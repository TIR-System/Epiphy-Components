// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.core.storage

import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.charset.StandardCharsets
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.util.concurrent.ThreadLocalRandom

/**
 * 强类型状态化 JSON 原子持久化门面（对应并强化原 `openJsonStore`）。
 *
 * 鲁棒性保证：
 * 1. **缺失与损坏严格区分**：正本与 `.bak` 均不存在时返回 [LoadOutcome.Missing]，绝不复活已主动删除的文件；
 * 2. **自动 `.bak` 备份自愈**：仅当正本存在但解析失败时，自动校验并从 `.bak` 恢复正本；
 * 3. **损坏现场隔离与防覆写锁 (`corruptLocked`)**：若正本损坏且无可用 `.bak`，立即将坏文件隔离重命名为
 *    `<file>.corrupt.<epochMs>.bak` 并置 [isCorruptLocked] = `true`，拒绝后续常规写入以防空内存状态覆盖可抢救数据；
 * 4. **fsync + 原子替换 + 幂等跳过**：写入先经同目录 `.tmp` 强制刷盘 (`FileChannel.force`) 再原子替换，内容未变时零磁盘 I/O。
 */
class AtomicJsonStore<T : Any>(
    rawFilePath: Path,
    private val serializer: KSerializer<T>,
    private val json: Json = DEFAULT_PRETTY_JSON,
    private val lockOnCorrupt: Boolean = true
) {
    val filePath: Path = rawFilePath.toAbsolutePath().normalize()
    val backupPath: Path = filePath.resolveSibling("${filePath.fileName}.bak")

    @Volatile
    var isCorruptLocked: Boolean = false
        private set

    @Volatile
    var lastCorruptQuarantinePath: Path? = null
        private set

    @Volatile
    private var lastSerializedSnapshot: String? = null

    sealed interface LoadOutcome<out T> {
        data object Missing : LoadOutcome<Nothing>
        data class Loaded<T>(val value: T) : LoadOutcome<T>
        data class RecoveredFromBackup<T>(val value: T, val quarantinedCorruptFile: Path?) : LoadOutcome<T>
        data class CorruptLocked(val quarantinedCorruptFile: Path?, val error: Throwable) : LoadOutcome<Nothing>
    }

    sealed interface SaveOutcome {
        data object Written : SaveOutcome
        data object SkippedUnchanged : SaveOutcome
        data object BlockedByCorruptLock : SaveOutcome
        data class Failed(val error: Throwable) : SaveOutcome
    }

    @Synchronized
    fun unlockAfterManualRecovery() {
        isCorruptLocked = false
    }

    @Synchronized
    fun load(): LoadOutcome<T> {
        val mainExists = Files.isRegularFile(filePath)
        val bakExists = Files.isRegularFile(backupPath)

        // 铁律：正本缺失时不从残留 .bak 复活已删除文件
        if (!mainExists) {
            lastSerializedSnapshot = null
            return LoadOutcome.Missing
        }

        val mainAttempt = runCatching {
            val raw = Files.readString(filePath, StandardCharsets.UTF_8)
            val parsed = json.decodeFromString(serializer, raw)
            raw to parsed
        }
        if (mainAttempt.isSuccess) {
            val (raw, parsed) = mainAttempt.getOrThrow()
            lastSerializedSnapshot = raw
            isCorruptLocked = false
            return LoadOutcome.Loaded(parsed)
        }

        val mainErr = mainAttempt.exceptionOrNull() ?: IOException("Unknown JSON decode failure: $filePath")
        val quarantined = quarantineCorruptMainFile()

        if (bakExists) {
            val bakAttempt = runCatching {
                val bakRaw = Files.readString(backupPath, StandardCharsets.UTF_8)
                val bakParsed = json.decodeFromString(serializer, bakRaw)
                bakRaw to bakParsed
            }
            if (bakAttempt.isSuccess) {
                val (bakRaw, bakParsed) = bakAttempt.getOrThrow()
                // 用完好的 .bak 修复正本
                runCatching { writeRawStringAtomically(filePath, bakRaw, rotateBackup = false) }
                lastSerializedSnapshot = bakRaw
                isCorruptLocked = false
                return LoadOutcome.RecoveredFromBackup(bakParsed, quarantined)
            }
        }

        if (lockOnCorrupt) {
            isCorruptLocked = true
        }
        lastCorruptQuarantinePath = quarantined
        return LoadOutcome.CorruptLocked(quarantined, mainErr)
    }

    @Synchronized
    fun save(value: T, forceWrite: Boolean = false): SaveOutcome {
        if (isCorruptLocked) {
            return SaveOutcome.BlockedByCorruptLock
        }
        return runCatching {
            val encoded = json.encodeToString(serializer, value)
            if (!forceWrite && encoded == lastSerializedSnapshot && Files.isRegularFile(filePath)) {
                return SaveOutcome.SkippedUnchanged
            }
            writeRawStringAtomically(filePath, encoded, rotateBackup = true)
            lastSerializedSnapshot = encoded
            SaveOutcome.Written
        }.getOrElse { err ->
            SaveOutcome.Failed(err)
        }
    }

    private fun quarantineCorruptMainFile(): Path? {
        if (!Files.isRegularFile(filePath)) return null
        val stamp = System.currentTimeMillis()
        val quarantine = filePath.resolveSibling("${filePath.fileName}.corrupt.$stamp.bak")
        return runCatching {
            moveWithWindowsFallback(filePath, quarantine)
            quarantine
        }.getOrNull()
    }

    companion object {
        val DEFAULT_PRETTY_JSON: Json = Json {
            prettyPrint = true
            encodeDefaults = true
            ignoreUnknownKeys = true
        }

        fun ensureParentDirectory(target: Path) {
            val parent = target.toAbsolutePath().normalize().parent
            if (parent != null && !Files.isDirectory(parent)) {
                Files.createDirectories(parent)
            }
        }

        fun writeRawStringAtomically(target: Path, content: String, rotateBackup: Boolean) {
            val normTarget = target.toAbsolutePath().normalize()
            ensureParentDirectory(normTarget)
            val parent = normTarget.parent ?: error("Target path has no parent directory: $normTarget")
            val nonce = ThreadLocalRandom.current().nextLong(100_000L, 999_999_999L)
            val tmpFile = parent.resolve(".${normTarget.fileName}.$nonce.tmp")
            val bakFile = normTarget.resolveSibling("${normTarget.fileName}.bak")

            try {
                val bytes = content.toByteArray(StandardCharsets.UTF_8)
                FileChannel.open(
                    tmpFile,
                    StandardOpenOption.CREATE,
                    StandardOpenOption.WRITE,
                    StandardOpenOption.TRUNCATE_EXISTING
                ).use { ch ->
                    val buf = ByteBuffer.wrap(bytes)
                    while (buf.hasRemaining()) {
                        ch.write(buf)
                    }
                    ch.force(true)
                }

                if (rotateBackup && Files.isRegularFile(normTarget)) {
                    runCatching {
                        Files.copy(normTarget, bakFile, StandardCopyOption.REPLACE_EXISTING)
                    }
                }

                moveWithWindowsFallback(tmpFile, normTarget)
            } finally {
                runCatching { Files.deleteIfExists(tmpFile) }
            }
        }

        private fun moveWithWindowsFallback(src: Path, dst: Path) {
            var lastErr: IOException? = null
            for (attempt in 0 until 3) {
                try {
                    Files.move(src, dst, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
                    return
                } catch (_: AtomicMoveNotSupportedException) {
                    Files.move(src, dst, StandardCopyOption.REPLACE_EXISTING)
                    return
                } catch (ioe: IOException) {
                    lastErr = ioe
                    if (attempt < 2) {
                        try {
                            Thread.sleep(15L * (attempt + 1))
                        } catch (_: InterruptedException) {
                            Thread.currentThread().interrupt()
                            break
                        }
                    }
                }
            }
            // 最终非 ATOMIC_MOVE 兜底尝试一次
            try {
                Files.move(src, dst, StandardCopyOption.REPLACE_EXISTING)
            } catch (finalErr: IOException) {
                throw lastErr ?: finalErr
            }
        }
    }
}
