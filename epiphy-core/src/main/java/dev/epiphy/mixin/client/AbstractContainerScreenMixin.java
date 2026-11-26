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
 * 容器界面四相位精准夹心 Mixin（完结 P2-1 与 P2-3 阻塞项）：
 * 1. `renderBg` 返回后（全部槽位之前） -> `bgNodes`；
 * 2. `renderSlot` 头部 -> `slot.underlayNodes`（位于物品图标底层）；
 * 3. `renderSlot` 尾部 -> `slot.overlayNodes`（位于物品图标与数量叠字顶层）；
 * 4. `render` 尾部（全部槽位与前景标签之后） -> `fgNodes`。
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
