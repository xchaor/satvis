# 卫星测运控中心（TT&C）研发日志

- **日期**：2026-11-20
- **范围**：satvis 单页应用（Vue 3 + Vite + CesiumJS）新增的卫星测运控中心、独立控制台窗口、HTTP 控制接口、模型姿态与链路模拟
- **提交**：`8072f5c9`（GP 探测修复）、`6c2e3c88`（测运控功能），已推送 `origin/main`
- **验证**：`pnpm type-check` 通过；`TZ=UTC pnpm test` 86 个测试文件、1247 个用例全部通过

---

## 1. 概览

本次在 satvis 主页面（3D 地球）之外新增了一个**独立的测运控控制台窗口**，用于模拟实际卫星测运控操作：

1. 卫星清单与锁定
2. 卫星 3D 模型更换（数据来自 `data/models`）
3. 姿态/动作同步：锁定卫星后旋转 3D 模型、展开/收拢太阳翼，地球上的卫星实时同步；Sensor cone 随姿态倾斜
4. 星地上下行信息模拟（指令、遥测、数据帧，含链路可见性与时延）
5. 星间通信模拟（距离、时延、地球遮挡）
6. 模型高亮：半透明包围盒、颜色、常亮/闪烁、有效时长
7. 供外部系统调用的 HTTP GET/POST 控制接口

控制台**不遮挡地球**：它是独立窗口（`ttc.html`），通过浏览器 `BroadcastChannel` 与主页面实时联动。

---

## 2. 架构

```
┌─────────────────────────────┐        BroadcastChannel         ┌──────────────────────────┐
│ 主页面（index.html）         │  <───────────────────────────>  │ 测运控窗口（ttc.html）     │
│ Vue + CesiumJS 3D 地球       │        satvis-ttc-console       │ Vue，无 Cesium            │
│                              │                                 │                          │
│ TtcManager（场景/链路/指令） │                                 │ TtcConsoleClient（镜像）   │
│ TtcHostBridge（状态/执行）   │                                 │ 控制台 4 个页签            │
│ 卫星目录 / Pinia 状态        │                                 │                          │
└──────────────┬───────────────┘                                 └──────────────────────────┘
               │ HTTP（JSON，400ms 轮询）
               ▼
┌─────────────────────────────┐
│ Vite 开发服务器              │
│ /ttc-api/*（中间件）         │
│ 指令队列（上限 200）         │
└──────────────▲───────────────┘
               │ HTTP GET/POST（外部系统）
               │
        ┌──────┴──────┐
        │  curl / 平台 │
        └─────────────┘
```

- **主页面是唯一的"真相源"**：卫星目录、锁定状态、姿态、链路、消息都由主页面持有并渲染。
- **控制台窗口只镜像状态、发送操作**，不加载 Cesium，也不拉取卫星数据。
- **HTTP 接口**把外部指令放入 Vite 开发服务器的队列，主页面轮询取走并执行。

### 跨窗口协议（BroadcastChannel）

- 频道名：`satvis-ttc-console`（同源窗口自动互通，与是否由 `window.open` 打开无关）
- 消息为结构化克隆的纯数据（不能直接传 Vue 响应式代理）
- 主页面每 1s 心跳推送状态；状态变化时 100ms 防抖推送；消息按 id 增量发送
- 控制台 4s 收不到消息显示"未连接"；每 2s 发送 `hello` 自动重连；主页面重载后自动恢复
- 卫星清单搜索也走该通道：控制台发 `search`，主页面检索目录后回传结果

---

## 3. 新增功能

### 3.1 独立测运控窗口

- 主页面左侧菜单新增 **「测运控」**（图标 `radio-tower`），点击后打开独立窗口 `ttc.html`（560×960，可自由移动/缩放）
- 重复点击复用同一窗口；被浏览器拦截时弹出 Toast 提示
- 移除了原先内嵌在主页面的测运控面板，因此不会再遮挡地球
- 窗口内包含：连接状态、当前锁定卫星、3D/跟踪开关、清单/姿态/链路/日志四个页签

### 3.2 卫星清单与锁定

