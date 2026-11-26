// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
plugins {
    java
    kotlin("jvm")
}

repositories {
    maven("https://maven.aliyun.com/repository/public") { name = "AliyunPublicMirror" }
    mavenCentral()
}

dependencies {
    compileOnly(project(":epiphy-api"))
}

kotlin {
    jvmToolchain(17)
}
