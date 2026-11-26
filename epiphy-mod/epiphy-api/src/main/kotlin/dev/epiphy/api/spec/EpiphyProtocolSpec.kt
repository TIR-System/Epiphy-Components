// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.api.spec

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * Epiphy 跨端协议核心常量与官方双别名上限规范（Phase 4 原生版）。
 *
 * 严格遵循迁移计划书 §1.1 铁律 4：
 * - 每个标准字段保留「1 个主标准名 + 至多 2 个显式官方别名（合计 <= 3 个名称）」；
 * - 彻底移除历史过渡期 `DEPRECATED_*_ALIASES`；
 * - 所有官方别名均在 API/DSL/JSON 入口单点归一化为主标准名，内部管线与二进制网络帧零别名。
 */
object EpiphyProtocolSpec {
    const val SCHEMA_VERSION: String = "6.3.0"
    const val MAIN_NETWORK_CHANNEL: String = "epiphy:main"
    const val MAIN_NETWORK_PROTOCOL_VERSION: String = "1"

    // 兼容 KubeJS S2C 通道标识
    const val SURFACE_2D_CHANNEL: String = "epiphy:screen_danmaku"
    const val SPATIAL_FX_CHANNEL: String = "epiphy:spatial_fx"
    const val AUDIO_CHANNEL: String = "epiphy:audio"
    const val RENDER_DEBUG_CHANNEL: String = "epiphy:render_debug"

    const val DANMAKU_PROTO_VERSION: Int = 6
    val COMPATIBLE_DANMAKU_PROTO_VERSIONS: Set<Int> = setOf(5, 6)
    const val FX3D_PROTO_VERSION: Int = 1
    const val AUDIO_PROTO_VERSION: Int = 5

    // 绘制开销配额上限（对齐 rendering-subsystem-roadmap.md §3.2）
    const val PLAYER_SINGLE_OVERLAY_MAX_COST: Int = 24
    const val PLAYER_SCREEN_TOTAL_MAX_COST: Int = 120
    const val SYSTEM_SINGLE_OVERLAY_MAX_COST: Int = 96
    const val SYSTEM_SCREEN_TOTAL_MAX_COST: Int = 600

    /**
     * 顶层信封显式官方别名映射（alias -> canonical）。
     * 与 `docs/proto_v6_schema.json` `officialAliases.envelope` 1:1 严格对齐。
     */
    val OFFICIAL_ENVELOPE_ALIASES: Map<String, String> = mapOf(
        "act" to "action",
        "carrier" to "surface",
        "layers" to "nodes",
        "texMap" to "replaceTextures",
        "bg" to "bgNodes",
        "fg" to "fgNodes",
        "at" to "worldPos",
        "facing" to "billboard",
        "xray" to "seeThrough",
        "shake" to "shakeMode",
        "zIndex" to "renderPriority",
        "text" to "title",
        "subtitle" to "sub",
        "id" to "slotId",
        "size" to "scale",
        "tilt" to "angle",
        "duration" to "stay",
        "hold" to "activeHold",
        "fade" to "fadeStyle",
        "fadeTicks" to "fadeOut",
        "outline" to "outlineMode",
        "ns" to "namespace"
    )

    /**
     * 2D 图元节点显式官方别名映射（alias -> canonical）。
     * 与 `docs/proto_v6_schema.json` `officialAliases.node` 1:1 严格对齐。
     */
    val OFFICIAL_NODE_ALIASES: Map<String, String> = mapOf(
        "kind" to "type",
        "tint" to "color",
        "tex" to "texture",
        "items" to "children"
    )

    val VALID_ACTIONS: Set<String> = setOf("push", "patch", "deactivate", "clear")
    val VALID_SURFACES: Set<String> = setOf("screen", "gui", "slot", "world_plane")
    val VALID_TIERS: Set<String> = setOf("system", "player")
    val VALID_LIFE_MODES: Set<String> = setOf("once", "active", "screen_session")
    val VALID_NODE_TYPES: Set<String> = setOf("rect", "sprite", "nine_slice", "item", "text", "group")
    val VALID_FILL_MODES: Set<String> = setOf("solid", "outline", "gradient", "parallax", "shader", "mask")
    val VALID_CLIP_MODES: Set<String> = setOf("local", "scissor")
    val VALID_TRACK_MODES: Set<String> = setOf("lerp", "trail", "impulse")

