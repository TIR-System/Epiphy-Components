// priority: 1000
// ============================================================================
//  通用指令权限阀与 /epiphy 根命令注册中心 (EpiphyPermissionValve v4)
//  所属系列：Epiphy的-通用组件系列（本系列包含 startup / server / client 配套脚本）
//  [LLM 协作规范] 每次进行较大修改或重构前，请先将修改同步至 D:\Git-Epiphy 并执行 git commit 保存当前可用状态，便于随时回退与对比 diff。
//  许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
//  放置位置：kubejs/server_scripts/通用组件/Epiphy的-权限阀.js
//
//  职责说明：
//    1. 统一接管 `/epiphy` 根指令树，向各业务组件提供子命令挂载与 `/epiphy help` 帮助聚合（总览仅显示各模块一句话 summary，输入 `/epiphy help <模块>` 查看详情）；
//    2. 按存档独立持久化授权记录（含审计元数据）：
//       - 使用 KubeJS 原生 `JsonIO` 将每个存档的授权列表独立保存在该存档目录下（`saves/<存档>/kubejs_epiphy_permissions.json`，
//         若无法解析世界路径则按存档名落盘至 `kubejs/config/epiphy_permissions/<存档名>.json`）；
//       - 每条 scope 授权均记录 `{ by: '<授权人>', at: '<ISO时间>', playerName: '<被授权玩家名>' }`，支持在 `/epiphy auth list` 与 JSON 中追溯；
//    3. 严格的调用源类型甄别（纯 `Class.isInstance` 校验，零类名字符串模糊匹配）：
//       - 【命令方块 (BaseCommandBlock)】：确认 `source.source` 为 `BaseCommandBlock` 实例后按 `policy.allowCommandBlock` 判定；
//       - 【控制台 (MinecraftServer / RconConsoleSource)】：确认实例类型后进入 `policy.allowConsole` 与 `opLevel` 权限查询；
//       - 【玩家聊天框 (ServerPlayer)】：确认 `source.source === player` 且为 `ServerPlayer` 实例后，进入子命令声明的 `policy` 查询；
//       - 【其他函数以命令形式调用】：
//         * 调用方必须先通过 `declareCaller(callerId, ['danmaku', ...])` 注册明确的受控子命令白名单（无默认 `'*'`），
//           并在执行时通过 `withDeclaration(callerId, fn)` 或 `runDeclaredCommand` 声明；
//         * 同时目标子命令的 `policy` 必须允许声明式函数调用（`allowDeclaredCallers: true` 且若配置了 `allowedCallers` 白名单须命中；`auth` 节点永久禁止脚本函数代调）；
//    4. 兼顾 Tab 补全隐藏与明确拒绝提示：
//       - 子命令根节点挂载安全包裹 `try/catch` 的 `.requires(...)`，使未获授权玩家在聊天框按 Tab 时看不到无权访问的子命令树；
//       - 同时在 `/epiphy` 根下挂载 fallback 捕获分支，当无权限源强行手敲 `/epiphy <子命令> ...` 时，不会收到原版 `Unknown command`，
//         而是由权限阀精准输出中文拒绝原因（如未开启作弊、缺少管理员/授权资格或未声明调用源）。
//
//  依赖与缺失降级：
//    - 可选依赖：kubejs/server_scripts/通用组件/Epiphy的-日志.js (EpiphyLog, priority: 1100)
//      缺失时回退至原生 console.warn / console.error。
//    - 若缺失本文件：`/epiphy` 根命令及同系列子命令（danmaku / audio / auth / help）均不会注册，
//      同系列业务组件仅保留 JS 调用接口并在 OP 登录时提示权限阀未加载；后续通过 `/reload` 补全本文件时，
//      会自动从 `global.EpiphyCommandRegistryQueue` 补齐待注册子命令。
//    - 注：调用 `registerSubcommand` 时若未声明 `permission`，将告警并按最小权限默认设为 `admin`（仅 OP）。
//
//  [Rhino 语法兼容性约定] KubeJS 2001.6.x 内置 Rhino 对 ES6 支持不完整且存在语义偏差（如 `let`/`const`
//    TDZ/循环闭包偏差与部分语法糖在 Java 类包装下报错）。故本系列变量统一用 `var`，权限阀等核心基础模块维持
//    ES5 + 稳定容器语法；音频模块则采用经实测稳定的 ES6 子集（`=>` / 模板字符串 / `for..of`）。请勿引入 `let`/`const`。
// ============================================================================

