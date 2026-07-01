# Java源码解析：会话持久化与记忆提取

派大星 6月12日 13:20

> 理论篇讲了记忆系统的三层架构，这篇走读 Java 版 MewCode 的实现。Java 版的记忆系统在设计上做了不少简化，但核心的三层记忆（指令、会话、自动记忆）都有完整的实现。

## 模块概览

Java 版的记忆系统分散在三个包里：

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `memory/MemoryManager.java` | 约 230 | 自动记忆提取 + 自定义指令加载，一个类包两层 |
| `session/SessionManager.java` | 179 | 会话持久化：JSONL 存储、加载、列表 |
| `history/HistoryStore.java` | 152 | 输入历史：用户输入的循环缓冲区 |

总共不到 500 行，结构紧凑。每个文件各管一层记忆，职责清晰。

## 核心类型

### MemoryEntry：一条自动记忆

```java
@JsonInclude(JsonInclude.Include.NON_NULL)
public record MemoryEntry(
    String content,
    String timestamp,
    String type
) {
    // 兼容旧 JSON（无 type 字段）：缺省 type=null
    public MemoryEntry(String content, String timestamp) {
        this(content, timestamp, null);
    }
}
```

Java 16 的 `record` 类型天然不可变，自带 `equals()` / `hashCode()` / `toString()` 。每条记忆带三个字段：文本内容、ISO 时间戳，以及决定它写到哪个目录的 `type` （取值 `user` / `feedback` / `project` / `reference` ，缺失时为 `null` 兼容旧数据）。 `@JsonInclude(NON_NULL)` 加上 2 元便捷构造子，让 Jackson 既能反序列化没有 `type` 字段的旧 `auto_memory.json` ，也能干净地写新数据。不可变性保证了记忆一旦创建就不会被意外修改。

### SessionMessage：会话中的一条消息

```java
public record SessionMessage(
    String role,
    String content,
    long timestamp
) {}
```

Java 版的 SessionMessage 比较简洁，只有 role、content、timestamp 三个字段。没有 `RecordType` 枚举，没有 `tool_use_id` ，没有 `is_error` 。每条消息当作纯文本处理，不区分工具调用和工具结果。这意味着恢复会话时不需要做消息链校验，但也丧失了精确还原工具调用细节的能力。如果以后要支持恢复带工具调用的对话，需要扩展 SessionMessage 的字段。

### SessionInfo：会话列表的展示数据

```java
public record SessionInfo(
    String id,
    String firstMessage,
    int messageCount,
    long fileSize,
    String gitBranch,
    Instant modTime
) {}
```

`fileSize` 和 `gitBranch` 两个字段值得注意。 `gitBranch` 是一个很实用的设计：列出会话时，同时显示当前的 Git 分支名，帮助用户区分在不同分支上创建的会话。比如你在 `feature/login` 和 `feature/payment` 两个分支上各有一个会话，分支名能帮你快速找到想恢复的那个。

## 第一层记忆：自定义指令

Java 版把自定义指令的加载放在了 `MemoryManager` 里，作为一个静态方法：

```java
public static String loadInstructions(String workDir) {
    List<Path> candidates = List.of(
        Path.of(workDir, "MEWCODE.md"),
        Path.of(workDir, ".mewcode", "INSTRUCTIONS.md")
    );
    for (Path p : candidates) {
        try {
            return Files.readString(p);
        } catch (IOException ignored) {
            // try next
        }
    }
    return "";
}
```

设计上有几个特点值得注意。

第一，只有两个候选路径（ `MEWCODE.md` 和 `.mewcode/INSTRUCTIONS.md` ），没有用户主目录级别的全局指令。Java 版认为指令是项目级的。

第二，找到第一个就返回，不会把多个文件拼起来。这意味着 `MEWCODE.md` 的优先级高于 `.mewcode/INSTRUCTIONS.md` 。

第三，没有 `@include` 处理。如果指令内容很多，需要写在一个文件里。

这些简化让代码非常精简，也覆盖了最常见的使用场景。

## 第二层记忆：会话持久化

### 会话 ID 生成

```java
public static String newId() {
    return LocalDateTime.now().format(
        DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss")
    );
}
```

只用了时间戳，没有随机后缀。这意味着如果在同一秒内创建两个会话，ID 会冲突。实际使用中这种情况几乎不会发生（用户不可能在一秒内创建两个会话），但在自动化测试里可能需要注意。

### 消息持久化

