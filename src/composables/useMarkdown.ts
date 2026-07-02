// markdown-it + Shiki 单例渲染管线
import MarkdownIt from 'markdown-it'
import { createHighlighter, type Highlighter } from 'shiki'
import { BASE_URL } from '../config'
import type { DocHeading } from '../data/types'

const LANGS = [
  'text',
  'python',
  'java',
  'go',
  'typescript',
  'javascript',
  'tsx',
  'jsx',
  'vue',
  'html',
  'css',
  'scss',
  'json',
  'jsonc',
  'yaml',
  'markdown',
  'bash',
  'shellsession',
  'powershell',
  'xml',
  'sql',
  'dockerfile',
  'diff',
  'toml',
  'ini',
  'properties',
  'nginx',
  'c',
  'cpp',
  'c++',
  'csharp',
  'c#',
  'rust',
  'kotlin',
  'php',
  'ruby',
] as const

type SupportedLanguage = (typeof LANGS)[number]

const FALLBACK_LANGUAGE: SupportedLanguage = 'text'
const LANG_SET = new Set<string>(LANGS)
const LANG_ALIASES: Record<string, SupportedLanguage> = {
  plaintext: 'text',
  plain: 'text',
  txt: 'text',
  py: 'python',
  py3: 'python',
  python3: 'python',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  javascriptreact: 'jsx',
  typescriptreact: 'tsx',
  yml: 'yaml',
  md: 'markdown',
  sh: 'bash',
  shell: 'bash',
  shellscript: 'bash',
  zsh: 'bash',
  terminal: 'shellsession',
  console: 'shellsession',
  ps: 'powershell',
  ps1: 'powershell',
  pwsh: 'powershell',
  docker: 'dockerfile',
  dockercompose: 'yaml',
  'docker-compose': 'yaml',
  h: 'c',
  hpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  'c++': 'cpp',
  cs: 'csharp',
  rs: 'rust',
  kt: 'kotlin',
  kts: 'kotlin',
  rb: 'ruby',
}

type LanguageScores = Partial<Record<SupportedLanguage, number>>

const THEMES = ['github-light-high-contrast', 'github-dark-high-contrast'] as const
const SHIKI_THEMES = {
  light: THEMES[0],
  dark: THEMES[1],
} as const

let highlighter: Highlighter | null = null
let md: MarkdownIt | null = null

interface MarkdownRenderEnv {
  headings?: DocHeading[]
  headingCounts?: Record<string, number>
}

interface MarkdownRenderResult {
  html: string
  headings: DocHeading[]
}

async function ensureHighlighter(): Promise<Highlighter> {
  if (!highlighter) {
    highlighter = await createHighlighter({
      langs: [...LANGS],
      themes: [...THEMES],
    })
  }
  return highlighter
}

