# Epiphy KubeJS Components & Scripts (`epiphy-kubejs-components`)

[中文 (默认)](README.md) · [English](README_EN.md) · [Native Mod Migration Plan](docs/native-mod-migration-plan.md) · [Rendering Subsystem Roadmap](docs/rendering-subsystem-roadmap.md) · [LLM Engineering Guide](README-LLM.md) · [License (RAL 1.6)](LICENSE.md)

A declarative audiovisual presentation engine and hardened server infrastructure library for **Minecraft 1.20.1 (Forge 47.x + KubeJS 2001.6.x)**.  
It enables modpack authors and developers to script **screen danmaku, animated 2D HUD telemetry panels, 3D world holographic signs, multi-layer 3D item VFX, and 3D spatial soundscapes**, backed by **anti-rollback permission controls, low-overhead chunk block tracking, cost-gated terrain/fluid batch operations**, and **vanilla logout HP truncation fixes**.

> [!IMPORTANT]
> **Lifecycle, Compatibility & Platform Policy (Final Baseline Before Phase 4 Native Mod)**
> 1. **No Coexistence Period — Pure KubeJS Version Enters Direct EOL**: This project is transitioning into a standalone **Kotlin + Java** native mod (see [`docs/native-mod-migration-plan.md`](docs/native-mod-migration-plan.md)). **Once the native mod is officially released, there will be NO coexistence period and NO Maintenance LTS for these pure KubeJS scripts — the KubeJS-only version will immediately enter EOL (End of Life) with no further official maintenance.**
> 2. **One-Way Upgrade — Back Up Your Data**: We **do NOT guarantee that save or external data will remain readable if you downgrade from the native mod back to the KubeJS version**. Please back up your world and `epiphy-data/` before upgrading.
> 3. **Calling Native Mod APIs via KubeJS & Legacy Compatibility**:
>    - **Recommended Script Workflow**: After native mod migration, **calling the interfaces directly exposed by the native Epiphy mod from KubeJS scripts is fully supported — if you prefer scripting, this remains the recommended approach and will receive broad long-term support**;
>    - **Legacy Script Expectations**: Existing KubeJS scripts will still get **similar behavior** via the same call patterns (minor bugs or behavioral differences in unadapted scripts are expected as the underlying APIs have been upgraded and will continue to evolve). While we strive for forward compatibility, native mod migration is a major update — **incompatible legacy features will NOT be specially patched**.
> 4. **Forge Only**: Both the current scripts and the upcoming native mod target **Forge** (`Kotlin for Forge`). **There are currently NO plans for a Fabric version.**

### Runtime Requirements & Optional Mod Integrations

- **Required Base**: `Minecraft 1.20.1` · `Forge 47.x` · `KubeJS 2001.6.x`
- **Optional Third-Party Mods in Common Components** (all degrade cleanly with zero crashes or log spam when absent):

| Optional Mod | Used By | What It Does / Fallback When Absent | Native Mod (Phase 4) Plan |
| :--- | :--- | :--- | :--- |
| **CodeChickenLib** | `Epiphy的-物品三维渲染器.js` | Provides custom 3D item rendering hooks and pure-Java mesh submission (~0.54ms); **when absent, logs 1 warning and falls back to vanilla static 2D item icons** (World 3D FX has 0% CCL dependency) | **Remove completely** & self-implement in native mod |
| **ModernUI** | `Epiphy的-平面渲染器.js` | Enables direct text layout caching and single-pass SDF outline rendering; **when absent, transparently uses vanilla font rendering** | Keep as optional compatibility fast path |
| **Curios API** | `Epiphy的-服务端核心.js` | Allows querying Curios accessory slots (`findPlayerCurio`); **when absent, safely skips Curios slots** | Keep as optional soft compatibility bridge |

- **Gameplay / Recipe Script Dependencies** (only needed by specific showcase/recipe scripts; the 15 common components run standalone without them): `Twilight Forest` (Unstable Uncrafting Table meltdown & liveroot recipe), `Draconic Evolution` + `BrandonsCore` + `CodeChickenLib` (Chaos Implosion wave & hidden Chaos Crystal item), `Enigmatic Legacy` (supreme relic exemption & cursed ring recipe), `Botania` (liveroot recipe).

---

## What Can It Do? (Core Capabilities)

### 1. 📺 2D Planar Compositor, Screen Danmaku & World Holograms
> Server: `Epiphy2DSurface / ScreenDanmaku v6.3.0` · Client: `Epiphy2DRenderer / ScreenDanmakuClient v6.3.0`

