// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.client.surface2d.hook

import net.minecraft.client.gui.GuiGraphics
import net.minecraft.client.gui.screens.inventory.AbstractContainerScreen
import net.minecraft.resources.ResourceLocation
import net.minecraft.world.inventory.Slot
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

/**
 * 容器界面四相位回调（`bg` / `slot.underlay` / `slot.overlay` / `fg`）与 `GuiGraphics.innerBlit` 纹理重映射分发中心。
 *
 * 工作机制：
 * 1. 未注册监听器或纹理映射时，Mixin 入口仅检查对应的 `volatile boolean` 标志后直接返回；
 * 2. 分发容器界面回调时在外层包裹一层 `PoseStack` 推弹与异常捕获；
 * 3. 纹理重映射在 `GuiGraphics.innerBlit` 入口按映射表替换传入的 `ResourceLocation`，避免直接覆盖全局 `TextureManager` 中的纹理对象。
 *
 * 已知边界：
 * - 当前 `runGuardedWithPoseWatermark` 仅执行单次外层 `pushPose/popPose`，若监听器内部自身发生不对称的多次 `pushPose` 未弹出，仍需依赖后续栈深度水位线校验加固；
 * - 当前 `activeTextureRemaps` 为全局映射表，依赖界面关闭或退服钩子显式清空，尚未与单个 `Screen` 实例生命周期强绑定。
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