;(function () {
    var ROOT_LITERAL    = 'epiphy'
    var FALLBACK_DIR    = 'kubejs/config/epiphy_permissions'
    var WORLD_FILE_NAME = 'kubejs_epiphy_permissions.json'

    var SERVER_REF = null

    // 【catch 约定】日志设施自身的兜底：console / EpiphyLog 不可用时已无更低层可退，留空。
    function logWarn(tag, msg) {
        if (typeof global !== 'undefined' && global.EpiphyLog != null) {
            global.EpiphyLog.warn('EpiphyPermissionValve', tag, msg)
        } else {
            try { console.warn('[EpiphyPermissionValve ' + tag + '] ' + msg) } catch (e) { }
        }
    }

    function logError(tag, msg) {
        if (typeof global !== 'undefined' && global.EpiphyLog != null) {
            global.EpiphyLog.error('EpiphyPermissionValve', tag, msg)
        } else {
            try { console.error('[EpiphyPermissionValve ' + tag + '] ' + msg) } catch (e) { }
        }
    }

    function logCatch(tag, err) {
        if (typeof global !== 'undefined' && global.EpiphyLog != null) {
            global.EpiphyLog.catchWarn('EpiphyPermissionValve', tag, err)
        } else {
            try { console.warn('[EpiphyPermissionValve 异常:' + tag + '] ' + String(err)) } catch (e) { }
        }
    }

    function logOnceWarn(key, msg) {
        if (typeof global !== 'undefined' && global.EpiphyLog != null) {
            global.EpiphyLog.once('warn', key, msg)
        } else {
            try { console.warn(msg) } catch (e) { }
        }
    }

    function loadJavaClass(className) {
        try {
            return Java.loadClass(className)
        } catch (e) {
            if (typeof global !== 'undefined' && global.EpiphyLog != null) {
                global.EpiphyLog.debug('EpiphyPermissionValve', 'loadJavaClass', '未加载类 ' + className + ': ' + e)
            }
            return null
        }
    }

    // 仅用于跨版本/跨映射的 Java 方法或属性探测（失败属正常回退路径）
    function tryCall(fn, fallbackVal) {
        try {
            var res = fn()
            return res !== undefined ? res : fallbackVal
        } catch (e) {
            return fallbackVal
        }
    }

    var BaseCommandBlockClass  = loadJavaClass('net.minecraft.world.level.BaseCommandBlock')
    var MinecraftServerClass   = loadJavaClass('net.minecraft.server.MinecraftServer')
    var RconConsoleSourceClass = loadJavaClass('net.minecraft.server.rcon.RconConsoleSource')
    var ServerPlayerClass      = loadJavaClass('net.minecraft.server.level.ServerPlayer')
    var LevelResourceClass     = loadJavaClass('net.minecraft.world.level.storage.LevelResource')
    var FilesClass             = loadJavaClass('java.nio.file.Files')

    // 注意：Java.loadClass(...) 返回的是 Rhino 的 NativeJavaClass 静态成员包装器（仅暴露该类的静态字段/方法），
    // 直接访问 NativeJavaClass.isInstance 会抛 InternalError: Java class "..." has no public instance field or method named "isInstance"！
    // 要进行严格类型校验，必须支持：
    //   1. JS `obj instanceof NativeJavaClass`（Rhino 原生支持对 NativeJavaClass 执行 instanceof）；
    //   2. 或通过 `__javaObject__.isAssignableFrom(obj.getClass())` 反射校验。
    function isJavaInstance(javaClassWrapper, obj) {
        if (javaClassWrapper == null || obj == null) return false
        if (tryCall(function () { return obj instanceof javaClassWrapper }, false)) {
            return true
        }
        return Boolean(tryCall(function () {
            var rawClassObj = javaClassWrapper.__javaObject__
            if (rawClassObj != null && typeof rawClassObj.isInstance === 'function') {
                return Boolean(rawClassObj.isInstance(obj))
            }
            if (rawClassObj != null && typeof rawClassObj.isAssignableFrom === 'function' && typeof obj.getClass === 'function') {
                return Boolean(rawClassObj.isAssignableFrom(obj.getClass()))
            }
            return false
        }, false))
    }

    var subcommands       = {}
    var subcmdOrder       = []
    // 按存档隔离的内存缓存：
    // { '<worldKey>': { loaded: true, filePath: '...', grants: { '<playerKey>': { displayName: '...', scopes: { '<scope>': { by: '...', at: '...' } } } } } }
    var worldAuthStore    = {}
    var declarationStack  = []
    // 已注册的内部调用方白名单：{ '<callerId>': { '<subcmd>': true } }（严禁无参数默认全权 '*'）
    var registeredCallers = {}

    // 预置权限策略模板（冻结防外部篡改，且 normalizePermissionPolicy 永远返回浅拷贝）
    var POLICY_PRESETS = {
        public: Object.freeze({
            mode:                 'public',
            label:                '公开',
            requireCheats:        false,
            requireOp:            false,
            allowAuthorized:      true,
            opLevel:              0,
            allowCommandBlock:    true,
            allowConsole:         true,
            allowDeclaredCallers: true,
            allowedCallers:       null
        }),
        cheats: Object.freeze({
            mode:                 'cheats',
            label:                '需开启作弊',
            requireCheats:        true,
            requireOp:            false,
            allowAuthorized:      true,
            opLevel:              0,
            allowCommandBlock:    true,
            allowConsole:         true,
            allowDeclaredCallers: true,
            allowedCallers:       null
        }),
        authorized: Object.freeze({
            mode:                 'authorized',
            label:                '可作弊 + 管理员/已授权对象',
            requireCheats:        true,
            requireOp:            true,
            allowAuthorized:      true,
            opLevel:              2,
            allowCommandBlock:    true,
            allowConsole:         true,
            allowDeclaredCallers: true,
            allowedCallers:       null
        }),
        admin: Object.freeze({
            mode:                 'admin',
            label:                '可作弊 + 仅管理员(OP)',
            requireCheats:        true,
            requireOp:            true,
            allowAuthorized:      false,
            opLevel:              2,
            allowCommandBlock:    true,
            allowConsole:         true,
            allowDeclaredCallers: false,
            allowedCallers:       null
        })
    }

    function deepFreeze(obj) {
        if (obj == null || typeof obj !== 'object') return obj
        Object.freeze(obj)
        var keys = Object.keys(obj)
        for (var i = 0; i < keys.length; i++) {
            var val = obj[keys[i]]
            if (val != null && typeof val === 'object' && !Object.isFrozen(val)) {
                deepFreeze(val)
            }
        }
        return obj
    }
    deepFreeze(POLICY_PRESETS)

    function clonePolicy(p) {
        var src  = p || POLICY_PRESETS.public
        var copy = {}
        for (var k in src) {
            if (Object.prototype.hasOwnProperty.call(src, k)) {
                copy[k] = src[k]
            }
        }
        if (src.allowedCallers != null && typeof src.allowedCallers === 'object') {
            var callersCopy = {}
            for (var ck in src.allowedCallers) {
                if (src.allowedCallers[ck]) callersCopy[ck] = true
            }
            copy.allowedCallers = callersCopy
        } else {
            copy.allowedCallers = null
        }
        if (typeof copy.customCheck !== 'function') {
            copy.customCheck = null
        }
        return copy
    }

    function normalizeKey(str) {
        if (str == null) return ''
        return String(str).trim().toLowerCase()
    }

    function normalizeScope(scope) {
        var s = normalizeKey(scope)
        return (!s || s === 'all' || s === '*') ? '*' : s
    }

    function normalizeAllowedCallersList(rawList) {
        if (rawList == null) return null
        var arr = Array.isArray(rawList) ? rawList : [rawList]
        var map = {}
        var count = 0
        for (var i = 0; i < arr.length; i++) {
            var k = normalizeKey(arr[i])
            if (k) {
                map[k] = true
                count++
            }
        }
        return count > 0 ? map : null
    }

    function normalizePermissionPolicy(rawPolicy, fallbackPolicy) {
        var base = fallbackPolicy || POLICY_PRESETS.public
        if (rawPolicy === undefined || rawPolicy === null || rawPolicy === '') {
            return clonePolicy(base)
        }
        if (typeof rawPolicy === 'boolean') {
            return clonePolicy(rawPolicy ? POLICY_PRESETS.authorized : POLICY_PRESETS.public)
        }
        if (typeof rawPolicy === 'number' && isFinite(rawPolicy)) {
            if (rawPolicy <= 0) return clonePolicy(POLICY_PRESETS.public)
            var lv = Math.round(rawPolicy)
            return {
                mode:                 'op_level_' + lv,
                label:                '权限等级>=' + lv,
                requireCheats:        true,
                requireOp:            true,
                allowAuthorized:      true,
                opLevel:              lv,
                allowCommandBlock:    true,
                allowConsole:         true,
                allowDeclaredCallers: true,
                allowedCallers:       null
            }
        }
        if (typeof rawPolicy === 'function') {
            return {
                mode:                 'custom',
                label:                '自定义校验',
                requireCheats:        false,
                requireOp:            false,
                allowAuthorized:      true,
                opLevel:              0,
                allowCommandBlock:    true,
                allowConsole:         true,
                allowDeclaredCallers: false,
                allowedCallers:       null,
                customCheck:          rawPolicy
            }
        }
        if (typeof rawPolicy === 'string') {
            var s = rawPolicy.trim().toLowerCase()
            if (s === 'public' || s === 'all' || s === 'none' || s === 'everyone' || s === '公开') return clonePolicy(POLICY_PRESETS.public)
            if (s === 'cheats' || s === 'cheat' || s === '仅作弊') return clonePolicy(POLICY_PRESETS.cheats)
            if (s === 'authorized' || s === 'auth' || s === 'cheat_or_auth' || s === '授权') return clonePolicy(POLICY_PRESETS.authorized)
            if (s === 'admin' || s === 'op' || s === 'operator' || s === '管理员') return clonePolicy(POLICY_PRESETS.admin)
            return clonePolicy(base)
        }
        if (typeof rawPolicy === 'object') {
            var presetKey = rawPolicy.mode || rawPolicy.type || rawPolicy.preset
            var seed = (presetKey && typeof presetKey === 'string')
                ? normalizePermissionPolicy(presetKey, base)
                : clonePolicy(base)
            var callerWhitelist = rawPolicy.allowedCallers !== undefined
                ? normalizeAllowedCallersList(rawPolicy.allowedCallers)
                : seed.allowedCallers
            return {
                mode:                 String(presetKey || 'custom'),
                label:                String(rawPolicy.label || seed.label),
                requireCheats:        rawPolicy.requireCheats !== undefined ? Boolean(rawPolicy.requireCheats) : seed.requireCheats,
                requireOp:            rawPolicy.requireOp !== undefined ? Boolean(rawPolicy.requireOp) : seed.requireOp,
                allowAuthorized:      rawPolicy.allowAuthorized !== undefined ? Boolean(rawPolicy.allowAuthorized) : seed.allowAuthorized,
                opLevel:              (rawPolicy.opLevel != null && isFinite(Number(rawPolicy.opLevel))) ? Math.round(Number(rawPolicy.opLevel)) : seed.opLevel,
                allowCommandBlock:    rawPolicy.allowCommandBlock !== undefined ? Boolean(rawPolicy.allowCommandBlock) : seed.allowCommandBlock,
                allowConsole:         rawPolicy.allowConsole !== undefined ? Boolean(rawPolicy.allowConsole) : seed.allowConsole,
                allowDeclaredCallers: rawPolicy.allowDeclaredCallers !== undefined ? Boolean(rawPolicy.allowDeclaredCallers) : seed.allowDeclaredCallers,
                allowedCallers:       callerWhitelist,
                customCheck:          typeof rawPolicy.customCheck === 'function' ? rawPolicy.customCheck : null
            }
        }
        return clonePolicy(base)
    }

    function extractServerFromObj(obj) {
        if (obj == null) return null
        return tryCall(function () {
            if (typeof obj.getServer === 'function') {
                var s0 = obj.getServer()
                if (s0 != null) return s0
            }
            if (obj.server != null) return obj.server
            return null
        }, null)
    }

    function resolveServer(source, player) {
        var s = extractServerFromObj(source) || extractServerFromObj(player)
        if (s != null) {
            SERVER_REF = s
            return s
        }
        if (SERVER_REF == null) {
            var fromUtils = tryCall(function () {
                return (typeof Utils !== 'undefined' && Utils != null && typeof Utils.getServer === 'function')
                    ? Utils.getServer()
                    : null
            }, null)
            if (fromUtils != null) SERVER_REF = fromUtils
        }
        return SERVER_REF
    }

    function resolveWorldStorageInfo(server) {
        var srv = server || SERVER_REF
        if (srv != null && LevelResourceClass != null) {
            try {
                var rootRes = LevelResourceClass.ROOT
                if (rootRes != null && typeof srv.getWorldPath === 'function') {
                    var worldPath = srv.getWorldPath(rootRes)
                    if (worldPath != null) {
                        var normRoot = (typeof worldPath.normalize === 'function') ? worldPath.normalize() : worldPath
                        var jsonPath = String(normRoot).replace(/[\\/]+$/, '') + '/' + WORLD_FILE_NAME
                        return {
                            worldKey: 'path:' + jsonPath.toLowerCase(),
                            filePath: jsonPath
                        }
                    }
                }
            } catch (ePath) {
                logCatch('resolveWorldPath', ePath)
            }
        }

        var levelName = 'default_world'
        if (srv != null) {
            var resolvedName = tryCall(function () {
                var wData = (typeof srv.getWorldData === 'function') ? srv.getWorldData() : srv.worldData
                if (wData != null) {
                    var rawName = (typeof wData.getLevelName === 'function') ? wData.getLevelName() : wData.levelName
                    if (rawName != null && String(rawName).trim().length > 0) {
                        return String(rawName).trim()
                    }
                }
                return null
            }, null)
            if (resolvedName) levelName = resolvedName
        }
        var safeFileSlug = levelName.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim() || 'default_world'
        var fallbackPath = FALLBACK_DIR + '/' + safeFileSlug + '.json'
        return {
            worldKey: 'name:' + safeFileSlug.toLowerCase(),
            filePath: fallbackPath
        }
    }

    function ensureParentDir(filePathStr) {
        if (FilesClass == null) return
        try {
            var PathsClass = loadJavaClass('java.nio.file.Paths')
            if (PathsClass == null) return
            var p = PathsClass.get(String(filePathStr))
            var parent = p != null ? p.getParent() : null
            if (parent != null && !FilesClass.exists(parent)) {
                FilesClass.createDirectories(parent)
            }
        } catch (e) {
            logCatch('ensureParentDir', e)
        }
    }

    function readMapField(obj, key) {
        if (obj == null) return null
        return tryCall(function () {
            if (obj[key] !== undefined) return obj[key]
            if (typeof obj.get === 'function') return obj.get(key)
            return null
        }, null)
    }

    // 解析单条用户授权数据（兼容旧版数组格式 ['*'] 与新版带审计信息格式 { displayName, scopes: { '*': { by, at } } }）
    function parseUserGrantRecord(uKey, rawUserVal) {
        var record = {
            displayName: uKey,
            scopes:      {}
        }
        if (rawUserVal == null) return record

        if (Array.isArray(rawUserVal) || (typeof rawUserVal === 'object' && typeof rawUserVal.iterator === 'function')) {
            if (typeof rawUserVal.iterator === 'function') {
                var it = rawUserVal.iterator()
                while (it.hasNext()) {
                    var sc = normalizeScope(it.next())
                    record.scopes[sc] = { by: 'legacy', at: 'unknown' }
                }
            } else {
                for (var i = 0; i < rawUserVal.length; i++) {
                    var sc2 = normalizeScope(rawUserVal[i])
                    record.scopes[sc2] = { by: 'legacy', at: 'unknown' }
                }
            }
            return record
        }

        if (typeof rawUserVal === 'object') {
            var disp = readMapField(rawUserVal, 'displayName')
            if (disp != null && String(disp).trim().length > 0) {
                record.displayName = String(disp).trim()
            }
            var rawScopesObj = readMapField(rawUserVal, 'scopes') || rawUserVal
            if (typeof rawScopesObj.keySet === 'function') {
                var kit = rawScopesObj.keySet().iterator()
                while (kit.hasNext()) {
                    var k = String(kit.next())
                    if (k === 'displayName' || k === 'scopes') continue
                    var v = rawScopesObj.get(k)
                    var meta = parseScopeAuditMeta(v)
                    if (meta) record.scopes[normalizeScope(k)] = meta
                }
            } else {
                for (var sk in rawScopesObj) {
                    if (sk === 'displayName' || sk === 'scopes') continue
                    var meta2 = parseScopeAuditMeta(rawScopesObj[sk])
                    if (meta2) record.scopes[normalizeScope(sk)] = meta2
                }
            }
        }
        return record
    }

    function parseScopeAuditMeta(val) {
        if (!val) return null
        if (val === true) return { by: 'unknown', at: 'unknown' }
        if (typeof val === 'object') {
            var byVal = readMapField(val, 'by') || readMapField(val, 'grantedBy') || 'unknown'
            var atVal = readMapField(val, 'at') || readMapField(val, 'grantedAt') || 'unknown'
            return {
                by: String(byVal),
                at: String(atVal)
            }
        }
        return null
    }

    function getOrLoadWorldGrants(server) {
        var info  = resolveWorldStorageInfo(server)
        var entry = worldAuthStore[info.worldKey]
        if (entry != null && entry.loaded) {
            return entry
        }
        var grants = {}
        try {
            if (typeof JsonIO !== 'undefined' && JsonIO != null) {
                var rawMap = JsonIO.read(info.filePath)
                if (rawMap != null) {
                    var usersObj = readMapField(rawMap, 'users')
                    if (usersObj != null) {
                        if (typeof usersObj.keySet === 'function') {
                            var ks = usersObj.keySet().iterator()
                            while (ks.hasNext()) {
                                var rawK = String(ks.next())
                                var uKey = normalizeKey(rawK)
                                grants[uKey] = parseUserGrantRecord(uKey, usersObj.get(rawK))
                            }
                        } else if (typeof usersObj === 'object') {
                            for (var uk in usersObj) {
                                var normUk = normalizeKey(uk)
                                grants[normUk] = parseUserGrantRecord(normUk, usersObj[uk])
                            }
                        }
                    }
                }
            }
        } catch (eRead) {
            logCatch('getOrLoadWorldGrants', eRead)
        }

        entry = {
            worldKey: info.worldKey,
            filePath: info.filePath,
            loaded:   true,
            grants:   grants
        }
        worldAuthStore[info.worldKey] = entry
        return entry
    }

    function saveWorldGrantsToDisk(server) {
        var entry = getOrLoadWorldGrants(server)
        try {
            if (typeof JsonIO !== 'undefined' && JsonIO != null) {
                ensureParentDir(entry.filePath)
                var outUsers = {}
                for (var uKey in entry.grants) {
                    var rec = entry.grants[uKey]
                    if (!rec || !rec.scopes) continue
                    var outScopes = {}
                    var count = 0
                    for (var sc in rec.scopes) {
                        var meta = rec.scopes[sc]
                        if (meta) {
                            outScopes[sc] = {
                                by: String(meta.by || 'unknown'),
                                at: String(meta.at || '')
                            }
                            count++
                        }
                    }
                    if (count > 0) {
                        outUsers[uKey] = {
                            displayName: String(rec.displayName || uKey),
                            scopes:      outScopes
                        }
                    }
                }
                JsonIO.write(entry.filePath, {
                    version:   4,
                    updatedAt: formatTimestampNow(),
                    users:     outUsers
                })
                return true
            }
        } catch (eWrite) {
            logError('saveWorldGrantsToDisk', '写入存档授权文件失败 (' + entry.filePath + '): ' + eWrite)
        }
        return false
    }

    function formatTimestampNow() {
        var d = new Date()
        var pad = function (n) { return n < 10 ? ('0' + n) : String(n) }
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
               pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
    }

    function extractActorLabel(sourceOrName) {
        if (sourceOrName == null) return 'SYSTEM'
        if (typeof sourceOrName === 'string') return sourceOrName.trim() || 'SYSTEM'
        var p = tryCall(function () {
            if (typeof sourceOrName.isPlayer === 'function' && sourceOrName.isPlayer()) {
                return (typeof sourceOrName.getPlayer === 'function') ? sourceOrName.getPlayer() : sourceOrName.player
            }
            return null
        }, null)
        if (p != null) {
            var pName = extractPlayerName(p)
            if (pName) return pName
        }
        var tn = tryCall(function () {
            return (typeof sourceOrName.getTextName === 'function') ? sourceOrName.getTextName() : null
        }, null)
        if (tn != null && String(tn).trim().length > 0) return String(tn).trim()
        return 'CONSOLE'
    }

    function extractPlayerName(player) {
        if (player == null) return ''
        var fromProfile = tryCall(function () {
            if (typeof player.getProfile === 'function') {
                var prof = player.getProfile()
                if (prof != null && typeof prof.getName === 'function' && prof.getName() != null) {
                    return String(prof.getName())
                }
            }
            return null
        }, null)
        if (fromProfile) return fromProfile
        var fromUser = tryCall(function () {
            return player.username != null ? String(player.username) : null
        }, null)
        if (fromUser) return fromUser
        return tryCall(function () {
            if (typeof player.getName === 'function') {
                var comp = player.getName()
                if (comp != null && typeof comp.getString === 'function') return String(comp.getString())
                if (comp != null) return String(comp)
            }
            return ''
        }, '')
    }

    function extractPlayerUuid(player) {
        if (player == null) return ''
        var sUuid = tryCall(function () {
            return typeof player.getStringUUID === 'function' ? String(player.getStringUUID()) : null
        }, null)
        if (sUuid) return sUuid
        var rawUuid = tryCall(function () {
            return player.uuid != null ? String(player.uuid) : null
        }, null)
        if (rawUuid) return rawUuid
        return tryCall(function () {
            if (typeof player.getProfile === 'function') {
                var prof = player.getProfile()
                if (prof != null && typeof prof.getId === 'function' && prof.getId() != null) {
                    return String(prof.getId())
                }
            }
            return ''
        }, '')
    }

    function isWorldCheatsEnabled(server, player) {
        var srv = server || SERVER_REF
        if (srv == null) {
            return Boolean(tryCall(function () {
                return player != null && typeof player.hasPermissions === 'function' && player.hasPermissions(2)
            }, false))
        }
        if (tryCall(function () {
            return (typeof srv.isDedicatedServer === 'function' && srv.isDedicatedServer())
                || (typeof srv.isDedicated === 'function' && srv.isDedicated())
        }, false)) return true
        if (tryCall(function () {
            var pList = (typeof srv.getPlayerList === 'function') ? srv.getPlayerList() : srv.playerList
            return pList != null && typeof pList.isAllowCheatsForAllPlayers === 'function' && pList.isAllowCheatsForAllPlayers()
        }, false)) return true
        var wAllow = tryCall(function () {
            var wData = (typeof srv.getWorldData === 'function') ? srv.getWorldData() : srv.worldData
            if (wData != null) {
                if (typeof wData.getAllowCommands === 'function') return Boolean(wData.getAllowCommands())
                if (wData.allowCommands !== undefined) return Boolean(wData.allowCommands)
            }
            return null
        }, null)
        if (wAllow !== null) return wAllow
        return Boolean(tryCall(function () {
            return player != null && typeof player.hasPermissions === 'function' && player.hasPermissions(2)
        }, false))
    }

    function isPlayerAdmin(server, player, source, minOpLevel) {
        if (player == null) return false
        var srv   = server || resolveServer(source, player)
        var reqLv = (minOpLevel != null && isFinite(minOpLevel) && minOpLevel > 0) ? Math.round(minOpLevel) : 2
        if (tryCall(function () { return typeof player.isOp === 'function' && player.isOp() }, false)) return true
        if (tryCall(function () { return typeof player.hasPermissions === 'function' && player.hasPermissions(reqLv) }, false)) return true
        if (tryCall(function () { return source != null && typeof source.hasPermission === 'function' && source.hasPermission(reqLv) }, false)) return true
        if (srv != null) {
            return Boolean(tryCall(function () {
                var prof  = (typeof player.getProfile === 'function') ? player.getProfile() : player.profile
                var pList = (typeof srv.getPlayerList === 'function') ? srv.getPlayerList() : srv.playerList
                if (prof != null && pList != null && typeof pList.isOp === 'function' && pList.isOp(prof)) {
                    return true
                }
                if (prof != null && typeof srv.isSingleplayerOwner === 'function' && srv.isSingleplayerOwner(prof)) {
                    return isWorldCheatsEnabled(srv, player)
                }
                return false
            }, false))
        }
        return false
    }

    function checkScopeInRecord(rec, targetScope) {
        if (rec == null || rec.scopes == null) return false
        if (rec.scopes['*']) return true
        return Boolean(targetScope && rec.scopes[targetScope])
    }

    function migrateNameGrantToUuid(grantsMap, nameKey, uuidKey, currentDisplayName) {
        if (!nameKey || !uuidKey || !grantsMap || !grantsMap[nameKey]) return false
        var oldRec = grantsMap[nameKey]
        if (oldRec.scopes) {
            if (!grantsMap[uuidKey]) {
                grantsMap[uuidKey] = { displayName: currentDisplayName || oldRec.displayName || uuidKey, scopes: {} }
            } else if (currentDisplayName) {
                grantsMap[uuidKey].displayName = currentDisplayName
            }
            for (var sc in oldRec.scopes) {
                if (oldRec.scopes[sc] && !grantsMap[uuidKey].scopes[sc]) {
                    grantsMap[uuidKey].scopes[sc] = oldRec.scopes[sc]
                }
            }
        }
        delete grantsMap[nameKey]
        return true
    }

    function isPlayerAuthorized(server, player, subCommandName) {
        if (player == null) return false
        var srv     = server || resolveServer(null, player)
        var entry   = getOrLoadWorldGrants(srv)
        var scope   = normalizeScope(subCommandName)
        var rawName = extractPlayerName(player)
        var nameKey = normalizeKey(rawName)
        var uuidKey = normalizeKey(extractPlayerUuid(player))

        if (uuidKey && nameKey && entry.grants[nameKey]) {
            if (migrateNameGrantToUuid(entry.grants, nameKey, uuidKey, rawName)) {
                saveWorldGrantsToDisk(srv)
            }
        }
        if (uuidKey && checkScopeInRecord(entry.grants[uuidKey], scope)) return true
        if (!uuidKey && nameKey && checkScopeInRecord(entry.grants[nameKey], scope)) return true
        return false
    }

    function refreshPlayerCommandTree(server, player) {
        if (player == null) return
        var srv = server || resolveServer(null, player)
        if (srv == null) return
        if (tryCall(function () {
            var pList = (typeof srv.getPlayerList === 'function') ? srv.getPlayerList() : srv.playerList
            if (pList != null && typeof pList.sendPlayerPermissionLevel === 'function') {
                pList.sendPlayerPermissionLevel(player)
                return true
            }
            return false
        }, false)) return
        tryCall(function () {
            var cmds = (typeof srv.getCommands === 'function') ? srv.getCommands() : srv.commands
            if (cmds != null && typeof cmds.sendCommands === 'function') {
                cmds.sendCommands(player)
            }
        }, null)
    }

    function applyGrantToRecord(grantsMap, key, displayName, scope, auditMeta) {
        if (!key) return
        if (!grantsMap[key]) {
            grantsMap[key] = { displayName: displayName || key, scopes: {} }
        } else if (displayName && grantsMap[key].displayName === key) {
            grantsMap[key].displayName = displayName
        }
        grantsMap[key].scopes[scope] = {
            by: auditMeta.by,
            at: auditMeta.at
        }
    }

    function removeGrantFromRecord(grantsMap, key, scope) {
        if (!key || !grantsMap[key]) return
        if (scope === '*') {
            delete grantsMap[key]
            return
        }
        if (grantsMap[key].scopes) {
            delete grantsMap[key].scopes[scope]
            var remain = 0
            for (var s in grantsMap[key].scopes) {
                if (grantsMap[key].scopes[s]) remain++
            }
            if (remain === 0) delete grantsMap[key]
        }
    }

    function mutatePlayerGrant(server, playerOrName, isGrant, subCommandScope, grantedBySourceOrName) {
        if (playerOrName == null) return false
        var srv   = server || (typeof playerOrName === 'object' ? resolveServer(null, playerOrName) : SERVER_REF)
        var entry = getOrLoadWorldGrants(srv)
        var scope = normalizeScope(subCommandScope)
        var auditMeta = isGrant ? {
            by: extractActorLabel(grantedBySourceOrName),
            at: formatTimestampNow()
        } : null

        if (typeof playerOrName === 'string') {
            var k = normalizeKey(playerOrName)
            if (!k) return false
            if (isGrant) {
                applyGrantToRecord(entry.grants, k, String(playerOrName).trim(), scope, auditMeta)
            } else {
                removeGrantFromRecord(entry.grants, k, scope)
                for (var gk in entry.grants) {
                    var greq = entry.grants[gk]
                    if (greq != null && greq.displayName && normalizeKey(greq.displayName) === k) {
                        removeGrantFromRecord(entry.grants, gk, scope)
                    }
                }
            }
            saveWorldGrantsToDisk(srv)
            return true
        }

        var rawName = extractPlayerName(playerOrName)
        var pName   = normalizeKey(rawName)
        var pUuid   = normalizeKey(extractPlayerUuid(playerOrName))
        if (isGrant) {
            if (pUuid) {
                if (pName && entry.grants[pName]) {
                    migrateNameGrantToUuid(entry.grants, pName, pUuid, rawName)
                }
                applyGrantToRecord(entry.grants, pUuid, rawName || pUuid, scope, auditMeta)
            } else if (pName) {
                applyGrantToRecord(entry.grants, pName, rawName, scope, auditMeta)
            }
        } else {
            removeGrantFromRecord(entry.grants, pName, scope)
            removeGrantFromRecord(entry.grants, pUuid, scope)
        }
        saveWorldGrantsToDisk(srv)
        refreshPlayerCommandTree(srv, playerOrName)
        return true
    }

    // 授权玩家并记录审计元数据（谁授权的、何时授权的）
    function grantPlayer(server, playerOrName, subCommandScope, grantedBySourceOrName) {
        return mutatePlayerGrant(server, playerOrName, true, subCommandScope, grantedBySourceOrName)
    }

    function revokePlayer(server, playerOrName, subCommandScope) {
        return mutatePlayerGrant(server, playerOrName, false, subCommandScope, null)
    }

    function listGrantedEntries(server) {
        var entry = getOrLoadWorldGrants(server)
        var out   = []
        for (var k in entry.grants) {
            var rec = entry.grants[k]
            if (!rec || !rec.scopes) continue
            var items = []
            for (var sc in rec.scopes) {
                var meta = rec.scopes[sc]
                if (meta) {
                    items.push(sc + ' (by ' + (meta.by || 'unknown') + ' @ ' + (meta.at || 'unknown') + ')')
                }
            }
            if (items.length > 0) {
                var label = (rec.displayName && normalizeKey(rec.displayName) !== k)
                    ? (rec.displayName + '/' + k)
                    : (rec.displayName || k)
                out.push(label + ' -> [' + items.join(', ') + ']')
            }
        }
        return out
    }

    // 显式注册受信任脚本调用方及其允许调用的子命令列表：
    //   严禁省略 allowedScopes 默认给 '*'！调用方必须明确传入非空的子命令名称数组（如 ['danmaku']），且禁止声明 'auth'。
    function declareCaller(callerId, allowedScopes) {
        var id = normalizeKey(callerId)
        if (!id) return false
        var list = Array.isArray(allowedScopes)
            ? allowedScopes
            : (typeof allowedScopes === 'string' && allowedScopes.trim().length > 0 ? [allowedScopes] : [])
        var scopeSet = {}
        var count = 0
        for (var i = 0; i < list.length; i++) {
            var sc = normalizeKey(list[i])
            if (sc && sc !== '*' && sc !== 'all' && sc !== 'auth') {
                scopeSet[sc] = true
                count++
            }
        }
        if (count === 0) {
            logWarn('declareCaller', 'declareCaller("' + id + '") 必须显式指定具体子命令白名单（如 ["danmaku"]），不支持空列表或通配符 "*"。')
            return false
        }
        registeredCallers[id] = scopeSet
        return true
    }

    function withDeclaration(callerId, fn) {
        var id = normalizeKey(callerId)
        if (!id || typeof fn !== 'function') return null
        if (!registeredCallers[id]) {
            logWarn('withDeclaration', '调用方 "' + id + '" 尚未通过 declareCaller(callerId, allowedScopes) 注册白名单，withDeclaration 已拒绝。')
            return null
        }
        declarationStack.push(id)
        try {
            return fn()
        } finally {
            declarationStack.pop()
        }
    }

    // 显式绑定调用方身份，供跨 Tick 调度或异步回调安全使用（不依赖隐式全局同步栈）
    function bindDeclaration(callerId, fn) {
        var id = normalizeKey(callerId)
        if (!id || typeof fn !== 'function') return fn
        return function () {
            var args = arguments
            return withDeclaration(id, function () {
                return fn.apply(null, args)
            })
        }
    }

    function runDeclaredCommand(runnerObj, callerId, commandStr, silent) {
        if (runnerObj == null || !commandStr) return 0
        var looksLikePlayer = (ServerPlayerClass != null && isJavaInstance(ServerPlayerClass, runnerObj))
            || Boolean(tryCall(function () { return typeof runnerObj.getUuid === 'function' && typeof runnerObj.hasPermissions === 'function' }, false))
        if (looksLikePlayer) {
            logWarn('runDeclaredCommand', '出于安全边界禁止将玩家对象作为 runDeclaredCommand 的提权执行代理，已拦截。')
            return 0
        }
        var cmd = String(commandStr).replace(/^\//, '')
        var res = withDeclaration(callerId, function () {
            if (silent !== false && typeof runnerObj.runCommandSilent === 'function') {
                return runnerObj.runCommandSilent(cmd)
            }
            if (typeof runnerObj.runCommand === 'function') {
                return runnerObj.runCommand(cmd)
            }
            return 0
        })
        return res != null ? res : 0
    }

    // 严格通过 Java Class.isInstance 识别 CommandSourceStack 的底层数据类型（彻底移除类名字符串 indexOf 模糊匹配）
    // 注意信任优先级：必须先校验玩家 / 命令方块，绝不允许玩家来源借助 declarationStack 绕过玩家权限校验。
    function classifyCommandSource(source) {
        if (source == null) {
            return { kind: 'untrusted_other', player: null, rawSource: null, className: 'null' }
        }

        var rawSource = tryCall(function () { return source.source }, null)
        var rawCls    = tryCall(function () {
            return (rawSource != null && typeof rawSource.getClass === 'function') ? String(rawSource.getClass().getName()) : ''
        }, '')

        // 1. 优先严格验证是否为真实玩家直接执行（最不可信物理源优先拦截，防提权伪装）：
        //    注意：CommandSourceStack.getPlayer() 返回的是 ServerPlayer，但 Rhino 可能会对其中一个包装一层 NativeJavaObject / KubeJS 代理，
        //    导致 rawSource === player 引用不相等；因此同时支持 Java Object.equals() 与 UUID 相等比对，并配合 ServerPlayerClass.isInstance 校验。
        var player = tryCall(function () {
            var isPl = (typeof source.isPlayer === 'function') ? Boolean(source.isPlayer()) : true
            if (!isPl) return null
            var pCand = (typeof source.getPlayer === 'function') ? source.getPlayer() : source.player
            return (pCand != null && typeof pCand !== 'boolean') ? pCand : null
        }, null)

        if (player != null) {
            var isRealPlayerSource = false
            if (rawSource != null) {
                var sameEntity = (rawSource === player)
                if (!sameEntity && typeof rawSource.equals === 'function') {
                    sameEntity = Boolean(tryCall(function () { return rawSource.equals(player) }, false))
                }
                if (!sameEntity) {
                    var u1 = extractPlayerUuid(rawSource)
                    var u2 = extractPlayerUuid(player)
                    if (u1 && u2 && u1 === u2) sameEntity = true
                }
                if (sameEntity && (ServerPlayerClass == null || isJavaInstance(ServerPlayerClass, rawSource))) {
                    isRealPlayerSource = true
                }
            } else {
                // 若环境未映射 source.source 字段（rawSource 为 null/undefined），回退校验 player 本身是否为 ServerPlayer 实例
                if (ServerPlayerClass == null || isJavaInstance(ServerPlayerClass, player)) {
                    isRealPlayerSource = true
                }
            }
            if (isRealPlayerSource) {
                return { kind: 'player', player: player, rawSource: rawSource || player, className: rawCls || 'ServerPlayer' }
            }
        }

        // 2. 严格验证是否为命令方块 (BaseCommandBlock)
        if (rawSource != null && BaseCommandBlockClass != null) {
            if (isJavaInstance(BaseCommandBlockClass, rawSource)) {
                return { kind: 'command_block', player: null, rawSource: rawSource, className: rawCls || 'BaseCommandBlock' }
            }
        }

        // 3. 在排除玩家与命令方块后，检查当前调用栈是否处于已注册白名单的 withDeclaration 块内；
        //    同时探测物理底层是否为控制台（MinecraftServer / RconConsoleSource），
        //    确保即使在声明块内调用 server.runCommand，也不会绕过 policy.allowConsole === false。
        var consoleCarrierCls = classifyConsoleRawSource(rawSource, rawCls)
        if (declarationStack.length > 0) {
            var topId = declarationStack[declarationStack.length - 1]
            if (topId && registeredCallers[topId]) {
                return {
                    kind: 'declared_function',
                    callerId: topId,
                    player: null,
                    rawSource: rawSource,
                    isConsoleCarrier: consoleCarrierCls != null,
                    className: 'Declared:' + topId
                }
            }
        }

        // 4. 严格验证是否为服务器控制台 (MinecraftServer 或 RconConsoleSource)
        if (consoleCarrierCls != null) {
            return { kind: 'console', player: null, rawSource: rawSource, className: consoleCarrierCls }
        }

        // 5. 其他任何来源（如 CommandSource.NULL 数据包函数、execute as @a 伪装源、第三方伪造 CommandSource）一律归为 untrusted_other
        return { kind: 'untrusted_other', player: null, rawSource: rawSource, className: rawCls || 'UnknownSource' }
    }

    function classifyConsoleRawSource(rawSource, rawCls) {
        if (rawSource == null) return null
        if (MinecraftServerClass != null && isJavaInstance(MinecraftServerClass, rawSource)) {
            return rawCls || 'MinecraftServer'
        }
        if (RconConsoleSourceClass != null && isJavaInstance(RconConsoleSourceClass, rawSource)) {
            return rawCls || 'RconConsoleSource'
        }
        return null
    }

    function checkConsoleCarrierPermission(source, subKey, policy, viaDeclaration) {
        if (policy.allowConsole === false) {
            return {
                allowed: false,
                reason: viaDeclaration
                    ? ('子命令 /epiphy ' + subKey + ' 不允许由控制台调用（禁止通过声明代调块内的 server.runCommand 绕过 allowConsole）。')
                    : ('子命令 /epiphy ' + subKey + ' 不允许由控制台直接调用。')
            }
        }
        var reqConsoleLv = (policy.requireOp && policy.opLevel > 0) ? policy.opLevel : 0
        if (reqConsoleLv > 0 && typeof source.hasPermission === 'function' && !source.hasPermission(reqConsoleLv)) {
            return {
                allowed: false,
                reason: viaDeclaration
                    ? ('声明调用携带的控制台源未达到子命令要求的权限等级 (' + reqConsoleLv + ')。')
                    : ('控制台源未达到子命令要求的权限等级 (' + reqConsoleLv + ')。')
            }
        }
        return null
    }

    // 评估当前 CommandSourceStack 是否有权执行指定子命令
    function evaluateSourceAccess(source, subCommandName, policyOverride) {
        if (source == null) {
            return { allowed: false, reason: '无效的指令执行源。' }
        }
        var subKey  = normalizeKey(subCommandName)
        var subSpec = subKey ? subcommands[subKey] : null
        var policy  = normalizePermissionPolicy(
            policyOverride !== undefined ? policyOverride : (subSpec != null ? subSpec.policy : null),
            POLICY_PRESETS.admin
        )

        var srcInfo = classifyCommandSource(source)

        // 分支 1：命令方块数据类型 (BaseCommandBlock)
        if (srcInfo.kind === 'command_block') {
            if (policy.allowCommandBlock === false) {
                return { allowed: false, reason: '子命令 /epiphy ' + subKey + ' 不允许由命令方块调用。' }
            }
            return { allowed: true, sourceKind: 'command_block', player: null }
        }

        // 分支 2：已声明的内部函数调用 (declared_function) -> 同时校验 caller scope、allowDeclaredCallers/allowedCallers 与底层控制台策略
        if (srcInfo.kind === 'declared_function') {
            var callerId    = srcInfo.callerId
            var callerGates = registeredCallers[callerId]
            if (!subKey || subKey === 'auth' || policy.allowDeclaredCallers === false) {
                return { allowed: false, reason: '子命令 /epiphy ' + subKey + ' 禁止通过脚本声明代调。' }
            }
            if (srcInfo.isConsoleCarrier) {
                var declaredConsoleDeny = checkConsoleCarrierPermission(source, subKey, policy, true)
                if (declaredConsoleDeny) return declaredConsoleDeny
            }
            if (!callerGates || !callerGates[subKey]) {
                return { allowed: false, reason: '调用方 "' + callerId + '" 未获准调用子命令 /epiphy ' + subKey + '。' }
            }
            if (policy.allowedCallers != null && !policy.allowedCallers[callerId]) {
                return { allowed: false, reason: '子命令 /epiphy ' + subKey + ' 的白名单未包含调用方 "' + callerId + '"。' }
            }
            return { allowed: true, sourceKind: 'declared_function', callerId: callerId, player: null }
        }

        // 分支 3：服务器控制台数据类型 (MinecraftServer / RconConsoleSource) -> 进入权限查询
        if (srcInfo.kind === 'console') {
            var consoleDeny = checkConsoleCarrierPermission(source, subKey, policy, false)
            if (consoleDeny) return consoleDeny
            return { allowed: true, sourceKind: 'console', player: null }
        }

        // 分支 4：真实玩家聊天框输入 (ServerPlayer) -> 进入权限查询
        if (srcInfo.kind === 'player' && srcInfo.player != null) {
            var player = srcInfo.player
            var server = resolveServer(source, player)

            if (typeof policy.customCheck === 'function') {
                try {
                    var customRes = policy.customCheck({
                        source:     source,
                        player:     player,
                        server:     server,
                        subcommand: subKey,
                        valve:      valveApi
                    })
                    if (customRes === true) return { allowed: true, sourceKind: 'player', player: player }
                    if (typeof customRes === 'string') return { allowed: false, player: player, reason: customRes }
                    if (customRes && typeof customRes === 'object') return customRes
                    return { allowed: false, player: player, reason: '未通过子命令 /epiphy ' + subKey + ' 的自定义权限校验。' }
                } catch (eCustom) {
                    return { allowed: false, player: player, reason: '权限校验异常: ' + eCustom }
                }
            }

            if (policy.requireCheats && !isWorldCheatsEnabled(server, player)) {
                return {
                    allowed: false,
                    player:  player,
                    reason:  '当前世界未开启作弊（Allow Cheats），无法在聊天框执行 /epiphy ' + subKey + '。'
                }
            }

            if (policy.requireOp) {
                var isAdmin = isPlayerAdmin(server, player, source, policy.opLevel)
                var isAuth  = policy.allowAuthorized && isPlayerAuthorized(server, player, subKey)
                if (!isAdmin && !isAuth) {
                    var reqDesc = policy.allowAuthorized ? '管理员 (OP) 或已被管理员授权的对象' : '管理员 (OP)'
                    return {
                        allowed: false,
                        player:  player,
                        reason:  '权限不足：/epiphy ' + subKey + ' 需要【' + reqDesc + '】方可执行。'
                    }
                }
            }

            return { allowed: true, sourceKind: 'player', player: player }
        }

        // 分支 5：其他未声明的调用源（如第三方数据包 .mcfunction、execute as 借壳调用等） -> 拦截
        return {
            allowed: false,
            reason:  '已拦截未声明的非交互式调用源 (' + srcInfo.className + ')。其他模块调用 /epiphy 系列功能时须先通过 declareCaller 与 withDeclaration 声明。'
        }
    }

    function sendSourceMessage(source, textStr) {
        if (source == null) return
        try {
            source.sendSuccess(Text.of(textStr), false)
        } catch (e) {
            logCatch('sendSourceMessage', e)
        }
    }

    function checkSourceOrReject(source, subCommandName, policyOverride) {
        var res = evaluateSourceAccess(source, subCommandName, policyOverride)
        if (!res.allowed) {
            sendSourceMessage(source, '§c[Epiphy 权限阀] ' + res.reason)
            return false
        }
        return true
    }

    // 供 Brigadier .requires(...) 与可见性判定使用：包裹 try/catch 并对每个子命令的解析期异常做单次去重日志保护，绝不弄崩客户端命令树同步
    function canSeeSubcommand(source, subCommandName, policyOverride) {
        if (source == null) return false
        try {
            var res = evaluateSourceAccess(source, subCommandName, policyOverride)
            return Boolean(res && res.allowed)
        } catch (e) {
            var errKey = normalizeKey(subCommandName) || 'unknown'
            logOnceWarn(
                'valve:canSee:' + errKey,
                '[EpiphyPermissionValve] canSeeSubcommand("' + errKey + '") 解析期异常 (仅记录一次): ' + e
            )
            return false
        }
    }

    function guardExecution(subCommandName, policyOrHandler, maybeHandler) {
        var branchPolicy = (typeof policyOrHandler === 'function') ? undefined : policyOrHandler
        var handlerFn    = (typeof policyOrHandler === 'function') ? policyOrHandler : maybeHandler
        return function (ctx) {
            var src = ctx != null ? ctx.source : null
            if (!checkSourceOrReject(src, subCommandName, branchPolicy)) {
                return 0
            }
            return handlerFn(ctx)
        }
    }

    function registerSubcommand(spec) {
        if (spec == null || !spec.name) return false
        var name = normalizeKey(spec.name)
        if (!name) return false
        var rawPerm = spec.permission !== undefined
            ? spec.permission
            : (spec.policy !== undefined ? spec.policy : spec.auth)
        if (rawPerm == null) {
            logWarn('registerSubcommand', '子命令 /' + ROOT_LITERAL + ' ' + name + ' 未声明 permission，已按最小权限原则默认设为 admin (仅 OP)。')
        }
        var policy = normalizePermissionPolicy(rawPerm, POLICY_PRESETS.admin)

        if (subcommands[name] == null) {
            subcmdOrder.push(name)
        }
        subcommands[name] = {
            name:      name,
            policy:    policy,
            summary:   spec.summary ? String(spec.summary) : ('/epiphy ' + name + ' 子命令'),
            helpLines: spec.helpLines || [],
            buildNode: typeof spec.buildNode === 'function' ? spec.buildNode : null
        }
        return true
    }

    function resolveSubcommandHelpLines(entry) {
        if (entry == null || entry.helpLines == null) return []
        if (typeof entry.helpLines === 'function') {
            try {
                var r = entry.helpLines()
                return Array.isArray(r) ? r : []
            } catch (e) {
                logCatch('resolveSubcommandHelpLines', e)
                return []
            }
        }
        return Array.isArray(entry.helpLines) ? entry.helpLines : []
    }

    function sendAggregatedHelp(source, targetSubName) {
        if (targetSubName) {
            var key = normalizeKey(targetSubName)
            if (key === 'auth' || key === 'core' || key === 'valve') {
                sendSourceMessage(source, '§3§l----------------------------------------------------')
                sendSourceMessage(source, '§b§l  [ Epiphy 权限阀核心 // /epiphy auth 帮助手册 ]')
                sendSourceMessage(source, '§3§l----------------------------------------------------')
                sendSourceMessage(source, '§e1. 查看授权与作弊状态： §f/epiphy auth list')
                sendSourceMessage(source, '§e2. 授予玩家全部权限：   §f/epiphy auth grant <玩家>')
                sendSourceMessage(source, '§e3. 授予玩家单模块权限： §f/epiphy auth grant <玩家> <模块名(如 danmaku)>')
                sendSourceMessage(source, '§e4. 撤销玩家全部权限：   §f/epiphy auth revoke <玩家>')
                sendSourceMessage(source, '§e5. 撤销玩家单模块权限： §f/epiphy auth revoke <玩家> <模块名(如 danmaku)>')
                sendSourceMessage(source, '§3§l----------------------------------------------------')
                return 1
            }
            var target = subcommands[key]
            if (target == null) {
                sendSourceMessage(source, '§c[Epiphy 指令中心] 未找到名为 [' + key + '] 的子模块。输入 §f/epiphy help §c查看已加载模块列表。')
                return 0
            }
            var access = evaluateSourceAccess(source, key, target.policy)
            var statusTag = access.allowed ? '§a[已就绪/可执行]' : ('§c[受限: ' + access.reason + ']')
            sendSourceMessage(source, '§e• 模块 [' + target.name + '] ' + statusTag + ' §7(权限策略: §b' + target.policy.label + '§7)')
            var detailLines = resolveSubcommandHelpLines(target)
            for (var d = 0; d < detailLines.length; d++) {
                sendSourceMessage(source, detailLines[d])
            }
            return 1
        }

        var authAccess = evaluateSourceAccess(source, 'auth', POLICY_PRESETS.admin)
        var authStatus = authAccess.allowed ? '§a[可执行]' : '§8[仅管理员]'

        var header = [
            '§3§l====================================================',
            '§b§l  [ Epiphy 指令中心 // 已挂载插件与模块总览 ]',
            '§3§l====================================================',
            '§e• 查看指定模块详细语法： §f/epiphy help <模块名> §7(如 §f/epiphy help danmaku§7)',
            '§6【内置核心模块】：',
            '§b  ▸ §f/epiphy auth ' + authStatus + ' §7- 权限阀与玩家授权管理 §8(详情: /epiphy help auth)'
        ]
        for (var i = 0; i < header.length; i++) {
            sendSourceMessage(source, header[i])
        }

        sendSourceMessage(source, '§6【已挂载业务插件 (' + subcmdOrder.length + ')】：')
        if (subcmdOrder.length === 0) {
            sendSourceMessage(source, '§7  （当前暂无已注册的业务子模块）')
        } else {
            for (var s = 0; s < subcmdOrder.length; s++) {
                var sName = subcmdOrder[s]
                var entry = subcommands[sName]
                if (entry == null) continue
                var subAccess = evaluateSourceAccess(source, sName, entry.policy)
                var badge     = subAccess.allowed ? '§a[可用]' : '§c[未授权]'
                sendSourceMessage(
                    source,
                    '§a  ▸ §f/epiphy ' + sName + ' ' + badge + ' §7- ' + entry.summary + ' §8(详情: /epiphy help ' + sName + ')'
                )
            }
        }
        sendSourceMessage(source, '§3§l====================================================')
        return 1
    }

    // 处理被 .requires(...) 拦截而未能进入 Brigadier 子命令节点的输入（由 ServerEvents.command 在解析前调用）：
    //   使用 /\s+/ 切分首词（彻底避免多空格导致 headWord 为空），若命中已知子命令且无权限，精准打印权限阀拒绝原因并拦截。
    function interceptUnauthorizedCommandInput(source, rawInput) {
        if (source == null || !rawInput) return false
        var clean = String(rawInput).replace(/^\s*\/?/, '').trim()
        if (!clean) return false
        var tokens = clean.split(/\s+/)
        if (tokens.length < 2) return false
        var rootWord = normalizeKey(tokens[0])
        if (rootWord !== ROOT_LITERAL) return false

        var headWord = normalizeKey(tokens[1])
        if (!headWord || headWord === 'help') return false

        if (headWord === 'auth') {
            if (!canSeeSubcommand(source, 'auth', POLICY_PRESETS.admin)) {
                checkSourceOrReject(source, 'auth', POLICY_PRESETS.admin)
                return true
            }
            return false
        }

        var targetSpec = subcommands[headWord]
        if (targetSpec != null) {
            if (!canSeeSubcommand(source, headWord, targetSpec.policy)) {
                checkSourceOrReject(source, headWord, targetSpec.policy)
                return true
            }
        }
        return false
    }

    if (Array.isArray(global.EpiphyCommandRegistryQueue)) {
        for (var q = 0; q < global.EpiphyCommandRegistryQueue.length; q++) {
            registerSubcommand(global.EpiphyCommandRegistryQueue[q])
        }
        global.EpiphyCommandRegistryQueue.length = 0
    }

    function getStats() {
        var worldKeys   = Object.keys(worldAuthStore)
        var grantCount  = 0
        for (var wi = 0; wi < worldKeys.length; wi++) {
            var entry = worldAuthStore[worldKeys[wi]]
            if (entry != null && entry.grants != null) {
                grantCount += Object.keys(entry.grants).length
            }
        }
        return {
            subcommands:          subcmdOrder.slice(),
            subcommandCount:      subcmdOrder.length,
            declaredCallers:      Object.keys(registeredCallers),
            declaredCallersCount: Object.keys(registeredCallers).length,
            declarationStackDepth: declarationStack.length,
            loadedWorldsCount:    worldKeys.length,
            totalGrantedPlayers:  grantCount
        }
    }

    var valveApi = {
        ROOT_LITERAL:              ROOT_LITERAL,
        POLICIES:                  POLICY_PRESETS,
        normalizePermissionPolicy: normalizePermissionPolicy,
        registerSubcommand:        registerSubcommand,
        registerCommand:           registerSubcommand,
        declareCaller:             declareCaller,
        withDeclaration:           withDeclaration,
        bindDeclaration:           bindDeclaration,
        runDeclaredCommand:        runDeclaredCommand,
        classifyCommandSource:     classifyCommandSource,
        evaluateSourceAccess:      evaluateSourceAccess,
        checkSourceOrReject:       checkSourceOrReject,
        canSeeSubcommand:          canSeeSubcommand,
        guardExecution:            guardExecution,
        grantPlayer:               grantPlayer,
        revokePlayer:              revokePlayer,
        isPlayerAuthorized:        isPlayerAuthorized,
        isPlayerAdmin:             isPlayerAdmin,
        isWorldCheatsEnabled:      isWorldCheatsEnabled,
        sendHelp:                  sendAggregatedHelp,
        getStats:                  getStats
    }

    try {
        PlayerEvents.loggedIn(function (event) {
            try {
                var p = event != null ? event.player : null
                if (p == null) return
                var srv = resolveServer(null, p)
                var entry = getOrLoadWorldGrants(srv)
                var rawName = extractPlayerName(p)
                var nameKey = normalizeKey(rawName)
                var uuidKey = normalizeKey(extractPlayerUuid(p))
                if (!uuidKey) return
                var changed = false
                if (nameKey && entry.grants[nameKey]) {
                    changed = migrateNameGrantToUuid(entry.grants, nameKey, uuidKey, rawName)
                }
                if (entry.grants[uuidKey] && rawName && entry.grants[uuidKey].displayName !== rawName) {
                    entry.grants[uuidKey].displayName = rawName
                    changed = true
                }
                if (changed) saveWorldGrantsToDisk(srv)
            } catch (eLogin) {
                logCatch('PlayerEvents.loggedIn:grantSync', eLogin)
            }
        })
    } catch (eRegLogin) {
        logCatch('registerLoggedIn:grantSync', eRegLogin)
    }

    global.EpiphyPermissionValve = valveApi
    global.PermissionValve       = valveApi

    function handleAuthScopeCommand(ctx, Arguments, isGrant, rawScope) {
        var players = Arguments.PLAYERS.getResult(ctx, 'targets')
        var srv     = resolveServer(ctx.source, ctx.source.player)
        var scope   = normalizeScope(rawScope)
        var cnt     = 0
        if (players != null && typeof players.iterator === 'function') {
            var it = players.iterator()
            while (it.hasNext()) {
                var ok = isGrant
                    ? grantPlayer(srv, it.next(), scope, ctx.source)
                    : revokePlayer(srv, it.next(), scope)
                if (ok) cnt++
            }
        }
        var targetLabel = (scope === '*') ? '全部 /epiphy 子命令权限 (*)' : ('[/epiphy ' + scope + '] 权限')
        var msg = isGrant
            ? ('§a[Epiphy 权限阀] 已授予 ' + cnt + ' 名玩家' + targetLabel + '并记录审计信息。')
            : ('§e[Epiphy 权限阀] 已撤销 ' + cnt + ' 名玩家的' + targetLabel + '并同步至当前存档。')
        sendSourceMessage(ctx.source, msg)
        return cnt
    }

    ServerEvents.commandRegistry(function (event) {
        var Commands  = event.commands
        var Arguments = event.arguments

        if (Array.isArray(global.EpiphyCommandRegistryQueue) && global.EpiphyCommandRegistryQueue.length > 0) {
            for (var rq = 0; rq < global.EpiphyCommandRegistryQueue.length; rq++) {
                registerSubcommand(global.EpiphyCommandRegistryQueue[rq])
            }
            global.EpiphyCommandRegistryQueue.length = 0
        }

        var root = Commands.literal(ROOT_LITERAL)
            .executes(function (ctx) {
                return sendAggregatedHelp(ctx.source, null)
            })
            .then(
                Commands.literal('help')
                    .executes(function (ctx) {
                        return sendAggregatedHelp(ctx.source, null)
                    })
                    .then(
                        Commands.argument('topic', Arguments.WORD.create(event))
                            .executes(function (ctx) {
                                var topic = Arguments.WORD.getResult(ctx, 'topic')
                                return sendAggregatedHelp(ctx.source, topic)
                            })
                    )
            )
            .then(
                Commands.literal('auth')
                    .requires(function (source) {
                        return canSeeSubcommand(source, 'auth', POLICY_PRESETS.admin)
                    })
                    .then(
                        Commands.literal('list')
                            .executes(guardExecution('auth', POLICY_PRESETS.admin, function (ctx) {
                                var srv     = resolveServer(ctx.source, ctx.source.player)
                                var info    = resolveWorldStorageInfo(srv)
                                var entries = listGrantedEntries(srv)
                                var cheats  = isWorldCheatsEnabled(srv, ctx.source.player)
                                sendSourceMessage(ctx.source, '§b[Epiphy 权限阀] §7世界作弊状态: ' + (cheats ? '§a已开启' : '§c未开启') + ' §7| 授权用户数: §e' + entries.length)
                                sendSourceMessage(ctx.source, '§7当前存档授权文件: §8' + info.filePath)
                                for (var eIdx = 0; eIdx < entries.length; eIdx++) {
                                    sendSourceMessage(ctx.source, '§7  • §f' + entries[eIdx])
                                }
                                return 1
                            }))
                    )
                    .then(
                        Commands.literal('grant')
                            .then(
                                Commands.argument('targets', Arguments.PLAYERS.create(event))
                                    .executes(guardExecution('auth', POLICY_PRESETS.admin, function (ctx) {
                                        return handleAuthScopeCommand(ctx, Arguments, true, '*')
                                    }))
                                    .then(
                                        Commands.argument('scope', Arguments.WORD.create(event))
                                            .executes(guardExecution('auth', POLICY_PRESETS.admin, function (ctx) {
                                                return handleAuthScopeCommand(ctx, Arguments, true, Arguments.WORD.getResult(ctx, 'scope'))
                                            }))
                                    )
                            )
                    )
                    .then(
                        Commands.literal('revoke')
                            .then(
                                Commands.argument('targets', Arguments.PLAYERS.create(event))
                                    .executes(guardExecution('auth', POLICY_PRESETS.admin, function (ctx) {
                                        return handleAuthScopeCommand(ctx, Arguments, false, '*')
                                    }))
                                    .then(
                                        Commands.argument('scope', Arguments.WORD.create(event))
                                            .executes(guardExecution('auth', POLICY_PRESETS.admin, function (ctx) {
                                                return handleAuthScopeCommand(ctx, Arguments, false, Arguments.WORD.getResult(ctx, 'scope'))
                                            }))
                                    )
                            )
                    )
            )

        // 挂载各业务模块声明的子命令，并挂载安全包裹 try/catch 的 .requires(...) 以隐藏无权限玩家的 Tab 补全树
        for (var idx = 0; idx < subcmdOrder.length; idx++) {
            var subName = subcmdOrder[idx]
            var subSpec = subcommands[subName]
            if (subSpec == null || typeof subSpec.buildNode !== 'function') continue
            ;(function (boundName, boundSpec) {
                try {
                    var subNode = boundSpec.buildNode({
                        event:          event,
                        Commands:       Commands,
                        Arguments:      Arguments,
                        valve:          valveApi,
                        policy:         boundSpec.policy,
                        canSee:         function (source, branchPolicy) {
                            return canSeeSubcommand(source, boundName, branchPolicy)
                        },
                        guardExecution: function (handlerOrBranchPolicy, maybeHandler) {
                            return guardExecution(boundName, handlerOrBranchPolicy, maybeHandler)
                        }
                    })
                    if (subNode != null) {
                        if (typeof subNode.requires === 'function') {
                            subNode = subNode.requires(function (source) {
                                return canSeeSubcommand(source, boundName, boundSpec.policy)
                            })
                        }
                        root = root.then(subNode)
                    }
                } catch (eSub) {
                    logError('commandRegistry', '挂载子命令 ' + boundName + ' 失败: ' + eSub)
                }
            })(subName, subSpec)
        }

        event.register(root)
    })

    // 在 Brigadier 抛出 Unknown command 之前拦截未获授权的 /epiphy <子命令> 调用：
    //   既无需挂载常驻 GREEDY_STRING 节点（消除 <unpermitted_input> 补全提示并完整保留原版红色语法错误下划线），
    //   又能让无权限调用源收到明确的权限阀中文拒绝原因。
    ServerEvents.command(function (event) {
        try {
            var input = (typeof event.getInput === 'function') ? event.getInput() : event.input
            if (!input) return
            var parseRes = (typeof event.getParseResults === 'function') ? event.getParseResults() : event.parseResults
            var ctx      = (parseRes != null && typeof parseRes.getContext === 'function') ? parseRes.getContext() : (parseRes != null ? parseRes.context : null)
            var source   = (ctx != null && typeof ctx.getSource === 'function') ? ctx.getSource() : (ctx != null ? ctx.source : null)
            if (source != null && interceptUnauthorizedCommandInput(source, input)) {
                event.cancel()
            }
        } catch (eCmd) {
            logCatch('ServerEvents.command', eCmd)
        }
    })

    // 动态注册权限阀运行时统计到统一调试组件 (EpiphyDebug)
    var valveDebugProvider = {
        name:    'valve',
        label:   '权限阀中心',
        order:   30,
        summary: function () {
            var s = getStats()
            return 'subcmds=' + s.subcommandCount + ' [' + (s.subcommands.join(',') || 'none') + ']' +
                ' | callers=' + s.declaredCallersCount +
                ' | stackDepth=' + s.declarationStackDepth +
                ' | grants=' + s.totalGrantedPlayers
        },
        detail: function () {
            var s = getStats()
            var lines = [
                'subcommands (' + s.subcommandCount + '): ' + (s.subcommands.join(', ') || '（无）'),
                'declaredCallers (' + s.declaredCallersCount + '): ' + (s.declaredCallers.join(', ') || '（无）'),
                'declarationStackDepth: ' + s.declarationStackDepth,
                'loadedWorldsCount: ' + s.loadedWorldsCount + ', totalGrantedPlayers: ' + s.totalGrantedPlayers
            ]
            for (var i = 0; i < subcmdOrder.length; i++) {
                var sk = subcmdOrder[i]
                var sp = subcommands[sk]
                if (sp != null) {
                    lines.push('policy[' + sk + ']: mode=' + sp.policy.mode + ', console=' + sp.policy.allowConsole + ', declared=' + sp.policy.allowDeclaredCallers)
                }
            }
            return lines
        },
        check: function () {
            var s = getStats()
            return [{
                name:   'declaration_stack_balanced',
                ok:     s.declarationStackDepth === 0,
                detail: 'declarationStackDepth=' + s.declarationStackDepth
            }]
        }
    }
    if (typeof global !== 'undefined' && global != null) {
        if (global.EpiphyDebug != null && typeof global.EpiphyDebug.registerProvider === 'function') {
            global.EpiphyDebug.registerProvider(valveDebugProvider)
        } else {
            if (!Array.isArray(global.EpiphyDebugProviderQueue)) global.EpiphyDebugProviderQueue = []
            global.EpiphyDebugProviderQueue.push(valveDebugProvider)
        }
    }
})()
