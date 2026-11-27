// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.api.cache

/**
 * 有界淘汰策略：严格对齐 `EpiphySpec.createBoundedCache(maxSize, 'fifo' | 'lru')`。
 */
enum class EvictionPolicy {
    FIFO,
    LRU
}

/**
 * 基于 JDK [LinkedHashMap] 的有界键值缓存容器，支持 FIFO（按插入顺序淘汰）与 LRU（按最近访问顺序淘汰）。
 *
 * 已知边界：
 * - `get`、`set`、`has`、`delete` 的均摊时间复杂度为 `O(1)`；但在 `LRU` 策略下，`peek` 为避免触发 `LinkedHashMap` 的访问序重排，采用 `entries` 线性查找（`O(N)`）；
 * - 线程安全通过实例级 `@Synchronized` 互斥锁维持，适用于常规预设与元数据缓存，不适用于多线程高争用热路径。
 */
class BoundedCache<K : Any, V : Any>(
    val maxSize: Int,
    val policy: EvictionPolicy = EvictionPolicy.LRU
) {
    init {
        require(maxSize >= 1) { "BoundedCache maxSize must be >= 1, got $maxSize" }
    }

    private val backing = object : LinkedHashMap<K, V>(
        minOf(maxSize + 1, 64),
        0.75f,
        policy == EvictionPolicy.LRU
    ) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<K, V>?): Boolean =
            size > this@BoundedCache.maxSize
    }

    var hits: Long = 0L
        private set

    var misses: Long = 0L
        private set

    var evictions: Long = 0L
        private set

    val size: Int
        @Synchronized get() = backing.size

    @Synchronized
    fun get(key: K): V? {
        val v = backing[key]
        if (v != null) {
            hits++
        } else {
            misses++
        }
        return v
    }

    @Synchronized
    fun peek(key: K): V? =
        if (policy == EvictionPolicy.FIFO) {
            backing[key]
        } else {
            // 不改变 LRU 访问顺序的只读探测
            backing.entries.firstOrNull { it.key == key }?.value
        }

    @Synchronized
    fun set(key: K, value: V): V? {
        val existed = backing.containsKey(key)
        val before = backing.size
        val prev = backing.put(key, value)
        if (!existed && before >= maxSize && backing.size == maxSize) {
            evictions++
        }
        return prev
    }

    @Synchronized
    fun has(key: K): Boolean = backing.containsKey(key)

    @Synchronized
    fun delete(key: K): Boolean = backing.remove(key) != null

    @Synchronized
    fun clear() {
        backing.clear()
    }

    @Synchronized
    fun keysSnapshot(): List<K> = backing.keys.toList()
}
