# Go源码解析：MCP 协议与工具适配

派大星 6月12日修改

> 理论篇讲了 MCP 协议的设计理念和三阶段会话流程，这篇带你走读 Go 版 MewCode 的真实代码，看看一个 Coding Agent 怎么用不到 280 行代码接入整个 MCP 生态。

## 模块概览

MCP 的代码集中在一个文件里： `internal/mcp/mcp.go` ，总共 276 行。它把 MCP 客户端、连接管理器、工具适配器全部放在了同一个文件中。这个模块的复杂度不在代码量，而在它要把一个完整的外部协议（JSON-RPC 2.0 + 初始化握手 + 工具发现 + 工具调用）桥接到 MewCode 自己的工具系统里。

## 核心类型

### ServerConfig：一个 MCP 服务器长什么样

```go
type ServerConfig struct {
    Name      string            `yaml:"name"`
    Command   string            `yaml:"command"`
    Args      []string          `yaml:"args"`
    URL       string            `yaml:"url"`
    Transport string            `yaml:"transport"`
    Headers   map[string]string `yaml:"headers"`
    Env       map[string]string `yaml:"env"`
}
```

七个字段覆盖了两种传输方式的所有配置。 `Command` + `Args` + `Env` 服务于 stdio 传输， `URL` + `Transport` + `Headers` 服务于 HTTP 传输。 `Name` 是服务器的唯一标识，后面会用在工具名拼接里。

判断用哪种传输很直接： `IsStdio()` 看 `Command` 是否为空。 `transportKind()` 把空字符串和 `"http"` 都归一化到 Streamable HTTP（最新规范），只有显式写 `"sse"` 才走老版 SSE 传输。

### Client：单个 MCP 连接

```go
type Client struct {
    config    ServerConfig
    session   *mcp.ClientSession
    sdkClient *mcp.Client
}
```

三个字段： `config` 是配置， `sdkClient` 是底层的 MCP SDK 客户端， `session` 是建立连接后拿到的会话对象。所有后续操作（列工具、调工具）都走 `session` 。

### Manager：管理多个 MCP 连接

```go
type Manager struct {
    configs map[string]ServerConfig
    clients map[string]*Client
}
```

两个 map，一个存配置，一个存已连接的客户端。用服务器名做 key，天然去重。

### MCPToolWrapper：协议适配器

```go
type MCPToolWrapper struct {
    serverName string
    toolDef    *mcp.Tool
    client     *Client
}
```

这是整个模块最关键的类型。它把 MCP 协议返回的工具定义适配成 MewCode 的 `tools.Tool` 接口，Agent Loop 完全不知道自己调的工具来自外部 MCP 服务器。

## 主流程走读

整个 MCP 模块的主流程分三步：建立连接、发现工具、执行工具调用。

### 第一步：Connect，建连接

```go
func (c *Client) Connect(ctx context.Context) error {
    impl := &mcp.Implementation{
        Name: "mewcode", Version: "0.1.0",
    }
    c.sdkClient = mcp.NewClient(impl, nil)
    // ... 创建 transport ...
    session, err := c.sdkClient.Connect(ctx, transport, nil)
    c.session = session
    return nil
}
```

先声明自己的身份（ `Implementation` ），然后根据配置创建传输层，最后调 SDK 的 `Connect()` 完成初始化握手。握手成功后拿到的 `session` 就是后续所有操作的入口。

传输层创建有个值得注意的细节：stdio 模式下启动子进程时， `cmd.Stderr = io.Discard` 把 stderr 直接丢弃。原因是 npx/node 检测到 stderr 是 TTY 时会发 OSC 颜色查询序列，终端响应会污染 TUI 的输入流。HTTP 模式下，如果配了自定义 Headers，会用 `headerRoundTripper` 注入，header 值支持 `$ENV_VAR` 环境变量展开。

### 第二步：ListTools，发现工具

```go
func (c *Client) ListTools(ctx context.Context) ([]*mcp.Tool, error) {
    result, err := c.session.ListTools(ctx, nil)
    if err != nil {
        return nil, err
    }
    return result.Tools, nil
}
```

一行调用，拿到所有工具定义。返回的名称、描述、输入 schema 足够让 LLM 知道怎么调用它们。

### 第三步：CallTool，执行工具

```go
func (c *Client) CallTool(
    ctx context.Context, name string, args map[string]any,
) (string, bool, error) {
    result, err := c.session.CallTool(ctx, &mcp.CallToolParams{
        Name: name, Arguments: args,
    })
    // ... 提取文本内容 ...
    return text, result.IsError, nil
}
```

返回值是三元组：文本输出、是否出错、Go 层面的错误。注意区分两层错误： `result.IsError` 是协议层面的业务错误（工具执行失败但通信正常）， `err` 是传输层面的错误（连接断了、超时了）。

MCP 的 `Content` 是多态数组，可能包含文本、图片等类型。MewCode 只取 `TextContent` 拼接，空结果返回 `"(no output)"` 。

## 工具适配器

`MCPToolWrapper` 实现了 `tools.Tool` 接口的所有方法。最有意思的是 `Name()` 方法：

```go
func (w *MCPToolWrapper) Name() string {
    return "mcp__" + SanitizeName(w.serverName) +
        "__" + SanitizeName(w.toolDef.Name)
}
```

