<script setup lang="ts">
import { computed } from 'vue';
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from '@vue-flow/core';
import Markdown from './Markdown.vue';

export interface MapEdgeData {
  label?: string;
  /** Which side of the path the label sits on: two edges of a back-and-forth pair label outwards. */
  align: 'center' | 'left' | 'right';
  /**
   * Set for a back edge. `x` (flow coordinates) is the vertical run, right of every node it passes.
   * `exitUp` / `entryDown`: the end leaves through the top / enters through the bottom and runs in the gap
   * between rows, because a neighbour sits to its right.
   */
  loop?: { x: number; exitUp: boolean; entryDown: boolean };
}

const props = defineProps<EdgeProps<MapEdgeData>>();
const R = 8;
/** Distance from a node edge to the horizontal run of a loop in the gap between rows. */
const GAP = 28;

/** Orthogonal polyline with rounded corners. */
function rounded(p: [number, number][]): string {
  let d = `M${p[0]![0]},${p[0]![1]}`;
  for (let i = 1; i < p.length - 1; i++) {
    const [x0, y0] = p[i - 1]!;
    const [x, y] = p[i]!;
    const [x1, y1] = p[i + 1]!;
    const r0 = Math.min(R, Math.hypot(x - x0, y - y0) / 2);
    const r1 = Math.min(R, Math.hypot(x1 - x, y1 - y) / 2);
    const ax = x - Math.sign(x - x0) * r0;
    const ay = y - Math.sign(y - y0) * r0;
    const bx = x + Math.sign(x1 - x) * r1;
    const by = y + Math.sign(y1 - y) * r1;
    d += ` L${ax},${ay} Q${x},${y} ${bx},${by}`;
  }
  const [lx, ly] = p[p.length - 1]!;
  return `${d} L${lx},${ly}`;
}

const geo = computed(() => {
  const { sourceX: sx, sourceY: sy, targetX: tx, targetY: ty, data } = props;
  const loop = data.loop;
  if (!loop) {
    const [path, x, y] = getSmoothStepPath({ ...props, borderRadius: R, offset: 20 });
    return { path, x, y, align: data.align };
  }
  // Stays right of both ends even after a node is dragged.
  const X = Math.max(loop.x, sx + R * 2, tx + R * 2);
  const y0 = loop.exitUp ? sy - GAP : sy;
  const y1 = loop.entryDown ? ty + GAP : ty;
  const pts: [number, number][] = [[sx, sy]];
  if (loop.exitUp) pts.push([sx, y0]);
  pts.push([X, y0], [X, y1]);
  if (loop.entryDown) pts.push([tx, y1]);
  pts.push([tx, ty]);
  const path = rounded(pts);
  // Label above the run into the target when it fits there (inside the graph), else outside the vertical run.
  const width = Math.min(200, (data.label?.length || 0) * 6.4 + 14);
  if (X - tx - 2 * R >= width) return { path, x: (X + tx) / 2, y: y1 - 11, align: 'center' as const };
  return { path, x: X, y: (y0 + y1) / 2, align: 'right' as const };
});

const SHIFT = { center: '-50%', left: 'calc(-100% - 8px)', right: '8px' } as const;
</script>

<template>
  <BaseEdge :id="id" :path="geo.path" :marker-end="markerEnd" :style="style" />
  <EdgeLabelRenderer v-if="data.label">
    <div
      class="edge-label nodrag nopan"
      :style="{ transform: `translate(${geo.x}px, ${geo.y}px) translate(${SHIFT[geo.align]}, -50%)` }"
      :title="data.label"
    >
      <Markdown inline :text="data.label" />
    </div>
  </EdgeLabelRenderer>
</template>

<style scoped>
.edge-label {
  position: absolute;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 1px 6px;
  border-radius: 5px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--muted);
  font: 10.5px/1.5 var(--mono);
  pointer-events: all;
}
.edge-label :deep(code) {
  background: transparent;
  padding: 0;
  font-size: 1em;
}
</style>
