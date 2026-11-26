# Epiphy KubeJS 组件与魔改脚本集 (`epiphy-kubejs-components`)

[中文 (默认)](README.md) · [English](README_EN.md) · [原生 Mod 迁移计划书](docs/native-mod-migration-plan.md) · [渲染子系统路线图](docs/rendering-subsystem-roadmap.md) · [LLM 工程规范](README-LLM.md) · [许可证 (RAL 1.6)](LICENSE.md)

一套运行在 **Minecraft 1.20.1 (Forge 47.x + KubeJS 2001.6.x)** 上的通用视听表现引擎与服务端基础设施库。  
你可以用它以声明式脚本绘制**屏幕弹幕、动态 HUD 进度面板、世界 3D 全息告示牌、武器 3D 环绕特效、3D 空间音乐声场**，并获得**抗回滚权限管理、低开销方块追踪、大范围流体/地形批处理**与**原版重进世界血量截断修复**等开箱即用的底层能力。

> [!IMPORTANT]
> **版本演进、兼容性与平台声明（Phase 4 原生 Mod 迁移前最终封版）**
> 1. **无共存期、纯脚本版直接 EOL**：本项目正迁往 **Kotlin + Java** 独立原生模组（详见 [`docs/native-mod-migration-plan.md`](docs/native-mod-migration-plan.md)）。**原生 Mod 正式发布后，不会设立共存期，现有的纯 KubeJS 脚本版也不会提供 Maintenance LTS（长期维护），将直接进入 EOL 并停止官方维护。**
> 2. **单向升级、请自行备份数据**：官方**不保证从新版原生 Mod 降级回旧 KubeJS 脚本版时数据仍完整可读**，升级前请务必自行备份存档与 `epiphy-data/`。
> 3. **KubeJS 调用支持与兼容边界**：
>    - **官方推荐的脚本用法**：Mod 化后，**通过 KubeJS 调用原生 Mod 直接暴露的 Epiphy 组件接口完全可行——如果你需要以脚本形式编排功能，依然推荐这种模式，并且会得到长期广泛支持**；
>    - **旧脚本兼容预期**：原有的 KubeJS 脚本仍能通过同样的调用方式拿到**行为类似**的功能（由于底层接口已升级且未来会持续迭代，旧脚本直接调用可能出现 Bug 属预期行为）；虽会尽可能保证向前兼容，但 Mod 化属于大更新，**不兼容的旧功能不会特意修复**。
> 4. **仅支持 Forge**：当前版本与未来的独立原生 Mod 均基于 **Forge**（`Kotlin for Forge`），**暂时不会推出 Fabric 版**。

### 运行环境与可选联动依赖

- **必需基础环境**：`Minecraft 1.20.1` · `Forge 47.x` · `KubeJS 2001.6.x`
- **通用组件中的可选第三方 Mod**（未安装时均会自动安静降级，绝不报错或崩溃）：

| 可选第三方 Mod | 作用模块 | 装了有什么用 / 没装会怎样 | 原生 Mod 阶段（Phase 4）去向 |
| :--- | :--- | :--- | :--- |
| **CodeChickenLib** | `Epiphy的-物品三维渲染器.js` | 为自定义 3D 武器/物品提供渲染挂载与 Java 网格加速（~0.54ms）；**没装时仅提示 1 次并退回原版普通平面物品贴图**（世界 3D 特效完全不依赖 CCL） | **彻底移除依赖**，由原生 Mod 自主实现 |
| **ModernUI** | `Epiphy的-平面渲染器.js` | 启用高清文字排版缓存与单次 SDF 描边加速；**没装时自动用原版文字渲染** | 保留为可选软兼容加速分支 |
| **Curios API** | `Epiphy的-服务端核心.js` | 支持在饰品栏中检索特定物品（`findPlayerCurio`）；**没装时跳过饰品栏** | 保留为可选软兼容桥接 |

- **附属玩法 / 配方脚本依赖**（仅对应玩法脚本需要，不装完全不影响上面 15 个通用组件运行）：`Twilight Forest`（终极拆解台失稳殉爆与活木根配方）、`Draconic Evolution` + `BrandonsCore` + `CodeChickenLib`（殉爆波前演出与隐藏物品混沌晶体）、`Enigmatic Legacy`（遗物豁免与七咒配方）、`Botania`（活木根配方）。

