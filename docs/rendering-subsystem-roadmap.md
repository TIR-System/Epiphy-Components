# Epiphy 渲染子系统演进路线图与工程规范草案
> **文档状态**：架构设计、协议 Schema、降级矩阵与别名收敛规范（v0.4）  
> **许可证声明 (License)**：本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)  
> **关联规范**：[`README-LLM.md`](../README-LLM.md) · [`docs/kube-mods-rhino-es5-es6-compatibility.md`](kube-mods-rhino-es5-es6-compatibility.md)  
> **核心编写原则**：
> 1. **功能本质导向**：严格按 **【通过什么（底层机制）➔ 能做到什么（通用能力）➔ 已有的例子（具象应用）】** 定义模块，禁止用特例命名底层机制；
> 2. **硬件与管线诚实性**：严格受制于 MC 1.20.1 `GuiGraphics` 批处理状态机、主 FBO 通道语义、`glScissor` 轴对齐限制与 Rhino JNI 调用成本；
> 3. **反黑箱与别名收敛**：无论存量接口还是新增接口，每个字段最多允许 **2 个高频字段名（1 个主标准名 + 至多 1 个显式标注的 `【别名】`）**，枚举值仅保留最常用的 **3~5 种**标准写法；所有别名必须在输入入口一次性归一化为主标准名（内部管线与网络包零别名），其余历史冗余写法全部列入淘汰表（Deprecation List）。

---

## 1. 架构演进核心决策：2D 平面合成与 3D 空间渲染的职责切分

