// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.client

import com.mojang.blaze3d.vertex.DefaultVertexFormat
import com.mojang.blaze3d.vertex.VertexConsumer
import com.mojang.blaze3d.vertex.VertexFormat
import dev.epiphy.client.fx3d.item.NativeItem3DBridge
import dev.epiphy.client.surface2d.text.GlyphCaptureBackend
import dev.epiphy.client.surface2d.text.NativeTextBatchEngine
import dev.latvian.mods.rhino.Context
import dev.latvian.mods.rhino.ScriptableObject
import net.minecraft.SharedConstants
import net.minecraft.client.gui.Font
import net.minecraft.client.renderer.MultiBufferSource
import net.minecraft.client.renderer.RenderType
import net.minecraft.server.Bootstrap
import org.joml.Matrix4f
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import kotlin.math.abs

/**
 * 换芯过渡期「KubeJS 脚本实现 vs 原生 Mod 加速实现」双路径对等性回归测试（Differential / Equivalence Test）。
 *
 * 使用真实的 `rhino-forge` 引擎加载仓库内的通用组件 JS 脚本，将同一份声明式规范同时送入 JS 纯脚本路径与原生 Java/Kotlin 路径，
 * 校验两者产出的顶点数、材质签名（含 `blend` 模式、`depthTest`、`depthWrite`、`flushAfter`）、变换参数指纹与逐字抖动轨迹一致。
 */
class DualPathEquivalenceTest {

    companion object {
        @JvmStatic
        @BeforeAll
        fun bootstrapMinecraft() {
            SharedConstants.tryDetectVersion()
            Bootstrap.bootStrap()
        }

        private fun locateRepoRoot(): Path {
            val candidates = listOf(
                Paths.get("").toAbsolutePath().normalize(),
                Paths.get("..").toAbsolutePath().normalize()
            )
            return candidates.firstOrNull { Files.isRegularFile(it.resolve("settings.gradle.kts")) }
                ?: error("Cannot locate repository root containing settings.gradle.kts")
        }
    }

    private class TestRenderType(name: String) : RenderType(
        name,
        DefaultVertexFormat.POSITION_COLOR_TEX,
        VertexFormat.Mode.QUADS,
        256,
        false,
        false,
        Runnable {},
        Runnable {}
    )

    @AfterEach
    fun tearDown() {
        NativeItem3DBridge.renderTypeFactoryOverrideForTest = null
        NativeTextBatchEngine.INSTANCE.optionalBackend = null
        NativeTextBatchEngine.INSTANCE.clearCache()
    }

    private fun evalKubeJsScriptsInRhino(vararg relativeScriptPaths: String): Pair<Context, ScriptableObject> {
        val root = locateRepoRoot()
        val cx = Context.enter()
        val scope = cx.initStandardObjects()

        // 注入最小 KubeJS 宿主环境桩，使通用组件脚本可在无头 Rhino 中完整初始化并暴露 global.*._pure
        val prelude = """
            var global = {};
            var console = {
                info: function() {},
                warn: function() {},
                error: function() {},
                log: function() {}
            };
            var Platform = {
                isClientEnvironment: function() { return false; }
            };
            var ClientEvents = {
                paintScreen: function() {},
                loggedIn: function() {},
                loggedOut: function() {},
                tick: function() {}
            };
            var NetworkEvents = {
                dataReceived: function() {}
            };
            var StartupEvents = {
                registry: function() {},
                init: function() {}
            };
            var ForgeEvents = {
                onEvent: function() {}
            };
            var ForgeModEvents = {
                onEvent: function() {}
            };
            var Java = {
                loadClass: function() { return null; }
            };
        """.trimIndent()
        cx.evaluateString(scope, prelude, "test_prelude.js", 1, null)

        for (rel in relativeScriptPaths) {
            val path = root.resolve(rel)
            assertTrue(Files.isRegularFile(path), "Missing script for equivalence test: $path")
            val code = Files.readString(path, StandardCharsets.UTF_8)
            cx.evaluateString(scope, code, rel, 1, null)
        }
        return cx to scope
    }

