// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.api

import dev.epiphy.api.cache.BoundedCache
import dev.epiphy.api.cache.EvictionPolicy
import dev.epiphy.api.preset.PresetRegistry
import dev.epiphy.api.spec.EpiphyProtocolSpec
import dev.epiphy.api.spec.ProtoV6EnvelopeHeader
import dev.epiphy.api.spec.ProtoV6SchemaDocument
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths

class ProtoV6ContractAndAliasTest {

    private val json = Json { ignoreUnknownKeys = true }

    private fun locateProtoV6SchemaFile(): Path {
        val candidates = listOf(
            Paths.get("..", "..", "docs", "proto_v6_schema.json"),
            Paths.get("..", "docs", "proto_v6_schema.json"),
            Paths.get("docs", "proto_v6_schema.json")
        )
        return candidates.firstOrNull { Files.isRegularFile(it) }
            ?: error("Cannot locate docs/proto_v6_schema.json from working directory: ${Paths.get("").toAbsolutePath()}")
    }

    @Test
    fun `proto_v6_schema json matches EpiphyProtocolSpec and enforces at most 2 official aliases per field`() {
        val schemaPath = locateProtoV6SchemaFile()
        val rawJson = Files.readString(schemaPath)
        val doc = json.decodeFromString<ProtoV6SchemaDocument>(rawJson)

        assertEquals(EpiphyProtocolSpec.SCHEMA_VERSION, doc.schemaVersion)
        assertEquals(EpiphyProtocolSpec.DANMAKU_PROTO_VERSION, doc.protoVersion)
        assertEquals(EpiphyProtocolSpec.SURFACE_2D_CHANNEL, doc.channel)
        assertEquals(EpiphyProtocolSpec.COMPATIBLE_DANMAKU_PROTO_VERSIONS, doc.compatibleProtoVersions.toSet())

        // 1:1 对齐顶层与节点官方别名表
        assertEquals(doc.officialAliases.envelope, EpiphyProtocolSpec.OFFICIAL_ENVELOPE_ALIASES)
        assertEquals(doc.officialAliases.node, EpiphyProtocolSpec.OFFICIAL_NODE_ALIASES)

        // 核心铁律 4 门禁：每个主标准名映射的显式官方别名数量必须 <= 2（合计名称 <= 3）
        val envByCanonical = EpiphyProtocolSpec.OFFICIAL_ENVELOPE_ALIASES.entries.groupBy({ it.value }, { it.key })
        for ((canonical, aliases) in envByCanonical) {
            assertTrue(
                aliases.size <= 2,
                "Canonical envelope field '$canonical' exceeds max 2 official aliases: $aliases"
            )
            assertTrue(
                doc.envelope.containsKey(canonical),
                "Alias target '$canonical' must exist in proto_v6_schema.json envelope properties"
            )
        }

        val nodeByCanonical = EpiphyProtocolSpec.OFFICIAL_NODE_ALIASES.entries.groupBy({ it.value }, { it.key })
        for ((canonical, aliases) in nodeByCanonical) {
            assertTrue(
                aliases.size <= 2,
                "Canonical node field '$canonical' exceeds max 2 official aliases: $aliases"
            )
        }

        // 确认历史过渡期淘汰别名（msg / slot）在原生契约层已 100% 裁撤
        assertFalse(EpiphyProtocolSpec.OFFICIAL_ENVELOPE_ALIASES.containsKey("msg"))
        assertFalse(EpiphyProtocolSpec.OFFICIAL_ENVELOPE_ALIASES.containsKey("slot"))
    }

    @Test
    fun `single-point alias normalization strips aliases and preserves explicit canonical fields`() {
        val normalized = EpiphyProtocolSpec.normalizeEnvelopeMap(
            mapOf(
                "act" to "patch",
                "carrier" to "world_plane",
                "id" to "reactor_1",
                "ns" to "facility",
                "zIndex" to 75,
                "layers" to listOf(mapOf("kind" to "rect", "tint" to 0xFF00FF))
            )
        )

        assertEquals("patch", normalized["action"])
        assertEquals("world_plane", normalized["surface"])
        assertEquals("reactor_1", normalized["slotId"])
        assertEquals("facility", normalized["namespace"])
        assertEquals(75, normalized["renderPriority"])
        assertFalse(normalized.containsKey("act"))
        assertFalse(normalized.containsKey("carrier"))
        assertFalse(normalized.containsKey("id"))

        // 主标准名与别名同时出现时，优先保留主标准名
        val conflict = EpiphyProtocolSpec.normalizeEnvelopeMap(
            mapOf("action" to "push", "act" to "clear")
        )
        assertEquals("push", conflict["action"])
        assertFalse(conflict.containsKey("act"))

        val normNode = EpiphyProtocolSpec.normalizeNodeMap(
            mapOf(
                "kind" to "group",
                "items" to listOf(mapOf("kind" to "sprite", "tex" to "epiphy:textures/effect/star_flare.png"))
            )
        )
        assertEquals("group", normNode["type"])
        assertFalse(normNode.containsKey("kind"))
        val children = normNode["children"] as List<*>
        val child0 = children[0] as Map<*, *>
        assertEquals("sprite", child0["type"])
        assertEquals("epiphy:textures/effect/star_flare.png", child0["texture"])
    }

    @Test
    fun `SemVer closed range and BoundedCache FIFO vs LRU behave deterministically`() {
        assertTrue(SemVer.isInClosedRange("2.8.1", "2.6.0", "2.9.9"))
        assertFalse(SemVer.isInClosedRange("3.0.0", "2.6.0", "2.9.9"))
        assertTrue(SemVer.parse("1.0.0") > SemVer.parse("1.0.0-alpha.1"))

        val lru = BoundedCache<String, Int>(2, EvictionPolicy.LRU)
        lru.set("a", 1)
        lru.set("b", 2)
        assertEquals(1, lru.get("a")) // 访问 "a" 使其成为最近使用
        lru.set("c", 3)               // 淘汰最久未访问的 "b"
        assertNull(lru.get("b"))
        assertEquals(1, lru.get("a"))
        assertEquals(3, lru.get("c"))
        assertEquals(1L, lru.evictions)

        val fifo = BoundedCache<String, Int>(2, EvictionPolicy.FIFO)
        fifo.set("a", 1)
        fifo.set("b", 2)
        assertEquals(1, fifo.get("a")) // FIFO 下访问不延长寿命
        fifo.set("c", 3)                // 淘汰最早插入的 "a"
        assertNull(fifo.get("a"))
        assertEquals(2, fifo.get("b"))
    }

    @Test
    fun `PresetRegistry supports upward registration and kotlinx serialization roundtrip`() {
        val reg = PresetRegistry.domain<Map<String, Any?>>("test_m0_surface")
        reg.clear()
        reg.register("banner_static", mapOf("surface" to "screen", "priority" to 4))
        reg.registerFactory("banner_dyn") { ctx -> mapOf("title" to "Hello ${ctx["user"]}") }

        assertEquals(4, reg.resolve("banner_static")?.get("priority"))
        assertEquals("Hello Alice", reg.resolve("banner_dyn", mapOf("user" to "Alice"))?.get("title"))

        val env = ProtoV6EnvelopeHeader(slotId = "hud_main", renderPriority = 50)
        val encoded = json.encodeToString(ProtoV6EnvelopeHeader.serializer(), env)
        val decoded = json.decodeFromString(ProtoV6EnvelopeHeader.serializer(), encoded)
        assertNotNull(decoded)
        assertEquals("hud_main", decoded.slotId)
        assertEquals(50, decoded.renderPriority)
    }
}
