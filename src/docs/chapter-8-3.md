# Go源码解析：上下文压缩与溢写

派大星 6月12日修改

> 理论篇讲了两层上下文管理的设计，这篇带你走读 Go 版 MewCode 的真实代码。两个文件，约 460 行，把「怎么在有限窗口里维持长对话」以及「压缩之后怎么不让模型瞬间失忆」这两个问题一起解决得很干净。

## 模块概览

上下文管理拆成两个文件，按职责分工：

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `internal/compact/compact.go` | 240 | 两层上下文压缩：Layer 1 溢写裁剪 + Layer 2 LLM 全量摘要，外加熔断和手动入口 |
| `internal/compact/recovery.go` | 221 | 压缩后恢复：跨轮记录文件快照与技能调用，摘要消息后面拼回「最近读过的文件 / 已激活的技能 / 当前可用工具 / 收尾提示」四段 |

总共不到 500 行，没有任何接口抽象。这种「小而全」的组织方式是因为上下文管理本身就是一个内聚的问题：判断要不要压缩、怎么压缩、压缩完怎么重建对话、重建之后怎么补回工作记忆，全部紧密耦合，拆开反而增加跳转成本。

## 核心类型

### 常量：五条控制线

```go
const (
    autoCompactThreshold  = 0.80
    singleResultLimit     = 15000
    messageAggregateLimit = 20000
    oldResultSnipChars    = 2000
    keepRecentTurns       = 10
)
```

这五个常量划出了整个上下文管理的行为边界。 `autoCompactThreshold` 是 Layer 2 的触发线，上下文用量超过窗口的 80% 才启动 LLM 摘要。 `singleResultLimit` 是单个工具结果的溢写阈值，一个 grep 结果超过 15000 字符就往磁盘上写。这个值必须严格大于 `tools.MaxOutputChars` （10000），否则被截断到 10K 的工具输出（比如读一个中等大小的源文件）会反复触发溢写，溢写后读回来又是约 10K 又触发溢写，形成反馈循环。 `messageAggregateLimit` 是单条消息里所有工具结果加起来的上限，20000 字符。 `oldResultSnipChars` 和 `keepRecentTurns` 配合使用：最近 10 轮对话不动，更老的消息里超过 2000 字符的工具结果直接裁掉。

### AutoCompactTrackingState：熔断状态

```go
type AutoCompactTrackingState struct {
    ConsecutiveFailures int
}
```

就一个字段，记录 Layer 2（LLM 摘要）连续失败了几次。配合常量 `MaxConsecutiveAutoCompactFailures = 3` 使用。连续失败 3 次就不再尝试，避免在上下文已经炸掉的情况下反复调 API 浪费钱。成功一次就归零。这就是经典的熔断器模式，用最小的状态实现了保护。

### EstimateTokens：3.5 字符一个 Token

```go
func EstimateTokens(messages []conversation.Message) int {
    total := 0
    for _, m := range messages {
        total += int(float64(len(m.Content))/3.5) + 4
        for _, tu := range m.ToolUses {
            argsJSON, _ := json.Marshal(tu.Arguments)
            total += 50 + int(float64(len(argsJSON))/3.5)
        }
        for _, tr := range m.ToolResults {
            total += int(float64(len(tr.Content))/3.5) + 10
        }
        for _, tb := range m.ThinkingBlocks {
            total += int(float64(len(tb.Thinking)) / 3.5)
        }
    }
    return total
}
```

这个函数不走 API，纯本地估算。3.5 个字符约等于 1 个 Token，每条消息额外加 4 个 Token 的开销，每个工具调用额外加 50。不精确，但足够用来做阈值判断。精确计数需要调 Tokenizer，每轮循环都调一次太贵了。

## 主流程走读

### 入口：ManageContext()

```go
func ManageContext(
    ctx context.Context,
    conv *conversation.Manager,
    client llm.Client,
    workDir string,
    contextWindow int,
    tracking *AutoCompactTrackingState,
) (string, error) {
```

Agent Loop 每轮迭代都会调这个函数。它做三件事，严格按顺序来。

