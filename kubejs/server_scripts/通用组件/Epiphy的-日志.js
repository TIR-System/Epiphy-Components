// priority: 1100
// ============================================================================
//  通用限频日志与调试中心 (EpiphyLog v1.1)
//  所属系列：Epiphy的-通用组件系列（本系列包含 startup / server / client 配套脚本）
//  [LLM 协作规范] 每次进行较大修改或重构前，请先将修改同步至 D:\Git-Epiphy 并执行 git commit 保存当前可用状态，便于随时回退与对比 diff。
//  许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
//  放置位置：kubejs/server_scripts/通用组件/Epiphy的-日志.js
//
//  职责说明：
//    1. 为 Epiphy的-通用组件系列提供统一的限频警告、错误、信息与已捕获异常日志；
//    2. 区分“预期外但已处理的异常”(catchWarn -> console.warn，不染红、不计入脚本错误数)
//       与“不可恢复的硬错误”(error -> console.error)；
//    3. 提供按 key 去重的单次日志 (once) 与按模块开关的调试日志 (debug / setDebug)；
//    4. 提供独立于控制台的外部文件持久化接收器（`configureFileSink` / `getFileSinkConfig`），默认按天向 `epiphy-data/logs/YYYY-MM-DD.log` 写入可读日志（可配置为 `hourly` / `single` / `off`），并支持初始化前缓冲。
//
//  依赖与缺失影响：
//    - 本文件无前置脚本依赖（priority: 1100）。
//    - 若缺失本文件：同系列下游组件会自动回退至内联 console.warn / console.error 兜底输出，
//      核心功能不受影响，但失去统一限频、once 去重、玩家提示限频与按模块 debug 开关能力。
//
//  [Rhino 语法兼容性约定] KubeJS 2001.6.x 内置 Rhino 对 ES6 支持不完整且存在语义偏差（如 `let`/`const`
//    的 TDZ 与循环闭包语义偏差）。故本系列变量统一使用 `var`，本模块维持纯 ES5 以保证各加载阶段稳定互操作；
//    同系列音频模块另使用经实测稳定的 ES6 子集（`=>` / 模板字符串 / `for..of`）。修改时请勿引入 `let`/`const`。
// ============================================================================

