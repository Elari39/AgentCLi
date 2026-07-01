# Java源码解析：子 Agent 创建与任务管理

派大星 6月12日修改

> 理论篇讲了 SubAgent 的设计理念，这篇走读 Java 版的实现。六个文件约 1012 行，用 record、virtual thread、BlockingQueue 这些 Java 21 的特性来实现完整的 SubAgent 系统。

## 模块概览

Java 版 SubAgent 系统的代码集中在 `com.mewcode.subagent` 包下：

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `SubAgentSpec.java` | 83 | Agent 定义。`record` 类型 + 三个内置 Agent 常量 |
| `AgentLoader.java` | 169 | 定义加载。内置 + 用户级 + 项目级三级扫描 |
| `ToolFilter.java` | 99 | 工具过滤。全局黑名单 + 异步白名单 + 定义级限制 |
| `SubAgentTaskManager.java` | 170 | 后台任务管理。`virtual thread` 执行 + 通知队列 |
| `AgentTool.java` | 469 | 入口。`execute` 分发、前台/后台/`Fork` 三种执行路径 |
| `SubAgentProgress.java` | 26 | 进度报告。`record` 类型，每次工具调用后发一个 |

六个文件的职责划分清晰： `SubAgentSpec` 定义 Agent 蓝图， `AgentLoader` 负责发现和加载， `ToolFilter` 做工具过滤， `SubAgentTaskManager` 管理后台任务， `AgentTool` 是统一入口， `SubAgentProgress` 做进度报告。Fork 模式的逻辑合并在了 `AgentTool` 里。

## 核心类型

### SubAgentSpec：record 风格的 Agent 蓝图

```java
public record SubAgentSpec(
    String name,
    String description,
    List<String> tools,
    List<String> disallowedTools,
    String systemPromptOverride,
    int maxTurns,
    String model
) {
```

七个核心属性：名称、描述、工具白名单、工具黑名单、系统提示词、最大轮次和模型。 `tools` 是白名单字段，和 `disallowedTools` 配合使用：黑名单先移除，白名单再做交集过滤。

三个内置 Agent 直接用 `static final` 常量定义：

```java
public static final SubAgentSpec GENERAL_PURPOSE = new SubAgentSpec(
    "general-purpose", "General-purpose agent for research and multi-step tasks",
    List.of(), List.of(), null, 200, null);

public static final SubAgentSpec PLAN = new SubAgentSpec(
    "plan", "Software architect for designing implementation plans.",
    List.of(), List.of("EditFile", "WriteFile"), PLAN_AGENT_SYSTEM_PROMPT, 15, null);

public static final SubAgentSpec EXPLORE = new SubAgentSpec(
    "explore", "Fast read-only search agent for locating code",
    List.of(), List.of("EditFile", "WriteFile"), null, 30, "haiku");
```

PLAN 和 EXPLORE 都通过 `disallowedTools` 禁止了写文件操作。PLAN 有专门的系统提示词覆盖，约束 LLM 只做分析不做修改。EXPLORE 指定了 `"haiku"` 模型，因为搜索代码不需要最强的模型，用更快更便宜的 Haiku 就够了。maxTurns 的差异也值得注意：通用 Agent 200 轮，PLAN 只有 15 轮（规划不需要太多迭代），EXPLORE 30 轮。

PLAN 的系统提示词非常具体：

```java
private static final String PLAN_AGENT_SYSTEM_PROMPT = """
    You are a software architect and planning specialist.

    === CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===
    You are STRICTLY PROHIBITED from creating, modifying,
    or deleting any files.
    Your role is EXCLUSIVELY to explore code and design
    implementation plans.
    ...
    """;
```

用大写加等号的强调格式，确保 LLM 不会忽略「只读」这个约束。提示词里甚至列出了 Bash 命令的白名单和黑名单（ `ls, find, grep` 可以用， `mkdir, touch, rm` 不能用），做到了提示词层面和工具过滤层面的双重保障。

### SubAgentProgress：进度报告

```java
public record SubAgentProgress(
    String agentType,
    String description,
    String toolName,
    String toolOutput,
    boolean toolError,
    boolean done,
    int toolCount,
    double totalTime
) {}
```

