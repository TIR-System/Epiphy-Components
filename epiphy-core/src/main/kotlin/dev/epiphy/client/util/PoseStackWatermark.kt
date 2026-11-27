// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.client.util

import com.mojang.blaze3d.vertex.PoseStack
import dev.epiphy.mixin.client.PoseStackAccessor
import org.joml.Matrix3f
import org.joml.Matrix4f
import java.util.Deque

/**
 * 基于 `PoseStackAccessor` 的矩阵栈深度水位线守卫。
 *
 * 工作机制：
 * 1. 进入回调前检查 `PoseStack` 内部双端队列；若上游已意外传入空栈（`size == 0`），先注入一帧单位矩阵根帧再读取 `entryDepth` 并备份栈顶 `4x4 / 3x3` 矩阵；
 * 2. 推入一层隔离工作帧后执行回调，普通运行期异常交由 [RenderFaultCircuitBreaker] 计数与限频告警，致命 JVM 错误直接向外重抛；
 * 3. 在 `finally` 阶段核对栈深：
 *    - 若回调内部多执行了 `pushPose()` 未弹出（栈溢出泄漏），循环弹出多余帧直至恢复 `entryDepth`，并记录结构异常；
 *    - 若回调内部多执行了 `popPose()` 误弹出外层帧甚至将栈彻底弹空至 `size == 0`（此时原版 `PoseStack.pushPose()` 会因 `Deque.getLast()` 抛 `NoSuchElementException`），
 *      守卫先通过新建种子栈帧直接向空 `Deque` 填回首帧使 `size >= 1`，再补推至 `entryDepth` 并写回入口备份矩阵。
 *
 * 已知边界：
 * - 若在未启用 Mixin 转换的无头环境中传入未实现 [PoseStackAccessor] 的普通 `PoseStack`，守卫仅能执行外层单次对称 `pushPose/popPose`；无头测试可通过实现 [PoseStackAccessor] 的子类验证包括 `size == 0` 空栈在内的完整恢复逻辑。
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

        if (deque.isEmpty()) {
            appendSeedRootFrame(deque, Matrix4f(), Matrix3f())
        }

        val entryDepth = deque.size
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
                if (deque.isEmpty()) {
                    appendSeedRootFrame(deque, backupPose, backupNormal)
                }
                while (deque.size < entryDepth) {
                    poseStack.pushPose()
                }
                while (deque.size > entryDepth) {
                    poseStack.popPose()
                }
                restoreTopMatrices(poseStack, backupPose, backupNormal)
                val ctx = if (!detailContext.isNullOrBlank()) "[$detailContext] " else ""
                breaker.recordStructuralAnomaly(
                    "${ctx}PoseStack underflow detected: listener over-popped -$underflowLayers layer(s) (afterSize=$actualAfterDepth); rebuilt depth to $entryDepth"
                )
            }
        }
        return !caughtFailure
    }

    private fun appendSeedRootFrame(deque: Deque<PoseStack.Pose>, pose: Matrix4f, normal: Matrix3f) {
        val seedFrame = PoseStack().last()
        seedFrame.pose().set(pose)
        seedFrame.normal().set(normal)
        deque.addLast(seedFrame)
    }

    private fun restoreTopMatrices(poseStack: PoseStack, backupPose: Matrix4f, backupNormal: Matrix3f) {
        val top = poseStack.last()
        top.pose().set(backupPose)
        top.normal().set(backupNormal)
    }
}
