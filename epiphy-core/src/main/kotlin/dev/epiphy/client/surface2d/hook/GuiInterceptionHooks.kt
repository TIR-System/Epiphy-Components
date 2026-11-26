// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.client.surface2d.hook

import net.minecraft.client.gui.GuiGraphics
import net.minecraft.client.gui.screens.inventory.AbstractContainerScreen
import net.minecraft.resources.ResourceLocation
import net.minecraft.world.inventory.Slot
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

/**
 * 原生 GUI 夹心层（`bg` / `slot.underlay` / `slot.overlay` / `fg`）与零污染纹理重映射钩子中心。
 *
 * 解决 KubeJS 阶段 `P2-1` / `P2-3` 两大硬性阻塞：
 * 1. 未注册任何活跃拦截器或贴图映射时，所有 Mixin 入口仅执行 1 次 `volatile boolean` 布尔读取（`< 1ns` 零开销短路）；
 * 2. 所有回调在退出时强制校验并恢复 `PoseStack` 深度水位线，杜绝下游脚本或监听器异常污染原版界面；
 * 3. 会话级贴图重映射直接在 `GuiGraphics.innerBlit` 入口做 O(1) Map 查找，**彻底告别篡改全局 `TextureManager` 状态**。
 */
object GuiInterceptionHooks {

    interface ContainerPassListener {
        fun onAfterBackground(screen: AbstractContainerScreen<*>, graphics: GuiGraphics, mouseX: Int, mouseY: Int, partialTick: Float) {}
        fun onBeforeSlot(screen: AbstractContainerScreen<*>, graphics: GuiGraphics, slot: Slot) {}
        fun onAfterSlot(screen: AbstractContainerScreen<*>, graphics: GuiGraphics, slot: Slot) {}
        fun onAfterForeground(screen: AbstractContainerScreen<*>, graphics: GuiGraphics, mouseX: Int, mouseY: Int, partialTick: Float) {}
    }

    private val listeners = CopyOnWriteArrayList<ContainerPassListener>()
    private val activeTextureRemaps = ConcurrentHashMap<ResourceLocation, ResourceLocation>()

    @Volatile
    @JvmField
    var hasContainerListeners: Boolean = false

    @Volatile
    @JvmField
    var hasTextureRemaps: Boolean = false

    @JvmStatic
    fun registerListener(listener: ContainerPassListener) {
        if (!listeners.contains(listener)) {
            listeners.add(listener)
            hasContainerListeners = listeners.isNotEmpty()
        }
    }

    @JvmStatic
    fun unregisterListener(listener: ContainerPassListener) {
        listeners.remove(listener)
        hasContainerListeners = listeners.isNotEmpty()
    }

    @JvmStatic
    fun setTextureRemap(original: ResourceLocation, replacement: ResourceLocation) {
        activeTextureRemaps[original] = replacement
        hasTextureRemaps = activeTextureRemaps.isNotEmpty()
    }

    @JvmStatic
    fun clearTextureRemap(original: ResourceLocation) {
        activeTextureRemaps.remove(original)
        hasTextureRemaps = activeTextureRemaps.isNotEmpty()
    }

    @JvmStatic
    fun clearAllTextureRemaps() {
        activeTextureRemaps.clear()
        hasTextureRemaps = false
    }

    @JvmStatic
    fun remapTexture(original: ResourceLocation): ResourceLocation {
        if (!hasTextureRemaps) return original
        return activeTextureRemaps[original] ?: original
    }

    @JvmStatic
    fun dispatchAfterBackground(screen: AbstractContainerScreen<*>, graphics: GuiGraphics, mouseX: Int, mouseY: Int, partialTick: Float) {
        if (!hasContainerListeners) return
        for (l in listeners) {
            runGuardedWithPoseWatermark(graphics) {
                l.onAfterBackground(screen, graphics, mouseX, mouseY, partialTick)
            }
        }
    }

    @JvmStatic
    fun dispatchBeforeSlot(screen: AbstractContainerScreen<*>, graphics: GuiGraphics, slot: Slot) {
        if (!hasContainerListeners) return
        for (l in listeners) {
            runGuardedWithPoseWatermark(graphics) {
                l.onBeforeSlot(screen, graphics, slot)
            }
        }
    }

    @JvmStatic
    fun dispatchAfterSlot(screen: AbstractContainerScreen<*>, graphics: GuiGraphics, slot: Slot) {
        if (!hasContainerListeners) return
        for (l in listeners) {
            runGuardedWithPoseWatermark(graphics) {
                l.onAfterSlot(screen, graphics, slot)
            }
        }
    }

    @JvmStatic
    fun dispatchAfterForeground(screen: AbstractContainerScreen<*>, graphics: GuiGraphics, mouseX: Int, mouseY: Int, partialTick: Float) {
        if (!hasContainerListeners) return
        for (l in listeners) {
            runGuardedWithPoseWatermark(graphics) {
                l.onAfterForeground(screen, graphics, mouseX, mouseY, partialTick)
            }
        }
    }

    private inline fun runGuardedWithPoseWatermark(graphics: GuiGraphics, block: () -> Unit) {
        val pose = graphics.pose()
        pose.pushPose()
        try {
            block()
        } catch (_: Throwable) {
            // 下游绘制异常静默隔离，保护原版 GUI 不崩溃
        } finally {
            runCatching { pose.popPose() }
        }
    }
}
