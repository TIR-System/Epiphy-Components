// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.client.debug

import com.mojang.blaze3d.platform.GlUtil
import com.mojang.blaze3d.systems.RenderSystem
import dev.epiphy.client.fx3d.item.NativeItem3DEngine
import dev.epiphy.client.surface2d.text.NativeTextBatchEngine
import dev.epiphy.core.EpiphyRuntime
import dev.epiphy.core.config.EpiphyConfig
import dev.epiphy.core.debug.EpiphyDebugProvider
import dev.epiphy.core.debug.RollingNanoSampler
import dev.epiphy.core.storage.AtomicJsonStore
import net.minecraft.client.Minecraft
import net.minecraftforge.fml.ModList
import java.nio.file.Path
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.concurrent.atomic.AtomicLong

/**
 * 客户端渲染提交段帧耗时遥测采样与五元组基准报告导出器（对齐迁移计划书 §7.2 测量协议）。
 *
 * 工作机制：
 * 1. 当启用 `EpiphyConfig.debugPerfSamplingEnabled` 时，在每帧 `RenderTickEvent.Phase.END` 计算本帧新增的文字合批与物品 3D 提交段耗时（纳秒），写入 512 帧滑动窗口 [RollingNanoSampler]；
 * 2. 导出报告时一并采集测量五元组：
 *    - 计时口径：CPU 提交段 `System.nanoTime()`（512 帧滑动窗口 P50 / P95 / Max）；
 *    - 分辨率与缩放：当前窗口帧缓冲宽高与 `guiScale`；
 *    - 光影管线状态：探测 `oculus` / `iris` 是否加载；
 *    - 负载规模：窗口活跃帧数、累计提交字形 Quad 数、图集分桶刷新次数、3D 物品手持/GUI 绘制次数与局部缓冲冲洗次数；
 *    - 硬件与驱动基线：OpenGL Renderer、OpenGL Version、CPU 描述与 JVM 版本。
 *
 * 已知边界：
 * - 采样值为 CPU 侧顶点构建与缓冲提交段耗时，不包含驱动异步命令队列在 GPU 侧的光栅化执行耗时；若单帧未发生某子系统绘制（新增调用数为 0），该空闲帧不计入对应子系统的有效负载分位数窗口。
 */
object EpiphyRenderPerfReporter : EpiphyDebugProvider {

    override val id: String = "client_render_perf"
    override val label: String = "Epiphy Client Render Telemetry (5-Tuple)"
    override val order: Int = 40

    private val textFrameSampler = RollingNanoSampler(capacity = 512)
    private val item3DFrameSampler = RollingNanoSampler(capacity = 512)
    private val sampledFramesTotal = AtomicLong(0L)

    private var prevTextFrames: Long = 0L
    private var prevTextNanos: Long = 0L
    private var prevItemCalls: Long = 0L
    private var prevItemNanos: Long = 0L
    private var autoExportCounter: Int = 0

    private val TIME_FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")

    fun registerToDebugHub() {
        runCatching {
            EpiphyRuntime.ensureInitialized()
            EpiphyRuntime.debugHub.register(this)
        }
    }

    fun resetSamplers() {
        textFrameSampler.reset()
        item3DFrameSampler.reset()
        sampledFramesTotal.set(0L)
        prevTextFrames = (NativeTextBatchEngine.INSTANCE.collectStats()["framesRendered"] as? Number)?.toLong() ?: 0L
        prevTextNanos = 0L
        prevItemCalls = ((NativeItem3DEngine.collectStats()["runtime"] as? Map<*, *>)?.get("renderCalls") as? Number)?.toLong() ?: 0L
        prevItemNanos = 0L
    }

