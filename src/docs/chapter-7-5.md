# Python源码解析：MCP 协议与工具适配

派大星 6月12日修改

> 理论篇讲了 MCP 协议的设计理念和三阶段会话流程，这篇带你走读 Python 版 MewCode 的真实代码，看看同样的协议桥接在异步 Python 里是怎么落地的。

## 模块概览

MCP 的代码分布在 `mewcode/mcp/` 目录下，一共三个文件：

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `manager.py` | 70 | 管理多个 MCP 服务器的生命周期，统一注册和关闭 |
| `client.py` | 108 | 单个 MCP 连接的建立、维护和销毁 |
| `tool_wrapper.py` | 109 | 把 MCP 工具定义适配成 MewCode 内部的 Tool 接口 |

三个文件加起来不到 300 行，按职责拆成了三个模块，各自内聚。 `manager.py` 不关心连接细节， `client.py` 不关心工具注册， `tool_wrapper.py` 不关心连接管理。每个模块只需要理解自己那一层的逻辑。

## 核心类型

### MCPManager：多连接调度中心

```python
class MCPManager:
    def __init__(self) -> None:
        self._configs: dict[str, MCPServerConfig] = {}
        self._clients: dict[str, MCPClient] = {}
```

两个字典，一个存配置，一个存已连接的客户端。用服务器名做 key，结构清晰。Python 用前缀下划线标记「这是内部状态，外面不要直接碰」，是 Python 社区的封装约定。

配置加载走 `load_configs` ，把列表转成字典：

```python
def load_configs(self, configs: list[MCPServerConfig]) -> None:
    for cfg in configs:
        self._configs[cfg.name] = cfg
```

这里没有做去重检查。如果两个配置同名，后面的会覆盖前面的。这其实是合理的，多个配置源（全局 + 项目级）需要支持覆盖语义。

### MCPClient：单个 MCP 连接

```python
class MCPClient:
    def __init__(self, config: MCPServerConfig) -> None:
        self.config = config
        self.name = config.name
        self._session: ClientSession | None = None
        self._stack: AsyncExitStack | None = None
        self._alive = False
```

三个状态字段值得注意。 `_session` 是 MCP SDK 提供的会话对象，所有协议操作都走它。 `_stack` 是 `AsyncExitStack` ，Python 特有的异步资源管理器，后面会详细讲。 `_alive` 是布尔标志位，用来快速判断连接是否存活。

`is_alive` 暴露为只读属性：

```python
@property
def is_alive(self) -> bool:
    return self._alive
```

用 `@property` 而不是普通方法，调用方写 `client.is_alive` 而不是 `client.is_alive()` 。这是 Python 的惯用法，表示这是一个状态查询，不是一个会触发副作用的操作。

### MCPToolWrapper：协议适配器

```python
class MCPToolWrapper(Tool):
    def __init__(self, server_name, tool_def, client):
        self._server_name = server_name
        self._tool_def = tool_def
        self._client = client
        self.name = f"mcp_{server_name}_{tool_def.name}"
        self.description = tool_def.description or tool_def.name
        self.category = "command"
        self.is_concurrency_safe = False
        self.should_defer = True
```

继承自 MewCode 的 `Tool` 基类，在构造函数里直接设置了所有必需属性。 `should_defer = True` 表示这是延迟加载工具，不会在初始化时塞进 system prompt，因为 MCP 工具数量不可控。 `is_concurrency_safe = False` 表示 MCP 工具不允许并行执行，因为底层协议连接可能不是线程安全的。

注意名字格式是 `mcp_<server>_<tool>` ，用单下划线分隔。核心思路是名字要能反向定位到是哪个服务器的哪个工具，方便调试和日志追踪。

## 主流程走读

### 第一步：connect，建连接

```python
async def connect(self) -> None:
    if self._alive:
        return
    self._stack = AsyncExitStack()
    await self._stack.__aenter__()
```

开头的 `if self._alive: return` 是幂等保护，重复调用不会创建多余连接。 `AsyncExitStack` 是 Python 处理多层异步资源的标准工具，它像一个栈，资源按进入顺序压栈，关闭时按 LIFO 顺序弹出。

接下来根据配置选择传输层，建立会话：

