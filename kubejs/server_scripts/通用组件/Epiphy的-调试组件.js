// priority: 950
// ============================================================================
//  通用调试与性能诊断组件 (EpiphyDebug v1)
//  所属系列：Epiphy的-通用组件系列（本系列包含 startup / server / client 配套脚本）
//  [LLM 协作规范] 每次进行较大修改或重构前，请先将修改同步至 D:\Git-Epiphy 并执行 git commit 保存当前可用状态，便于随时回退与对比 diff。
//  许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
//  放置位置：kubejs/server_scripts/通用组件/Epiphy的-调试组件.js
//
//  职责说明：
//    1. 提供统一的动态调试提供者注册表 (registerProvider / global.EpiphyDebugProviderQueue)，
//       使上下游各组件无需彼此耦合即可动态上报运行时指标、耗时统计、健康自检与维护动作；
//    2. 默认向权限阀 (EpiphyPermissionValve) 注册管理员专属子命令 `/epiphy debug`：
//         - `/epiphy debug` / `status`             : 查看全局摘要与全模块关键性能指标
//         - `/epiphy debug module <名>`            : 查看单模块完整详细指标、自检与可用动作
//         - `/epiphy debug checks`                 : 执行全部已注册模块的健康检查
//         - `/epiphy debug log <模块|*> <on|off>`  : 统一切换 EpiphyLog 模块级调试日志开关
//         - `/epiphy debug action <模块> <动作>`    : 触发模块注册的维护动作（如 rescan / clearcache 等）
//    3. 同时导出 JS API `global.EpiphyDebug`，供脚本诊断或节点单元测试调用。
//
//  依赖与缺失影响：
//    - 强依赖服务端事件循环与 KubeJS `global` 对象。
//    - 可选依赖：kubejs/server_scripts/通用组件/Epiphy的-日志.js (EpiphyLog, priority: 1100)
//    - 可选依赖：kubejs/server_scripts/通用组件/Epiphy的-权限阀.js (EpiphyPermissionValve, priority: 1000)
//    - 若缺失权限阀：`/epiphy debug` 游戏内指令不会挂载，但各模块上报的数据仍可通过 `global.EpiphyDebug.collectSnapshot()` 在 JS 侧读取。
//
//  [Rhino 语法兼容性约定] KubeJS 2001.6.x 内置 Rhino 对 ES6 支持不完整且存在语义偏差（如 `let`/`const`
//    语义不完备，部分扩展语法会在 Java/Brigadier 回调包装中退化）。故全系列变量统一使用 `var`，本模块维持 ES5 +
//    `Map`/`Set` 写法；同系列音频模块采用经实测稳定的 ES6 子集（`=>` / 模板字符串 / `for..of`）。请勿引入 `let`/`const`。
// ============================================================================

