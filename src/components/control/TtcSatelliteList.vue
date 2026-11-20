<!-- The fleet list: what the satellite view has active, a catalog search, and the lock action. -->
<template>
  <div class="fleet">
    <UInput v-model="search" size="sm" icon="i-lucide-search" placeholder="搜索卫星名称或 NORAD 编号" :loading="api.fleet.searching" class="fleet__search" />
    <p class="fleet__hint">
      <template v-if="search.trim() !== ''">在全部目录中搜索（首次搜索会加载所有分组，可能需要几秒）。</template>
      <template v-else-if="api.fleet.activeCount > 0">卫星视图当前已激活 {{ api.fleet.activeCount }} 颗卫星；点击一行即可锁定。</template>
      <template v-else>卫星视图尚未激活卫星，下面列出已加载的目录；点击一行会激活并锁定它。</template>
    </p>
    <div class="fleet__rows" role="list">
      <button
        v-for="row in api.fleet.rows"
        :key="row.name"
        type="button"
        role="listitem"
        class="fleet__row"
        :class="{ 'fleet__row--locked': row.name === state.lockedName, 'fleet__row--active': row.active }"
        @click="lock(row.name)"
      >
        <span class="fleet__dot" :style="{ background: orbitColor(row.orbitClass) }" />
        <span class="fleet__name">{{ row.name }}</span>
        <span class="fleet__meta">#{{ row.satnum }} · {{ row.orbitClass }}</span>
        <span v-if="row.active" class="fleet__tag">在轨</span>
        <span v-if="row.hasModel" class="fleet__badge">3D</span>
        <UIcon :name="row.name === state.lockedName ? 'lucide:lock' : 'lucide:crosshair'" class="fleet__icon" />
      </button>
      <p v-if="api.fleet.rows.length === 0" class="fleet__empty">没有匹配的卫星。</p>
    </div>
    <p class="fleet__count">{{ api.fleet.rows.length }} 项<template v-if="api.fleet.total > api.fleet.rows.length">（共 {{ api.fleet.total }} 项）</template></p>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";

import { ORBIT_CLASS_COLOR, type OrbitClass } from "@/config/orbitClass";
import { useTtcConsole } from "@/modules/ttc/console";

const emit = defineEmits<{ locked: [] }>();

const api = useTtcConsole();
const state = api.state;
const search = ref("");
let searchTimer: ReturnType<typeof setTimeout> | undefined;

watch(search, (value) => {
  if (searchTimer !== undefined) {
    clearTimeout(searchTimer);
  }
  searchTimer = setTimeout(() => api.search(value), 200);
});

onBeforeUnmount(() => {
  if (searchTimer !== undefined) {
    clearTimeout(searchTimer);
  }
});

function orbitColor(orbitClass: string): string {
  return ORBIT_CLASS_COLOR[orbitClass as OrbitClass] ?? "var(--panel-muted)";
}

function lock(name: string): void {
  api.lock(name);
  emit("locked");
}
</script>

<style scoped>
.fleet {
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-height: 0;
}

.fleet__search {
  margin: 0 2px;
}

.fleet__hint,
.fleet__count {
  margin: 0 2px;
  color: var(--panel-muted);
  font-size: 11px;
  line-height: 1.45;
}

.fleet__rows {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: min(62dvh, 620px);
  overflow-y: auto;
  padding-right: 2px;
}

.fleet__row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 34px;
  padding: 5px 9px;
  background: none;
  border: 1px solid transparent;
  border-radius: 7px;
  color: var(--panel-ink);
  text-align: left;
  cursor: pointer;
}

.fleet__row:hover {
  background: var(--panel-raised);
}

.fleet__row--active {
  background: var(--panel-raised);
}

.fleet__row--locked {
  background: var(--panel-selected);
  border-color: color-mix(in srgb, var(--panel-accent) 55%, transparent);
}

.fleet__dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.fleet__name {
  overflow: hidden;
  flex: 1;
  font-size: 12.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fleet__meta {
  flex: none;
  color: var(--panel-muted);
  font-size: 10px;
}

.fleet__tag {
  flex: none;
  padding: 0 4px;
  border: 1px solid var(--panel-hairline);
  border-radius: 4px;
  color: var(--panel-muted);
  font-size: 9px;
  line-height: 15px;
}

.fleet__badge {
  flex: none;
  padding: 0 4px;
  background: var(--panel-raised);
  border-radius: 4px;
  color: var(--panel-muted);
  font-size: 9px;
  line-height: 16px;
}

.fleet__icon {
  flex: none;
  color: var(--panel-muted);
  font-size: 15px;
}

.fleet__row--locked .fleet__icon {
  color: var(--panel-accent);
}

.fleet__empty {
  margin: 10px 2px;
  color: var(--panel-muted);
  font-size: 12px;
}
</style>
