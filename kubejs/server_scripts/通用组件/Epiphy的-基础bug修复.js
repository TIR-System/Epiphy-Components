// priority: 900
// ============================================================================
//  基础 Bug 修复组件 (EpiphyBugfix v1)
//  所属系列：Epiphy的-通用组件系列（本系列包含 startup / server / client 配套脚本）
//  [LLM 协作规范] 每次进行较大修改或重构前，请先将修改同步至 <repo-root> 并执行 git commit 保存当前可用状态，便于随时回退与对比 diff。
//  许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
//  放置位置：kubejs/server_scripts/通用组件/Epiphy的-基础bug修复.js
//
//  职责说明：
//    1. 【退出HP保留修复】原版在重进世界读档时先于各类饰品/能力/延迟 Tick 属性修饰符调用
//       `LivingEntity.setHealth()`，导致高血上限玩家的当前 HP 被按默认上限（通常为 20）强行截断。
//       本模块纯服务端记录玩家退出/停服前夕的真实 HP，并在重进后于短窗口内随服务端真实
//       `maxHealth` 恢复而增量补齐。
//    2. 【零客户端信任】严禁依赖/接收客户端上传的 HP 或上限值（防篡改、防网络同步延迟），
//       所有读写均仅取自服务端 `ServerPlayer` 实体与服务端按存档隔离的持久化存储。
//    3. 【删 Mod 上限收缩兼容】若重进并等待属性结算窗口结束后，真实 `maxHealth` 低于原退出 HP，
//       超出部分直接丢弃，不强制抬升也不留存待补“血量欠款”。
//
//  依赖与缺失影响：
//    - 无任何前置硬依赖，可独立放入任意 KubeJS 2001 服务端脚本目录生效（priority: 900）。
//    - 可选依赖：kubejs/server_scripts/通用组件/Epiphy的-日志.js (EpiphyLog, priority: 1100)；
//      存在时限频异常、调试与信息日志自动接入 EpiphyLog，缺失时平滑回退至内置限频 console 输出。
//
//  [语法规范] 遵循 README-LLM.md §1 强制语法基准（与 docs/kube-mods-rhino-es5-es6-compatibility.md）：
//    以 ES5 + `var` 为主，可按需谨慎使用经实测无语义偏移的 ES6/ES2020 扩展语法；
//    严禁使用 `??`、`let`/`const`、对象属性简写/计算属性、展开与默认参数等已确认高危/失效特性。
// ============================================================================

