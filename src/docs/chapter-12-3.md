# Go源码解析：事件钩子与条件匹配

派大星 6月12日修改

> 理论篇讲了 Hook 系统的事件驱动设计和四种动作执行器，这篇带你走读 Go 版 MewCode 的真实代码，看看一个 419 行的单文件是怎么撑起整套钩子机制的。

## 模块概览

Hook 系统的代码就一个文件： `internal/hooks/hooks.go` ，419 行。没有子模块，没有接口抽象，所有逻辑平铺在一个 package 里。这种「一个文件干完所有事」的结构在 MewCode 里不多见，但 Hook 系统确实不需要更复杂的组织方式，它的职责边界非常清晰：接收事件、匹配条件、执行动作。

## 核心类型

### 事件和动作：两组枚举

```go
type EventName string

const (
    EventSessionStart EventName = "session_start"
    EventSessionEnd   EventName = "session_end"
    EventTurnStart    EventName = "turn_start"
    EventTurnEnd      EventName = "turn_end"
    EventPreSend      EventName = "pre_send"
    EventPostReceive  EventName = "post_receive"
    EventPreToolUse   EventName = "pre_tool_use"
    EventPostToolUse  EventName = "post_tool_use"
    EventShutdown     EventName = "shutdown"
)
```

9 个事件覆盖了 Agent 生命周期的所有关键节点。其中 `pre_tool_use` 是最特殊的一个，后面会看到它是唯一能「阻断」执行流的事件。

动作类型有四种： `command` （跑 shell 命令）、 `prompt` （注入提示词）、 `http` （发 HTTP 请求）、 `agent` （启动子 Agent）。

### Hook 结构体

```go
type Hook struct {
    ID        string    `yaml:"id"`
    Event     EventName `yaml:"event"`
    Condition string    `yaml:"if"`
    Action    Action    `yaml:"action"`
    Reject    bool      `yaml:"reject"`
    Once      bool      `yaml:"once"`
    Async     bool      `yaml:"async"`
    OnError   string    `yaml:"on_error"`
}
```

每个 Hook 就是一条规则：在什么事件（ `Event` ）、满足什么条件（ `Condition` ）时，执行什么动作（ `Action` ）。 `Reject` 表示这个 Hook 要不要阻断工具执行， `Once` 表示只触发一次， `Async` 表示异步执行不阻塞主流程， `OnError` 控制动作失败时的行为（ `fail` / `ignore` / `reject` 三选一）。

### Engine：Hook 引擎

```go
type Engine struct {
    mu            sync.Mutex
    hooks         []Hook
    notifications []HookResult
    fired         map[string]bool
    AgentRunner   func(prompt string, ctx HookContext) (string, error)
}
```

`Engine` 是 Hook 系统的核心。 `hooks` 存所有注册的 Hook 规则， `notifications` 是一个结果队列，异步 Hook 的执行结果会先放在这里，等外部来 drain。 `fired` 是一个 map，用来追踪哪些 `once` 类型的 Hook 已经触发过了。 `AgentRunner` 是一个可选的回调函数，只有 agent 类型的 Hook 才需要它。

注意所有字段都由 `sync.Mutex` 保护。因为 Hook 可以异步执行，多个 goroutine 可能同时读写这些状态。 `notifications` 队列是异步 Hook 和主流程之间的桥梁：异步 Hook 在后台跑完后把结果塞进队列，主流程在合适的时机调用 `DrainNotifications()` 一次性取走所有积压的结果。

## 主流程走读：RunHooks vs RunPreToolHooks

Hook 系统对外暴露两个入口，设计意图完全不同。理解它们的差异是理解整个 Hook 系统的关键。

### RunHooks：通用的 fire-and-forget

```go
for _, h := range e.snapshotHooks() {
    if h.Event != ctx.EventName { continue }
    if !e.shouldFire(h, ctx) { continue }
    if h.Async {
        go func(h Hook) {
            res := e.executeAction(h, ctx)
            e.recordNotification(res)
        }(h)
        continue
    }
    result := e.executeAction(h, ctx)
    results = append(results, result)
}
return results
```

