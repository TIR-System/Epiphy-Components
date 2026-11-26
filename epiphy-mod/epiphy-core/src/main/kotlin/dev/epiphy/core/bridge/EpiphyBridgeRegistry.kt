// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.core.bridge

import java.util.concurrent.ConcurrentHashMap

/**
 * 原生核心 (`src/main`) 与可选脚本桥接层 (`src/compat`) 之间的零第三方依赖解耦注册中心。
 *
 * - M1 基础设施底座 (`EpiphySpec` / `EpiphyServerCore` / `EpiphyLog` / `EpiphyDebug`)
 *   与 M2 视听高消耗热路径原生加速后端（`Item3D` / `World3D` / `Surface2D` / `AudioClient`）
 *   在初始化时向本中心注册门面对象；
 * - 当环境中安装了 KubeJS 时，`EpiphyKubeJSPlugin` 自动将此处注册的门面同步注入顶层绑定与 `global.*`。
 */
object EpiphyBridgeRegistry {
    @Volatile
    var coreVersion: String = "0.0.0"
        private set

    @Volatile
    var mixinBoosterActive: Boolean = false
        private set

    private val globalExports = ConcurrentHashMap<String, Any>()
    private val accelerators = ConcurrentHashMap<String, Any>()

    fun markCoreBootstrapped(version: String, boosterActive: Boolean) {
        coreVersion = version
        mixinBoosterActive = boosterActive
    }

    /**
     * 注册将直接挂载至 KubeJS `global.<name>` 与顶层绑定的原生模块门面。
     */
    fun registerGlobalComponent(name: String, facade: Any, vararg officialAliases: String) {
        require(officialAliases.size <= 2) {
            "Component '$name' may declare at most 2 official aliases, got ${officialAliases.toList()}"
        }
        globalExports[name] = facade
        for (alias in officialAliases) {
            if (alias.isNotBlank()) {
                globalExports[alias] = facade
            }
        }
    }

    /**
     * 注册供 KubeJS 视听脚本按需调用的原生高性能加速算子后端（类 CCL 模式）。
     */
    fun registerAccelerator(domain: String, backend: Any) {
        require(domain.isNotBlank()) { "Accelerator domain must not be blank" }
        accelerators[domain.trim()] = backend
    }

    fun getAccelerator(domain: String): Any? = accelerators[domain.trim()]

    fun hasAccelerator(domain: String): Boolean = accelerators.containsKey(domain.trim())

    fun listAccelerators(): Set<String> = accelerators.keys.toSortedSet()

    fun snapshotGlobalComponents(): Map<String, Any> = HashMap(globalExports)
}
