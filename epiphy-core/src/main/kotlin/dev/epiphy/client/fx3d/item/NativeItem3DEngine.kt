// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.client.fx3d.item

import com.mojang.blaze3d.vertex.DefaultVertexFormat
import com.mojang.blaze3d.vertex.PoseStack
import com.mojang.blaze3d.vertex.VertexFormat
import com.mojang.logging.LogUtils
import com.mojang.math.Axis
import dev.epiphy.client.shader.EpiphyCoreShaders
import net.minecraft.client.Minecraft
import net.minecraft.client.renderer.GameRenderer
import net.minecraft.client.renderer.MultiBufferSource
import net.minecraft.client.renderer.RenderStateShard
import net.minecraft.client.renderer.RenderType
import net.minecraft.client.resources.model.BakedModel
import net.minecraft.resources.ResourceLocation
import net.minecraft.world.item.ItemDisplayContext
import net.minecraft.world.item.ItemStack
import net.minecraft.world.item.Items
import net.minecraftforge.registries.ForgeRegistries
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.PI
import kotlin.math.max
import kotlin.math.roundToLong
import kotlin.math.sin

/**
 * 100% 零 `CodeChickenLib` 原生物品三维渲染与预烘焙引擎。
 *
 * - 编译期直接调用 Mojmap / Forge API（`RenderType.create`、`ShaderStateShard`、`Item3DRenderHooks`），自动重映射 SRG；
 * - 启动期或资源重载期接收声明式编译后的紧凑网格数据（`FloatArray` 顶点 + `IntArray` 颜色），内置非有限数（NaN/Inf）防火墙；
 * - 每帧渲染 100% 运行在原生 JVM 字节码中，零 Rhino 跨界回调、零堆分配矩阵变换。
 */
object NativeItem3DEngine : RenderStateShard("epiphy_item3d_shards", Runnable {}, Runnable {}) {

    private val LOGGER = LogUtils.getLogger()
    private val T0_NANOS = System.nanoTime()

    @Volatile var enabled: Boolean = true
    @Volatile var overlaysEnabled: Boolean = true
    @Volatile var geometryEnabled: Boolean = true
    @Volatile var guiGlobalScale: Float = 1.0f

    data class MaterialKey(
        val shaderId: String?,
        val texture: ResourceLocation,
        val additive: Boolean,
        val blur: Boolean,
        val cull: Boolean,
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
        val speedMul: Float,
        val attackExpand: Float,
        val guiScale: Float,
        val passes: List<BakedPass>,
        val overlayCount: Int,
        val geometryCount: Int,
        val totalVertices: Int
    )

    private val renderTypeCache = ConcurrentHashMap<MaterialKey, RenderType>()
    private val pendingSpecs = ConcurrentHashMap<String, CompiledItemModel>()
    private val activeModels = ConcurrentHashMap<String, CompiledItemModel>()

    private val renderCalls = AtomicLong(0L)
    private val handCalls = AtomicLong(0L)
    private val guiCalls = AtomicLong(0L)
    private val overlayDraws = AtomicLong(0L)
    private val geometryDraws = AtomicLong(0L)
    private val totalRenderNanos = AtomicLong(0L)
    @Volatile private var lastRenderUs: Long = 0L
    @Volatile private var maxRenderUs: Long = 0L
    @Volatile private var lastError: String? = null

    fun registerCompiledItem(model: CompiledItemModel): Boolean {
        pendingSpecs[model.itemId] = model
        return tryBindToRegistryItem(model)
    }

    fun unregisterItem(itemId: String): Boolean {
        pendingSpecs.remove(itemId)
        activeModels.remove(itemId)
        val rl = ResourceLocation.tryParse(itemId.trim()) ?: return false
        val item = ForgeRegistries.ITEMS.getValue(rl)
        if (item != null && item != Items.AIR) {
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

    fun clearRenderTypeCache() {
        renderTypeCache.clear()
    }

    private fun tryBindToRegistryItem(model: CompiledItemModel): Boolean {
        val rl = ResourceLocation.tryParse(model.itemId.trim()) ?: return false
        val item = runCatching { ForgeRegistries.ITEMS.getValue(rl) }.getOrNull() ?: return false
        if (item == Items.AIR) return false

        activeModels[model.itemId] = model
        Item3DRenderHooks.bindItem(item) { stack, displayContext, _, poseStack, bufferSource, _, _, _ ->
            renderCompiledItem(model, stack, displayContext, poseStack, bufferSource)
        }
        return true
    }

    fun getOrCreateRenderType(
        shaderId: String?,
        textureStr: String,
        additive: Boolean,
        blur: Boolean,
        cull: Boolean,
        depthWrite: Boolean
    ): RenderType {
        val texRl = ResourceLocation.tryParse(
            if (':' in textureStr) textureStr.trim() else "epiphy:${textureStr.trim()}"
        ) ?: ResourceLocation("epiphy", "textures/effect/white_pixel.png")

        val key = MaterialKey(shaderId?.takeIf { it.isNotBlank() }, texRl, additive, blur, cull, depthWrite)
        return renderTypeCache.computeIfAbsent(key) { k ->
            val shaderShard = if (k.shaderId != null) {
                ShaderStateShard {
                    EpiphyCoreShaders.getShaderByString(k.shaderId)?.instance
                        ?: GameRenderer.getPositionColorTexShader()
                }
            } else {
                POSITION_COLOR_TEX_SHADER
            }
            val state = RenderType.CompositeState.builder()
                .setShaderState(shaderShard)
                .setTextureState(TextureStateShard(k.texture, k.blur, false))
                .setTransparencyState(if (k.additive) LIGHTNING_TRANSPARENCY else TRANSLUCENT_TRANSPARENCY)
                .setCullState(if (k.cull) CULL else NO_CULL)
                .setWriteMaskState(if (k.depthWrite) COLOR_DEPTH_WRITE else COLOR_WRITE)
                .createCompositeState(false)

            val safeName = "epiphy_item3d_${k.hashCode().toUInt().toString(16)}"
            RenderType.create(
                safeName,
                DefaultVertexFormat.POSITION_COLOR_TEX,
                VertexFormat.Mode.QUADS,
                1024,
                false,
                false,
                state
            )
        }
    }

    private fun renderCompiledItem(
        model: CompiledItemModel,
        stack: ItemStack,
        displayContext: ItemDisplayContext,
        poseStack: PoseStack,
        bufferSource: MultiBufferSource
    ) {
        if (!enabled || model.passes.isEmpty()) return
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

        // ItemRendererMixin 在 PoseStack.popPose() 之前注入，此时栈顶已处于模型局部空间 [-0.5, -0.5, -0.5] (对应 [0..1] 坐标)
        val radScale = if (isGui) (model.guiScale * guiGlobalScale) else attackScale

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
                }

                if (pass.isOverlay) overlayDraws.incrementAndGet() else geometryDraws.incrementAndGet()
            } catch (err: Throwable) {
                lastError = "${model.itemId}/${pass.id}: ${err.message}"
                LOGGER.debug("[NativeItem3D] Pass error in {}/{}: {}", model.itemId, pass.id, err.toString())
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
            "bakedItems" to bakedSummary,
            "runtime" to mapOf(
                "renderCalls" to calls,
                "handCalls" to handCalls.get(),
                "guiCalls" to guiCalls.get(),
                "overlayDraws" to overlayDraws.get(),
                "geometryDraws" to geometryDraws.get(),
                "lastRenderUs" to lastRenderUs,
                "maxRenderUs" to maxRenderUs,
                "avgRenderUs" to avgUs,
                "lastError" to lastError
            )
        )
    }
}
