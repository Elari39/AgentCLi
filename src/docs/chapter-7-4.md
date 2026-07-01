# Java源码解析：MCP 协议与工具适配

派大星 6月12日修改

> 理论篇讲了 MCP 协议的设计理念和三阶段会话流程，这篇带你走读 Java 版 MewCode 的真实代码。一个 461 行的文件，用内部类把 MCP 客户端、传输层、工具适配器全部装在了一起。

## 模块概览

Java 版的 MCP 代码全部集中在一个文件里：

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `McpManager.java` | 461 | MCP 管理器 + stdio/HTTP 两种传输客户端 + 工具适配器 + JSON-RPC 手动解析 |

Java 版把所有东西塞进了一个类。 `McpTransport` 接口、 `McpStdioClient` 、 `McpHttpClient` 、 `McpToolWrapper` 全是内部类。这种做法的好处是代码高度内聚，坏处是文件比较长。但考虑到 MCP 模块内部耦合本来就紧密，放在一起反而更容易理解依赖关系。

一个显著的设计选择是：Java 版手写了 JSON-RPC 协议，没有依赖第三方 MCP 客户端库。所有 JSON-RPC 请求和响应都是自己用 Jackson 序列化/反序列化。这让你能看到 MCP 协议的完整通信细节，也保持了零外部依赖的原则。

## 核心类型

### McpManager：连接调度中心

```java
public class McpManager {
    private final Map<String, McpServerConfig> configs =
        new LinkedHashMap<>();
    private final Map<String, McpTransport> clients =
        new LinkedHashMap<>();

    public McpManager(List<McpServerConfig> configs) {
        if (configs != null) {
            for (var cfg : configs)
                this.configs.put(cfg.getName(), cfg);
        }
    }
}
```

两个 `LinkedHashMap` ，保持插入顺序。构造函数直接把配置列表转成字典，用服务器名做 key。 `if (configs != null)` 防御空列表，因为 Java 里 null 和空集合是两回事。

返回值用 record 封装：

```java
public record ServerInfo(
    String name, String instructions) {}

public record ConnectResult(
    List<Tool> tools,
    List<ServerInfo> servers,
    List<String> errors) {}
```

`ConnectResult` 把三种结果打包返回：注册成功的工具列表、服务器信息（含 MCP 服务器给的使用说明）、连接失败的错误列表。用 record 而不是普通类，因为这些只是数据载体，不需要可变性。

### McpTransport：传输层接口

```java
interface McpTransport {
    void connect() throws Exception;
    String getInstructions();
    List<McpToolDef> listTools() throws Exception;
    String callTool(String name,
                    Map<String, Object> args) throws Exception;
    void close();
}
```

四个方法覆盖了 MCP 客户端的完整生命周期。 `connect()` 建立连接并完成初始化握手， `listTools()` 发现工具， `callTool()` 执行工具， `close()` 清理资源。 `getInstructions()` 比较特殊，它返回服务器在初始化握手时给的使用说明。

接口声明为包级可见（没有 `public` ），只在 `McpManager` 内部使用。两个实现类 `McpStdioClient` 和 `McpHttpClient` 都是 `private static` 内部类。

### McpToolDef：工具定义

```java
record McpToolDef(
    String name,
    String description,
    Map<String, Object> inputSchema) {}
```

三个字段，对应 MCP 协议中工具定义的三要素。用 record 而不是类，因为工具定义创建后就不会变了。 `inputSchema` 用 `Map<String, Object>` 而不是强类型 DTO，因为 JSON Schema 结构太灵活，强类型反而限制太多。

### 两个工具方法

```java
static String sanitizeName(String name) {
    return NON_ALNUM.matcher(name).replaceAll("_");
}

static String resolveEnvVars(String value) {
    if (value == null) return null;
    return ENV_VAR.matcher(value).replaceAll(m -> {
        String env = System.getenv(m.group(1));
        return env != null ? env : m.group(0);
    });
}
```

