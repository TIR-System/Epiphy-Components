# Epiphy KubeJS 组件与魔改脚本集 (`epiphy-kubejs-components`)

[中文 (默认)](README.md) · [English](README_EN.md) · [LLM 工程规范](README-LLM.md) · [许可证 (RAL 1.6)](LICENSE.md)

一套面向 **Minecraft 1.20.1 / Forge 47.x / KubeJS 2001.6.x** 的通用服务端 / 客户端基础组件、双端交互表现引擎（屏幕弹幕 + 3D 空间音频）、机制修复与模组联动脚本集合。

> **项目状态、演进方向与平台定位**
> - **开发阶段声明（⚠️ 早期测试）**：本项目目前仍处于**早期测试阶段**，接口设计、配置格式、命令语法与模块边界尚未冻结——**当前版本行为可能不稳定，后续随时可能出现大量破坏性更新（Breaking Changes）**，暂不建议直接用于对稳定性要求高的长期正式周目。
> - **长期演进方向**：本项目在持续完善与验证后，后续将整体转向 **Kotlin + Java** 原生模组开发，大部分核心组件与玩法机制均会独立脱离脚本层运行；**KubeJS 仅作为当前阶段的过渡期依赖**。
> - **加载器兼容性**：当前主要在 **Forge 47.x** 环境实测；除涉及少量 Forge 特有兼容细节外，核心逻辑与 KubeJS 脚本在**理论上同样兼容 Fabric**，但目前尚未在 Fabric 环境完成实测验证。

---

## 工程架构与模块依赖

### 1. 纵向分层拓扑（纯文字框图）

