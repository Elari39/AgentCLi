# Java源码解析：上下文压缩与溢写

派大星 6月12日修改

> 理论篇讲了两层上下文管理的设计，这篇带你走读 Java 版 MewCode 的真实代码。一个工具类管两层压缩，一个伴生类管跨轮快照，把「怎么在有限窗口里维持长对话」以及「压缩之后怎么不让模型瞬间失忆」一起解决得很干净。

## 模块概览

上下文管理拆成两个文件，按职责分工：

| 文件 | 职责 |
| --- | --- |
| `ContextCompactor.java` | 两层上下文压缩：Layer 1 落盘裁剪 + Layer 2 LLM 全量摘要，外加熔断、手动入口和压缩后恢复块渲染 |
| `RecoveryState.java` | 跨轮快照仓库：记录每次 ReadFile 的字节快照与每次 Skill 调用的 SOP，给 `ContextCompactor.buildRecoveryAttachment` 当数据源 |

`ContextCompactor` 的方法仍然全是 static，没有实例状态，构造函数私有化，多个 Agent 并发调用也不会冲突。 `RecoveryState` 反过来是有状态的：每个 Agent 持有一个独立实例，记自己跑过的 ReadFile 与 Skill。两个文件互补，一个无状态，一个有状态，分工很清晰。

## 核心常量

```java
private static final double AUTOCOMPACT_THRESHOLD = 0.80;

private static final int SINGLE_RESULT_LIMIT = 15_000;
private static final int MESSAGE_AGGREGATE_LIMIT = 20_000;
private static final int OLD_RESULT_SNIP_CHARS = 2_000;
private static final int KEEP_RECENT_TURNS = 10;
private static final int MAX_CONSECUTIVE_FAILURES = 3;
```

这几个常量划出了整个上下文管理的行为边界。 `AUTOCOMPACT_THRESHOLD` 是 Layer 2 的触发线，上下文用量超过窗口的 80% 才启动 LLM 摘要。 `SINGLE_RESULT_LIMIT` 是单个工具结果的溢写阈值，15000 字符。这个值必须严格大于工具输出截断上限，否则被截断到 10K 的工具输出会反复触发溢写，溢写后读回来又触发溢写，形成反馈循环。 `MESSAGE_AGGREGATE_LIMIT` 是单条消息里所有工具结果加起来的上限。 `OLD_RESULT_SNIP_CHARS` 和 `KEEP_RECENT_TURNS` 配合使用：最近 10 轮对话不动，更老的消息里超过 2000 字符的工具结果直接裁掉。

## 熔断器

```java
public static class AutoCompactTrackingState {
    private int consecutiveFailures;

    public boolean isTripped() {
        return consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
    }

    public void recordFailure() { consecutiveFailures++; }
    public void reset() { consecutiveFailures = 0; }
}
```

如果上下文已经大到 LLM 摘要请求本身也超限，每轮 Loop 都会尝试压缩然后失败，白白烧 API 调用。熔断器在连续失败 3 次后停止自动压缩。成功一次就重置计数。调用方在 Agent 里持有这个对象，跨迭代传递状态。

## 主流程走读

### 入口：manage()

```java
public static String manage(ConversationManager conv, LlmClient client,
                            int contextWindow, String workDir,
                            AutoCompactTrackingState tracking) {
    String l1 = offloadAndSnip(conv, workDir);

    int tokens = estimateTokens(conv.getMessages());
    double ratio = (double) tokens / contextWindow;
    if (ratio > AUTOCOMPACT_THRESHOLD
            && (tracking == null || !tracking.isTripped())) {
        try {
            String l2 = autoCompact(conv, client, contextWindow);
            if (tracking != null) tracking.reset();
            return l2;
        } catch (Exception e) {
            if (tracking != null) tracking.recordFailure();
        }
    }
    return l1;
}
```

两层不是互斥选择，而是顺序执行：Layer 1 无条件先跑，Layer 2 看 ratio 决定。Layer 1 做完之后上下文可能已经缩小了，不一定需要 Layer 2。如果 Layer 2 失败，熔断器记一次；成功就重置。 `tracking` 传 null 时熔断器禁用，方便测试和一次性调用。

