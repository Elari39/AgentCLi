<script setup lang="ts">
import type { DocState } from '../data/types'

defineProps<{
  state: DocState
  error?: string
}>()
</script>

<template>
  <div v-if="state === 'loading'" class="flex flex-col items-center justify-center py-24 text-ink-muted">
    <div class="h-10 w-10 animate-spin rounded-full border-4 border-line border-t-accent"></div>
    <p class="mt-4 text-sm">文档加载中…</p>
  </div>

  <div
    v-else-if="state === 'error'"
    class="flex flex-col items-center justify-center py-24 text-ink-soft"
  >
    <svg class="h-12 w-12 text-rose-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m0 3.75h.008M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
    <p class="mt-4 text-base font-medium text-rose-500">文档加载失败</p>
    <p v-if="error" class="mt-1 text-sm text-ink-muted">{{ error }}</p>
    <RouterLink to="/intro" class="mt-4 text-sm text-accent hover:underline">返回首页</RouterLink>
  </div>

  <div v-else-if="state === 'empty'" class="flex flex-col items-center justify-center py-24 text-ink-muted">
    <svg class="h-12 w-12 text-ink-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
    </svg>
    <p class="mt-4 text-sm">该文档暂无内容</p>
  </div>
</template>