`sanitizeName` 把服务器名和工具名中的非字母数字字符替换成下划线，确保拼出来的工具名对 LLM 友好。 `resolveEnvVars` 用正则匹配 `${VAR}` 并替换成环境变量的值，找不到就保留原文。这两个方法是 MCP 模块的基础设施，在传输层选择和工具命名中都会用到。

## 主流程走读

### 第一步：connectAll，建连接

```java
public ConnectResult connectAll() {
    var tools = new ArrayList<Tool>();
    var errors = new ArrayList<String>();
    for (var entry : configs.entrySet()) {
        var cfg = entry.getValue();
        McpTransport transport;
        if (cfg.getCommand() != null && !cfg.getCommand().isBlank())
            transport = new McpStdioClient(cfg);
        else if (cfg.getUrl() != null && !cfg.getUrl().isBlank())
            transport = new McpHttpClient(cfg);
        else { errors.add("neither command nor url"); continue; }
```

传输层选择逻辑：有 `command` 就走 stdio，有 `url` 就走 HTTP，都没有就报错。这种显式的分支判断确保了只有合法配置才能创建传输层，配置不完整时立即报错，不会等到运行时才发现。

连接成功后拉工具列表并包装：

```java
transport.connect();
        clients.put(name, transport);
        servers.add(new ServerInfo(name,
            transport.getInstructions()));
        for (var td : transport.listTools()) {
            tools.add(new McpToolWrapper(name, td, transport));
        }
    }
    return new ConnectResult(
        List.copyOf(tools), List.copyOf(servers),
        List.copyOf(errors));
}
```

`List.copyOf` 创建不可变副本，返回给调用方的列表不会被意外修改。一个服务器连接失败时异常被 catch 住，错误收集到 `errors` 列表，不影响其他服务器的连接。

### 第二步：Stdio 连接，手写 JSON-RPC

Stdio 模式是 MCP 最常见的传输方式。Java 版手动实现了完整的 JSON-RPC 2.0 协议：

```java
private static class McpStdioClient
        implements McpTransport {
    private Process process;
    private BufferedWriter writer;
    private BufferedReader reader;
    private final AtomicInteger idCounter =
        new AtomicInteger(0);
```

四个核心字段： `process` 是 MCP 服务器子进程， `writer` 写请求到 stdin， `reader` 从 stdout 读响应， `idCounter` 生成 JSON-RPC 的请求 ID。用 `AtomicInteger` 而不是普通 `int` ，是为了线程安全，虽然当前代码是单线程调用。

连接过程分三步：启动子进程、发初始化请求、发通知：

```java
public void connect() throws Exception {
    var args = new ArrayList<String>();
    args.add(config.getCommand());
    if (config.getArgs() != null) args.addAll(config.getArgs());
    var pb = new ProcessBuilder(args);
    pb.redirectErrorStream(false);
    if (config.getEnv() != null) {
        for (var e : config.getEnv().entrySet())
            pb.environment().put(e.getKey(), resolveEnvVars(e.getValue()));
    }
    process = pb.start();
```

`ProcessBuilder` 是 Java 启动子进程的标准方式。 `redirectErrorStream(false)` 不合并 stderr 到 stdout，因为 JSON-RPC 响应走 stdout，stderr 混进来会破坏解析。环境变量通过 `pb.environment()` 注入， `resolveEnvVars` 展开 `${VAR}` 引用。

stderr 需要单独消费，否则缓冲区满了会导致子进程阻塞：

```java
Thread.startVirtualThread(() -> {
        try (var err = new BufferedReader(
                new InputStreamReader(
                    process.getErrorStream()))) {
            while (err.readLine() != null) {}
        } catch (IOException ignored) {}
    });
```

启动一个虚拟线程不断读取 stderr 并丢弃。用虚拟线程而不是平台线程，因为这个线程大部分时间都在阻塞等 IO，虚拟线程的开销极小。

初始化握手按 MCP 协议发送 `initialize` 请求：

```java
var initParams = Map.of(
        "protocolVersion", "2024-11-05",
        "capabilities", Map.of(),
        "clientInfo", Map.of("name", "mewcode", "version", "0.1.0"));
    var response = sendRequest("initialize", initParams);
    var result = (Map<String, Object>) response.get("result");
    if (result != null)
        instructions = (String) result.get("instructions");
    sendNotification("notifications/initialized", Map.of());
```

