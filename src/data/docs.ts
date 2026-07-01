// 文档内容加载：
//   - 常规 md（96 篇，不含 vibe-coding-prompts）构建时 raw import 打包
//   - vibe-coding-prompts.md（2.26MB）运行时 fetch，避免膨胀主 bundle
import { BASE_URL } from '../config'

const modules = import.meta.glob(['../docs/*.md', '!../docs/vibe-coding-prompts.md'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/** slug -> markdown 原文（不含 SUMMARY 与 vibe-coding-prompts） */
export const docsMap: Record<string, string> = {}
for (const [path, content] of Object.entries(modules)) {
  const name = path.split('/').pop() ?? ''
  if (!name.endsWith('.md')) continue
  const slug = name.slice(0, -3)
  if (slug === 'SUMMARY') continue
  if (slug === 'vibe-coding-prompts') continue // 超大文件，运行时 fetch
  docsMap[slug] = content
}

/** vibe-coding-prompts 单独 fetch 加载 */
export async function loadVibe(): Promise<string> {
  const url = `${BASE_URL}docs/vibe-coding-prompts.md`
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`加载失败：${resp.status}`)
  return resp.text()
}

/** 判断给定 slug 是否需要运行时 fetch */
export function isLazyDoc(slug: string): boolean {
  return slug === 'vibe-coding-prompts'
}
