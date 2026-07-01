# Java源码解析：工具注册与执行框架

派大星 6月12日修改

> 理论篇讲了 Function Calling 的协议和工具接口设计，这篇带你走读 Java 版 MewCode 的工具系统代码，看看「注册 → 描述 → 执行」这条主线在 Java 里是怎么落地的。

## 模块概览

工具系统的代码分布在 `com.mewcode.tool` 包下，核心类型和实现分开放：

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `Tool.java` | 20 | 工具接口定义，含 `shouldDefer()` 默认方法 |
| `ToolResult.java` | 12 | record 类型的执行结果，带工厂方法 |
| `ToolCategory.java` | 5 | 枚举：READ / WRITE / COMMAND |
| `ToolRegistry.java` | 121 | 注册中心：LinkedHashMap 存储，延迟发现，协议适配 |
| `impl/BashTool.java` | 143 | Bash 工具，ProcessBuilder + 超时控制 |
| `impl/EditFileTool.java` | 117 | EditFile 工具，唯一性校验 + 手动计数 |
| `impl/ReadFileTool.java` | 116 | ReadFile 工具，offset/limit 分页 |
| `impl/WriteFileTool.java` | 102 | WriteFile 工具，POSIX 权限设置 |
| `impl/GlobTool.java` | 120 | Glob 工具，FileVisitor 遍历 |
| `impl/GrepTool.java` | 186 | Grep 工具，二进制检测 + 输出截断 |
| `impl/ToolSearchTool.java` | 154 | ToolSearch，延迟工具发现 |

十一个文件加起来约 1100 行。Java 的语法本身需要更多的模板代码（接口声明、getter/setter、类型标注等），但每个类的职责边界非常清晰，代码量多出来的部分大多是 Java 语言规范要求的模板代码，不是业务逻辑。

## 核心类型

### Tool 接口 + shouldDefer 默认方法

```
public interface Tool {
    String name();
    String description();
    ToolCategory category();
    Map<String, Object> schema();
    ToolResult execute(Map<String, Object> args);

    default boolean shouldDefer() {
        return false;
    }
}
```

五个抽象方法加一个默认方法，这是 Java 版最精炼的一个文件。Java 的 interface 可以带默认实现，所以 `shouldDefer()` 直接写在接口里，大多数工具不需要覆盖它。只有需要延迟加载的工具才覆盖 shouldDefer() 返回 `true` ，其余工具自动继承默认值 `false` 。这种 default method 的设计不需要额外的接口或继承层次，编译器就能保证类型安全。

`execute()` 的参数是 `Map<String, Object>` 。LLM 传来的 JSON 参数被 Jackson 反序列化成 Map，工具自己从里面取值。手动提取参数的好处是不依赖外部库做参数解析，每个工具用 `stringArg()` 和 `intArg()` 辅助方法从 Map 中安全地取值。

### ToolCategory 枚举

```
public enum ToolCategory {
    READ, WRITE, COMMAND
}
```

Java 用 enum 表示工具分类，类型约束非常强。enum 在编译期和运行期都保证只有 READ、WRITE、COMMAND 这三个合法值，传错了直接编译不过。后面用 switch 对 `ToolCategory` 做分发时，编译器会检查是否覆盖了所有分支，遗漏了会给警告。

### ToolResult：record + 工厂方法

```
public record ToolResult(String output, boolean isError) {

    public static ToolResult success(String output) {
        return new ToolResult(output, false);
    }

    public static ToolResult error(String message) {
        return new ToolResult(message, true);
    }
}
```

Java 16 引入的 record 类型在这里正好合适：ToolResult 是不可变的数据载体，record 自动生成构造函数、getter、equals、hashCode 和 toString。

两个静态工厂方法 `success()` 和 `error()` 让调用处的意图更清晰： `ToolResult.error("...")` 一眼就知道这是个失败结果，不需要去看第二个参数。直接调 `new ToolResult("...", true)` 的话，读代码的人得看第二个参数才知道是成功还是失败。工厂方法把这个认知负担消除了。

翻看所有工具实现就能发现，成功路径一律用 `ToolResult.success()` ，失败路径一律用 `ToolResult.error()` ，代码的一致性非常好。

### ToolRegistry：LinkedHashMap + 延迟发现

```
public class ToolRegistry {
    public static final int MAX_OUTPUT_CHARS = 10_000;

    private final Map<String, Tool> tools = new LinkedHashMap<>();
    private final Set<String> discoveredTools = new HashSet<>();
```

