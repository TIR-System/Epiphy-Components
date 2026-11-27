# AGENTS.md — Epiphy 仓库 AI 协作入口宪章

> 接手本仓库任何任务前，请先完整阅读本文件及 [`.agent/rules/epiphy-engineering-charter.md`](.agent/rules/epiphy-engineering-charter.md)。更详细的跨模块契约见 [`README-LLM.md`](README-LLM.md) 与 [`docs/native-mod-migration-plan.md`](docs/native-mod-migration-plan.md)。

## 1. 四条硬性工作流准则（违反将直接触发 `./gradlew check` 失败）

1. **先拆解底层机制，再动代码（严禁针对具体结果/特定道具打表层补丁）**
   - 严格遵循 **「底层机制 ➔ 通用能力 ➔ 下游案例」** 的单向分层。
   - 遇到具体物品渲染异常、帧率下降或交互问题时，必须先剥离具体道具与玩法背景，定位底层渲染缓冲、状态机、并发或 I/O 机制问题，在 `epiphy-api` / `epiphy-core` / `通用组件` 中以通用机制修复。
   - 核心引擎与通用组件的源码、默认参数、API 命名和注释中，严禁出现任何下游测试道具、特定武器部位（如剑、刀、刃、护手）或特定演示着色器/贴图名称。

2. **保持平实自然的陈述文风，默认自己的实现并不完美**
   - 注释和文档应使用通顺、易读的自然语言，如实向阅读者说明：**这段代码处理什么问题、依赖哪些前置条件（线程、生命周期、状态栈）、目前存在哪些已知限制或未覆盖边界**。
   - 严禁使用自夸、说服性修辞或绝对化承诺（禁止“铁桶级”、“完美”、“极速”、“零开销”、“绝对恢复”、“彻底根治”、“100% 安全/零泄漏”等表述），严禁把尚未实现的保护写成既成事实。

3. **性能声明必须绑定测量方法，禁止拍脑袋写毫秒/纳秒数字**
   - 禁止在注释或文档中书写无测量协议的裸耗时数字。
   - 自动化测试优先断言与硬件无关的**结构复杂度不变量**（如纹理图集分桶后的 `getBuffer` 调用次数、是否误触发全局 `endBatch`）；实机耗时记录必须区分 CPU 提交段（`System.nanoTime()`）与 GPU 查询（`GL_TIME_ELAPSED`），并注明分辨率、GUI Scale、光影/ModernUI 环境、负载参数及 $\ge 300$ 帧的 `Avg / P95 / P99 / Max`。

4. **严守编译边界、数据边界与单一版本源**
   - `epiphy-core` 的 `main` SourceSet 保持无第三方业务 Mod 编译依赖；`EpiphyMod` 与 `dev.epiphy.core.*` 严禁直接引用客户端专属类（Dedicated Server 安全）；严禁将 `kotlin-stdlib` / `kotlinx-*` 打入模组 Jar。
   - 权限配置与全局设置严禁落入 `saves/<world>/` 内部。
   - 存量 `.js` 脚本须遵守 [`docs/kube-mods-rhino-es5-es6-compatibility.md`](docs/kube-mods-rhino-es5-es6-compatibility.md)（使用 `var`，禁用 `let`/`const`、`??` 及 `Math.PI` 等 8 个 Rhino 缺失常量）。

## 2. 必跑验证门禁

每次完成修改后，在仓库根目录执行：

```bash
./gradlew check build
```

确保以下自动化门禁通过：
- `epiphy-api:test`：`PROTO v6` Schema 与官方别名上限校验；
- `epiphy-core:test` (`EngineeringCharterGuardTest`)：动态反向案例隔离、平实注释反自夸词表拦截、核心类边界说明检查；
- `epiphy-core:test` (`BytecodeSafetyGuardTest` & `CoreInfrastructureRobustnessTest`)：服务端字节码隔离与存储/日志故障注入测试；
- `epiphy-core:verifyNoBundledKotlin`：构建产物无 Kotlin 运行时重复打包校验。
