// ============================================================================
//  Epiphy 的通用组件 —— 空间特效渲染器客户端门面 (Epiphy3DFX / EpiphySpatialFX v2.0.0 · Client)
//  许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
//  放置位置：kubejs/client_scripts/通用组件/Epiphy的-空间特效渲染器.js
//  架构定位：
//    - 视觉表现层【子系统 B】(详见 docs/rendering-subsystem-roadmap.md §1、§2 功能六 & §8.1 P3-2)
//    - 与【子系统 A】2D 平面渲染器 (Epiphy的-平面渲染器.js / Epiphy2DRenderer) 严格正交解耦；
//    - 实际 GPU 核心着色器 (`epiphy:epiphy_cosmos`) 注册与预烘焙 `CCModel` `IItemRenderer` 渲染管线
//      已统一收拢至 `startup_scripts/通用组件/Epiphy的-空间特效核心.js` (global.Epiphy3DFXCore)，
//      本客户端脚本仅提供运行时开关、绑定转发、状态诊断与兼容门面，不注册任何每帧 JS 顶点循环事件
//      （彻底消除手持与物品栏中的 Rhino JNI 卡顿）。
//  语法规范：遵循 README-LLM.md §1 强制 Rhino ES5 语法基准。
// ============================================================================

;(function () {
    var VERSION = '2.0.0'

    var LOCAL_BINDINGS = {}
    // 兜底默认值与 Epiphy3DFXCore.CONFIG 严格保持一致（由 Test 71 锁死防双源漂移）
    var FALLBACK_CONFIG = {
        enabled:          true,
        cosmosEnabled:    true,
        surroundEnabled:  true,
        guiSurroundScale: 0.86,
        guiRingLimit:     2,
        guiRenderHelix:   false,
        guiRenderMotes:   false
    }

    function getCore() {
        return (typeof global !== 'undefined' && global != null && global.Epiphy3DFXCore) ? global.Epiphy3DFXCore : null
    }

    function getConfigObj() {
        var core = getCore()
        return (core != null && core.CONFIG) ? core.CONFIG : FALLBACK_CONFIG
    }

    function bindItem(itemId, spec) {
        if (typeof itemId !== 'string' || !itemId) return false
        LOCAL_BINDINGS[itemId] = spec || {}
        var core = getCore()
        if (core != null && typeof core.bindItem === 'function') {
            return core.bindItem(itemId, spec)
        }
        return true
    }

    function unbindItem(itemId) {
        if (typeof itemId !== 'string' || !itemId) return false
        delete LOCAL_BINDINGS[itemId]
        var core = getCore()
        if (core != null && typeof core.unbindItem === 'function') {
            return core.unbindItem(itemId)
        }
        return true
    }

    function absorbGlobalBindings() {
        var core = getCore()
        if (core != null && typeof core.absorbGlobalBindings === 'function') {
            core.absorbGlobalBindings()
            return
        }
        var map = (typeof global !== 'undefined' && global != null) ? global.Epiphy3DFXItemBindings : null
        if (map != null && typeof map === 'object' && !Array.isArray(map)) {
            for (var id in map) {
                if (Object.prototype.hasOwnProperty.call(map, id)) {
                    LOCAL_BINDINGS[id] = map[id]
                }
            }
        }
    }

    function getBoundItemConfig(itemId) {
        var core = getCore()
        if (core != null && typeof core.getBoundItemConfig === 'function') {
            return core.getBoundItemConfig(itemId)
        }
        if (!Object.prototype.hasOwnProperty.call(LOCAL_BINDINGS, itemId)) {
            absorbGlobalBindings()
        }
        return Object.prototype.hasOwnProperty.call(LOCAL_BINDINGS, itemId) ? LOCAL_BINDINGS[itemId] : null
    }

    function setEnabled(flag) {
        getConfigObj().enabled = Boolean(flag)
    }

    function setCosmosEnabled(flag) {
        getConfigObj().cosmosEnabled = Boolean(flag)
    }

    function setSurroundEnabled(flag) {
        getConfigObj().surroundEnabled = Boolean(flag)
    }

    function getShaderStatus() {
        var core = getCore()
        if (core != null && typeof core.getShaderStatus === 'function') {
            return core.getShaderStatus()
        }
        return { registered: false, loaded: false, hasUniforms: false, lastError: 'core_unavailable' }
    }

    function getStats() {
        var core = getCore()
        if (core != null && typeof core.getStats === 'function') {
            var st = core.getStats()
            st.clientFacadeVersion = VERSION
            st.coreAvailable       = true
            return st
        }
        return {
            version:             VERSION,
            clientFacadeVersion: VERSION,
            coreAvailable:       false,
            enabled:             getConfigObj().enabled,
            boundCount:          Object.keys(LOCAL_BINDINGS).length,
            bakedCount:          0,
            bakedItems:          {},
            shaderLoaded:        false
        }
    }

    absorbGlobalBindings()

    var coreRef = getCore()
    var API = {
        VERSION:              VERSION,
        CONFIG:               getConfigObj(),
        bindItem:             bindItem,
        unbindItem:           unbindItem,
        absorbGlobalBindings: absorbGlobalBindings,
        getBoundItemConfig:   getBoundItemConfig,
        setEnabled:           setEnabled,
        setCosmosEnabled:     setCosmosEnabled,
        setSurroundEnabled:   setSurroundEnabled,
        getShaderStatus:      getShaderStatus,
        getStats:             getStats,
        _pure:                (coreRef != null && coreRef._pure) ? coreRef._pure : {}
    }

    if (typeof global !== 'undefined') {
        global.Epiphy3DFX      = API
        global.EpiphySpatialFX = API
    }
})()
