// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.core

import dev.epiphy.core.debug.EpiphyDebugHub
import dev.epiphy.core.debug.EpiphyDebugProvider
import dev.epiphy.core.debug.HealthCheckItem
import dev.epiphy.core.log.EpiphyLogEngine
import dev.epiphy.core.storage.EpiphyDataManager
import net.minecraft.server.MinecraftServer
import net.minecraft.world.level.storage.LevelResource
import net.minecraftforge.fml.loading.FMLPaths
import java.nio.file.Path

/**
 * Epiphy 原生基础设施运行时总管（统一串联 `EpiphyDataManager`、`EpiphyLogEngine` 与 `EpiphyDebugHub`）。
 */
object EpiphyRuntime {

    @Volatile
    private var initialized = false

    lateinit var dataManager: EpiphyDataManager
        private set

    lateinit var logEngine: EpiphyLogEngine
        private set

    val debugHub: EpiphyDebugHub = EpiphyDebugHub()

    @Synchronized
    fun ensureInitialized(customGameDir: Path? = null) {
        if (initialized) return
        val gameDir = customGameDir ?: runCatching { FMLPaths.GAMEDIR.get() }.getOrElse { Path.of(".") }
        dataManager = EpiphyDataManager(gameDir)
        dataManager.ensureSkeletonDirectories()
        logEngine = EpiphyLogEngine(dataManager.rootLogsDir)

        debugHub.register(object : EpiphyDebugProvider {
            override val id: String = "core"
            override val label: String = "Epiphy Native Core Infrastructure"
            override val order: Int = 10

            override fun summary(): String {
                val world = dataManager.activeWorldContext?.folderName ?: "<unbound>"
                val stats = logEngine.statsSnapshot()
                return "world=$world | logWritten=${stats["writtenLines"]} | logDropped=${stats["droppedEntries"]}"
            }

            override fun metrics(): Map<String, Any?> =
                debugHub.collectJvmMemoryMetrics() + logEngine.statsSnapshot()

            override fun runHealthChecks(): List<HealthCheckItem> {
                val logStats = logEngine.statsSnapshot()
                val dropped = (logStats["droppedEntries"] as? Number)?.toLong() ?: 0L
                return listOf(
                    HealthCheckItem(
                        providerId = "core",
                        checkName = "async_log_backpressure",
                        ok = dropped == 0L,
                        detail = "droppedLogEntries=$dropped"
                    )
                )
            }
        })

        Runtime.getRuntime().addShutdownHook(Thread({
            runCatching { logEngine.close() }
        }, "Epiphy-LogShutdownHook"))

        initialized = true
        logEngine.info("EpiphyCore", "Bootstrap", "Initialized epiphy-data root at ${dataManager.dataRoot}")
    }

    @Synchronized
    fun onServerStarting(server: MinecraftServer) {
        ensureInitialized()
        val worldRoot = server.getWorldPath(LevelResource.ROOT)
        val levelName = runCatching { server.worldData.levelName }.getOrNull()
        val ctx = dataManager.bindWorld(worldRoot, levelName)
        logEngine.switchLogDirectory(ctx.worldLogsDir)
        if (ctx.forkedOnThisLoad) {
            logEngine.warn(
                "EpiphyCore",
                "WorldFork",
                "Detected copied world save! Auto-forked external directory '${ctx.forkedFromFolderName}' -> '${ctx.folderName}'",
                rateLimitMs = 0L
            )
        } else {
            logEngine.info("EpiphyCore", "WorldBind", "Bound world context '${ctx.folderName}' (${ctx.saveRootPath})")
        }
    }

    @Synchronized
    fun onServerStopped() {
        if (!initialized) return
        val prev = dataManager.activeWorldContext?.folderName
        dataManager.unbindWorld()
        logEngine.resetToRootDirectory()
        logEngine.flushSync(1_000L)
        if (prev != null) {
            logEngine.info("EpiphyCore", "WorldUnbind", "Unbound world '$prev'; switched logs back to root directory.")
        }
    }
}
