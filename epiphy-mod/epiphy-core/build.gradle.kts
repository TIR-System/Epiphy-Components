// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
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

    // 4. 字节码隔离与契约单元测试
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.3")
    testImplementation("org.ow2.asm:asm:9.7")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

mixin {
    add(mainSourceSet, "epiphy.refmap.json")
    config("epiphy.mixins.json")
}

kotlin {
    jvmToolchain(17)
}

tasks.withType<JavaCompile>().configureEach {
    options.encoding = "UTF-8"
}

tasks.named<ProcessResources>("processResources") {
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
    description = "Verifies that built mod JARs do not bundle kotlin/ or kotlinx/ classes."
    dependsOn(tasks.named("jar"))
    doLast {
        val jarFile = tasks.named<Jar>("jar").get().archiveFile.get().asFile
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