- **Four Projection Surfaces (`surface`)**:
  - `screen`: Screen danmaku and declarative HUD panels (rendered below vanilla hotbar/health bars and above regular danmaku by default, with customizable `renderPriority` / `zIndex`);
  - `gui`: Dynamically replaces container GUI textures for the active screen session (auto-restored on close) or injects background/foreground decorative layers;
  - `slot`: Automatically matches container slots by index or item ID to render dynamic badges, cooldown masks, or highlights over slots;
  - `world_plane`: 3D-projected 2D holographic signs and ground magic circles anchored in the world (with save-scoped persistence, view-distance sync, billboard modes, and `seeThrough` X-ray support).
- **Declarative Scene Graph & 60fps Client Interpolation**: Built-in `rect` (solid, outline, 3-stop gradient, procedural/textured parallax, shader), `sprite`, `nine_slice`, `item`, `text` (typewriter, per-char shake, glow/stroke outlines), and `group` primitives. Client-side `lerp`, `trail`, and `impulse` tracks animate properties smoothly at 60fps from tiny server `action: 'patch'` updates.

### 2. ✨ Declarative 3D Item VFX & World Spatial FX
> Item 3D: `EpiphyItem3DRenderer v1.1.0` · World Server: `Epiphy3DFXServer v1.2.0` · World Client: `Epiphy3DFX v2.3.0`

- **3D Item Rendering (`EpiphyItem3DRenderer`)**: Chainable `fx()` DSL for attaching custom GLSL core shader overlays (e.g., parallax cosmos windows), rotating gyro rings (`ribbon_ring`), dual spiral ribbons (`ribbon_helix`), and orbiting star flares (`sprite_cluster`) to items with true hardware depth occlusion in first/third person and GUI slots.
- **World Spatial FX (`surface: 'world'`)**: Physically 0% third-party mod dependency. Spawns 3D `ring`, `beam`, `helix`, and `sphere` primitives at world coordinates or smoothly tracking entities (`followEntityUuid`), complete with `channel`/`slot` incremental patching and custom shape extensions.

### 3. 🔊 3D Spatial Audio & Gentle Music Ducking
> Server: `EpiphyAudio v5.8.0` · Client: `EpiphyAudioClient v5.6.0`

- **Multi-Source 3D Soundscapes**: Bind audio to fixed coordinates, blocks (`bindBlock`), moving entities, or dimensions with real-time OpenAL 3D channel position updates and distance attenuation curves.
- **Cluster Merging & Stream Standby**: Adjacent identical sound blocks automatically merge into a single union soundscape (recalculated seamlessly when blocks break). Exiting range or muting pauses the stream in standby so re-entering resumes smoothly without restarting.
- **Mod-Safe Music Ducking (`duckMusic`)**: Gently pauses only vanilla `minecraft:` background music while custom BGM plays and unpauses afterward — **never killing or muting other mods' custom BGM**.

### 4. 🛡️ Hardened Server Infrastructure, Block Engine & Standalone Bugfixes
> Core: `EpiphyServerCore / EpiphyServerBase v2.6.0` · Security: `EpiphyPermissionValve v5.4.0` · World: `EpiphyBlockTracker / EpiphyWorldOps v2.5.1` · Fix: `EpiphyBugfix v1.0.0`

- **Dual-Track Storage (`epiphy-data/`)**: Strictly separates world-state data that must roll back with saves (`saves/<world>/`) from anti-rollback security audits and daily readable logs (`<gameDir>/epiphy-data/`). Automatically detects copied world folders to fork isolated directories and self-heals corrupted JSON files from `.bak` backups with write-lock protection.
- **Anti-Rollback 3-State Permission Valve**: Grants fine-grained sub-scopes (like `/epiphy danmaku self` or `audio.play`) to non-OP players while enforcing strict quota, cooldown, and namespace isolation. Revocations write external tombstones in `revocations.json` so rolling back a world save cannot resurrect revoked permissions.
- **Progressive Chunk Scanner & Cost-Gated WorldOps**: Scans bound blocks across ticks without stalling the server thread, paired with a 3-tier cost-gated fluid draining and terrain clearing engine (protecting bedrock, containers, and designated lava rings).
- **Logout HP Truncation Fix (`EpiphyBugfix`)**: Zero-dependency server module that fixes the vanilla bug where players with `maxHealth > 20` (from Curios/attributes) have their health truncated back to 20 upon rejoining a world.

---