Java 版用 `LinkedHashMap` 而不是 HashMap ，这个选择很有讲究。 LinkedHashMap 保证遍历顺序和插入顺序一致。这意味着 `getAllSchemas()` 返回的工具列表每次都是同样的顺序：先 ReadFile，再 WriteFile，再 EditFile，以此类推。稳定的工具顺序对 LLM 的行为一致性很重要，如果每次请求工具列表的排列都不同，LLM 可能产生不一致的行为。用类型名 LinkedHashMap 就明确声明了「顺序很重要」这个意图。

`MAX_OUTPUT_CHARS` 定义在 Registry 上而不是某个具体工具上，因为多个工具（比如 Grep）都需要引用这个限制。

## 主流程走读

### 第一步：注册

`createDefault()` 是工具系统的启动入口：

```
public static ToolRegistry createDefault() {
    var reg = new ToolRegistry();
    reg.register(new ReadFileTool());
    reg.register(new WriteFileTool());
    reg.register(new EditFileTool());
    reg.register(new BashTool());
    reg.register(new GlobTool());
    reg.register(new GrepTool());
    return reg;
}
```

六个内置工具直接 new 出来注册进去。所有工具都是无状态的（没有实例字段），所以构造不需要任何参数。注册方法只有一行：

```
public void register(Tool tool) {
    tools.put(tool.name(), tool);
}
```

`LinkedHashMap.put()` 保证后注册的工具排在后面。如果同名工具重复注册，新的会覆盖旧的，这在 MCP 外部工具覆盖内置工具时有用。

### 第二步：生成 Schema

```
public List<Map<String, Object>> getAllSchemas(String protocol) {
    var schemas = new ArrayList<Map<String, Object>>();
    for (var tool : tools.values()) {
        if (tool.shouldDefer() && !discoveredTools.contains(tool.name()))
            continue;
        var base = tool.schema();
        if ("openai".equals(protocol)) {
            schemas.add(Map.of("type", "function", "name", base.get("name"),
                "parameters", base.get("input_schema")));
        } else {
            schemas.add(base);
        }
    }
    return schemas;
}
```

逻辑清晰：跳过未发现的延迟工具，根据 protocol 参数适配 Anthropic/OpenAI 两种 API 格式。

每个工具自己实现 `schema()` 方法返回 JSON Schema。以 EditFileTool 为例：

```
public Map<String, Object> schema() {
    return Map.of(
        "name", name(),
        "description", description(),
        "input_schema", Map.of(
            "type", "object",
            "properties", Map.of(
                "file_path", Map.of("type", "string", ...),
                "old_string", Map.of("type", "string", ...),
                "new_string", Map.of("type", "string", ...)
            ),
            "required", List.of("file_path", "old_string", "new_string")
        )
    );
}
```

Java 的 `Map.of()` 和 `List.of()` 创建不可变集合。这些 Schema 对象在工具注册后就不会变了，不可变性在这里是加分项。手写 Map 的方式虽然比框架自动生成更啰嗦，但不依赖任何额外的框架，每个字段的含义和约束一目了然。

### 第三步：执行

Agent Loop 通过 `registry.get(name)` 查找工具，然后调用 `execute(args)` 。Java 版的 `execute()` 是同步方法，直接返回 `ToolResult` 。如果 Agent Loop 需要并行执行多个工具，在调用层用虚拟线程池即可（第4章会详细讲）。

## 内置工具速览

| 工具 | Category | 核心逻辑 | Java 特有设计 |
| --- | --- | --- | --- |
| `ReadFile` | `READ` | 按行号范围读文件 | `Files.readString` + 手动 split |
| `WriteFile` | `WRITE` | 创建父目录 + 写入 | POSIX 权限设置 |
| `EditFile` | `WRITE` | 唯一性校验 + 精确替换 | 手写 `countOccurrences` 方法 |
| `Bash` | `COMMAND` | ProcessBuilder 执行命令 | 并发读 stdout/stderr |
| `Glob` | `READ` | FileVisitor 遍历 | `PathMatcher` 模式匹配 |
| `Grep` | `READ` | 正则搜索 | 二进制检测 + 输出截断 |

### 深入 EditFile：countOccurrences 手动搜索

EditFile 的执行流程是：读文件 → 校验唯一性 → 替换 → 写回。唯一性校验用了一个手写的计数方法：

```
private static int countOccurrences(
    String text, String sub
) {
    if (sub.isEmpty()) {
        return 0;
    }
    int count = 0;
    int idx = 0;
    while ((idx = text.indexOf(sub, idx)) != -1) {
        count++;
        idx += sub.length();
    }
    return count;
}
```

