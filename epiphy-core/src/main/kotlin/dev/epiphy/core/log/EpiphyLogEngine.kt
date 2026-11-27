// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.core.log

import org.slf4j.LoggerFactory
import java.io.BufferedWriter
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * 基于有界队列与后台写盘线程的限频日志记录器（对应原脚本层的 `EpiphyLog`）。
 *
 * 工作机制：
 * 1. 调用线程将日志条目放入有界 `ArrayBlockingQueue` 后立即返回，由守护线程负责打开文件与顺序写入，减少磁盘 I/O 对主线程的阻塞；
 * 2. 对指定了 `rateLimitMs > 0` 的日志按级别、模块与标签聚合，在时间窗口内抑制重复输出并在下一次输出时附带 `(suppressed N repeats)` 计数；
 * 3. 支持按生命周期切换输出目录：未进入世界时写入 `epiphy-data/logs/YYYY-MM-DD.log`，绑定世界后切换至对应世界 `logs/` 目录。
 *
 * 已知边界：
 * - 当后台写盘速度慢于突发日志产生速度且队列满载时，新入队条目会被丢弃并累加丢弃计数（SLF4J 控制台输出不受队列满载影响）。
 */
class EpiphyLogEngine(
    initialLogDir: Path,
    private val defaultRateLimitMs: Long = 5_000L,
    queueCapacity: Int = 4096
) : AutoCloseable {

    enum class Level { DEBUG, INFO, WARN, ERROR }

    private data class RateBucket(
        var lastEmittedAtMs: Long = 0L,
        var suppressedCount: Long = 0L
    )

    private sealed interface QueueCommand {
        data class Entry(
            val timestampMs: Long,
            val level: Level,
            val module: String,
            val tag: String,
            val message: String
        ) : QueueCommand

        data class SwitchDir(val newDir: Path) : QueueCommand
        class FlushBarrier(val done: java.util.concurrent.CountDownLatch = java.util.concurrent.CountDownLatch(1)) : QueueCommand
        data object Shutdown : QueueCommand
    }

    private val slf4j = LoggerFactory.getLogger("Epiphy")
    private val rootLogDir: Path = initialLogDir.toAbsolutePath().normalize()

    @Volatile
    var currentLogDir: Path = rootLogDir
        private set

    @Volatile
    var fileLoggingEnabled: Boolean = true

    @Volatile
    var globalDebugEnabled: Boolean = false

    @Volatile
    var deprecationWarningsEnabled: Boolean = false

    private val moduleDebugFlags = ConcurrentHashMap<String, Boolean>()
    private val rateBuckets = ConcurrentHashMap<String, RateBucket>()
    private val onceKeys = ConcurrentHashMap.newKeySet<String>()
    private val pendingDroppedNotices = AtomicLong(0L)
    private val totalDroppedEntries = AtomicLong(0L)
    private val totalWrittenLines = AtomicLong(0L)

    private val queue = ArrayBlockingQueue<QueueCommand>(queueCapacity.coerceAtLeast(128))
    private val closed = AtomicBoolean(false)

    private val writerThread = Thread({ runWriterLoop() }, "Epiphy-AsyncLogWriter").apply {
        isDaemon = true
        start()
    }

    fun isDebugEnabledFor(module: String): Boolean =
        globalDebugEnabled || (moduleDebugFlags[module.trim().lowercase()] == true)

    fun setModuleDebug(module: String, enabled: Boolean) {
        val key = module.trim().lowercase()
        if (key == "*" || key == "all") {
            globalDebugEnabled = enabled
            if (!enabled) moduleDebugFlags.clear()
        } else if (key == "deprecations" || key == "deprecated") {
            deprecationWarningsEnabled = enabled
        } else if (key.isNotEmpty()) {
            moduleDebugFlags[key] = enabled
        }
    }

    fun switchLogDirectory(targetDir: Path) {
        val norm = targetDir.toAbsolutePath().normalize()
        currentLogDir = norm
        queue.offer(QueueCommand.SwitchDir(norm))
    }

    fun resetToRootDirectory() {
        switchLogDirectory(rootLogDir)
    }

    fun debug(module: String, tag: String, message: String) {
        if (!isDebugEnabledFor(module)) return
        emit(Level.DEBUG, module, tag, message, rateLimitMs = 0L)
    }

    fun info(module: String, tag: String, message: String) {
        emit(Level.INFO, module, tag, message, rateLimitMs = 0L)
    }

    fun warn(module: String, tag: String, message: String, rateLimitMs: Long = defaultRateLimitMs) {
        emit(Level.WARN, module, tag, message, rateLimitMs = rateLimitMs)
    }

    fun error(module: String, tag: String, message: String, throwable: Throwable? = null, rateLimitMs: Long = defaultRateLimitMs) {
        val fullMsg = if (throwable != null) "$message (${throwable.javaClass.simpleName}: ${throwable.message})" else message
        emit(Level.ERROR, module, tag, fullMsg, rateLimitMs = rateLimitMs)
    }

    fun catchWarn(module: String, tag: String, throwable: Throwable, rateLimitMs: Long = defaultRateLimitMs) {
        val summary = "${throwable.javaClass.simpleName}: ${throwable.message ?: "no message"}"
        emit(Level.WARN, module, tag, summary, rateLimitMs = rateLimitMs)
    }

    fun warnOnce(module: String, onceKey: String, message: String): Boolean {
        val composite = "${module.trim().lowercase()}|$onceKey"
        if (!onceKeys.add(composite)) return false
        emit(Level.WARN, module, onceKey, message, rateLimitMs = 0L)
        return true
    }

    fun warnDeprecatedOnce(module: String, onceKey: String, message: String): Boolean {
        if (!deprecationWarningsEnabled) return false
        return warnOnce(module, "deprecated:$onceKey", message)
    }

    fun clearOnceHistory() {
        onceKeys.clear()
    }

    fun flushSync(timeoutMs: Long = 2_000L): Boolean {
        if (closed.get()) return false
        val barrier = QueueCommand.FlushBarrier()
        if (!queue.offer(barrier, timeoutMs, TimeUnit.MILLISECONDS)) return false
        return barrier.done.await(timeoutMs, TimeUnit.MILLISECONDS)
    }

    fun statsSnapshot(): Map<String, Any> = mapOf(
        "currentLogDir" to currentLogDir.toString(),
        "fileLoggingEnabled" to fileLoggingEnabled,
        "globalDebug" to globalDebugEnabled,
        "deprecationWarnings" to deprecationWarningsEnabled,
        "queuedCommands" to queue.size,
        "writtenLines" to totalWrittenLines.get(),
        "droppedEntries" to totalDroppedEntries.get(),
        "onceKeysCount" to onceKeys.size
    )

    private fun emit(level: Level, module: String, tag: String, message: String, rateLimitMs: Long) {
        if (closed.get()) return
        val now = System.currentTimeMillis()
        var finalMessage = message

        if (rateLimitMs > 0L) {
            val bucketKey = "${level.name}|${module.trim()}|${tag.trim()}"
            var shouldEmit = false
            var suppressedBefore = 0L
            rateBuckets.compute(bucketKey) { _, existing ->
                val b = existing ?: RateBucket()
                if ((now - b.lastEmittedAtMs) >= rateLimitMs) {
                    suppressedBefore = b.suppressedCount
                    b.lastEmittedAtMs = now
                    b.suppressedCount = 0L
                    shouldEmit = true
                } else {
                    b.suppressedCount++
                }
                b
            }
            if (!shouldEmit) return
            if (suppressedBefore > 0L) {
                finalMessage = "$message (suppressed $suppressedBefore repeats)"
            }
        }

        val consoleLine = "[$module/$tag] $finalMessage"
        when (level) {
            Level.DEBUG -> slf4j.debug(consoleLine)
            Level.INFO -> slf4j.info(consoleLine)
            Level.WARN -> slf4j.warn(consoleLine)
            Level.ERROR -> slf4j.error(consoleLine)
        }

        if (!fileLoggingEnabled) return

        val entry = QueueCommand.Entry(now, level, module, tag, finalMessage)
        if (!queue.offer(entry)) {
            pendingDroppedNotices.incrementAndGet()
            totalDroppedEntries.incrementAndGet()
        }
    }

    private fun runWriterLoop() {
        var activeDir = rootLogDir
        var activeDate: LocalDate? = null
        var writer: BufferedWriter? = null

        fun closeWriterQuietly() {
            runCatching { writer?.flush() }
            runCatching { writer?.close() }
            writer = null
        }

        fun ensureWriterFor(date: LocalDate): BufferedWriter? {
            if (writer != null && activeDate == date) return writer
            closeWriterQuietly()
            return runCatching {
                if (!Files.isDirectory(activeDir)) {
                    Files.createDirectories(activeDir)
                }
                val logFile = activeDir.resolve("${DATE_FMT.format(date)}.log")
                Files.newBufferedWriter(
                    logFile,
                    StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE,
                    StandardOpenOption.WRITE,
                    StandardOpenOption.APPEND
                ).also {
                    activeDate = date
                    writer = it
                }
            }.getOrNull()
        }

        try {
            while (true) {
                val cmd = queue.poll(500L, TimeUnit.MILLISECONDS)
                if (cmd == null) {
                    runCatching { writer?.flush() }
                    if (closed.get() && queue.isEmpty()) break
                    continue
                }
                when (cmd) {
                    is QueueCommand.Entry -> {
                        if (!fileLoggingEnabled) {
                            closeWriterQuietly()
                            continue
                        }
                        val zone = ZoneId.systemDefault()
                        val instant = Instant.ofEpochMilli(cmd.timestampMs)
                        val date = LocalDate.ofInstant(instant, zone)
                        val w = ensureWriterFor(date)
                        if (w != null) {
                            runCatching {
                                val dropped = pendingDroppedNotices.getAndSet(0L)
                                if (dropped > 0L) {
                                    w.write("${TIME_FMT.format(instant.atZone(zone))} [WARN] [EpiphyLog/Backpressure] Dropped $dropped log entries due to full queue")
                                    w.newLine()
                                }
                                w.write("${TIME_FMT.format(instant.atZone(zone))} [${cmd.level.name}] [${cmd.module}/${cmd.tag}] ${cmd.message}")
                                w.newLine()
                                totalWrittenLines.incrementAndGet()
                            }
                        }
                    }

                    is QueueCommand.SwitchDir -> {
                        if (cmd.newDir != activeDir) {
                            closeWriterQuietly()
                            activeDir = cmd.newDir
                            activeDate = null
                        }
                    }

                    is QueueCommand.FlushBarrier -> {
                        runCatching { writer?.flush() }
                        cmd.done.countDown()
                    }

                    QueueCommand.Shutdown -> {
                        closeWriterQuietly()
                        break
                    }
                }
            }
        } finally {
            closeWriterQuietly()
        }
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        queue.offer(QueueCommand.Shutdown)
        runCatching { writerThread.join(1_500L) }
    }

    companion object {
        private val DATE_FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd")
        private val TIME_FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss.SSS")
    }
}