    fun onRenderFrameEnd() {
        if (!EpiphyConfig.debugPerfSamplingEnabled) return
        sampledFramesTotal.incrementAndGet()

        val textStats = NativeTextBatchEngine.INSTANCE.collectStats()
        val curTextFrames = (textStats["framesRendered"] as? Number)?.toLong() ?: 0L
        val curTextLastUs = (textStats["lastRenderUs"] as? Number)?.toLong() ?: 0L
        if (curTextFrames > prevTextFrames) {
            val deltaCalls = curTextFrames - prevTextFrames
            prevTextFrames = curTextFrames
            // 若当帧渲染了 N 条逐字文本，记录单帧内估算提交段耗时
            val estFrameNanos = (curTextLastUs * 1_000L * deltaCalls).coerceAtLeast(0L)
            textFrameSampler.recordNanos(estFrameNanos)
        }

        val itemStats = NativeItem3DEngine.collectStats()
        val itemRt = itemStats["runtime"] as? Map<*, *>
        val curItemCalls = (itemRt?.get("renderCalls") as? Number)?.toLong() ?: 0L
        val curItemLastUs = (itemRt?.get("lastRenderUs") as? Number)?.toLong() ?: 0L
        if (curItemCalls > prevItemCalls) {
            val deltaItemCalls = curItemCalls - prevItemCalls
            prevItemCalls = curItemCalls
            val estItemFrameNanos = (curItemLastUs * 1_000L * deltaItemCalls).coerceAtLeast(0L)
            item3DFrameSampler.recordNanos(estItemFrameNanos)
        }

        autoExportCounter++
        if (autoExportCounter >= 1200) {
            autoExportCounter = 0
            runCatching { exportMarkdownReport() }
        }
    }

    override fun summary(): String {
        val txt = textFrameSampler.snapshot()
        val i3d = item3DFrameSampler.snapshot()
        return "sampling=${EpiphyConfig.debugPerfSamplingEnabled} | textSubmit(p50=${fmtMs(txt.p50Ms)}ms, p95=${fmtMs(txt.p95Ms)}ms, n=${txt.windowSamples}) | item3dSubmit(p50=${fmtMs(i3d.p50Ms)}ms, p95=${fmtMs(i3d.p95Ms)}ms, n=${i3d.windowSamples})"
    }

    override fun metrics(): Map<String, Any?> {
        val env = collectEnvironmentTuple()
        val txt = textFrameSampler.snapshot()
        val i3d = item3DFrameSampler.snapshot()
        return linkedMapOf(
            "fiveTupleEnvironment" to env,
            "textBatchSubmitMs" to mapOf(
                "windowSamples" to txt.windowSamples,
                "p50Ms" to txt.p50Ms,
                "p95Ms" to txt.p95Ms,
                "p99Ms" to txt.p99Ms,
                "maxMs" to txt.maxMs,
                "avgMs" to txt.avgMs
            ),
            "item3DSubmitMs" to mapOf(
                "windowSamples" to i3d.windowSamples,
                "p50Ms" to i3d.p50Ms,
                "p95Ms" to i3d.p95Ms,
                "p99Ms" to i3d.p99Ms,
                "maxMs" to i3d.maxMs,
                "avgMs" to i3d.avgMs
            ),
            "textEngineCounters" to NativeTextBatchEngine.INSTANCE.collectStats(),
            "item3DCounters" to NativeItem3DEngine.collectStats()
        )
    }

    fun collectEnvironmentTuple(): Map<String, Any?> {
        val mc = runCatching { Minecraft.getInstance() }.getOrNull()
        val win = mc?.window
        val resStr = if (win != null) {
            "${win.width}x${win.height} (scaled ${win.guiScaledWidth}x${win.guiScaledHeight}, guiScale=${win.guiScale})"
        } else {
            "headless"
        }
        val modList = runCatching { ModList.get() }.getOrNull()
        val oculusLoaded = modList?.isLoaded("oculus") == true
        val irisLoaded = modList?.isLoaded("iris") == true
        val modernUiLoaded = modList?.isLoaded("modernui") == true
        val embeddiumLoaded = modList?.isLoaded("embeddium") == true

        val glRenderer = if (RenderSystem.isOnRenderThread()) {
            runCatching { GlUtil.getRenderer() }.getOrDefault("unknown")
        } else {
            "non-render-thread"
        }
        val glVersion = if (RenderSystem.isOnRenderThread()) {
            runCatching { GlUtil.getOpenGLVersion() }.getOrDefault("unknown")
        } else {
            "non-render-thread"
        }
        val cpuInfo = runCatching { GlUtil.getCpuInfo() }.getOrDefault("unknown")

        return linkedMapOf(
            "timingMethod" to "CPU submit span via System.nanoTime() (512-frame rolling window)",
            "resolutionAndGuiScale" to resStr,
            "shaderAndRenderMods" to "oculus=$oculusLoaded, iris=$irisLoaded, embeddium=$embeddiumLoaded, modernui=$modernUiLoaded",
            "gpuRenderer" to glRenderer,
            "openGlVersion" to glVersion,
            "cpuInfo" to cpuInfo,
            "jvmVersion" to System.getProperty("java.version", "unknown")
        )
    }

