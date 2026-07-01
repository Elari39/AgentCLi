# Go源码解析：LLM 客户端与流式响应

派大星 6月12日修改

> 理论篇讲了 LLM 通信的设计理念和两层消息模型，这篇带你走读 Go 版 MewCode 的真实代码，看看一个 Coding Agent 是怎么和大模型对话的。

## 模块概览

LLM 通信的代码分布在两个目录下，一共七个文件：

| 文件 | 职责 |
| --- | --- |
| `internal/llm/client.go` | Client 接口定义、NewClient 工厂函数 |
| `internal/llm/events.go` | 流式事件类型：TextDelta、ToolCallComplete、StreamEnd 等 |
| `internal/llm/errors.go` | 5 种错误类型，把 API 错误映射为业务语义 |
| `internal/llm/anthropic.go` | Anthropic SDK 客户端，Stream() 实现、消息构建、错误分类 |
| `internal/llm/openai.go` | OpenAI 客户端，结构与 Anthropic 对称 |
| `internal/llm/model_resolver.go` | 模型别名解析，haiku / sonnet / opus → 完整 ID |
| `internal/conversation/conversation.go` | 内部 Message 结构体、Manager 对话管理器、双协议序列化 |

七个文件加起来不到 600 行。LLM 通信层的设计目标很明确：屏蔽不同供应商的 API 差异，给上层提供统一的流式事件接口。

## 核心类型

### Client 接口

整个 LLM 层只暴露一个接口，只有一个方法：

```
type Client interface {
    Stream(ctx context.Context,
           conv *conversation.Manager,    // 对话历史
           tools []map[string]any,        // 工具 schema
    ) (<-chan StreamEvent, <-chan error)   // 返回两个 channel
}
```

一个方法干完所有事。传入对话历史和工具列表，返回事件流和错误流。调用方不需要知道底层是 Anthropic 还是 OpenAI，只管从 channel 里读事件就行。

### StreamEvent：流式事件族

流式响应被拆成了七种事件，每种只携带一小块信息：

```
type StreamEvent interface{ streamEvent() }

type TextDelta struct{ Text string }        // 文本片段
type ThinkingDelta struct{ Text string }    // 思考过程片段
type ThinkingComplete struct {              // 思考完成
    Thinking  string
    Signature string
}
type ToolCallStart struct{ ToolName, ToolID string }  // 工具调用开始
type ToolCallDelta struct{ Text string }              // 工具参数片段
type ToolCallComplete struct {              // 工具调用完成
    ToolID    string
    ToolName  string
    Arguments map[string]any
}
type StreamEnd struct {                     // 流结束
    StopReason string
}
```

这些事件构成了上层消费流式响应的全部语言。Agent Loop 只认 `TextDelta` 、 `ToolCallComplete` 、 `StreamEnd` 这三个，其余的留给 UI 做展示。

### Message 与 Manager

`conversation` 包定义了内部统一的消息结构：

```
type Message struct {
    Role           string           // "user" 或 "assistant"
    Content        string           // 文本内容
    ThinkingBlocks []ThinkingBlock  // 思考块
    ToolUses       []ToolUseBlock   // 工具调用
    ToolResults    []ToolResultBlock // 工具结果​
}
```

一条 `Message` 可以同时携带文本、思考块和工具调用，因为 Anthropic 的 assistant 消息确实能包含这三者。 `Manager` 用一个 `[]Message` 切片管理整段对话，提供 `AddUserMessage` 、 `AddAssistantFull` 、 `AddToolResultsMessage` 等方法往里追加消息。

## 主流程走读

从上层调用到底层 SSE 事件，完整链路是这样走的：

**第一步：工厂创建客户端。** `NewClient` 根据配置里的 `Protocol` 字段分发：

```
func NewClient(cfg *config.ProviderConfig, systemPrompt string) (Client, error) {
    switch cfg.Protocol {
    case "anthropic":
        return newAnthropicClient(cfg, systemPrompt)
    case "openai":
        return newOpenAIClient(cfg, systemPrompt)
    default:
        return nil, fmt.Errorf("unknown protocol: %s", cfg.Protocol)
    }
}
```

**第二步：Agent Loop 调用 `Stream()`。** 只需要一行 `events, errs := client.Stream(ctx, conv, toolSchemas)` ，拿到两个 channel。

**第三步：goroutine 里发请求、读 SSE。** `Stream()` 内部启动一个 goroutine 处理所有网络 IO，调用方从 channel 消费事件，两边完全解耦。

**第四步：事件消费。** Agent Loop 用 `for ev := range events` 逐个处理，文本推给 UI，工具调用交给执行器，StreamEnd 结束本轮。

## 两层消息模型

MewCode 的消息有两层。内层是 `conversation.Message` ，上面已经看过了。外层是各供应商 API 要求的格式。两层之间由序列化函数桥接。

`serializeAnthropic` 有一个值得关注的细节：同角色连续消息的合并。

