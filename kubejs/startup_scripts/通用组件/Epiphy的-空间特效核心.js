// priority: 1050
// ============================================================================
//  Epiphy 的通用组件 —— 空间特效渲染核心 (Epiphy3DFXCore v1.0.5 · Startup/ModBus)
//  许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
//  放置位置：kubejs/startup_scripts/通用组件/Epiphy的-空间特效核心.js
//  第三方 Mod 可选特例（原则见 README-LLM.md §3.3）：
//    - CodeChickenLib（可选特例：`IItemRenderer` / `TransformUtils` / `CCShaderInstance` / `CCModel` / `CCRenderState` / `ColourAttribute` / `Matrix4` / `Vector3` / `Vertex5`）：
//      仅因 KubeJS 1.20.1 物品注册未暴露 `Item.initializeClient` 且 Rhino 纯解释器逐顶点写 `VertexConsumer` 耗时高（8~25ms）
//      而临时借作物品 3D 渲染入口胶水与纯 Java 侧预烘焙网格加速（实测 ~0.54ms，提速 15~46 倍）；
//      缺失时单次 console.warn 自动 Fail-Soft 退回原版静态物品模型，不影响世界 3D (`surface: 'world'`) 零 CCL 运行；
//      迁出为独立原生 Mod（Phase 4）时必须彻底移除全部 CCL 依赖，改用 Forge 原生 `IClientItemExtensions` + `BEWLR` / 自有 Mixin + 原版 `ShaderInstance` + 原生 Java 网格/VBO 自主实现。
//  架构定位：
//    - 视觉表现层【子系统 B】(详见 docs/rendering-subsystem-roadmap.md §1、§2 功能六 & §8.1 P3-2)
//    - 彻底与【子系统 A】2D 平面渲染器 (Epiphy的-平面渲染器.js) 解耦，专职三维物品渲染管线：
//      1. 通过 RegisterShadersEvent + CodeChickenLib CCShaderInstance.create（单重载工厂，根治 Rhino
//         ShaderInstance 构造二义性）注册 100% 自研 GLSL 核心着色器 `epiphy:epiphy_cosmos`；
//      2. 通过 ModelEvent$ModifyBakingResult 挂载 CodeChickenLib IItemRenderer，在烘焙期一次性预烘焙
//         经有限值校验的连续光滑 `CCModel`（星窗面片、极细柔光 3D 星盘双环、Frenet 连续双螺旋缠刃丝线与柔光四芒星芒），
//         热路径由纯 Java `CCModel.render` 提交至无闪烁加法发光 RenderType（`POSITION_COLOR_TEX` + `LIGHTNING_TRANSPARENCY`
//         + 双线性滤波柔光贴图 `glow_ribbon.png`/`star_flare.png` + `NO_CULL` + `COLOR_WRITE` + `sortOnUpload=false`）；
//      3. 热路径零 JS 逐顶点循环、零每帧矩阵分配、零排序/共面闪烁，`cosmosType` 单次 flush 防 Hand/GUI uniform 串扰，
//         配合 GUI 轻量 LOD 稳定保持 < 1ms。
//  语法规范：遵循 README-LLM.md §1 强制 Rhino ES5 语法基准（严禁读取 Math.PI 等 NativeMath 缺失常量）。
// ============================================================================