名字格式是 `mcp__<服务器名>__<工具名>` ，双下划线分隔。 `SanitizeName` 用正则把非字母数字字符替换成下划线。比如 `my-server` 上的 `read-file` 工具，最终名字是 `mcp__my_server__read_file` 。

`Schema()` 直接透传 MCP 工具的 `InputSchema` ，为空就给一个最小的空对象 schema。 `ShouldDefer()` 固定返回 true + ToolSearch 精确/关键词两种查询 + MarkDiscovered 激活，所有 MCP 工具都是「延迟工具」，不会在初始化时塞进 system prompt。MCP 工具数量不可控，全放进去会挤占上下文窗口。

`Execute()` 是最终的桥接点，内部调 `client.CallTool()` 完成实际的 JSON-RPC 请求。注意传给 `CallTool` 的是 `w.toolDef.Name` （原始工具名），不是 `w.Name()` （带前缀的名字），因为 MCP 服务器只认自己定义的工具名。

## 延迟加载：ToolSearch 与 DeferrableTool

所有 MCP 工具的 `ShouldDefer()` 返回 `true` ，这背后靠的是第三章定义的 `DeferrableTool` 接口：

```go
type DeferrableTool interface {
    ShouldDefer() bool
}
```

工具注册中心通过这个接口判断哪些工具要延迟。 `GetAllSchemas()` 构建每轮发给 LLM 的工具列表时，跳过标记为延迟且尚未被发现的工具：

```go
func (r *Registry) GetAllSchemas(protocol string) []map[string]any {
    for _, t := range r.tools {
        if isDeferred(t) && !r.discoveredTools[t.Name()] {
            continue  // 跳过未发现的延迟工具
        }
        // ... 正常构建 schema ...
    }
}
```

`GetDeferredToolNames()` 返回那些尚未被发现的延迟工具名称列表，Agent Loop 把这些名字注入 system-reminder，让 LLM 知道有哪些「隐藏」工具可以按需加载。

LLM 需要某个延迟工具时，通过 ToolSearch 搜索。ToolSearch 支持两种查询模式：

```go
func (t *ToolSearchTool) Execute(ctx context.Context, args map[string]any) ToolResult {
    query, _ := args["query"].(string)
    maxResults := intArg(args, "max_results", 5)

    var schemas []map[string]any
    if strings.HasPrefix(query, "select:") {
        // "select:ToolA,ToolB" → 按名称精确查找
        names := strings.Split(strings.TrimPrefix(query, "select:"), ",")
        schemas = t.Registry.FindDeferredByNames(names, t.Protocol)
    } else {
        // 关键词搜索名称和描述
        schemas = t.Registry.SearchDeferred(query, maxResults, t.Protocol)
    }

    // 标记为已发现，后续请求会包含这些工具的 Schema
    for _, s := range schemas {
        if name, ok := s["name"].(string); ok {
            t.Registry.MarkDiscovered(name)
        }
    }
    // ...
}
```

`select:` 前缀走精确查找，LLM 已经知道工具名时直接按名称拉取。不带前缀则走关键词搜索，在所有延迟工具的名称和描述里做包含匹配。找到后 `MarkDiscovered()` 标记为已发现，下一轮 `GetAllSchemas()` 就会包含这些工具的完整 schema。

ToolSearch 自身的 `ShouldDefer()` 返回 false。如果 ToolSearch 也被延迟，LLM 连发现工具的工具都找不到了。

## 连接管理

`Manager.ConnectAll()` 是把上面所有能力串起来的入口。它遍历所有配置，逐个建连接、拉工具列表、包装成 `MCPToolWrapper` ：

```go
func (m *Manager) ConnectAll(ctx context.Context) ConnectResult {
    for name, cfg := range m.configs {
        client := NewClient(cfg)
        if err := client.Connect(ctx); err != nil {
            errs = append(errs, ...)
            continue  // 一个失败不影响其他
        }
        m.clients[name] = client
        // ... 拉 InitializeResult 拿 Instructions ...
        toolDefs, err := client.ListTools(ctx)
        // ... 逐个包装成 MCPToolWrapper ...
    }
    return ConnectResult{...}
}
```

几个设计要点。某个服务器连接失败不会阻断其他服务器，错误收集到 `ConnectResult.Errors` 统一返回。连接成功后会读 `InitializeResult` 里的 `Instructions` 字段（MCP 服务器给客户端的使用说明），注入到 system prompt 让 LLM 知道怎么用这些工具。已连接的客户端缓存在 `m.clients` 里复用， `Shutdown()` 遍历关闭所有 session，用新的空 map 替换。

## 小结

| 设计决策 | Go 的实现方式 |
| --- | --- |
| 传输层选择 | `IsStdio()` + `transportKind()` 二级分派 |
| 初始化握手 | SDK `Connect()` 一次完成，拿到 session |
| 工具发现 | `session.ListTools()` → 逐个包装成 `MCPToolWrapper` |
| 工具调用 | `MCPToolWrapper.Execute()` → `client.CallTool()` → `session.CallTool()` |
| 名字安全 | `mcp__<server>__<tool>` ，正则替换非字母数字字符 |
| 延迟加载 | `ShouldDefer()` 固定返回 true + ToolSearch 精确/关键词两种查询 + MarkDiscovered 激活 |
| 连接缓存 | Manager 用两个 map 管理配置和客户端 |
| 容错 | 单个服务器失败不阻断，错误收集统一返回 |
