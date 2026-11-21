// priority: 1100
// ============================================================================
//  通用限频日志与调试中心 (EpiphyLog v1.2.0)
//  所属系列：Epiphy的-通用组件系列（本系列包含 startup / server / client 配套脚本）
//  许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
//  放置位置：kubejs/server_scripts/通用组件/Epiphy的-日志.js
//
//  职责说明：
//    1. 为 Epiphy的-通用组件系列提供统一的限频警告、错误、信息与已捕获异常日志；
//    2. 区分“预期外但已处理的异常”(catchWarn -> console.warn，不染红、不计入脚本错误数)
//       与“不可恢复的硬错误”(error -> console.error)；
//    3. 提供按 key 去重的单次日志 (once) 与按模块开关的调试日志 (debug / setDebug)；
//    4. 提供独立于控制台的外部文件持久化接收器（`configureFileSink` / `getFileSinkConfig`），支持 NIO 文本写盘与 KubeJS `ClassFilter` 环境下的 `KubeJSPaths.dir` + `JsonIO` 持久化降级，并随世界上下文自动切换至对应世界的 `logs/` 子目录，支持初始化前缓冲。
//
//  依赖与缺失影响：
//    - 本文件无前置脚本依赖（priority: 1100）。
//    - 若缺失本文件：同系列下游组件会自动回退至内联 console.warn / console.error 兜底输出，
//      核心功能不受影响，但失去统一限频、once 去重、玩家提示限频与按模块 debug 开关能力。
//
//  [语法规范] 遵循 README-LLM.md §1 强制语法基准（与 docs/kube-mods-rhino-es5-es6-compatibility.md）：
//    全仓以 ES5 + `var` 为主，可按需谨慎使用经实测无语义偏移的 ES6/ES2020 扩展语法；
//    严禁使用 `??`、`let`/`const`、对象属性简写/计算属性、展开与默认参数等已确认高危/失效特性。
// ============================================================================

