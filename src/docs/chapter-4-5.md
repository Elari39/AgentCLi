# Java源码解析：Agent 主循环与事件流

派大星 6月12日修改

> 理论篇讲了 Agent Loop 的设计理念和 ReAct 范式，这篇带你走读 Java 版 MewCode 的真实代码，看看这些概念在 virtual thread + BlockingQueue 的架构下是怎么落地的。

## 模块概览

Java 版的 Agent Loop 代码分布在三个文件里：

| 文件 | 职责 |
| --- | --- |
| `Agent.java` | 核心。`Agent` 类定义、`run()` 入口、`agentLoop()` 主循环、流消费、错误恢复 |
| `AgentEvent.java` | Agent 和 UI 之间的通信协议，用 `sealed interface` + `record` 定义所有事件类型 |
| `StreamingExecutor.java` | 工具执行器。分批策略、并行执行、单工具完整执行管线（权限→Hook→执行→截断） |

三个文件加起来不到 500 行。Java 版是三个语言实现中最紧凑的，原因是 Java 21 的 `record`、`sealed interface`、`pattern matching` 让类型定义和分支逻辑都变得极其简洁。

## 核心类型

### Agent 类

```java
public class Agent {
    private final LlmClient client;
    private final ToolRegistry registry;
    private final String protocol;
    private final int contextWindow;
    private PermissionChecker checker;
    private HookEngine hookEngine;
    private int maxIterations;
    private Supplier<List<String>> notificationFn;
}
```

核心三件套：`client` 负责 LLM 通信，`registry` 提供工具，`protocol` 决定工具描述格式。`contextWindow` 定义为 `final`，构造后不可变。

构造函数只接收三件套，其他能力通过 setter 按需注入：

```java
public Agent(LlmClient client, ToolRegistry registry, String protocol) {
    this.client = client;
    this.registry = registry;
    this.protocol = protocol;
    this.contextWindow = 200_000;
}

public void setChecker(PermissionChecker checker) { this.checker = checker; }
public void setHookEngine(HookEngine hookEngine) { this.hookEngine = hookEngine; }
public void setMaxIterations(int max) { this.maxIterations = max; }
```

先构造最小可用对象，再逐步挂载可选能力。这种渐进式配置的好处是构造函数参数少，调用方可以只配置自己需要的能力，不需要为不关心的选项传 null。

### AgentEvent：sealed interface + record

这是整个 Java 版最漂亮的类型设计。用 Java 17 的 `sealed interface` 限制事件类型集合，用 `record` 定义每个事件：

```java
public sealed interface AgentEvent {
    record StreamText(String text) implements AgentEvent {}
    record ToolUseEvent(String toolId, String toolName,
                        Map<String, Object> args) implements AgentEvent {}
    record ToolResultEvent(String toolId, String toolName, String output,
                           boolean isError, double elapsed) implements AgentEvent {}
    record TurnComplete(int turn) implements AgentEvent {}
    record LoopComplete(int totalTurns) implements AgentEvent {}
    record UsageEvent(int inputTokens, int outputTokens) implements AgentEvent {}
    record ErrorEvent(String message) implements AgentEvent {}
    record CompactEvent(String message) implements AgentEvent {}
    record RetryEvent(String reason, long waitMs) implements AgentEvent {}
    record PermissionRequestEvent(String toolName, String description,
            CompletableFuture<PermissionResponse> future) implements AgentEvent {}
}
```

`sealed` 关键字的作用是告诉编译器：只有这些 `record` 可以实现 `AgentEvent`。这意味着 `switch` 语句可以做穷举检查，漏掉哪个分支编译器会警告你。`sealed interface` 的类型安全性非常强，因为编译期就能发现遗漏，不会在运行时才碰到未处理的事件类型。

权限请求用 `CompletableFuture` 做反向通信：

```java
record PermissionRequestEvent(
    String toolName,
    String description,
    CompletableFuture<PermissionResponse> future
) implements AgentEvent {}
```