- 显示主页面当前已激活的卫星；未激活时列出已加载目录
- 支持按名称或 NORAD 编号搜索（首次搜索会加载全部目录分组，可能耗时数秒）
- 每行显示轨道类型色点、NORAD、是否已激活、是否有 3D 模型
- 点击一行即**锁定**：激活该卫星、开启它的 3D 模型、默认让相机跟随，并自动切换到「姿态」页签

### 3.3 姿态与动作

- **姿态控制**（相对速度坐标系）：
  - 滚转：绕速度轴 X，±180°
  - 俯仰：绕横轴 Y，±90°
  - 偏航：绕天顶轴 Z，±180°
  - 自旋：绕天顶轴 Z，0–60°/s，可启停
  - 复位姿态：三轴与自旋归零
- **太阳翼动作**：展开角 0–90°（0° 展开、90° 收拢），动画速率 70°/s，带进度条
- 姿态偏移通过 `OffsetOrientationProperty` 合成到模型的 `VelocityOrientationProperty` 上，**轨迹重采样和场景重建后依然保持**
- 姿态只作用于锁定卫星；解锁时清除姿态（太阳翼角度作为"物理状态"保留）

### 3.4 卫星模型更换

- 「姿态」页签底部模型下拉框：
  - 默认模型（卫星清单自带的模型）
  - **TT&C 演示卫星**（浏览器运行时生成，带可动太阳翼节点）
  - `data/models` 下的全部主模型（优先读取 `data/ttc/models.json`，缺失时使用内置文件清单）
- 运行时替换锁定卫星的模型实体，并自动处理 LOD（覆盖模型不再使用低模副本）
- **注意**：官方 satvis 模型在构建时把节点变换烘焙进顶点，太阳翼无法单独折叠；演示模型通过 glTF 节点 + `ModelGraphics.nodeTransformations` 实现真实展开/收拢动画，其他模型的太阳翼指令仍会记录日志

### 3.5 星地上下行模拟

- 地面站来自 Locations 面板；没有时可一键添加「北京」
- 实时显示：仰角、距离、单向时延（光速单程 + 120ms 处理）、链路可见性
- 指令按钮（遥测查询 / 姿态查询 / 指令展开 / 指令收拢）：
  - 卫星在地平线以下时拒发并记录告警
  - 上行帧发出后，按时延返回 ACK 和遥测下行
- 可选「过境期间自动遥测下行（每 5 秒）」
- 3D 地球上绘制星地链路折线（可见绿色、不可见橙色），随姿态与时间实时更新
- 遥测内容为模拟值：电池、温度、三轴姿态、太阳翼角度

### 3.6 星间链路模拟

- 与另一颗已激活卫星建立链路，最多 6 条，避免重复
- 实时计算距离、单向时延、**地球遮挡**（WGS84 椭球与两天线连线求交）
- 3D 地球上绘制星间链路（可见青色、遮挡橙色）
- 「发送测试数据」会在日志中产生上行包与按时延返回的 ACK

### 3.7 模型高亮（半透明包围盒）

- 在锁定卫星的 3D 模型外罩一个**半透明立方体包围盒**：
  - 填充透明度 0.25，边框透明度 0.95，随模型尺寸自动伸缩（边长 ≈ 2.05 × 模型包围球半径）
  - **总体视角下保持最小屏幕尺寸（32 像素）**，缩放地球时可见但不喧宾夺主；靠近时贴合模型实际尺寸
  - 随模型姿态一起旋转（复用模型的速度坐标系 + TT&C 姿态）
  - 包围盒不可用作选中目标：点击它仍会选中卫星本体
- 颜色：红、橙、黄、绿、青、蓝、紫、白
- 效果：**常亮** 或 **闪烁**（300ms 亮 / 300ms 灭）
- 有效时长：1–3600 秒，默认 30 秒；按**墙钟时间**计时，仿真暂停也照常闪烁和到期；到期自动消失
- 入口：
  - 控制台「姿态」页签 →「模型高亮」区域（色块、常亮/闪烁、时长、应用/清除、剩余秒数）
  - HTTP `highlight` / `highlight-clear` 动作
