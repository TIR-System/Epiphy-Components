# Epiphy KubeJS Components & Scripts (`epiphy-kubejs-components`)

[中文 (默认)](README.md) · [English](README_EN.md) · [LLM Engineering Guide](README-LLM.md) · [License (RAL 1.6)](LICENSE.md)

A collection of shared server/client infrastructure modules, audiovisual presentation engines (screen danmaku + 3D spatial audio), gameplay bugfixes, and modpack customization scripts built for **Minecraft 1.20.1 / Forge 47.x / KubeJS 2001.6.x**.

> **Status, Roadmap & Platform Notes**
> - **Early Testing Notice (⚠️ Unstable)**: This project is currently in an **early testing stage**. APIs, data schemas, command syntax, and module boundaries are not yet frozen — **current behavior may be unstable and major breaking changes can occur frequently**. Not recommended for production worlds requiring strict long-term stability yet.
> - **Migration Direction**: Once stabilized and feature-complete, this project will transition to **Kotlin + Java** native mod development, with most features becoming standalone modules; **KubeJS is a transitional dependency prior to that migration**.
> - **Loader Compatibility**: Currently tested on **Forge 47.x**. Apart from a small number of Forge-specific compatibility hooks, the core design is **theoretically compatible with Fabric as well**, though **untested on Fabric**.

---

## Engineering Architecture & Module Dependencies

### 1. Vertical Layer Topology (Text Box Diagram)