Agent 创建一个 `CompletableFuture`，放进事件发给 UI，然后 `future.get(5, TimeUnit.MINUTES)` 阻塞等待。UI 那边拿到 future 后让用户选择，选完 `future.complete(response)` 写回。5 分钟超时兜底，防止用户长时间不响应导致线程永久阻塞。超时后默认拒绝，这是安全优先的设计。

### record 的额外亮点

还有一个值得注意的事件类型 `AskUserRequestEvent`：

```java
record AskUserRequestEvent(
    List<AskUserDialog.Question> questions,
    CompletableFuture<Map<String, String>> future
) implements AgentEvent {}
```

这个事件让 Agent 可以向用户发起结构化问卷（多个问题，每个问题有独立回答），不仅仅是「允许/拒绝」的二元选择。这在需要收集多项用户输入的场景下非常有用。

## 主循环走读

### 入口：run()

```java
public BlockingQueue<AgentEvent> run(ConversationManager conv) {
    var queue = new LinkedBlockingQueue<AgentEvent>(64);
    Thread.startVirtualThread(() -> {
        try {
            agentLoop(conv, queue);
        } catch (Exception e) {
            putSafe(queue, new AgentEvent.ErrorEvent(
                "Agent error: " + e.getMessage()));
        }
    });
    return queue;
}
```

`run()` 的设计是典型的「生产者/消费者」模式：启动一个后台虚拟线程跑循环，事件通过队列推给 UI，立即返回队列引用。调用方拿到队列后就可以开始消费事件，不需要等循环结束。

`Thread.startVirtualThread()` 是 Java 21 引入的 API。虚拟线程由 JVM 管理，创建成本极低（几微秒），可以同时存在数百万个。这比传统的 `new Thread()` 轻量得多，非常适合 IO 密集的任务。

`LinkedBlockingQueue` 的容量是 64。这意味着 Agent 可以连续发 64 个事件而不用等 UI 消费。如果队列满了，`putSafe` 里的 `queue.put()` 会阻塞虚拟线程，但不会占用操作系统线程（这是虚拟线程的优势）。

外层的 try-catch 是最后一道防线：`agentLoop` 里任何未预料到的异常都会被捕获，包装成 `ErrorEvent` 推给 UI。这样 UI 总能收到错误信息，不会出现循环默默退出、调用方完全不知道发生了什么的情况。

### 循环骨架

```java
for (int iteration = 1; ; iteration++) {
    // 1. 检查迭代上限
    // 2. 检查线程中断
    // 3. 消费通知队列
    // 4. 自动上下文压缩
    // 5. 注入延迟工具清单
    // 6. 获取工具 schema，调用 LLM
    // 7. 消费流式响应
    // 8. 错误恢复
    // 9. max_tokens 恢复
    // 10. 保存 assistant 消息
    // 11. 没有工具调用 → 结束
    // 12. 执行工具 + 收集结果
    // 13. turn_end 通知
}
```

标准的无限循环加计数器，循环体里按步骤执行各个阶段。整个循环比较精简，聚焦在核心的「调 LLM → 消费流 → 执行工具」这条主线上。

### 调用 LLM 和消费流式响应

```java
var tools = registry.getAllSchemas(protocol);
var streamQueue = client.stream(conv, tools);
```

LLM 调用返回一个 `BlockingQueue<StreamEvent>`。`BlockingQueue` 是 Java 标准库里最适合「生产者/消费者」场景的并发原语，支持阻塞读取和容量限制，正好满足流式事件传递的需求。

然后用一个无限循环消费流：

```java
StreamEvent event = streamQueue.poll(30, TimeUnit.SECONDS);
if (event == null) {
    putSafe(queue, new AgentEvent.ErrorEvent("Stream timeout"));
    return;
}
```

`poll(30, TimeUnit.SECONDS)` 是带超时的阻塞读取。30 秒没收到事件就认为流超时，直接终止。这种超时保护避免了因为网络中断导致线程永久阻塞的风险。

拿到事件后用 pattern matching for switch 分发：