逻辑很直白：遍历所有 Hook，先按事件名过滤，再调 `shouldFire` 检查条件和 `once` 状态。匹配上的 Hook，如果标记了 `Async` 就开 goroutine 扔后台跑，否则同步执行。不管成功还是失败，都不会中断流程。 `session_start` 、 `turn_end` 、 `post_tool_use` 这些事件走的都是这条路径。

注意开头的 `snapshotHooks()` 调用。它会在锁里复制一份 hooks 切片出来，这样遍历过程中即使有人调用 `LoadHooks` 更新规则，也不会影响正在执行的这一轮。这是个经典的「快照隔离」模式，用一次浅拷贝换来无锁遍历。

两个过滤条件值得展开说。事件名过滤是第一道筛子，把不相关的 Hook 直接跳过。 `shouldFire` 是第二道，它先做条件表达式求值（下一节会详细讲），然后检查 `once` 标记。如果一个 Hook 设了 `Once: true` 且 ID 已经在 `fired` map 里出现过，就不再触发。这个 `fired` map 在 `LoadHooks` 的时候会被重置，意味着重新加载配置后所有 `once` 状态都会清零。

### RunPreToolHooks：唯一能阻断执行的入口

```go
func (e *Engine) RunPreToolHooks(ctx HookContext) (bool, string) {
    for _, h := range e.snapshotHooks() {
        if h.Event != EventPreToolUse { continue }
        if !e.shouldFire(h, ctx) { continue }
        result := e.executeAction(h, ctx)
        e.recordNotification(result)
        if h.Reject || (!result.Success && h.OnError == "reject") {
            msg := result.Output
            if msg == "" { msg = "blocked by hook " + h.ID }
            return true, msg
        }
    }
    return false, ""
}
```

这个方法只处理 `pre_tool_use` 事件，返回值是 `(rejected, message)` 。关键区别在于：一旦某个 Hook 配置了 `Reject: true` ，或者执行失败且 `OnError` 设为 `reject` ，整个工具调用就被拦截了。Agent Loop 那边收到 `rejected=true` 就不会真正执行工具，而是把拒绝原因作为工具结果返回给 LLM。

还有一个细节：这里没有 `Async` 分支。pre-tool Hook 必须同步执行完才能知道要不要拦截，异步在这里没有意义。另外，reject 的判断有两条路径：一条是 Hook 配置里直接写了 `Reject: true` ，这是「我就是要拦截」；另一条是动作执行失败了且 `OnError` 设为 `reject` ，这是「出错就当拦截处理」。两条路径最终效果一样，但语义不同。

## 条件匹配

### evaluateCondition：递归下降的简易解析器

条件字符串支持三层语法：叶子表达式（ `tool == "Bash"` ）、组合表达式（ `&&` 和 `||` ）、取反（ `!` ）。不支持括号， `&&` 和 `||` 优先级相同，严格从左到右求值。

```go
func evaluateCondition(condition string, ctx HookContext) bool {
    if condition == "" { return true }
    if tokens := splitComposite(condition); len(tokens) > 1 {
        result := evaluateCondition(tokens[0].expr, ctx)
        for i := 1; i < len(tokens); i++ {
            rhs := evaluateCondition(tokens[i].expr, ctx)
            if tokens[i].op == "&&" { result = result && rhs } else { result = result || rhs }
        }
        return result
    }
    if strings.HasPrefix(condition, "!") { return !evaluateCondition(condition[1:], ctx) }
    return evaluateLeaf(condition, ctx)
}
```

三层递归，一层处理一种语法。 `splitComposite` 按 `&&` 和 `||` 拆分，拆出多段就逐段递归求值然后组合。拆不出来就看是不是以 `!` 开头做取反，最后落到 `evaluateLeaf` 处理单个比较。

### evaluateLeaf：四种运算符

