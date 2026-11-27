// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.client.util

import dev.epiphy.core.EpiphyRuntime
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/**
 * 渲染与钩子分发路径通用的异常隔离与计数熔断器。
 *
 * 工作机制：
 * 1. 遇到 [VirtualMachineError]（如 `OutOfMemoryError`、`StackOverflowError`）、[LinkageError] 或 [ThreadDeath] 时直接向外重抛，不吞咽致命错误；
 * 2. 遇到普通运行期异常时累加连续失败计数与累计失败计数，并通过 `EpiphyLogEngine` 限频输出告警；
 * 3. 当连续失败次数达到 [tripThreshold] 时将 [isTripped] 置为 `true` 并输出一条错误日志，后续调用直接跳过直至显式调用 [reset]（如资源包重载或重新绑定时）。
 *
 * 已知边界：
 * - 熔断粒度以单个 `RenderFaultCircuitBreaker` 实例为准；若多个独立监听器共用同一熔断器，任一监听器持续抛错均会触发该通道熔断。
 */
class RenderFaultCircuitBreaker(
    val module: String,
    val channelTag: String,
    val tripThreshold: Int = 8,
    private val warnRateLimitMs: Long = 5_000L,
    private val onTripCallback: (() -> Unit)? = null
) {
    init {
        require(tripThreshold >= 1) { "tripThreshold must be >= 1, got $tripThreshold" }
    }

    private val consecutiveFailures = AtomicInteger(0)
    private val totalFailures = AtomicLong(0L)
    private val tripped = AtomicBoolean(false)

    @Volatile
    var lastErrorSummary: String? = null
        private set

    val isTripped: Boolean
        get() = tripped.get()

    val totalFailureCount: Long
        get() = totalFailures.get()

    val consecutiveFailureCount: Int
        get() = consecutiveFailures.get()

    fun recordSuccess() {
        if (consecutiveFailures.get() != 0) {
            consecutiveFailures.set(0)
        }
    }

    fun recordFailure(throwable: Throwable, detailContext: String? = null) {
        rethrowIfFatalJvmError(throwable)
        val total = totalFailures.incrementAndGet()
        val streak = consecutiveFailures.incrementAndGet()
        val ctxPrefix = if (!detailContext.isNullOrBlank()) "[$detailContext] " else ""
        val summary = "$ctxPrefix${throwable.javaClass.simpleName}: ${throwable.message ?: "no message"}"
        lastErrorSummary = summary

        logWarnSafe(
            "$summary (streak=$streak/$tripThreshold, total=$total)"
        )

        if (streak >= tripThreshold && tripped.compareAndSet(false, true)) {
            logErrorSafe(
                "Circuit breaker tripped after $streak consecutive failures; channel suspended until reload/reset. Last error: $summary"
            )
            onTripCallback?.invoke()
        }
    }

    fun recordStructuralAnomaly(anomalyMessage: String) {
        val total = totalFailures.incrementAndGet()
        val streak = consecutiveFailures.incrementAndGet()
        lastErrorSummary = anomalyMessage
        logWarnSafe("$anomalyMessage (streak=$streak/$tripThreshold, total=$total)")
        if (streak >= tripThreshold && tripped.compareAndSet(false, true)) {
            logErrorSafe(
                "Circuit breaker tripped after $streak consecutive anomalies; channel suspended until reload/reset. Last anomaly: $anomalyMessage"
            )
            onTripCallback?.invoke()
        }
    }

    fun reset() {
        consecutiveFailures.set(0)
        tripped.set(false)
    }

    inline fun runGuarded(detailContext: String? = null, block: () -> Unit): Boolean {
        if (isTripped) return false
        return try {
            block()
            recordSuccess()
            true
        } catch (t: Throwable) {
            recordFailure(t, detailContext)
            false
        }
    }

    private fun logWarnSafe(msg: String) {
        runCatching {
            EpiphyRuntime.ensureInitialized()
            EpiphyRuntime.logEngine.warn(module, channelTag, msg, rateLimitMs = warnRateLimitMs)
        }
    }

    private fun logErrorSafe(msg: String) {
        runCatching {
            EpiphyRuntime.ensureInitialized()
            EpiphyRuntime.logEngine.error(module, "$channelTag/CircuitTripped", msg, rateLimitMs = 0L)
        }
    }

    companion object {
        @JvmStatic
        fun rethrowIfFatalJvmError(t: Throwable) {
            if (t is VirtualMachineError || t is LinkageError || t is ThreadDeath) {
                throw t
            }
        }
    }
}
