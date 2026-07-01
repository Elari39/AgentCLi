# Java源码解析：命令注册与分发

派大星 6月12日 13:20

> 理论篇讲了 Slash Command 的设计思路，这篇走读 Java 版 MewCode 的实现。Java 版把命令系统浓缩到三个文件里，所有命令都用匿名函数内联注册，风格紧凑。

## 模块概览

命令系统的代码在 `com.mewcode.command` 包下，一共三个文件：

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `Command.java` | 46 | 命令定义：record + 匹配方法 |
| `CommandContext.java` | 22 | 运行时上下文：传给 handler 的参数包 |
| `CommandRegistry.java` | 282 | 核心：注册中心 + 所有内置命令的 handler 实现 |

282 行的 `CommandRegistry` 包含了注册表逻辑和所有内置命令的实现。所有命令全部内联在一个文件里。好处是打开一个文件就能看到全部命令的定义和实现，坏处是文件比较长。对于当前十来个命令的规模，内联方式完全够用。

## 核心类型

### Command：用 record 定义

```java
public record Command(
    String name,
    String description,
    String[] aliases,
    CommandType type,
    boolean hidden
) {
    public enum CommandType {
        LOCAL,
        LOCAL_UI,
        PROMPT
    }
}
```

Java 版的 `Command` 有一个关键设计：没有 `handler` 字段。`handler` 存在 `CommandRegistry` 的 `handlers` Map 里，和命令定义是分开的。这种分离让 `Command` record 保持纯粹的数据定义，`handler` 的注册和查找由 Registry 统一管理。

`CommandType` 作为内部枚举定义在 `Command` 里面。三种类型各有不同的处理方式： `LOCAL` 是纯本地逻辑，handler 返回文本直接展示； `LOCAL_UI` 涉及 TUI 状态变化，由 TUI 层直接处理； `PROMPT` 生成文本发给 LLM，触发 Agent 执行。

### 命令匹配

```java
public boolean matches(String input) {
    if (name.equals(input)) {
        return true;
    }
    for (var alias : aliases) {
        if (alias.equals(input)) {
            return true;
        }
    }
    return false;
}
```

精确匹配命令名或任意别名。注意是 `equals` （大小写敏感）。大小写不敏感的匹配放在了 `search` 方法里，用于自动补全场景。

### CommandContext：函数式的上下文

```java
public record CommandContext(
    String args,
    String workDir,
    String model,
    Supplier<String> permissionMode,
    IntSupplier toolCount,
    Supplier<int[]> tokenCount,
    Supplier<List<String>> memoryList,
    Runnable memoryClear,
    Supplier<String> sessionInfo,
    Supplier<List<String>> skillList
) {}
```

这个设计很有特色。用 `Supplier<T>` 和 `Runnable` 把能力包装成函数接口，而不是直接传对象引用。

`Supplier<String> permissionMode` 不是直接传一个字符串，而是传一个「获取字符串」的函数。好处是惰性求值：如果某个命令不需要权限模式信息，就不会触发获取操作。同时这也是一种解耦手段： `CommandContext` 不依赖 `Agent` 类，只依赖 `java.util.function` 里的标准接口。

`Supplier<int[]> tokenCount` 返回一个两元素数组 `[input, output]` 。用数组代替 tuple 虽然不够优雅但足够实用。如果后续需要更多字段，可以改成 record。

## 主流程：parse → find → dispatch

### 注册中心

```java
public class CommandRegistry {
    private final List<Command> commands = new ArrayList<>();
    private final Map<String, Function<CommandContext, String>> handlers = new HashMap<>();

    public void register(Command cmd, Function<CommandContext, String> handler) {
        commands.add(cmd);
        if (handler != null) {
            handlers.put(cmd.name(), handler);
            for (var alias : cmd.aliases()) handlers.put(alias, handler);
        }
    }
```

`register` 方法把命令和 `handler` 分开存储。命令定义存到 `commands` 列表里用于展示和搜索，`handler` 存到 `handlers` Map 里用于执行。 `handler` 可以是 `null` ，对应 `LOCAL_UI` 类型的命令（如 `/clear` 、 `/plan` ），这些命令由 TUI 层直接处理，不需要文本输出。

注意 handler 同时注册到命令名和所有别名上。这样查找时不需要先解析别名再查命令名，直接一次 `Map.get()` 就行。

### 查找

```java
public Optional<Command> find(String name) {
    return commands.stream()
        .filter(c -> c.matches(name))
        .findFirst();
}
```

用 Stream API 遍历所有命令，调用 `matches()` 方法做精确匹配。返回 `Optional<Command>` 而不是可能为 null 的 `Command` ，强制调用方处理「找不到」的情况。

