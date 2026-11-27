# Epiphy Core (`epiphy`) — Native Audiovisual & Server Infrastructure Mod for Minecraft 1.20.1

[中文 (默认)](README.md) · [English](README_EN.md) · [AI Engineering Charter](AGENTS.md) · [Native Mod Migration Plan](docs/native-mod-migration-plan.md) · [Rendering Subsystem Spec](docs/rendering-subsystem-roadmap.md) · [LLM Handover Guide](README-LLM.md) · [License (RAL 1.6)](LICENSE.md)

A standalone native mod (**Kotlin 2.2.21 + Java 17**) built for **Minecraft 1.20.1 · Forge 47.2+ · Kotlin for Forge 4.12.0+ · Sinytra MixinBooster**.  
Provides a declarative 2D/3D presentation pipeline, off-screen FBO cache pools, container GUI/slot sandwich hooks, `innerBlit` texture remapping, native 3D item rendering layers without `CodeChickenLib`, compile-time Mixin `@Accessor` OpenAL 3D audio controls, an in-game configuration screen, and an external JSON storage layer with backup recovery and save-copy fork detection.

> [!IMPORTANT]
> **Branch Layout & Compatibility Policy**
> 1. **Legacy Pure-KubeJS Archive**: Transitional pure-KubeJS scripts and V8 sandbox tests are archived on the **`legacy-kubejs`** branch (tag `v6.3.0-kubejs-eol`). **`main` is the primary repository for the standalone native mod.**
> 2. **No Coexistence Period & One-Way Upgrade**: Once the native mod releases, the pure KubeJS version enters **EOL** (no Maintenance LTS). **Downgrading data from the native mod back to legacy KubeJS scripts is NOT guaranteed** — please back up saves and `epiphy-data/` beforehand.
> 3. **Calling Native Core from KubeJS**: When KubeJS is installed, `epiphy` exposes the `EpiphyNative` gateway. Calling native mod APIs from KubeJS scripts remains a supported scripting workflow (incompatible legacy edge behaviors will not be specially back-patched).
> 4. **Forge Only**: Targets `Forge 47.2+` and `Kotlin for Forge`. **No Fabric version is planned.**

---

## Project Structure & Core Subsystems

```text
.
├── AGENTS.md                 # AI collaboration charter (mechanism-first workflow, neutral comment & telemetry rules)
├── epiphy-api/               # Public contracts (no Minecraft/Forge compile dependencies)
│   └── dev.epiphy.api.*      #   PROTO v6 contracts, <=2 official alias normalizer, BoundedCache (FIFO/LRU), PresetRegistry, SemVer
├── epiphy-core/              # Primary native mod (isolated main vs compat SourceSets, single reobfJar output)
│   ├── src/main/             #   [Core SourceSet: free of third-party gameplay mod dependencies]
│   │   ├── dev.epiphy.core.* #     AtomicJsonStore (fsync/.bak recovery/corrupt lock), EpiphyDataManager (save fork), Async Log, RollingNanoSampler
│   │   ├── dev.epiphy.client.*#    FboCachePool (premultiplied alpha), NativeTextBatchEngine (atlas-bucketed text), GuiInterceptionHooks, Config UI
│   │   └── dev.epiphy.mixin.*#     Java 17 Mixins (MixinBooster check, container 4-phase hooks, innerBlit remap, ItemRenderer, Sound*Accessor)
│   └── src/compat/           #   [Optional soft-compat SourceSet: compileOnly(KubeJS / ModernUI / Curios)]
│       ├── compat.kubejs.*   #     EpiphyKubeJSPlugin exposing the root gateway `EpiphyNative`
│       └── compat.modernui.* #     ModernUiGlyphCaptureBackend for version-adaptive optional SDF glyph capture
└── docs/                     # PROTO v6 Schema (proto_v6_schema.json), roadmaps, migration plan & historical archives
```

---

## Runtime Requirements & Building

- **Required**: `Minecraft 1.20.1` · `Forge 47.2.20+` · `Kotlin for Forge 4.12.0+` · `Sinytra MixinBooster 0.1.3+` (`MixinExtras` is embedded via Jar-in-Jar)
- **Optional Soft-Compat**: `KubeJS 2001.6.5+` · `ModernUI` · `Curios API`

### Build & Verification Gates (JDK 17)
```bash
./gradlew check build
```

`check` runs six automated verification gates:
1. `ProtoV6ContractAndAliasTest`: Checks parity against [`docs/proto_v6_schema.json`](docs/proto_v6_schema.json), enforces the `<= 2` official aliases limit, and verifies SemVer 2.0 numeric pre-release ordering;
2. `EngineeringCharterGuardTest`: Enforces dynamic reverse case-isolation, declarative neutral comment/doc tone, boundary documentation on core engine classes, and `mod_version` single-source-of-truth parity;
3. `CoreInfrastructureRobustnessTest`: Fault-injection I/O tests for `.bak` recovery, world-anchor backup healing, corrupt write-lock quarantine, copied-world auto-forking, external security path enforcement, async log switches, and monotonic drop counters;
4. `ClientSubsystemsRegressionTest`: Headless regression suite covering `PoseStackWatermark` overflow/underflow recovery, `RenderFaultCircuitBreaker` fatal `Error` passthrough and tripping, `Screen`-scoped GUI texture remaps, `NativeTextBatchEngine` multi-atlas bucketing ($== K$), `NativeItem3DBridge` explicit `BlendMode` and bind status codes, and `NativeAudioClientAccess` async channel stop tracking;
5. `BytecodeSafetyGuardTest`: ASM bytecode inspection verifying `EpiphyMod.class` and `EpiphyConfig.class` carry no direct client-only class references, `PoseStack.withPose` emits a JVM `finally` handler, and bootstrap/KubeJS entrypoints invoke no `java.lang.reflect` APIs;
6. `verifyNoBundledKotlin`: Inspects both thin and `-all.jar` artifacts to ensure zero bundled `kotlin/` or `kotlinx/` stdlib classes, mandatory `mixinbooster` dependency in `mods.toml`, and complete Mixin obfuscation entries in `epiphy.refmap.json`.

---

## Authors & License

- **Epiphy-iLLUMs**: Creator, Gameplay Design, Lead Maintainer; core architecture, feature design & implementation.
- **Gemini 4 series** / **Claude 5.5 series**: Architecture Collaboration, Implementation & Optimization.
- **DeepSeek**: Mascot.

Licensed under **RAL 1.6 (Reciprocal Attribution License 1.6)** — see [`LICENSE.md`](LICENSE.md) for the authoritative Chinese text.

> [!TIP]
> **No License Declaration Required for Downstream KubeJS `.js` Scripts**  
> Because KubeJS `.js` scripts are inherently distributed as plain source files directly downloaded to players' computers, **downstream `.js` scripts built on KubeJS and Epiphy components do NOT need to declare a license**.
