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
 * O(1) 均摊复杂度的有界键值缓存池。
 * 基于 JDK 内置双向哈希链表 [LinkedHashMap]，零迭代器分配地支持 FIFO（插入序）与 LRU（访问序）淘汰。
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