第一步，无条件执行 Layer 1（溢写和裁剪）。不管上下文用了多少，先把能省的省掉：

```go
if msg := offloadAndSnip(conv, workDir); msg != "" {
    parts = append(parts, msg)
}
```

第二步，估算当前 Token 用量，如果没超过 80% 的阈值就直接返回。大部分情况下走到这里就结束了，Layer 2 根本不会被触发：

```go
tokens := EstimateTokens(conv.GetMessages())
if float64(tokens)/float64(contextWindow) <= autoCompactThreshold {
    return strings.Join(parts, "; "), nil
}
```

第三步，检查熔断器。如果之前连续失败了 3 次，放弃 Layer 2，带着 Layer 1 的结果直接返回：

```go
if tracking != nil &&
    tracking.ConsecutiveFailures >= MaxConsecutiveAutoCompactFailures {
    return strings.Join(parts, "; "), nil
}
```

熔断器没触发，才真正调用 `autoCompact` 做 LLM 摘要。成功了把 `ConsecutiveFailures` 归零，失败了加一。这个设计让 Agent 在极端情况下能优雅降级，而不是卡死在不断失败的压缩尝试里。

## 第一层：溢写和裁剪

`offloadAndSnip` 是 Layer 1 的实现，不调用 LLM，纯本地操作。它对对话历史做三种处理，按顺序走。

### 操作一：单结果溢写

```go
for j, tr := range m.ToolResults {
    if alreadySpilled(tr.Content) || len(tr.Content) <= singleResultLimit {
        continue
    }
    path, err := writeSpill(spillDir, tr.ToolUseID, tr.Content)
    if err != nil {
        continue
    }
    messages[i].ToolResults[j].Content = fmt.Sprintf(
        "[Result of %d chars saved to %s — read with ReadFile if needed]",
        len(tr.Content), path,
    )
}
```

任何单个工具结果超过 5000 字符，就把完整内容写到 `.mewcode/tool_results/<tool_use_id>` 文件里，对话里替换成一行摘要。 `alreadySpilled` 检查内容是不是已经被替换过了，防止重复处理。 `writeSpill` 的错误处理是静默跳过，溢写失败不影响 Agent 继续工作，最多就是上下文大一点。

### 操作二：聚合溢写

```go
agg := 0
for _, tr := range m.ToolResults {
    agg += len(tr.Content)
}
if agg > messageAggregateLimit {
    for j, tr := range m.ToolResults {
        if alreadySpilled(tr.Content) || len(tr.Content) <= 200 {
            continue
        }
        // writeSpill + replace...
    }
}
```

单条消息里所有工具结果加起来超过 20000 字符时，把每个超过 200 字符的结果都溢写出去。这处理的是「一次调了很多工具，每个结果都不大，但加起来很多」的场景。注意这里的阈值从 5000 降到了 200，因为聚合超标时要更激进地释放空间。

### 操作三：裁剪过期结果

```go
boundary := len(messages) - keepRecentTurns*3
if i < boundary {
    for j, tr := range messages[i].ToolResults {
        if alreadySpilled(tr.Content) || len(tr.Content) <= oldResultSnipChars {
            continue
        }
        messages[i].ToolResults[j].Content = fmt.Sprintf(
            "[Stale output snipped: %d chars]", len(tr.Content))
    }
}
```

`keepRecentTurns` 乘以 3 是因为一轮对话通常对应三条消息（assistant 带工具调用、tool result、下一条 user 或 assistant）。超过这个边界的老消息，工具结果超过 2000 字符就直接裁成一行「已裁剪」的占位符，不落盘。这和溢写的区别是：溢写保留了完整内容可以用 ReadFile 读回来，裁剪是真的丢弃了。老旧的工具输出大概率不需要了，直接丢是合理的。

三个操作跑完，如果有任何修改，就调 `rebuildConversation` 用修改后的消息列表重建整个对话：

```go
if !changed {
    return ""
}
rebuildConversation(conv, messages)
```

### writeSpill：幂等磁盘写入

