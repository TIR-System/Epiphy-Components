# README-LLM — AI 协作者工程准则与跨上下文交接备忘

> **前置必读**：修改任何 `.js` 脚本前，须先完整阅读 [`docs/kube-mods-rhino-es5-es6-compatibility.md`](docs/kube-mods-rhino-es5-es6-compatibility.md)。
> 本文档用于向新对话窗口同步本仓库的技术约束、架构原则、历史已修复问题与后续演进契约，避免因上下文切换产生重复踩坑或语义偏离。

---

## 1. 运行时约束：`kube-mods/rhino` 兼容性与语义偏移

本项目当前过渡期运行底座为 **Minecraft 1.20.1 / Forge 47.x / KubeJS 2001.6.x** 内置的定制版 Rhino 引擎（`dev.latvian.mods.rhino`，纯 `Interpreter` 解释执行；后续版本将逐步迁往 Kotlin + Java 原生实现，当前所有脚本改动必须严格满足当前 Rhino 解释器语义）。

### 强制语法基准
> **唯一权威依据**：所有语法可行性与运行时行为均以 [`docs/kube-mods-rhino-es5-es6-compatibility.md`](docs/kube-mods-rhino-es5-es6-compatibility.md) 中的实测结果与字节码分析为准。

1. **主基调与可控扩展**：
   - 全仓库以 **ES5 为主**；
   - 若实测无语义偏移的 ES6 或其他受支持语法（例如箭头函数 `=>`、模板字符串、`for...of`、`Map`/`Set`、可选链 `?.`、`**`、`Object.entries`/`values`、`Array.from`/`includes` 等，详见兼容文档实测表）能使实现更整洁、可读性更高，允许使用；
   - 变量声明统一使用 **`var`**，以彻底规避 `let`/`const` 在该引擎上的块级与循环绑定语义偏移。
2. **明确禁用的高危/失效语法（禁止引入）**：
   - **`??`（空值合并运算符）**：`Interpreter.doNullishCoalescing` 未同步 Rhino 平行的 `double[]` 数字栈，`null ?? 9`、`undefined ?? 9` 等数值兜底会错误返回 **`0`** 或残留栈数值。必须显式编写 `(v !== null && v !== undefined) ? v : fallback` 或 `v != null ? v : fallback`。
   - **`let` / `const`**：无 TDZ；`for (let ...)` / `for (let ... of/in ...)` 无每次迭代独立词法绑定，循环内闭包会共享最终值；单语句 `if (true) let x = 1;` 向外部作用域泄漏；`const` 允许缺省初始值且非严格模式重赋值静默失效。
   - **对象简写与计算属性**：`{ x, y }`、`{ [k]: v }` 直接报 `SyntaxError`，必须书写完整键值 `{ x: x, y: y }`。
   - **展开/剩余语法与参数默认值**：`[...arr]`、`fn(...args)`、`function(a = 1)`、解构默认值（`var {a = 1} = obj`）均不可用。
   - **其他不支持特性**：`class` / `import` / `export`、`Promise` / `async` / `await`、`Proxy` / `Reflect`、`TypedArray` / `BigInt`、正则 `/u` 与 `/y` 标志。
3. **内置语义偏移注意**：
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
| `epiphy-data/` 外部统一目录、可读按天日志与复制档自动分叉 | `Epiphy的-服务端基础.js` / `Epiphy的-日志.js` / `.gitignore` | 建立 `config`/`worlds`/`players`/`events`/`logs`/`presets`/`backups` 骨架与 `.tmp`+`.bak` 原子写；默认输出按天 `.log`（支持 `logging.json`）；通过 `epiphy_world_id.json` + `meta.json` 检测 `lastWorldPath` 变化自动分叉并通知 OP | [x] |
| 外部撤销墓碑、Fail-Closed 按名授权备用模式与离线风险边界 | `Epiphy的-权限阀.js` | 权限迁移至 `epiphy-data/worlds/<slug>__<shortId>/`；`revocations.json` 拦截旧快照复活；`auth_mode.json` 默认 `false` 并附完整风险/离线服警示，仅真 OP/控制台 8 位口令 2 分钟二次确认或手动配置开启，关闭即暂停并保留未迁移记录 | [x] |
| `authorized` 非 OP 玩家音频与弹幕资源隔离与端侧防挤占 | `权限阀` / `音频组件` / `音频播放器` / `弹幕组件` / `弹幕渲染器` | 引入 `getCommandActorTier` 区分 `'system'` 与 `'player'`；音频钳制 `priority <= 3`、`u:<uuid>:` key 隔离、服务端配额与听众预留、`system` 单向淘汰及端侧优先淘汰 `'player'`；弹幕玩家命令参数限流、`250ms` 冷却、命名空间清屏锁及端侧每命名空间 `16` 条上限 | [x] |

---

## 5. 现行数据边界与演进契约（后续改造不得破坏）

以下设计已在本仓库落地并通过单元测试验证，后续重构、脚本增删或向 Kotlin + Java 迁移时须严格保持其边界与语义：

