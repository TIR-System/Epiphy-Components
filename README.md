# Epiphy KubeJS 组件与魔改脚本集 (`epiphy-kubejs-components`)

[中文 (默认)](README.md) · [English](README_EN.md) · [LLM 工程规范](README-LLM.md) · [许可证 (RAL 1.6)](LICENSE.md)

一套面向 **Minecraft 1.20.1 / Forge 47.x / KubeJS 2001.6.x** 的通用服务端 / 客户端基础组件、双端交互表现引擎（屏幕弹幕 + 3D 空间音频）、机制修复与模组联动脚本集合。

> **项目状态、演进方向与平台定位**
> - **开发阶段声明（⚠️ 早期测试）**：本项目目前仍处于**早期测试阶段**，接口设计、配置格式、命令语法与模块边界尚未冻结——**当前版本行为可能不稳定，后续随时可能出现大量破坏性更新（Breaking Changes）**，暂不建议直接用于对稳定性要求高的长期正式周目。
> - **长期演进方向**：本项目在持续完善与验证后，后续将整体转向 **Kotlin + Java** 原生模组开发，大部分核心组件与玩法机制均会独立脱离脚本层运行；**KubeJS 仅作为当前阶段的过渡期依赖**。
> - **加载器兼容性**：当前主要在 **Forge 47.x** 环境实测；除涉及少量 Forge 特有兼容细节外，核心逻辑与 KubeJS 脚本在**理论上同样兼容 Fabric**，但目前尚未在 Fabric 环境完成实测验证。

---

## 工程架构与模块依赖表

### 分层架构总览

```text
[第 1 层 · Startup 阶段：跨端契约与注册层]
├── Epiphy的-Spec与通用工具.js          (P:1200) -> 导出 EpiphySpec / EpiphyProtocol（全局契约真相源）
├── 创造模式栏-epiphy.js                (P:1000) -> 导出 EpiphyCreativeTab (epiphy:stuff)
├── Epiphy的小玩意-原版_其他Mod的隐藏物品.js      <- 依赖 [创造模式栏]
├── Epiphy的小玩意-终极拆解台_不稳定.js           <- 配合 [拆解台-混沌殉爆] 与 assets/epiphy/
└── Epiphy的小玩意_功能测试.js                    <- 联动 [创造模式栏] + [ScreenDanmaku] + [EpiphyAudio]

[第 2 层 · Server 基础层：通用基础设施层]
├── Epiphy的-日志.js                    (P:1100) -> 导出 EpiphyLog（无前置，全局限频日志中心）
├── Epiphy的-服务端基础.js              (P:1080) -> 导出 EpiphyServerBase（可选: Spec / Log）
├── Epiphy的-方块追踪组件.js            (P:1050) -> 导出 EpiphyBlockTracker v2（可选: Log）
├── Epiphy的-权限阀.js                  (P:1000) -> 导出 EpiphyPermissionValve v4（强依赖: ServerBase；可选: Log）
├── Epiphy的-调试组件.js                (P:950)  -> 导出 EpiphyDebug v1（可选: Log / 权限阀）
└── Epiphy的-基础bug修复.js             (P:900)  -> 导出 EpiphyBugfix v1（零硬依赖独立运行；可选: Log）

[第 3 层 · Server 调度与玩法层：业务表现与机制]
├── Epiphy的-屏幕弹幕组件.js            (P:500)  <- 强依赖 [Spec + ServerBase]；可选 [Log / 方块追踪 / 权限阀]
├── Epiphy的-音频组件.js                (P:500)  <- 强依赖 [Spec + ServerBase]；可选 [Log / 方块追踪 / 权限阀]
├── 拆解台-混沌殉爆.v18.js                       <- 依赖 [终极拆解台_不稳定] + [ScreenDanmaku]
└── 合成表-*/*.js                                <- 仅依赖原版或对应目标模组

[第 4 层 · Client 渲染与播放层：端侧消费]
├── Epiphy的-屏幕弹幕渲染器.js                   <- 消费网络包 epiphy:screen_danmaku（可选前置: Spec）
├── Epiphy的-音频播放器.js                       <- 消费网络包 epiphy:audio（可选前置: Spec）
└── 拆解台描述.js                                <- 客户端物品 Tooltip 描述
```

> 加载优先级约定：`Startup` 优先于 `Server` / `Client`；同一阶段内 `Priority` 数值越高越早加载（如 `1200 -> 1100 -> 1080 -> 1050 -> 1000 -> 950 -> 900 -> 500`）。

### 全模块依赖关系明细表

