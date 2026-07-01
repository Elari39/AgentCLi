# Java源码解析：技能加载与执行模式

派大星 6月12日修改

> 理论篇讲了 Skill 是「可复用的 SOP」，这篇带你走读 Java 版 MewCode 的实际代码，看看一个 Markdown 文件经过哪些环节变成 Agent 可消费的能力。

## 模块概览

Java 版把 Skill 系统集中在 `SkillCatalog.java` 一个文件里，总共 206 行。一个文件里定义了数据类型、目录扫描、文件解析、上下文生成，串起了从「用户写一个 Markdown」到「Skill 内容注入 Agent 提示词」的完整链路。

为什么只需要一个文件？因为 Java 版专注做好一件事：Skill 的发现和加载。执行模式（inline / fork）的路由交给了 Agent 层，工具白名单的过滤也在上层处理。 `SkillCatalog` 就是一个纯粹的「目录服务」，负责回答「有哪些 Skill 可用」和「给我某个 Skill 的完整内容」。

## 核心类型

### SkillMeta：Skill 的身份信息

```java
public record SkillMeta(
    String name,
    String description,
    String whenToUse,
    List<String> tags,
    List<String> allowedTools,
    String mode,
    String model,
    String forkContext
) {}
```

用 Java 的 `record` 定义，天然不可变。八个字段覆盖了 Skill 的完整配置。 `allowedTools` 是工具白名单，fork 模式下限制子 Agent 可用的工具。 `mode` 选择执行模式（ `"inline"` 或 `"fork"` ）。 `model` 允许指定 LLM 模型。 `forkContext` 控制 fork 子 Agent 继承多少父对话上下文。

`whenToUse` 对应 YAML 里的 `when_to_use` 。这个字段的内容会被注入到系统提示词里，帮助 LLM 判断什么时候该触发哪个 Skill。和 `description` 分开的好处是：description 告诉用户这个 Skill 是什么，whenToUse 告诉 LLM 什么时候用它，两个受众不同。

### Skill：Meta + 可执行体

```java
public record Skill(
    SkillMeta meta,
    String promptBody,
    Path sourceDir
) {}
```

`promptBody` 是 Skill 的 Markdown 正文， `sourceDir` 记录来源目录。

两个 `record` 嵌套使用， `Skill` 持有 `SkillMeta` ，形成清晰的两层结构：外层是「Skill 是什么 + 干什么」，内层是「Skill 的描述性元信息」。

### Catalog：Skill 注册中心

```java
private final Map<String, Skill> skills =
    new LinkedHashMap<>();

public void register(Skill skill) {
    skills.put(skill.meta().name(), skill);
}

public Optional<Skill> get(String name) {
    return Optional.ofNullable(skills.get(name));
}

public List<SkillMeta> list() {
    return skills.values().stream()
        .map(Skill::meta).toList();
}
```

用 `LinkedHashMap` 而不是 `HashMap` ，这是有意为之的。 `LinkedHashMap` 保持插入顺序， `list()` 返回的 Skill 列表顺序和加载顺序一致。如果用 `HashMap` ，每次调用 `list()` 的顺序可能不同，注入到系统提示词里的 Skill 列表就会随机排列，影响 LLM 的行为一致性。

`register` 用 `put` 直接覆盖同名 Skill，后加载的覆盖先加载的。这意味着项目级 Skill 可以覆盖用户级或内置的同名 Skill，实现了自然的优先级机制。

`get` 返回 `Optional<Skill>` 而不是裸 `Skill` 。这是 Java 的惯用做法，强制调用方处理「找不到」的情况，比返回 `null` 再忘记检查要安全。

`list()` 只返回 `SkillMeta` 而不是完整的 `Skill` 。调用方只需要知道有哪些 Skill 可用、它们叫什么、干什么，不需要拿到完整的 prompt body。这是信息最小化原则。

## 主流程走读

### 入口：loadFromDirectory

```java
public void loadFromDirectory(Path dir) {
    if (!Files.isDirectory(dir)) return;
    try (Stream<Path> entries = Files.list(dir)) {
        entries.filter(Files::isDirectory).forEach(skillDir -> {
            try {
                Skill skill = loadSkill(skillDir);
                if (skill != null) register(skill);
            } catch (IOException ignored) { }
        });
    } catch (IOException ignored) { }
}
```

`Files.list(dir)` 返回目录下的直接子项（不递归）。 `try-with-resources` 保证 `Stream<Path>` 在用完后关闭底层的目录句柄。这是 Java NIO 的要求： `Files.list` 返回的 Stream 持有 OS 资源，必须显式关闭。

容错策略很宽松：目录不存在直接 `return` ，单个 Skill 加载失败 catch 住继续下一个。两层 `try-catch` 各管各的：内层管单个 Skill 的解析错误，外层管目录本身不可读的情况。一个 Skill 出问题不会影响其他 Skill 的加载。

