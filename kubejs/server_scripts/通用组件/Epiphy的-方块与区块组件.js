// priority: 1050
// ============================================================================
//  通用方块追踪与区块地形批处理组件 (EpiphyBlockTracker / EpiphyChunkEngine v2.5.1)
//  所属系列：Epiphy的-通用组件系列（本系列包含 startup / server / client 配套脚本）
//  许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
//  放置位置：kubejs/server_scripts/通用组件/Epiphy的-方块与区块组件.js
//
//  职责说明：
//    1. 维护全服唯一的物理方块追踪表与 16x16x16 LevelChunkSection 渐进式扫描队列；
//       同一物理方块可同时被同系列多个业务订阅者（如 danmaku、audio、uncrafting）订阅，只扫一遍、只存一份；
//    2. 统一持久化至按存档隔离的 JSON 文件（优先 Java NIO .tmp + .bak 原子写，ClassFilter 下回退 JsonIO + persistentData 双写）；
//    3. 提供 migrateLegacyOnce(sourceSpec, blockId) 供业务侧声明旧存档数据一次性迁移，底座本身零业务耦合；
//    4. 集成【三级开销门控与统一帧时间预算】的区块地形批处理服务（`EpiphyWorldOps` / `EpiphyBlockTracker`）：
//       - 静态零开销休眠 + 反射句柄 Lazy Init（未提交重型地形任务时零内存与 CPU 开销）；
//       - 自适应开销开关（Pre-flight Cost Estimator）：小半径区域（R <= smallSphereDirectRadius）直接走单帧局部扫描，
//         大半径区域自动升级为 LevelChunkSection 调色板 O(1) 预筛 + 热点列复扫 + 未加载区块挂起队列；
//       - 统一帧时间预算（Unified Tick Budget）：当高优先级地形/流体批处理任务活跃时，自动共享帧预算并礼让低优后台区块巡检；
//       - 提供 `startSphereFluidPurge` / `triggerIncrementalFluidSweep`（球体全流体与含水属性剥离）、
//         `findLoadedSurfaceY`（严格零磁盘 IO 表面寻高）与 `startRingBlockJob`（分帧圆环方块浇筑）。
// ============================================================================

