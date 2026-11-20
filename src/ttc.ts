// The TT&C console window's entry: no Cesium, no satellite data, no Pinia. It mirrors the
// satellite view over a BroadcastChannel, so both can be placed side by side.

import ui from "@nuxt/ui/vue-plugin";
import { createApp, defineComponent } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";

import "@/css/main.css";
import "@/css/ttc-page.css";

import { ttcConsoleKey } from "@/modules/ttc/console";
import { createTtcConsoleApi } from "@/modules/ttc/TtcConsoleClient";

import TtcApp from "./TtcApp.vue";

// Nuxt UI's buttons resolve through a router link when no `to` is given either; without
// a router installed they warn on every render. No route is ever shown.
const router = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: "/:pathMatch(.*)*", component: defineComponent({ render: () => null }) }],
});

const app = createApp(TtcApp);
app.provide(ttcConsoleKey, createTtcConsoleApi());
app.use(ui);
app.use(router);
app.mount("#app");
