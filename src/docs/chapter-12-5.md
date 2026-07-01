# Java源码解析：事件钩子与条件匹配

派大星 6月12日修改

> 理论篇讲了 Hook 系统的设计理念，这篇走读 Java 版的 Hook 系统。所有逻辑压缩到了一个 215 行的 `HookEngine.java` 里，看看「全部塞进一个类」的实现风格是怎么做到既紧凑又清晰的。

## 模块概览

Java 版 Hook 系统只有一个文件：

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `HookEngine.java` | 215 | 全部。事件枚举、数据类型、条件匹配、动作执行、通知管理 |

Java 版用 record 和内部枚举把所有东西打包在一个类里。这不是偷懒，而是 Java 21 的 record 语法让数据类定义非常紧凑（五个核心类型只占五行），单文件反而更容易通读。

## 核心类型

### 事件和动作的枚举

```java
public enum EventName {
    SESSION_START("session_start"),
    SESSION_END("session_end"),
    TURN_START("turn_start"),  TURN_END("turn_end"),
    PRE_SEND("pre_send"),      POST_RECEIVE("post_receive"),
    PRE_TOOL_USE("pre_tool_use"),
    POST_TOOL_USE("post_tool_use"),
    SHUTDOWN("shutdown");

    private final String value;
    EventName(String value) { this.value = value; }
    public String value() { return value; }
}
```

9 种事件覆盖了 Agent Loop 运行过程中最核心的生命周期节点：会话的开始和结束、轮次的开始和结束、LLM 调用前后、工具使用前后、关闭。

动作类型也更精简：

```java
public enum ActionType {
    COMMAND("command"),
    SCRIPT("script"),
    PROMPT("prompt");

    private final String value;
    ActionType(String value) { this.value = value; }
    public String value() { return value; }
}
```

三种动作类型。 `command` 执行 shell 命令， `prompt` 返回文本消息， `script` 预留给脚本执行但目前和 `command` 的行为类似。

### Record 定义的数据类型

Java 21 的 record 让数据类定义极其紧凑，五个核心类型只用了五行：

```java
public record Action(ActionType type, String command, String message) {}

public record Hook(String id, EventName event, String condition,
                   Action action, boolean reject) {}

public record HookContext(EventName event, String toolName,
                          Map<String, Object> toolArgs,
                          String filePath, String message,
                          String error) {}

public record HookResult(String hookId, String output,
                         boolean success, boolean reject) {}

public record PreToolResult(boolean rejected, String message) {}
```

Java 版的 Hook 结构很精简。所有 Hook 都是同步执行的，没有「只跑一次」语义，也没有异步执行选项。这些简化保持了实现的清晰性，绝大多数 Hook 场景（如 lint 检查、日志记录）用同步执行就够了。

`Hook.condition` 存储的是原始字符串而不是预解析的 AST。这意味着每次匹配时都要实时解析条件表达式。对于 Hook 的执行频率（每轮最多几次）来说，解析开销可以忽略不计，但实现上简单了很多。

## 主流程：runHooks vs runPreToolHooks

### 通用事件触发

```java
public List<HookResult> runHooks(HookContext ctx) {
    List<HookResult> results = new ArrayList<>();
    for (Hook h : hooks) {
        if (h.event() != ctx.event()) continue;
        if (h.condition() != null && !h.condition().isEmpty()
                && !evaluateCondition(h.condition(), ctx))
            continue;
        HookResult result = executeAction(h, ctx);
        results.add(result);
        notifications.add(result);
    }
    return results;
}
```

结构清晰：遍历所有 Hook，按事件名过滤，检查条件，执行动作，收集结果。同步执行，直接返回结果列表。循环体只有三个步骤（事件匹配、条件检查、执行动作），逻辑非常直接。

`notifications.add(result)` 把每次执行的结果都收集起来，后续可以通过 `drainNotifications()` 统一获取。

### 工具拦截