为什么不用 Java 标准库？因为 Java 的 `String` 类确实没有直接提供「计算子串出现次数」的方法。可以用正则或者 `split` 间接实现，但都不如这个简单的循环直接。

`indexOf(sub, idx)` 从位置 idx 开始往后找子串，找到后 `idx += sub.length()` 跳过已匹配的部分继续找下一个。这是非重叠计数，即 `aaa` 里找 aa 的结果是 1 次而不是 2 次。

调用处的逻辑很清晰：

```
int count = countOccurrences(content, oldStr);
if (count == 0) {
    return ToolResult.error(
        "Error: old_string not found in file"
    );
}
if (count > 1) {
    return ToolResult.error(
        "Error: old_string found " + count
        + " times, must be unique"
    );
}

String newContent = content.replace(oldStr, newStr);
```

注意 Java 的 `String.replace()` 默认替换所有出现。但因为前面已经校验了只出现一次，所以效果等同于只替换一次。这是一种依赖前置条件的写法：校验保证了只有一次出现，所以「替换所有」和「替换一次」等价。

### 深入 Bash：ProcessBuilder + 并发 IO

Bash 工具是 Java 版里最复杂的内置工具，因为 Java 的进程管理需要手动处理 stdout/stderr 流的读取和超时控制：

```
ProcessBuilder pb = new ProcessBuilder(
    "bash", "-c", command
);
pb.redirectErrorStream(false);
Process process = pb.start();
```

`ProcessBuilder` 是 Java 创建子进程的标准方式。 `redirectErrorStream(false)` 明确不合并 stdout 和 stderr，保持分开捕获。

接下来是 stdout/stderr 的读取：

```
String stdout;
String stderr;
try (InputStream stdoutStream = process.getInputStream();
     InputStream stderrStream = process.getErrorStream()) {
    byte[] stdoutBytes = stdoutStream.readAllBytes();
    stderr = new String(stderrStream.readAllBytes());
    stdout = new String(stdoutBytes);
}
```

这里有一个微妙的问题。 `readAllBytes()` 是阻塞调用，如果 stdout 的管道缓冲区满了（通常是 64KB），子进程会阻塞在写 stdout 上，而 Java 这边还在等 stdout 读完才去读 stderr。如果子进程又在往 stderr 写大量数据，就会死锁。

当前实现能工作是因为大多数命令的输出不会同时在 stdout 和 stderr 产生超大量数据。但如果要处理极端情况，应该用两个线程分别读两个流。注释里写的 `Read stdout and stderr concurrently` 其实是预期的设计意图，当前代码是简化版。

超时控制的实现：

```
boolean finished = process.waitFor(
    timeout, TimeUnit.SECONDS
);
if (!finished) {
    process.destroyForcibly();
    return ToolResult.error(
        "Error: command timed out after " + timeout + "s"
    );
}
```

`waitFor(timeout, TimeUnit)` 等待指定时间，返回 boolean 表示进程是否在时限内结束。超时后 `destroyForcibly()` 强制杀进程，相当于发 SIGKILL。这种分离式的「等待 + 手动杀」模式虽然比一体式的超时控制写法多一步，但语义更清晰：先判断是否超时，再决定怎么处理。

输出格式组装模拟了终端的样子：

```
var sb = new StringBuilder();
sb.append("$ ").append(command).append('\n');
if (!stdout.isEmpty()) {
    sb.append(stdout);
    if (!stdout.endsWith("\n")) sb.append('\n');
}
if (!stderr.isEmpty()) {
    sb.append("STDERR: ").append(stderr);
}
sb.append("(exit code ").append(exitCode).append(')');

return new ToolResult(sb.toString(), exitCode != 0);
```

`$ command` 开头让 LLM 知道执行了什么，中间是输出内容，末尾是退出码。退出码非零标记 `isError` ，但这不是让 Java 抛异常，只是告诉 LLM「命令执行失败了」，LLM 会自己判断怎么处理。

### 辅助方法：stringArg 和 intArg

几乎每个工具实现里都有这两个 private static 方法：

```
private static String stringArg(
    Map<String, Object> args, String key, String def
) {
    var v = args.get(key);
    return v instanceof String s ? s : def;
}

private static int intArg(
    Map<String, Object> args, String key, int def
) {
    var v = args.get(key);
    if (v instanceof Number n) return n.intValue();
    return def;
}
```

Java 16 的 pattern matching 让类型检查和类型转换合成一步。 `v instanceof String s` 不仅检查类型，还把结果赋给变量 s 。 `intArg` 用 `Number` 基类接收，不管 JSON 解析出来是 Integer、Long 还是 Double，统一调 `intValue()` 转成 int。

