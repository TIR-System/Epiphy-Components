// priority: 500
// ============================================================================
//  通用空间特效组件 —— 服务端调度器 (Epiphy3DFXServer v1.1.0)
//  所属系列：Epiphy的-通用组件系列（本系列包含 startup / server / client 配套脚本）
//  许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
//  放置位置：kubejs/server_scripts/通用组件/Epiphy的-空间特效组件.js
//  配套客户端渲染器：kubejs/client_scripts/通用组件/Epiphy的-空间特效渲染器.js (Epiphy3DFX >= 2.1.0, <= 2.99.x，协议 v1)
//  配套启动期核心：kubejs/startup_scripts/通用组件/Epiphy的-空间特效核心.js (Epiphy3DFXCore >= 1.0.0, <= 1.99.x)
//
//  依赖与缺失降级行为：
//    - 必需前置：kubejs/startup_scripts/通用组件/Epiphy的-Spec与通用工具.js (EpiphySpec / EpiphyProtocol, priority: 1200)
//               与 kubejs/server_scripts/通用组件/Epiphy的-服务端核心.js (EpiphyServerCore / EpiphyServerBase, priority: 1080)
//    - 必需配套：kubejs/client_scripts/通用组件/Epiphy的-空间特效渲染器.js（缺失时服务端 API 正常调度，客户端无世界 3D 渲染）
//    - 可选依赖：kubejs/server_scripts/通用组件/Epiphy的-日志.js (EpiphyLog, priority: 1100)
//      缺失时由 EpiphyServerBase 自动回退至 console 限频降级输出
//
//  [组件边界 / 禁止直接复用] 本组件属于 L3 业务调度层（视觉表现层【子系统 B】服务端），内部逻辑不得被其他模块
//    或兄弟 L3 组件直接复制或跨模块复用；外部玩法脚本仅应通过 global.Epiphy3DFXServer 公开 API 调用。
//  [可扩展性设计] 面向未来新约束与新几何体预留三处稳定扩展点：
//    1. addConstraint(name, fn)        — 声明式准入/配额/维度/频率约束链（无需侵入 buildPacket）
//    2. registerShapeSchema(kind, ...) — 注册自定义 3D 图元清洗器与权重计费函数
//    3. registerPreset(name, def)      — 跨阶段向上注册可复用 3D 空间特效预设（复用 EpiphySpec 预设注册表）
//  [语法规范] 遵循 README-LLM.md §1 强制 Rhino ES5 语法基准（纯 var、禁止 ??/let/const/简写/展开）。
// ============================================================================

