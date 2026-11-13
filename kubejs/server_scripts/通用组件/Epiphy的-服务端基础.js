// priority: 1080
// ============================================================================
// Epiphy 服务端通用基础设施 (EpiphyServerBase)
//   所属阶段：server_scripts
//   硬依赖  ：global.EpiphyProtocol, global.EpiphySpec, global.EpiphyLog
//   定位    ：收拢服务端日志包装、Java 类缓存、MC 对象访问器、存档级磁盘路径定位、
//            权限阀子命令队列与统一 OP 提醒、Debug 提供者注册、单点兜底方块追踪与命令树 DSL
//   约束    ：严格 Rhino ES5（禁止 let/const、箭头函数、模板字符串、展开运算符）
// ============================================================================

;(function () {
    'use strict';

    var proto = (typeof global !== 'undefined') ? global.EpiphyProtocol : null;
    var spec  = (typeof global !== 'undefined') ? global.EpiphySpec     : null;
    var log   = (typeof global !== 'undefined') ? global.EpiphyLog      : null;

    if (!proto) {
        throw new Error('[EpiphyServerBase] 缺少硬依赖 global.EpiphyProtocol，请确认 startup_scripts/通用组件/Epiphy的-协议常量.js 已加载');
    }
    if (!spec) {
        throw new Error('[EpiphyServerBase] 缺少硬依赖 global.EpiphySpec，请确认 startup_scripts/通用组件/Epiphy的-Spec与通用工具.js 已加载');
    }
    if (!log) {
        throw new Error('[EpiphyServerBase] 缺少硬依赖 global.EpiphyLog，请确认 server_scripts/通用组件/Epiphy的-日志.js 已加载');
    }

    var javaClassCache = {};
    var SYSTEM_CLASS = null;
    var HAS_NANO_TIME = false;
    var LEVEL_RESOURCE_ROOT = null;
    var JAVA_FILE_CLASS = null;
    var SERVER_HOOKS_CLASS = null;
    var SUGGEST_PROVIDERS_CLASS = null;

    function hasOwn(obj, key) {
        return obj != null && Object.prototype.hasOwnProperty.call(obj, key);
    }

    function loadJavaClass(className, logger) {
        if (!className) return null;
        var key = String(className);
        if (hasOwn(javaClassCache, key)) {
            return javaClassCache[key] === FAILED_CLASS ? null : javaClassCache[key];
        }
        if (typeof Java === 'undefined' || Java == null || typeof Java.loadClass !== 'function') {
            javaClassCache[key] = FAILED_CLASS;
            return null;
        }
        try {
            var cls = Java.loadClass(key);
            javaClassCache[key] = cls || FAILED_CLASS;
            return cls || null;
        } catch (e) {
            javaClassCache[key] = FAILED_CLASS;
            if (logger && typeof logger.catchWarn === 'function') {
                logger.catchWarn('loadJavaClass:' + key, e);
            }
            return null;
        }
    }

    var FAILED_CLASS = { __epiphyLoadFailed: true };

    (function initCapabilities() {
        SYSTEM_CLASS = loadJavaClass('java.lang.System');
        HAS_NANO_TIME = Boolean(SYSTEM_CLASS && typeof SYSTEM_CLASS.nanoTime === 'function');
        JAVA_FILE_CLASS = loadJavaClass('java.io.File');
        SERVER_HOOKS_CLASS = loadJavaClass('net.minecraftforge.server.ServerLifecycleHooks');
        SUGGEST_PROVIDERS_CLASS = loadJavaClass('net.minecraft.commands.synchronization.SuggestionProviders');
        var lr = loadJavaClass('net.minecraft.world.level.storage.LevelResource');
        if (lr && lr.ROOT != null) {
            LEVEL_RESOURCE_ROOT = lr.ROOT;
        }
    })();

    var baseLogger = createLogger('EpiphyServerBase', 5000);

    function createLogger(moduleName, defaultIntervalMs) {
        var mod = String(moduleName || 'Epiphy');
        var defMs = (defaultIntervalMs != null && defaultIntervalMs > 0) ? defaultIntervalMs : 5000;
        var localCatches = 0;
        return {
            warn: function (tag, msg, notifyPlayer, intervalMs) {
                return log.warn(mod, tag, msg, notifyPlayer || null, intervalMs != null ? intervalMs : defMs);
            },
            catchWarn: function (tag, err, notifyPlayer, intervalMs) {
                localCatches++;
                return log.catchWarn(mod, tag, err, notifyPlayer || null, intervalMs != null ? intervalMs : defMs);
            },
            getCatchCount: function () {
                return localCatches;
            }
        };
    }

    function nowNano() {
        if (HAS_NANO_TIME) {
            return Number(SYSTEM_CLASS.nanoTime());
        }
        return Date.now() * 1000000;
    }

    function resolveServer(preferServer) {
        if (preferServer != null) return preferServer;
        if (typeof Utils !== 'undefined' && Utils != null && Utils.server != null) {
            return Utils.server;
        }
        if (SERVER_HOOKS_CLASS != null && typeof SERVER_HOOKS_CLASS.getCurrentServer === 'function') {
            return SERVER_HOOKS_CLASS.getCurrentServer();
        }
        return null;
    }

    function toJsArray(raw) {
        if (raw == null) return [];
        if (Array.isArray(raw)) return raw;
        var out = [];
        if (spec.isArrayLike(raw)) {
            for (var i = 0; i < raw.length; i++) out.push(raw[i]);
            return out;
        }
        if (typeof raw.iterator === 'function') {
            var it = raw.iterator();
            while (it.hasNext()) out.push(it.next());
            return out;
        }
        if (typeof raw.size === 'function' && typeof raw.get === 'function') {
            var n = Number(raw.size());
            for (var j = 0; j < n; j++) out.push(raw.get(j));
            return out;
        }
        return out;
    }

    function toSeqArray(raw) {
        if (raw == null) return null;
        if (Array.isArray(raw)) return raw;
        if (spec.isArrayLike(raw)) {
            var outA = [];
            for (var i = 0; i < raw.length; i++) outA.push(raw[i]);
            return outA;
        }
        if (typeof raw.iterator === 'function') {
            var outI = [];
            var it = raw.iterator();
            while (it.hasNext()) outI.push(it.next());
            return outI;
        }
        if (typeof raw.size === 'function' && typeof raw.get === 'function') {
            var outL = [];
            var sz = Number(raw.size());
            for (var j = 0; j < sz; j++) outL.push(raw.get(j));
            return outL;
        }
        return null;
    }

    function readMapField(obj, key) {
        if (obj == null) return null;
        if (typeof obj === 'object' && obj[key] !== undefined) {
            return obj[key];
        }
        if (typeof obj.get === 'function') {
            return obj.get(key);
        }
        return null;
    }

    function uuidOf(obj) {
        if (obj == null) return null;
        if (typeof obj.getStringUUID === 'function') return String(obj.getStringUUID());
        if (obj.stringUuid != null) return String(obj.stringUuid);
        if (obj.uuid != null) return String(obj.uuid);
        if (typeof obj.getUUID === 'function') {
            var u = obj.getUUID();
            if (u != null) return String(u);
        }
        if (typeof obj.getUuid === 'function') {
            var u2 = obj.getUuid();
            if (u2 != null) return String(u2);
        }
        if (typeof obj.getProfile === 'function') {
            var prof = obj.getProfile();
            if (prof != null && typeof prof.getId === 'function' && prof.getId() != null) {
                return String(prof.getId());
            }
        }
        if (obj.id != null && typeof obj.id === 'string') return obj.id;
        return null;
    }

    function nameOf(obj) {
        if (obj == null) return null;
        if (typeof obj.getProfile === 'function') {
            var p = obj.getProfile();
            if (p != null && typeof p.getName === 'function' && p.getName() != null) return String(p.getName());
        }
        if (typeof obj.getGameProfile === 'function') {
            var gp = obj.getGameProfile();
            if (gp != null && typeof gp.getName === 'function' && gp.getName() != null) return String(gp.getName());
        }
        if (obj.username != null) return String(obj.username);
        if (typeof obj.getName === 'function') {
            var n = obj.getName();
            if (n != null && typeof n.getString === 'function') return String(n.getString());
            if (n != null) return String(n);
        }
        if (obj.name != null) return String(obj.name);
        return null;
    }

    function entityIdOf(obj) {
        if (obj == null) return null;
        if (typeof obj.getId === 'function') return Number(obj.getId());
        if (obj.id != null && isFinite(Number(obj.id))) return Number(obj.id);
        return uuidOf(obj);
    }

    function dimOfLevel(lv) {
        if (lv == null) return null;
        if (typeof lv.getDimension === 'function') {
            var gd = lv.getDimension();
            if (gd != null) return spec.normalizeDim(String(gd));
        }
        if (typeof lv.dimension === 'function') return spec.normalizeDim(lv.dimension());
        if (lv.dimension != null) return spec.normalizeDim(lv.dimension);
        if (typeof lv.getLevel === 'function') {
            var inner = lv.getLevel();
            if (inner != null && inner !== lv) return dimOfLevel(inner);
        }
        return null;
    }

    function resolveLevel(levelOrDim, preferServer) {
        if (levelOrDim != null && typeof levelOrDim === 'object'
            && (typeof levelOrDim.getBlock === 'function' || levelOrDim.players != null)) {
            return levelOrDim;
        }
        var srv = resolveServer(preferServer);
        if (srv == null) return null;
        var targetDim = spec.normalizeDim(levelOrDim) || 'minecraft:overworld';
        if (typeof srv.getLevel === 'function') {
            var direct = srv.getLevel(targetDim);
            if (direct != null) return direct;
        }
        if (typeof srv.getAllLevels === 'function') {
            var all = toJsArray(srv.getAllLevels());
            for (var i = 0; i < all.length; i++) {
                if (dimOfLevel(all[i]) === targetDim) return all[i];
            }
        }
        return null;
    }

    function readPos(obj) {
        if (obj == null) return null;
        if (spec.isArrayLike(obj) && obj.length >= 3) {
            if (obj[0] == null || obj[1] == null || obj[2] == null) return null;
            var ax = Number(obj[0]), ay = Number(obj[1]), az = Number(obj[2]);
            return (isFinite(ax) && isFinite(ay) && isFinite(az)) ? { x: ax, y: ay, z: az } : null;
        }
        if (typeof obj.getX === 'function') {
            var gx = Number(obj.getX()), gy = Number(obj.getY()), gz = Number(obj.getZ());
            return (isFinite(gx) && isFinite(gy) && isFinite(gz)) ? { x: gx, y: gy, z: gz } : null;
        }
        if (obj.pos != null && typeof obj.pos === 'object') {
            return readPos(obj.pos);
        }
        if (obj.block != null && obj.block !== obj) {
            return readPos(obj.block);
        }
        if (typeof obj.x === 'function') {
            var fx = Number(obj.x()), fy = Number(obj.y()), fz = Number(obj.z());
            return (isFinite(fx) && isFinite(fy) && isFinite(fz)) ? { x: fx, y: fy, z: fz } : null;
        }
        if (obj.x != null && obj.y != null && obj.z != null && obj.x !== '' && obj.y !== '' && obj.z !== '') {
            var nx = Number(obj.x), ny = Number(obj.y), nz = Number(obj.z);
            return (isFinite(nx) && isFinite(ny) && isFinite(nz)) ? { x: nx, y: ny, z: nz } : null;
        }
        return null;
    }

    function vecToArray(v) {
        var p = readPos(v);
        if (p == null) return null;
        if (!isFinite(p.x) || !isFinite(p.y) || !isFinite(p.z)) return null;
        return [p.x, p.y, p.z];
    }

    function makePosKey(dim, x, y, z) {
        return (spec.normalizeDim(dim) || 'minecraft:overworld') + '|' + Math.floor(x) + ',' + Math.floor(y) + ',' + Math.floor(z);
    }

    function extractBlockId(blockOrState) {
        if (blockOrState == null) return null;
        if (blockOrState.id != null) return String(blockOrState.id);
        if (typeof blockOrState.getId === 'function') return String(blockOrState.getId());
        if (typeof blockOrState.getBlock === 'function') {
            var blk = blockOrState.getBlock();
            if (blk != null) {
                if (blk.id != null) return String(blk.id);
                if (typeof blk.getId === 'function') return String(blk.getId());
            }
        }
        return null;
    }

    function isChunkLoaded(lv, bx, bz) {
        if (lv == null) return false;
        var cx = bx >> 4;
        var cz = bz >> 4;
        if (typeof lv.getChunkSource === 'function') {
            var cs = lv.getChunkSource();
            if (cs != null && typeof cs.getChunkNow === 'function') {
                return cs.getChunkNow(cx, cz) != null;
            }
        }
        if (typeof lv.hasChunk === 'function') {
            return Boolean(lv.hasChunk(cx, cz));
        }
        return false;
    }

    function resolveWorldStorageInfo(server, worldFileName, fallbackDir) {
        var srv = resolveServer(server);
        var fileName = String(worldFileName || 'kubejs_epiphy_store.json');
        var fbDir = String(fallbackDir || 'kubejs/config/epiphy_store');
        var worldName = 'world';

        if (srv != null) {
            var wd = (typeof srv.getWorldData === 'function') ? srv.getWorldData() : srv.worldData;
            if (wd != null) {
                var ln = (typeof wd.getLevelName === 'function') ? wd.getLevelName() : wd.levelName;
                if (ln != null && String(ln).trim() !== '') worldName = String(ln).trim();
            }
        }

        if (srv != null && LEVEL_RESOURCE_ROOT != null && typeof srv.getWorldPath === 'function') {
            try {
                var rootPath = srv.getWorldPath(LEVEL_RESOURCE_ROOT);
                if (rootPath != null) {
                    var normRoot = (typeof rootPath.toAbsolutePath === 'function')
                        ? rootPath.toAbsolutePath().normalize()
                        : ((typeof rootPath.normalize === 'function') ? rootPath.normalize() : rootPath);
                    var resolved = (typeof normRoot.resolve === 'function')
                        ? normRoot.resolve(fileName).normalize()
                        : (String(normRoot).replace(/[\\/]+$/, '') + '/' + fileName);
                    var fileStr = String(resolved).replace(/\\/g, '/');
                    return {
                        worldKey:    'path:' + fileStr.toLowerCase(),
                        worldName:   worldName,
                        filePath:    fileStr,
                        isWorldRoot: true
                    };
                }
            } catch (ePath) {
                baseLogger.catchWarn('resolveWorldStorageInfo:getWorldPath', ePath);
            }
        }

        var slug = worldName.replace(/[<>:"/\\|?*\x00-\x1F]+/g, '_').trim() || 'world';
        return {
            worldKey:    'slug:' + slug.toLowerCase(),
            worldName:   worldName,
            filePath:    fbDir + '/' + slug + '.json',
            isWorldRoot: false
        };
    }

    function ensureParentDir(filePathStr, logger) {
        if (!filePathStr || JAVA_FILE_CLASS == null) return false;
        try {
            var f = new JAVA_FILE_CLASS(String(filePathStr));
            var parent = f.getParentFile();
            if (parent != null && !parent.exists()) {
                return Boolean(parent.mkdirs());
            }
            return true;
        } catch (e) {
            (logger || baseLogger).catchWarn('ensureParentDir', e);
            return false;
        }
    }

    // ========================================================================
    // 统一模块注册基础设施（Debug 提供者 & 权限阀子命令 + 单点 OP 失联提醒）
    // ========================================================================
    function registerDebugProvider(providerObj) {
        if (!providerObj || !providerObj.name) return false;
        if (typeof global !== 'undefined' && global.EpiphyDebug != null && typeof global.EpiphyDebug.registerProvider === 'function') {
            return Boolean(global.EpiphyDebug.registerProvider(providerObj));
        }
        if (typeof global !== 'undefined') {
            if (!Array.isArray(global.EpiphyDebugProviderQueue)) {
                global.EpiphyDebugProviderQueue = [];
            }
            for (var i = 0; i < global.EpiphyDebugProviderQueue.length; i++) {
                if (global.EpiphyDebugProviderQueue[i] && global.EpiphyDebugProviderQueue[i].name === providerObj.name) {
                    global.EpiphyDebugProviderQueue[i] = providerObj;
                    return true;
                }
            }
            global.EpiphyDebugProviderQueue.push(providerObj);
            return true;
        }
        return false;
    }

    var watchedSubcommands = [];
    var valveWarnedLogged = false;

    function isValveReady() {
        return Boolean(typeof global !== 'undefined' && global.EpiphyPermissionValve != null
            && typeof global.EpiphyPermissionValve.registerSubcommand === 'function');
    }

    function flushOrQueueSubcommand(subSpec) {
        if (isValveReady()) {
            return Boolean(global.EpiphyPermissionValve.registerSubcommand(subSpec));
        }
        if (typeof global === 'undefined') return false;
        if (!Array.isArray(global.EpiphyCommandRegistryQueue)) {
            global.EpiphyCommandRegistryQueue = [];
        }
        var q = global.EpiphyCommandRegistryQueue;
        for (var i = 0; i < q.length; i++) {
            if (q[i] && q[i].name === subSpec.name) {
                q[i] = subSpec;
                return false;
            }
        }
        q.push(subSpec);
        return false;
    }

    function checkSubcommandRegistrations(server, optPlayer) {
        if (watchedSubcommands.length === 0) return true;
        if (isValveReady()) {
            var q = (typeof global !== 'undefined' && Array.isArray(global.EpiphyCommandRegistryQueue))
                ? global.EpiphyCommandRegistryQueue : null;
            if (q && q.length > 0) {
                for (var i = 0; i < q.length; i++) {
                    if (q[i]) global.EpiphyPermissionValve.registerSubcommand(q[i]);
                }
                q.length = 0;
            }
            return true;
        }
        var missingNames = [];
        for (var w = 0; w < watchedSubcommands.length; w++) {
            if (watchedSubcommands[w].requireValve) {
                missingNames.push('/epiphy ' + watchedSubcommands[w].name);
            }
        }
        if (missingNames.length === 0) return true;

        var msg = '未检测到 EpiphyPermissionValve (Epiphy的-权限阀.js)，以下子命令未挂载: ' + missingNames.join(', ');
        if (!valveWarnedLogged) {
            valveWarnedLogged = true;
            baseLogger.warn('permissionValve', msg);
        }
        if (optPlayer != null && typeof optPlayer.hasPermissions === 'function' && optPlayer.hasPermissions(2)) {
            if (typeof optPlayer.tell === 'function') {
                var comp = (typeof Text !== 'undefined' && Text != null && typeof Text.of === 'function')
                    ? Text.of('§c[Epiphy] ' + msg) : ('[Epiphy] ' + msg);
                optPlayer.tell(comp);
            }
        }
        return false;
    }

    function registerSubcommandSafe(subSpec, opts) {
        if (!subSpec || !subSpec.name) return false;
        var requireValve = !(opts && opts.requirePermissionValve === false);
        var found = false;
        for (var i = 0; i < watchedSubcommands.length; i++) {
            if (watchedSubcommands[i].name === subSpec.name) {
                watchedSubcommands[i].requireValve = requireValve;
                found = true;
                break;
            }
        }
        if (!found) {
            watchedSubcommands.push({ name: subSpec.name, requireValve: requireValve });
        }
        return flushOrQueueSubcommand(subSpec);
    }

    if (typeof PlayerEvents !== 'undefined' && PlayerEvents != null && typeof PlayerEvents.loggedIn === 'function') {
        PlayerEvents.loggedIn(function (event) {
            if (event == null || event.player == null) return;
            checkSubcommandRegistrations(event.server || resolveServer(null), event.player);
        });
    }

    // ========================================================================
    // 单点共享方块追踪获取与最小化兜底（若无 EpiphyBlockTracker，仅挂一次 BlockEvents）
    // ========================================================================
    var fallbackHooksInstalled = false;
    var fallbackSubscribers = new Map();
    var fallbackTracked = new Map(); // posKey -> { key, blockId, dim, x, y, z, extras }
    var fallbackTickCounter = 0;

    function makeFallbackView(rec, sub) {
        var extras = rec.extras || (rec.extras = {});
        if (extras[sub.id] === undefined && sub.makeRecordExtra) {
            extras[sub.id] = sub.makeRecordExtra(rec.blockId, rec.dim, rec.x, rec.y, rec.z);
        }
        var builtExtra = extras[sub.id];
        var view = {
            key:     rec.key,
            blockId: rec.blockId,
            dim:     rec.dim,
            x:       rec.x,
            y:       rec.y,
            z:       rec.z,
            extra:   builtExtra !== undefined ? builtExtra : null
        };
        if (builtExtra != null && typeof builtExtra === 'object') {
            for (var ek in builtExtra) {
                if (hasOwn(builtExtra, ek) && !hasOwn(view, ek)) {
                    view[ek] = builtExtra[ek];
                }
            }
        }
        return view;
    }

    function ensureFallbackBlockHooks() {
        if (fallbackHooksInstalled) return;
        fallbackHooksInstalled = true;
        if (typeof BlockEvents === 'undefined' || BlockEvents == null) return;

        if (typeof BlockEvents.placed === 'function') {
            BlockEvents.placed(function (event) {
                if (fallbackSubscribers.size === 0) return;
                try {
                    if (event == null || event.block == null) return;
                    var bid = extractBlockId(event.block);
                    if (!bid) return;
                    var pos = readPos(event.block);
                    var dim = dimOfLevel(event.level) || 'minecraft:overworld';
                    if (!pos) return;
                    var ix = Math.floor(pos.x);
                    var iy = Math.floor(pos.y);
                    var iz = Math.floor(pos.z);
                    var key = makePosKey(dim, ix, iy, iz);
                    var rec = null;

                    fallbackSubscribers.forEach(function (sub) {
                        var meta = sub.bindings.get(bid);
                        if (meta == null) return;
                        if (rec == null) {
                            rec = fallbackTracked.get(key);
                            if (rec == null) {
                                rec = { key: key, blockId: bid, dim: dim, x: ix, y: iy, z: iz, extras: {} };
                                fallbackTracked.set(key, rec);
                            }
                        }
                        if (sub.onFound) {
                            try {
                                sub.onFound(makeFallbackView(rec, sub), meta, 'fallback_placed');
                            } catch (eF) {
                                baseLogger.catchWarn('fallbackTracker:' + sub.id + ':onFound', eF);
                            }
                        }
                    });
                } catch (ePlaced) {
                    baseLogger.catchWarn('fallbackTracker:placed', ePlaced);
                }
            });
        }

        if (typeof BlockEvents.broken === 'function') {
            BlockEvents.broken(function (event) {
                if (fallbackSubscribers.size === 0) return;
                try {
                    if (event == null || event.block == null) return;
                    var pos = readPos(event.block);
                    var dim = dimOfLevel(event.level) || 'minecraft:overworld';
                    if (!pos) return;
                    var ix = Math.floor(pos.x);
                    var iy = Math.floor(pos.y);
                    var iz = Math.floor(pos.z);
                    var key = makePosKey(dim, ix, iy, iz);
                    var bid = extractBlockId(event.block);
                    var rec = fallbackTracked.get(key);

                    fallbackSubscribers.forEach(function (sub) {
                        var targetBid = rec ? rec.blockId : bid;
                        var meta = targetBid ? sub.bindings.get(targetBid) : null;
                        if (rec != null && meta != null) {
                            if (sub.onRemoved) {
                                try {
                                    sub.onRemoved(makeFallbackView(rec, sub), meta, 'broken', event.player || null);
                                } catch (eR) {
                                    baseLogger.catchWarn('fallbackTracker:' + sub.id + ':onRemoved', eR);
                                }
                            }
                        } else if (sub.onBrokenUnregistered && bid) {
                            try {
                                sub.onBrokenUnregistered(dim, ix, iy, iz, bid, 'fallback_broken');
                            } catch (eU) {
                                baseLogger.catchWarn('fallbackTracker:' + sub.id + ':onBrokenUnregistered', eU);
                            }
                        }
                    });
                    if (rec != null) fallbackTracked.delete(key);
                } catch (eBroken) {
                    baseLogger.catchWarn('fallbackTracker:broken', eBroken);
                }
            });
        }

        if (typeof ServerEvents !== 'undefined' && ServerEvents != null && typeof ServerEvents.tick === 'function') {
            ServerEvents.tick(function (event) {
                fallbackTickCounter++;
                if (fallbackSubscribers.size === 0 || fallbackTracked.size === 0) return;
                var srv = (event != null && event.server != null) ? event.server : resolveServer(null);
                if (srv == null) return;
                fallbackSubscribers.forEach(function (sub) {
                    if (sub == null || sub.destroyed || !sub.onTick) return;
                    if (fallbackTickCounter < sub.maintainOffset) return;
                    if (((fallbackTickCounter - sub.maintainOffset) % sub.maintainInterval) !== 0) return;
                    fallbackTracked.forEach(function (rec) {
                        if (rec == null) return;
                        var meta = sub.bindings.get(rec.blockId);
                        if (meta == null) return;
                        var lv = resolveLevel(rec.dim, srv);
                        try {
                            sub.onTick(makeFallbackView(rec, sub), meta, fallbackTickCounter, lv, null);
                        } catch (eTick) {
                            baseLogger.catchWarn('fallbackTracker:' + sub.id + ':onTick', eTick);
                        }
                    });
                });
            });
        }
    }

    function createFallbackTrackerInstance(cfg) {
        ensureFallbackBlockHooks();
        var subId = String((cfg && cfg.name) || ('fb_' + fallbackSubscribers.size));
        var rawInterval = (cfg && cfg.maintainInterval != null) ? Math.floor(Number(cfg.maintainInterval)) : 1;
        var rawOffset = (cfg && cfg.maintainOffset != null) ? Math.floor(Number(cfg.maintainOffset)) : 0;
        var sub = {
            id:                   subId,
            maintainInterval:     (isFinite(rawInterval) && rawInterval > 0) ? rawInterval : 1,
            maintainOffset:       (isFinite(rawOffset) && rawOffset >= 0) ? rawOffset : 0,
            makeRecordExtra:      (cfg && typeof cfg.makeRecordExtra === 'function') ? cfg.makeRecordExtra : null,
            onFound:              (cfg && typeof cfg.onFound === 'function') ? cfg.onFound : null,
            onTick:               (cfg && typeof cfg.onTick === 'function') ? cfg.onTick : null,
            onRemoved:            (cfg && typeof cfg.onRemoved === 'function') ? cfg.onRemoved : null,
            onBrokenUnregistered: (cfg && typeof cfg.onBrokenUnregistered === 'function') ? cfg.onBrokenUnregistered : null,
            onBindingChanged:     (cfg && typeof cfg.onBindingChanged === 'function') ? cfg.onBindingChanged : null,
            bindings:             new Map(),
            destroyed:            false
        };
        fallbackSubscribers.set(subId, sub);

        function unbind(blockId, extraArg) {
            if (!blockId) return 0;
            var idStr = String(blockId).trim();
            if (!sub.bindings.has(idStr)) return 0;
            var prevMeta = sub.bindings.get(idStr);
            var removed = 0;
            var keys = Array.from(fallbackTracked.keys());
            for (var i = 0; i < keys.length; i++) {
                var rec = fallbackTracked.get(keys[i]);
                if (rec != null && rec.blockId === idStr) {
                    if (sub.onRemoved) {
                        try {
                            sub.onRemoved(makeFallbackView(rec, sub), prevMeta, 'unbind', extraArg);
                        } catch (eR) {
                            baseLogger.catchWarn('fallbackTracker:' + subId + ':unbind', eR);
                        }
                    }
                    delete rec.extras[subId];
                    removed++;
                }
            }
            sub.bindings.delete(idStr);
            if (sub.onBindingChanged) {
                try { sub.onBindingChanged(idStr, null, prevMeta); } catch (eC) { baseLogger.catchWarn(subId + ':onBindingChanged', eC); }
            }
            return removed;
        }

        function destroy() {
            if (sub.destroyed) return;
            sub.destroyed = true;
            var bids = Array.from(sub.bindings.keys());
            for (var i = 0; i < bids.length; i++) unbind(bids[i], null);
            fallbackSubscribers.delete(subId);
        }

        return {
            name:       subId,
            isFallback: true,
            bind: function (blockId, meta) {
                if (sub.destroyed || !blockId || meta == null) return false;
                var idStr = String(blockId).trim();
                var prevMeta = sub.bindings.get(idStr);
                sub.bindings.set(idStr, meta);
                if (sub.onBindingChanged) {
                    try { sub.onBindingChanged(idStr, meta, prevMeta); } catch (eC) { baseLogger.catchWarn(subId + ':onBindingChanged', eC); }
                }
                return true;
            },
            unbind: unbind,
            scanNow: function () {
                return 0;
            },
            hasBinding: function (blockId) {
                return sub.bindings.has(String(blockId || '').trim());
            },
            getBinding: function (blockId) {
                return sub.bindings.get(String(blockId || '').trim());
            },
            getBindingCount: function () {
                return sub.bindings.size;
            },
            getTrackedRecords: function (blockIdOpt) {
                var out = [];
                var filterBid = blockIdOpt != null ? String(blockIdOpt).trim() : null;
                fallbackTracked.forEach(function (rec) {
                    if (rec == null) return;
                    if (filterBid != null && rec.blockId !== filterBid) return;
                    if (sub.bindings.has(rec.blockId)) out.push(rec);
                });
                return out;
            },
            destroy: destroy
        };
    }

    function acquireBlockTracker(trackerCfg) {
        var api = (typeof global !== 'undefined') ? global.EpiphyBlockTracker : null;
        if (api != null && typeof api.createTracker === 'function') {
            var real = api.createTracker(trackerCfg);
            if (real && real.isFallback === undefined) {
                real.isFallback = false;
            }
            return real;
        }
        baseLogger.warn('blockTracker', '未检测到 EpiphyBlockTracker，[' + String((trackerCfg && trackerCfg.name) || 'tracker') + '] 降级为实时事件追踪');
        return createFallbackTrackerInstance(trackerCfg);
    }

    // ========================================================================
    // Brigadier 命令树可读性 DSL (createCommandBuilder)
    //   说明：减少重复 Commands.argument / getResult / guardExecution / sendSuccess 样板，
    //        保持自底向上构树顺序，安全适配 KubeJS Arguments 与测试沙盒。
    // ========================================================================
    var ARG_TYPE_MAP = {
        players:   'PLAYERS',
        player:    'PLAYER',
        entity:    'ENTITY',
        entities:  'ENTITIES',
        word:      'WORD',
        string:    'STRING',
        greedy:    'GREEDY_STRING',
        'int':     'INTEGER',
        'double':  'DOUBLE',
        'float':   'FLOAT',
        dimension: 'DIMENSION',
        dim:       'DIMENSION',
        vec3:      'VEC3',
        id:        'RESOURCE_LOCATION',
        sound:     'RESOURCE_LOCATION'
    };

    function createCommandBuilder(regCtx, builderOpts) {
        var event     = regCtx.event;
        var Commands  = regCtx.Commands;
        var Arguments = regCtx.Arguments;
        var defPolicy = regCtx.policy;
        var canSeeFn  = regCtx.canSee;
        var guardFn   = regCtx.guardExecution;
        var tag       = (builderOpts && builderOpts.tag) ? String(builderOpts.tag) : '';

        function resolveSource(target) {
            if (target == null) return null;
            return target.source != null ? target.source : target;
        }

        function sendText(target, msg) {
            var src = resolveSource(target);
            if (src == null) return;
            var s = String(msg);
            var comp = (typeof Text !== 'undefined' && Text != null && typeof Text.of === 'function') ? Text.of(s) : s;
            if (typeof src.sendSuccess === 'function') {
                src.sendSuccess(comp, false);
            } else if (typeof src.tell === 'function') {
                src.tell(comp);
            }
        }

        function sendLines(target, lines) {
            if (!lines) return 1;
            for (var i = 0; i < lines.length; i++) {
                sendText(target, lines[i]);
            }
            return 1;
        }

        function replyOk(target, msg) {
            var s = String(msg);
            if (s.charAt(0) !== '§' && tag) s = '§a[' + tag + '] ' + s;
            else if (s.charAt(0) !== '§') s = '§a' + s;
            sendText(target, s);
            return 1;
        }

        function replyErr(target, msg) {
            var s = String(msg);
            if (s.charAt(0) !== '§' && tag) s = '§c[' + tag + ' 错误] ' + s;
            else if (s.charAt(0) !== '§') s = '§c' + s;
            sendText(target, s);
            return 0;
        }

        function guard(policyOrFn, maybeFn) {
            if (typeof guardFn === 'function') {
                return (maybeFn !== undefined)
                    ? guardFn(policyOrFn, maybeFn)
                    : guardFn(policyOrFn);
            }
            return maybeFn !== undefined ? maybeFn : policyOrFn;
        }

        function resolveArgObj(typeName) {
            var mapped = ARG_TYPE_MAP[typeName] || String(typeName || 'WORD').toUpperCase();
            if (Arguments != null && Arguments[mapped] != null) return Arguments[mapped];
            if (typeName === 'sound' && Arguments != null && Arguments.WORD != null) return Arguments.WORD;
            return null;
        }

        function extractArg(ctx, argSpec) {
            var argObj = resolveArgObj(argSpec.type);
            if (argObj == null || typeof argObj.getResult !== 'function') return null;
            var raw = argObj.getResult(ctx, argSpec.name);
            if (argSpec.type === 'word' || argSpec.type === 'string' || argSpec.type === 'greedy'
                || argSpec.type === 'sound' || argSpec.type === 'id') {
                return raw != null ? String(raw) : null;
            }
            if (argSpec.type === 'players' || argSpec.type === 'entities') {
                return toJsArray(raw);
            }
            if (argSpec.type === 'dimension' || argSpec.type === 'dim') {
                return dimOfLevel(raw);
            }
            if (argSpec.type === 'vec3') {
                return vecToArray(raw);
            }
            return raw;
        }

        function readArg(ctx, name, typeName) {
            return extractArg(ctx, { name: name, type: typeName || 'word' });
        }

        function makeArgNode(argSpec) {
            var argObj = resolveArgObj(argSpec.type);
            if (argObj == null) {
                throw new Error('[EpiphyCommandBuilder] 未知或不可用的参数类型: ' + String(argSpec.type));
            }
            var node = Commands.argument(argSpec.name, argObj.create(event));
            var suggester = argSpec.suggests;
            if (!suggester && (argSpec.type === 'sound' || argSpec.suggest === 'sounds')) {
                suggester = SUGGEST_PROVIDERS_CLASS && SUGGEST_PROVIDERS_CLASS.AVAILABLE_SOUNDS;
            }
            if (suggester != null && typeof node.suggests === 'function') {
                node = node.suggests(suggester);
            }
            return node;
        }

        function wrapDepthExec(argSpecs, depth, handler, policy) {
            var fn = function (ctx) {
                var vals = { _count: depth };
                for (var k = 0; k < depth; k++) {
                    vals[argSpecs[k].name] = extractArg(ctx, argSpecs[k]);
                }
                return handler(ctx, vals);
            };
            return policy ? guard(policy, fn) : guard(fn);
        }

        function buildArgChain(argSpecs, handler, opts) {
            if (!argSpecs || argSpecs.length === 0) return null;
            var minArgs = (opts && opts.minArgs != null) ? opts.minArgs : argSpecs.length;
            var policy = (opts && opts.policy !== undefined) ? opts.policy : undefined;
            var childNode = null;

            for (var i = argSpecs.length - 1; i >= 0; i--) {
                var node = makeArgNode(argSpecs[i]);
                if (i + 1 >= minArgs) {
                    node = node.executes(wrapDepthExec(argSpecs, i + 1, handler, policy));
                }
                if (childNode != null) {
                    node = node.then(childNode);
                }
                childNode = node;
            }
            return childNode;
        }

        function attachChain(parentNode, argSpecs, handler, opts) {
            var minArgs = (opts && opts.minArgs != null) ? opts.minArgs : (argSpecs ? argSpecs.length : 0);
            var policy = (opts && opts.policy !== undefined) ? opts.policy : undefined;
            if (minArgs <= 0) {
                parentNode = parentNode.executes(wrapDepthExec(argSpecs || [], 0, handler, policy));
            }
            var chainHead = buildArgChain(argSpecs, handler, opts);
            if (chainHead != null) {
                parentNode = parentNode.then(chainHead);
            }
            return parentNode;
        }

        function literal(name, cfgOrFn) {
            var node = Commands.literal(name);
            if (typeof cfgOrFn === 'function') {
                return node.executes(guard(cfgOrFn));
            }
            var cfg = cfgOrFn || {};
            if (cfg.policy !== undefined && typeof canSeeFn === 'function' && typeof node.requires === 'function') {
                var reqPolicy = cfg.policy;
                node = node.requires(function (src) { return canSeeFn(src, reqPolicy); });
            } else if (defPolicy !== undefined && cfg.inheritRequires && typeof canSeeFn === 'function' && typeof node.requires === 'function') {
                node = node.requires(function (src) { return canSeeFn(src, defPolicy); });
            }
            if (typeof cfg.exec === 'function') {
                node = node.executes(cfg.policy !== undefined ? guard(cfg.policy, cfg.exec) : guard(cfg.exec));
            } else if (cfg.helpLines) {
                var lines = cfg.helpLines;
                var helpExec = function (ctx) { return sendLines(ctx, lines); };
                node = node.executes(cfg.policy !== undefined ? guard(cfg.policy, helpExec) : guard(helpExec));
            }
            if (cfg.chain) {
                node = attachChain(node, cfg.chain[0], cfg.chain[1], cfg.chain[2]);
            }
            if (cfg.chains) {
                for (var c = 0; c < cfg.chains.length; c++) {
                    var ch = cfg.chains[c];
                    node = attachChain(node, ch[0], ch[1], ch[2]);
                }
            }
            if (cfg.children) {
                for (var i = 0; i < cfg.children.length; i++) {
                    if (cfg.children[i] != null) {
                        node = node.then(cfg.children[i]);
                    }
                }
            }
            return node;
        }

        function arg(argSpec, cfgOrFn) {
            var node = makeArgNode(argSpec);
            if (typeof cfgOrFn === 'function') {
                return node.executes(wrapDepthExec([argSpec], 1, cfgOrFn, undefined));
            }
            var cfg = cfgOrFn || {};
            if (typeof cfg.exec === 'function') {
                node = node.executes(wrapDepthExec([argSpec], 1, cfg.exec, cfg.policy));
            }
            if (cfg.chain) {
                node = attachChain(node, cfg.chain[0], cfg.chain[1], cfg.chain[2]);
            }
            if (cfg.chains) {
                for (var c = 0; c < cfg.chains.length; c++) {
                    var ch = cfg.chains[c];
                    node = attachChain(node, ch[0], ch[1], ch[2]);
                }
            }
            if (cfg.children) {
                for (var i = 0; i < cfg.children.length; i++) {
                    if (cfg.children[i] != null) node = node.then(cfg.children[i]);
                }
            }
            return node;
        }

        return {
            guard:       guard,
            sendText:    sendText,
            sendLines:   sendLines,
            replyOk:     replyOk,
            replyErr:    replyErr,
            readArg:     readArg,
            arg:         arg,
            literal:     literal,
            chain:       buildArgChain,
            attachChain: attachChain
        };
    }

    if (typeof global !== 'undefined') {
        global.EpiphyServerBase = {
            createLogger:                 createLogger,
            loadJavaClass:                loadJavaClass,
            nowNano:                      nowNano,
            resolveServer:                resolveServer,
            toJsArray:                    toJsArray,
            toSeqArray:                   toSeqArray,
            readMapField:                 readMapField,
            uuidOf:                       uuidOf,
            nameOf:                       nameOf,
            entityIdOf:                   entityIdOf,
            dimOfLevel:                   dimOfLevel,
            resolveLevel:                 resolveLevel,
            readPos:                      readPos,
            vecToArray:                   vecToArray,
            makePosKey:                   makePosKey,
            extractBlockId:               extractBlockId,
            isChunkLoaded:                isChunkLoaded,
            resolveWorldStorageInfo:      resolveWorldStorageInfo,
            ensureParentDir:              ensureParentDir,
            registerDebugProvider:        registerDebugProvider,
            registerSubcommandSafe:       registerSubcommandSafe,
            checkSubcommandRegistrations: checkSubcommandRegistrations,
            isValveReady:                 isValveReady,
            acquireBlockTracker:          acquireBlockTracker,
            createCommandBuilder:         createCommandBuilder
        };
    }
})();
