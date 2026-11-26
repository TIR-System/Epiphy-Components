// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.mixin;

import net.minecraftforge.fml.loading.FMLLoader;
import org.objectweb.asm.tree.ClassNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.spongepowered.asm.mixin.extensibility.IMixinConfigPlugin;
import org.spongepowered.asm.mixin.extensibility.IMixinInfo;

import java.util.List;
import java.util.Set;

/**
 * Epiphy Mixin 启动期守卫插件（纯 Java 17 实现）。
 * 负责在 ModLauncher 早期探测 Sinytra MixinBooster (Fabric Mixin 0.15+) 是否就位，
 * 若用户在正式环境漏装 MixinBooster 仍停留在 LexForge 残缺 0.8.5，输出清晰可读的中英双语缺失提示。
 */
public final class EpiphyMixinPlugin implements IMixinConfigPlugin {
    private static final Logger LOGGER = LoggerFactory.getLogger("EpiphyMixinPlugin");
    private static volatile boolean mixinBoosterDetected = false;

    public static boolean isMixinBoosterActive() {
        return mixinBoosterDetected;
    }

    @Override
    public void onLoad(String mixinPackage) {
        mixinBoosterDetected = probeFabricMixinRuntime();
        if (mixinBoosterDetected) {
            LOGGER.info("[Epiphy] Modern Fabric Mixin runtime (MixinBooster) detected for package '{}'.", mixinPackage);
        } else if (FMLLoader.isProduction()) {
            String message = """
                [Epiphy] 缺少必需的现代字节码前置模组 Sinytra MixinBooster (org.sinytra.mixinbooster:mixin-booster)！
                [Epiphy] Missing required dependency: Sinytra MixinBooster! Please install MixinBooster for Forge 1.20.1 so Fabric Mixin 0.15+ features can load safely.
                """;
            LOGGER.error(message);
            throw new IllegalStateException(message.trim());
        } else {
            LOGGER.warn("[Epiphy] MixinBooster (FabricUtil) not detected in dev/test transformation layer; running in non-production compatibility mode.");
        }
    }

    private static boolean probeFabricMixinRuntime() {
        try {
            Class.forName("org.spongepowered.asm.mixin.FabricUtil", false, EpiphyMixinPlugin.class.getClassLoader());
            return true;
        } catch (ClassNotFoundException ignored) {
            return false;
        }
    }

    @Override
    public String getRefMapperConfig() {
        return null;
    }

    @Override
    public boolean shouldApplyMixin(String targetClassName, String mixinClassName) {
        return true;
    }

    @Override
    public void acceptTargets(Set<String> myTargets, Set<String> otherTargets) {
    }

    @Override
    public List<String> getMixins() {
        return null;
    }

    @Override
    public void preApply(String targetClassName, ClassNode targetClass, String mixinClassName, IMixinInfo mixinInfo) {
    }

    @Override
    public void postApply(String targetClassName, ClassNode targetClass, String mixinClassName, IMixinInfo mixinInfo) {
    }
}