注意 `entries.filter(Files::isDirectory)` ：只处理子目录，跳过直接放在 skills 目录下的文件。每个 Skill 必须有自己的目录。这种规整的组织方式让 Skill 可以包含多个文件（如 `skill.yaml` + `prompt.md` + 其他资源），而不仅仅是一个 Markdown 文件。

### 加载单个 Skill：两种格式

```java
private static Skill loadSkill(Path dir) throws IOException {
    Path metaPath = dir.resolve("skill.yaml");
    if (Files.isRegularFile(metaPath)) {
        return loadFromYamlAndPrompt(dir, metaPath);  // Strategy 1
    }
    Path mdPath = dir.resolve("SKILL.md");
    if (Files.isRegularFile(mdPath)) {
        return parseSkillMD(dir, Files.readString(mdPath));  // Strategy 2
    }
    return null;  // no recognizable skill files
}
```

两种策略按优先级尝试。先找 `skill.yaml` ，找到就走结构化路径；找不到再找 `SKILL.md` ，走 frontmatter 路径；都没有返回 `null` ，上层会跳过这个目录。

`Files.isRegularFile` 同时检查文件存在和是否是普通文件（排除符号链接指向目录等边缘情况）。

### Strategy 1：YAML + Prompt 分离格式

```java
private static Skill loadFromYamlAndPrompt(Path dir, Path metaPath)
        throws IOException {
    String yamlText = Files.readString(metaPath);
    Map<String, Object> map = new Yaml().load(yamlText);
    if (map == null) map = Map.of();
    SkillMeta meta = metaFromMap(map, dir);

    String promptBody = "";
    Path promptPath = dir.resolve("prompt.md");
    if (Files.isRegularFile(promptPath)) {
        promptBody = Files.readString(promptPath);
    }
    return new Skill(meta, promptBody, dir);
}
```

元数据从 `skill.yaml` 读，正文从 `prompt.md` 读。 `yaml.load` 可能返回 `null` （空文件的情况），用 `Map.of()` 兜底。 `prompt.md` 不存在也不报错， `promptBody` 默认空字符串。一个 Skill 可以只有元数据没有正文，虽然这种情况不常见。

这里用的是 SnakeYAML 的 `yaml.load` 。新版本的 SnakeYAML 建议传入 `SafeConstructor` 来限制反序列化的类型，但对于 Skill 文件这种受控输入场景，直接 `load` 问题不大。

### Strategy 2：SKILL.md 单文件格式

```java
private static Skill parseSkillMD(Path dir, String content) {
    String body = content;
    Map<String, Object> frontMatter = Map.of();
    String trimmed = content.stripLeading();
    if (trimmed.startsWith("---")) {
        int firstSep = content.indexOf("---");
        int secondSep = content.indexOf("---", firstSep + 3);
        if (secondSep >= 0) {
            String yamlBlock = content.substring(firstSep + 3, secondSep);
            body = content.substring(secondSep + 3).strip();
```

先用 `stripLeading()` 检查文件是否以 `---` 开头。如果是，用两次 `indexOf` 定位两个分隔符的位置，切出 YAML 块和正文。Java 标准库没有内置的按分隔符切三段的方法，所以需要手动定位。虽然多几行代码，但逻辑清晰。

切出 YAML 块后，交给 SnakeYAML 解析：

```java
try {
                Map<String, Object> parsed = new Yaml().load(yamlBlock);
                if (parsed != null) frontMatter = parsed;
            } catch (Exception ignored) { }
        }
    }
    SkillMeta meta = metaFromMap(frontMatter, dir);
    // ... 描述自动推断 ...
    return new Skill(meta, body, dir);
}
```

YAML 解析失败时 catch 住但不做任何处理，整个文件内容当作 body。这是一个宽容的设计：如果用户写了一个不带 frontmatter 的纯 Markdown 文件，它依然能被当作 Skill 加载，只是元数据需要靠 fallback 推断。

### 描述自动推断

```java
String description = meta.description();
if (description == null || description.isBlank()) {
    for (String line : body.split("
")) {
        String stripped = line.strip();
        if (!stripped.isEmpty() && !stripped.startsWith("#")) {
            description = stripped;
            break;
        }
    }
    meta = new SkillMeta(meta.name(),
        description != null ? description : "",
        meta.whenToUse(), meta.tags());
}
```

如果 frontmatter 里没有 `description` 字段，从正文里自动推断：跳过空行和标题行（以 `#` 开头），取第一个普通文本行作为描述。

因为 `SkillMeta` 是 `record` （不可变），没法直接改 `description` 字段，所以要创建一个新的 `SkillMeta` 实例。这是 Java `record` 的特点：不可变带来安全性，但修改时必须重建整个对象。代码量多了一行，但保证了不可变性。

### 名字兜底推断

```java
private static SkillMeta metaFromMap(Map<String, Object> map, Path dir) {
    String name = stringVal(map, "name");
    if (name == null || name.isBlank()) {
        name = dir.getFileName().toString().toLowerCase().replace(' ', '-');
    }
    String description = stringVal(map, "description");
    String whenToUse = stringVal(map, "when_to_use");
    List<String> tags = List.of();
    Object rawTags = map.get("tags");
    if (rawTags instanceof List<?> list) {
        tags = list.stream().map(Object::toString).toList();
    }
```

