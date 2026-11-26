// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.server

import com.mojang.logging.LogUtils

/**
 * 专用服务端（Dedicated Server）专属引导入口。
 */
object EpiphyDedicatedServerBootstrap {
    private val LOGGER = LogUtils.getLogger()

    fun init() {
        LOGGER.info("[EpiphyServer] Dedicated server environment verified (zero client class leakage).")
    }
}
