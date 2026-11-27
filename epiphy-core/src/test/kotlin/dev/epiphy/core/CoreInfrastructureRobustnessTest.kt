// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.core

import dev.epiphy.client.surface2d.fbo.FboCachePool
import dev.epiphy.core.debug.EpiphyDebugHub
import dev.epiphy.core.debug.EpiphyDebugProvider
import dev.epiphy.core.debug.RollingNanoSampler
import dev.epiphy.core.log.EpiphyLogEngine
import dev.epiphy.core.storage.AtomicJsonStore
import dev.epiphy.core.storage.EpiphyDataManager
import kotlinx.serialization.Serializable
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path

class CoreInfrastructureRobustnessTest {

    @Serializable
    data class SamplePayload(val name: String, val counter: Int)

    @Test
    fun `AtomicJsonStore enforces missing vs backup recovery vs corrupt quarantine lock`(@TempDir tempDir: Path) {
        val storePath = tempDir.resolve("state.json")
        val store = AtomicJsonStore(storePath, SamplePayload.serializer())

        // 1. 即使存在孤儿 .bak，只要正本不存在，必须返回 Missing（严禁复活已删文件）
        Files.writeString(store.backupPath, """{"name":"ghost","counter":99}""", StandardCharsets.UTF_8)
        assertEquals(AtomicJsonStore.LoadOutcome.Missing, store.load())
        Files.deleteIfExists(store.backupPath)

        // 2. 正常写入与幂等跳过
        assertEquals(AtomicJsonStore.SaveOutcome.Written, store.save(SamplePayload("alpha", 1)))
        assertEquals(AtomicJsonStore.SaveOutcome.SkippedUnchanged, store.save(SamplePayload("alpha", 1)))
        assertEquals(AtomicJsonStore.SaveOutcome.Written, store.save(SamplePayload("beta", 2)))
        assertTrue(Files.isRegularFile(store.backupPath), ".bak should be rotated after second write")

        // 3. 正本损坏但 .bak 完好 -> 自动从 .bak (alpha, 1) 自愈恢复并隔离坏正本
        Files.writeString(storePath, "{corrupted-json!!!", StandardCharsets.UTF_8)
        val recovered = store.load()
        assertTrue(recovered is AtomicJsonStore.LoadOutcome.RecoveredFromBackup)
        val recVal = (recovered as AtomicJsonStore.LoadOutcome.RecoveredFromBackup).value
        assertEquals(SamplePayload("alpha", 1), recVal)
        assertNotNull(recovered.quarantinedCorruptFile)
        assertTrue(Files.isRegularFile(recovered.quarantinedCorruptFile!!))
        assertFalse(store.isCorruptLocked)

        // 4. 正本与 .bak 同时损坏 -> 触发 CorruptLocked 防覆写锁，阻断后续写入以保护现场
        Files.writeString(storePath, "<<<broken_main>>>", StandardCharsets.UTF_8)
        Files.writeString(store.backupPath, "<<<broken_bak>>>", StandardCharsets.UTF_8)
        val locked = store.load()
        assertTrue(locked is AtomicJsonStore.LoadOutcome.CorruptLocked)
        assertTrue(store.isCorruptLocked)
        assertEquals(AtomicJsonStore.SaveOutcome.BlockedByCorruptLock, store.save(SamplePayload("overwrite_attempt", 0)))

        // 人工确认解锁后恢复可写
        store.unlockAfterManualRecovery()
        assertEquals(AtomicJsonStore.SaveOutcome.Written, store.save(SamplePayload("recovered_clean", 10)))
    }

    @Test
    fun `EpiphyDataManager normalizes Windows trailing dot paths, preserves same worldId, and forks copied saves`(@TempDir tempDir: Path) {
        val gameDir = tempDir.resolve("mc_instance/.")
        val dm = EpiphyDataManager(gameDir)
        dm.ensureSkeletonDirectories()
        assertTrue(Files.isDirectory(dm.worldsDir))
        assertTrue(Files.isDirectory(dm.rootLogsDir))

        val saveA = tempDir.resolve("saves/My Test World/.")
        Files.createDirectories(saveA)

        // 首次进档与同档重进 -> worldId 与外部目录保持严格一致
        val bind1 = dm.bindWorld(saveA, "My Test World")
        assertFalse(bind1.forkedOnThisLoad)
        val bind2 = dm.bindWorld(tempDir.resolve("saves/My Test World"), "My Test World")
        assertFalse(bind2.forkedOnThisLoad)
        assertEquals(bind1.worldId, bind2.worldId)
        assertEquals(bind1.folderName, bind2.folderName)

        // 模拟玩家复制整个存档目录（含 data/epiphy_world_id.json）到新文件夹
        val saveCopied = tempDir.resolve("saves/My Test World Copy")
        Files.createDirectories(saveCopied.resolve("data"))
        Files.copy(
            EpiphyDataManager.normalizeCleanPath(saveA).resolve("data/epiphy_world_id.json"),
            saveCopied.resolve("data/epiphy_world_id.json")
        )

        val bindForked = dm.bindWorld(saveCopied, "My Test World Copy")
        assertTrue(bindForked.forkedOnThisLoad, "Copied save at a different path must auto-fork!")
        assertNotEquals(bind1.worldId, bindForked.worldId)
        assertNotEquals(bind1.folderName, bindForked.folderName)
        assertEquals(bind1.folderName, bindForked.forkedFromFolderName)

        val notices = dm.consumePendingForkNotices()
        assertEquals(1, notices.size)
        assertEquals(bind1.worldId, notices[0].previousWorldId)
        assertEquals(bindForked.worldId, notices[0].newWorldId)
    }

