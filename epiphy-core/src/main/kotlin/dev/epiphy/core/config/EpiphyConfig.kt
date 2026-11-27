// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.core.config

import net.minecraftforge.common.ForgeConfigSpec
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Epiphy Core 双端通用与客户端配置定义（基于 `ForgeConfigSpec`，生成于 `<gameDir>/config/`，独立于世界存档目录）。
 *
 * 已知边界与约束：
 * - 本类位于双端共享包 `dev.epiphy.core.config`，不得引入 `net.minecraft.client.*` 或 `com.mojang.blaze3d.*` 等客户端专属类型，以保证专用服务端（Dedicated Server）正常加载；
 * - 热路径直接读取下方 `@Volatile` 镜像字段以减少每帧穿过 `ConfigValue.get()` 的读取开销，修改配置值后需调用 [syncFromSpecs] 或 [saveClientAndSync] 刷新镜像并通知监听器。
 */
object EpiphyConfig {

    enum class TextOutlineQuality(val levelCode: Int, val translationKey: String) {
        /** 完整采样：glow 4 向柔光，stroke 8 向外环 + 大半径 4 向内环桥接 */
        HIGH(3, "epiphy.config.enum.outline.high"),
        /** 均衡采样：glow 4 向柔光，stroke 标准 8 向外环 */
        BALANCED(2, "epiphy.config.enum.outline.balanced"),
        /** 性能优先：glow 与 stroke 均收敛为轻量 4 向采样 */
        PERFORMANCE(1, "epiphy.config.enum.outline.performance"),
        /** 关闭文字描边与外发光采样，仅保留正文与基础阴影 */
        OFF(0, "epiphy.config.enum.outline.off");

        fun next(): TextOutlineQuality {
            val all = entries
            return all[(ordinal + 1) % all.size]
        }
    }

    class CommonValues internal constructor(builder: ForgeConfigSpec.Builder) {
        val enableAsyncFileLogging: ForgeConfigSpec.BooleanValue
        val logDeprecationWarnings: ForgeConfigSpec.BooleanValue

        init {
            builder.comment("Epiphy Core Common Infrastructure Settings | 通用底座与日志设置")
                .push("infrastructure")

            enableAsyncFileLogging = builder
                .comment("Enable asynchronous file logging under <gameDir>/epiphy-data/ | 启用 epiphy-data/ 异步运行日志落盘")
                .translation("epiphy.config.common.enableAsyncFileLogging")
                .define("enableAsyncFileLogging", true)

            logDeprecationWarnings = builder
                .comment("Log one-time migration hints when legacy protocol aliases are encountered | 记录旧版协议别名一次性迁移提示")
                .translation("epiphy.config.common.logDeprecationWarnings")
                .define("logDeprecationWarnings", false)

            builder.pop()
        }
    }

    class ClientValues internal constructor(builder: ForgeConfigSpec.Builder) {
        // 1. 2D 平面合成与富文本引擎
        val enableSurface2D: ForgeConfigSpec.BooleanValue
        val enableNativeTextBatcher: ForgeConfigSpec.BooleanValue
        val textOutlineQuality: ForgeConfigSpec.EnumValue<TextOutlineQuality>
        val enableFboCache: ForgeConfigSpec.BooleanValue
        val enableGuiTextureRemap: ForgeConfigSpec.BooleanValue
        val surface2DFrameBudgetMs: ForgeConfigSpec.DoubleValue

        // 2. 3D 物品与空间特效引擎
        val enableItem3D: ForgeConfigSpec.BooleanValue
        val enableItem3DOverlays: ForgeConfigSpec.BooleanValue
        val enableItem3DGeometry: ForgeConfigSpec.BooleanValue
        val item3DGuiScale: ForgeConfigSpec.DoubleValue
        val enableWorld3D: ForgeConfigSpec.BooleanValue

        // 3. 空间音频与调试遥测
        val enableSpatialAudio: ForgeConfigSpec.BooleanValue
        val enableVanillaMusicDucking: ForgeConfigSpec.BooleanValue
        val debugPerfSampling: ForgeConfigSpec.BooleanValue

