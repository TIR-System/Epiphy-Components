// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.client

import com.mojang.logging.LogUtils
import dev.epiphy.client.audio.NativeAudioClientAccess
import dev.epiphy.client.fx3d.item.Item3DRenderHooks
import dev.epiphy.client.fx3d.item.NativeItem3DBridge
import dev.epiphy.client.fx3d.item.NativeItem3DEngine
import dev.epiphy.client.fx3d.world.NativeWorld3DBatchRenderer
import dev.epiphy.client.shader.EpiphyCoreShaders
import dev.epiphy.client.surface2d.NativeSurface2DAccelerator
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

    /**
     * 面向脚本层暴露的世界 3D 批渲染网关实例（仅客户端加载）。
     */
    object World3DBridge {
        fun acquireEmissiveBuffer(bs: net.minecraft.client.renderer.MultiBufferSource?) =
            NativeWorld3DBatchRenderer.acquireEmissiveBuffer(bs)

        fun flushEmissiveBuffer(bs: net.minecraft.client.renderer.MultiBufferSource?) =
            NativeWorld3DBatchRenderer.flushEmissiveBuffer(bs)

        fun resolveEntityPos(uuidStr: String?, partialTick: Float): DoubleArray? {
            if (uuidStr.isNullOrBlank()) return null
            val out = DoubleArray(3)
            return if (NativeWorld3DBatchRenderer.resolveEntityInterpolatedPos(uuidStr, partialTick, out)) out else null
        }

        fun emitRing(
            poseStack: com.mojang.blaze3d.vertex.PoseStack?,
            vc: com.mojang.blaze3d.vertex.VertexConsumer?,
            ox: Float, oy: Float, oz: Float,
            tiltX: Float, rotY: Float, tiltZ: Float,
            radius: Float, width: Float, segments: Int,
            rgbHex: Int, alpha: Float
        ) = NativeWorld3DBatchRenderer.emitRing(poseStack, vc, ox, oy, oz, tiltX, rotY, tiltZ, radius, width, segments, rgbHex, alpha)

        fun emitBeam(
            poseStack: com.mojang.blaze3d.vertex.PoseStack?,
            vc: com.mojang.blaze3d.vertex.VertexConsumer?,
            ox: Float, oy: Float, oz: Float,
            tiltX: Float, rotY: Float, tiltZ: Float,
            height: Float, width: Float,
            rgbHex: Int, alpha: Float
        ) = NativeWorld3DBatchRenderer.emitBeam(poseStack, vc, ox, oy, oz, tiltX, rotY, tiltZ, height, width, rgbHex, alpha)

        fun emitHelix(
            poseStack: com.mojang.blaze3d.vertex.PoseStack?,
            vc: com.mojang.blaze3d.vertex.VertexConsumer?,
            ox: Float, oy: Float, oz: Float,
            tiltX: Float, rotY: Float, tiltZ: Float,
            radius: Float, height: Float, width: Float, segments: Int, turns: Float,
            rgbHex: Int, alpha: Float
        ) = NativeWorld3DBatchRenderer.emitHelix(poseStack, vc, ox, oy, oz, tiltX, rotY, tiltZ, radius, height, width, segments, turns, rgbHex, alpha)

        fun emitSphere(
            poseStack: com.mojang.blaze3d.vertex.PoseStack?,
            vc: com.mojang.blaze3d.vertex.VertexConsumer?,
            ox: Float, oy: Float, oz: Float,
            tiltX: Float, rotY: Float, tiltZ: Float,
            radius: Float, segments: Int,
            rgbHex: Int, alpha: Float
        ) = NativeWorld3DBatchRenderer.emitSphere(poseStack, vc, ox, oy, oz, tiltX, rotY, tiltZ, radius, segments, rgbHex, alpha)
    }

    fun init(modBus: IEventBus, forgeBus: IEventBus) {
        modBus.addListener(::onClientSetup)
        modBus.addListener(EpiphyCoreShaders::onRegisterShaders)
        modBus.addListener(::onRegisterReloadListeners)
        forgeBus.addListener(::onClientLoggingOut)

        // 注册客户端原生高性能加速原语，供 KubeJS 脚本外挂绑定调用
        EpiphyBridgeRegistry.registerAccelerator("surface2d.fbo", sharedFboPool)
        EpiphyBridgeRegistry.registerAccelerator("surface2d.guiHooks", GuiInterceptionHooks)
        EpiphyBridgeRegistry.registerAccelerator("surface2d.accel", NativeSurface2DAccelerator.INSTANCE)
        EpiphyBridgeRegistry.registerAccelerator("fx3d.worldBatch", World3DBridge)
        EpiphyBridgeRegistry.registerAccelerator("fx3d.itemHooks", Item3DRenderHooks)
        EpiphyBridgeRegistry.registerAccelerator("fx3d.itemBridge", NativeItem3DBridge)
        EpiphyBridgeRegistry.registerAccelerator("audio.clientAccess", NativeAudioClientAccess)
        EpiphyBridgeRegistry.registerAccelerator("shader.registry", EpiphyCoreShaders)
    }

    private fun onClientSetup(event: FMLClientSetupEvent) {
        event.enqueueWork {
            val bound = NativeItem3DEngine.rebindAllPending()
            LOGGER.info("[EpiphyClient] Client native rendering & audio primitives initialized (bound3dItems={}).", bound)
        }
    }

    private fun onRegisterReloadListeners(event: RegisterClientReloadListenersEvent) {
        event.registerReloadListener(ResourceManagerReloadListener {
            // F3+T 重载资源包时清空离屏 FBO、纹理存在性缓存与物品 RenderType 缓存，并重新绑定待挂载 3D 物品
            sharedFboPool.destroyAll()
            NativeSurface2DAccelerator.INSTANCE.clearResourceCache()
            NativeItem3DEngine.clearRenderTypeCache()
            NativeItem3DEngine.rebindAllPending()
        })
    }

    private fun onClientLoggingOut(event: ClientPlayerNetworkEvent.LoggingOut) {
        // 退出服务器/存档时自动清空会话级 GUI 贴图重映射、音乐避让追踪与离屏 FBO 显存，100% 零跨服残留
        GuiInterceptionHooks.clearAllTextureRemaps()
        NativeAudioClientAccess.setVanillaMusicDucked(false)
        sharedFboPool.destroyAll()
    }
}
