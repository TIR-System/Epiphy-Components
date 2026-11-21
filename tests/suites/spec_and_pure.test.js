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
    // 1. parseTicksOrSec
    // ----------------------------------------------------------------------------
    test('parseTicksOrSec: handles null/empty/non-positive/invalid', function () {
        assert.strictEqual(pure.parseTicksOrSec(undefined), null)
        assert.strictEqual(pure.parseTicksOrSec(null), null)
        assert.strictEqual(pure.parseTicksOrSec('   '), null)
        assert.strictEqual(pure.parseTicksOrSec(0), null)
        assert.strictEqual(pure.parseTicksOrSec(-10), null)
        assert.strictEqual(pure.parseTicksOrSec('0s'), null)
        assert.strictEqual(pure.parseTicksOrSec('-1.5s'), null)
        assert.strictEqual(pure.parseTicksOrSec('abc'), null)
        assert.strictEqual(pure.parseTicksOrSec('abcs'), null)
    })

    test('parseTicksOrSec: converts seconds and ticks with rounding', function () {
        assert.strictEqual(pure.parseTicksOrSec('2s'), 40)
        assert.strictEqual(pure.parseTicksOrSec('2.5S'), 50)
        assert.strictEqual(pure.parseTicksOrSec(' 0.25s '), 5)
        assert.strictEqual(pure.parseTicksOrSec(65), 65)
        assert.strictEqual(pure.parseTicksOrSec('30'), 30)
        assert.strictEqual(pure.parseTicksOrSec('12.6'), 13)
    })

    // ----------------------------------------------------------------------------
    // 2. parseColor
    // ----------------------------------------------------------------------------
    test('parseColor: defaults, ints, presets, hex formats, random, invalid', function () {
        assert.deepStrictEqual(plain(pure.parseColor(undefined, 0x112233)), { color: 0x112233, isRandom: false })
        assert.deepStrictEqual(plain(pure.parseColor('', 0xABCDEF)), { color: 0xABCDEF, isRandom: false })
        assert.deepStrictEqual(plain(pure.parseColor(0x1FF55AA, 0)), { color: 0xFF55AA, isRandom: false })
        assert.deepStrictEqual(plain(pure.parseColor('red', 0)), { color: 0xFF4444, isRandom: false })
        assert.deepStrictEqual(plain(pure.parseColor(' GOLD ', 0)), { color: 0xFFAA00, isRandom: false })
        assert.deepStrictEqual(plain(pure.parseColor('#55ffaa', 0)), { color: 0x55FFAA, isRandom: false })
        assert.deepStrictEqual(plain(pure.parseColor('0x123456', 0)), { color: 0x123456, isRandom: false })
        assert.deepStrictEqual(plain(pure.parseColor('not_a_color', 0xFF5555)), { color: 0xFF5555, isRandom: false })

        var rnd = pure.parseColor('random', 0)
        assert.strictEqual(rnd.isRandom, true)
        assert.strictEqual(typeof rnd.color, 'number')
        assert.ok(rnd.color >= 0 && rnd.color <= 0xFFFFFF)
    })

    // ----------------------------------------------------------------------------
    // 3. parseSize
    // ----------------------------------------------------------------------------
    test('parseSize: defaults, scale fallback, numeric clamp, presets, tuples, random', function () {
        assert.deepStrictEqual(plain(pure.parseSize(undefined, undefined)), { scale: 1.0, isRandom: false })
        assert.deepStrictEqual(plain(pure.parseSize(null, 'large')), { scale: 1.35, isRandom: false })
        assert.deepStrictEqual(plain(pure.parseSize('TINY', 2.0)), { scale: 0.58, isRandom: false })
        assert.deepStrictEqual(plain(pure.parseSize('huge', null)), { scale: 1.70, isRandom: false })
        assert.deepStrictEqual(plain(pure.parseSize(0.05, null)), { scale: 0.2, isRandom: false })
        assert.deepStrictEqual(plain(pure.parseSize(9.5, null)), { scale: 4.0, isRandom: false })
        assert.deepStrictEqual(plain(pure.parseSize('2.25', null)), { scale: 2.25, isRandom: false })
        assert.deepStrictEqual(plain(pure.parseSize(-1, null)), { scale: 1.0, isRandom: false })
        assert.deepStrictEqual(plain(pure.parseSize('invalid', null)), { scale: 1.0, isRandom: false })
        assert.deepStrictEqual(plain(pure.parseSize([1.2, 1.2], null)), { scale: 1.2, isRandom: false })

        var rangeRes = pure.parseSize([1.8, 0.8], null)
        assert.strictEqual(rangeRes.isRandom, true)
        assert.ok(rangeRes.scale >= 0.8 && rangeRes.scale <= 1.8)

        var smallRnd = pure.parseSize('small_random', null)
        assert.strictEqual(smallRnd.isRandom, true)
        assert.ok(smallRnd.scale >= 0.55 && smallRnd.scale <= 0.97)
    })

    // ----------------------------------------------------------------------------
    // 4. parseTilt
    // ----------------------------------------------------------------------------
    test('parseTilt: fallback, keywords, numbers, tuple & string ranges', function () {
        assert.strictEqual(pure.parseTilt(undefined, undefined, 12.5), 12.5)
        assert.strictEqual(pure.parseTilt(undefined, undefined, null), 0.0)
        assert.strictEqual(pure.parseTilt(null, -15, 5), -15)
        assert.strictEqual(pure.parseTilt('none', null, 10), 0.0)
        assert.strictEqual(pure.parseTilt('flat', null, 10), 0.0)
        assert.strictEqual(pure.parseTilt('straight', null, 10), 0.0)
        assert.strictEqual(pure.parseTilt('22.5', null, 0), 22.5)
        assert.strictEqual(pure.parseTilt('bad_val', null, 7.5), 7.5)

        for (var i = 0; i < 10; i++) {
            var left = pure.parseTilt('left', null, 0)
            assert.ok(left <= -10.0 && left >= -25.0, 'left out of range: ' + left)

            var right = pure.parseTilt('right', null, 0)
            assert.ok(right >= 10.0 && right <= 25.0, 'right out of range: ' + right)

            var strRange = pure.parseTilt('-15~15', null, 0)
            assert.ok(strRange >= -15.0 && strRange <= 15.0, 'strRange out of range: ' + strRange)

            var arrRange = pure.parseTilt([-8, 12], null, 0)
            assert.ok(arrRange >= -8.0 && arrRange <= 12.0, 'arrRange out of range: ' + arrRange)
        }
    })

    // ----------------------------------------------------------------------------
    // 5. parseSpecString
    // ----------------------------------------------------------------------------
    test('parseSpecString: empty, free words, pipe split, escaped pipe & quoted text', function () {
        assert.deepStrictEqual(plain(pure.parseSpecString('')), {})
        assert.deepStrictEqual(plain(pure.parseSpecString('   ')), {})

        var free = pure.parseSpecString('Hello World | Sub Line')
        assert.strictEqual(free.text, 'Hello World')
        assert.strictEqual(free.sub, 'Sub Line')

        var escaped = pure.parseSpecString('A\\|B | C\\|D')
        assert.strictEqual(escaped.text, 'A|B')
        assert.strictEqual(escaped.sub, 'C|D')

        var quoted = pure.parseSpecString('text="你好 世界" sub=\'副标题 | A\' color=#55FFFF stay=3s bychar=开启 size=large')
        assert.strictEqual(quoted.text, '你好 世界')
        assert.strictEqual(quoted.sub, '副标题 | A')
        assert.strictEqual(quoted.color, '#55FFFF')
        assert.strictEqual(quoted.stay, '3s')
        assert.strictEqual(quoted.typewriter, true)
        assert.strictEqual(quoted.size, 'large')
    })

    test('parseSpecString: aliases, booleans & numeric sanitization', function () {
        var parsed = pure.parseSpecString(
            'subcolor=gold spacing=1.5 outlinemode=glow glowcolor=#FF00FF glowwidth=1.2 ' +
            'charms=45 existtime=4s activehold=40 lifemode=active continuous=yes shakemode=pulse ' +
            'shakeamp=3.5 shakefreq=500 percharshake=false fadestyle=blur fadeout=20 ' +
            'importance=8 maxpriority=6 includeonce=1 maxwidth=500 maxgroup=3 ' +
            'shadow=no wrap=false clamp=0 showingui=1 avoidhud=0 move=true normalizekey=off ' +
            'resetanimation=是 slot=boss_bar ns=dungeon group=combat 未知键=保留自由词'
        )
        assert.strictEqual(parsed.subColor, 'gold')
        assert.strictEqual(parsed.letterSpacing, 1.5)
        assert.strictEqual(parsed.outlineMode, 'glow')
        assert.strictEqual(parsed.outlineColor, '#FF00FF')
        assert.strictEqual(parsed.outlineWidth, 1.2)
        assert.strictEqual(parsed.charMs, 45)
        assert.strictEqual(parsed.duration, '4s')
        assert.strictEqual(parsed.activeHold, '40')
        assert.strictEqual(parsed.lifeMode, 'active')
        assert.strictEqual(parsed.continuous, true)
        assert.strictEqual(parsed.shakeMode, 'pulse')
        assert.strictEqual(parsed.shakeAmp, 3.5)
        assert.strictEqual(parsed.shakeFreq, '500')
        assert.strictEqual(parsed.perCharShake, false)
        assert.strictEqual(parsed.fadeStyle, 'blur')
        assert.strictEqual(parsed.fadeOut, '20')
        assert.strictEqual(parsed.priority, '8')
        assert.strictEqual(parsed.maxPriority, '6')
        assert.strictEqual(parsed.includeOnce, true)
        assert.strictEqual(parsed.maxWidth, 500)
        assert.strictEqual(parsed.maxGroup, 3)
        assert.strictEqual(parsed.shadow, false)
        assert.strictEqual(parsed.wrap, false)
        assert.strictEqual(parsed.clamp, false)
        assert.strictEqual(parsed.showInGui, true)
        assert.strictEqual(parsed.avoidHud, false)
        assert.strictEqual(parsed.movable, true)
        assert.strictEqual(parsed.normalizeKey, false)
        assert.strictEqual(parsed.restart, true)
        assert.strictEqual(parsed.id, 'boss_bar')
        assert.strictEqual(parsed.namespace, 'dungeon')
        assert.strictEqual(parsed.group, 'combat')
        assert.strictEqual(parsed.text, '未知键=保留自由词')
    })

    test('EpiphySpec: single startup script initializes both EpiphyProtocol and EpiphySpec together', function () {
        var sb = createKubeSandbox()
        runScriptIn(sb, SPEC_PATH)
        assert.ok(sb.global.EpiphyProtocol && sb.global.EpiphyProtocol.DANMAKU_CHANNEL === 'epiphy:screen_danmaku')
        assert.ok(sb.global.EpiphySpec && sb.global.EpiphySpec.PROTOCOL === sb.global.EpiphyProtocol)
        assert.strictEqual(sb.global.EpiphyProtocol.isProtoCompatible(5, 5), true)
        assert.strictEqual(sb.global.EpiphyProtocol.isProtoCompatible(5, 4), false)
        assert.strictEqual(sb.global.EpiphySpec.isProtoCompatible(5, 5), true)
    })

    test('EpiphySpec: shared math, dim normalization, ticks, color, size and tilt parsers', function () {
        var sb = createKubeSandbox()
        loadStartupBase(sb)
        var S = sb.global.EpiphySpec

        assert.strictEqual(S.min2(3, 7), 3)
        assert.strictEqual(S.max2(3, 7), 7)
        assert.strictEqual(S.clampNum(5, 0, 3, 1), 3)
        assert.strictEqual(S.clampNum('bad', 0, 3, 1), 1)
        assert.strictEqual(S.clampNum([], 0, 3, 2), 2)
        assert.strictEqual(S.normalizeDim('the_nether'), 'minecraft:the_nether')
        assert.strictEqual(S.normalizeDim('ResourceKey[minecraft:dimension / minecraft:overworld]'), 'minecraft:overworld')
        assert.strictEqual(S.normalizeDim(''), null)

        assert.strictEqual(S.parseBoolStrict('ON'), true)
        assert.strictEqual(S.parseBoolStrict('0'), false)
        assert.strictEqual(S.parseBoolStrict('maybe'), null)
        assert.strictEqual(S.parseBool('maybe', true), true)

        assert.strictEqual(S.parsePriority('urgent', 0), 4)
        assert.strictEqual(S.parsePriority('interrupt', 0, { map: { normal: 0, urgent: 1, replace: 2, interrupt: 2 }, min: 0, max: 2 }), 2)
        assert.strictEqual(S.parsePriority(9, 0, { min: 0, max: 10 }), 9)
        assert.strictEqual(S.parsePriority(99, 0, { min: 0, max: 2 }), 2)

        assert.strictEqual(S.parseTicks('2.5s', false), 50)
        assert.strictEqual(S.parseTicks('1.5m', false), 1800)
        assert.strictEqual(S.parseTicks('0', false), null)
        assert.strictEqual(S.parseTicks('0', true), 0)

        assert.strictEqual(S.parseTicksOrSec('2s'), 40)
        assert.strictEqual(S.parseTicksOrSec(' 0.25s '), 5)
        assert.strictEqual(S.parseTicksOrSec('12.6'), 13)
        assert.strictEqual(S.parseTicksOrSec('0s'), null)

        assert.deepStrictEqual(plain(S.parseColor('#f50', 0)), { color: 0xFF5500, isRandom: false })
        assert.deepStrictEqual(plain(S.parseColor('0x11223344', 0)), { color: 0x223344, isRandom: false })
        assert.strictEqual(S.parseColor('random', 0).isRandom, true)

        assert.deepStrictEqual(plain(S.parseSize([1.2, 1.2])), { scale: 1.2, isRandom: false })
        assert.strictEqual(S.parseSize('small_random').isRandom, true)
        assert.strictEqual(S.parseTilt('left'), -12)
        assert.strictEqual(S.parseTilt('none'), 0)
        var tiltRng = S.parseTilt('-15~15')
        assert.ok(tiltRng >= -15 && tiltRng <= 15)
    })

    test('EpiphySpec: parseCommandSpec supports collectFree/pipe splitting and strict error mode', function () {
        var sb = createKubeSandbox()
        loadStartupBase(sb)
        var S = sb.global.EpiphySpec

        var danmakuSchema = {
            aliases: { subtitle: 'sub', scale: 'size', fadeout: 'fadeOut' },
            bareWords: { urgent: { key: 'priority', value: 'urgent' } },
            fields: {
                color:   'lowerStr',
                size:    'str',
                sub:     'str',
                text:    'str',
                priority: 'lowerStr',
                fadeOut: { type: 'nonneg', max: 200 }
            },
            unknownMode:   'collectFree',
            splitFreePipe: true
        }
        var r1 = S.parseCommandSpec('urgent color=gold scale=1.5 Hello \\| A | Sub line', danmakuSchema)
        assert.strictEqual(r1.ok, true)
        assert.strictEqual(r1.opts.priority, 'urgent')
        assert.strictEqual(r1.opts.color, 'gold')
        assert.strictEqual(r1.opts.size, '1.5')
        assert.strictEqual(r1.opts.text, 'Hello | A')
        assert.strictEqual(r1.opts.sub, 'Sub line')

        var audioSchema = {
            aliases: { vol: 'volume', fadein: 'fadeIn' },
            bareWords: { loop: { key: 'loop', value: true } },
            fields: {
                loop:   'strictBool',
                volume: { type: 'strictNum', min: 0, max: 4 },
                fadeIn: 'str'
            },
            unknownMode: 'error'
        }
        var r2 = S.parseCommandSpec('loop vol=1.2 fadein=10t', audioSchema)
        assert.strictEqual(r2.ok, true)
        assert.strictEqual(r2.opts.loop, true)
        assert.strictEqual(r2.opts.volume, 1.2)
        assert.strictEqual(r2.opts.fadeIn, '10t')

        var rBadKey = S.parseCommandSpec('unknownKey=1', audioSchema)
        assert.strictEqual(rBadKey.ok, false)
        var rBadNum = S.parseCommandSpec('volume=99', audioSchema)
        assert.strictEqual(rBadNum.ok, false)
        var rBadBool = S.parseCommandSpec('loop=maybe', audioSchema)
        assert.strictEqual(rBadBool.ok, false)
    })

    test('EpiphySpec: computeSphereMergeClusters connects touching spheres by seq with tight union AABB', function () {
        var sb = createKubeSandbox()
        loadStartupBase(sb)
        var S = sb.global.EpiphySpec

        var clusters = S.computeSphereMergeClusters([
            { id: 'c', cx: 100, cy: 64, cz: 0, r: 5, seq: 1 },
            { id: 'b', cx: 12,  cy: 64, cz: 0, r: 6, seq: 3 },
            { id: 'a', cx: 0,   cy: 64, cz: 0, r: 6, seq: 2 } // touches b (dist=12 == 6+6), earlier seq
        ])
        assert.strictEqual(clusters.length, 2)
        assert.strictEqual(clusters[0].leader.id, 'c')
        assert.strictEqual(clusters[0].members.length, 1)
        assert.strictEqual(clusters[1].leader.id, 'a')
        assert.deepStrictEqual(plain(clusters[1].members.map(function (m) { return m.id })), ['a', 'b'])
        assert.strictEqual(clusters[1].minX, -6)
        assert.strictEqual(clusters[1].maxX, 18)
    })

    test('67. Component-owned VERSION, semver range dependency checks (min <= v <= max) & header parity', function () {
        var CREATIVE_TAB_PATH = path.join(ROOT_DIR, 'kubejs', 'startup_scripts', '通用组件', '创造模式栏-epiphy.js')
        var sb = {
            console: { info: function () {}, warn: function () {}, error: function () {}, debug: function () {}, log: function () {} },
            StartupEvents: { registry: function () {}, modifyCreativeTab: function () {} },
            ServerEvents: { loaded: function () {}, unloaded: function () {}, tick: function () {}, commandRegistry: function () {}, command: function () {} },
            BlockEvents: { placed: function () {}, broken: function () {} },
            PlayerEvents: { loggedIn: function () {}, loggedOut: function () {} },
            LevelEvents: { loaded: function () {} },
            ClientEvents: { tick: function () {}, loggedIn: function () {}, loggedOut: function () {}, paintScreen: function () {} },
            NetworkEvents: { dataReceived: function () {} },
            Java: { loadClass: function () { return null } },
            Text: { of: function (s) { return { string: String(s) } } },
            global: {}
        }
        sb.globalThis = sb
        vm.createContext(sb)
        loadStartupBase(sb)
        runScriptIn(sb, CREATIVE_TAB_PATH)
        runScriptIn(sb, LOG_PATH)
        runScriptIn(sb, SERVER_BASE_PATH)
        runScriptIn(sb, TRACKER_PATH)
        runScriptIn(sb, VALVE_PATH)
        runScriptIn(sb, DEBUG_PATH)
        runScriptIn(sb, BUGFIX_PATH)
        runScriptIn(sb, AUDIO_PATH)
        runScriptIn(sb, AUDIO_CLIENT_PATH)
        runScriptIn(sb, DANMAKU_PATH)
        runScriptIn(sb, RENDERER_PATH)
        runScriptIn(sb, h.FX3D_CORE_PATH)
        runScriptIn(sb, h.FX3D_SERVER_PATH)
        runScriptIn(sb, h.FX3D_PATH)

        var Spec  = sb.global.EpiphySpec
        var Proto = sb.global.EpiphyProtocol

        // 1. Protocol layer must NOT own component implementation versions
        assert.strictEqual(Proto.AUDIO_SEMVER, undefined, 'EpiphyProtocol must only carry wire protocol numbers, not component implementation semver')
        assert.strictEqual(Proto.DANMAKU_PROTO_VERSION, 6)
        assert.strictEqual(Proto.AUDIO_PROTO_VERSION, 5)

        // 2. Semver parsing, comparison & closed-range checks [min, max]
        assert.deepStrictEqual(JSON.parse(JSON.stringify(Spec.parseSemver('v5.8.0'))), { major: 5, minor: 8, patch: 0, raw: '5.8.0' })
        assert.strictEqual(Spec.compareSemver('2.5.0', '2.6.0'), -1)
        assert.strictEqual(Spec.compareSemver('2.6.0', '2.6.0'), 0)
        assert.strictEqual(Spec.compareSemver('3.0.0', '2.99.99'), 1)
        assert.strictEqual(Spec.isVersionInRange('2.5.0', '2.5.0', '2.99.99'), true)
        assert.strictEqual(Spec.isVersionInRange('2.99.99', '2.5.0', '2.99.99'), true)
        assert.strictEqual(Spec.isVersionInRange('2.4.9', '2.5.0', '2.99.99'), false)
        assert.strictEqual(Spec.isVersionInRange('3.0.0', '2.5.0', '2.99.99'), false)

        // 3. Every common component under kubejs/*/通用组件/*.js MUST be managed (auto-discovered, no silent escape)
        var componentMatrix = [
            { name: 'EpiphySpec',            docTag: 'EpiphySpec',                                obj: sb.global.EpiphySpec,            file: SPEC_PATH },
            { name: 'EpiphyCreativeTab',     docTag: 'EpiphyCreativeTab',                         obj: sb.global.EpiphyCreativeTab,     file: CREATIVE_TAB_PATH },
            { name: 'EpiphyLog',             docTag: 'EpiphyLog',                                 obj: sb.global.EpiphyLog,             file: LOG_PATH },
            { name: 'EpiphyServerCore',      docTag: 'EpiphyServerCore / EpiphyServerBase',       obj: sb.global.EpiphyServerCore,      file: SERVER_BASE_PATH },
            { name: 'EpiphyBlockTracker',    docTag: 'EpiphyBlockTracker / EpiphyWorldOps',       obj: sb.global.EpiphyBlockTracker,    file: TRACKER_PATH },
            { name: 'EpiphyPermissionValve', docTag: 'EpiphyPermissionValve',                     obj: sb.global.EpiphyPermissionValve, file: VALVE_PATH },
            { name: 'EpiphyDebug',           docTag: 'EpiphyDebug',                               obj: sb.global.EpiphyDebug,           file: DEBUG_PATH },
            { name: 'EpiphyBugfix',          docTag: 'EpiphyBugfix',                              obj: sb.global.EpiphyBugfix,          file: BUGFIX_PATH },
            { name: 'EpiphyAudio',           docTag: 'EpiphyAudio',                               obj: sb.global.EpiphyAudio,           file: AUDIO_PATH },
            { name: 'EpiphyAudioClient',     docTag: 'EpiphyAudioClient',                         obj: sb.global.EpiphyAudioClient,     file: AUDIO_CLIENT_PATH },
            { name: 'Epiphy2DSurface',       docTag: 'Epiphy2DSurface / ScreenDanmaku',           obj: sb.global.Epiphy2DSurface,       file: DANMAKU_PATH },
            { name: 'Epiphy2DRenderer',      docTag: 'Epiphy2DRenderer / ScreenDanmakuClient',    obj: sb.global.Epiphy2DRenderer,      file: RENDERER_PATH },
            { name: 'Epiphy3DFXCore',        docTag: 'Epiphy3DFXCore',                            obj: sb.global.Epiphy3DFXCore,        file: h.FX3D_CORE_PATH },
            { name: 'Epiphy3DFXServer',      docTag: 'Epiphy3DFXServer',                          obj: sb.global.Epiphy3DFXServer,      file: h.FX3D_SERVER_PATH },
            { name: 'Epiphy3DFX',            docTag: 'Epiphy3DFX',                                obj: sb.global.Epiphy3DFX,            file: h.FX3D_PATH }
        ]
        // Pure content/item/block-registration scripts with no exported global component API
        var exemptCommonScripts = [
            path.normalize(path.join(ROOT_DIR, 'kubejs', 'startup_scripts', '通用组件', 'Epiphy的小玩意-原版_其他Mod的隐藏物品.js')),
            path.normalize(path.join(ROOT_DIR, 'kubejs', 'startup_scripts', '通用组件', 'Epiphy的小玩意_功能测试.js'))
        ]
        var managedSet = {}
        for (var mi = 0; mi < componentMatrix.length; mi++) {
            managedSet[path.normalize(componentMatrix[mi].file)] = true
        }
        var commonDirs = [
            path.join(ROOT_DIR, 'kubejs', 'startup_scripts', '通用组件'),
            path.join(ROOT_DIR, 'kubejs', 'server_scripts',  '通用组件'),
            path.join(ROOT_DIR, 'kubejs', 'client_scripts',  '通用组件')
        ]
        var discoveredCommonFiles = []
        for (var cd = 0; cd < commonDirs.length; cd++) {
            if (!fs.existsSync(commonDirs[cd])) continue
            var ents = fs.readdirSync(commonDirs[cd])
            for (var ce = 0; ce < ents.length; ce++) {
                if (ents[ce].slice(-3) !== '.js') continue
                var fullFp = path.normalize(path.join(commonDirs[cd], ents[ce]))
                discoveredCommonFiles.push(fullFp)
                if (exemptCommonScripts.indexOf(fullFp) >= 0) continue
                assert.ok(managedSet[fullFp], 'Unmanaged common component detected (must register VERSION & header check in Test 67): ' + path.relative(ROOT_DIR, fullFp))
            }
        }
        assert.ok(discoveredCommonFiles.length >= componentMatrix.length, 'common component directory scan must discover all scripts')

        for (var i = 0; i < componentMatrix.length; i++) {
            var row = componentMatrix[i]
            assert.ok(row.obj && typeof row.obj.VERSION === 'string', row.name + ' must export its own semver VERSION string')
            var parsed = Spec.parseSemver(row.obj.VERSION)
            assert.ok(parsed != null, row.name + ' VERSION must be valid semver: ' + row.obj.VERSION)
            var headLines = fs.readFileSync(row.file, 'utf8').split(/\r?\n/).slice(0, 6).join('\n')
            var exactHeaderRe = new RegExp('\\bv' + parsed.major + '\\.' + parsed.minor + '\\.' + parsed.patch + '(?![.\\d])')
            assert.ok(exactHeaderRe.test(headLines), row.name + ' header must declare exact v' + row.obj.VERSION + ' (run `npm run sync-docs`)')
        }
        assert.strictEqual(sb.global.EpiphyAudio.VERSION, '5.8.0', 'EpiphyAudio must report its own 5.8.0 version')
        assert.strictEqual(sb.global.EpiphyAudioClient.VERSION, '5.6.0', 'EpiphyAudioClient must report its own 5.6.0 version')
        assert.strictEqual(sb.global.EpiphyDebug.VERSION, '1.0.0', 'EpiphyDebug must report its own 1.0.0 version')
        assert.strictEqual(sb.global.EpiphyBugfix.VERSION, '1.0.0', 'EpiphyBugfix must report its own 1.0.0 version')

        // 3b. Cross-document exact 3-segment semver parity & anti-drift guard (README.md, README_EN.md, README-LLM.md, roadmap)
        var roadmapDoc = fs.readFileSync(path.join(ROOT_DIR, 'docs', 'rendering-subsystem-roadmap.md'), 'utf8')
        var readmeZh   = fs.readFileSync(path.join(ROOT_DIR, 'README.md'), 'utf8')
        var readmeEn   = fs.readFileSync(path.join(ROOT_DIR, 'README_EN.md'), 'utf8')
        var readmeLlm  = fs.readFileSync(path.join(ROOT_DIR, 'README-LLM.md'), 'utf8')

        function hasExactDocVersion(text, label, verStr) {
            var esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            var re  = new RegExp(esc + '\\s+v' + verStr.replace(/\./g, '\\.') + '(?![.\\d])')
            return re.test(text)
        }

        // All 15 managed common components MUST have exact 3-segment vX.Y.Z parity in README.md AND README_EN.md
        var checkedDocVersions = 0
        for (var ri = 0; ri < componentMatrix.length; ri++) {
            var comp = componentMatrix[ri]
            var baseName = path.basename(comp.file)
            assert.ok(readmeZh.indexOf(baseName) >= 0, 'README.md must list common component: ' + baseName)
            assert.ok(readmeEn.indexOf(baseName) >= 0, 'README_EN.md must list common component: ' + baseName)
            assert.ok(hasExactDocVersion(readmeZh, comp.docTag, comp.obj.VERSION), 'README.md must declare exact `' + comp.docTag + ' v' + comp.obj.VERSION + '` (run `npm run sync-docs`)')
            assert.ok(hasExactDocVersion(readmeEn, comp.docTag, comp.obj.VERSION), 'README_EN.md must declare exact `' + comp.docTag + ' v' + comp.obj.VERSION + '` (run `npm run sync-docs`)')
            checkedDocVersions++
        }
        assert.ok(checkedDocVersions >= 15 && checkedDocVersions === componentMatrix.length, 'Test 67 must strictly verify all >=15 managed components across README.md & README_EN.md')

        var p32Line = roadmapDoc.split(/\r?\n/).find(function (l) { return l.indexOf('**P3-2**') >= 0 }) || ''
        assert.ok(hasExactDocVersion(p32Line, 'Epiphy3DFXCore', sb.global.Epiphy3DFXCore.VERSION), 'roadmap §8.1 P3-2 must match exact Epiphy3DFXCore v' + sb.global.Epiphy3DFXCore.VERSION)
        assert.ok(hasExactDocVersion(p32Line, 'Epiphy3DFXServer', sb.global.Epiphy3DFXServer.VERSION), 'roadmap §8.1 P3-2 must match exact Epiphy3DFXServer v' + sb.global.Epiphy3DFXServer.VERSION)
        assert.ok(hasExactDocVersion(p32Line, 'Epiphy3DFX', sb.global.Epiphy3DFX.VERSION), 'roadmap §8.1 P3-2 must match exact Epiphy3DFX v' + sb.global.Epiphy3DFX.VERSION)

        var llmP32Line = readmeLlm.split(/\r?\n/).find(function (l) { return l.indexOf('`P3-2`') >= 0 }) || ''
        assert.ok(hasExactDocVersion(llmP32Line, 'Epiphy3DFXCore', sb.global.Epiphy3DFXCore.VERSION), 'README-LLM.md §4 P3-2 must match exact Epiphy3DFXCore v' + sb.global.Epiphy3DFXCore.VERSION)
        assert.ok(hasExactDocVersion(llmP32Line, 'Epiphy3DFXServer', sb.global.Epiphy3DFXServer.VERSION), 'README-LLM.md §4 P3-2 must match exact Epiphy3DFXServer v' + sb.global.Epiphy3DFXServer.VERSION)
        assert.ok(hasExactDocVersion(llmP32Line, 'Epiphy3DFX', sb.global.Epiphy3DFX.VERSION), 'README-LLM.md §4 P3-2 must match exact Epiphy3DFX v' + sb.global.Epiphy3DFX.VERSION)

        var requiredInfraRefs = ['proto_v6_schema.json', 'rhino-check.js', 'sync-doc-versions.js']
        for (var ii = 0; ii < requiredInfraRefs.length; ii++) {
            assert.ok(readmeZh.indexOf(requiredInfraRefs[ii]) >= 0, 'README.md must reference ' + requiredInfraRefs[ii])
            assert.ok(readmeEn.indexOf(requiredInfraRefs[ii]) >= 0, 'README_EN.md must reference ' + requiredInfraRefs[ii])
        }
        // Guard against stale hardcoded test counts in top-level docs
        var docSet = [
            { name: 'README.md', text: readmeZh },
            { name: 'README_EN.md', text: readmeEn },
            { name: 'README-LLM.md', text: readmeLlm },
            { name: 'docs/rendering-subsystem-roadmap.md', text: roadmapDoc }
        ]
        for (var di = 0; di < docSet.length; di++) {
            assert.strictEqual(/(?:共\s*69\s*项|69\s*test cases|69\/69)/.test(docSet[di].text), false, docSet[di].name + ' must not carry stale hardcoded 69 test count')
        }
        assert.ok(readmeLlm.indexOf('P3-2') >= 0 && readmeLlm.indexOf('Epiphy3DFXServer') >= 0, 'README-LLM.md §4 must record P3-2 3D subsystem baseline')

        // 4. Out-of-range dependency version MUST be rejected fail-fast by downstream hard-dependent component
        var badCases = ['2.4.9', '3.0.0']
        for (var bi = 0; bi < badCases.length; bi++) {
            var badSb = {
                console: { info: function () {}, warn: function () {}, error: function () {}, debug: function () {}, log: function () {} },
                ServerEvents: { loaded: function () {}, unloaded: function () {}, tick: function () {}, commandRegistry: function () {}, command: function () {} },
                BlockEvents: { placed: function () {}, broken: function () {} },
                PlayerEvents: { loggedIn: function () {}, loggedOut: function () {} },
                Java: { loadClass: function () { return null } },
                global: {}
            }
            badSb.globalThis = badSb
            vm.createContext(badSb)
            loadServerBase(badSb)
            badSb.global.EpiphyServerCore.VERSION = badCases[bi]
            badSb.global.EpiphyServerBase.VERSION = badCases[bi]
            assert.throws(function () {
                runScriptIn(badSb, AUDIO_PATH)
            }, /版本不兼容/, 'EpiphyAudio must reject EpiphyServerCore version ' + badCases[bi] + ' outside [2.5.0, 2.99.99]')
        }
    })
}
