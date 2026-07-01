# Go源码解析：工具注册与执行框架

派大星 6月12日修改

> 理论篇讲了 Function Calling 的协议、工具接口设计和六个内置工具，这篇带你走读 Go 版 MewCode 的工具系统代码，看看「注册 → 描述 → 执行」这条主线是怎么实现的。

## 模块概览

工具系统的代码集中在 `internal/tools/` 目录下，共 10 个文件：

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `tool.go` | 186 | 核心基础设施：Tool 接口、ToolResult、Registry、Schema 生成 |
| `descriptions.go` | 68 | 六个内置工具的描述文本常量 |
| `read_file.go` | 91 | ReadFile 工具 |
| `write_file.go` | 47 | WriteFile 工具 |
| `edit_file.go` | 64 | EditFile 工具 |
| `bash.go` | 87 | Bash 工具 |
| `glob.go` | 81 | Glob 工具 |
| `grep.go` | 105 | Grep 工具 |
| `tool_search.go` | 99 | ToolSearch，延迟加载发现机制（第七章展开） |
| `ask_user.go` | 150 | AskUserQuestion，向用户提问的交互工具 |

前 8 个文件构成了理论篇讲的工具系统核心。后两个是扩展工具，理论篇没有重点展开，但它们的实现很有意思，后面会单独讲。

## 核心类型

### Tool 接口

所有工具都实现同一个接口：

```
type Tool interface {
    Name() string                                          // 工具唯一标识
    Description() string                                   // 给 LLM 看的描述
    Category() ToolCategory                                // read / write / command
    Schema() map[string]any                                // JSON Schema 参数定义
    Execute(ctx context.Context, args map[string]any) ToolResult // 执行
}
```

五个方法，各管一件事。 `Name()` 和 `Description()` 告诉 LLM 这个工具是什么、怎么用。 `Schema()` 定义参数格式让 LLM 知道该传什么。 `Category()` 标记工具的读写属性，给权限系统用。 `Execute()` 是真正干活的地方。

这个接口的好处是：不管内置工具还是 MCP 外部工具，对 Agent Loop 来说长得一样。第7章的 MCP 工具包装器也是实现这个接口，注册进来后 Agent 完全无感。

### ToolResult 和 ToolCategory

```
type ToolResult struct {
    Output  string // 执行结果或错误信息
    IsError bool   // 标记是否出错
}

type ToolCategory string

const (
    CategoryRead    ToolCategory = "read"    // 只读，不改文件系统
    CategoryWrite   ToolCategory = "write"   // 写操作
    CategoryCommand ToolCategory = "command" // 执行命令
)
```

`ToolResult` 只有两个字段，简洁到极致。注意 `IsError` 不是让程序 panic 的那种错误，而是告诉 LLM「这次工具调用没成功」，LLM 收到后可以换个思路再试。比如 EditFile 找不到要替换的字符串，就会返回 `IsError: true` ，LLM 看到后会重新读文件确认内容再编辑。

`ToolCategory` 把工具分成三类。第6章的权限系统会根据这个分类做不同的检查策略。

### Registry：工具注册中心

```
type Registry struct {
    tools           map[string]Tool  // 按名称存储所有工具
    discoveredTools map[string]bool  // 记录哪些延迟工具已被发现
}
```

Registry 是整个工具系统的中枢。所有工具注册到这里，Agent Loop 从这里获取工具列表和 Schema，执行时也从这里查找工具。两个字段，一个存工具实例，一个追踪延迟加载状态。

## 主流程走读

工具系统的主线可以拆成三步：注册、描述、执行。对应 Function Calling 的「告诉模型有什么工具 → 模型决定调用 → 执行并返回结果」。

### 第一步：注册

`CreateDefaultRegistry()` 是整个工具系统的启动入口：

```
func CreateDefaultRegistry() *Registry {
    reg := NewRegistry()
    reg.Register(&ReadFileTool{})
    reg.Register(&WriteFileTool{})
    reg.Register(&EditFileTool{})
    reg.Register(&BashTool{})
    reg.Register(&GlobTool{})
    reg.Register(&GrepTool{})
    return reg
}
```

六个内置工具，每个都是一个空结构体（没有状态），实例化后注册进去。 `Register()` 内部就一行： `r.tools[t.Name()] = t` ，按名称存进 map。

