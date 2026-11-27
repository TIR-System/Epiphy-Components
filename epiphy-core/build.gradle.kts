// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.util.jar.JarFile

plugins {
    java
    kotlin("jvm")
    kotlin("plugin.serialization")
    id("net.minecraftforge.gradle")
    id("org.parchmentmc.librarian.forgegradle")
    id("org.spongepowered.mixin")
}

val minecraftVersion = providers.gradleProperty("minecraft_version").get()
val forgeVersion = providers.gradleProperty("forge_version").get()
val parchmentChannel = providers.gradleProperty("parchment_mappings_channel").get()
val parchmentVersion = providers.gradleProperty("parchment_mappings_version").get()
val kffVersion = providers.gradleProperty("kff_version").get()
val mixinBoosterVersion = providers.gradleProperty("mixin_booster_version").get()
val fabricMixinVersion = providers.gradleProperty("fabric_mixin_version").get()
val mixinExtrasVersion = providers.gradleProperty("mixinextras_version").get()
val kubejsVersion = providers.gradleProperty("kubejs_version").get()
val modernuiVersion = providers.gradleProperty("modernui_version").get()
val curiosVersion = providers.gradleProperty("curios_version").get()

base {
    archivesName.set("epiphy")
}

jarJar.enable()

repositories {
    maven("https://maven.aliyun.com/repository/public") {
        name = "AliyunPublicMirror"
        content {
            excludeGroup("dev.latvian.mods")
            excludeGroup("dev.latvian.apps")
            excludeGroup("dev.architectury")
            excludeGroup("thedarkcolour")
            excludeGroup("org.sinytra.mixinbooster")
            excludeGroup("icyllis.modernui")
            excludeGroup("top.theillusivec4.curios")
        }
    }
    mavenCentral()
    maven("https://thedarkcolour.github.io/KotlinForForge/") {
        name = "Kotlin for Forge"
        content { includeGroup("thedarkcolour") }
    }
    maven("https://maven.su5ed.dev/releases") {
        name = "Su5eD (Sinytra MixinBooster)"
        content { includeGroup("org.sinytra.mixinbooster") }
    }
    maven("https://maven.fabricmc.net/") {
        name = "FabricMC (Fabric Mixin AP)"
        content { includeGroup("net.fabricmc") }
    }
    maven("https://maven.architectury.dev/") {
        name = "Architectury"
        content { includeGroup("dev.architectury") }
    }
    maven("https://maven.saps.dev/minecraft") {
        name = "LatvianModder (KubeJS / Rhino)"
        content {
            includeGroup("dev.latvian.mods")
            includeGroup("dev.latvian.apps")
        }
    }
    maven("https://maven.latvian.dev/releases") {
        name = "LatvianModder Releases"
        content {
            includeGroup("dev.latvian.mods")
            includeGroup("dev.latvian.apps")
        }
    }
    maven("https://maven.izzel.io/releases/") {
        name = "IzzelAliz (ModernUI)"
        content { includeGroup("icyllis.modernui") }
    }
    maven("https://maven.theillusivec4.top/") {
        name = "TheIllusiveC4 (Curios)"
        content { includeGroup("top.theillusivec4.curios") }
    }
}

// ============================================================================
// 编译期物理硬隔离：
// - main SourceSet   : 零第三方业务 Mod 依赖（若误引用 KubeJS/ModernUI/Curios 编译期直接报错）
// - compat SourceSet : 独占可选软兼容 compileOnly 依赖，最终合并入同一主 Jar 参与单次 reobfJar
// ============================================================================
val mainSourceSet: SourceSet = sourceSets.main.get()
val compatSourceSet: SourceSet = sourceSets.create("compat") {
    compileClasspath += mainSourceSet.output + mainSourceSet.compileClasspath
    runtimeClasspath += output + mainSourceSet.output + mainSourceSet.runtimeClasspath
}

val generatedBuildConstantsDir = layout.buildDirectory.dir("generated/sources/buildConstants/kotlin/main")
val generateBuildConstants by tasks.registering {
    val modVer = providers.gradleProperty("mod_version")
    val outDir = generatedBuildConstantsDir
    inputs.property("mod_version", modVer)
    outputs.dir(outDir)
    doLast {
        val pkgDir = outDir.get().asFile.resolve("dev/epiphy")
        pkgDir.mkdirs()
        pkgDir.resolve("EpiphyBuildConstants.kt").writeText(
            """
            // 自动生成自 gradle.properties 单一事实源 (SSOT)，请勿手动编辑
            package dev.epiphy

            internal object EpiphyBuildConstants {
                const val MOD_VERSION: String = "${modVer.get()}"
            }
            """.trimIndent() + "\n",
            Charsets.UTF_8
        )
    }
}

val apiProject = project(":epiphy-api")

