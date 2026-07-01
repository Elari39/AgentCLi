# Java源码解析：系统提示词组装管线

派大星 6月12日修改

> 理论篇讲了 System Prompt 的设计理念和分层结构，这篇带你走读 Java 版 MewCode 的真实代码，看看同样的设计在 Java 里是怎么落地的。

## 模块概览

System Prompt 的代码分布在三个文件里：

| 文件 | 职责 |
| --- | --- |
| `PromptBuilder.java` | 核心。Section record 定义、段落收集和排序、环境探测、buildSystemPrompt 入口 |
| `PromptSections.java` | 7 个固定段落的文本常量和工厂方法 |
| `PlanModePrompt.java` | Plan Mode 的完整版/精简版/重入/退出提醒 |

三个文件加起来约 400 行。Java 版把段落定义拆到了独立文件，PromptBuilder 本身只负责组装逻辑，职责分离很清晰。

## 核心类型

### Section：提示词片段

```java
public record Section(
    String name,
    int priority,
    String content
) {}
```

Java 16 引入的 `record` 类型，自动生成构造函数、 `equals()` 、 `hashCode()` 和 `toString()` ，而且所有字段默认 `final` ，不可变。不可变意味着 Section 创建后就不能被篡改，这对提示词构建来说是一个很好的安全保证。

三个字段各有明确的语义： `name` 标识段落身份、 `priority` 决定排序权重、 `content` 承载文本内容。

### EnvironmentContext 和 BuildOptions

```java
public record EnvironmentContext(
    String workDir,
    String os,
    String arch,
    String shell,
    boolean isGitRepo,
    String gitBranch,
    String model,
    String date
) {}

public record BuildOptions(
    String customInstructions,
    String skillSection,
    String memorySection
) {}
```

Java 版把环境信息和构建选项也定义成了 record。这是 Java 的惯用做法：用类型包装一组相关参数，比一个函数接收七八个参数更清晰。

`EnvironmentContext` 包含了丰富的运行时信息： `arch` 、 `shell` 、 `isGitRepo` 、 `gitBranch` 、 `model` 等。这些字段让 LLM 能精准感知当前环境，比如知道在 `feature/login` 分支上就能给出更有针对性的 git 建议。

### PromptBuilder 的状态和方法

```java
private final List<Section> sections =
    new ArrayList<>();

public PromptBuilder add(Section section) {
    sections.add(section);
    return this;
}
```

`add()` 返回 `this` ，支持链式调用。 `sections` 用 `ArrayList` ，因为后面要排序，而且需要按索引访问。

## 主流程：build 和 buildSystemPrompt

### build() 方法

```java
public String build() {
    sections.sort(
        Comparator.comparingInt(Section::priority)
    );

    var parts = new ArrayList<String>();
    for (Section s : sections) {
        String content = s.content() == null
            ? ""
            : s.content().strip();
        if (!content.isEmpty()) {
            parts.add(content);
        }
    }
    return String.join("

", parts);
}
```

排序用 `Comparator.comparingInt(Section::priority)` ，方法引用类型安全，IDE 能直接跳转到字段定义。

`s.content()` 用的是 record 自动生成的访问器方法（而不是直接字段访问），这也是 record 和普通 class 的区别。record 没有公开字段，所有访问都通过方法。

额外做了 `null` 检查（ `s.content() == null` ），Java 必须显式处理 `null`，否则调用 `strip()` 会抛 `NullPointerException` 。

### buildSystemPrompt 静态方法

```java
public static String buildSystemPrompt(
    EnvironmentContext env,
    BuildOptions options
) {
    var builder = new PromptBuilder();

    builder.add(PromptSections.identitySection());
    builder.add(PromptSections.systemSection());
    builder.add(PromptSections.doingTasksSection());
    builder.add(PromptSections.executingActionsSection());
    builder.add(PromptSections.usingToolsSection());
    builder.add(PromptSections.toneStyleSection());
    builder.add(PromptSections.outputEfficiencySection());
    builder.add(PromptSections.environmentSection(env));
```

7 个固定段落通过 `PromptSections` 的工厂方法获取，每个方法返回一个 `Section` 实例。Java 版把段落定义拆到了 `PromptSections` 类里，让 `PromptBuilder` 不用关心具体的提示词内容。

`environmentSection(env)` 接收整个 `EnvironmentContext` record，因为环境段落包含的信息很丰富，用 record 打包传递比传多个独立参数更整洁。

### 条件段落

```java
if (options.customInstructions() != null
    && !options.customInstructions().isEmpty()) {
    builder.add(new Section(
        "CustomInstructions", 80,
        "# Project Instructions

"
            + options.customInstructions()
    ));
}

if (options.skillSection() != null
    && !options.skillSection().isEmpty()) {
    builder.add(new Section(
        "Skills", 90,
        options.skillSection()
    ));
}

if (options.memorySection() != null
    && !options.memorySection().isEmpty()) {
    builder.add(new Section(
        "Memory", 95,
        options.memorySection()
    ));
}
```

