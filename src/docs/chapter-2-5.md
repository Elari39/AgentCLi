# Java源码解析：LLM 客户端与流式响应

派大星 6月12日修改

> 理论篇讲了 LLM 通信的设计理念和两层消息模型，这篇带你走读 Java 版 MewCode 的真实代码，看看同样的架构用 Java 21 来写会变成什么样子。

## 模块概览

LLM 通信的代码分布在两个包下，一共 11 个文件：

| 文件 | 职责 |
| --- | --- |
| `llm/LlmClient.java` | 核心接口定义 + 静态工厂方法，只暴露一个 `stream()` |
| `llm/StreamEvent.java` | `sealed interface` + 8 个 `record`，流式事件的完整词汇表 |
| `llm/AnthropicClient.java` | Anthropic 协议实现，手写 HTTP + SSE 解析 |
| `llm/OpenAiClient.java` | OpenAI Responses API 实现，结构与 Anthropic 对称 |
| `llm/LlmException.java` | 4 种异常子类，把 HTTP 错误映射为业务语义 |
| `llm/ModelResolver.java` | 模型别名解析，haiku / sonnet / opus 三个短名 |
| `conversation/ConversationManager.java` | 对话管理器，维护消息历史 + 双协议序列化 |
| `conversation/Message.java` | 可变消息类，同时容纳文本、思考块、工具调用 |
| `conversation/ThinkingBlock.java` | `record`，思考块 |
| `conversation/ToolUseBlock.java` | `record`，工具调用块 |
| `conversation/ToolResultBlock.java` | `record`，工具执行结果块 |

11 个文件加起来不到 500 行。文件数偏多是因为 `ThinkingBlock` 、 `ToolUseBlock` 、 `ToolResultBlock` 三个 record 各占一个文件，外加 Message 类独立成文件。这是 Java 的惯例，每个公开类型一个文件，虽然啰嗦但检索方便，IDE 里 Ctrl+Click 直接跳到独立文件，不用在大文件里翻找。

## 核心类型

### LlmClient：接口 + 工厂一体化

整个 LLM 层的对外契约只有一个接口，只有一个方法：

```
public interface LlmClient {
    BlockingQueue<StreamEvent> stream(
        ConversationManager conv,
        List<Map<String, Object>> tools);

    static LlmClient create(ProviderConfig cfg, String systemPrompt) {
        return switch (cfg.getProtocol()) {
            case "anthropic" -> new AnthropicClient(cfg, systemPrompt);
            case "openai"    -> new OpenAiClient(cfg, systemPrompt);
            default -> throw new IllegalArgumentException("Unknown protocol");
        };
    }
}
```

Java 版把工厂方法塞进了接口本身，利用 Java 8+ 允许接口有 `static` 方法的特性。调用方只需要 `LlmClient.create(cfg, prompt)` 一行就能拿到正确的实现，连工厂类都省了。接口和工厂合为一体，调用方不需要知道具体实现类的存在。

工厂内部的 `switch` 用了 Java 14 引入的 switch 表达式，箭头语法直接返回结果，不需要 `break` ，也不需要临时变量。 `default` 分支直接 throw，编译器知道它不可能继续执行，所以不会报「缺少 return」。

还有一个值得注意的设计： `stream()` 只返回一个 `BlockingQueue` ，没有单独的错误通道。错误怎么传？答案是 `StreamEvent.Error` 这个 record，错误被当作一种普通事件塞进同一个队列里。一个队列搞定一切，消费侧的代码更简单，不需要同时监听多个通道。

### StreamEvent：sealed interface + records

流式响应被拆成了 8 种事件：

```
public sealed interface StreamEvent {
    record TextDelta(String text) implements StreamEvent {}
    record ThinkingDelta(String text) implements StreamEvent {}
    record ThinkingComplete(String thinking, String signature) implements StreamEvent {}
    record ToolCallStart(String toolId, String toolName) implements StreamEvent {}
    record ToolCallDelta(String text) implements StreamEvent {}
    record ToolCallComplete(String toolId, String toolName,
        Map<String, Object> arguments) implements StreamEvent {}
    record StreamEnd(String stopReason, int inputTokens, int outputTokens)
        implements StreamEvent {}
    record Error(String message) implements StreamEvent {}
}
```

