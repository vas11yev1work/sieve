<script setup lang="ts">
import { ref, shallowRef, watch, nextTick } from 'vue';
import { VueFlow, useVueFlow, MarkerType, Panel, Position, type Node, type Edge } from '@vue-flow/core';
import { Background } from '@vue-flow/background';
import { Controls } from '@vue-flow/controls';
import dagre from '@dagrejs/dagre';
import '@vue-flow/core/dist/style.css';
import '@vue-flow/core/dist/theme-default.css';
import '@vue-flow/controls/dist/style.css';
import type { MapFlow, MapNode } from '../../../shared/types';
import { mapStore } from '../map';
import { t } from '../i18n';
import MapNodeCard, { type Port } from './MapNodeCard.vue';
import MapEdge, { type MapEdgeData } from './MapEdge.vue';

/** Rendered with `:key="flow.id"`, so every flow gets a fresh graph that is laid out once its nodes are measured. */
const props = defineProps<{ flow: MapFlow }>();

const { fitView, fitBounds, getViewport, zoomTo, setCenter, findNode, updateNode, updateNodeInternals } = useVueFlow();

const nodes = ref<Node<{ node: MapNode; ports: Port[] }>[]>(
  props.flow.nodes.map((n) => ({ id: n.id, type: 'step', position: { x: 0, y: 0 }, data: { node: n, ports: [] } })),
);
// Edges need their nodes' handles, which exist only after layout (see route()).
const edges = shallowRef<Edge<MapEdgeData>[]>([]);
const ready = ref(false);

/** Distance between neighbouring handles on one side of a node. */
const PORT_GAP = 22;
/** How far a back edge loops out past the nodes it passes, and the extra step for each further loop. */
const LOOP_OUT = 28;
const LOOP_STEP = 16;

/** Node center and size after layout (flow coordinates). */
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function layout() {
  const g = new dagre.graphlib.Graph();
  // Edge labels sit between ranks, so leave room for them.
  g.setGraph({ rankdir: 'TB', nodesep: 110, ranksep: 80 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes.value) {
    const d = findNode(n.id)?.dimensions;
    g.setNode(n.id, { width: d?.width || 260, height: d?.height || 80 });
  }
  for (const e of props.flow.edges) g.setEdge(e.from, e.to);
  dagre.layout(g);
  const boxes = new Map<string, Box>();
  for (const n of nodes.value) {
    const p = g.node(n.id);
    boxes.set(n.id, { x: p.x, y: p.y, w: p.width, h: p.height });
    updateNode(n.id, { position: { x: p.x - p.width / 2, y: p.y - p.height / 2 } });
  }
  return boxes;
}

/**
 * Give every edge its own handles so edges never share a point:
 * - downward edges go bottom → top; handles on a side are spread out, ordered by where the other end is;
 * - a back-and-forth pair runs as two parallel lines (forward on the left, back on the right), labels outwards;
 * - any other upward edge loops around the right side, so it never runs under the nodes.
 */
function route(c: Map<string, Box>): Edge<MapEdgeData>[] {
  const keys = new Set(props.flow.edges.map((e) => `${e.from}>${e.to}`));
  const sides = new Map<string, { port: Omit<Port, 'offset'>; key: number }[]>();
  const add = (node: string, port: Omit<Port, 'offset'>, key: number) => {
    const k = `${node}|${port.side}`;
    if (!sides.has(k)) sides.set(k, []);
    sides.get(k)!.push({ port, key });
  };
  let loops = 0;
  loopRight = 0;

  const out = props.flow.edges.map((e) => {
    const id = `${e.from}>${e.to}`;
    const a = c.get(e.from)!;
    const b = c.get(e.to)!;
    const paired = keys.has(`${e.to}>${e.from}`);
    let src: Position;
    let dst: Position;
    let align: MapEdgeData['align'] = 'center';
    let loop: MapEdgeData['loop'];
    if (b.y - a.y > 1) {
      [src, dst] = [Position.Bottom, Position.Top];
      if (paired) align = 'left';
    } else if (a.y - b.y > 1 && paired) {
      [src, dst, align] = [Position.Top, Position.Bottom, 'right'];
    } else if (a.y - b.y > 1) {
      // A node with a neighbour to its right in the same row can't use its right side: the run would pass
      // behind that neighbour. It leaves through the top (enters through the bottom) and uses the gap between rows.
      const blocked = (m: Box) => [...c.values()].some((n) => Math.abs(n.y - m.y) < 1 && n.x > m.x);
      const exitUp = blocked(a);
      const entryDown = blocked(b);
      [src, dst, align] = [
        exitUp ? Position.Top : Position.Right,
        entryDown ? Position.Bottom : Position.Right,
        'right',
      ];
      // Out past the right edge of every node between the two ends, nested loops further out.
      const right = Math.max(
        ...[...c.values()]
          .filter((n) => n.y + n.h / 2 >= b.y - b.h / 2 && n.y - n.h / 2 <= a.y + a.h / 2)
          .map((n) => n.x + n.w / 2),
      );
      const x = right + LOOP_OUT + loops++ * LOOP_STEP;
      loop = { x, exitUp, entryDown };
      loopRight = Math.max(loopRight, x);
    } else {
      [src, dst] = b.x >= a.x ? [Position.Right, Position.Left] : [Position.Left, Position.Right];
    }
    // Order along the side by the other end; within a pair the back edge sits to the right,
    // and loops leaving through the top/bottom take the right end of that side (they head right).
    const key = (side: Position, other: Box) =>
      side === Position.Top || side === Position.Bottom
        ? (loop ? 1e6 : other.x) + (align === 'right' ? 0.5 : 0)
        : other.y;
    add(e.from, { id: `${id}:s`, type: 'source', side: src }, key(src, b));
    add(e.to, { id: `${id}:t`, type: 'target', side: dst }, key(dst, a));

    return {
      id,
      source: e.from,
      target: e.to,
      sourceHandle: `${id}:s`,
      targetHandle: `${id}:t`,
      type: 'map',
      animated: e.kind === 'async',
      class: `k-${e.kind || 'call'}`,
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: 'var(--edge)' },
      data: { label: e.label, align, loop },
    };
  });

  const ports = new Map<string, Port[]>();
  for (const [k, list] of sides) {
    const node = k.slice(0, k.lastIndexOf('|'));
    list.sort((x, y) => x.key - y.key);
    list.forEach(({ port }, i) => {
      if (!ports.has(node)) ports.set(node, []);
      ports.get(node)!.push({ ...port, offset: (i - (list.length - 1) / 2) * PORT_GAP });
    });
  }
  for (const n of nodes.value) updateNode(n.id, { data: { ...n.data!, ports: ports.get(n.id) || [] } });
  return out;
}

