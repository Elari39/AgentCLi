# AGENTS.md — MewCode Agent 课程文档站

## 项目概述

Vue 3 渲染 `src/docs/` 下的 Markdown 文档，左侧导航目录与 `src/docs/SUMMARY.md` 顺序一致，支持 Docker 部署。

## 技术栈

- Vue 3.5 + TypeScript + `<script setup>` + Composition API
- Vite 8 + Tailwind CSS 4（`@import "tailwindcss"`，无 tailwind.config）
- Vue Router 4（history 模式）
- markdown-it + Shiki（代码高亮）
- 包管理器：**必须用 pnpm**，禁止 npm/yarn
- 容器：nginx:alpine 多阶段构建

## 目录结构约定

- `src/docs/`：文档正式数据源（git-tracked），章节 md + `SUMMARY.md`，可直接编辑
- `public/images/`：图片静态资源数据源（git-tracked）
- `public/docs/vibe-coding-prompts.md`：超大文档（2.26MB），运行时 fetch，**不在** `import.meta.glob` eager 中（已用负 glob 排除）
- `scrape_agent_docs.py`：全站爬虫，**直写**上述三个目录；重新运行即刷新数据，不再有中间同步层
- `vibe-coding-prompts.md` 走运行时 fetch 的设计不变（避免膨胀主 bundle）

## 修改文档内容

直接编辑 `src/docs/` 下 md 即可，`pnpm dev` / `pnpm build` 无前置步骤。重新爬取全站数据运行 `python scrape_agent_docs.py`。

## 验证命令

```bash
pnpm dev          # 本地开发，http://localhost:5173
pnpm build        # 类型检查 + 生产构建到 dist/
pnpm preview      # 预览生产构建
```

## Docker

```bash
# Compose 一键构建并后台启动
docker compose up -d --build
# 访问 http://localhost:2671
docker compose down            # 停止并清理

# 或手动 build/run
docker build -t meow-agent-docs .
docker run -d -p 2671:80 --name agent-docs meow-agent-docs
```

## 约定

- 中文 UI 文案与注释
- 页面须处理 Loading / Error / Empty 状态（见 `src/components/DocState.vue`）
- 不引入无必要依赖；复用现有组件与 composable
- 图片路径在 `useMarkdown.ts` 中改写为根绝对路径，子路径部署需统一用 `import.meta.env.BASE_URL`
