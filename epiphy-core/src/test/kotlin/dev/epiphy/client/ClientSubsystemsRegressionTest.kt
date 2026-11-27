// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.client

import com.mojang.blaze3d.vertex.DefaultVertexFormat
import com.mojang.blaze3d.vertex.PoseStack
import com.mojang.blaze3d.vertex.VertexConsumer
import com.mojang.blaze3d.vertex.VertexFormat
import dev.epiphy.client.audio.NativeAudioClientAccess
import dev.epiphy.client.fx3d.item.NativeItem3DBridge
import dev.epiphy.client.fx3d.item.NativeItem3DEngine
import dev.epiphy.client.surface2d.hook.GuiInterceptionHooks
import dev.epiphy.client.surface2d.text.GlyphCaptureBackend
import dev.epiphy.client.surface2d.text.NativeTextBatchEngine
import dev.epiphy.client.util.PoseStackWatermark
import dev.epiphy.client.util.RenderFaultCircuitBreaker
import dev.epiphy.mixin.client.PoseStackAccessor
import net.minecraft.SharedConstants
import net.minecraft.client.gui.Font
import net.minecraft.client.renderer.MultiBufferSource
import net.minecraft.client.renderer.RenderType
import net.minecraft.resources.ResourceLocation
import net.minecraft.server.Bootstrap
import org.joml.Matrix4f
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import java.util.ArrayDeque
import java.util.Deque
import java.util.IdentityHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * 客户端渲染、物品 3D 桥接与空间音频协调子系统的无头 JUnit 5 回归测试套件。
 */
class ClientSubsystemsRegressionTest {

    companion object {
        @JvmStatic
        @BeforeAll
        fun bootstrapMinecraftRegistries() {
            SharedConstants.tryDetectVersion()
            Bootstrap.bootStrap()
        }
    }

    private class TrackedPoseStack : PoseStack(), PoseStackAccessor {
        private val mirrorDeque = ArrayDeque<Pose>().apply {
            addLast(super.last())
        }

        override fun pushPose() {
            super.pushPose()
            mirrorDeque.addLast(super.last())
        }

        override fun popPose() {
            super.popPose()
            if (mirrorDeque.size > 1) {
                mirrorDeque.removeLast()
            }
        }

        override fun `epiphy$getPoseDeque`(): Deque<Pose> = mirrorDeque
    }

    private class DummyRenderType(name: String) : RenderType(
        name,
        DefaultVertexFormat.POSITION_COLOR_TEX,
        VertexFormat.Mode.QUADS,
        256,
        false,
        false,
        Runnable {},
        Runnable {}
    )

    private data class RecordedVertex(
        val x: Float,
        val y: Float,
        val z: Float,
        val r: Int,
        val g: Int,
        val b: Int,
        val a: Int
    )

    private class RecordingBufferSource : MultiBufferSource {
        var getBufferCallCount: Int = 0
        val verticesByType = IdentityHashMap<RenderType, MutableList<RecordedVertex>>()

        override fun getBuffer(renderType: RenderType): VertexConsumer {
            getBufferCallCount++
            val list = verticesByType.getOrPut(renderType) { ArrayList() }
            return object : VertexConsumer {
                private var vx = 0f
                private var vy = 0f
                private var vz = 0f
                private var vr = 255
                private var vg = 255
                private var vb = 255
                private var va = 255

                override fun vertex(x: Double, y: Double, z: Double): VertexConsumer {
                    vx = x.toFloat()
                    vy = y.toFloat()
                    vz = z.toFloat()
                    return this
                }

                override fun color(r: Int, g: Int, b: Int, a: Int): VertexConsumer {
                    vr = r
                    vg = g
                    vb = b
                    va = a
                    return this
                }

                override fun uv(u: Float, v: Float): VertexConsumer = this
                override fun overlayCoords(u: Int, v: Int): VertexConsumer = this
                override fun uv2(u: Int, v: Int): VertexConsumer = this
                override fun normal(x: Float, y: Float, z: Float): VertexConsumer = this
                override fun defaultColor(r: Int, g: Int, b: Int, a: Int) {}
                override fun unsetDefaultColor() {}

                override fun endVertex() {
                    list.add(RecordedVertex(vx, vy, vz, vr, vg, vb, va))
                }
            }
        }
    }