```java
public static void saveMessage(String workDir, String sessionId,
                               String role, String content) {
    Path file = sessionsDir(workDir).resolve(sessionId + ".jsonl");
    Map<String, Object> line = new LinkedHashMap<>();
    line.put("role", role);
    line.put("content", content);
    line.put("ts", Instant.now().getEpochSecond());
    String json = MAPPER.writeValueAsString(line) + "\n";
    Files.writeString(file, json,
        StandardOpenOption.CREATE, StandardOpenOption.APPEND);
}
```

用 JSONL 格式追加写入。每次写入都是打开文件、追加、关闭，不持有文件句柄。这种方式更安全（不会有文件句柄泄漏），即使程序意外退出，已经写入的消息也不会丢失。性能上每次都要走一次文件系统调用，但对话消息的写入频率很低，这个开销完全可以接受。

用了 `LinkedHashMap` 而不是普通 `HashMap` ，保证 JSON 字段的输出顺序是 `role → content → ts` 。这纯粹是为了可读性，让手动查看 JSONL 文件时更舒服。

`ts` 字段用的是 Unix 时间戳（秒），比 ISO 8601 格式更紧凑，但不如 ISO 格式直观。对于机器解析来说 Unix 时间戳更方便，排序和比较都是直接的数值运算。

### 会话加载

```java
public static List<SessionMessage> loadSession(String workDir, String sessionId) {
    Path file = sessionsDir(workDir).resolve(sessionId + ".jsonl");
    if (!Files.exists(file)) return List.of();
    List<SessionMessage> messages = new ArrayList<>();
    try (var reader = Files.newBufferedReader(file)) {
        String line;
        while ((line = reader.readLine()) != null) {
            if (line.isBlank()) continue;
            var map = MAPPER.readValue(line, Map.class);
            // 提取 role, content, ts 构造 SessionMessage
            messages.add(new SessionMessage(role, content, ts));
        }
    } catch (IOException ignored) {}
    return messages;
}
```

逐行读取，每行反序列化成一个 `Map` ，再提取字段构造 `SessionMessage` 。注意两层 try-catch：外层捕获文件读取异常，内层捕获单行解析异常。单行解析失败只跳过这行，不影响后续行的读取。

没有做消息链校验，只要能解析就全部加载。这在大多数情况下没问题，因为 SessionMessage 不区分工具调用和普通消息。如果以后扩展 SessionMessage 支持工具调用细节，加载时需要补上校验逻辑，确保每个工具调用都有对应的结果。

### 会话列表

```java
public static List<SessionInfo> listSessions(String workDir) {
    String branch = currentGitBranch(workDir);
    List<SessionInfo> sessions = new ArrayList<>();
    try (var paths = Files.list(sessionsDir(workDir))) {
        paths.filter(p -> p.toString().endsWith(".jsonl")).forEach(p -> {
            var msgs = loadSession(workDir, id);
            String first = msgs.stream()
                .filter(m -> "user".equals(m.role()))
                .map(SessionMessage::content).findFirst().orElse("");
            sessions.add(new SessionInfo(id, first, msgs.size(), ...));
        });
    }
    sessions.sort(Comparator.comparing(SessionInfo::modTime).reversed());
}
```

这里有一个性能问题：为了获取 `firstMessage` 和 `messageCount` ，它对每个会话都调用了 `loadSession()` ，也就是完整读取并解析整个 JSONL 文件。当会话数量多且每个会话很长时，这里会明显变慢。优化方向是引入元数据缓存文件，只存储首条消息和消息数，避免每次都全量读取。

### Git 分支检测

```java
public static String currentGitBranch(String workDir) {
    Process proc = new ProcessBuilder(
        "git", "-C", workDir,
        "rev-parse", "--abbrev-ref", "HEAD"
    ).redirectErrorStream(true).start();
    String output = new String(
        proc.getInputStream().readAllBytes()).trim();
    return proc.waitFor() == 0 ? output : "";
}
```

直接调用 `git` 命令获取当前分支名。用 `ProcessBuilder` 而不是 JGit 这样的纯 Java 库，保持了零外部依赖的原则。 `redirectErrorStream(true)` 把 stderr 合并到 stdout，这样如果目录不是 `git` 仓库，错误信息会被读取而不会阻塞进程。

### 格式化工具

```java
public static String formatRelativeTime(Instant t) {
    long seconds = Duration.between(t, Instant.now()).getSeconds();
    if (seconds < 60) return "just now";
    long minutes = seconds / 60;
    if (minutes < 60) return minutes + " minutes ago";
    long hours = minutes / 60;
    if (hours < 24) return hours + " hours ago";
    long days = hours / 24;
    // ... weeks 同理
}
```