```java
public PreToolResult runPreToolHooks(String toolName, Map<String, Object> args) {
    HookContext ctx = new HookContext(
        EventName.PRE_TOOL_USE, toolName, args, null, null, null);
    for (Hook h : hooks) {
        if (h.event() != EventName.PRE_TOOL_USE) continue;
        if (h.condition() != null && !h.condition().isEmpty()
                && !evaluateCondition(h.condition(), ctx)) continue;
        if (h.reject()) {
            HookResult result = executeAction(h, ctx);
            return new PreToolResult(true, result.output());
        }
    }
    return new PreToolResult(false, "");
}
```

这个方法有两个值得注意的设计。

第一个是 HookContext 的构造。在方法内部从 toolName 和 args 构造 HookContext，调用方只需要传两个参数，更简洁。

第二个是返回值。返回 `PreToolResult` record，用 `rejected` 布尔字段表达拒绝语义。碰到第一个匹配的 reject Hook 就执行 action 然后立即返回拒绝结果，不会继续检查后续的 Hook。这种「first match wins」的策略简单明了。

## 条件匹配

Java 版的条件匹配在每次调用时实时解析字符串，而不是预先解析成 AST：

```java
private boolean evaluateCondition(String condition, HookContext ctx) {
    String cond = condition.strip();
    if (cond.contains("==")) {
        String[] parts = cond.split("==", 2);
        return resolveVar(parts[0].strip(), ctx)
            .equals(stripQuotes(parts[1].strip()));
    }
    if (cond.contains("=~")) {
        String[] parts = cond.split("=~", 2);
        return Pattern.matches(stripQuotes(parts[1].strip()),
            resolveVar(parts[0].strip(), ctx));
    }
    return true;
}
```

只支持 `==` （精确匹配）和 `=~` （正则匹配）两种运算符。不支持 `&&` 和 `||` 组合条件。如果条件字符串里没有认识的运算符，直接返回 `true` （当作无条件匹配）。这种务实的设计覆盖了大部分 Hook 配置场景。

这个设计非常务实：大部分 Hook 配置要么不写条件，要么只写一个简单的 `tool==Bash` 或 `event=~pre_.*` 。复杂条件的需求不大，支持了反而增加了出 bug 的面积。

变量解析用 switch 表达式：

```java
private String resolveVar(String name, HookContext ctx) {
    return switch (name) {
        case "tool"  -> ctx.toolName() != null ? ctx.toolName() : "";
        case "event" -> ctx.event() != null ? ctx.event().value() : "";
        default -> {
            if (name.startsWith("args.") && ctx.toolArgs() != null) {
                Object v = ctx.toolArgs().get(name.substring(5));
                yield v != null ? String.valueOf(v) : "";
            }
            yield "";
        }
    };
}
```

Java 需要处理 null 值，每个分支都做了 null 检查。遇到 null 返回空字符串，确保后续的比较操作不会抛 `NullPointerException` 。防御性编程。

引号去除的处理很全面：

```java
private static String stripQuotes(String s) {
    if (s.length() >= 2) {
        char first = s.charAt(0);
        char last  = s.charAt(s.length() - 1);
        if ((first == '"' && last == '"')
                || (first == '\'' && last == '\'')
                || (first == '/' && last == '/')) {
            return s.substring(1, s.length() - 1);
        }
    }
    return s;
}
```

同时支持双引号、单引号和斜杠（正则模式）三种包裹方式。

## 动作执行器

### 动作分发

```java
private HookResult executeAction(Hook h, HookContext ctx) {
    return switch (h.action().type()) {
        case COMMAND -> executeCommand(h, ctx);
        case PROMPT  -> new HookResult(
            h.id(), h.action().message(), true, h.reject()
        );
        default -> new HookResult(
            h.id(),
            "Unknown action type: " + h.action().type().value(),
            false, false
        );
    };
}
```

用 switch 表达式做分发。 `PROMPT` 类型直接在 switch 分支里构造结果，因为它只需要返回消息文本，没有执行逻辑。 `COMMAND` 类型调用 `executeCommand` 方法启动子进程。

### Command 执行器

