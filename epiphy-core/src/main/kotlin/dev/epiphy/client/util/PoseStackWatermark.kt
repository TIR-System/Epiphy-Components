// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.client.util

import com.mojang.blaze3d.vertex.PoseStack
import dev.epiphy.mixin.client.PoseStackAccessor
import org.joml.Matrix3f
import org.joml.Matrix4f

/**
 * 基于 `PoseStackAccessor` 的矩阵栈深度水位线守卫。
 *
 * 工作机制：
 * 1. 进入回调前读取 `PoseStack` 内部双端队列当前深度 `entryDepth`，备份入口栈顶的 4x4 姿态矩阵与 3x3 法线矩阵，随后推入一层隔离工作帧；
 * 2. 回调抛出的普通异常交由 [RenderFaultCircuitBreaker] 计数与限频告警，致命 JVM 错误直接向外重抛；
 * 3. 在 `finally` 阶段核对栈深：
 *    - 若回调内部多执行了 `pushPose()` 未弹出（栈溢出泄漏），循环弹出多余帧直至恢复 `entryDepth`，并向熔断器记录结构异常；
 *    - 若回调内部多执行了 `popPose()` 误弹出外层帧（栈下溢透支），补推缺失帧至 `entryDepth` 并将入口矩阵备份写回栈顶帧，同时向熔断器记录结构异常。
 *
 * 已知边界：
 * - 若在未启用 Mixin 转换的无头测试环境中传入普通 `PoseStack`（未实现 [PoseStackAccessor]），守卫会退化为外层单次对称 `pushPose/popPose`；测试可通过实现 [PoseStackAccessor] 的子类验证完整双向深度恢复。
 */
object PoseStackWatermark {

    fun runGuarded(
        poseStack: PoseStack,
        breaker: RenderFaultCircuitBreaker,
        detailContext: String? = null,
        block: () -> Unit
    ): Boolean {
        if (breaker.isTripped) return false

        val deque = (poseStack as? PoseStackAccessor)?.`epiphy$getPoseDeque`()
        if (deque == null) {
            poseStack.pushPose()
            return try {
                block()
                breaker.recordSuccess()
                true
            } catch (t: Throwable) {
                breaker.recordFailure(t, detailContext)
                false
            } finally {
                runCatching { poseStack.popPose() }
            }
        }

        val entryDepth = deque.size.coerceAtLeast(1)
        val entryTop = poseStack.last()
        val backupPose = Matrix4f(entryTop.pose())
        val backupNormal = Matrix3f(entryTop.normal())

        poseStack.pushPose()
        val expectedWorkingDepth = entryDepth + 1
        var caughtFailure = false

        try {
            block()
        } catch (t: Throwable) {
            caughtFailure = true
            breaker.recordFailure(t, detailContext)
        } finally {
            val actualAfterDepth = deque.size
            if (actualAfterDepth == expectedWorkingDepth) {
                poseStack.popPose()
                if (!caughtFailure) {
                    breaker.recordSuccess()
                }
            } else if (actualAfterDepth > expectedWorkingDepth) {
                val leakedLayers = actualAfterDepth - expectedWorkingDepth
                while (deque.size > entryDepth) {
                    poseStack.popPose()
                }
                restoreTopMatrices(poseStack, backupPose, backupNormal)
                val ctx = if (!detailContext.isNullOrBlank()) "[$detailContext] " else ""
                breaker.recordStructuralAnomaly(
                    "${ctx}PoseStack overflow detected: listener leaked +$leakedLayers unpopped layer(s); restored depth to $entryDepth"
                )
            } else {
                val underflowLayers = expectedWorkingDepth - actualAfterDepth
                while (deque.size < entryDepth) {
                    poseStack.pushPose()
                }
                while (deque.size > entryDepth) {
                    poseStack.popPose()
                }
                restoreTopMatrices(poseStack, backupPose, backupNormal)
                val ctx = if (!detailContext.isNullOrBlank()) "[$detailContext] " else ""
                breaker.recordStructuralAnomaly(
                    "${ctx}PoseStack underflow detected: listener over-popped -$underflowLayers layer(s); rebuilt depth to $entryDepth"
                )
            }
        }
        return !caughtFailure
    }

    private fun restoreTopMatrices(poseStack: PoseStack, backupPose: Matrix4f, backupNormal: Matrix3f) {
        val top = poseStack.last()
        top.pose().set(backupPose)
        top.normal().set(backupNormal)
    }
}
