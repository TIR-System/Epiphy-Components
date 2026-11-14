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
│  P:1080  Epiphy的-服务端基础.js   ──► EpiphyServerBase    (opt: Spec / Log)       │
│  P:1050  Epiphy的-方块追踪组件.js ──► EpiphyBlockTracker  (opt: Log)              │
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
| **L2 Infrastructure** | `Epiphy的-日志.js` | `server` / `1100` | `EpiphyLog v1.1` (rate-limit, `once`, `catchWarn`, external `.log` sink) |
| **L2 Infrastructure** | `Epiphy的-服务端基础.js` | `server` / `1080` | `EpiphyServerBase v2` (accessors, `epiphy-data/`, world fork, DSL) |
| **L2 Infrastructure** | `Epiphy的-方块追踪组件.js` | `server` / `1050` | `EpiphyBlockTracker v2` (section scanning) |
| **L2 Access Control** | `Epiphy的-权限阀.js` | `server` / `1000` | `EpiphyPermissionValve v5` (`/epiphy`, tombstones, fail-closed auth) |
| **L2 Diagnostics** | `Epiphy的-调试组件.js` | `server` / `950` | `EpiphyDebug v1` (`/epiphy debug`) |
| **L2 Standalone Fix** | `Epiphy的-基础bug修复.js` | `server` / `900` | `EpiphyBugfix v1` (logout HP restoration) |
| **L3 Presentation** | `Epiphy的-屏幕弹幕组件.js` | `server` / `500` | `ScreenDanmaku v5.1` |
| **L3 Presentation** | `Epiphy的-音频组件.js` | `server` / `500` | `EpiphyAudio v5.3` |
| **L3 Gameplay** | `拆解台-混沌殉爆.v18.js` & `合成表-*` | `server` | Meltdown progression & recipe tweaks |
| **L4 Client** | `屏幕弹幕渲染器` / `音频播放器` / `拆解台描述` | `client` | `ScreenDanmakuClient v5.1`, `EpiphyAudioClient v5.3` |

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

Epiphy的-服务端基础.js:
  requires: { hard: [], optional: [EpiphySpec, EpiphyLog] }
  on_missing:
    no_EpiphySpec: Enables built-in slim dimension/array helpers
    no_EpiphyLog:  Logger wrapper falls back to built-in rate-limited console

Epiphy的-方块追踪组件.js:
  requires: { hard: [], optional: [EpiphyLog] }
  on_missing: Downstream bindBlock degrades to basic place/break listeners (no chunk scan or persistence)

Epiphy的-权限阀.js:
  requires: { hard: [EpiphyServerBase], optional: [EpiphyLog] }
  on_missing: /epiphy subcommands do not mount (OP notified on login); JS APIs remain usable

Epiphy的-调试组件.js:
  requires: { hard: [KubeJS server global lifecycle], optional: [EpiphyLog, EpiphyPermissionValve] }
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

拆解台-混沌殉爆.v18.js:
  requires:
    hard:     [Epiphy的小玩意-终极拆解台_不稳定.js, ScreenDanmaku]
    optional: [kubejs/assets/epiphy/ lang & assets]

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
   - Centralized protocol constants and argument parsers (`EpiphySpec`), rate-limited logging with external readable `.log` rotation (`EpiphyLog v1.1`: `daily` default, `hourly` / `single` / `off` via `epiphy-data/config/logging.json`), server accessors & atomic `.tmp` + `.bak` storage + Brigadier DSL (`EpiphyServerBase v2`), and progressive chunk-section block tracking (`EpiphyBlockTracker v2`).
   - External runtime root `<gameDir>/epiphy-data/` (`config/`, `worlds/`, `players/`, `events/`, `logs/`, `presets/`, `backups/`). Worlds bind via save-local `epiphy_world_id.json` and external `<slug>__<shortId>/meta.json`, automatically forking a fresh world folder when `lastWorldPath` changes (e.g., copied test saves) and notifying OPs on join.
   - **Permissions & Anti-Rollback Hardening (`EpiphyPermissionValve v5`)**: `Class.isInstance`-verified command dispatch, default strict UUID mode (explicitly documenting offline-server risks without TrueUUID or password-login plugins), external `revocations.json` tombstones blocking save-rollback resurrection, and Fail-Closed `auth_mode.json` requiring real OP/console 2-step confirmation (8-char `[0-9A-Za-z]` token valid for 2 minutes) via `/epiphy auth namegrant enable|confirm` (plus `grantname`, `revokename`, `where`, `reload`).
   - **Diagnostics & Standalone Fix**: Live health/perf inspector (`EpiphyDebug v1`) and standalone server-authoritative logout HP restoration (`EpiphyBugfix v1`).
2. **Audiovisual Presentation Engines (with Non-OP Player Resource Isolation)**:
   - **Screen Danmaku (`ScreenDanmaku v5.1`)**: Normalized coordinates with HUD zone avoidance, typewriter reveals, `per_char` glyph shake, outlines/glow, inline rich tags (`<b>`, `<big>`, `<scale=...>`, `<shake>`, `<outline>`), `once`/`active` lifecycles, and block bindings. Non-OP `authorized` player commands are classified as `'player'` tier with parameter clamping (priority/scale/length/lines/stay/radius), 250ms cooldown, `u:<uuid>` namespace lock on `stop`/`clear`, and a client per-namespace cap (`16`); JS API, OP, console, and command blocks stay unrestricted.
   - **Spatial Audio (`EpiphyAudio v5.3`)**: Fixed coordinate, block, tracked entity, dimension, and server-wide handles; attenuation curves; out-of-range mute/resume; `merge` cluster consolidation; vanilla music ducking (`duckMusic`); and client reconnect backoff. Non-OP `authorized` player commands enter `'player'` tier (`priority <= 3`, `u:<uuid>:` key prefix, global/creator/listener quotas reserving `>= 4/12` listener slots for `'system'`, and one-way server/client eviction protecting `'system'` audio).
3. **Gameplay Content & Tweaks**: `epiphy:stuff` creative tab and hidden-item collection (including Chaos Crystal CCL 3D OBJ + Chaos Shader rendering), `epiphy:rnfmabj_test` broadcast test block, the 5-stage Twilight Forest Uncrafting Table chaotic meltdown event with supreme-relic exemptions, and recipe adjustments.

---

## Repository Layout

```text
.
├── kubejs/
│   ├── assets/epiphy/            # Audio assets (.ogg/.mp3), models, textures, blockstates, zh_cn lang
│   ├── client_scripts/           # Client danmaku renderer, audio player, custom item tooltips
│   ├── server_scripts/           # Server foundation, valve/debug/bugfix, danmaku/audio schedulers, gameplay scripts
│   ├── startup_scripts/          # Startup Spec/Protocol base, item/block/creative-tab registrations
│   └── config/                   # KubeJS properties
├── docs/
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
- **Incompatible Licenses**: Conflicting non-forkable licenses (e.g., PolyForm Shield 1.0.0) are barred from inclusion or bridging.
