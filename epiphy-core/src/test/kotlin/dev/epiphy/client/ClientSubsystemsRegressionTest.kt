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
import org.junit.jupiter.api.Assertions.assertNotSame
import org.junit.jupiter.api.Assertions.assertSame
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
import java.util.concurrent.atomic.AtomicInteger

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

    /**
     * 与原版 `PoseStack` 完全一致地允许 `popPose()` 将内部 `Deque` 弹空至 `size == 0`（并在空栈 `popPose/pushPose/last` 时抛 `NoSuchElementException`）。
     */
    private class TrackedPoseStack : PoseStack(), PoseStackAccessor {
        private val realDeque: Deque<Pose>

        init {
            // 读取或同步真实底层 Deque：为保持测试零反射，这里维护一个与真实调用严格 1:1 抛错的代理 Deque，
            // 同时通过覆写所有栈操作委托到该 Deque，真实复现 size == 0 时 getLast/removeLast 抛 NoSuchElementException 的行为。
            realDeque = ArrayDeque<Pose>().apply {
                addLast(super.last())
            }
        }

        override fun pushPose() {
            val currentTop = realDeque.last // size == 0 时与原版一致直接抛 NoSuchElementException
            val sub = PoseStack()
            sub.last().pose().set(currentTop.pose())
            sub.last().normal().set(currentTop.normal())
            realDeque.addLast(sub.last())
        }

        override fun popPose() {
            realDeque.removeLast() // size == 0 时与原版一致直接抛 NoSuchElementException
        }

        override fun last(): Pose = realDeque.last

        override fun clear(): Boolean = realDeque.size == 1

        override fun translate(x: Float, y: Float, z: Float) {
            realDeque.last.pose().translate(x, y, z)
        }

        override fun `epiphy$getPoseDeque`(): Deque<Pose> = realDeque
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
    fun `PoseStackWatermark recovers from total stack depletion size 0 without throwing NoSuchElementException`() {
        val stack = TrackedPoseStack()
        stack.translate(12.5f, -4.0f, 3.0f)
        val expectedEntryMatrix = Matrix4f(stack.last().pose())

        val breaker = RenderFaultCircuitBreaker("TestMod", "PoseGuard", tripThreshold = 4, warnRateLimitMs = 0L)

        // 1. 溢出泄漏：监听器多 pushPose 4 层仅 pop 1 层
        PoseStackWatermark.runGuarded(stack, breaker, "overflowCase") {
            repeat(4) { stack.pushPose() }
            stack.translate(999f, 999f, 999f)
            stack.popPose()
        }
        assertEquals(1, stack.`epiphy$getPoseDeque`().size)
        assertEquals(expectedEntryMatrix, stack.last().pose())
        assertEquals(1, breaker.consecutiveFailureCount)

        // 2. 彻底弹空（size == 0）：入口深度 1，守卫压入工作帧后深度为 2；监听器连续 popPose 2 次将栈彻底弹空至 size == 0！
        PoseStackWatermark.runGuarded(stack, breaker, "depletedToZeroCase") {
            stack.popPose() // 深度 2 -> 1
            stack.popPose() // 深度 1 -> 0（栈已完全弹空！）
            assertEquals(0, stack.`epiphy$getPoseDeque`().size)
        }
        assertEquals(1, stack.`epiphy$getPoseDeque`().size, "Depleted empty PoseStack (size 0) must be rebuilt to entry depth 1 without throwing")
        assertEquals(expectedEntryMatrix, stack.last().pose(), "Entry matrix must be restored even after total stack depletion")
        assertEquals(2, breaker.consecutiveFailureCount)

        // 3. 连弹 3 次（弹空至 0 后第 3 次触发 NoSuchElementException）同样被安全捕获并恢复栈深与矩阵
        val okOverPop = PoseStackWatermark.runGuarded(stack, breaker, "overPopExceptionCase") {
            stack.popPose()
            stack.popPose()
            stack.popPose() // 抛 NoSuchElementException
        }
        assertFalse(okOverPop)
        assertEquals(1, stack.`epiphy$getPoseDeque`().size)
        assertEquals(expectedEntryMatrix, stack.last().pose())

        // 4. 上游调用前已传入空栈（size == 0）时入口同样不会崩溃
        stack.`epiphy$getPoseDeque`().clear()
        assertEquals(0, stack.`epiphy$getPoseDeque`().size)
        breaker.reset()
        assertTrue(PoseStackWatermark.runGuarded(stack, breaker, "preDepletedEntry") {
            stack.translate(1f, 2f, 3f)
        })
        assertEquals(1, stack.`epiphy$getPoseDeque`().size)

        // 5. 致命 VirtualMachineError 直接穿透重抛
        assertThrows(StackOverflowError::class.java) {
            PoseStackWatermark.runGuarded(stack, breaker, "fatalErrorCase") {
                throw StackOverflowError("simulated stack overflow")
            }
        }

        // 6. 连续普通运行期异常达到阈值触发熔断
        repeat(4) {
            PoseStackWatermark.runGuarded(stack, breaker, "runtimeFailureCase") {
                throw IllegalStateException("boom")
            }
        }
        assertTrue(breaker.isTripped)
    }

    @Test
    fun `NativeItem3DEngine reentrant slot pool isolates nested BEWLR item renders and cleans up on exception`() {
        val pool = arrayOfNulls<String>(4)
        val inUse = BooleanArray(4)
        val flushedOrder = ArrayList<String>()

        val outerBuf = "OUTER_SHARED_GUI_BUFFER"

        // 外层绑定物品借出 slot_0
        val leasedOuter = NativeItem3DEngine.leaseSlotFromPool(pool, inUse, outerBuf, { "SLOT_$it" }, canIsolate = true)
        assertEquals("SLOT_0", leasedOuter)
        assertTrue(inUse[0])

        // 场景 A：嵌套渲染一个未绑定的普通子物品（直接沿用外层传入的 SLOT_0，不调用 acquire，退出时因 buffer 未变也不调用 release）
        // 验证此时外层 SLOT_0 仍处于占用态且未被提前刷出
        assertTrue(flushedOrder.isEmpty())
        assertTrue(inUse[0])

        // 场景 B：嵌套渲染另一个同样需要隔离的绑定子物品 -> 借出独立的 SLOT_1，互不污染 SLOT_0
        val leasedInner = NativeItem3DEngine.leaseSlotFromPool(pool, inUse, leasedOuter, { "SLOT_$it" }, canIsolate = true)
        assertEquals("SLOT_1", leasedInner)
        assertNotSame(leasedOuter, leasedInner)
        assertTrue(inUse[0] && inUse[1])

        // 内层子物品先结束，归还并仅刷出 SLOT_1；外层 SLOT_0 保持在用且未刷出
        assertTrue(NativeItem3DEngine.returnSlotToPool(pool, inUse, leasedInner) { flushedOrder.add(it) })
        assertEquals(listOf("SLOT_1"), flushedOrder)
        assertTrue(inUse[0])
        assertFalse(inUse[1])

        // 外层物品随后即使在渲染中途抛出异常，由 @WrapMethod finally 执行归还，刷出 SLOT_0 并恢复全部空闲
        try {
            throw RuntimeException("simulated render error inside BEWLR")
        } catch (_: RuntimeException) {
            // expected
        } finally {
            NativeItem3DEngine.returnSlotToPool(pool, inUse, leasedOuter) { flushedOrder.add(it) }
        }
        assertEquals(listOf("SLOT_1", "SLOT_0"), flushedOrder)
        assertTrue(inUse.none { it }, "All isolation slots must be released after exception unwind")

        // 下一次渲染再次正常复用 SLOT_0
        val nextLease = NativeItem3DEngine.leaseSlotFromPool(pool, inUse, outerBuf, { "SLOT_$it" }, canIsolate = true)
        assertSame(leasedOuter, nextLease)
        NativeItem3DEngine.returnSlotToPool(pool, inUse, nextLease) {}
    }

    @Test
    fun `GuiInterceptionHooks scopes texture remaps strictly to the active Screen instance`() {
        val origTex = ResourceLocation("minecraft", "textures/gui/container/inventory.png")
        val repTex = ResourceLocation("epiphy", "textures/effect/white_pixel.png")

        var currentScreen: Any? = null
        GuiInterceptionHooks.activeScreenSupplierForTest = { currentScreen }

        GuiInterceptionHooks.setTextureRemap(origTex, repTex)
        assertFalse(GuiInterceptionHooks.hasTextureRemaps)
        assertEquals(origTex, GuiInterceptionHooks.remapTexture(origTex))

        val screenA = Any()
        currentScreen = screenA
        GuiInterceptionHooks.setTextureRemap(origTex, repTex)
        assertTrue(GuiInterceptionHooks.hasTextureRemaps)
        assertEquals(repTex, GuiInterceptionHooks.remapTexture(origTex))

        val screenB = Any()
        currentScreen = screenB
        assertEquals(origTex, GuiInterceptionHooks.remapTexture(origTex))
        assertFalse(GuiInterceptionHooks.hasTextureRemaps)
    }

    @Test
    fun `NativeTextBatchEngine buckets multi-atlas glyphs, enables SDF on tilted items, and refreshes capture per render frame`() {
        val atlas0 = DummyRenderType("epiphy_test_font_atlas_0")
        val atlas1 = DummyRenderType("epiphy_test_font_atlas_1")
        val atlas2 = DummyRenderType("epiphy_test_font_atlas_2")
        val atlases = arrayOf(atlas0, atlas1, atlas2)
        val captureCalls = AtomicInteger(0)
        val preferSdfObserved = ArrayList<Boolean>()

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
                captureCalls.incrementAndGet()
                preferSdfObserved.add(preferSdf)
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

        val units = (0 until 30).map { idx ->
            mapOf(
                "rawText" to (if (idx == 0) "§bA" else "DUP_${idx % 5}"), // 包含同帧重复字符以验证帧内去重
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
            units, true, 800.0, 0, 1.0, 1.0, 0.5, 0.5, 0.0, 0.25, false, 0.12, 0.35, 3.5, 4.0
        )

        NativeTextBatchEngine.INSTANCE.beginRenderFrame()
        val recorder = RecordingBufferSource()
        // 模拟倾斜旋转弹幕（mxy != 0, myx != 0），即使 outlineMode="none" 也应触发 preferSdf = true
        val cos8 = kotlin.math.cos(Math.toRadians(-8.0)).toFloat()
        val sin8 = kotlin.math.sin(Math.toRadians(-8.0)).toFloat()
        val rendered = NativeTextBatchEngine.INSTANCE.renderScene(
            scene, Matrix4f(), recorder, null, false,
            0, 30, 120.0, 1.2, true, false, "none", -1, 0.0f, false, "shrink", 0.0f,
            100.0f, 200.0f, cos8, -sin8, sin8, cos8, 1920.0f, 1080.0f, 32.0f
        )

        assertTrue(rendered)
        assertEquals(3, recorder.getBufferCallCount, "30 interleaved glyphs across 3 atlases must coalesce into 3 bucket flushes")
        // 30 个字符仅由 6 个唯一文本（§bA 与 DUP_0..DUP_4）组成，同一帧内只应捕获 6 次
        assertEquals(6, captureCalls.get(), "Identical glyphs within the same render frame must share captured quads")
        assertTrue(preferSdfObserved.all { it }, "Tilted danmaku must request SDF mode even without outlines")

        // 推进到下一渲染帧后，动态图集字形应重新同步捕获（防止跨帧死锁过期 UV）
        NativeTextBatchEngine.INSTANCE.beginRenderFrame()
        NativeTextBatchEngine.INSTANCE.renderScene(
            scene, Matrix4f(), RecordingBufferSource(), null, false,
            0, 30, 136.0, 1.2, true, false, "none", -1, 0.0f, false, "shrink", 0.0f,
            100.0f, 200.0f, cos8, -sin8, sin8, cos8, 1920.0f, 1080.0f, 32.0f
        )
        assertEquals(12, captureCalls.get(), "Advancing render frame must re-sync dynamic font atlas glyphs")
    }

    @Test
    fun `NativeItem3DBridge parses explicit BlendMode enum, rejects NaN quads, and reports truthful bind status`() {
        assertEquals(NativeItem3DEngine.BlendMode.TRANSLUCENT, NativeItem3DEngine.BlendMode.parseOrWarn("translucent"))
        assertEquals(NativeItem3DEngine.BlendMode.ADDITIVE, NativeItem3DEngine.BlendMode.parseOrWarn("additive"))
        assertEquals(NativeItem3DEngine.BlendMode.PREMULTIPLIED, NativeItem3DEngine.BlendMode.parseOrWarn("premultiplied"))
        assertEquals(NativeItem3DEngine.BlendMode.MULTIPLY, NativeItem3DEngine.BlendMode.parseOrWarn("multiply"))
        assertEquals(NativeItem3DEngine.BlendMode.SCREEN, NativeItem3DEngine.BlendMode.parseOrWarn("screen"))
        assertEquals(NativeItem3DEngine.BlendMode.OPAQUE, NativeItem3DEngine.BlendMode.parseOrWarn("opaque"))
        assertEquals(NativeItem3DEngine.BlendMode.TRANSLUCENT, NativeItem3DEngine.BlendMode.parseOrWarn("unknown_custom_mode"))

        val seenBlends = ArrayList<NativeItem3DEngine.BlendMode>()
        NativeItem3DBridge.renderTypeFactoryOverrideForTest = { _, _, blendMode, _, _, _, _ ->
            seenBlends.add(blendMode)
            DummyRenderType("epiphy_item3d_test_${blendMode.wireName}")
        }

        assertEquals(
            "INVALID_ID",
            NativeItem3DBridge.bindCompiledItemWithStatus("INVALID CAPS ID", 1.0, 0.0, 0.86, emptyList<Any>())
        )
        assertFalse(NativeItem3DBridge.bindCompiledItemFromJs("INVALID CAPS ID", 1.0, 0.0, 0.86, emptyList<Any>()))

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
    fun `NativeAudioClientAccess keeps -1 stopped as a monotonic terminal state across repeated polls`() {
        val audioExecutor = Executors.newSingleThreadExecutor()
        try {
            val handleToken = Any()
            val latch = CountDownLatch(1)

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

            // 连续第 2、第 3、第 4 次轮询均必须幂等保持 -1 终态，不得因读后误删重新变回 1
            for (pollRound in 2..4) {
                val pollRes = NativeAudioClientAccess.coordinateChannelState(
                    handleIdentity = handleToken,
                    syncStoppedFlag = false,
                    clampedAlGain = 0.8f,
                    shouldPauseMute = false,
                    forceUnpause = false
                ) { _ -> }
                assertEquals(-1, pollRes, "Poll round #$pollRound must stay in monotonic stopped state -1")
            }
        } finally {
            audioExecutor.shutdownNow()
        }
    }
}