每次 SubAgent 执行一个工具后，会通过 `progressListener` 发出一个进度事件。 `done` 字段区分「中间状态」和「最终状态」。 `totalTime` 用秒为单位，便于 UI 展示。这种细粒度的进度报告让用户能实时看到 SubAgent 的执行进展，而不是只在最后看到结果。

## Agent 定义的加载

### 三级扫描

```java
public static Map<String, SubAgentSpec> loadAll(Path projectRoot) {
    var loader = new AgentLoader();
    loader.loadBuiltins();
    String home = System.getProperty("user.home");
    if (home != null && !home.isEmpty())
        loader.loadDir(Path.of(home, ".mewcode", "agents"));
    if (projectRoot != null)
        loader.loadDir(projectRoot.resolve(".mewcode").resolve("agents"));
    return Collections.unmodifiableMap(loader.agents);
}
```

三级优先级：builtin → user → project，后加载的覆盖先加载的。这意味着项目级优先级最高，可以覆盖用户级和内置的同名 Agent 定义。

返回值用 `Collections.unmodifiableMap` 包装，防止调用方修改加载结果。这是 Java 的防御性编程风格。

### 定义文件的解析

```java
static SubAgentSpec parseAgentFile(Path path) throws IOException {
    String content = Files.readString(path);
    String trimmed = content.strip();
    String yamlBlock = null;
    String body = trimmed;
    if (trimmed.startsWith("---")) {
        int firstEnd = trimmed.indexOf("---", 3);
        if (firstEnd >= 0) {
            yamlBlock = trimmed.substring(3, firstEnd).strip();
            body = trimmed.substring(firstEnd + 3).strip();
        }
    }
```

YAML frontmatter 的解析逻辑清晰直接。做了一个宽松处理：如果文件不以 `---` 开头，不报错，而是把整个文件当作 body。这种宽容的设计让纯 Markdown 文件也能被解析为 Agent 定义。

用 SnakeYAML 解析 frontmatter 内容：

```java
if (yamlBlock != null && !yamlBlock.isEmpty()) {
    Yaml yaml = new Yaml();
    Map<String, Object> frontmatter = yaml.load(yamlBlock);
    if (frontmatter != null) {
        name = getString(frontmatter, "name");
        description = getString(frontmatter, "description");
        disallowedTools = getStringList(frontmatter, "disallowedTools");
        model = getString(frontmatter, "model");
        Object maxTurnsObj = frontmatter.get("maxTurns");
        if (maxTurnsObj instanceof Number n) {
            maxTurns = n.intValue();
        }
    }
}
```

`getStringList` 有个值得注意的实现细节：

```java
private static List<String> getStringList(Map<String, Object> map, String key) {
    Object v = map.get(key);
    if (v instanceof List<?> list) {
        var result = new ArrayList<String>();
        for (Object item : list) {
            if (item instanceof String s) result.add(s);
        }
        return List.copyOf(result);
    }
    return List.of();
}
```

用 pattern matching（ `instanceof String s` ）逐个检查列表元素是否为字符串，跳过非字符串的元素。返回不可变列表。这种防御性处理应对了 YAML 文件里可能出现混合类型的情况。

模型合法性校验：

```java
private static final Set<String> VALID_MODELS =
    Set.of("", "inherit", "haiku", "sonnet", "opus");

if (model != null && !VALID_MODELS.contains(model)) {
    throw new IllegalArgumentException(
        "Agent definition %s: invalid model '%s'"
            .formatted(path, model)
    );
}
```

只在 model 非 null 时才校验，允许不指定 model 的情况（默认继承父 Agent 的模型）。

## 工具过滤

### 六层过滤模型

