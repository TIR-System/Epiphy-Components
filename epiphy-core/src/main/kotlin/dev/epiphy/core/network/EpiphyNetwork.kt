// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.core.network

import dev.epiphy.api.spec.EpiphyProtocolSpec
import net.minecraft.resources.ResourceLocation
import net.minecraftforge.network.NetworkRegistry
import net.minecraftforge.network.simple.SimpleChannel

/**
 * `epiphy:main` 原生多路复用网络主通道。
 * 当前阶段支持缺省软连接（以便与尚未迁出 KubeJS 的存量端侧脚本平滑共存聯调），M4 收口时切换为强制版本握手。
 */
object EpiphyNetwork {
    private var initialized = false

    lateinit var channel: SimpleChannel
        private set

    @Synchronized
    fun register() {
        if (initialized) return
        val ver = EpiphyProtocolSpec.MAIN_NETWORK_PROTOCOL_VERSION
        channel = NetworkRegistry.newSimpleChannel(
            ResourceLocation.tryParse(EpiphyProtocolSpec.MAIN_NETWORK_CHANNEL)!!,
            { ver },
            { remote -> remote == ver || remote == NetworkRegistry.ABSENT.version() || remote == NetworkRegistry.ACCEPTVANILLA },
            { remote -> remote == ver || remote == NetworkRegistry.ABSENT.version() || remote == NetworkRegistry.ACCEPTVANILLA }
        )
        initialized = true
    }
}