```go
func writeSpill(dir, toolUseID, content string) (string, error) {
    if err := os.MkdirAll(dir, 0o755); err != nil {
        return "", err
    }
    path := filepath.Join(dir, toolUseID)
    if st, err := os.Stat(path); err == nil &&
        st.Size() == int64(len(content)) {
        return path, nil
    }
    return path, os.WriteFile(path, []byte(content), 0o644)
}
```

文件名就是 `tool_use_id` ，天然唯一。如果文件已经存在且大小一样，直接跳过写入。这让整个溢写操作是幂等的，ManageContext 被反复调用不会产生重复写入。

## 第二层：全量摘要

Layer 1 做完之后如果上下文还是超过 80%，就进入 `autoCompact` 。这一层要调 LLM，把整个对话压缩成一段摘要。

### 构造摘要请求

```go
var sb strings.Builder
for _, m := range messages {
    sb.WriteString(fmt.Sprintf("[%s]: %s
", m.Role, m.Content))
    for _, tu := range m.ToolUses {
        sb.WriteString(fmt.Sprintf("[tool_use %s]: %s
",
            tu.ToolName, tu.ToolUseID))
    }
    for _, tr := range m.ToolResults {
        content := tr.Content
        if len(content) > 500 {
            content = content[:500] + "..."
        }
        // ...
    }
}
```

先把整个对话历史序列化成纯文本。注意工具结果在这里又做了一次截断，每个最多保留 500 字符。因为这段文本是喂给 LLM 做摘要用的，不需要完整的工具输出，只要 LLM 能理解发生了什么就行。

然后创建一个全新的临时对话，把 `summarySystemPrompt` 和序列化的对话拼在一起发给 LLM：

```go
summaryConv := conversation.NewManager()
summaryConv.AddUserMessage(summarySystemPrompt + "

" + sb.String())
events, errs := client.Stream(ctx, summaryConv, nil)
```

第二个参数 `nil` 表示不给 LLM 任何工具。摘要阶段 LLM 只需要输出文本，不能调工具。

### 两阶段解析

`summarySystemPrompt` 要求 LLM 先输出 `<analysis>` 分析块，再输出 `<summary>` 摘要块。 `formatCompactSummary` 负责从原始输出里提取最终摘要：

```go
func formatCompactSummary(raw string) string {
    if start := strings.Index(raw, "<summary>"); start >= 0 {
        body := raw[start+len("<summary>"):]
        if end := strings.Index(body, "</summary>"); end >= 0 {
            return strings.TrimSpace(body[:end])
        }
        return strings.TrimSpace(body)
    }
    // fallback: 去掉 analysis 块，返回剩余内容
    // ...
    return strings.TrimSpace(raw)
}
```

为什么要两阶段？ `<analysis>` 是 LLM 的思考草稿，让它在总结之前先把对话脉络捋清楚，这样 `<summary>` 的质量更高。最终只保留 `<summary>` 的内容， `<analysis>` 被丢弃。如果 LLM 没有按格式输出（没有 `<summary>` 标签），函数会退回到把 `<analysis>` 块剥掉后返回剩余文本，确保不会丢失摘要。

### 重建对话

```go
compacted := conversation.NewManager()
compacted.AddUserMessage(
    fmt.Sprintf("[Compacted conversation summary]

%s", finalSummary))
compacted.AddAssistantMessage(
    "Understood. I'll continue based on this context.")
*conv = *compacted
```

用摘要创建一个全新的对话，只有两条消息：一条 user 消息放摘要内容，一条 assistant 消息表示「我理解了，继续工作」。然后用指针赋值直接替换掉原来的对话。从 Agent 的视角看，整个对话历史瞬间被替换成了一段精炼的摘要，上下文占用大幅下降。

### ForceCompact：手动入口

```go
func ForceCompact(
    ctx context.Context,
    conv *conversation.Manager,
    client llm.Client,
    contextWindow int,
) (string, error) {
    return autoCompact(ctx, conv, client, contextWindow)
}
```

用户输入 `/compact` 命令时走这个入口。直接调 `autoCompact` ，跳过 Layer 1，也不检查阈值和熔断器。因为这是用户主动要求的，应该无条件执行。

## 第三层：压缩后恢复

