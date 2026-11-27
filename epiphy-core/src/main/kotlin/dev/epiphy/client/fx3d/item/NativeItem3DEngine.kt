// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.client.fx3d.item

import com.mojang.blaze3d.platform.GlStateManager
import com.mojang.blaze3d.systems.RenderSystem
import com.mojang.blaze3d.vertex.BufferBuilder
import com.mojang.blaze3d.vertex.DefaultVertexFormat
import com.mojang.blaze3d.vertex.PoseStack
import com.mojang.blaze3d.vertex.VertexFormat
import com.mojang.math.Axis
import dev.epiphy.client.shader.EpiphyCoreShaders
import dev.epiphy.client.util.RenderFaultCircuitBreaker
import dev.epiphy.core.EpiphyRuntime
import net.minecraft.client.Minecraft
import net.minecraft.client.renderer.GameRenderer
import net.minecraft.client.renderer.MultiBufferSource
import net.minecraft.client.renderer.RenderStateShard
import net.minecraft.client.renderer.RenderType
import net.minecraft.client.resources.model.BakedModel
import net.minecraft.core.registries.BuiltInRegistries
import net.minecraft.resources.ResourceLocation
import net.minecraft.world.item.BlockItem
import net.minecraft.world.item.Item
import net.minecraft.world.item.ItemDisplayContext
import net.minecraft.world.item.ItemStack
import net.minecraft.world.item.Items
import net.minecraft.world.level.block.HalfTransparentBlock
import net.minecraft.world.level.block.StainedGlassPaneBlock
import net.minecraftforge.registries.ForgeRegistries
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.PI
import kotlin.math.max
import kotlin.math.roundToLong
import kotlin.math.sin

/**
 * 基于原版 `ShaderInstance`、`RenderType` 与 `Item3DRenderHooks` 的声明式物品三维图层渲染引擎（不依赖 `CodeChickenLib`）。
 *
 * 工作机制：
 * - 在模型绑定或资源重载阶段接收编译后的紧凑顶点与颜色数组，过滤含 NaN/Infinity 的异常坐标，并返回明确的挂载状态 [BindStatus]；
 * - 按显式 [BlendMode] 枚举与材质参数缓存 `RenderType`（支持 `translucent`、`additive`、`premultiplied`、`multiply`、`screen`、`opaque`）；
 * - 为需要深度缓冲同步的单件绑定物品提供深度可重入（最多 4 层嵌套）的局部可复用 `MultiBufferSource.BufferSource` 槽池，使基底深度刷新与自定义图层刷新仅作用于当前单件物品，在支持嵌套子物品（如 BEWLR 容器物品）的同时不打断外部容器多槽位的共享批次。
 *
 * 已知边界：
 * - 独立局部缓冲槽池仅在客户端主渲染线程、嵌套深度 `<= 4` 且外层缓冲为标准 `MultiBufferSource.BufferSource` 时借出；开启接管 `MultiBufferSource` 的第三方光影模组时，表现取决于光影管线对自定义 `RenderType` 与核心着色器的支持程度。
 */
object NativeItem3DEngine : RenderStateShard("epiphy_item3d_shards", Runnable {}, Runnable {}) {

    private val T0_NANOS = System.nanoTime()

    @Volatile var enabled: Boolean = true
    @Volatile var overlaysEnabled: Boolean = true
    @Volatile var geometryEnabled: Boolean = true
    @Volatile var guiGlobalScale: Float = 1.0f

    enum class BindStatus {
        BOUND,
        PENDING_REGISTRY,
        EMPTY_PASSES,
        INVALID_ID
    }

    enum class BlendMode(val wireName: String) {
        TRANSLUCENT("translucent"),
        ADDITIVE("additive"),
        PREMULTIPLIED("premultiplied"),
        MULTIPLY("multiply"),
        SCREEN("screen"),
        OPAQUE("opaque");

