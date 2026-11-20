<!-- Ground link geometry and simulated uplink/downlink, then inter-satellite links; all through the console API. -->
<template>
  <div class="link">
    <section class="link__section">
      <h3 class="link__title">星地链路 <span>上下行模拟</span></h3>

      <div v-if="state.stations.length === 0" class="link__row">
        <span class="link__muted">卫星视图还没有地面站。</span>
        <UButton size="xs" variant="soft" color="neutral" icon="i-lucide-map-pin-plus" @click="addBeijing">添加北京地面站</UButton>
      </div>
      <label v-else class="link__row">
        <span class="link__label">地面站</span>
        <select class="link__select" :value="state.stationIndex" aria-label="地面站" @change="selectStation">
          <option v-for="(station, index) in state.stations" :key="index" :value="index">{{ station.name ?? `站点 ${index + 1}` }}</option>
        </select>
      </label>

      <div class="link__stats">
        <div class="link__stat">
          <span>仰角</span>
          <b>{{ degrees(state.groundStats.elevationDeg) }}</b>
        </div>
        <div class="link__stat">
          <span>距离</span>
          <b>{{ kilometers(state.groundStats.distanceKm) }}</b>
        </div>
        <div class="link__stat">
          <span>单向时延</span>
          <b>{{ milliseconds(state.groundStats.latencyMs) }}</b>
        </div>
        <div class="link__stat">
          <span>链路</span>
          <b :class="state.groundStats.visible ? 'link__ok' : 'link__bad'">{{ state.groundStats.visible ? "可通信" : "不可见" }}</b>
        </div>
      </div>

      <div class="link__buttons">
        <UButton size="xs" variant="soft" color="neutral" :disabled="state.lockedName === ''" icon="i-lucide-activity" @click="api.sendCommand('telemetry')">遥测查询</UButton>
        <UButton size="xs" variant="soft" color="neutral" :disabled="state.lockedName === ''" icon="i-lucide-compass" @click="api.sendCommand('attitude')">姿态查询</UButton>
        <UButton size="xs" variant="soft" color="neutral" :disabled="state.lockedName === ''" icon="i-lucide-unfold-horizontal" @click="api.sendCommand('panels-deploy')">指令展开</UButton>
        <UButton size="xs" variant="soft" color="neutral" :disabled="state.lockedName === ''" icon="i-lucide-fold-horizontal" @click="api.sendCommand('panels-stow')">指令收拢</UButton>
      </div>

      <label class="link__check">
        <input type="checkbox" :checked="state.autoTelemetry" @change="toggleAutoTelemetry($event)" />
        过境期间自动遥测下行（每 5 秒）
      </label>
      <p class="link__note">上行在卫星低于地平线时会被拒绝；时延 = 光速单程 + 120 ms 处理。时间为仿真 UTC。</p>
    </section>

    <section class="link__section">
      <h3 class="link__title">星间链路 <span>卫星之间的通信</span></h3>
      <div v-if="state.lockedName === ''" class="link__muted">锁定一颗卫星后，可与另一颗已激活的卫星建立星间链路。</div>
      <template v-else>
        <div class="link__row">
          <select v-model="partner" class="link__select" aria-label="星间链路对端卫星">
            <option value="">选择对端卫星…</option>
            <option v-for="name in partnerOptions" :key="name" :value="name">{{ name }}</option>
          </select>
          <UButton size="xs" variant="soft" color="neutral" :disabled="partner === ''" icon="i-lucide-link" @click="addLink">建立链路</UButton>
        </div>
        <p v-if="partnerOptions.length === 0" class="link__muted">卫星视图中没有其他已激活的卫星；先在主页面激活一颗，或锁定后等它出现在列表里。</p>

        <div v-for="link in state.interSatelliteLinks" :key="link.id" class="link__isl">
          <div class="link__islHead">
            <UIcon name="lucide:radio" class="link__islIcon" />
            <span class="link__islName">{{ link.a }} ↔ {{ link.b }}</span>
            <span :class="state.islStats[link.id]?.visible ? 'link__ok' : 'link__bad'">{{ state.islStats[link.id]?.visible ? "可见" : "遮挡" }}</span>
          </div>
          <div class="link__islMeta">
            <span>{{ kilometers(state.islStats[link.id]?.distanceKm) }}</span>
            <span>{{ milliseconds(state.islStats[link.id]?.latencyMs) }}</span>
          </div>
          <div class="link__islButtons">
            <UButton size="xs" variant="soft" color="neutral" icon="i-lucide-send" @click="api.sendPacket(link.id)">发送测试数据</UButton>
            <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-trash-2" @click="api.removeLink(link.id)">移除</UButton>
          </div>
        </div>
        <p v-if="state.interSatelliteLinks.length === 0" class="link__muted">最多同时建立 6 条星间链路。</p>
        <p v-else class="link__note">遮挡判定：两天线连线与 WGS84 地球椭球相交即视为不可见。</p>
      </template>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";

