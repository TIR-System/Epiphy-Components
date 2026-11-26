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
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * 原生零 CCL 物品 3D 特效挂载 Mixin：
 * 在 `ItemRenderer.render` 完成原版基底模型变换但尚未弹出最终物品局部 `PoseStack` 前（或紧随基底绘制后），
 * 对命中 `Item3DRenderHooks` 的物品追加绘制声明式 3D 特效图层。
 */
@Mixin(ItemRenderer.class)
public abstract class ItemRendererMixin {

    @Inject(
        method = "render(Lnet/minecraft/world/item/ItemStack;Lnet/minecraft/world/item/ItemDisplayContext;ZLcom/mojang/blaze3d/vertex/PoseStack;Lnet/minecraft/client/renderer/MultiBufferSource;IILnet/minecraft/client/resources/model/BakedModel;)V",
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
        Item3DRenderHooks.dispatchAfterBaseItem(
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
