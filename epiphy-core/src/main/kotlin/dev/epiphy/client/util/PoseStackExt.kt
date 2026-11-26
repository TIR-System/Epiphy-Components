// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.client.util

import com.mojang.blaze3d.vertex.PoseStack

/**
 * 渲染矩阵栈零泄漏内联扩展原语（迁移计划书 §2.3 第 4 条）。
 *
 * 严禁使用 `kfflib` 自带的 `PoseStackUtilKt.use`（非 `inline` 分配闭包且无 `try / finally` 异常表）。
 * 本函数在编译期直接展开为无分配的 `pushPose()` + `try / finally { popPose() }`。
 */
inline fun PoseStack.withPose(block: PoseStack.() -> Unit) {
    this.pushPose()
    try {
        this.block()
    } finally {
        this.popPose()
    }
}
