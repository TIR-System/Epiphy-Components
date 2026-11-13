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
//    2. 统一持久化至按存档隔离的 JsonIO 文件（kubejs_epiphy_tracked_blocks.json + 防抖落盘），仅首次加载时从旧版 persistentData 迁移；
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
    var PERSIST_KEY            = 'epiphy_tracked_blocks_v2'
    var WORLD_FILE_NAME        = 'kubejs_epiphy_tracked_blocks.json'
    var FALLBACK_DIR           = 'kubejs/config/epiphy_tracked_blocks'
    var SAVE_DEBOUNCE_TICKS    = 40
    var VERIFY_WINDOW_TICKS    = 20
    var SCAN_ENQ_INTERVAL      = 20
    var SCAN_SECTIONS_PER_TICK = 1

    var SERVER_REF         = null
    var loadedPersistSrv   = null
    var loadedStoragePath  = null
    var tickCounter        = 0
    var persistDirty       = false
    var lastFlushTick      = -9999
    var migratedLegacyFlag = false
    var nextVerifySlot     = 0

    // 共享物理方块池与扫描状态（全局唯一份）
    // bindingsByBlockId: Map<blockId, Map<subId, bindingMeta>>
    // subscribers:       Map<subId, subscriberObj>
    // trackedBlocks:     Map<posKey, { key, blockId, dim, x, y, z, vSlot, extras: { [subId]: obj } }>
    var bindingsByBlockId = new Map()
    var subscribers       = new Map()
    var trackedBlocks     = new Map()
    var scannedSections   = new Set()
    var scanQueue         = []
    var migratedKeys      = new Set()
    var pendingMigrations = []

    // 【catch 约定】日志设施自身的兜底：console 不可用时已无更低层可退，留空。
    function logCatch(tag, err) {
        if (typeof global !== 'undefined' && global.EpiphyLog != null) {
            global.EpiphyLog.catchWarn('EpiphyBlockTracker', tag, err)
        } else {
            try { console.warn('[EpiphyBlockTracker 异常:' + tag + '] ' + String(err)) } catch (e) { }
        }
    }

    // 【catch 约定】Java 运行时类存在性探测：类未加载或非 Rhino 环境时返回 null 并走降级路径。
    function loadJavaClass(className) {
        try {
            return Java.loadClass(className)
        } catch (e) {
            return null
        }
    }

    var LevelResourceClass = loadJavaClass('net.minecraft.world.level.storage.LevelResource')
    var FilesClass         = loadJavaClass('java.nio.file.Files')
    var PathsClass         = loadJavaClass('java.nio.file.Paths')

    // 【catch 约定】以下 try/catch 均为 Java API 能力探测（normalizeDim/dimOfLevel/resolveLevel）：
    // 先检查方法或属性类型再调用，失败表示该 API 在当前 MC/Rhino 映射中不存在，属于预期分支，故留空。
    // 这些路径在事件与 tick 中频繁调用，写日志会污染限频桶并拖慢热路径。
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

    // 【catch 约定】以下 try/catch 均为 Java API 能力探测（extractBlockId/isChunkLoaded/readPlayerPos）：
    // 不同 MC/Rhino 映射下的方块对象、区块加载查询与玩家坐标访问接口存在差异，失败属预期分支，留空避免热路径污染。
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

    // 为订阅者按需生成该方块的私有扩展字段并缓存视图到 rec.views[subId]，消除每 tick 重复分配对象与 for-in 拷贝
    function ensureSubscriberView(rec, sub) {
        if (rec.views == null) rec.views = {}
        var cachedView = rec.views[sub.id]
        if (cachedView != null) return cachedView

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
        rec.views[sub.id] = view
        return view
    }

    function formatTimestampNow() {
        try {
            return new Date().toISOString()
        } catch (e) {
            return String(Date.now())
        }
    }

    // 【catch 约定】以下 try/catch 均为 GSON Map/List 与 WorldData API 能力探测：
    // 失败表示对象不属于对应容器类型或无该方法，走默认值回退属预期分支，故留空。
    function readJsonField(obj, key) {
        if (obj == null) return null
        try {
            if (obj[key] !== undefined) return obj[key]
            if (typeof obj.get === 'function') return obj.get(key)
        } catch (e) { }
        return null
    }

    function toSeqArray(val) {
        if (val == null) return null
        if (Array.isArray(val)) return val
        try {
            if (typeof val.size === 'function' && typeof val.get === 'function') {
                var len = Number(val.size())
                var out = []
                for (var i = 0; i < len; i++) out.push(val.get(i))
                return out
            }
        } catch (e) { }
        return null
    }

    function resolveWorldStorageInfo(server) {
        var srv = server || SERVER_REF
        if (srv != null && LevelResourceClass != null) {
            try {
                var rootRes = LevelResourceClass.ROOT
                if (rootRes != null && typeof srv.getWorldPath === 'function') {
                    var worldPath = srv.getWorldPath(rootRes)
                    if (worldPath != null) {
                        var normRoot = (typeof worldPath.normalize === 'function') ? worldPath.normalize() : worldPath
                        var jsonPath = String(normRoot).replace(/[\\/]+$/, '') + '/' + WORLD_FILE_NAME
                        return {
                            worldKey: 'path:' + jsonPath.toLowerCase(),
                            filePath: jsonPath
                        }
                    }
                }
            } catch (ePath) {
                logCatch('resolveWorldPath', ePath)
            }
        }

        var levelName = 'default_world'
        if (srv != null) {
            try {
                var wData = (typeof srv.getWorldData === 'function') ? srv.getWorldData() : srv.worldData
                if (wData != null) {
                    var rawName = (typeof wData.getLevelName === 'function') ? wData.getLevelName() : wData.levelName
                    if (rawName != null && String(rawName).trim().length > 0) {
                        levelName = String(rawName).trim()
                    }
                }
            } catch (eName) { }
        }
        var safeFileSlug = levelName.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim() || 'default_world'
        var fallbackPath = FALLBACK_DIR + '/' + safeFileSlug + '.json'
        return {
            worldKey: 'name:' + safeFileSlug.toLowerCase(),
            filePath: fallbackPath
        }
    }

    function ensureParentDir(filePathStr) {
        if (FilesClass == null || PathsClass == null) return
        try {
            var p = PathsClass.get(String(filePathStr))
            var parent = p != null ? p.getParent() : null
            if (parent != null && !FilesClass.exists(parent)) {
                FilesClass.createDirectories(parent)
            }
        } catch (e) {
            logCatch('ensureParentDir', e)
        }
    }

    function flushTrackedBlocks() {
        if (SERVER_REF == null || !persistDirty) return false
        try {
            var arr = []
            trackedBlocks.forEach(function (item) {
                arr.push([item.blockId, item.dim, item.x, item.y, item.z])
            })
            if (typeof JsonIO !== 'undefined' && JsonIO != null) {
                var targetPath = loadedStoragePath || resolveWorldStorageInfo(SERVER_REF).filePath
                loadedStoragePath = targetPath
                ensureParentDir(targetPath)
                JsonIO.write(targetPath, {
                    version:        2,
                    updatedAt:      formatTimestampNow(),
                    migratedLegacy: migratedLegacyFlag,
                    blocks:         arr
                })
                persistDirty  = false
                lastFlushTick = tickCounter
                return true
            }
        } catch (eSave) {
            logCatch('flushTrackedBlocks', eSave)
        }
        return false
    }

    function saveTrackedBlocks(immediate) {
        if (SERVER_REF == null) return
        persistDirty = true
        if (immediate === true || (tickCounter - lastFlushTick) >= SAVE_DEBOUNCE_TICKS) {
            flushTrackedBlocks()
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

    function allocVerifySlot() {
        var s = nextVerifySlot
        nextVerifySlot = (nextVerifySlot + 1) % VERIFY_WINDOW_TICKS
        return s
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
            rec = { key: key, blockId: blockId, dim: dim, x: ix, y: iy, z: iz, vSlot: allocVerifySlot(), chunkLoaded: true, extras: {} }
            trackedBlocks.set(key, rec)
            if (saveNow !== false) saveTrackedBlocks(false)
        }
        if (triggerFound) {
            dispatchFoundToSubscribers(rec, null, source)
        }
        return rec
    }

    function importSerializedBlockArray(rawOrArr, fallbackBlockId, sourceKey) {
        var imported = 0
        var skipped  = 0
        if (rawOrArr == null) return 0
        var parsed = rawOrArr
        if (typeof rawOrArr === 'string') {
            if (rawOrArr.length === 0) return 0
            try {
                parsed = JSON.parse(rawOrArr)
            } catch (eParse) {
                logCatch('importSerializedBlockArray:parse(' + String(sourceKey || 'unknown') + ')', eParse)
                return 0
            }
        }
        var arr = toSeqArray(parsed)
        if (arr == null) return 0
        for (var i = 0; i < arr.length; i++) {
            var it = toSeqArray(arr[i])
            if (it == null) {
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
                trackedBlocks.set(key, { key: key, blockId: bid, dim: dim, x: bx, y: by, z: bz, vSlot: allocVerifySlot(), chunkLoaded: true, extras: {} })
                imported++
            }
        }
        if (skipped > 0) {
            var warnMsg = '[EpiphyBlockTracker] 导入 ' + String(sourceKey || '持久化数据') + ' 时跳过 ' + skipped + ' 条格式不兼容的记录（缺少 blockId 或坐标非法）。'
            if (typeof global !== 'undefined' && global.EpiphyLog != null) {
                global.EpiphyLog.warn('EpiphyBlockTracker', 'importSkipped', warnMsg)
            } else {
                // 【catch 约定】日志设施自身的兜底：console 不可用时已无更低层可退，留空。
                try { console.warn(warnMsg) } catch (e) { }
            }
        }
        return imported
    }

    function ensureLoaded() {
        if (SERVER_REF == null || loadedPersistSrv === SERVER_REF) return
        loadedPersistSrv   = SERVER_REF
        trackedBlocks.clear()
        scannedSections.clear()
        scanQueue.length   = 0
        migratedKeys.clear()
        persistDirty       = false
        lastFlushTick      = -9999
        migratedLegacyFlag = false
        nextVerifySlot     = 0

        var storageInfo    = resolveWorldStorageInfo(SERVER_REF)
        loadedStoragePath  = storageInfo.filePath

        if (typeof JsonIO !== 'undefined' && JsonIO != null) {
            try {
                var rawObj = JsonIO.read(loadedStoragePath)
                if (rawObj != null) {
                    var directSeq = toSeqArray(rawObj)
                    if (directSeq != null) {
                        importSerializedBlockArray(directSeq, null, loadedStoragePath)
                    } else {
                        var blocksField = readJsonField(rawObj, 'blocks')
                        if (blocksField != null) {
                            importSerializedBlockArray(blocksField, null, loadedStoragePath)
                        }
                        if (readJsonField(rawObj, 'migratedLegacy') === true) {
                            migratedLegacyFlag = true
                        }
                    }
                }
            } catch (eJsonLoad) {
                logCatch('ensureLoaded:JsonIO', eJsonLoad)
            }
        }

        if (!migratedLegacyFlag) {
            var loadKeys = [PERSIST_KEY, 'epiphy_danmaku_bound_blocks_v1', 'epiphy_audio_bound_blocks_v1']
            var importedLegacy = 0
            for (var kIdx = 0; kIdx < loadKeys.length; kIdx++) {
                try {
                    var raw = SERVER_REF.persistentData.getString(loadKeys[kIdx])
                    if (raw && String(raw).length > 0) {
                        importedLegacy += importSerializedBlockArray(raw, null, loadKeys[kIdx])
                    }
                } catch (eLoad) {
                    logCatch('ensureLoaded:' + loadKeys[kIdx], eLoad)
                }
            }
            migratedLegacyFlag = true
            if (importedLegacy > 0) {
                saveTrackedBlocks(true)
            }
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
                                        trackedBlocks.set(dkey, { key: dkey, blockId: bid, dim: ddim, x: dbx, y: dby, z: dbz, vSlot: allocVerifySlot(), chunkLoaded: true, extras: {} })
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
            saveTrackedBlocks(true)
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

    var stateIdCache       = new Map()

    function extractStateIdCached(st) {
        if (st == null) return null
        if (typeof st.isAir === 'function' && st.isAir()) return null
        var cached = stateIdCache.get(st)
        if (cached !== undefined) return cached
        if (stateIdCache.size >= 4096) stateIdCache.clear()
        var bid = extractBlockId(st)
        stateIdCache.set(st, bid)
        return bid
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

                // 先探测区块段调色板 (O(palette))：若整段完全不包含任何已绑定方块，直接跳过 4096 格遍历
                var shouldScanSection = true
                if (typeof section.maybeHas === 'function') {
                    // 【catch 约定】Java Palette.maybeHas 能力探测：若当前 MC/Rhino 映射不支持 SAM 转换或抛错则降级全扫，留空避免刷屏。
                    try {
                        shouldScanSection = Boolean(section.maybeHas(function (pState) {
                            var pBid = extractStateIdCached(pState)
                            if (pBid == null) return false
                            var pMap = bindingsByBlockId.get(pBid)
                            return pMap != null && pMap.size > 0
                        }))
                    } catch (ePal) {
                        shouldScanSection = true
                    }
                }
                if (!shouldScanSection) continue

                var baseX = task.sx << 4, baseY = task.sy << 4, baseZ = task.sz << 4
                for (var ly = 0; ly < 16; ly++) {
                    var wy = baseY + ly
                    for (var lx = 0; lx < 16; lx++) {
                        var wx = baseX + lx
                        for (var lz = 0; lz < 16; lz++) {
                            var st = section.getBlockState(lx, ly, lz)
                            if (st == null || (typeof st.isAir === 'function' && st.isAir())) continue
                            var bid  = extractStateIdCached(st)
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
        if (dirty) saveTrackedBlocks(false)
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

        var dirty       = false
        var verifyPhase = tickCounter % VERIFY_WINDOW_TICKS
        trackedBlocks.forEach(function (rec, posKey) {
            try {
                if (rec == null) return
                var bMap = bindingsByBlockId.get(rec.blockId)
                if (bMap == null || bMap.size === 0) return

                // 将 block_changed 实体复核按 VERIFY_WINDOW_TICKS (1/20) 分摊到各 tick，并配合缓存视图消除每 tick 数组与对象分配
                var vSlot      = (rec.vSlot != null) ? (rec.vSlot % VERIFY_WINDOW_TICKS) : 0
                var needVerify = (vSlot === verifyPhase)
                var lv         = null
                var curBlock   = null

                if (needVerify) {
                    lv = resolveLevel(rec.dim, null)
                    if (lv == null || !isChunkLoaded(lv, rec.x, rec.z)) {
                        rec.chunkLoaded = false
                        return
                    }
                    rec.chunkLoaded = true
                    try { curBlock = lv.getBlock(rec.x, rec.y, rec.z) } catch (eGet) { logCatch('tick:getBlock', eGet) }
                    if (extractBlockId(curBlock) !== rec.blockId) {
                        dispatchRemovedToSubscribers(rec, 'block_changed', null, null)
                        trackedBlocks.delete(posKey)
                        dirty = true
                        return
                    }
                } else if (rec.chunkLoaded === false) {
                    return
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
        })
        if (dirty) saveTrackedBlocks(false)
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
                    if (rec.views != null) delete rec.views[subId]
                    if (bMap.size <= 1) {
                        trackedBlocks.delete(keys[i])
                    }
                    removed++
                }
            }
            bMap.delete(subId)
            if (bMap.size === 0) bindingsByBlockId.delete(idStr)
            saveTrackedBlocks(true)
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
            if (persistDirty && (tickCounter - lastFlushTick) >= SAVE_DEBOUNCE_TICKS) {
                flushTrackedBlocks()
            }
        } catch (eTick) {
            logCatch('ServerEvents.tick', eTick)
        }
    })

    try {
        ServerEvents.unloaded(function () {
            try {
                flushTrackedBlocks()
            } catch (eUnl) {
                logCatch('ServerEvents.unloaded', eUnl)
            }
        })
    } catch (eRegUnl) {
        logCatch('registerServerUnloaded', eRegUnl)
    }

    function configure(patch) {
        if (patch != null && typeof patch === 'object') {
            if (patch.scanEnqInterval != null && isFinite(Number(patch.scanEnqInterval))) {
                SCAN_ENQ_INTERVAL = Math.max(1, Math.floor(Number(patch.scanEnqInterval)))
            }
            if (patch.scanSectionsPerTick != null && isFinite(Number(patch.scanSectionsPerTick))) {
                SCAN_SECTIONS_PER_TICK = Math.max(1, Math.floor(Number(patch.scanSectionsPerTick)))
            }
            if (patch.verifyWindowTicks != null && isFinite(Number(patch.verifyWindowTicks))) {
                VERIFY_WINDOW_TICKS = Math.max(1, Math.floor(Number(patch.verifyWindowTicks)))
            }
            if (patch.saveDebounceTicks != null && isFinite(Number(patch.saveDebounceTicks))) {
                SAVE_DEBOUNCE_TICKS = Math.max(1, Math.floor(Number(patch.saveDebounceTicks)))
            }
        }
        return {
            scanEnqInterval:     SCAN_ENQ_INTERVAL,
            scanSectionsPerTick: SCAN_SECTIONS_PER_TICK,
            verifyWindowTicks:   VERIFY_WINDOW_TICKS,
            saveDebounceTicks:   SAVE_DEBOUNCE_TICKS
        }
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
