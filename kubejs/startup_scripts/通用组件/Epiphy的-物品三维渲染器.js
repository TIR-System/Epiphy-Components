// priority: 1050
// ============================================================================
//  Epiphy 的通用组件 —— 声明式物品三维渲染器 (EpiphyItem3DRenderer v1.1.0 · Startup/ModBus)
//  许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
//  放置位置：kubejs/startup_scripts/通用组件/Epiphy的-物品三维渲染器.js
//  第三方 Mod 可选特例（原则见 README-LLM.md §3.3）：
//    - CodeChickenLib（可选特例：`IItemRenderer` / `TransformUtils` / `CCShaderInstance` / `CCModel` / `CCRenderState` / `ColourAttribute` / `Matrix4` / `Vector3` / `Vertex5`）：
//      仅因 KubeJS 1.20.1 物品注册未暴露 `Item.initializeClient` 且 Rhino 纯解释器逐顶点写 `VertexConsumer` 耗时高（8~25ms）
//      而临时借作物品 3D 渲染入口胶水与纯 Java 侧预烘焙网格加速（实测 ~0.54ms，提速 15~46 倍）；
//      缺失时单次 console.warn 自动 Fail-Soft 退回原版静态物品模型，不影响世界 3D (`surface: 'world'`) 零 CCL 运行；
//      迁出为独立原生 Mod（Phase 4）时必须彻底移除全部 CCL 依赖，改用 Forge 原生 `IClientItemExtensions` + `BEWLR` / 自有 Mixin + 原版 `ShaderInstance` + 原生 Java 网格/VBO 自主实现。
//  架构定位（面向功能本身 · 与 PROTO v6 分层声明式设计同源）：
//    - 视觉表现层【子系统 B · 物品 3D 管线】，与【子系统 A】2D 平面渲染器彻底解耦，
//      亦与已迁入 Epiphy的-Spec与通用工具.js 的世界 3D 渲染相位桥接 (`RenderLevelStageEvent`) 物理隔离；
//    - 提供 4 项纯通用能力，绝不绑定任何特定物品或玩法案例：
//      1. 自定义核心着色器注册中心 (`registerShader`)：通过 `RegisterShadersEvent` + `CCShaderInstance.create`
//         批量注册任意 GLSL 核心着色器并缓存 uniform setter；
//      2. 分层声明式物品 3D 规范 (`proto: 6`，分组 `model` / `frame` / `motion` / `lod` / `layers`) 与
//         紧凑链式构造器 `fx()` (`id` 前置，对称于 `Epiphy2DSurface.ui()`)；
//      3. 4 类内置预烘焙几何图层原语（`surface_overlay` / `ribbon_ring` / `ribbon_helix` / `sprite_cluster`）
//         与可扩展注册机制（`registerLayerType` / `registerPart` / `registerPreset`）；
//      4. 材质签名级 `RenderType` 缓存池（支持无闪烁加法发光 `LIGHTNING_TRANSPARENCY` + 双线性滤波 + `sortOnUpload=false`）
//         与纯 Java `CCModel.render` 极速热路径（烘焙期有限值防火墙 + `computeNormals()`）。
//  语法规范：遵循 README-LLM.md §1 强制 Rhino ES5 语法基准（严禁读取 Math.PI 等 NativeMath 缺失常量）。
// ============================================================================

