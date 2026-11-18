// priority: 500
// ============================================================================
//  通用平面渲染与屏幕弹幕组件 —— 服务端调度器 (Epiphy2DSurface / ScreenDanmaku v6.0)
//  所属系列：Epiphy的-通用组件系列（本系列包含 startup / server / client 配套脚本）
//  [LLM 协作规范] 每次进行较大修改或重构前，请先将修改同步至 <repo-root> 并执行 git commit 保存当前可用状态，便于随时回退与对比 diff。
//  许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
//  放置位置：kubejs/server_scripts/通用组件/Epiphy的-平面渲染组件.js
//  配套客户端渲染器：kubejs/client_scripts/通用组件/Epiphy的-平面渲染器.js (Epiphy2DRenderer / ScreenDanmakuClient v6.0)
//  配套权限阀组件：kubejs/server_scripts/通用组件/Epiphy的-权限阀.js（管理 /epiphy 根命令、执行权限与 actorTier 资源分级）
//
//  依赖与缺失降级行为：
//    - 必需配套：kubejs/client_scripts/通用组件/Epiphy的-平面渲染器.js（缺失时服务端可正常调用 API，但客户端无接收与画面渲染）
//    - 前置底座：kubejs/startup_scripts/通用组件/Epiphy的-Spec与通用工具.js (EpiphySpec / EpiphyProtocol, priority: 1200)
//               与 kubejs/server_scripts/通用组件/Epiphy的-服务端核心.js (EpiphyServerCore / EpiphyServerBase, priority: 1080)
//    - 可选依赖：kubejs/server_scripts/通用组件/Epiphy的-日志.js (EpiphyLog, priority: 1100)
//      缺失时由 EpiphyServerBase 自动回退至 console 限频降级输出（核心功能不受影响）
//    - 可选依赖：kubejs/server_scripts/通用组件/Epiphy的-方块与区块组件.js (EpiphyBlockTracker, priority: 1050)
//      缺失时 bindBlock 降级为基础事件兜底模式（仅支持新放置/破坏方块，无区块扫描与持久化），不影响常规弹幕 API
//    - 可选依赖：kubejs/server_scripts/通用组件/Epiphy的-权限阀.js (EpiphyPermissionValve, priority: 1000)
//      缺失时 /epiphy danmaku 指令不生效（OP 登录时提示），JS 调用接口正常；后续 /reload 补全权限阀后会自动从队列补注册并复位提示标志
//
//  [组件边界 / 禁止直接复用] 本组件属于 L3 业务调度层（非 L1/L2 通用基础设施），内部逻辑不得被其他模块
//    或兄弟 L3 组件（如音频组件）直接复制或跨模块复用；外部玩法脚本仅应通过 global.ScreenDanmaku 公开 API 调用。
//  [语法规范] 遵循 README-LLM.md §1 强制语法基准（与 docs/kube-mods-rhino-es5-es6-compatibility.md）：
//    以 ES5 + `var` 为主，可按需谨慎使用经实测无语义偏移的 ES6/ES2020 扩展语法；
//    严禁使用 `??`、`let`/`const`、对象属性简写/计算属性、展开与默认参数等已确认高危/失效特性。
// ============================================================================
//  调用说明（global.ScreenDanmaku）
// ============================================================================
//  1. 推荐入口：
//     - ScreenDanmaku.toPlayer(playerOrPlayers, optsOrText)
//     - ScreenDanmaku.inDimension(levelOrDim, x, y, z, radius, optsOrText)
//     - ScreenDanmaku.atEvent(event, radiusOrOpts, maybeOpts)
//     - ScreenDanmaku.send(opts) / ScreenDanmaku.safeSend(targetOrOpts, maybeOpts)
//     - ScreenDanmaku.deactivatePlayer(player, keyOrGroup, fadeOutOrOpts, maxPriority)
//     - ScreenDanmaku.deactivateNear(levelOrDim, x, y, z, radius, keyOrGroup, fadeOutOrOpts, maxPriority)
//     - ScreenDanmaku.clearPlayer(player, groupOrOpts, maxPriority)
//     - ScreenDanmaku.clearNear(levelOrDim, x, y, z, radius, groupOrOpts, maxPriority)
//     （注：所有 API 在参数缺失或玩家离线时均采用限频日志 + 返回 0，不抛未捕获异常打断调用方 tick 逻辑）
//
//  2. 生命周期与优先级：
//     - lifeMode: 'once'（默认，duration 默认 65 tick，priority 默认 2）
//     - lifeMode: 'active'（持续激活，activeHold 默认 28 tick，priority 默认 5）
//     - movable: false（默认同 key 续期锁定初始位置与倾角；传 true 允许移动）
//     - restart: false（默认同 key 续期保留 born 时间轴；传 true 重播入场动画）
//     - normalizeKey: true（默认自动 key 归一化动态数值；传 false 保留不同数值为独立弹幕）
//
//  3. 震动模式（shake / shakeMode）：
//     - 'none'(默认) | 'constant' | 'decay' | 'fade_in' | 'pulse' | 'random'（在前述 5 种中随机抽取）
//     - 'per_char'（逐字独立方向随机抖动，默认关闭；支持 shakeFreq: 800（或 '0.8s' 统一 0.8 秒同步抖动）或 [800, 1300] 区间周期，shakeAmp 调节幅度）
//
//  4. 淡出模式（fade / fadeStyle）：
//     - 'shrink'(默认) | 'char_first' | 'char_last' | 'blink' | 'shatter'(逐字碎片化崩解飞散) | 'blur'(柔和失焦虚化淡出) | 'split'(裂解重影淡出) | 'random'
//
//  5. 字距、外圈发光与局部富文本样式（全部默认关闭，不影响未开启时的性能）：
//     - letterSpacing (或 spacing): 额外字间距像素（默认 0 关闭）
//     - outline (或 glow): 'none'(默认) | 'stroke'(实心描边外圈，如黑底绿字) | 'glow'(柔和发光外圈)
//       配套 outlineColor (默认 0x000000) 与 outlineWidth (默认 0.75px)
//     - 局部加粗/放大/单字震动：支持内联标签 <b>...</b>、<big>...</big>（或 <scale=1.35>...</scale>）、
//       <shake>...</shake>、<noshake>...</noshake>、<outline=#000000>...</outline>、<glow=#55FFFF>...</glow>，
//       或传入 boldTarget / scaleTarget / shakeTarget 自动包裹指定词条
//
//  6. 位置、命名锚点与 HUD 禁区避让：
//     - pos 预设：'center'(默认) | 'top' | 'bottom' | 'left' | 'right' | 'top_left' | 'top_right' | 'bottom_left' | 'bottom_right'
//     - 命名 HUD 锚点：'below_minimap'(右上小地图下方) | 'above_hotbar'(底部快捷栏上方) | 'left_hud' | 'right_hud'
//     - 随机分布：'edge'(四边环带) | 'spread'(9宫格广域分散) | 'random'(全屏随机)
//     - HUD 禁区避让：'edge' / 'spread' / 'random' 默认开启 avoidHud: true（自动避开右上角小地图、底部快捷栏与中心准星），
//       支持通过 avoid: [[rx, ry, w, h], ...] 或预设名（'minimap' | 'hotbar' | 'crosshair'）追加自定义避让矩形。
// ============================================================================

