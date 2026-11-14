// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
'use strict'

var assert = require('assert')
var fs     = require('fs')
var path   = require('path')
var vm     = require('vm')

var ROOT_DIR         = path.resolve(__dirname, '..')
var SPEC_PATH        = path.join(ROOT_DIR, 'kubejs', 'startup_scripts', '通用组件', 'Epiphy的-Spec与通用工具.js')
var LOG_PATH         = path.join(ROOT_DIR, 'kubejs', 'server_scripts', '通用组件', 'Epiphy的-日志.js')
var SERVER_BASE_PATH = path.join(ROOT_DIR, 'kubejs', 'server_scripts', '通用组件', 'Epiphy的-服务端基础.js')
var TRACKER_PATH     = path.join(ROOT_DIR, 'kubejs', 'server_scripts', '通用组件', 'Epiphy的-方块追踪组件.js')
var VALVE_PATH     = path.join(ROOT_DIR, 'kubejs', 'server_scripts', '通用组件', 'Epiphy的-权限阀.js')
var DEBUG_PATH        = path.join(ROOT_DIR, 'kubejs', 'server_scripts', '通用组件', 'Epiphy的-调试组件.js')
var BUGFIX_PATH       = path.join(ROOT_DIR, 'kubejs', 'server_scripts', '通用组件', 'Epiphy的-基础bug修复.js')
var DANMAKU_PATH      = path.join(ROOT_DIR, 'kubejs', 'server_scripts', '通用组件', 'Epiphy的-屏幕弹幕组件.js')
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

function attachConsoleCapture(sb) {
    var cap = { infos: [], warns: [], errors: [] }
    sb.console.info = function (m) { cap.infos.push(String(m)) }
    sb.console.warn = function (m) { cap.warns.push(String(m)) }
    sb.console.error = function (m) { cap.errors.push(String(m)) }
    return cap
}

function runScriptIn(sb, scriptPath) {
    vm.runInContext(fs.readFileSync(scriptPath, 'utf8'), sb, { filename: path.basename(scriptPath) })
    return sb
}

function loadStartupBase(sb) {
    runScriptIn(sb, SPEC_PATH)
    return sb
}

function loadServerBase(sb) {
    loadStartupBase(sb)
    runScriptIn(sb, LOG_PATH)
    runScriptIn(sb, SERVER_BASE_PATH)
    return sb
}

var sandbox = createKubeSandbox()
loadServerBase(sandbox)
runScriptIn(sandbox, VALVE_PATH)
runScriptIn(sandbox, DANMAKU_PATH)

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
    assert.strictEqual(Valve.normalizePermissionPolicy('authorized').mode, 'authorized')
    assert.strictEqual(Valve.normalizePermissionPolicy('auth').mode, 'admin', '"auth" must NOT alias authorized; unknown string must fail closed to admin')
    assert.strictEqual(Valve.normalizePermissionPolicy({ mode: 'auth' }).mode, 'admin', 'object mode:"auth" must also fail closed to admin')
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
    var callerTok = Valve.declareCaller('test_caller', ['danmaku'])
    assert.ok(callerTok && callerTok.__isEpiphyDeclToken === true)
    var resultInfo = null
    Valve.withDeclaration(callerTok, function () {
        resultInfo = Valve.classifyCommandSource(fakePlayerSource)
    })
    assert.strictEqual(resultInfo.kind, 'player')
    assert.strictEqual(Valve.classifyCommandSource(null).kind, 'untrusted_other')
})

