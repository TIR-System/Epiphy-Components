'use strict'

var assert = require('assert')
var fs     = require('fs')
var path   = require('path')
var vm     = require('vm')

var ROOT_DIR       = path.resolve(__dirname, '..')
var LOG_PATH       = path.join(ROOT_DIR, 'kubejs', 'server_scripts', '通用组件', 'Epiphy的-日志.js')
var TRACKER_PATH   = path.join(ROOT_DIR, 'kubejs', 'server_scripts', '通用组件', 'Epiphy的-方块追踪组件.js')
var VALVE_PATH     = path.join(ROOT_DIR, 'kubejs', 'server_scripts', '通用组件', 'Epiphy的-权限阀.js')
var DEBUG_PATH     = path.join(ROOT_DIR, 'kubejs', 'server_scripts', '通用组件', 'Epiphy的-调试组件.js')
var DANMAKU_PATH   = path.join(ROOT_DIR, 'kubejs', 'server_scripts', '通用组件', 'Epiphy的-屏幕弹幕组件.js')
var AUDIO_PATH        = path.join(ROOT_DIR, 'kubejs', 'server_scripts', '通用组件', 'Epiphy的-音频组件.js')
var RENDERER_PATH     = path.join(ROOT_DIR, 'kubejs', 'client_scripts', '通用组件', 'Epiphy的-屏幕弹幕渲染器.js')
var AUDIO_CLIENT_PATH = path.join(ROOT_DIR, 'kubejs', 'client_scripts', '通用组件', 'Epiphy的-音频播放器.js')

function createKubeSandbox(loadClassFn) {
    var noop = function () {}
    var sandbox = {
        console: {
            info:  noop,
            warn:  noop,
            error: noop,
            debug: noop,
            log:   noop
        },
        ServerEvents: {
            tick:            noop,
            commandRegistry: noop,
            command:         noop,
            unloaded:        noop
        },
        PlayerEvents: {
            loggedIn:  noop,
            loggedOut: noop
        },
        BlockEvents: {
            placed: noop,
            broken: noop
        },
        Java: {
            loadClass: typeof loadClassFn === 'function' ? loadClassFn : function () { return null }
        },
        Text: {
            of: function (s) { return String(s) }
        },
        global: {}
    }
    sandbox.globalThis = sandbox
    vm.createContext(sandbox)
    return sandbox
}

var sandbox = createKubeSandbox()
vm.runInContext(fs.readFileSync(VALVE_PATH, 'utf8'), sandbox, { filename: 'Epiphy的-权限阀.js' })
vm.runInContext(fs.readFileSync(DANMAKU_PATH, 'utf8'), sandbox, { filename: 'Epiphy的-屏幕弹幕组件.js' })

var Valve   = sandbox.global.EpiphyPermissionValve
var Danmaku = sandbox.global.ScreenDanmaku
var pure    = Danmaku && Danmaku._pure

assert.ok(Valve && typeof Valve.normalizePermissionPolicy === 'function', 'EpiphyPermissionValve.normalizePermissionPolicy must exist')
assert.ok(pure && typeof pure.parseSize === 'function', 'ScreenDanmaku._pure must be exported')

var tests = []
function test(name, fn) {
    tests.push({ name: name, fn: fn })
}

// vm.runInContext 创建的对象与宿主 Realm 原型不同，assert.deepStrictEqual 会因跨 Realm 原型报错，故归一化后深度对比
function plain(obj) {
    return JSON.parse(JSON.stringify(obj))
}

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

// ----------------------------------------------------------------------------
// 6. normalizePermissionPolicy (+ policy immutability & source classifier check)
// ----------------------------------------------------------------------------
test('normalizePermissionPolicy: returns mutable shallow clones without mutating frozen presets', function () {
    assert.strictEqual(Object.isFrozen(Valve.POLICIES.public), true)
    assert.strictEqual(Object.isFrozen(Valve.POLICIES.admin), true)

    var pDefault = Valve.normalizePermissionPolicy(undefined, null)
    assert.strictEqual(pDefault.mode, 'public')
    assert.strictEqual(Object.isFrozen(pDefault), false)
    pDefault.label = 'mutated'
    assert.notStrictEqual(Valve.POLICIES.public.label, 'mutated')

    var pZero = Valve.normalizePermissionPolicy(0, null)
    assert.strictEqual(pZero.mode, 'public')
    assert.strictEqual(Object.isFrozen(pZero), false, 'rawPolicy <= 0 must also return a cloned policy')
})