`sealed` 关键字的意思是：只有这个文件里声明的类型才能实现 `StreamEvent` 。编译器由此知道了所有可能的子类型，后面用 `switch` 做模式匹配时就能检查是否覆盖完整，遗漏了会报警告。

`record` 是 Java 16 引入的，一行就能定义一个不可变数据类，自动生成构造函数、getter、 `equals()` 、 `hashCode()` 、 `toString()` 。record 直接把字段写在圆括号里，非常紧凑。

把 `sealed interface` 和 `record` 组合起来，效果是一套完整的代数数据类型：接口定义了所有可能的事件种类，每个 record 是一种具体事件。编译器知道所有子类型，后面用 `switch` 做模式匹配时就能检查穷尽性，遗漏了某个分支会直接报警告。

### 三个 record 块：消息的零件

对话历史里的每条消息可以携带不同类型的内容块。三个 record 分别对应三种块：

```
public record ThinkingBlock(
    String thinking, String signature) {}

public record ToolUseBlock(
    String toolUseId, String toolName,
    Map<String, Object> arguments) {}

public record ToolResultBlock(
    String toolUseId, String content,
    boolean isError) {}
```

它们各自只有一行（加上 import 和 package 也就 3 到 5 行），但必须独立成文件，这是 Java 对公开类型的硬性要求。虽然文件数多了几个，好处是每个类型在文件树里一目了然，IDE 里 Ctrl+Click 直接跳到独立文件，不用在大文件里翻找。

`ThinkingBlock` 里的 `signature` 是 Anthropic extended thinking 的验证签名，用来防止篡改思考内容。 `ToolUseBlock` 的 `arguments` 用 `Map<String, Object>` 存储，而不是泛型或强类型，因为每个工具的参数结构不同，只能用动态 Map 兜底。

### Message：可变的消息容器

```
public class Message {
    private String role;
    private String content;
    private List<ThinkingBlock> thinkingBlocks;
    private List<ToolUseBlock> toolUses;
    private List<ToolResultBlock> toolResults;

    public Message(String role, String content) {
        this.role = role;
        this.content = content;
    }
    // getter + setter ...
}
```

注意这里用的是 `class` 而不是 `record` 。因为 Message 需要先创建再逐步填充，比如 `addAssistantFull()` 先 new 一个 Message，再 `setThinkingBlocks()` ，再 `setToolUses()` 。record 是不可变的，创建时就得把所有字段传全，不适合这种「先骨架后填肉」的模式。

Java 用了 private 字段加 getter/setter 的经典套路。虽然看起来代码不少，但语义很简单：Message 就是一个可变的消息容器，能装下 assistant 回复的所有组成部分。封装字段的好处是可以在 setter 里做校验，也可以在未来改变内部表示而不影响调用方。

## 主流程走读

从上层调用到底层 SSE 事件解析，完整链路分四步走。

### 第一步：工厂创建客户端

上面已经看过了， `LlmClient.create()` 根据配置里的 `protocol` 字段选择 `AnthropicClient` 或 `OpenAiClient` 。创建时会立即校验 API key：

```
public AnthropicClient(ProviderConfig cfg, String systemPrompt) {
    this.apiKey = cfg.resolvedApiKey();
    if (apiKey.isEmpty()) {
        throw new LlmException.AuthenticationException(
            "Anthropic API key not found.");
    }
    this.model = ModelResolver.resolve(cfg.getModel());
    this.thinking = cfg.isThinking();
    this.maxOutputTokens = cfg.resolvedMaxOutputTokens();
}
```

API key 为空直接抛异常，fail-fast。不会等到第一次请求时才发现 key 不对，而是在程序启动阶段就把问题暴露出来。 `ModelResolver.resolve()` 把短名映射成完整模型 ID，后面会详细讲。

