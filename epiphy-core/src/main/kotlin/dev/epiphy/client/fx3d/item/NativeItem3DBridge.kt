// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.client.fx3d.item

import dev.epiphy.client.shader.EpiphyCoreShaders
import net.minecraft.client.renderer.RenderType
import net.minecraft.resources.ResourceLocation

/**
 * 面向脚本层暴露的物品 3D 动态绑定桥接门面（仅在客户端注册至 `EpiphyBridgeRegistry`）。
 *
 * 工作机制：
 * 1. 将脚本层传入的面片顶点、颜色、显式混合模式与运动学配置解析并校验为 `NativeItem3DEngine.CompiledItemModel`（过滤非有限浮点坐标）；
 * 2. 通过 [bindCompiledItemWithStatus] 如实返回挂载结果（`"BOUND"`、`"PENDING_REGISTRY"`、`"EMPTY_PASSES"`、`"INVALID_ID"`），避免将延迟挂起或空面片误报为已成功绑定；
 * 3. 混合模式交由 [NativeItem3DEngine.BlendMode.parseOrWarn] 显式解析，未知字符串输出一次性告警并回退至 `"translucent"`。
 *
 * 已知边界：
 * - 在 KubeJS `startup_scripts` 早期调用时，若目标物品尚未完成 Forge 注册表注入，方法会返回 `"PENDING_REGISTRY"`（而 [bindCompiledItemFromJs] 返回 `false`），需待 `FMLClientSetupEvent` 触发 `rebindAllPending()` 完成最终绑定。
 */
object NativeItem3DBridge {

    /** 供无头单元测试替换 `RenderType` 构造逻辑，避免在未初始化 OpenGL 上下文时创建客户端 `RenderStateShard`。 */
    @Volatile
    internal var renderTypeFactoryOverrideForTest: ((
        shaderId: String?,
        texStr: String,
        blendMode: NativeItem3DEngine.BlendMode,
        blur: Boolean,
        cull: Boolean,
        depthWrite: Boolean,
        depthTest: Boolean
    ) -> RenderType)? = null

    fun setConfig(enabled: Boolean, overlaysEnabled: Boolean, geometryEnabled: Boolean, guiGlobalScale: Float) {
        NativeItem3DEngine.enabled = enabled
        NativeItem3DEngine.overlaysEnabled = overlaysEnabled
        NativeItem3DEngine.geometryEnabled = geometryEnabled
        NativeItem3DEngine.guiGlobalScale = guiGlobalScale
    }

    fun registerShader(shaderId: String, vertexFormat: String?, uniformNames: List<*>): Boolean {
        val names = uniformNames.mapNotNull { it?.toString()?.trim()?.takeIf(String::isNotEmpty) }
        return EpiphyCoreShaders.registerDynamicShader(shaderId, vertexFormat, names)
    }

    fun getShaderDiagnostics(): Map<String, Map<String, Any?>> = EpiphyCoreShaders.getShaderDiagnostics()

    fun unbindItem(itemId: String): Boolean = NativeItem3DEngine.unregisterItem(itemId)

    fun getStats(): Map<String, Any?> = NativeItem3DEngine.collectStats()

    /**
     * 编译并尝试将物品 3D 模型挂载至注册表，返回明确状态码：
     * - `"BOUND"`：已在 `ForgeRegistries.ITEMS` 解析到物品并完成挂载；
     * - `"PENDING_REGISTRY"`：模型面片有效，但物品尚未在注册表就绪，已登记至待重绑表；
     * - `"EMPTY_PASSES"`：无任何通过有限值与结构校验的有效面片；
     * - `"INVALID_ID"`：`itemId` 为空或不是合法的 `ResourceLocation`。
     */
    @JvmOverloads
    fun bindCompiledItemWithStatus(
        itemId: String,
        speedMul: Double,
        attackExpand: Double,
        guiScale: Double,
        rawPasses: List<*>,
        flushBase: Boolean = true,
        renderBase: Boolean = true
    ): String {
        val cleanId = itemId.trim()
        if (cleanId.isEmpty() || ResourceLocation.tryParse(cleanId) == null) {
            return NativeItem3DEngine.BindStatus.INVALID_ID.name
        }
        val model = parseCompiledItemModel(cleanId, speedMul, attackExpand, guiScale, rawPasses, flushBase, renderBase)
        if (model.passes.isEmpty() || model.totalVertices <= 0) {
            return NativeItem3DEngine.BindStatus.EMPTY_PASSES.name
        }
        return NativeItem3DEngine.registerCompiledItemWithStatus(model).name
    }