test('normalizePermissionPolicy: booleans, numbers, functions, strings & objects', function () {
    assert.strictEqual(Valve.normalizePermissionPolicy(true).mode, 'authorized')
    assert.strictEqual(Valve.normalizePermissionPolicy(false).mode, 'public')

    var lv3 = Valve.normalizePermissionPolicy(3.2)
    assert.strictEqual(lv3.mode, 'op_level_3')
    assert.strictEqual(lv3.opLevel, 3)
    assert.strictEqual(lv3.requireOp, true)

    var customFn = function () { return true }
    var pFn = Valve.normalizePermissionPolicy(customFn)
    assert.strictEqual(pFn.mode, 'custom')
    assert.strictEqual(pFn.customCheck, customFn)
    assert.strictEqual(pFn.allowDeclaredCallers, false)

    assert.strictEqual(Valve.normalizePermissionPolicy('公开').mode, 'public')
    assert.strictEqual(Valve.normalizePermissionPolicy('仅作弊').mode, 'cheats')
    assert.strictEqual(Valve.normalizePermissionPolicy('auth').mode, 'authorized')
    assert.strictEqual(Valve.normalizePermissionPolicy('管理员').mode, 'admin')

    var merged = Valve.normalizePermissionPolicy({
        mode:           'admin',
        opLevel:        4,
        allowedCallers: ['my_script', ' '],
        requireCheats:  false
    })
    assert.strictEqual(merged.mode, 'admin')
    assert.strictEqual(merged.opLevel, 4)
    assert.strictEqual(merged.requireCheats, false)
    assert.strictEqual(merged.requireOp, true)
    assert.deepStrictEqual(plain(merged.allowedCallers), { my_script: true })
})

test('permission valve classifyCommandSource: player source cannot escalate via declarationStack', function () {
    var fakePlayerSource = {
        player: { username: 'Steve', hasPermissions: function () { return false } }
    }
    Valve.declareCaller('test_caller', ['danmaku'])
    var resultInfo = null
    Valve.withDeclaration('test_caller', function () {
        resultInfo = Valve.classifyCommandSource(fakePlayerSource)
    })
    assert.strictEqual(resultInfo.kind, 'player')
    assert.strictEqual(Valve.classifyCommandSource(null).kind, 'untrusted_other')
})

test('permission valve evaluateSourceAccess: declared server.runCommand cannot bypass allowConsole=false', function () {
    function MockMinecraftServer() {}
    function MockServerPlayer() {}
    var isoSandbox = createKubeSandbox(function (clsName) {
        if (clsName === 'net.minecraft.server.MinecraftServer') return MockMinecraftServer
        if (clsName === 'net.minecraft.server.level.ServerPlayer') return MockServerPlayer
        return null
    })
    vm.runInContext(fs.readFileSync(VALVE_PATH, 'utf8'), isoSandbox, { filename: 'Epiphy的-权限阀.js' })
    var IsoValve = isoSandbox.global.EpiphyPermissionValve
    IsoValve.declareCaller('danmaku_script', ['danmaku'])

    var serverSource = {
        source: new MockMinecraftServer(),
        hasPermission: function (lv) { return lv <= 4 }
    }
    var lowPermServerSource = {
        source: new MockMinecraftServer(),
        hasPermission: function () { return false }
    }

    // Direct console outside withDeclaration
    assert.strictEqual(IsoValve.classifyCommandSource(serverSource).kind, 'console')
    assert.strictEqual(
        IsoValve.evaluateSourceAccess(serverSource, 'danmaku', {
            mode: 'custom', allowConsole: false, allowDeclaredCallers: true
        }).allowed,
        false
    )

    // Console carrier inside withDeclaration: respects BOTH allowConsole & allowDeclaredCallers
    var clsInside = null
    var resNoConsole = null
    var resLowPerm = null
    var resAllowed = null
    var resNoDeclared = null
    var resAbstractCarrier = null

    IsoValve.withDeclaration('danmaku_script', function () {
        clsInside = IsoValve.classifyCommandSource(serverSource)
        resNoConsole = IsoValve.evaluateSourceAccess(serverSource, 'danmaku', {
            mode: 'custom', allowConsole: false, allowDeclaredCallers: true
        })
        resLowPerm = IsoValve.evaluateSourceAccess(lowPermServerSource, 'danmaku', {
            mode: 'custom', allowConsole: true, allowDeclaredCallers: true, requireOp: true, opLevel: 4
        })
        resAllowed = IsoValve.evaluateSourceAccess(serverSource, 'danmaku', {
            mode: 'custom', allowConsole: true, allowDeclaredCallers: true
        })
        resNoDeclared = IsoValve.evaluateSourceAccess(serverSource, 'danmaku', {
            mode: 'custom', allowConsole: true, allowDeclaredCallers: false
        })
        resAbstractCarrier = IsoValve.evaluateSourceAccess({}, 'danmaku', {
            mode: 'custom', allowConsole: false, allowDeclaredCallers: true
        })
    })

    assert.strictEqual(clsInside.kind, 'declared_function')
    assert.strictEqual(clsInside.isConsoleCarrier, true)
    assert.strictEqual(resNoConsole.allowed, false)
    assert.strictEqual(resLowPerm.allowed, false)
    assert.strictEqual(resAllowed.allowed, true)
    assert.strictEqual(resAllowed.sourceKind, 'declared_function')
    assert.strictEqual(resNoDeclared.allowed, false)
    assert.strictEqual(resAbstractCarrier.allowed, true)
})