    fun exportMarkdownReport(): Path {
        EpiphyRuntime.ensureInitialized()
        val env = collectEnvironmentTuple()
        val txtSnap = textFrameSampler.snapshot()
        val i3dSnap = item3DFrameSampler.snapshot()
        val txtCounters = NativeTextBatchEngine.INSTANCE.collectStats()
        val i3dCounters = NativeItem3DEngine.collectStats()
        val i3dRt = i3dCounters["runtime"] as? Map<*, *> ?: emptyMap<Any?, Any?>()
        val nowStr = TIME_FMT.format(Instant.now().atZone(ZoneId.systemDefault()))

        val md = buildString {
            appendLine("# Epiphy Client Render Performance Report (5-Tuple Protocol)")
            appendLine()
            appendLine("- **Generated At**: `$nowStr`")
            appendLine("- **Sampling Active**: `${EpiphyConfig.debugPerfSamplingEnabled}` (Total sampled frames: `${sampledFramesTotal.get()}`)")
            appendLine()
            appendLine("## 1. Measurement 5-Tuple Context")
            appendLine("| Dimension | Value |")
            appendLine("| :--- | :--- |")
            appendLine("| **1. Timing Scope** | `${env["timingMethod"]}` |")
            appendLine("| **2. Resolution & GUI Scale** | `${env["resolutionAndGuiScale"]}` |")
            appendLine("| **3. Shader / Render Mods** | `${env["shaderAndRenderMods"]}` |")
            appendLine("| **4. Workload Counters** | `textFrames=${txtCounters["framesRendered"]}, quads=${txtCounters["quadsSubmitted"]}, bucketFlushes=${txtCounters["bucketFlushes"]}; item3dCalls=${i3dRt["renderCalls"]} (hand=${i3dRt["handCalls"]}, gui=${i3dRt["guiCalls"]}, isoFlushes=${i3dRt["isolatedFlushes"]})` |")
            appendLine("| **5. Hardware & Driver** | `GPU=${env["gpuRenderer"]} | GL=${env["openGlVersion"]} | CPU=${env["cpuInfo"]} | JVM=${env["jvmVersion"]}` |")
            appendLine()
            appendLine("## 2. Rolling Window Latency Distribution (Active Frames Only)")
            appendLine("| Subsystem | Window Samples | Avg (ms) | P50 (ms) | P95 (ms) | P99 (ms) | Max (ms) |")
            appendLine("| :--- | ---: | ---: | ---: | ---: | ---: | ---: |")
            appendLine("| `NativeTextBatchEngine` (CPU Submit) | ${txtSnap.windowSamples} | ${fmtMs(txtSnap.avgMs)} | ${fmtMs(txtSnap.p50Ms)} | ${fmtMs(txtSnap.p95Ms)} | ${fmtMs(txtSnap.p99Ms)} | ${fmtMs(txtSnap.maxMs)} |")
            appendLine("| `NativeItem3DEngine` (CPU Submit) | ${i3dSnap.windowSamples} | ${fmtMs(i3dSnap.avgMs)} | ${fmtMs(i3dSnap.p50Ms)} | ${fmtMs(i3dSnap.p95Ms)} | ${fmtMs(i3dSnap.p99Ms)} | ${fmtMs(i3dSnap.maxMs)} |")
        }

        val outDir = EpiphyRuntime.dataManager.activeWorldContext?.worldLogsDir ?: EpiphyRuntime.dataManager.rootLogsDir
        val outPath = outDir.resolve("render-perf-report.md")
        AtomicJsonStore.writeRawStringAtomically(outPath, md, rotateBackup = false)
        return outPath
    }

    private fun fmtMs(v: Double): String = String.format(java.util.Locale.ROOT, "%.3f", v)
}