priority 分别是 80、90、95，只在内容非空时添加。Java 的判空需要同时检查 `!= null` 和 `!isEmpty()` ，这是 Java 的特点：null 和空字符串是两个不同的状态，需要分别处理。

## 段落定义：PromptSections

### 文本块语法

```java
static final String IDENTITY_CONTENT = """
        You are MewCode, an AI programming assistant         running in the terminal. You help users with         software engineering tasks including writing         code, debugging, refactoring, explaining code,         and running commands.

        IMPORTANT: Be careful not to introduce security         vulnerabilities such as command injection, XSS,         SQL injection, and other common vulnerabilities.         Prioritize writing safe, secure, and correct         code.
        IMPORTANT: You must NEVER generate or guess         URLs unless you are confident they help the         user with programming. You may use URLs provided         by the user.""";
```

Java 13 引入了 Text Block（三引号字符串 `"""` ）。行尾的  是续行符，把多行源码拼成逻辑上的一行文本，避免输出中出现多余的换行。

Text Block 有一个巧妙的缩进规则：编译器会找到所有行中最靠左的非空行，把那个缩进量作为基准去掉。所以源码里的缩进是为了代码可读性，不会出现在最终字符串里。

### 工厂方法

```java
public static Section identitySection() {
    return new Section(
        "Identity", 0, IDENTITY_CONTENT
    );
}
```

每个段落都有一个对应的工厂方法。用静态方法而不是全局变量，好处是方法调用可以在未来加入参数做动态调整，比如根据不同的上下文返回不同版本的段落。

### 环境段落的动态构建

```java
public static Section environmentSection(
    EnvironmentContext env
) {
    var sb = new StringBuilder();
    sb.append("# Environment
");
    sb.append(" - Working directory: ")
      .append(env.workDir()).append('
');
    sb.append(" - Platform: ")
      .append(env.os()).append('/')
      .append(env.arch()).append('
');
    sb.append(" - Shell: ")
      .append(env.shell()).append('
');
    sb.append(" - Is git repo: ")
      .append(env.isGitRepo());
    if (env.isGitRepo()
        && env.gitBranch() != null
        && !env.gitBranch().isEmpty()) {
        sb.append('
')
          .append(" - Git branch: ")
          .append(env.gitBranch());
    }
    if (env.model() != null
        && !env.model().isEmpty()) {
        sb.append('
')
          .append(" - Model: ")
          .append(env.model());
    }
    sb.append('
')
      .append(" - Date: ")
      .append(env.date());
    return new Section(
        "Environment", 70, sb.toString()
    );
}
```

用 `StringBuilder` 手动拼接，这是 Java 拼接字符串的标准做法，避免反复创建中间字符串对象。

环境信息非常丰富：工作目录、平台、Shell 类型、是否 Git 仓库、Git 分支、模型名称、日期。这些信息帮助 LLM 生成更精准的命令。比如知道当前在 `feature/login` 分支上，LLM 在做 git 操作时就能给出更有针对性的建议。知道 Shell 是 zsh 而不是 bash，生成的命令语法也会更准确。

## 环境探测

```java
public static EnvironmentContext detectEnvironment(
    String model
) {
    String workDir =
        System.getProperty("user.dir");
    String osName =
        System.getProperty("os.name", "unknown")
              .toLowerCase();
    String arch =
        System.getProperty("os.arch", "unknown");
    String shell = System.getenv("SHELL");
    if (shell == null || shell.isEmpty()) {
        shell = "bash";
    }
```

Java 用 `System.getProperty()` 获取 JVM 系统属性（如 `user.dir` 、 `os.name` 、 `os.arch` ），用 `System.getenv()` 获取环境变量（如 `SHELL` ）。两种 API 的区别是：系统属性由 JVM 管理，可以在启动时通过 `-D` 参数设置；环境变量继承自操作系统。

Shell 检测有个回退逻辑：如果环境变量 `SHELL` 不存在（比如在 Windows 上），默认用 `"bash"` 。

### Git 探测

```java
boolean isGitRepo = false;
String gitBranch = "";

try {
    Process p = new ProcessBuilder(
        "git", "-C", workDir,
        "rev-parse", "--is-inside-work-tree"
    ).redirectErrorStream(true).start();
    try (var reader = new BufferedReader(
        new InputStreamReader(p.getInputStream()))
    ) {
        String line = reader.readLine();
        if ("true".equals(
            line != null ? line.strip() : "")) {
            isGitRepo = true;
        }
    }
    p.waitFor();
} catch (Exception ignored) {}
```

Java 版用 `ProcessBuilder` 调用 `git rev-parse --is-inside-work-tree` 来检测当前目录是不是 Git 仓库。这是最可靠的方式，因为 Git 自己最清楚什么算「在工作树里」。

`redirectErrorStream(true)` 把 stderr 合并到 stdout，简化读取逻辑。try-with-resources 自动关闭 reader。整个操作包在 try-catch 里，如果 git 命令不存在或者执行失败，静默忽略， `isGitRepo` 保持 `false` 。