;(function () {
    var VERSION    = '1.1.0'
    var PROTO_VER  = 6
    var SPEC       = (typeof global !== 'undefined' && global != null && global.EpiphySpec != null) ? global.EpiphySpec : null
    var E_MATH     = (typeof global !== 'undefined' && global != null && global.EpiphyMath != null)
        ? global.EpiphyMath
        : (SPEC && SPEC.MATH ? SPEC.MATH : null)
    if (SPEC && typeof SPEC.ensureMathConstants === 'function') {
        SPEC.ensureMathConstants(typeof Math !== 'undefined' ? Math : null)
    }
    var PI         = (E_MATH && typeof E_MATH.PI === 'number') ? E_MATH.PI : 3.141592653589793
    var TWO_PI     = (E_MATH && typeof E_MATH.TWO_PI === 'number') ? E_MATH.TWO_PI : 6.283185307179586
    var DEG_TO_RAD = (E_MATH && typeof E_MATH.DEG_TO_RAD === 'number') ? E_MATH.DEG_TO_RAD : 0.017453292519943295

    var ENV_STATE  = 'unknown'
    var BACKEND_STATUS = {
        cclChecked:    false,
        cclAvailable:  false,
        mode:          'uninitialized',
        missingClass:  null,
        warnedMissing: false
    }

    // 单调时钟：优先复用 EpiphySpec.createMonotonicClock（Util.getNanos -> 单调钳制 Date.now），防 NTP 回拨/跳变
    var MONO_CLOCK = null
    if (SPEC && typeof SPEC.createMonotonicClock === 'function') {
        MONO_CLOCK = SPEC.createMonotonicClock({
            allowSystemProbe: false,
            onWarn: function (msg) {
                try { console.warn('[EpiphyItem3DRenderer] ' + msg) } catch (eW) { }
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

    // 全局运行开关（中性命名，不耦合具体视觉题材）
    var CONFIG = {
        enabled:         true,
        overlaysEnabled: true,
        geometryEnabled: true,
        guiGlobalScale:  1.0
    }

    var ITEM_BINDINGS     = {}
    var RESOLVED_CACHE    = {}
    var BAKED_ITEMS       = {}
    var BAKED_COUNT       = 0
    var SHADER_SPECS      = {}   // shaderId -> { id, vertexFormat, uniformNames }
    var SHADER_RUNTIME    = {}   // shaderId -> { registered, loaded, instance, uniforms, setters, lastError }
    var CUSTOM_LAYERS     = Object.create(null) // type -> builderFn(layerSpec, bakeCtx)
    var RUNTIME_STATS     = {
        renderCalls:     0,
        handCalls:       0,
        guiCalls:        0,
        origDraws:       0,
        overlayDraws:    0,
        geometryDraws:   0,
        lastRenderUs:    0,
        maxRenderUs:     0,
        totalRenderUs:   0,
        loggedFirstHand: false,
        loggedFirstGui:  false,
        lastError:       null
    }
    var ERR_THROTTLE_AT   = {}

    // 跨阶段预设与可复用复合部件注册表（接入 EpiphySpec 统一机制）
    var ITEM_PRESETS = (SPEC && typeof SPEC.createPresetRegistry === 'function')
        ? SPEC.createPresetRegistry('item3d')
        : createLocalRegistry()

    var PART_REGISTRY = (SPEC && typeof SPEC.createPresetRegistry === 'function')
        ? SPEC.createPresetRegistry('item3d_part')
        : createLocalRegistry()

    function createLocalRegistry() {
        var map = Object.create(null)
        return {
            register: function (name, val) {
                var k = String(name || '').trim()
                if (!k || val == null) return false
                map[k] = val
                return true
            },
            has: function (name) { return Object.prototype.hasOwnProperty.call(map, String(name || '').trim()) },
            get: function (name) { return map[String(name || '').trim()] || null },
            remove: function (name) {
                var k = String(name || '').trim()
                if (!Object.prototype.hasOwnProperty.call(map, k)) return false
                delete map[k]
                return true
            },
            list: function () { return Object.keys(map) },
            resolve: function (name, overrides) {
                var entry = map[String(name || '').trim()]
                if (entry == null) return null
                var base = (typeof entry === 'function') ? entry(overrides || {}) : entry
                if (!isPlainObjLike(base)) return null
                return mergeGroupedItemSpec(base, overrides || {})
            }
        }
    }

    function clampNum(v, lo, hi) {
        return v < lo ? lo : (v > hi ? hi : v)
    }

    function isPlainObjLike(v) {
        return v != null && typeof v === 'object' && !Array.isArray(v)
    }

    function shallowClone(obj) {
        if (!isPlainObjLike(obj)) return {}
        var out = {}
        for (var k in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k]
        }
        return out
    }

    function mergeGroupedItemSpec(base, over) {
        if (SPEC && typeof SPEC.mergeGroupedOptions === 'function') {
            return SPEC.mergeGroupedOptions(base, over, {
                groupKeys: ['model', 'frame', 'motion', 'lod']
            })
        }
        var out = shallowClone(base)
        if (!isPlainObjLike(over)) return out
        var groups = { model: true, frame: true, motion: true, lod: true }
        for (var k in over) {
            if (!Object.prototype.hasOwnProperty.call(over, k) || over[k] === undefined) continue
            if (groups[k] && isPlainObjLike(out[k]) && isPlainObjLike(over[k])) {
                var merged = shallowClone(out[k])
                for (var sk in over[k]) {
                    if (Object.prototype.hasOwnProperty.call(over[k], sk) && over[k][sk] !== undefined) {
                        merged[sk] = over[k][sk]
                    }
                }
                out[k] = merged
            } else {
                out[k] = over[k]
            }
        }
        return out
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
            console.error('[EpiphyItem3DRenderer] ' + tag + ': ' + err)
        } catch (eLog) { }
    }

    function nowSeconds() {
        return MONO_CLOCK.elapsedSec()
    }

    // ======================================================================== 1. Mojmap 优先 + SRG 回退互操作工具（仅冷路径使用）
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

    function resolveUniformSetter(u, arity) {
        if (u == null) return null
        if (arity === 2) {
            if (typeof u.glUniform2f === 'function') return u.glUniform2f
            if (typeof u.set === 'function') return u.set
            if (typeof u.m_7971_ === 'function') return u.m_7971_
            return null
        }
        if (arity === 3) {
            if (typeof u.glUniform3f === 'function') return u.glUniform3f
            if (typeof u.set === 'function') return u.set
            if (typeof u.m_5889_ === 'function') return u.m_5889_
            return null
        }
        if (arity === 4) {
            if (typeof u.glUniform4f === 'function') return u.glUniform4f
            if (typeof u.set === 'function') return u.set
            if (typeof u.m_5808_ === 'function') return u.m_5808_
            return null
        }
        if (typeof u.glUniform1f === 'function') return u.glUniform1f
        if (typeof u.set === 'function') return u.set
        if (typeof u.m_5985_ === 'function') return u.m_5985_
        return null
    }

    function splitResourceId(rawId) {
        var s = String(rawId || '').trim()
        var idx = s.indexOf(':')
        if (idx > 0) return [s.slice(0, idx), s.slice(idx + 1)]
        return ['epiphy', s]
    }

    // ======================================================================== 2. 中性默认配置 & v6 声明式规范归一化
    // 铁律：通用组件默认配置保持完全中性空白，绝不包含任何特定装备/玩法的坐标、配色或贴图。
    function getNeutralItemSpec() {
        return {
            proto: PROTO_VER,
            model: {
                state:            'item', // 'item' | 'tool' | 'block'
                isGui3d:          false,
                usesBlockLight:   false,
                ambientOcclusion: false,
                renderBase:       true,
                flushBase:        true
            },
            frame: {
                unitScale:    1.0 / 64.0,
                origin:       [0.5, 0.5, 0.5],
                axisDir:      [1.0, 0.0],
                axisAngleRad: 0.0
            },
            motion: {
                speed:        1.0,
                attackExpand: 0.0
            },
            lod: {
                guiScale: 0.86
            },
            layers: []
        }
    }

    function normalizeFrame(rawFrame) {
        var def = getNeutralItemSpec().frame
        var f = isPlainObjLike(rawFrame) ? rawFrame : {}
        var unitScale = (f.unitScale != null && isFinite(Number(f.unitScale)) && Number(f.unitScale) > 0)
            ? Number(f.unitScale)
            : ((f.pixelCanvas != null && Number(f.pixelCanvas) > 0) ? (1.0 / Number(f.pixelCanvas)) : def.unitScale)

        var ox = def.origin[0], oy = def.origin[1], oz = def.origin[2]
        if (Array.isArray(f.origin) && f.origin.length >= 2) {
            ox = Number(f.origin[0]); oy = Number(f.origin[1])
            oz = f.origin.length >= 3 ? Number(f.origin[2]) : 0.5
        } else if (Array.isArray(f.pixelOrigin) && f.pixelOrigin.length >= 2) {
            // 将左上角原点像素坐标 (pxX, pxY) 换算至模型空间 [0..1] (左下角原点，Y 向上)
            ox = Number(f.pixelOrigin[0]) * unitScale
            oy = 1.0 - Number(f.pixelOrigin[1]) * unitScale
            oz = f.pixelOrigin.length >= 3 ? Number(f.pixelOrigin[2]) : 0.5
        }
        if (!isFinite(ox)) ox = 0.5
        if (!isFinite(oy)) oy = 0.5
        if (!isFinite(oz)) oz = 0.5

        var ux = 1.0, uy = 0.0, ang = 0.0
        if (Array.isArray(f.axisDir) && f.axisDir.length >= 2) {
            var rx = Number(f.axisDir[0]), ry = Number(f.axisDir[1])
            var rLen = Math.sqrt(rx * rx + ry * ry)
            if (isFinite(rLen) && rLen > 1e-6) {
                ux = rx / rLen
                uy = ry / rLen
                ang = Math.atan2(uy, ux)
            }
        } else if (f.axisAngleRad != null && isFinite(Number(f.axisAngleRad))) {
            ang = Number(f.axisAngleRad)
            ux = Math.cos(ang)
            uy = Math.sin(ang)
        } else if (f.axisAngleDeg != null && isFinite(Number(f.axisAngleDeg))) {
            ang = Number(f.axisAngleDeg) * DEG_TO_RAD
            ux = Math.cos(ang)
            uy = Math.sin(ang)
        }

        return {
            unitScale:    unitScale,
            origin:       [ox, oy, oz],
            axisDir:      [ux, uy],
            axisAngleRad: ang
        }
    }

    function normalizeMaterial(rawMat, defaults) {
        var d = isPlainObjLike(defaults) ? defaults : {}
        var m = isPlainObjLike(rawMat) ? rawMat : {}
        var blend = String(m.blend != null ? m.blend : (d.blend != null ? d.blend : 'additive')).toLowerCase()
        if (blend !== 'translucent' && blend !== 'additive') blend = 'additive'
        return {
            shader:     m.shader != null ? String(m.shader) : (d.shader != null ? String(d.shader) : null),
            texture:    m.texture != null ? String(m.texture) : (d.texture != null ? String(d.texture) : 'epiphy:textures/effect/white_pixel.png'),
            blend:      blend,
            blur:       m.blur !== undefined ? Boolean(m.blur) : (d.blur !== undefined ? Boolean(d.blur) : true),
            cull:       m.cull !== undefined ? Boolean(m.cull) : (d.cull !== undefined ? Boolean(d.cull) : false),
            depthTest:  m.depthTest !== undefined ? Boolean(m.depthTest) : (d.depthTest !== undefined ? Boolean(d.depthTest) : true),
            depthWrite: m.depthWrite !== undefined ? Boolean(m.depthWrite) : (d.depthWrite !== undefined ? Boolean(d.depthWrite) : false),
            flushAfter: m.flushAfter !== undefined ? Boolean(m.flushAfter) : (d.flushAfter !== undefined ? Boolean(d.flushAfter) : false)
        }
    }

    function normalizeItemSpec(itemId, rawSpec) {
        var neutral = getNeutralItemSpec()
        var resolved = rawSpec
        if (isPlainObjLike(rawSpec) && typeof rawSpec.preset === 'string') {
            var over = {}
            for (var ok in rawSpec) {
                if (Object.prototype.hasOwnProperty.call(rawSpec, ok) && ok !== 'preset') over[ok] = rawSpec[ok]
            }
            var fromReg = ITEM_PRESETS.resolve(rawSpec.preset, over)
            if (fromReg == null && SPEC && typeof SPEC.resolvePreset === 'function') {
                fromReg = SPEC.resolvePreset('item3d', rawSpec.preset, over)
            }
            if (isPlainObjLike(fromReg)) resolved = fromReg
        }
        if (!isPlainObjLike(resolved)) resolved = {}
        var merged = mergeGroupedItemSpec(neutral, resolved)

        var mdl = isPlainObjLike(merged.model) ? merged.model : neutral.model
        var mot = isPlainObjLike(merged.motion) ? merged.motion : neutral.motion
        var lod = isPlainObjLike(merged.lod) ? merged.lod : neutral.lod
        var rawLayers = Array.isArray(merged.layers) ? merged.layers : []
        var cleanLayers = []
        for (var i = 0; i < rawLayers.length; i++) {
            var ly = rawLayers[i]
            if (!isPlainObjLike(ly) || ly.enabled === false) continue
            var lType = String(ly.type || ly.kind || '').trim().toLowerCase()
            if (!lType) continue
            var copy = shallowClone(ly)
            copy.id        = ly.id != null && String(ly.id) !== '' ? String(ly.id) : (lType + '_' + i)
            copy.type      = lType
            copy.visibleIn = String(ly.visibleIn || 'all').toLowerCase()
            cleanLayers.push(copy)
        }

        return {
            proto: PROTO_VER,
            itemId: typeof itemId === 'string' ? itemId : '',
            model: {
                state:            String(mdl.state || 'item').toLowerCase(),
                isGui3d:          Boolean(mdl.isGui3d),
                usesBlockLight:   Boolean(mdl.usesBlockLight),
                ambientOcclusion: Boolean(mdl.ambientOcclusion),
                renderBase:       mdl.renderBase !== false,
                flushBase:        mdl.flushBase !== false
            },
            frame: normalizeFrame(merged.frame),
            motion: {
                speed:        isFinite(Number(mot.speed)) ? Number(mot.speed) : 1.0,
                attackExpand: isFinite(Number(mot.attackExpand)) ? Number(mot.attackExpand) : 0.0
            },
            lod: {
                guiScale: (lod.guiScale != null && isFinite(Number(lod.guiScale))) ? Number(lod.guiScale) : 0.86
            },
            layers: cleanLayers
        }
    }

    // ======================================================================== 3. v6 风格链式构造器 fx()（id 前置、可组合部件）
    function createFxBuilder(scopeOpts) {
        var sc      = isPlainObjLike(scopeOpts) ? scopeOpts : {}
        var layers  = Array.isArray(sc.layers) ? sc.layers : []
        var autoSeq = 0

        function nextId(prefix) {
            autoSeq++
            return (prefix || 'l') + '_' + autoSeq
        }

        function appendAny(itemOrArr) {
            if (Array.isArray(itemOrArr)) {
                for (var i = 0; i < itemOrArr.length; i++) {
                    if (itemOrArr[i] != null) layers.push(itemOrArr[i])
                }
            } else if (itemOrArr != null) {
                layers.push(itemOrArr)
            }
            return builder
        }

        var builder = {
            layers: layers,
            push:   appendAny,
            surfaceOverlay: function (id, shaderId, texture, opts) {
                var o = isPlainObjLike(opts) ? shallowClone(opts) : {}
                o.id   = (id != null && String(id) !== '') ? String(id) : nextId('overlay')
                o.type = 'surface_overlay'
                var mat = isPlainObjLike(o.material) ? shallowClone(o.material) : {}
                if (shaderId != null) mat.shader = String(shaderId)
                if (texture != null)  mat.texture = String(texture)
                if (mat.blend === undefined) mat.blend = 'translucent'
                if (mat.blur === undefined) mat.blur = false
                if (mat.depthWrite === undefined) mat.depthWrite = true
                if (mat.flushAfter === undefined) mat.flushAfter = (mat.shader != null)
                o.material = mat
                layers.push(o)
                return builder
            },
            ribbonRing: function (id, opts) {
                var o = isPlainObjLike(opts) ? shallowClone(opts) : {}
                o.id   = (id != null && String(id) !== '') ? String(id) : nextId('ring')
                o.type = 'ribbon_ring'
                layers.push(o)
                return builder
            },
            ribbonHelix: function (id, opts) {
                var o = isPlainObjLike(opts) ? shallowClone(opts) : {}
                o.id   = (id != null && String(id) !== '') ? String(id) : nextId('helix')
                o.type = 'ribbon_helix'
                layers.push(o)
                return builder
            },
            spriteCluster: function (id, opts) {
                var o = isPlainObjLike(opts) ? shallowClone(opts) : {}
                o.id   = (id != null && String(id) !== '') ? String(id) : nextId('sprites')
                o.type = 'sprite_cluster'
                layers.push(o)
                return builder
            },
            layer: function (id, typeName, opts) {
                var o = isPlainObjLike(opts) ? shallowClone(opts) : {}
                o.id   = (id != null && String(id) !== '') ? String(id) : nextId(typeName || 'layer')
                o.type = String(typeName || '').trim().toLowerCase()
                layers.push(o)
                return builder
            },
            part: function (partName, overrides) {
                var fn = PART_REGISTRY.get(partName)
                if (typeof fn === 'function') {
                    var res = fn(overrides || {}, builder)
                    if (res != null && res !== builder) appendAny(res)
                } else if (fn != null) {
                    appendAny(fn)
                }
                return builder
            },
            build: function () {
                return layers.slice()
            }
        }
        return builder
    }

    // ======================================================================== 4. 通用纯几何预烘焙原语（仅烘焙期执行）
    function lerpRgb(cA, cB, t) {
        var f = clampNum(Number(t), 0.0, 1.0)
        var r0 = (cA >>> 16) & 0xFF, g0 = (cA >>> 8) & 0xFF, b0 = cA & 0xFF
        var r1 = (cB >>> 16) & 0xFF, g1 = (cB >>> 8) & 0xFF, b1 = cB & 0xFF
        var r = Math.round(r0 + (r1 - r0) * f) & 0xFF
        var g = Math.round(g0 + (g1 - g0) * f) & 0xFF
        var b = Math.round(b0 + (b1 - b0) * f) & 0xFF
        return (r << 16) | (g << 8) | b
    }

    function pushQuad(list, p0, p1, p2, p3, rgba, uvRect, rgbaEnd) {
        var cEnd = (rgbaEnd !== undefined && rgbaEnd !== null) ? rgbaEnd : rgba
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

    // 严格共享端点的连续柔光丝带段：v=0..1 跨越丝带宽度（适配中心亮芯柔光贴图），u=0..1 沿路径连续延伸
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

    function pushCrossSegmentQuads(list, a, b, n1, n2, halfW, rgba) {
        pushConnectedRibbonQuad(list, a, n1, halfW, b, n1, halfW, rgba, rgba)
        pushConnectedRibbonQuad(list, a, n2, halfW, b, n2, halfW, rgba, rgba)
    }

    // 3 片正交柔光精灵面片（任意 3D 视角均饱满，配合加法混合无共面闪烁）
    function pushOrthoSpriteQuads(list, cx, cy, cz, ax1, ax2, ax3, radius, rgba) {
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

    // 原语 1：通用双面/单面贴合表面覆层面片（默认紧贴 item/generated 前后面外侧，避免深度冲突与斜视悬浮缝）
    function buildSurfaceOverlayQuads(geo) {
        var g = isPlainObjLike(geo) ? geo : {}
        var quads = []
        var tint  = g.color != null ? Number(g.color) : 0xFFFFFF
        var alpha = g.alpha != null ? Number(g.alpha) : 255
        var rgba  = packRgba(tint, alpha)
        var zFront = g.zFront != null ? Number(g.zFront) : 0.5318
        var zBack  = g.zBack != null ? Number(g.zBack) : 0.4682
        var x0 = g.x0 != null ? Number(g.x0) : 0.0
        var y0 = g.y0 != null ? Number(g.y0) : 0.0
        var x1 = g.x1 != null ? Number(g.x1) : 1.0
        var y1 = g.y1 != null ? Number(g.y1) : 1.0
        if (g.front !== false) {
            pushQuad(
                quads,
                [x0, y0, zFront], [x1, y0, zFront], [x1, y1, zFront], [x0, y1, zFront],
                rgba,
                [0.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0]
            )
        }
        if (g.back !== false) {
            pushQuad(
                quads,
                [x0, y1, zBack], [x1, y1, zBack], [x1, y0, zBack], [x0, y0, zBack],
                rgba,
                [0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0]
            )
        }
        return quads
    }

    // 原语 2：通用连续光带环/悬浮弧段（严格共享端点，支持非闭合弧段渐隐、双色渐变、椭圆包络、轴向波浪与径向短刻度）
    function buildRibbonRingQuads(geo, unitScale) {
        var g        = isPlainObjLike(geo) ? geo : {}
        var uS       = (unitScale != null && unitScale > 0) ? unitScale : (1.0 / 64.0)
        var quads    = []
        var R        = Number(g.radius != null ? g.radius : 8.0) * uS
        var ellZ     = Number(g.ellipticZ != null ? g.ellipticZ : 1.0)
        var segs     = clampNum(Math.round(Number(g.segments != null ? g.segments : 36)), 10, 64)
        var halfW    = Number(g.width != null ? g.width : 0.60) * uS
        var arcStart = Number(g.arcStart != null ? g.arcStart : 0.0)
        var arcSpan  = Number(g.arcSpan != null ? g.arcSpan : TWO_PI)
        var isFull   = Math.abs(arcSpan) >= (TWO_PI - 1e-4)
        var waveAmp  = Number(g.waveAmp || 0.0) * uS
        var waveFreq = Number(g.waveFreq != null ? g.waveFreq : 3.0)
        var pulseAmp = clampNum(Number(g.pulseAmp || 0.0), 0.0, 0.65)
        var pulseFrq = Number(g.pulseFreq != null ? g.pulseFreq : 2.0)
        var gradCyc  = Number(g.gradientCycles != null ? g.gradientCycles : (isFull ? 2.0 : 1.0))

        var cMain    = g.color != null ? Number(g.color) : 0xFFFFFF
        var cEnd     = g.colorEnd != null ? Number(g.colorEnd) : cMain
        var cCore    = g.coreColor != null ? Number(g.coreColor) : cMain
        var cCoreEnd = g.coreColorEnd != null ? Number(g.coreColorEnd) : (g.colorEnd != null ? cEnd : cCore)
        var aMain    = g.alpha != null ? Number(g.alpha) : 168
        var aAxis    = g.crossAlpha != null ? Number(g.crossAlpha) : 108

        var xAxis = [1.0, 0.0, 0.0]
        var pts   = new Array(segs + 1)
        var rads  = new Array(segs + 1)
        var hws   = new Array(segs + 1)
        var c1Arr = new Array(segs + 1)
        var c2Arr = new Array(segs + 1)

        var i
        for (i = 0; i <= segs; i++) {
            var frac = i / segs
            var ang  = arcStart + frac * arcSpan
            var ca   = Math.cos(ang), sa = Math.sin(ang)
            var wx   = waveAmp !== 0.0 ? (Math.sin(ang * waveFreq) * waveAmp) : 0.0
            pts[i]   = [wx, R * ca, R * ellZ * sa]
            var rx = 0.0, ry = ca, rz = sa * ellZ
            var rLen = Math.sqrt(ry * ry + rz * rz)
            if (rLen > 1e-6) { ry /= rLen; rz /= rLen }
            rads[i] = [rx, ry, rz]

            // 非闭合弧段自动施加首尾收尖与透明渐隐，闭合环保持平滑连通
            var env = isFull ? 1.0 : Math.pow(Math.max(0.0, Math.sin(frac * PI)), 0.72)
            var pulse = pulseAmp > 0.0 ? (1.0 - pulseAmp + pulseAmp * (0.5 + 0.5 * Math.cos(frac * TWO_PI * pulseFrq))) : 1.0
            var gradT = isFull
                ? (0.5 - 0.5 * Math.cos(frac * TWO_PI * gradCyc))
                : frac
            var col1 = (cMain !== cEnd) ? lerpRgb(cMain, cEnd, gradT) : cMain
            var col2 = (cCore !== cCoreEnd) ? lerpRgb(cCore, cCoreEnd, gradT) : cCore
            hws[i]   = halfW * (isFull ? 1.0 : (0.36 + 0.64 * env))
            c1Arr[i] = packRgba(col1, Math.round(aMain * env * pulse))
            c2Arr[i] = packRgba(col2, Math.round(aAxis * env * pulse))
        }

        for (i = 0; i < segs; i++) {
            pushConnectedRibbonQuad(quads, pts[i], rads[i], hws[i], pts[i + 1], rads[i + 1], hws[i + 1], c1Arr[i], c1Arr[i + 1])
            if (g.crossPlane !== false) {
                pushConnectedRibbonQuad(quads, pts[i], xAxis, hws[i] * 0.82, pts[i + 1], xAxis, hws[i + 1] * 0.82, c2Arr[i], c2Arr[i + 1])
            }
        }

        var ticks = clampNum(Math.round(Number(g.ticks || 0)), 0, 32)
        if (ticks > 0) {
            var tickW    = halfW * (g.tickWidthRatio != null ? Number(g.tickWidthRatio) : 0.44)
            var majOut   = Number(g.tickMajorOut != null ? g.tickMajorOut : 1.15) * uS
            var minOut   = Number(g.tickMinorOut != null ? g.tickMinorOut : 0.68) * uS
            var majIn    = Number(g.tickMajorIn != null ? g.tickMajorIn : 0.52) * uS
            var minIn    = Number(g.tickMinorIn != null ? g.tickMinorIn : 0.25) * uS
            var rgbaTk   = packRgba(cCore, 152)
            var rgbaTip  = packRgba(cMain, 24)
            for (var tk = 0; tk < ticks; tk++) {
                var tFrac = isFull ? (tk / ticks) : ((tk + 0.5) / ticks)
                var ta    = arcStart + tFrac * arcSpan
                var tc = Math.cos(ta), ts = Math.sin(ta)
                var twx = waveAmp !== 0.0 ? (Math.sin(ta * waveFreq) * waveAmp) : 0.0
                var isMajor = (tk % 4 === 0)
                var extOut  = isMajor ? majOut : minOut
                var extIn   = isMajor ? majIn : minIn
                var tanV    = [0.0, -ts, tc]
                var midPt   = [twx, R * tc, R * ellZ * ts]
                pushConnectedRibbonQuad(quads, midPt, tanV, tickW, [twx, (R + extOut) * tc, (R + extOut) * ellZ * ts], tanV, tickW * 0.55, rgbaTk, rgbaTip)
                pushConnectedRibbonQuad(quads, midPt, tanV, tickW, [twx, (R - extIn) * tc, (R - extIn) * ellZ * ts], tanV, tickW * 0.55, rgbaTk, rgbaTip)
            }
        }
        return quads
    }

    function buildRibbonRingMarkerQuads(geo, unitScale) {
        var g = isPlainObjLike(geo) ? geo : {}
        var markers = clampNum(Math.round(Number(g.markers || 0)), 0, 8)
        if (markers <= 0) return []
        var uS       = (unitScale != null && unitScale > 0) ? unitScale : (1.0 / 64.0)
        var R        = Number(g.radius != null ? g.radius : 8.0) * uS
        var ellZ     = Number(g.ellipticZ != null ? g.ellipticZ : 1.0)
        var mR       = Number(g.markerRadius != null ? g.markerRadius : 2.20) * uS
        var arcStart = Number(g.arcStart != null ? g.arcStart : 0.0)
        var arcSpan  = Number(g.arcSpan != null ? g.arcSpan : TWO_PI)
        var isFull   = Math.abs(arcSpan) >= (TWO_PI - 1e-4)
        var mPhase   = Number(g.markerPhase != null ? g.markerPhase : 0.35)
        var waveAmp  = Number(g.waveAmp || 0.0) * uS
        var waveFreq = Number(g.waveFreq != null ? g.waveFreq : 3.0)
        var cMark    = g.markerColor != null ? Number(g.markerColor) : (g.coreColor != null ? Number(g.coreColor) : 0xFFFFFF)
        var aMark    = g.markerAlpha != null ? Number(g.markerAlpha) : 162
        var rgba     = packRgba(cMark, aMark)
        var xAxis    = [1.0, 0.0, 0.0]
        var quads    = []
        for (var pk = 0; pk < markers; pk++) {
            var pa = isFull
                ? (arcStart + (pk / markers) * TWO_PI + mPhase)
                : (arcStart + ((pk + 0.5) / markers) * arcSpan)
            var pc = Math.cos(pa), ps = Math.sin(pa)
            var wx = waveAmp !== 0.0 ? (Math.sin(pa * waveFreq) * waveAmp) : 0.0
            pushOrthoSpriteQuads(quads, wx, R * pc, R * ellZ * ps, [0.0, pc, ps], [0.0, -ps, pc], xAxis, mR, rgba)
        }
        return quads
    }

    // 原语 3：通用 Frenet 连续螺旋流光带（支持安全最小半径 minRadius 防穿模、椭圆截面 ellipticZ、轴向双色渐变与共轨星珠节点）
    function evalHelixSample(g, st, frac, uS) {
        var startU  = Number(g.start != null ? g.start : 0.0)
        var spanU   = Number(g.span != null ? g.span : 40.0)
        var radMax  = Number(g.radius != null ? g.radius : 4.5) * uS
        var minRad  = g.minRadius != null ? (Number(g.minRadius) * uS) : (radMax * 0.28)
        var ellZ    = Number(g.ellipticZ != null ? g.ellipticZ : 1.0)
        var freq    = Number(g.freq != null ? g.freq : 0.17)
        var taper   = Number(g.taperPower != null ? g.taperPower : 0.78)
        var phase   = Number(st.phase != null ? st.phase : 0.0)

        var uRaw = startU + frac * spanU
        var env  = Math.pow(Math.max(0.0, Math.sin(frac * PI)), taper)
        var r    = minRad + (radMax - minRad) * env
        var ang  = uRaw * freq + phase
        var ca   = Math.cos(ang), sa = Math.sin(ang)
        return {
            pt:   [uRaw * uS, r * ca, r * ellZ * sa],
            rad:  [0.0, ca, sa * ellZ],
            env:  env,
            ca:   ca,
            sa:   sa
        }
    }

    function buildRibbonHelixStrandQuads(geo, strandCfg, unitScale) {
        var g     = isPlainObjLike(geo) ? geo : {}
        var st    = isPlainObjLike(strandCfg) ? strandCfg : {}
        var uS    = (unitScale != null && unitScale > 0) ? unitScale : (1.0 / 64.0)
        var quads = []
        var steps   = clampNum(Math.round(Number(g.steps != null ? g.steps : 36)), 12, 64)
        var halfWPx = Number(g.width != null ? g.width : 0.50)
        var pulseAmp = clampNum(Number(g.pulseAmp || 0.0), 0.0, 0.60)
        var pulseFrq = Number(g.pulseFreq != null ? g.pulseFreq : 2.0)

        var cMain    = st.color != null ? Number(st.color) : (g.color != null ? Number(g.color) : 0xFFFFFF)
        var cEnd     = st.colorEnd != null ? Number(st.colorEnd) : (g.colorEnd != null ? Number(g.colorEnd) : cMain)
        var cCore    = st.coreColor != null ? Number(st.coreColor) : cMain
        var cCoreEnd = st.coreColorEnd != null ? Number(st.coreColorEnd) : (cEnd !== cMain ? cEnd : cCore)
        var aMain    = st.alpha != null ? Number(st.alpha) : 162
        var aCore    = st.crossAlpha != null ? Number(st.crossAlpha) : 102

        var pts  = new Array(steps + 1)
        var rads = new Array(steps + 1)
        var envs = new Array(steps + 1)
        var i
        for (i = 0; i <= steps; i++) {
            var smp = evalHelixSample(g, st, i / steps, uS)
            pts[i]  = smp.pt
            rads[i] = smp.rad
            envs[i] = smp.env
        }

        var n1Arr = new Array(steps + 1)
        var n2Arr = new Array(steps + 1)
        var hwArr = new Array(steps + 1)
        var c1Arr = new Array(steps + 1)
        var c2Arr = new Array(steps + 1)
        for (i = 0; i <= steps; i++) {
            var frac  = i / steps
            var pPrev = pts[i > 0 ? (i - 1) : 0]
            var pNext = pts[i < steps ? (i + 1) : steps]
            var tx = pNext[0] - pPrev[0], ty = pNext[1] - pPrev[1], tz = pNext[2] - pPrev[2]
            var tLen = Math.sqrt(tx * tx + ty * ty + tz * tz)
            if (tLen < 1e-6) { tx = 1.0; ty = 0.0; tz = 0.0 }
            else { tx /= tLen; ty /= tLen; tz /= tLen }

            var rx = rads[i][0], ry = rads[i][1], rz = rads[i][2]
            var dot = rx * tx + ry * ty + rz * tz
            var n1x = rx - dot * tx, n1y = ry - dot * ty, n1z = rz - dot * tz
            var n1Len = Math.sqrt(n1x * n1x + n1y * n1y + n1z * n1z)
            if (n1Len < 1e-5) { n1x = 0.0; n1y = 1.0; n1z = 0.0 }
            else { n1x /= n1Len; n1y /= n1Len; n1z /= n1Len }

            var n2x = ty * n1z - tz * n1y
            var n2y = tz * n1x - tx * n1z
            var n2z = tx * n1y - ty * n1x
            var n2Len = Math.sqrt(n2x * n2x + n2y * n2y + n2z * n2z)
            if (n2Len > 1e-5) { n2x /= n2Len; n2y /= n2Len; n2z /= n2Len }

            var pulse = pulseAmp > 0.0 ? (1.0 - pulseAmp + pulseAmp * (0.5 + 0.5 * Math.sin(frac * TWO_PI * pulseFrq))) : 1.0
            var col1 = (cMain !== cEnd) ? lerpRgb(cMain, cEnd, frac) : cMain
            var col2 = (cCore !== cCoreEnd) ? lerpRgb(cCore, cCoreEnd, frac) : cCore

            n1Arr[i] = [n1x, n1y, n1z]
            n2Arr[i] = [n2x, n2y, n2z]
            hwArr[i] = (halfWPx * (0.42 + 0.58 * envs[i])) * uS
            c1Arr[i] = packRgba(col1, Math.round(aMain * envs[i] * pulse))
            c2Arr[i] = packRgba(col2, Math.round(aCore * envs[i] * pulse))
        }

        for (i = 0; i < steps; i++) {
            pushConnectedRibbonQuad(quads, pts[i], n1Arr[i], hwArr[i], pts[i + 1], n1Arr[i + 1], hwArr[i + 1], c1Arr[i], c1Arr[i + 1])
            if (g.crossPlane !== false) {
                pushConnectedRibbonQuad(quads, pts[i], n2Arr[i], hwArr[i] * 0.82, pts[i + 1], n2Arr[i + 1], hwArr[i + 1] * 0.82, c2Arr[i], c2Arr[i + 1])
            }
        }
        return quads
    }

    // 原语 3 辅件：沿螺旋流光带共轨镶嵌柔光精灵节点（随螺旋同步盘旋）
    function buildRibbonHelixNodeQuads(geo, strandCfg, unitScale) {
        var g = isPlainObjLike(geo) ? geo : {}
        var st = isPlainObjLike(strandCfg) ? strandCfg : {}
        var nCount = clampNum(Math.round(Number(st.nodes != null ? st.nodes : (g.nodes || 0))), 0, 8)
        if (nCount <= 0) return []
        var uS    = (unitScale != null && unitScale > 0) ? unitScale : (1.0 / 64.0)
        var nRad  = Number(st.nodeRadius != null ? st.nodeRadius : (g.nodeRadius != null ? g.nodeRadius : 1.65)) * uS
        var cMain = st.color != null ? Number(st.color) : (g.color != null ? Number(g.color) : 0xFFFFFF)
        var cEnd  = st.colorEnd != null ? Number(st.colorEnd) : (g.colorEnd != null ? Number(g.colorEnd) : cMain)
        var aNode = st.nodeAlpha != null ? Number(st.nodeAlpha) : (g.nodeAlpha != null ? Number(g.nodeAlpha) : 168)
        var xAxis = [1.0, 0.0, 0.0]
        var quads = []
        for (var ni = 0; ni < nCount; ni++) {
            var frac = (ni + 1) / (nCount + 1)
            var smp  = evalHelixSample(g, st, frac, uS)
            var col  = (cMain !== cEnd) ? lerpRgb(cMain, cEnd, frac) : cMain
            var rgba = packRgba(col, Math.round(aNode * (0.65 + 0.35 * smp.env)))
            pushOrthoSpriteQuads(quads, smp.pt[0], smp.pt[1], smp.pt[2], [0.0, smp.ca, smp.sa], [0.0, -smp.sa, smp.ca], xAxis, nRad, rgba)
        }
        return quads
    }

    // 原语 4：通用 3D 正交柔光精灵轨道簇（按确定性分布分组，支持椭圆轨道包络、区间与调色板）
    function buildSpriteClusterGroupQuads(geo, groupIndex, groupCount, unitScale) {
        var g = isPlainObjLike(geo) ? geo : {}
        var uS = (unitScale != null && unitScale > 0) ? unitScale : (1.0 / 64.0)
        var count   = clampNum(Math.round(Number(g.count != null ? g.count : 6)), 1, 24)
        var gCount  = Math.max(1, groupCount || 1)
        var spanSt  = Number(g.spanStart != null ? g.spanStart : 0.0)
        var spanLen = Number(g.spanLength != null ? g.spanLength : 32.0)
        var orbMin  = Number(g.orbitMin != null ? g.orbitMin : 4.0)
        var orbMax  = Number(g.orbitMax != null ? g.orbitMax : 9.0)
        var ellZ    = Number(g.ellipticZ != null ? g.ellipticZ : 1.0)
        var spMin   = Number(g.spriteMin != null ? g.spriteMin : 1.6)
        var spMax   = Number(g.spriteMax != null ? g.spriteMax : 2.5)
        var alpha   = g.alpha != null ? Number(g.alpha) : 155
        var palette = Array.isArray(g.palette) && g.palette.length > 0 ? g.palette : [0xFFFFFF]
        var xAxis   = [1.0, 0.0, 0.0]
        var quads   = []

        for (var i = 0; i < count; i++) {
            if ((i % gCount) !== groupIndex) continue
            var h1 = Math.sin(i * 17.31 + 2.13) * 43758.5453; h1 = h1 - Math.floor(h1)
            var h2 = Math.sin(i * 71.19 + 5.47) * 19283.1234; h2 = h2 - Math.floor(h2)
            var h3 = Math.sin(i * 43.87 + 1.91) * 28411.9812; h3 = h3 - Math.floor(h3)

            var uBase = (spanSt + h1 * spanLen) * uS
            var orbR  = (orbMin + h2 * (orbMax - orbMin)) * uS
            var ang0  = h3 * TWO_PI
            var tint  = Number(palette[i % palette.length])
            var c0    = Math.cos(ang0), s0 = Math.sin(ang0)
            var rSpr  = (spMin + h2 * (spMax - spMin)) * uS
            pushOrthoSpriteQuads(quads, uBase, orbR * c0, orbR * ellZ * s0, [0.0, c0, s0], [0.0, -s0, c0], xAxis, rSpr, packRgba(tint, alpha))
        }
        return quads
    }

    // 烘焙期 NaN/Infinity 防火墙：拦截任何非有限顶点静默流入 GPU
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

    function bakeQuadsToCCModel(quads, $CCModel, $Vertex5, $ColourAttribute, tag) {
        if (!Array.isArray(quads) || quads.length === 0) return null
        var check = validateQuadsFinite(quads)
        if (check.invalidCount > 0) {
            try {
                console.error('[EpiphyItem3DRenderer] 烘焙期检测到 ' + check.invalidCount + ' 个含非有限数 (NaN/Infinity) 的非法面片已丢弃' + (tag ? (' [' + tag + ']') : ''))
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
        model.computeNormals()
        return model
    }

    // ======================================================================== 5. 内置图层编译器与自定义图层扩展点
    // 每个编译产出项结构：
    //   { id, category ('overlay'|'geometry'), visibleIn, material, uniforms, quads, transform }
    function compileLayerToDescriptors(layerSpec, itemCfg) {
        var lType = layerSpec.type
        var frame = itemCfg.frame
        var uS    = frame.unitScale

        // 优先查询外部注册的自定义图层类型（支持扩展新图元或覆写内置图元）
        if (typeof CUSTOM_LAYERS[lType] === 'function') {
            var res = CUSTOM_LAYERS[lType](layerSpec, {
                itemCfg:  itemCfg,
                frame:    frame,
                packRgba: packRgba,
                pushQuad: pushQuad,
                pushConnectedRibbonQuad: pushConnectedRibbonQuad,
                pushOrthoSpriteQuads:    pushOrthoSpriteQuads
            })
            if (Array.isArray(res)) return res
            return res != null ? [res] : []
        }

        if (lType === 'surface_overlay') {
            var ovMat = normalizeMaterial(layerSpec.material, {
                blend:      'translucent',
                blur:       false,
                depthWrite: true,
                flushAfter: (layerSpec.material && layerSpec.material.shader != null)
            })
            var ovGeo = isPlainObjLike(layerSpec.geometry) ? layerSpec.geometry : layerSpec
            return [{
                id:        layerSpec.id,
                category:  'overlay',
                visibleIn: layerSpec.visibleIn,
                material:  ovMat,
                uniforms:  isPlainObjLike(layerSpec.uniforms) ? layerSpec.uniforms : null,
                quads:     buildSurfaceOverlayQuads(ovGeo),
                transform: { mode: 'identity' }
            }]
        }

        if (lType === 'ribbon_ring') {
            var rGeo = isPlainObjLike(layerSpec.geometry) ? layerSpec.geometry : {}
            var rTr  = isPlainObjLike(layerSpec.transform) ? layerSpec.transform : {}
            var rMat = normalizeMaterial(layerSpec.material, {
                texture:    'epiphy:textures/effect/glow_ribbon.png',
                blend:      'additive',
                blur:       true,
                depthWrite: false
            })
            var axisOff = Number(rTr.axisOffset != null ? rTr.axisOffset : 0.0) * uS
            var trSpec = {
                mode:            'local_axis',
                cx:              frame.origin[0] + frame.axisDir[0] * axisOff,
                cy:              frame.origin[1] + frame.axisDir[1] * axisOff,
                cz:              frame.origin[2] + Number(rTr.zOffset || 0.0) * uS,
                axisAngleRad:    frame.axisAngleRad,
                tiltU:           Number(rTr.tiltU || 0.0),
                tiltV:           Number(rTr.tiltV || 0.0),
                spinSpeed:       Number(rTr.spinSpeed != null ? rTr.spinSpeed : 0.65),
                scaleWithAttack: String(rTr.scaleWithAttack || 'uniform')
            }
            var out = [{
                id:        layerSpec.id,
                category:  'geometry',
                visibleIn: layerSpec.visibleIn,
                material:  rMat,
                uniforms:  null,
                quads:     buildRibbonRingQuads(rGeo, uS),
                transform: trSpec
            }]
            var markerQuads = buildRibbonRingMarkerQuads(rGeo, uS)
            if (markerQuads.length > 0) {
                var mMat = normalizeMaterial(layerSpec.markerMaterial, {
                    texture:    'epiphy:textures/effect/star_flare.png',
                    blend:      'additive',
                    blur:       true,
                    depthWrite: false
                })
                out.push({
                    id:        layerSpec.id + ':markers',
                    category:  'geometry',
                    visibleIn: layerSpec.visibleIn,
                    material:  mMat,
                    uniforms:  null,
                    quads:     markerQuads,
                    transform: trSpec
                })
            }
            return out
        }

        if (lType === 'ribbon_helix') {
            var hGeo = isPlainObjLike(layerSpec.geometry) ? layerSpec.geometry : {}
            var hTr  = isPlainObjLike(layerSpec.transform) ? layerSpec.transform : {}
            var hMat = normalizeMaterial(layerSpec.material, {
                texture:    'epiphy:textures/effect/glow_ribbon.png',
                blend:      'additive',
                blur:       true,
                depthWrite: false
            })
            var strands = Array.isArray(hGeo.strands) && hGeo.strands.length > 0
                ? hGeo.strands
                : [{ phase: 0.0 }, { phase: PI }]
            var combined = []
            var nodeQuads = []
            for (var si = 0; si < strands.length; si++) {
                var sq = buildRibbonHelixStrandQuads(hGeo, strands[si], uS)
                for (var sqi = 0; sqi < sq.length; sqi++) combined.push(sq[sqi])
                var nq = buildRibbonHelixNodeQuads(hGeo, strands[si], uS)
                for (var nqi = 0; nqi < nq.length; nqi++) nodeQuads.push(nq[nqi])
            }
            var hOff = Number(hTr.axisOffset != null ? hTr.axisOffset : 0.0) * uS
            var hTrSpec = {
                mode:            'local_axis',
                cx:              frame.origin[0] + frame.axisDir[0] * hOff,
                cy:              frame.origin[1] + frame.axisDir[1] * hOff,
                cz:              frame.origin[2] + Number(hTr.zOffset || 0.0) * uS,
                axisAngleRad:    frame.axisAngleRad,
                tiltU:           Number(hTr.tiltU || 0.0),
                tiltV:           Number(hTr.tiltV || 0.0),
                spinSpeed:       Number(hTr.spinSpeed != null ? hTr.spinSpeed : 1.15),
                scaleWithAttack: String(hTr.scaleWithAttack || 'radial')
            }
            var hOut = [{
                id:        layerSpec.id,
                category:  'geometry',
                visibleIn: layerSpec.visibleIn,
                material:  hMat,
                uniforms:  null,
                quads:     combined,
                transform: hTrSpec
            }]
            if (nodeQuads.length > 0) {
                var hnMat = normalizeMaterial(layerSpec.nodeMaterial || layerSpec.markerMaterial, {
                    texture:    'epiphy:textures/effect/star_flare.png',
                    blend:      'additive',
                    blur:       true,
                    depthWrite: false
                })
                hOut.push({
                    id:        layerSpec.id + ':nodes',
                    category:  'geometry',
                    visibleIn: layerSpec.visibleIn,
                    material:  hnMat,
                    uniforms:  null,
                    quads:     nodeQuads,
                    transform: hTrSpec
                })
            }
            return hOut
        }

        if (lType === 'sprite_cluster') {
            var sGeo = isPlainObjLike(layerSpec.geometry) ? layerSpec.geometry : {}
            var sTr  = isPlainObjLike(layerSpec.transform) ? layerSpec.transform : {}
            var sMat = normalizeMaterial(layerSpec.material, {
                texture:    'epiphy:textures/effect/star_flare.png',
                blend:      'additive',
                blur:       true,
                depthWrite: false
            })
            var groups  = clampNum(Math.round(Number(sGeo.groups != null ? sGeo.groups : 2)), 1, 4)
            var spds    = Array.isArray(sTr.orbitSpeeds) && sTr.orbitSpeeds.length > 0 ? sTr.orbitSpeeds : [0.42, -0.34]
            var bobAmp  = Number(sTr.bobAmp != null ? sTr.bobAmp : 0.9) * uS
            var bobFreq = Number(sTr.bobFreq != null ? sTr.bobFreq : 1.1)
            var sOut    = []
            for (var gi = 0; gi < groups; gi++) {
                var gq = buildSpriteClusterGroupQuads(sGeo, gi, groups, uS)
                if (gq.length === 0) continue
                sOut.push({
                    id:        layerSpec.id + ':g' + gi,
                    category:  'geometry',
                    visibleIn: layerSpec.visibleIn,
                    material:  sMat,
                    uniforms:  null,
                    quads:     gq,
                    transform: {
                        mode:            'local_axis_bob',
                        cx:              frame.origin[0],
                        cy:              frame.origin[1],
                        cz:              frame.origin[2],
                        axisDirX:        frame.axisDir[0],
                        axisDirY:        frame.axisDir[1],
                        axisAngleRad:    frame.axisAngleRad,
                        spinSpeed:       Number(spds[gi % spds.length] != null ? spds[gi % spds.length] : 0.4),
                        bobAmp:          bobAmp,
                        bobFreq:         bobFreq,
                        bobPhase:        gi * PI,
                        scaleWithAttack: String(sTr.scaleWithAttack || 'radial')
                    }
                })
            }
            return sOut
        }

        return []
    }

    // ======================================================================== 6. 公开注册与绑定 API
    function resolveNativeItem3D() {
        var nat = (typeof EpiphyNative !== 'undefined' && EpiphyNative != null)
            ? EpiphyNative
            : ((typeof global !== 'undefined' && global != null) ? global.EpiphyNative : null)
        if (nat != null && typeof nat.getItem3D === 'function') {
            try { return nat.getItem3D() } catch (eNi3d) { }
        }
        return null
    }

    function pushItemToNativeMod(itemId) {
        var nat3d = resolveNativeItem3D()
        if (nat3d == null) return false
        var cfg = getBoundItemConfig(itemId)
        if (cfg == null) return false

        nat3d.setConfig(Boolean(CONFIG.enabled), Boolean(CONFIG.overlaysEnabled), Boolean(CONFIG.geometryEnabled), Number(CONFIG.guiGlobalScale || 1.0))
        var rawPasses = []
        var totalVerts = 0
        var ovCnt = 0
        var geoCnt = 0
        for (var li = 0; li < cfg.layers.length; li++) {
            var descs = compileLayerToDescriptors(cfg.layers[li], cfg)
            for (var di = 0; di < descs.length; di++) {
                var desc = descs[di]
                if (!desc || !Array.isArray(desc.quads) || desc.quads.length === 0) continue
                var chk = validateQuadsFinite(desc.quads)
                var vq = chk.valid
                if (vq.length === 0) continue
                var xyzUv = []
                var rgba  = []
                for (var qi = 0; qi < vq.length; qi++) {
                    var q = vq[qi]
                    xyzUv.push(q.p0[0], q.p0[1], q.p0[2], q.u0, q.v0)
                    rgba.push(q.rgba0 !== undefined ? q.rgba0 : q.rgba)
                    xyzUv.push(q.p1[0], q.p1[1], q.p1[2], q.u1, q.v1)
                    rgba.push(q.rgba1 !== undefined ? q.rgba1 : q.rgba)
                    xyzUv.push(q.p2[0], q.p2[1], q.p2[2], q.u2, q.v2)
                    rgba.push(q.rgba2 !== undefined ? q.rgba2 : q.rgba)
                    xyzUv.push(q.p3[0], q.p3[1], q.p3[2], q.u3, q.v3)
                    rgba.push(q.rgba3 !== undefined ? q.rgba3 : q.rgba)
                }
                totalVerts += rgba.length
                if (desc.category === 'overlay') ovCnt++
                else geoCnt++
                rawPasses.push({
                    id:        desc.id,
                    category:  desc.category || 'geometry',
                    visibleIn: desc.visibleIn || 'all',
                    material:  desc.material,
                    uniforms:  desc.uniforms,
                    transform: desc.transform || { mode: 'identity' },
                    xyzUv:     xyzUv,
                    rgba:      rgba
                })
            }
        }
        var flushBase  = (cfg.model == null || cfg.model.flushBase !== false)
        var renderBase = (cfg.model == null || cfg.model.renderBase !== false)
        if (nat3d.bindCompiledItemFromJs(itemId, cfg.motion.speed, cfg.motion.attackExpand, cfg.lod.guiScale, rawPasses, flushBase, renderBase)) {
            BACKEND_STATUS.mode = 'native_mod_gpu'
            BAKED_ITEMS[itemId] = { passes: rawPasses.length, overlays: ovCnt, geometries: geoCnt, totalVerts: totalVerts }
            BAKED_COUNT = Object.keys(BAKED_ITEMS).length
            return true
        }
        return false
    }

    function registerShader(shaderId, opts) {
        var id = String(shaderId || '').trim()
        if (!id) return false
        var o = isPlainObjLike(opts) ? opts : {}
        var uList = Array.isArray(o.uniforms) ? o.uniforms.map(function (u) { return String(u) }) : []
        SHADER_SPECS[id] = {
            id:           id,
            vertexFormat: String(o.vertexFormat || 'POSITION_COLOR_TEX'),
            uniformNames: uList
        }
        var nat3d = resolveNativeItem3D()
        if (nat3d != null) {
            try { nat3d.registerShader(id, String(o.vertexFormat || 'POSITION_COLOR_TEX'), uList) } catch (eNatSh) { }
        }
        if (!SHADER_RUNTIME[id]) {
            SHADER_RUNTIME[id] = {
                registered: false,
                loaded:     false,
                instance:   null,
                uniforms:   {},
                setters1f:  {},
                setters2f:  {},
                setters3f:  {},
                setters4f:  {},
                lastError:  null
            }
        }
        return true
    }

    function listShaders() {
        return Object.keys(SHADER_SPECS)
    }

    function getShaderStatus(shaderId) {
        if (shaderId != null && String(shaderId).trim() !== '') {
            var id = String(shaderId).trim()
            var rt = SHADER_RUNTIME[id]
            if (!rt) return { id: id, registered: false, loaded: false, hasUniforms: false, lastError: 'not_registered' }
            var spec = SHADER_SPECS[id]
            var allFound = true
            if (spec && spec.uniformNames.length > 0) {
                for (var ui = 0; ui < spec.uniformNames.length; ui++) {
                    if (rt.uniforms[spec.uniformNames[ui]] == null) { allFound = false; break }
                }
            }
            return {
                id:          id,
                registered:  rt.registered,
                loaded:      rt.loaded,
                hasUniforms: rt.loaded && allFound,
                lastError:   rt.lastError
            }
        }
        var ids = Object.keys(SHADER_SPECS)
        var loadedCnt = 0
        var allReady = ids.length > 0
        var byId = {}
        for (var i = 0; i < ids.length; i++) {
            var st = getShaderStatus(ids[i])
            byId[ids[i]] = st
            if (st.loaded) loadedCnt++
            if (!st.loaded || !st.hasUniforms) allReady = false
        }
        return {
            count:       ids.length,
            loadedCount: loadedCnt,
            registered:  ids.length > 0 && Object.keys(byId).every(function (k) { return byId[k].registered }),
            loaded:      ids.length > 0 && loadedCnt === ids.length,
            hasUniforms: allReady,
            shaders:     byId
        }
    }

    function registerLayerType(typeName, builderFn) {
        var k = String(typeName || '').trim().toLowerCase()
        if (!k || typeof builderFn !== 'function') return false
        CUSTOM_LAYERS[k] = builderFn
        return true
    }

    function unregisterLayerType(typeName) {
        var k = String(typeName || '').trim().toLowerCase()
        if (!k || !Object.prototype.hasOwnProperty.call(CUSTOM_LAYERS, k)) return false
        delete CUSTOM_LAYERS[k]
        return true
    }

    function listLayerTypes() {
        var builtins = ['surface_overlay', 'ribbon_ring', 'ribbon_helix', 'sprite_cluster']
        var custom   = Object.keys(CUSTOM_LAYERS)
        var seen     = Object.create(null)
        var out      = []
        for (var i = 0; i < builtins.length; i++) { seen[builtins[i]] = true; out.push(builtins[i]) }
        for (var j = 0; j < custom.length; j++) { if (!seen[custom[j]]) out.push(custom[j]) }
        return out
    }

    function registerPreset(name, presetOrFn) {
        return ITEM_PRESETS.register(name, presetOrFn)
    }

    function registerPart(name, partFn) {
        return PART_REGISTRY.register(name, partFn)
    }

    function bindItem(itemId, spec) {
        if (typeof itemId !== 'string' || !itemId) return false
        ITEM_BINDINGS[itemId] = spec || {}
        delete RESOLVED_CACHE[itemId]
        pushItemToNativeMod(itemId)
        return true
    }

    function unbindItem(itemId) {
        if (typeof itemId !== 'string' || !itemId) return false
        delete ITEM_BINDINGS[itemId]
        delete RESOLVED_CACHE[itemId]
        var nat3d = resolveNativeItem3D()
        if (nat3d != null) {
            try { nat3d.unbindItem(itemId) } catch (eUnb) { }
        }
        return true
    }

    function absorbGlobalBindings() {
        if (typeof global === 'undefined' || global == null) return
        var map = global.EpiphyItem3DBindings
        if (!isPlainObjLike(map)) return
        for (var id in map) {
            if (Object.prototype.hasOwnProperty.call(map, id)) {
                ITEM_BINDINGS[id] = map[id]
                delete RESOLVED_CACHE[id]
                pushItemToNativeMod(id)
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

    // ======================================================================== 7. Forge ModBus 挂钩：着色器批量注册 & 物品 3D 预烘焙
    function updateRegisteredShaderHandles(shaderId, shaderInst) {
        var rt = SHADER_RUNTIME[shaderId]
        if (!rt) return
        rt.instance  = shaderInst
        rt.loaded    = (shaderInst != null)
        rt.uniforms  = {}
        rt.setters1f = {}
        rt.setters2f = {}
        rt.setters3f = {}
        rt.setters4f = {}
        if (shaderInst == null) return
        var spec = SHADER_SPECS[shaderId]
        var names = (spec && Array.isArray(spec.uniformNames)) ? spec.uniformNames : []
        for (var i = 0; i < names.length; i++) {
            var uName = names[i]
            var uObj = null
            try { uObj = callMcMember(shaderInst, 'getUniform', 'm_173348_', uName) } catch (eU) { uObj = null }
            rt.uniforms[uName]  = uObj
            rt.setters1f[uName] = resolveUniformSetter(uObj, 1)
            rt.setters2f[uName] = resolveUniformSetter(uObj, 2)
            rt.setters3f[uName] = resolveUniformSetter(uObj, 3)
            rt.setters4f[uName] = resolveUniformSetter(uObj, 4)
        }
    }

    function uploadLayerUniforms(shaderId, uniformMap, ctx) {
        if (!shaderId || !isPlainObjLike(uniformMap)) return
        var rt = SHADER_RUNTIME[shaderId]
        if (!rt || !rt.loaded) return
        for (var uName in uniformMap) {
            if (!Object.prototype.hasOwnProperty.call(uniformMap, uName)) continue
            var uObj = rt.uniforms[uName]
            if (uObj == null) continue
            var binding = uniformMap[uName]
            var val = binding
            if (typeof binding === 'function') {
                val = binding(ctx)
            } else if (typeof binding === 'string') {
                if (binding === 'time') val = ctx.time
                else if (binding === 'viewYaw') val = ctx.viewYaw
                else if (binding === 'viewPitch') val = ctx.viewPitch
                else if (binding === 'viewYawPitch') val = [ctx.viewYaw, ctx.viewPitch]
                else if (binding === 'isGui') val = ctx.isGui ? 1.0 : 0.0
                else if (binding === 'attackProgress') val = ctx.attackProgress
            }
            if (Array.isArray(val)) {
                if (val.length === 2 && rt.setters2f[uName] != null) {
                    var a0 = isFinite(Number(val[0])) ? Number(val[0]) : 0.0
                    var a1 = isFinite(Number(val[1])) ? Number(val[1]) : 0.0
                    rt.setters2f[uName].call(uObj, a0, a1)
                } else if (val.length === 3 && rt.setters3f[uName] != null) {
                    rt.setters3f[uName].call(uObj, Number(val[0]) || 0.0, Number(val[1]) || 0.0, Number(val[2]) || 0.0)
                } else if (val.length >= 4 && rt.setters4f[uName] != null) {
                    rt.setters4f[uName].call(uObj, Number(val[0]) || 0.0, Number(val[1]) || 0.0, Number(val[2]) || 0.0, Number(val[3]) || 0.0)
                }
            } else if (typeof val === 'number' && rt.setters1f[uName] != null) {
                rt.setters1f[uName].call(uObj, isFinite(val) ? val : 0.0)
            }
        }
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
                console.warn('[EpiphyItem3DRenderer] Platform.isClientEnvironment() 探测异常，已跳过客户端物品 3D 挂钩：' + ePlat)
            } catch (eLog) { }
            return false
        }
    }

    function probeCclBackend() {
        // 若原生 Epiphy Mod 物品 3D 引擎在场，直接由原生 ItemRendererMixin 接管，跳过 CodeChickenLib 探测与依赖！
        if (resolveNativeItem3D() != null) {
            BACKEND_STATUS.cclChecked   = true
            BACKEND_STATUS.cclAvailable = false
            BACKEND_STATUS.mode         = 'native_mod_gpu'
            BACKEND_STATUS.missingClass = null
            return false
        }
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
                console.warn('[EpiphyItem3DRenderer] 未检测到 CodeChickenLib (' + BACKEND_STATUS.missingClass + ')，已自动降级为原版静态物品模型（跳过自定义着色器与物品 3D 烘焙，不影响物品正常显示）')
            } catch (eWarn) { }
        }
        return BACKEND_STATUS.cclAvailable
    }

    var IS_CLIENT_SIDE = isClientSide()

    if (IS_CLIENT_SIDE && typeof ForgeModEvents !== 'undefined' && ForgeModEvents != null) {
        // 7.1 批量注册通过 registerShader 声明的全部自定义核心着色器
        try {
            ForgeModEvents.onEvent('net.minecraftforge.client.event.RegisterShadersEvent', function (event) {
                if (!probeCclBackend()) return
                var shaderIds = Object.keys(SHADER_SPECS)
                if (shaderIds.length === 0) return

                var $ResourceLocation    = Java.loadClass('net.minecraft.resources.ResourceLocation')
                var $DefaultVertexFormat = Java.loadClass('com.mojang.blaze3d.vertex.DefaultVertexFormat')
                var $Consumer            = Java.loadClass('java.util.function.Consumer')
                var $CCShaderInstance    = Java.loadClass('codechicken.lib.render.shader.CCShaderInstance')
                var provider             = event.getResourceProvider()

                var resolveVertexFormat = function (fmtName) {
                    if (fmtName === 'NEW_ENTITY') return readMcMember($DefaultVertexFormat, 'NEW_ENTITY', 'f_85812_')
                    if (fmtName === 'POSITION_COLOR') return readMcMember($DefaultVertexFormat, 'POSITION_COLOR', 'f_85815_')
                    return readMcMember($DefaultVertexFormat, 'POSITION_COLOR_TEX', 'f_85818_')
                }

                for (var si = 0; si < shaderIds.length; si++) {
                    (function (sid) {
                        var spec = SHADER_SPECS[sid]
                        var rt   = SHADER_RUNTIME[sid]
                        rt.lastError  = null
                        rt.registered = true
                        try {
                            var parts     = splitResourceId(sid)
                            var vFmt      = resolveVertexFormat(spec.vertexFormat)
                            var shaderLoc = new $ResourceLocation(parts[0], parts[1])
                            var shaderObj = $CCShaderInstance.create(provider, shaderLoc, vFmt)
                            event.registerShader(shaderObj, new $Consumer({
                                accept: function (loadedShader) {
                                    updateRegisteredShaderHandles(sid, loadedShader)
                                    var foundCnt = 0
                                    for (var u = 0; u < spec.uniformNames.length; u++) {
                                        if (rt.uniforms[spec.uniformNames[u]] != null) foundCnt++
                                    }
                                    console.info('[EpiphyItem3DRenderer] 自定义核心着色器已就绪: ' + sid + ' (uniforms=' + foundCnt + '/' + spec.uniformNames.length + ')')
                                }
                            }))
                        } catch (eShader) {
                            rt.lastError = String(eShader)
                            console.error('[EpiphyItem3DRenderer] 注册核心着色器失败 (' + sid + ')：' + eShader)
                        }
                    })(shaderIds[si])
                }
            })
        } catch (eRegShaderHook) {
            console.warn('[EpiphyItem3DRenderer] 绑定 RegisterShadersEvent 失败：' + eRegShaderHook)
        }

        // 7.2 在模型烘焙阶段一次性按声明式 layers 预烘焙 CCModel 并包裹原始物品模型为 IItemRenderer
        try {
            ForgeModEvents.onEvent('net.minecraftforge.client.event.ModelEvent$ModifyBakingResult', function (event) {
                try {
                    BAKED_ITEMS = {}
                    BAKED_COUNT = 0
                    if (resolveNativeItem3D() != null) {
                        absorbGlobalBindings()
                        var natIds = Object.keys(ITEM_BINDINGS)
                        for (var ni = 0; ni < natIds.length; ni++) {
                            pushItemToNativeMod(natIds[ni])
                        }
                        return
                    }
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
                    var cullShard       = readMcMember($RenderStateShard, 'CULL', 'f_110158_')
                    var colorDepthWrite = readMcMember($RenderStateShard, 'COLOR_DEPTH_WRITE', 'f_110114_')
                    var colorOnlyWrite  = readMcMember($RenderStateShard, 'COLOR_WRITE', 'f_110115_')
                    var posColTexShard  = readMcMember($RenderStateShard, 'POSITION_COLOR_TEX_SHADER', 'f_173101_')
                    var guiContextEnum  = readMcMember($ItemDisplayContext, 'GUI', 'GUI')

                    var fnGetMc            = resolveMcMethod($Minecraft, 'getInstance', 'm_91087_')
                    var fnGetPosColTexSh   = resolveMcMethod($GameRenderer, 'getPositionColorTexShader', 'm_172814_')
                    var fnGetItemRenderRt  = resolveMcMethod($ItemBlockRenderTypes, 'getRenderType', 'm_109279_')
                    var fnGetFoilBufDirect = resolveMcMethod($ItemRenderer, 'getFoilBufferDirect', 'm_115222_')

                    var defaultShaderShard = posColTexShard != null
                        ? posColTexShard
                        : new $ShaderStateShard(new $Supplier({ get: function () { return fnGetPosColTexSh.call($GameRenderer) } }))

                    // 材质签名级 RenderType 缓存池：相同材质配置自动复用同一 RenderType
                    var rtCache = Object.create(null)
                    var getOrCreateMaterialRenderType = function (mat) {
                        var sig = [
                            mat.shader || 'builtin_pct',
                            mat.texture,
                            mat.blend,
                            mat.blur ? '1' : '0',
                            mat.cull ? '1' : '0',
                            mat.depthWrite ? '1' : '0'
                        ].join('|')
                        if (rtCache[sig] != null) return rtCache[sig]

                        var shaderShard = defaultShaderShard
                        if (mat.shader != null) {
                            (function (targetShaderId) {
                                shaderShard = new $ShaderStateShard(new $Supplier({
                                    get: function () {
                                        var rtObj = SHADER_RUNTIME[targetShaderId]
                                        if (rtObj != null && rtObj.instance != null) return rtObj.instance
                                        return fnGetPosColTexSh.call($GameRenderer)
                                    }
                                }))
                            })(mat.shader)
                        }
                        var texParts = splitResourceId(mat.texture)
                        var blendShard = (mat.blend === 'additive' && lightningBlend != null) ? lightningBlend : transAlpha
                        var writeShard = mat.depthWrite ? colorDepthWrite : colorOnlyWrite
                        var cullState  = (mat.cull && cullShard != null) ? cullShard : noCull

                        var b = callMcMember($CompositeState, 'builder', 'm_110628_')
                        b = callMcMember(b, 'setShaderState', 'm_173292_', shaderShard)
                        b = callMcMember(b, 'setTextureState', 'm_173290_', new $TextureStateShard(new $ResourceLocation(texParts[0], texParts[1]), mat.blur, false))
                        b = callMcMember(b, 'setTransparencyState', 'm_110685_', blendShard)
                        b = callMcMember(b, 'setCullState', 'm_110661_', cullState)
                        b = callMcMember(b, 'setWriteMaskState', 'm_110687_', writeShard)
                        var safeName = 'epiphy:item3d_' + sig.replace(/[^A-Za-z0-9_]/g, '_')
                        var rt = callMcMember(
                            $RenderType, 'create', 'm_173215_',
                            safeName,
                            posColTexFmt,
                            $VertexFormatMode.QUADS,
                            1024,
                            false,
                            false,
                            buildCompositeStateNone(b)
                        )
                        rtCache[sig] = rt
                        return rt
                    }

                    var resolveTransformState = function (stateName) {
                        if (stateName === 'tool' || stateName === 'handheld') return $TransformUtils.DEFAULT_TOOL
                        if (stateName === 'block') return $TransformUtils.DEFAULT_BLOCK
                        return $TransformUtils.DEFAULT_ITEM != null ? $TransformUtils.DEFAULT_ITEM : $TransformUtils.DEFAULT_TOOL
                    }

                    var modelsMap = event.getModels()
                    var bakedThisPass = 0

                    for (var idx = 0; idx < itemIds.length; idx++) {
                        (function (itemId) {
                            var cfg = getBoundItemConfig(itemId)
                            if (cfg == null) return

                            var mrl = new $ModelResourceLocation(new $ResourceLocation(itemId), 'inventory')
                            var originalModel = modelsMap.get(mrl)
                            if (originalModel == null) {
                                console.warn('[EpiphyItem3DRenderer] 未找到物品烘焙模型，跳过 3D 挂载：' + itemId)
                                return
                            }

                            var bakedPasses = []
                            var totalVerts = 0
                            var overlayCount = 0
                            var geometryCount = 0

                            for (var li = 0; li < cfg.layers.length; li++) {
                                var descs = compileLayerToDescriptors(cfg.layers[li], cfg)
                                for (var di = 0; di < descs.length; di++) {
                                    var desc = descs[di]
                                    if (!desc || !Array.isArray(desc.quads) || desc.quads.length === 0) continue
                                    var ccModel = bakeQuadsToCCModel(desc.quads, $CCModel, $Vertex5, $ColourAttribute, itemId + ':' + desc.id)
                                    if (ccModel == null) continue
                                    var vCnt = ccModel.verts ? ccModel.verts.length : (desc.quads.length * 4)
                                    totalVerts += vCnt
                                    if (desc.category === 'overlay') overlayCount++
                                    else geometryCount++
                                    bakedPasses.push({
                                        id:         desc.id,
                                        category:   desc.category || 'geometry',
                                        visibleIn:  desc.visibleIn || 'all',
                                        renderType: getOrCreateMaterialRenderType(desc.material),
                                        shaderId:   desc.material.shader,
                                        flushAfter: Boolean(desc.material.flushAfter),
                                        uniforms:   desc.uniforms,
                                        transform:  desc.transform || { mode: 'identity' },
                                        model:      ccModel,
                                        verts:      vCnt
                                    })
                                }
                            }

                            // 预分配复用矩阵与向量（热路径零 GC）
                            var baseMat      = new $Matrix4()
                            var workMat      = new $Matrix4()
                            var vecX         = $Vector3.X_POS
                            var vecY         = $Vector3.Y_POS
                            var vecZ         = $Vector3.Z_POS
                            var speedMul     = cfg.motion.speed
                            var attackExpand = cfg.motion.attackExpand
                            var guiScaleCfg  = cfg.lod.guiScale
                            var modelState   = resolveTransformState(cfg.model.state)

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
                            var fnAo    = function () { return cfg.model.ambientOcclusion }
                            var fnGui3d = function () { return cfg.model.isGui3d }
                            var fnLight = function () { return cfg.model.usesBlockLight }

                            var renderCtxScratch = {
                                time:           0.0,
                                viewYaw:        0.0,
                                viewPitch:      0.0,
                                isGui:          false,
                                attackProgress: 0.0,
                                attackScale:    1.0
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
                                    var drewOverlays = 0
                                    var drewGeoms = 0
                                    var drawnVerts = 0
                                    var origUs = 0, flushUs = 0, layersUs = 0

                                    RUNTIME_STATS.renderCalls++
                                    if (isGui) RUNTIME_STATS.guiCalls++
                                    else RUNTIME_STATS.handCalls++

                                    // 1. 绘制原版基础物品模型（可选立即 flush 写入深度缓冲）
                                    if (cfg.model.renderBase && cachedItemRen != null && fnRenderLists != null && originalModel != null) {
                                        try {
                                            var tOrig0 = MONO_CLOCK.nowMs()
                                            var origRt = fnGetItemRenderRt.call($ItemBlockRenderTypes, stack, true)
                                            var hasFoil = fnHasFoil != null ? Boolean(fnHasFoil.call(stack)) : false
                                            var vcOrig = fnGetFoilBufDirect.call($ItemRenderer, getter, origRt, true, hasFoil)
                                            fnRenderLists.call(cachedItemRen, originalModel, stack, packedLight, packedOverlay, mStack, vcOrig)
                                            var tOrig1 = MONO_CLOCK.nowMs()
                                            origUs = Math.max(0, Math.round((tOrig1 - tOrig0) * 1000.0))
                                            if (cfg.model.flushBase) {
                                                flushRenderType(getter, origRt)
                                            }
                                            flushUs = Math.max(0, Math.round((MONO_CLOCK.nowMs() - tOrig1) * 1000.0))
                                            didOrig = true
                                            RUNTIME_STATS.origDraws++
                                        } catch (eOrig) {
                                            logErrorThrottled('renderOrig_' + itemId, eOrig)
                                        }
                                    }

                                    if (!CONFIG.enabled || getter == null || bakedPasses.length === 0) return

                                    var t = nowSeconds() * speedMul
                                    if (!isFinite(t)) t = 0.0
                                    var yawRad = 0.0
                                    var pitchRad = 0.0
                                    var attackProg = 0.0
                                    var attackScale = 1.0

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
                                                var sw = Number(fnGetAttackAnim.call(player, partial) || 0.0)
                                                if (isFinite(sw) && sw > 0.001 && sw < 0.999) {
                                                    attackProg = sw
                                                    if (attackExpand !== 0.0) {
                                                        var ss = 1.0 + Math.sin(sw * PI) * attackExpand
                                                        if (isFinite(ss)) attackScale = ss
                                                    }
                                                }
                                            }
                                        }
                                    }

                                    renderCtxScratch.time           = t
                                    renderCtxScratch.viewYaw        = yawRad
                                    renderCtxScratch.viewPitch      = pitchRad
                                    renderCtxScratch.isGui          = isGui
                                    renderCtxScratch.attackProgress = attackProg
                                    renderCtxScratch.attackScale    = attackScale

                                    var tLay0 = MONO_CLOCK.nowMs()
                                    var ccrs  = $CCRenderState.instance()
                                    baseMat.set(mStack)
                                    var activeRt = null
                                    var radScale = isGui ? (guiScaleCfg * CONFIG.guiGlobalScale) : attackScale

                                    // 2. 按声明顺序执行全部预烘焙图层（相同 RenderType 自动连续合批，仅必要时重绑与 flush）
                                    for (var pi = 0; pi < bakedPasses.length; pi++) {
                                        var pass = bakedPasses[pi]
                                        if (pass.category === 'overlay' && !CONFIG.overlaysEnabled) continue
                                        if (pass.category !== 'overlay' && !CONFIG.geometryEnabled) continue
                                        if (pass.visibleIn === 'hand' && isGui) continue
                                        if (pass.visibleIn === 'gui' && !isGui) continue
                                        if (pass.shaderId != null) {
                                            var shRt = SHADER_RUNTIME[pass.shaderId]
                                            if (!shRt || !shRt.loaded) continue
                                        }

                                        try {
                                            if (pass.shaderId != null && pass.uniforms != null) {
                                                uploadLayerUniforms(pass.shaderId, pass.uniforms, renderCtxScratch)
                                            }
                                            if (activeRt !== pass.renderType) {
                                                ccrs.reset()
                                                ccrs.computeLighting = false
                                                ccrs.baseColour = -1
                                                ccrs.bind(pass.renderType, getter)
                                                activeRt = pass.renderType
                                            }

                                            var tr = pass.transform
                                            if (tr.mode === 'identity') {
                                                pass.model.render(ccrs, baseMat)
                                            } else if (typeof tr.apply === 'function') {
                                                workMat.set(baseMat)
                                                tr.apply(workMat, renderCtxScratch, { vecX: vecX, vecY: vecY, vecZ: vecZ, radScale: radScale })
                                                pass.model.render(ccrs, workMat)
                                            } else {
                                                workMat.set(baseMat)
                                                var tx = tr.cx, ty = tr.cy, tz = tr.cz
                                                if (tr.mode === 'local_axis_bob' && tr.bobAmp !== 0.0) {
                                                    var bob = Math.sin(t * tr.bobFreq + tr.bobPhase) * tr.bobAmp
                                                    tx += tr.axisDirX * bob
                                                    ty += tr.axisDirY * bob
                                                }
                                                workMat.translate(tx, ty, tz)
                                                if (tr.axisAngleRad !== 0.0) workMat.rotate(tr.axisAngleRad, vecZ)
                                                if (radScale !== 1.0) {
                                                    if (tr.scaleWithAttack === 'radial') workMat.scale(1.0, radScale, radScale)
                                                    else if (tr.scaleWithAttack !== 'none') workMat.scale(radScale)
                                                }
                                                if (tr.tiltV) workMat.rotate(tr.tiltV, vecZ)
                                                if (tr.tiltU) workMat.rotate(tr.tiltU, vecY)
                                                if (tr.spinSpeed) workMat.rotate(t * tr.spinSpeed, vecX)
                                                pass.model.render(ccrs, workMat)
                                            }

                                            if (pass.flushAfter) {
                                                flushRenderType(getter, pass.renderType)
                                                activeRt = null
                                            }

                                            drawnVerts += pass.verts
                                            if (pass.category === 'overlay') { drewOverlays++; RUNTIME_STATS.overlayDraws++ }
                                            else { drewGeoms++; RUNTIME_STATS.geometryDraws++ }
                                        } catch (ePass) {
                                            activeRt = null
                                            logErrorThrottled('renderLayer_' + itemId + '_' + pass.id, ePass)
                                        }
                                    }

                                    layersUs = Math.max(0, Math.round((MONO_CLOCK.nowMs() - tLay0) * 1000.0))
                                    var durUs = Math.max(0, Math.round((MONO_CLOCK.nowMs() - t0Ms) * 1000.0))
                                    RUNTIME_STATS.lastRenderUs = durUs
                                    RUNTIME_STATS.totalRenderUs += durUs
                                    if (durUs > RUNTIME_STATS.maxRenderUs) RUNTIME_STATS.maxRenderUs = durUs

                                    if ((!isGui && !RUNTIME_STATS.loggedFirstHand) || (isGui && !RUNTIME_STATS.loggedFirstGui)) {
                                        if (isGui) RUNTIME_STATS.loggedFirstGui = true
                                        else RUNTIME_STATS.loggedFirstHand = true
                                        try {
                                            console.info('[EpiphyItem3DRenderer] 首次渲染命中 ' + itemId +
                                                ' (ctx=' + String(displayContext) +
                                                ', isGui=' + isGui +
                                                ', orig=' + didOrig + '(' + origUs + 'us)' +
                                                ', flush=' + flushUs + 'us' +
                                                ', overlays=' + drewOverlays +
                                                ', geoms=' + drewGeoms +
                                                ', layersUs=' + layersUs + 'us' +
                                                ', verts=' + drawnVerts +
                                                ', totalUs=' + durUs + ')')
                                        } catch (eDiag) { }
                                    }
                                },
                                getModelState:       function () { return modelState },
                                m_7541_:             fnAo,
                                useAmbientOcclusion: fnAo,
                                m_7539_:             fnGui3d,
                                isGui3d:             fnGui3d,
                                m_7547_:             fnLight,
                                usesBlockLight:      fnLight,
                                m_6160_:             getParticleIconFn,
                                getParticleIcon:     getParticleIconFn
                            })

                            modelsMap.put(mrl, renderer)
                            BAKED_ITEMS[itemId] = {
                                passes:     bakedPasses.length,
                                overlays:   overlayCount,
                                geometries: geometryCount,
                                totalVerts: totalVerts
                            }
                            console.info('[EpiphyItem3DRenderer] 已预烘焙 ' + itemId +
                                ' (passes=' + bakedPasses.length +
                                ', overlays=' + overlayCount +
                                ', geometries=' + geometryCount +
                                ', totalVerts=' + totalVerts + ')')
                            bakedThisPass++
                        })(itemIds[idx])
                    }

                    BAKED_COUNT = bakedThisPass
                } catch (eBake) {
                    console.error('[EpiphyItem3DRenderer] ModelEvent$ModifyBakingResult 预烘焙失败：' + eBake)
                }
            })
        } catch (eRegBakeHook) {
            console.warn('[EpiphyItem3DRenderer] 绑定 ModelEvent$ModifyBakingResult 失败：' + eRegBakeHook)
        }
    }

    // ======================================================================== 8. 公开 API 导出
    var API = {
        VERSION:              VERSION,
        PROTO_VERSION:        PROTO_VER,
        CONFIG:               CONFIG,
        fx:                   createFxBuilder,
        registerShader:       registerShader,
        listShaders:          listShaders,
        getShaderStatus:      getShaderStatus,
        registerLayerType:    registerLayerType,
        unregisterLayerType:  unregisterLayerType,
        listLayerTypes:       listLayerTypes,
        registerPreset:       registerPreset,
        registerPart:         registerPart,
        bindItem:             bindItem,
        unbindItem:           unbindItem,
        absorbGlobalBindings: absorbGlobalBindings,
        getBoundItemConfig:   getBoundItemConfig,
        getStats: function () {
            var avgUs = RUNTIME_STATS.renderCalls > 0
                ? Math.round(RUNTIME_STATS.totalRenderUs / RUNTIME_STATS.renderCalls)
                : 0
            var shStat = getShaderStatus()
            return {
                version:       VERSION,
                protoVersion:  PROTO_VER,
                enabled:       CONFIG.enabled,
                envState:      ENV_STATE,
                cclAvailable:  BACKEND_STATUS.cclAvailable,
                backendMode:   BACKEND_STATUS.mode,
                missingClass:  BACKEND_STATUS.missingClass,
                clockSource:   MONO_CLOCK.getSource(),
                boundCount:    Object.keys(ITEM_BINDINGS).length,
                bakedCount:    BAKED_COUNT,
                bakedItems:    BAKED_ITEMS,
                shaderCount:   shStat.count,
                shaderLoaded:  shStat.loaded,
                layerTypes:    listLayerTypes(),
                runtime: {
                    renderCalls:   RUNTIME_STATS.renderCalls,
                    handCalls:     RUNTIME_STATS.handCalls,
                    guiCalls:      RUNTIME_STATS.guiCalls,
                    origDraws:     RUNTIME_STATS.origDraws,
                    overlayDraws:  RUNTIME_STATS.overlayDraws,
                    geometryDraws: RUNTIME_STATS.geometryDraws,
                    lastRenderUs:  RUNTIME_STATS.lastRenderUs,
                    maxRenderUs:   RUNTIME_STATS.maxRenderUs,
                    avgRenderUs:   avgUs,
                    lastError:     RUNTIME_STATS.lastError
                }
            }
        },
        _pure: {
            packRgba:                  packRgba,
            lerpRgb:                   lerpRgb,
            getNeutralItemSpec:        getNeutralItemSpec,
            normalizeItemSpec:         normalizeItemSpec,
            normalizeFrame:            normalizeFrame,
            compileLayerToDescriptors: compileLayerToDescriptors,
            pushCrossSegmentQuads:     pushCrossSegmentQuads,
            pushOrthoSpriteQuads:      pushOrthoSpriteQuads,
            buildSurfaceOverlayQuads:  buildSurfaceOverlayQuads,
            buildRibbonRingQuads:      buildRibbonRingQuads,
            buildRibbonRingMarkerQuads: buildRibbonRingMarkerQuads,
            buildRibbonHelixStrandQuads: buildRibbonHelixStrandQuads,
            buildRibbonHelixNodeQuads: buildRibbonHelixNodeQuads,
            buildSpriteClusterGroupQuads: buildSpriteClusterGroupQuads,
            validateQuadsFinite:       validateQuadsFinite
        }
    }

    if (typeof global !== 'undefined') {
        global.EpiphyItem3DRenderer = API
    }
})()