这两个方法在每个工具类里都独立定义了一份，没有提取到公共基类或工具类里。这是 Java 版的一个有意的取舍：每个工具类自包含，不引入额外的继承层次。

### WriteFile：POSIX 权限处理

Java 版的 WriteFile 有一个其他语言版本没有的功能：

```
boolean posix = path.getFileSystem()
    .supportedFileAttributeViews().contains("posix");

if (posix) {
    Set<PosixFilePermission> dirPerms =
        PosixFilePermissions.fromString("rwxr-xr-x");
    Files.createDirectories(parent,
        PosixFilePermissions.asFileAttribute(dirPerms));
}
// ...
if (posix) {
    Set<PosixFilePermission> filePerms =
        PosixFilePermissions.fromString("rw-r--r--");
    Files.setPosixFilePermissions(path, filePerms);
}
```

在 Linux/macOS 上，创建目录时设置 `rwxr-xr-x` （755），创建文件时设置 `rw-r--r--` （644）。这些是 Unix 系统的标准权限。在 Windows 上跳过这些操作，因为 Windows 不支持 POSIX 权限模型。

先用 `supportedFileAttributeViews().contains("posix")` 检测当前文件系统是否支持 POSIX 权限，再决定是否设置。这种运行时检测让同一份代码在 Linux、macOS 和 Windows 上都能正确工作，不需要条件编译或平台分支。

### Grep：二进制检测 + 输出截断

Grep 工具有两个值得关注的功能。第一个是二进制文件检测：

```
private static boolean isBinaryFile(Path file) {
    try (InputStream is = Files.newInputStream(file)) {
        byte[] buf = new byte[512];
        int bytesRead = is.read(buf);
        if (bytesRead <= 0) return false;
        for (int i = 0; i < bytesRead; i++) {
            if (buf[i] == 0) return true;
        }
        return false;
    } catch (IOException e) {
        return true;
    }
}
```

读取文件头 512 字节，如果包含空字节（0x00）就判定为二进制文件并跳过。这个启发式方法不完美（有些文本文件可能包含 BOM 等特殊字节），但对绝大多数场景够用了。跳过二进制文件可以避免在搜索结果里出现乱码。

第二个是输出截断：

```
totalChars += entry.length() + 1;
if (totalChars > ToolRegistry.MAX_OUTPUT_CHARS) {
    results.add("... output truncated (max "
        + ToolRegistry.MAX_OUTPUT_CHARS + " chars)");
    return ToolResult.success(
        String.join("\n", results)
    );
}
```

搜索结果累计超过 `MAX_OUTPUT_CHARS`（10000 字符）就截断。这防止了一次 grep 返回几万行匹配结果把上下文撑爆。截断后还附了一条提示，LLM 看到就知道结果不完整，可以用更精确的模式缩小搜索范围。

## ToolSearch 与延迟加载

代码里还有一个 `ToolSearchTool`，配合 Tool 接口的 `shouldDefer()` 默认方法实现延迟加载。如果一个工具覆盖 `shouldDefer()` 返回 `true`，它的完整 schema 不会出现在默认的工具列表里。LLM 需要通过 ToolSearch 按名称或关键词搜索才能拉取它的完整定义。

目前六个内置工具都没有覆盖这个方法，默认返回 `false`，延迟加载机制在本章阶段不会被触发。它真正发挥作用是在第七章引入 MCP 之后：MCP 工具数量不可控，全量塞进上下文会浪费大量 token 并干扰模型选择。到那时我们会详细走读 Java 版的 ToolSearchTool 实现。

## 小结

| 设计决策 | Java 的实现方式 |
| --- | --- |
| 工具抽象 | `Tool` interface，5 个抽象方法 + `shouldDefer()` 默认方法 |
| 工具分类 | `ToolCategory` enum，编译期类型安全 |
| 结果传递 | `ToolResult` record + `success()` / `error()` 工厂方法 |
| 注册机制 | `LinkedHashMap` 保证插入序遍历 |
| Schema 生成 | 每个工具手写 `Map.of()` / `List.of()` 不可变集合 |
| 参数解析 | `stringArg()` / `intArg()` pattern matching 辅助方法 |
| 子进程管理 | `ProcessBuilder` + `waitFor(timeout)` + `destroyForcibly()` |
| 唯一性校验 | 手写 `countOccurrences()` 用 `indexOf` 循环计数 |
| 延迟加载 | `shouldDefer()` 默认方法 + ToolSearchTool（详见第七章） |
| 协议适配 | `getAllSchemas(protocol)` 参数区分 Anthropic/OpenAI 格式 |