```java
public static ToolRegistry filterForAgent(
    ToolRegistry source, SubAgentSpec spec,
    boolean isAsync, boolean isCustom,
    boolean isInProcessTeammate
) {
    Set<String> disallowed = new HashSet<>(spec.disallowedTools());
    boolean hasWhitelist = spec.tools() != null && !spec.tools().isEmpty()
        && !(spec.tools().size() == 1 && "*".equals(spec.tools().get(0)));
    ToolRegistry filtered = new ToolRegistry();
    for (Tool tool : source.listTools()) {
        String name = tool.name();
        if (isMcpTool(name)) { filtered.register(tool); continue; }   // Layer 1
        if (ALWAYS_DISALLOWED.contains(name)) continue;                 // Layer 2
        if (isCustom && CUSTOM_AGENT_DISALLOWED.contains(name)) continue; // Layer 3
        if (isAsync && !ASYNC_ALLOWED.contains(name)) {                 // Layer 4
            if (isInProcessTeammate
                    && ("Agent".equals(name) || IN_PROCESS_TEAMMATE_ALLOWED.contains(name))) {
                // fall through — permitted
            } else { continue; }
        }
        if (disallowed.contains(name)) continue;                        // Layer 5
        if (hasWhitelist && !allowed.contains(name)) continue;          // Layer 6
        filtered.register(tool);
    }
    return filtered;
}
```

过滤分六层：MCP 直通 → 全局黑名单 → 自定义 Agent 黑名单 → 异步白名单 → 定义级黑名单 → 定义级白名单。

全局黑名单：

```java
private static final Set<String> ALWAYS_DISALLOWED = Set.of(
    "TaskOutput", "ExitPlanMode", "EnterPlanMode",
    "Agent", "AskUserQuestion", "TaskStop", "Workflow"
);
```

7 个工具。 `Agent` 禁止是为了防止无限递归， `AskUserQuestion` 禁止是因为 SubAgent 不应该直接和用户交互， `ExitPlanMode` / `EnterPlanMode` 防止模式切换， `TaskOutput` / `TaskStop` / `Workflow` 是协调类工具。

异步白名单：

```java
private static final Set<String> ASYNC_ALLOWED = Set.of(
    "ReadFile", "WebSearch", "TodoWrite", "Grep", "WebFetch", "Glob",
    "Bash", "EditFile", "WriteFile", "NotebookEdit", "Skill", "LoadSkill",
    "SyntheticOutput", "ToolSearch", "EnterWorktree", "ExitWorktree"
);
```

16 个工具，覆盖了文件操作、搜索、Bash 命令、Skill 执行和 Worktree 操作。如果子 Agent 是 InProcessTeammate（ch15 团队模式），Layer 4 还额外允许 `Agent` 工具和协调工具（TaskCreate、TaskGet 等）。

MCP 工具（以 `mcp__` 开头）直接跳过所有过滤规则，因为 MCP 工具通常有自己的权限控制。

## 执行路径

### execute 入口

```java
public ToolResult execute(Map<String, Object> args) {
    String description = getStringArg(args, "description");
    String prompt = getStringArg(args, "prompt");
    if (description == null || prompt == null)
        return ToolResult.error("description and prompt are required");
    String subagentType = getStringArg(args, "subagent_type");
    if (subagentType == null || subagentType.isEmpty())
        return runFork(description, prompt, getStringArg(args, "model"));
    SubAgentSpec spec = resolveSpec(subagentType);
    if (spec == null)
        return ToolResult.error("Unknown agent type: " + subagentType);
    // ... 根据参数选择 runSync / runAsync
}
```

一个值得注意的设计：没有指定 `subagent_type` 时默认走 Fork 模式。这样 LLM 不需要选择具体的 Agent 类型就能启动一个子任务，降低了使用门槛。

### 前台同步执行

```java
private ToolResult runSync(
    SubAgentSpec spec, String description,
    String prompt, String modelOverride, String isolation
) {
    ToolRegistry subRegistry = ToolFilter.filterForAgent(
        parentRegistry, spec
    );
    LlmClient subClient = selectClient(spec.model(), modelOverride);

    Agent subAgent = new Agent(subClient, subRegistry, protocol);
    int maxTurns = spec.maxTurns() > 0 ? spec.maxTurns() : 200;
    subAgent.setMaxIterations(maxTurns);
```

SubAgent 的构建很简洁，Agent 构造只需要三个参数（client、registry、protocol），其他属性通过 setter 设置。

事件消费循环：

```java
BlockingQueue<AgentEvent> queue = subAgent.run(conv);
while (true) {
    AgentEvent event;
    try {
        event = queue.poll(60, TimeUnit.SECONDS);
    } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        return ToolResult.error("Agent interrupted");
    }
    if (event == null)
        return ToolResult.error("Agent timed out");
```