---

## 核心能力一览（它能做什么？）

### 1. 📺 2D 平面合成器、屏幕弹幕与世界全息牌
> 服务端：`Epiphy2DSurface / ScreenDanmaku v6.3.0` · 客户端：`Epiphy2DRenderer / ScreenDanmakuClient v6.3.0`

- **四大投射载体 (`surface`)**：
  - `screen`：屏幕弹幕与自定义 HUD 面板（默认置于原版血条/物品栏之下、普通弹幕之上，层级可自由调节）；
  - `gui`：在指定容器界面打开时，动态替换底层背景贴图（关界面自动还原）或插入背景/前景装饰层；
  - `slot`：自动匹配容器内的指定槽位或物品，在槽位上绘制动态角标、冷却遮罩或高亮框；
  - `world_plane`：悬浮在三维世界中的 2D 全息告示牌或地面法阵（支持存档持久化、按视距自动同步、朝向跟随与隔墙透视）。
- **声明式图元与流畅动画**：内置矩形（纯色/线框/三色渐变/多层程序化视差/着色器）、贴图、九宫格、物品图标、富文本（打字机/逐字震动/发光描边）与容器组；客户端自带平滑过渡（`lerp`）、残影追赶（`trail`）与受击微震（`impulse`）插值轨道，服务端只需发送极小体积的 `action: 'patch'` 变量更新包即可驱动 60fps 丝滑动画。

### 2. ✨ 3D 物品特效与世界空间特效
> 物品端：`EpiphyItem3DRenderer v1.1.0` · 世界服务端：`Epiphy3DFXServer v1.2.0` · 世界客户端：`Epiphy3DFX v2.3.0`

- **物品三维特效 (`EpiphyItem3DRenderer`)**：通过链式 `fx()` 构造器为物品声明自定义 GLSL 核心着色器覆层（如深空星海视差窗）、旋转星盘陀螺环（`ribbon_ring`）、双螺旋光带（`ribbon_helix`）与环绕星屑粒子簇（`sprite_cluster`），在第一/三人称手持与背包槽位中均有真实前后深度遮挡。
- **世界空间特效 (`surface: 'world'`)**：100% 零第三方 Mod 依赖。支持在世界坐标或追踪实体（`followEntityUuid`）上生成圆环（`ring`）、光柱（`beam`）、螺旋（`helix`）与经纬球壳（`sphere`），同样支持 `channel`/`slot` 增量更新与自定义形状渲染扩展。

### 3. 🔊 3D 空间音频与温和 BGM 避让
> 服务端：`EpiphyAudio v5.8.0` · 客户端：`EpiphyAudioClient v5.6.0`

- **多源 3D 声场**：支持将音效绑定到固定坐标、特定方块（`bindBlock`）、移动实体或整个维度，客户端实时同步 OpenAL 3D 声源方位与平滑距离衰减。
- **智能簇合并与保流**：多个相邻同源音乐方块会自动合并为一个并集声场（敲掉方块时无缝重算）；走远或静音时自动 `pause` 挂起，走近后接着原进度继续播放。
- **不误杀他模组的 BGM 避让 (`duckMusic`)**：开启背景音乐避让时，仅温和暂停原版 `minecraft:` 命名空间的背景音乐，播放结束后自动恢复，**绝不误停其他 Mod 的自定义 BGM**。

### 4. 🛡️ 服务端安全底座、方块引擎与独立 Bug 修复
> 核心：`EpiphyServerCore / EpiphyServerBase v2.6.0` · 权限：`EpiphyPermissionValve v5.4.0` · 方块：`EpiphyBlockTracker / EpiphyWorldOps v2.5.1` · 修复：`EpiphyBugfix v1.0.0`