import { useTtcConsole } from "@/modules/ttc/console";

const api = useTtcConsole();
const state = api.state;
const partner = ref("");

const partnerOptions = computed(() => state.activeNames.filter((name) => name !== state.lockedName));

function selectStation(event: Event): void {
  const index = Number((event.target as HTMLSelectElement).value);
  state.stationIndex = index;
  api.setStation(index);
}

function addBeijing(): void {
  api.addStation({ lat: 39.9042, lon: 116.4074, name: "北京" });
}

function toggleAutoTelemetry(event: Event): void {
  const on = (event.target as HTMLInputElement).checked;
  state.autoTelemetry = on;
  api.setAutoTelemetry(on);
}

function addLink(): void {
  api.addLink(state.lockedName, partner.value);
  partner.value = "";
}

function degrees(value?: number): string {
  return value === undefined ? "—" : `${value.toFixed(1)}°`;
}

function kilometers(value?: number): string {
  return value === undefined ? "—" : `${value.toFixed(0)} km`;
}

function milliseconds(value?: number): string {
  return value === undefined ? "—" : `${Math.round(value)} ms`;
}
</script>

<style scoped>
.link {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.link__section {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 10px 12px;
  background: var(--panel-raised);
  border: 1px solid var(--panel-hairline);
  border-radius: 9px;
}

.link__title {
  margin: 0;
  font-size: 12.5px;
  font-weight: 600;
}

.link__title span {
  margin-left: 6px;
  color: var(--panel-muted);
  font-size: 10px;
  font-weight: 400;
}

.link__row {
  display: flex;
  align-items: center;
  gap: 7px;
}

.link__label {
  flex: none;
  color: var(--panel-muted);
  font-size: 11px;
}

.link__select {
  flex: 1;
  min-width: 0;
  padding: 6px 7px;
  background: var(--panel-surface-dense);
  border: 1px solid var(--panel-hairline);
  border-radius: 6px;
  color: var(--panel-ink);
  font-size: 11px;
}

.link__stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 5px;
}

.link__stat {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 6px 7px;
  background: var(--panel-surface-dense);
  border-radius: 6px;
}

.link__stat span {
  color: var(--panel-muted);
  font-size: 9px;
}

.link__stat b {
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}

.link__ok {
  color: #4ade80;
}

.link__bad {
  color: #fb7185;
}

.link__buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.link__check {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--panel-muted);
  font-size: 11px;
  cursor: pointer;
}

.link__note,
.link__warn,
.link__muted {
  margin: 0;
  color: var(--panel-muted);
  font-size: 10px;
  line-height: 1.5;
}

.link__isl {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 7px 8px;
  background: var(--panel-surface-dense);
  border: 1px solid var(--panel-hairline);
  border-radius: 7px;
}

.link__islHead {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
}

.link__islIcon {
  flex: none;
  color: var(--panel-accent);
}

.link__islName {
  overflow: hidden;
  flex: 1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.link__islMeta {
  display: flex;
  gap: 10px;
  color: var(--panel-muted);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

.link__islButtons {
  display: flex;
  gap: 5px;
}
</style>