Layer 2 把上下文压回去了，但带来一个副作用。模型刚才还能直接看到完整代码片段、工具输出、用户原话，摘要一替换全没了。接下来用户问「刚才那个文件里 handleError 是怎么写的」，模型只能基于摘要里那两三句话猜，错的概率不低。 `internal/compact/recovery.go` 解决的就是这个问题。

恢复模块的本质是一个跨轮存活的快照仓库。它记两类东西：最近读过的文件，和最近触发过的技能。结构很直白：

```go
type RecoveryState struct {
    mu     sync.Mutex
    files  map[string]FileReadRecord
    skills map[string]SkillInvocationRecord
}

type FileReadRecord struct {
    Path      string
    Content   string
    Timestamp time.Time
}
```

加锁是必要的。ReadFile 在 `StreamingExecutor` 里会被并发触发，多个 goroutine 同时往里写不能丢数据。 `RecordFileRead` 与 `RecordSkillInvocation` 在 nil receiver 上直接 return，这是给测试和一次性脚本的安全网，不需要刻意构造 state 也不会崩。

### 何时记录

ReadFile 工具是关键入口。 `executeSingleTool` 在工具执行成功后多做一件事：

```go
result := tool.Execute(ctx, tc.Arguments)
if !result.IsError && tc.ToolName == "ReadFile" {
    if p, _ := tc.Arguments["file_path"].(string); p != "" {
        if data, err := os.ReadFile(p); err == nil {
            a.RecoveryState.RecordFileRead(p, string(data))
        }
    }
}
```

这里有个微妙的设计：不是从 `result.Output` 里拿内容，而是单独再 `os.ReadFile` 一次。原因是工具输出有行号前缀（ `1 <line>` 这种），拿来恢复反而带噪音。重读一次纯净的字节是更稳的选择，代价不过是一次额外打开文件。

技能的记录走另一条路径。 `internal/tui/tui.go` 在调用 `skills.RunInline` 之后调 `m.ag.RecoveryState.RecordSkillInvocation(...)` ，把渲染后的 SOP 写进 state。fork 路径稍微不同，需要在调 `skills.RunFork` 之前 record，因为 RunFork 不返回 body，只能记原始的 `skill.PromptBody` 。

### 限额硬上限

四个常量决定了恢复块最多有多大：

```go
const (
    RecoveryFileLimit      = 5
    RecoveryTokensPerFile  = 5_000
    RecoverySkillsBudget   = 25_000
    RecoveryTokensPerSkill = 5_000
    recoveryCharsPerToken  = 3.5
)
```

最多 5 个文件、每个最多 5000 token；技能总预算 25000 token、单技能 5000 token 上限。这些是硬上限，超出就丢，不报错。这意味着恢复块的体积可以预测，最坏情况大约 60K token，远低于 80% 的压缩触发线。换句话说，恢复块自己不会反过来把上下文撑爆，下一次 `ManageContext` 检查阈值的时候不会立刻又触发压缩。

`truncateByTokens` 按 `len(s) > budget * 3.5` 判断溢出，超额尾部截断并追加 `… (content truncated)` 标记。这个标记是给模型看的提示，让它知道这里不是完整内容，需要的话要重读。

### 渲染四段

`BuildRecoveryAttachment` 把 state 和当前工具表渲染成四段纯文本，顺序固定：最近读过的文件、已激活的技能、当前可用工具、收尾提示。每段都可能为空，全空时返回 `""` ，调用方就当压缩没附带恢复块处理。文件段按时间戳倒序排，最近读的在最上面。

```go
if files := state.snapshotFiles(RecoveryFileLimit); len(files) > 0 {
    sb.WriteString("## Recently read files

")
    sb.WriteString("These snapshots are what the file-reading tool last returned. Re-open with the tool if you need the current bytes.

")
    for _, f := range files {
        content := truncateByTokens(f.Content, RecoveryTokensPerFile)
        ts := f.Timestamp.UTC().Format("2006-01-02T15:04:05Z")
        fmt.Fprintf(&sb, "### %s  (read %s)

", f.Path, ts)
        sb.WriteString("```
