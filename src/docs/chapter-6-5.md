# Java源码解析：五层权限防御链

派大星 6月12日修改

> 理论篇讲了权限系统的四层防御和权限模式矩阵，这篇带你走读 Java 版 MewCode 的真实代码，看看整个权限系统是怎么用一个 343 行的文件搞定的。

## 模块概览

权限系统的代码集中在两个文件里：

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `PermissionChecker.java` | 343 | 核心。所有检查逻辑、规则加载、危险命令检测、路径沙箱、模式矩阵代理 |
| `PermissionMode.java` | 33 | 权限模式枚举和模式矩阵（嵌套 switch） |

Java 版把大部分逻辑收在了 `PermissionChecker.java` 一个文件里。Java 的内嵌类型（inner record、inner enum）让一个文件能干净地容纳多个相关类型，不需要拆文件来保持可读性。CheckResult、PermissionRule、RuleEffect 都定义为内嵌类型，和 PermissionChecker 放在一起，代码高度内聚。

## 核心类型

### CheckResult：检查结果

```java
public record CheckResult(
    PermissionMode.Decision decision,
    String reason
) {
    public static CheckResult allow() {
        return new CheckResult(
            PermissionMode.Decision.ALLOW, "");
    }
    public static CheckResult deny(String reason) {
        return new CheckResult(
            PermissionMode.Decision.DENY, reason);
    }
    public static CheckResult ask() {
        return new CheckResult(
            PermissionMode.Decision.ASK, "");
    }
}
```

`CheckResult` 是 PermissionChecker 的内嵌 record。三个静态工厂方法 `allow()` 、 `deny()` 、 `ask()` 是语法糖，让调用方写 `CheckResult.allow()` 而不是 `new CheckResult(Decision.ALLOW, "")` ，更简洁也更不容易传错参数。

`allow()` 和 `ask()` 的 reason 是空字符串，因为允许和询问不需要解释原因。只有 `deny()` 需要传原因，告诉用户为什么被拒绝。这个区分让调用方的代码更简洁：大多数场景只需要 `CheckResult.allow()` 一行。

### PermissionMode：权限模式和模式矩阵

```java
public enum PermissionMode {
    DEFAULT,
    ACCEPT_EDITS,
    PLAN,
    BYPASS;

    public Decision decide(ToolCategory category) {
        return switch (this) {
            case DEFAULT -> switch (category) {
                case READ -> Decision.ALLOW;
                case WRITE, COMMAND -> Decision.ASK;
            };
            case ACCEPT_EDITS -> switch (category) {
                case READ, WRITE -> Decision.ALLOW;
                case COMMAND -> Decision.ASK;
            };
            case PLAN -> DEFAULT.decide(category);
            case BYPASS -> Decision.ALLOW;
        };
    }

    public enum Decision {
        ALLOW, DENY, ASK
    }
}
```

模式矩阵用嵌套 switch expression 实现。Java 的 switch 有编译期穷举检查，加了新的 PermissionMode 或 ToolCategory 但忘了处理某个分支，编译器会报错。这个特性在维护时特别有价值：需求变更加了新的模式或工具分类，编译器会强制你处理所有组合。

`decide()` 方法直接定义在 enum 上，这是 Java enum 的强大之处：enum 不只是一组常量，它可以有方法和行为。模式和决策逻辑放在一起，调用方只需要 `mode.decide(category)` 一行就能得到决策结果。

四种模式覆盖了最常见的使用场景。BYPASS 直接返回 `Decision.ALLOW` ，不需要 switch category，因为全部放行。DEFAULT 模式是最严格的：只读操作自动放行，写和命令都需要确认。ACCEPT\_EDITS 多放行了写操作，适合信任 LLM 做文件修改的场景。注意 PLAN 模式直接委托给 `DEFAULT.decide()` ，意味着 write 和 command 返回的是 `ASK` 而不是 `DENY` 。Plan 模式的真正只读限制来自 Layer 0（ `PLAN_MODE_ALLOWED_TOOLS` 白名单 + 计划文件写入放行），不是来自模式矩阵。

### PermissionRule：规则定义

```java
private record PermissionRule(
    String toolName,
    String pattern,
    RuleEffect effect
) {
    boolean matches(
        String toolName, String content
    ) {
        if (!this.toolName.equals(toolName)) {
            return false;
        }
        PathMatcher matcher =
            FileSystems.getDefault()
                .getPathMatcher("glob:" + pattern);
        try {
            return matcher.matches(Path.of(content));
        } catch (Exception e) {
            return content.equals(pattern);
        }
    }
}

private enum RuleEffect {
    ALLOW, DENY
}
```