- 状态镜像：`highlightColor`、`highlightEffect`、`highlightUntil`（epoch 毫秒）会出现在控制台状态和 `GET /ttc-api/state` 中

### 3.8 HTTP 控制接口（仅开发服务器）

- 由 Vite 开发服务器的中间件提供，**仅 `pnpm dev` 有效**，构建产物没有后端
- 端点：
  - `GET /ttc-api` 接口自述
  - `GET /ttc-api/state` 主页面最后上报的状态（主页面未轮询前返回 503）
  - `GET /ttc-api/command?action=...` 查询参数下发
  - `POST /ttc-api/command` JSON 下发（返回 `202`）
- 主页面每 400ms `POST /ttc-api/poll`：上报状态、取走指令队列（上限 200 条，页面关闭时指令排队等待）
- 指令有白名单校验；CORS 开放；无鉴权；Vite 默认只监听 localhost
- **可选的 `name` 参数**：除 `lock`/`unlock`/`highlight-clear` 外，所有动作都可带 `name`；带 `name` 时先隐式锁定该卫星（激活、开启 3D 模型），**但不改变相机视角与跟踪状态**，只施加动作效果，因此**未锁定时也能直接执行**。不带 `name` 时作用于当前锁定卫星。需要相机跟随时使用显式 `lock` 或控制台清单。`command`/`uplink` 带新锁定的卫星时最多等待约 6 秒等卫星数据就绪后执行。
- 支持的 `action`：

| action | 参数 | 效果 |
|---|---|---|
| `attitude` | `roll` ±180、`pitch` ±90、`yaw` ±180 | 设置锁定卫星姿态 |
| `reset-attitude` | — | 姿态与自旋归零 |
| `spin` | `rate` ±120 | 绕天顶轴自旋，0 停止 |
| `panels` | `angle` 0–90 | 太阳翼目标角 |
| `lock` | `name` | 按名称锁定卫星 |
| `unlock` | — | 解除锁定 |
| `command` | `kind`：`telemetry` / `attitude` / `panels-deploy` / `panels-stow` | 模拟地面指令（带链路校验） |
| `uplink` | `text` ≤1000 | 上行数据帧；过境时生效，自动返回 `DATA-ACK` 下行 |
| `downlink` | `text` ≤1000 | 注入一条下行数据帧 |
| `model` | `file`：`.glb` 路径或 `demo` | 切换锁定卫星模型 |
| `highlight` | `color`（红/橙/黄/绿/青/蓝/紫/白）、`effect`（`steady`/`blink`）、`duration`（1–3600 秒，默认 30） | 模型外罩半透明彩色包围盒，到时自动消失 |
| `highlight-clear` | — | 立即移除包围盒 |
| `interlink` | `fromName`、`toName`（两颗不同的目录卫星）、`duration`（1–3600 秒，默认 30） | from 绿闪、to 红闪、黄色流光连线；不锁定、不动相机 |
| `interlink-clear` | — | 立即移除星间通信演示 |

- 状态快照包含：锁定卫星/NORAD、姿态、自旋、太阳翼角、高亮颜色/效果/到期时间、星间通信演示的 from/to/到期时间、星地链路统计、星间链路与统计、地面站、最近 20 条消息
- **指令是异步的**：返回 202 只代表入队；执行结果（含链路拒绝等告警）通过 `GET /ttc-api/state` 的 `messages` 查看

### 3.9 星间通信流光演示（HTTP）

- 独立于控制台的星间链路列表，用于对外演示两颗卫星之间的通信：
  - `fromName` 卫星外罩**绿色闪烁**包围盒
  - `toName` 卫星外罩**红色闪烁**包围盒
  - 两星之间一条黄色连线，叠加一段**黄色流光**（短亮段从 from 匀速流向 to，循环）
