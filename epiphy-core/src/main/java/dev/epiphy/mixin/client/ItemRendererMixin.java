// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.mixin.client;

import com.llamalad7.mixinextras.injector.wrapmethod.WrapMethod;
import com.llamalad7.mixinextras.injector.wrapoperation.Operation;
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
 * 物品 3D 自定义图层挂载与可重入单物品局部缓冲隔离 Mixin（注入 {@link ItemRenderer#render}）：
 * <ul>
 *   <li>通过 MixinExtras {@link WrapMethod} 在真实 {@code try / finally} 异常表保护下，按需为需要深度刷新的已绑定物品从可重入槽池借出独立局部 {@link MultiBufferSource}；
 *       即使发生嵌套子物品渲染（BEWLR）、中途提前取消或未捕获异常，也在 {@code finally} 中精确刷新并归还当前层级借出的专属缓冲槽，不打断外部容器多槽位共享批次；</li>
 *   <li>当模型配置指定 {@code renderBase = false} 时，在局部坐标系完成 {@code translate(-0.5, -0.5, -0.5)} 后跳过原版基底 {@link BakedModel} 绘制，提交自定义 3D 图层并对称执行 {@code popPose()}；</li>
 *   <li>当保持默认 {@code renderBase = true} 时，利用 {@link Slice} 从 {@code renderByItem} 之后匹配末尾退出 {@code popPose()}，在原版基底提交之后追加自定义 3D 图层。</li>
 * </ul>
 */
@Mixin(ItemRenderer.class)
public abstract class ItemRendererMixin {

    @WrapMethod(
        method = "render(Lnet/minecraft/world/item/ItemStack;Lnet/minecraft/world/item/ItemDisplayContext;ZLcom/mojang/blaze3d/vertex/PoseStack;Lnet/minecraft/client/renderer/MultiBufferSource;IILnet/minecraft/client/resources/model/BakedModel;)V"
    )
    private void epiphy$wrapRenderWithIsolatedBuffer(
        ItemStack itemStack,
        ItemDisplayContext displayContext,
        boolean leftHand,
        PoseStack poseStack,
        MultiBufferSource buffer,
        int combinedLight,
        int combinedOverlay,
        BakedModel model,
        Operation<Void> original
    ) {
        MultiBufferSource leasedOrOuter = Item3DRenderHooks.hasBoundItems
            ? Item3DRenderHooks.acquireIsolatedRenderBuffer(itemStack, model, buffer)
            : buffer;
        try {
            original.call(itemStack, displayContext, leftHand, poseStack, leasedOrOuter, combinedLight, combinedOverlay, model);
        } finally {
            if (leasedOrOuter != buffer) {
                Item3DRenderHooks.releaseIsolatedRenderBuffer(leasedOrOuter);
            }
        }
    }

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
            try {
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
            } finally {
                poseStack.popPose();
            }
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