```
// 合并同角色连续消息，维持 user/assistant 交替
if len(result) > 0 {
    prev := result[len(result)-1]
    prevRole, _ := prev["role"].(string)
    if prevRole == msg.Role {
        prevContent, isString := prev["content"].(string)
        if isString {
            result[len(result)-1]["content"] = prevContent + "

" + msg.Content
            continue
        }
    }
}
```

为什么要合并？因为 Anthropic API 要求消息严格按 user/assistant 交替排列，不允许连续两条 user 消息。但 MewCode 内部会在用户消息后面追加 system-reminder（也是 user 角色），这就产生了连续同角色消息。序列化时把它们拼在一起，API 就不会报错了。

`serializeOpenAI` 则不需要这个合并逻辑，因为 OpenAI 的 Responses API 用 input item 列表而非消息列表，结构更扁平，不要求严格交替。

## 流式响应处理

以 `anthropicClient.Stream()` 为例，看看流式处理的核心机制。

整个函数在一个 goroutine 里运行。先构建请求参数，然后调用 SDK 的 `NewStreaming` 拿到 SSE 流：

```
stream := c.client.Messages.NewStreaming(ctx, params)
defer stream.Close()
```

SSE 事件的读取用了一个额外的 goroutine 来对抗两个问题：context 取消和连接静默死亡。

```
readNext := func() {
    nextCh <- sseResult{hasNext: stream.Next()}
}

idle := time.NewTimer(anthropicStreamIdleTimeout) // 5 分钟
go readNext()
for {
    select {
    case <-ctx.Done():        // 用户取消
        errs <- &NetworkError{...}
        return
    case <-idle.C:            // 连接静默挂死
        errs <- &NetworkError{...}
        return
    case res = <-nextCh:      // 正常收到事件
    }
    // ... 处理事件 ...
    go readNext()             // 继续读下一个
}
```

SDK 的 `stream.Next()` 可能因为底层连接死亡而永远阻塞。把它放进单独的 goroutine，主循环就能同时监听 context 和空闲超时，不会卡死。

事件解析的核心是一个三层 switch。外层区分 `ContentBlockStartEvent` 、 `ContentBlockDeltaEvent` 、 `ContentBlockStopEvent` ；中层区分 block 类型（thinking / tool\_use / text）；内层做具体处理。

工具调用的参数是流式到达的 JSON 片段，需要逐步累积：

```
case anthropic.InputJSONDelta:
    jsonAccum += delta.PartialJSON         // 累积 JSON 片段
    events <- ToolCallDelta{Text: delta.PartialJSON}
```

等到 `ContentBlockStopEvent` 时，把累积的 JSON 一次性反序列化，发出 `ToolCallComplete` 事件。这时候 Agent Loop 收到的就是解析好的 `map[string]any` ，可以直接传给工具执行了。

## 错误分类

LLM 层定义了 5 种错误类型，把 API 返回的 HTTP 错误码和错误文本映射为上层能理解的业务语义：

| 错误类型 | 触发条件 | 上层处理 |
| --- | --- | --- |
| `AuthenticationError` | 401 / API key 无效 | 提示用户检查配置 |
| `RateLimitError` | 429 / 限流 | 等待后重试，携带 RetryAfter |
| `ContextTooLongError` | 413 / prompt too long | 触发上下文压缩 |
| `LLMError` | 其他 API 错误 | 通用错误展示 |
| `NetworkError` | 非 API 错误（DNS、超时等） | 提示网络问题 |

分类逻辑在 `classifyAnthropicError` 里，先判断是不是 API 错误，是的话按状态码分流，不是的话一律归为 `NetworkError` ：

OpenAI 那边结构完全一样，只是用 HTTP 状态码（401 / 429）代替了 Anthropic 的错误类型枚举。两个 `classify` 函数的分类结果统一映射到同一组错误类型，上层不需要区分来源。

```
func classifyAnthropicError(err error) error {
    var apiErr *anthropic.Error
    if errors.As(err, &apiErr) {
        switch apiErr.Type() {
        case anthropic.ErrorTypeAuthenticationError:
            return &AuthenticationError{...}
        case anthropic.ErrorTypeRateLimitError:
            return &RateLimitError{...}
        default:
            return &LLMError{...}
        }
    }
    return &NetworkError{...}  // 兜底
}
```

## 小结

| 设计决策 | Go 的实现方式 |
| --- | --- |
| 供应商抽象 | 单方法 Client 接口 + 工厂函数，上层零感知 |
| 流式响应 | goroutine + buffered channel（容量 64） |
| 连接保活 | 额外 goroutine 读 SSE + idle timer（5 分钟超时） |
| 工具参数解析 | JSON 片段累积，block 结束时一次性反序列化 |
| 消息交替 | serializeAnthropic 合并连续同角色消息 |
| 错误分类 | 5 种语义错误类型，Anthropic / OpenAI 统一映射 |
| 模型别名 | haiku / sonnet / opus 三个短名，一张 map 搞定 |
