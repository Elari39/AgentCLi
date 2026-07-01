# Go源码解析：技能加载与执行模式

派大星 6月12日修改

> 理论篇讲了 Skill 是「可复用的 SOP」，这篇带你走读 Go 版 MewCode 的实际代码，看看一个 Markdown 文件是怎么变成 Agent 可执行的能力的。

## 模块概览

Skill 系统的代码分布在 `internal/skills/` 目录下的多个文件里（skills.go、catalog.go、parser.go、directory.go、executor.go 等），串起了从「用户写一个 Markdown」到「Agent 按 SOP 执行任务」的完整链路。核心流程是三件事：定义数据结构、从磁盘加载、渲染成 Agent 可消费的 prompt。

## 核心类型

### SkillMeta：描述一个 Skill「是什么」

```go
type SkillMeta struct {
    Name         string   `yaml:"name"`
    Description  string   `yaml:"description"`
    WhenToUse    string   `yaml:"when_to_use"`
    Tags         []string `yaml:"tags"`
    AllowedTools []string `yaml:"allowed_tools"`
    Mode         string   `yaml:"mode"`
    Model        string   `yaml:"model"`
    Context      string   `yaml:"context"`
    ForkContext  string   `yaml:"fork_context"`
}
```

`AllowedTools` 是工具白名单，fork 模式下用来限制子 Agent 能调用哪些工具。 `Mode` 是现代方式选择执行模式： `"inline"` （默认）或 `"fork"` 。 `Context` 保留向后兼容，值为 `"fork"` 时等同于 `Mode="fork"` 。 `Model` 允许 Skill 指定使用的 LLM 模型。 `ForkContext` 控制 fork 子 Agent 继承多少父对话上下文： `"full"` （LLM 摘要）、 `"recent"` （最近 5 条）、 `"none"` （默认，不继承）。

### Skill：Meta + 可执行体

```go
type Skill struct {
    Meta       SkillMeta
    PromptBody string
    SourceDir  string
}
```

`PromptBody` 是 Skill 的正文， `SourceDir` 记录加载来源目录。

### Catalog：Skill 的注册中心

Catalog 就是一个 `map[string]*Skill` ，按名字索引，提供 `Register` 、 `Get` 、 `List` 三个方法。同名 Skill 会被后注册的覆盖，这个特性在多位置加载时就变成了优先级机制。

## 主流程走读

### 入口：LoadSkills

```go
func LoadSkills(workDir string) *Catalog {
    catalog := NewCatalog()
    if home, err := os.UserHomeDir(); err == nil {
        loadInto(catalog, filepath.Join(home, ".mewcode", "skills"))
    }
    loadInto(catalog, filepath.Join(workDir, ".mewcode", "skills"))
    loadInto(catalog, filepath.Join(workDir, ".claude", "skills"))
    return catalog
}
```

三个位置依次加载，合并到同一个 Catalog：全局 `~/.mewcode/skills/` 、项目 `$workDir/.mewcode/skills/` 、兼容目录 `$workDir/.claude/skills/` 。因为 `Register` 按名字覆盖，加载顺序就是优先级：项目级覆盖全局， `.claude/` 覆盖 `.mewcode/` 。

中间函数 `loadInto` 遍历目录下所有子目录，每个子目录当作一个 Skill 来加载。两处容错：目录不存在静默跳过，单个 Skill 解析失败也跳过，不会因为某个写坏的文件而影响全局。

### 加载单个 Skill：两种格式

```go
func loadSkill(dir string) (*Skill, error) {
    metaPath := filepath.Join(dir, "skill.yaml")
    data, err := os.ReadFile(metaPath)
    if err != nil {
        mdPath := filepath.Join(dir, "SKILL.md")
        data, err = os.ReadFile(mdPath)
        if err != nil {
            return nil, fmt.Errorf("no skill.yaml or SKILL.md found")
        }
        return parseSkillMD(dir, string(data))
    }
    // ... YAML 路径 ...
}
```

一个 Skill 目录下可以用两种格式定义， `loadSkill` 按优先级尝试：

**格式一：** `skill.yaml`**+** `prompt.md` 。结构化方式，元数据和正文分开，适合需要精确控制 `AllowedTools` 和 `Context` 的场景。