        companion object {
            @JvmStatic
            fun parseOrWarn(raw: String?, contextId: String = "material"): BlendMode {
                if (raw.isNullOrBlank()) return ADDITIVE
                return when (val norm = raw.trim().lowercase()) {
                    "translucent", "alpha", "normal" -> TRANSLUCENT
                    "additive", "add", "lightning" -> ADDITIVE
                    "premultiplied", "premul" -> PREMULTIPLIED
                    "multiply", "mul" -> MULTIPLY
                    "screen" -> SCREEN
                    "opaque", "none", "solid" -> OPAQUE
                    else -> {
                        runCatching {
                            EpiphyRuntime.ensureInitialized()
                            EpiphyRuntime.logEngine.warnOnce(
                                "EpiphyItem3D",
                                "unknown_blend:$norm",
                                "Unknown item3d blend mode '$raw' in '$contextId'; falling back to 'translucent'."
                            )
                        }
                        TRANSLUCENT
                    }
                }
            }
        }
    }

    private val PREMULTIPLIED_TRANSPARENCY = TransparencyStateShard(
        "epiphy_premultiplied_transparency",
        {
            RenderSystem.enableBlend()
            RenderSystem.blendFuncSeparate(
                GlStateManager.SourceFactor.ONE,
                GlStateManager.DestFactor.ONE_MINUS_SRC_ALPHA,
                GlStateManager.SourceFactor.ONE,
                GlStateManager.DestFactor.ONE_MINUS_SRC_ALPHA
            )
        },
        {
            RenderSystem.disableBlend()
            RenderSystem.defaultBlendFunc()
        }
    )

    private val MULTIPLY_TRANSPARENCY = TransparencyStateShard(
        "epiphy_multiply_transparency",
        {
            RenderSystem.enableBlend()
            RenderSystem.blendFuncSeparate(
                GlStateManager.SourceFactor.DST_COLOR,
                GlStateManager.DestFactor.ONE_MINUS_SRC_ALPHA,
                GlStateManager.SourceFactor.ZERO,
                GlStateManager.DestFactor.ONE
            )
        },
        {
            RenderSystem.disableBlend()
            RenderSystem.defaultBlendFunc()
        }
    )

    private val SCREEN_TRANSPARENCY = TransparencyStateShard(
        "epiphy_screen_transparency",
        {
            RenderSystem.enableBlend()
            RenderSystem.blendFuncSeparate(
                GlStateManager.SourceFactor.ONE,
                GlStateManager.DestFactor.ONE_MINUS_SRC_COLOR,
                GlStateManager.SourceFactor.ONE,
                GlStateManager.DestFactor.ONE_MINUS_SRC_ALPHA
            )
        },
        {
            RenderSystem.disableBlend()
            RenderSystem.defaultBlendFunc()
        }
    )

    data class MaterialKey(
        val shaderId: String?,
        val texture: ResourceLocation,
        val blendMode: BlendMode,
        val blur: Boolean,
        val cull: Boolean,
        val depthTest: Boolean,
        val depthWrite: Boolean
    )

    sealed interface UniformBinding {
        data object Time : UniformBinding
        data object ViewYaw : UniformBinding
        data object ViewPitch : UniformBinding
        data object ViewYawPitch : UniformBinding
        data object IsGui : UniformBinding
        data object AttackProgress : UniformBinding
        data class Const1f(val v0: Float) : UniformBinding
        data class Const2f(val v0: Float, val v1: Float) : UniformBinding
        data class Const3f(val v0: Float, val v1: Float, val v2: Float) : UniformBinding
        data class Const4f(val v0: Float, val v1: Float, val v2: Float, val v3: Float) : UniformBinding
    }

