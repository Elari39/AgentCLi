# Python源码解析：Git 工作树隔离

派大星 6月12日修改

> 理论篇讲了 Worktree 如何给每个子 Agent 一份独立的文件空间，这篇来走读 Python 版 MewCode 的实现。Python 版拆成了 8 个模块，每个职责清晰。模块总行数不到 800 行，但覆盖了从创建到自动清理的完整生命周期。

## 模块概览

Worktree 的代码集中在 mewcode/worktree/ 目录下：

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `manager.py` | 328 | 核心。`WorktreeManager` 类，`Create`/`Enter`/`Exit`/`Cleanup` 全部生命周期 |
| `models.py` | 25 | 数据类型定义：`Worktree` 和 `WorktreeSession` |
| `session.py` | 58 | 会话持久化：`JSON` 序列化/反序列化 |
| `changes.py` | 74 | 变更检测：`uncommitted` + `new commits` 计数 |
| `setup.py` | 131 | 创建后的初始化：配置复制、`Hook` 设置、符号链接、忽略文件 |
| `integration.py` | 31 | 子 Agent 集成：`worktree` 上下文通知模板 |
| `cleanup.py` | 93 | 自动清理：过期 `worktree` 识别和周期性清理任务 |
| `slug.py` | 28 | Slug 安全校验：名称合法性验证 |

文件虽多，但架构很清晰： manager.py 是入口，所有操作都通过 WorktreeManager 发起。 models.py 和 session.py 负责数据和持久化， changes.py 提供变更检测能力， setup.py 处理创建后的环境准备， cleanup.py 做过期回收。 slug.py 和 integration.py 是两个小工具模块。

## 核心类型

### Worktree 和 WorktreeSession

models.py 只有两个 dataclass，但区分了两个不同的关注点：

```python
@dataclass
class Worktree:
    name: str
    path: str
    branch: str
    based_on: str
    head_commit: str
    created: datetime = field(default_factory=datetime.now)
```

Worktree 描述一个 worktree 的静态信息。 name 是用户给的名字， path 是磁盘路径， branch 是 git 分支名（自动生成为 worktree-{slug} ）， based\_on 记录它是从哪个分支创建的， head\_commit 记录创建时的 HEAD SHA。 created 用于后续判断是否过期。

```python
@dataclass
class WorktreeSession:
    original_cwd: str
    worktree_path: str
    worktree_name: str
    original_branch: str
    original_head_commit: str
    session_id: str = ""
    hook_based: bool = False
```

WorktreeSession 记录的是「进入」worktree 之前的状态快照。 original\_cwd 保存原始工作目录， original\_branch 保存原始分支，这样退出时才知道回到哪里。 hook\_based 标记这个 session 是否由 Hook 驱动，用于区分手动进入和自动进入。

这两个 dataclass 的分离有设计意味。 Worktree 代表资源本身，可以被多个 session 使用。 WorktreeSession 代表一次使用行为，有明确的开始和结束。

### WorktreeManager

```python
class WorktreeManager:
    def __init__(
        self, repo_root: str,
        file_cache: FileCache | None = None,
        symlink_directories: list[str] | None = None,
        worktree_dir: str | None = None,
    ) -> None:
        self.repo_root = repo_root
        self.file_cache = file_cache
        self.symlink_directories = symlink_directories or []
        self.worktree_dir = worktree_dir or str(
            Path(repo_root) / ".mewcode" / "worktrees"
        )
        self._lock = asyncio.Lock()
        self.active: dict[str, Worktree] = {}
```

WorktreeManager 是整个模块的中枢。四个构造参数里， repo\_root 是必须的，其余三个都有默认值。 file\_cache 可选，进入和退出 worktree 时需要清缓存。 symlink\_directories 配置哪些目录做符号链接（比如 node\_modules ）。 worktree\_dir 默认放在 .mewcode/worktrees/ 下。

注意 \_lock 是 asyncio.Lock() ，不是 threading.Lock() 。这是因为 Python 版的 MewCode 用 asyncio 做并发，所有 worktree 操作都是 async 方法。 active 字典追踪所有活跃的 worktree， current\_session 追踪当前正在使用的 session。

还有一个 \_clear\_caches\_callback 列表，允许外部模块注册缓存清理回调：

```python
def _clear_all_caches(self) -> None:
    if self.file_cache:
        self.file_cache.clear()
    for cb in self._clear_caches_callback:
        try:
            cb()
        except Exception as e:
            log.warning("Cache clear callback failed: %s", e)
```