- **双轨数据存储 (`epiphy-data/`)**：将“需要跟存档一起回滚的方块/全息牌状态”（保存在 `saves/<world>/`）与“绝不能被回滚覆盖的权限审计与运行日志”（保存在游戏根目录 `epiphy-data/`）严格分离；复制存档时自动识别路径变化并分叉新目录，损坏文件自动从 `.bak` 自愈并加锁保护。
- **抗回滚三态权限阀**：支持将 `/epiphy` 下的单个子功能（如个人弹幕 `danmaku.self`、点歌 `audio.play`）精细授权给非 OP 玩家，并对非 OP 玩家实施严格的配额、冷却与命名空间隔离（无法清掉系统或他人的弹幕/音乐）；撤销权限会写入外部墓碑文件，回档也无法复活已撤销的权限。
- **渐进式区块扫描与地形批处理**：分帧扫描绑定方块（不卡主线程），并提供带三级预算门控的球体/柱体流体剥离与地形清理接口（支持保护基岩、容器与指定岩浆环）。
- **重进世界高血量截断修复 (`EpiphyBugfix`)**：零硬依赖独立模块，解决原版读档时先于饰品/属性加成调用 `setHealth()` 导致超过 20 点生命值上限的玩家重进世界后血量被强行扣回 20 的顽疾。

---

## 工程架构与 15 个通用组件速查

### 1. 四层加载与通信拓扑

