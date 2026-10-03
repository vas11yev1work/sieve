<script setup lang="ts">
import { computed } from 'vue';
import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import { highlight } from 'sugar-high';
import DOMPurify from 'dompurify';

const marked = new Marked(markedHighlight({ highlight: (code) => highlight(code) }));

/**
 * `inline`: one-line texts (titles, summaries, labels). Only `code` spans are rendered; everything else stays
 * literal, so identifiers like __init__ or "a * b" are not turned into bold/italics.
 */
const props = defineProps<{ text: string; inline?: boolean }>();

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]!);

const html = computed(() => {
  if (props.inline)
    return (props.text || '')
      .split(/(`[^`\n]+`)/)
      .map((part) => (/^`[^`]+`$/.test(part) ? `<code>${esc(part.slice(1, -1))}</code>` : esc(part)))
      .join('');
  const raw = marked.parse(props.text || '', { async: false, gfm: true, breaks: true }) as string;
  return DOMPurify.sanitize(raw, { ADD_ATTR: ['target'] });
});
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- every part is HTML-escaped -->
  <span v-if="inline" class="md-inline" v-html="html" />
  <!-- eslint-disable-next-line vue/no-v-html -- sanitized by DOMPurify -->
  <div v-else class="md" v-html="html" />
</template>