// ----------------------------------------------------------------------------
// 7. block tracker scan scoping (bind/scanNow do not clear global state)
// ----------------------------------------------------------------------------
test('block tracker: bind() & scanNow() preserve pure-air LRU, queued work and tracked records', function () {
    var tickHandlers = []
    var isoSandbox = createKubeSandbox()
    isoSandbox.ServerEvents.tick = function (fn) { tickHandlers.push(fn) }

    vm.runInContext(fs.readFileSync(TRACKER_PATH, 'utf8'), isoSandbox, { filename: 'Epiphy的-方块追踪组件.js' })
    var Tracker = isoSandbox.global.EpiphyBlockTracker
    assert.ok(Tracker && typeof Tracker.createTracker === 'function', 'EpiphyBlockTracker must export createTracker')

    // Build mock 16x16x16 section arrays spanning y=[0..63] (sy = 0..3) with sy=0 non-air and sy=1..3 air
    function makeChunk(hasSolidBlock) {
        var solidSection = {
            hasOnlyAir: function () { return false },
            maybeHas: function () { return true },
            getBlockState: function (lx, ly, lz) {
                if (hasSolidBlock && lx === 2 && ly === 0 && lz === 3) {
                    return { id: 'epiphy:block_a', isAir: function () { return false } }
                }
                return { id: 'minecraft:air', isAir: function () { return true } }
            }
        }
        var airSection = {
            hasOnlyAir: function () { return true },
            maybeHas: function () { return false },
            getBlockState: function () { return { id: 'minecraft:air', isAir: function () { return true } } }
        }
        return {
            getMinBuildHeight: function () { return 0 },
            getSections: function () { return [solidSection, airSection, airSection, airSection] }
        }
    }

    var chunk00 = makeChunk(true)
    var mockLevel = {
        dimension: 'minecraft:overworld',
        getMinBuildHeight: function () { return 0 },
        getMaxBuildHeight: function () { return 64 },
        getChunkSource: function () {
            return {
                getChunkNow: function (cx, cz) {
                    return (cx === 0 && cz === 0) ? chunk00 : null
                }
            }
        },
        getBlock: function () { return { id: 'epiphy:block_a' } }
    }
    var mockServer = {
        getLevel: function (d) { return d === 'minecraft:overworld' ? mockLevel : null },
        getAllLevels: function () { return [mockLevel] },
        getPlayerList: function () {
            return {
                getPlayers: function () {
                    return [{ level: mockLevel, x: 8, y: 8, z: 8 }]
                }
            }
        }
    }

    var subA = Tracker.createTracker({ name: 'sub_a' })
    var subB = Tracker.createTracker({ name: 'sub_b' })
    subA.bind('epiphy:block_a', { scanRadius: 8 })

    // Tick 1: enqueues non-air sy=0 (1 section), caches sy=1 (air) with AIR_SECTION_VER, and scans sy=0 finding 1 block
    assert.strictEqual(tickHandlers.length, 1)
    tickHandlers[0]({ server: mockServer })

    var s1 = Tracker.getStats()
    assert.strictEqual(s1.trackedBlocksSize, 1)
    assert.strictEqual(s1.bindingsVersion, 1)
    assert.ok(s1.scannedSectionsSize >= 2, 'scannedSections should retain solid + air sections')

    // Re-binding the SAME blockId for subB must NOT clear scannedSections or bump bindingsVersion
    subB.bind('epiphy:block_a', { scanRadius: 16 })
    var s2 = Tracker.getStats()
    assert.strictEqual(s2.bindingsVersion, 1)
    assert.strictEqual(s2.scannedSectionsSize, s1.scannedSectionsSize)

    // Binding a BRAND NEW blockId bumps bindingsVersion lazily without wiping scannedSections
    subB.bind('epiphy:block_b', { scanRadius: 12 })
    var s3 = Tracker.getStats()
    assert.strictEqual(s3.bindingsVersion, 2)
    assert.strictEqual(s3.scannedSectionsSize, s1.scannedSectionsSize, 'bind() must preserve cached air & non-air entries')

    // subA.scanNow() only enqueues non-air sections within subA radius without wiping global cache or duplicating queue
    var queued = subA.scanNow()
    var s4 = Tracker.getStats()
    assert.strictEqual(queued, 1, 'only non-air section (sy=0) within subA radius should re-enqueue; air stays skipped')
    assert.strictEqual(s4.pendingScanCount, 1)

    // Second scanNow() while still pending must not duplicate queue entries
    var queuedAgain = subA.scanNow()
    assert.strictEqual(queuedAgain, 0)
    assert.strictEqual(Tracker.getStats().pendingScanCount, 1)

    // getTrackedRecords() increments call counters cleanly
    var recs = subA.getTrackedRecords(null)
    assert.strictEqual(recs.length, 1)
    assert.strictEqual(Tracker.getStats().getTrackedRecordsCalls, 1)
    assert.strictEqual(Tracker.getStats().subscriberCalls.sub_a, 1)

    // rescanAll() clears global section LRU explicitly and re-enqueues nearby non-air sections
    var rescanEnqueued = Tracker.rescanAll()
    assert.ok(rescanEnqueued >= 1)
})

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

    // Load all 6 server components in real KubeJS priority order (1100 -> 1050 -> 1000 -> 950 -> 500 -> 500)
    vm.runInContext(fs.readFileSync(LOG_PATH, 'utf8'), isoSandbox, { filename: 'Epiphy的-日志.js' })
    vm.runInContext(fs.readFileSync(TRACKER_PATH, 'utf8'), isoSandbox, { filename: 'Epiphy的-方块追踪组件.js' })
    vm.runInContext(fs.readFileSync(VALVE_PATH, 'utf8'), isoSandbox, { filename: 'Epiphy的-权限阀.js' })
    vm.runInContext(fs.readFileSync(DEBUG_PATH, 'utf8'), isoSandbox, { filename: 'Epiphy的-调试组件.js' })
    vm.runInContext(fs.readFileSync(DANMAKU_PATH, 'utf8'), isoSandbox, { filename: 'Epiphy的-屏幕弹幕组件.js' })
    vm.runInContext(fs.readFileSync(AUDIO_PATH, 'utf8'), isoSandbox, { filename: 'Epiphy的-音频组件.js' })

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
    assert.ok(byName.tracker.summaryText.indexOf('scanQueue.length=') >= 0)
    assert.ok(byName.tracker.summaryText.indexOf('trackedBlocks.size=') >= 0)
    assert.ok(byName.tracker.summaryText.indexOf('getTrackedRecords=') >= 0)
    assert.ok(byName.audio.summaryText.indexOf('handles.size=1') >= 0, 'audio summary: ' + byName.audio.summaryText)
    assert.ok(byName.audio.summaryText.indexOf('syncAll=') >= 0)

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

