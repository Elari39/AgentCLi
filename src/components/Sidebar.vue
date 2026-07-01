<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { navTree, findGroupOf } from '../data/summary'

const route = useRoute()

const currentSlug = computed(() => {
  const s = route.params.slug
  return Array.isArray(s) ? s[0] : s
})

/** 折叠状态：记录已折叠的分组标题集合 */
const collapsed = ref<Set<string>>(new Set())

/** 自动展开当前 slug 所在分组 */
watch(
  currentSlug,
  (slug) => {
    if (!slug) return
    const g = findGroupOf(slug)
    if (g) collapsed.value.delete(g.title)
  },
  { immediate: true },
)

function toggle(title: string) {
  const next = new Set(collapsed.value)
  if (next.has(title)) next.delete(title)
  else next.add(title)
  collapsed.value = next
}

function isActive(slug: string): boolean {
  return slug === currentSlug.value
}
</script>

<template>
  <nav class="space-y-1 text-sm">
    <div v-for="group in navTree" :key="group.title" class="mb-2">
      <!-- 分组标题 -->
      <button
        class="flex w-full items-center gap-1 rounded px-2 py-1.5 text-left font-semibold text-ink hover:bg-surface-alt"
        @click="toggle(group.title)"
      >
        <svg
          class="h-3.5 w-3.5 shrink-0 transition-transform"
          :class="{ '-rotate-90': collapsed.has(group.title) }"
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
        </svg>
        <span class="truncate">{{ group.title }}</span>
      </button>

      <!-- 子项 -->
      <ul v-show="!collapsed.has(group.title)" class="ml-3 mt-0.5 border-l border-line">
        <li v-for="child in group.children" :key="child.slug">
          <RouterLink
            :to="`/${child.slug}`"
            class="block truncate border-l-2 border-transparent py-1.5 pl-3 pr-2 text-ink-soft transition-colors hover:border-accent hover:text-accent"
            :class="{
              'border-accent bg-accent-soft font-medium text-accent': isActive(child.slug),
            }"
          >
            {{ child.title }}
          </RouterLink>
        </li>
      </ul>
    </div>
  </nav>
</template>
