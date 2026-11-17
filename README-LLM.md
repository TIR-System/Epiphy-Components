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
   - 共享协议常量与纯逻辑解析收敛至 `kubejs/startup_scripts/通用组件/Epiphy的-Spec与通用工具.js`（`priority: 1200`）；服务端核心与世界/实体基础设施收敛至 `kubejs/server_scripts/通用组件/Epiphy的-服务端核心.js`（`priority: 1080`，同时导出 `EpiphyServerCore` 与 `EpiphyServerBase`）；物理方块追踪与三级开销门控区块地形批处理收敛至 `kubejs/server_scripts/通用组件/Epiphy的-方块与区块组件.js`（`priority: 1050`，同时导出 `EpiphyBlockTracker`、`EpiphyChunkEngine`、`EpiphyWorldOps`）。
   - `Epiphy的-音频组件.js` 与 `Epiphy的-屏幕弹幕组件.js` 属 L3 业务调度模块，**明确禁止被其他模块或平级业务直接复用内部实现**（仅通过公开全局 API `global.EpiphyAudio` / `global.ScreenDanmaku` 调度）。
   - 修改前优先复用已有公共函数，避免重复实现；同时避免过度抽象拆碎直观调用链。
2. **禁止多层冗余兜底（避免“兜底套娃”）**：
   - 核心硬依赖缺失应直接明确报错并停止加载对应受影响模块（Fail-Fast / Fail-Closed），不得层层堆叠互相掩盖错误的降级逻辑。尤其玩法层脚本（如 `拆解台-混沌殉爆.v18.js`）须强声明硬前置（`EpiphyServerCore` / `EpiphyWorldOps` / `ScreenDanmaku`）并禁止保留直发包与玩家/遗物冗余兜底。
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
| 弹幕端侧 `CompoundTag` 数值 `priority`/`proto` 读取失效、含空格文本逐字错位与 `maxGroup` 跨层驱逐 | `Epiphy的-屏幕弹幕渲染器.js` / `Epiphy的-屏幕弹幕组件.js` | 新增 `readPriorityField` 并改用 `readNum` 解析 `proto`，避免 `IntTag`/`DoubleTag` 退化；`splitLineIntoFragments` 统一空白与可见字素 `visIndex` 对齐 `countVisibleChars`；玩家命令强制 `u:<uuid>:` 组前缀且端侧 `maxGroupSize` 仅统计/驱逐同玩家命名空间 | [x] |
| 音频 `/epiphy audio list\|info` 缺 `describeHandle` 及端侧 `CompoundTag` `proto` 读取补齐 | `Epiphy的-音频组件.js` / `Epiphy的-音频播放器.js` | 在 `buildAudioCommandNode` 内补全 `describeHandle` 格式化函数，并将端侧 `dataReceived` 协议版本读取统一改为 `readNum(pkt, 'proto', null)` | [x] |
| 单元测试 `requires`/三重加载/`console`/音频端侧包往返“假绿”盲区 | `tests/pure_functions.test.js` | 真测 Brigadier `_req` 权限门禁与命令执行；移除 Test 14 重复加载并严格断言单次加载 `ServerEvents.tick` 数量；全链路捕获并断言零意外 `console.warn`/`error`；补全服务端 `_sent` 包到 `EpiphyAudioClient` 的真实往返及 P0 回归测试 | [x] |
| 渲染器 P1 缺陷群（续期漏同步 `tier`/`maxGroupSize`、无排队/帧预算/文本/scale 上限、batch 异常降格、永久降级、闪烁破坏缓存、`hasKeyInTag` fail-open） | `Epiphy的-屏幕弹幕渲染器.js` | 续期同步 `tier`/`maxGroupSize` 并复用 `enforceOverlayCaps`；增加 `maxPendingActions`/`maxPendingPerFrame`/`frameBudgetMs`/文本截断与 `maxScale` 上限；batch 按条目隔离 catch 且不降格单条；`BATCH_FAILED`/ModernUI 降级改为 `10s` 冷却恢复；移除 `blinkCursor` 缓存键并用几何绘制光标；`hasKeyInTag` 异常改 fail-closed 返回 `false` | [x] |
| 音频 双端 P1 缺陷群（`countedListeners` 漏减、未启动僵尸句柄、`pendingReset` 先清零、扫描 O(n²) 重建、`syncIntervalTicks=0`、无阀回落 `hasPermissions(2)`、`duckMusic` 杀他模组 BGM、3D `Channel` 坐标静止、静音重连循环、`update` 漏同步 `bx/by/bz`、解构语法风险） | `Epiphy的-音频组件.js` / `Epiphy的-音频播放器.js` | 抽取 `releasePlayerListenCount`；增加未启动超时与实体丢失清理；先广播成功再置 `pendingReset=false`；扫描延迟合并至 `dirtyMergeScopes`；`configure` 校验整型/浮点边界；缺失阀改为仅认 `isOp()`；`duckMusic` 改为 `Channel.pause`/`unpause` 并于队列归零时恢复；同步 `Channel.setSelfPosition(Vec3)` 与 `AbstractSoundInstance` 坐标；`mul=0` 走 `pause` 待命；同步 `bx/by/bz` 并移除数组解构 | [x] |
| 弹幕 P1 缺陷群（拆块无命名空间误清、`null`/无效维度回落主世界、`stop`/`clear` 无频控、`onFound('scan')` 全清缓存、API 无包上限、`myIdx` 缺失仲裁失效） | `Epiphy的-服务端基础.js` / `Spec与通用工具.js` / `Epiphy的-屏幕弹幕组件.js` | 绑块清理限定 `blk:<blockId>` + `maxSeenPriority`；`resolveLevel`/`clearNear`/`deactivateNear` 无效维度 fail-closed；为 `stop`/`clear` 增加独立分桶防刷频；`'scan'` 改定向清缓存与球簇 AABB 预过滤；增加 `SYSTEM_PACKET_LIMITS`；修复 `myIdx` 缺失时 `first`/`latest` 及 `stagger` 仲裁 | [x] |
| 非 OP `authorized` 权限粒度过粗（可对 `@a` 全服广域广播）与单指令按需授权缺失，及全库 `RAL-1.6` 文件头补齐 | `权限阀` / `服务端基础` / `弹幕组件` / `音频组件` / 全仓 `.js` | 实现 `module` -> `module.action` 分层权限（子级明确撤销优先于父级授权）与 `exactScopeOnly` 广播门 (`danmaku.broadcast` / `audio.broadcast`，无权非 OP 限 `<=4` 名他者/不跨维度/半径 `<=32m`)；新增 `/epiphy danmaku self` 与 `/epiphy auth scopes`；全仓缺失脚本与测试文件补齐 `RAL-1.6` 头部声明 | [x] |
| 实机 Forge 1.20.1 SRG 环境下音频无法播放及右下角字幕未注册（`Client.minecraft` / SRG 字段编号与 `attCache` 冷加载毒化） | `Epiphy的-音频播放器.js` / `tests/pure_functions.test.js` | 修复 `getMc()` 误落至 KubeJS `Client` 包装器并补全 `Minecraft`/`Options`/`SoundManager`/`SoundEngine`/`Gui`/`SubtitleOverlay`/`RandomSource`/`AbstractSoundInstance` 等全链路 SRG 兜底；修正音量/坐标字段偏移（`f_119572_`/`f_119574_`..`f_119576_`）及 3 处 `omode` -> `outMode`、`warnedKeys` 初始化顺序；为 `getSoundEvent` 冷加载新增宽限期与重试退避，避免 `attCache` 永久写入 `-1`；新增纯 SRG 端到端测试验证右下角 `m_7761_` 字幕 | [x] |
| 实机 KubeJS 2001.6.5 / Rhino Java 互操作异常（`KubeJSPaths.GAMEDIR` 缺失、POJO `typeof` 抛 `InternalError`、`JsonIO.read` `LinkedTreeMap` 被当数组）与重进世界测试方块弹幕不触发 | `Spec与通用工具` / `服务端基础 v2.2` / `方块追踪组件 v2.1` / `屏幕弹幕组件 v5.3` / `音频组件` / `权限阀` / 客户端渲染器与播放器 / `docs` | 全链改用 `safeTypeOf`/`isObjectLike`/`isJavaMapLike`/`safeReadProp`/`safeHasMethod` 隔离 Rhino `MemberType.get` 与 `EvaluatorException`；`resolveGameDir()` 安全探测并用 `KubeJSPaths.DIRECTORY` 取上级目录；`toSeqArray` 排除 `java.util.Map` 使持久化列表正常加载；`ensureLoaded()` 派发 `'persist'`、`danmaku` 响应 `'scan'`/`'persist'` 并通过 `PlayerEvents.loggedIn` 延迟 6 tick 补发；客户端静默探测 `java.lang.System` | [x] |
| 实机 `kube-mods/rhino` 下 `try` 块内 `function normalizeBoundSpec` 块级函数声明退化为 `undefined` 致弹幕完全失效，以及 `normalizePermissionPolicy('strict_op')` 误报未知策略 | `Epiphy的-屏幕弹幕组件.js` / `Epiphy的-权限阀.js` / `docs` / `tests/pure_functions.test.js` | 将 `normalizeBoundSpec`（与 `recordOne`）提升/改为 `var ... = function` 赋值形式并移出 `try` 块；在 `normalizePermissionPolicy` 补齐 `'strict_op'` 归一化映射；在文档与单测补齐 `try` 块语句级具名函数静检与双向回归测试 | [x] |
| 实机 KubeJS `ClassFilter` 屏蔽 `java.io`/`java.nio` 且 `JsonIO.read` 触发 `[Ljava.lang.reflect.Constructor;` 致同一世界每次重进重生成目录、`epiphy-data` 缺子目录且运行日志未落至世界子文件夹 | `Epiphy的-日志.js v1.2` / `Epiphy的-服务端基础.js v2.3` / `tests/pure_functions.test.js` | `ensureDirExists` 增加 `KubeJSPaths.dir` 兜底；`readTextSafe`/`readJsonSafe` 优先使用 `JsonIO.readString` 并加固 `javaToJsPlain` 防误触 Java `.class`；新增 `worlds/worlds_index.json` 与 `anchor.folderName` 探测替代 `File.listFiles()` 恢复同档识别与复制分叉；`EpiphyLog` 增加 `KubeJSPaths.dir + JsonIO` 写盘兜底并于进档后自动切换至 `worlds/<slug>__<shortId>/logs/` | [x] |
| 逐字震动/内联混排热路径开销过大（静态字未合批、全表 $O(N)$ 扫描、每帧重算 `cos`/`sin`/`Math.sin` 哈希、无屏幕外裁剪与不可共享时序缺少非法哨兵） | `Epiphy的-屏幕弹幕渲染器.js v5.3` / `tests/pure_functions.test.js` | 合并同样式连续静态片段并保留打字机边界单字回退；可见 `visIndex` 二分定界 ($O(\text{vis})$) 与 2D 视口外 bounds 裁剪；`hashUnit` 改 32 位位混洗与 256 档三角 LUT；`omni` 缓存 `_oCos`/`_oSin` 与稳态快照；统一周期支持弹幕级一次预计算，不可共享场合（随机频率区间 / `smooth` 等）显式置 `NaN` 非法哨兵并拒绝消费 | [x] |
| 逐字渲染器 JNI 字段查找（`sAllowShadow`/`fgMat`/热路径 `getMatrix`）、18~21 参传递与 `12ms` 帧预算误闪烁 | `Epiphy的-屏幕弹幕渲染器.js v5.4` / `tests/pure_functions.test.js` | 将 `sAllowShadow` 移入 `ensureFrameBatchCtx` 帧级缓存；`itemFgMat` 复用免去无旋转/缩放字阴影 `set+translate` JNI；进循环前校验并收敛 `itemBatchCtx` 移除热路径 `event.getMatrix()`；仅将严格恒定字段（含预计算 fade 参数）打入 5 参 `ITEM_RENDER_CTX_SCRATCH`，保留 `color`/`charScale`/`outlineMode`/`outlineColor` 单字覆盖；开帧统一清过期项、按 `priority` 绘制并上调紧急熔断线至 `45ms` 防正常重特效闪屏（不降级特效） | [x] |
| ModernUI 存在下弹幕未深度利用直连管线（`Text.of` 冗余构建、15s 轮询重查、绕路换算宽度、描边多 Pass Flush）及服务端 `inDimension` 冗余发包构筑 | `Epiphy的-屏幕弹幕渲染器.js v5.5` / `Epiphy的-屏幕弹幕组件.js v5.4` / `tests/pure_functions.test.js` | 客户端探测 `lookupVanillaLayout(String)` 与 `drawTextOutline`；`SHARED_TEXT_SEQ_CACHE` 惰性延后 `Text.of` 构造，合并静态行跳过 `resolveVisualSeq`，消除 15s TTL 重查（纯金丝雀 `MUI_EPOCH` 失效并清字宽缓存）；新增 `measureWholeLineWidthPx` 整段换行快路与 `needEndPx` 按需计算；复用 `itemOutMat` 并展平 `drawBatchedRing`；支持 `'mui_stroke'` 单 Pass 描边（Emoji/无 ModernUI 自动回退 `'stroke'`）及 `per_char`/多行静态 `drawUnitsPassGrouped` 三阶段分 Pass 合批；纯 `<shake>` 标签维持清晰 `MODE_NORMAL(0)`；同文本续期复用 `titleVis`/`subVis`；服务端 `v5.4` 前置筛除 0 玩家与源冷却避免 `recentPos` 污染（保留非法入参告警）、POJO 安全检查改 `!BASE.isObjectLike` 并对 `RECENT_POS_BY_GROUP` 实施 128 组上限清理 | [x] |
| P2 审计缺陷修复与设计注释补齐（队溢控制包 `hasKeyInTag` 误判、`Test 31` 守卫静默跳过、`a<=2→255`、全局角通道、字宽全清、`ZWJ`/国旗聚类、`unpauseGraceUntil` 死代码、`v18` `fallbackPkt` 缺 `proto`、`fallback tracker` 粘滞、权限阀 `__proto__`/`getContext()`/`at` 同步，以及路径边界/`legacy break`/总览/`45ms`/卸载区块/`stop` 注释） | `屏幕弹幕渲染器 v5.6` / `屏幕弹幕组件 v5.5` / `音频组件与播放器 v5.5` / `权限阀 v5.2` / `方块追踪`/`Bugfix`/`服务端基础`/`Spec`/`v18`/`tests/pure_functions.test.js` | `enqueueDanmaku` 改用 `isControlPacket(action)` 识别控制包；补全 `ScreenDanmakuClient.list()` 并去除 `Test 31` 跳过守卫；消除 `a<=2→255` 与 `unitRotDegSafeValue`；`GLYPH_WIDTH_MAP` 改 FIFO 淘汰；`readGraphemeCluster` 支持扩展 Extend 区间、`ZWJ` 连字与国旗配对；清理 `unpauseGraceUntil`；`v18 fallbackPkt` 补 `proto:5`；弹幕/音频支持后置加载 `EpiphyBlockTracker` 无缝升级；权限阀阻断 `__proto__`/`constructor`、`parseResults.getContext()` 空兜底 `event.getSource()` 并同步更新 `at` 与 `atMs`；为其余合理设计补齐注释并新增 `Test 55` 回归验证 | [x] |
| 持久化事务语义、三态权限作用域、命令方块修改锁、通用组件更名扩充与拆解台重构 + 弹幕/水幕深度优化与审计加固 | `Epiphy的-服务端核心.js v2.4` / `Epiphy的-方块与区块组件.js v2.3` / `Epiphy的-权限阀.js v5.3` / `Epiphy的-屏幕弹幕渲染器.js v5.7` / `Epiphy的-音频播放器.js v5.6` / `拆解台-混沌殉爆.v18.js` / `tests/pure_functions.test.js` | `readJsonDetailed` 仅在 `corrupt` 时自动从 `.bak` 恢复自愈（`missing` 不复活已删文件）并在 `JsonIO` 下通过内存缓存免去重复读盘；世界锚点增 `persistentData` 双重兜底防孤儿目录；权限阀实现三态作用域（父级生效时保留并默认覆盖子级、`revoke <p> <parent>` 保留子级、`revoke <p> <parent>.*` 整树移除与子树墓碑）并锁定命令方块 `strict_op`（优先判 `BaseCommandBlock` 防 `/execute as <OP>` 绕过）；原服务端基础与方块追踪分别更名扩充为 `Epiphy的-服务端核心.js`（含无 NBT 伪造的 `findPlayerItem`/`isHoldingMainHand` 与零分配 `forEachPlayerNear`）与 `Epiphy的-方块与区块组件.js`（含三级开销门控、`cylinder2D`/`useCylinder2D` 上柱下球流体剥离、最外圈 `flag=3` 边缘唤醒、`excludeLava`/`protectedRingCols` 防清岩浆环、基岩/容器保护及冷却期未加载区块轮询）；拆解台支持失稳任务 `persistentData` 优先加载与世界区块阶段自动对账防误爆、兜底直发包全量携带 `namespace`/`tier`/`SYSTEM_PACKET_LIMITS` 防全局清屏，并清理 `MAGMA_RING_BATCH` 死常量；弹幕渲染器新增与慢路径逐字符等价的 `ensureLineVisTable`（绑定 `MUI_EPOCH` 失效）、`TRANSIENT_TEXT_SEQ_CACHE` 隔离与静态晋升、非标签 `<...>` 首字符快速短路与 `VERSION` 导出；音频播放器修复 `duckMusic` 在 `chanMap==null` 时提前 `clear()` 与误暂停第三方模组 BGM 的缺陷 | [x] |
| L3 组件复用边界声明、全库死代码与跨层冗余收敛、`v18` 玩法层前置收口及缺陷修复 | `服务端核心.js v2.5` / `方块与区块组件.js v2.4` / `权限阀.js v5.4` / `音频组件.js v5.7` / `屏幕弹幕组件.js v5.7` / `拆解台-混沌殉爆.v18.js` / `tests/pure_functions.test.js` | `音频组件.js` 与 `屏幕弹幕组件.js` 顶部明确标注「禁止跨模块直接复用」并将局部工具收敛委托至 `EpiphySpec` / `EpiphyServerCore`；`服务端核心.js` 补齐导出 `safeReadProp` / `safeHasMethod` / `canWritePersistentFiles`，修复 `isChunkLoaded` `getChunkNow()==null` 后未继续回检 `hasChunk`、`forEachEntityNear` 单实体异常隔离（防截断与防误坠 `forEachPlayerNear`），并将 `hasResolvedDir` 守卫收归 `initEpiphyLoggingSink`；`方块与区块组件.js`、`权限阀.js` 与 `屏幕弹幕组件.js` 移除各自重复的 `JsonIO`/`readJsonSafe`/世界存储与零散玩家遍历兜底、直接复用 `BASE` 并抽取 `sendActionNear`；`拆解台-混沌殉爆.v18.js` 显式声明 `priority: 10`、强声明硬前置（`EpiphyServerCore` / `EpiphyWorldOps` / `ScreenDanmaku`）缺载 Fail-Fast、砍除 `fallbackPkt` 及冗余兜底与死常量，`sendDanmakuNear` 浅拷贝 `opts` 防原地篡改、`saveUnstableJobs` 补外部写盘失败告警，并修复 `ServerEvents.unloaded`、`ringFx` (`WORLD_OPS.findLoadedSurfaceY`) 及 `level?.server` POJO 隐患 | [x] |

