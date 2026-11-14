# README-LLM — AI 协作者工程准则与跨上下文交接备忘

> **前置必读**：修改任何 `.js` 脚本前，须先完整阅读 [`docs/kube-mods-rhino-es5-es6-compatibility.md`](docs/kube-mods-rhino-es5-es6-compatibility.md)。
> 本文档用于向新对话窗口同步本仓库的技术约束、架构原则、历史已修复问题与后续演进契约，避免因上下文切换产生重复踩坑或语义偏离。

---

## 1. 运行时约束：`kube-mods/rhino` 兼容性与语义偏移

本项目当前过渡期运行底座为 **Minecraft 1.20.1 / Forge 47.x / KubeJS 2001.6.x** 内置的定制版 Rhino 引擎（`dev.latvian.mods.rhino`，纯 `Interpreter` 解释执行；后续版本将逐步迁往 Kotlin + Java 原生实现，当前所有脚本改动必须严格满足当前 Rhino 解释器语义）。

### 强制语法基准
1. **变量声明全系使用 `var`**：
   - 协议、服务端基础、权限、调试、修复及弹幕模块保持 **严格模式兼容的 ES5 子集**；
   - 音频模块（`Epiphy的-音频组件.js` / `Epiphy的-音频播放器.js`）仅允许使用经实测稳定的 ES6 子集（`=>`、模板字符串、`for..of`、`Map`、`Set`），同样禁止 `let` / `const`。
2. **禁止使用的语法与特性**：
   - **`??`（空值合并运算符）**：`Interpreter.doNullishCoalescing` 未同步 Rhino 平行的 `double[]` 数字栈，`null ?? 9`、`undefined ?? 9` 等数值兜底会错误返回 **`0`** 或残留栈数值。必须显式编写 `(v !== null && v !== undefined) ? v : fallback` 或 `v != null ? v : fallback`。
   - **`let` / `const`**：无 TDZ；`for (let ...)` / `for (let ... of/in ...)` 无每次迭代独立词法绑定，循环内闭包会共享最终值；单语句 `if (true) let x = 1;` 向外部作用域泄漏；`const` 允许缺省初始值且非严格模式重赋值静默失效。
   - **对象简写与计算属性**：`{ x, y }`、`{ [k]: v }` 直接报 `SyntaxError`，必须书写完整键值 `{ x: x, y: y }`。
   - **展开/剩余语法与参数默认值**：`[...arr]`、`fn(...args)`、`function(a = 1)`、解构默认值（`var {a = 1} = obj`）均不可用。
   - **其他不支持特性**：`class` / `import` / `export`、`Promise` / `async` / `await`、`Proxy` / `Reflect`、`TypedArray` / `BigInt`、正则 `/u` 与 `/y` 标志。
3. **语义偏移注意**：
   - `'use strict'` 下非方法调用的 `this` 仍为 `[object Object]`（非 `undefined`）；
   - `'use strict'` 下直接 `eval` 会泄漏 `var` 到外层函数，间接 `eval` 直接抛 `RuntimeException: eval is not allowed!`；
   - `JSON.stringify` 经 KubeJS 修改：对象上的 `undefined` 字段变为 `null`、函数成员被反射序列化为 Java 类成员列表、整数输出为 `1.0`。序列化前需显式清理非纯数据字段。

---

## 2. Java / Forge / 客户端渲染互操作规范

1. **文件路径与 `WindowsPath` 规范化**：
   - Windows 环境下 `server.getWorldPath(LevelResource.ROOT)` 返回 `sun.nio.fs.WindowsPath`，字符串化后可能带有 `/.` 尾缀或混合路径分隔符。路径拼接前必须规范化（参见 `Epiphy的-服务端基础.js` `resolveWorldStorageInfo`），写入前须调用 `ensureParentDir` 确保父目录存在。
2. **Java 对象引用与类型甄别**：
   - 权限校验及关键源判断**严禁使用类名字符串匹配或 `.toString()` 猜测**，一律采用 `Java.loadClass(...)` + `isInstance(...)`。
   - 经过 KubeJS 事件或命令回调包装后的 `ServerPlayer` 实例，JS 层 `===` 恒等判断不一定成立；身份匹配须对比底层 Java 引用或 UUID。
   - 调用存在重载签名的 Java 方法（如渲染器 `GuiGraphics.scale(float, float)` 与 `scale(float, float, float)`）前须先检测可用重载签名。
3. **Forge `CommandSourceStack.withPermission(int)` 安全边界**：
   - 外部模组可通过 `source.withPermission(int)` 在保持 `source.source === ServerPlayer` 的前提下临时提升命令栈权限等级。
   - **禁止使用 `source.hasPermission(...)` 判断玩家是否为管理员（OP）**：必须读取真实 `ServerPlayer` 权限、OP 列表或单人房主状态（见 `Epiphy的-权限阀.js` `isPlayerAdmin`），同时保留 `RESERVED_SUBCOMMANDS`（`auth`、`help` 不可被设为别名或由脚本通过 `withDeclaration` 代调）。
