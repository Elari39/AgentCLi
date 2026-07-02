// 目录树类型定义

/** 叶子节点：单个可点击的文档 */
export interface NavLeaf {
  kind: 'leaf'
  /** 文档标题 */
  title: string
  /** slug，即文件名去 .md，对应路由 */
  slug: string
}

/** 分组节点：一个章/开篇/附加文档，包含若干叶子 */
export interface NavGroup {
  kind: 'group'
  /** 分组标题 */
  title: string
  /** 章节号（如第 1 章 → 1），开篇/附加为 undefined */
  chapter?: number
  /** 该组所有叶子（含章首页本身） */
  children: NavLeaf[]
}

export type NavNode = NavGroup

/** 文档加载状态 */
export type DocState = 'loading' | 'error' | 'empty' | 'ready'

/** 文章右侧目录标题 */
export interface DocHeading {
  /** 标题对应的 DOM id */
  id: string
  /** 目录展示层级：只收集正文 H2/H3 */
  level: 2 | 3
  /** 标题纯文本 */
  text: string
}
