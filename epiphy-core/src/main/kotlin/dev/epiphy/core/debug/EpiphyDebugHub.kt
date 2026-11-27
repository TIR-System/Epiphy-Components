// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.core.debug

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/**
 * 基于固定长度 `LongArray` 环形缓冲区的耗时采样器（用于统计渲染阶段或服务端任务的分位数耗时）。
 *
 * 已知边界：`recordNanos` 与 `snapshot` 通过 `@Synchronized` 互斥；`snapshot()` 会复制当前窗口样本并排序，适合在调试命令或低频遥测导出时调用，不宜在每帧热循环内高频调用。
 */
class RollingNanoSampler(val capacity: Int = 256) {
    init {
        require(capacity in 8..16384) { "Sampler capacity must be in 8..16384, got $capacity" }
    }

    private val ring = LongArray(capacity)
    private var writeCursor = 0
    private var filled = 0
    private val totalSamples = AtomicLong(0L)
    private var maxNanosSeen = 0L
    private var lastNanos = 0L

    data class PerfSnapshot(
        val windowSamples: Int,
        val totalCalls: Long,
        val avgMs: Double,
        val p50Ms: Double = 0.0,
        val p95Ms: Double,
        val p99Ms: Double = 0.0,
        val maxMs: Double,
        val lastMs: Double
    )

    @Synchronized
    fun recordNanos(durationNanos: Long) {
        val clamped = durationNanos.coerceAtLeast(0L)
        ring[writeCursor] = clamped
        writeCursor = (writeCursor + 1) % capacity
        if (filled < capacity) filled++
        totalSamples.incrementAndGet()
        lastNanos = clamped
        if (clamped > maxNanosSeen) maxNanosSeen = clamped
    }

    inline fun <R> measure(block: () -> R): R {
        val t0 = System.nanoTime()
        try {
            return block()
        } finally {
            recordNanos(System.nanoTime() - t0)
        }
    }

    @Synchronized
    fun snapshot(): PerfSnapshot {
        if (filled == 0) {
            return PerfSnapshot(0, totalSamples.get(), 0.0, 0.0, 0.0, 0.0, 0.0, 0.0)
        }
        val copy = LongArray(filled)
        for (i in 0 until filled) {
            copy[i] = ring[i]
        }
        copy.sort()
        var sum = 0L
        for (v in copy) sum += v
        val p50Idx = ((filled - 1) * 50) / 100
        val p95Idx = ((filled - 1) * 95) / 100
        val p99Idx = ((filled - 1) * 99) / 100
        return PerfSnapshot(
            windowSamples = filled,
            totalCalls = totalSamples.get(),
            avgMs = (sum.toDouble() / filled) / 1_000_000.0,
            p50Ms = copy[p50Idx] / 1_000_000.0,
            p95Ms = copy[p95Idx] / 1_000_000.0,
            p99Ms = copy[p99Idx] / 1_000_000.0,
            maxMs = maxNanosSeen / 1_000_000.0,
            lastMs = lastNanos / 1_000_000.0
        )
    }

    @Synchronized
    fun reset() {
        writeCursor = 0
        filled = 0
        totalSamples.set(0L)
        maxNanosSeen = 0L
        lastNanos = 0L
    }
}

/**
 * 强类型模块诊断提供者 SPI 接口。
 */
interface EpiphyDebugProvider {
    val id: String
    val label: String get() = id
    val order: Int get() = 100

    fun summary(): String
    fun detailLines(): List<String> = emptyList()
    fun metrics(): Map<String, Any?> = emptyMap()
    fun runHealthChecks(): List<HealthCheckItem> = emptyList()
    fun actionDescriptions(): Map<String, String> = emptyMap()
    fun invokeAction(actionName: String, args: List<String> = emptyList()): String? = null
}

data class HealthCheckItem(
    val providerId: String,
    val checkName: String,
    val ok: Boolean,
    val detail: String
)

/**
 * 模块诊断与自检汇总中心。
 *
 * 遍历各已注册 [EpiphyDebugProvider] 时独立捕获其抛出的异常并转为错误条目，避免单个模块的诊断逻辑异常中断其余模块的汇总输出。
 */
class EpiphyDebugHub {
    private val providers = ConcurrentHashMap<String, EpiphyDebugProvider>()

    fun register(provider: EpiphyDebugProvider) {
        val norm = provider.id.trim().lowercase()
        require(norm.isNotEmpty()) { "DebugProvider id must not be blank" }
        providers[norm] = provider
    }

    fun unregister(id: String): Boolean = providers.remove(id.trim().lowercase()) != null

    fun hasProvider(id: String): Boolean = providers.containsKey(id.trim().lowercase())

    fun getProvider(id: String): EpiphyDebugProvider? = providers[id.trim().lowercase()]

    fun orderedProviders(): List<EpiphyDebugProvider> =
        providers.values.sortedWith(compareBy<EpiphyDebugProvider> { it.order }.thenBy { it.id })

    fun listProviderIds(): List<String> =
        orderedProviders().map { it.id.trim().lowercase() }

    fun collectSummaries(): Map<String, String> {
        val ordered = providers.values.sortedWith(compareBy<EpiphyDebugProvider> { it.order }.thenBy { it.id })
        val out = LinkedHashMap<String, String>(ordered.size)
        for (p in ordered) {
            val key = p.id.trim().lowercase()
            out[key] = runCatching { p.summary() }
                .getOrElse { err -> "ERROR(${err.javaClass.simpleName}: ${err.message})" }
        }
        return out
    }

    fun collectAllHealthChecks(): List<HealthCheckItem> {
        val ordered = providers.values.sortedWith(compareBy<EpiphyDebugProvider> { it.order }.thenBy { it.id })
        val out = ArrayList<HealthCheckItem>()
        for (p in ordered) {
            val key = p.id.trim().lowercase()
            val items = runCatching { p.runHealthChecks() }
                .getOrElse { err ->
                    listOf(
                        HealthCheckItem(
                            providerId = key,
                            checkName = "provider_exception_guard",
                            ok = false,
                            detail = "${err.javaClass.simpleName}: ${err.message}"
                        )
                    )
                }
            out.addAll(items)
        }
        return out
    }

    fun collectJvmMemoryMetrics(): Map<String, Any> {
        val rt = Runtime.getRuntime()
        val usedBytes = rt.totalMemory() - rt.freeMemory()
        return mapOf(
            "heapUsedMb" to (usedBytes / (1024 * 1024)),
            "heapTotalMb" to (rt.totalMemory() / (1024 * 1024)),
            "heapMaxMb" to (rt.maxMemory() / (1024 * 1024)),
            "availableProcessors" to rt.availableProcessors()
        )
    }
}
