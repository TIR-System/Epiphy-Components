// priority: 1000
// ============================================================================
//  通用指令权限阀与 /epiphy 根命令注册中心 (EpiphyPermissionValve v5.2)
//  所属系列：Epiphy的-通用组件系列（本系列包含 startup / server / client 配套脚本）
//  [LLM 协作规范] 每次进行较大修改或重构前，请先将修改同步至 D:\Git-Epiphy 并执行 git commit 保存当前可用状态，便于随时回退与对比 diff。
//  许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
//  放置位置：kubejs/server_scripts/通用组件/Epiphy的-权限阀.js
//
//  职责说明：
//    1. 统一接管 `/epiphy` 根指令树，向各业务组件提供子命令挂载、细粒度分层权限域 (`module` / `module.action` / `exactScopeOnly` 广播特权)、`/epiphy auth scopes [模块]` 查看与 `/epiphy help` 帮助聚合（总览仅显示各模块一句话 summary，输入 `/epiphy help <模块>` 查看详情）；
//    2. 外部统一持久化、防回滚墓碑与 Fail-Closed 按名备用模式：
//       - 将每个世界的授权与撤销数据落盘至独立外部目录 `epiphy-data/worlds/<世界slug>__<短worldId>/`（`permissions.json`、`revocations.json`、`auth_mode.json`），首次升级支持从旧 `saves/<存档>/kubejs_epiphy_permissions.json` 一次性迁移；
//       - 若检测到存档被复制导致 `lastWorldPath` 变化，由 `EpiphyServerBase` 自动分叉新世界目录并在 OP 进服时提醒手动清理旧目录；
//       - 撤销权限时在 `revocations.json` 写入 `revokedAtMs` 墓碑，防止世界备份/回滚或旧快照导入使已撤销权限复活；
//       - 默认严格按 UUID 授权（并明示纯离线服无 TrueUUID 且无密码插件时 UUID 亦不安全）；备用按名授权模式默认 Fail-Closed（`allowNameGrant: false`），仅允许真 OP / 控制台通过 `/epiphy auth namegrant enable -> confirm <8位口令>`（2 分钟内二次确认）或手动修改带完整风险注释的 `auth_mode.json` 开启，中途关闭后保留未迁移按名记录但暂停生效；
//       - 提供 `getCommandActorTier(source)` 为下游组件区分 `'system'`（真 OP/控制台/命令方块/声明调用）与 `'player'`（`authorized` 普通玩家）资源层级。
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
    var BASE = (typeof global !== 'undefined') ? global.EpiphyServerBase : null
    if (!BASE) {
        throw new Error('[EpiphyPermissionValve] 缺少硬依赖 global.EpiphyServerBase，请确认 server_scripts/通用组件/Epiphy的-服务端基础.js 已加载')
    }

    var LOGGER                  = BASE.createLogger('EpiphyPermissionValve', 5000)
    var ROOT_LITERAL            = 'epiphy'
    var NAMEGRANT_TOKEN_TTL_MS  = 120000 // 2 分钟二次确认有效期
    var NAMEGRANT_TOKEN_LEN     = 8

    var SERVER_REF = null

    function logWarn(tag, msg) { LOGGER.warn(tag, msg) }
    function logError(tag, msg) { LOGGER.error(tag, msg) }
    function logCatch(tag, err) { LOGGER.catchWarn(tag, err) }
    function logOnceWarn(key, msg) { LOGGER.once('warn', key, msg) }
    function loadJavaClass(className) { return BASE.loadJavaClass(className, LOGGER) }

    var BaseCommandBlockClass  = loadJavaClass('net.minecraft.world.level.BaseCommandBlock')
    var MinecraftServerClass   = loadJavaClass('net.minecraft.server.MinecraftServer')
    var RconConsoleSourceClass = loadJavaClass('net.minecraft.server.rcon.RconConsoleSource')
    var ServerPlayerClass      = loadJavaClass('net.minecraft.server.level.ServerPlayer')
    var SecureRandomClass      = loadJavaClass('java.security.SecureRandom')
    var secureRandomInst       = null
    try {
        if (SecureRandomClass != null) secureRandomInst = new SecureRandomClass()
    } catch (eSr) {
        secureRandomInst = null
    }

    // 注意：Java.loadClass(...) 返回 Rhino NativeJavaClass，需兼容 instanceof 与 __javaObject__.isInstance 校验。
    function isJavaInstance(javaClassWrapper, obj) {
        if (javaClassWrapper == null || obj == null) return false
        try {
            if (obj instanceof javaClassWrapper) return true
        } catch (e0) { }
        try {
            var rawClassObj = javaClassWrapper.__javaObject__
            if (rawClassObj != null && typeof rawClassObj.isInstance === 'function') {
                return Boolean(rawClassObj.isInstance(obj))
            }
            if (rawClassObj != null && typeof rawClassObj.isAssignableFrom === 'function' && typeof obj.getClass === 'function') {
                return Boolean(rawClassObj.isAssignableFrom(obj.getClass()))
            }
        } catch (e1) { }
        return false
    }

    var subcommands          = {}
    var subcmdOrder          = []
    var RESERVED_SUBCOMMANDS = {
        auth: true,
        help: true
    }
    var FORBIDDEN_PROP_KEYS = {
        __proto__:            true,
        constructor:          true,
        prototype:            true,
        toString:             true,
        tostring:             true,
        valueOf:              true,
        valueof:              true,
        hasOwnProperty:       true,
        hasownproperty:       true,
        isPrototypeOf:        true,
        isprototypeof:        true,
        propertyIsEnumerable: true,
        propertyisenumerable: true,
        toLocaleString:       true,
        tolocalestring:       true
    }
    function isForbiddenSubcommandKey(k) {
        return !k || Boolean(FORBIDDEN_PROP_KEYS[k])
    }
    function getRegisteredSubcommand(key) {
        if (!key || isForbiddenSubcommandKey(key)) return null
        return Object.prototype.hasOwnProperty.call(subcommands, key) ? subcommands[key] : null
    }
    // 按存档隔离的内存缓存（统一存储在 epiphy-data/worlds/<slug>__<shortId>/ 下）
    var worldAuthStore               = {}
    var pendingNameGrantTokens       = {} // '<worldKey>|<actorKey>' -> { code, expiresAtMs, createdAtMs }
    var forkNotifiedWorlds           = {} // '<worldKey>' -> true
    var declarationStack             = []
    // 已注册的内部调用方白名单：{ '<callerId>': { '<subcmd>': true } }（严禁无参数默认全权 '*'）
    var registeredCallers    = {}
    // 与 registeredCallers 一一对应的不可伪造能力令牌（按引用比对，禁止仅凭字符串触发声明调用）
    var callerTokensById     = {}

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
        }),
        strict_op: Object.freeze({
            mode:                 'strict_op',
            label:                '仅真实 OP 或控制台（禁止命令方块与脚本代调）',
            requireCheats:        true,
            requireOp:            true,
            allowAuthorized:      false,
            opLevel:              2,
            allowCommandBlock:    false,
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
        if (!s || s === 'all' || s === '*') return '*'
        s = s.replace(/[\/:]+/g, '.').replace(/\.+/g, '.').replace(/^\.+|\.+$/g, '')
        return (!s || s === 'all' || s === '*') ? '*' : s
    }

    function isReservedScope(scope) {
        var s = normalizeScope(scope)
        if (RESERVED_SUBCOMMANDS[s]) return true
        return s.indexOf('auth.') === 0 || s.indexOf('help.') === 0
    }

    function buildScopeHierarchy(scope) {
        var norm = normalizeScope(scope)
        if (norm === '*') return ['*']
        var out = []
        var cur = norm
        while (cur) {
            out.push(cur)
            var dot = cur.lastIndexOf('.')
            if (dot <= 0) break
            cur = cur.substring(0, dot)
        }
        out.push('*')
        return out
    }

    function scopeMatchesSet(scopeSet, targetScope, exactScopeOnly) {
        if (scopeSet == null) return false
        var chain = buildScopeHierarchy(targetScope)
        if (exactScopeOnly) {
            return Boolean(scopeSet[chain[0]] || scopeSet['*'])
        }
        for (var i = 0; i < chain.length; i++) {
            if (scopeSet[chain[i]]) return true
        }
        return false
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
            if (s === 'authorized' || s === 'cheat_or_auth' || s === '授权') return clonePolicy(POLICY_PRESETS.authorized)
            if (s === 'admin' || s === 'op' || s === 'operator' || s === '管理员') return clonePolicy(POLICY_PRESETS.admin)
            if (s === 'strict_op' || s === 'strict-op' || s === 'strictop' || s === '严格管理员') return clonePolicy(POLICY_PRESETS.strict_op)
            var failClosed = (fallbackPolicy && s !== 'auth') ? fallbackPolicy : POLICY_PRESETS.admin
            logWarn('normalizePermissionPolicy', '未知权限策略 "' + rawPolicy + '"（注意：\'auth\' 是保留子命令名而非策略预设名，请改用 "authorized"），已按最小权限原则回退为 "' + failClosed.mode + '"。')
            return clonePolicy(failClosed)
        }
        if (typeof rawPolicy === 'object') {
            var presetKey  = rawPolicy.mode || rawPolicy.type || rawPolicy.preset
            var presetNorm = (typeof presetKey === 'string') ? presetKey.trim().toLowerCase() : ''
            var seed = (presetNorm && presetNorm !== 'custom')
                ? normalizePermissionPolicy(presetKey, (presetNorm === 'auth') ? POLICY_PRESETS.admin : base)
                : clonePolicy(base)
            var callerWhitelist = rawPolicy.allowedCallers !== undefined
                ? normalizeAllowedCallersList(rawPolicy.allowedCallers)
                : seed.allowedCallers
            var rawScopeStr = rawPolicy.scope != null ? String(rawPolicy.scope).trim() : ''
            return {
                mode:                 String((presetNorm === 'custom') ? 'custom' : (presetNorm ? seed.mode : 'custom')),
                label:                String(rawPolicy.label || seed.label),
                requireCheats:        rawPolicy.requireCheats !== undefined ? Boolean(rawPolicy.requireCheats) : seed.requireCheats,
                requireOp:            rawPolicy.requireOp !== undefined ? Boolean(rawPolicy.requireOp) : seed.requireOp,
                allowAuthorized:      rawPolicy.allowAuthorized !== undefined ? Boolean(rawPolicy.allowAuthorized) : seed.allowAuthorized,
                opLevel:              (rawPolicy.opLevel != null && isFinite(Number(rawPolicy.opLevel))) ? Math.round(Number(rawPolicy.opLevel)) : seed.opLevel,
                allowCommandBlock:    rawPolicy.allowCommandBlock !== undefined ? Boolean(rawPolicy.allowCommandBlock) : seed.allowCommandBlock,
                allowConsole:         rawPolicy.allowConsole !== undefined ? Boolean(rawPolicy.allowConsole) : seed.allowConsole,
                allowDeclaredCallers: rawPolicy.allowDeclaredCallers !== undefined ? Boolean(rawPolicy.allowDeclaredCallers) : seed.allowDeclaredCallers,
                allowedCallers:       callerWhitelist,
                scope:                rawScopeStr ? normalizeScope(rawScopeStr) : (seed.scope || ''),
                exactScopeOnly:       rawPolicy.exactScopeOnly !== undefined ? Boolean(rawPolicy.exactScopeOnly) : Boolean(seed.exactScopeOnly),
                allowSubScopes:       rawPolicy.allowSubScopes !== undefined ? Boolean(rawPolicy.allowSubScopes) : Boolean(seed.allowSubScopes),
                customCheck:          typeof rawPolicy.customCheck === 'function' ? rawPolicy.customCheck : null
            }
        }
        return clonePolicy(base)
    }

    function extractServerFromObj(obj) {
        if (obj == null) return null
        if (typeof obj.getServer === 'function') {
            var s0 = obj.getServer()
            if (s0 != null) return s0
        }
        return obj.server != null ? obj.server : null
    }

    function resolveServer(source, player) {
        var s = extractServerFromObj(source) || extractServerFromObj(player)
        if (s != null) {
            SERVER_REF = s
            return s
        }
        if (SERVER_REF == null) {
            SERVER_REF = BASE.resolveServer(null)
        }
        return SERVER_REF
    }

    function resolveWorldStorageInfo(server) {
        var srv = server || SERVER_REF
        if (typeof BASE.resolveEpiphyWorldContext === 'function') {
            var ctx = BASE.resolveEpiphyWorldContext(srv)
            return {
                worldKey:        ctx.worldKey,
                worldId:         ctx.worldId,
                worldName:       ctx.worldName,
                slug:            ctx.slug,
                folderName:      ctx.folderName,
                worldPath:       ctx.worldPath,
                worldDataDir:    ctx.worldDataDir,
                filePath:        ctx.permissionsFile,
                permissionsFile: ctx.permissionsFile,
                revocationsFile: ctx.revocationsFile,
                authModeFile:    ctx.authModeFile,
                metaFile:        ctx.metaFile,
                legacyFiles:     ctx.legacyFiles || [],
                forkNotice:      ctx.forkNotice || null,
                isWorldRoot:     Boolean(ctx.isWorldBound)
            }
        }
        return BASE.resolveWorldStorageInfo(srv, 'kubejs_epiphy_permissions.json', 'kubejs/config/epiphy_permissions')
    }

    function ensureParentDir(filePathStr) {
        return BASE.ensureParentDir(filePathStr, LOGGER)
    }

    function readMapField(obj, key) {
        return BASE.readMapField(obj, key)
    }

    function readJsonFile(filePath) {
        if (!filePath) return null
        if (typeof BASE.readJsonSafe === 'function') {
            return BASE.readJsonSafe(filePath, LOGGER)
        }
        try {
            if (typeof JsonIO !== 'undefined' && JsonIO != null) {
                return JsonIO.read(filePath)
            }
        } catch (eRead) {
            logCatch('readJsonFile', eRead)
        }
        return null
    }

    function writeJsonFile(filePath, payload) {
        if (!filePath) return false
        if (typeof BASE.writeJsonAtomic === 'function') {
            return BASE.writeJsonAtomic(filePath, payload, true, LOGGER)
        }
        try {
            if (typeof JsonIO !== 'undefined' && JsonIO != null) {
                ensureParentDir(filePath)
                JsonIO.write(filePath, payload)
                return true
            }
        } catch (eWrite) {
            logCatch('writeJsonFile', eWrite)
        }
        return false
    }

    function isUuidKeyFormat(keyStr) {
        if (!keyStr) return false
        var s = String(keyStr).trim()
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) || /^[0-9a-f]{32}$/i.test(s)
    }

    function isGrantRecordUuid(rec, uKey) {
        if (rec != null && rec.keyKind === 'uuid') return true
        if (rec != null && rec.keyKind === 'name') return false
        return isUuidKeyFormat(uKey)
    }

    function parseScopeAuditMeta(val) {
        if (!val) return null
        if (val === true) return { by: 'unknown', at: 'unknown', atMs: 0 }
        if (typeof val === 'object') {
            var byVal  = readMapField(val, 'by') || readMapField(val, 'grantedBy') || 'unknown'
            var atVal  = readMapField(val, 'at') || readMapField(val, 'grantedAt') || 'unknown'
            var rawMs  = readMapField(val, 'atMs')
            var atMs   = (rawMs != null && isFinite(Number(rawMs)) && Number(rawMs) >= 0) ? Number(rawMs) : 0
            if (atMs === 0 && typeof atVal === 'string' && atVal !== 'unknown') {
                var parsedMs = Date.parse(String(atVal).replace(' ', 'T'))
                if (isFinite(parsedMs) && parsedMs > 0) atMs = parsedMs
            }
            return {
                by:   String(byVal),
                at:   String(atVal),
                atMs: atMs
            }
        }
        return null
    }

    // 解析单条用户授权数据（兼容旧版数组格式 ['*'] 与新版带审计信息格式 { keyKind, displayName, scopes: { '*': { by, at, atMs } } }）
    function parseUserGrantRecord(uKey, rawUserVal) {
        var inferredKind = isUuidKeyFormat(uKey) ? 'uuid' : 'name'
        var record = {
            keyKind:     inferredKind,
            displayName: uKey,
            scopes:      {}
        }
        if (rawUserVal == null) return record

        if (Array.isArray(rawUserVal) || (typeof rawUserVal === 'object' && typeof rawUserVal.iterator === 'function')) {
            if (typeof rawUserVal.iterator === 'function') {
                var it = rawUserVal.iterator()
                while (it.hasNext()) {
                    var sc = normalizeScope(it.next())
                    record.scopes[sc] = { by: 'legacy', at: 'unknown', atMs: 0 }
                }
            } else {
                for (var i = 0; i < rawUserVal.length; i++) {
                    var sc2 = normalizeScope(rawUserVal[i])
                    record.scopes[sc2] = { by: 'legacy', at: 'unknown', atMs: 0 }
                }
            }
            return record
        }

        if (typeof rawUserVal === 'object') {
            var kk = readMapField(rawUserVal, 'keyKind')
            if (kk === 'uuid' || kk === 'name') {
                record.keyKind = kk
            }
            var disp = readMapField(rawUserVal, 'displayName')
            if (disp != null && String(disp).trim().length > 0) {
                record.displayName = String(disp).trim()
            }
            var rawScopesObj = readMapField(rawUserVal, 'scopes') || rawUserVal
            if (typeof rawScopesObj.keySet === 'function') {
                var kit = rawScopesObj.keySet().iterator()
                while (kit.hasNext()) {
                    var k = String(kit.next())
                    if (k === 'displayName' || k === 'scopes' || k === 'keyKind') continue
                    var v = rawScopesObj.get(k)
                    var meta = parseScopeAuditMeta(v)
                    if (meta) record.scopes[normalizeScope(k)] = meta
                }
            } else {
                for (var sk in rawScopesObj) {
                    if (sk === 'displayName' || sk === 'scopes' || sk === 'keyKind') continue
                    var meta2 = parseScopeAuditMeta(rawScopesObj[sk])
                    if (meta2) record.scopes[normalizeScope(sk)] = meta2
                }
            }
        }
        return record
    }

    function parseUsersMapInto(rawUsersObj, targetGrants) {
        if (rawUsersObj == null) return
        if (typeof rawUsersObj.keySet === 'function') {
            var ks = rawUsersObj.keySet().iterator()
            while (ks.hasNext()) {
                var rawK = String(ks.next())
                var uKey = normalizeKey(rawK)
                if (uKey) targetGrants[uKey] = parseUserGrantRecord(uKey, rawUsersObj.get(rawK))
            }
        } else if (typeof rawUsersObj === 'object') {
            for (var uk in rawUsersObj) {
                var normUk = normalizeKey(uk)
                if (normUk) targetGrants[normUk] = parseUserGrantRecord(normUk, rawUsersObj[uk])
            }
        }
    }

    function parseRevocationsMap(rawObj) {
        var out = {}
        if (rawObj == null || typeof rawObj !== 'object') return out
        var src = readMapField(rawObj, 'revoked') || rawObj
        if (src == null || typeof src !== 'object') return out
        for (var uKey in src) {
            if (!Object.prototype.hasOwnProperty.call(src, uKey)) continue
            var normUk = normalizeKey(uKey)
            var rec = src[uKey]
            if (!normUk || rec == null || typeof rec !== 'object') continue
            var cleanScopes = {}
            var hasAny = false
            for (var sc in rec) {
                if (!Object.prototype.hasOwnProperty.call(rec, sc)) continue
                var scopeKey = normalizeScope(sc)
                var rawItem = rec[sc]
                var ts = (typeof rawItem === 'number')
                    ? rawItem
                    : (rawItem && typeof rawItem === 'object' ? Number(rawItem.revokedAtMs || rawItem.atMs || 0) : 0)
                if (isFinite(ts) && ts > 0) {
                    cleanScopes[scopeKey] = {
                        revokedAtMs: ts,
                        revokedAt:   (rawItem && rawItem.revokedAt) ? String(rawItem.revokedAt) : '',
                        by:          (rawItem && rawItem.by) ? String(rawItem.by) : 'unknown'
                    }
                    hasAny = true
                }
            }
            if (hasAny) out[normUk] = cleanScopes
        }
        return out
    }

    function getRevocationMs(revocationsMap, userKey, scope) {
        if (!revocationsMap || !userKey) return 0
        var rec = revocationsMap[userKey]
        if (!rec) return 0
        var starRec  = rec['*']
        var scopeRec = (scope && scope !== '*') ? rec[scope] : null
        var starTs   = starRec ? Number(starRec.revokedAtMs || 0) : 0
        var scopeTs  = scopeRec ? Number(scopeRec.revokedAtMs || 0) : 0
        return starTs > scopeTs ? starTs : scopeTs
    }

    function isGrantSupersededByRevocation(revocationsMap, userKey, scope, grantAtMs) {
        var revTs = getRevocationMs(revocationsMap, userKey, scope)
        if (!(revTs > 0)) return false
        var gTs = (grantAtMs != null && isFinite(Number(grantAtMs))) ? Number(grantAtMs) : 0
        return gTs <= revTs
    }

    function pruneGrantsByRevocations(grantsMap, revocationsMap) {
        var removedCount = 0
        for (var uKey in grantsMap) {
            if (!Object.prototype.hasOwnProperty.call(grantsMap, uKey)) continue
            var rec = grantsMap[uKey]
            if (!rec || !rec.scopes) continue
            var remain = 0
            for (var sc in rec.scopes) {
                var meta = rec.scopes[sc]
                if (!meta || isGrantSupersededByRevocation(revocationsMap, uKey, sc, meta.atMs)) {
                    delete rec.scopes[sc]
                    removedCount++
                } else {
                    remain++
                }
            }
            if (remain === 0) {
                delete grantsMap[uKey]
            }
        }
        return removedCount
    }

    function recordRevocationTombstone(revocationsMap, userKey, scope, byLabel, nowMs) {
        if (!revocationsMap || !userKey) return
        var sc = normalizeScope(scope)
        if (!revocationsMap[userKey]) revocationsMap[userKey] = {}
        revocationsMap[userKey][sc] = {
            revokedAtMs: nowMs,
            revokedAt:   formatTimestampNow(),
            by:          byLabel || 'SYSTEM'
        }
    }

    function buildDefaultAuthModePayload(allowBool, updatedBy, updatedAt) {
        var enabled = (allowBool === true) // Fail-Closed：仅严格布尔 true 开启
        return {
            _warning: '【安全警告】开启 allowNameGrant 后，服务器将允许按玩家文本名授权，并在首个同名玩家上线时将其迁入 UUID。在未安装强制登录验证插件（如 AuthMe / EasyAuth）的服务器中，任何人只要最先以该名字上线即可永久冒领并继承全部权限！',
            _consequences: [
                '1. allowNameGrant 必须严格等于布尔值 true 才生效（Fail-Closed 原则）；任何字符串/数字/null/缺省均按 false（严格 UUID 模式）处理。',
                '2. 默认关闭（false）：仅校验玩家 UUID；未迁移的文本名授权记录会保留在 permissions.json 中并处于暂停状态，不自动迁移也不放行。',
                '3. 若服务器安装并强制“登录前禁止执行指令/禁止行动”的登录密码插件，按名冒领风险可忽略。',
                '4. 【纯离线服重要警告】若服务器为 online-mode=false 的纯离线服，且既未安装 TrueUUID 类 UUID 修复 Mod、也未安装登录密码插件，则即使保持默认 UUID 模式（allowNameGrant=false）依然不安全（原版离线 UUID 可由用户名直接计算）。'
            ],
            allowNameGrant: enabled,
            mode:           enabled ? 'uuid_with_name_fallback' : 'uuid_only',
            updatedBy:      updatedBy || 'SYSTEM',
            updatedAt:      updatedAt || formatTimestampNow()
        }
    }

    function parseAuthModeFile(rawObj) {
        if (rawObj == null || typeof rawObj !== 'object') {
            return {
                exists:         false,
                allowNameGrant: false,
                updatedBy:      'SYSTEM',
                updatedAt:      formatTimestampNow()
            }
        }
        // Fail-Closed：只有严格布尔 true 才启用按名字授权备用模式
        var rawFlag = readMapField(rawObj, 'allowNameGrant')
        var enabled = (rawFlag === true)
        var byVal   = readMapField(rawObj, 'updatedBy')
        var atVal   = readMapField(rawObj, 'updatedAt')
        return {
            exists:         true,
            allowNameGrant: enabled,
            updatedBy:      byVal ? String(byVal) : 'SYSTEM',
            updatedAt:      atVal ? String(atVal) : formatTimestampNow()
        }
    }

    function isNameGrantEnabled(entry) {
        return Boolean(entry != null && entry.authMode != null && entry.authMode.allowNameGrant === true)
    }

    function serializeGrantsPayload(grantsMap) {
        var outUsers = {}
        for (var uKey in grantsMap) {
            if (!Object.prototype.hasOwnProperty.call(grantsMap, uKey)) continue
            var rec = grantsMap[uKey]
            if (!rec || !rec.scopes) continue
            var outScopes = {}
            var count = 0
            for (var sc in rec.scopes) {
                var meta = rec.scopes[sc]
                if (meta) {
                    outScopes[sc] = {
                        by:   String(meta.by || 'unknown'),
                        at:   String(meta.at || ''),
                        atMs: Number(meta.atMs || 0)
                    }
                    count++
                }
            }
            if (count > 0) {
                outUsers[uKey] = {
                    keyKind:     isGrantRecordUuid(rec, uKey) ? 'uuid' : 'name',
                    displayName: String(rec.displayName || uKey),
                    scopes:      outScopes
                }
            }
        }
        return {
            version:   5,
            updatedAt: formatTimestampNow(),
            users:     outUsers
        }
    }

    function getOrLoadWorldGrants(server) {
        var info  = resolveWorldStorageInfo(server)
        var entry = worldAuthStore[info.worldKey]
        if (entry != null && entry.loaded) {
            return entry
        }

        // 1. 先加载外置撤销墓碑 (revocations.json) —— 绝不随 saves/ 回滚而消失
        var revocations = {}
        if (info.revocationsFile) {
            var rawRev = readJsonFile(info.revocationsFile)
            if (rawRev != null) {
                revocations = parseRevocationsMap(rawRev)
            }
        }

        // 2. 加载世界按名授权模式开关 (auth_mode.json, Fail-Closed 默认 false，首次缺失则落盘生成带风险说明的默认文件)
        var rawMode = info.authModeFile ? readJsonFile(info.authModeFile) : null
        var authMode = parseAuthModeFile(rawMode)
        if (!authMode.exists && info.authModeFile) {
            writeJsonFile(info.authModeFile, buildDefaultAuthModePayload(false, 'SYSTEM', authMode.updatedAt))
        }

        // 3. 加载主授权表 (permissions.json)；若尚未迁移过且存在旧版存档/fallback 文件，执行一次性迁移
        var grants = {}
        var mainRaw = info.filePath ? readJsonFile(info.filePath) : null
        var needSaveMain = false
        if (mainRaw != null) {
            parseUsersMapInto(readMapField(mainRaw, 'users'), grants)
        } else if (Array.isArray(info.legacyFiles)) {
            // 设计约束：info.legacyFiles 按“单存档精准路径 (<world>/kubejs_epiphy_permissions.json) -> 旧版共享世界名路径 (<slug>.json)”排序；
            // 一旦命中优先级更高、按世界精准隔离的旧文件，必须立即 break，绝不继续合并后续旧共享目录文件，防止跨同名存档权限污染或覆盖已变更状态。
            for (var lf = 0; lf < info.legacyFiles.length; lf++) {
                var legPath = info.legacyFiles[lf]
                var legRaw = readJsonFile(legPath)
                if (legRaw != null) {
                    var legUsers = readMapField(legRaw, 'users')
                    if (legUsers != null) {
                        parseUsersMapInto(legUsers, grants)
                        needSaveMain = true
                        logWarn('legacyImport', '已从旧位置 "' + legPath + '" 一次性导入授权数据至 "' + info.filePath + '"（受外部撤销墓碑校验保护）。')
                        break
                    }
                }
            }
        }

        // 4. 用外部撤销墓碑裁剪任何因世界回滚或旧文件导入而复活的撤销授权
        var pruned = pruneGrantsByRevocations(grants, revocations)
        if (pruned > 0) {
            needSaveMain = true
            logWarn('revocationTombstone', '检测到 ' + pruned + ' 条已撤销授权在存档回滚或旧档导入中尝试复活，已被外部墓碑拦截移除。')
        }

        entry = {
            worldKey:        info.worldKey,
            worldId:         info.worldId || info.worldKey,
            filePath:        info.filePath,
            revocationsFile: info.revocationsFile || '',
            authModeFile:    info.authModeFile || '',
            ctxInfo:         info,
            loaded:          true,
            grants:          grants,
            revocations:     revocations,
            authMode:        authMode
        }
        worldAuthStore[info.worldKey] = entry

        if (needSaveMain && info.filePath) {
            writeJsonFile(info.filePath, serializeGrantsPayload(entry.grants))
        }
        return entry
    }

    function saveWorldGrantsToDisk(server) {
        var entry = getOrLoadWorldGrants(server)
        try {
            return writeJsonFile(entry.filePath, serializeGrantsPayload(entry.grants))
        } catch (eWrite) {
            logError('saveWorldGrantsToDisk', '写入授权文件失败 (' + entry.filePath + '): ' + eWrite)
        }
        return false
    }

    function saveWorldRevocationsToDisk(server) {
        var entry = getOrLoadWorldGrants(server)
        if (!entry.revocationsFile) return false
        try {
            return writeJsonFile(entry.revocationsFile, {
                _description: 'Epiphy 外置授权撤销墓碑（独立于 saves/ 存档目录，防止世界回滚复活已撤销授权）',
                version:      1,
                updatedAt:    formatTimestampNow(),
                revoked:      entry.revocations
            })
        } catch (eWrite) {
            logError('saveWorldRevocationsToDisk', '写入撤销墓碑失败 (' + entry.revocationsFile + '): ' + eWrite)
        }
        return false
    }

    function saveWorldAuthModeToDisk(server) {
        var entry = getOrLoadWorldGrants(server)
        if (!entry.authModeFile) return false
        var payload = buildDefaultAuthModePayload(
            entry.authMode.allowNameGrant === true,
            entry.authMode.updatedBy,
            entry.authMode.updatedAt
        )
        return writeJsonFile(entry.authModeFile, payload)
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
        try {
            if (typeof sourceOrName.isPlayer === 'function' && sourceOrName.isPlayer()) {
                var p = (typeof sourceOrName.getPlayer === 'function') ? sourceOrName.getPlayer() : sourceOrName.player
                var pName = extractPlayerName(p)
                if (pName) return pName
            }
            if (typeof sourceOrName.getTextName === 'function') {
                var tn = sourceOrName.getTextName()
                if (tn != null && String(tn).trim().length > 0) return String(tn).trim()
            }
        } catch (e) { }
        return 'CONSOLE'
    }

    function extractPlayerName(player) {
        return BASE.nameOf(player) || ''
    }

    function extractPlayerUuid(player) {
        return BASE.uuidOf(player) || ''
    }

    function playerHasPermLevel(player, level) {
        return Boolean(player != null && typeof player.hasPermissions === 'function' && player.hasPermissions(level))
    }

    function isWorldCheatsEnabled(server, player) {
        var srv = server || SERVER_REF
        if (srv == null) return playerHasPermLevel(player, 2)
        if ((typeof srv.isDedicatedServer === 'function' && srv.isDedicatedServer())
            || (typeof srv.isDedicated === 'function' && srv.isDedicated())) {
            return true
        }
        var pList = (typeof srv.getPlayerList === 'function') ? srv.getPlayerList() : srv.playerList
        if (pList != null && typeof pList.isAllowCheatsForAllPlayers === 'function' && pList.isAllowCheatsForAllPlayers()) {
            return true
        }
        var wData = (typeof srv.getWorldData === 'function') ? srv.getWorldData() : srv.worldData
        if (wData != null) {
            if (typeof wData.getAllowCommands === 'function') return Boolean(wData.getAllowCommands())
            if (wData.allowCommands !== undefined) return Boolean(wData.allowCommands)
        }
        return playerHasPermLevel(player, 2)
    }

    function isPlayerAdmin(server, player, source, minOpLevel) {
        if (player == null) return false
        var srv   = server || resolveServer(source, player)
        var reqLv = (minOpLevel != null && isFinite(minOpLevel) && minOpLevel > 0) ? Math.round(minOpLevel) : 2
        if (typeof player.isOp === 'function' && player.isOp()) return true
        if (playerHasPermLevel(player, reqLv)) return true
        // 严禁读取 source.hasPermission(reqLv)：Forge/Vanilla 的 CommandSourceStack.withPermission(int)
        // 可在保持 source.source === ServerPlayer 的前提下临时抬高栈 permissionLevel，必须以真实玩家/OP 列表为准。
        if (srv != null) {
            var prof  = (typeof player.getProfile === 'function') ? player.getProfile()
                : ((typeof player.getGameProfile === 'function') ? player.getGameProfile() : player.profile)
            var pList = (typeof srv.getPlayerList === 'function') ? srv.getPlayerList() : srv.playerList
            if (prof != null && pList != null && typeof pList.isOp === 'function' && pList.isOp(prof)) {
                return true
            }
            if (prof != null && typeof srv.isSingleplayerOwner === 'function' && srv.isSingleplayerOwner(prof)) {
                return isWorldCheatsEnabled(srv, player)
            }
        }
        return false
    }

    function isChildScopeRevokedSince(revocationsMap, userKey, chain, parentIdx, grantAtMs) {
        if (!revocationsMap || !userKey) return false
        var rec = revocationsMap[userKey]
        if (!rec) return false
        var gTs = (grantAtMs != null && isFinite(Number(grantAtMs))) ? Number(grantAtMs) : 0
        for (var j = 0; j < parentIdx; j++) {
            var childScope = chain[j]
            var childRev = rec[childScope]
            if (childRev && Number(childRev.revokedAtMs || 0) >= gTs) {
                return true
            }
        }
        return false
    }

    function checkScopeInRecord(rec, targetScope, revocationsMap, userKey, opts) {
        if (rec == null || rec.scopes == null) return false
        var normTarget = normalizeScope(targetScope)
        var exactOnly  = Boolean(opts && opts.exactScopeOnly)
        var allowSubs  = Boolean(opts && opts.allowSubScopes)
        var chain      = buildScopeHierarchy(normTarget)
        var checkOrder = exactOnly
            ? (chain[0] === '*' ? ['*'] : [chain[0], '*'])
            : chain

        for (var i = 0; i < checkOrder.length; i++) {
            var cand = checkOrder[i]
            var meta = rec.scopes[cand]
            if (meta && !isGrantSupersededByRevocation(revocationsMap, userKey, cand, meta.atMs)) {
                var chainIdx = exactOnly ? (cand === '*' ? chain.length - 1 : 0) : i
                if (!isChildScopeRevokedSince(revocationsMap, userKey, chain, chainIdx, meta.atMs)) {
                    return true
                }
            }
        }

        if (allowSubs && normTarget && normTarget !== '*') {
            var prefix = normTarget + '.'
            for (var sc in rec.scopes) {
                if (!Object.prototype.hasOwnProperty.call(rec.scopes, sc)) continue
                var sNorm = normalizeScope(sc)
                if (sNorm.indexOf(prefix) === 0) {
                    var sMeta = rec.scopes[sc]
                    if (sMeta && !isGrantSupersededByRevocation(revocationsMap, userKey, sNorm, sMeta.atMs)) {
                        return true
                    }
                }
            }
        }
        return false
    }

    function migrateNameGrantToUuid(grantsMap, nameKey, uuidKey, currentDisplayName, revocationsMap) {
        if (!nameKey || !uuidKey || !grantsMap || !grantsMap[nameKey]) return false
        var oldRec = grantsMap[nameKey]
        if (oldRec.scopes) {
            if (!grantsMap[uuidKey]) {
                grantsMap[uuidKey] = { keyKind: 'uuid', displayName: currentDisplayName || oldRec.displayName || uuidKey, scopes: {} }
            } else {
                grantsMap[uuidKey].keyKind = 'uuid'
                if (currentDisplayName) grantsMap[uuidKey].displayName = currentDisplayName
            }
            for (var sc in oldRec.scopes) {
                var meta = oldRec.scopes[sc]
                if (!meta) continue
                if (revocationsMap && isGrantSupersededByRevocation(revocationsMap, uuidKey, sc, meta.atMs)) {
                    continue
                }
                if (revocationsMap && isGrantSupersededByRevocation(revocationsMap, nameKey, sc, meta.atMs)) {
                    continue
                }
                if (!grantsMap[uuidKey].scopes[sc]) {
                    grantsMap[uuidKey].scopes[sc] = meta
                }
            }
        }
        delete grantsMap[nameKey]
        return true
    }

    function isPlayerAuthorized(server, player, subCommandName, opts) {
        if (player == null) return false
        var scope = normalizeScope(subCommandName)
        if (isReservedScope(scope)) return false
        var srv        = server || resolveServer(null, player)
        var entry      = getOrLoadWorldGrants(srv)
        var rawName    = extractPlayerName(player)
        var nameKey    = normalizeKey(rawName)
        var uuidKey    = normalizeKey(extractPlayerUuid(player))
        var allowName  = isNameGrantEnabled(entry)

        // 只有明确开启按名字授权备用模式时，才允许从未迁移文本名迁移到首个登录的同名玩家 UUID
        if (allowName && uuidKey && nameKey && entry.grants[nameKey] && !isGrantRecordUuid(entry.grants[nameKey], nameKey)) {
            if (migrateNameGrantToUuid(entry.grants, nameKey, uuidKey, rawName, entry.revocations)) {
                saveWorldGrantsToDisk(srv)
            }
        }

        if (uuidKey && checkScopeInRecord(entry.grants[uuidKey], scope, entry.revocations, uuidKey, opts)) {
            return true
        }
        if (allowName && nameKey && checkScopeInRecord(entry.grants[nameKey], scope, entry.revocations, nameKey, opts)) {
            return true
        }
        return false
    }

    function hasPlayerScope(server, player, scope, opts) {
        return isPlayerAuthorized(server, player, scope, opts)
    }

    function refreshPlayerCommandTree(server, player) {
        if (player == null) return
        var srv = server || resolveServer(null, player)
        if (srv == null) return
        try {
            var pList = (typeof srv.getPlayerList === 'function') ? srv.getPlayerList() : srv.playerList
            if (pList != null && typeof pList.sendPlayerPermissionLevel === 'function') {
                pList.sendPlayerPermissionLevel(player)
                return
            }
            var cmds = (typeof srv.getCommands === 'function') ? srv.getCommands() : srv.commands
            if (cmds != null && typeof cmds.sendCommands === 'function') {
                cmds.sendCommands(player)
            }
        } catch (e) { }
    }

    function refreshAllOnlineCommandTrees(server) {
        var srv = server || SERVER_REF
        if (srv == null) return
        try {
            var pList = (typeof srv.getPlayerList === 'function') ? srv.getPlayerList() : srv.playerList
            if (pList == null || typeof pList.getPlayers !== 'function') return
            var players = BASE.toJsArray(pList.getPlayers())
            for (var i = 0; i < players.length; i++) {
                refreshPlayerCommandTree(srv, players[i])
            }
        } catch (e) { }
    }

    function applyGrantToRecord(grantsMap, key, keyKind, displayName, scope, auditMeta, revocationsMap) {
        if (!key) return
        if (!grantsMap[key]) {
            grantsMap[key] = { keyKind: keyKind, displayName: displayName || key, scopes: {} }
        } else {
            if (keyKind === 'uuid') grantsMap[key].keyKind = 'uuid'
            if (displayName && grantsMap[key].displayName === key) {
                grantsMap[key].displayName = displayName
            }
        }
        var revTs     = getRevocationMs(revocationsMap, key, scope)
        var finalAtMs = (auditMeta.atMs != null && isFinite(auditMeta.atMs)) ? auditMeta.atMs : Date.now()
        var finalAt   = auditMeta.at
        if (revTs > 0 && finalAtMs <= revTs) {
            finalAtMs = revTs + 1
            try { finalAt = new Date(finalAtMs).toISOString() } catch (eIso) { }
        }
        grantsMap[key].scopes[scope] = {
            by:   auditMeta.by,
            at:   finalAt,
            atMs: finalAtMs
        }
    }

    function removeGrantFromRecord(grantsMap, key, scope) {
        if (!key || !grantsMap[key]) return false
        if (scope === '*') {
            delete grantsMap[key]
            return true
        }
        if (grantsMap[key].scopes) {
            var existed = Boolean(grantsMap[key].scopes[scope])
            delete grantsMap[key].scopes[scope]
            var remain = 0
            for (var s in grantsMap[key].scopes) {
                if (grantsMap[key].scopes[s]) remain++
            }
            if (remain === 0) delete grantsMap[key]
            return existed
        }
        return false
    }

    function findOnlinePlayerByName(server, nameStr) {
        if (!server || !nameStr) return null
        try {
            var pList = (typeof server.getPlayerList === 'function') ? server.getPlayerList() : server.playerList
            if (pList == null) return null
            if (typeof pList.getPlayerByName === 'function') {
                return pList.getPlayerByName(String(nameStr).trim())
            }
            if (typeof pList.getPlayers === 'function') {
                var arr = BASE.toJsArray(pList.getPlayers())
                var targetNorm = normalizeKey(nameStr)
                for (var i = 0; i < arr.length; i++) {
                    if (normalizeKey(extractPlayerName(arr[i])) === targetNorm) return arr[i]
                }
            }
        } catch (e) { }
        return null
    }

    function mutatePlayerGrant(server, playerOrName, isGrant, subCommandScope, grantedBySourceOrName) {
        if (playerOrName == null) return false
        var scope = normalizeScope(subCommandScope)
        if (isReservedScope(scope)) {
            logWarn('mutatePlayerGrant', '拒绝修改系统保留作用域 "' + scope + '" 的玩家授权记录。')
            return false
        }
        var srv    = server || (BASE.isObjectLike(playerOrName) ? resolveServer(null, playerOrName) : SERVER_REF)
        var entry  = getOrLoadWorldGrants(srv)
        var nowMs  = Date.now()
        var byLbl  = extractActorLabel(grantedBySourceOrName)
        var auditMeta = isGrant ? {
            by:   byLbl,
            at:   formatTimestampNow(),
            atMs: nowMs
        } : null

        if (BASE.safeTypeOf(playerOrName) === 'string') {
            var rawStr = String(playerOrName).trim()
            var k = normalizeKey(rawStr)
            if (!k) return false
            var strIsUuid = isUuidKeyFormat(k)
            if (isGrant) {
                if (!strIsUuid) {
                    if (!isNameGrantEnabled(entry)) {
                        logWarn('mutatePlayerGrant', '默认严格 UUID 模式下禁止新建按玩家名 "' + rawStr + '" 的授权；请传入在线玩家实体、UUID，或在确认风险后启用 /epiphy auth namegrant enable。')
                        return false
                    }
                    // 若目标当前在线且已有 UUID，直接落在其 UUID 上（仍受 allowNameGrant 控制）
                    var onlineTarget = findOnlinePlayerByName(srv, rawStr)
                    var onlineUuid   = onlineTarget != null ? normalizeKey(extractPlayerUuid(onlineTarget)) : ''
                    if (onlineUuid) {
                        var dispOn = extractPlayerName(onlineTarget) || rawStr
                        applyGrantToRecord(entry.grants, onlineUuid, 'uuid', dispOn, scope, auditMeta, entry.revocations)
                        saveWorldGrantsToDisk(srv)
                        refreshPlayerCommandTree(srv, onlineTarget)
                        return true
                    }
                }
                applyGrantToRecord(entry.grants, k, strIsUuid ? 'uuid' : 'name', rawStr, scope, auditMeta, entry.revocations)
                saveWorldGrantsToDisk(srv)
                return true
            }

            // 撤销不受 allowNameGrant 开关限制（可随时清除已暂停的旧文本名或 UUID 授权）
            recordRevocationTombstone(entry.revocations, k, scope, byLbl, nowMs)
            removeGrantFromRecord(entry.grants, k, scope)
            for (var gk in entry.grants) {
                var greq = entry.grants[gk]
                if (greq != null && greq.displayName && normalizeKey(greq.displayName) === k) {
                    recordRevocationTombstone(entry.revocations, gk, scope, byLbl, nowMs)
                    removeGrantFromRecord(entry.grants, gk, scope)
                }
            }
            var affectedOnline = findOnlinePlayerByName(srv, rawStr)
            if (affectedOnline != null) {
                var affUuid = normalizeKey(extractPlayerUuid(affectedOnline))
                if (affUuid) {
                    recordRevocationTombstone(entry.revocations, affUuid, scope, byLbl, nowMs)
                    removeGrantFromRecord(entry.grants, affUuid, scope)
                }
                refreshPlayerCommandTree(srv, affectedOnline)
            }
            saveWorldRevocationsToDisk(srv)
            saveWorldGrantsToDisk(srv)
            return true
        }

        var rawName = extractPlayerName(playerOrName)
        var pName   = normalizeKey(rawName)
        var pUuid   = normalizeKey(extractPlayerUuid(playerOrName))
        if (isGrant) {
            if (pUuid) {
                if (isNameGrantEnabled(entry) && pName && entry.grants[pName] && !isGrantRecordUuid(entry.grants[pName], pName)) {
                    migrateNameGrantToUuid(entry.grants, pName, pUuid, rawName, entry.revocations)
                }
                applyGrantToRecord(entry.grants, pUuid, 'uuid', rawName || pUuid, scope, auditMeta, entry.revocations)
            } else if (pName) {
                if (!isNameGrantEnabled(entry)) {
                    logWarn('mutatePlayerGrant', '目标玩家缺少 UUID 且当前未开启按名字授权备用模式，已拒绝授权。')
                    return false
                }
                applyGrantToRecord(entry.grants, pName, 'name', rawName, scope, auditMeta, entry.revocations)
            } else {
                return false
            }
            saveWorldGrantsToDisk(srv)
        } else {
            if (pUuid) {
                recordRevocationTombstone(entry.revocations, pUuid, scope, byLbl, nowMs)
                removeGrantFromRecord(entry.grants, pUuid, scope)
            }
            if (pName) {
                recordRevocationTombstone(entry.revocations, pName, scope, byLbl, nowMs)
                removeGrantFromRecord(entry.grants, pName, scope)
            }
            saveWorldRevocationsToDisk(srv)
            saveWorldGrantsToDisk(srv)
        }
        refreshPlayerCommandTree(srv, playerOrName)
        return true
    }

    // 授权玩家并记录审计元数据（谁授权的、何时授权的）
    function grantPlayer(server, playerOrName, subCommandScope, grantedBySourceOrName) {
        return mutatePlayerGrant(server, playerOrName, true, subCommandScope, grantedBySourceOrName)
    }

    function revokePlayer(server, playerOrName, subCommandScope, revokedBySourceOrName) {
        return mutatePlayerGrant(server, playerOrName, false, subCommandScope, revokedBySourceOrName)
    }

    function generateConfirmationCode(len) {
        var digits = '0123456789'
        var upper  = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
        var lower  = 'abcdefghijklmnopqrstuvwxyz'
        var all    = digits + upper + lower
        var targetLen = len || NAMEGRANT_TOKEN_LEN
        function rndInt(max) {
            if (secureRandomInst != null && typeof secureRandomInst.nextInt === 'function') {
                try { return secureRandomInst.nextInt(max) } catch (e) { }
            }
            return Math.floor(Math.random() * max)
        }
        var chars = [
            digits.charAt(rndInt(digits.length)),
            upper.charAt(rndInt(upper.length)),
            lower.charAt(rndInt(lower.length))
        ]
        while (chars.length < targetLen) {
            chars.push(all.charAt(rndInt(all.length)))
        }
        for (var i = chars.length - 1; i > 0; i--) {
            var j = rndInt(i + 1)
            var tmp = chars[i]
            chars[i] = chars[j]
            chars[j] = tmp
        }
        return chars.join('')
    }

    function resolveConfirmationActorKey(source) {
        var cls = classifyCommandSource(source)
        if (cls.kind === 'console') return 'console'
        if (cls.kind === 'player' && cls.player != null) {
            var u = normalizeKey(extractPlayerUuid(cls.player))
            if (u) return 'player:' + u
            var n = normalizeKey(extractPlayerName(cls.player))
            if (n) return 'playername:' + n
        }
        return ''
    }

    function isRealAdminOrConsoleSource(source) {
        if (source == null) return { ok: false, reason: '缺少调用源' }
        var cls = classifyCommandSource(source)
        if (cls.kind === 'console') return { ok: true, kind: 'console', player: null }
        if (cls.kind === 'player' && cls.player != null) {
            var srv = resolveServer(source, cls.player)
            if (!isWorldCheatsEnabled(srv, cls.player)) {
                return { ok: false, reason: '当前存档未开启作弊' }
            }
            if (!isPlayerAdmin(srv, cls.player, source, 2)) {
                return { ok: false, reason: '仅真实管理员 (OP) 或控制台可执行该高危开关操作' }
            }
            return { ok: true, kind: 'player', player: cls.player }
        }
        return { ok: false, reason: '命令方块、脚本代调及普通已授权玩家禁止修改按名字授权模式' }
    }

    function requestNameGrantEnable(source) {
        var gate = isRealAdminOrConsoleSource(source)
        if (!gate.ok) return { ok: false, error: gate.reason }
        var srv   = resolveServer(source, gate.player)
        var entry = getOrLoadWorldGrants(srv)
        if (isNameGrantEnabled(entry)) {
            return { ok: false, alreadyEnabled: true, error: '当前世界已处于“按名字授权备用模式”开启状态。' }
        }
        var actorKey = resolveConfirmationActorKey(source) || 'console'
        var nowMs    = Date.now()
        var code     = generateConfirmationCode(NAMEGRANT_TOKEN_LEN)
        var tokenKey = entry.worldKey + '|' + actorKey
        pendingNameGrantTokens[tokenKey] = {
            worldKey:    entry.worldKey,
            actorKey:    actorKey,
            code:        code,
            createdAtMs: nowMs,
            expiresAtMs: nowMs + NAMEGRANT_TOKEN_TTL_MS
        }
        return {
            ok:          true,
            code:        code,
            ttlSeconds:  Math.round(NAMEGRANT_TOKEN_TTL_MS / 1000),
            authModeFile: entry.authModeFile
        }
    }

    function confirmNameGrantEnable(source, inputCode) {
        var gate = isRealAdminOrConsoleSource(source)
        if (!gate.ok) return { ok: false, error: gate.reason }
        var srv      = resolveServer(source, gate.player)
        var entry    = getOrLoadWorldGrants(srv)
        var actorKey = resolveConfirmationActorKey(source) || 'console'
        var tokenKey = entry.worldKey + '|' + actorKey
        var pending  = pendingNameGrantTokens[tokenKey]
        if (!pending) {
            return { ok: false, error: '没有待确认的开启请求，请先执行 /epiphy auth namegrant enable。' }
        }
        var nowMs = Date.now()
        if (nowMs > pending.expiresAtMs) {
            delete pendingNameGrantTokens[tokenKey]
            return { ok: false, expired: true, error: '确认口令已超过 2 分钟有效期，请重新执行 /epiphy auth namegrant enable 获取新口令。' }
        }
        var cleanCode = inputCode != null ? String(inputCode).trim() : ''
        if (cleanCode !== pending.code) {
            return { ok: false, mismatch: true, error: '确认口令不匹配，请检查大小写后重试（原口令仍在有效期内）。' }
        }
        delete pendingNameGrantTokens[tokenKey]
        entry.authMode.allowNameGrant = true
        entry.authMode.updatedBy = extractActorLabel(source)
        entry.authMode.updatedAt = formatTimestampNow()
        saveWorldAuthModeToDisk(srv)

        // 开启后为当前在线且有待迁移文本名授权的玩家立即迁移并刷新指令树
        var migrated = 0
        try {
            var pList = srv != null ? ((typeof srv.getPlayerList === 'function') ? srv.getPlayerList() : srv.playerList) : null
            if (pList != null && typeof pList.getPlayers === 'function') {
                var online = BASE.toJsArray(pList.getPlayers())
                for (var i = 0; i < online.length; i++) {
                    var op = online[i]
                    var rn = extractPlayerName(op)
                    var nk = normalizeKey(rn)
                    var uk = normalizeKey(extractPlayerUuid(op))
                    if (uk && nk && entry.grants[nk] && !isGrantRecordUuid(entry.grants[nk], nk)) {
                        if (migrateNameGrantToUuid(entry.grants, nk, uk, rn, entry.revocations)) migrated++
                    }
                }
            }
        } catch (eMig) { }
        if (migrated > 0) saveWorldGrantsToDisk(srv)
        refreshAllOnlineCommandTrees(srv)
        logWarn('nameGrantEnable', entry.authMode.updatedBy + ' 已通过 8 位二次确认启用按名字授权备用模式（世界 ' + entry.worldKey + '，立即迁移在线待生效记录 ' + migrated + ' 条）。')
        return { ok: true, migratedCount: migrated, authModeFile: entry.authModeFile }
    }

    function disableNameGrantMode(source) {
        var gate = isRealAdminOrConsoleSource(source)
        if (!gate.ok) return { ok: false, error: gate.reason }
        var srv   = resolveServer(source, gate.player)
        var entry = getOrLoadWorldGrants(srv)
        var actorKey = resolveConfirmationActorKey(source) || 'console'
        delete pendingNameGrantTokens[entry.worldKey + '|' + actorKey]
        var pausedCount = 0
        for (var k in entry.grants) {
            if (!isGrantRecordUuid(entry.grants[k], k)) pausedCount++
        }
        entry.authMode.allowNameGrant = false
        entry.authMode.updatedBy = extractActorLabel(source)
        entry.authMode.updatedAt = formatTimestampNow()
        saveWorldAuthModeToDisk(srv)
        refreshAllOnlineCommandTrees(srv)
        logWarn('nameGrantDisable', entry.authMode.updatedBy + ' 已关闭按名字授权备用模式（回退默认严格 UUID 模式，保留 ' + pausedCount + ' 条未迁移文本名记录为暂停状态）。')
        return { ok: true, pausedCount: pausedCount, authModeFile: entry.authModeFile }
    }

    function reloadWorldAuthFromDisk(server) {
        var srv = server || SERVER_REF
        if (typeof BASE.clearEpiphyWorldContextCache === 'function') {
            BASE.clearEpiphyWorldContextCache()
        }
        var info = resolveWorldStorageInfo(srv)
        delete worldAuthStore[info.worldKey]
        var reloaded = getOrLoadWorldGrants(srv)
        refreshAllOnlineCommandTrees(srv)
        return reloaded
    }

    function listGrantedEntries(server) {
        var entry     = getOrLoadWorldGrants(server)
        var allowName = isNameGrantEnabled(entry)
        var out       = []
        for (var k in entry.grants) {
            var rec = entry.grants[k]
            if (!rec || !rec.scopes) continue
            var isUuid = isGrantRecordUuid(rec, k)
            var items  = []
            for (var sc in rec.scopes) {
                var meta = rec.scopes[sc]
                if (meta && !isGrantSupersededByRevocation(entry.revocations, k, sc, meta.atMs)) {
                    items.push(sc + ' (by ' + (meta.by || 'unknown') + ' @ ' + (meta.at || 'unknown') + ')')
                }
            }
            if (items.length > 0) {
                var label = (rec.displayName && normalizeKey(rec.displayName) !== k)
                    ? (rec.displayName + '/' + k)
                    : (rec.displayName || k)
                var statusBadge = (!isUuid && !allowName) ? ' §8[按名记录-已暂停]' : ''
                out.push(label + statusBadge + ' -> [' + items.join(', ') + ']')
            }
        }
        return out
    }

    // 显式注册受信任脚本调用方及其允许调用的子命令列表：
    //   严禁省略 allowedScopes 默认给 '*'！调用方必须明确传入非空的子命令名称数组（如 ['danmaku']），且禁止声明 'auth'。
    function isSameJavaRef(a, b) {
        if (a == null || b == null) return false
        if (a === b) return true
        try {
            if (typeof a.equals === 'function' && Boolean(a.equals(b))) return true
        } catch (eEq) { }
        return false
    }

    function looksLikeUnsafeRunner(runnerObj) {
        if (runnerObj == null) return true
        if (ServerPlayerClass != null && isJavaInstance(ServerPlayerClass, runnerObj)) return true
        if (typeof runnerObj.getUuid === 'function' && typeof runnerObj.hasPermissions === 'function') return true
        if (BaseCommandBlockClass != null && isJavaInstance(BaseCommandBlockClass, runnerObj)) return true
        try {
            var rawInner = runnerObj.source !== undefined ? runnerObj.source : null
            if (rawInner != null) {
                if (ServerPlayerClass != null && isJavaInstance(ServerPlayerClass, rawInner)) return true
                if (BaseCommandBlockClass != null && isJavaInstance(BaseCommandBlockClass, rawInner)) return true
            }
            if (typeof runnerObj.isPlayer === 'function' && Boolean(runnerObj.isPlayer())) return true
            var innerP = (typeof runnerObj.getPlayer === 'function') ? runnerObj.getPlayer() : runnerObj.player
            if (innerP != null && typeof innerP !== 'boolean') return true
        } catch (eChk) { }
        return false
    }

    function resolveDeclarationToken(tokenObj, apiName) {
        if (tokenObj == null || typeof tokenObj !== 'object' || tokenObj.__isEpiphyDeclToken !== true) {
            logWarn(apiName || 'declaration', '必须传入 declareCaller(...) 返回的能力令牌对象，禁止传入字符串或伪造声明对象。')
            return null
        }
        var id = normalizeKey(tokenObj.callerId)
        if (!id || !registeredCallers[id] || callerTokensById[id] !== tokenObj) {
            logWarn(apiName || 'declaration', '声明令牌校验失败（未注册或非原始授权令牌）: "' + String(tokenObj.callerId) + '"。')
            return null
        }
        return id
    }

    function resolveFrameScopes(allowedScopeSet, targetScopes) {
        if (allowedScopeSet == null) return null
        var copy  = {}
        var count = 0
        if (targetScopes == null) {
            for (var k in allowedScopeSet) {
                if (allowedScopeSet[k] && !isReservedScope(k)) {
                    copy[k] = true
                    count++
                }
            }
            return count > 0 ? copy : null
        }
        var reqList = Array.isArray(targetScopes)
            ? targetScopes
            : (typeof targetScopes === 'string' && targetScopes.trim().length > 0 ? [targetScopes] : [])
        for (var i = 0; i < reqList.length; i++) {
            var sc = normalizeScope(reqList[i])
            if (sc && !isReservedScope(sc) && scopeMatchesSet(allowedScopeSet, sc, false)) {
                copy[sc] = true
                count++
            }
        }
        return count > 0 ? copy : null
    }

    function parseDeclaredCommandTarget(commandStr) {
        if (typeof commandStr !== 'string') return null
        if (/[\r\n\0]/.test(commandStr)) return null
        var trimmed = String(commandStr).replace(/^\s+|\s+$/g, '')
        if (!trimmed) return null
        var cmd = trimmed.replace(/^\/+/, '')
        var re  = new RegExp('^' + ROOT_LITERAL + '\\s+([A-Za-z0-9_:-]+)(?:\\s|$)')
        var m   = re.exec(cmd)
        if (!m) return null
        var subcmd = normalizeKey(m[1])
        if (!subcmd || RESERVED_SUBCOMMANDS[subcmd]) return null
        return {
            cmd:    cmd,
            subcmd: subcmd
        }
    }

    function declareCaller(callerId, allowedScopes) {
        var id = normalizeKey(callerId)
        if (!id) return null
        if (registeredCallers[id]) {
            logWarn('declareCaller', '调用方 "' + id + '" 已注册，出于 write-once 安全策略禁止重复注册或扩容权限作用域。')
            return null
        }
        var list = Array.isArray(allowedScopes)
            ? allowedScopes
            : (typeof allowedScopes === 'string' && allowedScopes.trim().length > 0 ? [allowedScopes] : [])
        var scopeSet = {}
        var count    = 0
        for (var i = 0; i < list.length; i++) {
            var sc = normalizeScope(list[i])
            if (sc && sc !== '*' && sc !== 'all' && !isReservedScope(sc)) {
                scopeSet[sc] = true
                count++
            }
        }
        if (count === 0) {
            logWarn('declareCaller', 'declareCaller("' + id + '") 必须显式指定具体合法子命令白名单（如 ["danmaku"]），不支持空列表、保留名或 "*"。')
            return null
        }
        var token = Object.freeze({
            __isEpiphyDeclToken: true,
            callerId:            id
        })
        registeredCallers[id] = scopeSet
        callerTokensById[id]  = token
        return token
    }

    function withDeclaration(callerToken, fn, targetScopes) {
        var id = resolveDeclarationToken(callerToken, 'withDeclaration')
        if (!id || typeof fn !== 'function') return null
        var frameScopes = resolveFrameScopes(registeredCallers[id], targetScopes)
        if (!frameScopes) {
            logWarn('withDeclaration', '调用方 "' + id + '" 请求的作用域未在已注册白名单内，withDeclaration 已拒绝。')
            return null
        }
        declarationStack.push({
            callerId:        id,
            effectiveScopes: frameScopes,
            runner:          null,
            maxDispatches:   0,
            dispatchesUsed:  0
        })
        try {
            return fn()
        } finally {
            declarationStack.pop()
        }
    }

    // 显式绑定调用方能力令牌，供跨 Tick 调度或异步回调安全使用（支持 targetScopes 收窄）
    function bindDeclaration(callerToken, fn, targetScopes) {
        var id = resolveDeclarationToken(callerToken, 'bindDeclaration')
        if (!id || typeof fn !== 'function') {
            return function () { return null }
        }
        var frameScopes = resolveFrameScopes(registeredCallers[id], targetScopes)
        if (!frameScopes) {
            logWarn('bindDeclaration', '调用方 "' + id + '" 请求的作用域未在已注册白名单内，bindDeclaration 已拒绝。')
            return function () { return null }
        }
        return function () {
            var args = arguments
            return withDeclaration(callerToken, function () {
                return fn.apply(null, args)
            }, targetScopes)
        }
    }

    function runDeclaredCommand(runnerObj, callerToken, commandStr, silent) {
        var id = resolveDeclarationToken(callerToken, 'runDeclaredCommand')
        if (!id) return 0
        if (runnerObj == null || !commandStr) return 0
        if (looksLikeUnsafeRunner(runnerObj)) {
            logWarn('runDeclaredCommand', '出于安全边界禁止将玩家、玩家命令栈或命令方块作为 runDeclaredCommand 的提权执行代理，已拦截。')
            return 0
        }
        var parsed = parseDeclaredCommandTarget(commandStr)
        if (!parsed) {
            logWarn('runDeclaredCommand', '出于最小权限约束，runDeclaredCommand 仅允许执行单条 /' + ROOT_LITERAL + ' <合法子命令> ... 指令，已拦截。')
            return 0
        }
        var allowedSet = registeredCallers[id]
        if (!allowedSet || !allowedSet[parsed.subcmd]) {
            logWarn('runDeclaredCommand', '调用方 "' + id + '" 未获准调用子命令 /' + ROOT_LITERAL + ' ' + parsed.subcmd + '，runDeclaredCommand 已拒绝。')
            return 0
        }
        for (var fi = 0; fi < declarationStack.length; fi++) {
            var outerFrame = declarationStack[fi]
            if (!outerFrame || !outerFrame.effectiveScopes || !outerFrame.effectiveScopes[parsed.subcmd]) {
                logWarn('runDeclaredCommand', '外层声明上下文 "' + (outerFrame && outerFrame.callerId) + '" 不允许调用 /' + ROOT_LITERAL + ' ' + parsed.subcmd + '，已阻止。')
                return 0
            }
            if (outerFrame.maxDispatches > 0 && outerFrame.dispatchesUsed >= outerFrame.maxDispatches) {
                logWarn('runDeclaredCommand', '外层单次声明配额已耗尽，禁止嵌套链式派发。')
                return 0
            }
        }
        var singleScope = {}
        singleScope[parsed.subcmd] = true
        declarationStack.push({
            callerId:        id,
            effectiveScopes: singleScope,
            runner:          runnerObj,
            maxDispatches:   1,
            dispatchesUsed:  0
        })
        try {
            var res = null
            if (silent !== false && typeof runnerObj.runCommandSilent === 'function') {
                res = runnerObj.runCommandSilent(parsed.cmd)
            } else if (typeof runnerObj.runCommand === 'function') {
                res = runnerObj.runCommand(parsed.cmd)
            } else {
                res = 0
            }
            return res != null ? res : 0
        } finally {
            declarationStack.pop()
        }
    }

    // 严格通过 Java Class.isInstance 识别 CommandSourceStack 的底层数据类型（彻底移除类名字符串 indexOf 模糊匹配）
    // 注意信任优先级：必须先校验玩家 / 命令方块，绝不允许玩家来源借助 declarationStack 绕过玩家权限校验。
    function classifyCommandSource(source) {
        if (source == null) {
            return { kind: 'untrusted_other', player: null, rawSource: null, className: 'null' }
        }

        var rawSource = source.source !== undefined ? source.source : null
        var rawCls    = (rawSource != null && typeof rawSource.getClass === 'function')
            ? String(rawSource.getClass().getName()) : ''

        // 1. 优先严格验证是否为真实玩家直接执行（最不可信物理源优先拦截，防提权伪装）：
        //    注意：CommandSourceStack.getPlayer() 返回的是 ServerPlayer，但 Rhino 可能会对其中一个包装一层 NativeJavaObject / KubeJS 代理，
        //    导致 rawSource === player 引用不相等；因此同时支持 Java Object.equals() 与 UUID 相等比对，并配合 ServerPlayerClass.isInstance 校验。
        var player = null
        try {
            var isPl = (typeof source.isPlayer === 'function') ? Boolean(source.isPlayer()) : true
            if (isPl) {
                var pCand = (typeof source.getPlayer === 'function') ? source.getPlayer() : source.player
                if (pCand != null && typeof pCand !== 'boolean') player = pCand
            }
        } catch (ePl) { player = null }

        if (player != null) {
            var isRealPlayerSource = false
            if (rawSource != null) {
                var sameEntity = (rawSource === player)
                if (!sameEntity && typeof rawSource.equals === 'function') {
                    try { sameEntity = Boolean(rawSource.equals(player)) } catch (eEq) { }
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

        // 3. 在排除玩家与命令方块后，检查当前调用栈是否处于已注册白名单的 withDeclaration / runDeclaredCommand 块内；
        //    严禁在无控制台载体、且未命中绑定 runner 时仅凭 declarationStack 将任意 untrusted_other（如 CommandSource.NULL / {}）静默提权。
        var consoleCarrierCls = classifyConsoleRawSource(rawSource, rawCls)
        if (declarationStack.length > 0) {
            var topFrame = declarationStack[declarationStack.length - 1]
            if (topFrame && topFrame.callerId && registeredCallers[topFrame.callerId]) {
                var hasPinnedRunner = false
                var pinnedRunnerOk  = true
                for (var fi = 0; fi < declarationStack.length; fi++) {
                    var f = declarationStack[fi]
                    if (f && f.runner != null) {
                        hasPinnedRunner = true
                        var matchesF = isSameJavaRef(rawSource, f.runner) || isSameJavaRef(source, f.runner)
                        if (!matchesF && consoleCarrierCls == null) {
                            pinnedRunnerOk = false
                            break
                        }
                    }
                }
                var allowDeclaredCarrier = hasPinnedRunner ? pinnedRunnerOk : (consoleCarrierCls != null)
                if (allowDeclaredCarrier) {
                    return {
                        kind:             'declared_function',
                        callerId:         topFrame.callerId,
                        player:           null,
                        rawSource:        rawSource,
                        isConsoleCarrier: consoleCarrierCls != null,
                        className:        'Declared:' + topFrame.callerId
                    }
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
    function evaluateSourceAccessCore(source, subCommandName, policyOverride, consumeDispatch) {
        if (source == null) {
            return { allowed: false, reason: '无效的指令执行源。' }
        }
        var subKey  = normalizeKey(subCommandName)
        var subSpec = getRegisteredSubcommand(subKey)
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

        // 分支 2：已声明的内部函数调用 (declared_function) -> 逐帧校验全栈调用方权限交集、策略白名单、控制台策略及单次派发配额
        if (srcInfo.kind === 'declared_function') {
            var effScope = normalizeScope((policy.scope && policy.scope !== '*') ? policy.scope : subKey)
            if (!subKey || isReservedScope(effScope) || policy.allowDeclaredCallers === false) {
                return { allowed: false, reason: '子命令 /epiphy ' + subKey + ' 禁止通过脚本声明代调。' }
            }
            if (srcInfo.isConsoleCarrier) {
                var declaredConsoleDeny = checkConsoleCarrierPermission(source, subKey, policy, true)
                if (declaredConsoleDeny) return declaredConsoleDeny
            }
            if (declarationStack.length === 0) {
                return { allowed: false, reason: '缺少有效的声明调用栈上下文。' }
            }
            for (var si = 0; si < declarationStack.length; si++) {
                var frame             = declarationStack[si]
                var fCallerId         = frame != null ? frame.callerId : ''
                var fRegisteredScopes = fCallerId ? registeredCallers[fCallerId] : null
                var fEffectiveScopes  = frame != null ? frame.effectiveScopes : null
                if (!fCallerId || !scopeMatchesSet(fRegisteredScopes, effScope, policy.exactScopeOnly) || !scopeMatchesSet(fEffectiveScopes, effScope, policy.exactScopeOnly)) {
                    return { allowed: false, reason: '调用方 "' + (fCallerId || 'unknown') + '" 未获准调用作用域 [' + effScope + ']。' }
                }
                if (policy.allowedCallers != null && !policy.allowedCallers[fCallerId]) {
                    return { allowed: false, reason: '子命令 /epiphy ' + subKey + ' 的白名单未包含调用方 "' + fCallerId + '"。' }
                }
                if (frame.maxDispatches > 0 && frame.dispatchesUsed >= frame.maxDispatches) {
                    return { allowed: false, reason: '声明调用 ("' + fCallerId + '") 的单次指令配额已耗尽，禁止二次/链式派发。' }
                }
            }
            if (consumeDispatch !== false) {
                for (var ci = 0; ci < declarationStack.length; ci++) {
                    var cFrame = declarationStack[ci]
                    if (cFrame && cFrame.maxDispatches > 0) {
                        cFrame.dispatchesUsed++
                    }
                }
            }
            return { allowed: true, sourceKind: 'declared_function', callerId: srcInfo.callerId, player: null }
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
            var playerScope = normalizeScope((policy.scope && policy.scope !== '*') ? policy.scope : subKey)

            if (typeof policy.customCheck === 'function') {
                try {
                    var customRes = policy.customCheck({
                        source:     source,
                        player:     player,
                        server:     server,
                        subcommand: subKey,
                        scope:      playerScope,
                        valve:      valveApi
                    })
                    if (customRes === true) return { allowed: true, sourceKind: 'player', player: player }
                    if (typeof customRes === 'string') return { allowed: false, player: player, reason: customRes }
                    if (customRes && typeof customRes === 'object') return customRes
                    return { allowed: false, player: player, reason: '未通过作用域 [' + playerScope + '] 的自定义权限校验。' }
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
                var isAuth  = policy.allowAuthorized && isPlayerAuthorized(server, player, playerScope, {
                    exactScopeOnly: policy.exactScopeOnly,
                    allowSubScopes: policy.allowSubScopes
                })
                if (!isAdmin && !isAuth) {
                    var reqDesc = policy.allowAuthorized ? '管理员 (OP) 或已被授权作用域 [' + playerScope + '] 的对象' : '管理员 (OP)'
                    return {
                        allowed: false,
                        player:  player,
                        reason:  '权限不足：需要【' + reqDesc + '】方可执行。'
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

    function evaluateSourceAccess(source, subCommandName, policyOverride) {
        return evaluateSourceAccessCore(source, subCommandName, policyOverride, true)
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
            var res = evaluateSourceAccessCore(source, subCommandName, policyOverride, false)
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

    function normalizeDeclaredScopes(name, rawScopes) {
        var out = []
        if (!Array.isArray(rawScopes)) return out
        for (var i = 0; i < rawScopes.length; i++) {
            var it = rawScopes[i]
            if (it == null) continue
            if (typeof it === 'string') {
                var scStr = normalizeScope(it)
                if (scStr && scStr !== '*') out.push({ scope: scStr, desc: '' })
            } else if (typeof it === 'object' && it.scope) {
                var scObj = normalizeScope(it.scope)
                if (scObj && scObj !== '*') out.push({ scope: scObj, desc: it.desc ? String(it.desc) : '' })
            }
        }
        return out
    }

    function registerSubcommand(spec) {
        if (spec == null || !spec.name) return false
        var name = normalizeKey(spec.name)
        if (!name) return false
        if (isForbiddenSubcommandKey(name)) {
            logWarn('registerSubcommand', '拒绝使用原型保留键名注册子命令: "' + name + '"。')
            return false
        }
        if (RESERVED_SUBCOMMANDS[name]) {
            logWarn('registerSubcommand', '拒绝注册保留子命令名 "/' + ROOT_LITERAL + ' ' + name + '"。')
            return false
        }
        if (spec.auth !== undefined) {
            logWarn('registerSubcommand', '子命令 /' + ROOT_LITERAL + ' ' + name + ' 使用了已废弃的 spec.auth 字段，已忽略；请改用 spec.permission。')
        }
        var rawPerm = spec.permission !== undefined ? spec.permission : spec.policy
        if (rawPerm == null) {
            logWarn('registerSubcommand', '子命令 /' + ROOT_LITERAL + ' ' + name + ' 未声明 permission，已按最小权限原则默认设为 admin (仅 OP)。')
        }
        var policy = normalizePermissionPolicy(rawPerm, POLICY_PRESETS.admin)

        if (!Object.prototype.hasOwnProperty.call(subcommands, name)) {
            subcmdOrder.push(name)
        }
        subcommands[name] = {
            name:      name,
            policy:    policy,
            summary:   spec.summary ? String(spec.summary) : ('/epiphy ' + name + ' 子命令'),
            helpLines: spec.helpLines || [],
            scopes:    normalizeDeclaredScopes(name, spec.scopes),
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

    function makeModuleRootPolicy(policy) {
        var copy = clonePolicy(policy || POLICY_PRESETS.admin)
        copy.allowSubScopes = true
        return copy
    }

    function sendAggregatedHelp(source, targetSubName) {
        if (targetSubName) {
            var key = normalizeKey(targetSubName)
            if (key === 'auth' || key === 'core' || key === 'valve') {
                sendSourceMessage(source, '§3§l----------------------------------------------------')
                sendSourceMessage(source, '§b§l  [ Epiphy 权限阀核心 // /epiphy auth 帮助手册 ]')
                sendSourceMessage(source, '§3§l----------------------------------------------------')
                sendSourceMessage(source, '§e1. 查看状态与作用域：   §f/epiphy auth list | scopes [模块] | where | reload')
                sendSourceMessage(source, '§e2. 授予玩家全部权限：   §f/epiphy auth grant <玩家> §7(默认按在线 UUID)')
                sendSourceMessage(source, '§e3. 授予模块/子命令权：  §f/epiphy auth grant <玩家> <作用域(如 danmaku 或 danmaku.self)>')
                sendSourceMessage(source, '§e4. 撤销玩家全部/细分权： §f/epiphy auth revoke <玩家> [作用域] §7(同步写外置撤销墓碑)')
                sendSourceMessage(source, '§e5. 按名字授权备用模式： §f/epiphy auth namegrant <status|enable|confirm <code>|disable> §7(仅真OP/控制台)')
                sendSourceMessage(source, '§e6. 文本名/离线授权操作： §f/epiphy auth grantname <名> [作用域] | /epiphy auth revokename <名> [作用域]')
                sendSourceMessage(source, '§3§l----------------------------------------------------')
                return 1
            }
            var target = getRegisteredSubcommand(key)
            if (target == null) {
                sendSourceMessage(source, '§c[Epiphy 指令中心] 未找到名为 [' + key + '] 的子模块。输入 §f/epiphy help §c查看已加载模块列表。')
                return 0
            }
            var access = evaluateSourceAccessCore(source, key, makeModuleRootPolicy(target.policy), false)
            var statusTag = access.allowed ? '§a[已就绪/可执行]' : ('§c[受限: ' + access.reason + ']')
            sendSourceMessage(source, '§e• 模块 [' + target.name + '] ' + statusTag + ' §7(权限策略: §b' + target.policy.label + '§7)')
            var detailLines = resolveSubcommandHelpLines(target)
            for (var d = 0; d < detailLines.length; d++) {
                sendSourceMessage(source, detailLines[d])
            }
            return 1
        }

        var authAccess = evaluateSourceAccessCore(source, 'auth', POLICY_PRESETS.admin, false)
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

        // 总览有意向所有玩家展示已加载模块与当前授权状态徽标，方便发现功能；真实指令树仍受 .requires 严格隐藏。
        sendSourceMessage(source, '§6【已挂载业务插件 (' + subcmdOrder.length + ')】：')
        if (subcmdOrder.length === 0) {
            sendSourceMessage(source, '§7  （当前暂无已注册的业务子模块）')
        } else {
            for (var s = 0; s < subcmdOrder.length; s++) {
                var sName = subcmdOrder[s]
                var entry = getRegisteredSubcommand(sName)
                if (entry == null) continue
                var subAccess = evaluateSourceAccessCore(source, sName, makeModuleRootPolicy(entry.policy), false)
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
            var subSub = tokens.length >= 3 ? normalizeKey(tokens[2]) : ''
            var polUse = (subSub === 'namegrant') ? POLICY_PRESETS.strict_op : POLICY_PRESETS.admin
            if (!canSeeSubcommand(source, 'auth', polUse)) {
                checkSourceOrReject(source, 'auth', polUse)
                return true
            }
            return false
        }

        var targetSpec = getRegisteredSubcommand(headWord)
        if (targetSpec != null) {
            var rootCheckPolicy = makeModuleRootPolicy(targetSpec.policy)
            if (!canSeeSubcommand(source, headWord, rootCheckPolicy)) {
                checkSourceOrReject(source, headWord, rootCheckPolicy)
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

    // 资源分级定位说明（仅划分 'system' 与 'player' 两级配额/隔离池）：
    //   - 普通非 OP 玩家划入 'player'（由业务组件套用命名空间隔离与频次/目标数限制）；
    //   - 真 OP、控制台、命令方块及经 evaluateSourceAccessCore 校验的声明函数调用均属系统权威调度，统一归入 'system'（细粒度来源权限已在入栈评估层判定）。
    function getCommandActorTier(source) {
        if (source == null) {
            return { tier: 'system', isPlayer: false, isOp: true, uuid: '', name: '', player: null }
        }
        var cls = classifyCommandSource(source)
        if (cls.kind === 'player' && cls.player != null) {
            var srv = resolveServer(source, cls.player)
            var op  = isPlayerAdmin(srv, cls.player, source, 2)
            return {
                tier:     op ? 'system' : 'player',
                isPlayer: true,
                isOp:     op,
                uuid:     normalizeKey(extractPlayerUuid(cls.player)),
                name:     extractPlayerName(cls.player),
                player:   cls.player
            }
        }
        return { tier: 'system', isPlayer: false, isOp: true, uuid: '', name: '', player: null }
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
        getCommandActorTier:       getCommandActorTier,
        evaluateSourceAccess:      evaluateSourceAccess,
        checkSourceOrReject:       checkSourceOrReject,
        canSeeSubcommand:          canSeeSubcommand,
        guardExecution:            guardExecution,
        grantPlayer:               grantPlayer,
        revokePlayer:              revokePlayer,
        isPlayerAuthorized:        isPlayerAuthorized,
        hasPlayerScope:            hasPlayerScope,
        normalizeScope:            normalizeScope,
        isPlayerAdmin:             isPlayerAdmin,
        isWorldCheatsEnabled:      isWorldCheatsEnabled,
        requestNameGrantEnable:    requestNameGrantEnable,
        confirmNameGrantEnable:    confirmNameGrantEnable,
        disableNameGrantMode:      disableNameGrantMode,
        reloadWorldAuthFromDisk:   reloadWorldAuthFromDisk,
        isNameGrantEnabled:        function (srv) { return isNameGrantEnabled(getOrLoadWorldGrants(srv)) },
        resolveWorldStorageInfo:   resolveWorldStorageInfo,
        sendHelp:                  sendAggregatedHelp,
        getStats:                  getStats
    }

    try {
        PlayerEvents.loggedIn(function (event) {
            try {
                var p = event != null ? event.player : null
                if (p == null) return
                var srv     = resolveServer(null, p)
                var entry   = getOrLoadWorldGrants(srv)
                var rawName = extractPlayerName(p)
                var nameKey = normalizeKey(rawName)
                var uuidKey = normalizeKey(extractPlayerUuid(p))

                if (isPlayerAdmin(srv, p, null, 2)) {
                    var notices = (typeof BASE.consumePendingWorldForkNotices === 'function')
                        ? BASE.consumePendingWorldForkNotices()
                        : []
                    if (notices.length === 0 && entry.ctxInfo != null && entry.ctxInfo.forkNotice != null && !forkNotifiedWorlds[entry.worldKey]) {
                        notices = [entry.ctxInfo.forkNotice]
                    }
                    if (notices.length > 0) {
                        forkNotifiedWorlds[entry.worldKey] = true
                        for (var ni = 0; ni < notices.length; ni++) {
                            var fn = notices[ni]
                            try {
                                p.tell(Text.of('§e[Epiphy 数据分叉提示] 检测到当前存档路径已变更，已为新目录自动分叉独立数据：§f' + fn.newFolder))
                                p.tell(Text.of('§7  原数据保留于 §8' + fn.oldFolder + ' §7（原路径: ' + fn.oldPath + '）；如需清理可自行进入对应文件夹删除。'))
                            } catch (eTell) { }
                        }
                    }
                }

                if (!uuidKey) return
                var changed = false
                if (isNameGrantEnabled(entry) && nameKey && entry.grants[nameKey] && !isGrantRecordUuid(entry.grants[nameKey], nameKey)) {
                    changed = migrateNameGrantToUuid(entry.grants, nameKey, uuidKey, rawName, entry.revocations)
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

    function handleAuthScopeCommand(source, playersArr, isGrant, rawScope) {
        var srv     = resolveServer(source, source.player)
        var scope   = normalizeScope(rawScope)
        if (isReservedScope(scope)) {
            sendSourceMessage(source, '§c[Epiphy 权限阀] "' + scope + '" 为系统保留子命令，禁止通过 /epiphy auth 授权或撤销。')
            return 0
        }
        var cnt     = 0
        for (var i = 0; i < playersArr.length; i++) {
            var ok = isGrant
                ? grantPlayer(srv, playersArr[i], scope, source)
                : revokePlayer(srv, playersArr[i], scope, source)
            if (ok) cnt++
        }
        var targetLabel = (scope === '*') ? '全部 /epiphy 子命令权限 (*)' : ('[/epiphy ' + scope + '] 权限')
        var msg = isGrant
            ? ('§a[Epiphy 权限阀] 已按 UUID 授予 ' + cnt + ' 名在线玩家' + targetLabel + '并记录审计信息。')
            : ('§e[Epiphy 权限阀] 已撤销 ' + cnt + ' 名玩家的' + targetLabel + '并写入外部撤销墓碑。')
        sendSourceMessage(source, msg)
        return cnt
    }

    function sendNameGrantRiskSummary(source, entry) {
        var enabled = isNameGrantEnabled(entry)
        sendSourceMessage(source, '§b[Epiphy 按名授权备用模式] §7当前状态: ' + (enabled ? '§e已开启 (uuid_with_name_fallback)' : '§a已关闭 (默认严格 uuid_only)') +
            ' §8(最后修改: ' + (entry.authMode.updatedBy || 'SYSTEM') + ' @ ' + (entry.authMode.updatedAt || 'unknown') + ')')
        sendSourceMessage(source, '§7  • §e风险提示§7: 开启后允许按玩家文本名预授权并在首次登录时迁入 UUID；在无登录密码插件的服务器中，首个以该名字上线者将永久继承该权限。')
        sendSourceMessage(source, '§7  • §a密码插件说明§7: 若已安装并强制 AuthMe / EasyAuth 等“未登录禁指令”的密码验证插件，则按名冒领风险可忽略。')
        sendSourceMessage(source, '§7  • §c纯离线服补充警告§7: 若服务器为 online-mode=false 且既无 TrueUUID 类 UUID 修复、也无登录密码插件，则即使维持默认 UUID 模式也不安全。')
        sendSourceMessage(source, '§7  • 配置文件: §8' + (entry.authModeFile || '（未挂载）'))
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

        var b = BASE.createCommandBuilder({
            event:          event,
            Commands:       Commands,
            Arguments:      Arguments,
            canSee:         function (source, branchPolicy) { return canSeeSubcommand(source, 'auth', branchPolicy) },
            guardExecution: function (pol, fn) { return guardExecution('auth', pol, fn) }
        })

        function makeAuthScopeMutator(litName, isGrant) {
            return b.literal(litName, {
                chain: [
                    [{ name: 'targets', type: 'players' }, { name: 'scope', type: 'word' }],
                    function (ctx, args) {
                        return handleAuthScopeCommand(ctx.source, args.targets, isGrant, args.scope || '*')
                    },
                    { minArgs: 1, policy: POLICY_PRESETS.admin }
                ]
            })
        }

        var authNode = b.literal('auth', {
            policy: POLICY_PRESETS.admin,
            children: [
                b.literal('list', {
                    policy: POLICY_PRESETS.admin,
                    exec: function (ctx) {
                        var srv     = resolveServer(ctx.source, ctx.source.player)
                        var entry   = getOrLoadWorldGrants(srv)
                        var entries = listGrantedEntries(srv)
                        var cheats  = isWorldCheatsEnabled(srv, ctx.source.player)
                        var modeTag = isNameGrantEnabled(entry) ? '§e按名备用已开启' : '§a严格UUID模式'
                        sendSourceMessage(ctx.source, '§b[Epiphy 权限阀] §7作弊: ' + (cheats ? '§a开' : '§c关') + ' §7| 模式: ' + modeTag + ' §7| 授权条目: §e' + entries.length)
                        sendSourceMessage(ctx.source, '§7权限文件: §8' + entry.filePath + ' §7| 墓碑: §8' + (entry.revocationsFile || '无'))
                        for (var eIdx = 0; eIdx < entries.length; eIdx++) {
                            sendSourceMessage(ctx.source, '§7  • §f' + entries[eIdx])
                        }
                        return 1
                    }
                }),
                b.literal('scopes', {
                    chain: [
                        [{ name: 'module', type: 'word' }],
                        function (ctx, args) {
                            var filterMod = args.module ? normalizeKey(args.module) : ''
                            sendSourceMessage(ctx.source, '§b[Epiphy 权限阀 // 可授权作用域列表]')
                            for (var si = 0; si < subcmdOrder.length; si++) {
                                var mName = subcmdOrder[si]
                                if (filterMod && mName !== filterMod) continue
                                var mSpec = getRegisteredSubcommand(mName)
                                if (mSpec == null) continue
                                sendSourceMessage(ctx.source, '§6  ▸ §f' + mName + ' §8(' + mSpec.policy.label + ')')
                                if (Array.isArray(mSpec.scopes) && mSpec.scopes.length > 0) {
                                    for (var sci = 0; sci < mSpec.scopes.length; sci++) {
                                        var scEntry = mSpec.scopes[sci]
                                        sendSourceMessage(ctx.source, '§7     - §b' + scEntry.scope + (scEntry.desc ? (' §8: ' + scEntry.desc) : ''))
                                    }
                                }
                            }
                            return 1
                        },
                        { minArgs: 0, policy: POLICY_PRESETS.admin }
                    ]
                }),
                b.literal('where', {
                    policy: POLICY_PRESETS.admin,
                    exec: function (ctx) {
                        var srv  = resolveServer(ctx.source, ctx.source.player)
                        var info = resolveWorldStorageInfo(srv)
                        sendSourceMessage(ctx.source, '§b[Epiphy 数据定位] §7worldId=§f' + (info.worldId || info.worldKey) + ' §7| worldName=§f' + info.worldName)
                        sendSourceMessage(ctx.source, '§7  • 数据目录: §8' + (info.worldDataDir || info.filePath))
                        sendSourceMessage(ctx.source, '§7  • 授权表: §8' + info.permissionsFile)
                        sendSourceMessage(ctx.source, '§7  • 撤销墓碑: §8' + info.revocationsFile)
                        sendSourceMessage(ctx.source, '§7  • 认证开关: §8' + info.authModeFile)
                        return 1
                    }
                }),
                b.literal('reload', {
                    policy: POLICY_PRESETS.admin,
                    exec: function (ctx) {
                        var srv   = resolveServer(ctx.source, ctx.source.player)
                        var entry = reloadWorldAuthFromDisk(srv)
                        var count = Object.keys(entry.grants).length
                        var modeStr = isNameGrantEnabled(entry) ? '§e按名备用已开启' : '§a严格UUID(默认)'
                        sendSourceMessage(ctx.source, '§a[Epiphy 权限阀] 已从 epiphy-data 重新加载当前世界权限与开关：授权记录 §f' + count + ' §a条 | 模式 ' + modeStr)
                        return 1
                    }
                }),
                makeAuthScopeMutator('grant', true),
                makeAuthScopeMutator('revoke', false),
                b.literal('grantname', {
                    chain: [
                        [{ name: 'targetName', type: 'word' }, { name: 'scope', type: 'word' }],
                        function (ctx, args) {
                            var srv   = resolveServer(ctx.source, ctx.source.player)
                            var scope = normalizeScope(args.scope || '*')
                            if (isReservedScope(scope)) {
                                sendSourceMessage(ctx.source, '§c[Epiphy 权限阀] "' + scope + '" 为系统保留子命令，禁止授权。')
                                return 0
                            }
                            var entry = getOrLoadWorldGrants(srv)
                            if (!isNameGrantEnabled(entry) && !isUuidKeyFormat(args.targetName)) {
                                sendSourceMessage(ctx.source, '§c[Epiphy 权限阀] 默认严格 UUID 模式下禁止新建按名字授权；请直接对在线玩家使用 /epiphy auth grant <玩家> [作用域]，或由真实 OP/控制台先开启 /epiphy auth namegrant enable。')
                                return 0
                            }
                            if (grantPlayer(srv, args.targetName, scope, ctx.source)) {
                                sendSourceMessage(ctx.source, '§a[Epiphy 权限阀] 已写入授权 [' + args.targetName + '] -> [' + scope + ']。')
                                return 1
                            }
                            sendSourceMessage(ctx.source, '§c[Epiphy 权限阀] 写入授权失败，请检查参数或权限模式。')
                            return 0
                        },
                        { minArgs: 1, policy: POLICY_PRESETS.admin }
                    ]
                }),
                b.literal('revokename', {
                    chain: [
                        [{ name: 'targetName', type: 'word' }, { name: 'scope', type: 'word' }],
                        function (ctx, args) {
                            var srv   = resolveServer(ctx.source, ctx.source.player)
                            var scope = normalizeScope(args.scope || '*')
                            if (RESERVED_SUBCOMMANDS[scope]) {
                                sendSourceMessage(ctx.source, '§c[Epiphy 权限阀] "' + scope + '" 为系统保留子命令。')
                                return 0
                            }
                            if (revokePlayer(srv, args.targetName, scope, ctx.source)) {
                                sendSourceMessage(ctx.source, '§e[Epiphy 权限阀] 已撤销 [' + args.targetName + '] 的 [' + scope + '] 授权并写入外部撤销墓碑。')
                                return 1
                            }
                            return 0
                        },
                        { minArgs: 1, policy: POLICY_PRESETS.admin }
                    ]
                }),
                b.literal('namegrant', {
                    policy: POLICY_PRESETS.strict_op,
                    children: [
                        b.literal('status', {
                            policy: POLICY_PRESETS.strict_op,
                            exec: function (ctx) {
                                var srv   = resolveServer(ctx.source, ctx.source.player)
                                var entry = getOrLoadWorldGrants(srv)
                                sendNameGrantRiskSummary(ctx.source, entry)
                                return 1
                            }
                        }),
                        b.literal('enable', {
                            policy: POLICY_PRESETS.strict_op,
                            exec: function (ctx) {
                                var req = requestNameGrantEnable(ctx.source)
                                if (!req.ok) {
                                    sendSourceMessage(ctx.source, '§c[Epiphy 按名授权] ' + req.error)
                                    return 0
                                }
                                sendSourceMessage(ctx.source, '§e§l[安全确认] 即将为当前世界开启“按名字授权备用模式”：')
                                sendSourceMessage(ctx.source, '§7  1. 在无 TrueUUID 的离线服中，首个以目标文本名上线且完成迁入的玩家将永久继承该权限。')
                                sendSourceMessage(ctx.source, '§7  2. 若服务器已安装强制登录密码插件（如 AuthMe / EasyAuth 等登录前禁指令），该冒领风险可忽略。')
                                sendSourceMessage(ctx.source, '§7  3. 若为纯 online-mode=false 离线服且既无 TrueUUID 修复也无密码插件，即使保持默认 UUID 模式亦不安全！')
                                sendSourceMessage(ctx.source, '§f  请在 §c' + req.ttlSeconds + ' 秒 §f内执行以下命令完成二次确认（区分大小写）：')
                                sendSourceMessage(ctx.source, '§a  /epiphy auth namegrant confirm §l§e' + req.code)
                                return 1
                            }
                        }),
                        b.literal('confirm', {
                            chain: [
                                [{ name: 'code', type: 'word' }],
                                function (ctx, args) {
                                    var res = confirmNameGrantEnable(ctx.source, args.code)
                                    if (!res.ok) {
                                        sendSourceMessage(ctx.source, '§c[Epiphy 按名授权] ' + res.error)
                                        return 0
                                    }
                                    sendSourceMessage(ctx.source, '§a[Epiphy 按名授权] 二次确认通过，已开启按名字授权备用模式（已写入 §8' + res.authModeFile + '§a，立即迁移在线记录 ' + res.migratedCount + ' 条）。')
                                    return 1
                                },
                                { minArgs: 1, policy: POLICY_PRESETS.strict_op }
                            ]
                        }),
                        b.literal('disable', {
                            policy: POLICY_PRESETS.strict_op,
                            exec: function (ctx) {
                                var res = disableNameGrantMode(ctx.source)
                                if (!res.ok) {
                                    sendSourceMessage(ctx.source, '§c[Epiphy 按名授权] ' + res.error)
                                    return 0
                                }
                                sendSourceMessage(ctx.source, '§a[Epiphy 按名授权] 已关闭备用模式并回退默认严格 UUID 模式（保留 ' + res.pausedCount + ' 条未迁移文本名记录为暂停生效状态，可在 §8' + res.authModeFile + ' §a查看）。')
                                return 1
                            }
                        })
                    ]
                })
            ]
        })

        var helpNode = b.literal('help', {
            chain: [
                [{ name: 'topic', type: 'word' }],
                function (ctx, args) { return sendAggregatedHelp(ctx.source, args.topic || null) },
                { minArgs: 0 }
            ]
        })

        var root = Commands.literal(ROOT_LITERAL)
            .executes(function (ctx) { return sendAggregatedHelp(ctx.source, null) })
            .then(helpNode)
            .then(authNode)

        // 挂载各业务模块声明的子命令，并挂载安全包裹 try/catch 的 .requires(...) 以隐藏无权限玩家的 Tab 补全树
        for (var idx = 0; idx < subcmdOrder.length; idx++) {
            var subName = subcmdOrder[idx]
            var subSpec = getRegisteredSubcommand(subName)
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
                            var rootVisPolicy = makeModuleRootPolicy(boundSpec.policy)
                            subNode = subNode.requires(function (source) {
                                return canSeeSubcommand(source, boundName, rootVisPolicy)
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
            if (source == null) {
                source = (typeof event.getSource === 'function') ? event.getSource() : event.source
            }
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
                var sp = getRegisteredSubcommand(sk)
                if (sp != null) {
                    lines.push('policy[' + sk + ']: mode=' + sp.policy.mode + ', console=' + sp.policy.allowConsole + ', declared=' + sp.policy.allowDeclaredCallers)
                }
            }
            return lines
        },
        metrics: getStats,
        check: function () {
            var s = getStats()
            return [{
                name:   'declaration_stack_balanced',
                ok:     s.declarationStackDepth === 0,
                detail: 'declarationStackDepth=' + s.declarationStackDepth
            }]
        }
    }
    BASE.registerDebugProvider(valveDebugProvider)
})()
