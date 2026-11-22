# Epiphy KubeJS Components & Scripts (`epiphy-kubejs-components`)

[中文 (默认)](README.md) · [English](README_EN.md) · [LLM Engineering Guide](README-LLM.md) · [License (RAL 1.6)](LICENSE.md)

A collection of shared server/client infrastructure modules, audiovisual presentation engines (screen danmaku + 3D spatial audio), gameplay bugfixes, and modpack customization scripts built for **Minecraft 1.20.1 / Forge 47.x / KubeJS 2001.6.x**.

> **Status, Roadmap & Platform Notes**
> - **Early Testing Notice (⚠️ Unstable)**: This project is currently in an **early testing stage**. APIs, data schemas, command syntax, and module boundaries are not yet frozen — **current behavior may be unstable and major breaking changes can occur frequently**. Not recommended for production worlds requiring strict long-term stability yet.
> - **Migration Direction**: Once stabilized and feature-complete, this project will transition to **Kotlin + Java** native mod development, with most features becoming standalone modules; **KubeJS is a transitional dependency prior to that migration**.
> - **Loader Compatibility**: Currently tested on **Forge 47.x**. Apart from a small number of Forge-specific compatibility hooks, the core design is **theoretically compatible with Fabric as well**, though **untested on Fabric**.

### Runtime Requirements & Third-Party Mod Dependencies

- **Base Requirements (Required)**: `Minecraft 1.20.1` · `Forge 47.x` · `KubeJS 2001.6.x` (transitional)
- **Optional Third-Party Mod Exceptions in Common Components** (Policy: any third-party mod dependency is treated strictly as an exception with clean Fail-Soft fallback when absent):

| Third-Party Mod | Level | Affected Common Component | Role & Fallback Behavior | Native Mod (Phase 4) Plan |
| :--- | :---: | :--- | :--- | :--- |
| **CodeChickenLib** | Optional Exception | `Epiphy的-物品三维渲染器.js` | Entry-point hook & pure-Java mesh submission fast path for custom 3D item rendering (`IItemRenderer` / `TransformUtils` / `CCShaderInstance` / `CCModel` / `CCRenderState` / `ColourAttribute` / `Matrix4` / `Vector3` / `Vertex5`, working around KubeJS lacking `Item.initializeClient` and Rhino per-vertex overhead); falls back cleanly to vanilla static item models with a single warning when absent (**World 3D `surface: 'world'` event bridge lives in `Epiphy的-Spec与通用工具.js`, physically 0% CCL dependency**) | **Remove completely & self-implement** (native `IClientItemExtensions` + `BEWLR` / own Mixin + vanilla `ShaderInstance` + native Java VBO/mesh) |
| **ModernUI** | Optional Fast Path | `Epiphy的-平面渲染器.js` | Enables direct text layout cache and single-pass SDF outline when installed; transparently falls back to vanilla pipeline when absent | Keep as optional compatibility branch |
| **Curios API** | Optional Utility | `Epiphy的-服务端核心.js` | Powers Curios slot lookups (`findPlayerCurio`); safely skipped when absent | Keep as optional soft compatibility |

- **Gameplay / Modpack-Specific Script Dependencies** (required only by the corresponding gameplay/recipe scripts; common components run standalone without them): `Twilight Forest` (Unstable Uncrafting Table meltdown chain & liveroot recipe), `Draconic Evolution` + `BrandonsCore` + `CodeChickenLib` (Chaos Implosion wave & hidden Chaos Crystal item), `Enigmatic Legacy` (supreme relic exemption & cursed ring recipe), `Botania` (liveroot recipe).

---

## Engineering Architecture & Module Dependencies

### 1. Vertical Layer Topology (Text Box Diagram)