minecraft {
    mappings(parchmentChannel, parchmentVersion)
    copyIdeResources.set(true)

    runs {
        configureEach {
            workingDirectory(project.file("run"))
            property("forge.logging.markers", "REGISTRIES")
            property("forge.logging.console.level", "debug")
            mods {
                create("epiphy") {
                    source(mainSourceSet)
                    source(compatSourceSet)
                    source(apiProject.extensions.getByType<SourceSetContainer>().getByName("main"))
                }
            }
        }

        create("client") {
            property("forge.enabledGameTestNamespaces", "epiphy")
        }

        create("server") {
            property("forge.enabledGameTestNamespaces", "epiphy")
            args("--nogui")
        }
    }
}

dependencies {
    minecraft("net.minecraftforge:forge:$minecraftVersion-$forgeVersion")

    // 0. 内部纯契约模块（仅取字节码合并，不传递拉取 kotlin-stdlib 进 jarJar）
    compileOnly(apiProject)
    "compatCompileOnly"(apiProject)
    testImplementation(apiProject)

    // 1. KFF 4.12.0 语言提供器（自动传递编译期 Kotlin 2.2.21 / coroutines 1.10.2 / serialization 1.9.0 与 kfflib API）
    implementation("thedarkcolour:kotlinforforge:$kffVersion")

    // 2. 现代 Mixin 管线：MixinBooster + Fabric Mixin AP + MixinExtras Jar-in-Jar
    implementation("org.sinytra.mixinbooster:mixin-booster:$mixinBoosterVersion")
    annotationProcessor("net.fabricmc:sponge-mixin:$fabricMixinVersion")

    compileOnly("io.github.llamalad7:mixinextras-common:$mixinExtrasVersion")
    annotationProcessor("io.github.llamalad7:mixinextras-common:$mixinExtrasVersion")

    implementation(fg.deobf("io.github.llamalad7:mixinextras-forge:$mixinExtrasVersion"))
    jarJar(group = "io.github.llamalad7", name = "mixinextras-forge", version = "[$mixinExtrasVersion,)") {
        jarJar.pin(this, mixinExtrasVersion)
        isTransitive = false
    }

    // 3. 可选软兼容依赖（严格限定于 compat SourceSet 编译期可见，绝不作为强制运行前置）
    "compatCompileOnly"(fg.deobf("dev.latvian.mods:kubejs-forge:$kubejsVersion"))
    "compatCompileOnly"(fg.deobf("icyllis.modernui:ModernUI-Forge:$modernuiVersion"))
    "compatCompileOnly"(fg.deobf("top.theillusivec4.curios:curios-forge:$curiosVersion:api"))

    // 4. 字节码隔离、无头回归与 Rhino 双路径对等性单元测试
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.3")
    testImplementation("org.ow2.asm:asm:9.7")
    testImplementation("dev.latvian.mods:rhino-forge:2001.2.2-build.17")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

mixin {
    add(mainSourceSet, "epiphy.refmap.json")
    config("epiphy.mixins.json")
}

kotlin {
    jvmToolchain(17)
    sourceSets.named("main") {
        kotlin.srcDir(generatedBuildConstantsDir)
    }
}

tasks.named("compileKotlin") {
    dependsOn(generateBuildConstants)
}

tasks.withType<JavaCompile>().configureEach {
    options.encoding = "UTF-8"
}

// MixinGradle 将 refmap 与 searge 复合映射写入 build/tmp/compileJava/；
// 禁用增量清空并在映射文件缺失时强制重跑，防止仅修改 Kotlin 文件后触发 reobfJar 找不到 tsrg 或打出空 refmap。
tasks.named<JavaCompile>("compileJava") {
    options.isIncremental = false
    outputs.upToDateWhen {
        project.layout.buildDirectory.file("tmp/compileJava/compileJava-mappings.tsrg").get().asFile.isFile &&
            project.layout.buildDirectory.file("tmp/compileJava/compileJava-refmap.json").get().asFile.isFile
    }
}

tasks.named<ProcessResources>("processResources") {
    filteringCharset = "UTF-8"
    inputs.property("filteringCharset", filteringCharset)
    val replaceProperties = mapOf(
        "mod_id" to providers.gradleProperty("mod_id").get(),
        "mod_version" to project.version.toString()
    )
    inputs.properties(replaceProperties)
    filesMatching("META-INF/mods.toml") {
        expand(replaceProperties + mapOf("file" to mapOf("jarVersion" to project.version.toString())))
    }
}

val apiMainSourceSet = apiProject.extensions.getByType<SourceSetContainer>().getByName("main")

tasks.named<Jar>("jar") {
    dependsOn(apiProject.tasks.named("classes"), compatSourceSet.classesTaskName)
    from(apiMainSourceSet.output)
    from(compatSourceSet.output)
    duplicatesStrategy = DuplicatesStrategy.EXCLUDE
    manifest {
        attributes(
            "Specification-Title" to "epiphy",
            "Specification-Vendor" to "Epiphy-iLLUMs",
            "Specification-Version" to "1",
            "Implementation-Title" to project.name,
            "Implementation-Version" to project.version.toString(),
            "Implementation-Vendor" to "Epiphy-iLLUMs",
            "MixinConfigs" to "epiphy.mixins.json"
        )
    }
    finalizedBy("reobfJar")
}

tasks.named<Jar>("jarJar") {
    dependsOn(apiProject.tasks.named("classes"), compatSourceSet.classesTaskName)
    from(apiMainSourceSet.output)
    from(compatSourceSet.output)
    duplicatesStrategy = DuplicatesStrategy.EXCLUDE
}

// ============================================================================
// 迁移工程计划书 §8 风险 1 硬性门禁：
// 严禁将 kotlin-stdlib 或 kotlinx-* 字节码打入模组产物 Jar（否则与 KFF MODULE_LAYER 触发 LinkageError）
// ============================================================================
val verifyNoBundledKotlin by tasks.registering {
    group = "verification"
    description = "Verifies thin and fat (-all) JARs for zero bundled Kotlin classes, Mixin refmap integrity, and mods.toml dependencies."
    dependsOn(tasks.named("jar"), tasks.named("jarJar"))
    doLast {
        val thinJar = tasks.named<Jar>("jar").get().archiveFile.get().asFile
        val fatJar = tasks.named<Jar>("jarJar").get().archiveFile.get().asFile
        for (jarFile in listOf(thinJar, fatJar)) {
            if (!jarFile.isFile) {
                throw GradleException("Expected mod JAR does not exist: ${jarFile.absolutePath}")
            }
            JarFile(jarFile).use { jf ->
                val leaked = jf.entries().asSequence()
                    .map { it.name }
                    .filter { it.endsWith(".class") && (it.startsWith("kotlin/") || it.startsWith("kotlinx/")) }
                    .take(10)
                    .toList()
                if (leaked.isNotEmpty()) {
                    throw GradleException(
                        "FATAL: Bundled Kotlin runtime classes detected in ${jarFile.name} (violates KFF LinkageError guard): $leaked"
                    )
                }

                val modsTomlEntry = jf.getJarEntry("META-INF/mods.toml")
                    ?: throw GradleException("Missing META-INF/mods.toml in ${jarFile.name}")
                val modsTomlText = jf.getInputStream(modsTomlEntry).bufferedReader(Charsets.UTF_8).readText()
                if (!modsTomlText.contains("modId = \"mixinbooster\"")) {
                    throw GradleException("META-INF/mods.toml in ${jarFile.name} must declare mandatory 'mixinbooster' dependency!")
                }
                if (!modsTomlText.contains("声明式 2D 平面合成与富文本渲染") || !modsTomlText.contains("【配置 (Config)】")) {
                    throw GradleException("META-INF/mods.toml in ${jarFile.name} suffered CJK character mangling during resource filtering!")
                }

                // 全包文本资源严格 UTF-8 解码与零损坏替换符 (U+FFFD) 门禁（防御 Windows GBK 默认编码破坏 expand/filter 资源）
                val textExts = listOf(".toml", ".json", ".mcmeta", ".fsh", ".vsh", ".txt")
                for (entry in jf.entries().asSequence()) {
                    if (entry.isDirectory) continue
                    if (textExts.none { entry.name.endsWith(it, ignoreCase = true) }) continue
                    val rawBytes = jf.getInputStream(entry).readBytes()
                    val decoded: String = try {
                        StandardCharsets.UTF_8
                            .newDecoder()
                            .onMalformedInput(CodingErrorAction.REPORT)
                            .onUnmappableCharacter(CodingErrorAction.REPORT)
                            .decode(ByteBuffer.wrap(rawBytes))
                            .toString()
                    } catch (ce: CharacterCodingException) {
                        throw GradleException("Invalid UTF-8 byte sequence in ${jarFile.name}!/${entry.name}: ${ce.message}", ce)
                    }
                    if (decoded.contains('\uFFFD')) {
                        throw GradleException("Corrupted Unicode replacement character (U+FFFD) detected in ${jarFile.name}!/${entry.name}!")
                    }
                }

                val refmapEntry = jf.getJarEntry("epiphy.refmap.json")
                    ?: throw GradleException("Missing epiphy.refmap.json in ${jarFile.name}; Mixins would silently fail in production!")
                val refmapText = jf.getInputStream(refmapEntry).bufferedReader(Charsets.UTF_8).readText()
                val requiredMixinKeys = listOf(
                    "dev/epiphy/mixin/client/AbstractContainerScreenMixin",
                    "dev/epiphy/mixin/client/GuiGraphicsMixin",
                    "dev/epiphy/mixin/client/ItemRendererMixin",
                    "dev/epiphy/mixin/client/PoseStackAccessor",
                    "dev/epiphy/mixin/client/SoundEngineAccessor"
                )
                for (mk in requiredMixinKeys) {
                    if (!refmapText.contains(mk)) {
                        throw GradleException("epiphy.refmap.json in ${jarFile.name} is missing obfuscation mappings for '$mk'!")
                    }
                }
            }
        }
    }
}

tasks.test {
    useJUnitPlatform()
    dependsOn(tasks.named("classes"), compatSourceSet.classesTaskName)
    systemProperty(
        "epiphy.mainClassesDirs",
        mainSourceSet.output.classesDirs.files.joinToString(File.pathSeparator) { it.absolutePath }
    )
}

tasks.named("check") {
    dependsOn(verifyNoBundledKotlin)
}
