# Python源码解析：命令注册与分发

派大星 6月12日 13:20

> 理论篇讲了 Slash Command 的设计理念和分类方式，这篇走读 Python 版 MewCode 的命令系统代码。这个模块麻雀虽小五脏俱全，涵盖了解析、注册、分发、自动补全四个环节，还有十多个内置命令的具体实现。

## 模块概览

命令系统的代码在 `mewcode/commands/` 目录下：

| 文件/目录 | 行数 | 职责 |
| --- | --- | --- |
| `parser.py` | 29 | 命令解析：从用户输入中提取命令名和参数 |
| `registry.py` | 94 | 核心：命令注册中心，类型定义，查找和匹配 |
| `completion.py` | 53 | TUI 补全弹窗：用户输入 `/` 时的候选列表 |
| `handlers/__init__.py` | 32 | 聚合所有内置命令，批量注册 |
| `handlers/*.py` | 15 个文件 | 每个文件实现一个命令 |

总共不到 700 行。命令系统的复杂度不在单个文件，而在它连接了 Agent、UI、会话管理、记忆、权限等几乎所有模块。

## 核心类型

### CommandType：三种命令分类

```python
class CommandType(str, Enum):
    LOCAL = "local"
    LOCAL_UI = "local_ui"
    PROMPT = "prompt"
```

这三种类型决定了命令的执行方式。 `LOCAL` 是纯本地逻辑，比如 `/help` 查看帮助、 `/status` 显示状态，不涉及 LLM。 `LOCAL_UI` 也是本地逻辑但需要操作 TUI 状态，比如 `/clear` 清屏、 `/plan` 切换模式。 `PROMPT` 最特殊，它生成一段文本发给 LLM，比如 `/review` 会构造一段「请审查当前 git diff」的 prompt。

### UIController：命令和 UI 的接口

```python
class UIController(Protocol):
    def add_system_message(self, text: str) -> None: ...
    def send_user_message(self, text: str) -> None: ...
    def set_plan_mode(self, enabled: bool) -> None: ...
    def get_token_count(self) -> tuple[int, int]: ...
    def refresh_status(self) -> None: ...
```

用 `Protocol` 定义接口而不是抽象基类。命令 handler 只依赖这个协议，不知道 TUI 的具体实现。这意味着可以在测试中传入一个 mock 对象，不用启动真正的 Textual 界面。

五个方法覆盖了命令和 UI 之间的所有交互：输出消息、发送用户输入（让 PROMPT 类型命令能触发 LLM）、切换模式、获取 token 统计、刷新状态栏。

### CommandContext：传给 handler 的运行时上下文

```python
@dataclass
class CommandContext:
    args: str
    agent: Any
    conversation: Any
    session: Any
    session_manager: Any
    memory_manager: Any
    ui: UIController
    config: Any
```

一个命令被执行时，能拿到整个系统的几乎所有组件。 `args` 是命令名后面的参数部分， `agent` 是 Agent 实例， `conversation` 是当前对话管理器， `session` 是当前会话， `memory_manager` 是记忆管理器， `ui` 是界面控制器。

`config` 是一个 `Any` 类型的字典，用来传递一些不好放进固定字段的东西，比如 `set_session` 、 `set_conversation` 、 `clear_chat` 这类回调函数。这种做法灵活但类型安全性差，是一个实用主义的折衷。

### Command：命令定义

```python
@dataclass
class Command:
    name: str
    description: str
    type: CommandType
    handler: CommandHandler
    aliases: list[str] = field(default_factory=list)
    usage: str = ""
    arg_prompt: str = ""
    hidden: bool = False
```

`handler` 的类型是 `Callable[[CommandContext], Awaitable[None]]` ，也就是一个异步函数。所有命令 `handler` 都是 async 的，即使有些命令（如 `/help` ）不需要异步操作。统一用 async 避免了在分发层区分同步和异步的复杂度。

`hidden` 字段让某些命令不出现在 `/help` 列表里，但仍然可以通过直接输入来使用。

## 主流程：parse → find → dispatch

### 解析：从文本到命令名

```python
def parse_command(
    text: str,
) -> tuple[str, str, bool]:
    text = text.strip()
    if not text.startswith("/"):
        return "", "", False
    text = text[1:]
    if not text:
        return "", "", True
    parts = text.split(None, 1)
    name = parts[0].lower()
    args = parts[1].strip() if len(parts) > 1 else ""
    return name, args, True
```

