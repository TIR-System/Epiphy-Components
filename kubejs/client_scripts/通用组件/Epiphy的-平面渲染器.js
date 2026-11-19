// ============================================================================
//  通用平面渲染与屏幕弹幕组件 —— 客户端渲染引擎 (Epiphy2DRenderer / ScreenDanmakuClient v6.1)
//  所属系列：Epiphy的-通用组件系列（本系列包含 startup / server / client 配套脚本）
//  [LLM 协作规范] 每次进行较大修改或重构前，请先将修改同步至 <repo-root> 并执行 git commit 保存当前可用状态，便于随时回退与对比 diff。
//  许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
//  放置位置：kubejs/client_scripts/通用组件/Epiphy的-平面渲染器.js
//  配套服务端组件：
//    - kubejs/server_scripts/通用组件/Epiphy的-平面渲染组件.js（服务端调度器 Epiphy2DSurface / ScreenDanmaku v6.1）
//    - kubejs/server_scripts/通用组件/Epiphy的-权限阀.js（/epiphy 指令注册中心与权限阀 EpiphyPermissionValve v5.4）
//
//  依赖与缺失降级：
//    - 可选前置：kubejs/startup_scripts/通用组件/Epiphy的-Spec与通用工具.js (EpiphySpec / EpiphyProtocol, priority: 1200)
//      缺失时启动输出 console.warn 并降级至内置 v6 协议常量与精简数值/布尔工具；收包仍严格执行 fail-closed 版本校验。
//    - 必需配套：kubejs/server_scripts/通用组件/Epiphy的-平面渲染组件.js（缺失时客户端处于待命状态，无弹幕数据包驱动）
//
//  功能概述：
//    1. 屏幕相对坐标 (rx, ry)、旋转角 (angle)、字号缩放 (scale)、RGB/HEX 颜色与阴影；
//    2. 文本生成：一次性显示 (typewriter: false) 或逐字打字机 (typewriter: true)，
//       客户端根据可见字素数与 charMs 统一计算维持时间与淡出时间；
//    3. 生命周期与优先级：
//       - 'once'   : 单次触发（默认 priority = 2），经过 holdDurationMs 后进入 fadeMs 淡出；
//       - 'active' : 持续激活（默认 priority = 5），心跳续期维持显示，停止或超时后进入淡出；
//       - 同 key 续期默认锁定初始坐标与倾角（movable: true 允许移动），默认保留 born 时间基准（restart: true 重置入场动画）；
//       - 自动 key 支持 normalizeKey 开关（默认 true 将独立动态数值归并为 '#'，false 保留原始文本差异）。
//    4. 震动模式 (shakeMode)：'none' | 'constant' | 'decay' | 'fade_in' | 'pulse' | 'random'（在前述 5 种中随机抽取）
//       - 独立逐字震动：'per_char'（或 perCharShake: true，未调用默认关闭；支持统一周期如 800ms 或随机区间 [min, max] 与 shakeAmp 幅度）；
//    5. 淡出模式 (fadeStyle)：'shrink' | 'char_first' | 'char_last' | 'blink' | 'shatter' | 'blur'(亚像素柔焦虚化淡出) | 'split'(多重裂解淡出) | 'random'；
//    6. 扩展样式（默认均关闭）：
//       - 字间距 (letterSpacing)：控制字符间额外像素间距（默认 0）；
//       - 字体外圈 (outlineMode: 'none' | 'stroke' | 'glow', outlineColor, outlineWidth)：支持黑底绿字等实心外圈或柔光外圈；
//       - 局部内联标记（仅当文本包含标签或启用时生效）：<b>加粗</b>、<scale=1.35>放大</scale>/<big>放大</big>、<shake>仅特定字震动</shake>、<noshake>免震</noshake>、<glow>/<outline>局部外圈。
//    7. 排版与边界：支持 \n 换行、maxWidth / wrap 自动折行、clamp 旋转包围盒防出屏、GUI 自动避让（showInGui: true 强制显示）、同组条数上限 (maxGroup)。
//
//  [语法规范] 遵循 README-LLM.md §1 强制语法基准（与 docs/kube-mods-rhino-es5-es6-compatibility.md）：
//    以 ES5 + `var` 为主，热路径维持低分配 ES5 写法，冷路径可按需谨慎使用经实测无语义偏移的 ES6/ES2020 扩展语法；
//    严禁使用 `??`、`let`/`const`、对象属性简写/计算属性、展开与默认参数等已确认高危/失效特性。
// ============================================================================

;(function () {
    var SPEC  = (typeof global !== 'undefined' && global.EpiphySpec != null) ? global.EpiphySpec : null
    var PROTO = (typeof global !== 'undefined' && global.EpiphyProtocol != null)
        ? global.EpiphyProtocol
        : (SPEC && SPEC.PROTOCOL ? SPEC.PROTOCOL : null)
    if (PROTO == null || SPEC == null) {
        try {
            console.warn('[ScreenDanmakuClient] 未检测到 startup_scripts/通用组件/Epiphy的-Spec与通用工具.js，已启用内置 v5 协议常量与基础工具降级运行。')
        } catch (eWarnInit) { }
    }
    var CHANNEL       = (PROTO && PROTO.DANMAKU_CHANNEL) || 'epiphy:screen_danmaku'
    var PROTO_VERSION = (PROTO && PROTO.DANMAKU_PROTO_VERSION) || 6

    // 统一配置常量表（消除散落魔法数）
    var CONFIG = {
        maxOverlays:                  120,
        maxPlayerOverlaysPerNamespace: 16,    // 单个玩家指令命名空间 (u:<uuid>) 同屏最多保留条数
        maxPendingActions:            256,    // 未消费入队动作上限（防单帧包洪泛 OOM）
        maxPendingPerFrame:           64,     // 单帧最多消费入队动作数
        frameBudgetMs:                45.0,   // 单帧硬防卡死熔断上限 (ms，正常高特效帧不触及；仅当超重负载累计超过阈值时截断本帧尾部条目防客户端冻结，不降级单条特效本身)
        maxTitleChars:                2048,   // 客户端主标题安全截断长度
        maxSubChars:                  1024,   // 客户端副标题安全截断长度
        maxCursorChars:               16,     // 打字机光标安全截断长度
        maxScale:                     8.0,    // 客户端缩放倍率先天上限
        lineStepPx:                   11,     // 单行步进高度 (px)
        minBlockHeightPx:      10,     // 最小文本块高度 (px)
        defaultWrapScreenPct:  0.86,   // maxWidth=0 时默认折行占屏宽比例
        wrapBucketPx:          8,      // 折行行宽分桶步长 (px)
        minWrapLinePx:         16,     // 最小折行像素宽度
        minSafeWrapLinePx:     64,     // 默认安全折行宽度下限
        screenMarginPx:        12,     // 屏幕左右基础留白 (px)
        clampPadPx:            6,      // 旋转包围盒屏幕边界内缩边距 (px)
        glyphCacheLimit:       4096,   // 字素宽度缓存条数上限
        typeReadBufferMs:      600,    // 打字机全部打完后的最短阅读停留缓冲 (ms)
        minHoldMs:             200,    // 最短维持时长 (ms)
        minFadeMs:             150,    // 最短淡出时长 (ms)
        maxOnceFadeRatio:      0.65,   // once 模式下淡出占总周期的最大比例（仅当未显式加长 fadeOut 时兜底）
        popAnimMs:             70,     // 非打字机模式出生弹跳动画时长 (ms)
        popScalePeak:          1.24,   // 出生弹跳峰值倍率
        cursorBlinkMs:         90,     // 打字机光标闪烁半周期 (ms)
        shatterFastThreshold:  18,     // 同屏弹幕超过该数量时 shatter 启用无矩阵快速绘制
        shatterMaxFrags:       22,     // 超长文本 shatter 聚簇目标块数
        shatterDenseVis:       48,     // 触发大步长碎片聚簇的可见字数阈值
        charShakeDefaultMinMs: 800,    // 逐字独立震动默认最小周期 (ms)
        charShakeDefaultMaxMs: 800,    // 逐字独立震动默认最大周期 (ms，默认 800ms 统一抖动周期)
        charShakeMaxDxPx:      5.00,   // 逐字震动水平方向单侧安全限幅 (px)
        charShakeMaxDyPx:      5.50,   // 逐字震动垂直方向单侧安全限幅 (px)
        errorLogIntervalMs:    5000,   // 渲染/接收异常日志最小打印间隔 (ms)
        maxItemDrawErrors:     2,      // 单条弹幕连续绘制报错达到该次数后立即剔除，防止刷屏
        debug:                 false,  // 是否输出逐字渲染调试日志（也可通过单条 debug: true 或 setDebug(true) 开启）
        screenRenderPriority:  0,      // 屏幕弹幕默认渲染层级（先画，处于底层）
        guiRenderPriority:     100,    // GUI 覆盖层默认渲染层级（默认高于弹幕不被覆盖，可独立调整）
        slotRenderPriority:    200     // 容器槽位覆盖层默认渲染层级
    }

    var PI         = 3.141592653589793
    var DEG_TO_RAD = PI / 180.0

    var FADE_POOL  = ['shrink', 'char_first', 'char_last', 'blink', 'shatter', 'blur', 'split']
    // 注意：'per_char' 逐字震动因开销较高，遵循“未显式调用则默认关闭”原则，不放入 SHAKE_POOL 随机池
    var SHAKE_POOL = ['none', 'constant', 'decay', 'fade_in', 'pulse']

    var activeOverlays          = []
    var pendingActions          = []
    var GL11                    = null
    var SystemClass             = null
    var MinecraftClass          = null
    var Matrix4fClass           = null
    var TextLayoutEngineClass   = null
    var ModernTextRendererClass = null
    var SheetsClass             = null
    function createLocalBoundedCache(maxSize) {
        if (SPEC && typeof SPEC.createBoundedCache === 'function') {
            return SPEC.createBoundedCache(maxSize)
        }
        var lim = (typeof maxSize === 'number' && maxSize >= 1) ? Math.floor(maxSize) : 512
        var map = Object.create(null)
        var ks  = []
        var hd  = 0
        var cnt = 0
        return {
            get: function (k) { var s = String(k); return (s in map) ? map[s] : undefined },
            has: function (k) { return String(k) in map },
            set: function (k, v) {
                var s = String(k)
                if (!(s in map)) {
                    while (cnt >= lim && hd < ks.length) {
                        var ok = ks[hd++]
                        if (ok in map) { delete map[ok]; cnt-- }
                    }
                    if (hd > 64 && hd * 2 >= ks.length) { ks = ks.slice(hd); hd = 0 }
                    ks.push(s); cnt++
                }
                map[s] = v
                return v
            },
            clear: function () { map = Object.create(null); ks = []; hd = 0; cnt = 0 },
            size:  function () { return cnt }
        }
    }

    var CACHED_FONT             = null
    var FONT_SIGNATURE          = ''
    var LAST_FONT_CHECK_MS      = -99999
    var GLYPH_WIDTH_CACHE       = createLocalBoundedCache(CONFIG.glyphCacheLimit)
    var LAST_LEVEL_KEY          = ''
    var lastErrorLogAt          = 0
    var suppressedErrors        = 0
    var BATCH_FAILED            = false
    var BATCH_RETRY_AT_MS       = 0
    var BATCH_RETRY_COOLDOWN_MS = 10000
    var MUI_RETRY_COOLDOWN_MS   = 10000
    var BATCH_MODE_PROBED       = false
    var FONT_DISPLAY_NORMAL     = null
    var MUI_PROBED              = false
    var MUI_ENGINE              = null
    var MUI_RENDERER            = null
    var MUI_CANARY_SEQ          = null
    var MUI_CANARY_STR          = 'A'
    var MUI_CANARY_LAYOUT       = null
    var MUI_EPOCH               = 0
    var MUI_HAS_VANILLA_LOOKUP  = false
    var MUI_HAS_DRAW_OUTLINE    = false
    var CHAR_OFFSET_SCRATCH     = { dx: 0.0, dy: 0.0, rotDeg: 0.0 }
    var SHAKE_VEC_SCRATCH       = { x: 0.0, y: 0.0 }
    var NODE_BIND_SCRATCH       = { x: 0.0, y: 0.0, w: 0.0, h: 0.0, alpha: 1.0, angle: 0.0 }
    var BOX_ORIG_SCRATCH        = { x0: 0.0, y0: 0.0 }
    var LOCAL_CLIP_SCRATCH      = { x: 0.0, y: 0.0, w: 0.0, h: 0.0, u: 0.0, v: 0.0, uw: 0.0, vh: 0.0, ratio: 1.0 }
    var FRAME_BATCH_CTX         = null
    var PASS_UNIT_SCRATCH       = []
    var PASS_MAT_POOL           = []

    // 环形外圈预计算采样表：
    //   - OUTLINE_8：0° 步进 45° 的 8 向实心描边环
    //   - GLOW_4：45° 对称 4 向柔光环（兼顾横竖笔画均匀覆盖与高性能，较 6 pass 再降 33% 绘制）
    //   - CARDINAL_4：大半径 stroke 时的 4 向内环桥接
    var DIAG_INV_SQRT2 = 0.7071067811865476
    var OUTLINE_8_DX   = [1.0, DIAG_INV_SQRT2, 0.0, -DIAG_INV_SQRT2, -1.0, -DIAG_INV_SQRT2, 0.0, DIAG_INV_SQRT2]
    var OUTLINE_8_DY   = [0.0, DIAG_INV_SQRT2, 1.0, DIAG_INV_SQRT2, 0.0, -DIAG_INV_SQRT2, -1.0, -DIAG_INV_SQRT2]
    var GLOW_4_DX      = [-0.75, 0.75, -0.75, 0.75]
    var GLOW_4_DY      = [-0.75, -0.75, 0.75, 0.75]
    var CARDINAL_4_DX  = [1.0, 0.0, -1.0, 0.0]
    var CARDINAL_4_DY  = [0.0, 1.0, 0.0, -1.0]
    // rendertype_text.fsh 会直接丢弃 alpha < 0.1 (~26/255) 的片元；外圈跳过低于 28 的极微弱描边，避免双线性采样在阈值边缘切出硬锯齿
    var OUTLINE_ALPHA_CUTOFF = 28

    var WARNED_KEYS = {}
    function warnOnce(key, msg) {
        if (WARNED_KEYS[key]) return
        WARNED_KEYS[key] = true
        console.warn('[ScreenDanmakuClient] ' + msg)
    }

    function loadJavaClass(className, silent) {
        if (typeof Java === 'undefined' || Java == null || typeof Java.loadClass !== 'function') return null
        try {
            return Java.loadClass(className)
        } catch (e) {
            if (!silent) {
                warnOnce('javaClass:' + className, '加载 Java 类 ' + className + ' 失败: ' + e)
            }
            return null
        }
    }

    GL11           = loadJavaClass('org.lwjgl.opengl.GL11')
    SystemClass    = loadJavaClass('java.lang.System', true)
    MinecraftClass = loadJavaClass('net.minecraft.client.Minecraft')
    Matrix4fClass  = loadJavaClass('org.joml.Matrix4f')

    var HAS_NANO_TIME = (SystemClass != null && typeof SystemClass.nanoTime === 'function')

    // 单调递增毫秒时钟：避免系统时间被 NTP 同步或手动修改时导致动画 age 跳变或变负
    function monotonicNowMs() {
        if (HAS_NANO_TIME) {
            try {
                return Number(SystemClass.nanoTime()) / 1000000.0
            } catch (e) {
                HAS_NANO_TIME = false
                warnOnce('nanoTime', 'System.nanoTime 不可用，回退 Date.now(): ' + e)
            }
        }
        return Date.now()
    }

    var RENDERER_EPOCH_MS = monotonicNowMs()

    function toAnimTimeSec(nowMs) {
        var cur = Number(nowMs) || 0
        if (RENDERER_EPOCH_MS > 1e9 && cur >= RENDERER_EPOCH_MS) {
            return (cur - RENDERER_EPOCH_MS) * 0.001
        }
        return cur * 0.001
    }

    // 限频错误日志：防止坏数据或渲染异常在 60+ FPS 下刷爆日志文件
    function logErrorThrottled(prefix, err) {
        var now = monotonicNowMs()
        if (now - lastErrorLogAt >= CONFIG.errorLogIntervalMs) {
            var tail = suppressedErrors > 0 ? (' (另有 ' + suppressedErrors + ' 次同类错误被折叠)') : ''
            lastErrorLogAt   = now
            suppressedErrors = 0
            console.error('[ScreenDanmakuClient] ' + prefix + ': ' + err + tail)
        } else {
            suppressedErrors++
        }
    }

    var PRIORITY_MAP = (PROTO && PROTO.PRIORITY_MAP) || {
        low:      1,
        normal:   2,
        high:     3,
        critical: 4,
        active:   5
    }
    var LEGACY_PRIORITY_MAP = (PROTO && PROTO.DEPRECATED_PRIORITY_ALIASES) || {
        minor: 1, '低': 1, '次要': 1,
        medium: 2, 'default': 2, '中': 2, '普通': 2,
        major: 3, important: 3, '高': 3, '重要': 3,
        fatal: 4, urgent: 4, boss: 4, '极高': 4, '致命': 4,
        sustain: 5, '持续': 5
    }
    var min2     = (SPEC && typeof SPEC.min2 === 'function') ? SPEC.min2 : function (a, b) { return a < b ? a : b }
    var max2     = (SPEC && typeof SPEC.max2 === 'function') ? SPEC.max2 : function (a, b) { return a > b ? a : b }
    var clampNum = (SPEC && typeof SPEC.clampNum === 'function')
        ? SPEC.clampNum
        : function (v, lo, hi, defVal) {
            if (v === null || v === undefined || valIsEmptyObjOrBool(v)) {
                return defVal !== undefined ? defVal : lo
            }
            var n = Number(v)
            if (isNaN(n) || !isFinite(n)) return defVal !== undefined ? defVal : lo
            return n < lo ? lo : (n > hi ? hi : n)
        }
    function valIsEmptyObjOrBool(v) {
        return v === '' || typeof v === 'boolean' || Array.isArray(v)
    }

    function parsePriority(val, defVal) {
        if (SPEC && typeof SPEC.parsePriority === 'function') {
            return SPEC.parsePriority(val, defVal, {
                map:           PRIORITY_MAP,
                deprecatedMap: LEGACY_PRIORITY_MAP,
                min:           0,
                max:           10,
                round:         true
            })
        }
        if (val === undefined || val === null || val === '') return defVal
        var key = String(val).trim().toLowerCase()
        if (PRIORITY_MAP[key] !== undefined) return PRIORITY_MAP[key]
        if (LEGACY_PRIORITY_MAP[key] !== undefined) return LEGACY_PRIORITY_MAP[key]
        var n = Number(val)
        return isFinite(n) ? clampNum(Math.round(n), 0, 10) : defVal
    }

    function readPriorityField(d, key, fallbackKey, defVal) {
        var s1 = readStr(d, key, '')
        if (s1) return parsePriority(s1, defVal)
        var n1 = readNum(d, key, null)
        if (n1 !== null && isFinite(n1)) return parsePriority(n1, defVal)
        if (fallbackKey) {
            var s2 = readStr(d, fallbackKey, '')
            if (s2) return parsePriority(s2, defVal)
            var n2 = readNum(d, fallbackKey, null)
            if (n2 !== null && isFinite(n2)) return parsePriority(n2, defVal)
        }
        return defVal
    }

    function checkProtoCompatible(expectedVer, incomingVer) {
        if (PROTO && typeof PROTO.isProtoCompatible === 'function') {
            return PROTO.isProtoCompatible(expectedVer, incomingVer)
        }
        if (incomingVer === undefined || incomingVer === null) return false
        var n = Number(incomingVer)
        var exp = Number(expectedVer)
        if (!isFinite(n) || !isFinite(exp)) return false
        if (exp === 6) return n === 5 || n === 6
        return n === exp
    }

    function sanitizeMaxWidth(val) {
        var n = Number(val)
        if (val === undefined || val === null || val === '' || !isFinite(n) || n <= 0) return 0
        if (n <= 1.0) return clampNum(n, 0.05, 1.0)
        return clampNum(Math.round(n), CONFIG.minWrapLinePx, 4096)
    }

    var FONT_WIDTH_PROBE_FONT = null
    var FONT_WIDTH_KIND       = null

    function invokeFontWidthWithKind(fontObj, kind, str) {
        if (kind === 'direct')   return Number(fontObj.width(str))
        if (kind === 'explicit') return Number(fontObj['width(java.lang.String)'].call(fontObj, str))
        if (kind === 'text')     return Number(fontObj.width(Text.of(str)))
        if (kind === 'srg_str')  return Number(fontObj.m_92895_(str))
        if (kind === 'srg_text') return Number(fontObj.m_92852_(Text.of(str)))
        return NaN
    }

    function probeFontWidthKind(fontObj, str) {
        var candidates = ['direct', 'explicit', 'text', 'srg_str', 'srg_text']
        for (var i = 0; i < candidates.length; i++) {
            var k = candidates[i]
            try {
                if (k === 'direct'   && typeof fontObj.width !== 'function') continue
                if (k === 'explicit' && typeof fontObj['width(java.lang.String)'] !== 'function') continue
                if (k === 'text'     && typeof fontObj.width !== 'function') continue
                if (k === 'srg_str'  && typeof fontObj.m_92895_ !== 'function') continue
                if (k === 'srg_text' && typeof fontObj.m_92852_ !== 'function') continue
                var w = invokeFontWidthWithKind(fontObj, k, str)
                if (isFinite(w) && w >= 0) {
                    FONT_WIDTH_PROBE_FONT = fontObj
                    FONT_WIDTH_KIND       = k
                    return w
                }
            } catch (eProbe) {
                // 仅在首次遇到 Font 实例时探测可用测宽重载
            }
        }
        FONT_WIDTH_PROBE_FONT = fontObj
        FONT_WIDTH_KIND       = 'none'
        return NaN
    }

    function invokeFontWidth(fontObj, str) {
        if (fontObj == null || !str) return NaN
        var s = String(str)
        if (FONT_WIDTH_PROBE_FONT === fontObj && FONT_WIDTH_KIND != null) {
            if (FONT_WIDTH_KIND === 'none') return NaN
            var wd = invokeFontWidthWithKind(fontObj, FONT_WIDTH_KIND, s)
            return (isFinite(wd) && wd >= 0) ? wd : NaN
        }
        return probeFontWidthKind(fontObj, s)
    }

    var MC_INSTANCE_FAILED = false

    function getClientFont(event, nowMs) {
        var f = null
        if (event != null) {
            if (event.font != null) f = event.font
            else if (event.mc != null && event.mc.font != null) f = event.mc.font
        }
        if (f == null && typeof Client !== 'undefined' && Client != null) {
            if (Client.font != null) f = Client.font
            else if (Client.minecraft != null && Client.minecraft.font != null) f = Client.minecraft.font
        }
        if (f == null && MinecraftClass != null && !MC_INSTANCE_FAILED) {
            try {
                var mcInst = MinecraftClass.getInstance()
                if (mcInst != null && mcInst.font != null) f = mcInst.font
            } catch (eMcF) {
                MC_INSTANCE_FAILED = true
                warnOnce('mcFont', '获取 Minecraft.getInstance().font 失败: ' + eMcF)
            }
        }
        if (f == null) f = CACHED_FONT
        if (f != null) {
            var tNow = (nowMs != null && isFinite(nowMs)) ? nowMs : monotonicNowMs()
            // 同一个 Font 实例 1500ms 内复用签名，避免每帧 3 次 JNI Font.width 探针
            if (CACHED_FONT === f && (tNow - LAST_FONT_CHECK_MS) < 1500) {
                return f
            }
            LAST_FONT_CHECK_MS = tNow
            var sig = 'F'
            var w1 = invokeFontWidth(f, 'iW')
            var w2 = invokeFontWidth(f, '§lA')
            var w3 = invokeFontWidth(f, '中')
            if (isFinite(w1) && isFinite(w2) && isFinite(w3)) {
                sig = 'F:' + w1 + ':' + w2 + ':' + w3
            }
            if (CACHED_FONT !== f || FONT_SIGNATURE !== sig) {
                CACHED_FONT      = f
                FONT_SIGNATURE   = sig
                resetGlyphWidthCache()
            }
        }
        return f
    }

    function isHighSurrogate(code) {
        return code >= 0xD800 && code <= 0xDBFF
    }
    function isLowSurrogate(code) {
        return code >= 0xDC00 && code <= 0xDFFF
    }
    function isGraphemeExtendCode(code) {
        return (code >= 0xFE00 && code <= 0xFE0F) ||
               (code >= 0xFE20 && code <= 0xFE2F) ||
               (code >= 0x0300 && code <= 0x036F) ||
               (code >= 0x1AB0 && code <= 0x1AFF) ||
               (code >= 0x1DC0 && code <= 0x1DFF) ||
               (code >= 0x20D0 && code <= 0x20FF) ||
               (code >= 0x3099 && code <= 0x309A) ||
               code === 0x20E3 ||
               code === 0x200D
    }
    function isSkinToneModifierPair(high, low) {
        return high === 0xD83C && low >= 0xDFFB && low <= 0xDFFF
    }
    function isRegionalIndicatorPair(high, low) {
        return high === 0xD83C && low >= 0xDDE6 && low <= 0xDDFF
    }
    function isSupplementaryExtendPair(high, low) {
        return high === 0xDB40 && ((low >= 0xDC20 && low <= 0xDC7F) || (low >= 0xDD00 && low <= 0xDDEF))
    }

    function readGraphemeCluster(str, startIdx) {
        var len = str.length
        var i   = startIdx
        var out = ''

        if (i < len) {
            var code = str.charCodeAt(i)
            var isRiStart = false
            if (isHighSurrogate(code) && (i + 1) < len && isLowSurrogate(str.charCodeAt(i + 1))) {
                var low0 = str.charCodeAt(i + 1)
                isRiStart = isRegionalIndicatorPair(code, low0)
                out += str.charAt(i) + str.charAt(i + 1)
                i += 2
            } else {
                out += str.charAt(i)
                i += 1
            }

            if (isRiStart && (i + 1) < len && isRegionalIndicatorPair(str.charCodeAt(i), str.charCodeAt(i + 1))) {
                out += str.charAt(i) + str.charAt(i + 1)
                i += 2
            }

            while (i < len) {
                var c = str.charCodeAt(i)
                if (c === 0x200D) {
                    out += str.charAt(i)
                    i += 1
                    if (i < len) {
                        var jHi = str.charCodeAt(i)
                        if (jHi !== 10 && jHi !== 13 && jHi !== 167) {
                            if (isHighSurrogate(jHi) && (i + 1) < len && isLowSurrogate(str.charCodeAt(i + 1))) {
                                out += str.charAt(i) + str.charAt(i + 1)
                                i += 2
                            } else {
                                out += str.charAt(i)
                                i += 1
                            }
                        }
                    }
                    continue
                }
                if (isGraphemeExtendCode(c)) {
                    out += str.charAt(i)
                    i += 1
                    continue
                }
                if ((i + 1) < len) {
                    var cLow = str.charCodeAt(i + 1)
                    if (isSkinToneModifierPair(c, cLow) || isSupplementaryExtendPair(c, cLow)) {
                        out += str.charAt(i) + str.charAt(i + 1)
                        i += 2
                        continue
                    }
                }
                break
            }
        }
        return { cluster: out, nextIndex: i }
    }

    function fnv1aHashHex(str) {
        var h = 0x811c9dc5
        for (var i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i)
            h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0
        }
        return h.toString(16)
    }

    // 动态数值归一化：
    //   当 normalizeKey=true（默认）时，仅将带符号数值、小数、百分数或紧跟常见计量/属性分隔符的动态读数替换为 '#'，
    //   保留诸如 "阶段 1"、"1号机"、"Tier 2" 等序号/标识符中的数字；当 normalizeKey=false 时完全保留原串。
    function normalizeTextForAutoKey(raw, normalizeNumbers) {
        var base = String(raw || '').replace(/§[0-9a-fk-or]/gi, '').replace(/\r?\n/g, ' ').trim()
        if (!normalizeNumbers) return base
        // 保护典型序号词（第N、阶段N、Lv.N、Tier N、#N、N号）不被替换为 '#'
        var guarded = base.replace(/(第\s*|阶段\s*|等级\s*|lv\.?\s*|tier\s*|#\s*)(\d+)/gi, '$1\uE001$2')
                          .replace(/(\d+)(\s*[号层阶波段区])/g, '\uE001$1$2')
        var normalized = guarded.replace(/[+-]\d+(?:\.\d+)?%?|\d+\.\d+%?|\d+%/g, '#')
                                .replace(/([:：=xX×/]\s*)\d+/g, '$1#')
                                .replace(/\uE001/g, '')
        return normalized
    }

    function deriveAutoActiveKey(namespace, group, slotId, posTag, title, sub, normalizeNumbers) {
        var nsPrefix = (namespace && String(namespace).trim().length > 0) ? (String(namespace).trim() + ':') : ''
        var grp      = (group && String(group).trim().length > 0) ? String(group).trim() : 'default'
        if (slotId && String(slotId).trim().length > 0) {
            return 'active:' + nsPrefix + grp + ':id:' + String(slotId).trim()
        }
        var shouldNorm = (normalizeNumbers !== false)
        var normTitle  = normalizeTextForAutoKey(title, shouldNorm)
        var normSub    = normalizeTextForAutoKey(sub, shouldNorm)
        var combined   = normTitle + '|' + normSub
        var hashTag    = fnv1aHashHex(combined)
        var headTag    = (normTitle.substring(0, 20) || 'default')
        return 'active:' + nsPrefix + grp + ':' + (posTag || 'center') + ':' + headTag + '#' + hashTag
    }

    // CompoundTag / JS 对象统一字段读取辅助（屏蔽 CompoundTag 的 Bean getter 名冲突）
    var RESERVED_TAG_BEANS = {
        id: true, type: true, empty: true, allKeys: true, asString: true, class: true, tags: true
    }

    function hasKeyInTag(d, key) {
        if (d == null) return false
        try {
            var fnContains = d['contains(java.lang.String)']
            if (typeof fnContains === 'function') return Boolean(fnContains.call(d, String(key)))
            if (typeof d.contains === 'function') return Boolean(d.contains(String(key)))
        } catch (e) {
            return false
        }
        try {
            return d[key] !== undefined && d[key] !== null
        } catch (e2) {
            return false
        }
    }

    function readStr(d, key, defVal) {
        if (d == null) return defVal
        if (!RESERVED_TAG_BEANS[key]) {
            try {
                var v = d[key]
                if (v != null && typeof v !== 'function' && typeof v !== 'object') {
                    var sv = String(v)
                    if (sv.length > 0) return sv
                }
            } catch (e) { }
        }
        try {
            if (typeof d.getString === 'function' && hasKeyInTag(d, key)) {
                var s = d.getString(String(key))
                if (s != null && String(s).length > 0) return String(s)
            }
        } catch (e2) { }
        return defVal
    }

    function readNum(d, key, defVal) {
        if (d == null) return defVal
        if (!RESERVED_TAG_BEANS[key]) {
            try {
                var v = d[key]
                if (v !== undefined && v !== null && typeof v !== 'function') {
                    var nv = Number(v)
                    if (isFinite(nv)) return nv
                    var sv = String(v).trim().replace(/[dfbslDFBSL]$/, '')
                    var nsv = Number(sv)
                    if (sv.length > 0 && isFinite(nsv)) return nsv
                }
            } catch (e) { }
        }
        if (hasKeyInTag(d, key)) {
            try {
                if (typeof d.getDouble === 'function') {
                    var nd = Number(d.getDouble(String(key)))
                    if (isFinite(nd)) return nd
                }
            } catch (e2) { }
        }
        return defVal
    }

    function readNonNegNum(d, key, defVal, minVal) {
        var floor = (minVal != null && isFinite(minVal)) ? minVal : 0
        var n = readNum(d, key, defVal)
        if (!isFinite(n) || n < 0) return defVal
        return max2(floor, n)
    }

    function parseBool(val, defVal) {
        if (SPEC && typeof SPEC.parseBoolStrict === 'function') {
            var b = SPEC.parseBoolStrict(val)
            return b !== null ? b : defVal
        }
        if (typeof val === 'boolean') return val
        if (typeof val === 'number') return val !== 0
        if (val == null) return defVal
        var s = String(val).trim().toLowerCase()
        if (s === 'true' || s === '1' || s === 'yes' || s === 'on' || s === '是' || s === '开启') return true
        if (s === 'false' || s === '0' || s === 'no' || s === 'off' || s === '否' || s === '关闭') return false
        return defVal
    }

    function readBool(d, key, defVal) {
        if (d == null) return defVal
        if (!RESERVED_TAG_BEANS[key]) {
            try {
                var v = d[key]
                if (v !== undefined && v !== null && typeof v !== 'function') {
                    var parsed = parseBool(String(v), null)
                    if (parsed !== null) return parsed
                    if (typeof v === 'boolean') return v
                    if (typeof v === 'number') return v !== 0
                }
            } catch (e) { }
        }
        if (hasKeyInTag(d, key)) {
            try {
                if (typeof d.getBoolean === 'function') return Boolean(d.getBoolean(String(key)))
            } catch (e2) { }
        }
        return defVal
    }

    function resetGlyphWidthCache() {
        GLYPH_WIDTH_CACHE.clear()
    }

    function measureClusterWidthPx(cluster, isBold, fontObj) {
        if (!cluster || cluster.length === 0) return 0
        var f = fontObj || getClientFont(null)
        if (f != null) {
            var cacheKey = (isBold ? '1:' : '0:') + cluster
            var cached = GLYPH_WIDTH_CACHE.get(cacheKey)
            if (cached !== undefined && isFinite(cached)) return cached
            var probe = isBold ? ('§l' + cluster) : cluster
            var w = invokeFontWidth(f, probe)
            if (isFinite(w) && w >= 0) {
                GLYPH_WIDTH_CACHE.set(cacheKey, w)
                return w
            }
        }
        var c0 = cluster.charCodeAt(0)
        var baseW = 6
        if (cluster.length > 1 || c0 > 255) {
            baseW = 9
        } else if (cluster === 'i' || cluster === 'l' || cluster === '!' || cluster === '.' || cluster === ',' || cluster === ':' || cluster === ';' || cluster === '\'' || cluster === '|') {
            baseW = 2
        } else if (cluster === 'I' || cluster === 't' || cluster === ' ' || cluster === '[' || cluster === ']') {
            baseW = 4
        } else if (cluster === 'f' || cluster === 'k' || cluster === 'r') {
            baseW = 5
        }
        return baseW + (isBold ? 1 : 0)
    }

    // ========================================================================
    //  局部内联富文本标签解析（默认关闭，仅当文本中检测到标签语法或显式开启时运行）
    //  支持语法（兼容 <...> 与 {...}）：
    //    - <b>...</b> 或 {b}...{/b}                   : 特定文字加粗
    //    - <big>...</big> 或 <scale=1.35>...</scale>  : 特定文字放大/缩放
    //    - <shake>...</shake> / <noshake>...</noshake>: 仅特定文字震动 / 豁免震动
    //    - <outline=#000000>...</outline>             : 特定文字实心外圈描边
    //    - <glow=#55FFFF>...</glow>                   : 特定文字发光外圈
    // ========================================================================

    var INLINE_TAG_RE = /^(?:<|\{)(\/?)(b|bold|big|scale|shake|noshake|outline|glow)(?:=([^>\}]+))?(?:>|\})/i

    function isPotentialSpanTagHead(str, idx) {
        if ((idx + 2) >= str.length) return false
        var c1 = str.charCodeAt(idx + 1)
        if (c1 === 47) { // '/'
            if ((idx + 3) >= str.length) return false
            c1 = str.charCodeAt(idx + 2)
        }
        // 仅当标签首字母为 b, s, n, o, g (大小写) 时才可能是合法内联标签，快速短路 <AVARITIA_BIOS> 等普通尖括号文本
        var lower = c1 | 32
        return lower === 98 || lower === 115 || lower === 110 || lower === 111 || lower === 103
    }

    function hasRichSpanTags(str) {
        if (!str || str.length < 3) return false
        var hasCandidate = false
        for (var i = 0, len = str.length - 2; i < len; i++) {
            var ch = str.charCodeAt(i)
            if ((ch === 60 || ch === 123) && isPotentialSpanTagHead(str, i)) {
                hasCandidate = true
                break
            }
        }
        if (!hasCandidate) return false
        return /(?:<|\{)\/?(?:b|bold|big|scale|shake|noshake|outline|glow)\b/i.test(str)
    }

    function hasSdfSpanTags(str) {
        if (!str || str.length < 4) return false
        var hasCandidate = false
        for (var i = 0, len = str.length - 3; i < len; i++) {
            var ch = str.charCodeAt(i)
            if ((ch === 60 || ch === 123) && isPotentialSpanTagHead(str, i)) {
                hasCandidate = true
                break
            }
        }
        if (!hasCandidate) return false
        return /(?:<|\{)\/?(?:big|scale|outline|glow)\b/i.test(str)
    }

    function parseHexColorInline(rawVal, defCol) {
        if (!rawVal) return defCol
        var s = String(rawVal).trim().toLowerCase()
        if (s.indexOf('#') === 0) s = s.substring(1)
        else if (s.indexOf('0x') === 0) s = s.substring(2)
        var n = parseInt(s, 16)
        return isFinite(n) ? (n & 0xFFFFFF) : defCol
    }

    function matchInlineTagAt(str, idx) {
        var ch = str.charCodeAt(idx)
        if (ch !== 60 && ch !== 123) return null // '<' or '{'
        if (!isPotentialSpanTagHead(str, idx)) return null
        var sub = str.substring(idx, min2(str.length, idx + 32))
        var m = INLINE_TAG_RE.exec(sub)
        if (m == null) return null
        return {
            rawLen:  m[0].length,
            isClose: m[1] === '/',
            tag:     m[2].toLowerCase(),
            arg:     m[3] != null ? m[3].trim() : null
        }
    }

    function applyInlineTagToState(tagObj, state) {
        var t = tagObj.tag
        if (tagObj.isClose) {
            if (t === 'b' || t === 'bold') state.tagBold = false
            else if (t === 'big' || t === 'scale') state.charScale = 1.0
            else if (t === 'shake' || t === 'noshake') state.shakeFlag = 0
            else if (t === 'outline' || t === 'glow') {
                state.outlineMode  = ''
                state.outlineColor = -1
            }
            return
        }
        if (t === 'b' || t === 'bold') {
            state.tagBold = true
        } else if (t === 'big') {
            var bigVal = tagObj.arg ? Number(tagObj.arg) : 1.35
            state.charScale = (isFinite(bigVal) && bigVal > 0.2) ? clampNum(bigVal, 0.3, 3.0) : 1.35
        } else if (t === 'scale') {
            var scVal = tagObj.arg ? Number(tagObj.arg) : 1.35
            state.charScale = (isFinite(scVal) && scVal > 0.2) ? clampNum(scVal, 0.3, 3.0) : 1.35
        } else if (t === 'shake') {
            state.shakeFlag = 1
        } else if (t === 'noshake') {
            state.shakeFlag = -1
        } else if (t === 'outline') {
            state.outlineMode  = 'stroke'
            state.outlineColor = parseHexColorInline(tagObj.arg, -1)
        } else if (t === 'glow') {
            state.outlineMode  = 'glow'
            state.outlineColor = parseHexColorInline(tagObj.arg, -1)
        }
    }

    function countVisibleChars(str) {
        if (!str || str.length === 0) return 0
        var checkTags = hasRichSpanTags(str)
        var count = 0
        for (var i = 0; i < str.length;) {
            var code = str.charCodeAt(i)
            if (code === 10 || code === 13) {
                i++
                continue
            }
            if (code === 167 && (i + 1) < str.length) {
                i += 2
                continue
            }
            if (checkTags) {
                var tag = matchInlineTagAt(str, i)
                if (tag != null) {
                    i += tag.rawLen
                    continue
                }
            }
            var g = readGraphemeCluster(str, i)
            count++
            i = g.nextIndex
        }
        return count
    }

    function sliceVisibleChars(str, maxVis) {
        if (!str || str.length === 0 || maxVis <= 0) return ''
        var checkTags = hasRichSpanTags(str)
        var vis = 0
        var out = ''
        for (var i = 0; i < str.length;) {
            var code = str.charCodeAt(i)
            if (code === 10 || code === 13) {
                i++
                continue
            }
            if (code === 167 && (i + 1) < str.length) {
                out += str.charAt(i) + str.charAt(i + 1)
                i += 2
                continue
            }
            if (checkTags) {
                var tag = matchInlineTagAt(str, i)
                if (tag != null) {
                    out += str.substring(i, i + tag.rawLen)
                    i += tag.rawLen
                    continue
                }
            }
            if (vis >= maxVis) break
            var g = readGraphemeCluster(str, i)
            out += g.cluster
            vis++
            i = g.nextIndex
        }
        return out
    }

    function computeClusterSpacing(clusterWidthPx, spacing, spacingMode) {
        if (!spacing || !isFinite(spacing)) return 0
        if (spacingMode === 'fixed' || spacingMode === 'px') return spacing
        return spacing * clampNum((clusterWidthPx || 0) / 9.0, 0.22, 2.0)
    }

    function dropFirstVisibleChars(str, skipVis, fontObj, letterSpacingPx, spacingMode) {
        if (!str || str.length === 0) return { text: '', offsetPx: 0 }
        if (skipVis <= 0) return { text: str, offsetPx: 0 }
        var checkTags = hasRichSpanTags(str)
        var spacing   = (letterSpacingPx != null && isFinite(letterSpacingPx)) ? Number(letterSpacingPx) : 0
        var vis       = 0
        var offsetPx  = 0
        var isBold    = false
        var tagState  = { tagBold: false, charScale: 1.0, shakeFlag: 0, outlineMode: '', outlineColor: -1 }
        var out       = ''
        for (var i = 0; i < str.length;) {
            var code = str.charCodeAt(i)
            if (code === 10 || code === 13) {
                i++
                continue
            }
            if (code === 167 && (i + 1) < str.length) {
                var fc = str.charAt(i + 1).toLowerCase()
                if (fc === 'l') isBold = true
                else if ((fc >= '0' && fc <= '9') || (fc >= 'a' && fc <= 'f') || fc === 'r') isBold = false
                out += str.charAt(i) + str.charAt(i + 1)
                i += 2
                continue
            }
            if (checkTags) {
                var tag = matchInlineTagAt(str, i)
                if (tag != null) {
                    applyInlineTagToState(tag, tagState)
                    out += str.substring(i, i + tag.rawLen)
                    i += tag.rawLen
                    continue
                }
            }
            var g = readGraphemeCluster(str, i)
            var effBold = isBold || tagState.tagBold
            var baseCw = measureClusterWidthPx(g.cluster, effBold, fontObj) * tagState.charScale
            var cw = baseCw + computeClusterSpacing(baseCw, spacing, spacingMode)
            if (vis < skipVis) {
                offsetPx += cw
            } else {
                out += g.cluster
            }
            vis++
            i = g.nextIndex
        }
        if (vis <= skipVis) return { text: '', offsetPx: offsetPx }
        return { text: out, offsetPx: offsetPx }
    }

    function serializeActiveTagPrefix(tagState) {
        var p = ''
        if (tagState.tagBold) p += '<b>'
        if (tagState.charScale !== 1.0) p += '<scale=' + tagState.charScale + '>'
        if (tagState.shakeFlag === 1) p += '<shake>'
        else if (tagState.shakeFlag === -1) p += '<noshake>'
        if (tagState.outlineMode === 'stroke') {
            p += (tagState.outlineColor >= 0) ? ('<outline=#' + tagState.outlineColor.toString(16) + '>') : '<outline>'
        } else if (tagState.outlineMode === 'glow') {
            p += (tagState.outlineColor >= 0) ? ('<glow=#' + tagState.outlineColor.toString(16) + '>') : '<glow>'
        }
        return p
    }

    function measureWholeLineWidthPx(fullLine, fontObj) {
        if (!fullLine || fullLine.length === 0) return 0
        if (MUI_ENGINE != null && MUI_HAS_VANILLA_LOOKUP) {
            try {
                var shared = getCachedTextCompSeq(fullLine, false)
                var lay = (MUI_EPOCH > 0 && shared._muiEpoch === MUI_EPOCH) ? shared._muiLayout : null
                if (lay == null && shared._muiEpoch !== MUI_EPOCH) {
                    lay = MUI_ENGINE.lookupVanillaLayout(shared.rawText)
                    if (lay != null && MUI_EPOCH > 0) {
                        var hasEm = (typeof lay.hasColorEmoji === 'function') ? Boolean(lay.hasColorEmoji()) : false
                        shared._muiLayout   = lay
                        shared._muiEpoch    = MUI_EPOCH
                        shared._muiHasEmoji = hasEm
                    }
                }
                if (lay != null && typeof lay.getTotalAdvance === 'function') {
                    var adv = Number(lay.getTotalAdvance())
                    if (isFinite(adv) && adv >= 0) return adv
                }
            } catch (eMuiW) { }
        }
        return invokeFontWidth(fontObj, fullLine)
    }

    function scanPlainStyledSegmentMeta(seg, activeColor, activeFmt, isBold) {
        var vis = 0
        for (var i = 0; i < seg.length;) {
            var code = seg.charCodeAt(i)
            if (code === 167 && (i + 1) < seg.length) {
                var nextCh = seg.charAt(i + 1)
                var lower  = nextCh.toLowerCase()
                if ((lower >= '0' && lower <= '9') || (lower >= 'a' && lower <= 'f')) {
                    activeColor = '§' + lower
                    activeFmt   = ''
                    isBold      = false
                } else if (lower === 'r') {
                    activeColor = ''
                    activeFmt   = ''
                    isBold      = false
                } else if (lower >= 'k' && lower <= 'o') {
                    if (activeFmt.indexOf('§' + lower) < 0) activeFmt += '§' + lower
                    if (lower === 'l') isBold = true
                }
                i += 2
                continue
            }
            var g = readGraphemeCluster(seg, i)
            vis++
            i = g.nextIndex
        }
        return { vis: vis, activeColor: activeColor, activeFmt: activeFmt, isBold: isBold }
    }

    function wrapStyledTextLines(str, maxLineWidthPx, fontObj, letterSpacingPx, spacingMode, preferWholeMeasure) {
        if (!str || str.length === 0) return []
        var checkTags   = hasRichSpanTags(str)
        var spacing     = (letterSpacingPx != null && isFinite(letterSpacingPx)) ? Number(letterSpacingPx) : 0
        var rawParts    = String(str).split(/\r?\n/)
        var lines       = []
        var activeColor = ''
        var activeFmt   = ''
        var isBold      = false
        var tagState    = { tagBold: false, charScale: 1.0, shakeFlag: 0, outlineMode: '', outlineColor: -1 }
        var allowWholeFast = Boolean(preferWholeMeasure) && !checkTags && spacing === 0

        for (var p = 0; p < rawParts.length; p++) {
            var seg = rawParts[p]
            if (seg.length === 0) {
                lines.push({ text: '', widthPx: 0, vis: 0, empty: true, hasTags: false })
                continue
            }

            if (allowWholeFast) {
                var fullPrefSeg = activeColor + activeFmt + seg
                var wholeW = measureWholeLineWidthPx(fullPrefSeg, fontObj)
                if (isFinite(wholeW) && wholeW >= 0 && (maxLineWidthPx >= 999999 || maxLineWidthPx < 12 || wholeW <= maxLineWidthPx)) {
                    var meta = scanPlainStyledSegmentMeta(seg, activeColor, activeFmt, isBold)
                    activeColor = meta.activeColor
                    activeFmt   = meta.activeFmt
                    isBold      = meta.isBold
                    if (meta.vis > 0) {
                        lines.push({ text: fullPrefSeg, widthPx: max2(0, wholeW), vis: meta.vis, hasTags: false })
                    } else {
                        lines.push({ text: '', widthPx: 0, vis: 0, empty: true, hasTags: false })
                    }
                    continue
                }
            }

            var curLine = activeColor + activeFmt + (checkTags ? serializeActiveTagPrefix(tagState) : '')
            var curW    = 0
            var curVis  = 0

            for (var i = 0; i < seg.length;) {
                var code = seg.charCodeAt(i)
                if (code === 167 && (i + 1) < seg.length) {
                    var nextCh = seg.charAt(i + 1)
                    var lower  = nextCh.toLowerCase()
                    curLine += seg.charAt(i) + nextCh
                    if ((lower >= '0' && lower <= '9') || (lower >= 'a' && lower <= 'f')) {
                        activeColor = '§' + lower
                        activeFmt   = ''
                        isBold      = false
                    } else if (lower === 'r') {
                        activeColor = ''
                        activeFmt   = ''
                        isBold      = false
                    } else if (lower >= 'k' && lower <= 'o') {
                        if (activeFmt.indexOf('§' + lower) < 0) activeFmt += '§' + lower
                        if (lower === 'l') isBold = true
                    }
                    i += 2
                    continue
                }
                if (checkTags) {
                    var tag = matchInlineTagAt(seg, i)
                    if (tag != null) {
                        applyInlineTagToState(tag, tagState)
                        curLine += seg.substring(i, i + tag.rawLen)
                        i += tag.rawLen
                        continue
                    }
                }

                var g       = readGraphemeCluster(seg, i)
                var effBold = isBold || tagState.tagBold
                var baseCw  = measureClusterWidthPx(g.cluster, effBold, fontObj) * tagState.charScale
                var extraSp = computeClusterSpacing(baseCw, spacing, spacingMode)
                var stepW   = (curVis > 0 ? extraSp : 0) + baseCw

                if (maxLineWidthPx >= 12 && curVis > 0 && (curW + stepW) > maxLineWidthPx) {
                    lines.push({ text: curLine, widthPx: max2(0, curW), vis: curVis, hasTags: checkTags })
                    curLine = activeColor + activeFmt + (checkTags ? serializeActiveTagPrefix(tagState) : '') + g.cluster
                    curW    = baseCw
                    curVis  = 1
                } else {
                    curLine += g.cluster
                    curW    += stepW
                    curVis++
                }
                i = g.nextIndex
            }

            if (curVis > 0) {
                lines.push({ text: curLine, widthPx: max2(0, curW), vis: curVis, hasTags: checkTags })
            } else {
                lines.push({ text: '', widthPx: 0, vis: 0, empty: true, hasTags: false })
            }
        }
        return lines
    }

    var IMUL32 = (typeof Math.imul === 'function') ? Math.imul : function (a, b) {
        var ah = (a >>> 16) & 0xFFFF
        var al = a & 0xFFFF
        var bh = (b >>> 16) & 0xFFFF
        var bl = b & 0xFFFF
        return ((al * bl) + (((ah * bl + al * bh) << 16) >>> 0)) | 0
    }

    var INV_TWO_PI    = 0.15915494309189535
    var TRIG_LUT_SIZE = 256
    var TRIG_LUT_MASK = 255
    var TRIG_COS_LUT  = []
    var TRIG_SIN_LUT  = []
    ;(function initTrigLut() {
        var stepRad = (PI * 2.0) / TRIG_LUT_SIZE
        for (var ti = 0; ti < TRIG_LUT_SIZE; ti++) {
            var a = ti * stepRad
            TRIG_COS_LUT.push(Math.cos(a))
            TRIG_SIN_LUT.push(Math.sin(a))
        }
    })()

    function fastSinTurns(turns) {
        var idx = Math.floor(turns * TRIG_LUT_SIZE) & TRIG_LUT_MASK
        return TRIG_SIN_LUT[idx]
    }

    function fastCosTurns(turns) {
        var idx = Math.floor(turns * TRIG_LUT_SIZE) & TRIG_LUT_MASK
        return TRIG_COS_LUT[idx]
    }

    function hashUnit(seed) {
        // 32 位整数 bit-mixer（替代 Math.sin 伪随机，零超越函数且分布均匀）
        var s = Number(seed)
        if (!isFinite(s)) s = 0.0
        var lo = Math.floor(s * 65536.0) | 0
        var hi = Math.floor(s) | 0
        var h  = (lo ^ IMUL32(hi ^ 0x9E3779B9, 0x85EBCA6B)) | 0
        h = IMUL32(h ^ (h >>> 16), 0x85EBCA6B)
        h = IMUL32(h ^ (h >>> 13), 0xC2B2AE35)
        h = (h ^ (h >>> 16)) >>> 0
        return h * 2.3283064365386963e-10
    }

    function splitLineIntoFragments(lineText, baseOffsetPx, fullW, fontObj, chunkSize, letterSpacingPx, spacingMode) {
        if (!lineText || lineText.length === 0) return []
        var maxClusterPerFrag = max2(1, chunkSize || 1)
        var checkTags = hasRichSpanTags(lineText)
        var spacing   = (letterSpacingPx != null && isFinite(letterSpacingPx)) ? Number(letterSpacingPx) : 0
        var frags     = []
        var activeCol = ''
        var activeFmt = ''
        var isBold    = false
        var tagState  = { tagBold: false, charScale: 1.0, shakeFlag: 0, outlineMode: '', outlineColor: -1 }
        var curX      = -fullW * 0.5 + baseOffsetPx

        var pendingText       = ''
        var pendingPlain      = ''
        var pendingFmtPref    = ''
        var pendingX          = 0
        var pendingW          = 0
        var pendingCount      = 0
        var pendingVisIndex   = 0
        var pendingScale      = 1.0
        var pendingShakeFlag  = 0
        var pendingOutMode    = ''
        var pendingOutCol     = -1
        var visOffset         = 0

        for (var i = 0; i < lineText.length;) {
            var code = lineText.charCodeAt(i)
            if (code === 10 || code === 13) {
                i++
                continue
            }
            if (code === 167 && (i + 1) < lineText.length) {
                var nextCh = lineText.charAt(i + 1)
                var lower  = nextCh.toLowerCase()
                if ((lower >= '0' && lower <= '9') || (lower >= 'a' && lower <= 'f')) {
                    activeCol = '§' + lower
                    activeFmt = ''
                    isBold    = false
                } else if (lower === 'r') {
                    activeCol = ''
                    activeFmt = ''
                    isBold    = false
                } else if (lower >= 'k' && lower <= 'o') {
                    if (activeFmt.indexOf('§' + lower) < 0) activeFmt += '§' + lower
                    if (lower === 'l') isBold = true
                }
                if (pendingCount > 0) {
                    pendingText += lineText.charAt(i) + nextCh
                }
                i += 2
                continue
            }
            if (checkTags) {
                var tag = matchInlineTagAt(lineText, i)
                if (tag != null) {
                    if (pendingCount > 0) {
                        frags.push({
                            text:         pendingText,
                            plainText:    pendingPlain,
                            fmtPref:      pendingFmtPref,
                            x:            pendingX,
                            w:            pendingW,
                            visIndex:     pendingVisIndex,
                            charScale:    pendingScale,
                            shakeFlag:    pendingShakeFlag,
                            outlineMode:  pendingOutMode,
                            outlineColor: pendingOutCol
                        })
                        pendingText    = ''
                        pendingPlain   = ''
                        pendingFmtPref = ''
                        pendingW       = 0
                        pendingCount   = 0
                    }
                    applyInlineTagToState(tag, tagState)
                    i += tag.rawLen
                    continue
                }
            }

            var g       = readGraphemeCluster(lineText, i)
            var effBold = isBold || tagState.tagBold
            var fmtPref = activeCol + activeFmt + (tagState.tagBold && activeFmt.indexOf('§l') < 0 ? '§l' : '')
            var cw      = measureClusterWidthPx(g.cluster, effBold, fontObj) * tagState.charScale
            var charSp  = computeClusterSpacing(cw, spacing, spacingMode)
            if (g.cluster.trim().length === 0) {
                if (pendingCount > 0) {
                    frags.push({
                        text:         pendingText,
                        plainText:    pendingPlain,
                        fmtPref:      pendingFmtPref,
                        x:            pendingX,
                        w:            pendingW,
                        visIndex:     pendingVisIndex,
                        charScale:    pendingScale,
                        shakeFlag:    pendingShakeFlag,
                        outlineMode:  pendingOutMode,
                        outlineColor: pendingOutCol
                    })
                    pendingText    = ''
                    pendingPlain   = ''
                    pendingFmtPref = ''
                    pendingW       = 0
                    pendingCount   = 0
                }
                curX += cw + charSp
                visOffset++
                i = g.nextIndex
                continue
            }

            if (pendingCount === 0) {
                pendingText      = fmtPref + g.cluster
                pendingPlain     = g.cluster
                pendingFmtPref   = fmtPref
                pendingX         = curX
                pendingW         = cw
                pendingVisIndex  = visOffset
                pendingScale     = tagState.charScale
                pendingShakeFlag = tagState.shakeFlag
                pendingOutMode   = tagState.outlineMode
                pendingOutCol    = tagState.outlineColor
                pendingCount     = 1
            } else {
                pendingText  += g.cluster
                pendingPlain += g.cluster
                pendingW     += cw + charSp
                pendingCount++
            }
            curX += cw + charSp
            visOffset++
            i = g.nextIndex

            if (pendingCount >= maxClusterPerFrag) {
                frags.push({
                    text:         pendingText,
                    plainText:    pendingPlain,
                    fmtPref:      pendingFmtPref,
                    x:            pendingX,
                    w:            pendingW,
                    visIndex:     pendingVisIndex,
                    charScale:    pendingScale,
                    shakeFlag:    pendingShakeFlag,
                    outlineMode:  pendingOutMode,
                    outlineColor: pendingOutCol
                })
                pendingText    = ''
                pendingPlain   = ''
                pendingFmtPref = ''
                pendingW       = 0
                pendingCount   = 0
            }
        }
        if (pendingCount > 0) {
            frags.push({
                text:         pendingText,
                plainText:    pendingPlain,
                fmtPref:      pendingFmtPref,
                x:            pendingX,
                w:            pendingW,
                visIndex:     pendingVisIndex,
                charScale:    pendingScale,
                shakeFlag:    pendingShakeFlag,
                outlineMode:  pendingOutMode,
                outlineColor: pendingOutCol
            })
        }
        return frags
    }

    var SHARED_TEXT_SEQ_CACHE    = {}
    var SHARED_TEXT_SEQ_KEYS     = []
    var MAX_TEXT_SEQ_CACHE       = 512
    var TRANSIENT_TEXT_SEQ_CACHE = {}
    var TRANSIENT_TEXT_SEQ_KEYS  = []
    var MAX_TRANSIENT_SEQ_CACHE  = 256

    function getCachedTextCompSeq(rawStr, eagerCompSeq, isTransient) {
        var key = String(rawStr || '')
        var entry
        if (Object.prototype.hasOwnProperty.call(SHARED_TEXT_SEQ_CACHE, key)) {
            entry = SHARED_TEXT_SEQ_CACHE[key]
        } else if (Object.prototype.hasOwnProperty.call(TRANSIENT_TEXT_SEQ_CACHE, key)) {
            entry = TRANSIENT_TEXT_SEQ_CACHE[key]
            // 当曾作为过渡态前缀缓存的条目被正式静态行请求时，将其晋升至持久共享缓存池，防止被后续打字机前缀淘汰
            if (isTransient !== true) {
                delete TRANSIENT_TEXT_SEQ_CACHE[key]
                entry._isTransient = false
                if (SHARED_TEXT_SEQ_KEYS.length >= MAX_TEXT_SEQ_CACHE) {
                    var oldestPromote = SHARED_TEXT_SEQ_KEYS.shift()
                    if (oldestPromote !== undefined) delete SHARED_TEXT_SEQ_CACHE[oldestPromote]
                }
                SHARED_TEXT_SEQ_CACHE[key] = entry
                SHARED_TEXT_SEQ_KEYS.push(key)
            }
        } else if (isTransient === true) {
            if (TRANSIENT_TEXT_SEQ_KEYS.length >= MAX_TRANSIENT_SEQ_CACHE) {
                var oldTrans = TRANSIENT_TEXT_SEQ_KEYS.shift()
                if (oldTrans !== undefined) delete TRANSIENT_TEXT_SEQ_CACHE[oldTrans]
            }
            entry = {
                rawText:      key,
                comp:         null,
                seq:          null,
                _isTransient: true,
                _muiLayout:   null,
                _muiEpoch:    -1,
                _muiHasEmoji: false
            }
            TRANSIENT_TEXT_SEQ_CACHE[key] = entry
            TRANSIENT_TEXT_SEQ_KEYS.push(key)
        } else {
            if (SHARED_TEXT_SEQ_KEYS.length >= MAX_TEXT_SEQ_CACHE) {
                var oldest = SHARED_TEXT_SEQ_KEYS.shift()
                if (oldest !== undefined) delete SHARED_TEXT_SEQ_CACHE[oldest]
            }
            entry = {
                rawText:      key,
                comp:         null,
                seq:          null,
                _isTransient: false,
                _muiLayout:   null,
                _muiEpoch:    -1,
                _muiHasEmoji: false
            }
            SHARED_TEXT_SEQ_CACHE[key] = entry
            SHARED_TEXT_SEQ_KEYS.push(key)
        }
        if (eagerCompSeq === true && (entry.comp == null || entry.seq == null)) {
            ensureUnitCompSeq(entry)
        }
        return entry
    }

    function ensureUnitCompSeq(unit) {
        if (unit == null) return null
        if (unit.comp != null && unit.seq != null) return unit
        var raw = (unit.rawText != null) ? String(unit.rawText) : ''
        if (unit.comp == null && raw.length > 0 && typeof Text !== 'undefined' && Text != null && typeof Text.of === 'function') {
            unit.comp = Text.of(raw)
        }
        if (unit.seq == null && unit.comp != null) {
            unit.seq = resolveVisualSeq(unit.comp)
        }
        if (raw.length > 0 && Object.prototype.hasOwnProperty.call(SHARED_TEXT_SEQ_CACHE, raw)) {
            var cached = SHARED_TEXT_SEQ_CACHE[raw]
            if (cached.comp == null && unit.comp != null) cached.comp = unit.comp
            if (cached.seq == null && unit.seq != null) cached.seq = unit.seq
        }
        return unit
    }

    function resolveVisualSeq(comp) {
        if (comp == null) return null
        try {
            if (typeof comp.getVisualOrderText === 'function') {
                return comp.getVisualOrderText()
            }
            if (typeof comp.m_7532_ === 'function') {
                return comp.m_7532_()
            }
        } catch (eSeq) { }
        return null
    }

    function probeDisplayModeNormal() {
        if (BATCH_MODE_PROBED) return FONT_DISPLAY_NORMAL
        BATCH_MODE_PROBED = true
        var cls = loadJavaClass('net.minecraft.client.gui.Font$DisplayMode')
        if (cls != null && cls.NORMAL != null) FONT_DISPLAY_NORMAL = cls.NORMAL
        return FONT_DISPLAY_NORMAL
    }

    function probeModernUiBridge() {
        if (MUI_PROBED) return MUI_ENGINE != null
        MUI_PROBED = true
        TextLayoutEngineClass = loadJavaClass('icyllis.modernui.mc.text.TextLayoutEngine')
        if (TextLayoutEngineClass == null || typeof TextLayoutEngineClass.getInstance !== 'function') {
            return false
        }
        ModernTextRendererClass = loadJavaClass('icyllis.modernui.mc.text.ModernTextRenderer')
        SheetsClass             = loadJavaClass('net.minecraft.client.renderer.Sheets')
        try {
            var eng = TextLayoutEngineClass.getInstance()
            if (eng == null) return false

            var probeLayout = null
            var hasVanillaLookup = false
            try {
                if (typeof eng.lookupVanillaLayout === 'function') {
                    var vanillaLayout = eng.lookupVanillaLayout(MUI_CANARY_STR)
                    if (vanillaLayout != null && typeof vanillaLayout.drawText === 'function') {
                        probeLayout = vanillaLayout
                        hasVanillaLookup = true
                    }
                }
            } catch (eMuiVanilla) {
                probeLayout = null
                hasVanillaLookup = false
            }

            if (probeLayout == null) {
                if (typeof eng.lookupFormattedLayout !== 'function') return false
                if (MUI_CANARY_SEQ == null && typeof Text !== 'undefined' && Text != null && typeof Text.of === 'function') {
                    MUI_CANARY_SEQ = resolveVisualSeq(Text.of('A'))
                }
                if (MUI_CANARY_SEQ == null) return false
                // 验证 2 参重载 (FormattedCharSequence, int) 在 Rhino 中无二义性（Style 未注册 TypeWrapper）
                probeLayout = eng.lookupFormattedLayout(MUI_CANARY_SEQ, 0)
                if (probeLayout == null || typeof probeLayout.drawText !== 'function') return false
            }

            MUI_HAS_VANILLA_LOOKUP = hasVanillaLookup
            var canOutline = false
            try {
                canOutline = (typeof probeLayout.drawTextOutline === 'function')
            } catch (eOutProbe) {
                canOutline = false
            }
            MUI_HAS_DRAW_OUTLINE = canOutline
            MUI_CANARY_LAYOUT = probeLayout
            MUI_EPOCH++
            MUI_ENGINE = eng
            if (typeof eng.getTextRenderer === 'function') {
                MUI_RENDERER = eng.getTextRenderer()
            } else if (ModernTextRendererClass != null) {
                MUI_RENDERER = new ModernTextRendererClass(eng)
            }
            return true
        } catch (eMuiInit) {
            MUI_ENGINE             = null
            MUI_RENDERER           = null
            MUI_CANARY_LAYOUT      = null
            MUI_HAS_VANILLA_LOOKUP = false
            MUI_HAS_DRAW_OUTLINE   = false
            logErrorThrottled('ModernUI TextLayout probe fallback', eMuiInit)
            return false
        }
    }

    var EMOJI_SHEET_PROBED = false
    var CACHED_EMOJI_SHEET = null

    function resolveEmojiSheet() {
        if (EMOJI_SHEET_PROBED) return CACHED_EMOJI_SHEET
        EMOJI_SHEET_PROBED = true
        if (SheetsClass == null) return null
        // 先在独立 try/catch 中探测 Mojmap 名，再回退 SRG；避免 KubeJS Rhino 在 NativeJavaClass 上直接读取缺失的 m_110787_ 抛出 InternalError WARN
        try {
            if (typeof SheetsClass.translucentCullBlockSheet === 'function') {
                CACHED_EMOJI_SHEET = SheetsClass.translucentCullBlockSheet()
                return CACHED_EMOJI_SHEET
            }
        } catch (eShMoj) { }
        try {
            if (typeof SheetsClass.m_110787_ === 'function') {
                CACHED_EMOJI_SHEET = SheetsClass.m_110787_()
                return CACHED_EMOJI_SHEET
            }
        } catch (eShSrg) {
            warnOnce('emojiSheet', '探测 ModernUI Emoji RenderType 失败: ' + eShSrg)
        }
        CACHED_EMOJI_SHEET = null
        return CACHED_EMOJI_SHEET
    }

    function isSameJavaRef(a, b) {
        if (a === b) return true
        if (a == null || b == null) return false
        try {
            if (typeof a.equals === 'function') return Boolean(a.equals(b))
        } catch (eEq) { }
        return false
    }

    function ensureFrameBatchCtx(event, fontObj, now) {
        var nowMs = now || monotonicNowMs()
        if (BATCH_FAILED) {
            if (nowMs < BATCH_RETRY_AT_MS) return null
            BATCH_FAILED = false
        }
        if (fontObj == null || event == null) return null
        var gfx = event.graphics
        if (gfx == null || typeof gfx.bufferSource !== 'function' || typeof gfx.flush !== 'function') return null
        if (typeof event.getMatrix !== 'function' && event.matrix == null) return null

        var bufSrc = null
        try {
            bufSrc = gfx.bufferSource()
        } catch (eBuf) {
            bufSrc = null
        }
        if (bufSrc == null) return null

        if (FRAME_BATCH_CTX == null) {
            var modeNormal = probeDisplayModeNormal()
            if (modeNormal == null) {
                BATCH_FAILED      = true
                BATCH_RETRY_AT_MS = nowMs + BATCH_RETRY_COOLDOWN_MS
                return null
            }
            var matItem    = null
            var matUnit    = null
            var matOut     = null
            var matFg      = null
            var matItemFg  = null
            var matItemOut = null
            var matItemO2  = null
            if (Matrix4fClass != null) {
                try {
                    matItem    = new Matrix4fClass()
                    matUnit    = new Matrix4fClass()
                    matOut     = new Matrix4fClass()
                    matFg      = new Matrix4fClass()
                    matItemFg  = new Matrix4fClass()
                    matItemOut = new Matrix4fClass()
                    matItemO2  = new Matrix4fClass()
                } catch (eM) {
                    matItem    = null
                    matUnit    = null
                    matOut     = null
                    matFg      = null
                    matItemFg  = null
                    matItemOut = null
                    matItemO2  = null
                }
            }
            var canDirect = (matItem != null && matUnit != null &&
                typeof matUnit.set === 'function' &&
                typeof matUnit.translate === 'function' &&
                typeof matUnit.rotateZ === 'function' &&
                typeof matUnit.scale === 'function')
            probeModernUiBridge()
            var emojiSheet = resolveEmojiSheet()
            FRAME_BATCH_CTX = {
                font:              null,
                drawFn:            null,
                useDirectSrgDraw:  false,
                hasGetMatrixFn:    (typeof event.getMatrix === 'function'),
                graphics:          gfx,
                bufSrc:            bufSrc,
                displayMode:       modeNormal,
                muiActive:         false,
                muiRetryAtMs:      0,
                muiEngine:         MUI_ENGINE,
                muiRenderer:       MUI_RENDERER,
                muiHasVanilla:     MUI_HAS_VANILLA_LOOKUP,
                muiHasDrawOutline: MUI_HAS_DRAW_OUTLINE,
                muiAllowSdf:       true,
                muiAllowShadow:    true,
                muiEmojiSheet:     emojiSheet,
                muiEndBatchFn:     null,
                canDirectMatrix:   canDirect,
                baseFrameMat:      null,
                _itemScratch:      matItem,
                itemMat:           null,
                itemFgMat:         matItemFg,
                itemFgReady:       false,
                itemOutMat:        matItemOut,
                itemOutMat2:       matItemO2,
                itemOutZ1:         NaN,
                itemOutZ2:         NaN,
                unitMat:           matUnit,
                outMat:            matOut,
                fgMat:             matFg,
                drawn:             0,
                nowMs:             now || 0,
                needBlendRestore:  false,
                prevBlend:         null
            }
        }

        var ctx = FRAME_BATCH_CTX
        ctx.graphics         = gfx
        ctx.bufSrc           = bufSrc
        ctx.hasGetMatrixFn   = (typeof event.getMatrix === 'function')
        ctx.drawn            = 0
        ctx.nowMs            = now || 0
        ctx.baseFrameMat     = null
        ctx.itemMat          = null
        ctx.itemFgReady      = false
        ctx.itemOutZ1        = NaN
        ctx.itemOutZ2        = NaN
        ctx.muiHasVanilla     = MUI_HAS_VANILLA_LOOKUP
        ctx.muiHasDrawOutline = MUI_HAS_DRAW_OUTLINE
        ctx.needBlendRestore = false
        ctx.prevBlend        = null

        if (!isSameJavaRef(ctx.font, fontObj)) {
            var muiReady = (MUI_ENGINE != null)
            var drawFn = null
            var useDirectSrgDraw = false
            try {
                var explicitSrg = fontObj['m_272191_(net.minecraft.util.FormattedCharSequence,float,float,int,boolean,org.joml.Matrix4f,net.minecraft.client.renderer.MultiBufferSource,net.minecraft.client.gui.Font$DisplayMode,int,int)']
                if (typeof explicitSrg === 'function') drawFn = explicitSrg
            } catch (eSrgExp) { }
            if (drawFn == null && typeof fontObj.m_272191_ === 'function') {
                // Forge SRG 下 FormattedCharSequence 重载独立命名为 m_272191_，可直接避开 ModernUI FormattedTextWrapper 与 String/Component 重载二义性
                useDirectSrgDraw = true
            }
            if (drawFn == null && !useDirectSrgDraw) {
                try {
                    var explicit = fontObj['drawInBatch(net.minecraft.util.FormattedCharSequence,float,float,int,boolean,org.joml.Matrix4f,net.minecraft.client.renderer.MultiBufferSource,net.minecraft.client.gui.Font$DisplayMode,int,int)']
                    if (typeof explicit === 'function') drawFn = explicit
                } catch (eExp) { }
            }
            if (!muiReady && drawFn == null && !useDirectSrgDraw && typeof fontObj.drawInBatch !== 'function') {
                return null
            }
            ctx.font             = fontObj
            ctx.drawFn           = drawFn
            ctx.useDirectSrgDraw = useDirectSrgDraw
            ctx.muiActive        = muiReady
            ctx.muiRetryAtMs     = 0
        } else if (!ctx.muiActive && MUI_ENGINE != null && nowMs >= (ctx.muiRetryAtMs || 0)) {
            ctx.muiActive    = true
            ctx.muiRetryAtMs = 0
        }

        if (ctx.muiEmojiSheet != null && ctx.muiEndBatchFn == null) {
            try {
                if (typeof bufSrc.endBatch === 'function') {
                    ctx.muiEndBatchFn = bufSrc.endBatch
                }
            } catch (eEndMoj) { }
            if (ctx.muiEndBatchFn == null) {
                try {
                    if (typeof bufSrc.m_109912_ === 'function') {
                        ctx.muiEndBatchFn = bufSrc.m_109912_
                    }
                } catch (eEndSrg) { }
            }
        }

        if (ctx.muiActive && (ctx.muiHasVanilla || MUI_CANARY_SEQ != null)) {
            try {
                var curCanary = ctx.muiHasVanilla
                    ? ctx.muiEngine.lookupVanillaLayout(MUI_CANARY_STR)
                    : ctx.muiEngine.lookupFormattedLayout(MUI_CANARY_SEQ, 0)
                if (!isSameJavaRef(curCanary, MUI_CANARY_LAYOUT)) {
                    MUI_CANARY_LAYOUT = curCanary
                    MUI_EPOCH++
                    resetGlyphWidthCache()
                }
                if (ModernTextRendererClass != null) {
                    ctx.muiAllowSdf    = (ModernTextRendererClass.sAllowSDFTextIn2D !== false)
                    ctx.muiAllowShadow = (ModernTextRendererClass.sAllowShadow !== false)
                } else {
                    ctx.muiAllowShadow = true
                }
            } catch (eCanary) {
                markMuiDegraded(ctx)
            }
        }
        return ctx
    }

    function markMuiDegraded(batchCtx) {
        if (batchCtx == null) return
        batchCtx.muiActive    = false
        batchCtx.muiRetryAtMs = (batchCtx.nowMs || monotonicNowMs()) + MUI_RETRY_COOLDOWN_MS
    }

    function markBatchFailed(batchCtx) {
        BATCH_FAILED      = true
        BATCH_RETRY_AT_MS = ((batchCtx && batchCtx.nowMs) || monotonicNowMs()) + BATCH_RETRY_COOLDOWN_MS
    }

    function flushFrameBatchCtx(batchCtx) {
        if (batchCtx != null && batchCtx.drawn > 0) {
            try {
                batchCtx.graphics.flush()
            } catch (eFlush) {
                logErrorThrottled('batch flush error', eFlush)
            }
            batchCtx.drawn = 0
        }
    }

    function resolveUnitMuiLayout(batchCtx, seq, ownerObj) {
        if (batchCtx == null || !batchCtx.muiActive) return null
        if (ownerObj != null && ownerObj._muiLayout != null && ownerObj._muiEpoch === MUI_EPOCH) {
            return ownerObj._muiLayout
        }
        var raw = (ownerObj != null && ownerObj.rawText != null) ? String(ownerObj.rawText) : ''
        var isTransOwner = Boolean(ownerObj != null && ownerObj._isTransient)
        var hasSharedKey = (raw.length > 0 && Object.prototype.hasOwnProperty.call(SHARED_TEXT_SEQ_CACHE, raw))
        var hasTransKey  = (!hasSharedKey && raw.length > 0 && Object.prototype.hasOwnProperty.call(TRANSIENT_TEXT_SEQ_CACHE, raw))
        if (hasSharedKey || hasTransKey) {
            var sharedEntry = hasSharedKey ? SHARED_TEXT_SEQ_CACHE[raw] : TRANSIENT_TEXT_SEQ_CACHE[raw]
            if (sharedEntry._muiLayout != null && sharedEntry._muiEpoch === MUI_EPOCH) {
                if (ownerObj != null) {
                    ownerObj._muiLayout   = sharedEntry._muiLayout
                    ownerObj._muiEpoch    = MUI_EPOCH
                    ownerObj._muiHasEmoji = sharedEntry._muiHasEmoji
                }
                return sharedEntry._muiLayout
            }
        }
        try {
            var layout = null
            if (batchCtx.muiHasVanilla && raw.length > 0) {
                layout = batchCtx.muiEngine.lookupVanillaLayout(raw)
            } else {
                var effSeq = seq
                if (effSeq == null && ownerObj != null) {
                    ensureUnitCompSeq(ownerObj)
                    effSeq = ownerObj.seq
                }
                if (effSeq == null) return null
                layout = batchCtx.muiEngine.lookupFormattedLayout(effSeq, 0)
            }
            if (layout != null) {
                var hasEm = (typeof layout.hasColorEmoji === 'function') ? Boolean(layout.hasColorEmoji()) : false
                if (ownerObj != null) {
                    ownerObj._muiLayout   = layout
                    ownerObj._muiEpoch    = MUI_EPOCH
                    ownerObj._muiHasEmoji = hasEm
                }
                if (raw.length > 0) {
                    var targetCache = hasSharedKey
                        ? SHARED_TEXT_SEQ_CACHE[raw]
                        : (hasTransKey ? TRANSIENT_TEXT_SEQ_CACHE[raw] : getCachedTextCompSeq(raw, false, isTransOwner))
                    targetCache._muiLayout   = layout
                    targetCache._muiEpoch    = MUI_EPOCH
                    targetCache._muiHasEmoji = hasEm
                }
            }
            return layout
        } catch (eLookup) {
            markMuiDegraded(batchCtx)
            logErrorThrottled('ModernUI lookupLayout fallback', eLookup)
            return null
        }
    }

    function flushEmojiSheetIfNeeded(batchCtx, layout, ownerObj) {
        if (batchCtx.muiEndBatchFn == null || batchCtx.muiEmojiSheet == null) return
        if (ownerObj != null && ownerObj._muiHasEmoji === false) return
        try {
            var hasEmoji = (ownerObj != null && ownerObj._muiHasEmoji != null)
                ? ownerObj._muiHasEmoji
                : (typeof layout.hasColorEmoji === 'function' && layout.hasColorEmoji())
            if (hasEmoji) {
                batchCtx.muiEndBatchFn.call(batchCtx.bufSrc, batchCtx.muiEmojiSheet)
            }
        } catch (eEmoji) { }
    }

    function computeMuiDrawMode(batchCtx, mat, preferSdf) {
        if (!batchCtx.muiAllowSdf) return 0
        if (preferSdf) return 1
        if (batchCtx.muiRenderer != null && typeof batchCtx.muiRenderer.chooseMode === 'function') {
            var chosen = batchCtx.muiRenderer.chooseMode(mat, batchCtx.displayMode)
            if (chosen === 4) {
                if (mat != null && typeof mat.m00 === 'function' && Math.abs(mat.m00() - 1.0) < 0.02) {
                    return 0
                }
                return batchCtx.muiAllowSdf ? 1 : 0
            }
            return chosen
        }
        return 1
    }

    function drawMuiLayoutPassRgb(batchCtx, layout, x, y, r, g, b, a, shadow, mat, drawMode) {
        if (batchCtx == null || !batchCtx.muiActive || layout == null || mat == null) return false
        try {
            var effA = clampNum(Math.round(a), 0, 255)
            if (effA <= 0) return true
            var allowShadow = Boolean(shadow) && (batchCtx.muiAllowShadow !== false)
            if (allowShadow) {
                // TextLayout.drawText 第 9 参是 isShadow（是否为阴影层），非 dropShadow；
                // 必须先以 RGB 右移 2 位 (25% 亮度) + isShadow=true 绘制阴影，再沿 +Z (+0.03) 以 isShadow=false 绘制全亮度主字。
                layout.drawText(mat, batchCtx.bufSrc, x, y, r >>> 2, g >>> 2, b >>> 2, effA, true, drawMode, false, 1.0, 0, 15728880)
                var fgMat = mat
                if (batchCtx.itemMat != null && mat === batchCtx.itemMat && batchCtx.itemFgMat != null) {
                    if (!batchCtx.itemFgReady) {
                        batchCtx.itemFgMat.set(batchCtx.itemMat)
                        batchCtx.itemFgMat.translate(0.0, 0.0, 0.03)
                        batchCtx.itemFgReady = true
                    }
                    fgMat = batchCtx.itemFgMat
                } else if (batchCtx.fgMat != null && typeof batchCtx.fgMat.set === 'function' && typeof batchCtx.fgMat.translate === 'function') {
                    batchCtx.fgMat.set(mat)
                    batchCtx.fgMat.translate(0.0, 0.0, 0.03)
                    fgMat = batchCtx.fgMat
                }
                layout.drawText(fgMat, batchCtx.bufSrc, x, y, r, g, b, effA, false, drawMode, false, 1.0, 0, 15728880)
                batchCtx.drawn += 2
            } else {
                layout.drawText(mat, batchCtx.bufSrc, x, y, r, g, b, effA, false, drawMode, false, 1.0, 0, 15728880)
                batchCtx.drawn++
            }
            return true
        } catch (eMuiDraw) {
            markMuiDegraded(batchCtx)
            logErrorThrottled('ModernUI TextLayout.drawText fallback', eMuiDraw)
            return false
        }
    }

    function drawMuiLayoutPass(batchCtx, layout, x, y, argb, shadow, mat, drawMode) {
        var a = (argb >>> 24) & 0xFF
        var r = (argb >>> 16) & 0xFF
        var g = (argb >>> 8) & 0xFF
        var b = argb & 0xFF
        return drawMuiLayoutPassRgb(batchCtx, layout, x, y, r, g, b, a, shadow, mat, drawMode)
    }

    function drawBatchedGlyph(batchCtx, seq, x, y, argb, shadow, mat, preLayout, muiDrawMode) {
        if (batchCtx == null || BATCH_FAILED || mat == null) return false
        if (preLayout != null && batchCtx.muiActive) {
            if (drawMuiLayoutPass(batchCtx, preLayout, x, y, argb, shadow, mat, muiDrawMode != null ? muiDrawMode : (batchCtx.muiAllowSdf ? 1 : 0))) {
                return true
            }
        }
        if (seq == null) return false
        try {
            if (batchCtx.drawFn != null) {
                batchCtx.drawFn.call(batchCtx.font, seq, x, y, argb, shadow, mat, batchCtx.bufSrc, batchCtx.displayMode, 0, 15728880)
            } else if (batchCtx.useDirectSrgDraw) {
                batchCtx.font.m_272191_(seq, x, y, argb, shadow, mat, batchCtx.bufSrc, batchCtx.displayMode, 0, 15728880)
            } else {
                batchCtx.font.drawInBatch(seq, x, y, argb, shadow, mat, batchCtx.bufSrc, batchCtx.displayMode, 0, 15728880)
            }
            batchCtx.drawn++
            return true
        } catch (eDrawBatch) {
            markBatchFailed(batchCtx)
            logErrorThrottled('drawInBatch fallback', eDrawBatch)
            return false
        }
    }

    function getOrBuildShatterCache(item, renderTitleLines, renderSubLines, titleLineCount, startY, lineStep, shownVis, fontObj) {
        var cacheKey = item.wrapKey + '|vis:' + shownVis
        if (item.shatterCacheKey === cacheKey && item.shatterFrags != null) {
            return item.shatterFrags
        }
        var chunkSize = shownVis > CONFIG.shatterDenseVis
            ? Math.ceil(shownVis / CONFIG.shatterMaxFrags)
            : (shownVis > CONFIG.shatterMaxFrags ? 2 : 1)
        var baseSeed  = item.shakeSeed || 37.0
        var fragSeq   = 0
        var list      = []
        var allGroups = [
            { lines: renderTitleLines, baseLineOffset: 0, color: item.color },
            { lines: renderSubLines,   baseLineOffset: titleLineCount, color: item.subColor }
        ]
        for (var gIdx = 0; gIdx < allGroups.length; gIdx++) {
            var grp = allGroups[gIdx]
            for (var lIdx = 0; lIdx < grp.lines.length; lIdx++) {
                var rLn      = grp.lines[lIdx]
                var baseY    = startY + (grp.baseLineOffset + rLn.lineIndex) * lineStep
                var rawFrags = splitLineIntoFragments(rLn.text, rLn.offsetPx, rLn.fullW, fontObj, chunkSize, item.letterSpacing, item.letterSpacingMode)
                for (var fIdx = 0; fIdx < rawFrags.length; fIdx++) {
                    var rf = rawFrags[fIdx]
                    fragSeq++
                    var fSeed    = baseSeed + fragSeq * 19.17 + rLn.lineIndex * 7.31
                    var vanishAt = 0.58 + hashUnit(fSeed + 1.1) * 0.40
                    var dirRad   = hashUnit(fSeed + 2.3) * PI * 2.0
                    var spd      = 10.0 + hashUnit(fSeed + 3.7) * 24.0
                    var rotMax   = (hashUnit(fSeed + 5.9) - 0.5) * 95.0
                    var fragEntry = getCachedTextCompSeq(rf.text, false)
                    list.push({
                        rawText:     fragEntry.rawText,
                        comp:        fragEntry.comp,
                        seq:         fragEntry.seq,
                        _muiLayout:  fragEntry._muiLayout,
                        _muiEpoch:   fragEntry._muiEpoch,
                        _muiHasEmoji:fragEntry._muiHasEmoji,
                        color:       grp.color,
                        cx:          rf.x + rf.w * 0.5,
                        cy:          baseY + 4.5,
                        halfW:       -rf.w * 0.5,
                        vanishAt:    vanishAt,
                        invVanish:   1.0 / vanishAt,
                        vx:          Math.cos(dirRad) * spd,
                        vy:          Math.sin(dirRad) * spd * 0.75,
                        rotMax:      rotMax,
                        phaseShift:  fragSeq * 23
                    })
                }
            }
        }
        item.shatterCacheKey = cacheKey
        item.shatterFrags    = list
        return list
    }

    // 构建逐字与静态合并片段缓存（按完整折行文本一次性构建，打字机推进时零重建）：
    //   - charShakeFrags：按单字粒度保存（兼容打字机逐字切分、char_first/char_last、局部区间震动与单字周期/相位）
    //   - charShakeUnits：当 letterSpacing === 0 时将同一行内连续、样式一致且不震动的 1.0 倍字符合并为大块静态 unit；
    //                     含震动/缩放/间隔字符保持独立单字 unit；打字机仅对跨越边界的半截静态块回退按 subFrags 绘制。
    function getOrBuildCharShakeCache(item, titleLines, subLines, titleLineCount, startY, lineStep, fontObj) {
        var minMs = max2(60, item.shakeFreqMin || CONFIG.charShakeDefaultMinMs)
        var maxMs = max2(minMs, item.shakeFreqMax || CONFIG.charShakeDefaultMaxMs)
        var isUnifiedFreq = (Math.abs(maxMs - minMs) <= 5)
        var isPerCharItem = (item.perCharShake === true || item.shakeMode === 'per_char')
        var itemSpacing   = item.letterSpacing || 0
        var cacheKey = item.wrapKey + '|f:' + minMs + '-' + maxMs + '|c:' + item.color + ':' + item.subColor + '|ls:' + itemSpacing + '|pc:' + (isPerCharItem ? 1 : 0)
        if (item.charShakeCacheKey === cacheKey && item.charShakeFrags != null && item.charShakeUnits != null) {
            return item.charShakeFrags
        }
        var baseSeed  = item.shakeSeed || 37.0
        var fragSeq   = 0
        var visSeq    = 0
        var list      = []
        var units     = []
        var pendingRun = []

        function flushStaticRun() {
            if (pendingRun.length === 0) return
            if (pendingRun.length === 1) {
                var single = pendingRun[0]
                single.visStart = single.visIndex
                single.visEnd   = single.visIndex + 1
                single.isMerged = false
                units.push(single)
                pendingRun.length = 0
                return
            }
            var first = pendingRun[0]
            var last  = pendingRun[pendingRun.length - 1]
            var plainStr = ''
            for (var pi = 0; pi < pendingRun.length; pi++) {
                plainStr += pendingRun[pi].plainText
            }
            var mergedText = (first.fmtPref || '') + plainStr
            var textEntry  = getCachedTextCompSeq(mergedText, false)
            units.push({
                isMerged:     true,
                subFrags:     pendingRun.slice(),
                visStart:     first.visIndex,
                visEnd:       last.visIndex + 1,
                visIndex:     last.visIndex,
                comp:         textEntry.comp,
                seq:          textEntry.seq,
                rawText:      mergedText,
                isBlank:      false,
                color:        first.color,
                baseX:        first.baseX,
                baseY:        first.baseY,
                w:            (last.baseX + last.w) - first.baseX,
                charScale:    1.0,
                shakeFlag:    0,
                outlineMode:  first.outlineMode,
                outlineColor: first.outlineColor,
                _muiLayout:   textEntry._muiLayout,
                _muiEpoch:    textEntry._muiEpoch,
                _muiHasEmoji: textEntry._muiHasEmoji
            })
            pendingRun.length = 0
        }

        function canExtendStaticRun(cf) {
            if (pendingRun.length === 0) return true
            var prev = pendingRun[pendingRun.length - 1]
            return cf.visIndex === (prev.visIndex + 1)
                && cf.fmtPref === prev.fmtPref
                && cf.outlineMode === prev.outlineMode
                && cf.outlineColor === prev.outlineColor
                && cf.color === prev.color
                && cf.baseY === prev.baseY
        }

        var allGroups = [
            { lines: titleLines || [], baseLineOffset: 0, color: item.color },
            { lines: subLines || [],   baseLineOffset: titleLineCount, color: item.subColor }
        ]
        for (var gIdx = 0; gIdx < allGroups.length; gIdx++) {
            var grp = allGroups[gIdx]
            for (var lIdx = 0; lIdx < grp.lines.length; lIdx++) {
                var ln = grp.lines[lIdx]
                if (!ln || ln.empty || !ln.text) continue
                var baseY    = startY + (grp.baseLineOffset + lIdx) * lineStep
                var rawFrags = splitLineIntoFragments(ln.text, 0, ln.widthPx, fontObj, 1, itemSpacing, item.letterSpacingMode)
                for (var fIdx = 0; fIdx < rawFrags.length; fIdx++) {
                    var rf = rawFrags[fIdx]
                    fragSeq++
                    var cSeed    = baseSeed + fragSeq * 31.73 + lIdx * 11.19
                    var periodMs = isUnifiedFreq
                        ? minMs
                        : (minMs + hashUnit(cSeed + 0.7) * max2(1, maxMs - minMs))
                    // 当 minMs === maxMs（如 [rnfmabj-测试] 要求统一 0.8s 震动一次）时，统一相位 0，使所有字同步触发抖动但方向各异
                    var phaseOff  = isUnifiedFreq ? 0.0 : (hashUnit(cSeed + 1.9) * 10.0)
                    var rawTxt    = rf.text || ''
                    var textPair  = getCachedTextCompSeq(rawTxt, false)
                    var isBlankFrag = (rawTxt.length > 0 && rawTxt.charCodeAt(0) <= 32 && rawTxt.indexOf('§') < 0 && /^\s+$/.test(rawTxt))
                    var absVisIdx = visSeq + (rf.visIndex != null ? rf.visIndex : fIdx)
                    var sc        = rf.charScale || 1.0
                    var sFlag     = rf.shakeFlag || 0
                    var cfObj     = {
                        comp:         textPair.comp,
                        seq:          textPair.seq,
                        rawText:      rawTxt,
                        plainText:    rf.plainText != null ? rf.plainText : rawTxt,
                        fmtPref:      rf.fmtPref != null ? rf.fmtPref : '',
                        isBlank:      isBlankFrag,
                        color:        grp.color,
                        baseX:        rf.x,
                        baseY:        baseY,
                        w:            rf.w,
                        visIndex:     absVisIdx,
                        visStart:     absVisIdx,
                        visEnd:       absVisIdx + 1,
                        isMerged:     false,
                        charScale:    sc,
                        shakeFlag:    sFlag,
                        outlineMode:  rf.outlineMode || '',
                        outlineColor: rf.outlineColor != null ? rf.outlineColor : -1,
                        cSeed:        cSeed,
                        periodMs:     periodMs,
                        invPeriod:    1.0 / periodMs,
                        phaseOff:     phaseOff,
                        _hStepIdx:    NaN,
                        _hSeed:       NaN,
                        _oStepIdx:    NaN,
                        _oSeed:       NaN,
                        _oTheta:      0.0,
                        _oCos:        1.0,
                        _oSin:        0.0,
                        _settledStep: NaN,
                        _settledSeed: NaN,
                        _settledAmp:  -1,
                        _settledCfg:  null,
                        _settledDx:   0.0,
                        _settledDy:   0.0,
                        _settledRot:  0.0,
                        _muiLayout:   textPair._muiLayout,
                        _muiEpoch:    textPair._muiEpoch,
                        _muiHasEmoji: textPair._muiHasEmoji
                    }
                    list.push(cfObj)

                    var charShakes = (sFlag === 1) || (isPerCharItem && sFlag !== -1)
                    var mergeEligible = (!charShakes) && (itemSpacing === 0) && Math.abs(sc - 1.0) <= 0.01 && !isBlankFrag
                    if (mergeEligible) {
                        if (!canExtendStaticRun(cfObj)) flushStaticRun()
                        pendingRun.push(cfObj)
                    } else {
                        flushStaticRun()
                        units.push(cfObj)
                    }
                }
                flushStaticRun()
                visSeq += (ln.vis != null ? ln.vis : countVisibleChars(ln.text))
            }
        }
        item._charShakeUnifiedFreq    = isUnifiedFreq
        item._charShakeSharedPeriodMs = isUnifiedFreq ? minMs : NaN
        item.charShakeCacheKey        = cacheKey
        item.charShakeFrags           = list
        item.charShakeUnits           = units
        return list
    }

    // 预编译单条弹幕的逐字抖动配置：消除每帧逐字重复 Number/String/toLowerCase/clampNum 类型解析开销
    function getCharShakeConfig(item) {
        if (item != null && item._charShakeCfg != null) return item._charShakeCfg
        var styleStr  = (item != null && item.charShakeStyle != null) ? String(item.charShakeStyle).toLowerCase() : 'omni'
        var styleCode = (styleStr === 'horizontal_step' || styleStr === 'h_step' || styleStr === 'horizontal')
            ? 1
            : ((styleStr === 'smooth' || styleStr === 'drift') ? 2 : 0)
        var shiftBase   = (item != null && item.charShakeShift != null && isFinite(Number(item.charShakeShift))) ? Number(item.charShakeShift) : 0.32
        var shiftXScale = (item != null && item.charShakeShiftX != null && isFinite(Number(item.charShakeShiftX))) ? Number(item.charShakeShiftX) : shiftBase
        var shiftYScale = (item != null && item.charShakeShiftY != null && isFinite(Number(item.charShakeShiftY))) ? Number(item.charShakeShiftY) : (shiftBase * 0.75)
        var swayXScale  = (item != null && item.charShakeSwayX != null && isFinite(Number(item.charShakeSwayX))) ? Number(item.charShakeSwayX) : 0.88
        var swayYScale  = (item != null && item.charShakeSwayY != null && isFinite(Number(item.charShakeSwayY))) ? Number(item.charShakeSwayY) : 0.0
        var rotDegAmp   = clampNum((item != null && item.charShakeRotDeg != null && isFinite(Number(item.charShakeRotDeg))) ? Number(item.charShakeRotDeg) : 0.0, 0.0, 45.0)
        var swayWin     = clampNum((item != null && item.charShakeWin != null && isFinite(Number(item.charShakeWin))) ? Number(item.charShakeWin) : 0.38, 0.05, 1.0)
        var transMode   = (item != null && item.charShakeTransition != null) ? String(item.charShakeTransition).toLowerCase() : 'smooth'
        var isSnap      = Boolean(item && item.charShakeSnap) || transMode === 'snap' || transMode === 'instant' || transMode === 'step' || transMode === '0'
        var transWin    = 0.16
        if (!isSnap && transMode !== '') {
            var transNum = Number(transMode)
            if (isFinite(transNum)) {
                transWin = transNum <= 0 ? 0.0 : clampNum(transNum, 0.01, 1.0)
            }
        }
        var jitterWin   = clampNum((item != null && item.charShakeWin != null && isFinite(Number(item.charShakeWin))) ? Number(item.charShakeWin) : 0.26, 0.05, 1.0)
        var cfg = {
            styleCode:   styleCode,
            shiftXScale: shiftXScale,
            shiftYScale: shiftYScale,
            swayXScale:  swayXScale,
            swayYScale:  swayYScale,
            rotDegAmp:   rotDegAmp,
            swayWin:     swayWin,
            isSnap:      isSnap,
            transWin:    transWin,
            jitterWin:   jitterWin
        }
        if (item != null) item._charShakeCfg = cfg
        return cfg
    }

    var ILLEGAL_SHARED_TIMING_VAL = NaN

    function markSharedTimingIllegal(shared, reason) {
        if (shared == null) shared = {}
        shared.canShare      = false
        shared.illegalReason = reason || 'DISALLOWED'
        shared.styleCode     = -1
        shared.periodMs      = ILLEGAL_SHARED_TIMING_VAL
        shared.invPeriod     = ILLEGAL_SHARED_TIMING_VAL
        shared.phaseOff      = ILLEGAL_SHARED_TIMING_VAL
        shared.cyc           = ILLEGAL_SHARED_TIMING_VAL
        shared.stepIdx       = ILLEGAL_SHARED_TIMING_VAL
        shared.frac          = ILLEGAL_SHARED_TIMING_VAL
        shared.pulse         = ILLEGAL_SHARED_TIMING_VAL
        shared.wave          = ILLEGAL_SHARED_TIMING_VAL
        shared.transT        = ILLEGAL_SHARED_TIMING_VAL
        return shared
    }

    // 弹幕级共享时序预计算：
    //   【可以】整条弹幕仅计算一次 pulse / wave / transT 的场合（仅限全条共享同一周期与零相位偏移时）：
    //     1) item._charShakeUnifiedFreq === true（即 Math.abs(shakeFreqMax - shakeFreqMin) <= 5ms，如默认统一 800ms）；
    //     2) styleCode === 0 ('omni') 或 styleCode === 1 ('horizontal_step')；
    //     3) ageMs >= 0 且 periodMs > 0 均有限。
    //   【不能】共用一次 pulse / wave 的场合（触发即显式将共享时序字段置为非法哨兵 NaN，绝不沿用陈旧值）：
    //     1) 非统一周期 [shakeFreqMin, shakeFreqMax]（每字拥有独立随机 periodMs 与 phaseOff -> 各自 cyc/stepIdx/frac 不同）；
    //     2) styleCode === 2 ('smooth' 连续双谐波漂移 -> 相位直接乘入每字独有 seed)；
    //     3) item / charFrags 为空、或 ageMs / periodMs 非法；
    //     4) 单字消费端若发现 cf.periodMs !== shared.periodMs 或 cf.phaseOff !== shared.phaseOff，同样拒绝共享并转入单字采样。
    function prepareSharedCharShakeTiming(item, ageMs, charFrags) {
        var shared = (item != null && item._sharedShakeTiming != null) ? item._sharedShakeTiming : {}
        if (item != null) item._sharedShakeTiming = shared
        if (item == null || charFrags == null || charFrags.length === 0) {
            return markSharedTimingIllegal(shared, 'EMPTY_OR_NULL')
        }
        if (item._charShakeUnifiedFreq !== true) {
            return markSharedTimingIllegal(shared, 'NON_UNIFIED_CHAR_FREQ')
        }
        if (!(ageMs >= 0 && isFinite(ageMs))) {
            return markSharedTimingIllegal(shared, 'INVALID_AGE')
        }
        var cfg = getCharShakeConfig(item)
        if (cfg.styleCode === 2) {
            return markSharedTimingIllegal(shared, 'STYLE_SMOOTH_PER_CHAR_PHASE')
        }
        var periodMs = item._charShakeSharedPeriodMs
        if (!(periodMs > 0 && isFinite(periodMs))) {
            var minMs = max2(60, item.shakeFreqMin || CONFIG.charShakeDefaultMinMs)
            var maxMs = max2(minMs, item.shakeFreqMax || CONFIG.charShakeDefaultMaxMs)
            if (Math.abs(maxMs - minMs) > 5) {
                return markSharedTimingIllegal(shared, 'NON_UNIFIED_CHAR_FREQ')
            }
            periodMs = minMs
        }
        var invPer  = 1.0 / periodMs
        var cyc     = ageMs * invPer
        var stepIdx = Math.floor(cyc)
        var frac    = cyc - stepIdx

        var pulse  = 0.0
        var wave   = 0.0
        var transT = 1.0
        if (cfg.styleCode === 1) {
            if (!cfg.isSnap && cfg.transWin > 0 && frac < cfg.transWin) {
                transT = frac / cfg.transWin
            }
            if (frac < cfg.swayWin) {
                var u = frac / cfg.swayWin
                wave  = fastSinTurns(u * 1.25) * (1.0 - u)
            }
        } else {
            if (frac < cfg.jitterWin) {
                var pu = frac / cfg.jitterWin
                pulse  = fastSinTurns(pu * 1.5) * (1.0 - pu) * 0.85
            }
        }

        shared.canShare      = true
        shared.illegalReason = ''
        shared.styleCode     = cfg.styleCode
        shared.periodMs      = periodMs
        shared.invPeriod     = invPer
        shared.phaseOff      = 0.0
        shared.cyc           = cyc
        shared.stepIdx       = stepIdx
        shared.frac          = frac
        shared.pulse         = pulse
        shared.wave          = wave
        shared.transT        = transT
        return shared
    }

    // 在有序 units 上二分定位与当前可见窗口 [startSkipVis, keepEndVis) 相交的下标区间 [lo, hi)
    function findVisibleUnitRange(units, startSkipVis, keepEndVis) {
        var n = units != null ? units.length : 0
        if (n === 0 || keepEndVis <= startSkipVis) return { lo: 0, hi: 0 }
        // 下界：首个 visEnd > startSkipVis 的位置
        var l = 0
        var r = n
        while (l < r) {
            var mid = (l + r) >>> 1
            var uEnd = units[mid].visEnd != null ? units[mid].visEnd : (units[mid].visIndex + 1)
            if (uEnd <= startSkipVis) l = mid + 1
            else r = mid
        }
        var lo = l
        // 上界：首个 visStart >= keepEndVis 的位置
        l = lo
        r = n
        while (l < r) {
            var mid2 = (l + r) >>> 1
            var uStart = units[mid2].visStart != null ? units[mid2].visStart : units[mid2].visIndex
            if (uStart < keepEndVis) l = mid2 + 1
            else r = mid2
        }
        return { lo: lo, hi: l }
    }

    function isUnitOutOfViewport(localCx, localCy, halfW, halfH, px, py, mxx, mxy, myx, myy, sw, sh, extraPadPx) {
        if (!(sw > 0 && sh > 0)) return false
        var wx   = px + mxx * localCx + mxy * localCy
        var wy   = py + myx * localCx + myy * localCy
        var extX = Math.abs(mxx) * halfW + Math.abs(mxy) * halfH + extraPadPx
        var extY = Math.abs(myx) * halfW + Math.abs(myy) * halfH + extraPadPx
        return (wx + extX) < 0.0 || (wx - extX) > sw || (wy + extY) < 0.0 || (wy - extY) > sh
    }

    // 计算单字在当前时刻的独立微抖动偏移（完全由样式参数控制，绝不在渲染器内写死单一效果）：
    //   - 'horizontal_step'：每 periodMs 触发 1 次轻微随机落点位移 (charShakeShift) + 初段水平/垂直阻尼晃动 (charShakeSwayX/Y, charShakeWin)
    //   - 'smooth'         ：按 periodMs 做连续双谐波平滑漂移
    //   - 'omni' (默认)    ：全向随机脉冲轻颤 + 极微弱残余偏移
    function sampleCharShakeOffset(cf, ageMs, curAmp, item, outObj, sharedTiming) {
        var dst  = outObj || CHAR_OFFSET_SCRATCH
        var ampN = curAmp
        if (typeof ampN !== 'number') ampN = Number(curAmp)
        if (!isFinite(ampN) || ampN <= 0) {
            dst.dx     = 0.0
            dst.dy     = 0.0
            dst.rotDeg = 0.0
            return dst
        }
        var effAmp  = ampN < 0.05 ? 0.05 : (ampN > 2.5 ? 2.5 : ampN)
        var seed    = (cf != null && cf.cSeed) ? cf.cSeed : 1.0
        var cfg     = getCharShakeConfig(item)

        var useShared = (
            sharedTiming != null &&
            sharedTiming.canShare === true &&
            sharedTiming.styleCode === cfg.styleCode &&
            isFinite(sharedTiming.cyc) &&
            isFinite(sharedTiming.stepIdx) &&
            isFinite(sharedTiming.frac) &&
            isFinite(sharedTiming.pulse) &&
            isFinite(sharedTiming.wave) &&
            isFinite(sharedTiming.transT) &&
            cf != null &&
            Math.abs(cf.periodMs - sharedTiming.periodMs) <= 1e-3 &&
            Math.abs((cf.phaseOff || 0.0) - (sharedTiming.phaseOff || 0.0)) <= 1e-6
        )

        var cyc, stepIdx, frac
        if (useShared) {
            cyc     = sharedTiming.cyc
            stepIdx = sharedTiming.stepIdx
            frac    = sharedTiming.frac
        } else {
            var invPer = (cf != null && cf.invPeriod > 0) ? cf.invPeriod : (1.0 / max2(60, Number(cf && cf.periodMs) || 800))
            var ageN   = (ageMs >= 0 && isFinite(ageMs)) ? ageMs : 0.0
            cyc     = (ageN * invPer) + ((cf != null && cf.phaseOff) ? cf.phaseOff : 0.0)
            stepIdx = Math.floor(cyc)
            frac    = cyc - stepIdx
        }

        // 稳态保持段快照：同一 stepIdx 且振幅/配置未变且已离开初段脉冲/过渡窗口，直接复用上一帧计算结果
        if (cf != null && cf._settledStep === stepIdx && cf._settledSeed === seed && cf._settledAmp === effAmp && cf._settledCfg === cfg) {
            dst.dx     = cf._settledDx
            dst.dy     = cf._settledDy
            dst.rotDeg = cf._settledRot
            return dst
        }

        var rawDx      = 0.0
        var rawDy      = 0.0
        var rawRotDeg  = 0.0
        var canSettle  = false

        if (cfg.styleCode === 1) {
            var needPrev = (!cfg.isSnap && cfg.transWin > 0 && frac < cfg.transWin)
            var nextDx, nextDy, nextRot, dirSignX, dirSignY
            if (cf != null) {
                if (cf._hStepIdx !== stepIdx || cf._hSeed !== seed) {
                    cf._hStepIdx  = stepIdx
                    cf._hSeed     = seed
                    cf._hNextX    = hashUnit(stepIdx * 17.13 + seed) * 2.0 - 1.0
                    cf._hNextY    = hashUnit(stepIdx * 29.71 + seed + 5.3) * 2.0 - 1.0
                    cf._hNextR    = cfg.rotDegAmp > 0 ? (hashUnit(stepIdx * 61.37 + seed + 13.7) * 2.0 - 1.0) : 0.0
                    cf._hDirSignX = (hashUnit(stepIdx * 43.17 + seed + 9.1) >= 0.5) ? 1.0 : -1.0
                    cf._hDirSignY = (hashUnit(stepIdx * 53.29 + seed + 3.7) >= 0.5) ? 1.0 : -1.0
                    cf._hCacheAmp = -1
                }
                if (cf._hCacheAmp !== effAmp) {
                    cf._hCacheAmp = effAmp
                    cf._hNextDx   = cf._hNextX * cfg.shiftXScale * effAmp
                    cf._hNextDy   = cf._hNextY * cfg.shiftYScale * effAmp
                    cf._hNextRot  = cfg.rotDegAmp > 0 ? (cf._hNextR * cfg.rotDegAmp * 0.65) : 0.0
                }
                nextDx   = cf._hNextDx
                nextDy   = cf._hNextDy
                nextRot  = cf._hNextRot
                dirSignX = cf._hDirSignX
                dirSignY = cf._hDirSignY
            } else {
                nextDx   = (hashUnit(stepIdx * 17.13 + seed) * 2.0 - 1.0) * cfg.shiftXScale * effAmp
                nextDy   = (hashUnit(stepIdx * 29.71 + seed + 5.3) * 2.0 - 1.0) * cfg.shiftYScale * effAmp
                nextRot  = cfg.rotDegAmp > 0 ? ((hashUnit(stepIdx * 61.37 + seed + 13.7) * 2.0 - 1.0) * cfg.rotDegAmp * 0.65) : 0.0
                dirSignX = (hashUnit(stepIdx * 43.17 + seed + 9.1) >= 0.5) ? 1.0 : -1.0
                dirSignY = (hashUnit(stepIdx * 53.29 + seed + 3.7) >= 0.5) ? 1.0 : -1.0
            }

            if (needPrev) {
                var hPrevX, hPrevY, hPrevR
                if (cf != null) {
                    if (cf._hPrevStepIdx !== stepIdx || cf._hPrevSeed !== seed) {
                        cf._hPrevStepIdx = stepIdx
                        cf._hPrevSeed    = seed
                        cf._hPrevX       = hashUnit((stepIdx - 1) * 17.13 + seed) * 2.0 - 1.0
                        cf._hPrevY       = hashUnit((stepIdx - 1) * 29.71 + seed + 5.3) * 2.0 - 1.0
                        cf._hPrevR       = cfg.rotDegAmp > 0 ? (hashUnit((stepIdx - 1) * 61.37 + seed + 13.7) * 2.0 - 1.0) : 0.0
                    }
                    hPrevX = cf._hPrevX
                    hPrevY = cf._hPrevY
                    hPrevR = cf._hPrevR
                } else {
                    hPrevX = hashUnit((stepIdx - 1) * 17.13 + seed) * 2.0 - 1.0
                    hPrevY = hashUnit((stepIdx - 1) * 29.71 + seed + 5.3) * 2.0 - 1.0
                    hPrevR = cfg.rotDegAmp > 0 ? (hashUnit((stepIdx - 1) * 61.37 + seed + 13.7) * 2.0 - 1.0) : 0.0
                }
                var shiftT = useShared ? sharedTiming.transT : (frac / cfg.transWin)
                var prevDx = hPrevX * cfg.shiftXScale * effAmp
                var prevDy = hPrevY * cfg.shiftYScale * effAmp
                rawDx = prevDx + (nextDx - prevDx) * shiftT
                rawDy = prevDy + (nextDy - prevDy) * shiftT
                if (cfg.rotDegAmp > 0) {
                    var prevRot = hPrevR * cfg.rotDegAmp * 0.65
                    rawRotDeg = prevRot + (nextRot - prevRot) * shiftT
                }
            } else {
                rawDx     = nextDx
                rawDy     = nextDy
                rawRotDeg = nextRot
            }

            if (frac < cfg.swayWin) {
                var wave
                if (useShared) {
                    wave = sharedTiming.wave
                } else {
                    var u = frac / cfg.swayWin
                    wave  = fastSinTurns(u * 1.25) * (1.0 - u)
                }
                rawDx += dirSignX * wave * effAmp * cfg.swayXScale
                rawDy += dirSignY * wave * effAmp * cfg.swayYScale
                if (cfg.rotDegAmp > 0) {
                    rawRotDeg += dirSignX * wave * cfg.rotDegAmp * 0.55
                }
            } else if (!needPrev && cfg.swayXScale === 0 && cfg.swayYScale === 0) {
                canSettle = true
            }
            var seedTurns = seed * INV_TWO_PI
            if (cfg.swayXScale !== 0) {
                rawDx += fastSinTurns(frac + seedTurns) * 0.10 * cfg.swayXScale * effAmp
            }
            if (cfg.swayYScale !== 0) {
                rawDy += fastCosTurns(frac + seedTurns * 1.3) * 0.10 * cfg.swayYScale * effAmp
            }
        } else if (cfg.styleCode === 2) {
            var sT = seed * INV_TWO_PI
            var nx = fastSinTurns(cyc + sT * 1.73) * 0.72 + fastCosTurns(cyc * 0.53 + sT * 3.11) * 0.28
            var ny = fastCosTurns(cyc * 0.87 + sT * 2.37) * 0.72 + fastSinTurns(cyc * 0.47 + sT * 4.19) * 0.28
            rawDx = nx * effAmp * 0.95
            rawDy = ny * effAmp * 1.15
        } else {
            var cosTheta, sinTheta
            if (cf != null) {
                if (cf._oStepIdx !== stepIdx || cf._oSeed !== seed) {
                    cf._oStepIdx = stepIdx
                    cf._oSeed    = seed
                    var turn0    = hashUnit(stepIdx * 19.37 + seed)
                    cf._oTheta   = turn0 * PI * 2.0
                    cf._oCos     = fastCosTurns(turn0)
                    cf._oSin     = fastSinTurns(turn0)
                }
                cosTheta = cf._oCos
                sinTheta = cf._oSin
            } else {
                var turn1 = hashUnit(stepIdx * 19.37 + seed)
                cosTheta = fastCosTurns(turn1)
                sinTheta = fastSinTurns(turn1)
            }
            var pulse = 0.0
            if (frac < cfg.jitterWin) {
                if (useShared) {
                    pulse = sharedTiming.pulse
                } else {
                    var pu = frac / cfg.jitterWin
                    pulse  = fastSinTurns(pu * 1.5) * (1.0 - pu) * 0.85
                }
            } else {
                canSettle = true
            }
            var mag = (0.22 + pulse) * effAmp
            rawDx = cosTheta * mag * 0.78
            rawDy = sinTheta * mag * 0.92
        }

        var maxDx = CONFIG.charShakeMaxDxPx
        var maxDy = CONFIG.charShakeMaxDyPx
        dst.dx     = isFinite(rawDx) ? (rawDx < -maxDx ? -maxDx : (rawDx > maxDx ? maxDx : rawDx)) : 0.0
        dst.dy     = isFinite(rawDy) ? (rawDy < -maxDy ? -maxDy : (rawDy > maxDy ? maxDy : rawDy)) : 0.0
        dst.rotDeg = isFinite(rawRotDeg) ? rawRotDeg : 0.0

        if (canSettle && cf != null) {
            cf._settledStep = stepIdx
            cf._settledSeed = seed
            cf._settledAmp  = effAmp
            cf._settledCfg  = cfg
            cf._settledDx   = dst.dx
            cf._settledDy   = dst.dy
            cf._settledRot  = dst.rotDeg
        }
        return dst
    }

    // 颜色打包辅助：原版 Font.adjustColor 对 alpha < 4 的颜色值会强制回退为 255 不透明，故钳制在 [5, 255]
    function packArgb(rgbColor, alphaByte) {
        var rgb = ((rgbColor != null && isFinite(rgbColor)) ? Math.round(rgbColor) : 0xFF5555) & 0x00FFFFFF
        var a   = clampNum(Math.round(alphaByte), 5, 255) & 0xFF
        return (a << 24) | rgb
    }

    var EVENT_CAP_PROBED      = false
    var HAS_SET_SHADER_COLOR  = false
    var HAS_RESET_SHADER      = false
    var HAS_EVENT_BLEND       = false

    function ensureEventCaps(event) {
        if (EVENT_CAP_PROBED || event == null) return
        EVENT_CAP_PROBED     = true
        HAS_SET_SHADER_COLOR = (typeof event.setShaderColor === 'function')
        HAS_RESET_SHADER     = (typeof event.resetShaderColor === 'function')
        HAS_EVENT_BLEND      = (typeof event.blend === 'function')
    }

    function setShaderAlphaSafe(event, alphaUnit) {
        ensureEventCaps(event)
        if (!HAS_SET_SHADER_COLOR) return
        event.setShaderColor(1.0, 1.0, 1.0, clampNum(alphaUnit, 0.02, 1.0))
    }

    function resetShaderAlphaSafe(event) {
        ensureEventCaps(event)
        if (HAS_RESET_SHADER) {
            event.resetShaderColor()
        } else if (HAS_SET_SHADER_COLOR) {
            event.setShaderColor(1.0, 1.0, 1.0, 1.0)
        }
    }

    var ITEM_POSE_SCRATCH = {
        needed: false,
        pushed: false,
        px:     0.0,
        py:     0.0,
        angle:  0.0,
        scaleX: 1.0,
        scaleY: 1.0
    }

    function ensureFallbackBlend(event, batchCtx) {
        ensureEventCaps(event)
        if (!HAS_EVENT_BLEND) return
        if (batchCtx != null) {
            if (batchCtx.prevBlend === null) {
                batchCtx.prevBlend = queryGlBlendEnabled()
                if (batchCtx.prevBlend !== true) {
                    event.blend(true)
                    batchCtx.needBlendRestore = true
                }
            }
            return
        }
        event.blend(true)
    }

    function applyItemPoseToEvent(event, px, py, angle, scaleX, scaleY) {
        event.push()
        event.translate(px, py)
        if (angle !== 0 && isFinite(angle)) {
            event.rotateDeg(angle)
        }
        if ((scaleX !== 1.0 || scaleY !== 1.0) && isFinite(scaleX) && isFinite(scaleY)) {
            if (typeof event['scale(float,float,float)'] === 'function') {
                event['scale(float,float,float)'](scaleX, scaleY, 1.0)
            } else if (typeof event['scale(float,float)'] === 'function') {
                event['scale(float,float)'](scaleX, scaleY)
            } else {
                event.scale(scaleX, scaleY, 1.0)
            }
        }
    }

    function ensureItemPosePushed(event) {
        if (ITEM_POSE_SCRATCH.needed && !ITEM_POSE_SCRATCH.pushed) {
            applyItemPoseToEvent(event, ITEM_POSE_SCRATCH.px, ITEM_POSE_SCRATCH.py, ITEM_POSE_SCRATCH.angle, ITEM_POSE_SCRATCH.scaleX, ITEM_POSE_SCRATCH.scaleY)
            ITEM_POSE_SCRATCH.pushed = true
        }
    }

    // 负 Z 分层辅助：对非旋转/缩放单元按 Z 偏移复用整条 item 的缓存矩阵，避免逐字重复 set+translate JNI 调用
    function startOutlineZMat(batchCtx, baseMat, zStart) {
        if (batchCtx == null || baseMat == null) return baseMat
        if (batchCtx.itemMat != null && baseMat === batchCtx.itemMat) {
            if (batchCtx.itemOutMat != null) {
                if (batchCtx.itemOutZ1 === zStart) return batchCtx.itemOutMat
                if (isNaN(batchCtx.itemOutZ1)) {
                    try {
                        batchCtx.itemOutMat.set(baseMat)
                        batchCtx.itemOutMat.translate(0.0, 0.0, zStart)
                        batchCtx.itemOutZ1 = zStart
                        return batchCtx.itemOutMat
                    } catch (eZ1) {
                        batchCtx.itemOutMat = null
                    }
                }
            }
            if (batchCtx.itemOutMat2 != null) {
                if (batchCtx.itemOutZ2 === zStart) return batchCtx.itemOutMat2
                if (isNaN(batchCtx.itemOutZ2)) {
                    try {
                        batchCtx.itemOutMat2.set(baseMat)
                        batchCtx.itemOutMat2.translate(0.0, 0.0, zStart)
                        batchCtx.itemOutZ2 = zStart
                        return batchCtx.itemOutMat2
                    } catch (eZ2) {
                        batchCtx.itemOutMat2 = null
                    }
                }
            }
        }
        if (batchCtx.outMat != null) {
            try {
                if (typeof batchCtx.outMat.set === 'function') {
                    batchCtx.outMat.set(baseMat)
                }
                batchCtx.outMat.translate(0.0, 0.0, zStart)
                return batchCtx.outMat
            } catch (eZMat) {
                batchCtx.outMat = null
            }
        }
        return baseMat
    }

    function drawBatchedPassRgb(batchCtx, effSeq, preLayout, drawMode, x, y, r, g, b, byteA, packedCol, shadow, mat, ownerUnit) {
        if (preLayout != null && batchCtx.muiActive) {
            return drawMuiLayoutPassRgb(batchCtx, preLayout, x, y, r, g, b, byteA, shadow, mat, drawMode)
        }
        var useSeq = effSeq
        if (useSeq == null && ownerUnit != null) {
            ensureUnitCompSeq(ownerUnit)
            useSeq = ownerUnit.seq
        }
        return drawBatchedGlyph(batchCtx, useSeq, x, y, packedCol, shadow, mat, null, drawMode)
    }

    function drawBatchedRing(batchCtx, effSeq, preLayout, outlineMuiMode, gx, gy, mat, zOffset, dxTbl, dyTbl, rad, oR, oG, oB, byteA, oColRgb, ownerUnit) {
        if (batchCtx == null || BATCH_FAILED || mat == null) return false
        var rMat = startOutlineZMat(batchCtx, mat, zOffset)
        var n    = dxTbl.length
        if (preLayout != null && batchCtx.muiActive) {
            var aVal = clampNum(Math.round(byteA), 0, 255)
            if (aVal <= 0) return true
            var bufSrc = batchCtx.bufSrc
            try {
                for (var mi = 0; mi < n; mi++) {
                    preLayout.drawText(rMat, bufSrc, gx + dxTbl[mi] * rad, gy + dyTbl[mi] * rad, oR, oG, oB, aVal, false, outlineMuiMode, false, 1.0, 0, 15728880)
                }
                batchCtx.drawn += n
                return true
            } catch (eMuiRing) {
                markMuiDegraded(batchCtx)
                logErrorThrottled('ModernUI TextLayout.drawText ring fallback', eMuiRing)
                return false
            }
        }

        var useSeq = effSeq
        if (useSeq == null && ownerUnit != null) {
            ensureUnitCompSeq(ownerUnit)
            useSeq = ownerUnit.seq
        }
        if (useSeq == null) return false
        var packedCol = packArgb(oColRgb, byteA)
        var buf = batchCtx.bufSrc
        var font = batchCtx.font
        var disp = batchCtx.displayMode
        try {
            if (batchCtx.drawFn != null) {
                var df = batchCtx.drawFn
                for (var di = 0; di < n; di++) {
                    df.call(font, useSeq, gx + dxTbl[di] * rad, gy + dyTbl[di] * rad, packedCol, false, rMat, buf, disp, 0, 15728880)
                }
            } else if (batchCtx.useDirectSrgDraw) {
                for (var si = 0; si < n; si++) {
                    font.m_272191_(useSeq, gx + dxTbl[si] * rad, gy + dyTbl[si] * rad, packedCol, false, rMat, buf, disp, 0, 15728880)
                }
            } else {
                for (var bi = 0; bi < n; bi++) {
                    font.drawInBatch(useSeq, gx + dxTbl[bi] * rad, gy + dyTbl[bi] * rad, packedCol, false, rMat, buf, disp, 0, 15728880)
                }
            }
            batchCtx.drawn += n
            return true
        } catch (eRingBatch) {
            markBatchFailed(batchCtx)
            logErrorThrottled('drawInBatch ring fallback', eRingBatch)
            return false
        }
    }

    // 合批路径外圈采样：
    //   - glow：4 向 45° 对称柔光 (0.90 * oRad, alpha ~0.41)，仅设 1 次负 Z 矩阵
    //   - stroke：8 向外环轮廓 + 大半径时 4 向内环桥接 (ModernUI SDF 模式下 1.15px 以下 8 向已无缝闭合)
    //   - mui_stroke：显式调用 ModernUI 原生 1-Pass GPU SDF 空心描边；缺 ModernUI/含 Emoji 时自动落回标准 8 向 stroke
    function drawBatchedOutline(batchCtx, effSeq, preLayout, outlineMuiMode, gx, gy, mat, outMode, oColRgb, oRad, baseA, ownerUnit) {
        var oR = (oColRgb >>> 16) & 0xFF
        var oG = (oColRgb >>> 8) & 0xFF
        var oB = oColRgb & 0xFF

        if (outMode === 'glow') {
            var glowByte = Math.round(0.41 * baseA * 255)
            if (glowByte < OUTLINE_ALPHA_CUTOFF) return true
            return drawBatchedRing(batchCtx, effSeq, preLayout, outlineMuiMode, gx, gy, mat, -0.055, GLOW_4_DX, GLOW_4_DY, oRad * 0.90, oR, oG, oB, glowByte, oColRgb, ownerUnit)
        }

        var strokeByte = Math.round(0.92 * baseA * 255)
        if (strokeByte < OUTLINE_ALPHA_CUTOFF) return true

        if (outMode === 'mui_stroke' && preLayout != null && batchCtx.muiActive && batchCtx.muiHasDrawOutline && !(ownerUnit != null && ownerUnit._muiHasEmoji)) {
            var mOutMat = startOutlineZMat(batchCtx, mat, -0.045)
            try {
                preLayout.drawTextOutline(mOutMat, batchCtx.bufSrc, gx, gy, oR, oG, oB, clampNum(Math.round(strokeByte), 0, 255), 15728880)
                batchCtx.drawn++
                return true
            } catch (eMuiOut) {
                logErrorThrottled('ModernUI TextLayout.drawTextOutline fallback', eMuiOut)
            }
        }

        // stroke 实心描边：8 向圆周轮廓 + 较大半径时的 4 向内环桥接
        if (!drawBatchedRing(batchCtx, effSeq, preLayout, outlineMuiMode, gx, gy, mat, -0.045, OUTLINE_8_DX, OUTLINE_8_DY, oRad, oR, oG, oB, strokeByte, oColRgb, ownerUnit)) {
            return false
        }
        var midThresh = (preLayout != null && batchCtx.muiActive && batchCtx.muiAllowSdf) ? 1.15 : 0.82
        if (oRad > midThresh) {
            drawBatchedRing(batchCtx, effSeq, preLayout, outlineMuiMode, gx, gy, mat, -0.018, CARDINAL_4_DX, CARDINAL_4_DY, oRad * 0.48, oR, oG, oB, strokeByte, oColRgb, ownerUnit)
        }
        return true
    }

    var ITEM_RENDER_CTX_SCRATCH = {
        event:               null,
        batchCtx:            null,
        baseItemMat:         null,
        shadow:              false,
        defOutMod:           'none',
        defOutCol:           -1,
        outWidth:            0.75,
        outlineMuiMode:      0,
        itemBaseCoreMode:    0,
        itemMixedSdfMode:    0,
        canGroupPasses:      false,
        fadeStyle:           'shrink',
        inFade:              false,
        fadeProgress:        0.0,
        isBlurFade:          false,
        isSplitFade:         false,
        invP:                1.0,
        baseA:               1.0,
        splitHaloAlpha:      0,
        splitCoreByte:       255,
        splitSpreadPx:       0.65,
        splitCoreShd:        false,
        blurRad:             0.35,
        blurY:               0.2275,
        blurMistAlpha:       0.0,
        blurMistByte:        0,
        blurCoreUnit:        1.0,
        blurCoreByte:        255,
        blurGlowOutAlpha:    1.0,
        blurAllowShadowTime: false
    }

    function prepareItemRenderCtx(event, item, itemBatchCtx, defOutMod, defOutCol, defOutWid, inFade, fadeProgress) {
        var fadeStyle   = item.fadeStyle
        var isBlurFade  = (inFade && fadeStyle === 'blur')
        var isSplitFade = (inFade && fadeStyle === 'split')
        if ((isBlurFade || isSplitFade) && fadeProgress >= 0.97) return null

        var invP  = inFade ? clampNum(1.0 - fadeProgress, 0.0, 1.0) : 1.0
        var baseA = (isBlurFade || isSplitFade) ? (invP * invP) : 1.0
        if (baseA <= 0.025) return null

        var rCtx = ITEM_RENDER_CTX_SCRATCH
        var shd  = Boolean(item.shadow)
        var outM = defOutMod || 'none'
        var baseMat = (itemBatchCtx != null) ? itemBatchCtx.itemMat : null
        var outMuiMode = (itemBatchCtx != null && itemBatchCtx.muiAllowSdf) ? 1 : 0
        var baseCoreMode = 0
        if (itemBatchCtx != null && itemBatchCtx.muiActive && baseMat != null) {
            baseCoreMode = (outM !== 'none' || isBlurFade || isSplitFade)
                ? outMuiMode
                : computeMuiDrawMode(itemBatchCtx, baseMat, false)
        }
        var isPerCharItem = (item.perCharShake === true || item.shakeMode === 'per_char')
        var hasSdfInline  = (item.hasSdfInlineTags === true)
        var hasMixedSdf   = (outM !== 'none' || isBlurFade || isSplitFade || hasSdfInline || (isPerCharItem && (item.charShakeRotDeg || 0) > 0))
        rCtx.event            = event
        rCtx.batchCtx         = itemBatchCtx
        rCtx.baseItemMat      = baseMat
        rCtx.shadow           = shd
        rCtx.defOutMod        = outM
        rCtx.defOutCol        = defOutCol != null ? defOutCol : -1
        rCtx.outWidth         = defOutWid || 0.75
        rCtx.outlineMuiMode   = outMuiMode
        rCtx.itemBaseCoreMode = baseCoreMode
        rCtx.itemMixedSdfMode = hasMixedSdf ? outMuiMode : baseCoreMode
        rCtx.canGroupPasses   = (itemBatchCtx != null && itemBatchCtx.canDirectMatrix && !isBlurFade && !isSplitFade && (outM !== 'none' || shd || hasSdfInline))
        rCtx.fadeStyle        = fadeStyle
        rCtx.inFade           = Boolean(inFade)
        rCtx.fadeProgress     = fadeProgress
        rCtx.isBlurFade       = isBlurFade
        rCtx.isSplitFade      = isSplitFade
        rCtx.invP             = invP
        rCtx.baseA            = baseA

        if (isSplitFade) {
            var haloBellS    = Math.sin(clampNum(fadeProgress, 0.05, 0.95) * PI)
            rCtx.splitHaloAlpha = clampNum(Math.round((invP * 0.72 + haloBellS * 0.28) * 72), 5, 96)
            rCtx.splitCoreByte  = clampNum(Math.round(baseA * 245 + 6), 5, 255)
            rCtx.splitSpreadPx  = 0.65 + fadeProgress * 2.85
            rCtx.splitCoreShd   = shd && fadeProgress < 0.42
        } else if (isBlurFade) {
            var blurRad         = 0.35 + fadeProgress * 0.48
            var mistAlpha       = clampNum(invP * (0.36 + 0.24 * Math.sin(fadeProgress * PI)), 0.03, 0.56)
            var coreBlurUnit    = clampNum(invP * invP * (1.0 - fadeProgress * 0.35), 0.03, 1.0)
            rCtx.blurRad        = blurRad
            rCtx.blurY          = blurRad * 0.65
            rCtx.blurMistAlpha  = mistAlpha
            rCtx.blurMistByte   = clampNum(Math.round(mistAlpha * 255), 5, 145)
            rCtx.blurCoreUnit   = coreBlurUnit
            rCtx.blurCoreByte   = clampNum(Math.round(coreBlurUnit * 255), 5, 255)
            rCtx.blurGlowOutAlpha    = (fadeProgress >= 0.42 ? 0.0 : (baseA * (1.0 - fadeProgress / 0.42)))
            rCtx.blurAllowShadowTime = shd && fadeProgress < 0.35
        }
        return rCtx
    }

    function tryDrawUnitBatched(rCtx, unit, floatX, floatY, halfW, rgbColor, outMode, outColor, charScale, hasUnitRot, unitRotDeg) {
        var batchCtx = rCtx.batchCtx
        var baseItemMat = rCtx.baseItemMat
        if (batchCtx == null || BATCH_FAILED || baseItemMat == null) return false

        var preLayout = resolveUnitMuiLayout(batchCtx, unit.seq, unit)
        var useMuiCore = (preLayout != null && batchCtx.muiActive)
        var effSeq = unit.seq
        if (!useMuiCore) {
            ensureUnitCompSeq(unit)
            effSeq = unit.seq
            if (effSeq == null) return false
        } else {
            flushEmojiSheetIfNeeded(batchCtx, preLayout, unit)
        }

        var sc = (charScale != null && isFinite(charScale) && charScale > 0.2) ? charScale : 1.0
        var hasUnitScale = (Math.abs(sc - 1.0) > 0.01)
        var needUnitTransform = (hasUnitScale || hasUnitRot)
        var hasAnyOutline = (outMode === 'stroke' || outMode === 'glow' || outMode === 'mui_stroke')
        // 统一让同字符/同混排条目的外圈与主体沿用 SDF(1)，防止 BufferSource 在 MODE_NORMAL(0) 与 SDF(1) 间频繁切换触发断批冲洗
        var outlineMuiMode = rCtx.outlineMuiMode
        var event          = rCtx.event

        if (rCtx.isSplitFade) {
            var haloAlphaS = rCtx.splitHaloAlpha
            var spreadPxS  = rCtx.splitSpreadPx
            if (haloAlphaS >= OUTLINE_ALPHA_CUTOFF) {
                var hColB = useMuiCore ? 0 : packArgb(rgbColor, haloAlphaS)
                var hMatS = startOutlineZMat(batchCtx, baseItemMat, -0.024)
                var hcR = (rgbColor >>> 16) & 0xFF
                var hcG = (rgbColor >>> 8) & 0xFF
                var hcB = rgbColor & 0xFF
                if (!drawBatchedPassRgb(batchCtx, effSeq, preLayout, outlineMuiMode, floatX - spreadPxS, floatY, hcR, hcG, hcB, haloAlphaS, hColB, false, hMatS, unit)) return false
                drawBatchedPassRgb(batchCtx, effSeq, preLayout, outlineMuiMode, floatX + spreadPxS, floatY, hcR, hcG, hcB, haloAlphaS, hColB, false, hMatS, unit)
                drawBatchedPassRgb(batchCtx, effSeq, preLayout, outlineMuiMode, floatX, floatY - spreadPxS * 0.78, hcR, hcG, hcB, haloAlphaS, hColB, false, hMatS, unit)
                drawBatchedPassRgb(batchCtx, effSeq, preLayout, outlineMuiMode, floatX, floatY + spreadPxS * 0.78, hcR, hcG, hcB, haloAlphaS, hColB, false, hMatS, unit)
            }
            var sR = (rgbColor >>> 16) & 0xFF
            var sG = (rgbColor >>> 8) & 0xFF
            var sB = rgbColor & 0xFF
            return drawBatchedPassRgb(batchCtx, effSeq, preLayout, outlineMuiMode, floatX, floatY, sR, sG, sB, rCtx.splitCoreByte, useMuiCore ? 0 : packArgb(rgbColor, rCtx.splitCoreByte), rCtx.splitCoreShd, baseItemMat, unit)
        }

        var unitPushed = false
        try {
            var mat, gx, gy
            if (needUnitTransform) {
                var hw = halfW || 0
                if (batchCtx.canDirectMatrix) {
                    var uMat = batchCtx.unitMat
                    uMat.set(baseItemMat)
                    uMat.translate(floatX + hw, floatY + 4.0, 0.0)
                    if (hasUnitRot) uMat.rotateZ(unitRotDeg * DEG_TO_RAD)
                    if (hasUnitScale) uMat.scale(sc, sc, 1.0)
                    mat = uMat
                    gx  = -hw
                    gy  = -4.0
                } else {
                    ensureItemPosePushed(event)
                    event.push()
                    unitPushed = true
                    var cx = floatX + hw
                    var cy = floatY + 4.0
                    event.translate(cx, cy)
                    if (hasUnitRot && typeof event.rotateDeg === 'function') {
                        event.rotateDeg(unitRotDeg)
                    }
                    if (hasUnitScale) {
                        if (typeof event['scale(float,float)'] === 'function') {
                            event['scale(float,float)'](sc, sc)
                        } else {
                            event.scale(sc, sc, 1.0)
                        }
                    }
                    mat = (batchCtx.hasGetMatrixFn ? event.getMatrix() : event.matrix)
                    gx  = -hw
                    gy  = -4.0
                }
            } else {
                mat = baseItemMat
                gx  = floatX
                gy  = floatY
            }

            if (hasAnyOutline) {
                // 虚化淡出后半段由扩散虚影接管，提前收掉外圈发光，大幅压低 fade 峰值 pass 数
                var effOutAlpha = (rCtx.isBlurFade && outMode === 'glow')
                    ? rCtx.blurGlowOutAlpha
                    : rCtx.baseA
                if (effOutAlpha > 0.01) {
                    var oColRgb = (outColor != null && outColor >= 0) ? outColor : (outMode === 'glow' ? rgbColor : 0x050A10)
                    var oRad    = clampNum(rCtx.outWidth || (outMode === 'glow' ? 0.85 : 0.72), 0.25, 2.5)
                    if (!drawBatchedOutline(batchCtx, effSeq, preLayout, outlineMuiMode, gx, gy, mat, outMode, oColRgb, oRad, effOutAlpha, unit)) {
                        return false
                    }
                }
            }

            var coreMuiMode  = (hasAnyOutline || rCtx.isBlurFade || needUnitTransform)
                ? outlineMuiMode
                : rCtx.itemMixedSdfMode
            var cR           = (rgbColor >>> 16) & 0xFF
            var cG           = (rgbColor >>> 8) & 0xFF
            var cB           = rgbColor & 0xFF

            if (rCtx.isBlurFade) {
                var mistEffB = Math.round(rCtx.blurMistAlpha * 255)
                if (mistEffB >= OUTLINE_ALPHA_CUTOFF) {
                    var blurRad = rCtx.blurRad
                    var blurY   = rCtx.blurY
                    var mMatB   = startOutlineZMat(batchCtx, mat, -0.020)
                    var mistCol = useMuiCore ? 0 : packArgb(rgbColor, mistEffB)
                    if (!drawBatchedPassRgb(batchCtx, effSeq, preLayout, outlineMuiMode, gx - blurRad, gy - blurY, cR, cG, cB, mistEffB, mistCol, false, mMatB, unit)) return false
                    drawBatchedPassRgb(batchCtx, effSeq, preLayout, outlineMuiMode, gx + blurRad, gy + blurY, cR, cG, cB, mistEffB, mistCol, false, mMatB, unit)
                }
                var coreEffB = rCtx.blurCoreByte
                var blurShd  = rCtx.blurAllowShadowTime && (outMode === 'none')
                return drawBatchedPassRgb(batchCtx, effSeq, preLayout, coreMuiMode, gx, gy, cR, cG, cB, coreEffB, useMuiCore ? 0 : packArgb(rgbColor, coreEffB), blurShd, mat, unit)
            }

            var useShadow = rCtx.shadow && (outMode === 'none')
            if (useMuiCore && useShadow && batchCtx.muiAllowShadow !== false && needUnitTransform && batchCtx.canDirectMatrix && mat === batchCtx.unitMat) {
                try {
                    preLayout.drawText(mat, batchCtx.bufSrc, gx, gy, cR >>> 2, cG >>> 2, cB >>> 2, 255, true, coreMuiMode, false, 1.0, 0, 15728880)
                    mat.translate(0.0, 0.0, 0.03)
                    preLayout.drawText(mat, batchCtx.bufSrc, gx, gy, cR, cG, cB, 255, false, coreMuiMode, false, 1.0, 0, 15728880)
                    batchCtx.drawn += 2
                    return true
                } catch (eShdInline) {
                    markMuiDegraded(batchCtx)
                    logErrorThrottled('ModernUI TextLayout.drawText inline shadow fallback', eShdInline)
                    return false
                }
            }
            return drawBatchedPassRgb(batchCtx, effSeq, preLayout, coreMuiMode, gx, gy, cR, cG, cB, 255, useMuiCore ? 0 : packArgb(rgbColor, 255), useShadow, mat, unit)
        } finally {
            if (unitPushed) {
                try { event.pop() } catch (eUPop) { }
            }
        }
    }

    function acquirePassMat(idx) {
        if (idx < PASS_MAT_POOL.length) return PASS_MAT_POOL[idx]
        if (Matrix4fClass == null) return null
        var m = new Matrix4fClass()
        PASS_MAT_POOL.push(m)
        return m
    }

    // 分 Pass 合批渲染（Pass1: 全员外圈 -> Pass2: ModernUI 全员阴影 -> Pass3: 全员正文前景）：
    //   1) 彻底消灭同一条弹幕内部“外圈/MODE_SDF_STROKE/MODE_NORMAL/MODE_SDF_FILL”交错导致的 BufferSource 断批 Flush；
    //   2) 消除邻近字外圈/阴影覆盖前字亮边；
    //   3) 结合 itemOutMat / itemFgMat 与单位就地 Z 平移，最大化削减 Matrix4f JNI 复制与传参。
    function drawUnitsPassGrouped(rCtx, entries, count) {
        if (rCtx == null || count <= 0) return
        var batchCtx    = rCtx.batchCtx
        var baseItemMat = rCtx.baseItemMat
        if (batchCtx == null || BATCH_FAILED || baseItemMat == null) {
            for (var fi = 0; fi < count; fi++) {
                var fe = entries[fi]
                drawRichUnit(rCtx, fe.unit, fe.floatX, fe.floatY, fe.unitRotDeg)
            }
            return
        }

        var anyOutline   = false
        var anyMuiShadow = false
        var muiAllowShd  = (batchCtx.muiAllowShadow !== false)
        var passMatUsed  = 0
        var outlineMuiMode = rCtx.outlineMuiMode
        var coreMuiMode    = rCtx.itemMixedSdfMode
        var useMuiGlobal   = batchCtx.muiActive

        // 预准备所有可视单元的布局与变换矩阵（每个变换单元仅构建一次 uMat）
        for (var i = 0; i < count; i++) {
            var en   = entries[i]
            var unit = en.unit
            var preLayout = useMuiGlobal ? resolveUnitMuiLayout(batchCtx, unit.seq, unit) : null
            var useMui    = (preLayout != null && batchCtx.muiActive)
            en.preLayout  = preLayout
            en.useMui     = useMui
            if (useMui) {
                flushEmojiSheetIfNeeded(batchCtx, preLayout, unit)
            } else {
                ensureUnitCompSeq(unit)
            }

            if (en.needTransform) {
                var pMat = acquirePassMat(passMatUsed)
                if (pMat != null) {
                    passMatUsed++
                    pMat.set(baseItemMat)
                    pMat.translate(en.floatX + en.halfW, en.floatY + 4.0, 0.0)
                    if (en.hasUnitRot) pMat.rotateZ(en.unitRotDeg * DEG_TO_RAD)
                    if (en.hasUnitScale) pMat.scale(en.charScale, en.charScale, 1.0)
                    en.mat = pMat
                    en.gx  = -en.halfW
                    en.gy  = -4.0
                } else {
                    // Matrix 池无法分配时退回单字路径
                    for (var ri = i; ri < count; ri++) {
                        var remE = entries[ri]
                        drawRichUnit(rCtx, remE.unit, remE.floatX, remE.floatY, remE.unitRotDeg)
                    }
                    count = i
                    break
                }
            } else {
                en.mat = baseItemMat
                en.gx  = en.floatX
                en.gy  = en.floatY
            }

            if (en.outMode !== 'none') anyOutline = true
            else if (rCtx.shadow && useMui && muiAllowShd) anyMuiShadow = true
            en.outlineOk = false
        }
        if (count <= 0) return

        // Pass 1：统一绘制所有单元的外圈层（z = -0.045 / -0.055 / -0.018）
        if (anyOutline) {
            var baseA  = rCtx.baseA
            var oRad   = clampNum(rCtx.outWidth || 0.75, 0.25, 2.5)
            for (var p1 = 0; p1 < count; p1++) {
                var e1 = entries[p1]
                if (e1.outMode === 'none') continue
                if (!e1.useMui && e1.unit.seq == null) continue
                var oColRgb = (e1.outColor != null && e1.outColor >= 0) ? e1.outColor : (e1.outMode === 'glow' ? e1.rgbColor : 0x050A10)
                e1.outlineOk = drawBatchedOutline(batchCtx, e1.unit.seq, e1.preLayout, outlineMuiMode, e1.gx, e1.gy, e1.mat, e1.outMode, oColRgb, oRad, baseA, e1.unit)
            }
        }

        // Pass 2：统一绘制 ModernUI 阴影层（z = 0.0）
        var bufSrc = batchCtx.bufSrc
        if (anyMuiShadow && batchCtx.muiActive) {
            for (var p2 = 0; p2 < count; p2++) {
                var e2 = entries[p2]
                if (!e2.useMui || e2.preLayout == null || e2.outMode !== 'none' || !rCtx.shadow) continue
                try {
                    var c2 = e2.rgbColor
                    e2.preLayout.drawText(e2.mat, bufSrc, e2.gx, e2.gy, ((c2 >>> 16) & 0xFF) >>> 2, ((c2 >>> 8) & 0xFF) >>> 2, (c2 & 0xFF) >>> 2, 255, true, coreMuiMode, false, 1.0, 0, 15728880)
                    batchCtx.drawn++
                } catch (eShdPass) {
                    markMuiDegraded(batchCtx)
                    e2.useMui = false
                    logErrorThrottled('ModernUI TextLayout.drawText shadow pass fallback', eShdPass)
                }
            }
        }

        // Pass 3：统一绘制全员正文前景层（z = +0.03 或 0.0）
        for (var p3 = 0; p3 < count; p3++) {
            var e3   = entries[p3]
            var u3   = e3.unit
            var shd3 = rCtx.shadow && (e3.outMode === 'none')
            if (e3.useMui && e3.preLayout != null && batchCtx.muiActive) {
                var fgMat = e3.mat
                if (shd3 && muiAllowShd) {
                    if (e3.mat === baseItemMat && batchCtx.itemFgMat != null) {
                        if (!batchCtx.itemFgReady) {
                            batchCtx.itemFgMat.set(baseItemMat)
                            batchCtx.itemFgMat.translate(0.0, 0.0, 0.03)
                            batchCtx.itemFgReady = true
                        }
                        fgMat = batchCtx.itemFgMat
                    } else if (e3.needTransform && e3.mat != null) {
                        e3.mat.translate(0.0, 0.0, 0.03)
                        fgMat = e3.mat
                    }
                }
                var c3 = e3.rgbColor
                try {
                    e3.preLayout.drawText(fgMat, bufSrc, e3.gx, e3.gy, (c3 >>> 16) & 0xFF, (c3 >>> 8) & 0xFF, c3 & 0xFF, 255, false, coreMuiMode, false, 1.0, 0, 15728880)
                    batchCtx.drawn++
                    continue
                } catch (eCorePass) {
                    markMuiDegraded(batchCtx)
                    ensureUnitCompSeq(u3)
                    logErrorThrottled('ModernUI TextLayout.drawText core pass fallback', eCorePass)
                }
            }
            if (u3.seq != null && !BATCH_FAILED) {
                if (drawBatchedGlyph(batchCtx, u3.seq, e3.gx, e3.gy, packArgb(e3.rgbColor, 255), shd3, e3.mat, null, 0)) {
                    continue
                }
            }
            drawRichUnit(rCtx, u3, e3.floatX, e3.floatY, e3.unitRotDeg)
        }
    }

    // 统一绘制函数：仅接收严格恒定的 item 级上下文 rCtx + 单元对象 unit + (floatX, floatY, unitRotDeg) 共 5 参，消除 18~21 参热路径传参分配
    function drawRichUnit(rCtx, unit, floatX, floatY, unitRotDeg) {
        if (rCtx == null || unit == null) return
        if (!isFinite(floatX) || !isFinite(floatY)) return

        var rgbColor   = unit.color
        var outMode    = (unit.outlineMode && unit.outlineMode.length > 0) ? unit.outlineMode : rCtx.defOutMod
        var outColor   = (unit.outlineColor != null && unit.outlineColor >= 0) ? unit.outlineColor : rCtx.defOutCol
        var charScale  = unit.charScale
        var halfW      = (unit.w != null) ? (unit.w * 0.5) : 0.0
        var hasUnitRot = (unitRotDeg != null && isFinite(unitRotDeg) && Math.abs(unitRotDeg) > 0.15)

        if (rCtx.batchCtx != null && !BATCH_FAILED) {
            if (tryDrawUnitBatched(rCtx, unit, floatX, floatY, halfW, rgbColor, outMode, outColor, charScale, hasUnitRot, unitRotDeg)) {
                return
            }
        }

        var event      = rCtx.event
        ensureUnitCompSeq(unit)
        var comp       = unit.comp
        var isBlurFade = rCtx.isBlurFade
        var shadow     = rCtx.shadow

        ensureFallbackBlend(event, rCtx.batchCtx)
        ensureItemPosePushed(event)

        var needMatrix = (Math.abs(floatX - Math.round(floatX)) > 0.01) ||
                         (Math.abs(floatY - Math.round(floatY)) > 0.01) ||
                         (charScale != null && Math.abs(charScale - 1.0) > 0.01) ||
                         hasUnitRot ||
                         (outMode === 'stroke' || outMode === 'glow' || outMode === 'mui_stroke') ||
                         isBlurFade

        if (!needMatrix && !rCtx.isSplitFade) {
            var fastCol = packArgb(rgbColor, 255)
            event.text(comp, Math.round(floatX) || 0, Math.round(floatY) || 0, fastCol, shadow)
            GRAPHICS_TEXT_DIRTY = true
            return
        }

        if (rCtx.isSplitFade) {
            // 保留“逐渐分解成数个字体”的裂解淡出效果 (fade: 'split')
            var coreAlphaS = rCtx.splitCoreByte
            var haloAlphaS = rCtx.splitHaloAlpha
            var spreadPxS  = rCtx.splitSpreadPx
            var sx = Math.round(spreadPxS) || 1
            var sy = Math.round(spreadPxS * 0.78) || 1
            var rx = Math.round(floatX) || 0
            var ry = Math.round(floatY) || 0
            setShaderAlphaSafe(event, haloAlphaS / 255.0)
            var hColS = packArgb(rgbColor, haloAlphaS)
            event.text(comp, rx - sx, ry, hColS, false)
            event.text(comp, rx + sx, ry, hColS, false)
            event.text(comp, rx, ry - sy, hColS, false)
            event.text(comp, rx, ry + sy, hColS, false)
            setShaderAlphaSafe(event, coreAlphaS / 255.0)
            event.text(comp, rx, ry, packArgb(rgbColor, coreAlphaS), rCtx.splitCoreShd)
            resetShaderAlphaSafe(event)
            GRAPHICS_TEXT_DIRTY = true
            return
        }

        var unitPushed = false
        try {
            event.push()
            unitPushed = true
            var sc = (charScale != null && isFinite(charScale) && charScale > 0.2) ? charScale : 1.0
            if (Math.abs(sc - 1.0) > 0.01 || hasUnitRot) {
                var cx = floatX + halfW
                var cy = floatY + 4.0
                event.translate(cx, cy)
                if (hasUnitRot && typeof event.rotateDeg === 'function') {
                    event.rotateDeg(unitRotDeg)
                }
                if (Math.abs(sc - 1.0) > 0.01) {
                    if (typeof event['scale(float,float)'] === 'function') {
                        event['scale(float,float)'](sc, sc)
                    } else {
                        event.scale(sc, sc, 1.0)
                    }
                }
                event.translate(-halfW, -4.0)
            } else {
                event.translate(floatX, floatY)
            }

            // 1. 外圈绘制（回退路径与合批路径一致：glow 4 向对称柔光，stroke/mui_stroke 8 向轮廓，增量平移消除内层 push/pop）
            if (outMode === 'stroke' || outMode === 'glow' || outMode === 'mui_stroke') {
                var isGlowFb      = (outMode === 'glow')
                var effOutAlphaFb = (isBlurFade && isGlowFb) ? rCtx.blurGlowOutAlpha : rCtx.baseA
                if (effOutAlphaFb > 0.01) {
                    var oColRgb = (outColor != null && outColor >= 0)
                        ? outColor
                        : (isGlowFb ? rgbColor : 0x050A10)
                    var oRad = clampNum(rCtx.outWidth || (isGlowFb ? 0.85 : 0.72), 0.25, 2.5) * (isGlowFb ? 0.90 : 1.0)
                    var outAlphaUnit = (isGlowFb ? 0.41 : 0.92) * effOutAlphaFb
                    var outAlphaByte = Math.round(outAlphaUnit * 255)
                    if (outAlphaByte >= OUTLINE_ALPHA_CUTOFF) {
                        var packedOutCol = packArgb(oColRgb, outAlphaByte)
                        setShaderAlphaSafe(event, outAlphaUnit)
                        var dxTbl = isGlowFb ? GLOW_4_DX : OUTLINE_8_DX
                        var dyTbl = isGlowFb ? GLOW_4_DY : OUTLINE_8_DY
                        var curDx = 0.0
                        var curDy = 0.0
                        for (var fi = 0; fi < dxTbl.length; fi++) {
                            var nx = dxTbl[fi] * oRad
                            var ny = dyTbl[fi] * oRad
                            event.translate(nx - curDx, ny - curDy)
                            curDx = nx
                            curDy = ny
                            event.text(comp, 0, 0, packedOutCol, false)
                        }
                        event.translate(-curDx, -curDy)
                    }
                }
            }

            // 2. 淡出虚化 (blur)：回退路径同样采用增量平移消除内层 push/pop，并收敛为对角双通道虚影
            if (isBlurFade) {
                var blurRad   = rCtx.blurRad
                var blurY2    = rCtx.blurY
                var mistAlpha = rCtx.blurMistAlpha
                var mistCol   = packArgb(rgbColor, rCtx.blurMistByte)
                setShaderAlphaSafe(event, mistAlpha)

                event.translate(-blurRad, -blurY2)
                event.text(comp, 0, 0, mistCol, false)
                event.translate(blurRad * 2.0, blurY2 * 2.0)
                event.text(comp, 0, 0, mistCol, false)
                event.translate(-blurRad, -blurY2)

                setShaderAlphaSafe(event, rCtx.blurCoreUnit)
                event.text(comp, 0, 0, packArgb(rgbColor, rCtx.blurCoreByte), rCtx.blurAllowShadowTime && (outMode === 'none'))
                resetShaderAlphaSafe(event)
            } else {
                // 正常主字绘制
                if (outMode === 'stroke' || outMode === 'glow') {
                    resetShaderAlphaSafe(event)
                }
                var mainCol = packArgb(rgbColor, 255)
                var useShadow = shadow && (outMode === 'none')
                event.text(comp, 0, 0, mainCol, useShadow)
            }
        } finally {
            resetShaderAlphaSafe(event)
            if (unitPushed) {
                try { event.pop() } catch (eUPop) { }
            }
        }
    }

    function smoothNoise1D(t, seed) {
        var i0 = Math.floor(t)
        var f  = t - i0
        var u  = f * f * (3.0 - 2.0 * f)
        var v0 = hashUnit(i0 + seed) * 2.0 - 1.0
        var v1 = hashUnit(i0 + 1 + seed) * 2.0 - 1.0
        return v0 + (v1 - v0) * u
    }

    function sampleContinuousShakeOffset(item, ageMs, curShake, outObj) {
        var dst = outObj || { x: 0, y: 0 }
        if (curShake <= 0) {
            dst.x = 0
            dst.y = 0
            return dst
        }
        var seed  = item.shakeSeed || 17.31
        var tSlow = ageMs * 0.022
        var tFast = ageMs * 0.058
        var nx = smoothNoise1D(tSlow, seed) * 0.72 + smoothNoise1D(tFast, seed + 101.7) * 0.28
        var ny = smoothNoise1D(tSlow, seed + 53.9) * 0.72 + smoothNoise1D(tFast, seed + 167.3) * 0.28
        dst.x = clampNum(nx, -1.0, 1.0) * curShake
        dst.y = clampNum(ny, -1.0, 1.0) * curShake
        return dst
    }

    // 为折行后的单行对象按需构建 O(1) 可见字素切分边界与累计像素宽度表（仅在打字机或 char_first/char_last 首次访问该行时构建 1 次）
    function ensureLineVisTable(ln, fontObj, letterSpacingPx, spacingMode) {
        var spacing = (letterSpacingPx != null && isFinite(letterSpacingPx)) ? Number(letterSpacingPx) : 0
        var spMode  = spacingMode || 'relative'
        if (ln._visEndIdx != null &&
            ln._visTableSp === spacing &&
            ln._visTableMode === spMode &&
            ln._visTableEpoch === MUI_EPOCH &&
            ln._visTableFont === fontObj) {
            return ln
        }
        var str       = ln.text || ''
        if (str.indexOf('\n') >= 0 || str.indexOf('\r') >= 0) {
            ln._visEndIdx = null
            ln._visHasNewline = true
            return ln
        }
        var checkTags  = Boolean(ln.hasTags) || hasRichSpanTags(str)
        var endIndices = [0]
        var cumWidths  = [0]
        var isBold     = false
        var tagState   = { tagBold: false, charScale: 1.0, shakeFlag: 0, outlineMode: '', outlineColor: -1 }
        var curW       = 0

        for (var i = 0; i < str.length;) {
            var code = str.charCodeAt(i)
            if (code === 167 && (i + 1) < str.length) {
                var fc = str.charAt(i + 1).toLowerCase()
                if (fc === 'l') isBold = true
                else if ((fc >= '0' && fc <= '9') || (fc >= 'a' && fc <= 'f') || fc === 'r') isBold = false
                i += 2
                continue
            }
            if (checkTags) {
                var tag = matchInlineTagAt(str, i)
                if (tag != null) {
                    applyInlineTagToState(tag, tagState)
                    i += tag.rawLen
                    continue
                }
            }
            var g = readGraphemeCluster(str, i)
            var effBold = isBold || tagState.tagBold
            var baseCw  = measureClusterWidthPx(g.cluster, effBold, fontObj) * tagState.charScale
            var cw      = baseCw + computeClusterSpacing(baseCw, spacing, spMode)
            curW += cw
            i = g.nextIndex
            // 与 sliceVisibleChars 严格保持逐字符一致：吸收紧跟在当前可见字素之后的 § 格式码与闭合/内联标签
            while (i < str.length) {
                var nextCode = str.charCodeAt(i)
                if (nextCode === 167 && (i + 1) < str.length) {
                    var nfc = str.charAt(i + 1).toLowerCase()
                    if (nfc === 'l') isBold = true
                    else if ((nfc >= '0' && nfc <= '9') || (nfc >= 'a' && nfc <= 'f') || nfc === 'r') isBold = false
                    i += 2
                    continue
                }
                if (checkTags) {
                    var trailTag = matchInlineTagAt(str, i)
                    if (trailTag != null) {
                        applyInlineTagToState(trailTag, tagState)
                        i += trailTag.rawLen
                        continue
                    }
                }
                break
            }
            endIndices.push(i)
            cumWidths.push(curW)
        }
        ln._visEndIdx     = endIndices
        ln._visCumW       = cumWidths
        ln._visTableSafe  = !checkTags
        ln._visTableSp    = spacing
        ln._visTableMode  = spMode
        ln._visTableEpoch = MUI_EPOCH
        ln._visTableFont  = fontObj
        return ln
    }

    function buildRenderedLines(wrappedLines, startSkipVis, keepEndVis, appendCursor, fontObj, letterSpacingPx, spacingMode, needEndPx) {
        if (!wrappedLines || wrappedLines.length === 0) return []
        var out = []
        var cursorIdx = 0
        var lastActiveIdx = -1
        var calcEndPx = (needEndPx !== false)

        for (var i = 0; i < wrappedLines.length; i++) {
            var ln        = wrappedLines[i]
            var lineStart = cursorIdx
            var lineEnd   = cursorIdx + ln.vis
            cursorIdx     = lineEnd

            if (lineEnd <= startSkipVis || lineStart >= keepEndVis) {
                continue
            }

            var localSkip = max2(0, startSkipVis - lineStart)
            var localKeep = min2(ln.vis, keepEndVis - lineStart)
            if (localKeep <= localSkip) continue

            // O(1) 查表快速路径：当 localSkip === 0（打字机正向推进或整行显示）且已构建（或按需构建）行级字素表时，
            // 直接用 substring(0, _visEndIdx[localKeep]) 与 _visCumW[localKeep] 完成切片与光标定位，0 循环、0 重复测宽！
            if (localSkip === 0 && localKeep === ln.vis) {
                var fullEndPx = 0
                if (calcEndPx) {
                    fullEndPx = (ln.widthPx || 0) + (letterSpacingPx > 0 ? computeClusterSpacing(9, letterSpacingPx, spacingMode) : 0)
                }
                out.push({
                    text:        ln.text,
                    fullW:       ln.widthPx,
                    offsetPx:    0,
                    endPx:       fullEndPx,
                    lineIndex:   i,
                    isTransient: false
                })
                lastActiveIdx = out.length - 1
                continue
            }

            if (localSkip === 0) {
                ensureLineVisTable(ln, fontObj, letterSpacingPx, spacingMode)
                if (ln._visEndIdx != null && localKeep < ln._visEndIdx.length) {
                    var fastSlice = ln.text.substring(0, ln._visEndIdx[localKeep])
                    if (fastSlice.length > 0) {
                        var fastEndPx = calcEndPx ? (ln._visCumW[localKeep] || 0) : 0
                        out.push({
                            text:        fastSlice,
                            fullW:       ln.widthPx,
                            offsetPx:    0,
                            endPx:       fastEndPx,
                            lineIndex:   i,
                            isTransient: true
                        })
                        lastActiveIdx = out.length - 1
                        continue
                    }
                }
            }

            var sliced  = (localKeep < ln.vis) ? sliceVisibleChars(ln.text, localKeep) : ln.text
            var dropped = (localSkip > 0) ? dropFirstVisibleChars(sliced, localSkip, fontObj, letterSpacingPx, spacingMode) : { text: sliced, offsetPx: 0 }
            if (dropped.text && dropped.text.length > 0) {
                var endPx = 0
                if (calcEndPx) {
                    endPx = (localKeep >= ln.vis)
                        ? ((ln.widthPx || 0) + (letterSpacingPx > 0 ? computeClusterSpacing(9, letterSpacingPx, spacingMode) : 0))
                        : dropFirstVisibleChars(sliced, 999999, fontObj, letterSpacingPx, spacingMode).offsetPx
                }
                out.push({
                    text:        dropped.text,
                    fullW:       ln.widthPx,
                    offsetPx:    dropped.offsetPx,
                    endPx:       endPx,
                    lineIndex:   i,
                    isTransient: (localSkip > 0 || localKeep < ln.vis)
                })
                lastActiveIdx = out.length - 1
            }
        }

        if (appendCursor && appendCursor.length > 0 && lastActiveIdx >= 0) {
            out[lastActiveIdx].text += appendCursor
        }
        return out
    }

    function computeCurrentShakeAmp(item, now, age, fadeStartAt, fadeWin) {
        var mode = item.shakeMode
        var base = item.shakeAmp
        if (!mode || mode === 'none' || base <= 0) return 0.0

        if (mode === 'constant' || mode === 'per_char') {
            return base
        }
        if (mode === 'decay') {
            var shakeBase = item.shakeDurationMs || item.holdDurationMs || 2000
            var decayWin  = clampNum(shakeBase * 0.42, 220, 850)
            if (age >= decayWin) return 0.0
            var t = clampNum(1.0 - (age / decayWin), 0.0, 1.0)
            return base * (t * t * 1.45)
        }
        if (mode === 'fade_in') {
            var preLead   = min2(350, fadeWin * 0.6)
            var shakeFrom = fadeStartAt - preLead
            if (now < shakeFrom) return 0.0
            var totalSpan = max2(1, item.expire - shakeFrom)
            var p = clampNum((now - shakeFrom) / totalSpan, 0.0, 1.0)
            return base * (0.3 + p * p * 1.55)
        }
        if (mode === 'pulse') {
            var wave = Math.sin(age * 0.025)
            return wave > 0.35 ? base * wave : 0.0
        }
        return base
    }

    function applyStopToOverlay(ov, now, customFadeTicks) {
        // 先解除 'active' 持续状态，确保已越过 fadeStartAt 正在淡出的条目不再作为 active 保留；
        // 再检查 now < ov.fadeStartAt：若已处于淡出后半段则沿用原 fadeStartAt，避免把 alpha 重置回 1.0 引起闪烁。
        ov.lifeMode = 'once'
        var fMs = customFadeTicks > 0 ? max2(CONFIG.minFadeMs, customFadeTicks * 50) : (ov.fadeMs || 500)
        if (now < ov.fadeStartAt) {
            ov.fadeMs      = fMs
            ov.fadeStartAt = now
            ov.expire      = now + fMs
        }
    }

    // 单一权威时间模型计算：
    //   修复打字机模式下“打完字立刻进入淡出”的问题：
    //   当 typewriter=true 时，reqHoldMs (stay / duration) 作为打字全部完成后的完整阅读停留时长叠加在纯打字时长之后，
    //   确保长句打完后依然有充足的阅读与抖动展示时间，随后再进入 fadeMs 淡出。
    function computeOverlaySchedule(lifeMode, requestedHoldTicks, fadeTicks, typewriter, totalVis, charMs, now, elapsedMs) {
        var reqHoldMs  = max2(CONFIG.minHoldMs, requestedHoldTicks * 50)
        var reqFadeMs  = max2(CONFIG.minFadeMs, fadeTicks * 50)
        var pureTypeMs = (typewriter && totalVis > 0) ? (totalVis * charMs) : 0
        var remTypeMs  = max2(0, pureTypeMs - max2(0, elapsedMs || 0))

        if (lifeMode === 'active') {
            var activeHoldMs = max2(reqHoldMs, remTypeMs + CONFIG.typeReadBufferMs)
            var activeFadeAt = now + activeHoldMs
            return {
                holdDurationMs:  activeHoldMs,
                shakeDurationMs: reqHoldMs,
                fadeMs:          reqFadeMs,
                fadeStartAt:     activeFadeAt,
                expireAt:        activeFadeAt + reqFadeMs
            }
        }

        // 单次触发模式 (once)：
        //   若带打字机：总存活时间 = 剩余打字时间 remTypeMs + 完整维持停留时间 reqHoldMs + 淡出时间 reqFadeMs；
        //   若不带打字机：总周期为 reqHoldMs，淡出占末尾 fadeMs。
        if (typewriter && totalVis > 0) {
            var holdAfterTypeMs = max2(CONFIG.typeReadBufferMs, reqHoldMs)
            var twFadeStart     = now + remTypeMs + holdAfterTypeMs
            var twTotalDurMs    = remTypeMs + holdAfterTypeMs + reqFadeMs
            return {
                holdDurationMs:  twTotalDurMs,
                shakeDurationMs: remTypeMs + holdAfterTypeMs,
                fadeMs:          reqFadeMs,
                fadeStartAt:     twFadeStart,
                expireAt:        twFadeStart + reqFadeMs
            }
        }

        var fadeMs     = max2(CONFIG.minFadeMs, min2(reqHoldMs * CONFIG.maxOnceFadeRatio, reqFadeMs))
        var totalDurMs = max2(reqHoldMs, fadeMs + CONFIG.minHoldMs)
        var fadeStart  = now + max2(0, totalDurMs - fadeMs)
        return {
            holdDurationMs:  totalDurMs,
            shakeDurationMs: reqHoldMs,
            fadeMs:          fadeMs,
            fadeStartAt:     fadeStart,
            expireAt:        fadeStart + fadeMs
        }
    }

    // ------------------------------------------------------------------------
    // v6 适配器、Rhino/NBT 安全转换、状态变量插值轨道 (vars + tracks + action:'patch') 与几何裁剪纯函数
    // ------------------------------------------------------------------------
    var REPLACED_TEXTURE_REGISTRY = {}
    var TEXTURE_EXIST_CACHE       = createLocalBoundedCache(512)

    function safeTypeOf(v) {
        if (v === null) return 'object'
        if (v === undefined) return 'undefined'
        try {
            return typeof v
        } catch (e) {
            return 'object'
        }
    }

    function safeCallZeroArg(obj, mojName, srgName) {
        if (obj == null) return undefined
        try {
            if (mojName && typeof obj[mojName] === 'function') return obj[mojName]()
        } catch (e1) { }
        try {
            if (srgName && typeof obj[srgName] === 'function') return obj[srgName]()
        } catch (e2) { }
        return undefined
    }

    function safeCallOneArg(obj, mojName, srgName, arg) {
        if (obj == null) return undefined
        try {
            if (mojName && typeof obj[mojName] === 'function') return obj[mojName](arg)
        } catch (e1) { }
        try {
            if (srgName && typeof obj[srgName] === 'function') return obj[srgName](arg)
        } catch (e2) { }
        return undefined
    }

    function isRealCompoundTag(obj) {
        if (obj == null) return false
        try {
            return (typeof obj.getAllKeys === 'function' || typeof obj.m_128431_ === 'function') &&
                   (typeof obj.get === 'function' || typeof obj.m_128423_ === 'function')
        } catch (e) {
            return false
        }
    }

    function isRealListTagOrJavaList(obj) {
        if (obj == null || Array.isArray(obj)) return false
        if (isRealCompoundTag(obj)) return false
        try {
            return (typeof obj.size === 'function' && typeof obj.get === 'function' && typeof obj.getAllKeys !== 'function' && typeof obj.m_128431_ !== 'function')
        } catch (e) {
            return false
        }
    }

    function isPlainObjLike(v) {
        return v != null && safeTypeOf(v) === 'object' && !Array.isArray(v)
    }

    function nbtToPlainJs(val, depth) {
        if (val === null || val === undefined) return val
        var d = depth || 0
        if (d > 16) return val
        var t = safeTypeOf(val)
        if (t === 'boolean' || t === 'number' || t === 'string') return val

        // Real MC CompoundTag (skips Test 30/31 FakeCompoundTag which lacks getAllKeys/get)
        if (isRealCompoundTag(val)) {
            var resObj = {}
            var keySet = safeCallZeroArg(val, 'getAllKeys', 'm_128431_')
            if (keySet != null) {
                try {
                    if (typeof keySet.iterator === 'function') {
                        var it = keySet.iterator()
                        while (it.hasNext()) {
                            var k = String(it.next())
                            var child = safeCallOneArg(val, 'get', 'm_128423_', k)
                            resObj[k] = nbtToPlainJs(child, d + 1)
                        }
                        return resObj
                    }
                } catch (eIter) { }
            }
            return resObj
        }

        // Real MC ListTag / Java List
        if (isRealListTagOrJavaList(val)) {
            var resArr = []
            try {
                var sz = Number(val.size())
                for (var li = 0; li < sz; li++) {
                    resArr.push(nbtToPlainJs(val.get(li), d + 1))
                }
            } catch (eList) { }
            return resArr
        }

        // Preserve FakeCompoundTag mocks in unit tests untouched
        try {
            if (typeof val.contains === 'function' || typeof val.getString === 'function') {
                return val
            }
        } catch (eFakeChk) { }

        // Boxed Java Boolean / String / Number / NumericTag / StringTag
        try {
            if (typeof val.booleanValue === 'function') return Boolean(val.booleanValue())
            if (typeof val.getAsNumber === 'function') return Number(val.getAsNumber())
            if (typeof val.m_8103_ === 'function') return Number(val.m_8103_())
            if (typeof val.doubleValue === 'function') return Number(val.doubleValue())
            if (typeof val.compareToIgnoreCase === 'function') return String(val)
        } catch (ePrim) { }

        try {
            var tagId = safeCallZeroArg(val, 'getId', 'm_7060_')
            if (tagId === 8 || tagId === 8.0) {
                var sVal = safeCallZeroArg(val, 'getAsString', 'm_7916_')
                if (sVal !== undefined) return String(sVal)
            } else if (tagId != null && tagId >= 1 && tagId <= 6) {
                var nVal = safeCallZeroArg(val, 'getAsDouble', 'm_7065_')
                if (nVal !== undefined && isFinite(Number(nVal))) return Number(nVal)
            }
        } catch (eTagId) { }

        if (Array.isArray(val)) {
            var dirtyArr = false
            var outArr = []
            for (var ai = 0; ai < val.length; ai++) {
                var convItem = nbtToPlainJs(val[ai], d + 1)
                if (convItem !== val[ai]) dirtyArr = true
                outArr.push(convItem)
            }
            return dirtyArr ? outArr : val
        }

        try {
            if (typeof val.entrySet === 'function') {
                var mapObj = {}
                var mIt = val.entrySet().iterator()
                while (mIt.hasNext()) {
                    var ent = mIt.next()
                    mapObj[String(ent.getKey())] = nbtToPlainJs(ent.getValue(), d + 1)
                }
                return mapObj
            }
        } catch (eMap) { }

        return val
    }

    function adaptV5ToV6Client(rawPkt) {
        if (rawPkt == null) return rawPkt
        var normalized = nbtToPlainJs(rawPkt, 0)
        if (SPEC && typeof SPEC.adaptV5ToV6 === 'function') {
            return SPEC.adaptV5ToV6(normalized)
        }
        if (!isPlainObjLike(normalized)) return normalized
        var out = {}
        for (var k in normalized) {
            if (Object.prototype.hasOwnProperty.call(normalized, k)) {
                out[k] = normalized[k]
            }
        }
        out.proto   = 6
        out.surface = out.surface ? String(out.surface) : 'screen'
        var act     = out.action ? String(out.action) : 'push'
        out.action  = act
        if (act === 'clear' || act === 'deactivate' || act === 'stop' || act === 'patch' || Array.isArray(out.items)) {
            if (out.slotId == null && out.id != null) out.slotId = String(out.id)
            if (out.slotId == null && out.slot != null) out.slotId = String(out.slot)
            return out
        }
        if (out.slotId == null) {
            out.slotId = out.id != null ? String(out.id) : (out.slot != null ? String(out.slot) : '')
        }
        if (!isPlainObjLike(out.vars)) out.vars = {}
        if (!isPlainObjLike(out.tracks)) out.tracks = {}
        if (!Array.isArray(out.nodes) || out.nodes.length === 0) {
            var tStr = readStr(out, 'title', readStr(out, 'text', ''))
            var sStr = readStr(out, 'sub', readStr(out, 'subtitle', ''))
            var synth = []
            if (tStr.length > 0 || sStr.length === 0) {
                synth.push({
                    id: 'title', type: 'text', x: 0, y: 0, anchor: 'center',
                    text: tStr, color: readNum(out, 'color', 0xFF5555), shadow: readBool(out, 'shadow', true)
                })
            }
            if (sStr.length > 0) {
                synth.push({
                    id: 'sub', type: 'text', x: 0, y: 12, anchor: 'center',
                    text: sStr, color: readNum(out, 'subColor', 0xFFCC44), shadow: readBool(out, 'shadow', true)
                })
            }
            out.nodes = synth
        }
        return out
    }

    function hasCustomDeclarativeNodes(rawOrig) {
        if (!isPlainObjLike(rawOrig)) return false
        if (rawOrig.surface === 'gui' || rawOrig.surface === 'slot') return true
        if (isPlainObjLike(rawOrig.clip)) return true
        if (Array.isArray(rawOrig.bgNodes) && rawOrig.bgNodes.length > 0) return true
        if (Array.isArray(rawOrig.fgNodes) && rawOrig.fgNodes.length > 0) return true
        if (isPlainObjLike(rawOrig.replaceTextures)) return true
        if (!Array.isArray(rawOrig.nodes) || rawOrig.nodes.length === 0) return false
        return true
    }

    function cloneSimpleMap(src) {
        var out = {}
        var plain = nbtToPlainJs(src, 0)
        if (isPlainObjLike(plain)) {
            for (var k in plain) {
                if (Object.prototype.hasOwnProperty.call(plain, k)) {
                    out[k] = plain[k]
                }
            }
        }
        return out
    }

    function initOverlayTrackState(vars, tracks, now) {
        var state = {}
        var disp  = cloneSimpleMap(vars)
        if (!isPlainObjLike(tracks)) {
            return { trackState: state, displayVars: disp }
        }
        for (var tk in tracks) {
            if (!Object.prototype.hasOwnProperty.call(tracks, tk)) continue
            var tr = tracks[tk]
            if (!isPlainObjLike(tr)) continue
            var mode = String(tr.mode || 'lerp').toLowerCase()
            if (mode === 'lerp') {
                var initVal = Number(vars[tk] != null ? vars[tk] : 0)
                if (!isFinite(initVal)) initVal = 0
                state[tk] = { mode: 'lerp', cur: initVal, target: initVal }
                disp[tk]  = initVal
            } else if (mode === 'trail') {
                var tRef = String(tr.target || ('$' + tk))
                var tKey = tRef.charAt(0) === '$' ? tRef.substring(1) : tRef
                var tInit = Number(vars[tKey] != null ? vars[tKey] : (vars[tk] != null ? vars[tk] : 0))
                if (!isFinite(tInit)) tInit = 0
                state[tk] = { mode: 'trail', cur: tInit, lastTarget: tInit, holdUntilMs: now }
                disp[tk]  = tInit
            } else if (mode === 'impulse') {
                var wRef = String(tr.onChange || ('$' + tk))
                var wKey = wRef.charAt(0) === '$' ? wRef.substring(1) : wRef
                var initImp = (tr.initPeak != null && isFinite(Number(tr.initPeak)) && Number(tr.initPeak) > 0)
                    ? Number(tr.initPeak)
                    : 0.0
                state[tk] = {
                    mode:           'impulse',
                    cur:            initImp,
                    lastWatchedVal: vars[wKey],
                    triggeredAtMs:  initImp > 0 ? now : 0,
                    initialized:    true
                }
                disp[tk] = initImp
            }
        }
        return { trackState: state, displayVars: disp }
    }

    function applyVarsPatchToOverlay(ov, incomingVars, now) {
        var plainVars = nbtToPlainJs(incomingVars, 0)
        if (ov == null || !isPlainObjLike(plainVars)) return
        if (ov.vars == null) ov.vars = {}
        if (ov.displayVars == null) ov.displayVars = {}
        if (ov.trackState == null) ov.trackState = {}
        var tracks = ov.tracks || {}

        for (var vk in plainVars) {
            if (!Object.prototype.hasOwnProperty.call(plainVars, vk)) continue
            var nextVal = plainVars[vk]
            var prevVal = ov.vars[vk]
            ov.vars[vk] = nextVal
            if (tracks[vk] == null) {
                ov.displayVars[vk] = nextVal
            } else if (tracks[vk].mode === 'lerp') {
                var numNext = Number(nextVal)
                if (isFinite(numNext)) {
                    if (ov.trackState[vk] == null) {
                        ov.trackState[vk] = { mode: 'lerp', cur: numNext, target: numNext }
                        ov.displayVars[vk] = numNext
                    } else {
                        ov.trackState[vk].target = numNext
                    }
                }
            }
            for (var tk in tracks) {
                if (!Object.prototype.hasOwnProperty.call(tracks, tk)) continue
                var tr = tracks[tk]
                if (tr == null) continue
                if (tr.mode === 'trail') {
                    var tRef = String(tr.target || ('$' + tk))
                    var tKey = tRef.charAt(0) === '$' ? tRef.substring(1) : tRef
                    if (tKey === vk) {
                        var tNext = Number(nextVal)
                        if (isFinite(tNext)) {
                            var tst = ov.trackState[tk]
                            if (tst == null) {
                                tst = { mode: 'trail', cur: tNext, lastTarget: tNext, holdUntilMs: now }
                                ov.trackState[tk] = tst
                            } else if (Math.abs(tNext - tst.lastTarget) > 1e-6) {
                                tst.lastTarget  = tNext
                                tst.holdUntilMs = now + max2(0, Number(tr.delayMs != null ? tr.delayMs : 220))
                            }
                        }
                    }
                } else if (tr.mode === 'impulse') {
                    var wRef = String(tr.onChange || ('$' + tk))
                    var wKey = wRef.charAt(0) === '$' ? wRef.substring(1) : wRef
                    if (wKey === vk && nextVal !== prevVal) {
                        var ist = ov.trackState[tk]
                        var peak = Number(tr.peak != null ? tr.peak : 1.0)
                        if (ist == null) {
                            ist = { mode: 'impulse', cur: peak, lastWatchedVal: nextVal, triggeredAtMs: now, initialized: true }
                            ov.trackState[tk] = ist
                        } else {
                            ist.cur            = peak
                            ist.lastWatchedVal = nextVal
                            ist.triggeredAtMs  = now
                        }
                        ov.displayVars[tk] = peak
                    }
                }
            }
        }
    }

    function stepOverlayTracks(ov, now) {
        if (ov == null) return
        if (ov.vars == null) ov.vars = {}
        if (ov.displayVars == null) ov.displayVars = cloneSimpleMap(ov.vars)
        var tracks = ov.tracks
        if (!isPlainObjLike(tracks)) {
            ov._lastTrackStepMs = now
            return
        }
        if (ov.trackState == null) {
            var initTr = initOverlayTrackState(ov.vars, tracks, now)
            ov.trackState  = initTr.trackState
            ov.displayVars = initTr.displayVars
        }
        var rawDtMs = (ov._lastTrackStepMs != null && isFinite(ov._lastTrackStepMs))
            ? (now - ov._lastTrackStepMs)
            : 16.0
        var dtMs  = clampNum(rawDtMs, 0.0, 100.0)
        var dtSec = dtMs / 1000.0
        ov._lastTrackStepMs = now

        for (var tk in tracks) {
            if (!Object.prototype.hasOwnProperty.call(tracks, tk)) continue
            var tr = tracks[tk]
            if (!isPlainObjLike(tr)) continue
            var st = ov.trackState[tk]
            var mode = String(tr.mode || 'lerp').toLowerCase()
            if (mode === 'lerp') {
                var target = Number(ov.vars[tk] != null ? ov.vars[tk] : 0)
                if (!isFinite(target)) target = 0
                if (st == null) {
                    st = { mode: 'lerp', cur: target, target: target }
                    ov.trackState[tk] = st
                }
                st.target = target
                var speed = max2(0.1, Number(tr.speed != null ? tr.speed : 10.0))
                var diff  = target - st.cur
                if (Math.abs(diff) <= 1e-4 || dtSec <= 0) {
                    if (Math.abs(diff) <= 1e-4) st.cur = target
                } else {
                    var kAlpha = 1.0 - Math.exp(-speed * dtSec)
                    if (tr.easing === 'out_quad') {
                        kAlpha = 1.0 - (1.0 - kAlpha) * (1.0 - kAlpha)
                    } else if (tr.easing === 'out_cubic') {
                        var invA = 1.0 - kAlpha
                        kAlpha = 1.0 - invA * invA * invA
                    }
                    st.cur = st.cur + diff * clampNum(kAlpha, 0.0, 1.0)
                }
                ov.displayVars[tk] = st.cur
            } else if (mode === 'trail') {
                var tRef = String(tr.target || ('$' + tk))
                var tKey = tRef.charAt(0) === '$' ? tRef.substring(1) : tRef
                var tTarget = Number(ov.vars[tKey] != null ? ov.vars[tKey] : 0)
                if (!isFinite(tTarget)) tTarget = 0
                if (st == null) {
                    st = { mode: 'trail', cur: tTarget, lastTarget: tTarget, holdUntilMs: now }
                    ov.trackState[tk] = st
                }
                if (Math.abs(tTarget - st.lastTarget) > 1e-6) {
                    st.lastTarget  = tTarget
                    st.holdUntilMs = now + max2(0, Number(tr.delayMs != null ? tr.delayMs : 220))
                }
                if (now >= st.holdUntilMs && dtSec > 0) {
                    var tSpeed = max2(0.1, Number(tr.speed != null ? tr.speed : 4.0))
                    var tDiff  = tTarget - st.cur
                    if (Math.abs(tDiff) <= 1e-4) {
                        st.cur = tTarget
                    } else {
                        var tAlpha = 1.0 - Math.exp(-tSpeed * dtSec)
                        st.cur = st.cur + tDiff * clampNum(tAlpha, 0.0, 1.0)
                    }
                }
                ov.displayVars[tk] = st.cur
            } else if (mode === 'impulse') {
                var wRef = String(tr.onChange || ('$' + tk))
                var wKey = wRef.charAt(0) === '$' ? wRef.substring(1) : wRef
                var curWatched = ov.vars[wKey]
                var peakVal = Number(tr.peak != null ? tr.peak : 1.0)
                if (st == null) {
                    st = { mode: 'impulse', cur: 0.0, lastWatchedVal: curWatched, triggeredAtMs: 0, initialized: true }
                    ov.trackState[tk] = st
                } else if (curWatched !== st.lastWatchedVal) {
                    st.lastWatchedVal = curWatched
                    st.cur            = peakVal
                    st.triggeredAtMs  = now
                }
                if (st.cur > 0 && st.triggeredAtMs > 0) {
                    var decMs = max2(16, Number(tr.decayMs != null ? tr.decayMs : 180))
                    var elMs  = max2(0, now - st.triggeredAtMs)
                    st.cur    = elMs >= decMs ? 0.0 : (peakVal * (1.0 - elMs / decMs))
                }
                ov.displayVars[tk] = st.cur
            }
        }
    }

    function resolveVarValue(valOrRef, varsMap, fallbackVal) {
        if (typeof valOrRef === 'string' && valOrRef.charAt(0) === '$') {
            var vKey = valOrRef.substring(1)
            if (varsMap != null && varsMap[vKey] !== undefined) {
                return varsMap[vKey]
            }
            return fallbackVal
        }
        return (valOrRef !== undefined && valOrRef !== null) ? valOrRef : fallbackVal
    }

    function resolveVarNum(valOrRef, varsMap, fallbackNum) {
        var v = resolveVarValue(valOrRef, varsMap, fallbackNum)
        var n = Number(v)
        return isFinite(n) ? n : fallbackNum
    }

    function interpolateVarString(rawStr, varsMap) {
        if (!rawStr) return ''
        var s = String(rawStr)
        if (s.indexOf('$') < 0) return s
        if (!isPlainObjLike(varsMap)) return s
        if (s.charAt(0) === '$' && varsMap[s.substring(1)] !== undefined) {
            return String(varsMap[s.substring(1)])
        }
        return s.replace(/\$\{([A-Za-z0-9_]+)\}|\$([A-Za-z0-9_]+)/g, function (full, k1, k2) {
            var k = k1 || k2
            return (varsMap[k] !== undefined && varsMap[k] !== null) ? String(varsMap[k]) : full
        })
    }

    function computeLocalClipRect(x, y, w, h, u, v, uw, vh, clipSpec, varsMap, outScratch) {
        var out = outScratch != null ? outScratch : { x: 0, y: 0, w: 0, h: 0, u: 0, v: 0, uw: 0, vh: 0, ratio: 1.0 }
        var bx  = Number(x) || 0
        var by  = Number(y) || 0
        var bw  = max2(0, Number(w) || 0)
        var bh  = max2(0, Number(h) || 0)
        var bu  = Number(u) || 0
        var bv  = Number(v) || 0
        var buw = Number(uw != null ? uw : bw) || 0
        var bvh = Number(vh != null ? vh : bh) || 0
        if (!isPlainObjLike(clipSpec)) {
            out.x = bx; out.y = by; out.w = bw; out.h = bh; out.u = bu; out.v = bv; out.uw = buw; out.vh = bvh; out.ratio = 1.0
            return out
        }
        var ratio = clampNum(resolveVarNum(clipSpec.ratio, varsMap, 1.0), 0.0, 1.0)
        var dir   = String(clipSpec.dir || 'left').toLowerCase()
        if (dir === 'right') {
            var invR = 1.0 - ratio
            out.x = bx + bw * invR; out.y = by; out.w = bw * ratio; out.h = bh
            out.u = bu + buw * invR; out.v = bv; out.uw = buw * ratio; out.vh = bvh; out.ratio = ratio
            return out
        }
        if (dir === 'down') {
            out.x = bx; out.y = by; out.w = bw; out.h = bh * ratio
            out.u = bu; out.v = bv; out.uw = buw; out.vh = bvh * ratio; out.ratio = ratio
            return out
        }
        if (dir === 'up') {
            var invU = 1.0 - ratio
            out.x = bx; out.y = by + bh * invU; out.w = bw; out.h = bh * ratio
            out.u = bu; out.v = bv + bvh * invU; out.uw = buw; out.vh = bvh * ratio; out.ratio = ratio
            return out
        }
        if (dir === 'center_x') {
            var halfInv = (1.0 - ratio) * 0.5
            out.x = bx + bw * halfInv; out.y = by; out.w = bw * ratio; out.h = bh
            out.u = bu + buw * halfInv; out.v = bv; out.uw = buw * ratio; out.vh = bvh; out.ratio = ratio
            return out
        }
        out.x = bx; out.y = by; out.w = bw * ratio; out.h = bh
        out.u = bu; out.v = bv; out.uw = buw * ratio; out.vh = bvh; out.ratio = ratio
        return out
    }

    function restoreAllReplacedTextures() {
        var keys = Object.keys(REPLACED_TEXTURE_REGISTRY)
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i]
            var entry = REPLACED_TEXTURE_REGISTRY[k]
            if (entry != null && entry.texManager != null && entry.resLoc != null && entry.originalTexObj != null) {
                try {
                    if (typeof entry.texManager.register === 'function') {
                        entry.texManager.register(entry.resLoc, entry.originalTexObj)
                    } else if (typeof entry.texManager.m_118495_ === 'function') {
                        entry.texManager.m_118495_(entry.resLoc, entry.originalTexObj)
                    }
                } catch (eRest) { }
            }
            delete REPLACED_TEXTURE_REGISTRY[k]
        }
    }

    // 实际应用一条弹幕指令（仅在主渲染线程中或无并发竞争时修改 activeOverlays）
    function applyDanmakuNow(rawOrig, now) {
        if (rawOrig == null) return
        var plainOrig = nbtToPlainJs(rawOrig, 0)
        if (plainOrig.items != null) {
            try {
                var preBatchLen = Number(plainOrig.items.length || 0)
                for (var pbIdx = 0; pbIdx < preBatchLen; pbIdx++) {
                    try {
                        applyDanmakuNow(plainOrig.items[pbIdx], now)
                    } catch (ePreBatchItem) {
                        logErrorThrottled('applyDanmaku batch item error', ePreBatchItem)
                    }
                }
            } catch (ePreBatch) {
                logErrorThrottled('applyDanmaku batch error', ePreBatch)
            }
            return
        }
        var hasCustomNodes = hasCustomDeclarativeNodes(plainOrig)
        var isCompoundTagLike = false
        try {
            isCompoundTagLike = !isPlainObjLike(plainOrig) ||
                ((typeof plainOrig.contains === 'function' || typeof plainOrig.getString === 'function') && !isRealCompoundTag(plainOrig))
        } catch (eTagChk) {
            isCompoundTagLike = true
        }
        var raw    = isCompoundTagLike ? plainOrig : adaptV5ToV6Client(plainOrig)
        var action = readStr(raw, 'action', 'push')

        // 1. 清空全部或指定分组
        if (action === 'clear') {
            var targetGroup = readStr(raw, 'group', '')
            var targetNs    = readStr(raw, 'namespace', readStr(raw, 'ns', ''))
            var clearTier   = readStr(raw, 'tier', '')
            var isPlayerClear = (clearTier === 'player' || targetNs.indexOf('u:') === 0)
            var clearMaxPri = readPriorityField(raw, 'maxPriority', 'priority', 10)
            if (isPlayerClear && clearMaxPri > 3) clearMaxPri = 3
            if ((!targetGroup || targetGroup === '*' || targetGroup === 'all') && !targetNs && !isPlayerClear && clearMaxPri >= 10) {
                activeOverlays.length = 0
                restoreAllReplacedTextures()
            } else {
                for (var i = activeOverlays.length - 1; i >= 0; i--) {
                    var cov    = activeOverlays[i]
                    if (isPlayerClear && cov.tier !== 'player') continue
                    var nsGrpKey = (targetNs && targetGroup && targetGroup.indexOf(targetNs + ':') !== 0)
                        ? (targetNs + ':' + targetGroup)
                        : targetGroup
                    var grpHit = (!targetGroup || targetGroup === '*' || targetGroup === 'all' || cov.group === targetGroup || (targetNs && cov.group === nsGrpKey))
                    var nsHit  = (!targetNs || cov.namespace === targetNs)
                    var covPri = cov.priority != null ? cov.priority : (cov.lifeMode === 'active' ? 5 : 2)
                    if (grpHit && nsHit && covPri <= clearMaxPri) {
                        activeOverlays.splice(i, 1)
                    }
                }
            }
            return
        }

        // 2. 停止持续激活弹幕
        if (action === 'deactivate' || action === 'stop') {
            var targetKey       = readStr(raw, 'key', readStr(raw, 'slotId', readStr(raw, 'slot', readStr(raw, 'id', ''))))
            var stopGroup       = readStr(raw, 'group', '')
            var stopNs          = readStr(raw, 'namespace', readStr(raw, 'ns', ''))
            var stopTier        = readStr(raw, 'tier', '')
            var isPlayerStop    = (stopTier === 'player' || stopNs.indexOf('u:') === 0)
            var customFadeTicks = readNum(raw, 'fadeOut', -1)
            var includeOnce     = readBool(raw, 'includeOnce', false)
            var maxStopPriority = readPriorityField(raw, 'maxPriority', 'priority', 10)
            if (isPlayerStop && maxStopPriority > 3) maxStopPriority = 3
            var isWildcard      = (targetKey === '*' || targetKey === 'all' || stopGroup === '*' || stopGroup === 'all')

            if (isWildcard) {
                for (var wIdx = activeOverlays.length - 1; wIdx >= 0; wIdx--) {
                    var wOv = activeOverlays[wIdx]
                    if (isPlayerStop && wOv.tier !== 'player') continue
                    if (!includeOnce && wOv.lifeMode !== 'active') continue
                    if (stopNs && wOv.namespace !== stopNs) continue
                    var wPri = wOv.priority != null ? wOv.priority : (wOv.lifeMode === 'active' ? 5 : 2)
                    if (wPri > maxStopPriority) continue
                    applyStopToOverlay(wOv, now, customFadeTicks)
                }
                return
            }

            var matchedByKey = false
            if (targetKey.length > 0) {
                for (var kStopIdx = activeOverlays.length - 1; kStopIdx >= 0; kStopIdx--) {
                    var kOv = activeOverlays[kStopIdx]
                    if (isPlayerStop && kOv.tier !== 'player') continue
                    if (stopNs && kOv.namespace !== stopNs) continue
                    var nsTargetKey = (kOv.namespace && targetKey.indexOf(kOv.namespace + ':') !== 0)
                        ? (kOv.namespace + ':' + targetKey)
                        : targetKey
                    if (kOv.key === targetKey || kOv.key === nsTargetKey || (kOv.slotId && kOv.slotId === targetKey)) {
                        matchedByKey = true
                        var kPri = kOv.priority != null ? kOv.priority : (kOv.lifeMode === 'active' ? 5 : 2)
                        if (kPri <= maxStopPriority) {
                            applyStopToOverlay(kOv, now, customFadeTicks)
                        }
                    }
                }
            }
            if (matchedByKey) return

            if (stopGroup.length > 0 || stopNs.length > 0) {
                for (var gStopIdx = activeOverlays.length - 1; gStopIdx >= 0; gStopIdx--) {
                    var gOv = activeOverlays[gStopIdx]
                    if (isPlayerStop && gOv.tier !== 'player') continue
                    var nsStopGrp = (stopNs && stopGroup && stopGroup.indexOf(stopNs + ':') !== 0)
                        ? (stopNs + ':' + stopGroup)
                        : stopGroup
                    var gMatch = (!stopGroup || gOv.group === stopGroup || (stopNs && gOv.group === nsStopGrp)) && (!stopNs || gOv.namespace === stopNs)
                    if (gMatch) {
                        if (!includeOnce && gOv.lifeMode !== 'active') continue
                        var gPri = gOv.priority != null ? gOv.priority : (gOv.lifeMode === 'active' ? 5 : 2)
                        if (gPri <= maxStopPriority) {
                            applyStopToOverlay(gOv, now, customFadeTicks)
                        }
                    }
                }
            }
            return
        }

        // 2b. 增量状态变量补丁 (action: 'patch')：仅更新已驻留实例的 vars 与 activeHold，孤儿包静默丢弃
        if (action === 'patch') {
            var patchKey = readStr(raw, 'key', readStr(raw, 'slotId', readStr(raw, 'slot', readStr(raw, 'id', ''))))
            if (!patchKey) return
            var patchNs   = readStr(raw, 'namespace', readStr(raw, 'ns', ''))
            var patchTier = readStr(raw, 'tier', '')
            var isPlayerPatch = (patchTier === 'player' || patchNs.indexOf('u:') === 0)
            for (var pIdx = 0; pIdx < activeOverlays.length; pIdx++) {
                var pOv = activeOverlays[pIdx]
                if (isPlayerPatch && pOv.tier !== 'player') continue
                if (patchNs && pOv.namespace && pOv.namespace !== patchNs) continue
                var nsPatchKey = (pOv.namespace && patchKey.indexOf(pOv.namespace + ':') !== 0)
                    ? (pOv.namespace + ':' + patchKey)
                    : patchKey
                if (pOv.key === patchKey || pOv.key === nsPatchKey || (pOv.slotId && pOv.slotId === patchKey)) {
                    if (isPlainObjLike(raw.vars)) {
                        applyVarsPatchToOverlay(pOv, raw.vars, now)
                    }
                    if (pOv.lifeMode === 'active') {
                        var patchHoldTicks = readNonNegNum(raw, 'activeHold', pOv.holdTicks || 28, 4)
                        pOv.holdTicks      = patchHoldTicks
                        var patchElapsed   = max2(0, now - pOv.born)
                        var patchSched     = computeOverlaySchedule(pOv.lifeMode, patchHoldTicks, pOv.fadeTicks || 10, pOv.typewriter, pOv.totalVis, pOv.charMs, now, patchElapsed)
                        pOv.holdDurationMs = patchSched.holdDurationMs
                        pOv.fadeMs         = patchSched.fadeMs
                        pOv.fadeStartAt    = patchSched.fadeStartAt
                        pOv.expire         = patchSched.expireAt
                        pOv.frozenVis      = null
                    }
                    break
                }
            }
            return
        }

        // 3. 批量数组推送（单条隔离报错，且无论是否为空/异常都不降格为单条渲染）
        if (raw.items != null) {
            try {
                var batchLen = Number(raw.items.length || 0)
                for (var bIdx = 0; bIdx < batchLen; bIdx++) {
                    try {
                        applyDanmakuNow(raw.items[bIdx], now)
                    } catch (eBatchItem) {
                        logErrorThrottled('applyDanmaku batch item error', eBatchItem)
                    }
                }
            } catch (eBatch) {
                logErrorThrottled('applyDanmaku batch error', eBatch)
            }
            return
        }

        var surface = readStr(raw, 'surface', 'screen').toLowerCase()
        var title   = truncateSafeText(readStr(raw, 'title', readStr(raw, 'text', '')), CONFIG.maxTitleChars)
        var sub     = truncateSafeText(readStr(raw, 'sub', readStr(raw, 'subtitle', '')), CONFIG.maxSubChars)
        if (title.length === 0 && sub.length === 0 && !hasCustomNodes) return

        var hasTags    = hasRichSpanTags(title) || hasRichSpanTags(sub)
        var hasSdfTags = hasTags ? (hasSdfSpanTags(title) || hasSdfSpanTags(sub)) : false
        var typewriter = readBool(raw, 'typewriter', false)
        var charMs     = Math.round(readNonNegNum(raw, 'charMs', 30, 8))
        var lifeMode   = readStr(raw, 'lifeMode', 'once')
        var defPri     = (lifeMode === 'active') ? 5 : 2
        var priority   = readPriorityField(raw, 'priority', 'importance', defPri)
        var stayTicks  = readNonNegNum(raw, 'stay', (lifeMode === 'active') ? 28 : 65, 4)
        var holdTicks  = (lifeMode === 'active')
            ? readNonNegNum(raw, 'activeHold', readNonNegNum(raw, 'holdTicks', stayTicks, 4), 4)
            : stayTicks
        var fadeTicks  = readNonNegNum(raw, 'fadeOut', 10, 1)

        var namespace    = readStr(raw, 'namespace', readStr(raw, 'ns', ''))
        var rawTier      = readStr(raw, 'tier', '')
        var tier         = (rawTier === 'player' || namespace.indexOf('u:') === 0) ? 'player' : 'system'
        var group        = readStr(raw, 'group', 'default')
        var slotId       = readStr(raw, 'slotId', readStr(raw, 'slot', readStr(raw, 'id', '')))
        var posTag       = readStr(raw, 'posTag', 'center')
        var normalizeKey = readBool(raw, 'normalizeKey', true)
        var key          = readStr(raw, 'key', '')
        if (!key && (lifeMode === 'active' || slotId.length > 0)) {
            key = deriveAutoActiveKey(namespace, group, slotId, posTag, title || slotId, sub, normalizeKey)
        } else if (key && namespace && key.indexOf(namespace + ':') !== 0) {
            key = namespace + ':' + key
        }

        var exist = null
        if (key.length > 0) {
            for (var kFindIdx = 0; kFindIdx < activeOverlays.length; kFindIdx++) {
                if (activeOverlays[kFindIdx].key === key) {
                    exist = activeOverlays[kFindIdx]
                    break
                }
            }
        }
        var sameTextAsExist = (exist != null && exist.title === title && exist.sub === sub)
        var titleVis = sameTextAsExist ? exist.titleVis : countVisibleChars(title)
        var subVis   = sameTextAsExist ? exist.subVis   : countVisibleChars(sub)
        var totalVis = titleVis + subVis

        var jitterBool   = readBool(raw, 'jitter', false)
        var perCharBool  = readBool(raw, 'perCharShake', false)
        var shakeInput   = readStr(raw, 'shakeMode', perCharBool ? 'per_char' : (jitterBool ? 'constant' : 'none')).toLowerCase()
        if (shakeInput === 'char' || shakeInput === 'perchar' || shakeInput === 'char_shake') {
            shakeInput = 'per_char'
        }
        var isRandShake  = readBool(raw, 'randomShake', shakeInput === 'random' || shakeInput === 'rand')
        var shakeMode    = (shakeInput === 'random' || shakeInput === 'rand')
            ? SHAKE_POOL[Math.floor(Math.random() * SHAKE_POOL.length)]
            : shakeInput
        var isPerChar    = (shakeMode === 'per_char' || perCharBool)
        var defShakeAmp  = isPerChar ? 0.65 : ((shakeMode !== 'none') ? 2.5 : 0.0)
        var shakeAmp     = readNonNegNum(raw, 'shakeAmp', defShakeAmp, 0.0)
        if (shakeMode === 'none' && !isPerChar && !hasTags) shakeAmp = 0.0
        var shakeFreqMin   = Math.round(readNonNegNum(raw, 'shakeFreqMin', CONFIG.charShakeDefaultMinMs, 60))
        var shakeFreqMax   = Math.round(readNonNegNum(raw, 'shakeFreqMax', max2(shakeFreqMin, CONFIG.charShakeDefaultMaxMs), shakeFreqMin))
        var charShakeStyle  = readStr(raw, 'charShakeStyle', 'omni').toLowerCase()
        var charShakeShift  = readNonNegNum(raw, 'charShakeShift', 0.32, 0.0)
        var charShakeShiftX = readNonNegNum(raw, 'charShakeShiftX', charShakeShift, 0.0)
        var charShakeShiftY = readNonNegNum(raw, 'charShakeShiftY', charShakeShift * 0.75, 0.0)
        var charShakeSwayX  = readNonNegNum(raw, 'charShakeSwayX', 0.88, 0.0)
        var charShakeSwayY  = readNonNegNum(raw, 'charShakeSwayY', 0.0, 0.0)
        var charShakeRotDeg     = clampNum(readNonNegNum(raw, 'charShakeRotDeg', 0.0, 0.0), 0.0, 45.0)
        var charShakeWin        = clampNum(readNonNegNum(raw, 'charShakeWin', 0.38, 0.05), 0.05, 1.0)
        var charShakeSnap       = readBool(raw, 'charShakeSnap', false)
        var charShakeTransition = readStr(raw, 'charShakeTransition', 'smooth').toLowerCase()

        var fadeStyleInput = readStr(raw, 'fadeStyle', 'shrink').toLowerCase()
        if (fadeStyleInput === '虚化' || fadeStyleInput === 'defocus') fadeStyleInput = 'blur'
        else if (fadeStyleInput === '裂解' || fadeStyleInput === 'clone') fadeStyleInput = 'split'
        var isRandomFade   = (fadeStyleInput === 'random' || fadeStyleInput === 'rand')
        var fadeStyle      = isRandomFade
            ? FADE_POOL[Math.floor(Math.random() * FADE_POOL.length)]
            : fadeStyleInput

        // 字间距与外圈（默认全部关闭：letterSpacing = 0, outlineMode = 'none'）
        var letterSpacing     = clampNum(readNum(raw, 'letterSpacing', readNum(raw, 'spacing', 0.0)), -2.0, 20.0)
        var letterSpacingMode = readStr(raw, 'letterSpacingMode', 'relative').toLowerCase() === 'fixed' ? 'fixed' : 'relative'
        var outlineMode   = readStr(raw, 'outlineMode', 'none').toLowerCase()
        if (outlineMode === 'sdf_stroke') outlineMode = 'mui_stroke'
        if (outlineMode !== 'stroke' && outlineMode !== 'glow' && outlineMode !== 'mui_stroke') outlineMode = 'none'
        var outlineColor  = Math.round(readNum(raw, 'outlineColor', -1))
        var outlineWidth  = clampNum(readNonNegNum(raw, 'outlineWidth', outlineMode === 'glow' ? 0.85 : 0.72, 0.2), 0.2, 2.5)

        var resetAnim    = readBool(raw, 'restart', readBool(raw, 'resetAnimation', false))
        var allowMove    = readBool(raw, 'movable', readBool(raw, 'move', readBool(raw, 'updatePos', false)))
        var isRandScale  = readBool(raw, 'randomScale', false)
        var isRandColor  = readBool(raw, 'randomColor', false)
        var maxWidth     = sanitizeMaxWidth(readNum(raw, 'maxWidth', 0))
        var wrapEnabled  = readBool(raw, 'wrap', true)
        var clampBounds  = readBool(raw, 'clamp', true)
        var showInGui    = readBool(raw, 'showInGui', surface === 'gui' || surface === 'slot')
        var defRenderPri = (surface === 'slot')
            ? Number(CONFIG.slotRenderPriority != null ? CONFIG.slotRenderPriority : 200)
            : ((surface === 'gui')
                ? Number(CONFIG.guiRenderPriority != null ? CONFIG.guiRenderPriority : 100)
                : Number(CONFIG.screenRenderPriority != null ? CONFIG.screenRenderPriority : 0))
        var renderPriority = readNum(raw, 'renderPriority', readNum(raw, 'zIndex', defRenderPri))
        var ox           = Math.round(readNum(raw, 'ox', 0))
        var oy           = Math.round(readNum(raw, 'oy', 0))
        var maxGroupSize = Math.round(readNonNegNum(raw, 'maxGroup', readNonNegNum(raw, 'maxGroupSize', 0, 0), 0))
        var debugEnabled = readBool(raw, 'debug', false)

        if (exist != null) {
                    exist.proto           = 6
                    exist.surface         = surface
                    exist.hasGraphicNodes = hasCustomNodes
                    exist.nodes           = Array.isArray(raw.nodes) ? raw.nodes : exist.nodes
                    exist.clip            = raw.clip !== undefined ? raw.clip : exist.clip
                    exist.targetGui       = raw.targetGui !== undefined ? raw.targetGui : exist.targetGui
                    exist.replaceTextures = raw.replaceTextures !== undefined ? raw.replaceTextures : exist.replaceTextures
                    exist.bgNodes         = raw.bgNodes !== undefined ? raw.bgNodes : exist.bgNodes
                    exist.fgNodes         = raw.fgNodes !== undefined ? raw.fgNodes : exist.fgNodes
                    exist.slotMatch       = raw.slotMatch !== undefined ? raw.slotMatch : exist.slotMatch
                    exist.renderPriority  = renderPriority
                    exist.ox              = ox
                    exist.oy              = oy
                    if (isPlainObjLike(raw.tracks)) {
                        if (exist.tracks == null) exist.tracks = {}
                        for (var trk in raw.tracks) {
                            if (Object.prototype.hasOwnProperty.call(raw.tracks, trk)) {
                                exist.tracks[trk] = raw.tracks[trk]
                            }
                        }
                    }
                    if (isPlainObjLike(raw.vars)) {
                        applyVarsPatchToOverlay(exist, raw.vars, now)
                    }
                    exist.tier         = tier
                    exist.maxGroupSize = maxGroupSize
                    exist.priority     = priority
                    exist.namespace    = namespace
                    exist.slotId       = slotId
                    exist.holdTicks    = holdTicks
                    exist.fadeTicks    = fadeTicks
                    if (exist.title !== title || exist.sub !== sub || exist.maxWidth !== maxWidth || exist.wrap !== wrapEnabled || exist.letterSpacing !== letterSpacing || exist.letterSpacingMode !== letterSpacingMode) {
                        exist.title             = title
                        exist.sub               = sub
                        exist.titleVis          = titleVis
                        exist.subVis            = subVis
                        exist.totalVis          = totalVis
                        exist.hasInlineTags     = hasTags
                        exist.hasSdfInlineTags  = hasSdfTags
                        exist.letterSpacing     = letterSpacing
                        exist.letterSpacingMode = letterSpacingMode
                        exist.wrapKey           = ''
                        exist.shatterCacheKey   = ''
                        exist.shatterFrags      = null
                        exist.charShakeCacheKey = ''
                        exist.charShakeFrags    = null
                        exist.charShakeUnits    = null
                    }
                    exist.group        = group
                    exist.lifeMode     = lifeMode
                    exist.outlineMode  = outlineMode
                    exist.outlineColor = outlineColor
                    exist.outlineWidth = outlineWidth
                    exist.debug        = debugEnabled
                    if (allowMove) {
                        exist.rx    = clampNum(readNum(raw, 'rx', exist.rx), 0.0, 1.0)
                        exist.ry    = clampNum(readNum(raw, 'ry', exist.ry), 0.0, 1.0)
                        exist.angle = readNum(raw, 'angle', exist.angle)
                    }
                    if (!isRandScale) {
                        var nextScale = clampNum(readNonNegNum(raw, 'scale', exist.scale, 0.2), 0.2, CONFIG.maxScale)
                        if (exist.scale !== nextScale) {
                            exist.scale             = nextScale
                            exist.wrapKey           = ''
                            exist.shatterCacheKey   = ''
                            exist.shatterFrags      = null
                            exist.charShakeCacheKey = ''
                            exist.charShakeFrags    = null
                            exist.charShakeUnits    = null
                        }
                    }
                    if (!isRandColor) {
                        var nextCol = readNum(raw, 'color', exist.color)
                        if (exist.color !== nextCol) {
                            exist.color             = nextCol
                            exist.shatterCacheKey   = ''
                            exist.charShakeCacheKey = ''
                        }
                    }
                    var nextSubCol = readNum(raw, 'subColor', exist.subColor)
                    if (exist.subColor !== nextSubCol) {
                        exist.subColor          = nextSubCol
                        exist.shatterCacheKey   = ''
                        exist.charShakeCacheKey = ''
                    }
                    exist.shadow       = readBool(raw, 'shadow', exist.shadow)
                    exist.typewriter   = typewriter
                    exist.charMs       = charMs
                    exist.cursor       = readStr(raw, 'cursor', exist.cursor)
                    if (!isRandShake) {
                        exist.shakeMode    = shakeMode
                        exist.perCharShake = isPerChar
                        exist.shakeAmp     = shakeAmp
                        exist.shakeFreqMin = shakeFreqMin
                        exist.shakeFreqMax = shakeFreqMax
                    }
                    exist.charShakeStyle      = charShakeStyle
                    exist.charShakeShift      = charShakeShift
                    exist.charShakeShiftX     = charShakeShiftX
                    exist.charShakeShiftY     = charShakeShiftY
                    exist.charShakeSwayX      = charShakeSwayX
                    exist.charShakeSwayY      = charShakeSwayY
                    exist.charShakeRotDeg     = charShakeRotDeg
                    exist.charShakeWin        = charShakeWin
                    exist.charShakeSnap       = charShakeSnap
                    exist.charShakeTransition = charShakeTransition
                    exist._charShakeCfg       = null
                    exist._sharedShakeTiming  = null
                    if (!isRandomFade) {
                        exist.fadeStyle = fadeStyle
                    }
                    exist.maxWidth  = maxWidth
                    exist.wrap      = wrapEnabled
                    exist.clamp     = clampBounds
                    exist.showInGui = showInGui
                    if (resetAnim) {
                        exist.born = now
                    }
                    var elapsed    = max2(0, now - exist.born)
                    var renewSched = computeOverlaySchedule(lifeMode, holdTicks, fadeTicks, typewriter, totalVis, charMs, now, elapsed)
                    if (resetAnim) {
                        exist.shakeDurationMs = renewSched.shakeDurationMs
                    }
                    exist.holdDurationMs = renewSched.holdDurationMs
                    exist.fadeMs         = renewSched.fadeMs
                    exist.fadeStartAt    = renewSched.fadeStartAt
                    exist.expire         = renewSched.expireAt
                    exist.frozenVis      = null
                    exist.drawErrors     = 0
                    enforceOverlayCaps(now, group, tier, namespace, maxGroupSize)
                    return
        }

        var initSched  = computeOverlaySchedule(lifeMode, holdTicks, fadeTicks, typewriter, totalVis, charMs, now, 0)
        var initVars   = cloneSimpleMap(raw.vars)
        var initTracks = cloneSimpleMap(raw.tracks)
        var trBundle   = initOverlayTrackState(initVars, initTracks, now)

        activeOverlays.push({
            proto:              6,
            surface:            surface,
            hasGraphicNodes:    hasCustomNodes,
            nodes:              Array.isArray(raw.nodes) ? raw.nodes : [],
            vars:               initVars,
            displayVars:        trBundle.displayVars,
            tracks:             initTracks,
            trackState:         trBundle.trackState,
            _lastTrackStepMs:   now,
            clip:               raw.clip || null,
            targetGui:          raw.targetGui || null,
            replaceTextures:    raw.replaceTextures || null,
            bgNodes:            Array.isArray(raw.bgNodes) ? raw.bgNodes : null,
            fgNodes:            Array.isArray(raw.fgNodes) ? raw.fgNodes : null,
            slotMatch:          raw.slotMatch || null,
            key:                key,
            slotId:             slotId,
            tier:               tier,
            namespace:          namespace,
            group:              group,
            lifeMode:           lifeMode,
            priority:           priority,
            renderPriority:     renderPriority,
            ox:                 ox,
            oy:                 oy,
            holdTicks:          holdTicks,
            fadeTicks:          fadeTicks,
            title:              title,
            sub:                sub,
            titleVis:           titleVis,
            subVis:             subVis,
            totalVis:           totalVis,
            hasInlineTags:      hasTags,
            hasSdfInlineTags:   hasSdfTags,
            letterSpacing:      letterSpacing,
            letterSpacingMode:  letterSpacingMode,
            outlineMode:        outlineMode,
            outlineColor:       outlineColor,
            outlineWidth:       outlineWidth,
            rx:                 clampNum(readNum(raw, 'rx', 0.5), 0.0, 1.0),
            ry:                 clampNum(readNum(raw, 'ry', 0.35), 0.0, 1.0),
            angle:              readNum(raw, 'angle', 0.0),
            scale:              clampNum(readNonNegNum(raw, 'scale', 1.0, 0.2), 0.2, CONFIG.maxScale),
            color:              readNum(raw, 'color', 0xFF5555),
            subColor:           readNum(raw, 'subColor', 0xFFCC44),
            shadow:             readBool(raw, 'shadow', true),
            shakeMode:          shakeMode,
            perCharShake:       isPerChar,
            charShakeStyle:     charShakeStyle,
            charShakeShift:     charShakeShift,
            charShakeShiftX:    charShakeShiftX,
            charShakeShiftY:    charShakeShiftY,
            charShakeSwayX:     charShakeSwayX,
            charShakeSwayY:     charShakeSwayY,
            charShakeRotDeg:     charShakeRotDeg,
            charShakeWin:        charShakeWin,
            charShakeSnap:       charShakeSnap,
            charShakeTransition: charShakeTransition,
            shakeAmp:           shakeAmp,
            shakeFreqMin:       shakeFreqMin,
            shakeFreqMax:       shakeFreqMax,
            shakeSeed:          Math.random() * 1000.0 + 1.0,
            fadeStyle:          fadeStyle,
            typewriter:         typewriter,
            charMs:             charMs,
            cursor:             truncateSafeText(readStr(raw, 'cursor', '▌'), CONFIG.maxCursorChars),
            debug:              debugEnabled,
            maxWidth:           maxWidth,
            wrap:               wrapEnabled,
            clamp:              clampBounds,
            showInGui:          showInGui,
            maxGroupSize:       maxGroupSize,
            wrapKey:            '',
            shatterCacheKey:    '',
            shatterFrags:       null,
            charShakeCacheKey:  '',
            charShakeFrags:     null,
            charShakeUnits:     null,
            _sharedShakeTiming: null,
            titleLines:         null,
            subLines:           null,
            blockW:             0,
            blockH:             0,
            holdDurationMs:     initSched.holdDurationMs,
            shakeDurationMs:    initSched.shakeDurationMs,
            fadeMs:             initSched.fadeMs,
            born:               now,
            fadeStartAt:        initSched.fadeStartAt,
            expire:             initSched.expireAt,
            drawErrors:         0
        })
        enforceOverlayCaps(now, group, tier, namespace, maxGroupSize)
    }

    function truncateSafeText(s, maxLen) {
        if (!s || s.length <= maxLen) return s
        var cut = s.substring(0, maxLen)
        if (cut.length > 0) {
            var lastCode = cut.charCodeAt(cut.length - 1)
            if ((lastCode >= 0xD800 && lastCode <= 0xDBFF) || lastCode === 167) {
                cut = cut.substring(0, cut.length - 1)
            }
        }
        return cut
    }

    function enforceOverlayCaps(now, group, tier, namespace, maxGroupSize) {
        // 若指定了同分组最大并发条数 maxGroupSize：
        //   优先将该分组内最早的非淡出弹幕平滑转入淡出 (applyStopToOverlay)，避免硬性直接消失跳过淡出动画；
        //   仅当含正在淡出的同组总条数超过 maxGroupSize + 1 时才移除最早的一条兜底。
        if (maxGroupSize > 0 && group && group.length > 0) {
            var activeGrpList = []
            var allGrpIndices = []
            for (var gCheckIdx = 0; gCheckIdx < activeOverlays.length; gCheckIdx++) {
                var gov = activeOverlays[gCheckIdx]
                if (gov.group !== group) continue
                if (tier === 'player') {
                    if (gov.tier !== 'player') continue
                    if (namespace && gov.namespace !== namespace) continue
                }
                allGrpIndices.push(gCheckIdx)
                if (now < gov.fadeStartAt) {
                    activeGrpList.push(gov)
                }
            }
            var activeExcess = activeGrpList.length - maxGroupSize
            for (var aeIdx = 0; aeIdx < activeExcess; aeIdx++) {
                applyStopToOverlay(activeGrpList[aeIdx], now, 12)
            }
            var hardExcess = allGrpIndices.length - (maxGroupSize + 1)
            for (var exIdx = 0; exIdx < hardExcess; exIdx++) {
                activeOverlays.splice(allGrpIndices[exIdx] - exIdx, 1)
            }
        }

        if (tier === 'player' && namespace && CONFIG.maxPlayerOverlaysPerNamespace > 0) {
            var nsCount = 0
            for (var nIdx = 0; nIdx < activeOverlays.length; nIdx++) {
                if (activeOverlays[nIdx].tier === 'player' && activeOverlays[nIdx].namespace === namespace) {
                    nsCount++
                }
            }
            while (nsCount > CONFIG.maxPlayerOverlaysPerNamespace) {
                var nsDropIdx = -1
                var nsMinScore = Infinity
                for (var nChk = 0; nChk < activeOverlays.length; nChk++) {
                    var nCand = activeOverlays[nChk]
                    if (nCand.tier === 'player' && nCand.namespace === namespace) {
                        var nPri = nCand.priority != null ? nCand.priority : (nCand.lifeMode === 'active' ? 5 : 2)
                        var nSc  = nPri * 10 + (nCand.lifeMode === 'active' ? 5 : 0)
                        if (nSc < nsMinScore) {
                            nsMinScore = nSc
                            nsDropIdx  = nChk
                        }
                    }
                }
                if (nsDropIdx < 0) break
                activeOverlays.splice(nsDropIdx, 1)
                nsCount--
            }
        }

        while (activeOverlays.length > CONFIG.maxOverlays) {
            var dropIdx  = 0
            var ov0      = activeOverlays[0]
            var tw0      = (ov0.tier === 'player') ? 0 : 100000
            var minScore = tw0 + (ov0.priority != null ? ov0.priority : (ov0.lifeMode === 'active' ? 5 : 2)) * 10 + (ov0.lifeMode === 'active' ? 5 : 0)
            for (var mIdx = 1; mIdx < activeOverlays.length; mIdx++) {
                var cand    = activeOverlays[mIdx]
                var candTw  = (cand.tier === 'player') ? 0 : 100000
                var candPri = cand.priority != null ? cand.priority : (cand.lifeMode === 'active' ? 5 : 2)
                var score   = candTw + candPri * 10 + (cand.lifeMode === 'active' ? 5 : 0)
                if (score < minScore) {
                    minScore = score
                    dropIdx  = mIdx
                }
            }
            activeOverlays.splice(dropIdx, 1)
        }
    }

    function isControlPacket(raw) {
        if (raw == null) return false
        var act = readStr(raw, 'action', '')
        return act === 'deactivate' || act === 'stop' || act === 'clear'
    }

    // 外部调用与网络包统一入队，由 paintScreen 帧首在渲染线程一次性出队消费，避免遍历 activeOverlays 期间发生并发/重入修改
    function enqueueDanmaku(rawInput) {
        if (rawInput == null) return
        var raw = nbtToPlainJs(rawInput, 0)
        var act = readStr(raw, 'action', 'push')
        if (act === 'patch') {
            var pKey = readStr(raw, 'key', readStr(raw, 'slotId', readStr(raw, 'slot', readStr(raw, 'id', ''))))
            var pNs  = readStr(raw, 'namespace', readStr(raw, 'ns', ''))
            if (pKey.length > 0) {
                for (var pi = 0; pi < pendingActions.length; pi++) {
                    var qPkt = pendingActions[pi]
                    if (qPkt == null || readStr(qPkt, 'action', '') !== 'patch') continue
                    var qKey = readStr(qPkt, 'key', readStr(qPkt, 'slotId', readStr(qPkt, 'slot', readStr(qPkt, 'id', ''))))
                    var qNs  = readStr(qPkt, 'namespace', readStr(qPkt, 'ns', ''))
                    if (qKey === pKey && qNs === pNs) {
                        if (isPlainObjLike(raw.vars)) {
                            if (!isPlainObjLike(qPkt.vars)) qPkt.vars = {}
                            for (var vk in raw.vars) {
                                if (Object.prototype.hasOwnProperty.call(raw.vars, vk)) {
                                    qPkt.vars[vk] = raw.vars[vk]
                                }
                            }
                        }
                        if (raw.activeHold != null) qPkt.activeHold = raw.activeHold
                        return
                    }
                }
            }
        }
        if (pendingActions.length >= CONFIG.maxPendingActions) {
            var incomingCtrl = isControlPacket(raw)
            var dropQIdx = 0
            if (incomingCtrl) {
                for (var qi = 0; qi < pendingActions.length; qi++) {
                    var qItem = pendingActions[qi]
                    if (qItem != null && !isControlPacket(qItem)) {
                        dropQIdx = qi
                        break
                    }
                }
            }
            pendingActions.splice(dropQIdx, 1)
            logErrorThrottled('pendingActions overflow', '待处理弹幕队列已达上限 (' + CONFIG.maxPendingActions + ')，已淘汰最早的低优先级消息。')
        }
        pendingActions.push(raw)
    }

    function flushPendingActions(now) {
        if (pendingActions.length === 0) return
        var budget = min2(pendingActions.length, CONFIG.maxPendingPerFrame)
        var batch  = pendingActions.splice(0, budget)
        for (var i = 0; i < batch.length; i++) {
            try {
                applyDanmakuNow(batch[i], now)
            } catch (e) {
                logErrorThrottled('applyDanmaku error', e)
            }
        }
    }

    var protoMismatchWarned = false

    NetworkEvents.dataReceived(CHANNEL, function (event) {
        try {
            var rawPkt = event.data
            var incomingProto = (rawPkt != null) ? readNum(rawPkt, 'proto', null) : null
            if (!checkProtoCompatible(PROTO_VERSION, incomingProto)) {
                if (!protoMismatchWarned) {
                    protoMismatchWarned = true
                    console.error('[ScreenDanmakuClient] 协议校验失败（已拒收报文）：服务端 proto=' + String(incomingProto) + '，客户端预期 proto=' + PROTO_VERSION + '，请同步双端脚本。')
                }
                return
            }
            enqueueDanmaku(rawPkt)
        } catch (e) {
            logErrorThrottled('dataReceived error', e)
        }
    })

    global.ScreenDanmakuClient = {
        VERSION:    '6.1.0',
        CONFIG:     CONFIG,
        setDebug:   function (enabled) { CONFIG.debug = Boolean(enabled); return CONFIG.debug },
        push:       enqueueDanmaku,
        patch:      function (slotIdOrOpts, maybeVars, maybeHoldTicks) {
            if (slotIdOrOpts != null && typeof slotIdOrOpts === 'object') {
                var copy = {}
                for (var k in slotIdOrOpts) copy[k] = slotIdOrOpts[k]
                copy.action = 'patch'
                enqueueDanmaku(copy)
                return
            }
            var payload = {
                action: 'patch',
                slotId: slotIdOrOpts != null ? String(slotIdOrOpts) : '',
                vars:   (maybeVars != null && typeof maybeVars === 'object') ? maybeVars : {}
            }
            if (maybeHoldTicks != null) payload.activeHold = maybeHoldTicks
            enqueueDanmaku(payload)
        },
        deactivate: function (keyOrGroup, fadeOutOrOpts) {
            if (keyOrGroup != null && typeof keyOrGroup === 'object') {
                var copy = {}
                for (var k in keyOrGroup) copy[k] = keyOrGroup[k]
                copy.action = 'deactivate'
                enqueueDanmaku(copy)
                return
            }
            var target = (keyOrGroup != null && String(keyOrGroup).trim() !== '') ? String(keyOrGroup) : '*'
            var payload = { action: 'deactivate', key: target, group: target }
            if (typeof fadeOutOrOpts === 'number' && !isNaN(fadeOutOrOpts)) {
                payload.fadeOut = fadeOutOrOpts
            } else if (fadeOutOrOpts != null && typeof fadeOutOrOpts === 'object') {
                if (fadeOutOrOpts.fadeOut != null) payload.fadeOut = fadeOutOrOpts.fadeOut
                if (fadeOutOrOpts.maxPriority != null) payload.maxPriority = fadeOutOrOpts.maxPriority
                if (fadeOutOrOpts.priority != null) payload.priority = fadeOutOrOpts.priority
                if (fadeOutOrOpts.includeOnce != null) payload.includeOnce = fadeOutOrOpts.includeOnce
            }
            enqueueDanmaku(payload)
        },
        clear:      function (groupOrOpts, maxPriority) {
            if (groupOrOpts != null && typeof groupOrOpts === 'object') {
                var copy = {}
                for (var k in groupOrOpts) copy[k] = groupOrOpts[k]
                copy.action = 'clear'
                if (copy.group == null || copy.group === '') copy.group = '*'
                if (maxPriority != null && copy.maxPriority == null) copy.maxPriority = maxPriority
                enqueueDanmaku(copy)
                return
            }
            var payload = { action: 'clear', group: groupOrOpts || '*' }
            if (maxPriority != null) payload.maxPriority = maxPriority
            enqueueDanmaku(payload)
        },
        count:      function () { return activeOverlays.length + pendingActions.length },
        list:       function () {
            var out = []
            for (var i = 0; i < activeOverlays.length; i++) {
                var ov = activeOverlays[i]
                if (ov == null) continue
                out.push({
                    proto:        ov.proto || 6,
                    surface:      ov.surface || 'screen',
                    key:          ov.key,
                    slotId:       ov.slotId,
                    tier:         ov.tier,
                    namespace:    ov.namespace,
                    group:        ov.group,
                    lifeMode:     ov.lifeMode,
                    priority:       ov.priority,
                    renderPriority: ov.renderPriority != null ? ov.renderPriority : 0,
                    maxGroupSize:   ov.maxGroupSize,
                    lineCacheKey: ov._lineRenderCache != null ? ov._lineRenderCache.key : null
                })
            }
            return out
        },
        renderGuiSurfacePass:    function (screenOrEvent, phase, guiCtx) {
            return renderGuiSurfacePass(screenOrEvent, phase, guiCtx)
        },
        restoreReplacedTextures: restoreAllReplacedTextures,
        registerShader:          registerCustomShader,
        _pure: {
            hashUnit:                     hashUnit,
            fastSinTurns:                 fastSinTurns,
            fastCosTurns:                 fastCosTurns,
            readGraphemeCluster:          readGraphemeCluster,
            prepareSharedCharShakeTiming: prepareSharedCharShakeTiming,
            sampleCharShakeOffset:        sampleCharShakeOffset,
            findVisibleUnitRange:         findVisibleUnitRange,
            isUnitOutOfViewport:          isUnitOutOfViewport,
            getOrBuildCharShakeCache:     getOrBuildCharShakeCache,
            isPotentialSpanTagHead:       isPotentialSpanTagHead,
            hasRichSpanTags:              hasRichSpanTags,
            ensureLineVisTable:           ensureLineVisTable,
            sliceVisibleChars:            sliceVisibleChars,
            dropFirstVisibleChars:        dropFirstVisibleChars,
            buildRenderedLines:           buildRenderedLines,
            adaptV5ToV6:                  adaptV5ToV6Client,
            nbtToPlainJs:                 nbtToPlainJs,
            computeLocalClipRect:         computeLocalClipRect,
            evaluateNodeBind:             evaluateNodeBind,
            compareOverlayDrawPriority:   compareOverlayDrawPriority,
            stepOverlayTracks:            stepOverlayTracks,
            applyVarsPatchToOverlay:      applyVarsPatchToOverlay,
            renderDeclarativeNodes:       function (event, item, nodes, varsMap, fadeAlpha, fontObj, itemBatchCtx, now) {
                return renderDeclarativeNodes(event, item, nodes, varsMap, fadeAlpha, fontObj, itemBatchCtx, now != null ? now : monotonicNowMs(), 0.0, 0)
            },
            checkTextureExists:           function (texPath) { return checkTextureExists(texPath) },
            getReplacedTextures:          function () { return REPLACED_TEXTURE_REGISTRY },
            getSeqCacheStats:             function () {
                return {
                    sharedCount:    SHARED_TEXT_SEQ_KEYS.length,
                    transientCount: TRANSIENT_TEXT_SEQ_KEYS.length,
                    hasShared:      function (k) { return Object.prototype.hasOwnProperty.call(SHARED_TEXT_SEQ_CACHE, k) },
                    hasTransient:   function (k) { return Object.prototype.hasOwnProperty.call(TRANSIENT_TEXT_SEQ_CACHE, k) }
                }
            },
            inspectOverlays:              function () { return activeOverlays }
        }
    }
    global.Epiphy2DRenderer = global.ScreenDanmakuClient

    ClientEvents.loggedOut(function () {
        activeOverlays.length = 0
        pendingActions.length = 0
        TRANSIENT_TEXT_SEQ_CACHE = {}
        TRANSIENT_TEXT_SEQ_KEYS.length = 0
        LAST_LEVEL_KEY = ''
        restoreAllReplacedTextures()
    })
    ClientEvents.loggedIn(function () {
        activeOverlays.length = 0
        pendingActions.length = 0
        TRANSIENT_TEXT_SEQ_CACHE = {}
        TRANSIENT_TEXT_SEQ_KEYS.length = 0
        LAST_LEVEL_KEY = ''
        restoreAllReplacedTextures()
    })

    // 判定当前是否打开了需要遮挡 HUD 弹幕的交互式 GUI：
    //   注意：HUD 的 PaintScreenEventJS 构造时不传入 Screen（event.screen 恒为 null），
    //   且 Minecraft 类因存在 setScreen(Screen) 而无 getScreen()，mc.screen 在 Rhino 中会被推导为只写 setter；
    //   必须通过 MinecraftClientKJS 注入的 getCurrentScreen() / currentScreen / Forge SRG f_91080_ 读取，且仅探测一次。
    var SCREEN_CAP_MAP = { obj: null, kind: 'none', name: null }
    var CLI_SCREEN_CAP = { obj: null, kind: 'none', name: null }

    function probeScreenGetter(mcObj, cap) {
        if (mcObj == null) return null
        if (cap.obj !== mcObj) {
            cap.obj  = mcObj
            cap.kind = 'none'
            cap.name = null
            try {
                if (typeof mcObj.getCurrentScreen === 'function') {
                    cap.kind = 'fn'
                    cap.name = 'getCurrentScreen'
                }
            } catch (eFn) { }
            if (cap.kind === 'none') {
                var props = ['currentScreen', 'f_91080_']
                for (var i = 0; i < props.length; i++) {
                    try {
                        if (mcObj[props[i]] !== undefined) {
                            cap.kind = 'prop'
                            cap.name = props[i]
                            break
                        }
                    } catch (eProp) { }
                }
            }
        }
        if (cap.kind === 'fn') return mcObj[cap.name]()
        if (cap.kind === 'prop') return mcObj[cap.name]
        return null
    }

    var MC_SCR_GET_FAILED = false

    function resolveCurrentScreen(event) {
        if (event != null) {
            if (event.screen != null) return event.screen
            var fromEventMc = probeScreenGetter(event.mc, SCREEN_CAP_MAP)
            if (fromEventMc != null) return fromEventMc
        }
        if (typeof Client !== 'undefined' && Client != null) {
            var fromClient = probeScreenGetter(Client, CLI_SCREEN_CAP)
            if (fromClient != null) return fromClient
        }
        if (MinecraftClass != null && !MC_SCR_GET_FAILED) {
            try {
                var fromStaticMc = probeScreenGetter(MinecraftClass.getInstance(), SCREEN_CAP_MAP)
                if (fromStaticMc != null) return fromStaticMc
            } catch (e3) {
                MC_SCR_GET_FAILED = true
                warnOnce('mcStaticScreen', 'Minecraft.getInstance() 读取屏幕状态失败: ' + e3)
            }
        }
        return null
    }

    function isBlockingGuiOpen(event) {
        var scr = resolveCurrentScreen(event)
        if (scr == null) return false
        var clsName = (typeof scr.getClass === 'function') ? String(scr.getClass().getName()) : ''
        // ChatScreen 打开时 chat box 与输入框占据屏幕，必须视为 GUI 遮挡界面触发防覆盖隐藏
        if (clsName.indexOf('ReceivingLevelScreen') >= 0 || clsName.indexOf('Overlay') >= 0) {
            return false
        }
        return true
    }

    // 从 Level 对象（ClientEventJS.getLevel()，实现 LevelKJS）提取维度 ResourceLocation 字符串：
    //   主路径直接调用 LevelKJS.getDimension() / lv.dimension；后备支持原版 Level.dimension().location()。
    function extractDimensionIdFromLevel(lv) {
        if (lv == null) return null
        if (typeof lv.getDimension === 'function') {
            var gd = lv.getDimension()
            if (gd != null) {
                var sGd = String(gd)
                if (sGd.length > 0) return sGd
            }
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

    function resolveCurrentLevelKey(event) {
        if (event == null) return null
        var lv = (typeof event.getLevel === 'function') ? event.getLevel() : event.level
        if (lv != null) {
            var lvDim = extractDimensionIdFromLevel(lv)
            if (lvDim) return lvDim
        }
        var p = (typeof event.getPlayer === 'function') ? event.getPlayer() : event.player
        if (p != null) {
            var pLv = (typeof p.getLevel === 'function') ? p.getLevel() : p.level
            if (pLv != null) {
                var pDim = extractDimensionIdFromLevel(pLv)
                if (pDim) return pDim
                return null
            }
        }
        if (lv == null) return ''
        return null
    }

    var HAS_GL_IS_ENABLED = (GL11 != null && typeof GL11.glIsEnabled === 'function')

    function queryGlBlendEnabled() {
        if (!HAS_GL_IS_ENABLED) return null
        try {
            return Boolean(GL11.glIsEnabled(GL11.GL_BLEND))
        } catch (e) {
            HAS_GL_IS_ENABLED = false
            warnOnce('glIsEnabled', 'GL11.glIsEnabled 探测失败，后续跳过混合态查询: ' + e)
            return null
        }
    }

    function drawTypewriterCursor(rCtx, item, blinkCursor, cursorX, cursorY, color) {
        if (rCtx == null || !blinkCursor || blinkCursor.length === 0) return
        if (item._cursorText !== blinkCursor || item._cursorOwner == null) {
            var curEntry = getCachedTextCompSeq(blinkCursor, false)
            item._cursorText  = blinkCursor
            item._cursorComp  = curEntry.comp
            item._cursorSeq   = curEntry.seq
            item._cursorOwner = {
                rawText:      curEntry.rawText,
                comp:         curEntry.comp,
                seq:          curEntry.seq,
                w:            6.0,
                color:        color,
                charScale:    1.0,
                outlineMode:  '',
                outlineColor: -1,
                _muiLayout:   curEntry._muiLayout,
                _muiEpoch:    curEntry._muiEpoch,
                _muiHasEmoji: curEntry._muiHasEmoji
            }
        }
        var curUnit = item._cursorOwner
        curUnit.color = color
        drawRichUnit(rCtx, curUnit, cursorX, cursorY, 0.0)
    }

    function pushPassUnitSlot(passCount, unit, floatX, floatY, unitRotDeg, rCtx) {
        var slot = PASS_UNIT_SCRATCH[passCount]
        if (slot == null) {
            slot = {}
            PASS_UNIT_SCRATCH[passCount] = slot
        }
        var sc = (unit.charScale != null && isFinite(unit.charScale) && unit.charScale > 0.2) ? unit.charScale : 1.0
        var hasSc  = (Math.abs(sc - 1.0) > 0.01)
        var hasRot = (unitRotDeg != null && isFinite(unitRotDeg) && Math.abs(unitRotDeg) > 0.15)
        slot.unit          = unit
        slot.floatX        = floatX
        slot.floatY        = floatY
        slot.unitRotDeg    = unitRotDeg || 0.0
        slot.halfW         = (unit.w != null) ? (unit.w * 0.5) : 0.0
        slot.rgbColor      = unit.color
        slot.outMode       = (unit.outlineMode && unit.outlineMode.length > 0) ? unit.outlineMode : rCtx.defOutMod
        slot.outColor      = (unit.outlineColor != null && unit.outlineColor >= 0) ? unit.outlineColor : rCtx.defOutCol
        slot.charScale     = sc
        slot.hasUnitScale  = hasSc
        slot.hasUnitRot    = hasRot
        slot.needTransform = (hasSc || hasRot)
        return passCount + 1
    }

    var DRAW_ORDER_SCRATCH = []
    function compareOverlayDrawPriority(a, b) {
        var rpa = (a && a.renderPriority != null) ? Number(a.renderPriority) : 0
        var rpb = (b && b.renderPriority != null) ? Number(b.renderPriority) : 0
        if (rpa !== rpb) return rpa - rpb
        var pa = (a && a.priority != null) ? Number(a.priority) : 0
        var pb = (b && b.priority != null) ? Number(b.priority) : 0
        if (pb !== pa) return pb - pa
        return (a ? (a.born || 0) : 0) - (b ? (b.born || 0) : 0)
    }

    var getActiveScreen = resolveCurrentScreen

    // ------------------------------------------------------------------------
    // v6 2D 声明式图元树渲染器 (rect / sprite / nine_slice / item / text / group)
    // 与 GUI / 槽位 / 贴图覆写 (surface: 'gui' | 'slot', replaceTextures)
    // ------------------------------------------------------------------------
    var ResourceLocationClass = null
    var RenderTypeClass       = null

    function getResourceLocation(pathStr) {
        if (!pathStr) return null
        if (ResourceLocationClass === null) {
            ResourceLocationClass = loadJavaClass('net.minecraft.resources.ResourceLocation', true) || false
        }
        if (!ResourceLocationClass) return pathStr
        try {
            return new ResourceLocationClass(String(pathStr))
        } catch (eRL) {
            return null
        }
    }

    function checkTextureExists(texPath) {
        if (!texPath) return false
        var key = String(texPath)
        var cachedTex = TEXTURE_EXIST_CACHE.get(key)
        if (cachedTex !== undefined) {
            return cachedTex
        }
        var mc = null
        if (MinecraftClass != null && !MC_INSTANCE_FAILED) {
            try { mc = MinecraftClass.getInstance() } catch (eMcT) { }
        }
        if (mc == null) {
            var fbOk = key.indexOf('missing') < 0 && key.indexOf('invalid') < 0
            TEXTURE_EXIST_CACHE.set(key, fbOk)
            return fbOk
        }
        try {
            var rm = typeof mc.getResourceManager === 'function' ? mc.getResourceManager() : (mc.resourceManager || mc.f_91098_)
            if (rm != null) {
                var rl = getResourceLocation(key)
                if (rl != null && typeof rm.getResource === 'function') {
                    var optRes = rm.getResource(rl)
                    var exists = optRes != null && (typeof optRes.isPresent === 'function' ? Boolean(optRes.isPresent()) : true)
                    TEXTURE_EXIST_CACHE.set(key, exists)
                    return exists
                }
            }
        } catch (eTex) { }
        var fallbackOk = key.indexOf('missing') < 0 && key.indexOf('invalid') < 0
        TEXTURE_EXIST_CACHE.set(key, fallbackOk)
        return fallbackOk
    }

    function toArgbWithAlpha(rawCol, alphaFactor) {
        var c = (rawCol != null && isFinite(Number(rawCol))) ? (Math.round(Number(rawCol)) >>> 0) : 0xFFFFFFFF
        var baseA = (c >>> 24) & 0xFF
        if (baseA === 0) baseA = 0xFF
        var a = clampNum(Math.round(baseA * clampNum(alphaFactor, 0.0, 1.0)), 0, 255)
        return ((a << 24) | (c & 0x00FFFFFF)) | 0
    }

    function lerpColorRgb(c1, c2, t) {
        var p = clampNum(t, 0.0, 1.0)
        var a1 = ((c1 >>> 24) & 0xFF) || 0xFF
        var r1 = (c1 >>> 16) & 0xFF
        var g1 = (c1 >>> 8) & 0xFF
        var b1 = c1 & 0xFF
        var a2 = ((c2 >>> 24) & 0xFF) || 0xFF
        var r2 = (c2 >>> 16) & 0xFF
        var g2 = (c2 >>> 8) & 0xFF
        var b2 = c2 & 0xFF
        var a = Math.round(a1 + (a2 - a1) * p)
        var r = Math.round(r1 + (r2 - r1) * p)
        var g = Math.round(g1 + (g2 - g1) * p)
        var b = Math.round(b1 + (b2 - b1) * p)
        return ((a << 24) | (r << 16) | (g << 8) | b) >>> 0
    }

    var ACTIVE_FRAME_BATCH_CTX = null
    var ACTIVE_FRAME_EVENT     = null
    var GRAPHICS_TEXT_DIRTY    = false

    function flushBatchedBeforeImmediate() {
        if (ACTIVE_FRAME_BATCH_CTX != null && ACTIVE_FRAME_BATCH_CTX.drawn > 0) {
            flushFrameBatchCtx(ACTIVE_FRAME_BATCH_CTX)
        }
        if (GRAPHICS_TEXT_DIRTY && ACTIVE_FRAME_EVENT != null && ACTIVE_FRAME_EVENT.graphics != null) {
            try {
                if (typeof ACTIVE_FRAME_EVENT.graphics.flush === 'function') {
                    ACTIVE_FRAME_EVENT.graphics.flush()
                } else if (typeof ACTIVE_FRAME_EVENT.graphics.m_280262_ === 'function') {
                    ACTIVE_FRAME_EVENT.graphics.m_280262_()
                }
            } catch (eGf) { }
            GRAPHICS_TEXT_DIRTY = false
        }
    }

    function hashStepSigned(stepTick, seed, salt) {
        var h = ((stepTick * 374761393) + (seed * 668265263) + (salt * 1442695041)) | 0
        h = ((h ^ (h >>> 13)) * 1274126177) | 0
        h = (h ^ (h >>> 16)) >>> 0
        return ((h & 0xFFFF) / 32767.5) - 1.0
    }

    function evalAffinePropBind(baseVal, bSpec, vMap) {
        if (!isPlainObjLike(bSpec) || !bSpec.var) return baseVal
        var vKey = String(bSpec.var).replace(/^\$/, '')
        var rawV = resolveVarNum('$' + vKey, vMap, 0.0)
        var minV = bSpec.min !== undefined ? Number(bSpec.min) : 0.0
        var maxV = bSpec.max !== undefined ? Number(bSpec.max) : 1.0
        var clamped = clampNum(rawV, isFinite(minV) ? minV : 0.0, isFinite(maxV) ? maxV : 1.0)
        var mult = Number(bSpec.mult !== undefined ? bSpec.mult : (bSpec.span !== undefined ? bSpec.span : 0.0)) || 0.0
        var off  = Number(bSpec.offset || 0.0) || 0.0
        return baseVal + off + clamped * mult
    }

    function evaluateNodeBind(node, baseX, baseY, baseW, baseH, baseAlpha, baseAngle, vMap, now, outScratch) {
        var out = outScratch != null ? outScratch : { x: 0, y: 0, w: 0, h: 0, alpha: 1.0, angle: 0.0 }
        var b = node != null ? node.bind : null
        if (!isPlainObjLike(b)) {
            out.x = baseX; out.y = baseY; out.w = baseW; out.h = baseH; out.alpha = baseAlpha; out.angle = baseAngle
            return out
        }
        var rx = evalAffinePropBind(baseX, b.x, vMap)
        var ry = evalAffinePropBind(baseY, b.y, vMap)
        var rw = max2(0, evalAffinePropBind(baseW, b.w, vMap))
        var rh = max2(0, evalAffinePropBind(baseH, b.h, vMap))
        var ra = clampNum(evalAffinePropBind(baseAlpha, b.alpha, vMap), 0.0, 1.0)
        var rAng = evalAffinePropBind(baseAngle, b.angle, vMap)

        var animSec = toAnimTimeSec(now)
        var stepHz  = Number(b.stepHz || 0)
        var seed    = (Number(b.seed || 0) | 0)
        if (stepHz > 0 && isFinite(stepHz)) {
            var stepTick = Math.floor(animSec * stepHz)
            if (b.jitterX) rx += Math.round(hashStepSigned(stepTick, seed, 11) * Number(b.jitterX))
            if (b.jitterY) ry += Math.round(hashStepSigned(stepTick, seed, 23) * Number(b.jitterY))
            if (b.jitterW) rw = max2(1, rw + Math.round(hashStepSigned(stepTick, seed, 37) * Number(b.jitterW)))
            if (b.jitterH) rh = max2(1, rh + Math.round(hashStepSigned(stepTick, seed, 53) * Number(b.jitterH)))
        }
        if (b.shakeX || b.shakeY) {
            var impKey = b.impulseVar ? String(b.impulseVar).replace(/^\$/, '') : 'impulse'
            var impVal = clampNum(resolveVarNum('$' + impKey, vMap, 0.0), 0.0, 2.0)
            if (impVal > 0.005) {
                if (b.shakeX) rx += Math.sin(animSec * 42.0 + seed) * impVal * Number(b.shakeX)
                if (b.shakeY) ry += Math.cos(animSec * 35.0 + seed) * impVal * Number(b.shakeY)
            }
        }
        if (b.vibX || b.vibY) {
            var vHz = (b.vibHz !== undefined && isFinite(Number(b.vibHz))) ? Number(b.vibHz) : 18.0
            if (vHz > 0) {
                var vPhase = animSec * vHz * 6.2831853 + seed * 1.37
                if (b.vibX) rx += Math.sin(vPhase) * Number(b.vibX)
                if (b.vibY) ry += Math.cos(vPhase * 0.87 + 0.9) * Number(b.vibY)
            }
        }
        if (b.rotSpeed) {
            var rotSpd = Number(b.rotSpeed)
            if (isFinite(rotSpd) && rotSpd !== 0) {
                var rotDelta = (animSec * rotSpd) % 360.0
                rAng = ((rAng + rotDelta) % 360.0 + 360.0) % 360.0
            }
        }
        out.x = rx; out.y = ry; out.w = rw; out.h = rh; out.alpha = ra; out.angle = rAng
        return out
    }

    function computeBoxAnchorOrigin(nx, ny, nw, nh, anchor, outScratch) {
        var out = outScratch != null ? outScratch : { x0: 0, y0: 0 }
        if (anchor === 'top_left') { out.x0 = nx; out.y0 = ny; return out }
        if (anchor === 'left') { out.x0 = nx; out.y0 = ny - nh * 0.5; return out }
        if (anchor === 'top_right') { out.x0 = nx - nw; out.y0 = ny; return out }
        if (anchor === 'right') { out.x0 = nx - nw; out.y0 = ny - nh * 0.5; return out }
        out.x0 = nx - nw * 0.5; out.y0 = ny - nh * 0.5
        return out
    }

    function computeNodesBounds(nodes, varsMap, out, depth, parentOffX, parentOffY) {
        if (!Array.isArray(nodes) || (depth || 0) > 4) return out
        var vMap = isPlainObjLike(varsMap) ? varsMap : {}
        var pOx = Number(parentOffX) || 0
        var pOy = Number(parentOffY) || 0
        for (var i = 0; i < nodes.length; i++) {
            var n = nodes[i]
            if (!isPlainObjLike(n)) continue
            var nType = String(n.type || n.kind || 'rect').toLowerCase()
            var baseNx = pOx + resolveVarNum(n.x, vMap, 0)
            var baseNy = pOy + resolveVarNum(n.y, vMap, 0)
            var nx = baseNx
            var ny = baseNy
            var minNx = baseNx, maxNx = baseNx
            var minNy = baseNy, maxNy = baseNy
            if (isPlainObjLike(n.bind)) {
                nx = evalAffinePropBind(baseNx, n.bind.x, vMap)
                ny = evalAffinePropBind(baseNy, n.bind.y, vMap)
                if (isPlainObjLike(n.bind.x)) {
                    var xOff = Number(n.bind.x.offset || 0) || 0
                    var xMult = Number(n.bind.x.mult !== undefined ? n.bind.x.mult : (n.bind.x.span || 0)) || 0
                    minNx = min2(baseNx + xOff, baseNx + xOff + xMult)
                    maxNx = max2(baseNx + xOff, baseNx + xOff + xMult)
                }
                if (isPlainObjLike(n.bind.y)) {
                    var yOff = Number(n.bind.y.offset || 0) || 0
                    var yMult = Number(n.bind.y.mult !== undefined ? n.bind.y.mult : (n.bind.y.span || 0)) || 0
                    minNy = min2(baseNy + yOff, baseNy + yOff + yMult)
                    maxNy = max2(baseNy + yOff, baseNy + yOff + yMult)
                }
            }
            if (nType === 'group') {
                var gKids = Array.isArray(n.children) ? n.children : n.items
                computeNodesBounds(gKids, vMap, out, (depth || 0) + 1, minNx, minNy)
                if (maxNx !== minNx || maxNy !== minNy) {
                    computeNodesBounds(gKids, vMap, out, (depth || 0) + 1, maxNx, maxNy)
                }
                continue
            }
            var nw = resolveVarNum(n.w, vMap, nType === 'text' ? 80 : 16)
            var nh = resolveVarNum(n.h, vMap, nType === 'text' ? 10 : 8)
            var anc = String(n.anchor || 'center').toLowerCase()
            var origMin = computeBoxAnchorOrigin(minNx, minNy, nw, nh, anc)
            var origMax = computeBoxAnchorOrigin(maxNx, maxNy, nw, nh, anc)
            var lx0 = min2(origMin.x0, origMax.x0)
            var ly0 = min2(origMin.y0, origMax.y0)
            var lx1 = max2(origMin.x0, origMax.x0) + nw
            var ly1 = max2(origMin.y0, origMax.y0) + nh
            if (lx0 < out.minX) out.minX = lx0
            if (ly0 < out.minY) out.minY = ly0
            if (lx1 > out.maxX) out.maxX = lx1
            if (ly1 > out.maxY) out.maxY = ly1
        }
        return out
    }

    function applyNodeLocalScale(event, sx, sy) {
        if (typeof event['scale(float,float)'] === 'function') {
            event['scale(float,float)'](sx, sy)
        } else if (typeof event['scale(float,float,float)'] === 'function') {
            event['scale(float,float,float)'](sx, sy, 1.0)
        } else {
            event.scale(sx, sy)
        }
    }

    function drawRectSolid(event, x, y, w, h, argbColor) {
        if (w <= 0 || h <= 0) return
        ensureItemPosePushed(event)
        flushBatchedBeforeImmediate()
        if (typeof event.beginQuads === 'function' && typeof event.rectangle === 'function' && typeof event.end === 'function') {
            var prevBlend = queryGlBlendEnabled()
            var changedBlend = false
            try {
                if (typeof event.setPositionColorShader === 'function') event.setPositionColorShader()
                if (typeof event.blend === 'function' && prevBlend !== true) {
                    event.blend(true)
                    changedBlend = true
                }
                event.beginQuads(false)
                event.rectangle(x, y, 0.0, w, h, argbColor)
                event.end()
            } finally {
                if (changedBlend && prevBlend === false && typeof event.blend === 'function') {
                    try { event.blend(false) } catch (eB) { }
                }
            }
            return
        }
        var rx0 = Math.round(x)
        var ry0 = Math.round(y)
        var rw = Math.max(1, Math.round(w))
        var rh = Math.max(1, Math.round(h))
        if (typeof event.fill === 'function') {
            event.fill(rx0, ry0, rx0 + rw, ry0 + rh, argbColor)
        } else if (event.graphics != null && typeof event.graphics.fill === 'function') {
            event.graphics.fill(rx0, ry0, rx0 + rw, ry0 + rh, argbColor)
        } else if (event.graphics != null && typeof event.graphics.m_280509_ === 'function') {
            event.graphics.m_280509_(rx0, ry0, rx0 + rw, ry0 + rh, argbColor)
        } else if (typeof event.rectangle === 'function') {
            event.rectangle(rx0, ry0, 0.0, rw, rh, argbColor)
        }
    }

    function drawRectOutline(event, x, y, w, h, thickness, argbColor) {
        if (w <= 0 || h <= 0) return
        var t = max2(1, Math.round(Number(thickness) || 1))
        ensureItemPosePushed(event)
        flushBatchedBeforeImmediate()
        if (typeof event.beginQuads === 'function' && typeof event.rectangle === 'function' && typeof event.end === 'function') {
            var prevBlend = queryGlBlendEnabled()
            var changedBlend = false
            try {
                if (typeof event.setPositionColorShader === 'function') event.setPositionColorShader()
                if (typeof event.blend === 'function' && prevBlend !== true) {
                    event.blend(true)
                    changedBlend = true
                }
                event.beginQuads(false)
                event.rectangle(x, y, 0.0, w, min2(t, h), argbColor)
                if (h > t) {
                    event.rectangle(x, y + h - t, 0.0, w, t, argbColor)
                }
                var innerH = h - t * 2
                if (innerH > 0) {
                    event.rectangle(x, y + t, 0.0, min2(t, w), innerH, argbColor)
                    if (w > t) {
                        event.rectangle(x + w - t, y + t, 0.0, t, innerH, argbColor)
                    }
                }
                event.end()
            } finally {
                if (changedBlend && prevBlend === false && typeof event.blend === 'function') {
                    try { event.blend(false) } catch (eBo) { }
                }
            }
            return
        }
        drawRectSolid(event, x, y, w, min2(t, h), argbColor)
        if (h > t) drawRectSolid(event, x, y + h - t, w, t, argbColor)
        var inH = h - t * 2
        if (inH > 0) {
            drawRectSolid(event, x, y + t, min2(t, w), inH, argbColor)
            if (w > t) drawRectSolid(event, x + w - t, y + t, t, inH, argbColor)
        }
    }

    function drawRectGradient(event, x, y, w, h, fromArgb, toArgb, dir, midArgb, midPos) {
        if (w <= 0 || h <= 0) return
        ensureItemPosePushed(event)
        flushBatchedBeforeImmediate()
        var hasMid = (midArgb !== undefined && midArgb !== null)
        var mp = hasMid ? clampNum(Number(midPos != null ? midPos : 0.62), 0.05, 0.95) : 0.5
        if (typeof event.beginQuads === 'function' && typeof event.vertex === 'function' && typeof event.getMatrix === 'function' && typeof event.end === 'function') {
            var mat = event.getMatrix()
            var prevBlend = queryGlBlendEnabled()
            var changedBlend = false
            try {
                if (typeof event.setPositionColorShader === 'function') event.setPositionColorShader()
                if (typeof event.blend === 'function' && prevBlend !== true) {
                    event.blend(true)
                    changedBlend = true
                }
                event.beginQuads(false)
                if (hasMid && dir !== 'v') {
                    var xm = x + w * mp
                    event.vertex(mat, xm,    y,     0.0, midArgb)
                    event.vertex(mat, x,     y,     0.0, fromArgb)
                    event.vertex(mat, x,     y + h, 0.0, fromArgb)
                    event.vertex(mat, xm,    y + h, 0.0, midArgb)

                    event.vertex(mat, x + w, y,     0.0, toArgb)
                    event.vertex(mat, xm,    y,     0.0, midArgb)
                    event.vertex(mat, xm,    y + h, 0.0, midArgb)
                    event.vertex(mat, x + w, y + h, 0.0, toArgb)
                } else if (hasMid && dir === 'v') {
                    var ym = y + h * mp
                    event.vertex(mat, x + w, y,     0.0, fromArgb)
                    event.vertex(mat, x,     y,     0.0, fromArgb)
                    event.vertex(mat, x,     ym,    0.0, midArgb)
                    event.vertex(mat, x + w, ym,    0.0, midArgb)

                    event.vertex(mat, x + w, ym,    0.0, midArgb)
                    event.vertex(mat, x,     ym,    0.0, midArgb)
                    event.vertex(mat, x,     y + h, 0.0, toArgb)
                    event.vertex(mat, x + w, y + h, 0.0, toArgb)
                } else {
                    var tl = fromArgb
                    var tr = (dir === 'v') ? fromArgb : toArgb
                    var bl = (dir === 'v') ? toArgb : fromArgb
                    var br = toArgb
                    event.vertex(mat, x + w, y,     0.0, tr)
                    event.vertex(mat, x,     y,     0.0, tl)
                    event.vertex(mat, x,     y + h, 0.0, bl)
                    event.vertex(mat, x + w, y + h, 0.0, br)
                }
                event.end()
            } finally {
                if (changedBlend && prevBlend === false && typeof event.blend === 'function') {
                    try { event.blend(false) } catch (eB) { }
                }
            }
            return
        }
        var rx0 = Math.round(x)
        var ry0 = Math.round(y)
        var rw  = Math.max(1, Math.round(w))
        var rh  = Math.max(1, Math.round(h))
        if (dir === 'v') {
            if (typeof event.vGradient === 'function') {
                event.vGradient(rx0, ry0, rw, rh, fromArgb, toArgb)
                return
            }
            if (event.graphics != null && typeof event.graphics.fillGradient === 'function') {
                event.graphics.fillGradient(rx0, ry0, rx0 + rw, ry0 + rh, fromArgb, toArgb)
                return
            }
            var vSteps = min2(8, max2(1, rh))
            for (var vi = 0; vi < vSteps; vi++) {
                var vy0 = ry0 + Math.floor((vi * rh) / vSteps)
                var vy1 = ry0 + Math.floor(((vi + 1) * rh) / vSteps)
                var vCol = toArgbWithAlpha(lerpColorRgb(fromArgb, toArgb, (vi + 0.5) / vSteps), 1.0)
                drawRectSolid(event, rx0, vy0, rw, max2(1, vy1 - vy0), vCol)
            }
            return
        }
        if (typeof event.hGradient === 'function') {
            event.hGradient(rx0, ry0, rw, rh, fromArgb, toArgb)
            return
        }
        var hSteps = min2(12, max2(1, Math.ceil(rw / 8)))
        for (var hi = 0; hi < hSteps; hi++) {
            var hx0 = rx0 + Math.floor((hi * rw) / hSteps)
            var hx1 = rx0 + Math.floor(((hi + 1) * rw) / hSteps)
            var hCol = toArgbWithAlpha(lerpColorRgb(fromArgb, toArgb, (hi + 0.5) / hSteps), 1.0)
            drawRectSolid(event, hx0, ry0, max2(1, hx1 - hx0), rh, hCol)
        }
    }

    function drawTextureRegion(event, texPath, x, y, w, h, u, v, uw, vh, tw, th, alphaFactor, tintArgb) {
        if (w <= 0 || h <= 0) return
        if (!checkTextureExists(texPath)) {
            warnOnce('missingTex:' + texPath, '贴图资源不存在，已静默跳过该图层: ' + texPath)
            return
        }
        ensureItemPosePushed(event)
        flushBatchedBeforeImmediate()
        var rl = getResourceLocation(texPath)
        var baseTintRgb = (tintArgb != null && isFinite(Number(tintArgb))) ? Number(tintArgb) : 0xFFFFFFFF
        var tintCol = toArgbWithAlpha(baseTintRgb, alphaFactor != null ? alphaFactor : 1.0)
        if (rl != null && typeof event.setPositionColorTextureShader === 'function' && typeof event.setShaderTexture === 'function' && typeof event.beginQuads === 'function' && typeof event.rectangle === 'function' && typeof event.end === 'function') {
            var twVal = max2(1, Number(tw || 256))
            var thVal = max2(1, Number(th || 256))
            var uPx = Number(u || 0)
            var vPx = Number(v || 0)
            var uSpan = (uw != null) ? Number(uw) : Number(w)
            var vSpan = (vh != null) ? Number(vh) : Number(h)
            var u0 = uPx / twVal
            var v0 = vPx / thVal
            var u1 = (uPx + uSpan) / twVal
            var v1 = (vPx + vSpan) / thVal
            var prevBlend = queryGlBlendEnabled()
            var changedBlend = false
            try {
                event.setPositionColorTextureShader()
                event.setShaderTexture(rl)
                if (typeof event.blend === 'function' && prevBlend !== true) {
                    event.blend(true)
                    changedBlend = true
                }
                event.beginQuads(true)
                event.rectangle(x, y, 0.0, w, h, tintCol, u0, v0, u1, v1)
                event.end()
            } finally {
                if (changedBlend && prevBlend === false && typeof event.blend === 'function') {
                    try { event.blend(false) } catch (eBt) { }
                }
            }
            return
        }
        var rx0 = Math.round(x)
        var ry0 = Math.round(y)
        var rw = Math.max(1, Math.round(w))
        var rh = Math.max(1, Math.round(h))
        var colorAdjusted = false
        try {
            if (((alphaFactor != null && alphaFactor < 0.999) || (baseTintRgb & 0xFFFFFF) !== 0xFFFFFF) && event.graphics != null && typeof event.graphics.setColor === 'function') {
                var tR = ((baseTintRgb >>> 16) & 0xFF) / 255.0
                var tG = ((baseTintRgb >>> 8) & 0xFF) / 255.0
                var tB = (baseTintRgb & 0xFF) / 255.0
                var tA = clampNum(alphaFactor != null ? alphaFactor : 1.0, 0.0, 1.0)
                event.graphics.setColor(tR, tG, tB, tA)
                colorAdjusted = true
            }
            if (typeof event.drawTexture === 'function') {
                event.drawTexture(texPath, rx0, ry0, rw, rh, u || 0, v || 0, uw != null ? uw : rw, vh != null ? vh : rh, tw || 256, th || 256)
            } else if (rl != null && event.graphics != null && typeof event.graphics.blit === 'function') {
                event.graphics.blit(rl, rx0, ry0, rw, rh, u || 0, v || 0, uw != null ? uw : rw, vh != null ? vh : rh, tw || 256, th || 256)
            } else if (rl != null && event.graphics != null && typeof event.graphics.m_280163_ === 'function') {
                event.graphics.m_280163_(rl, rx0, ry0, rw, rh, u || 0, v || 0, uw != null ? uw : rw, vh != null ? vh : rh, tw || 256, th || 256)
            }
        } finally {
            if (colorAdjusted && event.graphics != null && typeof event.graphics.setColor === 'function') {
                try { event.graphics.setColor(1.0, 1.0, 1.0, 1.0) } catch (eColRest) { }
            }
        }
    }

    function sampleThreeStopColor(cFrom, cMid, cTo, midPos, t, alphaFactor) {
        var tc = clampNum(t, 0.0, 1.0)
        if (cMid == null) {
            return toArgbWithAlpha(lerpColorRgb(cFrom, cTo, tc), alphaFactor)
        }
        var mp = clampNum(Number(midPos != null ? midPos : 0.62), 0.05, 0.95)
        if (tc <= mp) {
            return toArgbWithAlpha(lerpColorRgb(cFrom, cMid, tc / mp), alphaFactor)
        }
        return toArgbWithAlpha(lerpColorRgb(cMid, cTo, (tc - mp) / (1.0 - mp)), alphaFactor)
    }

    function drawRectParallax(event, x, y, w, h, fill, now, fadeAlpha, fullX, fullY, fullW, fullH, varsMap) {
        if (w <= 0.25 || h <= 0.25) return
        var vMap = isPlainObjLike(varsMap) ? varsMap : {}
        var fx = (fullX !== undefined && fullX !== null) ? Number(fullX) : x
        var fy = (fullY !== undefined && fullY !== null) ? Number(fullY) : y
        var fw = max2(1, (fullW !== undefined && fullW !== null) ? Number(fullW) : w)
        var fh = max2(1, (fullH !== undefined && fullH !== null) ? Number(fullH) : h)
        var layers = Array.isArray(fill.layers) ? fill.layers : []
        var bgAlpha = fill.bgAlpha !== undefined ? clampNum(Number(fill.bgAlpha), 0.0, 1.0) : 1.0
        var bgColRaw = resolveVarValue(fill.bgColor, vMap, 0xFF0A0412)
        var hasGradLayer = false
        for (var gi = 0; gi < layers.length; gi++) {
            if (isPlainObjLike(layers[gi]) && String(layers[gi].kind || '').toLowerCase() === 'gradient') {
                hasGradLayer = true
                break
            }
        }
        if (bgAlpha > 0.005 && !hasGradLayer) {
            drawRectSolid(event, x, y, w, h, toArgbWithAlpha(bgColRaw, fadeAlpha * bgAlpha))
        }

        var canHardwareBatch = (typeof event.beginQuads === 'function' && typeof event.rectangle === 'function' && typeof event.end === 'function')
        var hasVertexGrad = (canHardwareBatch && typeof event.vertex === 'function' && typeof event.getMatrix === 'function')

        // 1. 先按单批次合并绘制所有程序化几何视差图层 (gradient / stripes / ripples / particles / steps + bloom)
        var topFillTex = String(fill.texture || fill.tex || '')
        var hasProcLayers = (fill.bloomWidth > 0)
        for (var pi = 0; pi < layers.length; pi++) {
            var pLay = layers[pi]
            if (!isPlainObjLike(pLay)) continue
            var pTex = String(pLay.tex || pLay.texture || (String(pLay.kind || '').toLowerCase() === 'texture' ? topFillTex : '') || (!pLay.kind ? topFillTex : ''))
            if (!pTex || !checkTextureExists(pTex)) {
                hasProcLayers = true
                break
            }
        }

        if (hasProcLayers) {
            ensureItemPosePushed(event)
            flushBatchedBeforeImmediate()
            var prevBlend = canHardwareBatch ? queryGlBlendEnabled() : true
            var changedBlend = false
            var mat = hasVertexGrad ? event.getMatrix() : null
            try {
                if (canHardwareBatch) {
                    if (typeof event.setPositionColorShader === 'function') event.setPositionColorShader()
                    if (typeof event.blend === 'function' && prevBlend !== true) {
                        event.blend(true)
                        changedBlend = true
                    }
                    event.beginQuads(false)
                }

                var emitClippedRect = function (qx, qy, qw, qh, argb) {
                    var cx0 = max2(x, qx)
                    var cy0 = max2(y, qy)
                    var cx1 = min2(x + w, qx + qw)
                    var cy1 = min2(y + h, qy + qh)
                    var cw = cx1 - cx0
                    var ch = cy1 - cy0
                    if (cw <= 0.15 || ch <= 0.15) return
                    if (canHardwareBatch) {
                        event.rectangle(cx0, cy0, 0.0, cw, ch, argb)
                    } else {
                        drawRectSolid(event, cx0, cy0, cw, ch, argb)
                    }
                }

                var emitHGradSpan = function (gx0, gy0, gw, gh, colL, colR) {
                    if (gw <= 0.15 || gh <= 0.15) return
                    if (hasVertexGrad && mat != null) {
                        event.vertex(mat, gx0 + gw, gy0,      0.0, colR)
                        event.vertex(mat, gx0,      gy0,      0.0, colL)
                        event.vertex(mat, gx0,      gy0 + gh, 0.0, colL)
                        event.vertex(mat, gx0 + gw, gy0 + gh, 0.0, colR)
                    } else if (canHardwareBatch) {
                        event.rectangle(gx0, gy0, 0.0, gw, gh, colL)
                    } else {
                        drawRectGradient(event, gx0, gy0, gw, gh, colL, colR, 'h')
                    }
                }

                var tSec = toAnimTimeSec(now)
                for (var li = 0; li < layers.length; li++) {
                    var lay = layers[li]
                    if (!isPlainObjLike(lay)) continue
                    var tex = String(lay.tex || lay.texture || (String(lay.kind || '').toLowerCase() === 'texture' ? topFillTex : '') || (!lay.kind ? topFillTex : ''))
                    if (tex && checkTextureExists(tex)) continue
                    var lAlpha = clampNum(Number(lay.alpha != null ? lay.alpha : 1.0) * fadeAlpha, 0.0, 1.0)
                    if (lAlpha <= 0.005) continue
                    var kind = String(lay.kind || '').toLowerCase()
                    var layColRaw = resolveVarValue(lay.color, vMap, li % 2 === 0 ? 0x6644AAFF : 0x55CC66FF)
                    var layAltRaw = resolveVarValue(lay.altColor, vMap, layColRaw)

                    if (kind === 'gradient') {
                        var cFrom = resolveVarValue(lay.from, vMap, 0x174A5A)
                        var cMid  = lay.mid !== undefined ? resolveVarValue(lay.mid, vMap, 0x26A69A) : null
                        var cTo   = resolveVarValue(lay.to, vMap, 0x80DEEA)
                        var mPos  = clampNum(Number(lay.midPos != null ? lay.midPos : 0.62), 0.05, 0.95)
                        var t0    = clampNum((x - fx) / fw, 0.0, 1.0)
                        var t1    = clampNum((x + w - fx) / fw, 0.0, 1.0)
                        var col0  = sampleThreeStopColor(cFrom, cMid, cTo, mPos, t0, lAlpha)
                        var col1  = sampleThreeStopColor(cFrom, cMid, cTo, mPos, t1, lAlpha)
                        if (cMid != null && t0 < mPos && t1 > mPos) {
                            var xm = fx + fw * mPos
                            var colM = sampleThreeStopColor(cFrom, cMid, cTo, mPos, mPos, lAlpha)
                            emitHGradSpan(x, y, xm - x, h, col0, colM)
                            emitHGradSpan(xm, y, (x + w) - xm, h, colM, col1)
                        } else {
                            emitHGradSpan(x, y, w, h, col0, col1)
                        }
                    } else if (kind === 'stripes') {
                        var stepPx = max2(4, Number(lay.step || 18))
                        var sWidth = max2(1, Number(lay.width || 6))
                        var sSkew  = (lay.skew !== undefined && isFinite(Number(lay.skew))) ? Number(lay.skew) : Math.round(fh * 0.5)
                        var absSkew = Math.abs(sSkew)
                        var sShift = (((tSec * Number(lay.speedX || 20)) % stepPx) + stepPx) % stepPx
                        var sArgb  = toArgbWithAlpha(layColRaw, lAlpha)
                        var nSlices = max2(3, min2(8, Math.ceil(absSkew) + 1))
                        var sliceH  = fh / nSlices
                        var visX0   = x - sWidth - absSkew
                        var visX1   = x + w + absSkew
                        var baseOrigin = fx - stepPx - absSkew + sShift
                        var skipSteps = Math.max(0, Math.floor((visX0 - baseOrigin) / stepPx))
                        for (var sx = baseOrigin + skipSteps * stepPx; sx <= visX1; sx += stepPx) {
                            for (var sl = 0; sl < nSlices; sl++) {
                                var progY = (sl + 0.5) / nSlices
                                var slX   = sx + sSkew * (1.0 - progY)
                                if (slX + sWidth <= x || slX >= x + w) continue
                                emitClippedRect(slX, fy + sl * sliceH, sWidth, sliceH + 0.15, sArgb)
                            }
                        }
                    } else if (kind === 'ripples') {
                        var rRows = max2(1, min2(16, Math.round(Number(lay.rows || 4))))
                        var rGap  = max2(1, Number(lay.rowGap || 3.4))
                        var rOffY = Number(lay.offsetY != null ? lay.offsetY : 2.0)
                        var rSegs = max2(2, min2(20, Math.round(Number(lay.segments || 6))))
                        var rBase = max2(3, Number(lay.baseLen || 26))
                        var rAmp  = max2(0, Number(lay.ampLen != null ? lay.ampLen : 15))
                        var rSpd  = Number(lay.speedX != null ? lay.speedX : 30)
                        var rThk  = max2(0.4, Number(lay.thickness || 1.0))
                        var rSeed = (Number(lay.seed || 17) | 0)
                        var spanW = fw + 56
                        var stride = spanW / rSegs
                        var maxSegLen = rBase + rAmp
                        for (var rIdx = 0; rIdx < rRows; rIdx++) {
                            var ry = fy + rOffY + rIdx * rGap
                            if (ry + rThk <= y || ry >= y + h) continue
                            var rDir = (rIdx % 2 === 0) ? 1.0 : -1.0
                            var phase = tSec * (rSpd + rIdx * 11.0) * rDir + ((rIdx * 137 + rSeed * 53) % spanW)
                            var rAlphaMod = lAlpha * (0.68 + (rIdx % 3) * 0.16)
                            var rCol = toArgbWithAlpha((rIdx % 2 === 0 || lay.altColor === undefined) ? layColRaw : layAltRaw, rAlphaMod)
                            for (var sg = 0; sg < rSegs; sg++) {
                                var segJit = (hashStepSigned(sg + rIdx * 17, rSeed, 71) * 0.42) * stride
                                var rx = fx - 28 + (((sg * stride + segJit + phase) % spanW + spanW) % spanW)
                                if (rx >= x + w || rx + maxSegLen <= x) continue
                                var rw = max2(3, rBase + Math.sin(tSec * 2.5 + rIdx * 1.9 + sg * 2.3) * rAmp)
                                if (rx + rw <= x) continue
                                emitClippedRect(rx, ry, rw, rThk, rCol)
                            }
                        }
                    } else if (kind === 'particles') {
                        var pCount = max2(1, min2(64, Math.round(Number(lay.count || 20))))
                        var pSpdX  = Number(lay.speedX != null ? lay.speedX : 18)
                        var pSpdY  = Number(lay.speedY || 0)
                        var pMinW  = max2(1, Number(lay.minW || 1))
                        var pMaxW  = max2(pMinW, Number(lay.maxW || 4))
                        var pThk   = max2(1, Number(lay.thickness || 1.2))
                        var pSeed  = (Number(lay.seed || 0) | 0)
                        var effFh  = max2(1, fh - pThk)
                        for (var pIdx = 0; pIdx < pCount; pIdx++) {
                            var px0 = (pIdx * 43 + pSeed * 17) % fw
                            var py0 = (pIdx * 19 + pSeed * 11 + 3) % effFh
                            var px  = fx + (((px0 + tSec * pSpdX) % fw + fw) % fw)
                            var py  = fy + (((py0 + tSec * pSpdY) % effFh + effFh) % effFh)
                            var pw  = (pIdx % 3 === 0) ? pMaxW : pMinW
                            var pA  = lAlpha * (0.45 + (pIdx % 4) * 0.14)
                            var pCol = toArgbWithAlpha((pIdx % 2 === 0 || lay.altColor === undefined) ? layColRaw : layAltRaw, pA)
                            emitClippedRect(px, py, pw, pThk, pCol)
                        }
                    } else if (kind === 'steps') {
                        var stCount = max2(2, min2(32, Math.round(Number(lay.count || 13))))
                        var stHz    = max2(1, Number(lay.stepHz || 9))
                        var stTick  = Math.floor(tSec * stHz)
                        var stSeed  = (Number(lay.seed || 7) | 0)
                        var stThk   = max2(0.5, Number(lay.thickness || 1.0))
                        var stSpan  = fw / stCount
                        var stepRoom = max2(1.0, fh - stThk)
                        var tierMidY = fy + stepRoom * 0.5
                        var tierLowY = fy + stepRoom
                        var prevTier = 0
                        var prevStY  = tierMidY
                        for (var si = 0; si < stCount; si++) {
                            var stX = fx + Math.round(si * stSpan)
                            var stJit = ((stTick + si * 3 + stSeed) % 5) - 2
                            var stW = max2(3, Math.round(stSpan - 4 + stJit))
                            var tier = (si + ((si % 3 === 0) ? stTick : 0)) % 3
                            var stY = (tier === 0) ? tierMidY : ((tier === 1) ? tierLowY : fy)
                            var stColRaw = (tier === 0) ? layColRaw : ((tier === 1 && lay.altColor !== undefined) ? layAltRaw : 0x73FFFFFF)
                            var stArgb = toArgbWithAlpha(stColRaw, lAlpha)
                            emitClippedRect(stX, stY, stW, stThk, stArgb)
                            if (lay.risers !== false && si > 0 && tier !== prevTier) {
                                var rY0 = min2(prevStY, stY)
                                var rH  = max2(stThk, max2(prevStY, stY) + stThk - rY0)
                                emitClippedRect(stX, rY0, 1, rH, stArgb)
                            }
                            prevTier = tier
                            prevStY  = stY
                        }
                    } else {
                        var uOff = ((now * Number(lay.speedX || 0.0)) % 256 + 256) % 256
                        var vOff = ((now * Number(lay.speedY || 0.0)) % 256 + 256) % 256
                        var starCol = toArgbWithAlpha(layColRaw, lAlpha * 0.45)
                        var dotX = x + ((uOff + li * 37) % max2(1, w))
                        var dotY = y + ((vOff + li * 19) % max2(1, h))
                        emitClippedRect(dotX, dotY, min2(2, w), min2(2, h), starCol)
                    }
                }

                if (fill.bloomWidth > 0 && w > 1.0) {
                    var bw = min2(Number(fill.bloomWidth), w)
                    var bColRaw = resolveVarValue(fill.bloomColor, vMap, 0xD8FFFFFF)
                    var bColEnd = toArgbWithAlpha(bColRaw, fadeAlpha * 0.85)
                    var bColStart = toArgbWithAlpha(bColRaw, 0.0)
                    emitHGradSpan(x + w - bw, y, bw, h, bColStart, bColEnd)
                }

                if (canHardwareBatch) {
                    event.end()
                }
            } finally {
                if (changedBlend && prevBlend === false && typeof event.blend === 'function') {
                    try { event.blend(false) } catch (eBp) { }
                }
            }
        }

        // 2. 绘制具有真实外部贴图的视差层（支持顶层 fill.texture 与单层 u/v/uw/vh/scrollU/scrollV/pulseHz）
        var topTexW = max2(1, Number(fill.texW || fill.tw || 256))
        var topTexH = max2(1, Number(fill.texH || fill.th || 256))
        for (var ti = 0; ti < layers.length; ti++) {
            var tLay = layers[ti]
            if (!isPlainObjLike(tLay)) continue
            var tPath = String(tLay.tex || tLay.texture || (String(tLay.kind || '').toLowerCase() === 'texture' ? topFillTex : '') || (!tLay.kind ? topFillTex : ''))
            if (tPath && checkTextureExists(tPath)) {
                var sc = max2(0.1, Number(tLay.scale || 1.0))
                var ltw = max2(1, Number(tLay.texW || tLay.tw || topTexW))
                var lth = max2(1, Number(tLay.texH || tLay.th || topTexH))
                var baseU = Number(tLay.u || 0)
                var baseV = Number(tLay.v || 0)
                var spdX = Number(tLay.speedX !== undefined ? tLay.speedX : (tLay.scrollU || 0.0))
                var spdY = Number(tLay.speedY !== undefined ? tLay.speedY : (tLay.scrollV || 0.0))
                var tuOff = baseU + (((now * spdX) % ltw + ltw) % ltw)
                var tvOff = baseV + (((now * spdY) % lth + lth) % lth)
                var pulseHz = Number(tLay.pulseHz || 0.0)
                var pulseMod = (pulseHz > 0 && isFinite(pulseHz)) ? (0.65 + 0.35 * Math.sin(((Number(now) || 0) * 0.001) * pulseHz * 6.2831853)) : 1.0
                var tlAlpha = clampNum(Number(tLay.alpha != null ? tLay.alpha : 1.0) * fadeAlpha * pulseMod, 0.0, 1.0)
                var luw = tLay.uw != null ? min2(Number(tLay.uw), w / sc) : (w / sc)
                var lvh = tLay.vh != null ? min2(Number(tLay.vh), h / sc) : (h / sc)
                drawTextureRegion(event, tPath, x, y, w, h, tuOff, tvOff, luw, lvh, ltw, lth, tlAlpha)
            }
        }
    }

    var CUSTOM_SHADER_HANDLERS = {}

    function registerCustomShader(shaderId, handler) {
        if (!shaderId || typeof handler !== 'function') return
        CUSTOM_SHADER_HANDLERS[String(shaderId).toLowerCase()] = handler
    }

    function drawRectShader(event, x, y, w, h, fill, now, fadeAlpha) {
        var fbCol = toArgbWithAlpha(fill.fallbackColor != null ? fill.fallbackColor : 0xFF140524, fadeAlpha)
        if (RenderTypeClass === null) {
            RenderTypeClass = loadJavaClass('net.minecraft.client.renderer.RenderType', true) || false
        }
        var shaderId = String(fill.shader || fill.shaderId || 'end_portal').toLowerCase()
        var drewShader = false
        var customHandler = CUSTOM_SHADER_HANDLERS[shaderId]
        if (typeof customHandler === 'function') {
            try {
                drewShader = Boolean(customHandler(event, x, y, w, h, fill, now, fadeAlpha))
            } catch (eCustSh) {
                warnOnce('shaderCustomErr:' + shaderId, '自定义着色器 "' + shaderId + '" 执行失败，已自动降级: ' + eCustSh)
            }
        }
        if (!drewShader && RenderTypeClass && event.graphics != null && typeof event.graphics.fill === 'function') {
            try {
                var rt = null
                if (shaderId === 'end_portal' && typeof RenderTypeClass.endPortal === 'function') {
                    rt = RenderTypeClass.endPortal()
                } else if (shaderId === 'end_gateway' && typeof RenderTypeClass.endGateway === 'function') {
                    rt = RenderTypeClass.endGateway()
                } else if (shaderId === 'glint' && typeof RenderTypeClass.glint === 'function') {
                    rt = RenderTypeClass.glint()
                }
                if (rt != null) {
                    ensureItemPosePushed(event)
                    flushBatchedBeforeImmediate()
                    event.graphics.fill(rt, Math.round(x), Math.round(y), Math.round(x + w), Math.round(y + h), 0)
                    drewShader = true
                }
            } catch (eSh) {
                warnOnce('shaderFallback:' + shaderId, 'GUI 着色器通道不可用，已自动降级为视差/纯色填充: ' + eSh)
            }
        }
        if (!drewShader) {
            drawRectSolid(event, x, y, w, h, fbCol)
            drawRectParallax(event, x, y, w, h, {
                layers: [
                    { tex: 'minecraft:textures/environment/end_sky.png', speedX: 0.015, speedY: 0.008, scale: 1.0, alpha: 0.65 },
                    { tex: 'minecraft:textures/entity/end_portal.png', speedX: -0.022, speedY: 0.018, scale: 1.5, alpha: 0.50 }
                ]
            }, now, fadeAlpha, x, y, w, h, null)
        }
    }

    function drawNineSliceNode(event, node, x, y, w, h, fadeAlpha) {
        var tex = node.texture || node.tex || ''
        if (!tex || !checkTextureExists(tex)) {
            drawRectSolid(event, x, y, w, h, toArgbWithAlpha(0xB0101018, fadeAlpha))
            return
        }
        var rawSlice = node.slice
        var halfW = max2(1, Math.floor(w * 0.5))
        var halfH = max2(1, Math.floor(h * 0.5))
        var sL, sT, sR, sB
        if (Array.isArray(rawSlice) || (rawSlice != null && typeof rawSlice.length === 'number' && typeof rawSlice !== 'string')) {
            sL = clampNum(Math.round(Number(rawSlice[0] != null ? rawSlice[0] : 4)) || 4, 1, halfW)
            sT = clampNum(Math.round(Number(rawSlice[1] != null ? rawSlice[1] : sL)) || sL, 1, halfH)
            sR = clampNum(Math.round(Number(rawSlice[2] != null ? rawSlice[2] : sL)) || sL, 1, halfW)
            sB = clampNum(Math.round(Number(rawSlice[3] != null ? rawSlice[3] : sT)) || sT, 1, halfH)
        } else {
            var sUni = max2(1, min2(min2(halfW, halfH), Math.round(Number(rawSlice || 4)) || 4))
            sL = sUni; sT = sUni; sR = sUni; sB = sUni
        }
        var u0 = Number(node.u || 0)
        var v0 = Number(node.v || 0)
        var uw = Number(node.uw || 16)
        var vh = Number(node.vh || 16)
        var tw = Number(node.texW !== undefined ? node.texW : (node.tw || 256))
        var th = Number(node.texH !== undefined ? node.texH : (node.th || 256))
        var cw = max2(0, w - sL - sR)
        var ch = max2(0, h - sT - sB)
        var cuw = max2(1, uw - sL - sR)
        var cvh = max2(1, vh - sT - sB)
        // 4 角
        drawTextureRegion(event, tex, x, y, sL, sT, u0, v0, sL, sT, tw, th, fadeAlpha)
        drawTextureRegion(event, tex, x + w - sR, y, sR, sT, u0 + uw - sR, v0, sR, sT, tw, th, fadeAlpha)
        drawTextureRegion(event, tex, x, y + h - sB, sL, sB, u0, v0 + vh - sB, sL, sB, tw, th, fadeAlpha)
        drawTextureRegion(event, tex, x + w - sR, y + h - sB, sR, sB, u0 + uw - sR, v0 + vh - sB, sR, sB, tw, th, fadeAlpha)
        // 4 边与中心
        if (cw > 0) {
            drawTextureRegion(event, tex, x + sL, y, cw, sT, u0 + sL, v0, cuw, sT, tw, th, fadeAlpha)
            drawTextureRegion(event, tex, x + sL, y + h - sB, cw, sB, u0 + sL, v0 + vh - sB, cuw, sB, tw, th, fadeAlpha)
        }
        if (ch > 0) {
            drawTextureRegion(event, tex, x, y + sT, sL, ch, u0, v0 + sT, sL, cvh, tw, th, fadeAlpha)
            drawTextureRegion(event, tex, x + w - sR, y + sT, sR, ch, u0 + uw - sR, v0 + sT, sR, cvh, tw, th, fadeAlpha)
        }
        if (cw > 0 && ch > 0) {
            drawTextureRegion(event, tex, x + sL, y + sT, cw, ch, u0 + sL, v0 + sT, cuw, cvh, tw, th, fadeAlpha)
        }
    }

    function drawItemNode(event, node, x, y) {
        var itemId = String(node.item || '')
        if (!itemId || itemId === 'minecraft:air') return
        ensureItemPosePushed(event)
        flushBatchedBeforeImmediate()
        if (typeof event.renderItem === 'function') {
            event.renderItem(itemId, Math.round(x), Math.round(y))
            return
        }
        if (event.graphics != null && typeof Item !== 'undefined' && Item != null && typeof Item.of === 'function') {
            try {
                var stack = Item.of(itemId, max2(1, Number(node.count || 1)))
                if (stack != null) {
                    if (typeof event.graphics.renderFakeItem === 'function') {
                        event.graphics.renderFakeItem(stack, Math.round(x), Math.round(y))
                    } else if (typeof event.graphics.m_280036_ === 'function') {
                        event.graphics.m_280036_(stack, Math.round(x), Math.round(y))
                    }
                }
            } catch (eIt) {
                warnOnce('itemRender:' + itemId, '物品图标渲染失败，已跳过: ' + eIt)
            }
        }
    }

    function drawDeclarativeTextNode(event, item, node, rawText, varsMap, fadeAlpha, fontObj, itemBatchCtx, localX, localY) {
        var rawTemplate = rawText != null ? String(rawText) : ''
        var hasVarExpr = rawTemplate.indexOf('$') >= 0
        var resolved = interpolateVarString(rawTemplate, varsMap)
        if (!resolved) return
        var lines = resolved.split('\n')
        var rawCol = resolveVarValue(node.color, varsMap, item.color != null ? item.color : 0xFFFFFF)
        if (typeof rawCol === 'string' && SPEC) {
            if (typeof SPEC.parseArgbColor === 'function') {
                rawCol = SPEC.parseArgbColor(rawCol, 0xFFFFFF).color
            } else if (typeof SPEC.parseColor === 'function') {
                rawCol = SPEC.parseColor(rawCol, 0xFFFFFF).color
            }
        }
        var argb = toArgbWithAlpha(rawCol, fadeAlpha)
        var shadow = node.shadow !== undefined ? Boolean(node.shadow) : (item.shadow !== undefined ? Boolean(item.shadow) : true)
        var nx = (localX !== undefined && localX !== null) ? Number(localX) : resolveVarNum(node.x, varsMap, 0)
        var ny = (localY !== undefined && localY !== null) ? Number(localY) : resolveVarNum(node.y, varsMap, 0)
        var anchor = String(node.anchor || 'center').toLowerCase()
        var lineStep = CONFIG.lineStepPx
        var isTopAnchor = (anchor === 'top_left' || anchor === 'top_right')
        var startY = isTopAnchor ? ny : (ny - Math.floor((lines.length * lineStep) * 0.5) + 1)

        var needWidthMeasure = !(anchor === 'top_left' || anchor === 'left')
        var curFontEpoch = needWidthMeasure ? (FONT_SIGNATURE + '|' + MUI_EPOCH) : ''
        for (var li = 0; li < lines.length; li++) {
            var lnStr = lines[li]
            if (!lnStr) continue
            var isTrans = (hasVarExpr || item.lifeMode === 'active' || lnStr.length <= 24)
            var entry = getCachedTextCompSeq(lnStr, false, isTrans)
            var lx = nx
            if (needWidthMeasure) {
                var lw
                if (lines.length === 1 && node._txtCacheKey === lnStr && node._txtCacheEpoch === curFontEpoch && node._txtCacheW !== undefined) {
                    lw = node._txtCacheW
                } else {
                    var measuredW = invokeFontWidth(fontObj, lnStr)
                    lw = (isFinite(measuredW) && measuredW >= 0) ? measuredW : (lnStr.replace(/§[0-9a-fk-or]/gi, '').length * 6)
                    if (lines.length === 1) {
                        node._txtCacheKey   = lnStr
                        node._txtCacheEpoch = curFontEpoch
                        node._txtCacheW     = lw
                    }
                }
                lx = (anchor === 'top_right' || anchor === 'right') ? (nx - lw) : (nx - Math.floor(lw * 0.5))
            }
            var ly    = startY + li * lineStep
            var lay   = (itemBatchCtx != null) ? resolveUnitMuiLayout(itemBatchCtx, entry.seq, entry) : null
            var useMui = (lay != null && itemBatchCtx != null && itemBatchCtx.muiActive)
            var mode  = (useMui && itemBatchCtx.muiAllowSdf) ? 1 : 0
            var seqToDraw = useMui ? entry.seq : ensureUnitCompSeq(entry).seq
            if (!(itemBatchCtx != null && drawBatchedGlyph(itemBatchCtx, seqToDraw, lx, ly, argb, shadow, itemBatchCtx.itemMat, lay, mode))) {
                ensureUnitCompSeq(entry)
                if (entry.comp != null) {
                    ensureFallbackBlend(event, itemBatchCtx)
                    ensureItemPosePushed(event)
                    event.text(entry.comp, Math.round(lx) || 0, Math.round(ly) || 0, argb, shadow)
                    GRAPHICS_TEXT_DIRTY = true
                }
            }
        }
    }

    function enableEventScissor(event, x0, y0, x1, y1) {
        var sx0 = Math.round(min2(x0, x1))
        var sy0 = Math.round(min2(y0, y1))
        var sx1 = Math.round(max2(x0, x1))
        var sy1 = Math.round(max2(y0, y1))
        if (typeof event.enableScissor === 'function') {
            event.enableScissor(sx0, sy0, sx1, sy1)
            return true
        }
        var scX = ITEM_POSE_SCRATCH.needed ? (ITEM_POSE_SCRATCH.px || 0) : 0
        var scY = ITEM_POSE_SCRATCH.needed ? (ITEM_POSE_SCRATCH.py || 0) : 0
        var scSx = ITEM_POSE_SCRATCH.needed ? (ITEM_POSE_SCRATCH.scaleX || 1.0) : 1.0
        var scSy = ITEM_POSE_SCRATCH.needed ? (ITEM_POSE_SCRATCH.scaleY || 1.0) : 1.0
        var gx0 = Math.round(scX + sx0 * scSx)
        var gy0 = Math.round(scY + sy0 * scSy)
        var gx1 = Math.round(scX + sx1 * scSx)
        var gy1 = Math.round(scY + sy1 * scSy)
        if (event.graphics != null && typeof event.graphics.enableScissor === 'function') {
            event.graphics.enableScissor(gx0, gy0, gx1, gy1)
            return true
        }
        if (event.graphics != null && typeof event.graphics.m_280588_ === 'function') {
            event.graphics.m_280588_(gx0, gy0, gx1, gy1)
            return true
        }
        return false
    }

    function disableEventScissor(event) {
        if (typeof event.disableScissor === 'function') {
            event.disableScissor()
        } else if (event.graphics != null && typeof event.graphics.disableScissor === 'function') {
            event.graphics.disableScissor()
        } else if (event.graphics != null && typeof event.graphics.m_280618_ === 'function') {
            event.graphics.m_280618_()
        }
    }

    function renderDeclarativeNodes(event, item, nodes, varsMap, fadeAlpha, fontObj, itemBatchCtx, now, parentAngleDeg, depth) {
        if (!Array.isArray(nodes) || nodes.length === 0 || (depth || 0) > 4) return
        var vMap = isPlainObjLike(varsMap) ? varsMap : {}
        var canRectBatch = (typeof event.beginQuads === 'function' && typeof event.rectangle === 'function' && typeof event.end === 'function')
        var rectBatchOpen = false
        var rectBatchPrevBlend = null
        var rectBatchChangedBlend = false

        var openRectBatch = function () {
            if (rectBatchOpen) return
            ensureItemPosePushed(event)
            flushBatchedBeforeImmediate()
            rectBatchPrevBlend = queryGlBlendEnabled()
            rectBatchChangedBlend = false
            if (typeof event.setPositionColorShader === 'function') event.setPositionColorShader()
            if (typeof event.blend === 'function' && rectBatchPrevBlend !== true) {
                event.blend(true)
                rectBatchChangedBlend = true
            }
            event.beginQuads(false)
            rectBatchOpen = true
        }

        var closeRectBatch = function () {
            if (!rectBatchOpen) return
            rectBatchOpen = false
            try {
                event.end()
            } finally {
                if (rectBatchChangedBlend && rectBatchPrevBlend === false && typeof event.blend === 'function') {
                    try { event.blend(false) } catch (eBEnd) { }
                }
                rectBatchChangedBlend = false
            }
        }

        var emitOutlineIntoOpenBatch = function (ox, oy, ow, oh, thickness, argbColor) {
            if (ow <= 0 || oh <= 0) return
            var t = max2(1, Math.round(Number(thickness) || 1))
            event.rectangle(ox, oy, 0.0, ow, min2(t, oh), argbColor)
            if (oh > t) {
                event.rectangle(ox, oy + oh - t, 0.0, ow, t, argbColor)
            }
            var innerH = oh - t * 2
            if (innerH > 0) {
                event.rectangle(ox, oy + t, 0.0, min2(t, ow), innerH, argbColor)
                if (ow > t) {
                    event.rectangle(ox + ow - t, oy + t, 0.0, t, innerH, argbColor)
                }
            }
        }

        try {
            for (var ni = 0; ni < nodes.length; ni++) {
                var node = nodes[ni]
                if (!isPlainObjLike(node)) continue
                var nType      = String(node.type || node.kind || 'rect').toLowerCase()
                var baseAlpha  = resolveVarNum(node.alpha, vMap, 1.0)
                var baseX      = resolveVarNum(node.x, vMap, 0)
                var baseY      = resolveVarNum(node.y, vMap, 0)
                var baseW      = max2(0, resolveVarNum(node.w, vMap, nType === 'sprite' || nType === 'item' ? 16 : 64))
                var baseH      = max2(0, resolveVarNum(node.h, vMap, nType === 'sprite' || nType === 'item' ? 16 : 8))
                var nScale     = resolveVarNum(node.scale != null ? node.scale : node.size, vMap, 1.0)
                var baseAngle  = resolveVarNum(node.angle != null ? node.angle : node.tilt, vMap, 0.0)
                var boundProps = evaluateNodeBind(node, baseX, baseY, baseW, baseH, baseAlpha, baseAngle, vMap, now, NODE_BIND_SCRATCH)
                var nAlpha     = clampNum(boundProps.alpha * fadeAlpha, 0.0, 1.0)
                if (nAlpha <= 0.005) continue

                var nx     = boundProps.x
                var ny     = boundProps.y
                var nw     = boundProps.w
                var nh     = boundProps.h
                var nAngle = boundProps.angle
                var anchor = String(node.anchor || 'center').toLowerCase()
                var boxOrig = computeBoxAnchorOrigin(nx, ny, nw, nh, anchor, BOX_ORIG_SCRATCH)
                var x0     = boxOrig.x0
                var y0     = boxOrig.y0
                var nodeRawColor = (node.color !== undefined) ? node.color : node.tint

                var clipSpec = isPlainObjLike(node.clip) ? node.clip : null
                var effAngle = (Number(parentAngleDeg) || 0) + nAngle
                var useScissor = (clipSpec != null && clipSpec.mode === 'scissor' && Math.abs(effAngle) < 0.01)
                var needsPush  = (nType === 'group' || nAngle !== 0 || Math.abs(nScale - 1.0) > 0.001)

                // 快速连续合批轨：相邻无局部变换/无 Scissor 的 solid/outline rect 共用单次 beginQuads 批次与单次 GL_BLEND 检查
                if (canRectBatch && !needsPush && !useScissor && nType === 'rect') {
                    var fastFill = isPlainObjLike(node.fill) ? node.fill : null
                    var fastMode = fastFill != null ? String(fastFill.mode || 'solid').toLowerCase() : 'solid'
                    if (fastMode === 'solid' || fastMode === 'outline') {
                        var fastClip = computeLocalClipRect(x0, y0, nw, nh, 0, 0, nw, nh, clipSpec, vMap, LOCAL_CLIP_SCRATCH)
                        var hasBorder = (node.borderWidth != null && Number(node.borderWidth) > 0 && node.borderColor != null)
                        var hasBody   = (fastClip.w > 0.25 && fastClip.h > 0.25)
                        if (hasBorder || hasBody) {
                            openRectBatch()
                            if (hasBorder) {
                                var fbw = Math.round(Number(node.borderWidth))
                                if (fbw > 0) {
                                    var fbCol = toArgbWithAlpha(resolveVarValue(node.borderColor, vMap, 0xFFFFFFFF), nAlpha)
                                    emitOutlineIntoOpenBatch(x0 - fbw, y0 - fbw, nw + fbw * 2, nh + fbw * 2, fbw, fbCol)
                                }
                            }
                            if (hasBody) {
                                if (fastMode === 'outline') {
                                    var foCol = toArgbWithAlpha(resolveVarValue((fastFill != null && fastFill.color != null) ? fastFill.color : nodeRawColor, vMap, 0xFFFFFFFF), nAlpha)
                                    var foThk = max2(1, Math.round(Number((fastFill != null && fastFill.thickness) || 1)))
                                    emitOutlineIntoOpenBatch(fastClip.x, fastClip.y, fastClip.w, fastClip.h, foThk, foCol)
                                } else {
                                    var fsCol = toArgbWithAlpha(resolveVarValue((fastFill != null && fastFill.color != null) ? fastFill.color : nodeRawColor, vMap, 0xFF000000), nAlpha)
                                    event.rectangle(fastClip.x, fastClip.y, 0.0, fastClip.w, fastClip.h, fsCol)
                                }
                            }
                        }
                        continue
                    }
                }

                closeRectBatch()

                var nodePushed    = false
                var scissorPushed = false
                try {
                    if (needsPush) {
                        ensureItemPosePushed(event)
                        event.push()
                        nodePushed = true
                        if (nx !== 0 || ny !== 0) event.translate(nx, ny)
                        if (nAngle !== 0 && isFinite(nAngle)) event.rotateDeg(nAngle)
                        if (Math.abs(nScale - 1.0) > 0.001 && isFinite(nScale)) {
                            applyNodeLocalScale(event, nScale, nScale)
                        }
                        var localOrig = computeBoxAnchorOrigin(0, 0, nw, nh, anchor, BOX_ORIG_SCRATCH)
                        x0 = localOrig.x0
                        y0 = localOrig.y0
                    }

                    var clipped = computeLocalClipRect(
                        x0, y0, nw, nh,
                        node.u || 0, node.v || 0,
                        node.uw != null ? node.uw : nw,
                        node.vh != null ? node.vh : nh,
                        (!useScissor ? clipSpec : null),
                        vMap,
                        LOCAL_CLIP_SCRATCH
                    )

                    if (useScissor && clipSpec != null) {
                        var scRect = computeLocalClipRect(x0, y0, nw, nh, 0, 0, nw, nh, clipSpec, vMap)
                        scissorPushed = enableEventScissor(event, scRect.x, scRect.y, scRect.x + scRect.w, scRect.y + scRect.h)
                    }

                    if (nType === 'rect') {
                        if (node.borderWidth != null && Number(node.borderWidth) > 0 && node.borderColor != null) {
                            var bw = Math.round(Number(node.borderWidth))
                            if (bw > 0) {
                                var bCol = resolveVarValue(node.borderColor, vMap, 0xFFFFFFFF)
                                var bArgb = toArgbWithAlpha(bCol, nAlpha)
                                drawRectOutline(event, x0 - bw, y0 - bw, nw + bw * 2, nh + bw * 2, bw, bArgb)
                            }
                        }
                        if (clipped.w > 0.25 && clipped.h > 0.25) {
                            var fill = isPlainObjLike(node.fill)
                                ? node.fill
                                : { mode: 'solid', color: nodeRawColor != null ? nodeRawColor : 0xFF000000 }
                            var fMode = String(fill.mode || 'solid').toLowerCase()
                            if (fMode === 'outline') {
                                var oCol = toArgbWithAlpha(resolveVarValue(fill.color != null ? fill.color : nodeRawColor, vMap, 0xFFFFFFFF), nAlpha)
                                var oThk = max2(1, Math.round(Number(fill.thickness || 1)))
                                drawRectOutline(event, clipped.x, clipped.y, clipped.w, clipped.h, oThk, oCol)
                            } else if (fMode === 'gradient') {
                                var cFrom = toArgbWithAlpha(resolveVarValue(fill.from !== undefined ? fill.from : fill.color, vMap, 0xFF5555), nAlpha)
                                var cTo   = toArgbWithAlpha(resolveVarValue(fill.to !== undefined ? fill.to : fill.colorEnd, vMap, 0xFFAA00), nAlpha)
                                var cMid  = fill.mid !== undefined ? toArgbWithAlpha(resolveVarValue(fill.mid, vMap, cTo), nAlpha) : null
                                var gDirVal = (fill.dir === 'v' || fill.dir === 'vertical') ? 'v' : 'h'
                                drawRectGradient(event, clipped.x, clipped.y, clipped.w, clipped.h, cFrom, cTo, gDirVal, cMid, fill.midPos)
                            } else if (fMode === 'parallax') {
                                drawRectParallax(event, clipped.x, clipped.y, clipped.w, clipped.h, fill, now, nAlpha, x0, y0, nw, nh, vMap)
                            } else if (fMode === 'shader') {
                                drawRectShader(event, clipped.x, clipped.y, clipped.w, clipped.h, fill, now, nAlpha)
                            } else {
                                var sCol = toArgbWithAlpha(resolveVarValue(fill.color != null ? fill.color : nodeRawColor, vMap, 0xFF000000), nAlpha)
                                drawRectSolid(event, clipped.x, clipped.y, clipped.w, clipped.h, sCol)
                            }
                        }
                    } else if (nType === 'sprite') {
                        if (clipped.w > 0.25 && clipped.h > 0.25) {
                            var spTint = nodeRawColor != null ? resolveVarValue(nodeRawColor, vMap, 0xFFFFFFFF) : 0xFFFFFFFF
                            drawTextureRegion(
                                event,
                                node.texture || node.tex || '',
                                clipped.x, clipped.y, clipped.w, clipped.h,
                                clipped.u, clipped.v, clipped.uw, clipped.vh,
                                node.texW !== undefined ? node.texW : (node.tw || 256),
                                node.texH !== undefined ? node.texH : (node.th || 256),
                                nAlpha,
                                spTint
                            )
                        }
                    } else if (nType === 'nine_slice') {
                        if (clipped.w > 0.25 && clipped.h > 0.25) {
                            drawNineSliceNode(event, node, clipped.x, clipped.y, clipped.w, clipped.h, nAlpha)
                        }
                    } else if (nType === 'item') {
                        drawItemNode(event, node, clipped.x, clipped.y)
                    } else if (nType === 'text') {
                        drawDeclarativeTextNode(
                            event,
                            item,
                            node,
                            node.text != null ? node.text : (node.title || ''),
                            vMap,
                            nAlpha,
                            fontObj,
                            nodePushed ? null : itemBatchCtx,
                            nodePushed ? 0 : nx,
                            nodePushed ? 0 : ny
                        )
                    } else if (nType === 'group') {
                        var groupKids = Array.isArray(node.children) ? node.children : node.items
                        renderDeclarativeNodes(event, item, groupKids, vMap, nAlpha, fontObj, null, now, effAngle, (depth || 0) + 1)
                    }
                } finally {
                    if (scissorPushed) {
                        try { disableEventScissor(event) } catch (eScis) { }
                    }
                    if (nodePushed) {
                        try { event.pop() } catch (eNPop) { }
                    }
                }
            }
        } finally {
            closeRectBatch()
        }
    }

    function matchesTargetGui(screenObj, targetGui) {
        if (!isPlainObjLike(targetGui)) return true
        if (screenObj == null) return false
        try {
            if (targetGui.screenClass) {
                var clsName = ''
                if (typeof screenObj.getClass === 'function') {
                    clsName = String(screenObj.getClass().getName())
                } else if (screenObj.className) {
                    clsName = String(screenObj.className)
                }
                if (clsName.indexOf(String(targetGui.screenClass)) < 0) return false
            }
            if (targetGui.titleMatch) {
                var tStr = ''
                if (typeof screenObj.getTitle === 'function' && screenObj.getTitle() != null) {
                    tStr = String(screenObj.getTitle().getString ? screenObj.getTitle().getString() : screenObj.getTitle())
                } else if (screenObj.title != null) {
                    tStr = String(screenObj.title)
                }
                if (tStr.indexOf(String(targetGui.titleMatch)) < 0) return false
            }
        } catch (eMatch) {
            return false
        }
        return true
    }

    var TM_BY_PATH_FAILED = false

    function resolveMcTextureManager() {
        if (TM_BY_PATH_FAILED || MinecraftClass == null || MC_INSTANCE_FAILED) return null
        try {
            var mc = MinecraftClass.getInstance()
            if (mc == null) return null
            if (typeof mc.getTextureManager === 'function') return mc.getTextureManager()
            if (mc.textureManager != null) return mc.textureManager
            if (mc.f_91088_ != null) return mc.f_91088_
        } catch (eTm) { }
        return null
    }

    function applyReplacedTexturesForGui(replaceMap) {
        if (!isPlainObjLike(replaceMap)) return
        var tm = resolveMcTextureManager()
        for (var origPath in replaceMap) {
            if (!Object.prototype.hasOwnProperty.call(replaceMap, origPath)) continue
            var repPath = String(replaceMap[origPath] || '')
            if (!repPath || !checkTextureExists(repPath)) {
                warnOnce('replaceTexMissing:' + repPath, 'GUI 替换目标贴图不存在，已保留原版贴图: ' + repPath)
                continue
            }
            if (REPLACED_TEXTURE_REGISTRY[origPath] != null && REPLACED_TEXTURE_REGISTRY[origPath].replacementPath === repPath) {
                continue
            }
            var origRl = getResourceLocation(origPath)
            var repRl  = getResourceLocation(repPath)
            var origTexObj = null
            var registeredReal = false
            if (tm != null && origRl != null && repRl != null) {
                try {
                    origTexObj = typeof tm.getTexture === 'function'
                        ? tm.getTexture(origRl)
                        : (typeof tm.m_118506_ === 'function' ? tm.m_118506_(origRl) : null)
                    var repTexObj = typeof tm.getTexture === 'function'
                        ? tm.getTexture(repRl)
                        : (typeof tm.m_118506_ === 'function' ? tm.m_118506_(repRl) : null)
                    if (repTexObj != null) {
                        if (typeof tm.register === 'function') {
                            tm.register(origRl, repTexObj)
                            registeredReal = true
                        } else if (typeof tm.m_118495_ === 'function') {
                            tm.m_118495_(origRl, repTexObj)
                            registeredReal = true
                        }
                    }
                } catch (eRegTex) {
                    warnOnce('replaceTexTm:' + origPath, 'TextureManager 贴图重映射不可用，将仅执行 bgNodes 夹心层覆盖: ' + eRegTex)
                }
            }
            REPLACED_TEXTURE_REGISTRY[origPath] = {
                texManager:      registeredReal ? tm : null,
                resLoc:          origRl,
                originalTexObj:  origTexObj,
                originalPath:    origPath,
                replacementPath: repPath,
                active:          true
            }
        }
    }

    function renderGuiSurfacePass(screenOrEvent, phase, guiCtx) {
        var now = monotonicNowMs()
        flushPendingActions(now)
        var ctx = isPlainObjLike(guiCtx) ? guiCtx : {}
        var screenObj = ctx.screen || (screenOrEvent != null ? (screenOrEvent.screen || getActiveScreen(screenOrEvent)) : null)
        var guiLeft = Number(ctx.guiLeft != null ? ctx.guiLeft : (screenObj != null && screenObj.guiLeft != null ? screenObj.guiLeft : 0)) || 0
        var guiTop  = Number(ctx.guiTop != null ? ctx.guiTop : (screenObj != null && screenObj.guiTop != null ? screenObj.guiTop : 0)) || 0
        var fontObj = getClientFont(screenOrEvent, now)
        var rendered = 0
        var prevEv = ACTIVE_FRAME_EVENT
        var prevDirty = GRAPHICS_TEXT_DIRTY
        ACTIVE_FRAME_EVENT = screenOrEvent
        GRAPHICS_TEXT_DIRTY = false

        var passList = []
        for (var oi = 0; oi < activeOverlays.length; oi++) {
            var cand = activeOverlays[oi]
            if (cand != null && now < cand.expire && (cand.surface === 'gui' || cand.surface === 'slot')) {
                passList.push(cand)
            }
        }
        if (passList.length > 1) passList.sort(compareOverlayDrawPriority)

        try {
        for (var i = 0; i < passList.length; i++) {
            var ov = passList[i]
            if (!matchesTargetGui(screenObj, ov.targetGui)) continue

            stepOverlayTracks(ov, now)
            var fadeStartAt  = ov.fadeStartAt != null ? ov.fadeStartAt : (ov.expire - (ov.fadeMs || 350))
            var fadeWin      = max2(1, ov.expire - fadeStartAt)
            var inFade       = (now >= fadeStartAt)
            var fadeProgress = inFade ? clampNum((now - fadeStartAt) / fadeWin, 0.0, 1.0) : 0.0
            var fadeAlpha    = inFade ? clampNum(1.0 - fadeProgress, 0.04, 1.0) : 1.0
            var vMap         = ov.displayVars || ov.vars || {}

            var pushed = false
            try {
                if ((phase === 'pre' || phase === 'bg') && ov.surface === 'gui') {
                    if (ov.replaceTextures != null) {
                        applyReplacedTexturesForGui(ov.replaceTextures)
                    }
                    if (Array.isArray(ov.bgNodes) && ov.bgNodes.length > 0 && screenOrEvent != null) {
                        if (typeof screenOrEvent.push === 'function' && (guiLeft !== 0 || guiTop !== 0)) {
                            screenOrEvent.push()
                            pushed = true
                            screenOrEvent.translate(guiLeft, guiTop)
                        }
                        renderDeclarativeNodes(screenOrEvent, ov, ov.bgNodes, vMap, fadeAlpha, fontObj, null, now, 0.0, 0)
                        rendered++
                    }
                } else if (phase === 'slot' && ov.surface === 'slot') {
                    var slotX = Number(ctx.slotX || 0)
                    var slotY = Number(ctx.slotY || 0)
                    var slotMatch = ov.slotMatch
                    var matchedSlot = true
                    if (slotMatch != null) {
                        if (slotMatch.item && ctx.itemId && String(ctx.itemId) !== String(slotMatch.item)) matchedSlot = false
                        if (slotMatch.slotIndex != null && slotMatch.slotIndex >= 0 && ctx.slotIndex != null && Number(ctx.slotIndex) !== Number(slotMatch.slotIndex)) matchedSlot = false
                    }
                    if (matchedSlot && Array.isArray(ov.nodes) && ov.nodes.length > 0 && screenOrEvent != null) {
                        if (typeof screenOrEvent.push === 'function') {
                            screenOrEvent.push()
                            pushed = true
                            screenOrEvent.translate(guiLeft + slotX, guiTop + slotY)
                        }
                        renderDeclarativeNodes(screenOrEvent, ov, ov.nodes, vMap, fadeAlpha, fontObj, null, now, 0.0, 0)
                        rendered++
                    }
                } else if ((phase === 'post' || phase === 'fg' || !phase) && ov.surface === 'gui') {
                    var fgList = (Array.isArray(ov.fgNodes) && ov.fgNodes.length > 0) ? ov.fgNodes : ov.nodes
                    if (Array.isArray(fgList) && fgList.length > 0 && screenOrEvent != null) {
                        if (typeof screenOrEvent.push === 'function' && (guiLeft !== 0 || guiTop !== 0)) {
                            screenOrEvent.push()
                            pushed = true
                            screenOrEvent.translate(guiLeft, guiTop)
                        }
                        renderDeclarativeNodes(screenOrEvent, ov, fgList, vMap, fadeAlpha, fontObj, null, now, 0.0, 0)
                        rendered++
                    }
                }
            } finally {
                if (pushed && screenOrEvent != null && typeof screenOrEvent.pop === 'function') {
                    try { screenOrEvent.pop() } catch (eGPop) { }
                }
            }
        }
        } finally {
            flushBatchedBeforeImmediate()
            ACTIVE_FRAME_EVENT = prevEv
            GRAPHICS_TEXT_DIRTY = prevDirty
        }
        return rendered
    }

    ClientEvents.paintScreen(function (event) {
        var curLevelKey = resolveCurrentLevelKey(event)
        if (curLevelKey === '') {
            if (activeOverlays.length > 0) activeOverlays.length = 0
            if (pendingActions.length > 0) pendingActions.length = 0
            LAST_LEVEL_KEY    = ''
            BATCH_FAILED      = false
            BATCH_RETRY_AT_MS = 0
            if (FRAME_BATCH_CTX != null) FRAME_BATCH_CTX.muiRetryAtMs = 0
            return
        }
        if (curLevelKey != null) {
            if (LAST_LEVEL_KEY !== '' && LAST_LEVEL_KEY !== curLevelKey) {
                activeOverlays.length = 0
            }
            LAST_LEVEL_KEY = curLevelKey
        }

        var now = monotonicNowMs()
        flushPendingActions(now)

        // 每帧绘制前统一清理全部已到期弹幕，避免紧急熔断时残留过期项未淘汰
        for (var expIdx = activeOverlays.length - 1; expIdx >= 0; expIdx--) {
            if (now >= activeOverlays[expIdx].expire) {
                activeOverlays.splice(expIdx, 1)
            }
        }
        if (activeOverlays.length === 0) {
            if (Object.keys(REPLACED_TEXTURE_REGISTRY).length > 0) {
                restoreAllReplacedTextures()
            }
            return
        }

        var sw                  = Number(event.width) || 854
        var sh                  = Number(event.height) || 480
        var curScreenObj        = resolveCurrentScreen(event)
        var guiBlocked          = isBlockingGuiOpen(event)
        var fontObj             = null
        var batchCtx            = null
        var batchTried          = false
        var baseFrameM          = null
        var frameStartMs        = now
        var drawnCount          = 0
        var lastRenderPri       = null
        var anyGuiReplaceMatch  = false
        ACTIVE_FRAME_EVENT      = event
        GRAPHICS_TEXT_DIRTY     = false

        var drawListLen = activeOverlays.length
        var drawList    = activeOverlays
        if (drawListLen > 1) {
            DRAW_ORDER_SCRATCH.length = drawListLen
            for (var oi = 0; oi < drawListLen; oi++) {
                DRAW_ORDER_SCRATCH[oi] = activeOverlays[oi]
            }
            DRAW_ORDER_SCRATCH.sort(compareOverlayDrawPriority)
            drawList = DRAW_ORDER_SCRATCH
        }

        try {
            for (var i = 0; i < drawListLen; i++) {
            var item = drawList[i]
            if (now >= item.expire) continue

            if (item.surface === 'gui' || item.surface === 'slot') {
                var guiMatchedNow = (curScreenObj != null) && matchesTargetGui(curScreenObj, item.targetGui)
                if (guiMatchedNow) {
                    item._wasGuiSessionOpen = true
                } else if (item.lifeMode === 'screen_session' && item._wasGuiSessionOpen) {
                    item.expire = now
                    continue
                }
            }

            if (guiBlocked && !item.showInGui) {
                continue
            }

            var curRenderPri = item.renderPriority != null ? Number(item.renderPriority) : 0
            if (lastRenderPri !== null && curRenderPri !== lastRenderPri) {
                flushBatchedBeforeImmediate()
            }
            lastRenderPri = curRenderPri

            // 单帧硬防卡死熔断（每绘制 8 条采样一次 monotonicNowMs，大幅削减 System.nanoTime JNI 跨界开销）：
            // 若极重洪泛触及该上限，将截断同层级/低层级尾部条目；GUI/slot 等高渲染层级 (renderPriority > 0) 始终放行。
            if (curRenderPri <= 0 && drawnCount >= 1 && (drawnCount & 7) === 1 && (monotonicNowMs() - frameStartMs) >= CONFIG.frameBudgetMs) {
                continue
            }
            drawnCount++

            if (fontObj === null) {
                fontObj = getClientFont(event, now)
            }
            if (!batchTried) {
                batchTried = true
                batchCtx   = ensureFrameBatchCtx(event, fontObj, now)
                ACTIVE_FRAME_BATCH_CTX = batchCtx
                if (batchCtx != null) {
                    baseFrameM = batchCtx.hasGetMatrixFn ? event.getMatrix() : event.matrix
                    batchCtx.baseFrameMat = baseFrameM
                }
            }

            var age          = max2(0, now - item.born)
            var rem          = max2(0, item.expire - now)
            var fadeStartAt  = item.fadeStartAt != null ? item.fadeStartAt : (item.expire - (item.fadeMs || 350))
            var fadeWin      = max2(1, item.expire - fadeStartAt)
            var inFade       = (now >= fadeStartAt)
            var fadeProgress = inFade ? clampNum((now - fadeStartAt) / fadeWin, 0.0, 1.0) : 0.0
            stepOverlayTracks(item, now)

            // 1. 最大行宽与自动换行缓存（含字间距 letterSpacing）
            var baseScale          = (item.scale != null && item.scale > 0.25) ? Number(item.scale) : 1.0
            var screenFitUnscaledW = max2(CONFIG.minWrapLinePx, Math.floor((sw - CONFIG.screenMarginPx) / baseScale))
            var pctClamped         = max2(24, Math.floor((sw * CONFIG.defaultWrapScreenPct) / baseScale))
            var screenMaxUnscaledW = min2(screenFitUnscaledW, pctClamped)
            var userMaxUnscaledW   = screenMaxUnscaledW
            if (item.maxWidth != null && item.maxWidth > 0) {
                userMaxUnscaledW = (item.maxWidth <= 1.0)
                    ? max2(CONFIG.minWrapLinePx, Math.floor((sw * item.maxWidth) / baseScale))
                    : Math.floor(item.maxWidth)
            }
            var rawEffMaxW   = item.wrap !== false ? min2(screenMaxUnscaledW, userMaxUnscaledW) : 999999
            var minSafeLineW = min2(CONFIG.minSafeWrapLinePx, min2(screenMaxUnscaledW, userMaxUnscaledW))
            var bucketW      = Math.floor(rawEffMaxW / CONFIG.wrapBucketPx) * CONFIG.wrapBucketPx
            var effMaxLineW  = rawEffMaxW < 999999
                ? max2(CONFIG.minWrapLinePx, max2(minSafeLineW, bucketW))
                : 999999

            var itemSpacing     = item.letterSpacing || 0
            var itemSpacingMode = item.letterSpacingMode || 'relative'
            var curFontSig      = (fontObj != null ? FONT_SIGNATURE : 'E:')
            if (item._lastFontSig !== curFontSig ||
                item._lastMaxLineW !== effMaxLineW ||
                item._lastSpacing !== itemSpacing ||
                item._lastSpacingMode !== itemSpacingMode ||
                !item.wrapKey ||
                !item.titleLines ||
                !item.subLines) {
                var rebuiltWrapKey = curFontSig + '|' + effMaxLineW + '|ls:' + itemSpacing + ':' + itemSpacingMode + '|' + item.title + '|' + item.sub
                item._lastFontSig     = curFontSig
                item._lastMaxLineW    = effMaxLineW
                item._lastSpacing     = itemSpacing
                item._lastSpacingMode = itemSpacingMode
                if (item.wrapKey !== rebuiltWrapKey || !item.titleLines || !item.subLines) {
                    item.wrapKey    = rebuiltWrapKey
                    var preferWholeWrap = (itemSpacing === 0 && !(item.perCharShake === true || item.shakeMode === 'per_char') && item.hasInlineTags !== true)
                    item.titleLines = wrapStyledTextLines(item.title, effMaxLineW, fontObj, itemSpacing, itemSpacingMode, preferWholeWrap)
                    item.subLines   = wrapStyledTextLines(item.sub, effMaxLineW, fontObj, itemSpacing, itemSpacingMode, preferWholeWrap)
                    var maxW = 0
                    for (var twi = 0; twi < item.titleLines.length; twi++) {
                        if (item.titleLines[twi].widthPx > maxW) maxW = item.titleLines[twi].widthPx
                    }
                    for (var swi = 0; swi < item.subLines.length; swi++) {
                        if (item.subLines[swi].widthPx > maxW) maxW = item.subLines[swi].widthPx
                    }
                    var totalLineCount = item.titleLines.length + item.subLines.length
                    var nodeBBox = { minX: -maxW * 0.5, minY: -(totalLineCount * CONFIG.lineStepPx) * 0.5, maxX: maxW * 0.5, maxY: (totalLineCount * CONFIG.lineStepPx) * 0.5 }
                    if (item.hasGraphicNodes && Array.isArray(item.nodes)) {
                        computeNodesBounds(item.nodes, item.displayVars || item.vars || {}, nodeBBox, 0)
                    }
                    item.blockW = max2(maxW, Math.ceil(nodeBBox.maxX - nodeBBox.minX))
                    item.blockH = max2(CONFIG.minBlockHeightPx, max2(totalLineCount * CONFIG.lineStepPx, Math.ceil(nodeBBox.maxY - nodeBBox.minY)))
                }
            }
            var curWrapKey = item.wrapKey

            // 2. 打字机可见字数进度
            var shownVis = item.totalVis
            if (item.typewriter && item.totalVis > 0) {
                if (!inFade) {
                    item.frozenVis = null
                    shownVis = min2(item.totalVis, Math.floor(age / item.charMs) + 1)
                } else {
                    if (item.frozenVis == null) {
                        var fadeStartAge = max2(0, fadeStartAt - item.born)
                        item.frozenVis = min2(item.totalVis, Math.floor(fadeStartAge / item.charMs) + 1)
                    }
                    shownVis = item.frozenVis
                }
            }

            var startSkipVis = 0
            var keepEndVis   = shownVis

            // 3. 入场弹跳与淡出变形（注意：blur 虚化淡出保持原字号不放大；split 裂解淡出保留轻微放大）
            var scaleX = item.scale
            var scaleY = item.scale

            if (!item.typewriter && age < CONFIG.popAnimMs) {
                var pop = item.scale * (CONFIG.popScalePeak - (CONFIG.popScalePeak - 1.0) * (age / CONFIG.popAnimMs))
                scaleX = pop
                scaleY = pop
            } else if (inFade) {
                var fs = item.fadeStyle
                if (fs === 'blink') {
                    var blinkStep = rem < (fadeWin * 0.4) ? 28 : 55
                    if (Math.floor(now / blinkStep) % 2 === 0) continue
                } else if (fs === 'char_first' && shownVis > 0) {
                    var goneChars = Math.floor(fadeProgress * (shownVis + 1))
                    if (goneChars >= shownVis) continue
                    startSkipVis = goneChars
                } else if (fs === 'char_last' && shownVis > 0) {
                    var remainChars = max2(0, shownVis - Math.floor(fadeProgress * (shownVis + 1)))
                    if (remainChars <= 0) continue
                    keepEndVis = remainChars
                } else if (fs === 'split') {
                    var splitExpand = 1.0 + fadeProgress * 0.05
                    scaleX = item.scale * splitExpand
                    scaleY = item.scale * splitExpand
                } else if (fs !== 'shatter' && fs !== 'blur') {
                    var shrinkFactor = max2(0.04, 1.0 - fadeProgress * 0.94)
                    scaleX = item.scale * shrinkFactor
                    scaleY = item.scale * shrinkFactor
                }
            }

            var blinkCursor = ''
            if (item.typewriter && !inFade && shownVis < item.totalVis && item.totalVis > 0) {
                blinkCursor = (Math.floor(now / CONFIG.cursorBlinkMs) % 2 === 0) ? item.cursor : ''
            }

            var titleLineCount = item.titleLines ? item.titleLines.length : 0
            var subLineCount   = item.subLines ? item.subLines.length : 0
            var totalLines     = titleLineCount + subLineCount
            var lineStep       = CONFIG.lineStepPx
            var startY         = -Math.floor((totalLines * lineStep) * 0.5) + 1
            var isShatterFade  = (inFade && item.fadeStyle === 'shatter')

            // 4. 震动偏移与屏幕边界约束
            var isPerCharShake  = (item.perCharShake === true || item.shakeMode === 'per_char')
            var usePerCharRoute = (!isShatterFade) && (isPerCharShake || itemSpacing !== 0 || item.hasInlineTags === true)
            var curShake        = computeCurrentShakeAmp(item, now, age, fadeStartAt, fadeWin)
            if (isShatterFade) {
                curShake = max2(curShake, 1.8 * (1.0 - fadeProgress * 0.5))
            }
            var shakeVec
            if (!isPerCharShake || isShatterFade) {
                shakeVec = sampleContinuousShakeOffset(item, age, curShake, SHAKE_VEC_SCRATCH)
            } else {
                SHAKE_VEC_SCRATCH.x = 0.0
                SHAKE_VEC_SCRATCH.y = 0.0
                shakeVec = SHAKE_VEC_SCRATCH
            }
            var px = sw * item.rx + (item.ox || 0) + shakeVec.x
            var py = sh * item.ry + (item.oy || 0) + shakeVec.y

            var angDeg = item.angle || 0
            var cosR   = 1.0
            var sinR   = 0.0
            if (angDeg !== 0 && isFinite(angDeg)) {
                var signedRad = angDeg * DEG_TO_RAD
                cosR = Math.cos(signedRad)
                sinR = Math.sin(signedRad)
            }
            var cosA = cosR >= 0 ? cosR : -cosR
            var sinA = sinR >= 0 ? sinR : -sinR
            var mxx  = cosR * scaleX
            var mxy  = -sinR * scaleY
            var myx  = sinR * scaleX
            var myy  = cosR * scaleY

            // 注：HUD 禁区避让（HUD_FORBIDDEN_PRESETS）仅在服务端 pos='edge'/'spread'/'random' 采样阶段生效；
            // 客户端仅负责屏幕边缘 clampBounds 兜底而不二次踢开固定坐标，确保显式指定 rx/ry 位置不被擅自改写。
            if (item.clamp !== false) {
                var wScaled  = (item.blockW || 0) * Math.abs(scaleX)
                var hScaled  = (item.blockH || 12) * Math.abs(scaleY)
                var halfExtX = 0.5 * (wScaled * cosA + hScaled * sinA)
                var halfExtY = 0.5 * (wScaled * sinA + hScaled * cosA)
                var halfSw   = sw * 0.5
                var halfSh   = sh * 0.5
                var minX     = min2(halfSw, halfExtX + CONFIG.clampPadPx)
                var maxX     = max2(halfSw, sw - halfExtX - CONFIG.clampPadPx)
                var minY     = min2(halfSh, halfExtY + CONFIG.clampPadPx)
                var maxY     = max2(halfSh, sh - halfExtY - CONFIG.clampPadPx)
                px = clampNum(px, minX, maxX)
                py = clampNum(py, minY, maxY)
            } else if (sw > 0 && sh > 0) {
                if (isUnitOutOfViewport(0.0, 0.0, (item.blockW || 0) * 0.5 + 16.0, (item.blockH || 12) * 0.5 + 16.0, px, py, mxx, mxy, myx, myy, sw, sh, 28.0)) {
                    item.drawErrors = 0
                    continue
                }
            }

            ITEM_POSE_SCRATCH.needed = false
            ITEM_POSE_SCRATCH.pushed = false
            try {
                if (batchCtx != null) {
                    batchCtx.itemFgReady = false
                    batchCtx.itemOutZ1   = NaN
                    batchCtx.itemOutZ2   = NaN
                }
                if (batchCtx != null && !BATCH_FAILED && batchCtx.canDirectMatrix && baseFrameM != null) {
                    var iMat = batchCtx._itemScratch
                    iMat.set(baseFrameM)
                    iMat.translate(px, py, 0.0)
                    if (item.angle !== 0 && isFinite(item.angle)) {
                        iMat.rotateZ(item.angle * DEG_TO_RAD)
                    }
                    if ((scaleX !== 1.0 || scaleY !== 1.0) && isFinite(scaleX) && isFinite(scaleY)) {
                        iMat.scale(scaleX, scaleY, 1.0)
                    }
                    batchCtx.itemMat         = iMat
                    ITEM_POSE_SCRATCH.needed = true
                    ITEM_POSE_SCRATCH.px     = px
                    ITEM_POSE_SCRATCH.py     = py
                    ITEM_POSE_SCRATCH.angle  = item.angle
                    ITEM_POSE_SCRATCH.scaleX = scaleX
                    ITEM_POSE_SCRATCH.scaleY = scaleY
                } else {
                    applyItemPoseToEvent(event, px, py, item.angle, scaleX, scaleY)
                    ITEM_POSE_SCRATCH.needed = true
                    ITEM_POSE_SCRATCH.pushed = true
                    if (batchCtx != null && !BATCH_FAILED) {
                        batchCtx.itemMat = batchCtx.hasGetMatrixFn ? event.getMatrix() : event.matrix
                    }
                }

                // 在进入任何逐字/碎片/行缓存循环前确定本条是否具备有效合批矩阵；
                // 拿不到 itemMat 时直接降为 null，禁止在每字热路径内再重复调 event.getMatrix() 兜底
                var itemBatchCtx = (batchCtx != null && !BATCH_FAILED && batchCtx.itemMat != null) ? batchCtx : null

                if (item.hasGraphicNodes) {
                    var nodeFadeAlpha = inFade ? clampNum(1.0 - fadeProgress, 0.04, 1.0) : 1.0
                    if (item.surface === 'gui' || item.surface === 'slot') {
                        var activeScr = curScreenObj
                        if (matchesTargetGui(activeScr, item.targetGui)) {
                            if (item.replaceTextures != null) {
                                anyGuiReplaceMatch = true
                                applyReplacedTexturesForGui(item.replaceTextures)
                            }
                            if (Array.isArray(item.bgNodes) && item.bgNodes.length > 0) {
                                renderDeclarativeNodes(event, item, item.bgNodes, item.displayVars || item.vars || {}, nodeFadeAlpha, fontObj, itemBatchCtx, now, angDeg, 0)
                            }
                            if (Array.isArray(item.nodes) && item.nodes.length > 0) {
                                renderDeclarativeNodes(event, item, item.nodes, item.displayVars || item.vars || {}, nodeFadeAlpha, fontObj, itemBatchCtx, now, angDeg, 0)
                            }
                            if (Array.isArray(item.fgNodes) && item.fgNodes.length > 0) {
                                renderDeclarativeNodes(event, item, item.fgNodes, item.displayVars || item.vars || {}, nodeFadeAlpha, fontObj, itemBatchCtx, now, angDeg, 0)
                            }
                        }
                    } else {
                        renderDeclarativeNodes(event, item, item.nodes, item.displayVars || item.vars || {}, nodeFadeAlpha, fontObj, itemBatchCtx, now, angDeg, 0)
                    }
                } else if (isShatterFade) {
                    var titleSkipS   = min2(item.titleVis, startSkipVis)
                    var titleKeepS   = min2(item.titleVis, keepEndVis)
                    var subSkipS     = max2(0, startSkipVis - item.titleVis)
                    var subKeepS     = max2(0, keepEndVis - item.titleVis)
                    var sTitleLines  = buildRenderedLines(item.titleLines, titleSkipS, titleKeepS, '', fontObj, itemSpacing, itemSpacingMode, false)
                    var sSubLines    = buildRenderedLines(item.subLines, subSkipS, subKeepS, '', fontObj, itemSpacing, itemSpacingMode, false)
                    var cachedFrags  = getOrBuildShatterCache(item, sTitleLines, sSubLines, titleLineCount, startY, lineStep, shownVis, fontObj)
                    var fastMode     = (activeOverlays.length > CONFIG.shatterFastThreshold)
                    var shShdBool    = Boolean(item.shadow)
                    for (var fIdx = 0; fIdx < cachedFrags.length; fIdx++) {
                        var frag = cachedFrags[fIdx]
                        if (fadeProgress >= frag.vanishAt) continue
                        var localP = min2(1.0, fadeProgress * frag.invVanish)
                        if (localP > 0.78 && (Math.floor((now + frag.phaseShift) / 32) % 2 === 0)) continue

                        var burstP = localP * localP
                        var dx     = frag.vx * burstP
                        var dy     = frag.vy * burstP + (14.0 * burstP * localP)
                        var rotDeg = frag.rotMax * burstP
                        var fScale = max2(0.12, 1.0 - localP * 0.78)
                        var fCol   = ((frag.color != null && isFinite(frag.color)) ? Math.round(frag.color) : 0xFF5555) | 0xFF000000
                        var fLay   = (itemBatchCtx != null) ? resolveUnitMuiLayout(itemBatchCtx, frag.seq, frag) : null
                        var fUseMui = (fLay != null && itemBatchCtx != null && itemBatchCtx.muiActive)
                        var fSeq   = fUseMui ? frag.seq : ensureUnitCompSeq(frag).seq
                        var fMode  = (fUseMui && itemBatchCtx.muiAllowSdf) ? 1 : 0

                        if (fastMode || (Math.abs(rotDeg) < 2.0 && fScale > 0.92)) {
                            var fxRaw = (frag.cx || 0) + (dx || 0) + (frag.halfW || 0)
                            var fyRaw = (frag.cy || 0) + (dy || 0) - 4.5
                            if (!(itemBatchCtx != null && drawBatchedGlyph(itemBatchCtx, fSeq, fxRaw, fyRaw, fCol, shShdBool, itemBatchCtx.itemMat, fLay, fMode))) {
                                ensureUnitCompSeq(frag)
                                ensureFallbackBlend(event, itemBatchCtx)
                                ensureItemPosePushed(event)
                                event.text(frag.comp, Math.round(fxRaw) || 0, Math.round(fyRaw) || 0, fCol, shShdBool)
                            }
                        } else if (itemBatchCtx != null && itemBatchCtx.canDirectMatrix) {
                            var fMatDirect = itemBatchCtx.unitMat
                            fMatDirect.set(itemBatchCtx.itemMat)
                            fMatDirect.translate((frag.cx || 0) + (dx || 0), (frag.cy || 0) + (dy || 0), 0.0)
                            if (rotDeg !== 0 && isFinite(rotDeg)) fMatDirect.rotateZ(rotDeg * DEG_TO_RAD)
                            if (fScale !== 1.0 && isFinite(fScale)) fMatDirect.scale(fScale, fScale, 1.0)
                            if (!drawBatchedGlyph(itemBatchCtx, fSeq, frag.halfW || 0, -4.5, fCol, shShdBool, fMatDirect, fLay, fMode)) {
                                ensureUnitCompSeq(frag)
                                ensureFallbackBlend(event, itemBatchCtx)
                                ensureItemPosePushed(event)
                                var fpDirect = false
                                try {
                                    event.push()
                                    fpDirect = true
                                    event.translate((frag.cx || 0) + (dx || 0), (frag.cy || 0) + (dy || 0))
                                    if (rotDeg !== 0 && isFinite(rotDeg)) event.rotateDeg(rotDeg)
                                    if (fScale !== 1.0 && isFinite(fScale)) {
                                        event['scale(float,float)'] ? event['scale(float,float)'](fScale, fScale) : event.scale(fScale, fScale)
                                    }
                                    event.text(frag.comp, Math.round(frag.halfW || 0) || 0, -4, fCol, shShdBool)
                                } catch (eFD) {
                                    logErrorThrottled('shatter direct draw error', eFD)
                                } finally {
                                    if (fpDirect) { try { event.pop() } catch (eFDPop) { } }
                                }
                            }
                        } else {
                            var fragPushed = false
                            try {
                                ensureItemPosePushed(event)
                                event.push()
                                fragPushed = true
                                event.translate((frag.cx || 0) + (dx || 0), (frag.cy || 0) + (dy || 0))
                                if (rotDeg !== 0 && isFinite(rotDeg)) event.rotateDeg(rotDeg)
                                if (fScale !== 1.0 && isFinite(fScale)) {
                                    event['scale(float,float)']
                                        ? event['scale(float,float)'](fScale, fScale)
                                        : event.scale(fScale, fScale)
                                }
                                var fhx = Math.round(frag.halfW || 0) || 0
                                var fMat = (itemBatchCtx != null) ? (itemBatchCtx.hasGetMatrixFn ? event.getMatrix() : event.matrix) : null
                                if (!(fMat != null && drawBatchedGlyph(itemBatchCtx, fSeq, frag.halfW || 0, -4.5, fCol, shShdBool, fMat, fLay, fMode))) {
                                    ensureUnitCompSeq(frag)
                                    ensureFallbackBlend(event, itemBatchCtx)
                                    event.text(frag.comp, fhx, -4, fCol, shShdBool)
                                }
                            } catch (eFrag) {
                                logErrorThrottled('shatter frag draw error', eFrag)
                            } finally {
                                if (fragPushed) {
                                    try { event.pop() } catch (eFragPop) { }
                                }
                            }
                        }
                    }
                } else {
                    var defOutMod = item.outlineMode || 'none'
                    var defOutCol = item.outlineColor != null ? item.outlineColor : -1
                    var defOutWid = item.outlineWidth || 0.75
                    var rCtx = prepareItemRenderCtx(event, item, itemBatchCtx, defOutMod, defOutCol, defOutWid, inFade, fadeProgress)
                    if (rCtx != null) {
                    if (usePerCharRoute) {
                        var charFrags = getOrBuildCharShakeCache(item, item.titleLines, item.subLines, titleLineCount, startY, lineStep, fontObj)
                        var charUnits = item.charShakeUnits || charFrags
                        var maxAbsSc  = max2(Math.abs(scaleX), Math.abs(scaleY))
                        var offPadPx  = 18.0 + ((defOutMod !== 'none' ? clampNum(defOutWid, 0.25, 2.5) : 0.0) + 8.0) * maxAbsSc
                        var lastVisCf = null
                        var sharedTiming = prepareSharedCharShakeTiming(item, age, charFrags)

                        if ((item.debug || CONFIG.debug) && !item._debugLogged && charFrags.length > 0) {
                            item._debugLogged = true
                            var dbg0 = charFrags[0]
                            var dbgOff = sampleCharShakeOffset(dbg0, age, item.shakeAmp || 0.65, item, { dx: 0.0, dy: 0.0, rotDeg: 0.0 }, sharedTiming)
                            console.info('[ScreenDanmakuClient DEBUG] frags=' + charFrags.length +
                                ' units=' + charUnits.length +
                                ' shared=' + Boolean(sharedTiming && sharedTiming.canShare) +
                                ' shownVis=' + shownVis +
                                ' age=' + age +
                                ' amp=' + item.shakeAmp +
                                ' p=' + dbg0.periodMs +
                                ' seed=' + dbg0.cSeed +
                                ' win=' + item.charShakeWin +
                                ' shakeStyle=' + (item.charShakeStyle || 'omni') +
                                ' shift=(' + item.charShakeShiftX + ',' + item.charShakeShiftY + ')' +
                                ' sway=(' + item.charShakeSwayX + ',' + item.charShakeSwayY + ')' +
                                ' rotDeg=' + item.charShakeRotDeg +
                                ' raw0=' + JSON.stringify(dbg0.rawText) +
                                ' off=(' + dbgOff.dx + ',' + dbgOff.dy + ',' + dbgOff.rotDeg + ')' +
                                ' outMode=' + defOutMod + ' col=' + dbg0.color)
                        }

                        var baseShakeAmp = item.shakeAmp || 0.65
                        var activeShake  = curShake > 0 ? curShake : baseShakeAmp
                        var visRange     = findVisibleUnitRange(charUnits, startSkipVis, keepEndVis)
                        var groupPasses  = rCtx.canGroupPasses
                        var passCount    = 0
                        for (var uIdx = visRange.lo; uIdx < visRange.hi; uIdx++) {
                            var unit = charUnits[uIdx]
                            if (unit.isMerged) {
                                if (startSkipVis <= unit.visStart && keepEndVis >= unit.visEnd) {
                                    lastVisCf = unit
                                    if (!isUnitOutOfViewport(unit.baseX + unit.w * 0.5, unit.baseY + 4.0, unit.w * 0.5 + 4.0, 6.0, px, py, mxx, mxy, myx, myy, sw, sh, offPadPx)) {
                                        if (groupPasses) {
                                            passCount = pushPassUnitSlot(passCount, unit, unit.baseX, unit.baseY, 0.0, rCtx)
                                        } else {
                                            drawRichUnit(rCtx, unit, unit.baseX, unit.baseY, 0.0)
                                        }
                                    }
                                } else {
                                    var subFrags = unit.subFrags
                                    for (var sfIdx = 0; sfIdx < subFrags.length; sfIdx++) {
                                        var cfSub = subFrags[sfIdx]
                                        if (cfSub.visIndex < startSkipVis) continue
                                        if (cfSub.visIndex >= keepEndVis) break
                                        lastVisCf = cfSub
                                        if (cfSub.isBlank) continue
                                        if (isUnitOutOfViewport(cfSub.baseX + cfSub.w * 0.5, cfSub.baseY + 4.0, cfSub.w * 0.5 + 4.0, 6.0, px, py, mxx, mxy, myx, myy, sw, sh, offPadPx)) {
                                            continue
                                        }
                                        if (groupPasses) {
                                            passCount = pushPassUnitSlot(passCount, cfSub, cfSub.baseX, cfSub.baseY, 0.0, rCtx)
                                        } else {
                                            drawRichUnit(rCtx, cfSub, cfSub.baseX, cfSub.baseY, 0.0)
                                        }
                                    }
                                }
                                continue
                            }

                            var cf = unit
                            if (cf.visIndex < startSkipVis || cf.visIndex >= keepEndVis) continue
                            lastVisCf = cf
                            if (cf.isBlank) continue

                            var unitSc = (cf.charScale != null && cf.charScale > 0) ? cf.charScale : 1.0
                            if (isUnitOutOfViewport(cf.baseX + cf.w * 0.5, cf.baseY + 4.0, cf.w * 0.5 * unitSc + 6.0, 6.0 * unitSc + 6.0, px, py, mxx, mxy, myx, myy, sw, sh, offPadPx)) {
                                continue
                            }

                            var shouldShakeChar = (cf.shakeFlag === 1) || (isPerCharShake && cf.shakeFlag !== -1)
                            var offDx  = 0.0
                            var offDy  = 0.0
                            var offRot = 0.0
                            if (shouldShakeChar) {
                                sampleCharShakeOffset(cf, age, activeShake, item, CHAR_OFFSET_SCRATCH, sharedTiming)
                                offDx  = CHAR_OFFSET_SCRATCH.dx
                                offDy  = CHAR_OFFSET_SCRATCH.dy
                                offRot = CHAR_OFFSET_SCRATCH.rotDeg
                            }
                            if (groupPasses) {
                                passCount = pushPassUnitSlot(passCount, cf, cf.baseX + offDx, cf.baseY + offDy, offRot, rCtx)
                            } else {
                                drawRichUnit(rCtx, cf, cf.baseX + offDx, cf.baseY + offDy, offRot)
                            }
                        }

                        if (groupPasses && passCount > 0) {
                            if (passCount === 1) {
                                var p0 = PASS_UNIT_SCRATCH[0]
                                drawRichUnit(rCtx, p0.unit, p0.floatX, p0.floatY, p0.unitRotDeg)
                            } else {
                                drawUnitsPassGrouped(rCtx, PASS_UNIT_SCRATCH, passCount)
                            }
                        }

                        if (blinkCursor.length > 0 && lastVisCf != null) {
                            drawTypewriterCursor(
                                rCtx,
                                item,
                                blinkCursor,
                                lastVisCf.baseX + lastVisCf.w + (itemSpacing || 0),
                                lastVisCf.baseY,
                                lastVisCf.color
                            )
                        }
                    } else {
                        var lCache            = item._lineRenderCache
                        var needCursorMeasure = (item.typewriter && !inFade && shownVis < item.totalVis && item.totalVis > 0)
                        if (lCache == null ||
                            lCache.wrapKey !== curWrapKey ||
                            lCache.skipVis !== startSkipVis ||
                            lCache.keepVis !== keepEndVis ||
                            lCache.startY !== startY ||
                            (needCursorMeasure && lCache.cursorAnchor == null)) {
                            var titleSkip = min2(item.titleVis, startSkipVis)
                            var titleKeep = min2(item.titleVis, keepEndVis)
                            var subSkip   = max2(0, startSkipVis - item.titleVis)
                            var subKeep   = max2(0, keepEndVis - item.titleVis)

                            var renderTitleLines = buildRenderedLines(item.titleLines, titleSkip, titleKeep, '', fontObj, itemSpacing, itemSpacingMode, needCursorMeasure)
                            var renderSubLines   = buildRenderedLines(item.subLines, subSkip, subKeep, '', fontObj, itemSpacing, itemSpacingMode, needCursorMeasure)

                            var tItems = []
                            for (var tIdx = 0; tIdx < renderTitleLines.length; tIdx++) {
                                var rLine1 = renderTitleLines[tIdx]
                                var isTrans1 = Boolean(rLine1.isTransient)
                                var tEntryShared = getCachedTextCompSeq(rLine1.text, false, isTrans1)
                                var tBaseX = -Math.floor((rLine1.fullW || 0) * 0.5)
                                var tFullW = rLine1.fullW || 0
                                tItems.push({
                                    rawText:      tEntryShared.rawText,
                                    comp:         tEntryShared.comp,
                                    seq:          tEntryShared.seq,
                                    _isTransient: isTrans1,
                                    x:            tBaseX + (rLine1.offsetPx || 0),
                                    endX:         tBaseX + (rLine1.endPx || 0),
                                    y:            startY + (rLine1.lineIndex || 0) * lineStep,
                                    w:            tFullW,
                                    color:        0xFF5555,
                                    charScale:    1.0,
                                    outlineMode:  '',
                                    outlineColor: -1,
                                    _muiLayout:   tEntryShared._muiLayout,
                                    _muiEpoch:    tEntryShared._muiEpoch,
                                    _muiHasEmoji: tEntryShared._muiHasEmoji
                                })
                            }
                            var sItems = []
                            for (var sIdx = 0; sIdx < renderSubLines.length; sIdx++) {
                                var rLine2 = renderSubLines[sIdx]
                                var isTrans2 = Boolean(rLine2.isTransient)
                                var sEntryShared = getCachedTextCompSeq(rLine2.text, false, isTrans2)
                                var sBaseX = -Math.floor((rLine2.fullW || 0) * 0.5)
                                var sFullW = rLine2.fullW || 0
                                sItems.push({
                                    rawText:      sEntryShared.rawText,
                                    comp:         sEntryShared.comp,
                                    seq:          sEntryShared.seq,
                                    _isTransient: isTrans2,
                                    x:            sBaseX + (rLine2.offsetPx || 0),
                                    endX:         sBaseX + (rLine2.endPx || 0),
                                    y:            startY + (titleLineCount + (rLine2.lineIndex || 0)) * lineStep,
                                    w:            sFullW,
                                    color:        0xFFCC44,
                                    charScale:    1.0,
                                    outlineMode:  '',
                                    outlineColor: -1,
                                    _muiLayout:   sEntryShared._muiLayout,
                                    _muiEpoch:    sEntryShared._muiEpoch,
                                    _muiHasEmoji: sEntryShared._muiHasEmoji
                                })
                            }
                            var cursorAnchor = null
                            if (needCursorMeasure) {
                                if (shownVis <= item.titleVis) {
                                    if (tItems.length > 0) {
                                        var lastT = tItems[tItems.length - 1]
                                        cursorAnchor = { x: lastT.endX, y: lastT.y, isSub: false }
                                    }
                                } else if (sItems.length > 0) {
                                    var lastS = sItems[sItems.length - 1]
                                    cursorAnchor = { x: lastS.endX, y: lastS.y, isSub: true }
                                }
                            }
                            var lineCacheKey = curWrapKey + '|s:' + startSkipVis + '|k:' + keepEndVis + '|y:' + startY
                            lCache = {
                                key:          lineCacheKey,
                                wrapKey:      curWrapKey,
                                skipVis:      startSkipVis,
                                keepVis:      keepEndVis,
                                startY:       startY,
                                tItems:       tItems,
                                sItems:       sItems,
                                cursorAnchor: cursorAnchor
                            }
                            item._lineRenderCache = lCache
                        }

                        var rawMainCol = (item.color != null && isFinite(item.color)) ? Math.round(item.color) : 0xFF5555
                        var rawSubCol  = (item.subColor != null && isFinite(item.subColor)) ? Math.round(item.subColor) : 0xFFCC44

                        if (rCtx.canGroupPasses && (lCache.tItems.length + lCache.sItems.length) > 1) {
                            var staticPassCount = 0
                            for (var tiG = 0; tiG < lCache.tItems.length; tiG++) {
                                var tEnG = lCache.tItems[tiG]
                                tEnG.color = rawMainCol
                                staticPassCount = pushPassUnitSlot(staticPassCount, tEnG, tEnG.x, tEnG.y, 0.0, rCtx)
                            }
                            for (var siG = 0; siG < lCache.sItems.length; siG++) {
                                var sEnG = lCache.sItems[siG]
                                sEnG.color = rawSubCol
                                staticPassCount = pushPassUnitSlot(staticPassCount, sEnG, sEnG.x, sEnG.y, 0.0, rCtx)
                            }
                            drawUnitsPassGrouped(rCtx, PASS_UNIT_SCRATCH, staticPassCount)
                        } else {
                            for (var ti = 0; ti < lCache.tItems.length; ti++) {
                                var tEntry = lCache.tItems[ti]
                                tEntry.color = rawMainCol
                                drawRichUnit(rCtx, tEntry, tEntry.x, tEntry.y, 0.0)
                            }
                            for (var si = 0; si < lCache.sItems.length; si++) {
                                var sEntry = lCache.sItems[si]
                                sEntry.color = rawSubCol
                                drawRichUnit(rCtx, sEntry, sEntry.x, sEntry.y, 0.0)
                            }
                        }
                        if (blinkCursor.length > 0 && lCache.cursorAnchor != null) {
                            var ca = lCache.cursorAnchor
                            drawTypewriterCursor(
                                rCtx,
                                item,
                                blinkCursor,
                                ca.x,
                                ca.y,
                                ca.isSub ? rawSubCol : rawMainCol
                            )
                        }
                    }
                    }
                }
                item.drawErrors = 0
            } catch (eDraw) {
                item.drawErrors = (item.drawErrors || 0) + 1
                logErrorThrottled('paintScreen draw error', eDraw)
                if (item.drawErrors >= CONFIG.maxItemDrawErrors) {
                    var rmIdx = activeOverlays.indexOf(item)
                    if (rmIdx >= 0) activeOverlays.splice(rmIdx, 1)
                }
            } finally {
                if (ITEM_POSE_SCRATCH.pushed) {
                    ITEM_POSE_SCRATCH.pushed = false
                    try { event.pop() } catch (ePop) { }
                }
                ITEM_POSE_SCRATCH.needed = false
            }
            }
        } finally {
            for (var postExpIdx = activeOverlays.length - 1; postExpIdx >= 0; postExpIdx--) {
                if (now >= activeOverlays[postExpIdx].expire && activeOverlays[postExpIdx].lifeMode === 'screen_session') {
                    activeOverlays.splice(postExpIdx, 1)
                }
            }
            if (!anyGuiReplaceMatch && Object.keys(REPLACED_TEXTURE_REGISTRY).length > 0) {
                restoreAllReplacedTextures()
            }
            flushBatchedBeforeImmediate()
            ACTIVE_FRAME_BATCH_CTX = null
            ACTIVE_FRAME_EVENT     = null
            GRAPHICS_TEXT_DIRTY    = false
            DRAW_ORDER_SCRATCH.length = 0
            ITEM_RENDER_CTX_SCRATCH.event       = null
            ITEM_RENDER_CTX_SCRATCH.batchCtx    = null
            ITEM_RENDER_CTX_SCRATCH.baseItemMat = null
            flushFrameBatchCtx(batchCtx)
            if (batchCtx != null && batchCtx.needBlendRestore) {
                if (HAS_EVENT_BLEND) event.blend(false)
                batchCtx.needBlendRestore = false
            }
        }
    })
})()
