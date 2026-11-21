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
    // 15. danmaku: onBindingChanged cache invalidation & first/latest/nearest/stagger arbitration
    // ----------------------------------------------------------------------------
    test('danmaku: onBindingChanged invalidates scope cache & first/latest/nearest/stagger conflict arbitration', function () {
        var isoSandbox = createKubeSandbox()
        var hooks = attachSandboxEventHooks(isoSandbox)
        loadServerBase(isoSandbox)
        runScriptIn(isoSandbox, TRACKER_PATH)
        vm.runInContext(fs.readFileSync(DEBUG_PATH, 'utf8'), isoSandbox, { filename: 'Epiphy的-调试组件.js' })

        var capturedDanmakuSub = null
        var origCreateTracker = isoSandbox.global.EpiphyBlockTracker.createTracker
        isoSandbox.global.EpiphyBlockTracker.createTracker = function (cfg) {
            var sub = origCreateTracker(cfg)
            if (cfg && cfg.name === 'danmaku') capturedDanmakuSub = sub
            return sub
        }
        vm.runInContext(fs.readFileSync(DANMAKU_PATH, 'utf8'), isoSandbox, { filename: 'Epiphy的-平面渲染组件.js' })

        var Tracker = isoSandbox.global.EpiphyBlockTracker
        var Debug   = isoSandbox.global.EpiphyDebug
        var Danmaku = isoSandbox.global.ScreenDanmaku
        var world   = makeMockWorld()
        var alice   = world.addPlayer('Alice', '00000000-0000-0000-0000-000000000010', 8, 20, 0)

        function getDanmakuRev() {
            var mod = Debug.collectSnapshot('danmaku').modules[0]
            return (mod && mod.metrics && typeof mod.metrics.boundScopeRevision === 'number') ? mod.metrics.boundScopeRevision : -1
        }

        for (var ti = 0; ti < hooks.tick.length; ti++) hooks.tick[ti]({ server: world.server })

        function stepTick() {
            for (var ti2 = 0; ti2 < hooks.tick.length; ti2++) hooks.tick[ti2]({ server: world.server })
        }
        function placeBlock(x, y, z, id) {
            world.setBlock(x, y, z, id)
            var b = world.makeBlock(x, y, z, id)
            for (var pi = 0; pi < hooks.placed.length; pi++) {
                hooks.placed[pi]({ block: b, level: world.level, player: alice })
            }
        }

        // Bind 'first' mode (lazily creates danmaku tracker subscriber) and place A(0,20,0) then B(10,20,0)
        Danmaku.bindBlock('epiphy:node_x', function (ctx) {
            return { text: 'from_' + ctx.x, group: 'g_arb', radius: 15 }
        }, { radius: 15, intervalTicks: 4, conflictMode: 'first', conflictScope: 'block' })
        assert.ok(capturedDanmakuSub != null, 'must capture danmaku subscriber for direct tracker rebind check')

        placeBlock(0, 20, 0, 'epiphy:node_x')
        placeBlock(10, 20, 0, 'epiphy:node_x')
        alice.sentPackets.length = 0
        while ((Tracker.getStats().lastTickAllTick % 4) !== 3) stepTick()
        stepTick()
        assert.strictEqual(alice.sentPackets.length, 1)
        assert.strictEqual(alice.sentPackets[0].pkt.title, 'from_0')

        // Rebind to 'latest' -> picks B(10)
        Danmaku.bindBlock('epiphy:node_x', function (ctx) {
            return { text: 'from_' + ctx.x, group: 'g_arb' }
        }, { radius: 15, intervalTicks: 4, conflictMode: 'latest', conflictScope: 'block' })
        alice.sentPackets.length = 0
        for (var k = 0; k < 4; k++) stepTick()
        assert.strictEqual(alice.sentPackets.length, 1)
        assert.strictEqual(alice.sentPackets[0].pkt.title, 'from_10')

        // Test 'nearest': Alice at x=8 chooses B(10); moving Alice to x=1 chooses A(0)
        Danmaku.bindBlock('epiphy:node_x', function (ctx) {
            return { text: 'from_' + ctx.x, group: 'g_arb' }
        }, { radius: 15, intervalTicks: 4, conflictMode: 'nearest', conflictScope: 'block' })
        alice.sentPackets.length = 0
        for (var k2 = 0; k2 < 4; k2++) stepTick()
        assert.strictEqual(alice.sentPackets[0].pkt.title, 'from_10')

        alice.moveTo(1, 20, 0)
        alice.sentPackets.length = 0
        for (var k3 = 0; k3 < 4; k3++) stepTick()
        assert.strictEqual(alice.sentPackets[0].pkt.title, 'from_0')

        // Test 'stagger': bind radius=20 so scopeListCache caches rSq=400, and verify staggered firing across 4 ticks
        Danmaku.bindBlock('epiphy:node_x', function (ctx) {
            return { text: 'from_' + ctx.x, group: 'g_arb' }
        }, { radius: 20, intervalTicks: 4, conflictMode: 'stagger', conflictScope: 'block' })
        alice.sentPackets.length = 0
        var seenByTick = []
        for (var st = 0; st < 4; st++) {
            var beforeLen = alice.sentPackets.length
            stepTick()
            if (alice.sentPackets.length > beforeLen) {
                seenByTick.push(alice.sentPackets[alice.sentPackets.length - 1].pkt.title)
            }
        }
        assert.strictEqual(seenByTick.length, 2)
        assert.notStrictEqual(seenByTick[0], seenByTick[1])

        // Verify tracker onBindingChanged hook immediately bumps boundScopeRevision even when sub.bind bypasses ScreenDanmaku
        var revBefore = getDanmakuRev()
        assert.ok(revBefore >= 0)
        capturedDanmakuSub.bind('epiphy:node_x', { scanRadius: 20 })
        assert.strictEqual(getDanmakuRev(), revBefore + 1)

        // Move Alice to x=4 (d=3.5 to A@0.5, d=6.5 to B@10.5) and shrink radius from 20 -> 2 within TTL:
        // scopeListCache MUST rebuild immediately with rSq=4, yielding 0 packets!
        alice.moveTo(4, 20, 0)
        Danmaku.bindBlock('epiphy:node_x', function (ctx) {
            return { text: 'from_' + ctx.x, group: 'g_arb' }
        }, { radius: 2, intervalTicks: 4, conflictMode: 'nearest', conflictScope: 'block' })
        alice.sentPackets.length = 0
        for (var k4 = 0; k4 < 4; k4++) stepTick()
        assert.strictEqual(alice.sentPackets.length, 0)
    })

    // ----------------------------------------------------------------------------
    // 16. danmaku: merge cluster honors min-seq leader, silences followers, expands union & recalculates on break
    // ----------------------------------------------------------------------------
    test('danmaku: merge cluster honors earliest leader, suppresses followers, expands union & recalculates on break', function () {
        var isoSandbox = createKubeSandbox(function (cls) {
            if (cls === 'java.lang.System') return { nanoTime: function () { return Date.now() * 1000000 } }
            return null
        })
        var hooks = attachSandboxEventHooks(isoSandbox)
        loadServerBase(isoSandbox)
        runScriptIn(isoSandbox, TRACKER_PATH)
        vm.runInContext(fs.readFileSync(DEBUG_PATH, 'utf8'), isoSandbox, { filename: 'Epiphy的-调试组件.js' })
        vm.runInContext(fs.readFileSync(DANMAKU_PATH, 'utf8'), isoSandbox, { filename: 'Epiphy的-平面渲染组件.js' })

        var Danmaku = isoSandbox.global.ScreenDanmaku
        var Debug   = isoSandbox.global.EpiphyDebug
        var world   = makeMockWorld()
        var pNearB1 = world.addPlayer('P1', '00000000-0000-0000-0000-000000000021', 0, 20, 0)
        var pNearB2 = world.addPlayer('P2', '00000000-0000-0000-0000-000000000022', 35, 20, 0)

        function stepTick() {
            for (var ti = 0; ti < hooks.tick.length; ti++) hooks.tick[ti]({ server: world.server })
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

        stepTick()
        var specCalls = []
        Danmaku.bindBlock('epiphy:merge_blk', function (ctx) {
            specCalls.push(ctx.x + ',' + ctx.y + ',' + ctx.z)
            return { text: 'leader_' + ctx.x, group: 'grp_merge' }
        }, { radius: 20, intervalTicks: 5, conflictCooldownTicks: 1, group: 'grp_merge', conflictMode: 'merge', conflictScope: 'block' })

        // 1) Place first block B1 at (0,20,0) -> leader emits once; P1 receives, P2 at x=35 does not
        placeBlock(0, 20, 0, 'epiphy:merge_blk', pNearB1)
        assert.strictEqual(specCalls.length, 1)
        assert.strictEqual(specCalls[0], '0,20,0')
        assert.strictEqual(pNearB1.sentPackets.filter(function (e) { return e.pkt.action === 'push' }).length, 1)
        assert.strictEqual(pNearB2.sentPackets.filter(function (e) { return e.pkt.action === 'push' }).length, 0)

        // 2) Place follower B2 at (30,20,0) (touches B1: d=30 <= 40) -> follower MUST NOT run specOrFn!
        placeBlock(30, 20, 0, 'epiphy:merge_blk', pNearB2)
        assert.strictEqual(specCalls.length, 1)

        // Advance 5 ticks -> ONLY B1 runs (specCalls grows by 1, NOT 2!), AND both P1 & P2 receive B1's packet!
        pNearB1.sentPackets.length = 0
        pNearB2.sentPackets.length = 0
        for (var t = 0; t < 5; t++) stepTick()
        assert.strictEqual(specCalls.length, 2)
        assert.strictEqual(specCalls[1], '0,20,0')
        assert.strictEqual(pNearB1.sentPackets.filter(function (e) { return e.pkt.title === 'leader_0' }).length, 1)
        assert.strictEqual(pNearB2.sentPackets.filter(function (e) { return e.pkt.title === 'leader_0' }).length, 1)

        // Verify per-cycle timing recorded without counting suppressed followers
        var dmMetrics = Danmaku.getStats()
        assert.ok(dmMetrics.emitCycleCount > 0 && dmMetrics.lastActiveEmitCycleMs >= 0)
        assert.strictEqual(Debug.collectSnapshot('danmaku').modules[0].metrics.emitCycleCount, dmMetrics.emitCycleCount)

        // 3) Break leader B1 at (0,20,0) -> P1 gets clear packet, P2 (inside surviving B2) is NOT cleared!
        pNearB1.sentPackets.length = 0
        pNearB2.sentPackets.length = 0
        breakBlock(0, 20, 0, 'epiphy:merge_blk', pNearB1)
        assert.strictEqual(pNearB1.sentPackets.some(function (e) { return e.pkt.action === 'clear' }), true)
        assert.strictEqual(pNearB2.sentPackets.some(function (e) { return e.pkt.action === 'clear' }), false)

        // Next 5 ticks -> B2 automatically promoted to leader and emits at x=30 for P2 only!
        pNearB1.sentPackets.length = 0
        pNearB2.sentPackets.length = 0
        for (var t2 = 0; t2 < 5; t2++) stepTick()
        assert.strictEqual(specCalls.length, 3)
        assert.strictEqual(specCalls[2], '30,20,0')
        assert.strictEqual(pNearB1.sentPackets.length, 0)
        assert.strictEqual(pNearB2.sentPackets.filter(function (e) { return e.pkt.title === 'leader_30' }).length, 1)
    })

    // ----------------------------------------------------------------------------
    // 18. client renderer: batched glow (4-diag) & stroke (8+4) outline passes and negative Z ordering
    // ----------------------------------------------------------------------------
    test('renderer: batched glow (4-diag) and stroke (8+4) emit circular passes with negative Z', function () {
        function MockMatrix4f() {
            this.z = 0
        }
        MockMatrix4f.prototype.set = function (other) {
            this.z = other && typeof other.z === 'number' ? other.z : 0
            return this
        }
        MockMatrix4f.prototype.translate = function (dx, dy, dz) {
            this.z += (dz || 0)
            return this
        }

        var paintHandlers = []
        var draws = []
        var mockFont = {
            width: function (s) { return String(s || '').length * 6 },
            drawInBatch: function (seq, x, y, argb, shadow, mat) {
                draws.push({
                    seq: String(seq),
                    x: Number(x),
                    y: Number(y),
                    argb: argb >>> 0,
                    alpha: (argb >>> 24) & 0xFF,
                    rgb: argb & 0x00FFFFFF,
                    shadow: Boolean(shadow),
                    z: mat && typeof mat.z === 'number' ? mat.z : 0
                })
                return 0
            }
        }
        var baseMat = new MockMatrix4f()
        var cliSandbox = {
            console: { info: function () {}, warn: function () {}, error: function (m, e) { console.log('CLI_ERR:', m, e && e.stack ? e.stack : e) }, debug: function () {}, log: function () {} },
            ClientEvents: {
                loggedOut: function () {},
                loggedIn: function () {},
                paintScreen: function (fn) { paintHandlers.push(fn) }
            },
            NetworkEvents: { dataReceived: function () {} },
            Java: {
                loadClass: function (cls) {
                    if (cls === 'net.minecraft.client.gui.Font$DisplayMode') return { NORMAL: 'NORMAL' }
                    if (cls === 'org.joml.Matrix4f') return MockMatrix4f
                    return null
                }
            },
            Text: {
                of: function (s) {
                    return {
                        string: String(s),
                        getVisualOrderText: function () { return String(s) }
                    }
                }
            },
            global: {}
        }
        cliSandbox.globalThis = cliSandbox
        vm.createContext(cliSandbox)
        loadStartupBase(cliSandbox)
        vm.runInContext(fs.readFileSync(RENDERER_PATH, 'utf8'), cliSandbox, { filename: 'Epiphy的-平面渲染器.js' })

        var Client = cliSandbox.global.ScreenDanmakuClient
        assert.ok(Client && typeof Client.push === 'function')
        assert.strictEqual(paintHandlers.length, 1)

        var mockEvent = {
            width: 854,
            height: 480,
            level: 'minecraft:overworld',
            font: mockFont,
            graphics: { bufferSource: function () { return {} }, flush: function () {} },
            getMatrix: function () { return baseMat },
            push: function () {},
            pop: function () {},
            translate: function () {},
            scale: function () {},
            rotateDeg: function () {},
            blend: function () {}
        }

        // Push a tilted single-char glow danmaku matching screenshot configuration
        Client.push({
            title: 'A',
            typewriter: false,
            color: 0x8CE6FF,
            outlineMode: 'glow',
            outlineColor: 0xD82038,
            outlineWidth: 1.05,
            shadow: false,
            angle: 18,
            stay: 100
        })
        paintHandlers[0](mockEvent)

        // Expect 4 symmetric diagonal outline draws + 1 foreground core = 5 draws
        assert.strictEqual(draws.length, 5)
        var glowOutlines = draws.slice(0, 4)
        var glowCore     = draws[4]
        assert.strictEqual(glowCore.rgb, 0x8CE6FF)
        assert.strictEqual(glowCore.alpha, 255)
        assert.strictEqual(glowCore.z, 0)
        for (var gi = 0; gi < glowOutlines.length; gi++) {
            assert.strictEqual(glowOutlines[gi].rgb, 0xD82038)
            assert.ok(glowOutlines[gi].alpha >= 28, 'outline alpha must stay safely above MC 0.1 alpha cutoff')
            assert.ok(glowOutlines[gi].z < 0, 'outline z must be strictly negative behind core')
        }

        // Clear and test 'stroke' mode (outlineWidth=1.05 > 0.82 -> 8 outer + 4 mid bridge + 1 core = 13 draws)
        draws.length = 0
        Client.clear('*')
        Client.push({
            title: 'A',
            typewriter: false,
            color: 0x55FF55,
            outlineMode: 'stroke',
            outlineColor: 0x050A10,
            outlineWidth: 1.05,
            stay: 100
        })
        paintHandlers[0](mockEvent)
        assert.strictEqual(draws.length, 13)
        assert.strictEqual(draws[12].rgb, 0x55FF55)
        assert.strictEqual(draws[12].z, 0)
        for (var si = 0; si < 12; si++) {
            assert.strictEqual(draws[si].rgb, 0x050A10)
            assert.ok(draws[si].alpha >= 230)
            assert.ok(draws[si].z < 0)
        }
    })

    // 19. renderer: ChatScreen 触发 GUI 防覆盖并兼容 Forge SRG m_272191_ 合批绘制
    test('renderer: ChatScreen triggers GUI blocking for showInGui=false danmaku and supports SRG m_272191_ batch draw', function () {
        function MockMatrix4f() { this.z = 0 }
        MockMatrix4f.prototype.set = function (o) { this.z = o ? (o.z || 0) : 0; return this }
        MockMatrix4f.prototype.translate = function (dx, dy, dz) { this.z += (dz || 0); return this }
        function makeScreen(className) {
            return { getClass: function () { return { getName: function () { return className } } } }
        }

        var paintHandlers = []
        var drawnTexts = []
        var srgDraws = 0
        var currentScreen = makeScreen('net.minecraft.client.gui.screens.ChatScreen')
        var mockFont = {
            width: function (s) { return String(s || '').length * 6 },
            // 故意让 drawInBatch 抛二义性异常以验证 m_272191_ 直连路径在 ModernUI + SRG 下生效
            drawInBatch: function () { throw new Error('ambiguous overload in mock') },
            m_272191_: function (seq) {
                srgDraws++
                drawnTexts.push(String(seq))
                return 0
            }
        }
        var mockMc = { f_91080_: null }
        var errors = []
        var cliSandbox = {
            console: { info: function () {}, warn: function () {}, error: function (m) { errors.push(String(m)) }, debug: function () {}, log: function () {} },
            ClientEvents: { loggedOut: function () {}, loggedIn: function () {}, paintScreen: function (fn) { paintHandlers.push(fn) } },
            NetworkEvents: { dataReceived: function () {} },
            Client: {
                getCurrentScreen: function () { return currentScreen }
            },
            Java: {
                loadClass: function (cls) {
                    if (cls === 'net.minecraft.client.gui.Font$DisplayMode') return { NORMAL: 'NORMAL' }
                    if (cls === 'org.joml.Matrix4f') return MockMatrix4f
                    if (cls === 'net.minecraft.client.Minecraft') return { getInstance: function () { return mockMc } }
                    return null
                }
            },
            Text: {
                of: function (s) {
                    return { string: String(s), getVisualOrderText: function () { return String(s) } }
                }
            },
            global: {}
        }
        cliSandbox.globalThis = cliSandbox
        vm.createContext(cliSandbox)
        loadStartupBase(cliSandbox)
        vm.runInContext(fs.readFileSync(RENDERER_PATH, 'utf8'), cliSandbox, { filename: 'Epiphy的-平面渲染器.js' })

        var Client = cliSandbox.global.ScreenDanmakuClient
        Client.push({ title: 'H', showInGui: false, typewriter: false, stay: 100 })
        Client.push({ title: 'S', showInGui: true,  typewriter: false, stay: 100 })

        var ev = {
            width: 854,
            height: 480,
            level: 'minecraft:overworld',
            font: mockFont,
            graphics: { bufferSource: function () { return {} }, flush: function () {} },
            getMatrix: function () { return new MockMatrix4f() },
            push: function () {},
            pop: function () {},
            translate: function () {},
            scale: function () {},
            rotateDeg: function () {},
            blend: function () {}
        }

        // ChatScreen 打开时：仅绘制 showInGui=true 的 'S'，且走 Forge SRG m_272191_ 无错误
        paintHandlers[0](ev)
        assert.deepStrictEqual(drawnTexts, ['S'])
        assert.strictEqual(srgDraws, 1)
        assert.strictEqual(errors.length, 0)

        // 当 Client.getCurrentScreen() 返回 null 但 Minecraft.f_91080_ 为 ChatScreen 时仍应拦截
        drawnTexts.length = 0
        currentScreen = null
        mockMc.f_91080_ = makeScreen('net.minecraft.client.gui.screens.ChatScreen')
        paintHandlers[0](ev)
        assert.deepStrictEqual(drawnTexts, ['S'])

        // 仅 ReceivingLevelScreen 不阻挡
        drawnTexts.length = 0
        mockMc.f_91080_ = makeScreen('net.minecraft.client.gui.screens.ReceivingLevelScreen')
        paintHandlers[0](ev)
        assert.deepStrictEqual(drawnTexts, ['H', 'S'])
    })

    // 21. renderer: ModernUI TextLayout 直连路径、直接 Matrix4f 变换、空格裁剪与零 glIsEnabled/PoseStack 开销
    test('renderer: ModernUI TextLayout fast path caches layouts, skips PoseStack/glIsEnabled, and culls blanks', function () {
        function FullMockMatrix4f() {
            this.z = 0
            this.ops = []
        }
        FullMockMatrix4f.prototype.set = function (o) {
            this.z = o ? (o.z || 0) : 0
            return this
        }
        FullMockMatrix4f.prototype.translate = function (dx, dy, dz) {
            this.z += (dz || 0)
            return this
        }
        FullMockMatrix4f.prototype.rotateZ = function (rad) {
            this.ops.push(['rotateZ', rad])
            return this
        }
        FullMockMatrix4f.prototype.scale = function (sx, sy, sz) {
            this.ops.push(['scale', sx, sy, sz])
            return this
        }

        var paintHandlers = []
        var lookupCount   = 0
        var emojiQueries  = 0
        var drawCalls     = []
        var glBlendQueries = 0
        var pushCalls     = 0
        var popCalls      = 0
        var rotateDegCalls = 0
        var flushCalls    = 0
        var currentEpochObj = { ver: 1 }

        var fakeLayoutsByStr = {}
        function makeFakeLayout(key) {
            return {
                key: key,
                hasColorEmoji: function () { emojiQueries++; return false },
                equals: function (other) { return Boolean(other && other.key === key) },
                drawText: function (mat, bufSrc, x, y, r, g, b, a, shadow, mode) {
                    drawCalls.push({
                        key: key,
                        x: x, y: y, r: r, g: g, b: b, a: a,
                        shadow: shadow, mode: mode, z: mat ? mat.z : 0
                    })
                    return 0
                }
            }
        }

        var fakeMuiEngine = {
            lookupFormattedLayout: function (seq, flags) {
                assert.strictEqual(flags, 0, 'must pass int 0 to resolve unambiguous 2-arg overload')
                lookupCount++
                var s = String(seq)
                var cacheKey = currentEpochObj.ver + ':' + s
                if (!fakeLayoutsByStr[cacheKey]) {
                    fakeLayoutsByStr[cacheKey] = makeFakeLayout(cacheKey)
                }
                var base = fakeLayoutsByStr[cacheKey]
                // 模拟 KubeJS Rhino 每次返回新的 NativeJavaObject 包装实例，但 Java equals 相同
                return Object.assign({}, base)
            },
            getTextRenderer: function () {
                return {
                    chooseMode: function () { return 4 }
                }
            }
        }

        var cliSandbox = {
            console: { info: function () {}, warn: function () {}, error: function (m) { throw new Error('unexpected error: ' + m) }, debug: function () {}, log: function () {} },
            ClientEvents: { loggedOut: function () {}, loggedIn: function () {}, paintScreen: function (fn) { paintHandlers.push(fn) } },
            NetworkEvents: { dataReceived: function () {} },
            Java: {
                loadClass: function (cls) {
                    if (cls === 'org.lwjgl.opengl.GL11') return { GL_BLEND: 3042, glIsEnabled: function () { glBlendQueries++; return true } }
                    if (cls === 'net.minecraft.client.gui.Font$DisplayMode') return { NORMAL: 'NORMAL' }
                    if (cls === 'org.joml.Matrix4f') return FullMockMatrix4f
                    if (cls === 'icyllis.modernui.mc.text.TextLayoutEngine') return { getInstance: function () { return fakeMuiEngine } }
                    if (cls === 'icyllis.modernui.mc.text.ModernTextRenderer') return { sAllowSDFTextIn2D: true }
                    return null
                }
            },
            Text: {
                of: function (s) {
                    return { string: String(s), getVisualOrderText: function () { return String(s) } }
                }
            },
            global: {}
        }
        cliSandbox.globalThis = cliSandbox
        vm.createContext(cliSandbox)
        loadStartupBase(cliSandbox)
        vm.runInContext(fs.readFileSync(RENDERER_PATH, 'utf8'), cliSandbox, { filename: 'Epiphy的-平面渲染器.js' })

        var Client = cliSandbox.global.ScreenDanmakuClient
        var baseMat = new FullMockMatrix4f()
        var ev = {
            width: 854,
            height: 480,
            level: 'minecraft:overworld',
            font: {
                width: function (s) { return String(s || '').length * 6 },
                drawInBatch: function () { throw new Error('must NOT call ambiguous Font.drawInBatch when ModernUI TextLayout active') }
            },
            graphics: {
                bufferSource: function () { return {} },
                flush: function () { flushCalls++ }
            },
            getMatrix: function () { return baseMat },
            push: function () { pushCalls++ },
            pop: function () { popCalls++ },
            translate: function () {},
            scale: function () {},
            rotateDeg: function () { rotateDegCalls++ },
            blend: function () {}
        }

        // 1. 推送含空格、glow、逐字旋转抖动的弹幕（模拟功能测试配置）
        Client.push({
            title: 'A  B',
            typewriter: false,
            color: 0x8CE6FF,
            outlineMode: 'glow',
            outlineColor: 0xD82038,
            outlineWidth: 1.05,
            perCharShake: true,
            charShakeStyle: 'horizontal_step',
            charShakeRotDeg: 2.5,
            shadow: false,
            stay: 100
        })

        // 绘制第 1 帧：probe(1 canary) + frame0 canary(1) + 'A'(1) + 'B'(1) = 4 次 lookup（空格 0 次）；每可见字 4-diag glow + 1 core = 5 次 drawText -> 共 10 次
        paintHandlers[0](ev)
        assert.strictEqual(drawCalls.length, 10, 'A and B only (spaces culled) * 5 passes (4 diag glow + 1 core) = 10 TextLayout.drawText calls')
        assert.strictEqual(pushCalls, 0, 'zero PoseStack.push JNI calls when Matrix4f supports rotateZ/scale')
        assert.strictEqual(popCalls, 0, 'zero PoseStack.pop JNI calls')
        assert.strictEqual(rotateDegCalls, 0, 'zero PoseStack.rotateDeg JNI calls')
        assert.strictEqual(glBlendQueries, 0, 'zero GL11.glIsEnabled GPU sync stalls when batched succeeds')
        assert.strictEqual(flushCalls, 1)
        assert.ok(drawCalls.every(function (d) { return d.mode === 1 }), 'all glow & core passes must share MODE_SDF_FILL(1) to prevent BufferSource batch breaks')

        // 2. 连续绘制第 2~5 帧：canary 虽然每次返回新包装但 .equals 为 true，故 _muiEpoch 不应误递增，cf._muiLayout 与 _muiHasEmoji 均应命中缓存
        var lookupsAfterFrame1 = lookupCount
        var emojiQueriesAfterFrame1 = emojiQueries
        drawCalls.length = 0
        for (var fi = 0; fi < 4; fi++) {
            paintHandlers[0](ev)
        }
        assert.strictEqual(drawCalls.length, 10 * 4)
        assert.strictEqual(lookupCount - lookupsAfterFrame1, 4, 'only 1 canary check per frame, 0 redundant glyph layout lookups')
        assert.strictEqual(emojiQueries - emojiQueriesAfterFrame1, 0, '_muiHasEmoji must be cached on unit alongside _muiLayout')

        // 3. 模拟 F3+T 资源重载（TextLayoutEngine 返回新 canary 实例）：应立即递增 MUI_EPOCH 并刷新单位缓存
        currentEpochObj.ver = 2
        drawCalls.length = 0
        paintHandlers[0](ev)
        assert.strictEqual(drawCalls.length, 10)
        assert.ok(drawCalls.every(function (d) { return d.key.indexOf('2:') === 0 }), 'must immediately switch to post-reload TextLayout epoch 2')

        // 4. stroke 模式（shadow:false）在 ModernUI SDF 下（outlineWidth=1.05 <= 1.15）仅需 8 外圈 + 1 主体 = 9 次 drawText
        Client.clear('*')
        drawCalls.length = 0
        Client.push({
            title: 'X',
            typewriter: false,
            color: 0x55FF55,
            outlineMode: 'stroke',
            outlineColor: 0x050A10,
            outlineWidth: 1.05,
            shadow: false,
            stay: 100
        })
        paintHandlers[0](ev)
        assert.strictEqual(drawCalls.length, 9)

        // 5. ModernUI shadow 2-pass 回归测试：启用 shadow 时必须先绘阴影通道 (r>>2,g>>2,b>>2,isShadow=true,z=0)，
        //    再于 +0.03f Z 绘制全亮度前景通道 (r,g,b,isShadow=false,z=+0.03)，防止仅传 isShadow=true 导致 25% 亮度变黑
        Client.clear('*')
        drawCalls.length = 0
        Client.push({
            title: '§c警告',
            typewriter: false,
            color: 0xFF8040,
            outlineMode: 'none',
            shadow: true,
            stay: 100
        })
        paintHandlers[0](ev)
        assert.strictEqual(drawCalls.length, 2, 'shadow:true ModernUI line must emit 2 drawText calls (shadow + foreground)')
        assert.strictEqual(drawCalls[0].shadow, true)
        assert.strictEqual(drawCalls[0].r, 63)
        assert.strictEqual(drawCalls[0].g, 32)
        assert.strictEqual(drawCalls[0].b, 16)
        assert.strictEqual(drawCalls[0].z, 0)
        assert.strictEqual(drawCalls[1].shadow, false)
        assert.strictEqual(drawCalls[1].r, 255)
        assert.strictEqual(drawCalls[1].g, 128)
        assert.strictEqual(drawCalls[1].b, 64)
        assert.ok(Math.abs(drawCalls[1].z - 0.03) < 0.001, 'foreground pass must sit +0.03 Z in front of shadow pass')
    })

    // ----------------------------------------------------------------------------
    // 29. Pillar 3B: Danmaku player command clamping, namespace stop/clear lock & client eviction
    // ----------------------------------------------------------------------------
    test('danmaku: non-OP player command clamping, namespace stop/clear isolation & client eviction', function () {
        function MockMinecraftServer() {}
        function MockServerPlayer(name, uuid, op) {
            this.username = name
            this._uuid = uuid
            this._op = Boolean(op)
            this._sent = []
        }
        MockServerPlayer.prototype.getProfile = function () { return { name: this.username, id: this._uuid } }
        MockServerPlayer.prototype.getStringUUID = function () { return this._uuid }
        MockServerPlayer.prototype.hasPermissions = function (lv) { return this._op && lv <= 4 }
        MockServerPlayer.prototype.sendData = function (ch, pkt) { this._sent.push({ ch: ch, pkt: pkt }) }

        var cmdCallbacks = []
        var sb = createKubeSandbox(function (cls) {
            if (cls === 'net.minecraft.server.MinecraftServer') return MockMinecraftServer
            if (cls === 'net.minecraft.server.level.ServerPlayer') return MockServerPlayer
            return null
        })
        sb.ServerEvents.commandRegistry = function (fn) { cmdCallbacks.push(fn) }
        var dmConsole = attachConsoleCapture(sb)

        var authPl   = new MockServerPlayer('AuthP', '00000000-0000-4000-8000-0000000000cc', false)
        var targetPl = new MockServerPlayer('TargetP', '00000000-0000-4000-8000-0000000000dd', false)
        var plainPl  = new MockServerPlayer('PlainDm', '00000000-0000-4000-8000-0000000000ee', false)
        var srv = new MockMinecraftServer()
        srv.getWorldData = function () { return { getLevelName: function () { return 'DmIso' }, getAllowCommands: function () { return true } } }
        srv.getPlayerList = function () { return { getPlayers: function () { return [authPl, targetPl] } } }
        sb.server = srv

        loadServerBase(sb)
        runScriptIn(sb, VALVE_PATH)
        runScriptIn(sb, DANMAKU_PATH)

        var Valve = sb.global.EpiphyPermissionValve
        var Dm    = sb.global.ScreenDanmaku
        Valve.grantPlayer(srv, authPl, 'danmaku', 'TestAdmin')

        function FakeNode(kind, name) {
            this._kind = kind; this._name = name; this._children = {}; this._exec = null; this._req = null
        }
        FakeNode.prototype.then = function (child) { if (child) this._children[child._name] = child; return this }
        FakeNode.prototype.executes = function (fn) { this._exec = fn; return this }
        FakeNode.prototype.requires = function (fn) { this._req = fn; return this }
        FakeNode.prototype.suggests = function () { return this }
        var regRoot = null
        var argValues = {}
        function makeDmArg(defFn) {
            return {
                create: function () { return {} },
                getResult: defFn || function (c, k) { return argValues[k] }
            }
        }
        var regEv = {
            commands: { literal: function (n) { return new FakeNode('lit', n) }, argument: function (n) { return new FakeNode('arg', n) } },
            arguments: {
                GREEDY_STRING:     makeDmArg(),
                STRING:            makeDmArg(),
                WORD:              makeDmArg(),
                PLAYERS:           makeDmArg(),
                DOUBLE:            makeDmArg(),
                INTEGER:           makeDmArg(),
                DIMENSION:         makeDmArg(function () { return 'minecraft:overworld' }),
                VEC3:              makeDmArg(),
                RESOURCE_LOCATION: makeDmArg()
            },
            register: function (r) { regRoot = r }
        }
        for (var ci = 0; ci < cmdCallbacks.length; ci++) cmdCallbacks[ci](regEv)

        var authCtx = { source: { source: authPl, player: authPl, getPlayer: function () { return authPl }, getServer: function () { return srv }, sendSuccess: function () {}, sendFailure: function () {} } }
        var plainSrc = { source: plainPl, player: plainPl, getPlayer: function () { return plainPl }, getServer: function () { return srv }, hasPermission: function () { return true } }
        var dmNode  = regRoot._children.danmaku
        assert.strictEqual(dmNode._req(plainSrc), false, 'unauthorized player must NOT see /epiphy danmaku even with stack elevation')
        assert.strictEqual(dmNode._req(authCtx.source), true, 'authorized player must see /epiphy danmaku')
        assert.strictEqual(regRoot._children.auth._req(authCtx.source), false, 'authorized non-OP must NOT see /epiphy auth')

        // 1. Authorized non-OP tries giant overlay spam + group hijacking
        var longBody = new Array(160).join('X')
        argValues = {
            targets: [targetPl],
            spec: `text="<scale=99><big>${longBody}\\nL2\\nL3\\nL4" priority=10 size=giant scale=50 maxWidth=9999 wrap=false stay=99999 ns=sys_override group=boss maxgroup=1`
        }
        dmNode._children.player._children.targets._children.spec._exec(authCtx)
        assert.strictEqual(targetPl._sent.length, 1)
        var sentPkt = targetPl._sent[0].pkt
        assert.strictEqual(sentPkt.tier, 'player')
        assert.strictEqual(sentPkt.namespace, 'u:00000000-0000-4000-8000-0000000000cc')
        assert.strictEqual(sentPkt.group, 'u:00000000-0000-4000-8000-0000000000cc:boss', 'player group must be scoped inside u:<uuid>:')
        assert.strictEqual(sentPkt.priority, 3)
        assert.ok(sentPkt.scale <= 2.0 && sentPkt.scale >= 0.5)
        assert.strictEqual(sentPkt.wrap, true)
        assert.ok(sentPkt.stay <= 200)
        assert.ok(sentPkt.title.length <= 120)
        assert.strictEqual(sentPkt.title.split('\n').length <= 3, true)
        assert.ok(sentPkt.title.indexOf('<scale=1.5>') >= 0 && sentPkt.title.indexOf('<scale=1.25>') >= 0)

        // 2. Player clear/stop commands force player tier + namespace + maxPriority <= 3
        targetPl._sent.length = 0
        argValues = { targets: [targetPl] }
        dmNode._children.clear._children.targets._exec(authCtx)
        assert.strictEqual(targetPl._sent[0].pkt.action, 'clear')
        assert.strictEqual(targetPl._sent[0].pkt.tier, 'player')
        assert.strictEqual(targetPl._sent[0].pkt.namespace, 'u:00000000-0000-4000-8000-0000000000cc')
        assert.strictEqual(targetPl._sent[0].pkt.maxPriority, 3)

        // 3. Direct JS API call stays completely unrestricted
        targetPl._sent.length = 0
        Dm.toPlayer(targetPl, { text: 'SystemBoss', priority: 10, scale: 4.5, stay: 600, wrap: false })
        var sysPkt = targetPl._sent[0].pkt
        assert.strictEqual(sysPkt.tier, 'system')
        assert.strictEqual(sysPkt.priority, 10)
        assert.strictEqual(sysPkt.scale, 4)

        // 4. Client renderer: player clear cannot clear system overlay, and overflow evicts player overlays first
        var rPaints = []
        var cliSb = {
            console: { info: function () {}, warn: function () {}, error: function () {}, debug: function () {}, log: function () {} },
            ClientEvents: { loggedOut: function () {}, loggedIn: function () {}, paintScreen: function (fn) { rPaints.push(fn) } },
            NetworkEvents: { dataReceived: function () {} },
            Java: { loadClass: function () { return null } },
            Text: { of: function (s) { return { string: String(s), getVisualOrderText: function () { return String(s) } } } },
            global: {}
        }
        cliSb.globalThis = cliSb
        vm.createContext(cliSb)
        loadStartupBase(cliSb)
        runScriptIn(cliSb, RENDERER_PATH)
        var rCli = cliSb.global.ScreenDanmakuClient
        var rMockEv = {
            width: 854, height: 480, level: 'minecraft:overworld',
            font: { width: function () { return 6 } },
            text: function () {},
            graphics: { bufferSource: function () { return { endBatch: function () {} } }, flush: function () {} },
            getMatrix: function () { return {} },
            push: function () {}, pop: function () {}, translate: function () {}, scale: function () {}, rotate: function () {}
        }
        rCli.push(sysPkt)
        rCli.push(sentPkt)
        rCli.push({ action: 'clear', tier: 'player', namespace: sentPkt.namespace, maxPriority: 3, group: '*' })
        rPaints[0](rMockEv)
        assert.strictEqual(rCli.count(), 1, 'player clear must leave system overlay alive')

        // Fill 25 player overlays under same u:<uuid> namespace -> capped at 16 (+ 1 system = 17)
        for (var k = 0; k < 25; k++) {
            rCli.push({ action: 'push', tier: 'player', namespace: sentPkt.namespace, priority: 2, title: 'Spam_' + k, stay: 200 })
        }
        rPaints[0](rMockEv)
        assert.ok(rCli.count() <= 17, 'per-player namespace must cap overlays while keeping system overlay')
        assert.strictEqual(dmConsole.errors.length, 0, 'danmaku isolation server run must emit zero console errors')
        assert.strictEqual(dmConsole.warns.length, 0, 'danmaku isolation server run must emit zero console warns')
    })

    // ----------------------------------------------------------------------------
    // 30. P0 regressions: CompoundTag numeric priority, per-char space typewriter & maxGroup isolation
    // ----------------------------------------------------------------------------
    test('P0 regressions: CompoundTag numeric priority, per-char space alignment & maxGroup isolation', function () {
        // 1. Simulate Minecraft CompoundTag where getString(key) returns '' for IntTag/DoubleTag, and raw[key] is undefined
        function FakeCompoundTag(map) {
            this._m = map || {}
        }
        FakeCompoundTag.prototype.contains = function (k) {
            return Object.prototype.hasOwnProperty.call(this._m, k)
        }
        FakeCompoundTag.prototype.getString = function (k) {
            var v = this._m[k]
            return (typeof v === 'string') ? v : ''
        }
        FakeCompoundTag.prototype.getDouble = function (k) {
            var v = this._m[k]
            return (typeof v === 'number') ? v : 0
        }
        FakeCompoundTag.prototype.getBoolean = function (k) {
            return Boolean(this._m[k])
        }

        var nowMs = 1000
        var paints = []
        var netFn = null
        var drawnChars = []
        var p0Warns = []
        var cliSb = {
            console: { info: function () {}, warn: function (m) { p0Warns.push(String(m)) }, error: function (m) { p0Warns.push(String(m)) }, debug: function () {}, log: function () {} },
            ClientEvents: { loggedOut: function () {}, loggedIn: function () {}, paintScreen: function (fn) { paints.push(fn) } },
            NetworkEvents: { dataReceived: function (ch, fn) { if (ch === 'epiphy:screen_danmaku') netFn = fn } },
            Java: {
                loadClass: function (cls) {
                    if (cls === 'java.lang.System') return { nanoTime: function () { return nowMs * 1000000 } }
                    return null
                }
            },
            Text: { of: function (s) { return { string: String(s), getVisualOrderText: function () { return String(s) } } } },
            global: {}
        }
        cliSb.globalThis = cliSb
        vm.createContext(cliSb)
        loadStartupBase(cliSb)
        runScriptIn(cliSb, RENDERER_PATH)
        var rCli = cliSb.global.ScreenDanmakuClient
        var rEv = {
            width: 854, height: 480, level: 'minecraft:overworld',
            font: {
                width: function (s) { return String(s || '').length * 6 },
                drawInBatch: function () {}
            },
            text: function (txt) {
                var s = (txt && txt.string != null) ? String(txt.string) : String(txt)
                drawnChars.push(s)
            },
            graphics: { bufferSource: function () { return { endBatch: function () {} } }, flush: function () {} },
            getMatrix: function () { return {} },
            push: function () {}, pop: function () {}, translate: function () {}, scale: function () {}, rotate: function () {}
        }

        // Push two system overlays via FakeCompoundTag: high priority=9 in group='boss', low priority=2 in group='default'
        netFn({ data: new FakeCompoundTag({ proto: 5, action: 'push', key: 'boss_title', group: 'boss', priority: 9, title: 'BossTitle', stay: 200, lifeMode: 'active' }) })
        netFn({ data: new FakeCompoundTag({ proto: 5, action: 'push', key: 'low_note', group: 'default', priority: 2, title: 'LowNote', stay: 200 }) })
        paints[0](rEv)
        assert.strictEqual(rCli.count(), 2)

        // System clear with numeric maxPriority=3 via CompoundTag must ONLY clear priority<=3, preserving priority=9!
        netFn({ data: new FakeCompoundTag({ proto: 5, action: 'clear', group: '*', maxPriority: 3 }) })
        paints[0](rEv)
        assert.strictEqual(rCli.count(), 1, 'CompoundTag numeric maxPriority=3 must NOT degrade to 10 and clear priority=9')

        // System deactivate with numeric maxPriority=3 via CompoundTag must NOT stop priority=9!
        netFn({ data: new FakeCompoundTag({ proto: 5, action: 'deactivate', key: 'boss_title', maxPriority: 3 }) })
        nowMs += 400
        paints[0](rEv)
        assert.strictEqual(rCli.count(), 1, 'CompoundTag numeric maxStopPriority=3 must NOT stop priority=9')

        // Adversarial player push with group='boss' & maxGroup=1 must NOT evict system 'boss_title' nor another player's 'boss' overlay!
        rCli.push({ action: 'push', tier: 'player', namespace: 'u:good', group: 'boss', priority: 2, title: 'GoodP', stay: 200 })
        rCli.push({ action: 'push', tier: 'player', namespace: 'u:evil', group: 'boss', maxGroup: 1, priority: 2, title: 'Evil1', stay: 200 })
        rCli.push({ action: 'push', tier: 'player', namespace: 'u:evil', group: 'boss', maxGroup: 1, priority: 2, title: 'Evil2', stay: 200 })
        paints[0](rEv)
        // GoodP + boss_title + Evil2 (and fading Evil1 up to maxGroup+1=2) must never wipe boss_title or GoodP!
        netFn({ data: new FakeCompoundTag({ proto: 5, action: 'clear', tier: 'player', namespace: 'u:evil', group: '*', maxPriority: 3 }) })
        paints[0](rEv)
        assert.strictEqual(rCli.count(), 2, 'player maxGroup eviction must stay isolated from system and other players')

        // Clear remaining overlays and test per-char typewriter with multiple spaces: "A  B C"
        rCli.clear('*')
        paints[0](rEv)
        assert.strictEqual(rCli.count(), 0)

        nowMs = 5000
        rCli.push({
            title: 'A  B C',
            typewriter: true,
            charMs: 100,
            perCharShake: true,
            shadow: false,
            stay: 200
        })

        function collectTextAt(t) {
            nowMs = t
            drawnChars.length = 0
            paints[0](rEv)
            return drawnChars.filter(function (c) { return c === 'A' || c === 'B' || c === 'C' }).join('')
        }

        assert.strictEqual(collectTextAt(5000), 'A', 'charMs=100 at 0ms shows 1st char A')
        assert.strictEqual(collectTextAt(5120), 'A', 'at 120ms (vis=2, space #1) must NOT reveal B early')
        assert.strictEqual(collectTextAt(5220), 'A', 'at 220ms (vis=3, space #2) must NOT reveal B early')
        assert.strictEqual(collectTextAt(5320), 'AB', 'at 320ms (vis=4) reveals A and B, not C')
        assert.strictEqual(collectTextAt(5520), 'ABC', 'at 520ms (vis=6) reveals A, B, and C')
        assert.strictEqual(p0Warns.length, 0, 'P0 client regression checks must produce zero warnings/errors')
    })

    // ----------------------------------------------------------------------------
    // 31. P1 regressions: Renderer (renewal tier/maxGroup sync, caps, batch recovery, cursor cache, hasKeyInTag)
    // ----------------------------------------------------------------------------
    test('P1 regressions (renderer): renewal sync, caps, batch error isolation & recovery, cursor cache, fail-closed tag read', function () {
        var warns = []
        var paints = []
        var nowMs = 10000
        function FakeCompoundTag(map, throwOnKey) {
            this._m = map || {}
            this._throwKey = throwOnKey || null
        }
        FakeCompoundTag.prototype.contains = function (k) {
            if (k === this._throwKey) throw new Error('Simulated tag read failure')
            return Object.prototype.hasOwnProperty.call(this._m, k)
        }
        FakeCompoundTag.prototype.getString = function (k) {
            var v = this._m[k]
            return (typeof v === 'string') ? v : ''
        }
        FakeCompoundTag.prototype.getDouble = function (k) {
            var v = this._m[k]
            return (typeof v === 'number') ? v : 0
        }
        FakeCompoundTag.prototype.getBoolean = function (k) {
            return Boolean(this._m[k])
        }

        var cliSb = {
            console: { info: function () {}, warn: function (m) { warns.push(String(m)) }, error: function (m) { warns.push(String(m)) }, debug: function () {}, log: function () {} },
            Date: { now: function () { return nowMs } },
            ClientEvents: { loggedOut: function () {}, loggedIn: function () {}, paintScreen: function (fn) { paints.push(fn) } },
            NetworkEvents: { dataReceived: function () {} },
            Java: { loadClass: function () { return null } },
            Text: { of: function (s) { return { string: String(s), getVisualOrderText: function () { return String(s) } } } },
            global: {}
        }
        cliSb.globalThis = cliSb
        vm.createContext(cliSb)
        loadStartupBase(cliSb)
        runScriptIn(cliSb, RENDERER_PATH)

        var cli = cliSb.global.ScreenDanmakuClient
        var rEv = {
            width: 854, height: 480, level: 'minecraft:overworld',
            font: { width: function (s) { return String(s || '').length * 6 }, drawInBatch: function () {} },
            text: function () {},
            graphics: { bufferSource: function () { return { endBatch: function () {} } }, flush: function () {} },
            getMatrix: function () { return {} },
            push: function () {}, pop: function () {}, translate: function () {}, scale: function () {}, rotate: function () {}
        }

        // 1. P1-1: Renewal must sync tier & maxGroupSize (preserving matching key namespace prefix 'mod:demo:renew_k')
        cli.push({ key: 'renew_k', tier: 'system', ns: 'mod:demo', group: 'grpA', maxGroup: 5, title: 'V1', stay: 200 })
        cli.push({ key: 'renew_k', tier: 'player', ns: 'mod:demo', group: 'grpA', maxGroup: 1, title: 'V2', stay: 200 })
        paints[0](rEv)
        var snap1 = cli.list()
        assert.strictEqual(snap1.length, 1, 'snap1 must contain renewed overlay unconditionally')
        assert.strictEqual(snap1[0].tier, 'player', 'renewal must update tier')
        cli.push({ key: 'other_k', tier: 'player', ns: 'mod:demo', group: 'grpA', maxGroup: 1, title: 'V3', stay: 200 })
        paints[0](rEv)
        cli.push({ action: 'clear', tier: 'player', ns: 'mod:demo', group: 'grpA', maxPriority: 5 })
        paints[0](rEv)
        assert.strictEqual(cli.count(), 0, 'synced player tier on renewal must allow player clear on mod:demo')

        // 2. P1-6: hasKeyInTag throwing CompoundTag.contains fails closed -> keeps safe fallback priority 5 instead of reading 0!
        cli.push(new FakeCompoundTag({ action: 'push', key: 'tag_pri', lifeMode: 'active', title: 'TagPri', stay: 200 }, 'priority'))
        cli.push({ action: 'clear', group: '*', maxPriority: 3 })
        paints[0](rEv)
        assert.strictEqual(cli.count(), 1, 'corrupt tag throwing on priority must fail closed to default active priority 5 (>3), not read 0')
        cli.clear('*')
        paints[0](rEv)

        // 3. P1-2 & P1-3: Queue cap preserves control packets even at queue head; batch mid-throw isolates broken item without downgrading batch
        cli.push({ title: 'FloodBeforeCtrl', stay: 200 })
        paints[0](rEv)
        assert.strictEqual(cli.count(), 1)
        cli.push({ action: 'deactivate', key: '*', includeOnce: true, fadeOut: 1 })
        for (var qi = 0; qi < 270; qi++) {
            cli.push({ title: 'Flood_' + qi, stay: 40 })
        }
        for (var fl = 0; fl < 6; fl++) {
            nowMs += 100
            paints[0](rEv)
        }
        var hasDeactivatedSurvived = cli._pure.inspectOverlays().every(function (ov) { return ov.title !== 'FloodBeforeCtrl' })
        assert.ok(hasDeactivatedSurvived, 'control action queued BEFORE flood must survive maxPendingActions eviction and stop prior overlay')
        cli.clear('*')
        paints[0](rEv)

        var badTagItem = new FakeCompoundTag({ title: 'Bad' }, 'title')
        cli.push({
            items: [
                { title: 'Good1', stay: 200, scale: 99 },
                badTagItem,
                { title: 'Good2', stay: 200 }
            ]
        })
        paints[0](rEv)
        assert.strictEqual(cli.count(), 2, 'batch must keep valid items around a single throwing item without aborting or single-item fallback')
        cli.clear('*')
        paints[0](rEv)

        // 4. P1-5: Cursor blink during typewriter must NOT bust lineCacheKey across 300ms..900ms
        nowMs = 20000
        cli.push({ key: 'tw_cache', title: 'Hello World', typewriter: true, charMs: 2000, stay: 200, scale: 1.0 })
        paints[0](rEv)
        var beforeBlinkList = cli.list()
        assert.strictEqual(beforeBlinkList.length, 1)
        var beforeBlinkKey = beforeBlinkList[0].lineCacheKey
        assert.ok(typeof beforeBlinkKey === 'string' && beforeBlinkKey.length > 0, 'beforeBlinkKey must be materialized on static typewriter line')
        nowMs = 20600 // toggled blink phase, same shownVis=1 (charMs=2000)
        paints[0](rEv)
        var afterBlinkKey = cli.list()[0].lineCacheKey
        assert.strictEqual(afterBlinkKey, beforeBlinkKey, 'blinkCursor phase change alone must NOT bust lineCacheKey')
    })

    // ----------------------------------------------------------------------------
    // 33. P1 regressions: Danmaku server (block clear isolation, invalid dim fail-closed, missing myIdx, packet bounds)
    // ----------------------------------------------------------------------------
    test('P1 regressions (danmaku server): scoped block clear, invalid dim fail-closed, missing myIdx & packet bounds', function () {
        var warns = []
        var overworld = { dimension: 'minecraft:overworld', getDimension: function () { return 'minecraft:overworld' }, players: [] }
        var pl = {
            username: 'DmTest', uuid: '00000000-0000-4000-8000-0000000000dd',
            level: overworld, block: { x: 1, y: 64, z: 1 },
            isOp: function () { return false },
            sendData: function (ch, pkt) { this._sent.push(pkt) },
            _sent: []
        }
        overworld.players = [pl]
        var srv = {
            getWorldData: function () { return { getLevelName: function () { return 'DmP1' }, getAllowCommands: function () { return true } } },
            getLevel: function (d) { return String(d) === 'minecraft:overworld' ? overworld : null },
            getAllLevels: function () { return [overworld] },
            getPlayerList: function () { return { getPlayers: function () { return [pl] } } },
            overworld: function () { return overworld }
        }
        var hookPlace = null
        var hookBreak = null
        var sb = {
            console: { info: function () {}, warn: function (m) { warns.push(String(m)) }, error: function (m) { warns.push(String(m)) }, debug: function () {}, log: function () {} },
            ServerEvents: { loaded: function (fn) { fn({ server: srv }) }, unloaded: function () {}, tick: function () {}, commandRegistry: function () {}, command: function () {} },
            PlayerEvents: { loggedIn: function () {}, loggedOut: function () {} },
            BlockEvents: { placed: function (fn) { hookPlace = fn }, broken: function (fn) { hookBreak = fn } },
            LevelEvents: { loaded: function () {} },
            Utils: { server: srv },
            server: srv,
            global: {}
        }
        sb.globalThis = sb
        vm.createContext(sb)
        loadStartupBase(sb)
        loadServerBase(sb)
        runScriptIn(sb, DANMAKU_PATH)

        var Base = sb.global.EpiphyServerBase
        var Dm = sb.global.ScreenDanmaku
        // P1-19: resolveLevel fails closed on invalid dim & clearNear(null) does NOT hit overworld
        assert.strictEqual(Base.resolveLevel('minecraft:nonexistent', srv), null, 'invalid dim must fail closed to null')
        assert.strictEqual(Dm.clearNear('minecraft:nonexistent', 0, 64, 0, 100), 0, 'clearNear on invalid dim must send 0 packets')
        assert.strictEqual(Dm.deactivateNear(null, 0, 64, 0, 100), 0, 'deactivateNear on null dim must send 0 packets')
        assert.strictEqual(pl._sent.length, 0)

        // P1-22: script API packet size bounds
        Dm.toPlayer(pl, { title: new Array(6000).join('Z'), scale: 500 })
        assert.ok(pl._sent.length === 1 && pl._sent[0].title.length === 4096 && pl._sent[0].scale <= 8.0, 'SYSTEM_PACKET_LIMITS must clamp giant title and scale')

        // P1-18: Block break clear is isolated to block namespace & priority
        pl._sent.length = 0
        Dm.bindBlock('test:beacon_warn', { group: 'alerts', radius: 16, mode: 'once', title: 'BeaconWarn', priority: 3 })
        if (hookPlace) {
            hookPlace({ level: overworld, block: { id: 'test:beacon_warn', x: 2, y: 64, z: 2 } })
        }
        if (hookBreak) {
            hookBreak({ level: overworld, block: { id: 'test:beacon_warn', x: 2, y: 64, z: 2 } })
        }
        var clrPkts = pl._sent.filter(function (pk) { return pk.action === 'clear' })
        assert.ok(clrPkts.length >= 1, 'breaking bound block emits scoped clear')
        assert.strictEqual(clrPkts[0].namespace, 'blk:test:beacon_warn', 'bound block clear must stay scoped to block namespace')
        assert.strictEqual(clrPkts[0].maxPriority, 3, 'bound block clear must include maxSeenPriority')
    })

    // ----------------------------------------------------------------------------
    // 41. ScreenDanmakuClient v5.3: per-char optimization, static-run merge, illegal shared sentinel, binary range & viewport bounds
    // ----------------------------------------------------------------------------
    test('ScreenDanmakuClient v5.3: trig LUT, bit-mix hash, illegal shared pulse/wave sentinel, static merge + typewriter & bounds culling', function () {
        var nowMs = 1000
        var paints = []
        var draws = []
        var warns = []
        var cliSb = {
            console: { info: function () {}, warn: function (m) { warns.push(String(m)) }, error: function (m) { warns.push(String(m)) }, debug: function () {}, log: function () {} },
            Date: { now: function () { return nowMs } },
            ClientEvents: { loggedOut: function () {}, loggedIn: function () {}, paintScreen: function (fn) { paints.push(fn) } },
            NetworkEvents: { dataReceived: function () {} },
            Java: {
                loadClass: function (cls) {
                    if (cls === 'java.lang.System') return { nanoTime: function () { return nowMs * 1000000 } }
                    return null
                }
            },
            Text: { of: function (s) { return { string: String(s), getVisualOrderText: function () { return String(s) } } } },
            global: {}
        }
        cliSb.globalThis = cliSb
        vm.createContext(cliSb)
        loadStartupBase(cliSb)
        runScriptIn(cliSb, RENDERER_PATH)

        var Cli  = cliSb.global.ScreenDanmakuClient
        var Pure = Cli._pure
        assert.ok(Pure != null, 'ScreenDanmakuClient._pure must exist')

        // 1. hashUnit (bit-mixer) range, determinism, and sensitivity to adjacent fractional seeds
        var seen = new Set()
        for (var hi = 0; hi < 200; hi++) {
            var h = Pure.hashUnit(37.0 + hi * 0.7)
            assert.ok(isFinite(h) && h >= 0 && h < 1, 'hashUnit out of [0,1): ' + h)
            assert.strictEqual(Pure.hashUnit(37.0 + hi * 0.7), h, 'hashUnit must be deterministic')
            seen.add(Math.floor(h * 1000000))
        }
        assert.ok(seen.size >= 195, 'bit-mixer hashUnit must have high uniqueness across adjacent fractional seeds')

        // 2. Trig LUT accuracy across positive, negative, and wrapped turns
        for (var ti = -30; ti <= 30; ti++) {
            var tr = ti * 0.137
            assert.ok(Math.abs(Pure.fastSinTurns(tr) - Math.sin(tr * Math.PI * 2.0)) < 0.03, 'fastSinTurns error too high at ' + tr)
            assert.ok(Math.abs(Pure.fastCosTurns(tr) - Math.cos(tr * Math.PI * 2.0)) < 0.03, 'fastCosTurns error too high at ' + tr)
        }

        var ev = {
            width: 300, height: 200, level: 'minecraft:overworld',
            font: { width: function (s) { return String(s || '').length * 6 }, drawInBatch: function () {} },
            text: function (txt, x, y) {
                var s = (txt && txt.string != null) ? String(txt.string) : String(txt)
                draws.push({ text: s, x: x, y: y })
            },
            graphics: { bufferSource: function () { return { endBatch: function () {} } }, flush: function () {} },
            getMatrix: function () { return {} },
            push: function () {}, pop: function () {}, translate: function () {}, scale: function () {}, rotate: function () {}
        }

        // 3. 【可以】vs【不能】共用 pulse / wave 检查（触发不可共用条件时必须写为 NaN 非法哨兵）
        // Case A: Unified frequency (800..800) + omni -> CAN share!
        Cli.push({
            key: 'shared_ok', title: 'ABCDE', perCharShake: true, charShakeStyle: 'omni',
            shakeFreqMin: 800, shakeFreqMax: 800, typewriter: false, shadow: false, stay: 200
        })
        paints[0](ev)
        var itemOk = Pure.inspectOverlays()[0]
        assert.strictEqual(itemOk._sharedShakeTiming.canShare, true, 'unified freq omni must enable shared timing')
        assert.strictEqual(itemOk._sharedShakeTiming.illegalReason, '')
        assert.ok(isFinite(itemOk._sharedShakeTiming.pulse) && isFinite(itemOk._sharedShakeTiming.frac))

        // Steady-state snapshot verification (omni frac >= jitterWin=0.26 -> settles after 250ms)
        nowMs = 1350 // age=350ms, frac=350/800=0.4375 >= 0.26
        paints[0](ev)
        var settledSample = Pure.sampleCharShakeOffset(itemOk.charShakeFrags[0], 350, 0.65, itemOk, { dx: 0, dy: 0, rotDeg: 0 }, itemOk._sharedShakeTiming)
        assert.strictEqual(itemOk.charShakeFrags[0]._settledStep, 0)
        assert.ok(isFinite(itemOk.charShakeFrags[0]._oCos) && isFinite(itemOk.charShakeFrags[0]._oSin))
        var settledNext = Pure.sampleCharShakeOffset(itemOk.charShakeFrags[0], 500, 0.65, itemOk, { dx: 0, dy: 0, rotDeg: 0 }, itemOk._sharedShakeTiming)
        assert.strictEqual(settledNext.dx, settledSample.dx, 'settled stage must reuse exact dx snapshot')
        assert.strictEqual(settledNext.dy, settledSample.dy, 'settled stage must reuse exact dy snapshot')

        // Case B: Non-unified freq (400..900) -> MUST mark illegal & poison shared pulse/wave to NaN
        Cli.clear('*')
        paints[0](ev)
        nowMs = 2000
        Cli.push({
            key: 'shared_bad_freq', title: 'ABCDE', perCharShake: true, charShakeStyle: 'omni',
            shakeFreqMin: 400, shakeFreqMax: 900, typewriter: false, shadow: false, stay: 200
        })
        paints[0](ev)
        var itemBadFreq = Pure.inspectOverlays()[0]
        assert.strictEqual(itemBadFreq._sharedShakeTiming.canShare, false, 'non-unified freq must forbid shared pulse/wave')
        assert.strictEqual(itemBadFreq._sharedShakeTiming.illegalReason, 'NON_UNIFIED_CHAR_FREQ')
        assert.ok(Number.isNaN(itemBadFreq._sharedShakeTiming.pulse), 'illegal pulse must be poisoned to NaN')
        assert.ok(Number.isNaN(itemBadFreq._sharedShakeTiming.wave), 'illegal wave must be poisoned to NaN')
        assert.ok(Number.isNaN(itemBadFreq._sharedShakeTiming.frac), 'illegal frac must be poisoned to NaN')
        assert.ok(Number.isNaN(itemBadFreq._sharedShakeTiming.stepIdx), 'illegal stepIdx must be poisoned to NaN')

        // Case C: styleCode === 2 ('smooth') even with unified freq -> MUST mark illegal & poison NaN
        Cli.clear('*')
        paints[0](ev)
        nowMs = 3000
        Cli.push({
            key: 'shared_bad_smooth', title: 'ABC', perCharShake: true, charShakeStyle: 'smooth',
            shakeFreqMin: 800, shakeFreqMax: 800, typewriter: false, shadow: false, stay: 200
        })
        paints[0](ev)
        var itemSmooth = Pure.inspectOverlays()[0]
        assert.strictEqual(itemSmooth._sharedShakeTiming.canShare, false, 'smooth mode must forbid shared pulse/wave')
        assert.strictEqual(itemSmooth._sharedShakeTiming.illegalReason, 'STYLE_SMOOTH_PER_CHAR_PHASE')
        assert.ok(Number.isNaN(itemSmooth._sharedShakeTiming.pulse), 'smooth mode must poison shared.pulse=NaN')
        assert.ok(Number.isNaN(itemSmooth._sharedShakeTiming.wave), 'smooth mode must poison shared.wave=NaN')

        // Case D: Per-char mismatch defense when consuming sharedTiming
        var poisonedTiming = { canShare: true, styleCode: 0, periodMs: 800, phaseOff: 0, cyc: 0.1, stepIdx: 0, frac: 0.1, pulse: 999, wave: 0, transT: 1 }
        var fakeCharCustomPeriod = { cSeed: 42, periodMs: 500, invPeriod: 1 / 500, phaseOff: 0 }
        var directRef = Pure.sampleCharShakeOffset(fakeCharCustomPeriod, 100, 0.65, itemOk, { dx: 0, dy: 0, rotDeg: 0 })
        var guardedOut = Pure.sampleCharShakeOffset(fakeCharCustomPeriod, 100, 0.65, itemOk, { dx: 0, dy: 0, rotDeg: 0 }, poisonedTiming)
        assert.strictEqual(guardedOut.dx, directRef.dx, 'mismatched cf.periodMs must refuse sharedTiming even if canShare=true')
        assert.strictEqual(guardedOut.dy, directRef.dy)

        // 4. Static run merging + typewriter char-by-char slicing ("Hello <shake>XY</shake> World")
        Cli.clear('*')
        paints[0](ev)
        nowMs = 4000
        Cli.push({
            key: 'mixed_static',
            title: 'Hello <shake>XY</shake> World',
            typewriter: true,
            charMs: 100,
            shadow: false,
            stay: 200
        })
        paints[0](ev) // flushes queue & sets born = 4000
        draws.length = 0
        nowMs = 4200 // age=200 -> shownVis=3 ("Hel") -> partial slice inside merged "Hello"
        paints[0](ev)
        assert.strictEqual(
            draws.filter(function (d) { return d.text !== '▌' }).map(function (d) { return d.text }).join(''),
            'Hel',
            'partial slice during typewriter must still render strictly 1 char at a time'
        )

        draws.length = 0
        nowMs = 6000 // fully revealed -> "Hello", "X", "Y", "World" (4 draw calls instead of 12!)
        paints[0](ev)
        assert.deepStrictEqual(
            draws.map(function (d) { return d.text }),
            ['Hello', 'X', 'Y', 'World'],
            'fully revealed static segments must merge while shaking chars stay separate and spaces never merge across'
        )

        // Binary search range verification
        var mixedItem = Pure.inspectOverlays()[0]
        var rSub = Pure.findVisibleUnitRange(mixedItem.charShakeUnits, 2, 7)
        assert.strictEqual(rSub.lo, 0)
        assert.strictEqual(rSub.hi, 2) // includes Hello [0..5) and X [6..7)

        // 5. Off-screen viewport bounds culling for ultra-wide clamp=false wrap=false per-char banner
        Cli.clear('*')
        paints[0](ev)
        nowMs = 7000
        var longTxt = 'A'.repeat(200) // wrap:false -> 200 * 6px = 1200px wide on sw=300px!
        Cli.push({
            key: 'wide_offscreen',
            title: longTxt,
            perCharShake: true,
            typewriter: false,
            wrap: false,
            clamp: false,
            shadow: false,
            stay: 200
        })
        draws.length = 0
        paints[0](ev)
        assert.ok(draws.length > 30 && draws.length < 90, 'bounds culling must draw middle visible chars and cull far offscreen chars; drawn=' + draws.length)
        assert.strictEqual(warns.length, 0, 'v5.3 renderer optimization checks must produce zero warnings/errors: ' + JSON.stringify(warns))
    })

    // ----------------------------------------------------------------------------
    // 42. ScreenDanmakuClient v5.4: frame-cached sAllowShadow, itemFgMat reuse, zero hot-path getMatrix, strict invariant rCtx & priority sweep
    // ----------------------------------------------------------------------------
    test('ScreenDanmakuClient v5.4: frame sAllowShadow cache, itemFgMat reuse, no hot-path getMatrix & strict invariant ctx', function () {
        var setCalls = 0
        var translateCalls = 0
        function CountingMat() {
            this.z = 0
        }
        CountingMat.prototype.set = function (other) {
            setCalls++
            this.z = (other && typeof other.z === 'number') ? other.z : 0
            return this
        }
        CountingMat.prototype.translate = function (_dx, _dy, dz) {
            translateCalls++
            this.z += (dz || 0)
            return this
        }
        CountingMat.prototype.rotateZ = function () { return this }
        CountingMat.prototype.scale   = function () { return this }

        var sAllowShadowReads = 0
        var shadowEnabled = true
        var ModernRendererMock = { sAllowSDFTextIn2D: true }
        Object.defineProperty(ModernRendererMock, 'sAllowShadow', {
            enumerable: true,
            get: function () {
                sAllowShadowReads++
                return shadowEnabled
            }
        })

        var drawLogs = []
        var lookupCalls = 0
        var muiEngineMock = {
            lookupFormattedLayout: function (seq) {
                lookupCalls++
                var s = String(seq)
                return {
                    hasColorEmoji: function () { return false },
                    equals: function (o) { return Boolean(o && o._s === s) },
                    _s: s,
                    drawText: function (mat, _buf, x, y, r, g, b, a, isShd) {
                        drawLogs.push({ s: s, rgb: (r << 16) | (g << 8) | b, isShd: Boolean(isShd), z: mat ? mat.z : 0 })
                        return 0
                    }
                }
            },
            getTextRenderer: function () { return { chooseMode: function () { return 1 } } }
        }

        var nowMs = 1000
        var paints = []
        var cliSb = {
            console: { info: function () {}, warn: function () {}, error: function () {}, debug: function () {}, log: function () {} },
            Date: { now: function () { return nowMs } },
            ClientEvents: { loggedOut: function () {}, loggedIn: function () {}, paintScreen: function (fn) { paints.push(fn) } },
            NetworkEvents: { dataReceived: function () {} },
            Java: {
                loadClass: function (cls) {
                    if (cls === 'java.lang.System') return { nanoTime: function () { return nowMs * 1000000 } }
                    if (cls === 'net.minecraft.client.gui.Font$DisplayMode') return { NORMAL: 'NORMAL' }
                    if (cls === 'org.joml.Matrix4f') return CountingMat
                    if (cls === 'icyllis.modernui.mc.text.TextLayoutEngine') return { getInstance: function () { return muiEngineMock } }
                    if (cls === 'icyllis.modernui.mc.text.ModernTextRenderer') return ModernRendererMock
                    return null
                }
            },
            Text: { of: function (s) { return { string: String(s), getVisualOrderText: function () { return String(s) } } } },
            global: {}
        }
        cliSb.globalThis = cliSb
        vm.createContext(cliSb)
        loadStartupBase(cliSb)
        runScriptIn(cliSb, RENDERER_PATH)

        var Cli = cliSb.global.ScreenDanmakuClient
        assert.ok(Cli.CONFIG.frameBudgetMs >= 40.0, 'emergency frameBudgetMs must stay high to avoid flickering heavy effects')

        var getMatrixCalls = 0
        var returnNullMatrix = false
        var baseFrameMat = new CountingMat()
        var fbDraws = []
        var ev = {
            width: 854, height: 480, level: 'minecraft:overworld',
            font: { width: function (s) { return String(s || '').length * 6 }, m_272191_: function () {} },
            text: function (comp) { fbDraws.push(String(comp.string)) },
            graphics: { bufferSource: function () { return { endBatch: function () {} } }, flush: function () {} },
            getMatrix: function () {
                getMatrixCalls++
                return returnNullMatrix ? null : baseFrameMat
            },
            push: function () {}, pop: function () {}, translate: function () {}, scale: function () {}, rotateDeg: function () {}
        }

        // 1. 10-char unrotated omni per_char with shadow=true: sAllowShadow read 1x/frame; itemFgMat built 1x for all 10 chars!
        Cli.push({
            key: 'fg_reuse',
            title: 'ABCDEFGHIJ',
            perCharShake: true,
            charShakeStyle: 'omni',
            outlineMode: 'none',
            shadow: true,
            typewriter: false,
            stay: 200
        })

        sAllowShadowReads = 0
        setCalls = 0
        translateCalls = 0
        drawLogs.length = 0
        paints[0](ev)
        assert.strictEqual(sAllowShadowReads, 1, 'sAllowShadow must only be read ONCE per frame, not once per char')
        // 1 itemMat (set + translate(px,py)) + 1 itemFgMat (set + translate(0,0,0.03)) = 2 set & 2 translate total across all 10 chars!
        assert.strictEqual(setCalls, 2, '10 unrotated shaded chars must share 1 itemMat + 1 itemFgMat (2 set calls total, not 11); got ' + setCalls)
        assert.strictEqual(translateCalls, 2, '10 unrotated shaded chars must invoke translate only twice total; got ' + translateCalls)
        assert.strictEqual(drawLogs.filter(function (d) { return d.isShd === false && Math.abs(d.z - 0.03) < 1e-6 }).length, 10, 'all 10 fg passes must use z=0.03')

        // Dynamic sAllowShadow toggle to false takes effect on the very next frame (still only 1 read!)
        shadowEnabled = false
        drawLogs.length = 0
        paints[0](ev)
        assert.strictEqual(sAllowShadowReads, 2, 'frame 2 reads sAllowShadow once again')
        assert.strictEqual(drawLogs.filter(function (d) { return d.isShd === true }).length, 0, 'dynamic sAllowShadow=false must suppress shadow passes next frame')

        // 2. Null itemMat must NOT trigger hot-path getMatrix() or wasted lookupFormattedLayout() per char
        shadowEnabled = true
        returnNullMatrix = true
        getMatrixCalls = 0
        lookupCalls = 0
        fbDraws.length = 0
        paints[0](ev)
        assert.ok(getMatrixCalls <= 2, 'null itemMat must never poll event.getMatrix() inside 10-char loop; calls=' + getMatrixCalls)
        assert.strictEqual(lookupCalls, 1, 'only canary lookup runs when itemMat is null; char loop must skip batched MUI cleanly')
        assert.strictEqual(fbDraws.length, 10, 'fallback draw still renders all 10 chars')

        // 3. Strictly invariant itemCtx MUST preserve subColor, <outline>, <big> overrides & priority order
        returnNullMatrix = false
        Cli.clear('*')
        paints[0](ev)
        nowMs = 2000
        Cli.push({
            key: 'low_pri', priority: 1, title: 'LOW', typewriter: false, shadow: false, stay: 200
        })
        Cli.push({
            key: 'high_pri_mixed', priority: 9,
            title: '<outline=#00FF00>A</outline>',
            sub: 'S',
            color: 0xFF0000,
            subColor: 0x0000FF,
            outlineMode: 'glow',
            shadow: false,
            typewriter: false,
            stay: 200
        })
        drawLogs.length = 0
        paints[0](ev)
        // 2D Painter's algorithm: low priority=1 renders BEFORE high priority=9 so higher-priority text stays on top
        var firstDrawn = drawLogs[0]
        var lastDrawn  = drawLogs[drawLogs.length - 1]
        assert.strictEqual(firstDrawn.s, 'LOW', 'priority=1 overlay must render before priority=9 overlay (bottom layer)')
        assert.ok(lastDrawn.s === 'A' || lastDrawn.s === 'S', 'priority=9 overlay must render after priority=1 overlay (top layer)')
        assert.ok(drawLogs.some(function (d) { return d.s === 'A' && d.rgb === 0x00FF00 }), 'inline <outline=#00FF00> must override item outline')
        assert.ok(drawLogs.some(function (d) { return d.s === 'S' && d.rgb === 0x0000FF }), 'subColor must stay independent from title color in rCtx')

        // 4. Expired items must be cleanly evicted every frame
        nowMs = 999999
        paints[0](ev)
        assert.strictEqual(Cli.count(), 0, 'expired overlays must always be evicted cleanly')
    })

    // ----------------------------------------------------------------------------
    // 53. ScreenDanmakuClient v5.5: ModernUI lookupVanillaLayout, drawTextOutline, Pass-Grouping, <shake> crisp mode & fallback
    // ----------------------------------------------------------------------------
    test('ScreenDanmakuClient v5.5: ModernUI lookupVanillaLayout, drawTextOutline, Pass-Grouping, <shake> crisp mode & fallback', function () {
        function MuiM4() {
            this._m00 = 1.0
            this._m11 = 1.0
            this.z    = 0.0
        }
        var m4SetCount = 0
        MuiM4.prototype.set = function (o) {
            m4SetCount++
            this._m00 = o ? o._m00 : 1.0
            this._m11 = o ? o._m11 : 1.0
            this.z    = o ? (o.z || 0.0) : 0.0
            return this
        }
        MuiM4.prototype.translate = function (dx, dy, dz) { this.z += (dz || 0.0); return this }
        MuiM4.prototype.rotateZ   = function (rad) { return this }
        MuiM4.prototype.scale     = function (sx, sy, sz) { this._m00 *= sx; this._m11 *= sy; return this }
        MuiM4.prototype.m00       = function () { return this._m00 }
        MuiM4.prototype.m11       = function () { return this._m11 }

        var nowMs = 1000
        var canaryEpoch = 1
        var opSeq = 0
        var textOfCalls = 0
        var vanillaNonCanaryLookups = []
        var formattedLookups = 0
        var drawCalls = []
        var outlineCalls = []
        var endBatchCalls = 0
        var cliWarns = []
        var paints = []

        var layoutCacheByEpoch = {}
        function makeMuiLayout(tag, isEmoji) {
            var id = canaryEpoch + ':' + tag
            var lay = {
                _id: id,
                equals: function (other) { return Boolean(other && other._id === id) },
                hasColorEmoji: function () { return Boolean(isEmoji) },
                getTotalAdvance: function () { return String(tag).length * 6.0 },
                drawText: function (mat, bufSrc, x, y, r, g, b, a, isShadow, mode) {
                    opSeq++
                    drawCalls.push({
                        opSeq: opSeq, tag: tag, z: mat ? mat.z : 0,
                        x: x, y: y, r: r, g: g, b: b, a: a,
                        isShadow: Boolean(isShadow), mode: mode
                    })
                },
                drawTextOutline: function (mat, bufSrc, x, y, r, g, b, a) {
                    opSeq++
                    outlineCalls.push({
                        opSeq: opSeq, tag: tag, z: mat ? mat.z : 0,
                        x: x, y: y, r: r, g: g, b: b, a: a
                    })
                }
            }
            return lay
        }

        var fakeEngine = {
            lookupVanillaLayout: function (str) {
                var s = String(str)
                if (s !== 'A') vanillaNonCanaryLookups.push(s)
                var ck = canaryEpoch + '|' + s
                if (!layoutCacheByEpoch[ck]) {
                    layoutCacheByEpoch[ck] = makeMuiLayout(s, s === '\uD83D\uDE00')
                }
                return layoutCacheByEpoch[ck]
            },
            lookupFormattedLayout: function (fcs) {
                formattedLookups++
                return makeMuiLayout('fmt:' + String(fcs), false)
            },
            getTextRenderer: function () {
                return {
                    chooseMode: function () { return 4 }
                }
            }
        }

        var bufSrc = {
            endBatch: function (sheet) { endBatchCalls++ }
        }

        var sb = {
            console: { info: function () {}, warn: function (m) { cliWarns.push(String(m)) }, error: function (m) { cliWarns.push(String(m)) }, debug: function () {}, log: function () {} },
            ClientEvents: { loggedOut: function () {}, loggedIn: function () {}, paintScreen: function (fn) { paints.push(fn) } },
            NetworkEvents: { dataReceived: function () {} },
            Java: {
                loadClass: function (cls) {
                    if (cls === 'java.lang.System') return { nanoTime: function () { return nowMs * 1000000 } }
                    if (cls === 'net.minecraft.client.gui.Font$DisplayMode') return { NORMAL: 'NORMAL' }
                    if (cls === 'org.joml.Matrix4f') return MuiM4
                    if (cls === 'net.minecraft.client.renderer.Sheets') return { translucentCullBlockSheet: function () { return 'EMOJI_SHEET' } }
                    if (cls === 'icyllis.modernui.mc.text.TextLayoutEngine') return { getInstance: function () { return fakeEngine } }
                    if (cls === 'icyllis.modernui.mc.text.ModernTextRenderer') return { sAllowSDFTextIn2D: true, sAllowShadow: true, sUseTextShadersInWorld: true }
                    return null
                }
            },
            Text: {
                of: function (s) {
                    textOfCalls++
                    return { string: String(s), getVisualOrderText: function () { return String(s) } }
                }
            },
            global: {}
        }
        sb.globalThis = sb
        vm.createContext(sb)
        loadStartupBase(sb)
        runScriptIn(sb, RENDERER_PATH)
        var Cli = sb.global.ScreenDanmakuClient
        assert.ok(Cli && paints.length === 1)

        var baseMat = new MuiM4()
        var ev = {
            width: 854, height: 480, level: 'minecraft:overworld',
            font: { width: function (s) { return String(s).length * 6 } },
            graphics: { bufferSource: function () { return bufSrc }, flush: function () {} },
            getMatrix: function () { return baseMat }
        }

        // 1. lookupVanillaLayout(String) zero Text.of allocation + SHARED_TEXT_SEQ_CACHE cross-item reuse + pop-in SDF -> settled crisp mode 0
        Cli.push({ title: 'HelloModern', typewriter: false, shadow: false, outlineMode: 'none', stay: 1000, fadeOut: 5 })
        Cli.push({ title: 'HelloModern', typewriter: false, shadow: false, outlineMode: 'none', ry: 0.45, stay: 1000, fadeOut: 5 })
        paints[0](ev)
        assert.strictEqual(textOfCalls, 0, 'ModernUI lookupVanillaLayout path must allocate zero Text.of components')
        assert.strictEqual(formattedLookups, 0, 'must not fall back to lookupFormattedLayout when lookupVanillaLayout succeeds')
        assert.strictEqual(vanillaNonCanaryLookups.length, 1, 'identical line text across two overlays must share 1 lookupVanillaLayout result')
        assert.strictEqual(drawCalls.length, 2, 'two static un-outlined items -> 2 drawText calls')
        assert.ok(drawCalls.every(function (d) { return d.mode === 1 }), 'pop-in entrance scale animation uses smooth SDF mode 1')
        drawCalls.length = 0
        nowMs += 350
        paints[0](ev)
        assert.strictEqual(drawCalls.length, 2)
        assert.ok(drawCalls.every(function (d) { return d.mode === 0 }), 'once pop-in settles at scale=1.0, un-outlined static items drop to crisp mode 0')

        // 2. No 15s TTL re-lookup when MUI_EPOCH is unchanged
        nowMs += 30000
        drawCalls.length = 0
        Cli.clear()
        Cli.push({ title: 'HelloModern', typewriter: false, shadow: false, outlineMode: 'none', stay: 40, fadeOut: 5 })
        paints[0](ev)
        assert.strictEqual(vanillaNonCanaryLookups.length, 1, 'must NOT re-lookup after 30s when ModernUI canary epoch is unchanged')

        // 3. F3+T reload (new canary instance) invalidates MUI_EPOCH and re-resolves cached entries cleanly
        canaryEpoch = 2
        nowMs += 50
        drawCalls.length = 0
        Cli.clear()
        Cli.push({ title: 'HelloModern', typewriter: false, shadow: false, outlineMode: 'none', stay: 40, fadeOut: 5 })
        paints[0](ev)
        assert.strictEqual(vanillaNonCanaryLookups.length, 2, 'canary reload must bump MUI_EPOCH and trigger fresh lookupVanillaLayout')

        // 4. mui_stroke single-pass drawTextOutline vs emoji bitmap automatic fallback to stroke ring (+ itemOutMat reuse)
        Cli.clear()
        drawCalls.length = 0
        outlineCalls.length = 0
        vanillaNonCanaryLookups.length = 0
        Cli.push({ title: 'OutlineTest', typewriter: false, shadow: false, outlineMode: 'mui_stroke', stay: 40, fadeOut: 5 })
        paints[0](ev)
        assert.strictEqual(outlineCalls.length, 1, 'mui_stroke on non-emoji text must use single-pass drawTextOutline')
        assert.strictEqual(drawCalls.length, 1, 'plus 1 foreground drawText')
        assert.strictEqual(drawCalls[0].mode, 1, 'outlined item core aligns to SDF mode 1')

        Cli.clear()
        drawCalls.length = 0
        outlineCalls.length = 0
        m4SetCount = 0
        Cli.push({ title: '\uD83D\uDE00', typewriter: false, shadow: false, outlineMode: 'mui_stroke', outlineWidth: 0.75, stay: 40, fadeOut: 5 })
        paints[0](ev)
        assert.strictEqual(outlineCalls.length, 0, 'emoji/bitmap layout must skip drawTextOutline (ModernUI skips bitmaps) and fall back to stroke ring')
        assert.strictEqual(drawCalls.length, 9, '8-dir stroke ring + 1 core = 9 drawText calls on fallback')
        assert.ok(endBatchCalls >= 1, 'emoji sheet endBatch invoked before emoji draw')
        assert.ok(m4SetCount <= 3, 'itemOutMat negative-Z cache must avoid re-calling Matrix4f.set per ring offset (actual=' + m4SetCount + ')')

        // 5. Multi-line static 3-pass Pass-Grouping: all Pass 1 drawTextOutline precede all Pass 3 foreground drawText
        Cli.clear()
        drawCalls.length = 0
        outlineCalls.length = 0
        Cli.push({ title: 'Line1', sub: 'Line2', typewriter: false, shadow: false, outlineMode: 'mui_stroke', stay: 40, fadeOut: 5 })
        paints[0](ev)
        assert.strictEqual(outlineCalls.length, 2, 'multi-line mui_stroke emits 2 Pass-1 outlines')
        assert.strictEqual(drawCalls.length, 2, 'plus 2 Pass-3 foregrounds')
        var maxOutlineSeq = Math.max.apply(null, outlineCalls.map(function (o) { return o.opSeq }))
        var minCoreSeq    = Math.min.apply(null, drawCalls.map(function (d) { return d.opSeq }))
        assert.ok(maxOutlineSeq < minCoreSeq, 'all Pass-1 outlines must execute strictly before Pass-3 foregrounds')

        // 6. <shake> alone keeps crisp mode 0 after pop-in, whereas <outline> enables SDF 1 + shadow Pass 2 before foreground Pass 3
        Cli.clear()
        drawCalls.length = 0
        outlineCalls.length = 0
        Cli.push({ title: '<shake>AB</shake>', typewriter: false, shadow: false, outlineMode: 'none', shakeMode: 'none', charShakeRotDeg: 0, stay: 40, fadeOut: 5 })
        paints[0](ev)
        nowMs += 350
        drawCalls.length = 0
        paints[0](ev)
        assert.strictEqual(drawCalls.length, 2, '<shake>AB</shake> renders A and B')
        assert.ok(drawCalls.every(function (d) { return d.mode === 0 }), '<shake>-only tags must keep crisp MODE_NORMAL(0) rather than forcing SDF(1)')

        Cli.clear()
        drawCalls.length = 0
        Cli.push({ title: 'A<outline=#00FF00>B</outline>', typewriter: false, shadow: true, outlineMode: 'none', stay: 40, fadeOut: 5 })
        paints[0](ev)
        var bOutDraws = drawCalls.filter(function (d) { return d.tag === 'B' && d.g === 255 && !d.isShadow && d.z < -0.01 })
        var aShdDraws = drawCalls.filter(function (d) { return d.tag === 'A' && d.isShadow })
        var cores     = drawCalls.filter(function (d) { return !d.isShadow && d.z >= 0 })
        assert.ok(bOutDraws.length >= 4 && aShdDraws.length === 1 && cores.length === 2, 'grouped inline <outline> + shadow runs outlines -> shadows -> cores')
        assert.ok(Math.max.apply(null, bOutDraws.map(function (d) { return d.opSeq })) < aShdDraws[0].opSeq, 'Pass-1 outline runs before Pass-2 shadow')
        assert.ok(aShdDraws[0].opSeq < Math.min.apply(null, cores.map(function (d) { return d.opSeq })), 'Pass-2 shadow runs before Pass-3 cores')
        assert.ok(cores.every(function (d) { return d.mode === 1 }), 'inline <outline> unifies core to SDF mode 1')
        assert.strictEqual(cliWarns.length, 0, 'ModernUI fast-path tests must emit zero warnings')

        // 7. Vanilla fallback without ModernUI: lazy Text.of allocates on demand and draws via m_272191_ without error
        var vanPaints = []
        var vanTextOfCalls = 0
        var vanVboCalls = 0
        var vanWarns = []
        var vanSb = {
            console: { info: function () {}, warn: function (m) { vanWarns.push(String(m)) }, error: function (m) { vanWarns.push(String(m)) }, debug: function () {}, log: function () {} },
            ClientEvents: { loggedOut: function () {}, loggedIn: function () {}, paintScreen: function (fn) { vanPaints.push(fn) } },
            NetworkEvents: { dataReceived: function () {} },
            Java: {
                loadClass: function (cls) {
                    if (cls === 'java.lang.System') return { nanoTime: function () { return 1000000 } }
                    if (cls === 'net.minecraft.client.gui.Font$DisplayMode') return { NORMAL: 'NORMAL' }
                    if (cls === 'org.joml.Matrix4f') return MuiM4
                    return null
                }
            },
            Text: { of: function (s) { vanTextOfCalls++; return { string: String(s), getVisualOrderText: function () { return String(s) } } } },
            global: {}
        }
        vanSb.globalThis = vanSb
        vm.createContext(vanSb)
        loadStartupBase(vanSb)
        runScriptIn(vanSb, RENDERER_PATH)
        vanSb.global.ScreenDanmakuClient.push({ title: 'VanOnly', typewriter: false, shadow: false, outlineMode: 'mui_stroke', stay: 40, fadeOut: 5 })
        vanPaints[0]({
            width: 854, height: 480, level: 'minecraft:overworld',
            font: {
                width: function (s) { return String(s).length * 6 },
                m_272191_: function () { vanVboCalls++ }
            },
            graphics: { bufferSource: function () { return { flush: function () {} } }, flush: function () {} },
            getMatrix: function () { return new MuiM4() }
        })
        assert.ok(vanTextOfCalls >= 1, 'vanilla fallback lazily materializes Text.of component')
        assert.strictEqual(vanVboCalls, 9, 'mui_stroke without ModernUI cleanly falls back to 8-pass stroke ring + 1 core = 9 VBO draws')
        assert.strictEqual(vanWarns.length, 0, 'vanilla fallback must emit zero warnings')
    })

    // ----------------------------------------------------------------------------
    // 54. ScreenDanmaku v5.4: inDimension 0-player & cooldown early skip, POJO-safe malformed warning, mui_stroke & 128-group recentPos bound
    // ----------------------------------------------------------------------------
    test('ScreenDanmaku v5.4: inDimension 0-player & cooldown skip, malformed warning preserved, mui_stroke & 128-group bound', function () {
        var warns = []
        var overworld = { dimension: 'minecraft:overworld', getDimension: function () { return 'minecraft:overworld' }, players: [] }
        var nearPlayer = {
            username: 'NearP', uuid: '00000000-0000-4000-8000-0000000000e1',
            level: overworld, block: { x: 10, y: 64, z: 10 },
            x: 10, y: 64, z: 10,
            isOp: function () { return false },
            sendData: function (ch, pkt) { this._sent.push(pkt) },
            _sent: []
        }
        overworld.players = [nearPlayer]
        var srv = {
            getWorldData: function () { return { getLevelName: function () { return 'DmV54' }, getAllowCommands: function () { return true } } },
            getLevel: function (d) { return String(d) === 'minecraft:overworld' ? overworld : null },
            getAllLevels: function () { return [overworld] },
            getPlayerList: function () { return { getPlayers: function () { return [nearPlayer] } } },
            overworld: function () { return overworld }
        }
        var sb = {
            console: { info: function () {}, warn: function (m) { warns.push(String(m)) }, error: function (m) { warns.push(String(m)) }, debug: function () {}, log: function () {} },
            ServerEvents: { loaded: function (fn) { fn({ server: srv }) }, unloaded: function () {}, tick: function () {}, commandRegistry: function () {}, command: function () {} },
            PlayerEvents: { loggedIn: function () {}, loggedOut: function () {} },
            BlockEvents: { placed: function () {}, broken: function () {} },
            LevelEvents: { loaded: function () {} },
            Utils: { server: srv },
            server: srv,
            global: {}
        }
        sb.globalThis = sb
        vm.createContext(sb)
        loadServerBase(sb)
        runScriptIn(sb, DANMAKU_PATH)
        var Dm = sb.global.ScreenDanmaku

        // 1. 0 in-radius players skips packet construction & recentPos pollution cleanly
        var sent0 = Dm.inDimension(overworld, 5000, 64, 5000, 16, { text: 'FarAway', pos: 'spread', group: 'farGrp' })
        assert.strictEqual(sent0, 0)
        assert.strictEqual(nearPlayer._sent.length, 0)
        assert.strictEqual(warns.length, 0)

        // 2. Source-conflict cooldown suppression skips second inDimension packet before delivery
        var c1 = Dm.inDimension(overworld, 10, 64, 10, 32, { text: 'FirstHit', sourceId: 'bossA', cooldownMs: 5000, conflictMode: 'first' })
        var c2 = Dm.inDimension(overworld, 10, 64, 10, 32, { text: 'SecondHit', sourceId: 'bossA', cooldownMs: 5000, conflictMode: 'first' })
        assert.strictEqual(c1, 1)
        assert.strictEqual(c2, 0, 'cooldown-suppressed second call must return 0 without sending')
        assert.strictEqual(nearPlayer._sent.length, 1)

        // 3. Malformed opts preserves warning even with 0 nearby players (and handles POJO-safe check)
        Dm.inDimension(overworld, 5000, 64, 5000, 16, { sub: 'MissingTitle' })
        assert.ok(warns.some(function (w) { return w.indexOf('buildValidatedPacket') >= 0 || w.indexOf('text') >= 0 || w.length > 0 }), 'malformed opts still logs throttled warning')

        // 4. mui_stroke & sdf_stroke parse cleanly into PROTO_VERSION=5 packet
        nearPlayer._sent.length = 0
        Dm.toPlayer(nearPlayer, { text: 'MuiOut', outline: 'sdf_stroke' })
        assert.strictEqual(nearPlayer._sent.length, 1)
        assert.strictEqual(nearPlayer._sent[0].outlineMode, 'mui_stroke', 'sdf_stroke alias resolves to mui_stroke')

        // 5. Dispatching 140 distinct spread groups never overflows RECENT_POS_BY_GROUP (>128 bound)
        nearPlayer._sent.length = 0
        for (var gi = 0; gi < 140; gi++) {
            var r = Dm.toPlayer(nearPlayer, { text: 'G' + gi, group: 'grp_' + gi, pos: 'spread' })
            assert.strictEqual(r, 1)
        }
        assert.strictEqual(nearPlayer._sent.length, 140)
    })

    // ----------------------------------------------------------------------------
    // 55. P2 audit fixes: grapheme ZWJ/flags/Extend, FIFO glyph eviction, rotated tryDrawUnitBatched, a<=2 fix, Valve __proto__/getContext/at sync, late tracker upgrade & v18 fail-fast & scoped ScreenDanmaku
    // ----------------------------------------------------------------------------
    test('P2 fixes: grapheme ZWJ/flags/Extend, FIFO glyph eviction, rotated batched unit, low-alpha fidelity, Valve hardening, late tracker upgrade & v18 fail-fast & scoped ScreenDanmaku', function () {
        // Part A: Client v5.6 pure & render behavior
        function M4() { this._rotZ = []; this._m00 = 1; this._m11 = 1; this.z = 0 }
        M4.prototype.set = function (o) { this._m00 = o ? o._m00 : 1; this._m11 = o ? o._m11 : 1; this.z = o ? (o.z || 0) : 0; return this }
        M4.prototype.translate = function (dx, dy, dz) { this.z += (dz || 0); return this }
        M4.prototype.rotateZ = function (rad) { this._rotZ.push(rad); return this }
        M4.prototype.scale = function (sx, sy) { this._m00 *= sx; this._m11 *= sy; return this }
        M4.prototype.m00 = function () { return this._m00 }
        M4.prototype.m11 = function () { return this._m11 }

        var nowMs = 1000
        var paints = []
        var netHandlers = {}
        var fontWidthCalls = {}
        var rotAnglesSeen = []
        var muiAlphasSeen = []
        var fakeEngine = {
            lookupVanillaLayout: function (s) {
                return {
                    _id: String(s),
                    equals: function (o) { return Boolean(o && o._id === String(s)) },
                    hasColorEmoji: function () { return false },
                    getTotalAdvance: function () { return String(s).length * 6 },
                    drawText: function (mat, buf, x, y, r, g, b, a) {
                        muiAlphasSeen.push(a)
                        if (mat && mat._rotZ && mat._rotZ.length > 0) {
                            for (var ri = 0; ri < mat._rotZ.length; ri++) rotAnglesSeen.push(mat._rotZ[ri])
                        }
                    }
                }
            },
            getTextRenderer: function () { return { chooseMode: function () { return 1 } } }
        }
        var sb = {
            console: { info: function () {}, warn: function () {}, error: function () {}, debug: function () {}, log: function () {} },
            ClientEvents: { loggedOut: function () {}, loggedIn: function () {}, paintScreen: function (fn) { paints.push(fn) } },
            NetworkEvents: { dataReceived: function (ch, fn) { netHandlers[ch] = fn } },
            Java: {
                loadClass: function (cls) {
                    if (cls === 'java.lang.System') return { nanoTime: function () { return nowMs * 1000000 } }
                    if (cls === 'net.minecraft.client.gui.Font$DisplayMode') return { NORMAL: 'NORMAL' }
                    if (cls === 'org.joml.Matrix4f') return M4
                    if (cls === 'icyllis.modernui.mc.text.TextLayoutEngine') return { getInstance: function () { return fakeEngine } }
                    if (cls === 'icyllis.modernui.mc.text.ModernTextRenderer') return { sAllowSDFTextIn2D: true, sAllowShadow: false }
                    return null
                }
            },
            Text: { of: function (s) { return { string: String(s), getVisualOrderText: function () { return String(s) } } } },
            global: {}
        }
        sb.globalThis = sb
        vm.createContext(sb)
        loadStartupBase(sb)
        runScriptIn(sb, RENDERER_PATH)
        var Cli = sb.global.ScreenDanmakuClient

        // 1. Grapheme clusters: Extend (0301/1AB0/20D0), paired flags, ZWJ families, keycap
        var rgc = Cli._pure.readGraphemeCluster
        var gExt = rgc('e\u0301\u1AB0\u20D0X', 0)
        assert.strictEqual(gExt.cluster, 'e\u0301\u1AB0\u20D0', 'Extended combining marks stay grouped')
        assert.strictEqual(gExt.nextIndex, 4)

        var flags = '\uD83C\uDDE8\uD83C\uDDF3\uD83C\uDDFA\uD83C\uDDF8' // CN + US
        var f1 = rgc(flags, 0)
        var f2 = rgc(flags, f1.nextIndex)
        assert.strictEqual(f1.cluster, '\uD83C\uDDE8\uD83C\uDDF3', 'first flag pair grouped as 1 cluster')
        assert.strictEqual(f2.cluster, '\uD83C\uDDFA\uD83C\uDDF8', 'second flag pair does not merge into first flag')
        assert.strictEqual(f2.nextIndex, flags.length)

        var fam = '\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67' // family ZWJ
        var gFam = rgc(fam + 'A', 0)
        assert.strictEqual(gFam.cluster, fam, 'ZWJ emoji sequence stays 1 grapheme cluster')
        assert.strictEqual(gFam.nextIndex, fam.length)

        var keycap = '1\uFE0F\u20E3!'
        assert.strictEqual(rgc(keycap, 0).cluster, '1\uFE0F\u20E3', 'keycap sequence grouped')

        // 2. Rotated per_char unit passes rotation cleanly without unitRotDegSafeValue
        var ev = {
            width: 854, height: 480, level: 'minecraft:overworld',
            font: {
                width: function (s) {
                    var k = String(s)
                    fontWidthCalls[k] = (fontWidthCalls[k] || 0) + 1
                    return k.length * 6
                }
            },
            graphics: { bufferSource: function () { return { endBatch: function () {} } }, flush: function () {} },
            getMatrix: function () { return new M4() }
        }
        Cli.push({ title: 'RotTest', typewriter: false, shadow: false, shakeMode: 'per_char', charShakeStyle: 'horizontal_step', charShakeWin: 1.0, shakeAmp: 1.5, charShakeRotDeg: 18, stay: 40, fadeOut: 5 })
        for (var rf = 0; rf < 5; rf++) {
            nowMs += 50
            paints[0](ev)
        }
        assert.ok(rotAnglesSeen.some(function (rad) { return Math.abs(rad) > 0.002 }), 'per_char rotDeg propagates directly to Matrix4f.rotateZ')

        // 3. FIFO glyph cache eviction (small limit=4 preserves recently used glyph instead of wiping whole table)
        Cli.clear('*')
        paints[0](ev)
        Cli.CONFIG.glyphCacheLimit = 4
        fontWidthCalls = {}
        // Push 5 distinct chars sequentially: A, B, C, D, E -> only A evicted, E & D retained!
        Cli.push({ title: 'ABCDE', typewriter: false, shadow: false, shakeMode: 'per_char', shakeAmp: 0, letterSpacing: 1, stay: 40, fadeOut: 5 })
        paints[0](ev)
        var probesAfterFirst = fontWidthCalls['D'] || 0
        Cli.clear('*')
        paints[0](ev)
        Cli.push({ title: 'ED', typewriter: false, shadow: false, shakeMode: 'per_char', shakeAmp: 0, letterSpacing: 1, stay: 40, fadeOut: 5 })
        paints[0](ev)
        assert.strictEqual(fontWidthCalls['D'], probesAfterFirst, 'FIFO eviction keeps warm glyph D cached instead of full table wipe')

        // 4. PermissionValve v5.2: __proto__/constructor protection, null getContext() fallback, and at ISO synced with atMs
        var vWarns = []
        var cmdHook = null
        var nonOpMsgs = []
        var nonOpPlayer = {
            username: 'Peasant', uuid: '00000000-0000-4000-8000-0000000000f1',
            isOp: function () { return false },
            hasPermissions: function () { return false },
            tell: function (m) { nonOpMsgs.push(String(m)) }
        }
        nonOpPlayer.source = nonOpPlayer
        nonOpPlayer.sendSuccess = function (m) { nonOpMsgs.push(String(m)) }
        var memValveFiles = {}
        var fixedValveNow = 1700000000000
        var FakeValveDate = function (ms) {
            if (!(this instanceof FakeValveDate)) return new Date(fixedValveNow).toISOString()
            return new Date(ms !== undefined ? ms : fixedValveNow)
        }
        FakeValveDate.now = function () { return fixedValveNow }
        FakeValveDate.parse = Date.parse
        var vSrv = {
            getWorldData: function () { return { getLevelName: function () { return 'ValveV52' }, getAllowCommands: function () { return true } } },
            getPlayerList: function () { return { getPlayers: function () { return [nonOpPlayer] }, isOp: function () { return false } } }
        }
        var vsb = {
            Date: FakeValveDate,
            console: { info: function () {}, warn: function (m) { vWarns.push(String(m)) }, error: function (m) { vWarns.push(String(m)) }, debug: function () {}, log: function () {} },
            Text: { of: function (s) { return String(s) } },
            JsonIO: {
                read: function (p) { return memValveFiles[String(p)] || null },
                write: function (p, obj) { memValveFiles[String(p)] = JSON.parse(JSON.stringify(obj)) }
            },
            KubeJSPaths: {
                DIRECTORY: { getParent: function () { return 'test_game_dir' } },
                dir: function (d) { return String(d) }
            },
            ServerEvents: { loaded: function (fn) { fn({ server: vSrv }) }, unloaded: function () {}, tick: function () {}, commandRegistry: function () {}, command: function (fn) { cmdHook = fn } },
            PlayerEvents: { loggedIn: function () {}, loggedOut: function () {} },
            BlockEvents: { placed: function () {}, broken: function () {} },
            Utils: { server: vSrv },
            server: vSrv,
            global: {}
        }
        vsb.globalThis = vsb
        vm.createContext(vsb)
        loadServerBase(vsb)
        runScriptIn(vsb, VALVE_PATH)
        var Valve52 = vsb.global.EpiphyPermissionValve
        assert.strictEqual(Valve52.registerSubcommand({ name: '__proto__', permission: 'public' }), false, 'reject __proto__ subcommand name')
        assert.strictEqual(Valve52.registerSubcommand({ name: 'constructor', permission: 'public' }), false, 'reject constructor subcommand name')
        assert.strictEqual(Valve52.registerSubcommand({ name: 'toString', permission: 'public' }), false, 'reject toString subcommand name')
        assert.strictEqual(Valve52.registerSubcommand({ name: 'demo52', permission: 'admin' }), true)

        // /epiphy constructor must NOT resolve Object.prototype.constructor as a subcommand
        var ctorCancelled = false
        cmdHook({
            getInput: function () { return 'epiphy constructor' },
            getParseResults: function () { return { getContext: function () { return null } } },
            getSource: function () { return nonOpPlayer },
            cancel: function () { ctorCancelled = true }
        })
        assert.strictEqual(ctorCancelled, false, 'prototype property name constructor must NOT trigger command interception')

        // /epiphy demo52 with parseResults.getContext() === null falls back to event.getSource()
        var demoCancelled = false
        cmdHook({
            getInput: function () { return 'epiphy demo52' },
            getParseResults: function () { return { getContext: function () { return null } } },
            getSource: function () { return nonOpPlayer },
            cancel: function () { demoCancelled = true }
        })
        assert.strictEqual(demoCancelled, true, 'null parseResults.getContext() falls back to event.getSource() and intercepts')
        assert.ok(nonOpMsgs.some(function (m) { return m.indexOf('demo52') >= 0 || m.indexOf('权限') >= 0 }))

        // Revocation followed by grant at exact same Date.now() bumps both atMs AND ISO string at
        var testUid = '00000000-0000-4000-8000-0000000000f1'
        assert.strictEqual(Valve52.revokePlayer(vSrv, testUid, 'demo52', 'Console'), true)
        assert.strictEqual(Valve52.grantPlayer(vSrv, testUid, 'demo52', 'Console'), true)
        var permFileKeys = Object.keys(memValveFiles).filter(function (k) { return k.indexOf('permissions.json') >= 0 })
        assert.ok(permFileKeys.length >= 1, 'permissions.json persisted to disk store')
        var savedPerms52 = memValveFiles[permFileKeys[0]]
        var meta52 = savedPerms52.users[testUid].scopes.demo52
        assert.strictEqual(meta52.atMs, fixedValveNow + 1, 'atMs must advance past same-ms revocation tombstone')
        assert.strictEqual(Date.parse(meta52.at), meta52.atMs, 'ISO at must match bumped atMs unconditionally')

        // 5. Fallback tracker upgrades cleanly when global.EpiphyBlockTracker loads later
        var lvUp = { dimension: 'minecraft:overworld', getDimension: function () { return 'minecraft:overworld' }, players: [] }
        var upSrv = {
            getWorldData: function () { return { getLevelName: function () { return 'UpTrk' }, getAllowCommands: function () { return true } } },
            getLevel: function () { return lvUp },
            getAllLevels: function () { return [lvUp] },
            getPlayerList: function () { return { getPlayers: function () { return [] } } }
        }
        var upSb = {
            console: { info: function () {}, warn: function () {}, error: function () {}, debug: function () {}, log: function () {} },
            ServerEvents: { loaded: function (fn) { fn({ server: upSrv }) }, unloaded: function () {}, tick: function () {}, commandRegistry: function () {}, command: function () {} },
            PlayerEvents: { loggedIn: function () {}, loggedOut: function () {} },
            BlockEvents: { placed: function () {}, broken: function () {} },
            Utils: { server: upSrv },
            server: upSrv,
            global: {}
        }
        upSb.globalThis = upSb
        vm.createContext(upSb)
        loadServerBase(upSb)
        runScriptIn(upSb, DANMAKU_PATH)
        runScriptIn(upSb, AUDIO_PATH)
        var DmUp  = upSb.global.ScreenDanmaku
        var AudUp = upSb.global.EpiphyAudio
        assert.strictEqual(DmUp.bindBlock('test:late_dm', { title: 'Hi' }), true)
        assert.strictEqual(AudUp.bindBlock('test:late_au', { sound: 'minecraft:block.note_block.harp' }), true)
        assert.strictEqual(DmUp.scanBlocksNow(), 0, 'fallback tracker returns 0 for scanNow')
        assert.strictEqual(AudUp.scanBlocksNow(), 0, 'fallback audio tracker returns 0 for scanNow')

        var realBinds = []
        var realScans = []
        upSb.global.EpiphyBlockTracker = {
            createTracker: function (cfg) {
                return {
                    name: cfg.name,
                    isFallback: false,
                    bind: function (bid) { realBinds.push(cfg.name + ':' + bid); return true },
                    unbind: function () { return 0 },
                    scanNow: function () { realScans.push(cfg.name); return 7 },
                    hasBinding: function () { return false },
                    getBinding: function () { return null },
                    getBindingCount: function () { return 1 },
                    getTrackedRecords: function () { return [] },
                    destroy: function () {}
                }
            }
        }
        assert.strictEqual(DmUp.scanBlocksNow(), 7, 'ScreenDanmaku must upgrade fallback tracker when EpiphyBlockTracker appears')
        assert.strictEqual(AudUp.scanBlocksNow(), 7, 'EpiphyAudio must upgrade fallback tracker when EpiphyBlockTracker appears')
        assert.ok(realBinds.indexOf('danmaku:test:late_dm') >= 0 && realBinds.indexOf('audio:test:late_au') >= 0, 'existing bindings replay onto upgraded real trackers')

        // 6. v18 gameplay layer fail-fast when hard prerequisites are missing, and emits scoped ScreenDanmaku packets once prerequisites are loaded
        var V18_PATH = path.join(ROOT_DIR, 'kubejs', 'server_scripts', '合成表-暮色森林', '拆解台-混沌殉爆.v18.js')
        var v18MissingSb = createKubeSandbox(function (cls) {
            if (cls === 'net.minecraft.world.level.Level') return { OVERWORLD: 'minecraft:overworld', NETHER: 'minecraft:the_nether', END: 'minecraft:the_end' }
            if (cls === 'net.minecraft.world.level.Level$ExplosionInteraction') return { NONE: 'NONE', TNT: 'TNT' }
            return function () {}
        })
        v18MissingSb.ServerEvents.recipes = function () {}
        loadStartupBase(v18MissingSb)
        assert.throws(
            function () { runScriptIn(v18MissingSb, V18_PATH) },
            function (err) { return err != null && /缺少必需前置组件/.test(String(err)) },
            'v18 gameplay script must fail-fast when hard prerequisites are missing'
        )

        var v18Pkts = []
        var v18Placed = {}
        var v18Ticks = []
        var v18Player = {
            username: 'V18Pl', uuid: '00000000-0000-4000-8000-0000000000e9',
            block: { x: 0, y: 64, z: 0 },
            getX: function () { return 0 }, getY: function () { return 64 }, getZ: function () { return 0 },
            x: 0, y: 64, z: 0,
            tell: function () {},
            playSound: function () {},
            sendData: function (ch, pkt) { if (ch === 'epiphy:screen_danmaku') v18Pkts.push(pkt) }
        }
        var v18Lv = {
            dimension: 'minecraft:overworld',
            getDimension: function () { return 'minecraft:overworld' },
            players: { size: function () { return 1 }, get: function () { return v18Player } },
            getPlayers: function () { return [v18Player] },
            getBlock: function () { return { id: 'minecraft:air', set: function () {} } },
            spawnParticles: function () {},
            runCommandSilent: function () {},
            server: null
        }
        var v18Srv = {
            getWorldData: function () { return { getLevelName: function () { return 'V18Test' } } },
            getLevel: function () { return v18Lv },
            getAllLevels: function () { return [v18Lv] },
            getPlayerList: function () { return { getPlayers: function () { return [v18Player] } } },
            scheduleInTicks: function () {},
            runCommandSilent: function () {}
        }
        v18Lv.server = v18Srv
        var v18Sb = {
            console: { info: function () {}, warn: function () {}, error: function () {}, debug: function () {}, log: function () {} },
            Java: {
                loadClass: function (cls) {
                    if (cls === 'net.minecraft.world.level.Level') return { OVERWORLD: 'minecraft:overworld', NETHER: 'minecraft:the_nether', END: 'minecraft:the_end' }
                    if (cls === 'net.minecraft.world.level.Level$ExplosionInteraction') return { NONE: 'NONE', TNT: 'TNT' }
                    return function () {}
                }
            },
            ServerEvents: {
                loaded: function (fn) { fn({ server: v18Srv }) },
                unloaded: function () {},
                tick: function (fn) { v18Ticks.push(fn) },
                recipes: function () {},
                commandRegistry: function () {},
                command: function () {}
            },
            LevelEvents: { loaded: function () {}, unloaded: function () {} },
            PlayerEvents: { loggedIn: function () {}, loggedOut: function () {} },
            BlockEvents: {
                placed: function (id, fn) { v18Placed[id] = fn },
                broken: function () {},
                rightClicked: function () {}
            },
            ItemEvents: { rightClicked: function () {} },
            Text: { of: function (s) { return String(s) } },
            Utils: { server: v18Srv },
            server: v18Srv,
            global: {}
        }
        v18Sb.globalThis = v18Sb
        vm.createContext(v18Sb)
        loadServerBase(v18Sb)
        runScriptIn(v18Sb, TRACKER_PATH)
        runScriptIn(v18Sb, DANMAKU_PATH)
        runScriptIn(v18Sb, path.join(ROOT_DIR, 'kubejs', 'server_scripts', '合成表-暮色森林', '拆解台-混沌殉爆.v18.js'))
        assert.ok(typeof v18Placed['epiphy:ultra_uncrafting_instability_1'] === 'function')
        v18Placed['epiphy:ultra_uncrafting_instability_1']({
            level: v18Lv,
            block: { id: 'epiphy:ultra_uncrafting_instability_1', x: 0, y: 64, z: 0 },
            player: v18Player,
            cancel: function () {}
        })
        for (var vt = 0; vt < 10 && v18Pkts.length === 0; vt++) {
            for (var ti = 0; ti < v18Ticks.length; ti++) v18Ticks[ti]({ server: v18Srv })
        }
        assert.ok(v18Pkts.length >= 1, 'v18 sends danmaku packet via ScreenDanmaku')
        assert.strictEqual(v18Pkts[0].proto, 6, 'v18 packet must include proto:6')
        assert.strictEqual(v18Pkts[0].namespace, 'uncrafting_chaos', 'v18 packet must include uncrafting_chaos namespace')
        assert.strictEqual(v18Pkts[0].tier, 'system', 'v18 packet must carry tier:system')
        Cli.clear('*')
        paints[0](ev)
        Cli.push({ id: 'keep_other_ns', namespace: 'other_mod', group: 'banner', title: 'PROTECTED_BANNER', stay: 500 })
        var beforeCnt = Cli.count()
        netHandlers['epiphy:screen_danmaku']({ data: v18Pkts[0] })
        assert.strictEqual(Cli.count(), beforeCnt + 1, 'ScreenDanmakuClient accepts v18 packet through fail-closed dataReceived')
        // Place stage 5 near v18Player (10,64,0) and advance to climax -> clearDanmakuNear must only clear uncrafting_chaos namespace, NEVER other_mod!
        v18Placed['epiphy:ultra_uncrafting_instability_5']({
            level: v18Lv,
            block: { id: 'epiphy:ultra_uncrafting_instability_5', x: 10, y: 64, z: 0 },
            player: v18Player,
            cancel: function () {}
        })
        v18Pkts.length = 0
        for (var vt2 = 0; vt2 < 730; vt2++) {
            for (var ti2 = 0; ti2 < v18Ticks.length; ti2++) v18Ticks[ti2]({ server: v18Srv })
        }
        var clearPkts = v18Pkts.filter(function (pk) { return pk && pk.action === 'clear' })
        assert.ok(clearPkts.length >= 1, 'v18 emits clear packet on meltdown climax')
        assert.strictEqual(clearPkts[0].namespace, 'uncrafting_chaos', 'v18 clear packet MUST carry namespace:uncrafting_chaos')
        netHandlers['epiphy:screen_danmaku']({ data: clearPkts[0] })
        paints[0](ev)
        assert.ok(Cli.list().some(function (ov) { return ov.namespace === 'other_mod' }), 'v18 clear packet must NOT globally wipe other_mod danmaku')
    })

    // ----------------------------------------------------------------------------
    // 60. Epiphy2DSurface & Epiphy2DRenderer v6.0: adaptV5ToV6, aliases, quotas, tracks, patch, nodes, rect.fill, GUI/slot & v18 native progress bars
    // ----------------------------------------------------------------------------
    test('Epiphy2DSurface & Epiphy2DRenderer v6.0: adaptV5ToV6, aliases, quotas, tracks, patch, nodes, rect.fill, GUI/slot & v18 native progress bars', function () {
        var svCon = {
            warns: [],
            info: function () {},
            warn: function (m) { svCon.warns.push(String(m)) },
            error: function () {},
            debug: function () {},
            log: function () {}
        }
        var svSb = {
            console: svCon,
            Java: { loadClass: function () { return null } },
            ServerEvents: { tick: function () {}, loaded: function () {}, unloaded: function () {}, commandRegistry: function () {} },
            BlockEvents: { placed: function () {}, broken: function () {}, rightClicked: function () {} },
            PlayerEvents: { loggedIn: function () {}, loggedOut: function () {} },
            LevelEvents: { loaded: function () {}, unloaded: function () {} },
            Text: { of: function (s) { return String(s) } },
            global: {}
        }
        svSb.globalThis = svSb
        vm.createContext(svSb)
        loadServerBase(svSb)
        runScriptIn(svSb, DANMAKU_PATH)

        var Spec    = svSb.global.EpiphySpec
        var Proto   = svSb.global.EpiphyProtocol
        var Dm      = svSb.global.ScreenDanmaku
        var Surface = svSb.global.Epiphy2DSurface

        // 1. P2-4 & P1-2: Dual export and protocol compatibility (v6 accepts 5 and 6, rejects 4)
        assert.strictEqual(Surface, Dm, 'Epiphy2DSurface must alias ScreenDanmaku')
        assert.strictEqual(Dm.VERSION, '6.2.0', 'ScreenDanmaku VERSION must be 6.2.0')
        assert.strictEqual(Proto.DANMAKU_PROTO_VERSION, 6, 'DANMAKU_PROTO_VERSION must be 6')
        assert.strictEqual(Spec.isProtoCompatible(6, 6), true)
        assert.strictEqual(Spec.isProtoCompatible(6, 5), true)
        assert.strictEqual(Spec.isProtoCompatible(6, 4), false)

        // 2. P1-1: Official vs Deprecated aliases
        var depHitsBefore = Object.keys(Dm._pure.getDeprecatedAliasHits()).length
        var pktOfficial = Dm.buildPacket({
            text: 'OfficialTitle',
            subtitle: 'OfficialSub',
            id: 'off_slot',
            size: 1.5,
            tilt: 12,
            duration: 80,
            hold: 40,
            fade: 'shatter',
            fadeTicks: 16,
            outline: 'stroke',
            ns: 'test_ns'
        })
        assert.strictEqual(pktOfficial.title, 'OfficialTitle')
        assert.strictEqual(pktOfficial.sub, 'OfficialSub')
        assert.strictEqual(pktOfficial.slotId, 'off_slot')
        assert.strictEqual(pktOfficial.scale, 1.5)
        assert.strictEqual(pktOfficial.angle, 12)
        assert.strictEqual(pktOfficial.stay, 80)
        assert.strictEqual(pktOfficial.activeHold, 40)
        assert.strictEqual(pktOfficial.fadeStyle, 'shatter')
        assert.strictEqual(pktOfficial.fadeOut, 16)
        assert.strictEqual(pktOfficial.outlineMode, 'stroke')
        assert.strictEqual(pktOfficial.namespace, 'test_ns')
        assert.strictEqual(Object.keys(Dm._pure.getDeprecatedAliasHits()).length, depHitsBefore, 'official aliases must not trigger deprecated hits')

        Dm.configure({ warnDeprecatedAliases: true })
        var warnsBeforeDep = svCon.warns.length
        // Pruned DEPRECATED_DANMAKU_ALIASES retains ONLY 2 most common frozen entries: msg -> title, slot -> slotId
        assert.deepStrictEqual(Object.keys(Spec.DEPRECATED_DANMAKU_ALIASES).sort(), ['msg', 'slot'])
        var pktDep = Dm.buildPacket({
            msg:  'DeprecatedMsg',
            slot: 'dep_slot'
        })
        assert.strictEqual(pktDep.title, 'DeprecatedMsg')
        assert.strictEqual(pktDep.slotId, 'dep_slot')
        assert.ok(Dm._pure.getDeprecatedAliasHits().msg >= 1, 'deprecated alias msg must be recorded')
        assert.ok(Dm._pure.getDeprecatedAliasHits().slot >= 1, 'deprecated alias slot must be recorded')
        assert.ok(svCon.warns.length > warnsBeforeDep, 'warnDeprecatedAliases=true must emit one-time warning via LOGGER.once')
        var warnsAfterFirstDep = svCon.warns.length
        Dm.buildPacket({ msg: 'SecondDeprecatedMsg' })
        assert.strictEqual(svCon.warns.length, warnsAfterFirstDep, 'LOGGER.once must not spam repeated warnings for the same deprecated alias')
        Dm.configure({ warnDeprecatedAliases: false })

        // 3. P1-2: adaptV5ToV6 snapshot & computeOverlayCost quota enforcement
        var adapted = Spec.adaptV5ToV6({
            proto: 5,
            title: 'LegacyTitle',
            sub: 'LegacySub',
            color: 0x112233,
            subColor: 0x445566,
            typewriter: true,
            charMs: 25
        })
        assert.strictEqual(adapted.proto, 6)
        assert.strictEqual(adapted.surface, 'screen')
        assert.strictEqual(adapted.nodes.length, 2)
        assert.strictEqual(adapted.nodes[0].id, 'title')
        assert.strictEqual(adapted.nodes[0].type, 'text')
        assert.strictEqual(adapted.nodes[0].text, 'LegacyTitle')
        assert.strictEqual(adapted.nodes[0].color, 0x112233)
        assert.strictEqual(adapted.nodes[0].typewriter, true)
        assert.strictEqual(adapted.nodes[1].id, 'sub')
        assert.strictEqual(adapted.nodes[1].text, 'LegacySub')
        assert.strictEqual(adapted.nodes[1].color, 0x445566)

        // Quota: player <= 24, system <= 96
        var expensiveNodes = []
        for (var ni = 0; ni < 7; ni++) {
            expensiveNodes.push({ type: 'nine_slice', texture: 'epiphy:textures/gui/frame.png', w: 64, h: 24, slice: 4 }) // 7 * 4 = 28 > 24
        }
        assert.strictEqual(Spec.computeOverlayCost({ nodes: expensiveNodes }), 28)
        var playerRejected = Dm.buildPacket({ tier: 'player', nodes: expensiveNodes })
        assert.strictEqual(playerRejected, null, 'player tier packet with cost 28 (>24) must be rejected')
        var systemAccepted = Dm.buildPacket({ tier: 'system', nodes: expensiveNodes })
        assert.ok(systemAccepted != null && systemAccepted.cost === 28, 'system tier packet with cost 28 (<=96) must be accepted')

        // 4. P1-3, P1-4, P1-5, P2-1 ~ P2-3: Client tracks, patch coalescing & orphan drop, nodes & try/finally state recovery
        var cliNowMs = 50000
        var cliPaints = []
        var cliNetHandlers = {}
        var cliSb = {
            console: { info: function () {}, warn: function () {}, error: function () {}, debug: function () {}, log: function () {} },
            Date: { now: function () { return cliNowMs } },
            ClientEvents: { loggedOut: function () {}, loggedIn: function () {}, paintScreen: function (fn) { cliPaints.push(fn) } },
            NetworkEvents: { dataReceived: function (ch, fn) { cliNetHandlers[ch] = fn } },
            Java: { loadClass: function () { return null } },
            Text: { of: function (s) { return { string: String(s), getVisualOrderText: function () { return String(s) } } } },
            global: {}
        }
        cliSb.globalThis = cliSb
        vm.createContext(cliSb)
        loadStartupBase(cliSb)
        runScriptIn(cliSb, RENDERER_PATH)
        var Renderer = cliSb.global.Epiphy2DRenderer

        // 4a. Orphan patch must be silently dropped without creating an overlay
        Renderer.patch('non_existent_slot', { progress: 0.5 })
        var stackDepth = 0
        var scissorDepth = 0
        var fillCalls = []
        var texCalls = []
        var textCalls = []
        var mockEv = {
            width: 854, height: 480, level: 'minecraft:overworld',
            font: { width: function (s) { return String(s || '').length * 6 } },
            push: function () { stackDepth++ },
            pop: function () { stackDepth-- },
            translate: function () {},
            rotateDeg: function () {},
            scale: function () {},
            enableScissor: function () { scissorDepth++ },
            disableScissor: function () { scissorDepth-- },
            fill: function (x0, y0, x1, y1, col) { fillCalls.push({ x0: x0, y0: y0, x1: x1, y1: y1, col: col }) },
            drawTexture: function (tex, x, y, w, h, u, v, uw, vh) { texCalls.push({ tex: tex, x: x, y: y, w: w, h: h, u: u, v: v, uw: uw, vh: vh }) },
            text: function (comp, x, y, col) { textCalls.push({ text: comp && comp.string != null ? comp.string : String(comp), x: x, y: y, col: col }) }
        }
        cliPaints[0](mockEv)
        assert.strictEqual(Renderer.count(), 0, 'orphan patch must be dropped without creating an overlay')

        // 4b. Push built-in 'progress_bar' preset, queue multiple patches (in-queue coalescing), verify lerp + trail + impulse + dt <= 100ms clamp
        var panelPkt = Dm.buildPacket({
            preset: 'progress_bar',
            id: 'boss_hp',
            life: { mode: 'active', hold: 20 },
            data: { progress: 1.0 },
            barWidth: 100,
            barHeight: 6,
            text: 'BOSS $pctText',
            sub: 'Phase 1',
            tracks: {
                hitFlash: { mode: 'impulse', onChange: '$progress', peak: 1.0, decayMs: 200 }
            }
        })
        cliNetHandlers['epiphy:screen_danmaku']({ data: panelPkt })
        cliPaints[0](mockEv)
        assert.strictEqual(Renderer.count(), 1)

        // Queue 3 patches before next frame -> must coalesce in pendingActions
        Renderer.patch('boss_hp', { progress: 0.8, pctText: '80%' })
        Renderer.patch('boss_hp', { progress: 0.6, pctText: '60%' })
        Renderer.patch('boss_hp', { progress: 0.4, pctText: '40%' }, 40)
        assert.strictEqual(Renderer.count(), 2, '3 patches for same slotId must coalesce into 1 queued patch + 1 active overlay')

        // Advance by 5000ms (simulating a huge lag spike) -> dt must be clamped to <= 100ms so lerp does not overshoot/NaN, and trail waits delayMs
        cliNowMs += 50
        cliPaints[0](mockEv)
        var ov = Renderer._pure.inspectOverlays()[0]
        assert.strictEqual(ov.vars.progress, 0.4, 'coalesced patch must set target progress=0.4')
        assert.strictEqual(ov.vars.pctText, '40%', 'coalesced patch must preserve latest pctText')
        assert.ok(ov.displayVars.progress < 1.0 && ov.displayVars.progress > 0.4, 'lerp track must interpolate smoothly toward 0.4')
        assert.strictEqual(ov.displayVars.progressTrail, 1.0, 'trail track must hold at 1.0 during delayMs (220ms)')
        assert.ok(ov.displayVars.hitFlash > 0.5, 'impulse track must spike on progress change')

        // Advance past trail delayMs (220ms) and verify trail catches up
        for (var step = 0; step < 10; step++) {
            cliNowMs += 60
            cliPaints[0](mockEv)
        }
        assert.ok(ov.displayVars.progressTrail < 0.85 && ov.displayVars.progressTrail >= ov.displayVars.progress, 'trail track must smoothly catch up after delayMs')
        assert.strictEqual(ov.displayVars.hitFlash, 0.0, 'impulse track must decay back to 0 after decayMs')

        // 4c. Pure geometry clip test across all 5 directions
        var clipL = Renderer._pure.computeLocalClipRect(10, 20, 100, 10, 0, 0, 100, 10, { dir: 'left', ratio: '$p' }, { p: 0.25 })
        assert.strictEqual(clipL.x, 10)
        assert.strictEqual(clipL.w, 25)
        assert.strictEqual(clipL.uw, 25)
        var clipR = Renderer._pure.computeLocalClipRect(10, 20, 100, 10, 0, 0, 100, 10, { dir: 'right', ratio: 0.25 }, {})
        assert.strictEqual(clipR.x, 85)
        assert.strictEqual(clipR.w, 25)
        assert.strictEqual(clipR.u, 75)
        var clipC = Renderer._pure.computeLocalClipRect(0, 0, 100, 10, 0, 0, 100, 10, { dir: 'center_x', ratio: 0.5 }, {})
        assert.strictEqual(clipC.x, 25)
        assert.strictEqual(clipC.w, 50)

        // 4d. All node types (rect solid/gradient/parallax/shader, sprite, nine_slice, item, text, group) + try/finally recovery on exception
        Renderer.clear('*')
        cliPaints[0](mockEv)
        Renderer.push(Dm.buildPacket({
            id: 'complex_graph',
            nodes: [
                { id: 'r_solid', type: 'rect', w: 40, h: 8, fill: { mode: 'solid', color: 0xFF112233 } },
                { id: 'r_grad', type: 'rect', w: 40, h: 8, fill: { mode: 'gradient', dir: 'v', from: 0xFFFF0000, to: 0xFF00FF00 } },
                { id: 'r_para', type: 'rect', w: 40, h: 8, fill: { mode: 'parallax', layers: [{ tex: 'minecraft:textures/environment/end_sky.png', speedX: 0.02, speedY: -0.01, scale: 1.0, alpha: 0.8 }] } },
                { id: 'r_shd', type: 'rect', w: 40, h: 8, fill: { mode: 'shader', shaderId: 'end_portal', fallbackColor: 0xFF1A0033 } },
                { id: 's_ok', type: 'sprite', texture: 'epiphy:textures/gui/bar.png', w: 32, h: 8, clip: { dir: 'left', ratio: 0.5, mode: 'scissor' } },
                { id: 's_missing', type: 'sprite', texture: 'epiphy:textures/gui/missing_tex.png', w: 32, h: 8 },
                { id: 'ns_box', type: 'nine_slice', texture: 'epiphy:textures/gui/frame.png', w: 48, h: 20, slice: 4 },
                { id: 'it_icon', type: 'item', item: 'minecraft:nether_star', count: 1 },
                { id: 'grp', type: 'group', x: 10, y: 5, angle: 15, scale: 1.2, children: [
                    { id: 'child_txt', type: 'text', text: 'NestedText', color: 0xFFAA00 }
                ]}
            ]
        }))
        cliPaints[0](mockEv)
        assert.strictEqual(stackDepth, 0, 'pose stack must return to 0 after rendering complex graph')
        assert.strictEqual(scissorDepth, 0, 'scissor stack must return to 0 after rendering complex graph')
        assert.strictEqual(Renderer._pure.checkTextureExists('epiphy:textures/gui/missing_tex.png'), false, 'missing texture must be cached as false')

        // Now test try/finally recovery when a draw method throws mid-node!
        var throwEv = {
            width: 854, height: 480, level: 'minecraft:overworld',
            push: function () { stackDepth++ },
            pop: function () { stackDepth-- },
            translate: function () {},
            rotateDeg: function () {},
            scale: function () {},
            enableScissor: function () { scissorDepth++ },
            disableScissor: function () { scissorDepth-- },
            fill: function () { throw new Error('Simulated GL draw crash inside node') }
        }
        assert.throws(function () {
            Renderer._pure.renderDeclarativeNodes(throwEv, {}, [
                { id: 'crash_node', type: 'rect', angle: 0, scale: 1.5, w: 20, h: 10, clip: { dir: 'left', ratio: 0.5, mode: 'scissor' } }
            ], {}, 1.0, null, null, cliNowMs)
        }, /Simulated GL draw crash/)
        assert.strictEqual(stackDepth, 0, 'try/finally must pop pose stack even when draw throws')
        assert.strictEqual(scissorDepth, 0, 'try/finally must disable scissor even when draw throws')

        // 4e. Phase 2: surface='gui' & surface='slot' + replaceTextures & automatic restoration
        Renderer.clear('*')
        cliPaints[0](mockEv)
        var guiPkt = Dm.buildPacket({
            id: 'custom_uncrafting_gui',
            surface: 'gui',
            lifeMode: 'active',
            targetGui: { titleMatch: '拆解台' },
            replaceTextures: {
                'twilightforest:textures/gui/uncrafting.png': 'epiphy:textures/gui/chaos_uncrafting.png'
            },
            bgNodes: [
                { id: 'gui_bg_glow', type: 'rect', x: 88, y: 40, w: 60, h: 12, fill: { mode: 'solid', color: 0x88440066 } }
            ],
            fgNodes: [
                { id: 'gui_fg_label', type: 'text', x: 88, y: 12, text: '§d混沌谐振已激活' }
            ]
        })
        var slotPkt = Dm.buildPacket({
            id: 'chaos_slot_starfield',
            surface: 'slot',
            lifeMode: 'active',
            targetGui: { titleMatch: '拆解台' },
            slotMatch: { item: 'epiphy:chaos_relic', slotIndex: 0 },
            nodes: [
                { id: 'slot_star', type: 'rect', x: 8, y: 8, w: 16, h: 16, fill: { mode: 'parallax', layers: [{ tex: 'minecraft:textures/environment/end_sky.png', speedX: 0.03, speedY: 0.02, scale: 1.0, alpha: 0.9 }] } }
            ]
        })
        Renderer.push(guiPkt)
        Renderer.push(slotPkt)
        var preRendered = Renderer.renderGuiSurfacePass(mockEv, 'pre', {
            screen: { title: '暮色拆解台', guiLeft: 100, guiTop: 50 },
            guiLeft: 100,
            guiTop: 50
        })
        assert.strictEqual(preRendered, 1, 'renderGuiSurfacePass(pre) must render bgNodes and apply replaceTextures')
        assert.ok(Renderer._pure.getReplacedTextures()['twilightforest:textures/gui/uncrafting.png'] != null, 'replaceTextures must register active texture override')
        var slotRendered = Renderer.renderGuiSurfacePass(mockEv, 'slot', {
            screen: { title: '暮色拆解台', guiLeft: 100, guiTop: 50 },
            guiLeft: 100,
            guiTop: 50,
            slotX: 16,
            slotY: 24,
            slotIndex: 0,
            itemId: 'epiphy:chaos_relic'
        })
        assert.strictEqual(slotRendered, 1, 'renderGuiSurfacePass(slot) must render matching slot nodes')
        var postRendered = Renderer.renderGuiSurfacePass(mockEv, 'post', {
            screen: { title: '暮色拆解台', guiLeft: 100, guiTop: 50 },
            guiLeft: 100,
            guiTop: 50
        })
        assert.strictEqual(postRendered, 1, 'renderGuiSurfacePass(post) must render fgNodes')
        Renderer.restoreReplacedTextures()
        assert.strictEqual(Object.keys(Renderer._pure.getReplacedTextures()).length, 0, 'restoreReplacedTextures must clean up all texture overrides')

        // 5. P1-6: Verify 拆解台-混沌殉爆.v18.js emits native 2D graphical progress bar packets (nodes + vars + tracks + clip, zero '█'/'░')
        var v18Pkts = []
        var v18Ticks = []
        var v18Placed = {}
        var v18Player = {
            username: 'TelemetryTester',
            stringUuid: '00000000-0000-0000-0000-000000000099',
            x: 2, y: 64, z: 2,
            isSpectator: function () { return false },
            sendData: function (ch, pkt) { if (ch === 'epiphy:screen_danmaku') v18Pkts.push(pkt) },
            tell: function () {}
        }
        var v18Lv = {
            dimension: 'minecraft:overworld',
            players: [v18Player],
            getPlayers: function () { return [v18Player] },
            getBlock: function () { return { id: 'epiphy:ultra_uncrafting_instability_1', set: function () {} } },
            getEntitiesWithin: function () { return [] },
            runCommandSilent: function () {},
            spawnParticles: function () {}
        }
        var v18Srv = {
            getLevel: function () { return v18Lv },
            getPlayers: function () { return [v18Player] },
            runCommandSilent: function () {}
        }
        v18Lv.server = v18Srv
        var v18Sb = {
            console: { info: function () {}, warn: function () {}, error: function () {}, debug: function () {}, log: function () {} },
            Java: {
                loadClass: function (cls) {
                    if (cls === 'net.minecraft.world.level.Level') return { OVERWORLD: 'minecraft:overworld', NETHER: 'minecraft:the_nether', END: 'minecraft:the_end' }
                    if (cls === 'net.minecraft.world.level.Level$ExplosionInteraction') return { NONE: 'NONE', TNT: 'TNT' }
                    return function () {}
                }
            },
            ServerEvents: {
                tick: function (fn) { v18Ticks.push(fn) },
                loaded: function (fn) { fn({ server: v18Srv }) },
                unloaded: function () {},
                recipes: function () {},
                commandRegistry: function () {},
                command: function () {}
            },
            BlockEvents: {
                placed: function (id, fn) { v18Placed[id] = fn },
                broken: function () {},
                rightClicked: function () {},
                leftClicked: function () {}
            },
            ItemEvents: { rightClicked: function () {} },
            PlayerEvents: { loggedIn: function () {}, loggedOut: function () {}, tick: function () {} },
            EntityEvents: { hurt: function () {}, death: function () {} },
            LevelEvents: { loaded: function () {}, unloaded: function () {}, beforeExplosion: function () {} },
            Text: { of: function (s) { return String(s) } },
            Utils: { server: v18Srv },
            server: v18Srv,
            global: {}
        }
        v18Sb.globalThis = v18Sb
        vm.createContext(v18Sb)
        loadServerBase(v18Sb)
        runScriptIn(v18Sb, TRACKER_PATH)
        runScriptIn(v18Sb, DANMAKU_PATH)
        runScriptIn(v18Sb, path.join(ROOT_DIR, 'kubejs', 'server_scripts', '合成表-暮色森林', '拆解台-混沌殉爆.v18.js'))

        v18Placed['epiphy:ultra_uncrafting_instability_1']({
            level: v18Lv,
            block: { id: 'epiphy:ultra_uncrafting_instability_1', x: 0, y: 64, z: 0 },
            player: v18Player,
            cancel: function () {}
        })
        for (var tickIdx = 0; tickIdx < 16; tickIdx++) {
            for (var tf = 0; tf < v18Ticks.length; tf++) v18Ticks[tf]({ server: v18Srv })
        }
        var telemetryPkts = v18Pkts.filter(function (p) { return p.group === 'uncrafting_telemetry' })
        assert.ok(telemetryPkts.length >= 1, 'v18 must emit uncrafting_telemetry HUD packet')
        var tPkt = telemetryPkts[0]
        assert.strictEqual(tPkt.proto, 6)
        assert.strictEqual(tPkt.surface, 'screen')
        assert.ok(Array.isArray(tPkt.nodes) && tPkt.nodes.length >= 16, 'v18 telemetry packet must contain Scheme Alpha topological progress bar nodes')
        assert.ok(tPkt.vars != null && typeof tPkt.vars.progress === 'number', 'v18 telemetry packet must bind numeric vars.progress')
        assert.ok(tPkt.tracks != null && tPkt.tracks.progress.mode === 'lerp' && tPkt.tracks.progressTrail.mode === 'trail' && tPkt.tracks.impulse.mode === 'impulse', 'v18 telemetry packet must configure lerp + trail + impulse tracks')
        assert.strictEqual(String(tPkt.sub).indexOf('█'), -1, 'v18 telemetry subtitle must not contain legacy text progress bar character █')
        assert.strictEqual(String(tPkt.sub).indexOf('░'), -1, 'v18 telemetry subtitle must not contain legacy text progress bar character ░')
        assert.ok(tPkt.nodes.some(function (n) { return n.id === 'badge_outer' && n.fill && n.fill.mode === 'outline' }), 'v18 Scheme Alpha must include concentric outline reticle badge_outer')
        assert.ok(tPkt.nodes.some(function (n) { return n.id === 'under_ripples' && n.fill && n.fill.mode === 'parallax' && n.fill.layers[0].kind === 'ripples' }), 'v18 Scheme Alpha must include external flowing ripples layer')
        assert.ok(tPkt.nodes.some(function (n) { return n.id === 'frame_top_steps' && n.fill && n.fill.mode === 'parallax' && n.fill.layers[0].kind === 'steps' }), 'v18 Scheme Alpha must include irregular stepped top frame layer')
        assert.ok(tPkt.nodes.some(function (n) { return n.id === 'cursor_group' && n.type === 'group' && n.bind && n.bind.x && n.bind.x.var === 'progress' }), 'v18 Scheme Alpha must include track-bound T-pin cursor_group')
        assert.ok(tPkt.nodes.some(function (n) { return n.id === 'footer_right' && n.anchor === 'top_right' }), 'v18 Scheme Alpha must include right-aligned footer_right text node')
        assert.ok(tPkt.nodes.some(function (n) { return n.id === 'badge_rot_sq' && n.anchor === 'center' && n.bind && n.bind.rotSpeed === 86 }), 'v18 Scheme Alpha must include continuous rotating reticle square badge_rot_sq')
        assert.ok(tPkt.nodes.some(function (n) { return n.id === 'badge_rot_dia' && n.anchor === 'center' && n.angle === 45 && n.bind && n.bind.rotSpeed === 86 }), 'v18 Scheme Alpha must include 45-deg rotating diamond badge_rot_dia')
        assert.ok(tPkt.nodes.every(function (n) { return n.id !== 'badge_item' }), 'v18 Scheme Alpha badge reticle must not be obscured by static 16x16 badge_item')
        var v18GlassL = tPkt.nodes.find(function (n) { return n.id === 'panel_bg_l' })
        var v18GlassM = tPkt.nodes.find(function (n) { return n.id === 'panel_bg_m' })
        var v18GlassM2 = tPkt.nodes.find(function (n) { return n.id === 'panel_bg_m2' })
        var v18GlassR = tPkt.nodes.find(function (n) { return n.id === 'panel_bg_r' })
        var v18UnderR = tPkt.nodes.find(function (n) { return n.id === 'under_ripples' })
        var v18BarMain = tPkt.nodes.find(function (n) { return n.id === 'bar_main' })
        var v18BadgeIn = tPkt.nodes.find(function (n) { return n.id === 'badge_inner' })
        var v18RotSq   = tPkt.nodes.find(function (n) { return n.id === 'badge_rot_sq' })
        assert.ok(v18GlassL && ((v18GlassL.fill.color >>> 24) & 0xFF) === 0x84 && v18GlassM && v18GlassM2 && v18GlassR && v18GlassM.h !== v18GlassL.h, 'v18 stepped glass backing must keep translucent asymmetric multi-terrace silhouette')
        assert.strictEqual(v18GlassL.x + v18GlassL.w, v18GlassM.x, 'glass slab L->M must abut cleanly with zero overlap dark seam')
        assert.strictEqual(v18GlassM.x + v18GlassM.w, v18GlassM2.x, 'glass slab M->M2 must abut cleanly with zero overlap dark seam')
        assert.strictEqual(v18GlassM2.x + v18GlassM2.w, v18GlassR.x, 'glass slab M2->R must abut cleanly with zero overlap dark seam')
        assert.ok(v18GlassL.y + v18GlassL.h >= v18UnderR.y + v18UnderR.h && v18GlassM.y + v18GlassM.h >= v18UnderR.y + v18UnderR.h, 'left/center glass slabs must fully cover under_ripples')
        assert.ok(v18BadgeIn.bind.seed === v18RotSq.bind.seed && v18BadgeIn.bind.vibX === v18RotSq.bind.vibX, 'badge_inner and rotating core must share identical vib/seed so center never drifts')
        assert.ok(v18UnderR && v18UnderR.fill && Array.isArray(v18UnderR.fill.layers) && v18UnderR.fill.layers.length >= 4, 'v18 under_ripples must have multi-depth layered data/ripple stream (far ripples + mid ripples + dual-speed particles)')
        assert.ok(v18BarMain && v18BarMain.w >= 460 && (v18BarMain.w / v18BarMain.h) >= 28, 'v18 telemetry bar must keep 1:1 HTML ~472x16 (>=28:1) hairline aspect ratio')
        assert.ok(v18BarMain && (v18BarMain.fill.layers[0].mid >>> 0) === 0x26A69A, 'v18 Stage 1-3 bar gradient must keep Endfield cyan-teal #26A69A midstop')
        assert.ok(v18BarMain && (v18BarMain.fill.layers[1].color >>> 0) === 0x3D000000, 'v18 bar_main diagonal stripes must preserve 0x3D alpha byte')
        assert.ok(v18RotSq && (v18RotSq.fill.color >>> 0) === 0x26A69A, 'v18 badge_rot_sq must keep Endfield cyan-teal #26A69A fill in Stage 1')
        assert.ok(v18BadgeIn && v18BadgeIn.bind && v18BadgeIn.bind.vibX > 0 && v18BadgeIn.bind.vibY > 0, 'v18 badge_inner must enable continuous micro-vibration')
        assert.ok(tPkt.tracks && tPkt.tracks.impulse && tPkt.tracks.impulse.initPeak > 0, 'v18 impulse track must trigger entrance shock via initPeak')
        assert.ok(telemetryPkts.length >= 2, 'v18 16 ticks must emit initial full packet (t=8) and intra-stage patch (t=16)')
        var tPatch = telemetryPkts[1]
        assert.strictEqual(tPatch.action, 'patch', 'v18 intra-stage refresh at t=16 must emit lightweight action:patch')
        assert.strictEqual(tPatch.slotId, 'core_telemetry_0_64_0', 'v18 patch must target same slotId')
        assert.strictEqual(tPatch.nodes, undefined, 'v18 patch packet must NOT resend full node tree')
        assert.ok(tPatch.vars && typeof tPatch.vars.progress === 'number' && tPatch.vars.progress > tPkt.vars.progress, 'v18 patch must advance vars.progress')

        // 5b. Verify evaluateNodeBind (affine track binding + discrete stepHz modulation + impulse shake)
        var bTestNode = {
            bind: {
                x: { var: 'progress', mult: 210, offset: 0 },
                stepHz: 9,
                seed: 17,
                jitterX: 4,
                jitterW: 2,
                impulseVar: 'impulse',
                shakeY: 2.0
            }
        }
        var bEval1 = Renderer._pure.evaluateNodeBind(bTestNode, -105, 0, 10, 6, 1.0, 0.0, { progress: 0.5, impulse: 0.0 }, 1000)
        var bEval1SameStep = Renderer._pure.evaluateNodeBind(bTestNode, -105, 0, 10, 6, 1.0, 0.0, { progress: 0.5, impulse: 0.0 }, 1020)
        assert.strictEqual(bEval1.x, bEval1SameStep.x, 'stepHz=9 discrete jitter must stay constant within the same 111ms clock step')
        assert.ok(Math.abs(bEval1.x - 0) <= 4, 'at progress=0.5 (-105 + 105 = 0), bound x with jitterX=4 must be within [-4, 4], got ' + bEval1.x)
        var bEvalImpulse = Renderer._pure.evaluateNodeBind(bTestNode, -105, 0, 10, 6, 1.0, 0.0, { progress: 0.5, impulse: 1.0 }, 1035)
        assert.ok(Math.abs(bEvalImpulse.y) <= 2, 'impulse shakeY must stay bounded by amplitude')

        // 6. Real KubeJS CompoundTag/ListTag + PaintScreenEventJS pipeline verification (catching Rhino NBT typeof & 6-arg rectangle/quads)
        // Simulate KubeJS NBTUtils serialization (CompoundTag / ListTag / NumericTag / StringTag)
        function toMockNbtTag(v) {
            if (v === null || v === undefined) return null
            if (typeof v === 'boolean') return { getId: function () { return 1 }, getAsNumber: function () { return v ? 1 : 0 }, getAsDouble: function () { return v ? 1 : 0 }, getAsString: function () { return v ? '1b' : '0b' } }
            if (typeof v === 'number') return { getId: function () { return 6 }, getAsNumber: function () { return v }, getAsDouble: function () { return v }, getAsString: function () { return String(v) } }
            if (typeof v === 'string') return { getId: function () { return 8 }, getAsString: function () { return v } }
            if (Array.isArray(v)) {
                var elems = v.map(toMockNbtTag)
                return {
                    getId: function () { return 9 },
                    size: function () { return elems.length },
                    get: function (i) { return elems[i] }
                }
            }
            if (typeof v === 'object') {
                var nbtMap = {}
                Object.keys(v).forEach(function (k) { nbtMap[k] = toMockNbtTag(v[k]) })
                var keyArr = Object.keys(nbtMap)
                return {
                    getId: function () { return 10 },
                    contains: function (k) { return Object.prototype.hasOwnProperty.call(nbtMap, k) },
                    getString: function (k) { var c = nbtMap[k]; return c && c.getAsString ? String(c.getAsString()) : '' },
                    getDouble: function (k) { var c = nbtMap[k]; return (c && c.getAsNumber) ? Number(c.getAsNumber()) : 0 },
                    getBoolean: function (k) { var c = nbtMap[k]; return Boolean(c && c.getAsNumber && c.getAsNumber() !== 0) },
                    getAllKeys: function () {
                        var idx = 0
                        return {
                            iterator: function () {
                                return {
                                    hasNext: function () { return idx < keyArr.length },
                                    next: function () { return keyArr[idx++] }
                                }
                            }
                        }
                    },
                    get: function (k) { return nbtMap[k] }
                }
            }
            return null
        }

        var nbtErrors = []
        var realCliNow = 80000
        var realCliPaints = []
        var realCliNet = {}
        var realCliSb = {
            console: { info: function () {}, warn: function () {}, error: function (m) { nbtErrors.push(String(m)) }, debug: function () {}, log: function () {} },
            Date: { now: function () { return realCliNow } },
            ClientEvents: { loggedOut: function () {}, loggedIn: function () {}, paintScreen: function (fn) { realCliPaints.push(fn) } },
            NetworkEvents: { dataReceived: function (ch, fn) { realCliNet[ch] = fn } },
            Java: { loadClass: function () { return null } },
            Text: { of: function (s) { return { string: String(s), getVisualOrderText: function () { return String(s) } } } },
            global: {}
        }
        realCliSb.globalThis = realCliSb
        vm.createContext(realCliSb)
        loadStartupBase(realCliSb)
        runScriptIn(realCliSb, RENDERER_PATH)

        var progressedPkt = Dm.buildPacket({
            preset: 'progress_bar',
            id: 'real_nbt_bar',
            life: { mode: 'active', hold: 24 },
            data: { progress: 0.5 },
            barWidth: 160,
            barHeight: 6,
            barColorFrom: 0xFF3333,
            barColorTo: 0xFFAA22,
            text: '§c§l[堆芯遥测] §f50%',
            sub: '§7正在运行'
        })
        var mockRealCompound = toMockNbtTag(progressedPkt)
        realCliNet['epiphy:screen_danmaku']({ data: mockRealCompound })

        var rectDraws = []
        var vertexDraws = []
        var quadSessions = 0
        var drawnTextStrings = []
        var realPaintEv = {
            width: 854, height: 480, level: 'minecraft:overworld',
            font: { width: function (s) { return String(s || '').length * 6 } },
            graphics: {
                flush: function () {},
                enableScissor: function () {},
                disableScissor: function () {}
            },
            push: function () {},
            pop: function () {},
            translate: function () {},
            rotateDeg: function () {},
            scale: function () {},
            getMatrix: function () { return { _id: 'mat' } },
            setPositionColorShader: function () {},
            setPositionColorTextureShader: function () {},
            setShaderTexture: function () {},
            blend: function () {},
            beginQuads: function () { quadSessions++ },
            end: function () {},
            rectangle: function (x, y, z, w, h, col) {
                assert.strictEqual(arguments.length >= 6, true, 'PaintScreenEventJS.rectangle requires 6 args (x,y,z,w,h,col)')
                rectDraws.push({ x: x, y: y, z: z, w: w, h: h, col: col })
            },
            vertex: function (mat, x, y, z, col) {
                vertexDraws.push({ x: x, y: y, z: z, col: col })
            },
            text: function (comp, x, y, col) {
                assert.ok(comp != null && comp.string != null, 'fallback event.text must receive non-null Component')
                drawnTextStrings.push(String(comp.string))
            }
        }
        realCliPaints[0](realPaintEv)
        assert.strictEqual(nbtErrors.length, 0, 'CompoundTag packet + PaintScreenEventJS draw must emit zero errors: ' + nbtErrors.join(' | '))
        assert.strictEqual(realCliSb.global.Epiphy2DRenderer.count(), 1, 'CompoundTag progress packet must materialize in activeOverlays')
        var activeBarOv = realCliSb.global.Epiphy2DRenderer._pure.inspectOverlays()[0]
        assert.strictEqual(activeBarOv.hasGraphicNodes, true, 'CompoundTag progress packet must set hasGraphicNodes=true')
        assert.ok(rectDraws.length >= 5, 'bar_bg + 4 border edges + bar_trail must draw via 6-arg PaintScreenEventJS.rectangle')
        var barMainVerts = vertexDraws
        assert.strictEqual(barMainVerts.length, 4, 'bar_main horizontal gradient must draw 1 hardware quad (4 vertices)')
        var drawnBarWidth = barMainVerts[0].x - barMainVerts[1].x
        assert.ok(Math.abs(drawnBarWidth - 80) < 0.01, 'at progress=0.5 with barWidth=160, gradient quad width must be 80px, got ' + drawnBarWidth)
        assert.ok(drawnTextStrings.some(function (s) { return s.indexOf('堆芯遥测') >= 0 }), 'title text node must draw with valid Component')
        assert.ok(drawnTextStrings.some(function (s) { return s.indexOf('正在运行') >= 0 }), 'sub text node must draw with valid Component')

        // Also push the full v18 Scheme Alpha telemetry packet as a CompoundTag/ListTag and render it through PaintScreenEventJS
        var prevRectCount = rectDraws.length
        var prevVertCount = vertexDraws.length
        realCliNet['epiphy:screen_danmaku']({ data: toMockNbtTag(tPkt) })
        realCliNow += 50
        realCliPaints[0](realPaintEv)
        assert.strictEqual(nbtErrors.length, 0, 'v18 Scheme Alpha CompoundTag packet + PaintScreenEventJS draw must emit zero errors: ' + nbtErrors.join(' | '))
        assert.ok(rectDraws.length > prevRectCount + 30, 'v18 Scheme Alpha procedural ripples/steps/particles/outline must emit batched hardware quads')
        assert.ok(vertexDraws.length > prevVertCount, 'v18 Scheme Alpha procedural 3-stop gradient + plasma bloom must emit hardware vertex gradients')
        assert.ok(drawnTextStrings.some(function (s) { return s.indexOf('EF-TLM') >= 0 }), 'v18 Scheme Alpha Endfield industrial tag must render')
        assert.ok(drawnTextStrings.some(function (s) { return s.indexOf('R_ESCAPE') >= 0 }), 'v18 Scheme Alpha right-aligned footer must render')
    })

    // ----------------------------------------------------------------------------
    // 61. Schema parity, EpiphyLog deprecation control, PRIORITY_MAP pruning, GUI renderPriority layering & flush order
    // ----------------------------------------------------------------------------
    test('Schema parity, EpiphyLog deprecation control, PRIORITY_MAP pruning, GUI renderPriority & flush order', function () {
        var logCon = { warns: [], infos: [], errors: [], debugs: [] }
        var svCon2 = {
            warns: [],
            info:  function (m) { logCon.infos.push(String(m)) },
            warn:  function (m) { svCon2.warns.push(String(m)); logCon.warns.push(String(m)) },
            error: function (m) { logCon.errors.push(String(m)) },
            debug: function (m) { logCon.debugs.push(String(m)) },
            log:   function () {}
        }
        var svSb2 = {
            console: svCon2,
            Java: { loadClass: function () { return null } },
            ServerEvents: { tick: function () {}, loaded: function () {}, unloaded: function () {}, commandRegistry: function () {} },
            BlockEvents: { placed: function () {}, broken: function () {}, rightClicked: function () {} },
            PlayerEvents: { loggedIn: function () {}, loggedOut: function () {} },
            LevelEvents: { loaded: function () {}, unloaded: function () {} },
            Text: { of: function (s) { return String(s) } },
            global: {}
        }
        svSb2.globalThis = svSb2
        vm.createContext(svSb2)
        runScriptIn(svSb2, SPEC_PATH)
        runScriptIn(svSb2, LOG_PATH)
        runScriptIn(svSb2, SERVER_BASE_PATH)
        runScriptIn(svSb2, DANMAKU_PATH)

        var Spec2 = svSb2.global.EpiphySpec
        var Proto2 = svSb2.global.EpiphyProtocol
        var Log2  = svSb2.global.EpiphyLog
        var Dm2   = svSb2.global.ScreenDanmaku

        // 1. PRIORITY_MAP must contain only the 5 canonical priority names; pruned DEPRECATED_PRIORITY_ALIASES keeps ONLY 2 frozen entries
        assert.deepStrictEqual(Object.keys(Proto2.PRIORITY_MAP).sort(), ['active', 'critical', 'high', 'low', 'normal'])
        assert.deepStrictEqual(Object.keys(Proto2.DEPRECATED_PRIORITY_ALIASES).sort(), ['medium', 'urgent'])
        assert.strictEqual(Proto2.DEPRECATED_PRIORITY_ALIASES.medium, 2)
        assert.strictEqual(Proto2.DEPRECATED_PRIORITY_ALIASES.urgent, 4)

        // 2. Deprecation alerts obey EpiphyLog control when CONFIG.warnDeprecatedAliases === 'log'
        assert.strictEqual(Dm2.CONFIG.warnDeprecatedAliases, 'log', 'default warnDeprecatedAliases must delegate to EpiphyLog')
        assert.strictEqual(svCon2.warns.length, 0)
        var pSilent = Dm2.buildPacket({
            title:       'PriTestSilent',
            priority:    'medium',
            shakeMode:   'perchar',
            fadeStyle:   'defocus',
            outlineMode: 'border'
        })
        assert.strictEqual(pSilent.priority, 2)
        assert.strictEqual(pSilent.shakeMode, 'per_char')
        assert.strictEqual(pSilent.fadeStyle, 'blur')
        assert.strictEqual(pSilent.outlineMode, 'stroke')
        assert.strictEqual(svCon2.warns.length, 0, 'with EpiphyLog deprecation control off, deprecated usages emit zero warns')
        assert.ok(Dm2._pure.getDeprecatedAliasHits()['priority:medium'] >= 1, 'deprecated priority must still be counted in hits')

        // Enable deprecation warnings via EpiphyLog (e.g. /epiphy debug log deprecations on)
        Log2.setDeprecationWarnings(true)
        var wBeforeLogOn = svCon2.warns.length
        Dm2.buildPacket({
            msg:      'PriTestLogOn',
            priority: 'urgent',
            slot:     'legacy_slot_warn'
        })
        Dm2.buildPacket({ title: 'PriTestLogOn2', priority: 'urgent' })
        var wAfterLogOn = svCon2.warns.length
        assert.ok(wAfterLogOn >= wBeforeLogOn + 2, 'enabling EpiphyLog deprecation warnings must emit one-time alerts for priority/field deprecations')
        Log2.setDeprecationWarnings(false)

        // 3. Full §4.1 & §5.2 Official Aliases & Node Schema Normalization
        var fullAliasPkt = Dm2.buildPacket({
            act:      'push',
            carrier:  'gui',
            lifeMode: 'screen_session',
            zIndex:   140,
            shake:    'constant',
            texMap:   { 'twilightforest:textures/gui/uncrafting.png': 'epiphy:textures/gui/chaos_uncrafting.png' },
            targetGui:{ titleMatch: '拆解台' },
            bg: [
                { kind: 'rect', x: 10, y: 10, w: 60, h: 20, fill: { mode: 'gradient', color: 0x112233, colorEnd: 0x445566 } },
                { kind: 'nine_slice', tex: 'epiphy:textures/gui/panel.png', w: 40, h: 30, texW: 128, texH: 128, slice: [3, 5, 7, 9] }
            ],
            fg: [
                { kind: 'text', x: 20, y: 12, text: 'FG', tint: 0xAABBCC }
            ],
            layers: [
                {
                    kind: 'group', x: 0, y: 0,
                    items: [
                        { kind: 'rect', w: 32, h: 16, fill: { mode: 'shader', shader: 'end_portal', fallbackColor: 0x120024 } },
                        { kind: 'sprite', tex: 'epiphy:textures/gui/icon.png', w: 16, h: 16, texW: 64, texH: 64, tint: 0xFF8844 }
                    ]
                }
            ]
        })
        assert.ok(fullAliasPkt != null)
        assert.strictEqual(fullAliasPkt.surface, 'gui')
        assert.strictEqual(fullAliasPkt.lifeMode, 'screen_session')
        assert.strictEqual(fullAliasPkt.renderPriority, 140)
        assert.strictEqual(fullAliasPkt.shakeMode, 'constant')
        assert.ok(fullAliasPkt.replaceTextures['twilightforest:textures/gui/uncrafting.png'])
        assert.strictEqual(fullAliasPkt.bgNodes[0].fill.mode, 'gradient')
        assert.strictEqual(fullAliasPkt.bgNodes[0].fill.dir, 'v', 'gradient with color/colorEnd defaults to vertical')
        assert.strictEqual(fullAliasPkt.bgNodes[0].fill.from, 0x112233)
        assert.strictEqual(fullAliasPkt.bgNodes[0].fill.to, 0x445566)
        assert.deepStrictEqual(Array.from(fullAliasPkt.bgNodes[1].slice), [3, 5, 7, 9], 'nine_slice.slice number[4] must be preserved')
        assert.strictEqual(fullAliasPkt.bgNodes[1].tw, 128)
        assert.strictEqual(fullAliasPkt.fgNodes[0].type, 'text')
        assert.strictEqual(fullAliasPkt.fgNodes[0].color >>> 0, 0x00AABBCC)
        assert.strictEqual(fullAliasPkt.nodes[0].type, 'group')
        assert.strictEqual(fullAliasPkt.nodes[0].children[0].fill.shader, 'end_portal')
        assert.strictEqual(fullAliasPkt.nodes[0].children[1].tw, 64)

        var wpPkt = Dm2.buildPacket({
            carrier: 'world_plane',
            at:      [10, 70, -5],
            facing:  'fixed',
            xray:    true,
            layers:  [{ kind: 'text', text: 'HI' }]
        })
        assert.deepStrictEqual(Array.from(wpPkt.worldPos), [10, 70, -5])
        assert.strictEqual(wpPkt.billboard, 'fixed')
        assert.strictEqual(wpPkt.seeThrough, true)
        assert.strictEqual(wpPkt.renderPriority, 0)

        // 4. Client GUI renderPriority ordering, nine_slice[4], registerShader / vanilla end_portal, flush order & screen_session lifecycle
        var cliNow2 = 50000
        var cliWarns2 = []
        var cliPaints2 = []
        var fakeScrOpen = { title: '暮色拆解台', guiLeft: 10, guiTop: 10 }
        var curActiveScr = fakeScrOpen
        var cliSb2 = {
            console: { info: function () {}, warn: function (m) { cliWarns2.push(String(m)) }, error: function (m) { throw new Error(m) }, debug: function () {}, log: function () {} },
            Date: { now: function () { return cliNow2 } },
            Client: { getCurrentScreen: function () { return curActiveScr } },
            ClientEvents: { loggedOut: function () {}, loggedIn: function () {}, paintScreen: function (fn) { cliPaints2.push(fn) } },
            NetworkEvents: { dataReceived: function () {} },
            Java: {
                loadClass: function (cls) {
                    if (cls === 'net.minecraft.client.renderer.RenderType') {
                        return { endPortal: function () { return { _rt: 'end_portal' } } }
                    }
                    return null
                }
            },
            Text: { of: function (s) { return { string: String(s), getVisualOrderText: function () { return String(s) } } } },
            global: {}
        }
        cliSb2.globalThis = cliSb2
        vm.createContext(cliSb2)
        loadStartupBase(cliSb2)
        runScriptIn(cliSb2, RENDERER_PATH)

        var R2 = cliSb2.global.Epiphy2DRenderer
        var customShaderHits = 0
        R2.registerShader('custom_nebula', function () { customShaderHits++; return true })
        // High eviction priority (10) declarative screen HUD defaults to hudRenderPriority = 50 (> plain danmaku 0, < GUI default 100)
        var scrPktPlain   = Dm2.buildPacket({ id: 'scr_plain', surface: 'screen', priority: 10, title: 'PLAIN_DANMAKU' })
        var scrPktHighPri = Dm2.buildPacket({ id: 'scr_high_pri', surface: 'screen', priority: 10, showInGui: true, layers: [{ kind: 'text', x: 0, y: 0, scale: 0.7, text: 'DANMAKU_TEXT' }] })
        var guiPktDefPri  = Dm2.buildPacket({ id: 'gui_def_pri', surface: 'gui', lifeMode: 'screen_session', targetGui: { titleMatch: '拆解台' }, bg: [{ kind: 'nine_slice', tex: 'epiphy:textures/gui/panel.png', x: 0, y: 0, w: 60, h: 40, texW: 128, texH: 128, slice: [3, 5, 7, 9] }], layers: [{ kind: 'rect', x: 0, y: 0, w: 40, h: 20, fill: { mode: 'shader', shader: 'end_portal' } }, { kind: 'rect', x: 0, y: 20, w: 10, h: 10, fill: { mode: 'shader', shader: 'custom_nebula' } }, { kind: 'text', x: 0, y: -8, scale: 0.65, text: 'BADGE_TAG' }, { kind: 'rect', x: 8, y: -8, w: 8, h: 6, color: 0xFFFFFFFF }] })
        var scrPktTopPri  = Dm2.buildPacket({ id: 'scr_top_override', surface: 'screen', renderPriority: 300, showInGui: true, layers: [{ kind: 'rect', x: 0, y: 0, w: 12, h: 12, color: 0xFF00FF00 }] })

        assert.strictEqual(scrPktPlain.renderPriority, 0)
        assert.strictEqual(scrPktHighPri.renderPriority, 50)
        assert.strictEqual(guiPktDefPri.renderPriority, 100)
        assert.strictEqual(scrPktTopPri.renderPriority, 300)

        R2.push(scrPktTopPri)
        R2.push(guiPktDefPri)
        R2.push(scrPktHighPri)

        var drawSeq = []
        var ev2 = {
            width: 854, height: 480, level: 'minecraft:overworld',
            font: { width: function (s) { return String(s || '').length * 6 } },
            graphics: {
                flush: function () { drawSeq.push('graphics.flush') },
                fill: function (rt, x0, y0, x1, y1) { drawSeq.push('shader:' + rt._rt) },
                blit: function (rl, rx, ry, rw, rh) { drawSeq.push('blit:' + rw + 'x' + rh) }
            },
            push: function () {}, pop: function () {}, translate: function () {}, rotateDeg: function () {}, scale: function () {},
            getMatrix: function () { return {} },
            setPositionColorShader: function () {},
            setPositionColorTextureShader: function () {},
            setShaderTexture: function () {},
            blend: function () {},
            beginQuads: function () {},
            end: function () {},
            rectangle: function (x, y, z, w, h, col) { drawSeq.push('rect:' + Math.round(w) + 'x' + Math.round(h)) },
            text: function (comp) { drawSeq.push('text:' + comp.string) }
        }
        cliPaints2[0](ev2)
        var idxDanmaku = drawSeq.indexOf('text:DANMAKU_TEXT')
        var idxShader  = drawSeq.indexOf('shader:end_portal')
        var idxBadgeT  = drawSeq.indexOf('text:BADGE_TAG')
        var idxFlushAfterBadgeT = drawSeq.indexOf('graphics.flush', idxBadgeT)
        var idxMaskRect = drawSeq.indexOf('rect:8x6')
        var idxTopRect  = drawSeq.indexOf('rect:12x12')

        assert.ok(idxDanmaku >= 0 && idxShader > idxDanmaku, 'GUI (renderPriority=100) must render AFTER screen danmaku (renderPriority=0) even if danmaku priority=10')
        assert.ok(idxBadgeT >= 0 && idxFlushAfterBadgeT > idxBadgeT && idxMaskRect > idxFlushAfterBadgeT, 'graphics.flush() must run after scaled text BADGE_TAG before rect mask 8x6 draws on top')
        assert.ok(idxTopRect > idxMaskRect, 'explicit renderPriority=300 must override GUI default 100 and draw last (on top)')
        assert.ok(drawSeq.some(function (s) { return s.indexOf('rect:3x5') === 0 || s.indexOf('blit:3x5') === 0 }), 'nine_slice with [3,5,7,9] must draw asymmetric 3x5 corner without NaN')
        assert.strictEqual(customShaderHits, 1, 'custom registered shader must execute cleanly via registerShader')

        // Closing GUI automatically expires screen_session overlays
        curActiveScr = null
        cliNow2 += 50
        cliPaints2[0](ev2)
        assert.strictEqual(R2.list().some(function (it) { return it.slotId === 'gui_def_pri' }), false, 'screen_session GUI overlay must auto-expire when target GUI closes')

        // ScreenDanmakuClient native v6 push/patch/deactivate/clear
        var Cli2 = cliSb2.global.ScreenDanmakuClient
        Cli2.clear('*')
        cliNow2 += 50
        cliPaints2[0](ev2)
        assert.strictEqual(Cli2.count(), 0)
        Cli2.push({
            slotId: 'cli_v6_slot',
            group: 'cli_v6_g',
            lifeMode: 'active',
            activeHold: 40,
            vars: { msg: 'INIT_V6' },
            nodes: [{ id: 't1', type: 'text', text: '$msg', color: 0xFFFFFFFF }]
        })
        cliNow2 += 50
        cliPaints2[0](ev2)
        assert.strictEqual(Cli2.list().some(function (it) { return it.slotId === 'cli_v6_slot' }), true, 'ScreenDanmakuClient.push must accept native v6 node payload without manual proto/action')
        Cli2.patch('cli_v6_slot', { msg: 'PATCHED_V6' }, 40)
        drawSeq.length = 0
        cliNow2 += 50
        cliPaints2[0](ev2)
        assert.ok(drawSeq.indexOf('text:PATCHED_V6') >= 0, 'ScreenDanmakuClient.patch must emit native v6 patch updating $msg')
        Cli2.deactivate('cli_v6_slot', 2)
        cliNow2 += 50
        cliPaints2[0](ev2)
        var afterDeactItem = Cli2.list().filter(function (it) { return it.slotId === 'cli_v6_slot' })[0]
        assert.ok(afterDeactItem != null && afterDeactItem.lifeMode === 'once', 'ScreenDanmakuClient.deactivate must emit native v6 deactivate transitioning active -> once')
        cliNow2 += 600
        cliPaints2[0](ev2)
        assert.strictEqual(Cli2.list().some(function (it) { return it.slotId === 'cli_v6_slot' }), false, 'deactivated v6 overlay must expire after fadeOut')
    })

    test('62. 32-bit ARGB alpha preservation, bind.rotSpeed continuous rotation, and smooth diagonal stripes', function () {
        var sb = {
            console: { info: function () {}, warn: function () {}, error: function () {}, debug: function () {}, log: function () {} },
            Date: { now: function () { return 10000 } },
            Java: { loadClass: function () { return null } },
            ServerEvents: { tick: function () {}, loaded: function () {}, unloaded: function () {}, commandRegistry: function () {} },
            BlockEvents: { placed: function () {}, broken: function () {}, rightClicked: function () {} },
            PlayerEvents: { loggedIn: function () {}, loggedOut: function () {} },
            LevelEvents: { loaded: function () {}, unloaded: function () {} },
            Text: { of: function (s) { return String(s) } },
            global: {}
        }
        sb.globalThis = sb
        vm.createContext(sb)
        runScriptIn(sb, SPEC_PATH)
        runScriptIn(sb, LOG_PATH)
        runScriptIn(sb, SERVER_BASE_PATH)
        runScriptIn(sb, DANMAKU_PATH)

        var Spec = sb.global.EpiphySpec
        var Dm = sb.global.ScreenDanmaku

        // 24-bit default parseColor compatibility preserved, parseArgbColor keeps high alpha byte
        assert.strictEqual(Spec.parseColor(0x3D112233, 0xFFFFFF).color, 0x112233)
        assert.strictEqual(Spec.parseArgbColor(0x3D000000, 0xFFFFFFFF).color >>> 0, 0x3D000000)
        assert.strictEqual(Spec.parseArgbColor('#4DFFFFFF', 0xFFFFFFFF).color >>> 0, 0x4DFFFFFF)
        assert.strictEqual(Spec.parseArgbColor(0x780A1218, 0xFFFFFFFF).color >>> 0, 0x780A1218)

        // buildPacket preserves alpha in node fills, borders, parallax layers & progress panels
        var pkt = Dm.buildPacket({
            id: 'argb_rot_test',
            surface: 'screen',
            priority: 'active',
            nodes: [
                { id: 'glass', type: 'rect', anchor: 'top_left', x: 0, y: 0, w: 60, h: 20, fill: { mode: 'solid', color: 0x780A1218 } },
                {
                    id: 'bar', type: 'rect', anchor: 'top_left', x: 0, y: 0, w: 80, h: 12,
                    fill: {
                        mode: 'parallax', bgAlpha: 0,
                        layers: [
                            { kind: 'stripes', step: 16, width: 5, skew: 6, speedX: 18, color: 0x3D000000, alpha: 1.0 },
                            { kind: 'ripples', rows: 2, color: 0x4DFFFFFF, altColor: '#29FFFFFF', alpha: 1.0 }
                        ]
                    }
                },
                { id: 'rot_sq', type: 'rect', anchor: 'center', x: 20, y: 20, w: 9, h: 9, angle: 45, fill: { mode: 'solid', color: 0x80FFFFFF }, bind: { rotSpeed: 86 } }
            ]
        })
        assert.strictEqual(pkt.nodes[0].fill.color >>> 0, 0x780A1218, 'solid glass alpha 0x78 must survive buildPacket')
        assert.strictEqual(pkt.nodes[1].fill.layers[0].color >>> 0, 0x3D000000, 'stripe shadow alpha 0x3D must survive buildPacket')
        assert.strictEqual(pkt.nodes[1].fill.layers[0].skew, 6, 'stripe skew must pass through sanitizeParallaxLayers')
        assert.strictEqual(pkt.nodes[1].fill.layers[1].color >>> 0, 0x4DFFFFFF, 'ripple hex alpha 0x4D must survive buildPacket')
        assert.strictEqual(pkt.nodes[1].fill.layers[1].altColor >>> 0, 0x29FFFFFF, 'ripple string #AARRGGBB alpha 0x29 must survive buildPacket')
        assert.strictEqual(pkt.nodes[2].bind.rotSpeed, 86, 'bind.rotSpeed must survive sanitizeNodeBind')

        // Client: evaluateNodeBind rotSpeed + smooth diagonal stripe slices + preserved alpha in emitted quads
        var cliNow3 = 500
        var cliPaints3 = []
        var cliSb3 = {
            console: { info: function () {}, warn: function () {}, error: function (m) { throw new Error(m) }, debug: function () {}, log: function () {} },
            Date: { now: function () { return cliNow3 } },
            Client: { getCurrentScreen: function () { return null } },
            ClientEvents: { loggedOut: function () {}, loggedIn: function () {}, paintScreen: function (fn) { cliPaints3.push(fn) } },
            NetworkEvents: { dataReceived: function () {} },
            Java: { loadClass: function () { return null } },
            Text: { of: function (s) { return { string: String(s) } } },
            global: {}
        }
        cliSb3.globalThis = cliSb3
        vm.createContext(cliSb3)
        loadStartupBase(cliSb3)
        runScriptIn(cliSb3, RENDERER_PATH)

        var R3 = cliSb3.global.Epiphy2DRenderer
        var bound500 = R3._pure.evaluateNodeBind(pkt.nodes[2], 20, 20, 9, 9, 1.0, 45, {}, 500)
        assert.strictEqual(bound500.angle, 88, 'angle 45 + rotSpeed 86 deg/s at 500ms must equal 88 deg')

        R3.push(pkt)
        var rotAngles = []
        var rectCalls = []
        var ev3 = {
            width: 854, height: 480, level: 'minecraft:overworld',
            font: { width: function () { return 20 } },
            graphics: { flush: function () {} },
            push: function () {}, pop: function () {}, translate: function () {},
            rotateDeg: function (deg) { rotAngles.push(deg) },
            scale: function () {},
            getMatrix: function () { return {} },
            setPositionColorShader: function () {},
            blend: function () {},
            beginQuads: function () {},
            end: function () {},
            rectangle: function (x, y, z, w, h, col) { rectCalls.push({ w: w, h: h, col: col >>> 0 }) },
            text: function () {}
        }
        cliPaints3[0](ev3)
        assert.ok(rotAngles.indexOf(88) >= 0, 'rotSpeed node must invoke event.rotateDeg(88) during paint')
        assert.ok(rectCalls.some(function (r) { return r.col === 0x780A1218 }), 'glass rect must pass translucent 0x780A1218 ARGB to event.rectangle')
        var stripeRects = rectCalls.filter(function (r) { return r.col === 0x3D000000 })
        assert.ok(stripeRects.length >= 12, 'diagonal stripes with alpha 0x3D must render multi-slice thin ribs instead of 2 chunky blocks')
        assert.ok(stripeRects.every(function (r) { return r.h < 3.0 }), 'each diagonal stripe slice must be thin (<3px), never halfH chunky block')

        // Large epoch timestamp (Date.now() = 1.795e12) must NOT quantize/freeze float32 rotateDeg or stall vibX/vibY
        var epochNow = 1795039370000
        var cliSb4 = {
            console: { info: function () {}, warn: function () {}, error: function (m) { throw new Error(m) }, debug: function () {}, log: function () {} },
            Date: { now: function () { return epochNow } },
            Client: { getCurrentScreen: function () { return null } },
            ClientEvents: { loggedOut: function () {}, loggedIn: function () {}, paintScreen: function () {} },
            NetworkEvents: { dataReceived: function () {} },
            Java: { loadClass: function () { return null } },
            Text: { of: function (s) { return { string: String(s) } } },
            global: {}
        }
        cliSb4.globalThis = cliSb4
        vm.createContext(cliSb4)
        loadStartupBase(cliSb4)
        runScriptIn(cliSb4, RENDERER_PATH)
        var R4 = cliSb4.global.Epiphy2DRenderer
        var rotNode = { bind: { rotSpeed: 86, vibX: 0.55, vibY: 0.45, vibHz: 22, seed: 29 } }
        var evA = R4._pure.evaluateNodeBind(rotNode, 10, 10, 8, 8, 1.0, 0, {}, epochNow + 100)
        var evB = R4._pure.evaluateNodeBind(rotNode, 10, 10, 8, 8, 1.0, 0, {}, epochNow + 250)
        assert.ok(evA.angle >= 0 && evA.angle < 360 && evB.angle >= 0 && evB.angle < 360, 'epoch rotSpeed angle must stay normalized within [0, 360)')
        assert.ok(Math.abs(Math.fround(evB.angle) - Math.fround(evA.angle)) > 5.0, 'float32-rounded angle must advance crisply under epoch Date.now() instead of freezing at 16384-deg steps')
        assert.ok(Math.abs(evA.x - 10) > 0.01 && Math.abs(evB.x - evA.x) > 0.01, 'vibX micro-vibration must oscillate smoothly without Math.round stalling')
    })

    test('63. v6.1/v5.8/v2.5 preset & widget registry, UI DSL, bounded cache pool, and renderer hot-path optimizations', function () {
        // 1. EpiphySpec.createBoundedCache FIFO eviction + createPresetRegistry cross-stage sharing
        var sb = {
            console: { info: function () {}, warn: function () {}, error: function (m) { throw new Error(m) }, debug: function () {}, log: function () {} },
            ServerEvents: { loaded: function () {}, tick: function () {}, commandRegistry: function () {} },
            BlockEvents: { placed: function () {}, broken: function () {} },
            PlayerEvents: { loggedIn: function () {}, loggedOut: function () {} },
            Java: { loadClass: function () { return null } },
            global: {}
        }
        sb.globalThis = sb
        vm.createContext(sb)
        loadStartupBase(sb)
        var Spec = sb.global.EpiphySpec

        var bc = Spec.createBoundedCache(3)
        bc.set('a', 1); bc.set('b', 2); bc.set('c', 3); bc.set('d', 4)
        assert.strictEqual(bc.size(), 3, 'bounded cache must enforce maxSize')
        assert.strictEqual(bc.has('a'), false, 'bounded cache must evict oldest FIFO key a')
        assert.strictEqual(bc.get('d'), 4)
        bc.set('b', 22)
        assert.strictEqual(bc.get('b'), 22)
        bc.clear()
        assert.strictEqual(bc.size(), 0)

        // Register presets in startup phase via EpiphySpec.registerPreset BEFORE loading server scripts
        assert.strictEqual(Spec.registerPreset('surface', 'startup_banner', {
            pos: [0.5, 0.2], color: 0x00FFAA, duration: 60, group: 'cross_stage'
        }), true)
        assert.strictEqual(Spec.registerPreset('audio', 'startup_sfx', {
            sound: 'minecraft:entity.experience_orb.pickup', category: 'MASTER', volume: 0.9, range: 48
        }), true)
        assert.strictEqual(Spec.registerPreset('world_ops', 'startup_purge', {
            padding: 12, loops: 5, syncInitRadius: 0, excludeLava: true
        }), true)

        runScriptIn(sb, SERVER_BASE_PATH)
        runScriptIn(sb, TRACKER_PATH)
        runScriptIn(sb, DANMAKU_PATH)
        runScriptIn(sb, AUDIO_PATH)

        var Surface = sb.global.Epiphy2DSurface
        var Audio   = sb.global.EpiphyAudio
        var WorldOps = sb.global.EpiphyWorldOps

        // 2. Cross-stage surface preset + custom widget + compact ui() builder + rect.outline shorthand
        var crossPkt = Surface.buildPacket({ preset: 'startup_banner', text: 'CrossStageOK' })
        assert.ok(crossPkt && crossPkt.title === 'CrossStageOK' && crossPkt.group === 'cross_stage', 'surface buildPacket must resolve startup-registered preset')

        assert.strictEqual(Surface.registerWidget('test_badge', function (n, ui) {
            return ui({ ox: n.x, oy: n.y })
                .outline('tb_outer', 0, 0, n.size || 20, n.size || 20, n.color || 0xFFFFFF, 1)
                .corners(0, 0, n.size || 20, n.size || 20, 4, 1, 0xFFD54F, 'tl,br')
                .build()
        }), true)

        assert.strictEqual(Surface.registerPreset('hud_demo', function (c, h) {
            var nodes = h.ui()
                .steppedPlate(-100, 0x80102030, [
                    ['p0', 60, -10, 20],
                    ['p1', 80, -8,  18],
                    ['p2', 60, -6,  16]
                ])
                .steppedLine(-100, 22, [[90, 0, 0xFFFFFF, 1], [110, 4, 0x4DD0E1, 1]])
                .ticks(-100, 0, 200, 12, [0.25, 0.5, 0.75], 0x44FFFFFF, 1, 'tk')
                .widget('test_badge', { x: -130, y: -6, size: 24, color: 0x00FFFF })
                .push({ id: 'raw_out', type: 'rect', x: 10, y: 0, w: 12, h: 12, outline: 0xFF5555, thickness: 2 })
                .build()
            return {
                surface: 'screen',
                id:      c.id || 'demo',
                data:    { progress: c.progress || 0.5 },
                nodes:   nodes,
                tracks:  h.progressTracks()
            }
        }), true)

        var demoPkt = Surface.buildPacket({ preset: 'hud_demo', id: 'hud_1', progress: 0.75 })
        assert.ok(demoPkt && Array.isArray(demoPkt.nodes), 'function preset with ui() + widget must build valid v6 packet')
        var p0 = demoPkt.nodes.find(function (n) { return n.id === 'p0' })
        var p1 = demoPkt.nodes.find(function (n) { return n.id === 'p1' })
        var p2 = demoPkt.nodes.find(function (n) { return n.id === 'p2' })
        assert.strictEqual(p0.x + p0.w, p1.x, 'ui.steppedPlate must abut p0->p1 with zero overlap')
        assert.strictEqual(p1.x + p1.w, p2.x, 'ui.steppedPlate must abut p1->p2 with zero overlap')
        assert.ok(demoPkt.nodes.some(function (n) { return n.id === 'tb_outer' && n.fill && n.fill.mode === 'outline' }), 'registered widget must expand during sanitizeNodesList')
        assert.ok(demoPkt.nodes.some(function (n) { return n.id === 'tk_50' && n.x === 0 }), 'ui.ticks must generate 50% tick at x=0')
        var rawOutNode = demoPkt.nodes.find(function (n) { return n.id === 'raw_out' })
        assert.ok(rawOutNode && rawOutNode.fill && rawOutNode.fill.mode === 'outline' && rawOutNode.fill.thickness === 2, 'raw rect.outline shorthand must normalize to outline fill')

        // 3. Audio & WorldOps preset resolution
        var audResolved = Audio.preset('startup_sfx', { pitch: 1.25 })
        assert.ok(audResolved && audResolved.sound === 'minecraft:entity.experience_orb.pickup' && audResolved.volume === 0.9 && audResolved.pitch === 1.25, 'EpiphyAudio.preset must resolve startup-registered audio preset with overrides')
        assert.strictEqual(Audio.registerPreset('boss_hit', { sound: 'minecraft:entity.generic.explode', priority: 'critical' }), true)
        assert.ok(Audio.listPresets().indexOf('boss_hit') >= 0)

        var woResolved = WorldOps.preset('startup_purge', { isRimOnlySweep: true })
        assert.ok(woResolved && woResolved.padding === 12 && woResolved.excludeLava === true && woResolved.isRimOnlySweep === true, 'EpiphyWorldOps.preset must resolve startup-registered world_ops preset')

        // 4. Client renderer: contiguous solid/outline rect batching + parallax early-cull + text width cache & left-anchor skip
        var cliPaints = []
        var cliNetCb  = null
        var nowVal    = 10000
        var cliSb = {
            console: { info: function () {}, warn: function () {}, error: function (m) { throw new Error(m) }, debug: function () {}, log: function () {} },
            Date: { now: function () { return nowVal } },
            Client: { getCurrentScreen: function () { return null } },
            ClientEvents: { loggedOut: function () {}, loggedIn: function () {}, paintScreen: function (fn) { cliPaints.push(fn) } },
            NetworkEvents: { dataReceived: function (ch, fn) { if (ch === 'epiphy:screen_danmaku') cliNetCb = fn } },
            Java: { loadClass: function () { return null } },
            Text: { of: function (s) { return { string: String(s) } } },
            global: {}
        }
        cliSb.globalThis = cliSb
        vm.createContext(cliSb)
        loadStartupBase(cliSb)
        runScriptIn(cliSb, RENDERER_PATH)

        var batchNodes = []
        for (var ri = 0; ri < 8; ri++) {
            batchNodes.push({ id: 'sr_' + ri, type: 'rect', anchor: 'top_left', x: ri * 10, y: 0, w: 8, h: 8, fill: { mode: 'solid', color: 0xFF33AAFF } })
        }
        batchNodes.push({ id: 'or_0', type: 'rect', anchor: 'top_left', x: 0, y: 12, w: 20, h: 10, fill: { mode: 'outline', color: 0xFFFFFFFF, thickness: 1 } })
        batchNodes.push({ id: 'or_1', type: 'rect', anchor: 'top_left', x: 24, y: 12, w: 20, h: 10, fill: { mode: 'outline', color: 0xFFFFAA00, thickness: 1 } })
        batchNodes.push({ id: 'tl_txt', type: 'text', anchor: 'top_left', x: 0, y: 30, scale: 1.0, text: 'LEFT_LABEL', color: 0xFFFFFFFF, shadow: true })
        batchNodes.push({ id: 'tr_txt', type: 'text', anchor: 'top_right', x: 100, y: 30, scale: 1.0, text: '$dynRight', color: 0xFFFFFFFF, shadow: true })

        cliNetCb({
            data: {
                proto: 6, surface: 'screen', id: 'batch_test', key: 'batch_test',
                lifeMode: 'active', activeHold: 100, rx: 0.5, ry: 0.5, scale: 1.0, tilt: 0,
                vars: { dynRight: 'RIGHT_A' },
                nodes: batchNodes
            }
        })

        var beginCount = 0, endCount = 0, quadCount = 0, fontWidthCalls = 0
        var mockEv = {
            width: 854, height: 480, level: 'minecraft:overworld',
            font: { width: function (s) { var str = String(s); if (str === 'LEFT_LABEL' || str === 'RIGHT_A' || str === 'RIGHT_UPDATED') fontWidthCalls++; return str.length * 6 } },
            graphics: { flush: function () {} },
            push: function () {}, pop: function () {}, translate: function () {}, rotateDeg: function () {}, scale: function () {},
            getMatrix: function () { return {} },
            setPositionColorShader: function () {},
            blend: function () {},
            beginQuads: function () { beginCount++ },
            end: function () { endCount++ },
            rectangle: function () { quadCount++ },
            text: function () {}
        }
        // Frame 1: 8 solid + 2 outline (4 edges each) = 16 quads emitted inside ONE single beginQuads/end batch!
        cliPaints[0](mockEv)
        assert.strictEqual(beginCount, 1, '10 contiguous solid/outline rect nodes must coalesce into 1 beginQuads batch, got ' + beginCount)
        assert.strictEqual(endCount, 1, 'coalesced rect batch must close cleanly with 1 end()')
        assert.strictEqual(quadCount, 16, '8 solid + 2x4 outline edges must emit all 16 quads')
        assert.strictEqual(fontWidthCalls, 1, 'top_left text must skip font.width (0 calls); only top_right calls font.width once')

        // Frame 2 with unchanged dynRight: top_right hits per-node width cache -> 0 additional font.width calls!
        nowVal += 50
        cliPaints[0](mockEv)
        assert.strictEqual(fontWidthCalls, 1, 'unchanged top_right text must hit per-node width cache (still 1 call total)')

        // Frame 3 after action:'patch' mutates dynRight: cache invalidates -> 1 new font.width call!
        cliNetCb({ data: { proto: 6, surface: 'screen', action: 'patch', id: 'batch_test', vars: { dynRight: 'RIGHT_UPDATED' } } })
        nowVal += 50
        cliPaints[0](mockEv)
        assert.strictEqual(fontWidthCalls, 2, 'mutated top_right text must invalidate cache and re-measure once')

        // 5. Parallax early-culling at low progress (10px wide clip on 472px bar)
        var lowQuads = 0, fullQuads = 0
        var mkParallaxEv = function (counterFn) {
            return {
                width: 854, height: 480, level: 'minecraft:overworld',
                font: { width: function () { return 20 } },
                graphics: { flush: function () {} },
                push: function () {}, pop: function () {}, translate: function () {}, rotateDeg: function () {}, scale: function () {},
                getMatrix: function () { return {} }, setPositionColorShader: function () {}, blend: function () {},
                beginQuads: function () {}, end: function () {},
                rectangle: function () { counterFn() }, text: function () {}
            }
        }
        var pFill = {
            mode: 'parallax', bgAlpha: 0,
            layers: [
                { kind: 'stripes', step: 18, width: 7, skew: 7, speedX: 20, color: 0x3D000000, alpha: 0.95 },
                { kind: 'ripples', rows: 4, rowGap: 3.4, offsetY: 1.2, segments: 7, baseLen: 26, ampLen: 14, speedX: 34, thickness: 1.1, seed: 23, color: 0x52FFFFFF, alpha: 0.95 }
            ]
        }
        cliNetCb({ data: { proto: 6, surface: 'screen', action: 'clear', group: '*', maxPriority: 10 } })
        cliNetCb({
            data: {
                proto: 6, surface: 'screen', id: 'p_cull', key: 'p_cull', lifeMode: 'active', activeHold: 100, rx: 0.5, ry: 0.5, scale: 1.0,
                vars: { p: 0.02 },
                nodes: [{ id: 'pm', type: 'rect', anchor: 'top_left', x: -236, y: -7, w: 472, h: 14, clip: { dir: 'left', ratio: '$p', mode: 'local' }, fill: pFill }]
            }
        })
        cliPaints[0](mkParallaxEv(function () { lowQuads++ }))
        cliNetCb({ data: { proto: 6, surface: 'screen', action: 'patch', id: 'p_cull', vars: { p: 1.0 } } })
        nowVal += 50
        cliPaints[0](mkParallaxEv(function () { fullQuads++ }))
        assert.ok(lowQuads > 0 && lowQuads * 4 < fullQuads, 'parallax early-cull at 2% width must emit <25% of full-bar quads (low=' + lowQuads + ', full=' + fullQuads + ')')
    })

    test('64. v6.2 LRU cache, controlled deep merge, grouped options, unknown-key warn, channel/slot, openJsonStore & node precompilation', function () {
        var warns = []
        var sentPkts = []
        var mockPlayer = {
            username: 'tester',
            x: 0, y: 64, z: 0,
            sendData: function (ch, pkt) { sentPkts.push({ ch: ch, pkt: pkt }) }
        }
        var mockLevel = {
            dimension: 'minecraft:overworld',
            players: [mockPlayer]
        }
        var srvObj = {
            getLevel: function () { return mockLevel },
            getAllLevels: function () { return [mockLevel] }
        }
        var diskFiles = {}
        var sb = {
            console: { info: function () {}, warn: function (m) { warns.push(String(m)) }, error: function (m) { throw new Error(m) }, debug: function () {}, log: function () {} },
            ServerEvents: { loaded: function (fn) { fn({ server: srvObj }) }, tick: function () {}, commandRegistry: function () {} },
            BlockEvents: { placed: function () {}, broken: function () {} },
            PlayerEvents: { loggedIn: function () {}, loggedOut: function () {} },
            JsonIO: {
                readString: function (p) { return Object.prototype.hasOwnProperty.call(diskFiles, p) ? diskFiles[p] : null },
                write: function (p, obj) { diskFiles[p] = JSON.stringify(obj) }
            },
            Java: { loadClass: function () { return null } },
            global: {}
        }
        sb.globalThis = sb
        vm.createContext(sb)
        loadServerBase(sb)
        runScriptIn(sb, TRACKER_PATH)
        runScriptIn(sb, DANMAKU_PATH)

        var Spec    = sb.global.EpiphySpec
        var Base    = sb.global.EpiphyServerCore
        var Surface = sb.global.Epiphy2DSurface

        // 1. LRU cache eviction vs FIFO
        var lru = Spec.createBoundedCache(3, 'lru')
        assert.strictEqual(lru.policy(), 'lru')
        lru.set('a', 1); lru.set('b', 2); lru.set('c', 3)
        assert.strictEqual(lru.get('a'), 1) // refreshes 'a' to MRU -> 'b' is now LRU
        lru.set('d', 4)
        assert.strictEqual(lru.has('a'), true, 'LRU must retain recently accessed key a')
        assert.strictEqual(lru.has('b'), false, 'LRU must evict least-recently-used key b')
        assert.strictEqual(lru.size(), 3)

        // 2. mergeTracksMap (same-mode merge, mode-switch replace, explicit disable) & mergeGroupedOptions
        var trMerged = Spec.mergeTracksMap(
            {
                progress:    { mode: 'lerp', speed: 10, easing: 'out_cubic' },
                subProgress: { mode: 'lerp', speed: 12, easing: 'out_cubic' },
                impulse:     { mode: 'impulse', onChange: '$progress', peak: 1.0, decayMs: 260 }
            },
            {
                progress:    { speed: 25 },
                subProgress: false,
                impulse:     { mode: 'trail', target: '$progress', speed: 5 }
            }
        )
        assert.strictEqual(trMerged.progress.mode, 'lerp', 'same-mode track override must preserve mode')
        assert.strictEqual(trMerged.progress.easing, 'out_cubic', 'same-mode track override must preserve easing')
        assert.strictEqual(trMerged.progress.speed, 25, 'same-mode track override must update speed')
        assert.strictEqual(trMerged.subProgress, undefined, 'false/null track override must disable track')
        assert.strictEqual(trMerged.impulse.mode, 'trail', 'mode-switch override must replace track')
        assert.strictEqual(trMerged.impulse.decayMs, undefined, 'mode-switch override must not leak old mode fields')

        // 3. buildProgressPanel removed; built-in 'progress_bar' preset + grouped options + unknown-key warn
        assert.strictEqual(Surface.buildProgressPanel, undefined, 'legacy buildProgressPanel must be removed in v6.2')
        assert.ok(Surface.listPresets().indexOf('progress_bar') >= 0, 'progress_bar built-in preset must be registered')

        Surface.registerPreset('grouped_card', {
            layout: { pos: [0.3, 0.2], scale: 0.8 },
            life:   { mode: 'active', hold: 30, fade: 'blur', fadeOut: 12 },
            data:   { hp: 1.0, label: 'INIT' },
            tracks: Surface.progressTracks()
        })
        var gPkt = Surface.buildPacket({
            preset: 'grouped_card',
            title:  'Card',
            life:   { hold: 50 },
            data:   { hp: 0.5 },
            tracks: { progress: { speed: 18 } }
        })
        assert.strictEqual(gPkt.rx, 0.3, 'grouped preset layout.pos must flatten to rx')
        assert.strictEqual(gPkt.scale, 0.8, 'grouped preset layout.scale must flatten to scale')
        assert.strictEqual(gPkt.lifeMode, 'active', 'grouped preset life.mode must be preserved across sparse life override')
        assert.strictEqual(gPkt.activeHold, 50, 'sparse life.hold override must win')
        assert.strictEqual(gPkt.vars.hp, 0.5, 'sparse data override must merge into vars')
        assert.strictEqual(gPkt.vars.label, 'INIT', 'preset data.label must be preserved on sparse data merge')
        assert.strictEqual(gPkt.tracks.progress.mode, 'lerp', 'sparse track override must preserve mode')
        assert.strictEqual(gPkt.tracks.progress.speed, 18, 'sparse track override must apply speed')

        warns.length = 0
        var typoPkt = Surface.buildPacket({ text: 'Hello', barWdith: 999 })
        assert.ok(typoPkt && typoPkt.barWdith === undefined, 'unknown key must not enter network packet')
        assert.ok(warns.some(function (w) { return w.indexOf('barWdith') >= 0 }), 'unknown packet key must emit one-time typo warning')

        // 4. ui() id-first + .texts() + .region() returning to parent origin
        var uNodes = Surface.ui({ ox: 10, oy: 20 })
            .boxes([['b1', 0, 0, 10, 5, 0xFFFFFFFF]])
            .region(100, 50, function (r) {
                r.texts([['r_txt', 5, 2, 'SUB', 1.0, 0xFF00FF00]])
            })
            .text('after_reg', 1, 2, 'BACK', 1.0, 0xFFFFFFFF)
            .build()
        assert.strictEqual(uNodes[0].id, 'b1')
        assert.strictEqual(uNodes[1].id, 'r_txt')
        assert.strictEqual(uNodes[1].x, 115, 'region must offset child x by ox+dx+x')
        assert.strictEqual(uNodes[2].id, 'after_reg')
        assert.strictEqual(uNodes[2].x, 11, 'after region, parent builder must remain at original ox')

        // 5. channel() + stateful slot() auto full/patch/variant/resync/close
        sentPkts.length = 0
        var ch = Surface.channel({ namespace: 'test_ns', group: 'test_grp', resyncTicks: 20 })
        var sl = ch.slot('hud_a', { preset: 'progress_bar', resyncTicks: 20 })
        sl.syncNear(mockLevel, 0, 64, 0, 32, { variant: 'v1', tick: 0, data: { progress: 0.2 }, text: 'A', life: { mode: 'active', hold: 20 } })
        sl.syncNear(mockLevel, 0, 64, 0, 32, { variant: 'v1', tick: 5, data: { progress: 0.4 }, life: { hold: 20 } })
        sl.syncNear(mockLevel, 0, 64, 0, 32, { variant: 'v2', tick: 10, data: { progress: 0.6 }, text: 'B', life: { mode: 'active', hold: 20 } })
        sl.syncNear(mockLevel, 0, 64, 0, 32, { variant: 'v2', tick: 35, data: { progress: 0.8 }, text: 'C', life: { mode: 'active', hold: 20 } })
        sl.closeNear(mockLevel, 0, 64, 0, 32, 10)
        assert.strictEqual(sentPkts.length, 5)
        assert.strictEqual(sentPkts[0].pkt.action, 'push', 'first slot.syncNear must emit full push')
        assert.strictEqual(sentPkts[0].pkt.namespace, 'test_ns')
        assert.strictEqual(sentPkts[1].pkt.action, 'patch', 'same-variant within resyncTicks must emit lightweight patch')
        assert.strictEqual(sentPkts[1].pkt.vars.progress, 0.4)
        assert.strictEqual(sentPkts[2].pkt.action, 'push', 'variant change must re-emit full push')
        assert.strictEqual(sentPkts[3].pkt.action, 'push', 'elapsed >= resyncTicks must re-emit full push')
        assert.strictEqual(sentPkts[4].pkt.action, 'deactivate', 'slot.closeNear must emit deactivate')

        // 6. EpiphyServerCore.openJsonStore missing default + corrupt write-lock
        var stMissing = Base.openJsonStore('test/missing.json', { defaultData: function () { return { v: 1 } } })
        var mRes = stMissing.load()
        assert.strictEqual(mRes.status, 'missing')
        assert.strictEqual(mRes.data.v, 1)
        assert.strictEqual(stMissing.save({ v: 2 }), true)
        assert.strictEqual(stMissing.load().data.v, 2)

        diskFiles['test/corrupt.json'] = '{ broken json'
        var stCorrupt = Base.openJsonStore('test/corrupt.json', { lockOnCorrupt: true })
        var cRes = stCorrupt.load()
        assert.strictEqual(cRes.status, 'corrupt')
        assert.strictEqual(stCorrupt.isCorrupt(), true)
        assert.strictEqual(stCorrupt.save({ v: 0 }), false, 'corrupt lock must refuse non-forced overwrite')
        assert.strictEqual(stCorrupt.save({ v: 9 }, { force: true }), true, 'force:true must override corrupt lock')
        assert.strictEqual(stCorrupt.isCorrupt(), false)

        // 7. Client node tree precompilation + stepHz micro-cache + SHARED_TEXT_SEQ_CACHE LRU
        var cliPaints = []
        var cliNetCb  = null
        var cNow      = 5000
        var cliSb = {
            console: { info: function () {}, warn: function () {}, error: function (m) { throw new Error(m) }, debug: function () {}, log: function () {} },
            Date: { now: function () { return cNow } },
            Client: { getCurrentScreen: function () { return null } },
            ClientEvents: { loggedOut: function () {}, loggedIn: function () {}, paintScreen: function (fn) { cliPaints.push(fn) } },
            NetworkEvents: { dataReceived: function (chName, fn) { if (chName === 'epiphy:screen_danmaku') cliNetCb = fn } },
            Java: { loadClass: function () { return null } },
            Text: { of: function (s) { return { string: String(s) } } },
            global: {}
        }
        cliSb.globalThis = cliSb
        vm.createContext(cliSb)
        loadStartupBase(cliSb)
        runScriptIn(cliSb, RENDERER_PATH)
        var R62 = cliSb.global.Epiphy2DRenderer

        var rawStaticNodes = [
            { id: 's1', type: 'rect', anchor: 'top_left', x: 10, y: 20, w: 40, h: 10, fill: { mode: 'solid', color: 0x8026A69A } },
            { id: 's2', type: 'rect', anchor: 'center',   x: 50, y: 50, w: 20, h: 10, fill: { mode: 'outline', color: 0xFFFFFFFF, thickness: 1 } },
            { id: 'd1', type: 'rect', anchor: 'top_left', x: 0,  y: 0,  w: 8,  h: 8,  fill: { mode: 'solid', color: 0xFFFFFFFF }, bind: { stepHz: 9, seed: 17, jitterX: 4 } }
        ]
        R62._pure.compileDeclarativeNodes(rawStaticNodes, 0)
        assert.strictEqual(rawStaticNodes[0]._c.isStaticFastRect, true, 'static solid rect must compile to isStaticFastRect fast path')
        assert.strictEqual(rawStaticNodes[1]._c.isStaticFastRect, true, 'static outline rect must compile to isStaticFastRect fast path')
        assert.strictEqual(rawStaticNodes[1]._c.x0, 40, 'center-anchored static rect must precompute x0 = x - w/2')
        assert.strictEqual(rawStaticNodes[2]._c.isStaticFastRect, false, 'bound node must not take static fast path')

        // Verify stepHz micro-cache populates and updates across step boundaries
        var evStep1 = R62._pure.evaluateNodeBind(rawStaticNodes[2], 0, 0, 8, 8, 1.0, 0.0, {}, 1000)
        var cachedTick = rawStaticNodes[2].bind._lastStepTick
        var evStep2 = R62._pure.evaluateNodeBind(rawStaticNodes[2], 0, 0, 8, 8, 1.0, 0.0, {}, 1010)
        assert.strictEqual(rawStaticNodes[2].bind._lastStepTick, cachedTick, 'same 9Hz step must hit stepHz micro-cache')
        assert.strictEqual(evStep1.x, evStep2.x)
    })

    test('65. v6.2.1 audit fixes: preset+action patch, progress_bar style/typo, KNOWN_PACKET_KEYS source parity, slot tick rewind & text/gradient precompile', function () {
        var warns = []
        var sentPkts = []
        var mockPlayer = {
            username: 'audit_tester',
            x: 0, y: 64, z: 0,
            sendData: function (ch, pkt) { sentPkts.push({ ch: ch, pkt: pkt }) }
        }
        var mockLevel = { dimension: 'minecraft:overworld', players: [mockPlayer] }
        var srvObj = {
            getLevel: function () { return mockLevel },
            getAllLevels: function () { return [mockLevel] }
        }
        var sb = {
            console: { info: function () {}, warn: function (m) { warns.push(String(m)) }, error: function (m) { throw new Error(m) }, debug: function () {}, log: function () {} },
            ServerEvents: { loaded: function (fn) { fn({ server: srvObj }) }, tick: function () {}, commandRegistry: function () {} },
            BlockEvents: { placed: function () {}, broken: function () {} },
            PlayerEvents: { loggedIn: function () {}, loggedOut: function () {} },
            Java: { loadClass: function () { return null } },
            global: {}
        }
        sb.globalThis = sb
        vm.createContext(sb)
        loadServerBase(sb)
        runScriptIn(sb, TRACKER_PATH)
        runScriptIn(sb, DANMAKU_PATH)

        var Surface = sb.global.Epiphy2DSurface

        // 1. preset + action:'patch' skips preset expansion, preserves action:'patch', flattens data & life.hold, and warns once
        warns.length = 0
        var patchWithPreset = Surface.buildPacket({
            preset: 'progress_bar',
            action: 'patch',
            id:     'hp_bar',
            life:   { hold: 40 },
            data:   { progress: 0.55 }
        })
        assert.strictEqual(patchWithPreset.action, 'patch', 'preset + action:patch must NOT silently drop action and turn into push')
        assert.strictEqual(patchWithPreset.slotId, 'hp_bar')
        assert.strictEqual(patchWithPreset.vars.progress, 0.55)
        assert.strictEqual(patchWithPreset.activeHold, 40)
        assert.strictEqual(patchWithPreset.nodes, undefined, 'patch packet must not carry preset nodes')
        assert.ok(warns.some(function (w) { return w.indexOf('preset="progress_bar"') >= 0 }), 'passing preset with control action must emit clear warning')

        // 2. progress_bar honors grouped style:{ color, shadow } on title node & catches barWdith typo
        warns.length = 0
        var styledBar = Surface.buildPacket({
            preset:   'progress_bar',
            title:    'SHIELD',
            style:    { color: 0x00FF00, shadow: false },
            data:     { progress: 0.7 },
            barWdith: 320
        })
        assert.strictEqual(styledBar.action, 'push')
        var titleNode = styledBar.nodes.filter(function (n) { return n.id === 'title' })[0]
        assert.ok(titleNode, 'progress_bar must generate title text node')
        assert.strictEqual(titleNode.color, 0x00FF00, 'progress_bar title node must inherit style.color')
        assert.strictEqual(titleNode.shadow, false, 'progress_bar title node must inherit style.shadow')
        assert.ok(warns.some(function (w) { return w.indexOf('barWdith') >= 0 }), 'typo passed to progress_bar preset must trigger warning')

        // 3. Previously missing valid keys must NOT trigger unknownPacketKey warnings + static source parity check
        warns.length = 0
        var legitPkt = Surface.buildPacket({
            text:          'Bold Scale Shake',
            boldTarget:    'Bold',
            scaleTarget:   'Scale',
            shakeTarget:   'Shake',
            charShakeFreq: 120,
            jitter:        true,
            perCharShake:  true
        })
        assert.ok(legitPkt && legitPkt.title.indexOf('<b>Bold</b>') >= 0, 'boldTarget must still wrap target substring')
        assert.strictEqual(warns.filter(function (w) { return w.indexOf('未知渲染参数') >= 0 }).length, 0, 'valid parser keys must not trigger unknownPacketKey warnings')

        var surfaceSrc = fs.readFileSync(DANMAKU_PATH, 'utf8')
        var knownKeys = Surface._pure.KNOWN_PACKET_KEYS
        var fnSection = surfaceSrc.slice(surfaceSrc.indexOf('function resolvePosition(opts)'), surfaceSrc.indexOf('function sendSinglePlayerPacket('))
        var missingKeys = []
        var seenChecked = Object.create(null)
        var dotRe = /\bopts\.([A-Za-z][A-Za-z0-9_]*)\b/g
        var m
        while ((m = dotRe.exec(fnSection)) !== null) {
            var k = m[1]
            if (seenChecked[k] || k.charAt(0) === '_') continue
            seenChecked[k] = true
            if (!knownKeys[k]) missingKeys.push(k)
        }
        var pickRe = /\bpick(?:NonEmpty)?\s*\(\s*opts\s*,\s*\[([^\]]+)\]/g
        while ((m = pickRe.exec(fnSection)) !== null) {
            var listStr = m[1]
            var strRe = /'([A-Za-z][A-Za-z0-9_]*)'/g
            var sm
            while ((sm = strRe.exec(listStr)) !== null) {
                var pk = sm[1]
                if (seenChecked[pk] || pk.charAt(0) === '_') continue
                seenChecked[pk] = true
                if (!knownKeys[pk]) missingKeys.push(pk)
            }
        }
        assert.deepStrictEqual(missingKeys, [], 'every opts.* / pick(opts, [...]) key read by packet builder must be present in KNOWN_PACKET_KEYS')

        // 4. channel.slot().syncNear() triggers full push on tick rewind
        sentPkts.length = 0
        var ch = Surface.channel({ namespace: 'ns_rw', group: 'g_rw', resyncTicks: 30 })
        var sl = ch.slot('s_rw', { preset: 'progress_bar', resyncTicks: 30 })
        sl.syncNear(mockLevel, 0, 64, 0, 32, { variant: 'v1', tick: 100, data: { progress: 0.5 }, text: 'T1' })
        sl.syncNear(mockLevel, 0, 64, 0, 32, { variant: 'v1', tick: 110, data: { progress: 0.6 } })
        sl.syncNear(mockLevel, 0, 64, 0, 32, { variant: 'v1', tick: 5,   data: { progress: 0.1 }, text: 'T2' })
        assert.strictEqual(sentPkts[0].pkt.action, 'push')
        assert.strictEqual(sentPkts[1].pkt.action, 'patch')
        assert.strictEqual(sentPkts[2].pkt.action, 'push', 'tick rewind (5 < 100) must re-emit full push instead of stalling resync')

        // 5. Client precompiler parses string colors and precompiles NT_TEXT & FM_GRADIENT
        var cliSb = {
            console: { info: function () {}, warn: function () {}, error: function (m) { throw new Error(m) }, debug: function () {}, log: function () {} },
            Date: { now: function () { return 1000 } },
            Client: { getCurrentScreen: function () { return null } },
            ClientEvents: { loggedOut: function () {}, loggedIn: function () {}, paintScreen: function () {} },
            NetworkEvents: { dataReceived: function () {} },
            Java: { loadClass: function () { return null } },
            Text: { of: function (s) { return { string: String(s) } } },
            global: {}
        }
        cliSb.globalThis = cliSb
        vm.createContext(cliSb)
        loadStartupBase(cliSb)
        runScriptIn(cliSb, RENDERER_PATH)
        var R = cliSb.global.Epiphy2DRenderer

        var nodesToCompile = [
            { id: 'hex_rect', type: 'rect', anchor: 'top_left', x: 0, y: 0, w: 20, h: 10, fill: { mode: 'solid', color: '#FFAA22' } },
            { id: 'grad_rect', type: 'rect', anchor: 'top_left', x: 0, y: 0, w: 100, h: 10, fill: { mode: 'gradient', dir: 'v', from: '#112233', mid: '#445566', to: 'gold' } },
            { id: 'txt_static', type: 'text', anchor: 'top_right', x: 50, y: 10, text: 'STATIC', color: '#00FF88' },
            { id: 'txt_dyn', type: 'text', anchor: 'top_left', x: 0, y: 0, text: '$pct', color: '$col' }
        ]
        R._pure.compileDeclarativeNodes(nodesToCompile, 0)
        assert.strictEqual(nodesToCompile[0]._c.staticFillArgb >>> 0, 0xFFFFAA22, 'hex string color must compile to 0xFFFFAA22 instead of white')
        assert.strictEqual(nodesToCompile[1]._c.gradDir, 'v')
        assert.strictEqual(nodesToCompile[1]._c.gradStaticFrom >>> 0, 0xFF112233)
        assert.strictEqual(nodesToCompile[1]._c.gradStaticMid >>> 0, 0xFF445566)
        assert.strictEqual(nodesToCompile[1]._c.gradStaticTo >>> 0, 0xFFFFAA00, 'named color gold in gradient must compile to 0xFFFFAA00')
        assert.strictEqual(nodesToCompile[2]._c.textHasVar, false)
        assert.strictEqual(nodesToCompile[2]._c.isTopAnchor, true)
        assert.strictEqual(nodesToCompile[2]._c.isRightAnchor, true)
        assert.strictEqual(nodesToCompile[2]._c.needWidthMeasure, true)
        assert.strictEqual(nodesToCompile[2]._c.staticTextArgb >>> 0, 0xFF00FF88)
        assert.strictEqual(nodesToCompile[3]._c.textHasVar, true)
        assert.strictEqual(nodesToCompile[3]._c.hasVarTextCol, true)
        assert.strictEqual(nodesToCompile[3]._c.needWidthMeasure, false)
    })

    test('66. v6.2.2 strict corrupt lock + quarantine backup & HUD renderPriority/priority draw order + Z-layer isolation', function () {
        var warns = []
        var diskFiles = {}
        var sb = {
            console: { info: function () {}, warn: function (m) { warns.push(String(m)) }, error: function (m) { throw new Error(m) }, debug: function () {}, log: function () {} },
            ServerEvents: { loaded: function () {}, tick: function () {}, commandRegistry: function () {} },
            BlockEvents: { placed: function () {}, broken: function () {} },
            PlayerEvents: { loggedIn: function () {}, loggedOut: function () {} },
            JsonIO: {
                readString: function (p) { return Object.prototype.hasOwnProperty.call(diskFiles, p) ? diskFiles[p] : null },
                write: function (p, obj) { diskFiles[p] = JSON.stringify(obj) }
            },
            Java: { loadClass: function () { return null } },
            global: {}
        }
        sb.globalThis = sb
        vm.createContext(sb)
        loadServerBase(sb)
        runScriptIn(sb, TRACKER_PATH)
        runScriptIn(sb, DANMAKU_PATH)

        var Base    = sb.global.EpiphyServerCore
        var Surface = sb.global.Epiphy2DSurface

        // 1. openJsonStore strict corrupt lock & quarantine backup before write
        diskFiles['qtest/unstable.json'] = '{ broken_original_records: [1,2,3'
        var stStrict = Base.openJsonStore('qtest/unstable.json', { lockOnCorrupt: true })
        assert.strictEqual(stStrict.load().status, 'corrupt')
        assert.strictEqual(stStrict.isCorrupt(), true)
        // Non-empty payload WITHOUT force/quarantine must STILL be refused (no silent overwrite of corrupt file)
        assert.strictEqual(stStrict.save({ version: 2, jobs: [{ x: 1 }] }), false, 'corrupt lock must refuse even non-empty save without quarantine/force')
        assert.strictEqual(diskFiles['qtest/unstable.json'], '{ broken_original_records: [1,2,3', 'corrupt file must remain untouched on disk')

        // With { quarantine: true }, corrupt raw file must be backed up to *.corrupt.*.bak BEFORE writing new payload
        assert.strictEqual(stStrict.save({ version: 2, jobs: [{ x: 9 }] }, { quarantine: true }), true, 'quarantine:true must backup corrupt file and save new payload')
        assert.strictEqual(stStrict.isCorrupt(), false)
        var qBackupKeys = Object.keys(diskFiles).filter(function (k) { return k.indexOf('qtest/unstable.json.corrupt.') === 0 && k.slice(-4) === '.bak' })
        assert.strictEqual(qBackupKeys.length, 1, 'exactly one .corrupt.<stamp>.bak backup must be created')
        assert.ok(diskFiles[qBackupKeys[0]].indexOf('broken_original_records') >= 0, 'quarantine backup must preserve original corrupt content')
        assert.strictEqual(JSON.parse(diskFiles['qtest/unstable.json']).jobs[0].x, 9)

        // 2. Server default renderPriority ladder: screen text (0) < screen declarative HUD (50) < gui (100) < slot (200)
        var pText = Surface.buildPacket({ text: 'NormalDanmaku' })
        var pHud  = Surface.buildPacket({ preset: 'progress_bar', title: 'HUD', data: { progress: 0.5 } })
        var pGui  = Surface.buildPacket({ surface: 'gui', nodes: [{ id: 'g', type: 'rect', x: 0, y: 0, w: 10, h: 10, color: 0xFFFFFFFF }] })
        var pSlot = Surface.buildPacket({ surface: 'slot', nodes: [{ id: 's', type: 'rect', x: 0, y: 0, w: 10, h: 10, color: 0xFFFFFFFF }] })
        var pOv   = Surface.buildPacket({ preset: 'progress_bar', title: 'CustomZ', zIndex: 12 })
        assert.strictEqual(pText.renderPriority, 0, 'plain screen danmaku must default to renderPriority 0')
        assert.strictEqual(pHud.renderPriority, 50, 'declarative HUD / progress_bar must default to hudRenderPriority 50')
        assert.strictEqual(pGui.renderPriority, 100, 'gui surface must default to renderPriority 100')
        assert.strictEqual(pSlot.renderPriority, 200, 'slot surface must default to renderPriority 200')
        assert.strictEqual(pOv.renderPriority, 12, 'explicit zIndex/renderPriority must still override default')

        // 3. Client draw order: low-pri danmaku -> high-pri danmaku -> HUD progress bar (with flush + Z-layer translate)
        var cliPaints = []
        var cliNetCb  = null
        var cNow      = 1000
        var cliSb = {
            console: { info: function () {}, warn: function () {}, error: function (m) { throw new Error(m) }, debug: function () {}, log: function () {} },
            Date: { now: function () { return cNow } },
            Client: { getCurrentScreen: function () { return null } },
            ClientEvents: { loggedOut: function () {}, loggedIn: function () {}, paintScreen: function (fn) { cliPaints.push(fn) } },
            NetworkEvents: { dataReceived: function (chName, fn) { if (chName === 'epiphy:screen_danmaku') cliNetCb = fn } },
            Java: { loadClass: function () { return null } },
            Text: { of: function (s) { return { string: String(s) } } },
            global: {}
        }
        cliSb.globalThis = cliSb
        vm.createContext(cliSb)
        loadStartupBase(cliSb)
        runScriptIn(cliSb, RENDERER_PATH)

        // Push HUD bar FIRST (oldest born, active priority 5, no explicit renderPriority -> client defaults to 50)
        cliNetCb({
            data: {
                proto: 6, surface: 'screen', id: 'hud_bar', lifeMode: 'active', priority: 5, activeHold: 100, rx: 0.27, ry: 0.14, scale: 0.56,
                nodes: [{ id: 'bar_bg', type: 'rect', anchor: 'top_left', x: 0, y: 0, w: 100, h: 10, fill: { mode: 'solid', color: 0xFFAA0000 } }]
            }
        })
        cNow += 100
        // Push high-priority danmaku SECOND
        cliNetCb({ data: { proto: 6, surface: 'screen', title: 'HI_DANMAKU', priority: 5, stay: 100, rx: 0.3, ry: 0.2 } })
        cNow += 100
        // Push low-priority danmaku LAST (newest born)
        cliNetCb({ data: { proto: 6, surface: 'screen', title: 'LO_DANMAKU', priority: 2, stay: 100, rx: 0.3, ry: 0.2 } })

        var drawOps = []
        var poseZHistory = []
        var curPoseZ = 0
        var poseStack = []
        var mockEv = {
            width: 854, height: 480, level: 'minecraft:overworld',
            font: { width: function () { return 40 } },
            graphics: {
                flush: function () { drawOps.push('FLUSH') },
                pose: function () {
                    return {
                        translate: function (x, y, z) {
                            curPoseZ += z
                            poseZHistory.push(curPoseZ)
                        }
                    }
                }
            },
            push: function () { poseStack.push(curPoseZ) },
            pop: function () { curPoseZ = poseStack.length ? poseStack.pop() : 0 },
            translate: function () {},
            rotateDeg: function () {},
            scale: function () {},
            setPositionColorShader: function () {},
            blend: function () {},
            beginQuads: function () {},
            end: function () {},
            rectangle: function () { drawOps.push('HUD_RECT@z=' + curPoseZ) },
            text: function (comp) { drawOps.push('TEXT:' + comp.string + '@z=' + curPoseZ) }
        }
        cliPaints[0](mockEv)

        var idxLo  = drawOps.indexOf('TEXT:LO_DANMAKU@z=0')
        var idxHi  = drawOps.indexOf('TEXT:HI_DANMAKU@z=0')
        var idxHud = drawOps.indexOf('HUD_RECT@z=1')
        assert.ok(idxLo >= 0, 'low-priority danmaku must draw at z=0 (ops=' + JSON.stringify(drawOps) + ')')
        assert.ok(idxHi > idxLo, 'high-priority danmaku must draw AFTER low-priority danmaku (on top)')
        assert.ok(idxHud > idxHi, 'HUD progress bar must draw AFTER all danmaku at elevated Z layer z=1 (ops=' + JSON.stringify(drawOps) + ')')
        assert.ok(drawOps.slice(idxHi, idxHud).indexOf('FLUSH') >= 0, 'graphics.flush() must occur between danmaku layer and HUD layer')

        // 4. Real FS rolling retention test for quarantine backups (maxQuarantineBackups = 3)
        var os = require('os')
        var qTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epiphy_qprune_'))
        try {
            var qSb = makeNodeBackedJavaSandbox(qTmpDir)
            loadServerBase(qSb)
            var qBase = qSb.global.EpiphyServerCore
            var qFile = path.join(qTmpDir, 'permissions.json')
            var qStore = qBase.openJsonStore(qFile, { backup: false, lockOnCorrupt: true, maxQuarantineBackups: 3 })
            for (var qi = 1; qi <= 6; qi++) {
                fs.writeFileSync(qFile, '{ corrupt_round_' + qi, 'utf8')
                assert.strictEqual(qStore.load().status, 'corrupt')
                assert.strictEqual(qStore.save({ round: qi }, { quarantine: true }), true)
            }
            var keptBackups = fs.readdirSync(qTmpDir).filter(function (fn) {
                return fn.indexOf('permissions.json.corrupt.') === 0 && fn.slice(-4) === '.bak'
            }).sort()
            assert.strictEqual(keptBackups.length, 3, 'quarantine pruning must keep only the newest maxQuarantineBackups=3 files, got: ' + JSON.stringify(keptBackups))
            assert.strictEqual(fs.readFileSync(path.join(qTmpDir, keptBackups[0]), 'utf8'), '{ corrupt_round_4')
            assert.strictEqual(fs.readFileSync(path.join(qTmpDir, keptBackups[2]), 'utf8'), '{ corrupt_round_6')
        } finally {
            try { fs.rmSync(qTmpDir, { recursive: true, force: true }) } catch (eRm) { }
        }
    })

    test('68. Renderer per-phase perf stats (off by default, tick-only disk flush, /epiphy debug renderperf) & PROTO v6 schema conformance', function () {
        // --- Part A: Client per-phase perf metrics & epiphy-data snapshot ---
        var cliPaints   = []
        var cliTicks    = []
        var cliNetCb    = null
        var cliDbgNetCb = null
        var cNow        = 1000
        var writtenPerf = {}
        var writeCount  = 0
        var createdDirs = []
        var cliSb = {
            console: { info: function () {}, warn: function () {}, error: function (m) { throw new Error(m) }, debug: function () {}, log: function () {} },
            Date: { now: function () { return cNow } },
            Client: { getCurrentScreen: function () { return { title: 'TestGui', guiLeft: 0, guiTop: 0 } } },
            ClientEvents: {
                loggedOut: function () {},
                loggedIn: function () {},
                tick: function (fn) { cliTicks.push(fn) },
                paintScreen: function (fn) { cliPaints.push(fn) }
            },
            NetworkEvents: {
                dataReceived: function (chName, fn) {
                    if (chName === 'epiphy:screen_danmaku') cliNetCb = fn
                    else if (chName === 'epiphy:render_debug') cliDbgNetCb = fn
                }
            },
            JsonIO: { write: function (p, obj) { writeCount++; writtenPerf[p] = obj } },
            Java: {
                loadClass: function (cls) {
                    if (cls === 'dev.latvian.mods.kubejs.KubeJSPaths') {
                        return {
                            DIRECTORY: { getParent: function () { return 'C:/mock_mc' } },
                            dir: function (d) { createdDirs.push(d) }
                        }
                    }
                    return null
                }
            },
            Text: { of: function (s) { return { string: String(s) } } },
            global: {}
        }
        cliSb.globalThis = cliSb
        vm.createContext(cliSb)
        loadStartupBase(cliSb)
        runScriptIn(cliSb, RENDERER_PATH)
        var R = cliSb.global.Epiphy2DRenderer

        // Default MUST be off (debug opt-in) & zero disk IO during paintScreen
        assert.strictEqual(R.CONFIG.perfLogEnabled, false, 'perfLogEnabled must default to false (debug opt-in)')
        assert.strictEqual(typeof cliDbgNetCb, 'function', 'client renderer must listen on epiphy:render_debug')
        assert.ok(cliTicks.length >= 1, 'client renderer must register ClientEvents.tick flush handler')

        cliNetCb({ data: { proto: 6, surface: 'screen', title: 'PLAIN', stay: 100, showInGui: true, rx: 0.3, ry: 0.2 } })
        cliNetCb({ data: { proto: 6, surface: 'screen', id: 'hud1', lifeMode: 'active', activeHold: 100, showInGui: true, rx: 0.5, ry: 0.2, nodes: [{ id: 'r1', type: 'rect', x: 0, y: 0, w: 60, h: 10, fill: { mode: 'solid', color: 0xFF33AAFF } }] } })
        cliNetCb({ data: { proto: 6, surface: 'gui', id: 'g1', lifeMode: 'active', activeHold: 100, targetGui: { titleMatch: 'TestGui' }, fgNodes: [{ id: 'gr1', type: 'rect', x: 0, y: 0, w: 20, h: 10, fill: { mode: 'solid', color: 0xFFFFFFFF } }] } })

        var mockEv = {
            width: 854, height: 480, level: 'minecraft:overworld',
            font: { width: function () { return 24 } },
            graphics: { flush: function () {} },
            push: function () {}, pop: function () {}, translate: function () {}, rotateDeg: function () {}, scale: function () {},
            setPositionColorShader: function () {}, blend: function () {}, beginQuads: function () {}, end: function () {},
            rectangle: function () {}, text: function () {}
        }
        cliPaints[0](mockEv)
        R.renderGuiSurfacePass(mockEv, 'fg', { screen: { title: 'TestGui', guiLeft: 0, guiTop: 0 } })
        cliTicks[0]()
        assert.strictEqual(writeCount, 0, 'when perfLogEnabled is false, neither paintScreen nor tick may write disk')

        var st = R.getStats()
        assert.strictEqual(st.version, '6.2.0')
        assert.strictEqual(st.perfLogEnabled, false)
        assert.strictEqual(st.phases.paint_total.frames, 1)
        assert.strictEqual(st.phases.screen_text.frames, 1)
        assert.strictEqual(st.phases.screen_hud.frames, 1)
        assert.ok(st.phases.gui.frames >= 1)
        assert.strictEqual(st.budgetTargetsMs.singlePanel, 0.3)
        assert.strictEqual(st.budgetTargetsMs.highLoadFrame, 2.5)

        // Enable via server EpiphyDebug.dispatchRenderPerf -> client epiphy:render_debug
        var dbgSvSb = {
            console: { info: function () {}, warn: function () {}, error: function (m) { throw new Error(m) }, debug: function () {}, log: function () {} },
            ServerEvents: { loaded: function () {}, tick: function () {}, commandRegistry: function () {} },
            Java: { loadClass: function () { return null } },
            Text: { of: function (s) { return String(s) } },
            global: {}
        }
        dbgSvSb.globalThis = dbgSvSb
        vm.createContext(dbgSvSb)
        loadServerBase(dbgSvSb)
        runScriptIn(dbgSvSb, DEBUG_PATH)
        var sentDbgPackets = []
        var fakePlayer = { sendData: function (ch, data) { sentDbgPackets.push({ ch: ch, data: data }); if (ch === 'epiphy:render_debug') cliDbgNetCb({ data: data }) } }
        var dispOn = dbgSvSb.global.EpiphyDebug.dispatchRenderPerf({ player: fakePlayer }, 'on')
        assert.strictEqual(dispOn.ok, true)
        assert.strictEqual(dispOn.sent, 1)
        assert.strictEqual(sentDbgPackets[0].ch, 'epiphy:render_debug')
        assert.strictEqual(sentDbgPackets[0].data.cmd, 'on')
        assert.strictEqual(R.CONFIG.perfLogEnabled, true)

        // Render frame while enabled: STILL zero sync disk write inside paintScreen
        cNow += 50
        cliPaints[0](mockEv)
        assert.strictEqual(writeCount, 0, 'paintScreen render thread must NEVER synchronously write disk even when perfLogEnabled is true')

        // Flush occurs only on ClientEvents.tick
        cNow += 50
        cliTicks[0]()
        var expectedPerfPath = 'C:/mock_mc/epiphy-data/logs/client_render_perf.json'
        assert.strictEqual(writeCount, 1, 'ClientEvents.tick must perform the throttled disk write once marked dirty')
        assert.ok(writtenPerf[expectedPerfPath] != null, 'renderer must write throttled perf snapshot to epiphy-data/logs/client_render_perf.json')
        assert.strictEqual(writtenPerf[expectedPerfPath].phases.screen_hud.frames, 2)

        // Reset & disable via debug command dispatch
        dbgSvSb.global.EpiphyDebug.dispatchRenderPerf({ player: fakePlayer }, 'reset')
        assert.strictEqual(R.getStats().phases.paint_total.frames, 0)
        dbgSvSb.global.EpiphyDebug.dispatchRenderPerf({ player: fakePlayer }, 'off')
        assert.strictEqual(R.CONFIG.perfLogEnabled, false)

        // Fail-Narrow safety: console (no player) invoking renderperf on/dump without explicit target MUST be rejected!
        var pAlice = { username: 'Alice', sendData: function (ch, data) { sentDbgPackets.push({ to: 'Alice', ch: ch, data: data }) } }
        var pBob   = { username: 'Bob',   sendData: function (ch, data) { sentDbgPackets.push({ to: 'Bob',   ch: ch, data: data }) } }
        var consoleSrc = { player: null, server: { players: [pAlice, pBob] } }
        var rejOn   = dbgSvSb.global.EpiphyDebug.dispatchRenderPerf(consoleSrc, 'on')
        var rejDump = dbgSvSb.global.EpiphyDebug.dispatchRenderPerf(consoleSrc, 'dump')
        assert.strictEqual(rejOn.ok, false, 'console renderperf on without target must fail-narrow to prevent accidental server-wide disk logging')
        assert.strictEqual(rejOn.sent, 0)
        assert.strictEqual(rejDump.ok, false, 'console renderperf dump without target must fail-narrow')
        // Explicit player target & @all broadcast work cleanly
        var okAlice = dbgSvSb.global.EpiphyDebug.dispatchRenderPerf(consoleSrc, 'on', 'alice')
        assert.strictEqual(okAlice.ok, true)
        assert.strictEqual(okAlice.sent, 1)
        var okAllOff = dbgSvSb.global.EpiphyDebug.dispatchRenderPerf(consoleSrc, 'off')
        assert.strictEqual(okAllOff.ok, true, 'console renderperf off without target is safe to broadcast')
        assert.strictEqual(okAllOff.sent, 2)
        var okAllOn = dbgSvSb.global.EpiphyDebug.dispatchRenderPerf(consoleSrc, 'on', '@all')
        assert.strictEqual(okAllOn.ok, true)
        assert.strictEqual(okAllOn.sent, 2)
        var missPlayer = dbgSvSb.global.EpiphyDebug.dispatchRenderPerf(consoleSrc, 'on', 'Nobody')
        assert.strictEqual(missPlayer.ok, false)

        // Client perfLogAutoOffMs auto-stop failsafe (10 minutes default)
        R.setPerfLog(true)
        assert.strictEqual(R.CONFIG.perfLogEnabled, true)
        cNow += R.CONFIG.perfLogAutoOffMs + 100
        cliTicks[0]()
        assert.strictEqual(R.CONFIG.perfLogEnabled, false, 'perfLogEnabled must auto-disable once perfLogAutoOffMs elapses')

        // --- Part B: Standalone docs/proto_v6_schema.json Conformance Validation ---
        var schemaPath = path.join(ROOT_DIR, 'docs', 'proto_v6_schema.json')
        var schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'))
        var roadmapText = fs.readFileSync(path.join(ROOT_DIR, 'docs', 'rendering-subsystem-roadmap.md'), 'utf8')

        var svSb = {
            console: { info: function () {}, warn: function () {}, error: function () {}, debug: function () {}, log: function () {} },
            ServerEvents: { loaded: function () {}, tick: function () {}, commandRegistry: function () {} },
            BlockEvents: { placed: function () {}, broken: function () {} },
            PlayerEvents: { loggedIn: function () {}, loggedOut: function () {} },
            Java: { loadClass: function () { return null } },
            global: {}
        }
        svSb.globalThis = svSb
        vm.createContext(svSb)
        loadServerBase(svSb)
        runScriptIn(svSb, TRACKER_PATH)
        runScriptIn(svSb, DANMAKU_PATH)
        var Spec    = svSb.global.EpiphySpec
        var Surface = svSb.global.Epiphy2DSurface

        // 1. Official aliases in schema must match Spec 1:1
        assert.deepStrictEqual(schema.officialAliases.envelope, Object.assign({}, Spec.OFFICIAL_DANMAKU_ALIASES), 'schema envelope aliases must match EpiphySpec.OFFICIAL_DANMAKU_ALIASES')
        assert.deepStrictEqual(schema.officialAliases.node, Object.assign({}, Spec.OFFICIAL_NODE_ALIASES), 'schema node aliases must match EpiphySpec.OFFICIAL_NODE_ALIASES')

        // 2. Roadmap §4.1 canonical core fields must exist in schema.envelope (with explicit slice & row-count floor)
        var sec41Start = roadmapText.indexOf('#### (A) 顶层信封')
        var sec41End   = roadmapText.indexOf('#### (B) 图元节点')
        assert.ok(sec41Start >= 0 && sec41End > sec41Start, 'roadmap §4.1 headings must be present and ordered')
        var sec41 = roadmapText.slice(sec41Start, sec41End)
        var rowRe = /^\|\s*`([a-zA-Z][a-zA-Z0-9_]*)`/gm
        var rm
        var sec41Rows = 0
        while ((rm = rowRe.exec(sec41)) !== null) {
            sec41Rows++
            assert.ok(schema.envelope[rm[1]] != null, 'roadmap §4.1 field `' + rm[1] + '` must be defined in docs/proto_v6_schema.json')
        }
        assert.ok(sec41Rows >= 25, 'roadmap §4.1 parser must match >= 25 core envelope rows, got ' + sec41Rows)

        // 2a. Roadmap §4.1 (C) rect.fill modes must match schema.fill.modes 1:1
        var sec41CStart = roadmapText.indexOf('#### (C) `rect.fill`')
        var sec41CEnd   = roadmapText.indexOf('### 4.2')
        assert.ok(sec41CStart >= 0 && sec41CEnd > sec41CStart, 'roadmap §4.1 (C) rect.fill section must exist')
        var sec41C = roadmapText.slice(sec41CStart, sec41CEnd)
        var fillRowRe = /^\|\s*\*\*`'([a-z_]+)'`\*\*/gm
        var fm
        var docFillModes = []
        while ((fm = fillRowRe.exec(sec41C)) !== null) {
            docFillModes.push(fm[1])
            assert.ok(schema.fill.modes.indexOf(fm[1]) >= 0, 'roadmap §4.1(C) fill.mode `' + fm[1] + '` must be defined in schema.fill.modes')
        }
        assert.ok(docFillModes.length >= 5, 'roadmap §4.1(C) must declare >= 5 rect.fill modes, got ' + docFillModes.length)

        // 2b. Roadmap §6.2 & §3 frame budget targets must stay in lockstep with Epiphy2DRenderer PERF_BUDGET
        var sec62Start = roadmapText.indexOf('### 6.2 客户端帧耗时预算')
        assert.ok(sec62Start >= 0, 'roadmap §6.2 frame budget section must exist')
        var sec62 = roadmapText.slice(sec62Start, sec62Start + 700)
        var mSingle = /<=\s*([0-9]+(?:\.[0-9]+)?)\s*ms/.exec(sec62)
        var mHigh   = /增量\s*\*\*`?<=\s*([0-9]+(?:\.[0-9]+)?)\s*ms/.exec(sec62)
        var mCutoff = /现行\s*`([0-9]+(?:\.[0-9]+)?)\s*ms`/.exec(sec62)
        assert.ok(mSingle && mHigh && mCutoff, 'roadmap §6.2 must declare singlePanel, highLoadFrame & emergencyCutoff ms targets')
        assert.strictEqual(st.budgetTargetsMs.singlePanel,     Number(mSingle[1]), 'singlePanel budget must match roadmap §6.2')
        assert.strictEqual(st.budgetTargetsMs.highLoadFrame,   Number(mHigh[1]),   'highLoadFrame budget must match roadmap §6.2')
        assert.strictEqual(st.budgetTargetsMs.emergencyCutoff, Number(mCutoff[1]), 'emergencyCutoff budget must match roadmap §6.2')
        assert.strictEqual(roadmapText.indexOf('frameBudgetMs (2.5ms)'), -1, 'roadmap §3 must NOT conflate highLoadFrameMs (2.5ms) with frameBudgetMs (45ms)')

        function validateNodeConformance(node, ctxLabel) {
            assert.ok(node && typeof node === 'object', ctxLabel + ': node must be object')
            assert.ok(schema.node.types.indexOf(node.type) >= 0, ctxLabel + ': invalid node.type=' + node.type)
            if (node.anchor !== undefined) {
                assert.ok(schema.node.anchors.indexOf(node.anchor) >= 0, ctxLabel + ': invalid anchor=' + node.anchor)
            }
            if (node.clip != null) {
                assert.ok(schema.clip.dirs.indexOf(node.clip.dir) >= 0, ctxLabel + ': invalid clip.dir=' + node.clip.dir)
                assert.ok(schema.clip.modes.indexOf(node.clip.mode) >= 0, ctxLabel + ': invalid clip.mode=' + node.clip.mode)
            }
            if (node.type === 'rect' && node.fill != null) {
                assert.ok(schema.fill.modes.indexOf(node.fill.mode) >= 0, ctxLabel + ': invalid fill.mode=' + node.fill.mode)
            }
            if (node.type === 'group' && Array.isArray(node.children)) {
                for (var ci = 0; ci < node.children.length; ci++) {
                    validateNodeConformance(node.children[ci], ctxLabel + '.children[' + ci + ']')
                }
            }
        }

        function validatePacketConformance(pkt, label) {
            assert.ok(pkt && typeof pkt === 'object', label + ': packet must be object')
            var act = pkt.action
            assert.ok(schema.actions.indexOf(act) >= 0, label + ': invalid action=' + act)
            var reqs = schema.requiredByAction[act]
            for (var ri = 0; ri < reqs.length; ri++) {
                assert.ok(pkt[reqs[ri]] !== undefined, label + ': missing required field `' + reqs[ri] + '` for action=' + act)
            }
            for (var k in pkt) {
                if (!Object.prototype.hasOwnProperty.call(pkt, k)) continue
                var spec = schema.envelope[k]
                assert.ok(spec != null, label + ': unexpected/undocumented wire key `' + k + '` not in proto_v6_schema.json')
                var v = pkt[k]
                if (spec.type === 'vec3') {
                    assert.ok(Array.isArray(v) && v.length === 3, label + '.' + k + ' must be vec3 array')
                } else if (spec.type === 'array') {
                    assert.ok(Array.isArray(v), label + '.' + k + ' must be array')
                } else if (spec.type === 'object') {
                    assert.ok(v != null && typeof v === 'object' && !Array.isArray(v), label + '.' + k + ' must be plain object')
                } else {
                    assert.strictEqual(typeof v, spec.type, label + '.' + k + ' expected ' + spec.type + ', got ' + typeof v)
                }
                if (spec.enum) {
                    assert.ok(spec.enum.indexOf(v) >= 0, label + '.' + k + '=' + v + ' not in enum ' + JSON.stringify(spec.enum))
                }
                if (spec.type === 'number') {
                    if (spec.min !== undefined) assert.ok(v >= spec.min, label + '.' + k + '=' + v + ' < min ' + spec.min)
                    if (spec.max !== undefined) assert.ok(v <= spec.max, label + '.' + k + '=' + v + ' > max ' + spec.max)
                }
                if (spec.type === 'string' && spec.maxLen !== undefined) {
                    assert.ok(v.length <= spec.maxLen, label + '.' + k + ' exceeds maxLen ' + spec.maxLen)
                }
            }
            if (pkt.tracks != null) {
                for (var tk in pkt.tracks) {
                    if (!Object.prototype.hasOwnProperty.call(pkt.tracks, tk)) continue
                    assert.ok(schema.track.modes.indexOf(pkt.tracks[tk].mode) >= 0, label + '.tracks.' + tk + ' invalid mode')
                }
            }
            var nodeLists = ['nodes', 'bgNodes', 'fgNodes']
            for (var nl = 0; nl < nodeLists.length; nl++) {
                var arr = pkt[nodeLists[nl]]
                if (Array.isArray(arr)) {
                    for (var ni = 0; ni < arr.length; ni++) {
                        validateNodeConformance(arr[ni], label + '.' + nodeLists[nl] + '[' + ni + ']')
                    }
                }
            }
        }

        // 3. Validate all representative packet families against standalone schema
        validatePacketConformance(Surface.buildPacket({ text: 'Hello', sub: 'World', pos: [0.5, 0.3], scale: 1.2 }), 'screen_text')
        validatePacketConformance(Surface.buildPacket({ preset: 'progress_bar', id: 'p1', title: 'HP', data: { progress: 0.6 }, life: { mode: 'active', hold: 40 } }), 'progress_bar')
        validatePacketConformance(Surface.buildPacket({ action: 'patch', id: 'p1', data: { progress: 0.8 }, life: { hold: 40 } }), 'patch')
        validatePacketConformance(Surface.buildPacket({ action: 'deactivate', id: 'p1', fadeOut: 12 }), 'deactivate')
        validatePacketConformance(Surface.buildPacket({ action: 'clear', group: '*', maxPriority: 5 }), 'clear')
        validatePacketConformance(Surface.buildPacket({ surface: 'gui', lifeMode: 'screen_session', targetGui: { titleMatch: 'Chest' }, bgNodes: [{ type: 'rect', x: 0, y: 0, w: 40, h: 20, fill: { mode: 'gradient', from: 0x112233, to: 0x445566 } }] }), 'gui')
        validatePacketConformance(Surface.buildPacket({ surface: 'slot', slotMatch: { slotIndex: 0 }, nodes: [{ type: 'rect', x: 0, y: 0, w: 16, h: 16, fill: { mode: 'outline', color: 0xFFFF0000 } }] }), 'slot')
        validatePacketConformance(Surface.buildPacket({ surface: 'world_plane', worldPos: [1, 64, 2], billboard: 'vertical', seeThrough: true, nodes: [{ type: 'text', x: 0, y: 0, text: 'WP' }] }), 'world_plane')
        validatePacketConformance(Spec.adaptV5ToV6({ proto: 5, title: 'LegacyV5', priority: 3, rx: 0.5, ry: 0.35, stay: 60 }), 'adaptV5ToV6')
    })

    test('70. RenderGuiEvent$Pre bridge: danmaku (0) < our HUD (50) < vanilla HUD (100) < explicit Post overlays, configurable & dedicated-server safe', function () {
        // 1. Dedicated server startup (Platform.isClientEnvironment() === false) must NEVER register RenderGuiEvent$Pre
        var srvForgeHooks = []
        var srvSb = {
            console: { info: function () {}, warn: function () {}, error: function (m) { throw new Error(m) }, debug: function () {}, log: function () {} },
            Platform: { isClientEnvironment: function () { return false } },
            ForgeEvents: { onEvent: function (cls, fn) { srvForgeHooks.push({ cls: cls, fn: fn }) } },
            global: {}
        }
        srvSb.globalThis = srvSb
        vm.createContext(srvSb)
        loadStartupBase(srvSb)
        assert.strictEqual(srvForgeHooks.length, 0, 'dedicated server must NOT register client RenderGuiEvent$Pre hook')
        assert.strictEqual(srvSb.global.EpiphyRenderHooks.preHudActive, false)

        // 2. Client startup registers RenderGuiEvent$Pre bridge once and delegates dynamically to Epiphy2DRenderer._onRenderGuiPre
        var forgeHooks = {}
        var cliPaints  = []
        var cliNetCb   = null
        var curScreen  = null
        var cNow       = 5000
        var cliSb = {
            console: { info: function () {}, warn: function () {}, error: function (m) { throw new Error(m) }, debug: function () {}, log: function () {} },
            Date: { now: function () { return cNow } },
            Platform: { isClientEnvironment: function () { return true } },
            ForgeEvents: { onEvent: function (cls, fn) { forgeHooks[cls] = fn } },
            Client: { getCurrentScreen: function () { return curScreen } },
            ClientEvents: { loggedOut: function () {}, loggedIn: function () {}, tick: function () {}, paintScreen: function (fn) { cliPaints.push(fn) } },
            NetworkEvents: { dataReceived: function (chName, fn) { if (chName === 'epiphy:screen_danmaku') cliNetCb = fn } },
            Java: { loadClass: function () { return null } },
            Text: { of: function (s) { return { string: String(s) } } },
            global: {}
        }
        cliSb.globalThis = cliSb
        vm.createContext(cliSb)
        loadStartupBase(cliSb)
        assert.strictEqual(typeof forgeHooks['net.minecraftforge.client.event.RenderGuiEvent$Pre'], 'function', 'client startup must register RenderGuiEvent$Pre bridge')
        assert.strictEqual(cliSb.global.EpiphyRenderHooks.preHudActive, true)
        runScriptIn(cliSb, RENDERER_PATH)
        var R = cliSb.global.Epiphy2DRenderer
        assert.strictEqual(R.isPreHudActive(), true)
        assert.strictEqual(R.getStats().preHudActive, true)
        assert.strictEqual(R.CONFIG.screenRenderPriority, 0)
        assert.strictEqual(R.CONFIG.hudRenderPriority, 50)
        assert.strictEqual(R.CONFIG.aboveVanillaHudPriority, 100)

        // Push 3 overlays: default danmaku (0), default HUD bar (50), explicit above-vanilla-HUD overlay (120)
        cliNetCb({ data: { proto: 6, surface: 'screen', title: 'DANMAKU_DEFAULT', stay: 100, rx: 0.4, ry: 0.4 } })
        cliNetCb({
            data: {
                proto: 6, surface: 'screen', id: 'our_hud', lifeMode: 'active', activeHold: 100, rx: 0.3, ry: 0.2,
                showInGui: true,
                nodes: [{ id: 'bar', type: 'rect', anchor: 'top_left', x: 0, y: 0, w: 80, h: 8, fill: { mode: 'solid', color: 0xFF00CCFF } }]
            }
        })
        cliNetCb({ data: { proto: 6, surface: 'screen', title: 'ABOVE_VANILLA_HUD', renderPriority: 120, stay: 100, rx: 0.5, ry: 0.5 } })

        function makeTraceEvent() {
            var ops = []
            var curZ = 0
            return {
                ops: ops,
                ev: {
                    width: 854, height: 480, level: 'minecraft:overworld',
                    font: { width: function (s) { return String(s || '').length * 6 } },
                    graphics: {
                        flush: function () { ops.push({ op: 'flush' }) },
                        pose: function () {
                            return { translate: function (x, y, z) { curZ = z; ops.push({ op: 'z', z: z }) } }
                        }
                    },
                    push: function () { curZ = 0 },
                    pop: function () { curZ = 0 },
                    translate: function () {},
                    rotateDeg: function () {},
                    scale: function () {},
                    setPositionColorShader: function () {},
                    resetShaderColor: function () { ops.push({ op: 'resetColor' }) },
                    blend: function () {},
                    beginQuads: function () {},
                    end: function () {},
                    rectangle: function () { ops.push({ op: 'rect', z: curZ }) },
                    text: function (txt) { ops.push({ op: 'text', text: String(txt && txt.string ? txt.string : txt), z: curZ }) }
                }
            }
        }

        // Fire Pre-HUD pass: ONLY danmaku (0) then our HUD (50), both at negative Z (-100 < -99 < 0)
        var preTrace = makeTraceEvent()
        forgeHooks['net.minecraftforge.client.event.RenderGuiEvent$Pre'](preTrace.ev)
        var preTexts = preTrace.ops.filter(function (o) { return o.op === 'text' })
        var preRects = preTrace.ops.filter(function (o) { return o.op === 'rect' })
        assert.strictEqual(preTexts.length, 1, 'Pre-HUD must draw ONLY default danmaku text, not renderPriority=120')
        assert.strictEqual(preTexts[0].text, 'DANMAKU_DEFAULT')
        assert.strictEqual(preRects.length, 1, 'Pre-HUD must draw default HUD bar')
        assert.ok(preTexts[0].z < 0 && preRects[0].z < 0, 'Pre-HUD items must use strictly negative Z (< 0) below vanilla HUD')
        assert.ok(preRects[0].z > preTexts[0].z, 'Our HUD (50) must sit at higher Z than danmaku (0) inside Pre-HUD')
        var idxText = preTrace.ops.findIndex(function (o) { return o.op === 'text' && o.text === 'DANMAKU_DEFAULT' })
        var idxRect = preTrace.ops.findIndex(function (o) { return o.op === 'rect' })
        assert.ok(idxText >= 0 && idxRect > idxText, 'Danmaku (0) must draw BEFORE our HUD (50)')

        // Fire Post-HUD pass (ClientEvents.paintScreen): ONLY renderPriority >= 100 draws (no double draw!)
        var postTrace = makeTraceEvent()
        cliPaints[0](postTrace.ev)
        var postTexts = postTrace.ops.filter(function (o) { return o.op === 'text' })
        var postRects = postTrace.ops.filter(function (o) { return o.op === 'rect' })
        assert.strictEqual(postTexts.length, 1, 'Post-HUD must draw ONLY renderPriority >= 100 overlay')
        assert.strictEqual(postTexts[0].text, 'ABOVE_VANILLA_HUD')
        assert.strictEqual(postRects.length, 0, 'Pre-HUD bar must NOT double-render in Post-HUD')

        // 3. Open GUI screen: showInGui=false danmaku hidden; showInGui=true HUD (50) stays in Pre-HUD (behind GUI), NOT Post-HUD
        curScreen = { getClass: function () { return { getName: function () { return 'net.minecraft.client.gui.screens.inventory.InventoryScreen' } } } }
        var guiPre = makeTraceEvent()
        forgeHooks['net.minecraftforge.client.event.RenderGuiEvent$Pre'](guiPre.ev)
        assert.strictEqual(guiPre.ops.filter(function (o) { return o.op === 'text' }).length, 0, 'showInGui=false danmaku must hide when GUI is open')
        assert.strictEqual(guiPre.ops.filter(function (o) { return o.op === 'rect' }).length, 1, 'showInGui=true HUD (<100) draws in Pre-HUD behind GUI screen')
        var guiPost = makeTraceEvent()
        cliPaints[0](guiPost.ev)
        assert.strictEqual(guiPost.ops.filter(function (o) { return o.op === 'rect' }).length, 0, 'HUD (<100) must NOT draw in Post-HUD on top of GUI screen')
        curScreen = null

        // 4. Configurable threshold: lowering aboveVanillaHudPriority to 40 promotes HUD (50) into Post-HUD while keeping danmaku (0) in Pre-HUD
        R.CONFIG.aboveVanillaHudPriority = 40
        var cfgPre = makeTraceEvent()
        forgeHooks['net.minecraftforge.client.event.RenderGuiEvent$Pre'](cfgPre.ev)
        assert.strictEqual(cfgPre.ops.filter(function (o) { return o.op === 'text' }).length, 1)
        assert.strictEqual(cfgPre.ops.filter(function (o) { return o.op === 'rect' }).length, 0, 'HUD (50 >= 40) must move out of Pre-HUD when threshold is lowered')
        var cfgPost = makeTraceEvent()
        cliPaints[0](cfgPost.ev)
        assert.strictEqual(cfgPost.ops.filter(function (o) { return o.op === 'rect' }).length, 1, 'HUD (50 >= 40) must now render in Post-HUD')
        R.CONFIG.aboveVanillaHudPriority = 100

        // 5. Fallback when preHudActive is false (non-Forge/Fabric): paintScreen renders all 3 in order 0 -> 50 -> 120
        cliSb.global.EpiphyRenderHooks.preHudActive = false
        var fbTrace = makeTraceEvent()
        cliPaints[0](fbTrace.ev)
        var fbOrder = fbTrace.ops.filter(function (o) { return o.op === 'text' || o.op === 'rect' }).map(function (o) { return o.op === 'rect' ? 'OUR_HUD' : o.text })
        assert.deepStrictEqual(fbOrder, ['DANMAKU_DEFAULT', 'OUR_HUD', 'ABOVE_VANILLA_HUD'], 'fallback single-pass paintScreen must render all layers in ascending renderPriority order')
    })

    test('71. epiphy:imperius_test (英佩瑞斯-测试中) sword registration & decoupled GPU-Shader + Pre-Baked CCModel Epiphy3DFXCore', function () {
        var FUNC_TEST_PATH = path.join(ROOT_DIR, 'kubejs', 'startup_scripts', '通用组件', 'Epiphy的小玩意_功能测试.js')
        var FX3D_CORE_PATH = h.FX3D_CORE_PATH
        var FX3D_PATH      = h.FX3D_PATH
        var modBusHooks    = {}
        var forgeHooks     = {}
        var cliPaints      = []
        var regItems       = {}
        var regBlocks      = {}
        var regSounds      = []

        // Mock Forge / MC / CodeChickenLib classes for RegisterShadersEvent + ModelEvent$ModifyBakingResult + IItemRenderer
        var registeredShaders = []
        var uniformValues     = { EpiphyTime: null, EpiphyYawPitch: null, EpiphyGuiMode: null }
        var createdRenderTypes = []
        var outlinePropsUsed   = []
        var bakedCCModels      = []
        var renderDrawCalls    = []
        var flushedTypes       = []
        var origModelDraws     = 0

        function MockResourceLocation(a, b) {
            this.str = b !== undefined ? (a + ':' + b) : String(a)
        }
        MockResourceLocation.prototype.toString = function () { return this.str }

        function MockModelResourceLocation(rl, variant) {
            this.key = String(rl) + '#' + String(variant)
        }
        MockModelResourceLocation.prototype.toString = function () { return this.key }

        function MockShaderInstance(provider, rl, fmt) {
            this.provider = provider
            this.rl       = rl
            this.fmt      = fmt
            this.m_173348_ = function (name) {
                return {
                    name: name,
                    m_5985_: function (v) { uniformValues[name] = v },
                    m_7971_: function (v0, v1) { uniformValues[name] = [v0, v1] }
                }
            }
        }

        function MockConsumer(obj) { return obj }
        function MockSupplier(obj) { return obj }
        function MockVertex5(x, y, z, u, v) { this.x = x; this.y = y; this.z = z; this.u = u; this.v = v }

        function MockCCModel(vCount) {
            this.verts = new Array(vCount)
            this.attrs = {}
            this.normalsComputed = false
            this.getOrAllocate = function (key) {
                if (!this.attrs[key]) this.attrs[key] = new Array(vCount)
                return this.attrs[key]
            }
            this.computeNormals = function () { this.normalsComputed = true; return this }
            this.render = function (ccrs, mat) {
                renderDrawCalls.push({
                    rt: ccrs.boundRt,
                    verts: this.verts.length,
                    scales: mat.scales.slice(),
                    rotCount: mat.rots.length
                })
            }
            bakedCCModels.push(this)
        }
        var MockCCModelClass = { quadModel: function (n) { return new MockCCModel(n) } }

        function MockMatrix4() {
            this.scales = []
            this.rots   = []
            this.trans  = []
        }
        MockMatrix4.prototype.set = function (other) {
            this.scales = other && other.scales ? other.scales.slice() : []
            this.rots   = other && other.rots ? other.rots.slice() : []
            this.trans  = other && other.trans ? other.trans.slice() : []
            return this
        }
        MockMatrix4.prototype.translate = function (x, y, z) { this.trans.push([x, y, z]); return this }
        MockMatrix4.prototype.rotate    = function (a, ax) { this.rots.push([a, ax]); return this }
        MockMatrix4.prototype.scale     = function (sx, sy, sz) { this.scales.push([sx, sy !== undefined ? sy : sx, sz !== undefined ? sz : sx]); return this }

        var mockCCRS = {
            boundRt: null,
            baseColour: -1,
            reset: function () { this.boundRt = null; this.baseColour = -1 },
            bind: function (rt) { this.boundRt = rt }
        }

        var mockPlayer = {
            m_5675_: function () { return 42.5 },
            m_5686_: function () { return -15.0 },
            m_21324_: function () { return 0.5 }
        }
        var mockMcInstance = {
            f_91074_: mockPlayer,
            m_91296_: function () { return 0.5 },
            m_91291_: function () {
                return {
                    m_115189_: function () { origModelDraws++ }
                }
            }
        }
        var GUI_CTX  = { name: 'GUI' }
        var HAND_CTX = { name: 'FIRST_PERSON_RIGHT_HAND' }

        var sb = {
            console: { info: function () {}, warn: function () {}, error: function (m) { throw new Error(m) }, debug: function () {}, log: function () {} },
            Date: { now: function () { return 8000 } },
            Platform: { isClientEnvironment: function () { return true } },
            ForgeModEvents: { onEvent: function (cls, fn) { modBusHooks[cls] = fn } },
            ForgeEvents: { onEvent: function (cls, fn) { forgeHooks[cls] = fn } },
            StartupEvents: {
                registry: function (regType, fn) {
                    if (regType === 'sound_event') {
                        fn({ create: function (id) { regSounds.push(id); return {} } })
                    } else if (regType === 'block') {
                        fn({
                            create: function (id) {
                                var b = {
                                    id: id,
                                    displayName: function (n) { b.name = n; return b },
                                    soundType: function () { return b },
                                    hardness: function () { return b },
                                    resistance: function () { return b },
                                    textureAll: function () { return b },
                                    texture: function () { return b }
                                }
                                regBlocks[id] = b
                                return b
                            }
                        })
                    } else if (regType === 'item') {
                        fn({
                            create: function (id, type) {
                                var it = {
                                    id: id,
                                    type: type || 'basic',
                                    tags: [],
                                    tierObj: { uses: 2031, attackDamageBonus: 4.0, enchantmentValue: 15 },
                                    displayName: function (n) { it.name = n; return it },
                                    tier: function (t) { it.tierName = t; return it },
                                    attackDamageBaseline: function (v) { it.damageBase = v; return it },
                                    attackDamageBonus: function (v) { it.damageBonus = v; return it },
                                    maxDamage: function (v) { it.maxDmg = v; return it },
                                    unstackable: function () { it.unstack = true; return it },
                                    modifyTier: function (cb) { cb(it.tierObj); return it },
                                    texture: function (t) { it.tex = t; return it },
                                    parentModel: function (m) { it.parentM = m; return it },
                                    tag: function (tg) { it.tags.push(tg); return it }
                                }
                                regItems[id] = it
                                return it
                            }
                        })
                    }
                },
                modifyCreativeTab: function () {}
            },
            Client: { getCurrentScreen: function () { return null } },
            ClientEvents: { loggedOut: function () {}, loggedIn: function () {}, tick: function () {}, paintScreen: function (fn) { cliPaints.push(fn) } },
            NetworkEvents: { dataReceived: function () {} },
            Java: {
                loadClass: function (cls) {
                    if (cls === 'net.minecraft.client.Minecraft') return { m_91087_: function () { return mockMcInstance } }
                    if (cls === 'net.minecraft.resources.ResourceLocation') return MockResourceLocation
                    if (cls === 'net.minecraft.client.resources.model.ModelResourceLocation') return MockModelResourceLocation
                    if (cls === 'net.minecraft.client.renderer.ShaderInstance') return MockShaderInstance
                    if (cls === 'codechicken.lib.render.shader.CCShaderInstance') {
                        return {
                            create: function (provider, rl, fmt) {
                                var inst = new MockShaderInstance(provider, rl, fmt)
                                inst.viaCCShader = true
                                return inst
                            }
                        }
                    }
                    if (cls === 'java.util.function.Consumer') return MockConsumer
                    if (cls === 'java.util.function.Supplier') return MockSupplier
                    if (cls === 'codechicken.lib.render.CCModel') return MockCCModelClass
                    if (cls === 'codechicken.lib.render.CCRenderState') return { instance: function () { return mockCCRS } }
                    if (cls === 'codechicken.lib.render.item.IItemRenderer') return function (impl) { return impl }
                    if (cls === 'codechicken.lib.util.TransformUtils') return { DEFAULT_TOOL: 'DEFAULT_TOOL' }
                    if (cls === 'codechicken.lib.vec.Matrix4') return MockMatrix4
                    if (cls === 'codechicken.lib.vec.Vector3') return { X_POS: 'X', Y_POS: 'Y', Z_POS: 'Z' }
                    if (cls === 'codechicken.lib.vec.Vertex5') return MockVertex5
                    if (cls === 'codechicken.lib.render.pipeline.attribute.ColourAttribute') return { attributeKey: 'colour' }
                    if (cls === 'net.minecraft.client.renderer.GameRenderer') return { m_172811_: function () { return 'posColShader' }, m_172814_: function () { return 'posColTexShader' } }
                    if (cls === 'net.minecraft.client.renderer.entity.ItemRenderer') return { m_115222_: function () { return 'foilVC' } }
                    if (cls === 'net.minecraft.client.renderer.ItemBlockRenderTypes') return { m_109279_: function () { return 'origItemRt' } }
                    if (cls === 'net.minecraft.world.item.ItemDisplayContext') return { GUI: GUI_CTX }
                    if (cls === 'net.minecraft.client.renderer.RenderStateShard') return { f_110139_: 'TRANS', f_110136_: 'LIGHTNING', f_110110_: 'NO_CULL', f_110114_: 'CD_WRITE', f_110115_: 'C_WRITE' }
                    if (cls === 'net.minecraft.client.renderer.RenderStateShard$ShaderStateShard') return function (sup) { this.sup = sup }
                    if (cls === 'net.minecraft.client.renderer.RenderStateShard$TextureStateShard') return function (rl) { this.rl = rl }
                    if (cls === 'net.minecraft.client.renderer.RenderType$OutlineProperty') return { NONE: 'OUTLINE_NONE' }
                    if (cls === 'net.minecraft.client.renderer.RenderType$CompositeState') {
                        return {
                            m_110628_: function () {
                                var st = {}
                                var b = {
                                    m_173292_: function (s) { st.shader = s; return b },
                                    m_173290_: function (t) { st.tex = t; return b },
                                    m_110685_: function (tr) { st.trans = tr; return b },
                                    m_110661_: function (c) { st.cull = c; return b },
                                    m_110687_: function (w) { st.write = w; return b },
                                    m_110689_: function (op) { outlinePropsUsed.push(op); st.outline = op; return st }
                                }
                                return b
                            }
                        }
                    }
                    if (cls === 'net.minecraft.client.renderer.RenderType') {
                        return {
                            m_173215_: function (name, fmt, mode, buf, cr, sort, state) {
                                var rt = { name: name, fmt: fmt, mode: mode, state: state }
                                createdRenderTypes.push(rt)
                                return rt
                            }
                        }
                    }
                    if (cls === 'com.mojang.blaze3d.vertex.DefaultVertexFormat') return { f_85815_: 'POSITION_COLOR', f_85818_: 'POSITION_COLOR_TEX' }
                    if (cls === 'com.mojang.blaze3d.vertex.VertexFormat$Mode') return { QUADS: 'QUADS' }
                    return null
                }
            },
            Text: { of: function (s) { return { string: String(s) } } },
            global: {}
        }
        sb.globalThis = sb
        vm.createContext(sb)
        loadStartupBase(sb)
        runScriptIn(sb, FX3D_CORE_PATH)
        runScriptIn(sb, FUNC_TEST_PATH)
        runScriptIn(sb, RENDERER_PATH)
        var forgeHooksBeforeFx3d = Object.keys(forgeHooks).length
        var cliPaintsBeforeFx3d  = cliPaints.length
        runScriptIn(sb, FX3D_PATH)

        // 1. Verify sword registration in Epiphy的小玩意_功能测试.js
        var imp = regItems['epiphy:imperius_test']
        assert.ok(imp != null, 'epiphy:imperius_test must be registered in StartupEvents.registry("item")')
        assert.strictEqual(imp.type, 'sword', 'must be registered with "sword" builder for sword enchantments & sweep mechanics')
        assert.strictEqual(imp.name, '英佩瑞斯-测试中', 'displayName must be 英佩瑞斯-测试中')
        assert.strictEqual(imp.damageBase, 50.0, 'attackDamageBaseline must be +50.0')
        assert.strictEqual(imp.damageBonus, 0.0, 'attackDamageBonus must be 0.0')
        assert.strictEqual(imp.maxDmg, 0, 'maxDamage(0) must be set for infinite durability')
        assert.strictEqual(imp.tierObj.uses, 0, 'tier.uses must be 0 for infinite durability')
        assert.strictEqual(imp.tierObj.attackDamageBonus, 0.0, 'tier.attackDamageBonus must be 0.0 so total modifier is exact +50')
        assert.ok(imp.tags.indexOf('minecraft:swords') >= 0 && imp.tags.indexOf('forge:tools/swords') >= 0, 'must carry minecraft:swords and forge:tools/swords tags')
        assert.ok(Array.isArray(sb.global.EpiphyCreativeTabQueue) && sb.global.EpiphyCreativeTabQueue.indexOf('epiphy:imperius_test') >= 0, 'must be queued into EpiphyCreativeTab')

        // 2. Verify strict 2D vs 3D subsystem separation AND zero per-frame JS loops in Epiphy3DFX client facade
        var R2D      = sb.global.Epiphy2DRenderer
        var FX3DCore = sb.global.Epiphy3DFXCore
        var FX3D     = sb.global.Epiphy3DFX
        assert.ok(FX3DCore != null && FX3D != null && sb.global.EpiphySpatialFX === FX3D, 'Epiphy3DFXCore and Epiphy3DFX/EpiphySpatialFX must be exported')
        assert.strictEqual(typeof R2D.bindItemVfx, 'undefined', '2D planar renderer must NOT contain 3D item VFX binding methods')
        assert.strictEqual(typeof R2D._pure.buildOrbit3DDrawables, 'undefined', '2D planar renderer must NOT contain 3D orbital mesh generation')
        assert.strictEqual(cliPaints.length, cliPaintsBeforeFx3d, 'Epiphy3DFX client facade must register ZERO per-frame ClientEvents.paintScreen loops')
        assert.strictEqual(Object.keys(forgeHooks).length, forgeHooksBeforeFx3d, 'Epiphy3DFX must register ZERO per-frame ForgeEvents (no RenderHandEvent/ContainerScreenEvent)')
        assert.strictEqual(typeof forgeHooks['net.minecraftforge.client.event.RenderHandEvent'], 'undefined')
        assert.strictEqual(typeof modBusHooks['net.minecraftforge.client.event.RegisterShadersEvent'], 'function', 'Epiphy3DFXCore must hook RegisterShadersEvent on ForgeModEvents')
        assert.strictEqual(typeof modBusHooks['net.minecraftforge.client.event.ModelEvent$ModifyBakingResult'], 'function', 'Epiphy3DFXCore must hook ModelEvent$ModifyBakingResult on ForgeModEvents')

        // 3. Verify self-contained GPU shader assets & mask texture exist (and zero Avaritia references)
        var shaderDir = path.join(ROOT_DIR, 'kubejs', 'assets', 'epiphy', 'shaders', 'core')
        var texDir    = path.join(ROOT_DIR, 'kubejs', 'assets', 'epiphy', 'textures', 'item')
        var shaderJson = JSON.parse(fs.readFileSync(path.join(shaderDir, 'epiphy_cosmos.json'), 'utf8'))
        var shaderVsh  = fs.readFileSync(path.join(shaderDir, 'epiphy_cosmos.vsh'), 'utf8')
        var shaderFsh  = fs.readFileSync(path.join(shaderDir, 'epiphy_cosmos.fsh'), 'utf8')
        assert.strictEqual(shaderJson.vertex, 'epiphy:epiphy_cosmos')
        assert.strictEqual(shaderJson.fragment, 'epiphy:epiphy_cosmos')
        assert.deepStrictEqual(shaderJson.attributes, ['Position', 'Color', 'UV0'])
        assert.ok(shaderVsh.indexOf('#version 150') === 0 && shaderFsh.indexOf('#version 150') === 0, 'core shaders must be valid GLSL 150')
        assert.ok(shaderFsh.indexOf('EpiphyYawPitch') >= 0 && shaderFsh.indexOf('evalCrossStarLayer') >= 0, 'fragment shader must implement camera-reactive cross-star cosmos')
        assert.ok(fs.existsSync(path.join(texDir, 'imperius_test.png')), 'static base blade texture must exist')
        assert.ok(fs.existsSync(path.join(texDir, 'imperius_test_cosmos_mask.png')), 'GPU cosmos window mask texture must exist')
        assert.ok(fs.existsSync(path.join(ROOT_DIR, 'kubejs', 'assets', 'epiphy', 'textures', 'effect', 'white_pixel.png')), 'white_pixel.png must exist for POSITION_COLOR_TEX surround VFX')
        assert.strictEqual(fs.existsSync(path.join(texDir, 'imperius_test.png.mcmeta')), false, 'obsolete animated mcmeta must be removed')
        var coreSrc = fs.readFileSync(FX3D_CORE_PATH, 'utf8')
        assert.strictEqual(coreSrc.indexOf('committee.nova.mods.avaritia'), -1, 'must NEVER call Avaritia renderer/shaders')
        assert.strictEqual(coreSrc.indexOf("Java.loadClass('java.lang.System')"), -1, 'must NEVER call Java.loadClass(java.lang.System) in hot path')

        // 4. Verify RGBA byte order (0xRRGGBBAA) for CodeChickenLib ColourRGBA & pure pre-baked mesh counts
        assert.strictEqual(FX3DCore._pure.packRgba(0x112233, 0x80) >>> 0, 0x11223380, 'CCL ColourRGBA must pack R in MSB and A in LSB (0xRRGGBBAA)')
        var impCfg = FX3D.getBoundItemConfig('epiphy:imperius_test')
        assert.ok(impCfg != null && impCfg.maskTexture === 'epiphy:textures/item/imperius_test_cosmos_mask.png', 'must auto-derive cosmos mask texture path')
        assert.strictEqual(FX3DCore._pure.buildCosmosOverlayQuads().length, 2, 'cosmos overlay must be exact 2 quads (front+back)')
        assert.ok(FX3DCore._pure.buildAstrolabeRingQuads(impCfg.rings[0]).length >= 100 && FX3DCore._pure.buildAstrolabeRingQuads(impCfg.rings[0]).length <= 180, 'Ring 0 must bake lean bold cross-ribbons, ticks, and 4 3D star-prisms')
        assert.ok(FX3DCore._pure.buildHelixRibbonQuads(impCfg.helix, 0).length >= 60 && FX3DCore._pure.buildHelixRibbonQuads(impCfg.helix, 0).length <= 140, 'Helix strand must bake lean smooth cross-ribbons along blade spine')
        assert.ok(FX3DCore._pure.buildStarMotesQuads(impCfg.motes, 0, 2).length >= 40, 'Star-mote group must bake 3D star heads + comet trails')

        // 5. Verify RegisterShadersEvent loads epiphy:epiphy_cosmos via CCShaderInstance.create (zero Rhino constructor ambiguity!)
        modBusHooks['net.minecraftforge.client.event.RegisterShadersEvent']({
            getResourceProvider: function () { return 'mockResProvider' },
            registerShader: function (inst, consumer) {
                registeredShaders.push(inst)
                consumer.accept(inst)
            }
        })
        assert.strictEqual(registeredShaders.length, 1, 'must register 1 custom core shader')
        assert.strictEqual(registeredShaders[0].viaCCShader, true, 'must prefer single-overload CCShaderInstance.create to avoid Rhino constructor ambiguity')
        assert.strictEqual(String(registeredShaders[0].rl), 'epiphy:epiphy_cosmos')
        var shStat = FX3D.getShaderStatus()
        assert.strictEqual(shStat.loaded, true)
        assert.strictEqual(shStat.hasUniforms, true, 'must resolve EpiphyTime, EpiphyYawPitch, EpiphyGuiMode uniforms')

        // 6. Verify ModelEvent$ModifyBakingResult pre-bakes CCModels ONCE, uses OutlineProperty.NONE, and wraps originalModel
        var modelsStore = {}
        var origModelStub = { m_6160_: function () { return 'bladeParticleSprite' } }
        modelsStore['epiphy:imperius_test#inventory'] = origModelStub
        var mockModelMap = {
            get: function (mrl) { return modelsStore[String(mrl)] || null },
            put: function (mrl, val) { modelsStore[String(mrl)] = val }
        }
        modBusHooks['net.minecraftforge.client.event.ModelEvent$ModifyBakingResult']({
            getModels: function () { return mockModelMap }
        })
        var wrappedRenderer = modelsStore['epiphy:imperius_test#inventory']
        assert.ok(wrappedRenderer != null && wrappedRenderer !== origModelStub && typeof wrappedRenderer.renderItem === 'function', 'must wrap original model with IItemRenderer')
        assert.strictEqual(wrappedRenderer.getModelState(), 'DEFAULT_TOOL', 'sword IItemRenderer must use TransformUtils.DEFAULT_TOOL')
        assert.strictEqual(wrappedRenderer.isGui3d(), false, 'sword icon must keep crisp flat GUI lighting (isGui3d=false)')
        assert.strictEqual(wrappedRenderer.m_6160_(), 'bladeParticleSprite', 'getParticleIcon must delegate to originalModel')
        assert.ok(outlinePropsUsed.length >= 2 && outlinePropsUsed.every(function (p) { return p === 'OUTLINE_NONE' }), 'all RenderTypes must pass OutlineProperty.NONE')
        // 1 cosmos overlay + 3 rings + 2 helices + 2 mote groups = 8 pre-baked CCModels
        assert.strictEqual(bakedCCModels.length, 8, 'must pre-bake exact 8 native CCModels (1 cosmos + 3 rings + 2 helices + 2 mote groups)')

        // 7. Verify per-frame renderItem in FIRST_PERSON_RIGHT_HAND & lean GUI LOD (zero JS vertex loop!)
        var mockBufferSource = {
            m_109912_: function (rt) { flushedTypes.push(rt) }
        }
        var mockStack = { m_41790_: function () { return true } }
        wrappedRenderer.renderItem(mockStack, HAND_CTX, new MockMatrix4(), mockBufferSource, 0x00F000F0, 0)
        assert.strictEqual(origModelDraws, 1, 'must draw originalModel once per renderItem')
        assert.strictEqual(renderDrawCalls.length, 8, 'first-person hand render must emit exact 8 pre-baked CCModel draw calls (zero JS vertex loop)')
        assert.strictEqual(uniformValues.EpiphyGuiMode, 0.0, 'first-person render must set EpiphyGuiMode = 0.0')
        assert.ok(Array.isArray(uniformValues.EpiphyYawPitch) && Math.abs(uniformValues.EpiphyYawPitch[0] - 42.5 * Math.PI / 180) < 1e-4, 'must upload camera yaw/pitch radians to GPU shader')
        assert.strictEqual(flushedTypes.length, 3, 'hand render must flush origRt -> cosmosRt -> vfxSurroundType in exact depth-occlusion order')
        // Verify slash expansion applied to ring/helix/mote transforms (swing=0.5 -> sin(PI/2)=1.0 -> 1.45x)
        var hasSlashScale = renderDrawCalls.some(function (dc) {
            return dc.scales.some(function (sc) { return Math.abs(sc[1] - 1.45) < 1e-4 })
        })
        assert.ok(hasSlashScale, 'swingProgress=0.5 must expand 3D surround scale to 1.45x via Matrix4')

        // GUI slot render check: lean LOD (1 cosmos + 2 hero rings = 3 draw calls) and NO mid-GUI origRt flush!
        renderDrawCalls.length = 0
        flushedTypes.length = 0
        wrappedRenderer.renderItem(mockStack, GUI_CTX, new MockMatrix4(), mockBufferSource, 0x00F000F0, 0)
        assert.strictEqual(uniformValues.EpiphyGuiMode, 1.0, 'GUI slot render must set EpiphyGuiMode = 1.0')
        assert.strictEqual(renderDrawCalls.length, 3, 'GUI slot render must use lean LOD (1 cosmos + 2 hero rings = 3 draw calls)')
        assert.strictEqual(flushedTypes.length, 2, 'GUI slot render must NOT flush origRt mid-hotbar batch')
        assert.strictEqual(FX3D.getStats().bakedCount, 1)
        assert.strictEqual(FX3D.getStats().coreAvailable, true)
        assert.strictEqual(FX3D.getStats().envState, 'client')

        // 8. Verify _pure.pushStarPrism3DQuads & pushCrossSegmentQuads geometry helpers
        var prismList = []
        FX3DCore._pure.pushStarPrism3DQuads(prismList, 0, 0, 0, [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.05, 0xFFAA00AA, 0xFFFFFFFF)
        assert.strictEqual(prismList.length, 6, 'pushStarPrism3DQuads must emit 3 orthogonal pairs * (glow + core) = 6 quads')
        var crossList = []
        FX3DCore._pure.pushCrossSegmentQuads(crossList, [0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.02, 0xFFFFFFFF)
        assert.strictEqual(crossList.length, 2, 'pushCrossSegmentQuads must emit 2 orthogonal ribbon quads')

        // 9. Verify BAKED_ITEMS clears cleanly across reloads after unbindItem (no stale entries!)
        FX3D.unbindItem('epiphy:imperius_test')
        delete sb.global.Epiphy3DFXItemBindings['epiphy:imperius_test']
        modBusHooks['net.minecraftforge.client.event.ModelEvent$ModifyBakingResult']({
            getModels: function () { return mockModelMap }
        })
        assert.strictEqual(FX3D.getStats().bakedCount, 0, 'reload after unbindItem must reset bakedCount to 0')
        assert.deepStrictEqual(plain(FX3D.getStats().bakedItems), {}, 'reload after unbindItem must clear stale BAKED_ITEMS entries')

        // 10. Verify client facade FALLBACK_CONFIG exact parity with Epiphy3DFXCore.CONFIG (no dual-source drift!)
        var facadeOnlySb = {
            console: { info: function () {}, warn: function () {}, error: function () {} },
            global: {}
        }
        facadeOnlySb.globalThis = facadeOnlySb
        vm.createContext(facadeOnlySb)
        runScriptIn(facadeOnlySb, FX3D_PATH)
        assert.deepStrictEqual(plain(facadeOnlySb.global.Epiphy3DFX.CONFIG), plain(FX3DCore.CONFIG), 'facade FALLBACK_CONFIG must match Epiphy3DFXCore.CONFIG 1:1')
        assert.strictEqual(facadeOnlySb.global.Epiphy3DFX.getStats().coreAvailable, false)

        // 11. Verify isClientSide() probe exception emits explicit warning & sets envState='probe_error'
        var probeWarns = []
        var errSb = {
            console: { info: function () {}, warn: function (m) { probeWarns.push(String(m)) }, error: function () {} },
            Platform: { isClientEnvironment: function () { throw new Error('boom_platform') } },
            ForgeModEvents: { onEvent: function () { throw new Error('must not hook modbus on probe_error') } },
            global: {}
        }
        errSb.globalThis = errSb
        vm.createContext(errSb)
        loadStartupBase(errSb)
        runScriptIn(errSb, FX3D_CORE_PATH)
        assert.strictEqual(errSb.global.Epiphy3DFXCore.getStats().envState, 'probe_error')
        assert.ok(probeWarns.some(function (w) { return w.indexOf('boom_platform') >= 0 }), 'isClientSide probe exception must emit visible console.warn')

        // 12. Verify EpiphySpec.createMonotonicClock (mc_util_nanos primary + NTP-jump-proof clamped Date.now fallback)
        var fakeNanos = 1000000000
        var utilClockSb = {
            console: { info: function () {}, warn: function () {}, error: function () {} },
            Java: {
                loadClass: function (cls) {
                    if (cls === 'net.minecraft.Util') return { m_137569_: function () { return fakeNanos } }
                    return null
                }
            },
            global: {}
        }
        utilClockSb.globalThis = utilClockSb
        vm.createContext(utilClockSb)
        loadStartupBase(utilClockSb)
        var clkUtil = utilClockSb.global.EpiphySpec.createMonotonicClock({ allowSystemProbe: false })
        assert.strictEqual(clkUtil.getSource(), 'mc_util_nanos', 'must prefer net.minecraft.Util.getNanos() (not blocked by ClassFilter)')
        fakeNanos += 2500000000
        assert.ok(Math.abs(clkUtil.elapsedSec() - 2.5) < 1e-4)

        var fakeDate = 10000
        var dateClockSb = {
            console: { info: function () {}, warn: function () {}, error: function () {} },
            Date: { now: function () { return fakeDate } },
            global: {}
        }
        dateClockSb.globalThis = dateClockSb
        vm.createContext(dateClockSb)
        loadStartupBase(dateClockSb)
        var clkDate = dateClockSb.global.EpiphySpec.createMonotonicClock({ allowSystemProbe: false })
        assert.strictEqual(clkDate.getSource(), 'clamped_date')
        fakeDate += 50
        var t1 = clkDate.elapsedSec()
        assert.ok(Math.abs(t1 - 0.05) < 1e-4)
        // Simulate NTP backward jump (-5000ms) -> must NOT go backwards!
        fakeDate -= 5000
        var t2 = clkDate.elapsedSec()
        assert.ok(t2 >= t1, 'NTP backward jump must never move monotonic clock backwards')
        // Simulate NTP forward jump (+60000ms) -> must clamp to clampStepMs (16ms)!
        fakeDate += 60000
        var t3 = clkDate.elapsedSec()
        assert.ok((t3 - t2) <= 0.02, 'NTP forward jump must be clamped cleanly')
    })
}