    /**
     * 布尔兼容入口：仅当物品已真实解析并挂载至 `Item3DRenderHooks`（即状态为 `"BOUND"`）时返回 `true`。
     */
    @JvmOverloads
    fun bindCompiledItemFromJs(
        itemId: String,
        speedMul: Double,
        attackExpand: Double,
        guiScale: Double,
        rawPasses: List<*>,
        flushBase: Boolean = true,
        renderBase: Boolean = true
    ): Boolean =
        bindCompiledItemWithStatus(itemId, speedMul, attackExpand, guiScale, rawPasses, flushBase, renderBase) ==
            NativeItem3DEngine.BindStatus.BOUND.name

    internal fun parseCompiledItemModel(
        cleanId: String,
        speedMul: Double,
        attackExpand: Double,
        guiScale: Double,
        rawPasses: List<*>,
        flushBase: Boolean,
        renderBase: Boolean
    ): NativeItem3DEngine.CompiledItemModel {
        val bakedPasses = ArrayList<NativeItem3DEngine.BakedPass>(rawPasses.size)
        var overlayCount = 0
        var geomCount = 0
        var totalVerts = 0

        for (rawPass in rawPasses) {
            val map = rawPass as? Map<*, *> ?: continue
            val passId = map["id"]?.toString() ?: "layer"
            val category = map["category"]?.toString() ?: "geometry"
            val isOverlay = (category == "overlay")
            val visibleIn = map["visibleIn"]?.toString() ?: "all"

            val matMap = map["material"] as? Map<*, *> ?: emptyMap<Any?, Any?>()
            val shaderId = matMap["shader"]?.toString()?.takeIf { it.isNotBlank() }
            val texStr = matMap["texture"]?.toString() ?: "epiphy:textures/effect/white_pixel.png"
            val blendMode = NativeItem3DEngine.BlendMode.parseOrWarn(
                matMap["blend"]?.toString(),
                "$cleanId/$passId"
            )
            val blur = (matMap["blur"] as? Boolean) ?: true
            val cull = (matMap["cull"] as? Boolean) ?: false
            val depthTest = (matMap["depthTest"] as? Boolean) ?: true
            val depthWrite = (matMap["depthWrite"] as? Boolean) ?: false
            val flushAfter = (matMap["flushAfter"] as? Boolean) ?: false

            val rawVerts = map["xyzUv"] as? List<*> ?: continue
            val rawCols = map["rgba"] as? List<*> ?: continue
            val vertCount = rawCols.size
            if (vertCount == 0 || (vertCount and 3) != 0 || rawVerts.size < vertCount * 5) continue

            val xyzUv = FloatArray(vertCount * 5)
            var finiteOk = true
            for (i in xyzUv.indices) {
                val f = (rawVerts[i] as? Number)?.toFloat() ?: Float.NaN
                if (!f.isFinite()) {
                    finiteOk = false
                    break
                }
                xyzUv[i] = f
            }
            if (!finiteOk) continue

            val rgba = IntArray(vertCount)
            for (i in 0 until vertCount) {
                rgba[i] = (rawCols[i] as? Number)?.toLong()?.toInt() ?: -1
            }

            val trMap = map["transform"] as? Map<*, *> ?: emptyMap<Any?, Any?>()
            val trSpec = NativeItem3DEngine.TransformSpec(
                mode = trMap["mode"]?.toString() ?: "identity",
                cx = numF(trMap["cx"], 0.5f),
                cy = numF(trMap["cy"], 0.5f),
                cz = numF(trMap["cz"], 0.5f),
                axisDirX = numF(trMap["axisDirX"], 1.0f),
                axisDirY = numF(trMap["axisDirY"], 0.0f),
                axisAngleRad = numF(trMap["axisAngleRad"], 0.0f),
                tiltU = numF(trMap["tiltU"], 0.0f),
                tiltV = numF(trMap["tiltV"], 0.0f),
                spinSpeed = numF(trMap["spinSpeed"], 0.0f),
                bobAmp = numF(trMap["bobAmp"], 0.0f),
                bobFreq = numF(trMap["bobFreq"], 0.0f),
                bobPhase = numF(trMap["bobPhase"], 0.0f),
                scaleWithAttack = trMap["scaleWithAttack"]?.toString() ?: "uniform"
            )

            val uniformList = ArrayList<Pair<String, NativeItem3DEngine.UniformBinding>>()
            val uMap = map["uniforms"] as? Map<*, *>
            if (uMap != null) {
                for ((uk, uv) in uMap) {
                    val uName = uk?.toString() ?: continue
                    val parsed = parseUniformBinding(uv) ?: continue
                    uniformList.add(uName to parsed)
                }
            }

            val overrideFactory = renderTypeFactoryOverrideForTest
            val rt = if (overrideFactory != null) {
                overrideFactory(shaderId, texStr, blendMode, blur, cull, depthWrite, depthTest)
            } else {
                NativeItem3DEngine.getOrCreateRenderType(shaderId, texStr, blendMode, blur, cull, depthWrite, depthTest)
            }
            bakedPasses.add(
                NativeItem3DEngine.BakedPass(
                    id = passId,
                    isOverlay = isOverlay,
                    visibleIn = visibleIn,
                    renderType = rt,
                    shaderId = shaderId,
                    depthTest = depthTest,
                    flushAfter = flushAfter,
                    uniforms = uniformList,
                    transform = trSpec,
                    vertexXyzUv = xyzUv,
                    vertexRgba = rgba
                )
            )
            totalVerts += vertCount
            if (isOverlay) overlayCount++ else geomCount++
        }

        return NativeItem3DEngine.CompiledItemModel(
            itemId = cleanId,
            renderBase = renderBase,
            flushBase = flushBase,
            speedMul = speedMul.toFloat().let { if (it.isFinite()) it else 1.0f },
            attackExpand = attackExpand.toFloat().let { if (it.isFinite()) it else 0.0f },
            guiScale = guiScale.toFloat().let { if (it.isFinite()) it else 0.86f },
            passes = bakedPasses,
            overlayCount = overlayCount,
            geometryCount = geomCount,
            totalVertices = totalVerts
        )
    }

