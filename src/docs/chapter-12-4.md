# Python源码解析：事件钩子与条件匹配

派大星 6月14日修改

> 理论篇讲了 Hook 系统如何在 Agent 生命周期的关键节点插入用户自定义行为，这篇带你走读 Python 版 MewCode 的真实代码，看看事件匹配、条件过滤、动作执行这一整条链路是怎么实现的。

## 模块概览

Hook 系统的代码集中在 `mewcode/hooks/` 目录下，一共六个文件：

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `engine.py` | 110 | 核心引擎。`Hook` 匹配、分发、`pre-tool` 拦截、通知收集 |
| `models.py` | 85 | 数据类型定义。`Hook`、`Action`、`HookContext`、`ToolRejectedError` |
| `loader.py` | 116 | 配置解析。把 `YAML` 原始数据校验转换成 `Hook` 对象 |
| `executors.py` | 97 | 动作执行器。`command`、`prompt`、`http`、`agent` 四种执行方式 |
| `conditions.py` | 96 | 条件表达式解析和匹配。支持 `==`、`!=`、`=~`、`~=` 四种运算符 |
| `events.py` | 30 | 生命周期事件枚举。定义了所有合法的 `Hook` 事件名 |

六个文件加起来约 530 行。模块划分非常干净：models 定义数据结构，conditions 负责条件匹配，executors 负责动作执行，loader 负责配置校验，engine 把所有东西串起来。

## 核心类型

### Hook 和 Action

Hook 是整个系统的基本单元，一个 Hook 表示「在某个事件发生时，如果满足条件，就执行某个动作」：

```python
@dataclass
class Hook:
    id: str
    event: str
    action: Action
    condition: ConditionGroup | None = None
    reject: bool = False
    once: bool = False
    async_exec: bool = False
    executed: bool = False
```

`event` 决定这个 Hook 在什么时候触发， `condition` 决定要不要执行， `action` 决定执行什么。三个布尔标记各有用途： `reject` 表示这个 Hook 能拦截工具执行（仅 `pre_tool_use` 事件可用）； `once` 表示只执行一次； `async_exec` 表示异步执行不阻塞主流程。

`should_run` 和 `mark_executed` 配合实现了「只跑一次」的语义：

```python
def should_run(self) -> bool:
    if self.once and self.executed:
        return False
    return True

def mark_executed(self) -> None:
    self.executed = True
```

Action 则定义了具体要执行什么：

```python
@dataclass
class Action:
    type: str
    command: str = ""
    message: str = ""
    url: str = ""
    method: str = "POST"
    body: str = ""
    headers: dict[str, str] = field(default_factory=dict)
    prompt: str = ""
    timeout: int = 30
```

字段很多，但每种 `type` 只用到其中一部分。 `command` 类型用 `command` 字段， `prompt` 类型用 `message` 字段， `http` 类型用 `url` 、 `method` 、 `body` 、 `headers` 。这种「大 union」的设计在配置驱动的系统里很常见，牺牲了一点类型精确性换来了统一的数据结构。

### HookContext：事件的上下文数据

```python
@dataclass
class HookContext:
    event_name: str = ""
    tool_name: str = ""
    tool_args: dict[str, Any] = field(default_factory=dict)
    file_path: str = ""
    message: str = ""
    error: str = ""
```

HookContext 承载了触发 Hook 时的所有上下文信息。条件匹配和模板展开都从这里取值。

`get_field` 方法是条件匹配的入口，它把字段名映射到具体的值：

```python
def get_field(self, name: str) -> str:
    if name == "tool":
        return self.tool_name
    if name == "event":
        return self.event_name
    if name.startswith("args."):
        key = name[5:]
        value = self.tool_args.get(key, "")
        return str(value) if value else ""
    return ""
```

注意 `args.` 前缀的处理，用户可以写 `args.command` 来匹配工具调用的具体参数。这让条件表达式能深入到工具参数层级，比如「只在 Bash 工具执行 npm install 时触发」。

`expand` 方法做模板变量替换，把 `$TOOL_NAME` 、 `$FILE_PATH` 这些占位符替换成真实值：

