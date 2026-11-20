<!-- The simulated traffic the satellite view reports: uplink, downlink, inter-satellite, warnings. -->
<template>
  <div class="log">
    <div class="log__bar">
      <span>{{ state.messages.length }} 条消息 · 仿真 UTC</span>
      <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-trash-2" :disabled="state.messages.length === 0" @click="api.clearMessages()">清空</UButton>
    </div>
    <div ref="scroller" class="log__rows">
      <p v-if="state.messages.length === 0" class="log__empty">暂无消息。锁定卫星后在「链路」页发送指令，或在「姿态」页操作卫星。</p>
      <div v-for="message in state.messages" :key="message.id" class="log__row" :class="`log__row--${message.direction}`">
        <div class="log__head">
          <span class="log__time">{{ message.at }}</span>
          <span class="log__channel">{{ message.channel === "ground" ? "星地" : "星间" }}</span>
          <span class="log__dir">{{ directionLabel(message.direction) }}</span>
          <span class="log__route">{{ message.from }} → {{ message.to }}</span>
        </div>
        <div class="log__text">{{ message.text }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from "vue";

import { useTtcConsole } from "@/modules/ttc/console";
import type { TtcDirection } from "@/stores/controlCenter";

const api = useTtcConsole();
const state = api.state;
const scroller = ref<HTMLElement>();

const LABELS: Record<TtcDirection, string> = {
  uplink: "上行 ↑",
  downlink: "下行 ↓",
  warn: "告警",
  sys: "系统",
};

function directionLabel(direction: TtcDirection): string {
  return LABELS[direction];
}

async function scrollToEnd(): Promise<void> {
  await nextTick();
  if (scroller.value) {
    scroller.value.scrollTop = scroller.value.scrollHeight;
  }
}

watch(() => state.messages.length, scrollToEnd, { flush: "post" });
onMounted(scrollToEnd);
</script>

<style scoped>
.log {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 0;
}

.log__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  color: var(--panel-muted);
  font-size: 10px;
}

.log__rows {
  display: flex;
  flex-direction: column;
  gap: 4px;
  height: min(60dvh, 620px);
  overflow-y: auto;
  padding: 3px;
  border: 1px solid var(--panel-hairline);
  border-radius: 8px;
  background: var(--panel-surface-dense);
  user-select: text;
}

.log__empty {
  margin: 16px 10px;
  color: var(--panel-muted);
  font-size: 11px;
  line-height: 1.5;
}

.log__row {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 5px 7px;
  border-left: 2px solid var(--panel-hairline);
  border-radius: 4px;
  background: var(--panel-raised);
}

.log__row--uplink {
  border-left-color: #4ade80;
}

.log__row--downlink {
  border-left-color: #22d3ee;
}

.log__row--warn {
  border-left-color: #fbbf24;
}

.log__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 5px;
  font-size: 9px;
}

.log__time {
  color: var(--panel-muted);
  font-variant-numeric: tabular-nums;
}

.log__channel {
  padding: 0 4px;
  background: var(--panel-hairline);
  border-radius: 3px;
  color: var(--panel-muted);
}

.log__dir {
  color: var(--panel-ink);
  font-weight: 600;
}

.log__row--uplink .log__dir {
  color: #4ade80;
}

.log__row--downlink .log__dir {
  color: #22d3ee;
}

.log__row--warn .log__dir {
  color: #fbbf24;
}

.log__route {
  overflow: hidden;
  color: var(--panel-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.log__text {
  font-size: 10.5px;
  line-height: 1.45;
  word-break: break-word;
}
</style>
