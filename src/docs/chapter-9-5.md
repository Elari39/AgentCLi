# Go源码解析：会话持久化与记忆提取

派大星 6月12日 13:20

> 理论篇讲了记忆系统的三类记忆和提取机制，这篇带你走读 Go 版 MewCode 的真实代码，看看「让 Agent 拥有长期记忆」是怎么用文件系统和后台子 Agent 实现的。

## 模块概览

记忆系统的代码分布在三个目录下：

**internal/memory/**

| 文件 | 职责 |
| --- | --- |
| `memory.go` | Manager 结构体，管理记忆目录的读写和列举 |
| `memory_types.go` | 四种记忆类型定义和完整的类型描述提示词 |
| `instructions.go` | 项目指令文件的发现、加载、@include 展开 |
| `find_relevant_memories.go` | LLM 驱动的记忆召回 |
| `memdir.go` | 记忆行为提示词组装，MEMORY.md 截断保护 |
| `memory_scan.go` | 并发扫描记忆目录，解析 frontmatter |
| `memory_age.go` | 记忆新鲜度计算和过期警告 |
| `paths.go` | 记忆目录路径计算和归属判断 |

**internal/memory/extractor/**

| 文件 | 职责 |
| --- | --- |
| `extractor.go` | 后台记忆提取子 Agent |
| `prompts.go` | 提取 Agent 的指令提示词 |

**internal/session/ 和 internal/history/**

| 文件 | 职责 |
| --- | --- |
| `session/session.go` | 会话持久化，JSONL 格式存档读档 |
| `history/history.go` | 输入历史，记录用户输过的 prompt |

## 核心类型

Manager 是个很薄的协调层，实际记忆写入由 Agent 的 Write/Read 工具完成，它只负责构建记忆内容（注入到 messages）和支持 `/memory` 命令。四种记忆类型（`user` / `feedback` / `project` / `reference`）构成封闭分类体系，核心原则是只保存「从当前项目状态推导不出来」的信息。 `type` 字段同时决定存储位置： `user` / `feedback` 进用户级目录 `~/.mewcode/memory/` （跟人走）， `project` / `reference` 进项目级目录 `<projectRoot>/.mewcode/memory/` （跟项目走）。SessionInfo 用时间戳 + 4 字符随机后缀做 ID，按时间排序且避免同秒冲突。

## 三类记忆

### 项目指令：优先级栈与 @include

`DiscoverInstructions` 从四个位置按优先级由低到高加载指令文件：

```go
func DiscoverInstructions(workDir string) []InstructionSource {
    var sources []InstructionSource
    seen := map[string]bool{}
    // 1. 用户全局 ~/.mewcode/
    // 2. 项目：从 git root 到 workDir 每层目录
    for _, dir := range projectInstructionDirs(workDir) {
        add(&sources, seen, filepath.Join(dir, "MEWCODE.md"))
        add(&sources, seen, filepath.Join(dir, "AGENTS.md"))
    }
    // 3. 旧版 INSTRUCTIONS.md
    // 4. 本地覆盖 MEWCODE.local.md
    return sources
}
```

越靠后加载的文件越晚出现在上下文里，模型注意力更偏向后面的内容，所以离工作目录越近的指令优先级越高。 `expandIncludes` 做递归展开，用 `seen` 集合防循环引用，遇到代码块就跳过以免误解析 `@` 符号。

### 会话持久化：JSONL 存档

会话用 JSONL 格式存储在 `.mewcode/sessions/` 下。 `SaveMessage` 用 append 模式写文件：

```go
func SaveMessage(workDir, sessionID string, msg Message) {
    f, err := os.OpenFile(
        sessionFilePath(workDir, sessionID),
        os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
    defer f.Close()
    data, _ := json.Marshal(msg)
    f.Write(data)
    f.Write([]byte("\n"))
}
```

JSONL 的好处是追加写入不需要读取整个文件。输入历史（ `history` 包）同理，上限 200 条。

### 自动记忆：文件 + 索引二层结构

每条记忆是独立的 `.md` 文件带 YAML frontmatter， `MEMORY.md` 是该目录的索引。 `paths.go` 暴露两个目录： `GetAutoMemPath(projectRoot)` 返项目级 `<projectRoot>/.mewcode/memory/` ， `GetUserAutoMemPath()` 返用户级 `~/.mewcode/memory/` ，两个 frontmatter 里 `type` 字段决定该条记忆落到哪边。两个目录都各有一份 `MEMORY.md` ，加载时由 `BuildMemoryPrompt(displayName, userMemDir, projectMemDir)` 分别注入到 system prompt。 `IsAutoMemPath` 同时接受两个目录做沙箱判断（任一命中即合法），路径末尾保留分隔符避免 `…/memoryxyz` 这种相邻目录被误判为命中。 `MEMORY.md` 每边都有两道截断保护（200 行 / 25KB），截断时先按行切再按字节切到最后一个换行处，避免切断半行。

## 自动记忆提取

记忆提取挂在第4章的 `OnLoopComplete` 回调上。Extractor 的核心设计是「合并」：

```go
func (e *Extractor) executeImpl(ctx context.Context) error {
    e.mu.Lock()
    if e.inProgress {
        e.pendingContext = &pendingExtractionCtx{}
        e.mu.Unlock()
        return nil
    }
    e.mu.Unlock()
    return e.runExtraction(ctx, false)
}
```

上一轮提取还在跑时，新调用只在 `pendingContext` 记一笔。当前提取结束后检查这个标记，有值就跑一轮 trailing extraction。这保证任意时刻最多只有一个提取 Agent 在运行。

`runExtraction` 先检查主 Agent 是否自己已写过记忆（命中任一目录就跳过），然后分别扫描两个记忆目录（ `ScanMemoryFiles(ctx, dir, scope)` 给每个 header 打上 `user` / `project` scope 标签）合并成 manifest 注入提示词，最后 fork 子 Agent 执行。子 Agent 最多跑 5 轮迭代，权限模式是 Bypass（后台没有 TUI 弹窗），路径沙箱 `PathSandbox(MemoryDir, UserMemoryDir)` 允许它写两个记忆目录任一。提示词专门有 `## Memory storage paths` 段告诉 LLM 哪个 type 该写到哪个绝对路径；提示词里还有个效率策略：第 1 轮并行读所有要更新的文件，第 2 轮并行写入，不交替读写浪费轮次。

## 记忆召回

`FindRelevantMemories` 用 LLM 做选择器。它分别扫两个记忆目录（user-level + project-level）合并所有 header，给每条打上 `Scope` 标签（"user" / "project"），再排除已展示的，把清单和用户查询发给 LLM 选最多 5 条：

```go
func FindRelevantMemories(ctx context.Context, query string,
    userMemDir, projectMemDir string,
    recentTools []string,
    alreadySurfaced map[string]struct{},
    selector SelectorFn,
) ([]RelevantMemory, error) {
    var all []MemoryHeader
    if userMemDir != "" {
        userScan, _ := ScanMemoryFiles(ctx, userMemDir, "user")
        all = append(all, userScan...)
    }
    if projectMemDir != "" {
        projectScan, _ := ScanMemoryFiles(ctx, projectMemDir, "project")
        all = append(all, projectScan...)
    }
    memories := filterOut(all, alreadySurfaced)
    selected, _ := selectRelevantMemories(
        ctx, query, memories, recentTools, selector)
    return mapToRelevantMemory(selected, memories), nil
}
```

`SelectorFn` 回调让 memory 包不依赖 llm 包。选择器会避开用户正在用的工具的文档（对话里已有），但仍选该工具的「注意事项」类记忆。选中后 `MemoryFreshnessText` 给超过 1 天的记忆附加过期警告，防止 Agent 把旧记忆里已过时的文件路径和函数名当成事实。

## 小结

| 设计决策 | Go 的实现方式 |
| --- | --- |
| 指令优先级 | 从全局到本地按序加载， `seen` 集合防循环引用 |
| 会话存储 | JSONL 追加写入，免去整文件反序列化 |
| 会话 ID | `YYYYMMDD-HHMMSS-xxxx` ：时间戳 + 4 字符 hex 随机后缀（ `crypto/rand` ，纳秒兜底）防同秒冲突 |
| 记忆存储 | 按 `type` 双路：user/feedback 进 `~/.mewcode/memory/` （跟人走），project/reference 进 `<projectRoot>/.mewcode/memory/` （跟项目走） |
| 记忆索引 | 用户级 + 项目级各一份 `MEMORY.md` ，每份双截断保护（200 行 / 25KB） |
| 提取触发 | OnLoopComplete 回调，fire-and-forget |
| 提取合并 | `inProgress` + `pendingContext` 最多一个子 Agent |
| 提取 prompt | `## Memory storage paths` 段把两个目录的绝对路径喂给 LLM，按 type 路由写入 |
| 工具沙箱 | `PathSandbox(MemoryDir, UserMemoryDir)` 允许两个记忆目录任一 + `ModeBypass` 跳过用户确认 |
| 记忆召回 | 双目录扫描合并 manifest 后送 SelectorFn 选 ≤5 条，回调解耦 LLM 依赖 |
| 过期保护 | MemoryFreshnessText 附加验证提醒 |