    data class TransformSpec(
        val mode: String, // "identity" | "local_axis" | "local_axis_bob"
        val cx: Float = 0.5f,
        val cy: Float = 0.5f,
        val cz: Float = 0.5f,
        val axisDirX: Float = 1.0f,
        val axisDirY: Float = 0.0f,
        val axisAngleRad: Float = 0.0f,
        val tiltU: Float = 0.0f,
        val tiltV: Float = 0.0f,
        val spinSpeed: Float = 0.0f,
        val bobAmp: Float = 0.0f,
        val bobFreq: Float = 0.0f,
        val bobPhase: Float = 0.0f,
        val scaleWithAttack: String = "uniform" // "uniform" | "radial" | "none"
    )

    class BakedPass(
        val id: String,
        val isOverlay: Boolean,
        val visibleIn: String, // "all" | "hand" | "gui"
        val renderType: RenderType,
        val shaderId: String?,
        val depthTest: Boolean,
        val flushAfter: Boolean,
        val uniforms: List<Pair<String, UniformBinding>>,
        val transform: TransformSpec,
        /** 每顶点 5 个 float: [x, y, z, u, v]，每 4 个顶点构成 1 个 Quad */
        val vertexXyzUv: FloatArray,
        /** 每顶点打包 RGBA: 0xRRGGBBAA */
        val vertexRgba: IntArray
    ) {
        val vertexCount: Int get() = vertexRgba.size
    }

    class CompiledItemModel(
        val itemId: String,
        val renderBase: Boolean = true,
        val flushBase: Boolean = true,
        val speedMul: Float,
        val attackExpand: Float,
        val guiScale: Float,
        val passes: List<BakedPass>,
        val overlayCount: Int,
        val geometryCount: Int,
        val totalVertices: Int
    ) {
        val needsIsolatedBuffer: Boolean =
            (renderBase && flushBase && passes.any { it.depthTest || it.isOverlay }) || passes.any { it.flushAfter }
    }

    private const val MAX_ISOLATION_SLOTS = 4

    private val renderTypeCache = ConcurrentHashMap<MaterialKey, RenderType>()
    private val pendingSpecs = ConcurrentHashMap<String, CompiledItemModel>()
    private val activeModels = ConcurrentHashMap<String, CompiledItemModel>()

    // 仅客户端主渲染线程访问的可重入局部缓冲槽池（支持嵌套 BEWLR 渲染而不互相提前刷出，也不打断外部容器共享 BufferSource）
    private val isolatedBufferSlots = arrayOfNulls<MultiBufferSource.BufferSource>(MAX_ISOLATION_SLOTS)
    private val isolatedSlotInUse = BooleanArray(MAX_ISOLATION_SLOTS)

    val passCircuitBreaker = RenderFaultCircuitBreaker(
        module = "EpiphyItem3D",
        channelTag = "NativeItem3DPass",
        tripThreshold = 16
    )

    private val renderCalls = AtomicLong(0L)
    private val handCalls = AtomicLong(0L)
    private val guiCalls = AtomicLong(0L)
    private val overlayDraws = AtomicLong(0L)
    private val geometryDraws = AtomicLong(0L)
    private val isolatedFlushes = AtomicLong(0L)
    private val totalRenderNanos = AtomicLong(0L)
    @Volatile private var lastRenderUs: Long = 0L
    @Volatile private var maxRenderUs: Long = 0L
    @Volatile private var lastError: String? = null

    /**
     * 可重入局部缓冲槽协调器（将线程/类型前置判定与槽位借还解耦，便于无头单测直接验证嵌套重入与异常恢复）。
     */
    internal fun <B : Any> leaseSlotFromPool(
        pool: Array<B?>,
        inUseFlags: BooleanArray,
        outerBuffer: B,
        factory: (Int) -> B,
        canIsolate: Boolean
    ): B {
        if (!canIsolate) return outerBuffer
        for (idx in pool.indices) {
            if (!inUseFlags[idx]) {
                var slot = pool[idx]
                if (slot == null) {
                    slot = factory(idx)
                    pool[idx] = slot
                }
                inUseFlags[idx] = true
                return slot
            }
        }
        return outerBuffer
    }