```text
┌──────────────────────────────────────────────────────────────────────────────────┐
│ Layer 1 · Startup Stage (Cross-Side Contracts & Asset/Content Registrations)     │
├──────────────────────────────────────────────────────────────────────────────────┤
│  Epiphy的-Spec与通用工具.js (P:1200) ──► EpiphySpec / Protocol / 2D&3D Hooks     │
│  Epiphy的-物品三维渲染器.js (P:1050) ──► EpiphyItem3DRenderer (opt: CCL fallback)│
│  创造模式栏-epiphy.js       (P:1000) ──► global.EpiphyCreativeTab (epiphy:stuff)  │
│     ├──► Epiphy的小玩意-原版_其他Mod的隐藏物品.js                                 │
│     ├──► Epiphy的小玩意-终极拆解台_不稳定.js  (paired with assets/epiphy/)        │
│     └──► Epiphy的小玩意_功能测试.js           (integrates Danmaku/Audio & 3D item)│
└────────────────────────────┬─────────────────────────────┬───────────────────────┘
                             │ (optional fallback)          │ (hard dep)
                             ▼                             ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│ Layer 2 · Server Foundation Layer (Load Order: Priority 1100 ──► 900)            │
├──────────────────────────────────────────────────────────────────────────────────┤
│  P:1100  Epiphy的-日志.js         ──► EpiphyLog           (standalone log hub)    │
│  P:1080  Epiphy的-服务端核心.js   ──► EpiphyServerCore/Base (opt: Spec / Log)     │
│  P:1050  Epiphy的-方块与区块组件.js ──► EpiphyBlockTracker/WorldOps (opt: Log)    │
│  P:1000  Epiphy的-权限阀.js       ──► EpiphyPermissionValve (hard: ServerBase)    │
│  P:950   Epiphy的-调试组件.js     ──► EpiphyDebug         (hard:Base; opt:Log/Val)│
│  P:900   Epiphy的-基础bug修复.js  ──► EpiphyBugfix        (zero hard deps; opt:Log)│
└────────────────────────────┬─────────────────────────────────────────────────────┘
                             │ global.* APIs & deferred registration queues
                             ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│ Layer 3 · Server Scheduling & Gameplay Layer                                     │
├──────────────────────────────────────────────────────────────────────────────────┤
│  Epiphy的-平面渲染组件.js (P:500) ◄══ Hard    : Spec + ServerBase                 │
│                                   ◄── Optional: Log / BlockTracker / Valve       │
│  Epiphy的-空间特效组件.js (P:500) ◄══ Hard    : Spec + ServerBase (constraints)   │
│                                   ◄── Optional: Log                              │
│  Epiphy的-音频组件.js     (P:500) ◄══ Hard    : Spec + ServerBase                 │
│                                   ◄── Optional: Log / BlockTracker / Valve       │
│  拆解台-混沌殉爆.v18.js   (P:10)  ◄══ Hard    : Unstable + Core/WorldOps/Danmaku │
│  合成表-*/*.js            (P:0)   ◄── Standalone recipes (vanilla / target mods) │
└───────────┬─────────────────────────────┬──────────────────────────┬─────────────┘
            │ epiphy:screen_danmaku       │ epiphy:spatial_fx        │ epiphy:audio
            ▼ (S2C packets)               ▼ (S2C packets)            ▼ (S2C packets)
┌──────────────────────────────────────────────────────────────────────────────────┐
│ Layer 4 · Client Rendering & Audio Playback Layer (Presentation Consumers Only)  │
├──────────────────────────────────────────────────────────────────────────────────┤
│  Epiphy的-平面渲染器.js     ──► 2D Graph/Anim/Vanilla+ModernUI (opt startup:Spec)│
│  Epiphy的-空间特效渲染器.js ──► 3D Item Facade + World FX (`surface: 'world'`)   │
│  Epiphy的-音频播放器.js     ──► 3D Soundscape/Ducking/Retry  (opt startup: Spec) │
│  拆解台描述.js              ──► Client item tooltip descriptions                 │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### 2. Architecture Layer Quick Reference Table

| Layer | Modules | Stage / Priority | Primary Exports / Role |
| :--- | :--- | :--- | :--- |
| **L1 Cross-Side Spec** | `Epiphy的-Spec与通用工具.js` | `startup` / `1200` | `EpiphySpec v2.8.0`, `EpiphyProtocol`, `EpiphyMath` (incl. cross-stage `NativeMath` polyfill, `RenderGuiEvent$Pre` 2D & `RenderLevelStageEvent` World-3D bridges, 2D/3D cost models) |
| **L1 Item 3D** | `Epiphy的-物品三维渲染器.js` | `startup` / `1050` | `EpiphyItem3DRenderer v1.1.0` (generic v6 layered declarative item 3D pipeline, `fx()` DSL, extensible `registerShader`/`registerLayerType`/`registerPart`/`registerPreset`, flicker-free additive pure-Java `CCModel` ~0.54ms, Fail-Soft vanilla fallback without CCL) |
| **L1 Content Reg** | `创造模式栏-epiphy.js` | `startup` / `1000` | `EpiphyCreativeTab v1.0.0` (`epiphy:stuff`) |
| **L1 Content Reg** | Hidden Items / Test Block / Unstable Table | `startup` | Custom items, test block & 5-stage blocks |
| **L2 Infrastructure** | `Epiphy的-日志.js` | `server` / `1100` | `EpiphyLog v1.2.0` (rate-limit, `once`, `catchWarn`, external `.log` sink) |
| **L2 Infrastructure** | `Epiphy的-服务端核心.js` | `server` / `1080` | `EpiphyServerCore / EpiphyServerBase v2.6.0` (accessors, world/entity/Curios helpers, `openJsonStore` stateful persistence & `.bak` recovery, `epiphy-data/`, world fork, DSL) |
| **L2 Infrastructure** | `Epiphy的-方块与区块组件.js` | `server` / `1050` | `EpiphyBlockTracker / EpiphyWorldOps v2.5.1` (section scanning, persist dispatch, cost-gated fluid purge, terrain ops & preset registry) |
| **L2 Access Control** | `Epiphy的-权限阀.js` | `server` / `1000` | `EpiphyPermissionValve v5.4.0` (`/epiphy`, 3-state scopes, command-block mutation lock, tombstones, fail-closed auth) |
| **L2 Diagnostics** | `Epiphy的-调试组件.js` | `server` / `950` | `EpiphyDebug v1.0.0` (`/epiphy debug`, including `renderperf` client perf logger control) |
| **L2 Standalone Fix** | `Epiphy的-基础bug修复.js` | `server` / `900` | `EpiphyBugfix v1.0.0` (logout HP restoration) |
| **L3 Presentation** | `Epiphy的-平面渲染组件.js` | `server` / `500` | `Epiphy2DSurface / ScreenDanmaku v6.2.0` (2D scene graph, grouped deep-merge options, `channel`/`slot`, `id`-first `ui()` DSL, preset/widget registries, built-in `'progress_bar'` preset & danmaku scheduler; internal logic not for cross-module reuse) |
| **L3 Presentation** | `Epiphy的-空间特效组件.js` | `server` / `500` | `Epiphy3DFXServer v1.1.0` (`surface: 'world'` 3D FX scheduler, `channel`/`slot`, `addConstraint` extensible rule pipeline, custom shape schemas & upward presets; internal logic not for cross-module reuse) |
| **L3 Presentation** | `Epiphy的-音频组件.js` | `server` / `500` | `EpiphyAudio v5.8.0` (standalone scheduler with preset registry; internal logic not for cross-module reuse) |
| **L3 Gameplay** | `拆解台-混沌殉爆.v18.js` | `server` / `10` | Meltdown progression (hard-requiring Core/WorldOps/Danmaku; persisted countdown, native 2D preset HUD + `channel`/`slot` incremental `patch`, anti-spoof relic & mainhand pickaxe check) |
| **L3 Gameplay** | `合成表-*` (Vanilla / Botania / Enigmatic) | `server` / `0` | Standalone recipe adjustments |
| **L4 Client** | `平面渲染器` / `空间特效渲染器` / `音频播放器` / `拆解台描述` | `client` | `Epiphy2DRenderer / ScreenDanmakuClient v6.2.0`, `Epiphy3DFX v2.3.0`, `EpiphyAudioClient v5.6.0` |

### 3. Dependency & Fallback Specification (YAML)

```yaml
# ==================== Layer 1 · Startup ====================
Epiphy的-Spec与通用工具.js:
  requires: { hard: [], optional: [] }
  on_missing:
    - EpiphyServerBase and client engines fall back to slim built-in helpers
    - Server danmaku, spatial FX, and audio engines refuse to boot without hard dependency