### Token 估算

```java
public static int estimateTokens(List<Message> messages) {
    int total = 0;
    for (Message m : messages) {
        total += (int) (safeLength(m.getContent()) / 3.5) + 4;
        // ... tool uses: +50 per block + args length / 3.5
        // ... tool results: content / 3.5 + 10
        // ... thinking blocks: content / 3.5
    }
    return total;
}
```

3.5 个字符约等于 1 个 Token，每条消息 +4，每个工具调用 +50。不调 Tokenizer API，纯本地估算。每轮循环都要算一次，调 API 太贵了。

## Layer 1：offloadAndSnip

Layer 1 是纯本地操作，每轮 Agent Loop 开头无条件运行，不看 ratio。它做三件事：单结果落盘、聚合落盘、裁剪旧结果。

```java
static String offloadAndSnip(ConversationManager conv, String workDir) {
    List<Message> messages = conv.getMessagesMutable();
    if (messages.isEmpty()) return "";

    String spillDir = workDir != null
            ? Path.of(workDir, SPILL_SUBDIR).toString() : null;
    int boundary = Math.max(0, messages.size() - KEEP_RECENT_TURNS * 3);
```

`boundary` 用消息数乘以 3 估算轮次边界（一轮大约 3 条消息：user、assistant with tool\_use、user with tool\_result），只有边界之前的老消息才会被裁剪。

### 单结果落盘

```java
for (int j = 0; j < results.size(); j++) {
    ToolResultBlock tr = results.get(j);
    if (alreadyProcessed(tr.content())
            || safeLength(tr.content()) <= SINGLE_RESULT_LIMIT) {
        continue;
    }
    Path path = writeSpill(spillDir, tr.toolUseId(), tr.content());
    if (path == null) continue;
    results.set(j, new ToolResultBlock(tr.toolUseId(),
            String.format("[Result of %d chars saved to %s]",
                    tr.content().length(), path),
            tr.isError()));
}
```

单个工具结果超过 15000 字符就写磁盘，原位替换成路径指针。 `alreadyProcessed` 检查是否已经被处理过（以 `[Result of` 或 `[Stale output snipped:` 开头），保证幂等。 `writeSpill` 写文件前检查是否已存在，已存在就直接返回路径不重复写入。

### 聚合落盘

```java
int agg = 0;
for (ToolResultBlock tr : results) {
    agg += safeLength(tr.content());
}
if (agg > MESSAGE_AGGREGATE_LIMIT && spillDir != null) {
    // 把这条消息里所有超过 200 字符的结果都落盘
}
```

一条消息里所有工具结果加起来超过 20000 字符时触发。典型场景：一次并发工具调用返回了多个中等大小的结果，单个不超限但加起来很大。

### 裁剪旧结果

```java
if (i < boundary) {
    for (int j = 0; j < results.size(); j++) {
        ToolResultBlock tr = results.get(j);
        if (alreadyProcessed(tr.content())
                || safeLength(tr.content()) <= OLD_RESULT_SNIP_CHARS) {
            continue;
        }
        results.set(j, new ToolResultBlock(tr.toolUseId(),
                String.format("[Stale output snipped: %d chars]",
                        tr.content().length()),
                tr.isError()));
    }
}
```

超过最近 10 轮的旧结果，只要还大于 2000 字符就裁成一行。不丢信息（磁盘上有完整版本），只是从上下文里移除不再需要的细节。

Layer 1 的三个操作都做完后，如果有变化就重建对话，返回操作摘要。

## Layer 2：Auto-compact

上下文用量超过 80% 时触发，调 LLM 把整段对话压缩成摘要：

```java
private static String autoCompact(
        ConversationManager conv, LlmClient client, int contextWindow) {
    int beforeTokens = estimateTokens(conv.getMessages());
    String serialized = serializeForSummary(conv.getMessages(), 500);
    String summaryRaw = requestSummary(client,
            SUMMARY_SYSTEM_PROMPT + "

" + serialized);
    String summaryText = formatCompactSummary(summaryRaw);

    ConversationManager compacted = new ConversationManager();
    compacted.addUserMessage("[Compacted conversation summary]

" + summaryText);
    compacted.addAssistantMessage("Understood. I'll continue based on this context.");
    replaceConversation(conv, compacted);

    int afterTokens = estimateTokens(conv.getMessages());
    return String.format("Compacted: %d -> %d estimated tokens",
            beforeTokens, afterTokens);
}
```