进入或退出 worktree 时，工作目录变了，之前缓存的文件内容全部失效。这个方法一次性把所有缓存清掉。每个回调都用 try/except 包裹，一个清理失败不影响其他的。

## 主流程走读

### Create：快速恢复 + 全新创建

create 方法有两条路径：快速恢复和全新创建。

```python
async def create(self, name: str, base_branch: str = "HEAD") -> Worktree:
    async with self._lock:
        err = validate_slug(name)
        if err:
            raise WorktreeError(err)

        if name in self.active:
            raise WorktreeError(f"worktree already exists: {name}")

        flat_slug = flatten_slug(name)
        wt_path = os.path.join(self.worktree_dir, flat_slug)
        branch_name = f"worktree-{flat_slug}"
```

先校验 slug 安全性，再检查是否重复。 flatten\_slug 把斜杠替换为加号（ feature/login 变成 feature+login ），因为斜杠不能出现在目录名里。分支名加上 worktree- 前缀，和普通分支区分开。

然后尝试快速恢复：

```python
        head_sha = self.read_worktree_head_sha(wt_path)
        if head_sha is not None:
            log.info("Fast recovery: reusing existing worktree at %s", wt_path)
            wt = Worktree(
                name=name, path=wt_path, branch=branch_name,
                based_on=base_branch, head_commit=head_sha,
            )
            self.active[name] = wt
            return wt
```

read\_worktree\_head\_sha 直接从文件系统读取 worktree 的 HEAD SHA，不需要调用 git 命令。如果读到了，说明这个 worktree 之前已经创建过了（可能是上次进程崩溃后遗留的），直接复用。这个优化很实用，避免了重复创建和不必要的 git 操作。

读 HEAD SHA 的实现值得仔细看：

```python
@staticmethod
def read_worktree_head_sha(wt_path: str) -> str | None:
    wt = Path(wt_path)
    git_file = wt / ".git"
    if not git_file.exists():
        return None

    content = git_file.read_text(encoding="utf-8").strip()
    if not content.startswith("gitdir:"):
        return None
    gitdir = Path(content.split(":", 1)[1].strip())
```

在 worktree 目录里， .git 不是一个目录，而是一个文件，内容是 gitdir: /path/to/main/.git/worktrees/xxx 。代码解析这个文件找到真正的 gitdir，然后读取 HEAD 文件获取当前引用，再解析引用找到 SHA。这条路径全是文件系统操作，不启动任何子进程，所以非常快。

如果快速恢复失败，走全新创建路径：

```python
        result = self._run_git([
            "worktree", "add",
            "-B", branch_name, wt_path, base_branch,
        ])
        if result.returncode != 0:
            raise WorktreeError(
                f"git worktree add failed: {result.stderr.strip()}"
            )

        perform_post_creation_setup(
            self.repo_root, wt_path,
            symlink_directories=self.symlink_directories,
        )
```

注意这里用的是 -B 而不是 -b 。大写 B 的意思是如果分支已存在就强制重置，小写 b 遇到同名分支会报错。这是防御性设计，避免前一次创建的分支没清理干净导致后续创建失败。

### Enter：保存现场

```python
async def enter(self, name: str) -> WorktreeSession:
    wt = self.active.get(name)
    if wt is None:
        raise WorktreeError(f"worktree not found: {name}")
    self._clear_all_caches()
    session = WorktreeSession(
        original_cwd=os.getcwd(), worktree_path=wt.path,
        worktree_name=name,
        original_branch=self._get_current_branch(),
        original_head_commit=self._get_head_commit(),
    )
    self.current_session = session
    save_worktree_session(self._mewcode_dir, session)
    return session
```

enter 做三件事：清缓存、记录现场、持久化 session。缓存清除放在最前面，因为后续操作可能依赖最新的文件状态。Session 持久化到磁盘上（JSON 格式），这样即使进程崩溃，下次启动也能恢复到正确的状态。

Session 持久化的实现在 session.py 里，逻辑很直白：

```python
def save_worktree_session(
    mewcode_dir: Path,
    session: WorktreeSession | None,
) -> None:
    path = _session_path(mewcode_dir)
    if session is None:
        path.write_text("{}", encoding="utf-8")
        return
    data = {
        "original_cwd": session.original_cwd,
        "worktree_path": session.worktree_path,
        # ...
    }
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")
```

退出时传 None 会写入一个空 JSON 对象，而不是删除文件。这是个微妙的选择，空文件比「文件不存在」更容易区分「从未使用过 worktree」和「已退出 worktree」。

### Exit：安全检查 + 可选清除