Epiphy的-物品三维渲染器.js:
  requires: { hard: [], optional: [CodeChickenLib, EpiphySpec] }
  on_missing:
    no_CodeChickenLib: Emits a single warning and skips custom shader/IItemRenderer baking; bound items fall back cleanly to their vanilla static item models (no missing-texture cube, no errors)
    no_EpiphySpec:     Uses built-in monotonic clamped clock and local preset registry fallback

创造模式栏-epiphy.js:
  requires: { hard: [], optional: [] }
  on_missing: Dependent items are not grouped into the epiphy:stuff creative tab

Epiphy的小玩意-原版_其他Mod的隐藏物品.js:
  requires: { hard: [创造模式栏-epiphy.js] }

Epiphy的小玩意-终极拆解台_不稳定.js:
  requires: { hard: [kubejs/assets/epiphy/ textures & models] }

Epiphy的小玩意_功能测试.js:
  requires: { hard: [创造模式栏-epiphy.js], optional: [ScreenDanmaku, EpiphyAudio] }
  on_missing: Block still registers normally; interactions emit no danmaku/audio

# ==================== Layer 2 · Server Foundation ====================
Epiphy的-日志.js:
  requires: { hard: [], optional: [] }
  on_missing: Downstream components fall back to native console (no unified rate-limiting or debug toggle)

