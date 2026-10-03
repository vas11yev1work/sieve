<script setup lang="ts">
import type { MapFlow, PrMap } from '../../../shared/types';
import { openFlow, sevCounts } from '../map';
import { t } from '../i18n';
import { TriangleAlert } from 'lucide-vue-next';

/** The "read first" page of the map: what the PR does, where, what could go wrong, and its flows. */
defineProps<{ map: PrMap }>();

const changed = (f: MapFlow) => f.nodes.filter((n) => n.change !== 'unchanged').length;
const flowSevs = (f: MapFlow) => sevCounts(f.nodes.flatMap((n) => n.findingIds || []));
</script>

<template>
  <div class="page scroll">
    <article class="doc">
      <p class="lede">{{ map.overview.summary }}</p>

      <section v-if="map.overview.areas.length">
        <h3>{{ t.areas }}</h3>
        <div class="areas">
          <span v-for="a in map.overview.areas" :key="a" class="chip">{{ a }}</span>
        </div>
      </section>

      <section v-if="map.overview.risks.length">
        <h3>{{ t.risks }}</h3>
        <ul class="risks">
          <li v-for="r in map.overview.risks" :key="r">
            <TriangleAlert :size="15" /> <span>{{ r }}</span>
          </li>
        </ul>
      </section>

      <section v-if="map.flows.length">
        <h3>{{ t.flows }}</h3>
        <ul class="flows">
          <li v-for="f in map.flows" :key="f.id">
            <button class="flow" :title="t.openGraph" @click="openFlow(f.id)">
              <span class="ftitle">{{ f.title }}</span>
              <span class="fdesc">{{ f.description }}</span>
              <span class="chain mono">
                <template v-for="(n, i) in f.nodes" :key="n.id"
                  ><span v-if="i" class="arrow"> → </span><span :class="n.change">{{ n.label }}</span></template
                >
              </span>
              <span class="stats">
                <span v-if="changed(f)" class="chip chg">{{ changed(f) }} {{ t.changedCount }}</span>
                <span v-for="s in flowSevs(f)" :key="s.sev" class="sevn" :class="s.sev">{{ s.n }}</span>
              </span>
            </button>
          </li>
        </ul>
      </section>
      <p v-else class="muted">{{ t.noFlows }}</p>
    </article>
  </div>
</template>

<style scoped>
.page {
  height: 100%;
  background: var(--bg);
}
.doc {
  max-width: 72ch;
  margin: 0 auto;
  padding: 40px 32px 64px;
}
.lede {
  margin: 0 0 36px;
  font-size: 18px;
  line-height: 1.6;
  letter-spacing: -0.005em;
  text-wrap: pretty;
}
section {
  margin-bottom: 32px;
}
h3 {
  margin: 0 0 12px;
  font-size: 15px;
  font-weight: 650;
}
.areas {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.areas .chip {
  font-size: 12.5px;
  padding: 3px 10px;
  background: var(--panel);
  border: 1px solid var(--border);
  color: var(--text);
}
.risks {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.risks li {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  line-height: 1.55;
}
.risks .lucide {
  color: var(--chg-modified);
  margin-top: 3px;
}
.flows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.flow {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  padding: 14px 16px;
  text-align: left;
  border-radius: 12px;
  background: var(--panel);
}
.flow:hover:not(:disabled) {
  background: var(--panel);
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
}
.flow:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.ftitle {
  font-size: 15px;
  font-weight: 600;
}
.fdesc {
  color: var(--muted);
  font-size: 13.5px;
  line-height: 1.5;
}
/* The flow as a sentence of steps: what calls what, with the changed steps in their change color. */
.chain {
  font-size: 12px;
  line-height: 1.7;
  color: var(--muted);
}
.chain .arrow {
  opacity: 0.6;
}
.chain .modified {
  color: var(--chg-modified);
  font-weight: 600;
}
.chain .added {
  color: var(--chg-added);
  font-weight: 600;
}
.chain .removed {
  color: var(--chg-removed);
  text-decoration: line-through;
}
.stats {
  display: flex;
  align-items: center;
  gap: 8px;
}
.stats:empty {
  display: none;
}
.chip.chg {
  color: var(--chg-modified);
  background: color-mix(in srgb, var(--chg-modified) 14%, transparent);
}
@media (max-width: 720px) {
  .doc {
    padding: 24px 16px 48px;
  }
}
</style>
