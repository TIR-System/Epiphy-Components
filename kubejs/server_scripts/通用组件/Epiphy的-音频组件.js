// priority: 500
// ============================================================================
//  通用空间音频与流式声场组件 —— 服务端调度器 (EpiphyAudio v5.6)
//  所属系列：Epiphy的-通用组件系列（本系列包含 startup / server / client 配套脚本）
//  [LLM 协作规范] 每次进行较大修改或重构前，请先将修改同步至 <repo-root> 并执行 git commit 保存当前可用状态，便于随时回退与对比 diff。
//  许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
//  放置位置：kubejs/server_scripts/通用组件/Epiphy的-音频组件.js
//  配套客户端播放器：kubejs/client_scripts/通用组件/Epiphy的-音频播放器.js (EpiphyAudioClient v5.6)
//  配套权限阀组件：kubejs/server_scripts/通用组件/Epiphy的-权限阀.js（管理 /epiphy 根命令、执行权限与 actorTier 资源分级）
//
//  依赖与缺失降级行为：
//    - 必需配套：kubejs/client_scripts/通用组件/Epiphy的-音频播放器.js（缺失时服务端可正常调度句柄，但客户端无声音输出）
//    - 前置底座：kubejs/startup_scripts/通用组件/Epiphy的-Spec与通用工具.js (EpiphySpec / EpiphyProtocol, priority: 1200)
//               与 kubejs/server_scripts/通用组件/Epiphy的-服务端核心.js (EpiphyServerCore / EpiphyServerBase, priority: 1080)
//    - 可选依赖：kubejs/server_scripts/通用组件/Epiphy的-日志.js (EpiphyLog, priority: 1100)
//      缺失时由 EpiphyServerBase 自动回退至 console 限频降级输出（核心功能不受影响）
//    - 可选依赖：kubejs/server_scripts/通用组件/Epiphy的-方块与区块组件.js (EpiphyBlockTracker, priority: 1050)
//      缺失时 bindBlock 降级为基础事件兜底模式（仅支持新放置/破坏方块，无区块扫描与持久化），不影响 play / toPlayer / at / onEntity 等常规 API
//    - 可选依赖：kubejs/server_scripts/通用组件/Epiphy的-权限阀.js (EpiphyPermissionValve, priority: 1000)
//      缺失时 /epiphy audio 指令不生效（OP 登录时提示），JS 调用接口正常；后续 /reload 补全权限阀后会自动从队列补注册并复位提示标志
//
//  适用环境：Minecraft 1.20.1 / Forge 47.x / KubeJS 2001.6.x
//
//  [组件边界 / 禁止直接复用] 本组件属于 L3 业务调度层（非 L1/L2 通用基础设施），内部逻辑不得被其他模块
//    或兄弟 L3 组件（如屏幕弹幕组件）直接复制或跨模块复用；外部玩法脚本仅应通过 global.EpiphyAudio 公开 API 调用。
//  [语法规范] 遵循 README-LLM.md §1 强制语法基准（与 docs/kube-mods-rhino-es5-es6-compatibility.md）：
//    以 ES5 + `var` 为主，可按需谨慎使用经实测无语义偏移的 ES6/ES2020 扩展语法；
//    严禁使用 `??`、`let`/`const`、对象属性简写/计算属性、展开与默认参数等已确认高危/失效特性。
// ============================================================================
//  调用说明（global.EpiphyAudio）
// ============================================================================
//  1. 推荐入口：
//     - EpiphyAudio.play(spec) / EpiphyAudio.play(target, soundId, opts) / EpiphyAudio.safePlay(...)
//     - EpiphyAudio.toPlayer(playerOrPlayers, soundId, opts)       [仅指定玩家收听，默认 2D 贴耳]
//     - EpiphyAudio.at(x, y, z, levelOrDim, soundId, opts)         [绑定维度与坐标]
//     - EpiphyAudio.atBlock(block, soundId, opts)                  [绑定方块中心，自动派生块坐标唯一 key]
//     - EpiphyAudio.onEntity(entity, soundId, opts)                [绑定并实时跟随实体/玩家]
//     - EpiphyAudio.inDimension(levelOrDim, soundId, opts)         [指定维度全维广播，或带 x,y,z,range 范围广播]
//     - EpiphyAudio.toAll(soundId, opts)                           [全服广域广播]
//     - EpiphyAudio.atEvent(event, soundId, opts)                  [事件驱动自动提取 block / entity / player / pos]
//     - EpiphyAudio.bindBlock(blockId, specOrFn)                   [自动绑定某类方块：含存档已有方块渐进扫描、放置自动启播、破坏自动停播]
//     - EpiphyAudio.unbindBlock(blockId)                           [解除某类方块的自动声源绑定]
//
//  2. 停止、控制与热更新：
//     - EpiphyAudio.stop(ref[, soundId, fadeOut])  支持传句柄号 / key / 方块(block) / 实体(entity) / 坐标对象
//     - EpiphyAudio.stopKey(key[, fadeOut]) / EpiphyAudio.stopTag(tag[, fadeOut]) / EpiphyAudio.stopGroup(group[, fadeOut])
//     - EpiphyAudio.stopAtBlock(block[, soundId, fadeOut]) / EpiphyAudio.stopOnEntity(entity[, soundId, fadeOut])
//     - EpiphyAudio.stopInDimension(levelOrDim[, soundId, fadeOut])
//     - EpiphyAudio.stopSound(soundId[, players, fadeOut]) / EpiphyAudio.stopFor(players[, soundId, fadeOut])
//     - EpiphyAudio.stopAll([fadeOut, maxPriority])
//     - EpiphyAudio.update(handleOrKey, patch)     支持无损热更新 volume / pitch / x,y,z / range（不打断客户端播放进度）
//     - EpiphyAudio.exclude(handleOrKey, players) / EpiphyAudio.include(handleOrKey, players)
// ============================================================================

