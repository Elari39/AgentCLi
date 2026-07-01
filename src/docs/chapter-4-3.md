# Go源码解析：Agent 主循环与事件流

派大星 6月12日修改

> 理论篇讲了 Agent Loop 的设计理念和 ReAct 范式，这篇带你走读 Go 版 Claude Code 的真实代码，看看这些概念在 Go 的世界里是怎么落地的。

## 模块概览

Go 版把 Agent 核心逻辑分散在几个文件里：

| 文件 | 职责 |
| --- | --- |
| `agent.go` | `Agent` 结构体定义、`New()`、`Run()` 入口 |
| `loop.go` | 主循环骨架、LLM 调用、停止条件判断 |
| `streaming_executor.go` | 工具并行执行、结果收集 |
| `events.go` | `AgentEvent` 接口及所有事件类型定义 |

相比 Python 版一个文件 1098 行的集中风格，Go 版按职责拆分成了独立文件。每个文件有明确的单一职责，符合 Go 社区推崇的小文件、清晰分包原则。

## 核心类型

### Agent 结构体

```go
type Agent struct {
    Client          llm.Client             // LLM 客户端，负责发请求
    Registry        *tools.Registry        // 工具注册中心，所有工具都在这
    Protocol        string                 // 协议标识，用于获取工具 schema
    WorkDir         string                 // 工作目录
    MaxIterations   int                    // 最大迭代次数，0 表示不限
    ContextWindow   int                    // 上下文窗口大小，默认 200000
    Checker         *permissions.Checker   // 权限检查器
    Hooks           *hooks.Engine          // Hook 引擎
    NotificationFn  func() []string        // 动态通知队列
    ToolNameFilter  func(name string) bool // 工具过滤器（团队模式用）
    OnLoopComplete  func(conv *conversation.Manager) // 循环结束回调
    compactTracking compact.AutoCompactTrackingState  // 上下文压缩状态
    eventCh         chan AgentEvent                   // 事件通道
}
```

Go 的结构体没有构造函数语法，字段类型直接声明，一目了然。`eventCh` 是带缓冲的 channel，所有事件往这个 channel 里写，外部消费者从另一端读。这是 Go 并发编程的标准姿势：用 channel 做生产者-消费者解耦。

```go
func New(client llm.Client, registry *tools.Registry, protocol string) *Agent {
    wd, _ := os.Getwd()
    return &Agent{
        Client:        client,
        Registry:      registry,
        Protocol:      protocol,
        WorkDir:       wd,
        ContextWindow: 200000,
    }
}
```

`New()` 只设最小默认值，其余字段由调用方按需赋值。Go 没有可选参数，所以用公开字段 + 零值默认来代替。比如 `MaxIterations` 默认 0 表示不限制，`Checker` 默认 nil 表示不检查权限。这是 Go 的典型做法：简单场景零配置，复杂场景直接赋值。

### AgentEvent

```go
type AgentEvent interface{ agentEvent() }

type StreamText struct{ Text string }         // 文本流片段
type ToolUseEvent struct {                     // 工具调用
    ToolID, ToolName string
    Args             map[string]any
}
type ToolResultEvent struct {                  // 工具执行结果
    ToolID, ToolName string
    Output           string
    IsError          bool
    Elapsed          time.Duration
}
```

Go 没有 Union 类型，用接口 + 私有方法模拟封闭类型集合。`agentEvent()` 是一个不导出的标记方法，只有同一个包内的类型才能实现它。这比空接口 `interface{}` 安全得多：编译器帮你保证只有预期的类型能出现在事件流里。

`StreamText`、`ToolUseEvent`、`ToolResultEvent` 是最核心的三个事件类型。注意 Go 版没有 Python 版那么多事件类型（12 种 vs 3+ 种），因为 Go 版把一些通知（如 Hook 结果、压缩通知）合并到了其他机制里。

## 主循环走读

### 入口 Run()

```go
func (a *Agent) Run(ctx context.Context, conv *conversation.Manager) <-chan AgentEvent {
    ch := make(chan AgentEvent, 32) // 带缓冲的事件通道
    go func() {
        defer close(ch)            // goroutine 退出时关闭通道
        // ... 循环逻辑 ...
    }()
    return ch                      // 立即返回，调用方从 channel 消费事件
}
```

