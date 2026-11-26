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
 * 零 `CodeChickenLib` 依赖的原生物品 3D 渲染挂载中心。
 *
 * 通过 `IdentityHashMap<Item, Item3DOverlayRenderer>` 实现指针级 O(1) 匹配：
 * - 未注册 3D 特效的普通物品仅经过 1 次 `volatile boolean` 短路判空，零堆分配、零性能损耗；
 * - 命中物品在原版基底 `BakedModel` 绘制完成后紧接提交声明式 3D 特效层，外层强制 `PoseStack` 异常还原。
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

    private val registry: MutableMap<Item, Item3DOverlayRenderer> =
        Collections.synchronizedMap(IdentityHashMap())

    @Volatile
    @JvmField
    var hasBoundItems: Boolean = false

    @JvmStatic
    fun bindItem(item: Item, renderer: Item3DOverlayRenderer) {
        registry[item] = renderer
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
    fun dispatchAfterBaseItem(
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
        val renderer = registry[stack.item] ?: return
        poseStack.pushPose()
        try {
            renderer.renderOverlay(
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
            // 单件物品特效异常静默隔离，确保手持与背包界面不崩溃
        } finally {
            runCatching { poseStack.popPose() }
        }
    }
}