先发请求告诉服务器自己是谁（ `clientInfo` ）、支持什么能力（ `capabilities` 为空，表示最基本的客户端）、协议版本。服务器响应里可能包含 `instructions` ，保存下来后面注入 system prompt。最后发一个无 ID 的通知（ `notifications/initialized` ），告诉服务器握手完成。

### JSON-RPC 请求发送与响应解析

`sendRequest` 是整个 stdio 客户端的核心方法：

```java
private Map<String, Object> sendRequest(
        String method, Object params) throws Exception {
    int id = idCounter.incrementAndGet();
    var request = new LinkedHashMap<String, Object>();
    request.put("jsonrpc", "2.0");
    request.put("id", id);
    request.put("method", method);
    request.put("params", params);
    String json = MAPPER.writeValueAsString(request);
    writer.write(json);
    writer.newLine();
    writer.flush();
```

请求格式严格遵循 JSON-RPC `2.0`： `jsonrpc` 固定 `2.0` ， `id` 递增整数， `method` 是方法名， `params` 是参数。每条消息一行，用换行符分隔。然后进入响应读取循环：

```java
while (true) {
        String line = reader.readLine();
        if (line == null)
            throw new IOException("MCP server closed");
        if (line.isBlank()) continue;
        var resp = MAPPER.readValue(line, Map.class);
        if (resp.containsKey("id")) return resp;
    }
}
```

MCP 服务器可能在响应之前发不带 `id` 的通知消息（比如进度通知），需要跳过，只返回带 `id` 的响应。 `line == null` 表示服务器关闭了连接。

### 第三步：HTTP 连接，Streamable HTTP

```java
private static class McpHttpClient
        implements McpTransport {
    private final HttpClient httpClient =
        HttpClient.newHttpClient();
    private String sessionId;
```

HTTP 客户端比 stdio 简单，因为不用管子进程生命周期。 `sessionId` 用于跨请求维持 MCP 会话状态。

HTTP 请求的构造和发送：

```java
var reqBuilder = HttpRequest.newBuilder()
    .uri(URI.create(config.getUrl()))
    .header("Content-Type", "application/json")
    .header("Accept", "application/json, text/event-stream")
    .POST(HttpRequest.BodyPublishers.ofString(jsonBody));
if (sessionId != null)
    reqBuilder.header("Mcp-Session-Id", sessionId);
if (config.getHeaders() != null) {
    for (var entry : config.getHeaders().entrySet())
        reqBuilder.header(entry.getKey(), resolveEnvVars(entry.getValue()));
}
```

`Accept` 头同时接受 JSON 和 SSE（Server-Sent Events），因为 MCP 的 Streamable HTTP 传输可能返回任意一种格式。 `Mcp-Session-Id` 是 MCP 协议定义的会话标识，首次请求不带，服务器响应后保存下来，后续请求都要带上。

响应解析要区分两种格式：

```java
httpResponse.headers()
    .firstValue("mcp-session-id")
    .ifPresent(sid -> sessionId = sid);

String contentType = httpResponse.headers()
    .firstValue("content-type")
    .orElse("application/json");

if (contentType.contains("text/event-stream")) {
    return parseSseResponse(httpResponse.body(), id);
}

return (Map<String, Object>)
    MAPPER.readValue(httpResponse.body(), Map.class);
```

先从响应头里提取 sessionId。然后根据 Content-Type 决定解析方式：SSE 格式需要额外解析 `data:` 前缀，JSON 格式直接反序列化。

SSE 解析逻辑：

```java
private Map<String, Object> parseSseResponse(
        String body, int expectedId) throws Exception {
    for (String line : body.split("
")) {
        if (!line.startsWith("data: ")) continue;
        String data = line.substring(6).strip();
        if (data.isEmpty() || data.equals("[DONE]")) continue;
        var msg = MAPPER.readValue(data, Map.class);
        if (msg.containsKey("id")) return msg;
    }
    throw new IOException("No JSON-RPC response in SSE stream");
}
```

