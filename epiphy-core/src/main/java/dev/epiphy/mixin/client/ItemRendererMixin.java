// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.mixin.client;

import com.mojang.blaze3d.vertex.PoseStack;
import dev.epiphy.client.fx3d.item.Item3DRenderHooks;
import net.minecraft.client.renderer.MultiBufferSource;
import net.minecraft.client.renderer.entity.ItemRenderer;
import net.minecraft.client.resources.model.BakedModel;
import net.minecraft.world.item.ItemDisplayContext;
import net.minecraft.world.item.ItemStack;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.Slice;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * 原生零 CCL 物品 3D 声明式图层挂载 Mixin：
 * <ul>
 *   <li>当已绑定物品的声明式规范显式指定 {@code model.renderBase = false} 时，在局部坐标系平移 {@code (-0.5, -0.5, -0.5)} 完成后跳过原版基底 {@link BakedModel} 绘制，直接提交自定义 3D 图层并对称弹出 {@link PoseStack}；</li>
 *   <li>当保持默认 {@code model.renderBase = true} 时，通过 {@link Slice} 精准锚定方法尾声唯一的退出 {@code popPose()}（排除动态附魔纹理内层 {@code popPose()} 干扰），在原版基底绘制完成后紧接提交声明式 3D 图层。</li>
 * </ul>
 */
@Mixin(ItemRenderer.class)
public abstract class ItemRendererMixin {

    @Inject(
        method = "render(Lnet/minecraft/world/item/ItemStack;Lnet/minecraft/world/item/ItemDisplayContext;ZLcom/mojang/blaze3d/vertex/PoseStack;Lnet/minecraft/client/renderer/MultiBufferSource;IILnet/minecraft/client/resources/model/BakedModel;)V",
        at = @At(
            value = "INVOKE",
            target = "Lcom/mojang/blaze3d/vertex/PoseStack;translate(FFF)V",
            shift = At.Shift.AFTER
        ),
        cancellable = true
    )
    private void epiphy$handleRenderBaseOverride(
        ItemStack itemStack,
        ItemDisplayContext displayContext,
        boolean leftHand,
        PoseStack poseStack,
        MultiBufferSource buffer,
        int combinedLight,
        int combinedOverlay,
        BakedModel model,
        CallbackInfo ci
    ) {
        if (!Item3DRenderHooks.hasBoundItems) return;
        if (!Item3DRenderHooks.shouldRenderBaseModel(itemStack)) {
            Item3DRenderHooks.dispatchCustomLayers(
                itemStack,
                displayContext,
                leftHand,
                poseStack,
                buffer,
                combinedLight,
                combinedOverlay,
                model
            );
            poseStack.popPose();
            ci.cancel();
        }
    }

    @Inject(
        method = "render(Lnet/minecraft/world/item/ItemStack;Lnet/minecraft/world/item/ItemDisplayContext;ZLcom/mojang/blaze3d/vertex/PoseStack;Lnet/minecraft/client/renderer/MultiBufferSource;IILnet/minecraft/client/resources/model/BakedModel;)V",
        slice = @Slice(
            from = @At(
                value = "INVOKE",
                target = "Lnet/minecraft/client/renderer/BlockEntityWithoutLevelRenderer;renderByItem(Lnet/minecraft/world/item/ItemStack;Lnet/minecraft/world/item/ItemDisplayContext;Lcom/mojang/blaze3d/vertex/PoseStack;Lnet/minecraft/client/renderer/MultiBufferSource;II)V"
            )
        ),
        at = @At(
            value = "INVOKE",
            target = "Lcom/mojang/blaze3d/vertex/PoseStack;popPose()V",
            shift = At.Shift.BEFORE
        )
    )
    private void epiphy$renderItem3DOverlay(
        ItemStack itemStack,
        ItemDisplayContext displayContext,
        boolean leftHand,
        PoseStack poseStack,
        MultiBufferSource buffer,
        int combinedLight,
        int combinedOverlay,
        BakedModel model,
        CallbackInfo ci
    ) {
        if (!Item3DRenderHooks.hasBoundItems) return;
        Item3DRenderHooks.dispatchCustomLayers(
            itemStack,
            displayContext,
            leftHand,
            poseStack,
            buffer,
            combinedLight,
            combinedOverlay,
            model
        );
    }
}