4. **ModernUI 客户端渲染适配定位（特例兼容，非常态基准）**：
   - 本项目测试环境包含 **ModernUI**；针对 ModernUI 字体阴影亮度衰减、多遍 `glow` + `blur` 重绘开销及矩阵/JNI 跨界调用所做的渲染管线适配属于**针对特定 Mod 环境的特例兼容，而非常态架构假设**。
   - 后续修改 `Epiphy的-屏幕弹幕渲染器.js` 时，**不得假设所有最终运行环境均安装了 ModernUI**；任何绘制改动必须同时确保在原生原版渲染管线与 ModernUI 兼容分支下均无亮度异常、Alpha 错乱或帧率劣化，并在进服环境实测验证。

---

## 3. 核心架构、依赖纪律与客户端信任边界

1. **模块化收敛与抽象尺度控制**：
   - 共享协议常量与纯逻辑解析收敛至 `kubejs/startup_scripts/通用组件/Epiphy的-Spec与通用工具.js`（`priority: 1200`）；服务端基础设施收敛至 `kubejs/server_scripts/通用组件/Epiphy的-服务端基础.js`（`priority: 1080`）。
   - 修改前优先复用已有公共函数，避免重复实现；同时避免过度抽象拆碎直观调用链。
2. **禁止多层冗余兜底（避免“兜底套娃”）**：
   - 核心硬依赖缺失应直接明确报错并停止加载对应受影响模块（Fail-Fast / Fail-Closed），不得层层堆叠互相掩盖错误的降级逻辑。
   - 仅保留面向独立运行模块或已明确声明的可选依赖单层轻量降级（例如 `EpiphyLog`、`EpiphyBlockTracker`、`EpiphyPermissionValve` 缺失时的单层确定性降级）。
3. **客户端数据信任边界划分（严禁一刀切，按职责严格区分）**：
   - **严禁信任客户端的场景（必须纯服务端权威）**：
     - 身份认证、权限授予/校验与指令源分类（`EpiphyPermissionValve`）；
     - 玩家核心数值、生存状态与防篡改恢复数据（如 `Epiphy的-基础bug修复.js` 的退出 HP 快照与 `maxHealth` 上限裁剪，不得读取或采信客户端上传的 HP/上限值）；
     - 持久化业务状态与管理配置落盘。
   - **允许客户端自主处理的场景（仅限纯本地表现，不得反哺服务端状态）**：
     - 屏幕尺寸适配、HUD 排版布局与局部动画插值（`ScreenDanmakuClient`）；
     - 本地音频音量衰减曲线插值、背景音乐避让与断流退避重连（`EpiphyAudioClient`）；
     - 客户端本地帧率保护与特定渲染Mod（如 ModernUI）兼容性分支。
4. **异常治理**：已预期且可恢复的运行期异常通过 `catchWarn` 输出限频警告，避免高频异常刷屏或被计入脚本崩溃错误。

---

## 4. 已解决问题基线（交接确认表）

以下问题在本仓库当前代码基线中已完成排查并提交修复；后续变更不得引入回退：

| 问题 / 缺陷描述 | 影响模块 | 已采用解决措施 | 状态 |
| :--- | :--- | :--- | :---: |
| `EpiphySpec` 与协议常量过度拆分，以及过度裁剪基础降级导致组件脆弱 | `Spec与通用工具` / 服务端与客户端基础组件 | 将 `EpiphyProtocol` 合并收敛至 `Epiphy的-Spec与通用工具.js`，并恢复关键模块清晰的单层轻量降级 | [x] |
| `CommandSourceStack.withPermission(int)` 提权、`auth` 别名冲突与 `withDeclaration` Confused Deputy 漏洞 | `Epiphy的-权限阀.js` | `isPlayerAdmin` 绕过栈等级直接核验真实 `ServerPlayer`/OP 列表；锁定 `RESERVED_SUBCOMMANDS` 禁止别名与脚本代调 `auth` | [x] |
| Rhino `ServerPlayer` 包装引用比较偏差与 Windows `WindowsPath` 拼接 / `JsonIO` 建目录异常 | `Epiphy的-服务端基础.js` / `Epiphy的-权限阀.js` | 统一路径规范化与 `ensureParentDir`，改进 Java 引用与 UUID 身份判定 | [x] |
| 玩家重进世界时属性修饰符加载晚于 `setHealth()`，导致高生命上限玩家 HP 被截断回 20 | `Epiphy的-基础bug修复.js` | 新增独立纯服务端模块：退出持久化真实 HP，重进后于结算窗口按服务端实际 `maxHealth` 补回，删 Mod 降上限时丢弃超出部分 | [x] |
| 客户端弹幕亮度异常，以及逐字 `glow` + `blur` 渲染、冗余 JNI/矩阵调用及测试方块性能开销过大 | `Epiphy的-屏幕弹幕渲染器.js` / `Epiphy的小玩意_功能测试.js` | 恢复正确阴影与绘制亮度参数，批处理优化逐字绘制并削减冗余矩阵与 JNI 调用 | [x] |
| 音频播放器链路与调用异常修复 | `Epiphy的-音频组件.js` / `Epiphy的-音频播放器.js` | 完成参数解析与端侧播放异常定位修复并回归现有沙盒测试 | [x] |