    internal inline fun <B : Any> returnSlotToPool(
        pool: Array<B?>,
        inUseFlags: BooleanArray,
        leasedBuffer: B?,
        flushSlot: (B) -> Unit
    ): Boolean {
        if (leasedBuffer == null) return false
        for (idx in pool.indices) {
            val slot = pool[idx]
            if (slot != null && leasedBuffer === slot && inUseFlags[idx]) {
                try {
                    flushSlot(slot)
                } catch (t: Throwable) {
                    RenderFaultCircuitBreaker.rethrowIfFatalJvmError(t)
                } finally {
                    inUseFlags[idx] = false
                }
                return true
            }
        }
        return false
    }

    private fun isKnownIsolatedSlot(buffer: MultiBufferSource): Boolean {
        for (slot in isolatedBufferSlots) {
            if (slot != null && buffer === slot) return true
        }
        return false
    }

    internal fun acquireIsolatedBufferSource(outerBuffer: MultiBufferSource): MultiBufferSource {
        if (outerBuffer !is MultiBufferSource.BufferSource || !RenderSystem.isOnRenderThread()) {
            return outerBuffer
        }
        return leaseSlotFromPool(
            pool = isolatedBufferSlots,
            inUseFlags = isolatedSlotInUse,
            outerBuffer = outerBuffer,
            factory = { MultiBufferSource.immediate(BufferBuilder(2048)) },
            canIsolate = true
        )
    }

    internal fun releaseIsolatedBufferSource(leasedBuffer: MultiBufferSource?) {
        val candidate = leasedBuffer as? MultiBufferSource.BufferSource ?: return
        val flushed = returnSlotToPool(
            pool = isolatedBufferSlots,
            inUseFlags = isolatedSlotInUse,
            leasedBuffer = candidate
        ) { slot ->
            slot.endBatch()
        }
        if (flushed) {
            isolatedFlushes.incrementAndGet()
        }
    }

    /**
     * 帧末统一收口自检：若因未知极端字节码绕过导致槽位标记残留，强制冲洗归零并限频记录告警。
     */
    fun onRenderFrameEnd() {
        if (!RenderSystem.isOnRenderThread()) return
        for (idx in isolatedSlotInUse.indices) {
            if (isolatedSlotInUse[idx]) {
                try {
                    isolatedBufferSlots[idx]?.endBatch()
                } catch (t: Throwable) {
                    RenderFaultCircuitBreaker.rethrowIfFatalJvmError(t)
                } finally {
                    isolatedSlotInUse[idx] = false
                }
                runCatching {
                    EpiphyRuntime.ensureInitialized()
                    EpiphyRuntime.logEngine.warn(
                        "EpiphyItem3D",
                        "IsolatedSlotFrameSweep",
                        "Reclaimed leaked isolated item buffer slot #$idx at end of render frame."
                    )
                }
            }
        }
    }

    fun registerCompiledItemWithStatus(model: CompiledItemModel): BindStatus {
        val cleanId = model.itemId.trim()
        if (cleanId.isEmpty() || ResourceLocation.tryParse(cleanId) == null) {
            return BindStatus.INVALID_ID
        }
        if (model.passes.isEmpty() || model.totalVertices <= 0) {
            pendingSpecs.remove(cleanId)
            activeModels.remove(cleanId)
            return BindStatus.EMPTY_PASSES
        }
        pendingSpecs[cleanId] = model
        return if (tryBindToRegistryItem(model)) BindStatus.BOUND else BindStatus.PENDING_REGISTRY
    }

    fun registerCompiledItem(model: CompiledItemModel): Boolean =
        registerCompiledItemWithStatus(model) == BindStatus.BOUND

