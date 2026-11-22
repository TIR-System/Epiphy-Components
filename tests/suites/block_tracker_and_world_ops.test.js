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
            assert.strictEqual(CliV57.VERSION, '6.2.1', 'ScreenDanmakuClient must expose VERSION 6.2.1')
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
}
