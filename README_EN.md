# Epiphy KubeJS Components & Scripts (`epiphy-kubejs-components`)

[中文 (默认)](README.md) · [English](README_EN.md) · [LLM Engineering Guide](README-LLM.md) · [License (RAL 1.6)](LICENSE.md)

A collection of shared server/client infrastructure modules, audiovisual presentation engines (screen danmaku + 3D spatial audio), gameplay bugfixes, and modpack customization scripts built for **Minecraft 1.20.1 / Forge 47.x / KubeJS 2001.6.x**.

> **Status, Roadmap & Platform Notes**
> - **Early Testing Notice (⚠️ Unstable)**: This project is currently in an **early testing stage**. APIs, data schemas, command syntax, and module boundaries are not yet frozen — **current behavior may be unstable and major breaking changes can occur frequently**. Not recommended for production worlds requiring strict long-term stability yet.
> - **Migration Direction**: Once stabilized and feature-complete, this project will transition to **Kotlin + Java** native mod development, with most features becoming standalone modules; **KubeJS is a transitional dependency prior to that migration**.
> - **Loader Compatibility**: Currently tested on **Forge 47.x**. Apart from a small number of Forge-specific compatibility hooks, the core design is **theoretically compatible with Fabric as well**, though **untested on Fabric**.

---

## Engineering Architecture & Module Dependencies

### Layered Architecture Overview

```text
[Layer 1 · Startup Stage: Cross-Side Contracts & Registrations]
├── Epiphy的-Spec与通用工具.js          (P:1200) -> Exports EpiphySpec / EpiphyProtocol (shared source of truth)
├── 创造模式栏-epiphy.js                (P:1000) -> Exports EpiphyCreativeTab (epiphy:stuff)
├── Epiphy的小玩意-原版_其他Mod的隐藏物品.js      <- Depends on [Creative Tab]
├── Epiphy的小玩意-终极拆解台_不稳定.js           <- Paired with [Meltdown v18] & assets/epiphy/
└── Epiphy的小玩意_功能测试.js                    <- Integrates [Creative Tab] + [ScreenDanmaku] + [EpiphyAudio]

[Layer 2 · Server Foundation Layer: Core Infrastructure]
├── Epiphy的-日志.js                    (P:1100) -> Exports EpiphyLog (standalone rate-limited logging hub)
├── Epiphy的-服务端基础.js              (P:1080) -> Exports EpiphyServerBase (optional: Spec / Log)
├── Epiphy的-方块追踪组件.js            (P:1050) -> Exports EpiphyBlockTracker v2 (optional: Log)
├── Epiphy的-权限阀.js                  (P:1000) -> Exports EpiphyPermissionValve v4 (hard: ServerBase; optional: Log)
├── Epiphy的-调试组件.js                (P:950)  -> Exports EpiphyDebug v1 (optional: Log / PermissionValve)
└── Epiphy的-基础bug修复.js             (P:900)  -> Exports EpiphyBugfix v1 (zero hard deps; optional: Log)

[Layer 3 · Server Scheduling & Gameplay Layer]
├── Epiphy的-屏幕弹幕组件.js            (P:500)  <- Hard: [Spec + ServerBase]; Optional: [Log / BlockTracker / Valve]
├── Epiphy的-音频组件.js                (P:500)  <- Hard: [Spec + ServerBase]; Optional: [Log / BlockTracker / Valve]
├── 拆解台-混沌殉爆.v18.js                       <- Depends on [Unstable Blocks] + [ScreenDanmaku]
└── 合成表-*/*.js                                <- Standalone recipe tweaks for vanilla / target mods

[Layer 4 · Client Rendering & Playback Layer]
├── Epiphy的-屏幕弹幕渲染器.js                   <- Consumes epiphy:screen_danmaku packets (optional startup: Spec)
├── Epiphy的-音频播放器.js                       <- Consumes epiphy:audio packets (optional startup: Spec)
└── 拆解台描述.js                                <- Client item tooltip script
```

> Load order convention: `Startup` loads before `Server` / `Client`; within a stage, higher `Priority` values load earlier (`1200 -> 1100 -> 1080 -> 1050 -> 1000 -> 950 -> 900 -> 500`).

### Module Dependency Matrix