为什么用空结构体？因为工具本身不需要维护状态，所有行为都在方法里。ReadFile 不需要记住上次读了什么，每次调用都是独立的。

### 第二步：生成 Schema

Agent Loop 每轮迭代都会调用 `GetAllSchemas()` 拿到所有工具的描述，塞进 LLM 请求：

```
func (r *Registry) GetAllSchemas(protocol string) []map[string]any {
    schemas := make([]map[string]any, 0, len(r.tools))
    for _, t := range r.tools {
        if isDeferred(t) && !r.discoveredTools[t.Name()] {
            continue // 延迟工具且未被发现，跳过
        }
        base := t.Schema()
        if protocol == "openai" {
            // OpenAI 格式包装
        } else {
            schemas = append(schemas, base) // Anthropic 原生格式
        }
    }
    return schemas
}
```

这里做了两件事。一是过滤掉未被发现的延迟工具（省 token，后面会讲）。二是根据 protocol 参数适配不同的 API 格式。Anthropic 原生格式和 OpenAI 格式的 schema 结构不同，这一层把差异抹平了。

每个工具的 `Schema()` 方法返回一个标准的 JSON Schema 描述。以 EditFile 为例：

```
func (t *EditFileTool) Schema() map[string]any {
    return map[string]any{
        "name":        t.Name(),
        "description": t.Description(),
        "input_schema": map[string]any{
            "type": "object",
            "properties": map[string]any{
                "file_path":  map[string]any{"type": "string", "description": "..."},
                "old_string": map[string]any{"type": "string", "description": "..."},
                "new_string": map[string]any{"type": "string", "description": "..."},
            },
            "required": []string{"file_path", "old_string", "new_string"},
        },
    }
}
```

这就是 LLM 看到的工具说明书。 `properties` 定义每个参数的类型和含义， `required` 标记哪些是必填的。LLM 会根据这些信息生成符合格式的调用参数。

### 第三步：执行

当 LLM 决定调用某个工具时，Agent Loop 通过 `Registry.Get(name)` 查找工具，然后调用 `Execute()` 。以 EditFile 为例，这是整个执行流程：

```
func (t *EditFileTool) Execute(_ context.Context, args map[string]any) ToolResult {
    filePath, _ := args["file_path"].(string)
    oldStr, _ := args["old_string"].(string)
    newStr, _ := args["new_string"].(string)

    if filePath == "" {
        return ToolResult{Output: "Error: file_path is required", IsError: true}
    }

    data, err := os.ReadFile(filePath)
    if os.IsNotExist(err) {
        return ToolResult{Output: fmt.Sprintf("Error: file not found: %s", filePath), IsError: true}
    }
```

先从 `args` map 里取参数。Go 没有自动的参数校验，所以手动做类型断言。接着读文件，文件不存在就返回错误。

然后是 EditFile 最核心的设计：唯一性校验。

```
    content := string(data)
    count := strings.Count(content, oldStr)
    if count == 0 {
        return ToolResult{Output: "Error: old_string not found in file", IsError: true}
    }
    if count > 1 {
        return ToolResult{
            Output: fmt.Sprintf("Error: old_string found %d times, must be unique", count),
            IsError: true,
        }
    }

    newContent := strings.Replace(content, oldStr, newStr, 1)
    os.WriteFile(filePath, []byte(newContent), 0o644)
```

`old_string` 在文件里必须恰好出现一次。找不到报错，出现多次也报错。这个约束看起来严格，但它解决了一个关键问题：如果允许模糊匹配或多次替换，LLM 可能意外改错地方。唯一性约束让每次编辑都是精确的、可预期的。LLM 需要提供足够多的上下文才能定位到唯一匹配，这反而提高了编辑的准确率。

## 六个内置工具速览

每个内置工具都是同样的模式：空结构体 + 五个方法。它们的差异在 `Execute()` 的逻辑上。

| 工具 | Category | 核心逻辑 | 关键限制 |
| --- | --- | --- | --- |
| `ReadFile` | `read` | 按行号范围读文件，输出带行号 | 默认读 2000 行，支持 offset/limit |
| `WriteFile` | `write` | 创建父目录 + 写入整个文件 | 全量覆盖，不做 diff |
| `EditFile` | `write` | 唯一性校验 + 精确替换 | `old_string` 必须在文件中恰好出现一次 |
| `Bash` | `command` | bash -c 执行命令，合并 stdout/stderr | 默认超时 120s，最大 600s |
| `Glob` | `read` | 递归遍历目录 + 模式匹配 | 自动跳过 .git、node\_modules 等 |
| `Grep` | `read` | 正则搜索文件内容 | 支持 include 过滤文件类型 |