Epiphy的-服务端核心.js:
  requires: { hard: [], optional: [EpiphySpec, EpiphyLog] }
  on_missing:
    no_EpiphySpec: Enables built-in slim dimension/array helpers
    no_EpiphyLog:  Logger wrapper falls back to built-in rate-limited console

Epiphy的-方块与区块组件.js:
  requires: { hard: [EpiphyServerCore], optional: [EpiphyLog] }
  on_missing: Downstream bindBlock degrades to basic place/break listeners (no chunk scan, persistence, or terrain ops)

Epiphy的-权限阀.js:
  requires: { hard: [EpiphyServerBase], optional: [EpiphyLog] }
  on_missing: /epiphy subcommands do not mount (OP notified on login); JS APIs remain usable

Epiphy的-调试组件.js:
  requires: { hard: [EpiphyServerBase], optional: [EpiphyLog, EpiphyPermissionValve] }
  on_missing: /epiphy debug command is unmounted while snapshots stay accessible via global.EpiphyDebug

Epiphy的-基础bug修复.js:
  requires: { hard: [], optional: [EpiphyLog] } # Designed for standalone zero-hard-dep operation
  on_missing: Smoothly falls back to built-in rate-limited console logging

# ==================== Layer 3 · Server Scheduling & Gameplay ====================
Epiphy的-平面渲染组件.js:
  requires:
    hard:     [EpiphySpec, EpiphyProtocol, EpiphyServerBase]
    paired:   [Epiphy的-平面渲染器.js]
    optional: [EpiphyLog, EpiphyBlockTracker, EpiphyPermissionValve]
  on_missing:
    no_client: Server API works normally with no client rendering
    optional:  Each optional module triggers a clean single-layer fallback

Epiphy的-空间特效组件.js:
  requires:
    hard:     [EpiphySpec, EpiphyProtocol, EpiphyServerBase]
    paired:   [Epiphy的-空间特效渲染器.js]
    optional: [EpiphyLog]
  on_missing:
    no_client: Server scheduler and constraint pipeline run normally with no client world 3D rendering

