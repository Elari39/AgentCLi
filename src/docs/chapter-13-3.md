# Go源码解析：子 Agent 创建与任务管理

派大星 6月12日修改

> 理论篇讲了 SubAgent 的两种创建模式和执行路径，这篇带你走读 Go 版 MewCode 的 `internal/agents/` 目录，看看「把 Agent 当工具使」到底是怎么实现的。

## 模块概览

SubAgent 的代码集中在 `internal/agents/` 目录下，一共五个文件：

| 文件 | 职责 |
| --- | --- |
| `definition.go` | `AgentDefinition` 结构体、Markdown frontmatter 解析 |
| `loader.go` | `AgentLoader`，从三个位置加载 Agent 定义 |
| `subagent.go` | `SubAgentSpec`、`TaskManager`、`SpawnSubAgent`、三个内置 Agent |
| `tool_filter.go` | 六层工具过滤，控制子 Agent 能用哪些工具 |
| `agent_tool.go` | `AgentTool` 的 `Execute` 入口，分发到四条执行路径 |

五个文件加起来约 1080 行。最重的是 `agent_tool.go` ，占了一半，因为它要处理四条执行路径。

## 核心类型

### AgentDefinition：Markdown 里的 Agent

用户可以用 Markdown 文件定义一个专用 Agent。文件用 YAML frontmatter 声明元信息，正文就是 system prompt：

```go
type AgentDefinition struct {
    AgentType       string   `yaml:"name"`
    WhenToUse       string   `yaml:"description"`
    DisallowedTools []string `yaml:"disallowedTools"`
    Model           string   `yaml:"model"`
    MaxTurns        int      `yaml:"maxTurns"`
    SystemPrompt    string   `yaml:"-"`
    FilePath        string   `yaml:"-"`
    Source          string   `yaml:"-"`
}
```

`ParseAgentFile` 负责解析。它检测开头有没有 `---` ，有就按三段拆分：第一段空、第二段 YAML frontmatter、第三段正文作为 SystemPrompt。没有 frontmatter 的文件整体当 system prompt，但 `name` 和 `description` 是必填字段，缺了直接报错。Model 字段不做白名单校验，只对 `inherit` 做大小写标准化，任意模型字符串都接受（第三方模型如 `glm-5.1` 必须能透传）。

### SubAgentSpec：运行时配置

`AgentDefinition` 通过 `ToSpec()` 转成 `SubAgentSpec` ，后者才是真正创建子 Agent 的运行时配置，包含 Name、Description、DisallowedTools、SystemPromptOverride、MaxTurns、Model 六个字段。这层转换是为了解耦： `AgentDefinition` 带着文件路径和来源信息，属于加载阶段的产物； `SubAgentSpec` 是纯运行时配置，内置 Agent 也直接用它，不需要经过文件解析。

### TaskManager：后台任务追踪

后台运行的子 Agent 需要有人管理生命周期。 `TaskManager` 就干这个：

```go
type TaskManager struct {
    mu            sync.Mutex
    tasks         map[string]*Task
    nextID        int
    notifications []TaskNotification
}
```

每个后台任务有五种状态： `pending → running → completed/failed/cancelled` 。 `TaskManager` 用互斥锁保护并发读写。通知机制采用拉模式：子 Agent 完成时调 `SetCompleted` ，把通知攒进 `notifications` 切片，父 Agent 在每轮迭代前调 `DrainNotifications` 一次性取走，避免 channel 阻塞。

## 两种创建模式

### Definition-based：预定义专家

这条路径用 `AgentLoader` 从三个位置加载 Agent 定义，后加载的覆盖先加载的：

```go
func (l *AgentLoader) LoadAll() error {
    // 1. 内置定义（general-purpose, plan, explore）
    for name, spec := range BuiltinSpecs { ... }
    // 2. ~/.mewcode/agents/*.md（用户级）
    l.loadDir(filepath.Join(home, ".mewcode", "agents"), "user")
    // 3. .mewcode/agents/*.md（项目级）
    l.loadDir(filepath.Join(l.workDir, ".mewcode", "agents"), "project")
    return nil
}
```

三个内置 Agent 各有特色： `general-purpose` 是万能型，200 轮上限，不限工具； `plan` 是只读规划师，禁用 EditFile 和 WriteFile，15 轮上限，自带 system prompt 约束只能读代码做方案； `explore` 是快速搜索员，同样只读，用 haiku 模型跑，不设 MaxTurns（默认 200 轮），追求速度。之前 30 轮的上限被移除了，因为 LLM 做代码搜索时需要发出很多 ToolSearch/Glob/Grep 调用，30 轮经常不够用。

### Fork-based：继承上下文的临时助手

Fork 模式不需要预定义。调用 Agent 工具时不指定 `subagent_type` 就走 Fork 路径，核心是 `buildForkedConversation` ，把父 Agent 的完整对话历史复制给子 Agent：

