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
 * 带备份恢复与损坏写保护的强类型 JSON 文件存储门面（对应原脚本层的 `openJsonStore`）。
 *
 * 工作机制：
 * 1. 区分“文件未创建”与“文件损坏”：当正本不存在时直接返回 [LoadOutcome.Missing]，不会从残留 `.bak` 重新生成已删除的文件；
 * 2. 备份恢复：当正本存在但反序列化失败时，尝试读取并校验同目录下的 `.bak` 副本，校验通过则用其修复正本；
 * 3. 损坏隔离与拒写保护：若正本与 `.bak` 均不可用，将损坏正本重命名为 `<file>.corrupt.<epochMs>.bak` 并置 [isCorruptLocked] 为 `true`，
 *    阻止后续常规保存用内存默认值覆盖现场；
 * 4. 刷盘与替换：保存时先写入同目录临时文件并调用 `FileChannel.force(true)`，再移动替换目标文件；序列化文本未变化时跳过写盘。
 *
 * 已知边界：
 * - 同步保护仅作用于当前 JVM 实例内的同一 `AtomicJsonStore` 对象，不提供跨进程文件锁，不能防御外部编辑器或另一进程同时改写同一文件。
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