        init {
            builder.comment("2D Declarative Surface & Rich-Text Batching | 2D 平面合成与富文本渲染")
                .push("surface2d")

            enableSurface2D = builder
                .comment("Master switch for 2D overlays, HUD panels, GUI/slot layers, and world planes | 启用 2D 平面、弹幕、HUD 与槽位叠加渲染总开关")
                .translation("epiphy.config.client.enableSurface2D")
                .define("enableSurface2D", true)

            enableNativeTextBatcher = builder
                .comment("Enable native glyph quad capture & atlas-bucketed per-character batching | 启用原生字形捕获与图集分桶逐字合批加速")
                .translation("epiphy.config.client.enableNativeTextBatcher")
                .define("enableNativeTextBatcher", true)

            textOutlineQuality = builder
                .comment("Sampling quality tier for rich-text stroke & glow outlines | 富文本描边与外发光采样精度档位")
                .translation("epiphy.config.client.textOutlineQuality")
                .defineEnum("textOutlineQuality", TextOutlineQuality.HIGH)

            enableFboCache = builder
                .comment("Enable off-screen FBO caching pool for static declarative node subtrees | 启用静态声明式节点树离屏 FBO 缓存池")
                .translation("epiphy.config.client.enableFboCache")
                .define("enableFboCache", true)

            enableGuiTextureRemap = builder
                .comment("Allow session-scoped GUI texture remapping without mutating global TextureManager | 允许零全局污染的会话级 GUI 纹理重映射")
                .translation("epiphy.config.client.enableGuiTextureRemap")
                .define("enableGuiTextureRemap", true)

            surface2DFrameBudgetMs = builder
                .comment("Per-frame CPU time budget (ms) before throttling low-priority overlays | 低优先级普通弹幕单帧耗时熔断预算 (毫秒)")
                .translation("epiphy.config.client.surface2DFrameBudgetMs")
                .defineInRange("surface2DFrameBudgetMs", 4.0, 0.5, 16.0)

            builder.pop()

            builder.comment("3D Item & Spatial FX Pipeline | 3D 物品与空间特效管线")
                .push("fx3d")

            enableItem3D = builder
                .comment("Master switch for native 3D item rendering layers | 启用原生物品三维渲染总开关")
                .translation("epiphy.config.client.enableItem3D")
                .define("enableItem3D", true)

            enableItem3DOverlays = builder
                .comment("Enable custom shader surface overlays on bound 3D items | 启用物品表面着色器覆层")
                .translation("epiphy.config.client.enableItem3DOverlays")
                .define("enableItem3DOverlays", true)

            enableItem3DGeometry = builder
                .comment("Enable 3D procedural geometry layers (ribbons, helices, sprite clusters) on bound items | 启用物品三维环绕几何图层")
                .translation("epiphy.config.client.enableItem3DGeometry")
                .define("enableItem3DGeometry", true)

            item3DGuiScale = builder
                .comment("Global scale multiplier for 3D item geometry layers inside GUI slots | 背包/快捷栏槽位内物品 3D 几何层全局缩放倍率")
                .translation("epiphy.config.client.item3DGuiScale")
                .defineInRange("item3DGuiScale", 1.0, 0.25, 2.0)

            enableWorld3D = builder
                .comment("Enable world-space 3D spatial FX rendering | 启用世界空间三维特效渲染")
                .translation("epiphy.config.client.enableWorld3D")
                .define("enableWorld3D", true)

            builder.pop()

            builder.comment("Spatial Audio & Diagnostics | 空间音频与性能诊断")
                .push("audio_and_debug")

            enableSpatialAudio = builder
                .comment("Enable client spatial audio controller | 启用客户端三维空间音频控制")
                .translation("epiphy.config.client.enableSpatialAudio")
                .define("enableSpatialAudio", true)

            enableVanillaMusicDucking = builder
                .comment("Gently duck vanilla background music while active Epiphy music streams play | 播放受管音乐声源时自动温和避让原版背景音乐")
                .translation("epiphy.config.client.enableVanillaMusicDucking")
                .define("enableVanillaMusicDucking", true)

            debugPerfSampling = builder
                .comment("Collect microsecond-level native render performance telemetry | 启用客户端微秒级渲染耗时遥测采样")
                .translation("epiphy.config.client.debugPerfSampling")
                .define("debugPerfSampling", false)

            builder.pop()
        }
    }

    val COMMON: CommonValues
    val COMMON_SPEC: ForgeConfigSpec

    val CLIENT: ClientValues
    val CLIENT_SPEC: ForgeConfigSpec

    init {
        val commonPair = ForgeConfigSpec.Builder().configure(::CommonValues)
        COMMON = commonPair.left
        COMMON_SPEC = commonPair.right

        val clientPair = ForgeConfigSpec.Builder().configure(::ClientValues)
        CLIENT = clientPair.left
        CLIENT_SPEC = clientPair.right
    }

    // 运行期无锁镜像字段（避免热路径每帧穿过 ForgeConfigSpec.ConfigValue 装箱读取）
    @Volatile @JvmField var asyncFileLogging: Boolean = true
    @Volatile @JvmField var deprecationWarnings: Boolean = false