`PermissionRule` 是 private 内嵌 record，外部不可见。 `matches()` 方法用 `java.nio.file.PathMatcher` 做 glob 匹配，这是 JDK 原生的路径通配符实现，支持 `*` 、 `**` 、 `?` 等通配符。

`PathMatcher` 的 glob 语法比 fnmatch 更严格，它要求内容能被解析为合法路径。如果解析失败（比如内容不是路径而是命令字符串），就退到精确匹配 `content.equals(pattern)` 。这个 fallback 确保了非路径类工具的规则也能工作。

## 主流程：check() 方法

### 内容提取

```java
private static final Map<String, String>
    CONTENT_FIELDS = Map.of(
    "Bash", "command",
    "ReadFile", "file_path",
    "WriteFile", "file_path",
    "EditFile", "file_path",
    "Glob", "pattern",
    "Grep", "pattern"
);

private static String extractContent(
    String toolName, Map<String, Object> args
) {
    String field = CONTENT_FIELDS.get(toolName);
    if (field == null) return null;
    var v = args.get(field);
    return v instanceof String s ? s : null;
}
```

`Map.of()` 是 Java 9 引入的不可变 Map 工厂方法，简洁但有个限制：最多 10 对键值对。 `CONTENT_FIELDS` 正好有 6 对，没问题。

`extractContent` 返回 `null` （而不是空字符串）表示「这个工具没有可提取的内容字段」。后续检查用 `content != null` 来判断是否需要做内容相关的检查。`null` 和空字符串有明确的语义区别：`null` 表示「不适用」，空字符串表示「适用但值为空」。

`v instanceof String s` 是 Java 16 的 pattern matching for instanceof，匹配成功后直接绑定为 `String s` ，不需要额外的类型转换。

### check() 方法：六层检查

```java
public CheckResult check(
    Tool tool, Map<String, Object> args
) {
    String toolName = tool.name();
    String content =
        extractContent(toolName, args);

    // Layer 0: Plan mode exceptions
    if (mode == PermissionMode.PLAN) {
        if (PLAN_MODE_ALLOWED_TOOLS
                .contains(toolName)) {
            return CheckResult.allow();
        }
        if ("WriteFile".equals(toolName)
            || "EditFile".equals(toolName)) {
            String path =
                stringArg(args, "file_path", "");
            if (path.contains(".mewcode/plans/")) {
                return CheckResult.allow();
            }
        }
    }
```

Layer 0 是 Plan Mode 的例外处理，放在所有其他检查之前。

Layer 0 做了两件事：第一，Agent、ToolSearch、AskUserQuestion 这三个工具在 Plan Mode 下始终放行，因为它们是规划流程必需的。第二，写入 `.mewcode/plans/` 目录下的文件也始终放行，因为 Plan 文件就存在这个目录。

```java
private static final Set<String>
    PLAN_MODE_ALLOWED_TOOLS = Set.of(
    "Agent", "ToolSearch", "AskUserQuestion"
);
```

`Set.of()` 创建不可变 Set，查找复杂度 O(1)。用 Set 而不是 List，因为这里只关心「是否包含」，不关心顺序。

### Layer 1：安全命令自动放行

```java
if ("Bash".equals(toolName)
    && content != null
    && isSafeCommand(content)) {
    return CheckResult.allow();
}
```

安全命令白名单，匹配到的命令直接放行，不走后续检查。这一层的存在减少了用户被频繁打断确认的体验问题。

```java
private static final Set<String> SAFE_COMMANDS =
    Set.of(
    "ls", "dir", "pwd", "echo", "cat",
    "head", "tail", "wc",
    "find", "which", "whereis", "whoami",
    "hostname", "uname",
    "date", "cal", "uptime", "df", "du",
    "free", "env", "printenv",
    "file", "stat", "readlink", "realpath",
    "basename", "dirname",
    "sort", "uniq", "tr", "cut", "awk", "sed",
    "grep", "egrep", "fgrep",
    "diff", "comm", "tee", "xargs",
    "true", "false", "test",
    "git status", "git log", "git diff",
    "git show", "git branch",
    "git tag", "git remote", "git rev-parse",
    "git ls-files",
    "git blame", "git stash list",
    "go version", "go env",
    "node -v", "npm -v", "npx",
    "python --version", "pip list",
    "cargo --version", "rustc --version",
    "java -version", "java --version"
);
```

