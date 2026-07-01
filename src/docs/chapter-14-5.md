# Java源码解析：Git 工作树隔离

派大星 6月12日修改

> 理论篇讲了 Worktree 如何给每个子 Agent 一份独立的文件空间，这篇来走读 Java 版 MewCode 的实现。单文件方案，242 行的 WorktreeManager.java 包含了全部逻辑。Java 的写法偏传统 OOP，Record 类型和 Optional 的使用让代码既简洁又类型安全。

## 模块概览

Worktree 的代码集中在一个文件里：

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `WorktreeManager.java` | 242 | 全部。`WorktreeInfo` 定义、`Create`/`Remove`/`List`/`Cleanup` 生命周期、变更检测 |

单文件是因为 Java 版把 Worktree 做成了一个纯管理层，不涉及 Session 持久化和复杂的创建后初始化。它的定位是「提供 git worktree 的安全封装 + 过期清理」，Session 管理和环境同步留给上层处理。

## 核心类型

### WorktreeInfo

Java 16 引入的 Record 类型在这里用得恰到好处：

```java
public record WorktreeInfo(
    String path,
    String branch,
    Instant createdAt
) {}
```

三个字段，不可变，自动生成 equals/hashCode/toString。 path 是磁盘路径， branch 是分支名， createdAt 用于过期判断。三个字段覆盖了 worktree 管理的核心需求：知道它在哪里、对应什么分支、什么时候创建的。

### WorktreeManager

```java
public class WorktreeManager {
    private final String projectRoot;
    private final List<String> symlinkDirs;
    private final int staleCutoffHours;
    private final Map<String, WorktreeInfo> worktrees = new LinkedHashMap<>();

    public WorktreeManager(String projectRoot,
            List<String> symlinkDirs, int staleCutoffHours) {
        this.projectRoot = projectRoot;
        this.symlinkDirs = symlinkDirs != null ? symlinkDirs : List.of();
        this.staleCutoffHours = staleCutoffHours > 0 ? staleCutoffHours : 24;
    }
}
```

构造函数接收三个参数。 symlinkDirs 为 null 时降级为空列表， staleCutoffHours 小于等于 0 时默认 24 小时。 worktrees 用 LinkedHashMap 而不是 HashMap ，保持插入顺序，这样 list() 返回的结果和创建顺序一致。

并发保护用的是 synchronized 关键字。每个公共方法都加了 synchronized ，简单直接。在 worktree 操作频率很低的场景下（一般只在 Agent 启动和结束时各调一次），这种粗粒度锁完全够用。

## 主流程走读

### Create：两步走

```java
public synchronized WorktreeInfo create(
    String branch,
    Path targetDir
) throws Exception {
    Path wtDir = targetDir != null
        ? targetDir
        : Path.of(projectRoot, ".mewcode", "worktrees", branch);

    // -B (uppercase) resets any orphan branch left behind by a removed worktree
    String output = runGit(projectRoot,
        "git", "worktree", "add",
        "-B", branch, wtDir.toString());
```

create 的实现很直接：没有 slug 校验（交给上层调用方），直接执行 git worktree add -B 。注意这里用的是大写 -B ，不是小写 -b 。大写 B 在分支已存在时会强制重置，省掉了先 git branch -D 再创建的额外步骤。这在 worktree 被手动删除但分支残留的场景下很重要。

targetDir 参数允许调用方自定义 worktree 路径，为 null 时使用默认路径。这个设计给了上层灵活性，比如测试时可以指定临时目录。

创建完 worktree 后，调用 PostCreationSetup.perform 做环境初始化（复制本地设置、配置 git hooks 路径、符号链接大目录等），然后做符号链接：

```java
for (String dir : symlinkDirs) {
    Path src = Path.of(projectRoot, dir);
    Path dst = wtDir.resolve(dir);
    if (Files.exists(src) && !Files.exists(dst)) {
        Files.createSymbolicLink(dst, src);
    }
}
```