---

## 5. 既定演进契约（尚未实施，后续改造须严格遵循）

以下设计已与仓库维护者确认完毕，后续展开重构或功能开发时须按此执行：

1. **`epiphy-data/` 统一外部数据目录**：
   - 位置：运行根目录 `epiphy-data/`（客户端 `.minecraft/epiphy-data/`，专用服 `./epiphy-data/`）。
   - 目录骨架先建齐但不硬加空模块：`config/`、`worlds/`、`players/`、`events/`、`logs/`、`presets/`、`backups/`（配合 `.tmp` 原子写 + `.bak` 备份），同时迁移已有需要抗回滚的数据。
   - **数据边界**：抗回滚管理/安全数据（权限授权、外部撤销墓碑、模块配置、审计日志）入 `epiphy-data/`；须随存档方块状态同步回滚的数据仍留 `saves/<world>/`。
   - **日志规范**：`logs/` 默认按天输出可读性高的文本日志（如 `YYYY-MM-DD.log`），并在 `config/` 中提供轮转/记录模式配置项。
2. **世界标识防撞与复制档自动分叉**：
   - 外部世界目录命名为 `<可读世界名slug>__<短ID>`，绑定世界内部稳定 `worldId` 与外部 `meta.json`（含 `lastWorldPath`）。
   - 若命中同一 `worldId` 但目录路径与 `lastWorldPath` 发生变化（如复制正式存档作测试档），必须**自动分叉**创建独立 `worldId` 与目录，并在日志输出明确提示（含目录路径与自行删除清理说明）。
3. **“按名字授权”备用模式与安全提示边界**：
   - 默认严格 UUID 授权；须在提示与配置注释中写明：**纯离线服（`online-mode=false`）在无 TrueUUID 类模组且无密码登录插件保护时，仅依靠 UUID 模式同样不安全**。
   - **开启方式 1（游戏内）**：仅限**真 OP / 控制台**（`allowAuthorized: false`、禁止命令方块），首次执行展示完整风险提示与 **8 位数字 + 随机大小写字母口令**，限 **2 分钟内**二次输入同一口令生效。
   - **开启方式 2（手动改 JSON）**：生成配置文件时默认 `false`，且文件内必须自带固定注释明确说明 **将该字段改为 `true` 会产生何种风险与后果**（并备注若服务器已安装强制密码登录插件可忽略该风险）；缺失或异常值一律按 Fail-Closed 处理。
   - **中途关闭回退**：开关改回 `false` 后，未迁移的纯名字授权记录**保留在原文件中不删除，但立即暂停生效**。
4. **`authorized` 资源隔离与 DoS 防护**：
   - 为音频句柄与弹幕包引入 `'system'`（脚本 API / 真 OP / 控制台 / 命令方块）与 `'player'`（仅通过 `authorized` 授权执行指令的玩家）来源分级及 `ownerUuid`；
   - 禁止 `authorized` 玩家 `stop`/`clear`/`update` 或撞 `key`/`group` 覆盖 `'system'` 与他人对象；
   - 限制 `authorized` 命令行 `priority` 上限（不高于系统常用演出优先级），保护全服池及单人听觉槽位不被玩家级循环音频挤占；仅在玩家命令入口限制弹幕 `scale`、长度、换行数、`stay` 与频次，不限制脚本 API 与 OP 演出。

---

## 6. 工作流、测试与协议合规

1. **Git 规范**：主仓库位于 `D:\Git-Epiphy`。重大重构或模块改动前须先提交当前可用基准；严禁将运行期生成的 `epiphy-data/`、`_backup_*/`、`probe/`、`*.log`、`*.tmp`、`kubejs/config/epiphy_permissions/` 等提交进版本库。所有读写均须使用 **UTF-8** 编码。
2. **测试定位**：`npm test`（`node tests/pure_functions.test.js`）运行在 Node.js V8 沙盒中，可回归纯函数与模拟命令/权限链路，但**无法捕获 Rhino 引擎缺陷与客户端渲染问题**；涉及运行期或画面修改后必须进服核验。
3. **许可证约束（RAL 1.6）**：本项目受 [`LICENSE.md`](LICENSE.md) 约束（作者：`Epiphy-iLLUMs + Gemini 4 系列 + Claude 5.5 系列`；吉祥物：`DeepSeek`）。修改代码须保留既有 `RAL-1.6` 文件头与署名；严禁切换为非官方修改/衍生许可证，严禁引入不可调和冲突协议（如 PolyForm Shield License 1.0.0）或绕开桥接隔离规范直接混编冲突组件。
