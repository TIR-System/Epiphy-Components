# Epiphy Core (`epiphy`) — Minecraft 1.20.1 原生视听表现与服务端基础设施模组

[中文 (默认)](README.md) · [English](README_EN.md) · [原生迁移工程计划书](docs/native-mod-migration-plan.md) · [渲染子系统规范](docs/rendering-subsystem-roadmap.md) · [LLM 工程准则](README-LLM.md) · [许可证 (RAL 1.6)](LICENSE.md)

面向 **Minecraft 1.20.1 · Forge 47.2+ · Kotlin for Forge 4.12.0+ · Sinytra MixinBooster** 构建的独立原生模组（**Kotlin 2.2.21 + Java 17** 混编）。  
本项目提供声明式 2D/3D 视觉合成管线、离屏 FBO 缓存池、容器 GUI/槽位精准夹心与无污染贴图重映射、零 `CodeChickenLib` 原生物品 3D 特效、零反射 OpenAL 3D 声场桥接，以及带防损坏覆写锁与世界自动分叉的高鲁棒服务端存储底座。

> [!IMPORTANT]
> **分支说明与兼容性契约**
> 1. **历史纯 KubeJS 脚本归档位置**：过渡期的完整纯 KubeJS 脚本与沙盒单测已永久冻结于 **`legacy-kubejs`** 分支（Tag `v6.3.0-kubejs-eol`）；当前 **`main` 分支为独立原生模组主仓库**。
> 2. **无共存期、单向升级**：原生 Mod 正式发布后纯 KubeJS 版直接进入 **EOL**（无共存期、无 Maintenance LTS）；**不保证从原生 Mod 降级回旧 KubeJS 版时数据可读**，升级前请自行备份存档与 `epiphy-data/`。
> 3. **KubeJS 联动推荐模式**：安装 KubeJS 时，本模组会自动激活软兼容插件并暴露顶层网关 **`EpiphyNative`**。以脚本形式调用原生 Mod 接口依然是官方推荐并长期广泛支持的用法（大更新中不兼容的旧版边缘特性不会特意逆向修补）。
> 4. **仅支持 Forge**：基于 `Forge 47.2+` 与 `Kotlin for Forge`，**暂不推出 Fabric 版**。

---

## 工程模块结构与已落地核心能力

```text
.
├── epiphy-api/               # 纯公共契约层（零 Minecraft/Forge 依赖，毫秒级 JUnit 测试）
│   └── dev.epiphy.api.*      #   PROTO v6 契约、官方双别名单点归一化、BoundedCache (FIFO/LRU)、PresetRegistry、SemVer
├── epiphy-core/              # 原生核心主模组（双 SourceSet 物理隔离，产出单一重映射发行 Jar）
│   ├── src/main/             #   [核心层：编译类路径物理隔离，零第三方业务 Mod 依赖]
│   │   ├── dev.epiphy.core.* #     AtomicJsonStore (fsync/.bak自愈/损坏锁)、EpiphyDataManager (复制档自动分叉)、异步限频日志、环形纳秒遥测
│   │   ├── dev.epiphy.client.*#    FboCachePool (预乘Alpha离屏池)、GuiInterceptionHooks、ui_masked_fill 着色器、零CCL物品3D钩子、零反射音频桥接
│   │   └── dev.epiphy.mixin.*#     纯 Java 17 Mixin（MixinBooster守卫、容器四相位夹心、innerBlit贴图重定向、ItemRenderer钩子、Sound*Accessor）
│   └── src/compat/           #   [软兼容层：独占 compileOnly(KubeJS / ModernUI / Curios)，按需动态激活]
│       └── compat.kubejs.*   #     EpiphyKubeJSPlugin：暴露单一克制顶层入口 EpiphyNative，供脚本绑定高性能原生算子
├── epiphy-showcase/          # 可选独立示范附属包（不打入核心发行 Jar）
└── docs/                     # PROTO v6 权威 Schema (proto_v6_schema.json)、渲染路线图与迁移计划书
```

### 核心底座亮点