```python
async def exit(self, name: str, action: str = "keep",
               discard_changes: bool = False) -> None:
    wt = self.active.get(name)
    if wt is None:
        raise WorktreeError(f"worktree not found: {name}")

    if action == "remove" and not discard_changes:
        changes = count_worktree_changes(wt.path, wt.head_commit)
        if changes.uncommitted > 0 or changes.new_commits > 0:
            raise WorktreeError(
                f"worktree has changes ..."
                "Set discard_changes=True to force removal."
            )
```

exit 有两种模式： keep 保留 worktree 目录（下次可以复用）， remove 删除。删除时如果有未保存的变更，必须显式传 discard\_changes=True 才行。这是一道安全阀，防止 LLM 误删有价值的工作成果。

变更检测在 changes.py 里，同时检查两个维度：

```python
def count_worktree_changes(wt_path: str, head_commit: str) -> Changes:
    changes = Changes()
    status = _run_git(["status", "--porcelain"], cwd=wt_path)
    if status.returncode == 0:
        changes.uncommitted = len(
            [line for line in status.stdout.splitlines() if line.strip()]
        )

    rev_list = _run_git(
        ["rev-list", "--count", f"{head_commit}..HEAD"], cwd=wt_path
    )
    if rev_list.returncode == 0:
        changes.new_commits = int(rev_list.stdout.strip())
    return changes
```

git status --porcelain 检查未提交的改动， git rev-list --count 检查创建后新增的提交。两个维度都查，是因为子 Agent 可能已经 commit 了但还没 push，这种情况 status 是干净的但 rev-list 不是。

## 安全校验

### validate\_slug：四层防护

```plaintext
_SEGMENT_RE = re.compile(r"^[a-zA-Z0-9._-]+$")

def validate_slug(name: str) -> str | None:
    if not name:
        return "name cannot be empty"
    if len(name) > MAX_SLUG_LENGTH:
        return f"name too long (max {MAX_SLUG_LENGTH} characters)"
    segments = name.split("/")
    for seg in segments:
        if not seg:
            return "name contains empty segment"
        if seg in (".", ".."):
            return "name must not contain '.' or '..' as a segment"
        if not _SEGMENT_RE.match(seg):
            return f"invalid segment: {seg!r} ..."
    return None
```

校验逻辑按斜杠分段，然后逐段验证，非常细致。空段意味着连续斜杠（ a//b ），单点和双点防止路径穿越（ ../../../etc/passwd ），正则白名单只允许安全字符。返回 None 表示校验通过，返回字符串表示错误原因。这个设计让调用方可以把错误信息直接返回给用户。

flatten\_slug 则更简单，一行搞定：

```python
def flatten_slug(name: str) -> str:
    return name.replace("/", "+")
```

斜杠替换为加号， feature/login 变成 feature+login 。这样既能用作目录名，又保留了原始结构的可读性。

## 创建后初始化

setup.py 的 perform\_post\_creation\_setup 做了四件事：

```python
def perform_post_creation_setup(
    repo_root: str, wt_path: str,
    symlink_directories: list[str] | None = None,
) -> None:
    _copy_local_configs(root, wt)
    _setup_git_hooks(root, wt)
    _create_symlinks(root, wt, symlink_directories or [])
    _copy_ignored_files(root, wt)
```

第一步，复制本地配置文件（ settings.local.json 、 .env ）到 worktree。这些文件被 gitignore 了不会跟着 worktree 走，但子 Agent 运行需要它们。

第二步，设置 Git Hook 路径。Worktree 默认不继承主仓库的 hooks：

```python
def _setup_git_hooks(root: Path, wt: Path) -> None:
    husky_dir = root / ".husky"
    if husky_dir.is_dir():
        hooks_path = str(husky_dir)
    else:
        git_hooks = root / ".git" / "hooks"
        if git_hooks.is_dir():
            hooks_path = str(git_hooks)

    subprocess.run(
        ["git", "config", "core.hooksPath", hooks_path],
        cwd=str(wt), capture_output=True, timeout=10,
    )
```

优先用 Husky 的 .husky 目录，没有就用 .git/hooks 。通过 git config core.hooksPath 让 worktree 指向主仓库的 hooks 目录，保持提交规范一致。

第三步，创建符号链接。 node\_modules 这种大目录不适合每个 worktree 都复制一份：

```python
def _create_symlinks(root: Path, wt: Path, directories: list[str]) -> None:
    for dirname in directories:
        src = root / dirname
        dst = wt / dirname
        if not src.exists():
            continue
        if dst.exists() or dst.is_symlink():
            continue
        os.symlink(str(src), str(dst))
```

