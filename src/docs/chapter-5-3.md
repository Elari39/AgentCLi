# Go源码解析：系统提示词组装管线

派大星 6月12日修改

> 理论篇讲了 System Prompt 的七个信息来源和三条通道，这篇带你走读 Go 版 MewCode 的真实代码，看看 Prompt 组装管线是怎么一步步拼出最终发给 LLM 的那段长文本的。

## 模块概览

System Prompt 的代码集中在 `internal/prompt/` 目录下，一共三个文件：

| 文件 | 职责 |
| --- | --- |
| `builder.go` | 核心类型定义（Section / Builder / EnvironmentContext），环境探测，BuildSystemPrompt 主编排函数 |
| `sections.go` | 7 个内容模块的具体文本（Identity、System、DoingTasks 等），加一个动态拼装的 EnvironmentSection |
| `plan_mode.go` | Plan Mode 提示词模板（完整版 / 精简版 / 退出版），BuildPlanModeReminder 控制注入频率 |

三个文件加起来不到 400 行。Prompt 组装的复杂度不在代码量，而在它用最小的结构把散落各处的指令统一编排成一段有优先级的长文本。

## 核心类型

### Section：最小拼装单元

```go
type Section struct {
    Name     string // 名称，用于标识
    Priority int    // 优先级，数字越小越靠前
    Content  string // 实际内容
}
```

整个 Prompt 组装系统围绕这一个结构体展开。每个内容模块返回一个 Section，Builder 按 Priority 排序后拼接。这比直接拼字符串好在哪？每个模块可以独立定义自己的优先级，新增模块不用改已有代码的拼接顺序。

### EnvironmentContext：运行时环境快照

```go
type EnvironmentContext struct {
    WorkDir   string
    OS        string // runtime.GOOS
    Arch      string // runtime.GOARCH
    Shell     string // 从环境变量读
    IsGitRepo bool   // git 命令探测
    GitBranch string
    Model     string
    Date      string // 当天日期
}
```

这个结构体在 `DetectEnvironment` 里填充，然后传给 `EnvironmentSection` 生成动态内容。它把环境探测和内容生成分开了，方便测试时直接构造一个假的 EnvironmentContext。

### BuildOptions：可选的外部注入

```go
type BuildOptions struct {
    CustomInstructions string // 用户自定义指令（CLAUDE.md）
    SkillSection       string // Skill 系统注入
    MemorySection      string // 记忆系统注入
}
```

这三个字段对应「条件注入」的部分。有值就加，没值就跳过。后续章节的 Skill 系统、记忆系统就是通过这个入口把自己的内容塞进 System Prompt 的。

### Builder：排序拼接器

```go
func (b *Builder) Add(s Section) *Builder {
    b.sections = append(b.sections, s)
    return b // 链式调用
}

func (b *Builder) Build() string {
    sort.Slice(b.sections, func(i, j int) bool {
        return b.sections[i].Priority < b.sections[j].Priority
    })
    var parts []string
    for _, s := range b.sections {
        content := strings.TrimSpace(s.Content)
        if content != "" {
            parts = append(parts, content)
        }
    }
    return strings.Join(parts, "

")
}
```

Builder 做的事很单纯：收集所有 Section，按 Priority 升序排列，过滤空内容，用两个换行拼起来。 `Add` 返回 `*Builder` 支持链式调用，但实际使用时没有链式写法，每次都单独调 `b.Add()` 。

## 主流程走读：BuildSystemPrompt

这是整个模块的编排入口，接收环境上下文和构建选项，返回最终的 System Prompt 字符串：

```go
func BuildSystemPrompt(env EnvironmentContext, opts BuildOptions) string {
    b := NewBuilder()

    // 第一步：7 个核心模块，优先级 0-70
    b.Add(IdentitySection())       // 0
    b.Add(SystemSection())         // 10
    b.Add(DoingTasksSection())     // 20
    b.Add(ExecutingActionsSection()) // 30
    b.Add(UsingToolsSection())     // 40
    b.Add(ToneStyleSection())      // 50
    b.Add(OutputEfficiencySection()) // 60
    b.Add(EnvironmentSection(env))   // 70

    // 第二步：条件注入，优先级 80-95
    if opts.CustomInstructions != "" {
        b.Add(Section{Name: "CustomInstructions", Priority: 80, Content: ...})
    }
    if opts.SkillSection != "" {
        b.Add(Section{Name: "Skills", Priority: 90, Content: ...})
    }
    if opts.MemorySection != "" {
        b.Add(Section{Name: "Memory", Priority: 95, Content: ...})
    }

    // 第三步：排序 + 拼接
    return b.Build()
}
```

流程分三步：先加 7 个固定模块，再按条件加可选模块，最后交给 Builder 排序拼接。优先级的间隔设成 10，是为了将来在中间插入新模块时不用改动已有编号。条件注入部分的优先级从 80 开始，确保外部内容始终排在核心指令之后。

## 七个内容模块

每个模块对应 `sections.go` 里的一个函数，返回一个带固定 Priority 的 Section：

