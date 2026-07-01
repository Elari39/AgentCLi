# Go源码解析：命令注册与分发

派大星 6月12日 13:20

> 理论篇讲了 Slash Command 的设计思路和三种命令类型，这篇带你走读 Go 版 MewCode 的真实代码，看看一个斜杠命令是怎么从用户输入变成执行结果的。

## 模块概览

Slash Command 的代码集中在 `internal/commands/` 目录下，一共两个文件：

| 文件 | 职责 |
| --- | --- |
| `commands.go` | 核心。命令类型定义、Registry 注册中心、Parse 解析器、13 个内置命令 |
| `loader.go` | 文件命令加载。三路径扫描、Markdown 解析、frontmatter 提取、 `$ARGUMENTS` 替换 |

两个文件加起来 516 行。

## 核心类型

### CommandType：三种命令类型

```go
type CommandType string

const (
    TypeLocal   CommandType = "local"
    TypeLocalUI CommandType = "local-ui"
    TypePrompt  CommandType = "prompt"
)
```

三种类型决定了命令的执行方式。 `Local` 是纯本地逻辑，Handler 直接返回字符串，比如 `/help` 、 `/status` 。 `LocalUI` 需要 UI 层介入，比如 `/clear` 要清屏、 `/compact` 要触发压缩，Handler 为空，由 TUI 事件循环接管。 `Prompt` 最特殊，Handler 返回的不是结果而是提示词，会被当作用户消息发给 LLM 让 Agent 去执行。

### Command 与 Context

```go
type Command struct {
    Name        string      // 主名称，对应 /name
    Description string
    Aliases     []string    // 别名，如 /h、/?
    Type        CommandType
    ArgPrompt   string      // 参数提示
    Hidden      bool        // 是否在 /help 里隐藏
    Handler     Handler     // func(ctx *Context) string
}
```

Handler 签名是 `func(ctx *Context) string` ，所有命令共用。Context 通过函数字段做依赖注入： `MemoryList` 来自记忆系统， `TokenCount` 来自对话管理器， `PermissionMode` 来自权限系统。命令不需要知道数据从哪来，只管调函数拿结果。

### Registry：注册中心

两张 map， `commands` 按主名称索引， `aliases` 把别名映射到主名称。 `Find` 先查主名称再查别名，保证 `/help` 和 `/h` 找到同一个命令。

## 主流程走读

一条斜杠命令从输入到执行，经过三步：解析输入、查找命令、按类型分发。

### 第一步：Parse 解析输入

```go
func Parse(input string) (name string, args string) {
    input = strings.TrimSpace(input)
    if !strings.HasPrefix(input, "/") {
        return "", ""
    }
    input = input[1:]
    parts := strings.SplitN(input, " ", 2)
    name = strings.ToLower(parts[0])
    if len(parts) > 1 {
        args = strings.TrimSpace(parts[1])
    }
    return
}
```

去掉空白、检查 `/` 前缀、用第一个空格切成命令名和参数。命令名统一转小写，不是 `/` 开头的直接返回空串。

### 第二步和第三步：查找 + 分发

Parse 拿到命令名后传给 `Registry.Find()` ，先查主名称再查别名，都没有就返回 nil。找到命令后，TUI 层根据 `Type` 决定怎么跑： `TypeLocal` 直接调 Handler 拿结果展示； `TypeLocalUI` 不走 Handler，由 TUI 自己处理（比如 `/clear` 清屏、 `/plan` 切模式）； `TypePrompt` 调 Handler 拿到提示词，当用户消息塞进对话交给 Agent Loop。

分发在 TUI 层完成，commands 模块只管定义和查找，不依赖 UI 实现。

## 内置命令速览

`CreateDefaultRegistry()` 注册了 13 个内置命令：

