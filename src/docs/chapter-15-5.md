# Java源码解析：多 Agent 团队协作

派大星 6月12日修改

> 🔗 原文链接： [⁣⁢⁣⁣⁡Java源码解析：多 Agent 团队协作](https://q00ax5us1um.feishu.cn/wiki/L2BKwKQktiRdqnk5hRYcE2Xbn5d)

> ⏰ 剪存时间：2026-06-11 23:39:06

> ✂️ 本文档由 [游侠飞书剪存](https://pwwjpto7tva.feishu.cn/wiki/space/7517832277555544092) 一键生成

> 💖 更多好物请访问 [游侠创客](https://uibot.cn/) 微信：xuefuta

> 15-5

> 理论篇讲了 Agent Teams 如何把一次性的子任务升级为长期协作团队，这篇来走读 Java 版 MewCode 的真实代码。4 个文件，约 500 行，实现了完整的团队管理、消息通信和工具暴露。后端支持 In-process 和 Tmux 两种模式，协调者模式通过工具白名单实现。

## 模块概览

Agent Teams 的代码集中在 com.mewcode.teams 包下：

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `TeamManager.java` | 149 | 核心。`TeamManager` / `Team` / `Member` 三层结构，成员生命周期 |
| `FileMailBox.java` | 133 | 基于文件的收件箱，`JSON` 存储 + 文件锁 + 乐观重试 |
| `Coordinator.java` | 37 | 协调模式的工具白名单 |
| `TeamTools.java` | 183 | `SendMessage` / `TeamCreate` / `TeamDelete` 三个工具的完整实现 |

四个文件的职责划分很清晰。 TeamManager.java 管数据和生命周期， FileMailBox.java 管通信， Coordinator.java 定义协调规则， TeamTools.java 把功能暴露给 LLM 使用。

## 核心类型

### TeamManager 和嵌套类

Java 版把三个核心类型放在一个文件里，用嵌套类组织：

```java
public class TeamManager {
    public enum TeamMode { IN_PROCESS, TMUX }

    private final Map<String, Team> teams = new LinkedHashMap<>();

    public static class Team { ... }
    public static class Member { ... }
}
```

TeamMode 枚举只有 IN\_PROCESS 和 TMUX 两个值。 LinkedHashMap 保持插入顺序，团队列表的展示顺序和创建顺序一致。

### Member

```java
public static class Member {
    final String name;
    final Agent agent;
    final ConversationManager conv;
    volatile boolean active;
    volatile Thread thread;

    Member(String name, Agent agent, ConversationManager conv) {
        this.name = name;
        this.agent = agent;
        this.conv = conv;
    }
}
```

每个 Member 持有自己的 Agent 实例和 ConversationManager。 active 和 thread 用 volatile 修饰，保证多线程之间的可见性。成员在虚拟线程里执行， volatile 确保主线程能及时看到工作线程的状态变化。

Member 只保留运行时必需的字段：名字、Agent 实例、对话管理器、活跃状态、执行线程。这种精简设计让每个成员的创建和管理都很轻量。

### Team

```java
public static class Team {
    private final String name;
    private final TeamMode mode;
    private final Map<String, Member> members = new LinkedHashMap<>();
    private final FileMailBox mailBox;

    public Team(String name, TeamMode mode) {
        this.name = name;
        this.mode = mode;
        this.mailBox = new FileMailBox(
            teamsBaseDir().resolve(name).resolve("inboxes"));
    }
}
```

每个 Team 自带一个 FileMailBox。邮箱目录在 .mewcode/teams/{teamName}/inboxes/ 下。Team 不做磁盘持久化（没有 save/load ），所有状态都在内存里。这意味着程序重启后团队信息会丢失。这是一个有意的简化，因为团队的生命周期通常和程序会话绑定。

添加成员的方法直接创建 Agent：

```java
public synchronized Member addMember(
    String name,
    LlmClient client,
    ToolRegistry registry,
    String protocol
) {
    Agent ag = new Agent(client, registry, protocol);
    Member member = new Member(name, ag, new ConversationManager());
    members.put(name, member);
    return member;
}
```

每个成员都有自己独立的 Agent、LlmClient、ToolRegistry 和 ConversationManager。这是完全隔离的设计，成员之间不共享任何运行时状态，只通过 FileMailBox 通信。

启动成员的方法把任务添加到对话然后执行 Agent：

```java
public synchronized BlockingQueue<AgentEvent> startMember(
    String name, String task
) {
    Member member = members.get(name);
    if (member == null) return null;
    member.conv.addUserMessage(task);
    BlockingQueue<AgentEvent> queue = member.agent.run(member.conv);
    member.active = true;
    return queue;
}
```

返回一个 BlockingQueue<AgentEvent> ，调用方可以从中消费 Agent 的事件流。直接返回事件队列，调用方可以按需消费事件，实现进度监控、日志记录等功能。

### 停止成员

```java
public synchronized void stopMember(String name) {
    Member member = members.get(name);
    if (member != null) {
        member.active = false;
        if (member.thread != null) member.thread.interrupt();
    }
}

public synchronized void stopAll() {
    for (Member m : members.values()) {
        m.active = false;
        if (m.thread != null) m.thread.interrupt();
    }
}
```

停止成员就是把 active 置 false 然后 interrupt 线程。 Thread.interrupt() 会让阻塞在 I/O 或 sleep 上的线程抛出 InterruptedException ，Agent 的主循环可以捕获后退出。统一用 interrupt 的好处是代码简单，不需要区分后端类型做不同的停止处理。

### 发送消息

```java
public void sendMessage(String from, String to, String content) {
    mailBox.send(to, new FileMailBox.MailMessage(from, content));
}
```

Team 级别的 sendMessage 是对 FileMailBox 的直接包装。注意这个方法没有 synchronized ，因为 FileMailBox 自己有文件锁保护并发。

## 后端检测

```java
public static TeamMode detectBackend() {
    if (System.getenv("TMUX") != null
            && !System.getenv("TMUX").isEmpty()) {
        return TeamMode.TMUX;
    }
    try {
        Process p = new ProcessBuilder("which", "tmux").start();
        if (p.waitFor() == 0) return TeamMode.TMUX;
    } catch (Exception ignored) {}
    return TeamMode.IN_PROCESS;
}
```

Java 版的后端检测只看 tmux。先检查 TMUX 环境变量（是否在 tmux 会话里），再检查 tmux 是否安装（ which tmux ），都不满足就用 in-process。

设计上选择了宽容策略：tmux 不可用时静默退化为 in-process，不会因为缺少 tmux 就阻止团队功能的使用。in-process 模式下所有成员在同一个 JVM 进程内的虚拟线程里运行。

## FileMailBox：文件锁通信

### 数据结构

```java
public record MailMessage(
    String from,
    String text,
    String timestamp,
    boolean read,
    String color,
    String summary
) {
    public MailMessage(String from, String text) {
        this(from, text,
            DateTimeFormatter.ISO_INSTANT.format(Instant.now()),
            false, "", "");
    }
}
```

用 Record 类型定义消息结构。双参数的构造器是便捷方法，自动填充时间戳和默认值。 color 字段是 UI 层用的，不同的队友可以有不同颜色。

### 文件锁机制

所有消息存在同一个 JSON 文件里，需要文件锁保护并发访问：

```java
private void withLock(String agentId, MutationFn fn) {
    Path lock = lockPath(agentId);
    boolean acquired = false;
    for (int attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            Files.createFile(lock);   // 原子创建 = 拿到锁
            acquired = true;
            break;
        } catch (FileAlreadyExistsException e) {
            var modTime = Files.getLastModifiedTime(lock).toInstant();
            if (Instant.now().minusSeconds(10).isAfter(modTime))
                Files.deleteIfExists(lock);  // 过期锁，强制释放
            Thread.sleep(MIN_SLEEP_MS + ThreadLocalRandom.current()
                .nextInt(MAX_SLEEP_MS - MIN_SLEEP_MS));  // 随机退避
        }
    }
```

锁的实现用的是「创建文件」原语。 Files.createFile() 在文件已存在时抛 FileAlreadyExistsException ，这是原子操作，可以作为互斥锁使用。

重试策略有两个细节。第一，等待时间是随机的（5 到 100 毫秒），用 ThreadLocalRandom 生成。随机化避免了多个进程同步重试导致的活锁。第二，超过 10 秒的锁文件被视为过期（持有锁的进程可能已经崩溃），强制删除后重试。

锁的使用模式是经典的 try-finally：

```java
    if (!acquired) return;

    try {
        List<MailMessage> messages = readInbox(agentId);
        messages = fn.apply(messages);
        writeInbox(agentId, messages);
    } finally {
        try { Files.deleteIfExists(lock); } catch (IOException ignored) {}
    }
```

先读取当前邮箱内容，应用变更函数，写回。finally 块里释放锁。即使变更函数抛异常，锁也会被释放。

### 读写操作

```java
public void send(String recipient, MailMessage msg) {
    withLock(recipient, messages -> {
        messages.add(new MailMessage(msg.from(), msg.text(),
            msg.timestamp(), false, msg.color(), msg.summary()));
        return messages;
    });
}
public List<MailMessage> readUnread(String agentId) {
    return readInbox(agentId).stream().filter(m -> !m.read()).toList();
}
public void markAllRead(String agentId) {
    withLock(agentId, msgs -> msgs.stream().map(m -> new MailMessage(
        m.from(), m.text(), m.timestamp(), true, m.color(), m.summary()
    )).toList());
}
```

send 在锁保护下追加消息。 readUnread 不加锁，只读操作。 markAllRead 在锁保护下把所有消息标为已读。因为 MailMessage 是 Record（不可变），标记已读需要创建新的 Record 实例。

readUnread + markAllRead 是「读完标记」语义。消息不会被删除，只是 read 字段变为 true。这意味着邮箱文件会越来越大，但好处是消息历史可以追溯。如果团队运行时间很长，可以定期清理已读消息。

## 工具暴露

TeamTools.java 实现了三个工具：SendMessage、TeamCreate、TeamDelete。每个工具都是一个实现了 Tool 接口的内部类。

### SendMessage

```java
@Override public ToolResult execute(Map<String, Object> args) {
    String to = (String) args.get("to");
    String content = (String) args.get("content");
    if (to == null || content == null)
        return ToolResult.error("'to' and 'content' are required");
    for (var teamName : teamMgr.listTeams()) {
        var team = teamMgr.getTeam(teamName);
        if (team != null && team.hasMember(to)) {
            team.sendMessage(senderName, to, content);
            return ToolResult.success("Message sent to " + to);
        }
    }
    return ToolResult.error("recipient not found: " + to);
}
```

SendMessageTool 持有 teamMgr 和 senderName 两个字段， senderName 在构造时绑定，这样每个 Agent 的 SendMessage 工具都知道自己是谁，不需要在调用时传发件人。 execute 方法遍历所有团队查找收件人，是全局搜索，不需要指定团队名。直接用成员名查找，简单直接。

### TeamCreate

```java
public static class TeamCreateTool implements Tool {
    @Override
    public ToolResult execute(Map<String, Object> args) {
        String name = (String) args.get("team_name");
        if (name == null || name.isEmpty()) {
            return ToolResult.error("Error: team_name is required");
        }

        String baseName = name;
        for (int i = 2; teamMgr.getTeam(name) != null; i++) {
            name = baseName + "-" + i;
        }

        TeamManager.TeamMode mode = TeamManager.detectBackend();
        TeamManager.Team team = teamMgr.createTeam(name, mode);
```

命名冲突处理：原名不可用就加数字后缀（如 team-2 、 team-3 ）。检查的是内存 map 里有没有同名团队，简单快速。

每个工具都实现了完整的 schema() 方法，返回 JSON Schema 格式的参数定义：

```java
@Override
public Map<String, Object> schema() {
    var props = new LinkedHashMap<String, Object>();
    props.put("team_name", Map.of("type", "string",
        "description", "Name for the team"));
    props.put("description", Map.of("type", "string",
        "description", "What this team will work on"));
    return Map.of(
        "name", name(), "description", description(),
        "input_schema", Map.of("type", "object",
            "properties", props,
            "required", List.of("team_name")));
}
```

用 LinkedHashMap 保持属性顺序（ team\_name 在 description 前面），这样 LLM 看到的参数顺序和预期一致。

### TeamDelete

```java
public static class TeamDeleteTool implements Tool {
    @Override
    public ToolResult execute(Map<String, Object> args) {
        String name = (String) args.get("team_name");
        TeamManager.Team team = teamMgr.getTeam(name);
        if (team == null)
            return ToolResult.error("Error: team '%s' not found".formatted(name));
        List<String> memberNames = team.memberNames();
        teamMgr.deleteTeam(name);
        return ToolResult.success("Team "%s" deleted. Stopped %d member(s): %s"
            .formatted(name, memberNames.size(), String.join(", ", memberNames)));
    }
}
```

删除前先记下成员名字列表，因为 deleteTeam 会清空成员。返回的结果里包含被停止的成员数量和名字，给 LLM 提供反馈。

deleteTeam 直接 stopAll 后删除，不检查是否有活跃成员。这种设计更简单直接：删除就是「停掉所有人然后清理」，不需要用户先手动停止每个成员。

## 协调者模式

```java
public final class Coordinator {
    private Coordinator() {}

    public static final Set<String> ALLOWED_TOOLS = Set.of(
        "Agent", "SendMessage",
        "TaskCreate", "TaskGet", "TaskList", "TaskUpdate",
        "TeamCreate", "TeamDelete",
        "ReadFile", "Glob", "Grep", "Bash"
    );

    public static boolean isCoordinatorTool(String name) {
        return ALLOWED_TOOLS.contains(name);
    }
}
```

协调者的工具白名单用 Set.of 创建不可变集合。包含两类工具：协调工具（Agent、SendMessage、Team 管理、Task 管理）和只读工具（ReadFile、Glob、Grep、Bash）。写操作工具（EditFile、WriteFile）不在里面，Lead 只能通过 Agent/SendMessage 间接让队友去做修改。

只保留了白名单本身，系统提示词由上层管理。这让协调者模块极其精简，37 行搞定。职责单一：只回答「这个工具是否允许协调者使用」这一个问题。

isCoordinatorTool 是一个纯查找方法，O(1) 时间复杂度。上层的工具注册逻辑在构建 Agent 的 ToolRegistry 时调用它，只注册白名单里的工具。

## 小结

| 设计决策 | Java 的实现方式 |
| --- | --- |
| 后端自动选择 | `detectBackend` 检查 `tmux` 环境变量和 `PATH`，退化为 `in-process` |
| 团队结构 | `TeamManager` → `Team` → `Member` 三层嵌套类 |
| 成员执行 | `Agent` + `ConversationManager` 独立实例，`Thread` 并发 |
| 跨进程通信 | `FileMailBox`，单 `JSON` 文件 + 创建文件做互斥锁 + 随机化重试 |
| 锁过期处理 | 超过 10 秒的锁文件视为过期，强制删除 |
| 消息语义 | 读完标记（`markAllRead`），消息不删除，可追溯 |
| 工具暴露 | `SendMessage` / `TeamCreate` / `TeamDelete` 各一个 `Tool` 实现类 |
| 协调模式 | `Coordinator.ALLOWED_TOOLS` 不可变集合做白名单 |
| 成员查找 | `SendMessage` 全局遍历所有团队，不需要名称注册表 |
| 停止成员 | `Thread.interrupt()` 统一中断 |
| 命名冲突 | 创建时加数字后缀（检查内存 `map` 而不是磁盘目录） |
| 状态管理 | 纯内存，不做磁盘持久化，不支持跨 `JVM` 共享 |
