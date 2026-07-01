<script setup lang="ts">
import { ref, watch } from 'vue'
import Sidebar from './Sidebar.vue'
import { useTheme } from '../composables/useTheme'

const sidebarOpen = ref(false)

// 桌面端侧栏收起态：跨刷新记忆
const SIDEBAR_KEY = 'meow-sidebar'
const sidebarCollapsed = ref(localStorage.getItem(SIDEBAR_KEY) === 'collapsed')
watch(sidebarCollapsed, (v) => {
  localStorage.setItem(SIDEBAR_KEY, v ? 'collapsed' : 'expanded')
})

const { theme, toggle } = useTheme()
</script>

<template>
  <div class="flex h-screen overflow-hidden bg-paper">
    <!-- 侧栏（桌面常驻可收起 / 移动抽屉） -->
    <aside
      class="fixed inset-y-0 left-0 z-30 w-72 transform border-r border-line bg-surface transition-transform duration-200"
      :class="[
        sidebarOpen ? 'translate-x-0' : '-translate-x-full',
        sidebarCollapsed ? 'md:hidden!' : 'md:static md:translate-x-0',
      ]"
    >
      <div class="flex h-14 items-center border-b border-line px-4">
        <span class="truncate text-base font-bold text-ink">MewCode Agent 课程</span>
      </div>
      <div class="h-[calc(100vh-3.5rem)] overflow-y-auto px-3 py-3">
        <Sidebar />
      </div>
    </aside>

    <!-- 移动端遮罩 -->
    <div
      v-if="sidebarOpen"
      class="fixed inset-0 z-20 bg-black/30 md:hidden"
      @click="sidebarOpen = false"
    ></div>

    <!-- 主区域 -->
    <div class="flex flex-1 flex-col overflow-hidden">
      <!-- 顶栏 -->
      <header
        class="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-4"
      >
        <!-- 移动端：抽屉式目录 -->
        <button
          class="rounded p-1.5 text-ink-muted hover:bg-surface-alt md:hidden"
          @click="sidebarOpen = !sidebarOpen"
          aria-label="切换目录"
        >
          <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5M3.75 17.25h16.5" />
          </svg>
        </button>
        <!-- 桌面端：收起/展开侧栏 -->
        <button
          class="hidden rounded p-1.5 text-ink-muted hover:bg-surface-alt md:inline-flex"
          @click="sidebarCollapsed = !sidebarCollapsed"
          :aria-label="sidebarCollapsed ? '展开目录' : '收起目录'"
        >
          <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5M3.75 17.25h16.5" />
          </svg>
        </button>
        <span class="text-sm text-ink-muted">MewCode Agent 课程文档</span>
        <button
          class="ml-auto rounded p-1.5 text-ink-muted hover:bg-surface-alt"
          @click="toggle"
          :aria-label="theme === 'dark' ? '切换为浅色' : '切换为深色'"
        >
          <!-- 浅色时显示月亮（切到深色），深色时显示太阳（切到浅色） -->
          <svg v-if="theme === 'dark'" class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="4" />
            <path stroke-linecap="round" d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32l1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32l1.41-1.41" />
          </svg>
          <svg v-else class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />
          </svg>
        </button>
      </header>

      <!-- 内容 -->
      <main class="flex-1 overflow-y-auto">
        <div class="mx-auto max-w-4xl px-5 py-8 md:px-8">
          <slot />
        </div>
      </main>
    </div>
  </div>
</template>