```text
┌──────────────────────────────────────────────────────────────────────────────────┐
│ Layer 1 · Startup Stage (Cross-Side Contracts & Asset/Content Registrations)     │
├──────────────────────────────────────────────────────────────────────────────────┤
│  Epiphy的-Spec与通用工具.js (P:1200) ──► global.EpiphySpec / EpiphyProtocol       │
│  创造模式栏-epiphy.js       (P:1000) ──► global.EpiphyCreativeTab (epiphy:stuff)  │
│     ├──► Epiphy的小玩意-原版_其他Mod的隐藏物品.js                                 │
│     ├──► Epiphy的小玩意-终极拆解台_不稳定.js  (paired with assets/epiphy/)        │
│     └──► Epiphy的小玩意_功能测试.js           (integrates Layer 3 Danmaku/Audio)  │
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
│  P:950   Epiphy的-调试组件.js     ──► EpiphyDebug         (opt: Log / Valve)      │
│  P:900   Epiphy的-基础bug修复.js  ──► EpiphyBugfix        (zero hard deps; opt:Log)│
└────────────────────────────┬─────────────────────────────────────────────────────┘
                             │ global.* APIs & deferred registration queues
                             ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│ Layer 3 · Server Scheduling & Gameplay Layer                                     │
├──────────────────────────────────────────────────────────────────────────────────┤
│  Epiphy的-屏幕弹幕组件.js (P:500) ◄══ Hard    : Spec + ServerBase                 │
│                                   ◄── Optional: Log / BlockTracker / Valve       │
│  Epiphy的-音频组件.js     (P:500) ◄══ Hard    : Spec + ServerBase                 │
│                                   ◄── Optional: Log / BlockTracker / Valve       │
│  拆解台-混沌殉爆.v18.js           ◄══ Requires: Unstable Blocks + ScreenDanmaku  │
│  合成表-*/*.js                    ◄── Standalone recipes (vanilla / target mods) │
└──────────────┬──────────────────────────────────────────────┬────────────────────┘
               │ epiphy:screen_danmaku                        │ epiphy:audio
               ▼ (S2C packets)                                ▼ (S2C packets)
┌──────────────────────────────────────────────────────────────────────────────────┐
│ Layer 4 · Client Rendering & Audio Playback Layer (Presentation Consumers Only)  │
├──────────────────────────────────────────────────────────────────────────────────┤
│  Epiphy的-屏幕弹幕渲染器.js ──► Layout/Anim/Vanilla+ModernUI (opt startup: Spec) │
│  Epiphy的-音频播放器.js     ──► 3D Soundscape/Ducking/Retry  (opt startup: Spec) │
│  拆解台描述.js              ──► Client item tooltip descriptions                 │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### 2. Architecture Layer Quick Reference Table

| Layer | Modules | Stage / Priority | Primary Exports / Role |
| :--- | :--- | :--- | :--- |
| **L1 Cross-Side Spec** | `Epiphy的-Spec与通用工具.js` | `startup` / `1200` | `EpiphySpec`, `EpiphyProtocol` |
| **L1 Content Reg** | `创造模式栏-epiphy.js` | `startup` / `1000` | `EpiphyCreativeTab` (`epiphy:stuff`) |
| **L1 Content Reg** | Hidden Items / Test Block / Unstable Table | `startup` | Custom items, test block & 5-stage blocks |
| **L2 Infrastructure** | `Epiphy的-日志.js` | `server` / `1100` | `EpiphyLog v1.2` (rate-limit, `once`, `catchWarn`, external `.log` sink) |
| **L2 Infrastructure** | `Epiphy的-服务端核心.js` | `server` / `1080` | `EpiphyServerCore / EpiphyServerBase v2.5` (accessors, world/entity/Curios helpers, `.bak` recovery, `epiphy-data/`, world fork, DSL) |
| **L2 Infrastructure** | `Epiphy的-方块与区块组件.js` | `server` / `1050` | `EpiphyBlockTracker / EpiphyWorldOps v2.4` (section scanning, persist dispatch, cost-gated fluid purge & terrain ops) |
| **L2 Access Control** | `Epiphy的-权限阀.js` | `server` / `1000` | `EpiphyPermissionValve v5.4` (`/epiphy`, 3-state scopes, command-block mutation lock, tombstones, fail-closed auth) |
| **L2 Diagnostics** | `Epiphy的-调试组件.js` | `server` / `950` | `EpiphyDebug v1` (`/epiphy debug`) |
| **L2 Standalone Fix** | `Epiphy的-基础bug修复.js` | `server` / `900` | `EpiphyBugfix v1` (logout HP restoration) |
| **L3 Presentation** | `Epiphy的-屏幕弹幕组件.js` | `server` / `500` | `ScreenDanmaku v5.7` (standalone scheduler; internal logic not for cross-module reuse) |
| **L3 Presentation** | `Epiphy的-音频组件.js` | `server` / `500` | `EpiphyAudio v5.7` (standalone scheduler; internal logic not for cross-module reuse) |
| **L3 Gameplay** | `拆解台-混沌殉爆.v18.js` & `合成表-*` | `server` / `10` | Meltdown progression (hard-requiring Core/WorldOps/Danmaku; persisted countdown, anti-spoof relic & mainhand pickaxe check) |
| **L4 Client** | `屏幕弹幕渲染器` / `音频播放器` / `拆解台描述` | `client` | `ScreenDanmakuClient v5.7`, `EpiphyAudioClient v5.6` |

### 3. Dependency & Fallback Specification (YAML)

```yaml
# ==================== Layer 1 · Startup ====================
Epiphy的-Spec与通用工具.js:
  requires: { hard: [], optional: [] }
  on_missing:
    - EpiphyServerBase and client engines fall back to slim built-in helpers
    - Server danmaku and audio engines refuse to boot without hard dependency

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
Epiphy的-屏幕弹幕组件.js:
  requires:
    hard:     [EpiphySpec, EpiphyProtocol, EpiphyServerBase]
    paired:   [Epiphy的-屏幕弹幕渲染器.js]
    optional: [EpiphyLog, EpiphyBlockTracker, EpiphyPermissionValve]
  on_missing:
    no_client: Server API works normally with no client rendering
    optional:  Each optional module triggers a clean single-layer fallback

Epiphy的-音频组件.js:
  requires:
    hard:     [EpiphySpec, EpiphyProtocol, EpiphyServerBase]
    paired:   [Epiphy的-音频播放器.js]
    optional: [EpiphyLog, EpiphyBlockTracker, EpiphyPermissionValve]
  on_missing:
    no_client: Server handles run normally with no client audio output
    optional:  Each optional module triggers a clean single-layer fallback
  note:     L3 schedulers (ScreenDanmaku / EpiphyAudio) must only be consumed via their public global APIs; internal logic cannot be reused across modules