;(function () {
    var VERSION    = '1.0.5'
    var E_MATH     = (typeof global !== 'undefined' && global != null && global.EpiphyMath != null)
        ? global.EpiphyMath
        : ((typeof global !== 'undefined' && global != null && global.EpiphySpec && global.EpiphySpec.MATH) ? global.EpiphySpec.MATH : null)
    if (typeof global !== 'undefined' && global != null && global.EpiphySpec && typeof global.EpiphySpec.ensureMathConstants === 'function') {
        global.EpiphySpec.ensureMathConstants(typeof Math !== 'undefined' ? Math : null)
    }
    var PI         = (E_MATH && typeof E_MATH.PI === 'number') ? E_MATH.PI : 3.141592653589793
    var TWO_PI     = (E_MATH && typeof E_MATH.TWO_PI === 'number') ? E_MATH.TWO_PI : 6.283185307179586
    var DEG_TO_RAD = (E_MATH && typeof E_MATH.DEG_TO_RAD === 'number') ? E_MATH.DEG_TO_RAD : 0.017453292519943295
    var PX_TO_UNIT = 1.0 / 64.0
    var ENV_STATE  = 'unknown'
    var BACKEND_STATUS = {
        cclChecked:    false,
        cclAvailable:  false,
        mode:          'uninitialized',
        missingClass:  null,
        warnedMissing: false
    }
    var WORLD_HOOK_STATE = {
        registered: false
    }

    // 单调时钟：优先复用 EpiphySpec.createMonotonicClock（Util.getNanos -> 单调钳制 Date.now），防 NTP 回拨/跳变
    var MONO_CLOCK = null
    if (typeof global !== 'undefined' && global != null && global.EpiphySpec && typeof global.EpiphySpec.createMonotonicClock === 'function') {
        MONO_CLOCK = global.EpiphySpec.createMonotonicClock({
            allowSystemProbe: false,
            onWarn: function (msg) {
                try { console.warn('[Epiphy3DFXCore] ' + msg) } catch (eW) { }
            }
        })
    } else {
        var FALLBACK_LAST_MS = null
        var FALLBACK_ACC_MS  = 0.0
        var FALLBACK_T0_MS   = null
        MONO_CLOCK = {
            nowMs: function () {
                var raw = Date.now()
                if (FALLBACK_LAST_MS === null) {
                    FALLBACK_LAST_MS = raw
                    FALLBACK_ACC_MS  = raw
                    return FALLBACK_ACC_MS
                }
                var dt = raw - FALLBACK_LAST_MS
                FALLBACK_LAST_MS = raw
                if (dt < 0 || dt > 250.0) dt = 16.0
                FALLBACK_ACC_MS += dt
                return FALLBACK_ACC_MS
            },
            elapsedSec: function () {
                var cur = this.nowMs()
                if (FALLBACK_T0_MS === null) FALLBACK_T0_MS = cur
                return (cur - FALLBACK_T0_MS) * 0.001
            },
            getSource: function () { return 'clamped_date' }
        }
    }

    var CONFIG = {
        enabled:          true,
        cosmosEnabled:    true,
        surroundEnabled:  true,
        guiSurroundScale: 0.86,
        guiRingLimit:     2,
        guiRenderHelix:   false,
        guiRenderMotes:   false
    }

    var ITEM_BINDINGS   = {}
    var RESOLVED_CACHE  = {}
    var BAKED_ITEMS     = {}
    var BAKED_COUNT     = 0
    var COSMOS_SHADER   = null
    var SHADER_UNIFORMS = {
        time:        null,
        yawPitch:    null,
        guiMode:     null,
        fnTime:      null,
        fnYawPitch:  null,
        fnGuiMode:   null
    }
    var SHADER_STATUS = {
        registered: false,
        loaded:     false,
        lastError:  null
    }
    var RUNTIME_STATS = {
        renderCalls:     0,
        handCalls:       0,
        guiCalls:        0,
        origDraws:       0,
        cosmosDraws:     0,
        surroundDraws:   0,
        lastRenderUs:    0,
        maxRenderUs:     0,
        totalRenderUs:   0,
        loggedFirstHand: false,
        loggedFirstGui:  false,
        lastError:       null
    }

    var ERR_THROTTLE_AT = {}

    function clampNum(v, lo, hi) {
        return v < lo ? lo : (v > hi ? hi : v)
    }

    function isPlainObjLike(v) {
        return v != null && typeof v === 'object' && !Array.isArray(v)
    }

    // CodeChickenLib ColourRGBA 字节序为 0xRRGGBBAA（R 在最高字节，A 在最低字节）
    function packRgba(rgb, alphaByte) {
        var r = ((rgb >>> 16) & 0xFF)
        var g = ((rgb >>> 8) & 0xFF)
        var b = (rgb & 0xFF)
        var a = clampNum(Math.round(alphaByte), 0, 255) & 0xFF
        return ((r << 24) | (g << 16) | (b << 8) | a) | 0
    }

    function logErrorThrottled(tag, err) {
        RUNTIME_STATS.lastError = tag + ': ' + String(err)
        var now = Date.now()
        var last = ERR_THROTTLE_AT[tag] || 0
        if ((now - last) < 5000) return
        ERR_THROTTLE_AT[tag] = now
        try {
            console.error('[Epiphy3DFXCore] ' + tag + ': ' + err)
        } catch (eLog) { }
    }

    // 单调秒级时钟（依托 Util.getNanos() 或单调钳制 Date.now()，防 NTP 回拨/跳变且零 ClassFilter 异常）
    function nowSeconds() {
        return MONO_CLOCK.elapsedSec()
    }

    // ======================================================================== 1. Mojmap 优先 + SRG 回退互操作工具（仅烘焙期/冷路径使用）
    function resolveMcMethod(target, mojName, srgName) {
        if (target == null) return null
        try {
            if (typeof target[mojName] === 'function') return target[mojName]
        } catch (e0) { }
        if (srgName && srgName !== mojName) {
            try {
                if (typeof target[srgName] === 'function') return target[srgName]
            } catch (e1) { }
        }
        return null
    }

    function callMcMember(target, mojName, srgName) {
        if (target == null) return null
        var args = []
        for (var i = 3; i < arguments.length; i++) args.push(arguments[i])
        var fn = resolveMcMethod(target, mojName, srgName)
        if (fn == null) {
            throw new Error('Missing MC method ' + mojName + '/' + srgName)
        }
        return fn.apply(target, args)
    }

    function readMcMember(target, mojName, srgName) {
        if (target == null) return null
        try {
            if (target[mojName] !== undefined) return target[mojName]
        } catch (e0) { }
        if (srgName && srgName !== mojName) {
            try {
                if (target[srgName] !== undefined) return target[srgName]
            } catch (e1) { }
        }
        return null
    }

    function buildCompositeStateNone(builder) {
        var outlineNone = null
        try {
            var $OutlineProperty = Java.loadClass('net.minecraft.client.renderer.RenderType$OutlineProperty')
            if ($OutlineProperty != null) {
                outlineNone = readMcMember($OutlineProperty, 'NONE', 'NONE')
            }
        } catch (eOutline) { }
        if (outlineNone != null) {
            return callMcMember(builder, 'createCompositeState', 'm_110689_', outlineNone)
        }
        return callMcMember(builder, 'createCompositeState', 'm_110689_', 'none')
    }

    var CACHED_FLUSH_GETTER = null
    var CACHED_FLUSH_FN     = null

    function flushRenderType(getter, rt) {
        if (getter == null || rt == null) return
        if (getter !== CACHED_FLUSH_GETTER) {
            CACHED_FLUSH_GETTER = getter
            CACHED_FLUSH_FN     = resolveMcMethod(getter, 'endBatch', 'm_109912_')
        }
        if (CACHED_FLUSH_FN != null) {
            CACHED_FLUSH_FN.call(getter, rt)
        }
    }

    function resolveUniform1fSetter(u) {
        if (u == null) return null
        if (typeof u.glUniform1f === 'function') return u.glUniform1f
        if (typeof u.set === 'function') return u.set
        if (typeof u.m_5985_ === 'function') return u.m_5985_
        return null
    }

    function resolveUniform2fSetter(u) {
        if (u == null) return null
        if (typeof u.glUniform2f === 'function') return u.glUniform2f
        if (typeof u.set === 'function') return u.set
        if (typeof u.m_7971_ === 'function') return u.m_7971_
        return null
    }

    // ======================================================================== 2. 默认预设归一化（与 fx3d Spec 对齐）
    function getDefaultItemSpec() {
        return {
            scheme:         's1',
            maskTexture:    null,
            speed:          1.0,
            slashExpand:    0.45,
            originX:        -9.5,
            originY:        9.5,
            ux:             0.698,
            uy:             -0.716,
            ringCenterU:    9.6,
            renderInHand:   true,
            renderInHotbar: true,
            renderInSlots:  true,
            cosmosWindow: {
                enabled:  true,
                parallax: 1.6,
                speed:    0.95
            },
            rings: [
                {
                    R: 8.4, tiltU: 0.52, tiltV: 0.16, spd: 0.65, segs: 36,
                    cCore: 0xFFF4D6, cGlow: 0xF2C068, ticks: 16, prisms: 2, wBase: 0.68, uOffset: 0.0
                },
                {
                    R: 11.2, tiltU: -0.78, tiltV: -0.26, spd: -0.48, segs: 40,
                    cCore: 0xD2EAFF, cGlow: 0x9C7EFF, ticks: 0, prisms: 2, wBase: 0.62, uOffset: 1.5
                }
            ],
            helix: {
                enabled: true,
                steps:   36,
                uStart:  3.0,
                uSpan:   48.0,
                radius:  4.5,
                freq:    0.17,
                speed:   1.15,
                wBase:   0.52,
                cCore0:  0xFFEAF4,
                cGlow0:  0xFFA2CC,
                cCore1:  0xD8F4FF,
                cGlow1:  0x8CD8FF
            },
            motes: {
                enabled:    true,
                count:      6,
                trailSteps: 0
            }
        }
    }

    function normalizeItemSpec(itemId, rawSpec) {
        var base = getDefaultItemSpec()
        var resolved = rawSpec
        if (isPlainObjLike(rawSpec) && typeof rawSpec.preset === 'string' && global.EpiphySpec && typeof global.EpiphySpec.resolvePreset === 'function') {
            var over = {}
            for (var ok in rawSpec) {
                if (Object.prototype.hasOwnProperty.call(rawSpec, ok) && ok !== 'preset') over[ok] = rawSpec[ok]
            }
            var fromSpec = global.EpiphySpec.resolvePreset('fx3d', rawSpec.preset, over)
            if (isPlainObjLike(fromSpec)) resolved = fromSpec
        }
        if (!isPlainObjLike(resolved)) resolved = {}
        var out = {}
        for (var k in base) {
            if (Object.prototype.hasOwnProperty.call(base, k)) {
                out[k] = (resolved[k] !== undefined) ? resolved[k] : base[k]
            }
        }
        out.cosmosWindow = isPlainObjLike(resolved.cosmosWindow) ? resolved.cosmosWindow : base.cosmosWindow
        out.helix        = isPlainObjLike(resolved.helix) ? resolved.helix : base.helix
        out.motes        = isPlainObjLike(resolved.motes) ? resolved.motes : base.motes
        out.rings        = Array.isArray(resolved.rings) ? resolved.rings : base.rings

        if (!out.maskTexture && typeof itemId === 'string') {
            var colon = itemId.indexOf(':')
            var ns = colon > 0 ? itemId.slice(0, colon) : 'epiphy'
            var pt = colon > 0 ? itemId.slice(colon + 1) : itemId
            out.maskTexture = ns + ':textures/item/' + pt + '_cosmos_mask.png'
        }
        return out
    }

    // ======================================================================== 3. 纯几何 3D 预烘焙网格生成器（仅在烘焙期运行一次）
    function pushQuad(list, p0, p1, p2, p3, rgba, uvRect, rgbaEnd) {
        var cEnd = rgbaEnd !== undefined && rgbaEnd !== null ? rgbaEnd : rgba
        list.push({
            p0: p0, p1: p1, p2: p2, p3: p3,
            u0: uvRect ? uvRect[0] : 0.0, v0: uvRect ? uvRect[1] : 0.0,
            u1: uvRect ? uvRect[2] : 1.0, v1: uvRect ? uvRect[3] : 0.0,
            u2: uvRect ? uvRect[4] : 1.0, v2: uvRect ? uvRect[5] : 1.0,
            u3: uvRect ? uvRect[6] : 0.0, v3: uvRect ? uvRect[7] : 1.0,
            rgba:  rgba,
            rgba0: rgba,
            rgba1: rgba,
            rgba2: cEnd,
            rgba3: cEnd
        })
    }

    // 严格共享端点的连续柔光丝带段：v=0..1 横跨丝带宽度匹配 glow_ribbon.png 高斯柔光剖面，u=0..1 沿路径无缝衔接
    function pushConnectedRibbonQuad(list, a, nA, hwA, b, nB, hwB, rgbaA, rgbaB) {
        var ax = nA[0] * hwA, ay = nA[1] * hwA, az = nA[2] * hwA
        var bx = nB[0] * hwB, by = nB[1] * hwB, bz = nB[2] * hwB
        pushQuad(
            list,
            [a[0] - ax, a[1] - ay, a[2] - az],
            [a[0] + ax, a[1] + ay, a[2] + az],
            [b[0] + bx, b[1] + by, b[2] + bz],
            [b[0] - bx, b[1] - by, b[2] - bz],
            rgbaA,
            [0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 0.0],
            rgbaB
        )
    }

    function pushRibbonQuad(list, a, b, normal, halfW, rgba, rgbaEnd) {
        pushConnectedRibbonQuad(list, a, normal, halfW, b, normal, halfW, rgba, rgbaEnd)
    }

    // 添加三维正交十字光带段（两片正交柔光面片，配合加法混合在任意视角恒定纤细、零共面闪烁）
    function pushCrossSegmentQuads(list, a, b, n1, n2, halfW, rgba) {
        pushRibbonQuad(list, a, b, n1, halfW, rgba, rgba)
        pushRibbonQuad(list, a, b, n2, halfW, rgba, rgba)
    }

    // 添加三维正交柔光四芒星芒 ✦（3 片正交贴图面片配 star_flare.png，任意 3D 视角清透璀璨且零硬边刺突）
    function pushStarFlare3DQuads(list, cx, cy, cz, ax1, ax2, ax3, radius, rgba) {
        var pairs = [
            [ax1, ax2],
            [ax2, ax3],
            [ax1, ax3]
        ]
        var uvFull = [0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0]
        for (var i = 0; i < pairs.length; i++) {
            var u = pairs[i][0]
            var v = pairs[i][1]
            var ux = u[0] * radius, uy = u[1] * radius, uz = u[2] * radius
            var vx = v[0] * radius, vy = v[1] * radius, vz = v[2] * radius
            pushQuad(
                list,
                [cx - ux - vx, cy - uy - vy, cz - uz - vz],
                [cx + ux - vx, cy + uy - vy, cz + uz - vz],
                [cx + ux + vx, cy + uy + vy, cz + uz + vz],
                [cx - ux + vx, cy - uy + vy, cz - uz + vz],
                rgba, uvFull, rgba
            )
        }
    }

    // 保留外部纯几何辅助别名（兼容既有 _pure API）
    function pushStarPrism3DQuads(list, cx, cy, cz, ax1, ax2, ax3, outerR, rgbaGlow, rgbaCore) {
        pushStarFlare3DQuads(list, cx, cy, cz, ax1, ax2, ax3, outerR * 1.35, rgbaGlow)
        pushStarFlare3DQuads(list, cx, cy, cz, ax1, ax2, ax3, outerR * 0.72, rgbaCore)
    }

    // 3.1 剑身前后双面星窗覆盖面片（紧贴 item/generated 前后面 Z=0.53125/0.46875 外侧 0.00175 单位，根绝斜视 Z-fighting）
    function buildCosmosOverlayQuads() {
        var quads = []
        var white = packRgba(0xFFFFFF, 255)
        var zFront = 0.5330
        var zBack  = 0.4670
        pushQuad(
            quads,
            [0.0, 0.0, zFront],
            [1.0, 0.0, zFront],
            [1.0, 1.0, zFront],
            [0.0, 1.0, zFront],
            white,
            [0.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0]
        )
        pushQuad(
            quads,
            [0.0, 1.0, zBack],
            [1.0, 1.0, zBack],
            [1.0, 0.0, zBack],
            [0.0, 0.0, zBack],
            white,
            [0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0]
        )
        return quads
    }

    // 3.2 单个 3D 星盘陀螺环丝带预烘焙网格（端点严格共享、极细柔光丝带 + 精细微刻度，零共面重叠）
    function buildAstrolabeRingQuads(ring) {
        var quads = []
        var R     = Number(ring.R != null ? ring.R : 8.4) * PX_TO_UNIT
        var segs  = clampNum(Math.round(Number(ring.segs != null ? ring.segs : 36)), 20, 48)
        var wBase = Number(ring.wBase != null ? ring.wBase : 0.68) * PX_TO_UNIT
        var cCore = ring.cCore != null ? Number(ring.cCore) : 0xFFF4D6
        var cGlow = ring.cGlow != null ? Number(ring.cGlow) : 0xF2C068
        // 单层柔光丝带（glow_ribbon.png 自带细亮芯 + 柔焦晕，加法混合下叠加增亮，绝不产生共面闪烁）
        var rgbaBand = packRgba(cGlow, 188)
        var rgbaAxis = packRgba(cCore, 152)
        var rgbaTick = packRgba(cCore, 165)
        var rgbaTickTip = packRgba(cGlow, 28)

        var xAxis = [1.0, 0.0, 0.0]

        var i, a0, a1, c0, s0, c1, s1, p0, p1, rad0, rad1
        for (i = 0; i < segs; i++) {
            a0 = (i / segs) * TWO_PI
            a1 = ((i + 1) / segs) * TWO_PI
            c0 = Math.cos(a0); s0 = Math.sin(a0)
            c1 = Math.cos(a1); s1 = Math.sin(a1)
            p0   = [0.0, R * c0, R * s0]
            p1   = [0.0, R * c1, R * s1]
            rad0 = [0.0, c0, s0]
            rad1 = [0.0, c1, s1]
            // 严格共享端点的径向柔光带 + 轴向柔光带（任意 3D 倾角下保持精致细线、严丝合缝）
            pushConnectedRibbonQuad(quads, p0, rad0, wBase, p1, rad1, wBase, rgbaBand, rgbaBand)
            pushConnectedRibbonQuad(quads, p0, xAxis, wBase * 0.88, p1, xAxis, wBase * 0.88, rgbaAxis, rgbaAxis)
        }

        // 星盘精致微刻度（短细针尖，避免凌乱）
        var ticks = clampNum(Math.round(Number(ring.ticks || 0)), 0, 24)
        if (ticks > 0) {
            var tickW = wBase * 0.44
            for (var tk = 0; tk < ticks; tk++) {
                var ta = (tk / ticks) * TWO_PI
                var tc = Math.cos(ta), ts = Math.sin(ta)
                var isMajor = (tk % 4 === 0)
                var extOut  = (isMajor ? 1.15 : 0.68) * PX_TO_UNIT
                var extIn   = (isMajor ? 0.52 : 0.25) * PX_TO_UNIT
                var tanV = [0.0, -ts, tc]
                var midPt = [0.0, R * tc, R * ts]
                pushConnectedRibbonQuad(
                    quads,
                    midPt, tanV, tickW,
                    [0.0, (R + extOut) * tc, (R + extOut) * ts], tanV, tickW * 0.55,
                    rgbaTick, rgbaTickTip
                )
                pushConnectedRibbonQuad(
                    quads,
                    midPt, tanV, tickW,
                    [0.0, (R - extIn) * tc, (R - extIn) * ts], tanV, tickW * 0.55,
                    rgbaTick, rgbaTickTip
                )
            }
        }

        return quads
    }

    // 3.2b 星盘环上的精致柔光四芒星节点（使用 star_flare.png）
    function buildAstrolabeRingStarQuads(ring) {
        var quads = []
        var prisms = clampNum(Math.round(Number(ring.prisms || 0)), 0, 6)
        if (prisms <= 0) return quads
        var R     = Number(ring.R != null ? ring.R : 8.4) * PX_TO_UNIT
        var cCore = ring.cCore != null ? Number(ring.cCore) : 0xFFF4D6
        var starR = 2.35 * PX_TO_UNIT
        var rgba  = packRgba(cCore, 168)
        var xAxis = [1.0, 0.0, 0.0]
        for (var pk = 0; pk < prisms; pk++) {
            var pa = (pk / prisms) * TWO_PI + 0.35
            var pc = Math.cos(pa), ps = Math.sin(pa)
            var radVec = [0.0, pc, ps]
            var tanVec = [0.0, -ps, pc]
            pushStarFlare3DQuads(quads, 0.0, R * pc, R * ps, radVec, tanVec, xAxis, starR, rgba)
        }
        return quads
    }

    // 3.3 双螺旋缠刃纤细流光丝线（真正 Frenet 连续标架 + 端点严格共享 + 首尾平滑渐隐，彻底零断口）
    function buildHelixRibbonQuads(helix, strandIndex) {
        var quads = []
        if (!helix || helix.enabled === false) return quads
        var steps    = clampNum(Math.round(Number(helix.steps != null ? helix.steps : 36)), 18, 48)
        var uStartPx = Number(helix.uStart != null ? helix.uStart : 3.0)
        var uSpanPx  = Number(helix.uSpan != null ? helix.uSpan : 48.0)
        var uStart   = uStartPx * PX_TO_UNIT
        var uSpan    = uSpanPx * PX_TO_UNIT
        var radMax   = Number(helix.radius != null ? helix.radius : 4.5) * PX_TO_UNIT
        var freqPx   = Number(helix.freq != null ? helix.freq : 0.17)
        var wBasePx  = Number(helix.wBase != null ? helix.wBase : 0.52)
        var phase    = (strandIndex === 1) ? PI : 0.0
        var cGlow    = (strandIndex === 1) ? Number(helix.cGlow1 != null ? helix.cGlow1 : 0x8CD8FF) : Number(helix.cGlow0 != null ? helix.cGlow0 : 0xFFA2CC)
        var cCore    = (strandIndex === 1) ? Number(helix.cCore1 != null ? helix.cCore1 : 0xD8F4FF) : Number(helix.cCore0 != null ? helix.cCore0 : 0xFFEAF4)

        // 先预采样所有中心点与径向方向
        var pts  = new Array(steps + 1)
        var rads = new Array(steps + 1)
        var envs = new Array(steps + 1)
        var i
        for (i = 0; i <= steps; i++) {
            var frac = i / steps
            var uPx  = uStartPx + frac * uSpanPx
            var u    = uStart + frac * uSpan
            var env  = Math.pow(Math.max(0.0, Math.sin(frac * PI)), 0.78)
            var r    = radMax * (0.28 + 0.72 * env)
            var ang  = uPx * freqPx + phase
            var ca   = Math.cos(ang), sa = Math.sin(ang)
            pts[i]  = [u, r * ca, r * sa]
            rads[i] = [0.0, ca, sa]
            envs[i] = env
        }

        // 计算每点连续正交标架 (N1, N2) 与平滑宽/色
        var n1Arr  = new Array(steps + 1)
        var n2Arr  = new Array(steps + 1)
        var hwArr  = new Array(steps + 1)
        var c1Arr  = new Array(steps + 1)
        var c2Arr  = new Array(steps + 1)
        for (i = 0; i <= steps; i++) {
            var pPrev = pts[i > 0 ? (i - 1) : 0]
            var pNext = pts[i < steps ? (i + 1) : steps]
            var tx = pNext[0] - pPrev[0]
            var ty = pNext[1] - pPrev[1]
            var tz = pNext[2] - pPrev[2]
            var tLen = Math.sqrt(tx * tx + ty * ty + tz * tz)
            if (tLen < 1e-6) { tx = 1.0; ty = 0.0; tz = 0.0 }
            else { tx /= tLen; ty /= tLen; tz /= tLen }

            // Gram-Schmidt：将径向投影到垂直于切线的平面，确保截面对齐且沿曲线平滑旋转
            var rx = rads[i][0], ry = rads[i][1], rz = rads[i][2]
            var dot = rx * tx + ry * ty + rz * tz
            var n1x = rx - dot * tx
            var n1y = ry - dot * ty
            var n1z = rz - dot * tz
            var n1Len = Math.sqrt(n1x * n1x + n1y * n1y + n1z * n1z)
            if (n1Len < 1e-5) { n1x = 0.0; n1y = 1.0; n1z = 0.0 }
            else { n1x /= n1Len; n1y /= n1Len; n1z /= n1Len }

            // N2 = T x N1（自动单位化且与 N1/T 两两正交）
            var n2x = ty * n1z - tz * n1y
            var n2y = tz * n1x - tx * n1z
            var n2z = tx * n1y - ty * n1x
            var n2Len = Math.sqrt(n2x * n2x + n2y * n2y + n2z * n2z)
            if (n2Len > 1e-5) { n2x /= n2Len; n2y /= n2Len; n2z /= n2Len }

            n1Arr[i] = [n1x, n1y, n1z]
            n2Arr[i] = [n2x, n2y, n2z]
            hwArr[i] = (wBasePx * (0.45 + 0.55 * envs[i])) * PX_TO_UNIT
            c1Arr[i] = packRgba(cGlow, Math.round(182 * envs[i]))
            c2Arr[i] = packRgba(cCore, Math.round(138 * envs[i]))
        }

        // 相邻采样点逐段严丝合缝连接（0 阶梯错位、0 断裂缺口）
        for (i = 0; i < steps; i++) {
            pushConnectedRibbonQuad(quads, pts[i], n1Arr[i], hwArr[i], pts[i + 1], n1Arr[i + 1], hwArr[i + 1], c1Arr[i], c1Arr[i + 1])
            pushConnectedRibbonQuad(quads, pts[i], n2Arr[i], hwArr[i] * 0.88, pts[i + 1], n2Arr[i + 1], hwArr[i + 1] * 0.88, c2Arr[i], c2Arr[i + 1])
        }
        return quads
    }

    // 3.4 精选柔光漂浮四芒星点（克制留白、聚焦剑身中上部，使用 star_flare.png，无杂乱彗尾）
    function buildStarMotesQuads(motes, groupIndex, groupCount) {
        var quads = []
        if (!motes || motes.enabled === false) return quads
        var count  = clampNum(Math.round(Number(motes.count != null ? motes.count : 6)), 1, 10)
        var gCount = Math.max(1, groupCount || 2)
        var palette = [0xFFD6EC, 0xB8EAFF, 0xFFF2D0, 0xE2C4FF]
        var xAxis   = [1.0, 0.0, 0.0]

        for (var i = 0; i < count; i++) {
            if ((i % gCount) !== groupIndex) continue
            var h1 = Math.sin(i * 17.31 + 2.13) * 43758.5453; h1 = h1 - Math.floor(h1)
            var h2 = Math.sin(i * 71.19 + 5.47) * 19283.1234; h2 = h2 - Math.floor(h2)
            var h3 = Math.sin(i * 43.87 + 1.91) * 28411.9812; h3 = h3 - Math.floor(h3)

            // 集中点缀在剑身中上部（14..48px），避开剑格环区防拥挤
            var uBase = (14.0 + h1 * 34.0) * PX_TO_UNIT
            var orbR  = (5.2 + h2 * 4.2) * PX_TO_UNIT
            var ang0  = h3 * TWO_PI
            var cTint = palette[i % palette.length]

            var c0 = Math.cos(ang0), s0 = Math.sin(ang0)
            var hx = uBase, hy = orbR * c0, hz = orbR * s0
            var radV = [0.0, c0, s0]
            var tanV = [0.0, -s0, c0]
            var starR = (1.85 + 0.85 * h2) * PX_TO_UNIT
            pushStarFlare3DQuads(quads, hx, hy, hz, radV, tanV, xAxis, starR, packRgba(cTint, 158))
        }
        return quads
    }

    // 校验预烘焙 Quad 列表所有坐标与 UV 均为有限数，拦截任何 NaN/Infinity 顶点静默流入 GPU
    function validateQuadsFinite(quads) {
        var valid = []
        var invalidCount = 0
        if (!Array.isArray(quads)) return { valid: valid, invalidCount: 0 }
        for (var i = 0; i < quads.length; i++) {
            var q = quads[i]
            if (q == null || !q.p0 || !q.p1 || !q.p2 || !q.p3) {
                invalidCount++
                continue
            }
            if (
                isFinite(q.p0[0]) && isFinite(q.p0[1]) && isFinite(q.p0[2]) &&
                isFinite(q.p1[0]) && isFinite(q.p1[1]) && isFinite(q.p1[2]) &&
                isFinite(q.p2[0]) && isFinite(q.p2[1]) && isFinite(q.p2[2]) &&
                isFinite(q.p3[0]) && isFinite(q.p3[1]) && isFinite(q.p3[2]) &&
                isFinite(q.u0) && isFinite(q.v0) &&
                isFinite(q.u1) && isFinite(q.v1) &&
                isFinite(q.u2) && isFinite(q.v2) &&
                isFinite(q.u3) && isFinite(q.v3)
            ) {
                valid.push(q)
            } else {
                invalidCount++
            }
        }
        return { valid: valid, invalidCount: invalidCount }
    }

    // 烘焙期将 Quad 列表一次性编译为 CodeChickenLib CCModel（强制计算法线以兼容 NEW_ENTITY 格式）
    function bakeQuadsToCCModel(quads, $CCModel, $Vertex5, $ColourAttribute, tag) {
        if (!Array.isArray(quads) || quads.length === 0) return null
        var check = validateQuadsFinite(quads)
        if (check.invalidCount > 0) {
            try {
                console.error('[Epiphy3DFXCore] 烘焙期检测到 ' + check.invalidCount + ' 个含非有限数 (NaN/Infinity) 的非法面片已丢弃' + (tag ? (' [' + tag + ']') : ''))
            } catch (eNan) { }
        }
        var validQuads = check.valid
        if (validQuads.length === 0) return null
        var vCount = validQuads.length * 4
        var model = $CCModel.quadModel(vCount)
        var colours = model.getOrAllocate($ColourAttribute.attributeKey)
        var idx = 0
        for (var i = 0; i < validQuads.length; i++) {
            var q = validQuads[i]
            var c0 = q.rgba0 !== undefined ? q.rgba0 : q.rgba
            var c1 = q.rgba1 !== undefined ? q.rgba1 : q.rgba
            var c2 = q.rgba2 !== undefined ? q.rgba2 : q.rgba
            var c3 = q.rgba3 !== undefined ? q.rgba3 : q.rgba
            model.verts[idx]     = new $Vertex5(q.p0[0], q.p0[1], q.p0[2], q.u0, q.v0)
            colours[idx]         = c0
            model.verts[idx + 1] = new $Vertex5(q.p1[0], q.p1[1], q.p1[2], q.u1, q.v1)
            colours[idx + 1]     = c1
            model.verts[idx + 2] = new $Vertex5(q.p2[0], q.p2[1], q.p2[2], q.u2, q.v2)
            colours[idx + 2]     = c2
            model.verts[idx + 3] = new $Vertex5(q.p3[0], q.p3[1], q.p3[2], q.u3, q.v3)
            colours[idx + 3]     = c3
            idx += 4
        }
        // 烘焙期统一计算法线（同时兼容 POSITION_COLOR_TEX 与 NEW_ENTITY 顶点格式）
        model.computeNormals()
        return model
    }

    // ======================================================================== 4. 绑定管理 API
    function bindItem(itemId, spec) {
        if (typeof itemId !== 'string' || !itemId) return false
        ITEM_BINDINGS[itemId] = spec || {}
        delete RESOLVED_CACHE[itemId]
        return true
    }

    function unbindItem(itemId) {
        if (typeof itemId !== 'string' || !itemId) return false
        delete ITEM_BINDINGS[itemId]
        delete RESOLVED_CACHE[itemId]
        return true
    }

    function absorbGlobalBindings() {
        var map = (typeof global !== 'undefined' && global != null) ? global.Epiphy3DFXItemBindings : null
        if (!isPlainObjLike(map)) return
        for (var id in map) {
            if (Object.prototype.hasOwnProperty.call(map, id)) {
                ITEM_BINDINGS[id] = map[id]
                delete RESOLVED_CACHE[id]
            }
        }
    }

    function getBoundItemConfig(itemId) {
        if (typeof itemId !== 'string' || !itemId) return null
        if (!Object.prototype.hasOwnProperty.call(ITEM_BINDINGS, itemId)) {
            absorbGlobalBindings()
        }
        if (!Object.prototype.hasOwnProperty.call(ITEM_BINDINGS, itemId)) return null
        if (RESOLVED_CACHE[itemId] !== undefined) return RESOLVED_CACHE[itemId]
        var cfg = normalizeItemSpec(itemId, ITEM_BINDINGS[itemId])
        RESOLVED_CACHE[itemId] = cfg
        return cfg
    }

    // ======================================================================== 5. Forge ModBus 挂钩：核心着色器注册 & IItemRenderer 预烘焙
    function updateShaderUniformHandles(shaderInst) {
        COSMOS_SHADER = shaderInst
        SHADER_UNIFORMS.time       = null
        SHADER_UNIFORMS.yawPitch   = null
        SHADER_UNIFORMS.guiMode    = null
        SHADER_UNIFORMS.fnTime     = null
        SHADER_UNIFORMS.fnYawPitch = null
        SHADER_UNIFORMS.fnGuiMode  = null
        SHADER_STATUS.loaded       = (shaderInst != null)
        if (shaderInst == null) return
        try { SHADER_UNIFORMS.time     = callMcMember(shaderInst, 'getUniform', 'm_173348_', 'EpiphyTime') } catch (e0) { }
        try { SHADER_UNIFORMS.yawPitch = callMcMember(shaderInst, 'getUniform', 'm_173348_', 'EpiphyYawPitch') } catch (e1) { }
        try { SHADER_UNIFORMS.guiMode  = callMcMember(shaderInst, 'getUniform', 'm_173348_', 'EpiphyGuiMode') } catch (e2) { }
        SHADER_UNIFORMS.fnTime     = resolveUniform1fSetter(SHADER_UNIFORMS.time)
        SHADER_UNIFORMS.fnYawPitch = resolveUniform2fSetter(SHADER_UNIFORMS.yawPitch)
        SHADER_UNIFORMS.fnGuiMode  = resolveUniform1fSetter(SHADER_UNIFORMS.guiMode)
    }

    function isClientSide() {
        try {
            if (typeof Platform !== 'undefined' && Platform != null && typeof Platform.isClientEnvironment === 'function') {
                var isCli = Boolean(Platform.isClientEnvironment())
                ENV_STATE = isCli ? 'client' : 'server'
                return isCli
            }
            ENV_STATE = 'server'
            return false
        } catch (ePlat) {
            ENV_STATE = 'probe_error'
            try {
                console.warn('[Epiphy3DFXCore] Platform.isClientEnvironment() 探测异常，已跳过客户端 3D 挂钩：' + ePlat)
            } catch (eLog) { }
            return false
        }
    }

    function probeCclBackend() {
        if (BACKEND_STATUS.cclChecked) return BACKEND_STATUS.cclAvailable
        BACKEND_STATUS.cclChecked = true
        var reqClasses = [
            'codechicken.lib.render.shader.CCShaderInstance',
            'codechicken.lib.render.item.IItemRenderer',
            'codechicken.lib.util.TransformUtils',
            'codechicken.lib.render.CCModel',
            'codechicken.lib.render.CCRenderState',
            'codechicken.lib.render.pipeline.attribute.ColourAttribute',
            'codechicken.lib.vec.Matrix4',
            'codechicken.lib.vec.Vector3',
            'codechicken.lib.vec.Vertex5'
        ]
        for (var ci = 0; ci < reqClasses.length; ci++) {
            var clsName = reqClasses[ci]
            try {
                var loaded = Java.loadClass(clsName)
                if (loaded == null) {
                    BACKEND_STATUS.cclAvailable = false
                    BACKEND_STATUS.mode         = 'vanilla_fallback'
                    BACKEND_STATUS.missingClass = clsName
                    break
                }
            } catch (eCcl) {
                BACKEND_STATUS.cclAvailable = false
                BACKEND_STATUS.mode         = 'vanilla_fallback'
                BACKEND_STATUS.missingClass = clsName
                break
            }
        }
        if (BACKEND_STATUS.missingClass == null) {
            BACKEND_STATUS.cclAvailable = true
            BACKEND_STATUS.mode         = 'ccl_gpu'
        } else if (!BACKEND_STATUS.warnedMissing) {
            BACKEND_STATUS.warnedMissing = true
            try {
                console.warn('[Epiphy3DFXCore] 未检测到 CodeChickenLib (' + BACKEND_STATUS.missingClass + ')，已自动降级为原版静态物品模型（跳过 3D 星空着色器与环绕特效烘焙，不影响物品正常显示）')
            } catch (eWarn) { }
        }
        return BACKEND_STATUS.cclAvailable
    }

    var IS_CLIENT_SIDE = isClientSide()

    if (IS_CLIENT_SIDE && typeof ForgeModEvents !== 'undefined' && ForgeModEvents != null) {
        // 5.1 通过 CodeChickenLib CCShaderInstance.create（单重载工厂，无 Rhino 构造二义性）注册 epiphy:epiphy_cosmos
        try {
            ForgeModEvents.onEvent('net.minecraftforge.client.event.RegisterShadersEvent', function (event) {
                SHADER_STATUS.lastError = null
                if (!probeCclBackend()) {
                    SHADER_STATUS.registered = false
                    return
                }
                SHADER_STATUS.registered = true
                try {
                    var $ResourceLocation    = Java.loadClass('net.minecraft.resources.ResourceLocation')
                    var $DefaultVertexFormat = Java.loadClass('com.mojang.blaze3d.vertex.DefaultVertexFormat')
                    var $Consumer            = Java.loadClass('java.util.function.Consumer')
                    var $CCShaderInstance    = Java.loadClass('codechicken.lib.render.shader.CCShaderInstance')

                    var posColTex = readMcMember($DefaultVertexFormat, 'POSITION_COLOR_TEX', 'f_85818_')
                    var provider  = event.getResourceProvider()
                    var shaderLoc = new $ResourceLocation('epiphy', 'epiphy_cosmos')
                    var shaderObj = $CCShaderInstance.create(provider, shaderLoc, posColTex)

                    event.registerShader(shaderObj, new $Consumer({
                        accept: function (loadedShader) {
                            updateShaderUniformHandles(loadedShader)
                            console.info('[Epiphy3DFXCore] 核心星空着色器 epiphy:epiphy_cosmos 已就绪 (uniforms=' +
                                (SHADER_UNIFORMS.time != null ? 'T' : '-') +
                                (SHADER_UNIFORMS.yawPitch != null ? 'Y' : '-') +
                                (SHADER_UNIFORMS.guiMode != null ? 'G' : '-') + ')')
                        }
                    }))
                    console.info('[Epiphy3DFXCore] 已提交注册自研核心星空着色器 epiphy:epiphy_cosmos')
                } catch (eShader) {
                    SHADER_STATUS.lastError = String(eShader)
                    console.error('[Epiphy3DFXCore] 注册 epiphy:epiphy_cosmos 着色器失败：' + eShader)
                }
            })
        } catch (eRegShaderHook) {
            console.warn('[Epiphy3DFXCore] 绑定 RegisterShadersEvent 失败：' + eRegShaderHook)
        }

        // 5.2 在模型烘焙阶段一次性预烘焙 CCModel 并包裹原始物品模型为 IItemRenderer
        try {
            ForgeModEvents.onEvent('net.minecraftforge.client.event.ModelEvent$ModifyBakingResult', function (event) {
                try {
                    BAKED_ITEMS = {}
                    BAKED_COUNT = 0
                    if (!probeCclBackend()) return
                    absorbGlobalBindings()
                    var itemIds = Object.keys(ITEM_BINDINGS)
                    if (itemIds.length === 0) return

                    var $ModelResourceLocation = Java.loadClass('net.minecraft.client.resources.model.ModelResourceLocation')
                    var $ResourceLocation      = Java.loadClass('net.minecraft.resources.ResourceLocation')
                    var $IItemRenderer         = Java.loadClass('codechicken.lib.render.item.IItemRenderer')
                    var $TransformUtils        = Java.loadClass('codechicken.lib.util.TransformUtils')
                    var $CCModel               = Java.loadClass('codechicken.lib.render.CCModel')
                    var $CCRenderState         = Java.loadClass('codechicken.lib.render.CCRenderState')
                    var $ColourAttribute       = Java.loadClass('codechicken.lib.render.pipeline.attribute.ColourAttribute')
                    var $Matrix4               = Java.loadClass('codechicken.lib.vec.Matrix4')
                    var $Vector3               = Java.loadClass('codechicken.lib.vec.Vector3')
                    var $Vertex5               = Java.loadClass('codechicken.lib.vec.Vertex5')
                    var $Minecraft             = Java.loadClass('net.minecraft.client.Minecraft')
                    var $GameRenderer          = Java.loadClass('net.minecraft.client.renderer.GameRenderer')
                    var $ItemRenderer          = Java.loadClass('net.minecraft.client.renderer.entity.ItemRenderer')
                    var $ItemBlockRenderTypes  = Java.loadClass('net.minecraft.client.renderer.ItemBlockRenderTypes')
                    var $ItemDisplayContext    = Java.loadClass('net.minecraft.world.item.ItemDisplayContext')
                    var $RenderStateShard      = Java.loadClass('net.minecraft.client.renderer.RenderStateShard')
                    var $ShaderStateShard      = Java.loadClass('net.minecraft.client.renderer.RenderStateShard$ShaderStateShard')
                    var $TextureStateShard     = Java.loadClass('net.minecraft.client.renderer.RenderStateShard$TextureStateShard')
                    var $RenderType            = Java.loadClass('net.minecraft.client.renderer.RenderType')
                    var $CompositeState        = Java.loadClass('net.minecraft.client.renderer.RenderType$CompositeState')
                    var $DefaultVertexFormat   = Java.loadClass('com.mojang.blaze3d.vertex.DefaultVertexFormat')
                    var $VertexFormatMode      = Java.loadClass('com.mojang.blaze3d.vertex.VertexFormat$Mode')
                    var $Supplier              = Java.loadClass('java.util.function.Supplier')

                    var posColTexFmt    = readMcMember($DefaultVertexFormat, 'POSITION_COLOR_TEX', 'f_85818_')
                    var transAlpha      = readMcMember($RenderStateShard, 'TRANSLUCENT_TRANSPARENCY', 'f_110139_')
                    var lightningBlend  = readMcMember($RenderStateShard, 'LIGHTNING_TRANSPARENCY', 'f_110136_')
                    var noCull          = readMcMember($RenderStateShard, 'NO_CULL', 'f_110110_')
                    var colorDepthWrite = readMcMember($RenderStateShard, 'COLOR_DEPTH_WRITE', 'f_110114_')
                    var colorOnlyWrite  = readMcMember($RenderStateShard, 'COLOR_WRITE', 'f_110115_')
                    var posColTexShard  = readMcMember($RenderStateShard, 'POSITION_COLOR_TEX_SHADER', 'f_173101_')
                    var guiContextEnum  = readMcMember($ItemDisplayContext, 'GUI', 'GUI')

                    // 预先解析热路径直连静态方法句柄（零每帧反射与临时数组分配）
                    var fnGetMc            = resolveMcMethod($Minecraft, 'getInstance', 'm_91087_')
                    var fnGetPosColTexSh   = resolveMcMethod($GameRenderer, 'getPositionColorTexShader', 'm_172814_')
                    var fnGetItemRenderRt  = resolveMcMethod($ItemBlockRenderTypes, 'getRenderType', 'm_109279_')
                    var fnGetFoilBufDirect = resolveMcMethod($ItemRenderer, 'getFoilBufferDirect', 'm_115222_')

                    // 构造无闪烁加法发光 RenderType 工厂：
                    //   - POSITION_COLOR_TEX (每顶点仅 3 字段，不吃世界暗光/红闪)
                    //   - LIGHTNING_TRANSPARENCY (SRC_ALPHA, ONE 严格可交换加法混合 -> 0 排序闪烁、0 共面闪烁)
                    //   - TextureStateShard(loc, true, false) (开启双线性滤波抗锯齿，柔光边缘如丝顺滑)
                    //   - NO_CULL + COLOR_WRITE (不写深度，只做深度测试被剑身真实遮挡) + sortOnUpload=false
                    var vfxShaderState = posColTexShard != null
                        ? posColTexShard
                        : new $ShaderStateShard(new $Supplier({ get: function () { return fnGetPosColTexSh.call($GameRenderer) } }))
                    var vfxBlendState = lightningBlend != null ? lightningBlend : transAlpha
                    var buildAdditiveVfxType = function (rtName, texPath) {
                        var b = callMcMember($CompositeState, 'builder', 'm_110628_')
                        b = callMcMember(b, 'setShaderState', 'm_173292_', vfxShaderState)
                        b = callMcMember(b, 'setTextureState', 'm_173290_', new $TextureStateShard(new $ResourceLocation('epiphy', texPath), true, false))
                        b = callMcMember(b, 'setTransparencyState', 'm_110685_', vfxBlendState)
                        b = callMcMember(b, 'setCullState', 'm_110661_', noCull)
                        b = callMcMember(b, 'setWriteMaskState', 'm_110687_', colorOnlyWrite)
                        return callMcMember(
                            $RenderType, 'create', 'm_173215_',
                            rtName,
                            posColTexFmt,
                            $VertexFormatMode.QUADS,
                            1024,
                            false,
                            false,
                            buildCompositeStateNone(b)
                        )
                    }
                    var vfxRibbonType = buildAdditiveVfxType('epiphy:fx3d_surround_ribbon', 'textures/effect/glow_ribbon.png')
                    var vfxStarType   = buildAdditiveVfxType('epiphy:fx3d_surround_star',   'textures/effect/star_flare.png')

                    var cosmosOverlayQuads = buildCosmosOverlayQuads()
                    var cosmosOverlayVerts = cosmosOverlayQuads.length * 4
                    var cosmosOverlayModel = bakeQuadsToCCModel(cosmosOverlayQuads, $CCModel, $Vertex5, $ColourAttribute, 'cosmos_overlay')
                    var modelsMap = event.getModels()
                    var fnFalse = function () { return false }
                    var bakedThisPass = 0

                    for (var idx = 0; idx < itemIds.length; idx++) {
                        (function (itemId) {
                            var cfg = getBoundItemConfig(itemId)
                            if (cfg == null) return

                            var mrl = new $ModelResourceLocation(new $ResourceLocation(itemId), 'inventory')
                            var originalModel = modelsMap.get(mrl)
                            if (originalModel == null) {
                                console.warn('[Epiphy3DFXCore] 未找到物品烘焙模型，跳过 3D 挂载：' + itemId)
                                return
                            }

                            // 构造专属星空蒙版 RenderType（使用 epiphy:epiphy_cosmos 核心着色器）
                            var cosmosType = null
                            if (cfg.cosmosWindow && cfg.cosmosWindow.enabled !== false && cfg.maskTexture) {
                                var cosmosShaderSup = new $Supplier({
                                    get: function () {
                                        if (COSMOS_SHADER != null) return COSMOS_SHADER
                                        return fnGetPosColTexSh.call($GameRenderer)
                                    }
                                })
                                var cb = callMcMember($CompositeState, 'builder', 'm_110628_')
                                cb = callMcMember(cb, 'setShaderState', 'm_173292_', new $ShaderStateShard(cosmosShaderSup))
                                cb = callMcMember(cb, 'setTextureState', 'm_173290_', new $TextureStateShard(new $ResourceLocation(cfg.maskTexture), false, false))
                                cb = callMcMember(cb, 'setTransparencyState', 'm_110685_', transAlpha)
                                cb = callMcMember(cb, 'setCullState', 'm_110661_', noCull)
                                cb = callMcMember(cb, 'setWriteMaskState', 'm_110687_', colorDepthWrite)
                                var cState = buildCompositeStateNone(cb)
                                cosmosType = callMcMember(
                                    $RenderType, 'create', 'm_173215_',
                                    'epiphy:cosmos_' + itemId.replace(':', '_'),
                                    posColTexFmt,
                                    $VertexFormatMode.QUADS,
                                    256,
                                    false,
                                    false,
                                    cState
                                )
                            }

                            var guardPxX  = 32.0 + Number(cfg.originX != null ? cfg.originX : -9.5)
                            var guardPxY  = 32.0 + Number(cfg.originY != null ? cfg.originY : 9.5)
                            var guardMX   = guardPxX * PX_TO_UNIT
                            var guardMY   = 1.0 - guardPxY * PX_TO_UNIT
                            var uxModel   = Number(cfg.ux != null ? cfg.ux : 0.698)
                            var uyModel   = -Number(cfg.uy != null ? cfg.uy : -0.716)
                            var bladeAng  = Math.atan2(uyModel, uxModel)
                            var ringBaseU = Number(cfg.ringCenterU != null ? cfg.ringCenterU : 9.6)

                            var totalSurroundVerts = 0

                            // 一次性预烘焙 3D 星盘陀螺环（丝带与四芒星节点分离至各自柔光贴图模型）
                            var bakedRings = []
                            var ringsSpec = Array.isArray(cfg.rings) ? cfg.rings : []
                            for (var ri = 0; ri < ringsSpec.length; ri++) {
                                var rCfg = ringsSpec[ri]
                                var rQuads = buildAstrolabeRingQuads(rCfg)
                                var rModel = bakeQuadsToCCModel(rQuads, $CCModel, $Vertex5, $ColourAttribute, itemId + ':ring' + ri)
                                var rStarQuads = buildAstrolabeRingStarQuads(rCfg)
                                var rStarModel = bakeQuadsToCCModel(rStarQuads, $CCModel, $Vertex5, $ColourAttribute, itemId + ':ringStar' + ri)
                                if (rModel != null) {
                                    var rVerts = rModel.verts ? rModel.verts.length : (rQuads.length * 4)
                                    var rsVerts = rStarModel != null ? (rStarModel.verts ? rStarModel.verts.length : (rStarQuads.length * 4)) : 0
                                    totalSurroundVerts += rVerts + rsVerts
                                    var rU = (ringBaseU + Number(rCfg.uOffset || 0.0)) * PX_TO_UNIT
                                    bakedRings.push({
                                        model:     rModel,
                                        verts:     rVerts,
                                        starModel: rStarModel,
                                        starVerts: rsVerts,
                                        cx:        guardMX + uxModel * rU,
                                        cy:        guardMY + uyModel * rU,
                                        tiltU:     Number(rCfg.tiltU || 0.0),
                                        tiltV:     Number(rCfg.tiltV || 0.0),
                                        spd:       Number(rCfg.spd != null ? rCfg.spd : 0.65)
                                    })
                                }
                            }

                            // 一次性预烘焙双螺旋缠刃丝线（2 股连续 Frenet 曲线合并为单个 CCModel）
                            var bakedHelixModel = null
                            var bakedHelixVerts = 0
                            var bakedHelixStrands = 0
                            var helixSpd = Number(cfg.helix && cfg.helix.speed != null ? cfg.helix.speed : 1.15)
                            if (cfg.helix && cfg.helix.enabled !== false) {
                                var combinedHelixQuads = []
                                for (var hs = 0; hs < 2; hs++) {
                                    var hq = buildHelixRibbonQuads(cfg.helix, hs)
                                    if (hq.length > 0) {
                                        bakedHelixStrands++
                                        for (var hqi = 0; hqi < hq.length; hqi++) combinedHelixQuads.push(hq[hqi])
                                    }
                                }
                                bakedHelixModel = bakeQuadsToCCModel(combinedHelixQuads, $CCModel, $Vertex5, $ColourAttribute, itemId + ':helix')
                                if (bakedHelixModel != null) {
                                    bakedHelixVerts = bakedHelixModel.verts ? bakedHelixModel.verts.length : (combinedHelixQuads.length * 4)
                                    totalSurroundVerts += bakedHelixVerts
                                }
                            }

                            // 一次性预烘焙精选柔光漂浮四芒星点（2 个慢速反向轨道簇，克制清透）
                            var bakedMoteGroups = []
                            var moteSpds = [0.42, -0.34]
                            if (cfg.motes && cfg.motes.enabled !== false) {
                                for (var mg = 0; mg < 2; mg++) {
                                    var mQuads = buildStarMotesQuads(cfg.motes, mg, 2)
                                    var mModel = bakeQuadsToCCModel(mQuads, $CCModel, $Vertex5, $ColourAttribute, itemId + ':motes' + mg)
                                    if (mModel != null) {
                                        var mVerts = mModel.verts ? mModel.verts.length : (mQuads.length * 4)
                                        totalSurroundVerts += mVerts
                                        bakedMoteGroups.push({
                                            model: mModel,
                                            verts: mVerts,
                                            spd:   moteSpds[mg],
                                            phase: mg * PI
                                        })
                                    }
                                }
                            }

                            // 热路径复用的 Matrix4 与轴向量（零每帧对象分配、零 JS 逐顶点循环）
                            var baseMat     = new $Matrix4()
                            var workMat     = new $Matrix4()
                            var vecX        = $Vector3.X_POS
                            var vecY        = $Vector3.Y_POS
                            var vecZ        = $Vector3.Z_POS
                            var speedMul    = Number(cfg.speed != null ? cfg.speed : 1.0)
                            var slashExpand = Number(cfg.slashExpand != null ? cfg.slashExpand : 0.45)

                            var cachedMc          = null
                            var cachedItemRen     = null
                            var fnRenderLists     = null
                            var fnGetFrameTime    = null
                            var fnHasFoil         = null
                            var playerFieldKey    = null
                            var fnGetViewYRot     = null
                            var fnGetViewXRot     = null
                            var fnGetAttackAnim   = null
                            var playerMethodsInit = false

                            var getParticleIconFn = function () {
                                try { return callMcMember(originalModel, 'getParticleIcon', 'm_6160_') } catch (eIcon) { return null }
                            }

                            var renderer = new $IItemRenderer({
                                renderItem: function (stack, displayContext, mStack, getter, packedLight, packedOverlay) {
                                    var t0Ms = MONO_CLOCK.nowMs()
                                    if (cachedMc == null && fnGetMc != null) {
                                        cachedMc = fnGetMc.call($Minecraft)
                                        if (cachedMc != null) {
                                            cachedItemRen  = callMcMember(cachedMc, 'getItemRenderer', 'm_91291_')
                                            fnGetFrameTime = resolveMcMethod(cachedMc, 'getFrameTime', 'm_91296_')
                                            if (cachedItemRen != null) {
                                                fnRenderLists = resolveMcMethod(cachedItemRen, 'renderModelLists', 'm_115189_')
                                            }
                                            if (cachedMc.player !== undefined) playerFieldKey = 'player'
                                            else if (cachedMc.f_91074_ !== undefined) playerFieldKey = 'f_91074_'
                                        }
                                    }
                                    if (fnHasFoil == null && stack != null) {
                                        fnHasFoil = resolveMcMethod(stack, 'hasFoil', 'm_41790_')
                                    }

                                    var isGui = (displayContext === guiContextEnum)
                                    var didOrig = false
                                    var didCosmos = false
                                    var didSurround = false
                                    var drawnVerts = 0
                                    var origUs = 0, flushUs = 0, cosmosUs = 0, surroundUs = 0

                                    RUNTIME_STATS.renderCalls++
                                    if (isGui) RUNTIME_STATS.guiCalls++
                                    else RUNTIME_STATS.handCalls++

                                    // 1. 绘制原版 64x64 立体挤出剑身模型（含附魔光效）并刷新写入深度缓冲
                                    if (cachedItemRen != null && fnRenderLists != null && originalModel != null) {
                                        try {
                                            var tOrig0 = MONO_CLOCK.nowMs()
                                            var origRt = fnGetItemRenderRt.call($ItemBlockRenderTypes, stack, true)
                                            var hasFoil = fnHasFoil != null ? Boolean(fnHasFoil.call(stack)) : false
                                            var vcOrig = fnGetFoilBufDirect.call($ItemRenderer, getter, origRt, true, hasFoil)
                                            fnRenderLists.call(cachedItemRen, originalModel, stack, packedLight, packedOverlay, mStack, vcOrig)
                                            var tOrig1 = MONO_CLOCK.nowMs()
                                            origUs = Math.max(0, Math.round((tOrig1 - tOrig0) * 1000.0))
                                            flushRenderType(getter, origRt)
                                            flushUs = Math.max(0, Math.round((MONO_CLOCK.nowMs() - tOrig1) * 1000.0))
                                            didOrig = true
                                            RUNTIME_STATS.origDraws++
                                        } catch (eOrig) {
                                            logErrorThrottled('renderOrig_' + itemId, eOrig)
                                        }
                                    }

                                    if (!CONFIG.enabled || getter == null) return

                                    var t = nowSeconds() * speedMul
                                    if (!isFinite(t)) t = 0.0
                                    var yawRad = 0.0
                                    var pitchRad = 0.0
                                    var slashScale = 1.0

                                    if (!isGui && cachedMc != null && playerFieldKey != null) {
                                        var player = cachedMc[playerFieldKey]
                                        if (player != null) {
                                            if (!playerMethodsInit) {
                                                playerMethodsInit = true
                                                fnGetViewYRot   = resolveMcMethod(player, 'getViewYRot', 'm_5675_')
                                                fnGetViewXRot   = resolveMcMethod(player, 'getViewXRot', 'm_5686_')
                                                fnGetAttackAnim = resolveMcMethod(player, 'getAttackAnim', 'm_21324_')
                                            }
                                            var partial = fnGetFrameTime != null ? Number(fnGetFrameTime.call(cachedMc) || 0.0) : 0.0
                                            if (fnGetViewYRot != null) {
                                                var yv = Number(fnGetViewYRot.call(player, partial) || 0.0) * DEG_TO_RAD
                                                if (isFinite(yv)) yawRad = yv
                                            }
                                            if (fnGetViewXRot != null) {
                                                var pv = Number(fnGetViewXRot.call(player, partial) || 0.0) * DEG_TO_RAD
                                                if (isFinite(pv)) pitchRad = pv
                                            }
                                            if (fnGetAttackAnim != null) {
                                                var swing = Number(fnGetAttackAnim.call(player, partial) || 0.0)
                                                if (swing > 0.001 && swing < 0.999) {
                                                    var ss = 1.0 + Math.sin(swing * PI) * slashExpand
                                                    if (isFinite(ss)) slashScale = ss
                                                }
                                            }
                                        }
                                    }

                                    var ccrs = $CCRenderState.instance()
                                    baseMat.set(mStack)

                                    // 2. GPU 核心着色器深空星空窗口（仅 2 quad = 8 顶点；绘制后立即 flush 锁定 uniform 防 Hand/GUI 串扰）
                                    if (CONFIG.cosmosEnabled && cosmosType != null && cosmosOverlayModel != null && COSMOS_SHADER != null) {
                                        try {
                                            var tCos0 = MONO_CLOCK.nowMs()
                                            if (SHADER_UNIFORMS.fnTime != null) SHADER_UNIFORMS.fnTime.call(SHADER_UNIFORMS.time, t)
                                            if (SHADER_UNIFORMS.fnYawPitch != null) SHADER_UNIFORMS.fnYawPitch.call(SHADER_UNIFORMS.yawPitch, yawRad, pitchRad)
                                            if (SHADER_UNIFORMS.fnGuiMode != null) SHADER_UNIFORMS.fnGuiMode.call(SHADER_UNIFORMS.guiMode, isGui ? 1.0 : 0.0)
                                            ccrs.reset()
                                            ccrs.computeLighting = false
                                            ccrs.baseColour = -1
                                            ccrs.bind(cosmosType, getter)
                                            cosmosOverlayModel.render(ccrs, baseMat)
                                            flushRenderType(getter, cosmosType)
                                            didCosmos = true
                                            drawnVerts += cosmosOverlayVerts
                                            RUNTIME_STATS.cosmosDraws++
                                            cosmosUs = Math.max(0, Math.round((MONO_CLOCK.nowMs() - tCos0) * 1000.0))
                                        } catch (eCos) {
                                            logErrorThrottled('renderCosmos_' + itemId, eCos)
                                        }
                                    }

                                    // 3. 预烘焙 3D 环绕特效（无闪烁加法发光双管线：先柔光丝带 glow_ribbon，再四芒星芒 star_flare）
                                    if (CONFIG.surroundEnabled && vfxRibbonType != null) {
                                        try {
                                            var tSur0 = MONO_CLOCK.nowMs()
                                            var radScale = isGui ? CONFIG.guiSurroundScale : slashScale
                                            var ringLim  = isGui ? Math.min(bakedRings.length, CONFIG.guiRingLimit) : bakedRings.length
                                            var drawHelix = (!isGui || CONFIG.guiRenderHelix) && bakedHelixModel != null
                                            var drawMotes = (!isGui || CONFIG.guiRenderMotes) && bakedMoteGroups.length > 0
                                            var surVerts = 0

                                            // 3a. 柔光丝带批次（星盘双环 + 连续双螺旋丝线）
                                            if (ringLim > 0 || drawHelix) {
                                                ccrs.reset()
                                                ccrs.computeLighting = false
                                                ccrs.baseColour = -1
                                                ccrs.bind(vfxRibbonType, getter)

                                                for (var rIdx = 0; rIdx < ringLim; rIdx++) {
                                                    var br = bakedRings[rIdx]
                                                    workMat.set(baseMat)
                                                    workMat.translate(br.cx, br.cy, 0.5)
                                                    workMat.rotate(bladeAng, vecZ)
                                                    if (radScale !== 1.0) workMat.scale(radScale)
                                                    if (br.tiltV !== 0.0) workMat.rotate(br.tiltV, vecZ)
                                                    if (br.tiltU !== 0.0) workMat.rotate(br.tiltU, vecY)
                                                    workMat.rotate(t * br.spd, vecX)
                                                    br.model.render(ccrs, workMat)
                                                    surVerts += br.verts
                                                }

                                                if (drawHelix) {
                                                    workMat.set(baseMat)
                                                    workMat.translate(guardMX, guardMY, 0.5)
                                                    workMat.rotate(bladeAng, vecZ)
                                                    if (radScale !== 1.0) workMat.scale(1.0, radScale, radScale)
                                                    workMat.rotate(t * helixSpd, vecX)
                                                    bakedHelixModel.render(ccrs, workMat)
                                                    surVerts += bakedHelixVerts
                                                }
                                            }

                                            // 3b. 柔光四芒星芒批次（星盘方位星芒 + 精选漂浮星点）
                                            if (vfxStarType != null && (ringLim > 0 || drawMotes)) {
                                                var hasRingStars = false
                                                for (var rsChk = 0; rsChk < ringLim; rsChk++) {
                                                    if (bakedRings[rsChk].starModel != null) { hasRingStars = true; break }
                                                }
                                                if (hasRingStars || drawMotes) {
                                                    ccrs.reset()
                                                    ccrs.computeLighting = false
                                                    ccrs.baseColour = -1
                                                    ccrs.bind(vfxStarType, getter)

                                                    for (var rsIdx = 0; rsIdx < ringLim; rsIdx++) {
                                                        var brs = bakedRings[rsIdx]
                                                        if (brs.starModel == null) continue
                                                        workMat.set(baseMat)
                                                        workMat.translate(brs.cx, brs.cy, 0.5)
                                                        workMat.rotate(bladeAng, vecZ)
                                                        if (radScale !== 1.0) workMat.scale(radScale)
                                                        if (brs.tiltV !== 0.0) workMat.rotate(brs.tiltV, vecZ)
                                                        if (brs.tiltU !== 0.0) workMat.rotate(brs.tiltU, vecY)
                                                        workMat.rotate(t * brs.spd, vecX)
                                                        brs.starModel.render(ccrs, workMat)
                                                        surVerts += brs.starVerts
                                                    }

                                                    if (drawMotes) {
                                                        for (var mIdx = 0; mIdx < bakedMoteGroups.length; mIdx++) {
                                                            var bm = bakedMoteGroups[mIdx]
                                                            var bobU = Math.sin(t * 1.1 + bm.phase) * 0.9 * PX_TO_UNIT
                                                            workMat.set(baseMat)
                                                            workMat.translate(guardMX + uxModel * bobU, guardMY + uyModel * bobU, 0.5)
                                                            workMat.rotate(bladeAng, vecZ)
                                                            if (radScale !== 1.0) workMat.scale(1.0, radScale, radScale)
                                                            workMat.rotate(t * bm.spd, vecX)
                                                            bm.model.render(ccrs, workMat)
                                                            surVerts += bm.verts
                                                        }
                                                    }
                                                }
                                            }

                                            if (surVerts > 0) {
                                                drawnVerts += surVerts
                                                didSurround = true
                                                RUNTIME_STATS.surroundDraws++
                                            }
                                            surroundUs = Math.max(0, Math.round((MONO_CLOCK.nowMs() - tSur0) * 1000.0))
                                        } catch (eVfx) {
                                            logErrorThrottled('renderSurround_' + itemId, eVfx)
                                        }
                                    }

                                    var durUs = Math.round((MONO_CLOCK.nowMs() - t0Ms) * 1000.0)
                                    if (durUs < 0) durUs = 0
                                    RUNTIME_STATS.lastRenderUs = durUs
                                    RUNTIME_STATS.totalRenderUs += durUs
                                    if (durUs > RUNTIME_STATS.maxRenderUs) RUNTIME_STATS.maxRenderUs = durUs

                                    if ((!isGui && !RUNTIME_STATS.loggedFirstHand) || (isGui && !RUNTIME_STATS.loggedFirstGui)) {
                                        if (isGui) RUNTIME_STATS.loggedFirstGui = true
                                        else RUNTIME_STATS.loggedFirstHand = true
                                        try {
                                            console.info('[Epiphy3DFXCore] 首次渲染命中 ' + itemId +
                                                ' (ctx=' + String(displayContext) +
                                                ', isGui=' + isGui +
                                                ', orig=' + didOrig + '(' + origUs + 'us)' +
                                                ', flush=' + flushUs + 'us' +
                                                ', cosmos=' + didCosmos + '(' + cosmosUs + 'us)' +
                                                ', surround=' + didSurround + '(' + surroundUs + 'us)' +
                                                ', verts=' + drawnVerts +
                                                ', totalUs=' + durUs + ')')
                                        } catch (eDiag) { }
                                    }
                                },
                                getModelState: function () {
                                    return $TransformUtils.DEFAULT_TOOL
                                },
                                m_7541_: fnFalse,
                                useAmbientOcclusion: fnFalse,
                                m_7539_: fnFalse,
                                isGui3d: fnFalse,
                                m_7547_: fnFalse,
                                usesBlockLight: fnFalse,
                                m_6160_: getParticleIconFn,
                                getParticleIcon: getParticleIconFn
                            })

                            modelsMap.put(mrl, renderer)
                            BAKED_ITEMS[itemId] = {
                                rings:        bakedRings.length,
                                helices:      bakedHelixStrands,
                                moteGroups:   bakedMoteGroups.length,
                                surroundVerts: totalSurroundVerts,
                                hasCosmos:    cosmosType != null,
                                maskTexture:  cfg.maskTexture
                            }
                            console.info('[Epiphy3DFXCore] 已预烘焙 ' + itemId +
                                ' (rings=' + bakedRings.length +
                                ', helices=' + bakedHelixStrands +
                                ', motes=' + bakedMoteGroups.length +
                                ', surroundVerts=' + totalSurroundVerts + ')')
                            bakedThisPass++
                        })(itemIds[idx])
                    }

                    BAKED_COUNT = bakedThisPass
                } catch (eBake) {
                    console.error('[Epiphy3DFXCore] ModelEvent$ModifyBakingResult 预烘焙失败：' + eBake)
                }
            })
        } catch (eRegBakeHook) {
            console.warn('[Epiphy3DFXCore] 绑定 ModelEvent$ModifyBakingResult 失败：' + eRegBakeHook)
        }
    }

    // 5.3 世界空间 3D 渲染相位桥接 (RenderLevelStageEvent)：零活跃特效时 O(1) 短路零开销
    if (IS_CLIENT_SIDE && typeof ForgeEvents !== 'undefined' && ForgeEvents != null &&
        typeof ForgeEvents.onEvent === 'function') {
        try {
            ForgeEvents.onEvent('net.minecraftforge.client.event.RenderLevelStageEvent', function (forgeEvent) {
                if (!CONFIG.enabled) return
                var fx3d = (typeof global !== 'undefined' && global != null) ? global.Epiphy3DFX : null
                if (fx3d == null || typeof fx3d._hasActiveWorldFx !== 'function' || !fx3d._hasActiveWorldFx()) return
                if (typeof fx3d._onRenderLevelStage === 'function') {
                    fx3d._onRenderLevelStage(forgeEvent)
                }
            })
            WORLD_HOOK_STATE.registered = true
        } catch (eWorldHook) {
            WORLD_HOOK_STATE.registered = false
            try {
                console.warn('[Epiphy3DFXCore] 绑定 RenderLevelStageEvent 失败，世界 3D 特效渲染已跳过：' + eWorldHook)
            } catch (eWL) { }
        }
    }

    // ======================================================================== 6. 公开 API 导出
    var API = {
        VERSION:              VERSION,
        CONFIG:               CONFIG,
        bindItem:             bindItem,
        unbindItem:           unbindItem,
        absorbGlobalBindings: absorbGlobalBindings,
        getBoundItemConfig:   getBoundItemConfig,
        getShaderStatus: function () {
            return {
                registered: SHADER_STATUS.registered,
                loaded:     SHADER_STATUS.loaded,
                hasUniforms: (SHADER_UNIFORMS.time != null && SHADER_UNIFORMS.yawPitch != null && SHADER_UNIFORMS.guiMode != null),
                lastError:  SHADER_STATUS.lastError
            }
        },
        getStats: function () {
            var avgUs = RUNTIME_STATS.renderCalls > 0
                ? Math.round(RUNTIME_STATS.totalRenderUs / RUNTIME_STATS.renderCalls)
                : 0
            return {
                version:             VERSION,
                enabled:             CONFIG.enabled,
                envState:            ENV_STATE,
                cclAvailable:        BACKEND_STATUS.cclAvailable,
                backendMode:         BACKEND_STATUS.mode,
                missingClass:        BACKEND_STATUS.missingClass,
                worldHookRegistered: WORLD_HOOK_STATE.registered,
                clockSource:         MONO_CLOCK.getSource(),
                boundCount:          Object.keys(ITEM_BINDINGS).length,
                bakedCount:          BAKED_COUNT,
                bakedItems:          BAKED_ITEMS,
                shaderLoaded:        SHADER_STATUS.loaded,
                runtime: {
                    renderCalls:   RUNTIME_STATS.renderCalls,
                    handCalls:     RUNTIME_STATS.handCalls,
                    guiCalls:      RUNTIME_STATS.guiCalls,
                    origDraws:     RUNTIME_STATS.origDraws,
                    cosmosDraws:   RUNTIME_STATS.cosmosDraws,
                    surroundDraws: RUNTIME_STATS.surroundDraws,
                    lastRenderUs:  RUNTIME_STATS.lastRenderUs,
                    maxRenderUs:   RUNTIME_STATS.maxRenderUs,
                    avgRenderUs:   avgUs,
                    lastError:     RUNTIME_STATS.lastError
                }
            }
        },
        _pure: {
            packRgba:                   packRgba,
            normalizeItemSpec:          normalizeItemSpec,
            pushCrossSegmentQuads:      pushCrossSegmentQuads,
            pushStarFlare3DQuads:       pushStarFlare3DQuads,
            pushStarPrism3DQuads:       pushStarPrism3DQuads,
            buildCosmosOverlayQuads:    buildCosmosOverlayQuads,
            buildAstrolabeRingQuads:    buildAstrolabeRingQuads,
            buildAstrolabeRingStarQuads: buildAstrolabeRingStarQuads,
            buildHelixRibbonQuads:      buildHelixRibbonQuads,
            buildStarMotesQuads:        buildStarMotesQuads,
            validateQuadsFinite:        validateQuadsFinite
        }
    }

    if (typeof global !== 'undefined') {
        global.Epiphy3DFXCore = API
    }
})()