```python
def expand(self, template: str) -> str:
    result = template
    result = result.replace("$EVENT", self.event_name)
    result = result.replace("$TOOL_NAME", self.tool_name)
    result = result.replace("$FILE_PATH", self.file_path)
    result = result.replace("$MESSAGE", self.message)
    result = result.replace("$ERROR", self.error)
    for key, value in self.tool_args.items():
        result = result.replace(
            f"$TOOL_ARGS.{key}", str(value)
        )
    return result
```

这样用户在配置 Hook 的 command 时就可以写 `echo "$TOOL_NAME was called"` ，执行时会自动替换成真实的工具名。

### ToolRejectedError

```python
class ToolRejectedError(Exception):
    def __init__(self, tool: str, reason: str, hook_id: str):
        self.tool = tool
        self.reason = reason
        self.hook_id = hook_id
```

这是 Hook 系统唯一向外「冒泡」的异常。当 pre-tool Hook 拒绝了一个工具调用时，Agent Loop 会收到这个错误，把拒绝原因作为工具执行结果返回给 LLM。

## 生命周期事件

```python
class LifecycleEvent(StrEnum):
    SESSION_START = "session_start"
    SESSION_END = "session_end"
    TURN_START = "turn_start"
    TURN_END = "turn_end"
    PRE_TOOL_USE = "pre_tool_use"
    POST_TOOL_USE = "post_tool_use"
    # ... 以及 PRE_SEND, POST_RECEIVE, STARTUP,
    # SHUTDOWN, ERROR, COMPACT 等共 15 种
```

Python 版定义了 15 种事件，覆盖了 Agent 生命周期的各个阶段。其中 `pre_tool_use` 和 `post_tool_use` 是最关键的两个：前者能拦截工具执行，后者能在工具执行后做清理或通知。

使用 `StrEnum` 而不是普通的字符串常量，让 loader 在校验时可以用集合操作快速判断事件名是否合法：

```python
_VALID_EVENTS = {e.value for e in LifecycleEvent}
```

## 主流程：RunHooks vs RunPreToolHooks

HookEngine 有两条执行路径，普通事件走 `run_hooks` ，工具拦截走 `run_pre_tool_hooks` 。两条路径的差别在于：后者会检查 `reject` 标志，一旦命中就立即返回拒绝结果，阻断工具执行。

### 通用事件触发

```python
async def run_hooks(self, event: str, ctx: HookContext) -> None:
    matched = self.find_matching_hooks(event, ctx)
    for hook in matched:
        hook.mark_executed()
        if hook.async_exec:
            asyncio.ensure_future(self._run_single(hook, ctx))
        else:
            await self._run_single(hook, ctx)
```

匹配到的 Hook 按顺序执行。如果某个 Hook 标记了 `async_exec` ，用 `asyncio.ensure_future` 扔到后台，不等它跑完就继续下一个。这对「发个通知」之类不需要等结果的场景很实用。

Hook 匹配的逻辑在 `find_matching_hooks` 里，三层过滤：

```python
def find_matching_hooks(self, event: str, ctx: HookContext):
    matched: list[Hook] = []
    for hook in self.hooks:
        if hook.event != event:
            continue
        if not hook.should_run():
            continue
        if hook.condition is not None and not hook.condition.evaluate(ctx):
            continue
        matched.append(hook)
    return matched
```

第一层按事件名过滤，第二层检查 `once` 标记，第三层做条件表达式求值。三层都通过才算匹配。

### 工具拦截：pre-tool 的特殊路径

```python
async def run_pre_tool_hooks(self, ctx: HookContext) -> ToolRejectedError | None:
    matched = self.find_matching_hooks("pre_tool_use", ctx)
    for hook in matched:
        hook.mark_executed()
        try:
            result = await execute_action(hook.action, ctx)
            self._notifications.append(...)
            if hook.reject:
                return ToolRejectedError(tool=ctx.tool_name,
                    reason=result.output, hook_id=hook.id)
        except Exception as e:
            log.warning("Hook '%s' execution error: %s", hook.id, e)
    return None
```

和 `run_hooks` 最大的区别是返回值。 `run_hooks` 返回 `None` ，它只是「通知」性质的； `run_pre_tool_hooks` 返回 `ToolRejectedError | None` ，它能「阻断」工具执行。

