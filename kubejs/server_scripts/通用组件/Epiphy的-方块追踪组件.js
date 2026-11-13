// priority: 1050
// ============================================================================
//  通用方块追踪与渐进式区块段扫描组件 (EpiphyBlockTracker v2)
//  所属系列：Epiphy的-通用组件系列（本系列包含 startup / server / client 配套脚本）
//  [LLM 协作规范] 每次进行较大修改或重构前，请先将修改同步至 D:\Git-Epiphy 并执行 git commit 保存当前可用状态，便于随时回退与对比 diff。
//  许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
//  放置位置：kubejs/server_scripts/通用组件/Epiphy的-方块追踪组件.js
//
//  职责说明：
//    1. 维护全服唯一的物理方块追踪表与 16x16x16 LevelChunkSection 渐进式扫描队列；
//       同一物理方块可同时被同系列多个业务订阅者（如 danmaku 与 audio）订阅，只扫一遍、只存一份；
//    2. 统一持久化至 server.persistentData ('epiphy_tracked_blocks_v2')；
//    3. 提供 migrateLegacyOnce(sourceSpec, blockId) 供业务侧声明旧存档数据一次性迁移，底座本身零业务耦合；
//    4. 每个订阅句柄支持 destroy() 彻底注销自身及其孤立追踪记录。
//
//  依赖与缺失降级：
//    - 可选依赖：kubejs/server_scripts/通用组件/Epiphy的-日志.js (EpiphyLog, priority: 1100)
//      缺失时回退至原生 console.warn / console.error（无限频与去重）。
//    - 若缺失本文件：同系列业务组件（Epiphy的-屏幕弹幕组件 / Epiphy的-音频组件）的 bindBlock 会降级为
//      基础事件兜底模式（仅支持新放置/破坏方块，无区块扫描与持久化），不影响非方块绑定的常规 API。
// ============================================================================