/** Rightmost back-edge run (flow x), 0 when there are none: fitView only sees nodes, loops stick out. */
let loopRight = 0;
const MAX_ZOOM = 1.1;

async function fit(duration = 0) {
  if (!loopRight) return fitView({ padding: 0.25, maxZoom: MAX_ZOOM, duration });
  const ns = props.flow.nodes.map((n) => findNode(n.id)!);
  const x = Math.min(...ns.map((n) => n.position.x));
  const y = Math.min(...ns.map((n) => n.position.y));
  const right = Math.max(loopRight + 24, ...ns.map((n) => n.position.x + n.dimensions.width));
  const bottom = Math.max(...ns.map((n) => n.position.y + n.dimensions.height));
  await fitBounds({ x, y, width: right - x, height: bottom - y }, { padding: 0.15, duration });
  if (getViewport().zoom > MAX_ZOOM) await zoomTo(MAX_ZOOM, { duration });
}

async function onInit() {
  if (ready.value) return; // nodes-initialized fires again when handles change
  const centers = layout();
  const routed = route(centers);
  await nextTick();
  updateNodeInternals(props.flow.nodes.map((n) => n.id));
  await nextTick();
  edges.value = routed;
  if (mapStore.nodeId && findNode(mapStore.nodeId)) focus(0);
  else await fit();
  ready.value = true;
}

function focus(duration = 300) {
  const n = findNode(mapStore.nodeId);
  if (!n) return;
  const w = n.dimensions.width || 260;
  const h = n.dimensions.height || 80;
  setCenter(n.position.x + w / 2, n.position.y + h / 2, { zoom: 1.1, duration });
}

watch(
  () => mapStore.fitTick,
  () => fit(300),
);
watch(
  () => mapStore.focusTick,
  () => ready.value && focus(),
);
</script>

