# README-LLM — AI 协作者工程准则与跨上下文交接备忘

> **必读文档**：开始阅读或修改任何 `.js` 脚本前，**请先完整阅读 [`docs/kube-mods-rhino-es5-es6-compatibility.md`](docs/kube-mods-rhino-es5-es6-compatibility.md)**。
> 如果你是第一次打开本仓库，请把本文件当作不可违背的工程基线——里面记录了大量换一个上下文窗口就会丢失、但违背即出严重 Bug 的实战踩坑结论。

---

## 1. 运行时铁律：KubeJS `kube-mods/rhino` 兼容性与语义偏移

本项目的运行环境是 **Minecraft 1.20.1 / Forge 47.x / KubeJS 2001.6.x** 内置的定制版 Rhino 引擎（`dev.latvian.mods.rhino`，纯 `Interpreter` 解释执行）。**它不是 Node.js/V8，也不是标准 Rhino。**

### 必须遵守的语法规范
1. **变量声明全系强制使用 `var`**：
   - 基础底座与弹幕模块保持 **严格模式兼容的 ES5 子集**；
   - 音频模块（`Epiphy的-音频组件.js` / `Epiphy的-音频播放器.js`）允许使用经实测稳定的 ES6 子集（`=>`、模板字符串、`for..of`、`Map`、`Set`），但**同样严禁引入 `let`/`const`**。
2. **明确禁用的语法 / 特性（绝对不要写）**：
   - ❌ **`??`（空值合并运算符）**：`kube-mods/rhino` 的 `Interpreter.doNullishCoalescing` 存在严重解释器栈 Bug——未同步 `double[]` 数字栈，`null ?? 9`、`undefined ?? 9` 等数字兜底会错误返回 **`0`** 或相邻栈槽残留数字！**一律改写为 `(v !== null && v !== undefined) ? v : fallback` 或 `v != null ? v : fallback`。**
   - ❌ **`let` / `const`**：在 `kube-mods/rhino` 中无 TDZ；`for (let ...)` / `for (let ... of/in ...)` **没有每轮独立绑定**，闭包会全部共享最终迭代值；单语句 `if (true) let x = 1;` 会向外部作用域泄漏；`const` 允许无初始值且非严格模式下重写静默失败。
   - ❌ **对象简写与计算属性**：`{ x, y }` 和 `{ [key]: v }` 均直接报 `SyntaxError`。必须写完整 `{ x: x, y: y }`。
   - ❌ **`...` 展开与剩余语法、默认参数、解构默认值**：`[...arr]`、`fn(...args)`、`function(a = 1)`、`var {a = 1} = obj` 均解析报错。
   - ❌ **`class` / `import` / `export`、`Promise` / `async` / `await`、`Proxy` / `Reflect`、`TypedArray` / `BigInt`、正则 `/u` 与 `/y` 标志**。
3. **语义偏移注意**：
   - `'use strict'` 下独立函数调用的 `this` 仍为 `[object Object]`（不是 `undefined`）；
   - `'use strict'` 下直接 `eval` 会泄漏 `var` 到外层函数，间接 `eval` 会直接抛 `RuntimeException: eval is not allowed!`；
   - **`JSON.stringify` 被 KubeJS 魔改**：对象上的 `undefined` 字段会变成 `null`、函数属性会被反射展开为 Java 类成员数组、整数会被输出为 `1.0`。序列化纯数据时务必主动剔除函数与不需要的 `undefined` 字段。

---

## 2. Java / Forge / ModernUI 互操作实测坑位（换上下文极易重踩）