;(function () {
    var SPEC  = (typeof global !== 'undefined') ? global.EpiphySpec : null
    var BASE  = (typeof global !== 'undefined') ? global.EpiphyServerBase : null
    var PROTO = (typeof global !== 'undefined' && global.EpiphyProtocol != null)
        ? global.EpiphyProtocol
        : (SPEC && SPEC.PROTOCOL ? SPEC.PROTOCOL : null)
    if (!SPEC || !PROTO || !BASE) {
        throw new Error('[Epiphy3DFXServer] 缺少硬依赖 (EpiphySpec / EpiphyProtocol / EpiphyServerBase)，请确认基础脚本已加载')
    }
    if (typeof SPEC.checkDependencyVersion === 'function') {
        SPEC.checkDependencyVersion('EpiphySpec', SPEC, '2.5.0', '2.99.99', { caller: 'Epiphy3DFXServer', required: true })
        SPEC.checkDependencyVersion('EpiphyServerCore', BASE, '2.5.0', '2.99.99', { caller: 'Epiphy3DFXServer', required: true })
    }

    var VERSION       = '1.1.0'
    var LOGGER        = BASE.createLogger('Epiphy3DFX', 5000)
    var CHANNEL       = PROTO.FX3D_CHANNEL || 'epiphy:spatial_fx'
    var PROTO_VERSION = PROTO.FX3D_PROTO_VERSION || 1
    var QUOTA         = PROTO.FX3D_QUOTA || {
        playerMaxCost:         16,
        systemMaxCost:         64,
        playerMaxPerNamespace: 8,
        systemMaxTotal:        64,
        maxPendingActions:     128
    }

    var SERVER_REF  = null
    var tickCounter = 0

    var CONFIG = {
        debug:              false,
        errorLogIntervalMs: 5000,
        defaultRadius:      64,
        defaultMaxDistance: 96,
        defaultStayTicks:   60,
        defaultActiveHold:  40,
        defaultFadeIn:      4,
        defaultFadeOut:     8,
        maxStayTicks:       72000,
        maxFadeTicks:       600,
        maxShapesPerPacket: 16,
        maxPlayerCost:      QUOTA.playerMaxCost || 16,
        maxSystemCost:      QUOTA.systemMaxCost || 64
    }

    var VALID_SURFACES = { world: true }
    var VALID_KINDS    = { ring: true, beam: true, helix: true, sphere: true, custom: true }
    var CUSTOM_SHAPE_VALIDATORS = Object.create(null)
    var CUSTOM_SHAPE_COSTS      = Object.create(null)
    var CONSTRAINTS             = [] // Array<{ name: string, fn: Function }>

    var FX3D_PRESETS = (SPEC && typeof SPEC.createPresetRegistry === 'function')
        ? SPEC.createPresetRegistry('fx3d')
        : { register: function () { return false }, has: function () { return false }, get: function () { return null }, remove: function () { return false }, list: function () { return [] }, resolve: function () { return null } }

    var KNOWN_PACKET_KEYS = (function () {
        var keys = [
            'proto', 'surface', 'action', 'tier', 'key', 'slotId', 'id',
            'namespace', 'group', 'preset', 'dimension', 'dim',
            'worldPos', 'x', 'y', 'z', 'followEntityUuid', 'offset',
            'lifeMode', 'stay', 'duration', 'activeHold', 'fadeIn', 'fadeOut',
            'priority', 'maxPriority', 'includeOnce', 'maxDistance', 'radius',
            'shapes', 'kind', 'shape', 'vars', 'restart', 'debug', 'server'
        ]
        var m = Object.create(null)
        for (var i = 0; i < keys.length; i++) m[keys[i]] = true
        return m
    })()

    if (typeof ServerEvents !== 'undefined' && ServerEvents != null) {
        if (typeof ServerEvents.loaded === 'function') {
            ServerEvents.loaded(function (event) {
                if (event != null && event.server != null) SERVER_REF = event.server
            })
        }
        if (typeof ServerEvents.unloaded === 'function') {
            ServerEvents.unloaded(function () {
                SERVER_REF = null
            })
        }
        if (typeof ServerEvents.tick === 'function') {
            ServerEvents.tick(function (event) {
                if (SERVER_REF == null && event != null && event.server != null) SERVER_REF = event.server
                tickCounter++
            })
        }
    }

    function resolveActiveServer(preferServer) {
        if (preferServer != null) return preferServer
        if (SERVER_REF != null) return SERVER_REF
        if (typeof BASE.resolveServer === 'function') {
            var resolved = BASE.resolveServer(null)
            if (resolved != null) {
                SERVER_REF = resolved
                return resolved
            }
        }
        if (typeof Utils !== 'undefined' && Utils != null && Utils.server != null) {
            SERVER_REF = Utils.server
            return SERVER_REF
        }
        return null
    }

    function reportWarn(msg, notifyPlayer) {
        return LOGGER.warn('参数警告', msg, notifyPlayer, CONFIG.errorLogIntervalMs)
    }

    function parseFiniteNum(v, defVal) {
        var n = SPEC.parseFiniteNum(v)
        return n !== null ? n : defVal
    }

    function parseNonNegNum(v, defVal, minVal) {
        var n = SPEC.parseNonNegNum(v)
        if (n === null) return defVal
        var floor = (minVal != null && isFinite(minVal)) ? minVal : 0
        return Math.max(floor, n)
    }

    function parseBool(v, defVal) {
        if (v === undefined || v === null || v === '') return defVal
        var b = SPEC.parseBoolStrict(v)
        return b !== null ? b : defVal
    }

    function parsePriority(val, defVal) {
        return SPEC.parsePriority(val, defVal, {
            map:           PROTO.PRIORITY_MAP,
            deprecatedMap: SPEC.DEPRECATED_PRIORITY_ALIASES,
            min:           0,
            max:           10
        })
    }

    function parseColor(val, defCol) {
        var parsed = SPEC.parseColor(val, defCol, SPEC.COLOR_PRESETS)
        return parsed != null ? parsed.color : defCol
    }

    function sanitizeVarsMap(rawVars) {
        if (!BASE.isObjectLike(rawVars) || Array.isArray(rawVars)) return {}
        var out = {}
        for (var k in rawVars) {
            if (!Object.prototype.hasOwnProperty.call(rawVars, k)) continue
            var v = rawVars[k]
            if (typeof v === 'number' && isFinite(v)) {
                out[k] = v
            } else if (typeof v === 'boolean') {
                out[k] = v
            } else if (v != null) {
                out[k] = String(v).slice(0, 256)
            }
        }
        return out
    }

    function sanitizeWorldPos(opts) {
        if (Array.isArray(opts.worldPos) && opts.worldPos.length >= 3) {
            var ax = parseFiniteNum(opts.worldPos[0], null)
            var ay = parseFiniteNum(opts.worldPos[1], null)
            var az = parseFiniteNum(opts.worldPos[2], null)
            if (ax !== null && ay !== null && az !== null) return [ax, ay, az]
        }
        if (opts.x != null && opts.y != null && opts.z != null) {
            var bx = parseFiniteNum(opts.x, null)
            var by = parseFiniteNum(opts.y, null)
            var bz = parseFiniteNum(opts.z, null)
            if (bx !== null && by !== null && bz !== null) return [bx, by, bz]
        }
        return null
    }

    function sanitizeOffset(rawOff) {
        if (Array.isArray(rawOff) && rawOff.length >= 3) {
            return [
                parseFiniteNum(rawOff[0], 0),
                parseFiniteNum(rawOff[1], 0),
                parseFiniteNum(rawOff[2], 0)
            ]
        }
        return null
    }

    function sanitizeShape(rawShape) {
        if (!BASE.isObjectLike(rawShape)) return null
        var kind = String(rawShape.kind || rawShape.type || 'ring').trim().toLowerCase()
        if (!VALID_KINDS[kind] && typeof CUSTOM_SHAPE_VALIDATORS[kind] !== 'function') {
            LOGGER.once('warn', 'unknownFx3dKind:' + kind, '未知 3D 图元类型 `' + kind + '`（请先通过 registerShapeSchema 注册或使用 ring/beam/helix/sphere/custom），已跳过。')
            return null
        }
        var out = {
            kind:     kind,
            radius:   Math.max(0.05, Math.min(128.0, parseFiniteNum(rawShape.radius, 1.5))),
            height:   Math.max(0.0, Math.min(256.0, parseFiniteNum(rawShape.height, kind === 'beam' ? 8.0 : 0.25))),
            width:    Math.max(0.02, Math.min(32.0, parseFiniteNum(rawShape.width, 0.14))),
            color:    parseColor(rawShape.color, 0x70E6FF),
            alpha:    Math.max(0.0, Math.min(1.0, parseFiniteNum(rawShape.alpha, 0.85))),
            speed:    Math.max(-32.0, Math.min(32.0, parseFiniteNum(rawShape.speed, 1.0))),
            tiltX:    Math.max(-180.0, Math.min(180.0, parseFiniteNum(rawShape.tiltX, 0.0))),
            tiltY:    Math.max(-180.0, Math.min(180.0, parseFiniteNum(rawShape.tiltY, 0.0))),
            tiltZ:    Math.max(-180.0, Math.min(180.0, parseFiniteNum(rawShape.tiltZ, 0.0))),
            segments: Math.max(4, Math.min(64, Math.round(parseFiniteNum(rawShape.segments, 24))))
        }
        if (rawShape.offset != null) {
            var sOff = sanitizeOffset(rawShape.offset)
            if (sOff != null) out.offset = sOff
        }
        if (rawShape.id != null && String(rawShape.id) !== '') {
            out.id = String(rawShape.id).slice(0, 64)
        }
        if (typeof CUSTOM_SHAPE_VALIDATORS[kind] === 'function') {
            var customRes = CUSTOM_SHAPE_VALIDATORS[kind](rawShape, out)
            if (customRes === false || customRes === null) return null
            if (BASE.isObjectLike(customRes)) out = customRes
        }
        return out
    }

    function warnUnknownKeys(opts) {
        if (!BASE.isObjectLike(opts)) return
        for (var k in opts) {
            if (!Object.prototype.hasOwnProperty.call(opts, k)) continue
            if (k.charAt(0) === '_' || KNOWN_PACKET_KEYS[k] === true) continue
            LOGGER.once('warn', 'unknownFx3dKey:' + k, '检测到未知 3D 空间特效参数 `' + k + '`（请检查拼写），已忽略。')
        }
    }

    function runConstraints(packet, ctx, notifyPlayer) {
        for (var i = 0; i < CONSTRAINTS.length; i++) {
            var rule = CONSTRAINTS[i]
            if (rule == null || typeof rule.fn !== 'function') continue
            var res
            try {
                res = rule.fn(packet, ctx)
            } catch (eRule) {
                return reportWarn('3D 空间特效约束 `' + rule.name + '` 执行异常（已 Fail-Closed 拦截）：' + eRule, notifyPlayer)
            }
            if (res === false) {
                return reportWarn('3D 空间特效被约束 `' + rule.name + '` 拦截！', notifyPlayer)
            }
            if (BASE.isObjectLike(res) && res.ok === false) {
                return reportWarn('3D 空间特效被约束 `' + rule.name + '` 拦截：' + String(res.reason || '未满足准入条件'), notifyPlayer)
            }
        }
        return true
    }

    function resolvePreset(name, overrides) {
        var resolved = FX3D_PRESETS.resolve(name, overrides)
        if (!BASE.isObjectLike(resolved)) return null
        var copy = {}
        for (var k in resolved) {
            if (Object.prototype.hasOwnProperty.call(resolved, k) && k !== 'preset') {
                copy[k] = resolved[k]
            }
        }
        // 函数型预设只需返回几何/样式，自动继承调用方未在预设里覆写的信封/定位/变量字段
        if (BASE.isObjectLike(overrides)) {
            var passKeys = [
                'surface', 'action', 'tier', '_sourceTier', 'key', 'slotId', 'id',
                'namespace', 'group', 'dimension', 'dim', 'worldPos', 'x', 'y', 'z',
                'followEntityUuid', 'offset', 'maxDistance', 'vars', 'restart', 'debug'
            ]
            for (var pi = 0; pi < passKeys.length; pi++) {
                var pk = passKeys[pi]
                if (overrides[pk] !== undefined && copy[pk] === undefined) {
                    copy[pk] = overrides[pk]
                }
            }
        }
        return copy
    }

    function buildValidatedPacket(rawOpts, notifyPlayer) {
        if (!BASE.isObjectLike(rawOpts)) {
            return reportWarn('调用 Epiphy3DFXServer 必须传入配置对象！', notifyPlayer)
        }
        var opts = rawOpts
        var earlyAct = String(opts.action || 'push').trim().toLowerCase()
        var isControl = (earlyAct === 'clear' || earlyAct === 'deactivate' || earlyAct === 'stop' || earlyAct === 'patch')
        if (typeof opts.preset === 'string' && opts.preset.trim() !== '') {
            if (!isControl) {
                var resolved = resolvePreset(opts.preset, opts)
                if (resolved == null) {
                    return reportWarn('未找到已注册的 3D 空间特效预设: ' + opts.preset, notifyPlayer)
                }
                opts = resolved
            }
        }
        warnUnknownKeys(opts)

        var surfaceStr = String(opts.surface || 'world').trim().toLowerCase()
        if (!VALID_SURFACES[surfaceStr]) {
            return reportWarn('不支持的 3D 承载面 surface="' + surfaceStr + '"（当前支持: ' + Object.keys(VALID_SURFACES).join(', ') + '）！', notifyPlayer)
        }
        var action = String(opts.action || 'push').trim().toLowerCase()
        if (action === 'stop') action = 'deactivate'

        var nsStr   = opts.namespace != null ? String(opts.namespace).trim() : ''
        var grpStr  = (opts.group != null && String(opts.group).trim() !== '') ? String(opts.group).trim() : 'default'
        var slotStr = (opts.slotId != null && String(opts.slotId).trim() !== '')
            ? String(opts.slotId).trim()
            : (opts.id != null ? String(opts.id).trim() : '')
        var keyStr  = (opts.key != null && String(opts.key).trim() !== '') ? String(opts.key).trim() : slotStr
        var tierStr = (opts._sourceTier === 'player' || opts.tier === 'player' || nsStr.indexOf('u:') === 0) ? 'player' : 'system'

        if (action === 'clear') {
            var cPkt = {
                proto:     PROTO_VERSION,
                surface:   surfaceStr,
                action:    'clear',
                tier:      tierStr,
                group:     (opts.group != null && String(opts.group).trim() !== '') ? String(opts.group).trim() : '*',
                namespace: nsStr
            }
            var cPri = opts.maxPriority != null ? opts.maxPriority : opts.priority
            if (cPri != null) cPkt.maxPriority = parsePriority(cPri, 10)
            if (!runConstraints(cPkt, { action: 'clear', rawOpts: opts }, notifyPlayer)) return null
            return cPkt
        }

        if (action === 'deactivate') {
            var dPkt = {
                proto:     PROTO_VERSION,
                surface:   surfaceStr,
                action:    'deactivate',
                tier:      tierStr,
                key:       keyStr,
                group:     opts.group != null ? String(opts.group).trim() : '',
                namespace: nsStr
            }
            var dFade = SPEC.parseTicksOrSec(opts.fadeOut)
            if (dFade !== null) dPkt.fadeOut = Math.min(CONFIG.maxFadeTicks, dFade)
            var dPri = opts.maxPriority != null ? opts.maxPriority : opts.priority
            if (dPri != null) dPkt.maxPriority = parsePriority(dPri, 10)
            if (parseBool(opts.includeOnce, false)) dPkt.includeOnce = true
            if (!runConstraints(dPkt, { action: 'deactivate', rawOpts: opts }, notifyPlayer)) return null
            return dPkt
        }

        if (action === 'patch') {
            if (!slotStr && !keyStr) {
                return reportWarn('3D 特效 patch 增量报文缺少必填参数 `slotId` / `id` / `key`！', notifyPlayer)
            }
            var pPkt = {
                proto:     PROTO_VERSION,
                surface:   surfaceStr,
                action:    'patch',
                tier:      tierStr,
                key:       keyStr,
                slotId:    slotStr || keyStr,
                namespace: nsStr,
                group:     grpStr,
                vars:      sanitizeVarsMap(opts.vars)
            }
            var pPos = sanitizeWorldPos(opts)
            if (pPos != null) pPkt.worldPos = pPos
            var pHoldRaw = opts.activeHold != null ? opts.activeHold : (opts.stay != null ? opts.stay : opts.duration)
            if (pHoldRaw != null) {
                var pHoldTicks = SPEC.parseTicksOrSec(pHoldRaw)
                if (pHoldTicks !== null && pHoldTicks > 0) {
                    pPkt.activeHold = Math.min(CONFIG.maxStayTicks, Math.max(4, pHoldTicks))
                }
            }
            if (!runConstraints(pPkt, { action: 'patch', rawOpts: opts }, notifyPlayer)) return null
            return pPkt
        }

        // action === 'push'
        var worldPos = sanitizeWorldPos(opts)
        if (worldPos == null && !opts.followEntityUuid) {
            return reportWarn('3D 空间特效 push 报文缺少必填坐标 `worldPos: [x, y, z]`（或 `x/y/z` / `followEntityUuid`）！', notifyPlayer)
        }

        var rawShapes = Array.isArray(opts.shapes) ? opts.shapes : null
        var shapes = []
        if (rawShapes != null) {
            for (var si = 0; si < rawShapes.length && shapes.length < CONFIG.maxShapesPerPacket; si++) {
                var cleaned = sanitizeShape(rawShapes[si])
                if (cleaned != null) shapes.push(cleaned)
            }
        } else if (BASE.isObjectLike(opts.shape)) {
            var oneClean = sanitizeShape(opts.shape)
            if (oneClean != null) shapes.push(oneClean)
        } else if (opts.kind != null) {
            var inlineClean = sanitizeShape(opts)
            if (inlineClean != null) shapes.push(inlineClean)
        }
        if (shapes.length === 0) {
            return reportWarn('3D 空间特效 push 报文缺少有效图元 `shapes[]`（或 `kind`）！', notifyPlayer)
        }

        var lifeRaw  = String(opts.lifeMode || 'once').trim().toLowerCase()
        var lifeMode = (lifeRaw === 'active') ? 'active' : 'once'
        var durTicks = SPEC.parseTicksOrSec(opts.duration != null ? opts.duration : opts.stay)
        var holdTicks = SPEC.parseTicksOrSec(opts.activeHold)
        var stayVal = (lifeMode === 'active')
            ? Math.min(CONFIG.maxStayTicks, Math.max(4, holdTicks !== null ? holdTicks : (durTicks !== null ? durTicks : CONFIG.defaultActiveHold)))
            : Math.min(CONFIG.maxStayTicks, Math.max(4, durTicks !== null ? durTicks : CONFIG.defaultStayTicks))
        var activeHoldVal = Math.min(CONFIG.maxStayTicks, Math.max(4, holdTicks !== null ? holdTicks : CONFIG.defaultActiveHold))
        var fadeInTicks  = SPEC.parseTicksOrSec(opts.fadeIn)
        var fadeOutTicks = SPEC.parseTicksOrSec(opts.fadeOut)
        var defPri = (lifeMode === 'active') ? 5 : 2
        var priority = parsePriority(opts.priority, defPri)
        if (tierStr === 'player' && priority > 3) priority = 3

        var dimStr = opts.dimension != null
            ? SPEC.normalizeDim(opts.dimension)
            : (opts.dim != null ? SPEC.normalizeDim(opts.dim) : '')

        var built = {
            proto:       PROTO_VERSION,
            surface:     surfaceStr,
            action:      'push',
            tier:        tierStr,
            key:         keyStr,
            slotId:      slotStr,
            namespace:   nsStr,
            group:       grpStr,
            dimension:   dimStr,
            hasWorldPos: (worldPos != null),
            lifeMode:    lifeMode,
            priority:    priority,
            stay:        stayVal,
            activeHold:  activeHoldVal,
            fadeIn:      Math.min(CONFIG.maxFadeTicks, fadeInTicks !== null ? fadeInTicks : CONFIG.defaultFadeIn),
            fadeOut:     Math.min(CONFIG.maxFadeTicks, fadeOutTicks !== null ? fadeOutTicks : CONFIG.defaultFadeOut),
            maxDistance: Math.max(4, Math.min(512, parseFiniteNum(opts.maxDistance, CONFIG.defaultMaxDistance))),
            shapes:      shapes,
            vars:        sanitizeVarsMap(opts.vars),
            restart:     parseBool(opts.restart, false),
            debug:       parseBool(opts.debug, false)
        }
        if (worldPos != null) {
            built.worldPos = worldPos
        }
        if (opts.followEntityUuid != null && String(opts.followEntityUuid).trim() !== '') {
            built.followEntityUuid = String(opts.followEntityUuid).trim()
            var fOff = sanitizeOffset(opts.offset)
            if (fOff != null) built.offset = fOff
        }

        var cost = (typeof SPEC.computeSpatialFxCost === 'function')
            ? SPEC.computeSpatialFxCost(built, CUSTOM_SHAPE_COSTS)
            : shapes.length * 3
        var maxCost = (tierStr === 'player') ? CONFIG.maxPlayerCost : CONFIG.maxSystemCost
        if (cost > maxCost) {
            return reportWarn('3D 空间特效渲染开销超出配额上限（cost=' + cost + ' > max=' + maxCost + '，tier=' + tierStr + '），已拒绝构建报文！', notifyPlayer)
        }
        built.cost = cost

        if (!runConstraints(built, { action: 'push', rawOpts: opts }, notifyPlayer)) return null
        return built
    }

    function sendPacketToPlayer(target, pkt, preferServer) {
        if (target == null || pkt == null) return 0
        var player = target
        if (typeof target === 'string') {
            var srv = resolveActiveServer(preferServer)
            if (srv == null) return 0
            try {
                player = srv.getPlayer(target)
            } catch (eGetP) {
                return 0
            }
        }
        if (player == null || typeof player.sendData !== 'function') return 0
        try {
            player.sendData(CHANNEL, pkt)
            return 1
        } catch (eSend) {
            LOGGER.catchWarn('sendData', eSend, null, CONFIG.errorLogIntervalMs)
            return 0
        }
    }

    function toPlayer(playerOrPlayers, opts) {
        if (playerOrPlayers == null) return 0
        var pkt = buildValidatedPacket(opts, null)
        if (pkt == null) return 0
        var preferSrv = (BASE.isObjectLike(opts) && opts.server != null) ? opts.server : null
        var list = (Array.isArray(playerOrPlayers) || SPEC.isArrayLike(playerOrPlayers)) ? playerOrPlayers : [playerOrPlayers]
        var sent = 0
        for (var i = 0; i < list.length; i++) {
            sent += sendPacketToPlayer(list[i], pkt, preferSrv)
        }
        return sent
    }

    function inDimension(levelOrDim, x, y, z, radius, opts) {
        var srv = resolveActiveServer((opts && opts.server) ? opts.server : null)
        var level = BASE.resolveLevel(levelOrDim, srv)
        if (level == null) return 0
        var r = parseNonNegNum(radius, CONFIG.defaultRadius, 1)
        var recipients = []
        BASE.forEachPlayerNear(level, x, y, z, r, function (p) {
            recipients.push(p)
        })
        if (recipients.length === 0) return 0
        var copy = {}
        if (BASE.isObjectLike(opts)) {
            for (var k in opts) {
                if (Object.prototype.hasOwnProperty.call(opts, k)) copy[k] = opts[k]
            }
        }
        if (copy.worldPos == null && copy.x == null && !copy.followEntityUuid && copy.action !== 'clear' && copy.action !== 'deactivate' && copy.action !== 'patch') {
            copy.worldPos = [parseFiniteNum(x, 0), parseFiniteNum(y, 64), parseFiniteNum(z, 0)]
        }
        if (!copy.dimension && !copy.dim) {
            var dimName = BASE.dimOfLevel(level)
            if (dimName) copy.dimension = dimName
        }
        var pkt = buildValidatedPacket(copy, null)
        if (pkt == null) return 0
        var sent = 0
        for (var i = 0; i < recipients.length; i++) {
            sent += sendPacketToPlayer(recipients[i], pkt, srv)
        }
        return sent
    }

    function patchNear(levelOrDim, x, y, z, radius, slotIdOrOpts, maybeVars, maybeHoldTicks) {
        var opts
        if (BASE.isObjectLike(slotIdOrOpts)) {
            opts = {}
            for (var k in slotIdOrOpts) {
                if (Object.prototype.hasOwnProperty.call(slotIdOrOpts, k)) opts[k] = slotIdOrOpts[k]
            }
            opts.action = 'patch'
        } else {
            opts = {
                action: 'patch',
                slotId: slotIdOrOpts != null ? String(slotIdOrOpts) : '',
                vars:   BASE.isObjectLike(maybeVars) ? maybeVars : {}
            }
            if (maybeHoldTicks != null) opts.activeHold = maybeHoldTicks
        }
        return inDimension(levelOrDim, x, y, z, radius, opts)
    }

    function buildDeactivateOpts(keyOrOpts, fadeOutOrOpts, isGroupMode) {
        var opts
        if (BASE.isObjectLike(keyOrOpts)) {
            opts = {}
            for (var k in keyOrOpts) {
                if (Object.prototype.hasOwnProperty.call(keyOrOpts, k)) opts[k] = keyOrOpts[k]
            }
            opts.action = 'deactivate'
        } else {
            var target = (keyOrOpts != null && String(keyOrOpts).trim() !== '') ? String(keyOrOpts).trim() : '*'
            var isWild = (target === '*' || target === 'all')
            if (isWild) {
                opts = { action: 'deactivate', key: '*', group: '*' }
            } else if (isGroupMode) {
                opts = { action: 'deactivate', key: '', group: target }
            } else {
                // 字符串简写默认仅按 key/slotId 精确停止，绝不同时填 group 以免同名 group 误停整组
                opts = { action: 'deactivate', key: target, group: '' }
            }
            if (typeof fadeOutOrOpts === 'number' && isFinite(fadeOutOrOpts)) {
                opts.fadeOut = fadeOutOrOpts
            } else if (BASE.isObjectLike(fadeOutOrOpts)) {
                for (var fk in fadeOutOrOpts) {
                    if (Object.prototype.hasOwnProperty.call(fadeOutOrOpts, fk)) opts[fk] = fadeOutOrOpts[fk]
                }
            }
        }
        return opts
    }

    function deactivatePlayer(player, keyOrOpts, fadeOutOrOpts) {
        return toPlayer(player, buildDeactivateOpts(keyOrOpts, fadeOutOrOpts, false))
    }

    function deactivateGroupPlayer(player, groupName, fadeOutOrOpts) {
        return toPlayer(player, buildDeactivateOpts(groupName, fadeOutOrOpts, true))
    }

    function deactivateNear(levelOrDim, x, y, z, radius, keyOrOpts, fadeOutOrOpts) {
        return inDimension(levelOrDim, x, y, z, radius, buildDeactivateOpts(keyOrOpts, fadeOutOrOpts, false))
    }

    function deactivateGroupNear(levelOrDim, x, y, z, radius, groupName, fadeOutOrOpts) {
        return inDimension(levelOrDim, x, y, z, radius, buildDeactivateOpts(groupName, fadeOutOrOpts, true))
    }

    function clearPlayer(player, groupOrOpts, maxPriority) {
        var opts
        if (BASE.isObjectLike(groupOrOpts)) {
            opts = {}
            for (var k in groupOrOpts) {
                if (Object.prototype.hasOwnProperty.call(groupOrOpts, k)) opts[k] = groupOrOpts[k]
            }
            opts.action = 'clear'
            if (maxPriority != null && opts.maxPriority == null) opts.maxPriority = maxPriority
        } else {
            opts = { action: 'clear', group: groupOrOpts || '*' }
            if (maxPriority != null) opts.maxPriority = maxPriority
        }
        return toPlayer(player, opts)
    }

    function clearNear(levelOrDim, x, y, z, radius, groupOrOpts, maxPriority) {
        var opts
        if (BASE.isObjectLike(groupOrOpts)) {
            opts = {}
            for (var k in groupOrOpts) {
                if (Object.prototype.hasOwnProperty.call(groupOrOpts, k)) opts[k] = groupOrOpts[k]
            }
            opts.action = 'clear'
            if (maxPriority != null && opts.maxPriority == null) opts.maxPriority = maxPriority
        } else {
            opts = { action: 'clear', group: groupOrOpts || '*' }
            if (maxPriority != null) opts.maxPriority = maxPriority
        }
        return inDimension(levelOrDim, x, y, z, radius, opts)
    }

    // ------------------------------------------------------------------------
    // 作用域有状态通道与槽位句柄（对称 Epiphy2DSurface.channel().slot()）
    // ------------------------------------------------------------------------
    function createChannel(chCfg) {
        var cfg = BASE.isObjectLike(chCfg) ? chCfg : {}
        var chNs          = cfg.namespace != null ? String(cfg.namespace).trim() : ''
        var chGroup       = (cfg.group != null && String(cfg.group).trim() !== '') ? String(cfg.group).trim() : 'default'
        var chResyncTicks = Math.max(10, Math.round(parseFiniteNum(cfg.resyncTicks, 60)))
        var beforeSendFn  = (typeof cfg.beforeSend === 'function') ? cfg.beforeSend : null

        function applyScope(raw) {
            var merged = {}
            if (BASE.isObjectLike(raw)) {
                for (var k in raw) {
                    if (Object.prototype.hasOwnProperty.call(raw, k)) merged[k] = raw[k]
                }
            }
            if (chNs && !merged.namespace) merged.namespace = chNs
            if (chGroup && !merged.group) merged.group = chGroup
            if (beforeSendFn != null) {
                var modded = beforeSendFn(merged)
                if (BASE.isObjectLike(modded)) merged = modded
            }
            return merged
        }

        return {
            namespace: chNs,
            group:     chGroup,
            inDimension: function (levelOrDim, x, y, z, radius, opts) {
                return inDimension(levelOrDim, x, y, z, radius, applyScope(opts))
            },
            toPlayer: function (playerOrPlayers, opts) {
                return toPlayer(playerOrPlayers, applyScope(opts))
            },
            clearNear: function (levelOrDim, x, y, z, radius, maxPriority) {
                return clearNear(levelOrDim, x, y, z, radius, { namespace: chNs, group: chGroup, maxPriority: maxPriority })
            },
            slot: function (slotId, slotDefaults) {
                var sid = String(slotId || '').trim()
                var defObj = BASE.isObjectLike(slotDefaults) ? slotDefaults : {}
                var slotResync = Math.max(10, Math.round(parseFiniteNum(defObj.resyncTicks, chResyncTicks)))
                var lastVariant = null
                var lastFullTick = -999999

                return {
                    slotId: sid,
                    reset: function () {
                        lastVariant  = null
                        lastFullTick = -999999
                    },
                    syncNear: function (levelOrDim, x, y, z, radius, frameOpts) {
                        var fo = BASE.isObjectLike(frameOpts) ? frameOpts : {}
                        var curTick = (typeof fo.tick === 'number' && isFinite(fo.tick)) ? fo.tick : tickCounter
                        var variant = fo.variant !== undefined ? String(fo.variant) : ''
                        var tickRewound = (lastFullTick > -999990 && curTick < lastFullTick)
                        var needFull = (fo.forceFull === true) ||
                            (lastVariant === null) ||
                            (variant !== lastVariant) ||
                            tickRewound ||
                            ((curTick - lastFullTick) >= slotResync)

                        if (needFull) {
                            var fullReq = {}
                            for (var dk in defObj) {
                                if (Object.prototype.hasOwnProperty.call(defObj, dk) && dk !== 'resyncTicks') {
                                    fullReq[dk] = defObj[dk]
                                }
                            }
                            for (var fk in fo) {
                                if (Object.prototype.hasOwnProperty.call(fo, fk) && fk !== 'tick' && fk !== 'variant' && fk !== 'forceFull') {
                                    fullReq[fk] = fo[fk]
                                }
                            }
                            fullReq.slotId = sid
                            fullReq.key    = fullReq.key || sid
                            fullReq.action = 'push'
                            var sentFull = inDimension(levelOrDim, x, y, z, radius, applyScope(fullReq))
                            lastVariant  = variant
                            lastFullTick = curTick
                            return sentFull
                        }

                        var patchReq = {
                            action: 'patch',
                            slotId: sid,
                            key:    sid,
                            vars:   BASE.isObjectLike(fo.vars) ? fo.vars : (BASE.isObjectLike(fo.data) ? fo.data : {})
                        }
                        if (fo.worldPos != null) patchReq.worldPos = fo.worldPos
                        if (fo.activeHold != null) patchReq.activeHold = fo.activeHold
                        return inDimension(levelOrDim, x, y, z, radius, applyScope(patchReq))
                    },
                    patchNear: function (levelOrDim, x, y, z, radius, vars, activeHold) {
                        return inDimension(levelOrDim, x, y, z, radius, applyScope({
                            action:     'patch',
                            slotId:     sid,
                            key:        sid,
                            vars:       BASE.isObjectLike(vars) ? vars : {},
                            activeHold: activeHold
                        }))
                    },
                    closeNear: function (levelOrDim, x, y, z, radius, fadeOut) {
                        lastVariant  = null
                        lastFullTick = -999999
                        return inDimension(levelOrDim, x, y, z, radius, applyScope({
                            action:  'deactivate',
                            key:     sid,
                            group:   chGroup,
                            fadeOut: fadeOut
                        }))
                    }
                }
            }
        }
    }

    // ------------------------------------------------------------------------
    // 扩展点 API：约束链 / 自定义图元模式 / 承载面扩展 / 向上预设注册
    // ------------------------------------------------------------------------
    function addConstraint(name, fn) {
        var key = String(name || '').trim()
        if (!key || typeof fn !== 'function') return false
        for (var i = 0; i < CONSTRAINTS.length; i++) {
            if (CONSTRAINTS[i].name === key) {
                CONSTRAINTS[i].fn = fn
                return true
            }
        }
        CONSTRAINTS.push({ name: key, fn: fn })
        return true
    }

    function removeConstraint(name) {
        var key = String(name || '').trim()
        for (var i = CONSTRAINTS.length - 1; i >= 0; i--) {
            if (CONSTRAINTS[i].name === key) {
                CONSTRAINTS.splice(i, 1)
                return true
            }
        }
        return false
    }

    function listConstraints() {
        var out = []
        for (var i = 0; i < CONSTRAINTS.length; i++) out.push(CONSTRAINTS[i].name)
        return out
    }

    function registerShapeSchema(kind, validatorFn, costFn) {
        var k = String(kind || '').trim().toLowerCase()
        if (!k) return false
        VALID_KINDS[k] = true
        if (typeof validatorFn === 'function') CUSTOM_SHAPE_VALIDATORS[k] = validatorFn
        if (typeof costFn === 'function') CUSTOM_SHAPE_COSTS[k] = costFn
        return true
    }

    function registerSurface(surfaceName) {
        var s = String(surfaceName || '').trim().toLowerCase()
        if (!s) return false
        VALID_SURFACES[s] = true
        return true
    }

    var API = {
        VERSION:             VERSION,
        CHANNEL:             CHANNEL,
        PROTO_VERSION:       PROTO_VERSION,
        CONFIG:              CONFIG,
        buildPacket:         buildValidatedPacket,
        toPlayer:            toPlayer,
        inDimension:         inDimension,
        patchNear:           patchNear,
        deactivatePlayer:      deactivatePlayer,
        deactivateGroupPlayer: deactivateGroupPlayer,
        deactivateNear:        deactivateNear,
        deactivateGroupNear:   deactivateGroupNear,
        clearPlayer:         clearPlayer,
        clearNear:           clearNear,
        channel:             createChannel,
        registerPreset:      FX3D_PRESETS.register,
        hasPreset:           FX3D_PRESETS.has,
        getPreset:           FX3D_PRESETS.get,
        removePreset:        FX3D_PRESETS.remove,
        listPresets:         FX3D_PRESETS.list,
        resolvePreset:       resolvePreset,
        addConstraint:       addConstraint,
        removeConstraint:    removeConstraint,
        listConstraints:     listConstraints,
        registerShapeSchema: registerShapeSchema,
        registerSurface:     registerSurface,
        _pure: {
            KNOWN_PACKET_KEYS: KNOWN_PACKET_KEYS,
            sanitizeShape:     sanitizeShape,
            sanitizeWorldPos:  sanitizeWorldPos
        }
    }

    if (typeof global !== 'undefined') {
        global.Epiphy3DFXServer = API
    }
})()
