<script setup lang="ts">
import { computed } from 'vue'
import type { FindingContext } from '../api'

const props = defineProps<{ ctx: FindingContext | null; line: number; endLine?: number }>()

const from = computed(() => props.line)
const to = computed(() => props.endLine || props.line)
const hit = (n?: number) => n !== undefined && n >= from.value && n <= to.value

interface Row {
  type: 'add' | 'del' | 'ctx' | 'hunk'
  old?: number
  new?: number
  text: string
}

const rows = computed<Row[]>(() => {
  const c = props.ctx
  if (!c) return []
  if (c.hunks.length) {
    const out: Row[] = []
    for (const h of c.hunks) {
      out.push({ type: 'hunk', text: h.header })
      // Trim very long hunks to a window around the finding.
      const idx = h.lines.findIndex((l) => l.new !== undefined && l.new >= from.value - 12)
      const start = h.lines.length > 80 && idx > 0 ? idx : 0
      const slice = h.lines.slice(start, h.lines.length > 80 ? start + 60 : undefined)
      for (const l of slice) out.push({ type: l.type, old: l.old, new: l.new, text: l.text })
    }
    return out
  }
  if (c.snippet) return c.snippet.lines.map((text, i) => ({ type: 'ctx' as const, new: c.snippet!.start + i, text }))
  return []
})
</script>

<template>
  <div class="diff">
    <div v-if="!rows.length" class="muted pad">—</div>
    <table v-else>
      <tbody>
        <tr v-for="(r, i) in rows" :key="i" :class="[r.type, { hit: hit(r.new) }]">
          <template v-if="r.type === 'hunk'">
            <td colspan="4" class="hunk">{{ r.text }}</td>
          </template>
          <template v-else>
            <td class="num">{{ r.old ?? '' }}</td>
            <td class="num">{{ r.new ?? '' }}</td>
            <td class="sign">{{ r.type === 'add' ? '+' : r.type === 'del' ? '−' : '' }}</td>
            <td class="code">{{ r.text }}</td>
          </template>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.diff {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: auto;
  background: var(--code-bg);
  max-height: 440px;
}
.pad {
  padding: 12px;
}
table {
  border-collapse: collapse;
  width: 100%;
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.55;
}
td {
  padding: 0 8px;
  vertical-align: top;
}
.num {
  width: 1%;
  min-width: 38px;
  text-align: right;
  color: var(--muted);
  user-select: none;
  opacity: 0.8;
}
.sign {
  width: 1%;
  user-select: none;
  color: var(--muted);
  padding: 0 2px;
}
.code {
  white-space: pre;
}
.hunk {
  color: var(--muted);
  background: var(--panel-2);
  padding: 3px 10px;
  font-size: 11.5px;
}
tr.add {
  background: var(--add-bg);
}
tr.add .code,
tr.add .sign {
  color: var(--add-fg);
}
tr.del {
  background: var(--del-bg);
}
tr.del .code,
tr.del .sign {
  color: var(--del-fg);
}
tr.hit {
  box-shadow: inset 3px 0 0 var(--accent);
}
tr.hit td {
  background: var(--hl-bg);
}
</style>