/** 提取 Markdown fence 的语言名，兼容 ```ts {1,3} / ```language-python 等写法 */
function getFenceLanguageName(lang?: string): string {
  const raw = (lang ?? '').trim().toLowerCase().replace(/^language-/, '')
  return raw.split(/[\s,{:]/, 1)[0] ?? ''
}

/** 统一显式 fence 语言名；未知语言返回 null，交给内容推断 */
function normalizeExplicitFenceLanguage(lang?: string): SupportedLanguage | null {
  const name = getFenceLanguageName(lang)
  if (!name) return null

  const alias = LANG_ALIASES[name]
  if (alias) return alias

  return LANG_SET.has(name) ? (name as SupportedLanguage) : null
}

function addLanguageScore(scores: LanguageScores, lang: SupportedLanguage, score: number) {
  scores[lang] = (scores[lang] ?? 0) + score
}

function looksLikeJson(code: string): boolean {
  const trimmed = code.trim()
  if (!/^[{[]/.test(trimmed)) return false
  try {
    JSON.parse(trimmed)
    return true
  } catch {
    return false
  }
}

function inferFenceLanguage(code: string): SupportedLanguage {
  const text = code.trim()
  if (!text) return FALLBACK_LANGUAGE

  const lines = text.split(/\r?\n/)
  const nonEmptyLines = lines.map((line) => line.trim()).filter(Boolean)
  const firstLine = nonEmptyLines[0] ?? ''

  // 强特征优先返回，减少通用关键词带来的误判。
  if (/^(diff --git|index [a-f0-9]+\.\.[a-f0-9]+|@@\s)/m.test(text)) return 'diff'
  const diffishLines = nonEmptyLines.filter((line) => /^[+-](?!\+\+|--|\s*\[[ x]\])/.test(line))
  if (diffishLines.length >= 3 && diffishLines.some((line) => line.startsWith('+')) && diffishLines.some((line) => line.startsWith('-'))) {
    return 'diff'
  }
  if (/^<template[\s>]/i.test(firstLine) || /<script\s+setup\b/i.test(text)) return 'vue'
  if (/^<\?xml\b/i.test(firstLine)) return 'xml'
  if (/^(<!doctype html|<html[\s>])/i.test(firstLine) || (/<[a-z][\w:-]*(\s|>)/i.test(text) && /<\/(div|span|main|section|body|script|style|template)>/i.test(text))) {
    return 'html'
  }
  if (looksLikeJson(text)) return 'json'
  if (/^\s*FROM\s+\S+/im.test(text) && /\b(RUN|COPY|ADD|CMD|ENTRYPOINT|WORKDIR|ENV|EXPOSE)\b/i.test(text)) {
    return 'dockerfile'
  }
  if (/^\s*(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE)\b/im.test(text) && /\b(FROM|WHERE|VALUES|SET|TABLE|JOIN)\b/i.test(text)) {
    return 'sql'
  }
  if (/^\s*(\$|>|PS\s+[A-Z]:\\.*>|[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:.*\$)\s+/m.test(text)) {
    return 'shellsession'
  }

  const scores: LanguageScores = {}

  // Python：覆盖课程文档中大量未标注的 ABC/dataclass/async generator 代码块。
  if (/^\s*(async\s+)?def\s+\w+\s*\(/m.test(text)) addLanguageScore(scores, 'python', 5)
  if (/^\s*class\s+\w+(?:\([^)]*\))?:\s*$/m.test(text)) addLanguageScore(scores, 'python', 5)
  if (/^\s*@(abstractmethod|dataclass|staticmethod|classmethod|property)\b/m.test(text)) addLanguageScore(scores, 'python', 4)
  if (/\b(self|None|True|False)\b/.test(text)) addLanguageScore(scores, 'python', 2)
  if (/^\s*(from\s+[\w.]+\s+import|import\s+[\w.]+)/m.test(text)) addLanguageScore(scores, 'python', 2)
  if (/^\s*(if|elif|else|for|while|try|except|finally|with)\b.*:\s*$/m.test(text)) {
    addLanguageScore(scores, 'python', 3)
  }
  if (/\b(yield|async\s+for|async\s+with)\b/.test(text)) addLanguageScore(scores, 'python', 2)
  if (/\b(list|dict|tuple|set)\[[^\]]+\]/.test(text)) addLanguageScore(scores, 'python', 2)

  // Go / Java / Kotlin / Rust / C 系语言。
  if (/^\s*package\s+\w+/m.test(text)) addLanguageScore(scores, 'go', 5)
  if (/^\s*func\s+(?:\(\w+\s+\*?\w+\)\s*)?\w+\s*\(/m.test(text)) addLanguageScore(scores, 'go', 5)
  if (/:=|\bdefer\b|\bgo\s+func\b/.test(text)) addLanguageScore(scores, 'go', 2)
  if (/^\s*import\s+\(/m.test(text)) addLanguageScore(scores, 'go', 2)

  if (/\b(public|private|protected)\s+(?:static\s+)?(?:final\s+)?(class|interface|enum)\s+\w+/.test(text)) {
    addLanguageScore(scores, 'java', 5)
  }
  if (/\bpublic\s+static\s+void\s+main\s*\(/.test(text)) addLanguageScore(scores, 'java', 4)
  if (/\bSystem\.out\.println\s*\(|^\s*@Override\b/m.test(text)) addLanguageScore(scores, 'java', 3)
  if (/\bnew\s+[A-Z]\w*\s*\(/.test(text)) addLanguageScore(scores, 'java', 1)

  if (/^\s*using\s+System\b/m.test(text) || /\bConsole\.WriteLine\s*\(/.test(text)) {
    addLanguageScore(scores, 'csharp', 5)
  }
  if (/\bnamespace\s+[\w.]+\s*\{/.test(text) || /\bstring\[\]\s+args\b/.test(text)) {
    addLanguageScore(scores, 'csharp', 2)
  }

  if (/^\s*data\s+class\s+\w+|^\s*fun\s+\w+\s*\(/m.test(text)) addLanguageScore(scores, 'kotlin', 4)
  if (/\b(val|var)\s+\w+\s*[:=]/.test(text) && /\bString\b|\bInt\b|\bBoolean\b/.test(text)) {
    addLanguageScore(scores, 'kotlin', 2)
  }

  if (/^\s*(pub\s+)?fn\s+\w+\s*\(/m.test(text) || /\blet\s+mut\b|\bimpl\s+\w+/.test(text)) {
    addLanguageScore(scores, 'rust', 5)
  }
  if (/^\s*use\s+(crate|std)::/m.test(text)) addLanguageScore(scores, 'rust', 2)

  if (/^\s*#include\s+[<"]/m.test(text) || /\bint\s+main\s*\(/.test(text)) addLanguageScore(scores, 'cpp', 4)
  if (/\bstd::|cout\s*<<|cin\s*>>/.test(text)) addLanguageScore(scores, 'cpp', 3)
  if (/\bprintf\s*\(|\bmalloc\s*\(/.test(text)) addLanguageScore(scores, 'c', 3)

  // JS / TS / JSX / Vue。
  if (/^\s*(import|export)\s+.+from\s+['"]/m.test(text)) {
    addLanguageScore(scores, 'javascript', 2)
    addLanguageScore(scores, 'typescript', 2)
  }
  if (/^\s*(const|let|var)\s+\w+\s*=/m.test(text) || /\bfunction\s+\w+\s*\(/.test(text)) {
    addLanguageScore(scores, 'javascript', 3)
  }
  if (/=>|\basync\s+function\b|\bawait\b/.test(text)) addLanguageScore(scores, 'javascript', 1)
  if (/^\s*interface\s+\w+\s*\{|^\s*type\s+\w+\s*=/m.test(text)) addLanguageScore(scores, 'typescript', 5)
  if (/:\s*(string|number|boolean|unknown|any|void|never|Promise|Record|Array|ReadonlyArray)\b/.test(text)) {
    addLanguageScore(scores, 'typescript', 3)
  }
  if (/<[A-Z]\w*(\s|\/?>)/.test(text) && /\b(return|const|function|export)\b/.test(text)) {
    addLanguageScore(scores, /:\s*(string|number|boolean|ReactNode)\b/.test(text) ? 'tsx' : 'jsx', 5)
  }
  if (/<script\b|<style\b|<template\b/i.test(text)) addLanguageScore(scores, 'vue', 4)

  // 配置、样式、标记语言与常见脚本。
  const yamlPairs = nonEmptyLines.filter((line) => /^-?\s*[\w.-]+\s*:\s+\S/.test(line)).length
  if (yamlPairs >= 2 || /^---\s*$/m.test(text) || /^\s*-\s+[\w.-]+:\s+\S/m.test(text)) {
    addLanguageScore(scores, 'yaml', 4)
  }
  if (/^\s*\[[\w.-]+\]\s*$/m.test(text) && /^\s*[\w.-]+\s*=.+/m.test(text)) addLanguageScore(scores, 'ini', 4)
  if (/^\s*[\w.-]+\s*=.+/m.test(text) && !/[{};]/.test(text)) addLanguageScore(scores, 'properties', 3)
  if (/^\s*\[[\w.-]+\]\s*$/m.test(text) && /\b(true|false|\d{4}-\d{2}-\d{2})\b/.test(text)) {
    addLanguageScore(scores, 'toml', 3)
  }
  if (/^\s*[.#]?[a-z][\w\s.#:[\]\="'-]*\{\s*$/im.test(text) && /^\s*[-\w]+\s*:\s*[^;{}]+;?\s*$/m.test(text)) {
    addLanguageScore(scores, 'css', 5)
  }
  if (/@(media|keyframes|supports)\b|var\(--[\w-]+\)/.test(text)) addLanguageScore(scores, 'css', 3)
  if (/^\s*(server|location|upstream)\s+[^{]*\{/m.test(text) && /\b(listen|proxy_pass|root|server_name)\b/.test(text)) {
    addLanguageScore(scores, 'nginx', 5)
  }
  if (/^#\s+\S/m.test(text) && /(^\s*[-*]\s+|\[[ x]\])/m.test(text)) addLanguageScore(scores, 'markdown', 4)

  if (/^#!\/.*\b(bash|sh|zsh)\b/m.test(text) || /^\s*(pnpm|npm|yarn|git|docker|python|pip|uv|go|cargo)\s+\S+/m.test(text)) {
    addLanguageScore(scores, 'bash', 4)
  }
  if (/^\s*(if|for|while)\b.*;\s*then\b/m.test(text) || /\b(echo|export|cd|mkdir|rm|cp|mv)\b/.test(text)) {
    addLanguageScore(scores, 'bash', 2)
  }
  if (/\b(Get|Set|New|Remove|Start|Stop|Select|Where)-[A-Z]\w+\b/.test(text) || /\$env:[A-Za-z_]/.test(text)) {
    addLanguageScore(scores, 'powershell', 5)
  }

  if (/^<\?php\b/.test(firstLine) || (/\bfunction\s+\w+\s*\([^)]*\)\s*\{/.test(text) && /\$\w+/.test(text))) {
    addLanguageScore(scores, 'php', 5)
  }
  if (/^\s*(def|class)\s+\w+.*\bend\s*$/m.test(text) || /\bputs\s+['"]/.test(text)) {
    addLanguageScore(scores, 'ruby', 4)
  }

  const candidates: SupportedLanguage[] = [
    'python',
    'typescript',
    'javascript',
    'tsx',
    'jsx',
    'java',
    'go',
    'csharp',
    'kotlin',
    'rust',
    'cpp',
    'c',
    'vue',
    'html',
    'css',
    'yaml',
    'bash',
    'powershell',
    'shellsession',
    'sql',
    'dockerfile',
    'json',
    'markdown',
    'toml',
    'ini',
    'properties',
    'nginx',
    'php',
    'ruby',
    'xml',
    'diff',
  ]
  const best = candidates
    .map((lang) => ({ lang, score: scores[lang] ?? 0 }))
    .sort((a, b) => b.score - a.score)[0]

  return best && best.score >= 4 ? best.lang : FALLBACK_LANGUAGE
}

/** 解析最终用于 Shiki 的语言：显式语言优先，未知或空语言再按内容推断 */
function resolveFenceLanguage(code: string, lang?: string): SupportedLanguage {
  return normalizeExplicitFenceLanguage(lang) ?? inferFenceLanguage(code)
}

/** 将标题文本转换为稳定、可用于 DOM id 的锚点 */
function slugifyHeading(text: string): string {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]+/gu, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return slug || 'section'
}

/** 同一篇文章内重复标题追加序号，避免 id 冲突 */
function createHeadingId(text: string, env: MarkdownRenderEnv): string {
  const base = slugifyHeading(text)
  const counts = env.headingCounts ?? {}
  const next = (counts[base] ?? 0) + 1
  counts[base] = next
  env.headingCounts = counts
  return next === 1 ? base : `${base}-${next}`
}

function buildMd(hl: Highlighter): MarkdownIt {
  const inst = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: false,
    breaks: false,
    highlight(code, lang) {
      const language = resolveFenceLanguage(code, lang)
      try {
        const html = hl.codeToHtml(code, { lang: language, themes: SHIKI_THEMES })
        // 注入语言标签数据源（纯文本不显示），供 MarkdownRenderer 读取
        return language === FALLBACK_LANGUAGE ? html : html.replace('<pre', `<pre data-lang="${language}"`)
      } catch {
        // 语言未加载等异常，降级纯文本
        return hl.codeToHtml(code, { lang: FALLBACK_LANGUAGE, themes: SHIKI_THEMES })
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

  // 为 H2/H3 注入锚点 id，并同步收集右侧文章目录数据
  const defaultHeadingOpen = inst.renderer.rules.heading_open
  inst.renderer.rules.heading_open = (tokens, idx, options, env: MarkdownRenderEnv, self) => {
    const token = tokens[idx]
    const level = Number(token.tag.slice(1))
    if (level === 2 || level === 3) {
      const inlineToken = tokens[idx + 1]
      const text = inlineToken?.type === 'inline' ? inlineToken.content.trim() : ''
      if (text) {
        const id = createHeadingId(text, env)
        token.attrSet('id', id)
        env.headings?.push({ id, level, text })
      }
    }

    return defaultHeadingOpen
      ? defaultHeadingOpen(tokens, idx, options, env, self)
      : self.renderToken(tokens, idx, options)
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
  return renderMarkdownWithHeadings(content).html
}

/** 渲染 markdown，并返回可用于右侧目录的 H2/H3 标题 */
export function renderMarkdownWithHeadings(content: string): MarkdownRenderResult {
  const env: MarkdownRenderEnv = {
    headings: [],
    headingCounts: {},
  }

  if (!md) {
    // 渲染器尚未就绪：先按纯文本转义返回，避免阻塞首屏
    const fallback = new MarkdownIt({ html: false })
    return {
      html: fallback.render(content),
      headings: [],
    }
  }

  return {
    html: md.render(content, env),
    headings: env.headings ?? [],
  }
}
