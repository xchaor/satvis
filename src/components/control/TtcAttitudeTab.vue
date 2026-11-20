<!-- Attitude on three axes, the solar-panel action, and the model picker; all through the console API. -->
<template>
  <div v-if="state.lockedName === ''" class="attitude attitude--empty">
    <UIcon name="lucide:lock-keyhole" class="attitude__emptyIcon" />
    <p>先在「清单」中锁定一颗卫星，再对它进行姿态与动作控制。</p>
    <UButton size="xs" variant="soft" color="neutral" icon="i-lucide-list" @click="emit('open-fleet')">打开卫星清单</UButton>
  </div>

  <div v-else class="attitude">
    <section class="attitude__section">
      <h3 class="attitude__title">姿态控制 <span>相对速度坐标系</span></h3>
      <label class="attitude__axis">
        <span class="attitude__axisName">滚转 <em>绕速度轴 X</em></span>
        <input type="range" min="-180" max="180" step="1" :value="state.roll" @input="setAxis('roll', $event)" />
        <b>{{ state.roll }}°</b>
      </label>
      <label class="attitude__axis">
        <span class="attitude__axisName">俯仰 <em>绕横轴 Y</em></span>
        <input type="range" min="-90" max="90" step="1" :value="state.pitch" @input="setAxis('pitch', $event)" />
        <b>{{ state.pitch }}°</b>
      </label>
      <label class="attitude__axis">
        <span class="attitude__axisName">偏航 <em>绕天顶轴 Z</em></span>
        <input type="range" min="-180" max="180" step="1" :value="state.yaw" @input="setAxis('yaw', $event)" />
        <b>{{ state.yaw }}°</b>
      </label>
      <div class="attitude__buttons">
        <UButton size="xs" variant="soft" color="neutral" icon="i-lucide-rotate-ccw" @click="resetAttitude">复位姿态</UButton>
        <UButton size="xs" :variant="spinning ? 'solid' : 'soft'" :color="spinning ? 'primary' : 'neutral'" icon="i-lucide-refresh-cw" @click="toggleSpin">
          {{ spinning ? "停止自旋" : "自旋" }}
        </UButton>
      </div>
      <label class="attitude__axis">
        <span class="attitude__axisName">自旋角速度</span>
        <input type="range" min="0" max="60" step="1" :value="Math.abs(state.spinRate)" @input="setSpin($event)" />
        <b>{{ Math.abs(state.spinRate) }}°/s</b>
      </label>
    </section>

    <section class="attitude__section">
      <h3 class="attitude__title">卫星动作 <span>太阳翼</span></h3>
      <label class="attitude__axis">
        <span class="attitude__axisName">展开角</span>
        <input type="range" min="0" max="90" step="1" :value="state.panelTarget" @input="setPanel($event)" />
        <b>{{ Math.round(state.panelAngle) }}°</b>
      </label>
      <div class="attitude__buttons">
        <UButton size="xs" variant="soft" color="neutral" icon="i-lucide-unfold-horizontal" @click="setPanels(0)">展开太阳翼</UButton>
        <UButton size="xs" variant="soft" color="neutral" icon="i-lucide-fold-horizontal" @click="setPanels(90)">收拢太阳翼</UButton>
      </div>
      <div class="attitude__meter" role="progressbar" :aria-valuenow="Math.round(state.panelAngle)" aria-valuemin="0" aria-valuemax="90">
        <span :style="{ width: `${(state.panelAngle / 90) * 100}%` }" />
      </div>
      <p class="attitude__note">
        0° 展开 · 90° 收拢。官方 satvis 模型在构建时烘焙了节点变换，太阳翼动画仅对下方「TT&amp;C 演示卫星」等带节点的模型生效；其他模型的指令仍会记录。
      </p>
    </section>

    <section class="attitude__section">
      <h3 class="attitude__title">卫星模型 <span>data/models</span></h3>
      <select class="attitude__select" aria-label="卫星模型" :value="selectedModel" @change="onModelChange">
        <option v-for="option in modelOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
      </select>
      <p v-if="!state.hasModel" class="attitude__warn">该卫星当前没有 3D 模型，选择一个模型后即可在轨道上看到它。</p>
      <p v-else class="attitude__note">当前：{{ state.modelLabel || "卫星清单自带的模型" }}</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";

