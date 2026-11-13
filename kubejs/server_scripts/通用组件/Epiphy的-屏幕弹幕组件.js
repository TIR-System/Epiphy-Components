// priority: 500
// ============================================================================
//  通用屏幕弹幕与泛用文本显示组件 —— 服务端调度器 (ScreenDanmaku v5)
//  所属系列：Epiphy的-通用组件系列（本系列包含 startup / server / client 配套脚本）
//  [LLM 协作规范] 每次进行较大修改或重构前，请先将修改同步至 D:\Git-Epiphy 并执行 git commit 保存当前可用状态，便于随时回退与对比 diff。
//  许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
//  放置位置：kubejs/server_scripts/通用组件/Epiphy的-屏幕弹幕组件.js
//  配套客户端渲染器：kubejs/client_scripts/通用组件/Epiphy的-屏幕弹幕渲染器.js
//  配套权限阀组件：kubejs/server_scripts/通用组件/Epiphy的-权限阀.js（管理 /epiphy 根命令与执行权限，本组件向其声明 danmaku 子命令与帮助文本）
//
//  依赖与缺失降级行为：
//    - 必需配套：kubejs/client_scripts/通用组件/Epiphy的-屏幕弹幕渲染器.js（缺失时服务端可正常调用 API，但客户端无接收与画面渲染）
//    - 协议契约：kubejs/startup_scripts/通用组件/Epiphy的-协议常量.js (EpiphyProtocol, priority: 1200)
//      缺失时启动输出 console.warn 并回退至内联兜底协议版本 (5)；若双端内联版本不一致，客户端将 fail-closed 拒收报文
//    - 可选依赖：kubejs/server_scripts/通用组件/Epiphy的-日志.js (EpiphyLog, priority: 1100)
//      缺失时回退至内联 console.warn / console.error 兜底日志（失去统一限频与去重）
//    - 可选依赖：kubejs/server_scripts/通用组件/Epiphy的-方块追踪组件.js (EpiphyBlockTracker, priority: 1050)
//      缺失时 bindBlock 降级为基础事件兜底模式（仅支持新放置/破坏方块，无区块扫描与持久化），不影响常规弹幕 API
//    - 可选依赖：kubejs/server_scripts/通用组件/Epiphy的-权限阀.js (EpiphyPermissionValve, priority: 1000)
//      缺失时 /epiphy danmaku 指令不生效（OP 登录时提示），JS 调用接口正常；后续 /reload 补全权限阀后会自动从队列补注册并复位提示标志
//
//  [Rhino 语法兼容性约定] KubeJS 2001.6.x 内置 Rhino 对 ES6 支持不完整且存在语义偏差（如 `let`/`const`
//    的 TDZ 与循环块级绑定存在兼容陷阱）。本系列变量统一使用 `var`，弹幕模块维持 ES5 + `Map`/`Set`；
//    同系列音频模块使用经本服实测稳定的 ES6 子集（`=>` / 模板字符串 / `for..of`）。请勿引入 `let`/`const`。
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
    var PROTO         = (typeof global !== 'undefined' && global.EpiphyProtocol != null) ? global.EpiphyProtocol : null
    var CHANNEL       = (PROTO && PROTO.DANMAKU_CHANNEL) || 'epiphy:screen_danmaku'
    var PROTO_VERSION = (PROTO && PROTO.DANMAKU_PROTO_VERSION) || 5
    if (PROTO == null) {
        console.warn('[ScreenDanmaku] 未检测到 startup_scripts/通用组件/Epiphy的-协议常量.js (EpiphyProtocol)，将使用内联兜底协议版本 ' + PROTO_VERSION + '；若双端版本不一致将被客户端拒收。')
    }
    var SERVER_REF    = null
    var spreadCounter = 0

    var CONFIG = {
        debug:              false,
        errorLogIntervalMs: 5000,
        avoidMaxRetries:    14,
        sizeMin:            0.2,
        sizeMax:            4.0,
        smallRandRange:     [0.55, 0.97],
        randSizeRange:      [0.58, 1.70]
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
    //   outline            | @deprecated outlineMode             | 'none'|'stroke'|'glow'| 'none'    | ✓
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
        outlineMode:       'none',    // 外圈模式：'none'(默认关闭) | 'stroke'(描边外圈) | 'glow'(发光外圈)
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
        maxGroup:       0,         // 同组同屏最大并发弹幕数（0 表示不额外限制）
        showInGui:      false
    }

    var PRIORITY_MAP = (PROTO && PROTO.PRIORITY_MAP) || {
        low: 1, minor: 1, '低': 1, '次要': 1,
        normal: 2, medium: 2, default: 2, '中': 2, '普通': 2,
        high: 3, major: 3, important: 3, '高': 3, '重要': 3,
        critical: 4, fatal: 4, urgent: 4, boss: 4, '极高': 4, '致命': 4,
        active: 5, sustain: 5, '持续': 5
    }

    // 内置 HUD 常见禁区（归一化矩形 { x, y, w, h }，优先从 EpiphyProtocol 读取单一真相源）
    var HUD_FORBIDDEN_PRESETS = (PROTO && PROTO.HUD_FORBIDDEN_PRESETS) || {
        minimap:   { x: 0.74, y: 0.00, w: 0.26, h: 0.28 }, // 右上角小地图区
        hotbar:    { x: 0.22, y: 0.80, w: 0.56, h: 0.20 }, // 底部快捷栏、经验条与状态栏
        crosshair: { x: 0.40, y: 0.38, w: 0.20, h: 0.22 }, // 屏幕正中心准星视野区
        bossbar:   { x: 0.25, y: 0.00, w: 0.50, h: 0.09 }  // 顶部 Boss 血条区
    }

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

    var SIZE_PRESETS = {
        tiny:   0.58,
        small:  0.74,
        normal: 1.00,
        medium: 1.00,
        large:  1.35,
        huge:   1.70
    }

    var COLOR_PRESETS = {
        red:          0xFF4444,
        dark_red:     0xAA0000,
        gold:         0xFFAA00,
        yellow:       0xFFFF55,
        green:        0x55FF55,
        dark_green:   0x00AA00,
        aqua:         0x55FFFF,
        dark_aqua:    0x00AAAA,
        blue:         0x5555FF,
        light_purple: 0xFF55FF,
        purple:       0xAA00AA,
        dark_purple:  0xAA00AA,
        white:        0xFFFFFF,
        gray:         0xAAAAAA,
        dark_gray:    0x555555,
        black:        0x000000
    }

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
        if (obj == null || typeof obj !== 'object') return defVal
        for (var i = 0; i < keys.length; i++) {
            var v = obj[keys[i]]
            if (v !== undefined && v !== null) return v
        }
        return defVal
    }

    function pickNonEmpty(obj, keys, defVal) {
        if (obj == null || typeof obj !== 'object') return defVal
        for (var i = 0; i < keys.length; i++) {
            var v = obj[keys[i]]
            if (v !== undefined && v !== null && String(v).trim() !== '') return v
        }
        return defVal
    }

    // 【catch 约定】以下 try/catch 均为 Java Vec3 / BlockPos 坐标字段与方法能力探测：
    // 读取失败说明传入对象并非有效三维坐标容器，直接返回 null 属于预期分支，留空避免高频误报。
    function readVec3(vec) {
        if (vec == null) return null
        try {
            var vx = (typeof vec.x === 'function') ? vec.x() : vec.x
            var vy = (typeof vec.y === 'function') ? vec.y() : vec.y
            var vz = (typeof vec.z === 'function') ? vec.z() : vec.z
            var nx = Number(vx), ny = Number(vy), nz = Number(vz)
            if (isFinite(nx) && isFinite(ny) && isFinite(nz)) return { x: nx, y: ny, z: nz }
        } catch (e) { }
        return null
    }

    // 统一路由至 EpiphyLog（Epiphy的-日志.js）限频日志层：库函数遇到无效参数或已捕获异常时仅记 warn，不抛异常中断调用方 tick
    // 【catch 约定】以下日志设施自身的兜底：console / notifyPlayer.tell 不可用时已无更低层可退，留空避免递归报错。
    function reportConfigWarning(msg, notifyPlayer) {
        if (typeof global !== 'undefined' && global.EpiphyLog != null) {
            return global.EpiphyLog.warn('ScreenDanmaku', '参数警告', msg, notifyPlayer, CONFIG.errorLogIntervalMs)
        }
        try { console.warn('[ScreenDanmaku 参数警告] ' + msg) } catch (e) { }
        if (notifyPlayer != null) {
            try { notifyPlayer.tell(Text.of('§c[ScreenDanmaku 参数警告] ' + msg)) } catch (e2) { }
        }
        return null
    }

    function reportCatch(tag, err) {
        if (typeof global !== 'undefined' && global.EpiphyLog != null) {
            return global.EpiphyLog.catchWarn('ScreenDanmaku', tag, err, null, CONFIG.errorLogIntervalMs)
        }
        try { console.warn('[ScreenDanmaku 异常:' + String(tag || 'unknown') + '] ' + String(err)) } catch (eIgnore) { }
        return null
    }

    var danmakuTickCounter   = 0
    var blockSourceSeq       = 0
    var playerSourceCooldown = new Map() // '<playerUuid>|<scopeKey>' -> expireTick

    ServerEvents.tick(function (event) {
        if (SERVER_REF == null) SERVER_REF = event.server
        danmakuTickCounter++
        if ((danmakuTickCounter % 600) === 0 && playerSourceCooldown.size > 0) {
            playerSourceCooldown.forEach(function (exp, k) {
                if (exp <= danmakuTickCounter) playerSourceCooldown.delete(k)
            })
        }
    })

    function normalizeDanmakuConflictMode(raw, fallback) {
        var s = raw != null ? String(raw).trim().toLowerCase() : ''
        if (!s) return fallback || 'overlap'
        if (s === 'overlap' || s === 'allow' || s === 'none' || s === 'independent') return 'overlap'
        if (s === 'merge' || s === 'combine' || s === 'union' || s === 'throttle' || s === 'dedup') return 'merge'
        if (s === 'nearest' || s === 'closest') return 'nearest'
        if (s === 'first' || s === 'oldest') return 'first'
        if (s === 'latest' || s === 'newest' || s === 'replace') return 'latest'
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
        if (p == null) return 'unknown'
        try { return String(p.getUuid()) } catch (e) { }
        try { return String(p.username || 'player') } catch (e2) { }
        return 'unknown'
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

    function parsePriority(val, defVal) {
        if (val === undefined || val === null || val === '') return defVal
        if (typeof val === 'number' && isFinite(val)) return Math.max(0, Math.min(10, Math.round(val)))
        var s = String(val).trim().toLowerCase()
        if (PRIORITY_MAP[s] != null) return PRIORITY_MAP[s]
        var n = Number(s)
        if (isFinite(n)) return Math.max(0, Math.min(10, Math.round(n)))
        return defVal
    }

    function parseFiniteNum(val, defVal) {
        if (val === undefined || val === null || val === '') return defVal
        var n = Number(val)
        return isFinite(n) ? n : defVal
    }

    function parseNonNegNum(val, defVal, minVal) {
        var floor = (minVal != null && isFinite(minVal)) ? minVal : 0
        if (val === undefined || val === null || val === '') return defVal
        var n = Number(val)
        if (!isFinite(n) || n < 0) return defVal
        return Math.max(floor, n)
    }

    function sanitizeMaxWidth(val) {
        var n = Number(val)
        if (val === undefined || val === null || val === '' || !isFinite(n) || n <= 0) return 0
        if (n <= 1.0) return Math.max(0.05, Math.min(1.0, n))
        return Math.max(16, Math.min(4096, Math.round(n)))
    }

    function parseTicksOrSec(raw) {
        if (raw === undefined || raw === null || String(raw).trim() === '') return null
        var s = String(raw).trim().toLowerCase()
        if (s.slice(-1) === 's') {
            var sec = Number(s.slice(0, -1))
            if (isFinite(sec) && sec > 0) return Math.round(sec * 20)
            return null
        }
        var n = Number(s)
        if (isFinite(n) && n > 0) return Math.round(n)
        return null
    }

    function parseBool(val, defVal) {
        if (val === undefined || val === null || val === '') return defVal
        if (typeof val === 'boolean') return val
        if (typeof val === 'number') return !isNaN(val) && val !== 0
        var s = String(val).trim().toLowerCase()
        if (s === 'true' || s === '1' || s === '1b' || s === 'yes' || s === 'on' || s === 'y' || s === '是' || s === '开启' || s === '开') return true
        if (s === 'false' || s === '0' || s === '0b' || s === 'no' || s === 'off' || s === 'n' || s === 'none' || s === '否' || s === '关闭' || s === '关') return false
        return defVal
    }

    function quantizeZoneTag(rx, ry) {
        var col = rx < 0.35 ? 'L' : (rx > 0.65 ? 'R' : 'C')
        var row = ry < 0.28 ? 'T' : (ry > 0.62 ? 'B' : 'M')
        return 'zone_' + row + col
    }

    function parseColor(val, defColor) {
        if (val === undefined || val === null || val === '') return { color: defColor, isRandom: false }
        if (typeof val === 'number' && isFinite(val)) return { color: val & 0xFFFFFF, isRandom: false }
        var s = String(val).trim().toLowerCase()
        if (s === 'random' || s === 'rand') {
            var keys = ['red', 'gold', 'yellow', 'aqua', 'light_purple', 'white', 'green']
            return { color: COLOR_PRESETS[keys[Math.floor(Math.random() * keys.length)]], isRandom: true }
        }
        if (COLOR_PRESETS[s] != null) return { color: COLOR_PRESETS[s], isRandom: false }
        if (s.indexOf('#') === 0) s = s.substring(1)
        else if (s.indexOf('0x') === 0) s = s.substring(2)
        var parsed = parseInt(s, 16)
        if (isFinite(parsed)) return { color: parsed & 0xFFFFFF, isRandom: false }
        return { color: defColor, isRandom: false }
    }

    function isArrayLike(v, minLen) {
        var req = minLen || 2
        return v != null && typeof v === 'object' && typeof v !== 'string' && typeof v.length === 'number' && v.length >= req
    }

    function parseSize(sizeVal, scaleVal) {
        var raw = (sizeVal !== undefined && sizeVal !== null && sizeVal !== '') ? sizeVal : scaleVal
        if (raw === undefined || raw === null || raw === '') return { scale: DEFAULTS.size, isRandom: false }
        if (Array.isArray(raw) || isArrayLike(raw, 2)) {
            var sMin = parseNonNegNum(raw[0], 0.65, CONFIG.sizeMin)
            var sMax = parseNonNegNum(raw[1], 1.25, CONFIG.sizeMin)
            var lo   = Math.min(sMin, sMax)
            var hi   = Math.max(sMin, sMax)
            var val  = Math.max(CONFIG.sizeMin, Math.min(CONFIG.sizeMax, lo + Math.random() * (hi - lo)))
            return { scale: Number(val.toFixed(2)), isRandom: lo !== hi }
        }
        if (typeof raw === 'number' && isFinite(raw) && raw > 0) {
            return { scale: Math.max(CONFIG.sizeMin, Math.min(CONFIG.sizeMax, raw)), isRandom: false }
        }
        var s = String(raw).trim().toLowerCase()
        if (s === 'small_random' || s === 'small_rand') {
            var sr = CONFIG.smallRandRange
            return { scale: Number((sr[0] + Math.random() * (sr[1] - sr[0])).toFixed(2)), isRandom: true }
        }
        if (s === 'random' || s === 'rand') {
            var rr = CONFIG.randSizeRange
            return { scale: Number((rr[0] + Math.random() * (rr[1] - rr[0])).toFixed(2)), isRandom: true }
        }
        if (SIZE_PRESETS[s] != null) return { scale: SIZE_PRESETS[s], isRandom: false }
        var num = Number(s)
        if (isFinite(num) && num > 0) {
            return { scale: Math.max(CONFIG.sizeMin, Math.min(CONFIG.sizeMax, num)), isRandom: false }
        }
        return { scale: DEFAULTS.size, isRandom: false }
    }

    function parseTilt(tiltVal, angleVal, fallbackAngle) {
        var raw = (tiltVal !== undefined && tiltVal !== null && tiltVal !== '') ? tiltVal : angleVal
        if (raw === undefined || raw === null || raw === '') {
            return fallbackAngle != null ? fallbackAngle : DEFAULTS.tilt
        }
        if (Array.isArray(raw) || isArrayLike(raw, 2)) {
            var aMin = parseFiniteNum(raw[0], -22)
            var aMax = parseFiniteNum(raw[1], 22)
            return Number((aMin + Math.random() * (aMax - aMin)).toFixed(1))
        }
        if (typeof raw === 'number' && isFinite(raw)) return raw
        var s = String(raw).trim().toLowerCase()
        if (s === 'random' || s === 'rand') {
            if (Math.random() < 0.22) {
                return Number(((Math.random() - 0.5) * 7.0).toFixed(1))
            }
            var sign = Math.random() < 0.5 ? -1 : 1
            return Number((sign * (5.0 + Math.random() * 23.0)).toFixed(1))
        }
        if (s === 'left') return Number((-10.0 - Math.random() * 15.0).toFixed(1))
        if (s === 'right') return Number((10.0 + Math.random() * 15.0).toFixed(1))
        if (s === 'none' || s === 'flat' || s === 'straight') return 0.0
        // 区间写法：'-40~40' / '-40,40'（指令 tilt=-40~40 使用）
        var rangeMatch = /^(-?\d+(?:\.\d+)?)\s*[~,]\s*(-?\d+(?:\.\d+)?)$/.exec(s)
        if (rangeMatch != null) {
            var rMin = Number(rangeMatch[1]), rMax = Number(rangeMatch[2])
            return Number((rMin + Math.random() * (rMax - rMin)).toFixed(1))
        }
        var num = Number(s)
        if (isFinite(num)) return num
        return fallbackAngle != null ? fallbackAngle : DEFAULTS.tilt
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

    function pruneRecentPos(groupKey, nowMs) {
        var arr = RECENT_POS_BY_GROUP[groupKey]
        if (!arr || arr.length === 0) return []
        var kept = []
        for (var i = 0; i < arr.length; i++) {
            if (arr[i].expireAt > nowMs) kept.push(arr[i])
        }
        RECENT_POS_BY_GROUP[groupKey] = kept
        return kept
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
            var arr = pruneRecentPos(sepGroup, Date.now())
            var durTicks = parseNonNegNum(opts.duration, DEFAULTS.duration, 10)
            arr.push({ rx: p.rx, ry: p.ry, expireAt: Date.now() + durTicks * 50 + 3000 })
            if (arr.length > 8) arr.shift()
            RECENT_POS_BY_GROUP[sepGroup] = arr
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
            return { jitter: true, perCharShake: false, shakeMode: 'decay', shakeAmp: amp, shakeFreqMin: freqRange.minMs, shakeFreqMax: freqRange.maxMs, isRandom: false }
        }
        if (s === 'fade_in' || s === 'fadein' || s === 'before_fade') {
            return { jitter: true, perCharShake: false, shakeMode: 'fade_in', shakeAmp: amp, shakeFreqMin: freqRange.minMs, shakeFreqMax: freqRange.maxMs, isRandom: false }
        }
        if (s === 'pulse' || s === 'wave') {
            return { jitter: true, perCharShake: false, shakeMode: 'pulse', shakeAmp: amp, shakeFreqMin: freqRange.minMs, shakeFreqMax: freqRange.maxMs, isRandom: false }
        }
        if (s === 'random' || s === 'rand') {
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
        return VALID_FADE_STYLES[s] || DEFAULTS.fade
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
                mode = 'none'
            } else if (outBool === true || outStr === 'stroke' || outStr === 'border' || outStr === 'outline' || outStr === '描边' || outStr === '外圈') {
                mode = 'stroke'
            } else if (outStr === 'glow' || outStr === 'halo' || outStr === '发光') {
                mode = 'glow'
            } else {
                // 允许直接写 outline: '#000000' 或 outline: 'black'
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
        var lmRaw = opts.lifeMode != null ? opts.lifeMode : opts.existMode
        if (lmRaw != null && String(lmRaw).trim() !== '') {
            var lm = String(lmRaw).trim().toLowerCase()
            if (lm === 'active' || lm === 'continuous' || lm === 'sustain' || lm === 'hold' || lm === '持续' || parseBool(lmRaw, false)) {
                isContinuous = true
            }
        }

        var durRaw = opts.duration != null ? opts.duration : (opts.existTime != null ? opts.existTime : opts.stay)
        if (durRaw != null && String(durRaw).trim() !== '') {
            var ds = String(durRaw).trim().toLowerCase()
            if (ds === 'active' || ds === 'continuous' || ds === 'sustain' || ds === 'hold' || ds === '持续') {
                isContinuous = true
                durRaw = null
            }
        }

        var parsedDur    = parseTicksOrSec(durRaw)
        var hasCustomDur = (parsedDur !== null)
        var ticks        = hasCustomDur ? parsedDur : DEFAULTS.duration

        if (isContinuous) {
            var customHoldRaw = opts.activeHold != null ? opts.activeHold : opts.holdTicks
            var parsedHold    = parseTicksOrSec(customHoldRaw)
            var hold          = (parsedHold !== null)
                ? parsedHold
                : (hasCustomDur ? ticks : DEFAULTS.activeHold)
            var effHold = Math.max(4, hold)
            return { lifeMode: 'active', stay: effHold, activeHold: effHold }
        }
        return { lifeMode: 'once', stay: Math.max(4, ticks), activeHold: DEFAULTS.activeHold }
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

    function buildValidatedPacket(optsOrText, notifyPlayer) {
        var opts = normalizeOptionsObject(optsOrText)
        if (opts == null || typeof opts !== 'object') {
            return reportConfigWarning('调用时必须传入弹幕配置对象或文本字符串！', notifyPlayer)
        }
        if (opts.action === 'clear') {
            var cPacket = {
                proto:     PROTO_VERSION,
                action:    'clear',
                group:     String(pickNonEmpty(opts, ['group'], '*')),
                namespace: String(pick(opts, ['namespace', 'ns'], ''))
            }
            var cPri = pick(opts, ['maxPriority', 'priority'], null)
            if (cPri != null) cPacket.maxPriority = parsePriority(cPri, 10)
            return cPacket
        }
        if (opts.action === 'deactivate' || opts.action === 'stop') {
            var dKeyRaw = pickNonEmpty(opts, ['key', 'id', 'slot'], '')
            var dPacket = {
                proto:     PROTO_VERSION,
                action:    'deactivate',
                key:       String(dKeyRaw),
                group:     String(pick(opts, ['group'], '')),
                namespace: String(pick(opts, ['namespace', 'ns'], ''))
            }
            var dFadeOut = parseTicksOrSec(opts.fadeOut)
            if (dFadeOut !== null) dPacket.fadeOut = dFadeOut
            var dPri = pick(opts, ['maxPriority', 'priority'], null)
            if (dPri != null) dPacket.maxPriority = parsePriority(dPri, 10)
            if (parseBool(opts.includeOnce, false)) dPacket.includeOnce = true
            return dPacket
        }

        var rawTitle = pickNonEmpty(opts, ['text', 'title'], null)
        var rawSub   = pick(opts, ['sub', 'subtitle'], DEFAULTS.sub)

        if (rawTitle == null) {
            return reportConfigWarning('缺少必填参数 `text`（或 `title`）：弹幕主文本不能为空！', notifyPlayer)
        }

        var titleStr = applyTargetStyleTags(
            String(rawTitle).replace(/&([0-9a-fk-or])/gi, '§$1').replace(/\\n/g, '\n').replace(/\\\|/g, '|'),
            opts
        )
        var subStr   = applyTargetStyleTags(
            String(rawSub || '').replace(/&([0-9a-fk-or])/gi, '§$1').replace(/\\n/g, '\n').replace(/\\\|/g, '|'),
            opts
        )

        var posInfo      = resolvePosition(opts)
        var sizeInfo     = parseSize(opts.size, opts.scale)
        var angleVal     = parseTilt(opts.tilt, opts.angle, posInfo.presetAngle)
        var colorInfo    = parseColor(opts.color, DEFAULTS.color)
        var subColInfo   = parseColor(opts.subColor, DEFAULTS.subColor)
        var outlineInfo  = resolveOutline(opts, colorInfo.color)
        var spacingVal   = Math.max(-2.0, Math.min(24.0, parseFiniteNum(pick(opts, ['letterSpacing', 'charSpacing', 'spacing'], null), DEFAULTS.letterSpacing)))
        var isChar       = resolveTypewriterMode(opts)
        var charMsVal    = Math.round(parseNonNegNum(opts.charMs, DEFAULTS.charMs, 8))
        var shakeInfo    = resolveShake(opts)
        var fadeStyle    = resolveFadeStyle(opts)
        var lifeInfo     = resolveLifetime(opts)
        var defPri       = (lifeInfo.lifeMode === 'active') ? DEFAULTS.activePriority : DEFAULTS.priority
        var priority     = parsePriority(pick(opts, ['priority', 'importance'], null), defPri)
        var groupStr     = String(pickNonEmpty(opts, ['group'], DEFAULTS.group))
        var nsStr        = String(pickNonEmpty(opts, ['namespace', 'ns'], ''))
        var slotIdStr    = String(pickNonEmpty(opts, ['id', 'slot'], ''))
        var keyStr       = String(pickNonEmpty(opts, ['key'], ''))
        var resetAnim    = parseBool(pick(opts, ['restart', 'resetAnimation'], null), false)
        var allowMove    = parseBool(pick(opts, ['movable', 'move', 'updatePos'], null), DEFAULTS.movable)
        var normalizeKey = parseBool(opts.normalizeKey, DEFAULTS.normalizeKey)
        var maxWidth     = sanitizeMaxWidth(pick(opts, ['maxWidth'], DEFAULTS.maxWidth))
        var wrapVal      = parseBool(opts.wrap, DEFAULTS.wrap)
        var clampVal     = parseBool(opts.clamp, DEFAULTS.clamp)
        var shadowVal    = parseBool(opts.shadow, DEFAULTS.shadow)
        var showGuiVal   = parseBool(opts.showInGui, DEFAULTS.showInGui)
        var maxGroupVal  = Math.round(parseNonNegNum(pick(opts, ['maxGroup', 'maxGroupSize', 'groupLimit', 'maxConcurrent'], null), DEFAULTS.maxGroup, 0))
        var fadeOutVal   = parseTicksOrSec(opts.fadeOut)
        if (fadeOutVal === null) fadeOutVal = DEFAULTS.fadeOut
        var baseShift    = parseNonNegNum(opts.charShakeShift, DEFAULTS.charShakeShift, 0.0)

        return {
            proto:               PROTO_VERSION,
            action:              'push',
            key:                 keyStr,
            slotId:              slotIdStr,
            namespace:           nsStr,
            group:               groupStr,
            posTag:              posInfo.posTag,
            normalizeKey:        normalizeKey,
            lifeMode:            lifeInfo.lifeMode,
            priority:            priority,
            title:               titleStr,
            sub:                 subStr,
            rx:                  posInfo.rx,
            ry:                  posInfo.ry,
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
            cursor:              String(pickNonEmpty(opts, ['cursor'], DEFAULTS.cursor)),
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
    }

    // 【catch 约定】以下 try/catch 均为 Java API 能力探测：先 typeof 判函数再调，
    // 失败表示该 API 在本次加载的 MC/Rhino 版本中不存在，属于预期分支，故留空。
    // 这些路径每次调用都会经过，写日志会污染限频桶并拖慢热路径。
    // 读取玩家实体坐标（优先读取 KubeJS BlockContainerJS 的明文坐标）
    function readPlayerPos(p) {
        if (p == null) return null
        try {
            var b = p.block
            if (b != null) {
                var bx = Number(b.x), by = Number(b.y), bz = Number(b.z)
                if (isFinite(bx) && isFinite(by) && isFinite(bz)) {
                    return { x: bx, y: by, z: bz }
                }
            }
        } catch (e0) { }
        try {
            if (typeof p.getX === 'function' && typeof p.getY === 'function' && typeof p.getZ === 'function') {
                var gx = Number(p.getX()), gy = Number(p.getY()), gz = Number(p.getZ())
                if (isFinite(gx) && isFinite(gy) && isFinite(gz)) {
                    return { x: gx, y: gy, z: gz }
                }
            }
        } catch (e1) { }
        return null
    }

    function forEachPlayerInRadius(level, x, y, z, radius, fn) {
        if (level == null) return 0
        var cx = Number(x), cy = Number(y), cz = Number(z), r = Number(radius)
        if (!isFinite(cx) || !isFinite(cy) || !isFinite(cz) || !isFinite(r) || r < 0) return 0
        var d2 = r * r
        var list = level.players
        if (list == null) return 0
        var hitCount = 0
        for (var i = 0, len = list.size(); i < len; i++) {
            var p = list.get(i)
            var pPos = readPlayerPos(p)
            if (pPos == null) continue
            var dx = pPos.x - cx, dy = pPos.y - cy, dz = pPos.z - cz
            var distSq = dx * dx + dy * dy + dz * dz
            if (isFinite(distSq) && distSq <= d2) {
                hitCount++
                fn(p, distSq)
            }
        }
        return hitCount
    }

    // 【catch 约定】以下两个函数内的 try/catch 为维度/玩家查找能力探测：失败属于未找到目标的正常分支，留空；
    // 真正的数据包发送 (target.sendData) 异常通过 reportCatch 上报，避免静默丢包。
    function resolveLevel(levelOrDim, serverFallback) {
        if (levelOrDim == null) return null
        if (typeof levelOrDim === 'object' && levelOrDim.players != null) {
            return levelOrDim
        }
        var dimId = String(levelOrDim).trim()
        if (dimId.indexOf(':') < 0) dimId = 'minecraft:' + dimId
        var srv = serverFallback || SERVER_REF
        if (srv != null) {
            try {
                return srv.getLevel(dimId)
            } catch (e) { }
        }
        return null
    }

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
        var effOpts = prepareSourceConflictOpts(opts)
        var pkt = buildValidatedPacket(effOpts, null)
        if (pkt == null) return 0
        return forEachPlayerInRadius(lv, cx, cy, cz, r, function (p) {
            if (!allowSourceConflictForPlayer(p, effOpts)) return
            try { p.sendData(CHANNEL, pkt) } catch (e) { reportCatch('radiusSend', e) }
        })
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

    function deactivatePlayer(player, keyOrGroup, fadeOutOrOpts, maybeMaxPriority) {
        if (player == null) return 0
        return toPlayer(player, buildDeactivateOptions(keyOrGroup, fadeOutOrOpts, maybeMaxPriority))
    }

    function deactivateNear(levelOrDim, x, y, z, radius, keyOrGroup, fadeOutOrOpts, maybeMaxPriority) {
        var lv = resolveLevel(levelOrDim, null)
        if (lv == null) return 0
        var r = (radius !== undefined && radius !== null && radius !== '') ? parseNonNegNum(radius, -1, 0) : DEFAULTS.radius
        if (r < 0) return 0
        var pkt = buildValidatedPacket(buildDeactivateOptions(keyOrGroup, fadeOutOrOpts, maybeMaxPriority), null)
        if (pkt == null) return 0
        return forEachPlayerInRadius(lv, x, y, z, r, function (p) {
            try { p.sendData(CHANNEL, pkt) } catch (e) { reportCatch('deactivateNearSend', e) }
        })
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
        var lv = resolveLevel(levelOrDim, null)
        if (lv == null) return 0
        var r = (radius !== undefined && radius !== null && radius !== '') ? parseNonNegNum(radius, -1, 0) : DEFAULTS.radius
        if (r < 0) return 0
        var pkt = buildValidatedPacket(buildClearOptions(groupOrOpts, maxPriority), null)
        if (pkt == null) return 0
        return forEachPlayerInRadius(lv, x, y, z, r, function (p) {
            try { p.sendData(CHANNEL, pkt) } catch (e) { reportCatch('clearNearSend', e) }
        })
    }


    // ======================================================================== 方块弹幕发射源自动绑定（委托 EpiphyBlockTracker）

    var SCOPE_CACHE_TTL_TICKS = 20
    var boundScopeRevision    = 0
    var scopeListCache        = new Map() // '<dim>|<scopeKey>' -> { rev, builtTick, list: [{ rec, binding, seq, cx, cy, cz, r, rSq }], idxByKey: Map, mergeClustersByKey: Map }
    var blockSeqByKey         = new Map() // '<posKey>' -> seq

    function invalidateScopeCache(removedKey) {
        boundScopeRevision++
        if (scopeListCache.size > 0) scopeListCache.clear()
        if (removedKey != null) blockSeqByKey.delete(removedKey)
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

        var n = mergeNodes.length
        var visited = new Array(n)
        for (var vi = 0; vi < n; vi++) visited[vi] = false

        for (var s = 0; s < n; s++) {
            if (visited[s]) continue
            visited[s] = true
            var queue   = [s]
            var members = []
            for (var qi = 0; qi < queue.length; qi++) {
                var idx = queue[qi]
                var a = mergeNodes[idx]
                members.push(a)
                for (var nb = 0; nb < n; nb++) {
                    if (visited[nb]) continue
                    var b = mergeNodes[nb]
                    var touch = a.r + b.r
                    var dx = a.cx - b.cx, dy = a.cy - b.cy, dz = a.cz - b.cz
                    if ((dx * dx + dy * dy + dz * dz) <= (touch * touch + 1e-6)) {
                        visited[nb] = true
                        queue.push(nb)
                    }
                }
            }
            if (members.length > 1) {
                members.sort(function (ma, mb) { return ma.seq - mb.seq })
            }
            var minX = Infinity, maxX = -Infinity
            var minY = Infinity, maxY = -Infinity
            var minZ = Infinity, maxZ = -Infinity
            for (var mi = 0; mi < members.length; mi++) {
                var m = members[mi]
                if (m.cx - m.r < minX) minX = m.cx - m.r
                if (m.cx + m.r > maxX) maxX = m.cx + m.r
                if (m.cy - m.r < minY) minY = m.cy - m.r
                if (m.cy + m.r > maxY) maxY = m.cy + m.r
                if (m.cz - m.r < minZ) minZ = m.cz - m.r
                if (m.cz + m.r > maxZ) maxZ = m.cz + m.r
            }
            var clusterObj = {
                leaderKey: members[0].rec.key,
                leaderSeq: members[0].seq,
                members:   members,
                minX:      minX,
                maxX:      maxX,
                minY:      minY,
                maxY:      maxY,
                minZ:      minZ,
                maxZ:      maxZ
            }
            for (var ki = 0; ki < members.length; ki++) {
                byKey.set(members[ki].rec.key, clusterObj)
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
        var list = level.players
        if (list == null) return 0
        var isJavaList = (typeof list.size === 'function' && typeof list.get === 'function')
        var len = isJavaList ? list.size() : (typeof list.length === 'number' ? list.length : 0)
        var count = 0
        for (var i = 0; i < len; i++) {
            var p = isJavaList ? list.get(i) : list[i]
            if (p != null) {
                count++
                fn(p)
            }
        }
        return count
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
        } else {
            fallbackTracked.forEach(function (item) { raw.push(item) })
        }

        var list = []
        for (var i = 0; i < raw.length; i++) {
            var item = raw[i]
            if (item == null || item.dim !== rec.dim) continue
            var itemBinding = danmakuBlockTracker != null
                ? danmakuBlockTracker.getBinding(item.blockId)
                : fallbackBindings.get(item.blockId)
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

        // list 已按 _danmakuSeq 升序排序：first/latest 只需扫描竞争一侧并可提前命中退出
        if (mode === 'first') {
            var limitFirst = (myIdx !== undefined) ? myIdx : list.length
            for (var fi = 0; fi < limitFirst; fi++) {
                var fe  = list[fi]
                var fdx = px - fe.cx, fdy = py - fe.cy, fdz = pz - fe.cz
                if ((fdx * fdx + fdy * fdy + fdz * fdz) <= fe.rSq) {
                    return myIdx !== undefined ? false : (fe.rec.key === rec.key)
                }
            }
            return true
        }
        if (mode === 'latest') {
            var stopLatest = (myIdx !== undefined) ? (myIdx + 1) : 0
            for (var li = list.length - 1; li >= stopLatest; li--) {
                var le  = list[li]
                var ldx = px - le.cx, ldy = py - le.cy, ldz = pz - le.cz
                if ((ldx * ldx + ldy * ldy + ldz * ldz) <= le.rSq) {
                    return myIdx !== undefined ? false : (le.rec.key === rec.key)
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
        ensureRecordSeq(rec)
        var scopeEntry = getScopeCacheEntry(rec, binding)
        var total      = scopeEntry.list.length
        if (total <= 1) return (tickNum % binding.intervalTicks) === 0
        var idx = scopeEntry.idxByKey.get(rec.key)
        if (idx === undefined) idx = 0
        var phase = Math.floor((idx * binding.intervalTicks) / total)
        return ((tickNum + phase) % binding.intervalTicks) === 0
    }

    function emitForBoundBlock(rec, binding, lv, curBlock) {
        if (binding == null) return 0
        var isMergeMode = ((binding.conflictMode || 'overlap') === 'merge')
        var cluster = null
        if (isMergeMode) {
            cluster = getMergeClusterForRecord(rec, binding)
            if (cluster != null && cluster.leaderKey !== rec.key) return 0
        }
        if (lv == null) lv = resolveLevel(rec.dim, null)
        if (lv == null) return 0
        if (curBlock == null) {
            try { curBlock = lv.getBlock(rec.x, rec.y, rec.z) } catch (e0) { reportCatch('boundBlockGet', e0) }
        }
        var extractId = (typeof global !== 'undefined' && global.EpiphyBlockTracker) ? global.EpiphyBlockTracker.extractBlockId : null
        if (extractId != null && extractId(curBlock) !== rec.blockId) return 0

        var cx = rec.x + 0.5, cy = rec.y + 0.5, cz = rec.z + 0.5
        var r  = binding.radius
        var visitTargets = function (cb) {
            return cluster != null
                ? forEachPlayerInMergeCluster(lv, cluster, cb)
                : forEachPlayerInRadius(lv, cx, cy, cz, r, cb)
        }

        // 模式 1（共享模式 perPlayer === false，默认）：仅当至少有一名玩家通过作用域准入后才延迟生成并打包一次，避免 merge/竞争落选方块空耗构包
        if (!binding.perPlayer) {
            var sharedBuilt = false
            var sharedPkt   = null
            var sharedSent  = 0
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
                        sharedPkt = buildValidatedPacket(sharedSpec, null)
                    }
                }
                if (sharedPkt == null) return
                try {
                    p.sendData(CHANNEL, sharedPkt)
                    sharedSent++
                } catch (eSend) {
                    reportCatch('emitForBoundBlock:shared_send', eSend)
                }
            })
            return sharedSent
        }

        // 模式 2（独立模式 perPlayer === true）：对生效范围内每名玩家各自调用一次 specOrFn（传入 player: p）
        return visitTargets(function (p) {
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
                    toPlayer(p, rawSpec)
                }
            } catch (eEmit) {
                reportCatch('emitForBoundBlock:per_player', eEmit)
            }
        })
    }

    function handleBoundBlockRemoved(rec, binding) {
        invalidateScopeCache(rec != null ? rec.key : null)
        if (rec == null || binding == null || !binding.group) return
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
                    var pkt = buildValidatedPacket(buildClearOptions(binding.group, null), null)
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
                return
            }
        }
        clearNear(rec.dim, rec.x + 0.5, rec.y + 0.5, rec.z + 0.5, binding.radius + 6, binding.group)
    }

    var danmakuBlockTracker  = null
    var missingTrackerWarned = false

    // 基础兜底表：当方块追踪组件缺失时，仅维护本会话内通过 placed/broken 事件感知的方块，避免功能完全瘫痪
    var fallbackBindings      = new Map()
    var fallbackTracked       = new Map()
    var fallbackEventsHooked  = false

    function hookFallbackBlockEvents() {
        if (fallbackEventsHooked) return
        fallbackEventsHooked = true
        try {
            BlockEvents.placed(function (event) {
                try {
                    if (danmakuBlockTracker != null || fallbackBindings.size === 0 || event.block == null) return
                    var bid = event.block.id != null ? String(event.block.id) : null
                    if (bid == null || !fallbackBindings.has(bid)) return
                    var dim = String(event.level.dimension || 'minecraft:overworld')
                    var key = dim + '|' + Math.floor(event.block.x) + ',' + Math.floor(event.block.y) + ',' + Math.floor(event.block.z)
                    var rec = { key: key, blockId: bid, dim: dim, x: Math.floor(event.block.x), y: Math.floor(event.block.y), z: Math.floor(event.block.z) }
                    fallbackTracked.set(key, rec)
                    ensureRecordSeq(rec)
                    invalidateScopeCache(null)
                    var fbBinding = fallbackBindings.get(bid)
                    if (fbBinding != null && (!((fbBinding.conflictMode || 'overlap') === 'merge') || isMergeClusterLeader(rec, fbBinding))) {
                        emitForBoundBlock(rec, fbBinding, event.level, event.block)
                    }
                } catch (eP) {
                    reportCatch('fallback:placed', eP)
                }
            })
            BlockEvents.broken(function (event) {
                try {
                    if (danmakuBlockTracker != null || event.block == null) return
                    var dim = String(event.level.dimension || 'minecraft:overworld')
                    var key = dim + '|' + Math.floor(event.block.x) + ',' + Math.floor(event.block.y) + ',' + Math.floor(event.block.z)
                    var rec = fallbackTracked.get(key)
                    if (rec != null) {
                        var b = fallbackBindings.get(rec.blockId)
                        fallbackTracked.delete(key)
                        handleBoundBlockRemoved(rec, b)
                    }
                } catch (eB) {
                    reportCatch('fallback:broken', eB)
                }
            })
        } catch (eHook) {
            reportCatch('fallback:hookEvents', eHook)
        }
    }

    function createFallbackTracker() {
        hookFallbackBlockEvents()
        return {
            isFallback: true,
            bind: function (idStr, meta) { fallbackBindings.set(idStr, meta); return true },
            unbind: function (idStr) {
                var b = fallbackBindings.get(idStr)
                fallbackBindings.delete(idStr)
                var removed = 0
                fallbackTracked.forEach(function (rec, k) {
                    if (rec.blockId === idStr) {
                        if (b != null && b.group) clearNear(rec.dim, rec.x + 0.5, rec.y + 0.5, rec.z + 0.5, b.radius + 6, b.group)
                        fallbackTracked.delete(k)
                        blockSeqByKey.delete(k)
                        removed++
                    }
                })
                invalidateScopeCache(null)
                return removed
            },
            scanNow: function () { return 0 }
        }
    }

    function ensureDanmakuBlockTracker() {
        if (danmakuBlockTracker != null) return danmakuBlockTracker
        var trackerApi = (typeof global !== 'undefined') ? global.EpiphyBlockTracker : null
        if (trackerApi == null || typeof trackerApi.createTracker !== 'function') {
            if (!missingTrackerWarned) {
                missingTrackerWarned = true
                var msg = '[ScreenDanmaku] 依赖组件 EpiphyBlockTracker (Epiphy的-方块追踪组件.js) 未加载，已降级为基础事件兜底模式（仅支持新放置/破坏方块，无区块扫描与持久化）。'
                if (typeof global !== 'undefined' && global.EpiphyLog != null) {
                    global.EpiphyLog.once('warn', 'danmaku:missing_block_tracker', msg)
                } else {
                    // 【catch 约定】日志设施自身的兜底：console 不可用时已无更低层可退，留空。
                    try { console.warn(msg) } catch (e) { }
                }
            }
            return createFallbackTracker()
        }
        danmakuBlockTracker = trackerApi.createTracker({
            name:             'danmaku',
            maintainInterval: 1,
            onBindingChanged: function () {
                invalidateScopeCache(null)
            },
            onFound: function (rec, binding, source) {
                ensureRecordSeq(rec)
                invalidateScopeCache(null)
                // 仅在玩家新放置时立即触发首帧反馈；若归属于已存在合并集群的从属方块则静默合并，不额外运行
                if (source === 'placed') {
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
            onRemoved: function (rec, binding) {
                handleBoundBlockRemoved(rec, binding)
            }
        })
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
        tracker.bind(idStr, {
            blockId:               idStr,
            specOrFn:              specOrFn,
            radius:                radius,
            scanRadius:            Math.min(128, Math.max(16, radius + 6)),
            intervalTicks:         Math.floor(interval),
            group:                 grp,
            perPlayer:             perPlayer,
            conflictMode:          conflictMode,
            conflictScope:         conflictScope,
            conflictCooldownTicks: Math.floor(conflictCooldown)
        })
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
                checkDanmakuValveRegistration()
            }
            if (danmakuBlockTracker == null && fallbackTracked.size > 0 && SERVER_REF != null) {
                fallbackTracked.forEach(function (rec) {
                    var b = fallbackBindings.get(rec.blockId)
                    if (b != null && (danmakuTickCounter % b.intervalTicks) === 0) {
                        emitForBoundBlock(rec, b, null, null)
                    }
                })
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
        CHANNEL:           CHANNEL,
        configure:         configure,
        bindBlock:         bindBlock,
        watchBlock:        bindBlock,
        unbindBlock:       unbindBlock,
        unwatchBlock:      unbindBlock,
        scanBlocksNow:     scanBlocksNow,
        CONFIG:            CONFIG,
        DEFAULTS:          DEFAULTS,
        HUD_FORBIDDEN:     HUD_FORBIDDEN_PRESETS,
        buildPacket:       buildValidatedPacket,
        safeSend:          safeSend,
        send:              send,
        toPlayer:          toPlayer,
        inDimension:       inDimension,
        atEvent:           atEvent,
        deactivatePlayer:  deactivatePlayer,
        deactivateNear:    deactivateNear,
        sendToPlayer:      toPlayer,
        sendNear:          inDimension,
        sendMinorEdgeNear: sendMinorEdgeNear,
        clearPlayer:       clearPlayer,
        clearNear:         clearNear,
        _pure: Object.freeze({
            parseSize:       parseSize,
            parseTilt:       parseTilt,
            parseColor:      parseColor,
            parseTicksOrSec: parseTicksOrSec,
            parseSpecString: parseSpecString
        })
    }

    // ========================================================================
    //  第二部分：向权限阀组件 (EpiphyPermissionValve) 声明 `danmaku` 子命令与帮助手册
    // ========================================================================

    var DANMAKU_HELP_LINES = [
        '§3§l----------------------------------------------------',
        '§b§l  [ Epiphy 屏幕弹幕组件 // /epiphy danmaku 帮助手册 ]',
        '§3§l----------------------------------------------------',
        '§e1. 查看弹幕帮助： §f/epiphy danmaku help §7(或 §f/epiphy help danmaku§7)',
        '§e2. 指定玩家显示： §f/epiphy danmaku player <玩家> <弹幕内容与可选参数...>',
        '§e3. 自身周围显示： §f/epiphy danmaku here <半径> <弹幕内容与可选参数...>',
        '§e4. 维度坐标显示： §f/epiphy danmaku pos <维度> <x> <y> <z> <半径> <弹幕内容与可选参数...>',
        '§e5. 停止持续弹幕： §f/epiphy danmaku stop [玩家] [key或分组名] [fadeOut] [maxPriority]',
        '§e6. 清空屏幕弹幕： §f/epiphy danmaku clear [玩家] [分组名(默认*)] [maxPriority]',
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

    function sendDanmakuHelp(source) {
        for (var i = 0; i < DANMAKU_HELP_LINES.length; i++) {
            try {
                source.sendSuccess(Text.of(DANMAKU_HELP_LINES[i]), false)
            } catch (e) {
                reportCatch('helpSend', e)
            }
        }
        return 1
    }

    function parseSpecString(specStr) {
        var opts = {}
        if (!specStr || String(specStr).trim().length === 0) {
            return opts
        }

        var KNOWN_KEYS = {
            text: true, title: true, sub: true, subtitle: true,
            pos: true, rx: true, ry: true, avoid: true, avoidhud: true,
            size: true, scale: true,
            tilt: true, angle: true,
            color: true, subcolor: true,
            spacing: true, letterspacing: true, charspacing: true,
            outline: true, outlinemode: true, outlinecolor: true, outlinewidth: true,
            glow: true, glowcolor: true, glowwidth: true,
            boldtarget: true, scaletarget: true, targetscale: true, shaketarget: true,
            mode: true, typewriter: true, bychar: true, charms: true, cursor: true, shadow: true,
            shake: true, shakemode: true, shakeamp: true, shakefreq: true, shakeinterval: true, percharshake: true, charshake: true, jitter: true,
            fade: true, fadestyle: true, fademode: true, fadeout: true,
            stay: true, duration: true, existtime: true, activehold: true, holdticks: true,
            life: true, lifemode: true, existmode: true, continuous: true, sustained: true,
            priority: true, importance: true, maxpriority: true, includeonce: true,
            maxwidth: true, wrap: true, clamp: true, showingui: true,
            maxgroup: true, maxgroupsize: true, grouplimit: true, maxconcurrent: true,
            movable: true, move: true, updatepos: true,
            normalizekey: true,
            restart: true, resetanimation: true,
            key: true, id: true, slot: true, namespace: true, ns: true, group: true,
            debug: true
        }

        var regex = /([a-zA-Z]+)=(?:"([^"]*)"|'([^']*)'|(\S+))|(\S+)/g
        var match
        var freeWords = []

        while ((match = regex.exec(specStr)) !== null) {
            if (match[1] != null) {
                var rawKey = match[1]
                var kLower = rawKey.toLowerCase()
                var val = match[2] != null ? match[2] : (match[3] != null ? match[3] : match[4])
                if (KNOWN_KEYS[kLower]) {
                    if (kLower === 'subcolor') opts.subColor = val
                    else if (kLower === 'spacing' || kLower === 'letterspacing' || kLower === 'charspacing') opts.letterSpacing = parseFiniteNum(val, 0)
                    else if (kLower === 'outlinemode') opts.outlineMode = val
                    else if (kLower === 'outlinecolor' || kLower === 'glowcolor') opts.outlineColor = val
                    else if (kLower === 'outlinewidth' || kLower === 'glowwidth') opts.outlineWidth = parseNonNegNum(val, DEFAULTS.outlineWidth, 0.25)
                    else if (kLower === 'boldtarget') opts.boldTarget = val
                    else if (kLower === 'scaletarget') opts.scaleTarget = val
                    else if (kLower === 'targetscale') opts.targetScale = parseFiniteNum(val, 1.35)
                    else if (kLower === 'shaketarget') opts.shakeTarget = val
                    else if (kLower === 'charms') opts.charMs = parseNonNegNum(val, DEFAULTS.charMs, 8)
                    else if (kLower === 'bychar' || kLower === 'typewriter') opts.typewriter = parseBool(val, false)
                    else if (kLower === 'existtime') opts.duration = val
                    else if (kLower === 'activehold' || kLower === 'holdticks') opts.activeHold = val
                    else if (kLower === 'life' || kLower === 'lifemode' || kLower === 'existmode') opts.lifeMode = val
                    else if (kLower === 'continuous' || kLower === 'sustained') opts.continuous = parseBool(val, false)
                    else if (kLower === 'shakemode') opts.shakeMode = val
                    else if (kLower === 'shakeamp') opts.shakeAmp = parseNonNegNum(val, DEFAULTS.shakeAmp, 0.0)
                    else if (kLower === 'shakefreq' || kLower === 'shakeinterval') opts.shakeFreq = val
                    else if (kLower === 'percharshake' || kLower === 'charshake') opts.perCharShake = parseBool(val, true)
                    else if (kLower === 'fadestyle' || kLower === 'fademode') opts.fadeStyle = val
                    else if (kLower === 'fadeout') opts.fadeOut = val
                    else if (kLower === 'importance') opts.priority = val
                    else if (kLower === 'maxpriority') opts.maxPriority = val
                    else if (kLower === 'includeonce') opts.includeOnce = parseBool(val, false)
                    else if (kLower === 'maxwidth') opts.maxWidth = sanitizeMaxWidth(val)
                    else if (kLower === 'maxgroup' || kLower === 'maxgroupsize' || kLower === 'grouplimit' || kLower === 'maxconcurrent') opts.maxGroup = parseNonNegNum(val, 0, 0)
                    else if (kLower === 'shadow') opts.shadow = parseBool(val, DEFAULTS.shadow)
                    else if (kLower === 'wrap') opts.wrap = parseBool(val, DEFAULTS.wrap)
                    else if (kLower === 'clamp') opts.clamp = parseBool(val, DEFAULTS.clamp)
                    else if (kLower === 'debug') opts.debug = parseBool(val, true)
                    else if (kLower === 'showingui') opts.showInGui = parseBool(val, DEFAULTS.showInGui)
                    else if (kLower === 'avoidhud') opts.avoidHud = parseBool(val, DEFAULTS.avoidHud)
                    else if (kLower === 'movable' || kLower === 'move' || kLower === 'updatepos') opts.movable = parseBool(val, DEFAULTS.movable)
                    else if (kLower === 'normalizekey') opts.normalizeKey = parseBool(val, DEFAULTS.normalizeKey)
                    else if (kLower === 'restart' || kLower === 'resetanimation') opts.restart = parseBool(val, false)
                    else if (kLower === 'slot') opts.id = val
                    else if (kLower === 'ns') opts.namespace = val
                    else opts[kLower] = val
                } else {
                    freeWords.push(match[0])
                }
            } else if (match[5] != null) {
                freeWords.push(match[5])
            }
        }

        var joinedFree = freeWords.join(' ').trim()
        if (joinedFree.length > 0 && opts.text == null && opts.title == null) {
            var placeholder = '\uE000'
            var escapedFree = joinedFree.replace(/\\\|/g, placeholder)
            var pipeIdx     = escapedFree.indexOf('|')
            if (pipeIdx >= 0) {
                opts.text = escapedFree.substring(0, pipeIdx).replace(/\uE000/g, '|').trim()
                if (opts.sub == null) {
                    opts.sub = escapedFree.substring(pipeIdx + 1).replace(/\uE000/g, '|').trim()
                }
            } else {
                opts.text = escapedFree.replace(/\uE000/g, '|')
            }
        }

        return opts
    }

    function sendSourceError(source, msg) {
        try {
            source.sendSuccess(Text.of('§c[Epiphy Danmaku 错误] ' + msg + ' §7(输入 §f/epiphy danmaku help §7查看语法)'), false)
        } catch (e) {
            reportCatch('sourceErrorSend', e)
        }
    }

    // 构建 danmaku 子命令节点，所有 executes 分支统一由权限阀 guardExecution 包裹
    function buildDanmakuCommandNode(regCtx) {
        var event          = regCtx.event
        var Commands       = regCtx.Commands
        var Arguments      = regCtx.Arguments
        var guardExecution = regCtx.guardExecution

        return Commands.literal('danmaku')
            .executes(guardExecution(function (ctx) {
                return sendDanmakuHelp(ctx.source)
            }))
            .then(
                Commands.literal('help')
                    .executes(guardExecution(function (ctx) {
                        return sendDanmakuHelp(ctx.source)
                    }))
            )
            .then(
                Commands.literal('stop')
                    .executes(guardExecution(function (ctx) {
                        var p = ctx.source.player
                        if (p == null) {
                            sendSourceError(ctx.source, '控制台或命令方块执行 stop 请指定目标玩家！')
                            return 0
                        }
                        deactivatePlayer(p, '*')
                        ctx.source.sendSuccess(Text.of('§a[Epiphy Danmaku] 已停止你屏幕上的持续激活弹幕。'), false)
                        return 1
                    }))
                    .then(
                        Commands.argument('targets', Arguments.PLAYERS.create(event))
                            .executes(guardExecution(function (ctx) {
                                var players = Arguments.PLAYERS.getResult(ctx, 'targets')
                                var cnt = toPlayer(players, { action: 'deactivate', key: '*', group: '*' })
                                ctx.source.sendSuccess(Text.of('§a[Epiphy Danmaku] 已停止 ' + cnt + ' 名玩家的持续激活弹幕。'), false)
                                return cnt
                            }))
                            .then(
                                Commands.argument('key', Arguments.WORD.create(event))
                                    .executes(guardExecution(function (ctx) {
                                        var players = Arguments.PLAYERS.getResult(ctx, 'targets')
                                        var k = Arguments.WORD.getResult(ctx, 'key')
                                        var cnt = toPlayer(players, { action: 'deactivate', key: k, group: k })
                                        ctx.source.sendSuccess(Text.of('§a[Epiphy Danmaku] 已停止 ' + cnt + ' 名玩家的 [' + k + '] 持续弹幕。'), false)
                                        return cnt
                                    }))
                                    .then(
                                        Commands.argument('fadeOut', Arguments.INTEGER.create(event))
                                            .executes(guardExecution(function (ctx) {
                                                var players = Arguments.PLAYERS.getResult(ctx, 'targets')
                                                var k = Arguments.WORD.getResult(ctx, 'key')
                                                var fo = Arguments.INTEGER.getResult(ctx, 'fadeOut')
                                                var cnt = toPlayer(players, { action: 'deactivate', key: k, group: k, fadeOut: fo })
                                                ctx.source.sendSuccess(Text.of('§a[Epiphy Danmaku] 已停止 ' + cnt + ' 名玩家的 [' + k + '] 持续弹幕 (fadeOut=' + fo + ')。'), false)
                                                return cnt
                                            }))
                                            .then(
                                                Commands.argument('maxPriority', Arguments.WORD.create(event))
                                                    .executes(guardExecution(function (ctx) {
                                                        var players = Arguments.PLAYERS.getResult(ctx, 'targets')
                                                        var k = Arguments.WORD.getResult(ctx, 'key')
                                                        var fo = Arguments.INTEGER.getResult(ctx, 'fadeOut')
                                                        var mp = Arguments.WORD.getResult(ctx, 'maxPriority')
                                                        var cnt = toPlayer(players, { action: 'deactivate', key: k, group: k, fadeOut: fo, maxPriority: mp })
                                                        ctx.source.sendSuccess(Text.of('§a[Epiphy Danmaku] 已停止 ' + cnt + ' 名玩家的 [' + k + '] 持续弹幕 (fadeOut=' + fo + ', maxPriority=' + mp + ')。'), false)
                                                        return cnt
                                                    }))
                                            )
                                    )
                            )
                    )
            )
            .then(
                Commands.literal('clear')
                    .executes(guardExecution(function (ctx) {
                        var p = ctx.source.player
                        if (p == null) {
                            sendSourceError(ctx.source, '控制台或命令方块执行 clear 请指定目标玩家！')
                            return 0
                        }
                        clearPlayer(p, '*')
                        ctx.source.sendSuccess(Text.of('§a[Epiphy Danmaku] 已清空你屏幕上的所有弹幕。'), false)
                        return 1
                    }))
                    .then(
                        Commands.argument('targets', Arguments.PLAYERS.create(event))
                            .executes(guardExecution(function (ctx) {
                                var players = Arguments.PLAYERS.getResult(ctx, 'targets')
                                var cnt = toPlayer(players, { action: 'clear', group: '*' })
                                ctx.source.sendSuccess(Text.of('§a[Epiphy Danmaku] 已清空 ' + cnt + ' 名玩家的全部屏幕弹幕。'), false)
                                return cnt
                            }))
                            .then(
                                Commands.argument('group', Arguments.WORD.create(event))
                                    .executes(guardExecution(function (ctx) {
                                        var players = Arguments.PLAYERS.getResult(ctx, 'targets')
                                        var grp = Arguments.WORD.getResult(ctx, 'group')
                                        var cnt = toPlayer(players, { action: 'clear', group: grp })
                                        ctx.source.sendSuccess(Text.of('§a[Epiphy Danmaku] 已清空 ' + cnt + ' 名玩家的 [' + grp + '] 分组弹幕。'), false)
                                        return cnt
                                    }))
                                    .then(
                                        Commands.argument('maxPriority', Arguments.WORD.create(event))
                                            .executes(guardExecution(function (ctx) {
                                                var players = Arguments.PLAYERS.getResult(ctx, 'targets')
                                                var grp = Arguments.WORD.getResult(ctx, 'group')
                                                var mp = Arguments.WORD.getResult(ctx, 'maxPriority')
                                                var cnt = toPlayer(players, { action: 'clear', group: grp, maxPriority: mp })
                                                ctx.source.sendSuccess(Text.of('§a[Epiphy Danmaku] 已清空 ' + cnt + ' 名玩家的 [' + grp + '] 分组弹幕 (maxPriority=' + mp + ')。'), false)
                                                return cnt
                                            }))
                                    )
                            )
                    )
            )
            .then(
                Commands.literal('player')
                    .then(
                        Commands.argument('targets', Arguments.PLAYERS.create(event))
                            .then(
                                Commands.argument('spec', Arguments.GREEDY_STRING.create(event))
                                    .executes(guardExecution(function (ctx) {
                                        var players = Arguments.PLAYERS.getResult(ctx, 'targets')
                                        var specStr = Arguments.GREEDY_STRING.getResult(ctx, 'spec')
                                        var opts    = parseSpecString(specStr)
                                        if (!opts.text && !opts.title) {
                                            sendSourceError(ctx.source, '缺少必填的弹幕主文本！')
                                            return 0
                                        }
                                        var cnt = toPlayer(players, opts)
                                        ctx.source.sendSuccess(
                                            Text.of('§a[Epiphy Danmaku] 已向 ' + cnt + ' 名玩家发送弹幕: §f' + (opts.text || opts.title)),
                                            false
                                        )
                                        return cnt
                                    }))
                            )
                    )
            )
            .then(
                Commands.literal('here')
                    .then(
                        Commands.argument('radius', Arguments.DOUBLE.create(event))
                            .then(
                                Commands.argument('spec', Arguments.GREEDY_STRING.create(event))
                                    .executes(guardExecution(function (ctx) {
                                        var radius  = Arguments.DOUBLE.getResult(ctx, 'radius')
                                        var specStr = Arguments.GREEDY_STRING.getResult(ctx, 'spec')
                                        var opts    = parseSpecString(specStr)
                                        if (!opts.text && !opts.title) {
                                            sendSourceError(ctx.source, '缺少必填的弹幕主文本！')
                                            return 0
                                        }
                                        var pos   = readVec3(ctx.source.position)
                                        var level = ctx.source.level
                                        if (pos == null) {
                                            sendSourceError(ctx.source, '无法读取当前指令执行位置！')
                                            return 0
                                        }
                                        var cnt   = inDimension(level, pos.x, pos.y, pos.z, radius, opts)
                                        ctx.source.sendSuccess(
                                            Text.of('§a[Epiphy Danmaku] 已在当前维度半径 ' + radius + 'm 内触发弹幕（命中 ' + cnt + ' 名玩家）。'),
                                            false
                                        )
                                        return 1
                                    }))
                            )
                    )
            )
            .then(
                Commands.literal('pos')
                    .then(
                        Commands.argument('dim', Arguments.DIMENSION.create(event))
                            .then(
                                Commands.argument('center', Arguments.VEC3.create(event))
                                    .then(
                                        Commands.argument('radius', Arguments.DOUBLE.create(event))
                                            .then(
                                                Commands.argument('spec', Arguments.GREEDY_STRING.create(event))
                                                    .executes(guardExecution(function (ctx) {
                                                        var targetLevel = Arguments.DIMENSION.getResult(ctx, 'dim')
                                                        var center      = readVec3(Arguments.VEC3.getResult(ctx, 'center'))
                                                        var radius      = Arguments.DOUBLE.getResult(ctx, 'radius')
                                                        var specStr     = Arguments.GREEDY_STRING.getResult(ctx, 'spec')
                                                        if (center == null) {
                                                            sendSourceError(ctx.source, '无法解析目标坐标！')
                                                            return 0
                                                        }
                                                        var opts        = parseSpecString(specStr)
                                                        if (!opts.text && !opts.title) {
                                                            sendSourceError(ctx.source, '缺少必填的弹幕主文本！')
                                                            return 0
                                                        }
                                                        var cnt = inDimension(targetLevel, center.x, center.y, center.z, radius, opts)
                                                        ctx.source.sendSuccess(
                                                            Text.of('§a[Epiphy Danmaku] 已在目标维度 (' + center.x.toFixed(1) + ', ' + center.y.toFixed(1) + ', ' + center.z.toFixed(1) + ') 半径 ' + radius + 'm 内触发弹幕（命中 ' + cnt + ' 名玩家）。'),
                                                            false
                                                        )
                                                        return 1
                                                    }))
                                            )
                                    )
                            )
                    )
            )
    }

    var danmakuSubcommandSpec = {
        name:       'danmaku',
        // 由屏幕弹幕组件自行声明权限策略：
        //   - 命令方块 (BaseCommandBlock) 与控制台 (MinecraftServer) 放行；
        //   - 玩家聊天框执行需 [可作弊 + 是管理员或已被授权]；
        //   - 其他脚本函数若以命令形式调用，须先调用 EpiphyPermissionValve.declareCaller(id, ['danmaku']) 注册并在调用头使用 withDeclaration。
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
        summary:    '通用屏幕弹幕与泛用文本显示调度指令 (/epiphy danmaku ...)',
        helpLines:  DANMAKU_HELP_LINES,
        buildNode:  buildDanmakuCommandNode
    }

    var valveMissing      = false
    var valveRegError     = null
    var notifiedValveOps  = new Set()

    function checkDanmakuValveRegistration(quiet) {
        var queue = (typeof global !== 'undefined' && global != null) ? global.EpiphyCommandRegistryQueue : null
        var valve = (typeof global !== 'undefined' && global != null)
            ? (global.EpiphyPermissionValve || global.PermissionValve)
            : null
        var stillQueued = Array.isArray(queue) && queue.indexOf(danmakuSubcommandSpec) >= 0
        var missing = (valve == null || stillQueued)
        valveMissing = missing
        if (missing && !quiet) {
            console.info('[ScreenDanmaku] 未检测到权限阀组件 (EpiphyPermissionValve)，/epiphy danmaku 指令功能未生效（JS 调用接口正常）。')
        }
        return missing
    }

    try {
        PlayerEvents.loggedIn(function (event) {
            try {
                if (valveMissing) checkDanmakuValveRegistration(true)
                if (!valveMissing && valveRegError == null) return
                var p = event != null ? event.player : null
                if (p == null) return
                var isOp = false
                try { isOp = Boolean(p.hasPermissions(2)) } catch (ePerm) { reportCatch('loggedIn:hasPermissions', ePerm) }
                if (!isOp) return
                var uuid = null
                try { uuid = String(p.getUuid()) } catch (eUuid) { uuid = String(p.username || 'op') }
                if (notifiedValveOps.has(uuid)) return
                notifiedValveOps.add(uuid)
                if (valveRegError != null) {
                    p.tell(Text.of('§c[ScreenDanmaku] §7注册 §f/epiphy danmaku §7指令时发生异常，指令功能未生效: §c' + valveRegError))
                } else {
                    p.tell(Text.of('§e[ScreenDanmaku] §7未检测到权限阀组件 (EpiphyPermissionValve)，§f/epiphy danmaku §7指令功能未生效（JS 调用接口正常）。'))
                }
            } catch (eIn) {
                reportCatch('PlayerEvents.loggedIn:valveNotify', eIn)
            }
        })
    } catch (eRegLogin) {
        reportCatch('registerLoggedIn:valveNotify', eRegLogin)
    }

    try {
        PlayerEvents.loggedOut(function (event) {
            try {
                var p = event != null ? event.player : null
                if (p == null) return
                var uuid = getPlayerUuidSafe(p)
                if (uuid && uuid !== 'unknown') {
                    notifiedValveOps.delete(uuid)
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
    } catch (eRegLogout) {
        reportCatch('registerLoggedOut:cleanup', eRegLogout)
    }

    try {
        var valve = (typeof global !== 'undefined' && global != null)
            ? (global.EpiphyPermissionValve || global.PermissionValve)
            : null
        if (valve != null && typeof valve.registerSubcommand === 'function') {
            valve.registerSubcommand(danmakuSubcommandSpec)
        } else if (typeof global !== 'undefined' && global != null) {
            if (!Array.isArray(global.EpiphyCommandRegistryQueue)) {
                global.EpiphyCommandRegistryQueue = []
            }
            var q = global.EpiphyCommandRegistryQueue
            for (var qi = q.length - 1; qi >= 0; qi--) {
                if (q[qi] != null && q[qi].name === 'danmaku') q.splice(qi, 1)
            }
            q.push(danmakuSubcommandSpec)
        }
    } catch (eReg) {
        valveRegError = String(eReg)
        console.warn('[ScreenDanmaku] 注册 /epiphy danmaku 指令时出现异常，已终止指令注册: ' + eReg)
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

    var danmakuDebugProvider = {
        name:    'danmaku',
        label:   '屏幕弹幕组件',
        order:   40,
        summary: function () {
            var mode = (danmakuBlockTracker != null && !danmakuBlockTracker.isFallback) ? 'tracker' : 'fallback'
            return 'scopeCache=' + scopeListCache.size +
                ' (rev=' + boundScopeRevision + ')' +
                ' | cooldowns=' + playerSourceCooldown.size +
                ' | getTrackedRecords=' + getDanmakuTrackerCalls() +
                ' | mode=' + mode
        },
        detail: function () {
            var mode = (danmakuBlockTracker != null && !danmakuBlockTracker.isFallback) ? 'tracker' : 'fallback'
            return [
                'trackerMode: ' + mode + ' (fallbackBindings=' + fallbackBindings.size + ', fallbackTracked=' + fallbackTracked.size + ')',
                'scopeListCache.size: ' + scopeListCache.size + ' (boundScopeRevision=' + boundScopeRevision + ')',
                'blockSeqByKey.size: ' + blockSeqByKey.size,
                'playerSourceCooldown.size: ' + playerSourceCooldown.size,
                'getTrackedRecords(danmaku): ' + getDanmakuTrackerCalls(),
                'valveMissing: ' + valveMissing + ', valveRegError: ' + String(valveRegError),
                'CONFIG.debug: ' + Boolean(CONFIG.debug) + ', tickCounter: ' + danmakuTickCounter
            ]
        },
        check: function () {
            var hasRealTracker = (danmakuBlockTracker != null && !danmakuBlockTracker.isFallback)
            return [
                {
                    name:   'valve_registered',
                    ok:     !valveMissing && valveRegError == null,
                    detail: 'valveMissing=' + valveMissing + ', err=' + String(valveRegError)
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
            }
        }
    }
    if (typeof global !== 'undefined' && global != null) {
        if (global.EpiphyDebug != null && typeof global.EpiphyDebug.registerProvider === 'function') {
            global.EpiphyDebug.registerProvider(danmakuDebugProvider)
        } else {
            if (!Array.isArray(global.EpiphyDebugProviderQueue)) global.EpiphyDebugProviderQueue = []
            global.EpiphyDebugProviderQueue.push(danmakuDebugProvider)
        }
    }
})()
