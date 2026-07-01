# 实战演练：动手实现 Worktree

派大星 6月12日修改

第14章：实战篇

## 本章需要做什么？

上一章我们给 MewCode 装上了 SubAgent 系统，主 Agent 可以把任务分派给子 Agent，子 Agent 在隔离的上下文中执行。消息隔离了，权限隔离了，文件缓存也隔离了。但有一样东西还没隔离：文件系统。

两个 Agent 同时改同一个文件，会互相覆盖。Git 分支管不了这个问题，因为分支只是时间维度的快照，同一时刻只有一个工作目录。我们需要的是空间维度的隔离，让同一时间存在多个独立工作区。

这一章要给 MewCode 接入 Git Worktree 管理系统。做完之后，每个子 Agent 都可以在独立的工作目录中操作文件，彻底消除并行场景下的文件冲突。

具体要新增这些东西：

- •
  **Slug 安全验证** ：防止路径遍历攻击，LLM 生成的名称不可信
- •
  **WorktreeManager 生命周期管理** ：Create / Enter / Exit / AutoCleanup / StaleCleanup / List / Remove，完整覆盖 Worktree 的创建、使用和销毁
- •
  **创建后设置** ：复制本地配置、配置 git hooks、软链接依赖目录、复制被忽略但需要的文件
- •
  **会话状态持久化** ：WorktreeSession 存入配置文件，支持 `--resume` 恢复
- •
  **与 SubAgent 集成** ：AgentDefinition 新增 `isolation` 字段， `executeWithWorktree` 自动创建 Worktree、注入上下文通知、完成后自动清理
- •
  **/worktree 斜杠命令** ：list / create / enter / exit / remove 五个子命令

这章 **不做** ：Worktree 之间的合并策略（由上层用户决定 merge 或丢弃）、跨 Worktree 的代码同步工具、多 Agent 并行编排（留给后续的 Agent Teams 系统）。

## Vibe Coding 实战

### 生成三份文档

把任务换成本章的内容：

```markdown
# 我的初步想法
- 用 Git 自带的多工作目录机制（同一仓库可挂多个工作目录，每个对应不同分支）作为隔离基础，目录统一放在仓库内部不被 Git 追踪的位置
- 目录名称走严格的安全校验：限制字符集、长度，拒绝 `.` 和 `..` 段，允许 `/` 作为嵌套分隔符（创建分支时再做平铺转换），防 LLM 输入触发路径遍历
- 完整生命周期管理：创建（含快速恢复——目录已存在时不调 git 子进程，纯文件系统读取 HEAD）、进入、退出、删除
- 创建后做环境初始化：复制本地配置（如 `settings.local.json`）、按主仓库 hooks 路径配置子目录的 git hooks、软链接大型依赖目录（依赖目录列表来自配置）、按规则复制被 gitignore 但运行需要的文件（best-effort）
- 切换工作目录时清理三类缓存（文件内容缓存、系统提示词/项目指令缓存、memory 文件缓存），防止 Agent 用旧目录的内容对新目录做决策
- 子 Agent 隔离模式：Agent 定义里通过字段声明隔离需求，进入流程自动建目录、在任务文本前注入路径翻译说明，完成后按变更情况自动判断保留还是清掉
- 退出时变更保护：有未提交修改或未推送 commit 时，默认拒绝删除目录，需显式确认丢弃；切回原目录后要重新加载主仓库的 hooks 配置
- 会话状态持久化到磁盘，支持进程意外退出后下次启动 `--resume` 恢复
- 后台周期性清理过期临时目录，三层过滤（命名模式 → 当前使用中/未过期 → fail-closed 的变更与未推送检查）
- 配套斜杠命令让用户手动管理目录（创建、列出、进入、退出、查看状态）
```

AI 会开始问你问题，进行需求澄清。

你根据理论篇学到的内容回答这些问题，一直这样反复循环对齐需求，最后就能生成三份文档了。

### 正式开发

三份文档有了之后，就相当于施工图纸已经定好了，然后让 Claude Code 根据这三份文档进行开发

![](images/chapter-14-2/img-1.png)

经过一段时间后，开发完成。

![](images/chapter-14-2/img-2.png)

### 功能验证过程

来验收一下结果

让 Agent 在 worktree 里创建个文件：

> 请在当前目录创建 witness.txt，内容写 "original content from main agent"。

![](images/chapter-14-2/img-3.png)

然后我们再输入

> 请用 Agent 工具派一个 general-purpose 子 Agent，

> isolation 参数设为 "worktree"，

> 任务（prompt）是：把 witness.txt 的内容改成 "modified by isolated worker"，然后用 git 提交。

![](images/chapter-14-2/img-4.png)

会看到它是在worktree里创建，不会在主目录里创建文件，能有效避免文件冲突

![](images/chapter-14-2/img-5.png)

这时worktrees有一份witness的文本文件，内容是：modified by isolated worker

而主目录也有一份witness的文本文件，内容是：original content from main agent

![](images/chapter-14-2/img-6.png)

验收没问题，那么本章的主要任务就完成了。

现在虽然文件冲突解决了，但是如果是依赖关系的任务不能盲目并行咋办？如果是需要不同身份去处理任务咋办？如果是需要发散性讨论咋办？如果子Agent间需要协作咋办？

下一章，我们让多个子 Agent组成队伍，真正是一个team！

## 参考提示词和代码

如果你在澄清需求的过程中遇到困难，或者生成的三份文件效果不理想，可以直接使用下面的参考版本。

把下面三个文件保存到项目根目录，然后告诉你的 AI 编程助手：

> 提示词如果需要复制，移步到这里： [💡 提示词复制](vibe-coding-prompts.md)
