// markdown-it + Shiki 单例渲染管线
import MarkdownIt from 'markdown-it'
import { createHighlighter, type Highlighter } from 'shiki'
import { BASE_URL } from '../config'

const LANGS = [
  'python',
  'java',
  'go',
  'plaintext',
  'text',
  'yaml',
  'markdown',
  'json',
  'typescript',
  'javascript',
  'xml',
  'html',
  'bash',
] as const

const THEMES = ['github-light', 'github-dark'] as const

let highlighter: Highlighter | null = null
let md: MarkdownIt | null = null

async function ensureHighlighter(): Promise<Highlighter> {
  if (!highlighter) {
    highlighter = await createHighlighter({
      langs: [...LANGS],
      themes: [...THEMES],
    })
  }
  return highlighter
}

function buildMd(hl: Highlighter): MarkdownIt {
  const inst = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: false,
    breaks: false,
    highlight(code, lang) {
      const language = lang && LANGS.includes(lang as (typeof LANGS)[number]) ? lang : 'text'
      try {
        const html = hl.codeToHtml(code, { lang: language, themes: { light: 'github-light', dark: 'github-dark' } })
        // 注入语言标签数据源（纯文本不显示），供 MarkdownRenderer 读取
        return language === 'text' ? html : html.replace('<pre', `<pre data-lang="${language}"`)
      } catch {
        // 语言未加载等异常，降级纯文本
        return hl.codeToHtml(code, { lang: 'text', themes: { light: 'github-light', dark: 'github-dark' } })
      }
    },
  })

  // 图片 src 改写为根绝对路径：images/x.png -> <BASE_URL>images/x.png
  const defaultImage = inst.renderer.rules.image
  inst.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    const srcIdx = token.attrIndex('src')
    if (srcIdx >= 0) {
      let src = token.attrs![srcIdx][1]
      if (src.startsWith('images/')) {
        src = BASE_URL + src
      } else if (src.startsWith('/images/')) {
        src = BASE_URL + src.slice(1)
      }
      token.attrs![srcIdx][1] = src
    }
    return defaultImage ? defaultImage(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options)
  }

  // 链接处理：站内 xxx.md -> /xxx；外链加 target/rel
  const defaultLink = inst.renderer.rules.link_open
  inst.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    const hrefIdx = token.attrIndex('href')
    if (hrefIdx >= 0) {
      const href = token.attrs![hrefIdx][1]
      const mdMatch = href.match(/^([a-z0-9-]+)\.md$/i)
      if (mdMatch) {
        token.attrs![hrefIdx][1] = `${BASE_URL}${mdMatch[1]}`
      } else if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) {
        // 外链
        token.attrSet('target', '_blank')
        token.attrSet('rel', 'noopener noreferrer')
      }
    }
    return defaultLink ? defaultLink(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options)
  }

  return inst
}

/** 初始化渲染器（app 启动时调用一次） */
export async function initMarkdown(): Promise<void> {
  if (md) return
  const hl = await ensureHighlighter()
  md = buildMd(hl)
}

export function isMarkdownReady(): boolean {
  return md !== null
}

/** 渲染 markdown 为 HTML 字符串 */
export function renderMarkdown(content: string): string {
  if (!md) {
    // 渲染器尚未就绪：先按纯文本转义返回，避免阻塞首屏
    const fallback = new MarkdownIt({ html: false })
    return fallback.render(content)
  }
  return md.render(content)
}
