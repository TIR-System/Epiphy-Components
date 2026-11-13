// priority: 1100
// ============================================================================
//  通用限频日志与调试中心 (EpiphyLog v1)
//  所属系列：Epiphy的-通用组件系列（本系列包含 startup / server / client 配套脚本）
//  [LLM 协作规范] 每次进行较大修改或重构前，请先将修改同步至 D:\Git-Epiphy 并执行 git commit 保存当前可用状态，便于随时回退与对比 diff。
//  许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
//  放置位置：kubejs/server_scripts/通用组件/Epiphy的-日志.js
//
//  职责说明：
//    1. 为 Epiphy的-通用组件系列提供统一的限频警告、错误、信息与已捕获异常日志；
//    2. 区分“预期外但已处理的异常”(catchWarn -> console.warn，不染红、不计入脚本错误数)
//       与“不可恢复的硬错误”(error -> console.error)；
//    3. 提供按 key 去重的单次日志 (once) 与按模块开关的调试日志 (debug / setDebug)。
//
//  依赖与缺失影响：
//    - 本文件无前置脚本依赖（priority: 1100）。
//    - 若缺失本文件：同系列下游组件会自动回退至内联 console.warn / console.error 兜底输出，
//      核心功能不受影响，但失去统一限频、once 去重、玩家提示限频与按模块 debug 开关能力。
// ============================================================================

;(function () {
    var DEFAULT_INTERVAL_MS = 5000
    var buckets             = {} // '<module>|<level>|<tag>' -> { lastAt, suppressed }
    var playerBuckets       = {} // '<module>|<level>|<tag>|<playerKey>' -> { lastAt, suppressed }
    var onceKeys            = {} // '<key>' -> true
    var debugModules        = {} // '<module>' or '*' -> boolean

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
        reset:               reset
    }

    global.EpiphyLog    = api
    global.EpiphyLogger = api
})()
