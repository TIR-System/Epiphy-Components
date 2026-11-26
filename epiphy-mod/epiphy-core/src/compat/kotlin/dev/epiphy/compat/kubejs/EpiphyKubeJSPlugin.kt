// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.compat.kubejs

import com.mojang.logging.LogUtils
import dev.epiphy.api.SemVer
import dev.epiphy.api.cache.BoundedCache
import dev.epiphy.api.cache.EvictionPolicy
import dev.epiphy.api.preset.PresetRegistry
import dev.epiphy.api.spec.EpiphyProtocolSpec
import dev.epiphy.core.bridge.EpiphyBridgeRegistry
import dev.latvian.mods.kubejs.KubeJSPlugin
import dev.latvian.mods.kubejs.script.BindingsEvent

/**
 * KubeJS 软兼容前置桥接插件（位于独立 `compat` SourceSet，仅在安装 KubeJS 时由 `kubejs.plugins.txt` 激活）。
 *
 * 职责：
 * 1. 向 KubeJS 暴露 `EpiphyNative` 底座探针、原生有界缓存/预设注册表工厂与官方双别名归一化器；
 * 2. 将 [EpiphyBridgeRegistry] 中已就位的原生核心模块（M1 `Spec`/`ServerCore`/`Log`/`Debug`）及
 *    视听高消耗热路径加速算子（M2 `Item3D`/`World3D`/`Surface2D`/`AudioClient`）自动同步至顶层绑定与 `global.*`，
 *    确保尚未迁出的存量 KubeJS 脚本零改动继续运行与实机联调。
 */
class EpiphyKubeJSPlugin : KubeJSPlugin() {
    private val logger = LogUtils.getLogger()

    override fun init() {
        logger.info("[EpiphyCompat] EpiphyKubeJSPlugin initialized (bridging native core -> KubeJS scripts).")
    }

    override fun registerBindings(event: BindingsEvent) {
        event.add("EpiphyNative", EpiphyNativeJsFacade)

        val components = EpiphyBridgeRegistry.snapshotGlobalComponents()
        for ((name, facade) in components) {
            event.add(name, facade)
        }

        // 同步写入该脚本上下文关联的共享 `global` Map，兼容现有脚本 `global.Epiphy*` 访问习惯
        val globalObj = event.manager?.let { mgr ->
            runCatching {
                val field = mgr.javaClass.getField("global")
                @Suppress("UNCHECKED_CAST")
                field.get(mgr) as? MutableMap<String, Any?>
            }.getOrNull()
        }
        if (globalObj != null) {
            globalObj["EpiphyNative"] = EpiphyNativeJsFacade
            for ((name, facade) in components) {
                globalObj[name] = facade
            }
        }
    }
}

/**
 * 暴露给 KubeJS 脚本侧的原生引擎总控与加速后端查询门面（`EpiphyNative` / `global.EpiphyNative`）。
 */
object EpiphyNativeJsFacade {
    @JvmField
    val VERSION: String = EpiphyProtocolSpec.SCHEMA_VERSION

    fun getCoreVersion(): String = EpiphyBridgeRegistry.coreVersion

    fun isMixinBoosterActive(): Boolean = EpiphyBridgeRegistry.mixinBoosterActive

    fun isVersionInRange(actual: String?, min: String?, max: String?): Boolean =
        SemVer.isInClosedRange(actual, min, max)

    @JvmOverloads
    fun createBoundedCache(maxSize: Int, mode: String = "lru"): BoundedCache<Any, Any> {
        val policy = if (mode.equals("fifo", ignoreCase = true)) EvictionPolicy.FIFO else EvictionPolicy.LRU
        return BoundedCache(maxSize.coerceAtLeast(1), policy)
    }

    fun getPresetDomain(domain: String): PresetRegistry<Any> = PresetRegistry.domain(domain)

    fun normalizeEnvelope(raw: Map<String, Any?>): Map<String, Any?> =
        EpiphyProtocolSpec.normalizeEnvelopeMap(raw)

    fun normalizeNode(raw: Map<String, Any?>): Map<String, Any?> =
        EpiphyProtocolSpec.normalizeNodeMap(raw)

    fun hasAccelerator(domain: String): Boolean = EpiphyBridgeRegistry.hasAccelerator(domain)

    fun getAccelerator(domain: String): Any? = EpiphyBridgeRegistry.getAccelerator(domain)

    fun listAccelerators(): Set<String> = EpiphyBridgeRegistry.listAccelerators()
}