压缩后只剩两条消息：摘要和确认。摘要 prompt 要求 LLM 先做 `<analysis>` 分析，再输出 `<summary>` 结果。 `formatCompactSummary` 提取 `<summary>` 标签里的内容，丢弃分析过程。如果 LLM 没有按格式输出，直接用原始文本兜底。

### 摘要请求

```java
private static String requestSummary(LlmClient client, String prompt) {
    ConversationManager summaryConv = new ConversationManager();
    summaryConv.addUserMessage(prompt);
    BlockingQueue<StreamEvent> events = client.stream(summaryConv, null);
```

创建临时对话发送摘要请求。 `client.stream` 的第二个参数 `null` 表示不给工具 schema，LLM 只能输出文本。用 `BlockingQueue` 消费流式事件， `InterruptedException` 的处理遵循 Java 最佳实践：恢复中断标志再抛出包装异常。

### 对话序列化

```java
private static String serializeForSummary(
        List<Message> messages, int toolResultCap) {
    var sb = new StringBuilder();
    for (Message m : messages) {
        sb.append(String.format("[%s]: %s
", m.getRole(), ...));
        // tool uses: 只保留工具名和 ID，不保留参数
        // tool results: 截断到 500 字符
    }
    return sb.toString();
}
```

纯文本格式，信息密度比完整 JSON 高，Token 消耗少。工具结果截断到 500 字符，因为这段文本本身就是要喂给 LLM 做摘要的，不需要完整细节。

## 辅助函数

### 对话重建

```java
private static void rebuildConversation(
        ConversationManager conv, List<Message> messages) {
    ConversationManager rebuilt = new ConversationManager();
    for (Message m : messages) appendMessage(rebuilt, m);
    replaceConversation(conv, rebuilt);
}
```

`replaceConversation` 通过 `getMessagesMutable().clear() + addAll()` 就地替换，调用方持有的引用保持有效。 `appendMessage` 根据消息类型分派到四种 add 方法：带工具调用的 assistant、工具结果、纯 user、纯 assistant。

## 第三层：压缩后恢复

Layer 2 的摘要把上下文压回去了，但同时也让模型瞬间「失忆」。它刚才还能看到完整代码、工具输出、用户原话，下一秒只剩一段几百字的摘要。如果接下来用户问「刚才那个文件里 handleError 是怎么写的」，模型会基于摘要里的几个名词猜测，错的概率不低。 `RecoveryState.java` + `ContextCompactor.buildRecoveryAttachment` 解决的就是这个问题。

### RecoveryState：跨轮快照仓库

```java
public final class RecoveryState {

    public record FileReadRecord(String path, String content, Instant timestamp) {}
    public record SkillInvocationRecord(String name, String body, Instant timestamp) {}

    private final Object lock = new Object();
    private final Map<String, FileReadRecord> files = new HashMap<>();
    private final Map<String, SkillInvocationRecord> skills = new HashMap<>();

    public void recordFileRead(String path, String content) {
        if (path == null || path.isEmpty()) return;
        synchronized (lock) {
            files.put(path, new FileReadRecord(path, content, Instant.now()));
        }
    }
    ...
}
```

为什么要加锁？因为 `StreamingExecutor.executeAll` 用 `Executors.newVirtualThreadPerTaskExecutor()` 并发跑 ReadFile，多个虚拟线程同时往里写不能丢数据。 `record*` 方法在空 path / 空 name 上直接 return，给测试和一次性脚本留个安全网。

`Agent` 持有一个 final 字段：

```java
private final RecoveryState recoveryState = new RecoveryState();

public RecoveryState getRecoveryState() { return recoveryState; }
public ToolRegistry getRegistry() { return registry; }
public String getProtocol() { return protocol; }
```

三个 getter 一起加是因为 fork 子 Agent 和 TUI 的 `/compact` 命令都需要从外部拿到这些字段。