名字为空时用目录名兜底，转小写并把空格替换成连字符。 `dir.getFileName()` 返回路径的最后一段（目录名），是 NIO Path API 的标准操作。

`tags` 的处理用了 Java 16 的 pattern matching for instanceof： `rawTags instanceof List<?> list` 同时做了类型检查和变量绑定。如果 YAML 里的 `tags` 不是列表类型（比如写成了字符串）， `instanceof` 不通过， `tags` 保持空列表默认值。

`tags` 字段可以用于 Skill 的分类和搜索。 `whenToUse` 字段注入系统提示词帮助 LLM 做触发判断。两者结合让 Skill 的发现和使用更精准。

### 辅助方法：stringVal

```java
private static String stringVal(
    Map<String, Object> map, String key
) {
    Object v = map.get(key);
    return v != null ? v.toString() : null;
}
```

三行代码的辅助方法，从 `Map<String, Object>` 里安全取字符串。SnakeYAML 把 YAML 解析成 `Map<String, Object>` ，值的类型不确定，用 `toString()` 统一转成字符串。如果 key 不存在返回 `null` ，交给调用方处理。

Java 没有内置的 YAML-to-record 映射，所以需要手动从 Map 里取值。可以用 Jackson 的 YAML 模块做自动映射，但那会引入额外依赖。当前的手动取值方式虽然代码多一点，但依赖更少，容错更灵活。

## 上下文生成

### buildActiveContext：把 Skill 注入提示词

```java
public String buildActiveContext(Set<String> activeSkillNames) {
    if (activeSkillNames == null || activeSkillNames.isEmpty()) return "";
    var sb = new StringBuilder();
    sb.append("## Active Skills

");
    for (var name : activeSkillNames) {
        var skill = skills.get(name);
        if (skill != null) {
            sb.append("### ").append(name).append("
");
            sb.append(skill.promptBody()).append("

");
        }
    }
    return sb.toString();
}
```

这个方法把当前激活的 Skill 的 prompt body 拼成一段 Markdown，格式是二级标题加正文。返回的字符串直接注入到 Agent 的系统提示词里。

参数是 `Set<String>` ：一组 Skill 名字。可以同时激活多个 Skill，它们的 prompt body 会依次拼接。这意味着 Agent 可以同时受多个 SOP 的引导，比如同时激活 `code-review` 和 `security-check` 。

`activeSkillNames` 为空或 `null` 时返回空字符串，不往提示词里注入任何东西。这是 Skill 系统的「零开销」原则：没有激活任何 Skill 时，Agent 的行为和没有 Skill 系统一样。

把上下文生成放在 `SkillCatalog` 里，让调用方只需要传一组名字就行。封装程度更高：调用方不需要知道 Skill 的内部结构，只需要说「我要激活这些 Skill」，Catalog 自动拼出注入文本。

## 设计总结

Java 版的 Skill 系统在设计上有几个突出特点：

**单文件内聚** 。206 行的 `SkillCatalog.java` 包含了全部逻辑。record 类型的紧凑语法让数据定义只占几行，剩下的空间全部用于业务逻辑。

**双格式支持** 。既支持 `skill.yaml` + `prompt.md` 的分离格式（适合复杂 Skill），也支持 `SKILL.md` 的单文件格式（适合简单 Skill）。分离格式优先，单文件格式作为 fallback。

**宽松容错** 。名字和描述都有 fallback 推断，YAML 解析失败不报错，单个 Skill 加载失败不影响其他 Skill。这种宽松策略让用户可以快速迭代 Skill 定义，不用担心一个小错误导致整个系统挂掉。

**启动时加载** 。Skill 在启动时一次性加载，运行期间不会重新读取文件。修改 Skill 文件需要重启程序。这简化了并发模型，不需要考虑文件变更的时序问题。

## 小结

| 设计决策 | Java 的实现方式 |
| --- | --- |
| 数据类型 | `record` 定义 `SkillMeta` 和 `Skill`，天然不可变 |
| 注册中心 | `LinkedHashMap` 保持插入顺序，`put` 覆盖同名 |
| 目录扫描 | `Files.list` + `try-with-resources` 管理资源 |
| 两种格式 | `skill.yaml` + `prompt.md` 优先，`SKILL.md` fallback |
| Frontmatter 解析 | 两次 `indexOf("---")` 手动定位，SnakeYAML 解析 |
| 名字兜底 | 目录名转小写、空格换连字符 |
| 描述兜底 | 正文第一个非空非标题行 |
| 上下文生成 | `buildActiveContext` 拼接激活 Skill 的 prompt body |
| 容错策略 | 两层 `try-catch`，目录和单个 Skill 各管各的错误 |
| 查询 API | `get` 返回 `Optional`，`list` 只返回 `SkillMeta` |
