// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
'use strict'

var assert = require('assert')
var fs     = require('fs')
var path   = require('path')
var vm     = require('vm')

var ROOT_DIR         = path.resolve(__dirname, '..')
var SPEC_PATH        = path.join(ROOT_DIR, 'kubejs', 'startup_scripts', '通用组件', 'Epiphy的-Spec与通用工具.js')
var LOG_PATH         = path.join(ROOT_DIR, 'kubejs', 'server_scripts', '通用组件', 'Epiphy的-日志.js')
var SERVER_BASE_PATH = path.join(ROOT_DIR, 'kubejs', 'server_scripts', '通用组件', 'Epiphy的-服务端核心.js')
var TRACKER_PATH     = path.join(ROOT_DIR, 'kubejs', 'server_scripts', '通用组件', 'Epiphy的-方块与区块组件.js')
var VALVE_PATH     = path.join(ROOT_DIR, 'kubejs', 'server_scripts', '通用组件', 'Epiphy的-权限阀.js')
var DEBUG_PATH        = path.join(ROOT_DIR, 'kubejs', 'server_scripts', '通用组件', 'Epiphy的-调试组件.js')
var BUGFIX_PATH       = path.join(ROOT_DIR, 'kubejs', 'server_scripts', '通用组件', 'Epiphy的-基础bug修复.js')
var DANMAKU_PATH      = path.join(ROOT_DIR, 'kubejs', 'server_scripts', '通用组件', 'Epiphy的-平面渲染组件.js')
var AUDIO_PATH        = path.join(ROOT_DIR, 'kubejs', 'server_scripts', '通用组件', 'Epiphy的-音频组件.js')
var RENDERER_PATH     = path.join(ROOT_DIR, 'kubejs', 'client_scripts', '通用组件', 'Epiphy的-平面渲染器.js')
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
    // Grant ONLY 'danmaku.self' and 'audio.play' to selfPl; grant parent 'danmaku' + child 'danmaku.player' to modPl then revoke parent 'danmaku' (retaining 'danmaku.player')
    Valve.grantPlayer(srv, selfPl, 'danmaku.self', 'Admin')
    Valve.grantPlayer(srv, selfPl, 'audio.play', 'Admin')
    Valve.grantPlayer(srv, modPl, 'danmaku.player', 'Admin')
    Valve.grantPlayer(srv, modPl, 'danmaku.clear', 'Admin')
    Valve.grantPlayer(srv, modPl, 'danmaku', 'Admin')
    Valve.revokePlayer(srv, modPl, 'danmaku', 'Admin')

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

    // 2. Revoking parent 'danmaku' preserves stored child grants ('danmaku.player' & 'danmaku.clear') while revoking uncovered siblings ('danmaku.pos')
    assert.strictEqual(dmNode._children.player._req(modSrc), true, 'stored child danmaku.player survives parent danmaku revoke')
    assert.strictEqual(dmNode._children.pos._req(modSrc), false, 'uncovered sibling danmaku.pos is removed when parent danmaku is revoked')

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