返回值是一个三元组： `(命令名, 参数, 是否是命令)` 。第三个布尔值很关键。如果用户输入不是以 `/` 开头的，返回 `False` ，调用方就知道这是普通文本，应该发给 LLM 而不是命令系统。

`split(None, 1)` 是 Python 的一个技巧：第一个参数 `None` 表示按任意空白分割， `1` 表示只分割一次。这样 `/review fix the bug in parser` 会被分成 `["review", "fix the bug in parser"]` ，参数部分保持原样，不会被进一步拆分。

命令名转小写处理，所以 `/Help` 、 `/HELP` 、 `/help` 是等价的。

### 查找：从命令名到 Command 对象

```python
class CommandRegistry:
    def __init__(self) -> None:
        self._commands: dict[str, Command] = {}
        self._alias_map: dict[str, str] = {}

    def find(self, name: str) -> Command | None:
        if name in self._commands:
            return self._commands[name]
        canon = self._alias_map.get(name)
        if canon:
            return self._commands.get(canon)
        return None
```

两层查找：先在主命令表里找，找不到再去别名表找。别名表存的是 `别名 → 主命令名` 的映射，所以不管你输入 `/h` 、 `/?` 还是 `/help` ，最终都找到同一个 `Command` 对象。

### 注册：防冲突检查

```python
def register_sync(self, command: Command) -> None:
    if command.name in self._commands \
            or command.name in self._alias_map:
        raise ValueError(
            f"Command name '{command.name}' conflicts"
        )
    for alias in command.aliases:
        if alias in self._alias_map \
                or alias in self._commands:
            raise ValueError(
                f"Alias '{alias}' conflicts"
            )
    self._commands[command.name] = command
    for alias in command.aliases:
        self._alias_map[alias] = command.name
```

注册时检查命令名和所有别名是否和已有的命令或别名冲突。注意别名不能和另一个命令的主名字冲突，主名字也不能和另一个命令的别名冲突。这种双向检查防止了 `/h` 同时是 `/help` 的别名又是另一个命令的主名字的混乱局面。

还有一个 `register` 的 async 版本，用 `asyncio.Lock()` 保护并发注册。这是为 Skill 动态注册命令准备的，因为 Skill 加载可能在后台异步进行。

### 自动补全

```python
def complete(
    registry: CommandRegistry, prefix: str,
) -> list[str]:
    prefix = prefix.lstrip("/")
    matches: list[str] = []
    for cmd in registry.list_commands():
        if cmd.name.startswith(prefix):
            matches.append("/" + cmd.name)
        for alias in cmd.aliases:
            if alias.startswith(prefix):
                matches.append("/" + alias)
    matches.sort()
    return matches
```

用户输入 `/h` 时，补全函数会遍历所有非隐藏命令，找出名字或别名以 `h` 开头的，返回 `["/h", "/help"]` 。

TUI 那边用 Textual 的 `OptionList` 组件把这些候选项展示成一个弹窗：

```python
class CompletionPopup(Vertical):
    class Selected(TMessage):
        def __init__(self, value: str) -> None:
            super().__init__()
            self.value = value

    def show(self, items: list[str]) -> None:
        ol = self.query_one(
            "#completion-list", OptionList
        )
        ol.clear_options()
        for item in items:
            ol.add_option(Option(item, id=item))
        self.display = True
        ol.focus()
```

弹窗是 dock 在底部的，选中后发一个 `Selected` 消息给父组件，父组件把选中的命令填入输入框。

## 内置命令速览