按**几何空间维度与底层渲染管线**，将视觉表现层切分为两个正交子系统：

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                           Epiphy 视觉表现层双子系统切分                                │
├───────────────────────────────────────────┬────────────────────────────────────────────┤
│ 子系统 A：Epiphy的-平面渲染器              │ 子系统 B：Epiphy的-空间特效组件            │
│ (Epiphy2DSurface / 兼容原 ScreenDanmaku)  │ (Epiphy3DFX / 三维网格与着色器渲染器)      │
├───────────────────────────────────────────┼────────────────────────────────────────────┤
│ 【功能本质】                              │ 【功能本质】                               │
│ 局部 2D 坐标系 (u, v) 内的多层图元合成器  │ 三维世界坐标系 (x, y, z) 内的网格、体积与  │
│ 与多载体平面投影引擎                      │ 空间着色器渲染引擎                         │
├───────────────────────────────────────────┼────────────────────────────────────────────┤
│ 【四大投影载体 (surface)】                │ 【核心机制范畴】                           │
│ 1. screen      : 屏幕 HUD 归一化平面      │ 1. 程序化 3D 网格 (VBO 球体/柱体/丝带刀光) │
│ 2. gui         : 界面容器图层与纹理重映射 │ 2. 外部 3D 模型解析 (OBJ / Bedrock 网格)   │
│ 3. slot        : 物品槽位 16×16 局部平面  │ 3. 方块/实体自定义渲染挂载 (BER / Entity)  │
│ 4. world_plane : 三维空间中的 2D 投影平面 │ 4. 3D Core / Post-Processing 着色器管线    │
└───────────────────────────────────────────┴────────────────────────────────────────────┘
```

### 1.1 协议版本递增与 `adaptV5ToV6` 单一内部形态
- **显式升版至 `PROTO_VERSION = 6`**：
  - `EpiphyProtocol.isProtoCompatible` 同时接受 `proto === 5`（旧版 45 字段扁平文本包）与 `proto === 6`（新版 `{ surface, nodes[], vars, tracks }` 图元树包）；
  - 客户端收包入口处设唯一纯函数转换器 **`adaptV5ToV6(rawPkt)`**：在进入队列与续期合并（`applyDanmakuNow`）前，将 `proto: 5` 扁平包**确定性地归一化为 `v6` 标准包结构**（文本内容收拢为 `nodes: [{ type: 'text', ... }]`），杜绝渲染管线内部出现“既判扁平字段又判 `nodes` 数组”的双轨分叉。

---

## 2. 六大核心功能解构（通过什么 ➔ 做到什么 ➔ 已有的例子）

### 功能一：声明式 2D 图元树与分层分阶段合批（Declarative 2D Scene Graph）

1. **通过什么（底层机制与原语）**：
   - 将 2D 平面拆解为 **5 种原子叶节点 + 1 种容器节点**：
     - `rect`（几何矩形载体，通过统一 `fill` 机制承载纯色、渐变、单图集多层视差或内置 Shader 填充）；
     - `sprite`（单张贴图 UV 采样与序列帧切换）；
     - `nine_slice`（九宫格边缘保持拉伸框）；
     - `item`（MC 物品图标渲染）；
     - `text`（富文本/打字机/逐字位移）；
     - `group`（维护局部 `PoseStack` 2D 变换：平移 `x, y`、缩放 `scale`、旋转 `angle`、不透明度 `alpha` 与裁剪 `clip`）。
   - **明确定义的局部坐标原点与对齐基准（Anchor Convention）**：
     - 面板根部 `PoseStack` 原点 `(0, 0)` 固定位于 `(rx * screenW + ox, ry * screenH + oy)`；
     - 矩形类节点（`rect`, `sprite`, `nine_slice`, `item`）通过 `anchor: 'top_left' | 'center'`（默认 `'center'` 以对齐弹幕中心坐标系，GUI 子面板可设 `'top_left'`）决定 `(x, y)` 是图元中心还是左上角，彻底消除偏移半宽的对齐歧义。
   - **分层分阶段合批管线（Pass-Grouped Batching）**：
     - 几何与贴图节点按层序调用 `GuiGraphics` 原生方法；
     - **`text` 节点完全继承现行 `v5.7` 三大性能快路径**：① `ensureLineVisTable` $O(1)$ 打字机字素切片与像素宽度查表；② `SHARED_TEXT_SEQ_CACHE` / `TRANSIENT_TEXT_SEQ_CACHE` + ModernUI `lookupVanillaLayout(String)`（零 `Text.of` 构造、跳过逐字 `PoseStack` 与 `glIsEnabled`）；③ 同一深度层的 `text` 节点汇总至 `drawUnitsPassGrouped`（描边 Pass ➔ 阴影 Pass ➔ 前景 Pass）统一执行单次 `MultiBufferSource.endBatch()`，**严禁退化为逐节点或逐字符 Flush**。
2. **能做到什么（通用能力）**：
   - 用纯 JSON 数据结构拼装任意多层级 2D 视觉组件，同时保证在 60 字 × 20 面板同屏的高压场景下维持与现行 `v5.7` 相同的帧率水准。
3. **已有的例子（具象应用）**：
   - 科技风多栏遥测面板（九宫格底框 + 半透明渐变底板 + 物品图标 + 实时状态文字）；
   - 物品栏槽位上的复合角标；`v18` 混沌殉爆的故障弹窗与全屏警报横幅。

---

### 功能二：状态变量驱动、客户端缓动跟踪与几何裁剪（State Interpolation & Clipping）

1. **通过什么（底层机制与原语）**：
   - **状态字典（`vars`）与队列内合并更新（`action: 'patch'`）**：
     - 服务端仅在数值变化时下发轻量 `patch` 包（如 `{ action: 'patch', slotId: 'boss_hp', vars: { hp: 0.62 } }`）；
     - **队列合并与孤儿保护**：客户端 `enqueueDanmaku` 收到 `patch` 时，若待处理队列中已有同 `namespace + slotId` 的未消费包则直接原地合并 `vars`（不占额外队列槽位）；若目标面板尚未创建或已过期则静默丢弃；命中活跃面板时更新 `vars` 并自动顺延 `activeHold` 心跳窗口。
   - **客户端多通道插值跟踪器（`tracks`）**：基于单调时钟 `monotonicNowMs`（单步帧间隔钳制 `dt <= 100ms`，防止窗口失焦或卡顿恢复瞬间残影条直接跳变）维护三类通道：
     - `lerp`（平滑过渡）：按 `durationMs` 与缓动函数（`linear` / `out_quad` / `out_cubic`）平滑逼近目标值；
     - `trail`（滞后追赶）：目标值下降时先停顿 `delayMs`，再以 `speed`（每秒追赶比例）平滑收敛；
     - `impulse`（突变脉冲）：检测到目标值突变时产生 `1.0 -> 0.0` 的衰减振荡量，可绑定至位移抖动或闪烁不透明度。
   - **双模式比例裁剪器（`clip` —— 兼顾旋转面板与复合容器）**：
     - `mode: 'local'`（**默认**，局部几何/UV 收缩）：在 `PoseStack` 局部坐标系内直接按绑定变量比例 `[0.0, 1.0]` 收缩 `rect` / `sprite` 的绘制宽高 `(w, h)` 与终点 UV `(u1, v1)`——**零 `glScissor` 状态开销，且在面板或父容器带旋转角（`angle !== 0`）时依然能沿斜向完美裁剪**！
     - `mode: 'scissor'`（屏幕轴对齐硬件裁剪）：调用 `GuiGraphics.enableScissor`，专门用于裁剪包含 `text` / `item` / `nine_slice` 的复合 `group` 容器（注：`glScissor` 仅支持屏幕轴对齐矩形，当 `angle !== 0` 时对 `rect`/`sprite` 自动优先走 `'local'`）。
   - **图元属性仿射绑定与离散步进调制器（`node.bind`）**：
     - **连续轨道仿射映射**：任意图元或 `group` 容器的 `x, y, w, h, alpha, angle` 均可声明 `{ var: '<trackOrVarKey>', mult: <spanPx>, offset: <baseOffset>, min: 0, max: 1 }`，由客户端按 `base + offset + clamp(val, min, max) * mult` 60fps 实时求值；
     - **离散时钟步进与冲击微震调制**：通过 `stepHz`（如 `9` Hz 数字信号步进时钟）+ `seed` + `jitterX / jitterY / jitterW / jitterH` 驱动确定性伪随机离散跳变；通过 `impulseVar` + `shakeX / shakeY` 驱动随脉冲轨道衰减的高频微震；
     - **五向排版锚点（`anchor: 'center' | 'top_left' | 'left' | 'top_right' | 'right'`）**：支持盒模型与文本节点左右两端对齐及局部缩放坐标原点自动归零。
2. **能做到什么（通用能力）**：
   - 服务端无需高频发包驱动动画帧，客户端即可让任意图元或复合子树（如游标准星、悬浮旗标、边缘故障体素块）随逻辑数值丝滑平移、伸缩、停顿残影、受击微震或以固定采样频率（如 `9Hz`）产生数字体素重构形变，且不受进度条内胆 `clip` 裁剪框截断。
3. **已有的例子（具象应用）**：
   - **高定 Boss 血条与 `v18` 方案 α 工业科研遥测仪**：`cursor_group` 绑定 `bind: { x: { var: 'progress', mult: barW } }` 驱动 `□───` T-Pin 垂直穿透吊线与底部百分比旗标实时跟随进度前缘；前缘体素块与徽章顶部的 `DET[██]D` 反色遮罩块通过 `bind: { stepHz: 9, jitterX: ..., jitterW: ... }` 实现离散变形；同心回字内框通过 `bind: { impulseVar: 'impulse', shakeX: 1.5, shakeY: 1.5 }` 实现阶跃微颤。

---

### 功能三：统一区域填充机制（`fill` —— 纯色 / 空心线框 / 多段渐变 / 贴图与程序化几何视差 / 着色器填充）

1. **通过什么（底层机制与原语 —— 将填充抽象为单一可辨识联合对象 `fill`）**：
   - 不再将 `fillMode`、`shaderId`、`parallaxLayers`、`colorBottom` 散落为平级字段或拆分额外图元类型，而是将**「矩形区域如何被填充」**统一收敛为 `rect` 节点的 **`fill` 机制对象**（通过 `fill.mode` 区分 5 种互斥填充策略）：
     - **`fill.mode = 'solid'`（默认）**：纯色填充 `{ mode: 'solid', color: 0xFF... }`（支持顶层简写 `rect.color`）；
     - **`fill.mode = 'outline'`（单批次空心线框）**：`{ mode: 'outline', color: 0xFF..., thickness: 1 }`，在单次 `beginQuads(false)...end()` 批次内发射上下左右 4 条边框 quad，无需拆分为 4 个独立 `rect` 节点；
     - **`fill.mode = 'gradient'`（二段/三段硬件渐变）**：支持水平或垂直渐变 `{ mode: 'gradient', dir: 'h' | 'v', from: 0xFF..., mid: 0xFF..., to: 0xFF..., midPos: 0.62 }`，在单次 `beginQuads(false)` 内以相连四顶点硬件插值完成二段或三段色彩过渡；
     - **`fill.mode = 'parallax'`（外部图集与零贴图程序化几何视差合成 —— KubeJS 阶段零风险主力方案）**：
       - **外部贴图视差层**：当 `layer.tex` 指向有效纹理时，采样同一图集不同子区域并按 `speedX/Y`、`scale` 滚动；
       - **零贴图程序化几何视差层（`layer.kind: 'gradient' | 'stripes' | 'ripples' | 'particles' | 'steps'` + `bloomWidth`）**：在无外部资源包贴图时，于**单次 `beginQuads(false)...end()` 几何批次**内按面板固定坐标系生成并精确裁切至 `clip` 可见区的程序化图层——支持 `gradient`（全幅三色基底渐变）、`stripes`（周期滚动装甲暗肋）、`ripples`（正反差速流动与正弦呼吸长度的多层水平波纹丝线）、`particles`（差速星空与短码粒子流）、`steps`（按 `stepHz` 动态错位的不规则阶梯露台与立柱）以及 `bloomWidth`（前缘等离子高光渐变带）；
       - **前景镂空遮盖法（规避主 FBO `DST_ALPHA` 失效与 `GL_EQUAL` 泄漏）**：底层画带 `clip` 的 `parallax` 矩形，顶层直接叠放外框图元，零危险 GL 状态修改；
     - **`fill.mode = 'shader'`（内置着色器直绑填充）**：
       - `{ mode: 'shader', shaderId: 'end_portal' | 'end_gateway', fallbackColor: 0xFF090418 }`；
     - **独立 Kotlin/Java Mod 阶段扩展（`fill.mask`）**：进入原生 Mod 阶段后解锁单 Pass 双采样器 `mask` 异形剪影填充。
2. **能做到什么（通用能力）**：
   - 用同一个 `rect` 图元结构，在单次 GPU Quad 合批内无缝切换纯色块、精密空心准星线框、三段高动态渐变、60fps 多层差速流动波纹/星空代码视差流、动态阶梯外框或原生着色器裂隙。
3. **已有的例子（具象应用）**：
   - **`v18` 方案 α 复合遥测面板**：主进度条内胆单节点合批 `gradient + stripes + ripples + particles + bloomWidth`；进度条下方铺设 4 层 `kind: 'ripples'` 外部差速流动水面波纹场；上沿采用 13 段 `kind: 'steps'` 不规则阶梯动态外框；左侧双层同心回字准星框与 T-Pin `□` 吊线锚点采用 `fill.mode = 'outline'` 单节点绘制；
   - **原版【末地折跃门】/ 龙之研究【混沌晶体】裂隙窗**：`rect` 配置 `fill: { mode: 'shader', shaderId: 'end_portal' }`。

**统一 `fill` 机制配置示例**：
```js
{
    type: 'rect',
    x: 0, y: 0, w: 180, h: 16,
    clip: { dir: 'left', ratio: '$hp_cur', mode: 'local' },
    fill: {
        mode:    'parallax',
        texture: 'epiphy:textures/effect/cosmic_atlas.png',
        texW:    256,
        texH:    256,
        bgColor: 0xFF090418,
        layers: [
            { u: 0,   v: 0,  uw: 128, vh: 64, scale: 1.0, scrollU: 2.0,  scrollV: 0.5, parallax: 0.15, alpha: 0.90 },
            { u: 128, v: 0,  uw: 128, vh: 64, scale: 1.8, scrollU: -4.5, scrollV: 1.2, parallax: 0.35, alpha: 0.85 },
            { u: 0,   v: 64, uw: 128, vh: 64, scale: 2.5, scrollU: 1.0,  scrollV: -3.0, parallax: 0.60, alpha: 1.00, pulseHz: 2.0 }
        ]
    }
}
```

---

### 功能四：GUI 渲染管线介入与纹理动态重映射（GUI Interception & Texture Remapping）

1. **通过什么（底层机制与原语）**：
   - **渲染时序夹心层注入（`bgNodes` & `fgNodes` —— KubeJS 阶段首选零风险方案）**：利用 Forge `ContainerScreenEvent.Render.Background`（原版 `renderBg()` 画完底图后、`renderSlots()` 画物品前）与 `Foreground`（画完物品后、`renderTooltip()` 前），以 `(guiLeft, guiTop)` 为原点注入 2D 图元树；
   - **会话级纹理表重定向（`replaceTextures`）**：在匹配目标 `Screen` 打开期间，备份并替换 `TextureManager.byPath` (`f_118468_`) 中目标 `ResourceLocation` 指向的 `AbstractTexture`，界面关闭或异常时在 `try / finally` 与 `ScreenEvent.Closing` 中无条件还原（独立 Mod 阶段升级为 `GuiGraphics.blit` Mixin 拦截）；
   - **容器会话生命周期（`lifeMode: 'screen_session'`）**：除支持定时 `once` / 心跳 `active` 外，`gui` 与 `slot` 载体额外支持 `'screen_session'`（在目标界面打开期间持续生效，关闭界面时自动销毁规则）与长期绑定模式。
2. **能做到什么（通用能力）**：
   - 按运行期上下文（特定方块、失稳阶段、玩家状态）动态替换某个 GUI 的原有背景与部件贴图，且完全不遮挡容器槽位内的物品图标、数量和高亮提示。
3. **已有的例子（具象应用）**：
   - 处于失稳阶段的【暮色森林拆解台】打开时动态换上赤红脉冲科技底图；特定容器槽位加盖锁死封条。

---

### 功能五：三维空间中的 2D 画布投影与姿态锚定（3D-Projected 2D Canvas）

1. **通过什么（底层机制与原语）**：
   - 将 2D 画布锚定至世界三维坐标 `(x, y, z)`，通过 `billboard: 'center' | 'vertical' | 'fixed'`（配 `yaw, pitch, roll`）控制朝向，通过 `seeThrough: boolean` 控制深度测试，通过 `persist: boolean` 写入 `saves/<world>/kubejs_epiphy_world_planes.json`（随存档同步回滚）；
   - KubeJS 阶段优先驱动 1.20.1 原生 `Display` 实体簇；独立 Mod 阶段接入 **`TextureTarget`（FBO 离屏烘焙池）** 与 3D 射线平面求交交互 GUI。
2. **能做到什么（通用能力）**：
   - 将 2D 富文本与图案面板投射到三维世界中，自由配置是否跨重启保留、是否跟随玩家视角、是否隔墙透视。
3. **已有的例子（具象应用）**：
   - 跨重启保留的基地【高级告示牌】、`pitch: -90` 平铺地面的 2D 旋转魔法阵、隔墙可见的失稳核心信标。

---

### 功能六：三维网格、模型与空间着色器管线（3D Mesh & Spatial Shader Pipeline —— `Epiphy3DFX`）

1. **通过什么（底层机制与原语）**：
   - 独立子系统操作三维顶点缓冲（VBO / `CCRenderState`）、外部 OBJ/Bedrock 模型、Display 实体矩阵变换与 3D Core/Post Shaders。
2. **能做到什么（通用能力）**：
   - 渲染具备真实三维体积、空间遮挡与后处理扭曲的立体特效与自定义方块/实体模型。
3. **已有的例子（具象应用）**：
   - 已落地的【混沌晶体】CCL 3D OBJ + Chaos Shader 物品渲染；独立 Mod 阶段的真 3D 球壳冲击波与体积光柱。

---

## 3. 硬性工程红线、配额计费模型与环境降级矩阵

### 3.1 OpenGL / `GuiGraphics` 状态绝对对称还原红线（`try / finally` 铁律）
在 HUD 与 GUI 相位中，任何状态泄漏都会导致原版物品栏、Tooltip 或其他 Mod 界面黑屏且无法归因。**所有渲染函数必须遵守以下铁律**：
1. **`PoseStack` 推弹对称**：每次 `pose.pushPose()` 必须在紧邻的 `try { ... } finally { pose.popPose() }` 中弹出；
2. **`enableScissor` 裁剪栈对称**：每次 `guiGraphics.enableScissor(x0, y0, x1, y1)` 必须在 `finally { guiGraphics.disableScissor() }` 中关闭；
3. **着色器颜色复位**：凡调用 `RenderSystem.setShaderColor(r, g, b, a)` 修改了染色或 Alpha，必须在 `finally` 中执行 `RenderSystem.setShaderColor(1.0, 1.0, 1.0, 1.0)`；
4. **KubeJS 阶段严禁在 GUI 相位修改 `depthMask` / `depthFunc` / `colorMask` / 主 FBO Alpha 通道**。

### 3.2 绘制开销权重计费模型（`computeOverlayCost` —— 取代单纯节点数限制）
废除不反映真实 GPU 开销的“节点数 `<= 16`”规则，改为在服务端发包校验与客户端入队时统一通过纯函数 **`computeOverlayCost(pkt)`** 计算绘制权重（Draw Weight）：

| 图元与填充模式 | 权重计算公式 (`cost`) | 计费依据 |
| :--- | :--- | :--- |
| `rect` (`fill.mode === 'solid' \| 'outline' \| 'gradient'`) | `1`（若带描边 `borderWidth > 0` 则 `+1`） | 1 次 `beginQuads` 纯色/空心框/渐变 Quad 批绘制 |
| `rect` (`fill.mode === 'parallax'`) | `1 + texLayers + min(2, ceil(procLayers / 2))`（外部贴图最多 4 层） | 背景底色 + 贴图视差按层计费；同批次程序化几何层折半合并计费 |
| `rect` (`fill.mode === 'shader'`) | `4` | 独立 Shader 切换与批次 Flush 开销 |
| `sprite`（普通单层贴图） | `1` | 1 次 `GuiGraphics.blit` / Quad 绘制 |
| `nine_slice` | `4`（支持 `slice` 单值或 `[l, t, r, b]` 四向切片） | 九宫格批次开销 |
| `item` | `3` | 物品模型矩阵变换与光照设置开销 |
| `text`（静态整行） | `2 * lineCount` | 命中 `SHARED_TEXT_SEQ_CACHE` 整行合批绘制 |
| `text`（`typewriter` 或 `per_char`） | `2 + Math.ceil(visibleChars / 8)` | 逐字素矩阵变换或过渡态切片开销 |

- **配额门禁上限**：
  - `'player'` 层级（非 OP 授权玩家指令）：单面板 `maxCost <= 24`，同屏总权重 `<= 120`；
  - `'system'` 层级（JS 脚本 / OP / 控制台 / 命令方块）：单面板 `maxCost <= 96`，同屏总权重 `<= 600`；超出部分按优先级自动拒绝或裁剪。

### 3.3 异常与环境降级矩阵（Fallback Matrix）

| 异常 / 环境场景 | 探测方式 | 确定性降级行为（Fail-Safe） | 日志与告警策略 |
| :--- | :--- | :--- | :--- |
| **1. 贴图资源不存在** (`ResourceLocation` 缺失或路径非法) | `ResourceManager.getResource(rl).isPresent()`（结果缓存至 `TEXTURE_EXIST_CACHE`，资源重载时清空） | **绝不绘制紫黑丢失块**：若有 `fallbackColor` / `bgColor` 则退化为纯色 `rect`；若无则静默跳过该节点 | 每个缺失贴图路径通过 `warnOnce` 仅打印 1 次客户端警告 |
| **2. 目标 Shader 不可用** (`fill.mode === 'shader'` 但 Shader 为 `null`) | 未通过 `registerShader` 注册且非原版内置 (`end_portal`/`end_gateway`/`glint`)，或渲染异常 | 自动降级为 `fill.fallbackColor` 纯色 + 原版 `end_sky.png`/`end_portal.png` 视差回退（彻底解耦外部模组特定着色器名） | `warnOnce` 记录一次降级原因 |
| **3. 旋转面板遇到 `clip.mode === 'scissor'`** | `totalAngle !== 0` 且节点请求 `'scissor'` | 对 `rect` / `sprite` 自动切换为支持任意旋转角的 `'local'` 局部宽高/UV 收缩裁剪；对 `group` 取旋转后外接 AABB | 静默自适应 |
| **4. 开启 Iris / OptiFine 光影或 Fabulous 画质** | 探测活跃光影管线或渲染阶段异常 | `screen` / `gui` / `slot` 仅使用标准 `GuiGraphics` 调用与 `enableScissor`；`world_plane` 在 KubeJS 阶段走原版 `Display` 实体轨，天然兼容一切光影 | 静默兼容，零报错 |
| **5. GUI 类名不匹配或 `TextureManager.byPath` 反射失败** | `Screen.getClass().getName()` 未命中，或 `byPath` (`f_118468_`) 无法访问 | 类名不匹配时整个 `gui` 覆盖层休眠不绘制；`byPath` 反射失败时自动放弃 `replaceTextures`，仅执行 100% 安全的 `bgNodes` 背景夹心层覆写 | `byPath` 失败记 1 次 `warnOnce` |
| **6. 未安装 ModernUI** | 复用现行 `probeModernUiBridge()` 状态机 | `text` 节点自动回退原版 `Font.drawInBatch` + `SHARED_TEXT_SEQ_CACHE` 缓存；`'mui_stroke'` 自动回退 8 向合并 `'stroke'` | 现有机制已完备验证（测试 21/54） |
| **7. 单帧渲染耗时超限** | 帧耗时监控 `frameElapsedMs` | 常规高压预算 `highLoadFrameMs (2.5ms)` 作为告警/队列节流参考线；单帧总渲染超硬熔断线 `frameBudgetMs (45ms)` 触发紧急熔断跳过当帧绘制（10 秒冷却自动恢复） | 复用现行 `v5.7` 防闪烁熔断器 |

---

## 4. 严格协议 Schema 与 `v5 ➔ v6` 迁移映射表

### 4.1 `PROTO_VERSION = 6` 顶层包与节点 Schema 规范表

> **单一事实源声明（SSOT）**：完整的机器可读线协议全量 79 字段契约以 [`docs/proto_v6_schema.json`](proto_v6_schema.json) 为**唯一权威定义**（含继承自 `v5` 的富文本排版、描边与 `charShake*` 细节参数）。下方 §4.1 表格为面向人类的**核心结构字段导览**，测试套件 Test 68 强制锁定「§4.1 导览字段 ⊆ `proto_v6_schema.json`」与官方别名 1:1 对齐。

#### (A) 顶层信封（核心结构字段导览）
| 主标准名 (Canonical) | 显式高频别名（至多 1 个） | 类型 | 取值范围 / 枚举 | 默认值 | 单位 | 说明 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `proto` | - | `number` | `5 \| 6` | `6` | - | 协议版本号（`5` 经 `adaptV5ToV6` 自动转 `6`） |
| `action` | `【别名: act】` | `string` | `'push' \| 'patch' \| 'deactivate' \| 'clear'` | `'push'` | - | `'patch'` 仅更新已存在面板的 `vars` 并顺延心跳 |
| `surface` | `【别名: carrier】` | `string` | `'screen' \| 'gui' \| 'slot' \| 'world_plane'` | `'screen'` | - | 渲染投影载体平面 |
| `namespace` | `【别名: ns】` | `string` | 长度 `1..64`，`[a-z0-9_:\-.]` | `'default'` | - | 命名空间隔离键（玩家层强制 `'u:<uuid>'`） |
| `group` | - | `string` | 长度 `1..64` | `'default'` | - | 分组标识（用于组并发上限与按组清理） |
| `slotId` | `【别名: id】` | `string` | 长度 `0..128` | `''` | - | 显式实例槽位 ID（同 `namespace + slotId` 续期覆盖） |
| `key` | - | `string` | 长度 `0..160` | `''` | - | 逻辑去重/续期键 |
| `tier` | - | `string` | `'system' \| 'player'` | `'system'` | - | 调用源权限层级 |
| `lifeMode` | - | `string` | `'once' \| 'active' \| 'screen_session'` | `'once'` | - | 单次定时、心跳续期或随当前打开的 GUI 会话共存亡 |
| `priority` | - | `number` | 整数 `0..10`（玩家层 `<= 3`） | `2` (`once`) / `5` (`active`) | - | 淘汰与帧预算保护优先级（数值越高越晚淘汰） |
| `renderPriority` | `【别名: zIndex】` | `number` | `-10000 .. 10000` | `'screen':0`, `'screen+nodes(HUD)':50`, `'gui':100`, `'slot':200` | - | **独立画面层叠渲染优先级**（默认图形 HUD 高于弹幕、GUI 高于 HUD，可独立调整） |
| `rx`, `ry` | `【组合别名: pos】` | `number` | `0.0 .. 1.0` | `0.5`, `0.35` | 归一化屏幕比 | `surface === 'screen'` 时的锚点坐标（`pos: [rx, ry]`） |
| `ox`, `oy` | - | `number` | `-4096 .. 4096` | `0`, `0` | `px` | 相对于锚点的像素微调偏移 |
| `scale` | `【别名: size】` | `number` | `0.2 .. 8.0`（玩家层 `0.5..2.0`） | `1.0` | 倍率 | 面板整体缩放倍率 |
| `angle` | `【别名: tilt】` | `number` | `-180.0 .. 180.0` | `0.0` | 度 (`deg`) | 面板整体顺时针旋转角 |
| `stay` | `【别名: duration】` | `number` | 整数 `4 .. 72000` | `65` | `ticks` (50ms) | 维持时长 |
| `activeHold` | - | `number` | 整数 `4 .. 72000` | `28` | `ticks` (50ms) | `lifeMode: 'active'` 单次心跳维持窗口 |
| `fadeOut` | - | `number` | 整数 `1 .. 1200` | `10` | `ticks` (50ms) | 淡出阶段时长 |
| `fadeStyle` | `【别名: fade】` | `string` | `'shrink' \| 'char_first' \| 'char_last' \| 'blink' \| 'shatter' \| 'blur' \| 'split' \| 'random'` | `'shrink'` | - | 退场动画风格 |
| `vars` | - | `object` | `Record<string, number \| boolean \| string>`（单值字符串 `<= 256`） | `{}` | 数值 / 状态 | 服务端下发的状态变量字典 |
| `tracks` | - | `object` | `Record<string, TrackSpec>`（最多 16 个通道） | `{}` | - | 客户端插值通道定义（`lerp` / `trail` / `impulse`） |
| `clip` | - | `object` | `{ dir, ratio, mode }` | `null` | - | 顶层面板级比例裁剪规则 |
| `nodes` | `【别名: layers】` | `array` | `NodeSpec[]`（总权重 `cost <= maxCost`） | `[]` | - | 声明式 2D 图元树根节点列表 |
| `targetGui` | - | `object` | `{ screenClass?: string, titleMatch?: string }` | `null` | - | `surface === 'gui'` 时的目标界面匹配条件 |
| `replaceTextures` | `【别名: texMap】` | `object` | `Record<string, string>` | `{}` | - | `surface === 'gui'` 时会话级原贴图重映射表 |
| `bgNodes` | `【别名: bg】` | `array` | `NodeSpec[]` | `[]` | - | `surface === 'gui'` 时背景夹心层图元（底图后/槽位前） |
| `fgNodes` | `【别名: fg】` | `array` | `NodeSpec[]` | `[]` | - | `surface === 'gui'` 时前景装饰层图元（槽位后/提示前） |
| `slotMatch` | - | `object` | `{ slotIndex?, itemId?, containerClass? }` | `null` | - | `surface === 'slot'` 时的目标容器槽位匹配条件 |
| `worldPos` | `【别名: at】` | `number[3]` | `[x, y, z]` | `null` | 米 (`m`) | `surface === 'world_plane'` 时的世界三维坐标 |
| `billboard` | `【别名: facing】` | `string` | `'center' \| 'vertical' \| 'fixed'` | `'vertical'` | - | `surface === 'world_plane'` 时的朝向跟随模式 |
| `seeThrough` | `【别名: xray】` | `boolean` | `true \| false` | `false` | - | `surface === 'world_plane'` 时是否穿透方块遮挡 |

#### (B) 图元节点 Schema（`NodeSpec`）
| 主标准名 (Canonical) | 显式高频别名（至多 1 个） | 适用 `type` | 类型 | 范围 / 默认值 | 单位 | 说明 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `type` | `【别名: kind】` | 全部 | `string` | `'text' \| 'rect' \| 'sprite' \| 'nine_slice' \| 'item' \| 'group'` | - | **必填**，图元种类（共 6 种正交类型） |
| `anchor` | - | 全部 | `string` | `'center' \| 'top_left' \| 'left' \| 'top_right' \| 'right'`（默认 `'center'`） | - | 决定 `(x, y)` 对应的锚点方位（支持左/右/中心对齐） |
| `x`, `y` | - | 全部 | `number` | `-2048 .. 2048`（默认 `0`） | `px` | 相对于父容器/面板锚点的局部像素坐标 |
| `w`, `h` | - | 除 `text` 外 | `number` | `0 .. 2048`（`item` 默认 `16`） | `px` | 图元像素宽高 |
| `bind` | - | 全部 | `object` | `{ x/y/w/h/alpha/angle: { var, mult, offset }, stepHz?, seed?, jitter*?, impulseVar?, shake*? }` | - | 图元属性轨道仿射绑定、`stepHz` 离散抖动与冲击微震调制 |
| `color` | `【别名: tint】` | `rect`, `text`, `sprite` | `number` | 32位 `0xAARRGGBB` 或 24位 `0xRRGGBB`（默认 `0xFFFFFFFF`） | ARGB | 文本/纯色矩形主色或贴图染色 Tint |
| `fill` | - | `rect` | `object` | `{ mode: 'solid' \| 'outline' \| 'gradient' \| 'parallax' \| 'shader', ... }` | - | **统一区域填充机制**（未传时默认 `{ mode: 'solid', color: node.color }`） |
| `texture` | `【别名: tex】` | `sprite`, `nine_slice` | `string` | `namespace:path.png`（长 `<= 128`，须过白名单） | - | 纹理资源路径（`parallax` 填充的图集写在 `fill.texture`） |
| `u`, `v`, `uw`, `vh` | - | `sprite`, `nine_slice` | `number` | `0 .. 4096`（默认 `0, 0, w, h`） | `px` | 采样区域的左上角 UV 与宽高 |
| `texW`, `texH` | - | `sprite`, `nine_slice` | `number` | `1 .. 4096`（默认 `256, 256`） | `px` | 纹理文件总像素宽高（兼容 `tw`, `th`） |
| `slice` | - | `nine_slice` | `number \| number[4]` | `[left, top, right, bottom]` 或单值（各 `1..64`） | `px` | 九宫格四边不拉伸像素边距 |
| `clip` | - | 全部 | `object` | `{ dir: 'left'\|'right'\|'down'\|'up'\|'center_x', ratio: number\|'$var', mode: 'local'\|'scissor' }` | 比例 `0..1` | 比例裁剪（默认 `'local'` 支持任意旋转角） |
| `children` | `【别名: items】` | `group` | `array` | `NodeSpec[]` | - | 容器子节点列表 |

#### (C) `rect.fill` 统一填充机制子 Schema（`FillSpec`）
| `fill.mode` 取值 | 必填与可选子字段 | 说明 |
| :--- | :--- | :--- |
| **`'solid'`**（默认） | `color?: number`, `borderColor?: number`, `borderWidth?: number` | 纯色填充与可选描边 |
| **`'outline'`** | `color: number`, `thickness?: number` | 单批次 4 边空心线框绘制 |
| **`'gradient'`** | `color/from: number`, `mid?: number`, `colorEnd/to: number`, `midPos?: number`, `dir?: 'v'\|'h'\|'vertical'\|'horizontal'` | 二段或三段线性渐变填充（传 `color/colorEnd` 默认垂直；传 `from/to` 默认水平） |
| **`'parallax'`** | `texture?: string` `【别名: tex】`, `texW/tw?`, `texH/th?`, `bgColor?`, `bgAlpha?`, `bloomWidth?`, `bloomColor?`, `layers[]` | 外部贴图视差（`{ u, v, uw, vh, scale, scrollU/speedX, scrollV/speedY, alpha, pulseHz }`）与零贴图程序化图层（`kind: 'gradient'\|'stripes'\|'ripples'\|'particles'\|'steps'`） |
| **`'shader'`** | `shader/shaderId: 'end_portal' \| 'end_gateway' \| 'glint' \| string`, `fallbackColor?: number` | 原版内置着色器或通过 `Epiphy2DRenderer.registerShader` 扩展的自定义着色器（未注册时自动视差/纯色降级） |

---

### 4.2 `v5 ➔ v6` 45 字段完整迁移映射表（`adaptV5ToV6` 契约与单测基准）

客户端 `adaptV5ToV6(v5Pkt)` 将原 `v5` 扁平包的 45 个字段无损映射至 `v6` 结构，规则如下：

| 原 `v5` 字段（共 45 项） | 在 `v6` 中的归属位置 | 转换规则与说明 |
| :--- | :--- | :--- |
| `proto` (`5`) | 顶层 `proto` ➔ `6` | 标记已由适配器归一化为 `v6`（保留 `_fromProto: 5` 供诊断） |
| `action`, `tier`, `key`, `slotId`, `namespace`, `group`, `posTag`, `normalizeKey`, `lifeMode`, `priority` | **顶层 Envelope 同名字段** | 1:1 原样保留 |
| `rx`, `ry`, `movable`, `angle`, `scale`, `randomScale` | **顶层 Envelope 同名字段** | 面板级空间变换与续期移动锁 |
| `stay`, `activeHold`, `fadeStyle`, `fadeOut`, `showInGui`, `maxGroup`, `restart`, `debug` | **顶层 Envelope 同名字段** | 面板级生命周期与队列控制 |
| `jitter`, `shakeMode`, `shakeAmp`, `shakeFreqMin`, `shakeFreqMax`, `randomShake` | **`shakeMode !== 'per_char'` 时归属顶层 Envelope；`'per_char'` 时下沉至 `nodes[0]`** | 整体震动作用在面板根部；逐字震动作用在 `text` 节点 |
| `title`, `sub`, `color`, `randomColor`, `subColor`, `typewriter`, `charMs`, `cursor`, `shadow`, `letterSpacing`, `letterSpacingMode`, `outlineMode`, `outlineColor`, `outlineWidth`, `perCharShake`, `charShakeStyle`, `charShakeShift`, `charShakeShiftX`, `charShakeShiftY`, `charShakeSwayX`, `charShakeSwayY`, `charShakeRotDeg`, `charShakeWin`, `charShakeSnap`, `charShakeTransition`, `maxWidth`, `wrap`, `clamp` | **全部收拢至 `nodes[0]` (`{ type: 'text', ... }`)** | 完整保留所有文本排版、ModernUI 描边与逐字震动参数，直接驱动现行 `buildRenderedLines` 与 `drawUnitsPassGrouped` |

---

## 5. 兼容性语义收敛与黑箱淘汰清单（Alias Pruning & Deprecation Policy）

当前代码库中存在大量早期积累的同义词别名（如布尔值 18 种写法、生命周期 11 种写法、冲突模式 15 种写法），不仅增加解析分支开销，更导致脚本调用呈现出“技术黑箱”。

### 5.1 别名收敛三大原则
1. **新老字段统一「1 主标准名 + 至多 1 显式高频别名」铁律**：
   - 无论存量字段还是 `v6` 新增字段，每个字段最多允许 **2 个高频名称**：**1 个主标准名（Canonical Name）** + **至多 1 个高频简写别名**；
   - 必须在文档 Schema 表（见 §4.1）与代码中的 `OFFICIAL_ALIASES` 常量表里明确标注 **`【别名: xxx】`**，严禁在业务代码各处散落隐式 `opts.a || opts.b || opts.c`；
   - **入口单点归一化**：所有允许的 `【别名】` 在服务端发包构建入口（及客户端 `adaptV5ToV6` 入口）一次性归一化为主标准名，**网络传输包与渲染管线内部只出现主标准名**。
2. **枚举值保留 3~5 种最常用标准写法**：每个枚举维度仅保留 **3~5 个核心标准值**。
3. **两阶段透明淘汰**：超出“1 主名 + 1 别名”以外的所有历史冗余写法，全部移入静态 `DEPRECATED_ALIASES` 淘汰映射表——过渡期命中时通过 `LOGGER.once('warn', ...)` 输出一次性迁移提示并自动映射；进入独立 Kotlin/Java 模组阶段后彻底删除。

### 5.2 核心接口保留写法（主名 + 显式别名）vs 淘汰列表对照表

| 配置维度 | ✅ 永久保留的标准写法（主名 + 显式标注 `【别名】`，枚举 3~5 种） | ❌ 列入淘汰列表的冗余写法（Deprecated） |
| :--- | :--- | :--- |
| **1. 布尔值 (`parseBoolStrict`)** | `true` / `false`、`1` / `0`、`'true'` / `'false'`、`'on'` / `'off'` | `'1b'` / `'0b'`、`'yes'` / `'no'`、`'y'` / `'n'`、`'是'` / `'否'`、`'开启'` / `'关闭'`、`'开'` / `'关'`、`'none'`（布尔上下文中） |
| **2. 优先级 (`PRIORITY_MAP`)** | 数字 `0..10`、`'low'(1)`、`'normal'(2)`、`'high'(3)`、`'critical'(4)`、`'active'(5)` | `'minor'`, `'medium'`, `'default'`, `'major'`, `'important'`, `'fatal'`, `'urgent'`, `'boss'`, `'sustain'` 及全部中文别名（`'低'`, `'次要'`, `'中'`, `'普通'`, `'高'`, `'重要'`, `'极高'`, `'致命'`, `'持续'`） |
| **3. 生命周期 (`lifeMode`)** | 主名 `lifeMode`（无字段别名）；枚举 `'once' \| 'active' \| 'screen_session'`（音频支持 `'loop'`） | 字段 `existMode`, `continuous`, `sustained`, `life`；枚举值 `'continuous'`, `'sustain'`, `'hold'`, `'持续'`；以及向 `duration` 传 `'active'` 的隐式重载 |
| **4. 震动模式 (`shakeMode`)** | 主名 `shakeMode` `【别名: shake】`；枚举 `'none' \| 'constant' \| 'decay' \| 'fade_in' \| 'pulse' \| 'per_char' \| 'random'` | 字段 `jitter`, `perCharShake`, `charShake`；枚举 `'perchar'`, `'char'`, `'char_shake'`, `'spawn'`, `'impact'`, `'fadein'`, `'before_fade'`, `'wave'`, `'rand'`, `'逐字'`, `'逐字震动'`；以及向 `shake` 直接传布尔或数字的隐式重载 |
| **5. 淡出风格 (`fadeStyle`)** | 主名 `fadeStyle` `【别名: fade】`；枚举 `'shrink' \| 'char_first' \| 'char_last' \| 'blink' \| 'shatter' \| 'blur' \| 'split' \| 'random'` | 字段 `fadeMode`；枚举 `'char'`, `'glitch'`, `'defocus'`, `'clone'`, `'rand'`, `'虚化'`, `'裂解'`, `'分解'` |
| **6. 文本外圈 (`outlineMode`)** | 主名 `outlineMode` `【别名: outline】`；枚举 `'none' \| 'stroke' \| 'glow' \| 'mui_stroke'` | 字段 `glow`, `glowColor`, `glowWidth`；枚举 `'off'`, `'border'`, `'halo'`, `'sdf_stroke'`, `'描边'`, `'外圈'`, `'发光'`；以及向 `outline` 直接传颜色码的隐式重载 |
| **7. 发射源冲突仲裁 (`conflictMode`)** | 主名 `conflictMode`（无字段别名）；枚举 `'overlap' \| 'merge' \| 'nearest' \| 'first' \| 'latest' \| 'stagger'` | 字段 `sourceConflict`, `overlapMode`；枚举 `'allow'`, `'none'`, `'independent'`, `'combine'`, `'union'`, `'throttle'`, `'dedup'`, `'closest'`, `'oldest'`, `'newest'`, `'replace'` |
| **8. 存量高频属性字段名** | `title` `【别名: text】`, `sub` `【别名: subtitle】`, `stay` `【别名: duration】`, `scale` `【别名: size】`, `angle` `【别名: tilt】`, `slotId` `【别名: id】`, `namespace` `【别名: ns】`, `letterSpacing` `【别名: spacing】`, `activeHold`, `maxGroup`, `movable`, `restart` | `existTime`, `holdTicks`, `maxGroupSize`, `groupLimit`, `maxConcurrent`, `move`, `updatePos`, `resetAnimation`, `charSpacing`, `byChar`, `slot` |
| **`9. v6 新增高频字段名`** | `surface` `【别名: carrier】`, `renderPriority` `【别名: zIndex】`, `nodes` `【别名: layers】`, `type` `【别名: kind】`, `texture` `【别名: tex】`, `color` `【别名: tint】`, `children` `【别名: items】`, `replaceTextures` `【别名: texMap】`, `bgNodes` `【别名: bg】`, `fgNodes` `【别名: fg】`, `worldPos` `【别名: at】`, `billboard` `【别名: facing】`, `seeThrough` `【别名: xray】` | 严禁为新字段引入第 3 个名称或未登记的隐式同义词；淘汰告警默认 `warnDeprecatedAliases: 'log'` 受 `EpiphyLog`（`/epiphy debug log deprecations/danmaku`）统一开关控制 |

---

## 6. 测试验证方案与性能帧预算（Verification & Performance Budget）

所有新增能力必须同步扩展 [`tests/run.js`](../tests/run.js) 下对应的 `tests/suites/*.test.js` 套件（具体用例数以 `npm test` 汇总输出为准，首次执行前须先 `npm install` 安装 `acorn`）并通过 [`scripts/rhino-check.js`](../scripts/rhino-check.js) 校验（自动接入 `npm test`；缺 `acorn` 直接硬失败，有本地 `rhino-forge` Jar 与 JDK 时执行真实 `Context.compileString`，仅 Jar/JDK 缺失时降级为 `local-acorn-ast`），并在实机通过 `/epiphy debug renderperf on|dump` 输出 `epiphy-data/logs/client_render_perf.json` 核验帧耗时预算：

### 6.1 沙盒单元测试必测项（`npm test` 新增用例清单）
1. **`adaptV5ToV6` 无损往返与等价性测试**：遍历全部 45 个 `v5` 字段输入，断言转换后的 `v6` 包在顶层 Envelope 与 `nodes[0]` 上数值 100% 精确对齐，且 `ScreenDanmakuClient` 对 `proto: 5` 与 `proto: 6` 包产生完全相同的内部 Overlay 状态与渲染调用序列；
2. **`action: 'patch'` 队列内原地合并与孤儿丢弃测试**：断言同一帧入队多条同 `slotId` 的 `'patch'` 包时在 `pendingActions` 内合并为 1 条并顺延 `activeHold`；对不存在的 `slotId` 发送 `'patch'` 时安全丢弃不产生空壳 Overlay；
3. **`computeOverlayCost` 权重计费与配额拦截测试**：断言 `rect`（含 `solid` / `gradient` / `parallax` / `shader` 四种 `fill.mode`）、`sprite`、`nine_slice`、`text` 的权重累加准确，验证 `'player'` 层级超 `24` 权重被裁剪/拒绝，`'system'` 层级放行至 `96`；
4. **`tracks` 状态插值（含卡顿 `dt <= 100ms` 钳制）与 `clip` 双模式边界测试**：给定固定时间戳序列 `nowMs`，断言 `lerp`、`trail`、`impulse` 数值曲线精确，以及 `angle !== 0` 时 `clip.mode: 'local'` 局部宽高/UV 收缩与 `'scissor'` 外接框计算的准确性；
5. **`try / finally` 渲染状态对称还原测试**：在模拟 `GuiGraphics` / `PoseStack` 中注入抛错图元节点，断言异常捕获后 `poseStackDepth === 0`、`scissorDepth === 0`、`shaderColor === [1,1,1,1]`、`TextureManager.byPath` 100% 恢复原纹理；
6. **淘汰别名一次性告警测试**：断言使用 `DEPRECATED_ALIASES` 中的旧写法时触发且仅触发 1 次迁移警告，标准写法与显式 `OFFICIAL_ALIASES` 零警告。

### 6.2 客户端帧耗时预算（Performance Budget）
- **单面板 CPU/JNI 预算**：HUD / GUI 相位下，单个含 5~8 个图元节点（如九宫格底框 + 残影条 + 3 层单图集视差 `fill` + 图标 + 文本）的复合面板，在 Rhino 解释器下的单帧平均耗时须 **`<= 0.3 ms`**（60 FPS 下占帧预算 `< 1.8%`）；
- **同屏高压预算**：20 条并发弹幕 + 2 个复合进度面板同屏时，帧耗时增量 **`<= 2.5 ms`**；
- **帧紧急熔断线**：维持现行 `45 ms` 帧预算熔断保护与 10 秒冷却自动恢复机制不变。

---

## 7. 按风险重排的分阶段实施路线图（Risk-Ordered Roadmap）

将高确定性的纯 `GuiGraphics` 图元树与插值底座前置，将涉及外部环境兼容的 GUI 纹理替换、世界平面投影与自定义 Shader 逐级后置隔离：

```text
Phase 1 (零 GL 风险底座：PROTO v6 + 图元树 + fill 机制 + 状态插值 + 局部/Scissor 裁剪 + 别名收敛)
  ├─ 升级 PROTO_VERSION = 6，实现 adaptV5ToV6(pkt)、action:'patch' 队列合并与 computeOverlayCost(pkt) 权重配额门禁
  ├─ 实现纯 GuiGraphics 图元树 (rect / sprite / nine_slice / item / text / group)，text 完整继承 v5.7 三阶段合批
  ├─ 实现 rect.fill 统一填充机制 (mode: 'solid' | 'gradient' | 'parallax')、vars + tracks 插值器与 clip (local / scissor)
  ├─ 落地 §5 别名收敛表 (OFFICIAL_ALIASES 单点归一化 + DEPRECATED_ALIASES 一次性迁移提示)
  └─ 通过「rect(fill.mode:'parallax') + clip + 顶层镂空外框 sprite」零 GL 风险实现高定血条/视差星海面板，补齐单测
        │
        ▼
Phase 2 (多载体扩展 A：GUI 夹心层注入 / 物品槽位叠加 / 可选纹理表重映射与 shader 填充)
  ├─ 实现 surface: 'gui' 的 ContainerScreenEvent Background/Foreground 夹心层绘制 (bgNodes / fgNodes，零反射风险)
  ├─ 实现 surface: 'slot' 的容器槽位 2D 动态角标、充能条与遮罩叠加
  ├─ 实现带严格 try/finally + Closing/loggedOut 无条件还原的 replaceTextures 会话级纹理重映射与 fill.mode:'shader'
  └─ 正式挂载 global.Epiphy2DSurface / Epiphy2DRenderer 命名（永久保留 ScreenDanmaku 兼容别名）
        │
        ▼
Phase 3 (多载体扩展 B & 3D 协议先行：世界 2D 平面 + Epiphy3DFX 契约)
  ├─ 实现 surface: 'world_plane'：saves/<world>/ 持久化、billboard 跟随/固定、seeThrough 穿透控制（优先驱动 Display 实体轨）
  └─ 独立建立 Epiphy3DFX 服务端调度协议与客户端轻量桥接层，与 2D 平面渲染器彻底解耦
        │
        ▼
Phase 4 (Kotlin + Java 原生模组迁移：彻底移除淘汰别名 + 硬件级加速)
  ├─ 正式移除 §5.2 淘汰列表中的冗余别名，冻结原生 API
  ├─ 2D 平面渲染器接入 fill.mask 单 Pass 双采样器蒙版 Shader、TextureTarget (FBO) 离屏缓存池（含声明式节点树整树/静态子树离屏缓存，默认关闭、按需开启）、GuiGraphics Mixin 与世界平面射线交互 GUI
  └─ 3D 空间特效彻底移除 KubeJS 阶段临时借用的 CodeChickenLib 挂接特例，自主实现原生 IClientItemExtensions / BlockEntityWithoutLevelRenderer（或自有 ItemRenderer Mixin）、原版 ShaderInstance Core/Post Shader、VBO 程序化网格生成与原生 BlockEntityRenderer
```

---

## 8. 实施进度与变更记录表（Implementation Progress & Milestone Log）

> **维护规则**：后续每完成并验证通过一个子项，必须同步更新下表中的状态（`[ ]` ➔ `[x]`）、实际修改文件、单测通过数与提交哈希/日期，确保工程状态与文档零漂移。

### 8.1 分阶段任务跟踪矩阵

| 状态 | 编号 | 阶段与任务项描述 | 涉及核心文件 | 单测 / 验证指标 | 完成记录 (Commit / 日期) |
| :---: | :--- | :--- | :--- | :--- | :--- |
| [x] | **P0-1** | **架构设计与协议规范定稿（v0.4）**：完成 2D/3D 职责切分、`PROTO v6` Schema、`adaptV5ToV6` 映射表、`rect.fill` 统一填充机制、权重计费模型、降级矩阵与别名淘汰表 | `docs/rendering-subsystem-roadmap.md` | 架构审查通过 | `e719404` (2026-11-19) |
| [x] | **P1-1** | **协议升版与入口别名收敛**：`EpiphyProtocol` 支持 `PROTO_VERSION = 6`（兼容 `5`）；补齐全量顶层与节点级 `OFFICIAL_*_ALIASES`（含 `renderPriority`/`zIndex`）、拆出 `DEPRECATED_PRIORITY_ALIASES` 并使淘汰告警接入 `EpiphyLog` 统一管控 | `Epiphy的-日志.js`<br>`Epiphy的-服务端核心.js`<br>`Epiphy的-Spec与通用工具.js`<br>`Epiphy的-平面渲染组件.js` | 全量官方/淘汰别名与 `EpiphyLog` 开关回归单测 (61/61) | `ade6b7f`+ (2026-11-19) |
| [~] | **P1-2** | **`adaptV5ToV6` 转换器与 `computeOverlayCost` 权重门禁**：45 字段转换与权重配额（`'player' <= 24`, `'system' <= 96`）已就绪；注：KubeJS 阶段 `drawDeclarativeTextNode` 暂不承担 `<shake>`/`typewriter`/`outlineMode` 全量管线（纯文本包仍走 `v5.7` 完整合批轨） | `Epiphy的-Spec与通用工具.js`<br>`Epiphy的-平面渲染组件.js`<br>`Epiphy的-平面渲染器.js` | 45 字段往返单测 + 配额裁剪单测 | 混合图文全富文本待 Phase 4 原生补全 |
| [x] | **P1-3** | **状态变量字典 (`vars`)、`action: 'patch'` 队列合并与 `tracks` 插值器**：实现同 `slotId` 队列合并、孤儿包丢弃、`lerp`/`trail`/`impulse`（`dt <= 100ms` 钳制）及 `node.bind` 仿射/步进绑定 | `Epiphy的-平面渲染组件.js`<br>`Epiphy的-平面渲染器.js` | 时间序列插值与 `evaluateNodeBind` 单测 | 已完成 |
| [x] | **P1-4** | **声明式 2D 图元树与独立层级调度**：实现 6 类图元、`nine_slice.slice` 4 元数组与标量、`5` 向 `anchor`、双模 `clip`、`renderPriority` 独立于 `priority` 的层叠排序（GUI 默认置顶）及 `flushBatchedBeforeImmediate` 双缓冲刷新修复 | `Epiphy的-平面渲染器.js` | 异常注入状态零泄漏 + 层叠排序与遮罩单测 | 已完成 |
| [x] | **P1-5** | **`rect.fill` 统一填充机制**：完成 `solid` / `outline` / 三色 `gradient` / 外部贴图与程序化几何 `parallax`（`ripples`/`steps`/`particles`/`stripes`）/ `shader`（原版 `end_portal`/`end_gateway`/`glint` + `registerShader` 可扩展机制）与 `TEXTURE_EXIST_CACHE` 防缺贴图 | `Epiphy的-平面渲染器.js` | 视差 UV 计算 + Shader 降级 + 缺贴图单测 | 已完成 |
| [x] | **P1-6** | **Phase 1 预设封装、向上自定义注册与 `v18` 方案 α 实装**：移除特例 `buildProgressPanel`，归位为内置 `'progress_bar'` 预设 + `progressTracks`；落地分组配置深合并、`channel`/`slot` 句柄、`ui()` `id` 前置 + `.texts()`/`.region()` 与端侧节点预编译；`v18` 三幕遥测全面采用方案 α（`472x16@0.56`、零重叠阶梯切角玻璃底衬、同心旋转方格徽章、4 层立体底流与 `slot.syncNear` 自动全量/增量 `patch`） | `Epiphy的-Spec与通用工具.js`<br>`Epiphy的-平面渲染组件.js`<br>`Epiphy的-平面渲染器.js`<br>`拆解台-混沌殉爆.v18.js` | `v18` NBT 序列化 + 真 `PaintScreenEventJS` + 预设/`channel`/`slot`/预编译/`KNOWN_PACKET_KEYS` 静态一致性/HUD 分层与 Z 隔离断言 (66/66) | 已完成 |
| [~] | **P2-1** | **承载面 `surface: 'gui'` 夹心层与会话寿命**：已实现 `renderGuiSurfacePass`、`lifeMode: 'screen_session'` 与 `renderPriority: 100` 默认不被弹幕覆盖；**明确前置边界**：当前仅在 `PaintScreen` 阶段生效，**完整夹心层（含非容器类 `Screen` 的背景/控件夹心与原版任意 GUI 组件精准 Z 夹心）阻塞于 Phase 4 原生模组 Mixin，非 KubeJS 阶段可优雅完成** | `Epiphy的-平面渲染组件.js`<br>`Epiphy的-平面渲染器.js` | `screen_session` / `renderGuiSurfacePass` 单测 | 部分完成（**阻塞于 Phase 4 Mixin，非 KubeJS 可完成**） |
| [x] | **P2-2** | **会话级纹理重映射与 `fill.mode: 'shader'`**：`applyReplacedTexturesForGui` 接入 `Minecraft.getTextureManager().register` 真替换并在界面关闭/`loggedOut`/`clear` 自动还原；支持原版内置及外部注册自定义 Shader 与降级回退 | `Epiphy的-平面渲染器.js` | 纹理还原防污染单测 + Shader 降级单测 | 已完成 |
| [~] | **P2-3** | **承载面 `surface: 'slot'` 物品槽位 2D 叠加层**：已完成 `slotMatch` 与局部偏移绘制（`renderPriority: 200`）及单测；**明确前置边界**：**单槽 `renderSlot` 物品底层夹心与高性能多槽批绘制阻塞于 Phase 4 原生模组 Mixin（KubeJS Rhino 逐槽循环存在实测帧率天花板），非 KubeJS 阶段可优雅完成** | `Epiphy的-平面渲染器.js` | 槽位匹配与局部坐标裁剪单测 | 部分完成（**阻塞于 Phase 4 Mixin，非 KubeJS 可完成**） |
| [x] | **P2-4** | **双端正式更名并挂载 `Epiphy2DSurface` / `Epiphy2DRenderer`**：更名脚本文件并保留 `ScreenDanmaku` / `ScreenDanmakuClient` 兼容别名 | `Epiphy的-平面渲染组件.js`<br>`Epiphy的-平面渲染器.js`<br>`README*.md` | 别名等价性回归单测 | `0b5a013` (2026-11-19) |
| [ ] | **P3-1** | **承载面 `surface: 'world_plane'`（世界 2D 平面 / 高级告示牌）**：实现 `saves/<world>/kubejs_epiphy_world_planes.json` 持久化、`billboard` 朝向控制、`seeThrough` 穿透开关与 1.20.1 `Display` 实体轨驱动 | 服务端/客户端平面渲染组件 | 跨重启持久化回滚单测 + 视距增量同步单测 | 待开始 |
| [x] | **P3-2** | **`Epiphy3DFX` 空间特效子系统双端闭环基座**：已落地物品 3D 渲染核心 `Epiphy的-空间特效核心.js` (`Epiphy3DFXCore v1.0.4`，100% 自研 GLSL 1.50 核心星空着色器 `epiphy:epiphy_cosmos` + 烘焙期有限值校验与 `computeNormals()` 预烘焙纯 Java `CCModel` 渲染〔~0.54ms，`cosmosType` 单次 flush 防 uniform 串扰〕+ 临时可选 CCL 特例〔无 CCL 单告警退回原版静态模型；Phase 4 独立 Mod 须自实现去 CCL〕+ `RenderLevelStageEvent` O(1) 短路桥接）、服务端世界 3D 调度器 `Epiphy的-空间特效组件.js` (`Epiphy3DFXServer v1.1.0`，`epiphy:spatial_fx` 协议 `v1`、`surface: 'world'`、`computeSpatialFxCost` 配额、`channel`/`slot`、`addConstraint` 可扩展约束链与 `registerShapeSchema`/`registerPreset`）及客户端消费端 `Epiphy的-空间特效渲染器.js` (`Epiphy3DFX v2.2.1`，100% 零 CCL 依赖、内置 4 种纯原版图元默认渲染器、`followEntityUuid` 实体平滑插值追踪、同槽 `patch` 合并、`'player'`/`'system'` 隔离淘汰、`once`/`active` 生命周期与 `registerWorldShape` 渲染扩展） | `Epiphy的-Spec与通用工具.js`<br>`Epiphy的-空间特效核心.js`<br>`Epiphy的-空间特效组件.js`<br>`Epiphy的-空间特效渲染器.js` | 2D/3D 解耦 + 无 CCL 降级 + 零 `Math.PI` NaN + 双端 `surface: 'world'` 闭环与约束链回归单测 | 已完成 (2026-11-22) |
| [ ] | **P4-1** | **Kotlin + Java 原生模组迁移**：移除 `DEPRECATED_ALIASES`；**彻底移除 KubeJS 阶段临时借用的 `CodeChickenLib` 特例依赖（改用 Forge 原生 `IClientItemExtensions` + `BEWLR` / 自有 Mixin + 原版 `ShaderInstance` + 原生 Java VBO/网格提交自主实现物品 3D 渲染）**；接入 `fill.mask` 单 Pass 着色器、`TextureTarget` (FBO) 离屏缓存池（含声明式节点树整树/静态子树离屏缓存，默认关闭按需开启）、`GuiGraphics` Mixin、世界平面射线交互 GUI 与原生 3D VBO/Shader | 独立模组工程 | 原生模组集成测试 | 待开始 |

### 8.2 变更日志（Changelog）

- **2026-11-19 (`v0.4` / Commit `e719404`)**：完成渲染子系统演进路线图与工程规范草案（确立 2D/3D 双子系统切分、6 大功能本质解构、`rect.fill` 统一填充机制、`try/finally` GL 状态还原铁律、`computeOverlayCost` 权重计费、7 项环境降级矩阵、`PROTO v6` Schema、`v5 ➔ v6` 45 字段迁移表、1 主名 + 1 显式 `【别名】` 收敛规范及 `P0 ~ P4` 进度跟踪表）。
- **2026-11-19 (`v1.0` / Phase 1 & Phase 2 KubeJS 平面渲染器重构落地)**：
  - 完成 `P1-1 ~ P1-6` 与 `P2-1 ~ P2-4`：协议升级至 `PROTO_VERSION = 6`（向下兼容 `proto: 5`），在 `EpiphySpec` 落地 `OFFICIAL_DANMAKU_ALIASES`、`DEPRECATED_DANMAKU_ALIASES`、`computeOverlayCost` 与 `adaptV5ToV6`；
  - 双端升级为 `ScreenDanmaku` / `Epiphy2DSurface v6.0` 与 `ScreenDanmakuClient` / `Epiphy2DRenderer v6.0`，支持 6 类正交 2D 图元（`rect`、`sprite`、`nine_slice`、`item`、`text`、`group`）、4 种矩形填充模式（`solid`、`gradient`、`parallax`、`shader`）、双模裁剪（`clip.mode: 'local' | 'scissor'`）、3 类插值轨道（`lerp`、`trail`、`impulse`，含 `dt <= 100ms` 钳制）、`action: 'patch'` 队列内原地合并与孤儿包静默丢弃、以及 `surface: 'gui' | 'slot'` 与 `replaceTextures` 自动还原；
  - 将 `拆解台-混沌殉爆.v18.js` 中的三处遥测进度条（堆芯失稳 5 阶段遥测、终末 10 秒死刑遥测、300m 物质湮灭实时波前遥测）从旧版 `'█'`/`'░'` 字符拼串全面升级为基于 `buildProgressPanel` 的原生 2D 图元复合进度条（含渐变主条 + 延迟拖影轨 + 局部几何裁剪），移除 `PROGRESS_BAR_CACHE` 与 `makeProgressBar`；全量单元测试扩展至 `60/60` 全部通过。
- **2026-11-19 (`v1.0.1` / 真机 KubeJS Rhino NBT & `PaintScreenEventJS` 实装修复)**：
  - 修复 KubeJS `NetworkEvents.dataReceived` 下 `event.data` 嵌套 `CompoundTag` / `ListTag` 在 Rhino 执行 `typeof` 报错（`InternalError: Invalid JavaScript value of type net.minecraft.nbt.CompoundTag`）的问题：新增 `nbtToPlainJs` 在接收入口与 `adaptV5ToV6` 边界将真实 NBT Tag 递归转为纯 JS 值（同时保留单测 Mock 与 `FakeCompoundTag` 兼容），并将辅助类型判断统一替换为 `isPlainObjLike`；
  - 对齐 `kubejs-forge-2001.6.5-build.26.jar` 真实 `PaintScreenEventJS` / `GuiGraphics` API：移除不存在的 `event.fill` / `event.drawTexture` / `event.hGradient` / `event.vGradient` / `event.enableScissor` / `event.raw` 调用，改为 `event.setPositionColorShader` / `event.setPositionColorTextureShader` / `event.blend` / `event.beginQuads` / 6 参及 10 参 `event.rectangle` / 四顶点硬件梯度 `event.vertex` / `event.end` 与 `event.graphics`（配合批处理预刷新 `flushBatchedBeforeImmediate` 与 `try/finally` 状态还原）；
  - 修复 `drawDeclarativeTextNode` 在 ModernUI 未命中时未调用 `ensureUnitCompSeq` 导致向 `event.text` 传 `null` 的问题，并修复 `拆解台-混沌殉爆.v18.js` `barColorFrom: meta.hex` 与 `buildProgressPanel` 副标题间距；测试第 60 条补充真机 NBT 与 `PaintScreenEventJS` 契约断言，`60/60` 通过 + Rhino 语法检查通过。
- **2026-11-19 (`v1.1` / 泛用动态绑定、空心线框、程序化几何视差机制扩展 & `v18` 定稿方案 α 实装)**：
  - **渲染器泛用机制扩展（以功能为导向）**：
    1. 新增 `node.bind`（图元属性仿射绑定与离散步进调制器）：支持 `x/y/w/h/alpha/angle` 绑定至任意 `tracks`/`vars` 线性映射，支持 `stepHz`（如 `9Hz` 数字信号步进时钟）确定性伪随机抖动 `jitterX/Y/W/H` 以及 `impulseVar` 驱动的受击微震 `shakeX/Y`；
    2. 新增 `fill.mode = 'outline'` 单批次空心线框（1 次 `beginQuads` 完成四边描边）、`fill.mode = 'gradient'` 三色硬件渐变（`from -> mid -> to`）以及五向排版锚点（`center | top_left | left | top_right | right`）与缩放文本局部原点自动归零；
    3. 扩展 `fill.mode = 'parallax'` 支持零贴图程序化几何视差层（`layer.kind: 'gradient' | 'stripes' | 'ripples' | 'particles' | 'steps'` + `bloomWidth`），在单次 `beginQuads(false)...end()` 批次内完成多层差速流动波纹丝线、差速星空代码粒子流、滚动装甲暗肋与不规则动态阶梯外框的几何裁切与合批绘制；
  - **`拆解台-混沌殉爆.v18.js` 定稿方案 α 落地与命名严谨化**：运用上述泛用机制组装方案 α（左侧双层同心回字准星徽章 + `DET[██]D` 离散跳变反色遮罩签 + 《终末地》反色工业铭牌 `EF-TLM` + 13 段不规则阶梯动态外框 + 底部 4 层差速流动水面波纹场 + 4 层程序化星空波纹视差内胆 + 前缘跟随 `□───` T-Pin 垂直穿透吊线与 `9Hz` 变形体素块簇 + 右端 `□───` 双行遥测读数台），并将原“终末死刑”全面修正为严谨的高能物理遥测术语 **`约束场崩溃 · 视界锁死倒计时 [不可逆坍缩态]` (`HZ-LCK // T-0`)**。
- **2026-11-19 (`v1.1.1` / 契约对表审计修复、EpiphyLog 淘汰告警管控与 GUI 独立渲染优先级)**：
  - **补齐 §4.1 & §5.2 全量别名收敛与 Schema 对齐**：`OFFICIAL_DANMAKU_ALIASES` 补全 `act` / `carrier` / `layers` / `texMap` / `bg` / `fg` / `at` / `facing` / `xray` / `shake` / `zIndex`（共 22 项），新增 `OFFICIAL_NODE_ALIASES`（`kind->type`, `tint->color`, `tex->texture`, `items->children`）；拆离 `DEPRECATED_PRIORITY_ALIASES`；补齐 `nine_slice.slice: number[4]`、`fill.shader`（移除硬编码外部着色器名，提供 `registerShader` 可扩展与通用降级）、`fill.gradient` `color/colorEnd/vertical/horizontal`、`sprite.texW/texH/tint` 与 `parallax` 顶层 `texture` / `scrollU` / `scrollV` / `pulseHz` 支持，并诚实标注 §8.1 进度表 `[~]` 项；
  - **淘汰告警接入 `EpiphyLog`**：`EpiphyLog` 新增 `setDeprecationWarnings` / `isDeprecationWarningsEnabled` / `warnDeprecatedOnce`，`ScreenDanmaku.CONFIG.warnDeprecatedAliases` 默认改为 `'log'`（受 `/epiphy debug log deprecations on` 或 `/epiphy debug log danmaku on` 与 `EpiphyLog` 开关控制）；
  - **GUI 独立渲染优先级 (`renderPriority` / `zIndex`)**：解耦淘汰与帧预算 `priority`，默认 `'screen': 0` < `'gui': 100` < `'slot': 200`，修正 `compareOverlayDrawPriority` 为按 `renderPriority` 升序绘制并跨越层级强制刷新批处理，确保 GUI 默认置于弹幕之上不被覆盖且支持逐包/全局调整；
  - **真机序列与方案 α 精调**：修复 `flushBatchedBeforeImmediate()` 补刷 `event.graphics.flush()`（解决 `badge_mask` 遮不住缩放文本 `badge_tag`）、补齐 `getActiveScreen` 与真实 `TextureManager` 纹理替换、`screen_session` 界面关闭自动注销，并加宽 `v18` `ef_tag_plate`（`56px`）与进度条（`236px`）、绑定 `impulse` 至 `$impulseEvent` 避免 0.4s 误抽搐、切换 300m 湮灭时显式关闭 `core_telemetry`。
- **2026-11-20 (`v1.2` / 跨组件向上预设与自定义复合单元、紧凑 `ui()` DSL、缓存池收敛与 KubeJS 零视觉变化热路径优化)**：
  - **跨组件向上预设与缓存池收敛 (`EpiphySpec` / `Epiphy2DSurface v6.1` / `EpiphyAudio v5.8` / `EpiphyWorldOps v2.5`)**：
    1. `EpiphySpec` 新增 `createBoundedCache(maxSize)`（$O(1)$ 均摊 FIFO 有界缓存池）与 `createPresetRegistry(domain)` / `registerPreset` / `resolvePreset`（挂载 `global.EpiphyPresetStore`，支持 `startup_scripts` 向上提交预设供 `server_scripts` 消费）；破坏性移除已淘汰的 `preset -> pos` 别名，使 `preset` 成为全组件统一预设字段；
    2. `Epiphy2DSurface v6.1` 新增 `ui()` 紧凑链式构造器（内置 `steppedPlate` 零重叠阶梯底衬、`corners` 四角加固折角、`steppedLine` 自动立柱折线、`ticks` 刻度线、`boxes`、`group`、`widget` 泛用原语及 `rect.outline` 简写）与 `registerPreset` / `registerWidget`，支持下游玩法脚本向上提交专属复合单元（如 `v18_t_pin`、`v18_reticle_badge`）与参数化预设（`v18_telemetry`）；
    3. `EpiphyAudio v5.8`（含 `bindBlock` 扫描/启播）与 `EpiphyWorldOps v2.5` 同步落地 `registerPreset` / `preset` / `{ preset: '...' }` 自动解析；`Epiphy的小玩意_功能测试.js` 升级为启动期向上提交 `rnfmabj_test_bgm` / `rnfmabj_test_prescript` 预设。
  - **客户端零视觉变化热路径优化 (`Epiphy2DRenderer v6.1`)**：
    1. 将 `GLYPH_WIDTH_CACHE`、`TEXTURE_EXIST_CACHE`（上限 512）、`SHARED_TEXT_SEQ_CACHE`（512）、`TRANSIENT_TEXT_SEQ_CACHE`（256）以及 `EpiphyServerCore` 的 `LAST_WRITTEN_JSON_CACHE`（64）统一收敛至 `EpiphySpec.createBoundedCache`（消除散落手写 `Array.shift()` 淘汰，缺 `SPEC` 时平滑降级本地有界实现）；
    2. 新增连续 `solid`/`outline` `rect` 自动合批（相邻几何节点合并为单次 `beginQuads`/`end`，外层 `finally` 强关闭保证异常安全）；
    3. 为 `evaluateNodeBind` / `computeBoxAnchorOrigin` / `computeLocalClipRect` 补充热路径 Scratch 复用参数（未传时仍返回纯新对象）；
    4. `drawRectParallax` 增加 `stripes`/`ripples` 视口早期剔除与斜肋分段上限（`3..8`）；`drawDeclarativeTextNode` 左对齐零 `font.width` 跳过 + 右/中对齐单行节点宽度缓存（绑定 `FONT_SIGNATURE|MUI_EPOCH` 失效）；
  - **`v18` 定义瘦身与同阶段 `action: 'patch'` 增量更新**：`拆解台-混沌殉爆.v18.js` 三幕遥测全面迁移至 `v18_telemetry` 预设 + 4 套主题，非遮挡文字集中置尾减少 Flush，同阶段刷新自动发极简 `action: 'patch'`（仅首次/切阶段/每 48 tick 发全量节点树），热路径去 `toFixed` 字符串分配；全量测试扩展至 `63/63` 通过并通过真实 Rhino `Context.compileString` 编译核验。
- **2026-11-20 (`v1.3` / `v6.2` 破坏性架构收敛：分组深合并、`channel`/`slot`、`id` 前置 DSL、收包节点预编译、LRU 缓存与 `openJsonStore`)**：
  - **`EpiphySpec`**：`createBoundedCache(maxSize, 'fifo' | 'lru')` 新增纯 ES5 双向链表 $O(1)$ `'lru'` 策略（零迭代器分配、无 Rhino `NativeMap` 风险）；新增受控 2 层合并原语 `mergeTracksMap`（支持同模式字段合并、切模式整条替换、`null`/`false` 显式禁用）与 `mergeGroupedOptions` 并接入预设注册表。
  - **`Epiphy2DSurface v6.2`（破坏性清理与接口升级）**：
    1. 彻底移除特例函数 `buildProgressPanel`，归位为内置标准预设 `'progress_bar'`（单一常量源 `PROGRESS_PANEL_DEFAULTS`）与极薄轨道原语 `progressTracks(overrides)`；
    2. 支持配置分组（`layout` / `life` / `motion` / `style` / `data` / `tracks`）入口一次性展平（不动 `PROTO v6` 网络包），并建立 `KNOWN_PACKET_KEYS` 白名单对拼错参数发出一次性 `LOGGER.once` 警告；
    3. 新增作用域通道 `channel({ namespace, group, resyncTicks, beforeSend })` 与调用方持有的有状态 `slot(id, ...)` 句柄（`syncNear`/`patchNear`/`closeNear` 自动决策首次/变体切换/周期保活全量与常规 `patch`）；
    4. `ui()` DSL 全方法破坏性统一为 `id` 前置（`rect`/`outline`/`text`/`parallax`/`group`/`boxes` 同序、消除 `null` 占位），新增 `.texts()`、`.steppedPlate` 行内 ID 与零节点开销局部坐标块 `.region(dx, dy, fn)`。
  - **`Epiphy2DRenderer v6.2`（热路径预编译与零闭包批处理）**：
    1. `SHARED_TEXT_SEQ_CACHE` 切至 `'lru'` 防止突发一次性弹幕冲刷高频常驻 HUD 排版；
    2. 收包入口新增 `compileDeclarativeNodes`（整型 `type`/`fillMode` 枚举、静态几何/颜色/坐标预算、`isStaticFastRect` 极速直绘轨）与 `stepHz` 离散抖动微缓存；
    3. 批处理状态机 `openRectBatch`/`closeRectBatch`/`emitOutlineIntoOpenBatch` 提升至模块顶层（每帧 0 闭包分配），新增帧内 `resolveEventCaps(event)` 消除 5 处 `drawRect*` 重复 `typeof` JNI 探测；
    4. 真正的声明式节点树整树 / 静态子树离屏缓存（`TextureTarget` FBO，默认关闭）正式记入 Phase 4 原生模组路线图。
  - **`EpiphyServerCore v2.6` & 业务收口**：新增状态化 JSON 持久化门面 `openJsonStore(filePath, opts)`（统一 `load`/`save`/`isCorrupt` 与 `lockOnCorrupt` 防损坏覆写，根治底层的读/写参数反序问题），迁移 `方块与区块组件`、`权限阀`、`v18`；`v18` 同步修复 `DANMAKU_NAMESPACE` 声明顺序并全面迁至 `HUD_CH`/`slot`/`id` 前置 `ui()` + `.region()`；单测扩至 `66/66` 且全过真实 Rhino 编译检查。
- **2026-11-21 (`P3-2` 客户端底座 / `Epiphy3DFXCore v1.0.1` + `Epiphy3DFX v2.0.0` GPU 核心着色器与预烘焙 `CCModel` 架构重构)**：
  - 彻底淘汰高 CPU 开销的逐顶点 JS 循环（`RenderHandEvent` / `ContainerScreenEvent` / `PaintScreenEventJS` 桥接已全部移除，恢复 `Epiphy的-Spec与通用工具.js` 零额外每帧桥接开销），在 [`kubejs/startup_scripts/通用组件/Epiphy的-空间特效核心.js`](../kubejs/startup_scripts/通用组件/Epiphy的-空间特效核心.js) 建立子系统 B 原生 GPU + 预烘焙 `CCModel` 核心；
  - 通过 `RegisterShadersEvent` 注册 100% 自研 GLSL 1.50 核心着色器 `epiphy:epiphy_cosmos`（[`epiphy_cosmos.{json,vsh,fsh}`](../kubejs/assets/epiphy/shaders/core/epiphy_cosmos.fsh)），以原生屏幕分辨率逐像素计算 360° 无缝相机视角视差深空星海、三层四芒十字星芒（`+`/`✦`）+ 柔和径向光晕与多倍频翡翠青/星穹紫体积星云，并严格限定在 `imperius_test_cosmos_mask.png` 下段剑身星窗与 1px 裂隙内，绝不调用无尽贪婪等外部渲染器；
  - 通过 `ModelEvent$ModifyBakingResult` + CodeChickenLib `IItemRenderer` 在模型烘焙期一次性将 2 面星窗面片、3 道带刻度与三维四芒星棱晶的星盘陀螺环、双螺旋缠刃光带及 3 簇 14 枚 3D 拖尾星屑预烘焙为原生 Java `CCModel` 网格，运行时零 JS 顶点循环、零 GC 分配，依托硬件深度缓冲在第一人称、第三人称、快捷栏与背包槽位实现真实剑身前后遮挡与零卡顿渲染。
- **2026-11-22 (`P3-2` 世界 3D 双端闭环基座 & 无 CCL Fail-Soft 降级 / `Epiphy3DFXCore v1.0.2` + `Epiphy3DFXServer v1.0.0` + `Epiphy3DFX v2.1.0`)**：
  - **无 CCL 干净 Fail-Soft 退回原版模型**：`Epiphy3DFXCore` 在 `RegisterShadersEvent` 与 `ModelEvent$ModifyBakingResult` 入口前置一次性 `probeCclBackend()` 探测；缺 CodeChickenLib 时仅输出 1 条 `console.warn`、置 `backendMode: 'vanilla_fallback'` 并跳过烘焙，绑定物品自动保留原版静态 `BakedModel` 正常显示（零 `console.error` 噪声）；
  - **世界 3D (`surface: 'world'`) 服务端-客户端可扩展闭环**：在 `EpiphyProtocol` 新增 `FX3D_CHANNEL = 'epiphy:spatial_fx'`、`FX3D_PROTO_VERSION = 1`、`FX3D_QUOTA` 与 `EpiphySpec.computeSpatialFxCost`；新增服务端调度器 [`Epiphy的-空间特效组件.js`](../kubejs/server_scripts/通用组件/Epiphy的-空间特效组件.js)（支持 `push`/`patch`/`deactivate`/`clear`、`channel().slot()` 自动全量/增量与 tick 回绕重同步、`addConstraint` 可扩展约束链、`registerShapeSchema` 与向上 `registerPreset`）；升级客户端 [`Epiphy的-空间特效渲染器.js`](../kubejs/client_scripts/通用组件/Epiphy的-空间特效渲染器.js) 接入 `NetworkEvents.dataReceived('epiphy:spatial_fx')`（同槽 `patch` 合并、`'player'`/`'system'` 隔离与单向淘汰、`once`/`active` 生命周期与 `registerWorldShape` 扩展），并通过 `Epiphy3DFXCore` 挂接 `RenderLevelStageEvent`（零活跃特效时 $O(1)$ 短路零开销，渲染阶段严格 `try/finally` `PoseStack` 还原）。
- **2026-11-22 (`P3-2` 真机取证根治：`rhino-forge` `NativeMath` 常量缺陷修复 & 纯 Java `CCModel` 0.54ms 回归 / `EpiphySpec v2.7.0` + `Epiphy3DFXCore v1.0.4` + `Epiphy3DFX v2.2.1`)**：
  - **根治 `rhino-forge` `NativeMath.findPrototypeId` 缺失 8 常量导致 `Math.PI === undefined`**：在 `EpiphySpec v2.7.0` 建立 `global.EpiphyMath` / `EpiphySpec.MATH` 与幂等 `ensureMathConstants(Math)`，于 `startup`/`server`/`client` 三端入口自动修补各自独立作用域的 `Math` 对象；清除全仓 4 个脚本的 15 处 `Math.PI`（根治 3D 物品星环/螺旋/星屑全 `NaN` 隐形、手持星窗 `EpiphyYawPitch=NaN` 纯黑、世界 `ring`/`helix`/`sphere` 隐形及服务端圆环方块/粒子环 `NaN`）；在 `scripts/rhino-check.js` 增设 8 个 `Math.*` 常量的永久 AST 门禁并在兼容文档中落案。
  - **恢复纯 Java `CCModel.render` 极速热路径（~0.54ms vs JS 循环 8~25ms）**：经用户事前批准，在 `Epiphy3DFXCore v1.0.4` 声明的可选 `CodeChickenLib` 特例范围内恢复预烘焙 `CCModel` + `CCRenderState` + `Matrix4`，补齐烘焙期 `validateQuadsFinite` 防火墙与 `model.computeNormals()`（兼容 `NEW_ENTITY` `entityTranslucentEmissive`）、设置 `brightness=15728880`/`overlay=655360`，并在 `cosmosType` 绘制后显式 `flushRenderType` 锁定 uniform 防止 Hand/GUI 串扰（Phase 4 独立 Mod 仍须彻底去 CCL 自实现）。


