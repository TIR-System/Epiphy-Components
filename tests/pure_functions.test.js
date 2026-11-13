'use strict'

var assert = require('assert')
var fs     = require('fs')
var path   = require('path')
var vm     = require('vm')

var ROOT_DIR       = path.resolve(__dirname, '..')
var DANMAKU_PATH   = path.join(ROOT_DIR, 'kubejs', 'server_scripts', '通用组件', 'Epiphy的-屏幕弹幕组件.js')
var VALVE_PATH     = path.join(ROOT_DIR, 'kubejs', 'server_scripts', '通用组件', 'Epiphy的-权限阀.js')
var TRACKER_PATH   = path.join(ROOT_DIR, 'kubejs', 'server_scripts', '通用组件', 'Epiphy的-方块追踪组件.js')

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
})

// Run suite
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