    @JvmStatic
    fun isProtoCompatible(expected: Int, incoming: Int): Boolean {
        if (expected == DANMAKU_PROTO_VERSION) {
            return incoming in COMPATIBLE_DANMAKU_PROTO_VERSIONS
        }
        return incoming == expected
    }

    /**
     * 入口单点归一化：将顶层信封中的官方别名映射为主标准名（主标准名已存在时优先保留主标准名，并剔除别名键实现内部零别名）。
     */
    @JvmStatic
    fun normalizeEnvelopeMap(raw: Map<String, Any?>): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>(raw.size)
        for ((k, v) in raw) {
            if (!OFFICIAL_ENVELOPE_ALIASES.containsKey(k)) {
                out[k] = v
            }
        }
        for ((alias, canonical) in OFFICIAL_ENVELOPE_ALIASES) {
            if (raw.containsKey(alias) && !out.containsKey(canonical)) {
                val aliasVal = raw[alias]
                if (aliasVal != null) {
                    out[canonical] = aliasVal
                }
            }
        }
        return out
    }

    /**
     * 入口单点归一化：将图元节点中的官方别名递归映射为主标准名（内部零别名）。
     */
    @JvmStatic
    fun normalizeNodeMap(raw: Map<String, Any?>, depth: Int = 0): Map<String, Any?> {
        if (depth > 6) return raw
        val out = LinkedHashMap<String, Any?>(raw.size)
        for ((k, v) in raw) {
            if (!OFFICIAL_NODE_ALIASES.containsKey(k)) {
                out[k] = v
            }
        }
        for ((alias, canonical) in OFFICIAL_NODE_ALIASES) {
            if (raw.containsKey(alias) && !out.containsKey(canonical)) {
                val aliasVal = raw[alias]
                if (aliasVal != null) {
                    out[canonical] = aliasVal
                }
            }
        }
        val rawChildren = out["children"]
        if (rawChildren is List<*>) {
            out["children"] = rawChildren.map { child ->
                if (child is Map<*, *>) {
                    @Suppress("UNCHECKED_CAST")
                    normalizeNodeMap(child as Map<String, Any?>, depth + 1)
                } else {
                    child
                }
            }
        }
        return out
    }
}

/**
 * 机器可读 `docs/proto_v6_schema.json` 反序列化结构（供契约校验与运行时 JSON Schema 守卫共用）。
 */
@Serializable
data class ProtoV6SchemaDocument(
    val schemaVersion: String,
    val protoVersion: Int,
    val compatibleProtoVersions: List<Int>,
    val channel: String,
    val officialAliases: OfficialAliasesSection,
    val actions: List<String>,
    val surfaces: List<String>,
    val tiers: List<String>,
    val lifeModes: List<String>,
    val defaultRenderPriority: Map<String, Int>,
    val requiredByAction: Map<String, List<String>>,
    val envelope: Map<String, JsonObject>,
    val node: NodeSchemaSection,
    val fill: ModesSection,
    val clip: ClipSchemaSection,
    val track: ModesSection
) {
    @Serializable
    data class OfficialAliasesSection(
        val envelope: Map<String, String>,
        val node: Map<String, String>
    )

    @Serializable
    data class NodeSchemaSection(
        val types: List<String>,
        val anchors: List<String>,
        val commonFields: List<String>
    )

    @Serializable
    data class ModesSection(
        val modes: List<String>
    )

    @Serializable
    data class ClipSchemaSection(
        val dirs: List<String>,
        val modes: List<String>
    )
}

/**
 * 轻量声明式协议信封核心数据模型（支持 `kotlinx.serialization` JSON 编解码）。
 */
@Serializable
data class ProtoV6EnvelopeHeader(
    val proto: Int = EpiphyProtocolSpec.DANMAKU_PROTO_VERSION,
    val action: String = "push",
    val surface: String = "screen",
    val tier: String = "system",
    val namespace: String = "default",
    val group: String = "default",
    val slotId: String = "",
    val key: String = "",
    val lifeMode: String = "once",
    val priority: Int = 2,
    val renderPriority: Int = 0,
    val vars: Map<String, JsonElement> = emptyMap()
)