手写的相对时间格式化。没有用第三方库（如 PrettyTime），而是一系列 if-else 阶梯。这种写法的好处是零依赖、行为完全可预测。

## 第三层记忆：自动记忆提取

### 提取时机

```java
private static final int EXTRACTION_INTERVAL = 5;
private int turnCount;

public boolean shouldExtract() {
    turnCount++;
    return turnCount % EXTRACTION_INTERVAL == 0;
}
```

每 5 轮对话提取一次。用计数器取模的方式简单直接。需要注意的是 `turnCount` 是实例变量，如果进程重启会重置为 0。不过对于记忆提取这种「锦上添花」的功能，频率偶尔波动不会有实质影响。

### LLM 驱动的提取

```java
public void extract(LlmClient client, ConversationManager conv) {
    List<Message> messages = conv.getMessages();
    if (messages.size() < 4) return;

    StringBuilder sb = new StringBuilder();
    for (Message msg : messages) {
        sb.append([).append(msg.getRole()).append("]: ")
          .append(msg.getContent()).append(\n);
    }
    ConversationManager extractConv = new ConversationManager();
    extractConv.addUserMessage(
        "Extract key facts from this conversation worth remembering across future conversations. "
        + "Classify each item into one of four types — the type decides which storage scope it lives in:\n"
        + "- `user` (user-level scope): preferences / role / background across projects\n"
        + "- `feedback` (user-level scope): corrections or validated approaches\n"
        + "- `project` (project-level scope): facts specific to this project\n"
        + "- `reference` (project-level scope): external resources tied to this project\n\n"
        + "Format with these exact headers — skip a category if nothing to save:\n\n"
        + "### user\n- item 1\n\n### feedback\n- item 2\n\n### project\n- item 3\n\n### reference\n- item 4\n\n"
        + "Output nothing else. Conversation:\n" + sb
    );
```

提取时会把整个对话历史都塞进 prompt，而不是只取最近的新消息。对话很长时这会消耗更多 token，但好处是 LLM 能看到完整的上下文，分类判断也更准。Prompt 明确按 4 段 `### type` 头部输出（user / feedback / project / reference），并在每个 `type` 后注明它的存储 scope；空类别直接跳过。下游 `parseTypedSections` 会按这个格式切段，按 `type` 路由到对应文件，所以这里的 prompt 是双路存储的"协议契约"——一旦改输出格式，就要同步改解析端。

提取 prompt 是英文的，只要求提取 key facts、decisions 和 context，没有细分类别。这种宽泛的指令让 LLM 自己判断什么值得记住，比严格分类更灵活。

### 流式收集结果

```java
var events = client.stream(extractConv, null);
StringBuilder result = new StringBuilder();
try {
    while (true) {
        StreamEvent event = events.take();
        if (event instanceof StreamEvent.TextDelta td)
            result.append(td.text());
        else if (event instanceof StreamEvent.StreamEnd
                || event instanceof StreamEvent.Error)
            break;
    }
} catch (InterruptedException e) {
    Thread.currentThread().interrupt();
}
```

用 `BlockingQueue` 做流式事件传递。 `events.take()` 会阻塞直到有新事件，这是 Java 并发编程的标准模式。注意 `InterruptedException` 的处理：捕获后重新设置中断标志（ `Thread.currentThread().interrupt()` ），这是 Java 并发的最佳实践，确保上层代码能感知到中断。

### 持久化

```java
Map<String, String> bySection = parseTypedSections(result.toString());
if (bySection.isEmpty()) return;

String now = DateTimeFormatter.ISO_INSTANT.format(Instant.now());
boolean changed = false;
for (var section : bySection.entrySet()) {
    String type = section.getKey();
    String content = section.getValue().trim();
    if (content.isEmpty()) continue;
    // 未知 type silently drop，避免 LLM 幻觉造类
    if (!USER_TYPES.contains(type) && !PROJECT_TYPES.contains(type)) continue;
    entries.add(new MemoryEntry(content, now, type));
    changed = true;
}
if (changed) save();
```

解析结果按 `type` 拆开后，每个有效段落都被 append 成独立的 `MemoryEntry` 。 `USER_TYPES = Set.of("user", "feedback")` 与 `PROJECT_TYPES = Set.of("project", "reference")` 这两个常量是路由的 single source of truth：保存时（ `save()` ）按它们分文件，召回时（ `getMemories()` ）按 `type` 排序。LLM 偶尔会幻觉出 `### misc` 这种未知 `type`，直接 drop 比 silently 归到某一边安全。