;(function () {
    var DEFAULT_INTERVAL_MS = 5000
    var MAX_BUCKET_ENTRIES  = 2048
    var buckets             = {} // '<module>|<level>|<tag>' -> { lastAt, suppressed }
    var playerBuckets       = {} // '<module>|<level>|<tag>|<playerKey>' -> { lastAt, suppressed }
    var onceKeys            = {} // '<key>' -> true
    var debugModules        = {} // '<module>' or '*' -> boolean
    var deprecationWarnEnabled = false

    function evictFirstKeyIfFull(mapObj) {
        var keys = Object.keys(mapObj)
        if (keys.length >= MAX_BUCKET_ENTRIES) {
            delete mapObj[keys[0]]
        }
    }

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

    var FILE_CLASS         = null
    var FILES_CLASS        = null
    var PATHS_CLASS        = null
    var CHARSET_UTF8       = null
    var OPEN_OPTS          = null
    var KUBEJS_PATHS_CLASS = null
    var javaIoProbed       = false
    var kubeJsPathsProbed  = false
    var jsonLogCache       = {}
    var MAX_JSON_LOG_LINES = 2000

    function ensureKubeJsPaths() {
        if (kubeJsPathsProbed) return KUBEJS_PATHS_CLASS != null
        kubeJsPathsProbed = true
        if (typeof Java === 'undefined' || Java == null || typeof Java.loadClass !== 'function') {
            return false
        }
        try {
            KUBEJS_PATHS_CLASS = Java.loadClass('dev.latvian.mods.kubejs.KubeJSPaths')
        } catch (eKj) {
            KUBEJS_PATHS_CLASS = null
        }
        return KUBEJS_PATHS_CLASS != null
    }

    function ensureJavaFileIo() {
        if (javaIoProbed) return (FILES_CLASS != null && PATHS_CLASS != null)
        javaIoProbed = true
        ensureKubeJsPaths()
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

    function ensureDirViaKubeJs(filePath) {
        ensureKubeJsPaths()
        if (KUBEJS_PATHS_CLASS == null) return false
        var norm = String(filePath).replace(/\\/g, '/')
        var slashIdx = norm.lastIndexOf('/')
        if (slashIdx <= 0) return false
        var parentDir = norm.slice(0, slashIdx)
        if (!/^(?:[a-zA-Z]:[\\/]|\/)/.test(parentDir)) return false
        try {
            if (typeof KUBEJS_PATHS_CLASS.dir !== 'function') return false
            KUBEJS_PATHS_CLASS.dir(parentDir)
            return true
        } catch (eDir) {
            return false
        }
    }

    function loadExistingJsonLogLines(filePath) {
        if (Object.prototype.hasOwnProperty.call(jsonLogCache, filePath)) {
            return jsonLogCache[filePath]
        }
        var lines = []
        if (typeof JsonIO !== 'undefined' && JsonIO != null && typeof JsonIO.readString === 'function') {
            try {
                var raw = JsonIO.readString(String(filePath))
                if (raw != null && String(raw).trim() !== '') {
                    var parsed = JSON.parse(String(raw))
                    if (parsed != null && Array.isArray(parsed.entries)) {
                        for (var i = 0; i < parsed.entries.length; i++) {
                            lines.push(String(parsed.entries[i]))
                        }
                    } else if (Array.isArray(parsed)) {
                        for (var j = 0; j < parsed.length; j++) {
                            lines.push(String(parsed[j]))
                        }
                    }
                }
            } catch (eSeed) { }
        }
        jsonLogCache[filePath] = lines
        return lines
    }

    function writeLineToDisk(filePath, line, parts) {
        if (!filePath) return false
        try {
            if (typeof fileSink.writer === 'function') {
                fileSink.writer(filePath, line)
                fileSink.writtenLines++
                fileSink.lastFilePath = filePath
                fileSink.lastError = ''
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
                    fileSink.lastError = ''
                    return true
                }
            }
            // KubeJS 2001.6.x ClassFilter 默认屏蔽 java.io / java.nio.file：回退为 KubeJSPaths.dir + JsonIO 写盘，避免产生文件锁
            if (typeof JsonIO !== 'undefined' && JsonIO != null && typeof JsonIO.write === 'function') {
                ensureDirViaKubeJs(filePath)
                var cachedLines = loadExistingJsonLogLines(filePath)
                var cleanLine = String(line).replace(/[\r\n]+$/, '')
                if (cleanLine) cachedLines.push(cleanLine)
                if (cachedLines.length > MAX_JSON_LOG_LINES) {
                    cachedLines.splice(0, cachedLines.length - MAX_JSON_LOG_LINES)
                }
                var tsNow = (parts && parts.ts) ? parts.ts : formatNowParts(new Date()).ts
                JsonIO.write(String(filePath), {
                    format:    'epiphy-log-v1',
                    updatedAt: tsNow,
                    count:     cachedLines.length,
                    entries:   cachedLines
                })
                fileSink.writtenLines++
                fileSink.lastFilePath = filePath
                fileSink.lastError = ''
                return true
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
        writeLineToDisk(targetPath, formatFileLine(parts.ts, level, text), parts)
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
                writeLineToDisk(targetPath, formatFileLine(item.parts.ts, item.level, item.text), item.parts)
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
            evictFirstKeyIfFull(buckets)
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
                evictFirstKeyIfFull(playerBuckets)
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
        evictFirstKeyIfFull(onceKeys)
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

    function setDeprecationWarnings(enabled) {
        deprecationWarnEnabled = Boolean(enabled)
        return deprecationWarnEnabled
    }

    function isDeprecationWarningsEnabled(moduleName) {
        if (deprecationWarnEnabled === true) return true
        if (isDebug('deprecations')) return true
        if (moduleName && isDebug(moduleName)) return true
        return false
    }

    function warnDeprecatedOnce(moduleName, depKey, msg) {
        if (!isDeprecationWarningsEnabled(moduleName)) return false
        var mod = normKey(moduleName, 'Epiphy')
        return once('warn', depKey, '[' + mod + ' 淘汰警告] ' + String(msg))
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

    var VERSION = '1.2.0'

    var api = {
        VERSION:             VERSION,
        DEFAULT_INTERVAL_MS: DEFAULT_INTERVAL_MS,
        warn:                warn,
        error:               error,
        info:                info,
        catchWarn:           catchWarn,
        once:                         once,
        setDeprecationWarnings:       setDeprecationWarnings,
        isDeprecationWarningsEnabled: isDeprecationWarningsEnabled,
        warnDeprecatedOnce:           warnDeprecatedOnce,
        setDebug:                     setDebug,
        isDebug:                      isDebug,
        debug:                        debug,
        reset:                        reset,
        configureFileSink:            configureFileSink,
        getFileSinkConfig:            getFileSinkConfig,
        getStats:                     getStats
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