```go
func evaluateLeaf(condition string, ctx HookContext) bool {
    for _, op := range []string{"!=", "=~", "=*", "=="} {
        if idx := strings.Index(condition, op); idx >= 0 {
            left := strings.TrimSpace(condition[:idx])
            right := strings.Trim(strings.TrimSpace(condition[idx+len(op):]), `"'`)
            val := resolveVar(left, ctx)
            switch op {
            case "==": return val == right
            case "!=": return val != right
            case "=~": matched, _ := regexp.MatchString(strings.Trim(right, "/"), val); return matched
            case "=*": matched, _ := filepath.Match(right, val); return matched }
        }
    }
    return resolveVar(condition, ctx) != "" // 无运算符 → truthy 检查
}
```

四种运算符： `==` 精确匹配、 `!=` 不等、 `=~` 正则匹配、 `=*` glob 通配。运算符的扫描顺序有讲究， `!=` 排在 `==` 前面，是因为如果先找 `==` ，那 `!=` 里的 `=` 也会被匹配到。最后一行是兜底：如果没有运算符，就当作变量的 truthy 检查，变量非空就是 true。

### resolveVar：变量解析

`resolveVar` 把条件里的变量名映射到 `HookContext` 的字段。支持 `tool` 、 `event` 、 `file_path` 、 `message` 四个内置变量，以及 `args.KEY` 的点号语法来访问工具参数的任意字段。比如 `args.command` 能拿到 Bash 工具的具体命令内容。

## 四种动作执行器

### command：跑 shell 命令

```go
func runCommand(h Hook, ctx HookContext) HookResult {
    cmd := exec.Command("bash", "-c", h.Action.Command)
    cmd.Env = append(cmd.Environ(),
        "MEWCODE_EVENT="+string(ctx.EventName),
        "MEWCODE_TOOL="+ctx.ToolName,
        "MEWCODE_FILE_PATH="+ctx.FilePath,
    )
    var stdout, stderr bytes.Buffer
    cmd.Stdout = &stdout
    cmd.Stderr = &stderr
    err := cmd.Run()
    // ...
}
```

直接用 `bash -c` 执行用户配置的命令。巧妙的地方在于它会自动注入三个环境变量： `MEWCODE_EVENT` 、 `MEWCODE_TOOL` 、 `MEWCODE_FILE_PATH` 。这样用户的脚本不需要解析参数，直接读环境变量就能拿到上下文信息。

### prompt：注入提示词

prompt 类型是最简单的，直接把 `Action.Message` 作为输出返回，不执行任何外部操作。调用方拿到这个输出后会注入到对话上下文里，影响 LLM 的后续行为。整个执行器就四行代码。

### http：发 HTTP 请求

```go
body := h.Action.Body
if body == "" {
    payload := map[string]any{
        "event": string(ctx.EventName), "tool": ctx.ToolName,
        "tool_args": ctx.ToolArgs, "file_path": ctx.FilePath,
        "message": ctx.Message, "error": ctx.Error,
    }
    if b, err := json.Marshal(payload); err == nil {
        body = string(b)
    }
}
```

如果用户没有自定义 body，就自动把整个 `HookContext` 序列化成 JSON 发出去。默认方法是 POST，默认超时 10 秒，响应体最多读 64KB。这种「合理默认值 + 全量覆盖」的设计让简单场景零配置就能用，复杂场景也不受限。

### agent：启动子 Agent

agent 类型的执行器通过 `Engine.AgentRunner` 回调实现。Engine 本身不依赖 Agent 模块，只是预留了一个函数签名，由上层在初始化时注入。如果没有注入，执行时会返回一个清晰的错误：「agent-type hook configured but no AgentRunner registered」。这种依赖倒置让 Hook 模块保持了零外部依赖的干净状态。

## 小结

| 设计决策 | Go 的实现方式 |
| --- | --- |
| 事件模型 | 9 个 `EventName` 常量，字符串枚举 |
| 阻断能力 | 只有 `RunPreToolHooks` 能 `reject`，其余 `fire-and-forget` |
| 条件语法 | 自制递归下降解析器，四种运算符 + 组合 + 取反 |
| 异步执行 | `Async` 标记 → `go func()` + `notifications` 队列 |
| once 追踪 | `fired map[string]bool` + `sync.Mutex` 保护 |
| 动作扩展 | `executeAction` 四路 `switch`，各自独立实现 |
| 依赖隔离 | `agent` 类型通过 `AgentRunner` 回调注入，零外部 `import` |