```text
┌──────────────────────────────────────────────────────────────────────────────────┐
│ Layer 1 · Startup 启动期（跨端契约、3D 物品管线与内容注册，最先加载）              │
├──────────────────────────────────────────────────────────────────────────────────┤
│  Epiphy的-Spec与通用工具.js (P:1200) ──► EpiphySpec / EpiphyProtocol / 2D&3D桥接  │
│  Epiphy的-物品三维渲染器.js (P:1050) ──► EpiphyItem3DRenderer (可选: CCL 降级)   │
│  创造模式栏-epiphy.js       (P:1000) ──► global.EpiphyCreativeTab (epiphy:stuff)  │
│     └──► 隐藏物品收录 / 终极拆解台_不稳定 (5阶段方块) / 功能测试方块与3D长剑案例  │
└────────────────────────────┬─────────────────────────────┬───────────────────────┘
                             │ (可选兜底)                   │ (硬依赖)
                             ▼                             ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│ Layer 2 · Server 基础底座（按 Priority 1100 ──► 900 顺序装配）                   │
├──────────────────────────────────────────────────────────────────────────────────┤
│  P:1100  Epiphy的-日志.js           ──► EpiphyLog            (限频/去重/外部日志) │
│  P:1080  Epiphy的-服务端核心.js     ──► EpiphyServerCore/Base (存储/实体/命令DSL) │
│  P:1050  Epiphy的-方块与区块组件.js ──► EpiphyBlockTracker/WorldOps (扫描/改地形)│
│  P:1000  Epiphy的-权限阀.js         ──► EpiphyPermissionValve (三态权限/墓碑锁)  │
│  P:950   Epiphy的-调试组件.js       ──► EpiphyDebug          (健康自检/性能采样)  │
│  P:900   Epiphy的-基础bug修复.js    ──► EpiphyBugfix         (重进世界HP恢复)     │
└────────────────────────────┬─────────────────────────────────────────────────────┘
                             │ global.* API & 预设注册表
                             ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│ Layer 3 · Server 业务调度与玩法脚本层                                            │
├──────────────────────────────────────────────────────────────────────────────────┤
│  Epiphy的-平面渲染组件.js (P:500)  │ Epiphy的-空间特效组件.js (P:500) │ 音频组件  │
│  拆解台-混沌殉爆.v18.js   (P:10)   │ 合成表-*/*.js            (P:0)   │ (P:500)   │
└───────────┬────────────────────────┴────┬─────────────────────────────┴────┬─────┘
            │ epiphy:screen_danmaku       │ epiphy:spatial_fx                │ epiphy:audio
            ▼ (S2C 网络包)                ▼ (S2C 网络包)                     ▼ (S2C 网络包)
┌──────────────────────────────────────────────────────────────────────────────────┐
│ Layer 4 · Client 客户端表现层（纯端侧渲染与播放，不参与服务端权威判定）           │
├──────────────────────────────────────────────────────────────────────────────────┤
│  Epiphy的-平面渲染器.js     ──► 2D 图元树 / 插值轨道 / GUI&槽位 / 世界全息平面   │
│  Epiphy的-空间特效渲染器.js ──► 世界 3D 特效渲染器 + 物品 3D 状态门面            │
│  Epiphy的-音频播放器.js     ──► OpenAL 3D 声场追踪 / 原版 BGM 避让 / 断流重连    │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### 2. 组件清单与版本速查表

| 架构层 | 脚本文件 | 阶段 (Priority) | 导出全局符号 & 当前版本 | 一句话职责说明 |
| :--- | :--- | :---: | :--- | :--- |
| **L1 契约** | `Epiphy的-Spec与通用工具.js` | `startup` (`1200`) | `EpiphySpec v2.8.1`<br>`EpiphyProtocol` / `EpiphyMath` | 跨端协议常量、参数解析、LRU/FIFO 缓存池、预设注册表、Rhino `Math` 常量修补及 2D/3D 渲染事件桥接 |
| **L1 物品3D** | `Epiphy的-物品三维渲染器.js` | `startup` (`1050`) | `EpiphyItem3DRenderer v1.1.0` | 声明式通用物品 3D 渲染管线（`fx()` 构造器、自定义核心着色器、预烘焙星环/螺旋/星屑网格，无 CCL 自动退回原版模型） |
| **L1 物品栏** | `创造模式栏-epiphy.js` | `startup` (`1000`) | `EpiphyCreativeTab v1.0.0` | 统一维护 `epiphy:stuff` 创造模式物品栏与跨脚本动态追加队列 |
| **L2 日志** | `Epiphy的-日志.js` | `server` (`1100`) | `EpiphyLog v1.2.0` | 统一限频、去重警告、`catchWarn` 与按世界自动路由的 `epiphy-data/` 按天文本日志 |
| **L2 核心** | `Epiphy的-服务端核心.js` | `server` (`1080`) | `EpiphyServerCore / EpiphyServerBase v2.6.0` | 世界/实体安全访问器、Curios 检索、`openJsonStore`（`.bak` 自愈与防损坏覆写）、存档分叉检测与 Brigadier 命令 DSL |
| **L2 世界** | `Epiphy的-方块与区块组件.js` | `server` (`1050`) | `EpiphyBlockTracker / EpiphyWorldOps v2.5.1` | 渐进式区块段方块追踪、持久化派发、以及带三级开销门控的流体剥离与地形批处理引擎 |
| **L2 权限** | `Epiphy的-权限阀.js` | `server` (`1000`) | `EpiphyPermissionValve v5.4.0` | `/epiphy` 根命令、三态分层权限域、命令方块防篡改锁、外置撤销墓碑与二次口令确认的按名授权备用模式 |
| **L2 诊断** | `Epiphy的-调试组件.js` | `server` (`950`) | `EpiphyDebug v1.1.0` | `/epiphy debug` 多模块运行指标聚合、健康自检与客户端 `renderperf` 帧耗时采样开关 |
| **L2 修复** | `Epiphy的-基础bug修复.js` | `server` (`900`) | `EpiphyBugfix v1.0.0` | 零硬依赖纯服务端模块：修复高血量上限玩家重进世界时生命值被原版强行截断回 20 的 Bug |
| **L3 2D调度** | `Epiphy的-平面渲染组件.js` | `server` (`500`) | `Epiphy2DSurface / ScreenDanmaku v6.3.0` | 2D 图元树、`ui()` DSL、`channel`/`slot` 增量同步、世界全息平面持久化与屏幕弹幕服务端调度 |
| **L3 3D调度** | `Epiphy的-空间特效组件.js` | `server` (`500`) | `Epiphy3DFXServer v1.2.0` | 世界 3D 空间特效（`surface: 'world'`）服务端协议调度、配额控制、`channel`/`slot` 与可扩展约束链 |
| **L3 音频** | `Epiphy的-音频组件.js` | `server` (`500`) | `EpiphyAudio v5.8.0` | 3D 空间声场服务端调度、相邻同源方块球簇合并、实体追踪与非 OP 玩家配额隔离 |
| **L4 2D渲染** | `Epiphy的-平面渲染器.js` | `client` | `Epiphy2DRenderer / ScreenDanmakuClient v6.3.0` | 客户端 2D 图元树预编译与合批渲染、轨道插值、GUI 贴图替换与槽位叠加、世界平面 3D 投影与 ModernUI 快路径 |
| **L4 3D渲染** | `Epiphy的-空间特效渲染器.js` | `client` | `Epiphy3DFX v2.3.0` | 客户端世界 3D 特效渲染（100% 零 CCL，内置环/柱/螺旋/球壳与实体插值追踪）及物品 3D 状态查询门面 |
| **L4 播放器** | `Epiphy的-音频播放器.js` | `client` | `EpiphyAudioClient v5.6.0` | 客户端 OpenAL 3D 声源坐标实时同步、静音暂停保流、温和原版音乐避让与断流退避重连 |

<details>
<summary><b>📋 点击展开：各模块详细依赖关系与缺失降级规范 (YAML)</b></summary>

```yaml
# ==================== Layer 1 · Startup ====================
Epiphy的-Spec与通用工具.js:
  requires: { hard: [], optional: [] }
  on_missing:
    - EpiphyServerBase 与客户端引擎各自启用精简内置兜底
    - 服务端弹幕组件、空间特效组件与音频组件因缺少硬前置拒绝启动

