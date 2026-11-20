// ============================================================================
//  通用空间音频与流式声场组件 —— 客户端播放引擎 (EpiphyAudioClient v5.6)
//  所属系列：Epiphy的-通用组件系列（本系列包含 startup / server / client 配套脚本）
//  许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
//  放置位置：kubejs/client_scripts/通用组件/Epiphy的-音频播放器.js
//  配套服务端组件：
//    - kubejs/server_scripts/通用组件/Epiphy的-音频组件.js（服务端调度器 EpiphyAudio >= 5.6.0, <= 5.99.x，协议 v5）
//    - kubejs/server_scripts/通用组件/Epiphy的-权限阀.js（/epiphy 指令注册中心与权限阀 EpiphyPermissionValve >= 5.0.0, <= 5.99.x）

//  依赖与缺失降级：
//    - 可选前置：kubejs/startup_scripts/通用组件/Epiphy的-Spec与通用工具.js (EpiphySpec / EpiphyProtocol, priority: 1200)
//      缺失时启动输出 console.warn 并降级至内置 v5 协议常量与基础数值工具；收包仍严格执行 fail-closed 版本校验。
//    - 必需配套：kubejs/server_scripts/通用组件/Epiphy的-音频组件.js（缺失时客户端处于待命状态，无音频数据包驱动）

//  适用环境：Minecraft 1.20.1 / Forge 47.x / KubeJS 2001.6.x
//
//  [语法规范] 遵循 README-LLM.md §1 强制语法基准（与 docs/kube-mods-rhino-es5-es6-compatibility.md）：
//    以 ES5 + `var` 为主，可按需谨慎使用经实测无语义偏移的 ES6/ES2020 扩展语法；
//    严禁使用 `??`、`let`/`const`、对象属性简写/计算属性、展开与默认参数等已确认高危/失效特性。
// ============================================================================