```java
private HookResult executeCommand(Hook h, HookContext ctx) {
    try {
        ProcessBuilder pb = new ProcessBuilder("bash", "-c", h.action().command());
        Map<String, String> env = pb.environment();
        env.put("MEWCODE_EVENT", ctx.event() != null ? ctx.event().value() : "");
        env.put("MEWCODE_TOOL", ctx.toolName() != null ? ctx.toolName() : "");
        pb.redirectErrorStream(false);
        Process proc = pb.start();
```

通过环境变量传递上下文，子进程里可以直接用 `$MEWCODE_TOOL` 。 `redirectErrorStream(false)` 让 stdout 和 stderr 分开读取。

```java
String stdout = new String(proc.getInputStream().readAllBytes()).strip();
        String stderr = new String(proc.getErrorStream().readAllBytes()).strip();
        int code = proc.waitFor();
        String output = stderr.isEmpty() ? stdout : stdout + "\n" + stderr;
        return new HookResult(h.id(), output, code == 0, h.reject());
    } catch (IOException | InterruptedException e) {
        if (e instanceof InterruptedException) Thread.currentThread().interrupt();
        return new HookResult(h.id(), "Failed: " + e.getMessage(), false, h.reject());
    }
}
```

有几个值得注意的设计细节。

第一，通过环境变量把上下文传给子进程（ `MEWCODE_EVENT` 、 `MEWCODE_TOOL` ）。shell 脚本里直接用 `$MEWCODE_TOOL` 就能拿到当前工具名，非常方便。

第二，分别读取 stdout 和 stderr（ `redirectErrorStream(false)` ），然后拼接。这保留了错误信息的区分能力，output 里先展示 stdout 再展示 stderr。

第三，没有超时控制。如果子进程挂起， `proc.waitFor()` 会无限阻塞。这是一个简化点，生产环境中建议补充 `waitFor(timeout, TimeUnit)` 的超时保护。

第四， `InterruptedException` 的处理很规范。Java 的线程中断协议要求：捕获 `InterruptedException` 后必须重新设置中断标志（ `Thread.currentThread().interrupt()` ），让调用方知道发生了中断。

## Hook 注册和通知

```java
private final List<Hook> hooks = new ArrayList<>();
private final List<HookResult> notifications = new ArrayList<>();

public void addHook(Hook hook) {
    hooks.add(hook);
}

public void loadHooks(List<Hook> hookList) {
    hooks.clear();
    hooks.addAll(hookList);
}
```

Hook 的注册有两种方式： `addHook` 逐个添加， `loadHooks` 批量替换。 `loadHooks` 会先 `clear` 再 `addAll` ，是全量替换语义。

通知的收集和消费：

```java
public List<HookResult> drainNotifications() {
    List<HookResult> result = List.copyOf(notifications);
    notifications.clear();
    return result;
}
```

经典的「取走就清空」模式。用 `List.copyOf` 创建不可变副本返回给调用方，避免外部修改影响内部状态。

这里有一个潜在的并发问题：如果多个线程同时调用 `runHooks` 和 `drainNotifications` ， `notifications` 列表的读写可能产生竞态。如果要在多线程环境使用，需要加 `synchronized` 或者换成 `CopyOnWriteArrayList` 。当前实现假设 Hook 的触发和通知消费在同一个线程上，这在大多数使用场景下成立。

## 小结

| 设计决策 | Java 的实现方式 |
| --- | --- |
| 文件组织 | 单文件 215 行，`record` + 内部枚举 |
| 数据类型 | 5 个 `record`，每个一行定义 |
| 事件种类 | 9 种核心生命周期事件 |
| 条件匹配 | 实时解析字符串，支持 `==` 和 `=~` |
| 动作类型 | `command`（执行命令）、`prompt`（返回文本） |
| 上下文传递 | 环境变量（`$MEWCODE_EVENT`、`$MEWCODE_TOOL`） |
| 执行模式 | 同步阻塞 |
| 拒绝语义 | `PreToolResult` `record`，`rejected` 布尔字段 |
| 通知机制 | `drainNotifications()` 取走并清空 |
| 变量解析 | `switch` 表达式，支持 `tool`、`event`、`args.*` |