Epiphy的-物品三维渲染器.js:
  requires: { hard: [], optional: [CodeChickenLib, EpiphySpec] }
  on_missing:
    no_CodeChickenLib: 客户端仅输出 1 条降级警告并跳过自定义着色器与 IItemRenderer 烘焙，绑定物品自动退回原版静态模型正常显示（无紫黑块、无报错）
    no_EpiphySpec:     启用内置单调钳制时钟与本地预设表兜底

创造模式栏-epiphy.js:
  requires: { hard: [], optional: [] }
  on_missing: 附属物品无法自动归入统一的 epiphy:stuff 创造模式栏

Epiphy的小玩意-原版_其他Mod的隐藏物品.js:
  requires: { hard: [创造模式栏-epiphy.js] }

Epiphy的小玩意-终极拆解台_不稳定.js:
  requires: { hard: [kubejs/assets/epiphy/ 资源] }

Epiphy的小玩意_功能测试.js:
  requires: { hard: [创造模式栏-epiphy.js], optional: [ScreenDanmaku, EpiphyAudio] }
  on_missing: 缺弹幕或音频时测试方块仍正常注册，交互仅无对应声画触发

# ==================== Layer 2 · Server Foundation ====================
Epiphy的-日志.js:
  requires: { hard: [], optional: [] }
  on_missing: 下游模块回退至原生 console，失去统一限频、once 去重与 debug 开关

Epiphy的-服务端核心.js:
  requires: { hard: [], optional: [EpiphySpec, EpiphyLog] }
  on_missing:
    no_EpiphySpec: 维度归一化与数组判断启用内置精简降级实现
    no_EpiphyLog:  日志包装自动降级为内置限频 console 输出

Epiphy的-方块与区块组件.js:
  requires: { hard: [EpiphyServerCore], optional: [EpiphyLog] }
  on_missing: 下游弹幕/音频的 bindBlock 退化为仅响应放置与破坏的基础监听（无区块扫描、持久化与地形批处理）

Epiphy的-权限阀.js:
  requires: { hard: [EpiphyServerBase], optional: [EpiphyLog] }
  on_missing: 下游 /epiphy 子命令不挂载（OP 登录提示），但业务组件 JS API 仍可调用

Epiphy的-调试组件.js:
  requires: { hard: [EpiphyServerBase], optional: [EpiphyLog, EpiphyPermissionValve] }
  on_missing: 缺权限阀时不注册 /epiphy debug 指令，指标快照仍可通过 global.EpiphyDebug 读取

Epiphy的-基础bug修复.js:
  requires: { hard: [], optional: [EpiphyLog] } # 设计定位为零硬依赖可独立放入运行
  on_missing: 缺日志组件时平滑回退内置限频 console

# ==================== Layer 3 · Server Scheduling & Gameplay ====================
Epiphy的-平面渲染组件.js:
  requires:
    hard:     [EpiphySpec, EpiphyProtocol, EpiphyServerBase]
    paired:   [Epiphy的-平面渲染器.js]
    optional: [EpiphyLog, EpiphyBlockTracker, EpiphyPermissionValve]
  on_missing:
    no_client: 服务端 API 可正常调用，客户端无接收与画面渲染
    optional:  各可选组件均按单层明确降级，不阻断核心调度

Epiphy的-空间特效组件.js:
  requires:
    hard:     [EpiphySpec, EpiphyProtocol, EpiphyServerBase]
    paired:   [Epiphy的-空间特效渲染器.js]
    optional: [EpiphyLog]
  on_missing:
    no_client: 服务端调度与约束校验正常工作，客户端无世界 3D 渲染输出