;(function () {
    var VERSION         = '2.5.1'
    var PERSIST_KEY     = 'epiphy_tracked_blocks_v2'
    // 注意：trackedBlocks 记录物理方块坐标状态，须随存档备份还原同步回滚，因此刻意保存在 saves/<world>/ 而非抗回滚的 epiphy-data/（见 README-LLM.md §5.1）
    var WORLD_FILE_NAME = 'kubejs_epiphy_tracked_blocks.json'
    var FALLBACK_DIR    = 'kubejs/config/epiphy_tracked_blocks'

    var SPEC   = (typeof global !== 'undefined' && global.EpiphySpec != null) ? global.EpiphySpec : null
    var E_MATH = (typeof global !== 'undefined' && global.EpiphyMath != null) ? global.EpiphyMath : (SPEC && SPEC.MATH ? SPEC.MATH : null)
    var TWO_PI = (E_MATH && typeof E_MATH.TWO_PI === 'number') ? E_MATH.TWO_PI : 6.283185307179586
    var BASE = (typeof global !== 'undefined') ? (global.EpiphyServerCore || global.EpiphyServerBase) : null
    if (!BASE) {
        throw new Error('[EpiphyBlockTracker] 缺少硬依赖 global.EpiphyServerBase，请确认 server_scripts/通用组件/Epiphy的-服务端核心.js 已加载')
    }
    if (SPEC && typeof SPEC.checkDependencyVersion === 'function') {
        SPEC.checkDependencyVersion('EpiphyServerCore', BASE, '2.5.0', '2.99.99', { caller: 'EpiphyBlockTracker', required: true })
    }
    var LOGGER = BASE.createLogger('EpiphyBlockTracker', 5000)

    var CONFIG = {
        saveDebounceTicks:       40,
        verifyWindowTicks:       20,
        scanEnqInterval:         20,
        scanSectionsPerTick:     1,
        maxScannedSections:      8192,
        maxScanQueue:            512,
        worldOpsTickBudgetMs:    8,
        worldOpsMaxColsPerTick:  160,
        smallSphereDirectRadius: 16,
        ringBlocksPerTick:       240
    }

    var SERVER_REF         = null
    var loadedPersistSrv   = null
    var loadedStoragePath  = null
    var tickCounter        = 0
    var persistDirty       = false
    var lastFlushTick      = -9999
    var migratedLegacyFlag = false
    var nextVerifySlot     = 0

    var nowNano = BASE.nowNano

    var lastTickAllMs       = 0
    var lastActiveTickAllMs = 0
    var maxTickAllMs        = 0
    var tickAllCount        = 0
    var lastTickAllTick     = 0
    var lastScanSliceMs     = 0
    var maxScanSliceMs      = 0
    var scanSliceCount      = 0

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

    var logCatch       = (tag, err) => LOGGER.catchWarn(tag, err)
    var normalizeDim   = BASE.normalizeDim
    var dimOfLevel     = BASE.dimOfLevel
    var resolveLevel   = (levelOrDim, server) => BASE.resolveLevel(levelOrDim, server || SERVER_REF)
    var makePosKey     = BASE.makePosKey
    var extractBlockId = BASE.extractBlockId
    var isChunkLoaded  = BASE.isChunkLoaded
    var readPlayerPos  = BASE.readPos

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

    var readJsonField           = BASE.readMapField
    var toSeqArray              = BASE.toSeqArray
    var resolveWorldStorageInfo = (server) => BASE.resolveWorldStorageInfo(server || SERVER_REF, WORLD_FILE_NAME, FALLBACK_DIR)

    var loadedStorageStore = null

    function ensureStorageStore(filePath) {
        var normTarget = filePath ? String(filePath).replace(/\\/g, '/') : ''
        if (loadedStorageStore != null && loadedStorageStore.path === normTarget) {
            return loadedStorageStore
        }
        loadedStorageStore = BASE.openJsonStore(normTarget, { logger: LOGGER, backup: true, lockOnCorrupt: true })
        return loadedStorageStore
    }

    function flushTrackedBlocks() {
        if (SERVER_REF == null || !persistDirty) return false
        try {
            var arr = []
            trackedBlocks.forEach(function (item) {
                arr.push([item.blockId, item.dim, item.x, item.y, item.z])
            })
            var targetPath = loadedStoragePath || resolveWorldStorageInfo(SERVER_REF).filePath
            loadedStoragePath = targetPath
            var store = ensureStorageStore(targetPath)
            var payload = {
                version:        2,
                updatedAt:      formatTimestampNow(),
                migratedLegacy: migratedLegacyFlag,
                blocks:         arr
            }
            var wroteDisk = Boolean(store.save(payload))
            try {
                if (SERVER_REF.persistentData != null && typeof SERVER_REF.persistentData.putString === 'function') {
                    SERVER_REF.persistentData.putString(PERSIST_KEY, JSON.stringify(arr))
                }
            } catch (ePData) { }
            if (wroteDisk) {
                persistDirty  = false
                lastFlushTick = tickCounter
                return true
            }
            if (store.isCorrupt()) {
                // 损坏锁生效期间外部 JSON 不覆盖，运行态已由 persistentData 兜底，清空脏标记避免每 tick 空转刷告警
                persistDirty  = false
                lastFlushTick = tickCounter
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
            if (rec != null && rec.blockId !== blockId) {
                dispatchRemovedToSubscribers(rec, 'block_changed', null, null)
            }
            rec = { key: key, blockId: blockId, dim: dim, x: ix, y: iy, z: iz, vSlot: allocVerifySlot(), chunkLoaded: true, extras: {} }
            trackedBlocks.set(key, rec)
            if (saveNow !== false) saveTrackedBlocks(false)
        }
        if (triggerFound) {
            dispatchFoundToSubscribers(rec, null, source)
        }
        return rec
    }

    function importSerializedBlockArray(rawOrArr, fallbackBlockId, sourceKey, optAddedKeysOut) {
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
                if (Array.isArray(optAddedKeysOut)) optAddedKeysOut.push(key)
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
        loadedStorageStore = BASE.openJsonStore(loadedStoragePath, { logger: LOGGER, backup: true, lockOnCorrupt: true })

        var detailRes  = loadedStorageStore.load()
        var diskStatus = detailRes.status
        var rawObj     = detailRes.data

        if (diskStatus === 'ok' && rawObj != null) {
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
        } else if (diskStatus === 'corrupt') {
            LOGGER.warn('ensureLoaded:corrupt', '追踪方块持久化文件损坏且无可用 .bak 备份 (' + loadedStoragePath + ')，尝试从 persistentData 恢复并挂起空表覆盖保护')
        }

        var diskCorrupt = loadedStorageStore.isCorrupt()
        if (!migratedLegacyFlag || diskCorrupt) {
            var loadKeys = [PERSIST_KEY, 'epiphy_danmaku_bound_blocks_v1', 'epiphy_audio_bound_blocks_v1']
            var importedLegacy = 0
            for (var kIdx = 0; kIdx < loadKeys.length; kIdx++) {
                try {
                    if (SERVER_REF.persistentData == null || typeof SERVER_REF.persistentData.getString !== 'function') break
                    var raw = SERVER_REF.persistentData.getString(loadKeys[kIdx])
                    if (raw && String(raw).length > 0) {
                        importedLegacy += importSerializedBlockArray(raw, null, loadKeys[kIdx])
                    }
                } catch (eLoad) {
                    logCatch('ensureLoaded:' + loadKeys[kIdx], eLoad)
                }
            }
            if (!diskCorrupt || importedLegacy > 0) {
                migratedLegacyFlag = true
            }
            if (importedLegacy > 0) {
                saveTrackedBlocks(true)
            }
        }
        trackedBlocks.forEach(function (rec) {
            if (rec != null && bindingsByBlockId.has(rec.blockId)) {
                dispatchFoundToSubscribers(rec, null, 'persist')
            }
        })
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
                    importSerializedBlockArray(raw, bid, specObj.serverKey, addedKeys)
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
        var cs    = (typeof lv.getChunkSource === 'function') ? lv.getChunkSource() : null
        var chunk = (cs != null && typeof cs.getChunkNow === 'function')
            ? cs.getChunkNow(chunkX, chunkZ)
            : ((typeof lv.hasChunk === 'function' && lv.hasChunk(chunkX, chunkZ) && typeof lv.getChunk === 'function') ? lv.getChunk(chunkX, chunkZ) : null)
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
        var t0Ns      = nowNano()
        var processed = 0
        var dirty     = false
        try {
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

                // 优先外挂原生 Mod 的 NativeSectionScanner（单次纯 Java 调色板预筛 + 指针扫描，取代 Rhino 4096 次跨界调用）
                var natScanner = (typeof EpiphyNative !== 'undefined' && EpiphyNative != null)
                    ? EpiphyNative
                    : ((typeof global !== 'undefined' && global != null) ? global.EpiphyNative : null)
                if (natScanner != null && typeof natScanner.scanChunkSection === 'function') {
                    var targetIds = Array.from(bindingsByBlockId.keys())
                    var matchedList = natScanner.scanChunkSection(section, task.sx, task.sy, task.sz, targetIds)
                    if (matchedList != null && typeof matchedList.size === 'function') {
                        var mSize = Number(matchedList.size())
                        for (var mi = 0; mi < mSize; mi++) {
                            var mHit = matchedList.get(mi)
                            if (mHit == null) continue
                            var mBid = String(mHit.blockId())
                            var mx = Number(mHit.x()), my = Number(mHit.y()), mz = Number(mHit.z())
                            var mKey = makePosKey(task.dim, mx, my, mz)
                            if (!trackedBlocks.has(mKey)) {
                                registerTrackedBlock(mBid, task.dim, mx, my, mz, false, true, 'native_scan')
                                dirty = true
                            }
                        }
                        touchScannedSection(task.skey, bindingsVersion)
                        continue
                    }
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
        } finally {
            var dtSliceMs = (nowNano() - t0Ns) / 1000000.0
            if (processed > 0 && dtSliceMs >= 0 && isFinite(dtSliceMs)) {
                lastScanSliceMs = dtSliceMs
                scanSliceCount++
                if (dtSliceMs > maxScanSliceMs) maxScanSliceMs = dtSliceMs
            }
        }
    }

    function tickAllTrackedBlocks() {
        if (SERVER_REF == null) return
        ensureLoaded()
        absorbGlobalMigrations()
        if (bindingsByBlockId.size === 0) return

        var willEnqueue = (tickCounter % CONFIG.scanEnqInterval) === 1
        var hasQueued   = scanQueueHead < scanQueue.length
        var hadTracked  = trackedBlocks.size > 0
        if (!willEnqueue && !hasQueued && !hadTracked) return

        var t0Ns  = nowNano()
        var dirty = false
        try {
            if (willEnqueue) {
                enqueueNearbySections()
            }
            processScanSlice()

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
                            // 卸载区块内条目刻意保留在 trackedBlocks 与持久化文件中（仅跳过 per-tick 回调），以便玩家重返区块时恢复追踪；
                            // 方块实际破坏/替换/unbind 时会通过 delete 立即清理。
                            rec.chunkLoaded = false
                            return
                        }
                        rec.chunkLoaded = true
                        try { curBlock = lv.getBlock(rec.x, rec.y, rec.z) } catch (eGet) { logCatch('tick:getBlock', eGet) }
                        if (extractBlockId(curBlock) !== rec.blockId) {
                            trackedBlocks.delete(posKey)
                            dispatchRemovedToSubscribers(rec, 'block_changed', null, null)
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
        } finally {
            var dtMs = (nowNano() - t0Ns) / 1000000.0
            if (dtMs >= 0 && isFinite(dtMs)) {
                lastTickAllMs   = dtMs
                tickAllCount++
                lastTickAllTick = tickCounter
                if (hadTracked || trackedBlocks.size > 0) lastActiveTickAllMs = dtMs
                if (dtMs > maxTickAllMs) maxTickAllMs = dtMs
            }
        }
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
                if (prevMeta == null && loadedPersistSrv != null && trackedBlocks.size > 0) {
                    trackedBlocks.forEach(function (rec) {
                        if (rec != null && rec.blockId === idStr) {
                            dispatchFoundToSubscribers(rec, subId, 'persist')
                        }
                    })
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

    // ========================================================================
    // 区块与地形批处理引擎（三级开销门控：Lazy Init + 自适应开关 + 统一帧时间预算）
    // ========================================================================
    var worldOpsInitialized  = false
    var BLOCK_POS_CLASS      = null
    var MUTABLE_POS_CLASS    = null
    var SHARED_MUTABLE_POS   = null
    var AIR_STATE            = null
    var WATERLOGGED_PROP     = null
    var JAVA_BOOL_FALSE      = false
    var PALETTE_FLUID_STATE  = 0 // 0=未探测, 1=支持 maybeHas, -1=不支持
    var fluidPurgeJobs       = []
    var ringBlockJobs        = []
    var protectedRingCols    = {} // key: dim|chunkX|chunkZ -> expireTick（保护已浇筑的岩浆环不被流体复扫清除）
    var lastWorldOpsTickMs   = 0
    var maxWorldOpsTickMs    = 0

    var RING_PROTECTED_BLOCK_IDS = {
        'minecraft:bedrock':               true,
        'minecraft:barrier':               true,
        'minecraft:end_portal_frame':      true,
        'minecraft:end_portal':            true,
        'minecraft:end_gateway':           true,
        'minecraft:command_block':         true,
        'minecraft:chain_command_block':   true,
        'minecraft:repeating_command_block': true,
        'minecraft:structure_block':       true,
        'minecraft:jigsaw':                true
    }

    function isLavaBlockOrState(level, wx, wy, wz, state) {
        try {
            var sid = extractStateIdCached(state)
            if (sid === 'minecraft:lava') return true
            if (sid != null && sid !== '') return false
        } catch (eSid) { }
        try {
            var b = level.getBlock(wx, wy, wz)
            if (b != null && String(b.id) === 'minecraft:lava') return true
        } catch (eBlk) { }
        return false
    }

    var FLUID_PREDICATE = function (state) {
        try {
            return !state.getFluidState().isEmpty()
        } catch (e) {
            return true
        }
    }

    function ensureWorldOpsInit() {
        if (worldOpsInitialized) return
        worldOpsInitialized = true
        BLOCK_POS_CLASS   = BASE.loadJavaClass('net.minecraft.core.BlockPos', true)
        MUTABLE_POS_CLASS = BASE.loadJavaClass('net.minecraft.core.BlockPos$MutableBlockPos', true)
        if (MUTABLE_POS_CLASS != null) {
            try { SHARED_MUTABLE_POS = new MUTABLE_POS_CLASS() } catch (eM) { SHARED_MUTABLE_POS = null }
        }
        var blocksCls = BASE.loadJavaClass('net.minecraft.world.level.block.Blocks', true)
        if (blocksCls != null && blocksCls.AIR != null && typeof blocksCls.AIR.defaultBlockState === 'function') {
            try { AIR_STATE = blocksCls.AIR.defaultBlockState() } catch (eAir) { AIR_STATE = null }
        }
        if (AIR_STATE == null) {
            var regCls = BASE.loadJavaClass('net.minecraftforge.registries.ForgeRegistries', true)
            var rlCls  = BASE.loadJavaClass('net.minecraft.resources.ResourceLocation', true)
            if (regCls != null && rlCls != null && regCls.BLOCKS != null) {
                try {
                    var airBlk = regCls.BLOCKS.getValue(new rlCls('minecraft:air'))
                    if (airBlk != null && typeof airBlk.defaultBlockState === 'function') AIR_STATE = airBlk.defaultBlockState()
                } catch (eAir2) { }
            }
        }
        var propsCls = BASE.loadJavaClass('net.minecraft.world.level.block.state.properties.BlockStateProperties', true)
        if (propsCls != null && propsCls.WATERLOGGED != null) {
            WATERLOGGED_PROP = propsCls.WATERLOGGED
        }
        var jBoolCls = BASE.loadJavaClass('java.lang.Boolean', true)
        if (jBoolCls != null && jBoolCls.FALSE != null) {
            JAVA_BOOL_FALSE = jBoolCls.FALSE
        }
    }

    function purgeChunkColumnFluids(level, chunkX, chunkZ, cx, cy, cz, rSq, minWorldY, maxWorldY, useCylinder2D, purgeOpts) {
        ensureWorldOpsInit()
        var col = null
        try {
            col = getLoadedChunkSections(level, chunkX, chunkZ)
        } catch (eCol) {
            return 0
        }
        if (!col || !col.loaded) return 2
        var sections = col.sections
        if (sections == null) return 0

        var pOpts       = (purgeOpts != null && typeof purgeOpts === 'object') ? purgeOpts : {}
        var normDim     = pOpts.dim || 'minecraft:overworld'
        var ringProtExp = protectedRingCols[normDim + '|' + chunkX + '|' + chunkZ] || 0
        var skipLava    = Boolean(pOpts.excludeLava) || (ringProtExp > tickCounter)
        var cylFloorY   = (pOpts.cylFloorY != null && isFinite(pOpts.cylFloorY)) ? pOpts.cylFloorY : Math.min(cy, 16)
        var rimShellRSq = (pOpts.rimShellRSq != null && pOpts.rimShellRSq > 0) ? pOpts.rimShellRSq : rSq

        var minBuildY = col.minBuildY
        var baseX     = chunkX << 4
        var baseZ     = chunkZ << 4
        var mpos      = SHARED_MUTABLE_POS
        var hadFluid  = false
        var isCyl     = (useCylinder2D !== false)

        // 水平 2D AABB 最近点与最远点预计算（上层海平面/水柱使用 2D 圆柱距离，消除球面内缩遗留水墙；深层地下使用半球距离保护深部地下水/岩浆湖）
        var nearX = (cx < baseX) ? (baseX - cx) : (cx > baseX + 15 ? (cx - (baseX + 15)) : 0)
        var nearZ = (cz < baseZ) ? (baseZ - cz) : (cz > baseZ + 15 ? (cz - (baseZ + 15)) : 0)
        var near2DSq = nearX * nearX + nearZ * nearZ
        if (near2DSq > rSq) return 0

        var farX = Math.max(Math.abs(baseX - cx), Math.abs(baseX + 15 - cx))
        var farZ = Math.max(Math.abs(baseZ - cz), Math.abs(baseZ + 15 - cz))
        var far2DSq = farX * farX + farZ * farZ

        for (var sIdx = 0, sLen = sections.length; sIdx < sLen; sIdx++) {
            var section = sections[sIdx]
            if (section == null) continue
            try {
                if (typeof section.hasOnlyAir === 'function' && section.hasOnlyAir()) continue
            } catch (eAirChk) { }

            var secBottomY = minBuildY + (sIdx << 4)
            var secTopY    = secBottomY + 15
            if (secTopY < minWorldY || secBottomY > maxWorldY) continue

            if (!isCyl) {
                var nearY = (cy < secBottomY) ? (secBottomY - cy) : (cy > secTopY ? (cy - secTopY) : 0)
                if (near2DSq + nearY * nearY > rSq) continue
            } else if (secTopY < cylFloorY) {
                var nearFloorY = cylFloorY - secTopY
                if (near2DSq + nearFloorY * nearFloorY > rSq) continue
            }

            if (PALETTE_FLUID_STATE >= 0 && typeof section.maybeHas === 'function') {
                var hasFluidInPalette = true
                try {
                    hasFluidInPalette = Boolean(section.maybeHas(FLUID_PREDICATE))
                    PALETTE_FLUID_STATE = 1
                } catch (ePal) {
                    PALETTE_FLUID_STATE = -1
                    hasFluidInPalette = true
                }
                if (!hasFluidInPalette) continue
            }

            var fullyInside
            if (isCyl && secBottomY >= cylFloorY) {
                fullyInside = (far2DSq <= rSq)
            } else {
                var refCenterY = isCyl ? cylFloorY : cy
                var farY = Math.max(Math.abs(secBottomY - refCenterY), Math.abs(secTopY - refCenterY))
                fullyInside = (far2DSq + farY * farY <= rSq)
            }

            for (var ly = 0; ly < 16; ly++) {
                var wy   = secBottomY + ly
                if (wy < minWorldY || wy > maxWorldY) continue
                var dySq = 0
                if (!isCyl) {
                    dySq = (wy - cy) * (wy - cy)
                } else if (wy < cylFloorY) {
                    dySq = (wy - cylFloorY) * (wy - cylFloorY)
                }
                for (var lx = 0; lx < 16; lx++) {
                    var wx    = baseX + lx
                    var dx    = wx - cx
                    var dxSq  = dx * dx
                    var dxySq = dxSq + dySq
                    for (var lz = 0; lz < 16; lz++) {
                        var wz = baseZ + lz
                        var dz = wz - cz
                        var horizSq = dxSq + dz * dz
                        if (!fullyInside) {
                            if (dxySq + dz * dz > rSq) continue
                        }
                        try {
                            var state = section.getBlockState(lx, ly, lz)
                            if (state == null || state.getFluidState().isEmpty()) continue
                            if (skipLava && isLavaBlockOrState(level, wx, wy, wz, state)) continue
                            hadFluid = true
                            // 最外侧 1~1.5 格边界壳层使用 flag=3 通知邻居流体更新，使边界海水自然回流坍塌而非冻结为悬空垂直水墙；
                            // 内部核心区域继续使用 flag=2 批量静默剥离以避免巨量连锁流体 tick
                            var setFlags = (horizSq > rimShellRSq) ? 3 : 2
                            var tpos = (mpos != null)
                                ? mpos.set(wx, wy, wz)
                                : (BLOCK_POS_CLASS != null ? new BLOCK_POS_CLASS(wx, wy, wz) : null)
                            if (WATERLOGGED_PROP != null && typeof state.hasProperty === 'function' && state.hasProperty(WATERLOGGED_PROP) && tpos != null) {
                                level.setBlock(tpos, state.setValue(WATERLOGGED_PROP, JAVA_BOOL_FALSE), setFlags)
                            } else if (AIR_STATE != null && tpos != null && typeof level.setBlock === 'function') {
                                level.setBlock(tpos, AIR_STATE, setFlags)
                            } else {
                                level.getBlock(wx, wy, wz).set('minecraft:air')
                            }
                        } catch (eInner) { }
                    }
                }
            }
        }
        return hadFluid ? 1 : 0
    }

    function findFluidPurgeJob(dim, cx, cy, cz) {
        var normDim = normalizeDim(dim) || 'minecraft:overworld'
        for (var i = 0; i < fluidPurgeJobs.length; i++) {
            var j = fluidPurgeJobs[i]
            if (j != null && j.dim === normDim && j.x === cx && j.y === cy && j.z === cz) {
                return j
            }
        }
        return null
    }

    // 自适应开销门控球体流体剥离：
    //   - 当总半径 r <= CONFIG.smallSphereDirectRadius 时，直接单帧完成，不分配跨帧热点/未加载队列；
    //   - 当总半径较大时，T+0 同步抽干核心区（受 syncMaxMs 保护），随后进入分帧热点队列与未加载区块挂起队列。
    var WORLD_OPS_PRESETS = (typeof global !== 'undefined' && global.EpiphySpec && typeof global.EpiphySpec.createPresetRegistry === 'function')
        ? global.EpiphySpec.createPresetRegistry('world_ops')
        : { register: function () { return false }, has: function () { return false }, get: function () { return null }, remove: function () { return false }, list: function () { return [] }, resolve: function () { return null } }

    function resolveWorldOpsOpts(rawOpts) {
        if (!BASE.isObjectLike(rawOpts)) return {}
        if (typeof rawOpts.preset === 'string' && rawOpts.preset.trim() !== '') {
            var resolved = WORLD_OPS_PRESETS.resolve(rawOpts.preset, rawOpts)
            if (BASE.isObjectLike(resolved)) return resolved
        }
        return rawOpts
    }

    function startSphereFluidPurge(level, dim, cx, cy, cz, radius, opts) {
        if (level == null || !(radius > 0)) return false
        ensureWorldOpsInit()
        var options       = resolveWorldOpsOpts(opts)
        var normDim       = normalizeDim(dim || dimOfLevel(level)) || 'minecraft:overworld'
        var isRimOnly     = Boolean(options.isRimOnlySweep)
        // 同时支持 options.cylinder2D 与 options.useCylinder2D 两种命名（默认开启上柱下球模式）
        var useCylinder2D = (options.cylinder2D !== false && options.useCylinder2D !== false)
        var excludeLava   = Boolean(options.excludeLava || options.waterOnly)
        var sweepCooldown = (options.sweepIntervalTicks != null && isFinite(Number(options.sweepIntervalTicks)))
            ? Math.max(0, Math.floor(Number(options.sweepIntervalTicks)))
            : 15
        var padding       = (options.padding != null && isFinite(Number(options.padding))) ? Number(options.padding) : 16
        var loops         = (options.loops != null && isFinite(Number(options.loops))) ? Math.max(1, Math.floor(Number(options.loops))) : 6
        var unloadedTtl   = (options.unloadedTtl != null && isFinite(Number(options.unloadedTtl))) ? Math.max(20, Math.floor(Number(options.unloadedTtl))) : 600
        var syncInitR     = isRimOnly ? 0 : ((options.syncInitRadius != null && isFinite(Number(options.syncInitRadius))) ? Number(options.syncInitRadius) : 96)
        var syncMaxMs     = (options.syncMaxMs != null && isFinite(Number(options.syncMaxMs))) ? Number(options.syncMaxMs) : 25
        var onDone        = (typeof options.onDone === 'function') ? options.onDone : null

        var existingJob = findFluidPurgeJob(normDim, cx, cy, cz)
        if (existingJob != null) {
            existingJob.loopsLeft     = Math.max(existingJob.loopsLeft, isRimOnly ? 2 : loops)
            existingJob.expireTick    = Math.max(existingJob.expireTick, tickCounter + unloadedTtl)
            existingJob.nextSweepTick = tickCounter
            if (excludeLava) existingJob.excludeLava = true
            if (existingJob.index >= existingJob.columns.length && existingJob.rimColumns && existingJob.rimColumns.length > 0) {
                existingJob.columns    = existingJob.rimColumns.slice()
                existingJob.hotColumns = []
                existingJob.index      = 0
            }
            return true
        }

        var r           = radius + padding
        var rSq         = r * r
        var rimShellRSq = (r > 2) ? ((r - 1.5) * (r - 1.5)) : rSq
        var minWorldY   = -64, maxWorldY = 319
        if (normDim === 'minecraft:the_nether' || normDim === 'minecraft:the_end') {
            minWorldY = 0
            maxWorldY = 255
        }
        if (typeof level.getMinBuildHeight === 'function') {
            try { minWorldY = Number(level.getMinBuildHeight()) } catch (eMinY) { }
        }
        if (typeof level.getMaxBuildHeight === 'function') {
            try { maxWorldY = Number(level.getMaxBuildHeight()) - 1 } catch (eMaxY) { }
        }
        // 上部柱体 + 下部半球：cylFloorY（默认 min(cy, 16)，涵盖全部海平面与深海海床）以上采用完整圆柱截断水墙，
        // cylFloorY 以下按球体半径收敛 y0，避免无故抽干爆心外围直到 -64 层的深部地下水与岩浆湖
        var cylFloorY = (options.cylinderFloorY != null && isFinite(Number(options.cylinderFloorY)))
            ? Math.floor(Number(options.cylinderFloorY))
            : Math.min(cy, 16)
        var y0 = (options.fullHeightCylinder === true)
            ? minWorldY
            : Math.max(minWorldY, cy - r)
        var y1 = useCylinder2D ? maxWorldY : Math.min(maxWorldY, cy + r)
        var purgeOpts = {
            dim:         normDim,
            excludeLava: excludeLava,
            cylFloorY:   cylFloorY,
            rimShellRSq: rimShellRSq
        }

        var minChunkX = (cx - r) >> 4
        var maxChunkX = (cx + r) >> 4
        var minChunkZ = (cz - r) >> 4
        var maxChunkZ = (cz + r) >> 4

        // 开销门控 1：小半径球体直接单帧执行完毕，不创建后台分帧任务
        if (r <= CONFIG.smallSphereDirectRadius) {
            for (var scX = minChunkX; scX <= maxChunkX; scX++) {
                for (var scZ = minChunkZ; scZ <= maxChunkZ; scZ++) {
                    purgeChunkColumnFluids(level, scX, scZ, cx, cy, cz, rSq, y0, y1, useCylinder2D, purgeOpts)
                }
            }
            if (onDone != null) {
                try { onDone() } catch (eDone0) { logCatch('fluidPurge:onDone', eDone0) }
            }
            return true
        }

        var syncRSq    = syncInitR * syncInitR
        var rimR       = Math.max(0, radius - 40)
        var rimRSq     = rimR * rimR
        var columns    = []
        var rimColumns = []
        var syncStartMs = Date.now()

        for (var chX = minChunkX; chX <= maxChunkX; chX++) {
            var bx0   = chX << 4
            var bx1   = bx0 + 15
            var nearX = (cx < bx0) ? (bx0 - cx) : (cx > bx1 ? (cx - bx1) : 0)
            for (var chZ = minChunkZ; chZ <= maxChunkZ; chZ++) {
                var bz0   = chZ << 4
                var bz1   = bz0 + 15
                var nearZ = (cz < bz0) ? (bz0 - cz) : (cz > bz1 ? (cz - bz1) : 0)
                var nearDist2D = nearX * nearX + nearZ * nearZ
                if (nearDist2D > rSq) continue

                var midX         = (bx0 + 7.5) - cx
                var midZ         = (bz0 + 7.5) - cz
                var centerDistSq = midX * midX + midZ * midZ
                var isRimCol     = (centerDistSq >= rimRSq || nearDist2D >= rimRSq)
                if (isRimOnly && !isRimCol) continue

                if (syncInitR > 0 && nearDist2D <= syncRSq && (Date.now() - syncStartMs) < syncMaxMs) {
                    var syncStatus = purgeChunkColumnFluids(level, chX, chZ, cx, cy, cz, rSq, y0, y1, useCylinder2D, purgeOpts)
                    if (syncStatus === 0 && !isRimCol) continue
                }

                var colObj = {
                    chX:    chX,
                    chZ:    chZ,
                    distSq: centerDistSq,
                    isRim:  isRimCol
                }
                columns.push(colObj)
                if (isRimCol) rimColumns.push(colObj)
            }
        }

        columns.sort((a, b) => a.distSq - b.distSq)
        rimColumns.sort((a, b) => a.distSq - b.distSq)

        fluidPurgeJobs.push({
            dim:             normDim,
            columns:         columns,
            rimColumns:      rimColumns,
            hotColumns:      [],
            unloadedColumns: [],
            unloadedKeys:    {},
            index:           0,
            x:               cx,
            y:               cy,
            z:               cz,
            rSq:             rSq,
            rimShellRSq:     rimShellRSq,
            cylFloorY:       cylFloorY,
            y0:              y0,
            y1:              y1,
            useCylinder2D:   useCylinder2D,
            excludeLava:     excludeLava,
            sweepCooldown:   sweepCooldown,
            nextSweepTick:   0,
            loopsLeft:       isRimOnly ? 0 : Math.max(0, loops - 1),
            expireTick:      tickCounter + unloadedTtl,
            notifiedDone:    Boolean(isRimOnly),
            onDone:          onDone
        })
        return true
    }

    function triggerIncrementalFluidSweep(level, dim, cx, cy, cz, radius, opts) {
        var resolvedOpts = resolveWorldOpsOpts(opts)
        var normDim = normalizeDim(dim || dimOfLevel(level)) || 'minecraft:overworld'
        var exist   = findFluidPurgeJob(normDim, cx, cy, cz)
        if (exist != null) {
            exist.loopsLeft  = Math.max(exist.loopsLeft, 2)
            exist.expireTick = Math.max(exist.expireTick, tickCounter + 240)
            if (resolvedOpts.excludeLava || resolvedOpts.waterOnly) {
                exist.excludeLava = true
            }
            return true
        }
        var mergedOpts = {}
        for (var k in resolvedOpts) {
            if (Object.prototype.hasOwnProperty.call(resolvedOpts, k)) mergedOpts[k] = resolvedOpts[k]
        }
        mergedOpts.isRimOnlySweep = true
        return startSphereFluidPurge(level, normDim, cx, cy, cz, radius, mergedOpts)
    }

    // 严格在已加载区块中快速寻高（绝不触发未加载区块同步磁盘读取）：
    //   优先通过 LevelChunkSection.hasOnlyAir() 快速跳过空区段，定位最高非空气方块坐标 y（未加载时返回 null）
    function findLoadedSurfaceY(level, x, z, refY, searchUp, searchDown) {
        if (level == null || !isChunkLoaded(level, x, z)) return null
        var upSpan   = (searchUp != null && isFinite(Number(searchUp))) ? Math.max(0, Math.floor(Number(searchUp))) : 96
        var downSpan = (searchDown != null && isFinite(Number(searchDown))) ? Math.max(0, Math.floor(Number(searchDown))) : 32
        var topY     = Math.floor(refY + upSpan)
        var botY     = Math.floor(refY - downSpan)

        try {
            var col = getLoadedChunkSections(level, x >> 4, z >> 4)
            if (col.loaded && col.sections != null) {
                var lx = x & 15
                var lz = z & 15
                var minBY = col.minBuildY
                var maxSecIdx = Math.min(col.sections.length - 1, (topY - minBY) >> 4)
                var minSecIdx = Math.max(0, (botY - minBY) >> 4)
                for (var sIdx = maxSecIdx; sIdx >= minSecIdx; sIdx--) {
                    var sec = col.sections[sIdx]
                    if (sec == null || (typeof sec.hasOnlyAir === 'function' && sec.hasOnlyAir())) continue
                    var secBaseY = minBY + (sIdx << 4)
                    var startLy  = Math.min(15, topY - secBaseY)
                    var endLy    = Math.max(0, botY - secBaseY)
                    for (var ly = startLy; ly >= endLy; ly--) {
                        var st = sec.getBlockState(lx, ly, lz)
                        if (st != null && !(typeof st.isAir === 'function' && st.isAir())) {
                            var bid = extractStateIdCached(st)
                            if (bid != null && bid !== 'minecraft:air' && bid !== 'minecraft:cave_air' && bid !== 'minecraft:void_air') {
                                return secBaseY + ly
                            }
                        }
                    }
                }
                return Math.floor(refY)
            }
        } catch (eSecSurface) { }

        // 轻量回退：仅在已确认区块加载的前提下按步长寻高
        try {
            for (var y = topY; y > botY; y--) {
                var b = level.getBlock(x, y, z)
                if (b != null && b.id !== 'minecraft:air' && b.id !== 'minecraft:cave_air') return y
            }
        } catch (eFbSurface) { }
        return Math.floor(refY)
    }

    // 分帧圆环方块浇筑任务（严格跳过未加载区块 + 遵守全局帧时间预算 + 支持表层上方/内部替换）
    function startRingBlockJob(level, dim, cx, cy, cz, radius, opts) {
        if (level == null || !(radius > 0)) return false
        var options       = resolveWorldOpsOpts(opts)
        var normDim       = normalizeDim(dim || dimOfLevel(level)) || 'minecraft:overworld'
        var blockId       = String(options.blockId || 'minecraft:lava')
        var width         = (options.width != null && isFinite(Number(options.width))) ? Math.max(1, Math.floor(Number(options.width))) : 2
        var thickness     = (options.thickness != null && isFinite(Number(options.thickness))) ? Math.max(1, Math.floor(Number(options.thickness))) : 3
        var onDone        = (typeof options.onDone === 'function') ? options.onDone : null
        var circumference = Math.max(1, Math.floor(TWO_PI * radius))
        var seenCols      = {}
        var columns       = []

        for (var step = 0; step < circumference; step++) {
            var angle = (step / circumference) * TWO_PI
            var cosA  = Math.cos(angle)
            var sinA  = Math.sin(angle)
            for (var w = 0; w < width; w++) {
                var rr     = radius + w
                var px     = Math.floor(cx + cosA * rr)
                var pz     = Math.floor(cz + sinA * rr)
                var colKey = px + '|' + pz
                if (!seenCols[colKey]) {
                    seenCols[colKey] = true
                    columns.push([px, pz])
                    protectedRingCols[normDim + '|' + (px >> 4) + '|' + (pz >> 4)] = tickCounter + 1200
                }
            }
        }

        ringBlockJobs.push({
            dim:                 normDim,
            x:                   cx,
            y:                   cy,
            z:                   cz,
            blockId:             blockId,
            thickness:           thickness,
            columns:             columns,
            done:                0,
            placedCols:          0,
            skippedUnloadedCols: 0,
            totalCols:           columns.length,
            onDone:              onDone
        })
        return true
    }

    function hasActiveWorldOps() {
        return fluidPurgeJobs.length > 0 || ringBlockJobs.length > 0
    }

    function pollUnloadedFluidColumns(lv, job, pOpts, startMs, maxMs, totalRef) {
        if (job.unloadedColumns.length === 0 || tickCounter > job.expireTick || (tickCounter % 10) !== 0) return
        var remainingUnloaded = []
        var nextKeys = {}
        for (var uIdx = 0; uIdx < job.unloadedColumns.length; uIdx++) {
            var uCol = job.unloadedColumns[uIdx]
            var uKey = uCol.chX + '|' + uCol.chZ
            if (totalRef.count > 0 && (Date.now() - startMs) >= maxMs) {
                for (var rIdx = uIdx; rIdx < job.unloadedColumns.length; rIdx++) {
                    var rem = job.unloadedColumns[rIdx]
                    var rKey = rem.chX + '|' + rem.chZ
                    if (!nextKeys[rKey]) {
                        nextKeys[rKey] = true
                        remainingUnloaded.push(rem)
                    }
                }
                break
            }
            if (!isChunkLoaded(lv, uCol.chX << 4, uCol.chZ << 4)) {
                if (!nextKeys[uKey]) {
                    nextKeys[uKey] = true
                    remainingUnloaded.push(uCol)
                }
                continue
            }
            totalRef.count++
            var uStatus = purgeChunkColumnFluids(lv, uCol.chX, uCol.chZ, job.x, job.y, job.z, job.rSq, job.y0, job.y1, job.useCylinder2D, pOpts)
            if (uStatus === 1) {
                job.hotColumns.push(uCol)
                job.loopsLeft = Math.max(job.loopsLeft, 1)
            }
        }
        job.unloadedColumns = remainingUnloaded
        job.unloadedKeys    = nextKeys
    }

    function tickWorldOps(budgetMs) {
        if (!hasActiveWorldOps()) return 0
        var t0Ns           = nowNano()
        var startMs        = Date.now()
        var maxMs          = (budgetMs != null && budgetMs > 0) ? budgetMs : CONFIG.worldOpsTickBudgetMs
        var totalRef       = { count: 0 }

        // 1. 优先推进球体/柱体流体剥离队列
        for (var n = fluidPurgeJobs.length - 1; n >= 0; n--) {
            var job = fluidPurgeJobs[n]
            if (job == null) { fluidPurgeJobs.splice(n, 1); continue }
            var lv = resolveLevel(job.dim, null)
            if (lv == null) { fluidPurgeJobs.splice(n, 1); continue }

            var pOpts = {
                dim:         job.dim,
                excludeLava: job.excludeLava,
                cylFloorY:   job.cylFloorY,
                rimShellRSq: job.rimShellRSq
            }
            if (job.unloadedKeys == null) job.unloadedKeys = {}

            while (job.index < job.columns.length) {
                if (totalRef.count > 0 && ((Date.now() - startMs) >= maxMs || totalRef.count >= CONFIG.worldOpsMaxColsPerTick)) {
                    var dtEarly = (nowNano() - t0Ns) / 1000000.0
                    lastWorldOpsTickMs = dtEarly
                    if (dtEarly > maxWorldOpsTickMs) maxWorldOpsTickMs = dtEarly
                    return dtEarly
                }
                var col = job.columns[job.index]
                job.index++
                totalRef.count++
                var status = purgeChunkColumnFluids(lv, col.chX, col.chZ, job.x, job.y, job.z, job.rSq, job.y0, job.y1, job.useCylinder2D, pOpts)
                if (status === 2) {
                    var uKey = col.chX + '|' + col.chZ
                    if (!job.unloadedKeys[uKey]) {
                        job.unloadedKeys[uKey] = true
                        job.unloadedColumns.push(col)
                    }
                } else if (status === 1 || col.isRim) {
                    job.hotColumns.push(col)
                }
            }

            // 即使在复扫冷却等待期间，也定期轮询刚进入玩家视距的新加载区块，防止玩家飞向坑边时看见未剥离区块水墙
            pollUnloadedFluidColumns(lv, job, pOpts, startMs, maxMs, totalRef)

            if (job.loopsLeft > 0 && (job.hotColumns.length > 0 || (job.rimColumns && job.rimColumns.length > 0))) {
                // 相位锁定复扫冷却：等待 sweepCooldown tick（如 15 tick）后再启动下一轮热点/边界复扫，
                // 避免 5 轮复扫在爆炸最初 2 秒内空转耗尽，确保全程跟随 DE 冲击波炸开海床的节奏持续截断外围回灌水幕
                if (job.sweepCooldown > 0 && tickCounter < job.nextSweepTick) {
                    continue
                }
                job.loopsLeft--
                job.columns       = job.hotColumns.length > 0 ? job.hotColumns : job.rimColumns.slice()
                job.hotColumns    = []
                job.index         = 0
                job.nextSweepTick = tickCounter + (job.sweepCooldown || 15)
                continue
            }

            if (!job.notifiedDone) {
                job.notifiedDone = true
                if (job.onDone != null) {
                    try { job.onDone(job) } catch (eDone) { logCatch('fluidPurge:onDone', eDone) }
                }
            }

            if (job.unloadedColumns.length > 0 && tickCounter <= job.expireTick) {
                if (job.unloadedColumns.length > 0 || job.hotColumns.length > 0) {
                    continue
                }
            }

            fluidPurgeJobs.splice(n, 1)
        }

        // 2. 利用剩余帧时间预算推进圆环方块浇筑队列
        for (var m = ringBlockJobs.length - 1; m >= 0; m--) {
            var rJob = ringBlockJobs[m]
            if (rJob == null) { ringBlockJobs.splice(m, 1); continue }
            var rLv = resolveLevel(rJob.dim, null)
            if (rLv == null) { ringBlockJobs.splice(m, 1); continue }

            var colBudget = CONFIG.ringBlocksPerTick
            while (colBudget > 0 && rJob.done < rJob.columns.length) {
                if (totalRef.count > 0 && (Date.now() - startMs) >= maxMs) {
                    break
                }
                var cPair = rJob.columns[rJob.done]
                rJob.done++
                colBudget--
                totalRef.count++
                var px = cPair[0]
                var pz = cPair[1]
                // 严格跳过未加载区块，绝不触发磁盘同步加载卡死主线程
                if (!isChunkLoaded(rLv, px, pz)) {
                    rJob.skippedUnloadedCols = (rJob.skippedUnloadedCols || 0) + 1
                    continue
                }
                var sy = findLoadedSurfaceY(rLv, px, pz, rJob.y, 96, 16)
                if (sy == null) continue
                rJob.placedCols = (rJob.placedCols || 0) + 1
                protectedRingCols[rJob.dim + '|' + (px >> 4) + '|' + (pz >> 4)] = tickCounter + 1200
                // 从表面上方 1 格 (sy + 1) 及表层向下浇筑：保护基岩、门框、命令方块及带 BlockEntity 的容器不被覆盖
                for (var d = -1; d < rJob.thickness - 1; d++) {
                    try {
                        var ty = sy - d
                        var b  = rLv.getBlock(px, ty, pz)
                        if (b == null) continue
                        var bid = String(b.id || '')
                        if (RING_PROTECTED_BLOCK_IDS[bid] || b.entity != null) continue
                        if (bid === 'minecraft:air' || bid === 'minecraft:cave_air' || d === 0) {
                            b.set(rJob.blockId)
                        }
                    } catch (eSetR) { }
                }
            }

            if (rJob.done >= rJob.columns.length) {
                ringBlockJobs.splice(m, 1)
                if (rJob.onDone != null) {
                    try { rJob.onDone(rJob) } catch (eRingDone) { logCatch('ringJob:onDone', eRingDone) }
                }
            }
        }

        var dtTotal = (nowNano() - t0Ns) / 1000000.0
        lastWorldOpsTickMs = dtTotal
        if (dtTotal > maxWorldOpsTickMs) maxWorldOpsTickMs = dtTotal
        return dtTotal
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
                trackedBlocks.delete(key)
                dispatchRemovedToSubscribers(rec, 'broken', null, null)
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

    if (typeof ServerEvents !== 'undefined' && ServerEvents != null && typeof ServerEvents.loaded === 'function') {
        ServerEvents.loaded(function (event) {
            try {
                if (event != null && event.server != null) SERVER_REF = event.server
                if (SERVER_REF != null) {
                    ensureLoaded()
                    absorbGlobalMigrations()
                }
            } catch (eLd) {
                logCatch('ServerEvents.loaded', eLd)
            }
        })
    }

    ServerEvents.tick(function (event) {
        try {
            if (event != null && event.server != null) SERVER_REF = event.server
            tickCounter++
            if (SERVER_REF == null) return
            // 统一帧时间预算：若存在高优地形/流体批处理任务，先执行并计算耗时；若已耗尽帧预算则本 tick 延后低优区块段扫描
            var opsSpentMs = hasActiveWorldOps() ? tickWorldOps(CONFIG.worldOpsTickBudgetMs) : 0
            if (opsSpentMs < CONFIG.worldOpsTickBudgetMs) {
                tickAllTrackedBlocks()
            }
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
                SERVER_REF         = null
                loadedPersistSrv   = null
                loadedStoragePath  = null
                loadedStorageStore = null
                persistDirty       = false
                migratedLegacyFlag = false
                trackedBlocks.clear()
                scannedSections.clear()
                resetScanQueue()
                migratedKeys.clear()
                fluidPurgeJobs.length = 0
                ringBlockJobs.length  = 0
                protectedRingCols     = {}
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
            lastEnqueueStatus:      getLastScanStatus(),
            lastTickAllMs:          lastTickAllMs,
            lastActiveTickAllMs:    lastActiveTickAllMs,
            maxTickAllMs:           maxTickAllMs,
            tickAllCount:           tickAllCount,
            lastTickAllTick:        lastTickAllTick,
            lastScanSliceMs:        lastScanSliceMs,
            maxScanSliceMs:         maxScanSliceMs,
            scanSliceCount:         scanSliceCount,
            fluidPurgeJobsCount:    fluidPurgeJobs.length,
            ringBlockJobsCount:     ringBlockJobs.length,
            lastWorldOpsTickMs:     lastWorldOpsTickMs,
            maxWorldOpsTickMs:      maxWorldOpsTickMs
        }
    }

    var trackerAndChunkApi = {
        VERSION:                      VERSION,
        CONFIG:                       CONFIG,
        configure:                    configure,
        createTracker:                createTracker,
        migrateLegacyOnce:            migrateLegacyOnce,
        rescanAll:                    rescanAll,
        getStats:                     getStats,
        getLastScanStatus:            getLastScanStatus,
        extractBlockId:               extractBlockId,
        isChunkLoaded:                isChunkLoaded,
        makePosKey:                   makePosKey,
        normalizeDim:                 normalizeDim,
        dimOfLevel:                   dimOfLevel,
        resolveLevel:                 resolveLevel,
        getLoadedChunkSections:       getLoadedChunkSections,
        purgeChunkColumnFluids:       purgeChunkColumnFluids,
        startSphereFluidPurge:        startSphereFluidPurge,
        triggerIncrementalFluidSweep: triggerIncrementalFluidSweep,
        findLoadedSurfaceY:           findLoadedSurfaceY,
        startRingBlockJob:            startRingBlockJob,
        hasActiveWorldOps:            hasActiveWorldOps,
        registerPreset:               function (name, specOrFn) { return WORLD_OPS_PRESETS.register(name, specOrFn) },
        preset:                       function (name, overrides) { return WORLD_OPS_PRESETS.resolve(name, overrides) },
        listPresets:                  function () { return WORLD_OPS_PRESETS.list() },
        removePreset:                 function (name) { return WORLD_OPS_PRESETS.remove(name) }
    }
    global.EpiphyBlockTracker = trackerAndChunkApi
    global.EpiphyChunkEngine  = trackerAndChunkApi
    global.EpiphyWorldOps     = trackerAndChunkApi

    // 动态上报扫描队列、已追踪池、地形批处理队列、getTrackedRecords 调用频次与耗时统计到 EpiphyDebug
    var trackerDebugProvider = {
        name:    'tracker',
        label:   '方块与区块组件',
        order:   20,
        summary: () => {
            var s = getStats()
            return `scanQueue.length=${s.scanQueueArrayLength} (pending=${s.pendingScanCount}) | trackedBlocks.size=${s.trackedBlocksSize} | tickAll=${s.lastTickAllMs.toFixed(3)}ms (active=${s.lastActiveTickAllMs.toFixed(3)}ms, max=${s.maxTickAllMs.toFixed(3)}ms) | getTrackedRecords=${s.getTrackedRecordsCalls}`
        },
        detail: () => {
            var s = getStats()
            return [
                `bindingsCount: ${s.bindingsCount} (version=${s.bindingsVersion})`,
                `subscribersCount: ${s.subscribersCount}`,
                `trackedBlocks.size: ${s.trackedBlocksSize}`,
                `tickAllMs: last=${s.lastTickAllMs.toFixed(3)}ms, lastActive=${s.lastActiveTickAllMs.toFixed(3)}ms, max=${s.maxTickAllMs.toFixed(3)}ms (count=${s.tickAllCount}, lastTick=${s.lastTickAllTick})`,
                `scanSliceMs: last=${s.lastScanSliceMs.toFixed(3)}ms, max=${s.maxScanSliceMs.toFixed(3)}ms (count=${s.scanSliceCount})`,
                `scannedSections.size: ${s.scannedSectionsSize} / max=${CONFIG.maxScannedSections}`,
                `scanQueue.length: ${s.scanQueueArrayLength} (head=${s.scanQueueHead}, pending=${s.pendingScanCount}, max=${CONFIG.maxScanQueue})`,
                `CONFIG: enqInterval=${CONFIG.scanEnqInterval}, perTick=${CONFIG.scanSectionsPerTick}, verifyWin=${CONFIG.verifyWindowTicks}, debounce=${CONFIG.saveDebounceTicks}`,
                `stateIdCache.size: ${s.stateIdCacheSize}`,
                `getTrackedRecordsCalls: ${s.getTrackedRecordsCalls} (perSub=${JSON.stringify(s.subscriberCalls)})`,
                `persistDirty: ${persistDirty}, storagePath: ${loadedStoragePath || '（未加载世界）'}`
            ]
        },
        metrics: getStats,
        check: () => {
            var s = getStats()
            var qOk = s.pendingScanCount < Math.floor(CONFIG.maxScanQueue * 0.85)
            var pOk = (SERVER_REF == null || loadedStoragePath != null)
            return [
                {
                    name:   'scan_queue_headroom',
                    ok:     qOk,
                    detail: `pending=${s.pendingScanCount}/${CONFIG.maxScanQueue} (arrayLen=${s.scanQueueArrayLength})`
                },
                {
                    name:   'storage_initialized',
                    ok:     pOk,
                    detail: `loadedStoragePath=${String(loadedStoragePath)}`
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
                        return {
                            code:    'queue_truncated',
                            data:    st,
                            message: '已重扫并新入队 ' + n + ' 个非空气区块段（扫描队列已满 ' + st.pending + '/' + st.cap + '，剩余区段将在消费空出后按周期补扫）'
                        }
                    }
                    if (st.blockedByQueue) {
                        return {
                            code:    'queue_full',
                            data:    st,
                            message: '扫描队列已满（' + st.pending + '/' + st.cap + ' 排队中），本次未能入队'
                        }
                    }
                    return {
                        code:    'enqueued',
                        data:    st,
                        message: '已重扫并新入队 ' + n + ' 个非空气区块段（待扫总数: ' + getPendingScanCount() + '）'
                    }
                }
            },
            flush: {
                desc: '立即将 trackedBlocks 落盘保存',
                fn: function () {
                    flushTrackedBlocks()
                    return {
                        code:    'flushed',
                        data:    { savedCount: trackedBlocks.size, storagePath: loadedStoragePath },
                        message: '已落盘 savedCount=' + trackedBlocks.size + ' -> ' + String(loadedStoragePath)
                    }
                }
            },
            resetmetrics: {
                desc: '重置 tickAll / scanSlice 峰值与累计耗时计数',
                fn: function () {
                    lastTickAllMs       = 0
                    lastActiveTickAllMs = 0
                    maxTickAllMs        = 0
                    tickAllCount        = 0
                    lastScanSliceMs     = 0
                    maxScanSliceMs      = 0
                    scanSliceCount      = 0
                    return {
                        code:    'metrics_reset',
                        data:    { tickAllCount: 0, scanSliceCount: 0 },
                        message: '已清零方块追踪器耗时统计'
                    }
                }
            }
        }
    }
    BASE.registerDebugProvider(trackerDebugProvider)
})()