import { ttcModelUrl, useTtcModels } from "@/composables/useTtcModels";
import { useTtcConsole } from "@/modules/ttc/console";
import { TTC_DEMO_LABEL } from "@/modules/ttc/demoModel";

const emit = defineEmits<{ "open-fleet": [] }>();

const api = useTtcConsole();
const state = api.state;
const { entries } = useTtcModels();

/** A select value, not a model URL: the satellite view resolves the demo's blob URL itself. */
const DEMO_VALUE = "__demo__";

const spinning = computed(() => state.spinRate !== 0);

const modelOptions = computed(() => [
  { value: "", label: "默认模型（卫星清单自带的模型）" },
  { value: DEMO_VALUE, label: TTC_DEMO_LABEL },
  ...entries.value
    .map((entry) => ({ value: ttcModelUrl(entry.file), label: `${entry.label} · ${entry.file}` }))
    .sort((a, b) => a.label.localeCompare(b.label)),
]);

const selectedModel = computed(() => {
  if (state.modelUrl === "") {
    return "";
  }
  return state.modelDemo ? DEMO_VALUE : state.modelUrl;
});

/** The slider follows the drag locally; the satellite view's echo confirms it a tick later. */
function setAxis(axis: "roll" | "pitch" | "yaw", event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  if (axis === "roll") {
    state.roll = value;
    api.setAttitude({ roll: value });
  } else if (axis === "pitch") {
    state.pitch = value;
    api.setAttitude({ pitch: value });
  } else {
    state.yaw = value;
    api.setAttitude({ yaw: value });
  }
}

function setSpin(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  state.spinRate = value;
  api.setSpin(value);
}

function setPanel(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  state.panelTarget = value;
  api.setPanelTarget(value);
}

function toggleSpin(): void {
  const rate = spinning.value ? 0 : 10;
  state.spinRate = rate;
  api.setSpin(rate);
}

function resetAttitude(): void {
  state.roll = 0;
  state.pitch = 0;
  state.yaw = 0;
  state.spinRate = 0;
  api.resetAttitude();
}

function setPanels(degrees: number): void {
  state.panelTarget = degrees;
  api.setPanelTarget(degrees);
}

function onModelChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  if (value === "") {
    api.setModel({ kind: "default" });
    return;
  }
  if (value === DEMO_VALUE) {
    api.setModel({ kind: "demo" });
    return;
  }
  const entry = entries.value.find((candidate) => ttcModelUrl(candidate.file) === value);
  api.setModel({ kind: "file", url: value, label: entry?.label ?? value });
}
</script>

<style scoped>
.attitude {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.attitude--empty {
  align-items: center;
  gap: 8px;
  padding: 30px 12px;
  color: var(--panel-muted);
  text-align: center;
}

.attitude__emptyIcon {
  font-size: 28px;
}

.attitude__section {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 10px 12px;
  background: var(--panel-raised);
  border: 1px solid var(--panel-hairline);
  border-radius: 9px;
}

.attitude__title {
  margin: 0 0 2px;
  font-size: 12.5px;
  font-weight: 600;
}

.attitude__title span {
  margin-left: 6px;
  color: var(--panel-muted);
  font-size: 10px;
  font-weight: 400;
}

.attitude__axis {
  display: grid;
  grid-template-columns: 100px 1fr 56px;
  align-items: center;
  gap: 10px;
}

.attitude__axisName {
  color: var(--panel-ink);
  font-size: 11.5px;
}

.attitude__axisName em {
  display: block;
  color: var(--panel-muted);
  font-size: 9px;
  font-style: normal;
}

.attitude__axis b {
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.attitude__axis input[type="range"] {
  width: 100%;
  accent-color: var(--panel-accent);
}

.attitude__buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.attitude__meter {
  height: 5px;
  overflow: hidden;
  background: var(--panel-hairline);
  border-radius: 3px;
}

.attitude__meter span {
  display: block;
  height: 100%;
  background: var(--panel-accent);
  transition: width 0.12s linear;
}

.attitude__select {
  width: 100%;
  padding: 6px 7px;
  background: var(--panel-surface-dense);
  border: 1px solid var(--panel-hairline);
  border-radius: 6px;
  color: var(--panel-ink);
  font-size: 11px;
}

.attitude__note {
  margin: 0;
  color: var(--panel-muted);
  font-size: 10px;
  line-height: 1.5;
}

.attitude__warn {
  margin: 0;
  color: #fbbf24;
  font-size: 10px;
  line-height: 1.5;
}
</style>
