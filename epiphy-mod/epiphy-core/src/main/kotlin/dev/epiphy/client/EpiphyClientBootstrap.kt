// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.client

import com.mojang.logging.LogUtils
import net.minecraftforge.eventbus.api.IEventBus
import net.minecraftforge.fml.event.lifecycle.FMLClientSetupEvent

/**
 * 客户端安全隔离启动跳板。
 * 注意：`init(IEventBus, IEventBus)` 方法签名仅包含双端共享的 `IEventBus` 接口，
 * 所有 `@OnlyIn(Dist.CLIENT)` 事件订阅均封装在本类内部，确保专用服务端零客户端类加载。
 */
object EpiphyClientBootstrap {
    private val LOGGER = LogUtils.getLogger()

    fun init(modBus: IEventBus, forgeBus: IEventBus) {
        modBus.addListener(::onClientSetup)
        // 预留给 M1/M2 原生渲染事件桥接与着色器注册挂载点（forgeBus / modBus）
        LOGGER.debug("[EpiphyClient] Client bootstrap listeners attached (forgeBus={})", forgeBus.hashCode())
    }

    private fun onClientSetup(event: FMLClientSetupEvent) {
        LOGGER.info("[EpiphyClient] Client setup initialized.")
    }
}