白名单覆盖了常用的只读命令、文本处理工具、版本查询命令。这些命令不会修改系统状态，自动放行能减少用户被频繁打断确认的体验问题。

```java
private boolean isSafeCommand(String command) {
    String trimmed = command.trim();
    if (trimmed.contains("|")
        || trimmed.contains(";")
        || trimmed.contains("&&")
        || trimmed.contains(">")
        || trimmed.contains("$(")
        || trimmed.contains("`")) {
        return false;
    }
    for (var safe : SAFE_COMMANDS) {
        if (trimmed.equals(safe)
            || trimmed.startsWith(safe + " ")) {
            return true;
        }
    }
    return false;
}
```

安全命令检测先排除所有包含管道、分号、重定向、命令替换的命令。这是因为 `ls | rm -rf /` 里虽然有 `ls` ，但管道后面跟了危险命令，不能放行。只有「纯净」的安全命令才自动通过。

`trimmed.startsWith(safe + " ")` 确保匹配的是完整的命令前缀而不是子串。比如 `ls` 能匹配 `ls -la` ，但不会匹配 `lsof` 。

### Layer 2：危险命令检测

```java
if ("Bash".equals(toolName)
    && content != null) {
    for (var pattern : DANGEROUS_PATTERNS) {
        if (pattern.matcher(content).find()) {
            return CheckResult.deny(
                "Dangerous command detected: "
                    + pattern.pattern());
        }
    }
}
```

```java
private static final List<Pattern>
    DANGEROUS_PATTERNS = List.of(
    Pattern.compile(
        "rm\s+-[a-z]*r[a-z]*f[a-z]*\s+/\s*$"),
    Pattern.compile("mkfs\."),
    Pattern.compile("dd\s+if=.*of=/dev/"),
    Pattern.compile("chmod\s+-R\s+777\s+/"),
    Pattern.compile(
        ":\(\)\{\s*:\|:&\s*\};:"),
    Pattern.compile(
        "curl\s+.*\|\s*(ba)?sh"),
    Pattern.compile(
        "wget\s+.*\|\s*(ba)?sh"),
    Pattern.compile(">\s*/dev/sd")
);
```

八条正则模式覆盖了最常见的危险操作。 `Pattern.compile()` 在类加载时就把正则编译好，后续匹配时不需要重复编译。 `List.of()` 创建不可变列表，保证模式列表不会被意外修改。

`pattern.matcher(content).find()` 是子串匹配。和 `matches()` 不同， `find()` 不要求整个字符串都匹配，只要有某个子串能匹配就返回 true。这很重要，因为危险命令可能出现在复合命令的任何位置。

### Layer 3：路径沙箱

```java
if (content != null
    && isPathTool(toolName)) {
    if (!isPathAllowed(content)) {
        return CheckResult.deny(
            "Path outside allowed sandbox: "
                + content);
    }
}