    @AfterEach
    fun tearDown() {
        GuiInterceptionHooks.activeScreenSupplierForTest = null
        GuiInterceptionHooks.clearAllTextureRemaps()
        GuiInterceptionHooks.resetCircuitBreaker()
        NativeTextBatchEngine.INSTANCE.optionalBackend = null
        NativeTextBatchEngine.INSTANCE.clearCache()
        NativeItem3DBridge.renderTypeFactoryOverrideForTest = null
    }

    @Test
    fun `PoseStackWatermark restores exact stack depth on multi-layer overflow and underflow while breaker rethrows JVM Errors`() {
        val stack = TrackedPoseStack()
        stack.translate(12.5f, -4.0f, 3.0f)
        val expectedEntryMatrix = Matrix4f(stack.last().pose())

        val breaker = RenderFaultCircuitBreaker("TestMod", "PoseGuard", tripThreshold = 3, warnRateLimitMs = 0L)

        // 1. 监听器内部多 pushPose 4 层却只 popPose 1 层（泄漏 +3 层）
        PoseStackWatermark.runGuarded(stack, breaker, "overflowCase") {
            repeat(4) { stack.pushPose() }
            stack.translate(999f, 999f, 999f)
            stack.popPose()
        }
        assertEquals(1, stack.`epiphy$getPoseDeque`().size, "Overflowed PoseStack layers must be popped back to entry depth 1")
        assertEquals(expectedEntryMatrix, stack.last().pose(), "Entry matrix must remain intact after overflow recovery")
        assertEquals(1, breaker.consecutiveFailureCount)

        // 2. 监听器内部恶意多 popPose 把工作帧与入口基线变换篡改（下溢透支）
        PoseStackWatermark.runGuarded(stack, breaker, "underflowCase") {
            stack.popPose() // 提前弹出守卫压入的工作帧
            stack.translate(-500f, -500f, -500f) // 直接污染外层帧
        }
        assertEquals(1, stack.`epiphy$getPoseDeque`().size, "Underflowed PoseStack must be rebuilt to entry depth 1")
        assertEquals(expectedEntryMatrix, stack.last().pose(), "Entry matrix must be restored from backup after underflow")
        assertEquals(2, breaker.consecutiveFailureCount)

        // 3. 致命 VirtualMachineError 绝不被吞咽
        assertThrows(StackOverflowError::class.java) {
            PoseStackWatermark.runGuarded(stack, breaker, "fatalErrorCase") {
                throw StackOverflowError("simulated stack overflow")
            }
        }

        // 4. 第 3 次普通运行期异常触发阈值自动熔断
        val ok = PoseStackWatermark.runGuarded(stack, breaker, "runtimeFailureCase") {
            throw IllegalStateException("boom")
        }
        assertFalse(ok)
        assertTrue(breaker.isTripped, "Circuit breaker must trip upon reaching threshold 3")

        var invokedWhileTripped = false
        PoseStackWatermark.runGuarded(stack, breaker, "skippedWhenTripped") {
            invokedWhileTripped = true
        }
        assertFalse(invokedWhileTripped, "Tripped circuit breaker must skip faulty callback")

        breaker.reset()
        assertFalse(breaker.isTripped)
    }