| 命令 | 别名 | 类型 | 职责 |
| --- | --- | --- | --- |
| `/help` | `/h` , `/?` | `LOCAL` | 显示帮助信息，支持 `/help <cmd>` 查看单个命令 |
| `/status` | `/s` | `LOCAL` | 显示模式、Token、工具数、记忆数、版本 |
| `/compact` | `/c` | `LOCAL` | 手动触发上下文压缩 |
| `/clear` |  | `LOCAL_UI` | 清除对话，创建新会话 |
| `/plan` | `/p` | `LOCAL_UI` | 切换到 Plan 只读模式 |
| `/do` |  | `LOCAL_UI` | 切换回执行模式 |
| `/session` |  | `LOCAL` | 会话管理（list/resume/new/delete） |
| `/memory` |  | `LOCAL` | 记忆管理（list/clear/edit） |
| `/permission` | `/perm` | `LOCAL` | 权限管理（mode/rules/add/reset） |
| `/review` |  | `PROMPT` | 审查 git diff |
| `/skill` | `/skills` | `LOCAL` | 管理 Skill 技能包 |
| `/worktree` | `/wt` | `LOCAL` | Git Worktree 管理 |
| `/trace` | `/tree` | `LOCAL` | 查看 Agent 追踪树 |
| `/tasks` | `/task` | `LOCAL` | 管理后台任务 |

## 典型命令实现走读

### /help：最简单的 LOCAL 命令

```python
async def handle_help(ctx: CommandContext) -> None:
    registry = ctx.config["registry"]
    if ctx.args:
        cmd = registry.find(ctx.args.lower())
        if cmd is None:
            ctx.ui.add_system_message(f"未知命令：{ctx.args}")
            return
        ctx.ui.add_system_message(f"/{cmd.name}  {cmd.description}")
        return
    # 无参数：列出所有命令
    lines = ["可用命令："]
    for cmd in registry.list_commands():
        lines.append(f"  /{_format_aliases(cmd):<24} {cmd.description}")
    ctx.ui.add_system_message("\n".join(lines))
```

`/help` 不带参数列出所有命令，带参数显示单个命令的详情。注意 `list_commands()` 只返回非隐藏命令，所以隐藏命令不会出现在列表里，但 `/help hidden_cmd` 仍然能查到它的详情。

### /plan 和 /do：状态切换

```python
async def handle_plan(ctx: CommandContext) -> None:
    ctx.ui.set_plan_mode(True)
    ctx.ui.add_system_message(
        "已切换到 Plan 模式 — 只读，禁止写入和命令执行"
    )
    if ctx.args:
        ctx.ui.send_user_message(ctx.args)
```

`/plan` 切换模式后，如果带了参数（比如 `/plan 分析一下这个目录结构` ），会立即把参数作为用户消息发出去。这让你可以在切换模式的同时提出问题，一步到位。

`/do` 就是反向操作，把 Plan 模式关掉。

### /compact：带前置检查的命令

```python
async def handle_compact(ctx: CommandContext) -> None:
    if ctx.agent is None:
        ctx.ui.add_system_message("Agent 未初始化")
        return

    input_tokens, _ = ctx.ui.get_token_count()
    if input_tokens < 5000:
        ctx.ui.add_system_message(
            f"当前 token 数 {input_tokens:,}，无需压缩"
        )
        return

    result = await ctx.agent.manual_compact(
        ctx.conversation
    )
```

在调用 Agent 的压缩方法之前，先检查 token 数量。低于 5000 时压缩没有意义，直接返回。这种前置检查避免了用户误操作导致的无效 LLM 调用。

### /session：带子命令的复杂命令

```python
async def handle_session(ctx: CommandContext) -> None:
    parts = ctx.args.split(None, 1)
    sub = parts[0] if parts else ""
    if sub == "":        # 显示当前会话信息
    elif sub == "list":  # 列出最近 10 个会话
    elif sub == "resume":# 恢复会话，注入时间间隔提示
    elif sub == "new":   # 创建新会话
    elif sub == "delete":# 删除指定会话
```

`/session` 是最复杂的内置命令。它有五个子命令，其中 `resume` 的实现最有看头：

```python
elif sub == "resume":
    result = sm.resume(session_id)
    if ctx.session:
        ctx.session.close()
    ctx.config["set_session"](result.session)
    conv = ConversationManager()
    for msg in result.messages:
        conv.history.append(msg)
    gap_msg = build_time_gap_message(result.last_active)
    if gap_msg:
        conv.history.append(gap_msg)  # 注入时间间隔提示
    ctx.config["set_conversation"](conv)
```

恢复会话时，先关闭当前会话，再用回调函数 `set_session` 和 `set_conversation` 替换全局状态。这些回调来自 `config` 字典，是 TUI 层注入的。这种设计让命令 handler 不需要直接引用 TUI 的内部状态。