")
        sb.WriteString(content)
        if !strings.HasSuffix(content, "
") {
            sb.WriteByte('
')
        }
        sb.WriteString("```

")
    }
}
```

工具段是关键的一段。摘要替换之后，模型如果不知道自己还有什么工具可用，行为会变保守，宁可问用户也不肯发起调用。把工具表显式写一遍，给模型一个清晰的「你还能这样做」的提醒。这一段的内容是字符串渲染层面给的提示，API 层面的 `tools` 参数其实每次请求本来就会带，所以是双重保险。

收尾提示是一段固定的小段落：

> Everything above the divider is reconstructed context. For exact code, error strings, or user-typed text, re-read the source rather than guess from the summary.

这段话修正的是模型一个常见错误倾向。它看到摘要里说「修改了 foo.go 的 handleError」，可能就直接基于摘要里那几句话改代码，结果改错。这段提示明确告诉它：要原文请去重读，别猜。

### 拼到摘要后面

`autoCompact` 在生成 `finalSummary` 之后做最后一步：

```go
content := fmt.Sprintf("[Compacted conversation summary]

%s", finalSummary)
if attachment := BuildRecoveryAttachment(recovery, toolSchemas); attachment != "" {
    content += "

---

" + attachment
}
compacted := conversation.NewManager()
compacted.AddUserMessage(content)
compacted.AddAssistantMessage("Understood. I'll continue based on this context.")
```

恢复块就是简单的字符串拼接，用 `---` 分隔，全部塞在同一条 user 消息里。下一条 assistant 确认消息保持不变。从对话结构上看，整段会话史现在只剩两条消息：一条带摘要+恢复的 user，一条 ack 的 assistant。

### 工具表的早期计算

主循环开头多了一行：

```go
toolSchemas := a.currentToolSchemas()
if msg, err := compact.ManageContext(ctx, conv, a.Client, a.WorkDir,
    a.ContextWindow, &a.compactTracking,
    a.RecoveryState, toolSchemas); err == nil && msg != "" {
    ch <- CompactEvent{Message: msg}
}
// ...
events, errs := a.Client.Stream(ctx, apiConv, toolSchemas)
```

为什么要在 `ManageContext` 之前就把 `toolSchemas` 算好？因为恢复块里的「可用工具」段必须和下一次 `client.Stream` 看到的工具集完全一致。如果先调 `ManageContext` 再算 schemas，两次结果可能不同（比如 `ToolNameFilter` 在中间被改过），模型就会被骗：恢复块说有 A 工具但 API 请求里没传，或者反过来。一次算好两边复用，逻辑上更可靠。

## 小结

| 设计决策 | Go 的实现方式 |
| --- | --- |
| 两层架构 | Layer 1（ `offloadAndSnip` ）每轮无条件跑，Layer 2（ `autoCompact` ）超 80% 才触发 |
| 溢写幂等 | 文件名用 `tool_use_id` ，写前检查文件大小，相同则跳过 |
| 三种裁剪策略 | 单结果 > 5000 溢写、聚合 > 20000 全部溢写、过期 > 2000 直接裁掉 |
| LLM 摘要质量 | 两阶段提示词： `<analysis>` 思考 + `<summary>` 输出，只保留后者 |
| 对话重建 | 摘要作为 user 消息 + 一条 assistant 确认，指针赋值替换原对话 |
| 熔断保护 | `ConsecutiveFailures` 计数，连续 3 次失败后停止自动压缩 |
| 手动入口 | `ForceCompact` 跳过 Layer 1、阈值检查和熔断，直接执行 LLM 摘要 |
| Token 估算 | 3.5 字符/Token 近似，不调 API，每轮循环零成本 |
| 跨轮快照 | `RecoveryState` 用 `sync.Mutex` 保护两张 map，ReadFile 后重读字节落帐 |
| 恢复块限额 | 5 文件 × 5K token / 25K token 技能预算 / 单技能 5K，总长可预测稳定在 60K 内 |
| 工具表对齐 | 主循环开头一次性算 `toolSchemas` ，恢复块和 `client.Stream` 复用同一份 |