### 第二步：stream() 启动虚拟线程

这是整个 LLM 层最关键的方法：

```
@Override
public BlockingQueue<StreamEvent> stream(
        ConversationManager conv, List<Map<String, Object>> tools) {
    var queue = new LinkedBlockingQueue<StreamEvent>(64);
    Thread.startVirtualThread(() -> {
        try {
            doStream(conv, tools, queue);
        } catch (Exception e) {
            queue.add(new StreamEvent.Error(classifyError(e).getMessage()));
        }
    });
    return queue;
}
```

Java 版用 virtual thread + `BlockingQueue` 实现异步流式处理： `stream()` 立即返回一个队列给调用方，网络 IO 在后台虚拟线程里异步执行，事件通过队列传递。调用方拿到队列后就可以开始消费，不需要等网络请求完成。

`LinkedBlockingQueue` 的容量设为 64。这个缓冲区让生产者（SSE 解析）和消费者（Agent Loop）之间有了弹性，解析速度快于消费速度时不会立刻阻塞。容量太小会导致频繁阻塞，太大会浪费内存，64 是一个经验值。

虚拟线程是 Java 21 的正式特性。 `Thread.startVirtualThread()` 创建的线程非常轻量，可以创建成千上万个而不会有性能问题。用它而不是平台线程，是因为 SSE 解析涉及大量阻塞 IO（等待服务器推送），虚拟线程在阻塞时会自动让出底层的操作系统线程，不会浪费宝贵的 OS 线程资源。

外层的 `try-catch` 是最后一道防线。 `doStream()` 里任何未预料到的异常都会被 `classifyError()` 转换成语义化的错误消息，塞进队列。消费方收到 `StreamEvent.Error` 就知道流断了。

### 第三步：构建请求体

`doStream()` 的前半段在组装 Anthropic API 需要的 JSON 结构：

```
var body = new LinkedHashMap<String, Object>();
body.put("model", model);
body.put("max_tokens", maxOutputTokens);
body.put("stream", true);
body.put("system", List.of(Map.of("type", "text", "text", systemPrompt)));

if (thinking) {
    if (ModelResolver.supportsAdaptiveThinking(model)) {
        body.put("thinking", Map.of("type", "adaptive", "budget_tokens", maxOutputTokens));
    } else {
        body.put("thinking", Map.of("type", "enabled", "budget_tokens", maxOutputTokens - 1));
    }
}
```

这里没有用任何 SDK 或请求模型类，纯手工拼 Map。好处是零依赖，不需要引入 Anthropic 官方 SDK 或第三方库。坏处是缺乏类型安全，拼错一个 key 只有运行时才会发现。这是一个有意的工程取舍：用类型安全换取零外部依赖。

thinking 参数的处理有个分支：新模型（4.6 系列）支持 `adaptive` 类型的思考，budget 可以设满；旧模型只支持 `enabled` ，budget 必须比 max\_tokens 少 1，否则 API 会报错。这个减 1 的细节是 Anthropic API 的硬性要求。

### 第四步：发送 HTTP 请求

```
var httpClient = HttpClient.newHttpClient();
var request = HttpRequest.newBuilder()
    .uri(URI.create(url))
    .header("Content-Type", "application/json")
    .header("x-api-key", apiKey)
    .header("anthropic-version", API_VERSION)
    .POST(HttpRequest.BodyPublishers.ofString(MAPPER.writeValueAsString(body)))
    .build();
var response = httpClient.send(request, HttpResponse.BodyHandlers.ofInputStream());
```

用的是 Java 11 引入的 `java.net.http.HttpClient` ，标准库自带，不需要 OkHttp 或 Apache HttpClient。 `BodyHandlers.ofInputStream()` 让响应体以流的形式返回，而不是一次性读进内存，这对 SSE 来说至关重要，因为 SSE 响应可能持续好几分钟。

`MAPPER.writeValueAsString(body)` 把 Map 序列化成 JSON 字符串。 `MAPPER` 是 Jackson 的 `ObjectMapper` ，在类级别声明为 `static final` ，全局复用。ObjectMapper 是线程安全的，所以可以放心地在多个虚拟线程之间共享。