```python
try:
        if self.config.is_stdio:
            read, write = await self._connect_stdio()
        else:
            read, write = await self._connect_http()
        session = await self._stack.enter_async_context(
            ClientSession(read, write))
        await session.initialize()
        self._session, self._alive = session, True
    except Exception:
        await self._cleanup_stack()
        raise
```

`try/except` 确保连接失败时清理已分配的资源，不会泄漏。

Stdio 连接的细节：

```python
async def _connect_stdio(self):
    params = StdioServerParameters(
        command=self.config.command,
        args=self.config.args,
        env=build_child_env(self.config.env),
    )
    read, write = await self._stack.enter_async_context(
        stdio_client(params)
    )
    return read, write
```

`StdioServerParameters` 来自 MCP SDK，它会启动子进程并用 stdin/stdout 做通信。 `build_child_env` 负责把配置里的环境变量注入到子进程环境中，同时做 `${VAR}` 的展开。整个子进程的生命周期由 `AsyncExitStack` 管理，关闭 stack 时子进程也会被终止。

HTTP 连接要多处理一个 Headers 环境变量展开的问题：

```python
async def _connect_http(self) -> tuple[Any, Any]:
    resolved_headers = {
        k: resolve_env_vars(v)
        for k, v in self.config.headers.items()
    }
    http_client = httpx.AsyncClient(
        headers=resolved_headers,
        follow_redirects=True,
    )
    await self._stack.enter_async_context(http_client)
```

`resolve_env_vars` 把 Header 值中的 `${API_KEY}` 替换成实际环境变量。典型场景是 MCP 服务器需要 API Token 认证，Token 不应该硬编码在配置文件里。

### 第二步：list\_tools，发现工具

```python
async def list_tools(self) -> list[types.Tool]:
    assert self._session is not None
    result = await self._session.list_tools()
    return list(result.tools)
```

一行调用，返回工具定义列表。 `assert` 确保只在连接建立后才能调用。 `list()` 是防御性复制，调用方拿到的是一份独立拷贝，不会影响 session 内部状态。

### 第三步：call\_tool，执行工具

```python
async def call_tool(
    self, name: str, arguments: dict[str, Any]
) -> types.CallToolResult:
    assert self._session is not None
    return await self._session.call_tool(name, arguments)
```

同样极其简洁。返回 `CallToolResult` 对象，里面的 `content` 是多态内容列表（文本、图片等）， `isError` 标记业务层面是否失败。这两个信息的拆解交给 `MCPToolWrapper` 去做。

## 工具适配器

`MCPToolWrapper` 要解决的核心问题是：Agent Loop 使用统一的 Tool 接口调用工具，而 MCP 返回的工具定义格式和 MewCode 内部格式不一样。适配器要做两件事：把 MCP 的 schema 转成 MewCode 的 schema，把 MCP 的调用结果转成 MewCode 的 ToolResult。

### 参数模型生成

Python 版用 Pydantic 动态生成参数验证模型，让 MCP 工具也享受到类型安全的参数校验。

```python
def _build_params_model(tool_name, input_schema):
    properties = input_schema.get("properties", {})
    required = set(input_schema.get("required", []))
    field_definitions = {}
    for name, prop in properties.items():
        py_type = _json_type_to_python(prop.get("type", "string"))
        if name in required:
            field_definitions[name] = (py_type, ...)
        else:
            field_definitions[name] = (py_type | None, None)
    return create_model(f"{tool_name}Params", **field_definitions)
```

`create_model` 是 Pydantic 提供的动态模型生成器。它根据 MCP 工具的 JSON Schema 在运行时创建一个 Python 类。 `(py_type, ...)` 表示必填字段， `(py_type | None, None)` 表示可选字段，默认值为 `None` 。

JSON 类型到 Python 类型的映射很直接：

```python
def _json_type_to_python(json_type: str) -> type:
    mapping: dict[str, type] = {
        "string": str,
        "integer": int,
        "number": float,
        "boolean": bool,
        "object": dict,
        "array": list,
    }
    return mapping.get(json_type, str)
```

遇到不认识的类型就回退到 `str` 。这不是偷懒，是防御性设计。MCP 服务器可能返回非标准类型，与其报错不如按字符串处理。

### 执行逻辑：连接保活 + 错误处理

`execute` 方法是适配器最核心的部分，它处理了三层问题：