```text
┌──────────────────────────────────────────────────────────────────────────────────┐
│ Layer 1 · Startup 阶段（跨端契约与资产/内容注册，最先加载）                        │
├──────────────────────────────────────────────────────────────────────────────────┤
│  Epiphy的-Spec与通用工具.js (P:1200) ──► global.EpiphySpec / EpiphyProtocol       │
│  创造模式栏-epiphy.js       (P:1000) ──► global.EpiphyCreativeTab (epiphy:stuff)  │
│     ├──► Epiphy的小玩意-原版_其他Mod的隐藏物品.js                                 │
│     ├──► Epiphy的小玩意-终极拆解台_不稳定.js  (配合 assets/epiphy/ 贴图与模型)    │
│     └──► Epiphy的小玩意_功能测试.js           (联动 Layer 3 弹幕与音频)            │
└────────────────────────────┬─────────────────────────────┬───────────────────────┘
                             │ (可选兜底)                   │ (硬依赖)
                             ▼                             ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│ Layer 2 · Server 基础层（基础设施底座，按 Priority 1100 ──► 900 顺序装配）        │
├──────────────────────────────────────────────────────────────────────────────────┤
│  P:1100  Epiphy的-日志.js         ──► EpiphyLog           (无前置，限频/去重中心) │
│  P:1080  Epiphy的-服务端基础.js   ──► EpiphyServerBase    (可选: Spec / Log)      │
│  P:1050  Epiphy的-方块追踪组件.js ──► EpiphyBlockTracker  (可选: Log)             │
│  P:1000  Epiphy的-权限阀.js       ──► EpiphyPermissionValve (强: ServerBase)      │
│  P:950   Epiphy的-调试组件.js     ──► EpiphyDebug         (可选: Log / 权限阀)    │
│  P:900   Epiphy的-基础bug修复.js  ──► EpiphyBugfix        (零硬依赖; 可选: Log)   │
└────────────────────────────┬─────────────────────────────────────────────────────┘
                             │ global.* API & 延迟注册队列
                             ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│ Layer 3 · Server 业务调度与玩法层                                                │
├──────────────────────────────────────────────────────────────────────────────────┤
│  Epiphy的-屏幕弹幕组件.js (P:500) ◄══ 强依赖: Spec + ServerBase                   │
│                                   ◄── 可选  : Log / BlockTracker / 权限阀         │
│  Epiphy的-音频组件.js     (P:500) ◄══ 强依赖: Spec + ServerBase                   │
│                                   ◄── 可选  : Log / BlockTracker / 权限阀         │
│  拆解台-混沌殉爆.v18.js           ◄══ 依赖  : 终极拆解台_不稳定 + ScreenDanmaku   │
│  合成表-*/*.js                    ◄── 独立配方脚本（原版 / 植物魔法 / 神秘遗物）  │
└──────────────┬──────────────────────────────────────────────┬────────────────────┘
               │ 频道 epiphy:screen_danmaku                   │ 频道 epiphy:audio
               ▼ (S2C 网络包)                                 ▼ (S2C 网络包)
┌──────────────────────────────────────────────────────────────────────────────────┐
│ Layer 4 · Client 渲染与播放层（纯端侧消费，不参与服务端权威判定）                 │
├──────────────────────────────────────────────────────────────────────────────────┤
│  Epiphy的-屏幕弹幕渲染器.js ──► 排版/动画/原生+ModernUI渲染   (可选前置: Spec)   │
│  Epiphy的-音频播放器.js     ──► 3D 声场/衰减/MusicDuck/重连   (可选前置: Spec)   │
│  拆解台描述.js              ──► 客户端物品 Tooltip 描述                          │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### 2. 工程架构速查表

| 架构层 | 核心模块 | 阶段 / Priority | 核心导出 / 职责 |
| :--- | :--- | :--- | :--- |
| **L1 跨端契约** | `Epiphy的-Spec与通用工具.js` | `startup` / `1200` | `EpiphySpec`、`EpiphyProtocol` |
| **L1 内容注册** | `创造模式栏-epiphy.js` | `startup` / `1000` | `EpiphyCreativeTab` (`epiphy:stuff`) |
| **L1 内容注册** | 隐藏物品 / 测试方块 / 失稳拆解台 | `startup` | 物品、测试方块与 5 阶段失稳方块 |
| **L2 基础设施** | `Epiphy的-日志.js` | `server` / `1100` | `EpiphyLog`（限频、去重、`catchWarn`） |
| **L2 基础设施** | `Epiphy的-服务端基础.js` | `server` / `1080` | `EpiphyServerBase`（访问器、路径、DSL） |
| **L2 基础设施** | `Epiphy的-方块追踪组件.js` | `server` / `1050` | `EpiphyBlockTracker v2`（区块段扫描） |
| **L2 安全控制** | `Epiphy的-权限阀.js` | `server` / `1000` | `EpiphyPermissionValve v4`（`/epiphy`） |
| **L2 诊断维护** | `Epiphy的-调试组件.js` | `server` / `950` | `EpiphyDebug v1`（`/epiphy debug`） |
| **L2 独立修复** | `Epiphy的-基础bug修复.js` | `server` / `900` | `EpiphyBugfix v1`（退出 HP 服务端恢复） |
| **L3 业务调度** | `Epiphy的-屏幕弹幕组件.js` | `server` / `500` | `ScreenDanmaku v5` |
| **L3 业务调度** | `Epiphy的-音频组件.js` | `server` / `500` | `EpiphyAudio v5.2` |
| **L3 玩法脚本** | `拆解台-混沌殉爆.v18.js` & `合成表-*` | `server` | 混沌殉爆事件链与配方调整 |
| **L4 客户端表现** | `屏幕弹幕渲染器` / `音频播放器` / `拆解台描述` | `client` | `ScreenDanmakuClient`、`EpiphyAudioClient` |

### 3. 模块依赖与降级语义规范（YAML）

```yaml
# ==================== Layer 1 · Startup ====================
Epiphy的-Spec与通用工具.js:
  requires: { hard: [], optional: [] }
  on_missing:
    - EpiphyServerBase 与客户端引擎各自启用精简内置兜底
    - 服务端弹幕组件与音频组件因缺少硬前置拒绝启动

创造模式栏-epiphy.js:
  requires: { hard: [], optional: [] }
  on_missing: 附属物品无法自动归入统一的 epiphy:stuff 创造模式栏

Epiphy的小玩意-原版_其他Mod的隐藏物品.js:
  requires: { hard: [创造模式栏-epiphy.js] }

Epiphy的小玩意-终极拆解台_不稳定.js:
  requires: { hard: [kubejs/assets/epiphy/ 资源] }

Epiphy的小玩意_功能测试.js:
  requires: { hard: [创造模式栏-epiphy.js], optional: [ScreenDanmaku, EpiphyAudio] }
  on_missing: 缺弹幕或音频时测试方块仍正常注册，交互仅无对应声画触发

