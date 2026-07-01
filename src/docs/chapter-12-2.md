# 实战演练：动手实现 Hook 系统

派大星 6月12日修改

## 本章需要做什么

上一章我们给 MewCode 装上了 Skill 技能包系统，让 Agent 能通过 Slash Command 加载预定义的提示词和工具集合。但每次 Agent 写完文件你还是要手动跑格式化，每次看到危险命令你还是得自己盯着审批弹窗，每次开始新对话你还是要手动说「先读一下 ARCHITECTURE.md」。

这些事情触发条件明确、执行动作固定，完全不需要你来做。这一章要给 MewCode 装上 Hook 系统，让你在 Agent 的生命周期事件上挂载自动化动作。做完之后，格式化、拦截、上下文注入全部自动化，你不用再当人肉 CI。

具体要新增这些东西：

- **事件常量** ：15 个生命周期事件（session\_start/session\_end、turn\_start/turn\_end、pre\_tool\_use/post\_tool\_use、pre\_send/post\_receive、startup/shutdown/error/compact/permission\_request/file\_change/command\_execute）
- **核心数据结构** ：Hook、Action、HookContext、ConditionGroup、Condition、ToolRejectedError
- **条件表达式** ：解析与求值，支持 ==/!=/=~/~= 四种操作符，&&/|| 组合（不可混用）
- **四种执行器** ：command（shell 命令）、prompt（注入提示词）、http（HTTP 请求）、agent（子 Agent，先占位）
- **上下文变量替换** ：$EVENT、$TOOL\_NAME、$FILE\_PATH、$MESSAGE、$ERROR、$TOOL\_ARGS.xxx
- **执行控制** ：once（只执行一次）、async（后台执行）、command 的 timeout 超时
- **拦截机制** ：pre\_tool\_use + reject 返回 ToolRejectedError，LLM 看到拒绝原因后调整策略
- **HookEngine 核心** ：runHooks（非拦截事件）+ runPreToolHooks（pre\_tool\_use 专用）
- **Agent Loop 集成** ：在会话、轮次、消息、工具的生命周期节点插入 Hook 调用
- **配置加载与校验** ：从 YAML 加载，校验事件名、action 类型、reject/async 约束、必填字段

这章 **不做** ：once 标记的持久化（只做运行时标记，重启即重置）、Hook 执行顺序的显式优先级字段、agent 执行器的真实实现（留给后续的 SubAgent 章节）。

## Vibe Coding 实战

### 生成三份文档

把任务换成本章的内容：

```markdown
# 我的初步想法
- 用「事件 + 条件 + 动作」三要素描述一条规则；条件可省略表示无条件触发，事件和动作必须有
- 生命周期事件覆盖四个层级：会话级（会话起止）、轮次级（轮次起止）、消息级（发送前/接收后）、工具级（执行前/执行后），再加少量系统级事件（启动、退出、错误、压缩等）
- 工具执行前的事件具有拦截能力，可以基于工具参数内容做细粒度安全策略，被拦截后把拒绝原因作为工具结果反馈给 LLM，形成「拦截 → Agent 收到原因 → Agent 调整策略」的循环
- 条件表达式复用权限规则的匹配语法，支持精确、反向、正则、glob 四种操作符，逻辑组合用「全部满足」或「任一满足」二选一，不允许混用（避免引入运算符优先级和完整表达式引擎）
- 四种动作执行器：执行 shell 命令、注入提示词消息、发起 HTTP 请求、启动子 Agent（子 Agent 这种先占位）
- 执行控制三件套：只执行一次、后台异步执行、命令超时；并强制工具拦截类事件不允许异步
- 动作模板里支持上下文变量占位（事件名、工具名、文件路径、消息内容、错误信息、工具参数字段），未定义变量替换为空串而不是报错
- 辅助机制错误隔离原则：Hook 自身执行失败只记日志，绝不中断 Agent 主流程
- 从 YAML 声明式加载规则，加载时集中校验事件名、动作类型、拦截字段只能用在执行前事件、异步标记不能用在拦截事件、各动作类型必填字段，非法配置要能定位到具体规则
- 引擎需要嵌入 Agent Loop 的关键节点：会话起止、轮次起止、消息发送前/接收后、工具执行前（同步、可拦截）、工具执行后
```

然后 AI 就会开始问你问题，进行需求澄清。

你根据理论篇学到的内容回答这些问题，一直这样反复循环对齐需求，最后就能生成三份文档了。

### 正式开发

三份文档有了之后，就相当于施工图纸已经定好了，然后让 Claude Code 根据这三份文档进行开发

![](images/chapter-12-2/img-1.png)

经过一段时间后，开发完成。

![](images/chapter-12-2/img-2.png)

### 功能验证过程

来验收一下结果

写一个测试用的 `hooks` 配置

```yaml
# Hooks
hooks:

  # pre_tool_use 拦截写 *.json（reject + on_error 兜底）
  # 注意：LLM 给的 file_path 通常是绝对路径，glob 的 * 不跨 / 分隔符，
  # 所以这里用正则按后缀匹配（=~ /\.json$/）而不是 =* "*.json"
  - id: block-json-write
    event: pre_tool_use
    if: 'tool == "WriteFile" && args.file_path =~ /\.json$/'
    action:
      type: command
      command: 'echo "禁止直接写入 JSON 文件，请使用专用工具"'
    reject: true
```

然后我们打开MewCode，去试试这个hooks，我们输入

> 帮我创建 config.json，内容是 {}

![](images/chapter-12-2/img-3.png)

Agent 调用 WriteFille工具时会被 hook 拦截，收到"禁止写入Json文件"的错误，工具不会真正执行，然后Agent 会根据拒绝原因调整策略，用更合法的方式达到目的

现在对于我们单体的Agent来说，其实已经比较完整成体系了，但是不知道有没有感觉到，有的时候我们的MewCode任务一多，一件件处理会处理得好慢，好像我们得给它找点帮手，比如是不是搞多几个Agent。

下一章，我们就来讲讲怎么实现 SubAgent 和任务编排。

## 参考提示词和代码

如果你在澄清需求的过程中遇到困难，或者生成的三份文件效果不理想，可以直接使用下面的参考版本。

把下面三个文件保存到项目根目录，然后告诉你的 AI 编程助手：

> 提示词如果需要复制，移步到这里： [💡 提示词复制](vibe-coding-prompts.md)