Git 探测能给 LLM 提供重要的上下文。如果当前不是 Git 仓库，LLM 就不会尝试执行 git 命令；如果是 Git 仓库，分支名能帮助 LLM 理解当前的工作上下文。

## Plan Mode 提示词

### 完整版提醒

```java
private static final String PLAN_MODE_FULL_REMINDER =
    """
    Plan mode is active. The user indicated that     they do not want you to execute yet -- you MUST     NOT make any edits (with the exception of the     plan file mentioned below), run any non-readonly     tools (including changing configs or making     commits), or otherwise make any changes to the     system. This supercedes any other instructions     you have received.

    ## Plan File Info:
    %s
    You should build your plan incrementally by     writing to or editing this file.
    ...""";
```

注意占位符用的是 `%s` （Java 的 `String.format` 语法）。 `%s` 不支持命名参数，只能按位置填充，所以参数顺序很重要。如果有多个占位符，传参的顺序必须严格对应，否则文本会拼错。

### 重入和退出提醒

```java
private static final String
    PLAN_MODE_REENTRY_REMINDER = """
    ## Re-entering Plan Mode

    You are returning to plan mode after having     previously exited it. A plan file exists at %s     from your previous planning session.

    **Before proceeding with any new planning,     you should:**
    1. Read the existing plan file
    2. Evaluate the user's current request
    3. Decide how to proceed:
       - **Different task**: start fresh
       - **Same task, continuing**: modify existing
    ...""";
```

除了完整版和精简版，Java 版还有两个额外的提醒模板： `PLAN_MODE_REENTRY_REMINDER` （重新进入 Plan Mode）和 `PLAN_MODE_EXIT_REMINDER` （退出 Plan Mode）。

重入提醒告诉 LLM「你之前规划过，先看看旧计划再决定是接着做还是重新来」。退出提醒告诉 LLM「Plan Mode 结束了，你可以自由操作了」。这两个模板让 Plan Mode 的状态转换更平滑，LLM 不会在切换模式时丢失上下文。

### 频率控制

```java
private static final int REMINDER_INTERVAL = 5;

public static String buildReminder(
    String planPath,
    boolean planExists,
    int iteration
) {
    String planFileInfo = "Plan file: " + planPath;
    if (planExists) {
        planFileInfo += "
A plan file already exists "
            + "at " + planPath
            + ". You can read it and make incremental "
            + "edits using the EditFile tool.";
    } else {
        planFileInfo += "
No plan file exists yet. "
            + "You should create your plan at "
            + planPath + " using the WriteFile tool.";
    }

    if (iteration == 1) {
        return String.format(
            PLAN_MODE_FULL_REMINDER, planFileInfo);
    }

    int attachmentIndex =
        (iteration - 1) / REMINDER_INTERVAL;
    if (attachmentIndex % REMINDER_INTERVAL == 0) {
        return String.format(
            PLAN_MODE_FULL_REMINDER, planFileInfo);
    }

    return String.format(
        PLAN_MODE_SPARSE_REMINDER, planPath);
}
```

频率控制的算法是：第 1 轮发完整版，之后每 25 轮（5 的平方）发一次完整版，其余轮次发精简版。完整版包含详细的 Plan Mode 规则和计划文件信息，精简版只提醒「你在 Plan Mode 中」。这种递减频率的设计避免了每轮都塞大量提醒文本浪费 token。

`buildReentryReminder` 和 `buildExitReminder` 分别用于 Plan Mode 的重入和退出场景：

```java
public static String buildReentryReminder(
    String planPath
) {
    return String.format(
        PLAN_MODE_REENTRY_REMINDER, planPath);
}

public static String buildExitReminder(
    String planPath, boolean planExists
) {
    String extra = "";
    if (planExists) {
        extra = " The plan file is located at "
            + planPath
            + " if you need to reference it.";
    }
    return String.format(
        PLAN_MODE_EXIT_REMINDER, extra);
}
```

退出提醒的 `planExists` 参数决定是否附带计划文件路径，让 LLM 在执行阶段能方便地回头查看规划。

## 小结

| 设计决策 | Java 的实现方式 |
| --- | --- |
| 提示词片段 | `record Section` ，不可变，三个字段 |
| 排序组装 | `Comparator.comparingInt()` + 方法引用 |
| 段落拼接 | `String.join(" ", parts)` |
| 环境探测 | `System.getProperty()` + `ProcessBuilder` 调 git |
| 条件段落 | `!= null && !isEmpty()` 双重判空后 `add()` |
| 文本常量 | Text Block `"""..."""` +  续行符 |
| Plan Mode 频率 | 整数除法 + 取模，每 25 轮发一次完整提醒 |
| Plan Mode 状态 | 4 种提醒模板：完整、精简、重入、退出 |
| 段落与组装分离 | `PromptSections` 提供工厂方法， `PromptBuilder` 只管组装 |