    private fun resolveRegisteredItem(rl: ResourceLocation): Item? {
        val fromForge = runCatching {
            if (ForgeRegistries.ITEMS.containsKey(rl)) ForgeRegistries.ITEMS.getValue(rl) else null
        }.getOrNull()
        if (fromForge != null && fromForge != Items.AIR) return fromForge

        val fromVanilla = runCatching {
            BuiltInRegistries.ITEM.getOptional(rl).orElse(null)
        }.getOrNull()
        return fromVanilla?.takeIf { it != Items.AIR }
    }

    fun unregisterItem(itemId: String): Boolean {
        val cleanId = itemId.trim()
        pendingSpecs.remove(cleanId)
        activeModels.remove(cleanId)
        val rl = ResourceLocation.tryParse(cleanId) ?: return false
        val item = resolveRegisteredItem(rl)
        if (item != null) {
            Item3DRenderHooks.unbindItem(item)
            return true
        }
        return false
    }

    fun rebindAllPending(): Int {
        var bound = 0
        for (model in pendingSpecs.values) {
            if (tryBindToRegistryItem(model)) {
                bound++
            }
        }
        return bound
    }

    /**
     * 在客户端注册表冻结就绪后核查仍未匹配到真实物品的挂起项并记录告警，防止拼写错误静默失效。
     */
    fun auditUnresolvedPendingItems(): List<String> {
        val unresolved = pendingSpecs.keys.filter { !activeModels.containsKey(it) }.sorted()
        if (unresolved.isNotEmpty()) {
            runCatching {
                EpiphyRuntime.ensureInitialized()
                EpiphyRuntime.logEngine.warn(
                    "EpiphyItem3D",
                    "UnresolvedItemIds",
                    "3D item models remained unbound after client setup (missing from ForgeRegistries.ITEMS): $unresolved",
                    rateLimitMs = 0L
                )
            }
        }
        return unresolved
    }

    fun clearRenderTypeCache() {
        renderTypeCache.clear()
        passCircuitBreaker.reset()
    }

    private fun tryBindToRegistryItem(model: CompiledItemModel): Boolean {
        val rl = ResourceLocation.tryParse(model.itemId.trim()) ?: return false
        val item = resolveRegisteredItem(rl) ?: return false

        activeModels[model.itemId.trim()] = model
        Item3DRenderHooks.bindItem(
            item = item,
            renderBase = model.renderBase,
            isolateBuffer = model.needsIsolatedBuffer
        ) { stack, displayContext, _, poseStack, bufferSource, _, _, bakedModel ->
            renderCompiledItem(model, stack, displayContext, poseStack, bufferSource, bakedModel)
        }
        return true
    }

    @Suppress("INFERRED_INVISIBLE_RETURN_TYPE_WARNING")
    fun getOrCreateRenderType(
        shaderId: String?,
        textureStr: String,
        blendMode: BlendMode,
        blur: Boolean,
        cull: Boolean,
        depthWrite: Boolean,
        depthTest: Boolean = true
    ): RenderType {
        val texRl = ResourceLocation.tryParse(
            if (':' in textureStr) textureStr.trim() else "epiphy:${textureStr.trim()}"
        ) ?: ResourceLocation("epiphy", "textures/effect/white_pixel.png")

        val key = MaterialKey(shaderId?.takeIf { it.isNotBlank() }, texRl, blendMode, blur, cull, depthTest, depthWrite)
        return renderTypeCache.computeIfAbsent(key) { k ->
            val shaderShard = if (k.shaderId != null) {
                ShaderStateShard {
                    EpiphyCoreShaders.getShaderByString(k.shaderId)?.instance
                        ?: GameRenderer.getPositionColorTexShader()
                }
            } else {
                POSITION_COLOR_TEX_SHADER
            }
            val transparencyShard = when (k.blendMode) {
                BlendMode.ADDITIVE -> LIGHTNING_TRANSPARENCY
                BlendMode.TRANSLUCENT -> TRANSLUCENT_TRANSPARENCY
                BlendMode.PREMULTIPLIED -> PREMULTIPLIED_TRANSPARENCY
                BlendMode.MULTIPLY -> MULTIPLY_TRANSPARENCY
                BlendMode.SCREEN -> SCREEN_TRANSPARENCY
                BlendMode.OPAQUE -> NO_TRANSPARENCY
            }
            val state = RenderType.CompositeState.builder()
                .setShaderState(shaderShard)
                .setTextureState(TextureStateShard(k.texture, k.blur, false))
                .setTransparencyState(transparencyShard)
                .setDepthTestState(if (k.depthTest) LEQUAL_DEPTH_TEST else NO_DEPTH_TEST)
                .setCullState(if (k.cull) CULL else NO_CULL)
                .setWriteMaskState(if (k.depthWrite) COLOR_DEPTH_WRITE else COLOR_WRITE)
                .createCompositeState(false)

            val safeName = "epiphy_item3d_${k.hashCode().toUInt().toString(16)}"
            val created: RenderType = RenderType.create(
                safeName,
                DefaultVertexFormat.POSITION_COLOR_TEX,
                VertexFormat.Mode.QUADS,
                1024,
                false,
                false,
                state
            )
            created
        }
    }