## 两层消息模型

MewCode 的消息有两层。内层是 `Message` 类加三个 record 块，用于程序内部传递。外层是各供应商 API 要求的 JSON 格式。两层之间由 `ConversationManager.serialize()` 桥接。

### 序列化入口

```
public List<Map<String, Object>> serialize(String protocol) {
    return "openai".equals(protocol)
        ? serializeOpenAI()
        : serializeAnthropic();
}
```

一行三目运算符搞定协议分发。注意 `"openai"` 放在 `equals()` 前面，这是 Java 的经典技巧：即使 `protocol` 是 null 也不会抛空指针异常。

### Anthropic 序列化：content blocks 拼装

Anthropic API 要求 assistant 消息的 `content` 字段是一个块数组，按顺序放 thinking、text、tool\_use 块。 `serializeAnthropic()` 的核心逻辑就是把 Message 里的各个部分组装成这个数组：

```
if (hasThinking) {
    for (var tb : msg.getThinkingBlocks()) {
        content.add(Map.of("type", "thinking",
            "thinking", tb.thinking(), "signature", tb.signature()));
    }
}
if (msg.getContent() != null && !msg.getContent().isEmpty()) {
    content.add(Map.of("type", "text", "text", msg.getContent()));
}
```

thinking 块和 text 块的构建用 `Map.of()` 一行搞定，因为字段都是不可变的。tool\_use 块不能用 `Map.of()` ，因为它的 `input` 字段可能包含嵌套结构，需要用 `LinkedHashMap` 保证键的插入顺序：

```
if (hasToolUses) {
    for (var tu : msg.getToolUses()) {
        var block = new LinkedHashMap<String, Object>();
        block.put("type", "tool_use");
        block.put("id", tu.toolUseId());
        block.put("name", tu.toolName());
        block.put("input", tu.arguments());
        content.add(block);
    }
}
```

三个 `if` 块的顺序不是随意的。Anthropic API 要求 thinking 块必须出现在最前面，text 在中间，tool\_use 在最后。如果顺序搞反，API 会返回 400 错误。代码的排列顺序直接映射了 API 的协议约束。

record 的 getter 方法名没有 `get` 前缀，直接用字段名： `tb.thinking()` 而不是 `tb.getThinking()` 。这是 record 的语法特性，让调用侧更简洁。

### 连续同角色消息合并

Anthropic API 还有一个约束：消息必须严格按 user/assistant 交替排列。但 MewCode 内部会通过 `addSystemReminder()` 在用户消息后面追加 system-reminder，它也是 user 角色，这就会产生连续两条 user 消息。

```
if (!result.isEmpty()) {
    var prev = result.getLast();
    var prevRole = (String) prev.get("role");
    if (prevRole != null && prevRole.equals(msg.getRole())) {
        var prevContent = prev.get("content");
        if (prevContent instanceof String s) {
            var merged = new LinkedHashMap<String, Object>();
            merged.put("role", msg.getRole());
            merged.put("content", s + "\n\n" + msg.getContent());
            result.set(result.size() - 1, merged);
            continue;
        }
    }
}
```

`prevContent instanceof String s` 是 Java 16 引入的模式匹配。它同时做了两件事：检查 `prevContent` 的运行时类型是不是 `String` ，如果是就绑定到变量 `s` 。不再需要先 `instanceof` 再强制转型的两步操作。

合并逻辑的策略是：如果前一条消息的 content 是纯字符串，就把当前消息的文本拼在后面，中间用两个换行分隔。如果前一条的 content 是 List（content blocks 数组），就把当前文本作为一个新的 text block 追加进去。两种情况覆盖了所有可能的合并场景。

### OpenAI 序列化：扁平 item 列表

OpenAI Responses API 用的不是 message 列表而是 input item 列表，结构更扁平：

