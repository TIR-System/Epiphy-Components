// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.client.surface2d.hook

import dev.epiphy.client.util.PoseStackWatermark
import dev.epiphy.client.util.RenderFaultCircuitBreaker
import net.minecraft.client.Minecraft
import net.minecraft.client.gui.GuiGraphics
import net.minecraft.client.gui.screens.inventory.AbstractContainerScreen
import net.minecraft.resources.ResourceLocation
import net.minecraft.world.inventory.Slot
import java.lang.ref.WeakReference
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

/**
 * 容器界面四阶段回调（`bg` / `slot.underlay` / `slot.overlay` / `fg`）与 `GuiGraphics.innerBlit` 界面级纹理重映射分发中心。
 *
 * 工作机制：
 * 1. 未注册监听器或无活跃纹理重映射时，Mixin 入口检查 `volatile boolean` 标志后直接返回；
 * 2. 分发容器界面回调时通过 [PoseStackWatermark] 记录并恢复精确矩阵栈深度，并由 [RenderFaultCircuitBreaker] 记录异常计数与超阈值熔断；
 * 3. 纹理重映射与当前打开的 `Screen` 实例通过弱引用绑定：当关联界面关闭、切换至其他界面或退回游戏世界时，重映射表自动清空失效。
 *
 * 已知边界：
 * - 纹理重映射作用于当前活跃 `Screen` 生命周期内的 `GuiGraphics.innerBlit` 调用；若同一界面上其他模组绘制了与重映射源路径相同的贴图，也会一并应用该重映射。
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
    private var boundScreenOwnerRef: WeakReference<Any>? = null

    /** 供无头单元测试覆盖当前活跃 Screen 探测逻辑；生产环境下保持为 null，默认读取 `Minecraft.getInstance()?.screen`。 */
    @Volatile
    internal var activeScreenSupplierForTest: (() -> Any?)? = null

    val circuitBreaker = RenderFaultCircuitBreaker(
        module = "EpiphySurface2D",
        channelTag = "GuiContainerHooks",
        tripThreshold = 8
    )

    @Volatile
    @JvmField
    var hasContainerListeners: Boolean = false

    @Volatile
    @JvmField
    var hasTextureRemaps: Boolean = false

    private fun resolveCurrentActiveScreen(): Any? {
        val testSupplier = activeScreenSupplierForTest
        if (testSupplier != null) return testSupplier.invoke()
        return runCatching { Minecraft.getInstance()?.screen }.getOrNull()
    }

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
    fun resetCircuitBreaker() {
        circuitBreaker.reset()
    }

    @JvmStatic
    @Synchronized
    fun setTextureRemap(original: ResourceLocation, replacement: ResourceLocation) {
        val currentScreen = resolveCurrentActiveScreen() ?: run {
            clearAllTextureRemaps()
            return
        }
        val prevScreen = boundScreenOwnerRef?.get()
        if (prevScreen !== currentScreen) {
            activeTextureRemaps.clear()
            boundScreenOwnerRef = WeakReference(currentScreen)
        }
        activeTextureRemaps[original] = replacement
        hasTextureRemaps = activeTextureRemaps.isNotEmpty()
    }

    @JvmStatic
    @Synchronized
    fun clearTextureRemap(original: ResourceLocation) {
        activeTextureRemaps.remove(original)
        hasTextureRemaps = activeTextureRemaps.isNotEmpty()
        if (!hasTextureRemaps) {
            boundScreenOwnerRef = null
        }
    }

    @JvmStatic
    @Synchronized
    fun clearAllTextureRemaps() {
        activeTextureRemaps.clear()
        boundScreenOwnerRef = null
        hasTextureRemaps = false
    }

    @JvmStatic
    @Synchronized
    fun onScreenClosing(closingScreen: Any?) {
        val bound = boundScreenOwnerRef?.get()
        if (bound == null || closingScreen == null || bound === closingScreen) {
            clearAllTextureRemaps()
        }
    }

    @JvmStatic
    fun remapTexture(original: ResourceLocation): ResourceLocation {
        if (!hasTextureRemaps) return original
        val currentScreen = resolveCurrentActiveScreen()
        val boundScreen = boundScreenOwnerRef?.get()
        if (currentScreen == null || boundScreen == null || currentScreen !== boundScreen) {
            clearAllTextureRemaps()
            return original
        }
        return activeTextureRemaps[original] ?: original
    }

    @JvmStatic
    fun dispatchAfterBackground(screen: AbstractContainerScreen<*>, graphics: GuiGraphics, mouseX: Int, mouseY: Int, partialTick: Float) {
        if (!hasContainerListeners || circuitBreaker.isTripped) return
        for (l in listeners) {
            PoseStackWatermark.runGuarded(graphics.pose(), circuitBreaker, "afterBackground") {
                l.onAfterBackground(screen, graphics, mouseX, mouseY, partialTick)
            }
        }
    }

    @JvmStatic
    fun dispatchBeforeSlot(screen: AbstractContainerScreen<*>, graphics: GuiGraphics, slot: Slot) {
        if (!hasContainerListeners || circuitBreaker.isTripped) return
        for (l in listeners) {
            PoseStackWatermark.runGuarded(graphics.pose(), circuitBreaker, "beforeSlot#${slot.index}") {
                l.onBeforeSlot(screen, graphics, slot)
            }
        }
    }

    @JvmStatic
    fun dispatchAfterSlot(screen: AbstractContainerScreen<*>, graphics: GuiGraphics, slot: Slot) {
        if (!hasContainerListeners || circuitBreaker.isTripped) return
        for (l in listeners) {
            PoseStackWatermark.runGuarded(graphics.pose(), circuitBreaker, "afterSlot#${slot.index}") {
                l.onAfterSlot(screen, graphics, slot)
            }
        }
    }

    @JvmStatic
    fun dispatchAfterForeground(screen: AbstractContainerScreen<*>, graphics: GuiGraphics, mouseX: Int, mouseY: Int, partialTick: Float) {
        if (!hasContainerListeners || circuitBreaker.isTripped) return
        for (l in listeners) {
            PoseStackWatermark.runGuarded(graphics.pose(), circuitBreaker, "afterForeground") {
                l.onAfterForeground(screen, graphics, mouseX, mouseY, partialTick)
            }
        }
    }
}
