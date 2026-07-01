// 解析 SUMMARY.md 为目录树（NavGroup[]）+ 扁平 slugOrder（供 prev/next）
import summaryRaw from '../docs/SUMMARY.md?raw'
import type { NavGroup } from './types'

interface Entry {
  title: string
  slug: string
}

const ENTRY_RE = /^\s*-\s+\[([^\]]+)\]\(([^)]+)\)\s*$/
const CHAPTER_RE = /^第(\d+)章[：:]/
const EXTRA_SLUGS = new Set(['claude-code-config', 'source-download', 'vibe-coding-prompts'])

function parseEntries(raw: string): Entry[] {
  const entries: Entry[] = []
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(ENTRY_RE)
    if (!m) continue
    entries.push({ title: m[1].trim(), slug: m[2].trim().replace(/\.md$/i, '') })
  }
  return entries
}

function build(): { tree: NavGroup[]; slugOrder: string[] } {
  const entries = parseEntries(summaryRaw)
  const tree: NavGroup[] = []
  const slugOrder: string[] = []
  let current: NavGroup | null = null

  const appendLeaf = (group: NavGroup, e: Entry) => {
    group.children.push({ kind: 'leaf', title: e.title, slug: e.slug })
  }

  for (const e of entries) {
    slugOrder.push(e.slug)
    const cm = e.title.match(CHAPTER_RE)
    const isExtra = EXTRA_SLUGS.has(e.slug)

    if (cm) {
      // 新章节
      current = { kind: 'group', title: e.title, chapter: Number(cm[1]), children: [] }
      tree.push(current)
      appendLeaf(current, e)
    } else if (isExtra) {
      // 附加文档归入附加组
      let extra = tree.find((g) => g.title === '附加文档')
      if (!extra) {
        extra = { kind: 'group', title: '附加文档', children: [] }
        tree.push(extra)
      }
      appendLeaf(extra, e)
      current = null
    } else if (current) {
      appendLeaf(current, e)
    } else {
      // 第一个章节之前（intro）归入开篇组
      let intro = tree.find((g) => g.title === '开篇')
      if (!intro) {
        intro = { kind: 'group', title: '开篇', children: [] }
        tree.push(intro)
      }
      appendLeaf(intro, e)
    }
  }

  return { tree, slugOrder }
}

const { tree, slugOrder } = build()

export const navTree: NavGroup[] = tree
export const allSlugs: string[] = slugOrder

/** 根据当前 slug 找到上一个/下一个 slug */
export function getAdjacent(slug: string): { prev?: string; next?: string } {
  const idx = allSlugs.indexOf(slug)
  if (idx < 0) return {}
  return {
    prev: idx > 0 ? allSlugs[idx - 1] : undefined,
    next: idx < allSlugs.length - 1 ? allSlugs[idx + 1] : undefined,
  }
}

/** 根据当前 slug 找到所在分组（用于侧栏自动展开） */
export function findGroupOf(slug: string): NavGroup | undefined {
  return navTree.find((g) => g.children.some((c) => c.slug === slug))
}

/** 根据 slug 查标题 */
export function titleOf(slug: string): string | undefined {
  for (const g of navTree) {
    const hit = g.children.find((c) => c.slug === slug)
    if (hit) return hit.title
  }
  return undefined
}
