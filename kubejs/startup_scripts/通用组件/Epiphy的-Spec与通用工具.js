// priority: 1180
// ============================================================================
// Epiphy 通用规范与纯逻辑基座 (EpiphySpec)
//   所属阶段：startup_scripts（服务端与客户端共享）
//   硬依赖  ：global.EpiphyProtocol (Epiphy的-协议常量.js, priority >= 1200)
//   定位    ：收拢跨组件重复的数值/布尔/时长/颜色/字号/倾角/命令解析器与球簇合并几何算法
//   约束    ：严格 Rhino ES5（禁止 let/const、箭头函数、模板字符串、展开运算符）
// ============================================================================

;(function () {
    'use strict';

    var proto = (typeof global !== 'undefined') ? global.EpiphyProtocol : null;
    if (!proto) {
        throw new Error('[EpiphySpec] 缺少硬依赖 global.EpiphyProtocol，请确认 Epiphy的-协议常量.js 已加载');
    }

    var PRIORITY_MAP = proto.PRIORITY_MAP || {
        normal:    0,
        urgent:    1,
        replace:   2,
        interrupt: 2
    };

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

    function isArrayLike(x) {
        if (!x || typeof x !== 'object') return false;
        if (Array.isArray(x)) return true;
        return typeof x.length === 'number' && x.length >= 0 && isFinite(x.length) && Math.floor(x.length) === x.length;
    }

    function isJavaListLike(x) {
        return Boolean(x && typeof x === 'object' && typeof x.size === 'function' && typeof x.get === 'function');
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
        var lo = (opts && opts.min !== undefined && opts.min !== null) ? opts.min : 0;
        var hi = (opts && opts.max !== undefined && opts.max !== null) ? opts.max : 10;
        var doRound = !(opts && opts.round === false);

        if (typeof raw === 'string') {
            var s = raw.trim().toLowerCase();
            if (!s) return def;
            if (map && hasOwn(map, s)) {
                return clampNum(map[s], lo, hi, def);
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

    function parseColor(val, defColor, presets) {
        var def = (typeof defColor === 'number' && isFinite(defColor)) ? (defColor & 0xFFFFFF) : 0xFFFFFF;
        var presetMap = presets || COLOR_PRESETS;
        if (val === null || val === undefined || val === '' || typeof val === 'boolean') {
            return { color: def, isRandom: false };
        }
        if (typeof val === 'number') {
            if (!isFinite(val)) return { color: def, isRandom: false };
            return { color: (Math.floor(val) & 0xFFFFFF), isRandom: false };
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
                return { color: parseInt(h, 16) & 0xFFFFFF, isRandom: false };
            }
            return { color: def, isRandom: false };
        }
        if (/^0x[0-9a-f]{1,8}$/.test(s)) {
            return { color: parseInt(s, 16) & 0xFFFFFF, isRandom: false };
        }
        if (/^[0-9a-f]{6}$/.test(s)) {
            return { color: parseInt(s, 16) & 0xFFFFFF, isRandom: false };
        }
        return { color: def, isRandom: false };
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
                    var dy = a.cy - b.cy;
                    var dz = a.cz - b.cz;
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

    if (typeof global !== 'undefined') {
        global.EpiphySpec = {
            COLOR_PRESETS:              COLOR_PRESETS,
            SIZE_PRESETS:               SIZE_PRESETS,
            PRIORITY_MAP:               PRIORITY_MAP,
            min2:                       min2,
            max2:                       max2,
            clampNum:                   clampNum,
            isArrayLike:                isArrayLike,
            normalizeDim:               normalizeDim,
            parseFiniteNum:             parseFiniteNum,
            parseNonNegNum:             parseNonNegNum,
            parseBoolStrict:            parseBoolStrict,
            parseBool:                  parseBool,
            parsePriority:              parsePriority,
            parseTicks:                 parseTicks,
            parseTicksOrSec:            parseTicksOrSec,
            parseColor:                 parseColor,
            parseSize:                  parseSize,
            parseTilt:                  parseTilt,
            parseCommandSpec:           parseCommandSpec,
            computeSphereMergeClusters: computeSphereMergeClusters
        };
    }
})();