```
for (var tu : msg.getToolUses()) {
    String argsJson;
    try { argsJson = MAPPER.writeValueAsString(tu.arguments()); }
    catch (JsonProcessingException e) { argsJson = "{}"; }
    var item = new LinkedHashMap<String, Object>();
    item.put("type", "function_call");
    item.put("name", tu.toolName());
    item.put("call_id", tu.toolUseId());
    item.put("arguments", argsJson);
    result.add(item);
}
```

和 Anthropic 最大的区别是：工具调用的参数需要序列化成 JSON 字符串，而不是直接嵌套 Map 对象。Anthropic 的 `input` 字段接受嵌套 JSON 对象，OpenAI 的 `arguments` 字段只接受字符串。所以这里多了一步 `MAPPER.writeValueAsString()` 。

`catch` 里返回 `"{}"` 是防御性编程。正常情况下 `arguments` 一定是可序列化的 Map，但万一碰到奇怪的对象，总比程序崩溃好。

## 流式响应处理

SSE（Server-Sent Events）解析是整个 LLM 层最复杂的部分。以 AnthropicClient.doStream() 为例拆解。

### SSE 行读取

HTTP 响应体是一个持续推送的文本流，每个事件由两行组成： event: xxx 和 data: {...} 。用 BufferedReader 逐行读取：

```
try (var reader = new BufferedReader(
    new InputStreamReader(response.body()))) {
    String line;
    String eventType = null;
    while ((line = reader.readLine()) != null) {
        if (line.startsWith("event: ")) {
            eventType = line.substring(7).trim();
            continue;
        }
        if (!line.startsWith("data: ")) continue;
        String data = line.substring(6).trim();
        if (data.equals("[DONE]")) break;
        // ... 解析 JSON ...
    }
}
```

`try-with-resources` 确保 reader 和底层的 InputStream 在结束时自动关闭，不管是正常结束还是异常退出。这是 Java 7 引入的资源管理语法，编译器会在 try 块结束时自动调用 `close()` 方法。

状态管理用了一个局部变量 `eventType` ：先读到 `event:` 行时记住事件类型，再读到 `data:` 行时根据记住的类型做分发。处理完 data 之后把 `eventType` 重置为 null，等待下一对 event/data 行。

### 事件分发：三层 switch

data 行拿到之后，先用 ObjectMapper 解析成 Map，然后进入一个大的 switch 表达式：

```
case "content_block_start" -> {
    var block = (Map<String, Object>) event.get("content_block");
    String type = block != null ? (String) block.get("type") : "";
    if ("thinking".equals(type)) {
        inThinking = true;
        thinkingAccum.setLength(0);
    } else if ("tool_use".equals(type)) {
        currentToolName = (String) block.getOrDefault("name", "");
        currentToolId = (String) block.getOrDefault("id", "");
        jsonAccum.setLength(0);
        queue.add(new StreamEvent.ToolCallStart(currentToolId, currentToolName));
    }
}
```

`content_block_start` 表示一个新的内容块开始了。它根据块的 `type` 字段初始化不同的状态：thinking 块设一个 `inThinking` 标记并清空累积器；tool\_use 块记住当前工具名和 ID，清空 JSON 累积器，并立即往队列里推一个 `ToolCallStart` 事件通知上层。

text 类型的块没有 start 处理，因为文本不需要累积状态，每个 delta 直接推就行。

### content\_block\_delta：逐片累积

delta 事件是 SSE 的核心，每个 delta 携带一小块增量内容：

```
case "thinking_delta" -> {
    String t = (String) delta.getOrDefault("thinking", "");
    thinkingAccum.append(t);
    queue.add(new StreamEvent.ThinkingDelta(t));
}
case "text_delta" ->
    queue.add(new StreamEvent.TextDelta((String) delta.getOrDefault("text", "")));
case "input_json_delta" -> {
    String pj = (String) delta.getOrDefault("partial_json", "");
    jsonAccum.append(pj);
    queue.add(new StreamEvent.ToolCallDelta(pj));
}
```