`Run()` 立即返回一个 channel，真正的循环逻辑在 goroutine 里运行。`defer close(ch)` 保证 goroutine 退出时 channel 一定关闭，调用方的 `for range ch` 循环会自然结束。这是 Go 并发的标准模式：启动 goroutine，返回 channel，让调用方消费。

### 循环骨架

```go
for iteration := 1; ; iteration++ {
    // 1. 检查迭代上限
    // 2. 检查上下文取消
    // 3. 上下文压缩管理
    // 4. Plan Mode 注入
    // 5. 动态通知注入
    // 6. 获取工具 schema，调用 LLM
    // 7. 消费流式响应
    // 8. 处理停止条件
    // 9. 没有工具调用？→ 结束
    // 10. 收集工具执行结果，准备下一轮
}
```

Go 的 `for` 循环没有 `while` 关键字，直接 `for { ... }` 就是无限循环。每轮迭代的步骤清晰列出。和 Python 版的 15 步相比，Go 版更精简：没有 Hook 穿插，没有团队模式消息处理。

### 调用 LLM 和消费流式响应

```go
events, errs := a.Client.Stream(ctx, conv, toolSchemas)
```

`client.Stream()` 返回两个 channel：`events` 是 LLM 流式事件，`errs` 是错误。Go 的多返回值让错误处理和正常流分离得很清楚。

```go
executor := NewStreamingExecutor(a.Registry, a.Checker, ch)

for ev := range events {
    switch e := ev.(type) {
    case llm.TextDelta:
        text += e.Text
        ch <- StreamText{Text: e.Text}    // 文本片段实时推给 UI
    case llm.ToolCallComplete:
        toolCalls = append(toolCalls, e)
        executor.Submit(ctx, a, e)         // 工具解析完就立即提交执行
    case llm.StreamEnd:
        stopReason = e.StopReason
        usage = e.Usage
    }
}
```

`for ev := range events` 是 Go 消费 channel 的标准写法。`switch e := ev.(type)` 是类型 switch，根据事件的具体类型分派处理。文本片段实时推给 UI，工具调用解析完立即提交执行——注意这里 Go 版和 Python 版的关键区别：Go 版在流式阶段就开始执行工具（`executor.Submit`），而 Python 版等流消费完毕后才统一执行。

### 终止判断

```go
if len(toolCalls) == 0 {
    conv.AddAssistantFull(text, thinkingBlocks, nil)
    ch <- LoopComplete{TotalTurns: iteration}
    if a.OnLoopComplete != nil {
        go a.OnLoopComplete(conv) // 异步触发，不阻塞
    }
    return // 退出 goroutine，channel 被 defer close
}
```

没有工具调用就结束循环。`conv.AddAssistantFull` 把完整的文本和思维链写入对话历史，`ch <- LoopComplete{...}` 通知外部循环结束。`OnLoopComplete` 回调在独立 goroutine 里异步触发，不阻塞主循环退出。

### 工具结果收集

```go
results := executor.CollectResults()

var toolResults []conversation.ToolResultBlock
for _, r := range results {
    ch <- ToolResultEvent{...} // 每个结果推给 UI

    truncated := r.output
    if len(truncated) > tools.MaxOutputChars {
        truncated = truncated[:tools.MaxOutputChars] + "\n… (output truncated)"
    }
    toolResults = append(toolResults, conversation.ToolResultBlock{
        ToolUseID: r.toolID,
        Content:   truncated,
        IsError:   r.isError,
    })
}
conv.AddToolResultsMessage(toolResults)
```

`executor.CollectResults()` 阻塞等待所有已提交的工具执行完毕。对超长输出做截断保护，防止单个工具结果撑爆上下文窗口。截断后的结果包装成 `ToolResultBlock` 写入对话历史，准备下一轮迭代。

## 四个停止条件

理论篇讲了四个停止条件，看 Go 版怎么实现的：

**1. LLM 不再调用工具**

就是上面那个 `if len(toolCalls) == 0` 判断。最常见的正常退出路径。

**2. 达到最大迭代次数**

```go
if a.MaxIterations > 0 && iteration > a.MaxIterations {
    ch <- ErrorEvent{Message: fmt.Sprintf(
        "Agent reached maximum iterations (%d)", a.MaxIterations)}
    return
}
```

