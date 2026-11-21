// priority: 1050
// ============================================================================
//  Epiphy 的通用组件 —— 空间特效渲染核心 (Epiphy3DFXCore v1.0.1 · Startup/ModBus)
//  许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
//  放置位置：kubejs/startup_scripts/通用组件/Epiphy的-空间特效核心.js
//  架构定位：
//    - 视觉表现层【子系统 B】(详见 docs/rendering-subsystem-roadmap.md §1、§2 功能六 & §8.1 P3-2)
//    - 彻底与【子系统 A】2D 平面渲染器 (Epiphy的-平面渲染器.js) 解耦，专职三维物品渲染管线：
//      1. 通过 RegisterShadersEvent + CodeChickenLib CCShaderInstance.create（单重载工厂，根治 Rhino
//         ShaderInstance 构造二义性）注册 100% 自研 GLSL 核心着色器 `epiphy:epiphy_cosmos`；
//      2. 通过 ModelEvent$ModifyBakingResult 挂载 CodeChickenLib IItemRenderer，在烘焙期一次性预烘焙
//         星窗面片、3D 星盘陀螺环、度盘刻度与四芒星棱晶、双螺旋缠刃光带及 14 枚 3D 游弋星屑；
//      3. 热路径彻底零反射、零临时数组、零 ClassFilter 异常、零 JS 顶点循环：
//         直连缓存方法句柄 + 纯 JS 单调时钟 + 轻量化预烘焙网格 + GUI 槽位轻量 LOD，
//         兼顾真实硬件深度前后遮挡与手持/背包全程满帧无卡顿。
//  语法规范：遵循 README-LLM.md §1 强制 Rhino ES5 语法基准。
// ============================================================================