### /review：PROMPT 类型命令

```python
REVIEW_PROMPT = (
    "请审查当前 git diff 中的代码变更。"
    "重点关注：\n"
    "1. 逻辑错误\n2. 安全问题\n"
    "3. 性能问题\n4. 代码风格"
)

async def handle_review(ctx: CommandContext) -> None:
    prompt = REVIEW_PROMPT
    if ctx.args:
        prompt += f"\n\n额外关注：{ctx.args}"
    ctx.ui.send_user_message(prompt)
```

PROMPT 类型的命令不直接产出结果，而是通过 `send_user_message()` 把构造好的 prompt 发给 LLM。用户看到的效果就像自己输入了这段话然后按了回车。

## 文件命令的加载和注册

### 聚合注册

```python
ALL_COMMANDS = [
    HELP_COMMAND, COMPACT_COMMAND, CLEAR_COMMAND,
    PLAN_COMMAND, DO_COMMAND, SESSION_COMMAND,
    MEMORY_COMMAND, PERMISSION_COMMAND,
    STATUS_COMMAND, SKILL_COMMAND,
]

def register_all_commands(
    registry: CommandRegistry,
) -> None:
    for cmd in ALL_COMMANDS:
        registry.register_sync(cmd)
```

所有内置命令在 `handlers/__init__.py` 里集中注册。每个 handler 文件导出一个 `XXX_COMMAND` 常量， `__init__.py` 把它们收集到列表里批量注册。

注意 `/worktree` 、 `/trace` 、 `/tasks` 不在这个列表里。它们需要运行时依赖（ `WorktreeManager` 、 `TraceManager` 、 `TaskManager` ），不能在模块加载时就创建，而是在 TUI 初始化时通过工厂函数动态创建：

```python
def create_worktree_command(
    manager: WorktreeManager,
) -> Command:
    async def handle_worktree(
        ctx: CommandContext,
    ) -> None:
        # 使用闭包捕获 manager
        ...
    return Command(
        name="worktree",
        aliases=["wt"],
        handler=handle_worktree,
        ...
    )
```

工厂函数用闭包把 `manager` 捕获进 handler 里，这样 handler 执行时就能访问到对应的管理器实例。

### Skill 动态注册

Skill 系统可以把自己注册为 Slash Command。这是通过 `skill_register.py` 实现的：

```python
_REGISTERED_SKILL_NAMES: set[str] = set()

def register_skill_commands(registry, loader, executor=None):
    for name in list(_REGISTERED_SKILL_NAMES):  # 清理旧命令
        registry._commands.pop(name, None)
        _REGISTERED_SKILL_NAMES.discard(name)
    for skill_name, skill_desc in loader.get_catalog():  # 注册新命令
        if registry.find(skill_name) is not None:
            continue
        cmd = Command(name=skill_name, description=f"{skill_desc} [skill]",
                      type=CommandType.PROMPT, handler=make_handler(skill_name))
        registry.register_sync(cmd)
        _REGISTERED_SKILL_NAMES.add(skill_name)
```

每次 reload 时先清除旧的 Skill 命令再重新注册。 `_REGISTERED_SKILL_NAMES` 这个模块级别的集合追踪了哪些命令是 Skill 注册的，清理时只清理这些，不会误删内置命令。

Skill 命令的 handler 用 `make_handler` 工厂函数生成，根据 Skill 的 `mode` 决定执行方式： `fork` 模式在后台异步执行， `inline` 模式把 Skill 内容注入上下文然后触发 LLM。

## 小结

| 设计决策 | Python 的实现方式 |
| --- | --- |
| 命令解析 | `split(None, 1)` 一次分割，保留参数原文 |
| 类型系统 | 三种 `CommandType` （LOCAL / LOCAL\_UI / PROMPT） |
| 注册中心 | 双表（主命令 + 别名），双向冲突检查 |
| handler 签名 | 统一 `async` ，接收 `CommandContext` |
| UI 解耦 | `Protocol` 定义接口，handler 不依赖具体 TUI |
| 运行时依赖 | 工厂函数 + 闭包注入 |
| 动态扩展 | Skill 可注册为命令，reload 时清理重建 |
| 自动补全 | 前缀匹配 + Textual OptionList 弹窗 |