### 搜索（前缀匹配）

```java
public List<Command> search(String prefix) {
    String lower = prefix.toLowerCase(Locale.ROOT);
    return commands.stream()
        .filter(c -> !c.hidden())
        .filter(c -> c.name().toLowerCase(Locale.ROOT).startsWith(lower)
            || Arrays.stream(c.aliases())
                .anyMatch(a -> a.toLowerCase(Locale.ROOT).startsWith(lower)))
        .sorted(Comparator.comparing(Command::name))
        .collect(Collectors.toList());
}
```

用于自动补全。和 `find` 的精确匹配不同， `search` 用前缀匹配，而且大小写不敏感（ `Locale.ROOT` 保证了语言无关的小写转换）。结果按命令名排序。

这里用 `Locale.ROOT` 而不是默认 locale 是一个好习惯。在土耳其语 locale 下， `"I".toLowerCase()` 会变成 `"ı"` 而不是 `"i"` ，可能导致匹配失败。

### 执行

```java
public String execute(String name, CommandContext ctx) {
    var handler = handlers.get(name);
    if (handler != null) return handler.apply(ctx);
    // 名字直接查不到，尝试通过 find 走别名匹配
    var cmd = find(name);
    if (cmd.isEmpty()) return "Unknown command: " + name;
    handler = handlers.get(cmd.get().name());
    if (handler != null) return handler.apply(ctx);
    return "No handler registered for /" + name;
}
```

执行逻辑分两步。先直接用名字查 handler（覆盖了别名的情况），找不到再通过 `find` 找到命令对象，用命令的主名字再查一次 handler。两次查找是因为 handler Map 里可能只注册了主名字，没有注册别名（虽然当前的 `register` 方法会同时注册，但这提供了容错能力）。

Java 版的 handler 返回 `String` 。这意味着命令不能直接操作 UI，只能返回文本让调用方去展示。对于 `LOCAL_UI` 类型的命令，handler 为 `null` ，TUI 层自己处理。这种设计把「数据生成」和「UI 渲染」完全分开，命令层只负责产生文本。

## 内置命令速览

| 命令 | 别名 | 类型 | 职责 |
| --- | --- | --- | --- |
| `/help` | `/h` , `/?` | `LOCAL` | 帮助信息，支持 `/help <cmd>` |
| `/clear` |  | `LOCAL_UI` | 清除对话 |
| `/compact` | `/c` | `LOCAL_UI` | 压缩上下文 |
| `/status` | `/s` | `LOCAL` | 显示状态 |
| `/memory` |  | `LOCAL` | 记忆管理（list/clear） |
| `/plan` | `/p` | `LOCAL_UI` | 切换 Plan 模式 |
| `/do` |  | `LOCAL_UI` | 切换执行模式 |
| `/session` |  | `LOCAL` | 会话管理 |
| `/permission` | `/perm` | `LOCAL` | 权限管理 |
| `/resume` | `/r` | `LOCAL_UI` | 恢复上次会话 |
| `/skills` |  | `LOCAL` | 列出已安装 Skill |
| `/review` |  | `PROMPT` | 审查代码变更 |

## 典型命令实现走读

### /help：内联 lambda 的典型例子

```java
register(new Command("help", "Show available commands",
        new String[]{"h", "?"}, CommandType.LOCAL, false),
    ctx -> {
        if (ctx.args() != null && !ctx.args().isBlank()) {
            var target = find(ctx.args().strip());
            if (target.isEmpty()) return "Unknown command: " + ctx.args();
            return "/" + target.get().name() + " — " + target.get().description();
        }
        var sb = new StringBuilder("Available commands:\n\n");
        for (var cmd : listVisible())
            sb.append("  /").append(cmd.name()).append(" ").append(cmd.description()).append("\n");
        return sb.toString();
    });
```

整个 handler 是一个 lambda 表达式，直接写在 `register` 调用里。定义和注册在同一个位置，一目了然。缺点是 `registerDefaults()` 方法变得很长（282 行的 `CommandRegistry` 大部分都是这些内联 handler），但好处是不需要在多个文件之间跳转来理解一个命令的完整行为。

### /status：Supplier 的惰性求值

```java
register(
    new Command("status", "Show current status",
        new String[]{"s"}, CommandType.LOCAL, false),
    ctx -> {
        var sb = new StringBuilder("MewCode Status\n──────────────\n");
        sb.append("  Mode:      ").append(ctx.permissionMode().get()).append("\n");
        int[] tokens = ctx.tokenCount().get();
        sb.append("  Tokens:    ").append(tokens[0]).append(" / ").append(tokens[1]).append("\n");
        sb.append("  Tools:     ").append(ctx.toolCount().getAsInt()).append("\n");
        sb.append("  Memories:  ").append(ctx.memoryList().get().size()).append("\n");
        sb.append("  Model:     ").append(ctx.model()).append("\n");
        return sb.toString();
    }
);
```

