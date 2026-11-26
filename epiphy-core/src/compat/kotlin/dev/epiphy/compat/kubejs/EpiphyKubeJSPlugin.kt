// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.compat.kubejs

import com.mojang.logging.LogUtils
import dev.epiphy.api.SemVer
import dev.epiphy.api.cache.BoundedCache
import dev.epiphy.api.cache.EvictionPolicy
import dev.epiphy.api.preset.PresetRegistry
import dev.epiphy.api.spec.EpiphyProtocolSpec
import dev.epiphy.core.EpiphyRuntime
import dev.epiphy.core.bridge.EpiphyBridgeRegistry
import dev.epiphy.core.debug.RollingNanoSampler
import dev.latvian.mods.kubejs.KubeJSPlugin
import dev.latvian.mods.kubejs.script.BindingsEvent

/**
 * KubeJS 软兼容桥接插件（独立 `compat` SourceSet，仅在安装 KubeJS 时激活）。
 *
 * 保持顶层命名空间高度克制：顶层仅暴露单一总入口 `EpiphyNative`，
 * 供下游脚本将高消耗/高危操作（有界缓存池、环形性能采样器、FBO 离屏池、GUI/Slot 真夹心、零反射音频、零 CCL 物品 3D）绑定至原生 Core。
 */
class EpiphyKubeJSPlugin : KubeJSPlugin() {
    private val logger = LogUtils.getLogger()

    override fun init() {
        logger.info("[EpiphyCompat] EpiphyKubeJSPlugin ready (exposing single root 'EpiphyNative' accelerator gateway).")
    }

    override fun registerBindings(event: BindingsEvent) {
        event.add("EpiphyNative", EpiphyNativeJsFacade)

        // 若未来阶段显式注册了需要注入 global.* 的兼容门面，按需同步而不污染顶层命名空间
        val globalMap = event.manager?.let { mgr ->
            runCatching {
                val field = mgr.javaClass.getField("global")
                @Suppress("UNCHECKED_CAST")
                field.get(mgr) as? MutableMap<String, Any?>
            }.getOrNull()
        }
        if (globalMap != null) {
            globalMap["EpiphyNative"] = EpiphyNativeJsFacade
            for ((name, facade) in EpiphyBridgeRegistry.snapshotGlobalComponents()) {
                globalMap[name] = facade
            }
        }
    }
}

/**
 * 面向 KubeJS 脚本暴露的原生高性能内核与阻塞原语网关（`EpiphyNative`）。
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

    @JvmOverloads
    fun createPerfSampler(capacity: Int = 256): RollingNanoSampler =
        RollingNanoSampler(capacity.coerceIn(8, 16384))

    fun getPresetDomain(domain: String): PresetRegistry<Any> = PresetRegistry.domain(domain)

    fun getLogEngine() = EpiphyRuntime.logEngine

    fun getDataManager() = EpiphyRuntime.dataManager

    fun getDebugHub() = EpiphyRuntime.debugHub

    fun normalizeEnvelope(raw: Map<String, Any?>): Map<String, Any?> =
        EpiphyProtocolSpec.normalizeEnvelopeMap(raw)

    fun normalizeNode(raw: Map<String, Any?>): Map<String, Any?> =
        EpiphyProtocolSpec.normalizeNodeMap(raw)

    fun hasAccelerator(domain: String): Boolean = EpiphyBridgeRegistry.hasAccelerator(domain)

    fun getAccelerator(domain: String): Any? = EpiphyBridgeRegistry.getAccelerator(domain)

    fun listAccelerators(): Set<String> = EpiphyBridgeRegistry.listAccelerators()
}