;(() => {
    var SPEC  = (typeof global !== 'undefined') ? global.EpiphySpec : null
    var BASE  = (typeof global !== 'undefined') ? global.EpiphyServerBase : null
    var PROTO = (typeof global !== 'undefined' && global.EpiphyProtocol != null)
        ? global.EpiphyProtocol
        : (SPEC && SPEC.PROTOCOL ? SPEC.PROTOCOL : null)
    if (!SPEC || !PROTO || !BASE) {
        throw new Error('[EpiphyAudio] 缺少硬依赖 (EpiphySpec / EpiphyServerBase)，请确认基础脚本已加载')
    }
    var LOGGER        = BASE.createLogger('EpiphyAudio', 5000)
    var CHANNEL       = PROTO.AUDIO_CHANNEL
    var PROTO_VERSION = PROTO.AUDIO_PROTO_VERSION
    var VERSION       = PROTO.AUDIO_SEMVER

    var CONFIG = {
        syncIntervalTicks:   5,              // 资格、锚点与条件同步周期 (tick)
        scanEnqInterval:     20,             // 绑定方块渐进式区块段入队周期 (tick)
        scanSectionsPerTick: 2,              // 每 tick 最多扫描的 16x16x16 区块段数（零卡顿发现存档已有方块）
        rangeHysteresis:     2.0,            // 已收听玩家的离开判定迟滞放宽距离 (格)，防边界闪烁
        defaultRange:        32,
        playerMaxRange:      64,             // 非OP授权玩家未授予 audio.broadcast 时允许的最大收听半径 (格)
        minRange:            1,
        maxRange:            512,
        defaultOneShotTicks: 20 * 60 * 3,    // 非循环且未给 duration 时的句柄最大兜底保留时长 (3分钟)
        defaultActiveHold:   30,             // lifeMode='active' 心跳续期单次默认维持窗口 (tick)
        unstartedTimeoutTicks: 20 * 60 * 5,  // 挂起等待启动条件的最长保留时长 (tick, 0=不超时)
        anchorGraceTicks:    100,            // 实体锚点因区块卸载暂时丢失后的宽限等待 (tick)
        maxHandles:          512,            // 全服句柄上限；超出时按层级与优先级淘汰
        maxPlayerHandles:    64,             // 非OP授权玩家指令创建句柄的全服总上限
        maxCreatedHandlesPerPlayer: 8,       // 单名非OP授权玩家通过指令同时存在的句柄上限
        maxHandlesPerPlayer: 12,             // 单名玩家同时收听的句柄上限
        maxPlayerHandlesPerListener: 8,      // 单名玩家收听槽中允许 player 层级占用的上限（预留 >=4 槽给 system/OP/脚本）
        playerMaxPriority:   3,              // 非OP授权玩家指令允许的最高优先级
        maxBroadcastTargets: 4,              // 未授予 audio.broadcast 时非OP单次最多影响的在线人数
        maxKeyLength:        160,
        listMaxLines:        20,
        errorLogIntervalMs:  5000            // 限频警告日志最小间隔 (ms)
    }

    var PRIORITY_MAP = PROTO.PRIORITY_MAP

    var CATEGORY_ALIASES = {
        master: 'MASTER', music: 'MUSIC', record: 'RECORDS', records: 'RECORDS',
        weather: 'WEATHER', block: 'BLOCKS', blocks: 'BLOCKS', hostile: 'HOSTILE',
        neutral: 'NEUTRAL', player: 'PLAYERS', players: 'PLAYERS', ambient: 'AMBIENT', voice: 'VOICE'
    }
    var DEFAULT_CATEGORY = 'RECORDS'
    var FALLOFFS         = new Set(['linear', 'smooth', 'cutoff', 'flat'])
    var AUDIENCES        = new Set(['near', 'self', 'players', 'dim', 'all'])

    var loadJavaClass = BASE.loadJavaClass
    var UUIDClass     = loadJavaClass('java.util.UUID')
    var BlockPosClass = loadJavaClass('net.minecraft.core.BlockPos')
    var nowNano       = BASE.nowNano

    var lastSyncAllMs       = 0
    var lastActiveSyncAllMs = 0
    var maxSyncAllMs        = 0
    var syncAllCount        = 0
    var lastSyncAllTick     = 0

    var SESSION        = Date.now().toString(36) + Math.floor(Math.random() * 1679616).toString(36)
    var handles        = new Map() // id -> handle
    var keyIndex       = new Map() // key -> id
    var listenCount    = new Map() // uuid -> count
    var loginReadyTick = new Map() // uuid -> tickCounter
    var listenersGlobal = { start: [], join: [], leave: [], end: [] }

    var serverRef          = null
    var tickCounter        = 0
    var pendingReset       = true
    var nextHandleId       = 1
    var listenerTriggerSeq = 0
    // ======================================================================== 基础工具与限频告警（复用 L1/L2 EpiphySpec / EpiphyServerCore）

    var min2          = SPEC.min2
    var max2          = SPEC.max2
    var clampNum      = (v, lo, hi) => SPEC.clampNum(v, lo, hi, lo)
    var safeTypeOf    = BASE.safeTypeOf
    var isObjectLike  = BASE.isObjectLike
    var safeReadProp  = BASE.safeReadProp
    var safeHasMethod = BASE.safeHasMethod

    var reportWarning = (where, msg, notifyPlayer) => LOGGER.warn(where, msg, notifyPlayer, CONFIG.errorLogIntervalMs)
    var reportCatch   = (tag, err) => LOGGER.catchWarn(tag, err, null, CONFIG.errorLogIntervalMs)

    var parseFiniteNum = (val, defVal) => {
        var n = SPEC.parseFiniteNum(val)
        return n !== null ? n : defVal
    }

    var parseBool = (val, defVal) => {
        if (val === undefined || val === null || val === '') return defVal
        if (typeof val === 'number') return !isNaN(val) && val !== 0
        if (typeof val === 'string' && val.trim().toLowerCase() === 'none') return false
        var b = SPEC.parseBoolStrict(val)
        return b !== null ? b : defVal
    }

    var parsePriority = (val, defVal) => SPEC.parsePriority(val, defVal, { map: PRIORITY_MAP, min: 0, max: 10 })

    var parseTicks = SPEC.parseTicks

    var normalizeSoundId = (v) => {
        if (v == null) return null
        var raw = v
        if (isObjectLike(raw)) {
            if (safeHasMethod(raw, 'getLocation')) raw = raw.getLocation()
            else {
                var locProp = safeReadProp(raw, 'location')
                if (locProp != null) raw = locProp
            }
        }
        var s = String(raw).trim().toLowerCase()
        if (s.length === 0 || s.length > 256) return null
        if (!s.includes(':')) s = `minecraft:${s}`
        return /^[a-z0-9_.\-]+:[a-z0-9_.\-\/]+$/.test(s) ? s : null
    }

    var normalizeDim = SPEC.normalizeDim

    var normalizeCategory = (v) => {
        if (v == null || v === '') return DEFAULT_CATEGORY
        return CATEGORY_ALIASES[String(v).trim().toLowerCase()] || null
    }

    var normalizeKey = (v) => {
        if (v == null) return null
        var s = String(v).trim()
        return (s.length > 0 && s.length <= CONFIG.maxKeyLength) ? s : null
    }

    var copyObject = (src) => {
        var out = {}
        if (isObjectLike(src)) {
            for (var k of Object.keys(src)) out[k] = src[k]
        }
        return out
    }

    var toJsArray = BASE.toJsArray

    // ======================================================================== Minecraft / KubeJS 6 对象访问

    var isEntity = (o) => isObjectLike(o) && (safeHasMethod(o, 'getStringUUID') || safeHasMethod(o, 'getUUID'))
    var isPlayer = (o) => isEntity(o) && (safeHasMethod(o, 'getGameProfile') || safeHasMethod(o, 'm_36316_') || safeHasMethod(o, 'getProfile') || safeReadProp(o, 'username') != null)
    var isBlockContainer = (o) => isObjectLike(o) && !isEntity(o) &&
        (safeHasMethod(o, 'getBlockState') || safeReadProp(o, 'blockState') != null || (safeReadProp(o, 'id') != null && safeReadProp(o, 'level') != null && safeReadProp(o, 'pos') != null))

    var uuidOf     = BASE.uuidOf
    var entityIdOf = BASE.entityIdOf
    var nameOf     = (p) => BASE.nameOf(p) || '?'

    var levelOf = (o) => {
        if (o == null) return null
        var lv = safeReadProp(o, 'level')
        if (lv == null && safeHasMethod(o, 'getLevel')) {
            try { lv = o.getLevel() } catch (eLv) { lv = null }
        }
        return lv != null ? lv : null
    }

    var dimOfLevel = BASE.dimOfLevel

    var resolveDimId = (levelOrDim) => {
        if (levelOrDim == null) return null
        if (typeof levelOrDim === 'string') return normalizeDim(levelOrDim)
        var fromLv = dimOfLevel(levelOrDim)
        if (fromLv != null) return fromLv
        return normalizeDim(levelOrDim)
    }

    var allLevels = () => {
        if (serverRef == null || typeof serverRef.getAllLevels !== 'function') return []
        return toJsArray(serverRef.getAllLevels())
    }

    var resolveServerLevel = (dimId) => {
        if (serverRef == null || !dimId) return null
        return BASE.resolveLevel(dimId, serverRef)
    }

    var readPos            = BASE.readPos
    var extractBlockId     = BASE.extractBlockId
    var isBlockChunkLoaded = BASE.isChunkLoaded

    var queryBlockAt = (dimId, bx, by, bz) => {
        var lv = resolveServerLevel(dimId)
        if (lv == null) return null
        var ix = Math.floor(bx), iy = Math.floor(by), iz = Math.floor(bz)
        if (!isBlockChunkLoaded(lv, ix, iz)) return null
        return (typeof lv.getBlock === 'function') ? lv.getBlock(ix, iy, iz) : null
    }

    var isBlockPoweredAt = (dimId, bx, by, bz) => {
        var lv = resolveServerLevel(dimId)
        if (lv == null) return false
        var ix = Math.floor(bx), iy = Math.floor(by), iz = Math.floor(bz)
        if (!isBlockChunkLoaded(lv, ix, iz)) return false
        var b = (typeof lv.getBlock === 'function') ? lv.getBlock(ix, iy, iz) : null
        if (b != null) {
            if (typeof b.getIndirectPower === 'function' && Number(b.getIndirectPower()) > 0) return true
            if (b.indirectPower != null && Number(b.indirectPower) > 0) return true
        }
        return Boolean(BlockPosClass != null && typeof lv.hasNeighborSignal === 'function'
            && lv.hasNeighborSignal(new BlockPosClass(ix, iy, iz)))
    }

    var deriveBlockAnchorKey = (dimId, bx, by, bz, soundId) => {
        var base = `block@${dimId || 'minecraft:overworld'}:${Math.floor(bx)},${Math.floor(by)},${Math.floor(bz)}`
        return soundId ? `${base}#${soundId}` : base
    }

    var deriveEntityAnchorKey = (uuidStr, soundId) => {
        var base = `entity@${uuidStr}`
        return soundId ? `${base}#${soundId}` : base
    }

    var onlinePlayers = () => {
        if (serverRef == null) return []
        if (typeof serverRef.getPlayerList === 'function') {
            var pl = serverRef.getPlayerList()
            if (pl != null && typeof pl.getPlayers === 'function') return toJsArray(pl.getPlayers())
        }
        return serverRef.players != null ? toJsArray(serverRef.players) : []
    }

    var findPlayerByName = (name) => {
        var target = String(name).trim().toLowerCase()
        for (var p of onlinePlayers()) {
            if (nameOf(p).toLowerCase() === target) return p
        }
        return null
    }

    var getActiveEntityFromLevel = (lv, uuidObj) => {
        if (lv == null || typeof lv.getEntity !== 'function') return null
        var e = lv.getEntity(uuidObj)
        return (e != null && (typeof e.isRemoved !== 'function' || !e.isRemoved())) ? e : null
    }

    var findEntityByUuid = (uuidStr, preferDim, levelMap) => {
        if (UUIDClass == null || !uuidStr) return null
        var uuidObj = null
        try {
            uuidObj = UUIDClass.fromString(String(uuidStr))
        } catch (eUuid) {
            return null
        }
        if (uuidObj == null) return null

        if (preferDim && levelMap && levelMap[preferDim]) {
            var prefEnt = getActiveEntityFromLevel(levelMap[preferDim], uuidObj)
            if (prefEnt != null) return prefEnt
        }

        for (var lv of allLevels()) {
            if (preferDim && dimOfLevel(lv) === preferDim && levelMap && levelMap[preferDim]) continue
            var ent = getActiveEntityFromLevel(lv, uuidObj)
            if (ent != null) return ent
        }
        return null
    }

    var collectPlayerUuids = (src) => {
        var items = (typeof src === 'string' || isEntity(src)) ? [src] : toJsArray(src)
        var uuids = {}
        var count = 0
        var missing = []
        for (var it of items) {
            if (it == null) continue
            var p = typeof it === 'string' ? findPlayerByName(it) : it
            var u = isPlayer(p) ? uuidOf(p) : ((typeof it === 'string' && it.includes('-')) ? it.toLowerCase() : null)
            if (u == null) {
                missing.push(String(it))
                continue
            }
            if (!uuids[u]) {
                uuids[u] = true
                count++
            }
        }
        return { uuids: uuids, count: count, missing: missing }
    }

    // ======================================================================== 网络发送与事件分发

    var sendPacket = (player, pkt) => {
        if (player == null || pkt == null) return false
        if (pkt.proto == null) pkt.proto = PROTO_VERSION
        try {
            player.sendData(CHANNEL, pkt)
            return true
        } catch (e) {
            reportCatch('sendPacket', e)
            return false
        }
    }

    var safeCall = (fn, args, label) => {
        if (typeof fn !== 'function') return false
        try {
            return fn.apply(null, args)
        } catch (e) {
            reportWarning(label || 'callback', String(e))
            return false
        }
    }

    var handleInfo = (h) => {
        if (h == null) return null
        var a = h.anchor
        return {
            id:           h.id,
            key:          h.key,
            tag:          h.tag,
            group:        h.group,
            priority:     h.priority,
            lifeMode:     h.lifeMode,
            sound:        h.sound,
            category:     h.category,
            volume:       h.volume,
            pitch:        h.pitch,
            range:        h.range,
            falloff:      h.falloff,
            loop:         h.loop,
            duckMusic:    h.duckMusic,
            lateJoin:     h.lateJoin,
            fadeIn:       h.fadeIn,
            fadeOut:      h.fadeOut,
            anchor:       a.kind,
            audience:     h.audience.kind,
            dim:          a.kind !== 'none' ? a.dim : h.audience.dim,
            x:            a.x,
            y:            a.y,
            z:            a.z,
            entityUuid:   a.uuid || null,
            blockId:      a.blockId || null,
            listeners:    h.listenerCount,
            triggerCount: h.triggerCount,
            waitingStart: !h.started,
            ageTicks:     max2(0, tickCounter - h.bornTick)
        }
    }

    var emit = (type, h, extra1, extra2) => {
        var info = handleInfo(h)
        if (h.callbacks) {
            if (type === 'start' && typeof h.callbacks.onStart === 'function') safeCall(h.callbacks.onStart, [info], 'onStart')
            if (type === 'join'  && typeof h.callbacks.onJoin  === 'function') safeCall(h.callbacks.onJoin,  [extra1, info], 'onJoin')
            if (type === 'leave' && typeof h.callbacks.onLeave === 'function') safeCall(h.callbacks.onLeave, [extra1, info, extra2], 'onLeave')
            if (type === 'end'   && typeof h.callbacks.onEnd   === 'function') safeCall(h.callbacks.onEnd,   [info, extra1], 'onEnd')
        }
        var list = listenersGlobal[type]
        if (list && list.length > 0) {
            for (var fn of list) {
                safeCall(fn, [info, extra1, extra2], `on:${type}`)
            }
        }
    }

    var on = (eventType, fn) => {
        var t = String(eventType || '').trim().toLowerCase()
        if (!listenersGlobal[t] || typeof fn !== 'function') return false
        listenersGlobal[t].push(fn)
        return true
    }

    // ======================================================================== 锚点与句柄构建

    var anchorFromEntity = (e) => {
        if (!isEntity(e)) return null
        var u   = uuidOf(e)
        var pos = readPos(e)
        if (u == null || pos == null) return null
        return {
            kind:         'entity',
            uuid:         u,
            eid:          entityIdOf(e),
            isPlayer:     isPlayer(e),
            ref:          e,
            x:            pos.x,
            y:            pos.y,
            z:            pos.z,
            dim:          resolveDimId(levelOf(e)) || 'minecraft:overworld',
            missingTicks: 0
        }
    }

    var anchorFromBlock = (blockObj, levelOrDim) => {
        var pos = readPos(blockObj)
        if (pos == null) return null
        var lv  = levelOf(blockObj)
        var dim = (lv != null ? dimOfLevel(lv) : resolveDimId(levelOrDim)) || 'minecraft:overworld'
        var bx  = Math.floor(pos.x), by = Math.floor(pos.y), bz = Math.floor(pos.z)
        var blockId = extractBlockId(blockObj)
        if (!blockId) {
            blockId = extractBlockId(queryBlockAt(dim, bx, by, bz))
        }
        return {
            kind:    'block',
            bx:      bx,
            by:      by,
            bz:      bz,
            x:       bx + 0.5,
            y:       by + 0.5,
            z:       bz + 0.5,
            dim:     dim,
            blockId: blockId
        }
    }

    var anchorFromPos = (src, levelOrDim, centerOnBlock) => {
        var pos = readPos(src)
        if (pos == null) return null
        var dim = null
        if (!Array.isArray(src) && isObjectLike(src)) {
            var ownLevel = levelOf(src)
            if (ownLevel != null) dim = dimOfLevel(ownLevel)
            var dimProp = safeReadProp(src, 'dim')
            if (dim == null && dimProp != null) dim = resolveDimId(dimProp)
            var dimensionProp = safeReadProp(src, 'dimension')
            if (dim == null && dimensionProp != null) dim = resolveDimId(dimensionProp)
        }
        if (dim == null) dim = resolveDimId(levelOrDim)
        if (dim == null) return null
        var off = centerOnBlock ? 0.5 : 0.0
        return {
            kind: centerOnBlock ? 'block' : 'pos',
            bx:   Math.floor(pos.x),
            by:   Math.floor(pos.y),
            bz:   Math.floor(pos.z),
            x:    pos.x + off,
            y:    pos.y + off,
            z:    pos.z + off,
            dim:  dim
        }
    }

    var fail = (msg) => ({ error: msg })

    var buildHandle = (spec) => {
        if (!isObjectLike(spec)) {
            return fail('调用时必须传入音频配置对象 spec')
        }
        var rawSound = spec.sound != null ? spec.sound : (spec.soundId != null ? spec.soundId : spec.id)
        var sound    = normalizeSoundId(rawSound)
        if (sound == null) {
            return fail(`缺少有效的音频 ID (sound)，需为 namespace:path 格式，收到: ${rawSound}`)
        }

        var anchor    = { kind: 'none', x: 0, y: 0, z: 0, dim: null }
        var entitySrc = spec.entity != null ? spec.entity : spec.follow
        if (entitySrc != null) {
            anchor = anchorFromEntity(entitySrc)
            if (anchor == null) return fail('entity 不是有效的实体对象')
        } else if (spec.block != null) {
            anchor = anchorFromBlock(spec.block, spec.level != null ? spec.level : spec.dim)
            if (anchor == null) return fail('block 无法解析出有效的方块坐标与维度')
        } else if (spec.at != null || spec.pos != null) {
            var posInput = spec.at != null ? spec.at : spec.pos
            if (isBlockContainer(posInput)) {
                anchor = anchorFromBlock(posInput, spec.level != null ? spec.level : spec.dim)
            } else {
                anchor = anchorFromPos(posInput, spec.level != null ? spec.level : spec.dim, parseBool(spec.blockCenter, false))
            }
            if (anchor == null) return fail('at/pos 无法解析出有效坐标与维度（坐标锚点必须指定 dim 或 level）')
        } else if (spec.x != null && spec.y != null && spec.z != null && (spec.dim != null || spec.level != null)) {
            anchor = anchorFromPos([spec.x, spec.y, spec.z], spec.level != null ? spec.level : spec.dim, parseBool(spec.blockCenter, false))
            if (anchor == null) return fail('x/y/z 或 dim/level 无效')
        }

        var audKind = spec.audience != null ? String(spec.audience).trim().toLowerCase() : null
        if (audKind === 'player' || audKind === 'whitelist' || audKind === 'specific') audKind = 'players'
        if (audKind === 'dimension' || audKind === 'world') audKind = 'dim'
        if (audKind === 'broadcast' || audKind === 'global' || audKind === '*') audKind = 'all'
        if (audKind != null && !AUDIENCES.has(audKind)) {
            return fail(`audience 仅支持 near / self / players / dim / all，收到: ${spec.audience}`)
        }

        var playersSrc = spec.players != null ? spec.players : (spec.player != null ? spec.player : spec.whitelist)
        var playerCol  = playersSrc != null ? collectPlayerUuids(playersSrc) : null

        if (audKind == null) {
            if (playerCol != null) audKind = 'players'
            else if (anchor.kind !== 'none') audKind = 'near'
            else if (spec.dim != null || spec.level != null) audKind = 'dim'
            else return fail("未指定目标范围：请提供 at / block / entity / players / dim 之一，或显式声明 audience:'all'")
        }

        var audience = {
            kind:   audKind,
            uuids:  playerCol != null ? playerCol.uuids : null,
            dim:    null,
            filter: typeof spec.filter === 'function' ? spec.filter : (typeof spec.canHear === 'function' ? spec.canHear : null)
        }

        if (audKind === 'players') {
            if (playerCol == null || playerCol.count === 0) {
                return fail(`players 列表中没有找到在线玩家${playerCol && playerCol.missing.length > 0 ? ` (未找到: ${playerCol.missing.join(', ')})` : ''}`)
            }
        } else if (audKind === 'self') {
            if (anchor.kind !== 'entity' || !anchor.isPlayer) {
                return fail("audience:'self' 要求锚点 entity 必须为玩家")
            }
        } else if (audKind === 'near') {
            if (anchor.kind === 'none') {
                return fail("audience:'near' 必须绑定坐标 (at/pos)、方块 (block) 或实体 (entity) 锚点")
            }
        } else if (audKind === 'dim') {
            audience.dim = anchor.kind !== 'none' ? anchor.dim : resolveDimId(spec.dim != null ? spec.dim : spec.level)
            if (audience.dim == null) {
                return fail("audience:'dim' 无法确定目标维度")
            }
        }

        var falloff = null
        var rawFalloff = spec.falloff != null ? spec.falloff : spec.mode
        if (rawFalloff != null) {
            falloff = String(rawFalloff).trim().toLowerCase()
            if (!FALLOFFS.has(falloff)) return fail(`falloff 仅支持 linear / smooth / cutoff / flat，收到: ${rawFalloff}`)
        } else {
            falloff = (anchor.kind !== 'none' && audKind !== 'self' && audKind !== 'all') ? 'linear' : 'flat'
        }
        if (anchor.kind === 'none') falloff = 'flat'

        var category = normalizeCategory(spec.category != null ? spec.category : spec.cat)
        if (category == null) return fail(`category 音频通道无效: ${spec.category || spec.cat}`)

        var lifeModeRaw  = spec.lifeMode != null ? String(spec.lifeMode).trim().toLowerCase() : ''
        var isActiveMode = (lifeModeRaw === 'active' || lifeModeRaw === 'sustain' || lifeModeRaw === 'continuous' || parseBool(spec.continuous, false))
        var loop         = parseBool(spec.loop, isActiveMode || lifeModeRaw === 'loop')
        var lifeMode     = isActiveMode ? 'active' : (loop ? 'loop' : 'once')

        var durationTicks = spec.durationSeconds != null
            ? parseTicks(parseFiniteNum(spec.durationSeconds, 0) * 20, false)
            : parseTicks(spec.duration != null ? spec.duration : spec.stay, false)
        if ((spec.duration != null || spec.durationSeconds != null) && durationTicks == null) {
            return fail(`duration 时长格式无效: ${spec.duration != null ? spec.duration : spec.durationSeconds}`)
        }

        var lifetimeTicks = parseTicks(spec.lifetime, false)
        if (spec.lifetime != null && lifetimeTicks == null) {
            return fail(`lifetime 时长格式无效: ${spec.lifetime}`)
        }

        var activeHoldTicks = parseTicks(spec.activeHold != null ? spec.activeHold : spec.holdTicks, false) || CONFIG.defaultActiveHold
        var delayTicks      = parseTicks(spec.delay != null ? spec.delay : spec.startDelay, true) || 0
        var fadeInTicks     = parseTicks(spec.fadeIn, true) || 0
        var fadeOutTicks    = parseTicks(spec.fadeOut, true) || 0

        var explicitKey = normalizeKey(spec.key)
        if (spec.key != null && explicitKey == null) {
            return fail(`key 长度必须在 1~${CONFIG.maxKeyLength} 之间`)
        }
        var autoKey = explicitKey
        if (autoKey == null) {
            if (anchor.kind === 'block') {
                autoKey = deriveBlockAnchorKey(anchor.dim, anchor.bx, anchor.by, anchor.bz, sound)
            } else if (anchor.kind === 'entity' && (loop || isActiveMode)) {
                autoKey = deriveEntityAnchorKey(anchor.uuid, sound)
            }
        }

        var groupStr = String(spec.group != null && spec.group !== '' ? spec.group : (spec.tag != null && spec.tag !== '' ? spec.tag : 'default'))
        var tagStr   = spec.tag != null ? String(spec.tag) : groupStr
        var defPri   = isActiveMode ? 5 : (loop ? 3 : 2)
        var priority = parsePriority(spec.priority != null ? spec.priority : spec.importance, defPri)

        var excluded = {}
        if (spec.exclude != null) {
            var ex = collectPlayerUuids(spec.exclude)
            for (var u of Object.keys(ex.uuids)) excluded[u] = true
        }

        var startConditions = {
            delayUntilTick:  delayTicks > 0 ? (tickCounter + delayTicks) : 0,
            startOnEnter:    parseBool(spec.startOnEnter, false),
            requireRedstone: parseBool(spec.requireRedstone, false),
            predicate:       typeof spec.startWhen === 'function' ? spec.startWhen : null
        }

        var isBlockAnchor = (anchor.kind === 'block')
        var stopConditions = {
            stopOnBlockBreak:  parseBool(spec.stopOnBlockBreak, isBlockAnchor && loop),
            stopOnRedstoneOff: parseBool(spec.stopOnRedstoneOff, false),
            stopOnEntityDeath: parseBool(spec.stopOnEntityDeath, false),
            stopWhenEmpty:     parseBool(spec.stopWhenEmpty, false),
            maxTriggers:       max2(0, Math.round(parseFiniteNum(spec.maxTriggers != null ? spec.maxTriggers : spec.maxListeners, 0))),
            predicate:         typeof spec.stopWhen === 'function' ? spec.stopWhen : null
        }

        var hasStartGate = (startConditions.delayUntilTick > tickCounter) ||
                             startConditions.startOnEnter ||
                             startConditions.requireRedstone ||
                             (startConditions.predicate != null)
        var unstartedWaitTicks = 0
        if (hasStartGate) {
            var rawWait = spec.startTimeout !== undefined ? spec.startTimeout : spec.maxWaitTicks
            if (rawWait !== undefined) {
                var parsedWait = parseTicks(rawWait, false)
                unstartedWaitTicks = (parsedWait != null && parsedWait > 0) ? parsedWait : 0
            } else {
                unstartedWaitTicks = max2(0, CONFIG.unstartedTimeoutTicks || 0)
            }
        }

        var effectiveSpanTicks = isActiveMode
            ? activeHoldTicks
            : (loop
                ? (lifetimeTicks != null ? lifetimeTicks : 0)
                : (durationTicks != null ? durationTicks : CONFIG.defaultOneShotTicks))

        var sourceTier = (spec._sourceTier === 'player') ? 'player' : 'system'
        var ownerUuid  = (sourceTier === 'player' && spec._ownerUuid != null)
            ? String(spec._ownerUuid).trim().toLowerCase()
            : ''
        if (sourceTier === 'player') {
            priority = min2(priority, CONFIG.playerMaxPriority)
            if (autoKey != null && ownerUuid) {
                var uPrefix = `u:${ownerUuid}:`
                if (autoKey.indexOf(uPrefix) !== 0) {
                    autoKey = `${uPrefix}${autoKey}`
                    if (autoKey.length > CONFIG.maxKeyLength) {
                        autoKey = autoKey.slice(0, CONFIG.maxKeyLength)
                    }
                }
            }
        }

        return {
            handle: {
                id:              0,
                key:             autoKey,
                explicitKey:     explicitKey != null,
                sourceTier:      sourceTier,
                ownerUuid:       ownerUuid,
                tag:             tagStr,
                group:           groupStr,
                priority:        priority,
                lifeMode:        lifeMode,
                sound:           sound,
                category:        category,
                volume:          clampNum(parseFiniteNum(spec.volume != null ? spec.volume : spec.vol, 1.0), 0.0, 2.0),
                pitch:           clampNum(parseFiniteNum(spec.pitch != null ? spec.pitch : spec.pit, 1.0), 0.5, 2.0),
                range:           clampNum(parseFiniteNum(spec.range != null ? spec.range : spec.radius, CONFIG.defaultRange), CONFIG.minRange, CONFIG.maxRange),
                falloff:         falloff,
                loop:            loop,
                outOfRangeMode:  (spec.restartOnEnter === true || String(spec.outOfRangeMode || '').toLowerCase() === 'stop') ? 'stop' : (spec.outOfRangeMode === 'mute' || loop ? 'mute' : 'stop'),
                keepAliveRange:  clampNum(parseFiniteNum(spec.keepAliveRange, max2(CONFIG.defaultRange * 2.5, (parseFiniteNum(spec.range != null ? spec.range : spec.radius, CONFIG.defaultRange)) + 48)), 16, 1024),
                conflictMode:       normalizeConflictMode(spec.conflictMode, 'none'),
                conflictScope:      String(spec.conflictScope || 'sound').toLowerCase(),
                mutedListeners:     {},
                listenerEnteredSeq: {},
                listenerInRange:    {},
                listenerInRangeSeq: {},
                resume:          parseBool(spec.resume, true),
                duckMusic:       parseBool(spec.duckMusic != null ? spec.duckMusic : spec.duck, loop && (category === 'RECORDS' || category === 'MUSIC')),
                lateJoin:        parseBool(spec.lateJoin, loop),
                fadeIn:          fadeInTicks,
                fadeOut:         fadeOutTicks,
                anchor:          anchor,
                audience:        audience,
                excluded:        excluded,
                listeners:       {},
                listenerCount:   0,
                triggerCount:    0,
                hadListenerOnce: false,
                bornTick:            tickCounter,
                activeHoldTicks:     activeHoldTicks,
                spanTicks:           effectiveSpanTicks,
                endTick:             (!hasStartGate && effectiveSpanTicks > 0) ? (tickCounter + effectiveSpanTicks) : 0,
                unstartedExpireTick: (hasStartGate && unstartedWaitTicks > 0) ? (tickCounter + unstartedWaitTicks) : 0,
                graceTicks:          max2(0, parseFiniteNum(spec.anchorGraceTicks, CONFIG.anchorGraceTicks)),
                endWithAnchor:   parseBool(spec.endWithAnchor, true),
                startCond:       startConditions,
                stopCond:        stopConditions,
                started:         false,
                sentEid:         anchor.eid,
                sentDim:         anchor.dim,
                callbacks: {
                    onStart: spec.onStart,
                    onJoin:  spec.onJoin,
                    onLeave: spec.onLeave,
                    onEnd:   spec.onEnd
                }
            }
        }
    }

    // ======================================================================== 玩家快照、条件评估与同步

    var snapshotPlayers = () => {
        var list = []
        var byUuid = {}
        var byDim = {}
        var levelMap = {}
        for (var p of onlinePlayers()) {
            var uuid = uuidOf(p)
            if (uuid == null) continue
            var lv  = levelOf(p)
            var dim = resolveDimId(lv) || 'minecraft:overworld'
            if (lv != null && !levelMap[dim]) levelMap[dim] = lv
            var pos = readPos(p)
            var rec = {
                p:    p,
                uuid: uuid,
                dim:  dim,
                x:    pos != null ? pos.x : 0,
                y:    pos != null ? pos.y : 0,
                z:    pos != null ? pos.z : 0,
                eid:  entityIdOf(p)
            }
            list.push(rec)
            byUuid[uuid] = rec
            if (!byDim[dim]) byDim[dim] = []
            byDim[dim].push(rec)
        }
        return { list: list, byUuid: byUuid, byDim: byDim, levelMap: levelMap }
    }

    var refreshEntityAnchor = (a, snap) => {
        if (a.isPlayer) {
            var rec = snap.byUuid[a.uuid]
            if (rec == null) return false
            a.ref = rec.p; a.x = rec.x; a.y = rec.y; a.z = rec.z; a.dim = rec.dim; a.eid = rec.eid
            return true
        }
        var isEntityActive = (e) => e != null
            && (typeof e.isRemoved !== 'function' || !e.isRemoved())
            && (typeof e.isAlive !== 'function' || e.isAlive())
        var ent = a.ref
        if (!isEntityActive(ent)) {
            ent = findEntityByUuid(a.uuid, a.dim, snap.levelMap)
            a.ref = ent
        }
        if (!isEntityActive(ent)) return false
        var pos = readPos(ent)
        if (pos == null) return false
        a.x   = pos.x
        a.y   = pos.y
        a.z   = pos.z
        a.dim = resolveDimId(levelOf(ent)) || a.dim
        a.eid = entityIdOf(ent)
        return true
    }

    var getClusterSourceLim = (h, src, alreadyListening) => {
        if (!alreadyListening) return src.range
        return h.outOfRangeMode === 'mute'
            ? max2(src.range + CONFIG.rangeHysteresis, h.keepAliveRange)
            : (src.range + CONFIG.rangeHysteresis)
    }

    var pickClusterSourceForPlayer = (h, rec, alreadyListening) => {
        var sources = h.clusterSources
        if (!Array.isArray(sources) || sources.length === 0) return null
        var inRange = false
        var best = null
        var bestDistSq = Infinity
        var curKey = (h.listenerAnchorKey && rec.uuid != null) ? h.listenerAnchorKey[rec.uuid] : null
        var curSrc = null
        var curDistSq = Infinity
        for (var i = 0; i < sources.length; i++) {
            var s = sources[i]
            if (s == null || s.dim !== rec.dim) continue
            var dx = rec.x - s.cx, dy = rec.y - s.cy, dz = rec.z - s.cz
            var dSq = dx * dx + dy * dy + dz * dz
            var lim = getClusterSourceLim(h, s, alreadyListening)
            if (dSq <= lim * lim) inRange = true
            if (best == null || dSq < bestDistSq - 0.01 || (Math.abs(dSq - bestDistSq) <= 0.01 && s.seq < best.seq)) {
                best = s
                bestDistSq = dSq
            }
            if (curKey != null && s.audioKey === curKey) {
                curSrc = s
                curDistSq = dSq
            }
        }
        // 迟滞防抖：若当前跟随方块仍存活在集群内，仅当另一方块显著更近 (>1.0 格²) 时才切换更新包，避免边界微步来回跳变
        var chosen = best
        if (curSrc != null && best != null && best.audioKey !== curSrc.audioKey && (bestDistSq + 1.0) >= curDistSq) {
            chosen = curSrc
        }
        return { inRange: inRange, best: best, bestDistSq: bestDistSq, chosen: chosen }
    }

    var isPlayerEligible = (h, rec, alreadyListening) => {
        if (h.excluded[rec.uuid]) return false
        var a   = h.anchor
        var aud = h.audience

        if (aud.kind === 'self' && rec.uuid !== a.uuid) return false
        if (aud.kind === 'players' && (!aud.uuids || !aud.uuids[rec.uuid])) return false
        if (aud.kind === 'dim' && rec.dim !== aud.dim) return false
        if (aud.uuids != null && !aud.uuids[rec.uuid]) return false

        if (a.kind !== 'none' && aud.kind !== 'all') {
            if (rec.dim !== a.dim) return false
            if (aud.kind !== 'dim') {
                if (h.isMergedCluster && Array.isArray(h.clusterSources) && h.clusterSources.length > 0) {
                    if (!pickClusterSourceForPlayer(h, rec, alreadyListening).inRange) return false
                } else {
                    var lim = alreadyListening
                        ? (h.outOfRangeMode === 'mute' ? max2(h.range + CONFIG.rangeHysteresis, h.keepAliveRange) : (h.range + CONFIG.rangeHysteresis))
                        : h.range
                    var dx = rec.x - a.x, dy = rec.y - a.y, dz = rec.z - a.z
                    if ((dx * dx + dy * dy + dz * dz) > (lim * lim)) return false
                }
            }
        }

        if (aud.filter != null) {
            if (!safeCall(aud.filter, [rec.p, handleInfo(h)], 'audience.filter')) return false
        }
        return true
    }

    var getCandidateListForHandle = (h, snap) => {
        var a   = h.anchor
        var aud = h.audience
        if (a.kind !== 'none' && aud.kind !== 'all') {
            return snap.byDim[a.dim] || []
        }
        if (aud.kind === 'dim' && aud.dim != null) {
            return snap.byDim[aud.dim] || []
        }
        return snap.list
    }

    var hasAnyEligibleCandidate = (h, snap) => {
        for (var cand of getCandidateListForHandle(h, snap)) {
            if (isPlayerEligible(h, cand, false)) return true
        }
        return false
    }

    var checkStartConditionMet = (h, snap) => {
        var sc = h.startCond
        if (sc.delayUntilTick > 0 && tickCounter < sc.delayUntilTick) return false

        var a = h.anchor
        if (a.kind === 'entity' && !refreshEntityAnchor(a, snap)) return false
        if (sc.requireRedstone && a.kind === 'block' && !isBlockPoweredAt(a.dim, a.bx, a.by, a.bz)) return false
        if (sc.startOnEnter && !hasAnyEligibleCandidate(h, snap)) return false
        if (sc.predicate != null) {
            if (!safeCall(sc.predicate, [handleInfo(h), { server: serverRef, tick: tickCounter }], 'startWhen')) return false
        }
        return true
    }

    var checkStopConditionTriggered = (h, skipPredicate) => {
        var tc = h.stopCond
        var a  = h.anchor

        if (a.kind === 'block') {
            if (tc.stopOnBlockBreak && a.blockId) {
                if (h.isMergedCluster && Array.isArray(h.clusterSources) && h.clusterSources.length > 0) {
                    var brokenKeys = []
                    var aliveCount = 0
                    for (var ci = 0; ci < h.clusterSources.length; ci++) {
                        var cs = h.clusterSources[ci]
                        var cb = queryBlockAt(cs.dim, cs.bx, cs.by, cs.bz)
                        var cid = extractBlockId(cb)
                        if (cid != null && cid !== cs.blockId) {
                            brokenKeys.push(cs.audioKey)
                        } else {
                            aliveCount++
                        }
                    }
                    if (brokenKeys.length > 0) {
                        for (var bi = 0; bi < brokenKeys.length; bi++) {
                            removeBoundMergeSource(brokenKeys[bi])
                        }
                        if (aliveCount === 0) return 'block_broken'
                        reconcileAudioMergeScope(h.mergeScopeKey, null, h.fadeOut, h.id)
                        return null
                    }
                } else {
                    var curBlock = queryBlockAt(a.dim, a.bx, a.by, a.bz)
                    var curId    = extractBlockId(curBlock)
                    if (curId != null && curId !== a.blockId) {
                        return 'block_broken'
                    }
                }
            }
            if (tc.stopOnRedstoneOff && !isBlockPoweredAt(a.dim, a.bx, a.by, a.bz)) {
                return 'redstone_off'
            }
        }

        if (tc.maxTriggers > 0 && h.triggerCount >= tc.maxTriggers) return 'max_triggers'
        if (tc.stopWhenEmpty && h.hadListenerOnce && h.listenerCount === 0) return 'empty_listeners'

        if (!skipPredicate && tc.predicate != null) {
            if (safeCall(tc.predicate, [handleInfo(h), { server: serverRef, tick: tickCounter }], 'stopWhen')) {
                return 'condition_met'
            }
        }
        return null
    }

    var buildPlayPacket = (h, restartClient, srcOverride) => {
        var a = h.anchor
        var pkt = {
            proto:  PROTO_VERSION,
            act:    'play',
            ses:    SESSION,
            h:      h.id,
            tier:   h.sourceTier === 'player' ? 'player' : 'system',
            pri:    h.priority != null ? h.priority : 2,
            snd:    h.sound,
            cat:    h.category,
            vol:    h.volume,
            pit:    h.pitch,
            loop:   h.loop ? 1 : 0,
            mode:   h.falloff,
            omode:  h.outOfRangeMode || 'stop',
            resume: h.resume ? 1 : 0,
            duck:   h.duckMusic ? 1 : 0,
            fin:    h.fadeIn,
            fout:   h.fadeOut,
            rst:    restartClient === false ? 0 : 1,
            anc:    a.kind === 'block' ? 'pos' : a.kind
        }
        if (srcOverride != null) {
            pkt.x   = srcOverride.cx
            pkt.y   = srcOverride.cy
            pkt.z   = srcOverride.cz
            pkt.rng = srcOverride.range
            if (srcOverride.dim != null) pkt.dim = srcOverride.dim
        } else if (a.kind !== 'none') {
            pkt.x   = a.x
            pkt.y   = a.y
            pkt.z   = a.z
            pkt.rng = h.range
            if (a.dim != null) pkt.dim = a.dim
            if (a.kind === 'entity' && a.eid != null) pkt.eid = a.eid
        } else if (h.audience.kind === 'dim' && h.audience.dim != null) {
            pkt.dim = h.audience.dim
        }
        return pkt
    }

    var buildUpdatePacket = (h, srcOverride) => {
        var a = h.anchor
        var pkt = {
            proto: PROTO_VERSION,
            act:   'update',
            ses:   SESSION,
            h:    h.id,
            vol:  h.volume,
            pit:  h.pitch,
            rng:  srcOverride != null ? srcOverride.range : h.range,
            fout: h.fadeOut
        }
        if (srcOverride != null) {
            pkt.x = srcOverride.cx
            pkt.y = srcOverride.cy
            pkt.z = srcOverride.cz
        } else if (a.kind !== 'none') {
            pkt.x = a.x
            pkt.y = a.y
            pkt.z = a.z
            if (a.kind === 'entity' && a.eid != null) pkt.eid = a.eid
        }
        return pkt
    }

    var setClusterListenerTarget = (h, uuid, src) => {
        if (src == null) return
        if (!h.listenerAnchorKey) h.listenerAnchorKey = {}
        if (!h.listenerSentPos) h.listenerSentPos = {}
        h.listenerAnchorKey[uuid] = src.audioKey
        h.listenerSentPos[uuid]   = { x: src.cx, y: src.cy, z: src.cz, r: src.range }
    }

    var needsClusterAnchorUpdate = (h, uuid, src) => {
        if (src == null) return false
        var prev = h.listenerSentPos ? h.listenerSentPos[uuid] : null
        if (prev == null) return true
        return prev.x !== src.cx || prev.y !== src.cy || prev.z !== src.cz || prev.r !== src.range
    }

    var buildStopPacket = (h, customFadeOutTicks) => {
        var fout = (customFadeOutTicks != null && isFinite(customFadeOutTicks) && customFadeOutTicks >= 0)
            ? Math.round(customFadeOutTicks)
            : h.fadeOut
        return { proto: PROTO_VERSION, act: 'stop', ses: SESSION, h: h.id, fout: fout }
    }

    var findOtherCountedMergeSibling = (h, uuid) => {
        var sk = getConflictScopeKey(h)
        for (var other of handles.values()) {
            if (other == null || other.id === h.id) continue
            if (other.conflictMode !== 'merge') continue
            if (getConflictScopeKey(other) !== sk) continue
            if (other.listeners && other.listeners[uuid] && other.countedListeners && other.countedListeners[uuid]) {
                return other
            }
        }
        return null
    }

    var findOtherActiveMergeSibling = (h, uuid) => {
        var sk = getConflictScopeKey(h)
        for (var other of handles.values()) {
            if (other == null || other.id === h.id) continue
            if (other.conflictMode !== 'merge') continue
            if (getConflictScopeKey(other) !== sk) continue
            if (other.listeners && other.listeners[uuid]) return other
        }
        return null
    }

    var addListener = (h, rec) => {
        h.listeners[rec.uuid] = true
        var seq = ++listenerTriggerSeq
        if (!h.listenerEnteredSeq) h.listenerEnteredSeq = {}
        if (!h.listenerInRange) h.listenerInRange = {}
        if (!h.listenerInRangeSeq) h.listenerInRangeSeq = {}
        if (!h.countedListeners) h.countedListeners = {}
        h.listenerEnteredSeq[rec.uuid] = seq
        var inOwnRange = false
        if (h.anchor.kind === 'none') {
            inOwnRange = true
        } else if (h.isMergedCluster && Array.isArray(h.clusterSources) && h.clusterSources.length > 0) {
            var initPick = pickClusterSourceForPlayer(h, rec, false)
            inOwnRange = (initPick != null && initPick.best != null && initPick.bestDistSq <= initPick.best.range * initPick.best.range)
        } else {
            inOwnRange = (distSqToHandle(rec, h) <= h.range * h.range)
        }
        h.listenerInRange[rec.uuid] = inOwnRange
        if (inOwnRange) h.listenerInRangeSeq[rec.uuid] = seq
        h.listenerCount++
        h.triggerCount++
        h.hadListenerOnce = true
        // merge 集群对同一玩家仅计为 1 次并发句柄，避免多方块叠加耗尽 maxHandlesPerPlayer
        var alreadyCountedInCluster = (h.conflictMode === 'merge' && findOtherCountedMergeSibling(h, rec.uuid) != null)
        if (!alreadyCountedInCluster) {
            h.countedListeners[rec.uuid] = true
            listenCount.set(rec.uuid, (listenCount.get(rec.uuid) || 0) + 1)
        } else {
            h.countedListeners[rec.uuid] = false
        }
        emit('join', h, rec.p)
    }

    var releasePlayerListenCount = (h, uuid) => {
        var wasCounted = Boolean(h.countedListeners && h.countedListeners[uuid])
        if (h.countedListeners) delete h.countedListeners[uuid]
        if (!wasCounted) return
        var nextOwner = (h.conflictMode === 'merge') ? findOtherActiveMergeSibling(h, uuid) : null
        if (nextOwner != null) {
            if (!nextOwner.countedListeners) nextOwner.countedListeners = {}
            nextOwner.countedListeners[uuid] = true
        } else if (listenCount.has(uuid)) {
            var next = listenCount.get(uuid) - 1
            if (next <= 0) listenCount.delete(uuid)
            else listenCount.set(uuid, next)
        }
    }

    var removeListener = (h, uuid, rec, reason, customFadeOut) => {
        if (!h.listeners[uuid]) return
        if (rec != null) {
            sendPacket(rec.p, buildStopPacket(h, customFadeOut))
        }
        delete h.listeners[uuid]
        if (h.mutedListeners) delete h.mutedListeners[uuid]
        if (h.listenerEnteredSeq) delete h.listenerEnteredSeq[uuid]
        if (h.listenerInRange) delete h.listenerInRange[uuid]
        if (h.listenerInRangeSeq) delete h.listenerInRangeSeq[uuid]
        if (h.listenerAnchorKey) delete h.listenerAnchorKey[uuid]
        if (h.listenerSentPos) delete h.listenerSentPos[uuid]
        h.listenerCount = max2(0, h.listenerCount - 1)
        releasePlayerListenCount(h, uuid)
        emit('leave', h, rec != null ? rec.p : null, reason)
    }

    var broadcastUpdateToListeners = (h, snap) => {
        var uuids = Object.keys(h.listeners)
        if (uuids.length === 0) return
        if (h.isMergedCluster && Array.isArray(h.clusterSources) && h.clusterSources.length > 0) {
            for (var u of uuids) {
                var rec = snap.byUuid[u]
                if (rec == null) continue
                var pick = pickClusterSourceForPlayer(h, rec, true)
                var src  = (pick && pick.chosen) ? pick.chosen : h.clusterSources[0]
                setClusterListenerTarget(h, u, src)
                sendPacket(rec.p, buildUpdatePacket(h, src))
            }
            return
        }
        var pkt = buildUpdatePacket(h)
        for (var u2 of uuids) {
            var rec2 = snap.byUuid[u2]
            if (rec2 != null) sendPacket(rec2.p, pkt)
        }
    }

    var resendPlayToListeners = (h, snap, restartFlag) => {
        var uuids = Object.keys(h.listeners)
        if (uuids.length === 0) return
        if (h.isMergedCluster && Array.isArray(h.clusterSources) && h.clusterSources.length > 0) {
            for (var u of uuids) {
                var rec = snap.byUuid[u]
                if (rec == null) continue
                var pick = pickClusterSourceForPlayer(h, rec, true)
                var src  = (pick && pick.chosen) ? pick.chosen : h.clusterSources[0]
                setClusterListenerTarget(h, u, src)
                sendPacket(rec.p, buildPlayPacket(h, restartFlag, src))
            }
            return
        }
        var pkt = buildPlayPacket(h, restartFlag)
        for (var u2 of uuids) {
            var rec2 = snap.byUuid[u2]
            if (rec2 != null) sendPacket(rec2.p, pkt)
        }
    }

    var syncHandle = (h, snap) => {
        var a = h.anchor

        if (a.kind === 'entity') {
            if (!refreshEntityAnchor(a, snap)) {
                a.missingTicks += h.started ? CONFIG.syncIntervalTicks : 0
                for (var u of Object.keys(h.listeners)) {
                    removeListener(h, u, snap.byUuid[u] || null, 'anchor_missing')
                }
                if (h.stopCond.stopOnEntityDeath || (h.endWithAnchor && a.missingTicks >= h.graceTicks)) {
                    endHandle(h, 'anchor_lost', snap)
                }
                return
            }
            a.missingTicks = 0
        }

        var stopReason = checkStopConditionTriggered(h)
        if (stopReason != null) {
            endHandle(h, stopReason, snap)
            return
        }
        if (!handles.has(h.id)) return

        var dimChanged = (a.kind === 'entity' && h.started && a.dim !== h.sentDim)
        var eidChanged = (a.kind === 'entity' && h.started && !dimChanged && a.eid !== h.sentEid)
        var isCluster  = Boolean(h.isMergedCluster && Array.isArray(h.clusterSources) && h.clusterSources.length > 0)

        for (var u of Object.keys(h.listeners)) {
            var rec = snap.byUuid[u]
            if (rec == null) {
                removeListener(h, u, null, 'offline')
            } else if (!isPlayerEligible(h, rec, true) && (isCluster || !(h.conflictMode === 'merge' && isPlayerInMergedClusterRange(h, rec)))) {
                removeListener(h, u, rec, 'out_of_scope')
            } else {
                if (isCluster) {
                    var clPick = pickClusterSourceForPlayer(h, rec, true)
                    var best   = clPick != null ? clPick.best : null
                    var chosen = clPick != null ? clPick.chosen : null
                    if (best != null) {
                        if (clPick.bestDistSq <= best.range * best.range) {
                            if (!h.listenerInRange) h.listenerInRange = {}
                            if (!h.listenerInRangeSeq) h.listenerInRangeSeq = {}
                            if (!h.listenerInRange[u]) {
                                h.listenerInRange[u] = true
                                h.listenerInRangeSeq[u] = ++listenerTriggerSeq
                            }
                        } else {
                            var clHys = best.range + CONFIG.rangeHysteresis
                            if (clPick.bestDistSq > clHys * clHys && h.listenerInRange) {
                                h.listenerInRange[u] = false
                            }
                        }
                    }
                    if (dimChanged && chosen != null) {
                        setClusterListenerTarget(h, u, chosen)
                        sendPacket(rec.p, buildPlayPacket(h, true, chosen))
                    } else if (chosen != null && (eidChanged || needsClusterAnchorUpdate(h, u, chosen))) {
                        setClusterListenerTarget(h, u, chosen)
                        sendPacket(rec.p, buildUpdatePacket(h, chosen))
                    }
                } else {
                    if (h.anchor.kind !== 'none') {
                        var dSq = distSqToHandle(rec, h)
                        if (dSq <= h.range * h.range) {
                            if (!h.listenerInRange) h.listenerInRange = {}
                            if (!h.listenerInRangeSeq) h.listenerInRangeSeq = {}
                            if (!h.listenerInRange[u]) {
                                h.listenerInRange[u] = true
                                h.listenerInRangeSeq[u] = ++listenerTriggerSeq
                            }
                        } else {
                            var hys = h.range + CONFIG.rangeHysteresis
                            if (dSq > hys * hys && h.listenerInRange) {
                                h.listenerInRange[u] = false
                            }
                        }
                    }
                    if (dimChanged) {
                        sendPacket(rec.p, buildPlayPacket(h, true))
                    } else if (eidChanged) {
                        sendPacket(rec.p, buildUpdatePacket(h))
                    }
                }
            }
        }

        if (h.lateJoin || !h.started) {
            var pkt = null
            for (var rec of getCandidateListForHandle(h, snap)) {
                if (h.listeners[rec.uuid]) continue
                var readyAt = loginReadyTick.get(rec.uuid)
                if (readyAt != null) {
                    if (tickCounter < readyAt) continue
                    loginReadyTick.delete(rec.uuid)
                }
                if (!isPlayerEligible(h, rec, false)) continue
                var isMergeSibling = (h.conflictMode === 'merge' && findOtherActiveMergeSibling(h, rec.uuid) != null)
                if (!isMergeSibling) {
                    var curListen = listenCount.get(rec.uuid) || 0
                    if (h.sourceTier === 'player') {
                        var playerTierCount = 0
                        for (var eh of handles.values()) {
                            if (eh != null && eh.sourceTier === 'player' && eh.listeners[rec.uuid] && eh.countedListeners && eh.countedListeners[rec.uuid]) {
                                playerTierCount++
                            }
                        }
                        if (playerTierCount >= CONFIG.maxPlayerHandlesPerListener) {
                            reportWarning('maxPlayerHandlesPerListener', `玩家 ${rec.name || rec.uuid} 的普通玩家层级收听槽位已达上限 (${CONFIG.maxPlayerHandlesPerListener}/${CONFIG.maxHandlesPerPlayer})，已跳过新增 #${h.id}`)
                            continue
                        }
                        if (curListen >= CONFIG.maxHandlesPerPlayer) {
                            reportWarning('maxHandlesPerPlayer', `玩家 ${rec.name || rec.uuid} 同时收听句柄数已达上限 (${CONFIG.maxHandlesPerPlayer})，已跳过新增音频 #${h.id}`)
                            continue
                        }
                    } else if (curListen >= CONFIG.maxHandlesPerPlayer) {
                        var listenerVictim = null
                        var lvScore = Infinity
                        for (var vh of handles.values()) {
                            if (vh != null && vh.sourceTier === 'player' && vh.listeners[rec.uuid] && vh.countedListeners && vh.countedListeners[rec.uuid]) {
                                var vs = (vh.priority || 2) * 1000000 + (vh.loop ? 500000 : 0) + (vh.bornTick % 500000)
                                if (vs < lvScore) {
                                    lvScore = vs
                                    listenerVictim = vh
                                }
                            }
                        }
                        if (listenerVictim != null) {
                            removeListener(listenerVictim, rec.uuid, rec, 'evicted_by_system')
                        } else {
                            reportWarning('maxHandlesPerPlayer', `玩家 ${rec.name || rec.uuid} 同时收听句柄数已达上限 (${CONFIG.maxHandlesPerPlayer})，已跳过新增音频 #${h.id}`)
                            continue
                        }
                    }
                }
                var joinPkt = null
                var joinSrc = null
                if (isCluster) {
                    var jPick = pickClusterSourceForPlayer(h, rec, false)
                    joinSrc = (jPick && jPick.chosen) ? jPick.chosen : h.clusterSources[0]
                    joinPkt = buildPlayPacket(h, true, joinSrc)
                } else {
                    if (pkt == null) pkt = buildPlayPacket(h, true)
                    joinPkt = pkt
                }
                if (sendPacket(rec.p, joinPkt)) {
                    if (isCluster && joinSrc != null) {
                        setClusterListenerTarget(h, rec.uuid, joinSrc)
                    }
                    addListener(h, rec)
                    if (h.stopCond.maxTriggers > 0 && h.triggerCount >= h.stopCond.maxTriggers) break
                }
            }
        }

        h.sentEid = a.eid
        h.sentDim = a.dim

        // 监听器列表更新后仅复检 maxTriggers / stopWhenEmpty，避免在同一周期内重复执行用户的 stopWhen 谓词
        var postStopReason = checkStopConditionTriggered(h, true)
        if (postStopReason != null) {
            endHandle(h, postStopReason, snap)
        }
    }

    var activateHandle = (h, snap) => {
        if (h.anchor.kind === 'entity') {
            if (!refreshEntityAnchor(h.anchor, snap)) {
                h.anchor.missingTicks += CONFIG.syncIntervalTicks
                if (h.stopCond.stopOnEntityDeath || (h.endWithAnchor && h.anchor.missingTicks >= h.graceTicks)) {
                    endHandle(h, 'anchor_lost', snap)
                    return false
                }
                if (h.unstartedExpireTick > 0 && tickCounter >= h.unstartedExpireTick) {
                    endHandle(h, 'start_timeout', snap)
                    return false
                }
                return true
            }
            h.anchor.missingTicks = 0
        }
        var preStopReason = checkStopConditionTriggered(h)
        if (preStopReason != null) {
            endHandle(h, preStopReason, snap)
            return false
        }
        if (!checkStartConditionMet(h, snap)) {
            if (h.unstartedExpireTick > 0 && tickCounter >= h.unstartedExpireTick) {
                endHandle(h, 'start_timeout', snap)
                return false
            }
            return true
        }
        h.started = true
        if (h.spanTicks > 0) {
            h.endTick = tickCounter + h.spanTicks
        }
        syncHandle(h, snap)
        if (!handles.has(h.id)) return false
        if (!h.loop && !h.lateJoin && h.listenerCount === 0) {
            endHandle(h, 'no_listener', snap)
            return false
        }
        emit('start', h)
        return true
    }

    var syncAll = () => {
        if (handles.size === 0 && dirtyMergeScopes.size === 0) return
        var hadHandles = handles.size > 0
        var t0Ns = nowNano()
        try {
            var snap             = snapshotPlayers()
            flushDirtyMergeScopes(snap)
            if (handles.size === 0) return
            var noOnlinePlayers  = (snap.list.length === 0)
            var needsArbitration = false
            handles.forEach((h) => {
                if (h == null || !handles.has(h.id)) return
                if (h.endTick > 0 && tickCounter >= h.endTick) {
                    endHandle(h, 'expired', snap)
                    return
                }
                if (noOnlinePlayers && h.started && h.listenerCount === 0 && (h.loop || h.lateJoin)) {
                    // 无人在线且无活跃监听器时，常规方块/坐标音源降频检查结束条件（每 20 tick 一次），避免空转 queryBlockAt
                    if (h.anchor.kind !== 'entity' && h.stopCond.predicate == null && (tickCounter % 20) !== 0) {
                        return
                    }
                }
                if (!h.started) {
                    activateHandle(h, snap)
                } else {
                    syncHandle(h, snap)
                    if (handles.has(h.id) && !h.loop && !h.lateJoin && h.listenerCount === 0) {
                        endHandle(h, 'no_listener', snap)
                    }
                }
                if (!needsArbitration && !noOnlinePlayers && handles.has(h.id) && h.started && h.listenerCount > 0) {
                    if ((h.conflictMode && h.conflictMode !== 'none') ||
                        (h.mutedListeners != null && Object.keys(h.mutedListeners).length > 0)) {
                        needsArbitration = true
                    }
                }
            })
            if (needsArbitration) {
                arbitrateHandleConflicts(snap)
            }
        } finally {
            var dtMs = (nowNano() - t0Ns) / 1000000.0
            if (dtMs >= 0 && isFinite(dtMs)) {
                lastSyncAllMs   = dtMs
                syncAllCount++
                lastSyncAllTick = tickCounter
                if (hadHandles || handles.size > 0) lastActiveSyncAllMs = dtMs
                if (dtMs > maxSyncAllMs) maxSyncAllMs = dtMs
            }
        }
    }

    var normalizeConflictMode = (raw, fallback) => {
        var s = raw != null ? String(raw).trim().toLowerCase() : ''
        if (!s) return fallback || 'none'
        if (s === 'none' || s === 'independent' || s === 'distance' || s === 'per_source' || s === 'overlap') return 'none'
        if (s === 'merge' || s === 'combine' || s === 'union') return 'merge'
        if (s === 'latest' || s === 'last_triggered') return 'latest'
        if (s === 'first' || s === 'first_triggered') return 'first'
        if (s === 'newest') return 'newest'
        if (s === 'oldest') return 'oldest'
        if (s === 'nearest' || s === 'closest') return 'nearest'
        return fallback || 'none'
    }

    var getConflictScopeKey = (h) => {
        var sc = h.conflictScope || 'sound'
        if (sc === 'all') return 'all'
        if (sc === 'group') return 'group:' + (h.group || 'default')
        if (sc === 'tag') return 'tag:' + (h.tag || 'default')
        return 'sound:' + h.sound
    }

    var distSqToHandle = (rec, h) => {
        var a = h.anchor
        if (a == null || a.kind === 'none') return 0
        if (rec.dim !== a.dim) return 1e12
        var dx = rec.x - a.x, dy = rec.y - a.y, dz = rec.z - a.z
        return dx * dx + dy * dy + dz * dz
    }

    var isHandleOwnRange = (rec, h, useHysteresis) => {
        if (h.anchor == null || h.anchor.kind === 'none') return true
        if (rec.dim !== h.anchor.dim) return false
        var lim = useHysteresis ? (h.range + CONFIG.rangeHysteresis) : h.range
        return distSqToHandle(rec, h) <= (lim * lim)
    }

    var isPlayerInMergedClusterRange = (h, rec) => {
        var sk = getConflictScopeKey(h)
        for (var other of handles.values()) {
            if (other == null || other.id === h.id || !other.started) continue
            if (other.conflictMode !== 'merge') continue
            if (getConflictScopeKey(other) !== sk) continue
            if (isPlayerEligible(other, rec, true)) return true
        }
        return false
    }

    var getTriggerSeqForPlayer = (h, u) => {
        if (h.listenerInRangeSeq && h.listenerInRangeSeq[u] != null) return h.listenerInRangeSeq[u]
        if (h.listenerEnteredSeq && h.listenerEnteredSeq[u] != null) return h.listenerEnteredSeq[u]
        return h.id
    }

    var arbitrateHandleConflicts = (snap) => {
        if (snap == null || snap.list.length === 0) return
        for (var i = 0; i < snap.list.length; i++) {
            var rec = snap.list[i]
            var u = rec.uuid
            var groups = {}

            for (var h of handles.values()) {
                if (h == null || !h.started || !h.listeners[u]) continue
                if (!h.conflictMode || h.conflictMode === 'none') {
                    if (h.mutedListeners && h.mutedListeners[u]) {
                        delete h.mutedListeners[u]
                        sendPacket(rec.p, { proto: PROTO_VERSION, act: 'mute', ses: SESSION, h: h.id, muted: 0 })
                    }
                    continue
                }
                var sk = getConflictScopeKey(h)
                if (!groups[sk]) groups[sk] = []
                groups[sk].push(h)
            }

            for (var skKey of Object.keys(groups)) {
                var list = groups[skKey]
                if (list.length <= 1) {
                    var only = list[0]
                    if (only.mutedListeners && only.mutedListeners[u]) {
                        delete only.mutedListeners[u]
                        sendPacket(rec.p, { proto: PROTO_VERSION, act: 'mute', ses: SESSION, h: only.id, muted: 0 })
                    }
                    continue
                }

                var groupMode = list[0].conflictMode || 'nearest'
                for (var gm = 1; gm < list.length; gm++) {
                    if (list[gm].conflictMode && list[gm].conflictMode !== 'none') {
                        groupMode = list[gm].conflictMode
                        break
                    }
                }

                var winner = list[0]
                if (groupMode === 'merge') {
                    // 组合合并模式：范围取并集总合；若当前未静音句柄仍在舒适区则保持连续不跳切，
                    // 当退至外缘 (>0.72*range) 且存在显著更近的同组句柄时平滑切至最近成员，避免边缘音量衰减为零
                    var currentActive = null
                    var inRangeList = []
                    for (var m = 0; m < list.length; m++) {
                        var it = list[m]
                        if (isHandleOwnRange(rec, it, true)) {
                            inRangeList.push(it)
                            if (!(it.mutedListeners && it.mutedListeners[u])) {
                                currentActive = it
                            }
                        }
                    }
                    var pool = inRangeList.length > 0 ? inRangeList : list
                    var closest = pool[0]
                    var closestDistSq = distSqToHandle(rec, closest)
                    for (var pIdx = 1; pIdx < pool.length; pIdx++) {
                        var pCand = pool[pIdx]
                        var dCandSq = distSqToHandle(rec, pCand)
                        if (dCandSq < closestDistSq - 0.25) {
                            closest = pCand
                            closestDistSq = dCandSq
                        }
                    }
                    if (currentActive != null) {
                        var curDistSq = distSqToHandle(rec, currentActive)
                        var rimThreshold = currentActive.range * 0.72
                        if (closest.id !== currentActive.id && curDistSq > (rimThreshold * rimThreshold) && closestDistSq * 2.5 < curDistSq) {
                            winner = closest
                        } else {
                            winner = currentActive
                        }
                    } else {
                        winner = closest
                    }
                } else {
                    for (var j = 1; j < list.length; j++) {
                        var cand = list[j]
                        var mode = cand.conflictMode || winner.conflictMode || 'nearest'
                        if (mode === 'latest') {
                            if (getTriggerSeqForPlayer(cand, u) > getTriggerSeqForPlayer(winner, u)) winner = cand
                        } else if (mode === 'first') {
                            if (getTriggerSeqForPlayer(cand, u) < getTriggerSeqForPlayer(winner, u)) winner = cand
                        } else if (mode === 'newest') {
                            if (cand.id > winner.id) winner = cand
                        } else if (mode === 'oldest') {
                            if (cand.id < winner.id) winner = cand
                        } else {
                            var dCand = distSqToHandle(rec, cand)
                            var dWin  = distSqToHandle(rec, winner)
                            if (dCand < dWin - 0.25 || (Math.abs(dCand - dWin) <= 0.25 && (cand.priority > winner.priority || (cand.priority === winner.priority && cand.id < winner.id)))) {
                                winner = cand
                            }
                        }
                    }
                }
                for (var k = 0; k < list.length; k++) {
                    var item = list[k]
                    var shouldMute = (item.id !== winner.id)
                    var wasMuted   = Boolean(item.mutedListeners && item.mutedListeners[u])
                    if (shouldMute !== wasMuted) {
                        if (!item.mutedListeners) item.mutedListeners = {}
                        if (shouldMute) item.mutedListeners[u] = true
                        else delete item.mutedListeners[u]
                        sendPacket(rec.p, { proto: PROTO_VERSION, act: 'mute', ses: SESSION, h: item.id, muted: shouldMute ? 1 : 0 })
                    }
                }
            }
        }
    }

    // ======================================================================== 句柄注册、淘汰与终止

    var registerHandle = (h) => {
        h.id = nextHandleId++
        handles.set(h.id, h)
        if (h.key != null) keyIndex.set(h.key, h.id)
    }

    function endHandle(h, reason, snap, customFadeOut) {
        if (h == null || !handles.has(h.id)) return false
        var s     = snap || snapshotPlayers()
        var uuids = Object.keys(h.listeners)
        var pkt   = buildStopPacket(h, customFadeOut)
        for (var u of uuids) {
            var rec = s.byUuid[u]
            if (rec != null) sendPacket(rec.p, pkt)
            releasePlayerListenCount(h, u)
        }
        h.listeners          = {}
        h.mutedListeners     = {}
        h.listenerEnteredSeq = {}
        h.listenerInRange    = {}
        h.listenerInRangeSeq = {}
        h.countedListeners   = {}
        h.listenerAnchorKey  = {}
        h.listenerSentPos    = {}
        h.listenerCount      = 0
        handles.delete(h.id)
        if (h.key != null && keyIndex.get(h.key) === h.id) {
            keyIndex.delete(h.key)
        }
        emit('end', h, reason)
        return true
    }

    var countPlayerHandles = (optOwnerUuid) => {
        var cnt = 0
        for (var h of handles.values()) {
            if (h != null && h.sourceTier === 'player' && (!optOwnerUuid || h.ownerUuid === optOwnerUuid)) {
                cnt++
            }
        }
        return cnt
    }

    var evictPlayerHandleVictim = (incomingPriority, optOwnerUuid, allowCrossLoopReplace) => {
        var victim   = null
        var minScore = Infinity
        for (var cand of handles.values()) {
            if (cand == null || cand.sourceTier !== 'player') continue
            if (optOwnerUuid && cand.ownerUuid !== optOwnerUuid) continue
            var score = (cand.priority || 2) * 1000000 + (cand.loop ? 500000 : 0) + (cand.bornTick % 500000)
            if (score < minScore) {
                minScore = score
                victim   = cand
            }
        }
        if (victim == null) return false
        if (allowCrossLoopReplace || !victim.loop || (incomingPriority || 2) >= (victim.priority || 2)) {
            return endHandle(victim, 'evicted')
        }
        return false
    }

    var evictLowestPriorityHandle = (incomingPriority, incomingTier) => {
        if (incomingTier === 'player') {
            return evictPlayerHandleVictim(incomingPriority, null, false)
        }
        var victim   = null
        var minScore = Infinity
        for (var cand of handles.values()) {
            if (cand == null) continue
            // system 层级优先淘汰 player 层级句柄；同层级内再比较 priority / loop / bornTick
            var tierWeight = (cand.sourceTier === 'player') ? 0 : 1000000000
            var score = tierWeight + (cand.priority || 2) * 1000000 + (cand.loop ? 500000 : 0) + (cand.bornTick % 500000)
            if (score < minScore) {
                minScore = score
                victim   = cand
            }
        }
        if (victim == null) return false
        if (victim.sourceTier === 'player') {
            return endHandle(victim, 'evicted')
        }
        if (!victim.loop || (incomingPriority || 2) >= (victim.priority || 2)) {
            return endHandle(victim, 'evicted')
        }
        return false
    }

    // ======================================================================== 对外接口：播放与心跳续期

    var isSpecObject = (a) => isObjectLike(a) && !Array.isArray(a) &&
        !safeHasMethod(a, 'getClass') && (safeReadProp(a, 'sound') != null || safeReadProp(a, 'soundId') != null || safeReadProp(a, 'id') != null)

    var normalizeLegacySpec = (target, soundId, opts) => {
        var o = isObjectLike(opts) ? copyObject(opts) : {}
        if (soundId != null) o.sound = soundId
        if (target == null) return o
        if (safeTypeOf(target) === 'string') {
            var s = target.trim().toLowerCase()
            if (s === 'all' || s === '*') {
                o.audience = 'all'
            } else if (s.includes(':') && o.dim == null) {
                o.dim      = target
                o.audience = o.audience || 'dim'
            } else {
                o.players = [target]
            }
        } else if (isPlayer(target)) {
            o.players = [target]
        } else if (isEntity(target)) {
            o.entity = target
        } else if (isBlockContainer(target)) {
            o.block = target
        } else if (Array.isArray(target) || (safeHasMethod(target, 'iterator') && readPos(target) == null)) {
            o.players = target
        } else {
            o.at = target
        }
        return o
    }

    var renewExistingHandle = (existing, newHandle, spec) => {
        var snap = serverRef != null ? snapshotPlayers() : null
        existing.priority = newHandle.priority
        existing.tag      = newHandle.tag
        existing.group    = newHandle.group
        existing.fadeOut  = newHandle.fadeOut

        if (existing.lifeMode === 'active' || newHandle.lifeMode === 'active') {
            existing.lifeMode  = 'active'
            existing.spanTicks = newHandle.activeHoldTicks
            existing.endTick   = tickCounter + newHandle.activeHoldTicks
        } else if (newHandle.spanTicks > 0) {
            existing.spanTicks = newHandle.spanTicks
            existing.endTick   = tickCounter + newHandle.spanTicks
        }

        var allowMove = parseBool(spec.movable != null ? spec.movable : spec.updatePos, true)
        var paramChanged = false
        if (Math.abs(existing.volume - newHandle.volume) > 0.005) {
            existing.volume = newHandle.volume
            paramChanged = true
        }
        if (Math.abs(existing.pitch - newHandle.pitch) > 0.005) {
            existing.pitch = newHandle.pitch
            paramChanged = true
        }
        if (existing.range !== newHandle.range) {
            existing.range = newHandle.range
            paramChanged = true
        }
        if (allowMove && existing.anchor.kind === 'pos' && newHandle.anchor.kind !== 'none') {
            existing.anchor.x = newHandle.anchor.x
            existing.anchor.y = newHandle.anchor.y
            existing.anchor.z = newHandle.anchor.z
            paramChanged = true
        }

        if (snap != null && existing.listenerCount > 0) {
            if (existing.sound !== newHandle.sound || existing.category !== newHandle.category || existing.falloff !== newHandle.falloff) {
                existing.sound    = newHandle.sound
                existing.category = newHandle.category
                existing.falloff  = newHandle.falloff
                resendPlayToListeners(existing, snap, true)
            } else if (paramChanged) {
                broadcastUpdateToListeners(existing, snap)
            }
        }
        return existing.id
    }

    var play = (a, b, c) => {
        try {
            var spec  = (b === undefined && isSpecObject(a)) ? a : normalizeLegacySpec(a, b, c)
            var built = buildHandle(spec)
            if (built.error) {
                reportWarning('play', built.error)
                return 0
            }
            var h = built.handle

            if (h.key != null && keyIndex.has(h.key)) {
                var old = handles.get(keyIndex.get(h.key))
                if (old != null) {
                    if (h.sourceTier === 'player' && old.sourceTier !== 'player') {
                        reportWarning('play', `玩家指令无权覆盖或续期系统级 key [${h.key}]`)
                        return 0
                    }
                    var forceReplace = parseBool(spec.replace != null ? spec.replace : spec.restart, false)
                    if (!forceReplace) {
                        return renewExistingHandle(old, h, spec)
                    }
                    endHandle(old, 'replaced')
                }
            }

            if (h.sourceTier === 'player') {
                if (countPlayerHandles(h.ownerUuid) >= CONFIG.maxCreatedHandlesPerPlayer &&
                    !evictPlayerHandleVictim(h.priority, h.ownerUuid, true)) {
                    reportWarning('play', `玩家并发音频句柄已达个人上限 (${CONFIG.maxCreatedHandlesPerPlayer}) 且无可淘汰句柄，已忽略: ${h.sound}`)
                    return 0
                }
                if (countPlayerHandles(null) >= CONFIG.maxPlayerHandles &&
                    !evictPlayerHandleVictim(h.priority, null, false)) {
                    reportWarning('play', `全服玩家指令音频总池已满 (${CONFIG.maxPlayerHandles})，已忽略: ${h.sound}`)
                    return 0
                }
            }

            if (handles.size >= CONFIG.maxHandles && !evictLowestPriorityHandle(h.priority, h.sourceTier)) {
                reportWarning('play', `全服句柄已达上限 (${CONFIG.maxHandles}) 且无可淘汰低优先级句柄，已忽略: ${h.sound}`)
                return 0
            }

            registerHandle(h)
            if (serverRef != null && !activateHandle(h, snapshotPlayers())) {
                return 0
            }
            return h.id
        } catch (e) {
            reportWarning('play', String(e))
            return 0
        }
    }

    var safePlay = (a, b, c) => {
        try { return play(a, b, c) } catch (e) { reportCatch('safePlay', e); return 0 }
    }

    var withFields = (opts, fields) => {
        var o = (typeof opts === 'object' && opts != null) ? copyObject(opts) : {}
        for (var k of Object.keys(fields)) o[k] = fields[k]
        return o
    }

    var toPlayer = (playerOrPlayers, soundId, opts) =>
        play(withFields(opts, { sound: soundId, players: playerOrPlayers }))

    var at = (x, y, z, levelOrDim, soundId, opts) =>
        play(withFields(opts, { sound: soundId, at: [x, y, z], dim: levelOrDim }))

    var atBlock = (block, soundId, opts) =>
        play(withFields(opts, { sound: soundId, block: block }))

    var onEntity = (entity, soundId, opts) =>
        play(withFields(opts, { sound: soundId, entity: entity }))

    var inDimension = (levelOrDim, a, b, c, d, e, f) => {
        if (typeof a === 'number' && typeof b === 'number' && typeof c === 'number') {
            var x = a, y = b, z = c
            var radius  = typeof d === 'number' ? d : CONFIG.defaultRange
            var soundId = typeof d === 'number' ? e : d
            var opts    = typeof d === 'number' ? f : e
            return play(withFields(opts, {
                sound:    soundId,
                at:       [x, y, z],
                dim:      levelOrDim,
                range:    radius,
                audience: (opts && opts.audience) ? opts.audience : 'near'
            }))
        }
        return play(withFields(b, { sound: a, dim: levelOrDim, audience: 'dim' }))
    }

    var toAll = (soundId, opts) =>
        play(withFields(opts, { sound: soundId, audience: 'all' }))

    var atEvent = (event, soundId, opts) => {
        if (event == null) {
            reportWarning('atEvent', '传入的 event 为空')
            return 0
        }
        var block = event.block
        if (block != null) return atBlock(block, soundId, opts)
        var entity = event.entity
        if (entity != null) return onEntity(entity, soundId, opts)
        var player = event.player
        if (player != null) return onEntity(player, soundId, opts)
        var pos = readPos(event.pos)
        var lv  = levelOf(event)
        if (pos != null && lv != null) {
            return at(pos.x, pos.y, pos.z, lv, soundId, opts)
        }
        reportWarning('atEvent', '无法从 event 中提取 block / entity / player / pos')
        return 0
    }

    // ======================================================================== 对外接口：停止、排除与热更新

    var resolveHandle = (ref) => {
        if (ref == null) return null
        if (typeof ref === 'number' || (typeof ref === 'string' && /^\d+$/.test(ref.trim()))) {
            var n = Number(ref)
            return isFinite(n) ? (handles.get(n) || null) : null
        }
        if (typeof ref === 'string') {
            var kid = keyIndex.get(ref.trim())
            return kid != null ? (handles.get(kid) || null) : null
        }
        return null
    }

    var endMatching = (predicate, fadeOut, maxPriority) => {
        var maxPri  = maxPriority != null ? parsePriority(maxPriority, 10) : 10
        var fout    = parseTicks(fadeOut, true)
        var matched = []
        for (var h of handles.values()) {
            if ((h.priority || 2) <= maxPri && predicate(h)) {
                matched.push(h)
            }
        }
        if (matched.length === 0) return 0
        var snap = snapshotPlayers()
        for (var h of matched) {
            endHandle(h, 'stopped', snap, fout)
        }
        return matched.length
    }

    var stopAtBlock = (blockObj, soundId, fadeOut) => {
        if (blockObj == null) return 0
        var pos = readPos(blockObj)
        if (pos == null) return 0
        var lv  = levelOf(blockObj)
        var dim = lv != null ? dimOfLevel(lv) : (blockObj.dim ? resolveDimId(blockObj.dim) : null)
        var bx  = Math.floor(pos.x), by = Math.floor(pos.y), bz = Math.floor(pos.z)
        var sid = soundId != null ? normalizeSoundId(soundId) : null
        return endMatching((h) => {
            var a = h.anchor
            if (a.kind !== 'block' && a.kind !== 'pos') return false
            if (dim != null && a.dim !== dim) return false
            if (sid != null && h.sound !== sid) return false
            return Math.floor(a.x) === bx && Math.floor(a.y) === by && Math.floor(a.z) === bz
        }, fadeOut)
    }

    var stopOnEntity = (entityObj, soundId, fadeOut) => {
        if (entityObj == null) return 0
        var u = isEntity(entityObj) ? uuidOf(entityObj) : String(entityObj)
        if (!u) return 0
        var sid = soundId != null ? normalizeSoundId(soundId) : null
        return endMatching((h) => {
            if (h.anchor.kind !== 'entity' || h.anchor.uuid !== u) return false
            if (sid != null && h.sound !== sid) return false
            return true
        }, fadeOut)
    }

    var stopInDimension = (levelOrDim, soundId, fadeOut) => {
        var dim = resolveDimId(levelOrDim)
        if (dim == null) return 0
        var sid = soundId != null ? normalizeSoundId(soundId) : null
        return endMatching((h) => {
            var hDim = h.anchor.kind !== 'none' ? h.anchor.dim : h.audience.dim
            if (hDim !== dim) return false
            if (sid != null && h.sound !== sid) return false
            return true
        }, fadeOut)
    }

    var stopKey = (key, fadeOut) => {
        if (key == null) return 0
        var id   = keyIndex.get(String(key).trim())
        var fout = parseTicks(fadeOut, true)
        return (id != null && endHandle(handles.get(id), 'stopped', null, fout)) ? 1 : 0
    }

    var stopAll = (fadeOut, maxPriority) =>
        endMatching(() => true, fadeOut, maxPriority)

    var stopTag = (tagOrGroup, fadeOut, maxPriority) => {
        if (tagOrGroup == null) return 0
        var t = String(tagOrGroup).trim()
        if (t === '*' || t === 'all') return stopAll(fadeOut, maxPriority)
        return endMatching((h) => h.tag === t || h.group === t || h.key === t, fadeOut, maxPriority)
    }

    var stopFor = (players, soundId, fadeOut) => {
        var sid = null
        if (soundId != null && String(soundId).trim() !== '' && String(soundId).trim() !== '*') {
            sid = normalizeSoundId(soundId)
            if (sid == null) {
                reportWarning('stopFor', `音频 ID 无效: ${soundId}`)
                return 0
            }
        }
        var col = collectPlayerUuids(players)
        if (col.count === 0) return 0
        var fout = parseTicks(fadeOut, true)
        var snap = snapshotPlayers()
        var affected = 0
        for (var h of handles.values()) {
            if (sid != null && h.sound !== sid) continue
            var touched = false
            for (var u of Object.keys(col.uuids)) {
                h.excluded[u] = true
                if (h.listeners[u]) {
                    removeListener(h, u, snap.byUuid[u] || null, 'excluded', fout)
                    touched = true
                }
            }
            if (touched) affected++
        }
        return affected
    }

    var stopSound = (soundId, players, fadeOut) => {
        if (fadeOut === undefined && players != null && (typeof players === 'number' || (typeof players === 'string' && /^\d+(?:\.\d+)?\s*(?:s|sec|ms|t|tick|ticks)?$/i.test(players.trim())))) {
            fadeOut = players
            players = null
        }
        if (players != null) return stopFor(players, soundId, fadeOut)
        var sid = normalizeSoundId(soundId)
        if (sid == null) {
            reportWarning('stopSound', `音频 ID 无效: ${soundId}`)
            return 0
        }
        return endMatching((h) => h.sound === sid, fadeOut)
    }

    var stop = (ref, soundIdOrFadeOut, maybeFadeOut) => {
        if (ref == null || ref === '*' || ref === 'all') {
            return stopAll(soundIdOrFadeOut)
        }
        if (typeof ref === 'number' || (typeof ref === 'string' && /^\d+$/.test(ref.trim()))) {
            var hById = resolveHandle(ref)
            var fout1 = parseTicks(soundIdOrFadeOut, true)
            return endHandle(hById, 'stopped', null, fout1) ? 1 : 0
        }
        if (typeof ref === 'string') {
            var s = ref.trim()
            var foutStr = parseTicks(soundIdOrFadeOut, true)
            if (keyIndex.has(s)) {
                return endHandle(handles.get(keyIndex.get(s)), 'stopped', null, foutStr) ? 1 : 0
            }
            var byTag = stopTag(s, foutStr)
            if (byTag > 0) return byTag
            var asSound = normalizeSoundId(s)
            if (asSound != null) return stopSound(asSound, null, foutStr)
            return 0
        }
        if (isBlockContainer(ref)) {
            var isSnd1 = (typeof soundIdOrFadeOut === 'string' && parseTicks(soundIdOrFadeOut, true) === null)
            return stopAtBlock(ref, isSnd1 ? soundIdOrFadeOut : null, isSnd1 ? maybeFadeOut : soundIdOrFadeOut)
        }
        if (isEntity(ref)) {
            var isSnd2 = (typeof soundIdOrFadeOut === 'string' && parseTicks(soundIdOrFadeOut, true) === null)
            return stopOnEntity(ref, isSnd2 ? soundIdOrFadeOut : null, isSnd2 ? maybeFadeOut : soundIdOrFadeOut)
        }
        if (isObjectLike(ref)) {
            var refBlock = safeReadProp(ref, 'block')
            if (refBlock != null) return stopAtBlock(refBlock, safeReadProp(ref, 'sound'), safeReadProp(ref, 'fadeOut'))
            var refEntity = safeReadProp(ref, 'entity')
            if (refEntity != null) return stopOnEntity(refEntity, safeReadProp(ref, 'sound'), safeReadProp(ref, 'fadeOut'))
            var refKey = safeReadProp(ref, 'key')
            if (refKey != null) return stopKey(refKey, safeReadProp(ref, 'fadeOut'))
            var refTag = safeReadProp(ref, 'tag') != null ? safeReadProp(ref, 'tag') : safeReadProp(ref, 'group')
            if (refTag != null) return stopTag(refTag, safeReadProp(ref, 'fadeOut'), safeReadProp(ref, 'maxPriority'))
            var refDim = safeReadProp(ref, 'dim') != null ? safeReadProp(ref, 'dim') : safeReadProp(ref, 'level')
            if (refDim != null) return stopInDimension(refDim, safeReadProp(ref, 'sound'), safeReadProp(ref, 'fadeOut'))
            if (readPos(ref) != null) return stopAtBlock(ref, soundIdOrFadeOut, maybeFadeOut)
        }
        reportWarning('stop', `无法识别的 stop 目标参数: ${ref}`)
        return 0
    }

    var exclude = (handleOrKey, players) => {
        var h = resolveHandle(handleOrKey)
        if (h == null) return false
        var col  = collectPlayerUuids(players)
        var snap = snapshotPlayers()
        for (var u of Object.keys(col.uuids)) {
            h.excluded[u] = true
            if (h.listeners[u]) removeListener(h, u, snap.byUuid[u] || null, 'excluded')
        }
        return true
    }

    var include = (handleOrKey, players) => {
        var h = resolveHandle(handleOrKey)
        if (h == null) return false
        var col = collectPlayerUuids(players)
        for (var u of Object.keys(col.uuids)) {
            delete h.excluded[u]
        }
        return true
    }

    var update = (handleOrKey, patch) => {
        var h = resolveHandle(handleOrKey)
        if (h == null || patch == null || typeof patch !== 'object') return false
        var needRestart = false
        var needLiveUpd = false

        if (patch.volume != null || patch.vol != null) {
            h.volume = clampNum(parseFiniteNum(patch.volume != null ? patch.volume : patch.vol, h.volume), 0.0, 2.0)
            needLiveUpd = true
        }
        if (patch.pitch != null || patch.pit != null) {
            h.pitch = clampNum(parseFiniteNum(patch.pitch != null ? patch.pitch : patch.pit, h.pitch), 0.5, 2.0)
            needLiveUpd = true
        }
        if (patch.range != null || patch.radius != null) {
            h.range = clampNum(parseFiniteNum(patch.range != null ? patch.range : patch.radius, h.range), CONFIG.minRange, CONFIG.maxRange)
            needLiveUpd = true
        }
        if (patch.fadeOut != null) {
            var fo = parseTicks(patch.fadeOut, true)
            if (fo != null) {
                h.fadeOut = fo
                needLiveUpd = true
            }
        }
        if ((h.anchor.kind === 'pos' || h.anchor.kind === 'block') && (patch.x != null || patch.y != null || patch.z != null)) {
            h.anchor.x = parseFiniteNum(patch.x, h.anchor.x)
            h.anchor.y = parseFiniteNum(patch.y, h.anchor.y)
            h.anchor.z = parseFiniteNum(patch.z, h.anchor.z)
            if (h.anchor.kind === 'block') {
                h.anchor.bx = Math.floor(h.anchor.x)
                h.anchor.by = Math.floor(h.anchor.y)
                h.anchor.bz = Math.floor(h.anchor.z)
            }
            needLiveUpd = true
        }
        if (patch.category != null) {
            var cat = normalizeCategory(patch.category)
            if (cat == null) { reportWarning('update', `category 无效: ${patch.category}`); return false }
            if (h.category !== cat) {
                h.category  = cat
                needRestart = true
            }
        }
        if (patch.falloff != null) {
            var f = String(patch.falloff).trim().toLowerCase()
            if (!FALLOFFS.has(f)) { reportWarning('update', `falloff 无效: ${patch.falloff}`); return false }
            var nextFalloff = h.anchor.kind === 'none' ? 'flat' : f
            if (h.falloff !== nextFalloff) {
                h.falloff   = nextFalloff
                needRestart = true
            }
        }
        if (patch.lifetime !== undefined) {
            var lt = parseTicks(patch.lifetime, false)
            h.endTick = lt != null ? (tickCounter + lt) : 0
        }
        if (patch.lateJoin != null) {
            h.lateJoin = parseBool(patch.lateJoin, h.lateJoin)
        }
        if (patch.priority != null) {
            h.priority = parsePriority(patch.priority, h.priority)
        }

        if (h.listenerCount > 0 && serverRef != null) {
            var snap = snapshotPlayers()
            if (needRestart || parseBool(patch.restart, false)) {
                resendPlayToListeners(h, snap, true)
            } else if (needLiveUpd) {
                broadcastUpdateToListeners(h, snap)
            }
        }
        return true
    }

    // ======================================================================== 对外接口：查询

    var isPlaying = (handleOrKey) => {
        var h = resolveHandle(handleOrKey)
        return h != null && h.listenerCount > 0
    }

    var get = (handleOrKey) => {
        var h = resolveHandle(handleOrKey)
        return h != null ? handleInfo(h) : null
    }

    var getByKey = (key) => {
        if (key == null) return null
        var id = keyIndex.get(String(key).trim())
        return (id != null && handles.has(id)) ? handleInfo(handles.get(id)) : null
    }

    var list = () => {
        var out = []
        for (var h of handles.values()) {
            out.push(handleInfo(h))
        }
        out.sort((a, b) => a.id - b.id)
        return out
    }

    var listeners = (handleOrKey) => {
        var h = resolveHandle(handleOrKey)
        if (h == null) return []
        var snap  = snapshotPlayers()
        var names = []
        for (var u of Object.keys(h.listeners)) {
            var rec = snap.byUuid[u]
            if (rec != null) names.push(nameOf(rec.p))
        }
        return names
    }

    // ======================================================================== 方块声源自动绑定（委托 EpiphyBlockTracker）

    var makeBoundAudioKey = (blockId, dim, x, y, z) => `bound_block@${blockId}@${dim}:${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`

    var boundAudioSeqCounter = 0
    var boundAudioSeqByKey   = new Map() // posKey -> monotonic seq
    var mergeBoundSources    = new Map() // audioKey -> { audioKey, key, blockId, dim, bx, by, bz, cx, cy, cz, range, scopeKey, seq, playSpec }
    var dirtyMergeScopes     = new Set() // scopeKey -> 待合并重算的维度声场作用域

    var flushDirtyMergeScopes = (snapOpt) => {
        if (dirtyMergeScopes.size === 0) return 0
        var snap = snapOpt != null ? snapOpt : (serverRef != null ? snapshotPlayers() : null)
        var scopes = Array.from(dirtyMergeScopes)
        dirtyMergeScopes.clear()
        var reconciled = 0
        for (var i = 0; i < scopes.length; i++) {
            if (reconcileAudioMergeScope(scopes[i], snap, null)) {
                reconciled++
            }
        }
        return reconciled
    }

    var ensureBoundAudioSeq = (rec) => {
        if (rec == null) return 0
        if (rec.key != null) {
            var existing = boundAudioSeqByKey.get(rec.key)
            if (existing != null) return existing
            // 常规移除/解绑会在 L2438/L2577 精确 delete；8192 仅作异常长期不卸载场景的防爆内存兜底
            if (boundAudioSeqByKey.size >= 8192) boundAudioSeqByKey.clear()
            var nextSeq = ++boundAudioSeqCounter
            boundAudioSeqByKey.set(rec.key, nextSeq)
            return nextSeq
        }
        return ++boundAudioSeqCounter
    }

    var getBoundMergeScopeKey = (dim, effSound, rawSpec) => {
        var sc = String(rawSpec.conflictScope != null ? rawSpec.conflictScope : 'sound').trim().toLowerCase()
        if (sc === 'all') return `${dim}|all`
        if (sc === 'group') return `${dim}|group:${rawSpec.group || rawSpec.tag || 'default'}`
        if (sc === 'tag') return `${dim}|tag:${rawSpec.tag || rawSpec.group || 'default'}`
        return `${dim}|sound:${effSound}`
    }

    var findActiveClusterHandleForKey = (audioKey) => {
        if (!audioKey) return null
        if (keyIndex.has(audioKey)) {
            var hDirect = handles.get(keyIndex.get(audioKey))
            if (hDirect != null) return hDirect
        }
        for (var h of handles.values()) {
            if (h != null && h.isMergedCluster && h.clusterMemberKeys != null && h.clusterMemberKeys.has(audioKey)) {
                return h
            }
        }
        return null
    }

    var computeMergedComponents = (scopeKey) => {
        var nodes = []
        for (var src of mergeBoundSources.values()) {
            if (src != null && src.scopeKey === scopeKey) {
                nodes.push({ src: src, cx: src.cx, cy: src.cy, cz: src.cz, r: src.range, seq: src.seq })
            }
        }
        if (nodes.length === 0) return []
        return SPEC.computeSphereMergeClusters(nodes).map((c) => c.members.map((m) => m.src))
    }

    var startMergedClusterHandle = (comp, scopeKey, snap) => {
        var leader = comp[0]
        var curBlock = queryBlockAt(leader.dim, leader.bx, leader.by, leader.bz)
        var spec = withFields(leader.playSpec, {
            key: leader.audioKey,
            x:   leader.bx,
            y:   leader.by,
            z:   leader.bz,
            dim: leader.dim,
            blockCenter: true
        })
        if (curBlock != null && extractBlockId(curBlock) === leader.blockId) {
            spec.block = curBlock
            delete spec.x; delete spec.y; delete spec.z; delete spec.blockCenter
        }
        var built = buildHandle(spec)
        if (built.error) {
            reportWarning('mergeCluster', built.error)
            return false
        }
        var h = built.handle
        var memberKeys = new Set()
        for (var i = 0; i < comp.length; i++) memberKeys.add(comp[i].audioKey)
        h.isMergedCluster   = true
        h.mergeScopeKey     = scopeKey
        h.clusterSources    = comp
        h.clusterMemberKeys = memberKeys
        h.listenerAnchorKey = {}
        h.listenerSentPos   = {}

        if (handles.size >= CONFIG.maxHandles && !evictLowestPriorityHandle(h.priority, h.sourceTier)) {
            reportWarning('play', `全服句柄已达上限 (${CONFIG.maxHandles}) 且无可淘汰低优先级句柄，已忽略: ${h.sound}`)
            return false
        }
        registerHandle(h)
        if (snap != null && !activateHandle(h, snap)) {
            return false
        }
        return true
    }

    var reconcileAudioMergeScope = (scopeKey, snapOpt, customFadeOut, skipSyncHandleId) => {
        if (!scopeKey) return false
        var components = computeMergedComponents(scopeKey)
        var existingHandles = []
        for (var eh of handles.values()) {
            if (eh != null && eh.isMergedCluster && eh.mergeScopeKey === scopeKey) {
                existingHandles.push(eh)
            }
        }
        var snap = snapOpt != null ? snapOpt : (serverRef != null ? snapshotPlayers() : null)

        if (components.length === 0) {
            for (var r = 0; r < existingHandles.length; r++) {
                endHandle(existingHandles[r], 'block_broken', snap, customFadeOut)
            }
            return true
        }

        var usedHandles = new Set()
        var compHandle  = new Array(components.length)

        // 第一轮：优先匹配 leaderKey 未变的既有句柄（放新块扩展并集时直接沿用原句柄，零额外创建）
        for (var ci = 0; ci < components.length; ci++) {
            var leaderKey = components[ci][0].audioKey
            for (var hi = 0; hi < existingHandles.length; hi++) {
                var hCand = existingHandles[hi]
                if (!usedHandles.has(hCand.id) && hCand.key === leaderKey) {
                    compHandle[ci] = hCand
                    usedHandles.add(hCand.id)
                    break
                }
            }
        }
        // 第二轮：若原 leader 方块被敲掉，由同一存活连通簇继承该句柄（平滑移交新 leader，不中断收听）
        for (var ci2 = 0; ci2 < components.length; ci2++) {
            if (compHandle[ci2] != null) continue
            var comp = components[ci2]
            for (var hi2 = 0; hi2 < existingHandles.length; hi2++) {
                var hCand2 = existingHandles[hi2]
                if (usedHandles.has(hCand2.id) || hCand2.clusterMemberKeys == null) continue
                var intersects = false
                for (var mi = 0; mi < comp.length; mi++) {
                    if (hCand2.clusterMemberKeys.has(comp[mi].audioKey)) {
                        intersects = true
                        break
                    }
                }
                if (intersects) {
                    compHandle[ci2] = hCand2
                    usedHandles.add(hCand2.id)
                    break
                }
            }
        }

        // 先结束不再对应任何连通分量（或已被合并进更大连通分量）的旧句柄
        for (var hi3 = 0; hi3 < existingHandles.length; hi3++) {
            var orphan = existingHandles[hi3]
            if (!usedHandles.has(orphan.id)) {
                endHandle(orphan, 'merged', snap, customFadeOut)
            }
        }

        // 同步继承句柄的新成员表与新范围并集，并为分裂出的新连通簇启动独立句柄
        for (var ci3 = 0; ci3 < components.length; ci3++) {
            var curComp   = components[ci3]
            var curLeader = curComp[0]
            var curH      = compHandle[ci3]
            if (curH == null) {
                startMergedClusterHandle(curComp, scopeKey, snap)
                continue
            }
            var newKeys = new Set()
            for (var kIdx = 0; kIdx < curComp.length; kIdx++) newKeys.add(curComp[kIdx].audioKey)
            if (curH.key !== curLeader.audioKey) {
                if (curH.key != null && keyIndex.get(curH.key) === curH.id) {
                    keyIndex.delete(curH.key)
                }
                curH.key = curLeader.audioKey
                keyIndex.set(curH.key, curH.id)
                curH.anchor.bx      = curLeader.bx
                curH.anchor.by      = curLeader.by
                curH.anchor.bz      = curLeader.bz
                curH.anchor.x       = curLeader.cx
                curH.anchor.y       = curLeader.cy
                curH.anchor.z       = curLeader.cz
                curH.anchor.blockId = curLeader.blockId
                curH.range          = curLeader.range
            }
            curH.clusterSources    = curComp
            curH.clusterMemberKeys = newKeys
            if (snap != null && curH.id !== skipSyncHandleId) {
                if (!curH.started) activateHandle(curH, snap)
                else syncHandle(curH, snap)
            }
        }
        return true
    }

    var removeBoundMergeSource = (audioKey, fadeOut, doReconcile) => {
        if (!audioKey) return false
        var src = mergeBoundSources.get(audioKey)
        if (src == null) return false
        mergeBoundSources.delete(audioKey)
        if (doReconcile) {
            reconcileAudioMergeScope(src.scopeKey, null, fadeOut)
        }
        return true
    }

    var handleBoundBlockRemoved = (audioKey, key, fadeOut) => {
        if (key != null) boundAudioSeqByKey.delete(key)
        if (mergeBoundSources.has(audioKey)) {
            removeBoundMergeSource(audioKey, fadeOut, true)
            return
        }
        stopKey(audioKey, fadeOut)
    }

    var startBoundBlockAudio = (rec, binding, lv, curBlock, foundSource) => {
        if (binding == null) binding = audioBlockTracker != null ? audioBlockTracker.getBinding(rec.blockId) : null
        if (binding == null) return false
        if (lv == null) lv = resolveServerLevel(rec.dim)
        if (lv == null || !isBlockChunkLoaded(lv, rec.x, rec.z)) return false
        if (curBlock == null) curBlock = queryBlockAt(rec.dim, rec.x, rec.y, rec.z)
        if (extractBlockId(curBlock) !== rec.blockId) return false

        var rawSpec = typeof binding.specOrFn === 'function'
            ? safeCall(binding.specOrFn, [{ block: curBlock, level: lv, server: serverRef, dim: rec.dim, x: rec.x, y: rec.y, z: rec.z }], 'bindBlock')
            : binding.specOrFn
        if (rawSpec == null || typeof rawSpec !== 'object') return false

        var effMode = normalizeConflictMode(rawSpec.conflictMode !== undefined ? rawSpec.conflictMode : 'nearest', 'nearest')
        var playSpec = withFields(rawSpec, {
            key:              rec.audioKey,
            block:            curBlock,
            dim:              rec.dim,
            loop:             rawSpec.loop !== undefined ? rawSpec.loop : true,
            outOfRangeMode:   rawSpec.outOfRangeMode !== undefined ? rawSpec.outOfRangeMode : 'mute',
            conflictMode:     effMode,
            conflictScope:    rawSpec.conflictScope !== undefined ? rawSpec.conflictScope : 'sound',
            stopOnBlockBreak: rawSpec.stopOnBlockBreak !== undefined ? rawSpec.stopOnBlockBreak : true
        })

        if (effMode === 'merge') {
            var rawSound = rawSpec.sound != null ? rawSpec.sound : (rawSpec.soundId != null ? rawSpec.soundId : rawSpec.id)
            var effSound = normalizeSoundId(rawSound)
            if (effSound != null) {
                var bx = Math.floor(rec.x), by = Math.floor(rec.y), bz = Math.floor(rec.z)
                var effRange = clampNum(parseFiniteNum(rawSpec.range != null ? rawSpec.range : rawSpec.radius, CONFIG.defaultRange), CONFIG.minRange, CONFIG.maxRange)
                var scopeKey = getBoundMergeScopeKey(rec.dim, effSound, playSpec)
                var seq = ensureBoundAudioSeq(rec)
                mergeBoundSources.set(rec.audioKey, {
                    audioKey: rec.audioKey,
                    key:      rec.key,
                    blockId:  rec.blockId,
                    dim:      rec.dim,
                    bx:       bx,
                    by:       by,
                    bz:       bz,
                    cx:       bx + 0.5,
                    cy:       by + 0.5,
                    cz:       bz + 0.5,
                    range:    effRange,
                    scopeKey: scopeKey,
                    seq:      seq,
                    playSpec: playSpec
                })
                if (foundSource === 'scan') {
                    dirtyMergeScopes.add(scopeKey)
                    return true
                }
                return reconcileAudioMergeScope(scopeKey, null, null)
            }
        } else if (mergeBoundSources.has(rec.audioKey)) {
            removeBoundMergeSource(rec.audioKey, null, true)
        }

        return play(playSpec) > 0
    }

    var audioBlockTracker     = null
    var audioBoundMetaByBlockId = new Map()
    var createAudioBlockTrackerInstance = () => BASE.acquireBlockTracker({
        name:             'audio',
        maintainInterval: 20,
        maintainOffset:   2,
        makeRecordExtra: function (blockId, dim, ix, iy, iz) {
            return { audioKey: makeBoundAudioKey(blockId, dim, ix, iy, iz) }
        },
        onFound: function (rec, binding, foundSource) {
            ensureBoundAudioSeq(rec)
            if (findActiveClusterHandleForKey(rec.audioKey) == null) {
                startBoundBlockAudio(rec, binding, null, null, foundSource)
            }
        },
        onTick: function (rec, binding, tickNum, lv, curBlock) {
            if (findActiveClusterHandleForKey(rec.audioKey) == null) {
                startBoundBlockAudio(rec, binding, lv, curBlock, 'tick')
            }
        },
        onRemoved: function (rec, binding, reason, fadeOut) {
            handleBoundBlockRemoved(rec.audioKey, rec.key, fadeOut)
        },
        onBrokenUnregistered: function (dim, x, y, z, bid) {
            handleBoundBlockRemoved(makeBoundAudioKey(bid, dim, x, y, z), `${dim}|${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`, null)
        }
    })
    var ensureAudioBlockTracker = () => {
        var hasReal = (typeof global !== 'undefined' && global.EpiphyBlockTracker != null && typeof global.EpiphyBlockTracker.createTracker === 'function')
        if (audioBlockTracker != null) {
            if (!audioBlockTracker.isFallback || !hasReal) {
                return audioBlockTracker
            }
            var oldFallback = audioBlockTracker
            var upgraded    = createAudioBlockTrackerInstance()
            if (upgraded != null && !upgraded.isFallback) {
                audioBoundMetaByBlockId.forEach((meta, bid) => {
                    upgraded.bind(bid, meta)
                })
                try {
                    if (typeof oldFallback.destroy === 'function') oldFallback.destroy()
                } catch (eOldAudioFb) { }
                audioBlockTracker = upgraded
            }
            return audioBlockTracker
        }
        audioBlockTracker = createAudioBlockTrackerInstance()
        return audioBlockTracker
    }

    var bindBlock = (blockId, specOrFn) => {
        if (!blockId || specOrFn == null) return false
        var tracker = ensureAudioBlockTracker()
        if (tracker == null) return false
        var idStr = String(blockId).trim()
        var range = (typeof specOrFn === 'object' && specOrFn.range != null) ? Number(specOrFn.range) : 32
        var metaEntry = {
            blockId:    idStr,
            specOrFn:   specOrFn,
            scanRadius: clampNum(isFinite(range) ? range + 6 : 38, 16, 128)
        }
        audioBoundMetaByBlockId.set(idStr, metaEntry)
        tracker.bind(idStr, metaEntry)
        if (!global.EpiphyAudioBlockBindings || typeof global.EpiphyAudioBlockBindings !== 'object') {
            global.EpiphyAudioBlockBindings = {}
        }
        global.EpiphyAudioBlockBindings[idStr] = specOrFn
        return true
    }

    var unbindBlock = (blockId, fadeOut) => {
        if (!blockId) return 0
        var tracker = ensureAudioBlockTracker()
        if (tracker == null) return 0
        var idStr = String(blockId).trim()
        audioBoundMetaByBlockId.delete(idStr)
        if (global.EpiphyAudioBlockBindings && typeof global.EpiphyAudioBlockBindings === 'object') {
            delete global.EpiphyAudioBlockBindings[idStr]
        }
        var stopped = tracker.unbind(idStr, fadeOut)
        var affectedScopes = new Set()
        var removeEntries  = []
        mergeBoundSources.forEach((src, ak) => {
            if (src != null && src.blockId === idStr) {
                affectedScopes.add(src.scopeKey)
                removeEntries.push({ ak: ak, key: src.key })
            }
        })
        for (var ri = 0; ri < removeEntries.length; ri++) {
            var rm = removeEntries[ri]
            mergeBoundSources.delete(rm.ak)
            if (rm.key != null) boundAudioSeqByKey.delete(rm.key)
        }
        for (var sk of affectedScopes) {
            dirtyMergeScopes.delete(sk)
            reconcileAudioMergeScope(sk, null, fadeOut)
        }
        return stopped
    }

    var scanBlocksNow = () => {
        var tracker = ensureAudioBlockTracker()
        return tracker != null ? tracker.scanNow() : 0
    }

    var absorbGlobalBlockBindings = () => {
        var reg = global.EpiphyAudioBlockBindings
        if (reg != null && typeof reg === 'object') {
            for (var bid of Object.keys(reg)) {
                if (reg[bid] != null) bindBlock(bid, reg[bid])
            }
        }
    }

    absorbGlobalBlockBindings()

    // ======================================================================== 服务端事件与全局导出

    var clearListenerRecordForPlayer = (uuid) => {
        if (!uuid) return
        for (var h of handles.values()) {
            if (h == null) continue
            releasePlayerListenCount(h, uuid)
            if (h.listeners[uuid]) {
                delete h.listeners[uuid]
                h.listenerCount = max2(0, h.listenerCount - 1)
            }
            if (h.mutedListeners) delete h.mutedListeners[uuid]
            if (h.listenerEnteredSeq) delete h.listenerEnteredSeq[uuid]
            if (h.listenerInRange) delete h.listenerInRange[uuid]
            if (h.listenerInRangeSeq) delete h.listenerInRangeSeq[uuid]
            if (h.listenerAnchorKey) delete h.listenerAnchorKey[uuid]
            if (h.listenerSentPos) delete h.listenerSentPos[uuid]
        }
        listenCount.delete(uuid)
    }

    if (typeof ServerEvents !== 'undefined' && ServerEvents != null && typeof ServerEvents.unloaded === 'function') {
        ServerEvents.unloaded(() => {
            handles.clear()
            keyIndex.clear()
            listenCount.clear()
            loginReadyTick.clear()
            mergeBoundSources.clear()
            dirtyMergeScopes.clear()
            boundAudioSeqByKey.clear()
            serverRef = null
        })
    }

    ServerEvents.tick((event) => {
        try {
            if (event.server != null) serverRef = event.server
            tickCounter++
            if (pendingReset && serverRef != null) {
                absorbGlobalBlockBindings()
                for (var p of onlinePlayers()) {
                    var pu = uuidOf(p)
                    if (pu != null) {
                        clearListenerRecordForPlayer(pu)
                        loginReadyTick.set(pu, tickCounter + 5)
                    }
                    sendPacket(p, { proto: PROTO_VERSION, act: 'reset', ses: SESSION })
                }
                pendingReset = false
            }
            if ((tickCounter % CONFIG.syncIntervalTicks) === 0 || dirtyMergeScopes.size > 0) {
                syncAll()
            }
        } catch (e) {
            reportWarning('tick', String(e))
        }
    })

    PlayerEvents.loggedIn((event) => {
        try {
            var p = event.player
            if (p == null) return
            var uuid = uuidOf(p)
            if (uuid != null) {
                clearListenerRecordForPlayer(uuid)
                loginReadyTick.set(uuid, tickCounter + 8)
            }
            sendPacket(p, { proto: PROTO_VERSION, act: 'reset', ses: SESSION })
        } catch (e) {
            reportWarning('loggedIn', String(e))
        }
    })

    PlayerEvents.loggedOut((event) => {
        try {
            var p = event.player
            if (p == null) return
            var uuid = uuidOf(p)
            if (uuid == null) return
            for (var h of handles.values()) {
                removeListener(h, uuid, null, 'offline')
            }
            listenCount.delete(uuid)
            loginReadyTick.delete(uuid)
        } catch (e) {
            reportWarning('loggedOut', String(e))
        }
    })

    var CONFIG_INT_LIMITS = {
        syncIntervalTicks:           { min: 1, max: 1200 },
        scanEnqInterval:             { min: 1, max: 1200 },
        scanSectionsPerTick:         { min: 1, max: 64 },
        defaultOneShotTicks:         { min: 1, max: 720000 },
        defaultActiveHold:           { min: 1, max: 12000 },
        unstartedTimeoutTicks:       { min: 0, max: 720000 },
        anchorGraceTicks:            { min: 0, max: 72000 },
        maxHandles:                  { min: 1, max: 8192 },
        maxPlayerHandles:            { min: 1, max: 4096 },
        maxCreatedHandlesPerPlayer:  { min: 1, max: 512 },
        maxHandlesPerPlayer:         { min: 1, max: 256 },
        maxPlayerHandlesPerListener: { min: 1, max: 256 },
        playerMaxPriority:           { min: 0, max: 10 },
        maxBroadcastTargets:         { min: 1, max: 256 },
        maxKeyLength:                { min: 16, max: 512 },
        listMaxLines:                { min: 1, max: 200 },
        errorLogIntervalMs:          { min: 0, max: 600000 }
    }
    var CONFIG_NUM_LIMITS = {
        rangeHysteresis: { min: 0, max: 256 },
        defaultRange:    { min: 1, max: 4096 },
        playerMaxRange:  { min: 8, max: 4096 },
        minRange:        { min: 0.5, max: 2048 },
        maxRange:        { min: 1, max: 4096 }
    }

    var configure = (patch) => {
        if (patch != null && typeof patch === 'object') {
            var cfgPatch = (patch.CONFIG && typeof patch.CONFIG === 'object') ? patch.CONFIG : patch
            for (var k of Object.keys(cfgPatch)) {
                if (!Object.prototype.hasOwnProperty.call(CONFIG, k) || cfgPatch[k] === undefined) continue
                var intRule = CONFIG_INT_LIMITS[k]
                var numRule = CONFIG_NUM_LIMITS[k]
                if (intRule != null || numRule != null) {
                    var n = Number(cfgPatch[k])
                    var rule = intRule || numRule
                    if (!isFinite(n) || n < rule.min || n > rule.max) {
                        reportWarning('configure', `配置项 CONFIG.${k}=${cfgPatch[k]} 超出有效范围 [${rule.min}, ${rule.max}]，已拒绝修改`)
                        continue
                    }
                    CONFIG[k] = intRule ? Math.floor(n) : n
                } else {
                    CONFIG[k] = cfgPatch[k]
                }
            }
            if (CONFIG.maxRange < CONFIG.minRange) {
                CONFIG.maxRange = CONFIG.minRange
            }
        }
        return CONFIG
    }

    global.EpiphyAudio = {
        VERSION:          VERSION,
        CHANNEL:          CHANNEL,
        CONFIG:           CONFIG,
        configure:        configure,
        version:          VERSION,
        channel:          CHANNEL,
        config:           CONFIG,
        play:             play,
        safePlay:         safePlay,
        send:             play,
        safeSend:         safePlay,
        toPlayer:         toPlayer,
        at:               at,
        atBlock:          atBlock,
        onEntity:         onEntity,
        inDimension:      inDimension,
        toAll:            toAll,
        atEvent:          atEvent,
        bindBlock:        bindBlock,
        watchBlock:       bindBlock,
        unbindBlock:      unbindBlock,
        unwatchBlock:     unbindBlock,
        scanBlocksNow:    scanBlocksNow,
        stop:             stop,
        stopKey:          stopKey,
        stopTag:          stopTag,
        stopGroup:        stopTag,
        stopAtBlock:      stopAtBlock,
        stopOnEntity:     stopOnEntity,
        stopInDimension:  stopInDimension,
        stopSound:        stopSound,
        stopFor:          stopFor,
        stopAll:          stopAll,
        exclude:          exclude,
        include:          include,
        update:           update,
        isPlaying:        isPlaying,
        get:              get,
        getByKey:         getByKey,
        list:             list,
        listeners:        listeners,
        on:               on,
        getStats:         () => getStats(),
        _pure:            Object.freeze({ parseOptions: (str) => parseOptions(str) })
    }

    // ========================================================================
    //  第二部分：向权限阀组件 (EpiphyPermissionValve) 声明 `audio` 子命令与帮助手册
    // ========================================================================

    var AUDIO_HELP_LINES = [
        '§3§l----------------------------------------------------',
        '§b§l  [ Epiphy 空间音频与声场组件 // /epiphy audio 帮助手册 ]',
        '§3§l----------------------------------------------------',
        '§e1. 查看音频帮助： §f/epiphy audio help §7(或 §f/epiphy help audio§7)',
        '§e2. 指定玩家播放： §f/epiphy audio play <玩家> <音频ID> [可选参数...]',
        '§e3. 跟随实体播放： §f/epiphy audio follow <实体> <音频ID> [可选参数...]',
        '§e4. 当前维度坐标： §f/epiphy audio at <x> <y> <z> <音频ID> [可选参数...]',
        '§e5. 指定维度坐标： §f/epiphy audio pos <维度> <x> <y> <z> <音频ID> [可选参数...]',
        '§e6. 维度广域广播： §f/epiphy audio dim <维度> <音频ID> [可选参数...]',
        '§e7. 全服广域广播： §f/epiphy audio all <音频ID> [可选参数...]',
        '§e8. 实时调制句柄： §f/epiphy audio update <句柄号或key> <volume=/pitch=/range=...> §8(无损热更新)',
        '§e9. 停止与查询：   §f/epiphy audio stop <句柄号或key> [fadeOut] §7| §fstoptag <标签> §7| §fstopall [fadeOut]',
        '§e                  §f/epiphy audio stopsound <音频ID> [玩家] §7| §fstopfor <玩家> [音频ID] §7| §flist §7| §finfo <句柄>',
        '§7----------------------------------------------------',
        '§6【可选键值参数语法（所有非必填参数均可直接省略不写）】：',
        '  §bloop=§ftrue|false §7(或直接写单词 §floop§7) §8| §blife=§fonce(单次)|loop(循环)|active(心跳续期)',
        '  §bfalloff=§flinear(3D线性)|smooth(平滑曲线，支持立体声距离衰减)|cutoff(范围内恒定音量、出界截断)|flat(2D贴耳)',
        '  §brange=§f可听半径格数(1~512，默认 32) §7| §bvolume=§f0.0~2.0(默认 1.0) §7| §bpitch=§f0.5~2.0(默认 1.0)',
        '  §bfadein=§f淡入时长(如 20 或 1s) §7| §bfadeout=§f停止/离开时软淡出时长(如 20 或 1s)',
        '  §bduck=§ftrue|false(BGM生效时自动避让原版背景音乐，循环RECORDS/MUSIC默认开启)',
        '  §bduration=§f单次维持时长(如 100t / 5s) §7| §blifetime=§f循环最长存活时长(如 2m)',
        '  §bdelay=§f延迟启动时长(如 40t / 2s) §7| §bstartonenter=§ftrue(有玩家进入范围才开始播放)',
        '  §bstoponbreak=§ftrue(方块破坏自动停止) §7| §bstoponempty=§ftrue(全员离开范围后自动停止)',
        '  §baudience=§fnear(附近)|self(仅锚点本人)|players(指定玩家)|dim(全维度)|all(全服)',
        '  §bcategory=§frecords(默认)|music|master|ambient|block|hostile|player|voice',
        '  §bkey=§f唯一标识键 §7| §btag=§f分组标签 §7| §bpriority=§flow|normal|high|critical|active §7| §breplace=§ftrue',
        '§7----------------------------------------------------',
        '§d【示例 1（在脚下放置 30 格平滑衰减循环音乐，离开时 1 秒淡出）】：',
        '  §f/epiphy audio at ~ ~ ~ epiphy:children_of_the_city loop range=30 falloff=smooth fadein=1s fadeout=1s key=city_bgm',
        '§d【示例 2（跟随自身实体的防空警报，仅 48 格内可听）】：',
        '  §f/epiphy audio follow @s epiphy:air_raid_siren loop range=48 falloff=linear key=siren_alert'
    ]

    var AUDIO_SPEC_SCHEMA = {
        unknownMode: 'error',
        aliases: {
            vol:         'volume',
            pit:         'pitch',
            radius:      'range',
            r:           'range',
            life:        'lifeMode',
            mode:        'falloff',
            cat:         'category',
            dur:         'duration',
            stay:        'duration',
            holdticks:   'activeHold',
            startdelay:  'delay',
            late:        'lateJoin',
            duck:        'duckMusic',
            outofrange:  'outOfRangeMode',
            omode:       'outOfRangeMode',
            conflict:    'conflictMode',
            restart:     'replace',
            importance:  'priority',
            stoponbreak: 'stopOnBlockBreak',
            stoponempty: 'stopWhenEmpty',
            maxlisteners:'maxTriggers'
        },
        bareWords: {
            loop:    { key: 'loop',     value: true },
            once:    { key: 'loop',     value: false },
            active:  { key: 'lifeMode', value: 'active' },
            replace: { key: 'replace',  value: true },
            restart: { key: 'replace',  value: true },
            linear:  { key: 'falloff',  value: 'linear' },
            smooth:  { key: 'falloff',  value: 'smooth' },
            cutoff:  { key: 'falloff',  value: 'cutoff' },
            flat:    { key: 'falloff',  value: 'flat' },
            near:    { key: 'audience', value: 'near' },
            self:    { key: 'audience', value: 'self' },
            all:     { key: 'audience', value: 'all' }
        },
        fields: {
            volume:            'strictNum',
            pitch:             'strictNum',
            range:             'strictNum',
            maxTriggers:       'strictNum',
            loop:              'strictBool',
            lateJoin:          'strictBool',
            resume:            'strictBool',
            duckMusic:         'strictBool',
            replace:           'strictBool',
            startOnEnter:      'strictBool',
            requireRedstone:   'strictBool',
            stopOnBlockBreak:  'strictBool',
            stopOnRedstoneOff: 'strictBool',
            stopOnEntityDeath: 'strictBool',
            stopWhenEmpty:     'strictBool',
            lifeMode:          'str',
            falloff:           'str',
            category:          'str',
            duration:          'str',
            lifetime:          'str',
            activeHold:        'str',
            delay:             'str',
            fadeIn:            'str',
            fadeOut:           'str',
            outOfRangeMode:    'str',
            conflictMode:      'str',
            conflictScope:     'str',
            audience:          'str',
            priority:          'str',
            key:               'str',
            tag:               'str',
            group:             'str'
        }
    }

    var parseOptions = (str) => {
        if (str == null || String(str).trim().length === 0) return { opts: {} }
        var res = SPEC.parseCommandSpec(str, AUDIO_SPEC_SCHEMA)
        if (!res.ok) return { error: res.error }
        if (res.opts != null) {
            delete res.opts._sourceTier
            delete res.opts._ownerUuid
        }
        return { opts: res.opts }
    }

    var resolveAudioActorTier = (source) => {
        var valve = (typeof global !== 'undefined') ? global.EpiphyPermissionValve : null
        if (valve != null && typeof valve.getCommandActorTier === 'function') {
            return valve.getCommandActorTier(source)
        }
        if (source != null) {
            var pl = (typeof source.getPlayer === 'function') ? source.getPlayer() : source.player
            if (pl != null) {
                // 权限阀缺失时 Fail-Closed：绝不信任 bare hasPermissions(2)
                var isOp = Boolean(typeof pl.isOp === 'function' && pl.isOp())
                var u = uuidOf(pl)
                return {
                    tier:     isOp ? 'system' : 'player',
                    isPlayer: true,
                    isOp:     isOp,
                    uuid:     u ? String(u).trim().toLowerCase() : '',
                    name:     nameOf(pl) || '',
                    player:   pl
                }
            }
        }
        return { tier: 'system', isPlayer: false, isOp: true, uuid: '', name: '', player: null }
    }

    var isHandleOwnedByActor = (h, actor) =>
        Boolean(h != null && h.sourceTier === 'player' && actor != null && actor.uuid && h.ownerUuid === actor.uuid)

    var buildAudioCommandNode = (ctxReg) => {
        var cb = BASE.createCommandBuilder(ctxReg, { tag: 'EpiphyAudio' })

        var cmdErr = (sourceOrCtx, msg) => cb.replyErr(sourceOrCtx, `${msg} §7(输入 §f/epiphy audio help §7查看语法)`)

        var resolveHandleForActor = (ref, actor) => {
            if (actor == null || actor.tier !== 'player') return resolveHandle(ref)
            if (typeof ref === 'string') {
                var s = ref.trim()
                if (/^\d+$/.test(s)) {
                    var byId = resolveHandle(s)
                    return isHandleOwnedByActor(byId, actor) ? byId : null
                }
                var scoped = resolveHandle(`u:${actor.uuid}:${s}`)
                if (isHandleOwnedByActor(scoped, actor)) return scoped
                var direct = resolveHandle(s)
                return isHandleOwnedByActor(direct, actor) ? direct : null
            }
            var h = resolveHandle(ref)
            return isHandleOwnedByActor(h, actor) ? h : null
        }

        var stopForActorFilter = (actor, players, soundId, fadeOut) => {
            var sid = null
            if (soundId != null && String(soundId).trim() !== '' && String(soundId).trim() !== '*') {
                sid = normalizeSoundId(soundId)
                if (sid == null) return 0
            }
            var col = collectPlayerUuids(players)
            if (col.count === 0) return 0
            var fout = parseTicks(fadeOut, true)
            var snap = snapshotPlayers()
            var affected = 0
            for (var h of handles.values()) {
                if (!isHandleOwnedByActor(h, actor)) continue
                if (sid != null && h.sound !== sid) continue
                var touched = false
                for (var u of Object.keys(col.uuids)) {
                    h.excluded[u] = true
                    if (h.listeners[u]) {
                        removeListener(h, u, snap.byUuid[u] || null, 'excluded', fout)
                        touched = true
                    }
                }
                if (touched) affected++
            }
            return affected
        }

        var hasAudioBroadcastGrant = (actor) => {
            if (actor == null || actor.tier !== 'player') return true
            var valve = (typeof global !== 'undefined') ? global.EpiphyPermissionValve : null
            if (valve == null || actor.player == null) return false
            if (typeof valve.hasPlayerScope === 'function') {
                return Boolean(valve.hasPlayerScope(serverRef, actor.player, 'audio.broadcast', { exactScopeOnly: true }))
            }
            return false
        }

        var runPlayCommand = (source, fields, optionStr) => {
            var parsed = parseOptions(optionStr)
            if (parsed.error) return cmdErr(source, parsed.error)
            var merged = withFields(parsed.opts, fields)
            var actor  = resolveAudioActorTier(source)
            if (actor.tier === 'player') {
                var srcDim = dimOfLevel(levelOf(actor.player))
                var aud    = merged.audience || ''
                var needBroadcast = false
                if (Array.isArray(merged.players) && merged.players.length > CONFIG.maxBroadcastTargets) {
                    needBroadcast = true
                } else if (aud === 'all' && onlinePlayers().length > CONFIG.maxBroadcastTargets) {
                    needBroadcast = true
                } else if (aud === 'dim') {
                    var targetDim = resolveDimId(merged.dim)
                    var dimCount  = 0
                    for (var dp of onlinePlayers()) {
                        if (dimOfLevel(levelOf(dp)) === targetDim) dimCount++
                    }
                    if ((srcDim && targetDim && srcDim !== targetDim) || dimCount > CONFIG.maxBroadcastTargets) {
                        needBroadcast = true
                    }
                } else if (merged.at != null && merged.dim != null) {
                    var posDim = resolveDimId(merged.dim)
                    if (srcDim && posDim && srcDim !== posDim) needBroadcast = true
                }
                if (merged.range != null && isFinite(Number(merged.range)) && Number(merged.range) > CONFIG.playerMaxRange) {
                    needBroadcast = true
                }
                if (needBroadcast && !hasAudioBroadcastGrant(actor)) {
                    return cmdErr(source, `权限不足：影响超过 ${CONFIG.maxBroadcastTargets} 名玩家、跨维度或超出范围上限 (${CONFIG.playerMaxRange}格) 的音频广播需要额外授予 [audio.broadcast] 作用域`)
                }
                merged._sourceTier = 'player'
                merged._ownerUuid  = actor.uuid
            } else {
                merged._sourceTier = 'system'
                merged._ownerUuid  = ''
            }
            var id = play(merged)
            if (id > 0) {
                var info = get(id)
                var stateDesc = (info && info.waitingStart)
                    ? '已挂起等待启动条件满足'
                    : `当前收听 §f${info != null ? info.listeners : 0}§7 人`
                cb.replyOk(source, `§7已调度 §f${fields.sound}§7（句柄 §e#${id}§7，${stateDesc}）`)
                return 1
            }
            return cmdErr(source, '播放未生效：参数无效、非循环音频范围内无在线玩家、或玩家/全服句柄配额已满')
        }

        var soundChain = (prefixArgs, handler) => {
            var specs = prefixArgs.concat([
                { name: 'sound', type: 'sound' },
                { name: 'options', type: 'greedy' }
            ])
            return [
                specs,
                (ctx, v) => handler(ctx, v, v._count >= specs.length ? v.options : ''),
                { minArgs: prefixArgs.length + 1 }
            ]
        }

        var describeHandle = (info) => {
            if (info == null) return '§7(null)'
            var keyPart = info.key ? ` key=§f${info.key}§7` : ''
            var ancDesc = info.anchor === 'pos'
                ? `${Math.round(info.x)},${Math.round(info.y)},${Math.round(info.z)}@${info.dim || '?'}`
                : (info.anchor === 'entity'
                    ? `entity:${info.entityUuid || '?'}`
                    : (info.anchor === 'block' ? `block(${info.blockId || '?'})` : 'none'))
            var flags = []
            if (info.loop) flags.push('loop')
            if (info.waitingStart) flags.push('wait')
            var flagPart = flags.length > 0 ? ` [${flags.join(',')}]` : ''
            return `§e#${info.id}§7${keyPart} §f${info.sound}§7 pri=§b${info.priority}§7 listeners=§a${info.listeners}§7 anc=§7${ancDesc}${flagPart}`
        }

        return cb.literal('audio', {
            helpLines: AUDIO_HELP_LINES,
            children: [
                cb.literal('help', { scope: 'audio.help', helpLines: AUDIO_HELP_LINES }),
                cb.literal('play', {
                    scope: 'audio.play',
                    chain: soundChain([{ name: 'targets', type: 'players' }], (ctx, v, opt) => {
                        if (v.targets.length === 0) return cmdErr(ctx.source, '未匹配到任何在线玩家')
                        return runPlayCommand(ctx.source, { sound: v.sound, players: v.targets }, opt)
                    })
                }),
                cb.literal('follow', {
                    scope: 'audio.follow',
                    chain: soundChain([{ name: 'entity', type: 'entity' }], (ctx, v, opt) =>
                        runPlayCommand(ctx.source, { sound: v.sound, entity: v.entity }, opt)
                    )
                }),
                cb.literal('at', {
                    scope: 'audio.at',
                    chain: soundChain([{ name: 'pos', type: 'vec3' }], (ctx, v, opt) => {
                        var lv = typeof ctx.source.getLevel === 'function' ? ctx.source.getLevel() : ctx.source.level
                        var dim = dimOfLevel(lv)
                        if (v.pos == null || dim == null) return cmdErr(ctx.source, '无法确定目标坐标或当前维度')
                        return runPlayCommand(ctx.source, { sound: v.sound, at: v.pos, dim: dim }, opt)
                    })
                }),
                cb.literal('pos', {
                    scope: 'audio.pos',
                    chain: soundChain([
                        { name: 'dimension', type: 'dim' },
                        { name: 'pos', type: 'vec3' }
                    ], (ctx, v, opt) => {
                        if (v.pos == null || v.dimension == null) return cmdErr(ctx.source, '无法解析目标维度或坐标')
                        return runPlayCommand(ctx.source, { sound: v.sound, at: v.pos, dim: v.dimension }, opt)
                    })
                }),
                cb.literal('dim', {
                    scope: 'audio.dim',
                    chain: soundChain([{ name: 'dimension', type: 'dim' }], (ctx, v, opt) => {
                        if (v.dimension == null) return cmdErr(ctx.source, '无法解析目标维度')
                        return runPlayCommand(ctx.source, { sound: v.sound, dim: v.dimension, audience: 'dim' }, opt)
                    })
                }),
                cb.literal('all', {
                    scope: 'audio.all',
                    chain: soundChain([], (ctx, v, opt) =>
                        runPlayCommand(ctx.source, { sound: v.sound, audience: 'all' }, opt)
                    )
                }),
                cb.literal('update', {
                    scope: 'audio.update',
                    chain: [[
                        { name: 'ref', type: 'string' },
                        { name: 'options', type: 'greedy' }
                    ], (ctx, v) => {
                        var parsed = parseOptions(v.options)
                        if (parsed.error) return cmdErr(ctx.source, parsed.error)
                        var actor = resolveAudioActorTier(ctx.source)
                        if (actor.tier === 'player') {
                            var ownH = resolveHandleForActor(v.ref, actor)
                            if (ownH == null) return cmdErr(ctx.source, `未找到你名下的句柄 [${v.ref}]（普通授权玩家无权修改系统或他人音频）`)
                            if (parsed.opts.priority != null) {
                                parsed.opts.priority = min2(parsePriority(parsed.opts.priority, ownH.priority), CONFIG.playerMaxPriority)
                            }
                            if (update(ownH.id, parsed.opts)) return cb.replyOk(ctx.source, `§7已实时热更新句柄 [${v.ref}]`)
                            return cmdErr(ctx.source, `更新句柄 [${v.ref}] 失败`)
                        }
                        if (update(v.ref, parsed.opts)) return cb.replyOk(ctx.source, `§7已实时热更新句柄 [${v.ref}]`)
                        return cmdErr(ctx.source, `未找到句柄或 key [${v.ref}]`)
                    }]
                }),
                cb.literal('stop', {
                    scope: 'audio.stop',
                    chain: [[
                        { name: 'ref', type: 'string' },
                        { name: 'fadeOut', type: 'word' }
                    ], (ctx, v) => {
                        var actor = resolveAudioActorTier(ctx.source)
                        var n = 0
                        if (actor.tier === 'player') {
                            var rawRef = String(v.ref || '').trim()
                            var foutP  = (v._count >= 2) ? v.fadeOut : undefined
                            if (rawRef === '*' || rawRef === 'all') {
                                n = endMatching((h) => isHandleOwnedByActor(h, actor), foutP)
                            } else {
                                var matchedH = resolveHandleForActor(rawRef, actor)
                                if (matchedH != null) {
                                    n = endHandle(matchedH, 'stopped', null, parseTicks(foutP, true)) ? 1 : 0
                                } else {
                                    var sidP = normalizeSoundId(rawRef)
                                    n = endMatching((h) => isHandleOwnedByActor(h, actor) && (h.tag === rawRef || h.group === rawRef || (sidP != null && h.sound === sidP)), foutP)
                                }
                            }
                            if (n > 0) return cb.replyOk(ctx.source, `§7已停止你名下匹配 [${v.ref}] 的 ${n} 个音频句柄`)
                            return cmdErr(ctx.source, `未找到你名下匹配 [${v.ref}] 的活动句柄（无法停止系统或他人音频）`)
                        }
                        n = (v._count >= 2) ? stop(v.ref, v.fadeOut) : stop(v.ref)
                        if (n > 0) {
                            var msg = (v._count >= 2)
                                ? `§7已软停止 [${v.ref}] (fadeOut=${v.fadeOut}, 共 ${n} 个句柄)`
                                : `§7已停止 [${v.ref}] (共 ${n} 个句柄)`
                            return cb.replyOk(ctx.source, msg)
                        }
                        return cmdErr(ctx.source, `未找到匹配 [${v.ref}] 的活动句柄`)
                    }, { minArgs: 1 }]
                }),
                cb.literal('stopkey', {
                    scope: 'audio.stopkey',
                    chain: [[{ name: 'key', type: 'string' }], (ctx, v) => {
                        var actor = resolveAudioActorTier(ctx.source)
                        if (actor.tier === 'player') {
                            var h = resolveHandleForActor(v.key, actor)
                            if (h != null && endHandle(h, 'stopped')) return cb.replyOk(ctx.source, `§7已停止你名下的 key=${v.key}`)
                            return cmdErr(ctx.source, `没有找到你名下 key=${v.key} 的句柄`)
                        }
                        if (stopKey(v.key) > 0) return cb.replyOk(ctx.source, `§7已停止 key=${v.key}`)
                        return cmdErr(ctx.source, `没有找到 key=${v.key} 的句柄`)
                    }]
                }),
                cb.literal('stoptag', {
                    scope: 'audio.stoptag',
                    chain: [[{ name: 'tag', type: 'string' }], (ctx, v) => {
                        var actor = resolveAudioActorTier(ctx.source)
                        if (actor.tier === 'player') {
                            var t = String(v.tag || '').trim()
                            var nOwn = endMatching((h) => isHandleOwnedByActor(h, actor) && (t === '*' || t === 'all' || h.tag === t || h.group === t || h.key === t || h.key === `u:${actor.uuid}:${t}`))
                            cb.replyOk(ctx.source, `§7已停止你名下 tag/group=${v.tag} 的 ${nOwn} 个句柄`)
                            return nOwn > 0 ? 1 : 0
                        }
                        var n = stopTag(v.tag)
                        cb.replyOk(ctx.source, `§7已停止 tag/group=${v.tag} 的 ${n} 个句柄`)
                        return n > 0 ? 1 : 0
                    }]
                }),
                cb.literal('stopsound', {
                    scope: 'audio.stopsound',
                    chain: [[
                        { name: 'sound', type: 'sound' },
                        { name: 'targets', type: 'players' }
                    ], (ctx, v) => {
                        var actor = resolveAudioActorTier(ctx.source)
                        if (actor.tier === 'player') {
                            if (v._count >= 2) {
                                var nF = stopForActorFilter(actor, v.targets, v.sound)
                                cb.replyOk(ctx.source, `§7已对你名下句柄在 ${v.targets.length} 名玩家处停止该音频，涉及 ${nF} 个句柄`)
                                return nF > 0 ? 1 : 0
                            }
                            var sidOwn = normalizeSoundId(v.sound)
                            var nS = sidOwn != null ? endMatching((h) => isHandleOwnedByActor(h, actor) && h.sound === sidOwn) : 0
                            cb.replyOk(ctx.source, `§7已结束你名下的 ${nS} 个句柄`)
                            return nS > 0 ? 1 : 0
                        }
                        var n = (v._count >= 2) ? stopFor(v.targets, v.sound) : stopSound(v.sound)
                        var msg = (v._count >= 2)
                            ? `§7已对 ${v.targets.length} 名玩家停止该音频，涉及 ${n} 个句柄`
                            : `§7已结束 ${n} 个句柄`
                        cb.replyOk(ctx.source, msg)
                        return n > 0 ? 1 : 0
                    }, { minArgs: 1 }]
                }),
                cb.literal('stopfor', {
                    scope: 'audio.stopfor',
                    chain: [[
                        { name: 'targets', type: 'players' },
                        { name: 'sound', type: 'sound' }
                    ], (ctx, v) => {
                        var actor = resolveAudioActorTier(ctx.source)
                        var n = (actor.tier === 'player')
                            ? stopForActorFilter(actor, v.targets, v._count >= 2 ? v.sound : null)
                            : stopFor(v.targets, v._count >= 2 ? v.sound : null)
                        var kind = v._count >= 2 ? '指定音频' : '全部音频'
                        cb.replyOk(ctx.source, `§7已对 ${v.targets.length} 名玩家停止${actor.tier === 'player' ? '你名下的' : ''}${kind}，涉及 ${n} 个句柄`)
                        return n > 0 ? 1 : 0
                    }, { minArgs: 1 }]
                }),
                cb.literal('stopall', {
                    scope: 'audio.stopall',
                    chain: [[{ name: 'fadeOut', type: 'word' }], (ctx, v) => {
                        var actor = resolveAudioActorTier(ctx.source)
                        var hasFo = v._count >= 1
                        if (actor.tier === 'player') {
                            var nOwn = endMatching((h) => isHandleOwnedByActor(h, actor), hasFo ? v.fadeOut : undefined)
                            return cb.replyOk(ctx.source, `§7已停止你名下全部 ${nOwn} 个活动句柄（未触及系统或他人音频）`)
                        }
                        var n = hasFo ? stopAll(v.fadeOut) : stopAll()
                        var msg = hasFo
                            ? `§7已软停止全部 ${n} 个活动句柄 (fadeOut=${v.fadeOut})`
                            : `§7已结束全部 ${n} 个活动句柄`
                        return cb.replyOk(ctx.source, msg)
                    }, { minArgs: 0 }]
                }),
                cb.literal('list', {
                    scope: 'audio.list',
                    exec: (ctx) => {
                        var all = list()
                        cb.replyOk(ctx.source, `§7当前活动音频句柄 ${all.length} 个${all.length > CONFIG.listMaxLines ? `（仅展示前 ${CONFIG.listMaxLines} 个）` : ''}`)
                        for (var i = 0; i < all.length && i < CONFIG.listMaxLines; i++) {
                            cb.sendText(ctx.source, describeHandle(all[i]))
                        }
                        return 1
                    }
                }),
                cb.literal('info', {
                    scope: 'audio.info',
                    chain: [[{ name: 'ref', type: 'string' }], (ctx, v) => {
                        var info = get(v.ref)
                        if (info == null) return cmdErr(ctx.source, `句柄或 key [${v.ref}] 不存在`)
                        cb.sendText(ctx.source, describeHandle(info))
                        var names = listeners(v.ref)
                        cb.sendText(ctx.source, `§7当前收听玩家: §f${names.length > 0 ? names.join(', ') : '（无）'}`)
                        return 1
                    }]
                })
            ]
        })
    }

    var audioSubcommandSpec = {
        name:       'audio',
        permission: {
            mode:                 'authorized',
            label:                '可作弊 + 管理员/已授权对象',
            requireCheats:        true,
            requireOp:            true,
            allowAuthorized:      true,
            opLevel:              2,
            allowCommandBlock:    true,
            allowConsole:         true,
            allowDeclaredCallers: true,
            allowedCallers:       null
        },
        scopes: [
            { scope: 'audio.play',      desc: '向指定目标玩家播放音频' },
            { scope: 'audio.follow',    desc: '绑定实体移动播放音频' },
            { scope: 'audio.at',        desc: '在当前维度指定坐标播放音频' },
            { scope: 'audio.pos',       desc: '指定维度和坐标播放音频' },
            { scope: 'audio.dim',       desc: '向指定维度播放音频' },
            { scope: 'audio.all',       desc: '向全体玩家播放音频（超过 4 人需 audio.broadcast）' },
            { scope: 'audio.broadcast', desc: '允许非 OP 超过 4 人或跨维度音频广播（需单独授予）' },
            { scope: 'audio.update',    desc: '热更新音频句柄参数' },
            { scope: 'audio.stop',      desc: '停止自己名下的音频句柄' },
            { scope: 'audio.stopkey',   desc: '按 key 停止音频' },
            { scope: 'audio.stoptag',   desc: '按 tag/group 停止音频' },
            { scope: 'audio.stopsound', desc: '按 soundId 停止音频' },
            { scope: 'audio.stopfor',   desc: '对指定玩家静默排除音频' },
            { scope: 'audio.stopall',   desc: '停止自己名下全部音频' },
            { scope: 'audio.list',      desc: '查看当前活动音频句柄列表' },
            { scope: 'audio.info',      desc: '查看单个音频句柄详情' },
            { scope: 'audio.help',      desc: '查看 /epiphy audio 帮助' }
        ],
        summary:   '通用空间音频与流式声场调度指令 (/epiphy audio ...)',
        helpLines: AUDIO_HELP_LINES,
        buildNode: buildAudioCommandNode
    }

    try {
        BASE.registerSubcommandSafe(audioSubcommandSpec)
    } catch (eReg) {
        LOGGER.warn('commandReg', `注册 /epiphy audio 指令时出现异常，已终止指令注册: ${eReg}`)
    }

    var getAudioTrackerCalls = () => {
        var t = (typeof global !== 'undefined' && global != null) ? global.EpiphyBlockTracker : null
        var st = (t != null && typeof t.getStats === 'function') ? t.getStats() : null
        return (st != null && st.subscriberCalls != null && st.subscriberCalls.audio != null)
            ? st.subscriberCalls.audio : 0
    }

    var getStats = () => {
        var tracker    = audioBlockTracker
        var isFb       = Boolean(tracker != null && tracker.isFallback)
        var mode       = (tracker != null && !tracker.isFallback) ? 'tracker' : 'fallback'
        var fbBindings = (isFb && typeof tracker.getBindingCount === 'function') ? tracker.getBindingCount() : 0
        var fbTracked  = (isFb && typeof tracker.getTrackedRecords === 'function') ? tracker.getTrackedRecords(null).length : 0
        return {
            handlesSize:         handles.size,
            maxHandles:          CONFIG.maxHandles,
            keyIndexSize:        keyIndex.size,
            listenCountSize:     listenCount.size,
            trackerMode:         mode,
            lastSyncAllMs:       lastSyncAllMs,
            lastActiveSyncAllMs: lastActiveSyncAllMs,
            maxSyncAllMs:        maxSyncAllMs,
            syncAllCount:        syncAllCount,
            lastSyncTick:        lastSyncAllTick,
            currentTick:         tickCounter,
            trackedRecordsCalls: getAudioTrackerCalls(),
            fallbackBindings:    fbBindings,
            fallbackTracked:     fbTracked,
            valveMissing:        !BASE.isValveReady(),
            debug:               Boolean(CONFIG.debug)
        }
    }

    var audioDebugProvider = {
        name:    'audio',
        label:   '空间音频组件',
        order:   50,
        summary: () => {
            var s = getStats()
            return `handles.size=${s.handlesSize} | syncAll=${s.lastSyncAllMs.toFixed(3)}ms` +
                ` (active=${s.lastActiveSyncAllMs.toFixed(3)}ms, max=${s.maxSyncAllMs.toFixed(3)}ms)` +
                ` | listeners=${s.listenCountSize} | mode=${s.trackerMode}`
        },
        detail: () => {
            var s = getStats()
            return [
                `handles.size: ${s.handlesSize} / max=${s.maxHandles}, keyIndex.size=${s.keyIndexSize}`,
                `listenCount.size: ${s.listenCountSize}, trackerMode=${s.trackerMode}`,
                `syncAllMs: last=${s.lastSyncAllMs.toFixed(3)}ms, lastActive=${s.lastActiveSyncAllMs.toFixed(3)}ms, max=${s.maxSyncAllMs.toFixed(3)}ms`,
                `syncAllCount: ${s.syncAllCount}, lastSyncTick=${s.lastSyncTick}, currentTick=${s.currentTick}`,
                `getTrackedRecords(audio): ${s.trackedRecordsCalls}`,
                `fallbackBindings=${s.fallbackBindings}, fallbackTracked=${s.fallbackTracked}`,
                `valveMissing=${s.valveMissing}, CONFIG.debug=${s.debug}`
            ]
        },
        metrics: getStats,
        check: () => {
            var hasRealTracker = (audioBlockTracker != null && !audioBlockTracker.isFallback)
            var vMissing = !BASE.isValveReady()
            return [
                {
                    name:   'handles_headroom',
                    ok:     handles.size < Math.floor(CONFIG.maxHandles * 0.9),
                    detail: `handles=${handles.size}/${CONFIG.maxHandles}`
                },
                {
                    name:   'valve_registered',
                    ok:     !vMissing,
                    detail: `valveMissing=${vMissing}`
                },
                {
                    name:   'block_tracker_attached',
                    ok:     hasRealTracker || audioBlockTracker == null,
                    detail: `tracker=${audioBlockTracker == null ? 'lazy_uninit' : (hasRealTracker ? 'EpiphyBlockTracker' : 'fallback')}`
                }
            ]
        },
        actions: {
            rescan: {
                desc: '重扫在线玩家周边音频绑定方块',
                fn: () => {
                    var n = scanBlocksNow()
                    var trackerApi = (typeof global !== 'undefined') ? global.EpiphyBlockTracker : null
                    var st = (trackerApi != null && typeof trackerApi.getLastScanStatus === 'function')
                        ? trackerApi.getLastScanStatus()
                        : null
                    if (st != null && st.blockedByQueue) {
                        return `当前扫描队列已满（${st.queuePending}/${st.maxQueue}，排队消化中），本次跳过入队，请稍后重试`
                    }
                    if (st != null && st.truncatedByQueue && n > 0) {
                        return `音频绑定方块已入队扫描 ${n} 个区块段（队列已接近上限 ${st.maxQueue}，剩余区段将在消费后继续）`
                    }
                    return `音频绑定方块已入队扫描 ${n} 个区块段`
                }
            },
            stopall: {
                desc: '停止当前全部活动音频句柄',
                fn: () => {
                    var n = stopAll()
                    return `已停止全部 ${n} 个音频句柄`
                }
            },
            resetmetrics: {
                desc: '重置 syncAll 峰值与累计耗时计数',
                fn: () => {
                    lastSyncAllMs       = 0
                    lastActiveSyncAllMs = 0
                    maxSyncAllMs        = 0
                    syncAllCount        = 0
                    return '已清零 syncAll 耗时统计'
                }
            }
        }
    }
    BASE.registerDebugProvider(audioDebugProvider)
})()