拿到事件后用 pattern matching switch 分发处理：

```java
switch (event) {
        case AgentEvent.StreamText st -> output.append(st.text());
        case AgentEvent.ToolResultEvent tre -> {
            toolCount++;
            emitProgress(description, spec.name(), tre.toolName(),
                tre.output(), tre.isError(), false, toolCount, elapsed);
        }
        case AgentEvent.ErrorEvent err ->
            return ToolResult.error("Agent failed: " + err.message());
        case AgentEvent.LoopComplete lc -> { /* 返回结果 */ }
        default -> {}
    }
}
```

Java 版需要自己消费事件流，因为 Agent.run 返回 `BlockingQueue<AgentEvent>` （第4章的设计），调用方必须显式消费事件。

这种显式消费的好处是能在执行过程中发出进度报告（每个工具调用后 `emitProgress` ），让调用方实时了解 SubAgent 的执行进展。

`poll(60, TimeUnit.SECONDS)` 设置了 60 秒超时，如果 SubAgent 60 秒内没有产生任何事件就判定超时。这个保护机制防止了 SubAgent 卡死导致父 Agent 永久阻塞。

### Worktree 隔离

```java
String wtBranch = null;
if ("worktree".equals(isolation) && worktreeManager != null) {
    wtBranch = "agent-%s-%d".formatted(
        description.replaceAll("\\s+", "-"), System.currentTimeMillis());
    try {
        worktreeManager.create(wtBranch, null);
    } catch (Exception e) {
        return ToolResult.error("Error creating worktree: " + e.getMessage());
    }
}
```

分支名用 `agent-描述-时间戳` 的格式，描述中的空格替换为连字符。执行完之后的清理：

```java
if (wtBranch != null && worktreeManager != null) {
    var wtOpt = worktreeManager.get(wtBranch);
    if (wtOpt.isPresent()) {
        String changes = WorktreeManager.detectChanges(wtOpt.get().path());
        if (changes.isEmpty()) {
            worktreeManager.remove(wtBranch);
        } else {
            wtInfo = "\n\nWorktree retained at %s (branch: %s)"
                .formatted(wtOpt.get().path(), wtBranch);
        }
    }
}
```

有文件修改就保留 worktree，没有修改就删除。还额外把 `detectChanges` 的结果（具体哪些文件改了）附加到输出里，让父 Agent 知道 SubAgent 修改了什么。

### Fork 模式

```java
private ToolResult runFork(String description, String prompt,
                            String modelOverride) {
    if (parentConversation == null)
        return ToolResult.error("fork requires parent conversation context");
    for (var msg : parentConversation.getMessages()) {
        if (msg.getContent() != null
                && msg.getContent().contains(FORK_BOILERPLATE_TAG))
            return ToolResult.error("cannot fork from a forked agent");
    }
```

防嵌套检测：扫描对话历史找 `<fork_boilerplate>` 标签。如果发现对话里已经有这个标签，说明当前已经是一个 Fork 出来的 Agent，不允许再次 Fork，防止无限递归。

Fork 会话的构建更详细：

```java
private static ConversationManager buildForkedConversation(
        ConversationManager parent, String task) {
    ConversationManager forked = new ConversationManager();
    for (var msg : parent.getMessages()) {
        if (hasUnresolvedToolUses(msg)) {
            // 有工具调用但没结果：先添加 assistant 消息，再补占位符
            forked.addAssistantFull(msg.getContent(),
                msg.getThinkingBlocks(), msg.getToolUses());
            var placeholders = msg.getToolUses().stream()
                .map(tu -> new ToolResultBlock(tu.toolUseId(),
                    "(tool execution interrupted by fork)", false))
                .toList();
            forked.addToolResultsMessage(placeholders);
```

对于有工具结果的消息、纯 assistant 消息、用户消息，分别调用对应的 add 方法：

```java
} else if (hasToolUses(msg)) {
            forked.addAssistantFull(msg.getContent(),
                msg.getThinkingBlocks(), msg.getToolUses());
        } else if (hasToolResults(msg)) {
            forked.addToolResultsMessage(msg.getToolResults());
        } else if ("assistant".equals(msg.getRole())) {
            forked.addAssistantMessage(msg.getContent());
        } else {
            forked.addUserMessage(msg.getContent());
        }
    }
    forked.addUserMessage(FORK_BOILERPLATE + "\n\nYour task:\n" + task);
    return forked;
}
```

