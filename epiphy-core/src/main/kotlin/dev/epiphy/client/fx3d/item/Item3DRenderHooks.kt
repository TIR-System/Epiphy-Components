// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.client.fx3d.item

import com.mojang.blaze3d.vertex.PoseStack
import net.minecraft.client.renderer.MultiBufferSource
import net.minecraft.client.resources.model.BakedModel
import net.minecraft.world.item.Item
import net.minecraft.world.item.ItemDisplayContext
import net.minecraft.world.item.ItemStack
import java.util.Collections
import java.util.IdentityHashMap

/**
 * 零 `CodeChickenLib` 依赖的原生物品 3D 声明式渲染挂载中心。
 *
 * 通过 `IdentityHashMap<Item, BoundItemEntry>` 实现指针级 O(1) 匹配：
 * - 未注册 3D 图层的普通物品仅经过 1 次 `volatile boolean` 短路判空，零堆分配、零性能损耗；
 * - 支持 `renderBase` 基底模型开关控制，外层强制执行 `PoseStack` 对称推弹异常保护。
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
        val renderer: Item3DOverlayRenderer
    )

    private val registry: MutableMap<Item, BoundItemEntry> =
        Collections.synchronizedMap(IdentityHashMap())

    @Volatile
    @JvmField
    var hasBoundItems: Boolean = false

    @JvmStatic
    @JvmOverloads
    fun bindItem(item: Item, renderBase: Boolean = true, renderer: Item3DOverlayRenderer) {
        registry[item] = BoundItemEntry(renderBase, renderer)
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
    fun shouldRenderBaseModel(stack: ItemStack): Boolean {
        if (!hasBoundItems || stack.isEmpty) return true
        if (!NativeItem3DEngine.enabled) return true
        val entry = registry[stack.item] ?: return true
        return entry.renderBase
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
        if (!hasBoundItems || stack.isEmpty) return
        val entry = registry[stack.item] ?: return
        poseStack.pushPose()
        try {
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
        } catch (_: Throwable) {
            // 单件物品图层异常静默隔离，确保手持与容器界面渲染栈不发生泄漏
        } finally {
            runCatching { poseStack.popPose() }
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
