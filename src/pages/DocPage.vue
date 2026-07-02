<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useDoc } from '../composables/useDoc'
import { getAdjacent, titleOf } from '../data/summary'
import DocLayout from '../components/DocLayout.vue'
import MarkdownRenderer from '../components/MarkdownRenderer.vue'
import DocState from '../components/DocState.vue'

const route = useRoute()
const slugRef = computed(() => route.params.slug)
const { state, html, headings, error } = useDoc(slugRef)

const adjacent = computed(() => {
  const slug = slugRef.value
  const s = Array.isArray(slug) ? slug[0] : slug
  if (!s) return { prev: undefined, next: undefined }
  return getAdjacent(s)
})

const currentTitle = computed(() => {
  const slug = slugRef.value
  const s = Array.isArray(slug) ? slug[0] : slug
  return s ? titleOf(s) : undefined
})
</script>

<template>
  <DocLayout :headings="state === 'ready' ? headings : []">
    <!-- 标题 -->
    <div v-if="currentTitle && state === 'ready'" class="mb-6 text-xs text-ink-muted">
      {{ currentTitle }}
    </div>

    <DocState v-if="state !== 'ready'" :state="state" :error="error" />

    <MarkdownRenderer v-if="state === 'ready'" :html="html" />

    <!-- 上一页 / 下一页 -->
    <nav
      v-if="state === 'ready' && (adjacent.prev || adjacent.next)"
      class="mt-12 flex border-t border-line pt-6"
    >
      <RouterLink
        v-if="adjacent.prev"
        :to="`/${adjacent.prev}`"
        class="group flex flex-1 flex-col rounded-lg border border-line px-4 py-2 hover:border-accent hover:bg-accent-soft"
      >
        <span class="text-xs text-ink-muted">上一页</span>
        <span class="truncate text-sm font-medium text-ink group-hover:text-accent">
          {{ titleOf(adjacent.prev) }}
        </span>
      </RouterLink>
      <div v-else class="flex-1"></div>
      <RouterLink
        v-if="adjacent.next"
        :to="`/${adjacent.next}`"
        class="group ml-3 flex flex-1 flex-col items-end rounded-lg border border-line px-4 py-2 text-right hover:border-accent hover:bg-accent-soft"
      >
        <span class="text-xs text-ink-muted">下一页</span>
        <span class="truncate text-sm font-medium text-ink group-hover:text-accent">
          {{ titleOf(adjacent.next) }}
        </span>
      </RouterLink>
    </nav>
  </DocLayout>
</template>
