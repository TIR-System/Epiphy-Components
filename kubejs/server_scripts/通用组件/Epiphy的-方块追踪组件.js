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
//
//  [Rhino 语法兼容性约定] KubeJS 2001.6.x 内置 Rhino 对 ES6 支持不完整且存在语义偏差（如 `let`/`const`
//    块级作用域语义不完备及 Java 回调互操作限制）。本系列统一禁用 `let`/`const` 而使用 `var`，本模块坚持
//    ES5 语法搭配稳定 `Map`/`Set`；同系列音频模块使用经实测稳定的 ES6 子集（`=>` / 模板字符串 / `for..of`）。
// ============================================================================

;(function () {
    var PERSIST_KEY     = 'epiphy_tracked_blocks_v2'
    var WORLD_FILE_NAME = 'kubejs_epiphy_tracked_blocks.json'
    var FALLBACK_DIR    = 'kubejs/config/epiphy_tracked_blocks'

    var CONFIG = {
        saveDebounceTicks:   40,
        verifyWindowTicks:   20,
        scanEnqInterval:     20,
        scanSectionsPerTick: 1,
        maxScannedSections:  8192,
        maxScanQueue:        512
    }

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
    var bindingsByBlockId        = new Map()
    var subscribers              = new Map()
    var trackedBlocks            = new Map()
    var AIR_SECTION_VER          = -1
    var bindingsVersion          = 1
    var scannedSections          = new Map() // skey -> bindingsVersion | AIR_SECTION_VER(-1)
    var scanQueue                = []
    var scanQueueHead            = 0
    var pendingScanKeys          = new Set() // 与 scanQueue 未消费条目同步，防止重复入队
    var migratedKeys             = new Set()
    var pendingMigrations        = []
    var trackedRecordsTotalCalls = 0
    var lastEnqueueStatus        = {
        enqueued:         0,
        blockedByQueue:   false,
        truncatedByQueue: false,
        pending:          0,
        cap:              CONFIG.maxScanQueue,
        forceNearby:      false
    }

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
        if (immediate === true || (tickCounter - lastFlushTick) >= CONFIG.saveDebounceTicks) {
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
        nextVerifySlot = (nextVerifySlot + 1) % CONFIG.verifyWindowTicks
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
        resetScanQueue()
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

    // 【重新发现机制边界约定】本组件区分三种触发重扫的语义路径，后续扩展请严格按场景选用：
    //   1) bindingsVersion++（全图增量失效，保留 AIR_SECTION_VER）：
    //      用于新增未知 blockId 或既有绑定扩大 scanRadius 时；仅令已缓存的非空气区段在下一次玩家靠近时重检，
    //      刻意保留纯空气区段 (AIR_SECTION_VER = -1) 缓存，避免重扫大量纯空气（新放置方块由 BlockEvents.placed 捕获）。
    //   2) enqueueNearbySections({ forceNearby: true })（即 sub.scanNow() 局部强制入队）：
    //      用于单模块/单区域按需立即补扫玩家周边（绕过 cachedVer === bindingsVersion 判断），不递增全局版本号也不清纯空气。
    //   3) rescanAll()（全量重置，含纯空气与队列）：
    //      仅用于管理员 /epiphy debug 显式重扫或兜底恢复；会清空 scannedSections 与 scanQueue 后以 forceNearby 重新入队。
    // 真 LRU 缓存维护：命中时 delete + set 迁至 Map 尾部，保留 bindingsVersion / AIR_SECTION_VER(-1) 状态，防止重扫正反馈
    function touchScannedSection(skey, ver) {
        if (scannedSections.has(skey)) {
            scannedSections.delete(skey)
        } else if (scannedSections.size >= CONFIG.maxScannedSections) {
            var oldestSkey = scannedSections.keys().next().value
            if (oldestSkey !== undefined) scannedSections.delete(oldestSkey)
        }
        scannedSections.set(skey, ver)
    }

    function resetScanQueue() {
        scanQueue.length = 0
        scanQueueHead    = 0
        pendingScanKeys.clear()
    }

    function getPendingScanCount() {
        return scanQueue.length - scanQueueHead
    }

    function getLoadedChunkSections(lv, chunkX, chunkZ) {
        if (lv == null) return { loaded: false, sections: null, minBuildY: -64 }
        var cs    = lv.getChunkSource()
        var chunk = cs != null ? cs.getChunkNow(chunkX, chunkZ) : (lv.hasChunk(chunkX, chunkZ) ? lv.getChunk(chunkX, chunkZ) : null)
        if (chunk == null) return { loaded: false, sections: null, minBuildY: -64 }
        var sections  = chunk.getSections()
        var minBuildY = typeof chunk.getMinBuildHeight === 'function' ? Number(chunk.getMinBuildHeight()) : -64
        return { loaded: true, sections: sections, minBuildY: minBuildY }
    }

    function recordEnqueueStatus(enqueued, blocked, truncated, forceNearby) {
        lastEnqueueStatus = {
            enqueued:         enqueued,
            blockedByQueue:   Boolean(blocked),
            truncatedByQueue: Boolean(truncated),
            pending:          getPendingScanCount(),
            cap:              CONFIG.maxScanQueue,
            forceNearby:      Boolean(forceNearby)
        }
    }

    function enqueueNearbySections(opts) {
        var forceNearby = Boolean(opts != null && opts.forceNearby)
        if (bindingsByBlockId.size === 0 || SERVER_REF == null) {
            recordEnqueueStatus(0, false, false, forceNearby)
            return 0
        }
        if (getPendingScanCount() >= CONFIG.maxScanQueue) {
            recordEnqueueStatus(0, true, false, forceNearby)
            return 0
        }
        var maxRadius   = (opts != null && opts.maxRadius != null && isFinite(Number(opts.maxRadius)))
            ? Number(opts.maxRadius)
            : 0
        if (maxRadius <= 0) {
            maxRadius = 32
            bindingsByBlockId.forEach(function (bMap) {
                bMap.forEach(function (b) {
                    if (b != null && b.scanRadius > maxRadius) maxRadius = b.scanRadius
                })
            })
        }
        var pList = null
        try { pList = SERVER_REF.getPlayerList().getPlayers() } catch (e0) {
            recordEnqueueStatus(0, false, false, forceNearby)
            return 0
        }
        if (pList == null) {
            recordEnqueueStatus(0, false, false, forceNearby)
            return 0
        }
        var enqueued = 0
        var n = (typeof pList.size === 'function') ? Number(pList.size()) : (pList.length || 0)
        for (var i = 0; i < n; i++) {
            var p   = typeof pList.get === 'function' ? pList.get(i) : pList[i]
            var pos = readPlayerPos(p)
            if (pos == null) continue
            var lv  = resolveLevel(p.level, null)
            var dim = dimOfLevel(lv || p.level) || 'minecraft:overworld'
            if (lv == null) lv = resolveLevel(dim, null)
            var minSX = Math.floor((pos.x - maxRadius) / 16)
            var maxSX = Math.floor((pos.x + maxRadius) / 16)
            var minSY = Math.floor((pos.y - maxRadius) / 16)
            var maxSY = Math.floor((pos.y + maxRadius) / 16)
            var minSZ = Math.floor((pos.z - maxRadius) / 16)
            var maxSZ = Math.floor((pos.z + maxRadius) / 16)
            if (lv != null && typeof lv.getMinBuildHeight === 'function') {
                var worldMinSY = Math.floor(Number(lv.getMinBuildHeight()) / 16)
                if (minSY < worldMinSY) minSY = worldMinSY
            }
            if (lv != null && typeof lv.getMaxBuildHeight === 'function') {
                var worldMaxSY = Math.floor((Number(lv.getMaxBuildHeight()) - 1) / 16)
                if (maxSY > worldMaxSY) maxSY = worldMaxSY
            }
            for (var sx = minSX; sx <= maxSX; sx++) {
                for (var sz = minSZ; sz <= maxSZ; sz++) {
                    var col = null
                    // 【catch 约定】Java 区块段能力探测：部分非标准 Level 若无 getChunkSource/getSections 则回退仅入队。
                    try {
                        col = getLoadedChunkSections(lv, sx, sz)
                    } catch (eCol) {
                        col = { loaded: true, sections: null, minBuildY: -64 }
                    }
                    if (!col.loaded) continue
                    for (var sy = minSY; sy <= maxSY; sy++) {
                        var skey = dim + '|' + sx + ',' + sy + ',' + sz
                        if (pendingScanKeys.has(skey)) continue
                        var cachedVer = scannedSections.get(skey)
                        if (cachedVer === AIR_SECTION_VER) {
                            touchScannedSection(skey, AIR_SECTION_VER)
                            continue
                        }
                        if (!forceNearby && cachedVer === bindingsVersion) {
                            touchScannedSection(skey, bindingsVersion)
                            continue
                        }
                        if (col.sections != null) {
                            var secIdx = (sy * 16 - col.minBuildY) >> 4
                            if (secIdx < 0 || secIdx >= col.sections.length) continue
                            var sec = col.sections[secIdx]
                            if (sec == null || sec.hasOnlyAir()) {
                                // 纯空气段记为 AIR_SECTION_VER(-1) 直接入 LRU，不占用扫描队列预算且不随 bindingsVersion 失效（新放置方块由 BlockEvents.placed 捕获）
                                touchScannedSection(skey, AIR_SECTION_VER)
                                continue
                            }
                        }
                        if (getPendingScanCount() >= CONFIG.maxScanQueue) {
                            recordEnqueueStatus(enqueued, false, true, forceNearby)
                            return enqueued
                        }
                        // 先记入版本号；若消费阶段因维度卸载/未加载/越界/异常中止，必须 delete 回滚以防“假已扫”永久跳过
                        touchScannedSection(skey, bindingsVersion)
                        pendingScanKeys.add(skey)
                        scanQueue.push({ dim: dim, sx: sx, sy: sy, sz: sz, skey: skey })
                        enqueued++
                    }
                }
            }
        }
        recordEnqueueStatus(enqueued, false, false, forceNearby)
        return enqueued
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
        if (scanQueueHead >= scanQueue.length || bindingsByBlockId.size === 0) return
        var processed = 0
        var dirty     = false
        while (scanQueueHead < scanQueue.length && processed < CONFIG.scanSectionsPerTick) {
            var task = scanQueue[scanQueueHead]
            scanQueue[scanQueueHead] = null
            scanQueueHead++
            if (task != null) pendingScanKeys.delete(task.skey)
            if (scanQueueHead >= scanQueue.length) {
                scanQueue.length = 0
                scanQueueHead    = 0
            } else if (scanQueueHead >= 256 && scanQueueHead * 2 >= scanQueue.length) {
                scanQueue = scanQueue.slice(scanQueueHead)
                scanQueueHead = 0
            }
            if (task == null) continue
            processed++
            var lv = resolveLevel(task.dim, null)
            if (lv == null) {
                scannedSections.delete(task.skey)
                continue
            }
            try {
                var col = getLoadedChunkSections(lv, task.sx, task.sz)
                if (!col.loaded) {
                    scannedSections.delete(task.skey)
                    continue
                }
                var sections = col.sections
                var secIdx   = (task.sy * 16 - col.minBuildY) >> 4
                if (sections == null || secIdx < 0 || secIdx >= sections.length) {
                    scannedSections.delete(task.skey)
                    continue
                }
                var section = sections[secIdx]
                if (section == null || section.hasOnlyAir()) {
                    touchScannedSection(task.skey, AIR_SECTION_VER)
                    continue
                }

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
                if (!shouldScanSection) {
                    touchScannedSection(task.skey, bindingsVersion)
                    continue
                }

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
                touchScannedSection(task.skey, bindingsVersion)
            } catch (eScan) {
                scannedSections.delete(task.skey)
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

        if ((tickCounter % CONFIG.scanEnqInterval) === 1) {
            enqueueNearbySections()
        }
        processScanSlice()

        var dirty       = false
        var verifyPhase = tickCounter % CONFIG.verifyWindowTicks
        trackedBlocks.forEach(function (rec, posKey) {
            try {
                if (rec == null) return
                var bMap = bindingsByBlockId.get(rec.blockId)
                if (bMap == null || bMap.size === 0) return

                // 将 block_changed 实体复核按 CONFIG.verifyWindowTicks (1/20) 分摊到各 tick，并配合缓存视图消除每 tick 数组与对象分配
                var vSlot      = (rec.vSlot != null) ? (rec.vSlot % CONFIG.verifyWindowTicks) : 0
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
            onBindingChanged:     (cfg && typeof cfg.onBindingChanged === 'function') ? cfg.onBindingChanged : null,
            getTrackedRecordsCalls: 0,
            destroyed:            false
        }

        function unbindBlockForSub(blockId, extraArg) {
            if (!blockId) return 0
            var idStr = String(blockId).trim()
            var bMap  = bindingsByBlockId.get(idStr)
            if (bMap == null || !bMap.has(subId)) return 0

            var prevMeta = bMap.get(subId)
            var removed  = 0
            var keys     = Array.from(trackedBlocks.keys())
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
            if (sub.onBindingChanged != null) {
                try { sub.onBindingChanged(idStr, null, prevMeta) } catch (eChg) { logCatch(sub.id + ':onBindingChanged', eChg) }
            }
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
                var idStr        = String(blockId).trim()
                var bMap         = bindingsByBlockId.get(idStr)
                var isNewBlockId = (bMap == null || bMap.size === 0)
                var prevMeta     = bMap != null ? bMap.get(subId) : null
                if (bMap == null) {
                    bMap = new Map()
                    bindingsByBlockId.set(idStr, bMap)
                }
                bMap.set(subId, meta)
                // 仅当新增未知方块类型且已有扫描状态时推进版本号，使已缓存非空气段按需重检，
                // 而不清空全局 LRU / 待扫队列；同 blockId 扩大 scanRadius 会直接扩大后续入队遍历半径，无需重扫已检段
                if (isNewBlockId && (scannedSections.size > 0 || getPendingScanCount() > 0)) {
                    bindingsVersion++
                }
                if (sub.onBindingChanged != null) {
                    try { sub.onBindingChanged(idStr, meta, prevMeta) } catch (eChg) { logCatch(sub.id + ':onBindingChanged', eChg) }
                }
                return true
            },
            unbind: unbindBlockForSub,
            scanNow: function () {
                if (sub.destroyed) return 0
                var hasAnyBinding = false
                var subMaxRadius  = 0
                bindingsByBlockId.forEach(function (bMap) {
                    var meta = bMap.get(subId)
                    if (meta != null) {
                        hasAnyBinding = true
                        var r = (meta.scanRadius != null && isFinite(Number(meta.scanRadius))) ? Number(meta.scanRadius) : 32
                        if (r > subMaxRadius) subMaxRadius = r
                    }
                })
                if (!hasAnyBinding) {
                    recordEnqueueStatus(0, false, false, true)
                    return 0
                }
                return enqueueNearbySections({
                    forceNearby: true,
                    maxRadius:   subMaxRadius > 0 ? subMaxRadius : 32
                })
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
                trackedRecordsTotalCalls++
                sub.getTrackedRecordsCalls++
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
            if (persistDirty && (tickCounter - lastFlushTick) >= CONFIG.saveDebounceTicks) {
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
                CONFIG.scanEnqInterval = Math.max(1, Math.floor(Number(patch.scanEnqInterval)))
            }
            if (patch.scanSectionsPerTick != null && isFinite(Number(patch.scanSectionsPerTick))) {
                CONFIG.scanSectionsPerTick = Math.max(1, Math.floor(Number(patch.scanSectionsPerTick)))
            }
            if (patch.verifyWindowTicks != null && isFinite(Number(patch.verifyWindowTicks))) {
                CONFIG.verifyWindowTicks = Math.max(1, Math.floor(Number(patch.verifyWindowTicks)))
            }
            if (patch.saveDebounceTicks != null && isFinite(Number(patch.saveDebounceTicks))) {
                CONFIG.saveDebounceTicks = Math.max(1, Math.floor(Number(patch.saveDebounceTicks)))
            }
            if (patch.maxScannedSections != null && isFinite(Number(patch.maxScannedSections))) {
                CONFIG.maxScannedSections = Math.max(256, Math.floor(Number(patch.maxScannedSections)))
                while (scannedSections.size > CONFIG.maxScannedSections) {
                    var oldestKey = scannedSections.keys().next().value
                    if (oldestKey === undefined) break
                    scannedSections.delete(oldestKey)
                }
            }
            if (patch.maxScanQueue != null && isFinite(Number(patch.maxScanQueue))) {
                CONFIG.maxScanQueue = Math.max(16, Math.floor(Number(patch.maxScanQueue)))
            }
        }
        return {
            scanEnqInterval:     CONFIG.scanEnqInterval,
            scanSectionsPerTick: CONFIG.scanSectionsPerTick,
            verifyWindowTicks:   CONFIG.verifyWindowTicks,
            saveDebounceTicks:   CONFIG.saveDebounceTicks,
            maxScannedSections:  CONFIG.maxScannedSections,
            maxScanQueue:        CONFIG.maxScanQueue
        }
    }

    // 显式全量重置（参见【重新发现机制边界约定】策略 3）
    function rescanAll() {
        scannedSections.clear()
        resetScanQueue()
        return enqueueNearbySections({ forceNearby: true })
    }

    function getLastScanStatus() {
        return {
            enqueued:         lastEnqueueStatus.enqueued,
            blockedByQueue:   lastEnqueueStatus.blockedByQueue,
            truncatedByQueue: lastEnqueueStatus.truncatedByQueue,
            pending:          getPendingScanCount(),
            cap:              CONFIG.maxScanQueue,
            forceNearby:      lastEnqueueStatus.forceNearby
        }
    }

    function getStats() {
        var subCalls = {}
        subscribers.forEach(function (sub, id) {
            subCalls[id] = sub.getTrackedRecordsCalls || 0
        })
        return {
            bindingsCount:          bindingsByBlockId.size,
            bindingsVersion:        bindingsVersion,
            subscribersCount:       subscribers.size,
            trackedBlocksSize:      trackedBlocks.size,
            scannedSectionsSize:    scannedSections.size,
            maxScannedSections:     CONFIG.maxScannedSections,
            scanQueueArrayLength:   scanQueue.length,
            scanQueueHead:          scanQueueHead,
            pendingScanCount:       getPendingScanCount(),
            maxScanQueue:           CONFIG.maxScanQueue,
            stateIdCacheSize:       stateIdCache.size,
            getTrackedRecordsCalls: trackedRecordsTotalCalls,
            subscriberCalls:        subCalls,
            lastEnqueueStatus:      getLastScanStatus()
        }
    }

    global.EpiphyBlockTracker = {
        CONFIG:            CONFIG,
        configure:         configure,
        createTracker:     createTracker,
        migrateLegacyOnce: migrateLegacyOnce,
        rescanAll:         rescanAll,
        getStats:          getStats,
        getLastScanStatus: getLastScanStatus,
        extractBlockId:    extractBlockId,
        isChunkLoaded:     isChunkLoaded,
        makePosKey:        makePosKey,
        normalizeDim:      normalizeDim,
        dimOfLevel:        dimOfLevel,
        resolveLevel:      resolveLevel
    }

    // 动态上报扫描队列、已追踪池、getTrackedRecords 调用频次等到 EpiphyDebug
    var trackerDebugProvider = {
        name:    'tracker',
        label:   '方块追踪组件',
        order:   20,
        summary: function () {
            var s = getStats()
            return 'scanQueue.length=' + s.scanQueueArrayLength +
                ' (pending=' + s.pendingScanCount + ')' +
                ' | trackedBlocks.size=' + s.trackedBlocksSize +
                ' | scannedSections=' + s.scannedSectionsSize +
                ' | getTrackedRecords=' + s.getTrackedRecordsCalls
        },
        detail: function () {
            var s = getStats()
            return [
                'bindingsCount: ' + s.bindingsCount + ' (version=' + s.bindingsVersion + ')',
                'subscribersCount: ' + s.subscribersCount,
                'trackedBlocks.size: ' + s.trackedBlocksSize,
                'scannedSections.size: ' + s.scannedSectionsSize + ' / max=' + CONFIG.maxScannedSections,
                'scanQueue.length: ' + s.scanQueueArrayLength + ' (head=' + s.scanQueueHead + ', pending=' + s.pendingScanCount + ', max=' + CONFIG.maxScanQueue + ')',
                'CONFIG: enqInterval=' + CONFIG.scanEnqInterval + ', perTick=' + CONFIG.scanSectionsPerTick + ', verifyWin=' + CONFIG.verifyWindowTicks + ', debounce=' + CONFIG.saveDebounceTicks,
                'stateIdCache.size: ' + s.stateIdCacheSize,
                'getTrackedRecordsCalls: ' + s.getTrackedRecordsCalls + ' (perSub=' + JSON.stringify(s.subscriberCalls) + ')',
                'persistDirty: ' + persistDirty + ', storagePath: ' + (loadedStoragePath || '（未加载世界）')
            ]
        },
        check: function () {
            var s = getStats()
            var qOk = s.pendingScanCount < Math.floor(CONFIG.maxScanQueue * 0.85)
            var pOk = (SERVER_REF == null || loadedStoragePath != null)
            return [
                {
                    name:   'scan_queue_headroom',
                    ok:     qOk,
                    detail: 'pending=' + s.pendingScanCount + '/' + CONFIG.maxScanQueue + ' (arrayLen=' + s.scanQueueArrayLength + ')'
                },
                {
                    name:   'storage_initialized',
                    ok:     pOk,
                    detail: 'loadedStoragePath=' + String(loadedStoragePath)
                }
            ]
        },
        actions: {
            rescan: {
                desc: '重扫在线玩家周边非空气区块段',
                fn: function () {
                    var n  = rescanAll()
                    var st = getLastScanStatus()
                    if (st.truncatedByQueue) {
                        return '已重扫并新入队 ' + n + ' 个非空气区块段（扫描队列已满 ' + st.pending + '/' + st.cap + '，剩余区段将在消费空出后按周期补扫）'
                    }
                    if (st.blockedByQueue) {
                        return '扫描队列已满（' + st.pending + '/' + st.cap + ' 排队中），本次未能入队'
                    }
                    return '已重扫并新入队 ' + n + ' 个非空气区块段（待扫总数: ' + getPendingScanCount() + '）'
                }
            },
            flush: {
                desc: '立即将 trackedBlocks 落盘保存',
                fn: function () {
                    flushTrackedBlocks()
                    return '已落盘 savedCount=' + trackedBlocks.size + ' -> ' + String(loadedStoragePath)
                }
            }
        }
    }
    if (typeof global !== 'undefined' && global != null) {
        if (global.EpiphyDebug != null && typeof global.EpiphyDebug.registerProvider === 'function') {
            global.EpiphyDebug.registerProvider(trackerDebugProvider)
        } else {
            if (!Array.isArray(global.EpiphyDebugProviderQueue)) global.EpiphyDebugProviderQueue = []
            global.EpiphyDebugProviderQueue.push(trackerDebugProvider)
        }
    }
})()
