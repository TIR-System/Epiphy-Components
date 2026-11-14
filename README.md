# Epiphy KubeJS 组件与魔改脚本集 (`epiphy-kubejs-components`)

[中文 (默认)](README.md) · [English](README_EN.md) · [LLM 协作规范](README-LLM.md) · [许可证 (RAL 1.6)](LICENSE.md)

一套面向 **Minecraft 1.20.1 / Forge 47.x / KubeJS 2001.6.x** 的通用服务端 / 客户端基础组件、双端交互表现引擎（屏幕弹幕 + 3D 空间音频）、机制修复与模组联动魔改脚本集合。

---

## 核心功能概览

### 1. 通用基础设施底座（`kubejs/**/通用组件/`）

| 组件脚本 | 阶段 / Priority | 核心职责 |
| :--- | :--- | :--- |
| `Epiphy的-Spec与通用工具.js` | `startup` / `1200` | 定义共享协议常量（`EpiphyProtocol`）、优先级/字号/时长/颜色/倾角/命令行参数解析器与球簇合并几何算法（`EpiphySpec`） |
| `Epiphy的-日志.js` | `server` / `1100` | 统一限频警告、`catchWarn` 软异常处理、`once` 去重与按模块开关的调试日志（`EpiphyLog`） |
| `Epiphy的-服务端基础.js` | `server` / `1080` | Java 类缓存、MC 实体/维度/位置访问器、存档级路径解析、`createCommandBuilder` Brigadier DSL 与延迟注册队列（`EpiphyServerBase`） |
| `Epiphy的-方块追踪组件.js` | `server` / `1050` | 全服物理方块追踪表与渐进式 `16×16×16` 区块段扫描、多模块订阅共享与持久化（`EpiphyBlockTracker v2`） |
| `Epiphy的-权限阀.js` | `server` / `1000` | 接管 `/epiphy` 根指令与帮助聚合，基于 `Class.isInstance` 的严格调用源甄别（玩家/OP/命令方块/控制台/声明式脚本调用）与按世界授权持久化（`EpiphyPermissionValve v4`） |
| `Epiphy的-调试组件.js` | `server` / `950` | `/epiphy debug` 动态运行指标面板、健康自检与维护动作注册表（`EpiphyDebug v1`） |
| `Epiphy的-基础bug修复.js` | `server` / `900` | 纯服务端权威的退出 HP 记录与重进延迟结算恢复（解决重进世界时属性修饰符加载晚于 `setHealth()` 导致高血上限玩家血量被压回 20 的问题，零客户端信任） |

### 2. 双端交互表现引擎

- **屏幕弹幕与文本演出（`ScreenDanmaku v5` + `ScreenDanmakuClient v5`）**
  - 文件：`Epiphy的-屏幕弹幕组件.js`（服务端）+ `Epiphy的-屏幕弹幕渲染器.js`（客户端）
  - 支持相对屏幕坐标与常见 HUD 禁区避让、多段打字机、`per_char` 逐字微震动、描边与外发光、内联富文本标签（`<b>`、`<big>`、`<scale=...>`、`<shake>`、`<outline>`）、`once` / `active` 生命周期、多种退场动效及物理方块位置绑定。
- **空间音频与流式声场（`EpiphyAudio v5.2` + `EpiphyAudioClient v5.2`）**
  - 文件：`Epiphy的-音频组件.js`（服务端）+ `Epiphy的-音频播放器.js`（客户端）
  - 支持固定坐标 / 方块 / 追踪实体 / 全维度 / 全服广播，线性/平滑/截断衰减曲线、出界暂停与恢复、邻近方块声源 `merge` 簇合并、原版音乐避让（`duckMusic`）、心跳续期与客户端异常断流退避重连。

### 3. 游戏内容、合成表调整与玩法脚本

- **创造模式栏与隐藏物品收录**：`创造模式栏-epiphy.js`（`epiphy:stuff`）、`Epiphy的小玩意-原版_其他Mod的隐藏物品.js`（收录屏障、刷怪蛋、命令方块系列、物品化传送门、带 CCL 3D OBJ + Chaos Shader 渲染的混沌晶体、`神秘遗物` 建筑师的青睐、`诡厄巫法·启示录` 终末之环等）。
- **指令广播测试方块**：`Epiphy的小玩意_功能测试.js`（`epiphy:rnfmabj_test`，用于弹幕 + 音频联动展示与性能压测）。
- **拆解台 · 混沌殉爆 v18**：`拆解台-混沌殉爆.v18.js` + `Epiphy的小玩意-终极拆解台_不稳定.js` + `拆解台描述.js`（围绕暮色森林终极拆解台的 5 阶段失稳演进、防破坏缩短倒计时、终望珍珠吞噬异常停机、七咒之戒 / 终末之环等遗物豁免与混沌爆炸清理）。
- **配方魔改**：`合成表-原版/附魔苹果.js`、`合成表-植物魔法/活木根.js`、`合成表-魔法遗物相关/七咒.js`。