;(function () {
    var VERSION         = 1
    var MODULE_NAME     = 'EpiphyBugfix'
    var WORLD_FILE_NAME = 'kubejs_epiphy_bugfix_hp.json'
    var PERSIST_KEY     = 'epiphy_bugfix_logout_hp_v1'
    var EPSILON         = 0.001

    var CONFIG = {
        // 登录后等待各类饰品 / Capability / 周期属性刷新的最大服务端 Tick 窗口（25 ticks ≈ 1.25s）
        settleWindowTicks: 25,
        // 兜底 console 警告限频间隔（仅在未安装 EpiphyLog 时生效）
        fallbackLogIntervalMs: 5000,
        // 未安装 EpiphyLog 时是否打印 debug 详情
        debug: false
    }

    var records             = {} // uuid -> { hp, max, recordedAtMs }
    var pendingSessions     = {} // uuid -> session state
    var pendingCount        = 0
    var loadedServerRef     = null
    var loadedStoragePath   = null
    var serverTicks         = 0
    var fallbackWarnBuckets = {}

    var LEVEL_RESOURCE_PROBED = false
    var LEVEL_RESOURCE_ROOT   = null
    var JAVA_FILE_PROBED      = false
    var JAVA_FILE_CLASS       = null
    var KUBEJS_PATHS_PROBED   = false
    var KUBEJS_PATHS_CLASS    = null
    var JAVA_UUID_PROBED      = false
    var JAVA_UUID_CLASS       = null
    var FAKE_PLAYER_PROBED    = false
    var FAKE_PLAYER_CLASS     = null

    function hasOwn(obj, key) {
        return obj != null && Object.prototype.hasOwnProperty.call(obj, key)
    }

    function resolveEpiphyLog() {
        if (typeof global === 'undefined' || global == null) return null
        return global.EpiphyLog || global.EpiphyLogger || null
    }

    // 【catch 约定】日志兜底函数仅吞掉 console 不可用时的底线异常，避免因日志本身引发递归报错。
    function emitFallbackConsole(level, text) {
        try {
            if (level === 'error') {
                console.error(text)
            } else if (level === 'info' || level === 'debug') {
                console.info(text)
            } else {
                console.warn(text)
            }
        } catch (e) { }
    }

    function fallbackRateLog(level, tag, text) {
        var now = Date.now()
        var k   = level + '|' + tag
        var b   = fallbackWarnBuckets[k]
        if (b == null) {
            b = { lastAt: 0, suppressed: 0 }
            fallbackWarnBuckets[k] = b
        }
        if ((now - b.lastAt) >= CONFIG.fallbackLogIntervalMs) {
            var tail = b.suppressed > 0 ? (' (另有 ' + b.suppressed + ' 次被折叠)') : ''
            b.lastAt     = now
            b.suppressed = 0
            emitFallbackConsole(level, '[' + MODULE_NAME + ' ' + tag + '] ' + String(text) + tail)
        } else {
            b.suppressed++
        }
    }

    function logInfo(tag, msg) {
        var logApi = resolveEpiphyLog()
        if (logApi != null && typeof logApi.info === 'function') {
            logApi.info(MODULE_NAME, tag, msg)
        } else {
            emitFallbackConsole('info', '[' + MODULE_NAME + ' ' + tag + '] ' + String(msg))
        }
    }

    function logWarn(tag, msg) {
        var logApi = resolveEpiphyLog()
        if (logApi != null && typeof logApi.warn === 'function') {
            logApi.warn(MODULE_NAME, tag, msg)
        } else {
            fallbackRateLog('warn', tag, msg)
        }
    }

    function logCatch(tag, err) {
        var logApi = resolveEpiphyLog()
        if (logApi != null && typeof logApi.catchWarn === 'function') {
            logApi.catchWarn(MODULE_NAME, tag, err)
        } else {
            fallbackRateLog('warn', '异常:' + tag, String(err))
        }
    }

    function logDebug(tag, msg) {
        var logApi = resolveEpiphyLog()
        if (logApi != null && typeof logApi.debug === 'function') {
            logApi.debug(MODULE_NAME, tag, msg)
        } else if (CONFIG.debug) {
            emitFallbackConsole('debug', '[' + MODULE_NAME + ' DEBUG:' + tag + '] ' + String(msg))
        }
    }

    function probeJavaClass(className) {
        if (typeof Java === 'undefined' || Java == null || typeof Java.loadClass !== 'function') return null
        try {
            return Java.loadClass(className)
        } catch (e) {
            return null
        }
    }

    function getLevelResourceRoot() {
        if (!LEVEL_RESOURCE_PROBED) {
            LEVEL_RESOURCE_PROBED = true
            var cls = probeJavaClass('net.minecraft.world.level.storage.LevelResource')
            if (cls != null) LEVEL_RESOURCE_ROOT = cls.ROOT || null
        }
        return LEVEL_RESOURCE_ROOT
    }

    function getJavaFileClass() {
        if (!JAVA_FILE_PROBED) {
            JAVA_FILE_PROBED = true
            JAVA_FILE_CLASS = probeJavaClass('java.io.File')
        }
        return JAVA_FILE_CLASS
    }

    function getKubeJsPathsClass() {
        if (!KUBEJS_PATHS_PROBED) {
            KUBEJS_PATHS_PROBED = true
            KUBEJS_PATHS_CLASS = probeJavaClass('dev.latvian.mods.kubejs.KubeJSPaths')
        }
        return KUBEJS_PATHS_CLASS
    }

    function getJavaUuidClass() {
        if (!JAVA_UUID_PROBED) {
            JAVA_UUID_PROBED = true
            JAVA_UUID_CLASS  = probeJavaClass('java.util.UUID')
        }
        return JAVA_UUID_CLASS
    }

    function isFakePlayer(player) {
        if (player == null) return true
        if (player.fake === true) return true
        if (typeof player.isFake === 'function' && player.isFake()) return true
        if (!FAKE_PLAYER_PROBED) {
            FAKE_PLAYER_PROBED = true
            FAKE_PLAYER_CLASS  = probeJavaClass('net.minecraftforge.common.util.FakePlayer')
        }
        if (FAKE_PLAYER_CLASS != null) {
            try {
                if (player instanceof FAKE_PLAYER_CLASS) return true
            } catch (e) { }
        }
        return false
    }

    function isPlayerEntity(entity) {
        if (entity == null) return false
        if (typeof entity.isPlayer === 'function') {
            try {
                return Boolean(entity.isPlayer())
            } catch (e) { }
        }
        return extractPlayerUuid(entity) !== '' && (typeof entity.getHealth === 'function' || entity.health !== undefined)
    }

    function extractPlayerUuid(player) {
        if (player == null) return ''
        try {
            if (typeof player.getStringUUID === 'function') {
                var u0 = player.getStringUUID()
                if (u0 != null && String(u0).trim() !== '') return String(u0).trim()
            }
        } catch (e0) { }
        try {
            if (typeof player.getUUID === 'function') {
                var u1 = player.getUUID()
                if (u1 != null && String(u1).trim() !== '') return String(u1).trim()
            }
        } catch (e1) { }
        var raw = player.stringUUID != null
            ? player.stringUUID
            : (player.stringUuid != null ? player.stringUuid : player.uuid)
        return raw != null ? String(raw).trim() : ''
    }

    function extractPlayerName(player) {
        if (player == null) return 'unknown'
        if (player.username != null && String(player.username) !== '') return String(player.username)
        if (typeof player.getScoreboardName === 'function') {
            try {
                var sn = player.getScoreboardName()
                if (sn != null && String(sn) !== '') return String(sn)
            } catch (e) { }
        }
        return extractPlayerUuid(player) || 'unknown'
    }

    function readHealth(player) {
        if (player == null) return NaN
        var raw = (typeof player.getHealth === 'function') ? player.getHealth() : player.health
        return Number(raw)
    }

    function readMaxHealth(player) {
        if (player == null) return NaN
        var raw = (typeof player.getMaxHealth === 'function') ? player.getMaxHealth() : player.maxHealth
        return Number(raw)
    }

    function writeHealth(player, value) {
        if (player == null || !isFinite(value)) return false
        var safeVal = Math.max(0, value)
        if (typeof player.setHealth === 'function') {
            player.setHealth(safeVal)
            return true
        }
        player.health = safeVal
        return true
    }

    function isPlayerDead(player) {
        if (player == null) return true
        if (player.dead === true) return true
        if (typeof player.isDeadOrDying === 'function') {
            try {
                if (player.isDeadOrDying()) return true
            } catch (e) { }
        }
        if (typeof player.isAlive === 'function') {
            try {
                if (!player.isAlive()) return true
            } catch (e2) { }
        }
        var hp = readHealth(player)
        return !isFinite(hp) || hp <= 0
    }

    function unwrapValue(val) {
        if (val == null) return null
        if (typeof val.isNumber === 'function' && val.isNumber() && typeof val.getAsDouble === 'function') {
            try { return Number(val.getAsDouble()) } catch (e0) { }
        }
        if (typeof val.getAsNumber === 'function') {
            try { return Number(val.getAsNumber()) } catch (e1) { }
        }
        if (typeof val.getAsString === 'function') {
            try { return String(val.getAsString()) } catch (e2) { }
        }
        return val
    }

    function readField(obj, key) {
        if (obj == null) return null
        if (typeof obj.get === 'function') {
            try { return unwrapValue(obj.get(key)) } catch (e) { }
        }
        return obj[key]
    }

    function forEachMapEntry(mapObj, cb) {
        if (mapObj == null || typeof cb !== 'function') return
        if (typeof mapObj.keySet === 'function' && typeof mapObj.get === 'function') {
            var it = mapObj.keySet().iterator()
            while (it.hasNext()) {
                var k = String(it.next())
                cb(k, mapObj.get(k))
            }
            return
        }
        if (typeof mapObj === 'object') {
            for (var pk in mapObj) {
                if (hasOwn(mapObj, pk)) cb(pk, mapObj[pk])
            }
        }
    }

    // ------------------------------------------------------------------------
    // 纯函数核心（供运行时调用与单元测试直接覆盖）
    // ------------------------------------------------------------------------

    function sanitizeHpRecord(rawHp, rawMax, recordedAtMs) {
        var hp  = Number(rawHp)
        var max = Number(rawMax)
        if (!isFinite(hp) || hp <= 0 || !isFinite(max) || max <= 0) return null
        var clampedHp = Math.min(hp, max)
        var ts = (recordedAtMs != null && isFinite(Number(recordedAtMs)) && Number(recordedAtMs) > 0)
            ? Number(recordedAtMs)
            : Date.now()
        return {
            hp:           clampedHp,
            max:          max,
            recordedAtMs: ts
        }
    }

    // 在登录结算窗口尚未结束前再次退出，保留未补完且未被扣血消耗的剩余上限额度
    function computeLogoutRecordFromState(curHp, curMax, isDead, activeSession) {
        var hp  = Number(curHp)
        var max = Number(curMax)
        if (isDead || !isFinite(hp) || hp <= 0 || !isFinite(max) || max <= 0) return null

        if (activeSession != null && !activeSession.settled) {
            var remaining    = Math.max(0, activeSession.recordedHp - activeSession.grantedCap)
            var carriedHp    = Math.min(activeSession.recordedHp, hp + remaining)
            var effectiveHp  = Math.max(Math.min(hp, max), carriedHp)
            var effectiveMax = Math.max(max, activeSession.recordedMax || max)
            return sanitizeHpRecord(effectiveHp, effectiveMax, Date.now())
        }
        return sanitizeHpRecord(hp, max, Date.now())
    }

    // 登录恢复状态转移：
    //   1. 只发放自上次 tick 以来 `curMax` 新解锁的那部分上限差额（不会抹平等待期玩家刚受的伤害）
    //   2. 若达到 `recordedHp` 或到达 `settleWindowTicks`，立即结束恢复；若因删 Mod 导致真实上限更低，
    //      未补完的超出部分随窗口到期一并作废，绝不结转到后续时刻。
    function computeRestoreStep(curHp, curMax, isDead, session, elapsedTicks, settleWindowTicks) {
        var hp  = Number(curHp)
        var max = Number(curMax)
        if (isDead || !isFinite(hp) || hp <= 0 || !isFinite(max) || max <= 0) {
            if (session != null) session.settled = true
            return { action: 'abort', newHp: hp, applied: 0, done: true, reason: 'dead_or_invalid' }
        }

        var targetByNow = Math.min(session.recordedHp, max)
        var prevCovered = Math.min(session.recordedHp, session.grantedCap)
        var newHp       = hp
        var applied     = 0

        if (targetByNow > prevCovered + EPSILON) {
            var grant     = targetByNow - prevCovered
            var candidate = Math.min(max, hp + grant)
            applied       = Math.max(0, candidate - hp)
            newHp         = candidate
            session.grantedCap = targetByNow
        }

        var fullyRestored = session.grantedCap >= (session.recordedHp - EPSILON)
        var windowExpired = elapsedTicks >= settleWindowTicks
        var done          = fullyRestored || windowExpired
        var reason        = fullyRestored
            ? 'restored'
            : (windowExpired ? 'window_expired_clamped' : 'pending')

        if (done) session.settled = true

        return {
            action:  applied > EPSILON ? 'heal' : 'noop',
            newHp:   newHp,
            applied: applied,
            done:    done,
            reason:  reason
        }
    }

    // ------------------------------------------------------------------------
    // 服务端按存档隔离的持久化读写（优先 <world>/kubejs_epiphy_bugfix_hp.json，回退 server.persistentData）
    // 说明：退出 HP 属于随存档状态同步回滚的实体数据（非抗回滚安全配置），因此刻意保留在 saves/<world>/ 而非 epiphy-data/（且本模块保持零硬依赖）。
    // ------------------------------------------------------------------------

    function resolveWorldFilePath(server) {
        if (server == null) return null
        try {
            var rootRes = getLevelResourceRoot()
            if (rootRes != null && typeof server.getWorldPath === 'function') {
                var rootPath = server.getWorldPath(rootRes)
                if (rootPath != null) {
                    var normRoot = (typeof rootPath.toAbsolutePath === 'function')
                        ? rootPath.toAbsolutePath().normalize()
                        : ((typeof rootPath.normalize === 'function') ? rootPath.normalize() : rootPath)
                    if (normRoot != null) {
                        var normStr = String(normRoot)
                        if (normStr && normStr !== '[object Object]' && normStr.indexOf('undefined') !== 0) {
                            return normStr.replace(/\\/g, '/').replace(/(?:\/+\.)*\/*$/, '') + '/' + WORLD_FILE_NAME
                        }
                        if (typeof normRoot.resolve === 'function') {
                            return String(normRoot.resolve(WORLD_FILE_NAME).normalize()).replace(/\\/g, '/')
                        }
                    }
                }
            }
        } catch (e) {
            logCatch('resolveWorldFilePath', e)
        }
        return null
    }

    function ensureParentDir(filePathStr) {
        if (!filePathStr) return false
        var norm = String(filePathStr).replace(/\\/g, '/')
        var slashIdx = norm.lastIndexOf('/')
        var kjPaths = getKubeJsPathsClass()
        if (slashIdx > 0 && kjPaths != null && typeof kjPaths.dir === 'function') {
            try {
                var parentDir = norm.slice(0, slashIdx)
                if (parentDir && kjPaths.dir(parentDir) != null) return true
            } catch (eKj) { }
        }
        var fileCls = getJavaFileClass()
        if (fileCls == null) return false
        try {
            var f = new fileCls(String(filePathStr))
            var p = f.getParentFile()
            if (p != null && !p.exists()) return Boolean(p.mkdirs())
            return true
        } catch (e) {
            logCatch('ensureParentDir', e)
            return false
        }
    }

    function importPlayerMap(playersNode) {
        if (playersNode == null) return 0
        var count = 0
        forEachMapEntry(playersNode, function (uuid, entry) {
            if (!uuid || entry == null) return
            var clean = sanitizeHpRecord(
                readField(entry, 'hp'),
                readField(entry, 'max'),
                readField(entry, 'recordedAtMs')
            )
            if (clean != null) {
                records[uuid] = clean
                count++
            }
        })
        return count
    }

    function readServerPersistentJson(server) {
        if (server == null || server.persistentData == null) return null
        try {
            var pd  = server.persistentData
            var raw = (typeof pd.getString === 'function') ? pd.getString(PERSIST_KEY) : pd[PERSIST_KEY]
            if (raw != null && String(raw).length > 0) {
                return JSON.parse(String(raw))
            }
        } catch (e) {
            logCatch('readServerPersistentJson', e)
        }
        return null
    }

    function writeServerPersistentJson(server, payloadObj) {
        if (server == null || server.persistentData == null) return false
        try {
            var pd      = server.persistentData
            var jsonStr = JSON.stringify(payloadObj)
            if (typeof pd.putString === 'function') {
                pd.putString(PERSIST_KEY, jsonStr)
            } else {
                pd[PERSIST_KEY] = jsonStr
            }
            return true
        } catch (e) {
            logCatch('writeServerPersistentJson', e)
            return false
        }
    }

    var storageCorruptBlocked = false

    function resolveServerBase() {
        if (typeof global === 'undefined' || global == null) return null
        return global.EpiphyServerBase || null
    }

    function ensureLoaded(server) {
        var srv = server
        if (srv == null || loadedServerRef === srv) return
        loadedServerRef       = srv
        loadedStoragePath     = resolveWorldFilePath(srv)
        records               = {}
        pendingSessions       = {}
        pendingCount          = 0
        storageCorruptBlocked = false

        var loadedFromJsonIo = false
        var diskCorrupt      = false
        var baseApi          = resolveServerBase()

        if (loadedStoragePath != null) {
            if (baseApi != null && typeof baseApi.readJsonDetailed === 'function') {
                var detailRes = baseApi.readJsonDetailed(loadedStoragePath, null, true)
                if (detailRes.status === 'ok' && detailRes.data != null) {
                    var pf0 = readField(detailRes.data, 'players')
                    if (pf0 != null) {
                        importPlayerMap(pf0)
                        loadedFromJsonIo = true
                    }
                } else if (detailRes.status === 'corrupt') {
                    diskCorrupt = true
                }
            } else if (typeof JsonIO !== 'undefined' && JsonIO != null && typeof JsonIO.read === 'function') {
                var rawObj = null
                try {
                    rawObj = JsonIO.read(loadedStoragePath)
                } catch (eJson) {
                    diskCorrupt = true
                    logCatch('ensureLoaded:JsonIO', eJson)
                }
                if (rawObj == null && diskCorrupt) {
                    try {
                        var bakObj = JsonIO.read(loadedStoragePath + '.bak')
                        if (bakObj != null) {
                            rawObj = bakObj
                            diskCorrupt = false
                            logWarn('ensureLoaded:bakRecovered', '主文件损坏，已从备份恢复: ' + loadedStoragePath + '.bak')
                        }
                    } catch (eBak) { }
                }
                if (rawObj != null) {
                    var playersField = readField(rawObj, 'players')
                    if (playersField != null) {
                        importPlayerMap(playersField)
                        loadedFromJsonIo = true
                    }
                }
            }
        }

        if (!loadedFromJsonIo) {
            var pdObj = readServerPersistentJson(srv)
            if (pdObj != null && pdObj.players != null) {
                importPlayerMap(pdObj.players)
                if (diskCorrupt && Object.keys(records).length > 0) {
                    diskCorrupt = false
                    flushStorage(srv)
                }
            } else if (diskCorrupt) {
                storageCorruptBlocked = true
                logWarn('ensureLoaded:corrupt', 'HP 持久化文件损坏且无可用备份 (' + loadedStoragePath + ')，已挂起空表覆写保护')
            }
        }
    }

    function flushStorage(server) {
        var srv = server || loadedServerRef
        if (srv == null) return false
        var exportPlayers = {}
        var playerCount   = 0
        for (var uuid in records) {
            if (hasOwn(records, uuid) && records[uuid] != null) {
                exportPlayers[uuid] = {
                    hp:           records[uuid].hp,
                    max:          records[uuid].max,
                    recordedAtMs: records[uuid].recordedAtMs
                }
                playerCount++
            }
        }
        if (storageCorruptBlocked && playerCount === 0) {
            return false
        }
        var payload = {
            version: VERSION,
            players: exportPlayers
        }

        // 始终同步双写一份到 srv.persistentData，确保 JSON 文件意外截断时仍可无损恢复
        var wrotePd   = writeServerPersistentJson(srv, payload)
        var wroteDisk = false
        var baseApi   = resolveServerBase()

        if (loadedStoragePath != null) {
            if (baseApi != null && typeof baseApi.writeJsonAtomic === 'function') {
                wroteDisk = Boolean(baseApi.writeJsonAtomic(loadedStoragePath, payload, true))
            } else if (typeof JsonIO !== 'undefined' && JsonIO != null && typeof JsonIO.write === 'function') {
                try {
                    ensureParentDir(loadedStoragePath)
                    if (typeof JsonIO.read === 'function') {
                        try {
                            var prev = JsonIO.read(loadedStoragePath)
                            if (prev != null) {
                                JsonIO.write(loadedStoragePath + '.bak', prev)
                            }
                        } catch (ePrevBak) { }
                    }
                    JsonIO.write(loadedStoragePath, payload)
                    wroteDisk = true
                } catch (eJsonWrite) {
                    logCatch('flushStorage:JsonIO', eJsonWrite)
                }
            }
        }
        if (wroteDisk) {
            storageCorruptBlocked = false
        }
        return Boolean(wroteDisk || wrotePd)
    }

    function removePendingSession(uuid) {
        if (hasOwn(pendingSessions, uuid)) {
            delete pendingSessions[uuid]
            pendingCount = Math.max(0, pendingCount - 1)
            return true
        }
        return false
    }

    function clearPlayerState(server, uuid, shouldFlush) {
        var changed = false
        if (removePendingSession(uuid)) changed = true
        if (hasOwn(records, uuid)) {
            delete records[uuid]
            changed = true
        }
        if (changed && shouldFlush !== false) {
            flushStorage(server)
        }
        return changed
    }

    function capturePlayerLogout(server, player, skipFlush) {
        if (player == null || isFakePlayer(player)) return false
        var uuid = extractPlayerUuid(player)
        if (!uuid) return false

        var srv = server || player.server || loadedServerRef
        ensureLoaded(srv)

        var activeSess = hasOwn(pendingSessions, uuid) ? pendingSessions[uuid] : null
        removePendingSession(uuid)

        var rec = computeLogoutRecordFromState(
            readHealth(player),
            readMaxHealth(player),
            isPlayerDead(player),
            activeSess
        )

        if (rec == null) {
            var had = hasOwn(records, uuid)
            if (had) delete records[uuid]
            if (had && !skipFlush) flushStorage(srv)
            logDebug('logoutClear', 'player=' + extractPlayerName(player) + ' 已死亡或无效血量，清除旧退出记录')
            return false
        }

        records[uuid] = rec
        if (!skipFlush) flushStorage(srv)
        logDebug('logoutSave', 'player=' + extractPlayerName(player) + ' hp=' + rec.hp + '/' + rec.max)
        return true
    }

    function isPlayerDetached(player) {
        if (player == null) return true
        try {
            if (typeof player.hasDisconnected === 'function' && player.hasDisconnected()) return true
        } catch (e0) { }
        try {
            if (typeof player.isRemoved === 'function' && player.isRemoved()) return true
        } catch (e1) { }
        return false
    }

    function resolveOnlinePlayer(server, uuid, fallbackRef) {
        var hasAuthoritativeLookup = false
        if (server != null) {
            if (typeof server.getPlayerList === 'function') {
                try {
                    var plist = server.getPlayerList()
                    if (plist != null) {
                        var uuidCls = getJavaUuidClass()
                        if (uuidCls != null && typeof plist.getPlayer === 'function') {
                            try {
                                var parsedUuid = uuidCls.fromString(uuid)
                                hasAuthoritativeLookup = true
                                var byUuid = plist.getPlayer(parsedUuid)
                                return (byUuid != null && !isPlayerDetached(byUuid)) ? byUuid : null
                            } catch (eUuid) { }
                        }
                        if (typeof plist.getPlayerByName === 'function' && fallbackRef != null) {
                            hasAuthoritativeLookup = true
                            var byName = plist.getPlayerByName(extractPlayerName(fallbackRef))
                            return (byName != null && extractPlayerUuid(byName) === uuid && !isPlayerDetached(byName))
                                ? byName
                                : null
                        }
                    }
                } catch (e1) { }
            }
            if (!hasAuthoritativeLookup && typeof server.getPlayer === 'function') {
                try {
                    hasAuthoritativeLookup = true
                    var p0 = server.getPlayer(uuid)
                    return (p0 != null && !isPlayerDetached(p0)) ? p0 : null
                } catch (e0) { }
            }
        }
        return !isPlayerDetached(fallbackRef) ? fallbackRef : null
    }

    // ------------------------------------------------------------------------
    // KubeJS 服务端事件绑定（守卫注册，兼容独立单元测试沙箱）
    // ------------------------------------------------------------------------

    if (typeof PlayerEvents !== 'undefined' && PlayerEvents != null) {
        if (typeof PlayerEvents.loggedOut === 'function') {
            PlayerEvents.loggedOut(function (event) {
                try {
                    if (event == null || event.player == null) return
                    capturePlayerLogout(event.server, event.player, false)
                } catch (e) {
                    logCatch('PlayerEvents.loggedOut', e)
                }
            })
        }

        if (typeof PlayerEvents.loggedIn === 'function') {
            PlayerEvents.loggedIn(function (event) {
                try {
                    if (event == null || event.player == null) return
                    var player = event.player
                    if (isFakePlayer(player)) return

                    var uuid = extractPlayerUuid(player)
                    if (!uuid) return

                    var srv = event.server || player.server || loadedServerRef
                    ensureLoaded(srv)

                    if (!hasOwn(records, uuid)) return
                    var rec = sanitizeHpRecord(records[uuid].hp, records[uuid].max, records[uuid].recordedAtMs)
                    if (rec == null || isPlayerDead(player)) {
                        clearPlayerState(srv, uuid, true)
                        return
                    }

                    var curHp  = readHealth(player)
                    var curMax = readMaxHealth(player)
                    if (!isFinite(curHp) || !isFinite(curMax) || curMax <= 0) {
                        clearPlayerState(srv, uuid, true)
                        return
                    }

                    // 若重进后血量本身已达到退出记录（例如原版已完整保留），无需任何调度直接清理
                    if (curHp >= rec.hp - EPSILON) {
                        logDebug('loginSkip', 'player=' + extractPlayerName(player) + ' curHp=' + curHp + ' >= recorded=' + rec.hp + '，无需补回')
                        clearPlayerState(srv, uuid, true)
                        return
                    }

                    if (!hasOwn(pendingSessions, uuid)) pendingCount++
                    pendingSessions[uuid] = {
                        uuid:          uuid,
                        playerName:    extractPlayerName(player),
                        playerRef:     player,
                        recordedHp:    rec.hp,
                        recordedMax:   rec.max,
                        grantedCap:    curHp,
                        startTick:     serverTicks,
                        restoredTotal: 0,
                        settled:       false
                    }
                    logDebug('loginQueue', 'player=' + extractPlayerName(player) +
                        ' curHp=' + curHp + ' curMax=' + curMax +
                        ' recorded=' + rec.hp + '/' + rec.max)
                } catch (e) {
                    logCatch('PlayerEvents.loggedIn', e)
                }
            })
        }

        if (typeof PlayerEvents.respawned === 'function') {
            PlayerEvents.respawned(function (event) {
                try {
                    if (event == null || event.player == null) return
                    var uuid = extractPlayerUuid(event.player)
                    if (!uuid) return
                    var srv = event.server || event.player.server || loadedServerRef
                    ensureLoaded(srv)
                    clearPlayerState(srv, uuid, true)
                } catch (e) {
                    logCatch('PlayerEvents.respawned', e)
                }
            })
        }
    }

    if (typeof EntityEvents !== 'undefined' && EntityEvents != null && typeof EntityEvents.death === 'function') {
        EntityEvents.death(function (event) {
            try {
                if (event == null || event.entity == null) return
                var ent = event.entity
                if (!isPlayerEntity(ent) || isFakePlayer(ent)) return
                var uuid = extractPlayerUuid(ent)
                if (!uuid) return
                var srv = event.server || ent.server || loadedServerRef
                ensureLoaded(srv)
                clearPlayerState(srv, uuid, true)
            } catch (e) {
                logCatch('EntityEvents.death', e)
            }
        })
    }

    if (typeof ServerEvents !== 'undefined' && ServerEvents != null) {
        if (typeof ServerEvents.loaded === 'function') {
            ServerEvents.loaded(function (event) {
                try {
                    if (event != null && event.server != null) ensureLoaded(event.server)
                } catch (e) {
                    logCatch('ServerEvents.loaded', e)
                }
            })
        }

        if (typeof ServerEvents.tick === 'function') {
            ServerEvents.tick(function (event) {
                serverTicks++
                if (pendingCount === 0) return
                try {
                    var srv      = (event != null && event.server != null) ? event.server : loadedServerRef
                    var dirty    = false
                    var settleMs = Math.max(1, Number(CONFIG.settleWindowTicks) || 25)
                    var uuids    = Object.keys(pendingSessions)

                    for (var i = 0; i < uuids.length; i++) {
                        var uuid = uuids[i]
                        var sess = pendingSessions[uuid]
                        if (sess == null) continue

                        var player = resolveOnlinePlayer(srv, uuid, sess.playerRef)
                        if (player == null) {
                            removePendingSession(uuid)
                            continue
                        }

                        var curHp  = readHealth(player)
                        var curMax = readMaxHealth(player)
                        var dead   = isPlayerDead(player)
                        var elapsed = Math.max(0, serverTicks - sess.startTick)
                        var step    = computeRestoreStep(curHp, curMax, dead, sess, elapsed, settleMs)

                        if (step.action === 'heal') {
                            writeHealth(player, step.newHp)
                            sess.restoredTotal += step.applied
                        }

                        if (step.done) {
                            logDebug('loginSettle', 'player=' + sess.playerName +
                                ' reason=' + step.reason +
                                ' restored=' + sess.restoredTotal.toFixed(2) +
                                ' finalHp=' + (isFinite(step.newHp) ? step.newHp.toFixed(2) : String(step.newHp)) +
                                ' curMax=' + curMax +
                                ' recorded=' + sess.recordedHp + '/' + sess.recordedMax)
                            removePendingSession(uuid)
                            if (hasOwn(records, uuid)) {
                                delete records[uuid]
                                dirty = true
                            }
                        }
                    }

                    if (dirty) flushStorage(srv)
                } catch (e) {
                    logCatch('ServerEvents.tick', e)
                }
            })
        }

        if (typeof ServerEvents.unloaded === 'function') {
            ServerEvents.unloaded(function (event) {
                try {
                    var srv = (event != null && event.server != null) ? event.server : loadedServerRef
                    if (srv != null && srv.players != null) {
                        ensureLoaded(srv)
                        var pList = srv.players
                        if (typeof pList.iterator === 'function') {
                            var it = pList.iterator()
                            while (it.hasNext()) {
                                capturePlayerLogout(srv, it.next(), true)
                            }
                        } else if (Array.isArray(pList)) {
                            for (var pi = 0; pi < pList.length; pi++) {
                                capturePlayerLogout(srv, pList[pi], true)
                            }
                        }
                        flushStorage(srv)
                    } else if (srv != null && loadedServerRef === srv) {
                        flushStorage(srv)
                    }
                    pendingSessions       = {}
                    pendingCount          = 0
                    loadedServerRef       = null
                    loadedStoragePath     = null
                    storageCorruptBlocked = false
                    records               = {}
                } catch (e) {
                    logCatch('ServerEvents.unloaded', e)
                }
            })
        }
    }

    logInfo('init', 'EpiphyBugfix v' + VERSION + ' 已加载（无前置硬依赖；EpiphyLog=' + (resolveEpiphyLog() != null ? '已接入' : '内置兜底') + '）')

    global.EpiphyBugfix = {
        VERSION: VERSION,
        CONFIG:  CONFIG,
        getRecord: function (uuidOrPlayer) {
            var u = (typeof uuidOrPlayer === 'string') ? uuidOrPlayer : extractPlayerUuid(uuidOrPlayer)
            return (u && hasOwn(records, u)) ? records[u] : null
        },
        clearRecord: function (uuidOrPlayer) {
            var u = (typeof uuidOrPlayer === 'string') ? uuidOrPlayer : extractPlayerUuid(uuidOrPlayer)
            return u ? clearPlayerState(loadedServerRef, u, true) : false
        },
        getRecordCount: function () {
            return Object.keys(records).length
        },
        getPendingCount: function () {
            return pendingCount
        },
        _pure: {
            sanitizeHpRecord:              sanitizeHpRecord,
            computeLogoutRecordFromState:  computeLogoutRecordFromState,
            computeRestoreStep:            computeRestoreStep
        }
    }
})()