---

## 5. 现行数据边界与演进契约（后续改造不得破坏）

以下设计已在本仓库落地并通过单元测试验证，后续重构、脚本增删或向 Kotlin + Java 迁移时须严格保持其边界与语义：

1. **`epiphy-data/` 统一外部数据目录与世界分叉边界**：
   - 位置：运行根目录 `epiphy-data/`（客户端 `.minecraft/epiphy-data/`，专用服 `./epiphy-data/`），子目录骨架 `config/`、`worlds/`、`players/`、`events/`、`logs/`、`presets/`、`backups/` 保持预建（禁止为了填满预留目录强加无用功能）。
   - **数据边界**：抗回滚管理/安全数据（权限授权、外部撤销墓碑、模块配置、可读审计日志）入 `epiphy-data/`；须随存档方块状态同步回滚的数据（如 `kubejs_epiphy_bugfix_hp.json`、`kubejs_epiphy_tracked_blocks.json`）仍留 `saves/<world>/`。
   - **世界复制防撞**：外部世界目录采用 `<slug>__<shortId>`，依赖存档内 `data/epiphy_world_id.json` 与外部 `meta.json`（含 `lastWorldPath`）双向校验；路径变更时自动分叉新目录并提醒 OP 手动清理旧目录。
   - **日志规范**：未绑定世界前的启动期日志落盘于 `epiphy-data/logs/`；进入具体存档绑定世界上下文后，运行时日志自动切换至对应世界目录 **`epiphy-data/worlds/<slug>__<shortId>/logs/YYYY-MM-DD.log`**（默认按天输出，配置位于 `epiphy-data/config/logging.json`）。在受 KubeJS `ClassFilter` 屏蔽 `java.io`/`java.nio` 的实机环境中自动降级为 `KubeJSPaths.dir` + `JsonIO` 写盘（无 OS 文件锁）。