| 函数 | 优先级 | 职责 |
| --- | --- | --- |
| `IdentitySection` | 0 | 角色定义：你是谁、安全底线（禁止注入、禁止编造 URL） |
| `SystemSection` | 10 | 系统规则：输出格式、工具权限、system-reminder 标签说明、Hook 反馈 |
| `DoingTasksSection` | 20 | 任务执行准则：先读再改、优先编辑已有文件、不做过度设计 |
| `ExecutingActionsSection` | 30 | 操作安全：区分可逆操作和高风险操作，高风险需确认 |
| `UsingToolsSection` | 40 | 工具使用指南：专用工具优先于 Bash、并行调用、Agent 委派 |
| `ToneStyleSection` | 50 | 语气风格：简洁、不用 emoji、引用代码带行号 |
| `OutputEfficiencySection` | 60 | 输出效率：先说要做什么，过程中简短更新，结尾一两句总结 |

前 7 个模块的内容是硬编码的字符串常量，每次构建都会原样输出。唯一的例外是 `EnvironmentSection` ，它根据传入的 `EnvironmentContext` 动态拼装。

## 环境探测：DetectEnvironment

```go
func DetectEnvironment(workDir string) EnvironmentContext {
    env := EnvironmentContext{
        WorkDir: workDir,
        OS:      runtime.GOOS,    // 编译时确定
        Arch:    runtime.GOARCH,
        Shell:   os.Getenv("SHELL"),
        Date:    time.Now().Format("2006-01-02"),
    }
    if env.Shell == "" {
        env.Shell = "bash" // 兜底默认值
    }
    // ...git 探测...
    return env
}
```

OS 和 Arch 用 `runtime` 包直接拿，Shell 从环境变量读，日期用当天。Git 相关的探测稍复杂一些，调了两次 `exec.Command` ：

```go
// 先判断是不是 git 仓库
out, err := exec.Command("git", "-C", workDir,
    "rev-parse", "--is-inside-work-tree").Output()
if err == nil && strings.TrimSpace(string(out)) == "true" {
    env.IsGitRepo = true
    // 再拿当前分支名
    branch, err := exec.Command("git", "-C", workDir,
        "rev-parse", "--abbrev-ref", "HEAD").Output()
    if err == nil {
        env.GitBranch = strings.TrimSpace(string(branch))
    }
}
```

两次 git 命令都带 `-C workDir` ，在指定目录下执行而不是依赖当前工作目录。如果不是 git 仓库， `IsGitRepo` 保持 false，分支名为空， `EnvironmentSection` 里就不会输出 Git 相关的行。这段探测在每次构建 System Prompt 时都会跑一次，确保环境信息是最新的。

## Plan Mode 提示词

Plan Mode 的提示词不走 `BuildSystemPrompt` ，而是在 Agent Loop 里通过 `system-reminder` 通道单独注入。它有三个模板：

**完整版** （ `planModeFullReminder` ）：一段很长的文本，告诉 LLM 现在是规划模式，禁止执行写操作，只能编辑 Plan 文件。还定义了五阶段工作流：理解需求 → 设计方案 → 审查 → 写最终计划 → 退出。

**精简版** （ `planModeSparseReminder` ）：一句话，提醒 LLM Plan Mode 仍然生效，指向前面的完整说明。

**退出版** （ `planModeExitReminder` ）：告诉 LLM 已经退出规划模式，可以正常执行了。

关键是注入频率的控制逻辑：

```go
func BuildPlanModeReminder(planFilePath string,
    planExists bool, iteration int) string {
    // ...构造 planFileInfo...

    if iteration == 1 {
        return fmt.Sprintf(planModeFullReminder, planFileInfo)
    }

    attachmentIndex := (iteration - 1) / reminderInterval
    if attachmentIndex%reminderInterval == 0 {
        return fmt.Sprintf(planModeFullReminder, planFileInfo)
    }

    return fmt.Sprintf(planModeSparseReminder, planFilePath)
}
```

`reminderInterval` 是常量 5。第 1 轮一定发完整版，之后每 5 轮重复一次完整版，其余轮次发精简版。这是对上下文长度和遗忘率的折中：完整版太长，每轮都发会浪费 Token；但如果只发一次，LLM 在长对话中会逐渐「忘记」Plan Mode 的约束。定期重复完整版就是在提醒它。

`planExists` 参数决定提示 LLM「读取已有 Plan 文件」还是「创建新 Plan 文件」，细节虽小但对 LLM 的行为影响很大。

## 小结

设计决策

Go 的实现方式

内容模块化

Section 结构体 + Priority 排序，新增模块不改已有代码

优先级间隔

核心模块 0/10/20/.../70，条件注入 80/90/95，留出插入空间

环境探测

runtime 包 + os.Getenv + exec.Command 调 git

条件注入

BuildOptions 三个字段，有值才 Add

Plan Mode 频率

第 1 轮完整版，每 5 轮重复，其余精简版

内容与拼装分离

sections.go 只管内容，builder.go 只管编排
