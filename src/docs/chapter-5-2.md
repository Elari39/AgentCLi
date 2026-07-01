# 实战演练：动手设计提示词管线

派大星 6月12日修改

## 本章需要做什么？

上一章我们把 Agent Loop 跑起来了。

MewCode 已经能自主多步干活，但它的「驾驶手册」只有三行，告诉它「你是 MewCode，一个终端 AI 编程助手」就完了。理论篇里我们看到，同一个模型、同一套工具、同一个 Loop，三行 prompt 和七模块完整 prompt 跑出来是两辆车。

这一章要把这三行展开成一套完整的 Prompt 工程体系。做完之后，MewCode 的 System Prompt 会有清晰的七模块结构，组装管线会按七源到三通道的规则正确分发信息，Prompt Cache 会真正命中并把每轮的 input token 成本打下来。Plan Mode 的指令也从硬拼接改成走 system-reminder 通道，不再每次都让缓存失效。

具体要新增和重构这些东西：

- **七模块 System Prompt 组装器** ：Section 结构体 + Priority 排序，IdentitySection / BehaviorSection / ToolUsageSection / CodeQualitySection / SecuritySection / TaskPatternSection / OutputStyleSection

- **Prompt 组装管线** ：assembleAPIPayload 函数把七类信息分发到 system / messages / tools 三通道

- **环境上下文重构** ：从 ch04 的 system 通道挪到 messages 通道首条 user 消息，避免污染 cache

- **工具描述强化** ：ReadFile / EditFile / WriteFile / Bash / Glob / Grep 的 description 字段补齐用法、优先级、配合关系

- **Prompt Cache 控制** ：system 通道整体设 `cache\_control: ephemeral`，tools 通道同样设，并从 API 返回 usage 验证命中

- **system-reminder 注入机制** ：role=user + `<system-reminder>` XML 标签包裹的消息，注入位置区分会话级与轮次级

- **Plan Mode 改造** ：Plan Mode 文本不再拼进 System Prompt，改成按轮次注入 system-reminder（第 1 轮完整版，每 5 轮重复一次）

- **典型场景评估脚本** ：5 个定性评估场景，方便每次改 prompt 后做人工对照

这章 **不做** ：MEWCODE.md 项目指令文件加载（章节 7）、自动记忆系统（章节 9）、真实 MCP Server 接入（章节 6）、LLM-as-judge 自动评估管线（依然是人工跑场景对比）。

## Vibe Coding 实战

### 生成三份文档

把任务换成本章的内容：

```markdown
# 我的初步想法
- 把全局指令按职责拆成多个模块（身份、行为、工具使用、代码规范、安全边界、任务模式、输出风格），用优先级排序的方式拼装，便于后续章节插入新模块。
- 区分稳定内容和变化内容：稳定的全局指令和工具描述走可缓存通道，变化的环境信息、对话历史、动态补充走对话通道。
- 把环境信息（工作目录、操作系统、时间、Git 状态等）从全局指令里搬出来，作为对话首条系统级补充消息，避免环境每次变化都让缓存失效。
- 在工具自身描述和全局指令里双重强化关键规则,覆盖模型的默认偏好(例如优先调用专用工具而不是通用 shell 命令、编辑前必须先读)。
- 引入一种带特殊标签的对话消息形式,在运行中向模型注入补充指令(外部工具上线、当前模式提醒、温和提示),既不污染缓存也不会被模型当作用户输入回复。
- 把会话级开关功能(如规划模式)的指令从全局指令里拆出来按轮次动态注入,用首轮完整、间隔轮次重复完整、其余轮次精简的节奏控制注入频率。
- 通过解析 API 返回的缓存命中字段验证缓存策略是否真的生效;准备一组典型行为场景做人工对比,作为本章的定性评估手段。
```

然后 AI 就会开始问你问题，进行需求澄清。

你根据理论篇学到的内容回答这些问题，反复循环对齐需求，最后生成三份文档。

### 正式开发

三份文档有了之后，施工图纸定好了，让 Claude Code 根据这三份文档开发

![](images/chapter-5-2/img-1.png)

经过一段时间后，开发完成。

![](images/chapter-5-2/img-2.png)

### 功能验证过程

来验收一下结果

我们先来看看「identify」层

![](images/chapter-5-2/img-3.png)

可以看到，这里会告诉LLM他是谁，那么我们启动MewCode，在没有任何我们去提示上下文的情况下，输入

> 你是谁，什么名字

![](images/chapter-5-2/img-4.png)

可以看到我们的身份是注入成功的，LLM已经知道自己是谁

「环境」层信息注入

![](images/chapter-5-2/img-5.png)

这个其实我们上面那张图也展示出来了

![](images/chapter-5-2/img-6.png)

「system」层这里，我们能看到是这样的信息

![](images/chapter-5-2/img-7.png)

在MewCode输入

> 工具结果可能包含什么

![](images/chapter-5-2/img-8.png)

我们可以看到，它已经能根据system提示词的指引去回答问题了

「DoingTasks」层，提示词这样

![](images/chapter-5-2/img-9.png)

我们打开MewCode，输入

> 你对于代码的抽象会怎么做

![](images/chapter-5-2/img-10.png)

我们能看到这里是能对应上的，这层没问题

「ExecutingActions」层，提示词如下

![](images/chapter-5-2/img-11.png)

打开MewCode，输入

> 你觉得哪些执行操作，需要谨慎

![](images/chapter-5-2/img-12.png)

也是对照着我们的提示词的，这块没问题

「UsingTools」层，提示词是这样的

![](images/chapter-5-2/img-13.png)

我们输入

> 你使用工具时，需要注意什么

![](images/chapter-5-2/img-14.png)

跟提示词对得上，这块没问题

「ToneStyle」层，提示词如下

![](images/chapter-5-2/img-15.png)

我们在MewCode，输入

> 你什么情况才能回复emoji

![](images/chapter-5-2/img-16.png)

可以看到，这层也遵守了，没问题

「TextOutput」层，提示词如下

![](images/chapter-5-2/img-17.png)

我们打开MewCode，输入

> 你的文本输出有什么限制

![](images/chapter-5-2/img-18.png)

可看到，最后这层也没问题，LLM都收到和根据提示词工作了

验收没问题，那么本章的主要任务就完成了。

## 参考提示词和代码

如果你在澄清需求的过程中遇到困难，或者生成的三份文件效果不理想，可以直接使用下面的参考版本。

把下面三个文件保存到项目根目录，然后告诉你的 AI 编程助手（在 `[你的语言]` 处填入你使用的编程语言）：

> 提示词如果需要复制，移步到这里： [💡 提示词复制](https://q00ax5us1um.feishu.cn/wiki/WrLawxh6EicbMpkRTXkcZercnuh)