2. **“按名字授权”备用模式与 Fail-Closed 边界**：
   - 默认严格 UUID 授权；在提示与配置注释中必须明示：**纯离线服（`online-mode=false`）在无 TrueUUID 类模组且无密码登录插件保护时，仅依靠 UUID 模式同样不安全**。
   - 仅限**真 OP / 控制台**可操作 `/epiphy auth namegrant enable|confirm <code>|disable`（8 位数字 + 随机大小写字母口令，2 分钟有效期）；`auth_mode.json` 须保留 `_warning` / `_consequences` 注释，缺失或异常值一律按 Fail-Closed 处理；关闭后保留未迁移纯名字记录但立即暂停生效。
3. **`authorized` 非 OP 玩家资源隔离与分级权限域原则**：
   - 必须通过 `EpiphyPermissionValve.getCommandActorTier(source)` 区分 `'system'`（JS API / 真 OP / 控制台 / 命令方块 / Declared Callers）与 `'player'`（非 OP `authorized` 玩家）；当权限阀未加载时仅认 `pl.isOp()`（严禁退化信任 `hasPermissions(2)`）。
   - 支持细粒度分层 `scope`（如 `danmaku.self`、`audio.play`）独立授予非 OP；明确撤销子 `scope` 须覆盖父模块授权；标记 `exactScopeOnly` 的高危能力（如 `danmaku.broadcast` / `audio.broadcast`）不得从模块级授权继承。
   - 任何新增音频/弹幕能力不得允许 `'player'` 源绕过命名空间隔离、越权停止 `'system'` 或他人对象，也不得挤压系统演出配额/槽位；同时不得反向给脚本 API、OP、控制台或命令方块施压额外玩家限流。
