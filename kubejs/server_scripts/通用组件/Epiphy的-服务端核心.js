// priority: 1080
// ============================================================================
// Epiphy 服务端核心与世界工具 (EpiphyServerCore / EpiphyServerBase v2.4)
//   许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
//   放置位置：kubejs/server_scripts/通用组件/Epiphy的-服务端核心.js
//   所属阶段：server_scripts
//   可选依赖：
//     - global.EpiphySpec (Epiphy的-Spec与通用工具.js)：缺失时维度/数组工具自动使用内置精简降级实现
//     - global.EpiphyLog (Epiphy的-日志.js)：缺失时自动降级为基础 console 限频日志，不阻断服务端模块加载
//   定位    ：收拢服务端日志包装与降级、Java 类缓存、MC 对象访问器（`resolveLevel` 无效维度 fail-closed 拒绝回落主世界）、
//            世界/实体/玩家高频工具（范围玩家与实体遍历、主副手/背包/Curios 安全物品与遗物检索、免指令消息/状态栏/粒子/音效工具）、
//            外部统一数据根 `epiphy-data/`（config/worlds/players/events/logs/presets/backups）、`.tmp`+`.bak` 原子读写、
//            KubeJS ClassFilter 兼容路径（`KubeJSPaths.dir` + `JsonIO.readString` + `worlds_index.json` + Rhino `NativeJavaMap` 防护）、
//            `lastWorldPath` 复制档自动分叉与世界专属 `logs/` 运行日志目录切换、权限阀子命令队列与统一 OP 提醒、Debug 注册与命令树 DSL
//   向下兼容：同时挂载 `global.EpiphyServerCore` 与 `global.EpiphyServerBase`
//   语法规范：遵循 README-LLM.md §1 强制语法基准（与 docs/kube-mods-rhino-es5-es6-compatibility.md）
// ============================================================================