---

## 目录结构

```text
.
├── kubejs/
│   ├── assets/epiphy/            # 音频资源 (.ogg/.mp3)、模型、材质、方块状态与简体中文语言文件
│   ├── client_scripts/           # 客户端渲染与音频播放引擎、物品 Tooltip 描述
│   ├── server_scripts/           # 服务端核心底座、权限/调试/修复组件、弹幕/音频调度与玩法配方
│   ├── startup_scripts/          # 启动期共享 Spec/协议底座、物品/方块/创造栏注册
│   └── config/                   # KubeJS 基础配置
├── docs/
│   └── kube-mods-rhino-es5-es6-compatibility.md  # kube-mods/rhino 实测兼容性与语义偏移参考
├── tests/
│   └── pure_functions.test.js    # Node 沙盒与纯函数测试套件
├── README.md                     # 中文自述（默认）
├── README_EN.md                  # 英文自述
├── README-LLM.md                 # 面向 LLM / AI 协作者的工程原则与上下文备忘
└── LICENSE.md                    # RAL 1.6 相互开源署名许可证完整文本
```

---

## 安装与测试

### 安装到游戏整合包
1. 确保目标端运行 **Minecraft 1.20.1 / Forge 47.x / KubeJS 2001.6.x**。
2. 将本仓库下的 `kubejs/` 目录合并放入客户端 `.minecraft/` 与服务端根目录（资源与脚本需双端一致，仅服务端单跑时缺失客户端脚本仍可降级运行但不输出端侧画面/音频）。
3. 进入游戏后可通过 `/epiphy help` 查看已挂载子命令，通过 `/epiphy auth list`、`/epiphy debug`（需 OP）管理授权与诊断性能。

### 本地沙盒单元测试
本仓库提供面向纯函数与指令/权限行为的 Node.js 沙盒测试（不依赖启动 Minecraft 客户端）：

```bash
npm test
```

> **提示**：Node.js 沙盒仅能验证 JS 逻辑正确性；KubeJS 运行期依赖定制版 `kube-mods/rhino`（与 V8/标准 ES6 存在语义差异），任何语法、Java 互操作与客户端 ModernUI 渲染改动仍需结合 [`docs/kube-mods-rhino-es5-es6-compatibility.md`](docs/kube-mods-rhino-es5-es6-compatibility.md) 与游戏内实测验证。

---

## 演进路线（规划中）

- 建设独立的运行外部数据根目录 `.minecraft/epiphy-data/`（服务端 `./epiphy-data/`），拆分 `config/`、`worlds/`、`players/`、`events/`、`logs/`、`presets/`、`backups/`，配合世界 `worldId` 指纹与复制世界自动分叉机制解决世界回滚复活权限与重名串读问题。
- 增加默认严格 UUID 鉴权、双入口二次确认“按名字授权”备用模式，以及 `authorized` 玩家在音频/弹幕上的来源归属隔离与资源配额保护。

---

## 作者与贡献者

- **Epiphy-iLLUMs**（项目发起人、玩法设计、核心维护者）
- **Gemini 4 系列**（架构协助、组件开发与问题排查）
- **Claude 5.5 系列**（架构协助、组件开发与审计优化）

---

## 许可证 (License)

本项目适用 **RAL 1.6（Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6）**，完整条款见根目录 [`LICENSE.md`](LICENSE.md)。

要点摘要（最终法律解释以 [`LICENSE.md`](LICENSE.md) 中文正式文本为准）：
- **源代码可用型相互开源**：保留修改与分叉（Fork）自由，须优先保留原作者及贡献者合理署名；
- **强相互义务**：修改、衍生、静态链接或动态链接依赖均触发开源义务，禁止通过外层封装或“桥接之壳”规避；
- **商业与转售边界**：允许作为非主要交付对象集成进商业产品，但**严禁将本作品本身作为独立商品直接收费转售**；提供托管服务（SaaS 等）须满足开源全栈要求；
- **冲突协议禁令**：禁止引入与分叉自由冲突的许可证（如 PolyForm Shield License 1.0.0），亦不得擅自切换为非官方数字版本的修改/衍生协议。
