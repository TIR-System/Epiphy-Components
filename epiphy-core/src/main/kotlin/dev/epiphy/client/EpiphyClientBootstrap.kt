// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.client

import com.mojang.logging.LogUtils
import dev.epiphy.client.audio.NativeAudioClientAccess
import dev.epiphy.client.fx3d.item.Item3DRenderHooks
import dev.epiphy.client.shader.EpiphyCoreShaders
import dev.epiphy.client.surface2d.fbo.FboCachePool
import dev.epiphy.client.surface2d.hook.GuiInterceptionHooks
import dev.epiphy.core.bridge.EpiphyBridgeRegistry
import net.minecraft.server.packs.resources.ResourceManagerReloadListener
import net.minecraftforge.client.event.ClientPlayerNetworkEvent
import net.minecraftforge.client.event.RegisterClientReloadListenersEvent
import net.minecraftforge.eventbus.api.IEventBus
import net.minecraftforge.fml.event.lifecycle.FMLClientSetupEvent

/**
 * 客户端安全隔离启动跳板。
 * `init(IEventBus, IEventBus)` 方法签名仅包含双端共享的 `IEventBus` 接口，确保专用服务端零客户端类加载。
 */
object EpiphyClientBootstrap {
    private val LOGGER = LogUtils.getLogger()

    val sharedFboPool: FboCachePool by lazy { FboCachePool() }

    fun init(modBus: IEventBus, forgeBus: IEventBus) {
        modBus.addListener(::onClientSetup)
        modBus.addListener(EpiphyCoreShaders::onRegisterShaders)
        modBus.addListener(::onRegisterReloadListeners)
        forgeBus.addListener(::onClientLoggingOut)

        // 注册客户端原生高性能加速原语，供阶段二脚本层按需绑定调用
        EpiphyBridgeRegistry.registerAccelerator("surface2d.fbo", sharedFboPool)
        EpiphyBridgeRegistry.registerAccelerator("surface2d.guiHooks", GuiInterceptionHooks)
        EpiphyBridgeRegistry.registerAccelerator("fx3d.itemHooks", Item3DRenderHooks)
        EpiphyBridgeRegistry.registerAccelerator("audio.clientAccess", NativeAudioClientAccess)
        EpiphyBridgeRegistry.registerAccelerator("shader.registry", EpiphyCoreShaders)
    }

    private fun onClientSetup(event: FMLClientSetupEvent) {
        LOGGER.info("[EpiphyClient] Client native rendering & audio primitives initialized.")
    }

    private fun onRegisterReloadListeners(event: RegisterClientReloadListenersEvent) {
        event.registerReloadListener(ResourceManagerReloadListener {
            // F3+T 重载资源包时无条件清空离屏 FBO 缓存，使新贴图与新字体立即生效
            sharedFboPool.destroyAll()
        })
    }

    private fun onClientLoggingOut(event: ClientPlayerNetworkEvent.LoggingOut) {
        // 退出服务器/存档时自动清空会话级 GUI 贴图重映射与离屏 FBO 显存，100% 零跨服残留
        GuiInterceptionHooks.clearAllTextureRemaps()
        sharedFboPool.destroyAll()
    }
}