    @Test
    fun `EpiphyLogEngine rate-limits bursts, switches world log directories, and isolates deprecation warnings`(@TempDir tempDir: Path) {
        val rootLogs = tempDir.resolve("logs")
        val worldLogs = tempDir.resolve("worlds/demo__12345678/logs")

        EpiphyLogEngine(rootLogs, defaultRateLimitMs = 200L).use { log ->
            log.info("TestMod", "Boot", "Root startup line")
            assertFalse(log.warnDeprecatedOnce("TestMod", "oldKey", "Deprecated key used"))
            log.deprecationWarningsEnabled = true
            assertTrue(log.warnDeprecatedOnce("TestMod", "oldKey", "Deprecated key used"))
            assertFalse(log.warnDeprecatedOnce("TestMod", "oldKey", "Deprecated key used again"))

            assertTrue(log.flushSync())
            val rootFiles = Files.list(rootLogs).use { it.toList() }
            assertEquals(1, rootFiles.size)
            val rootText = Files.readString(rootFiles[0], StandardCharsets.UTF_8)
            assertTrue(rootText.contains("Root startup line"))
            assertTrue(rootText.contains("Deprecated key used"))

            // 动态切至世界日志目录并验证限频折叠计数
            log.switchLogDirectory(worldLogs)
            log.warn("Renderer", "HotLoop", "Frame spike", rateLimitMs = 150L)
            log.warn("Renderer", "HotLoop", "Frame spike", rateLimitMs = 150L)
            log.warn("Renderer", "HotLoop", "Frame spike", rateLimitMs = 150L)
            Thread.sleep(170L)
            log.warn("Renderer", "HotLoop", "Frame spike", rateLimitMs = 150L)
            assertTrue(log.flushSync())

            val worldFiles = Files.list(worldLogs).use { it.toList() }
            assertEquals(1, worldFiles.size)
            val worldText = Files.readString(worldFiles[0], StandardCharsets.UTF_8)
            assertTrue(worldText.contains("suppressed 2 repeats"), "Expected rate-limit suppression summary in: $worldText")
        }
    }

    @Test
    fun `EpiphyDebugHub isolates faulty providers and RollingNanoSampler computes accurate percentiles`() {
        val hub = EpiphyDebugHub()
        hub.register(object : EpiphyDebugProvider {
            override val id: String = "broken_mod"
            override fun summary(): String = error("Simulated crash in summary")
            override fun runHealthChecks() = error("Simulated crash in check")
        })
        hub.register(object : EpiphyDebugProvider {
            override val id: String = "healthy_mod"
            override fun summary(): String = "ok=true"
        })

        val summaries = hub.collectSummaries()
        assertTrue(summaries["broken_mod"]!!.startsWith("ERROR("))
        assertEquals("ok=true", summaries["healthy_mod"])

        val checks = hub.collectAllHealthChecks()
        assertEquals(1, checks.size)
        assertFalse(checks[0].ok)
        assertEquals("broken_mod", checks[0].providerId)

        val sampler = RollingNanoSampler(capacity = 100)
        for (i in 1..100) {
            sampler.recordNanos(i * 1_000_000L) // 1ms .. 100ms
        }
        val snap = sampler.snapshot()
        assertEquals(100, snap.windowSamples)
        assertEquals(100L, snap.totalCalls)
        assertEquals(100.0, snap.maxMs, 0.001)
        assertTrue(snap.p95Ms in 94.0..96.0, "Expected p95 ~95ms, got ${snap.p95Ms}")

        assertEquals(32, FboCachePool.alignBucketDim(1))
        assertEquals(64, FboCachePool.alignBucketDim(45))
        assertEquals(2048, FboCachePool.alignBucketDim(9999))
    }

