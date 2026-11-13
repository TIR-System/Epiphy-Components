// ============================================================================
//  通用空间音频与流式声场组件 —— 客户端播放引擎 (EpiphyAudioClient v5.2, ES6)
//  所属系列：Epiphy的-通用组件系列（本系列包含 startup / server / client 配套脚本）
//  [LLM 协作规范] 每次进行较大修改或重构前，请先将修改同步至 D:\Git-Epiphy 并执行 git commit 保存当前可用状态，便于随时回退与对比 diff。
//  许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
//  放置位置：kubejs/client_scripts/通用组件/Epiphy的-音频播放器.js
//  配套服务端组件：
//    - kubejs/server_scripts/通用组件/Epiphy的-音频组件.js（服务端调度器 EpiphyAudio v5.2）
//    - kubejs/server_scripts/通用组件/Epiphy的-权限阀.js（/epiphy 指令注册中心与权限阀）
//
//  依赖与缺失降级行为：
//    - 必需配套：kubejs/server_scripts/通用组件/Epiphy的-音频组件.js（缺失时客户端处于待命状态，无音频数据包驱动）
//    - 协议契约：kubejs/startup_scripts/通用组件/Epiphy的-协议常量.js (EpiphyProtocol, priority: 1200)
//      缺失时启动输出 console.warn 并回退至内联兜底常量（协议版本 5）；
//      收包时始终执行 fail-closed 协议校验，缺 proto 或版本不匹配会输出 console.error 并直接拒收。
//
//  适用环境：Minecraft 1.20.1 / Forge 47.x / KubeJS 2001.6.x (ES6)
//
//  [Rhino 语法兼容性约定] KubeJS 2001.6.x 内置 Rhino 对 ES6 支持不完整且存在语义偏差（如 `let`/`const`
//    的 TDZ 与循环闭包语义偏差）。故本播放器仅使用经本服实测稳定的 ES6 子集（`=>` / 模板字符串 /
//    `for..of` / `Map` / `Set`），所有变量声明统一使用 `var`；同系列弹幕客户端与服务端底座维持 ES5。请勿引入 `let`/`const`。
// ============================================================================