- 参数：`fromName`、`toName`（必须是不同的目录卫星名）、`duration`（1–3600 秒，默认 30，墙钟计时）
- 不锁定卫星、不移动相机；必要时自动激活这两颗卫星使其位置可用
- 到期自动消失；可用 `interlink-clear` 立即清除；状态字段 `interlinkFrom`/`interlinkTo`/`interlinkUntil` 出现在 `GET /ttc-api/state`

### 3.10 Sensor cone 姿态同步

- 之前 Sensor cone 固定指向星下点，与卫星姿态无关
- 现在锥体朝向 = **速度坐标系 × TT&C 姿态偏移 × 对地安装旋转**，与 3D 模型共享同一套姿态基准：
  - 滚转/俯仰：锥体随星体摆离星下点，可见
  - 偏航/自旋：绕锥体自身轴线旋转；圆形锥体轮廓不变（物理上正确）
- 采样窗口边缘取不到速度时，回退到原固定对地朝向，避免 Cesium 回调抛错

---

## 4. 使用说明

### 4.1 启动

```bash
cd /d/vswork/lingkan/satvis

# 首次：子模块与依赖
git submodule update --init
pnpm install

# 启动（本机直连 satvis.space 超时，需要走本地代理）
HTTPS_PROXY=http://127.0.0.1:7897 \
HTTP_PROXY=http://127.0.0.1:7897 \
NO_PROXY=localhost,127.0.0.1 \
NODE_USE_ENV_PROXY=1 \
pnpm dev
```

- 浏览器打开 `http://localhost:5174/`（以终端显示端口为准）
- 启动探测现在最多等待 10s×2 次；通过慢代理可能要几秒到二十秒，期间卫星先出现、再加载模型
- 建议硬刷新（`Ctrl+Shift+R`）确保加载最新代码

### 4.2 测运控控制台

1. 允许浏览器弹出窗口
2. 左侧菜单点击 **「测运控」** → 打开独立窗口，显示「已连接卫星视图」
3. **清单**：搜索或点击已有卫星 → 锁定（相机跟随，自动进入「姿态」）
4. **姿态**：拖动滑杆或使用自旋/太阳翼按钮；地球上的模型与 Sensor cone 实时响应；在「模型高亮」区选颜色、常亮/闪烁和时长后点「应用高亮」
5. **链路**：
   - 添加/选择地面站，查看仰角、距离、时延
   - 发送遥测/姿态查询、指令展开/收拢；可开启自动遥测
   - 选择对端卫星建立星间链路，发送测试数据
6. **日志**：查看上下行、星间、告警消息（仿真 UTC），可清空
7. 顶部开关：
   - **3D**：为所有已激活卫星开启 3D 模型（与 Components 面板开关相同；上游限制：超过 200 颗带模型的卫星会自动关闭全局 3D）
   - **跟踪**：锁定后相机跟随
8. 关闭控制台窗口不会停止卫星视图；重新打开会自动重连

### 4.3 HTTP 接口示例

```bash
# 先锁定卫星（也可在控制台里锁定；或者省略，后续动作直接带 name）
curl -X POST http://localhost:5174/ttc-api/command \
  -H "Content-Type: application/json" \
  -d '{"action":"lock","name":"ISS (ZARYA)"}'

# 未锁定时也可直接带 name：先隐式锁定再执行
curl -X POST http://localhost:5174/ttc-api/command \
  -H "Content-Type: application/json" \
  -d '{"action":"attitude","name":"ISS (ZARYA)","roll":20,"pitch":-10,"yaw":45}'

# GET：姿态 滚转20°/俯仰-10°/偏航45°
curl "http://localhost:5174/ttc-api/command?action=attitude&roll=20&pitch=-10&yaw=45"

# POST：太阳翼收拢
curl -X POST http://localhost:5174/ttc-api/command \
  -H "Content-Type: application/json" -d '{"action":"panels","angle":90}'

# 上行数据（卫星需在地面站地平线以上）
curl -X POST http://localhost:5174/ttc-api/command \
  -H "Content-Type: application/json" -d '{"action":"uplink","text":"HELLO SAT"}'

# 注入下行数据
curl -X POST http://localhost:5174/ttc-api/command \
  -H "Content-Type: application/json" -d '{"action":"downlink","text":"TLM 电池 87.2%"}'

# 模型高亮：红色、闪烁、30 秒
curl "http://localhost:5174/ttc-api/command?action=highlight&color=red&effect=blink&duration=30"

# 模型高亮：绿色、常亮、2 分钟
curl -X POST http://localhost:5174/ttc-api/command \
  -H "Content-Type: application/json" \
  -d '{"action":"highlight","color":"green","effect":"steady","duration":120}'

# 立即清除高亮
curl -X POST http://localhost:5174/ttc-api/command \
  -H "Content-Type: application/json" -d '{"action":"highlight-clear"}'

# 星间通信演示：ISS 绿闪、CSS 红闪、黄色流光连线，60 秒
curl -X POST http://localhost:5174/ttc-api/command \
  -H "Content-Type: application/json" \
  -d '{"action":"interlink","fromName":"ISS (ZARYA)","toName":"CSS (TIANHE)","duration":60}'

# 查看状态、最近消息、高亮与星间通信演示状态
curl http://localhost:5174/ttc-api/state
```

