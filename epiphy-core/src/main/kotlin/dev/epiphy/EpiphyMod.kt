// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy

import com.mojang.logging.LogUtils
import dev.epiphy.client.EpiphyClientBootstrap
import dev.epiphy.core.EpiphyRuntime
import dev.epiphy.core.bridge.EpiphyBridgeRegistry
import dev.epiphy.core.config.EpiphyConfig
import dev.epiphy.core.network.EpiphyNetwork
import dev.epiphy.mixin.EpiphyMixinPlugin
import dev.epiphy.server.EpiphyDedicatedServerBootstrap
import net.minecraftforge.event.server.ServerAboutToStartEvent
import net.minecraftforge.event.server.ServerStoppedEvent
import net.minecraftforge.fml.ModList
import net.minecraftforge.fml.ModLoadingContext
import net.minecraftforge.fml.common.Mod
import net.minecraftforge.fml.config.ModConfig
import net.minecraftforge.fml.event.config.ModConfigEvent
import net.minecraftforge.fml.event.lifecycle.FMLCommonSetupEvent
import thedarkcolour.kotlinforforge.forge.FORGE_BUS
import thedarkcolour.kotlinforforge.forge.MOD_BUS
import thedarkcolour.kotlinforforge.forge.runForDist

@Mod(EpiphyMod.ID)
object EpiphyMod {
    const val ID: String = "epiphy"
    const val VERSION: String = "0.1.0-alpha.1"

    val LOGGER = LogUtils.getLogger()

    init {
        EpiphyRuntime.ensureInitialized()
        EpiphyBridgeRegistry.markCoreBootstrapped(VERSION, EpiphyMixinPlugin.isMixinBoosterActive())

        LOGGER.info(
            "[Epiphy] Bootstrapping native core v{} (Kotlin {}, MixinBoosterActive={})",
            VERSION,
            KotlinVersion.CURRENT,
            EpiphyMixinPlugin.isMixinBoosterActive()
        )

        val modCtx = ModLoadingContext.get()
        modCtx.registerConfig(ModConfig.Type.COMMON, EpiphyConfig.COMMON_SPEC)
        modCtx.registerConfig(ModConfig.Type.CLIENT, EpiphyConfig.CLIENT_SPEC)

        MOD_BUS.addListener(::onCommonSetup)
        MOD_BUS.addListener(::onConfigLoading)
        MOD_BUS.addListener(::onConfigReloading)
        FORGE_BUS.addListener(::onServerAboutToStart)
        FORGE_BUS.addListener(::onServerStopped)

        // 严格遵循迁移计划书 §2.3 第 1 条：
        // runForDist 为 inline 函数，clientTarget 内仅调用无客户端专属参数类型的静态跳板入口，
        // 严禁在此闭包中直接引用任何 @OnlyIn(Dist.CLIENT) 事件类，防止 Dedicated Server 类验证崩溃。
        runForDist(
            clientTarget = {
                EpiphyClientBootstrap.init(MOD_BUS, FORGE_BUS)
            },
            serverTarget = {
                EpiphyDedicatedServerBootstrap.init()
            }
        )
    }

    private fun onCommonSetup(event: FMLCommonSetupEvent) {
        event.enqueueWork {
            EpiphyNetwork.register()
            val modList = ModList.get()
            EpiphyRuntime.logEngine.info(
                "EpiphyCore",
                "CommonSetup",
                "Network ready; optional compat loaded: kubejs=${modList.isLoaded("kubejs")}, modernui=${modList.isLoaded("modernui")}, curios=${modList.isLoaded("curios")}"
            )
        }
    }

    private fun onConfigLoading(event: ModConfigEvent.Loading) {
        if (event.config.modId == ID) {
            EpiphyConfig.syncFromSpecs()
        }
    }

    private fun onConfigReloading(event: ModConfigEvent.Reloading) {
        if (event.config.modId == ID) {
            EpiphyConfig.syncFromSpecs()
        }
    }

    private fun onServerAboutToStart(event: ServerAboutToStartEvent) {
        EpiphyRuntime.onServerStarting(event.server)
    }

    private fun onServerStopped(event: ServerStoppedEvent) {
        EpiphyRuntime.onServerStopped()
    }
}
