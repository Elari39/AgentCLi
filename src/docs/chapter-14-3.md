# Go源码解析：Git 工作树隔离

派大星 6月12日修改

> 理论篇讲了为什么并行 Agent 需要文件系统隔离，以及 Git Worktree 的机制。这篇带你走读 Go 版 MewCode 的 internal/worktree/ 目录，看看 10 个文件、约 1400 行代码是怎么实现完整的 Worktree 生命周期管理的。

## 模块概览

Worktree 系统的代码集中在 internal/worktree/ 目录下，按职责拆分成 10 个文件：

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `validate.go` | 82 | Slug 安全校验、分支名生成 |
| `create.go` | 140 | 核心创建逻辑， `getOrCreateWorktree` |
| `setup.go` | 245 | 创建后的环境初始化（`settings`、`hooks`、`symlink`、`.worktreeinclude`） |
| `session.go` | 198 | 会话级 Worktree 管理（主 Agent 用的入口） |
| `agent.go` | 73 | 子 Agent 专用的轻量创建/移除 |
| `changes.go` | 74 | 变更检测（是否有未提交修改或新 `commit`） |
| `cleanup.go` | 130 | 过期 Worktree 的后台清理 |
| `filesystem.go` | 377 | 纯文件系统读取 Git 状态（不启动 `git` 子进程） |
| `notice.go` | 19 | 注入子 Agent 提示词的路径翻译通知 |
| `env.go` | 51 | `Git` 子进程的环境变量配置 |

模块内部的调用关系是分层的： session.go 和 agent.go 是面向外部的入口，它们调用 create.go 创建 worktree， create.go 依赖 validate.go 做安全校验、依赖 filesystem.go 读 Git 状态、依赖 env.go 配置子进程环境。 setup.go 在创建完成后做环境初始化。 cleanup.go 独立运行后台清理循环。

## 核心类型

### Slug 校验：ValidateWorktreeSlug

```go
const MaxWorktreeSlugLength = 64

var validWorktreeSlugSegment = regexp.MustCompile(
    `^[a-zA-Z0-9._-]+$`,
)

func ValidateWorktreeSlug(slug string) error {
    if len(slug) > MaxWorktreeSlugLength {
        return fmt.Errorf("... must be %d characters or fewer ...",
            MaxWorktreeSlugLength, len(slug))
    }
    for _, segment := range strings.Split(slug, "/") {
        if segment == "." || segment == ".." {
            return fmt.Errorf("... must not contain . or .. ...")
        }
        if !validWorktreeSlugSegment.MatchString(segment) {
            return fmt.Errorf("... must be non-empty ...")
        }
    }
    return nil
}
```

Slug 最多 64 字符。正斜杠 / 允许嵌套命名（比如 team/alice ），但不是在整个字符串上做正则匹配，而是按 / 切分后逐段校验。每段必须匹配 [a-zA-Z0-9.\_-]+ ， . 和 .. 单独排除，防止路径穿越。这很重要，因为 slug 最终会被拼进 .mewcode/worktrees/<slug> 路径， ../../../etc 这样的 slug 会逃逸出 worktrees 目录。

嵌套 slug 在创建时会被 FlattenSlug 压平： team/alice → team+alice 。 + 在 git 分支名和文件系统路径里都合法，但不在 slug 的字符白名单里，所以这个映射是单射的（不会碰撞）。

### CreateResult：创建结果

```go
type CreateResult struct {
    WorktreePath   string
    WorktreeBranch string
    HeadCommit     string
    BaseBranch     string
    Existed        bool
}
```

Existed 标记是快速恢复还是新创建。新创建时需要跑 performPostCreationSetup ，快速恢复跳过。 HeadCommit 保存基线 SHA，后续 HasWorktreeChanges 用它来判断是否有新 commit。

### WorktreeSession：会话状态

```go
type WorktreeSession struct {
    OriginalCwd        string `json:"original_cwd"`
    WorktreePath       string `json:"worktree_path"`
    WorktreeName       string `json:"worktree_name"`
    WorktreeBranch     string `json:"worktree_branch,omitempty"`
    OriginalBranch     string `json:"original_branch,omitempty"`
    OriginalHeadCommit string `json:"original_head_commit,omitempty"`
    SessionID          string `json:"session_id"`
    CreationDurationMs int64  `json:"creation_duration_ms,omitempty"`
}
```

会话状态记录了从哪里来（ OriginalCwd 、 OriginalBranch ）和到哪里去（ WorktreePath 、 WorktreeBranch ）。退出 worktree 时需要这些信息来恢复原始工作目录。状态会被序列化到 .mewcode/worktree\_session.json ，支持 --resume 恢复。

会话用模块级单例 + sync.RWMutex 保护并发访问：

```go
var (
    currentWorktreeSession *WorktreeSession
    sessionMu              sync.RWMutex
)
```

## 主流程走读：创建 Worktree

### 两个入口

Worktree 有两个创建入口，对应不同的使用场景：

CreateWorktreeForSession 是主 Agent 用的。它会设置全局会话单例、持久化到磁盘、在新建时跑 performPostCreationSetup ：

