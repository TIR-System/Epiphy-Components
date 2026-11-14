# Epiphy KubeJS Components & Scripts (`epiphy-kubejs-components`)

[中文 (默认)](README.md) · [English](README_EN.md) · [LLM Engineering Guide](README-LLM.md) · [License (RAL 1.6)](LICENSE.md)

A collection of shared server/client infrastructure modules, audiovisual presentation engines (screen danmaku + 3D spatial audio), gameplay bugfixes, and modpack customization scripts built for **Minecraft 1.20.1 / Forge 47.x / KubeJS 2001.6.x**.

---

## Key Features

### 1. Core Infrastructure (`kubejs/**/通用组件/`)

| Script | Stage / Priority | Responsibilities |
| :--- | :--- | :--- |
| `Epiphy的-Spec与通用工具.js` | `startup` / `1200` | Shared protocol constants (`EpiphyProtocol`), priority/size/duration/color/tilt/command-spec parsers, and sphere merge-cluster geometry (`EpiphySpec`) |
| `Epiphy的-日志.js` | `server` / `1100` | Rate-limited warnings, soft `catchWarn` exception reporting, `once` deduplication, and per-module debug toggles (`EpiphyLog`) |
| `Epiphy的-服务端基础.js` | `server` / `1080` | Java class cache, MC entity/dimension/position helpers, world-scoped storage paths, `createCommandBuilder` Brigadier DSL, and queued command registration (`EpiphyServerBase`) |
| `Epiphy的-方块追踪组件.js` | `server` / `1050` | Server-wide physical block tracking registry with progressive `16×16×16` chunk-section scanning and multi-subscriber persistence (`EpiphyBlockTracker v2`) |
| `Epiphy的-权限阀.js` | `server` / `1000` | Root `/epiphy` command router & help aggregator, `Class.isInstance`-based caller verification (players / OP / command blocks / console / declared script callers), and per-world grant persistence (`EpiphyPermissionValve v4`) |
| `Epiphy的-调试组件.js` | `server` / `950` | `/epiphy debug` live metrics dashboard, health checks, and maintenance action registry (`EpiphyDebug v1`) |
| `Epiphy的-基础bug修复.js` | `server` / `900` | Server-authoritative logout HP preservation & delayed login restoration (prevents vanilla `LivingEntity.setHealth()` from clamping high-max-HP players down to 20 before modded modifiers settle; zero client trust) |

### 2. Audiovisual Presentation Engines

- **Screen Danmaku & Rich Overlay Engine (`ScreenDanmaku v5` + `ScreenDanmakuClient v5`)**
  - Files: `Epiphy的-屏幕弹幕组件.js` (server) + `Epiphy的-屏幕弹幕渲染器.js` (client)
  - Supports normalized coordinates with HUD forbidden-zone avoidance, multi-line typewriter mode, `per_char` glyph shake, stroke/glow outlines, inline rich-text tags (`<b>`, `<big>`, `<scale=...>`, `<shake>`, `<outline>`), `once`/`active` lifecycles, multiple fade styles, and physical block bindings.
- **3D Spatial Audio & Streaming Soundscape (`EpiphyAudio v5.2` + `EpiphyAudioClient v5.2`)**
  - Files: `Epiphy的-音频组件.js` (server) + `Epiphy的-音频播放器.js` (client)
  - Supports coordinate / block / entity-tracking / dimension / server-wide audio handles, attenuation curves, out-of-range mute/resume, `merge` cluster consolidation, vanilla music ducking (`duckMusic`), heartbeat keep-alive, and client reconnect backoff.

### 3. Content, Recipes & Gameplay Events

- **Creative Tab & Hidden Items**: `创造模式栏-epiphy.js` (`epiphy:stuff`) and `Epiphy的小玩意-原版_其他Mod的隐藏物品.js` (barrier, boss spawn eggs, command block variants, itemized portals, Chaos Crystal with CCL 3D OBJ + Chaos Shader rendering, Enigmatic Legacy `cosmic_scroll`, Goety Revelation `halo_of_the_end`, etc.).
- **Functional Test Block**: `Epiphy的小玩意_功能测试.js` (`epiphy:rnfmabj_test` command-broadcasting block for danmaku + audio stress testing).
- **Twilight Forest Uncrafting Table Meltdown v18**: `拆解台-混沌殉爆.v18.js` + `Epiphy的小玩意-终极拆解台_不稳定.js` + `拆解台描述.js` (5-stage 3-minute instability progression, tamper protection, Endest Pearl / Gaping Void emergency shutdown, supreme-relic mining exemptions, and fluid-clearing chaotic detonation).
- **Recipe Tweaks**: `合成表-原版/附魔苹果.js`, `合成表-植物魔法/活木根.js`, `合成表-魔法遗物相关/七咒.js`.

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
1. Target environment: **Minecraft 1.20.1 / Forge 47.x / KubeJS 2001.6.x**.
2. Merge the `kubejs/` directory into your client `.minecraft/` and dedicated server root.
3. In-game (OP required for admin actions), inspect mounted modules with `/epiphy help`, grants with `/epiphy auth list`, and runtime diagnostics with `/epiphy debug`.

### Running Sandbox Unit Tests
Run the Node.js pure-function and command/permission harness tests locally without booting Minecraft:

```bash
npm test
```

> **Note**: Node.js (V8) only validates pure JS logic and mocked KubeJS contracts. In-game execution uses a heavily customized `kube-mods/rhino` interpreter; always cross-check [`docs/kube-mods-rhino-es5-es6-compatibility.md`](docs/kube-mods-rhino-es5-es6-compatibility.md) and verify in-game after syntax, Java interop, or client rendering changes.

---

## Planned Evolution

- Migrate persistent operational data to a unified external `<gameDir>/epiphy-data/` layout (`config/`, `worlds/`, `players/`, `events/`, `logs/`, `presets/`, `backups/`) with `worldId` fingerprinting and automatic save-clone branching to eliminate world-rollback permission resurrection and save-name collisions.
- Enforce UUID-only authorization by default with an explicit dual-entry name-grant fallback switch, plus `system`/`op` vs `player` resource isolation and quota protection in the audio and danmaku modules.

---

## Authors & Contributors

- **Epiphy-iLLUMs** (Creator, Gameplay Design, Lead Maintainer)
- **Gemini 4 series** (Architecture, Component Implementation & Debugging)
- **Claude 5.5 series** (Architecture, Component Implementation & Auditing)

---

## License

Licensed under **RAL 1.6 (Reciprocal Attribution License 1.6)** — see [`LICENSE.md`](LICENSE.md) for the full legal text.

Summary (the Chinese original in [`LICENSE.md`](LICENSE.md) governs in case of ambiguity):
- **Source-Available Reciprocal License**: Preserves modification and fork freedoms while requiring attribution;
- **Strict Reciprocity**: Modifications, derivatives, static linking, and dynamic linking dependencies trigger reciprocal source disclosure; wrapper layers cannot be used to evade obligations;
- **Commercial Boundaries**: Commercial integration as a non-primary component is permitted, **direct standalone resale is prohibited**, and Managed SaaS requires full-stack open source;
- **Incompatible Licenses**: Conflicting non-forkable licenses (e.g., PolyForm Shield 1.0.0) are prohibited from direct inclusion or bridging.