    @Test
    fun `GuiInterceptionHooks scopes texture remaps strictly to the active Screen instance`() {
        val origTex = ResourceLocation("minecraft", "textures/gui/container/inventory.png")
        val repTex = ResourceLocation("epiphy", "textures/effect/white_pixel.png")

        var currentScreen: Any? = null
        GuiInterceptionHooks.activeScreenSupplierForTest = { currentScreen }

        // 无打开界面时注册重映射不残留全局状态
        GuiInterceptionHooks.setTextureRemap(origTex, repTex)
        assertFalse(GuiInterceptionHooks.hasTextureRemaps)
        assertEquals(origTex, GuiInterceptionHooks.remapTexture(origTex))

        // 在 screenA 打开期间生效
        val screenA = Any()
        currentScreen = screenA
        GuiInterceptionHooks.setTextureRemap(origTex, repTex)
        assertTrue(GuiInterceptionHooks.hasTextureRemaps)
        assertEquals(repTex, GuiInterceptionHooks.remapTexture(origTex))

        // 界面切换至 screenB（即使脚本未显式调用 clear），旧界面的映射自动失效并清理
        val screenB = Any()
        currentScreen = screenB
        assertEquals(origTex, GuiInterceptionHooks.remapTexture(origTex))
        assertFalse(GuiInterceptionHooks.hasTextureRemaps)
    }

    @Test
    fun `NativeTextBatchEngine buckets interleaved multi-atlas glyphs into K flushes and preserves explicit color codes`() {
        val atlas0 = DummyRenderType("epiphy_test_font_atlas_0")
        val atlas1 = DummyRenderType("epiphy_test_font_atlas_1")
        val atlas2 = DummyRenderType("epiphy_test_font_atlas_2")
        val atlases = arrayOf(atlas0, atlas1, atlas2)

        NativeTextBatchEngine.INSTANCE.optionalBackend = object : GlyphCaptureBackend {
            override fun currentEpoch(): Int = 1

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
                val bucketIdx = rawText.hashCode().ushr(1) % atlases.size
                val vc = capturer.getBuffer(atlases[bucketIdx])
                val isExplicitCyan = rawText.startsWith("§b")
                val r = if (isExplicitCyan) 85 else sentinelR
                val g = if (isExplicitCyan) 255 else sentinelG
                val b = if (isExplicitCyan) 255 else sentinelB

                vc.vertex(0.0, 0.0, 0.0).color(r, g, b, 255).uv(0f, 0f).endVertex()
                vc.vertex(0.0, 8.0, 0.0).color(r, g, b, 255).uv(0f, 1f).endVertex()
                vc.vertex(6.0, 8.0, 0.0).color(r, g, b, 255).uv(1f, 1f).endVertex()
                vc.vertex(6.0, 0.0, 0.0).color(r, g, b, 255).uv(1f, 0f).endVertex()
                return true
            }
        }

        // 构造 30 个交替跨越 3 张图集页的字符单元（第 0 个带显式 §b 颜色码，其余继承节点基础色 0xFF8020）
        val units = (0 until 30).map { idx ->
            mapOf(
                "rawText" to (if (idx == 0) "§bA" else "C$idx"),
                "isMerged" to false,
                "isBlank" to false,
                "visIndex" to idx,
                "visStart" to idx,
                "visEnd" to (idx + 1),
                "baseX" to (idx * 7.0f),
                "baseY" to 10.0f,
                "w" to 6.0f,
                "charScale" to 1.0f,
                "color" to 0xFF8020,
                "shakeFlag" to 1,
                "outlineMode" to "none",
                "outlineColor" to -1,
                "cSeed" to (idx * 13.7 + 1.0),
                "periodMs" to 800.0,
                "phaseOff" to 0.0
            )
        }

        val scene = NativeTextBatchEngine.INSTANCE.compileScene(
            units,
            true,
            800.0,
            0,
            1.0,
            1.0,
            0.5,
            0.5,
            0.0,
            0.25,
            false,
            0.12,
            0.35,
            3.5,
            4.0
        )
        val recorder = RecordingBufferSource()
        val rendered = NativeTextBatchEngine.INSTANCE.renderScene(
            scene,
            Matrix4f(),
            recorder,
            null,
            false,
            0,
            30,
            120.0,
            1.2,
            true,
            false,
            "none",
            -1,
            0.0f,
            false,
            "shrink",
            0.0f,
            0.0f,
            0.0f,
            1.0f,
            0.0f,
            0.0f,
            1.0f,
            1920.0f,
            1080.0f,
            32.0f
        )