;(function () {
    'use strict';

    var spec = (typeof global !== 'undefined' && global.EpiphySpec != null) ? global.EpiphySpec : null;
    if (!spec) {
        try {
            console.warn('[EpiphyServerBase] 未检测到 global.EpiphySpec (Epiphy的-Spec与通用工具.js)，维度归一化与类数组判断将启用内置降级。');
        } catch (eSpecWarn) { }
    }

    function safeTypeOf(x) {
        if (spec && typeof spec.safeTypeOf === 'function') return spec.safeTypeOf(x);
        if (x === null) return 'object';
        if (x === undefined) return 'undefined';
        try {
            return typeof x;
        } catch (e) {
            return 'object';
        }
    }

    function isObjectLike(x) {
        if (spec && typeof spec.isObjectLike === 'function') return spec.isObjectLike(x);
        return x != null && safeTypeOf(x) === 'object';
    }

    function isJavaMapLike(x) {
        if (spec && typeof spec.isJavaMapLike === 'function') return spec.isJavaMapLike(x);
        if (!isObjectLike(x)) return false;
        try {
            return typeof x.entrySet === 'function' || typeof x.containsKey === 'function' || typeof x.put === 'function';
        } catch (e) {
            return false;
        }
    }

    function safeReadProp(obj, prop) {
        if (obj == null) return undefined;
        try {
            return obj[prop];
        } catch (e) {
            return undefined;
        }
    }

    function safeHasMethod(obj, prop) {
        if (obj == null) return false;
        try {
            return safeTypeOf(obj[prop]) === 'function';
        } catch (e) {
            return false;
        }
    }

    function isArrayLike(x) {
        if (spec && typeof spec.isArrayLike === 'function') return spec.isArrayLike(x);
        if (x == null) return false;
        if (Array.isArray(x)) return true;
        if (!isObjectLike(x)) return false;
        try {
            var len = x.length;
            return typeof len === 'number' && len >= 0 && isFinite(len) && Math.floor(len) === len;
        } catch (e) {
            return false;
        }
    }

    function normalizeDim(dimOrKey) {
        if (spec && typeof spec.normalizeDim === 'function') return spec.normalizeDim(dimOrKey);
        if (dimOrKey == null) return null;
        var s = String(dimOrKey).trim();
        if (!s) return null;
        var slashIdx = s.lastIndexOf('/');
        if (slashIdx >= 0 && s.charAt(s.length - 1) === ']') {
            s = s.slice(slashIdx + 1, -1).trim();
        }
        return s.indexOf(':') >= 0 ? s : ('minecraft:' + s);
    }

    var javaClassCache = {};
    var SYSTEM_CLASS = null;
    var HAS_NANO_TIME = false;
    var LEVEL_RESOURCE_ROOT = null;
    var JAVA_FILE_CLASS = null;
    var JAVA_FILES_CLASS = null;
    var JAVA_PATHS_CLASS = null;
    var JAVA_CHARSET_UTF8 = null;
    var JAVA_COPY_OPT_CLASS = null;
    var JAVA_UUID_CLASS = null;
    var KUBEJS_PATHS_CLASS = null;
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
        KUBEJS_PATHS_CLASS = loadJavaClass('dev.latvian.mods.kubejs.KubeJSPaths');
        JAVA_FILE_CLASS = loadJavaClass('java.io.File');
        JAVA_FILES_CLASS = loadJavaClass('java.nio.file.Files');
        JAVA_PATHS_CLASS = loadJavaClass('java.nio.file.Paths');
        var stdCs = loadJavaClass('java.nio.charset.StandardCharsets');
        var utf8 = safeReadProp(stdCs, 'UTF_8');
        if (utf8 != null) JAVA_CHARSET_UTF8 = utf8;
        JAVA_COPY_OPT_CLASS = loadJavaClass('java.nio.file.StandardCopyOption');
        JAVA_UUID_CLASS = loadJavaClass('java.util.UUID');
        SERVER_HOOKS_CLASS = loadJavaClass('net.minecraftforge.server.ServerLifecycleHooks');
        SUGGEST_PROVIDERS_CLASS = loadJavaClass('net.minecraft.commands.synchronization.SuggestionProviders');
        var lr = loadJavaClass('net.minecraft.world.level.storage.LevelResource');
        var lrRoot = safeReadProp(lr, 'ROOT');
        if (lrRoot != null) {
            LEVEL_RESOURCE_ROOT = lrRoot;
        }
    })();

    var fallbackLogBuckets = {};
    var fallbackOnceKeys = {};
    var missingLogWarned = false;

    function resolveEpiphyLog() {
        return (typeof global !== 'undefined' && global.EpiphyLog != null) ? global.EpiphyLog : null;
    }

    function emitFallbackConsole(level, text) {
        try {
            if (level === 'error') console.error(text);
            else if (level === 'info' || level === 'debug') console.info(text);
            else console.warn(text);
        } catch (e) { }
    }

    function fallbackRateLog(level, mod, tag, msg, notifyPlayer, intervalMs) {
        if (!missingLogWarned) {
            missingLogWarned = true;
            emitFallbackConsole('warn', '[EpiphyServerBase] 未检测到 Epiphy的-日志.js (EpiphyLog)，日志已自动降级为内置 console 限频输出。');
        }
        var bKey = mod + '|' + level + '|' + tag;
        var bucket = fallbackLogBuckets[bKey] || (fallbackLogBuckets[bKey] = { lastAt: 0, suppressed: 0 });
        var iv = (intervalMs != null && isFinite(intervalMs) && intervalMs >= 0) ? intervalMs : 5000;
        var now = Date.now();
        if (iv === 0 || (now - bucket.lastAt) >= iv) {
            var tail = bucket.suppressed > 0 ? (' (另有 ' + bucket.suppressed + ' 次同类日志被折叠)') : '';
            bucket.lastAt = now;
            bucket.suppressed = 0;
            emitFallbackConsole(level, '[' + mod + ' ' + tag + '] ' + String(msg) + tail);
        } else {
            bucket.suppressed++;
        }
        if (notifyPlayer != null && typeof notifyPlayer.tell === 'function') {
            try { notifyPlayer.tell('§c[' + mod + ' ' + tag + '] ' + String(msg)); } catch (eTell) { }
        }
        return null;
    }

    var baseLogger = createLogger('EpiphyServerBase', 5000);

    function createLogger(moduleName, defaultIntervalMs) {
        var mod = String(moduleName || 'Epiphy');
        var defMs = (defaultIntervalMs != null && defaultIntervalMs > 0) ? defaultIntervalMs : 5000;
        var localCatches = 0;
        return {
            warn: function (tag, msg, notifyPlayer, intervalMs) {
                var logApi = resolveEpiphyLog();
                var iv = intervalMs != null ? intervalMs : defMs;
                if (logApi && typeof logApi.warn === 'function') {
                    return logApi.warn(mod, tag, msg, notifyPlayer || null, iv);
                }
                return fallbackRateLog('warn', mod, String(tag || 'general'), msg, notifyPlayer, iv);
            },
            error: function (tag, msg, notifyPlayer, intervalMs) {
                var logApi = resolveEpiphyLog();
                var iv = intervalMs != null ? intervalMs : defMs;
                if (logApi && typeof logApi.error === 'function') {
                    return logApi.error(mod, tag, msg, notifyPlayer || null, iv);
                }
                return fallbackRateLog('error', mod, String(tag || 'general'), msg, notifyPlayer, iv);
            },
            catchWarn: function (tag, err, notifyPlayer, intervalMs) {
                localCatches++;
                var logApi = resolveEpiphyLog();
                var iv = intervalMs != null ? intervalMs : defMs;
                if (logApi && typeof logApi.catchWarn === 'function') {
                    return logApi.catchWarn(mod, tag, err, notifyPlayer || null, iv);
                }
                return fallbackRateLog('warn', mod, '异常:' + String(tag || 'unknown'), String(err), notifyPlayer, iv);
            },
            once: function (level, key, msg) {
                var logApi = resolveEpiphyLog();
                if (logApi && typeof logApi.once === 'function') {
                    return logApi.once(level, key, msg);
                }
                var k = String(key || 'default');
                if (fallbackOnceKeys[k]) return false;
                fallbackOnceKeys[k] = true;
                emitFallbackConsole(level || 'warn', String(msg));
                return true;
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
        if (isArrayLike(raw)) {
            for (var i = 0; i < raw.length; i++) out.push(raw[i]);
            return out;
        }
        if (safeHasMethod(raw, 'iterator')) {
            try {
                var it = raw.iterator();
                while (it.hasNext()) out.push(it.next());
                return out;
            } catch (eIt) { }
        }
        if (!isJavaMapLike(raw) && safeHasMethod(raw, 'size') && safeHasMethod(raw, 'get')) {
            try {
                var n = Number(raw.size());
                for (var j = 0; j < n; j++) out.push(raw.get(j));
                return out;
            } catch (eSz) { }
        }
        return out;
    }

    function toSeqArray(raw) {
        if (raw == null) return null;
        if (Array.isArray(raw)) return raw;
        if (isArrayLike(raw)) {
            var outA = [];
            for (var i = 0; i < raw.length; i++) outA.push(raw[i]);
            return outA;
        }
        if (safeHasMethod(raw, 'iterator')) {
            try {
                var outI = [];
                var it = raw.iterator();
                while (it.hasNext()) outI.push(it.next());
                return outI;
            } catch (eIt) { }
        }
        if (!isJavaMapLike(raw) && safeHasMethod(raw, 'size') && safeHasMethod(raw, 'get')) {
            try {
                var outL = [];
                var sz = Number(raw.size());
                for (var j = 0; j < sz; j++) outL.push(raw.get(j));
                return outL;
            } catch (eSz) { }
        }
        return null;
    }

    function readMapField(obj, key) {
        if (obj == null) return null;
        if (safeHasMethod(obj, 'get')) {
            try {
                if (safeHasMethod(obj, 'containsKey')) {
                    return obj.containsKey(key) ? obj.get(key) : null;
                }
                if (safeHasMethod(obj, 'has')) {
                    return obj.has(key) ? obj.get(key) : null;
                }
                var got = obj.get(key);
                if (got !== undefined && got !== null) return got;
            } catch (eGet) { }
        }
        if (isObjectLike(obj)) {
            var propVal = safeReadProp(obj, key);
            if (propVal !== undefined) return propVal;
        }
        return null;
    }

    function uuidOf(obj) {
        if (obj == null) return null;
        if (safeHasMethod(obj, 'getStringUUID')) {
            try { return String(obj.getStringUUID()); } catch (e0) { }
        }
        var su = safeReadProp(obj, 'stringUuid');
        if (su != null) return String(su);
        var uu = safeReadProp(obj, 'uuid');
        if (uu != null) return String(uu);
        if (safeHasMethod(obj, 'getUUID')) {
            try {
                var u = obj.getUUID();
                if (u != null) return String(u);
            } catch (e1) { }
        }
        if (safeHasMethod(obj, 'getUuid')) {
            try {
                var u2 = obj.getUuid();
                if (u2 != null) return String(u2);
            } catch (e2) { }
        }
        if (safeHasMethod(obj, 'getProfile')) {
            try {
                var prof = obj.getProfile();
                if (prof != null && safeHasMethod(prof, 'getId') && prof.getId() != null) {
                    return String(prof.getId());
                }
            } catch (e3) { }
        }
        var idVal = safeReadProp(obj, 'id');
        if (idVal != null && safeTypeOf(idVal) === 'string') return idVal;
        return null;
    }

    function nameOf(obj) {
        if (obj == null) return null;
        if (safeHasMethod(obj, 'getProfile')) {
            try {
                var p = obj.getProfile();
                if (p != null && safeHasMethod(p, 'getName') && p.getName() != null) return String(p.getName());
            } catch (e0) { }
        }
        if (safeHasMethod(obj, 'getGameProfile')) {
            try {
                var gp = obj.getGameProfile();
                if (gp != null && safeHasMethod(gp, 'getName') && gp.getName() != null) return String(gp.getName());
            } catch (e1) { }
        }
        var uname = safeReadProp(obj, 'username');
        if (uname != null) return String(uname);
        if (safeHasMethod(obj, 'getName')) {
            try {
                var n = obj.getName();
                if (n != null && safeHasMethod(n, 'getString')) return String(n.getString());
                if (n != null) return String(n);
            } catch (e2) { }
        }
        var nameProp = safeReadProp(obj, 'name');
        if (nameProp != null) return String(nameProp);
        return null;
    }

    function entityIdOf(obj) {
        if (obj == null) return null;
        if (safeHasMethod(obj, 'getId')) {
            try { return Number(obj.getId()); } catch (e0) { }
        }
        var idProp = safeReadProp(obj, 'id');
        if (idProp != null && isFinite(Number(idProp))) return Number(idProp);
        return uuidOf(obj);
    }

    function dimOfLevel(lv) {
        if (lv == null) return null;
        if (safeHasMethod(lv, 'getDimension')) {
            try {
                var gd = lv.getDimension();
                if (gd != null) return normalizeDim(String(gd));
            } catch (e0) { }
        }
        if (safeHasMethod(lv, 'dimension')) {
            try { return normalizeDim(lv.dimension()); } catch (e1) { }
        }
        var dimProp = safeReadProp(lv, 'dimension');
        if (dimProp != null) return normalizeDim(dimProp);
        if (safeHasMethod(lv, 'getLevel')) {
            try {
                var inner = lv.getLevel();
                if (inner != null && inner !== lv) return dimOfLevel(inner);
            } catch (e2) { }
        }
        return null;
    }

    function resolveLevel(levelOrDim, preferServer) {
        if (levelOrDim == null || levelOrDim === '') return null;
        if (isObjectLike(levelOrDim)
            && (safeHasMethod(levelOrDim, 'getBlock') || safeReadProp(levelOrDim, 'players') != null)) {
            return levelOrDim;
        }
        var srv = resolveServer(preferServer);
        if (srv == null) return null;
        var targetDim = normalizeDim(levelOrDim);
        if (!targetDim) return null;
        if (safeHasMethod(srv, 'getLevel')) {
            try {
                var direct = srv.getLevel(targetDim);
                if (direct != null) return direct;
            } catch (e0) { }
        }
        if (safeHasMethod(srv, 'getAllLevels')) {
            try {
                var all = toJsArray(srv.getAllLevels());
                for (var i = 0; i < all.length; i++) {
                    if (dimOfLevel(all[i]) === targetDim) return all[i];
                }
            } catch (e1) { }
        }
        return null;
    }

    function readPos(obj) {
        if (obj == null) return null;
        if (isArrayLike(obj) && obj.length >= 3) {
            if (obj[0] == null || obj[1] == null || obj[2] == null) return null;
            var ax = Number(obj[0]), ay = Number(obj[1]), az = Number(obj[2]);
            return (isFinite(ax) && isFinite(ay) && isFinite(az)) ? { x: ax, y: ay, z: az } : null;
        }
        if (safeHasMethod(obj, 'getX')) {
            try {
                var gx = Number(obj.getX()), gy = Number(obj.getY()), gz = Number(obj.getZ());
                return (isFinite(gx) && isFinite(gy) && isFinite(gz)) ? { x: gx, y: gy, z: gz } : null;
            } catch (e0) { }
        }
        var posProp = safeReadProp(obj, 'pos');
        if (isObjectLike(posProp)) {
            return readPos(posProp);
        }
        var blkProp = safeReadProp(obj, 'block');
        if (blkProp != null && blkProp !== obj) {
            return readPos(blkProp);
        }
        if (safeHasMethod(obj, 'x')) {
            try {
                var fx = Number(obj.x()), fy = Number(obj.y()), fz = Number(obj.z());
                return (isFinite(fx) && isFinite(fy) && isFinite(fz)) ? { x: fx, y: fy, z: fz } : null;
            } catch (e1) { }
        }
        var px = safeReadProp(obj, 'x');
        var py = safeReadProp(obj, 'y');
        var pz = safeReadProp(obj, 'z');
        if (px != null && py != null && pz != null && px !== '' && py !== '' && pz !== '') {
            var nx = Number(px), ny = Number(py), nz = Number(pz);
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
        return (normalizeDim(dim) || 'minecraft:overworld') + '|' + Math.floor(x) + ',' + Math.floor(y) + ',' + Math.floor(z);
    }

    function extractBlockId(blockOrState) {
        if (blockOrState == null) return null;
        var bidProp = safeReadProp(blockOrState, 'id');
        if (bidProp != null) return String(bidProp);
        if (safeHasMethod(blockOrState, 'getId')) {
            try { return String(blockOrState.getId()); } catch (e0) { }
        }
        if (safeHasMethod(blockOrState, 'getBlock')) {
            try {
                var blk = blockOrState.getBlock();
                if (blk != null) {
                    var innerId = safeReadProp(blk, 'id');
                    if (innerId != null) return String(innerId);
                    if (safeHasMethod(blk, 'getId')) return String(blk.getId());
                }
            } catch (e1) { }
        }
        return null;
    }

    function isChunkLoaded(lv, bx, bz) {
        if (lv == null) return false;
        var cx = bx >> 4;
        var cz = bz >> 4;
        if (typeof lv.getChunkSource === 'function') {
            var cs = lv.getChunkSource();
            if (cs != null && typeof cs.getChunkNow === 'function' && cs.getChunkNow(cx, cz) != null) {
                return true;
            }
        }
        if (typeof lv.hasChunk === 'function') {
            return Boolean(lv.hasChunk(cx, cz));
        }
        return false;
    }

    // ========================================================================
    // 实体 / 玩家 / 背包与 Curios 安全物品检索 / 免指令世界广播工具
    // ========================================================================
    var AABB_CLASS       = loadJavaClass('net.minecraft.world.phys.AABB', true);
    var CURIOS_API_CLASS = loadJavaClass('top.theillusivec4.curios.api.CuriosApi', true);

    function isCreativePlayer(player) {
        if (player == null) return false;
        try {
            if (typeof player.isCreative === 'function') return Boolean(player.isCreative());
            var cr = safeReadProp(player, 'creative');
            if (cr != null && typeof cr !== 'function') return Boolean(cr);
        } catch (e0) { }
        try {
            var ab = safeReadProp(player, 'abilities');
            if (ab != null) {
                var ib = safeReadProp(ab, 'instabuild');
                if (ib != null) return Boolean(ib);
            }
        } catch (e1) { }
        return false;
    }

    function isSpectatorPlayer(player) {
        if (player == null) return false;
        try {
            if (typeof player.isSpectator === 'function') return Boolean(player.isSpectator());
            var sp = safeReadProp(player, 'spectator');
            if (sp != null && typeof sp !== 'function') return Boolean(sp);
        } catch (e0) { }
        return false;
    }

    function extractItemStackId(stack) {
        if (stack == null) return '';
        try {
            if (typeof stack.isEmpty === 'function' && Boolean(stack.isEmpty())) return '';
            if (safeReadProp(stack, 'empty') === true) return '';
        } catch (eEmpty) { }
        var idProp = safeReadProp(stack, 'id');
        if (idProp != null && String(idProp) !== '') return String(idProp);
        if (safeHasMethod(stack, 'getId')) {
            try {
                var gid = stack.getId();
                if (gid != null) return String(gid);
            } catch (eGid) { }
        }
        return '';
    }

    function isHoldingMainHand(player, itemId) {
        if (player == null || !itemId) return false;
        var target = String(itemId).trim();
        if (!target) return false;
        var hasMainHandAccessor = false;
        try {
            var mh = safeReadProp(player, 'mainHandItem');
            if (mh == null && safeHasMethod(player, 'getMainHandItem')) mh = player.getMainHandItem();
            if (mh != null) {
                hasMainHandAccessor = true;
                var mhId = extractItemStackId(mh);
                return mhId === target;
            }
        } catch (eMh) { }
        // 实机环境若已成功读取主手槽位（即使主手为空），直接返回 false，绝不回退到可能包含副手的 player.isHolding
        if (hasMainHandAccessor) return false;
        // 仅针对未提供 mainHandItem / getMainHandItem 的极简单元测试桩回退
        try {
            var oh = safeReadProp(player, 'offHandItem');
            if (oh == null && safeHasMethod(player, 'getOffHandItem')) oh = player.getOffHandItem();
            if (oh != null && extractItemStackId(oh) === target) {
                return false;
            }
            if (typeof player.isHolding === 'function') return Boolean(player.isHolding(target));
        } catch (eHold) { }
        return false;
    }

    // 严格按候选列表优先级检索玩家携带的物品 ID（绝不回退到 String(player.nbt) 全量字符串匹配，彻底杜绝铁砧改名/书与笔伪造漏洞）：
    //   opts.mainHandOnly : true 时仅检查主手
    //   opts.checkHands   : 默认 true（检查主副手）
    //   opts.checkInventory: 默认 true（检查原版背包槽位）
    //   opts.checkCurios  : 默认 true（通过 CuriosApi 检查饰品槽真实 ItemStack.id）
    //   opts.skipCreative : true 时创造模式玩家直接返回 null
    function findPlayerItem(player, candidateIds, opts) {
        if (player == null || candidateIds == null) return null;
        var options = isObjectLike(opts) ? opts : {};
        if (options.skipCreative && isCreativePlayer(player)) return null;

        var ids = Array.isArray(candidateIds) ? candidateIds : [String(candidateIds)];
        if (ids.length === 0) return null;

        if (options.mainHandOnly) {
            for (var m = 0; m < ids.length; m++) {
                if (isHoldingMainHand(player, ids[m])) return ids[m];
            }
            return null;
        }

        var foundSet = {};
        var targetSet = {};
        for (var ti = 0; ti < ids.length; ti++) {
            var tid = String(ids[ti] || '').trim();
            if (tid) targetSet[tid] = true;
        }

        // 1. 检查主手与副手
        if (options.checkHands !== false) {
            try {
                var mainStack = safeReadProp(player, 'mainHandItem');
                if (mainStack == null && safeHasMethod(player, 'getMainHandItem')) mainStack = player.getMainHandItem();
                var mainId = extractItemStackId(mainStack);
                if (mainId && targetSet[mainId]) foundSet[mainId] = true;

                var offStack = safeReadProp(player, 'offHandItem');
                if (offStack == null && safeHasMethod(player, 'getOffHandItem')) offStack = player.getOffHandItem();
                var offId = extractItemStackId(offStack);
                if (offId && targetSet[offId]) foundSet[offId] = true;
            } catch (eH) { }
            if (typeof player.isHolding === 'function') {
                for (var h = 0; h < ids.length; h++) {
                    var hid = ids[h];
                    if (!foundSet[hid]) {
                        try {
                            if (Boolean(player.isHolding(hid))) foundSet[hid] = true;
                        } catch (eHold2) { }
                    }
                }
            }
        }

        if (foundSet[ids[0]]) return ids[0];

        // 2. 检查原版背包槽位（仅检查真实槽位物品 ID，不序列化物品 NBT 文本）
        if (options.checkInventory !== false) {
            try {
                var inv = safeReadProp(player, 'inventory');
                if (inv == null && safeHasMethod(player, 'getInventory')) inv = player.getInventory();
                if (inv != null) {
                    if (typeof inv.find === 'function') {
                        for (var k = 0; k < ids.length; k++) {
                            var kid = ids[k];
                            if (!foundSet[kid] && Number(inv.find(kid)) >= 0) {
                                foundSet[kid] = true;
                            }
                        }
                    } else if (safeHasMethod(inv, 'getContainerSize') && safeHasMethod(inv, 'getItem')) {
                        var invSize = Number(inv.getContainerSize());
                        for (var si = 0; si < invSize; si++) {
                            var st = inv.getItem(si);
                            var stId = extractItemStackId(st);
                            if (stId && targetSet[stId]) foundSet[stId] = true;
                        }
                    }
                }
            } catch (eInv) { }
        }

        if (foundSet[ids[0]]) return ids[0];

        // 3. 检查 Curios 饰品栏（仅读取槽位 ItemStack.id）
        if (options.checkCurios !== false && CURIOS_API_CLASS != null && safeHasMethod(CURIOS_API_CLASS, 'getCuriosInventory')) {
            try {
                var opt = CURIOS_API_CLASS.getCuriosInventory(player);
                if (opt != null && typeof opt.isPresent === 'function' && Boolean(opt.isPresent())) {
                    var handler = opt.resolve().get();
                    var stacksMap = handler.getCurios();
                    var iter = stacksMap.values().iterator();
                    while (iter.hasNext()) {
                        var stacksHandler = iter.next();
                        var dynStacks = stacksHandler.getStacks();
                        var slots = Number(dynStacks.getSlots());
                        for (var s = 0; s < slots; s++) {
                            var cStack = dynStacks.getStackInSlot(s);
                            var cId = extractItemStackId(cStack);
                            if (cId && targetSet[cId]) foundSet[cId] = true;
                        }
                    }
                }
            } catch (eCur) { }
        }

        for (var pIdx = 0; pIdx < ids.length; pIdx++) {
            if (foundSet[ids[pIdx]]) return ids[pIdx];
        }
        return null;
    }

    function forEachPlayerNear(level, x, y, z, radius, callback) {
        if (level == null || typeof callback !== 'function') return 0;
        var cx = Number(x), cy = Number(y), cz = Number(z), r = Number(radius);
        if (!isFinite(cx) || !isFinite(cy) || !isFinite(cz) || !isFinite(r) || r < 0) return 0;
        var d2 = r * r;
        var rawPlayers = safeReadProp(level, 'players');
        if (rawPlayers == null && safeHasMethod(level, 'getPlayers')) {
            try { rawPlayers = level.getPlayers(); } catch (eP) { }
        }
        if (rawPlayers == null) return 0;
        var isJavaList = !Array.isArray(rawPlayers) && safeHasMethod(rawPlayers, 'size') && safeHasMethod(rawPlayers, 'get');
        var list = (Array.isArray(rawPlayers) || isJavaList) ? rawPlayers : toSeqArray(rawPlayers);
        var len = isJavaList ? Number(list.size()) : (list.length || 0);
        var hitCount = 0;
        for (var i = 0; i < len; i++) {
            var p = isJavaList ? list.get(i) : list[i];
            var pos = readPos(p);
            if (pos == null) continue;
            var dx = pos.x - cx;
            var dy = pos.y - cy;
            var dz = pos.z - cz;
            var distSq = dx * dx + dy * dy + dz * dz;
            if (isFinite(distSq) && distSq <= d2) {
                hitCount++;
                callback(p, distSq, pos);
            }
        }
        return hitCount;
    }

    function hasPlayerNear(level, x, y, z, radius) {
        if (level == null) return false;
        var cx = Number(x), cy = Number(y), cz = Number(z), r = Number(radius);
        if (!isFinite(cx) || !isFinite(cy) || !isFinite(cz) || !isFinite(r) || r < 0) return false;
        var d2 = r * r;
        var rawPlayers = safeReadProp(level, 'players');
        if (rawPlayers == null && safeHasMethod(level, 'getPlayers')) {
            try { rawPlayers = level.getPlayers(); } catch (eP) { }
        }
        if (rawPlayers == null) return false;
        var isJavaList = !Array.isArray(rawPlayers) && safeHasMethod(rawPlayers, 'size') && safeHasMethod(rawPlayers, 'get');
        var list = (Array.isArray(rawPlayers) || isJavaList) ? rawPlayers : toSeqArray(rawPlayers);
        var len = isJavaList ? Number(list.size()) : (list.length || 0);
        for (var i = 0; i < len; i++) {
            var pos = readPos(isJavaList ? list.get(i) : list[i]);
            if (pos == null) continue;
            var dx = pos.x - cx;
            var dy = pos.y - cy;
            var dz = pos.z - cz;
            var distSq = dx * dx + dy * dy + dz * dz;
            if (isFinite(distSq) && distSq <= d2) return true;
        }
        return false;
    }

    function forEachEntityNear(level, x, y, z, radius, filterFn, callback) {
        if (level == null || typeof callback !== 'function') return 0;
        var cx = Number(x), cy = Number(y), cz = Number(z), r = Number(radius);
        if (!isFinite(cx) || !isFinite(cy) || !isFinite(cz) || !isFinite(r) || r < 0) return 0;
        var d2 = r * r;
        var count = 0;
        if (AABB_CLASS != null && safeHasMethod(level, 'getEntitiesWithin')) {
            try {
                var box = new AABB_CLASS(cx - r, cy - r, cz - r, cx + r, cy + r, cz + r);
                var ents = toSeqArray(level.getEntitiesWithin(box));
                for (var i = 0; i < ents.length; i++) {
                    var ent = ents[i];
                    if (ent == null) continue;
                    if (typeof filterFn === 'function' && !filterFn(ent)) continue;
                    var pos = readPos(ent);
                    var distSq = 0;
                    if (pos != null) {
                        var dx = pos.x - cx, dy = pos.y - cy, dz = pos.z - cz;
                        distSq = dx * dx + dy * dy + dz * dz;
                        if (distSq > d2) continue;
                    } else if (safeHasMethod(ent, 'getDistance')) {
                        var dist = Number(ent.getDistance(cx, cy, cz));
                        if (isFinite(dist) && dist > r) continue;
                        distSq = dist * dist;
                    }
                    count++;
                    callback(ent, distSq, pos);
                }
                return count;
            } catch (eBox) { }
        }
        return forEachPlayerNear(level, cx, cy, cz, r, function (p, distSq, pos) {
            if (typeof filterFn === 'function' && !filterFn(p)) return;
            count++;
            callback(p, distSq, pos);
        });
    }

    var JSON_LEGACY_COLOR_MAP = {
        dark_red: '§4', red: '§c', gold: '§6', yellow: '§e',
        green: '§a', dark_green: '§2', aqua: '§b', dark_aqua: '§3',
        blue: '§9', light_purple: '§d', dark_purple: '§5',
        white: '§f', gray: '§7', dark_gray: '§8', black: '§0'
    };

    function formatChatPayloadToString(msgOrJson) {
        if (msgOrJson == null) return '';
        if (typeof msgOrJson === 'string') {
            var trimmed = msgOrJson.trim();
            if (trimmed.charAt(0) === '{' && trimmed.charAt(trimmed.length - 1) === '}') {
                try {
                    var parsed = JSON.parse(trimmed);
                    if (parsed != null && typeof parsed === 'object') {
                        var prefix = '';
                        if (parsed.color && JSON_LEGACY_COLOR_MAP[parsed.color]) prefix += JSON_LEGACY_COLOR_MAP[parsed.color];
                        if (parsed.bold) prefix += '§l';
                        if (parsed.italic) prefix += '§o';
                        if (parsed.underlined) prefix += '§n';
                        return prefix + String(parsed.text != null ? parsed.text : '');
                    }
                } catch (eJson) { }
            }
            return msgOrJson;
        }
        if (isObjectLike(msgOrJson) && msgOrJson.text != null) {
            var pfx = '';
            if (msgOrJson.color && JSON_LEGACY_COLOR_MAP[msgOrJson.color]) pfx += JSON_LEGACY_COLOR_MAP[msgOrJson.color];
            if (msgOrJson.bold) pfx += '§l';
            if (msgOrJson.italic) pfx += '§o';
            return pfx + String(msgOrJson.text);
        }
        return String(msgOrJson);
    }

    function tellPlayerSafe(player, msgOrJson) {
        if (player == null || msgOrJson == null) return false;
        var formatted = formatChatPayloadToString(msgOrJson);
        if (!formatted) return false;
        try {
            if (typeof player.tell === 'function') {
                var payload = (typeof Text !== 'undefined' && Text != null && typeof Text.of === 'function')
                    ? Text.of(formatted)
                    : formatted;
                player.tell(payload);
                return true;
            }
        } catch (eTell) { }
        try {
            if (typeof player.sendSystemMessage === 'function') {
                var comp = (typeof Text !== 'undefined' && Text != null && typeof Text.of === 'function')
                    ? Text.of(formatted)
                    : formatted;
                player.sendSystemMessage(comp);
                return true;
            }
        } catch (eSys) { }
        return false;
    }

    function tellNear(level, x, y, z, radius, msgOrLines) {
        if (level == null || msgOrLines == null) return 0;
        var lines = Array.isArray(msgOrLines) ? msgOrLines : [msgOrLines];
        return forEachPlayerNear(level, x, y, z, radius, function (p) {
            for (var i = 0; i < lines.length; i++) {
                if (lines[i] != null) tellPlayerSafe(p, lines[i]);
            }
        });
    }

    function actionBarNear(level, x, y, z, radius, text) {
        if (level == null || text == null) return 0;
        var formatted = formatChatPayloadToString(text);
        return forEachPlayerNear(level, x, y, z, radius, function (p) {
            try {
                p.statusMessage = formatted;
            } catch (eAb) { }
        });
    }

    function spawnParticlesSafe(level, particleTypeOrId, x, y, z, dx, dy, dz, count, speed) {
        if (level == null || particleTypeOrId == null) return false;
        try {
            if (typeof level.spawnParticles === 'function') {
                level.spawnParticles(particleTypeOrId, true, x, y, z, dx, dy, dz, count, speed);
                return true;
            }
        } catch (ePart) { }
        return false;
    }

    // 用于须随存档状态同步回滚的世界内文件（如方块追踪、退出 HP 修复）；抗回滚权限与外部日志走 resolveEpiphyWorldContext (epiphy-data/)
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
                    var normStr = String(normRoot);
                    var resolved = (normStr && normStr !== '[object Object]' && normStr.indexOf('undefined') !== 0)
                        ? (normStr.replace(/\\/g, '/').replace(/(?:\/+\.)*\/*$/, '') + '/' + fileName)
                        : ((typeof normRoot.resolve === 'function')
                            ? String(normRoot.resolve(fileName).normalize()).replace(/\\/g, '/')
                            : (normStr.replace(/[\\/]+$/, '') + '/' + fileName));
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
        if (!filePathStr) return false;
        var norm = String(filePathStr).replace(/\\/g, '/');
        var slashIdx = norm.lastIndexOf('/');
        if (slashIdx > 0 && safeHasMethod(KUBEJS_PATHS_CLASS, 'dir')) {
            try {
                var parentDir = norm.slice(0, slashIdx);
                if (parentDir && KUBEJS_PATHS_CLASS.dir(parentDir) != null) {
                    return true;
                }
            } catch (eKj) { }
        }
        if (JAVA_FILE_CLASS == null) return false;
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
    // 统一外置数据根目录 (epiphy-data/) 与世界防串档/防回滚基础设施
    // ========================================================================
    var EPIPHY_DATA_SUBDIRS = ['config', 'worlds', 'players', 'events', 'logs', 'presets', 'backups'];
    var epiphyDataRootOverride = null;
    var worldContextCache = {};
    var pendingWorldForkNotices = [];
    var lastWorldForkNotice = null;
    var loggingInitialized = false;

    function normalizeSlashPath(p) {
        if (p == null) return '';
        return String(p).replace(/\\/g, '/').replace(/(?:\/+\.)*\/*$/, '');
    }

    function normalizePathCompare(p) {
        var norm = normalizeSlashPath(p);
        if (!norm) return '';
        // Windows 盘符/路径大小写归一化；仅比较路径语义一致性
        if (/^[a-zA-Z]:\//.test(norm) || norm.indexOf('\\') >= 0) {
            return norm.toLowerCase();
        }
        return norm;
    }

    function sanitizeSlug(raw, fallback) {
        var s = raw != null ? String(raw) : '';
        s = s.replace(/[<>:"/\\|?*\x00-\x1F]+/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
        if (!s || s === '.' || s === '..') return fallback || 'world';
        if (s.length > 48) s = s.slice(0, 48).replace(/_+$/, '') || (fallback || 'world');
        return s;
    }

    function formatIsoNow() {
        var d = new Date();
        function p2(n) { return n < 10 ? ('0' + n) : String(n); }
        return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' +
            p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
    }

    function generateWorldId() {
        try {
            if (JAVA_UUID_CLASS != null && typeof JAVA_UUID_CLASS.randomUUID === 'function') {
                return String(JAVA_UUID_CLASS.randomUUID()).replace(/-/g, '').slice(0, 12).toLowerCase();
            }
        } catch (eUuid) { }
        var hex = '';
        while (hex.length < 12) {
            hex += Math.floor(Math.random() * 0x10000).toString(16);
        }
        return hex.slice(0, 12).toLowerCase();
    }

    function resolveGameDir() {
        if (KUBEJS_PATHS_CLASS != null) {
            var directCandidates = [
                safeReadProp(KUBEJS_PATHS_CLASS, 'GAMEDIR'),
                safeReadProp(KUBEJS_PATHS_CLASS, 'INSTANCE')
            ];
            for (var i = 0; i < directCandidates.length; i++) {
                var c = directCandidates[i];
                if (c != null) {
                    try {
                        var str = normalizeSlashPath(typeof c.toAbsolutePath === 'function' ? c.toAbsolutePath().normalize() : c);
                        if (str && str !== '[object Object]' && str.indexOf('undefined') !== 0) {
                            return str;
                        }
                    } catch (eC) { }
                }
            }
            var kjsDir = safeReadProp(KUBEJS_PATHS_CLASS, 'DIRECTORY');
            if (kjsDir != null) {
                try {
                    var dirStr = normalizeSlashPath(typeof kjsDir.toAbsolutePath === 'function' ? kjsDir.toAbsolutePath().normalize() : kjsDir);
                    if (dirStr && dirStr !== '[object Object]' && dirStr.indexOf('undefined') !== 0) {
                        if (/\/kubejs$/i.test(dirStr)) {
                            var parent = dirStr.slice(0, -7);
                            if (parent) return parent;
                        }
                        return dirStr;
                    }
                } catch (eDir) { }
            }
        }
        if (JAVA_FILE_CLASS != null) {
            try {
                var dot = new JAVA_FILE_CLASS('.');
                var can = (typeof dot.getCanonicalPath === 'function') ? dot.getCanonicalPath() : dot.getAbsolutePath();
                var canStr = normalizeSlashPath(can);
                if (canStr) return canStr;
            } catch (eDot) { }
        }
        return '.';
    }

    function resolveEpiphyDataRoot() {
        if (epiphyDataRootOverride) return epiphyDataRootOverride;
        var gDir = resolveGameDir();
        if (!gDir || gDir === '.') return 'epiphy-data';
        return gDir + '/epiphy-data';
    }

    function setEpiphyDataRoot(customPath) {
        epiphyDataRootOverride = customPath ? normalizeSlashPath(customPath) : null;
        worldContextCache = {};
        loggingInitialized = false;
        return resolveEpiphyDataRoot();
    }

    function ensureDirExists(dirPath, logger) {
        if (!dirPath) return false;
        var norm = normalizeSlashPath(dirPath);
        if (JAVA_FILE_CLASS != null) {
            try {
                var f = new JAVA_FILE_CLASS(norm);
                if (f.exists()) return Boolean(f.isDirectory());
                return Boolean(f.mkdirs());
            } catch (eDir) {
                (logger || baseLogger).catchWarn('ensureDirExists', eDir);
            }
        }
        if (JAVA_FILES_CLASS != null && JAVA_PATHS_CLASS != null && typeof JAVA_FILES_CLASS.createDirectories === 'function') {
            try {
                JAVA_FILES_CLASS.createDirectories(JAVA_PATHS_CLASS.get(norm));
                return true;
            } catch (eNioDir) {
                (logger || baseLogger).catchWarn('ensureDirExists:nio', eNioDir);
            }
        }
        if (safeHasMethod(KUBEJS_PATHS_CLASS, 'dir')
            && (epiphyDataRootOverride != null || /^(?:[a-zA-Z]:[\\/]|\/)/.test(norm))) {
            try {
                if (KUBEJS_PATHS_CLASS.dir(norm) != null) {
                    return true;
                }
            } catch (eKjDir) {
                (logger || baseLogger).catchWarn('ensureDirExists:KubeJSPaths', eKjDir);
            }
        }
        return false;
    }

    function ensureEpiphyDataDirs(logger) {
        var root = resolveEpiphyDataRoot();
        ensureDirExists(root, logger);
        var out = { root: root, subdirs: {} };
        for (var i = 0; i < EPIPHY_DATA_SUBDIRS.length; i++) {
            var sub = EPIPHY_DATA_SUBDIRS[i];
            var subPath = root + '/' + sub;
            ensureDirExists(subPath, logger);
            out.subdirs[sub] = subPath;
        }
        return out;
    }

    function fileExists(filePath) {
        if (!filePath || JAVA_FILE_CLASS == null) return false;
        try {
            var f = new JAVA_FILE_CLASS(String(filePath));
            return Boolean(f.exists() && f.isFile());
        } catch (e) {
            return false;
        }
    }

    function isExpectedMissingFileErr(err) {
        var s = String(err || '');
        return s.indexOf('NoSuchFileException') >= 0
            || s.indexOf('FileNotFoundException') >= 0
            || s.indexOf('ENOENT') >= 0;
    }

    function readTextSafe(filePath, logger) {
        if (!filePath) return null;
        if (JAVA_FILES_CLASS != null && JAVA_PATHS_CLASS != null && JAVA_CHARSET_UTF8 != null) {
            try {
                var p = JAVA_PATHS_CLASS.get(String(filePath));
                if (!Boolean(JAVA_FILES_CLASS.exists(p))) return null;
                if (typeof JAVA_FILES_CLASS.readString === 'function') {
                    return String(JAVA_FILES_CLASS.readString(p, JAVA_CHARSET_UTF8));
                }
                if (typeof JAVA_FILES_CLASS.readAllBytes === 'function') {
                    var bytes = JAVA_FILES_CLASS.readAllBytes(p);
                    var jStrCls = loadJavaClass('java.lang.String');
                    if (jStrCls != null) return String(new jStrCls(bytes, JAVA_CHARSET_UTF8));
                }
            } catch (eRead) {
                if (!isExpectedMissingFileErr(eRead)) {
                    (logger || baseLogger).catchWarn('readTextSafe', eRead);
                }
            }
        }
        if (typeof JsonIO !== 'undefined' && JsonIO != null && typeof JsonIO.readString === 'function') {
            try {
                var jsStr = JsonIO.readString(String(filePath));
                if (jsStr != null) {
                    var rawStr = String(jsStr);
                    if (rawStr !== '') return rawStr;
                }
            } catch (eJioStr) {
                if (!isExpectedMissingFileErr(eJioStr)) {
                    (logger || baseLogger).catchWarn('readTextSafe:JsonIO.readString', eJioStr);
                }
            }
        }
        if (typeof FilesIO !== 'undefined' && FilesIO != null && typeof FilesIO.read === 'function') {
            try {
                var r = FilesIO.read(String(filePath));
                return r != null ? String(r) : null;
            } catch (eFio) {
                if (!isExpectedMissingFileErr(eFio)) {
                    (logger || baseLogger).catchWarn('readTextSafe:FilesIO', eFio);
                }
            }
        }
        return null;
    }

    function movePathReplace(srcPathStr, dstPathStr) {
        if (JAVA_FILES_CLASS != null && JAVA_PATHS_CLASS != null && JAVA_COPY_OPT_CLASS != null) {
            var srcP = JAVA_PATHS_CLASS.get(String(srcPathStr));
            var dstP = JAVA_PATHS_CLASS.get(String(dstPathStr));
            try {
                if (JAVA_COPY_OPT_CLASS.ATOMIC_MOVE != null) {
                    JAVA_FILES_CLASS.move(srcP, dstP, JAVA_COPY_OPT_CLASS.REPLACE_EXISTING, JAVA_COPY_OPT_CLASS.ATOMIC_MOVE);
                    return true;
                }
            } catch (eAtomic) { }
            try {
                JAVA_FILES_CLASS.move(srcP, dstP, JAVA_COPY_OPT_CLASS.REPLACE_EXISTING);
                return true;
            } catch (eMove) { }
        }
        if (JAVA_FILE_CLASS != null) {
            try {
                var srcF = new JAVA_FILE_CLASS(String(srcPathStr));
                var dstF = new JAVA_FILE_CLASS(String(dstPathStr));
                if (dstF.exists()) dstF.delete();
                return Boolean(srcF.renameTo(dstF));
            } catch (eRen) { }
        }
        return false;
    }

    function writeTextAtomic(filePath, text, keepBackup, logger) {
        if (!filePath) return false;
        var normPath = normalizeSlashPath(filePath);
        ensureParentDir(normPath, logger);
        var content = String(text != null ? text : '');
        var useBackup = (keepBackup !== false);

        if (JAVA_FILES_CLASS != null && JAVA_PATHS_CLASS != null && JAVA_CHARSET_UTF8 != null) {
            var tmpPath = normPath + '.tmp';
            var bakPath = normPath + '.bak';
            try {
                var tmpP = JAVA_PATHS_CLASS.get(tmpPath);
                if (typeof JAVA_FILES_CLASS.writeString === 'function') {
                    JAVA_FILES_CLASS.writeString(tmpP, content, JAVA_CHARSET_UTF8);
                } else {
                    JAVA_FILES_CLASS.write(tmpP, content.getBytes(JAVA_CHARSET_UTF8));
                }
                if (useBackup && fileExists(normPath)) {
                    try {
                        var curP = JAVA_PATHS_CLASS.get(normPath);
                        var bakP = JAVA_PATHS_CLASS.get(bakPath);
                        if (JAVA_COPY_OPT_CLASS != null && JAVA_COPY_OPT_CLASS.REPLACE_EXISTING != null) {
                            JAVA_FILES_CLASS.copy(curP, bakP, JAVA_COPY_OPT_CLASS.REPLACE_EXISTING);
                        }
                    } catch (eBak) {
                        (logger || baseLogger).catchWarn('writeTextAtomic:backup', eBak);
                    }
                }
                if (movePathReplace(tmpPath, normPath)) {
                    return true;
                }
            } catch (eNio) {
                (logger || baseLogger).catchWarn('writeTextAtomic', eNio);
                try {
                    if (JAVA_FILE_CLASS != null) {
                        var leftover = new JAVA_FILE_CLASS(tmpPath);
                        if (leftover.exists()) leftover.delete();
                    }
                } catch (eClean) { }
            }
        }

        if (typeof FilesIO !== 'undefined' && FilesIO != null && typeof FilesIO.write === 'function') {
            try {
                FilesIO.write(normPath, content);
                return true;
            } catch (eFioW) {
                (logger || baseLogger).catchWarn('writeTextAtomic:FilesIO', eFioW);
            }
        }
        return false;
    }

    function javaToJsPlain(val, depth) {
        var curDepth = depth != null ? depth : 0;
        if (val == null || curDepth > 24) return val;
        var t = safeTypeOf(val);
        if (t !== 'object') return val;
        if (Array.isArray(val)) {
            var arr = [];
            for (var i = 0; i < val.length; i++) arr.push(javaToJsPlain(val[i], curDepth + 1));
            return arr;
        }
        // 先检查 Java Map 接口；Rhino 的 NativeJavaMap 可能拦截 keySet/iterator 键查，需结合 Object.keys 兜底
        if (safeHasMethod(val, 'entrySet')) {
            try {
                var objE = {};
                var itE = val.entrySet().iterator();
                while (itE.hasNext()) {
                    var entry = itE.next();
                    var ek = entry != null ? String(entry.getKey()) : '';
                    if (ek) objE[ek] = javaToJsPlain(entry.getValue(), curDepth + 1);
                }
                return objE;
            } catch (eEntry) { }
        }
        if (safeHasMethod(val, 'keySet') && safeHasMethod(val, 'get')) {
            try {
                var obj = {};
                var it = val.keySet().iterator();
                while (it.hasNext()) {
                    var k = String(it.next());
                    obj[k] = javaToJsPlain(val.get(k), curDepth + 1);
                }
                return obj;
            } catch (eMap) { }
        }
        if (!isJavaMapLike(val) && safeHasMethod(val, 'iterator')) {
            try {
                var list = [];
                var it2 = val.iterator();
                while (it2.hasNext()) list.push(javaToJsPlain(it2.next(), curDepth + 1));
                return list;
            } catch (eList) { }
        }
        if (!isJavaMapLike(val) && safeHasMethod(val, 'size') && safeHasMethod(val, 'get')) {
            try {
                var listSz = Number(val.size());
                var arrL = [];
                for (var li = 0; li < listSz; li++) arrL.push(javaToJsPlain(val.get(li), curDepth + 1));
                return arrL;
            } catch (eSize) { }
        }
        // 使用 Object.keys 遍历普通 JS 对象与 Rhino NativeJavaMap，绝不对未过滤的 Java POJO 使用 `for..in` 误触 `.class`
        var out = {};
        try {
            var keys = Object.keys(val);
            for (var ki = 0; ki < keys.length; ki++) {
                var pk = keys[ki];
                if (pk === 'class' || pk === 'constructors' || pk === 'declaredConstructors') continue;
                var pv = safeReadProp(val, pk);
                if (pv !== undefined) out[pk] = javaToJsPlain(pv, curDepth + 1);
            }
        } catch (eKeys) { }
        return out;
    }

    function readJsonSingleTarget(targetPath, logger) {
        if (!targetPath) return { status: 'missing', data: null, error: null };
        var normTarget = normalizeSlashPath(targetPath);
        var hadReadError = false;
        var lastErrorMsg = null;

        if (JAVA_FILES_CLASS != null && JAVA_PATHS_CLASS != null && JAVA_CHARSET_UTF8 != null) {
            try {
                var p = JAVA_PATHS_CLASS.get(String(normTarget));
                if (Boolean(JAVA_FILES_CLASS.exists(p))) {
                    var nioStr = null;
                    if (typeof JAVA_FILES_CLASS.readString === 'function') {
                        nioStr = String(JAVA_FILES_CLASS.readString(p, JAVA_CHARSET_UTF8));
                    } else if (typeof JAVA_FILES_CLASS.readAllBytes === 'function') {
                        var bytes = JAVA_FILES_CLASS.readAllBytes(p);
                        var jStrCls = loadJavaClass('java.lang.String');
                        if (jStrCls != null) nioStr = String(new jStrCls(bytes, JAVA_CHARSET_UTF8));
                    }
                    if (nioStr != null) {
                        var trimmedNio = nioStr.trim();
                        if (trimmedNio.length === 0) {
                            return { status: 'corrupt', data: null, error: 'empty file' };
                        }
                        try {
                            return { status: 'ok', data: JSON.parse(trimmedNio), error: null };
                        } catch (eNioParse) {
                            (logger || baseLogger).warn('readJsonSafe', 'JSON 解析失败 (' + normTarget + '): ' + eNioParse);
                            return { status: 'corrupt', data: null, error: String(eNioParse) };
                        }
                    }
                }
            } catch (eNioRead) {
                if (!isExpectedMissingFileErr(eNioRead)) {
                    hadReadError = true;
                    lastErrorMsg = String(eNioRead);
                    (logger || baseLogger).catchWarn('readJsonSafe:nio', eNioRead);
                }
            }
        }

        if (typeof JsonIO !== 'undefined' && JsonIO != null && typeof JsonIO.readString === 'function') {
            try {
                var jsStr = JsonIO.readString(String(normTarget));
                if (jsStr != null) {
                    var rawStr = String(jsStr).trim();
                    if (rawStr.length === 0) {
                        return { status: 'corrupt', data: null, error: 'empty file' };
                    }
                    try {
                        return { status: 'ok', data: JSON.parse(rawStr), error: null };
                    } catch (eJioStrParse) {
                        (logger || baseLogger).warn('readJsonSafe', 'JSON 解析失败 (' + normTarget + '): ' + eJioStrParse);
                        return { status: 'corrupt', data: null, error: String(eJioStrParse) };
                    }
                }
            } catch (eJioStr) {
                if (!isExpectedMissingFileErr(eJioStr)) {
                    hadReadError = true;
                    lastErrorMsg = String(eJioStr);
                    (logger || baseLogger).catchWarn('readJsonSafe:JsonIO.readString', eJioStr);
                }
            }
        }

        if (typeof FilesIO !== 'undefined' && FilesIO != null && typeof FilesIO.read === 'function') {
            try {
                var fioRaw = FilesIO.read(String(normTarget));
                if (fioRaw != null) {
                    var fioTrimmed = String(fioRaw).trim();
                    if (fioTrimmed.length === 0) {
                        return { status: 'corrupt', data: null, error: 'empty file' };
                    }
                    try {
                        return { status: 'ok', data: JSON.parse(fioTrimmed), error: null };
                    } catch (eFioParse) {
                        (logger || baseLogger).warn('readJsonSafe', 'JSON 解析失败 (' + normTarget + '): ' + eFioParse);
                        return { status: 'corrupt', data: null, error: String(eFioParse) };
                    }
                }
            } catch (eFio) {
                if (!isExpectedMissingFileErr(eFio)) {
                    hadReadError = true;
                    lastErrorMsg = String(eFio);
                    (logger || baseLogger).catchWarn('readJsonSafe:FilesIO', eFio);
                }
            }
        }

        if (typeof JsonIO !== 'undefined' && JsonIO != null) {
            if (typeof JsonIO.readJson === 'function' && typeof JsonIO.toString === 'function') {
                try {
                    var el = JsonIO.readJson(String(normTarget));
                    if (el != null) {
                        var jsonStr = String(JsonIO.toString(el)).trim();
                        if (jsonStr && jsonStr !== 'null') {
                            return { status: 'ok', data: JSON.parse(jsonStr), error: null };
                        }
                        if (jsonStr === '') {
                            return { status: 'corrupt', data: null, error: 'empty json element' };
                        }
                    }
                } catch (eJioEl) {
                    if (!isExpectedMissingFileErr(eJioEl)) {
                        hadReadError = true;
                        lastErrorMsg = String(eJioEl);
                        (logger || baseLogger).catchWarn('readJsonSafe:JsonIO.readJson', eJioEl);
                    }
                }
            }
            if (typeof JsonIO.read === 'function') {
                try {
                    var raw = JsonIO.read(String(normTarget));
                    if (raw != null) {
                        return { status: 'ok', data: javaToJsPlain(raw, 0), error: null };
                    }
                } catch (eJio) {
                    if (!isExpectedMissingFileErr(eJio)) {
                        hadReadError = true;
                        lastErrorMsg = String(eJio);
                        (logger || baseLogger).catchWarn('readJsonSafe:JsonIO', eJio);
                    }
                }
            }
        }

        if (hadReadError) {
            return { status: 'corrupt', data: null, error: lastErrorMsg || 'read error' };
        }
        return { status: 'missing', data: null, error: null };
    }

    var LAST_WRITTEN_JSON_CACHE = {};
    var LAST_WRITTEN_JSON_KEYS  = [];

    function cacheLastWrittenJson(normPath, obj) {
        if (!normPath || !isObjectLike(obj)) return;
        if (!Object.prototype.hasOwnProperty.call(LAST_WRITTEN_JSON_CACHE, normPath)) {
            if (LAST_WRITTEN_JSON_KEYS.length >= 64) {
                var evicted = LAST_WRITTEN_JSON_KEYS.shift();
                if (evicted !== undefined) delete LAST_WRITTEN_JSON_CACHE[evicted];
            }
            LAST_WRITTEN_JSON_KEYS.push(normPath);
        }
        LAST_WRITTEN_JSON_CACHE[normPath] = obj;
    }

    function readJsonDetailed(filePath, logger, allowBackupRecovery) {
        if (!filePath) return { status: 'missing', data: null, fromBackup: false, error: null };
        var normPath = normalizeSlashPath(filePath);
        var primary = readJsonSingleTarget(normPath, logger);
        if (primary.status === 'ok' && primary.data != null) {
            cacheLastWrittenJson(normPath, primary.data);
            return { status: 'ok', data: primary.data, fromBackup: false, error: null };
        }
        // 仅当主文件确系损坏（status === 'corrupt'，如崩溃截断）或显式指定 'allow_missing' 时才自动从 .bak 自愈，
        // 避免管理员手动删除主文件重置状态（status === 'missing'）后被 .bak 静默复活
        var useBak = (allowBackupRecovery !== false) &&
            (primary.status === 'corrupt' || allowBackupRecovery === 'allow_missing') &&
            normPath.slice(-4) !== '.bak';
        if (useBak) {
            var bakPath = normPath + '.bak';
            var bakRes = readJsonSingleTarget(bakPath, logger);
            if (bakRes.status === 'ok' && bakRes.data != null) {
                (logger || baseLogger).warn(
                    'readJsonSafe:backupRecovered',
                    '主文件读取损坏 (' + normPath + ', status=' + primary.status + ')，已自动从备份恢复: ' + bakPath
                );
                try {
                    writeJsonAtomic(normPath, bakRes.data, false, logger);
                } catch (eHeal) { }
                cacheLastWrittenJson(normPath, bakRes.data);
                return { status: 'ok', data: bakRes.data, fromBackup: true, error: null };
            }
        }
        return {
            status:     primary.status,
            data:       null,
            fromBackup: false,
            error:      primary.error
        };
    }

    function readJsonSafe(filePath, logger) {
        var res = readJsonDetailed(filePath, logger, true);
        return res.status === 'ok' ? res.data : null;
    }

    function canWritePersistentFiles() {
        if (JAVA_FILES_CLASS != null || JAVA_FILE_CLASS != null) return true;
        if (typeof JsonIO !== 'undefined' && JsonIO != null && typeof JsonIO.write === 'function') {
            return Boolean(epiphyDataRootOverride != null || /^(?:[a-zA-Z]:[\\/]|\/)/.test(resolveGameDir()));
        }
        return false;
    }

    function writeJsonAtomic(filePath, obj, keepBackup, logger) {
        if (!filePath) return false;
        var normPath = normalizeSlashPath(filePath);
        try {
            var jsonStr = JSON.stringify(obj, null, 2);
            if (writeTextAtomic(normPath, jsonStr + '\n', keepBackup, logger)) {
                cacheLastWrittenJson(normPath, obj);
                return true;
            }
        } catch (eStr) {
            (logger || baseLogger).catchWarn('writeJsonAtomic:stringify', eStr);
        }
        if (typeof JsonIO !== 'undefined' && JsonIO != null && typeof JsonIO.write === 'function') {
            try {
                ensureParentDir(normPath, logger);
                if (keepBackup !== false && normPath.slice(-4) !== '.bak') {
                    try {
                        var prevObj = Object.prototype.hasOwnProperty.call(LAST_WRITTEN_JSON_CACHE, normPath)
                            ? LAST_WRITTEN_JSON_CACHE[normPath]
                            : null;
                        if (prevObj == null) {
                            var prevRes = readJsonSingleTarget(normPath, null);
                            if (prevRes.status === 'ok' && prevRes.data != null && isObjectLike(prevRes.data)) {
                                prevObj = prevRes.data;
                            }
                        }
                        if (prevObj != null && isObjectLike(prevObj)) {
                            JsonIO.write(normPath + '.bak', prevObj);
                        }
                    } catch (eBakJio) { }
                }
                JsonIO.write(normPath, obj);
                cacheLastWrittenJson(normPath, obj);
                return true;
            } catch (eJioW) {
                (logger || baseLogger).catchWarn('writeJsonAtomic:JsonIO', eJioW);
            }
        }
        return false;
    }

    function readWorldNameFromServer(srv) {
        var worldName = 'world';
        if (srv != null) {
            try {
                var wd = (typeof srv.getWorldData === 'function') ? srv.getWorldData() : srv.worldData;
                if (wd != null) {
                    var ln = (typeof wd.getLevelName === 'function') ? wd.getLevelName() : wd.levelName;
                    if (ln != null && String(ln).trim() !== '') worldName = String(ln).trim();
                }
            } catch (e) { }
        }
        return worldName;
    }

    function readWorldSeedFromServer(srv) {
        if (srv == null) return null;
        try {
            var wd = (typeof srv.getWorldData === 'function') ? srv.getWorldData() : srv.worldData;
            if (wd != null && typeof wd.worldGenOptions === 'function') {
                var opt = wd.worldGenOptions();
                if (opt != null && typeof opt.seed === 'function') {
                    return String(opt.seed());
                }
            }
        } catch (e) { }
        return null;
    }

    function resolveWorldDirectoryPath(srv) {
        if (srv == null || LEVEL_RESOURCE_ROOT == null || typeof srv.getWorldPath !== 'function') {
            return '';
        }
        try {
            var rootPath = srv.getWorldPath(LEVEL_RESOURCE_ROOT);
            if (rootPath == null) return '';
            var normRoot = (typeof rootPath.toAbsolutePath === 'function')
                ? rootPath.toAbsolutePath().normalize()
                : ((typeof rootPath.normalize === 'function') ? rootPath.normalize() : rootPath);
            var s = normalizeSlashPath(normRoot);
            if (!s || s === '[object Object]' || s.indexOf('undefined') === 0) return '';
            return s;
        } catch (e) {
            return '';
        }
    }

    function readWorldsIndexMap(worldsDir, logger) {
        if (!worldsDir) return {};
        var idxData = readJsonSafe(worldsDir + '/worlds_index.json', logger);
        if (idxData == null || !isObjectLike(idxData)) return {};
        var mapObj = isObjectLike(idxData.worlds) ? idxData.worlds : idxData;
        var out = {};
        try {
            var ks = Object.keys(mapObj);
            for (var i = 0; i < ks.length; i++) {
                var k = ks[i];
                var rec = mapObj[k];
                if (rec != null && isObjectLike(rec) && rec.folderName) {
                    out[String(k)] = rec;
                }
            }
        } catch (eIdx) { }
        return out;
    }

    function upsertWorldsIndexEntry(worldsDir, metaPayload, logger) {
        if (!worldsDir || !metaPayload || !metaPayload.worldId || !metaPayload.folderName) return false;
        var mapObj = readWorldsIndexMap(worldsDir, logger);
        var wid = String(metaPayload.worldId);
        mapObj[wid] = {
            worldId:       wid,
            folderName:    String(metaPayload.folderName),
            worldName:     String(metaPayload.worldName || 'world'),
            lastWorldPath: String(metaPayload.lastWorldPath || ''),
            updatedAt:     String(metaPayload.updatedAt || formatIsoNow())
        };
        return writeJsonAtomic(worldsDir + '/worlds_index.json', {
            version:   1,
            updatedAt: formatIsoNow(),
            worlds:    mapObj
        }, false, logger);
    }

    function scanWorldsMetadata(worldsDir, logger, hintFolderNames) {
        var entries = [];
        if (!worldsDir) return entries;
        var seenFolders = {};
        function tryCollectFolder(folderName) {
            if (!folderName) return;
            var fn = String(folderName).trim();
            if (!fn || hasOwn(seenFolders, fn)) return;
            seenFolders[fn] = true;
            var metaPath = worldsDir + '/' + fn + '/meta.json';
            var meta = readJsonSafe(metaPath, logger);
            if (meta != null && isObjectLike(meta) && meta.worldId) {
                entries.push({
                    folderName: fn,
                    metaPath:   metaPath,
                    meta:       meta
                });
            }
        }
        if (JAVA_FILE_CLASS != null) {
            try {
                var dirObj = new JAVA_FILE_CLASS(worldsDir);
                if (dirObj.exists() && dirObj.isDirectory()) {
                    var children = dirObj.listFiles();
                    if (children != null) {
                        for (var i = 0; i < children.length; i++) {
                            var child = children[i];
                            if (child != null && child.isDirectory()) {
                                tryCollectFolder(String(child.getName()));
                            }
                        }
                    }
                }
            } catch (eScan) {
                (logger || baseLogger).catchWarn('scanWorldsMetadata', eScan);
            }
        }
        var idxMap = readWorldsIndexMap(worldsDir, logger);
        var idxKeys = Object.keys(idxMap);
        for (var j = 0; j < idxKeys.length; j++) {
            var item = idxMap[idxKeys[j]];
            if (item && item.folderName) tryCollectFolder(item.folderName);
        }
        if (Array.isArray(hintFolderNames)) {
            for (var h = 0; h < hintFolderNames.length; h++) {
                if (hintFolderNames[h]) tryCollectFolder(hintFolderNames[h]);
            }
        }
        return entries;
    }

    function buildWorldContextResult(dataDirs, worldId, worldName, slug, folderName, worldPath, anchorPath, forkedFrom, forkNotice, isBoundWorld) {
        var wDir = dataDirs.subdirs.worlds + '/' + folderName;
        ensureDirExists(wDir, baseLogger);
        var worldLogsDir = wDir + '/logs';
        ensureDirExists(worldLogsDir, baseLogger);
        var legacyFiles = [];
        if (worldPath) {
            legacyFiles.push(worldPath + '/kubejs_epiphy_permissions.json');
        }
        legacyFiles.push('kubejs/config/epiphy_permissions/' + slug + '.json');
        return {
            worldKey:        'wid:' + worldId,
            worldId:         worldId,
            shortId:         worldId.slice(0, 8),
            worldName:       worldName,
            slug:            slug,
            folderName:      folderName,
            worldPath:       worldPath,
            anchorPath:      anchorPath,
            isWorldBound:    Boolean(isBoundWorld),
            dataRoot:        dataDirs.root,
            worldDataDir:    wDir,
            logsDir:         worldLogsDir,
            permissionsFile: wDir + '/permissions.json',
            revocationsFile: wDir + '/revocations.json',
            authModeFile:    wDir + '/auth_mode.json',
            metaFile:        wDir + '/meta.json',
            legacyFiles:     legacyFiles,
            forkedFrom:      forkedFrom || null,
            forkNotice:      forkNotice || null
        };
    }

    function switchRuntimeLogDirToWorld(ctx) {
        if (!ctx || !ctx.logsDir) return;
        initEpiphyLoggingSink(false);
        var logApi = resolveEpiphyLog();
        if (logApi != null && typeof logApi.configureFileSink === 'function') {
            var cur = (typeof logApi.getFileSinkConfig === 'function') ? logApi.getFileSinkConfig() : null;
            var changed = !cur || normalizePathCompare(cur.dir) !== normalizePathCompare(ctx.logsDir);
            logApi.configureFileSink({ dir: ctx.logsDir });
            if (changed && typeof logApi.info === 'function') {
                logApi.info(
                    'EpiphyServerBase',
                    'worldLogBound',
                    'worldId=' + ctx.worldId + ' folder=' + ctx.folderName + ' logDir=' + ctx.logsDir
                    + (ctx.forkedFrom ? (' forkedFrom=' + ctx.forkedFrom.folderName) : '')
                );
            }
        }
    }

    var SERVER_ANCHOR_PDATA_KEY = 'epiphy_world_anchor_v1';
    var lastKnownAnchorByPath = {};

    function readServerPersistentAnchor(srv) {
        if (srv == null) return null;
        try {
            var pData = srv.persistentData;
            if (pData == null) return null;
            var raw = null;
            if (typeof pData.getString === 'function') {
                if (typeof pData.contains === 'function' && !pData.contains(SERVER_ANCHOR_PDATA_KEY)) return null;
                raw = pData.getString(SERVER_ANCHOR_PDATA_KEY);
            } else if (pData[SERVER_ANCHOR_PDATA_KEY] != null) {
                raw = String(pData[SERVER_ANCHOR_PDATA_KEY]);
            }
            if (!raw || String(raw).trim() === '') return null;
            var parsed = JSON.parse(String(raw));
            return (parsed != null && isObjectLike(parsed) && parsed.worldId) ? parsed : null;
        } catch (eReadP) {
            return null;
        }
    }

    function writeServerPersistentAnchor(srv, anchorPayload) {
        if (srv == null || !anchorPayload || !anchorPayload.worldId) return false;
        try {
            var pData = srv.persistentData;
            if (pData == null) return false;
            var raw = JSON.stringify(anchorPayload);
            if (typeof pData.putString === 'function') {
                pData.putString(SERVER_ANCHOR_PDATA_KEY, raw);
                return true;
            }
            pData[SERVER_ANCHOR_PDATA_KEY] = raw;
            return true;
        } catch (eWriteP) {
            return false;
        }
    }

    function resolveEpiphyWorldContext(server, options) {
        var srv = resolveServer(server);
        var dataDirs = ensureEpiphyDataDirs(baseLogger);
        var worldName = readWorldNameFromServer(srv);
        var slug = sanitizeSlug(worldName, 'world');
        var worldPath = resolveWorldDirectoryPath(srv);
        var pathCmp = normalizePathCompare(worldPath);
        var forceReload = Boolean(options && options.forceReload);
        var allowLogSwitch = !(options && options.switchLogsDir === false);

        if (!forceReload && pathCmp && hasOwn(worldContextCache, pathCmp)) {
            var cachedCtx = worldContextCache[pathCmp];
            if (allowLogSwitch) switchRuntimeLogDirToWorld(cachedCtx);
            return cachedCtx;
        }
        if (!forceReload && !pathCmp && hasOwn(worldContextCache, '__unbound__:' + slug)) {
            return worldContextCache['__unbound__:' + slug];
        }

        if (!worldPath) {
            var unboundId = 'unbound_' + slug.toLowerCase();
            var unboundCtx = buildWorldContextResult(
                dataDirs, unboundId, worldName, slug, '_unbound__' + slug, '', '', null, null, false
            );
            worldContextCache['__unbound__:' + slug] = unboundCtx;
            return unboundCtx;
        }

        var anchorPath = worldPath + '/data/epiphy_world_id.json';
        var anchor = readJsonSafe(anchorPath, baseLogger);
        var pDataAnchor = readServerPersistentAnchor(srv);
        var memAnchor = hasOwn(lastKnownAnchorByPath, pathCmp) ? lastKnownAnchorByPath[pathCmp] : null;
        var effectiveAnchor = (anchor != null && anchor.worldId)
            ? anchor
            : ((pDataAnchor != null && pDataAnchor.worldId) ? pDataAnchor : memAnchor);
        var anchorId = (effectiveAnchor != null && effectiveAnchor.worldId) ? String(effectiveAnchor.worldId).trim() : '';
        var hintFolders = [];
        if (effectiveAnchor != null && effectiveAnchor.folderName) {
            hintFolders.push(String(effectiveAnchor.folderName).trim());
        } else if (anchorId) {
            hintFolders.push(slug + '__' + anchorId.slice(0, 8));
        }
        if (pDataAnchor != null && pDataAnchor.folderName && hintFolders.indexOf(String(pDataAnchor.folderName).trim()) < 0) {
            hintFolders.push(String(pDataAnchor.folderName).trim());
        }
        if (memAnchor != null && memAnchor.folderName && hintFolders.indexOf(String(memAnchor.folderName).trim()) < 0) {
            hintFolders.push(String(memAnchor.folderName).trim());
        }
        var existingEntries = scanWorldsMetadata(dataDirs.subdirs.worlds, baseLogger, hintFolders);

        var matchedById = null;
        var matchedByPath = null;

        for (var i = 0; i < existingEntries.length; i++) {
            var item = existingEntries[i];
            if (anchorId && item.meta.worldId === anchorId && matchedById == null) {
                matchedById = item;
            }
            if (item.meta.lastWorldPath && normalizePathCompare(item.meta.lastWorldPath) === pathCmp && matchedByPath == null) {
                matchedByPath = item;
            }
        }

        var finalWorldId = '';
        var finalFolder = '';
        var forkedFrom = null;
        var forkNotice = null;
        var needWriteAnchor = false;
        var needWriteMeta = false;
        var nowStr = formatIsoNow();
        var seedStr = readWorldSeedFromServer(srv);

        if (matchedById != null) {
            var prevPathCmp = normalizePathCompare(matchedById.meta.lastWorldPath || '');
            if (prevPathCmp && prevPathCmp !== pathCmp) {
                // worldId 从原存档复制/移动到了不同目录：自动分叉新 worldId 与新目录，绝不覆盖原世界数据
                finalWorldId = generateWorldId();
                finalFolder = slug + '__' + finalWorldId.slice(0, 8);
                forkedFrom = {
                    worldId:       matchedById.meta.worldId,
                    folderName:    matchedById.folderName,
                    lastWorldPath: matchedById.meta.lastWorldPath
                };
                needWriteAnchor = true;
                needWriteMeta = true;
                forkNotice = {
                    worldName:  worldName,
                    oldFolder:  'epiphy-data/worlds/' + matchedById.folderName,
                    newFolder:  'epiphy-data/worlds/' + finalFolder,
                    oldPath:    matchedById.meta.lastWorldPath,
                    newPath:    worldPath,
                    createdAt:  nowStr
                };
                pendingWorldForkNotices.push(forkNotice);
                lastWorldForkNotice = forkNotice;
                baseLogger.warn(
                    'worldFork',
                    '检测到世界路径变化，已自动分叉独立数据目录：原目录 "' + forkNotice.oldPath +
                    '" -> 新目录 "' + forkNotice.newPath + '"；数据已分离至 ' + forkNotice.newFolder +
                    '（原数据保留在 ' + forkNotice.oldFolder + '，如需清理可自行进入对应文件夹删除）。'
                );
            } else {
                finalWorldId = matchedById.meta.worldId;
                finalFolder = matchedById.folderName;
                if (!matchedById.meta.lastWorldPath || matchedById.meta.worldName !== worldName) {
                    needWriteMeta = true;
                }
                if (anchor == null || anchor.worldId !== finalWorldId || anchor.folderName !== finalFolder) {
                    needWriteAnchor = true;
                }
            }
        } else if (matchedByPath != null) {
            finalWorldId = String(matchedByPath.meta.worldId || generateWorldId());
            finalFolder = matchedByPath.folderName;
            needWriteAnchor = true;
            if (matchedByPath.meta.worldName !== worldName) needWriteMeta = true;
        } else {
            finalWorldId = anchorId || generateWorldId();
            finalFolder = (effectiveAnchor != null && effectiveAnchor.folderName && !matchedById)
                ? sanitizeSlug(effectiveAnchor.folderName, slug + '__' + finalWorldId.slice(0, 8))
                : (slug + '__' + finalWorldId.slice(0, 8));
            // 防止极低概率文件夹名碰撞其他已占用的不同 path 世界
            for (var cIdx = 0; cIdx < existingEntries.length; cIdx++) {
                if (existingEntries[cIdx].folderName === finalFolder &&
                    normalizePathCompare(existingEntries[cIdx].meta.lastWorldPath || '') !== pathCmp) {
                    finalWorldId = generateWorldId();
                    finalFolder = slug + '__' + finalWorldId.slice(0, 8);
                    break;
                }
            }
            needWriteAnchor = true;
            needWriteMeta = true;
        }

        var ctx = buildWorldContextResult(
            dataDirs, finalWorldId, worldName, slug, finalFolder, worldPath, anchorPath, forkedFrom, forkNotice, true
        );

        var anchorPayload = {
            version:    1,
            worldId:    finalWorldId,
            folderName: finalFolder,
            worldName:  worldName,
            boundAt:    nowStr
        };
        lastKnownAnchorByPath[pathCmp] = anchorPayload;
        var pDataAnchorOk = writeServerPersistentAnchor(srv, anchorPayload);
        var anchorFileOk = true;
        if (needWriteAnchor) {
            anchorFileOk = writeJsonAtomic(anchorPath, anchorPayload, true, baseLogger);
            if (!anchorFileOk && !pDataAnchorOk) {
                baseLogger.warn(
                    'worldAnchorWriteFailed',
                    '世界锚点文件写入失败 (' + anchorPath + ') 且 persistentData 不可写，已启用内存锚点回退以防目录孤儿化'
                );
            }
        }

        var oldMeta = (matchedById != null && forkedFrom == null)
            ? matchedById.meta
            : (matchedByPath != null ? matchedByPath.meta : null);
        var metaPayload = {
            version:       1,
            worldId:       finalWorldId,
            worldName:     worldName,
            slug:          slug,
            folderName:    finalFolder,
            lastWorldPath: worldPath,
            seed:          seedStr != null ? seedStr : (oldMeta && oldMeta.seed ? oldMeta.seed : null),
            createdAt:     (oldMeta && oldMeta.createdAt) ? oldMeta.createdAt : nowStr,
            updatedAt:     nowStr
        };
        if (forkedFrom != null) metaPayload.forkedFrom = forkedFrom;
        var metaWriteOk = true;
        if (needWriteMeta) {
            metaWriteOk = writeJsonAtomic(ctx.metaFile, metaPayload, true, baseLogger);
            if (!metaWriteOk) {
                baseLogger.warn('worldMetaWriteFailed', '写入世界元数据失败 (' + ctx.metaFile + ')');
            }
        }
        var existingIdxMap = readWorldsIndexMap(dataDirs.subdirs.worlds, null);
        var indexWriteOk = true;
        if (needWriteMeta || !hasOwn(existingIdxMap, finalWorldId) || existingIdxMap[finalWorldId].folderName !== finalFolder) {
            indexWriteOk = upsertWorldsIndexEntry(dataDirs.subdirs.worlds, metaPayload, baseLogger);
            if (!indexWriteOk) {
                baseLogger.warn('worldsIndexWriteFailed', '更新 worlds_index.json 失败 (worldId=' + finalWorldId + ')');
            }
        }
        ctx.anchorPersisted = Boolean(anchorFileOk || pDataAnchorOk);
        ctx.metaPersisted   = Boolean(metaWriteOk && indexWriteOk);

        worldContextCache[pathCmp] = ctx;
        if (allowLogSwitch) switchRuntimeLogDirToWorld(ctx);
        return ctx;
    }

    function clearEpiphyWorldContextCache() {
        worldContextCache = {};
    }

    function consumePendingWorldForkNotices() {
        var copy = pendingWorldForkNotices.slice();
        pendingWorldForkNotices.length = 0;
        return copy;
    }

    function getLastWorldForkNotice() {
        return lastWorldForkNotice;
    }

    function initEpiphyLoggingSink(forceReload) {
        if (loggingInitialized && !forceReload) return null;
        var dirs = ensureEpiphyDataDirs(baseLogger);
        var cfgPath = dirs.subdirs.config + '/logging.json';
        var defaultCfg = {
            _description:  'Epiphy 本地文件日志配置（mode 支持: daily=按天YYYY-MM-DD.log | hourly=按小时 | single=单文件epiphy.log | off=关闭写盘；进入世界后自动切换至 worlds/<world>/logs/）',
            enabled:       true,
            mode:          'daily',
            fileExtension: '.log',
            includeDebug:  false
        };
        var loaded = readJsonSafe(cfgPath, baseLogger);
        if (loaded == null || !isObjectLike(loaded)) {
            if (canWritePersistentFiles()) {
                writeJsonAtomic(cfgPath, defaultCfg, true, baseLogger);
            }
            loaded = defaultCfg;
        }
        var merged = {
            enabled:       loaded.enabled !== undefined ? Boolean(loaded.enabled) : defaultCfg.enabled,
            mode:          loaded.mode != null ? String(loaded.mode) : defaultCfg.mode,
            dir:           dirs.subdirs.logs,
            fileExtension: loaded.fileExtension != null ? String(loaded.fileExtension) : defaultCfg.fileExtension,
            includeDebug:  loaded.includeDebug !== undefined ? Boolean(loaded.includeDebug) : defaultCfg.includeDebug
        };
        var logApi = resolveEpiphyLog();
        if (logApi != null && typeof logApi.configureFileSink === 'function') {
            loggingInitialized = true;
            return logApi.configureFileSink(merged);
        }
        return merged;
    }

    initEpiphyLoggingSink(false);

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
                if (maybeFn !== undefined) {
                    return (guardFn.length >= 2)
                        ? guardFn(policyOrFn, maybeFn)
                        : guardFn(maybeFn);
                }
                return guardFn(policyOrFn);
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

        function resolveBranchPolicy(cfg) {
            if (!cfg) return undefined;
            if (cfg.policy !== undefined) {
                if (!cfg.scope) return cfg.policy;
                if (cfg.policy != null && typeof cfg.policy === 'object') {
                    var merged = {};
                    for (var pk in cfg.policy) {
                        if (Object.prototype.hasOwnProperty.call(cfg.policy, pk)) merged[pk] = cfg.policy[pk];
                    }
                    merged.scope = cfg.scope;
                    return merged;
                }
                return cfg.policy;
            }
            if (!cfg.scope) return undefined;
            var out = {};
            if (defPolicy != null && typeof defPolicy === 'object') {
                for (var dk in defPolicy) {
                    if (Object.prototype.hasOwnProperty.call(defPolicy, dk)) out[dk] = defPolicy[dk];
                }
            } else {
                out.mode = 'authorized';
                out.requireCheats = true;
                out.requireOp = true;
                out.allowAuthorized = true;
                out.opLevel = 2;
            }
            out.scope = cfg.scope;
            return out;
        }

        function withChainBranchPolicy(chOpts, branchPolicy) {
            if (branchPolicy === undefined || (chOpts && chOpts.policy !== undefined)) return chOpts;
            var copy = {};
            if (chOpts != null && typeof chOpts === 'object') {
                for (var k in chOpts) {
                    if (Object.prototype.hasOwnProperty.call(chOpts, k)) copy[k] = chOpts[k];
                }
            }
            copy.policy = branchPolicy;
            return copy;
        }

        function literal(name, cfgOrFn) {
            var node = Commands.literal(name);
            if (typeof cfgOrFn === 'function') {
                return node.executes(guard(cfgOrFn));
            }
            var cfg = cfgOrFn || {};
            var branchPolicy = resolveBranchPolicy(cfg);
            if (branchPolicy !== undefined && typeof canSeeFn === 'function' && typeof node.requires === 'function') {
                node = node.requires(function (src) { return canSeeFn(src, branchPolicy); });
            } else if (defPolicy !== undefined && cfg.inheritRequires && typeof canSeeFn === 'function' && typeof node.requires === 'function') {
                node = node.requires(function (src) { return canSeeFn(src, defPolicy); });
            }
            if (typeof cfg.exec === 'function') {
                node = node.executes(branchPolicy !== undefined ? guard(branchPolicy, cfg.exec) : guard(cfg.exec));
            } else if (cfg.helpLines) {
                var lines = cfg.helpLines;
                var helpExec = function (ctx) { return sendLines(ctx, lines); };
                node = node.executes(branchPolicy !== undefined ? guard(branchPolicy, helpExec) : guard(helpExec));
            }
            if (cfg.chain) {
                node = attachChain(node, cfg.chain[0], cfg.chain[1], withChainBranchPolicy(cfg.chain[2], branchPolicy));
            }
            if (cfg.chains) {
                for (var c = 0; c < cfg.chains.length; c++) {
                    var ch = cfg.chains[c];
                    node = attachChain(node, ch[0], ch[1], withChainBranchPolicy(ch[2], branchPolicy));
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
        var coreApi = {
            createLogger:                 createLogger,
            loadJavaClass:                loadJavaClass,
            nowNano:                      nowNano,
            resolveServer:                resolveServer,
            safeTypeOf:                   safeTypeOf,
            isObjectLike:                 isObjectLike,
            isJavaMapLike:                isJavaMapLike,
            isArrayLike:                  isArrayLike,
            safeReadProp:                 safeReadProp,
            safeHasMethod:                safeHasMethod,
            normalizeDim:                 normalizeDim,
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
            isCreativePlayer:             isCreativePlayer,
            isSpectatorPlayer:            isSpectatorPlayer,
            extractItemStackId:           extractItemStackId,
            isHoldingMainHand:            isHoldingMainHand,
            findPlayerItem:               findPlayerItem,
            forEachPlayerNear:            forEachPlayerNear,
            hasPlayerNear:                hasPlayerNear,
            forEachEntityNear:            forEachEntityNear,
            formatChatPayloadToString:    formatChatPayloadToString,
            tellPlayerSafe:               tellPlayerSafe,
            tellNear:                     tellNear,
            actionBarNear:                actionBarNear,
            spawnParticlesSafe:           spawnParticlesSafe,
            resolveWorldStorageInfo:      resolveWorldStorageInfo,
            ensureParentDir:              ensureParentDir,
            EPIPHY_DATA_SUBDIRS:          EPIPHY_DATA_SUBDIRS.slice(),
            resolveEpiphyDataRoot:        resolveEpiphyDataRoot,
            setEpiphyDataRoot:            setEpiphyDataRoot,
            ensureEpiphyDataDirs:         ensureEpiphyDataDirs,
            readTextSafe:                 readTextSafe,
            writeTextAtomic:              writeTextAtomic,
            readJsonDetailed:             readJsonDetailed,
            readJsonSafe:                 readJsonSafe,
            writeJsonAtomic:              writeJsonAtomic,
            resolveEpiphyWorldContext:    resolveEpiphyWorldContext,
            clearEpiphyWorldContextCache: clearEpiphyWorldContextCache,
            consumePendingWorldForkNotices: consumePendingWorldForkNotices,
            getLastWorldForkNotice:       getLastWorldForkNotice,
            initEpiphyLoggingSink:        initEpiphyLoggingSink,
            registerDebugProvider:        registerDebugProvider,
            registerSubcommandSafe:       registerSubcommandSafe,
            checkSubcommandRegistrations: checkSubcommandRegistrations,
            isValveReady:                 isValveReady,
            acquireBlockTracker:          acquireBlockTracker,
            createCommandBuilder:         createCommandBuilder
        };
        global.EpiphyServerCore = coreApi;
        global.EpiphyServerBase = coreApi;
    }

    if (typeof ServerEvents !== 'undefined' && ServerEvents != null) {
        if (typeof ServerEvents.loaded === 'function') {
            ServerEvents.loaded(function (event) {
                try {
                    initEpiphyLoggingSink(false);
                    var srv = (event != null && event.server != null) ? event.server : resolveServer(null);
                    if (srv != null) {
                        resolveEpiphyWorldContext(srv, { forceReload: true });
                    }
                } catch (eLoad) {
                    baseLogger.catchWarn('ServerEvents.loaded', eLoad);
                }
            });
        }
        if (typeof ServerEvents.unloaded === 'function') {
            ServerEvents.unloaded(function () {
                try {
                    clearEpiphyWorldContextCache();
                    fallbackTracked.clear();
                    fallbackTickCounter = 0;
                    var dirs = ensureEpiphyDataDirs(baseLogger);
                    var logApi = resolveEpiphyLog();
                    if (logApi != null && typeof logApi.configureFileSink === 'function') {
                        logApi.configureFileSink({ dir: dirs.subdirs.logs });
                    }
                } catch (eUnload) {
                    baseLogger.catchWarn('ServerEvents.unloaded', eUnload);
                }
            });
        }
    }
})();