// Run suite
// ----------------------------------------------------------------------------
// Shared mock world builders for integration-style module tests (14-18)
// ----------------------------------------------------------------------------
function makeMockWorld(opts) {
    var dim = (opts && opts.dim) || 'minecraft:overworld'
    var blockMap = new Map() // "x,y,z" -> blockId
    var unloadedChunks = new Set() // "cx,cz"
    var throwingChunks = new Set() // "cx,cz"
    var oobChunks      = new Set() // "cx,cz"
    var players = []

    function coordKey(x, y, z) {
        return Math.floor(x) + ',' + Math.floor(y) + ',' + Math.floor(z)
    }

    function makeBlockContainer(x, y, z, forcedId) {
        var ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z)
        var id = forcedId !== undefined ? forcedId : (blockMap.get(coordKey(ix, iy, iz)) || 'minecraft:air')
        return {
            x: ix,
            y: iy,
            z: iz,
            id: id,
            level: level,
            getId: function () { return id },
            getBlockState: function () {
                return {
                    id: id,
                    isAir: function () { return id === 'minecraft:air' }
                }
            }
        }
    }

    function buildChunkAt(cx, cz) {
        if (unloadedChunks.has(cx + ',' + cz)) return null
        if (throwingChunks.has(cx + ',' + cz)) {
            return {
                getMinBuildHeight: function () { return 0 },
                getSections: function () { throw new Error('synthetic chunk read error') }
            }
        }
        var sectionCount = oobChunks.has(cx + ',' + cz) ? 1 : 6
        var sections = []
        for (var sy = 0; sy < sectionCount; sy++) {
            (function (secY) {
                sections.push({
                    hasOnlyAir: function () {
                        var match = false
                        blockMap.forEach(function (bid, k) {
                            if (bid === 'minecraft:air') return
                            var parts = k.split(',')
                            var bx = Number(parts[0]), by = Number(parts[1]), bz = Number(parts[2])
                            if ((bx >> 4) === cx && (bz >> 4) === cz && (by >> 4) === secY) match = true
                        })
                        return !match
                    },
                    maybeHas: function (pred) {
                        var hit = false
                        blockMap.forEach(function (bid, k) {
                            var parts = k.split(',')
                            var bx = Number(parts[0]), by = Number(parts[1]), bz = Number(parts[2])
                            if ((bx >> 4) === cx && (bz >> 4) === cz && (by >> 4) === secY) {
                                if (pred({ id: bid, isAir: function () { return bid === 'minecraft:air' } })) hit = true
                            }
                        })
                        return hit
                    },
                    getBlockState: function (lx, ly, lz) {
                        var wx = (cx << 4) + lx
                        var wy = (secY << 4) + ly
                        var wz = (cz << 4) + lz
                        var bid = blockMap.get(coordKey(wx, wy, wz)) || 'minecraft:air'
                        return { id: bid, isAir: function () { return bid === 'minecraft:air' } }
                    }
                })
            })(sy)
        }
        return {
            getMinBuildHeight: function () { return 0 },
            getSections: function () { return sections }
        }
    }

    var level = {
        dimension: dim,
        getMinBuildHeight: function () { return 0 },
        getMaxBuildHeight: function () { return 96 },
        getBlock: function (x, y, z) { return makeBlockContainer(x, y, z) },
        getChunkSource: function () {
            return {
                getChunkNow: function (cx, cz) { return buildChunkAt(cx, cz) }
            }
        },
        hasChunk: function (cx, cz) { return !unloadedChunks.has(cx + ',' + cz) },
        getChunk: function (cx, cz) { return buildChunkAt(cx, cz) },
        players: {
            size: function () { return players.length },
            get: function (i) { return players[i] }
        }
    }

    function addPlayer(name, uuid, x, y, z) {
        var sentPackets = []
        var p = {
            username: name,
            uuid: uuid,
            level: level,
            _pos: { x: x, y: y, z: z },
            block: null,
            getStringUUID: function () { return uuid },
            getId: function () { return players.indexOf(p) + 1 },
            getX: function () { return p._pos.x },
            getY: function () { return p._pos.y },
            getZ: function () { return p._pos.z },
            sendData: function (ch, pkt) { sentPackets.push({ channel: ch, pkt: pkt }) },
            tell: function () {},
            sentPackets: sentPackets,
            moveTo: function (nx, ny, nz) { p._pos.x = nx; p._pos.y = ny; p._pos.z = nz }
        }
        players.push(p)
        return p
    }

    var levelsEnabled = true
    var server = {
        getAllLevels: function () { return levelsEnabled ? [level] : [] },
        getLevel: function (d) { return (levelsEnabled && String(d) === dim) ? level : null },
        getPlayerList: function () {
            return {
                getPlayers: function () { return players }
            }
        },
        persistentData: {}
    }

    return {
        dim: dim,
        level: level,
        server: server,
        players: players,
        unloadedChunks: unloadedChunks,
        throwingChunks: throwingChunks,
        oobChunks: oobChunks,
        setLevelsEnabled: function (v) { levelsEnabled = Boolean(v) },
        setBlock: function (x, y, z, id) {
            var k = coordKey(x, y, z)
            if (id === 'minecraft:air' || id == null) blockMap.delete(k)
            else blockMap.set(k, id)
        },
        makeBlock: makeBlockContainer,
        addPlayer: addPlayer
    }
}