```java
switch (event) {
    case StreamEvent.TextDelta td -> {
        text.append(td.text());
        putSafe(queue, new AgentEvent.StreamText(td.text()));
    }
    case StreamEvent.ToolCallComplete tcc -> {
        toolCalls.add(new ToolCallInfo(...));
        putSafe(queue, new AgentEvent.ToolUseEvent(...));
    }
    case StreamEvent.StreamEnd se -> {
        stopReason = se.stopReason();
        turnInput = se.inputTokens();
    }
    case StreamEvent.Error err -> { streamError = true; }
}
```

`case StreamEvent.TextDelta td ->` 既做了类型检查又做了解构赋值，一步到位。循环在收到 `StreamEnd` 或 `Error` 时 break 退出。

### 错误恢复

Java 版有一套完整的错误恢复策略：

```java
if (streamError) {
    if (lastErr.contains("context") || lastErr.contains("too long")) {
        if (contextRetries < 3) {
            contextRetries++;
            ContextCompactor.forceCompact(conv, client, contextWindow);
            continue; // 重试
        }
    }
    if (lastErr.toLowerCase().contains("rate limit")) {
        Thread.sleep(5000);
        continue; // 等 5 秒后重试
    }
    break; // 其他错误，放弃
}
```

两种可恢复的错误：上下文过长（最多重试 3 次，每次触发强制压缩）和速率限制（等 5 秒后重试）。`continue` 跳回循环开头重新调 LLM，`break` 放弃。Java 版在虚拟线程里 `Thread.sleep(5000)` 不会阻塞操作系统线程，这是虚拟线程相对传统线程的优势。

### max\_tokens 恢复

```java
if ("max_tokens".equals(stopReason)) {
    if (!maxTokensEscalated) {
        maxTokensEscalated = true;
        if (client instanceof AnthropicClient ac) {
            ac.setMaxOutputTokens(MAX_TOKENS_CEILING);
        }
        conv.addUserMessage("Output token limit hit. Resume directly...");
        continue; // 第一阶段：提升上限，重试
    } else if (outputRecoveries < MAX_OUTPUT_RECOVERIES) {
        outputRecoveries++;
        conv.addUserMessage("Break remaining work into smaller pieces.");
        continue; // 第二阶段：分段续写
    }
}
```

当 LLM 因为输出 token 上限被截断时，Java 版有两阶段恢复。第一次：把 `max_output_tokens` 提升到 64000（`MAX_TOKENS_CEILING`），注入续写指令，重试。如果还不够，就进入第二阶段：最多再重试 3 次（`MAX_OUTPUT_RECOVERIES`），每次都告诉 LLM 把工作拆小。

注意 `client instanceof AnthropicClient ac` 这个 pattern matching：只有当客户端是 Anthropic 的实现时才调 `setMaxOutputTokens`，其他 LLM 客户端不受影响。这是 Java 16+ 的 `instanceof` 增强，一行搞定类型检查 + 类型转换。

### 终止判断

```java
if (toolCalls.isEmpty()) {
    putSafe(queue, new AgentEvent.TurnComplete(iteration));
    putSafe(queue, new AgentEvent.LoopComplete(iteration));
    break;
}
```

没有工具调用就发 `TurnComplete` + `LoopComplete` 两个事件，然后 `break` 退出循环。虚拟线程结束，但 `BlockingQueue` 不会自动关闭。UI 那边通过收到 `LoopComplete` 事件来判断循环结束。

`BlockingQueue` 没有内置的「关闭」语义（不像某些并发原语可以标记为已完成），所以需要一个显式的终止事件。UI 那边通过收到 `LoopComplete` 事件来判断循环结束，停止消费队列。

## 四个停止条件

**1. LLM 不再调用工具**

就是上面 `toolCalls.isEmpty()` 的判断。最常见的正常退出。

**2. 迭代次数上限**

```java
if (maxIterations > 0 && iteration > maxIterations) {
    putSafe(queue, new AgentEvent.ErrorEvent(
        "Agent reached maximum iterations (%d)".formatted(maxIterations)));
    break;
}
```

`maxIterations` 为 0 表示不限制。Java 用 `String.formatted()` 替代 `String.format()`，更简洁。

