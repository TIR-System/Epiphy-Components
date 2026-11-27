# KubeJS 原型验证期历史问题修复归档（P0 ~ P3）

> **说明**：本文件归档自 `README-LLM.md` 原第 4 节，记录纯 KubeJS 原型探索阶段（`legacy-kubejs` 分支封存前）已定位并解决的历史问题基线，供追溯协议设计与边界成因时查阅。现行工程准则请以根目录 [`AGENTS.md`](../../AGENTS.md) 与 [`README-LLM.md`](../../README-LLM.md) 为准。  
> **许可证声明 (License)**：本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)。

| 问题 / 缺陷描述 | 影响模块 | 当时采用的解决措施 | 状态 |
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
| 单元测试 `requires`/三重加载/`console`/音频端侧包往返盲区 | `tests/pure_functions.test.js` | 校验 Brigadier `_req` 权限门禁与命令执行；移除重复加载并断言单次加载 `ServerEvents.tick` 数量；补全服务端 `_sent` 包到 `EpiphyAudioClient` 的往返测试 | [x] |
| 渲染器 P1 缺陷群（续期漏同步 `tier`/`maxGroupSize`、无排队/帧预算/文本/scale 上限、batch 异常降格、永久降级、闪烁破坏缓存、`hasKeyInTag` fail-open） | `Epiphy的-屏幕弹幕渲染器.js` | 续期同步 `tier`/`maxGroupSize` 并复用 `enforceOverlayCaps`；增加 `maxPendingActions`/`maxPendingPerFrame`/`frameBudgetMs`/文本截断与 `maxScale` 上限；`BATCH_FAILED`/ModernUI 降级改为 `10s` 冷却恢复；移除 `blinkCursor` 缓存键并用几何绘制光标；`hasKeyInTag` 异常改 fail-closed 返回 `false` | [x] |
| 音频 双端 P1 缺陷群（`countedListeners` 漏减、未启动僵尸句柄、`pendingReset` 先清零、扫描 O(n²) 重建、`syncIntervalTicks=0`、无阀回落 `hasPermissions(2)`、`duckMusic` 停他模组 BGM、3D `Channel` 坐标静止等） | `Epiphy的-音频组件.js` / `Epiphy的-音频播放器.js` | 抽取 `releasePlayerListenCount`；增加未启动超时与实体丢失清理；先广播成功再置 `pendingReset=false`；缺失阀改为仅认 `isOp()`；`duckMusic` 改为仅对 `minecraft:` 命名空间执行 `Channel.pause`/`unpause`；同步 `Channel.setSelfPosition(Vec3)` 与 `AbstractSoundInstance` 坐标 | [x] |
| 弹幕 P1 缺陷群（拆块无命名空间误清、`null`/无效维度回落主世界、`stop`/`clear` 无频控、`onFound('scan')` 全清缓存、API 无包上限、`myIdx` 缺失仲裁失效） | `Epiphy的-服务端基础.js` / `Spec与通用工具.js` / `Epiphy的-屏幕弹幕组件.js` | 绑块清理限定 `blk:<blockId>` + `maxSeenPriority`；`resolveLevel`/`clearNear`/`deactivateNear` 无效维度 fail-closed；为 `stop`/`clear` 增加独立分桶防刷频；`'scan'` 改定向清缓存与球簇 AABB 预过滤；增加 `SYSTEM_PACKET_LIMITS` | [x] |
| 非 OP `authorized` 权限粒度过粗与单指令按需授权缺失，及 `RAL-1.6` 文件头补齐 | `权限阀` / `服务端基础` / `弹幕组件` / `音频组件` / 全仓 `.js` | 实现 `module` -> `module.action` 分层权限与 `exactScopeOnly` 广播门 (`danmaku.broadcast` / `audio.broadcast`)；新增 `/epiphy danmaku self` 与 `/epiphy auth scopes` | [x] |
| 实机 Forge 1.20.1 SRG 环境下音频无法播放及右下角字幕未注册 | `Epiphy的-音频播放器.js` | 修复 `getMc()` 与 SRG 字段映射；为 `getSoundEvent` 冷加载新增宽限期与重试退避，避免 `attCache` 永久写入 `-1` | [x] |
| 实机 KubeJS 2001.6.5 / Rhino Java 互操作异常与重进世界测试方块弹幕不触发 | `Spec与通用工具` / `服务端基础 v2.2` / `方块追踪组件 v2.1` / `屏幕弹幕组件 v5.3` 等 | 改用 `safeTypeOf`/`isObjectLike`/`isJavaMapLike` 隔离 Rhino `MemberType.get` 异常；`toSeqArray` 排除 `java.util.Map`；重进世界延迟补发 | [x] |
| 实机 `kube-mods/rhino` 下 `try` 块内具名函数声明退化为 `undefined` | `Epiphy的-屏幕弹幕组件.js` / `Epiphy的-权限阀.js` | 将 `normalizeBoundSpec` 改为 `var ... = function` 赋值形式并移出 `try` 块；补齐 `'strict_op'` 归一化映射 | [x] |
| 实机 KubeJS `ClassFilter` 屏蔽 `java.io`/`java.nio` 导致世界目录重复生成 | `Epiphy的-日志.js v1.2` / `Epiphy的-服务端基础.js v2.3` | 新增 `worlds/worlds_index.json` 与 `anchor.folderName` 探测替代 `File.listFiles()`；`EpiphyLog` 支持进档后自动切换至世界子目录 | [x] |
| 逐字震动/内联混排热路径优化与 ModernUI 可选直连适配 | `Epiphy的-屏幕弹幕渲染器.js v5.3 ~ v5.7` | 合并同样式连续静态片段、二分定位可见区间、视口外裁剪、缓存矩阵减少跨界调用、分 Pass 合批绘制 | [x] |
| 2D 平面合成器 (`Epiphy2DSurface` / `Epiphy2DRenderer v6.0 ~ v6.3`)、`surface: 'world_plane'` 与通用 3D 子系统 (`P3-1` & `P3-2`) 落地 | `Spec与通用工具.js v2.8.1` / `平面渲染组件与渲染器 v6.3.0` / `物品三维渲染器 v1.1.0` / `空间特效组件与渲染器` | 完成 6 类 2D 图元、`ui()` 与 `fx()` 链式构造器、`channel`/`slot` 增量 `patch`、跨重启 `world_plane` 持久化、修复 `NativeMath` 8 常量缺失问题，并将具体测试武器下沉为下游案例脚本 | [x] |
