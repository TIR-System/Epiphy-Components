// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.core.storage

import kotlinx.serialization.Serializable
import java.nio.file.Files
import java.nio.file.Path
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue

/**
 * `epiphy-data/` 统一外部数据目录与存档复制防串档自动分叉管理器。
 *
 * 严格遵循 `README-LLM.md` §5.1 与迁移计划书 §6.2 契约：
 * - 外部骨架：`config/`, `worlds/`, `players/`, `events/`, `logs/`, `presets/`, `backups/`；
 * - 世界标识双向核验：比对存档内 `data/epiphy_world_id.json` 与外部 `worlds/<slug>__<shortId>/meta.json` (`lastWorldPath`)；
 * - 当玩家复制世界文件夹导致物理路径变化时，自动分叉出全新 `worldId` 与外部目录，并入队 OP 通知，100% 兼容既有 `epiphy-data/` 格式。
 */
class EpiphyDataManager(rawGameDir: Path) {

    val gameDir: Path = normalizeCleanPath(rawGameDir)
    val dataRoot: Path = gameDir.resolve("epiphy-data").normalize()

    val configDir: Path = dataRoot.resolve("config")
    val worldsDir: Path = dataRoot.resolve("worlds")
    val playersDir: Path = dataRoot.resolve("players")
    val eventsDir: Path = dataRoot.resolve("events")
    val rootLogsDir: Path = dataRoot.resolve("logs")
    val presetsDir: Path = dataRoot.resolve("presets")
    val backupsDir: Path = dataRoot.resolve("backups")

    private val indexStore = AtomicJsonStore(
        worldsDir.resolve("worlds_index.json"),
        WorldsIndexFile.serializer()
    )

    private val pendingForkNotices = ConcurrentLinkedQueue<WorldForkNotice>()

    @Volatile
    var activeWorldContext: BoundWorldContext? = null
        private set

    @Serializable
    data class SaveWorldAnchor(
        val worldId: String,
        val slug: String,
        val folderName: String = "",
        val createdAtMs: Long = System.currentTimeMillis()
    )

    @Serializable
    data class ExternalWorldMeta(
        val worldId: String,
        val slug: String,
        val folderName: String,
        val lastWorldPath: String,
        val forkedFromWorldId: String? = null,
        val createdAtMs: Long = System.currentTimeMillis(),
        val updatedAtMs: Long = System.currentTimeMillis()
    )

    @Serializable
    data class WorldsIndexFile(
        val version: Int = 1,
        val worlds: Map<String, String> = emptyMap() // worldId -> folderName (<slug>__<shortId>)
    )

    data class BoundWorldContext(
        val worldId: String,
        val slug: String,
        val folderName: String,
        val saveRootPath: Path,
        val externalWorldDir: Path,
        val worldLogsDir: Path,
        val forkedOnThisLoad: Boolean,
        val forkedFromFolderName: String? = null
    )

    data class WorldForkNotice(
        val previousWorldId: String,
        val previousFolderName: String,
        val previousWorldPath: String,
        val newWorldId: String,
        val newFolderName: String,
        val currentWorldPath: String,
        val timestampMs: Long = System.currentTimeMillis()
    )

    fun ensureSkeletonDirectories() {
        for (dir in listOf(dataRoot, configDir, worldsDir, playersDir, eventsDir, rootLogsDir, presetsDir, backupsDir)) {
            if (!Files.isDirectory(dir)) {
                Files.createDirectories(dir)
            }
        }
    }

