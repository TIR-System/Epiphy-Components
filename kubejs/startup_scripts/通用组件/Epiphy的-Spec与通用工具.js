// priority: 1200
// ============================================================================
// Epiphy 通用规范、共享协议契约与纯逻辑基座 (EpiphySpec + EpiphyProtocol v2.6)
//   许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
//   所属阶段：startup_scripts（服务端与客户端共享，单一前置加载项）
//   职责说明：
//     1. 定义并导出 global.EpiphyProtocol（频道名、版本号、PRIORITY_MAP、HUD_FORBIDDEN_PRESETS）；
//     2. 收拢跨组件复用的数值/布尔/时长/颜色/字号/倾角/命令解析器、球簇合并几何算法、有界 FIFO 缓存池 (`createBoundedCache`)
//        与跨阶段向上预设注册表 (`createPresetRegistry` / `registerPreset` / `resolvePreset`)，导出 global.EpiphySpec；
//     3. 服务端业务组件以本文件 + EpiphyServerBase 为底座；客户端渲染器/播放器在缺失本文件时仍可降级运行内置 v6 协议常量。
//   语法规范：遵循 README-LLM.md §1 强制语法基准（与 docs/kube-mods-rhino-es5-es6-compatibility.md）
// ============================================================================

;(function () {
    'use strict';

    // ------------------------------------------------------------------------
    // 1. 共享协议常量与版本契约 (global.EpiphyProtocol)
    // ------------------------------------------------------------------------
    var PRIORITY_MAP = {
        low:      1,
        normal:   2,
        high:     3,
        critical: 4,
        active:   5
    };

    var PRIORITY_CANON_NAMES = Object.freeze({
        1: 'low',
        2: 'normal',
        3: 'high',
        4: 'critical',
        5: 'active'
    });

    // [已淘汰，未来不再做兼容/不再新增映射表——不支持新功能] 仅保留 2 个最常用旧优先级别名
    var DEPRECATED_PRIORITY_ALIASES = Object.freeze({
        medium: 2,
        urgent: 4
    });

    var HUD_FORBIDDEN_PRESETS = {
        minimap:   Object.freeze({ x: 0.74, y: 0.00, w: 0.26, h: 0.28 }),
        hotbar:    Object.freeze({ x: 0.22, y: 0.80, w: 0.56, h: 0.20 }),
        crosshair: Object.freeze({ x: 0.40, y: 0.38, w: 0.20, h: 0.22 }),
        bossbar:   Object.freeze({ x: 0.25, y: 0.00, w: 0.50, h: 0.09 })
    };

    var SPEC_VERSION          = '2.6.0';

    var DANMAKU_CHANNEL       = 'epiphy:screen_danmaku';
    var DANMAKU_PROTO_VERSION = 6;

    var AUDIO_CHANNEL         = 'epiphy:audio';
    var AUDIO_PROTO_VERSION   = 5;

    function isProtoCompatible(expectedVer, incomingVer) {
        if (incomingVer === undefined || incomingVer === null) return false;
        var n = Number(incomingVer);
        var exp = Number(expectedVer);
        if (!isFinite(n) || !isFinite(exp)) return false;
        if (exp === 6) return n === 5 || n === 6;
        return n === exp;
    }

    // ------------------------------------------------------------------------
    // 语义化版本解析与闭区间依赖兼容校验 (minVer <= actualVer <= maxVer)
    //   说明：组件实现版本由各组件自身独立维护导出，EpiphySpec 仅提供通用比较与区间校验工具。
    // ------------------------------------------------------------------------
    function parseSemver(rawVer) {
        if (rawVer === undefined || rawVer === null) return null;
        if (typeof rawVer === 'number') {
            if (!isFinite(rawVer) || rawVer < 0) return null;
            var mjN = Math.floor(rawVer);
            return { major: mjN, minor: 0, patch: 0, raw: mjN + '.0.0' };
        }
        var s = String(rawVer).trim();
        if (!s) return null;
        if (s.charAt(0) === 'v' || s.charAt(0) === 'V') s = s.slice(1).trim();
        var m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/.exec(s);
        if (!m) return null;
        var major = parseInt(m[1], 10);
        var minor = m[2] !== undefined ? parseInt(m[2], 10) : 0;
        var patch = m[3] !== undefined ? parseInt(m[3], 10) : 0;
        if (!isFinite(major) || !isFinite(minor) || !isFinite(patch)) return null;
        return { major: major, minor: minor, patch: patch, raw: major + '.' + minor + '.' + patch };
    }

    function compareSemver(a, b) {
        var pa = parseSemver(a);
        var pb = parseSemver(b);
        if (pa == null || pb == null) return null;
        if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
        if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
        if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
        return 0;
    }

    function isVersionInRange(actualVer, minVer, maxVer) {
        var pa = parseSemver(actualVer);
        if (pa == null) return false;
        if (minVer !== undefined && minVer !== null && String(minVer).trim() !== '') {
            var cMin = compareSemver(pa.raw, minVer);
            if (cMin === null || cMin < 0) return false;
        }
        if (maxVer !== undefined && maxVer !== null && String(maxVer).trim() !== '') {
            var cMax = compareSemver(pa.raw, maxVer);
            if (cMax === null || cMax > 0) return false;
        }
        return true;
    }

    function checkDependencyVersion(depName, depObj, minVer, maxVer, opts) {
        var cfg    = isObjectLike(opts) ? opts : {};
        var caller = cfg.caller ? String(cfg.caller) : 'Epiphy';
        if (depObj == null) {
            var missMsg = '[' + caller + '] 缺少依赖 ' + String(depName) + '（要求版本 >= ' + String(minVer || '0.0.0') + ' 且 <= ' + String(maxVer || '*') + '）';
            if (cfg.required === true) throw new Error(missMsg);
            if (typeof cfg.onWarn === 'function') cfg.onWarn(missMsg);
            return { ok: false, reason: 'missing', actual: null, min: minVer || null, max: maxVer || null, message: missMsg };
        }
        var rawVer = (depObj.VERSION !== undefined) ? depObj.VERSION : depObj.version;
        if (rawVer === undefined || rawVer === null) {
            if (cfg.strictMissingVersion === true) {
                var noVerMsg = '[' + caller + '] 依赖 ' + String(depName) + ' 未声明 VERSION（要求 >= ' + String(minVer || '0.0.0') + ' 且 <= ' + String(maxVer || '*') + '）';
                if (cfg.required === true) throw new Error(noVerMsg);
                if (typeof cfg.onWarn === 'function') cfg.onWarn(noVerMsg);
                return { ok: false, reason: 'unversioned', actual: null, min: minVer || null, max: maxVer || null, message: noVerMsg };
            }
            return { ok: true, reason: 'unversioned_skipped', actual: null, min: minVer || null, max: maxVer || null, message: '' };
        }
        var parsed = parseSemver(rawVer);
        var inRng  = parsed != null && isVersionInRange(parsed.raw, minVer, maxVer);
        if (!inRng) {
            var actualStr = parsed != null ? parsed.raw : String(rawVer);
            var rangeStr  = (minVer ? ('>=' + minVer) : '') + (minVer && maxVer ? ' 且 ' : '') + (maxVer ? ('<=' + maxVer) : '');
            var badMsg    = '[' + caller + '] 依赖 ' + String(depName) + ' 版本不兼容（实际 ' + actualStr + '，兼容范围 ' + rangeStr + '）';
            if (cfg.required === true) throw new Error(badMsg);
            if (typeof cfg.onWarn === 'function') cfg.onWarn(badMsg);
            return { ok: false, reason: 'out_of_range', actual: actualStr, min: minVer || null, max: maxVer || null, message: badMsg };
        }
        return { ok: true, reason: 'ok', actual: parsed.raw, min: minVer || null, max: maxVer || null, message: '' };
    }

    function registerPriorityAlias(name, level) {
        if (name == null) return false;
        var key = String(name).trim().toLowerCase();
        var lv  = Number(level);
        if (!key || !isFinite(lv)) return false;
        PRIORITY_MAP[key] = Math.max(0, Math.min(10, Math.round(lv)));
        return true;
    }

    function registerHudPreset(name, rect) {
        if (name == null || rect == null || typeof rect !== 'object') return false;
        var key = String(name).trim().toLowerCase();
        var x = Number(rect.x), y = Number(rect.y), w = Number(rect.w), h = Number(rect.h);
        if (!key || !isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h)) return false;
        HUD_FORBIDDEN_PRESETS[key] = Object.freeze({ x: x, y: y, w: w, h: h });
        return true;
    }

    var PROTOCOL = {
        DANMAKU_CHANNEL:       DANMAKU_CHANNEL,
        DANMAKU_PROTO_VERSION: DANMAKU_PROTO_VERSION,
        AUDIO_CHANNEL:         AUDIO_CHANNEL,
        AUDIO_PROTO_VERSION:   AUDIO_PROTO_VERSION,
        PRIORITY_MAP:                PRIORITY_MAP,
        PRIORITY_CANON_NAMES:        PRIORITY_CANON_NAMES,
        DEPRECATED_PRIORITY_ALIASES: DEPRECATED_PRIORITY_ALIASES,
        HUD_FORBIDDEN_PRESETS:       HUD_FORBIDDEN_PRESETS,
        isProtoCompatible:     isProtoCompatible,
        registerPriorityAlias: registerPriorityAlias,
        registerHudPreset:     registerHudPreset
    };

    if (typeof global !== 'undefined') {
        global.EpiphyProtocol = PROTOCOL;
    }

    var SIZE_PRESETS = {
        tiny:   0.58,
        small:  0.74,
        normal: 1.00,
        medium: 1.00,
        large:  1.35,
        huge:   1.70
    };

    var COLOR_PRESETS = {
        red:          0xFF4444,
        dark_red:     0xAA0000,
        gold:         0xFFAA00,
        yellow:       0xFFFF55,
        green:        0x55FF55,
        dark_green:   0x00AA00,
        aqua:         0x55FFFF,
        dark_aqua:    0x00AAAA,
        blue:         0x5555FF,
        light_purple: 0xFF55FF,
        purple:       0xAA00AA,
        dark_purple:  0xAA00AA,
        white:        0xFFFFFF,
        gray:         0xAAAAAA,
        dark_gray:    0x555555,
        black:        0x000000
    };

    var DEFAULT_SIZE_CFG = {
        sizeMin:        0.2,
        sizeMax:        4.0,
        smallRandRange: [0.55, 0.97],
        randSizeRange:  [0.58, 1.70],
        defaultSize:    1.0
    };

    var SPEC_TOKEN_RE = /([A-Za-z_]+)=(?:"([^"]*)"|'([^']*)'|(\S+))|(\S+)/g;
    var PIPE_PLACEHOLDER = '\uE000';

    function hasOwn(obj, key) {
        return Object.prototype.hasOwnProperty.call(obj, key);
    }

    function min2(a, b) {
        return a < b ? a : b;
    }

    function max2(a, b) {
        return a > b ? a : b;
    }

    function safeTypeOf(x) {
        if (x === null) return 'object';
        if (x === undefined) return 'undefined';
        try {
            return typeof x;
        } catch (e) {
            // Rhino MemberType.get 对未包装 Java POJO 执行 typeof 时会抛 Invalid JavaScript value InternalError
            return 'object';
        }
    }

    function isObjectLike(x) {
        return x != null && safeTypeOf(x) === 'object';
    }

    function isJavaMapLike(x) {
        if (!isObjectLike(x)) return false;
        try {
            return typeof x.entrySet === 'function' || typeof x.containsKey === 'function' || typeof x.put === 'function';
        } catch (e) {
            return false;
        }
    }

    function isArrayLike(x) {
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

    function isJavaListLike(x) {
        if (!isObjectLike(x)) return false;
        try {
            if (isJavaMapLike(x)) return false;
            return typeof x.size === 'function' && typeof x.get === 'function';
        } catch (e) {
            return false;
        }
    }

    function readPairBounds(val) {
        if (isArrayLike(val)) {
            if (val.length === 0) return null;
            if (val.length === 1) return [val[0]];
            return [val[0], val[1]];
        }
        if (isJavaListLike(val)) {
            var sz = Number(val.size());
            if (!isFinite(sz) || sz <= 0) return null;
            if (sz === 1) return [val.get(0)];
            return [val.get(0), val.get(1)];
        }
        return null;
    }

    function parseFiniteNum(raw) {
        if (raw === null || raw === undefined || raw === '' || typeof raw === 'boolean') return null;
        if (Array.isArray(raw)) return null;
        if (typeof raw === 'string' && raw.trim() === '') return null;
        var n = Number(raw);
        return (typeof n === 'number' && !isNaN(n) && isFinite(n)) ? n : null;
    }

    function parseNonNegNum(raw) {
        var n = parseFiniteNum(raw);
        return (n !== null && n >= 0) ? n : null;
    }

    function clampNum(v, lo, hi, defVal) {
        var n = parseFiniteNum(v);
        if (n === null) return defVal !== undefined ? defVal : lo;
        if (lo !== undefined && lo !== null && n < lo) return lo;
        if (hi !== undefined && hi !== null && n > hi) return hi;
        return n;
    }

    function normalizeDim(dim) {
        if (dim == null) return null;
        if (typeof dim !== 'string' && dim.dimension != null) {
            return normalizeDim(dim.dimension);
        }
        var s;
        if (typeof dim === 'string') {
            s = dim;
        } else if (typeof dim.location === 'function') {
            s = String(dim.location());
        } else if (dim.location != null) {
            s = String(dim.location);
        } else {
            s = String(dim);
        }
        s = s.trim().toLowerCase();
        if (!s || s.indexOf('serverlevel') >= 0) return null;
        if (s.indexOf('resourcekey[') === 0) {
            var m = /\s\/\s([^\]]+)\]$/.exec(s);
            if (m && m[1]) s = m[1].trim();
        }
        if (s.indexOf(':') < 0) s = 'minecraft:' + s;
        return s;
    }

    function parseBoolStrict(raw) {
        if (raw === true || raw === false) return raw;
        if (typeof raw === 'number') {
            if (raw === 1) return true;
            if (raw === 0) return false;
            return null;
        }
        if (typeof raw !== 'string') return null;
        var s = raw.trim().toLowerCase();
        if (s === 'true' || s === '1' || s === '1b' || s === 'yes' || s === 'on' || s === 'y' || s === '是' || s === '开启' || s === '开') return true;
        if (s === 'false' || s === '0' || s === '0b' || s === 'no' || s === 'off' || s === 'n' || s === '否' || s === '关闭' || s === '关') return false;
        return null;
    }

    function parseBool(raw, defVal) {
        var parsed = parseBoolStrict(raw);
        return parsed !== null ? parsed : Boolean(defVal);
    }

    function parsePriority(raw, defVal, opts) {
        var def = (defVal !== undefined && defVal !== null) ? defVal : 0;
        if (raw === null || raw === undefined || raw === '') return def;
        var map = (opts && opts.map) ? opts.map : PRIORITY_MAP;
        var depMap = (opts && opts.deprecatedMap !== undefined) ? opts.deprecatedMap : DEPRECATED_PRIORITY_ALIASES;
        var lo = (opts && opts.min !== undefined && opts.min !== null) ? opts.min : 0;
        var hi = (opts && opts.max !== undefined && opts.max !== null) ? opts.max : 10;
        var doRound = !(opts && opts.round === false);

        if (typeof raw === 'string') {
            var s = raw.trim().toLowerCase();
            if (!s) return def;
            if (map && hasOwn(map, s)) {
                return clampNum(map[s], lo, hi, def);
            }
            if (depMap && hasOwn(depMap, s)) {
                var depLv = clampNum(depMap[s], lo, hi, def);
                if (opts && typeof opts.onDeprecated === 'function') {
                    opts.onDeprecated(s, PRIORITY_CANON_NAMES[depLv] || String(depLv), depLv);
                }
                return depLv;
            }
        }
        var n = parseFiniteNum(raw);
        if (n === null) return def;
        if (doRound) n = Math.round(n);
        return clampNum(n, lo, hi, def);
    }

    function parseTicks(val, allowZero) {
        if (val === null || val === undefined || val === '' || typeof val === 'boolean') return null;
        if (typeof val === 'number') {
            if (!isFinite(val)) return null;
            if (allowZero ? val < 0 : val <= 0) return null;
            return Math.ceil(val);
        }
        var s = String(val).trim().toLowerCase();
        if (!s) return null;
        var m = /^([+-]?(?:\d+\.?\d*|\.\d+))\s*(ms|t|tick|ticks|s|sec|secs|second|seconds|m|min|mins|minute|minutes)?$/.exec(s);
        if (!m) return null;
        var n = Number(m[1]);
        if (!isFinite(n)) return null;
        if (allowZero ? n < 0 : n <= 0) return null;
        var unit = m[2] || 't';
        var ticks;
        if (unit === 's' || unit === 'sec' || unit === 'secs' || unit === 'second' || unit === 'seconds') {
            ticks = n * 20;
        } else if (unit === 'm' || unit === 'min' || unit === 'mins' || unit === 'minute' || unit === 'minutes') {
            ticks = n * 1200;
        } else if (unit === 'ms') {
            ticks = n / 50;
        } else {
            ticks = n;
        }
        return n === 0 ? 0 : Math.max(1, Math.ceil(ticks));
    }

    function parseTicksOrSec(raw) {
        if (raw === null || raw === undefined || typeof raw === 'boolean') return null;
        if (typeof raw === 'number') {
            if (!isFinite(raw) || raw <= 0) return null;
            return Math.max(1, Math.round(raw));
        }
        var s = String(raw).trim();
        if (!s) return null;
        var last = s.charAt(s.length - 1).toLowerCase();
        if (last === 's') {
            var sec = parseFiniteNum(s.slice(0, -1));
            if (sec === null || sec <= 0) return null;
            return Math.max(1, Math.round(sec * 20));
        }
        var num = parseFiniteNum(s);
        if (num === null || num <= 0) return null;
        return Math.max(1, Math.round(num));
    }

    function randomVividColor() {
        var h = Math.random() * 6;
        var i = Math.floor(h);
        var f = h - i;
        var v = 235;
        var s = 0.72 + Math.random() * 0.25;
        var p = Math.round(v * (1 - s));
        var q = Math.round(v * (1 - f * s));
        var t = Math.round(v * (1 - (1 - f) * s));
        var r, g, b;
        if (i === 0)      { r = v; g = t; b = p; }
        else if (i === 1) { r = q; g = v; b = p; }
        else if (i === 2) { r = p; g = v; b = t; }
        else if (i === 3) { r = p; g = q; b = v; }
        else if (i === 4) { r = t; g = p; b = v; }
        else              { r = v; g = p; b = q; }
        return ((r & 0xFF) << 16) | ((g & 0xFF) << 8) | (b & 0xFF);
    }

    function parseColor(val, defColor, presets, opts) {
        var preserveAlpha = !!(opts && opts.preserveAlpha);
        var mask = preserveAlpha ? 0xFFFFFFFF : 0xFFFFFF;
        var def = (typeof defColor === 'number' && isFinite(defColor))
            ? (preserveAlpha ? (Math.floor(defColor) >>> 0) : (Math.floor(defColor) & 0xFFFFFF))
            : (preserveAlpha ? 0xFFFFFFFF : 0xFFFFFF);
        var presetMap = presets || COLOR_PRESETS;
        if (val === null || val === undefined || val === '' || typeof val === 'boolean') {
            return { color: def, isRandom: false };
        }
        if (typeof val === 'number') {
            if (!isFinite(val)) return { color: def, isRandom: false };
            var numCol = Math.floor(val);
            return { color: preserveAlpha ? (numCol >>> 0) : (numCol & mask), isRandom: false };
        }
        var s = String(val).trim().toLowerCase();
        if (!s) return { color: def, isRandom: false };
        if (s === 'random' || s === 'rand') {
            return { color: randomVividColor(), isRandom: true };
        }
        if (presetMap && hasOwn(presetMap, s)) {
            return { color: (presetMap[s] & 0xFFFFFF), isRandom: false };
        }
        if (s.charAt(0) === '#') {
            var h = s.slice(1);
            if (/^[0-9a-f]{3}$/.test(h)) {
                var exp = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
                return { color: parseInt(exp, 16) & 0xFFFFFF, isRandom: false };
            }
            if (/^[0-9a-f]{6,8}$/.test(h)) {
                var parsedHex = parseInt(h, 16);
                return { color: preserveAlpha ? (parsedHex >>> 0) : (parsedHex & 0xFFFFFF), isRandom: false };
            }
            return { color: def, isRandom: false };
        }
        if (/^0x[0-9a-f]{1,8}$/.test(s)) {
            var parsedOx = parseInt(s, 16);
            return { color: preserveAlpha ? (parsedOx >>> 0) : (parsedOx & 0xFFFFFF), isRandom: false };
        }
        if (/^[0-9a-f]{6}$/.test(s)) {
            return { color: parseInt(s, 16) & 0xFFFFFF, isRandom: false };
        }
        return { color: def, isRandom: false };
    }

    function parseArgbColor(val, defColor, presets) {
        return parseColor(val, defColor, presets, { preserveAlpha: true });
    }

    function sampleClampedRange(a, b, loBound, hiBound, defVal) {
        var ca = clampNum(a, loBound, hiBound, defVal);
        var cb = clampNum(b, loBound, hiBound, defVal);
        var lo = min2(ca, cb);
        var hi = max2(ca, cb);
        if (Math.abs(hi - lo) < 1e-6) {
            return { value: lo, isRandom: false };
        }
        return { value: lo + Math.random() * (hi - lo), isRandom: true };
    }

    function splitRangeStr(s) {
        var idx = s.indexOf('~');
        if (idx < 0) idx = s.indexOf(',');
        if (idx < 0) return null;
        return [s.slice(0, idx).trim(), s.slice(idx + 1).trim()];
    }

    function parseSize(sizeVal, scaleVal, cfg) {
        var c = cfg || DEFAULT_SIZE_CFG;
        var sMin = (c.sizeMin != null) ? c.sizeMin : DEFAULT_SIZE_CFG.sizeMin;
        var sMax = (c.sizeMax != null) ? c.sizeMax : DEFAULT_SIZE_CFG.sizeMax;
        var smallRng = c.smallRandRange || DEFAULT_SIZE_CFG.smallRandRange;
        var randRng = c.randSizeRange || DEFAULT_SIZE_CFG.randSizeRange;
        var presets = c.sizePresets || SIZE_PRESETS;
        var defScale = (c.defaultSize != null) ? c.defaultSize : DEFAULT_SIZE_CFG.defaultSize;

        var raw = (sizeVal !== undefined && sizeVal !== null && sizeVal !== '') ? sizeVal : scaleVal;
        if (raw === undefined || raw === null || raw === '' || typeof raw === 'boolean') {
            return { scale: defScale, isRandom: false };
        }

        var bounds = readPairBounds(raw);
        if (bounds !== null) {
            if (bounds.length === 1) {
                return { scale: clampNum(bounds[0], sMin, sMax, defScale), isRandom: false };
            }
            var na = parseFiniteNum(bounds[0]);
            var nb = parseFiniteNum(bounds[1]);
            if (na === null || nb === null) return { scale: defScale, isRandom: false };
            var res = sampleClampedRange(na, nb, sMin, sMax, defScale);
            return { scale: res.value, isRandom: res.isRandom };
        }

        if (typeof raw === 'number') {
            if (!isFinite(raw) || (c.rejectNonPositive && raw <= 0)) {
                return { scale: defScale, isRandom: false };
            }
            return { scale: clampNum(raw, sMin, sMax, defScale), isRandom: false };
        }

        var s = String(raw).trim().toLowerCase();
        if (!s) return { scale: defScale, isRandom: false };
        if (s === 'small_random' || s === 'small_rand') {
            var sr = sampleClampedRange(smallRng[0], smallRng[1], sMin, sMax, defScale);
            return { scale: sr.value, isRandom: true };
        }
        if (s === 'random' || s === 'rand') {
            var rr = sampleClampedRange(randRng[0], randRng[1], sMin, sMax, defScale);
            return { scale: rr.value, isRandom: true };
        }
        if (presets && hasOwn(presets, s)) {
            return { scale: clampNum(presets[s], sMin, sMax, defScale), isRandom: false };
        }
        var parts = splitRangeStr(s);
        if (parts) {
            var pa = parseFiniteNum(parts[0]);
            var pb = parseFiniteNum(parts[1]);
            if (pa !== null && pb !== null) {
                var pRes = sampleClampedRange(pa, pb, sMin, sMax, defScale);
                return { scale: pRes.value, isRandom: pRes.isRandom };
            }
            return { scale: defScale, isRandom: false };
        }
        var n = parseFiniteNum(s);
        if (n !== null) {
            if (c.rejectNonPositive && n <= 0) return { scale: defScale, isRandom: false };
            return { scale: clampNum(n, sMin, sMax, defScale), isRandom: false };
        }
        return { scale: defScale, isRandom: false };
    }

    function parseTilt(tiltVal, angleVal, fallbackAngle, defTilt) {
        var baseDef = (defTilt !== undefined && defTilt !== null && isFinite(Number(defTilt)))
            ? clampNum(defTilt, -180, 180, 0) : 0;
        var def = (fallbackAngle !== undefined && fallbackAngle !== null && fallbackAngle !== '')
            ? clampNum(fallbackAngle, -180, 180, baseDef)
            : baseDef;
        var raw = (tiltVal !== undefined && tiltVal !== null && tiltVal !== '') ? tiltVal
            : ((angleVal !== undefined && angleVal !== null && angleVal !== '') ? angleVal : undefined);
        if (raw === undefined || typeof raw === 'boolean') return def;

        var bounds = readPairBounds(raw);
        if (bounds !== null) {
            if (bounds.length === 1) {
                return clampNum(bounds[0], -180, 180, def);
            }
            var na = parseFiniteNum(bounds[0]);
            var nb = parseFiniteNum(bounds[1]);
            if (na === null || nb === null) return def;
            return sampleClampedRange(na, nb, -180, 180, def).value;
        }

        if (typeof raw === 'number') {
            return clampNum(raw, -180, 180, def);
        }

        var s = String(raw).trim().toLowerCase();
        if (!s) return def;
        if (s === 'none' || s === 'flat' || s === 'straight') return 0;
        if (s === 'left') return -12;
        if (s === 'right') return 12;
        if (s === 'random' || s === 'rand') {
            return -20 + Math.random() * 40;
        }
        var parts = splitRangeStr(s);
        if (parts) {
            var pa = parseFiniteNum(parts[0]);
            var pb = parseFiniteNum(parts[1]);
            if (pa !== null && pb !== null) {
                return sampleClampedRange(pa, pb, -180, 180, def).value;
            }
            return def;
        }
        return clampNum(s, -180, 180, def);
    }

    // ========================================================================
    // 声明式命令参数解析器 (parseCommandSpec)
    //   schema = {
    //     aliases:     { aliasLower: canonicalKey },
    //     bareWords:   { wordLower: { key: canonicalKey, value: any } },
    //     fields:      { canonicalKey: 'str'|'lowerStr'|'bool'|'strictBool'|'num'|'strictNum'|'nonneg'|{type,min,max,round,parse}|fn },
    //     unknownMode: 'collectFree' | 'error'
    //     splitFreePipe: boolean (default false)
    //   }
    // ========================================================================
    function applySchemaField(key, rawVal, fieldSpec, opts, addError) {
        if (typeof fieldSpec === 'function') {
            fieldSpec(rawVal, opts, addError, key);
            return;
        }
        var type = (typeof fieldSpec === 'string') ? fieldSpec
            : (fieldSpec && fieldSpec.type ? fieldSpec.type : 'str');
        var hasFallback = (fieldSpec && typeof fieldSpec === 'object' && hasOwn(fieldSpec, 'fallback'));
        if (fieldSpec && typeof fieldSpec.parse === 'function') {
            fieldSpec.parse(rawVal, opts, addError, key);
            return;
        }
        if (type === 'str') {
            opts[key] = String(rawVal);
            return;
        }
        if (type === 'lowerStr') {
            opts[key] = String(rawVal).trim().toLowerCase();
            return;
        }
        if (type === 'strictBool' || type === 'bool') {
            var b = parseBoolStrict(rawVal);
            if (b === null) {
                if (hasFallback && type !== 'strictBool') {
                    opts[key] = Boolean(fieldSpec.fallback);
                    return;
                }
                addError('无效布尔参数 ' + key + '=' + String(rawVal) + ' (应为 true/false/1/0/on/off)');
                return;
            }
            opts[key] = b;
            return;
        }
        if (type === 'num' || type === 'strictNum') {
            var n = parseFiniteNum(rawVal);
            if (n === null) {
                if (hasFallback && type !== 'strictNum') {
                    opts[key] = fieldSpec.fallback;
                    return;
                }
                addError('无效数字参数 ' + key + '=' + String(rawVal));
                return;
            }
            if (fieldSpec && typeof fieldSpec === 'object') {
                if (fieldSpec.round) n = Math.round(n);
                if (fieldSpec.min != null && n < fieldSpec.min) {
                    if (type === 'strictNum') {
                        addError('参数 ' + key + '=' + n + ' 超出下限 (>= ' + fieldSpec.min + ')');
                        return;
                    }
                    n = fieldSpec.min;
                }
                if (fieldSpec.max != null && n > fieldSpec.max) {
                    if (type === 'strictNum') {
                        addError('参数 ' + key + '=' + n + ' 超出上限 (<= ' + fieldSpec.max + ')');
                        return;
                    }
                    n = fieldSpec.max;
                }
            }
            opts[key] = n;
            return;
        }
        if (type === 'nonneg') {
            var nn = parseNonNegNum(rawVal);
            if (nn === null) {
                if (hasFallback) {
                    opts[key] = fieldSpec.fallback;
                    return;
                }
                addError('参数 ' + key + ' 必须为非负数: ' + String(rawVal));
                return;
            }
            if (fieldSpec && typeof fieldSpec === 'object') {
                if (fieldSpec.min != null && nn < fieldSpec.min) nn = fieldSpec.min;
                if (fieldSpec.max != null && nn > fieldSpec.max) nn = fieldSpec.max;
            }
            opts[key] = nn;
            return;
        }
        opts[key] = String(rawVal);
    }

    function parseCommandSpec(specStr, schema) {
        var opts = {};
        var errors = [];
        var freeTokens = [];
        var s = (specStr == null) ? '' : String(specStr);
        var sch = schema || {};
        var aliases = sch.aliases || {};
        var bareWords = sch.bareWords || {};
        var fields = sch.fields || {};
        var unknownMode = sch.unknownMode || 'collectFree';
        var splitFreePipe = Boolean(sch.splitFreePipe);

        var canonByLower = {};
        for (var fk in fields) {
            if (hasOwn(fields, fk)) {
                canonByLower[fk.toLowerCase()] = fk;
            }
        }
        for (var ak in aliases) {
            if (hasOwn(aliases, ak)) {
                canonByLower[ak.toLowerCase()] = aliases[ak];
            }
        }

        function addError(msg) {
            errors.push(String(msg));
        }

        if (s.trim()) {
            SPEC_TOKEN_RE.lastIndex = 0;
            var m;
            while ((m = SPEC_TOKEN_RE.exec(s)) !== null) {
                if (m[1] !== undefined) {
                    var rawKey = m[1].toLowerCase();
                    var rawVal = m[2] !== undefined ? m[2]
                        : (m[3] !== undefined ? m[3] : m[4]);
                    var canon = hasOwn(canonByLower, rawKey) ? canonByLower[rawKey] : null;
                    if (!canon) {
                        if (unknownMode === 'error') {
                            addError('未知参数键: ' + m[1]);
                        } else {
                            freeTokens.push(m[0]);
                        }
                        continue;
                    }
                    applySchemaField(canon, rawVal, fields[canon], opts, addError);
                } else if (m[5] !== undefined) {
                    var tok = m[5];
                    var lowerTok = tok.toLowerCase();
                    if (hasOwn(bareWords, lowerTok)) {
                        var bw = bareWords[lowerTok];
                        if (bw && bw.key) {
                            opts[bw.key] = bw.value;
                        }
                    } else if (unknownMode === 'error') {
                        addError('未知选项词: ' + tok);
                    } else {
                        freeTokens.push(tok);
                    }
                }
            }
        }

        var freeText = freeTokens.join(' ');
        if (splitFreePipe && opts.text == null && opts.title == null && freeText) {
            var protectedStr = freeText.replace(/\\\|/g, PIPE_PLACEHOLDER);
            var pipeIdx = protectedStr.indexOf('|');
            if (pipeIdx >= 0) {
                var mainPart = protectedStr.slice(0, pipeIdx).split(PIPE_PLACEHOLDER).join('|').trim();
                var subPart = protectedStr.slice(pipeIdx + 1).split(PIPE_PLACEHOLDER).join('|').trim();
                opts.text = mainPart;
                if (subPart && opts.sub == null && opts.subtitle == null) {
                    opts.sub = subPart;
                }
            } else {
                opts.text = protectedStr.split(PIPE_PLACEHOLDER).join('|').trim();
            }
        }

        return {
            ok:         errors.length === 0,
            error:      errors.length > 0 ? errors[0] : null,
            errors:     errors,
            opts:       opts,
            freeTokens: freeTokens,
            freeText:   freeText
        };
    }

    // ========================================================================
    // 球域连通分量合并算法 (computeSphereMergeClusters)
    //   输入：nodes: Array<{ cx, cy, cz, r, seq, ... }>
    //   规则：按 seq 升序排序后以 BFS 聚类，(dx²+dy²+dz²) <= (rA+rB)² + 1e-6 判通
    //   输出：Array<{ leader, members, minX, maxX, minY, maxY, minZ, maxZ }>
    // ========================================================================
    function computeSphereMergeClusters(nodes) {
        if (!nodes || !nodes.length) return [];
        var list = [];
        for (var i = 0; i < nodes.length; i++) {
            if (nodes[i] != null) list.push(nodes[i]);
        }
        if (list.length === 0) return [];

        list.sort(function (a, b) {
            return Number(a.seq) - Number(b.seq);
        });

        var n = list.length;
        var visited = [];
        var clusters = [];

        for (var s = 0; s < n; s++) {
            if (visited[s]) continue;
            visited[s] = true;
            var queue = [s];
            var head = 0;
            var members = [];
            var minX = Infinity, maxX = -Infinity;
            var minY = Infinity, maxY = -Infinity;
            var minZ = Infinity, maxZ = -Infinity;

            while (head < queue.length) {
                var idx = queue[head++];
                var a = list[idx];
                members.push(a);
                var ar = Number(a.r) || 0;
                if (a.cx - ar < minX) minX = a.cx - ar;
                if (a.cx + ar > maxX) maxX = a.cx + ar;
                if (a.cy - ar < minY) minY = a.cy - ar;
                if (a.cy + ar > maxY) maxY = a.cy + ar;
                if (a.cz - ar < minZ) minZ = a.cz - ar;
                if (a.cz + ar > maxZ) maxZ = a.cz + ar;

                for (var j = 0; j < n; j++) {
                    if (visited[j]) continue;
                    var b = list[j];
                    var br = Number(b.r) || 0;
                    var sumR = ar + br;
                    var dx = a.cx - b.cx;
                    if (dx > sumR || dx < -sumR) continue;
                    var dy = a.cy - b.cy;
                    if (dy > sumR || dy < -sumR) continue;
                    var dz = a.cz - b.cz;
                    if (dz > sumR || dz < -sumR) continue;
                    if ((dx * dx + dy * dy + dz * dz) <= (sumR * sumR + 1e-6)) {
                        visited[j] = true;
                        queue.push(j);
                    }
                }
            }

            members.sort(function (a, b) {
                return Number(a.seq) - Number(b.seq);
            });

            clusters.push({
                leader:  members[0],
                members: members,
                minX:    minX,
                maxX:    maxX,
                minY:    minY,
                maxY:    maxY,
                minZ:    minZ,
                maxZ:    maxZ
            });
        }

        return clusters;
    }

    // ------------------------------------------------------------------------
    // 6. 平面渲染协议 v6 别名收敛表、配额预算与 v5 -> v6 确定性适配器
    // ------------------------------------------------------------------------
    var OFFICIAL_DANMAKU_ALIASES = Object.freeze({
        act:        'action',
        carrier:    'surface',
        layers:     'nodes',
        texMap:     'replaceTextures',
        bg:         'bgNodes',
        fg:         'fgNodes',
        at:         'worldPos',
        facing:     'billboard',
        xray:       'seeThrough',
        shake:      'shakeMode',
        zIndex:     'renderPriority',
        text:       'title',
        subtitle:   'sub',
        id:         'slotId',
        size:       'scale',
        tilt:       'angle',
        duration:   'stay',
        hold:       'activeHold',
        fade:       'fadeStyle',
        fadeTicks:  'fadeOut',
        outline:    'outlineMode',
        ns:         'namespace'
    });

    var OFFICIAL_NODE_ALIASES = Object.freeze({
        kind:  'type',
        tint:  'color',
        tex:   'texture',
        items: 'children'
    });

    // [已淘汰，未来不再做兼容/不再新增映射表——不支持新功能] 仅保留 2 个最常用旧弹幕字段别名
    var DEPRECATED_DANMAKU_ALIASES = Object.freeze({
        msg:  'title',
        slot: 'slotId'
    });

    function normalizeDanmakuNode(rawNode, depth) {
        if (!isObjectLike(rawNode) || (depth || 0) > 6) return rawNode;
        var out = {};
        var k;
        for (k in rawNode) {
            if (hasOwn(rawNode, k)) {
                out[k] = rawNode[k];
            }
        }
        for (k in OFFICIAL_NODE_ALIASES) {
            if (hasOwn(OFFICIAL_NODE_ALIASES, k) && out[k] !== undefined) {
                var canon = OFFICIAL_NODE_ALIASES[k];
                if (out[canon] === undefined) {
                    out[canon] = out[k];
                }
            }
        }
        if (out.texW !== undefined && out.tw === undefined) out.tw = out.texW;
        if (out.texH !== undefined && out.th === undefined) out.th = out.texH;
        if (isObjectLike(out.fill)) {
            var fCopy = {};
            for (k in out.fill) {
                if (hasOwn(out.fill, k)) fCopy[k] = out.fill[k];
            }
            if (fCopy.shader !== undefined && fCopy.shaderId === undefined) fCopy.shaderId = fCopy.shader;
            if (fCopy.tex !== undefined && fCopy.texture === undefined) fCopy.texture = fCopy.tex;
            if (fCopy.texW !== undefined && fCopy.tw === undefined) fCopy.tw = fCopy.texW;
            if (fCopy.texH !== undefined && fCopy.th === undefined) fCopy.th = fCopy.texH;
            if (fCopy.mode === 'gradient') {
                var usedSchemaGradCols = (fCopy.color !== undefined || fCopy.colorEnd !== undefined) && fCopy.from === undefined && fCopy.to === undefined;
                if (fCopy.color !== undefined && fCopy.from === undefined) fCopy.from = fCopy.color;
                if (fCopy.colorEnd !== undefined && fCopy.to === undefined) fCopy.to = fCopy.colorEnd;
                if (fCopy.dir === 'vertical') fCopy.dir = 'v';
                else if (fCopy.dir === 'horizontal') fCopy.dir = 'h';
                else if (fCopy.dir === undefined && usedSchemaGradCols) fCopy.dir = 'v';
            }
            out.fill = fCopy;
        }
        if (Array.isArray(out.children)) {
            var nextChildren = [];
            for (var ci = 0; ci < out.children.length; ci++) {
                nextChildren.push(normalizeDanmakuNode(out.children[ci], (depth || 0) + 1));
            }
            out.children = nextChildren;
        }
        return out;
    }

    function normalizeNodeArrayAliases(arr) {
        if (!Array.isArray(arr)) return arr;
        var res = [];
        for (var i = 0; i < arr.length; i++) {
            res.push(normalizeDanmakuNode(arr[i], 0));
        }
        return res;
    }

    function normalizeDanmakuAliases(opts, warnFn) {
        if (!isObjectLike(opts)) return {};
        var out = {};
        var k;
        for (k in opts) {
            if (hasOwn(opts, k)) {
                out[k] = opts[k];
            }
        }
        for (k in OFFICIAL_DANMAKU_ALIASES) {
            if (hasOwn(OFFICIAL_DANMAKU_ALIASES, k) && out[k] !== undefined) {
                var canon1 = OFFICIAL_DANMAKU_ALIASES[k];
                if (out[canon1] === undefined) {
                    if (k === 'shake' && typeof out[k] === 'boolean') {
                        if (out[k]) out[canon1] = 'constant';
                    } else if (k === 'outline' && typeof out[k] === 'boolean') {
                        if (out[k]) out[canon1] = 'stroke';
                    } else {
                        out[canon1] = out[k];
                    }
                }
            }
        }
        for (k in DEPRECATED_DANMAKU_ALIASES) {
            if (hasOwn(DEPRECATED_DANMAKU_ALIASES, k) && out[k] !== undefined) {
                var canon2 = DEPRECATED_DANMAKU_ALIASES[k];
                if (out[canon2] === undefined) {
                    out[canon2] = out[k];
                }
                if (typeof warnFn === 'function') {
                    warnFn(k, canon2);
                }
            }
        }
        if (Array.isArray(out.nodes)) out.nodes = normalizeNodeArrayAliases(out.nodes);
        if (Array.isArray(out.bgNodes)) out.bgNodes = normalizeNodeArrayAliases(out.bgNodes);
        if (Array.isArray(out.fgNodes)) out.fgNodes = normalizeNodeArrayAliases(out.fgNodes);
        return out;
    }

    function computeNodeListCost(nodes) {
        if (!Array.isArray(nodes)) return 0;
        var cost = 0;
        for (var i = 0; i < nodes.length; i++) {
            var n = nodes[i];
            if (!isObjectLike(n)) continue;
            var nType = String(n.type || n.kind || 'rect');
            if (nType === 'group') {
                var gKids = Array.isArray(n.children) ? n.children : n.items;
                cost += 1 + computeNodeListCost(gKids);
            } else if (nType === 'rect' && isObjectLike(n.fill) && n.fill.mode === 'parallax') {
                var rawLayers = Array.isArray(n.fill.layers) ? n.fill.layers : [];
                var texLayers = 0;
                var procLayers = 0;
                for (var li = 0; li < rawLayers.length; li++) {
                    var rl = rawLayers[li];
                    if (isObjectLike(rl) && (rl.tex || rl.texture || rl.kind === 'texture' || n.fill.texture || n.fill.tex)) {
                        texLayers++;
                    } else if (isObjectLike(rl)) {
                        procLayers++;
                    }
                }
                var layerCost = (texLayers + procLayers === 0) ? 1 : (texLayers + (procLayers > 0 ? Math.min(2, Math.ceil(procLayers / 2)) : 0));
                cost += 1 + layerCost + (n.borderWidth > 0 ? 1 : 0);
            } else if (nType === 'rect' && isObjectLike(n.fill) && n.fill.mode === 'shader') {
                cost += 4 + (n.borderWidth > 0 ? 1 : 0);
            } else if (nType === 'rect') {
                cost += 1 + (n.borderWidth > 0 ? 1 : 0);
            } else if (nType === 'nine_slice') {
                cost += 4;
            } else if (nType === 'item') {
                cost += 3;
            } else if (nType === 'orbit3d' || nType === 'vfx3d' || nType === 'astrolabe3d') {
                cost += 6;
            } else if (nType === 'text') {
                var rawText = n.text != null ? String(n.text) : (n.title != null ? String(n.title) : '');
                var isPerChar = Boolean(n.perCharShake || n.shakeMode === 'per_char');
                cost += isPerChar ? Math.max(2, Math.ceil(rawText.length / 8)) : 2;
            } else {
                cost += 1;
            }
        }
        return cost;
    }

    function computeOverlayCost(pkt) {
        if (pkt == null || typeof pkt !== 'object') return 0;
        if (Array.isArray(pkt)) return computeNodeListCost(pkt);
        var cost = 0;
        if (Array.isArray(pkt.nodes)) cost += computeNodeListCost(pkt.nodes);
        if (Array.isArray(pkt.bgNodes)) cost += computeNodeListCost(pkt.bgNodes);
        if (Array.isArray(pkt.fgNodes)) cost += computeNodeListCost(pkt.fgNodes);
        if (cost === 0 && (pkt.title || pkt.text || pkt.sub || pkt.subtitle)) {
            var rawT = String(pkt.title || pkt.text || '') + String(pkt.sub || pkt.subtitle || '');
            var perC = Boolean(pkt.perCharShake || pkt.shakeMode === 'per_char');
            cost = perC ? Math.max(2, Math.ceil(rawT.length / 8)) : 2;
        }
        return cost;
    }

    // [已淘汰，未来不再做兼容/不再新增映射表——意味着不支持后续新功能]
    // 仅保留历史扁平 v5 写法的冻结适配层；新业务与客户端调用请一律直接使用原生 v6 结构 (proto: 6 + nodes[])。
    function adaptV5ToV6(rawPkt) {
        if (rawPkt == null || !isObjectLike(rawPkt)) return rawPkt;
        try {
            if (typeof rawPkt.contains === 'function' || typeof rawPkt.getString === 'function') return rawPkt;
        } catch (eTagCheck) { }
        var out = normalizeDanmakuAliases(rawPkt);
        out.proto   = 6;
        out.surface = out.surface ? String(out.surface) : 'screen';
        if (out.renderPriority === undefined) {
            var hasScreenHudNodes = (out.surface === 'screen') && Array.isArray(out.nodes) && out.nodes.length > 0;
            out.renderPriority = (out.surface === 'slot') ? 200
                : ((out.surface === 'gui') ? 100
                    : (hasScreenHudNodes ? 50 : 0));
        }
        var act     = out.action ? String(out.action) : 'push';
        out.action  = act;

        if (Array.isArray(out.items)) {
            var adaptedItems = [];
            for (var i = 0; i < out.items.length; i++) {
                adaptedItems.push(adaptV5ToV6(out.items[i]));
            }
            out.items = adaptedItems;
            return out;
        }

        if (act === 'clear' || act === 'deactivate' || act === 'stop' || act === 'patch') {
            if (out.slotId == null && out.id != null) out.slotId = String(out.id);
            if (out.slotId == null && out.slot != null) out.slotId = String(out.slot);
            return out;
        }

        if (out.namespace === undefined || out.namespace === null) out.namespace = '';
        else out.namespace = String(out.namespace);
        if (out.tier !== 'player' && out.tier !== 'system') {
            out.tier = (out.namespace.indexOf('u:') === 0) ? 'player' : 'system';
        }
        if (out.group === undefined || out.group === null || String(out.group) === '') out.group = 'default';
        else out.group = String(out.group);
        if (out.lifeMode === undefined || out.lifeMode === null || String(out.lifeMode) === '') out.lifeMode = 'once';
        if (out.priority === undefined || out.priority === null) {
            out.priority = (out.lifeMode === 'active') ? 5 : 2;
        }
        if (out.slotId == null) {
            out.slotId = out.id != null ? String(out.id) : (out.slot != null ? String(out.slot) : '');
        }
        if (!isObjectLike(out.vars) || Array.isArray(out.vars)) out.vars = {};
        if (!isObjectLike(out.tracks) || Array.isArray(out.tracks)) out.tracks = {};

        var hasExplicitNodes = (Array.isArray(out.nodes) && out.nodes.length > 0) ||
            (Array.isArray(out.bgNodes) && out.bgNodes.length > 0) ||
            (Array.isArray(out.fgNodes) && out.fgNodes.length > 0) ||
            (out.replaceTextures != null);
        if (hasExplicitNodes) {
            if (!Array.isArray(out.nodes)) out.nodes = [];
            return out;
        }

        var titleStr = out.title != null ? String(out.title) : (out.text != null ? String(out.text) : '');
        var subStr   = out.sub != null ? String(out.sub) : (out.subtitle != null ? String(out.subtitle) : '');
        var nodes    = [];
        if (titleStr.length > 0 || subStr.length === 0) {
            nodes.push({
                id:                  'title',
                type:                'text',
                x:                   0,
                y:                   0,
                anchor:              'center',
                text:                titleStr,
                color:               out.color != null ? out.color : 0xFF5555,
                shadow:              out.shadow !== undefined ? Boolean(out.shadow) : true,
                maxWidth:            out.maxWidth != null ? out.maxWidth : 0,
                wrap:                out.wrap !== undefined ? Boolean(out.wrap) : true,
                typewriter:          Boolean(out.typewriter),
                charMs:              out.charMs != null ? out.charMs : 30,
                cursor:              out.cursor != null ? String(out.cursor) : '▌',
                letterSpacing:       out.letterSpacing != null ? out.letterSpacing : (out.spacing != null ? out.spacing : 0),
                letterSpacingMode:   out.letterSpacingMode || 'relative',
                outlineMode:         out.outlineMode || out.outline || 'none',
                outlineColor:        out.outlineColor != null ? out.outlineColor : -1,
                outlineWidth:        out.outlineWidth != null ? out.outlineWidth : 0.72,
                perCharShake:        Boolean(out.perCharShake),
                charShakeStyle:      out.charShakeStyle || 'omni',
                charShakeShift:      out.charShakeShift != null ? out.charShakeShift : 0.32,
                charShakeShiftX:     out.charShakeShiftX,
                charShakeShiftY:     out.charShakeShiftY,
                charShakeSwayX:      out.charShakeSwayX,
                charShakeSwayY:      out.charShakeSwayY,
                charShakeRotDeg:     out.charShakeRotDeg,
                charShakeWin:        out.charShakeWin,
                charShakeSnap:       out.charShakeSnap,
                charShakeTransition: out.charShakeTransition
            });
        }
        if (subStr.length > 0) {
            nodes.push({
                id:           'sub',
                type:         'text',
                x:            0,
                y:            12,
                anchor:       'center',
                text:         subStr,
                color:        out.subColor != null ? out.subColor : 0xFFCC44,
                shadow:       out.shadow !== undefined ? Boolean(out.shadow) : true,
                maxWidth:     out.maxWidth != null ? out.maxWidth : 0,
                wrap:         out.wrap !== undefined ? Boolean(out.wrap) : true,
                outlineMode:  out.outlineMode || out.outline || 'none',
                outlineColor: out.outlineColor != null ? out.outlineColor : -1,
                outlineWidth: out.outlineWidth != null ? out.outlineWidth : 0.72
            });
        }
        out.nodes = nodes;
        return out;
    }

    // ------------------------------------------------------------------------
    // 5. 统一轻量有界缓存池（支持 'fifo' 默认零 get 写开销 | 'lru' 纯 ES5 双向链表 O(1) 热点保活）
    // ------------------------------------------------------------------------
    function createBoundedCache(maxSize, policy) {
        var limit   = (typeof maxSize === 'number' && isFinite(maxSize) && maxSize >= 1) ? Math.floor(maxSize) : 512;
        var modeStr = (policy != null && typeof policy === 'object')
            ? String(policy.policy || policy.eviction || 'fifo').toLowerCase()
            : String(policy || 'fifo').toLowerCase();

        if (modeStr === 'lru') {
            var map   = Object.create(null);
            var headN = null; // 最近使用 (MRU)
            var tailN = null; // 最久未使用 (LRU)
            var lCnt  = 0;

            var detachNode = function (node) {
                if (node.prev != null) node.prev.next = node.next;
                else headN = node.next;
                if (node.next != null) node.next.prev = node.prev;
                else tailN = node.prev;
                node.prev = null;
                node.next = null;
            };

            var prependNode = function (node) {
                node.prev = null;
                node.next = headN;
                if (headN != null) headN.prev = node;
                else tailN = node;
                headN = node;
            };

            return {
                get: function (key) {
                    var k = String(key);
                    var node = map[k];
                    if (node === undefined) return undefined;
                    if (node !== headN) {
                        detachNode(node);
                        prependNode(node);
                    }
                    return node.v;
                },
                has: function (key) {
                    return String(key) in map;
                },
                set: function (key, val) {
                    var k = String(key);
                    var node = map[k];
                    if (node !== undefined) {
                        node.v = val;
                        if (node !== headN) {
                            detachNode(node);
                            prependNode(node);
                        }
                        return val;
                    }
                    while (lCnt >= limit && tailN != null) {
                        var ev = tailN;
                        detachNode(ev);
                        delete map[ev.k];
                        lCnt--;
                    }
                    var fresh = { k: k, v: val, prev: null, next: null };
                    map[k] = fresh;
                    prependNode(fresh);
                    lCnt++;
                    return val;
                },
                delete: function (key) {
                    var k = String(key);
                    var node = map[k];
                    if (node === undefined) return false;
                    detachNode(node);
                    delete map[k];
                    lCnt--;
                    return true;
                },
                clear: function () {
                    map   = Object.create(null);
                    headN = null;
                    tailN = null;
                    lCnt  = 0;
                },
                size: function () {
                    return lCnt;
                },
                limit: function () {
                    return limit;
                },
                policy: function () {
                    return 'lru';
                }
            };
        }

        var store = Object.create(null);
        var keys  = [];
        var head  = 0;
        var count = 0;

        function evictOverflow() {
            while (count >= limit && head < keys.length) {
                var oldKey = keys[head++];
                if (oldKey in store) {
                    delete store[oldKey];
                    count--;
                }
            }
            if (head > 64 && head * 2 >= keys.length) {
                keys = keys.slice(head);
                head = 0;
            }
        }

        return {
            get: function (key) {
                var k = String(key);
                return (k in store) ? store[k] : undefined;
            },
            has: function (key) {
                return String(key) in store;
            },
            set: function (key, val) {
                var k = String(key);
                if (!(k in store)) {
                    evictOverflow();
                    keys.push(k);
                    count++;
                }
                store[k] = val;
                return val;
            },
            delete: function (key) {
                var k = String(key);
                if (!(k in store)) return false;
                delete store[k];
                count--;
                return true;
            },
            clear: function () {
                store = Object.create(null);
                keys  = [];
                head  = 0;
                count = 0;
            },
            size: function () {
                return count;
            },
            limit: function () {
                return limit;
            },
            policy: function () {
                return 'fifo';
            }
        };
    }

    // ------------------------------------------------------------------------
    // 6. 统一受控深合并（tracks 轨道级合并 + 分组选项合并）与跨阶段预设注册表
    // ------------------------------------------------------------------------
    var GROUPED_MERGE_KEYS = {
        layout: true,
        life:   true,
        motion: true,
        style:  true,
        data:   true,
        vars:   true
    };

    function mergeShallowObj(baseObj, overObj) {
        var out = {};
        var k;
        if (isObjectLike(baseObj)) {
            for (k in baseObj) {
                if (hasOwn(baseObj, k)) out[k] = baseObj[k];
            }
        }
        if (isObjectLike(overObj)) {
            for (k in overObj) {
                if (hasOwn(overObj, k) && overObj[k] !== undefined) out[k] = overObj[k];
            }
        }
        return out;
    }

    // 受控 2 层轨道合并：
    //   - over[k] === null || false -> 显式删除/禁用默认轨道
    //   - over[k].mode 变更 -> 整条替换（防止旧模式残留字段污染）
    //   - 同模式或未传 mode -> 合并字段（保留默认 mode/easing/peak 等）
    function mergeTracksMap(baseTracks, overTracks) {
        var out = {};
        var k;
        if (isObjectLike(baseTracks)) {
            for (k in baseTracks) {
                if (!hasOwn(baseTracks, k)) continue;
                var bt = baseTracks[k];
                out[k] = isObjectLike(bt) ? mergeShallowObj(bt, null) : bt;
            }
        }
        if (isObjectLike(overTracks)) {
            for (k in overTracks) {
                if (!hasOwn(overTracks, k) || overTracks[k] === undefined) continue;
                var ot = overTracks[k];
                if (ot === null || ot === false) {
                    delete out[k];
                    continue;
                }
                if (isObjectLike(out[k]) && isObjectLike(ot) && (ot.mode === undefined || ot.mode === out[k].mode)) {
                    out[k] = mergeShallowObj(out[k], ot);
                } else {
                    out[k] = isObjectLike(ot) ? mergeShallowObj(ot, null) : ot;
                }
            }
        }
        return out;
    }

    function mergeGroupedOptions(baseObj, overObj) {
        var merged = mergeShallowObj(baseObj, overObj);
        if (!isObjectLike(baseObj) || !isObjectLike(overObj)) return merged;
        for (var gk in GROUPED_MERGE_KEYS) {
            if (!hasOwn(GROUPED_MERGE_KEYS, gk)) continue;
            if (isObjectLike(baseObj[gk]) && isObjectLike(overObj[gk])) {
                merged[gk] = mergeShallowObj(baseObj[gk], overObj[gk]);
            }
        }
        if (isObjectLike(baseObj.tracks) || isObjectLike(overObj.tracks)) {
            merged.tracks = mergeTracksMap(baseObj.tracks, overObj.tracks);
        }
        return merged;
    }

    function getSharedPresetBucket(domainName) {
        var dKey = String(domainName || 'default').trim().toLowerCase() || 'default';
        if (typeof global !== 'undefined') {
            if (!isObjectLike(global.EpiphyPresetStore)) {
                global.EpiphyPresetStore = {};
            }
            if (!isObjectLike(global.EpiphyPresetStore[dKey])) {
                global.EpiphyPresetStore[dKey] = {};
            }
            return global.EpiphyPresetStore[dKey];
        }
        return {};
    }

    function createPresetRegistry(domainName) {
        var bucket = getSharedPresetBucket(domainName);

        function normKey(name) {
            if (name == null) return '';
            return String(name).trim().toLowerCase();
        }

        function register(name, specOrFn) {
            var k = normKey(name);
            if (!k) return false;
            if (typeof specOrFn !== 'function' && !isObjectLike(specOrFn)) return false;
            bucket[k] = specOrFn;
            return true;
        }

        function has(name) {
            var k = normKey(name);
            return !!(k && hasOwn(bucket, k));
        }

        function get(name) {
            var k = normKey(name);
            return (k && hasOwn(bucket, k)) ? bucket[k] : null;
        }

        function remove(name) {
            var k = normKey(name);
            if (!k || !hasOwn(bucket, k)) return false;
            delete bucket[k];
            return true;
        }

        function list() {
            var out = [];
            for (var k in bucket) {
                if (hasOwn(bucket, k)) out.push(k);
            }
            out.sort();
            return out;
        }

        function clear() {
            for (var k in bucket) {
                if (hasOwn(bucket, k)) delete bucket[k];
            }
        }

        function resolve(name, overrides, helpers) {
            var entry = get(name);
            if (entry == null) return null;
            var ov = isObjectLike(overrides) ? overrides : {};
            if (typeof entry === 'function') {
                var built = entry(ov, helpers);
                if (!isObjectLike(built)) return built;
                var resFn = mergeShallowObj(built, null);
                delete resFn.preset;
                return resFn;
            }
            var merged = mergeGroupedOptions(entry, ov);
            delete merged.preset;
            return merged;
        }

        return {
            domain:   String(domainName || 'default'),
            register: register,
            has:      has,
            get:      get,
            remove:   remove,
            list:     list,
            clear:    clear,
            resolve:  resolve
        };
    }

    function registerPresetGlobal(domainName, name, specOrFn) {
        return createPresetRegistry(domainName).register(name, specOrFn);
    }

    function resolvePresetGlobal(domainName, name, overrides, helpers) {
        return createPresetRegistry(domainName).resolve(name, overrides, helpers);
    }

    // ------------------------------------------------------------------------
    // 跨子系统共享单调时钟工厂（2D / 3D 渲染器统一使用）：
    //   1. 优先使用 net.minecraft.Util.getNanos() (SRG m_137569_) —— 底层直连 System.nanoTime()
    //      且不受 KubeJS ClassFilter 对 java.lang.System 的屏蔽限制，热路径零异常；
    //   2. 次选 java.lang.System.nanoTime()（仅非 MC JVM 环境下单次静默探测）；
    //   3. 最终降级 Date.now() 时强制套用单调增量钳制（免疫 NTP 校时回拨或跳变）。
    // ------------------------------------------------------------------------
    function createMonotonicClock(opts) {
        var cfg = isObjectLike(opts) ? opts : {};
        var maxJumpMs = (typeof cfg.maxJumpMs === 'number' && isFinite(cfg.maxJumpMs) && cfg.maxJumpMs > 0)
            ? cfg.maxJumpMs : 250.0;
        var clampStepMs = (typeof cfg.clampStepMs === 'number' && isFinite(cfg.clampStepMs) && cfg.clampStepMs >= 0)
            ? cfg.clampStepMs : 16.0;
        var allowSystemProbe = (cfg.allowSystemProbe !== false);
        var onFallbackWarn = (typeof cfg.onWarn === 'function') ? cfg.onWarn : null;

        var utilClass   = null;
        var utilNanosFn = null;
        var sysClass    = null;
        var source      = 'clamped_date';

        if (typeof Java !== 'undefined' && Java != null && typeof Java.loadClass === 'function') {
            try {
                utilClass = Java.loadClass('net.minecraft.Util');
                if (utilClass != null) {
                    if (typeof utilClass.getNanos === 'function') utilNanosFn = utilClass.getNanos;
                    else if (typeof utilClass.m_137569_ === 'function') utilNanosFn = utilClass.m_137569_;
                    if (utilNanosFn != null) {
                        source = 'mc_util_nanos';
                    }
                }
            } catch (eUtil) { utilClass = null; utilNanosFn = null; }

            if (source === 'clamped_date' && allowSystemProbe) {
                try {
                    sysClass = Java.loadClass('java.lang.System');
                    if (sysClass != null && typeof sysClass.nanoTime === 'function') {
                        source = 'system_nanos';
                    }
                } catch (eSys) { sysClass = null; }
            }
        }

        var t0Ns      = null;
        var lastRawMs = null;
        var accMs     = 0.0;
        var warned    = false;

        function readClampedDateMs() {
            var raw = Date.now();
            if (lastRawMs === null) {
                lastRawMs = raw;
                accMs = raw;
                return accMs;
            }
            var dt = raw - lastRawMs;
            lastRawMs = raw;
            if (dt < 0 || dt > maxJumpMs) {
                dt = clampStepMs;
            }
            accMs += dt;
            return accMs;
        }

        function nowMs() {
            if (source === 'mc_util_nanos' && utilNanosFn != null) {
                try {
                    var n0 = Number(utilNanosFn.call(utilClass));
                    if (isFinite(n0)) {
                        if (t0Ns === null) t0Ns = n0;
                        return (n0 - t0Ns) / 1000000.0;
                    }
                } catch (eU) {
                    source = 'clamped_date';
                    if (!warned && onFallbackWarn != null) {
                        warned = true;
                        onFallbackWarn('net.minecraft.Util.getNanos 不可用，已降级单调钳制 Date.now(): ' + eU);
                    }
                }
            }
            if (source === 'system_nanos' && sysClass != null) {
                try {
                    var n1 = Number(sysClass.nanoTime());
                    if (isFinite(n1)) {
                        if (t0Ns === null) t0Ns = n1;
                        return (n1 - t0Ns) / 1000000.0;
                    }
                } catch (eS) {
                    source = 'clamped_date';
                    if (!warned && onFallbackWarn != null) {
                        warned = true;
                        onFallbackWarn('System.nanoTime 不可用，已降级单调钳制 Date.now(): ' + eS);
                    }
                }
            }
            return readClampedDateMs();
        }

        var epochMs = nowMs();

        return {
            nowMs: nowMs,
            elapsedSec: function () {
                return (nowMs() - epochMs) * 0.001;
            },
            getSource: function () {
                return source;
            }
        };
    }

    if (typeof global !== 'undefined') {
        global.EpiphySpec = {
            VERSION:                    SPEC_VERSION,
            PROTOCOL:                   PROTOCOL,
            PROTO:                      PROTOCOL,
            parseSemver:                parseSemver,
            compareSemver:              compareSemver,
            isVersionInRange:           isVersionInRange,
            checkDependencyVersion:     checkDependencyVersion,
            COLOR_PRESETS:              COLOR_PRESETS,
            SIZE_PRESETS:               SIZE_PRESETS,
            PRIORITY_MAP:               PRIORITY_MAP,
            DEPRECATED_PRIORITY_ALIASES: DEPRECATED_PRIORITY_ALIASES,
            OFFICIAL_DANMAKU_ALIASES:   OFFICIAL_DANMAKU_ALIASES,
            OFFICIAL_NODE_ALIASES:      OFFICIAL_NODE_ALIASES,
            DEPRECATED_DANMAKU_ALIASES: DEPRECATED_DANMAKU_ALIASES,
            isProtoCompatible:          isProtoCompatible,
            normalizeDanmakuNode:       normalizeDanmakuNode,
            normalizeDanmakuAliases:    normalizeDanmakuAliases,
            computeNodeListCost:        computeNodeListCost,
            computeOverlayCost:         computeOverlayCost,
            adaptV5ToV6:                adaptV5ToV6,
            createBoundedCache:         createBoundedCache,
            createMonotonicClock:       createMonotonicClock,
            mergeTracksMap:             mergeTracksMap,
            mergeGroupedOptions:        mergeGroupedOptions,
            createPresetRegistry:       createPresetRegistry,
            registerPreset:             registerPresetGlobal,
            resolvePreset:              resolvePresetGlobal,
            min2:                       min2,
            max2:                       max2,
            clampNum:                   clampNum,
            safeTypeOf:                 safeTypeOf,
            isObjectLike:               isObjectLike,
            isJavaMapLike:              isJavaMapLike,
            isArrayLike:                isArrayLike,
            isJavaListLike:             isJavaListLike,
            normalizeDim:               normalizeDim,
            parseFiniteNum:             parseFiniteNum,
            parseNonNegNum:             parseNonNegNum,
            parseBoolStrict:            parseBoolStrict,
            parseBool:                  parseBool,
            parsePriority:              parsePriority,
            parseTicks:                 parseTicks,
            parseTicksOrSec:            parseTicksOrSec,
            parseColor:                 parseColor,
            parseArgbColor:             parseArgbColor,
            parseSize:                  parseSize,
            parseTilt:                  parseTilt,
            parseCommandSpec:           parseCommandSpec,
            computeSphereMergeClusters: computeSphereMergeClusters
        };

        // 客户端原生 Forge 前置渲染相位桥接（仅在客户端首次启动阶段挂接一次，专用服自动跳过）：
        //   KubeJS ClientEvents.paintScreen 绑定于 RenderGuiEvent$Post / ScreenEvent$Render$Post，
        //   绘制时机必然晚于原版物品栏/血条/小地图与 GUI 界面；此处在 startup 阶段通过 ForgeEvents
        //   挂接 RenderGuiEvent$Pre 并动态转发给 global.Epiphy2DRenderer._onRenderGuiPre(event)，
        //   使默认弹幕 (renderPriority: 0) 与默认自绘 HUD (renderPriority: 50) 均绘制在原版 HUD 与 GUI 之下，
        //   同时保持自绘 HUD 位于弹幕之上；renderPriority >= aboveVanillaHudPriority (100) 时自动进入 Post 层。
        if (global.EpiphyRenderHooks == null || typeof global.EpiphyRenderHooks !== 'object') {
            global.EpiphyRenderHooks = {
                preHudActive:     false,
                preHudRegistered: false,
                registered:       false
            };
        }
        if (typeof ForgeEvents !== 'undefined' && ForgeEvents != null &&
            typeof ForgeEvents.onEvent === 'function') {
            var isClientEnv = false;
            try {
                if (typeof Platform !== 'undefined' && Platform != null && typeof Platform.isClientEnvironment === 'function') {
                    isClientEnv = Boolean(Platform.isClientEnvironment());
                }
            } catch (eCliCheck) {
                isClientEnv = false;
            }
            if (isClientEnv) {
                if (!global.EpiphyRenderHooks.preHudRegistered && !global.EpiphyRenderHooks.registered) {
                    try {
                        ForgeEvents.onEvent('net.minecraftforge.client.event.RenderGuiEvent$Pre', function (forgeEvent) {
                            var r2d = (typeof global !== 'undefined' && global != null) ? global.Epiphy2DRenderer : null;
                            if (r2d != null && typeof r2d._onRenderGuiPre === 'function') {
                                r2d._onRenderGuiPre(forgeEvent);
                            }
                        });
                        global.EpiphyRenderHooks.preHudActive     = true;
                        global.EpiphyRenderHooks.preHudRegistered = true;
                        global.EpiphyRenderHooks.registered       = true;
                    } catch (ePreHook) {
                        global.EpiphyRenderHooks.preHudActive = false;
                        try {
                            console.warn('[EpiphySpec] RenderGuiEvent$Pre 桥接挂接失败，客户端将自动回退至 ClientEvents.paintScreen: ' + ePreHook);
                        } catch (eLogHook) { }
                    }
                }
            }
        }
    }
})();