注意 `reject` 标记的判断放在 action 执行之后。也就是说，即使要拒绝工具调用，也会先执行 Hook 的动作（比如记录日志），然后才返回拒绝。这个设计让拒绝 Hook 的 action 输出可以作为拒绝原因传回给 LLM。

### prompt 消息的收集和消费

```python
async def _run_single(self, hook: Hook, ctx: HookContext):
    try:
        result = await execute_action(hook.action, ctx)
        if hook.action.type == "prompt" and result.success:
            self._prompt_messages.append(result.output)
        # ...
```

当 Hook 的 action 类型是 `prompt` 时，执行结果不是「做了什么」，而是「往对话里注入一段消息」。这些消息攒在 `_prompt_messages` 列表里，Agent Loop 每轮迭代前通过 `get_prompt_messages` 取走：

```python
def get_prompt_messages(self) -> list[str]:
    messages = list(self._prompt_messages)
    self._prompt_messages.clear()
    return messages
```

取走就清空，是一次性消费的模式。这让 Hook 可以在特定时机向 LLM 注入提示词，比如在 `turn_start` 时提醒 LLM 某些约束。

## 条件匹配

### 运算符

条件系统支持四种运算符：

```python
_OPERATORS = ("==", "!=", "=~", "~=")
```

`==` 和 `!=` 是精确匹配； `=~` 用正则表达式匹配； `~=` 用 glob 模式匹配（fnmatch）。每种运算符的实现都很直接：

```python
def evaluate(self, ctx: HookContext) -> bool:
    field_value = ctx.get_field(self.field)
    if self.operator == "==":
        return field_value == self.value
    if self.operator == "!=":
        return field_value != self.value
    if self.operator == "=~":
        pattern = self.value
        if pattern.startswith("/") and pattern.endswith("/"):
            pattern = pattern[1:-1]
        return bool(re.search(pattern, field_value))
    if self.operator == "~=":
        return fnmatch.fnmatch(field_value, self.value)
```

正则匹配支持 `/pattern/` 这种带斜杠的写法，也支持不带斜杠直接写。如果正则本身有语法错误，默认返回 `False` 而不是抛异常，这是防御性编程的体现。

### 组合条件

```python
@dataclass
class ConditionGroup:
    conditions: list[Condition] = field(default_factory=list)
    logic: str = "and"

    def evaluate(self, ctx: HookContext) -> bool:
        if not self.conditions:
            return True
        if self.logic == "and":
            return all(c.evaluate(ctx) for c in self.conditions)
        return any(c.evaluate(ctx) for c in self.conditions)
```

条件可以用 `&&` 或 `||` 组合，但不能混用。这是有意为之的限制：

```python
if has_and and has_or:
    raise ConditionParseError(
        "Cannot mix '&&' and '||' in a single condition expression. "
        "Split into separate hooks instead."
    )
```

为什么不支持混用？因为一旦支持就需要处理优先级和括号，解析器的复杂度会飙升。Hook 配置是给用户写的，不是编程语言，简单的逻辑组合完全够用。如果真的需要复杂条件，拆成多个 Hook 反而更清晰。

## 动作执行器

四种动作类型通过一个分发表路由：

```python
_EXECUTOR_MAP = {
    "command": execute_command,
    "prompt": execute_prompt,
    "http": execute_http,
    "agent": execute_agent,
}

async def execute_action(action: Action, ctx: HookContext):
    executor = _EXECUTOR_MAP.get(action.type)
    if executor is None:
        return ActionResult(output=f"Unknown action type: {action.type}",
                            success=False)
    return await executor(action, ctx)
```

### command 执行器

```python
async def execute_command(action: Action, ctx: HookContext):
    command = ctx.expand(action.command)
    proc = await asyncio.create_subprocess_shell(
        command, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT)
    try:
        stdout, _ = await asyncio.wait_for(
            proc.communicate(), timeout=action.timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return ActionResult(output="Command timed out", success=False)
```

先做模板变量替换，然后用 `asyncio.create_subprocess_shell` 启动子进程。stderr 合并到 stdout（ `STDOUT` 参数），这样只需要处理一个输出流。