    /**
     * 刷新当前 `bufferSource`（启用隔离模式时即单物品私有的 `isolatedBufferSource`）中基底 `BakedModel` 的 `RenderType`，
     * 使基底模型的颜色与深度先于自定义 3D 图层写入硬件缓冲。
     */
    private fun flushBaseModelRenderTypes(
        bufferSource: MultiBufferSource.BufferSource,
        stack: ItemStack,
        displayContext: ItemDisplayContext,
        bakedModel: BakedModel
    ) {
        if (isKnownIsolatedSlot(bufferSource)) {
            bufferSource.endBatch()
            isolatedFlushes.incrementAndGet()
            return
        }

        val fabulous = if (displayContext != ItemDisplayContext.GUI && !displayContext.firstPerson() && stack.item is BlockItem) {
            val block = (stack.item as BlockItem).block
            block !is HalfTransparentBlock && block !is StainedGlassPaneBlock
        } else {
            true
        }

        for (passModel in bakedModel.getRenderPasses(stack, fabulous)) {
            for (rt in passModel.getRenderTypes(stack, fabulous)) {
                bufferSource.endBatch(rt)
            }
        }

        if (stack.hasFoil()) {
            if (fabulous) {
                bufferSource.endBatch(RenderType.glintDirect())
                bufferSource.endBatch(RenderType.entityGlintDirect())
            } else {
                bufferSource.endBatch(RenderType.glintTranslucent())
                bufferSource.endBatch(RenderType.glint())
                bufferSource.endBatch(RenderType.entityGlint())
            }
        }
    }

