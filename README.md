# Epiphy Core (`epiphy`) — Minecraft 1.20.1 原生视听表现与服务端基础设施模组

[中文 (默认)](README.md) · [English](README_EN.md) · [AI 协作宪章](AGENTS.md) · [原生迁移工程计划书](docs/native-mod-migration-plan.md) · [渲染子系统规范](docs/rendering-subsystem-roadmap.md) · [跨上下文交接指南](README-LLM.md) · [许可证 (RAL 1.6)](LICENSE.md)

面向 **Minecraft 1.20.1 · Forge 47.2+ · Kotlin for Forge 4.12.0+ · Sinytra MixinBooster** 构建的独立原生模组（**Kotlin 2.2.21 + Java 17** 混编）。  
本项目提供声明式 2D/3D 视觉合成管线、离屏 FBO 缓存池、容器 GUI/槽位夹心注入、按调用重定向的 GUI 贴图重映射、不依赖 `CodeChickenLib` 的原生物品 3D 渲染钩子、基于 Mixin `@Accessor` 的 OpenAL 3D 声源控制，以及带损坏隔离锁与世界分叉检测的外置存储底座。

> [!IMPORTANT]
> **分支说明与兼容性契约**
> 1. **历史纯 KubeJS 脚本归档位置**：过渡期的纯 KubeJS 脚本与沙盒测试已归档于 **`legacy-kubejs`** 分支（Tag `v6.3.0-kubejs-eol`）；当前 **`main` 分支为独立原生模组主仓库**。
> 2. **无共存期、单向升级**：原生 Mod 正式发布后纯 KubeJS 版直接进入 **EOL**（无共存期、无 Maintenance LTS）；**不保证从原生 Mod 降级回旧 KubeJS 版时数据可读**，升级前请先备份存档与 `epiphy-data/`。
> 3. **KubeJS 联动推荐模式**：安装 KubeJS 时，本模组会激活软兼容插件并暴露顶层网关 **`EpiphyNative`**。以脚本形式调用原生 Mod 接口依然是官方推荐并长期支持的用法（大更新中不兼容的旧版边缘特性不会特意逆向修补）。
> 4. **仅支持 Forge**：基于 `Forge 47.2+` 与 `Kotlin for Forge`，**暂不推出 Fabric 版**。

---

## 工程模块结构与核心能力概览

```text
.
├── AGENTS.md                 # AI 协作入口宪章（强制前置机制拆解、平实注释规范与测量协议）
├── epiphy-api/               # 公共契约层（不依赖 Minecraft/Forge 类库，独立运行契约单测）
│   └── dev.epiphy.api.*      #   PROTO v6 契约、官方双别名单点归一化、BoundedCache (FIFO/LRU)、PresetRegistry、SemVer
├── epiphy-core/              # 原生核心主模组（双 SourceSet 编译隔离，产出重映射发行 Jar）
│   ├── src/main/             #   [核心层：编译类路径不含第三方业务 Mod]
│   │   ├── dev.epiphy.core.* #     AtomicJsonStore (fsync/.bak自愈/损坏锁)、EpiphyDataManager (复制档分叉)、异步限频日志、环形纳秒采样
│   │   ├── dev.epiphy.client.*#    FboCachePool (预乘Alpha离屏池)、NativeTextBatchEngine (图集分桶合批)、GuiInterceptionHooks、配置界面
│   │   └── dev.epiphy.mixin.*#     Java 17 Mixin（MixinBooster探测、容器四相位钩子、innerBlit贴图重定向、ItemRenderer钩子、Sound*Accessor）
│   └── src/compat/           #   [软兼容层：compileOnly(KubeJS / ModernUI / Curios)，按需动态启用]
│       ├── compat.kubejs.*   #     EpiphyKubeJSPlugin：暴露顶层入口 EpiphyNative，供脚本绑定原生算子
│       └── compat.modernui.* #     ModernUiGlyphCaptureBackend：自适应多版本签名的可选 SDF 字形捕获后端
└── docs/                     # PROTO v6 Schema (proto_v6_schema.json)、渲染路线图、迁移计划书与历史归档
```

### 核心子系统说明

1. **存储、配置、日志与诊断底座 (`dev.epiphy.core.*`)**
   - **`AtomicJsonStore<T>`**：先写入同目录 `.tmp` 并执行 `FileChannel.force(true)` 刷盘后再移动替换；区分“文件未创建”与“文件损坏”；正本解析失败时尝试从 `.bak` 恢复，若正本与备份均损坏则重命名为 `.corrupt.<ts>.bak` 并置 `corruptLocked` 拒写标志，避免内存默认状态覆盖待排查文件（仅针对单进程写盘场景，不提供跨进程文件锁）。
   - **`EpiphyDataManager` & `EpiphyConfig`**：管理 `<gameDir>/epiphy-data/` 外置目录与 `<gameDir>/config/epiphy-*.toml` 双端配置，拦截写入 `saves/<world>/` 内部的安全配置路径；通过比对存档内 `epiphy_world_id.json` 与外部 `meta.json` 的路径记录，在检测到复制存档时分叉独立目录。
   - **`EpiphyLogEngine` & `EpiphyDebugHub`**：通过有界阻塞队列在独立守护线程写盘，支持按时间窗口折叠重复日志并在进退存档时切换日志目录；配套环形数组耗时采样器 `RollingNanoSampler` 与单提供者异常捕获隔离的诊断汇总中心。
