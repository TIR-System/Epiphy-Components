// ============================================================================
//  Epiphy 的通用组件 —— 空间特效渲染器与世界消费端 (Epiphy3DFX / EpiphySpatialFX v2.2.0 · Client)
//  许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
//  放置位置：kubejs/client_scripts/通用组件/Epiphy的-空间特效渲染器.js
//  架构定位：
//    - 视觉表现层【子系统 B】(详见 docs/rendering-subsystem-roadmap.md §1、§2 功能六 & §8.1 P3-2)
//    - 与【子系统 A】2D 平面渲染器 (Epiphy的-平面渲染器.js / Epiphy2DRenderer) 严格正交解耦；
//    - 承担两大职责：
//      1. 物品 3D 渲染门面：转发至 `startup_scripts/通用组件/Epiphy的-空间特效核心.js` (global.Epiphy3DFXCore)，
//         提供运行时开关、绑定管理与诊断统计，不在客户端脚本注册任何逐帧物品 JS 顶点循环；
//      2. 世界 3D 空间特效消费端 (`surface: 'world'`, 频道 `epiphy:spatial_fx`, 协议 v1)：
//         负责 Fail-Closed 协议校验、Mojmap/SRG 全兼容 NBT 解码、待处理队列与同槽 `patch` 合并、
//         `'player'`/`'system'` 隔离与单向淘汰、`once`/`active` 生命周期与淡入淡出包络、
//         `followEntityUuid` 实体平滑插值追踪、内置 4 种纯原版图元默认渲染器 (`ring`/`beam`/`helix`/`sphere`)，
//         以及通过 `registerWorldShape(kind, fn)` 覆写/扩展的 `RenderLevelStageEvent` 渲染分发
//         （零活跃特效时 O(1) 短路零开销，严格 try/finally 状态还原）。
//  语法规范：遵循 README-LLM.md §1 强制 Rhino ES5 语法基准（纯 var、禁止 ??/let/const/简写/展开）。
// ============================================================================

