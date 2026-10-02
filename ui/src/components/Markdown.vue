<script setup lang="ts">
import { computed } from 'vue';
import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import { highlight } from 'sugar-high';
import DOMPurify from 'dompurify';

const marked = new Marked(markedHighlight({ highlight: (code) => highlight(code) }));

const props = defineProps<{ text: string }>();

const html = computed(() => {
  const raw = marked.parse(props.text || '', { async: false, gfm: true, breaks: true }) as string;
  return DOMPurify.sanitize(raw, { ADD_ATTR: ['target'] });
});
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- sanitized by DOMPurify -->
  <div class="md" v-html="html" />
</template>
