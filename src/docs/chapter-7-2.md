# 实战演练：动手接入 MCP 服务

派大星 6月12日修改

## 本章需要做什么？

上一章我们给 MewCode 装上了权限系统，五层权限拦截让工具调用变得安全可控。但你有没有发现一个问题：MewCode 能用的工具，全部是你亲手写的。ReadFile、WriteFile、Bash、Grep、Glob，每一个都编译进二进制，想加新工具就得改代码、重新发版。

这一章要让 MewCode 从「封闭工具集」变成「开放工具生态」。做完之后，用户在配置文件里声明一个 MCP Server，MewCode 就能自动接入它提供的工具，不用改一行代码。GitHub Issue 查询、数据库操作、Slack 消息，社区写好了 MCP Server，直接接进来就能用。

具体要新增这些东西：

- **JSON-RPC 2.0 协议类型** ：请求、响应、通知三种消息的编解码
- **Transport 抽象 + 两种实现** ：stdio（子进程管道通信）和 Streamable HTTP（远程 Server）
- **MCP Client** ：初始化握手、工具发现、工具调用、请求-响应异步匹配
- **MCPToolWrapper** ：适配器，把 MCP 工具包装成 MewCode 内部的 Tool 接口
- **MCP Manager** ：连接缓存、配置合并、生命周期管理
- **环境变量隔离** ：子进程只拿到 PATH + 显式声明的变量，不泄露敏感信息

这章 **不做** ：SSE 流式推送、Resources/Prompts 消费、Sampling/Elicitation 等 Client 侧高级能力。

## Vibe Coding 实战

### 生成三份文档

把任务换成本章的内容：

```markdown
# 我的初步想法
- 实现一个客户端，按 JSON-RPC 2.0 的消息格式跟外部 server 通信
- 至少支持两种传输方式：本地子进程 stdio、远程 Streamable HTTP
- 一次会话分三个阶段：连接初始化握手 → 工具列表发现 → 工具调用
- 消息是双向的，需要处理请求-响应的异步匹配（每个请求带 id，回包按 id 关联）
- 写一个适配层把发现到的远端工具包装成 MewCode 已有的 Tool 接口，注册进工具中心，Agent 调用时无感
- 多个 server 的连接做缓存或池化，避免每次工具调用都重连
- 配置在哪里声明 server 列表（命令、URL、env、超时）需要在 spec 阶段定下来
```

然后 AI 就会开始问你问题，进行需求澄清。

你根据理论篇学到的内容回答这些问题，一直这样反复循环对齐需求，最后就能生成三份文档了。

### 正式开发

三份文档有了之后，就相当于施工图纸已经定好了，然后让 Claude Code 根据这三份文档进行开发

![](images/chapter-7-2/img-1.png)

经过一段时间后，开发完成。

![](images/chapter-7-2/img-2.png)

### 功能验证过程

来验收一下结果，现在配置里加上我们的context7 mcp，

config里配置如下

> mcp\_servers:

> - name: context7

> command: npx

> args: ["-y", "@upstash/context7-mcp"]

![](images/chapter-7-2/img-3.png)

然后启动MewCode，如果连接正常的话，ui会显示连接正常，以及注册的工具

![](images/chapter-7-2/img-4.png)

跟它说

> 用context7mcp 查看最新的eino的文档

我们可以看到模型决定调用 MCP 工具，MewCode 通过 MCP 协议把请求转给外部 Server，Server 执行后返回结果，模型基于结果回答。

![](images/chapter-7-2/img-5.png)

整个过程对模型来说，MCP 工具和内置工具没有任何区别。

要说内部Function Calling和MCP的一个大差别就是MCP更像是外部生态的一个工具注册中心，对于互联网上的系统而言，是打破生态孤岛的一个重要手段，将一个个生态链接起来，形成更加庞大强大的大生态。

验收没问题，那么本章的主要任务就完成了。下一章，我们给 MewCode 加上上下文管理能力。

## 参考提示词和代码

如果你在澄清需求的过程中遇到困难，或者生成的三份文件效果不理想，可以直接使用下面的参考版本。

把下面三个文件保存到项目根目录，然后告诉你的 AI 编程助手：

> 提示词如果需要复制，移步到这里： [💡 提示词复制](https://q00ax5us1um.feishu.cn/wiki/WrLawxh6EicbMpkRTXkcZercnuh)