    @Volatile @JvmField var surface2DEnabled: Boolean = true
    @Volatile @JvmField var nativeTextBatcherEnabled: Boolean = true
    @Volatile @JvmField var outlineQualityLevel: Int = TextOutlineQuality.HIGH.levelCode
    @Volatile @JvmField var fboCacheEnabled: Boolean = true
    @Volatile @JvmField var guiTextureRemapEnabled: Boolean = true
    @Volatile @JvmField var surface2DFrameBudgetMs: Double = 4.0

    @Volatile @JvmField var item3DEnabled: Boolean = true
    @Volatile @JvmField var item3DOverlaysEnabled: Boolean = true
    @Volatile @JvmField var item3DGeometryEnabled: Boolean = true
    @Volatile @JvmField var item3DGuiScale: Float = 1.0f
    @Volatile @JvmField var world3DEnabled: Boolean = true

    @Volatile @JvmField var spatialAudioEnabled: Boolean = true
    @Volatile @JvmField var vanillaMusicDuckingEnabled: Boolean = true
    @Volatile @JvmField var debugPerfSamplingEnabled: Boolean = false

    @Volatile @JvmField var revision: Long = 1L

    private val syncListeners = CopyOnWriteArrayList<Runnable>()

    fun addSyncListener(listener: Runnable) {
        syncListeners.add(listener)
    }

    fun syncFromSpecs() {
        runCatching {
            if (COMMON_SPEC.isLoaded) {
                asyncFileLogging = COMMON.enableAsyncFileLogging.get()
                deprecationWarnings = COMMON.logDeprecationWarnings.get()
            }
        }
        runCatching {
            if (CLIENT_SPEC.isLoaded) {
                surface2DEnabled = CLIENT.enableSurface2D.get()
                nativeTextBatcherEnabled = CLIENT.enableNativeTextBatcher.get()
                outlineQualityLevel = CLIENT.textOutlineQuality.get().levelCode
                fboCacheEnabled = CLIENT.enableFboCache.get()
                guiTextureRemapEnabled = CLIENT.enableGuiTextureRemap.get()
                surface2DFrameBudgetMs = CLIENT.surface2DFrameBudgetMs.get().coerceIn(0.5, 16.0)

                item3DEnabled = CLIENT.enableItem3D.get()
                item3DOverlaysEnabled = CLIENT.enableItem3DOverlays.get()
                item3DGeometryEnabled = CLIENT.enableItem3DGeometry.get()
                item3DGuiScale = CLIENT.item3DGuiScale.get().toFloat().coerceIn(0.25f, 2.0f)
                world3DEnabled = CLIENT.enableWorld3D.get()

                spatialAudioEnabled = CLIENT.enableSpatialAudio.get()
                vanillaMusicDuckingEnabled = CLIENT.enableVanillaMusicDucking.get()
                debugPerfSamplingEnabled = CLIENT.debugPerfSampling.get()
            }
        }
        revision++
        for (listener in syncListeners) {
            runCatching { listener.run() }
        }
    }

    fun saveClientAndSync() {
        runCatching {
            if (CLIENT_SPEC.isLoaded) {
                CLIENT_SPEC.save()
            }
            if (COMMON_SPEC.isLoaded) {
                COMMON_SPEC.save()
            }
        }
        syncFromSpecs()
    }

    fun snapshotMap(): Map<String, Any> = linkedMapOf(
        "revision" to revision,
        "enableAsyncFileLogging" to asyncFileLogging,
        "logDeprecationWarnings" to deprecationWarnings,
        "enableSurface2D" to surface2DEnabled,
        "enableNativeTextBatcher" to nativeTextBatcherEnabled,
        "textOutlineQualityLevel" to outlineQualityLevel,
        "enableFboCache" to fboCacheEnabled,
        "enableGuiTextureRemap" to guiTextureRemapEnabled,
        "surface2DFrameBudgetMs" to surface2DFrameBudgetMs,
        "enableItem3D" to item3DEnabled,
        "enableItem3DOverlays" to item3DOverlaysEnabled,
        "enableItem3DGeometry" to item3DGeometryEnabled,
        "item3DGuiScale" to item3DGuiScale.toDouble(),
        "enableWorld3D" to world3DEnabled,
        "enableSpatialAudio" to spatialAudioEnabled,
        "enableVanillaMusicDucking" to vanillaMusicDuckingEnabled,
        "debugPerfSampling" to debugPerfSamplingEnabled
    )
}