Epiphy的-音频组件.js:
  requires:
    hard:     [EpiphySpec, EpiphyProtocol, EpiphyServerBase]
    paired:   [Epiphy的-音频播放器.js]
    optional: [EpiphyLog, EpiphyBlockTracker, EpiphyPermissionValve]
  on_missing:
    no_client: 服务端句柄可正常调度，客户端无声音输出
    optional:  各可选组件均按单层明确降级，不阻断常规播放 API
  note:     L3 业务调度组件（含 Epiphy2DSurface/ScreenDanmaku、EpiphyAudio），仅通过全局公开 API 调用，禁止直接复用内部实现

拆解台-混沌殉爆.v18.js:
  requires:
    hard:     [Epiphy的小玩意-终极拆解台_不稳定.js, EpiphyServerCore, EpiphyWorldOps, ScreenDanmaku]
    optional: [EpiphyAudio, kubejs/assets/epiphy/ 语言与资源]
  on_missing: 任一硬前置缺失时立即抛出异常 Fail-Fast 拒载（玩法层不保留冗余兜底）

# ==================== Layer 4 · Client ====================
Epiphy的-平面渲染器.js:
  requires: { paired: [Epiphy2DSurface, ScreenDanmaku], optional: [EpiphySpec, EpiphyProtocol] }
  on_missing: 缺 Startup Spec 时启用内置 v6 协议常量与基础工具兜底

Epiphy的-空间特效渲染器.js:
  requires: { paired: [Epiphy3DFXServer], optional: [EpiphyItem3DRenderer, EpiphySpec, EpiphyProtocol] }
  on_missing: 缺 Startup Spec/物品三维渲染器时使用同源默认配置与内置 v1 协议常量兜底，不中断世界 3D 包收发与生命周期管理

Epiphy的-音频播放器.js:
  requires: { paired: [EpiphyAudio], optional: [EpiphySpec, EpiphyProtocol] }
  on_missing: 缺 Startup Spec 时启用内置 v5 协议常量与基础工具兜底
