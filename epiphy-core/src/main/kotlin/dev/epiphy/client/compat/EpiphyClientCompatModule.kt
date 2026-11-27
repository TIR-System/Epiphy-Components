// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.client.compat

/**
 * 客户端可选软兼容模块 SPI（通过 `META-INF/services/dev.epiphy.client.compat.EpiphyClientCompatModule` 发现）。
 *
 * 采用标准 JDK `ServiceLoader` 替代 `Class.forName` 反射与受语言加载器类型限制的 `@Mod.EventBusSubscriber`，
 * 使 `src/compat` 中的可选客户端适配器在 `kotlinforforge` 环境下确定性完成挂载，且未安装目标模组时不触发第三方类链接。
 */
interface EpiphyClientCompatModule {
    val id: String
    fun onClientSetup()
}