### 何时记录文件

ReadFile 的回写挂在 `StreamingExecutor.executeSingle` 末尾：

```java
long start = System.nanoTime();
ToolResult result;
try {
    result = tool.execute(call.args());
} catch (Exception e) {
    result = ToolResult.error("Tool execution error: " + e.getMessage());
}
double elapsed = (System.nanoTime() - start) / 1_000_000_000.0;

snapshotForRecovery(call, result);
```

`snapshotForRecovery` 做了一件事：

```java
private void snapshotForRecovery(ToolCallInfo call, ToolResult result) {
    if (recoveryState == null || result.isError()) return;
    if (!"ReadFile".equals(call.toolName())) return;
    Object pathObj = call.args() == null ? null : call.args().get("file_path");
    if (!(pathObj instanceof String) || ((String) pathObj).isEmpty()) return;
    String path = (String) pathObj;
    try {
        String content = Files.readString(Path.of(path));
        recoveryState.recordFileRead(path, content);
    } catch (IOException ignored) {
        // 文件读不到就跳过这次记录，绝不让主流程崩。
    }
}
```

这里有个微妙的设计：不是从 `result.output()` 里拿内容，而是单独再 `Files.readString` 一次。原因是工具输出有行号前缀（ `1 <line>` 这种），拿来恢复反而带噪音。重读一次纯净的字节是更稳的选择，代价不过是一次额外打开文件。 `IOException` 静默吞掉，文件读不到就不记，绝不让 Agent 主流程崩。

`StreamingExecutor` 有两个构造重载，一个 5-arg 兼容旧调用方，一个 6-arg 接受 `recoveryState` ：

```java
public StreamingExecutor(ToolRegistry registry, PermissionChecker checker,
                         HookEngine hookEngine, BlockingQueue<AgentEvent> eventQueue) {
    this(registry, checker, hookEngine, eventQueue, null);
}

public StreamingExecutor(ToolRegistry registry, PermissionChecker checker,
                         HookEngine hookEngine, BlockingQueue<AgentEvent> eventQueue,
                         RecoveryState recoveryState) {
    ...
}
```

Agent 主循环在创建 executor 时透传：

```java
var executor = new StreamingExecutor(registry, checker, hookEngine, queue, recoveryState);
```

### 何时记录技能

技能记录走的是 `SkillHost` 接口的默认方法：

```java
public interface SkillHost {
    void activateSkill(String name, String body);
    void setToolFilter(Predicate<String> filter);
    ToolRegistry toolRegistry();

    default void recordSkillInvocation(String name, String body) {}
}
```

`default` 是关键。这样老的 `SkillHost` 实现不用改，就自动得到一个 no-op 的默认行为。Agent 类未来如果实现 `SkillHost` ，覆盖这个方法把它桥接到 `recoveryState.recordSkillInvocation` 就行。

`SkillExecutor` 在 inline 和 fork 两个路径都调一次：

```java
public static String executeInline(Skill skill, String args, SkillHost host) {
    assertAllowedToolsExist(skill, host.toolRegistry());
    String body = substituteArguments(skill.promptBody(), args);
    host.activateSkill(skill.meta().name(), body);
    host.recordSkillInvocation(skill.meta().name(), body);
    ...
}

public static String executeFork(Skill skill, String args, SkillForkHost host) {
    assertAllowedToolsExist(skill, host.toolRegistry());
    String body = substituteArguments(skill.promptBody(), args);
    host.recordSkillInvocation(skill.meta().name(), skill.promptBody());
    ...
}
```

inline 记录渲染后的 body（含 `$ARGUMENTS` 替换结果），fork 记录原始 `promptBody` （因为 fork 在子 Agent 里跑，主对话只关心 SOP 本身）。

### 限额：四个硬上限

```java
public static final int RECOVERY_FILE_LIMIT = 5;
public static final int RECOVERY_TOKENS_PER_FILE = 5_000;
public static final int RECOVERY_SKILLS_BUDGET = 25_000;
public static final int RECOVERY_TOKENS_PER_SKILL = 5_000;
private static final double RECOVERY_CHARS_PER_TOKEN = 3.5;
```