| 模块文件 | 阶段 / Priority | 导出接口 | 硬依赖 | 可选依赖 | 缺失可降级行为 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Epiphy的-Spec与通用工具.js` | `startup` / `1200` | `EpiphySpec`, `EpiphyProtocol` | 无 | 无 | 缺失时 `EpiphyServerBase` 与客户端引擎分别启用精简兜底，服务端弹幕/音频核心拒绝启动 |
| `创造模式栏-epiphy.js` | `startup` / `1000` | `EpiphyCreativeTab` (`epiphy:stuff`) | 无 | 无 | 缺失时附属物品无法自动归入统一创造栏 |
| `Epiphy的小玩意-原版_其他Mod的隐藏物品.js` | `startup` | 隐藏/特殊物品注册 | `创造模式栏-epiphy.js` | — | 按模块整体启用或禁用，物品需对应模组或原版资源存在 |
| `Epiphy的小玩意_功能测试.js` | `startup` | 测试方块 `epiphy:rnfmabj_test` | `创造模式栏-epiphy.js` | `ScreenDanmaku`, `EpiphyAudio` | 缺弹幕/音频时方块仍可注册，触发交互无对应声画效果 |
| `Epiphy的小玩意-终极拆解台_不稳定.js` | `startup` | 5 阶段失稳方块注册 | `kubejs/assets/epiphy/` 纹理与模型 | — | 配套 `拆解台-混沌殉爆.v18.js` 使用 |
| `Epiphy的-日志.js` | `server` / `1100` | `EpiphyLog` | 无 | 无 | 缺失时各组件自动回退到原生 `console` 输出，失去统一限频与模块 debug 开关 |
| `Epiphy的-服务端基础.js` | `server` / `1080` | `EpiphyServerBase` | 无 | `EpiphySpec`, `EpiphyLog` | 缺 `EpiphySpec` 时启用内置维度/数组精简实现；缺 `EpiphyLog` 时回退限频 `console` |
| `Epiphy的-方块追踪组件.js` | `server` / `1050` | `EpiphyBlockTracker v2` | 无（使用 KubeJS 原生事件与 `JsonIO`） | `EpiphyLog` | 缺失本组件时，弹幕/音频的 `bindBlock` 退化为仅响应放置/破坏的基础监听（无区块扫描与持久化） |
| `Epiphy的-权限阀.js` | `server` / `1000` | `EpiphyPermissionValve v4` | `EpiphyServerBase` | `EpiphyLog` | 缺失本组件时 `/epiphy` 子命令树不挂载，业务组件 JS API 仍可正常调用 |
| `Epiphy的-调试组件.js` | `server` / `950` | `EpiphyDebug v1` | KubeJS 服务端 `global` 生命周期 | `EpiphyLog`, `EpiphyPermissionValve` | 缺权限阀时不挂载 `/epiphy debug` 指令，指标仍可通过 `global.EpiphyDebug` 读取 |
| `Epiphy的-基础bug修复.js` | `server` / `900` | `EpiphyBugfix v1` | 无（独立运行） | `EpiphyLog` | 缺日志组件时自动回退至内置限频 `console` 输出 |
| `Epiphy的-屏幕弹幕组件.js` | `server` / `500` | `ScreenDanmaku v5` | `EpiphySpec`, `EpiphyProtocol`, `EpiphyServerBase`；客户端需 `ScreenDanmakuClient` | `EpiphyLog`, `EpiphyBlockTracker`, `EpiphyPermissionValve` | 缺客户端渲染器时服务端 API 可调用但端侧无画面；可选组件缺失按单层降级 |
| `Epiphy的-屏幕弹幕渲染器.js` | `client` | `ScreenDanmakuClient v5` | 服务端 `ScreenDanmaku` 发包驱动 | `EpiphySpec` / `EpiphyProtocol` | 缺前置时客户端启用内置 v5 协议常量与基础数值工具兜底 |
| `Epiphy的-音频组件.js` | `server` / `500` | `EpiphyAudio v5.2` | `EpiphySpec`, `EpiphyProtocol`, `EpiphyServerBase`；客户端需 `EpiphyAudioClient` | `EpiphyLog`, `EpiphyBlockTracker`, `EpiphyPermissionValve` | 缺客户端播放器时服务端句柄可调度但端侧无声；可选组件缺失按单层降级 |
| `Epiphy的-音频播放器.js` | `client` | `EpiphyAudioClient v5.2` | 服务端 `EpiphyAudio` 发包驱动 | `EpiphySpec` / `EpiphyProtocol` | 缺前置时客户端启用内置 v5 协议常量与基础数值工具兜底 |
| `拆解台-混沌殉爆.v18.js` | `server` | 混沌殉爆核心事件逻辑 | `Epiphy的小玩意-终极拆解台_不稳定.js`, `ScreenDanmaku` | `kubejs/assets/epiphy/` 语言/资源 | 与暮色森林、无尽贪婪、神秘遗物、诡厄巫法启示录等模组联动 |
| `合成表-*/*.js` & `拆解台描述.js` | `server` / `client` | 配方调整与 Tooltip | 对应原版及目标模组 | — | 独立配方/提示脚本，互不耦合 |

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