完整参数与状态字段见 [ttc-http-api.md](ttc-http-api.md)。

### 4.4 模型与太阳翼

- 主页面默认只开 Point/Label，**3D 模型默认关闭**；可用控制台顶部「3D」或 Components 面板开启
- 锁定卫星时会单独为它启用 3D 模型，不受全局开关影响
- 太阳翼动画：先在模型下拉框选择 **「TT&C 演示卫星」**，再点展开/收拢或拖动展开角
- 官方模型可正常换模、随姿态旋转，但太阳翼指令只记录日志（节点已烘焙）
- 可选生成带卫星名称的完整模型清单（不生成也能用内置清单）：

```bash
node scripts/ttc/generate-assets.mjs
```

---

## 5. 修改文件清单

### 新增

| 文件 | 说明 |
|---|---|
| `ttc.html` / `src/ttc.ts` / `src/TtcApp.vue` | 独立控制台窗口入口（无 Cesium） |
| `src/css/ttc-page.css` | 控制台页面布局覆盖（可滚动文档） |
| `src/components/control/ControlCenterPanel.vue` | 控制台外壳：状态、页签、断线提示 |
| `src/components/control/TtcSatelliteList.vue` | 卫星清单与搜索 |
| `src/components/control/TtcAttitudeTab.vue` | 姿态、自旋、太阳翼、模型选择 |
| `src/components/control/TtcLinkTab.vue` | 星地/星间链路 |
| `src/components/control/TtcMessageLog.vue` | 消息日志 |
| `src/modules/ttc/console.ts` | 控制台 API 契约（状态/动作/注入 key） |
| `src/modules/ttc/protocol.ts` | BroadcastChannel 消息协议 |
| `src/modules/ttc/TtcHostBridge.ts` | 主页面端：状态发布、控制台/HTTP 指令执行 |
| `src/modules/ttc/TtcConsoleClient.ts` | 控制台端：状态镜像、发送操作与重连 |
| `src/modules/ttc/TtcManager.ts` | 场景端：姿态偏移、太阳翼动画、星地/星间链路、指令与遥测 |
| `src/modules/ttc/state.ts` | 姿态/太阳翼/模型覆盖的渲染循环注册表 |
| `src/modules/ttc/OffsetOrientationProperty.ts` | 在速度朝向上合成 TT&C 姿态 |
| `src/modules/ttc/linkGeometry.ts` | 仰角/距离/时延/地球遮挡计算 |
| `src/modules/ttc/highlight.ts` | 高亮颜色表、效果与时长约束（控制台/主页面/HTTP 共用） |
| `src/modules/ttc/demoModel.ts` | 浏览器运行时生成带太阳翼节点的演示卫星 glTF |
| `src/stores/controlCenter.ts` | Pinia 状态（锁定、姿态、消息、链路、模型覆盖） |
| `src/composables/useTtcModels.ts` | 模型清单加载与内置回退 |
| `vite-plugins/ttcHttp.ts` | Vite 开发服务器 `/ttc-api` 中间件 |
| `scripts/ttc/generate-assets.mjs` | 从 `data/models/models.yaml` 生成模型清单 |
| `docs/ttc-http-api.md` | HTTP 接口文档 |