**格式二：** `SKILL.md`**单文件** 。轻量级方式，一个 Markdown 搞定。有 YAML frontmatter 就从里面解析元数据，没有就用目录名当 Skill 名、正文第一段当描述。看 `parseSkillMD` 的 fallback 逻辑：

```go
func parseSkillMD(dir string, content string) (*Skill, error) {
    name := filepath.Base(dir)
    body := content
    var meta SkillMeta

    if strings.HasPrefix(strings.TrimSpace(content), "---") {
        parts := strings.SplitN(content, "---", 3)
        if len(parts) >= 3 {
            if err := yaml.Unmarshal([]byte(parts[1]), &meta); err == nil {
                body = strings.TrimSpace(parts[2])
            }
        }
    }
    // 名字和描述的兜底推断...
}
```

先尝试解析 frontmatter，解析不了就用目录名和正文推断。创建一个 Skill 的最低门槛就是：建个目录，丢个 Markdown 进去。

## 两种执行模式

Skill 加载完之后，执行的时候走 `Render` 方法：

```go
func (s *Skill) Render(args string) string {
    body := s.renderBody(args)
    if s.Meta.IsFork() {
        return s.renderForkDirective(body)
    }
    return body
}
```

### Inline 模式（默认）

`IsFork()` 返回 false 时走 inline 路径（ `IsFork()` 检查 `Mode == "fork"` 或 `Context == "fork"` ，两者任一为真即视为 fork 模式）， `Render` 直接返回替换过参数的 prompt body，注入当前对话，Agent 在主会话里按 SOP 执行。简单直接，适合不需要隔离的轻量 Skill。

### Fork 模式

`IsFork()` 返回 true 时， `Render` 不返回 prompt body 本身，而是返回一段「委派指令」：

```go
func (s *Skill) renderForkDirective(body string) string {
    var sb strings.Builder
    sb.WriteString("Run the skill `")
    sb.WriteString(s.Meta.Name)
    sb.WriteString("` in a forked sub-agent...")
    if len(s.Meta.AllowedTools) > 0 {
        sb.WriteString("- restrict the sub-agent to these tools: ")
        sb.WriteString(strings.Join(s.Meta.AllowedTools, ", "))
    }
    sb.WriteString("- prompt (pass verbatim to the sub-agent):

")
    sb.WriteString(body)
    // ...
}
```

这段指令告诉主 Agent：通过 Agent 工具启动子 Agent 来执行。Skill 的完整 prompt body 只传给子 Agent，主 Agent 只看到最终的摘要，几千字的 Skill 定义不会污染主会话的上下文窗口。

`AllowedTools` 在这里发挥作用：fork 出来的子 Agent 只能使用白名单里的工具。比如一个 `code-review` Skill 只允许 `ReadFile` 和 `Grep` ，子 Agent 就没法偷偷执行 `Bash` 命令。

## 参数传递与 $ARGUMENTS 替换

```go
func (s *Skill) renderBody(args string) string {
    body := s.PromptBody
    if strings.Contains(body, "$ARGUMENTS") {
        return strings.ReplaceAll(body, "$ARGUMENTS", args)
    }
    if strings.TrimSpace(args) == "" {
        return body
    }
    return body + "

## User Request

" + args
}
```

三种情况：有 `$ARGUMENTS` 占位符就做字符串替换，Skill 作者可以精确控制参数插入位置；没占位符但有参数，追加 `## User Request` 到末尾；两者都没有，原样返回。大部分 Skill 不需要复杂参数处理，追加到末尾就够了。

## 小结

| 设计决策 | Go 的实现方式 |
| --- | --- |
| 三位置合并加载 | `LoadSkills` 按全局 → 项目 → 兼容目录顺序调用 `loadInto`，同名覆盖 |
| 两种定义格式 | `loadSkill` 先找 `skill.yaml`，找不到再解析 `SKILL.md` |
| Inline 执行 | `Render` 直接返回替换后的 prompt body |
| Fork 执行 | `renderForkDirective` 生成委派指令，交给子 Agent 执行 |
| 工具白名单 | `AllowedTools` 字段写入 fork 指令，限制子 Agent 可用工具 |
| 参数替换 | 有 `$ARGUMENTS` 就替换，没有就追加 `## User Request` |
| 容错策略 | 目录不存在静默跳过，单个 Skill 加载失败不影响全局 |
