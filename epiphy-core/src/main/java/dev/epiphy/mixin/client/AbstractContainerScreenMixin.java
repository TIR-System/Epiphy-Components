// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.mixin.client;

import dev.epiphy.client.surface2d.hook.GuiInterceptionHooks;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.screens.inventory.AbstractContainerScreen;
import net.minecraft.world.inventory.Slot;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * 容器界面（{@link AbstractContainerScreen}）四阶段绘制挂载 Mixin：
 * <ol>
 *   <li>{@code renderBg} 返回后（槽位绘制前）：分发背景扩展层；</li>
 *   <li>{@code renderSlot} 头部：分发单槽位底层衬底（位于物品图标下方）；</li>
 *   <li>{@code renderSlot} 尾部：分发单槽位顶层叠画（位于物品图标与数量文字上方）；</li>
 *   <li>{@code render} 尾部（槽位与前景标签绘制完成后）：分发整体前景层。</li>
 * </ol>
 */
@Mixin(AbstractContainerScreen.class)
public abstract class AbstractContainerScreenMixin {

    @Inject(
        method = "render(Lnet/minecraft/client/gui/GuiGraphics;IIF)V",
        at = @At(
            value = "INVOKE",
            target = "Lnet/minecraft/client/gui/screens/inventory/AbstractContainerScreen;renderBg(Lnet/minecraft/client/gui/GuiGraphics;FII)V",
            shift = At.Shift.AFTER
        )
    )
    private void epiphy$afterRenderBg(GuiGraphics guiGraphics, int mouseX, int mouseY, float partialTick, CallbackInfo ci) {
        if (!GuiInterceptionHooks.hasContainerListeners) return;
        GuiInterceptionHooks.dispatchAfterBackground((AbstractContainerScreen<?>) (Object) this, guiGraphics, mouseX, mouseY, partialTick);
    }

    @Inject(
        method = "renderSlot(Lnet/minecraft/client/gui/GuiGraphics;Lnet/minecraft/world/inventory/Slot;)V",
        at = @At("HEAD")
    )
    private void epiphy$beforeRenderSlot(GuiGraphics guiGraphics, Slot slot, CallbackInfo ci) {
        if (!GuiInterceptionHooks.hasContainerListeners) return;
        GuiInterceptionHooks.dispatchBeforeSlot((AbstractContainerScreen<?>) (Object) this, guiGraphics, slot);
    }

    @Inject(
        method = "renderSlot(Lnet/minecraft/client/gui/GuiGraphics;Lnet/minecraft/world/inventory/Slot;)V",
        at = @At("RETURN")
    )
    private void epiphy$afterRenderSlot(GuiGraphics guiGraphics, Slot slot, CallbackInfo ci) {
        if (!GuiInterceptionHooks.hasContainerListeners) return;
        GuiInterceptionHooks.dispatchAfterSlot((AbstractContainerScreen<?>) (Object) this, guiGraphics, slot);
    }

    @Inject(
        method = "render(Lnet/minecraft/client/gui/GuiGraphics;IIF)V",
        at = @At("RETURN")
    )
    private void epiphy$afterRenderForeground(GuiGraphics guiGraphics, int mouseX, int mouseY, float partialTick, CallbackInfo ci) {
        if (!GuiInterceptionHooks.hasContainerListeners) return;
        GuiInterceptionHooks.dispatchAfterForeground((AbstractContainerScreen<?>) (Object) this, guiGraphics, mouseX, mouseY, partialTick);
    }
}