最多 5 个文件、每个最多 5000 token；技能总预算 25000 token、单技能 5000 token 上限。这些是硬上限，超出就丢，不报错。这意味着恢复块的体积可以预测，最坏情况大约 60K token，远低于 80% 的压缩触发线。换句话说，恢复块自己不会反过来把上下文撑爆。

`truncateByTokens` 按 `s.length() / 3.5` 折算上限，超额时切尾追加 `… (content truncated)` 标记。这个标记是给模型看的提示，让它知道这里不是完整内容，需要的话要重读。

### buildRecoveryAttachment：四段渲染

```java
public static String buildRecoveryAttachment(RecoveryState state,
                                             List<Map<String, Object>> toolSchemas) {
    var sb = new StringBuilder();

    if (state != null) {
        var files = state.snapshotFiles(RECOVERY_FILE_LIMIT);
        if (!files.isEmpty()) {
            sb.append("## Recently read files

")
              .append("These snapshots are what the file-reading tool last returned. ")
              .append("Re-open with the tool if you need the current bytes.

");
            for (var f : files) {
                String body = truncateByTokens(f.content(), RECOVERY_TOKENS_PER_FILE);
                sb.append("### ").append(f.path())
                  .append("  (read ").append(RECOVERY_TS.format(f.timestamp())).append(")

")
                  .append("```