    @Synchronized
    fun bindWorld(rawWorldSaveRoot: Path, displayLevelName: String? = null): BoundWorldContext {
        ensureSkeletonDirectories()

        val saveRoot = normalizeCleanPath(rawWorldSaveRoot)
        val canonicalSavePathStr = toCanonicalPathKey(saveRoot)
        val rawName = displayLevelName?.takeIf { it.isNotBlank() }
            ?: saveRoot.fileName?.toString()?.takeIf { it.isNotBlank() }
            ?: "world"
        val slug = sanitizeSlug(rawName)

        val anchorPath = saveRoot.resolve("data").resolve("epiphy_world_id.json")
        val anchorStore = AtomicJsonStore(anchorPath, SaveWorldAnchor.serializer(), lockOnCorrupt = false)
        val existingAnchor = (anchorStore.load() as? AtomicJsonStore.LoadOutcome.Loaded)?.value
            ?: (anchorStore.load() as? AtomicJsonStore.LoadOutcome.RecoveredFromBackup)?.value

        val currentIndexMap = LinkedHashMap(loadIndexMap())

        if (existingAnchor != null && existingAnchor.worldId.isNotBlank()) {
            val knownFolder = currentIndexMap[existingAnchor.worldId]
                ?.takeIf { it.isNotBlank() }
                ?: existingAnchor.folderName.takeIf { it.isNotBlank() }
                ?: buildFolderName(existingAnchor.slug.ifBlank { slug }, existingAnchor.worldId)

            val extDir = worldsDir.resolve(knownFolder).normalize()
            val metaStore = AtomicJsonStore(extDir.resolve("meta.json"), ExternalWorldMeta.serializer(), lockOnCorrupt = false)
            val existingMeta = when (val m = metaStore.load()) {
                is AtomicJsonStore.LoadOutcome.Loaded -> m.value
                is AtomicJsonStore.LoadOutcome.RecoveredFromBackup -> m.value
                else -> null
            }

            // 检测是否因复制存档导致物理路径变更 -> 触发安全自动分叉
            if (existingMeta != null &&
                existingMeta.lastWorldPath.isNotBlank() &&
                normalizePathKeyString(existingMeta.lastWorldPath) != canonicalSavePathStr
            ) {
                val newWorldId = UUID.randomUUID().toString()
                val newFolder = buildFolderName(slug, newWorldId)
                val newExtDir = worldsDir.resolve(newFolder).normalize()
                val newLogsDir = newExtDir.resolve("logs")
                Files.createDirectories(newLogsDir)

                val now = System.currentTimeMillis()
                anchorStore.save(
                    SaveWorldAnchor(
                        worldId = newWorldId,
                        slug = slug,
                        folderName = newFolder,
                        createdAtMs = now
                    ),
                    forceWrite = true
                )
                AtomicJsonStore(newExtDir.resolve("meta.json"), ExternalWorldMeta.serializer(), lockOnCorrupt = false).save(
                    ExternalWorldMeta(
                        worldId = newWorldId,
                        slug = slug,
                        folderName = newFolder,
                        lastWorldPath = canonicalSavePathStr,
                        forkedFromWorldId = existingAnchor.worldId,
                        createdAtMs = now,
                        updatedAtMs = now
                    ),
                    forceWrite = true
                )
                currentIndexMap[newWorldId] = newFolder
                indexStore.save(WorldsIndexFile(worlds = currentIndexMap))

                pendingForkNotices.add(
                    WorldForkNotice(
                        previousWorldId = existingAnchor.worldId,
                        previousFolderName = knownFolder,
                        previousWorldPath = existingMeta.lastWorldPath,
                        newWorldId = newWorldId,
                        newFolderName = newFolder,
                        currentWorldPath = canonicalSavePathStr,
                        timestampMs = now
                    )
                )

                val ctx = BoundWorldContext(
                    worldId = newWorldId,
                    slug = slug,
                    folderName = newFolder,
                    saveRootPath = saveRoot,
                    externalWorldDir = newExtDir,
                    worldLogsDir = newLogsDir,
                    forkedOnThisLoad = true,
                    forkedFromFolderName = knownFolder
                )
                activeWorldContext = ctx
                return ctx
            }

            // 同一世界正常重进：保持原 worldId 与原目录
            val logsDir = extDir.resolve("logs")
            Files.createDirectories(logsDir)
            val now = System.currentTimeMillis()
            if (existingAnchor.folderName != knownFolder) {
                anchorStore.save(existingAnchor.copy(folderName = knownFolder), forceWrite = true)
            }
            metaStore.save(
                ExternalWorldMeta(
                    worldId = existingAnchor.worldId,
                    slug = existingAnchor.slug.ifBlank { slug },
                    folderName = knownFolder,
                    lastWorldPath = canonicalSavePathStr,
                    forkedFromWorldId = existingMeta?.forkedFromWorldId,
                    createdAtMs = existingMeta?.createdAtMs ?: existingAnchor.createdAtMs,
                    updatedAtMs = now
                )
            )
            if (currentIndexMap[existingAnchor.worldId] != knownFolder) {
                currentIndexMap[existingAnchor.worldId] = knownFolder
                indexStore.save(WorldsIndexFile(worlds = currentIndexMap))
            }

            val ctx = BoundWorldContext(
                worldId = existingAnchor.worldId,
                slug = existingAnchor.slug.ifBlank { slug },
                folderName = knownFolder,
                saveRootPath = saveRoot,
                externalWorldDir = extDir,
                worldLogsDir = logsDir,
                forkedOnThisLoad = false
            )
            activeWorldContext = ctx
            return ctx
        }

        // 全新存档首次绑定
        val freshId = UUID.randomUUID().toString()
        val freshFolder = buildFolderName(slug, freshId)
        val freshExtDir = worldsDir.resolve(freshFolder).normalize()
        val freshLogsDir = freshExtDir.resolve("logs")
        Files.createDirectories(freshLogsDir)

        val now = System.currentTimeMillis()
        anchorStore.save(
            SaveWorldAnchor(worldId = freshId, slug = slug, folderName = freshFolder, createdAtMs = now),
            forceWrite = true
        )
        AtomicJsonStore(freshExtDir.resolve("meta.json"), ExternalWorldMeta.serializer(), lockOnCorrupt = false).save(
            ExternalWorldMeta(
                worldId = freshId,
                slug = slug,
                folderName = freshFolder,
                lastWorldPath = canonicalSavePathStr,
                createdAtMs = now,
                updatedAtMs = now
            ),
            forceWrite = true
        )
        currentIndexMap[freshId] = freshFolder
        indexStore.save(WorldsIndexFile(worlds = currentIndexMap))

        val ctx = BoundWorldContext(
            worldId = freshId,
            slug = slug,
            folderName = freshFolder,
            saveRootPath = saveRoot,
            externalWorldDir = freshExtDir,
            worldLogsDir = freshLogsDir,
            forkedOnThisLoad = false
        )
        activeWorldContext = ctx
        return ctx
    }