```java
private void save() {
    List<MemoryEntry> userScoped = new ArrayList<>();
    List<MemoryEntry> projectScoped = new ArrayList<>();
    for (MemoryEntry e : entries) {
        if (e.type() != null && USER_TYPES.contains(e.type())) {
            userScoped.add(e);
        } else if (e.type() != null && PROJECT_TYPES.contains(e.type())) {
            projectScoped.add(e);
        } else {
            // 旧数据没有 type，默认归到项目级
            projectScoped.add(e);
        }
    }
    writeJson(userFilePath, userScoped);
    writeJson(projectFilePath, projectScoped);
}

private void writeJson(Path path, List<MemoryEntry> filtered) {
    try {
        Files.createDirectories(path.getParent());
        String json = MAPPER.writerWithDefaultPrettyPrinter()
            .writeValueAsString(filtered);
        Files.writeString(path, json);
    } catch (IOException ignored) { /* best-effort */ }
}
```

分流的真正动作发生在两层：(1) `save()` 内联按 `type` 把 `entries` 拆成两个列表，避免任何记忆走错文件；(2) 抽出 `writeJson(path, list)` 助手只负责"创目录 + pretty-print 写一个文件"——把"决定写哪个"和"怎么写"职责分开。父目录 lazy 创建（ `~/.mewcode/memory/` 用户首次使用时不存在很正常）， `IOException` 静默吞掉走 best-effort 路线，单边失败不影响另一边。 `writerWithDefaultPrettyPrinter()` 让两个 `auto_memory.json` 都是格式化的，方便用户用编辑器手动 review / fix-up。

### 注入记忆

```java
public void injectMemories(ConversationManager conv) {
    List<String> memories = getMemories();
    if (memories.isEmpty()) return;
    StringBuilder sb = new StringBuilder("## Auto Memory\n\n");
    for (String mem : memories) sb.append(mem).append("\n\n");
    if (conv.getMessages().isEmpty()) {
        conv.addUserMessage(sb.toString());
        conv.addAssistantMessage("Understood, I'll keep this context in mind.");
    }
}
```

`entries.subList(0, excess).clear()` 是 Java 的一个惯用法： `subList()` 返回的是原列表的视图，对它调用 `clear()` 会直接从原列表中删除对应的元素。

### 全量重写

```java
private void writeToDisk() {
    try (var writer = Files.newBufferedWriter(filePath,
            StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING)) {
        long now = Instant.now().getEpochSecond();
        for (String t : entries) {
            var node = MAPPER.createObjectNode();
            node.put("text", t);
            node.put("ts", now);
            writer.write(MAPPER.writeValueAsString(node));
            writer.newLine();
        }
    } catch (IOException ignored) {}
}
```

注入记忆时，先加一条「用户消息」包含所有记忆内容，再加一条「助手回复」确认收到。这种 user-assistant 配对的注入方式比直接塞 system prompt 更可靠，因为有些模型对 system prompt 的遵从度不如对话上下文。

注意 `if (conv.getMessages().isEmpty())` 这个条件：只在对话开始时注入。这避免了每轮都重复注入，但也意味着如果中间提取了新记忆，要等到下次新对话才能生效。

## 输入历史：HistoryStore

`HistoryStore` 不属于「记忆系统」的三层架构，但它也是一种持久化。它记录用户在 REPL 里输入过的内容，支持上下键翻历史。

每次追加都全量重写文件。因为有循环缓冲区的裁剪逻辑，文件不会无限增长，最多 200 行。全量重写虽然效率低，但保证了文件内容和内存状态的一致性，不会出现会话 JSONL 那种「文件比内存多一些残留记录」的问题。

## 小结

| 设计决策 | Java 的实现方式 |
| --- | --- |
| 自定义指令 | 两个候选路径，找到即返回 |
| 会话格式 | JSONL 追加，每次写入都开关文件 |
| 消息结构 | 纯 role+content+ts，精简但够用 |
| 会话列表 | 每次全量读取 JSONL，含 Git 分支名 |
| 自动记忆存储 | 双文件 JSON，按 `type` 分级（user/feedback 跟人走，project/reference 跟项目走） |
| 提取策略 | 每 5 轮全量提取，LLM 驱动 |
| 输入历史 | 循环缓冲区 200 条，连续去重 |
| 并发模型 | `BlockingQueue.take()` 阻塞等待 |