;(function () {
    var VERSION = '2.2.0'
    var SPEC    = (typeof global !== 'undefined' && global != null) ? global.EpiphySpec : null
    var PROTO   = (typeof global !== 'undefined' && global != null && global.EpiphyProtocol != null)
        ? global.EpiphyProtocol
        : (SPEC && SPEC.PROTOCOL ? SPEC.PROTOCOL : null)

    var CHANNEL       = (PROTO && PROTO.FX3D_CHANNEL) ? PROTO.FX3D_CHANNEL : 'epiphy:spatial_fx'
    var PROTO_VERSION = (PROTO && PROTO.FX3D_PROTO_VERSION != null) ? PROTO.FX3D_PROTO_VERSION : 1
    var QUOTA         = (PROTO && PROTO.FX3D_QUOTA) ? PROTO.FX3D_QUOTA : {
        playerMaxCost:         16,
        systemMaxCost:         64,
        playerMaxPerNamespace: 8,
        systemMaxTotal:        64,
        maxPendingActions:     128
    }

    var LOCAL_BINDINGS = {}
    // 兜底默认值与 Epiphy3DFXCore.CONFIG 严格保持一致（由 Test 71 锁死防双源漂移）
    var FALLBACK_CONFIG = {
        enabled:          true,
        cosmosEnabled:    true,
        surroundEnabled:  true,
        guiSurroundScale: 0.86,
        guiRingLimit:     2,
        guiRenderHelix:   false,
        guiRenderMotes:   false
    }

    var WORLD_CONFIG = {
        maxPendingActions:     QUOTA.maxPendingActions || 128,
        maxPendingPerFrame:    32,
        systemMaxTotal:        QUOTA.systemMaxTotal || 64,
        playerMaxPerNamespace: QUOTA.playerMaxPerNamespace || 8,
        playerMaxCost:         QUOTA.playerMaxCost || 16,
        systemMaxCost:         QUOTA.systemMaxCost || 64,
        errorLogIntervalMs:    5000
    }

    // 单调时钟：优先复用 EpiphySpec.createMonotonicClock，缺失时退回单调钳制 Date.now()
    var MONO_CLOCK = null
    if (SPEC && typeof SPEC.createMonotonicClock === 'function') {
        MONO_CLOCK = SPEC.createMonotonicClock({
            allowSystemProbe: false,
            onWarn: function (msg) {
                try { console.warn('[Epiphy3DFX] ' + msg) } catch (eW) { }
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

    var lastErrorLogMs       = {}
    var activeWorldFx        = []
    var pendingActions       = []
    var worldSeq             = 0
    var droppedMismatch      = 0
    var droppedOverQuota     = 0
    var renderedFrameCount   = 0
    var renderedShapeCount   = 0
    var skippedUnknownShapes = 0
    var CUSTOM_WORLD_SHAPES  = Object.create(null)
    var BUILTIN_WORLD_SHAPES = Object.create(null)

    function logErrorThrottled(tag, err) {
        var now = MONO_CLOCK.nowMs()
        var prev = lastErrorLogMs[tag] || 0
        if (now - prev < WORLD_CONFIG.errorLogIntervalMs) return
        lastErrorLogMs[tag] = now
        try {
            console.warn('[Epiphy3DFX] ' + tag + ': ' + err)
        } catch (eLog) { }
    }

    function safeTypeOf(v) {
        if (v === null) return 'object'
        if (v === undefined) return 'undefined'
        try { return typeof v } catch (e) { return 'object' }
    }

    function isPlainObjLike(v) {
        return v != null && safeTypeOf(v) === 'object' && !Array.isArray(v)
    }

    function isRealCompoundTag(obj) {
        if (obj == null) return false
        try {
            return (typeof obj.getAllKeys === 'function' || typeof obj.m_128431_ === 'function') &&
                   (typeof obj.get === 'function' || typeof obj.m_128423_ === 'function')
        } catch (e) {
            return false
        }
    }

    function isRealListTag(obj) {
        if (obj == null || Array.isArray(obj) || isRealCompoundTag(obj)) return false
        try {
            return typeof obj.size === 'function' && typeof obj.get === 'function'
        } catch (e) {
            return false
        }
    }

    function readNbtTagId(val) {
        try {
            if (typeof val.getId === 'function') return Number(val.getId())
            if (typeof val.m_7060_ === 'function') return Number(val.m_7060_())
        } catch (eId) { }
        return -1
    }

    function readNbtNumeric(val) {
        if (typeof val.getAsDouble === 'function') return Number(val.getAsDouble())
        if (typeof val.m_7061_ === 'function')     return Number(val.m_7061_())
        if (typeof val.getAsFloat === 'function')  return Number(val.getAsFloat())
        if (typeof val.m_7057_ === 'function')     return Number(val.m_7057_())
        if (typeof val.getAsInt === 'function')    return Number(val.getAsInt())
        if (typeof val.m_7047_ === 'function')     return Number(val.m_7047_())
        if (typeof val.getAsByte === 'function')   return Number(val.getAsByte())
        if (typeof val.m_7063_ === 'function')     return Number(val.m_7063_())
        return null
    }

    function readNbtString(val) {
        if (typeof val.getAsString === 'function') return String(val.getAsString())
        if (typeof val.m_7916_ === 'function')     return String(val.m_7916_())
        return null
    }

    function nbtToPlainJs(val, depth) {
        if (val === null || val === undefined) return val
        var d = depth || 0
        if (d > 8) return null
        var t = safeTypeOf(val)
        if (t === 'string' || t === 'number' || t === 'boolean') return val
        if (Array.isArray(val)) {
            var arrOut = []
            for (var ai = 0; ai < val.length; ai++) arrOut.push(nbtToPlainJs(val[ai], d + 1))
            return arrOut
        }
        if (isRealCompoundTag(val)) {
            var objOut = {}
            var keys = typeof val.getAllKeys === 'function' ? val.getAllKeys() : val.m_128431_()
            var keyArr = []
            if (Array.isArray(keys)) keyArr = keys
            else if (keys != null && typeof keys.toArray === 'function') keyArr = keys.toArray()
            for (var ki = 0; ki < keyArr.length; ki++) {
                var kStr = String(keyArr[ki])
                var rawChild = typeof val.get === 'function' ? val.get(kStr) : val.m_128423_(kStr)
                objOut[kStr] = nbtToPlainJs(rawChild, d + 1)
            }
            return objOut
        }
        if (isRealListTag(val)) {
            var listOut = []
            var sz = Number(val.size() || 0)
            for (var li = 0; li < sz; li++) listOut.push(nbtToPlainJs(val.get(li), d + 1))
            return listOut
        }
        try {
            var tagId = readNbtTagId(val)
            // Tag 1..6 = Byte/Short/Int/Long/Float/Double (NumericTag)
            if (tagId >= 1 && tagId <= 6) {
                var numByTag = readNbtNumeric(val)
                if (numByTag !== null && isFinite(numByTag)) return numByTag
            }
            // Tag 8 = StringTag
            if (tagId === 8) {
                var strByTag = readNbtString(val)
                if (strByTag !== null) return strByTag
            }
            // 无 getId/m_7060_ 的轻量 NBT/包装对象：优先数值接口，再回落字符串接口
            var numVal = readNbtNumeric(val)
            if (numVal !== null && isFinite(numVal)) return numVal
            var strVal = readNbtString(val)
            if (strVal !== null) return strVal
        } catch (ePrim) { }
        return val
    }

    function isProtoOk(incoming) {
        if (PROTO && typeof PROTO.isProtoCompatible === 'function') {
            return PROTO.isProtoCompatible(PROTO_VERSION, incoming)
        }
        if (incoming === undefined || incoming === null) return false
        var n = Number(incoming)
        return isFinite(n) && n === PROTO_VERSION
    }

    function normalizeDimClient(rawDim) {
        if (SPEC && typeof SPEC.normalizeDim === 'function') return SPEC.normalizeDim(rawDim)
        if (rawDim == null) return ''
        var s = String(rawDim).trim().toLowerCase()
        if (!s) return ''
        return s.indexOf(':') >= 0 ? s : ('minecraft:' + s)
    }

    function computeCostClient(pkt) {
        if (SPEC && typeof SPEC.computeSpatialFxCost === 'function') {
            return SPEC.computeSpatialFxCost(pkt)
        }
        var shapes = Array.isArray(pkt.shapes) ? pkt.shapes : []
        return Math.max(1, shapes.length * 3)
    }

    function readNum(obj, key, defVal) {
        if (!isPlainObjLike(obj)) return defVal
        var v = obj[key]
        if (v === undefined || v === null || v === '') return defVal
        var n = Number(v)
        return isFinite(n) ? n : defVal
    }

    function readStr(obj, key, defVal) {
        if (!isPlainObjLike(obj)) return defVal
        var v = obj[key]
        if (v === undefined || v === null) return defVal
        return String(v)
    }

    function cloneSimpleMap(src) {
        var out = {}
        if (!isPlainObjLike(src)) return out
        for (var k in src) {
            if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k]
        }
        return out
    }

    // ------------------------------------------------------------------------
    // 1. 世界 3D 空间特效队列、隔离淘汰与生命周期管理 (`surface: 'world'`)
    // ------------------------------------------------------------------------
    function isControlAction(act) {
        return act === 'clear' || act === 'deactivate' || act === 'stop' || act === 'patch'
    }

    function enqueueWorldAction(rawPkt) {
        if (rawPkt == null) return false
        var pkt = nbtToPlainJs(rawPkt, 0)
        if (!isPlainObjLike(pkt)) return false
        if (!isProtoOk(pkt.proto)) {
            droppedMismatch++
            return false
        }
        var surface = readStr(pkt, 'surface', 'world').trim().toLowerCase()
        if (surface !== 'world') return false
        var action = readStr(pkt, 'action', 'push').trim().toLowerCase()
        if (action === 'stop') action = 'deactivate'
        pkt.surface = surface
        pkt.action  = action

        // 同槽位 patch 队列内原地合并（不额外消耗队列槽位）
        if (action === 'patch') {
            var pNs   = readStr(pkt, 'namespace', '')
            var pSlot = readStr(pkt, 'slotId', readStr(pkt, 'key', ''))
            if (pSlot) {
                for (var pi = pendingActions.length - 1; pi >= 0; pi--) {
                    var prev = pendingActions[pi]
                    if (prev != null && prev.action === 'patch' &&
                        readStr(prev, 'namespace', '') === pNs &&
                        readStr(prev, 'slotId', readStr(prev, 'key', '')) === pSlot) {
                        if (isPlainObjLike(pkt.vars)) {
                            if (!isPlainObjLike(prev.vars)) prev.vars = {}
                            for (var vk in pkt.vars) {
                                if (Object.prototype.hasOwnProperty.call(pkt.vars, vk)) prev.vars[vk] = pkt.vars[vk]
                            }
                        }
                        if (Array.isArray(pkt.worldPos) && pkt.worldPos.length >= 3) prev.worldPos = pkt.worldPos
                        if (pkt.activeHold != null) prev.activeHold = pkt.activeHold
                        return true
                    }
                }
            }
        }

        if (pendingActions.length >= WORLD_CONFIG.maxPendingActions) {
            if (isControlAction(action)) {
                var evictedIdx = -1
                for (var ei = 0; ei < pendingActions.length; ei++) {
                    if (!isControlAction(pendingActions[ei].action)) {
                        evictedIdx = ei
                        break
                    }
                }
                if (evictedIdx >= 0) pendingActions.splice(evictedIdx, 1)
                else pendingActions.shift()
            } else {
                droppedOverQuota++
                return false
            }
        }
        pendingActions.push(pkt)
        return true
    }

    function applyStopToFx(fx, nowMs, customFadeTicks) {
        fx.lifeMode = 'once'
        var fMs = (customFadeTicks >= 0) ? Math.max(50, customFadeTicks * 50) : Math.max(50, fx.fadeOutMs)
        if (nowMs < fx.fadeStartAt) {
            fx.fadeOutMs   = fMs
            fx.fadeStartAt = nowMs
            fx.expireAt    = nowMs + fMs
        }
    }

    function enforceWorldCaps(incomingTier, incomingNs) {
        // 1. 玩家单命名空间上限隔离
        if (incomingTier === 'player') {
            var nsList = []
            for (var i = 0; i < activeWorldFx.length; i++) {
                var it = activeWorldFx[i]
                if (it.tier === 'player' && it.namespace === incomingNs) nsList.push(i)
            }
            while (nsList.length >= WORLD_CONFIG.playerMaxPerNamespace) {
                var dropPos = nsList.shift()
                activeWorldFx.splice(dropPos, 1)
                for (var j = 0; j < nsList.length; j++) nsList[j]--
            }
        }

        // 2. 全局上限单向淘汰：始终优先淘汰 'player'（保护 'system'），同层按低优先级 + 最早创建淘汰
        while (activeWorldFx.length >= WORLD_CONFIG.systemMaxTotal) {
            var victimIdx = -1
            for (var vi = 0; vi < activeWorldFx.length; vi++) {
                var cand = activeWorldFx[vi]
                if (incomingTier === 'player' && cand.tier !== 'player') continue
                if (victimIdx < 0) {
                    victimIdx = vi
                    continue
                }
                var curV = activeWorldFx[victimIdx]
                var candIsPlayer = (cand.tier === 'player')
                var curIsPlayer  = (curV.tier === 'player')
                if (candIsPlayer !== curIsPlayer) {
                    if (candIsPlayer) victimIdx = vi
                    continue
                }
                if (cand.priority < curV.priority || (cand.priority === curV.priority && cand.seq < curV.seq)) {
                    victimIdx = vi
                }
            }
            if (victimIdx < 0) return false
            activeWorldFx.splice(victimIdx, 1)
        }
        return true
    }

    function applyWorldActionNow(pkt, nowMs) {
        if (!isPlainObjLike(pkt)) return
        var action = readStr(pkt, 'action', 'push')
        var ns     = readStr(pkt, 'namespace', '')
        var tier   = (readStr(pkt, 'tier', '') === 'player' || ns.indexOf('u:') === 0) ? 'player' : 'system'
        var isPlayerAct = (tier === 'player')

        if (action === 'clear') {
            var grp    = readStr(pkt, 'group', '*')
            var maxPri = readNum(pkt, 'maxPriority', 10)
            if (isPlayerAct && maxPri > 3) maxPri = 3
            if ((!grp || grp === '*' || grp === 'all') && !ns && !isPlayerAct && maxPri >= 10) {
                activeWorldFx.length = 0
                return
            }
            for (var ci = activeWorldFx.length - 1; ci >= 0; ci--) {
                var fxC = activeWorldFx[ci]
                if (isPlayerAct && fxC.tier !== 'player') continue
                if (ns && fxC.namespace !== ns) continue
                var grpHit = (!grp || grp === '*' || grp === 'all' || fxC.group === grp)
                if (grpHit && fxC.priority <= maxPri) {
                    activeWorldFx.splice(ci, 1)
                }
            }
            return
        }

        if (action === 'deactivate') {
            var targetKey  = readStr(pkt, 'key', readStr(pkt, 'slotId', '')).trim()
            var stopGrp    = readStr(pkt, 'group', '').trim()
            var stopMaxPri = readNum(pkt, 'maxPriority', 10)
            if (isPlayerAct && stopMaxPri > 3) stopMaxPri = 3
            var customFade = readNum(pkt, 'fadeOut', -1)
            var incOnce    = Boolean(pkt.includeOnce)
            var isWild     = (targetKey === '*' || targetKey === 'all' || stopGrp === '*' || stopGrp === 'all')

            if (isWild) {
                for (var wi = activeWorldFx.length - 1; wi >= 0; wi--) {
                    var wFx = activeWorldFx[wi]
                    if (isPlayerAct && wFx.tier !== 'player') continue
                    if (ns && wFx.namespace !== ns) continue
                    if (!incOnce && wFx.lifeMode !== 'active') continue
                    if (wFx.priority <= stopMaxPri) applyStopToFx(wFx, nowMs, customFade)
                }
                return
            }

            // 显式指定了 key/slotId 时：严格仅按 key/slotId 匹配（绝不因未命中而回退停掉同名 group）
            if (targetKey) {
                for (var ki = activeWorldFx.length - 1; ki >= 0; ki--) {
                    var kFx = activeWorldFx[ki]
                    if (isPlayerAct && kFx.tier !== 'player') continue
                    if (ns && kFx.namespace !== ns) continue
                    if (stopGrp && kFx.group !== stopGrp) continue
                    if (kFx.key === targetKey || (kFx.slotId && kFx.slotId === targetKey)) {
                        if (kFx.priority <= stopMaxPri) applyStopToFx(kFx, nowMs, customFade)
                    }
                }
                return
            }

            // 仅当未指定 key/slotId 时，才按 group 或 namespace 停止
            if (stopGrp || ns) {
                for (var gi = activeWorldFx.length - 1; gi >= 0; gi--) {
                    var gFx = activeWorldFx[gi]
                    if (isPlayerAct && gFx.tier !== 'player') continue
                    if (ns && gFx.namespace !== ns) continue
                    if (stopGrp && gFx.group !== stopGrp) continue
                    if (!incOnce && gFx.lifeMode !== 'active') continue
                    if (gFx.priority <= stopMaxPri) applyStopToFx(gFx, nowMs, customFade)
                }
            }
            return
        }

        if (action === 'patch') {
            var pKey = readStr(pkt, 'slotId', readStr(pkt, 'key', ''))
            if (!pKey) return
            for (var pi = 0; pi < activeWorldFx.length; pi++) {
                var pFx = activeWorldFx[pi]
                if (isPlayerAct && pFx.tier !== 'player') continue
                if (ns && pFx.namespace !== ns) continue
                if (pFx.slotId === pKey || pFx.key === pKey) {
                    if (isPlainObjLike(pkt.vars)) {
                        for (var vk in pkt.vars) {
                            if (Object.prototype.hasOwnProperty.call(pkt.vars, vk)) pFx.vars[vk] = pkt.vars[vk]
                        }
                    }
                    if (Array.isArray(pkt.worldPos) && pkt.worldPos.length >= 3) {
                        pFx.worldPos    = [Number(pkt.worldPos[0]) || 0, Number(pkt.worldPos[1]) || 0, Number(pkt.worldPos[2]) || 0]
                        pFx.hasWorldPos = true
                    }
                    if (pkt.followEntityUuid !== undefined) {
                        var nextFollow = readStr(pkt, 'followEntityUuid', '').trim()
                        if (pFx.followEntityUuid !== nextFollow) {
                            pFx.followEntityUuid    = nextFollow
                            pFx._followEntity       = null
                            pFx._followNextLookupMs = 0
                        }
                    }
                    if (Array.isArray(pkt.offset) && pkt.offset.length >= 3) {
                        pFx.offset = [Number(pkt.offset[0]) || 0, Number(pkt.offset[1]) || 0, Number(pkt.offset[2]) || 0]
                    }
                    if (pFx.lifeMode === 'active') {
                        var pHold = Math.max(4, readNum(pkt, 'activeHold', pFx.holdTicks))
                        pFx.holdTicks   = pHold
                        pFx.fadeStartAt = nowMs + pHold * 50
                        pFx.expireAt    = pFx.fadeStartAt + pFx.fadeOutMs
                    }
                    break
                }
            }
            return
        }

        // action === 'push'
        var cost = computeCostClient(pkt)
        var maxAllowed = isPlayerAct ? WORLD_CONFIG.playerMaxCost : WORLD_CONFIG.systemMaxCost
        if (cost > maxAllowed) {
            droppedOverQuota++
            return
        }

        var slotId      = readStr(pkt, 'slotId', '')
        var key         = readStr(pkt, 'key', slotId || ('wfx_' + (++worldSeq)))
        var group       = readStr(pkt, 'group', 'default')
        var lifeMode    = readStr(pkt, 'lifeMode', 'once') === 'active' ? 'active' : 'once'
        var pri         = Math.max(0, Math.min(10, Math.round(readNum(pkt, 'priority', lifeMode === 'active' ? 5 : 2))))
        if (isPlayerAct && pri > 3) pri = 3
        var stayTicks   = Math.max(4, readNum(pkt, 'stay', 60))
        var holdTicks   = Math.max(4, readNum(pkt, 'activeHold', stayTicks))
        var fadeInMs    = Math.max(0, readNum(pkt, 'fadeIn', 4) * 50)
        var fadeOutMs   = Math.max(50, readNum(pkt, 'fadeOut', 8) * 50)
        var dim         = normalizeDimClient(readStr(pkt, 'dimension', ''))
        var followUuid  = readStr(pkt, 'followEntityUuid', '').trim()
        var hasWorldPos = (pkt.hasWorldPos === false || pkt.hasWorldPos === 0)
            ? false
            : (Array.isArray(pkt.worldPos) && pkt.worldPos.length >= 3)
        var worldPos    = hasWorldPos
            ? [Number(pkt.worldPos[0]) || 0, Number(pkt.worldPos[1]) || 0, Number(pkt.worldPos[2]) || 0]
            : [0, 0, 0]
        var offsetVec   = (Array.isArray(pkt.offset) && pkt.offset.length >= 3)
            ? [Number(pkt.offset[0]) || 0, Number(pkt.offset[1]) || 0, Number(pkt.offset[2]) || 0]
            : null
        var maxDist     = Math.max(4, readNum(pkt, 'maxDistance', 96))
        var shapes      = Array.isArray(pkt.shapes) ? pkt.shapes : []
        if (shapes.length === 0) return

        // 同 key / slotId 续期覆盖
        for (var ei = 0; ei < activeWorldFx.length; ei++) {
            var exist = activeWorldFx[ei]
            if (exist.namespace === ns && (exist.key === key || (slotId && exist.slotId === slotId))) {
                if (isPlayerAct && exist.tier !== 'player') return
                exist.tier        = tier
                exist.group       = group
                exist.dimension   = dim
                exist.worldPos    = worldPos
                exist.hasWorldPos = hasWorldPos
                if (exist.followEntityUuid !== followUuid) {
                    exist.followEntityUuid    = followUuid
                    exist._followEntity       = null
                    exist._followNextLookupMs = 0
                }
                exist.offset      = offsetVec
                exist.lifeMode    = lifeMode
                exist.priority    = pri
                exist.holdTicks   = holdTicks
                exist.fadeInMs    = fadeInMs
                exist.fadeOutMs   = fadeOutMs
                exist.maxDistance = maxDist
                exist.shapes      = shapes
                exist.cost        = cost
                exist.vars        = cloneSimpleMap(pkt.vars)
                if (pkt.restart) exist.bornAt = nowMs
                var renewHoldMs = (lifeMode === 'active' ? holdTicks : stayTicks) * 50
                exist.fadeStartAt = nowMs + renewHoldMs
                exist.expireAt    = exist.fadeStartAt + fadeOutMs
                return
            }
        }

        if (!enforceWorldCaps(tier, ns)) {
            droppedOverQuota++
            return
        }

        var effHoldMs = (lifeMode === 'active' ? holdTicks : stayTicks) * 50
        activeWorldFx.push({
            seq:                 ++worldSeq,
            key:                 key,
            slotId:              slotId,
            namespace:           ns,
            group:               group,
            tier:                tier,
            dimension:           dim,
            worldPos:            worldPos,
            hasWorldPos:         hasWorldPos,
            followEntityUuid:    followUuid,
            _followEntity:       null,
            _followNextLookupMs: 0,
            offset:              offsetVec,
            lifeMode:            lifeMode,
            priority:            pri,
            holdTicks:           holdTicks,
            bornAt:              nowMs,
            fadeInMs:            fadeInMs,
            fadeOutMs:           fadeOutMs,
            fadeStartAt:         nowMs + effHoldMs,
            expireAt:            nowMs + effHoldMs + fadeOutMs,
            maxDistance:         maxDist,
            shapes:              shapes,
            cost:                cost,
            vars:                cloneSimpleMap(pkt.vars)
        })
    }

    function drainAndStepWorldFx(nowMs) {
        var limit = WORLD_CONFIG.maxPendingPerFrame
        var processed = 0
        while (pendingActions.length > 0 && processed < limit) {
            var next = pendingActions.shift()
            processed++
            try {
                applyWorldActionNow(next, nowMs)
            } catch (eApply) {
                logErrorThrottled('applyWorldActionNow', eApply)
            }
        }
        for (var i = activeWorldFx.length - 1; i >= 0; i--) {
            if (nowMs >= activeWorldFx[i].expireAt) {
                activeWorldFx.splice(i, 1)
            }
        }
    }

    function computeWorldFxAlpha(fx, nowMs) {
        var a = 1.0
        if (fx.fadeInMs > 0) {
            var el = nowMs - fx.bornAt
            if (el < fx.fadeInMs) a = Math.max(0.0, Math.min(1.0, el / fx.fadeInMs))
        }
        if (nowMs >= fx.fadeStartAt && fx.fadeOutMs > 0) {
            var rem = (fx.expireAt - nowMs) / fx.fadeOutMs
            a *= Math.max(0.0, Math.min(1.0, rem))
        }
        return a
    }

    function isTranslucentRenderStage(forgeEvent) {
        if (forgeEvent == null) return true
        try {
            var st = (typeof forgeEvent.getStage === 'function') ? forgeEvent.getStage() : forgeEvent.stage
            if (st == null) return true
            var name = String(st).toLowerCase()
            return name.indexOf('after_translucent') >= 0 || name.indexOf('after_particles') >= 0
        } catch (eSt) {
            return true
        }
    }

    function readCameraPos(forgeEvent) {
        try {
            var cam = (typeof forgeEvent.getCamera === 'function') ? forgeEvent.getCamera() : forgeEvent.camera
            if (cam == null) return [0, 0, 0]
            var pos = (typeof cam.getPosition === 'function') ? cam.getPosition() : cam.position
            if (pos == null) return [0, 0, 0]
            var cx = (typeof pos.x === 'function') ? pos.x() : pos.x
            var cy = (typeof pos.y === 'function') ? pos.y() : pos.y
            var cz = (typeof pos.z === 'function') ? pos.z() : pos.z
            return [Number(cx) || 0, Number(cy) || 0, Number(cz) || 0]
        } catch (eCam) {
            return [0, 0, 0]
        }
    }

    function readCurrentDimClient() {
        try {
            if (typeof Client !== 'undefined' && Client != null && Client.level != null && Client.level.dimension != null) {
                return normalizeDimClient(Client.level.dimension)
            }
        } catch (eDim) { }
        return ''
    }

    // ------------------------------------------------------------------------
    // 1.5 实体追踪解析 (`followEntityUuid`) 与 4 种纯原版内置图元渲染器
    // ------------------------------------------------------------------------
    var MC_CLASS_CACHE        = undefined
    var WORLD_RT_CACHE        = undefined
    var WORLD_POSE_MAT        = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    var WORLD_ROT_MAT         = [1, 0, 0, 0, 1, 0, 0, 0, 1]
    var FULL_BRIGHT_LIGHT     = 15728880
    var NO_OVERLAY_PACKED     = 655360

    function getMinecraftInstance() {
        if (MC_CLASS_CACHE === undefined) {
            MC_CLASS_CACHE = null
            if (typeof Java !== 'undefined' && Java != null && typeof Java.loadClass === 'function') {
                try { MC_CLASS_CACHE = Java.loadClass('net.minecraft.client.Minecraft') } catch (eMc) { MC_CLASS_CACHE = null }
            }
        }
        if (MC_CLASS_CACHE == null) return null
        try {
            if (typeof MC_CLASS_CACHE.getInstance === 'function') return MC_CLASS_CACHE.getInstance()
            if (typeof MC_CLASS_CACHE.m_91087_ === 'function') return MC_CLASS_CACHE.m_91087_()
        } catch (eInst) { }
        return null
    }

    function getClientLevelSafe() {
        try {
            if (typeof Client !== 'undefined' && Client != null && Client.level != null) return Client.level
        } catch (eCl) { }
        var mc = getMinecraftInstance()
        if (mc != null) {
            try {
                if (mc.level != null) return mc.level
                if (mc.f_91073_ != null) return mc.f_91073_
            } catch (eLv) { }
        }
        return null
    }

    function isEntityRemoved(ent) {
        if (ent == null) return true
        try {
            if (typeof ent.isRemoved === 'function') return Boolean(ent.isRemoved())
            if (typeof ent.m_213877_ === 'function') return Boolean(ent.m_213877_())
            if (ent.removed !== undefined) return Boolean(ent.removed)
        } catch (eRm) { return true }
        return false
    }

    function readEntityUuidLower(ent) {
        if (ent == null) return ''
        try {
            if (typeof ent.getStringUUID === 'function') return String(ent.getStringUUID()).trim().toLowerCase()
            if (typeof ent.m_20149_ === 'function') return String(ent.m_20149_()).trim().toLowerCase()
            if (typeof ent.getUUID === 'function') return String(ent.getUUID()).trim().toLowerCase()
            if (typeof ent.m_20148_ === 'function') return String(ent.m_20148_()).trim().toLowerCase()
            if (ent.uuid != null) return String(ent.uuid).trim().toLowerCase()
        } catch (eId) { }
        return ''
    }

    function findClientEntityByUuid(targetUuidLower) {
        if (!targetUuidLower) return null
        try {
            if (typeof Client !== 'undefined' && Client != null && Client.player != null) {
                if (!isEntityRemoved(Client.player) && readEntityUuidLower(Client.player) === targetUuidLower) {
                    return Client.player
                }
            }
        } catch (eCp) { }
        var level = getClientLevelSafe()
        if (level == null) return null
        var iterable = null
        try {
            if (typeof level.entitiesForRendering === 'function') iterable = level.entitiesForRendering()
            else if (typeof level.m_104735_ === 'function') iterable = level.m_104735_()
            else if (level.entities != null) iterable = level.entities
        } catch (eEnts) { iterable = null }
        if (iterable == null) return null

        if (Array.isArray(iterable)) {
            for (var i = 0; i < iterable.length; i++) {
                var e = iterable[i]
                if (e != null && !isEntityRemoved(e) && readEntityUuidLower(e) === targetUuidLower) return e
            }
            return null
        }
        try {
            if (typeof iterable.iterator === 'function') {
                var it = iterable.iterator()
                while (it.hasNext()) {
                    var ent = it.next()
                    if (ent != null && !isEntityRemoved(ent) && readEntityUuidLower(ent) === targetUuidLower) return ent
                }
            }
        } catch (eIt) { }
        return null
    }

    function readEntityInterpPos(ent, partialTick) {
        if (ent == null) return null
        try {
            var x = (typeof ent.getX === 'function') ? Number(ent.getX()) : ((typeof ent.m_20185_ === 'function') ? Number(ent.m_20185_()) : Number(ent.x))
            var y = (typeof ent.getY === 'function') ? Number(ent.getY()) : ((typeof ent.m_20186_ === 'function') ? Number(ent.m_20186_()) : Number(ent.y))
            var z = (typeof ent.getZ === 'function') ? Number(ent.getZ()) : ((typeof ent.m_20189_ === 'function') ? Number(ent.m_20189_()) : Number(ent.z))
            if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return null
            var xo = (ent.xo !== undefined && ent.xo !== null) ? Number(ent.xo) : ((ent.f_19854_ !== undefined && ent.f_19854_ !== null) ? Number(ent.f_19854_) : x)
            var yo = (ent.yo !== undefined && ent.yo !== null) ? Number(ent.yo) : ((ent.f_19855_ !== undefined && ent.f_19855_ !== null) ? Number(ent.f_19855_) : y)
            var zo = (ent.zo !== undefined && ent.zo !== null) ? Number(ent.zo) : ((ent.f_19856_ !== undefined && ent.f_19856_ !== null) ? Number(ent.f_19856_) : z)
            if (!isFinite(xo)) xo = x
            if (!isFinite(yo)) yo = y
            if (!isFinite(zo)) zo = z
            var pt = Math.max(0.0, Math.min(1.0, Number(partialTick) || 0.0))
            return [xo + (x - xo) * pt, yo + (y - yo) * pt, zo + (z - zo) * pt]
        } catch (ePos) {
            return null
        }
    }

    function resolveFxRenderPos(fx, nowMs, partialTick) {
        var ox = fx.offset ? fx.offset[0] : 0.0
        var oy = fx.offset ? fx.offset[1] : 0.0
        var oz = fx.offset ? fx.offset[2] : 0.0
        if (fx.followEntityUuid) {
            if (fx._followEntity != null && isEntityRemoved(fx._followEntity)) {
                fx._followEntity = null
            }
            if (fx._followEntity == null && nowMs >= (fx._followNextLookupMs || 0)) {
                fx._followNextLookupMs = nowMs + 250
                fx._followEntity = findClientEntityByUuid(fx.followEntityUuid.toLowerCase())
            }
            if (fx._followEntity != null) {
                var ep = readEntityInterpPos(fx._followEntity, partialTick)
                if (ep != null) {
                    return [ep[0] + ox, ep[1] + oy, ep[2] + oz]
                }
            }
            // 目标实体不在视野/未加载且未显式指定静态坐标：跳过本帧渲染，绝不画到世界原点 (0,0,0)
            if (!fx.hasWorldPos) return null
        }
        if (!fx.hasWorldPos) return null
        return [fx.worldPos[0] + ox, fx.worldPos[1] + oy, fx.worldPos[2] + oz]
    }

    function resolveWorldBufferSource(forgeEvent) {
        if (forgeEvent != null) {
            try {
                if (typeof forgeEvent.getBufferSource === 'function') {
                    var bsEv = forgeEvent.getBufferSource()
                    if (bsEv != null) return bsEv
                }
                if (forgeEvent.bufferSource != null) return forgeEvent.bufferSource
            } catch (eBsEv) { }
        }
        var mc = getMinecraftInstance()
        if (mc == null) return null
        try {
            var rb = (typeof mc.renderBuffers === 'function') ? mc.renderBuffers() : ((typeof mc.m_91269_ === 'function') ? mc.m_91269_() : null)
            if (rb == null) return null
            if (typeof rb.bufferSource === 'function') return rb.bufferSource()
            if (typeof rb.m_110104_ === 'function') return rb.m_110104_()
        } catch (eBsMc) { }
        return null
    }

    function resolveWorldRenderType(forgeEvent, hasBufferSource) {
        if (forgeEvent != null && forgeEvent.worldRenderType != null) return forgeEvent.worldRenderType
        if (WORLD_RT_CACHE === undefined) {
            WORLD_RT_CACHE = null
            if (typeof Java !== 'undefined' && Java != null && typeof Java.loadClass === 'function') {
                try {
                    var RenderTypeCls = Java.loadClass('net.minecraft.client.renderer.RenderType')
                    var ResLocCls     = Java.loadClass('net.minecraft.resources.ResourceLocation')
                    var whiteTex      = new ResLocCls('epiphy', 'textures/effect/white_pixel.png')
                    if (typeof RenderTypeCls.entityTranslucentEmissive === 'function') {
                        WORLD_RT_CACHE = RenderTypeCls.entityTranslucentEmissive(whiteTex, false)
                    } else if (typeof RenderTypeCls.m_234335_ === 'function') {
                        WORLD_RT_CACHE = RenderTypeCls.m_234335_(whiteTex, false)
                    }
                } catch (eRt) { WORLD_RT_CACHE = null }
            }
        }
        if (WORLD_RT_CACHE != null) return WORLD_RT_CACHE
        return hasBufferSource ? 'epiphy:world_emissive' : null
    }

    function getBufferFromSource(bs, rt) {
        if (bs == null || rt == null) return null
        if (typeof bs.getBuffer === 'function') return bs.getBuffer(rt)
        if (typeof bs.m_6299_ === 'function') return bs.m_6299_(rt)
        return null
    }

    function flushWorldBufferSource(bs, rt) {
        if (bs == null || rt == null) return
        try {
            if (typeof bs.endBatch === 'function') bs.endBatch(rt)
            else if (typeof bs.m_109912_ === 'function') bs.m_109912_(rt)
        } catch (eFlush) { }
    }

    function readWorldPoseMatrixTo(poseStack, out) {
        // 默认单位矩阵
        out[0] = 1; out[1] = 0; out[2] = 0; out[3] = 0
        out[4] = 0; out[5] = 1; out[6] = 0; out[7] = 0
        out[8] = 0; out[9] = 0; out[10] = 1; out[11] = 0
        out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1
        if (poseStack == null) return false
        try {
            var last = (typeof poseStack.last === 'function') ? poseStack.last() : ((typeof poseStack.m_85850_ === 'function') ? poseStack.m_85850_() : null)
            if (last == null) return false
            var p = (typeof last.pose === 'function') ? last.pose() : ((typeof last.m_252922_ === 'function') ? last.m_252922_() : null)
            if (p == null || typeof p.m00 !== 'function') return false
            out[0] = Number(p.m00()); out[1] = Number(p.m10()); out[2] = Number(p.m20()); out[3] = Number(p.m30())
            out[4] = Number(p.m01()); out[5] = Number(p.m11()); out[6] = Number(p.m21()); out[7] = Number(p.m31())
            out[8] = Number(p.m02()); out[9] = Number(p.m12()); out[10] = Number(p.m22()); out[11] = Number(p.m32())
            out[12] = Number(p.m03()); out[13] = Number(p.m13()); out[14] = Number(p.m23()); out[15] = Number(p.m33())
            return true
        } catch (eMat) {
            return false
        }
    }

    function parseHexRgb(rawColor, defHex) {
        var hex = defHex
        if (typeof rawColor === 'number' && isFinite(rawColor)) {
            hex = rawColor & 0xFFFFFF
        } else if (typeof rawColor === 'string') {
            var s = rawColor.trim()
            if (s.charAt(0) === '#') s = s.slice(1)
            else if (s.indexOf('0x') === 0 || s.indexOf('0X') === 0) s = s.slice(2)
            var parsed = parseInt(s, 16)
            if (isFinite(parsed)) hex = parsed & 0xFFFFFF
        }
        return [
            ((hex >> 16) & 255) / 255.0,
            ((hex >> 8) & 255) / 255.0,
            (hex & 255) / 255.0
        ]
    }

    function buildEulerRot3(rx, ry, rz, out) {
        var cx = Math.cos(rx), sx = Math.sin(rx)
        var cy = Math.cos(ry), sy = Math.sin(ry)
        var cz = Math.cos(rz), sz = Math.sin(rz)
        // R = Ry * Rx * Rz
        out[0] = cy * cz + sy * sx * sz
        out[1] = -cy * sz + sy * sx * cz
        out[2] = sy * cx
        out[3] = cx * sz
        out[4] = cx * cz
        out[5] = -sx
        out[6] = -sy * cz + cy * sx * sz
        out[7] = sy * sz + cy * sx * cz
        out[8] = cy * cx
    }

    function emitWorldVertex(vc, mat, lx, ly, lz, u, v, r, g, b, a) {
        var wx = mat[0] * lx + mat[1] * ly + mat[2] * lz + mat[3]
        var wy = mat[4] * lx + mat[5] * ly + mat[6] * lz + mat[7]
        var wz = mat[8] * lx + mat[9] * ly + mat[10] * lz + mat[11]
        if (typeof vc.m_5954_ === 'function') {
            vc.m_5954_(wx, wy, wz, r, g, b, a, u, v, NO_OVERLAY_PACKED, FULL_BRIGHT_LIGHT, 0.0, 1.0, 0.0)
            return
        }
        var ri = Math.max(0, Math.min(255, Math.round(r * 255)))
        var gi = Math.max(0, Math.min(255, Math.round(g * 255)))
        var bi = Math.max(0, Math.min(255, Math.round(b * 255)))
        var ai = Math.max(0, Math.min(255, Math.round(a * 255)))
        if (typeof vc.vertex === 'function') {
            vc.vertex(wx, wy, wz)
              .color(ri, gi, bi, ai)
              .uv(u, v)
              .overlayCoords(NO_OVERLAY_PACKED)
              .uv2(FULL_BRIGHT_LIGHT)
              .normal(0.0, 1.0, 0.0)
              .endVertex()
        } else if (typeof vc.m_5483_ === 'function') {
            vc.m_5483_(wx, wy, wz)
              .m_6122_(ri, gi, bi, ai)
              .m_7421_(u, v)
              .m_86008_(NO_OVERLAY_PACKED)
              .m_85969_(FULL_BRIGHT_LIGHT)
              .m_5601_(0.0, 1.0, 0.0)
              .m_5752_()
        }
    }

    function emitTransformedQuad(vc, mat, rot, ox, oy, oz, x0, y0, z0, x1, y1, z1, x2, y2, z2, x3, y3, z3, r, g, b, a) {
        var r0 = rot[0], r1 = rot[1], r2 = rot[2]
        var r3 = rot[3], r4 = rot[4], r5 = rot[5]
        var r6 = rot[6], r7 = rot[7], r8 = rot[8]
        emitWorldVertex(vc, mat, r0 * x0 + r1 * y0 + r2 * z0 + ox, r3 * x0 + r4 * y0 + r5 * z0 + oy, r6 * x0 + r7 * y0 + r8 * z0 + oz, 0.0, 0.0, r, g, b, a)
        emitWorldVertex(vc, mat, r0 * x1 + r1 * y1 + r2 * z1 + ox, r3 * x1 + r4 * y1 + r5 * z1 + oy, r6 * x1 + r7 * y1 + r8 * z1 + oz, 1.0, 0.0, r, g, b, a)
        emitWorldVertex(vc, mat, r0 * x2 + r1 * y2 + r2 * z2 + ox, r3 * x2 + r4 * y2 + r5 * z2 + oy, r6 * x2 + r7 * y2 + r8 * z2 + oz, 1.0, 1.0, r, g, b, a)
        emitWorldVertex(vc, mat, r0 * x3 + r1 * y3 + r2 * z3 + ox, r3 * x3 + r4 * y3 + r5 * z3 + oy, r6 * x3 + r7 * y3 + r8 * z3 + oz, 0.0, 1.0, r, g, b, a)
    }

    function prepBuiltinShape(ctx, sh, defColor) {
        var vc = ctx.getBuiltinConsumer()
        if (vc == null) return null
        var rgb = parseHexRgb(sh.color, defColor)
        var baseAlpha = readNum(sh, 'alpha', 0.85)
        var alpha = Math.max(0.0, Math.min(1.0, baseAlpha * ctx.envAlpha))
        if (alpha <= 0.004) return null
        var ox = 0.0, oy = 0.0, oz = 0.0
        if (Array.isArray(sh.offset) && sh.offset.length >= 3) {
            ox = Number(sh.offset[0]) || 0.0
            oy = Number(sh.offset[1]) || 0.0
            oz = Number(sh.offset[2]) || 0.0
        }
        var tiltX = readNum(sh, 'tiltX', 0.0)
        var tiltY = readNum(sh, 'tiltY', 0.0)
        var tiltZ = readNum(sh, 'tiltZ', 0.0)
        var speed = readNum(sh, 'speed', 1.0)
        buildEulerRot3(tiltX, tiltY + ctx.timeSec * speed, tiltZ, WORLD_ROT_MAT)
        return { vc: vc, r: rgb[0], g: rgb[1], b: rgb[2], a: alpha, ox: ox, oy: oy, oz: oz }
    }

    // 内置图元 1：ring（水平 + 垂直十字双带光环，任意视角可见）
    BUILTIN_WORLD_SHAPES.ring = function (ctx, sh) {
        var p = prepBuiltinShape(ctx, sh, 0x7CEBFF)
        if (p == null) return
        var radius = Math.max(0.1, readNum(sh, 'radius', 2.0))
        var halfW  = Math.max(0.02, readNum(sh, 'width', 0.16) * 0.5)
        var segs   = Math.max(8, Math.min(64, Math.round(readNum(sh, 'segments', 24))))
        var rIn    = Math.max(0.02, radius - halfW)
        var rOut   = radius + halfW
        var step   = (Math.PI * 2.0) / segs
        var mat    = ctx.poseMatrix
        for (var i = 0; i < segs; i++) {
            var a0 = i * step
            var a1 = (i + 1) * step
            var c0 = Math.cos(a0), s0 = Math.sin(a0)
            var c1 = Math.cos(a1), s1 = Math.sin(a1)
            // XZ 平面丝带
            emitTransformedQuad(
                p.vc, mat, WORLD_ROT_MAT, p.ox, p.oy, p.oz,
                c0 * rIn, 0, s0 * rIn,
                c0 * rOut, 0, s0 * rOut,
                c1 * rOut, 0, s1 * rOut,
                c1 * rIn, 0, s1 * rIn,
                p.r, p.g, p.b, p.a
            )
            // 垂直薄壁带（侧视防消失）
            emitTransformedQuad(
                p.vc, mat, WORLD_ROT_MAT, p.ox, p.oy, p.oz,
                c0 * radius, -halfW, s0 * radius,
                c0 * radius,  halfW, s0 * radius,
                c1 * radius,  halfW, s1 * radius,
                c1 * radius, -halfW, s1 * radius,
                p.r, p.g, p.b, p.a * 0.72
            )
        }
    }

    // 内置图元 2：beam（十字交叉发光光柱 + 高亮内芯）
    BUILTIN_WORLD_SHAPES.beam = function (ctx, sh) {
        var p = prepBuiltinShape(ctx, sh, 0xFFE28A)
        if (p == null) return
        var h   = Math.max(0.2, readNum(sh, 'height', 8.0))
        var hw  = Math.max(0.04, readNum(sh, 'width', readNum(sh, 'radius', 0.45)) * 0.5)
        var mat = ctx.poseMatrix
        // 外层十字交叉光柱
        emitTransformedQuad(p.vc, mat, WORLD_ROT_MAT, p.ox, p.oy, p.oz, -hw, 0, 0,  hw, 0, 0,  hw, h, 0, -hw, h, 0, p.r, p.g, p.b, p.a * 0.72)
        emitTransformedQuad(p.vc, mat, WORLD_ROT_MAT, p.ox, p.oy, p.oz, 0, 0, -hw, 0, 0,  hw, 0, h,  hw, 0, h, -hw, p.r, p.g, p.b, p.a * 0.72)
        // 内芯高亮核
        var cw = hw * 0.45
        var cr = Math.min(1.0, p.r * 0.6 + 0.4)
        var cg = Math.min(1.0, p.g * 0.6 + 0.4)
        var cb = Math.min(1.0, p.b * 0.6 + 0.4)
        emitTransformedQuad(p.vc, mat, WORLD_ROT_MAT, p.ox, p.oy, p.oz, -cw, 0, 0,  cw, 0, 0,  cw, h, 0, -cw, h, 0, cr, cg, cb, p.a)
        emitTransformedQuad(p.vc, mat, WORLD_ROT_MAT, p.ox, p.oy, p.oz, 0, 0, -cw, 0, 0,  cw, 0, h,  cw, 0, h, -cw, cr, cg, cb, p.a)
    }

    // 内置图元 3：helix（双股螺旋上升光带）
    BUILTIN_WORLD_SHAPES.helix = function (ctx, sh) {
        var p = prepBuiltinShape(ctx, sh, 0xC68BFF)
        if (p == null) return
        var radius = Math.max(0.1, readNum(sh, 'radius', 1.2))
        var h      = Math.max(0.2, readNum(sh, 'height', 4.0))
        var halfW  = Math.max(0.03, readNum(sh, 'width', 0.16) * 0.5)
        var segs   = Math.max(8, Math.min(64, Math.round(readNum(sh, 'segments', 24))))
        var turns  = Math.max(0.5, readNum(sh, 'turns', 2.0))
        var mat    = ctx.poseMatrix
        for (var strand = 0; strand < 2; strand++) {
            var phase = strand * Math.PI
            for (var i = 0; i < segs; i++) {
                var t0 = i / segs
                var t1 = (i + 1) / segs
                var a0 = phase + t0 * turns * Math.PI * 2.0
                var a1 = phase + t1 * turns * Math.PI * 2.0
                var y0 = t0 * h
                var y1 = t1 * h
                var x0 = Math.cos(a0) * radius
                var z0 = Math.sin(a0) * radius
                var x1 = Math.cos(a1) * radius
                var z1 = Math.sin(a1) * radius
                emitTransformedQuad(
                    p.vc, mat, WORLD_ROT_MAT, p.ox, p.oy, p.oz,
                    x0, y0 - halfW, z0,
                    x0, y0 + halfW, z0,
                    x1, y1 + halfW, z1,
                    x1, y1 - halfW, z1,
                    p.r, p.g, p.b, p.a
                )
            }
        }
    }

    // 内置图元 4：sphere（半透明发光经纬球壳）
    BUILTIN_WORLD_SHAPES.sphere = function (ctx, sh) {
        var p = prepBuiltinShape(ctx, sh, 0x72D6FF)
        if (p == null) return
        var radius  = Math.max(0.1, readNum(sh, 'radius', 1.5))
        var lonSegs = Math.max(6, Math.min(24, Math.round(readNum(sh, 'segments', 12))))
        var latSegs = Math.max(4, Math.min(12, Math.round(lonSegs * 0.5)))
        var mat     = ctx.poseMatrix
        for (var la = 0; la < latSegs; la++) {
            var phi0 = -Math.PI * 0.5 + (la / latSegs) * Math.PI
            var phi1 = -Math.PI * 0.5 + ((la + 1) / latSegs) * Math.PI
            var cp0 = Math.cos(phi0), sp0 = Math.sin(phi0)
            var cp1 = Math.cos(phi1), sp1 = Math.sin(phi1)
            for (var lo = 0; lo < lonSegs; lo++) {
                var th0 = (lo / lonSegs) * Math.PI * 2.0
                var th1 = ((lo + 1) / lonSegs) * Math.PI * 2.0
                var ct0 = Math.cos(th0), st0 = Math.sin(th0)
                var ct1 = Math.cos(th1), st1 = Math.sin(th1)
                emitTransformedQuad(
                    p.vc, mat, WORLD_ROT_MAT, p.ox, p.oy, p.oz,
                    radius * cp0 * ct0, radius * sp0, radius * cp0 * st0,
                    radius * cp0 * ct1, radius * sp0, radius * cp0 * st1,
                    radius * cp1 * ct1, radius * sp1, radius * cp1 * st1,
                    radius * cp1 * ct0, radius * sp1, radius * cp1 * st0,
                    p.r, p.g, p.b, p.a * 0.55
                )
            }
        }
    }

    function pushPoseSafe(ps) {
        if (ps == null) return false
        if (typeof ps.pushPose === 'function') { ps.pushPose(); return true }
        if (typeof ps.m_85836_ === 'function') { ps.m_85836_(); return true }
        return false
    }

    function translatePoseSafe(ps, dx, dy, dz) {
        if (ps == null) return
        if (typeof ps.translate === 'function') ps.translate(dx, dy, dz)
        else if (typeof ps.m_85837_ === 'function') ps.m_85837_(dx, dy, dz)
    }

    function popPoseSafe(ps) {
        if (ps == null) return
        if (typeof ps.popPose === 'function') ps.popPose()
        else if (typeof ps.m_85849_ === 'function') ps.m_85849_()
    }

    function onRenderLevelStage(forgeEvent) {
        if (!getConfigObj().enabled) return
        if (!isTranslucentRenderStage(forgeEvent)) return
        var nowMs = MONO_CLOCK.nowMs()
        drainAndStepWorldFx(nowMs)
        if (activeWorldFx.length === 0) return

        var poseStack = null
        try {
            poseStack = (typeof forgeEvent.getPoseStack === 'function') ? forgeEvent.getPoseStack() : forgeEvent.poseStack
        } catch (ePs) { poseStack = null }

        var camPos = readCameraPos(forgeEvent)
        var curDim = readCurrentDimClient()
        var partialTick = 0.0
        try {
            partialTick = Number((typeof forgeEvent.getPartialTick === 'function') ? forgeEvent.getPartialTick() : (forgeEvent.partialTick || 0)) || 0.0
        } catch (ePt) { partialTick = 0.0 }

        renderedFrameCount++
        var timeSec = MONO_CLOCK.elapsedSec()

        var worldBufferSource = null
        var worldRenderType   = null
        var builtinVc         = null
        var builtinQueried    = false
        var getBuiltinConsumer = function () {
            if (!builtinQueried) {
                builtinQueried    = true
                worldBufferSource = resolveWorldBufferSource(forgeEvent)
                worldRenderType   = resolveWorldRenderType(forgeEvent, worldBufferSource != null)
                if (worldBufferSource != null && worldRenderType != null) {
                    builtinVc = getBufferFromSource(worldBufferSource, worldRenderType)
                }
            }
            return builtinVc
        }

        try {
            for (var i = 0; i < activeWorldFx.length; i++) {
                var fx = activeWorldFx[i]
                if (curDim && fx.dimension && fx.dimension !== curDim) continue
                var renderPos = resolveFxRenderPos(fx, nowMs, partialTick)
                if (renderPos == null) continue
                var dx = renderPos[0] - camPos[0]
                var dy = renderPos[1] - camPos[1]
                var dz = renderPos[2] - camPos[2]
                var maxD = fx.maxDistance
                if ((dx * dx + dy * dy + dz * dz) > (maxD * maxD)) continue

                var envAlpha = computeWorldFxAlpha(fx, nowMs)
                if (envAlpha <= 0.005) continue

                var pushed = false
                try {
                    if (pushPoseSafe(poseStack)) {
                        pushed = true
                        translatePoseSafe(poseStack, dx, dy, dz)
                    }
                    readWorldPoseMatrixTo(poseStack, WORLD_POSE_MAT)
                    var ctx = {
                        event:              forgeEvent,
                        poseStack:          poseStack,
                        poseMatrix:         WORLD_POSE_MAT,
                        cameraPos:          camPos,
                        renderPos:          renderPos,
                        relativePos:        [dx, dy, dz],
                        partialTick:        partialTick,
                        nowMs:              nowMs,
                        timeSec:            timeSec,
                        ageSec:             Math.max(0.0, (nowMs - fx.bornAt) * 0.001),
                        envAlpha:           envAlpha,
                        fx:                 fx,
                        getBuiltinConsumer: getBuiltinConsumer,
                        emitWorldVertex:    emitWorldVertex
                    }
                    for (var si = 0; si < fx.shapes.length; si++) {
                        var sh = fx.shapes[si]
                        var kind = (sh != null && sh.kind != null) ? String(sh.kind).trim().toLowerCase() : ''
                        var rendererFn = CUSTOM_WORLD_SHAPES[kind] || BUILTIN_WORLD_SHAPES[kind]
                        if (typeof rendererFn === 'function') {
                            rendererFn(ctx, sh)
                            renderedShapeCount++
                        } else if (kind) {
                            skippedUnknownShapes++
                            logErrorThrottled('unknownWorldShape_' + kind, '未注册的世界 3D 图元类型 "' + kind + '"（可用 registerWorldShape 注册）')
                        }
                    }
                } catch (eRenderFx) {
                    logErrorThrottled('renderWorldFx_' + fx.key, eRenderFx)
                } finally {
                    if (pushed) {
                        try { popPoseSafe(poseStack) } catch (ePop) { }
                    }
                }
            }
        } finally {
            if (builtinVc != null && worldBufferSource != null && worldRenderType != null) {
                flushWorldBufferSource(worldBufferSource, worldRenderType)
            }
        }
    }

    // ------------------------------------------------------------------------
    // 2. KubeJS 客户端网络收包、登出清理与 Tick 生命周期推进
    // ------------------------------------------------------------------------
    if (typeof NetworkEvents !== 'undefined' && NetworkEvents != null &&
        typeof NetworkEvents.dataReceived === 'function') {
        NetworkEvents.dataReceived(CHANNEL, function (event) {
            if (event == null || event.data == null) return
            enqueueWorldAction(event.data)
        })
    }

    if (typeof ClientEvents !== 'undefined' && ClientEvents != null) {
        if (typeof ClientEvents.loggedOut === 'function') {
            ClientEvents.loggedOut(function () {
                activeWorldFx.length  = 0
                pendingActions.length = 0
            })
        }
        if (typeof ClientEvents.tick === 'function') {
            ClientEvents.tick(function () {
                if (pendingActions.length === 0 && activeWorldFx.length === 0) return
                drainAndStepWorldFx(MONO_CLOCK.nowMs())
            })
        }
    }

    // ------------------------------------------------------------------------
    // 3. 物品 3D 门面（转发至 Epiphy3DFXCore）
    // ------------------------------------------------------------------------
    function getCore() {
        return (typeof global !== 'undefined' && global != null && global.Epiphy3DFXCore) ? global.Epiphy3DFXCore : null
    }

    function getConfigObj() {
        var core = getCore()
        return (core != null && core.CONFIG) ? core.CONFIG : FALLBACK_CONFIG
    }

    function bindItem(itemId, spec) {
        if (typeof itemId !== 'string' || !itemId) return false
        LOCAL_BINDINGS[itemId] = spec || {}
        var core = getCore()
        if (core != null && typeof core.bindItem === 'function') {
            return core.bindItem(itemId, spec)
        }
        return true
    }

    function unbindItem(itemId) {
        if (typeof itemId !== 'string' || !itemId) return false
        delete LOCAL_BINDINGS[itemId]
        var core = getCore()
        if (core != null && typeof core.unbindItem === 'function') {
            return core.unbindItem(itemId)
        }
        return true
    }

    function absorbGlobalBindings() {
        var core = getCore()
        if (core != null && typeof core.absorbGlobalBindings === 'function') {
            core.absorbGlobalBindings()
            return
        }
        var map = (typeof global !== 'undefined' && global != null) ? global.Epiphy3DFXItemBindings : null
        if (map != null && typeof map === 'object' && !Array.isArray(map)) {
            for (var id in map) {
                if (Object.prototype.hasOwnProperty.call(map, id)) {
                    LOCAL_BINDINGS[id] = map[id]
                }
            }
        }
    }

    function getBoundItemConfig(itemId) {
        var core = getCore()
        if (core != null && typeof core.getBoundItemConfig === 'function') {
            return core.getBoundItemConfig(itemId)
        }
        if (!Object.prototype.hasOwnProperty.call(LOCAL_BINDINGS, itemId)) {
            absorbGlobalBindings()
        }
        return Object.prototype.hasOwnProperty.call(LOCAL_BINDINGS, itemId) ? LOCAL_BINDINGS[itemId] : null
    }

    function setEnabled(flag) {
        getConfigObj().enabled = Boolean(flag)
    }

    function setCosmosEnabled(flag) {
        getConfigObj().cosmosEnabled = Boolean(flag)
    }

    function setSurroundEnabled(flag) {
        getConfigObj().surroundEnabled = Boolean(flag)
    }

    function getShaderStatus() {
        var core = getCore()
        if (core != null && typeof core.getShaderStatus === 'function') {
            return core.getShaderStatus()
        }
        return { registered: false, loaded: false, hasUniforms: false, lastError: 'core_unavailable' }
    }

    function listWorldShapes() {
        var seen = Object.create(null)
        var out  = []
        var bk   = Object.keys(BUILTIN_WORLD_SHAPES)
        for (var i = 0; i < bk.length; i++) {
            seen[bk[i]] = true
            out.push(bk[i])
        }
        var ck = Object.keys(CUSTOM_WORLD_SHAPES)
        for (var j = 0; j < ck.length; j++) {
            if (!seen[ck[j]]) {
                seen[ck[j]] = true
                out.push(ck[j])
            }
        }
        return out
    }

    function getWorldStats() {
        return {
            channel:              CHANNEL,
            protoVersion:         PROTO_VERSION,
            activeCount:          activeWorldFx.length,
            pendingCount:         pendingActions.length,
            droppedMismatch:      droppedMismatch,
            droppedOverQuota:     droppedOverQuota,
            renderedFrames:       renderedFrameCount,
            renderedShapes:       renderedShapeCount,
            skippedUnknownShapes: skippedUnknownShapes,
            builtinShapes:        Object.keys(BUILTIN_WORLD_SHAPES),
            customShapes:         Object.keys(CUSTOM_WORLD_SHAPES),
            registeredShapes:     listWorldShapes(),
            clockSource:          MONO_CLOCK.getSource()
        }
    }

    function getStats() {
        var core = getCore()
        if (core != null && typeof core.getStats === 'function') {
            var st = core.getStats()
            st.clientFacadeVersion = VERSION
            st.coreAvailable       = true
            st.world               = getWorldStats()
            return st
        }
        return {
            version:             VERSION,
            clientFacadeVersion: VERSION,
            coreAvailable:       false,
            enabled:             getConfigObj().enabled,
            boundCount:          Object.keys(LOCAL_BINDINGS).length,
            bakedCount:          0,
            bakedItems:          {},
            shaderLoaded:        false,
            world:               getWorldStats()
        }
    }

    function registerWorldShape(kind, renderFn) {
        var k = String(kind || '').trim().toLowerCase()
        if (!k || typeof renderFn !== 'function') return false
        CUSTOM_WORLD_SHAPES[k] = renderFn
        return true
    }

    function unregisterWorldShape(kind) {
        var k = String(kind || '').trim().toLowerCase()
        if (!k || !Object.prototype.hasOwnProperty.call(CUSTOM_WORLD_SHAPES, k)) return false
        delete CUSTOM_WORLD_SHAPES[k]
        return true
    }

    absorbGlobalBindings()

    var coreRef = getCore()
    var API = {
        VERSION:              VERSION,
        CHANNEL:              CHANNEL,
        PROTO_VERSION:        PROTO_VERSION,
        CONFIG:               getConfigObj(),
        WORLD_CONFIG:         WORLD_CONFIG,
        // 物品 3D 门面 API
        bindItem:             bindItem,
        unbindItem:           unbindItem,
        absorbGlobalBindings: absorbGlobalBindings,
        getBoundItemConfig:   getBoundItemConfig,
        setEnabled:           setEnabled,
        setCosmosEnabled:     setCosmosEnabled,
        setSurroundEnabled:   setSurroundEnabled,
        getShaderStatus:      getShaderStatus,
        getStats:             getStats,
        // 世界 3D 消费端 API (`surface: 'world'`)
        pushWorld: function (pkt) {
            if (!isPlainObjLike(pkt)) return false
            var copy = cloneSimpleMap(pkt)
            if (copy.proto == null) copy.proto = PROTO_VERSION
            if (!copy.surface) copy.surface = 'world'
            if (!copy.action) copy.action = 'push'
            return enqueueWorldAction(copy)
        },
        patchWorld: function (slotIdOrOpts, maybeVars, maybeHoldTicks) {
            if (isPlainObjLike(slotIdOrOpts)) {
                var copy = cloneSimpleMap(slotIdOrOpts)
                copy.proto   = PROTO_VERSION
                copy.surface = 'world'
                copy.action  = 'patch'
                return enqueueWorldAction(copy)
            }
            var payload = {
                proto:   PROTO_VERSION,
                surface: 'world',
                action:  'patch',
                slotId:  slotIdOrOpts != null ? String(slotIdOrOpts) : '',
                vars:    isPlainObjLike(maybeVars) ? maybeVars : {}
            }
            if (maybeHoldTicks != null) payload.activeHold = maybeHoldTicks
            return enqueueWorldAction(payload)
        },
        deactivateWorld: function (keyOrOpts, fadeOutOrOpts) {
            if (isPlainObjLike(keyOrOpts)) {
                var copy = cloneSimpleMap(keyOrOpts)
                copy.proto   = PROTO_VERSION
                copy.surface = 'world'
                copy.action  = 'deactivate'
                return enqueueWorldAction(copy)
            }
            var target = (keyOrOpts != null && String(keyOrOpts).trim() !== '') ? String(keyOrOpts).trim() : '*'
            var isWild = (target === '*' || target === 'all')
            var payload = {
                proto:   PROTO_VERSION,
                surface: 'world',
                action:  'deactivate',
                key:     isWild ? '*' : target,
                group:   isWild ? '*' : ''
            }
            if (typeof fadeOutOrOpts === 'number' && isFinite(fadeOutOrOpts)) payload.fadeOut = fadeOutOrOpts
            else if (isPlainObjLike(fadeOutOrOpts)) {
                if (fadeOutOrOpts.fadeOut != null) payload.fadeOut = fadeOutOrOpts.fadeOut
                if (fadeOutOrOpts.maxPriority != null) payload.maxPriority = fadeOutOrOpts.maxPriority
                if (fadeOutOrOpts.includeOnce != null) payload.includeOnce = fadeOutOrOpts.includeOnce
            }
            return enqueueWorldAction(payload)
        },
        deactivateGroupWorld: function (groupName, fadeOutOrOpts) {
            var target = (groupName != null && String(groupName).trim() !== '') ? String(groupName).trim() : '*'
            var payload = {
                proto:   PROTO_VERSION,
                surface: 'world',
                action:  'deactivate',
                key:     '',
                group:   target
            }
            if (typeof fadeOutOrOpts === 'number' && isFinite(fadeOutOrOpts)) payload.fadeOut = fadeOutOrOpts
            else if (isPlainObjLike(fadeOutOrOpts)) {
                if (fadeOutOrOpts.fadeOut != null) payload.fadeOut = fadeOutOrOpts.fadeOut
                if (fadeOutOrOpts.maxPriority != null) payload.maxPriority = fadeOutOrOpts.maxPriority
                if (fadeOutOrOpts.includeOnce != null) payload.includeOnce = fadeOutOrOpts.includeOnce
            }
            return enqueueWorldAction(payload)
        },
        clearWorld: function (groupOrOpts, maxPriority) {
            if (isPlainObjLike(groupOrOpts)) {
                var copy = cloneSimpleMap(groupOrOpts)
                copy.proto   = PROTO_VERSION
                copy.surface = 'world'
                copy.action  = 'clear'
                if (!copy.group) copy.group = '*'
                if (maxPriority != null && copy.maxPriority == null) copy.maxPriority = maxPriority
                return enqueueWorldAction(copy)
            }
            var payload = { proto: PROTO_VERSION, surface: 'world', action: 'clear', group: groupOrOpts || '*' }
            if (maxPriority != null) payload.maxPriority = maxPriority
            return enqueueWorldAction(payload)
        },
        listWorld: function () {
            var out = []
            for (var i = 0; i < activeWorldFx.length; i++) {
                var it = activeWorldFx[i]
                out.push({
                    key:              it.key,
                    slotId:           it.slotId,
                    namespace:        it.namespace,
                    group:            it.group,
                    tier:             it.tier,
                    dimension:        it.dimension,
                    worldPos:         it.worldPos.slice(),
                    hasWorldPos:      it.hasWorldPos,
                    followEntityUuid: it.followEntityUuid,
                    offset:           it.offset ? it.offset.slice() : null,
                    lifeMode:         it.lifeMode,
                    priority:         it.priority,
                    cost:             it.cost,
                    shapeCount:       it.shapes.length,
                    vars:             cloneSimpleMap(it.vars)
                })
            }
            return out
        },
        countWorld:           function () { return activeWorldFx.length + pendingActions.length },
        getWorldStats:        getWorldStats,
        registerWorldShape:   registerWorldShape,
        unregisterWorldShape: unregisterWorldShape,
        listWorldShapes:      listWorldShapes,
        _hasActiveWorldFx:    function () { return activeWorldFx.length > 0 || pendingActions.length > 0 },
        _onRenderLevelStage:  onRenderLevelStage,
        _stepWorldNow:        function (nowMs) { drainAndStepWorldFx(nowMs != null ? nowMs : MONO_CLOCK.nowMs()) },
        _nbtToPlainJs:        nbtToPlainJs,
        _pure:                (coreRef != null && coreRef._pure) ? coreRef._pure : {}
    }

    if (typeof global !== 'undefined') {
        global.Epiphy3DFX      = API
        global.EpiphySpatialFX = API
    }
})()
