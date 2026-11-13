// priority: 500
// ============================================================================
//  通用空间音频与流式声场组件 —— 服务端调度器 (EpiphyAudio v5.2, ES6)
//  所属系列：Epiphy的-通用组件系列（本系列包含 startup / server / client 配套脚本）
//  [LLM 协作规范] 每次进行较大修改或重构前，请先将修改同步至 D:\Git-Epiphy 并执行 git commit 保存当前可用状态，便于随时回退与对比 diff。
//  许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
//  放置位置：kubejs/server_scripts/通用组件/Epiphy的-音频组件.js
//  配套客户端播放器：kubejs/client_scripts/通用组件/Epiphy的-音频播放器.js (EpiphyAudioClient v5.2)
//  配套权限阀组件：kubejs/server_scripts/通用组件/Epiphy的-权限阀.js（管理 /epiphy 根命令与执行权限，本组件向其声明 audio 子命令与帮助手册）
//
//  依赖与缺失降级行为：
//    - 必需配套：kubejs/client_scripts/通用组件/Epiphy的-音频播放器.js（缺失时服务端可正常调度句柄，但客户端无声音输出）
//    - 协议契约：kubejs/startup_scripts/通用组件/Epiphy的-协议常量.js (EpiphyProtocol, priority: 1200)
//      缺失时启动输出 console.warn 并回退至内联兜底协议版本 (5)；若双端内联版本不一致，客户端将 fail-closed 拒收报文
//    - 可选依赖：kubejs/server_scripts/通用组件/Epiphy的-日志.js (EpiphyLog, priority: 1100)
//      缺失时回退至内联 console.warn / console.error 兜底日志（失去统一限频与去重）
//    - 可选依赖：kubejs/server_scripts/通用组件/Epiphy的-方块追踪组件.js (EpiphyBlockTracker, priority: 1050)
//      缺失时 bindBlock 降级为基础事件兜底模式（仅支持新放置/破坏方块，无区块扫描与持久化），不影响 play / toPlayer / at / onEntity 等常规 API
//    - 可选依赖：kubejs/server_scripts/通用组件/Epiphy的-权限阀.js (EpiphyPermissionValve, priority: 1000)
//      缺失时 /epiphy audio 指令不生效（OP 登录时提示），JS 调用接口正常；后续 /reload 补全权限阀后会自动从队列补注册并复位提示标志
//
//  适用环境：Minecraft 1.20.1 / Forge 47.x / KubeJS 2001.6.x (ES6)
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
    var PROTO         = (typeof global !== 'undefined' && global.EpiphyProtocol != null) ? global.EpiphyProtocol : null
    var CHANNEL       = (PROTO && PROTO.AUDIO_CHANNEL) || 'epiphy:audio'
    var PROTO_VERSION = (PROTO && PROTO.AUDIO_PROTO_VERSION) || 5
    var VERSION       = (PROTO && PROTO.AUDIO_SEMVER) || '5.2.0'
    if (PROTO == null) {
        console.warn(`[EpiphyAudio] 未检测到 startup_scripts/通用组件/Epiphy的-协议常量.js (EpiphyProtocol)，将使用内联兜底协议版本 ${PROTO_VERSION}；若双端版本不一致将被客户端拒收。`)
    }

    var CONFIG = {
        syncIntervalTicks:   5,              // 资格、锚点与条件同步周期 (tick)
        scanEnqInterval:     20,             // 绑定方块渐进式区块段入队周期 (tick)
        scanSectionsPerTick: 2,              // 每 tick 最多扫描的 16x16x16 区块段数（零卡顿发现存档已有方块）
        rangeHysteresis:     2.0,            // 已收听玩家的离开判定迟滞放宽距离 (格)，防边界闪烁
        defaultRange:        32,
        minRange:            1,
        maxRange:            512,
        defaultOneShotTicks: 20 * 60 * 3,    // 非循环且未给 duration 时的句柄最大兜底保留时长 (3分钟)
        defaultActiveHold:   30,             // lifeMode='active' 心跳续期单次默认维持窗口 (tick)
        anchorGraceTicks:    100,            // 实体锚点因区块卸载暂时丢失后的宽限等待 (tick)
        maxHandles:          512,            // 全服句柄上限；超出时按优先级淘汰
        maxHandlesPerPlayer: 12,             // 单名玩家同时收听的句柄上限
        maxKeyLength:        160,
        listMaxLines:        20,
        errorLogIntervalMs:  5000            // 限频警告日志最小间隔 (ms)
    }

    var PRIORITY_MAP = (PROTO && PROTO.PRIORITY_MAP) || {
        low: 1, minor: 1, '低': 1, '次要': 1,
        normal: 2, medium: 2, default: 2, '中': 2, '普通': 2,
        high: 3, major: 3, important: 3, '高': 3, '重要': 3,
        critical: 4, fatal: 4, urgent: 4, boss: 4, '极高': 4, '致命': 4,
        active: 5, sustain: 5, '持续': 5
    }

    var CATEGORY_ALIASES = {
        master: 'MASTER', music: 'MUSIC', record: 'RECORDS', records: 'RECORDS',
        weather: 'WEATHER', block: 'BLOCKS', blocks: 'BLOCKS', hostile: 'HOSTILE',
        neutral: 'NEUTRAL', player: 'PLAYERS', players: 'PLAYERS', ambient: 'AMBIENT', voice: 'VOICE'
    }
    var DEFAULT_CATEGORY = 'RECORDS'
    var FALLOFFS         = new Set(['linear', 'smooth', 'cutoff', 'flat'])
    var AUDIENCES        = new Set(['near', 'self', 'players', 'dim', 'all'])

    var tryCall = (fn, fallbackVal) => {
        try {
            var res = fn()
            return res !== undefined ? res : fallbackVal
        } catch (e) {
            return fallbackVal
        }
    }

    var loadJavaClass = (className) => {
        try {
            return Java.loadClass(className)
        } catch (e) {
            if (typeof global !== 'undefined' && global.EpiphyLog != null) {
                global.EpiphyLog.debug('EpiphyAudio', 'loadJavaClass', `未加载类 ${className}: ${e}`)
            }
            return null
        }
    }

    var UUIDClass     = loadJavaClass('java.util.UUID')
    var BlockPosClass = loadJavaClass('net.minecraft.core.BlockPos')

    var SESSION        = Date.now().toString(36) + Math.floor(Math.random() * 1679616).toString(36)
    var handles        = new Map() // id -> handle
    var keyIndex       = new Map() // key -> id
    var listenCount    = new Map() // uuid -> count
    var loginReadyTick = new Map() // uuid -> tickCounter
    var listenersGlobal = { start: [], join: [], leave: [], end: [] }

    var serverRef       = null
    var loadedPersistSrv = null
    var tickCounter     = 0
    var pendingReset    = true
    var nextHandleId       = 1
    var listenerTriggerSeq = 0
    // ======================================================================== 基础工具与限频告警（委托 EpiphyLog）

    var min2 = (a, b) => (a < b ? a : b)
    var max2 = (a, b) => (a > b ? a : b)
    var clampNum = (v, lo, hi) => (v < lo ? lo : (v > hi ? hi : v))

    // 【catch 约定】日志设施自身的兜底：console / notifyPlayer.tell 不可用时已无更低层可退，留空避免递归报错。
    var reportWarning = (where, msg, notifyPlayer) => {
        if (typeof global !== 'undefined' && global.EpiphyLog != null) {
            return global.EpiphyLog.warn('EpiphyAudio', where, msg, notifyPlayer, CONFIG.errorLogIntervalMs)
        }
        var fullMsg = `[EpiphyAudio ${where}] ${msg}`
        try { console.warn(fullMsg) } catch (e) {}
        if (notifyPlayer != null) {
            try { notifyPlayer.tell(Text.of(`§c${fullMsg}`)) } catch (e) {}
        }
        return null
    }

    var reportCatch = (tag, err) => {
        if (typeof global !== 'undefined' && global.EpiphyLog != null) {
            return global.EpiphyLog.catchWarn('EpiphyAudio', tag, err, null, CONFIG.errorLogIntervalMs)
        }
        try { console.warn(`[EpiphyAudio 异常:${String(tag || 'unknown')}] ${String(err)}`) } catch (e) {}
        return null
    }

    var parseFiniteNum = (val, defVal) => {
        if (val === undefined || val === null || val === '') return defVal
        var n = Number(val)
        return isFinite(n) ? n : defVal
    }

    var parseBoolStrict = (val) => {
        if (val === true || val === false) return val
        if (val === undefined || val === null || val === '') return null
        if (typeof val === 'number') return !isNaN(val) && val !== 0
        var s = String(val).trim().toLowerCase()
        if (s === 'true' || s === '1' || s === '1b' || s === 'yes' || s === 'on' || s === 'y' || s === '是' || s === '开启' || s === '开') return true
        if (s === 'false' || s === '0' || s === '0b' || s === 'no' || s === 'off' || s === 'n' || s === 'none' || s === '否' || s === '关闭' || s === '关') return false
        return null
    }

    var parseBool = (val, defVal) => {
        var b = parseBoolStrict(val)
        return b === null ? defVal : b
    }

    var parsePriority = (val, defVal) => {
        if (val === undefined || val === null || val === '') return defVal
        if (typeof val === 'number' && isFinite(val)) return clampNum(Math.round(val), 0, 10)
        var s = String(val).trim().toLowerCase()
        if (PRIORITY_MAP[s] != null) return PRIORITY_MAP[s]
        var n = Number(s)
        return isFinite(n) ? clampNum(Math.round(n), 0, 10) : defVal
    }

    var parseTicks = (val, allowZero) => {
        var canBeZero = Boolean(allowZero)
        if (val === undefined || val === null || val === '') return null
        if (typeof val === 'number') {
            if (!isFinite(val)) return null
            if (canBeZero && val === 0) return 0
            return val > 0 ? Math.ceil(val) : null
        }
        var m = /^(\d+(?:\.\d+)?)\s*(t|tick|ticks|s|sec|m|min)?$/.exec(String(val).trim().toLowerCase())
        if (m == null) return null
        var n = Number(m[1])
        var unit = m[2] || 't'
        if (unit === 's' || unit === 'sec') n *= 20
        else if (unit === 'm' || unit === 'min') n *= 1200
        if (canBeZero && n === 0) return 0
        return n > 0 ? Math.ceil(n) : null
    }

    var normalizeSoundId = (v) => {
        if (v == null) return null
        var raw = v
        if (typeof raw === 'object') {
            raw = tryCall(() => {
                if (typeof raw.getLocation === 'function') return raw.getLocation()
                if (raw.location != null) return raw.location
                return raw
            }, raw)
        }
        var s = String(raw).trim().toLowerCase()
        if (s.length === 0 || s.length > 256) return null
        if (!s.includes(':')) s = `minecraft:${s}`
        return /^[a-z0-9_.\-]+:[a-z0-9_.\-\/]+$/.test(s) ? s : null
    }

    var normalizeDim = (v) => {
        if (v == null) return null
        var s = String(v).trim().toLowerCase()
        if (s.length === 0) return null
        return s.includes(':') ? s : `minecraft:${s}`
    }

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
        if (src != null && typeof src === 'object') {
            for (var k of Object.keys(src)) out[k] = src[k]
        }
        return out
    }

    // 【catch 约定】Java 对象属性/方法能力探测：跨映射读取字段或无参 getter，失败属预期分支，留空避免热路径污染。
    var readMember = (obj, name) => {
        if (obj == null) return null
        var v = null
        try { v = obj[name] } catch (e) { return null }
        if (typeof v === 'function') {
            try { return obj[name]() } catch (e) { return null }
        }
        return v
    }

    // 注意：KubeJS Rhino 中 NativeJavaList (如 level.players) 不可调用 .slice()，统一通过 size/get 或索引拷贝
    var toJsArray = (list) => {
        var out = []
        if (list == null) return out
        if (tryCall(() => {
            if (typeof list.size === 'function' && typeof list.get === 'function') {
                for (var i = 0, n = list.size(); i < n; i++) out.push(list.get(i))
                return true
            }
            return false
        }, false)) return out
        if (tryCall(() => {
            if (typeof list !== 'string' && typeof list.length === 'number') {
                for (var j = 0, len = list.length; j < len; j++) out.push(list[j])
                return true
            }
            return false
        }, false)) return out
        tryCall(() => {
            if (typeof list.iterator === 'function') {
                var it = list.iterator()
                while (it.hasNext()) out.push(it.next())
            }
        }, null)
        return out
    }

    // ======================================================================== Minecraft / KubeJS 6 对象访问

    var isEntity = (o) => o != null && typeof o === 'object' && (typeof o.getStringUUID === 'function' || typeof o.getUUID === 'function')
    var isPlayer = (o) => isEntity(o) && (typeof o.getGameProfile === 'function' || typeof o.getProfile === 'function' || o.username != null)
    var isBlockContainer = (o) => o != null && typeof o === 'object' && !isEntity(o) &&
        (typeof o.getBlockState === 'function' || o.blockState != null || (o.id != null && o.level != null && o.pos != null))

    var uuidOf = (e) => {
        if (e == null) return null
        return tryCall(() => (typeof e.getStringUUID === 'function') ? String(e.getStringUUID()) : null, null)
            || tryCall(() => (e.uuid != null) ? String(e.uuid) : null, null)
            || tryCall(() => (typeof e.getUUID === 'function') ? String(e.getUUID()) : null, null)
    }

    var entityIdOf = (e) => {
        if (e == null) return null
        return tryCall(() => {
            if (typeof e.getId === 'function') {
                var id = Number(e.getId())
                if (isFinite(id)) return id
            }
            return null
        }, null)
    }

    var nameOf = (p) => {
        if (p == null) return '?'
        return tryCall(() => (p.username != null) ? String(p.username) : null, null)
            || tryCall(() => (typeof p.getGameProfile === 'function') ? String(p.getGameProfile().getName()) : null, null)
            || tryCall(() => (typeof p.getProfile === 'function') ? String(p.getProfile().getName()) : null, null)
            || '?'
    }

    var levelOf = (o) => {
        if (o == null) return null
        var lv = readMember(o, 'level')
        if (lv == null) {
            lv = tryCall(() => (typeof o.getLevel === 'function') ? o.getLevel() : null, null)
        }
        return lv
    }

    var dimOfLevel = (lv) => {
        if (lv == null) return null
        var byGetter = tryCall(() => {
            if (typeof lv.getDimension === 'function') {
                var gd = lv.getDimension()
                return gd != null ? normalizeDim(String(gd)) : null
            }
            return null
        }, null)
        if (byGetter != null) return byGetter
        return tryCall(() => {
            var d = readMember(lv, 'dimension')
            if (d != null && typeof d.location === 'function') d = d.location()
            return d != null ? normalizeDim(String(d)) : null
        }, null)
    }

    var resolveDimId = (levelOrDim) => {
        if (levelOrDim == null) return null
        if (typeof levelOrDim === 'string') return normalizeDim(levelOrDim)
        var fromLv = dimOfLevel(levelOrDim)
        if (fromLv != null) return fromLv
        try { return normalizeDim(String(levelOrDim)) } catch (e) { return null }
    }

    var allLevels = () => {
        if (serverRef == null) return []
        try { return toJsArray(serverRef.getAllLevels()) } catch (e) { return [] }
    }

    var resolveServerLevel = (dimId) => {
        if (serverRef == null || !dimId) return null
        var norm = normalizeDim(dimId)
        var direct = tryCall(() => serverRef.getLevel(norm), null)
        if (direct != null) return direct
        for (var lv of allLevels()) {
            if (dimOfLevel(lv) === norm) return lv
        }
        return null
    }

    // 安全坐标提取：严禁将 null/undefined 传入 Number()（因为 Number(null) === 0 会将实体坐标误判为 0,0,0）
    var readPos = (o) => {
        if (o == null) return null
        if (Array.isArray(o) || (typeof o === 'object' && typeof o.length === 'number' && o.length >= 3)) {
            if (o[0] == null || o[1] == null || o[2] == null) return null
            var ax = Number(o[0]), ay = Number(o[1]), az = Number(o[2])
            return (isFinite(ax) && isFinite(ay) && isFinite(az)) ? { x: ax, y: ay, z: az } : null
        }
        var byGetters = tryCall(() => {
            if (typeof o.getX === 'function' && typeof o.getY === 'function' && typeof o.getZ === 'function') {
                var gx = Number(o.getX()), gy = Number(o.getY()), gz = Number(o.getZ())
                if (isFinite(gx) && isFinite(gy) && isFinite(gz)) return { x: gx, y: gy, z: gz }
            }
            return null
        }, null)
        if (byGetters != null) return byGetters
        var byBlock = tryCall(() => (o.block != null && o.block !== o) ? readPos(o.block) : null, null)
        if (byBlock != null) return byBlock
        var rx = readMember(o, 'x')
        var ry = readMember(o, 'y')
        var rz = readMember(o, 'z')
        if (rx != null && ry != null && rz != null && rx !== '' && ry !== '' && rz !== '') {
            var x = Number(rx), y = Number(ry), z = Number(rz)
            if (isFinite(x) && isFinite(y) && isFinite(z)) return { x: x, y: y, z: z }
        }
        return null
    }

    var extractBlockId = (blockOrState) => {
        if (blockOrState == null) return null
        return tryCall(() => (blockOrState.id != null) ? String(blockOrState.id) : null, null)
            || tryCall(() => (typeof blockOrState.getId === 'function') ? String(blockOrState.getId()) : null, null)
            || tryCall(() => {
                if (typeof blockOrState.getBlock === 'function') {
                    var blk = blockOrState.getBlock()
                    if (blk != null) {
                        if (blk.id != null) return String(blk.id)
                        if (typeof blk.getId === 'function') return String(blk.getId())
                    }
                }
                return null
            }, null)
    }

    var isBlockChunkLoaded = (lv, bx, bz) => {
        if (lv == null) return false
        var cx = bx >> 4
        var cz = bz >> 4
        if (tryCall(() => {
            var cs = lv.getChunkSource()
            return cs != null && cs.getChunkNow(cx, cz) != null
        }, false)) return true
        return Boolean(tryCall(() => lv.hasChunk(cx, cz), false))
    }

    var queryBlockAt = (dimId, bx, by, bz) => {
        var lv = resolveServerLevel(dimId)
        if (lv == null) return null
        var ix = Math.floor(bx), iy = Math.floor(by), iz = Math.floor(bz)
        if (!isBlockChunkLoaded(lv, ix, iz)) return null
        return tryCall(() => (typeof lv.getBlock === 'function') ? lv.getBlock(ix, iy, iz) : null, null)
    }

    var isBlockPoweredAt = (dimId, bx, by, bz) => {
        var lv = resolveServerLevel(dimId)
        if (lv == null) return false
        var ix = Math.floor(bx), iy = Math.floor(by), iz = Math.floor(bz)
        if (!isBlockChunkLoaded(lv, ix, iz)) return false
        if (tryCall(() => {
            var b = lv.getBlock(ix, iy, iz)
            if (b != null) {
                if (typeof b.getIndirectPower === 'function' && Number(b.getIndirectPower()) > 0) return true
                if (b.indirectPower != null && Number(b.indirectPower) > 0) return true
            }
            return false
        }, false)) return true
        return Boolean(tryCall(() => {
            return BlockPosClass != null && typeof lv.hasNeighborSignal === 'function'
                && lv.hasNeighborSignal(new BlockPosClass(ix, iy, iz))
        }, false))
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
        var list = tryCall(() => toJsArray(serverRef.getPlayerList().getPlayers()), null)
        if (list != null) return list
        return tryCall(() => toJsArray(serverRef.players), [])
    }

    var findPlayerByName = (name) => {
        var target = String(name).trim().toLowerCase()
        for (var p of onlinePlayers()) {
            if (nameOf(p).toLowerCase() === target) return p
        }
        return null
    }

    var findEntityByUuid = (uuidStr, preferDim, levelMap) => {
        if (UUIDClass == null || !uuidStr) return null
        var uuidObj = tryCall(() => UUIDClass.fromString(String(uuidStr)), null)
        if (uuidObj == null) return null

        if (preferDim && levelMap && levelMap[preferDim]) {
            var prefEnt = tryCall(() => {
                var e0 = levelMap[preferDim].getEntity(uuidObj)
                return (e0 != null && !e0.isRemoved()) ? e0 : null
            }, null)
            if (prefEnt != null) return prefEnt
        }

        for (var lv of allLevels()) {
            if (preferDim && dimOfLevel(lv) === preferDim && levelMap && levelMap[preferDim]) continue
            var ent = tryCall(() => {
                var e1 = lv.getEntity(uuidObj)
                return (e1 != null && !e1.isRemoved()) ? e1 : null
            }, null)
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
        if (!Array.isArray(src) && typeof src === 'object') {
            var ownLevel = levelOf(src)
            if (ownLevel != null) dim = dimOfLevel(ownLevel)
            if (dim == null && src.dim != null) dim = resolveDimId(src.dim)
            if (dim == null && src.dimension != null) dim = resolveDimId(src.dimension)
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
        if (spec == null || typeof spec !== 'object') {
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

        var effectiveSpanTicks = isActiveMode
            ? activeHoldTicks
            : (loop
                ? (lifetimeTicks != null ? lifetimeTicks : 0)
                : (durationTicks != null ? durationTicks : CONFIG.defaultOneShotTicks))

        return {
            handle: {
                id:              0,
                key:             autoKey,
                explicitKey:     explicitKey != null,
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
                bornTick:        tickCounter,
                activeHoldTicks: activeHoldTicks,
                spanTicks:       effectiveSpanTicks,
                endTick:         (!hasStartGate && effectiveSpanTicks > 0) ? (tickCounter + effectiveSpanTicks) : 0,
                graceTicks:      max2(0, parseFiniteNum(spec.anchorGraceTicks, CONFIG.anchorGraceTicks)),
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
        var ent = a.ref
        var alive = tryCall(() => ent != null && !ent.isRemoved() && (typeof ent.isAlive !== 'function' || ent.isAlive()), false)
        if (!alive) {
            ent = findEntityByUuid(a.uuid, a.dim, snap.levelMap)
            a.ref = ent
        }
        if (ent == null) return false
        if (!tryCall(() => (typeof ent.isAlive !== 'function' || ent.isAlive()), true)) return false
        var pos = readPos(ent)
        if (pos == null) return false
        a.x   = pos.x
        a.y   = pos.y
        a.z   = pos.z
        a.dim = resolveDimId(levelOf(ent)) || a.dim
        a.eid = entityIdOf(ent)
        return true
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
                var lim = alreadyListening
                    ? (h.outOfRangeMode === 'mute' ? max2(h.range + CONFIG.rangeHysteresis, h.keepAliveRange) : (h.range + CONFIG.rangeHysteresis))
                    : h.range
                var dx = rec.x - a.x, dy = rec.y - a.y, dz = rec.z - a.z
                if ((dx * dx + dy * dy + dz * dz) > (lim * lim)) return false
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
                var curBlock = queryBlockAt(a.dim, a.bx, a.by, a.bz)
                var curId    = extractBlockId(curBlock)
                if (curId != null && curId !== a.blockId) {
                    return 'block_broken'
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

    var buildPlayPacket = (h, restartClient) => {
        var a = h.anchor
        var pkt = {
            proto:  PROTO_VERSION,
            act:    'play',
            ses:    SESSION,
            h:      h.id,
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
        if (a.kind !== 'none') {
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

    var buildUpdatePacket = (h) => {
        var a = h.anchor
        var pkt = {
            proto: PROTO_VERSION,
            act:   'update',
            ses:   SESSION,
            h:    h.id,
            vol:  h.volume,
            pit:  h.pitch,
            rng:  h.range,
            fout: h.fadeOut
        }
        if (a.kind !== 'none') {
            pkt.x = a.x
            pkt.y = a.y
            pkt.z = a.z
            if (a.kind === 'entity' && a.eid != null) pkt.eid = a.eid
        }
        return pkt
    }

    var buildStopPacket = (h, customFadeOutTicks) => {
        var fout = (customFadeOutTicks != null && isFinite(customFadeOutTicks) && customFadeOutTicks >= 0)
            ? Math.round(customFadeOutTicks)
            : h.fadeOut
        return { proto: PROTO_VERSION, act: 'stop', ses: SESSION, h: h.id, fout: fout }
    }

    var addListener = (h, rec) => {
        h.listeners[rec.uuid] = true
        var seq = ++listenerTriggerSeq
        if (!h.listenerEnteredSeq) h.listenerEnteredSeq = {}
        if (!h.listenerInRange) h.listenerInRange = {}
        if (!h.listenerInRangeSeq) h.listenerInRangeSeq = {}
        h.listenerEnteredSeq[rec.uuid] = seq
        var inOwnRange = (h.anchor.kind === 'none') || (distSqToHandle(rec, h) <= h.range * h.range)
        h.listenerInRange[rec.uuid] = inOwnRange
        if (inOwnRange) h.listenerInRangeSeq[rec.uuid] = seq
        h.listenerCount++
        h.triggerCount++
        h.hadListenerOnce = true
        listenCount.set(rec.uuid, (listenCount.get(rec.uuid) || 0) + 1)
        emit('join', h, rec.p)
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
        h.listenerCount = max2(0, h.listenerCount - 1)
        if (listenCount.has(uuid)) {
            var next = listenCount.get(uuid) - 1
            if (next <= 0) listenCount.delete(uuid)
            else listenCount.set(uuid, next)
        }
        emit('leave', h, rec != null ? rec.p : null, reason)
    }

    var broadcastUpdateToListeners = (h, snap) => {
        var uuids = Object.keys(h.listeners)
        if (uuids.length === 0) return
        var pkt = buildUpdatePacket(h)
        for (var u of uuids) {
            var rec = snap.byUuid[u]
            if (rec != null) sendPacket(rec.p, pkt)
        }
    }

    var resendPlayToListeners = (h, snap, restartFlag) => {
        var uuids = Object.keys(h.listeners)
        if (uuids.length === 0) return
        var pkt = buildPlayPacket(h, restartFlag)
        for (var u of uuids) {
            var rec = snap.byUuid[u]
            if (rec != null) sendPacket(rec.p, pkt)
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

        var dimChanged = (a.kind === 'entity' && h.started && a.dim !== h.sentDim)
        var eidChanged = (a.kind === 'entity' && h.started && !dimChanged && a.eid !== h.sentEid)

        for (var u of Object.keys(h.listeners)) {
            var rec = snap.byUuid[u]
            if (rec == null) {
                removeListener(h, u, null, 'offline')
            } else if (!isPlayerEligible(h, rec, true) && !(h.conflictMode === 'merge' && isPlayerInMergedClusterRange(h, rec))) {
                removeListener(h, u, rec, 'out_of_scope')
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
                if ((listenCount.get(rec.uuid) || 0) >= CONFIG.maxHandlesPerPlayer) {
                    reportWarning('maxHandlesPerPlayer', `玩家 ${rec.name || rec.uuid} 同时收听句柄数已达上限 (${CONFIG.maxHandlesPerPlayer})，已跳过新增音频 #${h.id}`)
                    continue
                }
                if (pkt == null) pkt = buildPlayPacket(h, true)
                if (sendPacket(rec.p, pkt)) {
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
        if (!checkStartConditionMet(h, snap)) return true
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
        if (handles.size === 0) return
        var snap             = snapshotPlayers()
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
                    // 组合合并模式：范围取并集总合；若当前未静音句柄仍在自身范围内则保持连续播放不跳切，
                    // 否则切换为距离最近的在范围内成员
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
                    if (currentActive != null) {
                        winner = currentActive
                    } else {
                        var pool = inRangeList.length > 0 ? inRangeList : list
                        winner = pool[0]
                        for (var pIdx = 1; pIdx < pool.length; pIdx++) {
                            var pCand = pool[pIdx]
                            if (distSqToHandle(rec, pCand) < distSqToHandle(rec, winner) - 0.25) {
                                winner = pCand
                            }
                        }
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
            if (listenCount.has(u)) {
                var next = listenCount.get(u) - 1
                if (next <= 0) listenCount.delete(u)
                else listenCount.set(u, next)
            }
        }
        h.listeners     = {}
        h.listenerCount = 0
        handles.delete(h.id)
        if (h.key != null && keyIndex.get(h.key) === h.id) {
            keyIndex.delete(h.key)
        }
        emit('end', h, reason)
        return true
    }

    var evictLowestPriorityHandle = (incomingPriority) => {
        var victim   = null
        var minScore = Infinity
        for (var cand of handles.values()) {
            var score = (cand.priority || 2) * 1000000 + (cand.loop ? 500000 : 0) + (cand.bornTick % 500000)
            if (score < minScore) {
                minScore = score
                victim   = cand
            }
        }
        if (victim != null && (!victim.loop || (incomingPriority || 2) >= (victim.priority || 2))) {
            return endHandle(victim, 'evicted')
        }
        return false
    }

    // ======================================================================== 对外接口：播放与心跳续期

    var isSpecObject = (a) => a != null && typeof a === 'object' && !Array.isArray(a) &&
        typeof a.getClass !== 'function' && (a.sound != null || a.soundId != null || a.id != null)

    var normalizeLegacySpec = (target, soundId, opts) => {
        var o = (typeof opts === 'object' && opts != null) ? copyObject(opts) : {}
        if (soundId != null) o.sound = soundId
        if (target == null) return o
        if (typeof target === 'string') {
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
        } else if (Array.isArray(target) || (typeof target.iterator === 'function' && readPos(target) == null)) {
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
                    var forceReplace = parseBool(spec.replace != null ? spec.replace : spec.restart, false)
                    if (!forceReplace) {
                        return renewExistingHandle(old, h, spec)
                    }
                    endHandle(old, 'replaced')
                }
            }

            if (handles.size >= CONFIG.maxHandles && !evictLowestPriorityHandle(h.priority)) {
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
        var block  = tryCall(() => event.block, null)
        if (block != null) return atBlock(block, soundId, opts)
        var entity = tryCall(() => event.entity, null)
        if (entity != null) return onEntity(entity, soundId, opts)
        var player = tryCall(() => event.player, null)
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
        if (typeof ref === 'object') {
            if (ref.block != null) return stopAtBlock(ref.block, ref.sound, ref.fadeOut)
            if (ref.entity != null) return stopOnEntity(ref.entity, ref.sound, ref.fadeOut)
            if (ref.key != null) return stopKey(ref.key, ref.fadeOut)
            if (ref.tag != null || ref.group != null) return stopTag(ref.tag || ref.group, ref.fadeOut, ref.maxPriority)
            if (ref.dim != null || ref.level != null) return stopInDimension(ref.dim || ref.level, ref.sound, ref.fadeOut)
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

    var startBoundBlockAudio = (rec, binding, lv, curBlock) => {
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

        var playSpec = withFields(rawSpec, {
            key:              rec.audioKey,
            block:            curBlock,
            dim:              rec.dim,
            loop:             rawSpec.loop !== undefined ? rawSpec.loop : true,
            outOfRangeMode:   rawSpec.outOfRangeMode !== undefined ? rawSpec.outOfRangeMode : 'mute',
            conflictMode:     rawSpec.conflictMode !== undefined ? rawSpec.conflictMode : 'nearest',
            conflictScope:    rawSpec.conflictScope !== undefined ? rawSpec.conflictScope : 'sound',
            stopOnBlockBreak: rawSpec.stopOnBlockBreak !== undefined ? rawSpec.stopOnBlockBreak : true
        })
        return play(playSpec) > 0
    }

    var audioBlockTracker    = null
    var missingTrackerWarned = false

    // 基础兜底表：当方块追踪组件缺失时，仅维护本会话内通过 placed/broken 事件感知的方块
    var fallbackBindings     = new Map()
    var fallbackTracked      = new Map()
    var fallbackEventsHooked = false

    var hookFallbackBlockEvents = () => {
        if (fallbackEventsHooked) return
        fallbackEventsHooked = true
        try {
            BlockEvents.placed((event) => {
                try {
                    if (audioBlockTracker != null || fallbackBindings.size === 0 || event.block == null) return
                    var bid = extractBlockId(event.block)
                    if (bid == null || !fallbackBindings.has(bid)) return
                    var dim = dimOfLevel(event.level) || 'minecraft:overworld'
                    var ix  = Math.floor(event.block.x), iy = Math.floor(event.block.y), iz = Math.floor(event.block.z)
                    var key = `${dim}|${ix},${iy},${iz}`
                    var rec = { key: key, blockId: bid, dim: dim, x: ix, y: iy, z: iz, audioKey: makeBoundAudioKey(bid, dim, ix, iy, iz) }
                    fallbackTracked.set(key, rec)
                    if (!keyIndex.has(rec.audioKey)) {
                        startBoundBlockAudio(rec, fallbackBindings.get(bid), event.level, event.block)
                    }
                } catch (eP) {
                    reportCatch('fallback:placed', eP)
                }
            })
            BlockEvents.broken((event) => {
                try {
                    if (audioBlockTracker != null || event.block == null) return
                    var dim = dimOfLevel(event.level) || 'minecraft:overworld'
                    var ix  = Math.floor(event.block.x), iy = Math.floor(event.block.y), iz = Math.floor(event.block.z)
                    var key = `${dim}|${ix},${iy},${iz}`
                    var rec = fallbackTracked.get(key)
                    if (rec != null) {
                        stopKey(rec.audioKey)
                        fallbackTracked.delete(key)
                    } else {
                        var bid = extractBlockId(event.block)
                        if (bid != null && fallbackBindings.has(bid)) {
                            stopKey(makeBoundAudioKey(bid, dim, ix, iy, iz))
                        }
                    }
                } catch (eB) {
                    reportCatch('fallback:broken', eB)
                }
            })
        } catch (eHook) {
            reportCatch('fallback:hookEvents', eHook)
        }
    }

    var createFallbackTracker = () => {
        hookFallbackBlockEvents()
        return {
            isFallback: true,
            bind: (idStr, meta) => { fallbackBindings.set(idStr, meta); return true },
            unbind: (idStr, fadeOut) => {
                fallbackBindings.delete(idStr)
                var stopped = 0
                for (var [k, rec] of Array.from(fallbackTracked.entries())) {
                    if (rec.blockId === idStr) {
                        stopped += stopKey(rec.audioKey, fadeOut)
                        fallbackTracked.delete(k)
                    }
                }
                return stopped
            },
            scanNow: () => 0
        }
    }

    var ensureAudioBlockTracker = () => {
        if (audioBlockTracker != null) return audioBlockTracker
        var trackerApi = (typeof global !== 'undefined') ? global.EpiphyBlockTracker : null
        if (trackerApi == null || typeof trackerApi.createTracker !== 'function') {
            if (!missingTrackerWarned) {
                missingTrackerWarned = true
                var msg = '[EpiphyAudio] 依赖组件 EpiphyBlockTracker (Epiphy的-方块追踪组件.js) 未加载，已降级为基础事件兜底模式（仅支持新放置/破坏方块，无区块扫描与持久化）。'
                if (typeof global !== 'undefined' && global.EpiphyLog != null) {
                    global.EpiphyLog.once('warn', 'audio:missing_block_tracker', msg)
                } else {
                    // 【catch 约定】日志设施自身的兜底：console 不可用时已无更低层可退，留空。
                    try { console.warn(msg) } catch (e) {}
                }
            }
            return createFallbackTracker()
        }
        audioBlockTracker = trackerApi.createTracker({
            name:             'audio',
            maintainInterval: 20,
            maintainOffset:   2,
            makeRecordExtra: function (blockId, dim, ix, iy, iz) {
                return { audioKey: makeBoundAudioKey(blockId, dim, ix, iy, iz) }
            },
            onFound: function (rec, binding) {
                if (!keyIndex.has(rec.audioKey)) {
                    startBoundBlockAudio(rec, binding, null, null)
                }
            },
            onTick: function (rec, binding, tickNum, lv, curBlock) {
                if (!keyIndex.has(rec.audioKey)) {
                    startBoundBlockAudio(rec, binding, lv, curBlock)
                }
            },
            onRemoved: function (rec, binding, reason, fadeOut) {
                stopKey(rec.audioKey, fadeOut)
            },
            onBrokenUnregistered: function (dim, x, y, z, bid) {
                stopKey(makeBoundAudioKey(bid, dim, x, y, z))
            }
        })
        return audioBlockTracker
    }

    var bindBlock = (blockId, specOrFn) => {
        if (!blockId || specOrFn == null) return false
        var tracker = ensureAudioBlockTracker()
        if (tracker == null) return false
        var idStr = String(blockId).trim()
        var range = (typeof specOrFn === 'object' && specOrFn.range != null) ? Number(specOrFn.range) : 32
        tracker.bind(idStr, {
            blockId:    idStr,
            specOrFn:   specOrFn,
            scanRadius: clampNum(isFinite(range) ? range + 6 : 38, 16, 128)
        })
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
        if (global.EpiphyAudioBlockBindings && typeof global.EpiphyAudioBlockBindings === 'object') {
            delete global.EpiphyAudioBlockBindings[idStr]
        }
        return tracker.unbind(idStr, fadeOut)
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
            if (h != null && h.listeners[uuid]) {
                delete h.listeners[uuid]
                h.listenerCount = max2(0, h.listenerCount - 1)
            }
        }
        listenCount.delete(uuid)
    }

    ServerEvents.tick((event) => {
        try {
            if (event.server != null) serverRef = event.server
            tickCounter++
            if (pendingReset && serverRef != null) {
                pendingReset = false
                absorbGlobalBlockBindings()
                for (var p of onlinePlayers()) {
                    var pu = uuidOf(p)
                    if (pu != null) {
                        clearListenerRecordForPlayer(pu)
                        loginReadyTick.set(pu, tickCounter + 5)
                    }
                    sendPacket(p, { proto: PROTO_VERSION, act: 'reset', ses: SESSION })
                }
                checkValveRegistration()
            }
            if (tickCounter % CONFIG.syncIntervalTicks === 0) {
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
            if (valveMissing && checkValveRegistration(true)) {
                var isOp = Boolean(tryCall(() => p.hasPermissions(2), false))
                if (isOp) {
                    try {
                        p.tell(Text.of('§e[EpiphyAudio] §7未检测到权限阀组件 (EpiphyPermissionValve)，§f/epiphy audio §7指令功能未生效（JS 调用接口正常）。'))
                    } catch (e) {
                        reportCatch('loggedIn:tellValveMissing', e)
                    }
                }
            }
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

    var configure = (patch) => {
        if (patch != null && typeof patch === 'object') {
            var cfgPatch = (patch.CONFIG && typeof patch.CONFIG === 'object') ? patch.CONFIG : patch
            for (var k of Object.keys(cfgPatch)) {
                if (Object.prototype.hasOwnProperty.call(CONFIG, k) && cfgPatch[k] !== undefined) {
                    CONFIG[k] = cfgPatch[k]
                }
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
        on:               on
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

    var OPTION_KEYS = {
        volume: 'volume', vol: 'volume',
        pitch: 'pitch', pit: 'pitch',
        range: 'range', radius: 'range', r: 'range',
        loop: 'loop',
        life: 'lifeMode', lifemode: 'lifeMode',
        falloff: 'falloff', mode: 'falloff',
        category: 'category', cat: 'category',
        duration: 'duration', dur: 'duration', stay: 'duration',
        lifetime: 'lifetime',
        activehold: 'activeHold', holdticks: 'activeHold',
        delay: 'delay', startdelay: 'delay',
        fadein: 'fadeIn',
        fadeout: 'fadeOut',
        latejoin: 'lateJoin', late: 'lateJoin',
        resume: 'resume',
        duck: 'duckMusic', duckmusic: 'duckMusic',
        outofrange: 'outOfRangeMode', outofrangemode: 'outOfRangeMode', omode: 'outOfRangeMode',
        conflict: 'conflictMode', conflictmode: 'conflictMode',
        conflictscope: 'conflictScope',
        replace: 'replace', restart: 'replace',
        audience: 'audience',
        priority: 'priority', importance: 'priority',
        startonenter: 'startOnEnter',
        requireredstone: 'requireRedstone',
        stoponbreak: 'stopOnBlockBreak', stoponblockbreak: 'stopOnBlockBreak',
        stoponredstoneoff: 'stopOnRedstoneOff',
        stoponentitydeath: 'stopOnEntityDeath',
        stoponempty: 'stopWhenEmpty', stopwhenempty: 'stopWhenEmpty',
        maxtriggers: 'maxTriggers', maxlisteners: 'maxTriggers',
        key: 'key',
        tag: 'tag', group: 'group'
    }

    var BOOL_OPTIONS = new Set([
        'loop', 'lateJoin', 'resume', 'duckMusic', 'replace',
        'startOnEnter', 'requireRedstone',
        'stopOnBlockBreak', 'stopOnRedstoneOff', 'stopOnEntityDeath', 'stopWhenEmpty'
    ])
    var NUM_OPTIONS = new Set(['volume', 'pitch', 'range', 'maxTriggers'])
    var BARE_WORDS = {
        loop:    ['loop', true],
        once:    ['loop', false],
        active:  ['lifeMode', 'active'],
        replace: ['replace', true],
        restart: ['replace', true],
        linear:  ['falloff', 'linear'],
        smooth:  ['falloff', 'smooth'],
        cutoff:  ['falloff', 'cutoff'],
        flat:    ['falloff', 'flat'],
        near:    ['audience', 'near'],
        self:    ['audience', 'self'],
        all:     ['audience', 'all']
    }

    var parseOptions = (str) => {
        var opts = {}
        if (str == null || String(str).trim().length === 0) return { opts: opts }
        var re = /([A-Za-z_]+)=(?:"([^"]*)"|'([^']*)'|(\S+))|(\S+)/g
        var m
        while ((m = re.exec(String(str))) !== null) {
            if (m[5] != null) {
                var bare = BARE_WORDS[m[5].toLowerCase()]
                if (bare == null) return { error: `无法识别的独立参数词: ${m[5]}` }
                opts[bare[0]] = bare[1]
                continue
            }
            var key = OPTION_KEYS[m[1].toLowerCase()]
            if (key == null) return { error: `未知参数项: ${m[1]}` }
            var val = m[2] != null ? m[2] : (m[3] != null ? m[3] : m[4])
            if (BOOL_OPTIONS.has(key)) {
                var b = parseBoolStrict(val)
                if (b == null) return { error: `${key} 参数仅接受布尔值 (true / false)` }
                opts[key] = b
            } else if (NUM_OPTIONS.has(key)) {
                var n = Number(val)
                if (!isFinite(n)) return { error: `${key} 参数需要有效数字，收到: ${val}` }
                opts[key] = n
            } else {
                opts[key] = val
            }
        }
        return { opts: opts }
    }

    var reply = (source, msg) => {
        try { source.sendSuccess(Text.of(msg), false) } catch (e) { reportCatch('reply', e) }
    }
    var replyOk = (source, msg) => reply(source, `§a[EpiphyAudio] §7${msg}`)
    var replyErr = (source, msg) => reply(source, `§c[EpiphyAudio 错误] ${msg} §7(输入 §f/epiphy audio help §7查看语法)`)

    var sendAudioHelp = (source) => {
        for (var line of AUDIO_HELP_LINES) reply(source, line)
        return 1
    }

    var describeHandle = (info) => {
        var where = info.anchor === 'none'
            ? (info.dim != null ? info.dim : 'global')
            : `${info.dim} (${info.x.toFixed(1)}, ${info.y.toFixed(1)}, ${info.z.toFixed(1)})`
        var stateTag = info.waitingStart ? '§e[待启动]' : '§a[播放中]'
        return `§7#${info.id} ${stateTag} §f${info.sound}` +
            ` §7[${info.anchor}/${info.audience}/${info.falloff}${info.loop ? '/loop' : '/once'}]` +
            ` §8${where} r=${info.range} 收听=${info.listeners} 优先级=${info.priority} age=${info.ageTicks}t` +
            (info.key != null ? ` key=${info.key}` : '') + (info.tag != null ? ` tag=${info.tag}` : '')
    }

    var runPlayCommand = (source, fields, optionStr) => {
        var parsed = parseOptions(optionStr)
        if (parsed.error) {
            replyErr(source, parsed.error)
            return 0
        }
        var id = play(withFields(parsed.opts, fields))
        if (id > 0) {
            var info = get(id)
            var stateDesc = (info && info.waitingStart)
                ? '已挂起等待启动条件满足'
                : `当前收听 §f${info != null ? info.listeners : 0}§7 人`
            replyOk(source, `已调度 §f${fields.sound}§7（句柄 §e#${id}§7，${stateDesc}）`)
            return 1
        }
        replyErr(source, '播放未生效：参数无效、非循环音频范围内无在线玩家、或句柄池已满')
        return 0
    }

    var buildAudioCommandNode = (ctxReg) => {
        var event          = ctxReg.event
        var Commands       = ctxReg.Commands
        var Arguments      = ctxReg.Arguments
        var guardExecution = ctxReg.guardExecution
        var SOUND_ARG = Arguments.RESOURCE_LOCATION
        var soundSuggest = tryCall(() => {
            var sp = loadJavaClass('net.minecraft.commands.synchronization.SuggestionProviders')
            return sp != null ? sp.AVAILABLE_SOUNDS : null
        }, null)

        var soundOf = (ctx) => String(SOUND_ARG.getResult(ctx, 'sound'))

        var soundArgument = () => {
            var node = Commands.argument('sound', SOUND_ARG.create(event))
            if (soundSuggest != null) {
                try { node = node.suggests(soundSuggest) } catch (e) { reportCatch('soundSuggest', e) }
            }
            return node
        }

        var soundWithOptions = (handler) =>
            soundArgument()
                .executes(guardExecution((ctx) => handler(ctx, '')))
                .then(
                    Commands.argument('options', Arguments.GREEDY_STRING.create(event))
                        .executes(guardExecution((ctx) =>
                            handler(ctx, String(Arguments.GREEDY_STRING.getResult(ctx, 'options')))
                        ))
                )

        var vecToArray = (v) => {
            var p = readPos(v)
            return p != null ? [p.x, p.y, p.z] : null
        }

        return Commands.literal('audio')
            .executes(guardExecution((ctx) => sendAudioHelp(ctx.source)))
            .then(Commands.literal('help')
                .executes(guardExecution((ctx) => sendAudioHelp(ctx.source))))

            .then(Commands.literal('play')
                .then(Commands.argument('targets', Arguments.PLAYERS.create(event))
                    .then(soundWithOptions((ctx, opt) => {
                        var players = toJsArray(Arguments.PLAYERS.getResult(ctx, 'targets'))
                        if (players.length === 0) { replyErr(ctx.source, '未匹配到任何在线玩家'); return 0 }
                        return runPlayCommand(ctx.source, { sound: soundOf(ctx), players: players }, opt)
                    }))))

            .then(Commands.literal('follow')
                .then(Commands.argument('entity', Arguments.ENTITY.create(event))
                    .then(soundWithOptions((ctx, opt) => {
                        var ent = Arguments.ENTITY.getResult(ctx, 'entity')
                        return runPlayCommand(ctx.source, { sound: soundOf(ctx), entity: ent }, opt)
                    }))))

            .then(Commands.literal('at')
                .then(Commands.argument('pos', Arguments.VEC3.create(event))
                    .then(soundWithOptions((ctx, opt) => {
                        var pos = vecToArray(Arguments.VEC3.getResult(ctx, 'pos'))
                        var dim = tryCall(() => dimOfLevel(ctx.source.getLevel ? ctx.source.getLevel() : ctx.source.level), null)
                        if (pos == null || dim == null) { replyErr(ctx.source, '无法确定目标坐标或当前维度'); return 0 }
                        return runPlayCommand(ctx.source, { sound: soundOf(ctx), at: pos, dim: dim }, opt)
                    }))))

            .then(Commands.literal('pos')
                .then(Commands.argument('dimension', Arguments.DIMENSION.create(event))
                    .then(Commands.argument('pos', Arguments.VEC3.create(event))
                        .then(soundWithOptions((ctx, opt) => {
                            var dim = dimOfLevel(Arguments.DIMENSION.getResult(ctx, 'dimension'))
                            var pos = vecToArray(Arguments.VEC3.getResult(ctx, 'pos'))
                            if (pos == null || dim == null) { replyErr(ctx.source, '无法解析目标维度或坐标'); return 0 }
                            return runPlayCommand(ctx.source, { sound: soundOf(ctx), at: pos, dim: dim }, opt)
                        })))))

            .then(Commands.literal('dim')
                .then(Commands.argument('dimension', Arguments.DIMENSION.create(event))
                    .then(soundWithOptions((ctx, opt) => {
                        var dim = dimOfLevel(Arguments.DIMENSION.getResult(ctx, 'dimension'))
                        if (dim == null) { replyErr(ctx.source, '无法解析目标维度'); return 0 }
                        return runPlayCommand(ctx.source, { sound: soundOf(ctx), dim: dim, audience: 'dim' }, opt)
                    }))))

            .then(Commands.literal('all')
                .then(soundWithOptions((ctx, opt) =>
                    runPlayCommand(ctx.source, { sound: soundOf(ctx), audience: 'all' }, opt)
                )))

            .then(Commands.literal('update')
                .then(Commands.argument('ref', Arguments.STRING.create(event))
                    .then(Commands.argument('options', Arguments.GREEDY_STRING.create(event))
                        .executes(guardExecution((ctx) => {
                            var ref    = String(Arguments.STRING.getResult(ctx, 'ref'))
                            var optStr = String(Arguments.GREEDY_STRING.getResult(ctx, 'options'))
                            var parsed = parseOptions(optStr)
                            if (parsed.error) { replyErr(ctx.source, parsed.error); return 0 }
                            if (update(ref, parsed.opts)) {
                                replyOk(ctx.source, `已实时热更新句柄 [${ref}]`)
                                return 1
                            }
                            replyErr(ctx.source, `未找到句柄或 key [${ref}]`)
                            return 0
                        })))))

            .then(Commands.literal('stop')
                .then(Commands.argument('ref', Arguments.STRING.create(event))
                    .executes(guardExecution((ctx) => {
                        var ref = String(Arguments.STRING.getResult(ctx, 'ref'))
                        var n   = stop(ref)
                        if (n > 0) { replyOk(ctx.source, `已停止 [${ref}] (共 ${n} 个句柄)`); return 1 }
                        replyErr(ctx.source, `未找到匹配 [${ref}] 的活动句柄`)
                        return 0
                    }))
                    .then(Commands.argument('fadeOut', Arguments.WORD.create(event))
                        .executes(guardExecution((ctx) => {
                            var ref = String(Arguments.STRING.getResult(ctx, 'ref'))
                            var fo  = String(Arguments.WORD.getResult(ctx, 'fadeOut'))
                            var n   = stop(ref, fo)
                            if (n > 0) { replyOk(ctx.source, `已软停止 [${ref}] (fadeOut=${fo}, 共 ${n} 个句柄)`); return 1 }
                            replyErr(ctx.source, `未找到匹配 [${ref}] 的活动句柄`)
                            return 0
                        })))))

            .then(Commands.literal('stopkey')
                .then(Commands.argument('key', Arguments.STRING.create(event))
                    .executes(guardExecution((ctx) => {
                        var key = String(Arguments.STRING.getResult(ctx, 'key'))
                        if (stopKey(key) > 0) { replyOk(ctx.source, `已停止 key=${key}`); return 1 }
                        replyErr(ctx.source, `没有找到 key=${key} 的句柄`)
                        return 0
                    }))))

            .then(Commands.literal('stoptag')
                .then(Commands.argument('tag', Arguments.STRING.create(event))
                    .executes(guardExecution((ctx) => {
                        var tag = String(Arguments.STRING.getResult(ctx, 'tag'))
                        var n   = stopTag(tag)
                        replyOk(ctx.source, `已停止 tag/group=${tag} 的 ${n} 个句柄`)
                        return n > 0 ? 1 : 0
                    }))))

            .then(Commands.literal('stopsound')
                .then(soundArgument()
                    .executes(guardExecution((ctx) => {
                        var n = stopSound(soundOf(ctx))
                        replyOk(ctx.source, `已结束 ${n} 个句柄`)
                        return n > 0 ? 1 : 0
                    }))
                    .then(Commands.argument('targets', Arguments.PLAYERS.create(event))
                        .executes(guardExecution((ctx) => {
                            var players = toJsArray(Arguments.PLAYERS.getResult(ctx, 'targets'))
                            var n       = stopFor(players, soundOf(ctx))
                            replyOk(ctx.source, `已对 ${players.length} 名玩家停止该音频，涉及 ${n} 个句柄`)
                            return n > 0 ? 1 : 0
                        })))))

            .then(Commands.literal('stopfor')
                .then(Commands.argument('targets', Arguments.PLAYERS.create(event))
                    .executes(guardExecution((ctx) => {
                        var players = toJsArray(Arguments.PLAYERS.getResult(ctx, 'targets'))
                        var n       = stopFor(players, null)
                        replyOk(ctx.source, `已对 ${players.length} 名玩家停止全部音频，涉及 ${n} 个句柄`)
                        return n > 0 ? 1 : 0
                    }))
                    .then(soundArgument()
                        .executes(guardExecution((ctx) => {
                            var players = toJsArray(Arguments.PLAYERS.getResult(ctx, 'targets'))
                            var n       = stopFor(players, soundOf(ctx))
                            replyOk(ctx.source, `已对 ${players.length} 名玩家停止指定音频，涉及 ${n} 个句柄`)
                            return n > 0 ? 1 : 0
                        })))))

            .then(Commands.literal('stopall')
                .executes(guardExecution((ctx) => {
                    var n = stopAll()
                    replyOk(ctx.source, `已结束全部 ${n} 个活动句柄`)
                    return 1
                }))
                .then(Commands.argument('fadeOut', Arguments.WORD.create(event))
                    .executes(guardExecution((ctx) => {
                        var fo = String(Arguments.WORD.getResult(ctx, 'fadeOut'))
                        var n  = stopAll(fo)
                        replyOk(ctx.source, `已软停止全部 ${n} 个活动句柄 (fadeOut=${fo})`)
                        return 1
                    }))))

            .then(Commands.literal('list')
                .executes(guardExecution((ctx) => {
                    var all = list()
                    replyOk(ctx.source, `当前活动音频句柄 ${all.length} 个${all.length > CONFIG.listMaxLines ? `（仅展示前 ${CONFIG.listMaxLines} 个）` : ''}`)
                    for (var i = 0; i < all.length && i < CONFIG.listMaxLines; i++) {
                        reply(ctx.source, describeHandle(all[i]))
                    }
                    return 1
                })))

            .then(Commands.literal('info')
                .then(Commands.argument('ref', Arguments.STRING.create(event))
                    .executes(guardExecution((ctx) => {
                        var ref  = String(Arguments.STRING.getResult(ctx, 'ref'))
                        var info = get(ref)
                        if (info == null) { replyErr(ctx.source, `句柄或 key [${ref}] 不存在`); return 0 }
                        reply(ctx.source, describeHandle(info))
                        var names = listeners(ref)
                        reply(ctx.source, `§7当前收听玩家: §f${names.length > 0 ? names.join(', ') : '（无）'}`)
                        return 1
                    }))))
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
        summary:   '通用空间音频与流式声场调度指令 (/epiphy audio ...)',
        helpLines: AUDIO_HELP_LINES,
        buildNode: buildAudioCommandNode
    }

    var valveMissing = false

    function checkValveRegistration(quiet) {
        var queue = (typeof global !== 'undefined' && global != null) ? global.EpiphyCommandRegistryQueue : null
        var valve = (typeof global !== 'undefined' && global != null)
            ? (global.EpiphyPermissionValve || global.PermissionValve)
            : null
        var stillQueued = Array.isArray(queue) && queue.includes(audioSubcommandSpec)
        var missing = (valve == null || stillQueued)
        valveMissing = missing
        if (missing && !quiet) {
            console.info('[EpiphyAudio] 未检测到权限阀组件 (EpiphyPermissionValve)，/epiphy audio 指令功能未生效（JS 调用接口正常）。')
        }
        return missing
    }

    try {
        var valve = (typeof global !== 'undefined' && global != null)
            ? (global.EpiphyPermissionValve || global.PermissionValve)
            : null
        if (valve != null && typeof valve.registerSubcommand === 'function') {
            valve.registerSubcommand(audioSubcommandSpec)
        } else {
            if (!Array.isArray(global.EpiphyCommandRegistryQueue)) {
                global.EpiphyCommandRegistryQueue = []
            }
            var q = global.EpiphyCommandRegistryQueue
            for (var qi = q.length - 1; qi >= 0; qi--) {
                if (q[qi] != null && q[qi].name === 'audio') q.splice(qi, 1)
            }
            q.push(audioSubcommandSpec)
        }
    } catch (eReg) {
        console.warn(`[EpiphyAudio] 注册 /epiphy audio 指令时出现异常，已终止指令注册: ${eReg}`)
    }
})()
