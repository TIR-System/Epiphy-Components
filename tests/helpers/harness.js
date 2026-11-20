// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
'use strict'

var assert = require('assert')
var fs     = require('fs')
var path   = require('path')
var vm     = require('vm')

var ROOT_DIR          = path.resolve(__dirname, '..', '..')
var SPEC_PATH         = path.join(ROOT_DIR, 'kubejs', 'startup_scripts', '通用组件', 'Epiphy的-Spec与通用工具.js')
var LOG_PATH          = path.join(ROOT_DIR, 'kubejs', 'server_scripts',  '通用组件', 'Epiphy的-日志.js')
var SERVER_BASE_PATH  = path.join(ROOT_DIR, 'kubejs', 'server_scripts',  '通用组件', 'Epiphy的-服务端核心.js')
var TRACKER_PATH      = path.join(ROOT_DIR, 'kubejs', 'server_scripts',  '通用组件', 'Epiphy的-方块与区块组件.js')
var VALVE_PATH        = path.join(ROOT_DIR, 'kubejs', 'server_scripts',  '通用组件', 'Epiphy的-权限阀.js')
var DEBUG_PATH        = path.join(ROOT_DIR, 'kubejs', 'server_scripts',  '通用组件', 'Epiphy的-调试组件.js')
var BUGFIX_PATH       = path.join(ROOT_DIR, 'kubejs', 'server_scripts',  '通用组件', 'Epiphy的-基础bug修复.js')
var DANMAKU_PATH      = path.join(ROOT_DIR, 'kubejs', 'server_scripts',  '通用组件', 'Epiphy的-平面渲染组件.js')
var AUDIO_PATH        = path.join(ROOT_DIR, 'kubejs', 'server_scripts',  '通用组件', 'Epiphy的-音频组件.js')
var RENDERER_PATH     = path.join(ROOT_DIR, 'kubejs', 'client_scripts',  '通用组件', 'Epiphy的-平面渲染器.js')
var AUDIO_CLIENT_PATH = path.join(ROOT_DIR, 'kubejs', 'client_scripts',  '通用组件', 'Epiphy的-音频播放器.js')

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
    sb.console.info  = function (m) { cap.infos.push(String(m)) }
    sb.console.warn  = function (m) { cap.warns.push(String(m)) }
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

// vm.runInContext 创建的对象与宿主 Realm 原型不同，assert.deepStrictEqual 会因跨 Realm 原型报错，故归一化后深度对比
function plain(obj) {
    return JSON.parse(JSON.stringify(obj))
}

var _sharedDefault = null
function getSharedDefaultSandbox() {
    if (_sharedDefault != null) return _sharedDefault
    var sandbox = createKubeSandbox()
    loadServerBase(sandbox)
    runScriptIn(sandbox, VALVE_PATH)
    runScriptIn(sandbox, DANMAKU_PATH)
    var Valve   = sandbox.global.EpiphyPermissionValve
    var Danmaku = sandbox.global.ScreenDanmaku
    var pure    = Danmaku && Danmaku._pure
    assert.ok(Valve && typeof Valve.normalizePermissionPolicy === 'function', 'EpiphyPermissionValve.normalizePermissionPolicy must exist')
    assert.ok(pure && typeof pure.parseSize === 'function', 'ScreenDanmaku._pure must be exported')
    _sharedDefault = { sandbox: sandbox, Valve: Valve, Danmaku: Danmaku, pure: pure }
    return _sharedDefault
}

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
    NodeJavaFile.prototype.lastModified = function () { return fs.existsSync(this._p) ? fs.statSync(this._p).mtimeMs : 0 }
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

module.exports = {
    assert:                  assert,
    fs:                      fs,
    path:                    path,
    vm:                      vm,
    ROOT_DIR:                ROOT_DIR,
    SPEC_PATH:               SPEC_PATH,
    LOG_PATH:                LOG_PATH,
    SERVER_BASE_PATH:        SERVER_BASE_PATH,
    TRACKER_PATH:            TRACKER_PATH,
    VALVE_PATH:              VALVE_PATH,
    DEBUG_PATH:              DEBUG_PATH,
    BUGFIX_PATH:             BUGFIX_PATH,
    DANMAKU_PATH:            DANMAKU_PATH,
    AUDIO_PATH:              AUDIO_PATH,
    RENDERER_PATH:           RENDERER_PATH,
    AUDIO_CLIENT_PATH:       AUDIO_CLIENT_PATH,
    createKubeSandbox:       createKubeSandbox,
    attachConsoleCapture:    attachConsoleCapture,
    runScriptIn:             runScriptIn,
    loadStartupBase:         loadStartupBase,
    loadServerBase:          loadServerBase,
    plain:                   plain,
    getSharedDefaultSandbox: getSharedDefaultSandbox,
    makeMockWorld:           makeMockWorld,
    attachSandboxEventHooks: attachSandboxEventHooks,
    makeNodeBackedJavaSandbox: makeNodeBackedJavaSandbox
}