<template>
  <VueFlow
    v-model:nodes="nodes"
    v-model:edges="edges"
    class="graph"
    :class="{ ready }"
    :nodes-connectable="false"
    :edges-updatable="false"
    :min-zoom="0.2"
    :max-zoom="2"
    @nodes-initialized="onInit"
    @node-click="({ node }) => (mapStore.nodeId = node.id)"
    @pane-click="mapStore.nodeId = ''"
  >
    <template #node-step="p"><MapNodeCard :id="p.id" :data="p.data" /></template>
    <template #edge-map="p"><MapEdge v-bind="p" /></template>
    <Background :gap="18" :size="1.4" />
    <Controls :show-interactive="false" position="bottom-left" />
    <Panel position="top-left" class="legend">
      <span class="item"><i class="sw added">+</i>{{ t.added }}</span>
      <span class="item"><i class="sw modified">~</i>{{ t.modified }}</span>
      <span class="item"><i class="sw removed">−</i>{{ t.removed }}</span>
      <span class="sep" />
      <span class="item"
        ><svg width="22" height="6"><line x1="0" y1="3" x2="22" y2="3" /></svg>{{ t.edgeCall }}</span
      >
      <span class="item"
        ><svg width="22" height="6"><line x1="0" y1="3" x2="22" y2="3" class="dash" /></svg>{{ t.edgeAsync }}</span
      >
      <span class="item"
        ><svg width="22" height="6"><line x1="0" y1="3" x2="22" y2="3" class="dot" /></svg>{{ t.edgeEvent }}</span
      >
    </Panel>
  </VueFlow>
</template>

<style scoped>
.graph {
  background: var(--map-bg);
  height: 100%;
  opacity: 0;
  transition: opacity 0.15s;
}
.graph.ready {
  opacity: 1;
}
.graph :deep(.vue-flow__background pattern circle) {
  fill: var(--map-dots);
}
.graph :deep(.vue-flow__node-step) {
  border: none;
  padding: 0;
  background: transparent;
}
.graph :deep(.vue-flow__edge-path) {
  stroke: var(--edge);
  stroke-width: 1.5;
}
.graph :deep(.vue-flow__edge.k-event .vue-flow__edge-path) {
  stroke-dasharray: 1 4;
  stroke-linecap: round;
  stroke-width: 2;
}
.graph :deep(.vue-flow__edge.animated .vue-flow__edge-path) {
  stroke-dasharray: 6 4;
}
.graph :deep(.vue-flow__controls) {
  display: flex;
  flex-direction: column;
  gap: 8px;
  box-shadow: none;
}
.graph :deep(.vue-flow__controls-button) {
  width: 36px;
  height: 36px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--panel);
  color: var(--text);
  box-shadow:
    0 1px 3px rgba(20, 20, 40, 0.1),
    0 4px 12px rgba(20, 20, 40, 0.1);
  transition:
    box-shadow 0.12s,
    transform 0.12s;
}
.graph :deep(.vue-flow__controls-button:hover) {
  background: var(--panel);
  box-shadow:
    0 2px 4px rgba(20, 20, 40, 0.12),
    0 6px 16px rgba(20, 20, 40, 0.14);
  transform: translateY(-1px);
}
.graph :deep(.vue-flow__controls-button svg) {
  width: 14px;
  height: 14px;
  max-width: none;
  max-height: none;
  fill: currentColor;
}
.legend {
  display: flex;
  align-items: center;
  gap: 10px;
  white-space: nowrap;
  padding: 6px 10px;
  background: color-mix(in srgb, var(--panel) 92%, transparent);
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 11.5px;
  color: var(--muted);
  box-shadow: var(--shadow);
}
.legend .item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.legend .sep {
  width: 1px;
  height: 14px;
  background: var(--border);
}
.sw {
  font: 700 12px/1 var(--mono);
  font-style: normal;
  display: inline-grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border-radius: 4px;
  color: var(--c);
  background: color-mix(in srgb, var(--c) 16%, transparent);
}
.sw.added {
  --c: var(--chg-added);
}
.sw.modified {
  --c: var(--chg-modified);
}
.sw.removed {
  --c: var(--chg-removed);
}
.legend line {
  stroke: var(--edge);
  stroke-width: 2;
}
.legend line.dash {
  stroke-dasharray: 5 3;
}
.legend line.dot {
  stroke-dasharray: 1 3;
  stroke-linecap: round;
}
</style>