;(function () {
    var VERSION    = '1.0.1'
    var PI         = Math.PI
    var TWO_PI     = Math.PI * 2.0
    var DEG_TO_RAD = Math.PI / 180.0
    var PX_TO_UNIT = 1.0 / 64.0
    var ENV_STATE  = 'unknown'

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
        time:     null,
        yawPitch: null,
        guiMode:  null
    }
    var SHADER_STATUS = {
        registered: false,
        loaded:     false,
        lastError:  null
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

    function flushRenderType(getter, rt) {
        if (getter == null || rt == null) return
        if (typeof getter.m_109912_ === 'function') {
            getter.m_109912_(rt)
            return
        }
        if (typeof getter.endBatch === 'function') {
            getter.endBatch(rt)
        }
    }

    function setUniform1f(u, v) {
        if (u == null) return
        if (typeof u.glUniform1f === 'function') { u.glUniform1f(v); return }
        if (typeof u.m_5985_ === 'function') { u.m_5985_(v); return }
        if (typeof u.set === 'function') u.set(v)
    }

    function setUniform2f(u, v0, v1) {
        if (u == null) return
        if (typeof u.glUniform2f === 'function') { u.glUniform2f(v0, v1); return }
        if (typeof u.m_7971_ === 'function') { u.m_7971_(v0, v1); return }
        if (typeof u.set === 'function') u.set(v0, v1)
    }

    // ======================================================================== 2. 默认预设归一化（与 fx3d Spec 对齐）
    function getDefaultItemSpec() {
        return {
            scheme:         's1',
            maskTexture:    null,
            speed:          1.2,
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
                parallax: 1.8,
                speed:    1.2
            },
            rings: [
                {
                    R: 8.8, tiltU: 0.46, tiltV: 0.15, spd: 1.15, segs: 28,
                    cCore: 0xFFF7DA, cGlow: 0xF5B952, ticks: 12, prisms: 4, wBase: 1.45, uOffset: 0.0
                },
                {
                    R: 12.8, tiltU: -0.64, tiltV: -0.22, spd: -0.85, segs: 32,
                    cCore: 0xC6F2FF, cGlow: 0xB86BFF, ticks: 8, prisms: 2, wBase: 1.30, uOffset: 0.0
                },
                {
                    R: 6.2, tiltU: 0.18, tiltV: 0.0, spd: 1.75, segs: 20,
                    cCore: 0xFFE8AE, cGlow: 0xE84B84, ticks: 0, prisms: 0, wBase: 1.05, uOffset: -5.2
                }
            ],
            helix: {
                enabled: true,
                steps:   28,
                uStart:  2.0,
                uSpan:   49.0,
                radius:  5.4,
                freq:    0.21,
                speed:   2.3,
                cCore0:  0xFFEAC8,
                cGlow0:  0xF458AA,
                cCore1:  0xC2F4FF,
                cGlow1:  0x9672FF
            },
            motes: {
                enabled:    true,
                count:      14,
                trailSteps: 3
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
    function pushQuad(list, p0, p1, p2, p3, rgba, uvRect) {
        list.push({
            p0: p0, p1: p1, p2: p2, p3: p3,
            u0: uvRect ? uvRect[0] : 0.0, v0: uvRect ? uvRect[1] : 0.0,
            u1: uvRect ? uvRect[2] : 1.0, v1: uvRect ? uvRect[3] : 0.0,
            u2: uvRect ? uvRect[4] : 1.0, v2: uvRect ? uvRect[5] : 1.0,
            u3: uvRect ? uvRect[6] : 0.0, v3: uvRect ? uvRect[7] : 1.0,
            rgba: rgba
        })
    }

    function pushRibbonQuad(list, a, b, normal, halfW, rgba) {
        var hx = normal[0] * halfW, hy = normal[1] * halfW, hz = normal[2] * halfW
        pushQuad(
            list,
            [a[0] - hx, a[1] - hy, a[2] - hz],
            [a[0] + hx, a[1] + hy, a[2] + hz],
            [b[0] + hx, b[1] + hy, b[2] + hz],
            [b[0] - hx, b[1] - hy, b[2] - hz],
            rgba, null
        )
    }

    // 添加三维十字交叉光带段（两个正交面片，从任意角度观察都不会变细消失）
    function pushCrossSegmentQuads(list, a, b, n1, n2, halfW, rgba) {
        pushRibbonQuad(list, a, b, n1, halfW, rgba)
        pushRibbonQuad(list, a, b, n2, halfW, rgba)
    }

    // 添加三维双十字四芒星棱晶 ✦（两个正交四芒星菱形，轻量且任意角度均立体发光）
    function pushStarPrism3DQuads(list, cx, cy, cz, ax1, ax2, ax3, outerR, rgbaGlow, rgbaCore) {
        var pairs = [
            [ax1, ax2],
            [ax2, ax3],
            [ax1, ax3]
        ]
        var i, u, v, tipR, sideW
        for (i = 0; i < pairs.length; i++) {
            u = pairs[i][0]
            v = pairs[i][1]
            tipR  = outerR * 1.45
            sideW = outerR * 0.48
            pushQuad(
                list,
                [cx + u[0] * tipR,  cy + u[1] * tipR,  cz + u[2] * tipR],
                [cx + v[0] * sideW, cy + v[1] * sideW, cz + v[2] * sideW],
                [cx - u[0] * tipR,  cy - u[1] * tipR,  cz - u[2] * tipR],
                [cx - v[0] * sideW, cy - v[1] * sideW, cz - v[2] * sideW],
                rgbaGlow, null
            )
            tipR  = outerR * 0.96
            sideW = outerR * 0.24
            pushQuad(
                list,
                [cx + u[0] * tipR,  cy + u[1] * tipR,  cz + u[2] * tipR],
                [cx + v[0] * sideW, cy + v[1] * sideW, cz + v[2] * sideW],
                [cx - u[0] * tipR,  cy - u[1] * tipR,  cz - u[2] * tipR],
                [cx - v[0] * sideW, cy - v[1] * sideW, cz - v[2] * sideW],
                rgbaCore, null
            )
        }
    }

    // 3.1 剑身前后双面星窗覆盖面片（紧贴 item/generated 前后面 Z=0.53125/0.46875 外侧 0.001 单位，消除 Z-fighting）
    function buildCosmosOverlayQuads() {
        var quads = []
        var white = packRgba(0xFFFFFF, 255)
        var zFront = 0.5322
        var zBack  = 0.4678
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

    // 3.2 单个 3D 星盘陀螺环预烘焙网格（轻量化高对比丝带：每个环约 80~120 quads）
    function buildAstrolabeRingQuads(ring) {
        var quads = []
        var R     = Number(ring.R != null ? ring.R : 8.8) * PX_TO_UNIT
        var segs  = clampNum(Math.round(Number(ring.segs != null ? ring.segs : 28)), 16, 36)
        var wBase = Number(ring.wBase != null ? ring.wBase : 1.35) * PX_TO_UNIT
        var cCore = ring.cCore != null ? Number(ring.cCore) : 0xFFF7DA
        var cGlow = ring.cGlow != null ? Number(ring.cGlow) : 0xF5B952
        var rgbaGlow = packRgba(cGlow, 172)
        var rgbaCore = packRgba(cCore, 248)
        var rgbaTick = packRgba(cCore, 220)

        var wGlow = wBase * 0.82
        var wCore = wBase * 0.34
        var xAxis = [1.0, 0.0, 0.0]

        var i, a0, a1, c0, s0, c1, s1, p0, p1, radMid
        for (i = 0; i < segs; i++) {
            a0 = (i / segs) * TWO_PI
            a1 = ((i + 1) / segs) * TWO_PI
            c0 = Math.cos(a0); s0 = Math.sin(a0)
            c1 = Math.cos(a1); s1 = Math.sin(a1)
            p0 = [0.0, R * c0, R * s0]
            p1 = [0.0, R * c1, R * s1]
            var am = 0.5 * (a0 + a1)
            radMid = [0.0, Math.cos(am), Math.sin(am)]
            // 外层十字光带（保证正视与侧视均饱满满亮）+ 内层高光主环
            pushCrossSegmentQuads(quads, p0, p1, radMid, xAxis, wGlow, rgbaGlow)
            pushRibbonQuad(quads, p0, p1, radMid, wCore, rgbaCore)
        }

        // 星盘度盘刻度（限制上限 16 以保持极低顶点数）
        var ticks = clampNum(Math.round(Number(ring.ticks || 0)), 0, 16)
        if (ticks > 0) {
            var tickW = wBase * 0.28
            for (var tk = 0; tk < ticks; tk++) {
                var ta = (tk / ticks) * TWO_PI
                var tc = Math.cos(ta), ts = Math.sin(ta)
                var isMajor = (tk % 4 === 0)
                var rIn  = R - (isMajor ? 1.85 : 1.05) * PX_TO_UNIT
                var rOut = R + (isMajor ? 1.85 : 1.05) * PX_TO_UNIT
                var tanV = [0.0, -ts, tc]
                pushRibbonQuad(
                    quads,
                    [0.0, rIn * tc,  rIn * ts],
                    [0.0, rOut * tc, rOut * ts],
                    tanV, tickW, isMajor ? rgbaCore : rgbaTick
                )
            }
        }

        // 方位四芒星棱晶 ✦
        var prisms = clampNum(Math.round(Number(ring.prisms || 0)), 0, 6)
        if (prisms > 0) {
            var prismR = (2.45 * (ring.wBase != null ? Number(ring.wBase) : 1.35)) * PX_TO_UNIT
            var pGlow  = packRgba(cGlow, 195)
            var pCore  = packRgba(0xFFFFFF, 255)
            for (var pk = 0; pk < prisms; pk++) {
                var pa = (pk / prisms) * TWO_PI
                var pc = Math.cos(pa), ps = Math.sin(pa)
                var radVec = [0.0, pc, ps]
                var tanVec = [0.0, -ps, pc]
                pushStarPrism3DQuads(quads, 0.0, R * pc, R * ps, radVec, tanVec, xAxis, prismR, pGlow, pCore)
            }
        }

        return quads
    }

    // 3.3 双螺旋缠刃光带单股预烘焙网格（28 段轻量化丝带，约 84 quads/股）
    function buildHelixRibbonQuads(helix, strandIndex) {
        var quads = []
        if (!helix || helix.enabled === false) return quads
        var steps  = clampNum(Math.round(Number(helix.steps != null ? helix.steps : 28)), 16, 32)
        var uStartPx = Number(helix.uStart != null ? helix.uStart : 2.0)
        var uSpanPx  = Number(helix.uSpan != null ? helix.uSpan : 49.0)
        var uStart = uStartPx * PX_TO_UNIT
        var uSpan  = uSpanPx * PX_TO_UNIT
        var radMax = Number(helix.radius != null ? helix.radius : 5.4) * PX_TO_UNIT
        var freqPx = Number(helix.freq != null ? helix.freq : 0.21)
        var phase  = (strandIndex === 1) ? PI : 0.0
        var cCore  = (strandIndex === 1) ? Number(helix.cCore1 != null ? helix.cCore1 : 0xC2F4FF) : Number(helix.cCore0 != null ? helix.cCore0 : 0xFFEAC8)
        var cGlow  = (strandIndex === 1) ? Number(helix.cGlow1 != null ? helix.cGlow1 : 0x9672FF) : Number(helix.cGlow0 != null ? helix.cGlow0 : 0xF458AA)

        var prevP = null
        for (var i = 0; i <= steps; i++) {
            var frac  = i / steps
            var uPx   = uStartPx + frac * uSpanPx
            var u     = uStart + frac * uSpan
            var env   = Math.pow(Math.max(0.0, Math.sin(frac * PI)), 0.72)
            var r     = radMax * (0.30 + 0.70 * env)
            var ang   = uPx * freqPx + phase
            var ca    = Math.cos(ang), sa = Math.sin(ang)
            var curP  = [u, r * ca, r * sa]

            if (prevP != null) {
                var fade = Math.pow(Math.max(0.0, Math.sin((frac - 0.5 / steps) * PI)), 0.65)
                var wG   = (1.10 + 0.85 * fade) * PX_TO_UNIT
                var wC   = (0.44 + 0.35 * fade) * PX_TO_UNIT
                var aG   = Math.round(70 + 130 * fade)
                var aC   = Math.round(130 + 122 * fade)
                var radN = [0.0, ca, sa]
                var tanN = [1.0, 0.0, 0.0]
                pushCrossSegmentQuads(quads, prevP, curP, radN, tanN, wG, packRgba(cGlow, aG))
                pushRibbonQuad(quads, prevP, curP, radN, wC, packRgba(cCore, aC))
            }
            prevP = curP
        }
        return quads
    }

    // 3.4 3D 游弋星屑与彗尾分簇预烘焙网格（14 枚星屑分为 2 个反向轨道簇，轻量紧凑）
    function buildStarMotesQuads(motes, groupIndex, groupCount) {
        var quads = []
        if (!motes || motes.enabled === false) return quads
        var count      = clampNum(Math.round(Number(motes.count != null ? motes.count : 14)), 1, 18)
        var trailSteps = clampNum(Math.round(Number(motes.trailSteps != null ? motes.trailSteps : 3)), 2, 4)
        var gCount     = Math.max(1, groupCount || 2)
        var palette    = [0xFFF2C8, 0x8CF4FF, 0xE6A4FF, 0xFF9AC8]
        var xAxis      = [1.0, 0.0, 0.0]

        for (var i = 0; i < count; i++) {
            if ((i % gCount) !== groupIndex) continue
            var h1 = Math.sin(i * 12.9898 + 1.37) * 43758.5453; h1 = h1 - Math.floor(h1)
            var h2 = Math.sin(i * 78.233 + 4.19) * 19283.1234;  h2 = h2 - Math.floor(h2)
            var h3 = Math.sin(i * 39.425 + 7.61) * 28411.9812;  h3 = h3 - Math.floor(h3)

            var uBase = (2.5 + h1 * 48.0) * PX_TO_UNIT
            var orbR  = (7.5 + h2 * 7.5) * PX_TO_UNIT
            var ang0  = h3 * TWO_PI
            var cGlow = palette[i % palette.length]
            var dir   = (groupIndex === 1) ? -1.0 : 1.0

            var c0 = Math.cos(ang0), s0 = Math.sin(ang0)
            var hx = uBase, hy = orbR * c0, hz = orbR * s0
            var radV = [0.0, c0, s0]
            var tanV = [0.0, -s0, c0]
            var starR = (1.55 + 0.70 * h2) * PX_TO_UNIT
            pushStarPrism3DQuads(quads, hx, hy, hz, radV, tanV, xAxis, starR, packRgba(cGlow, 185), packRgba(0xFFFFFF, 255))

            var prevP = [hx, hy, hz]
            for (var ts = 1; ts <= trailSteps; ts++) {
                var frac = ts / trailSteps
                var aT   = ang0 - dir * frac * 0.44
                var uT   = uBase - frac * 1.5 * PX_TO_UNIT
                var rT   = orbR * (1.0 - frac * 0.05)
                var ct   = Math.cos(aT), st = Math.sin(aT)
                var curP = [uT, rT * ct, rT * st]
                var tw   = (0.78 * (1.0 - frac * 0.65)) * PX_TO_UNIT
                var ta   = Math.round(195 * (1.0 - frac) * (1.0 - frac))
                if (ta > 12) {
                    pushRibbonQuad(quads, prevP, curP, [0.0, ct, st], tw, packRgba(cGlow, ta))
                }
                prevP = curP
            }
        }
        return quads
    }

    function bakeQuadsToCCModel(quads, $CCModel, $Vertex5, $ColourAttribute) {
        if (!Array.isArray(quads) || quads.length === 0) return null
        var vCount = quads.length * 4
        var model = $CCModel.quadModel(vCount)
        var colours = model.getOrAllocate($ColourAttribute.attributeKey)
        var idx = 0
        for (var i = 0; i < quads.length; i++) {
            var q = quads[i]
            model.verts[idx]     = new $Vertex5(q.p0[0], q.p0[1], q.p0[2], q.u0, q.v0)
            colours[idx]         = q.rgba
            model.verts[idx + 1] = new $Vertex5(q.p1[0], q.p1[1], q.p1[2], q.u1, q.v1)
            colours[idx + 1]     = q.rgba
            model.verts[idx + 2] = new $Vertex5(q.p2[0], q.p2[1], q.p2[2], q.u2, q.v2)
            colours[idx + 2]     = q.rgba
            model.verts[idx + 3] = new $Vertex5(q.p3[0], q.p3[1], q.p3[2], q.u3, q.v3)
            colours[idx + 3]     = q.rgba
            idx += 4
        }
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
        SHADER_UNIFORMS.time     = null
        SHADER_UNIFORMS.yawPitch = null
        SHADER_UNIFORMS.guiMode  = null
        SHADER_STATUS.loaded     = (shaderInst != null)
        if (shaderInst == null) return
        try { SHADER_UNIFORMS.time     = callMcMember(shaderInst, 'getUniform', 'm_173348_', 'EpiphyTime') } catch (e0) { }
        try { SHADER_UNIFORMS.yawPitch = callMcMember(shaderInst, 'getUniform', 'm_173348_', 'EpiphyYawPitch') } catch (e1) { }
        try { SHADER_UNIFORMS.guiMode  = callMcMember(shaderInst, 'getUniform', 'm_173348_', 'EpiphyGuiMode') } catch (e2) { }
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

    if (isClientSide() && typeof ForgeModEvents !== 'undefined' && ForgeModEvents != null) {
        // 5.1 通过 CodeChickenLib CCShaderInstance.create（单重载工厂，无 Rhino 构造二义性）注册 epiphy:epiphy_cosmos
        try {
            ForgeModEvents.onEvent('net.minecraftforge.client.event.RegisterShadersEvent', function (event) {
                SHADER_STATUS.registered = true
                SHADER_STATUS.lastError  = null
                try {
                    var $ResourceLocation    = Java.loadClass('net.minecraft.resources.ResourceLocation')
                    var $DefaultVertexFormat = Java.loadClass('com.mojang.blaze3d.vertex.DefaultVertexFormat')
                    var $Consumer            = Java.loadClass('java.util.function.Consumer')
                    var $CCShaderInstance    = null
                    try { $CCShaderInstance = Java.loadClass('codechicken.lib.render.shader.CCShaderInstance') } catch (eCcs) { $CCShaderInstance = null }

                    var posColTex = readMcMember($DefaultVertexFormat, 'POSITION_COLOR_TEX', 'f_85818_')
                    var provider  = event.getResourceProvider()
                    var shaderLoc = new $ResourceLocation('epiphy', 'epiphy_cosmos')
                    var shaderObj = null

                    if ($CCShaderInstance != null && typeof $CCShaderInstance.create === 'function') {
                        shaderObj = $CCShaderInstance.create(provider, shaderLoc, posColTex)
                    } else {
                        var $ShaderInstance = Java.loadClass('net.minecraft.client.renderer.ShaderInstance')
                        shaderObj = new $ShaderInstance(provider, shaderLoc, posColTex)
                    }

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
                    absorbGlobalBindings()
                    var itemIds = Object.keys(ITEM_BINDINGS)
                    if (itemIds.length === 0) return

                    var $ModelResourceLocation = Java.loadClass('net.minecraft.client.resources.model.ModelResourceLocation')
                    var $ResourceLocation      = Java.loadClass('net.minecraft.resources.ResourceLocation')
                    var $CCModel               = Java.loadClass('codechicken.lib.render.CCModel')
                    var $CCRenderState         = Java.loadClass('codechicken.lib.render.CCRenderState')
                    var $IItemRenderer         = Java.loadClass('codechicken.lib.render.item.IItemRenderer')
                    var $TransformUtils        = Java.loadClass('codechicken.lib.util.TransformUtils')
                    var $Matrix4               = Java.loadClass('codechicken.lib.vec.Matrix4')
                    var $Vector3               = Java.loadClass('codechicken.lib.vec.Vector3')
                    var $Vertex5               = Java.loadClass('codechicken.lib.vec.Vertex5')
                    var $ColourAttribute       = Java.loadClass('codechicken.lib.render.pipeline.attribute.ColourAttribute')
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
                    var noCull          = readMcMember($RenderStateShard, 'NO_CULL', 'f_110110_')
                    var colorDepthWrite = readMcMember($RenderStateShard, 'COLOR_DEPTH_WRITE', 'f_110114_')
                    var colorOnlyWrite  = readMcMember($RenderStateShard, 'COLOR_WRITE', 'f_110115_')
                    var guiContextEnum  = readMcMember($ItemDisplayContext, 'GUI', 'GUI')

                    // 预先解析热路径直连静态方法句柄（零每帧反射与临时数组分配）
                    var fnGetMc            = resolveMcMethod($Minecraft, 'getInstance', 'm_91087_')
                    var fnGetPosColTexSh   = resolveMcMethod($GameRenderer, 'getPositionColorTexShader', 'm_172814_')
                    var fnGetItemRenderRt  = resolveMcMethod($ItemBlockRenderTypes, 'getRenderType', 'm_109279_')
                    var fnGetFoilBufDirect = resolveMcMethod($ItemRenderer, 'getFoilBufferDirect', 'm_115222_')

                    // 共享 3D 环绕特效 RenderType：沿用经真机验证 100% 稳定可见的 POSITION_COLOR_TEX + 纯白贴图 + TRANSLUCENT + NO_CULL + COLOR_WRITE
                    var vfxShaderSup = new $Supplier({
                        get: function () {
                            return fnGetPosColTexSh.call($GameRenderer)
                        }
                    })
                    var vfxBuilder = callMcMember($CompositeState, 'builder', 'm_110628_')
                    vfxBuilder = callMcMember(vfxBuilder, 'setShaderState', 'm_173292_', new $ShaderStateShard(vfxShaderSup))
                    vfxBuilder = callMcMember(vfxBuilder, 'setTextureState', 'm_173290_', new $TextureStateShard(new $ResourceLocation('epiphy', 'textures/effect/white_pixel.png'), false, false))
                    vfxBuilder = callMcMember(vfxBuilder, 'setTransparencyState', 'm_110685_', transAlpha)
                    vfxBuilder = callMcMember(vfxBuilder, 'setCullState', 'm_110661_', noCull)
                    vfxBuilder = callMcMember(vfxBuilder, 'setWriteMaskState', 'm_110687_', colorOnlyWrite)
                    var vfxState = buildCompositeStateNone(vfxBuilder)
                    var vfxSurroundType = callMcMember(
                        $RenderType, 'create', 'm_173215_',
                        'epiphy:fx3d_surround_vfx',
                        posColTexFmt,
                        $VertexFormatMode.QUADS,
                        2048,
                        false,
                        false,
                        vfxState
                    )

                    var cosmosOverlayModel = bakeQuadsToCCModel(buildCosmosOverlayQuads(), $CCModel, $Vertex5, $ColourAttribute)
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

                            // 一次性预烘焙 3D 星盘陀螺环
                            var bakedRings = []
                            var ringsSpec = Array.isArray(cfg.rings) ? cfg.rings : []
                            for (var ri = 0; ri < ringsSpec.length; ri++) {
                                var rCfg = ringsSpec[ri]
                                var rModel = bakeQuadsToCCModel(buildAstrolabeRingQuads(rCfg), $CCModel, $Vertex5, $ColourAttribute)
                                if (rModel != null) {
                                    totalSurroundVerts += rModel.verts.length
                                    var rU = (ringBaseU + Number(rCfg.uOffset || 0.0)) * PX_TO_UNIT
                                    bakedRings.push({
                                        model: rModel,
                                        cx:    guardMX + uxModel * rU,
                                        cy:    guardMY + uyModel * rU,
                                        tiltU: Number(rCfg.tiltU || 0.0),
                                        tiltV: Number(rCfg.tiltV || 0.0),
                                        spd:   Number(rCfg.spd != null ? rCfg.spd : 1.0)
                                    })
                                }
                            }

                            // 一次性预烘焙双螺旋缠刃光带（2 股）
                            var bakedHelices = []
                            var helixSpd = Number(cfg.helix && cfg.helix.speed != null ? cfg.helix.speed : 2.3)
                            if (cfg.helix && cfg.helix.enabled !== false) {
                                for (var hs = 0; hs < 2; hs++) {
                                    var hModel = bakeQuadsToCCModel(buildHelixRibbonQuads(cfg.helix, hs), $CCModel, $Vertex5, $ColourAttribute)
                                    if (hModel != null) {
                                        totalSurroundVerts += hModel.verts.length
                                        bakedHelices.push(hModel)
                                    }
                                }
                            }

                            // 一次性预烘焙 3D 游弋星屑与彗尾（2 个反向轨道簇）
                            var bakedMoteGroups = []
                            var moteSpds = [1.18, -0.86]
                            if (cfg.motes && cfg.motes.enabled !== false) {
                                for (var mg = 0; mg < 2; mg++) {
                                    var mModel = bakeQuadsToCCModel(buildStarMotesQuads(cfg.motes, mg, 2), $CCModel, $Vertex5, $ColourAttribute)
                                    if (mModel != null) {
                                        totalSurroundVerts += mModel.verts.length
                                        bakedMoteGroups.push({
                                            model: mModel,
                                            spd:   moteSpds[mg],
                                            phase: mg * 3.14159
                                        })
                                    }
                                }
                            }

                            // 热路径复用的 Matrix4 与方法句柄缓存（零 GC 分配、零每帧反射）
                            var baseMat = new $Matrix4()
                            var workMat = new $Matrix4()
                            var vecX    = $Vector3.X_POS
                            var vecY    = $Vector3.Y_POS
                            var vecZ    = $Vector3.Z_POS
                            var speedMul    = Number(cfg.speed != null ? cfg.speed : 1.2)
                            var slashExpand = Number(cfg.slashExpand != null ? cfg.slashExpand : 0.45)

                            var cachedMc          = null
                            var cachedItemRen     = null
                            var fnRenderLists     = null
                            var fnGetFrameTime    = null
                            var fnHasFoil         = null
                            var fnGetViewYRot     = null
                            var fnGetViewXRot     = null
                            var fnGetAttackAnim   = null
                            var playerMethodsInit = false

                            var getParticleIconFn = function () {
                                try { return callMcMember(originalModel, 'getParticleIcon', 'm_6160_') } catch (eIcon) { return null }
                            }

                            var renderer = new $IItemRenderer({
                                renderItem: function (stack, displayContext, mStack, getter, packedLight, packedOverlay) {
                                    if (cachedMc == null && fnGetMc != null) {
                                        cachedMc = fnGetMc.call($Minecraft)
                                        if (cachedMc != null) {
                                            cachedItemRen  = callMcMember(cachedMc, 'getItemRenderer', 'm_91291_')
                                            fnGetFrameTime = resolveMcMethod(cachedMc, 'getFrameTime', 'm_91296_')
                                            if (cachedItemRen != null) {
                                                fnRenderLists = resolveMcMethod(cachedItemRen, 'renderModelLists', 'm_115189_')
                                            }
                                        }
                                    }
                                    if (fnHasFoil == null && stack != null) {
                                        fnHasFoil = resolveMcMethod(stack, 'hasFoil', 'm_41790_')
                                    }

                                    var isGui = (displayContext === guiContextEnum)

                                    // 1. 绘制原版 64x64 立体挤出剑身模型（含附魔光效）
                                    //    仅在 3D 手持/世界视角下立即 flush 写入深度缓冲，GUI 槽位绝不打断原版物品栏合批！
                                    if (cachedItemRen != null && fnRenderLists != null && originalModel != null) {
                                        try {
                                            var origRt = fnGetItemRenderRt.call($ItemBlockRenderTypes, stack, true)
                                            var hasFoil = fnHasFoil != null ? Boolean(fnHasFoil.call(stack)) : false
                                            var vc = fnGetFoilBufDirect.call($ItemRenderer, getter, origRt, true, hasFoil)
                                            fnRenderLists.call(cachedItemRen, originalModel, stack, packedLight, packedOverlay, mStack, vc)
                                            if (!isGui) {
                                                flushRenderType(getter, origRt)
                                            }
                                        } catch (eOrig) {
                                            logErrorThrottled('renderOrig_' + itemId, eOrig)
                                        }
                                    }

                                    if (!CONFIG.enabled) return

                                    var t = nowSeconds() * speedMul
                                    var yawRad = 0.0
                                    var pitchRad = 0.0
                                    var slashScale = 1.0

                                    if (!isGui && cachedMc != null) {
                                        var player = cachedMc.f_91074_ !== undefined ? cachedMc.f_91074_ : cachedMc.player
                                        if (player != null) {
                                            if (!playerMethodsInit) {
                                                playerMethodsInit = true
                                                fnGetViewYRot   = resolveMcMethod(player, 'getViewYRot', 'm_5675_')
                                                fnGetViewXRot   = resolveMcMethod(player, 'getViewXRot', 'm_5686_')
                                                fnGetAttackAnim = resolveMcMethod(player, 'getAttackAnim', 'm_21324_')
                                            }
                                            var partial = fnGetFrameTime != null ? Number(fnGetFrameTime.call(cachedMc) || 0.0) : 0.0
                                            if (fnGetViewYRot != null) yawRad   = Number(fnGetViewYRot.call(player, partial) || 0.0) * DEG_TO_RAD
                                            if (fnGetViewXRot != null) pitchRad = Number(fnGetViewXRot.call(player, partial) || 0.0) * DEG_TO_RAD
                                            if (fnGetAttackAnim != null) {
                                                var swing = Number(fnGetAttackAnim.call(player, partial) || 0.0)
                                                if (swing > 0.001 && swing < 0.999) {
                                                    slashScale = 1.0 + Math.sin(swing * PI) * slashExpand
                                                }
                                            }
                                        }
                                    }

                                    var ccrs = $CCRenderState.instance()
                                    baseMat.set(mStack)

                                    // 2. GPU 核心着色器深空星空窗口（仅 2 个 quad，原生屏幕分辨率四芒星与 360° 相机视差）
                                    if (CONFIG.cosmosEnabled && cosmosType != null && cosmosOverlayModel != null && COSMOS_SHADER != null) {
                                        try {
                                            setUniform1f(SHADER_UNIFORMS.time, t)
                                            setUniform2f(SHADER_UNIFORMS.yawPitch, yawRad, pitchRad)
                                            setUniform1f(SHADER_UNIFORMS.guiMode, isGui ? 1.0 : 0.0)
                                            ccrs.reset()
                                            ccrs.computeLighting = false
                                            ccrs.baseColour = -1
                                            ccrs.bind(cosmosType, getter)
                                            cosmosOverlayModel.render(ccrs, baseMat)
                                            flushRenderType(getter, cosmosType)
                                        } catch (eCos) {
                                            logErrorThrottled('renderCosmos_' + itemId, eCos)
                                        }
                                    }

                                    // 3. 预烘焙 3D 环绕特效（星盘陀螺环 + 双螺旋光带 + 14 游弋星屑）
                                    //    手持/世界完整绘制（硬件深度前后遮挡）；GUI 16x16 槽位仅绘前 2 道主星环，极速零卡顿
                                    if (CONFIG.surroundEnabled) {
                                        try {
                                            var radScale = isGui ? CONFIG.guiSurroundScale : slashScale
                                            var ringLim  = isGui ? Math.min(bakedRings.length, CONFIG.guiRingLimit) : bakedRings.length
                                            ccrs.reset()
                                            ccrs.computeLighting = false
                                            ccrs.baseColour = -1
                                            ccrs.bind(vfxSurroundType, getter)

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
                                            }

                                            if ((!isGui || CONFIG.guiRenderHelix) && bakedHelices.length > 0) {
                                                workMat.set(baseMat)
                                                workMat.translate(guardMX, guardMY, 0.5)
                                                workMat.rotate(bladeAng, vecZ)
                                                if (radScale !== 1.0) workMat.scale(1.0, radScale, radScale)
                                                workMat.rotate(t * helixSpd, vecX)
                                                for (var hIdx = 0; hIdx < bakedHelices.length; hIdx++) {
                                                    bakedHelices[hIdx].render(ccrs, workMat)
                                                }
                                            }

                                            if ((!isGui || CONFIG.guiRenderMotes) && bakedMoteGroups.length > 0) {
                                                for (var mIdx = 0; mIdx < bakedMoteGroups.length; mIdx++) {
                                                    var bm = bakedMoteGroups[mIdx]
                                                    var bobU = Math.sin(t * 1.4 + bm.phase) * 1.2 * PX_TO_UNIT
                                                    workMat.set(baseMat)
                                                    workMat.translate(guardMX + uxModel * bobU, guardMY + uyModel * bobU, 0.5)
                                                    workMat.rotate(bladeAng, vecZ)
                                                    if (radScale !== 1.0) workMat.scale(1.0, radScale, radScale)
                                                    workMat.rotate(t * bm.spd, vecX)
                                                    bm.model.render(ccrs, workMat)
                                                }
                                            }

                                            flushRenderType(getter, vfxSurroundType)
                                        } catch (eVfx) {
                                            logErrorThrottled('renderSurround_' + itemId, eVfx)
                                        }
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
                                helices:      bakedHelices.length,
                                moteGroups:   bakedMoteGroups.length,
                                surroundVerts: totalSurroundVerts,
                                hasCosmos:    cosmosType != null,
                                maskTexture:  cfg.maskTexture
                            }
                            console.info('[Epiphy3DFXCore] 已预烘焙 ' + itemId +
                                ' (rings=' + bakedRings.length +
                                ', helices=' + bakedHelices.length +
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
            return {
                version:      VERSION,
                enabled:      CONFIG.enabled,
                envState:     ENV_STATE,
                clockSource:  MONO_CLOCK.getSource(),
                boundCount:   Object.keys(ITEM_BINDINGS).length,
                bakedCount:   BAKED_COUNT,
                bakedItems:   BAKED_ITEMS,
                shaderLoaded: SHADER_STATUS.loaded
            }
        },
        _pure: {
            packRgba:                packRgba,
            normalizeItemSpec:       normalizeItemSpec,
            pushCrossSegmentQuads:   pushCrossSegmentQuads,
            pushStarPrism3DQuads:    pushStarPrism3DQuads,
            buildCosmosOverlayQuads: buildCosmosOverlayQuads,
            buildAstrolabeRingQuads: buildAstrolabeRingQuads,
            buildHelixRibbonQuads:   buildHelixRibbonQuads,
            buildStarMotesQuads:     buildStarMotesQuads
        }
    }

    if (typeof global !== 'undefined') {
        global.Epiphy3DFXCore = API
    }
})()