;(function () {
    var PERSIST_KEY           = 'epiphy_tracked_blocks_v2'
    var SCAN_ENQ_INTERVAL     = 20
    var SCAN_SECTIONS_PER_TICK = 2

    var SERVER_REF       = null
    var loadedPersistSrv = null
    var tickCounter      = 0

    // 共享物理方块池与扫描状态（全局唯一份）
    // bindingsByBlockId: Map<blockId, Map<subId, bindingMeta>>
    // subscribers:       Map<subId, subscriberObj>
    // trackedBlocks:     Map<posKey, { key, blockId, dim, x, y, z, extras: { [subId]: obj } }>
    var bindingsByBlockId = new Map()
    var subscribers       = new Map()
    var trackedBlocks     = new Map()
    var scannedSections   = new Set()
    var scanQueue         = []
    var migratedKeys      = new Set()
    var pendingMigrations = []

    function logCatch(tag, err) {
        if (typeof global !== 'undefined' && global.EpiphyLog != null) {
            global.EpiphyLog.catchWarn('EpiphyBlockTracker', tag, err)
        } else {
            try { console.warn('[EpiphyBlockTracker 异常:' + tag + '] ' + String(err)) } catch (e) { }
        }
    }

    function normalizeDim(dim) {
        if (dim == null) return null
        if (typeof dim === 'string') {
            var s = dim.trim()
            if (!s) return null
            return s.indexOf(':') >= 0 ? s : ('minecraft:' + s)
        }
        try {
            if (typeof dim.location === 'function') return String(dim.location())
        } catch (e0) { }
        try {
            if (dim.dimension != null) return normalizeDim(dim.dimension)
        } catch (e1) { }
        try {
            var str = String(dim)
            if (str && str.indexOf(':') >= 0 && str.indexOf('ServerLevel') < 0) return str
        } catch (e2) { }
        return null
    }

    function dimOfLevel(lv) {
        if (lv == null) return null
        try {
            if (lv.dimension != null) return normalizeDim(lv.dimension)
        } catch (e0) { }
        try {
            if (typeof lv.dimension === 'function') return normalizeDim(lv.dimension())
        } catch (e1) { }
        return null
    }

    function resolveLevel(levelOrDim, server) {
        if (levelOrDim != null && typeof levelOrDim === 'object' && typeof levelOrDim.getBlock === 'function') {
            return levelOrDim
        }
        var srv = server || SERVER_REF
        if (srv == null) return null
        var targetDim = normalizeDim(levelOrDim) || 'minecraft:overworld'
        try {
            if (typeof srv.getLevel === 'function') {
                var direct = srv.getLevel(targetDim)
                if (direct != null) return direct
            }
        } catch (e0) { }
        try {
            var all = srv.getAllLevels()
            if (all != null && typeof all.iterator === 'function') {
                var it = all.iterator()
                while (it.hasNext()) {
                    var lv = it.next()
                    if (dimOfLevel(lv) === targetDim) return lv
                }
            }
        } catch (e1) { }
        return null
    }

    function makePosKey(dim, x, y, z) {
        return String(dim || 'minecraft:overworld') + '|' + Math.floor(x) + ',' + Math.floor(y) + ',' + Math.floor(z)
    }

    function extractBlockId(blockOrState) {
        if (blockOrState == null) return null
        try { if (blockOrState.id != null) return String(blockOrState.id) } catch (e0) { }
        try { if (typeof blockOrState.getId === 'function') return String(blockOrState.getId()) } catch (e1) { }
        try {
            if (typeof blockOrState.getBlock === 'function') {
                var blk = blockOrState.getBlock()
                if (blk != null) {
                    if (blk.id != null) return String(blk.id)
                    if (typeof blk.getId === 'function') return String(blk.getId())
                }
            }
        } catch (e2) { }
        return null
    }

    function isChunkLoaded(lv, bx, bz) {
        if (lv == null) return false
        var cx = bx >> 4, cz = bz >> 4
        try {
            var cs = lv.getChunkSource()
            if (cs != null && cs.getChunkNow(cx, cz) != null) return true
        } catch (e0) { }
        try { return Boolean(lv.hasChunk(cx, cz)) } catch (e1) { return false }
    }

    function readPlayerPos(player) {
        if (player == null) return null
        try {
            if (typeof player.getX === 'function') {
                return { x: Number(player.getX()), y: Number(player.getY()), z: Number(player.getZ()) }
            }
            if (player.x != null) {
                return { x: Number(player.x), y: Number(player.y), z: Number(player.z) }
            }
        } catch (e) { }
        return null
    }

    // 为订阅者按需生成该方块的私有扩展字段并缓存到 rec.extras[subId]
    function ensureSubscriberView(rec, sub) {
        if (rec.extras == null) rec.extras = {}
        var extra = rec.extras[sub.id]
        if (extra == null) {
            extra = {}
            if (sub.makeRecordExtra != null) {
                try {
                    var built = sub.makeRecordExtra(rec.blockId, rec.dim, rec.x, rec.y, rec.z)
                    if (built != null && typeof built === 'object') {
                        for (var k in built) extra[k] = built[k]
                    }
                } catch (eEx) {
                    logCatch(sub.id + ':makeRecordExtra', eEx)
                }
            }
            rec.extras[sub.id] = extra
        }
        var view = {
            key:     rec.key,
            blockId: rec.blockId,
            dim:     rec.dim,
            x:       rec.x,
            y:       rec.y,
            z:       rec.z
        }
        for (var ek in extra) view[ek] = extra[ek]
        return view
    }

    function saveTrackedBlocks() {
        if (SERVER_REF == null) return
        try {
            var arr = []
            trackedBlocks.forEach(function (item) {
                arr.push([item.blockId, item.dim, item.x, item.y, item.z])
            })
            SERVER_REF.persistentData.putString(PERSIST_KEY, JSON.stringify(arr))
        } catch (eSave) {
            logCatch('saveTrackedBlocks', eSave)
        }
    }

    function dispatchFoundToSubscribers(rec, targetSubId, source) {
        var bMap = bindingsByBlockId.get(rec.blockId)
        if (bMap == null || bMap.size === 0) return
        bMap.forEach(function (binding, subId) {
            if (targetSubId != null && subId !== targetSubId) return
            var sub = subscribers.get(subId)
            if (sub != null && sub.onFound != null) {
                try {
                    sub.onFound(ensureSubscriberView(rec, sub), binding, source || 'unknown')
                } catch (eFound) {
                    logCatch(sub.id + ':onFound', eFound)
                }
            }
        })
    }

    function dispatchRemovedToSubscribers(rec, reason, extraArg, targetSubId) {
        var bMap = bindingsByBlockId.get(rec.blockId)
        if (bMap == null || bMap.size === 0) return
        bMap.forEach(function (binding, subId) {
            if (targetSubId != null && subId !== targetSubId) return
            var sub = subscribers.get(subId)
            if (sub != null && sub.onRemoved != null) {
                try {
                    sub.onRemoved(ensureSubscriberView(rec, sub), binding, reason, extraArg)
                } catch (eRem) {
                    logCatch(sub.id + ':onRemoved', eRem)
                }
            }
        })
    }

    function registerTrackedBlock(blockId, dim, x, y, z, saveNow, triggerFound, source) {
        var bMap = bindingsByBlockId.get(blockId)
        if (bMap == null || bMap.size === 0) return null
        var ix  = Math.floor(Number(x))
        var iy  = Math.floor(Number(y))
        var iz  = Math.floor(Number(z))
        var key = makePosKey(dim, ix, iy, iz)
        var rec = trackedBlocks.get(key)
        if (rec == null || rec.blockId !== blockId) {
            rec = { key: key, blockId: blockId, dim: dim, x: ix, y: iy, z: iz, extras: {} }
            trackedBlocks.set(key, rec)
            if (saveNow !== false) saveTrackedBlocks()
        }
        if (triggerFound) {
            dispatchFoundToSubscribers(rec, null, source)
        }
        return rec
    }

    function importSerializedBlockArray(rawStr, fallbackBlockId, sourceKey) {
        var imported = 0
        var skipped  = 0
        if (!rawStr || String(rawStr).length === 0) return 0
        var arr = JSON.parse(String(rawStr))
        if (!Array.isArray(arr)) return 0
        for (var i = 0; i < arr.length; i++) {
            var it = arr[i]
            if (!Array.isArray(it)) {
                skipped++
                continue
            }
            var bid, dim, bx, by, bz
            if (it.length >= 5) {
                bid = String(it[0])
                dim = normalizeDim(String(it[1])) || 'minecraft:overworld'
                bx  = Math.floor(Number(it[2]))
                by  = Math.floor(Number(it[3]))
                bz  = Math.floor(Number(it[4]))
            } else if (it.length >= 4 && fallbackBlockId != null) {
                bid = String(fallbackBlockId)
                dim = normalizeDim(String(it[0])) || 'minecraft:overworld'
                bx  = Math.floor(Number(it[1]))
                by  = Math.floor(Number(it[2]))
                bz  = Math.floor(Number(it[3]))
            } else {
                skipped++
                continue
            }
            if (!isFinite(bx) || !isFinite(by) || !isFinite(bz)) {
                skipped++
                continue
            }
            var key = makePosKey(dim, bx, by, bz)
            if (!trackedBlocks.has(key)) {
                trackedBlocks.set(key, { key: key, blockId: bid, dim: dim, x: bx, y: by, z: bz, extras: {} })
                imported++
            }
        }
        if (skipped > 0) {
            var warnMsg = '[EpiphyBlockTracker] 导入 ' + String(sourceKey || '持久化数据') + ' 时跳过 ' + skipped + ' 条格式不兼容的记录（缺少 blockId 或坐标非法）。'
            if (typeof global !== 'undefined' && global.EpiphyLog != null) {
                global.EpiphyLog.warn('EpiphyBlockTracker', 'importSkipped', warnMsg)
            } else {
                try { console.warn(warnMsg) } catch (e) { }
            }
        }
        return imported
    }

    function ensureLoaded() {
        if (SERVER_REF == null || loadedPersistSrv === SERVER_REF) return
        loadedPersistSrv = SERVER_REF
        scannedSections.clear()
        scanQueue.length = 0
        migratedKeys.clear()

        var loadKeys = [PERSIST_KEY, 'epiphy_danmaku_bound_blocks_v1', 'epiphy_audio_bound_blocks_v1']
        var importedLegacyV1 = 0
        for (var kIdx = 0; kIdx < loadKeys.length; kIdx++) {
            try {
                var raw = SERVER_REF.persistentData.getString(loadKeys[kIdx])
                var cnt = importSerializedBlockArray(raw, null, loadKeys[kIdx])
                if (kIdx > 0) importedLegacyV1 += cnt
            } catch (eLoad) {
                logCatch('ensureLoaded:' + loadKeys[kIdx], eLoad)
            }
        }
        if (importedLegacyV1 > 0) {
            saveTrackedBlocks()
        }
    }

    // 统一的一次性旧版数据迁移接口（由业务侧声明迁移源与目标 blockId，底座不硬编码任何业务 ID）
    function migrateLegacyOnce(sourceSpec, blockId) {
        if (sourceSpec == null || !blockId) return 0
        var specObj = (typeof sourceSpec === 'string') ? { serverKey: sourceSpec } : sourceSpec
        var bid     = String(blockId).trim()
        if (!bid) return 0

        if (SERVER_REF == null) {
            pendingMigrations.push({ spec: specObj, blockId: bid })
            return 0
        }
        ensureLoaded()

        var migKey = (specObj.serverKey || '') + '|' + (specObj.levelField || '') + '->' + bid
        if (migratedKeys.has(migKey)) return 0
        migratedKeys.add(migKey)

        var addedKeys = []
        if (specObj.serverKey) {
            try {
                var raw = SERVER_REF.persistentData.getString(String(specObj.serverKey))
                if (raw && String(raw).length > 0) {
                    var before = trackedBlocks.size
                    importSerializedBlockArray(raw, bid, specObj.serverKey)
                    if (trackedBlocks.size > before) {
                        trackedBlocks.forEach(function (rec, k) {
                            if (rec.blockId === bid) addedKeys.push(k)
                        })
                    }
                }
            } catch (eSrvMig) {
                logCatch('migrateLegacyOnce:serverKey', eSrvMig)
            }
        }

        if (specObj.levelField) {
            try {
                var fieldName = String(specObj.levelField)
                var allLv     = SERVER_REF.getAllLevels()
                if (allLv != null && typeof allLv.iterator === 'function') {
                    var lvIt = allLv.iterator()
                    while (lvIt.hasNext()) {
                        var lv = lvIt.next()
                        try {
                            var pd = lv.persistentData
                            if (pd != null && pd[fieldName] != null) {
                                var dl = pd[fieldName]
                                if (dl.x != null && dl.y != null && dl.z != null) {
                                    var ddim = dimOfLevel(lv) || 'minecraft:overworld'
                                    var dbx  = Math.floor(Number(dl.x))
                                    var dby  = Math.floor(Number(dl.y))
                                    var dbz  = Math.floor(Number(dl.z))
                                    var dkey = makePosKey(ddim, dbx, dby, dbz)
                                    if (!trackedBlocks.has(dkey)) {
                                        trackedBlocks.set(dkey, { key: dkey, blockId: bid, dim: ddim, x: dbx, y: dby, z: dbz, extras: {} })
                                        addedKeys.push(dkey)
                                    }
                                }
                            }
                        } catch (eLvItem) {
                            logCatch('migrateLegacyOnce:levelItem', eLvItem)
                        }
                    }
                }
            } catch (eLvAll) {
                logCatch('migrateLegacyOnce:levelField', eLvAll)
            }
        }

        if (addedKeys.length > 0) {
            saveTrackedBlocks()
            for (var a = 0; a < addedKeys.length; a++) {
                var rec = trackedBlocks.get(addedKeys[a])
                if (rec != null) dispatchFoundToSubscribers(rec, null, 'migrate')
            }
        }
        return addedKeys.length
    }

    function absorbGlobalMigrations() {
        if (typeof global !== 'undefined' && Array.isArray(global.EpiphyLegacyBlockMigrations) && global.EpiphyLegacyBlockMigrations.length > 0) {
            var list = global.EpiphyLegacyBlockMigrations.splice(0)
            for (var i = 0; i < list.length; i++) {
                var m = list[i]
                if (m != null && m.blockId) {
                    migrateLegacyOnce(m, m.blockId)
                }
            }
        }
        if (SERVER_REF != null && pendingMigrations.length > 0) {
            var pList = pendingMigrations.splice(0)
            for (var j = 0; j < pList.length; j++) {
                migrateLegacyOnce(pList[j].spec, pList[j].blockId)
            }
        }
    }

    function enqueueNearbySections() {
        if (bindingsByBlockId.size === 0 || SERVER_REF == null) return
        var maxRadius = 32
        bindingsByBlockId.forEach(function (bMap) {
            bMap.forEach(function (b) {
                if (b.scanRadius > maxRadius) maxRadius = b.scanRadius
            })
        })
        var pList = null
        try { pList = SERVER_REF.getPlayerList().getPlayers() } catch (e0) { return }
        if (pList == null) return
        var n = (typeof pList.size === 'function') ? Number(pList.size()) : (pList.length || 0)
        for (var i = 0; i < n; i++) {
            var p   = typeof pList.get === 'function' ? pList.get(i) : pList[i]
            var pos = readPlayerPos(p)
            if (pos == null) continue
            var dim = dimOfLevel(p.level) || 'minecraft:overworld'
            var minSX = Math.floor((pos.x - maxRadius) / 16)
            var maxSX = Math.floor((pos.x + maxRadius) / 16)
            var minSY = Math.floor((pos.y - maxRadius) / 16)
            var maxSY = Math.floor((pos.y + maxRadius) / 16)
            var minSZ = Math.floor((pos.z - maxRadius) / 16)
            var maxSZ = Math.floor((pos.z + maxRadius) / 16)
            for (var sx = minSX; sx <= maxSX; sx++) {
                for (var sy = minSY; sy <= maxSY; sy++) {
                    for (var sz = minSZ; sz <= maxSZ; sz++) {
                        var skey = dim + '|' + sx + ',' + sy + ',' + sz
                        if (scannedSections.has(skey)) continue
                        if (scannedSections.size >= 4096) {
                            var oldestSkey = scannedSections.values().next().value
                            if (oldestSkey !== undefined) scannedSections.delete(oldestSkey)
                        }
                        scannedSections.add(skey)
                        scanQueue.push({ dim: dim, sx: sx, sy: sy, sz: sz, skey: skey })
                    }
                }
            }
        }
    }

    function processScanSlice() {
        if (scanQueue.length === 0 || bindingsByBlockId.size === 0) return
        var processed = 0
        var dirty     = false
        while (scanQueue.length > 0 && processed < SCAN_SECTIONS_PER_TICK) {
            var task = scanQueue.shift()
            processed++
            var lv = resolveLevel(task.dim, null)
            if (lv == null) continue
            try {
                var cs    = lv.getChunkSource()
                var chunk = cs != null ? cs.getChunkNow(task.sx, task.sz) : (lv.hasChunk(task.sx, task.sz) ? lv.getChunk(task.sx, task.sz) : null)
                if (chunk == null) {
                    scannedSections.delete(task.skey)
                    continue
                }
                var sections  = chunk.getSections()
                var minBuildY = typeof chunk.getMinBuildHeight === 'function' ? Number(chunk.getMinBuildHeight()) : -64
                var secIdx    = (task.sy * 16 - minBuildY) >> 4
                if (sections == null || secIdx < 0 || secIdx >= sections.length) continue
                var section = sections[secIdx]
                if (section == null || section.hasOnlyAir()) continue
                var baseX = task.sx << 4, baseY = task.sy << 4, baseZ = task.sz << 4
                for (var ly = 0; ly < 16; ly++) {
                    var wy = baseY + ly
                    for (var lx = 0; lx < 16; lx++) {
                        var wx = baseX + lx
                        for (var lz = 0; lz < 16; lz++) {
                            var st   = section.getBlockState(lx, ly, lz)
                            var bid  = extractBlockId(st)
                            var bMap = bid != null ? bindingsByBlockId.get(bid) : null
                            if (bMap != null && bMap.size > 0) {
                                var wz  = baseZ + lz
                                var key = makePosKey(task.dim, wx, wy, wz)
                                if (!trackedBlocks.has(key)) {
                                    registerTrackedBlock(bid, task.dim, wx, wy, wz, false, true, 'scan')
                                    dirty = true
                                }
                            }
                        }
                    }
                }
            } catch (eScan) {
                logCatch('scanSection', eScan)
            }
        }
        if (dirty) saveTrackedBlocks()
    }

    function tickAllTrackedBlocks() {
        if (SERVER_REF == null) return
        ensureLoaded()
        absorbGlobalMigrations()
        if (bindingsByBlockId.size === 0) return

        if ((tickCounter % SCAN_ENQ_INTERVAL) === 1) {
            enqueueNearbySections()
        }
        processScanSlice()

        var dirty = false
        var keys  = Array.from(trackedBlocks.keys())
        for (var i = 0; i < keys.length; i++) {
            try {
                var rec  = trackedBlocks.get(keys[i])
                if (rec == null) continue
                var bMap = bindingsByBlockId.get(rec.blockId)
                if (bMap == null || bMap.size === 0) continue

                var lv = resolveLevel(rec.dim, null)
                if (lv == null || !isChunkLoaded(lv, rec.x, rec.z)) continue
                var curBlock = null
                try { curBlock = lv.getBlock(rec.x, rec.y, rec.z) } catch (eGet) { logCatch('tick:getBlock', eGet) }
                if (extractBlockId(curBlock) !== rec.blockId) {
                    dispatchRemovedToSubscribers(rec, 'block_changed', null, null)
                    trackedBlocks.delete(keys[i])
                    dirty = true
                    continue
                }

                bMap.forEach(function (binding, subId) {
                    var sub = subscribers.get(subId)
                    if (sub == null || sub.onTick == null) return
                    if (sub.maintainInterval > 1 && (tickCounter % sub.maintainInterval) !== sub.maintainOffset) return
                    try {
                        sub.onTick(ensureSubscriberView(rec, sub), binding, tickCounter, lv, curBlock)
                    } catch (eSubTick) {
                        logCatch(sub.id + ':onTick', eSubTick)
                    }
                })
            } catch (eItem) {
                logCatch('tickItem', eItem)
            }
        }
        if (dirty) saveTrackedBlocks()
    }

    function createTracker(cfg) {
        var subId = String((cfg && cfg.name) || ('sub_' + subscribers.size))
        // 注意：若传入已存在的同名订阅者 ID，会先销毁旧订阅及其独占的追踪记录，确保同一名称仅保留单一活跃订阅者
        if (subscribers.has(subId)) {
            subscribers.get(subId).destroy()
        }

        var sub = {
            id:                   subId,
            maintainInterval:     (cfg && cfg.maintainInterval > 0) ? Math.floor(cfg.maintainInterval) : 1,
            maintainOffset:       (cfg && cfg.maintainOffset >= 0) ? Math.floor(cfg.maintainOffset) : 0,
            makeRecordExtra:      (cfg && typeof cfg.makeRecordExtra === 'function') ? cfg.makeRecordExtra : null,
            onFound:              (cfg && typeof cfg.onFound === 'function') ? cfg.onFound : null,
            onTick:               (cfg && typeof cfg.onTick === 'function') ? cfg.onTick : null,
            onRemoved:            (cfg && typeof cfg.onRemoved === 'function') ? cfg.onRemoved : null,
            onBrokenUnregistered: (cfg && typeof cfg.onBrokenUnregistered === 'function') ? cfg.onBrokenUnregistered : null,
            destroyed:            false
        }

        function unbindBlockForSub(blockId, extraArg) {
            if (!blockId) return 0
            var idStr = String(blockId).trim()
            var bMap  = bindingsByBlockId.get(idStr)
            if (bMap == null || !bMap.has(subId)) return 0

            var removed = 0
            var keys    = Array.from(trackedBlocks.keys())
            for (var i = 0; i < keys.length; i++) {
                var rec = trackedBlocks.get(keys[i])
                if (rec != null && rec.blockId === idStr) {
                    dispatchRemovedToSubscribers(rec, 'unbind', extraArg, subId)
                    if (rec.extras != null) delete rec.extras[subId]
                    if (bMap.size <= 1) {
                        trackedBlocks.delete(keys[i])
                    }
                    removed++
                }
            }
            bMap.delete(subId)
            if (bMap.size === 0) bindingsByBlockId.delete(idStr)
            saveTrackedBlocks()
            return removed
        }

        function destroy() {
            if (sub.destroyed) return
            sub.destroyed = true
            var boundIds  = []
            bindingsByBlockId.forEach(function (bMap, bid) {
                if (bMap.has(subId)) boundIds.push(bid)
            })
            for (var i = 0; i < boundIds.length; i++) {
                unbindBlockForSub(boundIds[i], null)
            }
            subscribers.delete(subId)
        }

        sub.destroy = destroy
        subscribers.set(subId, sub)

        return {
            name: subId,
            bind: function (blockId, meta) {
                if (sub.destroyed || !blockId || meta == null) return false
                var idStr = String(blockId).trim()
                var bMap  = bindingsByBlockId.get(idStr)
                if (bMap == null) {
                    bMap = new Map()
                    bindingsByBlockId.set(idStr, bMap)
                }
                bMap.set(subId, meta)
                scannedSections.clear()
                return true
            },
            unbind: unbindBlockForSub,
            scanNow: function () {
                if (sub.destroyed) return 0
                scannedSections.clear()
                enqueueNearbySections()
                return scanQueue.length
            },
            hasBinding: function (blockId) {
                var bMap = bindingsByBlockId.get(String(blockId || '').trim())
                return Boolean(bMap != null && bMap.has(subId))
            },
            getBinding: function (blockId) {
                var bMap = bindingsByBlockId.get(String(blockId || '').trim())
                return bMap != null ? bMap.get(subId) : undefined
            },
            getBindingCount: function () {
                var cnt = 0
                bindingsByBlockId.forEach(function (bMap) {
                    if (bMap.has(subId)) cnt++
                })
                return cnt
            },
            getTrackedRecords: function (blockIdOpt) {
                var out = []
                var filterBid = blockIdOpt != null ? String(blockIdOpt).trim() : null
                trackedBlocks.forEach(function (rec) {
                    if (rec == null) return
                    if (filterBid != null && rec.blockId !== filterBid) return
                    var bMap = bindingsByBlockId.get(rec.blockId)
                    if (bMap != null && bMap.has(subId)) out.push(rec)
                })
                return out
            },
            destroy: destroy
        }
    }

    BlockEvents.placed(function (event) {
        try {
            if (event.block == null) return
            var bid  = extractBlockId(event.block)
            var bMap = bid != null ? bindingsByBlockId.get(bid) : null
            if (bMap == null || bMap.size === 0) return
            var dim  = dimOfLevel(event.level) || 'minecraft:overworld'
            registerTrackedBlock(bid, dim, event.block.x, event.block.y, event.block.z, true, true, 'placed')
        } catch (ePlaced) {
            logCatch('BlockEvents.placed', ePlaced)
        }
    })

    BlockEvents.broken(function (event) {
        try {
            if (event.block == null) return
            var dim  = dimOfLevel(event.level) || 'minecraft:overworld'
            var key  = makePosKey(dim, event.block.x, event.block.y, event.block.z)
            var rec  = trackedBlocks.get(key)
            if (rec != null) {
                dispatchRemovedToSubscribers(rec, 'broken', null, null)
                trackedBlocks.delete(key)
                saveTrackedBlocks()
            } else {
                var bid  = extractBlockId(event.block)
                var bMap = bid != null ? bindingsByBlockId.get(bid) : null
                if (bMap != null) {
                    bMap.forEach(function (binding, subId) {
                        var sub = subscribers.get(subId)
                        if (sub != null && sub.onBrokenUnregistered != null) {
                            try {
                                sub.onBrokenUnregistered(dim, event.block.x, event.block.y, event.block.z, bid, binding)
                            } catch (eUnreg) {
                                logCatch(sub.id + ':brokenUnregistered', eUnreg)
                            }
                        }
                    })
                }
            }
        } catch (eBroken) {
            logCatch('BlockEvents.broken', eBroken)
        }
    })

    ServerEvents.tick(function (event) {
        try {
            if (event != null && event.server != null) SERVER_REF = event.server
            tickCounter++
            if (SERVER_REF == null) return
            tickAllTrackedBlocks()
        } catch (eTick) {
            logCatch('ServerEvents.tick', eTick)
        }
    })

    function configure(patch) {
        if (patch == null || typeof patch !== 'object') return { scanEnqInterval: SCAN_ENQ_INTERVAL, scanSectionsPerTick: SCAN_SECTIONS_PER_TICK }
        if (patch.scanEnqInterval != null && isFinite(Number(patch.scanEnqInterval))) {
            SCAN_ENQ_INTERVAL = Math.max(1, Math.floor(Number(patch.scanEnqInterval)))
        }
        if (patch.scanSectionsPerTick != null && isFinite(Number(patch.scanSectionsPerTick))) {
            SCAN_SECTIONS_PER_TICK = Math.max(1, Math.floor(Number(patch.scanSectionsPerTick)))
        }
        return { scanEnqInterval: SCAN_ENQ_INTERVAL, scanSectionsPerTick: SCAN_SECTIONS_PER_TICK }
    }

    global.EpiphyBlockTracker = {
        configure:         configure,
        createTracker:     createTracker,
        migrateLegacyOnce: migrateLegacyOnce,
        extractBlockId:    extractBlockId,
        isChunkLoaded:     isChunkLoaded,
        makePosKey:        makePosKey,
        normalizeDim:      normalizeDim,
        dimOfLevel:        dimOfLevel,
        resolveLevel:      resolveLevel
    }
})()