;(function () {
    var DEFAULT_INTERVAL_MS = 5000
    var buckets             = {} // '<module>|<level>|<tag>' -> { lastAt, suppressed }
    var playerBuckets       = {} // '<module>|<level>|<tag>|<playerKey>' -> { lastAt, suppressed }
    var onceKeys            = {} // '<key>' -> true
    var debugModules        = {} // '<module>' or '*' -> boolean

    var fileSink = {
        configured:       false,
        enabled:          true,
        mode:             'daily', // 'daily' | 'hourly' | 'single' | 'off'
        dir:              '',
        fileExtension:    '.log',
        includeDebug:     false,
        writer:           null,
        maxBufferedLines: 200,
        buffered:         [],
        writtenLines:     0,
        lastFilePath:     '',
        lastError:        ''
    }

    var FILE_CLASS   = null
    var FILES_CLASS  = null
    var PATHS_CLASS  = null
    var CHARSET_UTF8 = null
    var OPEN_OPTS    = null
    var javaIoProbed = false

    function ensureJavaFileIo() {
        if (javaIoProbed) return (FILES_CLASS != null && PATHS_CLASS != null)
        javaIoProbed = true
        if (typeof Java === 'undefined' || Java == null || typeof Java.loadClass !== 'function') {
            return false
        }
        try {
            FILE_CLASS   = Java.loadClass('java.io.File')
            FILES_CLASS  = Java.loadClass('java.nio.file.Files')
            PATHS_CLASS  = Java.loadClass('java.nio.file.Paths')
            var stdCs    = Java.loadClass('java.nio.charset.StandardCharsets')
            CHARSET_UTF8 = stdCs != null ? stdCs.UTF_8 : null
            var openOpt  = Java.loadClass('java.nio.file.StandardOpenOption')
            if (openOpt != null) {
                OPEN_OPTS = [openOpt.CREATE, openOpt.APPEND]
            }
        } catch (eJava) {
            FILES_CLASS = null
            PATHS_CLASS = null
        }
        return (FILES_CLASS != null && PATHS_CLASS != null)
    }

    function pad2(n) {
        return n < 10 ? ('0' + n) : String(n)
    }

    function pad3(n) {
        if (n < 10) return '00' + n
        if (n < 100) return '0' + n
        return String(n)
    }

    function formatNowParts(dateObj) {
        var d    = dateObj || new Date()
        var yyyy = d.getFullYear()
        var mm   = pad2(d.getMonth() + 1)
        var dd   = pad2(d.getDate())
        var hh   = pad2(d.getHours())
        var mi   = pad2(d.getMinutes())
        var ss   = pad2(d.getSeconds())
        var ms   = pad3(d.getMilliseconds())
        return {
            dateStr: yyyy + '-' + mm + '-' + dd,
            hourStr: yyyy + '-' + mm + '-' + dd + '_' + hh,
            ts:      yyyy + '-' + mm + '-' + dd + ' ' + hh + ':' + mi + ':' + ss + '.' + ms
        }
    }

    function sanitizeExtension(ext) {
        var s = ext != null ? String(ext).trim() : '.log'
        if (!s) return '.log'
        if (s.charAt(0) !== '.') s = '.' + s
        s = s.replace(/[^a-zA-Z0-9._-]+/g, '')
        return s.length > 1 ? s : '.log'
    }

    function normalizeMode(raw) {
        var m = raw != null ? String(raw).trim().toLowerCase() : 'daily'
        if (m === 'daily' || m === 'hourly' || m === 'single' || m === 'off') return m
        return 'daily'
    }

    function resolveTargetLogPath(parts) {
        if (!fileSink.dir || !fileSink.enabled || fileSink.mode === 'off') return ''
        var baseDir = String(fileSink.dir).replace(/\\/g, '/').replace(/\/+$/, '')
        var ext     = fileSink.fileExtension
        if (fileSink.mode === 'hourly') return baseDir + '/' + parts.hourStr + ext
        if (fileSink.mode === 'single') return baseDir + '/epiphy' + ext
        return baseDir + '/' + parts.dateStr + ext
    }

    function writeLineToDisk(filePath, line) {
        if (!filePath) return false
        try {
            if (typeof fileSink.writer === 'function') {
                fileSink.writer(filePath, line)
                fileSink.writtenLines++
                fileSink.lastFilePath = filePath
                return true
            }
            if (ensureJavaFileIo()) {
                var p = PATHS_CLASS.get(String(filePath))
                if (FILE_CLASS != null) {
                    var jf = new FILE_CLASS(String(filePath))
                    var parent = jf.getParentFile()
                    if (parent != null && !parent.exists()) parent.mkdirs()
                }
                if (typeof FILES_CLASS.writeString === 'function' && CHARSET_UTF8 != null && OPEN_OPTS != null) {
                    FILES_CLASS.writeString(p, line, CHARSET_UTF8, OPEN_OPTS[0], OPEN_OPTS[1])
                    fileSink.writtenLines++
                    fileSink.lastFilePath = filePath
                    return true
                }
            }
        } catch (eWrite) {
            fileSink.lastError = String(eWrite)
        }
        return false
    }

    function formatFileLine(ts, level, text) {
        var lvl = String(level || 'warn').toUpperCase()
        while (lvl.length < 5) lvl += ' '
        return '[' + ts + '] [' + lvl + '] ' + String(text).replace(/[\r\n]+/g, ' | ') + '\n'
    }

    function recordFileLog(level, text) {
        if (!fileSink.enabled || fileSink.mode === 'off') return
        if (level === 'debug' && !fileSink.includeDebug) return
        var parts = formatNowParts(new Date())
        if (!fileSink.configured || !fileSink.dir) {
            if (fileSink.buffered.length < fileSink.maxBufferedLines) {
                fileSink.buffered.push({ parts: parts, level: level, text: String(text) })
            }
            return
        }
        var targetPath = resolveTargetLogPath(parts)
        if (!targetPath) return
        writeLineToDisk(targetPath, formatFileLine(parts.ts, level, text))
    }

    function flushBufferedLogs() {
        if (!fileSink.configured || !fileSink.dir || fileSink.buffered.length === 0) return
        var pending = fileSink.buffered.slice()
        fileSink.buffered.length = 0
        if (!fileSink.enabled || fileSink.mode === 'off') return
        for (var i = 0; i < pending.length; i++) {
            var item = pending[i]
            if (item.level === 'debug' && !fileSink.includeDebug) continue
            var targetPath = resolveTargetLogPath(item.parts)
            if (targetPath) {
                writeLineToDisk(targetPath, formatFileLine(item.parts.ts, item.level, item.text))
            }
        }
    }

    function configureFileSink(cfg) {
        if (cfg == null || typeof cfg !== 'object') return getFileSinkConfig()
        if (cfg.enabled !== undefined) fileSink.enabled = Boolean(cfg.enabled)
        if (cfg.mode !== undefined) fileSink.mode = normalizeMode(cfg.mode)
        if (cfg.dir !== undefined && cfg.dir != null) {
            fileSink.dir = String(cfg.dir).replace(/\\/g, '/').replace(/\/+$/, '')
        }
        if (cfg.fileExtension !== undefined) fileSink.fileExtension = sanitizeExtension(cfg.fileExtension)
        if (cfg.includeDebug !== undefined) fileSink.includeDebug = Boolean(cfg.includeDebug)
        if (typeof cfg.writer === 'function') fileSink.writer = cfg.writer
        else if (cfg.writer === null) fileSink.writer = null
        fileSink.configured = true
        flushBufferedLogs()
        return getFileSinkConfig()
    }

    function getFileSinkConfig() {
        return {
            configured:    fileSink.configured,
            enabled:       fileSink.enabled,
            mode:          fileSink.mode,
            dir:           fileSink.dir,
            fileExtension: fileSink.fileExtension,
            includeDebug:  fileSink.includeDebug,
            writtenLines:  fileSink.writtenLines,
            bufferedCount: fileSink.buffered.length,
            lastFilePath:  fileSink.lastFilePath,
            lastError:     fileSink.lastError
        }
    }

    function normKey(s, fallback) {
        if (s == null) return fallback || ''
        var t = String(s).trim()
        return t.length > 0 ? t : (fallback || '')
    }

    // 【catch 约定】日志设施自身的兜底：console / player.tell 不可用时已无更低层可退，
    // 玩家键提取仅做属性能力探测，均属预期分支，留空避免递归报错。
    function emitConsole(level, text) {
        try {
            if (level === 'error') {
                console.error(text)
            } else if (level === 'info' || level === 'debug') {
                console.info(text)
            } else {
                console.warn(text)
            }
        } catch (e) { }
        recordFileLog(level, text)
    }

    function getPlayerKey(player) {
        if (player == null) return 'anon'
        try {
            if (typeof player.getStringUUID === 'function') return String(player.getStringUUID())
        } catch (e0) { }
        try {
            if (player.username != null) return String(player.username)
        } catch (e1) { }
        return 'anon'
    }

    function notify(player, text) {
        if (player == null) return
        try {
            player.tell(Text.of('§c' + text))
        } catch (e) { }
    }

    function logRateLimited(level, moduleName, tag, msg, notifyPlayer, intervalMs) {
        var mod      = normKey(moduleName, 'Epiphy')
        var tagStr   = normKey(tag, 'general')
        var fullMsg  = '[' + mod + ' ' + tagStr + '] ' + String(msg)
        var interval = (typeof intervalMs === 'number' && isFinite(intervalMs) && intervalMs >= 0)
            ? intervalMs
            : DEFAULT_INTERVAL_MS
        var bKey     = mod + '|' + level + '|' + tagStr
        var bucket   = buckets[bKey]
        if (bucket == null) {
            bucket = { lastAt: 0, suppressed: 0 }
            buckets[bKey] = bucket
        }

        var now = Date.now()
        if (interval === 0 || (now - bucket.lastAt) >= interval) {
            var tail = bucket.suppressed > 0 ? (' (另有 ' + bucket.suppressed + ' 次同类日志被折叠)') : ''
            bucket.lastAt     = now
            bucket.suppressed = 0
            emitConsole(level, fullMsg + tail)
        } else {
            bucket.suppressed++
        }

        if (notifyPlayer != null) {
            var pKey    = bKey + '|' + getPlayerKey(notifyPlayer)
            var pBucket = playerBuckets[pKey]
            if (pBucket == null) {
                pBucket = { lastAt: 0, suppressed: 0 }
                playerBuckets[pKey] = pBucket
            }
            if (interval === 0 || (now - pBucket.lastAt) >= interval) {
                var pTail = pBucket.suppressed > 0 ? (' (另有 ' + pBucket.suppressed + ' 次同类提示被折叠)') : ''
                pBucket.lastAt     = now
                pBucket.suppressed = 0
                notify(notifyPlayer, fullMsg + pTail)
            } else {
                pBucket.suppressed++
            }
        }
        return null
    }

    function warn(moduleName, tag, msg, notifyPlayer, intervalMs) {
        return logRateLimited('warn', moduleName, tag, msg, notifyPlayer, intervalMs)
    }

    function error(moduleName, tag, msg, notifyPlayer, intervalMs) {
        return logRateLimited('error', moduleName, tag, msg, notifyPlayer, intervalMs)
    }

    function info(moduleName, tag, msg) {
        var mod    = normKey(moduleName, 'Epiphy')
        var tagStr = normKey(tag, '')
        var prefix = tagStr ? ('[' + mod + ' ' + tagStr + '] ') : ('[' + mod + '] ')
        emitConsole('info', prefix + String(msg))
    }

    // 预期外但已被 catch 安全兜底处理的异常：语义为 warn，避免 console.error 在 KubeJS 中染红并计入脚本错误数
    function catchWarn(moduleName, tag, err, notifyPlayer, intervalMs) {
        var mod    = normKey(moduleName, 'Epiphy')
        var tagStr = normKey(tag, 'unknown')
        return logRateLimited('warn', mod, '异常:' + tagStr, String(err), notifyPlayer, intervalMs)
    }

    function once(level, key, msg) {
        var k = normKey(key, 'default')
        if (onceKeys[k]) return false
        onceKeys[k] = true
        emitConsole(level || 'warn', String(msg))
        return true
    }

    function setDebug(moduleOrBool, enabled) {
        if (typeof moduleOrBool === 'boolean') {
            debugModules['*'] = moduleOrBool
            return moduleOrBool
        }
        var mod = normKey(moduleOrBool, '*')
        var val = (enabled === undefined) ? true : Boolean(enabled)
        debugModules[mod] = val
        return val
    }

    function isDebug(moduleName) {
        if (debugModules['*'] === true) return true
        var mod = normKey(moduleName, '')
        return Boolean(mod && debugModules[mod] === true)
    }

    function debug(moduleName, tag, msg) {
        if (!isDebug(moduleName)) return false
        var mod    = normKey(moduleName, 'Epiphy')
        var tagStr = normKey(tag, 'debug')
        emitConsole('debug', '[' + mod + ' DEBUG:' + tagStr + '] ' + String(msg))
        return true
    }

    function reset() {
        buckets       = {}
        playerBuckets = {}
        onceKeys      = {}
    }

    function getStats() {
        var bucketCount           = 0
        var totalSuppressed       = 0
        var playerBucketCount     = 0
        var totalPlayerSuppressed = 0
        for (var bk in buckets) {
            if (Object.prototype.hasOwnProperty.call(buckets, bk)) {
                bucketCount++
                totalSuppressed += (buckets[bk].suppressed || 0)
            }
        }
        for (var pk in playerBuckets) {
            if (Object.prototype.hasOwnProperty.call(playerBuckets, pk)) {
                playerBucketCount++
                totalPlayerSuppressed += (playerBuckets[pk].suppressed || 0)
            }
        }
        var activeDbg = []
        for (var dk in debugModules) {
            if (Object.prototype.hasOwnProperty.call(debugModules, dk) && debugModules[dk] === true) {
                activeDbg.push(dk)
            }
        }
        return {
            defaultIntervalMs:     DEFAULT_INTERVAL_MS,
            bucketCount:           bucketCount,
            totalSuppressed:       totalSuppressed,
            playerBucketCount:     playerBucketCount,
            totalPlayerSuppressed: totalPlayerSuppressed,
            onceKeyCount:          Object.keys(onceKeys).length,
            activeDebugModules:    activeDbg
        }
    }

    var api = {
        DEFAULT_INTERVAL_MS: DEFAULT_INTERVAL_MS,
        warn:                warn,
        error:               error,
        info:                info,
        catchWarn:           catchWarn,
        once:                once,
        setDebug:            setDebug,
        isDebug:             isDebug,
        debug:               debug,
        reset:               reset,
        configureFileSink:   configureFileSink,
        getFileSinkConfig:   getFileSinkConfig,
        getStats:            getStats
    }

    global.EpiphyLog    = api
    global.EpiphyLogger = api

    // 动态上报自身统计到统一调试组件 (EpiphyDebug)
    var logDebugProvider = {
        name:    'log',
        label:   '限频日志中心',
        order:   10,
        summary: function () {
            var s = getStats()
            return 'buckets=' + s.bucketCount +
                ' | suppressed=' + s.totalSuppressed +
                ' | onceKeys=' + s.onceKeyCount +
                ' | debug=[' + (s.activeDebugModules.join(',') || 'off') + ']'
        },
        detail: function () {
            var s = getStats()
            return [
                'defaultIntervalMs: ' + s.defaultIntervalMs,
                'buckets: ' + s.bucketCount + ' (suppressed=' + s.totalSuppressed + ')',
                'playerBuckets: ' + s.playerBucketCount + ' (suppressed=' + s.totalPlayerSuppressed + ')',
                'onceKeys: ' + s.onceKeyCount,
                'activeDebugModules: ' + (s.activeDebugModules.join(', ') || '（全部关闭）')
            ]
        },
        metrics: getStats,
        check: function () {
            var s = getStats()
            return [{
                name:   'suppressed_volume',
                ok:     s.totalSuppressed < 5000,
                detail: 'totalSuppressed=' + s.totalSuppressed + ', buckets=' + s.bucketCount
            }]
        },
        actions: {
            reset: {
                desc: '清空限频桶与 once 去重记录',
                fn: function () {
                    reset()
                    return '已重置 EpiphyLog 限频桶与 once 缓存'
                }
            }
        }
    }
    if (global.EpiphyDebug != null && typeof global.EpiphyDebug.registerProvider === 'function') {
        global.EpiphyDebug.registerProvider(logDebugProvider)
    } else {
        if (!Array.isArray(global.EpiphyDebugProviderQueue)) global.EpiphyDebugProviderQueue = []
        global.EpiphyDebugProviderQueue.push(logDebugProvider)
    }
})()
