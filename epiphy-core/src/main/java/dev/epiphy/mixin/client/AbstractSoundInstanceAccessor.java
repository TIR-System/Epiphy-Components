// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.mixin.client;

import net.minecraft.client.resources.sounds.AbstractSoundInstance;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

/**
 * 编译期校验的 {@link AbstractSoundInstance} 字段访问器（自动重映射 SRG f_119572_..f_119576_，彻底淘汰运行期反射）。
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
