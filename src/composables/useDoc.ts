// 文档加载状态管理：根据 slug 加载 md 内容并渲染为 HTML
import { ref, watch, type Ref } from 'vue'
import { docsMap, isLazyDoc, loadVibe } from '../data/docs'
import { initMarkdown, isMarkdownReady, renderMarkdown } from './useMarkdown'
import type { DocState } from '../data/types'

interface UseDocResult {
  state: Ref<DocState>
  html: Ref<string>
  error: Ref<string>
}

let markdownReady: Promise<void> | null = null
function ensureMarkdown(): Promise<void> {
  if (!markdownReady) markdownReady = initMarkdown()
  return markdownReady
}

/**
 * @param slugRef 响应式 slug（如 computed(() => route.params.slug)）
 */
export function useDoc(slugRef: Ref<string | string[] | undefined>): UseDocResult {
  const state = ref<DocState>('loading')
  const html = ref('')
  const error = ref('')
  let controller: AbortController | null = null

  async function load(slug: string) {
    // 取消上一个进行中的请求
    if (controller) controller.abort()
    controller = new AbortController()

    if (!slug) {
      state.value = 'error'
      error.value = '未指定文档'
      html.value = ''
      return
    }

    state.value = 'loading'
    html.value = ''

    try {
      // 等待 markdown 渲染器就绪
      await ensureMarkdown()

      let content: string
      if (isLazyDoc(slug)) {
        // 运行时 fetch（vibe-coding-prompts）
        const signal = controller.signal
        content = await loadVibe()
        if (signal.aborted) return
      } else if (slug in docsMap) {
        content = docsMap[slug]
      } else {
        state.value = 'error'
        error.value = `文档不存在：${slug}`
        html.value = ''
        return
      }

      if (controller.signal.aborted) return

      const trimmed = content.trim()
      if (!trimmed) {
        state.value = 'empty'
        html.value = ''
        return
      }

      html.value = renderMarkdown(content)
      state.value = 'ready'
    } catch (e) {
      if (controller?.signal.aborted) return
      state.value = 'error'
      error.value = e instanceof Error ? e.message : '加载失败'
      html.value = ''
    }
  }

  watch(
    slugRef,
    (val) => {
      const slug = Array.isArray(val) ? val[0] : val
      if (slug) {
        load(slug)
        window.scrollTo({ top: 0, behavior: 'auto' })
      }
    },
    { immediate: true },
  )

  return { state, html, error }
}

export { isMarkdownReady }
