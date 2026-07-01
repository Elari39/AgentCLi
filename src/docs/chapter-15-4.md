# Go源码解析：多 Agent 团队协作

派大星 6月12日修改

> 🔗 原文链接： [⁣⁢⁣⁣⁡Go源码解析：多 Agent 团队协作](https://q00ax5us1um.feishu.cn/wiki/GUrTwR2qoihulBkIMafcukebnjb)

> ⏰ 剪存时间：2026-06-11 23:38:49

> ✂️ 本文档由 [游侠飞书剪存](https://pwwjpto7tva.feishu.cn/wiki/space/7517832277555544092) 一键生成

> 💖 更多好物请访问 [游侠创客](https://uibot.cn/) 微信：xuefuta

> 15-4

> 理论篇讲了 Agent Teams 如何把一次性的子任务升级为长期协作团队，这篇来走读 Go 版 MewCode 的真实代码。整个模块 10 个文件，约 1630 行，是全课程最大的单模块。

## 模块概览

Agent Teams 的代码集中在 internal/teams/ 目录下：

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `teams.go` | 189 | `Team` / `Member` / `TeamManager` 定义，成员生命周期 |
| `runner.go` | 220 | 队友主循环（`idle poll` → `agent run` → `idle notify`），通信格式 |
| `spawn.go` | 177 | `SpawnTeammate` 统一入口，按后端分发，`CLI` 构建 |
| `tools.go` | 177 | `SendMessage` / `TeamCreate` / `TeamDelete` 三个协调工具 |
| `filemailbox.go` | 137 | 基于文件的收件箱，`JSON` 存储 + 文件锁 |
| `inprocess.go` | 85 | `In-process` 后端启动、身份注入、消息注入 |
| `coordinator.go` | 31 | 协调模式的工具白名单 |
| `backend.go` | 21 | `detectBackend` 后端自动检测 |
| `tmux.go` | 24 | `Tmux` 后端：`new-window` 启动，`kill-window` 停止 |
| `iterm.go` | 55 | `iTerm2` 后端：`AppleScript` 创建/关闭 `tab` |

文件虽多，但架构很清晰： teams.go 定义数据结构， runner.go 驱动执行循环， spawn.go 做后端分发， filemailbox.go 管通信， tools.go 暴露给 LLM 使用。其余都是后端适配。

## 核心类型

### Team 和 Member

```go
type Member struct {
    Name     string
    AgentRef *agent.Agent
    Conv     *conversation.Manager
    Active   bool
    Cancel   context.CancelFunc
    PaneID   string  // tmux/iTerm 的外部句柄
}

type Team struct {
    Name    string
    Mode    TeamMode
    Members map[string]*Member
    MailBox *FileMailBox
    mu      sync.Mutex
}
```

Member 代表团队里的一个队友。In-process 模式下 AgentRef 和 Conv 都有值，队友的 Agent 循环跑在本进程的 goroutine 里。Tmux/iTerm 模式下这两个字段为空，因为队友的 LLM 运行在另一个进程里，本地只留一个 PaneID 句柄用于后续关闭。

Team 持有一个 FileMailBox 做成员间通信。每个 Team 的收件箱目录在 .mewcode/teams/{teamName}/inboxes/ 下，跨进程也能通过同一个目录交换消息。

### TeamManager

```go
type TeamManager struct {
    mu    sync.Mutex
    teams map[string]*Team
}
```

TeamManager 管理所有团队的生命周期。 CreateTeam 创建新团队， DeleteTeam 停止所有成员后删除， CloseAll 在应用退出时清理全部。还有一个 CreateTeamWith 方法，给外部进程（tmux/iTerm 启动的队友进程）用，让它把自己本地构建的 Team 注册进来，这样同一个 mailbox 目录的两端就都能访问了。

### FileMailBox

```go
type FileMailBox struct {
    baseDir string
}

type FileMailMessage struct {
    From      string `json:"from"`
    Text      string `json:"text"`
    Timestamp string `json:"timestamp"`
    Read      bool   `json:"read"`
    Summary   string `json:"summary,omitempty"`
}
```

每个收件人对应一个 JSON 文件（ {agentID}.json ），所有消息追加存储。 Read 字段区分已读未读。 Send 写消息， ReadUnread 读未读消息， MarkAllRead 标记全部已读。

并发安全靠文件锁实现。 withLock 方法用 O\_CREATE|O\_EXCL 创建锁文件，创建成功就拿到锁，失败就重试（最多 10 次，每次随机等 5 到 100 毫秒）。超过 10 秒的锁文件视为过期，强制删除后重试。这套机制虽然简单，但在跨进程场景下比内存锁可靠，因为 tmux 启动的队友进程和 lead 进程不共享内存。

## 主流程走读

### 创建团队到启动队友

整个流程从 TeamCreate 工具开始。LLM 调用 TeamCreate 时， detectBackend 自动选择执行后端，然后创建 Team。接着 LLM 用 Agent 工具（带 team\_name 参数）触发 SpawnTeammate 。

SpawnTeammate 是统一入口，按 Team.Mode 分发到三个后端：

```go
func SpawnTeammate(ctx context.Context, cfg TeammateSpawnConfig) (*SpawnResult, error) {
    switch cfg.Team.Mode {
    case ModeInProcess:
        ch := StartInProcessMember(ctx, ...)
        return &SpawnResult{Mode: ModeInProcess, EventCh: ch}, nil
    case ModeTmux:
        // mailbox 写初始任务 → 构建 CLI → spawnTmuxTeammate
        return &SpawnResult{Mode: ModeTmux, PaneID: paneID}, nil
    case ModeITerm:
        // 同 tmux，只是调用 spawnITermTeammate
        return &SpawnResult{Mode: ModeITerm, PaneID: tabID}, nil
    }
}
```

In-process 模式直接在本进程启动 goroutine，返回事件 channel。Tmux 和 iTerm 模式先把初始任务写入 mailbox（因为队友进程启动后会从 mailbox 轮询第一条任务），再构建 CLI 命令，最后调用对应的 spawn 函数。

### 队友的主循环

队友启动后进入 RunInProcessTeammate ，这是整个模块最核心的函数：

```go
func RunInProcessTeammate(ctx context.Context, team *Team,
    member *Member, initialPrompt string,
    addendum string, eventOut chan<- agent.AgentEvent,
) error {
    nextPrompt := initialPrompt
    for {
        // 1. 注入邮箱里的待处理消息
        // 2. 把 nextPrompt 作为 user message 加入对话
        // 3. member.AgentRef.Run(ctx, member.Conv)
        // 4. 消费 Agent 事件流
        // 5. 发 idle 通知给 lead
        // 6. 轮询等待下一条任务或 shutdown
    }
}
```

每轮循环做六件事。先看 mailbox 有没有新消息，有就注入为 system-reminder。然后把 prompt 加入对话、启动 Agent 循环、消费事件流。Agent 结束后，往 lead 的 mailbox 里写一条 idle 通知。最后进入空闲轮询，每 500 毫秒检查一次 mailbox，有新消息就构建下一轮的 prompt 继续循环，收到 shutdown 消息就退出。

idle 通知的格式是 [idle] memberName (reason: available) ，lead 的 Agent 在每轮迭代开头通过 NotificationFn 读到这些通知，就知道哪个队友空闲了可以派活。

### 关闭流程

StopMember 按后端类型做不同处理。对于 Tmux，先 send-keys C-c 发中断信号，再 kill-window 强制关闭。对于 iTerm，用 AppleScript 按 tab 名查找并关闭。对于 In-process，直接调用 member.Cancel() 取消 context。最后把 Active 置为 false。

## 三种执行后端

### detectBackend：自动选择

```go
func detectBackend() TeamMode {
    if os.Getenv("TMUX") != "" { return ModeTmux }
    if os.Getenv("ITERM_SESSION_ID") != "" { return ModeITerm }
    if _, err := exec.LookPath("tmux"); err == nil { return ModeTmux }
    return ModeInProcess
}
```

优先级很清晰：已经在 tmux 会话里的用 tmux，已经在 iTerm2 里的用 iTerm，tmux 装了但没在里面的也用 tmux（会新开 session），都没有就退化为 in-process。

### In-process：goroutine 方案

StartInProcessMember 调用 team.AddMember 创建成员，然后启动一个 goroutine 跑 RunInProcessTeammate 。所有队友共享同一个进程的内存，通信走 FileMailBox（虽然同进程，但仍然走文件，保持和外部后端一致的通信接口）。

如果配置了 Workdir （比如 worktree 的路径），会设到 member.AgentRef.WorkDir 上，这样队友的文件操作就限制在那个 worktree 目录下。

### Tmux：new-window 方案

```go
func spawnTmuxTeammate(teamName, memberName, cliCommand string) (string, error) {
    paneName := fmt.Sprintf("%s-%s", teamName, memberName)
    cmd := exec.Command("tmux", "new-window", "-d",
        "-n", paneName, cliCommand)
    // ...
    return paneName, nil
}
```

用 tmux new-window -d 在后台创建一个新窗口，窗口名是 teamName-memberName ，里面跑的是 mewcode --teammate --team-name X --agent-name Y 命令。队友进程启动后从 mailbox 轮询到初始任务，开始工作。

### iTerm2：AppleScript 方案

iTerm 后端用 osascript 执行 AppleScript，在当前窗口创建一个新 tab，设置 tab 名，然后用 write text 执行 CLI 命令。关闭时按 tab 名遍历所有窗口的所有 tab 查找并关闭。只在 macOS 上可用。

BuildTeammateCLI 负责构建 CLI 命令字符串。它用 os.Executable() 获取当前二进制路径，拼上 --teammate 和 --team-name 等参数。如果指定了 workdir，还会在命令前加 cd workdir && 。 shellQuote 函数处理了单引号转义，防止包含空格或特殊字符的路径破坏 shell 解析。

## 通信协调

### SendMessage 工具

LLM 通过 SendMessage 工具在队友之间发消息。工具接收 to 和 content 两个参数，遍历所有团队找到收件人所在的团队，然后调用 team.SendMessage 写入对方的 mailbox。

### DrainLeadMailbox：Lead 的通知队列

```go
func DrainLeadMailbox(mgr *TeamManager) []string {
    var notes []string
    for _, name := range mgr.ListTeams() {
        team := mgr.GetTeam(name)
        msgs, _ := team.MailBox.ReadUnread(LeadName)
        // 格式化为 <team-notification> XML 标签
        notes = append(notes, sb.String())
        _ = team.MailBox.MarkAllRead(LeadName)
    }
    return notes
}
```

这个函数挂在 Lead 的 Agent.NotificationFn 上。每轮 Agent 循环开头，Lead 的 Agent 调用这个函数，把所有团队的未读消息收集起来，格式化为 <team-notification> XML 标签注入对话。Lead 看到哪个队友 idle 了，就决定是派新任务还是收工。

### CoordinatorAllowedTools：工具白名单

```go
var CoordinatorAllowedTools = map[string]bool{
    "Agent": true, "SendMessage": true,
    "TeamCreate": true, "TeamDelete": true,
    "ReadFile": true, "Glob": true, "Grep": true, "Bash": true,
    // ...
}
```

协调模式下，Lead 的工具被限制在这个白名单里。读操作（ReadFile / Glob / Grep / Bash）允许，写操作不允许。Lead 只负责拆任务、派活、审结果，具体的代码修改交给队友去做。

## 小结

| 设计决策 | Go 的实现方式 |
| --- | --- |
| 后端自动选择 | `detectBackend` 按环境变量和 `PATH` 优先级选择 |
| In-process 执行 | `goroutine` + 带缓冲 `channel` 转发事件 |
| 外部进程执行 | `Tmux new-window` / `iTerm2 AppleScript create tab` |
| 跨进程通信 | `FileMailBox`，`JSON` 文件 + 文件锁，统一接口 |
| 队友主循环 | `agent run` → `idle notify` → `poll inbox` → 下一轮 |
| Lead 感知队友状态 | `DrainLeadMailbox` 挂在 `NotificationFn` 上 |
| 工具暴露 | `SendMessage` / `TeamCreate` / `TeamDelete` 三个工具注册到 `Registry` |
| 协调模式 | `CoordinatorAllowedTools` 白名单限制 Lead 只读不写 |
| 优雅关闭 | 按后端分别处理：`cancel context` / `kill-window` / `close tab` |