### 修改

| 文件 | 说明 |
|---|---|
| `src/app.ts` | 启动 `startTtc(cc)` 与 `startTtcHost(cc)` |
| `src/components/Satvis.vue` | 菜单「测运控」改为打开独立窗口；移除内嵌面板 |
| `src/modules/componentKinds.ts` | 模型姿态绑定、模型覆盖、太阳翼节点变换、Sensor cone 姿态 |
| `src/modules/satelliteGraphics.ts` | `coneBodyOrientation`：锥体随姿态倾斜 |
| `src/modules/util/gpSource.ts` | 探测超时 3s→10s，失败重试一次（修复目录为空） |
| `vite.config.ts` | 注册 `ttcHttpApi()`、增加 `ttc.html` 多页入口 |

---

## 6. 修复的问题

| 问题 | 原因 | 处理 |
|---|---|---|
| 卫星与 3D 模型完全不加载 | 启动探测 `/api/groups.json` 超时仅 3s，经本地代理约需 4s；超时后回退到不存在的静态快照，目录为空 | 探测超时改为 10s 并重试 1 次 |
| 测运控面板打开后代理大量 ECONNRESET、渲染告警刷屏 | 面板挂载时自动加载整个 Active 分组（上万颗卫星）；列表 `lockedName` 未定义 | 移除自动全量加载；补上 `lockedName` |
| 独立控制台按钮每渲染都告警 `route location` | 控制台入口没有 vue-router，Nuxt UI 的 Link 注入失败 | 控制台入口安装内存路由 |
| 类型检查失败 | `JulianDate` 从 `@cesium/engine` 以 type-only 导入被识别为值 | 改为从 `@cesium/core` 值导入 |
| 单元测试失败（SatelliteCatalog） | 新增的分组请求重试改变了"下次 ensure 才重试"的上游语义 | 恢复分组请求原行为，仅保留探测重试 |

---

## 7. 验证结果

- `pnpm type-check`：通过
- `TZ=UTC pnpm test`：86 个测试文件、1247 个用例全部通过
- 说明：非 UTC 时区下 `SampledTrajectory` 有 4 个既有失败（测试用本地时区构造固定日期），与本次改动无关，UTC/CI 环境通过
- 开发服务器日志确认 HTTP 接口可用，例如：

```
[ttc-api] #1 {"action":"lock","name":"CYGFM08"}
[ttc-api] #2 {"action":"attitude","roll":20,"pitch":-10,"yaw":45}
[ttc-api] #3 {"action":"attitude","roll":120,"pitch":-10,"yaw":45}
```

---

## 8. 已知限制与后续计划

**限制**

- HTTP 接口只在 `pnpm dev` 下存在；生产构建是静态站点，没有后端可承载
- HTTP 接口无鉴权，仅建议本机/可信网络使用
- 官方模型节点已烘焙，太阳翼动画只对演示模型生效
- 姿态是纯视觉模拟，不影响轨道；解锁会清除姿态
- 高亮包围盒按墙钟时间计时，仅标记当前锁定卫星；解锁后包围盒移除，若在有效期内重新锁定另一颗卫星则会显示在新卫星上
- 模型覆盖、链路、消息、高亮仅存于内存，刷新页面后重置
- 全局 3D 模型受上游 200 颗预算限制；锁定的单颗卫星不受影响
- 星地上行要求已配置地面站且卫星在地平线以上；时间为仿真 UTC

**后续**

- 生产环境的 HTTP 网关（独立 Node 服务）+ Token 鉴权、限流
- 用 WebSocket 推送替代 400ms 轮询，降低延迟
- 将控制台状态（模型覆盖、链路、地面站）持久化到 localStorage/URL
- 增加更多卫星动作（天线指向、载荷开关）与自定义带节点模型
- 多星同时控制与指令序列编排
- 为 `coneBodyOrientation` 增加姿态数学单元测试
