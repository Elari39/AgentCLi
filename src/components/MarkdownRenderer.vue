<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { BASE_URL } from '../config'
import ImageLightbox from './ImageLightbox.vue'

const props = defineProps<{
  html: string
}>()

const containerRef = ref<HTMLElement | null>(null)
const router = useRouter()

// 图片放大状态
const lightboxSrc = ref('')
const lightboxOpen = ref(false)

/** 从 pre 的 data-lang 属性提取语言名，返回 null 表示纯文本（不显示标签） */
function detectLang(pre: HTMLElement): string | null {
  const lang = (pre.getAttribute('data-lang') || '').toLowerCase()
  if (lang && lang !== 'text' && lang !== 'plaintext') return lang
  return null
}

/** 为代码块注入复制按钮与语言标签 */
function injectCopyButtons(root: HTMLElement) {
  root.querySelectorAll('pre.shiki').forEach((pre) => {
    if (pre.querySelector('.copy-btn')) return
    // 复制按钮
    const btn = document.createElement('button')
    btn.className = 'copy-btn'
    btn.textContent = '复制'
    btn.addEventListener('click', () => {
      const code = pre.querySelector('code')
      const text = code ? code.textContent ?? '' : pre.textContent ?? ''
      navigator.clipboard.writeText(text).then(() => {
        btn.textContent = '已复制'
        setTimeout(() => {
          btn.textContent = '复制'
        }, 1500)
      })
    })
    pre.appendChild(btn)

    // 语言标签
    if (!pre.querySelector('.lang-label')) {
      const lang = detectLang(pre as HTMLElement)
      if (lang) {
        const label = document.createElement('span')
        label.className = 'lang-label'
        label.textContent = lang
        pre.appendChild(label)
      }
    }
  })
}

/** 拦截站内链接，走 SPA 路由；拦截图片点击放大 */
function onClick(e: MouseEvent) {
  const target = (e.target as HTMLElement) ?? null

  // 图片：放大查看
  if (target && target.tagName === 'IMG') {
    e.preventDefault()
    const img = target as HTMLImageElement
    lightboxSrc.value = img.currentSrc || img.src
    lightboxOpen.value = true
    return
  }

  const anchor = target?.closest('a') as HTMLAnchorElement | null
  if (!anchor) return
  const href = anchor.getAttribute('href') ?? ''
  // 站内路由链接（以 BASE_URL 开头但不以 http 开头）
  if (href.startsWith(BASE_URL) && !/^https?:/i.test(href)) {
    const path = href.slice(BASE_URL.length) || '/'
    e.preventDefault()
    router.push('/' + path.replace(/^\/+/, ''))
  }
}

function refresh() {
  const root = containerRef.value
  if (!root) return
  injectCopyButtons(root)
}

onMounted(() => {
  refresh()
  containerRef.value?.addEventListener('click', onClick)
})

onBeforeUnmount(() => {
  containerRef.value?.removeEventListener('click', onClick)
})

watch(
  () => props.html,
  () => {
    // DOM 更新后再注入按钮
    requestAnimationFrame(refresh)
  },
)
</script>

<template>
  <div ref="containerRef" class="prose-agent" v-html="html"></div>
  <ImageLightbox :src="lightboxSrc" :visible="lightboxOpen" @close="lightboxOpen = false" />
</template>
