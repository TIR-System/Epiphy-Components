// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.compat.modernui

import com.mojang.logging.LogUtils
import dev.epiphy.EpiphyMod
import dev.epiphy.client.surface2d.text.GlyphCaptureBackend
import dev.epiphy.client.surface2d.text.NativeTextBatchEngine
import dev.epiphy.client.util.RenderFaultCircuitBreaker
import icyllis.modernui.mc.text.TextLayout
import icyllis.modernui.mc.text.TextLayoutEngine
import net.minecraft.client.gui.Font
import net.minecraft.client.renderer.MultiBufferSource
import net.minecraft.network.chat.Style
import net.minecraftforge.api.distmarker.Dist
import net.minecraftforge.eventbus.api.SubscribeEvent
import net.minecraftforge.fml.ModList
import net.minecraftforge.fml.common.Mod
import net.minecraftforge.fml.event.lifecycle.FMLClientSetupEvent
import org.joml.Matrix4f
import java.lang.invoke.MethodHandle
import java.lang.invoke.MethodHandles
import java.lang.invoke.MethodType
import java.util.concurrent.atomic.AtomicInteger

/**
 * ModernUI 可选软兼容字形网格捕获后端（位于 `src/compat`，仅在运行环境加载了 `modernui` 时启用）。
 *
 * 版本适配与行为：
 * - ModernUI `3.8 ~ 3.9` 的 `TextLayout.drawText` 为 13 参数，而 `3.10.1+ ~ 3.12+` 为 14 参数（增加了 `float density`）；
 * - 初始化阶段通过 `MethodHandles.publicLookup()` 探测两个公开方法签名，匹配其一后用于捕获字形 Quad；
 * - 含彩色 Emoji 的文本片段走常规纹理采样（`preferredMode = 0`），避免按单通道 SDF 距离场采样导致彩色贴图偏色；其余需要缩放、旋转或描边的片段请求 SDF 模式（`preferredMode = 1`）。
 *
 * 已知边界：
 * - 依赖 `icyllis.modernui.mc.text.TextLayoutEngine` 与 `TextLayout` 的上述公开签名；若更高版本调整了参数列表或运行期抛出异常，当前后端会将 `degraded` 置为 `true` 并回退至原版 `Font` 字形捕获。
 */
object ModernUiGlyphCaptureBackend : GlyphCaptureBackend {

    private val LOGGER = LogUtils.getLogger()
    private const val FULL_BRIGHT_LIGHT = 15728880

    private val identityMat = Matrix4f()
    private val epochCounter = AtomicInteger(1)
    @Volatile private var lastEngineRef: Any? = null
    @Volatile private var degraded: Boolean = false

    // 14 参数签名 (ModernUI 3.10.1+ / 3.12.x)
    private val drawText14Handle: MethodHandle?
    // 13 参数签名 (ModernUI 3.8.x / 3.9.x)
    private val drawText13Handle: MethodHandle?

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
    }

    @JvmStatic
    fun tryInstall() {
        if (drawText14Handle == null && drawText13Handle == null) {
            LOGGER.info("[EpiphyCompat] ModernUI detected, but TextLayout.drawText signature was not matched; using vanilla Font glyph capture.")
            return
        }
        NativeTextBatchEngine.INSTANCE.optionalBackend = this
        LOGGER.info(
            "[EpiphyCompat] Installed ModernUI SDF glyph capture backend (arity={}).",
            if (drawText14Handle != null) 14 else 13
        )
    }

    override fun currentEpoch(): Int {
        if (degraded) return -1
        return runCatching {
            val engine = TextLayoutEngine.getInstance()
            if (engine !== lastEngineRef) {
                lastEngineRef = engine
                epochCounter.incrementAndGet()
            } else {
                epochCounter.get()
            }
        }.getOrDefault(-1)
    }

    override fun captureGlyphs(
        font: Font,
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
            val layout = engine.lookupVanillaLayout(rawText, Style.EMPTY) ?: return false
            val mode = if (preferSdf && !layout.hasColorEmoji()) 1 else 0
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
 * 客户端软兼容自注册订阅器（本身方法签名不含任何 `icyllis.modernui.*` 类型，未安装 ModernUI 时不会触发类加载失败，且无需 `Class.forName` 反射）。
 */
@Mod.EventBusSubscriber(modid = EpiphyMod.ID, bus = Mod.EventBusSubscriber.Bus.MOD, value = [Dist.CLIENT])
object ModernUiClientCompatSubscriber {
    @JvmStatic
    @SubscribeEvent
    fun onClientSetup(event: FMLClientSetupEvent) {
        if (!ModList.get().isLoaded("modernui")) return
        event.enqueueWork {
            ModernUiGlyphCaptureBackend.tryInstall()
        }
    }
}