test('permission valve evaluateSourceAccess: declared server.runCommand cannot bypass allowConsole=false or ambient carriers', function () {
    function MockMinecraftServer() {}
    function MockServerPlayer() {}
    var isoSandbox = createKubeSandbox(function (clsName) {
        if (clsName === 'net.minecraft.server.MinecraftServer') return MockMinecraftServer
        if (clsName === 'net.minecraft.server.level.ServerPlayer') return MockServerPlayer
        return null
    })
    loadServerBase(isoSandbox)
    runScriptIn(isoSandbox, VALVE_PATH)
    var IsoValve = isoSandbox.global.EpiphyPermissionValve
    var callerTok = IsoValve.declareCaller('danmaku_script', ['danmaku'])
    assert.ok(callerTok && callerTok.__isEpiphyDeclToken === true)

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

    // Console carrier inside withDeclaration: respects BOTH allowConsole & allowDeclaredCallers; ambient {} is denied
    var clsInside = null
    var resNoConsole = null
    var resLowPerm = null
    var resAllowed = null
    var resNoDeclared = null
    var resAbstractCarrier = null

    IsoValve.withDeclaration(callerTok, function () {
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
    assert.strictEqual(resAbstractCarrier.allowed, false, 'ambient {} / CommandSource.NULL must NOT gain declared_function inside withDeclaration')
})

test('permission valve hardening: reserved auth/help names, token anti-forgery, write-once, stack intersection, runDeclaredCommand & withPermission(4)', function () {
    function MockMinecraftServer() {}
    function MockServerPlayer(name, uuid, op) {
        this._name = name
        this._uuid = uuid
        this._op   = !!op
    }
    MockServerPlayer.prototype.isOp           = function () { return this._op }
    MockServerPlayer.prototype.hasPermissions = function (lv) { return this._op && lv <= 4 }
    MockServerPlayer.prototype.getProfile     = function () { return { name: this._name, id: this._uuid } }
    MockServerPlayer.prototype.getStringUUID  = function () { return this._uuid }

    var iso = createKubeSandbox(function (clsName) {
        if (clsName === 'net.minecraft.server.MinecraftServer') return MockMinecraftServer
        if (clsName === 'net.minecraft.server.level.ServerPlayer') return MockServerPlayer
        return null
    })
    loadServerBase(iso)
    runScriptIn(iso, VALVE_PATH)
    var IV = iso.global.EpiphyPermissionValve

    // 2A: reserved subcommand names & removed spec.auth fallback
    assert.strictEqual(IV.registerSubcommand({ name: 'auth', permission: 'public' }), false)
    assert.strictEqual(IV.registerSubcommand({ name: 'help', permission: 'public' }), false)
    assert.strictEqual(IV.registerSubcommand({ name: 'spec_auth_legacy', auth: 'public' }), true)
    assert.strictEqual(IV.grantPlayer(null, 'Steve', 'auth', 'admin'), false, 'cannot grant reserved "auth" scope')
    assert.strictEqual(IV.grantPlayer(null, 'Steve', 'help', 'admin'), false, 'cannot grant reserved "help" scope')

    var mockSrv = {
        getPlayerList: function () { return { isOp: function () { return false }, isAllowCheatsForAllPlayers: function () { return true } } }
    }
    var nonOpPlayer = new MockServerPlayer('Noop', '00000000-0000-0000-0000-000000000099', false)
    nonOpPlayer.server = mockSrv
    // 2C: CommandSourceStack.withPermission(4) keeps source === player while stack source.hasPermission(4) === true
    var elevatedStack = {
        source:        nonOpPlayer,
        server:        mockSrv,
        isPlayer:      function () { return true },
        getPlayer:     function () { return nonOpPlayer },
        hasPermission: function (lv) { return lv <= 4 }
    }
    assert.strictEqual(IV.classifyCommandSource(elevatedStack).kind, 'player')
    assert.strictEqual(IV.isPlayerAdmin(mockSrv, nonOpPlayer, elevatedStack, 2), false, 'withPermission(4) stack must NOT elevate non-OP player to admin')
    assert.strictEqual(IV.evaluateSourceAccess(elevatedStack, 'spec_auth_legacy').allowed, false, 'legacy spec.auth must default to admin & deny withPermission(4) player')

    // 2B: token anti-forgery, write-once, nested frame intersection, targetScopes narrowing & runDeclaredCommand
    assert.strictEqual(IV.declareCaller('auth_only', ['auth', 'help']), null, 'reserved scopes only -> declareCaller rejected')
    var tokA = IV.declareCaller('caller_alpha', ['danmaku', 'audio'])
    var tokB = IV.declareCaller('caller_beta', ['audio', 'debug'])
    assert.ok(tokA && tokA.__isEpiphyDeclToken === true)
    assert.ok(tokB && tokB.__isEpiphyDeclToken === true)
    assert.strictEqual(IV.declareCaller('caller_alpha', ['danmaku', 'debug']), null, 'write-once must block widening re-registration')

    var srvSource = {
        source: new MockMinecraftServer(),
        hasPermission: function (lv) { return lv <= 4 }
    }

    // String spoofing & structurally forged object spoofing blocked
    assert.strictEqual(IV.withDeclaration('caller_alpha', function () { return 'pwn' }), null)
    assert.strictEqual(IV.withDeclaration({ __isEpiphyDeclToken: true, callerId: 'caller_alpha' }, function () { return 'pwn' }), null)
    var spoofBound = IV.bindDeclaration('caller_alpha', function () { return 'pwn' })
    assert.strictEqual(spoofBound(), null)

    // targetScopes narrowing & nested intersection (alpha:[danmaku,audio] + beta:[audio,debug] -> audio only)
    var narrowDanmaku = false
    var narrowAudio   = false
    var interDanmaku  = false
    var interAudio    = false
    var interDebug    = false
    IV.withDeclaration(tokA, function () {
        narrowDanmaku = IV.evaluateSourceAccess(srvSource, 'danmaku', 'authorized').allowed
        narrowAudio   = IV.evaluateSourceAccess(srvSource, 'audio', 'authorized').allowed
    }, ['danmaku'])
    IV.withDeclaration(tokA, function () {
        IV.withDeclaration(tokB, function () {
            interDanmaku = IV.evaluateSourceAccess(srvSource, 'danmaku', 'authorized').allowed
            interAudio   = IV.evaluateSourceAccess(srvSource, 'audio', 'authorized').allowed
            interDebug   = IV.evaluateSourceAccess(srvSource, 'debug', 'authorized').allowed
        })
    })
    assert.strictEqual(narrowDanmaku, true)
    assert.strictEqual(narrowAudio, false)
    assert.strictEqual(interDanmaku, false, 'outer+inner intersection excludes danmaku')
    assert.strictEqual(interAudio, true, 'outer+inner intersection preserves common scope audio')
    assert.strictEqual(interDebug, false, 'outer+inner intersection prevents escalating to inner debug')

    // runDeclaredCommand hardening: blocks non-/epiphy, reserved /epiphy auth, out-of-scope subcommand, player runner & 2nd chained dispatch
    var executedCmds = []
    var runner = {
        runCommandSilent: function (cmd) {
            executedCmds.push(cmd)
            var r1 = IV.evaluateSourceAccess({ source: runner }, 'danmaku', 'authorized')
            var r2 = IV.evaluateSourceAccess({ source: runner }, 'danmaku', 'authorized')
            var rAmbient = IV.evaluateSourceAccess({}, 'danmaku', 'authorized')
            assert.strictEqual(r1.allowed, true, 'first bound dispatch succeeds')
            assert.strictEqual(r2.allowed, false, 'second chained dispatch in same runDeclaredCommand must be denied')
            assert.strictEqual(rAmbient.allowed, false, 'unrelated {} carrier inside runDeclaredCommand must be denied')
            return 1
        }
    }
    assert.strictEqual(IV.runDeclaredCommand(runner, 'caller_alpha', '/epiphy danmaku'), 0, 'string token rejected')
    assert.strictEqual(IV.runDeclaredCommand(runner, tokA, '/op Noop'), 0, 'non-epiphy command blocked')
    assert.strictEqual(IV.runDeclaredCommand(runner, tokA, '/epiphy auth grant Noop *'), 0, 'reserved /epiphy auth blocked')
    assert.strictEqual(IV.runDeclaredCommand(runner, tokA, '/epiphy debug'), 0, 'out-of-scope /epiphy debug blocked')
    assert.strictEqual(IV.runDeclaredCommand(nonOpPlayer, tokA, '/epiphy danmaku'), 0, 'player runner blocked')
    assert.strictEqual(executedCmds.length, 0)
    assert.strictEqual(IV.runDeclaredCommand(runner, tokA, '/epiphy danmaku title=ok'), 1)
    assert.strictEqual(executedCmds.length, 1)
})

// ----------------------------------------------------------------------------
// 7. block tracker scan scoping (bind/scanNow do not clear global state)
// ----------------------------------------------------------------------------
test('block tracker: bind() & scanNow() preserve pure-air LRU, queued work and tracked records', function () {
    var tickHandlers = []
    var isoSandbox = createKubeSandbox()
    isoSandbox.ServerEvents.tick = function (fn) { tickHandlers.push(fn) }

    loadServerBase(isoSandbox)
    runScriptIn(isoSandbox, TRACKER_PATH)
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
    var isoConsole = attachConsoleCapture(isoSandbox)

    // Load server components once in real KubeJS priority order (1200 -> 1100 -> 1080 -> 1050 -> 1000 -> 950 -> 500)
    loadServerBase(isoSandbox)
    runScriptIn(isoSandbox, TRACKER_PATH)
    runScriptIn(isoSandbox, VALVE_PATH)
    vm.runInContext(fs.readFileSync(DEBUG_PATH, 'utf8'), isoSandbox, { filename: 'Epiphy的-调试组件.js' })
    vm.runInContext(fs.readFileSync(DANMAKU_PATH, 'utf8'), isoSandbox, { filename: 'Epiphy的-屏幕弹幕组件.js' })
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
    loadServerBase(isoSandbox)
    runScriptIn(isoSandbox, TRACKER_PATH)
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
    assert.strictEqual(rescanRes.code, 'queue_truncated')
    assert.strictEqual(rescanRes.data.truncatedByQueue, true)
    assert.ok(rescanRes.message.length > 0)

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
    assert.strictEqual(resetRes.code, 'metrics_reset')
    assert.ok(resetRes.message.length > 0)
    assert.strictEqual(Tracker.getStats().tickAllCount, 0)
})

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
    vm.runInContext(fs.readFileSync(DANMAKU_PATH, 'utf8'), isoSandbox, { filename: 'Epiphy的-屏幕弹幕组件.js' })

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
    loadStartupBase(cliSandbox)
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

test('client modules: degrade gracefully when EpiphySpec/EpiphyProtocol is absent and still fail-closed reject mismatched packets', function () {
    function makeClientDegradedSandbox() {
        var warns  = []
        var errors = []
        var netHandlers   = {}
        var paintHandlers = []
        var tickHandlers  = []
        var draws         = []
        var noop          = function () {}
        var sb = {
            console: {
                info:  noop,
                warn:  function (m) { warns.push(String(m)) },
                error: function (m) { errors.push(String(m)) },
                debug: noop,
                log:   noop
            },
            ClientEvents: {
                loggedOut:   noop,
                loggedIn:    noop,
                paintScreen: function (fn) { paintHandlers.push(fn) },
                tick:        function (fn) { tickHandlers.push(fn) }
            },
            NetworkEvents: {
                dataReceived: function (ch, fn) { netHandlers[ch] = fn }
            },
            Java: { loadClass: function () { return null } },
            Text: { of: function (s) { return { string: String(s), getVisualOrderText: function () { return String(s) } } } },
            global: {}
        }
        sb.globalThis = sb
        vm.createContext(sb)
        return {
            sb: sb,
            warns: warns,
            errors: errors,
            netHandlers: netHandlers,
            paintHandlers: paintHandlers,
            tickHandlers: tickHandlers,
            draws: draws
        }
    }

    // 1. 音频客户端无 startup 前置时平滑降级，仍严格拒收旧版本包
    var auEnv = makeClientDegradedSandbox()
    runScriptIn(auEnv.sb, AUDIO_CLIENT_PATH)
    assert.ok(auEnv.warns.some(function (w) { return w.indexOf('Epiphy的-Spec与通用工具.js') >= 0 }))
    assert.ok(auEnv.sb.global.EpiphyAudioClient != null)
    assert.ok(typeof auEnv.netHandlers['epiphy:audio'] === 'function')
    auEnv.netHandlers['epiphy:audio']({ data: { proto: 4, action: 'play', snd: 'minecraft:ui.button.click' } })
    assert.strictEqual(auEnv.errors.length, 1, 'degraded audio client must fail-closed reject mismatched proto=4 packet')
    auEnv.netHandlers['epiphy:audio']({ data: { proto: 5, action: 'play', h: 'degraded_h1', snd: 'minecraft:ui.button.click', vol: 1.2 } })
    assert.strictEqual(auEnv.errors.length, 1, 'degraded audio client must accept valid proto=5 packet without errors')
    assert.strictEqual(auEnv.sb.global.EpiphyAudioClient.count(), 1, 'degraded audio client must queue valid proto=5 action')

    // 2. 弹幕客户端无 startup 前置时可接收 v5 包并完成绘制，同时拒收错误版本包
    var dmEnv = makeClientDegradedSandbox()
    runScriptIn(dmEnv.sb, RENDERER_PATH)
    assert.ok(dmEnv.warns.some(function (w) { return w.indexOf('Epiphy的-Spec与通用工具.js') >= 0 }))
    assert.ok(dmEnv.sb.global.ScreenDanmakuClient != null)
    assert.ok(typeof dmEnv.netHandlers['epiphy:screen_danmaku'] === 'function')

    // 错误版本包被 fail-closed 拒收，不入队
    dmEnv.netHandlers['epiphy:screen_danmaku']({ data: { proto: 4, title: 'bad_proto' } })
    assert.strictEqual(dmEnv.errors.length, 1, 'degraded renderer must fail-closed reject mismatched proto=4 packet')

    var mockEvent = {
        width: 854,
        height: 480,
        level: 'minecraft:overworld',
        font: {
            width: function (s) { return String(s || '').length * 6 },
            drawInBatch: function (txt) { dmEnv.draws.push(String(txt && txt.string ? txt.string : txt)) }
        },
        text: function (txt) { dmEnv.draws.push(String(txt && txt.string ? txt.string : txt)) },
        graphics: { bufferSource: function () { return {} }, flush: function () {} },
        getMatrix: function () { return {} },
        push: function () {},
        pop: function () {},
        translate: function () {},
        scale: function () {},
        rotateDeg: function () {},
        blend: function () {}
    }
    dmEnv.paintHandlers[0](mockEvent)
    assert.strictEqual(dmEnv.draws.length, 0, 'rejected proto=4 packet must produce 0 draws')

    // 正常 v5 包可触发绘制（含字符串优先级与布尔字段解析）
    dmEnv.netHandlers['epiphy:screen_danmaku']({
        data: { proto: 5, title: 'DegradedOK', priority: 'urgent', typewriter: 'false', shadow: false, stay: 40 }
    })
    dmEnv.paintHandlers[0](mockEvent)
    assert.strictEqual(dmEnv.errors.length, 1, 'degraded renderer must paint valid proto=5 danmaku without draw errors')
    assert.ok(dmEnv.draws.length >= 1, 'degraded renderer must still render valid proto=5 danmaku')
    assert.ok(dmEnv.draws.some(function (s) { return s.indexOf('DegradedOK') >= 0 }), 'degraded renderer must draw payload text')
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
    assert.ok(h1.api != null && h1.api.VERSION === 1)
    assert.strictEqual(h1.netTried, false, 'EpiphyBugfix must never register client->server NetworkEvents handlers')
    assert.ok(h1.logs.info.some(function (s) { return s.indexOf('内置兜底') >= 0 }))

    var pExit = h1.mkPlayer('uuid-p1', 'Alice', 55, 60)
    h1.fireLogout(pExit)
    assert.deepStrictEqual(
        { hp: h1.api.getRecord('uuid-p1').hp, max: h1.api.getRecord('uuid-p1').max },
        { hp: 55, max: 60 }
    )
    assert.ok(sharedDisk['world_test/kubejs_epiphy_bugfix_hp.json'] != null)

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
        toString: function () { return 'E:\\Minecraft\\[1.20.1-测试]\\.minecraft\\saves\\New World\\.' },
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
    assert.strictEqual(st.filePath, 'E:/Minecraft/[1.20.1-测试]/.minecraft/saves/New World/kubejs_tracked_blocks.json')
    assert.strictEqual(audioSb.global.EpiphyServerBase.ensureParentDir(st.filePath), true)
    for (var li = 0; li < logoutHandlers.length; li++) {
        logoutHandlers[li]({ server: audioSb.server, player: fakePlayerObj })
    }
    assert.ok(jsonWritePaths.indexOf('E:/Minecraft/[1.20.1-测试]/.minecraft/saves/New World/kubejs_epiphy_bugfix_hp.json') >= 0, 'EpiphyBugfix must resolve world path without WindowsPath.resolve')
    assert.ok(dirCalls.length >= 2 && dirCalls.every(function (d) { return d === 'E:/Minecraft/[1.20.1-测试]/.minecraft/saves/New World' }))

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
// Helper: Real temp-fs Java NIO / File / KubeJSPaths mock for Pillar 1 & 2 tests
// ----------------------------------------------------------------------------
function makeNodeBackedJavaSandbox(gameDir, extraClassResolver) {
    function NodeJavaFile(p) {
        this._p = path.resolve(String(p))
    }
    NodeJavaFile.prototype.exists = function () { return fs.existsSync(this._p) }
    NodeJavaFile.prototype.isFile = function () { return fs.existsSync(this._p) && fs.statSync(this._p).isFile() }
    NodeJavaFile.prototype.isDirectory = function () { return fs.existsSync(this._p) && fs.statSync(this._p).isDirectory() }
    NodeJavaFile.prototype.mkdirs = function () { fs.mkdirSync(this._p, { recursive: true }); return true }
    NodeJavaFile.prototype.getParentFile = function () { return new NodeJavaFile(path.dirname(this._p)) }
    NodeJavaFile.prototype.getName = function () { return path.basename(this._p) }
    NodeJavaFile.prototype.getPath = function () { return this._p }
    NodeJavaFile.prototype.getCanonicalPath = function () { return this._p }
    NodeJavaFile.prototype.getAbsolutePath = function () { return this._p }
    NodeJavaFile.prototype.delete = function () { if (fs.existsSync(this._p)) fs.unlinkSync(this._p); return true }
    NodeJavaFile.prototype.renameTo = function (dst) { fs.renameSync(this._p, dst._p); return true }
    NodeJavaFile.prototype.listFiles = function () {
        if (!fs.existsSync(this._p)) return []
        var names = fs.readdirSync(this._p)
        var out = []
        for (var i = 0; i < names.length; i++) {
            out.push(new NodeJavaFile(path.join(this._p, names[i])))
        }
        return out
    }

    var NodeFiles = {
        exists: function (p) { return fs.existsSync(String(p)) },
        readString: function (p) { return fs.readFileSync(String(p), 'utf8') },
        writeString: function (p, content) {
            fs.mkdirSync(path.dirname(String(p)), { recursive: true })
            var args = Array.prototype.slice.call(arguments, 3)
            var isAppend = args.indexOf('APPEND') >= 0
            if (isAppend) fs.appendFileSync(String(p), String(content), 'utf8')
            else fs.writeFileSync(String(p), String(content), 'utf8')
        },
        copy: function (src, dst) {
            fs.mkdirSync(path.dirname(String(dst)), { recursive: true })
            fs.copyFileSync(String(src), String(dst))
        },
        move: function (src, dst) {
            fs.mkdirSync(path.dirname(String(dst)), { recursive: true })
            fs.renameSync(String(src), String(dst))
        },
        createDirectories: function (p) {
            fs.mkdirSync(String(p), { recursive: true })
        }
    }

    var sb = createKubeSandbox(function (clsName) {
        if (clsName === 'java.io.File') return NodeJavaFile
        if (clsName === 'java.nio.file.Files') return NodeFiles
        if (clsName === 'java.nio.file.Paths') return { get: function (s) { return path.resolve(String(s)) } }
        if (clsName === 'java.nio.charset.StandardCharsets') return { UTF_8: 'utf8' }
        if (clsName === 'java.nio.file.StandardCopyOption') return { REPLACE_EXISTING: 'REPLACE', ATOMIC_MOVE: 'ATOMIC' }
        if (clsName === 'java.nio.file.StandardOpenOption') return { CREATE: 'CREATE', APPEND: 'APPEND' }
        if (clsName === 'net.minecraft.world.level.storage.LevelResource') return { ROOT: 'ROOT' }
        if (clsName === 'dev.latvian.mods.kubejs.KubeJSPaths') {
            return {
                GAMEDIR: gameDir,
                dir: function (d) { fs.mkdirSync(path.resolve(String(d)), { recursive: true }); return String(d) }
            }
        }
        return extraClassResolver ? extraClassResolver(clsName) : null
    })
    sb.JsonIO = {
        read: function (p) {
            var rp = path.resolve(String(p))
            if (!fs.existsSync(rp)) return null
            return JSON.parse(fs.readFileSync(rp, 'utf8'))
        },
        write: function (p, obj) {
            var rp = path.resolve(String(p))
            fs.mkdirSync(path.dirname(rp), { recursive: true })
            fs.writeFileSync(rp, JSON.stringify(obj, null, 2), 'utf8')
        }
    }
    return sb
}

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
// 27. Pillar 2: external revocations, Fail-Closed auth_mode, 8-char 2-min confirm, pause on disable
// ----------------------------------------------------------------------------
test('permissions: external revocation tombstones, Fail-Closed auth_mode & 8-char 2-min confirmation', function () {
    var os = require('os')
    var tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'epiphy_p2_'))
    try {
        var gameDir = path.join(tmpRoot, 'game')
        var savePath = path.join(gameDir, 'saves', 'VaultWorld')
        fs.mkdirSync(savePath, { recursive: true })

        function MockServerPlayer(name, uuid, op) {
            this.username = name
            this._uuid = uuid
            this._op = Boolean(op)
            this._msgs = []
        }
        MockServerPlayer.prototype.getProfile = function () { return { name: this.username, id: this._uuid } }
        MockServerPlayer.prototype.getStringUUID = function () { return this._uuid }
        MockServerPlayer.prototype.hasPermissions = function (lv) { return this._op && lv <= 4 }
        MockServerPlayer.prototype.tell = function (t) { this._msgs.push(typeof t === 'string' ? t : (t && t.string ? t.string : String(t))) }
        function MockMinecraftServer() {
            this._players = []
        }
        MockMinecraftServer.prototype.getWorldData = function () {
            return { getLevelName: function () { return 'VaultWorld' }, getAllowCommands: function () { return true } }
        }
        MockMinecraftServer.prototype.getWorldPath = function () { return savePath }
        MockMinecraftServer.prototype.getPlayerList = function () {
            var self = this
            return { getPlayers: function () { return self._players }, isOp: function () { return false }, getPlayerByName: function (n) {
                for (var i = 0; i < self._players.length; i++) if (self._players[i].username === n) return self._players[i]
                return null
            } }
        }

        var loginHandlers = []
        var fakeNow = 1000000
        var sb = makeNodeBackedJavaSandbox(gameDir, function (cls) {
            if (cls === 'net.minecraft.server.MinecraftServer') return MockMinecraftServer
            if (cls === 'net.minecraft.server.level.ServerPlayer') return MockServerPlayer
            return null
        })
        sb.Date = function () { return new Date(fakeNow) }
        sb.Date.now = function () { return fakeNow }
        sb.Date.parse = Date.parse
        sb.PlayerEvents.loggedIn = function (fn) { loginHandlers.push(fn) }

        var srv = new MockMinecraftServer()
        var opPlayer    = new MockServerPlayer('RealOP', '00000000-0000-4000-8000-000000000001', true)
        var alicePlayer = new MockServerPlayer('Alice', '00000000-0000-4000-8000-000000000002', false)
        var steveFake   = new MockServerPlayer('Steve', '00000000-0000-4000-8000-000000000003', false)
        srv._players = [opPlayer, alicePlayer]

        // Seed legacy save permission file before loading Valve
        var legacySavePerm = path.join(savePath, 'kubejs_epiphy_permissions.json')
        fs.writeFileSync(legacySavePerm, JSON.stringify({
            version: 4,
            users: {
                '00000000-0000-4000-8000-000000000002': {
                    displayName: 'Alice',
                    scopes: { danmaku: { by: 'Admin', at: '2026-01-01 00:00:00', atMs: 500000 } }
                },
                steve: {
                    displayName: 'Steve',
                    scopes: { audio: { by: 'Admin', at: '2026-01-01 00:00:00', atMs: 500000 } }
                }
            }
        }), 'utf8')

        vm.runInContext(fs.readFileSync(LOG_PATH, 'utf8'), sb, { filename: 'Epiphy的-日志.js' })
        loadServerBase(sb)
        runScriptIn(sb, VALVE_PATH)

        var Valve = sb.global.EpiphyPermissionValve
        var info  = Valve.resolveWorldStorageInfo(srv)
        assert.strictEqual(Valve.isPlayerAuthorized(srv, alicePlayer, 'danmaku'), true, 'UUID legacy import must work')
        assert.strictEqual(Valve.isNameGrantEnabled(srv), false, 'allowNameGrant must default to false')
        assert.ok(fs.existsSync(info.authModeFile), 'auth_mode.json with warnings must be auto-created')
        var rawModeJson = JSON.parse(fs.readFileSync(info.authModeFile, 'utf8'))
        assert.strictEqual(rawModeJson.allowNameGrant, false)
        assert.ok(String(rawModeJson._warning).length > 20 && Array.isArray(rawModeJson._consequences))

        // In default UUID-only mode: legacy name grant "steve" must stay paused & never migrate
        for (var li = 0; li < loginHandlers.length; li++) loginHandlers[li]({ player: steveFake })
        assert.strictEqual(Valve.isPlayerAuthorized(srv, steveFake, 'audio'), false, 'paused name grant must NOT authorize by default')
        assert.strictEqual(Valve.grantPlayer(srv, 'OfflineNick', 'danmaku', opPlayer), false, 'cannot create new name grant when disabled')

        // Revoke Alice -> external revocation tombstone blocks world rollback resurrection
        fakeNow = 1005000
        assert.strictEqual(Valve.revokePlayer(srv, alicePlayer, 'danmaku', opPlayer), true)
        assert.strictEqual(Valve.isPlayerAuthorized(srv, alicePlayer, 'danmaku'), false)
        assert.ok(fs.existsSync(info.revocationsFile), 'revocations.json tombstone must be persisted externally')

        // Simulate save rollback: wipe external permissions.json and restore old permissions with atMs <= revokedAtMs
        fs.writeFileSync(info.permissionsFile, JSON.stringify({
            version: 5,
            users: {
                '00000000-0000-4000-8000-000000000002': {
                    keyKind: 'uuid',
                    displayName: 'Alice',
                    scopes: { danmaku: { by: 'Rollback', at: '2026-01-01 00:00:00', atMs: 500000 } }
                },
                steve: {
                    keyKind: 'name',
                    displayName: 'Steve',
                    scopes: { audio: { by: 'Rollback', at: '2026-01-01 00:00:00', atMs: 500000 } }
                }
            }
        }), 'utf8')
        Valve.reloadWorldAuthFromDisk(srv)
        assert.strictEqual(Valve.isPlayerAuthorized(srv, alicePlayer, 'danmaku'), false, 'revocation tombstone must stop rollback resurrection')

        // Name-grant activation: denied for non-OP, denied on wrong/expired token, succeeds for real OP within 2 min
        var nonOpSrc = { source: alicePlayer, player: alicePlayer, getServer: function () { return srv } }
        var opSrc    = { source: opPlayer, player: opPlayer, getServer: function () { return srv } }
        assert.strictEqual(Valve.requestNameGrantEnable(nonOpSrc).ok, false, 'non-OP must never enable name-grant mode')

        var req1 = Valve.requestNameGrantEnable(opSrc)
        assert.strictEqual(req1.ok, true)
        assert.ok(/^[0-9A-Za-z]{8}$/.test(req1.code), 'confirmation code must be 8 alphanumeric chars: ' + req1.code)
        assert.strictEqual(Valve.confirmNameGrantEnable(opSrc, 'WRONG000').ok, false, 'wrong code must fail')

        // Expire (> 120s)
        fakeNow += 121000
        assert.strictEqual(Valve.confirmNameGrantEnable(opSrc, req1.code).expired, true, 'expired code must fail')

        // Valid confirm within 2 min
        var req2 = Valve.requestNameGrantEnable(opSrc)
        fakeNow += 30000
        var conf = Valve.confirmNameGrantEnable(opSrc, req2.code)
        assert.strictEqual(conf.ok, true)
        assert.strictEqual(Valve.isNameGrantEnabled(srv), true)

        // Now Steve logs in -> paused name grant migrates onto Steve's UUID
        for (var li2 = 0; li2 < loginHandlers.length; li2++) loginHandlers[li2]({ player: steveFake })
        assert.strictEqual(Valve.isPlayerAuthorized(srv, steveFake, 'audio'), true)

        // Grant another offline name Bob, then disable mid-session -> Bob stays in JSON paused
        assert.strictEqual(Valve.grantPlayer(srv, 'BobName', 'danmaku', opSrc), true)
        var dis = Valve.disableNameGrantMode(opSrc)
        assert.strictEqual(dis.ok, true)
        assert.strictEqual(dis.pausedCount >= 1, true)
        assert.strictEqual(Valve.isNameGrantEnabled(srv), false)
        var afterDisableJson = JSON.parse(fs.readFileSync(info.permissionsFile, 'utf8'))
        assert.ok(afterDisableJson.users.bobname, 'unmigrated name record must remain preserved on disk when disabled')

        // Fail-Closed check: string "true" in auth_mode.json must NOT activate
        fs.writeFileSync(info.authModeFile, JSON.stringify({ allowNameGrant: 'true' }), 'utf8')
        Valve.reloadWorldAuthFromDisk(srv)
        assert.strictEqual(Valve.isNameGrantEnabled(srv), false, 'string "true" must fail-closed to false')
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
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
    var snap1 = cli.list ? cli.list() : []
    if (snap1.length > 0) {
        assert.strictEqual(snap1[0].tier, 'player', 'renewal must update tier')
    }
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

    // 3. P1-2 & P1-3: Queue cap preserves control packets; batch mid-throw isolates broken item without downgrading batch
    for (var qi = 0; qi < 270; qi++) {
        cli.push({ title: 'Flood_' + qi, stay: 40 })
    }
    cli.push({ action: 'clear', group: '*' })
    for (var fl = 0; fl < 5; fl++) {
        nowMs += 50
        paints[0](rEv)
    }
    assert.strictEqual(cli.count(), 0, 'control clear pushed after queue saturation must survive cap & clear flood')

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
    var beforeBlinkKey = (cli.list && cli.list()[0]) ? cli.list()[0].lineCacheKey : null
    nowMs = 20600 // toggled blink phase, same shownVis=1 (charMs=2000)
    paints[0](rEv)
    var afterBlinkKey = (cli.list && cli.list()[0]) ? cli.list()[0].lineCacheKey : null
    if (beforeBlinkKey != null) {
        assert.strictEqual(afterBlinkKey, beforeBlinkKey, 'blinkCursor phase change alone must NOT bust lineCacheKey')
    }
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
    var movedPositions = []
    var musicCh = {
        m_83666_: function () {},
        m_83677_: function () { musicPaused++ },
        m_83678_: function () { musicUnpaused++ },
        m_83680_: function () { return false }
    }
    var musicInst = { source: 'MUSIC', getSource: function () { return 'MUSIC' }, isStopped: function () { return false } }
    activeSet.add(musicInst)
    chanMap.set(musicInst, { execute: function (fn) { fn(musicCh) } })
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
    assert.ok(musicPaused >= 1, 'duckMusic must pause external MUSIC channel')
    assert.strictEqual(stopCalls.some(function (x) { return x === null || x === musicInst }), false, 'duckMusic must NOT call sm.stop on external MUSIC')

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

    // Stop ducking handle -> external vanilla MUSIC is unpaused via m_83678_
    catVol.RECORDS = 1.0
    netHandlers['epiphy:audio']({ data: { proto: 5, act: 'stop', ses: 1, h: 10, fout: 0 } })
    tickHandlers[0]({})
    assert.ok(musicUnpaused >= 1, 'ending ducking must unpause ducked external MUSIC')

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
// 34. Permission layering: fine-grained scopes (danmaku.self, audio.play, child revoke vs parent grant, *.broadcast, auth scopes)
// ----------------------------------------------------------------------------
test('permission layering: individual danmaku.self grant, child revoke override & broadcast gate', function () {
    function MockMinecraftServer() {}
    var sb = createKubeSandbox(function (cls) {
        if (cls === 'net.minecraft.server.MinecraftServer') return MockMinecraftServer
        return null
    })
    var cmdCallbacks = []
    var tickHandlers = []
    sb.ServerEvents.commandRegistry = function (fn) { cmdCallbacks.push(fn) }
    sb.ServerEvents.command = function (fn) { cmdCallbacks.push(fn) }
    sb.ServerEvents.tick = function (fn) { tickHandlers.push(fn) }

    function makePl(name, uuid, isOp) {
        var sent = []
        return {
            username: name, uuid: uuid, _op: Boolean(isOp), _sent: sent,
            getName: function () { return { getString: function () { return name } } },
            getUuid: function () { return uuid },
            isOp: function () { return Boolean(isOp) },
            hasPermissions: function () { return Boolean(isOp) },
            getX: function () { return 0 }, getY: function () { return 64 }, getZ: function () { return 0 },
            sendData: function (ch, pkt) { sent.push({ ch: ch, pkt: pkt }) }
        }
    }
    var opPl   = makePl('LayerOp',    '00000000-0000-4000-8000-0000000000e1', true)
    var selfPl = makePl('SelfOnly',   '00000000-0000-4000-8000-0000000000e2', false)
    var modPl  = makePl('ParentMod',  '00000000-0000-4000-8000-0000000000e3', false)
    var p3     = makePl('Crowd3',     '00000000-0000-4000-8000-0000000000e4', false)
    var p4     = makePl('Crowd4',     '00000000-0000-4000-8000-0000000000e5', false)
    var p5     = makePl('Crowd5',     '00000000-0000-4000-8000-0000000000e6', false)
    var p6     = makePl('Crowd6',     '00000000-0000-4000-8000-0000000000e7', false)
    var allPls = [opPl, selfPl, modPl, p3, p4, p5, p6]

    var overworld = { dimension: 'minecraft:overworld', getDimension: function () { return 'minecraft:overworld' }, players: allPls }
    var nether = { dimension: 'minecraft:the_nether', getDimension: function () { return 'minecraft:the_nether' }, players: [] }
    allPls.forEach(function (pl) { pl.level = overworld })
    var srv = new MockMinecraftServer()
    srv.getWorldData = function () { return { getLevelName: function () { return 'PermLayer' }, getAllowCommands: function () { return true } } }
    srv.getLevel = function (d) { return String(d) === 'minecraft:the_nether' ? nether : (String(d) === 'minecraft:overworld' ? overworld : null) }
    srv.getAllLevels = function () { return [overworld, nether] }
    srv.getPlayerList = function () { return { getPlayers: function () { return allPls }, getPlayerByName: function (n) { return allPls.find(function (x) { return x.username === n }) || null } } }
    sb.server = srv

    loadServerBase(sb)
    runScriptIn(sb, VALVE_PATH)
    runScriptIn(sb, DANMAKU_PATH)
    runScriptIn(sb, AUDIO_PATH)

    var Valve = sb.global.EpiphyPermissionValve
    // Grant ONLY 'danmaku.self' and 'audio.play' to selfPl; grant parent 'danmaku' to modPl then revoke 'danmaku.pos'
    Valve.grantPlayer(srv, selfPl, 'danmaku.self', 'Admin')
    Valve.grantPlayer(srv, selfPl, 'audio.play', 'Admin')
    Valve.grantPlayer(srv, modPl, 'danmaku', 'Admin')
    Valve.revokePlayer(srv, modPl, 'danmaku.pos', 'Admin')

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
        return { create: function () { return {} }, getResult: defFn || function (c, k) { return argValues[k] } }
    }
    var regEv = {
        commands: { literal: function (n) { return new FakeNode('lit', n) }, argument: function (n) { return new FakeNode('arg', n) } },
        arguments: {
            GREEDY_STRING: makeArgType(), STRING: makeArgType(), WORD: makeArgType(), INTEGER: makeArgType(),
            DOUBLE: makeArgType(), FLOAT: makeArgType(), PLAYERS: makeArgType(),
            DIMENSION: makeArgType(function () { return argValues.dim || 'minecraft:overworld' }),
            VEC3: makeArgType(), RESOURCE_LOCATION: makeArgType(), ENTITY: makeArgType()
        },
        register: function (r) { regRoot = r }
    }
    for (var ci = 0; ci < cmdCallbacks.length; ci++) cmdCallbacks[ci](regEv)

    function mkSrc(pl, outArr) {
        return {
            source: pl, player: pl, getPlayer: function () { return pl }, getServer: function () { return srv },
            level: overworld, position: { x: 0, y: 64, z: 0 },
            sendSuccess: function (m) { if (outArr) outArr.push('OK:' + String(m)) },
            sendFailure: function (m) { if (outArr) outArr.push('ERR:' + String(m)) }
        }
    }

    var dmNode = regRoot._children.danmaku
    var auNode = regRoot._children.audio
    var authNode = regRoot._children.auth
    var selfSrc = mkSrc(selfPl)
    var modSrc  = mkSrc(modPl)
    var opOut   = []
    var opSrc   = mkSrc(opPl, opOut)

    // 1. Hierarchical visibility for selfPl ('danmaku.self' & 'audio.play' only)
    assert.strictEqual(dmNode._req(selfSrc), true, 'danmaku.self grant lets player see danmaku root')
    assert.strictEqual(dmNode._children.self._req(selfSrc), true, 'selfPl sees danmaku self')
    assert.strictEqual(dmNode._children.player._req(selfSrc), false, 'selfPl must NOT see danmaku player')
    assert.strictEqual(dmNode._children.here._req(selfSrc), false, 'selfPl must NOT see danmaku here')
    assert.strictEqual(auNode._req(selfSrc), true, 'audio.play grant lets player see audio root')
    assert.strictEqual(auNode._children.play._req(selfSrc), true, 'selfPl sees audio play')
    assert.strictEqual(auNode._children.all._req(selfSrc), false, 'selfPl must NOT see audio all')

    // Execute /epiphy danmaku self -> sends ONLY to selfPl
    selfPl._sent.length = 0; p3._sent.length = 0
    argValues = { spec: 'text="SelfBanner"' }
    dmNode._children.self._children.spec._exec({ source: selfSrc })
    assert.strictEqual(selfPl._sent.length, 1, 'danmaku self sends to caller')
    assert.strictEqual(selfPl._sent[0].pkt.namespace, 'u:00000000-0000-4000-8000-0000000000e2')
    assert.strictEqual(p3._sent.length, 0, 'danmaku self never leaks to other players')

    // 2. Child revocation overrides parent module grant (modPl has 'danmaku' minus 'danmaku.pos')
    assert.strictEqual(dmNode._children.player._req(modSrc), true, 'parent danmaku grant allows danmaku.player')
    assert.strictEqual(dmNode._children.pos._req(modSrc), false, 'explicit child revoke danmaku.pos must beat parent danmaku grant')

    // 3. Parent grant does NOT imply exactScopeOnly *.broadcast -> >4 targets blocked until danmaku.broadcast granted
    var modOut = []
    var modCtx = { source: mkSrc(modPl, modOut) }
    argValues = { targets: [selfPl, p3, p4, p5, p6], spec: 'text="MassSpam"' }
    var resDenied = dmNode._children.player._children.targets._children.spec._exec(modCtx)
    assert.strictEqual(resDenied, 0, '5 non-self targets must be rejected without danmaku.broadcast')
    assert.strictEqual(p6._sent.length, 0)

    // P1-20: rapid clear rate-limit blocks second immediate clear
    argValues = { targets: [modPl] }
    dmNode._children.clear._children.targets._exec(modCtx)
    var secClr = dmNode._children.clear._children.targets._exec(modCtx)
    assert.strictEqual(secClr, 0, 'immediate back-to-back clear by non-OP must be rate-limited')

    // Grant danmaku.broadcast -> now 5 targets succeed
    Valve.grantPlayer(srv, modPl, 'danmaku.broadcast', 'Admin')
    argValues = { targets: [selfPl, p3, p4, p5, p6], spec: 'text="AllowedBroadcast"' }
    var resOk = dmNode._children.player._children.targets._children.spec._exec(modCtx)
    assert.strictEqual(resOk, 5, 'granting danmaku.broadcast unlocks >4 target player danmaku')

    // 4. /epiphy auth scopes lists declared fine-grained scopes
    assert.strictEqual(authNode._children.scopes._exec({ source: opSrc }), 1)
    assert.ok(opOut.some(function (l) { return l.indexOf('danmaku.self') >= 0 }), 'auth scopes output lists danmaku.self')
    assert.ok(opOut.some(function (l) { return l.indexOf('audio.broadcast') >= 0 }), 'auth scopes output lists audio.broadcast')
})

// ----------------------------------------------------------------------------
// 35. Audio Forge 1.20.1 SRG-only production runtime + Epiphy的小玩意_功能测试 e2e
// ----------------------------------------------------------------------------
test('Epiphy的小玩意_功能测试 & EpiphyAudioClient: SRG-only Forge runtime, subtitle m_7761_ & attCache recovery', function () {
    var TEST_BLOCK_PATH = path.resolve(__dirname, '../kubejs/startup_scripts/通用组件/Epiphy的小玩意_功能测试.js')

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
    var TEST_BLOCK_PATH = path.resolve(__dirname, '../kubejs/startup_scripts/通用组件/Epiphy的小玩意_功能测试.js')

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
// 38. Client java.lang.System Class Filter: silent probe produces zero WARN
// ----------------------------------------------------------------------------
test('Client loadJavaClass(java.lang.System, true): class filter rejection emits zero WARN', function () {
    function makeClientSb() {
        var sb = {
            console: { info: function () {}, warn: function () {}, error: function () {}, debug: function () {}, log: function () {} },
            ClientEvents:  { tick: function () {}, loggedIn: function () {}, loggedOut: function () {}, paintScreen: function () {} },
            NetworkEvents: { dataReceived: function () {} },
            Client:        { minecraft: null },
            Java: {
                loadClass: function (name) {
                    if (name === 'java.lang.System') {
                        throw new Error('Class java.lang.System is not allowed by class filter!')
                    }
                    return null
                }
            },
            global: {}
        }
        sb.globalThis = sb
        vm.createContext(sb)
        loadStartupBase(sb)
        return sb
    }

    var dmSb = makeClientSb()
    var dmCon = attachConsoleCapture(dmSb)
    runScriptIn(dmSb, RENDERER_PATH)
    assert.strictEqual(
        dmCon.warns.some(function (w) { return w.indexOf('java.lang.System') >= 0 }),
        false,
        'ScreenDanmakuClient must not warn when java.lang.System is blocked by class filter'
    )

    var auSb = makeClientSb()
    var auCon = attachConsoleCapture(auSb)
    runScriptIn(auSb, AUDIO_CLIENT_PATH)
    assert.strictEqual(
        auCon.warns.some(function (w) { return w.indexOf('java.lang.System') >= 0 }),
        false,
        'EpiphyAudioClient must not warn when java.lang.System is blocked by class filter'
    )
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