重点看一下 Bash 工具的实现，它是六个工具里最复杂的：

```
func (t *BashTool) Execute(ctx context.Context, args map[string]any) ToolResult {
    command, _ := args["command"].(string)
    timeout := intArg(args, "timeout", 120)
    if timeout > maxTimeout {
        timeout = maxTimeout // 硬上限 600 秒
    }

    ctx, cancel := context.WithTimeout(ctx, time.Duration(timeout)*time.Second)
    defer cancel()

    cmd := exec.CommandContext(ctx, "bash", "-c", command)
    var stdout, stderr bytes.Buffer
    cmd.Stdout = &stdout
    cmd.Stderr = &stderr
    err := cmd.Run()
```

用 `context.WithTimeout` 做超时控制， `exec.CommandContext` 在超时后会自动杀掉子进程。stdout 和 stderr 分别捕获到两个 buffer 里。

```
    exitCode := 0
    isError := false
    if err != nil {
        if exitErr, ok := err.(*exec.ExitError); ok {
            exitCode = exitErr.ExitCode()
            isError = exitCode != 0
        }
    }

    var sb bytes.Buffer
    fmt.Fprintf(&sb, "$ %s\n", command)
    // ... 组装 stdout、stderr ...
    fmt.Fprintf(&sb, "(exit code %d)", exitCode)
    return ToolResult{Output: sb.String(), IsError: isError}
}
```

退出码非零时标记 `IsError` ，但这不是程序崩溃，只是告诉 LLM「命令执行失败了」。LLM 会看到完整的 stdout、stderr 和退出码，自己判断怎么处理。输出格式模拟了终端的样子： `$ command` 开头，结果在中间，退出码在末尾。

还有一个不起眼但到处在用的辅助函数 `intArg()` ，定义在 read\_file.go 里：

```
func intArg(args map[string]any, key string, def int) int {
    v, ok := args[key]
    if !ok { return def }
    switch n := v.(type) {
    case float64: return int(n)  // JSON 数字默认解析为 float64
    case int:     return n
    case int64:   return int(n)
    default:      return def
    }
}
```

LLM 传过来的 JSON 参数在 Go 里解析后，数字类型可能是 `float64` 、 `int` 或 `int64` ，这个函数把三种情况都兜住了。六个内置工具里凡是有整数参数的都用它。

## ToolSearch 与延迟加载

代码里还有一个 `DeferrableTool` 接口和 `ToolSearchTool` ：

```
type DeferrableTool interface {
    ShouldDefer() bool
}
```

如果一个工具实现了这个接口并返回 `true` ，它就不会出现在默认的 Schema 列表里。LLM 需要通过 ToolSearch 按名称或关键词搜索才能拉取它的完整定义。

目前六个内置工具没有一个需要延迟加载，这套机制在本章阶段不会被触发。它真正发挥作用是在第七章引入 MCP 之后：用户接入多个 MCP Server，工具数量从个位数暴涨到几十上百个，全量塞进上下文的代价变得不可接受。到那时我们会详细讨论延迟加载的设计动机、ToolSearch 的实现走读和跨厂商兼容性问题。

## 小结

| 设计决策 | Go 的实现方式 |
| --- | --- |
| 工具抽象 | `Tool` 接口，5 个方法，所有工具统一实现 |
| 工具状态 | 空结构体，无状态，每次调用独立 |
| 注册机制 | `Registry` 用 `map[string]Tool` 按名称存储 |
| Schema 生成 | 每个工具自己返回 JSON Schema，Registry 统一收集 |
| 协议适配 | `GetAllSchemas(protocol)` 参数区分 Anthropic/OpenAI 格式 |
| 工具分类 | 三种 Category（read/write/command），供权限系统判断 |
| 结果传递 | `ToolResult{Output, IsError}`，错误交给 LLM 自行处理 |
| 延迟加载 | `DeferrableTool` 接口 + ToolSearch（详见第七章） |
| 参数解析 | 手动类型断言 + `intArg()` 辅助函数兜底多种数字类型 |
