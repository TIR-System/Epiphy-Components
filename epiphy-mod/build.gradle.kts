// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
plugins {
    kotlin("jvm") version "2.2.21" apply false
    kotlin("plugin.serialization") version "2.2.21" apply false
    id("net.minecraftforge.gradle") version "[6.0.24,6.2)" apply false
    id("org.parchmentmc.librarian.forgegradle") version "1.+" apply false
    id("org.spongepowered.mixin") version "0.7.+" apply false
}

allprojects {
    group = providers.gradleProperty("mod_group_id").get()
    version = providers.gradleProperty("mod_version").get()
}
