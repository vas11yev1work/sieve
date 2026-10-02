<script setup lang="ts">
import { computed } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

const props = defineProps<{ text: string }>()

const html = computed(() => {
  const raw = marked.parse(props.text || '', { async: false, gfm: true, breaks: true }) as string
  return DOMPurify.sanitize(raw, { ADD_ATTR: ['target'] })
})
</script>

<template>
  <div class="md" v-html="html" />
</template>