1. **`epiphy-data/` 统一外部数据目录与世界分叉边界**：
   - 位置：运行根目录 `epiphy-data/`（客户端 `.minecraft/epiphy-data/`，专用服 `./epiphy-data/`），子目录骨架 `config/`、`worlds/`、`players/`、`events/`、`logs/`、`presets/`、`backups/` 保持预建（禁止为了填满预留目录强加无用功能）。
   - **数据边界**：抗回滚管理/安全数据（权限授权、外部撤销墓碑、模块配置、可读审计日志）入 `epiphy-data/`；须随存档方块状态同步回滚的数据（如 `kubejs_epiphy_bugfix_hp.json`、`kubejs_epiphy_tracked_blocks.json`）仍留 `saves/<world>/`。
   - **世界复制防撞**：外部世界目录采用 `<slug>__<shortId>`，依赖存档内 `data/epiphy_world_id.json` 与外部 `meta.json`（含 `lastWorldPath`）双向校验；路径变更时自动分叉新目录并提醒 OP 手动清理旧目录。
   - **日志规范**：`logs/` 默认按天输出 `YYYY-MM-DD.log`，配置位于 `epiphy-data/config/logging.json`。
2. **“按名字授权”备用模式与 Fail-Closed 边界**：
   - 默认严格 UUID 授权；在提示与配置注释中必须明示：**纯离线服（`online-mode=false`）在无 TrueUUID 类模组且无密码登录插件保护时，仅依靠 UUID 模式同样不安全**。
   - 仅限**真 OP / 控制台**可操作 `/epiphy auth namegrant enable|confirm <code>|disable`（8 位数字 + 随机大小写字母口令，2 分钟有效期）；`auth_mode.json` 须保留 `_warning` / `_consequences` 注释，缺失或异常值一律按 Fail-Closed 处理；关闭后保留未迁移纯名字记录但立即暂停生效。
3. **`authorized` 非 OP 玩家资源隔离原则**：
   - 必须通过 `EpiphyPermissionValve.getCommandActorTier(source)` 区分 `'system'`（JS API / 真 OP / 控制台 / 命令方块 / Declared Callers）与 `'player'`（非 OP `authorized` 玩家）。
   - 任何新增音频/弹幕能力不得允许 `'player'` 源绕过命名空间隔离、越权停止 `'system'` 或他人对象，也不得挤压系统演出配额/槽位；同时不得反向给脚本 API、OP、控制台或命令方块施压额外玩家限流。
4. **长期原生化迁出计划**：
   - 本项目在脚本阶段功能与契约充分稳定后，将整体迁往 **Kotlin + Java** 原生模组，KubeJS 仅作此前过渡依赖。

---

## 6. 工作流、文档同步、版本规范与协议合规

1. **Git 规范**：主仓库位于 `D:\Git-Epiphy`。重大重构或模块改动前须先提交当前可用基准；严禁将运行期生成的 `epiphy-data/`、`_backup_*/`、`probe/`、`*.log`、`*.tmp`、`*.bak`、`kubejs/config/epiphy_permissions/` 等提交进版本库。所有读写均须使用 **UTF-8** 编码。
2. **文档与头部版本号同步规范（每次功能/架构改动必做）**：
   - **更新脚本头部注释与版本号**：修改任意 `.js` 组件涉及职责、依赖、降级策略或接口行为变化时，提交前必须检查并同步更新该脚本顶部注释的版本号（如 `EpiphyLog v1.1`、`EpiphyServerBase v2`、`EpiphyPermissionValve v5`、`ScreenDanmaku v5.1`、`EpiphyAudio v5.3` 等）、职责列表与依赖说明；若涉及共享语义版本常量（如 `EpiphySpec` 中 `AUDIO_SEMVER` 与端侧兜底 `VERSION`），须双端同步递增（网络包 `PROTO_VERSION` 仅在不兼容包结构变更时递增）。不得删除或篡改与改动无关的已有注释。
   - **同步仓库文档**：须同步检查并更新 [`README.md`](README.md)、[`README_EN.md`](README_EN.md)（工程架构表、组件版本号、核心能力与指令/目录说明），以及本文档 [`README-LLM.md`](README-LLM.md) 第 4 节（已解决问题基线表打 `[x]`）与第 5 节（现行契约状态）。
3. **测试定位**：`npm test`（`node tests/pure_functions.test.js`）运行在 Node.js V8 沙盒中，可回归纯函数与模拟命令/权限/音频/弹幕隔离链路，但**无法捕获 Rhino 引擎缺陷与客户端渲染问题**；涉及运行期或画面修改后必须进服核验。
4. **许可证约束（RAL 1.6）**：本项目受 [`LICENSE.md`](LICENSE.md) 约束（作者：`Epiphy-iLLUMs + Gemini 4 系列 + Claude 5.5 系列`；吉祥物：`DeepSeek`）。修改代码须保留既有 `RAL-1.6` 文件头与署名；严禁切换为非官方修改/衍生许可证，严禁引入不可调和冲突协议（如 PolyForm Shield License 1.0.0）或绕开桥接隔离规范直接混编冲突组件。