private boolean isPathTool(String toolName) {
    return "ReadFile".equals(toolName)
        || "WriteFile".equals(toolName)
        || "EditFile".equals(toolName);
}
```

`isPathTool` 硬编码了三个文件工具。这种硬编码的做法更直接，但加新的文件工具时要记得更新这个方法。如果忘了更新，新的文件工具就不会受路径沙箱的保护。

```java
private boolean isPathAllowed(String pathStr) {
    try {
        Path p = Path.of(pathStr)
            .toAbsolutePath().normalize();
        Path root = projectRoot
            .toAbsolutePath().normalize();
        Path tmp = Path.of("/tmp")
            .toAbsolutePath().normalize();
        return p.startsWith(root)
            || p.startsWith(tmp);
    } catch (Exception e) {
        return true;
    }
}
```

沙箱实现简洁明了：转成绝对路径、normalize（消除 `..` 和 `.` ）、用 `startsWith` 检查是否在项目目录或 `/tmp` 下。

`normalize()` 消除了路径中的 `..` 和 `.` ，但不解析符号链接。这意味着如果 `/tmp/evil` 是一个指向 `/etc` 的符号链接， `normalize` 不会发现这个间接引用。如果需要更严格的安全保证，可以用 `toRealPath()` 来解析符号链接。

异常时返回 `true` （放行）而不是 `false` （拒绝），这是「fail open」的策略。fail open 避免了路径解析异常导致正常操作被阻断。在安全系统里通常 fail closed 更安全，但 Java 版选择了 fail open，认为路径解析异常是小概率事件，误拒绝正常操作的代价更高。

### Layer 4：规则引擎

```java
if (content != null) {
    for (int i = fileRules.size() - 1;
         i >= 0; i--) {
        PermissionRule rule = fileRules.get(i);
        if (rule.matches(toolName, content)) {
            return switch (rule.effect) {
                case ALLOW ->
                    CheckResult.allow();
                case DENY ->
                    CheckResult.deny(
                        "Denied by rule: "
                        + rule.toolName
                        + "(" + rule.pattern
                        + ")");
            };
        }
    }
}
```

反向遍历规则列表，最后一条匹配的规则胜出。 `switch` expression 直接在匹配到的规则上做 allow/deny 分发。

规则列表是扁平的（所有层的规则合并成一个 `ArrayList` ）。加载顺序决定优先级：用户级最先加载排在前面，本地级最后加载排在后面。反向遍历时本地级先被检查到，所以本地级优先级最高。这跟 Claude Code 一致：越具体、越靠近当前项目的配置优先级越高。另外 deny 规则跨层合并不可翻转，任何一层的 deny 都不能被其他层的 allow 盖掉。

### Layer 4b：Session 级别的始终允许

```java
if (allowAlwaysRules.contains(
    toolName + ":" + content)) {
    return CheckResult.allow();
}
```

Java 版维护了一个 `Set<String>` ，当用户点击「始终允许」时，把 `toolName + ":" + content` 加进去。后续相同的工具调用直接放行，不再弹窗。

这是一个 session 级别的记忆，程序退出就丢失。和持久化到 YAML 文件的规则不同，这些「始终允许」只在当前会话有效。

### Layer 5：模式矩阵兜底

```java
var decision = mode.decide(tool.category());
return switch (decision) {
    case ALLOW -> CheckResult.allow();
    case DENY -> CheckResult.deny(
        "Denied by permission mode: " + mode);
    case ASK -> CheckResult.ask();
};
```

如果前面所有层都没有产生明确的决策，就用权限模式矩阵兜底。 `mode.decide()` 是 PermissionMode enum 上的方法，直接调用。enum 本身就承载了「当前是哪种模式」的信息，所以不需要额外传参数。

## 规则加载

### 三层规则文件

```java
private List<PermissionRule> loadRules() {
    var rules = new ArrayList<PermissionRule>();

    Path userHome =
        Path.of(System.getProperty("user.home"));
    Path userFile = userHome
        .resolve(".mewcode")
        .resolve("permissions.yaml");
    rules.addAll(loadRulesFile(userFile));

    if (projectRoot != null) {
        Path projectFile = projectRoot
            .resolve(".mewcode")
            .resolve("permissions.yaml");
        rules.addAll(loadRulesFile(projectFile));

        Path localFile = projectRoot
            .resolve(".mewcode")
            .resolve("permissions.local.yaml");
        rules.addAll(loadRulesFile(localFile));
    }

    return new ArrayList<>(rules);
}
```

加载顺序：用户级 → 项目级 → 本地级。 `addAll` 把每一层的规则追加到同一个列表里，合并成一个扁平列表。

`new ArrayList<>(rules)` 返回的是一个新列表，不是原始列表的引用。这确保了 `loadRules()` 的返回值可以被安全修改，不会影响内部状态。

### YAML 解析

```java
@SuppressWarnings("unchecked")
private List<PermissionRule> loadRulesFile(
    Path path
) {
    if (!Files.exists(path)) {
        return List.of();
    }

    String content;
    try {
        content = Files.readString(path);
    } catch (IOException e) {
        return List.of();
    }

    Yaml yaml = new Yaml();
    Object parsed;
    try {
        parsed = yaml.load(content);
    } catch (Exception e) {
        return List.of();
    }

    if (!(parsed instanceof List<?> entries)) {
        return List.of();
    }
```

Java 版用 SnakeYAML 库解析 YAML。 `yaml.load()` 返回 `Object` ，需要手动检查类型。 `parsed instanceof List<?> entries` 是 pattern matching，如果类型匹配就直接绑定为 `entries` 。

```java
var rules = new ArrayList<PermissionRule>();
    for (Object entry : entries) {
        if (!(entry instanceof Map<?, ?> map)) {
            continue;
        }
        Object ruleObj = map.get("rule");
        Object effectObj = map.get("effect");
        if (!(ruleObj instanceof String ruleStr)
            || !(effectObj
                instanceof String effectStr)) {
            continue;
        }

        RuleEffect effect;
        if ("allow".equals(effectStr)) {
            effect = RuleEffect.ALLOW;
        } else if ("deny".equals(effectStr)) {
            effect = RuleEffect.DENY;
        } else {
            continue;
        }

        Matcher m = RULE_PATTERN
            .matcher(ruleStr.trim());
        if (!m.matches()) {
            continue;
        }
        rules.add(new PermissionRule(
            m.group(1), m.group(2), effect));
    }
    return rules;
}
```

`RULE_PATTERN` 是 `Pattern.compile("^(\w+)\((.+)\)$")` ，匹配 `Bash(git *)` 这样的语法。 `m.group(1)` 是工具名， `m.group(2)` 是通配符模式。

容错策略很宽松：文件不存在、读取失败、解析失败、格式不对的条目，全部静默忽略。一条坏规则不会影响其他规则的加载和生效。

### 动态追加规则

```java
public void appendLocalRule(
    String toolName, String pattern
) {
    if (projectRoot == null) return;
    Path localFile = projectRoot
        .resolve(".mewcode")
        .resolve("permissions.local.yaml");
    try {
        Files.createDirectories(
            localFile.getParent());
        var rules = new ArrayList<>(
            loadRulesFile(localFile));
        rules.add(new PermissionRule(
            toolName, pattern, RuleEffect.ALLOW));

        var entries =
            new ArrayList<Map<String, String>>();
        for (var r : rules) {
            entries.add(Map.of(
                "rule",
                r.toolName + "(" + r.pattern + ")",
                "effect",
                r.effect == RuleEffect.ALLOW
                    ? "allow" : "deny"));
        }
        var yaml = new Yaml();
        Files.writeString(localFile,
            yaml.dump(entries));
        fileRules.clear();
        fileRules.addAll(loadRules());
    } catch (IOException ignored) {}
}
```

追加后立即重新加载所有规则。 `fileRules.clear()` + `fileRules.addAll(loadRules())` 保证内存中的规则列表和文件同步。

规则缓存在内存里，避免每次 check 都做文件 IO，性能更好。代价是手动修改规则文件后需要重启程序才能生效。 `appendLocalRule` 方法通过「写文件 + 重新加载」保证了通过 API 追加的规则立即生效。

## 工具描述

```java
public String describeToolAction(
    String toolName, Map<String, Object> args
) {
    return switch (toolName) {
        case "Bash" -> "Execute: "
            + stringArg(args, "command", "");
        case "ReadFile" -> "Read: "
            + stringArg(args, "file_path", "");
        case "WriteFile" -> "Write: "
            + stringArg(args, "file_path", "");
        case "EditFile" -> "Edit: "
            + stringArg(args, "file_path", "");
        case "Glob" -> "Glob: "
            + stringArg(args, "pattern", "");
        case "Grep" -> "Grep: "
            + stringArg(args, "pattern", "");
        default -> toolName;
    };
}
```

这个方法不参与权限判断，是给 UI 层用的。当需要弹窗让用户确认时，这个方法生成一行人类可读的描述，比如「Execute: git push origin main」。放在 PermissionChecker 里是因为它和权限检查共享 `extractContent` 的逻辑，避免重复代码。

## 小结

| 设计决策 | Java 的实现方式 |
| --- | --- |
| 决策结果 | `record CheckResult` + 三个静态工厂方法 |
| 权限模式 | `enum PermissionMode` ， `decide()` 方法用嵌套 switch |
| 模式矩阵 | 编译期穷举检查，漏处理分支编译报错 |
| 安全命令 | `Set<String>` 白名单 + 管道/重定向排除 |
| 危险命令 | `Pattern.compile()` 预编译， `matcher.find()` 子串匹配 |
| 路径沙箱 | `Path.normalize()` + `startsWith()` ，fail open 策略 |
| 规则语法 | `PathMatcher` glob 匹配，异常时回退到精确匹配 |
| 规则缓存 | 内存缓存 `ArrayList` ，追加后显式重新加载 |
| Session 记忆 | `Set<String> allowAlwaysRules` ，当前会话有效 |
| Plan Mode | Layer 0 独立处理，白名单 + 计划目录例外 |
| 单文件设计 | 内嵌 record/enum，一个文件容纳全部类型和逻辑 |