逐行扫描，跳过非 `data:` 行，跳过空数据和 `[DONE]` 标记，找到第一条带 `id` 的 JSON-RPC 响应就返回。

## 工具适配器

`McpToolWrapper` 把 MCP 工具适配成 MewCode 的 `Tool` 接口：

```java
private static class McpToolWrapper implements Tool {
    private final String serverName;
    private final McpToolDef toolDef;
    private final McpTransport transport;

    @Override
    public String name() {
        return "mcp__" + sanitizeName(serverName)
            + "__" + sanitizeName(toolDef.name());
    }
```

名字格式 `mcp__<server>__<tool>` ，双下划线分隔。 `sanitizeName` 确保服务器名和工具名里只有字母数字和下划线。双下划线的分隔符选择是因为工具名和服务器名里不太可能有连续两个下划线，降低了命名冲突的风险。

`shouldDefer()` 固定返回 true + ToolSearchTool 精确/关键词搜索 + markDiscovered 激活：

```java
@Override
public boolean shouldDefer() { return true; }
```

所有 MCP 工具都是延迟工具，不在启动时塞进 system prompt。MCP 服务器可能注册了几十上百个工具，全放进去会挤爆上下文窗口。

Schema 透传，空 schema 给默认值：

```java
@Override
public Map<String, Object> schema() {
    var input = toolDef.inputSchema() != null
        ? toolDef.inputSchema()
        : Map.<String, Object>of(
            "type", "object",
            "properties", Map.of());
    return Map.of(
        "name", name(),
        "description", description(),
        "input_schema", input);
}
```

如果 MCP 工具没定义 inputSchema（有些工具确实不需要参数），就给一个最小的空对象 schema，防止 LLM 收到 null 后困惑。

执行逻辑简洁直接：

```java
@Override
public ToolResult execute(Map<String, Object> args) {
    try {
        String output =
            transport.callTool(toolDef.name(), args);
        return ToolResult.success(output);
    } catch (Exception e) {
        return ToolResult.error(
            "MCP tool call failed: " + e.getMessage());
    }
}
```

调用失败返回错误结果而不是抛异常，Agent 会看到错误信息。注意传给 `callTool` 的是 `toolDef.name()` （原始工具名），不是 `name()` （带前缀的名字）。

### 内容提取

```java
private static String extractTextContent(Map<String, Object> response) {
    var result = (Map<String, Object>) response.get("result");
    if (result == null) return "(no output)";
    var content = (List<Map<String, Object>>) result.get("content");
    if (content == null) return "(no output)";
    var sb = new StringBuilder();
    for (var block : content) {
        if ("text".equals(block.get("type"))) {
            if (!sb.isEmpty()) sb.append("
");
            sb.append(block.get("text"));
        }
    }
    return sb.isEmpty() ? "(no output)" : sb.toString();
}
```

从 JSON-RPC 响应里逐层取值。 `result.content` 是 MCP 协议定义的多态内容列表，只提取 `type` 为 `text` 的块。图片和嵌入资源类型暂不支持，这些类型在命令行工具的场景下用处不大。空结果返回 `(no output)` ，给 LLM 一个明确的信号。

## 延迟加载：ToolSearchTool

上面看到 `shouldDefer()` 固定返回 true + ToolSearchTool 精确/关键词搜索 + markDiscovered 激活，所有 MCP 工具默认不进工具列表。LLM 需要使用某个 MCP 工具时，通过 ToolSearchTool 搜索并加载它。

ToolSearchTool 实现了两种查询模式：

```java
public ToolResult execute(Map<String, Object> args) {
    String query = stringArg(args, "query", "");
    int maxResults = intArg(args, "max_results", 5);
    List<Map<String, Object>> schemas;

    if (query.startsWith("select:")) {
        List<String> names = Arrays.stream(
            query.substring("select:".length()).split(","))
            .map(String::trim).toList();
        schemas = registry.findDeferredByNames(names, protocol);
    } else {
        schemas = registry.searchDeferred(query, maxResults, protocol);
    }
```