4. **长期原生化迁出计划**：
   - 本项目在脚本阶段功能与契约充分稳定后，将整体迁往 **Kotlin + Java** 原生模组，KubeJS 仅作此前过渡依赖。
   - **渲染缓存架构备忘（未来原生模组）**：进入独立 Kotlin + Java 实现阶段时，屏幕弹幕的静态片段与离散/稳态逐字缓冲改为采用独立 **`TextureTarget`** 离屏缓存池（自行管理 FBO 生命周期、离屏渲染与 Quad 贴回），直接绕开 MC 原版高频重复走文字渲染管线的开销。
   - **ModernUI 专有快路径与原版回退契约**：ModernUI（LGPL-3.0，兼容 RAL-1.6）专有特性（如 `lookupVanillaLayout(String)`、`'mui_stroke'`/`'sdf_stroke'` `drawTextOutline`、三阶段 `drawUnitsPassGrouped`）允许作为可选快路径调用，但不得改变既有 `'stroke'`/`'glow'`/`'per_char'`/`blur`/`split` 视觉效果，且在缺失 ModernUI、关闭 SDF 着色器或命中 Emoji 位图字体时须无感回退至原版实现并保持 `PROTO_VERSION = 5` 向后兼容。

---

## 6. 工作流、文档同步、版本规范与协议合规

