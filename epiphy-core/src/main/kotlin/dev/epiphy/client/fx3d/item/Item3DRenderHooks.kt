// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.client.fx3d.item

import com.mojang.blaze3d.vertex.PoseStack
import dev.epiphy.client.util.PoseStackWatermark
import dev.epiphy.client.util.RenderFaultCircuitBreaker
import net.minecraft.client.renderer.MultiBufferSource
import net.minecraft.client.resources.model.BakedModel
import net.minecraft.world.item.Item
import net.minecraft.world.item.ItemDisplayContext
import net.minecraft.world.item.ItemStack
import java.util.Collections
import java.util.IdentityHashMap

/**
 * 原生物品 3D 图层挂载注册表（不依赖 `CodeChickenLib`）。
 *
 * 工作机制：
 * 1. 使用 `IdentityHashMap<Item, BoundItemEntry>` 按物品实例引用匹配已绑定渲染器；未绑定任何物品时，Mixin 入口读取 `hasBoundItems` 布尔标志后直接返回；
 * 2. 对启用了 `isolateBuffer = true` 的绑定物品，将单次绘制转导至 `NativeItem3DEngine` 的局部独立 `MultiBufferSource.BufferSource`，避免刷新深度缓冲时打断外部容器共享批次；
 * 3. 分发自定义图层时通过 [PoseStackWatermark] 保证矩阵栈深度平衡，并由 [RenderFaultCircuitBreaker] 计数限频告警与超阈值熔断。
 *
 * 已知边界：
 * - 当第三方光影模组传入非标准 `MultiBufferSource.BufferSource` 实现时，`resolveRenderBuffer` 会保留外部传入的 `MultiBufferSource` 实例以维持光影管线兼容。
 */
object Item3DRenderHooks {

    fun interface Item3DOverlayRenderer {
        fun renderOverlay(
            stack: ItemStack,
            displayContext: ItemDisplayContext,
            leftHand: Boolean,
            poseStack: PoseStack,
            bufferSource: MultiBufferSource,
            combinedLight: Int,
            combinedOverlay: Int,
            bakedModel: BakedModel
        )
    }

    private class BoundItemEntry(
        val renderBase: Boolean,
        val isolateBuffer: Boolean,
        val renderer: Item3DOverlayRenderer
    )

    private val registry: MutableMap<Item, BoundItemEntry> =
        Collections.synchronizedMap(IdentityHashMap())

    val circuitBreaker = RenderFaultCircuitBreaker(
        module = "EpiphyItem3D",
        channelTag = "Item3DRenderHooks",
        tripThreshold = 8
    )

    @Volatile
    @JvmField
    var hasBoundItems: Boolean = false

    @JvmStatic
    @JvmOverloads
    fun bindItem(
        item: Item,
        renderBase: Boolean = true,
        isolateBuffer: Boolean = true,
        renderer: Item3DOverlayRenderer
    ) {
        registry[item] = BoundItemEntry(renderBase, isolateBuffer, renderer)
        hasBoundItems = registry.isNotEmpty()
    }

    @JvmStatic
    fun unbindItem(item: Item) {
        registry.remove(item)
        hasBoundItems = registry.isNotEmpty()
    }

    @JvmStatic
    fun clearAll() {
        registry.clear()
        hasBoundItems = false
    }

    @JvmStatic
    fun resetCircuitBreaker() {
        circuitBreaker.reset()
    }

    @JvmStatic
    fun shouldRenderBaseModel(stack: ItemStack): Boolean {
        if (!hasBoundItems || stack.isEmpty) return true
        if (!NativeItem3DEngine.enabled || circuitBreaker.isTripped) return true
        val entry = registry[stack.item] ?: return true
        return entry.renderBase
    }

    @JvmStatic
    fun acquireIsolatedRenderBuffer(
        stack: ItemStack,
        bakedModel: BakedModel?,
        outerBuffer: MultiBufferSource
    ): MultiBufferSource {
        if (!hasBoundItems || stack.isEmpty || !NativeItem3DEngine.enabled || circuitBreaker.isTripped) {
            return outerBuffer
        }
        val entry = registry[stack.item] ?: return outerBuffer
        if (!entry.isolateBuffer) return outerBuffer
        if (bakedModel != null && bakedModel.isCustomRenderer) return outerBuffer
        return NativeItem3DEngine.acquireIsolatedBufferSource(outerBuffer)
    }

    @JvmStatic
    fun releaseIsolatedRenderBuffer(leasedBuffer: MultiBufferSource?) {
        NativeItem3DEngine.releaseIsolatedBufferSource(leasedBuffer)
    }

    @JvmStatic
    fun dispatchCustomLayers(
        stack: ItemStack,
        displayContext: ItemDisplayContext,
        leftHand: Boolean,
        poseStack: PoseStack,
        bufferSource: MultiBufferSource,
        combinedLight: Int,
        combinedOverlay: Int,
        bakedModel: BakedModel
    ) {
        if (!hasBoundItems || stack.isEmpty || circuitBreaker.isTripped) return
        val entry = registry[stack.item] ?: return
        PoseStackWatermark.runGuarded(poseStack, circuitBreaker, stack.item.toString()) {
            entry.renderer.renderOverlay(
                stack,
                displayContext,
                leftHand,
                poseStack,
                bufferSource,
                combinedLight,
                combinedOverlay,
                bakedModel
            )
        }
    }

    @JvmStatic
    fun dispatchAfterBaseItem(
        stack: ItemStack,
        displayContext: ItemDisplayContext,
        leftHand: Boolean,
        poseStack: PoseStack,
        bufferSource: MultiBufferSource,
        combinedLight: Int,
        combinedOverlay: Int,
        bakedModel: BakedModel
    ) = dispatchCustomLayers(stack, displayContext, leftHand, poseStack, bufferSource, combinedLight, combinedOverlay, bakedModel)
}