;(function () {
    var BASE = (typeof global !== 'undefined') ? global.EpiphyServerBase : null
    if (!BASE) {
        throw new Error('[EpiphyDebug] 缺少硬依赖 global.EpiphyServerBase，请确认 server_scripts/通用组件/Epiphy的-服务端基础.js 已加载')
    }

    var LOGGER        = BASE.createLogger('EpiphyDebug', 5000)
    var providers     = new Map() // key -> providerRecord
    var providerOrder = []
    var SERVER_REF    = null

    function normalizeName(raw) {
        if (raw == null) return ''
        return String(raw).trim().toLowerCase()
    }

    function logCatch(tag, err) {
        LOGGER.catchWarn(tag, err)
    }

    function sendSourceMsg(source, text) {
        if (source == null) return
        try {
            source.sendSuccess(Text.of(String(text)), false)
        } catch (e) {
            logCatch('sendSourceMsg', e)
        }
    }

    function registerProvider(spec) {
        if (spec == null || typeof spec !== 'object') return false
        var key = normalizeName(spec.name || spec.id)
        if (!key) return false

        var normalizedActions = {}
        if (spec.actions != null && typeof spec.actions === 'object') {
            var actKeys = Object.keys(spec.actions)
            for (var ai = 0; ai < actKeys.length; ai++) {
                var rawAk = actKeys[ai]
                var ak    = normalizeName(rawAk)
                var act   = spec.actions[rawAk]
                if (!ak || act == null) continue
                if (typeof act === 'function') {
                    normalizedActions[ak] = { name: ak, desc: ak, fn: act }
                } else if (typeof act === 'object' && typeof act.fn === 'function') {
                    normalizedActions[ak] = {
                        name: ak,
                        desc: act.desc != null ? String(act.desc) : ak,
                        fn:   act.fn
                    }
                }
            }
        }

        if (!providers.has(key)) {
            providerOrder.push(key)
        }
        providers.set(key, {
            name:    key,
            label:   spec.label != null ? String(spec.label) : key,
            order:   (spec.order != null && isFinite(Number(spec.order))) ? Number(spec.order) : 100,
            summary: typeof spec.summary === 'function' ? spec.summary : null,
            detail:  typeof spec.detail === 'function' ? spec.detail : null,
            metrics: typeof spec.metrics === 'function' ? spec.metrics : null,
            check:   typeof spec.check === 'function' ? spec.check : null,
            actions: normalizedActions
        })
        return true
    }

    function unregisterProvider(name) {
        var key = normalizeName(name)
        if (!key || !providers.has(key)) return false
        providers.delete(key)
        var idx = providerOrder.indexOf(key)
        if (idx >= 0) providerOrder.splice(idx, 1)
        return true
    }

    function drainProviderQueue() {
        if (typeof global === 'undefined' || global == null) return 0
        var q = global.EpiphyDebugProviderQueue
        if (!Array.isArray(q) || q.length === 0) return 0
        var drained = 0
        for (var i = 0; i < q.length; i++) {
            if (registerProvider(q[i])) drained++
        }
        q.length = 0
        return drained
    }

    function sortedProviderKeys() {
        drainProviderQueue()
        var list = providerOrder.slice()
        list.sort(function (a, b) {
            var pa = providers.get(a)
            var pb = providers.get(b)
            var oa = pa != null ? pa.order : 100
            var ob = pb != null ? pb.order : 100
            if (oa !== ob) return oa - ob
            return a < b ? -1 : (a > b ? 1 : 0)
        })
        return list
    }

    function formatSummaryValue(raw) {
        if (raw == null) return '（无数据）'
        if (typeof raw === 'string') return raw
        if (Array.isArray(raw)) {
            var parts = []
            for (var i = 0; i < raw.length; i++) {
                var item = raw[i]
                if (item != null && typeof item === 'object' && item.key != null) {
                    parts.push(String(item.key) + '=' + String(item.value))
                } else {
                    parts.push(String(item))
                }
            }
            return parts.join(' | ')
        }
        if (typeof raw === 'object') {
            var kv = []
            var ks = Object.keys(raw)
            for (var j = 0; j < ks.length; j++) {
                kv.push(ks[j] + '=' + String(raw[ks[j]]))
            }
            return kv.join(' | ')
        }
        return String(raw)
    }

    function normalizeDetailLines(raw) {
        if (raw == null) return []
        if (Array.isArray(raw)) {
            var out = []
            for (var i = 0; i < raw.length; i++) out.push(String(raw[i]))
            return out
        }
        if (typeof raw === 'string') return [raw]
        if (typeof raw === 'object') {
            if (Array.isArray(raw.lines)) {
                return normalizeDetailLines(raw.lines)
            }
            var lines = []
            var keys  = Object.keys(raw)
            for (var j = 0; j < keys.length; j++) {
                var v = raw[keys[j]]
                lines.push(keys[j] + ': ' + (v != null && typeof v === 'object' ? JSON.stringify(v) : String(v)))
            }
            return lines
        }
        return [String(raw)]
    }

    function collectSnapshot(targetNameOpt) {
        var keys = sortedProviderKeys()
        var filterKey = targetNameOpt != null ? normalizeName(targetNameOpt) : ''
        var onlinePlayersCount = 0
        if (SERVER_REF != null) {
            // 【catch 约定】在线玩家数探测失败属服务器过渡状态分支，留空回退为 0。
            try {
                var pList = SERVER_REF.getPlayerList().getPlayers()
                if (pList != null) {
                    onlinePlayersCount = (typeof pList.size === 'function') ? Number(pList.size()) : (pList.length || 0)
                }
            } catch (eOnline) { }
        }

        var moduleEntries = []
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i]
            if (filterKey && k !== filterKey) continue
            var rec = providers.get(k)
            if (rec == null) continue

            var summaryData = null
            var summaryText = '（未提供 summary）'
            if (rec.summary != null) {
                try {
                    summaryData = rec.summary()
                    summaryText = formatSummaryValue(summaryData)
                } catch (eSum) {
                    logCatch('summary:' + k, eSum)
                    summaryText = '§c收集摘要异常: ' + eSum
                }
            }

            var detailLines = []
            if (rec.detail != null) {
                try {
                    detailLines = normalizeDetailLines(rec.detail())
                } catch (eDet) {
                    logCatch('detail:' + k, eDet)
                    detailLines = ['§c收集详情异常: ' + eDet]
                }
            }

            var metricsData = null
            if (rec.metrics != null) {
                try {
                    metricsData = rec.metrics()
                } catch (eMet) {
                    logCatch('metrics:' + k, eMet)
                    metricsData = null
                }
            }

            moduleEntries.push({
                name:        rec.name,
                label:       rec.label,
                order:       rec.order,
                summaryData: summaryData,
                summaryText: summaryText,
                detailLines: detailLines,
                metrics:     metricsData,
                actions:     Object.keys(rec.actions)
            })
        }

        return {
            timestamp:          Date.now(),
            onlinePlayersCount: onlinePlayersCount,
            providerCount:      keys.length,
            modules:            moduleEntries
        }
    }

    function runChecks(targetNameOpt) {
        var keys      = sortedProviderKeys()
        var filterKey = targetNameOpt != null ? normalizeName(targetNameOpt) : ''
        var results   = []
        var passCount = 0
        var warnCount = 0

        for (var i = 0; i < keys.length; i++) {
            var k = keys[i]
            if (filterKey && k !== filterKey) continue
            var rec = providers.get(k)
            if (rec == null || rec.check == null) continue

            var items = null
            try {
                items = rec.check()
            } catch (eChk) {
                logCatch('check:' + k, eChk)
                warnCount++
                results.push({
                    module: k,
                    label:  rec.label,
                    name:   'check_exception',
                    ok:     false,
                    detail: '自检执行抛错: ' + eChk
                })
                continue
            }

            if (!Array.isArray(items)) {
                if (items != null && typeof items === 'object') items = [items]
                else items = []
            }
            for (var j = 0; j < items.length; j++) {
                var c = items[j]
                if (c == null) continue
                var ok = Boolean(c.ok)
                if (ok) passCount++
                else warnCount++
                results.push({
                    module: k,
                    label:  rec.label,
                    name:   c.name != null ? String(c.name) : ('item_' + j),
                    ok:     ok,
                    detail: c.detail != null ? String(c.detail) : ''
                })
            }
        }

        return {
            total:     passCount + warnCount,
            passCount: passCount,
            warnCount: warnCount,
            items:     results
        }
    }

    function runAction(modName, actionName, args) {
        drainProviderQueue()
        var mKey = normalizeName(modName)
        var aKey = normalizeName(actionName)
        var rec  = providers.get(mKey)
        if (rec == null) {
            return { ok: false, code: 'provider_not_found', message: '未找到调试提供者 [' + mKey + ']' }
        }
        var act = rec.actions[aKey]
        if (act == null || typeof act.fn !== 'function') {
            return {
                ok:      false,
                code:    'action_not_found',
                message: '模块 [' + mKey + '] 未注册动作 [' + aKey + ']（可用: ' + (Object.keys(rec.actions).join(', ') || '无') + '）'
            }
        }
        try {
            var out = act.fn(args)
            if (out != null && typeof out === 'object' && !Array.isArray(out) && out.message !== undefined) {
                return {
                    ok:      out.ok === undefined ? true : Boolean(out.ok),
                    code:    out.code != null ? String(out.code) : (mKey + '.' + aKey),
                    data:    out.data !== undefined ? out.data : null,
                    message: out.message != null ? String(out.message) : ('已执行 ' + mKey + '.' + aKey)
                }
            }
            return { ok: true, code: mKey + '.' + aKey, data: null, message: out != null ? String(out) : ('已执行 ' + mKey + '.' + aKey) }
        } catch (eAct) {
            logCatch('action:' + mKey + ':' + aKey, eAct)
            return { ok: false, code: 'action_exception', data: null, message: '执行动作异常: ' + eAct }
        }
    }

    function toggleLogDebug(targetMod, enableFlag) {
        var mod = normalizeName(targetMod) || '*'
        var on  = Boolean(enableFlag)
        var applied = []

        if (typeof global !== 'undefined' && global.EpiphyLog != null && typeof global.EpiphyLog.setDebug === 'function') {
            var targetLogName = mod
            if (mod === 'tracker' || mod === 'blocktracker') targetLogName = 'EpiphyBlockTracker'
            else if (mod === 'valve' || mod === 'auth') targetLogName = 'EpiphyPermissionValve'
            else if (mod === 'audio') targetLogName = 'EpiphyAudio'
            else if (mod === 'danmaku') targetLogName = 'ScreenDanmaku'
            else if (mod === 'debug') targetLogName = 'EpiphyDebug'
            if (mod === '*') {
                global.EpiphyLog.setDebug(on)
                applied.push('EpiphyLog:*')
            } else {
                global.EpiphyLog.setDebug(targetLogName, on)
                if (targetLogName !== mod) global.EpiphyLog.setDebug(mod, on)
                applied.push('EpiphyLog:' + targetLogName)
            }
        }

        if ((mod === '*' || mod === 'danmaku') && typeof global !== 'undefined' && global.ScreenDanmaku != null && typeof global.ScreenDanmaku.configure === 'function') {
            global.ScreenDanmaku.configure({ debug: on })
            applied.push('ScreenDanmaku.CONFIG.debug')
        }
        if ((mod === '*' || mod === 'audio') && typeof global !== 'undefined' && global.EpiphyAudio != null && global.EpiphyAudio.CONFIG != null) {
            global.EpiphyAudio.CONFIG.debug = on
            applied.push('EpiphyAudio.CONFIG.debug')
        }

        return { ok: applied.length > 0, target: mod, enabled: on, applied: applied }
    }

    function printStatusCommand(source) {
        var snap = collectSnapshot(null)
        sendSourceMsg(source, '§3§l====================================================')
        sendSourceMsg(
            source,
            '§b§l  [ Epiphy Debug 状态面板 ] §7在线玩家: §f' + snap.onlinePlayersCount +
            ' §7| 已挂载模块: §a' + snap.providerCount
        )
        sendSourceMsg(source, '§3§l----------------------------------------------------')
        if (snap.modules.length === 0) {
            sendSourceMsg(source, '§e  （暂无已注册的动态调试提供者）')
        } else {
            for (var i = 0; i < snap.modules.length; i++) {
                var m = snap.modules[i]
                sendSourceMsg(source, '§6▸ ' + m.label + ' §8[' + m.name + ']§f: §7' + m.summaryText)
            }
        }
        sendSourceMsg(source, '§8提示: §f/epiphy debug module <名> §8看详情 | §f/epiphy debug checks §8跑自检')
        sendSourceMsg(source, '§3§l====================================================')
        return 1
    }

    function printModuleCommand(source, modName) {
        var snap = collectSnapshot(modName)
        if (snap.modules.length === 0) {
            var known = sortedProviderKeys().join(', ') || '（无）'
            sendSourceMsg(source, '§c[EpiphyDebug] 未找到模块 [' + modName + ']。当前可用模块: §f' + known)
            return 0
        }
        var m = snap.modules[0]
        sendSourceMsg(source, '§3§l----------------------------------------------------')
        sendSourceMsg(source, '§b§l  [ ' + m.label + ' (' + m.name + ') 详细诊断 ]')
        sendSourceMsg(source, '§e摘要: §f' + m.summaryText)
        for (var i = 0; i < m.detailLines.length; i++) {
            sendSourceMsg(source, '§7  • §f' + m.detailLines[i])
        }
        if (m.actions.length > 0) {
            var rec = providers.get(m.name)
            var actDesc = []
            for (var j = 0; j < m.actions.length; j++) {
                var an = m.actions[j]
                var aObj = rec != null ? rec.actions[an] : null
                actDesc.push('§e' + an + '§7(' + (aObj != null ? aObj.desc : an) + ')')
            }
            sendSourceMsg(source, '§b可用动作 (/epiphy debug action ' + m.name + ' <动作>): ' + actDesc.join('§7, '))
        }
        sendSourceMsg(source, '§3§l----------------------------------------------------')
        return 1
    }

    function printChecksCommand(source) {
        var res = runChecks(null)
        sendSourceMsg(source, '§3§l----------------------------------------------------')
        sendSourceMsg(
            source,
            '§b§l  [ Epiphy 全模块健康自检 ] §a通过 ' + res.passCount + '§7 / §c告警 ' + res.warnCount
        )
        for (var i = 0; i < res.items.length; i++) {
            var it  = res.items[i]
            var tag = it.ok ? '§a[PASS]' : '§c[WARN]'
            sendSourceMsg(source, tag + ' §7[' + it.module + '.' + it.name + '] §f' + it.detail)
        }
        sendSourceMsg(source, '§3§l----------------------------------------------------')
        return 1
    }

    function execLogToggle(source, target, enableFlag) {
        var res = toggleLogDebug(target, enableFlag)
        var tag = enableFlag ? '§a[EpiphyDebug] 已开启调试日志: §f' : '§e[EpiphyDebug] 已关闭调试日志: §f'
        sendSourceMsg(source, tag + (res.applied.join(', ') || target))
        return 1
    }

    function buildDebugCommandNode(ctxApi) {
        var b = BASE.createCommandBuilder(ctxApi, { tag: 'EpiphyDebug' })
        return b.literal('debug', {
            exec: function (ctx) { return printStatusCommand(ctx.source) },
            children: [
                b.literal('status', function (ctx) { return printStatusCommand(ctx.source) }),
                b.literal('checks', function (ctx) { return printChecksCommand(ctx.source) }),
                b.literal('module', {
                    chain: [
                        [{ name: 'mod', type: 'word' }],
                        function (ctx, args) { return printModuleCommand(ctx.source, args.mod) }
                    ]
                }),
                b.literal('log', {
                    children: [
                        b.arg({ name: 'target', type: 'word' }, {
                            children: [
                                b.literal('on', function (ctx) {
                                    return execLogToggle(ctx.source, b.readArg(ctx, 'target', 'word'), true)
                                }),
                                b.literal('off', function (ctx) {
                                    return execLogToggle(ctx.source, b.readArg(ctx, 'target', 'word'), false)
                                })
                            ]
                        })
                    ]
                }),
                b.literal('action', {
                    chain: [
                        [{ name: 'mod', type: 'word' }, { name: 'act', type: 'word' }],
                        function (ctx, args) {
                            var res = runAction(args.mod, args.act, null)
                            sendSourceMsg(ctx.source, (res.ok ? '§a[EpiphyDebug] ' : '§c[EpiphyDebug] ') + res.message)
                            return res.ok ? 1 : 0
                        }
                    ]
                })
            ]
        })
    }

    var DEBUG_HELP_LINES = [
        '§3§l----------------------------------------------------',
        '§b§l  [ Epiphy 统一调试组件 // /epiphy debug 帮助手册 ]',
        '§3§l----------------------------------------------------',
        '§e1. 运行时总览面板：   §f/epiphy debug §7或 §f/epiphy debug status',
        '§e2. 单模块详情与动作： §f/epiphy debug module <tracker|audio|danmaku|valve|log>',
        '§e3. 全模块健康自检：   §f/epiphy debug checks',
        '§e4. 统一切换日志开关： §f/epiphy debug log <模块|*> <on|off>',
        '§e5. 执行维护诊断动作： §f/epiphy debug action <模块> <动作名>',
        '§3§l----------------------------------------------------'
    ]

    var debugSubcommandSpec = {
        name:       'debug',
        permission: {
            mode:                 'admin',
            label:                '管理员 (仅 OP / 控制台 / 调试专用)',
            requireCheats:        false,
            requireOp:            true,
            allowAuthorized:      false,
            opLevel:              2,
            allowCommandBlock:    false,
            allowConsole:         true,
            allowDeclaredCallers: false,
            allowedCallers:       null
        },
        summary:   '全组件统一调试看板、耗时统计与健康自检指令 (/epiphy debug ...)',
        helpLines: DEBUG_HELP_LINES,
        buildNode: buildDebugCommandNode
    }

    ServerEvents.tick(function (event) {
        try {
            if (event != null && event.server != null) SERVER_REF = event.server
            drainProviderQueue()
        } catch (eTick) {
            logCatch('ServerEvents.tick', eTick)
        }
    })

    // 自检模块自身基础状态提供者
    registerProvider({
        name:    'debug',
        label:   '调试汇总核心',
        order:   99,
        summary: function () {
            return 'providers=' + providers.size + ' | queuePending=' +
                ((typeof global !== 'undefined' && Array.isArray(global.EpiphyDebugProviderQueue)) ? global.EpiphyDebugProviderQueue.length : 0)
        },
        detail: function () {
            return [
                'registeredProviders: ' + sortedProviderKeys().join(', '),
                'valveAttached: ' + Boolean(typeof global !== 'undefined' && (global.EpiphyPermissionValve || global.PermissionValve) != null),
                'logAttached: ' + Boolean(typeof global !== 'undefined' && global.EpiphyLog != null)
            ]
        },
        metrics: function () {
            return {
                providersCount: providers.size,
                queuePending:   (typeof global !== 'undefined' && Array.isArray(global.EpiphyDebugProviderQueue)) ? global.EpiphyDebugProviderQueue.length : 0,
                registered:     sortedProviderKeys()
            }
        },
        check: function () {
            var qLen = (typeof global !== 'undefined' && Array.isArray(global.EpiphyDebugProviderQueue))
                ? global.EpiphyDebugProviderQueue.length
                : 0
            return [{
                name:   'queue_drained',
                ok:     qLen === 0,
                detail: 'providerQueuePending=' + qLen
            }]
        }
    })

    drainProviderQueue()

    global.EpiphyDebug = {
        registerProvider:   registerProvider,
        unregisterProvider: unregisterProvider,
        hasProvider:        function (name) { drainProviderQueue(); return providers.has(normalizeName(name)) },
        listProviders:      sortedProviderKeys,
        collectSnapshot:    collectSnapshot,
        runChecks:          runChecks,
        runAction:          runAction,
        toggleLogDebug:     toggleLogDebug
    }

    BASE.registerSubcommandSafe(debugSubcommandSpec, { requirePermissionValve: false })
})()