## Architecture & 15 Common Components Quick Reference

### 1. Four-Layer Topology

```text
┌──────────────────────────────────────────────────────────────────────────────────┐
│ Layer 1 · Startup Stage (Cross-Side Contracts, Item 3D Pipeline & Registrations) │
├──────────────────────────────────────────────────────────────────────────────────┤
│  Epiphy的-Spec与通用工具.js (P:1200) ──► EpiphySpec / Protocol / 2D&3D Hooks     │
│  Epiphy的-物品三维渲染器.js (P:1050) ──► EpiphyItem3DRenderer (opt: CCL fallback)│
│  创造模式栏-epiphy.js       (P:1000) ──► global.EpiphyCreativeTab (epiphy:stuff)  │
│     └──► Hidden Items / Unstable Uncrafting Table (5 stages) / Test Showcases    │
└────────────────────────────┬─────────────────────────────┬───────────────────────┘
                             │ (optional fallback)          │ (hard dep)
                             ▼                             ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│ Layer 2 · Server Foundation Layer (Load Order: Priority 1100 ──► 900)            │
├──────────────────────────────────────────────────────────────────────────────────┤
│  P:1100  Epiphy的-日志.js           ──► EpiphyLog            (rate-limit/log)    │
│  P:1080  Epiphy的-服务端核心.js     ──► EpiphyServerCore/Base (storage/DSL)     │
│  P:1050  Epiphy的-方块与区块组件.js ──► EpiphyBlockTracker/WorldOps (scan/ops)  │
│  P:1000  Epiphy的-权限阀.js         ──► EpiphyPermissionValve (3-state/tombstone)│
│  P:950   Epiphy的-调试组件.js       ──► EpiphyDebug          (metrics/renderperf)│
│  P:900   Epiphy的-基础bug修复.js    ──► EpiphyBugfix         (logout HP restore) │
└────────────────────────────┬─────────────────────────────────────────────────────┘
                             │ global.* APIs & Preset Registries
                             ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│ Layer 3 · Server Scheduling & Gameplay Scripts                                   │
├──────────────────────────────────────────────────────────────────────────────────┤
│  Epiphy的-平面渲染组件.js (P:500)  │ Epiphy的-空间特效组件.js (P:500) │ Audio    │
│  拆解台-混沌殉爆.v18.js   (P:10)   │ 合成表-*/*.js            (P:0)   │ (P:500)  │
└───────────┬────────────────────────┴────┬─────────────────────────────┴────┬─────┘
            │ epiphy:screen_danmaku       │ epiphy:spatial_fx                │ epiphy:audio
            ▼ (S2C packets)               ▼ (S2C packets)                    ▼ (S2C packets)
┌──────────────────────────────────────────────────────────────────────────────────┐
│ Layer 4 · Client Presentation Layer (Rendering & Audio Playback Consumers Only)  │
├──────────────────────────────────────────────────────────────────────────────────┤
│  Epiphy的-平面渲染器.js     ──► 2D Scene Graph / Tracks / GUI&Slot / World Plane │
│  Epiphy的-空间特效渲染器.js ──► World 3D FX Renderer (0% CCL) + Item 3D Facade   │
│  Epiphy的-音频播放器.js     ──► OpenAL 3D Soundscape / Music Ducking / Retry     │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### 2. Managed Components Reference Table

| Layer | Script File | Stage (Priority) | Global Export & Version | Summary |
| :--- | :--- | :---: | :--- | :--- |
| **L1 Spec** | `Epiphy的-Spec与通用工具.js` | `startup` (`1200`) | `EpiphySpec v2.8.1`<br>`EpiphyProtocol` / `EpiphyMath` | Cross-side protocol constants, parsers, LRU/FIFO bounded caches, preset registry, Rhino `Math` polyfill & 2D/3D render bridges |
| **L1 Item 3D** | `Epiphy的-物品三维渲染器.js` | `startup` (`1050`) | `EpiphyItem3DRenderer v1.1.0` | Declarative generic item 3D pipeline (`fx()` DSL, custom core shaders, pre-baked rings/helices/flares, Fail-Soft vanilla fallback without CCL) |
| **L1 Tab** | `创造模式栏-epiphy.js` | `startup` (`1000`) | `EpiphyCreativeTab v1.0.0` | Manages the unified `epiphy:stuff` creative tab and cross-script item queue |
| **L2 Log** | `Epiphy的-日志.js` | `server` (`1100`) | `EpiphyLog v1.2.0` | Rate-limited console logging, deduplicated warnings, `catchWarn` & world-routed daily `.log` files in `epiphy-data/` |
| **L2 Core** | `Epiphy的-服务端核心.js` | `server` (`1080`) | `EpiphyServerCore / EpiphyServerBase v2.6.0` | Safe world/entity/Curios helpers, `openJsonStore` (`.bak` recovery & corrupt lock), copied-save auto-forking & Brigadier DSL |
| **L2 World** | `Epiphy的-方块与区块组件.js` | `server` (`1050`) | `EpiphyBlockTracker / EpiphyWorldOps v2.5.1` | Progressive chunk-section block tracker, persistence dispatch & 3-tier cost-gated fluid/terrain batch operations |
| **L2 Security** | `Epiphy的-权限阀.js` | `server` (`1000`) | `EpiphyPermissionValve v5.4.0` | `/epiphy` root command, 3-state hierarchical scopes, command-block lock, external revocation tombstones & 2-step `namegrant` |
| **L2 Debug** | `Epiphy的-调试组件.js` | `server` (`950`) | `EpiphyDebug v1.1.0` | `/epiphy debug` multi-module telemetry, health checks & client `renderperf` sampling toggle |
| **L2 Bugfix** | `Epiphy的-基础bug修复.js` | `server` (`900`) | `EpiphyBugfix v1.0.0` | Standalone zero-dependency fix restoring high-cap player HP truncated to 20 on world rejoin |
| **L3 2D Server** | `Epiphy的-平面渲染组件.js` | `server` (`500`) | `Epiphy2DSurface / ScreenDanmaku v6.3.0` | 2D scene graph scheduler, `ui()` DSL, `channel`/`slot` incremental sync, persisted `world_plane` holograms & danmaku |
| **L3 3D Server** | `Epiphy的-空间特效组件.js` | `server` (`500`) | `Epiphy3DFXServer v1.2.0` | World 3D spatial FX (`surface: 'world'`) server scheduler, quota isolation, `channel`/`slot` & extensible constraint chain |
| **L3 Audio** | `Epiphy的-音频组件.js` | `server` (`500`) | `EpiphyAudio v5.8.0` | 3D spatial audio server scheduler, adjacent block sphere-cluster merging, entity tracking & player-tier quota isolation |
| **L4 2D Client** | `Epiphy的-平面渲染器.js` | `client` | `Epiphy2DRenderer / ScreenDanmakuClient v6.3.0` | Client 2D node precompilation & batched rendering, track interpolation, GUI texture remap & slot overlays, 3D world planes & ModernUI fast path |
| **L4 3D Client** | `Epiphy的-空间特效渲染器.js` | `client` | `Epiphy3DFX v2.3.0` | Client world 3D FX renderer (100% zero-CCL, built-in ring/beam/helix/sphere & entity tracking) + item 3D status facade |
| **L4 Audio** | `Epiphy的-音频播放器.js` | `client` | `EpiphyAudioClient v5.6.0` | Client OpenAL 3D position syncing, mute standby pause, gentle vanilla `minecraft:` music ducking & stream retry |

<details>
<summary><b>📋 Click to Expand: Module Dependency & Fallback Specification (YAML)</b></summary>

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

</details>

---

## Quick Start: Installation, Commands & Verification

### 1. Installing into a Modpack
1. Ensure your instance runs **Minecraft 1.20.1 + Forge 47.x + KubeJS 2001.6.x** (no Fabric version planned).
2. Merge `kubejs/` into both the client `.minecraft/` folder and dedicated server root.
3. On launch, `<gameDir>/epiphy-data/` is created automatically for anti-rollback permissions and daily logs (git-ignored; never commit runtime data).
4. **Note on Test Block Audio**: For copyright and size reasons, `children_of_the_city.ogg` is omitted from this repository (see [`docs/audio-assets.md`](docs/audio-assets.md)). The test block's danmaku and placement logic work without it; supply your own `.ogg` or rebind the sound ID if you want BGM playback.

### 2. Common In-Game Commands (OP or Granted Scope)

| Command | Description |
| :--- | :--- |
| `/epiphy help` | List all mounted subcommands |
| `/epiphy auth list` / `scopes` / `where` | Inspect authorized players, fine-grained permission scopes, and `epiphy-data/` paths |
| `/epiphy debug status` / `check` | View active handle counts, cache hit rates, and run health self-checks |
| `/epiphy debug renderperf on\|dump\|off` | Toggle client per-phase render timing and dump stats to `epiphy-data/logs/client_render_perf.json` |
| `/epiphy danmaku self <text>` | Emit a personal screen banner (can be granted to regular players via `danmaku.self`) |
| `/epiphy audio list` / `info` | Inspect active 3D audio handles and listener states |

### 3. Running Sandbox Unit Tests & Static Checks

Verify all logic and Rhino syntax locally in Node.js without booting Minecraft:

```bash
npm install               # Install zero-dependency acorn parser on first clone
npm test                  # Run 7 sandbox test suites + PROTO v6 Schema check + Rhino AST guard
npm run sync-docs:check   # Verify 3-segment semver parity across all 15 component headers & 4 docs
```

- **Real Rhino Bytecode Compilation**: Point `RHINO_JAR`, `MC_MODS_DIR`, or `.rhino-local.json` to a local JDK + `rhino-forge-*.jar` for real `Context.compileString` verification in `scripts/rhino-check.js`; otherwise it automatically falls back to `local-acorn-ast` to catch `Math.PI`, `??`, `let/const`, and other Rhino pitfalls.

---

## Repository Layout

```text
.
├── kubejs/
│   ├── assets/epiphy/            # Sound assets (.ogg), core shaders (shaders/core/), models, textures & lang
│   ├── client_scripts/           # 通用组件/ (2D planar renderer, 3D spatial FX client, audio player) & tooltips
│   ├── server_scripts/           # 通用组件/ (log, server core, block/chunk engine, valve, debug, bugfix, 2D/3D/audio) & recipes
│   └── startup_scripts/          # 通用组件/ (Spec & hooks, item 3D renderer, creative tab) & showcases / meltdown blocks
├── docs/
│   ├── native-mod-migration-plan.md              # Phase 4 standalone native mod (Kotlin + Java) migration plan
│   ├── rendering-subsystem-roadmap.md            # 2D Planar Compositor & 3D Spatial FX roadmap & v6 specification
│   ├── proto_v6_schema.json                      # Authoritative PROTO v6 JSON Schema contract
│   ├── kube-mods-rhino-es5-es6-compatibility.md  # Bytecode & runtime audit of kube-mods/rhino
│   └── audio-assets.md                           # Audio asset exclusion & BYO placement notes
├── scripts/
│   ├── rhino-check.js            # Real Rhino / acorn AST syntax & semantic-drift gate
│   └── sync-doc-versions.js      # SSOT 3-segment version sync & anti-drift check (npm run sync-docs)
├── tests/
│   ├── run.js                    # Unified test runner (supports suite/name filtering)
│   ├── helpers/harness.js        # Shared KubeJS VM sandbox & path harness
│   └── suites/*.test.js          # 7 domain-grouped regression test suites
├── README.md                     # Chinese README (default)
├── README_EN.md                  # English README
├── README-LLM.md                 # Engineering rules & persistent context for LLMs
└── LICENSE.md                    # Full RAL 1.6 license text
```

---

## Authors & License

### Authors & Roles
- **Epiphy-iLLUMs**: Creator, Gameplay Design, Lead Maintainer; responsible for core feature design and implementation, project structure, modular architecture planning, error correction, and refactoring direction.
- **Gemini 4 series**: Architecture Collaboration, Component Implementation & Debugging.
- **Claude 5.5 series**: Architecture Collaboration, Component Implementation, Error Correction & Optimization Proposals.
- **DeepSeek**: Mascot.

### License (`RAL-1.6`)

Licensed under **RAL 1.6 (Reciprocal Attribution License 1.6)** — see [`LICENSE.md`](LICENSE.md) for the authoritative Chinese legal text:
- **Source-Available & Attribution**: Modification, extension, and forking are permitted with mandatory attribution to original authors and contributors;
- **Reciprocal Open-Source Obligation**: Modifications, derivatives, and static/dynamic linking dependencies must disclose source under compatible terms;
- **Commercial Boundaries**: Commercial integration as a non-primary component is permitted, while **direct standalone resale of this work is prohibited**;
- **Incompatible Licenses**: Conflicting non-forkable licenses (e.g., PolyForm Shield 1.0.0) are barred (except source-isolated Pure Compatibility Code under `r2` Sections 2.12 & 11.8).

> [!TIP]
> **For Modpack & Script Authors: Downstream KubeJS `.js` Scripts Do NOT Need a License Declaration**  
> Because KubeJS `.js` scripts are inherently distributed as plain source files directly downloaded to players' computers, **downstream `.js` scripts built on KubeJS and Epiphy components do NOT need to declare a license**.