# ==================== Layer 2 · Server Foundation ====================
Epiphy的-日志.js:
  requires: { hard: [], optional: [] }
  on_missing: 下游模块回退至原生 console，失去统一限频、once 去重与 debug 开关

Epiphy的-服务端基础.js:
  requires: { hard: [], optional: [EpiphySpec, EpiphyLog] }
  on_missing:
    no_EpiphySpec: 维度归一化与数组判断启用内置精简降级实现
    no_EpiphyLog:  日志包装自动降级为内置限频 console 输出

Epiphy的-方块追踪组件.js:
  requires: { hard: [], optional: [EpiphyLog] }
  on_missing: 下游弹幕/音频的 bindBlock 退化为仅响应放置与破坏的基础监听（无区块扫描与持久化）

Epiphy的-权限阀.js:
  requires: { hard: [EpiphyServerBase], optional: [EpiphyLog] }
  on_missing: 下游 /epiphy 子命令不挂载（OP 登录提示），但业务组件 JS API 仍可调用

Epiphy的-调试组件.js:
  requires: { hard: [KubeJS server global 生命周期], optional: [EpiphyLog, EpiphyPermissionValve] }
  on_missing: 缺权限阀时不注册 /epiphy debug 指令，指标快照仍可通过 global.EpiphyDebug 读取

Epiphy的-基础bug修复.js:
  requires: { hard: [], optional: [EpiphyLog] } # 设计定位为零硬依赖可独立放入运行
  on_missing: 缺日志组件时平滑回退内置限频 console

# ==================== Layer 3 · Server Scheduling & Gameplay ====================
Epiphy的-屏幕弹幕组件.js:
  requires:
    hard:     [EpiphySpec, EpiphyProtocol, EpiphyServerBase]
    paired:   [Epiphy的-屏幕弹幕渲染器.js]
    optional: [EpiphyLog, EpiphyBlockTracker, EpiphyPermissionValve]
  on_missing:
    no_client: 服务端 API 可正常调用，客户端无接收与画面渲染
    optional:  各可选组件均按单层明确降级，不阻断核心调度

Epiphy的-音频组件.js:
  requires:
    hard:     [EpiphySpec, EpiphyProtocol, EpiphyServerBase]
    paired:   [Epiphy的-音频播放器.js]
    optional: [EpiphyLog, EpiphyBlockTracker, EpiphyPermissionValve]
  on_missing:
    no_client: 服务端句柄可正常调度，客户端无声音输出
    optional:  各可选组件均按单层明确降级，不阻断常规播放 API

拆解台-混沌殉爆.v18.js:
  requires:
    hard:     [Epiphy的小玩意-终极拆解台_不稳定.js, ScreenDanmaku]
    optional: [kubejs/assets/epiphy/ 语言与资源]

# ==================== Layer 4 · Client ====================
Epiphy的-屏幕弹幕渲染器.js:
  requires: { paired: [ScreenDanmaku], optional: [EpiphySpec, EpiphyProtocol] }
  on_missing: 缺 Startup Spec 时启用内置 v5 协议常量与基础工具兜底

Epiphy的-音频播放器.js:
  requires: { paired: [EpiphyAudio], optional: [EpiphySpec, EpiphyProtocol] }
  on_missing: 缺 Startup Spec 时启用内置 v5 协议常量与基础工具兜底