;(() => {
    var SPEC  = (typeof global !== 'undefined' && global.EpiphySpec != null) ? global.EpiphySpec : null
    var PROTO = (typeof global !== 'undefined' && global.EpiphyProtocol != null)
        ? global.EpiphyProtocol
        : (SPEC && SPEC.PROTOCOL ? SPEC.PROTOCOL : null)
    if (PROTO == null || SPEC == null) {
        try {
            console.warn('[EpiphyAudioClient] 未检测到 startup_scripts/通用组件/Epiphy的-Spec与通用工具.js，已启用内置 v5 协议常量与基础数值工具降级运行。')
        } catch (eWarnInit) { }
    }
    var CHANNEL       = (PROTO && PROTO.AUDIO_CHANNEL) || 'epiphy:audio'
    var PROTO_VERSION = (PROTO && PROTO.AUDIO_PROTO_VERSION) || 5
    var VERSION       = '5.6.0'
    if (SPEC && typeof SPEC.checkDependencyVersion === 'function') {
        SPEC.checkDependencyVersion('EpiphySpec', SPEC, '2.5.0', '2.99.99', {
            caller: 'EpiphyAudioClient',
            onWarn: function (msg) { try { console.warn(msg) } catch (eW) { } }
        })
    }

    var CONFIG = {
        sweepIntervalTicks:     10,   // 慢速巡检周期（负责死链清理、异常断流重连、超时判定）
        subtitleRefreshTicks:   24,   // 循环音源字幕保活与 3D 方向刷新周期 (1.2s，小于原版 3s 过期时间)
        musicDuckIntervalTicks: 10,   // 原版背景音乐避让巡检周期 (0.5s)
        pendingTimeoutTicks:    200,  // 跨维度加载或实体未同步时的最长等待 (tick)
        resumeMinDelayTicks:    10,   // 循环音源意外中断后的初始退避重连间隔 (tick)
        resumeMaxDelayTicks:    200,  // 循环音源退避重连最大间隔 (tick)
        stableTicks:            80,   // 音源连续稳定播放超过该时长后重置退避计数 (tick)
        missingSoundGraceTicks: 100,  // 资源包重载或登录初期 getSoundEvent 尚未就绪时的容错等待窗口 (tick)
        maxEntries:             128,  // 客户端同时维护的最大句柄数
        defaultFadeOutTicks:    12,   // 默认软停止淡出时长 (tick)
        errorLogIntervalMs:     5000  // 限频错误日志间隔 (ms)
    }

    var warnedKeys = new Set()

    var warnOnce = (key, msg) => {
        if (warnedKeys.has(key)) return
        warnedKeys.add(key)
        console.warn(`[EpiphyAudioClient] ${msg}`)
    }

    var loadJavaClass = (name, silent) => {
        if (typeof Java === 'undefined' || Java == null || typeof Java.loadClass !== 'function') return null
        try {
            return Java.loadClass(name)
        } catch (e) {
            if (!silent) {
                warnOnce(`javaClass:${name}`, `加载 Java 类 ${name} 失败: ${e}`)
            }
            return null
        }
    }

    var Minecraft           = loadJavaClass('net.minecraft.client.Minecraft')
    var ResourceLocation    = loadJavaClass('net.minecraft.resources.ResourceLocation')
    var SoundSource         = loadJavaClass('net.minecraft.sounds.SoundSource')
    var RandomSource        = loadJavaClass('net.minecraft.util.RandomSource')
    var SimpleSoundInstance = loadJavaClass('net.minecraft.client.resources.sounds.SimpleSoundInstance')
    var Attenuation         = loadJavaClass('net.minecraft.client.resources.sounds.SoundInstance$Attenuation')
    var Vec3Class           = loadJavaClass('net.minecraft.world.phys.Vec3')
    var SystemClass         = loadJavaClass('java.lang.System', true)

    var createRandomSource = () => {
        if (RandomSource == null) return null
        try {
            if (typeof RandomSource.create === 'function') return RandomSource.create()
            if (typeof RandomSource.m_216327_ === 'function') return RandomSource.m_216327_()
        } catch (eRnd) {
            warnOnce('randomSource', `RandomSource.create 调用失败: ${eRnd}`)
        }
        return null
    }

    var RANDOM             = createRandomSource()
    var entries            = new Map() // handleId (number) -> entry
    // soundId -> attenuation_distance（仅缓存有效正值；F3+T 重载界面结束/恢复焦点/切服时由 prepareEntriesForResume 与 resetClientState 清空重建）
    var attCache           = new Map()
    var missingSoundUntil  = new Map() // soundId -> 下次重探 getSoundEvent 的 tick（避免永久毒化 attCache）
    var duckedMusicInsts   = new Set() // 被 duckMusic 暂停的原版/第三方 MUSIC 频道 SoundInstance
    var pendingActions     = []
    var session              = null
    var clientTicks          = 0
    var wasPaused            = false
    var wasWindowInactive    = false
    var wasScreenOpen        = false
    var postResumeResyncUntil = 0
    var lastLevelKey         = ''
    var lastErrorLogAt    = 0
    var suppressedErrors  = 0

    // ======================================================================== 基础工具

    var min2     = (SPEC && typeof SPEC.min2 === 'function') ? SPEC.min2 : ((a, b) => (a < b ? a : b))
    var max2     = (SPEC && typeof SPEC.max2 === 'function') ? SPEC.max2 : ((a, b) => (a > b ? a : b))
    var clampNum = (SPEC && typeof SPEC.clampNum === 'function')
        ? SPEC.clampNum
        : ((v, lo, hi, defVal) => {
            if (v === null || v === undefined || v === '' || typeof v === 'boolean' || Array.isArray(v)) {
                return defVal !== undefined ? defVal : lo
            }
            var n = Number(v)
            if (isNaN(n) || !isFinite(n)) return defVal !== undefined ? defVal : lo
            return n < lo ? lo : (n > hi ? hi : n)
        })

    var checkProtoCompatible = (expectedVer, incomingVer) => {
        if (PROTO && typeof PROTO.isProtoCompatible === 'function') {
            return PROTO.isProtoCompatible(expectedVer, incomingVer)
        }
        if (incomingVer === undefined || incomingVer === null) return false
        var n = Number(incomingVer)
        return isFinite(n) && n === Number(expectedVer)
    }

    var HAS_NANO_TIME = (SystemClass != null && typeof SystemClass.nanoTime === 'function')
    var monotonicNowMs = () => {
        if (HAS_NANO_TIME) {
            try {
                return Number(SystemClass.nanoTime()) / 1000000.0
            } catch (e) {
                HAS_NANO_TIME = false
                warnOnce('nanoTime', `System.nanoTime 不可用，已回退 Date.now(): ${e}`)
            }
        }
        return Date.now()
    }

    var logErrorThrottled = (prefix, err) => {
        var now = monotonicNowMs()
        if (now - lastErrorLogAt >= CONFIG.errorLogIntervalMs) {
            var tail = suppressedErrors > 0 ? ` (另有 ${suppressedErrors} 次同类异常被折叠)` : ''
            lastErrorLogAt   = now
            suppressedErrors = 0
            console.error(`[EpiphyAudioClient] ${prefix}: ${err}${tail}`)
        } else {
            suppressedErrors++
        }
    }

    var RESERVED_TAG_BEANS = new Set(['id', 'type', 'empty', 'allKeys', 'asString', 'class', 'tags'])

    var hasKeyInTag = (d, key) => {
        if (d == null) return false
        try {
            var fnContains = d['contains(java.lang.String)']
            if (typeof fnContains === 'function') return Boolean(fnContains.call(d, String(key)))
            if (typeof d.contains === 'function') return Boolean(d.contains(String(key)))
        } catch (e) {}
        try {
            return d[key] !== undefined && d[key] !== null
        } catch (e) {
            return false
        }
    }

    var readStr = (d, key, defVal) => {
        var fallback = defVal === undefined ? '' : defVal
        if (d == null) return fallback
        if (!RESERVED_TAG_BEANS.has(key)) {
            try {
                var v = d[key]
                if (v != null && typeof v !== 'function' && typeof v !== 'object') {
                    var sv = String(v)
                    if (sv.length >= 2 && (sv[0] === '"' || sv[0] === "'") && sv[sv.length - 1] === sv[0]) {
                        sv = sv.substring(1, sv.length - 1)
                    }
                    if (sv.length > 0) return sv
                }
            } catch (e) {}
        }
        try {
            if (typeof d.getString === 'function' && hasKeyInTag(d, key)) {
                var s = d.getString(String(key))
                if (s != null && String(s).length > 0) return String(s)
            }
        } catch (e) {}
        return fallback
    }

    var readNum = (d, key, defVal) => {
        var fallback = defVal === undefined ? null : defVal
        if (d == null) return fallback
        if (!RESERVED_TAG_BEANS.has(key)) {
            try {
                var v = d[key]
                if (v !== undefined && v !== null && typeof v !== 'function') {
                    var nv = Number(v)
                    if (isFinite(nv)) return nv
                    var sv = String(v).trim().replace(/[dfbslDFBSL]$/, '')
                    var nsv = Number(sv)
                    if (sv.length > 0 && isFinite(nsv)) return nsv
                }
            } catch (e) {}
        }
        if (hasKeyInTag(d, key)) {
            try {
                if (typeof d.getDouble === 'function') {
                    var nd = Number(d.getDouble(String(key)))
                    if (isFinite(nd)) return nd
                }
            } catch (e) {}
        }
        return fallback
    }

    var readFlag = (d, key, defVal) => {
        var fallback = defVal === undefined ? false : defVal
        var n = readNum(d, key, null)
        return (n === null || !isFinite(n)) ? fallback : (n !== 0)
    }

    // ======================================================================== 客户端环境一次探测与安全读取

    var probeMember = (obj, fnNames, propNames, slot) => {
        if (obj == null) return undefined
        if (!slot.probed) {
            slot.probed = true
            slot.kind   = 'none'
            slot.name   = null
            if (fnNames) {
                for (var i = 0; i < fnNames.length; i++) {
                    try {
                        if (typeof obj[fnNames[i]] === 'function') {
                            slot.kind = 'fn'
                            slot.name = fnNames[i]
                            break
                        }
                    } catch (eProbeFn) {
                        // Rhino 探测阶段跳过不可访问/写保护成员
                    }
                }
            }
            if (slot.kind === 'none' && propNames) {
                for (var j = 0; j < propNames.length; j++) {
                    try {
                        if (obj[propNames[j]] !== undefined) {
                            slot.kind = 'prop'
                            slot.name = propNames[j]
                            break
                        }
                    } catch (eProbeProp) {
                        // Rhino 探测阶段跳过 write-only bean 属性
                    }
                }
            }
        }
        if (slot.kind === 'fn') return obj[slot.name]()
        if (slot.kind === 'prop') return obj[slot.name]
        return undefined
    }

    var probeMethodName = (obj, fnNames, slot, key) => {
        if (slot[key] !== undefined) return slot[key]
        if (obj == null) return null
        for (var i = 0; i < fnNames.length; i++) {
            try {
                if (typeof obj[fnNames[i]] === 'function') {
                    slot[key] = fnNames[i]
                    return slot[key]
                }
            } catch (eProbe) {
                // 探测一次 SRG/Mojmap 方法名
            }
        }
        slot[key] = null
        return null
    }

    var MC_PAUSED_CAP      = { probed: false, kind: 'none', name: null }
    var MC_ACTIVE_CAP      = { probed: false, kind: 'none', name: null }
    var MC_SCREEN_CAP      = { probed: false, kind: 'none', name: null }
    var CLI_SCREEN_CAP     = { probed: false, kind: 'none', name: null }
    var MC_SM_CAP          = { probed: false, kind: 'none', name: null }
    var MC_MM_CAP          = { probed: false, kind: 'none', name: null }
    var MC_OPTS_CAP        = { probed: false, kind: 'none', name: null }
    var CLI_LEVEL_CAP      = { probed: false, kind: 'none', name: null }
    var CLI_PLAYER_CAP     = { probed: false, kind: 'none', name: null }
    var CHANNEL_OPS        = {}
    var SOUND_MANAGER_OPS  = {}
    var WEIGHED_OPS        = {}
    var SOUND_OPS          = {}
    var OPTIONS_OPS        = {}
    var INST_OPS           = {}
    var MC_GET_FAILED      = false
    var MC_GET_FN          = null

    var getMc = () => {
        if (Minecraft != null && !MC_GET_FAILED) {
            try {
                if (MC_GET_FN == null) {
                    if (typeof Minecraft.getInstance === 'function') MC_GET_FN = 'getInstance'
                    else if (typeof Minecraft.m_91087_ === 'function') MC_GET_FN = 'm_91087_'
                }
                if (MC_GET_FN != null) {
                    var mcInst = Minecraft[MC_GET_FN]()
                    if (mcInst != null) return mcInst
                }
            } catch (e) {
                MC_GET_FAILED = true
                warnOnce('mcGet', `Minecraft.getInstance 调用失败，回退 Client: ${e}`)
            }
        }
        if (typeof Client !== 'undefined' && Client != null) {
            try {
                if (Client.minecraft != null) return Client.minecraft
            } catch (eCliMc) {}
            return Client
        }
        return null
    }

    var isClientPaused = () => {
        var m = getMc()
        var v = probeMember(m, ['isPaused', 'm_91104_'], ['paused'], MC_PAUSED_CAP)
        return v !== undefined ? Boolean(v) : false
    }

    var isClientWindowActive = () => {
        var m = getMc()
        var v = probeMember(m, ['isWindowActive', 'm_91294_'], ['windowActive'], MC_ACTIVE_CAP)
        return v !== undefined ? Boolean(v) : true
    }

    var hasCurrentScreenOpen = () => {
        var m = getMc()
        var ms = probeMember(m, ['getCurrentScreen'], ['currentScreen', 'f_91080_'], MC_SCREEN_CAP)
        if (ms != null) return true
        if (typeof Client !== 'undefined' && Client != null && Client !== m) {
            var cs = probeMember(Client, ['getCurrentScreen'], ['currentScreen'], CLI_SCREEN_CAP)
            if (cs != null) return true
        }
        return false
    }

    var getSoundManager = () => {
        var m = getMc()
        if (m == null) return null
        var sm = probeMember(m, ['getSoundManager', 'm_91106_'], ['soundManager', 'f_91042_'], MC_SM_CAP)
        if (sm == null) {
            sm = readJavaField(m, ['soundManager', 'f_91042_'], fieldCacheMcSoundMgr)
        }
        return sm !== undefined ? sm : null
    }

    var resolveClientLevel = (event) => {
        if (event != null) {
            try {
                var elv = typeof event.getLevel === 'function' ? event.getLevel() : event.level
                if (elv != null) return elv
            } catch (eLv0) {}
        }
        if (typeof Client !== 'undefined' && Client != null) {
            var clv = probeMember(Client, ['getCurrentLevel', 'getLevel'], ['level'], CLI_LEVEL_CAP)
            if (clv != null) return clv
        }
        var m = getMc()
        if (m != null) {
            try {
                if (typeof m.getCameraEntity === 'function') {
                    var cam = m.getCameraEntity()
                    if (cam != null) {
                        var camLv = typeof cam.level === 'function' ? cam.level() : cam.level
                        if (camLv != null) return camLv
                    }
                }
            } catch (eCamLv) {}
        }
        return null
    }

    var resolveClientPlayer = (event) => {
        if (event != null) {
            try {
                var ep = typeof event.getPlayer === 'function' ? event.getPlayer() : event.player
                if (ep != null) return ep
            } catch (ePl0) {}
        }
        if (typeof Client !== 'undefined' && Client != null) {
            var cp = probeMember(Client, null, ['player'], CLI_PLAYER_CAP)
            if (cp != null) return cp
        }
        var m = getMc()
        if (m != null) {
            try {
                if (typeof m.getCameraEntity === 'function') {
                    var cam = m.getCameraEntity()
                    if (cam != null) return cam
                }
            } catch (eCamPl) {}
        }
        return null
    }

    var extractDimensionId = (lv) => {
        if (lv == null) return null
        if (typeof lv.getDimension === 'function') {
            var gd = lv.getDimension()
            if (gd != null && String(gd).length > 0) return String(gd)
        }
        var dimProp = lv.dimension
        if (dimProp != null && typeof dimProp !== 'function') {
            var sProp = String(dimProp)
            if (sProp.length > 0) return sProp
        }
        if (typeof dimProp === 'function') {
            var rk = dimProp.call(lv)
            if (rk != null) {
                if (typeof rk.location === 'function') return String(rk.location())
                return String(rk)
            }
        }
        return null
    }

    // 注意：KubeJS 6 的 EntityKJS 仅定义了 setX/setY/setZ（只写 setter），直接读取 ent.x 会返回 null/undefined，
    // 而 Number(null) === 0 会导致坐标被误判为 (0,0,0)！必须优先调用 getX()/getY()/getZ() 或读取 ent.block。
    var getEntityPos = (ent) => {
        if (ent == null) return null
        if (typeof ent.getX === 'function' && typeof ent.getY === 'function' && typeof ent.getZ === 'function') {
            var x = Number(ent.getX())
            var y = Number(ent.getY())
            var z = Number(ent.getZ())
            if (isFinite(x) && isFinite(y) && isFinite(z)) return { x: x, y: y, z: z }
        }
        var b = ent.block
        if (b != null && b.x != null && b.y != null && b.z != null) {
            var bx = Number(b.x)
            var by = Number(b.y)
            var bz = Number(b.z)
            if (isFinite(bx) && isFinite(by) && isFinite(bz)) return { x: bx, y: by, z: bz }
        }
        if (ent.x != null && ent.y != null && ent.z != null) {
            var rx = Number(ent.x)
            var ry = Number(ent.y)
            var rz = Number(ent.z)
            if (isFinite(rx) && isFinite(ry) && isFinite(rz)) return { x: rx, y: ry, z: rz }
        }
        return null
    }

    var getEntityById = (lv, eid) => {
        if (lv == null || eid == null || typeof lv.getEntity !== 'function') return null
        return lv.getEntity(Number(eid))
    }

    var resolveSoundSource = (catName) => {
        if (SoundSource == null) return null
        try {
            var c = SoundSource.valueOf(String(catName || 'RECORDS'))
            if (c != null) return c
        } catch (e) {
            warnOnce(`soundSource:${catName}`, `未知 SoundSource "${catName}"，回退 RECORDS`)
        }
        return SoundSource.RECORDS
    }

    var getAttenuationDistance = (soundId) => {
        if (attCache.has(soundId)) return attCache.get(soundId)
        var sm = getSoundManager()
        if (sm == null || ResourceLocation == null) return 16
        var missUntil = missingSoundUntil.get(soundId)
        if (missUntil != null && clientTicks < missUntil) return -1
        var att = 16
        try {
            var getEvtFn = probeMethodName(sm, ['getSoundEvent', 'm_120384_'], SOUND_MANAGER_OPS, 'getEvtFn')
            var weighed  = getEvtFn != null ? sm[getEvtFn](new ResourceLocation(String(soundId))) : null
            if (getEvtFn != null && weighed == null) {
                missingSoundUntil.set(soundId, clientTicks + 40)
                return -1
            }
            missingSoundUntil.delete(soundId)
            if (weighed != null && RANDOM != null) {
                var getSndFn = probeMethodName(weighed, ['getSound', 'm_213718_'], WEIGHED_OPS, 'getSndFn')
                var snd      = getSndFn != null ? weighed[getSndFn](RANDOM) : null
                if (snd != null) {
                    var getAttFn = probeMethodName(snd, ['getAttenuationDistance', 'm_119800_'], SOUND_OPS, 'getAttFn')
                    if (getAttFn != null) {
                        var a = Number(snd[getAttFn]())
                        if (isFinite(a) && a > 0) att = a
                    }
                }
            }
            if (getEvtFn != null) attCache.set(soundId, att)
            return att
        } catch (e) {
            warnOnce(`att:${soundId}`, `读取音效衰减距离失败 (${soundId})，使用默认值 16: ${e}`)
            return 16
        }
    }

    // ======================================================================== 距离可听度判定与音源启停

    var computeAudibleGain = (entry, playerPos) => {
        var spec = entry.spec
        var base = clampNum(spec.vol, 0.0, 2.0)
        if (entry.muted) return 0.0

        var fadeMult = 1.0
        if (entry.fadingOut) {
            var rem = entry.fadeEndTick - clientTicks
            if (rem <= 0) return 0.0
            var fadeSpan = max2(1, entry.fadeSpanTicks || CONFIG.defaultFadeOutTicks)
            fadeMult = clampNum(rem / fadeSpan, 0.0, 1.0)
        } else if (spec.fadeIn > 0) {
            var age = max2(0, clientTicks - (entry.startTick || clientTicks))
            if (age < spec.fadeIn) {
                fadeMult = clampNum(age / spec.fadeIn, 0.02, 1.0)
            }
        }

        var distMult = 1.0
        if (spec.anc !== 'none' && spec.mode !== 'flat' && playerPos != null) {
            var dx   = playerPos.x - entry.curX
            var dy   = playerPos.y - entry.curY
            var dz   = playerPos.z - entry.curZ
            var dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
            var rng  = max2(1.0, spec.rng || 32.0)
            if (spec.mode === 'cutoff') {
                distMult = (dist <= rng) ? 1.0 : 0.0
            } else if (spec.mode === 'linear') {
                distMult = clampNum(1.0 - (dist / rng), 0.0, 1.0)
            } else {
                // 'smooth': 平滑 S 曲线衰减，在边界处柔和归零
                var u = clampNum(1.0 - (dist / rng), 0.0, 1.0)
                distMult = u * u * (3.0 - 2.0 * u)
            }
        }

        return clampNum(base * fadeMult * distMult, 0.0, 2.0)
    }

    var fieldCacheSoundEngine = { cls: null, field: null, prop: null }
    var fieldCacheMcSoundMgr  = { cls: null, field: null, prop: null }
    var fieldCacheMcGui       = { cls: null, field: null, prop: null }
    var fieldCacheMcOptions   = { cls: null, field: null, prop: null }
    var fieldCacheChannelMap  = { cls: null, field: null, prop: null }
    var fieldCacheListeners   = { cls: null, field: null, prop: null }
    var fieldCacheSubOverlay  = { cls: null, field: null, prop: null }
    var fieldCacheInstVolume  = { cls: null, field: null, prop: null }
    var fieldCacheInstX       = { cls: null, field: null, prop: null }
    var fieldCacheInstY       = { cls: null, field: null, prop: null }
    var fieldCacheInstZ       = { cls: null, field: null, prop: null }

    var readJavaField = (obj, names, cacheSlot) => {
        if (obj == null) return null
        if (cacheSlot != null) {
            if (cacheSlot.prop != null) {
                try {
                    var pv = obj[cacheSlot.prop]
                    if (pv !== undefined && pv !== null) return pv
                } catch (eCp) {}
            }
            if (cacheSlot.field != null) {
                try { return cacheSlot.field.get(obj) } catch (eCf) {}
            }
        }
        for (var i = 0; i < names.length; i++) {
            var nm = names[i]
            try {
                if (obj[nm] !== undefined && obj[nm] !== null) {
                    if (cacheSlot != null) cacheSlot.prop = nm
                    return obj[nm]
                }
            } catch (e0) {}
        }
        try {
            var origCls = obj.getClass()
            var cls = origCls
            while (cls != null) {
                for (var j = 0; j < names.length; j++) {
                    try {
                        var fld = cls.getDeclaredField(names[j])
                        fld.setAccessible(true)
                        if (cacheSlot != null) {
                            cacheSlot.cls   = origCls
                            cacheSlot.field = fld
                        }
                        return fld.get(obj)
                    } catch (e1) {}
                }
                cls = cls.getSuperclass()
            }
        } catch (e2) {}
        return null
    }

    var setJavaNumberField = (obj, names, cacheSlot, numVal, isDouble) => {
        if (obj == null) return false
        var val = Number(numVal)
        try {
            if (cacheSlot != null && cacheSlot.field != null) {
                if (isDouble) cacheSlot.field.setDouble(obj, val)
                else cacheSlot.field.setFloat(obj, val)
                return true
            }
        } catch (eCached) {}
        try {
            if (typeof obj.getClass === 'function') {
                var cls = obj.getClass()
                while (cls != null) {
                    for (var i = 0; i < names.length; i++) {
                        try {
                            var fld = cls.getDeclaredField(names[i])
                            fld.setAccessible(true)
                            if (cacheSlot != null) {
                                cacheSlot.cls   = cls
                                cacheSlot.field = fld
                            }
                            if (isDouble) fld.setDouble(obj, val)
                            else fld.setFloat(obj, val)
                            return true
                        } catch (e1) {}
                    }
                    cls = cls.getSuperclass()
                }
            }
        } catch (e2) {}
        for (var j = 0; j < names.length; j++) {
            try {
                if (obj[names[j]] !== undefined) {
                    obj[names[j]] = val
                    return true
                }
            } catch (e3) {}
        }
        return false
    }

    var syncSoundInstanceVolume = (inst, gain) => {
        if (inst == null) return
        // 原版 SoundEngine.m_174988_ 遇到 calculateVolume <= 0 会直接调 Channel.stop() 摧毁流！
        // Forge 1.20.1 SRG 中 AbstractSoundInstance.volume 为 f_119572_（f_119573_ 为 pitch），下限保底 0.0001，
        // 同时消除 buildSoundInstance 首帧 fadeIn=0.02 残留导致暂停/切屏/重算音量后回落至 0.02 的问题。
        var instVol = clampNum(gain > 0.0001 ? gain : 0.0001, 0.0001, 2.0)
        setJavaNumberField(inst, ['volume', 'f_119572_'], fieldCacheInstVolume, instVol, false)
    }

    var syncSoundInstancePos = (inst, x, y, z) => {
        if (inst == null) return
        // AbstractSoundInstance 坐标字段在 Forge 1.20.1 SRG 中为 f_119574_ (x) / f_119575_ (y) / f_119576_ (z)
        setJavaNumberField(inst, ['x', 'f_119574_'], fieldCacheInstX, x, true)
        setJavaNumberField(inst, ['y', 'f_119575_'], fieldCacheInstY, y, true)
        setJavaNumberField(inst, ['z', 'f_119576_'], fieldCacheInstZ, z, true)
    }

    var getSoundEngine = (sm) => {
        if (sm == null) return null
        return readJavaField(sm, ['soundEngine', 'f_120349_'], fieldCacheSoundEngine)
    }

    var getCategoryGainMultiplier = (catObj) => {
        var m = getMc()
        var opts = m != null ? probeMember(m, ['getOptions'], ['options', 'f_91066_'], MC_OPTS_CAP) : null
        if (opts == null && m != null) {
            opts = readJavaField(m, ['options', 'f_91066_'], fieldCacheMcOptions)
        }
        var volFn = opts != null ? probeMethodName(opts, ['getSoundSourceVolume', 'm_92147_'], OPTIONS_OPS, 'getVolFn') : null
        if (volFn == null && typeof Client !== 'undefined' && Client != null && Client.options != null) {
            opts  = Client.options
            volFn = probeMethodName(opts, ['getSoundSourceVolume', 'm_92147_'], OPTIONS_OPS, 'getVolFn')
        }
        if (opts != null && volFn != null) {
            var masterVol = Number(opts[volFn](SoundSource.MASTER))
            var catVol    = catObj != null ? Number(opts[volFn](catObj)) : 1.0
            if (isFinite(masterVol) && isFinite(catVol)) {
                return clampNum(masterVol * catVol, 0.0, 1.0)
            }
        }
        return 1.0
    }

    var applyChannelGain = (sm, entry, gain, forceUnpause) => {
        if (sm == null || entry == null || entry.inst == null) return
        syncSoundInstanceVolume(entry.inst, gain)
        var se = getSoundEngine(sm)
        if (se == null) return
        // SoundEngine.instanceToChannel 在 Forge 1.20.1 SRG 中的真实字段名为 f_120226_（原 f_120220_ 为 Library）
        var chanMap = readJavaField(se, ['instanceToChannel', 'f_120226_'], fieldCacheChannelMap)
        if (chanMap == null || typeof chanMap.get !== 'function') return
        var chHandle = chanMap.get(entry.inst)
        if (chHandle == null || typeof chHandle.execute !== 'function') return

        var mul = getCategoryGainMultiplier(entry.catObj)
        entry.lastCatMul = mul
        var finalGain = clampNum(gain * mul, 0.0, 2.0)
        var shouldPauseMute = Boolean(entry.spec.loop && (mul <= 0.0001 || (finalGain <= 0.0001 && entry.spec.outMode === 'mute')))
        var shouldUnpause   = Boolean(!shouldPauseMute && (forceUnpause || entry._pausedByMute))
        try {
            chHandle.execute((ch) => {
                if (ch == null) return
                var stopFn    = probeMethodName(ch, ['stopped', 'm_83680_'], CHANNEL_OPS, 'stopFn')
                var volFn     = probeMethodName(ch, ['setVolume', 'm_83666_'], CHANNEL_OPS, 'volFn')
                var pauseFn   = probeMethodName(ch, ['pause', 'm_83677_'], CHANNEL_OPS, 'pauseFn')
                var unpauseFn = probeMethodName(ch, ['unpause', 'm_83678_'], CHANNEL_OPS, 'unpauseFn')
                if (stopFn != null && ch[stopFn]()) {
                    entry._channelStopped = true
                    return
                }
                if (volFn != null) ch[volFn](finalGain)
                if (shouldPauseMute && pauseFn != null) {
                    if (!entry._pausedByMute) {
                        ch[pauseFn]()
                        entry._pausedByMute = true
                    }
                } else if (shouldUnpause && unpauseFn != null) {
                    // Channel.unpause() / m_83678_() 仅在源处于 AL_PAUSED(4115) 时执行 alSourcePlay，天然幂等
                    ch[unpauseFn]()
                    entry._pausedByMute = false
                }
            })
        } catch (e1) {
            logErrorThrottled('applyChannelGain error', e1)
        }
    }

    var applyChannelPosition = (sm, entry, x, y, z) => {
        if (sm == null || entry == null || entry.inst == null || entry.is2D) return
        syncSoundInstancePos(entry.inst, x, y, z)
        var se = getSoundEngine(sm)
        if (se == null) return
        var chanMap = readJavaField(se, ['instanceToChannel', 'f_120226_'], fieldCacheChannelMap)
        if (chanMap == null || typeof chanMap.get !== 'function') return
        var chHandle = chanMap.get(entry.inst)
        if (chHandle == null || typeof chHandle.execute !== 'function') return
        try {
            chHandle.execute((ch) => {
                if (ch == null) return
                var posFn = probeMethodName(ch, ['setSelfPosition', 'm_83654_'], CHANNEL_OPS, 'posFn')
                if (posFn != null && Vec3Class != null) {
                    ch[posFn](new Vec3Class(Number(x), Number(y), Number(z)))
                }
            })
        } catch (ePos) {
            logErrorThrottled('applyChannelPosition error', ePos)
        }
    }

    var buildSoundInstance = (entry, lv, localPlayer) => {
        var spec = entry.spec
        if (Attenuation == null || ResourceLocation == null || SimpleSoundInstance == null) {
            return null
        }
        if (getAttenuationDistance(spec.snd) < 0) {
            if ((clientTicks - (entry.created || clientTicks)) < CONFIG.missingSoundGraceTicks) {
                return { wait: true }
            }
            warnOnce(`missing:${spec.snd}`, `音频 "${spec.snd}" 未在 sounds.json 中定义，已跳过播放`)
            return null
        }

        var curDim = extractDimensionId(lv)
        if (spec.dim != null && curDim != null && spec.dim !== curDim) {
            return { wait: true }
        }

        var catObj = resolveSoundSource(spec.cat)
        entry.catObj = catObj
        var resLoc = new ResourceLocation(spec.snd)

        var localId = (localPlayer != null && typeof localPlayer.getId === 'function')
            ? Number(localPlayer.getId()) : null
        var isSelfEntity = (spec.anc === 'entity' && spec.eid != null && localId != null && spec.eid === localId)

        if (spec.anc === 'entity' && !isSelfEntity) {
            var ent = getEntityById(lv, spec.eid)
            if (ent != null) {
                var ePos = getEntityPos(ent)
                if (ePos != null) {
                    entry.curX = ePos.x
                    entry.curY = ePos.y
                    entry.curZ = ePos.z
                }
            } else if (!isFinite(entry.curX)) {
                return { wait: true }
            }
        }

        var is2D = (spec.anc === 'none' || spec.mode === 'flat' || isSelfEntity)
        // 统一由 computeAudibleGain 精确控制 linear / smooth / cutoff 距离衰减曲线，
        // 关闭 OpenAL 原生 Attenuation.LINEAR，避免双层衰减以及原生 16 格半径截断破坏自定义 range！
        var attType = Attenuation.NONE

        // 直接使用目标基准音量构造原生 SimpleSoundInstance，由 OpenAL 实时计算 3D 距离衰减与方位，
        // 彻底避免玩家从范围边缘走入或淡入帧 t=0 时音量被锁死在极低值的问题！
        var initGain  = computeAudibleGain(entry, getEntityPos(localPlayer))
        var initVol   = clampNum(initGain > 0.005 ? initGain : 0.001, 0.001, 2.0)
        entry.smoothGain = initGain
        var initPitch = clampNum(spec.pit, 0.5, 2.0)
        entry.currentAlGain  = initVol
        entry.currentAlPitch = initPitch

        var inst = new SimpleSoundInstance(
            resLoc,
            catObj,
            initVol,
            initPitch,
            RANDOM,
            Boolean(spec.loop),
            0,
            attType,
            is2D ? 0.0 : Number(entry.curX || 0.0),
            is2D ? 0.0 : Number(entry.curY || 0.0),
            is2D ? 0.0 : Number(entry.curZ || 0.0),
            Boolean(is2D)
        )

        return { inst: inst, is2D: is2D }
    }

    var stopSoundInstance = (entry) => {
        if (entry == null || entry.inst == null) return
        var sm = getSoundManager()
        if (sm != null) {
            try {
                var stopFn = probeMethodName(sm, ['stop', 'm_120400_'], SOUND_MANAGER_OPS, 'stopFn')
                if (stopFn != null) sm[stopFn](entry.inst)
            } catch (e) {
                logErrorThrottled('sm.stop error', e)
            }
        }
        entry.inst = null
    }

    var removeEntryNow = (h) => {
        var entry = entries.get(h)
        if (entry == null) return
        stopSoundInstance(entry)
        entries.delete(h)
    }

    var clearAllNow = () => {
        restoreDuckedVanillaMusic()
        for (var entry of entries.values()) {
            stopSoundInstance(entry)
        }
        entries.clear()
    }

    var evictOldestEntry = () => {
        var victim   = null
        var minScore = Infinity
        for (var cand of entries.values()) {
            var tierWeight = (cand.tier === 'player') ? 0 : 1000000000
            var pri        = (cand.priority != null && isFinite(cand.priority)) ? cand.priority : 2
            var score      = tierWeight + pri * 1000000 + (cand.created % 1000000)
            if (victim == null || score < minScore) {
                minScore = score
                victim   = cand
            }
        }
        if (victim != null) removeEntryNow(victim.h)
    }

    var tryStartEntry = (entry, lv, localPlayer) => {
        if (lv == null) {
            if (entry.waitSince == null) entry.waitSince = clientTicks
            return true
        }
        if (entry.catObj == null && entry.spec != null) {
            entry.catObj = resolveSoundSource(entry.spec.cat)
        }
        if (!entry.fadingOut && entry.spec != null && entry.spec.loop) {
            var curMul  = getCategoryGainMultiplier(entry.catObj)
            var curGain = computeAudibleGain(entry, getEntityPos(localPlayer))
            if (curMul <= 0.0001 || (curGain <= 0.0001 && entry.spec.outMode === 'mute')) {
                entry._standbyMuted = true
                return true
            }
        }
        entry._standbyMuted = false
        stopSoundInstance(entry)
        entry.startTick = clientTicks

        var built = null
        try {
            built = buildSoundInstance(entry, lv, localPlayer)
        } catch (e) {
            warnOnce(`build:${entry.spec.snd}`, `创建音源实例失败 (${entry.spec.snd}): ${e}`)
            built = null
        }
        if (built == null) {
            removeEntryNow(entry.h)
            return false
        }
        if (built.wait) {
            if (entry.waitSince == null) entry.waitSince = clientTicks
            return true
        }
        entry.waitSince       = null
        entry.inst            = built.inst
        entry.is2D            = built.is2D
        entry.lastSubPingTick = clientTicks
        entry._channelStopped = false
        entry._pausedByMute   = false
        entry.lastSentAlGain  = -1.0
        entry.lastCatMul      = -1.0
        entry.lastSentPos     = isFinite(entry.curX)
            ? { x: Number(entry.curX), y: Number(entry.curY || 0), z: Number(entry.curZ || 0) }
            : null

        var sm = getSoundManager()
        if (sm != null) {
            try {
                var playFn = probeMethodName(sm, ['play', 'm_120367_'], SOUND_MANAGER_OPS, 'playFn')
                if (playFn != null) {
                    sm[playFn](entry.inst)
                } else {
                    warnOnce(`playNoFn:${entry.spec.snd}`, 'SoundManager 缺少 play / m_120367_ 方法，无法播放音频')
                }
            } catch (e) {
                warnOnce(`play:${entry.spec.snd}`, `调用 SoundManager.play 失败 (${entry.spec.snd}): ${e}`)
            }
        }
        return true
    }

    // ======================================================================== 字幕持续触发与 3D 方向指示 + 原版音乐避让

    // 原版 SoundEngine.play(SoundInstance) 在检查 volume <= 0 之前就会先通知所有 SoundEventListener (含 SubtitleOverlay)，
    // 且当 !canStartSilent() && volume <= 0 时会在通知完 SubtitleOverlay 后立即返回，不分配任何 OpenAL 通道或解码音频流！
    // 因此每 24 tick (1.2s) 发送一次 volume=0.0、带 3D 坐标与 LINEAR 衰减的 SimpleSoundInstance，即可零开销保持右下角字幕常驻并实时更新 < > 方向！
    var invokeOnPlaySound = (lsn, inst, weighed) => {
        if (lsn == null) return false
        if (typeof lsn.onPlaySound === 'function') {
            lsn.onPlaySound(inst, weighed)
            return true
        }
        if (typeof lsn.m_7761_ === 'function') {
            lsn.m_7761_(inst, weighed)
            return true
        }
        return false
    }

    var refreshSubtitleForEntry = (entry, sm) => {
        if (entry == null || entry.inst == null || entry.fadingOut || entry.muted) return
        if (!entry.spec.loop) return
        if ((clientTicks - (entry.lastSubPingTick || 0)) < CONFIG.subtitleRefreshTicks) return
        if ((entry.currentAlGain || 0) <= 0.01) return

        entry.lastSubPingTick = clientTicks
        try {
            var resLoc   = new ResourceLocation(entry.spec.snd)
            var getEvtFn = probeMethodName(sm, ['getSoundEvent', 'm_120384_'], SOUND_MANAGER_OPS, 'getEvtFn')
            var weighed  = getEvtFn != null ? sm[getEvtFn](resLoc) : null
            if (weighed == null) return

            var notified = false
            var se = getSoundEngine(sm)
            if (se != null) {
                // SoundEngine.listeners 在 Forge 1.20.1 SRG 中为 f_120231_（f_120229_ 为 queuedSounds）
                var listeners = readJavaField(se, ['listeners', 'f_120231_'], fieldCacheListeners)
                if (listeners != null && typeof listeners.iterator === 'function') {
                    var it = listeners.iterator()
                    while (it.hasNext()) {
                        var lsn = it.next()
                        if (lsn != null) {
                            try {
                                if (invokeOnPlaySound(lsn, entry.inst, weighed)) {
                                    notified = true
                                }
                            } catch (eLsn) {
                                logErrorThrottled('subtitleListener error', eLsn)
                            }
                        }
                    }
                }
            }

            if (!notified) {
                var mc  = getMc()
                // Minecraft.gui 在 Forge 1.20.1 SRG 中为 f_91065_
                var gui = mc != null ? readJavaField(mc, ['gui', 'f_91065_'], fieldCacheMcGui) : null
                // Gui.subtitleOverlay 在 Forge 1.20.1 SRG 中为 f_92996_
                var subOv = gui != null ? readJavaField(gui, ['subtitleOverlay', 'f_92996_'], fieldCacheSubOverlay) : null
                invokeOnPlaySound(subOv, entry.inst, weighed)
            }
        } catch (e) {
            logErrorThrottled('refreshSubtitle error', e)
        }
    }

    var extractNamespaceFromLocation = (loc) => {
        if (loc == null) return null
        try {
            if (typeof loc.getNamespace === 'function') {
                var nsG = String(loc.getNamespace() || '')
                if (nsG) return nsG
            }
        } catch (eGn) { }
        try {
            if (loc.namespace != null && typeof loc.namespace !== 'function') {
                var nsP = String(loc.namespace || '')
                if (nsP) return nsP
            }
        } catch (ePn) { }
        var s = String(loc)
        var cIdx = s.indexOf(':')
        if (cIdx > 0) return s.substring(0, cIdx)
        if (cIdx === 0) return 'minecraft'
        return null
    }

    var instLocCacheByClass = new Map()

    var resolveSoundInstanceLocation = (inst) => {
        if (inst == null) return null
        try {
            if (typeof inst.getLocation === 'function') return inst.getLocation()
        } catch (eGl) { }
        try {
            if (inst.location != null && typeof inst.location !== 'function') return inst.location
        } catch (ePl) { }
        // Forge SRG/纯反射兜底：按实例类缓存 ResourceLocation 字段或零参 getter，不依赖硬编码 SRG 混淆号
        try {
            if (typeof inst.getClass === 'function') {
                var cls = inst.getClass()
                var accessor = instLocCacheByClass.get(cls)
                if (accessor === undefined) {
                    accessor = null
                    var walkCls = cls
                    while (walkCls != null && accessor == null) {
                        try {
                            var methods = walkCls.getDeclaredMethods()
                            for (var mi = 0; mi < methods.length; mi++) {
                                var m = methods[mi]
                                if (m.getParameterCount() === 0 &&
                                    (ResourceLocation != null ? ResourceLocation.equals(m.getReturnType()) : String(m.getReturnType().getName()) === 'net.minecraft.resources.ResourceLocation')) {
                                    m.setAccessible(true)
                                    accessor = { kind: 'method', member: m }
                                    break
                                }
                            }
                        } catch (eMScan) { }
                        if (accessor == null) {
                            try {
                                var fields = walkCls.getDeclaredFields()
                                for (var fi = 0; fi < fields.length; fi++) {
                                    var f = fields[fi]
                                    if (ResourceLocation != null ? ResourceLocation.equals(f.getType()) : String(f.getType().getName()) === 'net.minecraft.resources.ResourceLocation') {
                                        f.setAccessible(true)
                                        accessor = { kind: 'field', member: f }
                                        break
                                    }
                                }
                            } catch (eFScan) { }
                        }
                        walkCls = walkCls.getSuperclass()
                    }
                    instLocCacheByClass.set(cls, accessor)
                }
                if (accessor != null) {
                    return accessor.kind === 'method' ? accessor.member.invoke(inst) : accessor.member.get(inst)
                }
            }
        } catch (eRefl) { }
        return null
    }

    var restoreDuckedVanillaMusic = () => {
        if (duckedMusicInsts.size === 0) return
        var sm = getSoundManager()
        var se = sm != null ? getSoundEngine(sm) : null
        var chanMap = se != null ? readJavaField(se, ['instanceToChannel', 'f_120226_'], fieldCacheChannelMap) : null
        // 当 SoundManager/SoundEngine/instanceToChannel 暂不可用时保留追踪集合，待后续 tick 就绪后立即恢复，防止已暂停音轨永久失联静音
        if (chanMap == null || typeof chanMap.get !== 'function') return
        for (var dInst of Array.from(duckedMusicInsts)) {
            var restoredOrGone = false
            try {
                var chHandle = chanMap.get(dInst)
                if (chHandle == null) {
                    restoredOrGone = true
                } else if (typeof chHandle.execute === 'function') {
                    chHandle.execute((ch) => {
                        if (ch == null) return
                        var stopFn    = probeMethodName(ch, ['stopped', 'm_83680_'], CHANNEL_OPS, 'stopFn')
                        var unpauseFn = probeMethodName(ch, ['unpause', 'm_83678_'], CHANNEL_OPS, 'unpauseFn')
                        if ((stopFn == null || !ch[stopFn]()) && unpauseFn != null) {
                            ch[unpauseFn]()
                        }
                    })
                    restoredOrGone = true
                }
            } catch (eUnpause) {
                logErrorThrottled('duckMusic unpause error', eUnpause)
            }
            if (restoredOrGone) {
                duckedMusicInsts.delete(dInst)
            }
        }
    }

    // 当存在开启了 duckMusic 的自定义 BGM 正在可听范围内播放时，仅温和暂停 minecraft: 原版 MUSIC 频道（停播后自动恢复，不暂停也不误杀其他模组 BGM）
    var tickVanillaMusicDucking = (hasAudibleDuckingBgm) => {
        if (!hasAudibleDuckingBgm) {
            restoreDuckedVanillaMusic()
            return
        }
        if ((clientTicks % CONFIG.musicDuckIntervalTicks) !== 0) return
        if (SoundSource != null && SoundSource.MUSIC != null) {
            var sm = getSoundManager()
            var se = sm != null ? getSoundEngine(sm) : null
            var chanMap = se != null ? readJavaField(se, ['instanceToChannel', 'f_120226_'], fieldCacheChannelMap) : null
            if (chanMap != null && typeof chanMap.entrySet === 'function') {
                var ownInsts = new Set()
                for (var ent of entries.values()) {
                    if (ent != null && ent.inst != null) ownInsts.add(ent.inst)
                }
                try {
                    var it = chanMap.entrySet().iterator()
                    while (it.hasNext()) {
                        var kv       = it.next()
                        var inst     = kv != null ? kv.getKey() : null
                        var chHandle = kv != null ? kv.getValue() : null
                        if (inst == null || chHandle == null || ownInsts.has(inst)) continue
                        var srcFn  = probeMethodName(inst, ['getSource', 'm_7492_'], INST_OPS, 'srcFn')
                        var srcCat = srcFn != null ? inst[srcFn]() : null
                        if (srcCat == null || (srcCat !== SoundSource.MUSIC && String(srcCat) !== String(SoundSource.MUSIC))) {
                            continue
                        }
                        // 按音频资源位置命名空间严格过滤：仅暂停原版 'minecraft' 音乐，彻底放行其他模组 BGM
                        var instLoc = resolveSoundInstanceLocation(inst)
                        var instNs  = extractNamespaceFromLocation(instLoc)
                        if (instNs != null && instNs !== 'minecraft') {
                            continue
                        }
                        if (!duckedMusicInsts.has(inst) && typeof chHandle.execute === 'function') {
                            chHandle.execute((ch) => {
                                if (ch == null) return
                                var stopFn  = probeMethodName(ch, ['stopped', 'm_83680_'], CHANNEL_OPS, 'stopFn')
                                var pauseFn = probeMethodName(ch, ['pause', 'm_83677_'], CHANNEL_OPS, 'pauseFn')
                                if ((stopFn == null || !ch[stopFn]()) && pauseFn != null) {
                                    ch[pauseFn]()
                                }
                            })
                            duckedMusicInsts.add(inst)
                        }
                    }
                } catch (e) {
                    logErrorThrottled('duckMusic pauseSource error', e)
                }
            }
        }
        // 仅当未持有已暂停原版音轨时推迟原版 MusicManager 下一首计时，防止 stopPlaying 意外销毁刚暂停的原版音乐
        if (duckedMusicInsts.size === 0) {
            var m = getMc()
            if (m != null) {
                try {
                    var mm = probeMember(m, ['getMusicManager', 'm_91107_'], ['musicManager', 'f_91043_'], MC_MM_CAP)
                    if (mm != null && typeof mm.stopPlaying === 'function') {
                        mm.stopPlaying()
                    }
                } catch (e) {
                    logErrorThrottled('duckMusic stopPlaying error', e)
                }
            }
        }
    }

    // ======================================================================== 网络指令解析与应用

    var parsePlaySpec = (d) => {
        var snd = readStr(d, 'snd', '')
        if (!snd || !/^[a-z0-9_.\-]+:[a-z0-9_.\-\/]+$/.test(snd)) return null
        var anc = readStr(d, 'anc', 'none')
        if (anc !== 'pos' && anc !== 'entity') anc = 'none'
        var mode = readStr(d, 'mode', 'flat')
        if (mode !== 'linear' && mode !== 'cutoff' && mode !== 'smooth') mode = 'flat'
        var cat     = readStr(d, 'cat', 'RECORDS')
        var loop    = readFlag(d, 'loop', false)
        var eidRaw  = readNum(d, 'eid', null)
        var defDuck = loop && (cat === 'RECORDS' || cat === 'MUSIC')
        var outMode = readStr(d, 'omode', loop ? 'mute' : 'stop')
        if (outMode !== 'mute' && outMode !== 'stop') outMode = 'stop'
        var tierStr = readStr(d, 'tier', 'system')
        var priRaw  = readNum(d, 'pri', null)
        return {
            snd:     snd,
            tier:    (tierStr === 'player') ? 'player' : 'system',
            pri:     (priRaw !== null && isFinite(priRaw)) ? priRaw : 2,
            outMode: outMode,
            cat:     cat,
            vol:     clampNum(readNum(d, 'vol', 1.0), 0.0, 2.0),
            pit:     clampNum(readNum(d, 'pit', 1.0), 0.5, 2.0),
            loop:    loop,
            resume:  readFlag(d, 'resume', true),
            duck:    readFlag(d, 'duck', defDuck),
            mode:    mode,
            anc:     anc,
            x:       readNum(d, 'x', 0.0),
            y:       readNum(d, 'y', 0.0),
            z:       readNum(d, 'z', 0.0),
            rng:     max2(1.0, readNum(d, 'rng', 32.0)),
            fadeIn:  max2(0, Math.round(readNum(d, 'fin', 0))),
            fadeOut: max2(0, Math.round(readNum(d, 'fout', 0))),
            dim:     readStr(d, 'dim', null),
            eid:     (eidRaw !== null && isFinite(eidRaw)) ? Math.floor(eidRaw) : null
        }
    }

    var applyActionNow = (raw, lv, localPlayer) => {
        if (raw == null) return
        var act = readStr(raw, 'act', '')
        var ses = readStr(raw, 'ses', null)

        if (ses != null && ses !== session) {
            clearAllNow()
            attCache.clear()
            missingSoundUntil.clear()
            session = ses
        }

        if (act === 'reset') {
            clearAllNow()
            attCache.clear()
            missingSoundUntil.clear()
            return
        }

        var hRaw = readNum(raw, 'h', null)
        if (hRaw === null || !isFinite(hRaw)) return
        var h = Math.floor(hRaw)

        if (act === 'mute') {
            var mTarget = entries.get(h)
            if (mTarget != null) {
                mTarget.muted = readFlag(raw, 'muted', true)
            }
            return
        }

        if (act === 'stop') {
            var existing = entries.get(h)
            if (existing == null) return
            var fadeTicks = Math.round(readNum(raw, 'fout', existing.spec.fadeOut || 0))
            if (fadeTicks > 0 && existing.inst != null) {
                existing.fadingOut     = true
                existing.fadeSpanTicks = fadeTicks
                existing.fadeEndTick   = clientTicks + fadeTicks
            } else {
                removeEntryNow(h)
            }
            return
        }

        if (act === 'update') {
            var target = entries.get(h)
            if (target == null) return
            var nextVol  = readNum(raw, 'vol', null)
            var nextPit  = readNum(raw, 'pit', null)
            var nextRng  = readNum(raw, 'rng', null)
            var nextX    = readNum(raw, 'x', null)
            var nextY    = readNum(raw, 'y', null)
            var nextZ    = readNum(raw, 'z', null)
            var nextEid  = readNum(raw, 'eid', null)
            var nextFout = readNum(raw, 'fout', null)

            if (nextVol !== null && isFinite(nextVol)) target.spec.vol = clampNum(nextVol, 0.0, 2.0)
            if (nextPit !== null && isFinite(nextPit)) target.spec.pit = clampNum(nextPit, 0.5, 2.0)
            if (nextRng !== null && isFinite(nextRng)) target.spec.rng = max2(1.0, nextRng)
            if (nextFout !== null && isFinite(nextFout)) target.spec.fadeOut = max2(0, Math.round(nextFout))
            if (nextEid !== null && isFinite(nextEid)) target.spec.eid = Math.floor(nextEid)
            if (nextX !== null && isFinite(nextX) && nextY !== null && isFinite(nextY) && nextZ !== null && isFinite(nextZ)) {
                target.spec.x = nextX
                target.spec.y = nextY
                target.spec.z = nextZ
                target.curX   = nextX
                target.curY   = nextY
                target.curZ   = nextZ
            }
            return
        }

        if (act === 'play') {
            var spec = parsePlaySpec(raw)
            if (spec == null) {
                warnOnce('badpkt', '收到无效的 play 数据包（缺少合法的 snd 字段）')
                return
            }
            var restartFlag = readFlag(raw, 'rst', true)
            if (entries.has(h)) {
                var cur = entries.get(h)
                // 若玩家刚离开范围触发软淡出又在淡出结束前折返，直接取消淡出继续播放，不打断音乐流
                if ((!restartFlag || cur.fadingOut) && cur.inst != null && cur.spec.snd === spec.snd) {
                    var sm = getSoundManager()
                    var stillActive = true
                    if (sm != null) {
                        try {
                            var activeFn = probeMethodName(sm, ['isActive', 'm_120404_'], SOUND_MANAGER_OPS, 'activeFn')
                            if (activeFn != null) stillActive = Boolean(sm[activeFn](cur.inst))
                        } catch (e) {
                            logErrorThrottled('sm.isActive error', e)
                        }
                    }
                    if (stillActive) {
                        cur.spec      = spec
                        cur.tier      = (spec.tier === 'player') ? 'player' : 'system'
                        cur.priority  = (spec.pri != null && isFinite(Number(spec.pri))) ? Number(spec.pri) : (cur.priority != null ? cur.priority : 2)
                        cur.fadingOut = false
                        cur.curX      = spec.x
                        cur.curY      = spec.y
                        cur.curZ      = spec.z
                        return
                    }
                }
                removeEntryNow(h)
            }
            if (entries.size >= CONFIG.maxEntries) {
                warnOnce('maxEntries', `客户端同时维护的音频句柄已达上限 (${CONFIG.maxEntries})，将淘汰最旧低优先级句柄`)
            }
            while (entries.size >= CONFIG.maxEntries) {
                evictOldestEntry()
            }
            var entry = {
                h:               h,
                spec:            spec,
                tier:            (spec.tier === 'player') ? 'player' : 'system',
                priority:        (spec.pri != null && isFinite(Number(spec.pri))) ? Number(spec.pri) : 2,
                catObj:          null,
                inst:            null,
                is2D:            false,
                curX:            spec.x,
                curY:            spec.y,
                curZ:            spec.z,
                currentAlGain:   clampNum(spec.vol, 0.0, 2.0),
                currentAlPitch:  clampNum(spec.pit, 0.5, 2.0),
                muted:           false,
                smoothGain:      clampNum(spec.vol, 0.0, 2.0),
                lastSentAlGain:  -1.0,
                fadingOut:       false,
                fadeSpanTicks:   0,
                fadeEndTick:     0,
                created:         clientTicks,
                startTick:       clientTicks,
                lastSubPingTick: 0,
                waitSince:       null,
                retryAt:         0,
                retryDelay:      CONFIG.resumeMinDelayTicks,
                _channelStopped: false
            }
            entries.set(h, entry)
            tryStartEntry(entry, lv, localPlayer)
        }
    }

    var enqueueAction = (data) => {
        if (data != null) pendingActions.push(data)
    }

    var flushPendingActions = (lv, localPlayer) => {
        if (pendingActions.length === 0) return
        var batch = pendingActions
        pendingActions = []
        for (var action of batch) {
            try {
                applyActionNow(action, lv, localPlayer)
            } catch (e) {
                logErrorThrottled('applyAction error', e)
            }
        }
    }

    var protoMismatchWarned = false

    NetworkEvents.dataReceived(CHANNEL, (event) => {
        try {
            var pkt = event.data
            var incomingProto = (pkt != null) ? readNum(pkt, 'proto', null) : null
            if (!checkProtoCompatible(PROTO_VERSION, incomingProto)) {
                if (!protoMismatchWarned) {
                    protoMismatchWarned = true
                    console.error(`[EpiphyAudioClient] 协议校验失败（已拒收报文）：服务端 proto=${String(incomingProto)}，客户端预期 proto=${PROTO_VERSION}，请同步双端脚本。`)
                }
                return
            }
            enqueueAction(pkt)
        } catch (e) {
            logErrorThrottled('dataReceived error', e)
        }
    })

    // ======================================================================== 客户端 Tick 驱动与巡检

    var prepareEntriesForResume = () => {
        // 清空衰减缓存：兼容 F3+T 资源包重载（LoadingOverlay 结束）或设备切换后音效 attenuation_distance 变更
        attCache.clear()
        missingSoundUntil.clear()
        for (var e of entries.values()) {
            if (e == null) continue
            e.lastSentAlGain    = -1.0
            e.lastSubPingTick   = 0
            e._channelStopped   = false
            e._resumeReconnected = false
        }
    }

    var tickActiveEntries = (lv, localPlayer, forceResync) => {
        var playerPos = getEntityPos(localPlayer)
        var sm        = getSoundManager()
        var hasAudibleDuckingBgm = false
        var forceSync = Boolean(forceResync)

        for (var h of Array.from(entries.keys())) {
            var entry = entries.get(h)
            if (entry == null || entry.inst == null) continue

            if (entry.fadingOut && clientTicks >= entry.fadeEndTick) {
                removeEntryNow(h)
                continue
            }

            if (entry.spec.anc === 'entity' && entry.spec.eid != null) {
                var ent = getEntityById(lv, entry.spec.eid)
                if (ent != null) {
                    var ePos = getEntityPos(ent)
                    if (ePos != null) {
                        entry.curX = ePos.x
                        entry.curY = ePos.y
                        entry.curZ = ePos.z
                    }
                }
            }

            var targetGain = computeAudibleGain(entry, playerPos)
            if (entry.smoothGain === undefined || entry.smoothGain === null || !isFinite(entry.smoothGain)) {
                entry.smoothGain = targetGain
            } else {
                entry.smoothGain += (targetGain - entry.smoothGain) * 0.25
                if (Math.abs(targetGain - entry.smoothGain) < 0.004) entry.smoothGain = targetGain
            }
            entry.currentAlGain = entry.smoothGain

            if (sm != null) {
                if (!entry.is2D && entry.inst != null && isFinite(entry.curX)) {
                    var lp = entry.lastSentPos
                    var posChanged = forceSync || lp == null ||
                        ((entry.curX - lp.x) * (entry.curX - lp.x) +
                         (entry.curY - lp.y) * (entry.curY - lp.y) +
                         (entry.curZ - lp.z) * (entry.curZ - lp.z)) > 0.01
                    if (posChanged) {
                        applyChannelPosition(sm, entry, entry.curX, entry.curY, entry.curZ)
                        entry.lastSentPos = { x: Number(entry.curX), y: Number(entry.curY || 0), z: Number(entry.curZ || 0) }
                    }
                }
                var curCatMul = getCategoryGainMultiplier(entry.catObj)
                var mulChanged = Math.abs(curCatMul - (entry.lastCatMul != null ? entry.lastCatMul : -1)) > 0.004
                if (forceSync || mulChanged || Math.abs(entry.currentAlGain - (entry.lastSentAlGain != null ? entry.lastSentAlGain : -1)) > 0.004 || (entry.currentAlGain === 0.0 && entry.lastSentAlGain !== 0.0)) {
                    applyChannelGain(sm, entry, entry.currentAlGain, forceSync)
                    entry.lastSentAlGain = entry.currentAlGain
                }
                refreshSubtitleForEntry(entry, sm)
            }

            if (entry.spec.duck && !entry.fadingOut && !entry.muted && entry.currentAlGain > 0.008) {
                hasAudibleDuckingBgm = true
            }
        }

        tickVanillaMusicDucking(hasAudibleDuckingBgm)
    }

    var sweepEntries = (lv, localPlayer) => {
        var sm = getSoundManager()
        if (sm == null) return

        for (var h of Array.from(entries.keys())) {
            var entry = entries.get(h)
            if (entry == null) continue

            if (entry.inst == null) {
                if (!entry._standbyMuted && entry.waitSince != null && (clientTicks - entry.waitSince) > CONFIG.pendingTimeoutTicks) {
                    removeEntryNow(h)
                } else if (clientTicks >= entry.retryAt) {
                    tryStartEntry(entry, lv, localPlayer)
                }
                continue
            }

            // 刚启动的前 20 tick 处于异步音频流初始化窗口，跳过断流判定
            if ((clientTicks - entry.startTick) < 20) continue

            var active = true
            if (entry._channelStopped === true) {
                active = false
            } else {
                try {
                    var activeFnSweep = probeMethodName(sm, ['isActive', 'm_120404_'], SOUND_MANAGER_OPS, 'activeFn')
                    if (activeFnSweep != null) active = Boolean(sm[activeFnSweep](entry.inst))
                } catch (e) {
                    logErrorThrottled('sweep sm.isActive error', e)
                    active = true
                }
            }
            if (active) {
                if ((clientTicks - entry.startTick) >= CONFIG.stableTicks) {
                    entry.retryDelay = CONFIG.resumeMinDelayTicks
                }
                continue
            }

            if (entry.fadingOut || !entry.spec.loop) {
                removeEntryNow(h)
                continue
            }

            // 循环音源意外中断（如切换音频设备、F3+T 重载资源包或切屏被底层回收）：静音待命时不空转重连，恢复可听后再重启
            var curMulSweep = getCategoryGainMultiplier(entry.catObj)
            var isMutedStandby = (curMulSweep <= 0.0001) || ((entry.currentAlGain || 0) <= 0.0001 && entry.spec.outMode === 'mute')
            stopSoundInstance(entry)
            if (isMutedStandby) {
                entry._standbyMuted = true
                entry.retryAt       = clientTicks + 10
                entry.retryDelay    = CONFIG.resumeMinDelayTicks
                continue
            }
            if (entry.spec.resume) {
                var resumeImmediate = (clientTicks <= postResumeResyncUntil && !entry._resumeReconnected)
                var quickFail = !resumeImmediate && (clientTicks - entry.startTick) < CONFIG.stableTicks
                if (resumeImmediate) entry._resumeReconnected = true
                entry.retryAt = clientTicks + (quickFail ? entry.retryDelay : 0)
                if (quickFail) {
                    entry.retryDelay = min2(entry.retryDelay * 2, CONFIG.resumeMaxDelayTicks)
                }
                entry.waitSince = null
                if (!quickFail) {
                    tryStartEntry(entry, lv, localPlayer)
                }
            } else {
                removeEntryNow(h)
            }
        }
    }

    ClientEvents.tick((event) => {
        try {
            var pausedNow       = isClientPaused()
            var windowActiveNow = isClientWindowActive()
            var screenOpenNow   = hasCurrentScreenOpen()

            if (pausedNow) {
                wasPaused         = true
                wasWindowInactive = !windowActiveNow
                wasScreenOpen     = screenOpenNow
                return
            }

            var resumedNow = false
            if (wasPaused) {
                wasPaused  = false
                resumedNow = true
            }
            if (wasWindowInactive && windowActiveNow) {
                resumedNow = true
            }
            if (wasScreenOpen && !screenOpenNow) {
                resumedNow = true
            }
            wasWindowInactive = !windowActiveNow
            wasScreenOpen     = screenOpenNow

            if (resumedNow) {
                // ESC/暂停界面关闭或切屏切回窗口时，立刻强制重同步各活跃通道增益、尝试唤醒 OpenAL 暂停态并放行断流巡检，无需等待玩家移动
                postResumeResyncUntil = clientTicks + 12
                prepareEntriesForResume()
            }

            clientTicks++
            var lv          = resolveClientLevel(event)
            var localPlayer = resolveClientPlayer(event)
            var dimKey      = extractDimensionId(lv)

            if (dimKey != null) {
                lastLevelKey = dimKey
            }

            flushPendingActions(lv, localPlayer)

            if (entries.size === 0) {
                restoreDuckedVanillaMusic()
                return
            }
            if (lv == null) return

            var inResumeWindow = (clientTicks <= postResumeResyncUntil)
            tickActiveEntries(lv, localPlayer, inResumeWindow)
            if (inResumeWindow || (clientTicks % CONFIG.sweepIntervalTicks === 0)) {
                sweepEntries(lv, localPlayer)
            }
        } catch (e) {
            logErrorThrottled('clientTick error', e)
        }
    })

    var resetClientState = () => {
        clearAllNow()
        duckedMusicInsts.clear()
        attCache.clear()
        missingSoundUntil.clear()
        pendingActions.length = 0
        lastLevelKey          = ''
        wasPaused             = false
        wasWindowInactive     = false
        wasScreenOpen         = false
        postResumeResyncUntil = 0
    }
    ClientEvents.loggedOut(() => {
        resetClientState()
        session = null
    })
    ClientEvents.loggedIn(() => {
        resetClientState()
    })

    global.EpiphyAudioClient = {
        VERSION: VERSION,
        CONFIG:  CONFIG,
        count: () => entries.size + pendingActions.length,
        list: () => {
            var out = []
            for (var e of entries.values()) {
                out.push({
                    h:         e.h,
                    sound:     e.spec.snd,
                    anchor:    e.spec.anc,
                    mode:      e.spec.mode,
                    loop:      e.spec.loop,
                    volume:    e.spec.vol,
                    gain:      e.currentAlGain,
                    pitch:     e.spec.pit,
                    x:         e.curX,
                    y:         e.curY,
                    z:         e.curZ,
                    fadingOut: e.fadingOut,
                    playing:   e.inst != null
                })
            }
            return out
        },
        stopAll: () => {
            pendingActions.length = 0
            clearAllNow()
        },
        _pure: {
            getProtocolState: () => ({
                channel:              CHANNEL,
                protoVersion:         PROTO_VERSION,
                checkProtoCompatible: checkProtoCompatible
            })
        }
    }
})()