**3. 连续未知工具**

Java 版的连续未知工具检测在 `StreamingExecutor` 层面处理，Agent 主循环里没有显式的计数器。当 `executeSingle` 发现工具不存在时返回错误结果，由上层决定是否终止。Java 版选择了把这个逻辑下沉到执行器，Agent 只看结果。

**4. 用户取消**

```java
if (Thread.currentThread().isInterrupted()) break;
```

Java 版检查线程中断标志。上层代码可以调用 `thread.interrupt()` 来取消 Agent。虚拟线程的中断语义和传统线程一样，`interrupt()` 会设置中断标志，如果线程正在阻塞操作（如 `queue.put()`）会抛 `InterruptedException`。这是 Java 标准的协作式取消机制。

## 工具执行

### StreamingExecutor：分批 + 并行

Java 版的 `StreamingExecutor` 包含了完整的分批策略和执行管线：

先按 category 分组：

```java
var readCalls = new ArrayList<ToolCallInfo>();
var otherCalls = new ArrayList<ToolCallInfo>();
for (var call : calls) {
    var tool = registry.get(call.toolName());
    if (tool != null && tool.category() == ToolCategory.READ)
        readCalls.add(call);
    else
        otherCalls.add(call);
}
```

READ 组有多个时并行执行，其他组串行：

```java
var results = new ArrayList<ToolExecResult>();
if (readCalls.size() > 1) {
    try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
        var futures = new ArrayList<Future<ToolExecResult>>();
        for (var call : readCalls) futures.add(executor.submit(() -> executeSingle(call)));
        for (var future : futures) results.add(future.get());
    }
} else {
    for (var call : readCalls) results.add(executeSingle(call));
}
for (var call : otherCalls) results.add(executeSingle(call));
```

分批策略直接明了：按工具的 `category` 分成 READ 和其他两组。READ 组有多个调用时并行执行，其他组全部串行。READ 工具（如 `ReadFile`、`Glob`、`Grep`）不修改文件系统状态，并行执行不会产生竞态条件。

`Executors.newVirtualThreadPerTaskExecutor()` 是 Java 21 的新 API，每提交一个任务就创建一个新的虚拟线程。`try-with-resources` 确保执行器用完就关闭。如果有 5 个 Read 调用，就会启动 5 个虚拟线程并行执行，每个线程的创建成本只有几微秒。

### 单工具执行流程

`executeSingle` 是工具执行的完整管线，按顺序走四关：

**第一关：查找工具**

```java
Tool tool = registry.get(call.toolName());
if (tool == null) {
    putSafe(new AgentEvent.ToolResultEvent(
        call.toolId(), call.toolName(), "Unknown tool", true, 0));
    return new ToolExecResult(call.toolId(),
        "Error: unknown tool '" + call.toolName() + "'", true);
}
```

找不到就返回错误。注意这里既发了事件给 UI，又返回了结果给调用方。

**第二关：Pre-tool Hook**

```java
if (hookEngine != null) {
    var hookResult = hookEngine.runPreToolHooks(call.toolName(), call.args());
    if (hookResult.rejected()) {
        String msg = "Rejected by hook: " + hookResult.message();
        putSafe(new AgentEvent.ToolResultEvent(
            call.toolId(), call.toolName(), msg, true, 0));
        return new ToolExecResult(call.toolId(), msg, true);
    }
}
```

Hook 检查放在权限检查之前。这个顺序很重要：Hook 可以在权限检查之前就拦截工具执行。比如一个 pre-tool Hook 配置了「禁止执行任何包含 rm 的命令」，那即使权限系统允许执行 Bash，Hook 也能提前拦截。

**第三关：权限检查**

```java
switch (checker.check(tool, call.args()).decision()) {
    case DENY -> {
        return new ToolExecResult(call.toolId(), "Permission denied", true);
    }
    case ASK -> {
        var future = new CompletableFuture<PermissionResponse>();
        putSafe(new AgentEvent.PermissionRequestEvent(
            call.toolName(), desc, future));
        var response = future.get(5, TimeUnit.MINUTES);
        if (response == PermissionResponse.DENY)
            return new ToolExecResult(call.toolId(), "User denied", true);
    }
    case ALLOW -> {}
}
```