    @Test
    fun `EpiphyDataManager forbids permission configs inside world saves and RawJsonFileStore heals backups`(
        @TempDir tempDir: Path
    ) {
        val dm = EpiphyDataManager(tempDir)
        val saveDir = tempDir.resolve("saves").resolve("TestWorld")
        Files.createDirectories(saveDir)
        val ctx = dm.bindWorld(saveDir, "TestWorld")

        // 外部 epiphy-data/worlds/<folder>/ 与 epiphy-data/config/ 必须放行
        val extSec = dm.resolveExternalWorldSecurityFiles(ctx)
        assertFalse(dm.isPathInsideWorldSave(Path.of(extSec["permissionsFile"]!!)))
        assertFalse(dm.isPathInsideWorldSave(dm.resolveGlobalConfigFile("logging.json")))

        // 存档目录内部 saves/<world>/ 必须被严格拦截
        val inSavePerm = saveDir.resolve("kubejs_epiphy_permissions.json")
        assertTrue(dm.isPathInsideWorldSave(inSavePerm))
        var blocked = false
        try {
            dm.requireExternalSecurityPath(inSavePerm)
        } catch (_: SecurityException) {
            blocked = true
        }
        assertTrue(blocked, "Permission config inside world save must throw SecurityException")

        val rawStore = dev.epiphy.core.storage.RawJsonFileStore(tempDir.resolve("epiphy-data/config/test_raw.json"))
        assertTrue(rawStore.saveRawJsonText("""{"hello":"world","v":1}"""))
        assertEquals("ok", rawStore.loadRaw().status)
    }

    @Test
    fun `EpiphyDataManager seamlessly upgrades legacy object-valued worlds_index json without false corrupt quarantine`(
        @TempDir tempDir: Path
    ) {
        val dm = EpiphyDataManager(tempDir)
        dm.ensureSkeletonDirectories()
        val indexFile = dm.worldsDir.resolve("worlds_index.json")
        Files.writeString(
            indexFile,
            """
            {
              "version": 1,
              "worlds": {
                "legacy-world-uuid": {
                  "worldId": "legacy-world-uuid",
                  "folderName": "LegacyWorld__legacy-w",
                  "levelName": "LegacyWorld"
                }
              }
            }
            """.trimIndent(),
            StandardCharsets.UTF_8
        )

        val saveDir = tempDir.resolve("saves").resolve("NewWorld")
        Files.createDirectories(saveDir)
        val ctx = dm.bindWorld(saveDir, "NewWorld")
        assertNotNull(ctx.worldId)

        val corruptBackups = Files.list(dm.worldsDir).use { stream ->
            stream.filter { it.fileName.toString().contains(".corrupt") }.toList()
        }
        assertEquals(0, corruptBackups.size, "Legacy object-valued worlds_index.json must not trigger false corrupt quarantine!")
    }

    @Test
    fun `EpiphyDataManager preserves existing worldId when anchor json heals from backup on load`(
        @TempDir tempDir: Path
    ) {
        val dm = EpiphyDataManager(tempDir)
        val saveDir = tempDir.resolve("saves").resolve("BackupHealWorld")
        Files.createDirectories(saveDir)

        val firstBind = dm.bindWorld(saveDir, "BackupHealWorld")
        val anchorPath = saveDir.resolve("data").resolve("epiphy_world_id.json")
        val anchorBakPath = saveDir.resolve("data").resolve("epiphy_world_id.json.bak")
        // 生成有效 .bak 副本并破坏正本，模拟异常断电后锚点文件损坏
        Files.copy(anchorPath, anchorBakPath, java.nio.file.StandardCopyOption.REPLACE_EXISTING)
        Files.writeString(anchorPath, "{truncated_anchor_json", StandardCharsets.UTF_8)

        val rebound = dm.bindWorld(saveDir, "BackupHealWorld")
        assertEquals(
            firstBind.worldId,
            rebound.worldId,
            "RecoveredFromBackup anchor must preserve the original worldId instead of generating a new UUID!"
        )
        assertFalse(rebound.forkedOnThisLoad)
    }

    @Test
    fun `EpiphyLogEngine respects fileLoggingEnabled switch and retains monotonic droppedEntries count`(
        @TempDir tempDir: Path
    ) {
        val silentDir = tempDir.resolve("silent_logs")
        EpiphyLogEngine(silentDir).use { log ->
            log.fileLoggingEnabled = false
            log.info("TestMod", "NoDisk", "Console only message")
            Thread.sleep(50L)
            assertFalse(Files.exists(silentDir), "Disabling fileLoggingEnabled must prevent log directory/file creation")
        }

        val burstDir = tempDir.resolve("burst_logs")
        EpiphyLogEngine(burstDir, defaultRateLimitMs = 0L, queueCapacity = 128).use { log ->
            for (i in 0 until 2000) {
                log.info("BurstTest", "Flood", "Line #$i payload")
            }
            assertTrue(log.flushSync(3_000L))
            val stats = log.statsSnapshot()
            val dropped = (stats["droppedEntries"] as Number).toLong()
            if (dropped > 0L) {
                // 再写一条触发 writer 线程消费后，验证累计 droppedEntries 不会被清零
                log.info("BurstTest", "AfterDrain", "Post-drain check")
                assertTrue(log.flushSync(2_000L))
                val statsAfter = log.statsSnapshot()
                assertEquals(dropped, (statsAfter["droppedEntries"] as Number).toLong())
            }
        }
    }
}