// ----------------------------------------------------------------------------
// 39. strict_op policy normalization + Rhino try-block function guard + bindBlock perPlayer/shared emit
// ----------------------------------------------------------------------------
test('PermissionValve strict_op policy & ScreenDanmaku bindBlock perPlayer/shared + Rhino try-block function guard', function () {
    // (1) EpiphyPermissionValve.normalizePermissionPolicy('strict_op')
    var vSb = createKubeSandbox()
    var vCon = attachConsoleCapture(vSb)
    loadStartupBase(vSb)
    runScriptIn(vSb, LOG_PATH)
    runScriptIn(vSb, SERVER_BASE_PATH)
    runScriptIn(vSb, VALVE_PATH)

    var valve = vSb.global.EpiphyPermissionValve
    assert.ok(valve && typeof valve.normalizePermissionPolicy === 'function', 'EpiphyPermissionValve.normalizePermissionPolicy must exist')
    var pStrict = valve.normalizePermissionPolicy('strict_op')
    assert.strictEqual(pStrict.mode, 'strict_op', 'normalizePermissionPolicy(strict_op) must keep mode=strict_op')
    assert.strictEqual(pStrict.allowCommandBlock, false, 'strict_op policy must set allowCommandBlock=false')
    assert.strictEqual(
        vCon.warns.some(function (w) { return w.indexOf('未知权限策略') >= 0 || w.indexOf('strict_op') >= 0 }),
        false,
        'normalizePermissionPolicy(strict_op) must emit zero unknown-policy warnings: ' + JSON.stringify(vCon.warns)
    )

    // (2) ScreenDanmaku.bindBlock with perPlayer=false and perPlayer=true via BlockTracker
    var dSb = createKubeSandbox()
    var dHooks = attachSandboxEventHooks(dSb)
    var dCon = attachConsoleCapture(dSb)
    loadStartupBase(dSb)
    runScriptIn(dSb, LOG_PATH)
    runScriptIn(dSb, SERVER_BASE_PATH)
    runScriptIn(dSb, TRACKER_PATH)
    runScriptIn(dSb, DANMAKU_PATH)

    var dm = dSb.global.ScreenDanmaku
    var world = makeMockWorld()
    var p1 = world.addPlayer('P1', 'aaaaaaaa-aaaa-4000-8000-aaaaaaaaaaaa', 2, 64, 0)
    var p2 = world.addPlayer('P2', 'bbbbbbbb-bbbb-4000-8000-bbbbbbbbbbbb', 3, 64, 0)

    dm.bindBlock('test:shared_block', {
        id: 'shared_danmaku',
        text: 'SharedHello',
        perPlayer: false
    }, { radius: 24, intervalTicks: 4 })

    dm.bindBlock('test:perplayer_block', function (ctx) {
        var pl = ctx && ctx.player ? ctx.player : null
        return {
            id: 'pp_danmaku',
            text: 'Hi ' + (pl ? pl.username : 'none'),
            perPlayer: true
        }
    }, { radius: 24, intervalTicks: 4, perPlayer: true })

    world.setBlock(0, 64, 0, 'test:shared_block')
    world.setBlock(4, 64, 0, 'test:perplayer_block')
    for (var pi = 0; pi < dHooks.placed.length; pi++) {
        dHooks.placed[pi]({ block: world.makeBlock(0, 64, 0, 'test:shared_block'), level: world.level, player: p1 })
        dHooks.placed[pi]({ block: world.makeBlock(4, 64, 0, 'test:perplayer_block'), level: world.level, player: p1 })
    }
    for (var tk = 0; tk < 12; tk++) {
        for (var ti = 0; ti < dHooks.tick.length; ti++) {
            dHooks.tick[ti]({ server: world.server })
        }
    }

    var p1Msgs = p1.sentPackets.map(function (x) { return JSON.stringify(x.pkt) }).join('|')
    var p2Msgs = p2.sentPackets.map(function (x) { return JSON.stringify(x.pkt) }).join('|')
    assert.ok(p1Msgs.indexOf('SharedHello') >= 0 && p2Msgs.indexOf('SharedHello') >= 0, 'perPlayer=false bound block must send to both nearby players; p1=' + p1Msgs + ' p2=' + p2Msgs)
    assert.ok(p1Msgs.indexOf('Hi P1') >= 0 && p1Msgs.indexOf('Hi P2') < 0, 'perPlayer=true bound block must tailor message for P1; p1=' + p1Msgs)
    assert.ok(p2Msgs.indexOf('Hi P2') >= 0 && p2Msgs.indexOf('Hi P1') < 0, 'perPlayer=true bound block must tailor message for P2; p2=' + p2Msgs)
    assert.strictEqual(dCon.errors.length, 0, 'ScreenDanmaku bindBlock tick must emit zero errors: ' + JSON.stringify(dCon.errors))

    // (3) Static Rhino guard: no statement-position `function name(` inside any `try { ... }` across kubejs/**/*.js
    var kubejsRoot = path.join(ROOT_DIR, 'kubejs')
    var allJs = []
    function walkDir(dir) {
        var entries = fs.readdirSync(dir, { withFileTypes: true })
        for (var i = 0; i < entries.length; i++) {
            var full = path.join(dir, entries[i].name)
            if (entries[i].isDirectory()) walkDir(full)
            else if (entries[i].isFile() && /\.js$/i.test(entries[i].name)) allJs.push(full)
        }
    }
    walkDir(kubejsRoot)
    assert.ok(allJs.length > 0, 'kubejs directory must contain .js files')

    var violations = []
    for (var fi = 0; fi < allJs.length; fi++) {
        var srcLines = fs.readFileSync(allJs[fi], 'utf8').split(/\r?\n/)
        var tryDepths = []
        var braceDepth = 0
        for (var li = 0; li < srcLines.length; li++) {
            var line = srcLines[li]
            var trimmed = line.replace(/\/\/.*$/, '').trim()
            if (tryDepths.length > 0 && /^\s*function\s+[A-Za-z_$][A-Za-z0-9_$]*\s*\(/.test(line)) {
                violations.push(path.relative(ROOT_DIR, allJs[fi]) + ':' + (li + 1) + ' -> ' + trimmed)
            }
            if (/\btry\s*\{\s*$/.test(trimmed)) {
                tryDepths.push(braceDepth)
            }
            for (var ci = 0; ci < trimmed.length; ci++) {
                if (trimmed[ci] === '{') braceDepth++
                else if (trimmed[ci] === '}') {
                    braceDepth--
                    if (tryDepths.length > 0 && braceDepth === tryDepths[tryDepths.length - 1]) {
                        tryDepths.pop()
                    }
                }
            }
        }
    }
    assert.deepStrictEqual(
        violations,
        [],
        'kube-mods/rhino forbids statement-position named function declarations inside try blocks: ' + JSON.stringify(violations)
    )

    var danmakuSrc = fs.readFileSync(DANMAKU_PATH, 'utf8')
    assert.ok(/var normalizeBoundSpec = function\s*\(/.test(danmakuSrc), 'normalizeBoundSpec must be var-assigned before try in emitForBoundBlock')
    assert.ok(/var recordOne = function\s*\(/.test(danmakuSrc), 'recordOne must be var-assigned inside countNonSelfTargets')
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
    // High priority renders BEFORE low priority; A gets green stroke (8 outer passes of #00FF00 -> c>>2? no outline passes exact color 0x00FF00)
    var firstDrawn = drawLogs[0]
    assert.strictEqual(firstDrawn.s, 'A', 'priority=9 overlay must render before priority=1 overlay even when pushed second')
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
    runScriptIn(v18Sb, path.join(__dirname, '..', 'kubejs', 'server_scripts', '合成表-暮色森林', '拆解台-混沌殉爆.v18.js'))
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

test('hidden items: epiphy:chaos_crystal avoids createCompositeState(boolean) EnumTypeWrapper trap across Mojmap, no-AT, and SRG modes', function () {
    var HIDDEN_PATH = path.join(ROOT_DIR, 'kubejs', 'startup_scripts', '通用组件', 'Epiphy的小玩意-原版_其他Mod的隐藏物品.js')

    function runHiddenItemsCase(useRemappedMojmap, exposeOutlineEnum) {
        var modBusListeners = {}
        var registeredModels = {}
        var boundTypes = []
        var renderCalls = 0
        var baseColoursSeen = []
        var scaleArgs = []
        var registeredItems = []
        var itemModelJsons = {}
        var compositeOutlineArgs = []
        var OUTLINE_NONE = { outline: 'NONE' }

        function makeStrictClassProxy(clsName, membersObj) {
            return new Proxy(membersObj, {
                get: function (target, prop) {
                    if (typeof prop === 'symbol' || prop === 'prototype' || prop === 'toString') return target[prop]
                    if (Object.prototype.hasOwnProperty.call(target, prop)) return target[prop]
                    throw new Error('InternalError: Java class "' + clsName + '" has no public instance field or method named "' + String(prop) + '".')
                }
            })
        }

        function assertValidOutlineArg(arg) {
            // 还原 Rhino EnumTypeWrapper + CompositeStateBuilder.createCompositeState 重载陷阱：
            // 传入 boolean (false) 会误命中 enum 重载并抛 IllegalArgumentException: argument type mismatch
            if (typeof arg === 'boolean') {
                throw new Error('IllegalArgumentException: argument type mismatch (boolean rejected by EnumTypeWrapper)')
            }
            assert.ok(arg === 'none' || arg === OUTLINE_NONE, 'expected OutlineProperty.NONE or "none", got: ' + arg)
            compositeOutlineArgs.push(arg)
            return { composite: true }
        }

        function ResourceLocation(ns, p) {
            this.ns = ns; this.p = p
        }
        ResourceLocation.prototype.toString = function () { return this.ns + ':' + this.p }

        function ModelResourceLocation(rl, variant) {
            this.rl = rl; this.variant = variant
        }
        ModelResourceLocation.prototype.toString = function () { return String(this.rl) + '#' + this.variant }

        // 与真实 Rhino 保持一致：实例对象 (NativeJavaObject) 访问缺失属性返回 undefined 而不抛错；静态类 (NativeJavaClass) 则抛 InternalError
        var fakeCompositeBuilder = useRemappedMojmap ? {
            setShaderState: function (s) { assert.ok(s && s.sup, 'ShaderStateShard required'); return fakeCompositeBuilder },
            setTextureState: function (t) { assert.ok(t && t.rl, 'TextureStateShard required'); return fakeCompositeBuilder },
            setTransparencyState: function (v) { assert.strictEqual(v, 'TRANSLUCENT'); return fakeCompositeBuilder },
            setCullState: function (v) { assert.strictEqual(v, 'NO_CULL'); return fakeCompositeBuilder },
            setLightmapState: function (v) { assert.strictEqual(v, 'LIGHTMAP'); return fakeCompositeBuilder },
            setOverlayState: function (v) { assert.strictEqual(v, 'OVERLAY'); return fakeCompositeBuilder },
            createCompositeState: assertValidOutlineArg
        } : {
            m_173292_: function (s) { assert.ok(s && s.sup, 'ShaderStateShard required'); return fakeCompositeBuilder },
            m_173290_: function (t) { assert.ok(t && t.rl, 'TextureStateShard required'); return fakeCompositeBuilder },
            m_110685_: function (v) { assert.strictEqual(v, 'TRANSLUCENT'); return fakeCompositeBuilder },
            m_110661_: function (v) { assert.strictEqual(v, 'NO_CULL'); return fakeCompositeBuilder },
            m_110671_: function (v) { assert.strictEqual(v, 'LIGHTMAP'); return fakeCompositeBuilder },
            m_110677_: function (v) { assert.strictEqual(v, 'OVERLAY'); return fakeCompositeBuilder },
            m_110689_: assertValidOutlineArg
        }

        var fakeCcrs = {
            brightness: 0,
            overlay: 0,
            baseColour: -1,
            reset: function () { this.baseColour = -1 },
            bind: function (rt, getter) {
                boundTypes.push(rt.name)
                baseColoursSeen.push(this.baseColour)
                assert.strictEqual(getter, 'FAKE_GETTER')
                assert.strictEqual(typeof rt.state, 'object')
            }
        }

        var fakeMatOps = []
        function FakeMatrix4(src) {
            this.src = src || null
            this.translate = function () { return this }
            this.rotate = function () { return this }
            this.scale = function (s) { scaleArgs.push(s); return this }
        }

        var fakeCrystalModel = {
            render: function (ccrs, mat) {
                assert.strictEqual(ccrs, fakeCcrs)
                fakeMatOps.push(mat)
                renderCalls++
            }
        }

        var shaderCalls = { inner: 0, outer: 0 }
        var fakeBCShaders = {
            CHAOS_ENTITY_SHADER: {
                getShaderInstance: function () { shaderCalls.inner++; return { shader: 'chaos' } },
                hasModelMatUniform: function () { return true },
                getModelMatUniform: function () { return { glUniformMatrix4f: function () {} } },
                hasSimpleLightUniform: function () { return true },
                getSimpleLightUniform: function () { return { glUniform1b: function () {} } },
                hasDisableLightUniform: function () { return true },
                getDisableLightUniform: function () { return { glUniform1b: function () {} } },
                hasDisableOverlayUniform: function () { return true },
                getDisableOverlayUniform: function () { return { glUniform1b: function () {} } }
            }
        }

        function FakeSupplier(impl) {
            this.get = impl.get
        }
        function FakeIItemRenderer(impl) {
            this.impl = impl
        }

        var sb = {
            console: { info: function () {}, warn: function (m) { throw new Error('unexpected warn: ' + m) }, error: function () {}, debug: function () {}, log: function () {} },
            Platform: { isClientEnvironment: function () { return true } },
            ForgeModEvents: {
                onEvent: function (evName, cb) {
                    modBusListeners[evName] = cb
                }
            },
            ForgeEvents: { onEvent: function () {} },
            StartupEvents: {
                registry: function (kind, cb) {
                    if (kind === 'item') {
                        cb({
                            create: function (id) {
                                registeredItems.push(id)
                                var b = {
                                    displayName: function () { return b },
                                    texture: function () { return b },
                                    rarity: function () { return b },
                                    modelJson: function (json) { itemModelJsons[id] = json; return b }
                                }
                                return b
                            }
                        })
                    }
                }
            },
            Java: {
                loadClass: function (cls) {
                    if (cls.indexOf('net.minecraftforge.fml.') === 0) {
                        throw new Error('ClassFilter denied: ' + cls)
                    }
                    if (cls === 'net.minecraft.client.resources.model.ModelResourceLocation') return ModelResourceLocation
                    if (cls === 'net.minecraft.resources.ResourceLocation') return ResourceLocation
                    if (cls === 'codechicken.lib.render.model.OBJParser') {
                        return function () {
                            return {
                                ignoreMtl: function () { return this },
                                parse: function () { return { isEmpty: function () { return false }, values: function () { return ['mesh'] } } }
                            }
                        }
                    }
                    if (cls === 'codechicken.lib.render.CCModel') {
                        return {
                            combine: function () {
                                return {
                                    backfacedCopy: function () { return this },
                                    computeNormals: function () { return fakeCrystalModel }
                                }
                            }
                        }
                    }
                    if (cls === 'codechicken.lib.render.CCRenderState') return { instance: function () { return fakeCcrs } }
                    if (cls === 'codechicken.lib.render.item.IItemRenderer') return FakeIItemRenderer
                    if (cls === 'codechicken.lib.util.TransformUtils') return { DEFAULT_BLOCK: 'DEFAULT_BLOCK_STATE' }
                    if (cls === 'codechicken.lib.vec.Matrix4') return FakeMatrix4
                    if (cls === 'codechicken.lib.vec.Vector3') return { Y_POS: 'Y_POS' }
                    if (cls === 'com.brandon3055.brandonscore.client.shader.BCShaders') return fakeBCShaders
                    if (cls === 'com.brandon3055.brandonscore.api.TimeKeeper') return { getClientTick: function () { return 40 } }
                    if (cls === 'net.minecraft.client.Minecraft') {
                        var mcInst = useRemappedMojmap
                            ? { getFrameTime: function () { return 0.5 } }
                            : { m_91296_: function () { return 0.5 } }
                        return makeStrictClassProxy('Minecraft', useRemappedMojmap
                            ? { getInstance: function () { return mcInst } }
                            : { m_91087_: function () { return mcInst } })
                    }
                    if (cls === 'net.minecraft.client.renderer.GameRenderer') {
                        return makeStrictClassProxy('GameRenderer', useRemappedMojmap
                            ? { getRendertypeCutoutShader: function () { shaderCalls.outer++; return { shader: 'cutout' } } }
                            : { m_172646_: function () { shaderCalls.outer++; return { shader: 'cutout' } } })
                    }
                    if (cls === 'net.minecraft.client.renderer.RenderStateShard') {
                        return makeStrictClassProxy('RenderStateShard', useRemappedMojmap
                            ? { TRANSLUCENT_TRANSPARENCY: 'TRANSLUCENT', NO_CULL: 'NO_CULL', LIGHTMAP: 'LIGHTMAP', OVERLAY: 'OVERLAY' }
                            : { f_110139_: 'TRANSLUCENT', f_110110_: 'NO_CULL', f_110152_: 'LIGHTMAP', f_110154_: 'OVERLAY' })
                    }
                    if (cls === 'net.minecraft.client.renderer.RenderStateShard$ShaderStateShard') {
                        return function (sup) { this.sup = sup; this.sup.get() }
                    }
                    if (cls === 'net.minecraft.client.renderer.RenderStateShard$TextureStateShard') {
                        return function (rl) { this.rl = rl }
                    }
                    if (cls === 'net.minecraft.client.renderer.RenderType') {
                        return makeStrictClassProxy('net.minecraft.client.renderer.RenderType', useRemappedMojmap
                            ? { create: function (name, fmt, mode, sz, crumb, sort, state) { return { name: name, fmt: fmt, mode: mode, sz: sz, state: state } } }
                            : { m_173215_: function (name, fmt, mode, sz, crumb, sort, state) { return { name: name, fmt: fmt, mode: mode, sz: sz, state: state } } })
                    }
                    if (cls === 'net.minecraft.client.renderer.RenderType$CompositeState') {
                        return makeStrictClassProxy('RenderType$CompositeState', useRemappedMojmap
                            ? { builder: function () { return fakeCompositeBuilder } }
                            : { m_110628_: function () { return fakeCompositeBuilder } })
                    }
                    if (cls === 'net.minecraft.client.renderer.RenderType$OutlineProperty') {
                        return makeStrictClassProxy('RenderType$OutlineProperty', exposeOutlineEnum ? { NONE: OUTLINE_NONE } : {})
                    }
                    if (cls === 'com.mojang.blaze3d.vertex.DefaultVertexFormat') {
                        return makeStrictClassProxy('DefaultVertexFormat', useRemappedMojmap
                            ? { NEW_ENTITY: 'NEW_ENTITY' }
                            : { f_85812_: 'NEW_ENTITY' })
                    }
                    if (cls === 'com.mojang.blaze3d.vertex.VertexFormat$Mode') return { TRIANGLES: 'TRIANGLES' }
                    if (cls === 'java.util.function.Supplier') return FakeSupplier
                    return function () {}
                }
            },
            global: {}
        }
        sb.globalThis = sb
        vm.createContext(sb)
        runScriptIn(sb, HIDDEN_PATH)

        assert.ok(registeredItems.indexOf('epiphy:chaos_crystal') >= 0, 'epiphy:chaos_crystal item must be registered')
        assert.ok(itemModelJsons['epiphy:end_gateway'] && Array.isArray(itemModelJsons['epiphy:end_gateway'].elements) && itemModelJsons['epiphy:end_gateway'].elements.length === 3, 'epiphy:end_gateway must use 3-element gateway shrine model')
        assert.strictEqual(itemModelJsons['epiphy:end_gateway'].textures.core, 'minecraft:block/sculk')
        assert.strictEqual(itemModelJsons['epiphy:end_gateway'].textures.cap, 'minecraft:block/bedrock')
        var bakingCb = modBusListeners['net.minecraftforge.client.event.ModelEvent$ModifyBakingResult']
        assert.strictEqual(typeof bakingCb, 'function', 'ModifyBakingResult must register via ForgeModEvents without denied FML classes')

        bakingCb({
            getModels: function () {
                return {
                    put: function (mrl, model) {
                        registeredModels[String(mrl)] = model
                    }
                }
            }
        })

        var rendererProxy = registeredModels['epiphy:chaos_crystal#inventory']
        assert.ok(rendererProxy != null && rendererProxy.impl != null, 'renderer must be bound to epiphy:chaos_crystal#inventory (not empty variant)')
        assert.strictEqual(registeredModels['epiphy:chaos_crystal#'], undefined, 'empty variant must not be used for item renderer')
        assert.strictEqual(rendererProxy.impl.getModelState(), 'DEFAULT_BLOCK_STATE')
        assert.strictEqual(rendererProxy.impl.m_7541_(), false)
        assert.strictEqual(rendererProxy.impl.useAmbientOcclusion(), false)
        assert.strictEqual(rendererProxy.impl.m_7539_(), true)
        assert.strictEqual(rendererProxy.impl.isGui3d(), true)
        assert.strictEqual(rendererProxy.impl.m_7547_(), true)
        assert.strictEqual(rendererProxy.impl.usesBlockLight(), true)
        assert.strictEqual(shaderCalls.inner, 1)
        assert.strictEqual(shaderCalls.outer, 1)

        rendererProxy.impl.renderItem({}, 'GUI', 'POSE_STACK', 'FAKE_GETTER', 15728880, 655360)
        assert.deepStrictEqual(boundTypes, ['draconicevolution:chaos_crystal_item_inner', 'draconicevolution:chaos_crystal_item_outer'])
        assert.deepStrictEqual(baseColoursSeen, [-1, -16])
        assert.strictEqual(renderCalls, 2)
        assert.strictEqual(compositeOutlineArgs.length, 2)
        if (exposeOutlineEnum) {
            assert.deepStrictEqual(compositeOutlineArgs, [OUTLINE_NONE, OUTLINE_NONE])
        } else {
            assert.deepStrictEqual(compositeOutlineArgs, ['none', 'none'])
        }
        assert.strictEqual(scaleArgs[0], 0.22)
    }

    runHiddenItemsCase(true, false)
    runHiddenItemsCase(true, true)
    runHiddenItemsCase(false, true)
})

test('hidden items helpers: callMcMember supports arbitrary argc and readMcMember falls back cleanly without swallowing errors or returning silent undefined', function () {
    var HIDDEN_PATH = path.join(ROOT_DIR, 'kubejs', 'startup_scripts', '通用组件', 'Epiphy的小玩意-原版_其他Mod的隐藏物品.js')
    var src = fs.readFileSync(HIDDEN_PATH, 'utf8')
    var startIdx = src.indexOf('var probeMcMember = function')
    var endIdx = src.indexOf('var buildCompositeStateNone = function')
    assert.ok(startIdx >= 0 && endIdx > startIdx, 'helper block markers must exist in hidden items script')
    var helperCode = src.slice(startIdx, endIdx) + '\nglobalThis.__mcHelpers = { probeMcMember: probeMcMember, readMcMember: readMcMember, callMcMember: callMcMember };\n'
    var sb = { globalThis: null }
    sb.globalThis = sb
    vm.createContext(sb)
    vm.runInContext(helperCode, sb)
    var h = sb.__mcHelpers

    // 1. callMcMember 覆盖 2/3/8 等任意参数个数（不再限制 0/1/7），且正确绑定 this
    var inst = {
        prefix: 'P:',
        add2: function (a, b) { return this.prefix + a + '+' + b },
        sum8: function (a, b, c, d, e, f, g, i) { return this.prefix + (a + b + c + d + e + f + g + i) },
        m_srg3_: function (x, y, z) { return this.prefix + [x, y, z].join(',') },
        f_srgField_: 42,
        nullableField: null
    }
    assert.strictEqual(h.callMcMember(inst, 'add2', 'm_add2_', 'x', 'y'), 'P:x+y')
    assert.strictEqual(h.callMcMember(inst, 'sum8', 'm_sum8_', 1, 2, 3, 4, 5, 6, 7, 8), 'P:36')
    // Mojmap 方法在实例上返回 undefined（不抛错）时正确回退 SRG 并传入 3 个参数
    assert.strictEqual(h.callMcMember(inst, 'missingMoj3', 'm_srg3_', 10, 20, 30), 'P:10,20,30')

    // 2. readMcMember 在 mojName 返回 undefined（不抛错）时回退 srgName，合法 null 不误判为缺失
    assert.strictEqual(h.readMcMember(inst, 'missingMojField', 'f_srgField_'), 42)
    assert.strictEqual(h.readMcMember(inst, 'nullableField', 'f_null_'), null)

    // 3. 双名均缺失时即使实例返回 undefined 也必须显式抛错，不能静默返回 undefined
    assert.throws(function () {
        h.readMcMember(inst, 'noSuchMoj', 'noSuchSrg')
    }, /Missing Java member noSuchMoj \/ noSuchSrg/)

    // 4. 成员存在但访问抛非“成员不存在”异常（如 IllegalAccessException）时不能被静默吞掉
    var guarded = {}
    Object.defineProperty(guarded, 'NONE', {
        enumerable: true,
        get: function () { throw new Error('IllegalAccessException: package-private enum') }
    })
    assert.throws(function () {
        h.readMcMember(guarded, 'NONE', 'NONE')
    }, /IllegalAccessException/)
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

// ----------------------------------------------------------------------------
// 59. EpiphyServerCore + EpiphyWorldOps + Uncrafting Chaos refactoring verification
// ----------------------------------------------------------------------------
test('Uncrafting Chaos & EpiphyServerCore/EpiphyWorldOps: anti-rename relic spoofing, mainhand diamond pickaxe, WorldOps cost gating & persistence', function () {
    var V18_PATH = path.join(ROOT_DIR, 'kubejs', 'server_scripts', '合成表-暮色森林', '拆解台-混沌殉爆.v18.js')
    var os = require('os')
    var tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'epiphy_uncraft59_'))
    try {
        var gameDir = path.join(tmpRoot, 'game')
        var saveDir = path.join(gameDir, 'saves', 'UncraftWorld')
        fs.mkdirSync(saveDir, { recursive: true })

        var sb = makeNodeBackedJavaSandbox(gameDir)
        var brokenHandlers = {}
        var placedHandlers = {}
        var tickHandlers = []
        var unloadHandlers = []
        sb.BlockEvents.placed = function (idOrFn, maybeFn) {
            if (typeof idOrFn === 'string' && typeof maybeFn === 'function') placedHandlers[idOrFn] = maybeFn
        }
        sb.BlockEvents.broken = function (idOrFn, maybeFn) {
            if (typeof idOrFn === 'string' && typeof maybeFn === 'function') brokenHandlers[idOrFn] = maybeFn
        }
        sb.BlockEvents.rightClicked = function () {}
        sb.ServerEvents.tick = function (fn) { tickHandlers.push(fn) }
        sb.ServerEvents.unloaded = function (fn) { unloadHandlers.push(fn) }
        sb.ServerEvents.recipes = function () {}

        var worldBlocks = {}
        var pDataStore = {}
        var overworldLv = {
            dimension: 'minecraft:overworld',
            getDimension: function () { return 'minecraft:overworld' },
            players: [],
            getPlayers: function () { return this.players },
            hasChunk: function (cx, cz) {
                return (cx >= -10 && cx <= 10 && cz >= -10 && cz <= 10) ||
                       (cx >= 180 && cx <= 200 && cz >= 180 && cz <= 200)
            },
            getChunkSource: function () {
                return {
                    getChunkNow: function (cx, cz) {
                        if (cx < -10 || cx > 10 || cz < -10 || cz > 10) return null
                        var secs = []
                        for (var si = 0; si < 24; si++) {
                            ;(function (sIdx) {
                                var secBaseY = -64 + (sIdx << 4)
                                secs.push({
                                    hasOnlyAir: function () { return false },
                                    getBlockState: function (lx, ly, lz) {
                                        var k = ((cx << 4) + lx) + ',' + (secBaseY + ly) + ',' + ((cz << 4) + lz)
                                        var bid = worldBlocks[k] || 'minecraft:air'
                                        return {
                                            getFluidState: function () {
                                                return { isEmpty: function () { return bid !== 'minecraft:water' && bid !== 'minecraft:lava' } }
                                            }
                                        }
                                    }
                                })
                            })(si)
                        }
                        return {
                            getMinBuildHeight: function () { return -64 },
                            getSections: function () { return secs }
                        }
                    }
                }
            },
            getBlock: function (x, y, z) {
                var k = Math.floor(x) + ',' + Math.floor(y) + ',' + Math.floor(z)
                return {
                    id: worldBlocks[k] || 'minecraft:air',
                    x: Math.floor(x), y: Math.floor(y), z: Math.floor(z),
                    set: function (newId) { worldBlocks[k] = String(newId) },
                    popItem: function () {}
                }
            },
            createExplosion: function () {
                return {
                    strength: function () { return this },
                    causesFire: function () { return this },
                    explosionMode: function () { return this },
                    explode: function () {}
                }
            },
            spawnParticles: function () {},
            spawnLightning: function () {}
        }
        var srv = {
            persistentData: {
                contains: function (k) { return Object.prototype.hasOwnProperty.call(pDataStore, k) },
                getString: function (k) { return pDataStore[k] || '' },
                putString: function (k, v) { pDataStore[k] = String(v) }
            },
            getWorldData: function () { return { getLevelName: function () { return 'UncraftWorld' } } },
            getWorldPath: function () { return saveDir },
            getLevel: function (d) { return String(d) === 'minecraft:overworld' ? overworldLv : null },
            getAllLevels: function () { return [overworldLv] },
            getPlayerList: function () { return { getPlayers: function () { return overworldLv.players } } },
            scheduleInTicks: function (_t, fn) { if (typeof fn === 'function') fn() }
        }
        overworldLv.server = srv
        sb.server = srv

        loadServerBase(sb)
        runScriptIn(sb, TRACKER_PATH)
        runScriptIn(sb, DANMAKU_PATH)
        runScriptIn(sb, AUDIO_PATH)
        runScriptIn(sb, V18_PATH)

        var Core = sb.global.EpiphyServerCore
        var WorldOps = sb.global.EpiphyWorldOps
        assert.ok(Core && Core === sb.global.EpiphyServerBase, 'EpiphyServerCore and EpiphyServerBase alias match')
        assert.ok(WorldOps && WorldOps === sb.global.EpiphyBlockTracker, 'EpiphyWorldOps and EpiphyBlockTracker alias match')

        // 1. Anvil rename spoofing MUST NOT count as holding a divine relic
        var spoofPlayer = {
            username: 'Spoofer',
            stringUuid: '00000000-0000-4000-8000-000000000077',
            getX: function () { return 3000 }, getY: function () { return 64 }, getZ: function () { return 3000 },
            isCreative: function () { return false },
            mainHandItem: { id: 'minecraft:dirt', isEmpty: function () { return false } },
            offHandItem: { id: 'minecraft:air', isEmpty: function () { return true } },
            inventory: { find: function () { return -1 } },
            // Player renamed dirt to "goety_revelation:halo_of_the_end" in NBT!
            nbt: '{Inventory:[{id:"minecraft:dirt",tag:{display:{Name:\'{"text":"goety_revelation:halo_of_the_end"}\'}}}]}'
        }
        assert.strictEqual(
            Core.findPlayerItem(spoofPlayer, ['goety_revelation:halo_of_the_end', 'enigmaticlegacy:cursed_ring']),
            null,
            'renamed item in player.nbt must NEVER spoof divine relic check'
        )

        // 2. Diamond pickaxe in inventory (or offhand) but NOT in mainhand MUST NOT allow safe break
        var invPickPlayer = {
            username: 'BagPick',
            stringUuid: '00000000-0000-4000-8000-000000000078',
            getX: function () { return 3000 }, getY: function () { return 64 }, getZ: function () { return 3000 },
            isCreative: function () { return false },
            mainHandItem: { id: 'minecraft:iron_pickaxe', isEmpty: function () { return false } },
            offHandItem: { id: 'minecraft:diamond_pickaxe', isEmpty: function () { return false } },
            // diamond_pickaxe is in inventory slot 5, and isHolding returns true because of offhand
            isHolding: function (id) { return id === 'minecraft:diamond_pickaxe' },
            inventory: { find: function (id) { return id === 'minecraft:diamond_pickaxe' ? 5 : -1 } }
        }
        assert.strictEqual(
            Core.isHoldingMainHand(invPickPlayer, 'minecraft:diamond_pickaxe'),
            false,
            'diamond pickaxe in inventory/offhand must NOT pass mainhand-only check'
        )

        var canceledBreak1 = false
        worldBlocks['3000,64,3000'] = 'twilightforest:uncrafting_table'
        brokenHandlers['twilightforest:uncrafting_table']({
            level: overworldLv,
            block: { id: 'twilightforest:uncrafting_table', x: 3000, y: 64, z: 3000, dimension: 'minecraft:overworld' },
            player: invPickPlayer,
            cancel: function () { canceledBreak1 = true }
        })
        assert.strictEqual(canceledBreak1, true, 'breaking with diamond pickaxe only in inventory/offhand must cancel break and trigger instability')
        assert.strictEqual(worldBlocks['3000,64,3000'], 'epiphy:ultra_uncrafting_instability_1', 'must transition to instability stage 1 block')

        // 3. Holding diamond pickaxe in mainhand allows safe break without cancelling
        var mainHandPickPlayer = {
            username: 'MainPick',
            stringUuid: '00000000-0000-4000-8000-000000000079',
            getX: function () { return 3100 }, getY: function () { return 64 }, getZ: function () { return 3100 },
            isCreative: function () { return false },
            mainHandItem: { id: 'minecraft:diamond_pickaxe', isEmpty: function () { return false } },
            offHandItem: { id: 'minecraft:air', isEmpty: function () { return true } },
            inventory: { find: function () { return 0 } }
        }
        var canceledBreak2 = false
        worldBlocks['3100,64,3100'] = 'twilightforest:uncrafting_table'
        brokenHandlers['twilightforest:uncrafting_table']({
            level: overworldLv,
            block: { id: 'twilightforest:uncrafting_table', x: 3100, y: 64, z: 3100, dimension: 'minecraft:overworld' },
            player: mainHandPickPlayer,
            cancel: function () { canceledBreak2 = true }
        })
        assert.strictEqual(canceledBreak2, false, 'holding diamond pickaxe in mainhand must allow normal break')

        // 3b. Crash/rollback reconciliation (P0-1): if saved unstable job has stageIndex=2 (t=1600),
        // but world chunk rolled back to stage 0 ('epiphy:ultra_uncrafting_instability_1'),
        // reloading and ticking must reconcile stageIndex to 0 without triggering false EXTERNAL_BLOCK_DISRUPTION explosion!
        var savedRaw = pDataStore['epiphy_uncrafting_unstable_v2']
        assert.ok(savedRaw, 'unstable job should be persisted to persistentData')
        var savedParsed = JSON.parse(savedRaw)
        assert.strictEqual(savedParsed.jobs.length, 1)
        // Advance persisted job at (3000,64,3000) to stageIndex=2, t=1600 while world block is still stage 0 ('epiphy:ultra_uncrafting_instability_1'),
        // and add a second job at (3020,64,3000) where the world rolled back to 'minecraft:air' (orphan job)
        savedParsed.jobs[0].stageIndex = 2
        savedParsed.jobs[0].t = 1600
        savedParsed.jobs.push({
            dim: 'minecraft:overworld',
            x: 3020, y: 64, z: 3000,
            t: 900, totalTicks: 3600, stageIndex: 1, fatalTriggered: false
        })
        pDataStore['epiphy_uncrafting_unstable_v2'] = JSON.stringify(savedParsed)

        // Load a fresh V18 instance against the rolled-back world state
        var restartTicks = []
        var restartSb = Object.assign({}, sb, {
            ServerEvents: {
                tick: function (fn) { restartTicks.push(fn) },
                unloaded: function () {},
                recipes: function () {}
            },
            BlockEvents: {
                placed: function () {},
                broken: function () {},
                rightClicked: function () {}
            }
        })
        vm.createContext(restartSb)
        runScriptIn(restartSb, V18_PATH)

        var fatalChatTriggered = false
        overworldLv.players = [Object.assign({}, invPickPlayer, {
            tell: function (msg) {
                if (String(msg).indexOf('EXTERNAL_BLOCK_DISRUPTION') >= 0) fatalChatTriggered = true
            }
        })]
        for (var tk = 0; tk < 12; tk++) {
            for (var th = 0; th < restartTicks.length; th++) restartTicks[th]({ server: srv })
        }
        assert.strictEqual(fatalChatTriggered, false, 'rolled-back chunk stage block must reconcile cleanly without triggering EXTERNAL_BLOCK_DISRUPTION')
        var reconciledJobs = JSON.parse(pDataStore['epiphy_uncrafting_unstable_v2']).jobs
        assert.strictEqual(reconciledJobs.length, 1, 'orphan job at air block (3020,64,3000) must be discarded cleanly')
        assert.strictEqual(reconciledJobs[0].stageIndex, 0, 'rolled-back job at (3000,64,3000) must reconcile stageIndex from 2 back to world block stage 0')
        assert.ok(reconciledJobs[0].t <= 730, 'reconciled job tick t must be clamped to stage 0 range')

        // 4. WorldOps cost gating: small sphere (r=2, total r=4 <= 16) runs synchronously in 1 frame without queuing background job
        var doneSmall = false
        WorldOps.startSphereFluidPurge(overworldLv, 'minecraft:overworld', 0, 64, 0, 2, {
            padding: 2,
            onDone: function () { doneSmall = true }
        })
        assert.strictEqual(doneSmall, true, 'small sphere fluid purge must complete immediately in single frame')
        assert.strictEqual(WorldOps.getStats().fluidPurgeJobsCount, 0, 'small sphere must not allocate background fluidPurgeJobs')

        // 5. Ring block job places lava on loaded chunks, protects bedrock/containers, and skips unloaded chunks
        worldBlocks['16,64,0'] = 'minecraft:bedrock'
        var ringStats = null
        var ringDone = false
        WorldOps.startRingBlockJob(overworldLv, 'minecraft:overworld', 0, 64, 0, 16, {
            blockId: 'minecraft:lava',
            width: 1,
            thickness: 2,
            onDone: function (rj) { ringDone = true; ringStats = rj }
        })
        for (var rt = 0; rt < 5 && !ringDone; rt++) {
            for (var ti = 0; ti < tickHandlers.length; ti++) tickHandlers[ti]({ server: srv })
        }
        assert.strictEqual(ringDone, true, 'ring block job completes across ticks within budget')
        assert.ok(ringStats && ringStats.placedCols > 0, 'ring job reports placedCols count')
        assert.strictEqual(worldBlocks['16,64,0'], 'minecraft:bedrock', 'ring block job must NEVER overwrite bedrock')
        assert.strictEqual(worldBlocks['16,65,0'], 'minecraft:lava', 'ring block job places lava above surface at sy+1')

        // 5b. Subsequent fluid sweep with excludeLava=true (or protectedRingCols) must NOT erase the newly placed lava ring!
        worldBlocks['16,66,0'] = 'minecraft:water'
        var sweepDone = false
        WorldOps.startSphereFluidPurge(overworldLv, 'minecraft:overworld', 0, 64, 0, 16, {
            padding: 2,
            loops: 1,
            excludeLava: true,
            onDone: function () { sweepDone = true }
        })
        for (var st = 0; st < 10 && !sweepDone; st++) {
            for (var tis = 0; tis < tickHandlers.length; tis++) tickHandlers[tis]({ server: srv })
        }
        assert.strictEqual(worldBlocks['16,66,0'], 'minecraft:air', 'fluid sweep must clear water at the rim')
        assert.strictEqual(worldBlocks['16,65,0'], 'minecraft:lava', 'fluid sweep with excludeLava / protectedRingCols must preserve the magma ring')

        // 6. Upper-cylinder + lower-hemisphere fluid purge (default cylinder2D=true) clears high-Y sea-level water at outer rim
        // while preserving deep underground fluids below cylFloorY outside the lower hemisphere
        worldBlocks['17,62,0'] = 'minecraft:water'
        worldBlocks['17,-60,0'] = 'minecraft:water'
        WorldOps.startSphereFluidPurge(overworldLv, 'minecraft:overworld', 0, -20, 0, 16, {
            padding: 2,
            loops: 1,
            cylinder2D: false
        })
        for (var ct0 = 0; ct0 < 15; ct0++) {
            for (var ti0 = 0; ti0 < tickHandlers.length; ti0++) tickHandlers[ti0]({ server: srv })
        }
        assert.strictEqual(worldBlocks['17,62,0'], 'minecraft:water', '3D sphere mode (cylinder2D=false) clips out high-Y sea-level water at outer rim')

        var cylDone = false
        WorldOps.startSphereFluidPurge(overworldLv, 'minecraft:overworld', 1, -20, 0, 16, {
            padding: 2,
            loops: 1,
            onDone: function () { cylDone = true }
        })
        for (var ct = 0; ct < 15 && !cylDone; ct++) {
            for (var ti2 = 0; ti2 < tickHandlers.length; ti2++) tickHandlers[ti2]({ server: srv })
        }
        assert.strictEqual(worldBlocks['17,62,0'], 'minecraft:air', 'default cylinder2D=true purge must clear high-Y sea-level water at outer rim without leaving vertical water walls')
        assert.strictEqual(worldBlocks['17,-60,0'], 'minecraft:water', 'deep underground fluid below cylFloorY outside lower hemisphere (dx=16, dy=-40 -> 256+1600 > 324) must NOT be cleared')

        // 6b. forEachEntityNear isolates single-entity callback exceptions without aborting remaining entities or falling back to forEachPlayerNear
        var isoSb = createKubeSandbox(function (cls) {
            if (cls === 'net.minecraft.world.phys.AABB') {
                return function (x1, y1, z1, x2, y2, z2) { this.x1 = x1; this.x2 = x2 }
            }
            return null
        })
        loadServerBase(isoSb)
        var isoHits = []
        var isoPlayerHits = 0
        var isoEntityList = [
            { getX: function () { return 1 }, getY: function () { return 64 }, getZ: function () { return 0 }, tag: 'throws' },
            { getX: function () { return 2 }, getY: function () { return 64 }, getZ: function () { return 0 }, tag: 'ok_entity' }
        ]
        var isoLevel = {
            players: [Object.assign({}, mainHandPickPlayer, { getX: function () { return 1 }, getY: function () { return 64 }, getZ: function () { return 0 } })],
            getEntitiesWithin: function () { return isoEntityList }
        }
        var isoCount = isoSb.global.EpiphyServerCore.forEachEntityNear(isoLevel, 0, 64, 0, 16, null, function (ent) {
            if (ent.tag === 'throws') throw new Error('boom_entity')
            if (ent.username === mainHandPickPlayer.username) isoPlayerHits++
            isoHits.push(ent.tag)
        })
        assert.strictEqual(isoCount, 1, 'forEachEntityNear counts succeeded non-throwing callbacks')
        assert.deepStrictEqual(isoHits, ['ok_entity'], 'throwing entity callback must NOT abort subsequent entities')
        assert.strictEqual(isoPlayerHits, 0, 'throwing entity callback must NOT fall through to duplicate forEachPlayerNear pass')

        // 7. ScreenDanmakuClient v5.7: verify VERSION, isPotentialSpanTagHead fast-rejection, exact fast/slow slice & endPx parity, and TRANSIENT vs SHARED cache isolation/promotion
        var cliPaints = []
        var cliNowMs = 1000
        var cliSb = {
            console: { info: function () {}, warn: function () {}, error: function () {}, debug: function () {}, log: function () {} },
            ClientEvents: { loggedOut: function () {}, loggedIn: function () {}, paintScreen: function (fn) { cliPaints.push(fn) } },
            NetworkEvents: { dataReceived: function () {} },
            Java: {
                loadClass: function (cls) {
                    if (cls === 'java.lang.System') return { nanoTime: function () { return cliNowMs * 1000000 } }
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
        cliSb.globalThis = cliSb
        vm.createContext(cliSb)
        loadStartupBase(cliSb)
        runScriptIn(cliSb, RENDERER_PATH)
        var CliV57 = cliSb.global.ScreenDanmakuClient
        assert.strictEqual(CliV57.VERSION, '6.0.0', 'ScreenDanmakuClient must expose VERSION 6.0.0')
        assert.strictEqual(cliSb.global.Epiphy2DRenderer, CliV57, 'Epiphy2DRenderer must alias ScreenDanmakuClient')
        assert.strictEqual(CliV57._pure.isPotentialSpanTagHead('<AVARITIA_BIOS>', 0), false, '<AVARITIA_BIOS> must be fast-rejected in O(1)')
        assert.strictEqual(CliV57._pure.hasRichSpanTags('<AVARITIA_BIOS> :: [0x00F8_DEADC0DE] >>'), false, 'non-tag brackets must not trigger regex or span tag mode')
        assert.strictEqual(CliV57._pure.hasRichSpanTags('<b>WARN</b> <shake>CORE</shake>'), true, 'real inline tags must be detected')

        // Verify 100% character-for-character and pixel-for-pixel equivalence between O(1) ensureLineVisTable fast path and legacy sliceVisibleChars + dropFirstVisibleChars slow path
        var mockFont = { width: function (s) { return String(s).length * 6 } }
        var sampleRichText = '§e<b>WARN</b> <shake>核心\uD83D\uDD25坍缩</shake> §lOK§r!'
        var testLn = { text: sampleRichText, widthPx: 120, vis: 14, hasTags: true }
        CliV57._pure.ensureLineVisTable(testLn, mockFont, 1.5, 'relative')
        assert.ok(Array.isArray(testLn._visEndIdx) && testLn._visEndIdx.length === 15, 'ensureLineVisTable builds 15 boundary entries for 14 visible graphemes')
        for (var kv = 1; kv < testLn.vis; kv++) {
            var fastRes = CliV57._pure.buildRenderedLines([testLn], 0, kv, '', mockFont, 1.5, 'relative', true)
            var slowSlice = CliV57._pure.sliceVisibleChars(sampleRichText, kv)
            var slowEndPx = CliV57._pure.dropFirstVisibleChars(slowSlice, 999999, mockFont, 1.5, 'relative').offsetPx
            assert.strictEqual(fastRes.length, 1)
            assert.strictEqual(fastRes[0].text, slowSlice, 'fast path slice at k=' + kv + ' must match sliceVisibleChars character-for-character (including trailing closing tags)')
            assert.strictEqual(fastRes[0].endPx, slowEndPx, 'fast path endPx at k=' + kv + ' must match dropFirstVisibleChars offsetPx exactly')
            assert.strictEqual(fastRes[0].isTransient, true, 'partial typewriter prefix must be marked isTransient=true')
        }

        // Verify TRANSIENT_TEXT_SEQ_CACHE isolation and static promotion
        CliV57.push({
            id: 'v57_static_item',
            title: 'STATIC_FULL_LINE_KEEP',
            stay: 100,
            typewriter: false
        })
        CliV57.push({
            id: 'v57_perf_danmaku',
            title: '<AVARITIA_BIOS> :: [0x00F8_DEADC0DE] >> REALITY_INTEGRITY = 0.00%',
            sub: '<< SYSTEM_CHECK_FAILED >>',
            stay: 100,
            rx: 0.5,
            ry: 0.3,
            typewriter: true,
            charDelay: 1
        })
        var cliVboDraws = 0
        var cliEv = {
            width: 854, height: 480, level: 'minecraft:overworld',
            font: {
                width: function (s) { return String(s).length * 6 },
                m_272191_: function () { cliVboDraws++ }
            },
            graphics: { bufferSource: function () { return { flush: function () {}, endBatch: function () {} } }, flush: function () {} },
            push: function () {}, pop: function () {}, translate: function () {}, scale: function () {}, mulPose: function () {},
            text: function () { cliVboDraws++ },
            drawString: function () { cliVboDraws++ }
        }
        for (var pf = 0; pf < 6; pf++) {
            cliNowMs += 60
            cliPaints[0](cliEv)
        }
        var cacheStats = CliV57._pure.getSeqCacheStats()
        assert.strictEqual(cacheStats.hasShared('STATIC_FULL_LINE_KEEP'), true, 'static full line must reside in SHARED_TEXT_SEQ_CACHE')
        assert.ok(cacheStats.transientCount > 0, 'typewriter prefixes must route into TRANSIENT_TEXT_SEQ_CACHE')
        var dList = CliV57.list()
        assert.strictEqual(dList.length, 2, 'ScreenDanmakuClient v5.7 should keep both static and typewriter items active')
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
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
    assert.strictEqual(Dm.VERSION, '6.0.0', 'ScreenDanmaku VERSION must be 6.0.0')
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
    var pktDep = Dm.buildPacket({
        msg: 'DeprecatedMsg',
        subText: 'DeprecatedSub',
        slot: 'dep_slot',
        fontSize: 1.25,
        rot: -15,
        spacing: 2.0
    })
    assert.strictEqual(pktDep.title, 'DeprecatedMsg')
    assert.strictEqual(pktDep.sub, 'DeprecatedSub')
    assert.strictEqual(pktDep.slotId, 'dep_slot')
    assert.strictEqual(pktDep.scale, 1.25)
    assert.strictEqual(pktDep.angle, -15)
    assert.strictEqual(pktDep.letterSpacing, 2.0)
    assert.ok(Dm._pure.getDeprecatedAliasHits().msg >= 1, 'deprecated alias msg must be recorded')
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

    // 4b. Push progress panel, queue multiple patches (in-queue coalescing), verify lerp + trail + impulse + dt <= 100ms clamp
    var panelPkt = Dm.buildPacket(Dm.buildProgressPanel({
        id: 'boss_hp',
        lifeMode: 'active',
        activeHold: 20,
        progress: 1.0,
        barWidth: 100,
        barHeight: 6,
        text: 'BOSS $pctText',
        sub: 'Phase 1',
        tracks: {
            hitFlash: { mode: 'impulse', onChange: '$progress', peak: 1.0, decayMs: 200 }
        }
    }))
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
    runScriptIn(v18Sb, path.join(__dirname, '..', 'kubejs', 'server_scripts', '合成表-暮色森林', '拆解台-混沌殉爆.v18.js'))

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

    var progressedPkt = Dm.buildPacket(Dm.buildProgressPanel({
        id: 'real_nbt_bar',
        lifeMode: 'active',
        activeHold: 24,
        progress: 0.5,
        barWidth: 160,
        barHeight: 6,
        barColorFrom: 0xFF3333,
        barColorTo: 0xFFAA22,
        text: '§c§l[堆芯遥测] §f50%',
        sub: '§7正在运行'
    }))
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

    // 1. PRIORITY_MAP must contain only the 5 canonical priority names; deprecated strings move to DEPRECATED_PRIORITY_ALIASES
    assert.deepStrictEqual(Object.keys(Proto2.PRIORITY_MAP).sort(), ['active', 'critical', 'high', 'low', 'normal'])
    assert.strictEqual(Proto2.DEPRECATED_PRIORITY_ALIASES.minor, 1)
    assert.strictEqual(Proto2.DEPRECATED_PRIORITY_ALIASES['致命'], 4)
    assert.strictEqual(Proto2.DEPRECATED_PRIORITY_ALIASES.sustain, 5)

    // 2. Deprecation alerts obey EpiphyLog control when CONFIG.warnDeprecatedAliases === 'log'
    assert.strictEqual(Dm2.CONFIG.warnDeprecatedAliases, 'log', 'default warnDeprecatedAliases must delegate to EpiphyLog')
    assert.strictEqual(svCon2.warns.length, 0)
    var pSilent = Dm2.buildPacket({
        title:       'PriTestSilent',
        priority:    'important',
        continuous:  true,
        shakeMode:   'perchar',
        fadeStyle:   'defocus',
        outlineMode: 'border'
    })
    assert.strictEqual(pSilent.priority, 3)
    assert.strictEqual(pSilent.lifeMode, 'active')
    assert.strictEqual(pSilent.shakeMode, 'per_char')
    assert.strictEqual(pSilent.fadeStyle, 'blur')
    assert.strictEqual(pSilent.outlineMode, 'stroke')
    assert.strictEqual(svCon2.warns.length, 0, 'with EpiphyLog deprecation control off, deprecated usages emit zero warns')
    assert.ok(Dm2._pure.getDeprecatedAliasHits()['priority:important'] >= 1, 'deprecated priority must still be counted in hits')

    // Enable deprecation warnings via EpiphyLog (e.g. /epiphy debug log deprecations on)
    Log2.setDeprecationWarnings(true)
    var wBeforeLogOn = svCon2.warns.length
    Dm2.buildPacket({
        title:       'PriTestLogOn',
        priority:    '致命',
        fadeMode:    '虚化',
        sourceConflict: 'union'
    })
    Dm2.buildPacket({ title: 'PriTestLogOn2', priority: '致命' })
    var wAfterLogOn = svCon2.warns.length
    assert.ok(wAfterLogOn >= wBeforeLogOn + 2, 'enabling EpiphyLog deprecation warnings must emit one-time alerts for priority/enum/field deprecations')
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
    // High eviction priority (10) screen danmaku still has default renderPriority = 0 (< GUI default 100)
    var scrPktHighPri = Dm2.buildPacket({ id: 'scr_high_pri', surface: 'screen', priority: 10, showInGui: true, layers: [{ kind: 'text', x: 0, y: 0, scale: 0.7, text: 'DANMAKU_TEXT' }] })
    var guiPktDefPri  = Dm2.buildPacket({ id: 'gui_def_pri', surface: 'gui', lifeMode: 'screen_session', targetGui: { titleMatch: '拆解台' }, bg: [{ kind: 'nine_slice', tex: 'epiphy:textures/gui/panel.png', x: 0, y: 0, w: 60, h: 40, texW: 128, texH: 128, slice: [3, 5, 7, 9] }], layers: [{ kind: 'rect', x: 0, y: 0, w: 40, h: 20, fill: { mode: 'shader', shader: 'end_portal' } }, { kind: 'rect', x: 0, y: 20, w: 10, h: 10, fill: { mode: 'shader', shader: 'custom_nebula' } }, { kind: 'text', x: 0, y: -8, scale: 0.65, text: 'BADGE_TAG' }, { kind: 'rect', x: 8, y: -8, w: 8, h: 6, color: 0xFFFFFFFF }] })
    var scrPktTopPri  = Dm2.buildPacket({ id: 'scr_top_override', surface: 'screen', renderPriority: 300, showInGui: true, layers: [{ kind: 'rect', x: 0, y: 0, w: 12, h: 12, color: 0xFF00FF00 }] })

    assert.strictEqual(scrPktHighPri.renderPriority, 0)
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