```go
func CreateWorktreeForSession(ctx context.Context,
    sessionID, slug, repoRoot string,
) (*WorktreeSession, error) {
    if err := ValidateWorktreeSlug(slug); err != nil {
        return nil, err
    }
    result, err := getOrCreateWorktree(ctx, repoRoot, slug)
    if err != nil { return nil, err }
    if !result.Existed {
        performPostCreationSetup(ctx, repoRoot, result.WorktreePath)
    }
    // 构建 session、设置全局单例、持久化到磁盘
    // ...
}
```

CreateAgentWorktree 是子 Agent 用的。它不碰全局会话状态，不 chdir，是轻量的：

```go
func CreateAgentWorktree(ctx context.Context,
    slug string,
) (*AgentWorktreeResult, error) {
    // ValidateWorktreeSlug → FindCanonicalGitRoot → getOrCreateWorktree
    if !result.Existed {
        performPostCreationSetup(ctx, gitRoot, result.WorktreePath)
    } else {
        // 更新 mtime，防止清理循环把正在用的 worktree 当过期的删了
        _ = os.Chtimes(result.WorktreePath, now, now)
    }
    // ...
}
```

两个入口最终都调用同一个核心函数 getOrCreateWorktree 。

### getOrCreateWorktree：核心创建逻辑

```go
func getOrCreateWorktree(ctx context.Context,
    repoRoot, slug string,
) (*CreateResult, error) {
    worktreePath := WorktreePathFor(repoRoot, slug)
    worktreeBranch := WorktreeBranchName(slug)

    // 快速恢复：如果 worktree 已存在，直接返回
    existingHead, _ := ReadWorktreeHeadSha(worktreePath)
    if existingHead != "" {
        return &CreateResult{
            WorktreePath: worktreePath,
            WorktreeBranch: worktreeBranch,
            HeadCommit: existingHead,
            Existed: true,
        }, nil
    }
```

快速恢复路径用 ReadWorktreeHeadSha 直接读文件系统，不启动 git 子进程。在 16M 对象的大仓库里，这比 git rev-parse HEAD 省了约 15ms 的进程启动开销。如果 .git 指针文件存在且能解析出 HEAD SHA，说明 worktree 已经存在，跳过后续所有步骤。

创建路径需要解析 base branch 和执行 git worktree add ：

```go
    // 解析默认分支（纯文件系统读取，不 fetch）
    defaultBranch, _ := GetDefaultBranch(repoRoot)
    gitDir, _ := ResolveGitDir(repoRoot)
    baseSha, _ := ResolveRef(gitDir, "refs/remotes/origin/"+defaultBranch)
    if baseSha != "" {
        baseBranch = "origin/" + defaultBranch
    } else {
        // origin/<default> 不存在，尝试 fetch，失败就用 HEAD
        _, _, fetchCode := runGit(ctx, repoRoot, "fetch", "origin", defaultBranch)
        if fetchCode == 0 {
            baseBranch = "origin/" + defaultBranch
        } else {
            baseBranch = "HEAD"
        }
    }

    // -B（大写）：如果分支已存在就重置，省掉一次 git branch -D
    _, stderr, code := runGit(ctx, repoRoot,
        "worktree", "add", "-B", worktreeBranch, worktreePath, baseBranch)
```

这里有两个关键设计。第一，base branch 的解析优先走纯文件系统读取（ ResolveRef 直接读 refs/remotes/origin/main 文件），只在本地没有 remote ref 时才 fetch。在大仓库里 fetch 会触发 commit-graph 扫描，花 6-8 秒，能跳过就跳过。第二，用 -B （大写）而不是 -b （小写）。小写 b 在分支已存在时会报错，大写 B 会重置分支。这省掉了一次额外的 git branch -D 子进程。

## 创建后初始化：performPostCreationSetup

Git worktree 创建后只有源码，没有配置文件、git hooks、node\_modules 这些东西。 performPostCreationSetup 做四件事：

```go
func performPostCreationSetup(ctx context.Context,
    repoRoot, worktreePath string,
) {
    copySettingsLocal(repoRoot, worktreePath)
    configureHooksPath(ctx, repoRoot, worktreePath)
    symlinkDirectories(repoRoot, worktreePath, getSymlinkDirectories())
    CopyWorktreeIncludeFiles(ctx, repoRoot, worktreePath)
}
```

**A. 复制本地设置** 。把 .mewcode/settings.local.json 从主仓库复制到 worktree，传播本地配置（可能包含密钥）。

**B. 配置 git hooks 路径** 。设置 core.hooksPath ，优先指向 .husky/ ，其次 .git/hooks/ 。这样 worktree 里的 git 操作也会触发 hooks。

**C. 符号链接大目录** 。 node\_modules 、 vendor 这类目录如果每个 worktree 都复制一份，几百 MB 的磁盘就没了。通过 symlink 共享这些目录，worktree 创建瞬间就能用包管理器的产出。但这是 opt-in 的，需要在配置里声明 symlinkDirectories 。

**D. 复制 .worktreeinclude 文件** 。有些 gitignored 文件在 worktree 里也需要（比如 .env 、编译配置）。 .worktreeinclude 文件列出了这些文件的 glob 模式， CopyWorktreeIncludeFiles 用 git ls-files --others --ignored 列出被 gitignore 的文件，然后按模式匹配复制。

