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
import org.spongepowered.asm.mixin.injection.ModifyVariable;
import org.spongepowered.asm.mixin.injection.Slice;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * 物品 3D 自定义图层挂载与单物品局部缓冲隔离 Mixin（注入 {@link ItemRenderer#render}）：
 * <ul>
 *   <li>当已绑定物品启用了 {@code flushBase = true} 且非自定义特殊渲染器时，在方法入口将该次调用的 {@link MultiBufferSource} 替换为单物品复用的局部缓冲源，
 *       使基底深度刷新仅刷出当前单件物品的顶点，避免在容器界面多槽位绘制中途打断外部共享 {@code BufferSource} 的其他物品队列；</li>
 *   <li>当模型配置指定 {@code renderBase = false} 时，在局部坐标系完成 {@code translate(-0.5, -0.5, -0.5)} 后跳过原版基底 {@link BakedModel} 绘制，提交自定义 3D 图层、刷出局部缓冲并对称执行 {@code popPose()}；</li>
 *   <li>当保持默认 {@code renderBase = true} 时，利用 {@link Slice} 从 {@code renderByItem} 之后匹配末尾退出 {@code popPose()}，在原版基底提交之后追加自定义 3D 图层，并在方法返回处统一收尾归还局部缓冲源。</li>
 * </ul>
 */
@Mixin(ItemRenderer.class)
public abstract class ItemRendererMixin {

    @ModifyVariable(
        method = "render(Lnet/minecraft/world/item/ItemStack;Lnet/minecraft/world/item/ItemDisplayContext;ZLcom/mojang/blaze3d/vertex/PoseStack;Lnet/minecraft/client/renderer/MultiBufferSource;IILnet/minecraft/client/resources/model/BakedModel;)V",
        at = @At("HEAD"),
        argsOnly = true
    )
    private MultiBufferSource epiphy$isolateBoundItemBuffer(
        MultiBufferSource outerBuffer,
        ItemStack itemStack,
        ItemDisplayContext displayContext,
        boolean leftHand,
        PoseStack poseStack,
        MultiBufferSource originalBuffer,
        int combinedLight,
        int combinedOverlay,
        BakedModel model
    ) {
        if (!Item3DRenderHooks.hasBoundItems) return outerBuffer;
        return Item3DRenderHooks.resolveRenderBuffer(itemStack, model, outerBuffer);
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
                Item3DRenderHooks.finishIsolatedRenderBuffer(buffer);
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

    @Inject(
        method = "render(Lnet/minecraft/world/item/ItemStack;Lnet/minecraft/world/item/ItemDisplayContext;ZLcom/mojang/blaze3d/vertex/PoseStack;Lnet/minecraft/client/renderer/MultiBufferSource;IILnet/minecraft/client/resources/model/BakedModel;)V",
        at = @At("RETURN")
    )
    private void epiphy$releaseIsolatedBufferOnReturn(
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
        Item3DRenderHooks.finishIsolatedRenderBuffer(buffer);
    }
}
