<!-- The TT&C console window: a full page that steers the satellite view in another window. -->
<template>
  <div class="console">
    <header class="console__header">
      <div class="console__brand">
        <UIcon name="lucide:satellite-dish" class="console__logo" />
        <div>
          <h1 class="console__title">卫星测运控中心</h1>
          <p class="console__subtitle">SATVIS TT&amp;C CONSOLE</p>
        </div>
      </div>
      <div class="console__link" :class="state.connected ? 'console__link--ok' : 'console__link--bad'">
        <span class="console__dot" />
        {{ state.connected ? "已连接卫星视图" : "未连接卫星视图" }}
      </div>
      <UButton v-if="!state.connected" size="xs" variant="soft" color="warning" icon="i-lucide-refresh-cw" @click="api.reconnect()">重连</UButton>
    </header>

    <p v-if="!state.connected" class="console__offline">
      还没有连上卫星视图。请打开承载 3D 地球的 satvis 主页面并保持它运行，测运控台会自动连接；也可以点击「重连」。
    </p>

    <div class="console__lock" :class="{ 'console__lock--active': state.lockedName !== '' }">
      <UIcon :name="state.lockedName !== '' ? 'lucide:lock' : 'lucide:lock-open'" class="console__lockIcon" />
      <div class="console__lockText">
        <span class="console__lockName">{{ state.lockedName || "未锁定卫星" }}</span>
        <span class="console__lockMeta">
          {{ state.lockedName ? `NORAD #${state.lockedSatnum || "—"} · 可下发姿态与动作指令` : "在「清单」中选择一颗卫星" }}
        </span>
      </div>
      <label class="console__switch" title="显示所有已激活卫星的 3D 模型">
        <input type="checkbox" :checked="state.modelsOn" @change="onModels" />
        3D
      </label>
      <label class="console__switch" title="锁定后让相机跟随卫星">
        <input type="checkbox" :checked="state.follow" @change="onFollow" />
        跟踪
      </label>
      <UButton v-if="state.lockedName" size="xs" variant="ghost" color="neutral" icon="i-lucide-x" @click="api.unlock()">解除</UButton>
    </div>

    <segmented-control v-model="tab" label="测运控功能" :options="tabs" />

    <main class="console__body">
      <ttc-satellite-list v-if="tab === 'fleet'" @locked="tab = 'attitude'" />
      <ttc-attitude-tab v-else-if="tab === 'attitude'" @open-fleet="tab = 'fleet'" />
      <ttc-link-tab v-else-if="tab === 'links'" />
      <ttc-message-log v-else />
    </main>

    <footer class="console__foot">
      测运控台是独立窗口，与卫星视图通过 BroadcastChannel 联动；关闭它不会停止卫星视图。<br />
      外部 HTTP 控制（仅 <code>pnpm dev</code>）：<code>GET/POST /ttc-api/command</code> · <code>GET /ttc-api/state</code>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";

import { useTtcConsole, type TtcConsoleTab } from "@/modules/ttc/console";

import SegmentedControl from "../SegmentedControl.vue";
import TtcAttitudeTab from "./TtcAttitudeTab.vue";
import TtcLinkTab from "./TtcLinkTab.vue";
import TtcMessageLog from "./TtcMessageLog.vue";
import TtcSatelliteList from "./TtcSatelliteList.vue";

const api = useTtcConsole();
const state = api.state;
const tab = ref<TtcConsoleTab>("fleet");

const tabs: { value: TtcConsoleTab; label: string }[] = [
  { value: "fleet", label: "清单" },
  { value: "attitude", label: "姿态" },
  { value: "links", label: "链路" },
  { value: "log", label: "日志" },
];

function onModels(event: Event): void {
  const on = (event.target as HTMLInputElement).checked;
  state.modelsOn = on;
  api.setGlobal3D(on);
}

function onFollow(event: Event): void {
  const on = (event.target as HTMLInputElement).checked;
  state.follow = on;
  api.setFollow(on);
}
</script>

<style scoped>
.console {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(100%, 780px);
  min-height: 100dvh;
  margin: 0 auto;
  padding: 18px 16px 26px;
  color: var(--panel-ink);
  font-size: 13px;
}

.console__header {
  display: flex;
  align-items: center;
  gap: 10px;
}

.console__brand {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
}

.console__logo {
  flex: none;
  font-size: 30px;
  color: var(--panel-accent);
}

.console__title {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.console__subtitle {
  margin: 1px 0 0;
  color: var(--panel-muted);
  font-size: 9px;
  letter-spacing: 0.16em;
}

.console__link {
  display: flex;
  align-items: center;
  gap: 5px;
  flex: none;
  color: var(--panel-muted);
  font-size: 10px;
}

.console__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}

.console__link--ok {
  color: #4ade80;
}

.console__link--bad {
  color: #fb7185;
}

.console__offline {
  margin: 0;
  padding: 8px 10px;
  background: color-mix(in srgb, #fbbf24 12%, transparent);
  border: 1px solid color-mix(in srgb, #fbbf24 35%, transparent);
  border-radius: 8px;
  color: #fcd34d;
  font-size: 11px;
  line-height: 1.5;
}

.console__lock {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 10px 12px;
  background: var(--panel-raised);
  border: 1px solid var(--panel-hairline);
  border-radius: 10px;
}

.console__lock--active {
  border-color: color-mix(in srgb, var(--panel-accent) 55%, transparent);
}

.console__lockIcon {
  flex: none;
  font-size: 22px;
  color: var(--panel-muted);
}

.console__lock--active .console__lockIcon {
  color: var(--panel-accent);
}

.console__lockText {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}

.console__lockName {
  overflow: hidden;
  font-size: 14px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.console__lockMeta {
  overflow: hidden;
  color: var(--panel-muted);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.console__switch {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
  color: var(--panel-muted);
  font-size: 11px;
  cursor: pointer;
  user-select: none;
}

.console__body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
}

.console__foot {
  color: var(--panel-muted);
  font-size: 9.5px;
  line-height: 1.6;
  text-align: center;
}

.console__foot code {
  padding: 0 3px;
  background: var(--panel-raised);
  border-radius: 3px;
  font-size: 9px;
}

@media (max-width: 520px) {
  .console {
    padding: 12px 10px 20px;
  }

  .console__title {
    font-size: 15px;
  }

  .console__link {
    font-size: 9px;
  }
}
</style>
