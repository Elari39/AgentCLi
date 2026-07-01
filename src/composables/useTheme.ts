// 主题（深浅色）管理：class-based，跟随系统 + 记住用户选择
import { ref, watch } from 'vue'

type Theme = 'light' | 'dark'

const STORAGE_KEY = 'meow-theme'

/** 读取用户已保存的选择（未保存返回 null） */
function readStored(): Theme | null {
  const s = localStorage.getItem(STORAGE_KEY)
  return s === 'light' || s === 'dark' ? s : null
}

/** 系统当前偏好 */
function systemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** 计算初始主题：优先 localStorage，否则跟随系统 */
function resolveInitial(): Theme {
  const stored = readStored()
  if (stored) return stored
  return systemPrefersDark() ? 'dark' : 'light'
}

const theme = ref<Theme>(resolveInitial())

/** 将主题同步到 <html> 的 .dark 类 */
function applyClass(value: Theme) {
  document.documentElement.classList.toggle('dark', value === 'dark')
}

// 初始同步（index.html 内联脚本已先行设置，这里保证后续切换一致）
applyClass(theme.value)

// 主题变化时同步 class 与 localStorage
watch(theme, (value) => {
  applyClass(value)
  localStorage.setItem(STORAGE_KEY, value)
})

// 仅当用户未手动选择时，跟随系统变化
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  if (readStored()) return // 用户已选择，不再跟随
  theme.value = e.matches ? 'dark' : 'light'
})

export function useTheme() {
  function toggle() {
    theme.value = theme.value === 'dark' ? 'light' : 'dark'
  }

  return { theme, toggle }
}