        assertTrue(rendered)
        // 核心结构不变量：30 个字符交替分布在 3 张纹理图集上，PassBucketBuffer 只应触发恰好 K = 3 次 getBuffer！
        assertEquals(3, recorder.getBufferCallCount, "30 interleaved glyphs across 3 atlases must coalesce into exactly 3 bucket flushes")

        val allVerts = recorder.verticesByType.values.flatten()
        assertEquals(30 * 4, allVerts.size)
        assertTrue(allVerts.any { it.r == 85 && it.g == 255 && it.b == 255 }, "Explicit §b color must be preserved without sentinel override")
        assertTrue(allVerts.any { it.r == 0xFF && it.g == 0x80 && it.b == 0x20 }, "Sentinel-colored glyphs must inherit node caller RGB 0xFF8020")
        assertTrue(allVerts.all { it.y in (10.0f - 4.01f)..(18.0f + 4.01f) }, "Per-char shake Y displacement must stay within clamped bounds")
    }

    @Test
    fun `NativeItem3DBridge parses explicit BlendMode enum, rejects NaN quads, and reports truthful bind status`() {
        assertEquals(NativeItem3DEngine.BlendMode.TRANSLUCENT, NativeItem3DEngine.BlendMode.parseOrWarn("translucent"))
        assertEquals(NativeItem3DEngine.BlendMode.ADDITIVE, NativeItem3DEngine.BlendMode.parseOrWarn("additive"))
        assertEquals(NativeItem3DEngine.BlendMode.PREMULTIPLIED, NativeItem3DEngine.BlendMode.parseOrWarn("premultiplied"))
        assertEquals(NativeItem3DEngine.BlendMode.MULTIPLY, NativeItem3DEngine.BlendMode.parseOrWarn("multiply"))
        assertEquals(NativeItem3DEngine.BlendMode.SCREEN, NativeItem3DEngine.BlendMode.parseOrWarn("screen"))
        assertEquals(NativeItem3DEngine.BlendMode.OPAQUE, NativeItem3DEngine.BlendMode.parseOrWarn("opaque"))
        // 未知混合模式回退为安全的 TRANSLUCENT，不再隐式变为加法混合
        assertEquals(NativeItem3DEngine.BlendMode.TRANSLUCENT, NativeItem3DEngine.BlendMode.parseOrWarn("unknown_custom_mode"))

        val seenBlends = ArrayList<NativeItem3DEngine.BlendMode>()
        NativeItem3DBridge.renderTypeFactoryOverrideForTest = { _, _, blendMode, _, _, _, _ ->
            seenBlends.add(blendMode)
            DummyRenderType("epiphy_item3d_test_${blendMode.wireName}")
        }

        // 1. 非法 ResourceLocation -> INVALID_ID / false
        assertEquals(
            "INVALID_ID",
            NativeItem3DBridge.bindCompiledItemWithStatus("INVALID CAPS ID", 1.0, 0.0, 0.86, emptyList<Any>())
        )
        assertFalse(NativeItem3DBridge.bindCompiledItemFromJs("INVALID CAPS ID", 1.0, 0.0, 0.86, emptyList<Any>()))

        // 2. 含 NaN 顶点的面片被过滤后为空 -> EMPTY_PASSES / false
        val nanPass = mapOf(
            "id" to "broken_quad",
            "category" to "geometry",
            "material" to mapOf("blend" to "multiply"),
            "xyzUv" to listOf(
                0f, 0f, 0f, 0f, 0f,
                Float.NaN, 1f, 0f, 0f, 1f,
                1f, 1f, 0f, 1f, 1f,
                1f, 0f, 0f, 1f, 0f
            ),
            "rgba" to listOf(-1, -1, -1, -1)
        )
        assertEquals(
            "EMPTY_PASSES",
            NativeItem3DBridge.bindCompiledItemWithStatus("epiphy:unregistered_demo_item", 1.0, 0.0, 0.86, listOf(nanPass))
        )

        // 3. 合法面片但物品在无头环境尚未注册进 ForgeRegistries -> 如实返回 PENDING_REGISTRY（布尔入口返回 false，不伪造成功）
        val validPass = mapOf(
            "id" to "ring_0",
            "category" to "geometry",
            "material" to mapOf("blend" to "screen"),
            "xyzUv" to listOf(
                0f, 0f, 0f, 0f, 0f,
                0f, 1f, 0f, 0f, 1f,
                1f, 1f, 0f, 1f, 1f,
                1f, 0f, 0f, 1f, 0f
            ),
            "rgba" to listOf(-1, -1, -1, -1)
        )
        val status = NativeItem3DBridge.bindCompiledItemWithStatus(
            "epiphy:unregistered_demo_item",
            1.0,
            0.0,
            0.86,
            listOf(validPass)
        )
        assertEquals("PENDING_REGISTRY", status)
        assertEquals(listOf(NativeItem3DEngine.BlendMode.SCREEN), seenBlends)
        assertFalse(NativeItem3DBridge.bindCompiledItemFromJs("epiphy:unregistered_demo_item", 1.0, 0.0, 0.86, listOf(validPass)))

        val unresolved = NativeItem3DEngine.auditUnresolvedPendingItems()
        assertTrue("epiphy:unregistered_demo_item" in unresolved)
        NativeItem3DBridge.unbindItem("epiphy:unregistered_demo_item")

        // 4. 已在原版注册表存在的真实物品（如 minecraft:diamond_sword）应立即完成挂载并返回 BOUND / true
        val boundStatus = NativeItem3DBridge.bindCompiledItemWithStatus(
            "minecraft:diamond_sword",
            1.0,
            0.0,
            0.86,
            listOf(validPass)
        )
        assertEquals("BOUND", boundStatus)
        assertTrue(NativeItem3DBridge.bindCompiledItemFromJs("minecraft:diamond_sword", 1.0, 0.0, 0.86, listOf(validPass)))
        assertTrue(NativeItem3DBridge.unbindItem("minecraft:diamond_sword"))
    }

    @Test
    fun `NativeAudioClientAccess observes async audio-thread channel stop without losing -1 state`() {
        val audioExecutor = Executors.newSingleThreadExecutor()
        try {
            val handleToken = Any()
            val latch = CountDownLatch(1)

            // 模拟第一次主线程轮询时 syncStoppedFlag 仍为 false，而异步音频线程稍后观测到 channel.stopped() == true
            val firstPoll = NativeAudioClientAccess.coordinateChannelState(
                handleIdentity = handleToken,
                syncStoppedFlag = false,
                clampedAlGain = 0.8f,
                shouldPauseMute = false,
                forceUnpause = false
            ) { onAudioThread ->
                audioExecutor.execute {
                    onAudioThread(true, {}, {}, {})
                    latch.countDown()
                }
            }
            assertEquals(1, firstPoll)
            assertTrue(latch.await(2, TimeUnit.SECONDS))

            // 异步回调完成后下一次轮询，即便 syncStoppedFlag 尚未翻转，也必须立即返回 -1 (stopped)
            val secondPoll = NativeAudioClientAccess.coordinateChannelState(
                handleIdentity = handleToken,
                syncStoppedFlag = false,
                clampedAlGain = 0.8f,
                shouldPauseMute = false,
                forceUnpause = false
            ) { _ -> }
            assertEquals(-1, secondPoll)

            // 当 ChannelHandle.isStopped 同步标志已为 true 时，首次轮询即直接返回 -1
            val directStopped = NativeAudioClientAccess.coordinateChannelState(
                handleIdentity = Any(),
                syncStoppedFlag = true,
                clampedAlGain = 0.5f,
                shouldPauseMute = false,
                forceUnpause = false
            ) { _ -> }
            assertEquals(-1, directStopped)
        } finally {
            audioExecutor.shutdownNow()
        }
    }
}