在循环最开头检查。`MaxIterations` 为 0 时表示不限制（Go 零值语义），大于 0 才生效。

**3. 连续未知工具**

```go
if r.isUnknown {
    consecutiveUnknown++
} else {
    consecutiveUnknown = 0
}
// ...
if consecutiveUnknown >= 3 {
    ch <- ErrorEvent{Message: "Too many consecutive unknown tool calls"}
    return
}
```

连续 3 次调用不存在的工具就终止，中间有一次正常调用就重置计数。

**4. 用户取消**

```go
if ctx.Err() != nil {
    return
}
```

Go 的 `context.Context` 是取消传播的标准机制。`ctx.Err() != nil` 检查上层是否已经取消。这比 Python 的 generator 垃圾回收隐式取消更显式：你能看到 context 在哪里被检查。

## 工具执行

### StreamingExecutor

```go
func (se *StreamingExecutor) Submit(ctx context.Context, agent *Agent, tc llm.ToolCallComplete) {
    se.mu.Lock()
    idx := len(se.pending)
    se.pending = append(se.pending, pendingTool{call: tc})
    se.mu.Unlock()

    se.wg.Add(1)
    go func() {
        defer se.wg.Done()
        result := agent.executeSingleTool(ctx, se.eventCh, tc)
        se.mu.Lock()
        se.pending[idx].result = result
        se.pending[idx].done = true
        se.mu.Unlock()
    }()
}
```

`Submit` 把工具执行包装成 goroutine 立即启动。`mu` 互斥锁保护 `pending` 切片的并发写入，`wg` 用于等待所有 goroutine 完成。Go 的并发原语（goroutine + `sync.Mutex` + `sync.WaitGroup`）在这里组合使用，每个都有明确职责。

### 单工具执行流程

`executeSingleTool` 是工具执行的完整管线，按顺序走四关：

**第一关：查找工具**。在 Registry 里找不到就返回 unknown 错误。

**第二关：权限检查**。 `Checker.Check()` 返回三种结果。`Deny` 直接拒绝；`Allow` 放行；`Ask` 就发一个 `PermissionRequestEvent` 给 UI，然后阻塞等用户回应：

```go
respCh := make(chan PermissionResponse, 1)
eventCh <- PermissionRequestEvent{
    ToolName:   tc.ToolName,
    Desc:       desc,
    ResponseCh: respCh,
}
resp := <-respCh // 阻塞，直到用户点允许或拒绝
```

权限请求事件用带缓冲的 channel 实现反向通信：Agent 发出 `PermissionRequestEvent`，附带一个 `respCh` channel，然后 `<-respCh` 阻塞等待。UI 收到事件后把用户的选择写入 `respCh`，Agent 继续执行。

Go 的 channel 天然就是为这种一来一回的同步场景设计的。缓冲大小为 1 保证 UI 写入不会阻塞（即使 Agent 还没开始读）。

## Plan Mode

```go
if a.Checker != nil && a.Checker.Mode == permissions.ModePlan {
    planPath := planfile.GetOrCreatePlanPath(a.WorkDir)
    a.Checker.PlanFilePath = planPath
    planExists := planfile.PlanExists(a.WorkDir)
    reminder := prompt.BuildPlanModeReminder(planPath, planExists, iteration)
    conv.AddSystemReminder(reminder)
}
```

核心思路和 Python 版一样：不改变循环结构，只在每轮迭代开头注入一段 system-reminder。Plan Mode 下只允许读工具，写工具会被权限系统拦住。`planfile` 包管理计划文件的创建和检查。

## 小结

| 设计决策 | Go 的实现方式 |
| --- | --- |
| 异步事件流 | goroutine + channel，消费方 `for range ch` |
| 主循环 | `for { ... }` + 显式 `return` |
| 工具并行 | goroutine 立即启动 + `WaitGroup` 等待 |
| 权限交互 | 带缓冲 channel 做一次性请求-响应 |
| 流消费 | `for range events` 消费 LLM channel，类型 switch 分派 |
| Plan Mode | 注入 system-reminder + 权限层拦截 |
| 上下文保护 | 截断超长工具输出 |
| 参数校验 | 依赖 JSON 反序列化的隐式校验 |