源不存在就跳过，目标已存在也跳过，不报错。这两个跳过条件让这段代码可以重复调用而不出问题。

第四步比较特别。 \_copy\_ignored\_files 读取 .worktreeinclude 配置文件，把里面列出的被 gitignore 的文件复制到 worktree。这个设计解决的是「有些被忽略的文件是运行时必需的」这个问题，比如编译产物或生成的配置文件。

## 自动清理

cleanup.py 提供了两个层次的清理能力。

### cleanup\_stale\_worktrees：按条件清理

```plaintext
EPHEMERAL_PATTERNS = [
    re.compile(r"^agent-[0-9a-f]{7,8}$"),
    re.compile(r"^wf_[0-9a-f]{8}"),
]

def _is_ephemeral(name: str) -> bool:
    return any(p.match(name) for p in EPHEMERAL_PATTERNS)
```

清理只针对「临时」worktree，通过正则匹配名称来判断。 agent- 开头的是子 Agent 自动创建的， wf\_ 开头的是工作流创建的。用户手动命名的 worktree（比如 feature/login ）不会被自动清理。

清理的决策逻辑有五层过滤：

```python
async def cleanup_stale_worktrees(manager: WorktreeManager, cutoff_hours: int) -> int:
    cutoff = datetime.now() - timedelta(hours=cutoff_hours)
    for entry in worktree_dir.iterdir():
        if not _is_ephemeral(name):         # 1. 只清理临时的
            continue
        if manager.current_session and ...:  # 2. 跳过正在使用的
            continue
        if mtime > cutoff:                   # 3. 跳过还年轻的
            continue
        if has_worktree_changes(...):        # 4. 跳过有未保存变更的
            continue
        if has_unpushed_commits(...):        # 5. 跳过有未推送提交的
            continue
        # 全部通过才删除
```

五层过滤保证了清理的安全性。特别是第四和第五层，即使 worktree 已经超时，只要里面有没保存或没推送的工作，就不会被删掉。宁可多占一点磁盘空间，也不丢失有价值的工作成果。

### start\_stale\_cleanup\_task：后台定时器

```python
async def start_stale_cleanup_task(
    manager: WorktreeManager,
    interval: int,
    cutoff_hours: int,
) -> None:
    while True:
        await asyncio.sleep(interval)
        try:
            count = await cleanup_stale_worktrees(manager, cutoff_hours)
            if count:
                log.info("Stale worktree cleanup removed %d worktrees", count)
        except Exception as e:
            log.warning("Stale worktree cleanup error: %s", e)
```

用 asyncio.sleep 做定时轮询。注意它先 sleep 再清理，所以第一次清理不会在启动时立刻发生。整个循环用 try/except 包裹，一次清理异常不会中断后续的定时任务。

### Session 恢复

Manager 还有一个 restore\_session 方法，用于进程重启后恢复状态：

```python
def restore_session(self) -> WorktreeSession | None:
    session = load_worktree_session(self._mewcode_dir)
    if session is None:
        return None
    head_sha = self.read_worktree_head_sha(wt_path)
    if head_sha is None:
        save_worktree_session(self._mewcode_dir, None)
        return None
    # ... 重建 Worktree 对象，恢复 active 和 current_session
```

先从磁盘加载 session，再验证 worktree 目录是否还存在（通过读 HEAD SHA）。如果 worktree 已经被手动删除了，就清理掉持久化的 session 数据。这个「先加载，再验证」的模式在崩溃恢复场景下很重要。

## 小结

| 设计决策 | Python 的实现方式 |
| --- | --- |
| 安全校验 | 按斜杠分段逐段验证，拦截空段/路径穿越/非法字符 |
| 文件隔离 | `git worktree add -B` 创建独立工作目录，`-B` 容忍残留分支 |
| 快速恢复 | 直接从文件系统读 `HEAD SHA`，不启动子进程 |
| 依赖共享 | 配置化 `symlink_directories` 做符号链接 |
| 环境同步 | 四步 `setup`：配置复制 → `Hook` 设置 → 符号链接 → 忽略文件复制 |
| 并发保护 | `asyncio.Lock()` 保护 `worktree` 操作 |
| 状态持久化 | `Session` 写入 `JSON` 文件，崩溃后可恢复 |
| 安全退出 | 删除前检查 `uncommitted` + `new commits`，需显式 `force` |
| 过期清理 | 五层过滤 + `asyncio.sleep` 定时循环 |
| 缓存一致 | `Enter`/`Exit` 时清除 `FileCache` + 注册的回调 |