```python
async def execute(self, params: BaseModel) -> ToolResult:
    if not self._client.is_alive:
        try:
            await self._client.connect()
        except Exception as e:
            return ToolResult(
                output=f"reconnect failed: {e}",
                is_error=True)
```

第一层，检查连接是否存活。如果连接断了就尝试重连。重连失败返回错误结果，不抛异常。Agent 会看到工具执行失败的信息，可以决定怎么处理。

```python
try:
        result = await self._client.call_tool(
            self._tool_def.name,
            params.model_dump(exclude_none=True))
    except Exception as e:
        self._client._alive = False
        return ToolResult(output=f"MCP tool call failed: {e}", is_error=True)
    text = _extract_text(result.content)
    return ToolResult(output=text, is_error=bool(result.isError))
```

第二层，调用工具。 `params.model_dump(exclude_none=True)` 把 Pydantic 模型转回字典，同时排除值为 `None` 的可选字段。传给 `call_tool` 的是 `self._tool_def.name` （原始 MCP 工具名），不是 `self.name` （带 `mcp_` 前缀的名字）。调用失败时把 `_alive` 设为 `False` ，下次再调就会触发重连。

第三层，提取文本内容。MCP 返回的 `content` 是多态列表，需要把不同类型的内容拼接成纯文本：

```python
def _extract_text(content: list[Any]) -> str:
    parts: list[str] = []
    for block in content:
        if isinstance(block, mcp_types.TextContent):
            parts.append(block.text)
        elif isinstance(block, mcp_types.ImageContent):
            parts.append(f"[image: {block.mimeType}]")
        elif isinstance(block, mcp_types.EmbeddedResource):
            resource = block.resource
            if hasattr(resource, "text"):
                parts.append(resource.text)
            else:
                parts.append(f"[binary resource: {resource.uri}]")
    return "
".join(parts) if parts else "(no output)"
```

文本内容直接取 `text` ，图片和二进制资源只保留一个占位描述。空结果返回 `(no output)` 。这个处理策略优先保证文本内容的完整传递，对于非文本内容则给出足够的元信息让 Agent 知道返回了什么类型的数据。

### Schema 透传

```python
def get_schema(self) -> dict[str, Any]:
    return {
        "name": self.name,
        "description": self.description,
        "input_schema": self._tool_def.inputSchema,
    }
```

直接把 MCP 工具的 `inputSchema` 透传给 LLM。不做任何转换，LLM 看到的参数描述和 MCP 服务器定义的完全一致。

## 延迟加载：评分搜索机制

MCPToolWrapper 构造时设置了 `self.should_defer = True` ，所有 MCP 工具默认不进工具列表。LLM 需要使用时通过 ToolSearch 按需加载。

Python 版的延迟搜索实现了一套评分机制，让搜索结果按相关性排序：

```python
def search_deferred(
    self, query: str, max_results: int,
    protocol: str = "anthropic",
) -> list[dict[str, Any]]:
    query_lower = query.lower()
    scored: list[tuple[int, str, Tool]] = []
    for name, tool in self._tools.items():
        if not getattr(tool, "should_defer", False):
            continue
        score = 0
        name_lower = name.lower()
        desc_lower = (tool.description or "").lower()
```

评分计算分四层：

```python
if query_lower in name_lower:
            score += 10
        if query_lower in desc_lower:
            score += 5
        for word in query_lower.split():
            if word in name_lower:
                score += 3
            if word in desc_lower:
                score += 1
        if score > 0:
            scored.append((score, name, tool))
    scored.sort(key=lambda x: x[0], reverse=True)
```

完整查询串匹配工具名得 10 分，匹配描述得 5 分。然后把查询拆成单词，每个词匹配工具名得 3 分，匹配描述得 1 分。最后按总分降序排列，取前 `max_results` 个。名称匹配比描述匹配更精确，完整匹配比单词匹配更可靠。LLM 搜索「notebook edit」时，名字里包含完整「notebook edit」的工具排最前面，名字里只包含「notebook」或「edit」单词的排后面。

和评分搜索配套的还有精确查找模式：

```python
def find_deferred_by_names(
    self, names: list[str],
    protocol: str = "anthropic",
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for name in names:
        tool = self._tools.get(name)
        if tool is None:
            continue
        if not getattr(tool, "should_defer", False):
            continue
        base = tool.get_schema()
        # ... protocol adaptation ...
    return results
```

