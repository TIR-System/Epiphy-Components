// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
plugins {
    java
    kotlin("jvm")
    kotlin("plugin.serialization")
}

val kotlinxSerializationVersion = providers.gradleProperty("kotlinx_serialization_version").get()

repositories {
    maven("https://maven.aliyun.com/repository/public") { name = "AliyunPublicMirror" }
    mavenCentral()
}

dependencies {
    // 运行时由 Kotlin for Forge 4.12.0 模块层统一提供，严禁传递打入模组 Jar
    compileOnly("org.jetbrains.kotlinx:kotlinx-serialization-json:$kotlinxSerializationVersion")

    testImplementation("org.jetbrains.kotlinx:kotlinx-serialization-json:$kotlinxSerializationVersion")
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.3")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

kotlin {
    jvmToolchain(17)
}

tasks.withType<JavaCompile>().configureEach {
    options.encoding = "UTF-8"
}

tasks.test {
    useJUnitPlatform()
}
