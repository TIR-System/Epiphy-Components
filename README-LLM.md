# README-LLM — AI 协作者工程准则与跨上下文交接指南

> **最高优先级必读**：动笔前必须先阅读根目录 [`AGENTS.md`](AGENTS.md) 与 [`.agent/rules/epiphy-engineering-charter.md`](.agent/rules/epiphy-engineering-charter.md)。  
> 修改任何 `.js` 脚本前，须同时阅读 [`docs/kube-mods-rhino-es5-es6-compatibility.md`](docs/kube-mods-rhino-es5-es6-compatibility.md)。  
> 历史 KubeJS 阶段已解决缺陷记录已归档至 [`docs/archive/kubejs-issue-history.md`](docs/archive/kubejs-issue-history.md)。

---

## 1. 核心架构哲学与写作铁律（编译门禁强制执行）

### 1.1 「底层机制 ➔ 通用能力 ➔ 下游案例」单向分层
- **问题降维流程**：遇到具体游戏截图、报错或性能瓶颈时，必须先将表层现象还原为底层机制问题（如渲染缓冲刷新时序、深度/混合状态契约、线程可见性、文件原子替换），再设计参数化的通用引擎能力，最后由下游案例脚本通过公开配置消费。
- **严禁案例概念倒灌**：允许由具体目标效果反推需要补充什么通用能力，但**严禁**将特定案例的坐标、配色、着色器名、贴图名或具象器械部位概念（如 `imperius_test`、`epiphy_cosmos`、剑、刀、刃、护手等）写入 `epiphy-api`、`epiphy-core` 或 `kubejs/*/通用组件/` 的代码、默认参数、API 命名与注释中。`EngineeringCharterGuardTest` 会自动提取案例目录标识并反向扫描核心层。

### 1.2 默认不完美假设与平实自然的注释风格
- **如实陈述机制与边界**：默认自己编写的代码存在未覆盖的边界条件。注释应使用流畅、易读的自然语言，清楚说明这段代码做了什么、依赖什么调用前提（如线程归属、生命周期阶段），以及当前有哪些已知局限或折中。
- **禁止自夸、说服性修辞与无依据耗时承诺**：禁止在注释或主干文档中使用主观吹捧词、绝对化断言或未绑定测量方法的裸耗时数字（具体禁用词表与拦截规则见 [`.agent/rules/epiphy-engineering-charter.md`](.agent/rules/epiphy-engineering-charter.md) §2.2 & §3）。

### 1.3 性能指标与测量五元组规范
- **CI 门禁指标**：采用与硬件配置无关的确定性结构指标（如跨纹理图集分桶后的 `MultiBufferSource.getBuffer` 调用次数、跨界调用次数、是否误触发外层共享缓冲 `endBatch`）。
- **实机耗时记录**：必须明确区分渲染线程 CPU 提交段耗时（`System.nanoTime()`）与 GPU 查询耗时（`GL_TIME_ELAPSED`），并同时记录**分辨率与 GUI Scale、渲染管线栈（原版 / ModernUI / Iris 及光影开启状态）、场景负载参数、以及连续 $\ge 300$ 帧的 `Avg / P95 / P99 / Max`**。

---

## 2. 原生模组工程结构与字节码边界 (`Minecraft 1.20.1 · Forge 47.2+`)

1. **模块划分**：
   - `epiphy-api`：公共协议模型（`PROTO v6`）、官方别名归一化（1 主标准名 + 至多 2 个官方别名）、`BoundedCache`、`PresetRegistry`、`SemVer`。不依赖 Minecraft/Forge 类库。
   - `epiphy-core`：
     - `src/main`：核心基础设施与客户端渲染/音频底层原语。编译类路径不引入 KubeJS / ModernUI / Curios 等第三方业务 Mod。
     - `src/compat`：可选软兼容桥接层（`compileOnly` 依赖 KubeJS / ModernUI / Curios），随主模块统一参与单次 `reobfJar` 与 `jarJar` 打包。
   - **长期模块化家族方向**（详见 [`docs/native-mod-migration-plan.md`](docs/native-mod-migration-plan.md) §9）：`epiphy-api` 将保持零 Minecraft/Forge 依赖并持续扩张纯契约与 SPI 能力；`surface2d`、`fx3d`、`audio`、`permission` 规划在未来拆分为与 `epiphy-core` 同级、单向依赖核心底座的独立模组（类 FTB 家族式组织形态，但聚焦视听表现与外置治理方向），并通过 Forge 原生 `Jar-in-Jar` 同时支持分散安装与单 JAR 聚合分发。日常开发应避免上述四个业务域之间产生横向交叉依赖。
2. **Kotlin for Forge (`4.12.0`) 与 Mixin 边界**：
   - 运行时复用 KFF `4.12.0` 提供的 `Kotlin 2.2.21`、`kotlinx-coroutines-core 1.10.2` 与 `kotlinx-serialization-json 1.9.0`，构建产物严禁自行打包 `kotlin/` 或 `kotlinx/` 字节码（由 `verifyNoBundledKotlin` 门禁检查）。
   - `runForDist` 为 `inline` 函数，`EpiphyMod` 与 `dev.epiphy.core.*` 严禁在字节码中直接引用 `net.minecraft.client.*`、`com.mojang.blaze3d.*` 或客户端专属事件类，统一通过无客户端参数类型的 `EpiphyClientBootstrap.init(MOD_BUS, FORGE_BUS)` 跳板转发（由 `BytecodeSafetyGuardTest` 检查）。
   - 矩阵栈推弹须使用带 `try / finally` 的 `PoseStack.withPose`（避免使用 `kfflib` 中无异常表的 `PoseStack.use`）。
