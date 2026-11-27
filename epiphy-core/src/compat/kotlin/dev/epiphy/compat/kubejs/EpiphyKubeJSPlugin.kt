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
import dev.epiphy.core.config.EpiphyConfig
import dev.epiphy.core.debug.RollingNanoSampler
import dev.epiphy.core.storage.RawJsonFileStore
import dev.epiphy.core.world.NativeSectionScanner
import dev.latvian.mods.kubejs.KubeJSPlugin
import dev.latvian.mods.kubejs.script.BindingsEvent
import net.minecraft.world.level.chunk.LevelChunkSection
import java.nio.file.Path

/**
 * KubeJS 软兼容桥接插件（独立 `compat` SourceSet，仅在安装 KubeJS 时激活）。
 *
 * 保持顶层命名空间高度克制：顶层仅暴露单一总入口 `EpiphyNative`，
 * 供现有 KubeJS 脚本像外挂 `CodeChickenLib` 一样非侵入地将高消耗/高危操作挂载到原生 Mod 上。
 */
class EpiphyKubeJSPlugin : KubeJSPlugin() {
    private val logger = LogUtils.getLogger()

    override fun init() {
        EpiphyRuntime.ensureInitialized()
        logger.info("[EpiphyCompat] EpiphyKubeJSPlugin ready (exposing single root 'EpiphyNative' accelerator gateway).")
    }

    override fun registerBindings(event: BindingsEvent) {
        event.add("EpiphyNative", EpiphyNativeJsFacade)

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
 * 与现有 KubeJS `EpiphySpec.createBoundedCache` 100% 同签名兼容的原生 O(1) 缓存适配器。
 */
class JsBoundedCacheAdapter(
    private val limitCount: Int,
    private val policyName: String,
    private val backing: BoundedCache<String, Any>
) {
    private object NullValue

    fun get(key: Any?): Any? {
        val v = backing.get(key?.toString() ?: "")
        return if (v === NullValue) null else v
    }
    fun has(key: Any?): Boolean = backing.has(key?.toString() ?: "")
    fun set(key: Any?, value: Any?): Any? {
        backing.set(key?.toString() ?: "", value ?: NullValue)
        return value
    }
    fun delete(key: Any?): Boolean = backing.delete(key?.toString() ?: "")
    fun clear() = backing.clear()
    fun size(): Int = backing.size
    fun limit(): Int = limitCount
    fun policy(): String = policyName
}

/**
 * 面向 KubeJS 脚本暴露的原生高性能内核与阻塞原语网关（`EpiphyNative`）。
 * 注意：所有客户端加速对象均通过 `EpiphyBridgeRegistry` 以 `Any?` 返回，确保专用服务端零客户端类加载。
 */
object EpiphyNativeJsFacade {
    private val T0_NANOS: Long = System.nanoTime()

    @JvmField
    val VERSION: String = EpiphyProtocolSpec.SCHEMA_VERSION

    fun getCoreVersion(): String = EpiphyBridgeRegistry.coreVersion

    fun isMixinBoosterActive(): Boolean = EpiphyBridgeRegistry.mixinBoosterActive

    fun nowNano(): Long = System.nanoTime()

    fun elapsedMillis(): Double = (System.nanoTime() - T0_NANOS) / 1_000_000.0

    fun isVersionInRange(actual: String?, min: String?, max: String?): Boolean =
        SemVer.isInClosedRange(actual, min, max)

    @JvmOverloads
    fun createBoundedCache(maxSize: Int, mode: String = "lru"): JsBoundedCacheAdapter {
        val isFifo = mode.equals("fifo", ignoreCase = true)
        val policy = if (isFifo) EvictionPolicy.FIFO else EvictionPolicy.LRU
        val safeMax = maxSize.coerceAtLeast(1)
        return JsBoundedCacheAdapter(safeMax, if (isFifo) "fifo" else "lru", BoundedCache(safeMax, policy))
    }

    @JvmOverloads
    fun createPerfSampler(capacity: Int = 256): RollingNanoSampler =
        RollingNanoSampler(capacity.coerceIn(8, 16384))

    fun getPresetDomain(domain: String): PresetRegistry<Any> = PresetRegistry.domain(domain)

    fun getLogEngine() = run {
        EpiphyRuntime.ensureInitialized()
        EpiphyRuntime.logEngine
    }

    fun getDataManager() = run {
        EpiphyRuntime.ensureInitialized()
        EpiphyRuntime.dataManager
    }

    fun getDebugHub() = run {
        EpiphyRuntime.ensureInitialized()
        EpiphyRuntime.debugHub
    }

    /**
     * 安全校验：检查某路径是否误落在 `saves/<world>/` 世界存档内部（权限配置严禁落入存档内部）。
     */
    fun isPathInsideWorldSave(rawPath: String?): Boolean {
        if (rawPath.isNullOrBlank()) return false
        EpiphyRuntime.ensureInitialized()
        return runCatching { EpiphyRuntime.dataManager.isPathInsideWorldSave(Path.of(rawPath.trim())) }.getOrDefault(false)
    }

    @JvmOverloads
    fun openRawJsonStore(rawPath: String, lockOnCorrupt: Boolean = true, maxQuarantineBackups: Int = 5): RawJsonFileStore {
        EpiphyRuntime.ensureInitialized()
        return RawJsonFileStore(Path.of(rawPath.trim()), lockOnCorrupt, maxQuarantineBackups)
    }

    /**
     * 原生极速 16x16x16 区块段调色板预筛与扫描（替代 Rhino 4096 次跨界循环）。
     */
    fun scanChunkSection(
        section: LevelChunkSection?,
        sx: Int,
        sy: Int,
        sz: Int,
        targetBlockIds: Collection<String>?
    ): List<NativeSectionScanner.MatchedBlockPos> =
        NativeSectionScanner.scanSection(section, sx, sy, sz, targetBlockIds)

    fun normalizeEnvelope(raw: Map<String, Any?>): Map<String, Any?> =
        EpiphyProtocolSpec.normalizeEnvelopeMap(raw)

    fun normalizeNode(raw: Map<String, Any?>): Map<String, Any?> =
        EpiphyProtocolSpec.normalizeNodeMap(raw)

    fun hasAccelerator(domain: String): Boolean = EpiphyBridgeRegistry.hasAccelerator(domain)

    fun getAccelerator(domain: String): Any? = EpiphyBridgeRegistry.getAccelerator(domain)

    fun listAccelerators(): Set<String> = EpiphyBridgeRegistry.listAccelerators()

    fun getConfigSnapshot(): Map<String, Any> = EpiphyConfig.snapshotMap()

    // 客户端外挂快捷入口（在专用服务端自动返回 null，零客户端类引用）
    fun getSurface2D(): Any? = EpiphyBridgeRegistry.getAccelerator("surface2d.accel")
    fun getFboPool(): Any? = EpiphyBridgeRegistry.getAccelerator("surface2d.fbo")
    fun getGuiHooks(): Any? = EpiphyBridgeRegistry.getAccelerator("surface2d.guiHooks")
    fun getWorld3D(): Any? = EpiphyBridgeRegistry.getAccelerator("fx3d.worldBatch")
    fun getItem3D(): Any? = EpiphyBridgeRegistry.getAccelerator("fx3d.itemBridge")
    fun getAudioClient(): Any? = EpiphyBridgeRegistry.getAccelerator("audio.clientAccess")
}