    private fun renderCompiledItem(
        model: CompiledItemModel,
        stack: ItemStack,
        displayContext: ItemDisplayContext,
        poseStack: PoseStack,
        bufferSource: MultiBufferSource,
        bakedModel: BakedModel
    ) {
        if (!enabled || model.passes.isEmpty() || passCircuitBreaker.isTripped) return
        val t0 = System.nanoTime()
        val isGui = (displayContext == ItemDisplayContext.GUI)
        renderCalls.incrementAndGet()
        if (isGui) guiCalls.incrementAndGet() else handCalls.incrementAndGet()

        val timeSec = ((t0 - T0_NANOS) * 1e-9f) * model.speedMul
        var yawRad = 0.0f
        var pitchRad = 0.0f
        var attackProg = 0.0f
        var attackScale = 1.0f

        val mc = Minecraft.getInstance()
        if (!isGui && mc != null) {
            val player = mc.player
            if (player != null) {
                val pt = mc.frameTime
                yawRad = Math.toRadians(player.getViewYRot(pt).toDouble()).toFloat()
                pitchRad = Math.toRadians(player.getViewXRot(pt).toDouble()).toFloat()
                val sw = player.getAttackAnim(pt)
                if (sw.isFinite() && sw > 0.001f && sw < 0.999f) {
                    attackProg = sw
                    if (model.attackExpand != 0.0f) {
                        val s = 1.0f + sin(sw * PI.toFloat()) * model.attackExpand
                        if (s.isFinite()) attackScale = s
                    }
                }
            }
        }

        if (model.renderBase && model.flushBase && bufferSource is MultiBufferSource.BufferSource && !bakedModel.isCustomRenderer) {
            try {
                flushBaseModelRenderTypes(bufferSource, stack, displayContext, bakedModel)
            } catch (err: Throwable) {
                RenderFaultCircuitBreaker.rethrowIfFatalJvmError(err)
                passCircuitBreaker.recordFailure(err, "${model.itemId}/flushBase")
            }
        }

        val radScale = if (isGui) (model.guiScale * guiGlobalScale) else attackScale
        var lastDrawnRt: RenderType? = null

        for (pass in model.passes) {
            if (pass.isOverlay && !overlaysEnabled) continue
            if (!pass.isOverlay && !geometryEnabled) continue
            if (pass.visibleIn == "hand" && isGui) continue
            if (pass.visibleIn == "gui" && !isGui) continue
            if (pass.shaderId != null && EpiphyCoreShaders.getShaderByString(pass.shaderId) == null) {
                continue
            }

            try {
                if (pass.shaderId != null && pass.uniforms.isNotEmpty()) {
                    applyUniforms(pass.shaderId, pass.uniforms, timeSec, yawRad, pitchRad, isGui, attackProg)
                }

                val vc = bufferSource.getBuffer(pass.renderType)
                poseStack.pushPose()
                try {
                    val tr = pass.transform
                    if (tr.mode != "identity") {
                        var tx = tr.cx
                        var ty = tr.cy
                        val tz = tr.cz
                        if (tr.mode == "local_axis_bob" && tr.bobAmp != 0.0f) {
                            val bob = sin(timeSec * tr.bobFreq + tr.bobPhase) * tr.bobAmp
                            tx += tr.axisDirX * bob
                            ty += tr.axisDirY * bob
                        }
                        poseStack.translate(tx, ty, tz)
                        if (tr.axisAngleRad != 0.0f) poseStack.mulPose(Axis.ZP.rotation(tr.axisAngleRad))
                        if (radScale != 1.0f) {
                            when (tr.scaleWithAttack) {
                                "radial" -> poseStack.scale(1.0f, radScale, radScale)
                                "none" -> {}
                                else -> poseStack.scale(radScale, radScale, radScale)
                            }
                        }
                        if (tr.tiltV != 0.0f) poseStack.mulPose(Axis.ZP.rotation(tr.tiltV))
                        if (tr.tiltU != 0.0f) poseStack.mulPose(Axis.YP.rotation(tr.tiltU))
                        if (tr.spinSpeed != 0.0f) poseStack.mulPose(Axis.XP.rotation(timeSec * tr.spinSpeed))
                    }

                    val mat = poseStack.last().pose()
                    val verts = pass.vertexXyzUv
                    val cols = pass.vertexRgba
                    var vIdx = 0
                    for (cIdx in cols.indices) {
                        val rgba = cols[cIdx]
                        val r = (rgba ushr 24) and 0xFF
                        val g = (rgba ushr 16) and 0xFF
                        val b = (rgba ushr 8) and 0xFF
                        val a = rgba and 0xFF
                        vc.vertex(mat, verts[vIdx], verts[vIdx + 1], verts[vIdx + 2])
                            .color(r, g, b, a)
                            .uv(verts[vIdx + 3], verts[vIdx + 4])
                            .endVertex()
                        vIdx += 5
                    }
                } finally {
                    poseStack.popPose()
                }

                if (pass.flushAfter && bufferSource is MultiBufferSource.BufferSource) {
                    bufferSource.endBatch(pass.renderType)
                    lastDrawnRt = null
                } else {
                    lastDrawnRt = pass.renderType
                }

                passCircuitBreaker.recordSuccess()
                if (pass.isOverlay) overlayDraws.incrementAndGet() else geometryDraws.incrementAndGet()
            } catch (err: Throwable) {
                RenderFaultCircuitBreaker.rethrowIfFatalJvmError(err)
                lastError = "${model.itemId}/${pass.id}: ${err.message}"
                passCircuitBreaker.recordFailure(err, "${model.itemId}/${pass.id}")
            }
        }

        if (lastDrawnRt != null && bufferSource is MultiBufferSource.BufferSource) {
            try {
                bufferSource.endBatch(lastDrawnRt)
            } catch (err: Throwable) {
                RenderFaultCircuitBreaker.rethrowIfFatalJvmError(err)
                passCircuitBreaker.recordFailure(err, "${model.itemId}/tailFlush")
            }
        }

        val dtNs = max(0L, System.nanoTime() - t0)
        totalRenderNanos.addAndGet(dtNs)
        val dtUs = (dtNs / 1000.0).roundToLong()
        lastRenderUs = dtUs
        if (dtUs > maxRenderUs) maxRenderUs = dtUs
    }