```

---

## 核心功能说明

1. **通用基础设施**：统一收拢跨端协议常量与解析规范（`EpiphySpec`）、限频与去重日志（`EpiphyLog`）、服务端对象与 Brigadier 命令树 DSL（`EpiphyServerBase`）、渐进式区块段方块扫描追踪（`EpiphyBlockTracker`）、基于 `Class.isInstance` 源类型鉴权与按世界授权管理的 `/epiphy` 指令中心（`EpiphyPermissionValve`）、动态性能监控与健康自检（`EpiphyDebug`），以及不依赖前置的纯服务端退出 HP 保留与延迟恢复修复（`EpiphyBugfix`）。
2. **双端交互表现引擎**：
   - **屏幕弹幕（`ScreenDanmaku v5`）**：归一化屏幕坐标与 HUD 禁区避让、多段打字机、`per_char` 单字震动、描边/发光、局部富文本标签（`<b>`/`<big>`/`<scale=...>`/`<shake>`/`<outline>`）、`once` / `active` 双生命周期与方块绑定。
   - **空间音频（`EpiphyAudio v5.2`）**：固定位置/方块/追踪实体/维度/全局声场、衰减曲线、出界静音与恢复、邻近同源方块 `merge` 簇合并、背景音乐避让（`duckMusic`）与客户端断流退避重连。
3. **内容与玩法拓展**：`epiphy:stuff` 创造模式物品栏与隐藏物品收录（含混沌晶体 CCL 3D OBJ + Chaos Shader 物品渲染）、`epiphy:rnfmabj_test` 测试方块、暮色森林终极拆解台 5 阶段失稳殉爆与遗物豁免机制，以及原版/植物魔法/神秘遗物部分配方调整。

---

## 目录结构

```text
.
├── kubejs/
│   ├── assets/epiphy/            # 音频资源 (.ogg/.mp3)、模型、材质、方块状态与简体中文语言文件
│   ├── client_scripts/           # 客户端屏幕弹幕渲染器、空间音频播放器与 Tooltip 描述
│   ├── server_scripts/           # 服务端底座、权限/调试/Bug修复、弹幕/音频调度与玩法配方
│   ├── startup_scripts/          # 启动期 Spec/协议底座、物品/方块/创造栏注册
│   └── config/                   # KubeJS 基础配置
├── docs/
│   └── kube-mods-rhino-es5-es6-compatibility.md  # kube-mods/rhino 实测兼容性与语义偏移参考
├── tests/
│   └── pure_functions.test.js    # Node 沙盒与纯函数测试套件
├── README.md                     # 中文自述（默认）
├── README_EN.md                  # 英文自述
├── README-LLM.md                 # 面向 AI 协作者的工程准则与跨上下文交接备忘
└── LICENSE.md                    # RAL 1.6 相互开源署名许可证完整文本
```

---

## 安装与测试

### 安装到游戏整合包
1. 当前过渡期运行要求：**Minecraft 1.20.1 / Forge 47.x / KubeJS 2001.6.x**（理论上兼容 Fabric，未实测）。
2. 将 `kubejs/` 合并放入客户端 `.minecraft/` 与服务端根目录。
3. 管理员可在游戏内通过 `/epiphy help`、`/epiphy auth list`、`/epiphy debug` 查看帮助、授权状态与性能面板。

### 本地沙盒单元测试
```bash
npm test
```

> **提示**：Node.js 沙盒（V8）仅能校验纯 JS 逻辑与模拟契约，无法替代游戏内 `kube-mods/rhino` 及双端渲染实测；提交语法、Java 互操作或渲染改动前请参考 [`docs/kube-mods-rhino-es5-es6-compatibility.md`](docs/kube-mods-rhino-es5-es6-compatibility.md) 并进服验证。

---

## 作者与分工

- **Epiphy-iLLUMs**：项目发起人、玩法设计、核心维护者；同时负责大量基础功能的设计与实现、工程结构制定、模块化构思、纠错与重构建议。
- **Gemini 4 系列**：架构协助、组件开发与问题排查。
- **Claude 5.5 系列**：架构协助、组件开发、纠错与优化建议。
- **DeepSeek**：吉祥物（Mascot）。

---

## 许可证 (License)

本项目适用 **RAL 1.6（Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6）**，完整法律文本见根目录 [`LICENSE.md`](LICENSE.md)。

要点摘要（发生任何解释歧义时一律以 [`LICENSE.md`](LICENSE.md) 中文正式文本为准）：
- **源代码可用型相互开源**：保障修改与分叉（Fork）自由，并要求优先保留原作者及贡献者合理署名；
- **严格相互义务**：修改、衍生、静态链接及动态链接依赖均触发开源义务，禁止通过外层封装或“桥接之壳”规避；
- **商业与转售边界**：允许作为非主要交付对象集成于商业产品，但**严禁将本作品本身作为独立商品直接收费转售**；用于托管服务须公开开源全栈；
- **冲突协议禁令**：禁止引入不可调和冲突许可证（如 PolyForm Shield License 1.0.0），亦严禁切换至非官方数字版本号的修改或衍生版协议。
