<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue'

const props = defineProps<{
  src: string
  visible: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}

// 仅在可见时监听 Esc，避免未打开时拦截
watch(
  () => props.visible,
  (v) => {
    if (v) window.addEventListener('keydown', onKeydown)
    else window.removeEventListener('keydown', onKeydown)
  },
)

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
      @click.self="$emit('close')"
    >
      <img :src="src" class="max-h-[90vh] max-w-[90vw] rounded-lg shadow-2xl" alt="" />
    </div>
  </Teleport>
</template>