    @Test
    fun `Item3D spec produces identical vertex counts, material keys, and transform fingerprints across JS and Native paths`() {
        val (cx, scope) = evalKubeJsScriptsInRhino(
            "kubejs/startup_scripts/通用组件/Epiphy的-Spec与通用工具.js",
            "kubejs/startup_scripts/通用组件/Epiphy的-物品三维渲染器.js"
        )
        try {
            val capturedMaterials = ArrayList<String>()
            NativeItem3DBridge.renderTypeFactoryOverrideForTest = { shaderId, texStr, blendMode, blur, cull, depthWrite, depthTest ->
                val sig = "${shaderId ?: "builtin"}|$texStr|${blendMode.wireName}|blur=$blur|cull=$cull|dw=$depthWrite|dt=$depthTest"
                capturedMaterials.add(sig)
                TestRenderType("eq_$sig")
            }

            // 在 Rhino 中构造一份覆盖 4 种内置图层原语、多种 blend 模式、visibleIn、flushAfter 与运动参数的声明式 Spec，
            // 同时导出 JS 编译出的层描述符和送往 NativeItem3DBridge 的 rawPasses 载荷
            val harnessJs = """
                var I3D = global.EpiphyItem3DRenderer;
                var rawSpec = {
                    model: { renderBase: true, flushBase: true },
                    frame: { origin: [0.5, 0.45, 0.5], axisAngleDeg: 35.0 },
                    motion: { speed: 1.35, attackExpand: 0.25 },
                    lod: { guiScale: 0.82 },
                    layers: [
                        {
                            id: 'ov_base',
                            type: 'surface_overlay',
                            visibleIn: 'all',
                            shader: 'epiphy:demo_cosmos',
                            texture: 'epiphy:textures/effect/white_pixel.png',
                            blend: 'screen',
                            depthWrite: false,
                            flushAfter: true,
                            uniforms: { Time: 'time', Gain: 1.25 }
                        },
                        {
                            id: 'ring_main',
                            type: 'ribbon_ring',
                            visibleIn: 'hand',
                            radius: 0.65,
                            width: 0.08,
                            segments: 16,
                            blend: 'additive',
                            spinSpeed: 1.2,
                            tiltU: 0.4,
                            tiltV: -0.25
                        },
                        {
                            id: 'helix_sub',
                            type: 'ribbon_helix',
                            visibleIn: 'gui',
                            radius: 0.35,
                            length: 0.9,
                            turns: 2.0,
                            strands: 2,
                            segments: 12,
                            blend: 'translucent'
                        },
                        {
                            id: 'stars',
                            type: 'sprite_cluster',
                            count: 4,
                            blend: 'multiply',
                            bobAmp: 0.06,
                            bobFreq: 2.1
                        }
                    ]
                };
                var norm = I3D._pure.normalizeItemSpec('minecraft:diamond_sword', rawSpec);
                var jsPasses = [];
                var nativePayloadPasses = [];
                for (var li = 0; li < norm.layers.length; li++) {
                    var descs = I3D._pure.compileLayerToDescriptors(norm.layers[li], norm);
                    for (var di = 0; di < descs.length; di++) {
                        var d = descs[di];
                        var vq = I3D._pure.validateQuadsFinite(d.quads).valid;
                        if (vq.length === 0) continue;
                        var xyzUv = [];
                        var rgba = [];
                        for (var qi = 0; qi < vq.length; qi++) {
                            var q = vq[qi];
                            xyzUv.push(q.p0[0], q.p0[1], q.p0[2], q.u0, q.v0);
                            rgba.push(q.rgba0 !== undefined ? q.rgba0 : q.rgba);
                            xyzUv.push(q.p1[0], q.p1[1], q.p1[2], q.u1, q.v1);
                            rgba.push(q.rgba1 !== undefined ? q.rgba1 : q.rgba);
                            xyzUv.push(q.p2[0], q.p2[1], q.p2[2], q.u2, q.v2);
                            rgba.push(q.rgba2 !== undefined ? q.rgba2 : q.rgba);
                            xyzUv.push(q.p3[0], q.p3[1], q.p3[2], q.u3, q.v3);
                            rgba.push(q.rgba3 !== undefined ? q.rgba3 : q.rgba);
                        }
                        jsPasses.push({
                            id: d.id,
                            isOverlay: d.category === 'overlay',
                            visibleIn: d.visibleIn || 'all',
                            vertCount: vq.length * 4,
                            matSig: (d.material.shader || 'builtin') + '|' + d.material.texture + '|' + d.material.blend +
                                '|blur=' + Boolean(d.material.blur) + '|cull=' + Boolean(d.material.cull) +
                                '|dw=' + Boolean(d.material.depthWrite) + '|dt=' + Boolean(d.material.depthTest),
                            flushAfter: Boolean(d.material.flushAfter),
                            trMode: d.transform.mode,
                            cx: Number(d.transform.cx != null ? d.transform.cx : 0.5),
                            cy: Number(d.transform.cy != null ? d.transform.cy : 0.5),
                            cz: Number(d.transform.cz != null ? d.transform.cz : 0.5),
                            spinSpeed: Number(d.transform.spinSpeed || 0.0),
                            bobAmp: Number(d.transform.bobAmp || 0.0)
                        });
                        nativePayloadPasses.push({
                            id: d.id,
                            category: d.category || 'geometry',
                            visibleIn: d.visibleIn || 'all',
                            material: d.material,
                            uniforms: d.uniforms,
                            transform: d.transform || { mode: 'identity' },
                            xyzUv: xyzUv,
                            rgba: rgba
                        });
                    }
                }
                var equivalenceBundle = {
                    speed: norm.motion.speed,
                    attackExpand: norm.motion.attackExpand,
                    guiScale: norm.lod.guiScale,
                    flushBase: norm.model.flushBase,
                    renderBase: norm.model.renderBase,
                    jsPasses: jsPasses,
                    nativePayloadPasses: nativePayloadPasses
                };
                equivalenceBundle;
            """.trimIndent()

            @Suppress("UNCHECKED_CAST")
            val bundle = cx.evaluateString(scope, harnessJs, "item3d_eq_harness.js", 1, null) as Map<String, Any?>
            val jsPasses = bundle["jsPasses"] as List<Map<String, Any?>>
            val nativePayloadPasses = bundle["nativePayloadPasses"] as List<*>

            val nativeModel = NativeItem3DBridge.parseCompiledItemModel(
                cleanId = "minecraft:diamond_sword",
                speedMul = (bundle["speed"] as Number).toDouble(),
                attackExpand = (bundle["attackExpand"] as Number).toDouble(),
                guiScale = (bundle["guiScale"] as Number).toDouble(),
                rawPasses = nativePayloadPasses,
                flushBase = bundle["flushBase"] as Boolean,
                renderBase = bundle["renderBase"] as Boolean
            )

            assertNotNull(nativeModel)
            assertEquals(jsPasses.size, nativeModel.passes.size, "Pass count must match between JS and Native compilers")
            assertEquals((bundle["guiScale"] as Number).toFloat(), nativeModel.guiScale, 1e-5f)
            assertEquals((bundle["speed"] as Number).toFloat(), nativeModel.speedMul, 1e-5f)
            assertEquals((bundle["attackExpand"] as Number).toFloat(), nativeModel.attackExpand, 1e-5f)

            for (i in jsPasses.indices) {
                val jp = jsPasses[i]
                val np = nativeModel.passes[i]
                assertEquals(jp["id"]?.toString(), np.id, "Pass[$i] id mismatch")
                assertEquals(jp["isOverlay"], np.isOverlay, "Pass[$i] overlay category mismatch")
                assertEquals(jp["visibleIn"]?.toString(), np.visibleIn, "Pass[$i] visibleIn mismatch")
                assertEquals((jp["vertCount"] as Number).toInt(), np.vertexCount, "Pass[$i] vertex count mismatch")
                assertEquals(jp["flushAfter"], np.flushAfter, "Pass[$i] flushAfter mismatch")
                assertEquals(jp["matSig"]?.toString(), capturedMaterials[i], "Pass[$i] material signature drift between JS and Native")
                assertEquals(jp["trMode"]?.toString(), np.transform.mode, "Pass[$i] transform.mode mismatch")
                assertEquals((jp["cx"] as Number).toFloat(), np.transform.cx, 1e-5f)
                assertEquals((jp["cy"] as Number).toFloat(), np.transform.cy, 1e-5f)
                assertEquals((jp["cz"] as Number).toFloat(), np.transform.cz, 1e-5f)
                assertEquals((jp["spinSpeed"] as Number).toFloat(), np.transform.spinSpeed, 1e-5f)
                assertEquals((jp["bobAmp"] as Number).toFloat(), np.transform.bobAmp, 1e-5f)
            }
        } finally {
            // Latvian rhino-forge Context 无全局 ThreadLocal 栈，无需静态 exit
        }
    }