`switch` 用 pattern matching 穷举三种决策。`ASK` 分支创建 `CompletableFuture`，发事件给 UI，然后 `future.get(5, TimeUnit.MINUTES)` 阻塞等待。这里虚拟线程的优势又体现出来了：阻塞虚拟线程不会占用操作系统线程，可以有几千个工具同时在等权限确认也不会耗尽线程池。

超时默认拒绝（`PermissionResponse.DENY`），这是安全优先的设计：宁可拒绝也不要无限等待。

`ALLOW_ALWAYS` 处理 `extractContent` 提取工具的关键参数（Bash 的 command、ReadFile 的 file\_path），用于生成永久允许规则：

```java
private static String extractContent(String toolName, Map<String, Object> args) {
    String field = switch (toolName) {
        case "Bash" -> "command";
        case "ReadFile", "WriteFile", "EditFile" -> "file_path";
        case "Glob", "Grep" -> "pattern";
        default -> null;
    };
    if (field == null) return null;
    var v = args.get(field);
    return v instanceof String s ? s : null;
}
```

**第四关：真正执行**

```java
long start = System.nanoTime();
ToolResult result;
try {
    result = tool.execute(call.args());
} catch (Exception e) {
    result = ToolResult.error("Tool execution error: " + e.getMessage());
}
double elapsed = (System.nanoTime() - start) / 1_000_000_000.0;
```

工具执行是同步的（`tool.execute()` 直接返回结果）。因为工具在虚拟线程里执行，即使做 IO 操作（如文件读写、子进程调用）也不会阻塞操作系统线程。虚拟线程在遇到阻塞 IO 时会自动让出底层的 OS 线程，给其他虚拟线程使用。

执行完之后截断输出：

```java
String output = result.output();
if (output.length() > ToolRegistry.MAX_OUTPUT_CHARS) {
    output = output.substring(0, ToolRegistry.MAX_OUTPUT_CHARS)
        + "\n... (truncated)";
}
```

单层截断策略，超过限制直接截断并附加提示。保持简单，避免引入磁盘 IO 的复杂性。

### Post-tool Hook

```java
if (hookEngine != null) {
    var ctx = new HookEngine.HookContext(
        HookEngine.EventName.POST_TOOL_USE,
        call.toolName(), call.args(), null, null, null);
    hookEngine.runHooks(ctx);
}
```

工具执行完后触发 post-tool Hook。这是信息性的回调，不能阻断已完成的执行，只能观察结果。

## Plan Mode

Plan Mode 通过 `PermissionChecker` 实现。当 checker 的模式设为 Plan 时，所有写操作都会被权限系统拒绝。这是双层保障的思路：提示词层面告诉 LLM「你在规划模式，不要做修改」，权限层面兜底「即使 LLM 不听话也会被拦住」。系统提示词的注入在 `PermissionChecker` 和系统提示词构建层处理，Agent Loop 本身不需要关心 Plan Mode 的细节。

## 小结

| 设计决策 | Java 的实现方式 |
| --- | --- |
| 异步事件流 | `virtual thread` + `LinkedBlockingQueue`（容量 64） |
| 主循环 | 无限 `for` + `break` 出口 |
| 事件类型 | `sealed interface` + `record`，编译期穷举检查 |
| 流消费 | `BlockingQueue.poll(30s)` 带超时的阻塞读取，pattern matching for switch |
| 工具并行 | READ 类工具用 `Executors.newVirtualThreadPerTaskExecutor()` 并行，其他串行 |
| 权限交互 | `CompletableFuture`，5 分钟超时兜底，超时默认拒绝 |
| Plan Mode | 权限层拦截所有写操作 |
| 上下文保护 | 工具输出截断后再写入对话历史 |
| 错误恢复 | 上下文过长自动压缩（最多 3 次）+ 速率限制等待重试 |
| max\_tokens 恢复 | 两阶段：先提升上限，再分段续写（最多 3 次） |