| Script | Stage / Priority | Exports | Hard Dependencies | Optional Dependencies | Missing-Dependency Fallback Behavior |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Epiphy的-Spec与通用工具.js` | `startup` / `1200` | `EpiphySpec`, `EpiphyProtocol` | None | None | If absent, `EpiphyServerBase` and client engines use slim local fallbacks; server danmaku/audio refuse to boot |
| `创造模式栏-epiphy.js` | `startup` / `1000` | `EpiphyCreativeTab` (`epiphy:stuff`) | None | None | If absent, custom items are not grouped into the unified creative tab |
| `Epiphy的小玩意-原版_其他Mod的隐藏物品.js` | `startup` | Hidden/special item registrations | `创造模式栏-epiphy.js` | — | Self-contained item module; relies on vanilla / target mod assets |
| `Epiphy的小玩意_功能测试.js` | `startup` | Test block `epiphy:rnfmabj_test` | `创造模式栏-epiphy.js` | `ScreenDanmaku`, `EpiphyAudio` | Block still registers without danmaku/audio, without audiovisual triggers |
| `Epiphy的小玩意-终极拆解台_不稳定.js` | `startup` | 5-stage unstable block registrations | `kubejs/assets/epiphy/` textures & models | — | Paired with `拆解台-混沌殉爆.v18.js` |
| `Epiphy的-日志.js` | `server` / `1100` | `EpiphyLog` | None | None | Downstream modules fall back to native `console`, losing unified rate-limiting & per-module debug switches |
| `Epiphy的-服务端基础.js` | `server` / `1080` | `EpiphyServerBase` | None | `EpiphySpec`, `EpiphyLog` | Falls back to slim dim/array helpers without `EpiphySpec`, and rate-limited `console` without `EpiphyLog` |
| `Epiphy的-方块追踪组件.js` | `server` / `1050` | `EpiphyBlockTracker v2` | None (KubeJS events & `JsonIO`) | `EpiphyLog` | If this module is absent, `bindBlock` in danmaku/audio degrades to basic place/break listeners (no chunk scan or persistence) |
| `Epiphy的-权限阀.js` | `server` / `1000` | `EpiphyPermissionValve v4` | `EpiphyServerBase` | `EpiphyLog` | If absent, `/epiphy` subcommands do not mount while JS APIs remain callable |
| `Epiphy的-调试组件.js` | `server` / `950` | `EpiphyDebug v1` | KubeJS server `global` lifecycle | `EpiphyLog`, `EpiphyPermissionValve` | Without the valve, `/epiphy debug` is unmounted while metrics remain readable via `global.EpiphyDebug` |
| `Epiphy的-基础bug修复.js` | `server` / `900` | `EpiphyBugfix v1` | None (standalone) | `EpiphyLog` | Falls back to built-in rate-limited `console` output when `EpiphyLog` is absent |
| `Epiphy的-屏幕弹幕组件.js` | `server` / `500` | `ScreenDanmaku v5` | `EpiphySpec`, `EpiphyProtocol`, `EpiphyServerBase`; client `ScreenDanmakuClient` | `EpiphyLog`, `EpiphyBlockTracker`, `EpiphyPermissionValve` | Without client renderer, server API runs without client display; optional dependencies degrade cleanly |
| `Epiphy的-屏幕弹幕渲染器.js` | `client` | `ScreenDanmakuClient v5` | Server `ScreenDanmaku` packet stream | `EpiphySpec` / `EpiphyProtocol` | Falls back to built-in v5 protocol constants & basic helpers when startup Spec is absent |
| `Epiphy的-音频组件.js` | `server` / `500` | `EpiphyAudio v5.2` | `EpiphySpec`, `EpiphyProtocol`, `EpiphyServerBase`; client `EpiphyAudioClient` | `EpiphyLog`, `EpiphyBlockTracker`, `EpiphyPermissionValve` | Without client player, server handles schedule silently; optional dependencies degrade cleanly |
| `Epiphy的-音频播放器.js` | `client` | `EpiphyAudioClient v5.2` | Server `EpiphyAudio` packet stream | `EpiphySpec` / `EpiphyProtocol` | Falls back to built-in v5 protocol constants & basic helpers when startup Spec is absent |
| `拆解台-混沌殉爆.v18.js` | `server` | Chaotic meltdown mechanic | `Epiphy的小玩意-终极拆解台_不稳定.js`, `ScreenDanmaku` | `kubejs/assets/epiphy/` lang/assets | Integrates with Twilight Forest, Avaritia, Enigmatic Legacy, Goety Revelation |
| `合成表-*/*.js` & `拆解台描述.js` | `server` / `client` | Recipe tweaks & tooltips | Corresponding vanilla/target mods | — | Independent content scripts |

---

## Core Capabilities

1. **Shared Infrastructure**: Centralized protocol constants and argument parsers (`EpiphySpec`), rate-limited/deduplicated logging (`EpiphyLog`), server accessors & Brigadier DSL (`EpiphyServerBase`), progressive chunk-section block tracking (`EpiphyBlockTracker`), `Class.isInstance`-verified `/epiphy` command routing and per-world permissions (`EpiphyPermissionValve`), live diagnostics (`EpiphyDebug`), and standalone server-authoritative logout HP restoration (`EpiphyBugfix`).
2. **Audiovisual Presentation Engines**:
   - **Screen Danmaku (`ScreenDanmaku v5`)**: Normalized coordinates with HUD zone avoidance, typewriter reveals, `per_char` glyph shake, outlines/glow, inline rich tags (`<b>`, `<big>`, `<scale=...>`, `<shake>`, `<outline>`), `once`/`active` lifecycles, and block bindings.
   - **Spatial Audio (`EpiphyAudio v5.2`)**: Fixed coordinate, block, tracked entity, dimension, and server-wide handles; attenuation curves; out-of-range mute/resume; `merge` cluster consolidation; vanilla music ducking (`duckMusic`); and client reconnect backoff.
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
3. In-game (OP required for admin actions), use `/epiphy help`, `/epiphy auth list`, and `/epiphy debug`.

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