").append(body);
                if (!body.endsWith("
")) sb.append('
');
                sb.append("```

");
            }
        }
    }
    ...
}
```

输出顺序固定：最近读过的文件、已激活的技能、当前可用工具、收尾提示。每段都可能为空，全空时返回 `""` ，调用方就当压缩没附带恢复块处理。文件段按 `Comparator.comparing(...timestamp).reversed()` 排序，最近读的在最上面。

技能段在循环里实时算预算：

```java
int used = 0;
boolean emitted = false;
for (var sk : skills) {
    String body = truncateByTokens(sk.body(), RECOVERY_TOKENS_PER_SKILL);
    int tokens = approxTokens(body) + approxTokens(sk.name()) + 8;
    if (used + tokens > RECOVERY_SKILLS_BUDGET) break;
    used += tokens;
    section.append("### ").append(sk.name()).append("

")
           .append(body).append("

");
    emitted = true;
}
```

`+ 8` 是给 markdown 开销留的小余量。算到超预算就 break，保证总长可控。

工具段列出当前 schema 表里的所有工具名和描述首行：

```java
if (toolSchemas != null && !toolSchemas.isEmpty()) {
    sb.append("## Available tools

")
      .append("You still have access to the following tools — call them directly when the task needs one:

");
    for (var t : toolSchemas) {
        if (t == null) continue;
        Object nameObj = t.get("name");
        if (nameObj == null) continue;
        String name = nameObj.toString();
        ...
        if (!desc.isEmpty()) {
            sb.append("- ").append(name).append(" — ").append(desc).append('
');
        } else {
            sb.append("- ").append(name).append('
');
        }
    }
}
```

这一段是关键。摘要替换之后，模型如果不知道自己还有什么工具可用，行为会变保守，宁可问用户也不肯发起调用。把工具表显式写一遍，给模型一个清晰的「你还能这样做」的提醒。API 层每次请求本来就会带 `tools` 参数，所以这是双重保险。

收尾段是固定的一小段提示：

> Everything above the divider is reconstructed context. For exact code, error strings, or user-typed text, re-read the source rather than guess from the summary.

修正的是模型一个常见错误倾向：看到摘要里说「修改了 foo.java 的 handleError」，可能就直接基于摘要那几句话改代码，结果改错。这段明确告诉它要原文请去重读。

### 怎么拼到摘要后面

`manage` 与 `forceCompact` 多两个参数，把 recovery 和当前工具表透传给 `autoCompact` ：

```java
public static String manage(ConversationManager conv, LlmClient client,
                            int contextWindow, String workDir,
                            AutoCompactTrackingState tracking,
                            RecoveryState recovery,
                            List<Map<String, Object>> toolSchemas) {
    ...
}

public static String forceCompact(ConversationManager conv, LlmClient client, int contextWindow,
                                  RecoveryState recovery, List<Map<String, Object>> toolSchemas) {
    return autoCompact(conv, client, contextWindow, recovery, toolSchemas);
}
```

`autoCompact` 生成 `summaryText` 之后调一次 `buildRecoveryAttachment` 拿到 attachment 字符串：

```java
String content = "[Compacted conversation summary]

" + summaryText;
String attachment = buildRecoveryAttachment(recovery, toolSchemas);
if (!attachment.isEmpty()) {
    content += "

---

" + attachment;
}

ConversationManager compacted = new ConversationManager();
compacted.addUserMessage(content);
compacted.addAssistantMessage("Understood. I'll continue based on this context.");
replaceConversation(conv, compacted);
```

恢复块就是简单的字符串拼接，用 `---` 分隔，全部塞在同一条 user 消息里。下一条 assistant 确认消息保持不变。从对话结构上看，整段会话史现在只剩两条消息：一条带摘要+恢复的 user，一条 ack 的 assistant。

### 工具表的早期计算

Agent 主循环在调 `manage` 之前先把工具表算好一次：

```java
var iterToolSchemas = registry.getAllSchemas(protocol);
if (toolNameFilter != null) {
    iterToolSchemas = iterToolSchemas.stream()
            .filter(schema -> {
                Object name = schema.get("name");
                return name == null || toolNameFilter.test(name.toString());
            })
            .toList();
}

String compactMsg = ContextCompactor.manage(
        conv, client, contextWindow, wd, compactTracking,
        recoveryState, iterToolSchemas);
...
var streamQueue = client.stream(applied.apiConv(), iterToolSchemas);
```

为什么要在 `manage` 之前就算好？因为恢复块里的「可用工具」段必须和下一次 `client.stream` 看到的工具集完全一致。如果先算 `manage` 再重算 schemas，两次结果可能不同（比如 `toolNameFilter` 在中间被改过），模型就会被骗：恢复块说有 A 工具但 API 请求里没传，或者反过来。一次算好两边复用，逻辑上更可靠。

TUI 的 `/compact` 命令也一样取一次工具表和 recovery：

```java
var schemas = agent.getRegistry() != null
        ? agent.getRegistry().getAllSchemas(agent.getProtocol())
        : java.util.List.<java.util.Map<String, Object>>of();
String msg = com.mewcode.compact.ContextCompactor.forceCompact(
        conversation, client, selectedProvider.resolvedContextWindow(),
        agent.getRecoveryState(), schemas);
```

agent 为 null 时退化为空列表，恢复块的工具段就为空，整体仍能正常跑。

## 小结

| 设计决策 | Java 的实现方式 |
| --- | --- |
| 两层架构 | Layer 1 落盘裁剪（无条件）+ Layer 2 LLM 摘要（80% 触发） |
| 落盘策略 | 单结果 > 15000 字符或消息聚合 > 20000 字符写磁盘 |
| 裁剪策略 | 最近 10 轮不动，更老的 > 2000 字符裁成一行 |
| 幂等保护 | `alreadyProcessed` 检查 + `writeSpill` 文件已存在则跳过 |
| 熔断器 | 连续 3 次 LLM 摘要失败后停止自动压缩 |
| 摘要格式 | `<analysis>` + `<summary>` 两段式，提取 summary 丢弃分析 |
| Token 估算 | 3.5 字符/Token，纯本地计算，不调 API |
| 对话重建 | 新建 ConversationManager + 逐条 appendMessage + replaceConversation |
| 工具类模式 | 私有构造函数 + 全部 static 方法，无实例状态 |
| 跨轮快照 | `RecoveryState` 用 `synchronized (lock)` 保护两张 map，ReadFile 后重读字节落帐 |
| 恢复块限额 | 5 文件 × 5K token / 25K token 技能预算 / 单技能 5K，总长稳定在 60K 内 |
| 技能记录扩展点 | `SkillHost.recordSkillInvocation` 用 `default` 方法做 no-op，老实现不破坏 |
| 工具表对齐 | 主循环开头一次性算 `iterToolSchemas` ，恢复块和 `client.stream` 复用同一份 |
