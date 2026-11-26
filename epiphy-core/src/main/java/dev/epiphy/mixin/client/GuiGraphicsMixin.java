// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.mixin.client;

import dev.epiphy.client.surface2d.hook.GuiInterceptionHooks;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.resources.ResourceLocation;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.ModifyVariable;

/**
 * 零全局状态污染的会话级纹理重映射 Mixin（取代脚本期高危的 `TextureManager.register` 全局覆盖）。
 */
@Mixin(GuiGraphics.class)
public abstract class GuiGraphicsMixin {

    @ModifyVariable(
        method = "innerBlit(Lnet/minecraft/resources/ResourceLocation;IIIIIFFFF)V",
        at = @At("HEAD"),
        ordinal = 0,
        argsOnly = true
    )
    private ResourceLocation epiphy$remapInnerBlitPlain(ResourceLocation atlasLocation) {
        if (!GuiInterceptionHooks.hasTextureRemaps) return atlasLocation;
        return GuiInterceptionHooks.remapTexture(atlasLocation);
    }

    @ModifyVariable(
        method = "innerBlit(Lnet/minecraft/resources/ResourceLocation;IIIIIFFFFFFFF)V",
        at = @At("HEAD"),
        ordinal = 0,
        argsOnly = true
    )
    private ResourceLocation epiphy$remapInnerBlitTinted(ResourceLocation atlasLocation) {
        if (!GuiInterceptionHooks.hasTextureRemaps) return atlasLocation;
        return GuiInterceptionHooks.remapTexture(atlasLocation);
    }
}