源目录存在且目标不存在才创建符号链接。只做符号链接这一步，其余的环境同步（如配置复制、忽略文件等）由上层负责。这种精简设计让 WorktreeManager 保持为纯粹的「git worktree 封装层」。

最后把 WorktreeInfo 放进内存 map：

```java
var info = new WorktreeInfo(wtDir.toString(), branch, Instant.now());
worktrees.put(branch, info);
return info;
```

### Remove：查找后强制删除

```java
public synchronized void remove(String branch) throws Exception {
    WorktreeInfo info = worktrees.get(branch);
    if (info == null) {
        throw new IllegalArgumentException(
            "worktree not found: " + branch);
    }

    runGit(projectRoot,
        "git", "worktree", "remove", info.path(), "--force");
    worktrees.remove(branch);
}
```

先在 map 里找到对应的 worktree，找不到就抛 IllegalArgumentException 。找到了执行 git worktree remove --force 强制删除，然后从 map 中移除。用 --force 的理由是：子 Agent 可能留下了未提交的修改，不加 force 会被 git 拒绝。remove 就是强制删除，不做变更保护。调用方如果需要检查变更，应该在调用 remove 之前用 detectChanges 方法检查。

### List：双重数据源

```java
public synchronized List<WorktreeInfo> list() {
    try {
        String output = runGit(projectRoot,
            "git", "worktree", "list", "--porcelain");
        List<WorktreeInfo> result = parsePorcelain(output);
        if (!result.isEmpty()) {
            return result;
        }
    } catch (Exception ignored) {
        // fall through to in-memory map
    }
    return new ArrayList<>(worktrees.values());
}
```

list 方法先尝试从 git 命令获取真实的 worktree 列表，失败了再退化到内存 map。这个设计比只看内存 map 更可靠，因为外部可能通过 git 命令手动创建或删除了 worktree。

parsePorcelain 解析 git worktree list --porcelain 的输出格式：

```java
private static List<WorktreeInfo> parsePorcelain(String output) {
    String currentPath = null, currentBranch = null;
    for (String line : output.split("
")) {
        if (line.startsWith("worktree ")) {
            currentPath = line.substring("worktree ".length()).strip();
        } else if (line.startsWith("branch ")) {
            String ref = line.substring("branch ".length()).strip();
            currentBranch = ref.startsWith("refs/heads/")
                ? ref.substring("refs/heads/".length()) : ref;
        } else if (line.isBlank()) {
            if (currentPath != null && currentBranch != null)
                result.add(new WorktreeInfo(currentPath, currentBranch, Instant.now()));
            currentPath = null; currentBranch = null;
        }
    }
```

Porcelain 格式里每个 worktree 的信息块以空行分隔。代码逐行解析，遇到 worktree 行记路径，遇到 branch 行记分支（去掉 refs/heads/ 前缀），遇到空行就收集一个 worktree。最后还处理了「末尾没有空行」的边界情况，再检查一次 currentPath 和 currentBranch 。

### 变更检测

```java
public static String detectChanges(String worktreePath) throws Exception {
    ProcessBuilder pb = new ProcessBuilder("git", "diff", "--stat");
    pb.directory(Path.of(worktreePath).toFile());
    pb.redirectErrorStream(true);
    Process process = pb.start();
    String output;
    try (InputStream in = process.getInputStream()) {
        output = new String(in.readAllBytes());
    }
    boolean finished = process.waitFor(30, TimeUnit.SECONDS);
    if (!finished) {
        process.destroyForcibly();
        throw new IOException("git diff timed out");
    }
    return output.strip();
}
```

变更检测用 git diff --stat 返回变更摘要字符串。调用方通过检查返回值是否为空来判断有没有变更。返回值是 git diff --stat 的原始输出，包含了具体哪些文件改了，信息丰富。

这个方法是 static 的，不依赖 Manager 实例状态，可以独立使用。30 秒超时保护，超时后用 destroyForcibly 强制杀进程。 redirectErrorStream(true) 把 stderr 合并到 stdout，这样一次 readAllBytes 就能拿到所有输出。