`select:` 前缀走精确查找，否则走关键词搜索。精确查找用 `findDeferredByNames` ，不区分大小写比对工具名：

```java
public List<Map<String, Object>> findDeferredByNames(
    List<String> names, String protocol
) {
    var nameSet = new HashSet<String>();
    for (var n : names) nameSet.add(n.toLowerCase());

    var matches = new ArrayList<Map<String, Object>>();
    for (var tool : tools.values()) {
        if (nameSet.contains(tool.name().toLowerCase())) {
            // ... 构建 schema ...
        }
    }
    return matches;
}
```

关键词搜索用 `searchDeferred` ，在名称和描述里做包含匹配：

```java
public List<Map<String, Object>> searchDeferred(
        String query, int maxResults, String protocol) {
    String lower = query.toLowerCase();
    var matches = new ArrayList<Map<String, Object>>();
    for (var tool : tools.values()) {
        if (!tool.shouldDefer()) continue;
        if (tool.name().toLowerCase().contains(lower)
                || tool.description().toLowerCase().contains(lower)) {
            // ... 构建 schema 并加入 matches ...
            if (matches.size() >= maxResults) break;
        }
    }
    return matches;
}
```

搜索策略是「找到就加入，够数就停」。不做评分排序，简单高效。对于工具数量在几十到一两百的场景完全够用。

找到工具后标记为已发现：

```java
for (var s : schemas) {
    Object nameObj = s.get("name");
    if (nameObj instanceof String n) {
        registry.markDiscovered(n);
    }
}
```

`markDiscovered` 把工具名加入 `discoveredTools` 集合，下一轮 `getAllSchemas()` 就会包含这些工具的完整 Schema。从此 LLM 可以直接调用它们，不需要再经过 ToolSearch。

ToolSearchTool 自身的 `shouldDefer()` 返回 false，这很关键：

```java
@Override
public boolean shouldDefer() {
    return false;
}
```

ToolSearch 不能被延迟加载，否则 LLM 连发现其他工具的工具都找不到了。

## 连接管理

`registerAllTools` 是对外暴露的简化入口：

```java
public List<String> registerAllTools(
        ToolRegistry registry) {
    var result = connectAll();
    for (var t : result.tools()) registry.register(t);
    return result.errors();
}
```

调 `connectAll()` 拿到所有工具和错误，把工具注册到 Registry，把错误返回给上层处理。

关闭也很简洁：

```java
public void shutdown() {
    for (var client : clients.values()) client.close();
    clients.clear();
}
```

遍历关闭所有传输层，清空字典。Stdio 客户端的 `close()` 会强制终止子进程：

```java
@Override
public void close() {
    if (process != null && process.isAlive()) {
        process.destroyForcibly();
    }
}
```

`destroyForcibly()` 发 SIGKILL，不给子进程清理的机会。HTTP 客户端的 `close()` 是空实现，因为 HTTP 天然无状态，不需要释放连接资源。

## 小结

| 设计决策 | Java 的实现方式 |
| --- | --- |
| 代码组织 | 单文件 + 内部类，高内聚 |
| 协议实现 | 手写 JSON-RPC 2.0，不依赖 MCP SDK |
| 传输层选择 | `command` 非空走 stdio， `url` 非空走 HTTP |
| Stdio 通信 | ProcessBuilder 启动子进程，BufferedReader/Writer 逐行读写 |
| HTTP 通信 | [java.net](http://java.net/).http.HttpClient，同时支持 JSON 和 SSE 响应 |
| 会话维持 | `Mcp-Session-Id` header 跨请求传递 |
| 环境变量 | 正则替换 `${VAR}` ，注入到子进程环境和 HTTP Headers |
| 工具调用 | `McpToolWrapper` 适配 Tool 接口，异常转 ToolResult.error |
| 名字安全 | `mcp__<server>__<tool>` ，正则替换非字母数字字符 |
| 延迟加载 | `shouldDefer()` 固定返回 true + ToolSearchTool 精确/关键词搜索 + markDiscovered 激活 |
| 容错 | 单个服务器失败不阻断，错误收集统一返回 |
