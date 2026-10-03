import { reactive, computed, type Component } from 'vue';
import type { MapNodeKind, MapStatus, Severity } from '../../shared/types';
import { SEVERITIES } from '../../shared/types';
import {
  MousePointerClick,
  LayoutTemplate,
  Puzzle,
  Database,
  Server,
  Globe,
  Route,
  Wrench,
  ExternalLink,
  Circle,
} from 'lucide-vue-next';
import { api, stream } from './api';
import { store } from './store';

export const mapStore = reactive({
  /** null until loaded (or when the map is off). */
  status: null as MapStatus | null,
  /** Last progress events of the running build. */
  events: [] as string[],
  /** Sub-tab of the map view: the PR summary or the graph of a flow. */
  tab: 'summary' as 'summary' | 'graph',
  flowId: '',
  nodeId: '',
  /** Bumped to ask the graph to fit / center on the selected node. */
  fitTick: 0,
  focusTick: 0,
});

export const mapEnabled = computed(() => !!store.run && store.run.settings.mapMode !== 'off');
export const prMap = computed(() => (mapStore.status?.state === 'ready' ? mapStore.status.map : null));
export const currentFlow = computed(() => prMap.value?.flows.find((f) => f.id === mapStore.flowId) || null);
export const currentNode = computed(() => currentFlow.value?.nodes.find((n) => n.id === mapStore.nodeId) || null);

export const nodeKey = (flowId: string, nodeId: string) => `map:${flowId}:${nodeId}`;
export const nodeBase = (flowId: string, nodeId: string) =>
  `/api/map/nodes/${encodeURIComponent(flowId)}/${encodeURIComponent(nodeId)}`;

/** finding id → the map nodes it is linked to. */
export const findingRefs = computed(() => {
  const m = new Map<string, { flowId: string; nodeId: string }[]>();
  for (const f of prMap.value?.flows || [])
    for (const n of f.nodes)
      for (const id of n.findingIds || []) {
        if (!m.has(id)) m.set(id, []);
        m.get(id)!.push({ flowId: f.id, nodeId: n.id });
      }
  return m;
});

function setStatus(s: MapStatus) {
  mapStore.status = s;
  if (s.state !== 'ready') return;
  if (!s.map.flows.some((f) => f.id === mapStore.flowId)) {
    mapStore.flowId = s.map.flows[0]?.id || '';
    mapStore.nodeId = '';
  } else if (!currentNode.value) mapStore.nodeId = '';
}

export async function loadMap() {
  if (!mapEnabled.value) return;
  try {
    setStatus(await api.map());
  } catch (e) {
    setStatus({ state: 'error', error: (e as Error).message });
  }
  if (mapStore.status?.state === 'building') void follow(null);
}

let following = false;

/** Start a build (`body` = {}) or follow the running one (`body` = null) until it ends. */
async function follow(body: object | null) {
  if (following) return;
  following = true;
  if (body) {
    mapStore.events = [];
    mapStore.status = { state: 'building', startedAt: new Date().toISOString() };
  }
  let done: MapStatus | null = null;
  try {
    const url = body ? '/api/map/build' : '/api/map/progress';
    done = await stream<MapStatus>(url, body, {
      onProgress: (label) => {
        mapStore.events = [...mapStore.events.filter((e) => e !== label), label].slice(-5);
        if (mapStore.status?.state === 'building') mapStore.status.progress = label;
      },
    });
  } catch {
    // handled below
  } finally {
    following = false;
  }
  // On failure the server knows best: a failed build, a build started elsewhere (409), a dropped connection.
  if (done) setStatus(done);
  else await loadMap();
}

export const buildMap = () => follow({});

export async function cancelMap() {
  setStatus(await api.cancelMap());
}

export function selectFlow(id: string) {
  if (id === mapStore.flowId) return;
  mapStore.flowId = id;
  mapStore.nodeId = '';
}

export function moveFlow(delta: number) {
  const flows = prMap.value?.flows || [];
  const i = flows.findIndex((f) => f.id === mapStore.flowId);
  const n = flows[Math.min(flows.length - 1, Math.max(0, i + delta))];
  if (n) selectFlow(n.id);
}

/** Summary → graph of one flow. */
export function openFlow(id: string) {
  mapStore.tab = 'graph';
  selectFlow(id);
}

export function showNode(flowId: string, nodeId: string) {
  store.view = 'map';
  mapStore.tab = 'graph';
  mapStore.flowId = flowId;
  mapStore.nodeId = nodeId;
  mapStore.focusTick++;
}

/** Map → review: open the finding in a tab where it is visible. */
export function showFinding(id: string) {
  const f = store.run?.findings.find((x) => x.id === id);
  if (!f) return;
  store.view = 'review';
  store.kind = 'all';
  store.tab = f.filtered ? 'filtered' : store.run!.state.findings[id]?.status || 'open';
  store.selected = id;
}

export const KIND_ICONS: Record<MapNodeKind, Component> = {
  entry: MousePointerClick,
  component: LayoutTemplate,
  composable: Puzzle,
  store: Database,
  service: Server,
  api: Globe,
  router: Route,
  util: Wrench,
  external: ExternalLink,
  other: Circle,
};

/** Non-zero finding counts per severity, most severe first. */
export function sevCounts(ids: Iterable<string>): { sev: Severity; n: number }[] {
  const set = new Set(ids);
  const list = (store.run?.findings || []).filter((f) => set.has(f.id));
  return SEVERITIES.map((sev) => ({ sev, n: list.filter((f) => f.severity === sev).length })).filter((x) => x.n);
}