    @Synchronized
    fun unbindWorld() {
        activeWorldContext = null
    }

    fun consumePendingForkNotices(): List<WorldForkNotice> {
        val out = ArrayList<WorldForkNotice>()
        while (true) {
            val next = pendingForkNotices.poll() ?: break
            out.add(next)
        }
        return out
    }

    private fun loadIndexMap(): Map<String, String> =
        when (val res = indexStore.load()) {
            is AtomicJsonStore.LoadOutcome.Loaded -> res.value.worlds
            is AtomicJsonStore.LoadOutcome.RecoveredFromBackup -> res.value.worlds
            else -> emptyMap()
        }

    companion object {
        /**
         * 消除 Windows `LevelResource.ROOT` 常见的末尾 `/.` 与混合斜杠问题。
         */
        @JvmStatic
        fun normalizeCleanPath(raw: Path): Path {
            var norm = raw.toAbsolutePath().normalize()
            if (norm.fileName?.toString() == ".") {
                norm = norm.parent ?: norm
            }
            return norm
        }

        @JvmStatic
        fun toCanonicalPathKey(path: Path): String =
            normalizePathKeyString(normalizeCleanPath(path).toString())

        private fun normalizePathKeyString(raw: String): String {
            var s = raw.trim().replace('\\', '/')
            while (s.endsWith("/.")) s = s.dropLast(2)
            while (s.length > 3 && s.endsWith("/")) s = s.dropLast(1)
            // Windows 盘符大小写归一化
            if (s.length >= 2 && s[1] == ':') {
                s = s[0].lowercaseChar() + s.substring(1)
            }
            return s
        }

        @JvmStatic
        fun sanitizeSlug(rawName: String): String {
            val cleaned = rawName.trim()
                .replace(Regex("""[<>:"/\\|?*\x00-\x1F]+"""), "_")
                .replace(Regex("""\s+"""), "_")
                .trim('_', '.')
            return (cleaned.ifEmpty { "world" }).take(32)
        }

        @JvmStatic
        fun buildFolderName(slug: String, worldId: String): String {
            val shortId = worldId.replace("-", "").lowercase().take(8).ifEmpty { "00000000" }
            return "${sanitizeSlug(slug)}__$shortId"
        }
    }
}