```go
func buildForkedConversation(
    parent *conversation.Manager, task string,
) *conversation.Manager {
    forked := conversation.NewManager()
    msgs := parent.GetMessages()
    for _, msg := range msgs {
        // 复制每条消息，处理未完成的 tool_use
    }
    forked.AddUserMessage(forkBoilerplate + "\n\nYour task:\n" + task)
    return forked
}
```

这里有个细节：如果父对话里有 assistant 消息带着 tool\_use 但还没有对应的 tool\_result，直接复制会让 API 报错。所以 `buildForkedConversation` 检测这种情况，给未完成的 tool\_use 补上占位 result： `(tool execution interrupted by fork)` 。

Fork 模式还有嵌套保护。它往对话里注入了带 `<fork_boilerplate>` 标记的文字，如果父对话已包含这个标记，说明当前已经是 Fork 出来的子 Agent，就拒绝再次 Fork。

## 工具过滤

子 Agent 不该和父 Agent 有一样的权限。 `FilterToolsForAgentEx` 实现了六层过滤：

```go
// Layer 1: MCP 工具（mcp__ 前缀）直接放行
if IsMCPTool(name) { filtered.Register(t); continue }
// Layer 2: 全局禁用（7 个工具对所有子 Agent 都不可用）
if AllAgentDisallowedTools[name] { continue }
// Layer 3: 自定义 Agent 额外禁用
if isCustom && CustomAgentDisallowedTools[name] { continue }
// Layer 4: 异步 Agent 白名单（16 个工具）+ InProcessTeammate 扩展
if isAsync && !AsyncAgentAllowedTools[name] { ... continue }
// Layer 5: 定义级黑名单（如 plan Agent 禁用 EditFile）
if disallowed[name] { continue }
// Layer 6: 定义级白名单交集
if hasWhitelist && !allowed[name] { continue }
```

Layer 1 让 MCP 工具跳过所有过滤，因为 MCP 工具通常有自己的权限控制。Layer 2 的 `AllAgentDisallowedTools` 包含 7 个工具： `TaskOutput` 、 `ExitPlanMode` 、 `EnterPlanMode` 、 `Agent` 、 `AskUserQuestion` 、 `TaskStop` 、 `Workflow` 。禁 `Agent` 防止无限递归，禁 `AskUserQuestion` 因为子 Agent 没有用户 UI。Layer 4 的 `AsyncAgentAllowedTools` 白名单包含 16 个工具：ReadFile、WebSearch、TodoWrite、Grep、WebFetch、Glob、Bash、EditFile、WriteFile、NotebookEdit、Skill、LoadSkill、SyntheticOutput、ToolSearch、EnterWorktree、ExitWorktree。如果子 Agent 是 InProcessTeammate（ch15 团队模式），还额外允许 Agent 工具和协调工具。Layer 6 是定义级白名单交集，只有当定义里声明了 `tools` 字段时才生效。

## 执行路径

`AgentTool.Execute` 是调度中心，根据参数决定走哪条路径：先检查 `team_name` ，有的话走 `runAsTeammate` （ch15 团队模式入口）。然后看 `subagent_type` ，没指定就走 `runFork` 。指定了就解析 spec，再根据 `run_in_background` 选择 `runSync` 还是 `runAsync` 。

`runSync` 是最常用的路径。创建全新对话，注入 system prompt 和用户 prompt，调 `subAgent.Run()` 阻塞消费直到子 Agent 结束。如果指定了 `isolation: "worktree"` ，先创建临时 git worktree，结束后没变更就自动清理，有变更就保留并告诉父 Agent 分支名。

`runAsync` 最简单，调 `SpawnSubAgent` 在后台跑，立刻返回 task ID。 `runFork` 也总是后台运行，复制父对话后启动 goroutine 立即返回。

`runAsTeammate` 最复杂，检查 team 存在性、成员名唯一性、worktree 隔离，通过 `teams.SpawnTeammate` 启动，后续协调走 SendMessage 和 mailbox。

## 小结

| 设计决策 | Go 的实现方式 |
| --- | --- |
| Agent 定义格式 | Markdown + YAML frontmatter，`ParseAgentFile` 解析 |
| 三层加载 | 内置 → 用户目录 → 项目目录，后者覆盖前者 |
| 上下文隔离 | `Definition` 模式全新对话，`Fork` 模式复制 + 补丁 |
| 工具权限 | 六层过滤：MCP 直通 → 全局禁用(7) → 自定义禁用 → 异步白名单(16) → 定义级黑名单 → 定义级白名单 |
| 后台任务 | `TaskManager` + `DrainNotifications` 拉模式 |
| 执行分发 | `team` → `fork` → `sync`/`async` 四条路径 |
| 文件隔离 | 可选 `worktree`，无变更自动清理 |