3. **开源依赖查阅准则**：
   - 调研开源第三方 Mod（如 KFF、MixinBooster、MixinExtras、KubeJS、ModernUI、Curios 等）时，优先查阅其官方开源源码或编译期签名以确认准确契约；反编译手段仅用于无公开源码的闭源 Mod 或核对最终打包产物元数据。

---

## 3. 存量 KubeJS 脚本运行时约束（`kube-mods/rhino`）

仓库 `kubejs/` 下保留的过渡期联动脚本与纯数据配方脚本运行在 `dev.latvian.mods.rhino` 解释器下，须遵循 [`docs/kube-mods-rhino-es5-es6-compatibility.md`](docs/kube-mods-rhino-es5-es6-compatibility.md)：

1. **变量声明统一使用 `var`**：禁用 `let` / `const`（存在循环词法绑定与单语句作用域泄漏偏移）。
2. **禁用失效语法与缺失常量**：
   - 禁用 `Math.PI` / `Math.E` / `Math.LN2` / `Math.LN10` / `Math.LOG2E` / `Math.LOG10E` / `Math.SQRT1_2` / `Math.SQRT2`（`rhino-forge` `NativeMath` 未映射这 8 个常量，返回 `undefined`；统一使用 `global.EpiphyMath` 或显式数值常量）；
   - 禁用空值合并 `??` / `??=`（解释器双栈未同步，数值兜底会错误返回 `0`）；
   - 禁用对象属性简写 `{ x, y }`、计算属性 `{ [k]: v }`、展开语法 `...`、默认参数 `function(a = 1)` 及 `class` / `async` / 正则 `/u` `/y`。
3. **ModernUI 可选兼容定位**：
   - ModernUI 属于可选兼容环境而非默认前提；未安装 ModernUI 或遇到彩色位图符号时，排版与描边逻辑须能回退至原版 `Font` 正常绘制。

---

## 4. 数据存储边界与客户端信任划分

1. **随存档回滚 vs 存档外独立存储（硬性安全红线）**：
   - **存档外数据（`<gameDir>/epiphy-data/` 与 `<gameDir>/config/`）**：权限授权（`permissions.json`）、撤销墓碑（`revocations.json`）、按名授权配置（`auth_mode.json`）、跨档索引（`worlds_index.json`）、运行日志与 `ForgeConfigSpec` 配置文件（`epiphy-client.toml` / `epiphy-common.toml`）。**权限与安全配置文件严禁存放在 `saves/<world>/` 内部，也不从存档内导入**，防止存档回滚复活已撤销权限或外部存档夹带提权配置。
   - **随存档同步回滚的世界状态（`saves/<world>/`）**：世界悬浮平面持久化、方块追踪表、生命值恢复快照等业务世界状态，以及用于识别复制存档自动分叉的 `data/epiphy_world_id.json` 锚点。
2. **客户端信任边界**：
   - 身份认证、权限判定（必须核验真实 `ServerPlayer` / OP 列表，禁止直接信任可被 `withPermission` 提权的 `CommandSourceStack.hasPermission`）、核心生存数值与持久化落盘均以服务端为准；
   - 客户端仅负责本地视口排版、动画插值、局部音频衰减、原版背景音乐暂停避让与本地渲染预算控制。

---

## 5. 版本管理、构建门禁与 Git 规范

1. **单一版本真值源（SSOT）**：
   - 模组发行版本唯一源：[`gradle.properties`](gradle.properties) 中的 `mod_version`；
   - 协议 Schema 版本唯一源：[`docs/proto_v6_schema.json`](docs/proto_v6_schema.json) 中的 `schemaVersion`。
2. **本地构建与验证命令**：
   - 执行 `./gradlew check build` 运行全套 JUnit 契约测试、工程宪章守卫、字节码双端隔离守卫与 Jar 打包门禁；
   - 严禁将运行期生成的 `epiphy-data/`、`_backup_*/`、`*.log`、`*.tmp`、`*.bak` 或版权音频提交进版本库；所有文本读写均使用无 BOM 的 **UTF-8** 编码。
3. **Git 双语提交规范**：
   - 格式：`<subject> [(<scope>)] <中文说明> | <English description>`（标准 `<subject>`：`feat` / `fix` / `refactor` / `perf` / `docs` / `style` / `test` / `chore` / `build` / `ci` / `revert`）。
4. **许可证约束（RAL 1.6）**：
   - 本仓库源码与文档适用 [`LICENSE.md`](LICENSE.md)（RAL-1.6），新增源码文件须保留标准许可证头部声明；下游整合包基于 KubeJS 调用本组件编写的明文 `.js` 脚本无需声明许可证。