;(() => {
    var PROTO         = (typeof global !== 'undefined' && global.EpiphyProtocol != null) ? global.EpiphyProtocol : null
    var CHANNEL       = (PROTO && PROTO.AUDIO_CHANNEL) || 'epiphy:audio'
    var PROTO_VERSION = (PROTO && PROTO.AUDIO_PROTO_VERSION) || 5
    var VERSION       = (PROTO && PROTO.AUDIO_SEMVER) || '5.2.0'
    if (PROTO == null) {
        console.warn(`[EpiphyAudioClient] 未检测到 startup_scripts/通用组件/Epiphy的-协议常量.js (EpiphyProtocol)，将使用内联兜底协议版本 ${PROTO_VERSION}；若双端版本不一致将拒收报文。`)
    }

    var CONFIG = {
        sweepIntervalTicks:     10,   // 慢速巡检周期（负责死链清理、异常断流重连、超时判定）
        subtitleRefreshTicks:   24,   // 循环音源字幕保活与 3D 方向刷新周期 (1.2s，小于原版 3s 过期时间)
        musicDuckIntervalTicks: 10,   // 原版背景音乐避让巡检周期 (0.5s)
        pendingTimeoutTicks:    200,  // 跨维度加载或实体未同步时的最长等待 (tick)
        resumeMinDelayTicks:    10,   // 循环音源意外中断后的初始退避重连间隔 (tick)
        resumeMaxDelayTicks:    200,  // 循环音源退避重连最大间隔 (tick)
        stableTicks:            80,   // 音源连续稳定播放超过该时长后重置退避计数 (tick)
        maxEntries:             128,  // 客户端同时维护的最大句柄数
        defaultFadeOutTicks:    12,   // 默认软停止淡出时长 (tick)
        errorLogIntervalMs:     5000  // 限频错误日志间隔 (ms)
    }

    var Minecraft           = null
    var ResourceLocation    = null
    var SoundSource         = null
    var RandomSource        = null
    var SimpleSoundInstance = null
    var Attenuation         = null
    var SystemClass         = null

    try { Minecraft           = Java.loadClass('net.minecraft.client.Minecraft') } catch (e) {}
    try { ResourceLocation    = Java.loadClass('net.minecraft.resources.ResourceLocation') } catch (e) {}
    try { SoundSource         = Java.loadClass('net.minecraft.sounds.SoundSource') } catch (e) {}
    try { RandomSource        = Java.loadClass('net.minecraft.util.RandomSource') } catch (e) {}
    try { SimpleSoundInstance = Java.loadClass('net.minecraft.client.resources.sounds.SimpleSoundInstance') } catch (e) {}
    try { Attenuation         = Java.loadClass('net.minecraft.client.resources.sounds.SoundInstance$Attenuation') } catch (e) {}
    try { SystemClass         = Java.loadClass('java.lang.System') } catch (e) {}

    var RANDOM          = RandomSource != null ? RandomSource.create() : null
    var entries         = new Map() // handleId (number) -> entry
    var attCache        = new Map() // soundId -> attenuation_distance
    var warnedKeys      = new Set()
    var pendingActions    = []
    var session           = null
    var clientTicks       = 0
    var wasPaused         = false
    var unpauseGraceUntil = 0
    var lastLevelKey      = ''
    var lastErrorLogAt    = 0
    var suppressedErrors  = 0

    // ======================================================================== 基础工具

    var min2 = (a, b) => (a < b ? a : b)
    var max2 = (a, b) => (a > b ? a : b)
    var clampNum = (v, lo, hi) => (v < lo ? lo : (v > hi ? hi : v))

    var monotonicNowMs = () => {
        if (SystemClass != null) {
            try { return Number(SystemClass.nanoTime()) / 1000000.0 } catch (e) {}
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

    var warnOnce = (key, msg) => {
        if (warnedKeys.has(key)) return
        warnedKeys.add(key)
        console.warn(`[EpiphyAudioClient] ${msg}`)
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

    // ======================================================================== 客户端环境安全读取

    var getMc = () => {
        if (Minecraft != null) {
            try { return Minecraft.getInstance() } catch (e) {}
        }
        if (typeof Client !== 'undefined' && Client != null) return Client
        return null
    }

    var isClientPaused = () => {
        var m = getMc()
        if (m == null) return false
        try {
            if (typeof m.isPaused === 'function') return Boolean(m.isPaused())
            if (m.paused !== undefined) return Boolean(m.paused)
        } catch (e) {}
        return false
    }

    var getSoundManager = () => {
        var m = getMc()
        if (m != null) {
            try {
                if (typeof m.getSoundManager === 'function') return m.getSoundManager()
                if (m.soundManager != null) return m.soundManager
            } catch (e) {}
        }
        return null
    }

    var resolveClientLevel = (event) => {
        if (event != null) {
            try {
                var elv = typeof event.getLevel === 'function' ? event.getLevel() : event.level
                if (elv != null) return elv
            } catch (e) {}
        }
        if (typeof Client !== 'undefined' && Client != null) {
            try {
                if (typeof Client.getCurrentLevel === 'function') {
                    var clv = Client.getCurrentLevel()
                    if (clv != null) return clv
                }
            } catch (e) {}
            try {
                if (Client.level != null) return Client.level
            } catch (e) {}
        }
        var m = getMc()
        if (m != null) {
            try {
                var cam = m.getCameraEntity()
                if (cam != null) {
                    var camLv = typeof cam.level === 'function' ? cam.level() : cam.level
                    if (camLv != null) return camLv
                }
            } catch (e) {}
        }
        return null
    }

    var resolveClientPlayer = (event) => {
        if (event != null) {
            try {
                var ep = typeof event.getPlayer === 'function' ? event.getPlayer() : event.player
                if (ep != null) return ep
            } catch (e) {}
        }
        if (typeof Client !== 'undefined' && Client != null) {
            try {
                if (Client.player != null) return Client.player
            } catch (e) {}
        }
        var m = getMc()
        if (m != null) {
            try {
                var cam = m.getCameraEntity()
                if (cam != null) return cam
            } catch (e) {}
        }
        return null
    }

    var extractDimensionId = (lv) => {
        if (lv == null) return null
        try {
            if (typeof lv.getDimension === 'function') {
                var gd = lv.getDimension()
                if (gd != null && String(gd).length > 0) return String(gd)
            }
        } catch (e) {}
        try {
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
        } catch (e) {}
        return null
    }

    // 注意：KubeJS 6 的 EntityKJS 仅定义了 setX/setY/setZ（只写 setter），直接读取 ent.x 会返回 null/undefined，
    // 而 Number(null) === 0 会导致坐标被误判为 (0,0,0)！必须优先调用 getX()/getY()/getZ() 或读取 ent.block。
    var getEntityPos = (ent) => {
        if (ent == null) return null
        try {
            if (typeof ent.getX === 'function' && typeof ent.getY === 'function' && typeof ent.getZ === 'function') {
                var x = Number(ent.getX())
                var y = Number(ent.getY())
                var z = Number(ent.getZ())
                if (isFinite(x) && isFinite(y) && isFinite(z)) return { x: x, y: y, z: z }
            }
        } catch (e) {}
        try {
            var b = ent.block
            if (b != null && b.x != null && b.y != null && b.z != null) {
                var bx = Number(b.x)
                var by = Number(b.y)
                var bz = Number(b.z)
                if (isFinite(bx) && isFinite(by) && isFinite(bz)) return { x: bx, y: by, z: bz }
            }
        } catch (e) {}
        try {
            if (ent.x != null && ent.y != null && ent.z != null) {
                var rx = Number(ent.x)
                var ry = Number(ent.y)
                var rz = Number(ent.z)
                if (isFinite(rx) && isFinite(ry) && isFinite(rz)) return { x: rx, y: ry, z: rz }
            }
        } catch (e) {}
        return null
    }

    var getEntityById = (lv, eid) => {
        if (lv == null || eid == null) return null
        try {
            if (typeof lv.getEntity === 'function') return lv.getEntity(Number(eid))
        } catch (e) {}
        return null
    }

    var resolveSoundSource = (catName) => {
        if (SoundSource == null) return null
        try {
            var c = SoundSource.valueOf(String(catName || 'RECORDS'))
            if (c != null) return c
        } catch (e) {}
        return SoundSource.RECORDS
    }

    var getAttenuationDistance = (soundId) => {
        if (attCache.has(soundId)) return attCache.get(soundId)
        var att = 16
        var sm = getSoundManager()
        if (sm != null && ResourceLocation != null) {
            try {
                var weighed = sm.getSoundEvent(new ResourceLocation(String(soundId)))
                if (weighed == null) {
                    att = -1
                } else if (RANDOM != null && typeof weighed.getSound === 'function') {
                    var snd = weighed.getSound(RANDOM)
                    if (snd != null && typeof snd.getAttenuationDistance === 'function') {
                        var a = Number(snd.getAttenuationDistance())
                        if (isFinite(a) && a > 0) att = a
                    }
                }
            } catch (e) {
                att = 16
            }
        }
        attCache.set(soundId, att)
        return att
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

    var cachedSoundEngineField   = null
    var cachedChannelMapField    = null
    var cachedListenersField     = null
    var cachedSubOverlayField    = null

    var readJavaField = (obj, names) => {
        if (obj == null) return null
        for (var i = 0; i < names.length; i++) {
            var nm = names[i]
            try {
                if (obj[nm] !== undefined && obj[nm] !== null) return obj[nm]
            } catch (e0) {}
        }
        try {
            var cls = obj.getClass()
            while (cls != null) {
                for (var j = 0; j < names.length; j++) {
                    try {
                        var fld = cls.getDeclaredField(names[j])
                        fld.setAccessible(true)
                        return fld.get(obj)
                    } catch (e1) {}
                }
                cls = cls.getSuperclass()
            }
        } catch (e2) {}
        return null
    }

    var getSoundEngine = (sm) => {
        if (sm == null) return null
        if (cachedSoundEngineField != null) {
            try { return cachedSoundEngineField.get(sm) } catch (e) {}
        }
        var se = readJavaField(sm, ['soundEngine', 'f_120349_'])
        if (se != null) return se
        return null
    }

    var getCategoryGainMultiplier = (catObj) => {
        var m = getMc()
        if (m == null) return 1.0
        try {
            var opts = typeof m.options === 'object' ? m.options : (typeof m.getOptions === 'function' ? m.getOptions() : null)
            if (opts != null && typeof opts.getSoundSourceVolume === 'function') {
                var masterVol = Number(opts.getSoundSourceVolume(SoundSource.MASTER))
                var catVol    = catObj != null ? Number(opts.getSoundSourceVolume(catObj)) : 1.0
                if (isFinite(masterVol) && isFinite(catVol)) {
                    return clampNum(masterVol * catVol, 0.0, 1.0)
                }
            }
        } catch (e) {}
        return 1.0
    }

    var applyChannelGain = (sm, entry, gain) => {
        if (sm == null || entry == null || entry.inst == null) return
        var se = getSoundEngine(sm)
        if (se == null) return
        var chanMap = readJavaField(se, ['instanceToChannel', 'f_120220_'])
        if (chanMap == null || typeof chanMap.get !== 'function') return
        var chHandle = chanMap.get(entry.inst)
        if (chHandle == null || typeof chHandle.execute !== 'function') return

        var mul = getCategoryGainMultiplier(entry.catObj)
        var finalGain = clampNum(gain * mul, 0.0, 2.0)
        try {
            chHandle.execute((ch) => {
                try { ch.setVolume(finalGain) } catch (e0) {}
            })
        } catch (e1) {}
    }

    var buildSoundInstance = (entry, lv, localPlayer) => {
        var spec = entry.spec
        if (getAttenuationDistance(spec.snd) < 0) {
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

        var localId = null
        if (localPlayer != null) {
            try { localId = Number(localPlayer.getId()) } catch (e) {}
        }
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
            try { sm.stop(entry.inst) } catch (e) {}
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
        for (var entry of entries.values()) {
            stopSoundInstance(entry)
        }
        entries.clear()
    }

    var evictOldestEntry = () => {
        var oldest = null
        for (var cand of entries.values()) {
            if (oldest == null || cand.created < oldest.created) {
                oldest = cand
            }
        }
        if (oldest != null) removeEntryNow(oldest.h)
    }

    var tryStartEntry = (entry, lv, localPlayer) => {
        if (lv == null) {
            if (entry.waitSince == null) entry.waitSince = clientTicks
            return true
        }
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

        var sm = getSoundManager()
        if (sm != null) {
            try {
                sm.play(entry.inst)
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
    var refreshSubtitleForEntry = (entry, sm) => {
        if (entry == null || entry.inst == null || entry.fadingOut || entry.muted) return
        if (!entry.spec.loop) return
        if ((clientTicks - (entry.lastSubPingTick || 0)) < CONFIG.subtitleRefreshTicks) return
        if ((entry.currentAlGain || 0) <= 0.01) return

        entry.lastSubPingTick = clientTicks
        try {
            var resLoc  = new ResourceLocation(entry.spec.snd)
            var weighed = sm.getSoundEvent(resLoc)
            if (weighed == null) return

            var notified = false
            var se = getSoundEngine(sm)
            if (se != null) {
                var listeners = readJavaField(se, ['listeners', 'f_120229_'])
                if (listeners != null && typeof listeners.iterator === 'function') {
                    var it = listeners.iterator()
                    while (it.hasNext()) {
                        var lsn = it.next()
                        if (lsn != null && typeof lsn.onPlaySound === 'function') {
                            try {
                                lsn.onPlaySound(entry.inst, weighed)
                                notified = true
                            } catch (eLsn) {}
                        }
                    }
                }
            }

            if (!notified) {
                var mc = getMc()
                var gui = mc != null ? mc.gui : null
                var subOv = gui != null ? readJavaField(gui, ['subtitleOverlay', 'f_93006_']) : null
                if (subOv != null && typeof subOv.onPlaySound === 'function') {
                    subOv.onPlaySound(entry.inst, weighed)
                }
            }
        } catch (e) {}
    }

    // 当存在开启了 duckMusic 的自定义 BGM 正在可听范围内播放时，令原版背景音乐自动避让
    var tickVanillaMusicDucking = (hasAudibleDuckingBgm) => {
        if (!hasAudibleDuckingBgm) return
        if ((clientTicks % CONFIG.musicDuckIntervalTicks) !== 0) return
        var m = getMc()
        if (m != null) {
            try {
                var mm = typeof m.getMusicManager === 'function' ? m.getMusicManager() : m.musicManager
                if (mm != null && typeof mm.stopPlaying === 'function') {
                    mm.stopPlaying()
                }
            } catch (e) {}
        }
        if (SoundSource != null && SoundSource.MUSIC != null) {
            var sm = getSoundManager()
            if (sm != null) {
                try { sm.stop(null, SoundSource.MUSIC) } catch (e) {}
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
        return {
            snd:     snd,
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
            session = ses
        }

        if (act === 'reset') {
            clearAllNow()
            attCache.clear()
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
                        try { stillActive = Boolean(sm.isActive(cur.inst)) } catch (e) {}
                    }
                    if (stillActive) {
                        cur.spec      = spec
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
                warnOnce('maxEntries', `客户端同时维护的音频句柄已达上限 (${CONFIG.maxEntries})，将淘汰最旧句柄`)
            }
            while (entries.size >= CONFIG.maxEntries) {
                evictOldestEntry()
            }
            var entry = {
                h:               h,
                spec:            spec,
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
                retryDelay:      CONFIG.resumeMinDelayTicks
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

    var checkProtoCompatible = (expectedVer, incomingVer) => {
        if (PROTO != null && typeof PROTO.isProtoCompatible === 'function') {
            return PROTO.isProtoCompatible(expectedVer, incomingVer)
        }
        if (incomingVer === undefined || incomingVer === null) return false
        var n = Number(incomingVer)
        return isFinite(n) && n === Number(expectedVer)
    }

    NetworkEvents.dataReceived(CHANNEL, (event) => {
        try {
            var pkt = event.data
            var incomingProto = (pkt != null) ? pkt.proto : null
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

    var tickActiveEntries = (lv, localPlayer) => {
        var playerPos = getEntityPos(localPlayer)
        var sm        = getSoundManager()
        var hasAudibleDuckingBgm = false

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
                if (Math.abs(entry.currentAlGain - (entry.lastSentAlGain != null ? entry.lastSentAlGain : -1)) > 0.004 || entry.currentAlGain === 0.0) {
                    applyChannelGain(sm, entry, entry.currentAlGain)
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
        if (clientTicks < unpauseGraceUntil) return
        var sm = getSoundManager()
        if (sm == null) return

        for (var h of Array.from(entries.keys())) {
            var entry = entries.get(h)
            if (entry == null) continue

            if (entry.inst == null) {
                if (entry.waitSince != null && (clientTicks - entry.waitSince) > CONFIG.pendingTimeoutTicks) {
                    removeEntryNow(h)
                } else if (clientTicks >= entry.retryAt) {
                    tryStartEntry(entry, lv, localPlayer)
                }
                continue
            }

            // 刚启动的前 20 tick 处于异步音频流初始化窗口，跳过断流判定
            if ((clientTicks - entry.startTick) < 20) continue

            var active = true
            try { active = Boolean(sm.isActive(entry.inst)) } catch (e) { active = true }
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

            // 循环音源意外中断（如切换音频设备、F3+T 重载资源包或切屏被底层回收）：立即重连恢复
            stopSoundInstance(entry)
            if (entry.spec.resume) {
                var quickFail = (clientTicks - entry.startTick) < CONFIG.stableTicks
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
            if (isClientPaused()) {
                wasPaused = true
                return
            }
            if (wasPaused) {
                wasPaused = false
                unpauseGraceUntil = clientTicks + 15
            }

            clientTicks++
            var lv          = resolveClientLevel(event)
            var localPlayer = resolveClientPlayer(event)
            var dimKey      = extractDimensionId(lv)

            if (dimKey != null) {
                lastLevelKey = dimKey
            }

            flushPendingActions(lv, localPlayer)

            if (entries.size === 0 || lv == null) return

            tickActiveEntries(lv, localPlayer)
            if (clientTicks % CONFIG.sweepIntervalTicks === 0) {
                sweepEntries(lv, localPlayer)
            }
        } catch (e) {
            logErrorThrottled('clientTick error', e)
        }
    })

    try {
        var resetClientState = () => {
            clearAllNow()
            pendingActions.length = 0
            lastLevelKey = ''
            wasPaused    = false
        }
        ClientEvents.loggedOut(() => {
            resetClientState()
            session = null
        })
        ClientEvents.loggedIn(() => {
            resetClientState()
        })
    } catch (e) {}

    try {
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
            }
        }
    } catch (e) {}
})()