function attachSandboxEventHooks(isoSandbox) {
    var hooks = {
        tick: [],
        placed: [],
        broken: [],
        loggedIn: [],
        loggedOut: []
    }
    isoSandbox.ServerEvents.tick      = function (fn) { hooks.tick.push(fn) }
    isoSandbox.BlockEvents.placed     = function (fn) { hooks.placed.push(fn) }
    isoSandbox.BlockEvents.broken     = function (fn) { hooks.broken.push(fn) }
    isoSandbox.PlayerEvents.loggedIn  = function (fn) { hooks.loggedIn.push(fn) }
    isoSandbox.PlayerEvents.loggedOut = function (fn) { hooks.loggedOut.push(fn) }
    return hooks
}

// ----------------------------------------------------------------------------
// 14. block tracker abort rollbacks, queue-full status & timing telemetry
// ----------------------------------------------------------------------------
test('block tracker: scan aborts rollback LRU, reports queue-full status & records active-only timing', function () {
    var nsNow = 1000000
    var isoSandbox = createKubeSandbox(function (cls) {
        if (cls === 'java.lang.System') return { nanoTime: function () { return (nsNow += 250000) } }
        return null
    })
    var hooks = attachSandboxEventHooks(isoSandbox)
    vm.runInContext(fs.readFileSync(TRACKER_PATH, 'utf8'), isoSandbox, { filename: 'Epiphy的-方块追踪组件.js' })
    vm.runInContext(fs.readFileSync(DEBUG_PATH, 'utf8'), isoSandbox, { filename: 'Epiphy的-调试组件.js' })

    var Tracker = isoSandbox.global.EpiphyBlockTracker
    var Debug   = isoSandbox.global.EpiphyDebug
    var world   = makeMockWorld()
    world.addPlayer('Tester', '00000000-0000-0000-0000-000000000001', 8, 24, 8)
    world.setBlock(2, 20, 3, 'epiphy:probe_a')
    // Populate 17 additional sections within radius 48 using stone (18 non-air sections total > min maxScanQueue=16)
    var dummyStones = []
    for (var cx = -2; cx <= 2 && dummyStones.length < 17; cx++) {
        for (var cz = -2; cz <= 2 && dummyStones.length < 17; cz++) {
            if (cx === 0 && cz === 0) continue
            var sx = (cx << 4) + 2
            var sz = (cz << 4) + 3
            dummyStones.push([sx, 20, sz])
            world.setBlock(sx, 20, sz, 'minecraft:stone')
        }
    }

    Tracker.configure({ maxScanQueue: 16, scanSectionsPerTick: 1, scanEnqInterval: 999 })
    // Advance once BEFORE binding so SERVER_REF is initialized without pre-filling scanQueue
    for (var ti = 0; ti < hooks.tick.length; ti++) hooks.tick[ti]({ server: world.server })

    var bindingChangedCalls = []
    var sub = Tracker.createTracker({
        name: 'probe_sub',
        onBindingChanged: function (idStr, meta, prevMeta) {
            bindingChangedCalls.push({ id: idStr, r: meta && meta.scanRadius, prevR: prevMeta && prevMeta.scanRadius })
        }
    })
    sub.bind('epiphy:probe_a', { scanRadius: 48 })
    sub.bind('epiphy:probe_a', { scanRadius: 64 })
    assert.strictEqual(bindingChangedCalls.length, 2)
    assert.strictEqual(bindingChangedCalls[1].prevR, 48)
    assert.strictEqual(bindingChangedCalls[1].r, 64)

    // Saturate scan queue cleanly and verify blockedByQueue status via sub.scanNow()
    var nFirst = sub.scanNow()
    var st1 = Tracker.getLastScanStatus()
    assert.strictEqual(nFirst, 16)
    assert.strictEqual(st1.truncatedByQueue, true)
    assert.strictEqual(st1.blockedByQueue, false)

    var nBlocked = sub.scanNow()
    var st2 = Tracker.getLastScanStatus()
    assert.strictEqual(nBlocked, 0)
    assert.strictEqual(st2.blockedByQueue, true)
    var rescanRes = Debug.runAction('tracker', 'rescan')
    assert.strictEqual(rescanRes.ok, true)
    assert.ok(rescanRes.message.includes('已满'))

    // Clear queue cleanly (unload all dummy chunks & remove helper stones) before testing abort rollbacks on chunk (0,0)
    Tracker.configure({ maxScanQueue: 16, scanSectionsPerTick: 1 })
    for (var ucx = -2; ucx <= 2; ucx++) {
        for (var ucz = -2; ucz <= 2; ucz++) {
            world.unloadedChunks.add(ucx + ',' + ucz)
        }
    }
    for (var d = 0; d < 18; d++) {
        for (var ti2 = 0; ti2 < hooks.tick.length; ti2++) hooks.tick[ti2]({ server: world.server })
    }
    world.unloadedChunks.clear()
    for (var sj = 0; sj < dummyStones.length; sj++) {
        world.setBlock(dummyStones[sj][0], dummyStones[sj][1], dummyStones[sj][2], 'minecraft:air')
    }
    assert.strictEqual(Tracker.getStats().trackedBlocksSize, 0)

    // Test 1: lv == null abort rollback
    world.unloadedChunks.delete('0,0')
    world.setLevelsEnabled(false)
    Tracker.configure({ maxScanQueue: 32 })
    world.players[0].moveTo(8, 20, 8)
    sub.bind('epiphy:probe_a', { scanRadius: 16 })
    // Enqueue with levels disabled -> re-enable -> queue has tasks but if level goes null during consume:
    world.setLevelsEnabled(true)
    assert.ok(Tracker.rescanAll() > 0)
    var scannedBeforeNull = Tracker.getStats().scannedSectionsSize
    assert.ok(scannedBeforeNull > 0)
    world.setLevelsEnabled(false)
    for (var k = 0; k < 2; k++) {
        for (var ti3 = 0; ti3 < hooks.tick.length; ti3++) hooks.tick[ti3]({ server: world.server })
    }
    // At least one consumed task rolled back its scannedSections mark!
    assert.ok(Tracker.getStats().scannedSectionsSize < scannedBeforeNull)

    // Test 2: throwing chunk scan rolls back LRU cleanly instead of poisoning section
    world.setLevelsEnabled(true)
    world.throwingChunks.add('0,0')
    // Drain queue while chunk (0,0) throws
    for (var d2 = 0; d2 < 20; d2++) {
        for (var ti4 = 0; ti4 < hooks.tick.length; ti4++) hooks.tick[ti4]({ server: world.server })
    }
    assert.strictEqual(Tracker.getStats().trackedBlocksSize, 0)
    // Fix chunk (0,0) and rescan WITHOUT needing bindingsVersion bump -> rolls back worked!
    world.throwingChunks.delete('0,0')
    var reEnqueued = Tracker.rescanAll()
    assert.ok(reEnqueued > 0)
    for (var d3 = 0; d3 < 20; d3++) {
        for (var ti5 = 0; ti5 < hooks.tick.length; ti5++) hooks.tick[ti5]({ server: world.server })
    }
    assert.strictEqual(Tracker.getStats().trackedBlocksSize, 1)

    // Test 3: secIdx OOB rolls back LRU when sections array grows later
    world.setBlock(2, 40, 3, 'epiphy:probe_a') // sy=2 (y=32..47)
    world.oobChunks.add('0,0')
    Tracker.rescanAll()
    for (var d4 = 0; d4 < 25; d4++) {
        for (var ti6 = 0; ti6 < hooks.tick.length; ti6++) hooks.tick[ti6]({ server: world.server })
    }
    assert.strictEqual(Tracker.getStats().trackedBlocksSize, 1)
    world.oobChunks.delete('0,0')
    assert.ok(Tracker.rescanAll() > 0)
    for (var d5 = 0; d5 < 25; d5++) {
        for (var ti7 = 0; ti7 < hooks.tick.length; ti7++) hooks.tick[ti7]({ server: world.server })
    }
    assert.strictEqual(Tracker.getStats().trackedBlocksSize, 2)

    // Timing metrics check
    var stats = Tracker.getStats()
    assert.ok(stats.tickAllCount > 0 && stats.lastActiveTickAllMs > 0 && stats.scanSliceCount > 0)
    var resetRes = Debug.runAction('tracker', 'resetmetrics')
    assert.strictEqual(resetRes.ok, true)
    assert.ok(resetRes.message.includes('清零'))
    assert.strictEqual(Tracker.getStats().tickAllCount, 0)
})

