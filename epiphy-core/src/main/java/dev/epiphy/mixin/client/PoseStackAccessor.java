// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.mixin.client;

import com.mojang.blaze3d.vertex.PoseStack;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

import java.util.Deque;

/**
 * 编译期 {@link PoseStack} 内部栈队列访问器，供渲染水位线守卫读取与校验精确栈深。
 */
@Mixin(PoseStack.class)
public interface PoseStackAccessor {
    @Accessor("poseStack")
    Deque<PoseStack.Pose> epiphy$getPoseDeque();
}
