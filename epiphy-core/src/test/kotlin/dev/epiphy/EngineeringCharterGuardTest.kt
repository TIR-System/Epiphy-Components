// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy

import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assertions.fail
import org.junit.jupiter.api.Test
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths

/**
 * 工程宪章编译期自动化门禁（对应根目录 `AGENTS.md` 与 `.agent/rules/epiphy-engineering-charter.md`）：
 * 1. 校验工程宪章文件存在，且核心子系统类注释包含「已知边界」说明；
 * 2. 动态扫描下游案例脚本提取专属标识，反向拦截任何案例概念或具象器械部位词汇倒灌进核心层与通用组件；
 * 3. 扫描核心源码注释与主干文档，拦截自夸修辞、绝对化断言与无测量协议支撑的裸耗时承诺。
 */
class EngineeringCharterGuardTest {

    private fun locateRepoRoot(): Path {
        val candidates = listOf(
            Paths.get("").toAbsolutePath().normalize(),
            Paths.get("..").toAbsolutePath().normalize()
        )
        return candidates.firstOrNull { Files.isRegularFile(it.resolve("settings.gradle.kts")) }
            ?: error("Unable to locate repository root containing settings.gradle.kts from ${Paths.get("").toAbsolutePath()}")
    }

    @Test
    fun `charter files exist and core subsystem classes document known boundaries`() {
        val root = locateRepoRoot()
        val requiredDocs = listOf(
            root.resolve("AGENTS.md"),
            root.resolve(".agent/rules/epiphy-engineering-charter.md"),
            root.resolve("README-LLM.md"),
            root.resolve("docs/archive/kubejs-issue-history.md")
        )
        for (doc in requiredDocs) {
            assertTrue(Files.isRegularFile(doc) && Files.size(doc) > 100L, "Required charter/guide file missing or empty: $doc")
        }

        val coreClassesRequiringBoundaries = listOf(
            "epiphy-api/src/main/kotlin/dev/epiphy/api/cache/BoundedCache.kt",
            "epiphy-core/src/main/kotlin/dev/epiphy/core/storage/AtomicJsonStore.kt",
            "epiphy-core/src/main/kotlin/dev/epiphy/core/storage/EpiphyDataManager.kt",
            "epiphy-core/src/main/kotlin/dev/epiphy/core/log/EpiphyLogEngine.kt",
            "epiphy-core/src/main/kotlin/dev/epiphy/core/debug/EpiphyDebugHub.kt",
            "epiphy-core/src/main/kotlin/dev/epiphy/core/config/EpiphyConfig.kt",
            "epiphy-core/src/main/java/dev/epiphy/core/world/NativeSectionScanner.java",
            "epiphy-core/src/main/kotlin/dev/epiphy/client/debug/EpiphyRenderPerfReporter.kt",
            "epiphy-core/src/main/kotlin/dev/epiphy/client/surface2d/fbo/FboCachePool.kt",
            "epiphy-core/src/main/kotlin/dev/epiphy/client/surface2d/hook/GuiInterceptionHooks.kt",
            "epiphy-core/src/main/kotlin/dev/epiphy/client/util/PoseStackWatermark.kt",
            "epiphy-core/src/main/kotlin/dev/epiphy/client/util/RenderFaultCircuitBreaker.kt",
            "epiphy-core/src/main/java/dev/epiphy/client/surface2d/NativeSurface2DAccelerator.java",
            "epiphy-core/src/main/java/dev/epiphy/client/surface2d/text/NativeTextBatchEngine.java",
            "epiphy-core/src/main/kotlin/dev/epiphy/client/shader/EpiphyCoreShaders.kt",
            "epiphy-core/src/main/kotlin/dev/epiphy/client/fx3d/item/Item3DRenderHooks.kt",
            "epiphy-core/src/main/kotlin/dev/epiphy/client/fx3d/item/NativeItem3DBridge.kt",
            "epiphy-core/src/main/kotlin/dev/epiphy/client/fx3d/item/NativeItem3DEngine.kt",
            "epiphy-core/src/main/java/dev/epiphy/client/fx3d/world/NativeWorld3DBatchRenderer.java",
            "epiphy-core/src/main/kotlin/dev/epiphy/client/audio/NativeAudioClientAccess.kt",
            "epiphy-core/src/compat/kotlin/dev/epiphy/compat/modernui/ModernUiGlyphCaptureBackend.kt"
        )

        val missingBoundaryDocs = ArrayList<String>()
        for (rel in coreClassesRequiringBoundaries) {
            val file = root.resolve(rel)
            assertTrue(Files.isRegularFile(file), "Expected core file does not exist: $file")
            val text = Files.readString(file, StandardCharsets.UTF_8)
            if (!text.contains("已知边界") && !text.contains("Limitations")) {
                missingBoundaryDocs.add(rel)
            }
        }

        if (missingBoundaryDocs.isNotEmpty()) {
            fail<Unit>(
                "Core subsystem classes must candidly document their known boundaries ('已知边界' or 'Limitations'), " +
                    "missing in:\n  - " + missingBoundaryDocs.joinToString("\n  - ")
            )
        }
    }