Epiphy的-音频组件.js:
  requires:
    hard:     [EpiphySpec, EpiphyProtocol, EpiphyServerBase]
    paired:   [Epiphy的-音频播放器.js]
    optional: [EpiphyLog, EpiphyBlockTracker, EpiphyPermissionValve]
  on_missing:
    no_client: Server handles run normally with no client audio output
    optional:  Each optional module triggers a clean single-layer fallback
  note:     L3 schedulers (Epiphy2DSurface/ScreenDanmaku, EpiphyAudio) must only be consumed via their public global APIs; internal logic cannot be reused across modules

拆解台-混沌殉爆.v18.js:
  requires:
    hard:     [Epiphy的小玩意-终极拆解台_不稳定.js, EpiphyServerCore, EpiphyWorldOps, ScreenDanmaku]
    optional: [EpiphyAudio, kubejs/assets/epiphy/ lang & assets]
  on_missing: Throws Fail-Fast on load if any hard dependency is missing (no redundant gameplay-layer fallbacks)

# ==================== Layer 4 · Client ====================
Epiphy的-平面渲染器.js:
  requires: { paired: [Epiphy2DSurface, ScreenDanmaku], optional: [EpiphySpec, EpiphyProtocol] }
  on_missing: Uses built-in v6 protocol constants & basic helpers when Startup Spec is absent

Epiphy的-空间特效渲染器.js:
  requires: { paired: [Epiphy3DFXServer], optional: [EpiphyItem3DRenderer, EpiphySpec, EpiphyProtocol] }
  on_missing: Uses mirrored default config & built-in v1 protocol constants when Startup Spec/Item3DRenderer is absent, keeping world 3D queue & lifecycle active

Epiphy的-音频播放器.js:
  requires: { paired: [EpiphyAudio], optional: [EpiphySpec, EpiphyProtocol] }
  on_missing: Uses built-in v5 protocol constants & basic helpers when Startup Spec is absent