超时处理是亮点：用 `asyncio.wait_for` 包装 `communicate()` ，超时后先 `proc.kill()` 再 `await proc.wait()` 确保进程真的退出了。如果只 kill 不 wait，可能会留下僵尸进程。

判断成功失败靠返回码：

```python
return ActionResult(
    output=output, success=proc.returncode == 0
)
```

### prompt 执行器

```python
async def execute_prompt(action: Action, ctx: HookContext):
    message = ctx.expand(action.message)
    return ActionResult(output=message, success=True)
```

prompt 执行器是最简单的，它什么都不「做」，只是把模板展开后的消息返回。这个消息会被引擎收集到 `_prompt_messages` 里，后续注入到对话中。

### http 执行器

```python
async def execute_http(action: Action, ctx: HookContext):
    url = ctx.expand(action.url)
    body = ctx.expand(action.body) if action.body else None
    # ... header 处理省略 ...
    def _do_request() -> ActionResult:
        req = Request(url, data=data, headers=headers, method=method)
        with urlopen(req, timeout=30) as resp:
            resp_body = resp.read().decode(errors="replace")[:500]
            return ActionResult(output=f"HTTP {resp.status}: {resp_body}",
                                success=200 <= resp.status < 300)

    return await loop.run_in_executor(None, _do_request)
```

HTTP 请求用标准库的 `urllib` ，但因为 `urlopen` 是阻塞调用，用 `run_in_executor` 丢到线程池里执行。响应体截断到 500 字符，防止超大响应撑爆内存。

### agent 执行器（预留）

```python
async def execute_agent(action: Action, ctx: HookContext):
    log.info("Agent executor stub called with prompt: %s",
             prompt[:100])
    return ActionResult(
        output="agent executor not yet implemented",
        success=True,
    )
```

agent 类型的执行器只是个占位，还没有实现。这预示了一个方向：Hook 未来可以直接触发 SubAgent 执行。

## 配置加载

loader.py 做的是「从 YAML 原始数据到 Hook 对象」的转换和校验。校验逻辑很严格，每一步都有明确的错误信息：

```python
_VALID_ACTION_TYPES = {"command", "prompt", "http", "agent"}

_REQUIRED_FIELDS: dict[str, list[str]] = {
    "command": ["command"],
    "prompt": ["message"],
    "http": ["url"],
    "agent": ["prompt"],
}
```

不同 action 类型有不同的必填字段。这个映射表让校验逻辑不用写一堆 if-else。

有两条约束值得注意：

```python
reject = bool(entry.get("reject", False))
if reject and event != "pre_tool_use":
    raise HookConfigError(
        f"{label}: 'reject' can only be used with "
        f"'pre_tool_use' event"
    )

async_exec = bool(entry.get("async", False))
if async_exec and event == "pre_tool_use":
    raise HookConfigError(
        f"{label}: 'async' cannot be used with "
        f"'pre_tool_use' event"
    )
```

`reject` 只能用在 `pre_tool_use` 事件上，因为只有工具执行前的 Hook 才有「拦截」的语义。 `async` 不能和 `pre_tool_use` 一起用，因为异步执行意味着不等结果，而拦截必须等结果才知道要不要放行。这两条规则在配置加载阶段就校验了，而不是等到运行时才报错，fail-fast。

## 小结

| 设计决策 | Python 的实现方式 |
| --- | --- |
| 事件系统 | `StrEnum` 定义 15 种生命周期事件 |
| 条件匹配 | 四种运算符 + `&&` / `||` |
| 动作分发 | 字典映射 `_EXECUTOR_MAP`，策略模式 |
| 异步执行 | `asyncio.ensure_future` 扔到后台 |
| 命令超时 | `asyncio.wait_for` + `proc.kill()` |
| HTTP 请求 | `run_in_executor` 包装阻塞调用 |
| 工具拦截 | `run_pre_tool_hooks` 独立路径，返回 `ToolRejectedError` |
| 消息注入 | `_prompt_messages` 列表，一次性消费 |
| 配置校验 | `Loader` 层 `fail-fast`，`reject` 和 `async` 互斥校验 |