    @Test
    fun `dynamic reverse case-isolation guard blocks downstream case concepts in generic layers`() {
        val root = locateRepoRoot()

        // 1. 允许出现在核心层/通用组件中的公共协议通道、内置通用着色器与通用基础贴图白名单
        val allowedGenericIds = setOf(
            "epiphy:main",
            "epiphy:screen_danmaku",
            "epiphy:spatial_fx",
            "epiphy:audio",
            "epiphy:render_debug",
            "epiphy:ui_masked_fill",
            "epiphy:stuff"
        )
        val genericDomainNames = setOf(
            "surface", "surface2d", "audio", "block", "world", "world_ops",
            "item3d", "item3d_part", "fx3d", "progress_bar",
            "white_pixel", "glow_ribbon", "star_flare",
            "end_portal", "end_gateway",
            "screen_danmaku", "spatial_fx", "render_debug", "ui_masked_fill"
        )

        // 2. 自动扫描下游案例目录，提取所有案例注册的 epiphy:<id> 与 registerPreset/Part/Shader 专属名称
        val exactSubstringTokens = LinkedHashSet<String>()
        val wordBoundaryTokens = LinkedHashSet<String>()
        val kubejsDir = root.resolve("kubejs")
        // 跳过 epiphy:item/... 或 epiphy:textures/... 等带斜杠的资源目录前缀，仅提取完整标识符
        val idPattern = Regex("""\bepiphy:([a-z0-9_]+)(?![/a-z0-9_])""")
        // 兼容双参 EpiphySpec.registerPreset('domain', 'casePresetId', ...) 与单参 COMP.registerPreset('casePresetId', ...)
        val twoArgRegPattern = Regex("""\bregisterPreset\s*\(\s*['"][^'"]+['"]\s*,\s*['"]([^'"]+)['"]""")
        val oneArgRegPattern = Regex("""\bregister(?:Preset|Part|Shader|Widget)\s*\(\s*['"]([^'"]+)['"]""")

        if (Files.isDirectory(kubejsDir)) {
            Files.walk(kubejsDir).use { stream ->
                for (p in stream) {
                    if (!Files.isRegularFile(p) || !p.fileName.toString().endsWith(".js")) continue
                    val normPath = p.toString().replace('\\', '/')
                    if (!normPath.contains("小玩意与案例") && !normPath.contains("拆解台")) continue
                    val src = Files.readString(p, StandardCharsets.UTF_8)
                    for (m in idPattern.findAll(src)) {
                        val fullId = m.value
                        val localName = m.groupValues[1]
                        if (fullId !in allowedGenericIds && !localName.startsWith("textures") && localName !in genericDomainNames) {
                            wordBoundaryTokens.add(fullId)
                            if (localName.contains('_') && localName.length >= 5) {
                                wordBoundaryTokens.add(localName)
                            }
                        }
                    }
                    for (m in twoArgRegPattern.findAll(src)) {
                        val presetId = m.groupValues[1].trim()
                        if (presetId.length >= 4 && presetId !in genericDomainNames) {
                            wordBoundaryTokens.add(presetId)
                        }
                    }
                    for (m in oneArgRegPattern.findAll(src)) {
                        val arg1 = m.groupValues[1].trim()
                        if (arg1.length >= 4 && arg1 !in genericDomainNames) {
                            wordBoundaryTokens.add(arg1)
                        }
                    }
                }
            }
        }

        // 3. 叠加通用引擎中禁止出现的特定器械部位与已知案例词（分段拼接避免测试文件自匹配）
        val staticCaseAndWeaponParts = listOf(
            "imperius" + "_test",
            "epiphy" + "_cosmos",
            "rnfmabj",
            "混沌" + "殉爆",
            "剑" + "身",
            "剑" + "刃",
            "剑" + "格",
            "刀" + "刃",
            "护" + "手"
        )
        exactSubstringTokens.addAll(staticCaseAndWeaponParts)
        val compiledWordPatterns = wordBoundaryTokens.map { tok -> tok to Regex("""\b${Regex.escape(tok)}\b""", RegexOption.IGNORE_CASE) }

        // 4. 扫描全部通用源码目录（epiphy-api、epiphy-core 及 kubejs/*/通用组件/）
        val genericRoots = mutableListOf(
            root.resolve("epiphy-api/src/main"),
            root.resolve("epiphy-core/src/main"),
            root.resolve("epiphy-core/src/compat")
        )
        if (Files.isDirectory(kubejsDir)) {
            Files.walk(kubejsDir, 3).use { stream ->
                stream.filter { Files.isDirectory(it) && it.fileName.toString() == "通用组件" }
                    .forEach { genericRoots.add(it) }
            }
        }

        val violations = ArrayList<String>()
        for (gRoot in genericRoots) {
            if (!Files.isDirectory(gRoot)) continue
            Files.walk(gRoot).use { stream ->
                for (file in stream) {
                    if (!Files.isRegularFile(file)) continue
                    val fn = file.fileName.toString()
                    if (!fn.endsWith(".kt") && !fn.endsWith(".java") && !fn.endsWith(".js")) continue
                    val lines = Files.readAllLines(file, StandardCharsets.UTF_8)
                    val relPath = root.relativize(file).toString().replace('\\', '/')
                    for ((idx, line) in lines.withIndex()) {
                        for (tok in exactSubstringTokens) {
                            if (line.contains(tok, ignoreCase = true)) {
                                violations.add("$relPath:${idx + 1} references case-specific token '$tok' -> ${line.trim()}")
                            }
                        }
                        for ((tok, regex) in compiledWordPatterns) {
                            if (regex.containsMatchIn(line)) {
                                violations.add("$relPath:${idx + 1} references case-specific identifier '$tok' -> ${line.trim()}")
                            }
                        }
                    }
                }
            }
        }

        if (violations.isNotEmpty()) {
            fail<Unit>(
                "Violation of 'Mechanism -> General Capability -> Downstream Case' charter!\n" +
                    "Generic engine/component files must not reference downstream cases or specific weapon parts:\n  - " +
                    violations.take(20).joinToString("\n  - ")
            )
        }
    }