遍历所有消息，对每种消息类型做不同处理。这让对话历史的拷贝更精确，保留了 thinking blocks 和工具结果的完整结构。对于有工具调用但没有结果的消息，会补上占位符 `"(tool execution interrupted by fork)"` ，说明中断的原因。

Fork 模式总是在后台运行：

```java
String taskId = taskManager.spawnSubAgent(
    subClient, parentRegistry, protocol,
    SubAgentSpec.GENERAL_PURPOSE,
    FORK_BOILERPLATE + "\n\nYour task:\n" + prompt
);
```

直接用 `spawnSubAgent` 异步启动，父 Agent 可以继续执行其他任务。

## SubAgentTaskManager：后台任务管理

### 任务状态机

```java
public enum TaskStatus {
    PENDING, RUNNING, COMPLETED, FAILED, CANCELLED
}
```

五种状态形成一个简单的状态机： `PENDING → RUNNING → COMPLETED/FAILED/CANCELLED` 。用 enum 而不是字符串，编译器保证只有合法的状态值，switch 语句也能做穷举检查。

### 内部状态的封装

```java
private static class TaskEntry {
    final String id;
    final String name;
    volatile TaskStatus status;
    volatile String output;
    volatile String error;
    volatile Thread thread;

    TaskEntry(String id, String name) {
        this.id = id;
        this.name = name;
        this.status = TaskStatus.PENDING;
    }
}
```

`volatile` 关键字标记了所有可变字段。因为任务在 virtual thread 里执行，状态更新发生在工作线程，状态读取发生在主线程， `volatile` 保证了跨线程的可见性。

对外暴露的是不可变的 `Task` record：

```java
public record Task(String id, String name, TaskStatus status,
                   String output, String error) {}
```

内部可变的 `TaskEntry` 、对外不可变的 `Task` 。这种内外分离的设计保证了外部代码拿到的快照不会被后台线程修改。

### Virtual Thread 执行

```java
public String spawnSubAgent(LlmClient client, ToolRegistry registry,
        String protocol, SubAgentSpec spec, String prompt) {
    String taskId = createTask(spec.name() + ": " + truncate(prompt, 50));
    Thread thread = Thread.startVirtualThread(() -> {
        ToolRegistry subRegistry = ToolFilter.filterForAgent(registry, spec);
        var subAgent = new Agent(client, subRegistry, protocol);
        subAgent.setMaxIterations(spec.maxTurns() > 0 ? spec.maxTurns() : 200);
        var conv = new ConversationManager();
        if (spec.systemPromptOverride() != null)
            conv.addSystemReminder(spec.systemPromptOverride());
        conv.addUserMessage(prompt);
```

Agent 构建完成后，启动事件消费循环。中断检查放在 while 条件里，确保线程取消后及时退出：

```java
var output = new StringBuilder();
        var queue = subAgent.run(conv);
        while (!Thread.currentThread().isInterrupted()) {
            AgentEvent event = queue.poll(60, TimeUnit.SECONDS);
            switch (event) {
                case AgentEvent.StreamText st -> output.append(st.text());
                case AgentEvent.ErrorEvent err -> { setFailed(taskId, err.message()); return; }
                case AgentEvent.LoopComplete lc -> { setCompleted(taskId, output.toString()); return; }
                default -> {}
            }
        }
    });
    setRunning(taskId, thread);
}
```

用 `Thread.startVirtualThread` 启动后台任务。Virtual thread 是 Java 21 的特性，是抢占式调度。对于 SubAgent 这种 I/O 密集（大部分时间在等 LLM 响应）的工作负载，虚拟线程非常合适，创建成本极低且不会占用 OS 线程。

任务名格式是 `spec名: prompt前50字` ，方便在 UI 里辨识。

事件消费循环里，中断检查 `Thread.currentThread().isInterrupted()` 放在 while 条件里，任何时候线程被中断都能及时退出。虚拟线程的中断机制和传统线程一致， `poll` 等阻塞操作在线程被中断时会立即抛出 `InterruptedException` 。

