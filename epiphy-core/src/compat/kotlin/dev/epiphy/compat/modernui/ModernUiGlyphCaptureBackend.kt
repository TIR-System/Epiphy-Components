// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.compat.modernui

import com.mojang.logging.LogUtils
import dev.epiphy.client.compat.EpiphyClientCompatModule
import dev.epiphy.client.surface2d.text.GlyphCaptureBackend
import dev.epiphy.client.surface2d.text.NativeTextBatchEngine
import dev.epiphy.client.util.RenderFaultCircuitBreaker
import icyllis.modernui.mc.text.ModernTextRenderer
import icyllis.modernui.mc.text.TextLayout
import icyllis.modernui.mc.text.TextLayoutEngine
import net.minecraft.client.gui.Font
import net.minecraft.client.renderer.MultiBufferSource
import net.minecraftforge.fml.ModList
import org.joml.Matrix4f
import java.lang.invoke.MethodHandle
import java.lang.invoke.MethodHandles
import java.lang.invoke.MethodType
import java.util.concurrent.atomic.AtomicInteger

/**
 * ModernUI 可选软兼容字形网格捕获后端（位于 `src/compat`，通过 [ModernUiClientCompatModule] `ServiceLoader` SPI 在客户端启动时按需启用）。
 *
 * 版本适配与行为：
 * - ModernUI `3.8 ~ 3.9` 的 `TextLayout.drawText` 为 13 参数，而 `3.10.1+ ~ 3.12+` 为 14 参数（增加了 `float density`）；
 * - 初始化阶段通过 `MethodHandles.publicLookup()` 探测两个公开方法签名，匹配其一后用于捕获字形 Quad；
 * - 使用单参数 `TextLayoutEngine.lookupVanillaLayout(rawText)` 解析含 `§` 样式的文本并重置 `TextLayout` 内部保活计时器（`mTimer = 0`）；
 * - 含彩色 Emoji 或用户在 ModernUI 设置中关闭 `sAllowSDFTextIn2D` 的片段走常规纹理采样（`preferredMode = 0`），其余旋转、缩放或描边片段启用 SDF 矢量距离场模式（`preferredMode = 1`）。
 *
 * 已知边界：
 * - 依赖 `icyllis.modernui.mc.text.TextLayoutEngine`、`ModernTextRenderer` 与 `TextLayout` 的公开方法签名；若未来大版本移除上述签名或运行期调用异常，会将 `degraded` 置为 `true` 并回退至原版 `Font` 字形捕获。
 */
object ModernUiGlyphCaptureBackend : GlyphCaptureBackend {

    private val LOGGER = LogUtils.getLogger()
    private const val FULL_BRIGHT_LIGHT = 15728880

    private val identityMat = Matrix4f()
    private val epochCounter = AtomicInteger(1)
    @Volatile private var lastEngineRef: Any? = null
    @Volatile private var lastResLevel: Int = -1
    @Volatile private var degraded: Boolean = false

    // 14 参数签名 (ModernUI 3.10.1+ / 3.12.x)
    private val drawText14Handle: MethodHandle?
    // 13 参数签名 (ModernUI 3.8.x / 3.9.x)
    private val drawText13Handle: MethodHandle?
    // ModernUI 3.10+ 可选 getResLevel() 探测句柄
    private val getResLevelHandle: MethodHandle?

    init {
        val lookup = MethodHandles.publicLookup()
        drawText14Handle = runCatching {
            lookup.findVirtual(
                TextLayout::class.java,
                "drawText",
                MethodType.methodType(
                    Float::class.javaPrimitiveType,
                    Matrix4f::class.java,
                    MultiBufferSource::class.java,
                    Float::class.javaPrimitiveType,
                    Float::class.javaPrimitiveType,
                    Int::class.javaPrimitiveType,
                    Int::class.javaPrimitiveType,
                    Int::class.javaPrimitiveType,
                    Int::class.javaPrimitiveType,
                    Boolean::class.javaPrimitiveType,
                    Int::class.javaPrimitiveType,
                    Boolean::class.javaPrimitiveType,
                    Float::class.javaPrimitiveType,
                    Int::class.javaPrimitiveType,
                    Int::class.javaPrimitiveType
                )
            )
        }.getOrNull()

        drawText13Handle = if (drawText14Handle == null) {
            runCatching {
                lookup.findVirtual(
                    TextLayout::class.java,
                    "drawText",
                    MethodType.methodType(
                        Float::class.javaPrimitiveType,
                        Matrix4f::class.java,
                        MultiBufferSource::class.java,
                        Float::class.javaPrimitiveType,
                        Float::class.javaPrimitiveType,
                        Int::class.javaPrimitiveType,
                        Int::class.javaPrimitiveType,
                        Int::class.javaPrimitiveType,
                        Int::class.javaPrimitiveType,
                        Boolean::class.javaPrimitiveType,
                        Int::class.javaPrimitiveType,
                        Boolean::class.javaPrimitiveType,
                        Int::class.javaPrimitiveType,
                        Int::class.javaPrimitiveType
                    )
                )
            }.getOrNull()
        } else {
            null
        }

        getResLevelHandle = runCatching {
            lookup.findVirtual(
                TextLayoutEngine::class.java,
                "getResLevel",
                MethodType.methodType(Int::class.javaPrimitiveType)
            )
        }.getOrNull()
    }

