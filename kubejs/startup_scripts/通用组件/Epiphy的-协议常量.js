// priority: 1200
// ============================================================================
//  Epiphy 通用组件共享协议常量与版本契约 (EpiphyProtocol v1)
//  所属系列：Epiphy的-通用组件系列（本系列包含 startup / server / client 配套脚本）
//  [LLM 协作规范] 每次进行较大修改或重构前，请先将修改同步至 D:\Git-Epiphy 并执行 git commit 保存当前可用状态，便于随时回退与对比 diff。
//  许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
//  放置位置：kubejs/startup_scripts/通用组件/Epiphy的-协议常量.js
//
//  职责说明：
//    1. 在 startup_scripts 阶段（服务端与客户端均加载）定义本系列的唯一真相源（Single Source of Truth）；
//    2. 统一维护频道名、协议版本号、PRIORITY_MAP、HUD_FORBIDDEN_PRESETS 与报文字段契约；
//    3. 提供协议版本兼容性校验辅助函数，避免双端版本漂移时静默错解字段。
//
//  依赖与缺失影响：
//    - 本文件无前置脚本依赖（priority: 1200，最先加载）。
//    - 若缺失本文件：同系列依赖本契约的服务端/客户端组件会在启动时输出 console.warn 并各自回退到内联兜底常量；
//      一旦双端内联版本号不一致，客户端将按 fail-closed 原则直接拒收报文。
// ============================================================================

;(function () {
    var PRIORITY_MAP = {
        low: 1, minor: 1, '低': 1, '次要': 1,
        normal: 2, medium: 2, default: 2, '中': 2, '普通': 2,
        high: 3, major: 3, important: 3, '高': 3, '重要': 3,
        critical: 4, fatal: 4, urgent: 4, boss: 4, '极高': 4, '致命': 4,
        active: 5, sustain: 5, '持续': 5
    }

    var HUD_FORBIDDEN_PRESETS = {
        minimap:   Object.freeze({ x: 0.74, y: 0.00, w: 0.26, h: 0.28 }),
        hotbar:    Object.freeze({ x: 0.22, y: 0.80, w: 0.56, h: 0.20 }),
        crosshair: Object.freeze({ x: 0.40, y: 0.38, w: 0.20, h: 0.22 }),
        bossbar:   Object.freeze({ x: 0.25, y: 0.00, w: 0.50, h: 0.09 })
    }

    var DANMAKU_CHANNEL       = 'epiphy:screen_danmaku'
    var DANMAKU_PROTO_VERSION = 5

    var AUDIO_CHANNEL         = 'epiphy:audio'
    var AUDIO_PROTO_VERSION   = 5
    var AUDIO_SEMVER          = '5.2.0'

    function isProtoCompatible(expectedVer, incomingVer) {
        if (incomingVer === undefined || incomingVer === null) return false
        var n = Number(incomingVer)
        return isFinite(n) && n === Number(expectedVer)
    }

    function registerPriorityAlias(name, level) {
        if (name == null) return false
        var key = String(name).trim().toLowerCase()
        var lv  = Number(level)
        if (!key || !isFinite(lv)) return false
        PRIORITY_MAP[key] = Math.max(0, Math.min(10, Math.round(lv)))
        return true
    }

    function registerHudPreset(name, rect) {
        if (name == null || rect == null || typeof rect !== 'object') return false
        var key = String(name).trim().toLowerCase()
        var x = Number(rect.x), y = Number(rect.y), w = Number(rect.w), h = Number(rect.h)
        if (!key || !isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h)) return false
        HUD_FORBIDDEN_PRESETS[key] = Object.freeze({ x: x, y: y, w: w, h: h })
        return true
    }

    global.EpiphyProtocol = {
        DANMAKU_CHANNEL:       DANMAKU_CHANNEL,
        DANMAKU_PROTO_VERSION: DANMAKU_PROTO_VERSION,
        AUDIO_CHANNEL:         AUDIO_CHANNEL,
        AUDIO_PROTO_VERSION:   AUDIO_PROTO_VERSION,
        AUDIO_SEMVER:          AUDIO_SEMVER,
        PRIORITY_MAP:          PRIORITY_MAP,
        HUD_FORBIDDEN_PRESETS: HUD_FORBIDDEN_PRESETS,
        isProtoCompatible:     isProtoCompatible,
        registerPriorityAlias: registerPriorityAlias,
        registerHudPreset:     registerHudPreset
    }
})()