```

</details>

---

## 快速上手：安装、指令与本地验证

### 1. 安装到整合包
1. 确认游戏环境为 **Minecraft 1.20.1 + Forge 47.x + KubeJS 2001.6.x**。
2. 将本仓库的 `kubejs/` 目录合并到客户端 `.minecraft/` 与服务端根目录下。
3. 启动游戏后，系统会在游戏根目录自动生成 `epiphy-data/` 外部数据文件夹（存放权限配置与按天运行日志，切勿提交至公开版本库）。
4. **关于测试方块音乐的说明**：出于版权与体积原因，公开仓库不包含 `children_of_the_city.ogg`（详见 [`docs/audio-assets.md`](docs/audio-assets.md)）。不放该文件完全不影响测试方块的弹幕和其余功能；如需测试 BGM，可自行放入同名 `.ogg` 或改绑其他音效 ID。

### 2. 游戏内常用管理指令（需 OP 或对应授权）

| 指令 | 用途说明 |
| :--- | :--- |
| `/epiphy help` | 查看当前已挂载的所有子模块命令概览 |
| `/epiphy auth list` / `scopes` / `where` | 查看已授权玩家、细粒度权限域列表以及 `epiphy-data/` 实际落盘路径 |
| `/epiphy debug status` / `check` | 查看各模块活跃句柄数、缓存命中率并运行一键健康自检 |
| `/epiphy debug renderperf on\|dump\|off` | 开启客户端渲染分阶段耗时统计，并将结果导出至 `epiphy-data/logs/client_render_perf.json` |
| `/epiphy danmaku self <文本>` | 发送个人屏幕弹幕（可单独授权 `danmaku.self` 给普通玩家娱乐使用） |
| `/epiphy audio list` / `info` | 查看当前世界中正在运行的空间声场句柄与听众状态 |

### 3. 开发者本地单测与静态校验

修改脚本后，无需启动 Minecraft 即可在本地 Node.js 环境中完成全量逻辑回归与 Rhino 语法排雷：

```bash
npm install               # 首次克隆后安装零依赖的 acorn 解析器
npm test                  # 运行 7 大沙盒测试套件 + PROTO v6 Schema 校验 + Rhino 语法/AST 禁区检查
npm run sync-docs:check   # 校验 15 个组件头部与 4 份文档的三段式版本号是否严格一致
```

- **真实 Rhino 编译核验**：若本机装有 JDK 与 `rhino-forge-*.jar`，可通过环境变量 `RHINO_JAR`、`MC_MODS_DIR` 或本地 `.rhino-local.json` 让 `scripts/rhino-check.js` 调用真实 Rhino `Context.compileString`；未配置时自动使用 `local-acorn-ast` 拦截 `Math.PI`、`??`、`let/const` 等 Rhino 专属陷阱。

---

## 目录结构导览

```text
.
├── kubejs/
│   ├── assets/epiphy/            # 音效 (.ogg)、核心着色器 (shaders/core/)、方块/物品模型、贴图与语言文件
│   ├── client_scripts/           # 通用组件/ (平面渲染器、空间特效渲染器、音频播放器) 与物品 Tooltip 描述
│   ├── server_scripts/           # 通用组件/ (日志、服务端核心、方块与区块、权限阀、调试、Bug修复、2D/3D/音频调度) 与玩法/配方
│   └── startup_scripts/          # 通用组件/ (Spec与事件桥接、物品三维渲染器、创造模式栏) 及 小玩意与案例/、拆解台-混沌殉爆/
├── docs/
│   ├── native-mod-migration-plan.md              # Phase 4 独立原生模组 (Kotlin + Java) 迁移工程计划书
│   ├── rendering-subsystem-roadmap.md            # 2D 平面合成器与 3D 空间特效架构规范与演进路线图
│   ├── proto_v6_schema.json                      # 2D 平面渲染 PROTO v6 唯一权威 JSON Schema 契约
│   ├── kube-mods-rhino-es5-es6-compatibility.md  # kube-mods/rhino 字节码与运行时兼容性实测手册
│   └── audio-assets.md                           # 音频资源分发边界与本地自备说明
├── scripts/
│   ├── rhino-check.js            # 真实 Rhino / acorn AST 语法与语义偏移门禁脚本
│   └── sync-doc-versions.js      # 组件头部与 4 份文档版本号自动同步工具 (npm run sync-docs)
├── tests/
│   ├── run.js                    # 统一测试运行器（支持按套件名或 --filter 筛选）
│   ├── helpers/harness.js        # KubeJS VM 沙盒与模拟环境底座
│   └── suites/*.test.js          # 按模块领域划分的 7 个回归测试套件
├── README.md                     # 中文说明文档（默认）
├── README_EN.md                  # 英文说明文档
├── README-LLM.md                 # AI 协作者工程准则与跨上下文交接备忘
└── LICENSE.md                    # RAL 1.6 相互开源署名许可证完整法律文本
```

---

## 作者与许可证 (Authors & License)

### 作者与分工
- **Epiphy-iLLUMs**：项目发起人、玩法设计、核心维护者；负责核心功能设计与实现、工程结构制定、模块化构思、纠错与重构方向。
- **Gemini 4 系列**：架构协助、组件开发与问题排查。
- **Claude 5.5 系列**：架构协助、组件开发、纠错与优化建议。
- **DeepSeek**：吉祥物（Mascot）。

### 许可证 (`RAL-1.6`)

本仓库源码与文档适用 **RAL 1.6（Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6）**，完整条款以根目录 [`LICENSE.md`](LICENSE.md) 中文正式文本为准：
- **源代码可用与署名**：允许修改、扩展与分叉（Fork），再发布时须保留原作者及贡献者合理署名；
- **相互开源义务**：对本项目本体形成修改、衍生或静态/动态链接依赖的模组作品须履行同等开源义务；
- **商业与转售边界**：允许作为非主要交付物集成于商业环境，但**严禁将本作品本身作为独立商品直接收费转售**；
- **冲突协议禁令**：禁止引入不可调和冲突协议（如禁止竞争性分叉的 PolyForm Shield 1.0.0；满足 `r2` 第 2.12/11.8 条源码隔离的纯粹兼容性代码特例除外）。

> [!TIP]
> **整合包与脚本作者定心丸：下游 KubeJS `.js` 脚本无需声明许可证**  
> 由于 KubeJS 的 `.js` 脚本在整合包分发时原本就需要将明文源码直接下载到玩家的电脑上（天然满足源码可见），因此**你基于 KubeJS 并调用 Epiphy 组件编写的下游 `.js` 脚本无需声明许可证**。