    @JvmStatic
    fun tryInstall(): Boolean {
        if (drawText14Handle == null && drawText13Handle == null) {
            LOGGER.info("[EpiphyCompat] ModernUI detected, but TextLayout.drawText signature was not matched; using vanilla Font glyph capture.")
            return false
        }
        degraded = false
        NativeTextBatchEngine.INSTANCE.optionalBackend = this
        LOGGER.info(
            "[EpiphyCompat] Installed ModernUI SDF glyph capture backend via SPI (arity={}).",
            if (drawText14Handle != null) 14 else 13
        )
        return true
    }

    override fun currentEpoch(): Int {
        if (degraded) return -1
        return runCatching {
            val engine = TextLayoutEngine.getInstance() ?: return -1
            val resLvl = getResLevelHandle?.let { h -> (h.invokeExact(engine) as Int) } ?: 0
            if (engine !== lastEngineRef || resLvl != lastResLevel) {
                lastEngineRef = engine
                lastResLevel = resLvl
                epochCounter.incrementAndGet()
            } else {
                epochCounter.get()
            }
        }.getOrDefault(-1)
    }

    override fun captureGlyphs(
        font: Font?,
        rawText: String,
        seeThrough: Boolean,
        preferSdf: Boolean,
        capturer: MultiBufferSource,
        sentinelR: Int,
        sentinelG: Int,
        sentinelB: Int
    ): Boolean {
        if (degraded || rawText.isEmpty()) return false
        val h14 = drawText14Handle
        val h13 = drawText13Handle
        if (h14 == null && h13 == null) return false

        return try {
            val engine = TextLayoutEngine.getInstance() ?: return false
            val layout = engine.lookupVanillaLayout(rawText) ?: return false
            val allowSdf2d = runCatching { ModernTextRenderer.sAllowSDFTextIn2D }.getOrDefault(true)
            val mode = if (preferSdf && allowSdf2d && !layout.hasColorEmoji()) 1 else 0
            if (h14 != null) {
                h14.invokeExact(
                    layout,
                    identityMat,
                    capturer,
                    0.0f,
                    0.0f,
                    sentinelR,
                    sentinelG,
                    sentinelB,
                    255,
                    false,
                    mode,
                    seeThrough,
                    1.0f,
                    0,
                    FULL_BRIGHT_LIGHT
                ) as Float
            } else if (h13 != null) {
                h13.invokeExact(
                    layout,
                    identityMat,
                    capturer,
                    0.0f,
                    0.0f,
                    sentinelR,
                    sentinelG,
                    sentinelB,
                    255,
                    false,
                    mode,
                    seeThrough,
                    0,
                    FULL_BRIGHT_LIGHT
                ) as Float
            }
            true
        } catch (err: Throwable) {
            RenderFaultCircuitBreaker.rethrowIfFatalJvmError(err)
            degraded = true
            LOGGER.warn("[EpiphyCompat] ModernUI glyph capture degraded cleanly to vanilla Font: {}", err.toString())
            false
        }
    }
}

/**
 * 客户端 `ServiceLoader` SPI 注册入口：自身签名不含任何 `icyllis.modernui.*` 类型，未安装 ModernUI 时安全跳过。
 */
class ModernUiClientCompatModule : EpiphyClientCompatModule {
    override val id: String = "modernui"

    override fun onClientSetup() {
        if (!ModList.get().isLoaded("modernui")) return
        ModernUiGlyphCaptureBackend.tryInstall()
    }
}
