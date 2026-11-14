// ============================================================================
//  通用屏幕弹幕与泛用文本显示组件 —— 客户端渲染引擎 (ScreenDanmakuClient v5.2)
//  所属系列：Epiphy的-通用组件系列（本系列包含 startup / server / client 配套脚本）
//  [LLM 协作规范] 每次进行较大修改或重构前，请先将修改同步至 D:\Git-Epiphy 并执行 git commit 保存当前可用状态，便于随时回退与对比 diff。
//  许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
//  放置位置：kubejs/client_scripts/通用组件/Epiphy的-屏幕弹幕渲染器.js
//  配套服务端组件：
//    - kubejs/server_scripts/通用组件/Epiphy的-屏幕弹幕组件.js（服务端调度器 ScreenDanmaku v5.2）
//    - kubejs/server_scripts/通用组件/Epiphy的-权限阀.js（/epiphy 指令注册中心与权限阀）
//
//  依赖与缺失降级：
//    - 可选前置：kubejs/startup_scripts/通用组件/Epiphy的-Spec与通用工具.js (EpiphySpec / EpiphyProtocol, priority: 1200)
//      缺失时启动输出 console.warn 并降级至内置 v5 协议常量与精简数值/布尔工具；收包仍严格执行 fail-closed 版本校验。
//    - 必需配套：kubejs/server_scripts/通用组件/Epiphy的-屏幕弹幕组件.js（缺失时客户端处于待命状态，无弹幕数据包驱动）
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
//  [Rhino 语法兼容性约定] KubeJS 2001.6.x 内置 Rhino 对 ES6 支持不完整且存在语义偏差（如 `let`/`const`
//    块级绑定/TDZ 行为偏差，且部分新特性在每帧 Java 互操作热路径下存在额外开销）。故本渲染器坚持 ES5 + `var`
//    写法；同系列音频客户端播放器则使用经实测稳定的 ES6 子集（`=>` / 模板字符串 / `for..of`）。请勿引入 `let`/`const`。
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
    var PROTO_VERSION = (PROTO && PROTO.DANMAKU_PROTO_VERSION) || 5

    // 统一配置常量表（消除散落魔法数）
    var CONFIG = {
        maxOverlays:                  120,
        maxPlayerOverlaysPerNamespace: 16,    // 单个玩家指令命名空间 (u:<uuid>) 同屏最多保留条数
        maxPendingActions:            256,    // 未消费入队动作上限（防单帧包洪泛 OOM）
        maxPendingPerFrame:           64,     // 单帧最多消费入队动作数
        frameBudgetMs:                12.0,   // 单帧弹幕渲染耗时预算 (ms)
        maxTitleChars:                2048,   // 客户端主标题安全截断长度
        maxSubChars:                  1024,   // 客户端副标题安全截断长度
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
        debug:                 false   // 是否输出逐字渲染调试日志（也可通过单条 debug: true 或 setDebug(true) 开启）
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
    var CACHED_FONT             = null
    var FONT_SIGNATURE          = ''
    var LAST_FONT_CHECK_MS      = -99999
    var GLYPH_WIDTH_MAP         = {}
    var GLYPH_CACHE_SIZE        = 0
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
    var MUI_CANARY_LAYOUT       = null
    var MUI_EPOCH               = 0
    var CHAR_OFFSET_SCRATCH     = { dx: 0.0, dy: 0.0, rotDeg: 0.0 }
    var SHAKE_VEC_SCRATCH       = { x: 0.0, y: 0.0 }
    var FRAME_BATCH_CTX         = null

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
        low: 1, minor: 1, '低': 1, '次要': 1,
        normal: 2, medium: 2, default: 2, '中': 2, '普通': 2,
        high: 3, major: 3, important: 3, '高': 3, '重要': 3,
        critical: 4, fatal: 4, urgent: 4, boss: 4, '极高': 4, '致命': 4,
        active: 5, sustain: 5, '持续': 5
    }
    var min2     = (SPEC && typeof SPEC.min2 === 'function') ? SPEC.min2 : function (a, b) { return a < b ? a : b }
    var max2     = (SPEC && typeof SPEC.max2 === 'function') ? SPEC.max2 : function (a, b) { return a > b ? a : b }
    var clampNum = (SPEC && typeof SPEC.clampNum === 'function')
        ? SPEC.clampNum
        : function (v, lo, hi, defVal) {
            if (v === null || v === undefined || v === '' || typeof v === 'boolean' || Array.isArray(v)) {
                return defVal !== undefined ? defVal : lo
            }
            var n = Number(v)
            if (isNaN(n) || !isFinite(n)) return defVal !== undefined ? defVal : lo
            return n < lo ? lo : (n > hi ? hi : n)
        }

    function parsePriority(val, defVal) {
        if (SPEC && typeof SPEC.parsePriority === 'function') {
            return SPEC.parsePriority(val, defVal, { map: PRIORITY_MAP, min: 0, max: 10, round: true })
        }
        if (val === undefined || val === null || val === '') return defVal
        var key = String(val).trim().toLowerCase()
        if (PRIORITY_MAP[key] !== undefined) return PRIORITY_MAP[key]
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
        return isFinite(n) && n === Number(expectedVer)
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
                GLYPH_WIDTH_MAP  = {}
                GLYPH_CACHE_SIZE = 0
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
               (code >= 0x0300 && code <= 0x036F) ||
               (code >= 0x3099 && code <= 0x309A) ||
               code === 0x20E3 ||
               code === 0x200D
    }
    function isSkinToneModifierPair(high, low) {
        return high === 0xD83C && low >= 0xDFFB && low <= 0xDFFF
    }

    function readGraphemeCluster(str, startIdx) {
        var len = str.length
        var i   = startIdx
        var out = ''

        if (i < len) {
            var code = str.charCodeAt(i)
            if (isHighSurrogate(code) && (i + 1) < len && isLowSurrogate(str.charCodeAt(i + 1))) {
                out += str.charAt(i) + str.charAt(i + 1)
                i += 2
            } else {
                out += str.charAt(i)
                i += 1
            }

            while (i < len) {
                var c = str.charCodeAt(i)
                if (isGraphemeExtendCode(c)) {
                    out += str.charAt(i)
                    i += 1
                    continue
                }
                if (isHighSurrogate(c) && (i + 1) < len && isSkinToneModifierPair(c, str.charCodeAt(i + 1))) {
                    out += str.charAt(i) + str.charAt(i + 1)
                    i += 2
                    continue
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

    function measureClusterWidthPx(cluster, isBold, fontObj) {
        if (!cluster || cluster.length === 0) return 0
        var f = fontObj || getClientFont(null)
        if (f != null) {
            var cacheKey = (isBold ? '1:' : '0:') + cluster
            var cached   = GLYPH_WIDTH_MAP[cacheKey]
            if (cached !== undefined && isFinite(cached)) return cached
            var probe = isBold ? ('§l' + cluster) : cluster
            var w = invokeFontWidth(f, probe)
            if (isFinite(w) && w >= 0) {
                if (GLYPH_CACHE_SIZE > CONFIG.glyphCacheLimit) {
                    GLYPH_WIDTH_MAP  = {}
                    GLYPH_CACHE_SIZE = 0
                }
                GLYPH_WIDTH_MAP[cacheKey] = w
                GLYPH_CACHE_SIZE++
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

    function hasRichSpanTags(str) {
        if (!str || str.length < 3) return false
        if (str.indexOf('<') < 0 && str.indexOf('{') < 0) return false
        return /(?:<|\{)\/?(?:b|bold|big|scale|shake|noshake|outline|glow)\b/i.test(str)
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

    function wrapStyledTextLines(str, maxLineWidthPx, fontObj, letterSpacingPx, spacingMode) {
        if (!str || str.length === 0) return []
        var checkTags   = hasRichSpanTags(str)
        var spacing     = (letterSpacingPx != null && isFinite(letterSpacingPx)) ? Number(letterSpacingPx) : 0
        var rawParts    = String(str).split(/\r?\n/)
        var lines       = []
        var activeColor = ''
        var activeFmt   = ''
        var isBold      = false
        var tagState    = { tagBold: false, charScale: 1.0, shakeFlag: 0, outlineMode: '', outlineColor: -1 }

        for (var p = 0; p < rawParts.length; p++) {
            var seg = rawParts[p]
            if (seg.length === 0) {
                lines.push({ text: '', widthPx: 0, vis: 0, empty: true, hasTags: false })
                continue
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

    function hashUnit(seed) {
        var x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453
        return x - Math.floor(x)
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
                            x:            pendingX,
                            w:            pendingW,
                            visIndex:     pendingVisIndex,
                            charScale:    pendingScale,
                            shakeFlag:    pendingShakeFlag,
                            outlineMode:  pendingOutMode,
                            outlineColor: pendingOutCol
                        })
                        pendingText  = ''
                        pendingW     = 0
                        pendingCount = 0
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
                        x:            pendingX,
                        w:            pendingW,
                        visIndex:     pendingVisIndex,
                        charScale:    pendingScale,
                        shakeFlag:    pendingShakeFlag,
                        outlineMode:  pendingOutMode,
                        outlineColor: pendingOutCol
                    })
                    pendingText  = ''
                    pendingW     = 0
                    pendingCount = 0
                }
                curX += cw + charSp
                visOffset++
                i = g.nextIndex
                continue
            }

            if (pendingCount === 0) {
                pendingText      = fmtPref + g.cluster
                pendingX         = curX
                pendingW         = cw
                pendingVisIndex  = visOffset
                pendingScale     = tagState.charScale
                pendingShakeFlag = tagState.shakeFlag
                pendingOutMode   = tagState.outlineMode
                pendingOutCol    = tagState.outlineColor
                pendingCount     = 1
            } else {
                pendingText += g.cluster
                pendingW    += cw + charSp
                pendingCount++
            }
            curX += cw + charSp
            visOffset++
            i = g.nextIndex

            if (pendingCount >= maxClusterPerFrag) {
                frags.push({
                    text:         pendingText,
                    x:            pendingX,
                    w:            pendingW,
                    visIndex:     pendingVisIndex,
                    charScale:    pendingScale,
                    shakeFlag:    pendingShakeFlag,
                    outlineMode:  pendingOutMode,
                    outlineColor: pendingOutCol
                })
                pendingText  = ''
                pendingW     = 0
                pendingCount = 0
            }
        }
        if (pendingCount > 0) {
            frags.push({
                text:         pendingText,
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
            if (eng == null || typeof eng.lookupFormattedLayout !== 'function') return false
            if (MUI_CANARY_SEQ == null && typeof Text !== 'undefined' && Text != null && typeof Text.of === 'function') {
                MUI_CANARY_SEQ = resolveVisualSeq(Text.of('A'))
            }
            if (MUI_CANARY_SEQ == null) return false
            // 验证 2 参重载 (FormattedCharSequence, int) 在 Rhino 中无二义性（Style 未注册 TypeWrapper）
            var probeLayout = eng.lookupFormattedLayout(MUI_CANARY_SEQ, 0)
            if (probeLayout == null || typeof probeLayout.drawText !== 'function') return false
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
            MUI_ENGINE        = null
            MUI_RENDERER      = null
            MUI_CANARY_LAYOUT = null
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
            var matItem = null
            var matUnit = null
            var matOut  = null
            var matFg   = null
            if (Matrix4fClass != null) {
                try {
                    matItem = new Matrix4fClass()
                    matUnit = new Matrix4fClass()
                    matOut  = new Matrix4fClass()
                    matFg   = new Matrix4fClass()
                } catch (eM) {
                    matItem = null
                    matUnit = null
                    matOut  = null
                    matFg   = null
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
                font:            null,
                drawFn:          null,
                useDirectSrgDraw:false,
                graphics:        gfx,
                bufSrc:          bufSrc,
                displayMode:     modeNormal,
                muiActive:       false,
                muiRetryAtMs:    0,
                muiEngine:       MUI_ENGINE,
                muiRenderer:     MUI_RENDERER,
                muiAllowSdf:     true,
                muiEmojiSheet:   emojiSheet,
                muiEndBatchFn:   null,
                canDirectMatrix: canDirect,
                baseFrameMat:    null,
                _itemScratch:    matItem,
                itemMat:         null,
                unitMat:         matUnit,
                outMat:          matOut,
                fgMat:           matFg,
                drawn:           0,
                nowMs:           now || 0,
                needBlendRestore:false,
                prevBlend:       null
            }
        }

        var ctx = FRAME_BATCH_CTX
        ctx.graphics         = gfx
        ctx.bufSrc           = bufSrc
        ctx.drawn            = 0
        ctx.nowMs            = now || 0
        ctx.baseFrameMat     = null
        ctx.itemMat          = null
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

        if (ctx.muiActive && MUI_CANARY_SEQ != null) {
            try {
                var curCanary = ctx.muiEngine.lookupFormattedLayout(MUI_CANARY_SEQ, 0)
                if (!isSameJavaRef(curCanary, MUI_CANARY_LAYOUT)) {
                    MUI_CANARY_LAYOUT = curCanary
                    MUI_EPOCH++
                }
                if (ModernTextRendererClass != null) {
                    ctx.muiAllowSdf = (ModernTextRendererClass.sAllowSDFTextIn2D !== false)
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
        if (batchCtx == null || !batchCtx.muiActive || seq == null) return null
        var now = batchCtx.nowMs
        if (ownerObj != null && ownerObj._muiLayout != null && ownerObj._muiEpoch === MUI_EPOCH && (now - (ownerObj._muiCheckMs || 0)) < 15000) {
            return ownerObj._muiLayout
        }
        try {
            var layout = batchCtx.muiEngine.lookupFormattedLayout(seq, 0)
            if (ownerObj != null && layout != null) {
                ownerObj._muiLayout   = layout
                ownerObj._muiEpoch    = MUI_EPOCH
                ownerObj._muiHasEmoji = (typeof layout.hasColorEmoji === 'function') ? Boolean(layout.hasColorEmoji()) : false
                // 按字符序号错峰刷新，避免多字在同一帧集中到期刷新导致抖动
                var staggerMs = ((ownerObj.visIndex || 0) & 15) * 60
                ownerObj._muiCheckMs = now - staggerMs
            }
            return layout
        } catch (eLookup) {
            markMuiDegraded(batchCtx)
            logErrorThrottled('ModernUI lookupFormattedLayout fallback', eLookup)
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
            if (a <= 2) a = 255
            var allowShadow = Boolean(shadow) && (ModernTextRendererClass == null || ModernTextRendererClass.sAllowShadow !== false)
            if (allowShadow) {
                // TextLayout.drawText 第 9 参是 isShadow（是否为阴影层），非 dropShadow；
                // 必须先以 RGB 右移 2 位 (25% 亮度) + isShadow=true 绘制阴影，再沿 +Z (+0.03) 以 isShadow=false 绘制全亮度主字。
                layout.drawText(mat, batchCtx.bufSrc, x, y, r >>> 2, g >>> 2, b >>> 2, a, true, drawMode, false, 1.0, 0, 15728880)
                var fgMat = mat
                if (batchCtx.fgMat != null && typeof batchCtx.fgMat.set === 'function' && typeof batchCtx.fgMat.translate === 'function') {
                    batchCtx.fgMat.set(mat)
                    batchCtx.fgMat.translate(0.0, 0.0, 0.03)
                    fgMat = batchCtx.fgMat
                }
                layout.drawText(fgMat, batchCtx.bufSrc, x, y, r, g, b, a, false, drawMode, false, 1.0, 0, 15728880)
                batchCtx.drawn += 2
            } else {
                layout.drawText(mat, batchCtx.bufSrc, x, y, r, g, b, a, false, drawMode, false, 1.0, 0, 15728880)
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
                    var rfComp = Text.of(rf.text)
                    list.push({
                        comp:       rfComp,
                        seq:        resolveVisualSeq(rfComp),
                        color:      grp.color,
                        cx:         rf.x + rf.w * 0.5,
                        cy:         baseY + 4.5,
                        halfW:      -rf.w * 0.5,
                        vanishAt:   vanishAt,
                        invVanish:  1.0 / vanishAt,
                        vx:         Math.cos(dirRad) * spd,
                        vy:         Math.sin(dirRad) * spd * 0.75,
                        rotMax:     rotMax,
                        phaseShift: fragSeq * 23
                    })
                }
            }
        }
        item.shatterCacheKey = cacheKey
        item.shatterFrags    = list
        return list
    }

    // 构建逐字渲染缓存（按完整折行文本一次性构建，打字机推进时零重建）：
    //   仅在开启 per_char 震动、字间距 letterSpacing != 0、外圈 outlineMode != 'none' 或含局部富文本标签时使用。
    function getOrBuildCharShakeCache(item, titleLines, subLines, titleLineCount, startY, lineStep, fontObj) {
        var minMs = max2(60, item.shakeFreqMin || CONFIG.charShakeDefaultMinMs)
        var maxMs = max2(minMs, item.shakeFreqMax || CONFIG.charShakeDefaultMaxMs)
        var isUnifiedFreq = (Math.abs(maxMs - minMs) <= 5)
        var cacheKey = item.wrapKey + '|f:' + minMs + '-' + maxMs + '|c:' + item.color + ':' + item.subColor + '|ls:' + (item.letterSpacing || 0)
        if (item.charShakeCacheKey === cacheKey && item.charShakeFrags != null) {
            return item.charShakeFrags
        }
        var baseSeed  = item.shakeSeed || 37.0
        var fragSeq   = 0
        var visSeq    = 0
        var list      = []
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
                var rawFrags = splitLineIntoFragments(ln.text, 0, ln.widthPx, fontObj, 1, item.letterSpacing, item.letterSpacingMode)
                for (var fIdx = 0; fIdx < rawFrags.length; fIdx++) {
                    var rf = rawFrags[fIdx]
                    fragSeq++
                    var cSeed    = baseSeed + fragSeq * 31.73 + lIdx * 11.19
                    var periodMs = isUnifiedFreq
                        ? minMs
                        : (minMs + hashUnit(cSeed + 0.7) * max2(1, maxMs - minMs))
                    // 当 minMs === maxMs（如 [rnfmabj-测试] 要求统一 0.8s 震动一次）时，统一相位 0，使所有字同步触发抖动但方向各异
                    var phaseOff = isUnifiedFreq ? 0.0 : (hashUnit(cSeed + 1.9) * 10.0)
                    var cfComp = Text.of(rf.text)
                    var rawTxt = rf.text || ''
                    var isBlankFrag = (rawTxt.length > 0 && rawTxt.indexOf('§') < 0 && /^\s+$/.test(rawTxt))
                    list.push({
                        comp:         cfComp,
                        seq:          resolveVisualSeq(cfComp),
                        rawText:      rawTxt,
                        isBlank:      isBlankFrag,
                        color:        grp.color,
                        baseX:        rf.x,
                        baseY:        baseY,
                        w:            rf.w,
                        visIndex:     visSeq + (rf.visIndex != null ? rf.visIndex : fIdx),
                        charScale:    rf.charScale || 1.0,
                        shakeFlag:    rf.shakeFlag || 0,
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
                        _muiLayout:   null,
                        _muiEpoch:    -1,
                        _muiCheckMs:  0
                    })
                }
                visSeq += (ln.vis != null ? ln.vis : countVisibleChars(ln.text))
            }
        }
        item.charShakeCacheKey = cacheKey
        item.charShakeFrags    = list
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

    // 计算单字在当前时刻的独立微抖动偏移（完全由样式参数控制，绝不在渲染器内写死单一效果）：
    //   - 'horizontal_step'：每 periodMs 触发 1 次轻微随机落点位移 (charShakeShift) + 初段水平/垂直阻尼晃动 (charShakeSwayX/Y, charShakeWin)
    //   - 'smooth'         ：按 periodMs 做连续双谐波平滑漂移
    //   - 'omni' (默认)    ：全向随机脉冲轻颤 + 极微弱残余偏移
    function sampleCharShakeOffset(cf, ageMs, curAmp, item, outObj) {
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
        var invPer  = (cf != null && cf.invPeriod > 0) ? cf.invPeriod : (1.0 / max2(60, Number(cf && cf.periodMs) || 800))
        var ageN    = (ageMs >= 0 && isFinite(ageMs)) ? ageMs : 0.0
        var cyc     = (ageN * invPer) + ((cf != null && cf.phaseOff) ? cf.phaseOff : 0.0)
        var stepIdx = Math.floor(cyc)
        var frac    = cyc - stepIdx
        var seed    = (cf != null && cf.cSeed) ? cf.cSeed : 1.0
        var cfg     = getCharShakeConfig(item)

        var rawDx     = 0.0
        var rawDy     = 0.0
        var rawRotDeg = 0.0

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
                var shiftT = frac / cfg.transWin
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
                var u    = frac / cfg.swayWin
                var wave = Math.sin(u * PI * 2.5) * (1.0 - u)
                rawDx += dirSignX * wave * effAmp * cfg.swayXScale
                rawDy += dirSignY * wave * effAmp * cfg.swayYScale
                if (cfg.rotDegAmp > 0) {
                    rawRotDeg += dirSignX * wave * cfg.rotDegAmp * 0.55
                }
            }
            if (cfg.swayXScale !== 0) {
                rawDx += Math.sin(frac * PI * 2.0 + seed) * 0.10 * cfg.swayXScale * effAmp
            }
            if (cfg.swayYScale !== 0) {
                rawDy += Math.cos(frac * PI * 2.0 + seed * 1.3) * 0.10 * cfg.swayYScale * effAmp
            }
        } else if (cfg.styleCode === 2) {
            var phase = cyc * PI * 2.0
            var nx = Math.sin(phase + seed * 1.73) * 0.72 + Math.cos(phase * 0.53 + seed * 3.11) * 0.28
            var ny = Math.cos(phase * 0.87 + seed * 2.37) * 0.72 + Math.sin(phase * 0.47 + seed * 4.19) * 0.28
            rawDx = nx * effAmp * 0.95
            rawDy = ny * effAmp * 1.15
        } else {
            var theta
            if (cf != null) {
                if (cf._oStepIdx !== stepIdx || cf._oSeed !== seed) {
                    cf._oStepIdx = stepIdx
                    cf._oSeed    = seed
                    cf._oTheta   = hashUnit(stepIdx * 19.37 + seed) * PI * 2.0
                }
                theta = cf._oTheta
            } else {
                theta = hashUnit(stepIdx * 19.37 + seed) * PI * 2.0
            }
            var pulse = 0.0
            if (frac < cfg.jitterWin) {
                var pu = frac / cfg.jitterWin
                pulse = Math.sin(pu * PI * 3.0) * (1.0 - pu) * 0.85
            }
            var mag = (0.22 + pulse) * effAmp
            rawDx = Math.cos(theta) * mag * 0.78
            rawDy = Math.sin(theta) * mag * 0.92
        }

        var maxDx = CONFIG.charShakeMaxDxPx
        var maxDy = CONFIG.charShakeMaxDyPx
        dst.dx     = isFinite(rawDx) ? (rawDx < -maxDx ? -maxDx : (rawDx > maxDx ? maxDx : rawDx)) : 0.0
        dst.dy     = isFinite(rawDy) ? (rawDy < -maxDy ? -maxDy : (rawDy > maxDy ? maxDy : rawDy)) : 0.0
        dst.rotDeg = isFinite(rawRotDeg) ? rawRotDeg : 0.0
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

    // 负 Z 分层辅助：每组外圈/虚化环仅设置 1 次负 Z 矩阵，避免逐 pass 多次 translate JNI 调用
    function startOutlineZMat(batchCtx, baseMat, zStart) {
        if (batchCtx != null && batchCtx.outMat != null && baseMat != null) {
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

    function drawBatchedPassRgb(batchCtx, effSeq, preLayout, drawMode, x, y, r, g, b, byteA, packedCol, shadow, mat) {
        if (preLayout != null && batchCtx.muiActive) {
            return drawMuiLayoutPassRgb(batchCtx, preLayout, x, y, r, g, b, byteA, shadow, mat, drawMode)
        }
        return drawBatchedGlyph(batchCtx, effSeq, x, y, packedCol, shadow, mat, null, drawMode)
    }

    function drawBatchedRing(batchCtx, effSeq, preLayout, outlineMuiMode, gx, gy, mat, zOffset, dxTbl, dyTbl, rad, oR, oG, oB, byteA, oColRgb) {
        var rMat = startOutlineZMat(batchCtx, mat, zOffset)
        var packedCol = (preLayout != null && batchCtx.muiActive) ? 0 : packArgb(oColRgb, byteA)
        for (var i = 0; i < dxTbl.length; i++) {
            if (!drawBatchedPassRgb(batchCtx, effSeq, preLayout, outlineMuiMode, gx + dxTbl[i] * rad, gy + dyTbl[i] * rad, oR, oG, oB, byteA, packedCol, false, rMat)) {
                return false
            }
        }
        return true
    }

    // 合批路径外圈采样：
    //   - glow：4 向 45° 对称柔光 (0.90 * oRad, alpha ~0.41)，仅设 1 次负 Z 矩阵
    //   - stroke：8 向外环轮廓 + 大半径时 4 向内环桥接 (ModernUI SDF 模式下 1.15px 以下 8 向已无缝闭合)
    function drawBatchedOutline(batchCtx, effSeq, preLayout, outlineMuiMode, gx, gy, mat, outMode, oColRgb, oRad, baseA) {
        var oR = (oColRgb >>> 16) & 0xFF
        var oG = (oColRgb >>> 8) & 0xFF
        var oB = oColRgb & 0xFF

        if (outMode === 'glow') {
            var glowByte = Math.round(0.41 * baseA * 255)
            if (glowByte < OUTLINE_ALPHA_CUTOFF) return true
            return drawBatchedRing(batchCtx, effSeq, preLayout, outlineMuiMode, gx, gy, mat, -0.055, GLOW_4_DX, GLOW_4_DY, oRad * 0.90, oR, oG, oB, glowByte, oColRgb)
        }

        // stroke 实心描边：8 向圆周轮廓 + 较大半径时的 4 向内环桥接
        var strokeByte = Math.round(0.92 * baseA * 255)
        if (strokeByte < OUTLINE_ALPHA_CUTOFF) return true
        if (!drawBatchedRing(batchCtx, effSeq, preLayout, outlineMuiMode, gx, gy, mat, -0.045, OUTLINE_8_DX, OUTLINE_8_DY, oRad, oR, oG, oB, strokeByte, oColRgb)) {
            return false
        }
        var midThresh = (preLayout != null && batchCtx.muiActive && batchCtx.muiAllowSdf) ? 1.15 : 0.82
        if (oRad > midThresh) {
            drawBatchedRing(batchCtx, effSeq, preLayout, outlineMuiMode, gx, gy, mat, -0.018, CARDINAL_4_DX, CARDINAL_4_DY, oRad * 0.48, oR, oG, oB, strokeByte, oColRgb)
        }
        return true
    }

    function tryDrawUnitBatched(event, comp, seq, ownerObj, floatX, floatY, halfW, rgbColor, shadow, outMode, outColor, outWidth, charScale, inFade, isBlurFade, isSplitFade, fadeProgress, hasUnitRot, baseA, invP, batchCtx) {
        if (batchCtx == null || BATCH_FAILED) return false
        var effSeq = seq || resolveVisualSeq(comp)
        if (effSeq == null) return false

        var preLayout = resolveUnitMuiLayout(batchCtx, effSeq, ownerObj)
        if (preLayout != null && batchCtx.muiActive) {
            flushEmojiSheetIfNeeded(batchCtx, preLayout, ownerObj)
        }

        var sc = (charScale != null && isFinite(charScale) && charScale > 0.2) ? charScale : 1.0
        var hasUnitScale = (Math.abs(sc - 1.0) > 0.01)
        var needUnitTransform = (hasUnitScale || hasUnitRot)
        var hasAnyOutline = (outMode === 'stroke' || outMode === 'glow')
        // 统一让同字符的外圈与主体沿用 SDF(1)（当启用外圈/旋转/虚化时），防止 BufferSource 在外圈与主体间来回切换 RenderType 触发断批冲洗
        var outlineMuiMode = batchCtx.muiAllowSdf ? 1 : 0
        var baseItemMat = batchCtx.itemMat || ((typeof event.getMatrix === 'function') ? event.getMatrix() : event.matrix)
        if (baseItemMat == null) return false

        if (isSplitFade) {
            var haloBellS    = Math.sin(clampNum(fadeProgress, 0.05, 0.95) * PI)
            var haloAlphaS   = clampNum(Math.round((invP * 0.72 + haloBellS * 0.28) * 72), 5, 96)
            var coreEffByteS = clampNum(Math.round(baseA * 245 + 6), 5, 255)
            var spreadPxS    = 0.65 + fadeProgress * 2.85
            if (haloAlphaS >= OUTLINE_ALPHA_CUTOFF) {
                var hColB = packArgb(rgbColor, haloAlphaS)
                var hMatS = startOutlineZMat(batchCtx, baseItemMat, -0.024)
                if (!drawBatchedGlyph(batchCtx, effSeq, floatX - spreadPxS, floatY, hColB, false, hMatS, preLayout, outlineMuiMode)) return false
                drawBatchedGlyph(batchCtx, effSeq, floatX + spreadPxS, floatY, hColB, false, hMatS, preLayout, outlineMuiMode)
                drawBatchedGlyph(batchCtx, effSeq, floatX, floatY - spreadPxS * 0.78, hColB, false, hMatS, preLayout, outlineMuiMode)
                drawBatchedGlyph(batchCtx, effSeq, floatX, floatY + spreadPxS * 0.78, hColB, false, hMatS, preLayout, outlineMuiMode)
            }
            return drawBatchedGlyph(batchCtx, effSeq, floatX, floatY, packArgb(rgbColor, coreEffByteS), Boolean(shadow) && fadeProgress < 0.42, baseItemMat, preLayout, outlineMuiMode)
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
                    if (hasUnitRot) uMat.rotateZ(unitRotDegSafeValue * DEG_TO_RAD)
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
                        event.rotateDeg(unitRotDegSafeValue)
                    }
                    if (hasUnitScale) {
                        if (typeof event['scale(float,float)'] === 'function') {
                            event['scale(float,float)'](sc, sc)
                        } else {
                            event.scale(sc, sc, 1.0)
                        }
                    }
                    mat = (typeof event.getMatrix === 'function') ? event.getMatrix() : event.matrix
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
                var effOutAlpha = (isBlurFade && outMode === 'glow')
                    ? (fadeProgress >= 0.42 ? 0.0 : (baseA * (1.0 - fadeProgress / 0.42)))
                    : baseA
                if (effOutAlpha > 0.01) {
                    var oColRgb = (outColor != null && outColor >= 0) ? outColor : (outMode === 'glow' ? rgbColor : 0x050A10)
                    var oRad    = clampNum(outWidth || (outMode === 'glow' ? 0.85 : 0.72), 0.25, 2.5)
                    if (!drawBatchedOutline(batchCtx, effSeq, preLayout, outlineMuiMode, gx, gy, mat, outMode, oColRgb, oRad, effOutAlpha)) {
                        return false
                    }
                }
            }

            var coreMuiMode  = (hasAnyOutline || isBlurFade || needUnitTransform)
                ? outlineMuiMode
                : computeMuiDrawMode(batchCtx, mat, false)
            var useMuiCore   = (preLayout != null && batchCtx.muiActive)
            var cR           = (rgbColor >>> 16) & 0xFF
            var cG           = (rgbColor >>> 8) & 0xFF
            var cB           = rgbColor & 0xFF

            if (isBlurFade) {
                var blurRad   = 0.35 + fadeProgress * 0.48
                var mistAlpha = clampNum(invP * (0.36 + 0.24 * Math.sin(fadeProgress * PI)), 0.03, 0.56)
                var mistEffB  = Math.round(mistAlpha * 255)
                if (mistEffB >= OUTLINE_ALPHA_CUTOFF) {
                    var blurY   = blurRad * 0.65
                    var mMatB   = startOutlineZMat(batchCtx, mat, -0.020)
                    var mistCol = useMuiCore ? 0 : packArgb(rgbColor, mistEffB)
                    if (!drawBatchedPassRgb(batchCtx, effSeq, preLayout, outlineMuiMode, gx - blurRad, gy - blurY, cR, cG, cB, mistEffB, mistCol, false, mMatB)) return false
                    drawBatchedPassRgb(batchCtx, effSeq, preLayout, outlineMuiMode, gx + blurRad, gy + blurY, cR, cG, cB, mistEffB, mistCol, false, mMatB)
                }
                var coreBlurUnit = clampNum(invP * invP * (1.0 - fadeProgress * 0.35), 0.03, 1.0)
                var coreEffB     = clampNum(Math.round(coreBlurUnit * 255), 5, 255)
                var blurShd      = Boolean(shadow) && outMode === 'none' && fadeProgress < 0.35
                return drawBatchedPassRgb(batchCtx, effSeq, preLayout, coreMuiMode, gx, gy, cR, cG, cB, coreEffB, useMuiCore ? 0 : packArgb(rgbColor, coreEffB), blurShd, mat)
            }

            var useShadow = Boolean(shadow) && (outMode === 'none')
            return drawBatchedPassRgb(batchCtx, effSeq, preLayout, coreMuiMode, gx, gy, cR, cG, cB, 255, useMuiCore ? 0 : packArgb(rgbColor, 255), useShadow, mat)
        } finally {
            if (unitPushed) {
                try { event.pop() } catch (eUPop) { }
            }
        }
    }

    var unitRotDegSafeValue = 0.0

    // 统一绘制函数：支持 ModernUI TextLayout / Font.drawInBatch 帧内合批、直接 Matrix4f 变换、外圈描边/发光、虚化/裂解淡出
    function drawRichUnit(event, comp, floatX, floatY, halfW, rgbColor, shadow, outMode, outColor, outWidth, charScale, fadeStyle, inFade, fadeProgress, unitRotDeg, batchCtx, seqOpt, ownerObj) {
        var isBlurFade  = (inFade && fadeStyle === 'blur')
        var isSplitFade = (inFade && fadeStyle === 'split')
        if ((isBlurFade || isSplitFade) && fadeProgress >= 0.97) return

        var invP     = inFade ? clampNum(1.0 - fadeProgress, 0.0, 1.0) : 1.0
        var baseA    = isBlurFade ? (invP * invP) : (isSplitFade ? (invP * invP) : 1.0)
        if (baseA <= 0.025) return

        if (!isFinite(floatX) || !isFinite(floatY)) return
        var hasUnitRot = (unitRotDeg != null && isFinite(unitRotDeg) && Math.abs(unitRotDeg) > 0.15)
        if (hasUnitRot) unitRotDegSafeValue = unitRotDeg

        if (batchCtx != null && !BATCH_FAILED) {
            if (tryDrawUnitBatched(event, comp, seqOpt, ownerObj, floatX, floatY, halfW, rgbColor, shadow, outMode, outColor, outWidth, charScale, inFade, isBlurFade, isSplitFade, fadeProgress, hasUnitRot, baseA, invP, batchCtx)) {
                return
            }
        }

        ensureFallbackBlend(event, batchCtx)
        ensureItemPosePushed(event)

        var needMatrix = (Math.abs(floatX - Math.round(floatX)) > 0.01) ||
                         (Math.abs(floatY - Math.round(floatY)) > 0.01) ||
                         (charScale != null && Math.abs(charScale - 1.0) > 0.01) ||
                         hasUnitRot ||
                         (outMode === 'stroke' || outMode === 'glow') ||
                         isBlurFade

        if (!needMatrix && !isSplitFade) {
            var fastCol = packArgb(rgbColor, 255)
            event.text(comp, Math.round(floatX) || 0, Math.round(floatY) || 0, fastCol, Boolean(shadow))
            return
        }

        if (isSplitFade) {
            // 保留“逐渐分解成数个字体”的裂解淡出效果 (fade: 'split')
            var coreAlphaS = clampNum(Math.round(baseA * 245 + 6), 5, 255)
            var haloBellS  = Math.sin(clampNum(fadeProgress, 0.05, 0.95) * PI)
            var haloAlphaS = clampNum(Math.round((invP * 0.72 + haloBellS * 0.28) * 72), 5, 96)
            var spreadPxS  = 0.65 + fadeProgress * 2.85
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
            event.text(comp, rx, ry, packArgb(rgbColor, coreAlphaS), Boolean(shadow) && fadeProgress < 0.42)
            resetShaderAlphaSafe(event)
            return
        }

        var unitPushed = false
        try {
            event.push()
            unitPushed = true
            var sc = (charScale != null && isFinite(charScale) && charScale > 0.2) ? charScale : 1.0
            if (Math.abs(sc - 1.0) > 0.01 || hasUnitRot) {
                var cx = floatX + (halfW || 0)
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
                event.translate(-(halfW || 0), -4.0)
            } else {
                event.translate(floatX, floatY)
            }

            // 1. 外圈绘制（回退路径与合批路径一致：glow 4 向对称柔光，stroke 8 向轮廓，增量平移消除内层 push/pop）
            if (outMode === 'stroke' || outMode === 'glow') {
                var isGlowFb    = (outMode === 'glow')
                var effOutAlphaFb = (isBlurFade && isGlowFb)
                    ? (fadeProgress >= 0.42 ? 0.0 : (baseA * (1.0 - fadeProgress / 0.42)))
                    : baseA
                if (effOutAlphaFb > 0.01) {
                    var oColRgb = (outColor != null && outColor >= 0)
                        ? outColor
                        : (isGlowFb ? rgbColor : 0x050A10)
                    var oRad = clampNum(outWidth || (isGlowFb ? 0.85 : 0.72), 0.25, 2.5) * (isGlowFb ? 0.90 : 1.0)
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
                var blurRad   = 0.35 + fadeProgress * 0.48
                var blurY2    = blurRad * 0.65
                var mistAlpha = clampNum(invP * (0.36 + 0.24 * Math.sin(fadeProgress * PI)), 0.03, 0.56)
                var mistByte  = clampNum(Math.round(mistAlpha * 255), 5, 145)
                var mistCol   = packArgb(rgbColor, mistByte)
                setShaderAlphaSafe(event, mistAlpha)

                event.translate(-blurRad, -blurY2)
                event.text(comp, 0, 0, mistCol, false)
                event.translate(blurRad * 2.0, blurY2 * 2.0)
                event.text(comp, 0, 0, mistCol, false)
                event.translate(-blurRad, -blurY2)

                var coreBlurUnit = clampNum(invP * invP * (1.0 - fadeProgress * 0.35), 0.03, 1.0)
                var coreBlurByte = clampNum(Math.round(coreBlurUnit * 255), 5, 255)
                setShaderAlphaSafe(event, coreBlurUnit)
                event.text(comp, 0, 0, packArgb(rgbColor, coreBlurByte), Boolean(shadow) && outMode === 'none' && fadeProgress < 0.35)
                resetShaderAlphaSafe(event)
            } else {
                // 正常主字绘制
                if (outMode === 'stroke' || outMode === 'glow') {
                    resetShaderAlphaSafe(event)
                }
                var mainCol = packArgb(rgbColor, 255)
                var useShadow = Boolean(shadow) && (outMode === 'none')
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

    function buildRenderedLines(wrappedLines, startSkipVis, keepEndVis, appendCursor, fontObj, letterSpacingPx, spacingMode) {
        if (!wrappedLines || wrappedLines.length === 0) return []
        var out = []
        var cursorIdx = 0
        var lastActiveIdx = -1

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

            var sliced  = (localKeep < ln.vis) ? sliceVisibleChars(ln.text, localKeep) : ln.text
            var dropped = (localSkip > 0) ? dropFirstVisibleChars(sliced, localSkip, fontObj, letterSpacingPx, spacingMode) : { text: sliced, offsetPx: 0 }
            if (dropped.text && dropped.text.length > 0) {
                var endPx = (localKeep >= ln.vis)
                    ? ((ln.widthPx || 0) + (letterSpacingPx > 0 ? computeClusterSpacing(9, letterSpacingPx, spacingMode) : 0))
                    : dropFirstVisibleChars(sliced, 999999, fontObj, letterSpacingPx, spacingMode).offsetPx
                out.push({
                    text:      dropped.text,
                    fullW:     ln.widthPx,
                    offsetPx:  dropped.offsetPx,
                    endPx:     endPx,
                    lineIndex: i
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

    // 实际应用一条弹幕指令（仅在主渲染线程中或无并发竞争时修改 activeOverlays）
    function applyDanmakuNow(raw, now) {
        if (raw == null) return
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

        var title = truncateSafeText(readStr(raw, 'title', readStr(raw, 'text', '')), CONFIG.maxTitleChars)
        var sub   = truncateSafeText(readStr(raw, 'sub', readStr(raw, 'subtitle', '')), CONFIG.maxSubChars)
        if (title.length === 0 && sub.length === 0) return

        var titleVis   = countVisibleChars(title)
        var subVis     = countVisibleChars(sub)
        var totalVis   = titleVis + subVis
        var hasTags    = hasRichSpanTags(title) || hasRichSpanTags(sub)

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
            key = deriveAutoActiveKey(namespace, group, slotId, posTag, title, sub, normalizeKey)
        } else if (key && namespace && key.indexOf(namespace + ':') !== 0) {
            key = namespace + ':' + key
        }

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
        if (outlineMode !== 'stroke' && outlineMode !== 'glow') outlineMode = 'none'
        var outlineColor  = Math.round(readNum(raw, 'outlineColor', -1))
        var outlineWidth  = clampNum(readNonNegNum(raw, 'outlineWidth', outlineMode === 'glow' ? 0.85 : 0.72, 0.2), 0.2, 2.5)

        var resetAnim    = readBool(raw, 'restart', readBool(raw, 'resetAnimation', false))
        var allowMove    = readBool(raw, 'movable', readBool(raw, 'move', readBool(raw, 'updatePos', false)))
        var isRandScale  = readBool(raw, 'randomScale', false)
        var isRandColor  = readBool(raw, 'randomColor', false)
        var maxWidth     = sanitizeMaxWidth(readNum(raw, 'maxWidth', 0))
        var wrapEnabled  = readBool(raw, 'wrap', true)
        var clampBounds  = readBool(raw, 'clamp', true)
        var showInGui    = readBool(raw, 'showInGui', false)
        var maxGroupSize = Math.round(readNonNegNum(raw, 'maxGroup', readNonNegNum(raw, 'maxGroupSize', 0, 0), 0))
        var debugEnabled = readBool(raw, 'debug', false)

        if (key.length > 0) {
            for (var kIdx = 0; kIdx < activeOverlays.length; kIdx++) {
                var exist = activeOverlays[kIdx]
                if (exist.key === key) {
                    exist.tier         = tier
                    exist.maxGroupSize = maxGroupSize
                    exist.priority     = priority
                    exist.namespace    = namespace
                    exist.slotId       = slotId
                    if (exist.title !== title || exist.sub !== sub || exist.maxWidth !== maxWidth || exist.wrap !== wrapEnabled || exist.letterSpacing !== letterSpacing || exist.letterSpacingMode !== letterSpacingMode) {
                        exist.title             = title
                        exist.sub               = sub
                        exist.titleVis          = titleVis
                        exist.subVis            = subVis
                        exist.totalVis          = totalVis
                        exist.hasInlineTags     = hasTags
                        exist.letterSpacing     = letterSpacing
                        exist.letterSpacingMode = letterSpacingMode
                        exist.wrapKey           = ''
                        exist.shatterCacheKey   = ''
                        exist.shatterFrags      = null
                        exist.charShakeCacheKey = ''
                        exist.charShakeFrags    = null
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
            }
        }

        var initSched = computeOverlaySchedule(lifeMode, holdTicks, fadeTicks, typewriter, totalVis, charMs, now, 0)

        activeOverlays.push({
            key:               key,
            slotId:            slotId,
            tier:              tier,
            namespace:         namespace,
            group:             group,
            lifeMode:          lifeMode,
            priority:          priority,
            title:             title,
            sub:               sub,
            titleVis:          titleVis,
            subVis:            subVis,
            totalVis:          totalVis,
            hasInlineTags:     hasTags,
            letterSpacing:     letterSpacing,
            letterSpacingMode: letterSpacingMode,
            outlineMode:       outlineMode,
            outlineColor:      outlineColor,
            outlineWidth:      outlineWidth,
            rx:                clampNum(readNum(raw, 'rx', 0.5), 0.0, 1.0),
            ry:                clampNum(readNum(raw, 'ry', 0.35), 0.0, 1.0),
            angle:             readNum(raw, 'angle', 0.0),
            scale:             clampNum(readNonNegNum(raw, 'scale', 1.0, 0.2), 0.2, CONFIG.maxScale),
            color:             readNum(raw, 'color', 0xFF5555),
            subColor:          readNum(raw, 'subColor', 0xFFCC44),
            shadow:            readBool(raw, 'shadow', true),
            shakeMode:         shakeMode,
            perCharShake:      isPerChar,
            charShakeStyle:    charShakeStyle,
            charShakeShift:    charShakeShift,
            charShakeShiftX:   charShakeShiftX,
            charShakeShiftY:   charShakeShiftY,
            charShakeSwayX:    charShakeSwayX,
            charShakeSwayY:    charShakeSwayY,
            charShakeRotDeg:     charShakeRotDeg,
            charShakeWin:        charShakeWin,
            charShakeSnap:       charShakeSnap,
            charShakeTransition: charShakeTransition,
            shakeAmp:          shakeAmp,
            shakeFreqMin:      shakeFreqMin,
            shakeFreqMax:      shakeFreqMax,
            shakeSeed:         Math.random() * 1000.0 + 1.0,
            fadeStyle:         fadeStyle,
            typewriter:        typewriter,
            charMs:            charMs,
            cursor:            readStr(raw, 'cursor', '▌'),
            debug:             debugEnabled,
            maxWidth:          maxWidth,
            wrap:              wrapEnabled,
            clamp:             clampBounds,
            showInGui:         showInGui,
            maxGroupSize:      maxGroupSize,
            wrapKey:           '',
            shatterCacheKey:   '',
            shatterFrags:      null,
            charShakeCacheKey: '',
            charShakeFrags:    null,
            titleLines:        null,
            subLines:          null,
            blockW:            0,
            blockH:            0,
            holdDurationMs:    initSched.holdDurationMs,
            shakeDurationMs:   initSched.shakeDurationMs,
            fadeMs:            initSched.fadeMs,
            born:              now,
            fadeStartAt:       initSched.fadeStartAt,
            expire:            initSched.expireAt,
            drawErrors:        0
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

    // 外部调用与网络包统一入队，由 paintScreen 帧首在渲染线程一次性出队消费，避免遍历 activeOverlays 期间发生并发/重入修改
    function enqueueDanmaku(raw) {
        if (raw == null) return
        if (pendingActions.length >= CONFIG.maxPendingActions) {
            var incomingCtrl = hasKeyInTag(raw, 'stop') || hasKeyInTag(raw, 'clear')
            var dropQIdx = 0
            if (incomingCtrl) {
                for (var qi = 0; qi < pendingActions.length; qi++) {
                    var qItem = pendingActions[qi]
                    if (qItem != null && !hasKeyInTag(qItem, 'stop') && !hasKeyInTag(qItem, 'clear')) {
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
            var pkt = event.data
            var incomingProto = (pkt != null) ? readNum(pkt, 'proto', null) : null
            if (!checkProtoCompatible(PROTO_VERSION, incomingProto)) {
                if (!protoMismatchWarned) {
                    protoMismatchWarned = true
                    console.error('[ScreenDanmakuClient] 协议校验失败（已拒收报文）：服务端 proto=' + String(incomingProto) + '，客户端预期 proto=' + PROTO_VERSION + '，请同步双端脚本。')
                }
                return
            }
            enqueueDanmaku(pkt)
        } catch (e) {
            logErrorThrottled('dataReceived error', e)
        }
    })

    global.ScreenDanmakuClient = {
        CONFIG:     CONFIG,
        setDebug:   function (enabled) { CONFIG.debug = Boolean(enabled); return CONFIG.debug },
        push:       enqueueDanmaku,
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
        count:      function () { return activeOverlays.length + pendingActions.length }
    }

    ClientEvents.loggedOut(function () {
        activeOverlays.length = 0
        pendingActions.length = 0
        LAST_LEVEL_KEY = ''
    })
    ClientEvents.loggedIn(function () {
        activeOverlays.length = 0
        pendingActions.length = 0
        LAST_LEVEL_KEY = ''
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

    function drawTypewriterCursor(event, item, blinkCursor, cursorX, cursorY, color, shdBool, outMode, outCol, outWid, inFade, fadeProgress, batchCtx) {
        if (!blinkCursor || blinkCursor.length === 0) return
        if (item._cursorText !== blinkCursor || item._cursorComp == null) {
            item._cursorText  = blinkCursor
            item._cursorComp  = Text.of(blinkCursor)
            item._cursorSeq   = resolveVisualSeq(item._cursorComp)
            item._cursorOwner = { _muiLayout: null, _muiEpoch: -1, _muiCheckMs: 0 }
        }
        drawRichUnit(
            event,
            item._cursorComp,
            cursorX,
            cursorY,
            3.0,
            color,
            shdBool,
            outMode,
            outCol,
            outWid,
            1.0,
            item.fadeStyle,
            inFade,
            fadeProgress,
            0.0,
            batchCtx,
            item._cursorSeq,
            item._cursorOwner
        )
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

        if (activeOverlays.length === 0) return

        var sw          = Number(event.width) || 854
        var sh          = Number(event.height) || 480
        var guiBlocked  = isBlockingGuiOpen(event)
        var fontObj     = null
        var batchCtx    = null
        var batchTried  = false
        var baseFrameM  = null
        var frameStartMs = now
        var drawnCount   = 0

        try {
            for (var i = 0; i < activeOverlays.length; i++) {
            var item = activeOverlays[i]
            if (now >= item.expire) {
                activeOverlays.splice(i, 1)
                i--
                continue
            }

            if (guiBlocked && !item.showInGui) {
                continue
            }

            if (drawnCount >= 1 && (monotonicNowMs() - frameStartMs) >= CONFIG.frameBudgetMs) {
                break
            }
            drawnCount++

            if (fontObj === null) {
                fontObj = getClientFont(event, now)
            }
            if (!batchTried) {
                batchTried = true
                batchCtx   = ensureFrameBatchCtx(event, fontObj, now)
                if (batchCtx != null) {
                    baseFrameM = (typeof event.getMatrix === 'function') ? event.getMatrix() : event.matrix
                    batchCtx.baseFrameMat = baseFrameM
                }
            }

            var age          = max2(0, now - item.born)
            var rem          = max2(0, item.expire - now)
            var fadeStartAt  = item.fadeStartAt != null ? item.fadeStartAt : (item.expire - (item.fadeMs || 350))
            var fadeWin      = max2(1, item.expire - fadeStartAt)
            var inFade       = (now >= fadeStartAt)
            var fadeProgress = inFade ? clampNum((now - fadeStartAt) / fadeWin, 0.0, 1.0) : 0.0

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
                    item.titleLines = wrapStyledTextLines(item.title, effMaxLineW, fontObj, itemSpacing, itemSpacingMode)
                    item.subLines   = wrapStyledTextLines(item.sub, effMaxLineW, fontObj, itemSpacing, itemSpacingMode)
                    var maxW = 0
                    for (var twi = 0; twi < item.titleLines.length; twi++) {
                        if (item.titleLines[twi].widthPx > maxW) maxW = item.titleLines[twi].widthPx
                    }
                    for (var swi = 0; swi < item.subLines.length; swi++) {
                        if (item.subLines[swi].widthPx > maxW) maxW = item.subLines[swi].widthPx
                    }
                    var totalLineCount = item.titleLines.length + item.subLines.length
                    item.blockW = maxW
                    item.blockH = max2(CONFIG.minBlockHeightPx, totalLineCount * CONFIG.lineStepPx)
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
            var px = sw * item.rx + shakeVec.x
            var py = sh * item.ry + shakeVec.y

            if (item.clamp !== false) {
                var rad      = Math.abs(item.angle || 0) * DEG_TO_RAD
                var cosA     = Math.abs(Math.cos(rad))
                var sinA     = Math.abs(Math.sin(rad))
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
            }

            ITEM_POSE_SCRATCH.needed = false
            ITEM_POSE_SCRATCH.pushed = false
            try {
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
                        batchCtx.itemMat = (typeof event.getMatrix === 'function') ? event.getMatrix() : event.matrix
                    }
                }

                if (isShatterFade) {
                    var titleSkipS   = min2(item.titleVis, startSkipVis)
                    var titleKeepS   = min2(item.titleVis, keepEndVis)
                    var subSkipS     = max2(0, startSkipVis - item.titleVis)
                    var subKeepS     = max2(0, keepEndVis - item.titleVis)
                    var sTitleLines  = buildRenderedLines(item.titleLines, titleSkipS, titleKeepS, '', fontObj, itemSpacing, itemSpacingMode)
                    var sSubLines    = buildRenderedLines(item.subLines, subSkipS, subKeepS, '', fontObj, itemSpacing, itemSpacingMode)
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
                        var fSeq   = frag.seq || (frag.seq = resolveVisualSeq(frag.comp))
                        var fLay   = (batchCtx != null && !BATCH_FAILED) ? resolveUnitMuiLayout(batchCtx, fSeq, frag) : null
                        var fMode  = (fLay != null && batchCtx.muiAllowSdf) ? 1 : 0

                        if (fastMode || (Math.abs(rotDeg) < 2.0 && fScale > 0.92)) {
                            var fxRaw = (frag.cx || 0) + (dx || 0) + (frag.halfW || 0)
                            var fyRaw = (frag.cy || 0) + (dy || 0) - 4.5
                            if (!(batchCtx != null && !BATCH_FAILED && drawBatchedGlyph(batchCtx, fSeq, fxRaw, fyRaw, fCol, shShdBool, batchCtx.itemMat, fLay, fMode))) {
                                ensureFallbackBlend(event, batchCtx)
                                ensureItemPosePushed(event)
                                event.text(frag.comp, Math.round(fxRaw) || 0, Math.round(fyRaw) || 0, fCol, shShdBool)
                            }
                        } else if (batchCtx != null && !BATCH_FAILED && batchCtx.canDirectMatrix) {
                            var fMatDirect = batchCtx.unitMat
                            fMatDirect.set(batchCtx.itemMat)
                            fMatDirect.translate((frag.cx || 0) + (dx || 0), (frag.cy || 0) + (dy || 0), 0.0)
                            if (rotDeg !== 0 && isFinite(rotDeg)) fMatDirect.rotateZ(rotDeg * DEG_TO_RAD)
                            if (fScale !== 1.0 && isFinite(fScale)) fMatDirect.scale(fScale, fScale, 1.0)
                            if (!drawBatchedGlyph(batchCtx, fSeq, frag.halfW || 0, -4.5, fCol, shShdBool, fMatDirect, fLay, fMode)) {
                                ensureFallbackBlend(event, batchCtx)
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
                                var fMat = (batchCtx != null && !BATCH_FAILED) ? ((typeof event.getMatrix === 'function') ? event.getMatrix() : event.matrix) : null
                                if (!(fMat != null && drawBatchedGlyph(batchCtx, fSeq, frag.halfW || 0, -4.5, fCol, shShdBool, fMat, fLay, fMode))) {
                                    ensureFallbackBlend(event, batchCtx)
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
                } else if (usePerCharRoute) {
                    var charFrags = getOrBuildCharShakeCache(item, item.titleLines, item.subLines, titleLineCount, startY, lineStep, fontObj)
                    var cShdBool  = Boolean(item.shadow)
                    var defOutMod = item.outlineMode || 'none'
                    var defOutCol = item.outlineColor != null ? item.outlineColor : -1
                    var defOutWid = item.outlineWidth || 0.75
                    var lastVisCf = null
                    if ((item.debug || CONFIG.debug) && !item._debugLogged && charFrags.length > 0) {
                        item._debugLogged = true
                        var dbg0 = charFrags[0]
                        var dbgOff = sampleCharShakeOffset(dbg0, age, item.shakeAmp || 0.65, item, { dx: 0.0, dy: 0.0, rotDeg: 0.0 })
                        console.info('[ScreenDanmakuClient DEBUG] frags=' + charFrags.length +
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
                    for (var cIdx = 0; cIdx < charFrags.length; cIdx++) {
                        var cf = charFrags[cIdx]
                        if (cf.visIndex < startSkipVis || cf.visIndex >= keepEndVis) continue
                        lastVisCf = cf
                        if (cf.isBlank) continue

                        var shouldShakeChar = (cf.shakeFlag === 1) || (isPerCharShake && cf.shakeFlag !== -1)
                        var offDx  = 0.0
                        var offDy  = 0.0
                        var offRot = 0.0
                        if (shouldShakeChar) {
                            sampleCharShakeOffset(cf, age, activeShake, item, CHAR_OFFSET_SCRATCH)
                            offDx  = CHAR_OFFSET_SCRATCH.dx
                            offDy  = CHAR_OFFSET_SCRATCH.dy
                            offRot = CHAR_OFFSET_SCRATCH.rotDeg
                        }
                        var cOutMode  = (cf.outlineMode && cf.outlineMode.length > 0) ? cf.outlineMode : defOutMod
                        var cOutColor = (cf.outlineColor != null && cf.outlineColor >= 0) ? cf.outlineColor : defOutCol

                        drawRichUnit(
                            event,
                            cf.comp,
                            cf.baseX + offDx,
                            cf.baseY + offDy,
                            cf.w * 0.5,
                            cf.color,
                            cShdBool,
                            cOutMode,
                            cOutColor,
                            defOutWid,
                            cf.charScale,
                            item.fadeStyle,
                            inFade,
                            fadeProgress,
                            offRot,
                            batchCtx,
                            cf.seq,
                            cf
                        )
                    }

                    if (blinkCursor.length > 0 && lastVisCf != null) {
                        drawTypewriterCursor(
                            event,
                            item,
                            blinkCursor,
                            lastVisCf.baseX + lastVisCf.w + (itemSpacing || 0),
                            lastVisCf.baseY,
                            lastVisCf.color,
                            cShdBool,
                            defOutMod,
                            defOutCol,
                            defOutWid,
                            inFade,
                            fadeProgress,
                            batchCtx
                        )
                    }
                } else {
                    var lineCacheKey = curWrapKey + '|s:' + startSkipVis + '|k:' + keepEndVis + '|y:' + startY
                    var lCache       = item._lineRenderCache
                    if (lCache == null || lCache.key !== lineCacheKey) {
                        var titleSkip = min2(item.titleVis, startSkipVis)
                        var titleKeep = min2(item.titleVis, keepEndVis)
                        var subSkip   = max2(0, startSkipVis - item.titleVis)
                        var subKeep   = max2(0, keepEndVis - item.titleVis)

                        var renderTitleLines = buildRenderedLines(item.titleLines, titleSkip, titleKeep, '', fontObj, itemSpacing, itemSpacingMode)
                        var renderSubLines   = buildRenderedLines(item.subLines, subSkip, subKeep, '', fontObj, itemSpacing, itemSpacingMode)

                        var tItems = []
                        for (var tIdx = 0; tIdx < renderTitleLines.length; tIdx++) {
                            var rLine1 = renderTitleLines[tIdx]
                            var tComp  = Text.of(rLine1.text)
                            var tBaseX = -Math.floor((rLine1.fullW || 0) * 0.5)
                            tItems.push({
                                comp:    tComp,
                                seq:     resolveVisualSeq(tComp),
                                x:       tBaseX + (rLine1.offsetPx || 0),
                                endX:    tBaseX + (rLine1.endPx || 0),
                                y:       startY + (rLine1.lineIndex || 0) * lineStep,
                                halfW:   (rLine1.fullW || 0) * 0.5,
                                _muiLayout:  null,
                                _muiEpoch:   -1,
                                _muiCheckMs: 0
                            })
                        }
                        var sItems = []
                        for (var sIdx = 0; sIdx < renderSubLines.length; sIdx++) {
                            var rLine2 = renderSubLines[sIdx]
                            var sComp  = Text.of(rLine2.text)
                            var sBaseX = -Math.floor((rLine2.fullW || 0) * 0.5)
                            sItems.push({
                                comp:    sComp,
                                seq:     resolveVisualSeq(sComp),
                                x:       sBaseX + (rLine2.offsetPx || 0),
                                endX:    sBaseX + (rLine2.endPx || 0),
                                y:       startY + (titleLineCount + (rLine2.lineIndex || 0)) * lineStep,
                                halfW:   (rLine2.fullW || 0) * 0.5,
                                _muiLayout:  null,
                                _muiEpoch:   -1,
                                _muiCheckMs: 0
                            })
                        }
                        var cursorAnchor = null
                        if (shownVis <= item.titleVis) {
                            if (tItems.length > 0) {
                                var lastT = tItems[tItems.length - 1]
                                cursorAnchor = { x: lastT.endX, y: lastT.y, isSub: false }
                            }
                        } else if (sItems.length > 0) {
                            var lastS = sItems[sItems.length - 1]
                            cursorAnchor = { x: lastS.endX, y: lastS.y, isSub: true }
                        }
                        lCache = { key: lineCacheKey, tItems: tItems, sItems: sItems, cursorAnchor: cursorAnchor }
                        item._lineRenderCache = lCache
                    }

                    var rawMainCol = (item.color != null && isFinite(item.color)) ? Math.round(item.color) : 0xFF5555
                    var rawSubCol  = (item.subColor != null && isFinite(item.subColor)) ? Math.round(item.subColor) : 0xFFCC44
                    var shdBool    = Boolean(item.shadow)
                    var lOutMode   = item.outlineMode || 'none'
                    var lOutCol    = item.outlineColor != null ? item.outlineColor : -1
                    var lOutWid    = item.outlineWidth || 0.75

                    for (var ti = 0; ti < lCache.tItems.length; ti++) {
                        var tEntry = lCache.tItems[ti]
                        drawRichUnit(event, tEntry.comp, tEntry.x, tEntry.y, tEntry.halfW, rawMainCol, shdBool, lOutMode, lOutCol, lOutWid, 1.0, item.fadeStyle, inFade, fadeProgress, 0.0, batchCtx, tEntry.seq, tEntry)
                    }
                    for (var si = 0; si < lCache.sItems.length; si++) {
                        var sEntry = lCache.sItems[si]
                        drawRichUnit(event, sEntry.comp, sEntry.x, sEntry.y, sEntry.halfW, rawSubCol, shdBool, lOutMode, lOutCol, lOutWid, 1.0, item.fadeStyle, inFade, fadeProgress, 0.0, batchCtx, sEntry.seq, sEntry)
                    }
                    if (blinkCursor.length > 0 && lCache.cursorAnchor != null) {
                        var ca = lCache.cursorAnchor
                        drawTypewriterCursor(
                            event,
                            item,
                            blinkCursor,
                            ca.x,
                            ca.y,
                            ca.isSub ? rawSubCol : rawMainCol,
                            shdBool,
                            lOutMode,
                            lOutCol,
                            lOutWid,
                            inFade,
                            fadeProgress,
                            batchCtx
                        )
                    }
                }
                item.drawErrors = 0
            } catch (eDraw) {
                item.drawErrors = (item.drawErrors || 0) + 1
                logErrorThrottled('paintScreen draw error', eDraw)
                if (item.drawErrors >= CONFIG.maxItemDrawErrors) {
                    activeOverlays.splice(i, 1)
                    i--
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
            flushFrameBatchCtx(batchCtx)
            if (batchCtx != null && batchCtx.needBlendRestore) {
                if (HAS_EVENT_BLEND) event.blend(false)
                batchCtx.needBlendRestore = false
            }
        }
    })
})()
