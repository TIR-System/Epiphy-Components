// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.api.preset

import java.util.concurrent.ConcurrentHashMap

/**
 * 跨阶段向上预设注册表（Startup -> Server / Client 共享）。
 * 支持静态不可变预设对象与按调用上下文动态生成的工厂预设。
 */
class PresetRegistry<T : Any>(val domain: String) {
    private sealed interface Entry<T : Any> {
        data class StaticValue<T : Any>(val value: T) : Entry<T>
        data class DynamicFactory<T : Any>(val factory: (Map<String, Any?>) -> T) : Entry<T>
    }

    private val entries = ConcurrentHashMap<String, Entry<T>>()

    private fun normalizeKey(id: String): String = id.trim()

    fun register(id: String, preset: T) {
        val key = normalizeKey(id)
        require(key.isNotEmpty()) { "Preset id in domain '$domain' must not be blank" }
        entries[key] = Entry.StaticValue(preset)
    }

    fun registerFactory(id: String, factory: (Map<String, Any?>) -> T) {
        val key = normalizeKey(id)
        require(key.isNotEmpty()) { "Preset factory id in domain '$domain' must not be blank" }
        entries[key] = Entry.DynamicFactory(factory)
    }

    fun unregister(id: String): Boolean = entries.remove(normalizeKey(id)) != null

    fun has(id: String): Boolean = entries.containsKey(normalizeKey(id))

    fun resolve(id: String, params: Map<String, Any?> = emptyMap()): T? {
        val key = normalizeKey(id)
        if (key.isEmpty()) return null
        return when (val entry = entries[key]) {
            is Entry.StaticValue -> entry.value
            is Entry.DynamicFactory -> entry.factory(params)
            null -> null
        }
    }

    fun listIds(): List<String> = entries.keys.sorted()

    fun clear() {
        entries.clear()
    }

    companion object {
        private val domains = ConcurrentHashMap<String, PresetRegistry<Any>>()

        @Suppress("UNCHECKED_CAST")
        @JvmStatic
        fun <T : Any> domain(name: String): PresetRegistry<T> {
            val norm = name.trim().lowercase()
            require(norm.isNotEmpty()) { "Preset domain must not be blank" }
            return domains.computeIfAbsent(norm) { PresetRegistry(norm) } as PresetRegistry<T>
        }
    }
}