```

---

## Core Capabilities

1. **Shared Infrastructure & External `epiphy-data/` Storage**:
   - Centralized protocol constants, argument parsers, bounded `'fifo'`/`'lru'` cache pool (`createBoundedCache`), controlled deep-merge (`mergeTracksMap`/`mergeGroupedOptions`), and cross-stage upward preset registry (`createPresetRegistry`/`registerPreset`) (`EpiphySpec`), rate-limited logging with external readable `.log` rotation & KubeJS `ClassFilter` fallback (`EpiphyLog v1.2.0`), server accessors & stateful JSON persistence facade `openJsonStore` with `.bak` recovery and corrupt write-lock (`EpiphyServerCore / EpiphyServerBase v2.6.0`), and progressive chunk-section block tracking with 3-tier cost-gated terrain batch engine (`EpiphyBlockTracker / EpiphyWorldOps v2.5.1`).
   - External runtime root `<gameDir>/epiphy-data/` (`config/`, `worlds/`, `players/`, `events/`, `logs/`, `presets/`, `backups/`). Worlds bind via save-local `epiphy_world_id.json` and external `<slug>__<shortId>/meta.json`, automatically forking a fresh world folder when `lastWorldPath` changes (e.g., copied test saves) and notifying OPs on join.
   - **Permissions & Anti-Rollback Hardening (`EpiphyPermissionValve v5.4.0`)**: `Class.isInstance`-verified command dispatch with hierarchical permission scopes (allowing individual subcommands like `danmaku.self` or `audio.play` to be granted to non-OPs, child revocations overriding parent module grants, and `exactScopeOnly` broadcast gates for `danmaku.broadcast` / `audio.broadcast`), default strict UUID mode (explicitly documenting offline-server risks without TrueUUID or password-login plugins), external `revocations.json` tombstones blocking save-rollback resurrection, and Fail-Closed `auth_mode.json` requiring real OP/console 2-step confirmation via `/epiphy auth namegrant enable|confirm` (plus `scopes`, `grantname`, `revokename`, `where`, `reload`), hardened with prototype-key filtering, null `getContext()` source fallback, and synced `at`/`atMs` post-revocation timestamps.
   - **Diagnostics & Standalone Fix**: Live health/perf inspector (`EpiphyDebug v1.0.0`) and standalone server-authoritative logout HP restoration (`EpiphyBugfix v1.0.0`).
2. **Audiovisual Presentation Engines (with Non-OP Player Resource Isolation)**:
   - **2D Planar Compositor & Screen Danmaku (`Epiphy2DSurface / ScreenDanmaku v6.2.0` / `Epiphy2DRenderer / ScreenDanmakuClient v6.2.0`)**: `PROTO v6` declarative 6-type 2D scene graph (`rect`, `sprite`, `nine_slice`, `item`, `text`, `group`), unified `rect.fill` (`solid`, `outline`, `gradient`, `parallax`, `shader`), dual-mode clipping (`local`, `scissor`), client interpolation tracks (`lerp`, `trail`, `impulse`), grouped option deep-merge (`layout`/`life`/`motion`/`style`/`data`/`tracks`), unknown-key typo warnings, scoped `channel`/`slot` handles (automatic full push vs incremental `action: 'patch'`), `id`-first chainable `ui()` DSL (`steppedPlate`, `corners`, `steppedLine`, `ticks`, `boxes`, `texts`, `region`, `widget`), built-in `'progress_bar'` preset + `progressTracks`, and upward preset/custom widget registration (`registerPreset`, `registerWidget`); client hot-path optimizations include arrival-time declarative node precompilation (`isStaticFastRect` fast path), `stepHz` micro-caching, hoisted zero-closure rect batching + per-frame `resolveEventCaps`, parallax early culling, left-anchor zero-`font.width` skip + per-node text width caching, `'lru'` shared text layout cache, normalized coordinates with HUD zone avoidance, typewriter reveals, `per_char` glyph shake, outlines/glow, inline rich tags, dedicated `ModernUI (LGPL-3.0)` fast-path optimizations with automatic vanilla fallback, `once`/`active`/`screen_session` lifecycles, persisted/login-delayed emission, and namespace-isolated block bindings. Adds `/epiphy danmaku self` for individual player banners; non-OP `authorized` commands stay in `'player'` tier with parameter/rate/target clamping, while JS API, OP, console, and command blocks remain unrestricted.
   - **3D Spatial FX & Declarative Item 3D Subsystem (`EpiphyItem3DRenderer v1.1.0` / `Epiphy3DFXServer v1.1.0` / `Epiphy3DFX v2.3.0`)**: Strictly decoupled from the 2D planar renderer and designed around capability-first principles (implementation -> generic capability -> downstream showcases). Item rendering (`EpiphyItem3DRenderer`) shares the layered declarative `PROTO v6` schema (`model`/`frame`/`motion`/`lod`/`layers`) and chainable `fx()` DSL, offering extensible `registerShader`, 4 built-in pre-baked primitives (`surface_overlay`/`ribbon_ring`/`ribbon_helix`/`sprite_cluster`), `registerLayerType`/`registerPart`/`registerPreset`, and flicker-free additive pure-Java `CCModel` submission (~0.54ms, cleanly falling back to vanilla static models when CodeChickenLib is absent). World FX (`surface: 'world'`, channel `epiphy:spatial_fx`, proto v1, physically 0% CCL dependency) is driven by the `RenderLevelStageEvent` bridge in `Epiphy的-Spec与通用工具.js` (O(1) idle short-circuit), providing server-side scheduling, `'player'`/`'system'` quota & eviction isolation, stateful `channel`/`slot` incremental `patch`, extensible `addConstraint` rule pipelines, smooth `followEntityUuid` entity interpolation, built-in pure-vanilla renderers for all 4 core shapes (`ring`/`beam`/`helix`/`sphere`), and `registerShapeSchema` / `registerWorldShape` hooks.
   - **Spatial Audio (`EpiphyAudio v5.8.0` / `EpiphyAudioClient v5.6.0`)**: Fixed coordinate, block, tracked entity, dimension, and server-wide handles with upward preset registration (`registerPreset`, `playPreset`, `{ preset }`, including `bindBlock` preset resolution); attenuation curves; live 3D `Channel` selfPosition syncing; `pause` standby on category mute/out-of-range; coalesced scan `merge` cluster consolidation; namespace-filtered gentle `pause`/`unpause` vanilla music ducking (`duckMusic` pauses only `minecraft:` `MUSIC` channels, preserves `duckedMusicInsts` when `chanMap` is transiently null, and never pauses or stops other mods' BGM); validated `configure`; unstarted timeout cleanup; late tracker upgrade; and retry-safe `pendingReset`. Non-OP `authorized` commands enter `'player'` tier (`priority <= 3`, `u:<uuid>:` key prefix, `audio.broadcast` required for `>4` targets or cross-dim, and one-way eviction protecting `'system'` audio).
3. **Gameplay Content & Tweaks**: `epiphy:stuff` creative tab and hidden-item collection (including Chaos Crystal CCL 3D OBJ + Chaos Shader rendering), `epiphy:rnfmabj_test` broadcast test block, the 5-stage Twilight Forest Uncrafting Table chaotic meltdown event with supreme-relic exemptions, and recipe adjustments.

---

## Repository Layout

```text
.
├── kubejs/
│   ├── assets/epiphy/            # Sound assets (.ogg, see docs/audio-assets.md), core shaders (shaders/core/), models, textures, blockstates, zh_cn lang
│   ├── client_scripts/           # Client 2D renderer, 3D spatial FX client (Epiphy的-空间特效渲染器.js), audio player, custom item tooltips
│   ├── server_scripts/           # Server foundation, valve/debug/bugfix, 2D/3D FX (Epiphy的-空间特效组件.js)/audio schedulers, gameplay scripts
│   └── startup_scripts/          # Startup Spec/Protocol/2D&3D hooks, generic declarative item 3D renderer (Epiphy的-物品三维渲染器.js), item/block/tab registrations & showcases
├── docs/
│   ├── audio-assets.md                           # Audio asset exclusion & BYO placement notes
│   ├── kube-mods-rhino-es5-es6-compatibility.md  # Bytecode & runtime audit of kube-mods/rhino
│   ├── proto_v6_schema.json                      # Authoritative PROTO v6 JSON Schema contract
│   └── rendering-subsystem-roadmap.md            # 2D Planar Compositor & 3D Spatial FX roadmap & v6 protocol specification
├── scripts/
│   ├── rhino-check.js            # Real Rhino / acorn AST syntax & semantic-drift gate
│   └── sync-doc-versions.js      # SSOT 3-segment version sync & anti-drift check across headers & docs (npm run sync-docs)
├── tests/
│   ├── run.js                    # Unified test runner (supports suite/name filtering)
│   ├── helpers/harness.js        # Shared KubeJS VM sandbox & path harness
│   ├── suites/*.test.js          # 7 domain-grouped test suites (exact count reported by npm test)
│   └── pure_functions.test.js    # Backwards-compatible shim forwarding to tests/run.js
├── README.md                     # Chinese README (default)
├── README_EN.md                  # English README
├── README-LLM.md                 # Engineering rules & persistent context for LLMs
└── LICENSE.md                    # Full RAL 1.6 license text
```

---

## Installation & Testing

### Installing into a Modpack
1. Current transitional runtime requirement: **Minecraft 1.20.1 / Forge 47.x / KubeJS 2001.6.x** (theoretically compatible with Fabric; untested).
2. Merge `kubejs/` into both client `.minecraft/` and dedicated server root.
3. In-game (OP required for admin actions), use `/epiphy help`, `/epiphy auth list`, `/epiphy auth where`, and `/epiphy debug`; runtime data is stored in `<gameDir>/epiphy-data/` (git-ignored; never commit runtime artifacts).
4. **Excluded Assets & Config Notice**:
   - The third-party commercial track `children_of_the_city.ogg` is intentionally omitted from this public repository (and git-ignored; see [`docs/audio-assets.md`](docs/audio-assets.md)). [`sounds.json`](kubejs/assets/epiphy/sounds.json) and the test block script retain the `epiphy:children_of_the_city` sound event slot for optional user-supplied audio without breaking the block's danmaku/placement behavior when absent.
   - Only runtime-loaded `.ogg` sound effects are included; redundant `.mp3` sources, leftover `.bak` backups, and KubeJS default templates/IDE configs (`example_*`, `kubejs/README.txt`, `kubejs/config/*.properties`, `probejs.json`, `jsconfig.json`) were removed so merging `kubejs/` will not overwrite existing modpack configs.

### Running Sandbox Unit Tests & Rhino Checks
```bash
npm install
npm test
```

> **Notes**:
> - Run `npm install` first on a fresh clone to install the zero-dependency `acorn` devDependency; `scripts/rhino-check.js` fails fast (`exit 1`) if `acorn` is missing rather than downgrading to a weak check.
> - `npm test` runs `node tests/run.js` (V8 sandbox tests + `docs/proto_v6_schema.json` protocol conformance) followed by `node scripts/rhino-check.js` (mandatory `acorn` AST semantic-drift guard + real Rhino / `local-acorn-ast` syntax validation).
> - If a JDK and `rhino-forge-*.jar` are available locally, point `RHINO_JAR`, `MC_MODS_DIR`, or git-ignored `.rhino-local.json` to them for real `Context.compileString` verification (pass `--require-rhino` to forbid fallback); otherwise it falls back to `local-acorn-ast`.
> - For rendering or frame-budget changes, verify in-game and toggle `/epiphy debug renderperf on|dump` to inspect `epiphy-data/logs/client_render_perf.json`.

### Git Commit Convention
- **Format**: `<subject> [(<scope>)] <中文说明> | <English description>` (both Chinese and English summaries are required in every commit message).
- **Standard `<subject>` types**: `feat` / `fix` / `refactor` / `perf` / `docs` / `style` / `test` / `chore` / `build` / `ci` / `revert` (see [`README-LLM.md`](README-LLM.md) Section 6 for full details).

---

## Authors & Roles

- **Epiphy-iLLUMs**: Creator, Gameplay Design, Lead Maintainer; responsible for designing and implementing substantial core features, overall project structure, modular architecture planning, error correction, and refactoring direction.
- **Gemini 4 series**: Architecture Collaboration, Component Implementation & Debugging.
- **Claude 5.5 series**: Architecture Collaboration, Component Implementation, Error Correction & Optimization Proposals.
- **DeepSeek**: Mascot.

---

## License

Licensed under **RAL 1.6 (Reciprocal Attribution License 1.6)** — see [`LICENSE.md`](LICENSE.md) for the full legal text.

Summary (the Chinese original in [`LICENSE.md`](LICENSE.md) governs in case of ambiguity):
- **Source-Available Reciprocal License**: Preserves modification and fork freedoms with mandatory attribution;
- **Strict Reciprocity**: Modifications, derivatives, static linking, and dynamic linking dependencies trigger reciprocal source disclosure; wrapper layers cannot be used to evade obligations;
- **Commercial Boundaries**: Commercial integration as a non-primary component is permitted, **direct standalone resale is prohibited**, and Managed SaaS requires full-stack open source;
- **Incompatible Licenses**: Conflicting non-forkable licenses (e.g., PolyForm Shield 1.0.0) are barred from inclusion or bridging (except source-isolated Pure Compatibility Code permitted as a special exception under `r2` Sections 2.12 & 11.8).