    @Test
    fun `declarative neutral tone guard blocks promotional hype and unmeasured latency claims`() {
        val root = locateRepoRoot()

        val bannedPhrases = listOf(
            "铁" + "桶",
            "无懈" + "可击",
            "黑科" + "技",
            "连根" + "拔除",
            "极" + "速",
            "零损" + "耗",
            "零开" + "销",
            "零全局" + "污染",
            "绝对" + "恢复",
            "绝对" + "安全",
            "绝对" + "确定性",
            "彻底" + "根治",
            "彻底" + "消除",
            "彻底" + "告别",
            "彻底" + "淘汰",
            "100%" + " 安全",
            "100%" + " 兼容",
            "100%" + " 零",
            "100%" + " 移除",
            "100%" + " 原版",
            "bullet" + "proof",
            "blazingly" + " fast",
            "zero-" + "overhead",
            "zero-" + "pollution"
        )

        // 拦截无测量五元组支撑的裸耗时数字承诺（如 `< 1ns`、`< 0.08 ms`、`<= 0.4ms`）
        val unmeasuredLatencyClaimRegex = Regex("""(?:<=?|<)\s*\d+(?:\.\d+)?\s*(?:ns|us|µs|ms)\b""", RegexOption.IGNORE_CASE)

        val violations = ArrayList<String>()

        // A. 扫描 epiphy-api、epiphy-core 与 kubejs 通用组件源码中的注释行
        val codeRoots = mutableListOf(
            root.resolve("epiphy-api/src/main"),
            root.resolve("epiphy-core/src/main"),
            root.resolve("epiphy-core/src/compat")
        )
        val kubejsDir = root.resolve("kubejs")
        if (Files.isDirectory(kubejsDir)) {
            Files.walk(kubejsDir, 3).use { stream ->
                stream.filter { Files.isDirectory(it) && it.fileName.toString() == "通用组件" }
                    .forEach { codeRoots.add(it) }
            }
        }
        for (cRoot in codeRoots) {
            if (!Files.isDirectory(cRoot)) continue
            Files.walk(cRoot).use { stream ->
                for (file in stream) {
                    if (!Files.isRegularFile(file)) continue
                    val fn = file.fileName.toString()
                    if (!fn.endsWith(".kt") && !fn.endsWith(".java") && !fn.endsWith(".js")) continue
                    val relPath = root.relativize(file).toString().replace('\\', '/')
                    val lines = Files.readAllLines(file, StandardCharsets.UTF_8)
                    var inBlockComment = false
                    for ((idx, rawLine) in lines.withIndex()) {
                        val trimmed = rawLine.trim()
                        if (trimmed.startsWith("/*")) inBlockComment = true
                        val isComment = inBlockComment || trimmed.startsWith("//") || trimmed.startsWith("*") || rawLine.contains("//")
                        if (isComment) {
                            for (phrase in bannedPhrases) {
                                if (rawLine.contains(phrase, ignoreCase = true)) {
                                    violations.add("$relPath:${idx + 1} [persuasive/absolute phrase '$phrase']: $trimmed")
                                }
                            }
                            val m = unmeasuredLatencyClaimRegex.find(rawLine)
                            if (m != null) {
                                violations.add("$relPath:${idx + 1} [unmeasured latency claim '${m.value}']: $trimmed")
                            }
                        }
                        if (inBlockComment && trimmed.contains("*/")) inBlockComment = false
                    }
                }
            }
        }

        // B. 扫描仓库主干工程文档（跳过宪章中显式包裹在 charter-banned-examples 标记内的反面示例块）
        val primaryDocs = listOf(
            root.resolve("AGENTS.md"),
            root.resolve(".agent/rules/epiphy-engineering-charter.md"),
            root.resolve("README.md"),
            root.resolve("README_EN.md"),
            root.resolve("README-LLM.md"),
            root.resolve("docs/native-mod-migration-plan.md"),
            root.resolve("epiphy-core/src/main/resources/META-INF/mods.toml"),
            root.resolve("epiphy-core/src/main/resources/assets/epiphy/lang/zh_cn.json"),
            root.resolve("epiphy-core/src/main/resources/assets/epiphy/lang/en_us.json")
        )
        for (doc in primaryDocs) {
            if (!Files.isRegularFile(doc)) continue
            val relPath = root.relativize(doc).toString().replace('\\', '/')
            val lines = Files.readAllLines(doc, StandardCharsets.UTF_8)
            var inBannedExampleBlock = false
            for ((idx, rawLine) in lines.withIndex()) {
                if (rawLine.contains("<!-- charter-banned-examples-start -->")) {
                    inBannedExampleBlock = true
                    continue
                }
                if (rawLine.contains("<!-- charter-banned-examples-end -->")) {
                    inBannedExampleBlock = false
                    continue
                }
                if (inBannedExampleBlock) continue
                // 跳过引用宪章禁用说明行
                if (rawLine.contains("禁止“") || rawLine.contains("禁止\"") || rawLine.contains("禁用词")) continue

                for (phrase in bannedPhrases) {
                    if (rawLine.contains(phrase, ignoreCase = true)) {
                        violations.add("$relPath:${idx + 1} [persuasive/absolute phrase '$phrase']: ${rawLine.trim()}")
                    }
                }
                val m = unmeasuredLatencyClaimRegex.find(rawLine)
                if (m != null) {
                    violations.add("$relPath:${idx + 1} [unmeasured latency claim '${m.value}']: ${rawLine.trim()}")
                }
            }
        }

        if (violations.isNotEmpty()) {
            fail<Unit>(
                "Violation of Declarative & Neutral Engineering Documentation Charter!\n" +
                    "Replace promotional/absolute claims or unmeasured latency numbers with factual mechanisms and known boundaries:\n  - " +
                    violations.take(25).joinToString("\n  - ")
            )
        }
    }

    @Test
    fun `version single source of truth matches between gradle properties and EpiphyMod VERSION`() {
        val root = locateRepoRoot()
        val props = java.util.Properties()
        Files.newBufferedReader(root.resolve("gradle.properties"), StandardCharsets.UTF_8).use { props.load(it) }
        val expectedModVersion = props.getProperty("mod_version")?.trim()
        assertTrue(!expectedModVersion.isNullOrEmpty(), "mod_version must be defined in gradle.properties")
        assertTrue(
            expectedModVersion == EpiphyMod.VERSION,
            "Version drift detected: gradle.properties mod_version='$expectedModVersion' vs EpiphyMod.VERSION='${EpiphyMod.VERSION}'"
        )
    }
}
