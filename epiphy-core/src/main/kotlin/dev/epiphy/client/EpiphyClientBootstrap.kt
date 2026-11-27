// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.client

import com.mojang.blaze3d.systems.RenderSystem
import com.mojang.logging.LogUtils
import dev.epiphy.client.audio.NativeAudioClientAccess
import dev.epiphy.client.config.EpiphyConfigScreen
import dev.epiphy.client.fx3d.item.Item3DRenderHooks
import dev.epiphy.client.fx3d.item.NativeItem3DBridge
import dev.epiphy.client.fx3d.item.NativeItem3DEngine
import dev.epiphy.client.fx3d.world.NativeWorld3DBatchRenderer
import dev.epiphy.client.shader.EpiphyCoreShaders
import dev.epiphy.client.surface2d.NativeSurface2DAccelerator
import dev.epiphy.client.surface2d.fbo.FboCachePool
import dev.epiphy.client.surface2d.hook.GuiInterceptionHooks
import dev.epiphy.core.bridge.EpiphyBridgeRegistry
import dev.epiphy.core.config.EpiphyConfig
import net.minecraft.server.packs.resources.ResourceManagerReloadListener
import net.minecraftforge.client.ConfigScreenHandler
import net.minecraftforge.client.event.ClientPlayerNetworkEvent
import net.minecraftforge.client.event.RegisterClientReloadListenersEvent
import net.minecraftforge.client.event.ScreenEvent
import net.minecraftforge.event.TickEvent
import net.minecraftforge.eventbus.api.IEventBus
import net.minecraftforge.fml.ModLoadingContext
import net.minecraftforge.fml.event.lifecycle.FMLClientSetupEvent

/**
 * 客户端隔离启动入口。
 * `init(IEventBus, IEventBus)` 方法签名仅包含双端共享的 `IEventBus` 接口，避免专用服务端在类验证阶段触碰客户端类。
 */
object EpiphyClientBootstrap {
    private val LOGGER = LogUtils.getLogger()

    private val fboPoolLazy = lazy { FboCachePool() }
    val sharedFboPool: FboCachePool get() = fboPoolLazy.value

    private var fboPurgeTickCounter: Int = 0

    /**
     * 面向脚本层暴露的世界 3D 批渲染网关实例（仅客户端加载）。
     */
    object World3DBridge {
        fun isEnabled(): Boolean = EpiphyConfig.world3DEnabled

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
        forgeBus.addListener(::onScreenClosing)
        forgeBus.addListener(::onClientTick)

        ModLoadingContext.get().registerExtensionPoint(ConfigScreenHandler.ConfigScreenFactory::class.java) {
            ConfigScreenHandler.ConfigScreenFactory { _, parent -> EpiphyConfigScreen(parent) }
        }

        EpiphyConfig.addSyncListener {
            applyClientConfigNow()
        }
        applyClientConfigNow()

        EpiphyBridgeRegistry.registerAccelerator("surface2d.fbo", sharedFboPool)
        EpiphyBridgeRegistry.registerAccelerator("surface2d.guiHooks", GuiInterceptionHooks)
        EpiphyBridgeRegistry.registerAccelerator("surface2d.accel", NativeSurface2DAccelerator.INSTANCE)
        EpiphyBridgeRegistry.registerAccelerator("fx3d.worldBatch", World3DBridge)
        EpiphyBridgeRegistry.registerAccelerator("fx3d.itemHooks", Item3DRenderHooks)
        EpiphyBridgeRegistry.registerAccelerator("fx3d.itemBridge", NativeItem3DBridge)
        EpiphyBridgeRegistry.registerAccelerator("audio.clientAccess", NativeAudioClientAccess)
        EpiphyBridgeRegistry.registerAccelerator("shader.registry", EpiphyCoreShaders)
    }

    private fun applyClientConfigNow() {
        NativeItem3DEngine.enabled = EpiphyConfig.item3DEnabled
        NativeItem3DEngine.overlaysEnabled = EpiphyConfig.item3DOverlaysEnabled
        NativeItem3DEngine.geometryEnabled = EpiphyConfig.item3DGeometryEnabled
        NativeItem3DEngine.guiGlobalScale = EpiphyConfig.item3DGuiScale

        if (!EpiphyConfig.fboCacheEnabled && fboPoolLazy.isInitialized()) {
            runCatching { sharedFboPool.destroyAll() }
        }
        if (!EpiphyConfig.guiTextureRemapEnabled) {
            GuiInterceptionHooks.clearAllTextureRemaps()
        }
        if (!EpiphyConfig.spatialAudioEnabled || !EpiphyConfig.vanillaMusicDuckingEnabled) {
            NativeAudioClientAccess.setVanillaMusicDucked(false)
        }
    }

    private fun onClientSetup(event: FMLClientSetupEvent) {
        event.enqueueWork {
            EpiphyConfig.syncFromSpecs()
            val bound = NativeItem3DEngine.rebindAllPending()
            val unresolved = NativeItem3DEngine.auditUnresolvedPendingItems()
            LOGGER.info(
                "[EpiphyClient] Client rendering & audio primitives initialized (bound3dItems={}, unresolved3dItems={}).",
                bound,
                unresolved.size
            )
        }
    }

    private fun onRegisterReloadListeners(event: RegisterClientReloadListenersEvent) {
        event.registerReloadListener(ResourceManagerReloadListener {
            if (fboPoolLazy.isInitialized()) {
                sharedFboPool.destroyAll()
            }
            NativeSurface2DAccelerator.INSTANCE.clearResourceCache()
            NativeItem3DEngine.clearRenderTypeCache()
            GuiInterceptionHooks.resetCircuitBreaker()
            Item3DRenderHooks.resetCircuitBreaker()
            NativeItem3DEngine.rebindAllPending()
        })
    }

    private fun onScreenClosing(event: ScreenEvent.Closing) {
        GuiInterceptionHooks.onScreenClosing(event.screen)
    }

    private fun onClientTick(event: TickEvent.ClientTickEvent) {
        if (event.phase != TickEvent.Phase.END) return
        fboPurgeTickCounter++
        if (fboPurgeTickCounter >= 200) {
            fboPurgeTickCounter = 0
            if (fboPoolLazy.isInitialized() && RenderSystem.isOnRenderThread()) {
                sharedFboPool.purgeIdle()
            }
        }
    }

    private fun onClientLoggingOut(event: ClientPlayerNetworkEvent.LoggingOut) {
        GuiInterceptionHooks.clearAllTextureRemaps()
        GuiInterceptionHooks.resetCircuitBreaker()
        Item3DRenderHooks.resetCircuitBreaker()
        NativeAudioClientAccess.setVanillaMusicDucked(false)
        if (fboPoolLazy.isInitialized()) {
            sharedFboPool.destroyAll()
        }
    }
}