外层先从 event 里取出 `delta` Map，再根据 delta 的 `type` 字段进入内层 switch。这里展示了三种 delta 的不同处理策略。 `text_delta` 最简单，直接推事件，不累积。 `thinking_delta` 既推事件（给 UI 实时展示）又累积（block 结束时要拼成完整的思考文本）。 `input_json_delta` 也是双重处理，因为工具参数需要等全部 JSON 片段到齐后才能反序列化成 Map。

`StringBuilder.append()` 的性能在这里很重要。一个工具调用的参数可能被拆成几十个 JSON 片段推过来，每次 `append()` 的复杂度是 O(1) 均摊。如果改成字符串拼接（ `str += fragment` ），每次都要创建新的 String 对象，性能会差很多。

### content\_block\_stop：收官

当一个块的所有 delta 都到齐后，服务器会推一个 `content_block_stop` ：

```
case "content_block_stop" -> {
    if (inThinking) {
        queue.add(new StreamEvent.ThinkingComplete(thinkingAccum.toString(), thinkingSignature));
        inThinking = false;
    }
    if (!currentToolName.isEmpty()) {
        Map<String, Object> args;
        try { args = MAPPER.readValue(jsonAccum.toString(), Map.class); }
        catch (Exception e) { args = new HashMap<>(); }
        queue.add(new StreamEvent.ToolCallComplete(currentToolId, currentToolName, args));
        currentToolName = "";
        currentToolId = "";
        jsonAccum.setLength(0);
    }
}
```

thinking 块结束时，把累积的完整文本和签名一起打包成 `ThinkingComplete` 事件。tool\_use 块结束时，把累积的 JSON 片段反序列化成 `Map<String, Object>` ，打包成 `ToolCallComplete` 事件。从这个时刻起，Agent Loop 就可以拿着解析好的参数去执行工具了。

`MAPPER.readValue()` 外面包了 `try-catch` ，如果 JSON 格式损坏（极端情况，比如连接中断导致 JSON 不完整），回退到空 Map。上层拿到空参数会把工具执行标记为错误，不会导致整个系统崩溃。

### Token 用量追踪

SSE 流的末尾会推 `message_start` 和 `message_delta` 事件，携带 token 消耗信息：

```
case "message_delta" -> {
    var delta = (Map<String, Object>) event.get("delta");
    if (delta != null && delta.containsKey("stop_reason"))
        stopReason = (String) delta.get("stop_reason");
    var usage = (Map<String, Object>) event.get("usage");
    if (usage != null) {
        int di = ((Number) usage.getOrDefault("input_tokens", 0)).intValue();
        int do_ = ((Number) usage.getOrDefault("output_tokens", 0)).intValue();
        if (di > 0) inputTokens = di;
        if (do_ > 0) outputTokens = do_;
    }
}
```

`message_delta` 同时携带 `stop_reason` 和 `usage` 。 `stop_reason` 告诉上层这轮结束的原因： `end_turn` 表示 LLM 自然结束， `tool_use` 表示 LLM 想调用工具。Agent Loop 根据这个字段决定是否进入下一轮迭代。

变量名 `do_` 后面带了个下划线，因为 `do` 是 Java 关键字不能做变量名。这是 Java 的一个小限制，碰到和关键字冲突的变量名时，常见的做法是加下划线后缀。

最后，所有状态汇总成一个 `StreamEnd` 事件推入队列，标志着整个流式响应处理完毕。

## 错误分类

LLM 层把 API 返回的 HTTP 错误码转换成语义化的异常类型。异常体系一共有 4 种：

```
public class LlmException extends RuntimeException {
    public static class AuthenticationException
        extends LlmException { ... }
    public static class RateLimitException
        extends LlmException {
        private final String retryAfter;
        ...
    }
    public static class ContextTooLongException
        extends LlmException { ... }
    public static class NetworkException
        extends LlmException { ... }
}
```

用静态内部类而不是独立文件，因为这些异常类型只在 `LlmException` 的上下文中有意义。基类 `LlmException` 本身也能直接实例化，充当通用错误，不属于上述四种的错误都归到基类。这样异常体系既有分类又有兜底，上层 catch 时可以精确匹配也可以统一处理。