## 自动清理

### cleanupStale：按时间阈值清理

```java
public synchronized int cleanupStale(int cutoffHours) {
    int hours = cutoffHours > 0 ? cutoffHours : staleCutoffHours;
    Instant cutoff = Instant.now().minusSeconds((long) hours * 3600);
    int removed = 0;
    var it = worktrees.entrySet().iterator();
    while (it.hasNext()) {
        var info = it.next().getValue();
        if (info.createdAt().isBefore(cutoff)) {
            try {
                runGit(projectRoot, "git", "worktree", "remove", info.path(), "--force");
                it.remove(); removed++;
            } catch (Exception ignored) {}
        }
    }
    return removed;
}
```

计算截止时间，遍历所有 worktree，创建时间早于截止点的就强制删除。用 Iterator.remove() 而不是直接操作 map，避免 ConcurrentModificationException 。

只做了一层过滤（时间过期），逻辑简单直接。在实际使用中，worktree 的生命周期通常很短（一次 Agent 运行），24 小时的默认阈值已经足够安全。如果需要更精细的控制，可以在此基础上扩展检查逻辑（如检查是否有未保存变更）。

try/catch 里的异常被静默吞掉了，注释写的是 best-effort。这是合理的，一个 worktree 清理失败不应该中断其余的清理流程。

### removeAll：全量清理

```java
public synchronized void removeAll() {
    var it = worktrees.entrySet().iterator();
    while (it.hasNext()) {
        var entry = it.next();
        try {
            runGit(projectRoot,
                "git", "worktree", "remove",
                entry.getValue().path(), "--force");
        } catch (Exception ignored) {}
        it.remove();
    }
}
```

应用退出时调用，逐个强制删除所有 worktree。注意即使 git 命令失败，也会从 map 里移除记录，因为 it.remove() 放在 catch 块外面。这保证了即使磁盘上的 worktree 没删干净，内存状态也是干净的。

## Git 命令执行

```java
private static String runGit(String workDir, String... cmd) throws Exception {
    var pb = new ProcessBuilder(cmd);
    pb.directory(Path.of(workDir).toFile());
    pb.redirectErrorStream(true);
    Process p = pb.start();
    String output;
    try (var in = p.getInputStream()) { output = new String(in.readAllBytes()); }
    if (!p.waitFor(60, TimeUnit.SECONDS)) {
        p.destroyForcibly();
        throw new IOException("git command timed out");
    }
    if (p.exitValue() != 0)
        throw new IOException(String.join(" ", cmd) + ": " + output);
    return output;
}
```

用 ProcessBuilder 执行 git 命令。超时处理上，需要手动 waitFor(60, SECONDS) 检查是否超时，超时后 destroyForcibly 杀进程。60 秒的超时对大多数 git 操作来说已经足够。

值得注意的是，当前实现没有设置 stdin=DEVNULL 或 GIT\_TERMINAL\_PROMPT=0 等环境变量来防止 git 等待用户输入。在遇到需要认证的远程仓库时可能会卡住。如果需要在生产环境使用，建议补上这些防护。

## 小结

| 设计决策 | Java 的实现方式 |
| --- | --- |
| 安全校验 | 没有内置，由上层调用方负责 |
| 文件隔离 | `git worktree add -b` 创建独立工作目录 |
| 依赖共享 | 构造时传入 `symlinkDirs`，创建后自动链接 |
| 并发保护 | `synchronized` 方法级锁 |
| 过期清理 | `cleanupStale` 按创建时间判断，`best-effort` 异常处理 |
| 全量清理 | `removeAll` 在应用退出时逐个强制删除 |
| 数据源冗余 | `list()` 优先读 `git porcelain` 输出，退化到内存 `map` |
| 变更检测 | `detectChanges` 静态方法，返回 `git diff --stat` 原始输出 |
| 强制删除 | 统一使用 `--force`，不做变更保护 |
| 超时保护 | `process.waitFor(60, SECONDS)` + `destroyForcibly` |