    @Test
    fun `Surface2D per-char shake kinematics match within 1e-3f across JS pure sampler and NativeTextBatchEngine`() {
        val (cx, scope) = evalKubeJsScriptsInRhino(
            "kubejs/startup_scripts/通用组件/Epiphy的-Spec与通用工具.js",
            "kubejs/client_scripts/通用组件/Epiphy的-平面渲染器.js"
        )
        try {
            val unitAtlas = TestRenderType("eq_text_atlas")
            // 发射 1x1 基准顶点 (0,0) -> 经过 NativeTextBatchEngine 变换后的第 0 个顶点 (x, y) 即等于最终 (baseX + offDx, baseY + offDy)
            NativeTextBatchEngine.INSTANCE.optionalBackend = object : GlyphCaptureBackend {
                override fun currentEpoch(): Int = 1
                override fun captureGlyphs(
                    font: Font?, rawText: String, seeThrough: Boolean, preferSdf: Boolean,
                    capturer: MultiBufferSource, sentinelR: Int, sentinelG: Int, sentinelB: Int
                ): Boolean {
                    val vc = capturer.getBuffer(unitAtlas)
                    vc.vertex(0.0, 0.0, 0.0).color(sentinelR, sentinelG, sentinelB, 255).uv(0f, 0f).endVertex()
                    vc.vertex(0.0, 1.0, 0.0).color(sentinelR, sentinelG, sentinelB, 255).uv(0f, 1f).endVertex()
                    vc.vertex(1.0, 1.0, 0.0).color(sentinelR, sentinelG, sentinelB, 255).uv(1f, 1f).endVertex()
                    vc.vertex(1.0, 0.0, 0.0).color(sentinelR, sentinelG, sentinelB, 255).uv(1f, 0f).endVertex()
                    return true
                }
            }

            val styles = listOf("omni" to 0, "horizontal_step" to 1, "smooth" to 2)
            val sampleAges = listOf(0.0, 95.0, 260.0, 800.0, 1135.0)

            for ((styleName, styleCode) in styles) {
                val units = (0 until 6).map { idx ->
                    mapOf(
                        "rawText" to "G$idx",
                        "isMerged" to false,
                        "isBlank" to false,
                        "visIndex" to idx,
                        "visStart" to idx,
                        "visEnd" to (idx + 1),
                        "baseX" to (idx * 10.0f),
                        "baseY" to 20.0f,
                        "w" to 6.0f,
                        "charScale" to 1.0f,
                        "color" to 0xFFFFFF,
                        "shakeFlag" to 1,
                        "outlineMode" to "none",
                        "outlineColor" to -1,
                        "cSeed" to (37.0 + idx * 31.73),
                        "periodMs" to 800.0,
                        "invPeriod" to (1.0 / 800.0),
                        "phaseOff" to 0.0
                    )
                }

                val scene = NativeTextBatchEngine.INSTANCE.compileScene(
                    units,
                    true,
                    800.0,
                    styleCode,
                    0.32,
                    0.24,
                    0.88,
                    0.0,
                    0.0,
                    0.38,
                    false,
                    0.16,
                    0.26,
                    4.5,
                    4.5
                )

                for (ageMs in sampleAges) {
                    // 1. Native 路径渲染并读取每个字符 Quad 第 0 个顶点的最终 (x, y)
                    val nativePositions = ArrayList<Pair<Float, Float>>()
                    var vertIdx = 0
                    val captureOut = MultiBufferSource {
                        object : VertexConsumer {
                            private var lx = 0f
                            private var ly = 0f
                            override fun vertex(x: Double, y: Double, z: Double): VertexConsumer {
                                lx = x.toFloat()
                                ly = y.toFloat()
                                return this
                            }
                            override fun color(r: Int, g: Int, b: Int, a: Int): VertexConsumer = this
                            override fun uv(u: Float, v: Float): VertexConsumer = this
                            override fun overlayCoords(u: Int, v: Int): VertexConsumer = this
                            override fun uv2(u: Int, v: Int): VertexConsumer = this
                            override fun normal(x: Float, y: Float, z: Float): VertexConsumer = this
                            override fun defaultColor(r: Int, g: Int, b: Int, a: Int) {}
                            override fun unsetDefaultColor() {}
                            override fun endVertex() {
                                if ((vertIdx and 3) == 0) {
                                    nativePositions.add(lx to ly)
                                }
                                vertIdx++
                            }
                        }
                    }

                    NativeTextBatchEngine.INSTANCE.beginRenderFrame()
                    val ok = NativeTextBatchEngine.INSTANCE.renderScene(
                        scene, Matrix4f(), captureOut, null, false,
                        0, 6, ageMs, 1.15, true, false, "none", -1, 0.0f,
                        false, "shrink", 0.0f,
                        0f, 0f, 1f, 0f, 0f, 1f, 1920f, 1080f, 32f
                    )
                    assertTrue(ok)
                    assertEquals(6, nativePositions.size)

                    // 2. JS 路径使用真实 Epiphy2DRenderer._pure.sampleCharShakeOffset 计算同一时刻坐标
                    val jsCode = """
                        (function() {
                            var P = global.Epiphy2DRenderer._pure;
                            var item = {
                                charShakeStyle: '$styleName',
                                _charShakeUnifiedFreq: true,
                                _charShakeSharedPeriodMs: 800.0,
                                shakeFreqMin: 800.0,
                                shakeFreqMax: 800.0
                            };
                            var frags = [];
                            for (var i = 0; i < 6; i++) {
                                frags.push({
                                    baseX: i * 10.0,
                                    baseY: 20.0,
                                    cSeed: 37.0 + i * 31.73,
                                    periodMs: 800.0,
                                    invPeriod: 1.0 / 800.0,
                                    phaseOff: 0.0
                                });
                            }
                            var shared = P.prepareSharedCharShakeTiming(item, $ageMs, frags);
                            var out = [];
                            for (var j = 0; j < frags.length; j++) {
                                var off = P.sampleCharShakeOffset(frags[j], $ageMs, 1.15, item, { dx: 0, dy: 0, rotDeg: 0 }, shared);
                                out.push([frags[j].baseX + off.dx, frags[j].baseY + off.dy]);
                            }
                            return out;
                        })();
                    """.trimIndent()

                    @Suppress("UNCHECKED_CAST")
                    val jsPositions = cx.evaluateString(scope, jsCode, "shake_eq_$styleName.js", 1, null) as List<List<Number>>
                    assertEquals(6, jsPositions.size)

                    for (cIdx in 0 until 6) {
                        val jx = jsPositions[cIdx][0].toFloat()
                        val jy = jsPositions[cIdx][1].toFloat()
                        val (nx, ny) = nativePositions[cIdx]
                        assertTrue(
                            abs(jx - nx) <= 1e-3f && abs(jy - ny) <= 1e-3f,
                            "Shake kinematics mismatch for style='$styleName', ageMs=$ageMs, char=$cIdx: JS=($jx, $jy) vs Native=($nx, $ny)"
                        )
                    }
                }
            }
        } finally {
            // Latvian rhino-forge Context 无全局 ThreadLocal 栈，无需静态 exit
        }
    }
}
