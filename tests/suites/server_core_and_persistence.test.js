// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
'use strict'

module.exports = function registerSuite(test, h) {
    var assert                    = h.assert
    var fs                        = h.fs
    var path                      = h.path
    var vm                        = h.vm
    var ROOT_DIR                  = h.ROOT_DIR
    var SPEC_PATH                 = h.SPEC_PATH
    var LOG_PATH                  = h.LOG_PATH
    var SERVER_BASE_PATH          = h.SERVER_BASE_PATH
    var TRACKER_PATH              = h.TRACKER_PATH
    var VALVE_PATH                = h.VALVE_PATH
    var DEBUG_PATH                = h.DEBUG_PATH
    var BUGFIX_PATH               = h.BUGFIX_PATH
    var DANMAKU_PATH              = h.DANMAKU_PATH
    var AUDIO_PATH                = h.AUDIO_PATH
    var RENDERER_PATH             = h.RENDERER_PATH
    var AUDIO_CLIENT_PATH         = h.AUDIO_CLIENT_PATH
    var createKubeSandbox         = h.createKubeSandbox
    var attachConsoleCapture      = h.attachConsoleCapture
    var runScriptIn               = h.runScriptIn
    var loadStartupBase           = h.loadStartupBase
    var loadServerBase            = h.loadServerBase
    var plain                     = h.plain
    var makeMockWorld             = h.makeMockWorld
    var attachSandboxEventHooks   = h.attachSandboxEventHooks
    var makeNodeBackedJavaSandbox = h.makeNodeBackedJavaSandbox
    var shared                    = h.getSharedDefaultSandbox()
    var sandbox                   = shared.sandbox
    var Valve                     = shared.Valve
    var Danmaku                   = shared.Danmaku
    var pure                      = shared.pure
    // ----------------------------------------------------------------------------
    // 8. EpiphyLog.getStats & EpiphyDebug dynamic provider hub across all 6 server scripts
    // ----------------------------------------------------------------------------
    test('debug hub: dynamic queue drain, multi-module metrics, checks, actions & admin policy', function () {
        function MockMinecraftServer() {}
        function MockServerPlayer(name, op) {
            this.username = name
            this._op = Boolean(op)
            this._sent = []
        }
        MockServerPlayer.prototype.getStringUUID = function () { return 'uuid-' + this.username }
        MockServerPlayer.prototype.getUuid = function () { return 'uuid-' + this.username }
        MockServerPlayer.prototype.hasPermissions = function (lv) { return this._op && lv <= 4 }
        MockServerPlayer.prototype.sendData = function (ch, pkt) { this._sent.push({ ch: ch, pkt: pkt }) }

        var tickHandlers = []
        var isoSandbox = createKubeSandbox(function (clsName) {
            if (clsName === 'net.minecraft.server.MinecraftServer') return MockMinecraftServer
            if (clsName === 'net.minecraft.server.level.ServerPlayer') return MockServerPlayer
            return null
        })
        isoSandbox.ServerEvents.tick = function (fn) { tickHandlers.push(fn) }
        var isoConsole = attachConsoleCapture(isoSandbox)

        // Load server components once in real KubeJS priority order (1200 -> 1100 -> 1080 -> 1050 -> 1000 -> 950 -> 500)
        loadServerBase(isoSandbox)
        runScriptIn(isoSandbox, TRACKER_PATH)
        runScriptIn(isoSandbox, VALVE_PATH)
        vm.runInContext(fs.readFileSync(DEBUG_PATH, 'utf8'), isoSandbox, { filename: 'Epiphy的-调试组件.js' })
        vm.runInContext(fs.readFileSync(DANMAKU_PATH, 'utf8'), isoSandbox, { filename: 'Epiphy的-平面渲染组件.js' })
        vm.runInContext(fs.readFileSync(AUDIO_PATH, 'utf8'), isoSandbox, { filename: 'Epiphy的-音频组件.js' })

        assert.strictEqual(tickHandlers.length, 5, 'single-load order must not duplicate ServerEvents.tick handlers (TRACKER + DEBUG + 2*DANMAKU + AUDIO; fallback skipped)')
        assert.strictEqual(isoConsole.warns.length, 0, 'clean load must emit zero console warns')
        assert.strictEqual(isoConsole.errors.length, 0, 'clean load must emit zero console errors')

        var Log     = isoSandbox.global.EpiphyLog
        var Valve   = isoSandbox.global.EpiphyPermissionValve
        var Debug   = isoSandbox.global.EpiphyDebug
        var Danmaku = isoSandbox.global.ScreenDanmaku
        var Audio   = isoSandbox.global.EpiphyAudio

        assert.ok(Log && typeof Log.getStats === 'function')
        assert.ok(Debug && typeof Debug.collectSnapshot === 'function')
        assert.deepStrictEqual(
            plain(Debug.listProviders()),
            ['log', 'tracker', 'valve', 'danmaku', 'audio', 'debug']
        )

        // Exercise Log stats (rate-limit suppression + once)
        Log.warn('TestMod', 'rateTag', 'msg1', null, 60000)
        Log.warn('TestMod', 'rateTag', 'msg2', null, 60000)
        Log.once('warn', 'once_k1', 'hello once')
        var logStats = Log.getStats()
        assert.strictEqual(logStats.bucketCount, 1)
        assert.strictEqual(logStats.totalSuppressed, 1)
        assert.strictEqual(logStats.onceKeyCount, 1)

        // Exercise Audio play + ServerEvents.tick to record handles.size and syncAll timing
        var p1 = new MockServerPlayer('Tester', false)
        var op = new MockServerPlayer('AdminOP', true)
        p1.x = 0; p1.y = 64; p1.z = 0
        op.x = 2; op.y = 64; op.z = 0
        var mockLevel = {
            dimension: 'minecraft:overworld',
            players: [p1, op],
            getBlock: function () { return { id: 'minecraft:air' } },
            getMinBuildHeight: function () { return 0 },
            getMaxBuildHeight: function () { return 64 },
            getChunkSource: function () { return { getChunkNow: function () { return null } } }
        }
        p1.level = mockLevel
        op.level = mockLevel
        var mockServer = {
            getLevel: function () { return mockLevel },
            getAllLevels: function () { return [mockLevel] },
            getPlayerList: function () { return { getPlayers: function () { return [p1, op] } } }
        }

        Audio.play({ sound: 'epiphy:children_of_the_city', audience: 'all', loop: true })
        for (var ti = 0; ti < tickHandlers.length; ti++) {
            tickHandlers[ti]({ server: mockServer })
        }

        var snap = Debug.collectSnapshot(null)
        assert.strictEqual(snap.onlinePlayersCount, 2)
        assert.strictEqual(snap.providerCount, 6)

        var byName = {}
        for (var mi = 0; mi < snap.modules.length; mi++) {
            byName[snap.modules[mi].name] = snap.modules[mi]
        }
        assert.ok(byName.tracker.summaryText.length > 0 && byName.tracker.detailLines.length > 0)
        assert.ok(byName.tracker.metrics && typeof byName.tracker.metrics.scanQueueArrayLength === 'number')
        assert.ok(typeof byName.tracker.metrics.trackedBlocksSize === 'number')
        assert.ok(typeof byName.tracker.metrics.getTrackedRecordsCalls === 'number')
        assert.ok(byName.audio.summaryText.length > 0 && byName.audio.detailLines.length > 0)
        assert.strictEqual(byName.audio.metrics.handlesSize, 1)
        assert.ok(typeof byName.audio.metrics.lastSyncAllMs === 'number')
        assert.ok(byName.danmaku.metrics && byName.log.metrics && byName.valve.metrics && byName.debug.metrics)

        var chk = Debug.runChecks(null)
        assert.strictEqual(chk.warnCount, 0, 'all checks should pass cleanly: ' + JSON.stringify(chk.items))

        var actRes = Debug.runAction('danmaku', 'clearcache')
        assert.strictEqual(actRes.ok, true)

        var dbgToggle = Debug.toggleLogDebug('danmaku', true)
        assert.strictEqual(dbgToggle.ok, true)
        assert.strictEqual(Log.isDebug('ScreenDanmaku'), true)
        assert.strictEqual(Danmaku.CONFIG.debug, true)
        Debug.toggleLogDebug('danmaku', false)
        assert.strictEqual(Danmaku.CONFIG.debug, false)

        // Permission check: /epiphy debug must allow OP & console, deny regular player & declared callers
        var opAccess     = Valve.evaluateSourceAccess({ source: op, player: op, hasPermission: function () { return true } }, 'debug', Valve.getStats && { mode: 'admin', requireCheats: false, requireOp: true, allowAuthorized: false, opLevel: 2, allowCommandBlock: false, allowConsole: true, allowDeclaredCallers: false })
        var playerAccess = Valve.evaluateSourceAccess({ source: p1, player: p1, hasPermission: function () { return false } }, 'debug', { mode: 'admin', requireCheats: false, requireOp: true, allowAuthorized: false, opLevel: 2, allowCommandBlock: false, allowConsole: true, allowDeclaredCallers: false })
        assert.strictEqual(opAccess.allowed, true)
        assert.strictEqual(playerAccess.allowed, false)
    })

    test('EpiphyServerBase: degrades cleanly without EpiphyLog/EpiphySpec; Valve & BlockTracker keep running while heavy business modules require full base', function () {
        var sb = createKubeSandbox()
        var warns = []
        sb.console.warn = function (m) { warns.push(String(m)) }

        // Without startup EpiphySpec or optional EpiphyLog, ServerBase + Valve + BlockTracker must NOT crash
        runScriptIn(sb, SERVER_BASE_PATH)
        runScriptIn(sb, VALVE_PATH)
        runScriptIn(sb, TRACKER_PATH)

        var B = sb.global.EpiphyServerBase
        assert.ok(B && typeof B.normalizeDim === 'function')
        assert.strictEqual(B.normalizeDim('the_nether'), 'minecraft:the_nether')
        assert.strictEqual(B.makePosKey('overworld', 1.9, 64, -2.1), 'minecraft:overworld|1,64,-3')

        var log = B.createLogger('TestDegraded', 0)
        log.warn('probe', 'degraded warn works')
        assert.ok(warns.some(function (w) { return w.indexOf('Epiphy的-Spec与通用工具.js') >= 0 }))
        assert.ok(warns.some(function (w) { return w.indexOf('Epiphy的-日志.js') >= 0 }))
        assert.ok(warns.some(function (w) { return w.indexOf('degraded warn works') >= 0 }))

        assert.ok(sb.global.EpiphyPermissionValve.registerSubcommand({ name: 'demo', permission: 'public' }))
        var tracker = sb.global.EpiphyBlockTracker.createTracker({ name: 't_degraded' })
        assert.strictEqual(tracker.isFallback, undefined)

        // Heavy business orchestrators still require EpiphySpec / EpiphyServerBase
        assert.throws(function () {
            runScriptIn(sb, DANMAKU_PATH)
        }, /EpiphySpec|EpiphyServerBase/)
    })

    test('EpiphyServerBase: CommandBuilder enforces bottom-up Brigadier ordering, optional chain tails, and reply helpers', function () {
        var sb = createKubeSandbox()
        loadServerBase(sb)
        var B = sb.global.EpiphyServerBase

        function makeNode(kind, name) {
            var frozenChildren = []
            var execFn = null
            var reqFn = null
            var suggestsVal = null
            var node = {
                kind: kind,
                name: name,
                requires: function (fn) { reqFn = fn; return node },
                executes: function (fn) { execFn = fn; return node },
                suggests: function (s) { suggestsVal = s; return node },
                then: function (child) {
                    frozenChildren.push(child._snapshot())
                    return node
                },
                _snapshot: function () {
                    return {
                        kind: kind,
                        name: name,
                        hasExec: execFn !== null,
                        execFn: execFn,
                        reqFn: reqFn,
                        suggestsVal: suggestsVal,
                        children: frozenChildren.slice()
                    }
                }
            }
            return node
        }

        var Commands = {
            literal: function (n) { return makeNode('literal', n) },
            argument: function (n, type) { return makeNode('arg:' + type, n) }
        }
        var Arguments = {
            PLAYERS: { create: function () { return 'PLAYERS' }, getResult: function (ctx, n) { return ctx.args[n] } },
            WORD:    { create: function () { return 'WORD' },    getResult: function (ctx, n) { return ctx.args[n] } },
            GREEDY_STRING: { create: function () { return 'GREEDY' }, getResult: function (ctx, n) { return ctx.args[n] } }
        }

        var b = B.createCommandBuilder({
            event: {},
            Commands: Commands,
            Arguments: Arguments,
            guardExecution: function (fn) { return fn },
            canSee: function () { return true }
        }, { tag: 'UnitTest' })

        var calls = []
        var sent = []
        var root = b.literal('demo', {
            children: [
                b.literal('stop', {
                    chain: [
                        [{ name: 'target', type: 'players' }, { name: 'id', type: 'word' }],
                        function (ctx, args) {
                            calls.push({ count: args._count, target: args.target, id: args.id })
                            if (args.id === 'fail') return b.replyErr(ctx, 'missing id')
                            return b.replyOk(ctx, 'stopped')
                        },
                        { minArgs: 0 }
                    ]
                })
            ]
        })

        var snap = root._snapshot()
        var stopSnap = snap.children[0]
        assert.strictEqual(stopSnap.hasExec, true, 'minArgs=0 executes on literal')
        assert.strictEqual(stopSnap.children[0].name, 'target')
        assert.strictEqual(stopSnap.children[0].hasExec, true, '1-arg executes before frozen into stop')
        assert.strictEqual(stopSnap.children[0].children[0].name, 'id')
        assert.strictEqual(stopSnap.children[0].children[0].hasExec, true, '2-arg executes before frozen into target')

        var mockSrc = { sendSuccess: function (msg) { sent.push(String(msg)) } }
        assert.strictEqual(stopSnap.execFn({ source: mockSrc, args: {} }), 1)
        assert.strictEqual(stopSnap.children[0].execFn({ source: mockSrc, args: { target: ['P1'] } }), 1)
        assert.strictEqual(stopSnap.children[0].children[0].execFn({ source: mockSrc, args: { target: ['P1'], id: 'fail' } }), 0)

        assert.strictEqual(calls.length, 3)
        assert.strictEqual(calls[0]._count || calls[0].count, 0)
        assert.deepStrictEqual(calls[1].target, ['P1'])
        assert.strictEqual(calls[2].id, 'fail')
        assert.ok(sent[0].indexOf('[UnitTest] stopped') >= 0)
        assert.ok(sent[2].indexOf('[UnitTest 错误] missing id') >= 0)
    })

    test('EpiphyServerBase: resolveWorldStorageInfo & centralized acquireBlockTracker fallback work without EpiphyBlockTracker', function () {
        var sb = createKubeSandbox()
        var hooks = attachSandboxEventHooks(sb)
        loadServerBase(sb)
        var B = sb.global.EpiphyServerBase

        var infoFallback = B.resolveWorldStorageInfo({
            getWorldData: function () { return { getLevelName: function () { return 'My/Test:World' } } }
        }, 'kubejs_epiphy_permissions.json', 'kubejs/config/epiphy_permissions')
        assert.strictEqual(infoFallback.isWorldRoot, false)
        assert.strictEqual(infoFallback.filePath, 'kubejs/config/epiphy_permissions/My_Test_World.json')

        var tracker = B.acquireBlockTracker({ name: 'demoSub' })
        assert.strictEqual(tracker.isFallback, true)

        var events = []
        var tracker2 = B.acquireBlockTracker({
            name: 'demoSub2',
            onFound: function (view, meta, reason) {
                events.push({ type: 'found', key: view.key, reason: reason, r: meta.radius })
            },
            onRemoved: function (view, meta, reason) {
                events.push({ type: 'removed', key: view.key, reason: reason })
            }
        })
        assert.strictEqual(tracker2.bind('mod:bell', { radius: 16 }), true)

        hooks.placed.forEach(function (fn) {
            fn({
                level: { dimension: 'minecraft:overworld' },
                block: { id: 'mod:bell', x: 10, y: 64, z: -5 }
            })
        })
        assert.strictEqual(tracker2.getTrackedRecords('mod:bell').length, 1)

        hooks.broken.forEach(function (fn) {
            fn({
                level: { dimension: 'minecraft:overworld' },
                block: { id: 'mod:bell', x: 10, y: 64, z: -5 }
            })
        })
        assert.strictEqual(tracker2.getTrackedRecords('mod:bell').length, 0)
        assert.deepStrictEqual(events, [
            { type: 'found', key: 'minecraft:overworld|10,64,-5', reason: 'fallback_placed', r: 16 },
            { type: 'removed', key: 'minecraft:overworld|10,64,-5', reason: 'broken' }
        ])

        assert.strictEqual(B.registerSubcommandSafe({ name: 'test_cmd' }), false)
        assert.strictEqual(sb.global.EpiphyCommandRegistryQueue.length, 1)
        assert.strictEqual(B.registerDebugProvider({ name: 'test_mod' }), true)
        assert.ok(sb.global.EpiphyDebugProviderQueue.some(function (p) { return p && p.name === 'test_mod' }))
    })

    test('EpiphyServerBase fallback tracker: promotes makeRecordExtra fields & dispatches throttled onTick', function () {
        var sb = createKubeSandbox()
        var hooks = attachSandboxEventHooks(sb)
        loadServerBase(sb)
        var B = sb.global.EpiphyServerBase

        var tickSeen = []
        var foundViews = []
        var mockLevel = { dimension: 'minecraft:overworld', players: [] }
        var mockServer = { getLevel: function (d) { return d === 'minecraft:overworld' ? mockLevel : null } }

        var tr = B.acquireBlockTracker({
            name: 'audio_fb_test',
            maintainInterval: 3,
            maintainOffset: 2,
            makeRecordExtra: function (bid, dim, x, y, z) {
                return { audioKey: 'k:' + bid + '@' + x + ',' + y + ',' + z, customTag: 99 }
            },
            onFound: function (view) { foundViews.push(view) },
            onTick: function (view, meta, tickNum, lv) {
                tickSeen.push({ tick: tickNum, audioKey: view.audioKey, levelOk: lv === mockLevel })
            }
        })
        assert.strictEqual(tr.isFallback, true)
        tr.bind('mod:speaker', { radius: 24 })

        hooks.placed.forEach(function (fn) {
            fn({ level: mockLevel, block: { id: 'mod:speaker', x: 1, y: 2, z: 3 } })
        })
        assert.strictEqual(foundViews.length, 1)
        assert.strictEqual(foundViews[0].audioKey, 'k:mod:speaker@1,2,3')
        assert.strictEqual(foundViews[0].customTag, 99)
        assert.strictEqual(foundViews[0].extra.audioKey, 'k:mod:speaker@1,2,3')

        for (var t = 1; t <= 6; t++) {
            hooks.tick.forEach(function (fn) { fn({ server: mockServer }) })
        }
        assert.deepStrictEqual(tickSeen, [
            { tick: 2, audioKey: 'k:mod:speaker@1,2,3', levelOk: true },
            { tick: 5, audioKey: 'k:mod:speaker@1,2,3', levelOk: true }
        ])
    })

    test('EpiphyBugfix: zero hard dependencies, optional EpiphyLog, server-authoritative logout HP & deleted-mod cap clamp', function () {
        function makeBugfixHarness(opts) {
            opts = opts || {}
            var sharedDisk = opts.sharedDisk || {}
            var logs = { info: [], warn: [], error: [], debug: [] }
            var handlers = {
                loggedIn:  [],
                loggedOut: [],
                respawned: [],
                death:     [],
                loaded:    [],
                tick:      [],
                unloaded:  []
            }
            var onlinePlayers = {}

            function makePd() {
                var store = {}
                return {
                    getString: function (k) { return store[k] != null ? String(store[k]) : '' },
                    putString: function (k, v) { store[k] = String(v) },
                    _raw: store
                }
            }

            var serverObj = {
                persistentData: opts.pd || makePd(),
                players: [],
                getWorldPath: opts.disableJsonIo ? undefined : function () {
                    return {
                        toAbsolutePath: function () { return this },
                        normalize: function () { return this },
                        resolve: function (name) { return { normalize: function () { return 'world_test/' + name } } }
                    }
                },
                getPlayerList: function () {
                    return {
                        getPlayerByName: function (name) {
                            var keys = Object.keys(onlinePlayers)
                            for (var i = 0; i < keys.length; i++) {
                                var p = onlinePlayers[keys[i]]
                                if (p && p.username === name) return p
                            }
                            return null
                        }
                    }
                }
            }

            var netTried = false
            var sb = {
                console: {
                    info:  function (m) { logs.info.push(String(m)) },
                    warn:  function (m) { logs.warn.push(String(m)) },
                    error: function (m) { logs.error.push(String(m)) },
                    debug: function (m) { logs.debug.push(String(m)) },
                    log:   function () {}
                },
                ServerEvents: {
                    loaded:   function (fn) { handlers.loaded.push(fn) },
                    tick:     function (fn) { handlers.tick.push(fn) },
                    unloaded: function (fn) { handlers.unloaded.push(fn) },
                    commandRegistry: function () {},
                    command:         function () {}
                },
                PlayerEvents: {
                    loggedIn:  function (fn) { handlers.loggedIn.push(fn) },
                    loggedOut: function (fn) { handlers.loggedOut.push(fn) },
                    respawned: function (fn) { handlers.respawned.push(fn) }
                },
                EntityEvents: {
                    death: function (fn) { handlers.death.push(fn) }
                },
                BlockEvents: { placed: function () {}, broken: function () {} },
                NetworkEvents: {
                    dataReceived: function () { netTried = true }
                },
                JsonIO: opts.disableJsonIo ? undefined : {
                    read: function (p) { return sharedDisk[p] != null ? JSON.parse(JSON.stringify(sharedDisk[p])) : null },
                    write: function (p, obj) { sharedDisk[p] = JSON.parse(JSON.stringify(obj)) }
                },
                Java: {
                    loadClass: function (cls) {
                        if (cls === 'net.minecraft.world.level.storage.LevelResource') return { ROOT: 'ROOT' }
                        return null
                    }
                },
                Text: { of: function (s) { return String(s) } },
                global: {}
            }
            sb.globalThis = sb
            vm.createContext(sb)

            if (opts.withLog) {
                runScriptIn(sb, LOG_PATH)
                sb.global.EpiphyLog.setDebug('EpiphyBugfix', true)
            }
            runScriptIn(sb, BUGFIX_PATH)

            function mkPlayer(uuid, name, hp, maxHp, extra) {
                extra = extra || {}
                var p = {
                    stringUUID: uuid,
                    username: name,
                    health: hp,
                    maxHealth: maxHp,
                    fake: Boolean(extra.fake),
                    dead: Boolean(extra.dead),
                    server: serverObj,
                    isPlayer: function () { return true },
                    getHealth: function () { return p.health },
                    setHealth: function (v) { p.health = v },
                    getMaxHealth: function () { return p.maxHealth },
                    isDeadOrDying: function () { return p.dead || p.health <= 0 }
                }
                return p
            }

            function fireLogin(p) {
                onlinePlayers[p.stringUUID] = p
                serverObj.players.push(p)
                for (var i = 0; i < handlers.loggedIn.length; i++) {
                    handlers.loggedIn[i]({ server: serverObj, player: p })
                }
            }
            function fireLogout(p) {
                for (var i = 0; i < handlers.loggedOut.length; i++) {
                    handlers.loggedOut[i]({ server: serverObj, player: p })
                }
                delete onlinePlayers[p.stringUUID]
                serverObj.players = serverObj.players.filter(function (x) { return x !== p })
            }
            function stepTicks(n, onBeforeEach) {
                for (var t = 0; t < n; t++) {
                    if (typeof onBeforeEach === 'function') onBeforeEach(t)
                    for (var i = 0; i < handlers.tick.length; i++) {
                        handlers.tick[i]({ server: serverObj })
                    }
                }
            }

            return {
                sb: sb,
                api: sb.global.EpiphyBugfix,
                logs: logs,
                handlers: handlers,
                serverObj: serverObj,
                sharedDisk: sharedDisk,
                get netTried() { return netTried },
                mkPlayer: mkPlayer,
                fireLogin: fireLogin,
                fireLogout: fireLogout,
                stepTicks: stepTicks
            }
        }

        // 1. 零前置独立加载：无 Spec / Base / Log，不监听任何客户端上传包，纯服务端落盘后重启恢复
        var sharedDisk = {}
        var h1 = makeBugfixHarness({ sharedDisk: sharedDisk, withLog: false })
        assert.ok(h1.api != null && h1.api.VERSION === '1.0.0')
        assert.strictEqual(h1.netTried, false, 'EpiphyBugfix must never register client->server NetworkEvents handlers')
        assert.ok(h1.logs.info.some(function (s) { return s.indexOf('内置兜底') >= 0 }))

        var pExit = h1.mkPlayer('uuid-p1', 'Alice', 55, 60)
        h1.fireLogout(pExit)
        assert.deepStrictEqual(
            { hp: h1.api.getRecord('uuid-p1').hp, max: h1.api.getRecord('uuid-p1').max },
            { hp: 55, max: 60 }
        )
        assert.ok(sharedDisk['world_test/kubejs_epiphy_bugfix_hp.json'] != null)
        assert.strictEqual(sharedDisk['world_test/kubejs_epiphy_bugfix_hp.json'].version, 1, 'persisted HP JSON schema version must remain integer 1 for save compatibility')

        // 模拟重开世界 + 可选接入 EpiphyLog + 原版读档先钳位到 20，再分两阶段恢复到 60 上限
        var h2 = makeBugfixHarness({ sharedDisk: sharedDisk, withLog: true })
        assert.ok(h2.logs.info.some(function (s) { return s.indexOf('已接入') >= 0 }))
        var pJoin = h2.mkPlayer('uuid-p1', 'Alice', 20, 20)
        h2.fireLogin(pJoin)
        assert.strictEqual(h2.api.getPendingCount(), 1)
        assert.ok(h2.logs.info.some(function (s) { return s.indexOf('DEBUG:loginQueue') >= 0 }), 'EpiphyLog debug hook should receive loginQueue via info console')

        h2.stepTicks(1)
        assert.strictEqual(pJoin.health, 20)
        assert.strictEqual(h2.api.getPendingCount(), 1)

        pJoin.maxHealth = 35
        h2.stepTicks(1)
        assert.strictEqual(pJoin.health, 35, 'should grant partial headroom up to 35 as first mod loads')
        assert.strictEqual(h2.api.getPendingCount(), 1)

        pJoin.maxHealth = 60
        h2.stepTicks(1)
        assert.strictEqual(pJoin.health, 55, 'should restore exact logout HP 55 without healing to 60')
        assert.strictEqual(h2.api.getPendingCount(), 0, 'pending session must finish once full recorded HP is restored')
        assert.strictEqual(h2.api.getRecord('uuid-p1'), null, 'consumed record must be removed cleanly')

        // 2. 等待窗口内受伤不能被免费回满（真实扣血必须扣掉）
        var hDmg = makeBugfixHarness({ sharedDisk: {} })
        var pHurtOut = hDmg.mkPlayer('uuid-p2', 'Bob', 55, 60)
        hDmg.fireLogout(pHurtOut)
        var pHurtIn = hDmg.mkPlayer('uuid-p2', 'Bob', 20, 20)
        hDmg.fireLogin(pHurtIn)
        pHurtIn.health = 14 // creeper hits for 6 while curios haven't loaded yet
        hDmg.stepTicks(1)
        assert.strictEqual(pHurtIn.health, 14, 'must not heal damage sustained while maxHealth is still 20')
        pHurtIn.maxHealth = 60
        hDmg.stepTicks(1)
        assert.strictEqual(pHurtIn.health, 49, 'must preserve pre-load 6 damage (55 - 6 = 49)')

        // 3. 删 Mod 导致 HP 上限降低：超出部分不计算、不欠账、到期彻底清零
        var modDelDisk = {}
        var hMod1 = makeBugfixHarness({ sharedDisk: modDelDisk })
        hMod1.fireLogout(hMod1.mkPlayer('uuid-p3', 'Carol', 50, 80))

        var hMod2 = makeBugfixHarness({ sharedDisk: modDelDisk })
        var pCarIn = hMod2.mkPlayer('uuid-p3', 'Carol', 20, 20)
        hMod2.fireLogin(pCarIn)
        pCarIn.maxHealth = 35 // Mod A (+45) was deleted; only Mod B (+15) remains
        hMod2.stepTicks(1)
        assert.strictEqual(pCarIn.health, 35, 'should restore up to new real cap 35 only')
        assert.strictEqual(hMod2.api.getPendingCount(), 1, 'stays within settle window until window expires')

        hMod2.stepTicks(25)
        assert.strictEqual(hMod2.api.getPendingCount(), 0, 'expired settle window drops unreachable excess 15')
        assert.strictEqual(hMod2.api.getRecord('uuid-p3'), null, 'deleted-mod surplus must not persist past settlement window')

        // 窗口到期后玩家自己再装回新加血道具，绝不能 retroactively 补血
        pCarIn.maxHealth = 80
        hMod2.stepTicks(5)
        assert.strictEqual(pCarIn.health, 35, 'equipping new gear after settlement must not refund discarded excess')

        // 4. 死亡清档、假玩家忽略、结算期闪退保留未扣血额度、无 JsonIO 回退 server.persistentData
        var sharedPd = {
            store: {},
            getString: function (k) { return this.store[k] || '' },
            putString: function (k, v) { this.store[k] = String(v) }
        }
        var hFb = makeBugfixHarness({ disableJsonIo: true, pd: sharedPd })
        // 假玩家忽略
        var pFake = hFb.mkPlayer('uuid-fake', 'Deployer', 100, 100, { fake: true })
        hFb.fireLogout(pFake)
        assert.strictEqual(hFb.api.getRecord('uuid-fake'), null)

        // 无 JsonIO 回退写入 server.persistentData
        hFb.fireLogout(hFb.mkPlayer('uuid-p4', 'Dave', 55, 60))
        assert.ok(sharedPd.store.epiphy_bugfix_logout_hp_v1 && sharedPd.store.epiphy_bugfix_logout_hp_v1.indexOf('55') >= 0)

        // 重载后从 server.persistentData 读回，在 tick 0 受伤4点且尚未加载完即闪退
        var hFb2 = makeBugfixHarness({ disableJsonIo: true, pd: sharedPd })
        var pDaveFast = hFb2.mkPlayer('uuid-p4', 'Dave', 20, 20)
        hFb2.fireLogin(pDaveFast)
        pDaveFast.health = 16 // hurt 4 mid-settlement
        hFb2.fireLogout(pDaveFast)
        assert.strictEqual(hFb2.api.getRecord('uuid-p4').hp, 51, 'mid-settlement disconnect keeps remaining headroom minus damage (55 - 4 = 51)')

        // 死亡清除记录，防止读到旧血量复活作弊
        for (var di = 0; di < hFb2.handlers.death.length; di++) {
            hFb2.handlers.death[di]({ server: hFb2.serverObj, entity: pDaveFast })
        }
        assert.strictEqual(hFb2.api.getRecord('uuid-p4'), null, 'EntityEvents.death must purge saved logout HP')
    })

    test('regressions: Rhino ServerPlayer null-check, WindowsPath string-join + KubeJSPaths.dir, Sheets Mojmap probe & blur+glow fade reduction', function () {
        // 1. Rhino 中对未解包 Java 对象执行 !x 会触发 Invalid JavaScript value InternalError：
        //    验证 isArrayLike/isJavaListLike 直接采用 == null 且源码无 !x，并完整跑通 EpiphyAudio.play + snapshotPlayers
        assert.ok(!/function isArrayLike[\s\S]*?!x\b/.test(fs.readFileSync(SPEC_PATH, 'utf8')), 'SPEC.isArrayLike must not coerce object via !x')
        assert.ok(!/function isJavaListLike[\s\S]*?x\s*&&/.test(fs.readFileSync(SPEC_PATH, 'utf8')), 'SPEC.isJavaListLike must not coerce object via x &&')
        assert.ok(!/function isArrayLike[\s\S]*?!x\b/.test(fs.readFileSync(SERVER_BASE_PATH, 'utf8')), 'BASE.isArrayLike must not coerce object via !x')

        var dirCalls = []
        var fakeKubeJsPaths = { dir: function (p) { dirCalls.push(String(p)); return { toString: function () { return String(p) } } } }
        var audioSb = createKubeSandbox(function (cls) {
            if (cls === 'net.minecraft.world.level.storage.LevelResource') return { ROOT: 'ROOT' }
            if (cls === 'dev.latvian.mods.kubejs.KubeJSPaths') return fakeKubeJsPaths
            return null // java.io.File deliberately blocked by ClassFilter!
        })
        var fakePlayerSent = []
        var fakePlayerObj = {
            uuid: { toString: function () { return 'uuid-rhino-p1' } },
            username: 'EpiphyPlayer',
            x: 10.5, y: 64.0, z: -2.25,
            health: 45, maxHealth: 60,
            isAlive: function () { return true },
            level: { dimension: 'minecraft:overworld' },
            isRemoved: function () { return false },
            sendData: function (ch, payload) { fakePlayerSent.push({ ch: ch, payload: payload }) }
        }
        var winPathMock = {
            toAbsolutePath: function () { return this },
            normalize: function () { return this },
            toString: function () { return 'X:\\<mc-instance>\\.minecraft\\saves\\New World\\.' },
            resolve: function () { throw new Error('Rhino overload ambiguity on WindowsPath.resolve(String)') }
        }
        audioSb.server = {
            players: [fakePlayerObj],
            persistentData: { getString: function () { return '' }, putString: function () {} },
            getWorldPath: function () { return winPathMock },
            getAllLevels: function () { return [{ dimension: 'minecraft:overworld', players: [fakePlayerObj] }] },
            getPlayerList: function () { return { getPlayers: function () { return [fakePlayerObj] }, getPlayerByName: function () { return fakePlayerObj } } }
        }
        var serverTicks = []
        var logoutHandlers = []
        var jsonWritePaths = []
        audioSb.ServerEvents.tick = function (fn) { serverTicks.push(fn) }
        audioSb.ServerEvents.loaded = function () {}
        audioSb.ServerEvents.commandRegistry = function () {}
        audioSb.ServerEvents.command = function () {}
        audioSb.PlayerEvents.loggedOut = function (fn) { logoutHandlers.push(fn) }
        audioSb.PlayerEvents.respawned = function () {}
        audioSb.EntityEvents = { death: function () {} }
        audioSb.NetworkEvents = { dataReceived: function () {} }
        audioSb.JsonIO = { read: function () { return null }, write: function (p) { jsonWritePaths.push(String(p)) } }

        loadServerBase(audioSb)
        runScriptIn(audioSb, BUGFIX_PATH)
        runScriptIn(audioSb, AUDIO_PATH)

        assert.strictEqual(audioSb.global.EpiphySpec.isArrayLike(fakePlayerObj), false)
        var pPos = audioSb.global.EpiphyServerBase.readPos(fakePlayerObj)
        assert.ok(pPos != null && pPos.x === 10.5 && pPos.y === 64.0 && pPos.z === -2.25)

        // WindowsPath.resolve 绝不能再被调用；ensureParentDir 应通过 KubeJSPaths.dir 成功建目录（无 java.io.File）
        var st = audioSb.global.EpiphyServerBase.resolveWorldStorageInfo(audioSb.server, 'kubejs_tracked_blocks.json', 'kubejs/data/epiphy_block_tracker')
        assert.strictEqual(st.isWorldRoot, true)
        assert.strictEqual(st.filePath, 'X:/<mc-instance>/.minecraft/saves/New World/kubejs_tracked_blocks.json')
        assert.strictEqual(audioSb.global.EpiphyServerBase.ensureParentDir(st.filePath), true)
        for (var li = 0; li < logoutHandlers.length; li++) {
            logoutHandlers[li]({ server: audioSb.server, player: fakePlayerObj })
        }
        assert.ok(jsonWritePaths.indexOf('X:/<mc-instance>/.minecraft/saves/New World/kubejs_epiphy_bugfix_hp.json') >= 0, 'EpiphyBugfix must resolve world path without WindowsPath.resolve')
        assert.ok(dirCalls.length >= 2 && dirCalls.every(function (d) { return d === 'X:/<mc-instance>/.minecraft/saves/New World' }))

        // EpiphyAudio.play 对真实玩家位置不应因 !ServerPlayer 崩溃，能正确向玩家发包
        for (var ti = 0; ti < serverTicks.length; ti++) {
            serverTicks[ti]({ server: audioSb.server })
        }
        var hAudio = audioSb.global.EpiphyAudio.play({
            sound: 'epiphy:children_of_the_city',
            at: [10, 64, -2],
            dim: 'minecraft:overworld',
            range: 30,
            loop: true
        })
        assert.ok(hAudio > 0, 'EpiphyAudio.play must succeed with online ServerPlayer')
        for (var ti2 = 0; ti2 < serverTicks.length; ti2++) {
            serverTicks[ti2]({ server: audioSb.server })
        }
        assert.ok(fakePlayerSent.length >= 1, 'online player in range must receive start packet')

        // 2. Sheets Mojmap 优先探测 + bufSrc.endBatch 优先探测：访问 m_110787_ / m_109912_ 时抛错也不得产生 WARN/ERROR
        var cliWarns = []
        var sheetsProbeThrows = {
            translucentCullBlockSheet: function () { return { sheet: 'emoji' } }
        }
        Object.defineProperty(sheetsProbeThrows, 'm_110787_', {
            get: function () { throw new Error('InternalError: m_110787_ missing on NativeJavaClass') }
        })
        var endBatchCalls = 0
        var bufSrcMojmap = {
            endBatch: function () { endBatchCalls++ }
        }
        Object.defineProperty(bufSrcMojmap, 'm_109912_', {
            get: function () { throw new Error('InternalError: m_109912_ missing') }
        })
        function M4() { this.z = 0 }
        M4.prototype.set = function (o) { this.z = o ? o.z : 0; return this }
        M4.prototype.translate = function (dx, dy, dz) { this.z += (dz || 0); return this }
        M4.prototype.rotateZ = function () { return this }
        M4.prototype.scale = function () { return this }
        var rDraws = []
        var fakeLayoutEmoji = {
            hasColorEmoji: function () { return true },
            equals: function (o) { return Boolean(o && o._k === 'e') },
            _k: 'e',
            drawText: function (mat, b, x, y, r, g, bl, a, shd, mode) { rDraws.push({ x: x, y: y, a: a, mode: mode }) }
        }
        var rPaints = []
        var rNow = 1000
        var rCliSb = {
            console: { info: function () {}, warn: function (m) { cliWarns.push(String(m)) }, error: function (m) { cliWarns.push(String(m)) }, debug: function () {}, log: function () {} },
            ClientEvents: { loggedOut: function () {}, loggedIn: function () {}, paintScreen: function (fn) { rPaints.push(fn) } },
            NetworkEvents: { dataReceived: function () {} },
            Java: {
                loadClass: function (cls) {
                    if (cls === 'java.lang.System') return { nanoTime: function () { return rNow * 1000000 } }
                    if (cls === 'net.minecraft.client.gui.Font$DisplayMode') return { NORMAL: 'NORMAL' }
                    if (cls === 'org.joml.Matrix4f') return M4
                    if (cls === 'net.minecraft.client.renderer.Sheets') return sheetsProbeThrows
                    if (cls === 'icyllis.modernui.mc.text.TextLayoutEngine') return {
                        getInstance: function () {
                            return {
                                lookupFormattedLayout: function () { return fakeLayoutEmoji },
                                getTextRenderer: function () { return { chooseMode: function () { return 4 } } }
                            }
                        }
                    }
                    if (cls === 'icyllis.modernui.mc.text.ModernTextRenderer') return { sAllowSDFTextIn2D: true }
                    return null
                }
            },
            Text: { of: function (s) { return { string: String(s), getVisualOrderText: function () { return String(s) } } } },
            global: {}
        }
        rCliSb.globalThis = rCliSb
        vm.createContext(rCliSb)
        loadStartupBase(rCliSb)
        runScriptIn(rCliSb, RENDERER_PATH)
        var rClient = rCliSb.global.ScreenDanmakuClient
        rClient.push({
            title: 'A',
            typewriter: false,
            outlineMode: 'glow',
            shadow: false,
            fadeStyle: 'blur',
            stay: 20,    // total 1000ms (fade [500..1000])
            fadeOut: 10  // 500ms
        })
        var rEv = {
            width: 854, height: 480, level: 'minecraft:overworld',
            font: { width: function () { return 6 } },
            graphics: { bufferSource: function () { return bufSrcMojmap }, flush: function () {} },
            getMatrix: function () { return new M4() }
        }
        rPaints[0](rEv)
        assert.strictEqual(cliWarns.length, 0, 'Sheets Mojmap-first probe must produce zero warnings')
        assert.ok(endBatchCalls >= 1, 'bufSrc.endBatch Mojmap-first must succeed for emoji layouts')
        assert.strictEqual(rDraws.length, 5, 'alive frame: 4 diag glow + 1 core')

        // 推进至 blur fade 60%（t=1000+800 -> fadeProgress = 300/500 = 0.60 >= 0.42）：glow 提前收起，仅绘制 2 对角虚影 + 1 核心 = 3 passes
        rNow = 1000 + 800
        rDraws.length = 0
        rPaints[0](rEv)
        assert.strictEqual(rDraws.length, 3, 'late blur fade (>=42%) skips glow and draws 2 diag mist + 1 core = 3 passes')
    })

    // ----------------------------------------------------------------------------
    // 26. Pillar 1: epiphy-data skeleton, atomic .tmp+.bak, daily logs & worldId auto-fork
    // ----------------------------------------------------------------------------
    test('epiphy-data: skeleton dirs, atomic write + .bak, daily readable logs & lastWorldPath auto-fork', function () {
        var os = require('os')
        var tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'epiphy_p1_'))
        try {
            var gameDir = path.join(tmpRoot, 'game')
            var sb = makeNodeBackedJavaSandbox(gameDir)
            vm.runInContext(fs.readFileSync(LOG_PATH, 'utf8'), sb, { filename: 'Epiphy的-日志.js' })
            loadServerBase(sb)

            var Base = sb.global.EpiphyServerBase
            var Log  = sb.global.EpiphyLog
            var dataRoot = Base.resolveEpiphyDataRoot()
            assert.strictEqual(path.resolve(dataRoot), path.resolve(path.join(gameDir, 'epiphy-data')))

            var expectedSubdirs = ['config', 'worlds', 'players', 'events', 'logs', 'presets', 'backups']
            for (var i = 0; i < expectedSubdirs.length; i++) {
                var subPath = path.join(dataRoot, expectedSubdirs[i])
                assert.ok(fs.existsSync(subPath) && fs.statSync(subPath).isDirectory(), 'missing skeleton dir: ' + expectedSubdirs[i])
            }
            assert.ok(fs.existsSync(path.join(dataRoot, 'config', 'logging.json')), 'logging.json must be auto-created')

            // Log sink writes daily readable .log files & supports mode change
            Log.warn('TestMod', 'dailyCheck', 'first-line-log', null, 0)
            var d = new Date()
            var p2 = function (n) { return n < 10 ? ('0' + n) : String(n) }
            var dailyName = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + '.log'
            var dailyPath = path.join(dataRoot, 'logs', dailyName)
            assert.ok(fs.existsSync(dailyPath), 'daily log file must exist: ' + dailyPath)
            var logContent = fs.readFileSync(dailyPath, 'utf8')
            assert.ok(logContent.indexOf('[WARN ]') >= 0 && logContent.indexOf('first-line-log') >= 0)

            Log.configureFileSink({ mode: 'single' })
            Log.info('TestMod', 'singleCheck', 'single-line-log')
            assert.ok(fs.existsSync(path.join(dataRoot, 'logs', 'epiphy.log')))

            // Atomic write produces .bak on overwrite and leaves zero .tmp
            var testJson = path.join(dataRoot, 'config', 'atomic_test.json')
            assert.strictEqual(Base.writeJsonAtomic(testJson, { step: 1 }), true)
            assert.strictEqual(Base.writeJsonAtomic(testJson, { step: 2 }), true)
            assert.ok(fs.existsSync(testJson + '.bak'), 'overwrite must preserve .bak backup')
            assert.strictEqual(fs.existsSync(testJson + '.tmp'), false, 'must leave zero .tmp residue')
            assert.strictEqual(Base.readJsonSafe(testJson).step, 2)
            assert.strictEqual(Base.readJsonSafe(testJson + '.bak').step, 1)

            // World identification & lastWorldPath copy auto-fork
            function makeWorldSrv(worldName, savePath) {
                return {
                    getWorldData: function () { return { getLevelName: function () { return worldName } } },
                    getWorldPath: function () { return savePath }
                }
            }
            var prodPath = path.join(gameDir, 'saves', 'ProdWorld')
            var copyPath = path.join(gameDir, 'saves', 'TestCopy')
            fs.mkdirSync(prodPath, { recursive: true })
            fs.mkdirSync(copyPath, { recursive: true })

            var ctxProd = Base.resolveEpiphyWorldContext(makeWorldSrv('ProdWorld', prodPath))
            assert.ok(ctxProd.worldId && ctxProd.folderName.indexOf('ProdWorld__') === 0)
            assert.ok(fs.existsSync(ctxProd.anchorPath), 'world anchor data/epiphy_world_id.json must exist')
            assert.ok(fs.existsSync(ctxProd.metaFile), 'external meta.json must exist')

            // Copy world save (carrying same worldId) to another folder path -> must auto-fork!
            fs.mkdirSync(path.join(copyPath, 'data'), { recursive: true })
            fs.copyFileSync(ctxProd.anchorPath, path.join(copyPath, 'data', 'epiphy_world_id.json'))

            var ctxCopy = Base.resolveEpiphyWorldContext(makeWorldSrv('ProdWorld', copyPath))
            assert.notStrictEqual(ctxCopy.worldId, ctxProd.worldId, 'copied save with different path must auto-fork fresh worldId')
            assert.notStrictEqual(ctxCopy.worldDataDir, ctxProd.worldDataDir, 'forked world must isolate external data folder')
            assert.ok(ctxCopy.forkNotice != null && ctxCopy.forkNotice.oldFolder.indexOf(ctxProd.folderName) >= 0)
            assert.strictEqual(Base.consumePendingWorldForkNotices().length, 1)
        } finally {
            fs.rmSync(tmpRoot, { recursive: true, force: true })
        }
    })

    // ----------------------------------------------------------------------------
    // 36. Rhino Java Interop Safety (KubeJSPaths.DIRECTORY parent + Java POJO traps)
    // ----------------------------------------------------------------------------
    test('Rhino Java interop: KubeJSPaths.DIRECTORY parent resolution & strict Java POJO guards', function () {
        function makeStrictJavaProxy(obj, label) {
            var allowed = {
                Symbol: true,
                then:   true,
                inspect: true
            }
            return new Proxy(obj, {
                get: function (target, prop) {
                    if (typeof prop === 'symbol') return target[prop]
                    var p = String(prop)
                    if (Object.prototype.hasOwnProperty.call(target, p)) return target[p]
                    if (allowed[p]) return undefined
                    throw new Error('EvaluatorException: Java class/object "' + label + '" has no property "' + p + '"')
                }
            })
        }

        var fakeKubePaths = makeStrictJavaProxy({
            DIRECTORY: 'D:/FakeMinecraftInstance/kubejs',
            CONFIG:    'D:/FakeMinecraftInstance/kubejs/config'
        }, 'KubeJSPaths')

        var strictLevel = makeStrictJavaProxy({
            getDimension: function () { return 'minecraft:overworld' },
            hasChunk:     function () { return true },
            isLoaded:     function () { return true },
            getBlock:     function () { return { id: 'minecraft:air' } },
            getPlayers:   function () { return [strictPlayer] }
        }, 'ServerLevel')

        var sentPackets = []
        var strictPlayer = makeStrictJavaProxy({
            getId:          function () { return 101 },
            getName:        function () { return { getString: function () { return 'RhinoPlayer' } } },
            getGameProfile: function () { return { getName: function () { return 'RhinoPlayer' } } },
            getStringUUID:  function () { return '11111111-1111-4000-8000-111111111111' },
            isOp:          function () { return false },
            getX:          function () { return 5 },
            getY:          function () { return 64 },
            getZ:          function () { return 5 },
            getLevel:      function () { return strictLevel },
            sendData:      function (ch, pkt) { sentPackets.push({ ch: ch, pkt: pkt }) }
        }, 'ServerPlayer')

        var strictSrv = makeStrictJavaProxy({
            getWorldData:   function () { return { getLevelName: function () { return 'StrictRhinoWorld' }, getAllowCommands: function () { return true } } },
            getLevel:       function () { return strictLevel },
            getAllLevels:   function () { return [strictLevel] },
            getPlayerList:  function () { return { getPlayers: function () { return [strictPlayer] } } },
            overworld:      function () { return strictLevel },
            persistentData: makeStrictJavaProxy({
                contains:  function () { return false },
                getString: function () { return '' }
            }, 'CompoundTag')
        }, 'MinecraftServer')

        var noop = function () {}
        var sb = {
            console: { info: noop, warn: noop, error: noop, debug: noop, log: noop },
            ServerEvents: {
                loaded: function (fn) { fn({ server: strictSrv }) },
                tick: noop,
                commandRegistry: noop,
                command: noop,
                unloaded: noop
            },
            PlayerEvents: { loggedIn: noop, loggedOut: noop },
            BlockEvents:  { placed: noop, broken: noop },
            Java: {
                loadClass: function (name) {
                    if (name === 'dev.latvian.mods.kubejs.KubeJSPaths') return fakeKubePaths
                    return null
                }
            },
            global: {}
        }
        var con = attachConsoleCapture(sb)
        sb.globalThis = sb
        vm.createContext(sb)
        loadStartupBase(sb)
        runScriptIn(sb, SERVER_BASE_PATH)
        runScriptIn(sb, VALVE_PATH)
        runScriptIn(sb, AUDIO_PATH)

        var BASE = sb.global.EpiphyServerBase
        assert.ok(BASE != null, 'EpiphyServerBase must load when KubeJSPaths only exposes DIRECTORY')
        assert.strictEqual(BASE.resolveEpiphyDataRoot(), 'D:/FakeMinecraftInstance/epiphy-data', 'DIRECTORY ending in /kubejs must resolve parent gameDir')
        assert.strictEqual(BASE.isObjectLike(strictPlayer), true)
        assert.strictEqual(BASE.isArrayLike(strictPlayer), false)
        var readP = BASE.readPos(strictPlayer)
        assert.ok(readP != null && readP.x === 5 && readP.y === 64 && readP.z === 5, 'readPos must read strict ServerPlayer coordinates safely')
        assert.strictEqual(BASE.uuidOf(strictPlayer), '11111111-1111-4000-8000-111111111111')
        assert.strictEqual(BASE.nameOf(strictPlayer), 'RhinoPlayer')

        // Audio & PermissionValve APIs must accept strict Java POJOs cleanly without EvaluatorException
        var handleId = sb.global.EpiphyAudio.play({
            sound:   'minecraft:music.menu',
            entity:  strictPlayer,
            players: [strictPlayer],
            loop:    true
        })
        assert.ok(handleId > 0, 'EpiphyAudio.play on strict Java player/entity must succeed')
        assert.strictEqual(sb.global.EpiphyAudio.stop(strictPlayer), 1, 'EpiphyAudio.stop(strictPlayer) must stop handle without throwing')
        assert.strictEqual(con.errors.length, 0, 'Rhino Java interop test must emit zero console errors: ' + JSON.stringify(con.errors))
        assert.strictEqual(con.warns.length, 0, 'Rhino Java interop test must emit zero console warnings: ' + JSON.stringify(con.warns))
    })

    // ----------------------------------------------------------------------------
    // 37. World Exit/Rejoin Regression: JsonIO LinkedTreeMap + persisted test block danmaku/audio
    // ----------------------------------------------------------------------------
    test('World rejoin regression: JsonIO LinkedTreeMap load & PlayerEvents.loggedIn delayed danmaku + audio trigger', function () {
        var TEST_BLOCK_PATH = path.join(ROOT_DIR, 'kubejs', 'startup_scripts', '通用组件', 'Epiphy的小玩意_功能测试.js')

        function makeMockJavaMap(plainObj) {
            var backing = new Map()
            var keys = Object.keys(plainObj)
            for (var i = 0; i < keys.length; i++) {
                backing.set(keys[i], plainObj[keys[i]])
            }
            // Strict Java Map mock: .size() + .get(key) + .containsKey(key) + .entrySet(), throws on JS property reads like .blocks!
            return new Proxy({
                size:        function () { return backing.size },
                containsKey: function (k) { return backing.has(k) },
                get:         function (k) { return backing.has(k) ? backing.get(k) : null },
                entrySet:    function () { return backing.entries() }
            }, {
                get: function (target, prop) {
                    if (typeof prop === 'symbol') return target[prop]
                    var p = String(prop)
                    if (Object.prototype.hasOwnProperty.call(target, p)) return target[p]
                    if (p === 'then' || p === 'inspect') return undefined
                    throw new Error('EvaluatorException: LinkedTreeMap has no JS field "' + p + '"')
                }
            })
        }

        var fakeJavaList = (function () {
            var row = ['epiphy:rnfmabj_test', 'minecraft:overworld', 12, 64, 10]
            return {
                size: function () { return 1 },
                get:  function (idx) {
                    if (idx !== 0) return null
                    return {
                        size: function () { return row.length },
                        get:  function (j) { return row[j] }
                    }
                }
            }
        })()

        var persistedJavaMap = makeMockJavaMap({
            version:        2,
            updatedAt:      '2026-11-15T05:00:00.000Z',
            migratedLegacy: true,
            blocks:         fakeJavaList
        })

        var serverTicks = []
        var loadedCbs = []
        var loggedInCbs = []
        var loggedOutCbs = []
        var overworldBlock = {
            id: 'epiphy:rnfmabj_test',
            x: 12, y: 64, z: 10,
            getId: function () { return 'epiphy:rnfmabj_test' },
            getX: function () { return 12 }, getY: function () { return 64 }, getZ: function () { return 10 },
            getLevel: function () { return overworldLv }
        }
        var overworldLv = {
            getDimension: function () { return 'minecraft:overworld' },
            dimension: 'minecraft:overworld',
            hasChunk: function () { return true },
            isLoaded: function () { return true },
            getBlock: function (x, y, z) {
                if (Math.floor(x) === 12 && Math.floor(y) === 64 && Math.floor(z) === 10) return overworldBlock
                return { id: 'minecraft:air' }
            },
            players: [],
            getPlayers: function () { return overworldLv.players }
        }
        var netherLv = {
            getDimension: function () { return 'minecraft:the_nether' },
            dimension: 'minecraft:the_nether',
            hasChunk: function () { return true },
            isLoaded: function () { return true },
            getBlock: function () { return { id: 'minecraft:air' } },
            players: [],
            getPlayers: function () { return netherLv.players }
        }
        var rejoiningPlayer = {
            username: 'Rejoiner',
            getId: function () { return 88 },
            getName: function () { return { getString: function () { return 'Rejoiner' } } },
            getStringUUID: function () { return '22222222-2222-4000-8000-222222222222' },
            isOp: function () { return true },
            isRemoved: function () { return false },
            getX: function () { return 10 }, getY: function () { return 64 }, getZ: function () { return 10 },
            getLevel: function () { return overworldLv },
            level: overworldLv,
            sendData: function (ch, pkt) { this._sent.push({ ch: ch, pkt: pkt }) },
            _sent: []
        }
        var netherPlayer = {
            username: 'NetherWatcher',
            getId: function () { return 89 },
            getName: function () { return { getString: function () { return 'NetherWatcher' } } },
            getStringUUID: function () { return '33333333-3333-4000-8000-333333333333' },
            isOp: function () { return true },
            isRemoved: function () { return false },
            getX: function () { return 10 }, getY: function () { return 64 }, getZ: function () { return 10 },
            getLevel: function () { return netherLv },
            level: netherLv,
            sendData: function (ch, pkt) { this._sent.push({ ch: ch, pkt: pkt }) },
            _sent: []
        }

        var rejoinSrv = {
            getWorldData: function () { return { getLevelName: function () { return 'RejoinWorld' }, getAllowCommands: function () { return true } } },
            getWorldPath: function () { return tmpDisk.replace(/\\/g, '/') + '/saves/RejoinWorld' },
            getLevel: function (d) { return String(d).indexOf('the_nether') >= 0 ? netherLv : overworldLv },
            getAllLevels: function () { return [overworldLv, netherLv] },
            getPlayerList: function () { return { getPlayers: function () { return overworldLv.players.concat(netherLv.players) } } },
            overworld: function () { return overworldLv },
            persistentData: { contains: function () { return false }, getString: function () { return '' } }
        }

        var tmpDisk = fs.mkdtempSync(path.join(require('os').tmpdir(), 'epiphy_rejoin_'))
        try {
            var svSb = {
                console: { info: function () {}, warn: function () {}, error: function () {}, debug: function () {}, log: function () {} },
                StartupEvents: {
                    registry: function (_kind, fn) {
                        fn({
                            create: function () {
                                var b = {
                                    displayName: function () { return b }, soundType: function () { return b },
                                    hardness: function () { return b }, resistance: function () { return b },
                                    textureAll: function () { return b }, texture: function () { return b }
                                }
                                return b
                            }
                        })
                    }
                },
                ServerEvents: {
                    loaded:          function (fn) { loadedCbs.push(fn) },
                    unloaded:        function () {},
                    tick:            function (fn) { serverTicks.push(fn) },
                    commandRegistry: function () {}
                },
                BlockEvents: { placed: function () {}, broken: function () {} },
                PlayerEvents: {
                    loggedIn:  function (fn) { loggedInCbs.push(fn) },
                    loggedOut: function (fn) { loggedOutCbs.push(fn) }
                },
                JsonIO: {
                    read:  function (p) { return String(p).indexOf('kubejs_epiphy_tracked_blocks') >= 0 ? persistedJavaMap : null },
                    write: function () {}
                },
                Java: {
                    loadClass: function (name) {
                        if (name === 'dev.latvian.mods.kubejs.KubeJSPaths') {
                            return { DIRECTORY: tmpDisk.replace(/\\/g, '/') + '/kubejs' }
                        }
                        if (name === 'net.minecraft.world.level.storage.LevelResource') {
                            return { ROOT: 'ROOT' }
                        }
                        return null
                    }
                },
                Text: { of: function (s) { return String(s) } },
                global: {}
            }
            var svCon = attachConsoleCapture(svSb)
            svSb.globalThis = svSb
            vm.createContext(svSb)
            loadStartupBase(svSb)
            runScriptIn(svSb, TEST_BLOCK_PATH)
            runScriptIn(svSb, LOG_PATH)
            runScriptIn(svSb, SERVER_BASE_PATH)
            runScriptIn(svSb, TRACKER_PATH)
            runScriptIn(svSb, DANMAKU_PATH)
            runScriptIn(svSb, AUDIO_PATH)

            // Fire ServerEvents.loaded BEFORE players log in (real world startup sequence!)
            for (var li = 0; li < loadedCbs.length; li++) {
                loadedCbs[li]({ server: rejoinSrv })
            }

            // Verify persisted block loaded cleanly from Java LinkedTreeMap with zero importSkipped warnings!
            var trackerStats = svSb.global.EpiphyBlockTracker.getStats()
            assert.strictEqual(
                trackerStats.trackedBlocksSize,
                1,
                'JsonIO LinkedTreeMap must restore the persisted epiphy:rnfmabj_test block; warns=' + JSON.stringify(svCon.warns) + ' errors=' + JSON.stringify(svCon.errors)
            )
            assert.strictEqual(
                svCon.warns.some(function (w) { return w.indexOf('importSkipped') >= 0 }),
                false,
                'JsonIO LinkedTreeMap must never log importSkipped warnings: ' + JSON.stringify(svCon.warns)
            )

            // Now player rejoins the world!
            overworldLv.players.push(rejoiningPlayer)
            netherLv.players.push(netherPlayer)
            for (var pi = 0; pi < loggedInCbs.length; pi++) {
                loggedInCbs[pi]({ player: rejoiningPlayer })
                loggedInCbs[pi]({ player: netherPlayer })
            }

            // Step 10 ticks -> tick 6 triggers delayed login flush right after client ClientEvents.loggedIn reset!
            for (var tk = 0; tk < 10; tk++) {
                for (var ti = 0; ti < serverTicks.length; ti++) {
                    serverTicks[ti]({ server: rejoinSrv })
                }
            }

            var danmakuPkts = rejoiningPlayer._sent.filter(function (x) { return x.ch === 'epiphy:screen_danmaku' })
            var audioPkts   = rejoiningPlayer._sent.filter(function (x) { return x.ch === 'epiphy:audio' && x.pkt && x.pkt.act === 'play' })
            assert.ok(danmakuPkts.length >= 1, 'rejoining overworld player near persisted epiphy:rnfmabj_test must receive danmaku automatically')
            assert.ok(audioPkts.length >= 1, 'rejoining overworld player near persisted epiphy:rnfmabj_test must receive audio automatically')
            assert.strictEqual(
                netherPlayer._sent.filter(function (x) { return x.ch === 'epiphy:screen_danmaku' }).length,
                0,
                'other-dimension player must not receive overworld persisted block danmaku'
            )
            assert.strictEqual(svCon.errors.length, 0, 'world rejoin simulation must emit zero console errors: ' + JSON.stringify(svCon.errors))
        } finally {
            try { fs.rmSync(tmpDisk, { recursive: true, force: true }) } catch (eRm) {}
        }
    })

    // ----------------------------------------------------------------------------
    // 40. KubeJS ClassFilter sandbox: world rejoin keeps same worldId, copy auto-forks, & per-world logs/
    // ----------------------------------------------------------------------------
    test('KubeJS ClassFilter: same world keeps worldId across restarts, copied save forks, and runtime logs write to world/logs/', function () {
        var os = require('os')
        var tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'epiphy_kjs_cf_'))
        try {
            var gameDir = path.join(tmpRoot, 'mc')
            var save1   = path.join(gameDir, 'saves', 'TestWorld')
            var save2   = path.join(gameDir, 'saves', 'TestWorldCopy')
            fs.mkdirSync(path.join(gameDir, 'kubejs'), { recursive: true })
            fs.mkdirSync(save1, { recursive: true })

            function makeFilteredSandbox() {
                var loadedCbs = []
                var unloadedCbs = []
                var sb = createKubeSandbox(function (clsName) {
                    // Simulate real KubeJS 2001.6.5 ClassFilter blocking java.io / java.nio / java.lang.System
                    if (clsName === 'java.io.File' || clsName.indexOf('java.nio.') === 0 || clsName === 'java.lang.System') {
                        throw new Error('Class ' + clsName + ' is not allowed by class filter!')
                    }
                    if (clsName === 'dev.latvian.mods.kubejs.KubeJSPaths') {
                        return {
                            DIRECTORY: path.join(gameDir, 'kubejs').replace(/\\/g, '/'),
                            dir: function (d) {
                                var rp = path.resolve(String(d))
                                fs.mkdirSync(rp, { recursive: true })
                                return rp.replace(/\\/g, '/')
                            }
                        }
                    }
                    if (clsName === 'net.minecraft.world.level.storage.LevelResource') {
                        return { ROOT: 'ROOT' }
                    }
                    return null
                })
                sb.ServerEvents.loaded = function (fn) { loadedCbs.push(fn) }
                sb.ServerEvents.unloaded = function (fn) { unloadedCbs.push(fn) }
                sb.JsonIO = {
                    readString: function (p) {
                        var rp = path.resolve(String(p))
                        if (!fs.existsSync(rp)) throw new Error('java.nio.file.NoSuchFileException: ' + rp)
                        return fs.readFileSync(rp, 'utf8')
                    },
                    read: function (p) {
                        var rp = path.resolve(String(p))
                        if (!fs.existsSync(rp)) return null
                        // Poisonous NativeJavaMap simulation: .keySet/.iterator return undefined, reflection props throw
                        var parsed = JSON.parse(fs.readFileSync(rp, 'utf8'))
                        return new Proxy(parsed, {
                            get: function (target, prop) {
                                if (prop === 'class' || prop === 'constructors') {
                                    throw new Error('InternalError: Java class "[Ljava.lang.reflect.Constructor;" has no public instance field or method named "keySet".')
                                }
                                return target[prop]
                            }
                        })
                    },
                    write: function (p, obj) {
                        var rp = path.resolve(String(p))
                        fs.mkdirSync(path.dirname(rp), { recursive: true })
                        fs.writeFileSync(rp, JSON.stringify(obj, null, 2), 'utf8')
                    }
                }
                var cap = attachConsoleCapture(sb)
                vm.runInContext(fs.readFileSync(LOG_PATH, 'utf8'), sb, { filename: 'Epiphy的-日志.js' })
                loadServerBase(sb)
                return { sb: sb, cap: cap, loadedCbs: loadedCbs, unloadedCbs: unloadedCbs }
            }

            function mkSrv(saveDir) {
                return {
                    getWorldData: function () { return { getLevelName: function () { return 'TestWorld' } } },
                    getWorldPath: function () { return saveDir.replace(/\\/g, '/') }
                }
            }

            // Session 1: initial enter world
            var s1 = makeFilteredSandbox()
            for (var i1 = 0; i1 < s1.loadedCbs.length; i1++) s1.loadedCbs[i1]({ server: mkSrv(save1) })
            var Base1 = s1.sb.global.EpiphyServerBase
            var Log1  = s1.sb.global.EpiphyLog
            var ctx1  = Base1.resolveEpiphyWorldContext(mkSrv(save1))

            assert.ok(fs.existsSync(path.join(gameDir, 'epiphy-data', 'config', 'logging.json')), 'logging.json must be created even under KubeJS ClassFilter')
            assert.ok(fs.existsSync(path.join(gameDir, 'epiphy-data', 'worlds', 'worlds_index.json')), 'worlds_index.json must be created')
            assert.ok(fs.existsSync(ctx1.anchorPath), 'save anchor epiphy_world_id.json must exist')
            assert.ok(fs.existsSync(ctx1.metaFile), 'world meta.json must exist')
            assert.ok(fs.existsSync(ctx1.logsDir) && fs.statSync(ctx1.logsDir).isDirectory(), 'per-world logs/ dir must exist')

            Log1.warn('TestMod', 'session1', 'hello-world-log-1', null, 0)
            var d = new Date()
            var p2 = function (n) { return n < 10 ? ('0' + n) : String(n) }
            var dayFile = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + '.log'
            var worldLogFile = path.join(ctx1.logsDir, dayFile)
            assert.ok(fs.existsSync(worldLogFile), 'runtime log file must be created inside world/logs/: ' + worldLogFile)
            var logTxt1 = fs.readFileSync(worldLogFile, 'utf8')
            assert.ok(logTxt1.indexOf('hello-world-log-1') >= 0, 'world log must record session1 log entry')
            assert.strictEqual(s1.cap.errors.length, 0, 'session 1 must have zero errors')

            // Session 2: fresh VM sandbox, rejoin SAME save1 -> MUST preserve same worldId & folderName
            var s2 = makeFilteredSandbox()
            for (var i2 = 0; i2 < s2.loadedCbs.length; i2++) s2.loadedCbs[i2]({ server: mkSrv(save1) })
            var ctx2 = s2.sb.global.EpiphyServerBase.resolveEpiphyWorldContext(mkSrv(save1))
            assert.strictEqual(ctx2.worldId, ctx1.worldId, 'rejoining same save under ClassFilter must keep exact same worldId')
            assert.strictEqual(ctx2.folderName, ctx1.folderName, 'rejoining same save must reuse same world folder')
            assert.strictEqual(
                s2.cap.warns.some(function (w) { return w.indexOf('Constructor') >= 0 || w.indexOf('readJsonSafe') >= 0 }),
                false,
                'session 2 must have zero JsonIO/Constructor warnings: ' + JSON.stringify(s2.cap.warns)
            )
            var worldFoldersAfterRejoin = fs.readdirSync(path.join(gameDir, 'epiphy-data', 'worlds')).filter(function (x) {
                return x.indexOf('TestWorld__') === 0
            })
            assert.strictEqual(worldFoldersAfterRejoin.length, 1, 'rejoin must not duplicate world folders: ' + JSON.stringify(worldFoldersAfterRejoin))

            // Session 3: even if worlds_index.json is absent (pre-existing world dir on disk), anchor.folderName self-heals
            fs.rmSync(path.join(gameDir, 'epiphy-data', 'worlds', 'worlds_index.json'))
            var s3 = makeFilteredSandbox()
            for (var i3 = 0; i3 < s3.loadedCbs.length; i3++) s3.loadedCbs[i3]({ server: mkSrv(save1) })
            var ctx3 = s3.sb.global.EpiphyServerBase.resolveEpiphyWorldContext(mkSrv(save1))
            assert.strictEqual(ctx3.worldId, ctx1.worldId, 'missing worlds_index.json must still resolve same world via anchor.folderName')
            assert.ok(fs.existsSync(path.join(gameDir, 'epiphy-data', 'worlds', 'worlds_index.json')), 'worlds_index.json must self-heal')

            // Session 4: copy save1 -> save2 (different path carrying same anchor) -> MUST auto-fork!
            fs.mkdirSync(path.join(save2, 'data'), { recursive: true })
            fs.copyFileSync(ctx1.anchorPath, path.join(save2, 'data', 'epiphy_world_id.json'))
            var s4 = makeFilteredSandbox()
            var ctx4 = s4.sb.global.EpiphyServerBase.resolveEpiphyWorldContext(mkSrv(save2))
            assert.notStrictEqual(ctx4.worldId, ctx1.worldId, 'copied save at different path must auto-fork new worldId')
            assert.notStrictEqual(ctx4.folderName, ctx1.folderName, 'copied save must fork isolated world folder')
            assert.ok(ctx4.forkNotice != null && ctx4.forkNotice.oldFolder.indexOf(ctx1.folderName) >= 0, 'forkNotice must reference original folder')
            s4.sb.global.EpiphyLog.warn('TestMod', 'forked', 'hello-forked-log', null, 0)
            assert.ok(fs.existsSync(path.join(ctx4.logsDir, dayFile)), 'forked world must write runtime logs to its own logs/ subfolder')

            // Confirm session1 + session2 appended entries still exist intact in world1 log without loss
            var logTxtFinal = fs.readFileSync(worldLogFile, 'utf8')
            assert.ok(logTxtFinal.indexOf('hello-world-log-1') >= 0, 'existing world log entries must be preserved across restarts')
        } finally {
            fs.rmSync(tmpRoot, { recursive: true, force: true })
        }
    })

    // ----------------------------------------------------------------------------
    // 58. Persistence transactions, 3-state scope hierarchy, command block strict_op & unload cleanup
    // ----------------------------------------------------------------------------
    test('audit fixes: persistence .bak recovery & corruption guard, 3-state scope hierarchy, command block strict_op & unload cleanup', function () {
        var os = require('os')
        var tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'epiphy_audit58_'))
        try {
            var gameDir = path.join(tmpRoot, 'game')
            var saveDir = path.join(gameDir, 'saves', 'AuditWorld')
            fs.mkdirSync(saveDir, { recursive: true })

            function FakeCommandBlock() {}
            var sb = makeNodeBackedJavaSandbox(gameDir)
            var origLoadClass = sb.Java.loadClass
            sb.Java.loadClass = function (cls) {
                if (cls === 'net.minecraft.world.level.BaseCommandBlock') return FakeCommandBlock
                return origLoadClass(cls)
            }
            var unloadCbs = []
            var logoutCbs = []
            var cmdCbs = []
            sb.ServerEvents.unloaded = function (fn) { unloadCbs.push(fn) }
            sb.ServerEvents.commandRegistry = function (fn) { cmdCbs.push(fn) }
            sb.PlayerEvents.loggedOut = function (fn) { logoutCbs.push(fn) }

            loadServerBase(sb)
            runScriptIn(sb, TRACKER_PATH)
            runScriptIn(sb, BUGFIX_PATH)
            runScriptIn(sb, VALVE_PATH)
            runScriptIn(sb, DANMAKU_PATH)
            runScriptIn(sb, AUDIO_PATH)

            var Base = sb.global.EpiphyServerBase
            var Tracker = sb.global.EpiphyBlockTracker
            var Valve = sb.global.EpiphyPermissionValve

            // 1. readJsonDetailed automatically recovers from .bak when primary is CORRUPT, but NOT when primary is intentionally deleted (missing)
            var testJsonPath = path.join(gameDir, 'epiphy_recover_test.json')
            fs.writeFileSync(testJsonPath, '{broken_json', 'utf8')
            fs.writeFileSync(testJsonPath + '.bak', JSON.stringify({ version: 2, ok: true }), 'utf8')
            var det = Base.readJsonDetailed(testJsonPath)
            assert.strictEqual(det.status, 'ok', 'corrupt primary with valid .bak must recover to ok')
            assert.strictEqual(det.fromBackup, true, 'must flag fromBackup')
            assert.strictEqual(det.data.ok, true)
            assert.strictEqual(JSON.parse(fs.readFileSync(testJsonPath, 'utf8')).ok, true, 'primary file must be healed from .bak')

            fs.unlinkSync(testJsonPath)
            var detMissing = Base.readJsonDetailed(testJsonPath)
            assert.strictEqual(detMissing.status, 'missing', 'intentionally deleted primary file must return missing instead of resurrecting from .bak')
            assert.strictEqual(fs.existsSync(testJsonPath), false, 'deleted primary file must remain deleted')

            // 2. World anchor persistence & fallback when anchor file is missing/unwritable
            var pDataStore = {}
            var srv = {
                persistentData: {
                    contains: function (k) { return Object.prototype.hasOwnProperty.call(pDataStore, k) },
                    getString: function (k) { return pDataStore[k] || '' },
                    putString: function (k, v) { pDataStore[k] = String(v) }
                },
                getWorldData: function () { return { getLevelName: function () { return 'AuditWorld' } } },
                getWorldPath: function () { return saveDir },
                players: []
            }
            var ctx1 = Base.resolveEpiphyWorldContext(srv, { forceReload: true })
            var firstWorldId = ctx1.worldId
            assert.ok(firstWorldId && ctx1.folderName.indexOf('AuditWorld__') === 0)

            // Delete anchor file + .bak on disk and force reload: persistentData / memory fallback must keep the exact same worldId!
            if (fs.existsSync(ctx1.anchorPath)) fs.unlinkSync(ctx1.anchorPath)
            if (fs.existsSync(ctx1.anchorPath + '.bak')) fs.unlinkSync(ctx1.anchorPath + '.bak')
            var ctx2 = Base.resolveEpiphyWorldContext(srv, { forceReload: true })
            assert.strictEqual(ctx2.worldId, firstWorldId, 'missing anchor with persistentData backup must NOT generate a new worldId or orphan world directory')

            // 3. 3-state Scope Hierarchy in PermissionValve:
            //    State A: Parent scope ('danmaku') active -> child scope ('danmaku.self') is stored AND covered by parent
            var testPlayer = {
                username: 'ScopeTester',
                stringUuid: '00000000-0000-4000-8000-000000000099',
                getUuid: function () { return '00000000-0000-4000-8000-000000000099' },
                hasPermissions: function () { return false },
                isOp: function () { return false }
            }
            assert.strictEqual(Valve.grantPlayer(srv, testPlayer, 'danmaku.self', 'OP'), true)
            assert.strictEqual(Valve.grantPlayer(srv, testPlayer, 'danmaku', 'OP'), true)
            assert.strictEqual(Valve.hasPlayerGrant(srv, testPlayer, 'danmaku.self'), true)
            assert.strictEqual(Valve.hasPlayerGrant(srv, testPlayer, 'danmaku.pos'), true, 'parent danmaku covers danmaku.pos')
            var entries1 = Valve.listGrantedEntries(srv)
            assert.ok(entries1.some(function (s) {
                return s.indexOf('00000000-0000-4000-8000-000000000099') >= 0 &&
                       s.indexOf('danmaku.self [由父级 danmaku 默认覆盖]') >= 0
            }), 'stored child scope must be retained and marked as covered by parent danmaku in listGrantedEntries')

            //    State B: Revoke parent ('danmaku') -> parent removed, stored child ('danmaku.self') preserved!
            assert.strictEqual(Valve.revokePlayer(srv, testPlayer, 'danmaku', 'OP'), true)
            assert.strictEqual(Valve.hasPlayerGrant(srv, testPlayer, 'danmaku.pos'), false, 'uncovered child danmaku.pos is no longer active after parent revoke')
            assert.strictEqual(Valve.hasPlayerGrant(srv, testPlayer, 'danmaku.self'), true, 'explicitly stored child danmaku.self survives parent-only revoke')

            //    State C: Revoke subtree ('danmaku.*') -> entire tree removed & subtree tombstone blocks rollback resurrection
            assert.strictEqual(Valve.grantPlayer(srv, testPlayer, 'danmaku', 'OP'), true)
            var grantsFile = ctx1.permissionsFile
            var snapshotBeforeTreeRevoke = fs.readFileSync(grantsFile, 'utf8')
            assert.strictEqual(Valve.revokePlayer(srv, testPlayer, 'danmaku.*', 'OP'), true)
            assert.strictEqual(Valve.hasPlayerGrant(srv, testPlayer, 'danmaku'), false)
            assert.strictEqual(Valve.hasPlayerGrant(srv, testPlayer, 'danmaku.self'), false, 'danmaku.* subtree revoke removes stored child danmaku.self')

            // Simulate world rollback of permissions.json: subtree tombstone ('danmaku.*') in revocations.json must prune both parent and child!
            fs.writeFileSync(grantsFile, snapshotBeforeTreeRevoke, 'utf8')
            fs.writeFileSync(grantsFile + '.bak', snapshotBeforeTreeRevoke, 'utf8')
            Valve.reloadWorldGrants(srv)
            assert.strictEqual(Valve.hasPlayerGrant(srv, testPlayer, 'danmaku'), false, 'danmaku.* tombstone blocks parent resurrection on rollback')
            assert.strictEqual(Valve.hasPlayerGrant(srv, testPlayer, 'danmaku.self'), false, 'danmaku.* tombstone blocks child resurrection on rollback')

            // 4. Command Block trust & strict_op mutation lock (including /execute as <OnlineOP> disguise)
            var rawCmdBlock = new FakeCommandBlock()
            var onlineOp = {
                username: 'ServerAdmin',
                stringUuid: '00000000-0000-4000-8000-000000000001',
                hasPermissions: function () { return true },
                isOp: function () { return true }
            }
            var disguisedCmdBlockSource = {
                source: rawCmdBlock,
                player: onlineOp,
                getPlayer: function () { return onlineOp },
                getServer: function () { return srv },
                hasPermission: function () { return true },
                getTextName: function () { return '@' }
            }
            var classified = Valve.classifyCommandSource(disguisedCmdBlockSource)
            assert.strictEqual(classified.kind, 'command_block', 'BaseCommandBlock executing as OnlineOP must still be classified as command_block')
            var defaultEval = Valve.evaluateSourceAccess(disguisedCmdBlockSource, 'danmaku', 'default')
            assert.strictEqual(defaultEval.allowed, true, 'command_block is trusted by default for functional scopes')
            var strictOpEval = Valve.evaluateSourceAccess(disguisedCmdBlockSource, 'auth', 'strict_op')
            assert.strictEqual(strictOpEval.allowed, false, 'command_block is strictly forbidden from mutating permissions under strict_op')

            // 5. Audio playerMaxRange requires audio.broadcast when range > 64, and unload cleans handles
            assert.strictEqual(sb.global.EpiphyAudio.CONFIG.playerMaxRange, 64)
            for (var ui = 0; ui < unloadCbs.length; ui++) unloadCbs[ui]({ server: srv })
            assert.strictEqual(Tracker.getStats().trackedBlocksSize, 0, 'unload clears BlockTracker in-memory records')
        } finally {
            fs.rmSync(tmpRoot, { recursive: true, force: true })
        }
    })
}