`RateLimitException` 多了一个 `retryAfter` 字段，用来存放 429 响应中的 `Retry-After` 头。上层可以据此决定等多久再重试，而不是盲目等固定时间。

### classifyHttpError：从状态码到语义

```
private static LlmException classifyHttpError(int status, String body) {
    String lower = body.toLowerCase();
    if (status == 413 || lower.contains("prompt is too long"))
        return new LlmException.ContextTooLongException("Context too long: " + body);
    return switch (status) {
        case 401 -> new LlmException.AuthenticationException("Invalid API key: " + body);
        case 429 -> new LlmException.RateLimitException("Rate limited. Please wait.", "");
        default  -> new LlmException("API error (" + status + "): " + body);
    };
}
```

上下文过长的检测有两层：HTTP 413 状态码是显式的，但有些情况下 Anthropic 会返回 400 状态码加 `prompt is too long` 的错误文本。所以不仅检查状态码，还在 body 里搜关键词。 `toLowerCase()` 是为了大小写不敏感匹配。

switch 表达式直接返回异常对象，而不是 throw。外层调用 `throw classifyHttpError(...)` 才真正抛出异常。把「分类」和「抛出」分开，让这个方法可以在单元测试里独立验证分类逻辑。

### classifyError：兜底分类

```
private static LlmException classifyError(Exception e) {
    if (e instanceof LlmException le) return le;
    return new LlmException(
        "Unexpected error: " + e.getMessage(), e);
}
```

这个方法处理 `doStream()` 里抛出的所有异常。如果已经是 `LlmException` （比如 `classifyHttpError` 的结果），直接透传；如果是 Jackson 序列化异常、IO 异常等意料之外的错误，包装成通用的 `LlmException` 。

`instanceof LlmException le` 又是模式匹配语法：判断类型的同时绑定变量，一步到位。

## ModelResolver：模型别名

```
private static final Map<String, String> ALIASES = Map.of(
    "haiku", "claude-haiku-4-5-20251001",
    "sonnet", "claude-sonnet-4-6-20250514",
    "opus",  "claude-opus-4-6-20250514");

public static String resolve(String model) {
    return ALIASES.getOrDefault(model, model);
}

public static boolean supportsAdaptiveThinking(String model) {
    String resolved = resolve(model);
    return resolved.contains("opus-4-6") || resolved.contains("sonnet-4-6");
}
```

`Map.of()` 创建的是不可变 Map，线程安全，不需要额外的同步。 `resolve()` 用 `getOrDefault` ：如果传入的 model 不在别名表里（比如直接传了完整 ID），就原样返回。

`supportsAdaptiveThinking()` 用字符串包含判断而不是精确匹配，因为未来可能有新的日期后缀。只要模型名里包含 `opus-4-6` 或 `sonnet-4-6` 就认为支持 adaptive thinking。这个判断影响了前面 thinking 参数的构建方式。

## 小结

| 设计决策 | Java 的实现方式 |
| --- | --- |
| 供应商抽象 | `LlmClient` 单方法接口 + 接口内 `static` 工厂方法 |
| 流式响应 | virtual thread + `LinkedBlockingQueue` （容量 64） |
| 事件类型安全 | `sealed interface` + 8 个 `record` ，编译器保证穷尽性 |
| SSE 解析 | `BufferedReader` 逐行读取 + `ObjectMapper` 解析 JSON |
| 工具参数解析 | `StringBuilder` 累积 JSON 片段，block 结束时 `readValue()` |
| 消息交替 | `serializeAnthropic()` 合并连续同角色消息 |
| 错误分类 | 4 种异常子类（静态内部类），HTTP 状态码 + body 关键词双重判断 |
| 模型别名 | `Map.of()` 不可变 Map，3 个短名映射完整 ID |
| JSON 处理 | `ObjectMapper` 静态单例，线程安全，全局复用 |
| 不可变数据 | record 做值对象（ `ThinkingBlock` 、 `ToolUseBlock` 、 `StreamEvent` ） |