拆解台-混沌殉爆.v18.js:
  requires:
    hard:     [Epiphy的小玩意-终极拆解台_不稳定.js, EpiphyServerCore, EpiphyWorldOps, ScreenDanmaku]
    optional: [EpiphyAudio, kubejs/assets/epiphy/ lang & assets]
  on_missing: Throws Fail-Fast on load if any hard dependency is missing (no redundant gameplay-layer fallbacks)

# ==================== Layer 4 · Client ====================
Epiphy的-屏幕弹幕渲染器.js:
  requires: { paired: [ScreenDanmaku], optional: [EpiphySpec, EpiphyProtocol] }
  on_missing: Uses built-in v5 protocol constants & basic helpers when Startup Spec is absent

Epiphy的-音频播放器.js:
  requires: { paired: [EpiphyAudio], optional: [EpiphySpec, EpiphyProtocol] }
  on_missing: Uses built-in v5 protocol constants & basic helpers when Startup Spec is absent
```

---

## Core Capabilities

1. **Shared Infrastructure & External `epiphy-data/` Storage**:
   - Centralized protocol constants and argument parsers (`EpiphySpec`), rate-limited logging with external readable `.log` rotation & KubeJS `ClassFilter` fallback (`EpiphyLog v1.2`: `daily`/`hourly`/`single`/`off` via `epiphy-data/config/logging.json`, routing runtime logs to per-world `worlds/<slug>__<shortId>/logs/`), server accessors (fail-closed `resolveLevel`, Rhino-safe Java POJO probes, anti-spoof `findPlayerItem`/`isHoldingMainHand`, and persistent `worlds_index.json`) & `corrupt`-only `.tmp` + `.bak` recovery + scope-propagating Brigadier DSL (`EpiphyServerCore / EpiphyServerBase v2.4`), and progressive chunk-section block tracking with 3-tier cost-gated terrain batch engine (`EpiphyBlockTracker / EpiphyWorldOps v2.3`, featuring `cylinder2D` upper-cylinder/lower-hemisphere fluid purge, `excludeLava` ring protection, and bedrock/container guards).
   - External runtime root `<gameDir>/epiphy-data/` (`config/`, `worlds/`, `players/`, `events/`, `logs/`, `presets/`, `backups/`). Worlds bind via save-local `epiphy_world_id.json` and external `<slug>__<shortId>/meta.json`, automatically forking a fresh world folder when `lastWorldPath` changes (e.g., copied test saves) and notifying OPs on join.
   - **Permissions & Anti-Rollback Hardening (`EpiphyPermissionValve v5.3`)**: `Class.isInstance`-verified command dispatch with hierarchical permission scopes (allowing individual subcommands like `danmaku.self` or `audio.play` to be granted to non-OPs, child revocations overriding parent module grants, and `exactScopeOnly` broadcast gates for `danmaku.broadcast` / `audio.broadcast`), default strict UUID mode (explicitly documenting offline-server risks without TrueUUID or password-login plugins), external `revocations.json` tombstones blocking save-rollback resurrection, and Fail-Closed `auth_mode.json` requiring real OP/console 2-step confirmation via `/epiphy auth namegrant enable|confirm` (plus `scopes`, `grantname`, `revokename`, `where`, `reload`), hardened with prototype-key filtering, null `getContext()` source fallback, and synced `at`/`atMs` post-revocation timestamps.
   - **Diagnostics & Standalone Fix**: Live health/perf inspector (`EpiphyDebug v1`) and standalone server-authoritative logout HP restoration (`EpiphyBugfix v1`).
2. **Audiovisual Presentation Engines (with Non-OP Player Resource Isolation)**:
   - **Screen Danmaku (`ScreenDanmaku v5.6` / `ScreenDanmakuClient v5.7`)**: Normalized coordinates with HUD zone avoidance, typewriter reveals (cursor blink preserves line caches), `per_char` glyph shake (adjacent static-run merging, $O(\text{visible})$ range search, viewport bounds culling, steady-state snapshot, bit-mix hash + trig LUT, full `ZWJ`/flag/Extend grapheme clustering, FIFO glyph width eviction, direct unit rotation param, frame-cached `sAllowShadow` & shared `itemFgMat`/`itemOutMat`, strictly-invariant `rCtx`, and priority-ordered anti-flicker rendering), outlines/glow, inline rich tags (`<b>`, `<big>`, `<scale=...>`, `<shake>`, `<outline>`, keeping crisp `MODE_NORMAL(0)` on `<shake>`-only spans), dedicated `ModernUI (LGPL-3.0)` fast-path optimizations with automatic vanilla fallback (`lookupVanillaLayout(String)` zero `Text.of` allocation, canary `MUI_EPOCH` invalidation, whole-paragraph `measureWholeLineWidthPx` wrap shortcut, opt-in 1-pass `'mui_stroke'`/`'sdf_stroke'` via `drawTextOutline` falling back to `'stroke'` on emoji/vanilla, 3-pass `drawUnitsPassGrouped`, renewal metric reuse; plus `action`-based control packet preservation on queue overflow, late tracker upgrade, server `inDimension` 0-player/cooldown early skip, POJO-safe option check, and 128-group `recentPos` bound), `once`/`active` lifecycles with cooldown recovery after batch/ModernUI faults, persisted/login-delayed emission, and namespace-isolated block bindings. Adds `/epiphy danmaku self` for individual player banners; non-OP `authorized` commands stay in `'player'` tier with parameter/rate/target (`>4` targets or cross-dim requires `danmaku.broadcast`) clamping, client queue/frame caps, and per-namespace limits (`16`), while JS API, OP, console, and command blocks remain unrestricted.
   - **Spatial Audio (`EpiphyAudio v5.6` / `EpiphyAudioClient v5.6`)**: Fixed coordinate, block, tracked entity, dimension, and server-wide handles; attenuation curves; live 3D `Channel` selfPosition syncing; `pause` standby on category mute/out-of-range; coalesced scan `merge` cluster consolidation; namespace-filtered gentle `pause`/`unpause` vanilla music ducking (`duckMusic` pauses only `minecraft:` `MUSIC` channels, preserves `duckedMusicInsts` when `chanMap` is transiently null, and never pauses or stops other mods' BGM); validated `configure`; unstarted timeout cleanup; late tracker upgrade; and retry-safe `pendingReset`. Non-OP `authorized` commands enter `'player'` tier (`priority <= 3`, `u:<uuid>:` key prefix, `audio.broadcast` required for `>4` targets or cross-dim, and one-way eviction protecting `'system'` audio).
3. **Gameplay Content & Tweaks**: `epiphy:stuff` creative tab and hidden-item collection (including Chaos Crystal CCL 3D OBJ + Chaos Shader rendering), `epiphy:rnfmabj_test` broadcast test block, the 5-stage Twilight Forest Uncrafting Table chaotic meltdown event with supreme-relic exemptions, and recipe adjustments.

---

## Repository Layout

```text
.
├── kubejs/
│   ├── assets/epiphy/            # Sound assets (.ogg, see docs/audio-assets.md), models, textures, blockstates, zh_cn lang
│   ├── client_scripts/           # Client danmaku renderer, audio player, custom item tooltips
│   ├── server_scripts/           # Server foundation, valve/debug/bugfix, danmaku/audio schedulers, gameplay scripts
│   └── startup_scripts/          # Startup Spec/Protocol base, item/block/creative-tab registrations
├── docs/
│   ├── audio-assets.md                           # Audio asset exclusion & BYO placement notes
│   └── kube-mods-rhino-es5-es6-compatibility.md  # Bytecode & runtime audit of kube-mods/rhino
├── tests/
│   └── pure_functions.test.js    # Node.js sandbox & pure-function test suite
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

### Running Sandbox Unit Tests
```bash
npm test
```

> **Note**: Node.js (V8) only validates pure JS logic and mocked contracts. In-game execution runs on a customized `kube-mods/rhino` interpreter; always consult [`docs/kube-mods-rhino-es5-es6-compatibility.md`](docs/kube-mods-rhino-es5-es6-compatibility.md) and verify in-game after syntax, Java interop, or rendering edits.

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
