// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.core.storage

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import java.nio.file.Files
import java.nio.file.Path

/**
 * 面向动态 JSON 文本的读写包装器（供过渡期脚本按路径读写无固定 Kotlin Schema 的 JSON 配置或状态文件）。
 *
 * 内部委托 [AtomicJsonStore] 执行临时文件刷盘、`.bak` 副本恢复与损坏拒写锁，并在解锁时按数量上限清理历史 `.corrupt.*.bak` 备份。
 * 已知边界：每次读写均会经过 `JsonElement` 解析校验，不适用于超大体积流式文本文件。
 */
class RawJsonFileStore @JvmOverloads constructor(
    val targetPath: Path,
    lockOnCorrupt: Boolean = true,
    private val maxQuarantineBackups: Int = 5
) {
    private val backing = AtomicJsonStore(
        rawFilePath = targetPath,
        serializer = JsonElement.serializer(),
        json = PRETTY_JSON,
        lockOnCorrupt = lockOnCorrupt
    )

    val isCorruptLocked: Boolean
        get() = backing.isCorruptLocked

    data class RawLoadResult(
        val ok: Boolean,
        val status: String, // "ok" | "missing" | "corrupt"
        val jsonText: String?,
        val fromBackup: Boolean,
        val error: String?
    )

    fun loadRaw(): RawLoadResult = when (val out = backing.load()) {
        is AtomicJsonStore.LoadOutcome.Loaded -> RawLoadResult(
            true, "ok", PRETTY_JSON.encodeToString(JsonElement.serializer(), out.value), false, null
        )
        is AtomicJsonStore.LoadOutcome.RecoveredFromBackup -> RawLoadResult(
            true, "ok", PRETTY_JSON.encodeToString(JsonElement.serializer(), out.value), true, null
        )
        is AtomicJsonStore.LoadOutcome.Missing -> RawLoadResult(false, "missing", null, false, null)
        is AtomicJsonStore.LoadOutcome.CorruptLocked -> RawLoadResult(
            false, "corrupt", null, false, out.error.message ?: out.error.toString()
        )
    }

    /**
     * 写入原始 JSON 文本。损坏锁生效时：`quarantine=true` 表示正本已在加载时被隔离为 `.corrupt.<ts>.bak`，
     * 此时解除锁并写入新数据；否则拒绝覆盖。
     */
    @JvmOverloads
    fun saveRawJsonText(rawJson: String, force: Boolean = false, quarantine: Boolean = false): Boolean {
        val elem = runCatching { PRETTY_JSON.parseToJsonElement(rawJson) }.getOrNull() ?: return false
        if (backing.isCorruptLocked) {
            if (force || quarantine) {
                backing.unlockAfterManualRecovery()
                pruneQuarantineBackups()
            } else {
                return false
            }
        }
        val outcome = backing.save(elem, forceWrite = force)
        return outcome is AtomicJsonStore.SaveOutcome.Written || outcome is AtomicJsonStore.SaveOutcome.SkippedUnchanged
    }

    /** 解除损坏锁并返回已隔离的坏文件备份路径（若有）。 */
    fun quarantineNow(): String? {
        val p = backing.lastCorruptQuarantinePath?.toString()?.replace('\\', '/')
        backing.unlockAfterManualRecovery()
        pruneQuarantineBackups()
        return p
    }

    private fun pruneQuarantineBackups() {
        if (maxQuarantineBackups <= 0) return
        val parent = targetPath.toAbsolutePath().normalize().parent ?: return
        if (!Files.isDirectory(parent)) return
        val prefix = "${targetPath.fileName}.corrupt."
        runCatching {
            val matches = Files.list(parent).use { stream ->
                stream.filter { p ->
                    val name = p.fileName?.toString() ?: ""
                    Files.isRegularFile(p) && name.startsWith(prefix) && name.endsWith(".bak")
                }.toList()
            }.sortedBy { runCatching { Files.getLastModifiedTime(it).toMillis() }.getOrDefault(0L) }
            for (i in 0 until (matches.size - maxQuarantineBackups)) {
                Files.deleteIfExists(matches[i])
            }
        }
    }

    companion object {
        val PRETTY_JSON = Json {
            prettyPrint = true
            ignoreUnknownKeys = true
            encodeDefaults = true
        }
    }
}