LLM 已经知道工具名字时，用 `select:ToolA,ToolB` 语法直接按名称拉取，跳过评分计算。找到的工具通过 `mark_discovered()` 标记，下一轮 `get_all_schemas()` 就会包含它们。

和 Go、Java 版的简单包含匹配相比，Python 版的评分搜索在工具数量较多时能给出更相关的结果，但核心流程是一样的：搜索、返回 schema、标记已发现、下一轮可用。

## 连接管理

### 启动时全量注册

`register_all_tools` 是系统启动时的入口：

```python
async def register_all_tools(self, registry):
    errors = []
    for name, config in self._configs.items():
        try:
            client = MCPClient(config)
            await client.connect()
            self._clients[name] = client
            for td in await client.list_tools():
                registry.register(MCPToolWrapper(name, td, client))
        except Exception as e:
            errors.append(f"MCP server '{name}': {e}")
    return errors
```

逐个连接 MCP 服务器，拉取工具列表，包装成 `MCPToolWrapper` 注册到全局工具注册表。一个服务器失败不影响其他服务器，错误收集到列表里统一返回。 `logger.warning` 让运维人员在日志里看到哪些服务器连接失败了。

### 延迟获取与自动重连

`get_client` 是另一个获取客户端的入口，带延迟初始化和重连能力：

```python
async def get_client(self, name):
    client = self._clients.get(name)
    if client is None:
        config = self._configs.get(name)
        if config is None: return None
        client = MCPClient(config)
        await client.connect()
        self._clients[name] = client
        return client
```

客户端不在缓存里就看有没有配置，有就现场创建连接。如果在缓存里但连接断了：

```python
if not client.is_alive:
        await client.close()
        client = MCPClient(self._configs[name])
        await client.connect()
        self._clients[name] = client
    return client
```

先关掉旧的，重新创建一个。每次重连都创建新的 `MCPClient` 实例而不是在旧实例上重连，避免旧的 `AsyncExitStack` 状态混乱。

### 优雅关闭

```python
async def shutdown(self) -> None:
    for name, client in self._clients.items():
        try:
            await client.close()
        except Exception:
            logger.debug("Error closing MCP server '%s'",
                         name, exc_info=True)
    self._clients.clear()
```

遍历关闭所有客户端。关闭失败只记 debug 日志，不抛异常。因为这是程序退出前的清理阶段，一个连接关不掉不应该阻止其他连接的清理。 `self._clients.clear()` 清空字典，即使有些 close 失败了也不保留失效的引用。

`client.close()` 内部的资源释放通过 `AsyncExitStack` 完成：

```python
async def close(self) -> None:
    self._alive = False
    self._session = None
    await self._cleanup_stack()

async def _cleanup_stack(self) -> None:
    if self._stack is not None:
        try:
            await self._stack.__aexit__(None, None, None)
        except Exception:
            logger.debug("Error closing stack for '%s'",
                         self.name, exc_info=True)
        self._stack = None
```

先标记死亡，再释放资源。顺序不能反，否则在资源释放过程中如果有并发调用检查 `is_alive` ，可能误判为存活。 `__aexit__` 的三个 `None` 表示正常退出而非异常退出，这样 context manager 不会尝试做异常处理逻辑。

## 小结

| 设计决策 | Python 的实现方式 |
| --- | --- |
| 传输层选择 | `config.is_stdio` 分派到 `_connect_stdio` / `_connect_http` |
| 资源管理 | `AsyncExitStack` 统一管理子进程、HTTP 客户端、MCP 会话 |
| 工具发现 | `session.list_tools()` → 逐个包装成 `MCPToolWrapper` |
| 参数验证 | Pydantic `create_model` 动态生成参数模型 |
| 工具调用 | `MCPToolWrapper.execute()` → `client.call_tool()` → `session.call_tool()` |
| 名字安全 | `mcp_<server>_<tool>` ，f-string 直接拼接 |
| 延迟加载 | `should_defer = True` ，评分搜索（10/5/3/1 分制）+ mark\_discovered 激活 |
| 连接保活 | `is_alive` 属性 + execute 时自动重连 |
| 容错 | 单个服务器失败不阻断，错误收集统一返回 |