1. **Git 规范与 MC 实例同步**：主仓库位于 `<repo-root>`；每次修改脚本、完成验证并提交至 `<repo-root>` 后，须同步将 `<repo-root>/kubejs` 更新到实机测试实例 `<mc-instance>/.minecraft/kubejs`（保持 `assets/`、`client_scripts/`、`server_scripts/`、`startup_scripts/` 等目录完全一致，勿误删实例内 `probe/`、用户自备版权音乐与运行数据）。重大重构或模块改动前须先提交当前可用基准；严禁将运行期生成的 `epiphy-data/`、`_backup_*/`、`probe/`、`*.log`、`*.tmp`、`*.bak`、`*.mp3`、版权音乐 `children_of_the_city.ogg`、`kubejs/config/epiphy_permissions/` 等提交进版本库。所有读写均须使用 **UTF-8** 编码。
2. **文档与头部版本号同步规范（每次功能/架构改动必做）**：
   - **更新脚本头部注释与版本号**：修改任意 `.js` 组件涉及职责、依赖、降级策略或接口行为变化时，提交前必须检查并同步更新该脚本顶部注释的版本号（如 `EpiphyLog v1.2`、`EpiphyServerCore v2.4`、`EpiphyBlockTracker v2.3`、`EpiphyPermissionValve v5.3`、`ScreenDanmaku v5.6`、`ScreenDanmakuClient v5.7`、`EpiphyAudio v5.6` 等）、职责列表与依赖说明；若涉及共享语义版本常量（如 `EpiphySpec` 中 `AUDIO_SEMVER` 与端侧兜底 `VERSION`），须双端同步递增（网络包 `PROTO_VERSION` 仅在不兼容包结构变更时递增）。不得删除或篡改与改动无关的已有注释。
   - **同步仓库文档**：须同步检查并更新 [`README.md`](README.md)、[`README_EN.md`](README_EN.md)（工程架构表、组件版本号、核心能力与指令/目录说明），以及本文档 [`README-LLM.md`](README-LLM.md) 第 4 节（已解决问题基线表打 `[x]`）与第 5 节（现行契约状态）。
3. **测试定位**：`npm test`（`node tests/pure_functions.test.js`）运行在 Node.js V8 沙盒中，可回归纯函数与模拟命令/权限/音频/弹幕隔离链路，但**无法捕获 Rhino 引擎缺陷与客户端渲染问题**；涉及运行期或画面修改后必须进服核验。
4. **许可证约束（RAL 1.6）**：本项目受 [`LICENSE.md`](LICENSE.md)（现行 `r2`）约束（作者：`Epiphy-iLLUMs + Gemini 4 系列 + Claude 5.5 系列`；吉祥物：`DeepSeek`）。修改代码须保留既有 `RAL-1.6` 文件头与署名；严禁切换为非官方修改/衍生许可证，严禁引入不可调和冲突协议（如 PolyForm Shield License 1.0.0；符合第 2.12/11.8 条源码层隔离标准的纯粹兼容性代码特例除外）或绕开桥接隔离规范直接混编冲突组件。