    private fun numF(raw: Any?, def: Float): Float {
        val f = (raw as? Number)?.toFloat() ?: return def
        return if (f.isFinite()) f else def
    }

    internal fun parseUniformBinding(raw: Any?): NativeItem3DEngine.UniformBinding? = when (raw) {
        is String -> when (raw) {
            "time" -> NativeItem3DEngine.UniformBinding.Time
            "viewYaw" -> NativeItem3DEngine.UniformBinding.ViewYaw
            "viewPitch" -> NativeItem3DEngine.UniformBinding.ViewPitch
            "viewYawPitch" -> NativeItem3DEngine.UniformBinding.ViewYawPitch
            "isGui" -> NativeItem3DEngine.UniformBinding.IsGui
            "attackProgress" -> NativeItem3DEngine.UniformBinding.AttackProgress
            else -> null
        }
        is Number -> {
            val f = raw.toFloat()
            if (f.isFinite()) NativeItem3DEngine.UniformBinding.Const1f(f) else null
        }
        is List<*> -> when (raw.size) {
            2 -> NativeItem3DEngine.UniformBinding.Const2f(numF(raw[0], 0f), numF(raw[1], 0f))
            3 -> NativeItem3DEngine.UniformBinding.Const3f(numF(raw[0], 0f), numF(raw[1], 0f), numF(raw[2], 0f))
            4 -> NativeItem3DEngine.UniformBinding.Const4f(numF(raw[0], 0f), numF(raw[1], 0f), numF(raw[2], 0f), numF(raw[3], 0f))
            else -> null
        }
        else -> null
    }
}
