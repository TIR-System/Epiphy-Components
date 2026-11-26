// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.client.shader

import com.mojang.blaze3d.shaders.Uniform
import com.mojang.blaze3d.vertex.DefaultVertexFormat
import com.mojang.blaze3d.vertex.VertexFormat
import com.mojang.logging.LogUtils
import net.minecraft.client.renderer.ShaderInstance
import net.minecraft.resources.ResourceLocation
import net.minecraftforge.client.event.RegisterShadersEvent
import java.util.concurrent.ConcurrentHashMap

/**
 * 原生 `ShaderInstance` 注册与强类型 `Uniform` 预缓存中心（100% 原版机制，彻底替代 `CCShaderInstance`）。
 */
object EpiphyCoreShaders {
    private val LOGGER = LogUtils.getLogger()

    data class CompiledShaderHandle(
        val id: ResourceLocation,
        val instance: ShaderInstance,
        val uniforms: Map<String, Uniform>
    ) {
        fun uniform(name: String): Uniform? = uniforms[name]
    }

    private data class ShaderSpec(
        val id: ResourceLocation,
        val format: VertexFormat,
        val uniformNames: List<String>
    )

    private val specs = ConcurrentHashMap<ResourceLocation, ShaderSpec>()
    private val loadedShaders = ConcurrentHashMap<ResourceLocation, CompiledShaderHandle>()

    val UI_MASKED_FILL_ID: ResourceLocation = ResourceLocation.tryParse("epiphy:ui_masked_fill")!!

    @Volatile
    var uiMaskedFillShader: CompiledShaderHandle? = null
        private set

    init {
        registerShaderSpec(
            UI_MASKED_FILL_ID,
            DefaultVertexFormat.POSITION_COLOR_TEX_LIGHTMAP,
            listOf("MaskThreshold")
        )
    }

    @JvmStatic
    fun registerShaderSpec(id: ResourceLocation, format: VertexFormat, uniformNames: List<String> = emptyList()) {
        specs[id] = ShaderSpec(id, format, uniformNames)
    }

    @JvmStatic
    fun registerDynamicShader(idStr: String, formatName: String?, uniformNames: List<String>): Boolean {
        val rl = ResourceLocation.tryParse(if (':' in idStr) idStr.trim() else "epiphy:${idStr.trim()}") ?: return false
        val fmt = when (formatName?.trim()?.uppercase()) {
            "NEW_ENTITY" -> DefaultVertexFormat.NEW_ENTITY
            "POSITION_COLOR" -> DefaultVertexFormat.POSITION_COLOR
            "POSITION_COLOR_TEX_LIGHTMAP" -> DefaultVertexFormat.POSITION_COLOR_TEX_LIGHTMAP
            else -> DefaultVertexFormat.POSITION_COLOR_TEX
        }
        specs[rl] = ShaderSpec(rl, fmt, uniformNames)
        return true
    }

    @JvmStatic
    fun getShader(id: ResourceLocation): CompiledShaderHandle? = loadedShaders[id]

    @JvmStatic
    fun getShaderByString(idStr: String): CompiledShaderHandle? {
        val rl = ResourceLocation.tryParse(if (':' in idStr) idStr.trim() else "epiphy:${idStr.trim()}") ?: return null
        return loadedShaders[rl]
    }

    @JvmStatic
    fun listRegisteredShaderIds(): List<String> = specs.keys.map { it.toString() }.sorted()

    @JvmStatic
    fun getShaderDiagnostics(): Map<String, Map<String, Any?>> {
        val out = LinkedHashMap<String, Map<String, Any?>>()
        for ((id, spec) in specs) {
            val loaded = loadedShaders[id]
            val hasAllUniforms = loaded != null && spec.uniformNames.all { loaded.uniforms.containsKey(it) }
            out[id.toString()] = mapOf(
                "id" to id.toString(),
                "registered" to true,
                "loaded" to (loaded != null),
                "hasUniforms" to hasAllUniforms,
                "uniformsFound" to (loaded?.uniforms?.keys?.toList() ?: emptyList<String>())
            )
        }
        return out
    }

    internal fun onRegisterShaders(event: RegisterShadersEvent) {
        for ((id, spec) in specs) {
            runCatching {
                val inst = ShaderInstance(event.resourceProvider, id, spec.format)
                event.registerShader(inst) { loaded ->
                    val uMap = LinkedHashMap<String, Uniform>()
                    for (uName in spec.uniformNames) {
                        loaded.getUniform(uName)?.let { uMap[uName] = it }
                    }
                    val handle = CompiledShaderHandle(id, loaded, uMap)
                    loadedShaders[id] = handle
                    if (id == UI_MASKED_FILL_ID) {
                        uiMaskedFillShader = handle
                    }
                    LOGGER.debug("[EpiphyShaders] Loaded core shader '{}' (cachedUniforms={})", id, uMap.keys)
                }
            }.onFailure { err ->
                LOGGER.warn("[EpiphyShaders] Failed to register core shader '{}', fallback will apply: {}", id, err.toString())
            }
        }
    }
}
