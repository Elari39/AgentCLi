<script setup lang="ts">
import type { DocHeading } from '../data/types'

defineProps<{
  headings: DocHeading[]
}>()

function headingHref(id: string): string {
  return `#${encodeURIComponent(id)}`
}

function scrollToHeading(heading: DocHeading) {
  const el = document.getElementById(heading.id)
  if (!el) return

  el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${window.location.search}${headingHref(heading.id)}`,
  )
}
</script>

<template>
  <aside class="w-64 shrink-0">
    <div class="sticky top-6 max-h-[calc(100vh-6.5rem)] overflow-y-auto border-l border-line pl-4">
      <div class="mb-3 text-xs font-bold tracking-widest text-ink-muted">本文目录</div>
      <nav aria-label="本文目录" class="space-y-1 text-sm">
        <a
          v-for="heading in headings"
          :key="heading.id"
          :href="headingHref(heading.id)"
          :title="heading.text"
          class="block truncate rounded px-2 py-1.5 text-ink-soft transition-colors hover:bg-surface-alt hover:text-accent"
          :class="{
            'pl-5 text-xs': heading.level === 3,
            'font-medium': heading.level === 2,
          }"
          @click.prevent="scrollToHeading(heading)"
        >
          {{ heading.text }}
        </a>
      </nav>
    </div>
  </aside>
</template>
