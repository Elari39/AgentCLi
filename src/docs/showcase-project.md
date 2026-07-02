# 实战成品项目：Claude Session Viewer

派大星 7月2日修改

项目地址

欢迎提意见，也欢迎顺手点个 star。

[GitHub 仓库 →](https://github.com/jerrywu001/cc-sessions-viewer)

[](images/showcase-project/overview.mp4)

项目概览：快速了解 Claude Session Viewer 的核心功能和使用方式

![Claude Session Viewer 演示](images/showcase-project/session.gif)

把 Claude Code、Codex、Gemini CLI 的本地会话统一放进一个桌面端里管理

在正式进入 MewCode 的架构学习之前，先来看一个已经做出来、并且可以直接使用的成品项目：**Claude Session Viewer**。

这个项目解决的问题很具体：当你同时使用 Claude Code、Codex、Gemini CLI 这类 AI 编程工具时，会话历史会散落在不同目录、不同格式的本地文件里。想回头查某次对话、复盘一次工具调用、继续一个旧任务，往往要去翻 JSONL、碰运气 resume，或者自己写脚本解析。

Claude Session Viewer 把这些本地会话统一整理成「项目 / 会话 / 对话」三层结构，支持阅读、搜索、导出、恢复会话，也可以直接在应用内继续和 Agent 对话。它不是课程里的玩具 demo，而是一个完整的桌面端产品：开源免费，支持 macOS、Windows、Linux，基于 Tauri 构建。

![Claude Session Viewer 主界面](images/showcase-project/cover.png)

主界面：按项目组织多个 AI CLI 的历史会话

## 为什么先看这个项目？

MewCode 课程关注的是 Coding Agent 的底层实现：LLM 对话、工具系统、Agent Loop、权限、上下文、记忆、多 Agent 协作。Claude Session Viewer 则从另一个角度展示了一个真实 AI 编程工具周边产品应该如何服务开发者的日常工作流。

它的价值不在于替代 Claude Code、Codex 或 Gemini CLI，而是把这些工具产生的会话资产管理起来。对学习 Coding Agent 的同学来说，这个项目可以帮助你建立两个直觉：

- **Agent 不是只存在于一次对话里**：历史会话、上下文、工具调用、成本统计、恢复入口，都是 Agent 产品体验的一部分。
- **工程化能力决定产品可用性**：只读解析、软删除、导出、搜索、跨平台打包、内嵌终端，这些细节决定一个工具能不能长期用。

## 应用内直接对话

Claude Session Viewer 不只是一个历史查看器，也支持直接在应用内开启新会话，或者接着某条历史往下聊。模型、推理强度、权限模式都可以在界面里切换，Markdown 表格、Mermaid 图、图片输入也能正常处理。

![应用内直接对话](images/showcase-project/chat-preview.png)

应用内对话：不用切回终端，也能继续推进任务

如果 Claude 通过 AskUserQuestion 反问用户，选项会直接渲染成可点击卡片。这个细节看起来不大，但对实际使用很重要：它减少了在终端和图形界面之间来回切换的摩擦。

![Claude AskUserQuestion 交互式提问](images/showcase-project/chat-preview-2.png)

交互式提问：把终端里的选择题变成可点击卡片

## 会话回放

最核心的能力是会话回放。Claude Code、Codex、Gemini CLI 的历史记录不只是普通文本，里面包含思考过程、工具调用、文件 diff、命令输出、截图等结构化信息。Claude Session Viewer 会尽量按原始语义还原这些内容，而不是把 JSON 拍平成一大段纯文本。

![会话回放](images/showcase-project/chat.png)

会话回放：结构化展示思考、工具调用和代码修改

这对复盘 Agent 行为尤其有帮助。你可以看到 Agent 为什么做某个决定、调用了哪些工具、每一步输出是什么，也更容易定位一次任务是在哪个环节走偏的。

## 一键恢复与内嵌终端

看到一半想继续干活，可以直接恢复会话。应用内置终端，也支持把 resume 命令交给外部终端执行，例如 Terminal.app、cmux、iTerm2、Ghostty、Warp。

![内嵌终端恢复会话](images/showcase-project/session-resume.png)

一键恢复：从历史会话直接回到可执行状态

每个 Agent 还可以单独配置启动参数。比如在本地安全环境里，如果你希望减少频繁授权确认，可以给特定工具配置对应的权限参数。这个设计和课程后面会讲到的「权限系统」正好形成对照：产品层可以提供便利，但底层必须知道边界在哪里。

## 全局搜索

当会话数量多起来后，搜索会变成刚需。Claude Session Viewer 支持跨项目搜索，并能直接跳转到命中的消息位置。对经常复盘提示词、工具调用、报错信息的同学来说，这比在终端里 grep 一堆原始日志要高效很多。

![全局搜索](images/showcase-project/search.png)

全局搜索：跨项目定位历史问题和关键上下文

## 成本统计

AI 编程工具真正用起来以后，成本会变成一个很现实的问题。这个项目会基于模型价格数据统计消耗，并按项目、模型、工具维度拆开看。macOS 上还可以放进菜单栏，快速查看今天、近 7 天、近 30 天的消耗。

![成本统计](images/showcase-project/stats.png)

成本统计：按项目、模型、工具拆分 token 与费用

![macOS 菜单栏成本统计](images/showcase-project/sys-stats.png)

菜单栏统计：不用打开主窗口，也能看到近期消耗

## 导出与长期保存

会话记录本质上是开发过程中的知识资产。Claude Session Viewer 支持导出 Markdown、HTML、JSON，方便归档、分享或离线阅读。删除操作也默认走软删除，不会直接把原始记录从磁盘上永久移除。

![导出 HTML](images/showcase-project/export.png)

导出 HTML：把一次关键会话保存成可独立阅读的材料

## 还能做什么？

- 会话旁边可以打开纯 shell 标签，在对应项目目录里直接执行命令。
- 集成 cmux，支持按 cwd 复用 workspace、定位正在运行的会话、按目录名自动命名标签。
- 可以把所有用户提问抽出来单独查看，点击后跳回原消息。
- 支持「看过的视图」历史和收藏，方便回到上次读到的位置。
- 常用文件夹可以固定到侧栏。
- 重命名会同步回 CLI，删除是软删并支持还原。

## 下载与源码

项目仓库：[GitHub - cc-sessions-viewer](https://github.com/jerrywu001/cc-sessions-viewer)

安装包下载：[GitHub Releases](https://github.com/jerrywu001/cc-sessions-viewer/releases)

安装包覆盖 macOS、Windows x64、Linux x86\_64。macOS 首次打开如果提示「无法验证开发者」，是因为应用只做了 ad-hoc 签名，没有做公证，可以通过右键「打开」确认一次。

后续学习 MewCode 时，可以把这个项目当作一个真实产品参照：课程会拆 Agent 的核心能力，而这个工具展示的是围绕 Agent 工作流做产品化时，还需要补齐哪些工程体验。