### 取消和通知

```java
public synchronized void cancelTask(String id) {
    TaskEntry t = tasks.get(id);
    if (t != null && t.status == TaskStatus.RUNNING) {
        t.status = TaskStatus.CANCELLED;
        if (t.thread != null) {
            t.thread.interrupt();
        }
        notifications.add(new TaskNotification(
            id, t.name, TaskStatus.CANCELLED, ""
        ));
    }
}
```

取消操作先改状态，再中断线程。顺序很重要：如果先中断再改状态，事件消费循环可能先看到中断，在状态还是 `RUNNING` 的时候就退出了。

通知的收集：

```java
public synchronized List<TaskNotification> drainNotifications() {
    var result = new ArrayList<>(notifications);
    notifications.clear();
    return result;
}
```

所有公共方法都加了 `synchronized` 。因为 Java 的并发模型是多线程的，任务在虚拟线程里执行，状态更新和读取可能发生在不同的线程上， `synchronized` 保证了操作的原子性和可见性。

## 模型选择和工具 Schema

### 模型选择

```java
private LlmClient selectClient(String specModel, String overrideModel) {
    String model = (overrideModel != null && !overrideModel.isEmpty())
        ? overrideModel : specModel;
    if (model == null || model.isEmpty() || "inherit".equals(model))
        return client;
    if (modelResolver != null) {
        LlmClient resolved = modelResolver.apply(model);
        if (resolved != null) return resolved;
    }
    return client;
}
```

参数级覆盖 > 定义级 > 继承。通过外部注入的 `modelResolver` 函数来解析模型名，实现了依赖注入：调用方决定如何解析模型名到 LlmClient，SubAgent 本身不关心解析细节。

### 动态 Schema 生成

```java
public Map<String, Object> schema() {
    List<String> agentTypes;
    if (agentSpecs != null && !agentSpecs.isEmpty())
        agentTypes = AgentLoader.listNames(agentSpecs);
    else
        agentTypes = List.of("general-purpose", "plan", "explore");

    Map<String, Object> properties = new LinkedHashMap<>();
    properties.put("subagent_type", Map.of(
        "type", "string", "enum", agentTypes,
        "description", "The type of agent to use."));
    // ...
}
```

Schema 的 `subagent_type` 字段的 `enum` 列表是动态生成的，包含了所有已加载的 Agent 类型。这样 LLM 在选择 Agent 类型时，只会看到当前可用的选项，不会尝试调用不存在的类型。

动态 enum 列表对 LLM 更友好，LLM 只会看到当前可用的选项，不会尝试使用不存在的 Agent 类型。

### shouldDefer：延迟加载

```java
@Override
public boolean shouldDefer() {
    return true;
}
```

Agent 工具标记了 `shouldDefer` ，意味着它的 schema 不会默认出现在工具列表里，只有通过 ToolSearch 显式查找才会加载。这是一个成本优化：Agent 工具的 schema 比较大（包含动态的 agent 类型列表和详细描述），不是每次对话都需要。

## 小结

| 设计决策 | Java 的实现方式 |
| --- | --- |
| Agent 定义 | `record`，7 个核心字段（含 `tools` 白名单） |
| 内置 Agent | `static final` 常量（`general-purpose`、`plan`、`explore`） |
| 加载顺序 | `builtin` → `user` → `project`（后覆盖前，项目级优先） |
| 工具过滤 | 6 层：MCP 直通 → 全局黑名单(7) → 自定义黑名单(7) → 异步白名单(16) → 定义级黑名单 → 定义级白名单 |
| MCP 工具 | 总是放行，跳过所有过滤 |
| 后台执行 | `Virtual Thread` + `BlockingQueue` |
| 线程安全 | `synchronized` + `volatile` |
| 进度报告 | `SubAgentProgress` `record`，每个工具调用后发出 |
| Fork 会话 | 遍历所有消息分类处理，补占位符 |
| 事件消费 | 显式 `while` + `poll` 循环，60s 超时保护 |
| Schema | 动态生成 `enum` 列表 |
| 模型解析 | 外部注入 `modelResolver` 函数 |
