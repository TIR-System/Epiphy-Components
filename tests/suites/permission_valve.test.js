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
}