| 命令 | 别名 | 类型 | 作用 |
| --- | --- | --- | --- |
| `/help` | `/h` , `/?` | `Local` | 列出所有命令，或查看某个命令的详情 |
| `/clear` |  | `LocalUI` | 清空对话，重新开始 |
| `/compact` | `/c` | `LocalUI` | 压缩对话上下文 |
| `/status` | `/s` | `Local` | 显示当前状态（模式、Token、工具数等） |
| `/memory` |  | `Local` | 管理自动记忆（list / clear） |
| `/plan` | `/p` | `LocalUI` | 切换到 Plan Mode（只读） |
| `/do` |  | `LocalUI` | 切换回执行模式 |
| `/session` |  | `Local` | 查看会话信息 |
| `/permission` | `/perm` | `Local` | 查看或切换权限模式 |
| `/resume` | `/r` | `LocalUI` | 恢复之前的会话 |
| `/skills` |  | `Local` | 列出已安装的 Skill |
| `/review` |  | `Prompt` | 让 Agent 审查当前代码变更 |

`/review` 是唯一的 `TypePrompt` 内置命令，只拼提示词让 LLM 审查 git diff。Prompt 类型的真正威力在用户自定义命令。另外 `/memory` 和 `/permission` 支持子命令，用 `parseSubcommand` 再切一刀实现二级命令。

## 文件命令加载

loader.go 让用户用 Markdown 文件定义自己的命令。

### 三路径合并

```go
func LoadUserCommands(workDir string) []*Command {
    var dirs []string
    if home, err := os.UserHomeDir(); err == nil {
        dirs = append(dirs, filepath.Join(home, ".mewcode", "commands"))
    }
    dirs = append(dirs,
        filepath.Join(workDir, ".mewcode", "commands"),
        filepath.Join(workDir, ".claude", "commands"),
    )
    // ...
}
```

三个路径按优先级排列： `~/.mewcode/commands/` （用户全局）、 `$workDir/.mewcode/commands/` （项目级）、 `$workDir/.claude/commands/` （兼容 Claude Code）。后者覆盖前者，用 map 去重加 slice 保序。

### Markdown 解析

每个 `.md` 文件对应一条命令。文件名决定命令名： `git/log.md` 变成 `/git:log` ，子目录用冒号连接。

```go
func splitFrontmatter(content string) (CommandMeta, string) {
    if !strings.HasPrefix(strings.TrimSpace(content), "---") {
        return meta, content
    }
    parts := strings.SplitN(content, "---", 3)
    if len(parts) < 3 {
        return meta, content
    }
    _ = yaml.Unmarshal([]byte(parts[1]), &meta)
    return meta, parts[2]
}
```

frontmatter 里可以写 `description` 、 `argument-hint` 、 `aliases` 。没有 frontmatter 也没关系，Description 会 fallback 到正文的第一行非标题文本。解析失败静默降级，一个坏文件不会让整个命令系统崩溃。

### $ARGUMENTS 替换

文件命令全部注册为 `TypePrompt` ，Handler 由 `promptHandler` 生成：

```go
func promptHandler(body string) Handler {
    return func(ctx *Context) string {
        if strings.Contains(body, "$ARGUMENTS") {
            return strings.ReplaceAll(body, "$ARGUMENTS", ctx.Args)
        }
        if strings.TrimSpace(ctx.Args) == "" {
            return body
        }
        return body + "\n\n## User Request\n\n" + ctx.Args
    }
}
```

如果正文里有 `$ARGUMENTS` 占位符，直接替换。没有占位符但用户传了参数，就在末尾追加一个 `## User Request` 段落。用户写命令模板时可以精确控制参数位置，也可以完全不管让系统自动处理。

## 小结

| 设计决策 | Go 的实现方式 |
| --- | --- |
| 三种命令类型 | `CommandType` 枚举（Local / LocalUI / Prompt），分发在 TUI 层 |
| 统一 Handler | `func(ctx *Context) string` ，所有命令共用签名 |
| 依赖注入 | Context 结构体，用函数字段代替直接依赖 |
| 别名系统 | Registry 双 map（commands + aliases），Find 两层查找 |
| 文件命令 | Markdown + YAML frontmatter，三路径按优先级合并 |
| 参数传递 | `$ARGUMENTS` 占位符替换，无占位符时自动追加 |
| 容错策略 | 文件解析失败静默跳过，不影响其他命令 |