1. **`WindowsPath` 与世界路径拼接**：
   - Windows 下 `server.getWorldPath(LevelResource.ROOT)` 返回 `sun.nio.fs.WindowsPath`，其字符串化结果可能带 `/.` 尾缀或反斜杠 `\`，直接拼文件名会写出非法路径或跨目录失败。所有路径构造先规范化分隔符与尾缀（见 `Epiphy的-服务端基础.js` 的 `resolveWorldStorageInfo`）；`JsonIO.write` 也不会自动建目录，落盘前须走 `ensureParentDir`。
2. **Rhino 中的 Java 对象引用与类型校验**：
   - **不要依赖文件名、字符串 `.toString()` 或 `className.indexOf(...)` 判断权限/调用源！** 权限与安全边界一律使用 `Java.loadClass(...)` + `isInstance(...)`（参考 `Epiphy的-权限阀.js`）。
   - 同一底层 `ServerPlayer` 经过 KubeJS 事件/命令回调包装后，JS `===` 未必相等；需要身份同一性时比较 UUID 或 Java 引用包装。
   - 调用存在重载的 Java 图形/数学方法时（如 Client `GuiGraphics.scale(float, float)` vs `scale(float, float, float)`），必须像 `Epiphy的-屏幕弹幕渲染器.js` 那样先显式探测重载签名或做保护。
3. **ModernUI 客户端弹幕渲染性能与亮度坑**：
   - 本服实装了 ModernUI，频繁的 `PoseStack` 矩阵操作、多余的 JNI/Java 方法跨界调用，或单字全量 `glow` + `blur` 多次重绘会导致客户端帧率骤降；同时修改字形绘制通道 / Alpha / 阴影时极易引发**弹幕整体或局部亮度异常**。
   - 任何涉及 `Epiphy的-屏幕弹幕渲染器.js` 的绘制改动，**不能只跑 `npm test`，必须进服截图或实测核对亮度与帧率**。
4. **Forge `CommandSourceStack.withPermission(int)` 提权陷阱**：
   - 大量外部模组（指令书、终端、CC 海龟、任务奖励）会调用 `source.withPermission(2/4)` 临时抬高指令栈等级，同时保留 `source.source === ServerPlayer`。
   - **因此绝对禁止通过 `source.hasPermission(lv)` 判定玩家是否为 OP！** 必须穿透到底层真实 `ServerPlayer` 并检查 `player.isOp()` / `player.hasPermissions(lv)` / `PlayerList.isOp(profile)` / 单人房主（参见 `Epiphy的-权限阀.js` `isPlayerAdmin`）。
   - 同时保留 `RESERVED_SUBCOMMANDS`（`auth`、`help` 不可作为预设别名，也禁止 `withDeclaration` / 脚本代调 `auth`）。

---

## 3. 核心架构与编码原则

1. **大规模收敛，但避免过度抽象损害可读性**：
   - 跨端协议常量、纯参数解析器（优先级、字号、颜色、时长、倾角、命令行 Spec）与共享几何算法统一放在 `kubejs/startup_scripts/通用组件/Epiphy的-Spec与通用工具.js`（`priority: 1200`）；
   - 服务端共享基建（日志包装、Java 类缓存、存档路径解析、`createCommandBuilder`）收拢在 `kubejs/server_scripts/通用组件/Epiphy的-服务端基础.js`（`priority: 1080`）。
   - 在写重复样板前先检查这两处是否已有通用工具；同时保持函数短小、逻辑直观，不为“看起来抽象”而拆碎调用链。
2. **禁止“兜底的兜底的兜底”无限套娃**：
   - 核心硬前置缺失应直接暴露明确错误（Fail-Closed / Fail-Fast），而不是一层层写冗余降级掩盖问题。
   - 仅保留面向可独立运行设计或明确标明的可选依赖单层轻量降级（例如 `EpiphyLog`、`EpiphyBlockTracker` 缺失时的单层明确降级；`Epiphy的-基础bug修复.js` 设计定位即“零前置硬依赖、仅可选接入日志”）。
3. **零客户端信任与安全默认值**：
   - 玩家血量快照（`Epiphy的-基础bug修复.js`）、授权名单、权限校验等安全/数值敏感逻辑一律以服务端为准，**绝不读取或信任客户端上行报文里的数值**。
   - 解析安全布尔开关、协议版本号时坚持 **Fail-Closed**：缺字段、损坏 JSON、版本不匹配一律按拒绝/`false` 处理，不静默放行。
4. **限频日志与“软异常不染红”**：
   - 运行期非致命或第三方对象导致的异常走 `catchWarn`（`console.warn` + 限频窗口），避免刷屏或触发 KubeJS 把已安全处理的异常算作脚本加载报错。

---

## 4. `epiphy-data/` 统一数据目录与安全演进契约（既定设计）

后续涉及持久化扩展、权限升级与独立文件存储，须遵守以下已与仓库所有者对齐的架构约定（避免改回旧方案或重做冲突方案）：

1. **目录定位与职责划分**：
   - 在运行根目录建立统一外部数据目录 `epiphy-data/`（客户端/整合包位于 `.minecraft/epiphy-data/`，专用服位于 `./epiphy-data/`），预建骨架：`config/`、`worlds/`、`players/`、`events/`、`logs/`、`presets/`、`backups/`（配套 `.tmp` 原子写入 + `.bak` 备份；**不为了填满空目录硬加无关功能，也不漏迁已有需要抗回滚的模块数据**）。
   - **抗回滚数据进 `epiphy-data/`**：权限授权与撤销墓碑、模块配置、审计日志。
   - **随世界方块同步回滚数据留 `saves/<world>/`**：如物理方块追踪绑定等若随存档回滚更合理的状态；需根据语义明确区分，不可混放导致回滚后状态撕裂。
   - **`logs/` 默认按天输出可读性高的文本日志**（如 `YYYY-MM-DD.log`），并在 `config/` 提供可切换的轮转/记录模式配置。
2. **世界防重名与复制档自动分叉**：
   - 外部世界目录使用 **`<可读世界名slug>__<短ID>`**，结合世界内稳定 `worldId` 锚点与外部 `meta.json`（含 `lastWorldPath` 等指纹）。
   - **关键规则**：若读到相同 `worldId` 但目录路径与 `lastWorldPath` 不同（典型场景：玩家把正式存档复制改名作测试档），必须**自动分叉**生成新的 `worldId` 与新世界目录，并在服务端日志清晰提示“已自动分叉，如需清理可自行进入对应文件夹删除”，防止测试档污染正式档数据。
3. **“按名字授权”备用模式规范**：
   - **默认严格使用 UUID 授权**；在所有相关文档、命令提示与配置注释中必须写明：**纯离线服（`online-mode=false`）且既无 TrueUUID 类修复 mod 也无密码登录插件保护时，只靠 UUID 模式也同样不安全（可被同名顶号）**。
   - **双重开启方式**：
     1. *游戏内指令*：仅限**真 OP / 控制台**（`allowAuthorized: false`、禁止命令方块）；首次输入打印完整风险告示（含“谁先用该名字上线谁永久继承”、“有密码登录插件可忽略”等）并生成一段 **8 位随机（数字 + 大小写字母）口令**，限 **2 分钟（120 秒）内**由同一操作者二次输入确认才启用。
     2. *`epiphy-data` 手动改 JSON*：生成配置时默认 `false`，并在相邻字段带完整注释说明 **“将该值改为 `true` 会有什么后果”**。
   - **中途关闭回退**：当切回 `false` 后，未迁移的按名字授权记录**保留在文件内不删，但立即暂停生效**。
4. **`authorized` 资源 DoS 与管理员演出的隔离方向（待落地）**：
   - 为音频句柄与弹幕包建立 `'system'`（脚本 API / 真 OP / 控制台 / 命令方块）与 `'player'`（`authorized` 玩家命令）双轨来源标识与 `ownerUuid`：
     - `authorized` 玩家不可 `stop`/`clear`/`update` 或凭撞 `key`/`group` 覆盖 `'system'` 及他人创建的音频/弹幕；
     - `authorized` 命令 `priority` 封顶（如 `<= 3`），全局池与每人 `12` 听觉槽位不许玩家反挤系统音频（高优系统音频可反向驱逐玩家级句柄）；
     - 仅在“玩家命令解析入口”夹紧弹幕 `scale`、文本长度、换行数、`stay` 时长及触发频次，**绝不限制 KubeJS 脚本 API 与 OP 的正常演出上限**。

---

## 5. 开发工作流、测试边界与版权红线

1. **Git 仓库与变更纪律**：
   - 仓库位于 `D:\Git-Epiphy`；每次进行较大修改或重构前，先提交当前可用状态，保持可回退与干净的 diff。
   - **勿将运行期数据与本地测试垃圾提交入库**：如 `epiphy-data/`、`_backup_*/`、`probe/`、`*.log`、`*.tmp`、`kubejs/config/epiphy_permissions/` 等。
   - 仓库包含大量中文文件名与注释，读写脚本时务必明确使用 **UTF-8** 编码，不要用默认系统编码或覆盖破坏原有说明注释。
2. **测试认知边界**：
   - 运行 `npm test`（`node tests/pure_functions.test.js`）可快速回归纯函数与沙盒交互；
   - **但 V8 无法模拟 `kube-mods/rhino` 的语法缺失、栈 Bug（如 `??`）、Java 重载与 ModernUI 渲染**——`npm test` 全绿不等于游戏内零报错。
3. **协议红线（RAL 1.6）**：
   - 本仓库全量受 [`LICENSE.md`](LICENSE.md)（RAL 1.6）约束：作者为 `Epiphy-iLLUMs + Gemini 4 系列 + Claude 5.5 系列`。
   - 新增或修改文件头时保留 `RAL-1.6` 与系列协作声明；严禁切换为非官方修改/衍生版许可证，严禁直接混入存在不可调和冲突的第三方代码（如 PolyForm Shield 1.0.0），遇到可豁免冲突的第三方库须严格按 RAL 1.6 附录 A 通过独立桥接子模块隔离。