2. **客户端 2D / 3D 渲染与空间音频原语 (`dev.epiphy.client.*` & `mixin.*`)**
   - **`NativeTextBatchEngine`**：在首次遇到某文本片段时捕获其字形 Quad 与所属字体纹理页 `RenderType`，后续每帧在 Java 侧计算逐字偏移并在各深度阶段内部按 `RenderType` 分桶归并提交，减少跨纹理页交替绘制引发的批次中断。
   - **`FboCachePool`**：按 32px 步进分桶管理 `TextureTarget` 离屏缓冲，使用预乘 Alpha（`GL_ONE, GL_ONE_MINUS_SRC_ALPHA`）缓解半透明边缘二次混合发暗问题，并在 `finally` 中重新绑定主 `RenderTarget`。
   - **容器界面钩子与物品 3D 管线**：`AbstractContainerScreenMixin` 在容器背景后、槽位绘制前后与前景后提供回调挂载点；`GuiGraphicsMixin` 在 `innerBlit` 入口按映射表替换纹理路径；`ItemRendererMixin` 与 `NativeItem3DEngine` 基于原版 `ShaderInstance` 与 `BakedModel.getRenderPasses` 提交声明式物品 3D 图层。
   - **音频访问器与游戏内配置界面**：通过编译期生成的 `@Accessor` 接口访问 `SoundEngine` 声道映射与 `AbstractSoundInstance` 属性，在播放受管音乐时暂停 `minecraft:` 命名空间背景音乐；提供游戏内模组列表可直达的 `EpiphyConfigScreen` 可视化设置页。

---

## 运行前置与构建命令

### 运行时前置
- **必需**：`Minecraft 1.20.1` · `Forge 47.2.20+` · `Kotlin for Forge 4.12.0+` · `Sinytra MixinBooster 0.1.3+`（`MixinExtras` 已通过 Jar-in-Jar 随包内嵌）
- **可选软兼容**（已安装时自动启用桥接，未安装时保持基础功能运行）：`KubeJS 2001.6.5+` · `ModernUI` · `Curios API`

### 本地构建与门禁测试
需要 **JDK 17**（Gradle 会自动从 `~/.jdks` 检测）：

```bash
./gradlew check build
```

`check` 任务自动执行六项工程门禁：
1. `epiphy-api:test` (`ProtoV6ContractAndAliasTest`)：对照 [`docs/proto_v6_schema.json`](docs/proto_v6_schema.json) 校验协议字段、「至多 2 个官方别名」规则与 SemVer 2.0 预发布数值序；
2. `epiphy-core:test` (`EngineeringCharterGuardTest`)：执行动态反向案例词汇隔离检查、注释与主干文档反自夸/反无依据耗时断言检查、核心引擎类边界说明完整性校验，以及 `gradle.properties` 版本单一事实源对齐检查；
3. `epiphy-core:test` (`CoreInfrastructureRobustnessTest`)：文件 I/O 故障注入测试（`.bak` 恢复、锚点自愈保 UUID、双坏拒写锁、复制存档分叉、外置权限路径拦截、异步日志开关与累计丢弃统计）；
4. `epiphy-core:test` (`ClientSubsystemsRegressionTest`)：客户端渲染、音频与桥接无头回归套件（`PoseStackWatermark` 多层溢出/下溢恢复、`RenderFaultCircuitBreaker` 致命错误重抛与阈值熔断、界面级 GUI 纹理重映射失效、`NativeTextBatchEngine` 跨图集分桶次数 $== K$ 与颜色继承、`NativeItem3DBridge` 显式 `BlendMode` 与绑定状态码、`NativeAudioClientAccess` 异步线程停止观测）；
5. `epiphy-core:test` (`BytecodeSafetyGuardTest`)：通过 ASM 扫描编译产物，校验 `EpiphyMod.class` 与 `EpiphyConfig.class` 不直接引用客户端专属类、校验 `PoseStack.withPose` 异常表，并校验启动与 KubeJS 插件入口无 `java.lang.reflect` 反射调用；
6. `epiphy-core:verifyNoBundledKotlin`：同时检查瘦包与 `-all.jar` 胖包，校验未混入 `kotlin/` 或 `kotlinx/` 标准库字节码、`META-INF/mods.toml` 已声明 `mixinbooster` 前置，且 `epiphy.refmap.json` 完整包含各 Mixin 混淆映射。

---

## 作者与许可证 (Authors & License)

- **Epiphy-iLLUMs**：项目发起人、玩法设计、核心维护者；负责核心功能设计与实现、工程结构制定、模块化构思、纠错与重构方向。
- **Gemini 4 系列** / **Claude 5.5 系列**：架构协助、组件开发、纠错与优化建议。
- **DeepSeek**：吉祥物（Mascot）。

本项目源码与文档适用 **RAL 1.6（Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6）**，完整条款以 [`LICENSE.md`](LICENSE.md) 中文正式文本为准。

> [!TIP]
> **下游 KubeJS `.js` 脚本免许可证声明**  
> 由于 KubeJS 的 `.js` 脚本在整合包分发时原本就需要将明文源码直接下载到玩家的电脑上，因此**基于 KubeJS 和 Epiphy 组件编写的下游 `.js` 脚本无需声明许可证**。