    private fun applyUniforms(
        shaderId: String,
        bindings: List<Pair<String, UniformBinding>>,
        time: Float,
        yaw: Float,
        pitch: Float,
        isGui: Boolean,
        attackProg: Float
    ) {
        val handle = EpiphyCoreShaders.getShaderByString(shaderId) ?: return
        for ((uName, binding) in bindings) {
            val u = handle.uniform(uName) ?: continue
            when (binding) {
                UniformBinding.Time -> u.set(time)
                UniformBinding.ViewYaw -> u.set(yaw)
                UniformBinding.ViewPitch -> u.set(pitch)
                UniformBinding.ViewYawPitch -> u.set(yaw, pitch)
                UniformBinding.IsGui -> u.set(if (isGui) 1.0f else 0.0f)
                UniformBinding.AttackProgress -> u.set(attackProg)
                is UniformBinding.Const1f -> u.set(binding.v0)
                is UniformBinding.Const2f -> u.set(binding.v0, binding.v1)
                is UniformBinding.Const3f -> u.set(binding.v0, binding.v1, binding.v2)
                is UniformBinding.Const4f -> u.set(binding.v0, binding.v1, binding.v2, binding.v3)
            }
        }
    }

    fun collectStats(): Map<String, Any?> {
        val calls = renderCalls.get()
        val avgUs = if (calls > 0L) ((totalRenderNanos.get() / 1000.0) / calls).roundToLong() else 0L
        val bakedSummary = LinkedHashMap<String, Map<String, Int>>()
        for ((id, m) in activeModels) {
            bakedSummary[id] = mapOf(
                "passes" to m.passes.size,
                "overlays" to m.overlayCount,
                "geometries" to m.geometryCount,
                "totalVerts" to m.totalVertices
            )
        }
        return mapOf(
            "backendMode" to "native_item_hooks",
            "cclAvailable" to false,
            "boundCount" to pendingSpecs.size,
            "bakedCount" to activeModels.size,
            "unresolvedItems" to pendingSpecs.keys.filter { !activeModels.containsKey(it) }.sorted(),
            "circuitTripped" to passCircuitBreaker.isTripped,
            "bakedItems" to bakedSummary,
            "runtime" to mapOf(
                "renderCalls" to calls,
                "handCalls" to handCalls.get(),
                "guiCalls" to guiCalls.get(),
                "overlayDraws" to overlayDraws.get(),
                "geometryDraws" to geometryDraws.get(),
                "isolatedFlushes" to isolatedFlushes.get(),
                "lastRenderUs" to lastRenderUs,
                "maxRenderUs" to maxRenderUs,
                "avgRenderUs" to avgUs,
                "failureCount" to passCircuitBreaker.totalFailureCount,
                "lastError" to lastError
            )
        )
    }
}