## 变更检测

子 Agent 在 worktree 里干完活后，需要知道它改了什么。 HasWorktreeChanges 做两个检查：

```go
func HasWorktreeChanges(ctx context.Context,
    worktreePath, headCommit string,
) bool {
    stdout, _, code := runGit(ctx, worktreePath,
        "status", "--porcelain")
    if code != 0 { return true } // fail-closed
    if strings.TrimSpace(stdout) != "" { return true }

    stdout, _, code = runGit(ctx, worktreePath,
        "rev-list", "--count", headCommit+"..HEAD")
    if code != 0 { return true } // fail-closed
    n, _ := strconv.Atoi(strings.TrimSpace(stdout))
    return n > 0
}
```

先看有没有未提交的修改（ git status --porcelain ），再看有没有新 commit（ git rev-list --count baseCommit..HEAD ）。所有异常情况都返回 true （fail-closed），宁可多保留一个 worktree，不误删有价值的工作。

CountWorktreeChanges 返回更详细的统计（改了几个文件、几个 commit），供 ExitWorktree 工具展示给用户。

## 过期 Worktree 清理

Agent 创建的 worktree 可能因为进程崩溃而残留。 CleanupStaleAgentWorktrees 做三层安全过滤后才删除：

```go
func CleanupStaleAgentWorktrees(ctx context.Context,
    cutoffDate time.Time,
) int {
    for _, entry := range entries {
        slug := entry.Name()
        // Layer 1: 只清理临时 worktree（匹配 ephemeral 模式）
        if !isEphemeralSlug(slug) { continue }
        // Layer 2: 跳过当前会话和最近修改的
        if info.ModTime().After(cutoffDate) { continue }
        // Layer 3: 有未提交修改或未推送 commit 就跳过
        statusOut, _, statusCode := runGit(ctx, worktreePath,
            "--no-optional-locks", "status", "--porcelain", "-uno")
        if statusCode != 0 || strings.TrimSpace(statusOut) != "" { continue }
        // 全部通过才删
        RemoveAgentWorktree(ctx, worktreePath, WorktreeBranchName(slug), gitRoot)
    }
}
```

ephemeralWorktreePatterns 匹配自动生成的 worktree 名（如 agent-a1b2c3d4 、 wf\_xxxx-yyy-1 ），用户手动命名的（如 my-feature ）永远不会被自动清理。 -uno 参数跳过 untracked 文件扫描，在大仓库里快 5-10 倍。

StartCleanupLoop 在后台 goroutine 里用 ticker 定期触发清理。间隔和 cutoff 都可配置，默认 cutoff 是 720 小时（30 天）。

## 纯文件系统读取 Git 状态

filesystem.go 是模块里最大的文件（377 行），它实现了不启动 git 子进程的 Git 状态读取。这在性能敏感的路径上很重要，比如 worktree 的快速恢复路径。

核心函数：

ResolveGitDir 读 .git 文件/目录，处理 worktree 和 submodule 的 gitdir: 指针。

readGitHead 解析 HEAD 文件： ref: refs/heads/<branch> 是分支，裸 SHA 是 detached HEAD。

ResolveRef 先查 loose ref 文件，再查 packed-refs。对 worktree 场景，先查 worktree 自己的 gitDir，再查 commonDir（主仓库的 .git）。

所有读取都做了安全校验： IsSafeRefName 检查 ref 名是否只包含安全字符（字母数字和 /.\_+@- ），排除 .. 穿越和 - 开头的参数注入。 IsValidGitSha 校验 SHA 是 40 位或 64 位的纯 hex 字符串。

## 小结

| 设计决策 | Go 的实现方式 |
| --- | --- |
| Slug 校验 | 64 字符上限，per-segment 正则 `[a-zA-Z0-9._-]+`，禁止 `.` / `..` 段 |
| 嵌套 slug | `FlattenSlug` 用 `+` 替换 `/`，避免 D/F 冲突和目录嵌套 |
| 分支创建 | `git worktree add -B`（大写，`force reset`），省掉 `branch -D` |
| Base branch | 纯文件系统读取优先，只在 `remote ref` 不存在时才 `fetch` |
| 快速恢复 | `ReadWorktreeHeadSha` 直接读 `.git` 指针文件，不启动 `git` 子进程 |
| 创建后初始化 | 四步：`settings` 复制、`hooks` 配置、目录 `symlink`、`worktreeinclude` 文件复制 |
| 变更检测 | `status --porcelain` + `rev-list --count`，`fail-closed` 策略 |
| 过期清理 | 三层安全过滤（`ephemeral` 模式 + 年龄 + 变更检查），后台 `goroutine` `ticker` |
| Git 状态读取 | 纯文件系统（`ResolveGitDir`/`readGitHead`/`ResolveRef`），`ref` 名和 `SHA` 做安全校验 |
| 两个入口 | `CreateWorktreeForSession`（主 Agent，带会话状态）和 `CreateAgentWorktree`（子 Agent，轻量） |