// ----------------------------------------------------------------------------
// 15. danmaku: onBindingChanged cache invalidation & first/latest/nearest/stagger arbitration
// ----------------------------------------------------------------------------
test('danmaku: onBindingChanged invalidates scope cache & first/latest/nearest/stagger conflict arbitration', function () {
    var isoSandbox = createKubeSandbox()
    var hooks = attachSandboxEventHooks(isoSandbox)
    vm.runInContext(fs.readFileSync(TRACKER_PATH, 'utf8'), isoSandbox, { filename: 'Epiphy的-方块追踪组件.js' })
    vm.runInContext(fs.readFileSync(DEBUG_PATH, 'utf8'), isoSandbox, { filename: 'Epiphy的-调试组件.js' })

    var capturedDanmakuSub = null
    var origCreateTracker = isoSandbox.global.EpiphyBlockTracker.createTracker
    isoSandbox.global.EpiphyBlockTracker.createTracker = function (cfg) {
        var sub = origCreateTracker(cfg)
        if (cfg && cfg.name === 'danmaku') capturedDanmakuSub = sub
        return sub
    }
    vm.runInContext(fs.readFileSync(DANMAKU_PATH, 'utf8'), isoSandbox, { filename: 'Epiphy的-屏幕弹幕组件.js' })

    var Tracker = isoSandbox.global.EpiphyBlockTracker
    var Debug   = isoSandbox.global.EpiphyDebug
    var Danmaku = isoSandbox.global.ScreenDanmaku
    var world   = makeMockWorld()
    var alice   = world.addPlayer('Alice', '00000000-0000-0000-0000-000000000010', 8, 20, 0)

    function getDanmakuRev() {
        var detail = Debug.collectSnapshot('danmaku').modules[0].detailLines.join('\n')
        var m = /boundScopeRevision=(\d+)/.exec(detail)
        return m ? Number(m[1]) : -1
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
    vm.runInContext(fs.readFileSync(TRACKER_PATH, 'utf8'), isoSandbox, { filename: 'Epiphy的-方块追踪组件.js' })
    vm.runInContext(fs.readFileSync(DEBUG_PATH, 'utf8'), isoSandbox, { filename: 'Epiphy的-调试组件.js' })
    vm.runInContext(fs.readFileSync(DANMAKU_PATH, 'utf8'), isoSandbox, { filename: 'Epiphy的-屏幕弹幕组件.js' })

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
    var dmSnap    = Debug.collectSnapshot('danmaku')
    var detailStr = dmSnap.modules[0].detailLines.join('\n')
    assert.ok(detailStr.includes('emitCycleMs:') && !detailStr.includes('cycles=0'))

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
// 17. audio: syncAll idle skip, conflict arbitration & merged connected block clusters
// ----------------------------------------------------------------------------
test('audio: syncAll skips 0-handle ticks, arbitrates conflicts & merges block clusters with union + seamless break', function () {
    var nsNow = 1000000
    var isoSandbox = createKubeSandbox(function (cls) {
        if (cls === 'java.lang.System') return { nanoTime: function () { return (nsNow += 150000) } }
        return null
    })
    var hooks = attachSandboxEventHooks(isoSandbox)
    vm.runInContext(fs.readFileSync(TRACKER_PATH, 'utf8'), isoSandbox, { filename: 'Epiphy的-方块追踪组件.js' })
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
    assert.ok(audSnap.modules[0].detailLines.join('\n').includes('syncAllCount: 0,'))

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

// ----------------------------------------------------------------------------
// 18. client renderer: batched glow (16-angle) & stroke (8-angle) outline passes and negative Z ordering
// ----------------------------------------------------------------------------
test('renderer: batched glow (8 outer + 4 inner) and stroke (8-angle) emit smooth circular passes with negative monotonic Z', function () {
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
        console: { info: function () {}, warn: function () {}, error: function () {}, debug: function () {}, log: function () {} },
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
    vm.runInContext(fs.readFileSync(RENDERER_PATH, 'utf8'), cliSandbox, { filename: 'Epiphy的-屏幕弹幕渲染器.js' })

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

    // Expect 12 outline draws (8 outer @ 22.5deg + 4 cardinal inner) + 1 foreground core = 13 draws
    assert.strictEqual(draws.length, 13)
    var glowOutlines = draws.slice(0, 12)
    var glowCore     = draws[12]
    assert.strictEqual(glowCore.rgb, 0x8CE6FF)
    assert.strictEqual(glowCore.alpha, 255)
    assert.strictEqual(glowCore.z, 0)
    for (var gi = 0; gi < glowOutlines.length; gi++) {
        assert.strictEqual(glowOutlines[gi].rgb, 0xD82038)
        assert.ok(glowOutlines[gi].alpha >= 28, 'outline alpha must stay safely above MC 0.1 alpha cutoff')
        assert.ok(glowOutlines[gi].z < 0, 'outline z must be strictly negative behind core')
        if (gi > 0) {
            assert.ok(glowOutlines[gi].z > glowOutlines[gi - 1].z, 'outline z must increase monotonically toward core')
        }
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
    vm.runInContext(fs.readFileSync(RENDERER_PATH, 'utf8'), cliSandbox, { filename: 'Epiphy的-屏幕弹幕渲染器.js' })

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
        this.res = res; this.f_119573_ = vol; this.pit = pit; this.loop = loop
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
                if (cls === 'net.minecraft.resources.ResourceLocation') return function (s) { return String(s) }
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
    assert.ok(playCalls[0].f_119573_ > 0.7, 'SimpleSoundInstance Java volume (f_119573_) must sync past initial fadeIn 0.02')

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
            hasColorEmoji: function () { return false },
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
            return fakeLayoutsByStr[cacheKey]
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
    vm.runInContext(fs.readFileSync(RENDERER_PATH, 'utf8'), cliSandbox, { filename: 'Epiphy的-屏幕弹幕渲染器.js' })

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

    // 绘制第 1 帧：probe(1 canary) + frame0 canary(1) + 'A'(1) + 'B'(1) = 4 次 lookup（空格 0 次）；每可见字 13 次 drawText -> 共 26 次
    paintHandlers[0](ev)
    assert.strictEqual(drawCalls.length, 26, 'A and B only (spaces culled) * 13 passes = 26 TextLayout.drawText calls')
    assert.strictEqual(pushCalls, 0, 'zero PoseStack.push JNI calls when Matrix4f supports rotateZ/scale')
    assert.strictEqual(popCalls, 0, 'zero PoseStack.pop JNI calls')
    assert.strictEqual(rotateDegCalls, 0, 'zero PoseStack.rotateDeg JNI calls')
    assert.strictEqual(glBlendQueries, 0, 'zero GL11.glIsEnabled GPU sync stalls when batched succeeds')
    assert.strictEqual(flushCalls, 1)
    assert.ok(drawCalls.every(function (d) { return d.mode === 1 }), 'all glow & core passes must share MODE_SDF_FILL(1) to prevent BufferSource batch breaks')

    // 2. 连续绘制第 2~5 帧：cf._muiLayout 应命中缓存，只有每帧 1 次 canary 检查，无多余 lookupFormattedLayout
    var lookupsAfterFrame1 = lookupCount
    drawCalls.length = 0
    for (var fi = 0; fi < 4; fi++) {
        paintHandlers[0](ev)
    }
    assert.strictEqual(drawCalls.length, 26 * 4)
    assert.strictEqual(lookupCount - lookupsAfterFrame1, 4, 'only 1 canary check per frame, 0 redundant glyph layout lookups')

    // 3. 模拟 F3+T 资源重载（TextLayoutEngine 返回新 canary 实例）：应立即递增 MUI_EPOCH 并刷新单位缓存
    currentEpochObj.ver = 2
    drawCalls.length = 0
    paintHandlers[0](ev)
    assert.strictEqual(drawCalls.length, 26)
    assert.ok(drawCalls.every(function (d) { return d.key.indexOf('2:') === 0 }), 'must immediately switch to post-reload TextLayout epoch 2')

    // 4. stroke 模式在 ModernUI SDF 下（outlineWidth=1.05 <= 1.15）仅需 8 外圈 + 1 主体 = 9 次 drawText
    Client.clear('*')
    drawCalls.length = 0
    Client.push({
        title: 'X',
        typewriter: false,
        color: 0x55FF55,
        outlineMode: 'stroke',
        outlineColor: 0x050A10,
        outlineWidth: 1.05,
        stay: 100
    })
    paintHandlers[0](ev)
    assert.strictEqual(drawCalls.length, 9)
})

var passed = 0
for (var i = 0; i < tests.length; i++) {
    var t = tests[i]
    try {
        t.fn()
        passed++
        console.log('[PASS] ' + t.name)
    } catch (err) {
        console.error('[FAIL] ' + t.name)
        console.error(err && err.stack ? err.stack : err)
        process.exitCode = 1
    }
}
console.log('Summary: ' + passed + '/' + tests.length + ' passed')
