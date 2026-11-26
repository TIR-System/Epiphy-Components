# Epiphy Core (`epiphy`) — Native Audiovisual & Hardened Server Infrastructure Mod for Minecraft 1.20.1

[中文 (默认)](README.md) · [English](README_EN.md) · [Native Mod Migration Plan](docs/native-mod-migration-plan.md) · [Rendering Subsystem Spec](docs/rendering-subsystem-roadmap.md) · [LLM Engineering Guide](README-LLM.md) · [License (RAL 1.6)](LICENSE.md)

A standalone native mod (**Kotlin 2.2.21 + Java 17**) built for **Minecraft 1.20.1 · Forge 47.2+ · Kotlin for Forge 4.12.0+ · Sinytra MixinBooster**.  
Provides a declarative 2D/3D presentation pipeline, off-screen FBO cache pools, container GUI/slot sandwich hooks, zero-pollution texture remapping, zero-`CodeChickenLib` 3D item rendering hooks, zero-reflection OpenAL 3D audio accessors, and a fault-tolerant external server storage engine.

> [!IMPORTANT]
> **Branch Layout & Compatibility Policy**
> 1. **Legacy Pure-KubeJS Archive**: All transitional pure-KubeJS scripts and V8 sandbox tests are permanently archived on the **`legacy-kubejs`** branch (tag `v6.3.0-kubejs-eol`). **`main` is now the root repository for the standalone native mod.**
> 2. **No Coexistence Period & One-Way Upgrade**: Once the native mod releases, the pure KubeJS version immediately enters **EOL** (no Maintenance LTS). **Downgrading data from the native mod back to legacy KubeJS scripts is NOT guaranteed** — please back up saves and `epiphy-data/` beforehand.
> 3. **Calling Native Core from KubeJS**: When KubeJS is installed, `epiphy` automatically exposes the `EpiphyNative` gateway. Calling native mod APIs from KubeJS scripts remains our recommended, widely supported scripting workflow (incompatible legacy edge behaviors will not be specially back-patched).
> 4. **Forge Only**: Targets `Forge 47.2+` and `Kotlin for Forge`. **No Fabric version is planned.**

---

## Project Structure & Core Capabilities

```text
.
├── epiphy-api/               # Pure public contracts (zero Minecraft/Forge deps, fast JUnit 5 suite)
│   └── dev.epiphy.api.*      #   PROTO v6 contracts, <=2 official alias normalizer, BoundedCache (FIFO/LRU), PresetRegistry, SemVer
├── epiphy-core/              # Primary native mod (isolated main vs compat SourceSets, single reobfJar output)
│   ├── src/main/             #   [Zero third-party mod compile classpath]
│   │   ├── dev.epiphy.core.* #     AtomicJsonStore (fsync/.bak recovery/corrupt lock), EpiphyDataManager (save fork), Async Log, RollingNanoSampler
│   │   ├── dev.epiphy.client.*#    FboCachePool (premultiplied alpha), GuiInterceptionHooks, ui_masked_fill shader, Item3DRenderHooks, NativeAudioClientAccess
│   │   └── dev.epiphy.mixin.*#     Pure Java 17 Mixins (MixinBooster guard, container 4-phase sandwich, innerBlit remap, ItemRenderer, Sound*Accessor)
│   └── src/compat/           #   [Optional soft-compat SourceSet: compileOnly(KubeJS / ModernUI / Curios)]
│       └── compat.kubejs.*   #     EpiphyKubeJSPlugin exposing the clean single root gateway `EpiphyNative`
├── epiphy-showcase/          # Optional standalone showcase addon (excluded from core release JAR)
└── docs/                     # Authoritative PROTO v6 Schema (proto_v6_schema.json), roadmaps & migration plan
```

---

## Runtime Requirements & Building

- **Required**: `Minecraft 1.20.1` · `Forge 47.2.20+` · `Kotlin for Forge 4.12.0+` · `Sinytra MixinBooster 0.1.3+` (`MixinExtras` is embedded via Jar-in-Jar)
- **Optional Soft-Compat**: `KubeJS 2001.6.5+` · `ModernUI` · `Curios API`

### Build & Verification Gates (JDK 17)
```bash
./gradlew check build
```

`check` enforces four automated engineering gates:
1. `ProtoV6ContractAndAliasTest`: Verifies parity against [`docs/proto_v6_schema.json`](docs/proto_v6_schema.json) and the `<= 2` official aliases rule;
2. `CoreInfrastructureRobustnessTest`: Fault-injection I/O tests for `.bak` self-healing, corrupt write-lock quarantine, copied-world auto-forking, async log rate-limiting, and rolling P95/Max nano samplers;
3. `BytecodeSafetyGuardTest`: ASM bytecode inspection ensuring `EpiphyMod.class` has zero client-only references (Dedicated Server safe) and `PoseStack.withPose` emits a real `finally` exception handler;
4. `verifyNoBundledKotlin`: Fails the build if any `kotlin/` or `kotlinx/` stdlib classes leak into the built JAR.

---

## Authors & License

- **Epiphy-iLLUMs**: Creator, Gameplay Design, Lead Maintainer; core architecture, feature design & implementation.
- **Gemini 4 series** / **Claude 5.5 series**: Architecture Collaboration, Implementation & Optimization.
- **DeepSeek**: Mascot.

Licensed under **RAL 1.6 (Reciprocal Attribution License 1.6)** — see [`LICENSE.md`](LICENSE.md) for the authoritative Chinese text.

> [!TIP]
> **No License Declaration Required for Downstream KubeJS `.js` Scripts**  
> Because KubeJS `.js` scripts are inherently distributed as plain source files directly downloaded to players' computers, **downstream `.js` scripts built on KubeJS and Epiphy components do NOT need to declare a license**.