1. **🛡️ 铁桶级存储、日志与诊断底座 (`dev.epiphy.core.*`)**
   - **`AtomicJsonStore<T>`**：同目录 `.tmp` + `FileChannel.force(true)` 刷盘后原子替换；严格区分“文件未创建”与“文件损坏”（绝不复活已删文件）；正本损坏时自动从 `.bak` 校验自愈，双坏时自动重命名隔离为 `.corrupt.<ts>.bak` 并开启 `corruptLocked` 拒写保护，防止空状态覆盖可抢救数据。
   - **`EpiphyDataManager`**：维护 `<gameDir>/epiphy-data/` 外置安全目录；双向比对存档内 `epiphy_world_id.json` 与外部 `meta.json` 物理路径，复制存档时自动分叉全新 `<slug>__<shortId>` 目录并生成 OP 提醒。
   - **`EpiphyLogEngine` & `EpiphyDebugHub`**：有界队列守护线程异步写盘、滑动窗口限频折叠 `(suppressed N repeats)`、进退档自动切换世界日志目录；配以零分配 `RollingNanoSampler` 环形 P95/Max 耗时采样器与单模块异常隔离自检中心。
2. **⚡ 原生渲染与视听阻塞突破原语 (`dev.epiphy.client.*` & `mixin.*`)**
   - **`FboCachePool`**：按 32px 分桶复用 `TextureTarget` 离屏帧缓冲，使用预乘 Alpha（`GL_ONE, GL_ONE_MINUS_SRC_ALPHA`）根除半透明二次混合黑边，并在 `finally` 中 100% 恢复主帧缓冲。
   - **容器 `gui` / `slot` 真夹心与零污染贴图重映射**：`AbstractContainerScreenMixin` 精确注入 `renderBg` 后、`renderSlot` 前后与前景后四个相位；`GuiGraphicsMixin` 在 `innerBlit` 入口做 O(1) 贴图重映射，彻底告别篡改全局 `TextureManager`。
   - **双采样器蒙版着色器 & 零 CCL 物品 3D & 零反射音频**：内置 GLSL 1.50 `epiphy:ui_masked_fill` 蒙版着色器、`ItemRendererMixin` O(1) 物品 3D 覆层钩子，以及编译期校验的 `SoundEngine`/`SoundManager` `@Accessor`（温和暂停 `minecraft:` BGM，绝不误停他模组音乐）。

---

## 运行前置与构建命令

### 运行时前置
- **必需**：`Minecraft 1.20.1` · `Forge 47.2.20+` · `Kotlin for Forge 4.12.0+` · `Sinytra MixinBooster 0.1.3+`（`MixinExtras` 已通过 Jar-in-Jar 随包内嵌）
- **可选软兼容**（装了自动启用桥接，未装零报错运行）：`KubeJS 2001.6.5+` · `ModernUI` · `Curios API`

### 本地构建与门禁测试
需要 **JDK 17**（Gradle 会自动从 `~/.jdks` 检测）：

```bash
./gradlew check build
```

`check` 任务会自动执行四重硬性门禁：
1. `epiphy-api:test`：直读 [`docs/proto_v6_schema.json`](docs/proto_v6_schema.json) 校验协议字段与「至多 2 个官方别名」契约；
2. `epiphy-core:test` (`CoreInfrastructureRobustnessTest`)：真实文件 I/O 故障注入测试（`.bak` 自愈、双坏防覆写锁、复制存档自动分叉、异步日志限频折叠与环形采样百分位）；
3. `epiphy-core:test` (`BytecodeSafetyGuardTest`)：ASM 扫描编译产物验证 `EpiphyMod.class` 零客户端类引用（Dedicated Server 安全）及 `PoseStack.withPose` 含真实 JVM `finally` 异常表；
4. `epiphy-core:verifyNoBundledKotlin`：扫描构建 Jar 确保零 `kotlin/` 或 `kotlinx/` 标准库字节码打入模组包（杜绝 KFF `LinkageError`）。

---

## 作者与许可证 (Authors & License)

- **Epiphy-iLLUMs**：项目发起人、玩法设计、核心维护者；负责核心功能设计与实现、工程结构制定、模块化构思、纠错与重构方向。
- **Gemini 4 系列** / **Claude 5.5 系列**：架构协助、组件开发、纠错与优化建议。
- **DeepSeek**：吉祥物（Mascot）。

本项目源码与文档适用 **RAL 1.6（Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6）**，完整条款以 [`LICENSE.md`](LICENSE.md) 中文正式文本为准。

> [!TIP]
> **下游 KubeJS `.js` 脚本免许可证声明**  
> 由于 KubeJS 的 `.js` 脚本在整合包分发时原本就需要将明文源码直接下载到玩家的电脑上，因此**基于 KubeJS 和 Epiphy 组件编写的下游 `.js` 脚本无需声明许可证**。