;(function () {
    var SPEC  = (typeof global !== 'undefined') ? global.EpiphySpec : null
    var BASE  = (typeof global !== 'undefined') ? global.EpiphyServerBase : null
    var PROTO = (typeof global !== 'undefined' && global.EpiphyProtocol != null)
        ? global.EpiphyProtocol
        : (SPEC && SPEC.PROTOCOL ? SPEC.PROTOCOL : null)
    if (!SPEC || !PROTO || !BASE) {
        throw new Error('[ScreenDanmaku] 缺少硬依赖 (EpiphySpec / EpiphyServerBase)，请确认基础脚本已加载')
    }
    var LOGGER        = BASE.createLogger('ScreenDanmaku', 5000)
    var CHANNEL       = PROTO.DANMAKU_CHANNEL
    var PROTO_VERSION = PROTO.DANMAKU_PROTO_VERSION
    var SERVER_REF    = null
    var spreadCounter = 0

    var CONFIG = {
        debug:                 false,
        warnDeprecatedAliases: 'log',
        errorLogIntervalMs:    5000,
        avoidMaxRetries:       14,
        sizeMin:               0.2,
        sizeMax:               4.0,
        smallRandRange:        [0.55, 0.97],
        randSizeRange:         [0.58, 1.70]
    }

    // ------------------------------------------------------------------------
    // DEFAULTS 字段规范与双端契约对照表：
    //   规范字段名          | @deprecated 别名                    | 类型/范围             | 默认值    | 双端一致
    //   text               | title                               | string                | 必填      | ✓ 报文字段 title
    //   sub                | subtitle                            | string                | ''        | ✓
    //   pos                | position / preset                   | preset/edge/spread/random | 'center' | ✓ posTag
    //   rx, ry             | -                                   | number [0, 1]         | 0.5, 0.32 | ✓
    //   size               | @deprecated scale                   | number|range [0.2..4] | 1.0     | ✓
    //   tilt               | @deprecated angle                   | number|range [-180..180]| 0.0   | ✓ angle
    //   color, subColor    | -                                   | hex|rgb|'random'      | 0xFF5555/0xFFCC44 | ✓
    //   mode               | @deprecated typewriter              | 'all'|'char'          | 'all'     | ✓ typewriter (boolean)
    //   charMs             | -                                   | int >= 8 (ms)         | 30        | ✓
    //   cursor             | -                                   | string                | '▌'       | ✓
    //   shake              | @deprecated shakeMode / jitter      | string                | 'none'    | ✓
    //   shakeAmp           | -                                   | number >= 0           | 2.5       | ✓
    //   charShakeStyle     | @deprecated shakeStyle              | 'omni'|'horizontal_step'|'smooth' | 'omni' | ✓
    //   charShakeFreq      | shakeFreq                           | [800, 800] ms         | 800       | ✓ (client charShakeDefaultMin/Max=800)
    //   fade               | @deprecated fadeStyle               | string                | 'shrink'  | ✓ fadeStyle
    //   fadeOut            | -                                   | ticks >= 0            | 10        | ✓
    //   letterSpacing      | @deprecated charSpacing / spacing   | number [-2, 24]       | 0         | ✓
    //   outline            | @deprecated outlineMode             | 'none'|'stroke'|'glow'|'mui_stroke'| 'none' | ✓
    //   lifeMode           | -                                   | 'once'|'active'       | 'once'    | ✓
    //   priority           | @deprecated importance              | 0..10                 | 2 / 5     | ✓ (client fallback 2 / 5)
    //   group / namespace  | @deprecated ns                      | string                | 'default'/''| ✓
    //   id                 | @deprecated slot                    | string                | ''        | ✓ slotId
    //   key                | -                                   | string                | ''        | ✓
    //   movable            | @deprecated move / updatePos        | boolean               | false     | ✓
    //   restart            | @deprecated resetAnimation          | boolean               | false     | ✓
    //   maxGroup           | @deprecated maxGroupSize/groupLimit/maxConcurrent | int >= 0 | 0     | ✓
    //   maxWidth / wrap / clamp / shadow / showInGui / avoidOverlap / normalizeKey | - | boolean/num | 见下表 | ✓
    //   conflictMode       | @deprecated sourceConflict/overlapMode| 'overlap'|'merge'|'nearest'|'first'|'latest'|'stagger'|'overlap'| 服务端独占
    // ------------------------------------------------------------------------
    var DEFAULTS = {
        group:          'default',
        sub:            '',
        pos:            'center',
        rx:             0.50,
        ry:             0.32,
        size:           1.0,
        tilt:           0.0,
        color:          0xFF5555,
        subColor:       0xFFCC44,
        mode:           'all',     // 'all' | 'char'
        charMs:         30,
        cursor:         '▌',
        shake:          'none',    // 'none' | 'constant' | 'decay' | 'fade_in' | 'pulse' | 'per_char' | 'random'
        shakeAmp:       2.5,
        charShakeAmp:   0.65,      // 'per_char' 模式下的默认幅度（亚像素微抖动，清晰可见且绝不互相错位）
        charShakeStyle:  'omni',   // 'per_char' 子模式：'omni'(全向脉冲) | 'horizontal_step'(周期微位移+水平晃动) | 'smooth'(连续慢漂)
        charShakeShift:  0.32,     // 'horizontal_step' 每周期随机微位移默认倍率（0 关闭）
        charShakeShiftX: null,     // 可单独指定水平落点位移幅度倍率（未传时取 charShakeShift）
        charShakeShiftY: null,     // 可单独指定垂直落点位移幅度倍率（未传时取 charShakeShift * 0.75）
        charShakeSwayX:  0.88,     // 'horizontal_step' 水平方向位移晃动倍率
        charShakeSwayY:  0.0,      // 'horizontal_step' 垂直方向位移晃动倍率
        charShakeRotDeg:     0.0,      // 单字朝向（角度）晃动最大偏转角（度，如 7.5）
        charShakeWin:        0.38,     // 周期初段晃动窗口占比 [0.05, 1.0]
        charShakeSnap:       false,    // 'horizontal_step' 周期切换时：false=平滑过渡位移，true=直接瞬移
        charShakeTransition: 'smooth', // 'smooth'(默认0.16过渡) | 'snap'/'instant'(瞬移) | '0.05'~'1.0'(自定义过渡窗口占比)
        avoidOverlap:    true,     // 'spread'/'random'/'edge' 是否尽量避开同组近期弹幕位置
        minSepX:         0.26,     // 同组弹幕防重叠水平最小参考间距（归一化屏幕宽）
        minSepY:         0.20,     // 同组弹幕防重叠垂直最小参考间距（归一化屏幕高）
        shakeFreqMin:   800,       // 'per_char' 模式下单字默认最小震动周期 (ms，默认 0.8s 统一同步)
        shakeFreqMax:   800,       // 'per_char' 模式下单字默认最大震动周期 (ms，传区间时可设为不同值)
        fade:           'shrink',  // 'shrink' | 'char_first' | 'char_last' | 'blink' | 'shatter' | 'blur' | 'split' | 'random'
        fadeOut:           10,        // 淡出持续时间（tick）
        letterSpacing:     0,         // 额外字间距（默认 0 关闭）
        letterSpacingMode: 'relative',// 'relative'(按字素宽度等比缩放，中英文观感一致) | 'fixed'(固定像素)
        outlineMode:       'none',    // 外圈模式：'none'(默认关闭) | 'stroke'(描边外圈) | 'glow'(发光外圈) | 'mui_stroke'(ModernUI单Pass SDF描边，无ModernUI时自动回退stroke)
        outlineColor:   0x000000,  // 外圈默认颜色（黑色描边或自定义发光色）
        outlineWidth:   0.75,      // 外圈默认半径（亚像素级 0.75px）
        lifeMode:       'once',    // 'once' | 'active'
        priority:       2,
        activePriority: 5,
        movable:        false,
        normalizeKey:   true,      // 自动 key 是否归并动态数值
        avoidHud:       true,      // 随机采样位置时默认避开右上小地图、底部快捷栏与中心准星
        duration:       65,        // 单次触发默认维持时间（tick，不含打字机补偿，由客户端统一计算）
        activeHold:     28,        // 持续激活单次心跳维持窗口（tick）
        radius:         64,
        shadow:         true,
        wrap:           true,
        clamp:          true,
        maxWidth:       0,
        maxGroup:            0,         // 同组同屏最大并发弹幕数（0 表示不额外限制）
        showInGui:           false,
        screenRenderPriority: 0,        // 独立画面层叠渲染优先级（默认高于低层、低于 GUI）
        guiRenderPriority:    100,      // GUI 承载面默认渲染优先级（不被 screen 弹幕覆盖，可独立调整）
        slotRenderPriority:   200       // 槽位承载面默认渲染优先级（位于 GUI 图层上方）
    }

    var PRIORITY_MAP = PROTO.PRIORITY_MAP

    // 内置 HUD 常见禁区（归一化矩形 { x, y, w, h }，从 EpiphyProtocol 读取单一真相源）
    var HUD_FORBIDDEN_PRESETS = PROTO.HUD_FORBIDDEN_PRESETS

    var DEFAULT_HUD_AVOID_LIST = [
        HUD_FORBIDDEN_PRESETS.minimap,
        HUD_FORBIDDEN_PRESETS.hotbar,
        HUD_FORBIDDEN_PRESETS.crosshair
    ]

    var POS_PRESETS = {
        center:        { rx: 0.50, ry: 0.34, spreadX: 0.04, spreadY: 0.04 },
        top:           { rx: 0.50, ry: 0.14, spreadX: 0.18, spreadY: 0.05 },
        bottom:        { rx: 0.50, ry: 0.74, spreadX: 0.18, spreadY: 0.04 },
        left:          { rx: 0.18, ry: 0.45, spreadX: 0.08, spreadY: 0.22 },
        right:         { rx: 0.82, ry: 0.50, spreadX: 0.08, spreadY: 0.18 },
        top_left:      { rx: 0.18, ry: 0.16, spreadX: 0.08, spreadY: 0.07 },
        top_right:     { rx: 0.82, ry: 0.16, spreadX: 0.08, spreadY: 0.07 },
        bottom_left:   { rx: 0.18, ry: 0.74, spreadX: 0.08, spreadY: 0.07 },
        bottom_right:  { rx: 0.82, ry: 0.74, spreadX: 0.08, spreadY: 0.07 },
        below_minimap: { rx: 0.84, ry: 0.36, spreadX: 0.07, spreadY: 0.06 },
        above_hotbar:  { rx: 0.50, ry: 0.72, spreadX: 0.16, spreadY: 0.04 },
        left_hud:      { rx: 0.16, ry: 0.38, spreadX: 0.06, spreadY: 0.16 },
        right_hud:     { rx: 0.84, ry: 0.52, spreadX: 0.06, spreadY: 0.16 }
    }

    var SIZE_PRESETS  = SPEC.SIZE_PRESETS
    var COLOR_PRESETS = SPEC.COLOR_PRESETS

    var VALID_FADE_STYLES = {
        shrink:     'shrink',
        char_first: 'char_first',
        char:       'char_first',
        char_last:  'char_last',
        blink:      'blink',
        shatter:    'shatter',
        glitch:     'shatter',
        blur:       'blur',
        defocus:    'blur',
        '虚化':     'blur',
        split:      'split',
        clone:      'split',
        '裂解':     'split',
        '分解':     'split',
        random:     'random',
        rand:       'random'
    }

    function pick(obj, keys, defVal) {
        if (!BASE.isObjectLike(obj)) return defVal
        for (var i = 0; i < keys.length; i++) {
            var v = BASE.safeReadProp(obj, keys[i])
            if (v !== undefined && v !== null) return v
        }
        return defVal
    }

    function pickNonEmpty(obj, keys, defVal) {
        if (!BASE.isObjectLike(obj)) return defVal
        for (var i = 0; i < keys.length; i++) {
            var v = BASE.safeReadProp(obj, keys[i])
            if (v !== undefined && v !== null && String(v).trim() !== '') return v
        }
        return defVal
    }

    var nowNano = BASE.nowNano

    function reportConfigWarning(msg, notifyPlayer) {
        return LOGGER.warn('参数警告', msg, notifyPlayer, CONFIG.errorLogIntervalMs)
    }

    function reportCatch(tag, err) {
        return LOGGER.catchWarn(tag, err, null, CONFIG.errorLogIntervalMs)
    }

    var danmakuTickCounter   = 0
    var blockSourceSeq       = 0
    var boundMetaByBlockId   = new Map()
    var pendingLoginFlushes  = new Map() // uuid -> { uuid, player, dueTick }
    var playerSourceCooldown = new Map() // '<playerUuid>|<scopeKey>' -> expireTick

    var lastEmitMs            = 0
    var maxEmitMs             = 0
    var emitCallCount         = 0
    var curEmitCycleTick      = -1
    var curEmitCycleAccumMs   = 0
    var curEmitCycleActive    = false
    var lastEmitCycleMs       = 0
    var lastActiveEmitCycleMs = 0
    var maxEmitCycleMs        = 0
    var emitCycleCount        = 0
    var lastEmitCycleTick     = 0

    function recordEmitTelemetry(dtMs, dispatchedCount) {
        if (dtMs < 0 || !isFinite(dtMs)) return
        lastEmitMs = dtMs
        if (dtMs > maxEmitMs) maxEmitMs = dtMs
        emitCallCount++

        if (danmakuTickCounter !== curEmitCycleTick) {
            curEmitCycleTick    = danmakuTickCounter
            curEmitCycleAccumMs = 0
            curEmitCycleActive  = false
            emitCycleCount++
            lastEmitCycleTick = danmakuTickCounter
        }
        curEmitCycleAccumMs += dtMs
        if (dispatchedCount > 0) curEmitCycleActive = true
        lastEmitCycleMs = curEmitCycleAccumMs
        if (curEmitCycleActive) lastActiveEmitCycleMs = curEmitCycleAccumMs
        if (curEmitCycleAccumMs > maxEmitCycleMs) maxEmitCycleMs = curEmitCycleAccumMs
    }

    ServerEvents.tick(function (event) {
        if (SERVER_REF == null) SERVER_REF = event.server
        danmakuTickCounter++
        if (pendingLoginFlushes.size > 0) {
            var duePlayers = []
            pendingLoginFlushes.forEach(function (entry, uuid) {
                if (entry != null && danmakuTickCounter >= entry.dueTick) {
                    duePlayers.push({ uuid: uuid, player: entry.player })
                }
            })
            for (var fi = 0; fi < duePlayers.length; fi++) {
                var dp = duePlayers[fi]
                pendingLoginFlushes.delete(dp.uuid)
                flushTrackedBlocksForJoinedPlayer(dp.player)
            }
        }
        if ((danmakuTickCounter % 600) === 0 && playerSourceCooldown.size > 0) {
            playerSourceCooldown.forEach(function (exp, k) {
                if (exp <= danmakuTickCounter) playerSourceCooldown.delete(k)
            })
        }
    })

    function normalizeDanmakuConflictMode(raw, fallback) {
        var s = raw != null ? String(raw).trim().toLowerCase() : ''
        if (!s) return fallback || 'overlap'
        if (s === 'overlap') return 'overlap'
        if (s === 'allow' || s === 'none' || s === 'independent') {
            reportDeprecatedUsage('conflictMode:' + s, 'overlap', '旧版冲突仲裁枚举')
            return 'overlap'
        }
        if (s === 'merge') return 'merge'
        if (s === 'combine' || s === 'union' || s === 'throttle' || s === 'dedup') {
            reportDeprecatedUsage('conflictMode:' + s, 'merge', '旧版冲突仲裁枚举')
            return 'merge'
        }
        if (s === 'nearest') return 'nearest'
        if (s === 'closest') {
            reportDeprecatedUsage('conflictMode:' + s, 'nearest', '旧版冲突仲裁枚举')
            return 'nearest'
        }
        if (s === 'first') return 'first'
        if (s === 'oldest') {
            reportDeprecatedUsage('conflictMode:' + s, 'first', '旧版冲突仲裁枚举')
            return 'first'
        }
        if (s === 'latest') return 'latest'
        if (s === 'newest' || s === 'replace') {
            reportDeprecatedUsage('conflictMode:' + s, 'latest', '旧版冲突仲裁枚举')
            return 'latest'
        }
        if (s === 'stagger') return 'stagger'
        return fallback || 'overlap'
    }

    // 【catch 约定】以下 try/catch 均为 Java API 能力探测：不同 MC/Rhino 映射下字段名可能不一致，
    // 访问异常属于预期分支，且在高频调用路径中留空可避免污染限频桶与拖慢热路径。
    function resolveEventSourceScope(event, opts) {
        if (opts != null && typeof opts === 'object') {
            if (opts.sourceScope != null) return String(opts.sourceScope)
            if (opts.sourceKey != null) return String(opts.sourceKey)
            if (opts.conflictScope != null && opts.conflictScope !== 'block') return String(opts.conflictScope)
        }
        if (event != null) {
            if (event.block != null) {
                try {
                    if (event.block.id != null) return 'block:' + String(event.block.id)
                } catch (e0) { }
            }
            if (event.entity != null) {
                try {
                    if (event.entity.type != null) return 'entity:' + String(event.entity.type)
                } catch (e1) { }
            }
        }
        if (opts != null && typeof opts === 'object' && opts.group != null) {
            return 'group:' + String(opts.group)
        }
        return 'default'
    }

    function getPlayerUuidSafe(p) {
        return BASE.uuidOf(p) || BASE.nameOf(p) || 'unknown'
    }

    function prepareSourceConflictOpts(opts) {
        if (opts == null || typeof opts !== 'object') return opts
        var mode = normalizeDanmakuConflictMode(
            pick(opts, ['sourceConflict', 'conflictMode', 'overlapMode'], undefined),
            'overlap'
        )
        if (mode === 'latest' && opts.key == null) {
            var scopeKey = resolveEventSourceScope(null, opts)
            var copy = Object.assign({}, opts)
            copy.key = 'src:' + scopeKey
            if (copy.restart === undefined) copy.restart = true
            return copy
        }
        return opts
    }

    function allowSourceConflictForPlayer(p, opts) {
        if (opts == null || typeof opts !== 'object') return true
        var mode = normalizeDanmakuConflictMode(
            pick(opts, ['sourceConflict', 'conflictMode', 'overlapMode'], undefined),
            'overlap'
        )
        if (mode === 'overlap' || mode === 'latest') return true
        var cooldown = Number(pick(opts, ['sourceCooldownTicks', 'conflictCooldownTicks'], 40))
        if (!isFinite(cooldown) || cooldown < 1) cooldown = 40
        var scopeKey = resolveEventSourceScope(null, opts)
        var ck = getPlayerUuidSafe(p) + '|' + scopeKey
        var exp = playerSourceCooldown.get(ck)
        if (exp != null && danmakuTickCounter < exp) return false
        if (playerSourceCooldown.size >= 2048) {
            playerSourceCooldown.forEach(function (v, k) {
                if (v <= danmakuTickCounter) playerSourceCooldown.delete(k)
            })
            if (playerSourceCooldown.size >= 2048) playerSourceCooldown.clear()
        }
        playerSourceCooldown.set(ck, danmakuTickCounter + Math.floor(cooldown))
        return true
    }

    function shouldEmitDeprecationWarn() {
        if (CONFIG.warnDeprecatedAliases === false) return false
        if (CONFIG.warnDeprecatedAliases === true) return true
        // 默认 'log' 模式：受 EpiphyLog（/epiphy debug log deprecations on | danmaku on）或 CONFIG.debug 统一管控
        if (typeof LOGGER.isDeprecationEnabled === 'function' && LOGGER.isDeprecationEnabled()) return true
        return Boolean(CONFIG.debug)
    }

    function reportDeprecatedUsage(depKey, canonKey, kindLabel) {
        var hitKey = String(depKey || '')
        deprecatedAliasHits[hitKey] = (deprecatedAliasHits[hitKey] || 0) + 1
        if (!shouldEmitDeprecationWarn()) return
        var logApi = (typeof global !== 'undefined' && global != null) ? global.EpiphyLog : null
        var label = kindLabel || '旧版别名字段'
        var msg = '检测到已进入淘汰列表的' + label + ' `' + depKey + '`（已自动映射为标准写法 `' + canonKey + '`），请迁移至标准写法。'
        if (CONFIG.warnDeprecatedAliases !== true && logApi != null && typeof logApi.warnDeprecatedOnce === 'function') {
            logApi.warnDeprecatedOnce('ScreenDanmaku', 'deprecatedAlias:' + hitKey, msg)
        } else {
            LOGGER.once('warn', 'deprecatedAlias:' + hitKey, msg)
        }
    }

    function parsePriority(val, defVal) {
        return SPEC.parsePriority(val, defVal, {
            map:           PRIORITY_MAP,
            deprecatedMap: SPEC.DEPRECATED_PRIORITY_ALIASES,
            min:           0,
            max:           10,
            onDeprecated:  function (depKey, canonName) {
                reportDeprecatedUsage('priority:' + depKey, 'priority=' + canonName, '旧版优先级别名')
            }
        })
    }

    function parseFiniteNum(val, defVal) {
        var n = SPEC.parseFiniteNum(val)
        return n !== null ? n : defVal
    }

    function parseNonNegNum(val, defVal, minVal) {
        var n = SPEC.parseNonNegNum(val)
        if (n === null) return defVal
        var floor = (minVal != null && isFinite(minVal)) ? minVal : 0
        return Math.max(floor, n)
    }

    function sanitizeMaxWidth(val) {
        var n = Number(val)
        if (val === undefined || val === null || val === '' || !isFinite(n) || n <= 0) return 0
        if (n <= 1.0) return Math.max(0.05, Math.min(1.0, n))
        return Math.max(16, Math.min(4096, Math.round(n)))
    }

    var parseTicksOrSec = SPEC.parseTicksOrSec

    function parseBool(val, defVal) {
        if (val === undefined || val === null || val === '') return defVal
        if (typeof val === 'number') return !isNaN(val) && val !== 0
        if (typeof val === 'string' && val.trim().toLowerCase() === 'none') return false
        var b = SPEC.parseBoolStrict(val)
        return b !== null ? b : defVal
    }

    function quantizeZoneTag(rx, ry) {
        var col = rx < 0.35 ? 'L' : (rx > 0.65 ? 'R' : 'C')
        var row = ry < 0.28 ? 'T' : (ry > 0.62 ? 'B' : 'M')
        return 'zone_' + row + col
    }

    function parseColor(val, defColor) {
        return SPEC.parseColor(val, defColor, COLOR_PRESETS)
    }

    function parseArgbColor(val, defColor) {
        if (typeof SPEC.parseArgbColor === 'function') {
            return SPEC.parseArgbColor(val, defColor, COLOR_PRESETS)
        }
        return SPEC.parseColor(val, defColor, COLOR_PRESETS, { preserveAlpha: true })
    }

    function isArrayLike(v, minLen) {
        if (!SPEC.isArrayLike(v)) return false
        return v.length >= (minLen || 2)
    }

    function parseSize(sizeVal, scaleVal) {
        return SPEC.parseSize(sizeVal, scaleVal, {
            sizeMin:           CONFIG.sizeMin,
            sizeMax:           CONFIG.sizeMax,
            smallRandRange:    CONFIG.smallRandRange,
            randSizeRange:     CONFIG.randSizeRange,
            sizePresets:       SIZE_PRESETS,
            defaultSize:       DEFAULTS.size,
            rejectNonPositive: true
        })
    }

    function parseTilt(tiltVal, angleVal, fallbackAngle) {
        var raw = (tiltVal !== undefined && tiltVal !== null && tiltVal !== '') ? tiltVal : angleVal
        if (typeof raw === 'string') {
            var s = raw.trim().toLowerCase()
            if (s === 'random' || s === 'rand') {
                if (Math.random() < 0.22) {
                    return Number(((Math.random() - 0.5) * 7.0).toFixed(1))
                }
                var sign = Math.random() < 0.5 ? -1 : 1
                return Number((sign * (5.0 + Math.random() * 23.0)).toFixed(1))
            }
            if (s === 'left') return Number((-10.0 - Math.random() * 15.0).toFixed(1))
            if (s === 'right') return Number((10.0 + Math.random() * 15.0).toFixed(1))
        }
        return SPEC.parseTilt(tiltVal, angleVal, fallbackAngle, DEFAULTS.tilt)
    }

    // 解析禁区避让列表：支持预设名（'minimap'|'hotbar'|'crosshair'|'bossbar'）、对象 {x,y,w,h} 或四元数组 [x,y,w,h]
    function buildAvoidRects(opts, includeDefaultHud) {
        var rects = []
        var useHud = parseBool(opts.avoidHud, includeDefaultHud)
        if (useHud) {
            for (var d = 0; d < DEFAULT_HUD_AVOID_LIST.length; d++) {
                rects.push(DEFAULT_HUD_AVOID_LIST[d])
            }
        }
        var rawAvoid = opts.avoid
        if (rawAvoid == null) return rects
        var list = (Array.isArray(rawAvoid) || (typeof rawAvoid === 'object' && typeof rawAvoid.length === 'number'))
            ? rawAvoid
            : [rawAvoid]
        // 若直接传入单条 [x, y, w, h] 数值四元组，包装为单元素数组
        if (list.length === 4 && typeof list[0] === 'number' && typeof list[1] === 'number') {
            list = [list]
        }
        for (var i = 0; i < list.length; i++) {
            var entry = list[i]
            if (entry == null) continue
            if (typeof entry === 'string') {
                var parts = entry.split(',')
                for (var p = 0; p < parts.length; p++) {
                    var k = parts[p].trim().toLowerCase()
                    if (HUD_FORBIDDEN_PRESETS[k]) rects.push(HUD_FORBIDDEN_PRESETS[k])
                }
            } else if (Array.isArray(entry) || isArrayLike(entry, 4)) {
                var ax = Number(entry[0]), ay = Number(entry[1]), aw = Number(entry[2]), ah = Number(entry[3])
                if (isFinite(ax) && isFinite(ay) && isFinite(aw) && isFinite(ah) && aw > 0 && ah > 0) {
                    rects.push({ x: ax, y: ay, w: aw, h: ah })
                }
            } else if (typeof entry === 'object' && entry.x != null && entry.y != null && entry.w != null && entry.h != null) {
                var ox = Number(entry.x), oy = Number(entry.y), ow = Number(entry.w), oh = Number(entry.h)
                if (isFinite(ox) && isFinite(oy) && isFinite(ow) && isFinite(oh) && ow > 0 && oh > 0) {
                    rects.push({ x: ox, y: oy, w: ow, h: oh })
                }
            }
        }
        return rects
    }

    function isPointInAvoidRects(rx, ry, rects) {
        for (var i = 0; i < rects.length; i++) {
            var r = rects[i]
            if (rx >= r.x && rx <= (r.x + r.w) && ry >= r.y && ry <= (r.y + r.h)) {
                return true
            }
        }
        return false
    }

    var RECENT_POS_BY_GROUP = {}
    var RECENT_POS_GROUP_COUNT = 0

    function pruneRecentPos(groupKey, nowMs) {
        var arr = RECENT_POS_BY_GROUP[groupKey]
        if (!arr || arr.length === 0) {
            if (arr != null) {
                delete RECENT_POS_BY_GROUP[groupKey]
                if (RECENT_POS_GROUP_COUNT > 0) RECENT_POS_GROUP_COUNT--
            }
            return []
        }
        var kept = []
        for (var i = 0; i < arr.length; i++) {
            if (arr[i].expireAt > nowMs) kept.push(arr[i])
        }
        if (kept.length === 0) {
            delete RECENT_POS_BY_GROUP[groupKey]
            if (RECENT_POS_GROUP_COUNT > 0) RECENT_POS_GROUP_COUNT--
            return []
        }
        RECENT_POS_BY_GROUP[groupKey] = kept
        return kept
    }

    function storeRecentPos(groupKey, entry, nowMs) {
        if (!groupKey) return
        if (!Object.prototype.hasOwnProperty.call(RECENT_POS_BY_GROUP, groupKey)) {
            if (RECENT_POS_GROUP_COUNT >= 128) {
                var gKeys = Object.keys(RECENT_POS_BY_GROUP)
                for (var gi = 0; gi < gKeys.length; gi++) {
                    pruneRecentPos(gKeys[gi], nowMs)
                }
                if (RECENT_POS_GROUP_COUNT >= 128 && gKeys.length > 0 && RECENT_POS_BY_GROUP[gKeys[0]] != null) {
                    delete RECENT_POS_BY_GROUP[gKeys[0]]
                    RECENT_POS_GROUP_COUNT--
                }
            }
            RECENT_POS_GROUP_COUNT++
        }
        var arr = pruneRecentPos(groupKey, nowMs)
        if (arr.length === 0 && !Object.prototype.hasOwnProperty.call(RECENT_POS_BY_GROUP, groupKey)) {
            RECENT_POS_GROUP_COUNT++
        }
        arr.push(entry)
        if (arr.length > 8) arr.shift()
        RECENT_POS_BY_GROUP[groupKey] = arr
    }

    function scoreSeparation(rx, ry, recentList, minSepX, minSepY) {
        if (!recentList || recentList.length === 0) return 999.0
        var sx = Math.max(0.05, minSepX || 0.26)
        var sy = Math.max(0.05, minSepY || 0.20)
        var worst = 999.0
        for (var i = 0; i < recentList.length; i++) {
            var r = recentList[i]
            var dx = (rx - r.rx) / sx
            var dy = (ry - r.ry) / sy
            var d2 = dx * dx + dy * dy
            if (d2 < worst) worst = d2
        }
        return worst
    }

    function sampleWithAvoidance(samplerFn, avoidRects, sepCtx) {
        var tries = CONFIG.avoidMaxRetries || 14
        var last  = null
        var best  = null
        var bestScore = -1.0
        var recent = (sepCtx && sepCtx.enabled) ? pruneRecentPos(sepCtx.group, Date.now()) : null
        for (var t = 0; t < tries; t++) {
            last = samplerFn()
            if (!isPointInAvoidRects(last.rx, last.ry, avoidRects)) {
                if (!recent || recent.length === 0) return last
                var sc = scoreSeparation(last.rx, last.ry, recent, sepCtx.minSepX, sepCtx.minSepY)
                if (sc >= 1.0) return last
                if (sc > bestScore) {
                    bestScore = sc
                    best = last
                }
            }
        }
        return best || last
    }

    function resolvePosition(opts) {
        if (opts.rx != null && opts.ry != null && opts.rx !== '' && opts.ry !== '' && isFinite(Number(opts.rx)) && isFinite(Number(opts.ry))) {
            var fixedX = Math.max(0.0, Math.min(1.0, Number(opts.rx)))
            var fixedY = Math.max(0.0, Math.min(1.0, Number(opts.ry)))
            return { rx: fixedX, ry: fixedY, presetAngle: null, posTag: quantizeZoneTag(fixedX, fixedY) }
        }
        if (Array.isArray(opts.pos) || isArrayLike(opts.pos, 2)) {
            var arrX = Math.max(0.0, Math.min(1.0, parseFiniteNum(opts.pos[0], 0.5)))
            var arrY = Math.max(0.0, Math.min(1.0, parseFiniteNum(opts.pos[1], 0.35)))
            return { rx: arrX, ry: arrY, presetAngle: null, posTag: quantizeZoneTag(arrX, arrY) }
        }
        if (opts.pos != null && typeof opts.pos === 'object' && opts.pos.rx != null && opts.pos.ry != null && isFinite(Number(opts.pos.rx)) && isFinite(Number(opts.pos.ry))) {
            var objX = Math.max(0.0, Math.min(1.0, Number(opts.pos.rx)))
            var objY = Math.max(0.0, Math.min(1.0, Number(opts.pos.ry)))
            return { rx: objX, ry: objY, presetAngle: opts.pos.angle, posTag: quantizeZoneTag(objX, objY) }
        }

        var posKey = (opts.pos !== undefined && opts.pos !== null && String(opts.pos).trim() !== '')
            ? String(opts.pos).trim().toLowerCase()
            : DEFAULTS.pos
        var sepGroup = String(opts.group != null && opts.group !== '' ? opts.group : DEFAULTS.group)
        var sepCtx = {
            enabled: parseBool(opts.avoidOverlap, DEFAULTS.avoidOverlap),
            group:   sepGroup,
            minSepX: parseNonNegNum(opts.minSepX, DEFAULTS.minSepX, 0.05),
            minSepY: parseNonNegNum(opts.minSepY, DEFAULTS.minSepY, 0.05)
        }
        var recordPickedPos = function (p) {
            if (!sepCtx.enabled || !p) return p
            var nowPick  = Date.now()
            var durTicks = parseNonNegNum(opts.duration, DEFAULTS.duration, 10)
            storeRecentPos(sepGroup, { rx: p.rx, ry: p.ry, expireAt: nowPick + durTicks * 50 + 3000 }, nowPick)
            return p
        }

        if (posKey === 'edge' || posKey === 'edges' || posKey === 'minor') {
            var edgeAvoid = buildAvoidRects(opts, DEFAULTS.avoidHud)
            var pickedEdge = recordPickedPos(sampleWithAvoidance(function () {
                var band = Math.floor(Math.random() * 4)
                var erx, ery
                if (band === 0) {
                    erx = 0.09 + Math.random() * 0.19
                    ery = 0.10 + Math.random() * 0.68
                } else if (band === 1) {
                    erx = 0.72 + Math.random() * 0.19
                    ery = 0.30 + Math.random() * 0.48
                } else if (band === 2) {
                    erx = 0.14 + Math.random() * 0.58
                    ery = 0.08 + Math.random() * 0.15
                } else {
                    erx = 0.14 + Math.random() * 0.72
                    ery = 0.66 + Math.random() * 0.12
                }
                return { rx: Number(erx.toFixed(3)), ry: Number(ery.toFixed(3)) }
            }, edgeAvoid, sepCtx))
            var randTilt = (Math.random() < 0.3) ? 0.0 : Number(((Math.random() - 0.5) * 26.0).toFixed(1))
            return { rx: pickedEdge.rx, ry: pickedEdge.ry, presetAngle: randTilt, posTag: 'edge' }
        }

        if (posKey === 'spread' || posKey === 'scatter' || posKey === 'wide') {
            var spreadAvoid = buildAvoidRects(opts, DEFAULTS.avoidHud)
            var pickedSpread = recordPickedPos(sampleWithAvoidance(function () {
                spreadCounter = (spreadCounter + 1 + Math.floor(Math.random() * 3)) % 9
                var cell = spreadCounter
                if (cell === 4 && Math.random() < 0.65) {
                    cell = (cell + 1 + Math.floor(Math.random() * 7)) % 9
                }
                var col = cell % 3
                var row = Math.floor(cell / 3)
                var srx = 0.10 + col * 0.27 + Math.random() * 0.25
                var sry = 0.09 + row * 0.24 + Math.random() * 0.21
                return { rx: Number(srx.toFixed(3)), ry: Number(sry.toFixed(3)) }
            }, spreadAvoid, sepCtx))
            return { rx: pickedSpread.rx, ry: pickedSpread.ry, presetAngle: null, posTag: 'spread' }
        }

        if (posKey === 'random' || posKey === 'rand') {
            var randAvoid = buildAvoidRects(opts, DEFAULTS.avoidHud)
            var pickedRand = recordPickedPos(sampleWithAvoidance(function () {
                return {
                    rx: Number((0.09 + Math.random() * 0.82).toFixed(3)),
                    ry: Number((0.08 + Math.random() * 0.70).toFixed(3))
                }
            }, randAvoid, sepCtx))
            return {
                rx: pickedRand.rx,
                ry: pickedRand.ry,
                presetAngle: null,
                posTag: 'random'
            }
        }

        if (posKey.indexOf(',') > 0) {
            var parts = posKey.split(',')
            var px = Number(parts[0])
            var py = Number(parts[1])
            if (isFinite(px) && isFinite(py)) {
                var cpx = Math.max(0.0, Math.min(1.0, px))
                var cpy = Math.max(0.0, Math.min(1.0, py))
                return { rx: cpx, ry: cpy, presetAngle: null, posTag: quantizeZoneTag(cpx, cpy) }
            }
        }

        var preset = POS_PRESETS[posKey] || POS_PRESETS.center
        return {
            rx: preset.rx + (Math.random() - 0.5) * preset.spreadX,
            ry: preset.ry + (Math.random() - 0.5) * preset.spreadY,
            presetAngle: null,
            posTag: POS_PRESETS[posKey] ? posKey : 'center'
        }
    }

    function resolveTypewriterMode(opts) {
        var twParsed = parseBool(opts.typewriter, null)
        if (twParsed !== null) return twParsed
        var bcParsed = parseBool(opts.byChar, null)
        if (bcParsed !== null) return bcParsed
        if (opts.mode != null && String(opts.mode).trim() !== '') {
            var m = String(opts.mode).trim().toLowerCase()
            if (m === 'char' || m === 'chars' || m === 'typewriter' || m === '逐字') return true
            if (m === 'all' || m === 'instant' || m === 'once' || m === '全部') return false
            if (m === 'random' || m === 'rand') return Math.random() < 0.5
        }
        return false
    }

    // 解析单字震动周期（支持毫秒或秒数，如 [800, 1300]、[0.8, 1.3]、'0.8~1.3'、'800-1300' 或单值）
    function parseShakeFreqMsVal(v) {
        if (v === undefined || v === null || String(v).trim() === '') return null
        var s = String(v).trim().toLowerCase()
        if (s.slice(-2) === 'ms') {
            var ms = Number(s.slice(0, -2))
            return (isFinite(ms) && ms > 0) ? Math.round(ms) : null
        }
        if (s.slice(-1) === 's') {
            var sec = Number(s.slice(0, -1))
            return (isFinite(sec) && sec > 0) ? Math.round(sec * 1000) : null
        }
        var n = Number(s)
        if (!isFinite(n) || n <= 0) return null
        // 若传入 <= 20 的小数值（例如 0.8、1.3），自动按秒转换为毫秒
        return (n <= 20) ? Math.round(n * 1000) : Math.round(n)
    }

    function resolveShakeFreqRange(opts) {
        var minMs = DEFAULTS.shakeFreqMin
        var maxMs = DEFAULTS.shakeFreqMax
        var rawFreq = opts.shakeFreq != null
            ? opts.shakeFreq
            : (opts.charShakeFreq != null ? opts.charShakeFreq : opts.shakeInterval)

        if (rawFreq != null) {
            if (Array.isArray(rawFreq) || isArrayLike(rawFreq, 2)) {
                var a0 = parseShakeFreqMsVal(rawFreq[0])
                var a1 = parseShakeFreqMsVal(rawFreq[1])
                if (a0 !== null && a1 !== null) {
                    minMs = Math.min(a0, a1)
                    maxMs = Math.max(a0, a1)
                } else if (a0 !== null) {
                    minMs = a0
                    maxMs = a0
                }
            } else if (typeof rawFreq === 'string' && (rawFreq.indexOf('~') > 0 || rawFreq.indexOf('-') > 0 || rawFreq.indexOf(',') > 0)) {
                var parts = rawFreq.split(/[~,\-]/)
                var p0 = parseShakeFreqMsVal(parts[0])
                var p1 = parseShakeFreqMsVal(parts[1])
                if (p0 !== null && p1 !== null) {
                    minMs = Math.min(p0, p1)
                    maxMs = Math.max(p0, p1)
                }
            } else {
                var single = parseShakeFreqMsVal(rawFreq)
                if (single !== null) {
                    // 传入单值（如 800 或 '0.8s'）时，minMs 与 maxMs 保持严格相等，使所有字符按同一周期统一同步触发抖动
                    minMs = Math.max(60, single)
                    maxMs = minMs
                }
            }
        }
        if (opts.shakeFreqMin != null) {
            var explicitMin = parseShakeFreqMsVal(opts.shakeFreqMin)
            if (explicitMin !== null) minMs = explicitMin
        }
        if (opts.shakeFreqMax != null) {
            var explicitMax = parseShakeFreqMsVal(opts.shakeFreqMax)
            if (explicitMax !== null) maxMs = explicitMax
        }
        minMs = Math.max(60, minMs)
        maxMs = Math.max(minMs, maxMs)
        return { minMs: minMs, maxMs: maxMs }
    }

    // 震动解析：支持 'none' | 'constant' | 'decay' | 'fade_in' | 'pulse' | 'per_char'(逐字独立震动，默认关闭) | 'random'
    function resolveShake(opts) {
        var rawMode     = opts.shakeMode != null ? opts.shakeMode : (opts.shake != null ? opts.shake : opts.jitter)
        var perCharFlag = parseBool(opts.perCharShake != null ? opts.perCharShake : opts.charShake, false)
        var freqRange   = resolveShakeFreqRange(opts)

        if (perCharFlag) {
            var pcAmp = parseNonNegNum(opts.shakeAmp, DEFAULTS.charShakeAmp, 0.0)
            return {
                jitter:       true,
                perCharShake: true,
                shakeMode:    'per_char',
                shakeAmp:     pcAmp,
                shakeFreqMin: freqRange.minMs,
                shakeFreqMax: freqRange.maxMs,
                isRandom:     false
            }
        }

        var amp = parseNonNegNum(opts.shakeAmp, DEFAULTS.shakeAmp, 0.0)

        if (rawMode === undefined || rawMode === null || rawMode === '') {
            return { jitter: false, perCharShake: false, shakeMode: 'none', shakeAmp: 0.0, shakeFreqMin: freqRange.minMs, shakeFreqMax: freqRange.maxMs, isRandom: false }
        }
        var boolMode = parseBool(rawMode, null)
        if (boolMode === false) {
            return { jitter: false, perCharShake: false, shakeMode: 'none', shakeAmp: 0.0, shakeFreqMin: freqRange.minMs, shakeFreqMax: freqRange.maxMs, isRandom: false }
        }
        if (boolMode === true && (typeof rawMode === 'boolean' || String(rawMode).trim().toLowerCase() !== '1')) {
            return { jitter: true, perCharShake: false, shakeMode: 'constant', shakeAmp: amp, shakeFreqMin: freqRange.minMs, shakeFreqMax: freqRange.maxMs, isRandom: false }
        }
        if (typeof rawMode === 'number' && isFinite(rawMode) && rawMode > 0) {
            return { jitter: true, perCharShake: false, shakeMode: 'constant', shakeAmp: Math.min(12.0, rawMode), shakeFreqMin: freqRange.minMs, shakeFreqMax: freqRange.maxMs, isRandom: false }
        }

        var s = String(rawMode).trim().toLowerCase()
        if (s === 'per_char' || s === 'perchar' || s === 'char' || s === 'char_shake' || s === '逐字' || s === '逐字震动') {
            if (s !== 'per_char') {
                reportDeprecatedUsage('shakeMode:' + s, 'per_char', '旧版震动枚举')
            }
            var charAmp = parseNonNegNum(opts.shakeAmp, DEFAULTS.charShakeAmp, 0.0)
            return {
                jitter:       true,
                perCharShake: true,
                shakeMode:    'per_char',
                shakeAmp:     charAmp,
                shakeFreqMin: freqRange.minMs,
                shakeFreqMax: freqRange.maxMs,
                isRandom:     false
            }
        }
        if (s === 'constant') {
            return { jitter: true, perCharShake: false, shakeMode: 'constant', shakeAmp: amp, shakeFreqMin: freqRange.minMs, shakeFreqMax: freqRange.maxMs, isRandom: false }
        }
        if (s === 'decay' || s === 'spawn' || s === 'impact') {
            if (s !== 'decay') reportDeprecatedUsage('shakeMode:' + s, 'decay', '旧版震动枚举')
            return { jitter: true, perCharShake: false, shakeMode: 'decay', shakeAmp: amp, shakeFreqMin: freqRange.minMs, shakeFreqMax: freqRange.maxMs, isRandom: false }
        }
        if (s === 'fade_in' || s === 'fadein' || s === 'before_fade') {
            if (s !== 'fade_in') reportDeprecatedUsage('shakeMode:' + s, 'fade_in', '旧版震动枚举')
            return { jitter: true, perCharShake: false, shakeMode: 'fade_in', shakeAmp: amp, shakeFreqMin: freqRange.minMs, shakeFreqMax: freqRange.maxMs, isRandom: false }
        }
        if (s === 'pulse' || s === 'wave') {
            if (s !== 'pulse') reportDeprecatedUsage('shakeMode:' + s, 'pulse', '旧版震动枚举')
            return { jitter: true, perCharShake: false, shakeMode: 'pulse', shakeAmp: amp, shakeFreqMin: freqRange.minMs, shakeFreqMax: freqRange.maxMs, isRandom: false }
        }
        if (s === 'random' || s === 'rand') {
            if (s !== 'random') reportDeprecatedUsage('shakeMode:' + s, 'random', '旧版震动枚举')
            var r = Math.random()
            if (r < 0.28) return { jitter: false, perCharShake: false, shakeMode: 'none', shakeAmp: 0.0, shakeFreqMin: freqRange.minMs, shakeFreqMax: freqRange.maxMs, isRandom: true }
            if (r < 0.48) return { jitter: true, perCharShake: false, shakeMode: 'decay', shakeAmp: amp, shakeFreqMin: freqRange.minMs, shakeFreqMax: freqRange.maxMs, isRandom: true }
            if (r < 0.68) return { jitter: true, perCharShake: false, shakeMode: 'fade_in', shakeAmp: amp, shakeFreqMin: freqRange.minMs, shakeFreqMax: freqRange.maxMs, isRandom: true }
            if (r < 0.84) return { jitter: true, perCharShake: false, shakeMode: 'pulse', shakeAmp: amp, shakeFreqMin: freqRange.minMs, shakeFreqMax: freqRange.maxMs, isRandom: true }
            return { jitter: true, perCharShake: false, shakeMode: 'constant', shakeAmp: amp * 0.8, shakeFreqMin: freqRange.minMs, shakeFreqMax: freqRange.maxMs, isRandom: true }
        }

        var num = Number(s)
        if (isFinite(num) && num > 0) {
            return { jitter: true, perCharShake: false, shakeMode: 'constant', shakeAmp: Math.min(12.0, num), shakeFreqMin: freqRange.minMs, shakeFreqMax: freqRange.maxMs, isRandom: false }
        }
        return { jitter: false, perCharShake: false, shakeMode: 'none', shakeAmp: 0.0, shakeFreqMin: freqRange.minMs, shakeFreqMax: freqRange.maxMs, isRandom: false }
    }

    function resolveFadeStyle(opts) {
        var raw = opts.fadeStyle != null ? opts.fadeStyle : (opts.fade != null ? opts.fade : opts.fadeMode)
        if (raw === undefined || raw === null || String(raw).trim() === '') {
            return DEFAULTS.fade
        }
        var s = String(raw).trim().toLowerCase()
        var mapped = VALID_FADE_STYLES[s] || DEFAULTS.fade
        if (VALID_FADE_STYLES[s] && s !== mapped) {
            reportDeprecatedUsage('fadeStyle:' + s, mapped, '旧版淡出枚举')
        }
        return mapped
    }

    // 解析字体外圈与发光配置（默认关闭 'none'）
    function resolveOutline(opts, mainColor) {
        var rawOut  = opts.outlineMode != null ? opts.outlineMode : opts.outline
        var rawGlow = opts.glow
        var mode    = 'none'
        var colRaw  = opts.outlineColor != null ? opts.outlineColor : opts.glowColor
        var wRaw    = opts.outlineWidth != null ? opts.outlineWidth : opts.glowWidth

        if (rawGlow !== undefined && rawGlow !== null && rawGlow !== '' && rawGlow !== false) {
            var glowBool = parseBool(rawGlow, null)
            if (glowBool === true) {
                mode = 'glow'
            } else if (glowBool !== false) {
                mode = 'glow'
                if (colRaw == null) colRaw = rawGlow
            }
        }

        if (rawOut !== undefined && rawOut !== null && rawOut !== '' && rawOut !== false) {
            var outStr = String(rawOut).trim().toLowerCase()
            var outBool = parseBool(rawOut, null)
            if (outBool === false || outStr === 'none' || outStr === 'off') {
                if (outStr === 'off') reportDeprecatedUsage('outlineMode:off', 'none', '旧版外圈枚举')
                mode = 'none'
            } else if (outStr === 'mui_stroke' || outStr === 'sdf_stroke') {
                if (outStr === 'sdf_stroke') reportDeprecatedUsage('outlineMode:sdf_stroke', 'mui_stroke', '旧版外圈枚举')
                mode = 'mui_stroke'
            } else if (outBool === true || outStr === 'stroke' || outStr === 'border' || outStr === 'outline' || outStr === '描边' || outStr === '外圈') {
                if (outStr !== 'stroke') reportDeprecatedUsage('outlineMode:' + outStr, 'stroke', '旧版外圈枚举')
                mode = 'stroke'
            } else if (outStr === 'glow' || outStr === 'halo' || outStr === '发光') {
                if (outStr !== 'glow') reportDeprecatedUsage('outlineMode:' + outStr, 'glow', '旧版外圈枚举')
                mode = 'glow'
            } else {
                // 淘汰列表：向 outline 直接传颜色码的隐式重载
                reportDeprecatedUsage('outline:' + outStr, "outlineMode:'stroke', outlineColor:'" + rawOut + "'", '旧版外圈隐式重载')
                mode = 'stroke'
                if (colRaw == null) colRaw = rawOut
            }
        }

        var defCol = (mode === 'glow') ? (mainColor & 0xFFFFFF) : DEFAULTS.outlineColor
        var colInfo = parseColor(colRaw, defCol)
        var widthVal = Math.max(0.25, Math.min(3.0, parseNonNegNum(wRaw, DEFAULTS.outlineWidth, 0.25)))
        return {
            mode:  mode,
            color: colInfo.color,
            width: Number(widthVal.toFixed(2))
        }
    }

    function wrapTargetSubstring(text, targetOrList, openTag, closeTag) {
        if (!text || targetOrList == null || targetOrList === '') return text
        var list = (Array.isArray(targetOrList) || isArrayLike(targetOrList, 1)) ? targetOrList : [targetOrList]
        var out  = String(text)
        for (var i = 0; i < list.length; i++) {
            var needle = list[i] != null ? String(list[i]) : ''
            if (needle.length === 0) continue
            if (out.indexOf(needle) >= 0) {
                out = out.split(needle).join(openTag + needle + closeTag)
            }
        }
        return out
    }

    function applyTargetStyleTags(text, opts) {
        var s = text
        if (opts.boldTarget != null && opts.boldTarget !== '') {
            s = wrapTargetSubstring(s, opts.boldTarget, '<b>', '</b>')
        }
        if (opts.scaleTarget != null && opts.scaleTarget !== '') {
            var tScale = Math.max(0.4, Math.min(3.0, parseFiniteNum(opts.targetScale, 1.35)))
            s = wrapTargetSubstring(s, opts.scaleTarget, '<scale=' + tScale + '>', '</scale>')
        }
        if (opts.shakeTarget != null && opts.shakeTarget !== '') {
            s = wrapTargetSubstring(s, opts.shakeTarget, '<shake>', '</shake>')
        }
        return s
    }

    // 服务端仅解析调用方显式请求的 lifeMode 与基础维持 tick（stay / activeHold），
    // 不再预叠加 minTypeTicks + fadeTicks，由客户端 computeOverlaySchedule 单一权威计算。
    function resolveLifetime(opts) {
        var isContinuous = parseBool(opts.continuous, false) || parseBool(opts.sustained, false)
        var isScreenSession = false
        var lmRaw = opts.lifeMode != null ? opts.lifeMode : opts.existMode
        if (lmRaw != null && String(lmRaw).trim() !== '') {
            var lm = String(lmRaw).trim().toLowerCase()
            if (lm === 'screen_session') {
                isScreenSession = true
            } else if (lm === 'active' || lm === 'continuous' || lm === 'sustain' || lm === 'hold' || lm === '持续' || parseBool(lmRaw, false)) {
                if (lm !== 'active' && parseBool(lmRaw, null) !== true) {
                    reportDeprecatedUsage('lifeMode:' + lm, 'active', '旧版生命周期枚举')
                }
                isContinuous = true
            }
        }

        var durRaw = opts.duration != null ? opts.duration : (opts.existTime != null ? opts.existTime : opts.stay)
        if (durRaw != null && String(durRaw).trim() !== '') {
            var ds = String(durRaw).trim().toLowerCase()
            if (ds === 'active' || ds === 'continuous' || ds === 'sustain' || ds === 'hold' || ds === '持续') {
                reportDeprecatedUsage('duration=' + ds, "lifeMode:'active'", '旧版时长重载')
                isContinuous = true
                durRaw = null
            }
        }

        var parsedDur     = parseTicksOrSec(durRaw)
        var hasCustomDur  = (parsedDur !== null)
        var ticks         = hasCustomDur ? parsedDur : DEFAULTS.duration
        var customHoldRaw = opts.activeHold != null ? opts.activeHold : opts.holdTicks
        var parsedHold    = parseTicksOrSec(customHoldRaw)

        if (isScreenSession) {
            var sessHold = (parsedHold !== null) ? parsedHold : (hasCustomDur ? ticks : 7200)
            var effSess  = Math.max(4, sessHold)
            return { lifeMode: 'screen_session', stay: effSess, activeHold: effSess }
        }
        if (isContinuous) {
            var hold = (parsedHold !== null)
                ? parsedHold
                : (hasCustomDur ? ticks : DEFAULTS.activeHold)
            var effHold = Math.max(4, hold)
            return { lifeMode: 'active', stay: effHold, activeHold: effHold }
        }
        return {
            lifeMode:   'once',
            stay:       Math.max(4, ticks),
            activeHold: (parsedHold !== null) ? Math.max(4, parsedHold) : DEFAULTS.activeHold
        }
    }

    function normalizeOptionsObject(optsOrText) {
        if (typeof optsOrText === 'string') {
            var placeholder = '\uE000'
            var escaped     = optsOrText.replace(/\\\|/g, placeholder)
            var pipeIdx     = escaped.indexOf('|')
            if (pipeIdx >= 0) {
                return {
                    text: escaped.substring(0, pipeIdx).replace(/\uE000/g, '|').trim(),
                    sub:  escaped.substring(pipeIdx + 1).replace(/\uE000/g, '|').trim()
                }
            }
            return { text: escaped.replace(/\uE000/g, '|') }
        }
        return optsOrText
    }

    var SYSTEM_PACKET_LIMITS = {
        maxTitleLen:          4096,
        maxSubLen:            2048,
        maxCursorLen:         16,
        maxScale:             8.0,
        maxStayTicks:         72000,
        maxFadeOutTicks:      1200,
        maxCharMs:            2000,
        maxPlayerOverlayCost: 24,
        maxSystemOverlayCost: 96,
        maxNodeDepth:         4
    }

    var VALID_SURFACES   = { screen: true, gui: true, slot: true, world_plane: true }
    var VALID_CLIP_DIRS  = { left: true, right: true, down: true, up: true, center_x: true }
    var VALID_FILL_MODES = { solid: true, outline: true, gradient: true, parallax: true, shader: true }
    var VALID_NODE_TYPES = { text: true, rect: true, sprite: true, nine_slice: true, item: true, group: true }
    var VALID_ANCHORS    = { center: true, top_left: true, left: true, top_right: true, right: true }
    var VALID_PROC_KINDS = { texture: true, gradient: true, stripes: true, ripples: true, particles: true, steps: true }
    var deprecatedAliasHits = {}

    function sanitizeVarOrColor(val, defColor) {
        if (typeof val === 'string' && val.charAt(0) === '$') return val
        return parseArgbColor(val, defColor).color
    }

    function sanitizeVarOrNum(val, defNum, minVal, maxVal) {
        if (typeof val === 'string' && val.charAt(0) === '$') return val
        var n = parseFiniteNum(val, defNum)
        if (minVal != null && n < minVal) n = minVal
        if (maxVal != null && n > maxVal) n = maxVal
        return n
    }

    function sanitizeClipSpec(clip) {
        if (clip == null || typeof clip !== 'object') return null
        var dir = String(clip.dir || 'left').trim().toLowerCase()
        if (!VALID_CLIP_DIRS[dir]) dir = 'left'
        var mode = String(clip.mode || 'local').trim().toLowerCase() === 'scissor' ? 'scissor' : 'local'
        var ratio = clip.ratio
        if (typeof ratio === 'string' && ratio.charAt(0) === '$') {
            return { dir: dir, ratio: ratio, mode: mode }
        }
        return {
            dir:   dir,
            ratio: Math.max(0.0, Math.min(1.0, parseFiniteNum(ratio, 1.0))),
            mode:  mode
        }
    }

    function sanitizeAffinePropBind(spec) {
        if (spec == null || typeof spec !== 'object' || !spec.var) return null
        var out = {
            var:  String(spec.var).replace(/^\$/, ''),
            mult: parseFiniteNum(spec.mult !== undefined ? spec.mult : spec.span, 0.0)
        }
        if (spec.offset !== undefined) out.offset = parseFiniteNum(spec.offset, 0.0)
        if (spec.min !== undefined) out.min = parseFiniteNum(spec.min, 0.0)
        if (spec.max !== undefined) out.max = parseFiniteNum(spec.max, 1.0)
        return out
    }

    function sanitizeNodeBind(rawBind) {
        if (rawBind == null || typeof rawBind !== 'object') return null
        var out = {}
        var hasField = false
        var propKeys = ['x', 'y', 'w', 'h', 'alpha', 'angle']
        for (var pi = 0; pi < propKeys.length; pi++) {
            var pk = propKeys[pi]
            var bSpec = sanitizeAffinePropBind(rawBind[pk])
            if (bSpec != null) {
                out[pk] = bSpec
                hasField = true
            }
        }
        if (rawBind.stepHz !== undefined) {
            out.stepHz = Math.max(0, Math.min(60, parseFiniteNum(rawBind.stepHz, 0)))
            hasField = true
        }
        if (rawBind.seed !== undefined) {
            out.seed = Math.round(parseFiniteNum(rawBind.seed, 0))
            hasField = true
        }
        if (rawBind.jitterX !== undefined) { out.jitterX = Math.max(-256, Math.min(256, parseFiniteNum(rawBind.jitterX, 0))); hasField = true }
        if (rawBind.jitterY !== undefined) { out.jitterY = Math.max(-256, Math.min(256, parseFiniteNum(rawBind.jitterY, 0))); hasField = true }
        if (rawBind.jitterW !== undefined) { out.jitterW = Math.max(-256, Math.min(256, parseFiniteNum(rawBind.jitterW, 0))); hasField = true }
        if (rawBind.jitterH !== undefined) { out.jitterH = Math.max(-256, Math.min(256, parseFiniteNum(rawBind.jitterH, 0))); hasField = true }
        if (rawBind.impulseVar !== undefined) { out.impulseVar = String(rawBind.impulseVar).replace(/^\$/, ''); hasField = true }
        if (rawBind.shakeX !== undefined) { out.shakeX = Math.max(0, Math.min(64, parseFiniteNum(rawBind.shakeX, 0))); hasField = true }
        if (rawBind.shakeY !== undefined) { out.shakeY = Math.max(0, Math.min(64, parseFiniteNum(rawBind.shakeY, 0))); hasField = true }
        if (rawBind.rotSpeed !== undefined) { out.rotSpeed = Math.max(-720, Math.min(720, parseFiniteNum(rawBind.rotSpeed, 0))); hasField = true }
        return hasField ? out : null
    }

    function sanitizeRectFill(fill, rawNodeColor) {
        if (fill == null || typeof fill !== 'object') {
            return {
                mode:  'solid',
                color: sanitizeVarOrColor(rawNodeColor !== undefined ? rawNodeColor : 0xFF000000, 0xFF000000)
            }
        }
        var mode = String(fill.mode || 'solid').trim().toLowerCase()
        if (!VALID_FILL_MODES[mode]) mode = 'solid'
        if (mode === 'outline') {
            return {
                mode:      'outline',
                color:     sanitizeVarOrColor(fill.color !== undefined ? fill.color : rawNodeColor, 0xFFFFFFFF),
                thickness: Math.max(1, Math.min(16, Math.round(parseFiniteNum(fill.thickness, 1))))
            }
        }
        if (mode === 'gradient') {
            var rawGDir = String(fill.dir || '').trim().toLowerCase()
            var usedSchemaGradCols = (fill.color !== undefined || fill.colorEnd !== undefined) && fill.from === undefined && fill.to === undefined
            var gDir = (rawGDir === 'v' || rawGDir === 'vertical' || (!rawGDir && usedSchemaGradCols)) ? 'v' : 'h'
            var fromCol = sanitizeVarOrColor(fill.from !== undefined ? fill.from : (fill.color !== undefined ? fill.color : rawNodeColor), 0xFF5555)
            var toCol   = sanitizeVarOrColor(fill.to !== undefined ? fill.to : (fill.colorEnd !== undefined ? fill.colorEnd : fromCol), 0xFFAA00)
            var gOut    = { mode: 'gradient', dir: gDir, from: fromCol, to: toCol }
            if (fill.mid !== undefined) {
                gOut.mid    = sanitizeVarOrColor(fill.mid, toCol)
                gOut.midPos = Math.max(0.05, Math.min(0.95, parseFiniteNum(fill.midPos, 0.62)))
            }
            return gOut
        }
        if (mode === 'parallax') {
            var rawLayers = Array.isArray(fill.layers) ? fill.layers : []
            var layers = []
            var texLayerCount = 0
            for (var li = 0; li < rawLayers.length && layers.length < 6; li++) {
                var rl = rawLayers[li]
                if (rl == null || typeof rl !== 'object') continue
                var kindStr = rl.kind ? String(rl.kind).trim().toLowerCase() : ''
                if (kindStr && !VALID_PROC_KINDS[kindStr]) kindStr = 'texture'
                var layerTexStr = String(rl.tex || rl.texture || '')
                var hasTex = (layerTexStr.length > 0 || (fill.texture || fill.tex)) && (!kindStr || kindStr === 'texture')
                if (hasTex) {
                    if (texLayerCount >= 4) continue
                    texLayerCount++
                }
                var layOut = {
                    tex:      layerTexStr,
                    speedX:   parseFiniteNum(rl.speedX !== undefined ? rl.speedX : rl.scrollU, 0.0),
                    speedY:   parseFiniteNum(rl.speedY !== undefined ? rl.speedY : rl.scrollV, 0.0),
                    scale:    Math.max(0.1, Math.min(16.0, parseFiniteNum(rl.scale, 1.0))),
                    rotSpeed: parseFiniteNum(rl.rotSpeed, 0.0),
                    alpha:    Math.max(0.0, Math.min(1.0, parseFiniteNum(rl.alpha, 1.0)))
                }
                if (kindStr) layOut.kind = kindStr
                if (rl.u !== undefined) layOut.u = parseFiniteNum(rl.u, 0)
                if (rl.v !== undefined) layOut.v = parseFiniteNum(rl.v, 0)
                if (rl.uw !== undefined) layOut.uw = parseFiniteNum(rl.uw, 128)
                if (rl.vh !== undefined) layOut.vh = parseFiniteNum(rl.vh, 64)
                if (rl.parallax !== undefined) layOut.parallax = parseFiniteNum(rl.parallax, 0.0)
                if (rl.pulseHz !== undefined) layOut.pulseHz = Math.max(0, Math.min(30, parseFiniteNum(rl.pulseHz, 0.0)))
                if (rl.color !== undefined) layOut.color = sanitizeVarOrColor(rl.color, 0xFFFFFFFF)
                if (rl.altColor !== undefined) layOut.altColor = sanitizeVarOrColor(rl.altColor, 0x80FFFFFF)
                if (rl.from !== undefined) layOut.from = sanitizeVarOrColor(rl.from, 0x174A5A)
                if (rl.mid !== undefined) layOut.mid = sanitizeVarOrColor(rl.mid, 0x26A69A)
                if (rl.to !== undefined) layOut.to = sanitizeVarOrColor(rl.to, 0x80DEEA)
                if (rl.midPos !== undefined) layOut.midPos = Math.max(0.05, Math.min(0.95, parseFiniteNum(rl.midPos, 0.62)))
                if (rl.step !== undefined) layOut.step = Math.max(2, Math.min(256, parseFiniteNum(rl.step, 18)))
                if (rl.width !== undefined) layOut.width = Math.max(1, Math.min(128, parseFiniteNum(rl.width, 6)))
                if (rl.skew !== undefined) layOut.skew = Math.max(-64, Math.min(64, parseFiniteNum(rl.skew, 7)))
                if (rl.rows !== undefined) layOut.rows = Math.max(1, Math.min(16, Math.round(parseFiniteNum(rl.rows, 4))))
                if (rl.rowGap !== undefined) layOut.rowGap = Math.max(1, Math.min(64, parseFiniteNum(rl.rowGap, 3.5)))
                if (rl.offsetY !== undefined) layOut.offsetY = parseFiniteNum(rl.offsetY, 2.0)
                if (rl.segments !== undefined) layOut.segments = Math.max(1, Math.min(24, Math.round(parseFiniteNum(rl.segments, 6))))
                if (rl.baseLen !== undefined) layOut.baseLen = Math.max(2, Math.min(256, parseFiniteNum(rl.baseLen, 26)))
                if (rl.ampLen !== undefined) layOut.ampLen = Math.max(0, Math.min(128, parseFiniteNum(rl.ampLen, 15)))
                if (rl.thickness !== undefined) layOut.thickness = Math.max(0.5, Math.min(16, parseFiniteNum(rl.thickness, 1.2)))
                if (rl.count !== undefined) layOut.count = Math.max(1, Math.min(64, Math.round(parseFiniteNum(rl.count, 16))))
                if (rl.minW !== undefined) layOut.minW = Math.max(1, Math.min(32, parseFiniteNum(rl.minW, 1)))
                if (rl.maxW !== undefined) layOut.maxW = Math.max(1, Math.min(64, parseFiniteNum(rl.maxW, 4)))
                if (rl.stepHz !== undefined) layOut.stepHz = Math.max(0.5, Math.min(60, parseFiniteNum(rl.stepHz, 9)))
                if (rl.risers !== undefined) layOut.risers = Boolean(rl.risers)
                if (rl.seed !== undefined) layOut.seed = Math.round(parseFiniteNum(rl.seed, 0))
                layers.push(layOut)
            }
            var pOut = { mode: 'parallax', layers: layers }
            if (fill.texture || fill.tex) pOut.texture = String(fill.texture || fill.tex)
            if (fill.texW !== undefined || fill.tw !== undefined) pOut.tw = Math.max(1, parseFiniteNum(fill.texW !== undefined ? fill.texW : fill.tw, 256))
            if (fill.texH !== undefined || fill.th !== undefined) pOut.th = Math.max(1, parseFiniteNum(fill.texH !== undefined ? fill.texH : fill.th, 256))
            if (fill.maskTexture) pOut.maskTexture = String(fill.maskTexture)
            if (fill.bgColor !== undefined) pOut.bgColor = sanitizeVarOrColor(fill.bgColor, 0xFF0A0412)
            if (fill.bgAlpha !== undefined) pOut.bgAlpha = Math.max(0.0, Math.min(1.0, parseFiniteNum(fill.bgAlpha, 1.0)))
            if (fill.bloomWidth !== undefined) pOut.bloomWidth = Math.max(0, Math.min(128, parseFiniteNum(fill.bloomWidth, 0)))
            if (fill.bloomColor !== undefined) pOut.bloomColor = sanitizeVarOrColor(fill.bloomColor, 0xD8FFFFFF)
            return pOut
        }
        if (mode === 'shader') {
            var shName = String(fill.shader || fill.shaderId || 'end_portal')
            var sOut = {
                mode:          'shader',
                shader:        shName,
                shaderId:      shName,
                fallbackColor: sanitizeVarOrColor(fill.fallbackColor !== undefined ? fill.fallbackColor : rawNodeColor, 0x1A0033)
            }
            if (fill.maskTexture) sOut.maskTexture = String(fill.maskTexture)
            return sOut
        }
        return {
            mode:  'solid',
            color: sanitizeVarOrColor(fill.color !== undefined ? fill.color : rawNodeColor, 0xFF000000)
        }
    }

    function sanitizeNodesList(rawNodes, depth) {
        if (!Array.isArray(rawNodes) || depth > SYSTEM_PACKET_LIMITS.maxNodeDepth) return []
        var out = []
        for (var i = 0; i < rawNodes.length; i++) {
            var rn = rawNodes[i]
            if (rn == null || typeof rn !== 'object') continue
            var nType = String(rn.type || rn.kind || 'rect').trim().toLowerCase()
            if (!VALID_NODE_TYPES[nType]) continue
            var rawAnc = String(rn.anchor || 'center').trim().toLowerCase()
            var anchor = VALID_ANCHORS[rawAnc] ? rawAnc : 'center'
            var nodeColorVal = (rn.color !== undefined) ? rn.color : rn.tint
            var node = {
                id:     rn.id != null ? String(rn.id) : ('n' + i),
                type:   nType,
                x:      sanitizeVarOrNum(rn.x, 0, -4096, 4096),
                y:      sanitizeVarOrNum(rn.y, 0, -4096, 4096),
                anchor: anchor
            }
            if (rn.w !== undefined) node.w = sanitizeVarOrNum(rn.w, 0, 0, 4096)
            if (rn.h !== undefined) node.h = sanitizeVarOrNum(rn.h, 0, 0, 4096)
            if (rn.scale !== undefined || rn.size !== undefined) {
                node.scale = sanitizeVarOrNum(rn.scale !== undefined ? rn.scale : rn.size, 1.0, 0.1, SYSTEM_PACKET_LIMITS.maxScale)
            }
            if (rn.angle !== undefined || rn.tilt !== undefined) {
                node.angle = sanitizeVarOrNum(rn.angle !== undefined ? rn.angle : rn.tilt, 0.0, -360, 360)
            }
            if (rn.alpha !== undefined) {
                node.alpha = sanitizeVarOrNum(rn.alpha, 1.0, 0.0, 1.0)
            }
            var clipSpec = sanitizeClipSpec(rn.clip)
            if (clipSpec != null) node.clip = clipSpec
            var bindSpec = sanitizeNodeBind(rn.bind)
            if (bindSpec != null) node.bind = bindSpec

            if (nType === 'rect') {
                node.w    = node.w !== undefined ? node.w : 64
                node.h    = node.h !== undefined ? node.h : 8
                node.fill = sanitizeRectFill(rn.fill, nodeColorVal)
                if (nodeColorVal !== undefined) node.color = sanitizeVarOrColor(nodeColorVal, 0xFF000000)
                if (rn.borderColor !== undefined) node.borderColor = sanitizeVarOrColor(rn.borderColor, 0xFFFFFFFF)
                if (rn.borderWidth !== undefined) node.borderWidth = Math.max(0, Math.min(16, parseFiniteNum(rn.borderWidth, 1)))
            } else if (nType === 'sprite') {
                node.texture = String(rn.texture || rn.tex || '')
                node.w       = node.w !== undefined ? node.w : 16
                node.h       = node.h !== undefined ? node.h : 16
                node.u       = parseFiniteNum(rn.u, 0)
                node.v       = parseFiniteNum(rn.v, 0)
                node.uw      = parseFiniteNum(rn.uw, typeof node.w === 'number' ? node.w : 16)
                node.vh      = parseFiniteNum(rn.vh, typeof node.h === 'number' ? node.h : 16)
                node.tw      = Math.max(1, parseFiniteNum(rn.texW !== undefined ? rn.texW : rn.tw, 256))
                node.th      = Math.max(1, parseFiniteNum(rn.texH !== undefined ? rn.texH : rn.th, 256))
                if (nodeColorVal !== undefined) {
                    var normTint = sanitizeVarOrColor(nodeColorVal, 0xFFFFFFFF)
                    node.color = normTint
                    node.tint  = normTint
                }
            } else if (nType === 'nine_slice') {
                node.texture = String(rn.texture || rn.tex || '')
                node.w       = node.w !== undefined ? node.w : 64
                node.h       = node.h !== undefined ? node.h : 24
                if (Array.isArray(rn.slice) || (rn.slice != null && typeof rn.slice.length === 'number' && typeof rn.slice !== 'string')) {
                    var sl0 = Math.max(1, Math.min(64, Math.round(parseFiniteNum(rn.slice[0], 4))))
                    var sl1 = Math.max(1, Math.min(64, Math.round(parseFiniteNum(rn.slice[1], sl0))))
                    var sl2 = Math.max(1, Math.min(64, Math.round(parseFiniteNum(rn.slice[2], sl0))))
                    var sl3 = Math.max(1, Math.min(64, Math.round(parseFiniteNum(rn.slice[3], sl1))))
                    node.slice = [sl0, sl1, sl2, sl3]
                } else {
                    node.slice = Math.max(1, Math.min(64, Math.round(parseFiniteNum(rn.slice, 4))))
                }
                node.u       = parseFiniteNum(rn.u, 0)
                node.v       = parseFiniteNum(rn.v, 0)
                node.uw      = parseFiniteNum(rn.uw, 16)
                node.vh      = parseFiniteNum(rn.vh, 16)
                node.tw      = Math.max(1, parseFiniteNum(rn.texW !== undefined ? rn.texW : rn.tw, 256))
                node.th      = Math.max(1, parseFiniteNum(rn.texH !== undefined ? rn.texH : rn.th, 256))
            } else if (nType === 'item') {
                node.item  = String(rn.item || 'minecraft:air')
                node.count = Math.max(1, Math.round(parseFiniteNum(rn.count, 1)))
                if (rn.glint !== undefined) node.glint = Boolean(rn.glint)
            } else if (nType === 'text') {
                var rawNodeText = rn.text != null ? String(rn.text) : (rn.title != null ? String(rn.title) : '')
                node.text   = truncateSafeProtoText(rawNodeText.replace(/&([0-9a-fk-or])/gi, '§$1').replace(/\\n/g, '\n'), SYSTEM_PACKET_LIMITS.maxTitleLen)
                node.color  = sanitizeVarOrColor(nodeColorVal !== undefined ? nodeColorVal : DEFAULTS.color, DEFAULTS.color)
                node.shadow = rn.shadow !== undefined ? parseBool(rn.shadow, true) : true
                if (rn.outlineMode || rn.outline) node.outlineMode = String(rn.outlineMode || rn.outline).toLowerCase()
                if (rn.outlineColor !== undefined) node.outlineColor = parseColor(rn.outlineColor, -1).color
                if (rn.outlineWidth !== undefined) node.outlineWidth = Math.max(0.2, Math.min(2.5, parseFiniteNum(rn.outlineWidth, 0.72)))
                if (rn.typewriter !== undefined) node.typewriter = parseBool(rn.typewriter, false)
                if (rn.charMs !== undefined) node.charMs = Math.max(8, Math.min(SYSTEM_PACKET_LIMITS.maxCharMs, Math.round(parseFiniteNum(rn.charMs, 30))))
                if (rn.perCharShake !== undefined) node.perCharShake = parseBool(rn.perCharShake, false)
            } else if (nType === 'group') {
                var rawKids = Array.isArray(rn.children) ? rn.children : rn.items
                node.children = sanitizeNodesList(rawKids, depth + 1)
            }
            out.push(node)
        }
        return out
    }

    function sanitizeVarsMap(rawVars) {
        if (rawVars == null || typeof rawVars !== 'object') return {}
        var out = {}
        for (var k in rawVars) {
            if (!Object.prototype.hasOwnProperty.call(rawVars, k)) continue
            var v = rawVars[k]
            if (typeof v === 'number' && isFinite(v)) {
                out[k] = v
            } else if (typeof v === 'boolean') {
                out[k] = v
            } else if (v != null) {
                out[k] = truncateSafeProtoText(String(v), 256)
            }
        }
        return out
    }

    function sanitizeTracksMap(rawTracks) {
        if (rawTracks == null || typeof rawTracks !== 'object') return {}
        var out = {}
        for (var k in rawTracks) {
            if (!Object.prototype.hasOwnProperty.call(rawTracks, k)) continue
            var tr = rawTracks[k]
            if (tr == null || typeof tr !== 'object') continue
            var mode = String(tr.mode || 'lerp').trim().toLowerCase()
            if (mode !== 'lerp' && mode !== 'trail' && mode !== 'impulse') mode = 'lerp'
            var entry = { mode: mode }
            if (mode === 'lerp') {
                entry.speed  = Math.max(0.1, Math.min(100.0, parseFiniteNum(tr.speed, 10.0)))
                entry.easing = String(tr.easing || 'out_cubic').trim().toLowerCase()
            } else if (mode === 'trail') {
                entry.target  = String(tr.target || ('$' + k))
                entry.delayMs = Math.max(0, Math.min(10000, Math.round(parseFiniteNum(tr.delayMs, 240))))
                entry.speed   = Math.max(0.1, Math.min(100.0, parseFiniteNum(tr.speed, 4.0)))
            } else if (mode === 'impulse') {
                entry.onChange = String(tr.onChange || ('$' + k))
                entry.peak     = Math.max(0.0, Math.min(100.0, parseFiniteNum(tr.peak, 1.0)))
                entry.decayMs  = Math.max(16, Math.min(10000, Math.round(parseFiniteNum(tr.decayMs, 180))))
            }
            out[k] = entry
        }
        return out
    }

    function truncateSafeProtoText(str, maxLen) {
        if (!str || str.length <= maxLen) return str
        var cut = str.substring(0, maxLen)
        if (cut.length > 0) {
            var lastCode = cut.charCodeAt(cut.length - 1)
            if ((lastCode >= 0xD800 && lastCode <= 0xDBFF) || lastCode === 167) {
                cut = cut.substring(0, cut.length - 1)
            }
        }
        return cut
    }

    function buildValidatedPacket(optsOrText, notifyPlayer) {
        var rawOpts = normalizeOptionsObject(optsOrText)
        if (rawOpts == null || typeof rawOpts !== 'object') {
            return reportConfigWarning('调用时必须传入弹幕配置对象或文本字符串！', notifyPlayer)
        }
        var opts = (SPEC && typeof SPEC.normalizeDanmakuAliases === 'function')
            ? SPEC.normalizeDanmakuAliases(rawOpts, function (depKey, canonKey) {
                reportDeprecatedUsage(depKey, canonKey, '旧版别名字段')
            })
            : rawOpts
        var surfaceStr = String(opts.surface || 'screen').trim().toLowerCase()
        if (!VALID_SURFACES[surfaceStr]) surfaceStr = 'screen'

        if (opts.action === 'clear') {
            var cNs  = String(pick(opts, ['namespace', 'ns'], ''))
            var cTier = (opts._sourceTier === 'player' || opts.tier === 'player' || cNs.indexOf('u:') === 0) ? 'player' : 'system'
            var cPacket = {
                proto:     PROTO_VERSION,
                surface:   surfaceStr,
                action:    'clear',
                tier:      cTier,
                group:     String(pickNonEmpty(opts, ['group'], '*')),
                namespace: cNs
            }
            var cPri = pick(opts, ['maxPriority', 'priority'], null)
            if (cPri != null) cPacket.maxPriority = parsePriority(cPri, 10)
            return cPacket
        }
        if (opts.action === 'deactivate' || opts.action === 'stop') {
            var dKeyRaw = pickNonEmpty(opts, ['key', 'slotId', 'id', 'slot'], '')
            var dNs     = String(pick(opts, ['namespace', 'ns'], ''))
            var dTier   = (opts._sourceTier === 'player' || opts.tier === 'player' || dNs.indexOf('u:') === 0) ? 'player' : 'system'
            var dPacket = {
                proto:     PROTO_VERSION,
                surface:   surfaceStr,
                action:    'deactivate',
                tier:      dTier,
                key:       String(dKeyRaw),
                group:     String(pick(opts, ['group'], '')),
                namespace: dNs
            }
            var dFadeOut = parseTicksOrSec(opts.fadeOut)
            if (dFadeOut !== null) dPacket.fadeOut = dFadeOut
            var dPri = pick(opts, ['maxPriority', 'priority'], null)
            if (dPri != null) dPacket.maxPriority = parsePriority(dPri, 10)
            if (parseBool(opts.includeOnce, false)) dPacket.includeOnce = true
            return dPacket
        }
        if (opts.action === 'patch') {
            var pSlotRaw = String(pickNonEmpty(opts, ['slotId', 'id', 'key', 'slot'], ''))
            if (!pSlotRaw) {
                return reportConfigWarning('patch 增量更新报文缺少必填参数 `id`（或 `slotId` / `key`）！', notifyPlayer)
            }
            var pNs   = String(pick(opts, ['namespace', 'ns'], ''))
            var pTierPatch = (opts._sourceTier === 'player' || opts.tier === 'player' || pNs.indexOf('u:') === 0) ? 'player' : 'system'
            var pPacket = {
                proto:     PROTO_VERSION,
                surface:   surfaceStr,
                action:    'patch',
                tier:      pTierPatch,
                key:       String(pickNonEmpty(opts, ['key'], '')),
                slotId:    pSlotRaw,
                namespace: pNs,
                group:     String(pickNonEmpty(opts, ['group'], DEFAULTS.group)),
                vars:      sanitizeVarsMap(opts.vars)
            }
            var pHoldRaw = pick(opts, ['activeHold', 'hold', 'holdTicks', 'stay', 'duration'], null)
            if (pHoldRaw != null) {
                var pHoldTicks = parseTicksOrSec(pHoldRaw)
                if (pHoldTicks !== null && pHoldTicks > 0) {
                    pPacket.activeHold = Math.min(SYSTEM_PACKET_LIMITS.maxStayTicks, Math.max(4, pHoldTicks))
                }
            }
            return pPacket
        }

        var hasDeclarativeV6 = (Array.isArray(opts.nodes) && opts.nodes.length > 0) ||
            (Array.isArray(opts.bgNodes) && opts.bgNodes.length > 0) ||
            (Array.isArray(opts.fgNodes) && opts.fgNodes.length > 0) ||
            (opts.replaceTextures != null && typeof opts.replaceTextures === 'object')

        var rawTitle = pickNonEmpty(opts, ['text', 'title'], null)
        var rawSub   = pick(opts, ['sub', 'subtitle'], DEFAULTS.sub)

        if (rawTitle == null && !hasDeclarativeV6) {
            return reportConfigWarning('缺少必填参数 `text`（或 `title` / `nodes`）：弹幕主文本或图元树不能为空！', notifyPlayer)
        }

        var titleStr = rawTitle != null ? truncateSafeProtoText(
            applyTargetStyleTags(
                String(rawTitle).replace(/&([0-9a-fk-or])/gi, '§$1').replace(/\\n/g, '\n').replace(/\\\|/g, '|'),
                opts
            ),
            SYSTEM_PACKET_LIMITS.maxTitleLen
        ) : ''
        var subStr = truncateSafeProtoText(
            applyTargetStyleTags(
                String(rawSub || '').replace(/&([0-9a-fk-or])/gi, '§$1').replace(/\\n/g, '\n').replace(/\\\|/g, '|'),
                opts
            ),
            SYSTEM_PACKET_LIMITS.maxSubLen
        )

        var posInfo      = resolvePosition(opts)
        var sizeInfo     = parseSize(opts.size, opts.scale)
        sizeInfo.scale   = Math.min(SYSTEM_PACKET_LIMITS.maxScale, sizeInfo.scale)
        var angleVal     = parseTilt(opts.tilt, opts.angle, posInfo.presetAngle)
        var colorInfo    = parseColor(opts.color, DEFAULTS.color)
        var subColInfo   = parseColor(opts.subColor, DEFAULTS.subColor)
        var outlineInfo  = resolveOutline(opts, colorInfo.color)
        var spacingVal   = Math.max(-2.0, Math.min(24.0, parseFiniteNum(pick(opts, ['letterSpacing', 'charSpacing', 'spacing'], null), DEFAULTS.letterSpacing)))
        var isChar       = resolveTypewriterMode(opts)
        var charMsVal    = Math.min(SYSTEM_PACKET_LIMITS.maxCharMs, Math.round(parseNonNegNum(opts.charMs, DEFAULTS.charMs, 8)))
        var shakeInfo    = resolveShake(opts)
        var fadeStyle    = resolveFadeStyle(opts)
        var lifeInfo     = resolveLifetime(opts)
        lifeInfo.stay       = Math.min(SYSTEM_PACKET_LIMITS.maxStayTicks, lifeInfo.stay)
        lifeInfo.activeHold = Math.min(SYSTEM_PACKET_LIMITS.maxStayTicks, lifeInfo.activeHold)
        var defPri       = (lifeInfo.lifeMode === 'active') ? DEFAULTS.activePriority : DEFAULTS.priority
        var priority     = parsePriority(pick(opts, ['priority', 'importance'], null), defPri)
        var groupStr     = String(pickNonEmpty(opts, ['group'], DEFAULTS.group))
        var nsStr        = String(pickNonEmpty(opts, ['namespace', 'ns'], ''))
        var slotIdStr    = String(pickNonEmpty(opts, ['slotId', 'id', 'slot'], ''))
        var keyStr       = String(pickNonEmpty(opts, ['key'], ''))
        var resetAnim    = parseBool(pick(opts, ['restart', 'resetAnimation'], null), false)
        var allowMove    = parseBool(pick(opts, ['movable', 'move', 'updatePos'], null), DEFAULTS.movable)
        var normalizeKey = parseBool(opts.normalizeKey, DEFAULTS.normalizeKey)
        var maxWidth     = sanitizeMaxWidth(pick(opts, ['maxWidth'], DEFAULTS.maxWidth))
        var wrapVal      = parseBool(opts.wrap, DEFAULTS.wrap)
        var clampVal     = parseBool(opts.clamp, DEFAULTS.clamp)
        var shadowVal    = parseBool(opts.shadow, DEFAULTS.shadow)
        var showGuiVal   = parseBool(opts.showInGui, (surfaceStr === 'gui' || surfaceStr === 'slot') ? true : DEFAULTS.showInGui)
        var maxGroupVal  = Math.round(parseNonNegNum(pick(opts, ['maxGroup', 'maxGroupSize', 'groupLimit', 'maxConcurrent'], null), DEFAULTS.maxGroup, 0))
        var fadeOutVal   = parseTicksOrSec(opts.fadeOut)
        if (fadeOutVal === null) fadeOutVal = DEFAULTS.fadeOut
        fadeOutVal       = Math.min(SYSTEM_PACKET_LIMITS.maxFadeOutTicks, fadeOutVal)
        var baseShift    = parseNonNegNum(opts.charShakeShift, DEFAULTS.charShakeShift, 0.0)

        var defRenderPri = (surfaceStr === 'slot')
            ? parseFiniteNum(DEFAULTS.slotRenderPriority, 200)
            : ((surfaceStr === 'gui')
                ? parseFiniteNum(DEFAULTS.guiRenderPriority, 100)
                : parseFiniteNum(DEFAULTS.screenRenderPriority, 0))
        var rawRenderPri = pick(opts, ['renderPriority', 'zIndex'], null)
        var renderPri    = (rawRenderPri !== null && rawRenderPri !== undefined && rawRenderPri !== '')
            ? Math.max(-10000, Math.min(10000, parseFiniteNum(rawRenderPri, defRenderPri)))
            : defRenderPri

        var pTier = (opts._sourceTier === 'player' || opts.tier === 'player' || nsStr.indexOf('u:') === 0) ? 'player' : 'system'

        var built = {
            proto:               PROTO_VERSION,
            surface:             surfaceStr,
            action:              'push',
            tier:                pTier,
            key:                 keyStr,
            slotId:              slotIdStr,
            namespace:           nsStr,
            group:               groupStr,
            posTag:              posInfo.posTag,
            normalizeKey:        normalizeKey,
            lifeMode:            lifeInfo.lifeMode,
            priority:            priority,
            renderPriority:      renderPri,
            title:               titleStr,
            sub:                 subStr,
            rx:                  posInfo.rx,
            ry:                  posInfo.ry,
            ox:                  opts.ox != null ? Math.max(-4096, Math.min(4096, Math.round(parseFiniteNum(opts.ox, 0)))) : 0,
            oy:                  opts.oy != null ? Math.max(-4096, Math.min(4096, Math.round(parseFiniteNum(opts.oy, 0)))) : 0,
            movable:             allowMove,
            angle:               angleVal,
            scale:               sizeInfo.scale,
            randomScale:         Boolean(sizeInfo.isRandom),
            color:               colorInfo.color,
            randomColor:         Boolean(colorInfo.isRandom),
            subColor:            subColInfo.color,
            stay:                lifeInfo.stay,
            activeHold:          lifeInfo.activeHold,
            fadeStyle:           fadeStyle,
            fadeOut:             fadeOutVal,
            typewriter:          isChar,
            charMs:              charMsVal,
            cursor:              truncateSafeProtoText(String(pickNonEmpty(opts, ['cursor'], DEFAULTS.cursor)).replace(/[\r\n]/g, ''), SYSTEM_PACKET_LIMITS.maxCursorLen),
            shadow:              shadowVal,
            letterSpacing:       Number(spacingVal.toFixed(2)),
            letterSpacingMode:   String(opts.letterSpacingMode || DEFAULTS.letterSpacingMode).toLowerCase() === 'fixed' ? 'fixed' : 'relative',
            outlineMode:         outlineInfo.mode,
            outlineColor:        outlineInfo.color,
            outlineWidth:        outlineInfo.width,
            jitter:              shakeInfo.jitter,
            perCharShake:        Boolean(shakeInfo.perCharShake),
            shakeMode:           shakeInfo.shakeMode,
            charShakeStyle:      String(pick(opts, ['charShakeStyle', 'shakeStyle'], DEFAULTS.charShakeStyle)).toLowerCase(),
            charShakeShift:      baseShift,
            charShakeShiftX:     parseNonNegNum(opts.charShakeShiftX, baseShift, 0.0),
            charShakeShiftY:     parseNonNegNum(opts.charShakeShiftY, baseShift * 0.75, 0.0),
            charShakeSwayX:      parseNonNegNum(opts.charShakeSwayX, DEFAULTS.charShakeSwayX, 0.0),
            charShakeSwayY:      parseNonNegNum(opts.charShakeSwayY, DEFAULTS.charShakeSwayY, 0.0),
            charShakeRotDeg:     Math.min(45.0, parseNonNegNum(opts.charShakeRotDeg, DEFAULTS.charShakeRotDeg, 0.0)),
            charShakeWin:        Math.max(0.05, Math.min(1.0, parseNonNegNum(opts.charShakeWin, DEFAULTS.charShakeWin, 0.05))),
            charShakeSnap:       parseBool(opts.charShakeSnap, DEFAULTS.charShakeSnap),
            charShakeTransition: String(pick(opts, ['charShakeTransition'], DEFAULTS.charShakeTransition)).toLowerCase(),
            shakeAmp:            shakeInfo.shakeAmp,
            shakeFreqMin:        shakeInfo.shakeFreqMin,
            shakeFreqMax:        shakeInfo.shakeFreqMax,
            randomShake:         Boolean(shakeInfo.isRandom),
            maxWidth:            maxWidth,
            wrap:                wrapVal,
            clamp:               clampVal,
            showInGui:           showGuiVal,
            maxGroup:            maxGroupVal,
            restart:             resetAnim,
            debug:               parseBool(opts.debug, false)
        }

        if (opts.vars != null && typeof opts.vars === 'object') {
            built.vars = sanitizeVarsMap(opts.vars)
        }
        if (opts.tracks != null && typeof opts.tracks === 'object') {
            built.tracks = sanitizeTracksMap(opts.tracks)
        }
        var rootClip = sanitizeClipSpec(opts.clip)
        if (rootClip != null) {
            built.clip = rootClip
        }
        if (Array.isArray(opts.nodes) && opts.nodes.length > 0) {
            built.nodes = sanitizeNodesList(opts.nodes, 0)
        }
        if (surfaceStr === 'gui' || surfaceStr === 'slot') {
            if (opts.targetGui != null && typeof opts.targetGui === 'object') {
                built.targetGui = {}
                if (opts.targetGui.screenClass != null) built.targetGui.screenClass = String(opts.targetGui.screenClass)
                if (opts.targetGui.titleMatch != null) built.targetGui.titleMatch = String(opts.targetGui.titleMatch)
                if (opts.targetGui.menuId != null) built.targetGui.menuId = String(opts.targetGui.menuId)
            }
            if (opts.replaceTextures != null && typeof opts.replaceTextures === 'object') {
                built.replaceTextures = {}
                for (var rtk in opts.replaceTextures) {
                    if (Object.prototype.hasOwnProperty.call(opts.replaceTextures, rtk) && opts.replaceTextures[rtk]) {
                        built.replaceTextures[String(rtk)] = String(opts.replaceTextures[rtk])
                    }
                }
            }
            if (Array.isArray(opts.bgNodes) && opts.bgNodes.length > 0) {
                built.bgNodes = sanitizeNodesList(opts.bgNodes, 0)
            }
            if (Array.isArray(opts.fgNodes) && opts.fgNodes.length > 0) {
                built.fgNodes = sanitizeNodesList(opts.fgNodes, 0)
            }
            if (opts.slotMatch != null && typeof opts.slotMatch === 'object') {
                built.slotMatch = {}
                if (opts.slotMatch.item != null) built.slotMatch.item = String(opts.slotMatch.item)
                if (opts.slotMatch.tag != null) built.slotMatch.tag = String(opts.slotMatch.tag)
                if (opts.slotMatch.slotIndex != null) built.slotMatch.slotIndex = Math.round(parseFiniteNum(opts.slotMatch.slotIndex, -1))
            }
        } else if (surfaceStr === 'world_plane') {
            var wp = opts.worldPos !== undefined ? opts.worldPos : opts.at
            if (Array.isArray(wp) && wp.length >= 3) {
                built.worldPos = [parseFiniteNum(wp[0], 0), parseFiniteNum(wp[1], 64), parseFiniteNum(wp[2], 0)]
            }
            built.billboard = String(opts.billboard !== undefined ? opts.billboard : (opts.facing || 'vertical')).toLowerCase()
            built.seeThrough = parseBool(opts.seeThrough !== undefined ? opts.seeThrough : opts.xray, false)
        }

        if (hasDeclarativeV6 && SPEC && typeof SPEC.computeOverlayCost === 'function') {
            var pktCost = SPEC.computeOverlayCost(built)
            var maxAllowedCost = (pTier === 'player') ? SYSTEM_PACKET_LIMITS.maxPlayerOverlayCost : SYSTEM_PACKET_LIMITS.maxSystemOverlayCost
            if (pktCost > maxAllowedCost) {
                return reportConfigWarning('2D 图元树渲染开销超出配额上限（cost=' + pktCost + ' > max=' + maxAllowedCost + '，tier=' + pTier + '），已拒绝构建报文！', notifyPlayer)
            }
            built.cost = pktCost
        }

        return built
    }

    // 【catch 约定】以下 try/catch 均为 Java API 能力探测：先 typeof 判函数再调，
    // 失败表示该 API 在本次加载的 MC/Rhino 版本中不存在，属于预期分支，故留空。
    var readPlayerPos         = BASE.readPos
    var forEachPlayerInRadius = BASE.forEachPlayerNear
    var resolveLevel          = (levelOrDim, serverFallback) => BASE.resolveLevel(levelOrDim, serverFallback || SERVER_REF)

    function sendSinglePlayerPacket(target, pkt) {
        if (target == null || pkt == null) return 0
        var player = target
        if (typeof target === 'string') {
            if (SERVER_REF == null) return 0
            try {
                player = SERVER_REF.getPlayer(target)
            } catch (e0) {
                return 0
            }
            if (player == null) return 0
        }
        try {
            player.sendData(CHANNEL, pkt)
            return 1
        } catch (e) {
            reportCatch('sendData', e)
            return 0
        }
    }

    function toPlayer(playerOrPlayers, opts) {
        if (playerOrPlayers == null) {
            reportConfigWarning('调用 toPlayer 时未指定目标玩家（playerOrPlayers 为空）')
            return 0
        }
        var effOpts = prepareSourceConflictOpts(opts)
        var pkt = buildValidatedPacket(effOpts, null)
        if (pkt == null) return 0

        if (typeof playerOrPlayers === 'string') {
            if (SERVER_REF == null) return 0
            var pObj = SERVER_REF.getPlayer(playerOrPlayers)
            if (pObj == null) return 0
            if (!allowSourceConflictForPlayer(pObj, effOpts)) return 0
            return sendSinglePlayerPacket(pObj, pkt)
        }

        if (Array.isArray(playerOrPlayers)) {
            var cnt = 0
            for (var i = 0; i < playerOrPlayers.length; i++) {
                if (allowSourceConflictForPlayer(playerOrPlayers[i], effOpts)) {
                    cnt += sendSinglePlayerPacket(playerOrPlayers[i], pkt)
                }
            }
            return cnt
        }
        if (typeof playerOrPlayers.iterator === 'function') {
            var iter = playerOrPlayers.iterator()
            var c = 0
            while (iter.hasNext()) {
                var nxt = iter.next()
                if (allowSourceConflictForPlayer(nxt, effOpts)) {
                    c += sendSinglePlayerPacket(nxt, pkt)
                }
            }
            return c
        }

        if (!allowSourceConflictForPlayer(playerOrPlayers, effOpts)) return 0
        return sendSinglePlayerPacket(playerOrPlayers, pkt)
    }

    function inDimension(levelOrDim, x, y, z, radiusOrOpts, maybeOpts) {
        if (levelOrDim == null) {
            reportConfigWarning('调用 inDimension 时未指定目标维度')
            return 0
        }
        var cx = Number(x), cy = Number(y), cz = Number(z)
        if (x == null || y == null || z == null || !isFinite(cx) || !isFinite(cy) || !isFinite(cz)) {
            reportConfigWarning('调用 inDimension 时坐标 (x, y, z) 无效')
            return 0
        }

        var r = DEFAULTS.radius
        var opts = maybeOpts
        if (maybeOpts === undefined && (typeof radiusOrOpts === 'object' || typeof radiusOrOpts === 'string')) {
            opts = radiusOrOpts
            if (opts != null && typeof opts === 'object' && opts.radius != null) {
                var rOpt = Number(opts.radius)
                if (!isFinite(rOpt) || rOpt < 0) {
                    reportConfigWarning('弹幕作用半径 radius 必须为非负有限数值')
                    return 0
                }
                r = rOpt
            }
        } else if (radiusOrOpts != null) {
            var rArg = Number(radiusOrOpts)
            if (!isFinite(rArg) || rArg < 0) {
                reportConfigWarning('弹幕作用半径 radius 必须为非负有限数值')
                return 0
            }
            r = rArg
        }

        var lv = resolveLevel(levelOrDim, (opts != null && typeof opts === 'object') ? opts.server : null)
        if (lv == null) {
            reportConfigWarning('无法解析目标维度: ' + String(levelOrDim))
            return 0
        }
        var normProbe = normalizeOptionsObject(opts)
        if (!BASE.isObjectLike(normProbe) ||
            (normProbe.action !== 'clear' && normProbe.action !== 'deactivate' && normProbe.action !== 'stop' && pickNonEmpty(normProbe, ['text', 'title'], null) == null)) {
            return buildValidatedPacket(prepareSourceConflictOpts(opts), null) ? 0 : 0
        }

        var radiusTargets = []
        forEachPlayerInRadius(lv, cx, cy, cz, r, function (p) {
            radiusTargets.push(p)
        })
        if (radiusTargets.length === 0) return 0

        var effOpts = prepareSourceConflictOpts(opts)
        var eligibleTargets = []
        for (var ti = 0; ti < radiusTargets.length; ti++) {
            if (allowSourceConflictForPlayer(radiusTargets[ti], effOpts)) {
                eligibleTargets.push(radiusTargets[ti])
            }
        }
        if (eligibleTargets.length === 0) return 0

        var pkt = buildValidatedPacket(effOpts, null)
        if (pkt == null) return 0
        var sentCount = 0
        for (var si = 0; si < eligibleTargets.length; si++) {
            try {
                eligibleTargets[si].sendData(CHANNEL, pkt)
                sentCount++
            } catch (e) {
                reportCatch('radiusSend', e)
            }
        }
        return sentCount
    }

    function atEvent(event, radiusOrOpts, maybeOpts) {
        if (event == null) {
            reportConfigWarning('调用 atEvent 时 event 为空')
            return 0
        }
        var r = DEFAULTS.radius
        var opts = maybeOpts
        if (maybeOpts === undefined && (typeof radiusOrOpts === 'object' || typeof radiusOrOpts === 'string')) {
            opts = radiusOrOpts
            if (opts != null && typeof opts === 'object' && opts.radius != null) {
                var rOpt = Number(opts.radius)
                if (!isFinite(rOpt) || rOpt < 0) return 0
                r = rOpt
            }
        } else if (radiusOrOpts != null) {
            var rArg = Number(radiusOrOpts)
            if (!isFinite(rArg) || rArg < 0) return 0
            r = rArg
        }

        var lv = event.level || (event.player ? event.player.level : null) || (event.entity ? event.entity.level : null)
        var cx = null, cy = null, cz = null

        if (event.block != null) {
            cx = event.block.x; cy = event.block.y; cz = event.block.z
            if (lv == null) lv = event.block.level
        } else if (event.entity != null) {
            var ePos = readPlayerPos(event.entity)
            if (ePos != null) { cx = ePos.x; cy = ePos.y; cz = ePos.z }
        } else if (event.player != null) {
            var pPos = readPlayerPos(event.player)
            if (pPos != null) { cx = pPos.x; cy = pPos.y; cz = pPos.z }
        } else if (event.pos != null) {
            cx = event.pos.x; cy = event.pos.y; cz = event.pos.z
        }

        if (lv == null || cx == null || cy == null || cz == null) {
            reportConfigWarning('无法从 event 中提取有效的维度与坐标')
            return 0
        }

        var passOpts = opts
        if (opts != null && typeof opts === 'object' && opts.sourceScope == null && opts.sourceKey == null) {
            passOpts = Object.assign({}, opts, { sourceScope: resolveEventSourceScope(event, opts) })
        }
        return inDimension(lv, cx, cy, cz, r, passOpts)
    }

    function send(opts) {
        if (opts == null || typeof opts !== 'object') {
            reportConfigWarning('调用 ScreenDanmaku.send(opts) 时必须传入配置对象')
            return 0
        }
        if (opts.player != null || opts.players != null) {
            return toPlayer(opts.player != null ? opts.player : opts.players, opts)
        }
        if (opts.event != null) {
            return atEvent(opts.event, opts.radius != null ? opts.radius : DEFAULTS.radius, opts)
        }
        var cx = opts.x, cy = opts.y, cz = opts.z
        if (Array.isArray(opts.center) && opts.center.length >= 3) {
            cx = opts.center[0]; cy = opts.center[1]; cz = opts.center[2]
        } else if (opts.center != null && typeof opts.center === 'object') {
            cx = opts.center.x; cy = opts.center.y; cz = opts.center.z
        }
        var targetDim = opts.level || opts.dimension || opts.dim || 'minecraft:overworld'
        if (cx != null && cy != null && cz != null) {
            return inDimension(targetDim, cx, cy, cz, opts.radius != null ? opts.radius : DEFAULTS.radius, opts)
        }

        reportConfigWarning('调用 ScreenDanmaku.send(opts) 时未指定 player / event / center 目标')
        return 0
    }

    // 常驻安全发送入口：兼容 safeSend(player, optsOrText) 与 safeSend(opts)，屏蔽底层通道名与协议细节
    function safeSend(targetOrOpts, maybeOpts) {
        try {
            if (maybeOpts !== undefined) {
                return toPlayer(targetOrOpts, maybeOpts)
            }
            return send(targetOrOpts)
        } catch (e) {
            reportCatch('safeSend', e)
            return 0
        }
    }

    function sendMinorEdgeNear(level, x, y, z, radius, opts) {
        opts = normalizeOptionsObject(opts) || {}
        var merged = {}
        for (var k in opts) merged[k] = opts[k]
        if (merged.pos == null && merged.rx == null) merged.pos = 'edge'
        if (merged.size == null && merged.scale == null) merged.size = 'small_random'
        if (merged.tilt == null && merged.angle == null) merged.tilt = 'random'
        if (merged.mode == null && merged.typewriter == null) merged.mode = 'char'
        if (merged.fade == null && merged.fadeStyle == null) merged.fade = 'random'
        return inDimension(level, x, y, z, radius, merged)
    }

    function buildDeactivateOptions(keyOrGroup, fadeOutOrOpts, maybeMaxPriority) {
        if (keyOrGroup != null && typeof keyOrGroup === 'object') {
            var copy = {}
            for (var k in keyOrGroup) copy[k] = keyOrGroup[k]
            copy.action = 'deactivate'
            if (copy.key == null && copy.id == null && copy.slot == null && copy.group == null && copy.namespace == null && copy.ns == null) {
                copy.key   = '*'
                copy.group = '*'
            }
            if (maybeMaxPriority != null && copy.maxPriority == null && copy.priority == null) {
                copy.maxPriority = maybeMaxPriority
            }
            return copy
        }
        var target = (keyOrGroup != null && String(keyOrGroup).trim() !== '') ? String(keyOrGroup) : '*'
        var opts   = { action: 'deactivate', key: target, group: target }
        if (typeof fadeOutOrOpts === 'number' && isFinite(fadeOutOrOpts) && fadeOutOrOpts > 0) {
            opts.fadeOut = fadeOutOrOpts
        } else if (fadeOutOrOpts != null && typeof fadeOutOrOpts === 'object') {
            if (fadeOutOrOpts.fadeOut != null) opts.fadeOut = fadeOutOrOpts.fadeOut
            if (fadeOutOrOpts.maxPriority != null) opts.maxPriority = fadeOutOrOpts.maxPriority
            if (fadeOutOrOpts.priority != null) opts.priority = fadeOutOrOpts.priority
            if (fadeOutOrOpts.includeOnce != null) opts.includeOnce = fadeOutOrOpts.includeOnce
            if (fadeOutOrOpts.namespace != null) opts.namespace = fadeOutOrOpts.namespace
            if (fadeOutOrOpts.ns != null && opts.namespace == null) opts.namespace = fadeOutOrOpts.ns
            if (fadeOutOrOpts.id != null) opts.id = fadeOutOrOpts.id
            if (fadeOutOrOpts.slot != null && opts.id == null) opts.id = fadeOutOrOpts.slot
        }
        if (maybeMaxPriority != null && opts.maxPriority == null && opts.priority == null) {
            opts.maxPriority = maybeMaxPriority
        }
        return opts
    }

    function sendActionNear(actionLabel, levelOrDim, x, y, z, radius, actionOpts) {
        if (levelOrDim == null || levelOrDim === '') {
            reportConfigWarning('调用 ' + actionLabel + ' 时未指定有效维度')
            return 0
        }
        var lv = resolveLevel(levelOrDim, null)
        if (lv == null) return 0
        var r = (radius !== undefined && radius !== null && radius !== '') ? parseNonNegNum(radius, -1, 0) : DEFAULTS.radius
        if (r < 0) return 0
        var pkt = buildValidatedPacket(actionOpts, null)
        if (pkt == null) return 0
        return forEachPlayerInRadius(lv, x, y, z, r, (p) => {
            try { p.sendData(CHANNEL, pkt) } catch (e) { reportCatch(actionLabel + 'Send', e) }
        })
    }

    function deactivatePlayer(player, keyOrGroup, fadeOutOrOpts, maybeMaxPriority) {
        if (player == null) return 0
        return toPlayer(player, buildDeactivateOptions(keyOrGroup, fadeOutOrOpts, maybeMaxPriority))
    }

    function deactivateNear(levelOrDim, x, y, z, radius, keyOrGroup, fadeOutOrOpts, maybeMaxPriority) {
        return sendActionNear('deactivateNear', levelOrDim, x, y, z, radius, buildDeactivateOptions(keyOrGroup, fadeOutOrOpts, maybeMaxPriority))
    }

    function buildClearOptions(groupOrOpts, maxPriority) {
        if (groupOrOpts != null && typeof groupOrOpts === 'object') {
            var copy = {}
            for (var k in groupOrOpts) copy[k] = groupOrOpts[k]
            copy.action = 'clear'
            if (copy.group == null || copy.group === '') copy.group = '*'
            if (maxPriority != null && copy.maxPriority == null) copy.maxPriority = maxPriority
            return copy
        }
        var opts = { action: 'clear', group: (groupOrOpts != null && String(groupOrOpts).trim() !== '') ? String(groupOrOpts) : '*' }
        if (maxPriority != null) opts.maxPriority = maxPriority
        return opts
    }

    function clearPlayer(player, groupOrOpts, maxPriority) {
        if (player == null) return 0
        return toPlayer(player, buildClearOptions(groupOrOpts, maxPriority))
    }

    function clearNear(levelOrDim, x, y, z, radius, groupOrOpts, maxPriority) {
        return sendActionNear('clearNear', levelOrDim, x, y, z, radius, buildClearOptions(groupOrOpts, maxPriority))
    }

    function buildPatchOptions(slotIdOrOpts, maybeVars, maybeHoldTicks) {
        if (slotIdOrOpts != null && typeof slotIdOrOpts === 'object') {
            var copy = {}
            for (var k in slotIdOrOpts) copy[k] = slotIdOrOpts[k]
            copy.action = 'patch'
            return copy
        }
        var opts = {
            action: 'patch',
            id:     slotIdOrOpts != null ? String(slotIdOrOpts) : '',
            vars:   (maybeVars != null && typeof maybeVars === 'object') ? maybeVars : {}
        }
        if (maybeHoldTicks != null) opts.activeHold = maybeHoldTicks
        return opts
    }

    function patchPlayer(player, slotIdOrOpts, maybeVars, maybeHoldTicks) {
        if (player == null) return 0
        return toPlayer(player, buildPatchOptions(slotIdOrOpts, maybeVars, maybeHoldTicks))
    }

    function patchNear(levelOrDim, x, y, z, radius, slotIdOrOpts, maybeVars, maybeHoldTicks) {
        return sendActionNear('patchNear', levelOrDim, x, y, z, radius, buildPatchOptions(slotIdOrOpts, maybeVars, maybeHoldTicks))
    }

    // ------------------------------------------------------------------------
    // 原生 2D 图形进度条面板构造器（基于 v6 图元树 nodes + vars + tracks + rect.fill + clip）
    // ------------------------------------------------------------------------
    function buildProgressPanel(cfg) {
        var c = (cfg != null && typeof cfg === 'object') ? cfg : {}
        var pVal = Math.max(0.0, Math.min(1.0, parseFiniteNum(c.progress, 0.0)))
        var barW = Math.max(24, Math.min(600, Math.round(parseFiniteNum(c.barWidth, 152))))
        var barH = Math.max(3, Math.min(48, Math.round(parseFiniteNum(c.barHeight, 6))))
        var barY = Math.round(parseFiniteNum(c.barY, 0))
        var titleStr = String(pick(c, ['title', 'text'], ''))
        var subStr   = String(pick(c, ['sub', 'subtitle'], ''))
        var fillFrom = parseColor(c.barColorFrom !== undefined ? c.barColorFrom : (c.barColor !== undefined ? c.barColor : 0xFF3333), 0xFF3333).color
        var fillTo   = parseColor(c.barColorTo !== undefined ? c.barColorTo : (c.barAccentColor !== undefined ? c.barAccentColor : 0xFFAA22), 0xFFAA22).color
        var trailCol = parseArgbColor(c.trailColor !== undefined ? c.trailColor : 0x77FF6644, 0x77FF6644).color
        var bgCol    = parseArgbColor(c.bgColor !== undefined ? c.bgColor : 0xB0120A16, 0xB0120A16).color
        var borderCol= parseArgbColor(c.borderColor !== undefined ? c.borderColor : 0xCC552233, 0xCC552233).color

        var nodes = []
        if (Array.isArray(c.nodes) && c.nodes.length > 0) {
            for (var cni = 0; cni < c.nodes.length; cni++) {
                nodes.push(c.nodes[cni])
            }
        } else {
            if (Array.isArray(c.preNodes)) {
                for (var pni = 0; pni < c.preNodes.length; pni++) {
                    nodes.push(c.preNodes[pni])
                }
            }
            var mainFill = (c.barFill != null && typeof c.barFill === 'object')
                ? c.barFill
                : { mode: 'gradient', dir: 'h', from: fillFrom, to: fillTo }
            if (mainFill.mode === 'gradient' && c.barColorMid !== undefined && mainFill.mid === undefined) {
                mainFill.mid = parseColor(c.barColorMid, fillTo).color
            }
            nodes.push(
                {
                    id:          'bar_bg',
                    type:        'rect',
                    x:           0,
                    y:           barY,
                    w:           barW + 2,
                    h:           barH + 2,
                    anchor:      'center',
                    fill:        { mode: 'solid', color: bgCol },
                    borderColor: borderCol,
                    borderWidth: 1
                },
                {
                    id:     'bar_trail',
                    type:   'rect',
                    x:      0,
                    y:      barY,
                    w:      barW,
                    h:      barH,
                    anchor: 'center',
                    fill:   { mode: 'solid', color: trailCol },
                    clip:   { dir: 'left', ratio: '$progressTrail', mode: 'local' }
                },
                {
                    id:     'bar_main',
                    type:   'rect',
                    x:      0,
                    y:      barY,
                    w:      barW,
                    h:      barH,
                    anchor: 'center',
                    fill:   mainFill,
                    clip:   { dir: 'left', ratio: '$progress', mode: 'local' }
                }
            )
            if (Array.isArray(c.extraNodes)) {
                for (var eni = 0; eni < c.extraNodes.length; eni++) {
                    nodes.push(c.extraNodes[eni])
                }
            }
            if (titleStr.length > 0 && c.includeDefaultTitle !== false) {
                nodes.push({
                    id:     'title',
                    type:   'text',
                    x:      0,
                    y:      barY - Math.round(barH * 0.5) - 9,
                    anchor: 'center',
                    text:   titleStr,
                    color:  parseColor(c.color, DEFAULTS.color).color,
                    shadow: c.shadow !== undefined ? Boolean(c.shadow) : true
                })
            }
            if (subStr.length > 0 && c.includeDefaultSub !== false) {
                nodes.push({
                    id:     'sub',
                    type:   'text',
                    x:      0,
                    y:      barY + Math.round(barH * 0.5) + 9,
                    anchor: 'center',
                    text:   subStr,
                    color:  parseColor(c.subColor, DEFAULTS.subColor).color,
                    shadow: c.shadow !== undefined ? Boolean(c.shadow) : true
                })
            }
        }

        var subPVal = Math.max(0.0, Math.min(1.0, parseFiniteNum(c.subProgress, pVal)))
        var out = {}
        for (var k in c) {
            if (Object.prototype.hasOwnProperty.call(c, k)) {
                out[k] = c[k]
            }
        }
        out.surface = c.surface || 'screen'
        out.text    = titleStr
        out.sub     = subStr
        out.vars    = {
            progress:      pVal,
            progressTrail: pVal,
            subProgress:   subPVal,
            impulse:       0.0,
            pctText:       Math.round(pVal * 100) + '%'
        }
        if (c.vars != null && typeof c.vars === 'object') {
            for (var vk in c.vars) {
                if (Object.prototype.hasOwnProperty.call(c.vars, vk)) {
                    out.vars[vk] = c.vars[vk]
                }
            }
        }
        out.tracks = {
            progress:      { mode: 'lerp', speed: parseFiniteNum(c.lerpSpeed, 10.0), easing: 'out_cubic' },
            progressTrail: { mode: 'trail', target: '$progress', delayMs: Math.round(parseFiniteNum(c.trailDelayMs, 220)), speed: parseFiniteNum(c.trailSpeed, 4.5) },
            subProgress:   { mode: 'lerp', speed: parseFiniteNum(c.subLerpSpeed, 12.0), easing: 'out_cubic' },
            impulse:       { mode: 'impulse', onChange: '$progress', peak: parseFiniteNum(c.impulsePeak, 1.0), decayMs: Math.round(parseFiniteNum(c.impulseDecayMs, 260)) }
        }
        if (c.tracks != null && typeof c.tracks === 'object') {
            for (var tk in c.tracks) {
                if (Object.prototype.hasOwnProperty.call(c.tracks, tk)) {
                    out.tracks[tk] = c.tracks[tk]
                }
            }
        }
        out.nodes = nodes
        return out
    }


    // ======================================================================== 方块弹幕发射源自动绑定（委托 EpiphyBlockTracker）

    var SCOPE_CACHE_TTL_TICKS = 20
    var boundScopeRevision    = 0
    var scopeListCache        = new Map() // '<dim>|<scopeKey>' -> { rev, builtTick, list: [{ rec, binding, seq, cx, cy, cz, r, rSq }], idxByKey: Map, mergeClustersByKey: Map }
    var blockSeqByKey         = new Map() // '<posKey>' -> seq

    function invalidateScopeCache(removedKey, optCacheKey) {
        if (optCacheKey != null && optCacheKey !== '') {
            scopeListCache.delete(optCacheKey)
        } else {
            boundScopeRevision++
            if (scopeListCache.size > 0) scopeListCache.clear()
        }
        if (removedKey != null) blockSeqByKey.delete(removedKey)
    }

    function getScopeCacheKeyForRecord(rec, binding) {
        return String(rec.dim || 'minecraft:overworld') + '|' + getBlockConflictScopeKey(rec, binding)
    }

    function getBlockConflictScopeKey(rec, binding) {
        var sc = (binding && binding.conflictScope) ? binding.conflictScope : 'block'
        if (sc === 'all') return 'all'
        if (sc === 'group') return 'group:' + ((binding && binding.group) || rec.blockId)
        return 'block:' + rec.blockId
    }

    function ensureRecordSeq(rec) {
        if (rec == null) return 0
        if (rec.key != null) {
            var mapped = blockSeqByKey.get(rec.key)
            if (mapped != null) {
                if (rec._danmakuSeq == null) rec._danmakuSeq = mapped
                return mapped
            }
            var seq = (rec._danmakuSeq != null) ? rec._danmakuSeq : (++blockSourceSeq)
            if (blockSeqByKey.size >= 8192) blockSeqByKey.clear()
            blockSeqByKey.set(rec.key, seq)
            rec._danmakuSeq = seq
            return seq
        }
        if (rec._danmakuSeq == null) rec._danmakuSeq = ++blockSourceSeq
        return rec._danmakuSeq
    }

    // 合并聚类连通分量构建：list 已按 _danmakuSeq 升序排序；
    // 任意两块球体相交或相切 (d <= rA + rB) 即归入同一集群，seq 最小者为唯一主控 leader。
    function buildMergeClusterMap(list) {
        var byKey = new Map()
        var mergeNodes = []
        for (var i = 0; i < list.length; i++) {
            var it = list[i]
            if (it != null && it.binding != null && (it.binding.conflictMode || 'overlap') === 'merge') {
                mergeNodes.push(it)
            }
        }
        if (mergeNodes.length === 0) return byKey
        var clusters = SPEC.computeSphereMergeClusters(mergeNodes)
        for (var c = 0; c < clusters.length; c++) {
            var cl = clusters[c]
            var clusterObj = {
                leaderKey: cl.leader.rec.key,
                leaderSeq: cl.leader.seq,
                members:   cl.members,
                minX:      cl.minX,
                maxX:      cl.maxX,
                minY:      cl.minY,
                maxY:      cl.maxY,
                minZ:      cl.minZ,
                maxZ:      cl.maxZ
            }
            for (var ki = 0; ki < cl.members.length; ki++) {
                byKey.set(cl.members[ki].rec.key, clusterObj)
            }
        }
        return byKey
    }

    function isPointInMergeCluster(cluster, px, py, pz) {
        if (cluster == null || cluster.members == null) return false
        if (px < cluster.minX || px > cluster.maxX ||
            py < cluster.minY || py > cluster.maxY ||
            pz < cluster.minZ || pz > cluster.maxZ) {
            return false
        }
        var members = cluster.members
        for (var i = 0; i < members.length; i++) {
            var m = members[i]
            var dx = px - m.cx, dy = py - m.cy, dz = pz - m.cz
            if ((dx * dx + dy * dy + dz * dz) <= m.rSq) return true
        }
        return false
    }

    function forEachPlayerInLevel(level, fn) {
        if (level == null || typeof fn !== 'function') return 0
        var players = BASE.toJsArray(level.players)
        for (var i = 0; i < players.length; i++) {
            fn(players[i])
        }
        return players.length
    }

    function forEachPlayerInMergeCluster(level, cluster, fn) {
        if (level == null || cluster == null) return 0
        var hitCount = 0
        forEachPlayerInLevel(level, function (p) {
            var pPos = readPlayerPos(p)
            if (pPos == null) return
            if (isPointInMergeCluster(cluster, pPos.x, pPos.y, pPos.z)) {
                hitCount++
                fn(p)
            }
        })
        return hitCount
    }

    function getScopeCacheEntry(rec, binding) {
        var scopeKey = getBlockConflictScopeKey(rec, binding)
        var cacheKey = String(rec.dim || 'minecraft:overworld') + '|' + scopeKey
        var cached   = scopeListCache.get(cacheKey)
        if (cached != null && cached.rev === boundScopeRevision &&
            danmakuTickCounter >= cached.builtTick &&
            (danmakuTickCounter - cached.builtTick) < SCOPE_CACHE_TTL_TICKS) {
            return cached
        }

        var raw = []
        if (danmakuBlockTracker != null && typeof danmakuBlockTracker.getTrackedRecords === 'function') {
            raw = binding.conflictScope === 'block'
                ? danmakuBlockTracker.getTrackedRecords(rec.blockId)
                : danmakuBlockTracker.getTrackedRecords(null)
        }

        var list = []
        for (var i = 0; i < raw.length; i++) {
            var item = raw[i]
            if (item == null || item.dim !== rec.dim) continue
            var itemBinding = (danmakuBlockTracker != null && typeof danmakuBlockTracker.getBinding === 'function')
                ? danmakuBlockTracker.getBinding(item.blockId)
                : null
            if (itemBinding == null) continue
            if (getBlockConflictScopeKey(item, itemBinding) !== scopeKey) continue
            var seq = ensureRecordSeq(item)
            var r   = itemBinding.radius
            list.push({
                rec:     item,
                binding: itemBinding,
                seq:     seq,
                cx:      item.x + 0.5,
                cy:      item.y + 0.5,
                cz:      item.z + 0.5,
                r:       r,
                rSq:     r * r
            })
        }
        if (list.length > 1) {
            list.sort(function (a, b) {
                return a.seq - b.seq
            })
        }
        var idxByKey = new Map()
        for (var j = 0; j < list.length; j++) {
            idxByKey.set(list[j].rec.key, j)
        }
        var mergeClustersByKey = buildMergeClusterMap(list)
        if (scopeListCache.size >= 256) scopeListCache.clear()
        var entry = {
            rev:                boundScopeRevision,
            builtTick:          danmakuTickCounter,
            list:               list,
            idxByKey:           idxByKey,
            mergeClustersByKey: mergeClustersByKey
        }
        scopeListCache.set(cacheKey, entry)
        return entry
    }

    function getMergeClusterForRecord(rec, binding) {
        if (rec == null || binding == null || (binding.conflictMode || 'overlap') !== 'merge') return null
        ensureRecordSeq(rec)
        var scopeEntry = getScopeCacheEntry(rec, binding)
        return scopeEntry.mergeClustersByKey != null ? (scopeEntry.mergeClustersByKey.get(rec.key) || null) : null
    }

    function isMergeClusterLeader(rec, binding) {
        var cluster = getMergeClusterForRecord(rec, binding)
        return cluster == null || cluster.leaderKey === rec.key
    }

    function shouldEmitForBoundBlockToPlayer(rec, binding, p) {
        ensureRecordSeq(rec)
        var mode = binding.conflictMode || 'overlap'
        if (mode === 'overlap' || mode === 'stagger') return true

        var scopeKey = getBlockConflictScopeKey(rec, binding)
        var pUuid = getPlayerUuidSafe(p)

        if (mode === 'merge') {
            if (!isMergeClusterLeader(rec, binding)) return false
            var ck = pUuid + '|blk:' + scopeKey
            var exp = playerSourceCooldown.get(ck)
            if (exp != null && danmakuTickCounter < exp) return false
            var cd = Math.max(1, binding.conflictCooldownTicks || binding.intervalTicks)
            if (playerSourceCooldown.size >= 2048) {
                playerSourceCooldown.forEach(function (v, k) {
                    if (v <= danmakuTickCounter) playerSourceCooldown.delete(k)
                })
                if (playerSourceCooldown.size >= 2048) playerSourceCooldown.clear()
            }
            playerSourceCooldown.set(ck, danmakuTickCounter + cd)
            return true
        }

        var pPos = readPlayerPos(p)
        if (pPos == null) return true
        var scopeEntry = getScopeCacheEntry(rec, binding)
        var list       = scopeEntry.list
        if (list.length <= 1) return true

        var px = pPos.x, py = pPos.y, pz = pPos.z
        var myIdx = scopeEntry.idxByKey.get(rec.key)
        if (myIdx === undefined) {
            invalidateScopeCache(null, getScopeCacheKeyForRecord(rec, binding))
            scopeEntry = getScopeCacheEntry(rec, binding)
            list       = scopeEntry.list
            myIdx      = scopeEntry.idxByKey.get(rec.key)
        }
        var mySeq = ensureRecordSeq(rec)

        // list 已按 _danmakuSeq 升序排序：first/latest 只需扫描竞争一侧并可提前命中退出
        if (mode === 'first') {
            var limitFirst = (myIdx !== undefined) ? myIdx : list.length
            for (var fi = 0; fi < limitFirst; fi++) {
                var fe = list[fi]
                if (myIdx === undefined && fe.seq >= mySeq) break
                var fdx = px - fe.cx, fdy = py - fe.cy, fdz = pz - fe.cz
                if ((fdx * fdx + fdy * fdy + fdz * fdz) <= fe.rSq) {
                    return false
                }
            }
            return true
        }
        if (mode === 'latest') {
            var stopLatest = (myIdx !== undefined) ? (myIdx + 1) : 0
            for (var li = list.length - 1; li >= stopLatest; li--) {
                var le = list[li]
                if (myIdx === undefined && le.seq <= mySeq) break
                var ldx = px - le.cx, ldy = py - le.cy, ldz = pz - le.cz
                if ((ldx * ldx + ldy * ldy + ldz * ldz) <= le.rSq) {
                    return false
                }
            }
            return true
        }

        var winner    = null
        var winSeq    = 0
        var winDistSq = Infinity
        for (var i = 0; i < list.length; i++) {
            var eItem = list[i]
            var dx = px - eItem.cx
            var dy = py - eItem.cy
            var dz = pz - eItem.cz
            var dSq = dx * dx + dy * dy + dz * dz
            if (dSq > eItem.rSq) continue
            if (winner == null || dSq < winDistSq - 0.25 || (Math.abs(dSq - winDistSq) <= 0.25 && eItem.seq < winSeq)) {
                winner    = eItem.rec
                winSeq    = eItem.seq
                winDistSq = dSq
            }
        }
        return winner == null || winner.key === rec.key
    }

    function shouldEmitStaggerTick(rec, binding, tickNum) {
        var mySeq      = ensureRecordSeq(rec)
        var scopeEntry = getScopeCacheEntry(rec, binding)
        var total      = scopeEntry.list.length
        if (total <= 1) return (tickNum % binding.intervalTicks) === 0
        var idx = scopeEntry.idxByKey.get(rec.key)
        if (idx === undefined) {
            invalidateScopeCache(null, getScopeCacheKeyForRecord(rec, binding))
            scopeEntry = getScopeCacheEntry(rec, binding)
            total      = scopeEntry.list.length
            if (total <= 1) return (tickNum % binding.intervalTicks) === 0
            idx = scopeEntry.idxByKey.get(rec.key)
        }
        if (idx === undefined) idx = mySeq % total
        var phase = Math.floor((idx * binding.intervalTicks) / total)
        return ((tickNum + phase) % binding.intervalTicks) === 0
    }

    function emitForBoundBlock(rec, binding, lv, curBlock, targetPlayer) {
        if (binding == null) return 0
        var isMergeMode = ((binding.conflictMode || 'overlap') === 'merge')
        var cluster = null
        if (isMergeMode) {
            cluster = getMergeClusterForRecord(rec, binding)
            if (cluster != null && cluster.leaderKey !== rec.key) return 0
        }
        if (lv == null) lv = resolveLevel(rec.dim, null)
        if (lv == null || rec.chunkLoaded === false) return 0

        var normalizeBoundSpec = function (rawSpec) {
            var normSpec = normalizeOptionsObject(rawSpec)
            if (normSpec == null || typeof normSpec !== 'object') return rawSpec
            var hasNs = (normSpec.namespace != null && String(normSpec.namespace).trim() !== '') ||
                        (normSpec.ns != null && String(normSpec.ns).trim() !== '')
            var outSpec = normSpec
            if (!hasNs) {
                outSpec = {}
                for (var ok in normSpec) {
                    if (Object.prototype.hasOwnProperty.call(normSpec, ok)) outSpec[ok] = normSpec[ok]
                }
                outSpec.namespace = binding.defaultNamespace
            }
            var effNs = String(pickNonEmpty(outSpec, ['namespace', 'ns'], binding.defaultNamespace))
            binding.lastEmittedNs = effNs
            var specPri = parsePriority(pick(outSpec, ['priority', 'importance'], null), -1)
            if (specPri >= 0 && specPri > (binding.maxSeenPriority || -1)) {
                binding.maxSeenPriority = specPri
            }
            return outSpec
        }

        var t0Ns    = nowNano()
        var sentOut = 0
        try {
            if (curBlock == null && typeof lv.getBlock === 'function') {
                try { curBlock = lv.getBlock(rec.x, rec.y, rec.z) } catch (e0) { reportCatch('boundBlockGet', e0) }
            }
            if (curBlock != null && BASE.extractBlockId(curBlock) !== rec.blockId) return 0

            var cx = rec.x + 0.5, cy = rec.y + 0.5, cz = rec.z + 0.5
            var r  = binding.radius
            var visitTargets = function (cb) {
                if (targetPlayer != null) {
                    var tpPos = readPlayerPos(targetPlayer)
                    if (tpPos == null) return 0
                    var tpDim = null
                    try {
                        var tpLv = BASE.safeReadProp(targetPlayer, 'level')
                        if (tpLv == null && typeof targetPlayer.getLevel === 'function') tpLv = targetPlayer.getLevel()
                        if (tpLv != null) tpDim = BASE.dimOfLevel(resolveLevel(tpLv, SERVER_REF) || tpLv)
                    } catch (eDim) { }
                    if (tpDim != null && rec.dim != null && tpDim !== rec.dim) return 0
                    if (cluster != null) {
                        if (!isPointInMergeCluster(cluster, tpPos.x, tpPos.y, tpPos.z)) return 0
                    } else {
                        var tdx = tpPos.x - cx, tdy = tpPos.y - cy, tdz = tpPos.z - cz
                        if ((tdx * tdx + tdy * tdy + tdz * tdz) > (r * r)) return 0
                    }
                    cb(targetPlayer)
                    return 1
                }
                return cluster != null
                    ? forEachPlayerInMergeCluster(lv, cluster, cb)
                    : forEachPlayerInRadius(lv, cx, cy, cz, r, cb)
            }

            // 模式 1（共享模式 perPlayer === false，默认）：仅当至少有一名玩家通过作用域准入后才延迟生成并打包一次，避免 merge/竞争落选方块空耗构包
            if (!binding.perPlayer) {
                var sharedBuilt = false
                var sharedPkt   = null
                visitTargets(function (p) {
                    if (!shouldEmitForBoundBlockToPlayer(rec, binding, p)) return
                    if (!sharedBuilt) {
                        sharedBuilt = true
                        var sharedSpec = null
                        try {
                            sharedSpec = typeof binding.specOrFn === 'function'
                                ? binding.specOrFn({
                                    block:  curBlock,
                                    level:  lv,
                                    server: SERVER_REF,
                                    dim:    rec.dim,
                                    x:      rec.x,
                                    y:      rec.y,
                                    z:      rec.z,
                                    player: null
                                })
                                : binding.specOrFn
                        } catch (eSharedSpec) {
                            reportCatch('emitForBoundBlock:shared_spec', eSharedSpec)
                            sharedSpec = null
                        }
                        if (sharedSpec != null) {
                            sharedPkt = buildValidatedPacket(normalizeBoundSpec(sharedSpec), null)
                            if (sharedPkt != null && sharedPkt.priority > (binding.maxSeenPriority || -1)) {
                                binding.maxSeenPriority = sharedPkt.priority
                            }
                        }
                    }
                    if (sharedPkt == null) return
                    try {
                        p.sendData(CHANNEL, sharedPkt)
                        sentOut++
                    } catch (eSend) {
                        reportCatch('emitForBoundBlock:shared_send', eSend)
                    }
                })
                return sentOut
            }

            // 模式 2（独立模式 perPlayer === true）：对生效范围内每名玩家各自调用一次 specOrFn（传入 player: p）
            visitTargets(function (p) {
                if (!shouldEmitForBoundBlockToPlayer(rec, binding, p)) return
                try {
                    var rawSpec = typeof binding.specOrFn === 'function'
                        ? binding.specOrFn({
                            block:  curBlock,
                            level:  lv,
                            server: SERVER_REF,
                            dim:    rec.dim,
                            x:      rec.x,
                            y:      rec.y,
                            z:      rec.z,
                            player: p
                        })
                        : binding.specOrFn
                    if (rawSpec != null) {
                        var normPerP = normalizeBoundSpec(rawSpec)
                        sentOut += toPlayer(p, normPerP)
                    }
                } catch (eEmit) {
                    reportCatch('emitForBoundBlock:per_player', eEmit)
                }
            })
            return sentOut
        } finally {
            recordEmitTelemetry((nowNano() - t0Ns) / 1000000.0, sentOut)
        }
    }

    function handleBoundBlockRemoved(rec, binding) {
        var scKey = (rec != null && binding != null) ? getScopeCacheKeyForRecord(rec, binding) : null
        invalidateScopeCache(rec != null ? rec.key : null, scKey)
        if (rec == null || binding == null || !binding.group) return
        var clearNs  = binding.lastEmittedNs || binding.defaultNamespace || ('blk:' + rec.blockId)
        var clearPri = (binding.clearMaxPriority != null)
            ? binding.clearMaxPriority
            : ((binding.maxSeenPriority != null && binding.maxSeenPriority >= 0) ? binding.maxSeenPriority : 5)
        var clearSpec = {
            group:       binding.group,
            namespace:   clearNs,
            maxPriority: clearPri
        }
        if ((binding.conflictMode || 'overlap') === 'merge') {
            var scopeEntry = getScopeCacheEntry(rec, binding)
            var remaining  = []
            for (var i = 0; i < scopeEntry.list.length; i++) {
                if (scopeEntry.list[i].rec.key !== rec.key) {
                    remaining.push(scopeEntry.list[i])
                }
            }
            if (remaining.length > 0) {
                var lv = resolveLevel(rec.dim, null)
                if (lv != null) {
                    var pkt = buildValidatedPacket(buildClearOptions(clearSpec, null), null)
                    if (pkt != null) {
                        var clearRad   = binding.radius + 6
                        var clearRadSq = clearRad * clearRad
                        var rcx = rec.x + 0.5, rcy = rec.y + 0.5, rcz = rec.z + 0.5
                        forEachPlayerInLevel(lv, function (p) {
                            var pPos = readPlayerPos(p)
                            if (pPos == null) return
                            var cdx = pPos.x - rcx, cdy = pPos.y - rcy, cdz = pPos.z - rcz
                            if ((cdx * cdx + cdy * cdy + cdz * cdz) > clearRadSq) return
                            for (var j = 0; j < remaining.length; j++) {
                                var rem = remaining[j]
                                var dx  = pPos.x - rem.cx, dy = pPos.y - rem.cy, dz = pPos.z - rem.cz
                                if ((dx * dx + dy * dy + dz * dz) <= rem.rSq) {
                                    return
                                }
                            }
                            try { p.sendData(CHANNEL, pkt) } catch (eClr) { reportCatch('clearNearSend', eClr) }
                        })
                    }
                }
                if (scopeEntry.idxByKey != null && scopeEntry.idxByKey.has(rec.key)) {
                    invalidateScopeCache(rec.key, scKey)
                }
                return
            }
            if (scopeEntry.idxByKey != null && scopeEntry.idxByKey.has(rec.key)) {
                invalidateScopeCache(rec.key, scKey)
            }
        }
        clearNear(rec.dim, rec.x + 0.5, rec.y + 0.5, rec.z + 0.5, binding.radius + 6, clearSpec)
    }

    function flushTrackedBlocksForJoinedPlayer(targetPlayer) {
        if (targetPlayer == null || danmakuBlockTracker == null || boundMetaByBlockId.size === 0) return 0
        try {
            if (typeof targetPlayer.isRemoved === 'function' && targetPlayer.isRemoved()) return 0
        } catch (eRem) { }
        var recs = danmakuBlockTracker.getTrackedRecords(null)
        if (!recs || recs.length === 0) return 0
        var totalSent = 0
        for (var i = 0; i < recs.length; i++) {
            var rec = recs[i]
            if (rec == null) continue
            var binding = boundMetaByBlockId.get(rec.blockId)
            if (binding == null) continue
            totalSent += emitForBoundBlock(rec, binding, null, null, targetPlayer)
        }
        return totalSent
    }

    var danmakuBlockTracker = null

    function createDanmakuBlockTrackerInstance() {
        return BASE.acquireBlockTracker({
            name:             'danmaku',
            maintainInterval: 1,
            onBindingChanged: function () {
                invalidateScopeCache(null)
            },
            onFound: function (rec, binding, source) {
                ensureRecordSeq(rec)
                invalidateScopeCache(null, getScopeCacheKeyForRecord(rec, binding))
                // 玩家新放置、区块扫盘或持久化加载时立即触发首帧反馈；若归属于已存在合并集群的从属方块则静默合并，不额外运行
                if (source === 'placed' || source === 'fallback_placed' || source === 'scan' || source === 'persist') {
                    if ((binding.conflictMode || 'overlap') === 'merge' && !isMergeClusterLeader(rec, binding)) {
                        return
                    }
                    emitForBoundBlock(rec, binding, null, null)
                }
            },
            onTick: function (rec, binding, tickNum, lv, curBlock) {
                if ((binding.conflictMode || 'overlap') === 'merge' && !isMergeClusterLeader(rec, binding)) {
                    return
                }
                var due = binding.conflictMode === 'stagger'
                    ? shouldEmitStaggerTick(rec, binding, tickNum)
                    : ((tickNum % binding.intervalTicks) === 0)
                if (due) {
                    emitForBoundBlock(rec, binding, lv, curBlock)
                }
            },
            onRemoved: function (rec, binding, reason) {
                // handleBoundBlockRemoved 内部统一通过 invalidateScopeCache(rec.key, ...) 清理 blockSeqByKey（覆盖 unbind/broken/block_changed）
                handleBoundBlockRemoved(rec, binding)
            }
        })
    }

    function ensureDanmakuBlockTracker() {
        var hasReal = (typeof global !== 'undefined' && global.EpiphyBlockTracker != null && typeof global.EpiphyBlockTracker.createTracker === 'function')
        if (danmakuBlockTracker != null) {
            if (!danmakuBlockTracker.isFallback || !hasReal) {
                return danmakuBlockTracker
            }
            var oldFallback = danmakuBlockTracker
            var upgraded    = createDanmakuBlockTrackerInstance()
            if (upgraded != null && !upgraded.isFallback) {
                boundMetaByBlockId.forEach(function (metaEntry, bid) {
                    upgraded.bind(bid, metaEntry)
                })
                try {
                    if (typeof oldFallback.destroy === 'function') oldFallback.destroy()
                } catch (eOldFb) { }
                danmakuBlockTracker = upgraded
                invalidateScopeCache(null)
            }
            return danmakuBlockTracker
        }
        danmakuBlockTracker = createDanmakuBlockTrackerInstance()
        return danmakuBlockTracker
    }

    function bindBlock(blockId, specOrFn, extraOpts) {
        if (!blockId || specOrFn == null) return false
        var tracker = ensureDanmakuBlockTracker()
        if (tracker == null) return false
        var idStr    = String(blockId).trim()
        var meta     = (extraOpts != null && typeof extraOpts === 'object') ? extraOpts : (typeof specOrFn === 'object' ? specOrFn : {})
        var radius   = Number(pick(meta, ['radius', 'range'], 30))
        if (!isFinite(radius) || radius <= 0) radius = 30
        var interval = Number(pick(meta, ['intervalTicks', 'interval'], 48))
        if (!isFinite(interval) || interval < 1) interval = 48
        var grp      = meta.group != null ? String(meta.group) : null
        // 物理默认采用共享模式 (perPlayer: false)：同一世界方块对周围玩家应呈现一致广播；
        // 显式传 shared: true 始终共享；否则优先读取 perPlayer，其次接受 shared: false 开启按玩家独立计算。
        var perPlayer = false
        if (meta.shared === true) {
            perPlayer = false
        } else if (meta.perPlayer !== undefined) {
            perPlayer = Boolean(meta.perPlayer)
        } else if (meta.shared === false) {
            perPlayer = true
        }
        var conflictMode = normalizeDanmakuConflictMode(
            pick(meta, ['conflictMode', 'sourceConflict', 'overlapMode'], undefined),
            'overlap'
        )
        var conflictScope = meta.conflictScope != null ? String(meta.conflictScope).trim().toLowerCase() : 'block'
        if (conflictScope !== 'block' && conflictScope !== 'group' && conflictScope !== 'all') {
            conflictScope = 'block'
        }
        var conflictCooldown = Number(pick(meta, ['conflictCooldownTicks', 'sourceCooldownTicks'], interval))
        if (!isFinite(conflictCooldown) || conflictCooldown < 1) conflictCooldown = interval
        var defNsRaw = pickNonEmpty(meta, ['namespace', 'ns'], null)
        var defNs    = defNsRaw != null ? String(defNsRaw).trim() : ('blk:' + idStr)
        var clearPri = pick(meta, ['clearMaxPriority'], null)
        var metaEntry = {
            blockId:               idStr,
            specOrFn:              specOrFn,
            radius:                radius,
            scanRadius:            Math.min(128, Math.max(16, radius + 6)),
            intervalTicks:         Math.floor(interval),
            group:                 grp,
            defaultNamespace:      defNs,
            lastEmittedNs:         defNs,
            maxSeenPriority:       -1,
            clearMaxPriority:      clearPri != null ? parsePriority(clearPri, 5) : null,
            perPlayer:             perPlayer,
            conflictMode:          conflictMode,
            conflictScope:         conflictScope,
            conflictCooldownTicks: Math.floor(conflictCooldown)
        }
        boundMetaByBlockId.set(idStr, metaEntry)
        tracker.bind(idStr, metaEntry)
        if (!global.ScreenDanmakuBlockBindings || typeof global.ScreenDanmakuBlockBindings !== 'object') {
            global.ScreenDanmakuBlockBindings = {}
        }
        global.ScreenDanmakuBlockBindings[idStr] = { specOrFn: specOrFn, extraOpts: meta }
        invalidateScopeCache(null)
        return true
    }

    function unbindBlock(blockId) {
        if (!blockId) return 0
        var tracker = ensureDanmakuBlockTracker()
        if (tracker == null) return 0
        var idStr = String(blockId).trim()
        boundMetaByBlockId.delete(idStr)
        if (global.ScreenDanmakuBlockBindings && typeof global.ScreenDanmakuBlockBindings === 'object') {
            delete global.ScreenDanmakuBlockBindings[idStr]
        }
        invalidateScopeCache(null)
        return tracker.unbind(idStr)
    }

    function scanBlocksNow() {
        var tracker = ensureDanmakuBlockTracker()
        return tracker != null ? tracker.scanNow() : 0
    }

    function absorbGlobalDanmakuBlockBindings() {
        var reg = global.ScreenDanmakuBlockBindings
        if (reg != null && typeof reg === 'object') {
            var bids = Object.keys(reg)
            for (var i = 0; i < bids.length; i++) {
                var bid   = bids[i]
                var entry = reg[bid]
                if (entry != null) {
                    if (entry.specOrFn != null) bindBlock(bid, entry.specOrFn, entry.extraOpts)
                    else bindBlock(bid, entry)
                }
            }
        }
    }

    absorbGlobalDanmakuBlockBindings()

    ServerEvents.tick(function (event) {
        try {
            if (event.server != null) SERVER_REF = event.server
            if (danmakuTickCounter === 1) {
                absorbGlobalDanmakuBlockBindings()
            }
        } catch (eTick) {
            reportCatch('ServerEvents.tick', eTick)
        }
    })

    function configure(patch) {
        if (patch != null && typeof patch === 'object') {
            var cfgPatch = (patch.CONFIG && typeof patch.CONFIG === 'object') ? patch.CONFIG : patch
            for (var ck in cfgPatch) {
                if (Object.prototype.hasOwnProperty.call(CONFIG, ck) && cfgPatch[ck] !== undefined) {
                    CONFIG[ck] = cfgPatch[ck]
                }
            }
            var defPatch = (patch.DEFAULTS && typeof patch.DEFAULTS === 'object') ? patch.DEFAULTS : patch
            for (var dk in defPatch) {
                if (Object.prototype.hasOwnProperty.call(DEFAULTS, dk) && defPatch[dk] !== undefined) {
                    DEFAULTS[dk] = defPatch[dk]
                }
            }
        }
        return { CONFIG: CONFIG, DEFAULTS: DEFAULTS }
    }

    global.ScreenDanmaku = {
        VERSION:            '6.0.0',
        CHANNEL:            CHANNEL,
        configure:          configure,
        bindBlock:          bindBlock,
        watchBlock:         bindBlock,
        unbindBlock:        unbindBlock,
        unwatchBlock:       unbindBlock,
        scanBlocksNow:      scanBlocksNow,
        CONFIG:             CONFIG,
        DEFAULTS:           DEFAULTS,
        HUD_FORBIDDEN:      HUD_FORBIDDEN_PRESETS,
        buildPacket:        buildValidatedPacket,
        buildProgressPanel: buildProgressPanel,
        safeSend:           safeSend,
        send:               send,
        toPlayer:           toPlayer,
        inDimension:        inDimension,
        atEvent:            atEvent,
        patchPlayer:        patchPlayer,
        patchNear:          patchNear,
        deactivatePlayer:   deactivatePlayer,
        deactivateNear:     deactivateNear,
        sendToPlayer:       toPlayer,
        sendNear:           inDimension,
        sendMinorEdgeNear:  sendMinorEdgeNear,
        clearPlayer:        clearPlayer,
        clearNear:          clearNear,
        getStats:           getStats,
        _pure: Object.freeze({
            parseSize:              parseSize,
            parseTilt:              parseTilt,
            parseColor:             parseColor,
            parseTicksOrSec:        parseTicksOrSec,
            parseSpecString:        parseSpecString,
            sanitizeClipSpec:       sanitizeClipSpec,
            sanitizeRectFill:       sanitizeRectFill,
            sanitizeNodesList:      sanitizeNodesList,
            getDeprecatedAliasHits: function () { return deprecatedAliasHits }
        })
    }
    global.Epiphy2DSurface = global.ScreenDanmaku

    // ========================================================================
    //  第二部分：向权限阀组件 (EpiphyPermissionValve) 声明 `danmaku` 子命令与帮助手册
    // ========================================================================

    var DANMAKU_HELP_LINES = [
        '§3§l----------------------------------------------------',
        '§b§l  [ Epiphy 屏幕弹幕组件 // /epiphy danmaku 帮助手册 ]',
        '§3§l----------------------------------------------------',
        '§e1. 查看弹幕帮助： §f/epiphy danmaku help §7(或 §f/epiphy help danmaku§7)',
        '§e2. 仅给自己显示： §f/epiphy danmaku self <弹幕内容与可选参数...>',
        '§e3. 指定玩家显示： §f/epiphy danmaku player <玩家> <弹幕内容与可选参数...>',
        '§e4. 自身周围显示： §f/epiphy danmaku here <半径> <弹幕内容与可选参数...>',
        '§e5. 维度坐标显示： §f/epiphy danmaku pos <维度> <x> <y> <z> <半径> <弹幕内容与可选参数...>',
        '§e6. 停止持续弹幕： §f/epiphy danmaku stop [玩家] [key或分组名] [fadeOut] [maxPriority]',
        '§e7. 清空屏幕弹幕： §f/epiphy danmaku clear [玩家] [分组名(默认*)] [maxPriority]',
        '§7----------------------------------------------------',
        '§6【文本与可选键值参数语法（所有非必填参数均可直接省略不写）】：',
        '  §a必填文本§7：直接书写主文本，可用 §f|§7 分隔主副标题（支持 §f&c &l§7 颜色码与 §f\\n§7 换行）',
        '  §blife=§fonce(单次触发，适用存在时间) §7| §factive(持续激活模式，红石/脚本停止后消失)',
        '  §bpriority=§flow(1)|normal(2,单次默认)|high(3)|critical(4)|active(5,持续默认) §8(stop/clear 的 maxPriority 需 >=5 才能停止默认持续弹幕)',
        '  §bduration=§f存在时间tick(如 80) 或秒数(如 4s) §7| 写 §fduration=active §7同为持续激活模式',
        '  §bpos=§fcenter|top|bottom|left|right|below_minimap|above_hotbar|edge|spread|random §8(默认 center)',
        '  §bavoidhud=§ftrue|false §7| §bavoid=§fminimap,hotbar,crosshair §8(随机采样位置默认避开常见 HUD 区域)',
        '  §bmovable=§ftrue|false §8(默认 false：同 key 续期时锁定初始位置；需移动时设为 true)',
        '  §bnormalizekey=§ftrue|false §8(默认 true：自动 key 归并动态数字；设为 false 区分不同数字文本)',
        '  §brestart=§ftrue|false §8(默认 false：同 key 更新时是否重置 born 时间基准以重播入场动画)',
        '  §bsize=§ftiny|small|small_random|normal|large|huge|random §7或数值 §f0.2~4.0 §8(默认 1.0)',
        '  §btilt=§f角度数值(如 -30~30 或区间 -40~40) §7或 §fleft|right|random(正斜随机) §8(默认 0 端正)',
        '  §bmode=§fall(一次全部生成) §7| §fchar(从首字逐字跳出) §8(默认 all)',
        '  §bshake=§fnone(不震动)|constant(持续)|decay(生成时衰减)|fade_in(淡出前震动)|pulse(余震脉冲)|per_char(逐字独立抖动)|random §8(默认 none)',
        '  §bshakefreq=§f单字震动周期(如 0.8s 统一同步抖动，或 0.8~1.3 区间随机) §7| §bshakeamp=§f震动幅度数值',
        '  §bfade=§fshrink(逐渐变小)|char_first(首字剥落)|char_last(尾字退格)|blink(闪烁)|shatter(碎片崩解)|blur(柔和虚化)|split(裂解重影)|random §8(默认 shrink)',
        '  §bspacing=§f额外字距像素(默认 0 关闭) §7| §boutline=§fstroke(描边外圈)|glow(发光外圈) §7| §boutlinecolor=§f#000000 §7| §boutlinewidth=§f0.75',
        '  §b局部富文本标签§7：文本内可写 §f<b>加粗</b>§7、§f<big>放大</big>§7(或 §f<scale=1.4>...§7)、§f<shake>局部抖动</shake>§7、§f<outline=#000000>描边</outline>§7（默认不开启零开销）',
        '  §bmaxgroup=§f同分组同屏最大弹幕条数(如 3，超出时自动淘汰同组最早弹幕，默认0不限)',
        '  §bmaxwidth=§f最大行宽(像素或0~1屏幕比例，默认0按86%屏宽折行) §7| §bwrap=§ftrue|false §7| §bclamp=§ftrue|false',
        '  §bshowingui=§ftrue|false §8(默认 false：打开背包/箱子/菜单时不遮挡 GUI 界面)',
        '§7----------------------------------------------------',
        '§d【示例 1（生成时震动衰减 + 从首字开始消失）】：',
        '  §f/epiphy danmaku player @s &c&l[警告：系统过载]|&7冷却液泄漏 pos=edge size=small_random tilt=random mode=char shake=decay fade=char_first',
        '§d【示例 2（逐字独立震动 + 淡出虚化 + 同组最多3条）】：',
        '  §f/epiphy danmaku here 30 &b致某人的指令 pos=spread tilt=-40~40 mode=char shake=per_char shakefreq=0.8~1.3 fade=blur group=prescript maxgroup=3'
    ]

    function dmBoolField(defVal) {
        return function (v, o, _err, k) {
            o[k] = parseBool(v, defVal)
        }
    }

    var DANMAKU_SPEC_SCHEMA = {
        unknownMode:   'collectFree',
        splitFreePipe: true,
        aliases: {
            spacing:        'letterSpacing',
            charspacing:    'letterSpacing',
            outlinemode:    'outlineMode',
            outlinecolor:   'outlineColor',
            glowcolor:      'outlineColor',
            outlinewidth:   'outlineWidth',
            glowwidth:      'outlineWidth',
            boldtarget:     'boldTarget',
            scaletarget:    'scaleTarget',
            targetscale:    'targetScale',
            shaketarget:    'shakeTarget',
            bychar:         'typewriter',
            existtime:      'duration',
            holdticks:      'activeHold',
            life:           'lifeMode',
            existmode:      'lifeMode',
            sustained:      'continuous',
            shakemode:      'shakeMode',
            shakeamp:       'shakeAmp',
            shakeinterval:  'shakeFreq',
            charshake:      'perCharShake',
            fadestyle:      'fadeStyle',
            fademode:       'fadeStyle',
            importance:     'priority',
            maxgroupsize:   'maxGroup',
            grouplimit:     'maxGroup',
            maxconcurrent:  'maxGroup',
            showingui:      'showInGui',
            move:           'movable',
            updatepos:      'movable',
            resetanimation: 'restart',
            slot:           'id',
            ns:             'namespace'
        },
        fields: {
            text:          'str',
            title:         'str',
            sub:           'str',
            subtitle:      'str',
            pos:           'str',
            rx:            'str',
            ry:            'str',
            avoid:         'str',
            avoidHud:      dmBoolField(DEFAULTS.avoidHud),
            size:          'str',
            scale:         'str',
            tilt:          'str',
            angle:         'str',
            color:         'str',
            subColor:      'str',
            letterSpacing: { type: 'num', fallback: 0 },
            outline:       'str',
            outlineMode:   'str',
            outlineColor:  'str',
            outlineWidth:  { type: 'nonneg', min: 0.25, fallback: DEFAULTS.outlineWidth },
            glow:          'str',
            boldTarget:    'str',
            scaleTarget:   'str',
            targetScale:   { type: 'num', fallback: 1.35 },
            shakeTarget:   'str',
            mode:          'str',
            typewriter:    dmBoolField(false),
            charMs:        { type: 'nonneg', min: 8, fallback: DEFAULTS.charMs },
            cursor:        'str',
            shadow:        dmBoolField(DEFAULTS.shadow),
            shake:         'str',
            shakeMode:     'str',
            shakeAmp:      { type: 'nonneg', min: 0.0, fallback: DEFAULTS.shakeAmp },
            shakeFreq:     'str',
            perCharShake:  dmBoolField(true),
            fade:          'str',
            fadeStyle:     'str',
            fadeOut:       'str',
            stay:          'str',
            duration:      'str',
            activeHold:    'str',
            lifeMode:      'str',
            continuous:    dmBoolField(false),
            priority:      'str',
            maxPriority:   'str',
            includeOnce:   dmBoolField(false),
            maxWidth:      function (v, o) { o.maxWidth = sanitizeMaxWidth(v) },
            wrap:          dmBoolField(DEFAULTS.wrap),
            clamp:         dmBoolField(DEFAULTS.clamp),
            showInGui:     dmBoolField(DEFAULTS.showInGui),
            maxGroup:      { type: 'nonneg', min: 0, fallback: 0 },
            movable:       dmBoolField(DEFAULTS.movable),
            normalizeKey:  dmBoolField(DEFAULTS.normalizeKey),
            restart:       dmBoolField(false),
            key:           'str',
            id:            'str',
            namespace:     'str',
            group:         'str',
            debug:         dmBoolField(true)
        }
    }

    var PLAYER_DANMAKU_LIMITS = {
        maxPriority:         3,
        minScale:            0.5,
        maxScale:            2.0,
        maxInlineScale:      1.5,
        maxTextLen:          120,
        maxSubLen:           80,
        maxCursorLen:        8,
        maxOutlineWidth:     1.5,
        maxLines:            3,
        maxStayTicks:        200,
        maxFadeOutTicks:     60,
        maxWidth:            260,
        maxRadius:           32,
        broadcastMaxRadius:  96,
        maxBroadcastTargets: 4,
        commandCooldownMs:   250
    }
    var playerCmdCooldownMap = new Map() // uuid -> lastAllowedAtMs

    function resolveDanmakuActorTier(source) {
        var valve = (typeof global !== 'undefined' && global != null) ? global.EpiphyPermissionValve : null
        if (valve != null && typeof valve.getCommandActorTier === 'function') {
            return valve.getCommandActorTier(source)
        }
        if (source != null) {
            var pl = (typeof source.getPlayer === 'function') ? source.getPlayer() : source.player
            if (pl != null) {
                // 权限阀缺失时 Fail-Closed：绝不信任 bare hasPermissions(2)
                var isOp = Boolean(typeof pl.isOp === 'function' && pl.isOp())
                var u = getPlayerUuidSafe(pl)
                return {
                    tier:     isOp ? 'system' : 'player',
                    isPlayer: true,
                    isOp:     isOp,
                    uuid:     u ? String(u).trim().toLowerCase() : 'anon',
                    player:   pl
                }
            }
        }
        return { tier: 'system', isPlayer: false, isOp: true, uuid: '', player: null }
    }

    function clampInlineRichTags(str) {
        var s = String(str != null ? str : '')
        s = s.replace(/<\s*big\s*>/gi, '<scale=1.25>')
        s = s.replace(/<\s*scale\s*=\s*([^>]+?)\s*>/gi, function (_all, rawNum) {
            var n = Number(rawNum)
            if (!isFinite(n)) n = 1.0
            if (n < PLAYER_DANMAKU_LIMITS.minScale) n = PLAYER_DANMAKU_LIMITS.minScale
            if (n > PLAYER_DANMAKU_LIMITS.maxInlineScale) n = PLAYER_DANMAKU_LIMITS.maxInlineScale
            return '<scale=' + n + '>'
        })
        return s
    }

    function clampPlayerTextField(rawVal, maxChars, maxLines) {
        if (rawVal == null) return ''
        var normalized = String(rawVal).replace(/\\n/g, '\n')
        var clampedTags = clampInlineRichTags(normalized)
        var lines = clampedTags.split('\n')
        if (lines.length > maxLines) {
            lines = lines.slice(0, maxLines)
        }
        var joined = lines.join('\n')
        if (joined.length > maxChars) {
            joined = joined.slice(0, maxChars)
        }
        return joined
    }

    function applyPlayerDanmakuLimits(opts, actor) {
        if (opts == null || typeof opts !== 'object') return opts
        if (actor == null || actor.tier !== 'player') return opts

        var ownerNs = 'u:' + (actor.uuid || 'anon')
        opts._sourceTier = 'player'
        opts._ownerUuid  = actor.uuid || 'anon'
        opts.tier        = 'player'
        opts.namespace   = ownerNs
        opts.ns          = ownerNs
        var rawPlayerGrp = String(opts.group != null && opts.group !== '' ? opts.group : DEFAULTS.group)
        opts.group       = (rawPlayerGrp.indexOf(ownerNs + ':') === 0) ? rawPlayerGrp : (ownerNs + ':' + rawPlayerGrp)

        if (opts.text != null) opts.text = clampPlayerTextField(opts.text, PLAYER_DANMAKU_LIMITS.maxTextLen, PLAYER_DANMAKU_LIMITS.maxLines)
        if (opts.title != null) opts.title = clampPlayerTextField(opts.title, PLAYER_DANMAKU_LIMITS.maxTextLen, PLAYER_DANMAKU_LIMITS.maxLines)
        if (opts.sub != null) opts.sub = clampPlayerTextField(opts.sub, PLAYER_DANMAKU_LIMITS.maxSubLen, PLAYER_DANMAKU_LIMITS.maxLines)
        if (opts.subtitle != null) opts.subtitle = clampPlayerTextField(opts.subtitle, PLAYER_DANMAKU_LIMITS.maxSubLen, PLAYER_DANMAKU_LIMITS.maxLines)
        if (opts.cursor != null) {
            opts.cursor = truncateSafeProtoText(String(opts.cursor).replace(/[\r\n]/g, ''), PLAYER_DANMAKU_LIMITS.maxCursorLen)
        }
        if (opts.outlineWidth != null) {
            opts.outlineWidth = Math.min(PLAYER_DANMAKU_LIMITS.maxOutlineWidth, parseNonNegNum(opts.outlineWidth, DEFAULTS.outlineWidth, 0.25))
        }
        if (opts.glowWidth != null) {
            opts.glowWidth = Math.min(PLAYER_DANMAKU_LIMITS.maxOutlineWidth, parseNonNegNum(opts.glowWidth, DEFAULTS.outlineWidth, 0.25))
        }

        var szInfo = parseSize(opts.size, opts.scale)
        var clampedScale = Math.max(PLAYER_DANMAKU_LIMITS.minScale, Math.min(PLAYER_DANMAKU_LIMITS.maxScale, szInfo.scale))
        opts.scale = Number(clampedScale.toFixed(2))
        delete opts.size

        var reqPri = parsePriority(pick(opts, ['priority', 'importance'], null), DEFAULTS.priority)
        opts.priority = Math.min(reqPri, PLAYER_DANMAKU_LIMITS.maxPriority)
        delete opts.importance

        opts.wrap  = true
        opts.clamp = true
        opts.maxWidth = Math.min(sanitizeMaxWidth(opts.maxWidth != null ? opts.maxWidth : DEFAULTS.maxWidth), PLAYER_DANMAKU_LIMITS.maxWidth)

        var stayTicks = parseTicksOrSec(opts.stay)
        if (stayTicks !== null && stayTicks > PLAYER_DANMAKU_LIMITS.maxStayTicks) {
            opts.stay = PLAYER_DANMAKU_LIMITS.maxStayTicks
        }
        var durTicks = parseTicksOrSec(opts.duration)
        if (durTicks !== null && durTicks > PLAYER_DANMAKU_LIMITS.maxStayTicks) {
            opts.duration = PLAYER_DANMAKU_LIMITS.maxStayTicks
        }
        var holdTicks = parseTicksOrSec(opts.activeHold)
        if (holdTicks !== null && holdTicks > PLAYER_DANMAKU_LIMITS.maxStayTicks) {
            opts.activeHold = PLAYER_DANMAKU_LIMITS.maxStayTicks
        }
        var foTicks = parseTicksOrSec(opts.fadeOut)
        if (foTicks !== null && foTicks > PLAYER_DANMAKU_LIMITS.maxFadeOutTicks) {
            opts.fadeOut = PLAYER_DANMAKU_LIMITS.maxFadeOutTicks
        }
        return opts
    }

    function checkPlayerDanmakuCmdRate(actor, bucket) {
        if (actor == null || actor.tier !== 'player' || !actor.uuid) return true
        var key   = (bucket ? String(bucket) : 'send') + ':' + String(actor.uuid).trim().toLowerCase()
        var nowMs = Date.now()
        var last  = playerCmdCooldownMap.get(key) || 0
        if ((nowMs - last) < PLAYER_DANMAKU_LIMITS.commandCooldownMs) {
            return false
        }
        if (playerCmdCooldownMap.size >= 2048) {
            playerCmdCooldownMap.forEach(function (v, k) {
                if ((nowMs - v) >= PLAYER_DANMAKU_LIMITS.commandCooldownMs) {
                    playerCmdCooldownMap.delete(k)
                }
            })
            if (playerCmdCooldownMap.size >= 2048) playerCmdCooldownMap.clear()
        }
        playerCmdCooldownMap.set(key, nowMs)
        return true
    }

    function parseSpecString(specStr) {
        if (!specStr || String(specStr).trim().length === 0) {
            return {}
        }
        var opts = SPEC.parseCommandSpec(specStr, DANMAKU_SPEC_SCHEMA).opts
        if (opts != null) {
            delete opts._sourceTier
            delete opts._ownerUuid
            delete opts.tier
        }
        return opts
    }

    // 构建 danmaku 子命令节点，所有 executes 分支统一由权限阀 guardExecution 包裹
    function buildDanmakuCommandNode(regCtx) {
        var cb = BASE.createCommandBuilder(regCtx, { tag: 'Epiphy Danmaku' })

        function cmdErr(ctx, msg) {
            return cb.replyErr(ctx, msg + ' §7(输入 §f/epiphy danmaku help §7查看语法)')
        }

        function hasDanmakuBroadcastGrant(actor) {
            if (actor == null || actor.tier !== 'player') return true
            var valve = (typeof global !== 'undefined' && global != null) ? global.EpiphyPermissionValve : null
            var srv = SERVER_REF || (actor.player != null ? actor.player.server : null)
            if (valve != null && typeof valve.hasPlayerScope === 'function' && actor.player != null) {
                return Boolean(valve.hasPlayerScope(srv, actor.player, 'danmaku.broadcast', { exactScopeOnly: true }))
            }
            return false
        }

        function resolveTargetUuidForCount(t) {
            if (t == null) return ''
            if (typeof t === 'string') {
                if (SERVER_REF != null && typeof SERVER_REF.getPlayer === 'function') {
                    try {
                        var p = SERVER_REF.getPlayer(t)
                        if (p != null) return getPlayerUuidSafe(p)
                    } catch (e) {}
                }
                return t.trim().toLowerCase()
            }
            return getPlayerUuidSafe(t)
        }

        function countNonSelfTargets(targets, actor) {
            if (targets == null) return 0
            var selfUuid = (actor != null && actor.uuid) ? String(actor.uuid).trim().toLowerCase() : ''
            var seen = {}
            var anonCnt = 0
            var uniqueOther = 0

            var recordOne = function (t) {
                if (t == null) return
                var u = resolveTargetUuidForCount(t)
                if (u) {
                    if (selfUuid && u === selfUuid) return
                    if (!seen[u]) {
                        seen[u] = true
                        uniqueOther++
                    }
                } else {
                    anonCnt++
                }
            }

            if (Array.isArray(targets)) {
                for (var i = 0; i < targets.length; i++) recordOne(targets[i])
            } else if (typeof targets.iterator === 'function') {
                var iter = targets.iterator()
                while (iter.hasNext()) recordOne(iter.next())
            } else {
                recordOne(targets)
            }
            return uniqueOther + anonCnt
        }

        function checkBroadcastTargetLimit(ctx, targets, actor, verb) {
            if (actor == null || actor.tier !== 'player') return null
            var nonSelf = countNonSelfTargets(targets, actor)
            if (nonSelf > PLAYER_DANMAKU_LIMITS.maxBroadcastTargets && !hasDanmakuBroadcastGrant(actor)) {
                return '你未被授予 danmaku.broadcast 权限，单次最多只能对 ' + PLAYER_DANMAKU_LIMITS.maxBroadcastTargets + ' 名其他玩家' + verb + '（当前匹配 ' + nonSelf + ' 人）！'
            }
            return null
        }

        function handleStop(ctx, v) {
            var actor = resolveDanmakuActorTier(ctx.source)
            var isPlayerTier = (actor.tier === 'player')
            var ownerNs = isPlayerTier ? ('u:' + (actor.uuid || 'anon')) : ''
            if (v._count === 0) {
                var p = ctx.source.player
                if (p == null) return cmdErr(ctx, '控制台或命令方块执行 stop 请指定目标玩家！')
                if (!checkPlayerDanmakuCmdRate(actor, 'stop')) {
                    return cmdErr(ctx, '弹幕指令发送过快，请稍候重试！')
                }
                if (isPlayerTier) {
                    deactivatePlayer(p, { key: '*', group: '*', namespace: ownerNs, maxPriority: PLAYER_DANMAKU_LIMITS.maxPriority, tier: 'player' })
                    return cb.replyOk(ctx, '已停止你发送并显示在你屏幕上的持续弹幕。')
                }
                deactivatePlayer(p, '*')
                return cb.replyOk(ctx, '已停止你屏幕上的持续激活弹幕。')
            }
            var limitErr = checkBroadcastTargetLimit(ctx, v.targets, actor, '停止弹幕')
            if (limitErr != null) return cmdErr(ctx, limitErr)
            if (!checkPlayerDanmakuCmdRate(actor, 'stop')) {
                return cmdErr(ctx, '弹幕指令发送过快，请稍候重试！')
            }
            var key = v._count >= 2 ? v.key : '*'
            var pkt = { action: 'deactivate', key: key, group: key }
            if (v._count >= 3) pkt.fadeOut = v.fadeOut
            if (v._count >= 4) pkt.maxPriority = v.maxPriority
            if (isPlayerTier) {
                pkt.tier        = 'player'
                pkt.namespace   = ownerNs
                var reqStopPri  = parsePriority(pkt.maxPriority, PLAYER_DANMAKU_LIMITS.maxPriority)
                pkt.maxPriority = Math.min(reqStopPri, PLAYER_DANMAKU_LIMITS.maxPriority)
            }
            var cnt = toPlayer(v.targets, pkt)
            if (v._count === 1) cb.replyOk(ctx, '已停止 ' + cnt + ' 名玩家的' + (isPlayerTier ? '个人命名空间' : '') + '持续激活弹幕。')
            else if (v._count === 2) cb.replyOk(ctx, '已停止 ' + cnt + ' 名玩家的 [' + key + '] 持续弹幕。')
            else if (v._count === 3) cb.replyOk(ctx, '已停止 ' + cnt + ' 名玩家的 [' + key + '] 持续弹幕 (fadeOut=' + v.fadeOut + ')。')
            else cb.replyOk(ctx, '已停止 ' + cnt + ' 名玩家的 [' + key + '] 持续弹幕 (fadeOut=' + v.fadeOut + ', maxPriority=' + pkt.maxPriority + ')。')
            return cnt
        }

        function handleClear(ctx, v) {
            var actor = resolveDanmakuActorTier(ctx.source)
            var isPlayerTier = (actor.tier === 'player')
            var ownerNs = isPlayerTier ? ('u:' + (actor.uuid || 'anon')) : ''
            if (v._count === 0) {
                var p = ctx.source.player
                if (p == null) return cmdErr(ctx, '控制台或命令方块执行 clear 请指定目标玩家！')
                if (!checkPlayerDanmakuCmdRate(actor, 'clear')) {
                    return cmdErr(ctx, '弹幕指令发送过快，请稍候重试！')
                }
                if (isPlayerTier) {
                    clearPlayer(p, { group: '*', namespace: ownerNs, maxPriority: PLAYER_DANMAKU_LIMITS.maxPriority, tier: 'player' })
                    return cb.replyOk(ctx, '已清空你个人命名空间下的屏幕弹幕。')
                }
                clearPlayer(p, '*')
                return cb.replyOk(ctx, '已清空你屏幕上的所有弹幕。')
            }
            var limitErr = checkBroadcastTargetLimit(ctx, v.targets, actor, '清空弹幕')
            if (limitErr != null) return cmdErr(ctx, limitErr)
            if (!checkPlayerDanmakuCmdRate(actor, 'clear')) {
                return cmdErr(ctx, '弹幕指令发送过快，请稍候重试！')
            }
            var grp = v._count >= 2 ? v.group : '*'
            var pkt = { action: 'clear', group: grp }
            if (v._count >= 3) pkt.maxPriority = v.maxPriority
            if (isPlayerTier) {
                pkt.tier        = 'player'
                pkt.namespace   = ownerNs
                var reqClrPri   = parsePriority(pkt.maxPriority, PLAYER_DANMAKU_LIMITS.maxPriority)
                pkt.maxPriority = Math.min(reqClrPri, PLAYER_DANMAKU_LIMITS.maxPriority)
            }
            var cnt = toPlayer(v.targets, pkt)
            if (v._count === 1) cb.replyOk(ctx, '已清空 ' + cnt + ' 名玩家的' + (isPlayerTier ? '个人命名空间' : '全部') + '屏幕弹幕。')
            else if (v._count === 2) cb.replyOk(ctx, '已清空 ' + cnt + ' 名玩家的 [' + grp + '] 分组弹幕。')
            else cb.replyOk(ctx, '已清空 ' + cnt + ' 名玩家的 [' + grp + '] 分组弹幕 (maxPriority=' + pkt.maxPriority + ')。')
            return cnt
        }

        function handleSelf(ctx, v) {
            var actor = resolveDanmakuActorTier(ctx.source)
            var p = (ctx.source != null && typeof ctx.source.getPlayer === 'function') ? ctx.source.getPlayer() : (ctx.source != null ? ctx.source.player : null)
            if (p == null) return cmdErr(ctx, '控制台或命令方块无法执行 danmaku self，请改用 danmaku player 指定目标玩家！')
            if (!checkPlayerDanmakuCmdRate(actor)) {
                return cmdErr(ctx, '弹幕指令发送过快，请稍候重试！')
            }
            var opts = applyPlayerDanmakuLimits(parseSpecString(v.spec), actor)
            if (!opts.text && !opts.title) return cmdErr(ctx, '缺少必填的弹幕主文本！')
            var cnt = toPlayer(p, opts)
            cb.replyOk(ctx, '已向自己屏幕发送弹幕: §f' + (opts.text || opts.title))
            return cnt
        }

        function handlePlayer(ctx, v) {
            var actor = resolveDanmakuActorTier(ctx.source)
            var limitErr = checkBroadcastTargetLimit(ctx, v.targets, actor, '发送弹幕')
            if (limitErr != null) return cmdErr(ctx, limitErr)
            if (!checkPlayerDanmakuCmdRate(actor)) {
                return cmdErr(ctx, '弹幕指令发送过快，请稍候重试！')
            }
            var opts = applyPlayerDanmakuLimits(parseSpecString(v.spec), actor)
            if (!opts.text && !opts.title) return cmdErr(ctx, '缺少必填的弹幕主文本！')
            var cnt = toPlayer(v.targets, opts)
            cb.replyOk(ctx, '已向 ' + cnt + ' 名玩家发送弹幕: §f' + (opts.text || opts.title))
            return cnt
        }

        function computeEffectiveRadius(rawRadius, actor) {
            var r = Number(rawRadius) || 0
            if (r < 0) r = 0
            if (actor != null && actor.tier === 'player') {
                var cap = hasDanmakuBroadcastGrant(actor)
                    ? PLAYER_DANMAKU_LIMITS.broadcastMaxRadius
                    : PLAYER_DANMAKU_LIMITS.maxRadius
                return Math.min(r, cap)
            }
            return r
        }

        function handleHere(ctx, v) {
            var actor = resolveDanmakuActorTier(ctx.source)
            if (!checkPlayerDanmakuCmdRate(actor)) {
                return cmdErr(ctx, '弹幕指令发送过快，请稍候重试！')
            }
            var opts = applyPlayerDanmakuLimits(parseSpecString(v.spec), actor)
            if (!opts.text && !opts.title) return cmdErr(ctx, '缺少必填的弹幕主文本！')
            var pos = BASE.readPos(ctx.source.position)
            if (pos == null) return cmdErr(ctx, '无法读取当前指令执行位置！')
            var effRadius = computeEffectiveRadius(v.radius, actor)
            var cnt = inDimension(ctx.source.level, pos.x, pos.y, pos.z, effRadius, opts)
            return cb.replyOk(ctx, '已在当前维度半径 ' + effRadius + 'm 内触发弹幕（命中 ' + cnt + ' 名玩家）。')
        }

        function handlePos(ctx, v) {
            var actor = resolveDanmakuActorTier(ctx.source)
            if (!checkPlayerDanmakuCmdRate(actor)) {
                return cmdErr(ctx, '弹幕指令发送过快，请稍候重试！')
            }
            var tgtLevel = resolveLevel(v.dim, SERVER_REF)
            if (tgtLevel == null) return cmdErr(ctx, '无效的目标维度！')
            if (actor.tier === 'player' && !hasDanmakuBroadcastGrant(actor)) {
                var srcDim = (ctx.source != null && ctx.source.level != null) ? BASE.dimOfLevel(ctx.source.level) : ''
                var tgtDim = BASE.dimOfLevel(tgtLevel)
                if (srcDim && tgtDim && srcDim !== tgtDim) {
                    return cmdErr(ctx, '你未被授予 danmaku.broadcast 权限，禁止跨维度触发坐标弹幕！')
                }
            }
            var center = BASE.readPos(v.center)
            if (center == null) return cmdErr(ctx, '无法解析目标坐标！')
            var opts = applyPlayerDanmakuLimits(parseSpecString(v.spec), actor)
            if (!opts.text && !opts.title) return cmdErr(ctx, '缺少必填的弹幕主文本！')
            var effRadius = computeEffectiveRadius(v.radius, actor)
            var cnt = inDimension(tgtLevel, center.x, center.y, center.z, effRadius, opts)
            return cb.replyOk(ctx, '已在目标维度 (' + center.x.toFixed(1) + ', ' + center.y.toFixed(1) + ', ' + center.z.toFixed(1) + ') 半径 ' + effRadius + 'm 内触发弹幕（命中 ' + cnt + ' 名玩家）。')
        }

        return cb.literal('danmaku', {
            helpLines: DANMAKU_HELP_LINES,
            children: [
                cb.literal('help', { scope: 'danmaku.help', helpLines: DANMAKU_HELP_LINES }),
                cb.literal('self', {
                    scope: 'danmaku.self',
                    chain: [[
                        { name: 'spec', type: 'greedy' }
                    ], handleSelf]
                }),
                cb.literal('stop', {
                    scope: 'danmaku.stop',
                    chain: [[
                        { name: 'targets', type: 'players' },
                        { name: 'key', type: 'word' },
                        { name: 'fadeOut', type: 'int' },
                        { name: 'maxPriority', type: 'word' }
                    ], handleStop, { minArgs: 0 }]
                }),
                cb.literal('clear', {
                    scope: 'danmaku.clear',
                    chain: [[
                        { name: 'targets', type: 'players' },
                        { name: 'group', type: 'word' },
                        { name: 'maxPriority', type: 'word' }
                    ], handleClear, { minArgs: 0 }]
                }),
                cb.literal('player', {
                    scope: 'danmaku.player',
                    chain: [[
                        { name: 'targets', type: 'players' },
                        { name: 'spec', type: 'greedy' }
                    ], handlePlayer]
                }),
                cb.literal('here', {
                    scope: 'danmaku.here',
                    chain: [[
                        { name: 'radius', type: 'double' },
                        { name: 'spec', type: 'greedy' }
                    ], handleHere]
                }),
                cb.literal('pos', {
                    scope: 'danmaku.pos',
                    chain: [[
                        { name: 'dim', type: 'dim' },
                        { name: 'center', type: 'vec3' },
                        { name: 'radius', type: 'double' },
                        { name: 'spec', type: 'greedy' }
                    ], handlePos]
                })
            ]
        })
    }

    var danmakuSubcommandSpec = {
        name:       'danmaku',
        // 由屏幕弹幕组件自行声明权限策略：
        //   - 命令方块 (BaseCommandBlock) 与控制台 (MinecraftServer) 放行；
        //   - 玩家聊天框执行需 [可作弊 + 是管理员或已被授予对应 scope（如 danmaku.self / danmaku.*）]；
        //   - 其他脚本函数若以命令形式调用，须先调用 EpiphyPermissionValve.declareCaller 注册并在调用头使用 withDeclaration。
        permission: {
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
        },
        scopes: [
            { scope: 'danmaku.self',      desc: '仅向自己屏幕发送单条受限弹幕（可单独授予非 OP）' },
            { scope: 'danmaku.player',    desc: '向指定目标玩家发送弹幕（超过 4 名其他玩家需 danmaku.broadcast）' },
            { scope: 'danmaku.here',      desc: '向当前维度坐标周围发送弹幕（无 broadcast 上限 32m）' },
            { scope: 'danmaku.pos',       desc: '向指定维度坐标周围发送弹幕（跨维度或 >32m 需 danmaku.broadcast）' },
            { scope: 'danmaku.stop',      desc: '停止自己命名空间下的持续激活弹幕（>4 名其他玩家需 broadcast）' },
            { scope: 'danmaku.clear',     desc: '清空自己命名空间下的屏幕弹幕（>4 名其他玩家需 broadcast）' },
            { scope: 'danmaku.broadcast', desc: '允许非 OP 跨维度、超 32m(最高96m) 或 >4 人的广域弹幕调度（需单独授予）' },
            { scope: 'danmaku.help',      desc: '查看 /epiphy danmaku 帮助' }
        ],
        summary:    '通用屏幕弹幕与泛用文本显示调度指令 (/epiphy danmaku ...)',
        helpLines:  DANMAKU_HELP_LINES,
        buildNode:  buildDanmakuCommandNode
    }

    var valveRegError = null

    if (typeof PlayerEvents !== 'undefined' && PlayerEvents != null && typeof PlayerEvents.loggedIn === 'function') {
        PlayerEvents.loggedIn(function (event) {
            try {
                var p = event != null ? event.player : null
                if (p == null) return
                if (SERVER_REF == null) {
                    SERVER_REF = BASE.resolveServer(null, p)
                }
                var uuid = getPlayerUuidSafe(p)
                if (uuid && uuid !== 'unknown') {
                    var prefix = uuid + '|'
                    playerSourceCooldown.forEach(function (_exp, k) {
                        if (String(k).indexOf(prefix) === 0) {
                            playerSourceCooldown.delete(k)
                        }
                    })
                    pendingLoginFlushes.set(uuid, {
                        uuid:    uuid,
                        player:  p,
                        dueTick: danmakuTickCounter + 6
                    })
                }
            } catch (eIn) {
                reportCatch('PlayerEvents.loggedIn:scheduleFlush', eIn)
            }
        })
    }

    if (typeof PlayerEvents !== 'undefined' && PlayerEvents != null && typeof PlayerEvents.loggedOut === 'function') {
        PlayerEvents.loggedOut(function (event) {
            try {
                var p = event != null ? event.player : null
                if (p == null) return
                var uuid = getPlayerUuidSafe(p)
                if (uuid && uuid !== 'unknown') {
                    pendingLoginFlushes.delete(uuid)
                    var normUuid = String(uuid).trim().toLowerCase()
                    playerCmdCooldownMap.delete(normUuid)
                    var cmdSuffix = ':' + normUuid
                    playerCmdCooldownMap.forEach(function (_expCmd, kCmd) {
                        var sCmd = String(kCmd)
                        if (sCmd.length > cmdSuffix.length && sCmd.lastIndexOf(cmdSuffix) === (sCmd.length - cmdSuffix.length)) {
                            playerCmdCooldownMap.delete(kCmd)
                        }
                    })
                    var prefix = uuid + '|'
                    playerSourceCooldown.forEach(function (_exp, k) {
                        if (String(k).indexOf(prefix) === 0) {
                            playerSourceCooldown.delete(k)
                        }
                    })
                }
            } catch (eOut) {
                reportCatch('PlayerEvents.loggedOut:cleanup', eOut)
            }
        })
    }

    if (typeof ServerEvents !== 'undefined' && ServerEvents != null && typeof ServerEvents.unloaded === 'function') {
        ServerEvents.unloaded(function () {
            SERVER_REF = null
            pendingLoginFlushes.clear()
            playerSourceCooldown.clear()
            playerCmdCooldownMap.clear()
            invalidateScopeCache(null)
        })
    }

    try {
        BASE.registerSubcommandSafe(danmakuSubcommandSpec)
    } catch (eReg) {
        valveRegError = String(eReg)
        LOGGER.warn('commandReg', '注册 /epiphy danmaku 指令时出现异常，已终止指令注册: ' + eReg)
    }

    function getDanmakuTrackerCalls() {
        try {
            var t = (typeof global !== 'undefined' && global != null) ? global.EpiphyBlockTracker : null
            if (t != null && typeof t.getStats === 'function') {
                var st = t.getStats()
                if (st != null && st.subscriberCalls != null && st.subscriberCalls.danmaku != null) {
                    return st.subscriberCalls.danmaku
                }
            }
        } catch (eT) { }
        return 0
    }

    function getStats() {
        var tracker    = danmakuBlockTracker
        var isFb       = Boolean(tracker != null && tracker.isFallback)
        var mode       = (tracker != null && !tracker.isFallback) ? 'tracker' : 'fallback'
        var fbBindings = (isFb && typeof tracker.getBindingCount === 'function') ? tracker.getBindingCount() : 0
        var fbTracked  = (isFb && typeof tracker.getTrackedRecords === 'function') ? tracker.getTrackedRecords(null).length : 0
        var vMissing   = !BASE.isValveReady()
        return {
            trackerMode:           mode,
            fallbackBindings:      fbBindings,
            fallbackTracked:       fbTracked,
            lastEmitCycleMs:       lastEmitCycleMs,
            lastActiveEmitCycleMs: lastActiveEmitCycleMs,
            maxEmitCycleMs:        maxEmitCycleMs,
            emitCycleCount:        emitCycleCount,
            lastEmitCycleTick:     lastEmitCycleTick,
            lastEmitMs:            lastEmitMs,
            maxEmitMs:             maxEmitMs,
            emitCallCount:         emitCallCount,
            scopeCacheSize:        scopeListCache.size,
            boundScopeRevision:    boundScopeRevision,
            blockSeqByKeySize:     blockSeqByKey.size,
            cooldownSize:          playerSourceCooldown.size,
            trackedRecordsCalls:   getDanmakuTrackerCalls(),
            valveMissing:          vMissing,
            valveRegError:         valveRegError,
            debug:                 Boolean(CONFIG.debug),
            tickCounter:           danmakuTickCounter
        }
    }

    var danmakuDebugProvider = {
        name:    'danmaku',
        label:   '屏幕弹幕组件',
        order:   40,
        summary: function () {
            var s = getStats()
            return 'scopeCache=' + s.scopeCacheSize +
                ' (rev=' + s.boundScopeRevision + ')' +
                ' | emitCycle=' + s.lastEmitCycleMs.toFixed(3) + 'ms' +
                ' (active=' + s.lastActiveEmitCycleMs.toFixed(3) + 'ms, max=' + s.maxEmitCycleMs.toFixed(3) + 'ms)' +
                ' | cooldowns=' + s.cooldownSize +
                ' | getTrackedRecords=' + s.trackedRecordsCalls +
                ' | mode=' + s.trackerMode
        },
        detail: function () {
            var s = getStats()
            return [
                'trackerMode: ' + s.trackerMode + ' (fallbackBindings=' + s.fallbackBindings + ', fallbackTracked=' + s.fallbackTracked + ')',
                'emitCycleMs: last=' + s.lastEmitCycleMs.toFixed(3) + 'ms, lastActive=' + s.lastActiveEmitCycleMs.toFixed(3) + 'ms, max=' + s.maxEmitCycleMs.toFixed(3) + 'ms (cycles=' + s.emitCycleCount + ', lastCycleTick=' + s.lastEmitCycleTick + ')',
                'emitCallMs: last=' + s.lastEmitMs.toFixed(3) + 'ms, max=' + s.maxEmitMs.toFixed(3) + 'ms (calls=' + s.emitCallCount + ')',
                'scopeListCache.size: ' + s.scopeCacheSize + ' (boundScopeRevision=' + s.boundScopeRevision + ')',
                'blockSeqByKey.size: ' + s.blockSeqByKeySize,
                'playerSourceCooldown.size: ' + s.cooldownSize,
                'getTrackedRecords(danmaku): ' + s.trackedRecordsCalls,
                'valveMissing: ' + s.valveMissing + ', valveRegError: ' + String(s.valveRegError),
                'CONFIG.debug: ' + s.debug + ', tickCounter: ' + s.tickCounter
            ]
        },
        metrics: getStats,
        check: function () {
            var hasRealTracker = (danmakuBlockTracker != null && !danmakuBlockTracker.isFallback)
            var vMissing = !BASE.isValveReady()
            return [
                {
                    name:   'valve_registered',
                    ok:     !vMissing && valveRegError == null,
                    detail: 'valveMissing=' + vMissing + ', err=' + String(valveRegError)
                },
                {
                    name:   'block_tracker_attached',
                    ok:     hasRealTracker || danmakuBlockTracker == null,
                    detail: 'tracker=' + (danmakuBlockTracker == null ? 'lazy_uninit' : (hasRealTracker ? 'EpiphyBlockTracker' : 'fallback'))
                }
            ]
        },
        actions: {
            clearcache: {
                desc: '清空弹幕作用域范围缓存',
                fn: function () {
                    invalidateScopeCache(null)
                    return '已清空 scopeListCache（当前 rev=' + boundScopeRevision + '）'
                }
            },
            scan: {
                desc: '触发弹幕绑定方块附近区段扫描',
                fn: function () {
                    var n = scanBlocksNow()
                    var trackerApi = (typeof global !== 'undefined') ? global.EpiphyBlockTracker : null
                    var st = (trackerApi != null && typeof trackerApi.getLastScanStatus === 'function')
                        ? trackerApi.getLastScanStatus()
                        : null
                    if (st != null && st.blockedByQueue) {
                        return '当前扫描队列已满（' + st.queuePending + '/' + st.maxQueue + '，正在排队消化中），请稍后重试'
                    }
                    if (st != null && st.truncatedByQueue && n > 0) {
                        return '弹幕绑定方块已入队扫描 ' + n + ' 个区块段（队列已接近上限 ' + st.maxQueue + '，剩余区段将在消费后继续）'
                    }
                    return '弹幕绑定方块已入队扫描 ' + n + ' 个区块段'
                }
            },
            resetmetrics: {
                desc: '重置弹幕发射峰值与累计耗时计数',
                fn: function () {
                    lastEmitMs            = 0
                    maxEmitMs             = 0
                    emitCallCount         = 0
                    curEmitCycleTick      = -1
                    curEmitCycleAccumMs   = 0
                    curEmitCycleActive    = false
                    lastEmitCycleMs       = 0
                    lastActiveEmitCycleMs = 0
                    maxEmitCycleMs        = 0
                    emitCycleCount        = 0
                    lastEmitCycleTick     = 0
                    return '已清零弹幕发射耗时统计'
                }
            }
        }
    }
    BASE.registerDebugProvider(danmakuDebugProvider)
})()
