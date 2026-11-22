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
    // 17. audio: syncAll idle skip, conflict arbitration & merged connected block clusters
    // ----------------------------------------------------------------------------
    test('audio: syncAll skips 0-handle ticks, arbitrates conflicts & merges block clusters with union + seamless break', function () {
        var nsNow = 1000000
        var isoSandbox = createKubeSandbox(function (cls) {
            if (cls === 'java.lang.System') return { nanoTime: function () { return (nsNow += 150000) } }
            return null
        })
        var hooks = attachSandboxEventHooks(isoSandbox)
        loadServerBase(isoSandbox)
        runScriptIn(isoSandbox, TRACKER_PATH)
        vm.runInContext(fs.readFileSync(DEBUG_PATH, 'utf8'), isoSandbox, { filename: 'Epiphy的-调试组件.js' })
        vm.runInContext(fs.readFileSync(AUDIO_PATH, 'utf8'), isoSandbox, { filename: 'Epiphy的-音频组件.js' })

        var Audio = isoSandbox.global.EpiphyAudio
        var Debug = isoSandbox.global.EpiphyDebug
        var world = makeMockWorld()
        var p1    = world.addPlayer('Listener1', '00000000-0000-0000-0000-000000000031', 0, 20, 0)
        var p2    = world.addPlayer('Listener2', '00000000-0000-0000-0000-000000000032', 35, 20, 0)

        function stepTicks(n) {
            for (var i = 0; i < n; i++) {
                for (var ti = 0; ti < hooks.tick.length; ti++) hooks.tick[ti]({ server: world.server })
            }
        }
        function placeBlock(x, y, z, id, actor) {
            world.setBlock(x, y, z, id)
            var b = world.makeBlock(x, y, z, id)
            for (var pi = 0; pi < hooks.placed.length; pi++) hooks.placed[pi]({ block: b, level: world.level, player: actor })
        }
        function breakBlock(x, y, z, id, actor) {
            var oldB = world.makeBlock(x, y, z, id)
            world.setBlock(x, y, z, 'minecraft:air')
            for (var bi = 0; bi < hooks.broken.length; bi++) hooks.broken[bi]({ block: oldB, level: world.level, player: actor })
        }

        // Subpart A: 30 ticks with 0 handles -> syncAllCount MUST stay 0!
        stepTicks(30)
        var audSnap = Debug.collectSnapshot('audio')
        assert.strictEqual(audSnap.modules[0].metrics.syncAllCount, 0)

        // Subpart B: standalone play conflict arbitration ('nearest')
        p1.moveTo(8, 20, 0)
        var hNearFar = Audio.play({ at: [0, 20, 0], dim: world.dim, sound: 'minecraft:test.arb', range: 25, loop: true, conflictMode: 'nearest' })
        var hNearCls = Audio.play({ at: [10, 20, 0], dim: world.dim, sound: 'minecraft:test.arb', range: 25, loop: true, conflictMode: 'nearest' })
        assert.ok(hNearFar > 0 && hNearCls > 0)
        stepTicks(5)
        var muteForFar = p1.sentPackets.filter(function (e) { return e.pkt.act === 'mute' && e.pkt.h === hNearFar })
        assert.ok(muteForFar.length > 0 && muteForFar[muteForFar.length - 1].pkt.muted === 1)
        Audio.stopAll()
        assert.strictEqual(Audio.list().length, 0)

        // Subpart C: merge block cluster Rules 1/2/3 + leader handoff + bridge split
        Debug.runAction('audio', 'resetmetrics')
        p1.moveTo(0, 20, 0)
        p2.moveTo(35, 20, 0)
        p1.sentPackets.length = 0
        p2.sentPackets.length = 0

        Audio.bindBlock('epiphy:aud_blk', {
            sound: 'minecraft:test.bgm',
            range: 20,
            loop: true,
            outOfRangeMode: 'stop',
            conflictMode: 'merge',
            conflictScope: 'sound',
            stopOnBlockBreak: true
        })

        // Place B1(0,20,0) -> 1 handle created, P1 plays, P2 silent
        placeBlock(0, 20, 0, 'epiphy:aud_blk', p1)
        assert.strictEqual(Audio.list().length, 1)
        var leaderHId = Audio.list()[0].id
        assert.strictEqual(p1.sentPackets.filter(function (e) { return e.pkt.act === 'play' }).length, 1)
        assert.strictEqual(p2.sentPackets.filter(function (e) { return e.pkt.act === 'play' }).length, 0)

        // Place B2(30,20,0) -> merges into SAME handle (handles.size stays 1!), P2 joins SAME handle with anchor x=30.5
        placeBlock(30, 20, 0, 'epiphy:aud_blk', p2)
        assert.strictEqual(Audio.list().length, 1)
        var p2Play = p2.sentPackets.filter(function (e) { return e.pkt.act === 'play' })
        assert.strictEqual(p2Play.length, 1)
        assert.strictEqual(p2Play[0].pkt.h, leaderHId)
        assert.strictEqual(p2Play[0].pkt.x, 30.5)

        // Move P1 to (28,20,0) (closer to B2 than B1) -> receives seamless act:'update' to x=30.5 on same handle!
        p1.sentPackets.length = 0
        p1.moveTo(28, 20, 0)
        stepTicks(5)
        var p1Upd = p1.sentPackets.filter(function (e) { return e.pkt.act === 'update' })
        assert.strictEqual(p1Upd.length, 1)
        assert.strictEqual(p1Upd[0].pkt.h, leaderHId)
        assert.strictEqual(p1Upd[0].pkt.x, 30.5)

        // Move P1 back to (0,20,0), break Leader B1 -> handle ID stays SAME re-keyed to B2(30.5), P1 stops, P2 undisturbed!
        p1.moveTo(0, 20, 0)
        stepTicks(5) // re-anchor P1 to B1(0.5) before breaking B1
        p1.sentPackets.length = 0
        p2.sentPackets.length = 0
        breakBlock(0, 20, 0, 'epiphy:aud_blk', p1)
        assert.strictEqual(Audio.list().length, 1)
        assert.strictEqual(Audio.list()[0].id, leaderHId)
        assert.strictEqual(Audio.list()[0].x, 30.5)
        assert.strictEqual(p1.sentPackets.some(function (e) { return e.pkt.act === 'stop' && e.pkt.h === leaderHId }), true)
        assert.strictEqual(p2.sentPackets.some(function (e) { return e.pkt.act === 'stop' }), false)

        // Bridge split: place B3(60,20,0) and B4(90,20,0) -> still 1 merged cluster [B2(30), B3(60), B4(90)]; break B3 -> splits into 2 handles!
        placeBlock(60, 20, 0, 'epiphy:aud_blk', p2)
        placeBlock(90, 20, 0, 'epiphy:aud_blk', p2)
        assert.strictEqual(Audio.list().length, 1)
        breakBlock(60, 20, 0, 'epiphy:aud_blk', p2)
        assert.strictEqual(Audio.list().length, 2)

        // Break remaining B2 and B4 -> 0 handles
        breakBlock(30, 20, 0, 'epiphy:aud_blk', p2)
        breakBlock(90, 20, 0, 'epiphy:aud_blk', p2)
        assert.strictEqual(Audio.list().length, 0)
    })

    // 20. audio-client: ESC 暂停/切屏回归后未移动即重同步通道音量/unpause 并立即重连断流
    test('audio-client: ESC pause and window focus resume resyncs gain, unpauses channel and reconnects stopped stream without movement', function () {
        var tickHandlers = []
        var netHandlers  = {}
        var paused       = false
        var winActive    = true
        var curScreen    = null
        var playCalls    = []
        var volCalls     = []
        var unpauseCalls = 0
        var activeSet    = new Set()
        var chanMap      = new Map()
        var chanStopped  = false
        var soundEngine  = { f_120226_: chanMap, f_120231_: [] }
        var soundManager = {
            f_120349_: soundEngine,
            getSoundEvent: function () {
                return { getSound: function () { return { getAttenuationDistance: function () { return 16 } } } }
            },
            play: function (inst) {
                playCalls.push(inst)
                activeSet.add(inst)
                chanStopped = false
                var ch = {
                    m_83666_: function (v) { volCalls.push(v) },
                    m_83678_: function () { unpauseCalls++ },
                    m_83680_: function () { return chanStopped }
                }
                chanMap.set(inst, { execute: function (fn) { fn(ch) } })
            },
            stop: function (inst) {
                activeSet.delete(inst)
                chanMap.delete(inst)
            },
            isActive: function (inst) { return activeSet.has(inst) }
        }
        var playerObj = { getId: function () { return 1 }, getX: function () { return 8 }, getY: function () { return 64 }, getZ: function () { return 0 } }
        var levelObj  = { getDimension: function () { return 'minecraft:overworld' } }
        var mockMc = {
            isPaused: function () { return paused },
            isWindowActive: function () { return winActive },
            getCurrentScreen: function () { return curScreen },
            getSoundManager: function () { return soundManager },
            options: { getSoundSourceVolume: function () { return 1.0 } },
            level: levelObj,
            player: playerObj
        }
        function MockSoundInstance(res, cat, vol, pit, rnd, loop, delay, att, x, y, z, rel) {
            this.res = res; this.f_119572_ = vol; this.f_119573_ = pit; this.f_119574_ = x; this.f_119575_ = y; this.f_119576_ = z; this.f_119577_ = Boolean(loop)
        }

        var cliSandbox = {
            console: { info: function () {}, warn: function () {}, error: function () {}, debug: function () {}, log: function () {} },
            ClientEvents: {
                tick: function (fn) { tickHandlers.push(fn) },
                loggedOut: function () {},
                loggedIn: function () {}
            },
            NetworkEvents: {
                dataReceived: function (ch, fn) { netHandlers[ch] = fn }
            },
            Client: mockMc,
            Java: {
                loadClass: function (cls) {
                    if (cls === 'net.minecraft.client.Minecraft') return { getInstance: function () { return mockMc } }
                    if (cls === 'net.minecraft.resources.ResourceLocation') return function (s) { this._id = String(s); this.toString = function () { return this._id } }
                    if (cls === 'net.minecraft.sounds.SoundSource') return { MASTER: 'MASTER', RECORDS: 'RECORDS', MUSIC: 'MUSIC', valueOf: function (n) { return n } }
                    if (cls === 'net.minecraft.util.RandomSource') return { create: function () { return {} } }
                    if (cls === 'net.minecraft.client.resources.sounds.SimpleSoundInstance') return MockSoundInstance
                    if (cls === 'net.minecraft.client.resources.sounds.SoundInstance$Attenuation') return { NONE: 'NONE', LINEAR: 'LINEAR' }
                    return null
                }
            },
            global: {}
        }
        cliSandbox.globalThis = cliSandbox
        vm.createContext(cliSandbox)
        loadStartupBase(cliSandbox)
        vm.runInContext(fs.readFileSync(AUDIO_CLIENT_PATH, 'utf8'), cliSandbox, { filename: 'Epiphy的-音频播放器.js' })

        var AudioCli = cliSandbox.global.EpiphyAudioClient
        assert.ok(AudioCli && tickHandlers.length === 1 && netHandlers['epiphy:audio'])

        // 1. 收到循环+fadeIn 播放包（玩家固定在 x=8，不移动）
        netHandlers['epiphy:audio']({
            data: {
                proto: 5, act: 'play', ses: 1, h: 1,
                snd: 'test:bgm', cat: 'RECORDS', vol: 1.0, pit: 1.0,
                loop: 1, mode: 'smooth', omode: 'mute', resume: 1, duck: 0,
                fin: 20, fout: 20, rst: 1, anc: 'pos', x: 0, y: 64, z: 0, rng: 32
            }
        })
        for (var i = 0; i < 30; i++) tickHandlers[0]({})
        assert.strictEqual(playCalls.length, 1)
        assert.ok(playCalls[0].f_119572_ > 0.7, 'SimpleSoundInstance Java volume (f_119572_) must sync past initial fadeIn 0.02')
        assert.strictEqual(playCalls[0].f_119573_, 1.0, 'SimpleSoundInstance Java pitch (f_119573_) must not be overwritten by volume')

        // 2. 模拟 ESC 暂停 + 切屏失焦，再回到游戏（玩家坐标全程未移动）
        volCalls.length = 0
        unpauseCalls = 0
        paused = true
        winActive = false
        curScreen = { pause: true }
        for (var p = 0; p < 5; p++) tickHandlers[0]({})
        assert.strictEqual(volCalls.length, 0)

        paused = false
        winActive = true
        curScreen = null
        tickHandlers[0]({}) // 回归游戏第 1 tick，零移动！
        assert.ok(volCalls.length >= 1, 'must immediately re-apply channel gain on first resumed tick without player movement')
        assert.ok(volCalls[volCalls.length - 1] > 0.7)
        assert.ok(unpauseCalls >= 1, 'must call Channel.unpause() on resume')

        // 3. 模拟多人/切屏失焦期间底层流停止，回到窗口第 1 tick 必须立即重连（不能拖延到 10 tick 巡检或等待移动）
        volCalls.length = 0
        winActive = false
        for (var w = 0; w < 3; w++) tickHandlers[0]({})
        activeSet.delete(playCalls[0])
        chanStopped = true
        winActive = true
        tickHandlers[0]({})
        assert.strictEqual(playCalls.length, 2, 'must immediately reconnect stopped loop on focus regain without movement')
    })

    test('EpiphyAudio._pure.parseOptions: aliases, bare words, strict errors and unknown tokens', function () {
        var sb = createKubeSandbox()
        loadServerBase(sb)
        runScriptIn(sb, AUDIO_PATH)
        var A = sb.global.EpiphyAudio
        assert.ok(A && A._pure && typeof A._pure.parseOptions === 'function')

        var ok1 = A._pure.parseOptions('vol=0.75 r=32 lifetime=120 life=active mode=linear conflict=nearest omode=bypass stoponbreak=false stoponempty=yes loop all')
        assert.strictEqual(ok1.error, undefined)
        assert.strictEqual(ok1.opts.volume, 0.75)
        assert.strictEqual(ok1.opts.range, 32)
        assert.strictEqual(ok1.opts.lifetime, '120')
        assert.strictEqual(ok1.opts.lifeMode, 'active')
        assert.strictEqual(ok1.opts.falloff, 'linear')
        assert.strictEqual(ok1.opts.conflictMode, 'nearest')
        assert.strictEqual(ok1.opts.outOfRangeMode, 'bypass')
        assert.strictEqual(ok1.opts.stopOnBlockBreak, false)
        assert.strictEqual(ok1.opts.stopWhenEmpty, true)
        assert.strictEqual(ok1.opts.loop, true)
        assert.strictEqual(ok1.opts.audience, 'all')

        var ok2 = A._pure.parseOptions('once active near smooth')
        assert.strictEqual(ok2.error, undefined)
        assert.strictEqual(ok2.opts.loop, false)
        assert.strictEqual(ok2.opts.lifeMode, 'active')
        assert.strictEqual(ok2.opts.audience, 'near')
        assert.strictEqual(ok2.opts.falloff, 'smooth')

        var badBool = A._pure.parseOptions('loop=notabool')
        assert.ok(badBool.error && badBool.error.indexOf('loop') >= 0)

        var badNum = A._pure.parseOptions('vol=abc')
        assert.ok(badNum.error && badNum.error.indexOf('volume') >= 0)

        var badKey = A._pure.parseOptions('unknownKey=1')
        assert.ok(badKey.error && badKey.error.indexOf('unknownKey') >= 0)

        var badWord = A._pure.parseOptions('bogusword')
        assert.ok(badWord.error && badWord.error.indexOf('bogusword') >= 0)
    })

    test('ScreenDanmaku & EpiphyAudio: buildNode builds converged Brigadier trees and executes subcommands', function () {
        var sb = createKubeSandbox()
        loadServerBase(sb)
        runScriptIn(sb, DANMAKU_PATH)
        runScriptIn(sb, AUDIO_PATH)

        function makeMockNode(kind, name) {
            var frozenChildren = []
            var execFn = null
            var node = {
                kind: kind,
                name: name,
                requires: function () { return node },
                executes: function (fn) { execFn = fn; return node },
                suggests: function () { return node },
                then: function (child) { frozenChildren.push(child._snapshot()); return node },
                _snapshot: function () {
                    return { kind: kind, name: name, hasExec: execFn !== null, execFn: execFn, children: frozenChildren.slice() }
                }
            }
            return node
        }

        var Commands = {
            literal: function (n) { return makeMockNode('literal', n) },
            argument: function (n, type) { return makeMockNode('arg:' + type, n) }
        }
        var argNames = ['PLAYERS', 'PLAYER', 'ENTITY', 'ENTITIES', 'WORD', 'STRING', 'GREEDY_STRING',
                        'INTEGER', 'DOUBLE', 'FLOAT', 'DIMENSION', 'VEC3', 'RESOURCE_LOCATION']
        var Arguments = {}
        for (var ai = 0; ai < argNames.length; ai++) {
            (function (t) {
                Arguments[t] = {
                    create: function () { return t },
                    getResult: function (ctx, name) { return ctx.args ? ctx.args[name] : undefined }
                }
            })(argNames[ai])
        }

        var regCtx = {
            event: {},
            Commands: Commands,
            Arguments: Arguments,
            guardExecution: function (fn) { return fn },
            canSee: function () { return true }
        }

        var queue = sb.global.EpiphyCommandRegistryQueue || []
        var specsByName = {}
        for (var qi = 0; qi < queue.length; qi++) {
            if (queue[qi] && queue[qi].name) specsByName[queue[qi].name] = queue[qi]
        }
        assert.ok(specsByName.danmaku && typeof specsByName.danmaku.buildNode === 'function')
        assert.ok(specsByName.audio && typeof specsByName.audio.buildNode === 'function')

        function indexChildren(snap) {
            var m = {}
            for (var c = 0; c < snap.children.length; c++) m[snap.children[c].name] = snap.children[c]
            return m
        }

        var dmSnap = specsByName.danmaku.buildNode(regCtx)._snapshot()
        var dmKids = indexChildren(dmSnap)
        var expectedDm = ['help', 'stop', 'clear', 'player', 'here', 'pos']
        for (var di = 0; di < expectedDm.length; di++) {
            assert.ok(dmKids[expectedDm[di]], 'danmaku missing subcommand: ' + expectedDm[di])
        }

        var sent = []
        var mockSrc = { sendSuccess: function (msg) { sent.push(String(msg)) } }
        assert.strictEqual(dmKids.help.execFn({ source: mockSrc, args: {} }), 1)
        assert.ok(sent.length >= 3, 'danmaku help prints multiple lines')

        var auSnap = specsByName.audio.buildNode(regCtx)._snapshot()
        var auKids = indexChildren(auSnap)
        var expectedAu = ['help', 'play', 'follow', 'at', 'pos', 'dim', 'all', 'update',
                          'stop', 'stopkey', 'stoptag', 'stopsound', 'stopfor', 'stopall', 'list', 'info']
        for (var aui = 0; aui < expectedAu.length; aui++) {
            assert.ok(auKids[expectedAu[aui]], 'audio missing subcommand: ' + expectedAu[aui])
        }

        var audioOut = []
        var auSrc = { sendSuccess: function (msg) { audioOut.push(String(msg)) } }
        assert.strictEqual(auKids.list.execFn({ source: auSrc, args: {} }), 1)
        assert.strictEqual(auKids.stopall.execFn({ source: auSrc, args: {} }), 1)
        assert.ok(audioOut.some(function (l) { return l.indexOf('活动音频句柄') >= 0 }))
        assert.ok(audioOut.some(function (l) { return l.indexOf('0 个活动句柄') >= 0 }))
    })

    // ----------------------------------------------------------------------------
    // 28. Pillar 3A: Audio command isolation (tier, quotas, eviction & listener headroom)
    // ----------------------------------------------------------------------------
    test('audio: authorized player command isolation, quota caps, one-way eviction & listener headroom', function () {
        function MockMinecraftServer() {}
        function MockServerPlayer(name, uuid, op) {
            this.username = name
            this._uuid = uuid
            this._op = Boolean(op)
            this._sent = []
            this.x = 0; this.y = 64; this.z = 0
        }
        MockServerPlayer.prototype.getProfile = function () { return { name: this.username, id: this._uuid } }
        MockServerPlayer.prototype.getStringUUID = function () { return this._uuid }
        MockServerPlayer.prototype.hasPermissions = function (lv) { return this._op && lv <= 4 }
        MockServerPlayer.prototype.sendData = function (ch, pkt) { this._sent.push({ ch: ch, pkt: pkt }) }

        var tickHandlers = []
        var cmdCallbacks = []
        var sb = createKubeSandbox(function (cls) {
            if (cls === 'net.minecraft.server.MinecraftServer') return MockMinecraftServer
            if (cls === 'net.minecraft.server.level.ServerPlayer') return MockServerPlayer
            return null
        })
        sb.ServerEvents.tick = function (fn) { tickHandlers.push(fn) }
        sb.ServerEvents.commandRegistry = function (fn) { cmdCallbacks.push(fn) }
        var auConsole = attachConsoleCapture(sb)

        var authPl = new MockServerPlayer('AuthPlayer', '00000000-0000-4000-8000-0000000000aa', false)
        var listenerPl = new MockServerPlayer('Listener', '00000000-0000-4000-8000-0000000000bb', false)
        var unauthPl = new MockServerPlayer('PlainPlayer', '00000000-0000-4000-8000-0000000000cc', false)
        var opPl = new MockServerPlayer('OpPlayer', '00000000-0000-4000-8000-0000000000dd', true)
        var mockLevel = {
            dimension: 'minecraft:overworld',
            players: [authPl, listenerPl],
            getBlock: function () { return { id: 'minecraft:air' } }
        }
        authPl.level = mockLevel
        listenerPl.level = mockLevel
        var srv = new MockMinecraftServer()
        srv.getWorldData = function () { return { getLevelName: function () { return 'AudioIso' }, getAllowCommands: function () { return true } } }
        srv.getLevel = function () { return mockLevel }
        srv.getAllLevels = function () { return [mockLevel] }
        srv.getPlayerList = function () { return { getPlayers: function () { return [authPl, listenerPl] }, getPlayerByName: function (n) { return n === 'AuthPlayer' ? authPl : listenerPl } } }
        sb.server = srv

        loadServerBase(sb)
        runScriptIn(sb, VALVE_PATH)
        runScriptIn(sb, AUDIO_PATH)

        var Valve = sb.global.EpiphyPermissionValve
        var Audio = sb.global.EpiphyAudio
        Valve.grantPlayer(srv, authPl, 'audio', 'TestAdmin')

        // Build mock Brigadier root
        function FakeNode(kind, name) {
            this._kind = kind; this._name = name; this._children = {}; this._exec = null; this._req = null
        }
        FakeNode.prototype.then = function (child) { if (child) this._children[child._name] = child; return this }
        FakeNode.prototype.executes = function (fn) { this._exec = fn; return this }
        FakeNode.prototype.requires = function (fn) { this._req = fn; return this }
        FakeNode.prototype.suggests = function () { return this }
        var regRoot = null
        var argValues = {}
        function makeArgType(defFn) {
            return {
                create: function () { return {} },
                getResult: defFn || function (c, k) { return argValues[k] }
            }
        }
        var regEv = {
            commands: {
                literal: function (n) { return new FakeNode('lit', n) },
                argument: function (n) { return new FakeNode('arg', n) }
            },
            arguments: {
                GREEDY_STRING:     makeArgType(),
                STRING:            makeArgType(),
                WORD:              makeArgType(),
                RESOURCE_LOCATION: makeArgType(),
                PLAYERS:           makeArgType(),
                DIMENSION:         makeArgType(function () { return 'minecraft:overworld' }),
                VEC3:              makeArgType(),
                ENTITY:            makeArgType()
            },
            register: function (r) { regRoot = r }
        }
        for (var ci = 0; ci < cmdCallbacks.length; ci++) cmdCallbacks[ci](regEv)

        function stepTicks(n) {
            for (var k = 0; k < n; k++) {
                for (var ti = 0; ti < tickHandlers.length; ti++) tickHandlers[ti]({ server: srv })
            }
        }

        // System creates high-priority handle keyed 'boss_bgm'
        var sysId = Audio.play({ sound: 'minecraft:music.dragon', key: 'boss_bgm', audience: 'all', loop: true, priority: 9 })
        assert.ok(sysId > 0)
        stepTicks(10)

        var authMsgs = []
        var authCtx = { source: { player: authPl, getPlayer: function () { return authPl }, getServer: function () { return srv }, sendSuccess: function (m) { authMsgs.push(String(m)) }, sendFailure: function () {} } }
        var unauthSrc = { source: unauthPl, player: unauthPl, getPlayer: function () { return unauthPl }, getServer: function () { return srv }, hasPermission: function () { return true } }
        var opSrc = { source: opPl, player: opPl, getPlayer: function () { return opPl }, getServer: function () { return srv } }
        var audioNode = regRoot._children.audio
        var authNode = regRoot._children.auth

        // Check real Brigadier .requires() gates
        assert.strictEqual(audioNode._req(unauthSrc), false, 'unauthorized player must NOT see /epiphy audio even with stack hasPermission(4)')
        assert.strictEqual(audioNode._req(authCtx.source), true, 'authorized player must see /epiphy audio')
        assert.strictEqual(authNode._req(authCtx.source), false, 'non-OP authorized player must NOT see /epiphy auth')
        assert.strictEqual(authNode._req(opSrc), true, 'real OP must see /epiphy auth')

        // /epiphy audio list & info must work without ReferenceError (describeHandle)
        assert.strictEqual(audioNode._children.list._exec(authCtx), 1, '/epiphy audio list must execute cleanly')
        argValues = { ref: 'boss_bgm' }
        assert.strictEqual(audioNode._children.info._children.ref._exec(authCtx), 1, '/epiphy audio info must execute cleanly')
        assert.ok(authMsgs.some(function (m) { return m.indexOf('boss_bgm') >= 0 }), 'audio info output must describe handle key')
        assert.strictEqual(auConsole.errors.length, 0, 'audio baseline commands must emit zero console errors')
        assert.strictEqual(auConsole.warns.length, 0, 'audio baseline commands must emit zero console warns')

        // Player tries to play with key='boss_bgm' priority=10 -> must NOT overwrite system key, priority clamped <= 3
        argValues = { sound: 'minecraft:block.note_block.harp', options: 'loop=true priority=10 key=boss_bgm' }
        audioNode._children.all._children.sound._children.options._exec(authCtx)
        stepTicks(5)

        assert.ok(Audio.get(sysId) != null && Audio.get(sysId).sound === 'minecraft:music.dragon', 'system handle must remain intact')
        var allHandles = Audio.list()
        assert.strictEqual(allHandles.length, 2)
        var playerH = allHandles.filter(function (h) { return h.id !== sysId })[0]
        assert.strictEqual(playerH.priority, 3, 'player handle priority must clamp to <= 3')

        // Player tries stopall, stopkey boss_bgm, stop sysId -> MUST NOT touch system handle!
        argValues = { key: 'boss_bgm' }
        audioNode._children.stopkey._children.key._exec(authCtx)
        assert.ok(Audio.get(sysId) != null, 'player stopkey must not stop system handle')
        argValues = { ref: String(sysId) }
        audioNode._children.stop._children.ref._exec(authCtx)
        assert.ok(Audio.get(sysId) != null, 'player stop <id> must not stop system handle')
        argValues = {}
        audioNode._children.stopall._exec(authCtx)
        assert.ok(Audio.get(sysId) != null, 'player stopall must not stop system handle')
        assert.strictEqual(Audio.get(playerH.id), null, 'player stopall only stops own player handles')

        // Listener headroom: fill 8 player handles on listenerPl, 9th skipped while system headroom remains!
        for (var pi = 0; pi < 9; pi++) {
            argValues = { targets: [listenerPl], sound: 'minecraft:block.note_block.harp', options: 'loop=true priority=3 key=p' + pi }
            audioNode._children.play._children.targets._children.sound._children.options._exec(authCtx)
        }
        stepTicks(5)
        // Player created handles capped at maxCreatedHandlesPerPlayer (8)
        var pCreated = Audio.list().filter(function (h) { return h.id !== sysId })
        assert.strictEqual(pCreated.length, 8, 'single player must be capped at maxCreatedHandlesPerPlayer=8')

        // System adds 5th/etc handles up to listener cap (12) -> system evicts lowest player handle instead of failing!
        var sysExtraIds = []
        for (var si = 0; si < 5; si++) {
            var sid = Audio.play({ sound: 'minecraft:ambient.cave', players: [listenerPl], loop: true, priority: 7, key: 'sys_extra_' + si })
            assert.ok(sid > 0)
            sysExtraIds.push(sid)
        }
        stepTicks(5)
        for (var si2 = 0; si2 < sysExtraIds.length; si2++) {
            assert.ok(Audio.listeners(sysExtraIds[si2]).length === 1, 'system handle must secure listener slot even when player handles filled up to 12')
        }

        // Client audio evictOldestEntry round-trips real server _sent play packets & preserves system over player tier
        var acTick = null
        var acNet = null
        var acSb = {
            console: { info: function () {}, warn: function () {}, error: function () {}, debug: function () {}, log: function () {} },
            ClientEvents: { loggedOut: function () {}, loggedIn: function () {}, tick: function (fn) { acTick = fn } },
            NetworkEvents: { dataReceived: function (ch, fn) { if (ch === 'epiphy:audio') acNet = fn } },
            Java: { loadClass: function () { return null } },
            global: {}
        }
        var cliAudioCon = attachConsoleCapture(acSb)
        acSb.globalThis = acSb
        vm.createContext(acSb)
        loadStartupBase(acSb)
        runScriptIn(acSb, AUDIO_CLIENT_PATH)
        var acClient = acSb.global.EpiphyAudioClient
        var realPlayPkts = listenerPl._sent
            .filter(function (item) { return item && item.pkt && item.pkt.act === 'play' })
            .map(function (item) { return item.pkt })
        assert.ok(realPlayPkts.some(function (p) { return p.h === sysId && p.tier === 'system' }), 'server _sent must contain real system play pkt')
        assert.ok(realPlayPkts.some(function (p) { return p.tier === 'player' }), 'server _sent must contain real player play pkt')
        for (var rp = 0; rp < realPlayPkts.length; rp++) {
            acNet({ data: realPlayPkts[rp] })
        }
        acTick({})
        assert.ok(acClient.list().some(function (x) { return x.h === sysId }), 'real server _sent system play packet must mount in EpiphyAudioClient')

        var baseSysPkt = realPlayPkts.filter(function (p) { return p.h === sysId })[0]
        for (var cpi = 1000; cpi < 1130; cpi++) {
            acNet({ data: { proto: baseSysPkt.proto, act: 'play', ses: baseSysPkt.ses, h: cpi, tier: 'player', pri: 3, snd: 'minecraft:block.note_block.harp', cat: 'RECORDS', vol: 1, pit: 1, loop: 1, mode: 'flat', anc: 'none', fin: 0, fout: 20 } })
        }
        acTick({})
        assert.strictEqual(acClient.count(), 128, 'client audio entries must respect maxEntries=128')
        assert.ok(acClient.list().some(function (x) { return x.h === sysId }), 'client audio eviction must keep real system handle over player handles')
        assert.strictEqual(cliAudioCon.errors.length, 0, 'audio client round-trip must emit zero errors')
    })

    // ----------------------------------------------------------------------------
    // 32. P1 regressions: Audio client & server (duck pause/restore, 3D channel pos, mul=0 standby, server quotas/reset/scan/dim)
    // ----------------------------------------------------------------------------
    test('P1 regressions (audio client & server): ducking pause/restore, 3D Channel pos, configure validation, pendingReset & dirty scan', function () {
        // --- Part A: Audio client (P1-13, P1-14, P1-15) ---
        var tickHandlers = []
        var netHandlers = {}
        var activeSet = new Set()
        var chanMap = new Map()
        var stopCalls = []
        var musicPaused = 0
        var musicUnpaused = 0
        var modMusicPaused = 0
        var movedPositions = []
        var musicCh = {
            m_83666_: function () {},
            m_83677_: function () { musicPaused++ },
            m_83678_: function () { musicUnpaused++ },
            m_83680_: function () { return false }
        }
        var musicInst = {
            source: 'MUSIC',
            getSource: function () { return 'MUSIC' },
            getLocation: function () { return 'minecraft:music.overworld.meadow' },
            isStopped: function () { return false }
        }
        var modMusicCh = {
            m_83666_: function () {},
            m_83677_: function () { modMusicPaused++ },
            m_83678_: function () {},
            m_83680_: function () { return false }
        }
        var modMusicInst = {
            source: 'MUSIC',
            getSource: function () { return 'MUSIC' },
            getLocation: function () { return 'bosses_of_mass_destruction:lich_theme' },
            isStopped: function () { return false }
        }
        activeSet.add(musicInst)
        activeSet.add(modMusicInst)
        chanMap.set(musicInst, { execute: function (fn) { fn(musicCh) } })
        chanMap.set(modMusicInst, { execute: function (fn) { fn(modMusicCh) } })
        // Simulate Java java.util.Map.entrySet().iterator() on chanMap
        chanMap.entrySet = function () {
            var arr = []
            chanMap.forEach(function (val, key) {
                arr.push({ getKey: function () { return key }, getValue: function () { return val } })
            })
            return {
                iterator: function () {
                    var idx = 0
                    return { hasNext: function () { return idx < arr.length }, next: function () { return arr[idx++] } }
                }
            }
        }

        function MockSoundInst(res, cat, vol, pit, rnd, loop, delay, att, x, y, z) {
            this.res = res; this.f_119573_ = vol; this.f_119575_ = x; this.f_119576_ = y; this.f_119577_ = z
        }
        var catVol = { RECORDS: 1.0, MUSIC: 1.0, MASTER: 1.0 }
        var acStoppedCount = 0
        var acPausedCount = 0
        var acPlayCount = 0
        var soundManager = {
            f_120349_: { f_120226_: chanMap, f_120231_: [] },
            getSoundEvent: function () { return { getSound: function () { return { getAttenuationDistance: function () { return 16 } } } } },
            play: function (inst) {
                acPlayCount++
                activeSet.add(inst)
                var ch = {
                    m_83666_: function () {},
                    m_83677_: function () { acPausedCount++ },
                    m_83678_: function () {},
                    m_83674_: function () { acStoppedCount++ },
                    m_83680_: function () { return false },
                    m_83654_: function (vec) { movedPositions.push([vec.x, vec.y, vec.z]) }
                }
                chanMap.set(inst, { execute: function (fn) { fn(ch) } })
            },
            stop: function (inst) {
                stopCalls.push(inst)
                if (inst != null) { activeSet.delete(inst); chanMap.delete(inst) }
            },
            isActive: function (inst) { return activeSet.has(inst) }
        }
        var playerObj = { getId: function () { return 1 }, getX: function () { return 0 }, getY: function () { return 64 }, getZ: function () { return 0 } }
        var mockMc = {
            isPaused: function () { return false },
            isWindowActive: function () { return true },
            getCurrentScreen: function () { return null },
            getSoundManager: function () { return soundManager },
            options: { getSoundSourceVolume: function (c) { return catVol[c] != null ? catVol[c] : 1.0 } },
            level: { getDimension: function () { return 'minecraft:overworld' } },
            player: playerObj
        }
        var acSb = {
            console: { info: function () {}, warn: function () {}, error: function () {}, debug: function () {}, log: function () {} },
            ClientEvents: { tick: function (fn) { tickHandlers.push(fn) }, loggedOut: function () {}, loggedIn: function () {} },
            NetworkEvents: { dataReceived: function (ch, fn) { netHandlers[ch] = fn } },
            Client: mockMc,
            Java: {
                loadClass: function (cls) {
                    if (cls === 'net.minecraft.client.Minecraft') return { getInstance: function () { return mockMc } }
                    if (cls === 'net.minecraft.resources.ResourceLocation') return function (s) { this._id = String(s); this.toString = function () { return this._id } }
                    if (cls === 'net.minecraft.sounds.SoundSource') return { MASTER: 'MASTER', RECORDS: 'RECORDS', MUSIC: 'MUSIC', valueOf: function (n) { return n } }
                    if (cls === 'net.minecraft.util.RandomSource') return { create: function () { return {} } }
                    if (cls === 'net.minecraft.client.resources.sounds.SimpleSoundInstance') return MockSoundInst
                    if (cls === 'net.minecraft.client.resources.sounds.SoundInstance$Attenuation') return { NONE: 'NONE', LINEAR: 'LINEAR' }
                    if (cls === 'net.minecraft.world.phys.Vec3') return function (x, y, z) { return { x: x, y: y, z: z } }
                    return null
                }
            },
            global: {}
        }
        acSb.globalThis = acSb
        vm.createContext(acSb)
        loadStartupBase(acSb)
        runScriptIn(acSb, AUDIO_CLIENT_PATH)

        netHandlers['epiphy:audio']({
            data: { proto: 5, act: 'play', ses: 1, h: 10, snd: 'test:duck', cat: 'RECORDS', vol: 1.0, pit: 1.0, loop: 1, mode: 'smooth', duck: 1, anc: 'pos', x: 1, y: 64, z: 2, rng: 32 }
        })
        for (var dt = 0; dt < 12; dt++) tickHandlers[0]({})
        assert.ok(musicPaused >= 1, 'duckMusic must pause vanilla minecraft: MUSIC channel')
        assert.strictEqual(modMusicPaused, 0, 'duckMusic must NOT pause third-party mod BGM (non-minecraft namespace)')
        assert.strictEqual(stopCalls.some(function (x) { return x === null || x === musicInst || x === modMusicInst }), false, 'duckMusic must NOT call sm.stop on external MUSIC')

        // P1-14: Position update syncs Channel.setSelfPosition(Vec3) and instance coords
        netHandlers['epiphy:audio']({
            data: { proto: 5, act: 'update', ses: 1, h: 10, x: 12, y: 68, z: -5 }
        })
        tickHandlers[0]({})
        assert.ok(movedPositions.some(function (p) { return p[0] === 12 && p[1] === 68 && p[2] === -5 }), 'position update must sync Channel 3D selfPosition')

        // P1-15: Setting RECORDS volume to 0 pauses via m_83677_ without calling Channel.stop() or recreating stream
        catVol.RECORDS = 0
        tickHandlers[0]({})
        assert.ok(acPausedCount >= 1, 'category mute (mul=0) must pause channel instead of killing stream')
        assert.strictEqual(acPlayCount, 1, 'mul=0 mute must NOT cause stop->reconnect loop')

        // Stop ducking handle while chanMap is temporarily unavailable (e.g. SoundEngine reload):
        // must NOT drop duckedMusicInsts tracking, and must unpause cleanly as soon as chanMap recovers!
        catVol.RECORDS = 1.0
        var savedSeObj = soundManager.f_120349_
        soundManager.f_120349_ = { f_120226_: null, f_120231_: [] }
        netHandlers['epiphy:audio']({ data: { proto: 5, act: 'stop', ses: 1, h: 10, fout: 0 } })
        tickHandlers[0]({})
        assert.strictEqual(musicUnpaused, 0, 'cannot unpause while chanMap is null')
        soundManager.f_120349_ = savedSeObj
        tickHandlers[0]({})
        assert.ok(musicUnpaused >= 1, 'ending ducking must retain duckedMusicInsts across transient chanMap==null and unpause once chanMap recovers')

        // --- Part B: Audio server (P1-7..P1-12, P1-16..P1-17) ---
        var svTick = []
        var svWarns = []
        var throwNextList = true
        var p1 = { username: 'A1', uuid: '00000000-0000-4000-8000-0000000000a1', getId: function () { return 1 }, getName: function () { return { getString: function () { return 'A1' } } }, getStringUUID: function () { return '00000000-0000-4000-8000-0000000000a1' }, isOp: function () { return false }, hasPermissions: function () { return true }, getX: function () { return 0 }, getY: function () { return 64 }, getZ: function () { return 0 }, getLevel: function () { return lv }, level: null, sendData: function (ch, pkt) { this._sent.push(pkt) }, _sent: [] }
        var p2 = { username: 'A2', uuid: '00000000-0000-4000-8000-0000000000a2', getId: function () { return 2 }, getName: function () { return { getString: function () { return 'A2' } } }, getStringUUID: function () { return '00000000-0000-4000-8000-0000000000a2' }, isOp: function () { return false }, getX: function () { return 1 }, getY: function () { return 64 }, getZ: function () { return 0 }, getLevel: function () { return lv }, level: null, sendData: function (ch, pkt) { this._sent.push(pkt) }, _sent: [] }
        var blkStore = {}
        var lv = {
            getDimension: function () { return 'minecraft:overworld' },
            dimension: 'minecraft:overworld',
            hasChunk: function () { return true },
            getBlock: function (x, y, z) { return blkStore[x + ',' + y + ',' + z] || { id: 'minecraft:air' } }
        }
        p1.level = lv; p2.level = lv
        var srv = {
            getWorldData: function () { return { getLevelName: function () { return 'AuP1' }, getAllowCommands: function () { return true } } },
            getLevel: function (d) { return String(d) === 'minecraft:overworld' ? lv : null },
            getAllLevels: function () { return [lv] },
            getPlayerList: function () { if (throwNextList) { throwNextList = false; throw new Error('Transient playerList failure') } return { getPlayers: function () { return [p1, p2] } } },
            getEntities: function () { return [] },
            overworld: function () { return lv }
        }
        var svSb = {
            console: { info: function () {}, warn: function (m) { svWarns.push(String(m)) }, error: function (m) { svWarns.push(String(m)) }, debug: function () {}, log: function () {} },
            ServerEvents: { loaded: function (fn) { fn({ server: srv }) }, unloaded: function () {}, tick: function (fn) { svTick.push(fn) }, commandRegistry: function () {}, command: function () {} },
            PlayerEvents: { loggedIn: function () {}, loggedOut: function () {} },
            BlockEvents: { placed: function () {}, broken: function () {} },
            LevelEvents: { loaded: function () {} },
            Utils: { server: srv },
            server: srv,
            global: {}
        }
        svSb.globalThis = svSb
        vm.createContext(svSb)
        loadStartupBase(svSb)
        loadServerBase(svSb)
        // Intentionally omit VALVE_PATH to test P1-12 fail-closed without Valve
        runScriptIn(svSb, AUDIO_PATH)

        var Audio = svSb.global.EpiphyAudio
        // P1-9: pendingReset must survive transient exception during first tick and retry on tick 2
        svTick[0]({ server: srv })
        assert.strictEqual(p1._sent.length, 0, 'tick 1 threw before reset send completes')
        svTick[0]({ server: srv })
        assert.ok(p1._sent.some(function (pk) { return pk.act === 'reset' }), 'failed pendingReset broadcast must retry on next tick')
        assert.ok(p2._sent.some(function (pk) { return pk.act === 'reset' }), 'failed pendingReset broadcast must reach all players on retry')

        // P1-11: configure rejects syncIntervalTicks=0 without breaking tick
        Audio.configure({ syncIntervalTicks: 0, maxMergeClusterSize: 'bad' })
        assert.ok(svWarns.some(function (w) { return w.indexOf('syncIntervalTicks') >= 0 }), 'configure must warn and reject syncIntervalTicks=0')

        // Play a handle that requires startCond -> unstarted cleanup (P1-8)
        var ghostEnt = { isRemoved: function () { return false }, isAlive: function () { return true }, getX: function () { return 0 }, getY: function () { return 64 }, getZ: function () { return 0 }, getLevel: function () { return lv }, level: lv }
        var hUnstarted = Audio.onEntity(ghostEnt, 'test:wait', { startCond: function () { return false }, startTimeout: 5, audience: 'all' })
        for (var tk = 0; tk < 12; tk++) svTick[0]({ server: srv })
        assert.strictEqual(Audio.isPlaying(hUnstarted), false, 'unstarted handle must expire after startTimeout ticks')

        // P1-16: update block anchor updates bx/by/bz and P1-7 countedListeners decrements cleanly
        function stepSv(n) { for (var k = 0; k < n; k++) svTick[0]({ server: srv }) }
        blkStore['5,64,5'] = { id: 'minecraft:jukebox' }
        blkStore['9,64,9'] = { id: 'minecraft:jukebox' }
        var hBlk = Audio.atBlock({ id: 'minecraft:jukebox', level: lv, pos: { x: 5, y: 64, z: 5 }, x: 5, y: 64, z: 5 }, 'test:loop', { loop: true, stopOnBlockBreak: true, fadeOut: 0 })
        stepSv(6)
        Audio.update(hBlk, { x: 9.5, y: 64.5, z: 9.5 })
        stepSv(6)
        // Old block turns to air -> must NOT stop; new block turns to air -> MUST stop
        blkStore['5,64,5'] = { id: 'minecraft:air' }
        stepSv(6)
        assert.strictEqual(Audio.isPlaying(hBlk), true, 'removing old block after anchor update must NOT stop handle')
        blkStore['9,64,9'] = { id: 'minecraft:air' }
        stepSv(6)
        assert.strictEqual(Audio.isPlaying(hBlk), false, 'removing moved block after anchor update MUST stop handle')
        assert.strictEqual(Audio.list().length, 0, 'ended handle must clean up all active handles')

        // P1-7: endHandle with merge cluster + maxSoundsPerPlayer=1 must accurately release listenCount without leaking quota
        Audio.configure({ maxSoundsPerPlayer: 1 })
        var m1 = Audio.at(0, 64, 0, 'minecraft:overworld', 'test:merge_bgm', { key: 'm1', group: 'mgrp', loop: true, conflict: 'merge', fadeOut: 0 })
        var m2 = Audio.at(1, 64, 0, 'minecraft:overworld', 'test:merge_bgm', { key: 'm2', group: 'mgrp', loop: true, conflict: 'merge', fadeOut: 0 })
        stepSv(6)
        Audio.stopAll(0)
        stepSv(6)
        var mAfter = Audio.toPlayer(p1, 'test:after_release', { loop: true })
        stepSv(6)
        assert.strictEqual(Audio.isPlaying(mAfter), true, 'player listenCount quota must be fully released after endHandle')
        Audio.stopAll(0)
        Audio.configure({ maxSoundsPerPlayer: 8 })
    })

    // ----------------------------------------------------------------------------
    // 35. Audio Forge 1.20.1 SRG-only production runtime + Epiphy的小玩意_功能测试 e2e
    // ----------------------------------------------------------------------------
    test('Epiphy的小玩意_功能测试 & EpiphyAudioClient: SRG-only Forge runtime, subtitle m_7761_ & attCache recovery', function () {
        var TEST_BLOCK_PATH = path.join(ROOT_DIR, 'kubejs', 'startup_scripts', '小玩意与案例', 'Epiphy的小玩意_功能测试.js')

        // 1. Load startup (Spec + Epiphy的小玩意_功能测试.js) + server (Base + BlockTracker + Audio)
        var registeredSounds = []
        var registeredBlocks = []
        var placedCbs = []
        var brokenCbs = []
        var serverTicks = []
        var playerPos = { x: 10, y: 64, z: 10 }
        var worldBlocks = {}
        var srvPlayer = {
            username: 'Tester',
            uuid: '00000000-0000-4000-8000-0000000000f1',
            getId: function () { return 77 },
            getName: function () { return { getString: function () { return 'Tester' } } },
            getStringUUID: function () { return '00000000-0000-4000-8000-0000000000f1' },
            isOp: function () { return true },
            getX: function () { return playerPos.x },
            getY: function () { return playerPos.y },
            getZ: function () { return playerPos.z },
            getLevel: function () { return srvLevel },
            level: null,
            sendData: function (ch, pkt) { this._sent.push({ ch: ch, pkt: pkt }) },
            _sent: []
        }
        var srvLevel = {
            getDimension: function () { return 'minecraft:overworld' },
            dimension: 'minecraft:overworld',
            hasChunk: function () { return true },
            isLoaded: function () { return true },
            getBlock: function (x, y, z) {
                return worldBlocks[Math.floor(x) + ',' + Math.floor(y) + ',' + Math.floor(z)] || { id: 'minecraft:air' }
            },
            getPlayers: function () { return [srvPlayer] }
        }
        srvPlayer.level = srvLevel
        var srvObj = {
            getWorldData: function () { return { getLevelName: function () { return 'TestBlockSrg' }, getAllowCommands: function () { return true } } },
            getLevel: function () { return srvLevel },
            getAllLevels: function () { return [srvLevel] },
            getPlayerList: function () { return { getPlayers: function () { return [srvPlayer] } } },
            players: [srvPlayer],
            overworld: function () { return srvLevel },
            persistentData: {}
        }

        var svSb = {
            console: { info: function () {}, warn: function () {}, error: function () {}, debug: function () {}, log: function () {} },
            StartupEvents: {
                registry: function (kind, fn) {
                    fn({
                        create: function (id) {
                            if (kind === 'sound_event') registeredSounds.push(id)
                            if (kind === 'block') registeredBlocks.push(id)
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
                loaded: function (fn) { fn({ server: srvObj }) },
                tick: function (fn) { serverTicks.push(fn) },
                commandRegistry: function () {}
            },
            BlockEvents: {
                placed: function (fn) { placedCbs.push(fn) },
                broken: function (fn) { brokenCbs.push(fn) }
            },
            PlayerEvents: { loggedIn: function () {}, loggedOut: function () {} },
            Java: { loadClass: function () { return null } },
            global: {}
        }
        var svCon = attachConsoleCapture(svSb)
        svSb.globalThis = svSb
        vm.createContext(svSb)
        loadStartupBase(svSb)
        runScriptIn(svSb, TEST_BLOCK_PATH)
        runScriptIn(svSb, SERVER_BASE_PATH)
        runScriptIn(svSb, TRACKER_PATH)
        runScriptIn(svSb, AUDIO_PATH)

        assert.ok(registeredSounds.indexOf('epiphy:children_of_the_city') >= 0, '功能测试 must register epiphy:children_of_the_city')
        assert.ok(registeredBlocks.indexOf('epiphy:rnfmabj_test') >= 0, '功能测试 must register epiphy:rnfmabj_test')

        // Step initial server ticks past login grace, then place epiphy:rnfmabj_test block
        for (var st = 0; st < 12; st++) {
            for (var sti = 0; sti < serverTicks.length; sti++) serverTicks[sti]({ server: srvObj })
        }
        srvPlayer._sent.length = 0
        var placedBlock = {
            id: 'epiphy:rnfmabj_test',
            x: 12, y: 64, z: 10,
            getId: function () { return 'epiphy:rnfmabj_test' },
            getX: function () { return 12 }, getY: function () { return 64 }, getZ: function () { return 10 },
            getLevel: function () { return srvLevel },
            level: srvLevel
        }
        worldBlocks['12,64,10'] = placedBlock
        for (var pci = 0; pci < placedCbs.length; pci++) {
            placedCbs[pci]({ block: placedBlock, level: srvLevel, server: srvObj, player: srvPlayer })
        }
        var playPkts = srvPlayer._sent.filter(function (item) { return item.ch === 'epiphy:audio' && item.pkt && item.pkt.act === 'play' })
        assert.strictEqual(playPkts.length, 1, 'placing epiphy:rnfmabj_test must emit epiphy:children_of_the_city play packet')
        assert.strictEqual(playPkts[0].pkt.snd, 'epiphy:children_of_the_city')

        // 2. Load EpiphyAudioClient in STRICT Forge 1.20.1 SRG-only sandbox (zero Mojmap names on vanilla classes!)
        var srgTick = null
        var srgNet  = null
        var srgLoggedIn = null
        var srgPlayed = []
        var srgStopped = []
        var srgSubs = []
        var srgGuiSubs = []
        var srgChanVols = []
        var srgPaused = 0
        var srgUnpaused = 0
        var srgPosMoved = []
        var srgActive = new Set()
        var srgChanMap = new Map()
        var soundEventReady = false // initially null -> simulates cold resource reload!

        function SrgSoundInstance(res, cat, vol, pit, rnd, loop, delay, att, x, y, z, rel) {
            assert.ok(rnd != null, 'RandomSource created via m_216327_ must be non-null')
            this.res = res; this.cat = cat
            this.f_119572_ = vol // volume
            this.f_119573_ = pit // pitch
            this.f_119574_ = x   // x
            this.f_119575_ = y   // y
            this.f_119576_ = z   // z
            this.f_119577_ = Boolean(loop) // boolean looping
            this.rel = rel
        }
        SrgSoundInstance.prototype.m_7492_ = function () { return this.cat }

        var srgSubtitleListener = {
            m_7761_: function (inst, weighed) { srgSubs.push({ snd: String(inst.res), weighed: weighed }) }
        }
        var srgGuiFallbackSub = {
            m_7761_: function (inst, weighed) { srgGuiSubs.push({ snd: String(inst.res), weighed: weighed }) }
        }
        var srgListenerList = [srgSubtitleListener]
        srgListenerList.iterator = function () {
            var idx = 0
            var arr = this
            return {
                hasNext: function () { return idx < arr.length },
                next: function () { return arr[idx++] }
            }
        }
        var srgSoundManager = {
            f_120349_: { f_120226_: srgChanMap, f_120231_: srgListenerList },
            m_120384_: function (resLoc) {
                if (!soundEventReady) return null
                if (String(resLoc) !== 'epiphy:children_of_the_city') return null
                return {
                    m_213718_: function () {
                        return { m_119800_: function () { return 64 } }
                    }
                }
            },
            m_120367_: function (inst) {
                srgPlayed.push(inst)
                srgActive.add(inst)
                var ch = {
                    m_83666_: function (v) { srgChanVols.push(v) },
                    m_83677_: function () { srgPaused++ },
                    m_83678_: function () { srgUnpaused++ },
                    m_83680_: function () { return false },
                    m_83654_: function (vec) { srgPosMoved.push([vec.x, vec.y, vec.z]) }
                }
                srgChanMap.set(inst, { execute: function (fn) { fn(ch) } })
            },
            m_120400_: function (inst) { srgStopped.push(inst); srgActive.delete(inst); srgChanMap.delete(inst) },
            m_120404_: function (inst) { return srgActive.has(inst) }
        }
        var cliPlayer = {
            getId: function () { return 77 },
            getX: function () { return playerPos.x },
            getY: function () { return playerPos.y },
            getZ: function () { return playerPos.z }
        }
        var rawSrgMc = {
            m_91104_: function () { return false }, // isPaused
            m_91294_: function () { return true },  // isWindowActive
            f_91080_: null,                          // screen
            m_91106_: function () { return srgSoundManager }, // getSoundManager
            f_91065_: { f_92996_: srgGuiFallbackSub }, // gui.subtitleOverlay
            f_91066_: { m_92147_: function () { return 1.0 } }, // options.getSoundSourceVolume
            m_91107_: function () { return {} } // getMusicManager
        }
        // KubeJS Client wrapper has Client.minecraft = rawSrgMc, NOT SoundManager!
        var kubeClientWrapper = {
            minecraft: rawSrgMc,
            level: { getDimension: function () { return 'minecraft:overworld' } },
            player: cliPlayer,
            getCurrentScreen: function () { return null },
            getCurrentLevel: function () { return kubeClientWrapper.level }
        }

        var srgCliSb = {
            console: { info: function () {}, warn: function () {}, error: function () {}, debug: function () {}, log: function () {} },
            ClientEvents: {
                tick: function (fn) { srgTick = fn },
                loggedOut: function () {},
                loggedIn: function (fn) { srgLoggedIn = fn }
            },
            NetworkEvents: {
                dataReceived: function (ch, fn) { if (ch === 'epiphy:audio') srgNet = fn }
            },
            Client: kubeClientWrapper,
            Java: {
                loadClass: function (cls) {
                    if (cls === 'net.minecraft.client.Minecraft') return { m_91087_: function () { return rawSrgMc } }
                    if (cls === 'net.minecraft.resources.ResourceLocation') return function (s) { this._id = String(s); this.toString = function () { return this._id } }
                    if (cls === 'net.minecraft.sounds.SoundSource') return { MASTER: 'MASTER', RECORDS: 'RECORDS', MUSIC: 'MUSIC', valueOf: function (n) { return n } }
                    if (cls === 'net.minecraft.util.RandomSource') return { m_216327_: function () { return { _srgRandom: true } } }
                    if (cls === 'net.minecraft.client.resources.sounds.SimpleSoundInstance') return SrgSoundInstance
                    if (cls === 'net.minecraft.client.resources.sounds.SoundInstance$Attenuation') return { NONE: 'NONE', LINEAR: 'LINEAR' }
                    if (cls === 'net.minecraft.world.phys.Vec3') return function (x, y, z) { return { x: x, y: y, z: z } }
                    return null
                }
            },
            global: {}
        }
        var srgCliCon = attachConsoleCapture(srgCliSb)
        srgCliSb.globalThis = srgCliSb
        vm.createContext(srgCliSb)
        loadStartupBase(srgCliSb)
        runScriptIn(srgCliSb, AUDIO_CLIENT_PATH)
        assert.ok(srgCliSb.global.EpiphyAudioClient != null, 'EpiphyAudioClient must load in SRG-only runtime')

        // Dispatch real server play packet while SoundManager is transiently not ready for 2 ticks
        srgNet({ data: playPkts[0].pkt })
        srgTick({}); srgTick({})
        assert.strictEqual(srgPlayed.length, 0)
        assert.strictEqual(srgCliSb.global.EpiphyAudioClient.count(), 1, 'transient null getSoundEvent must wait instead of deleting entry or poisoning attCache')

        // Resource reload finishes -> after missingSoundUntil (40t) retry expires, plays and refreshes bottom-right subtitle (m_7761_) every 24t
        soundEventReady = true
        for (var ct = 0; ct < 80; ct++) srgTick({})
        assert.strictEqual(srgPlayed.length, 1, 'SRG SoundManager.m_120367_ must play after transient soundEventReady delay')
        assert.ok(srgPlayed[0].f_119572_ > 0.7, 'volume (f_119572_) must ramp up cleanly')
        assert.strictEqual(srgPlayed[0].f_119573_, 1.0, 'pitch (f_119573_) must not be overwritten by volume')
        assert.strictEqual(srgPlayed[0].f_119577_, true, 'looping (f_119577_) must stay boolean true')
        assert.ok(srgSubs.length >= 1, 'bottom-right SubtitleOverlay.m_7761_ must receive subtitle ping in SRG mode')

        // Also verify Gui.f_92996_ (subtitleOverlay) fallback when SoundEngine.f_120231_ is empty
        srgSoundManager.f_120349_.f_120231_.length = 0
        for (var gt = 0; gt < 30; gt++) srgTick({})
        assert.ok(srgGuiSubs.length >= 1, 'Gui.f_92996_ subtitleOverlay.m_7761_ fallback must trigger when listeners empty')

        // Move out of range (rng=30, move x=100) -> outMode='mute' (NOT omode) must trigger Channel.pause (m_83677_)!
        playerPos.x = 100
        for (var ot = 0; ot < 40; ot++) srgTick({})
        assert.ok(srgPaused >= 1, 'outMode=mute must pause channel when distance > range')

        // Move back into range -> resumes via Channel.unpause (m_83678_)
        playerPos.x = 12
        for (var rt = 0; rt < 15; rt++) srgTick({})
        assert.ok(srgUnpaused >= 1, 'returning in range must unpause muted channel')
        assert.strictEqual(srgCliCon.errors.length, 0, 'SRG audio pipeline must emit zero errors')
        assert.strictEqual(svCon.errors.length, 0, 'server audio block test must emit zero errors')
    })
}
