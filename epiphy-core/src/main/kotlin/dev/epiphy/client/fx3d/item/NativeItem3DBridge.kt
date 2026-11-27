// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.client.fx3d.item

import dev.epiphy.client.shader.EpiphyCoreShaders

/**
 * 面向脚本层暴露的零 CCL 物品 3D 动态绑定桥接门面（仅在客户端注册到 `EpiphyBridgeRegistry`）。
 */
object NativeItem3DBridge {

    fun setConfig(enabled: Boolean, overlaysEnabled: Boolean, geometryEnabled: Boolean, guiGlobalScale: Float) {
        NativeItem3DEngine.enabled = enabled
        NativeItem3DEngine.overlaysEnabled = overlaysEnabled
        NativeItem3DEngine.geometryEnabled = geometryEnabled
        NativeItem3DEngine.guiGlobalScale = guiGlobalScale
    }

    fun registerShader(shaderId: String, vertexFormat: String?, uniformNames: List<*>) : Boolean {
        val names = uniformNames.mapNotNull { it?.toString()?.trim()?.takeIf(String::isNotEmpty) }
        return EpiphyCoreShaders.registerDynamicShader(shaderId, vertexFormat, names)
    }

    fun getShaderDiagnostics(): Map<String, Map<String, Any?>> = EpiphyCoreShaders.getShaderDiagnostics()

    fun unbindItem(itemId: String): Boolean = NativeItem3DEngine.unregisterItem(itemId)

    fun getStats(): Map<String, Any?> = NativeItem3DEngine.collectStats()

    /**
     * 接收脚本层编译好的面片与变换描述并烘焙为原生紧凑数组模型挂载至 `Item3DRenderHooks`。
     */
    @Suppress("UNCHECKED_CAST")
    @JvmOverloads
    fun bindCompiledItemFromJs(
        itemId: String,
        speedMul: Double,
        attackExpand: Double,
        guiScale: Double,
        rawPasses: List<*>,
        flushBase: Boolean = true,
        renderBase: Boolean = true
    ): Boolean {
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
            val additive = (matMap["blend"]?.toString()?.lowercase() != "translucent")
            val blur = (matMap["blur"] as? Boolean) ?: true
            val cull = (matMap["cull"] as? Boolean) ?: false
            val depthTest = (matMap["depthTest"] as? Boolean) ?: true
            val depthWrite = (matMap["depthWrite"] as? Boolean) ?: false
            val flushAfter = (matMap["flushAfter"] as? Boolean) ?: false

            val rawVerts = map["xyzUv"] as? List<*> ?: continue
            val rawCols = map["rgba"] as? List<*> ?: continue
            val vertCount = rawCols.size
            if (vertCount == 0 || rawVerts.size < vertCount * 5) continue

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

            val rt = NativeItem3DEngine.getOrCreateRenderType(shaderId, texStr, additive, blur, cull, depthWrite, depthTest)
            bakedPasses.add(
                NativeItem3DEngine.BakedPass(
                    id = passId,
                    isOverlay = isOverlay,
                    visibleIn = visibleIn,
                    renderType = rt,
                    shaderId = shaderId,
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

        val model = NativeItem3DEngine.CompiledItemModel(
            itemId = itemId,
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
        NativeItem3DEngine.registerCompiledItem(model)
        return true
    }

    private fun numF(raw: Any?, def: Float): Float {
        val f = (raw as? Number)?.toFloat() ?: return def
        return if (f.isFinite()) f else def
    }

    private fun parseUniformBinding(raw: Any?): NativeItem3DEngine.UniformBinding? = when (raw) {
        is String -> when (raw) {
            "time" -> NativeItem3DEngine.UniformBinding.Time
            "viewYaw" -> NativeItem3DEngine.UniformBinding.ViewYaw
            "viewPitch" -> NativeItem3DEngine.UniformBinding.ViewPitch
            "viewYawPitch" -> NativeItem3DEngine.UniformBinding.ViewYawPitch
            "isGui" -> NativeItem3DEngine.UniformBinding.IsGui
            "attackProgress" -> NativeItem3DEngine.UniformBinding.AttackProgress
            else -> null
        }
        is Number -> NativeItem3DEngine.UniformBinding.Const1f(raw.toFloat())
        is List<*> -> when (raw.size) {
            2 -> NativeItem3DEngine.UniformBinding.Const2f(numF(raw[0], 0f), numF(raw[1], 0f))
            3 -> NativeItem3DEngine.UniformBinding.Const3f(numF(raw[0], 0f), numF(raw[1], 0f), numF(raw[2], 0f))
            4 -> NativeItem3DEngine.UniformBinding.Const4f(numF(raw[0], 0f), numF(raw[1], 0f), numF(raw[2], 0f), numF(raw[3], 0f))
            else -> null
        }
        else -> null
    }
}
