// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.mixin.client;

import net.minecraft.client.resources.sounds.AbstractSoundInstance;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

/**
 * 编译期生成的 {@link AbstractSoundInstance} 受保护字段访问器（构建时由 Mixin 重映射为对应 SRG 字段名，替代运行期字符串反射）。
 */
@Mixin(AbstractSoundInstance.class)
public interface AbstractSoundInstanceAccessor {

    @Accessor("volume")
    float epiphy$getVolume();

    @Accessor("volume")
    void epiphy$setVolume(float volume);

    @Accessor("pitch")
    float epiphy$getPitch();

    @Accessor("pitch")
    void epiphy$setPitch(float pitch);

    @Accessor("x")
    double epiphy$getX();

    @Accessor("x")
    void epiphy$setX(double x);

    @Accessor("y")
    double epiphy$getY();

    @Accessor("y")
    void epiphy$setY(double y);

    @Accessor("z")
    double epiphy$getZ();

    @Accessor("z")
    void epiphy$setZ(double z);
}