`ctx.permissionMode().get()` 是 `Supplier<String>` 的调用。如果这个命令不需要权限信息（比如某个未来的变体），就不调用 `.get()` ，获取操作就不会发生。这就是 `Supplier` 的惰性求值优势：只在真正需要时才执行获取逻辑。

### /memory：switch 表达式

```java
ctx -> {
    String sub = /* 从 args 解析子命令，默认 "list" */;
    return switch (sub) {
        case "list" -> {
            var memories = ctx.memoryList().get();
            if (memories.isEmpty()) yield "No memories stored yet.";
            var sb = new StringBuilder("Auto-memories (%d):\n".formatted(memories.size()));
            for (var m : memories) sb.append("  • ").append(m).append("\n");
            yield sb.toString();
        }
        case "clear" -> { ctx.memoryClear().run(); yield "All auto-memories cleared."; }
        default -> "Usage: /memory [list|clear]";
    };
}
```

Java 14 的 switch 表达式比传统 switch 简洁得多。每个 case 用 `yield` 返回值，整个 switch 的结果就是 handler 的返回值。switch 表达式的穷举检查能在编译期捕获遗漏的分支，比 if-elif-else 链更安全。

`"\\s+", 2` 中的 `2` 是 split 的 limit 参数，含义是「结果数组的最大长度」。所以 `"/memory list".split("\\s+", 2)` 会得到 `["/memory", "list"]` ，最多两段。

### /review：PROMPT 命令的模式

```java
register(
    new Command("review", "Review current code changes",
        new String[]{}, CommandType.PROMPT, false),
    ctx -> {
        String prompt = "Please review the current git diff. "
            + "Focus on: logic errors, security, performance, style.";
        if (ctx.args() != null && !ctx.args().isBlank())
            prompt += "\n\nAdditional focus: " + ctx.args().strip();
        return prompt;
    }
);
```

`PROMPT` 类型命令的 handler 返回的不是展示文本，而是要发给 LLM 的 prompt。调用方会根据命令的 `type` 决定怎么处理返回值： `LOCAL` 类型的返回值直接展示， `PROMPT` 类型的返回值发给 LLM。

### LOCAL\_UI 命令：handler 为 null

```java
register(
    new Command("clear",
        "Clear conversation and start fresh",
        new String[]{}, CommandType.LOCAL_UI, false),
    null
);

register(
    new Command("plan",
        "Switch to plan mode (read-only)",
        new String[]{"p"}, CommandType.LOCAL_UI, false),
    null
);
```

`/clear` 、 `/compact` 、 `/plan` 、 `/do` 、 `/resume` 这些 `LOCAL_UI` 命令的 handler 都是 `null` 。TUI 层发现命令类型是 `LOCAL_UI` 时，不调用 `execute()` ，而是直接根据命令名做对应的 UI 操作（清屏、切换模式等）。

TUI 层发现命令类型是 `LOCAL_UI` 时，不调用 `execute()` ，而是直接根据命令名做对应的 UI 操作（清屏、切换模式等）。命令层和 UI 层的职责完全分离。

## 架构总结

Java 版采用「集中式」架构。所有命令在一个文件里定义和注册，handler 只能通过 `CommandContext` 暴露的函数式接口访问有限的能力。LOCAL\_UI 命令甚至没有 handler，完全由 TUI 层处理。

这种设计约束更强，但也更容易推理：看 `CommandContext` 的定义就知道 handler 能做什么、不能做什么。 `Supplier` 和 `Runnable` 接口明确了边界：handler 能读取状态（通过 `Supplier`）、能触发特定操作（通过 `Runnable`），但不能随意修改全局状态。

## 小结

| 设计决策 | Java 的实现方式 |
| --- | --- |
| 命令定义 | `record` ，handler 不绑定在命令上 |
| handler 签名 | `Function<CommandContext, String>` 同步返回文本 |
| 上下文 | `Supplier` / `Runnable` 函数式接口，惰性求值 |
| 文件组织 | 单文件 282 行，内联 lambda |
| `LOCAL_UI` | handler 为 null，TUI 层直接处理 |
| 搜索匹配 | `Locale.ROOT` 保证语言无关的大小写转换 |
| 返回值 | 返回 String，调用方决定展示方式 |
| 命令类型 | LOCAL / LOCAL\_UI / PROMPT 三种，各有不同处理路径 |
