// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.api

/**
 * 三段式语义化版本 (`major.minor.patch`) 与闭区间依赖校验器 (`min <= v <= max`)。
 * 对应原 KubeJS `EpiphySpec` 的 `parseSemver` / `compareSemver` / `isVersionInRange`。
 */
data class SemVer(
    val major: Int,
    val minor: Int,
    val patch: Int,
    val preRelease: String? = null
) : Comparable<SemVer> {

    init {
        require(major >= 0 && minor >= 0 && patch >= 0) {
            "SemVer components must be non-negative: $major.$minor.$patch"
        }
    }

    override fun compareTo(other: SemVer): Int {
        if (major != other.major) return major.compareTo(other.major)
        if (minor != other.minor) return minor.compareTo(other.minor)
        if (patch != other.patch) return patch.compareTo(other.patch)
        val aPre = preRelease
        val bPre = other.preRelease
        if (aPre == bPre) return 0
        if (aPre == null) return 1
        if (bPre == null) return -1
        return comparePreReleaseIdentifiers(aPre, bPre)
    }

    override fun toString(): String =
        if (preRelease.isNullOrEmpty()) "$major.$minor.$patch" else "$major.$minor.$patch-$preRelease"

    companion object {
        private val SEMVER_REGEX =
            Regex("""^\s*v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?\s*$""")

        @JvmStatic
        fun parseOrNull(raw: String?): SemVer? {
            if (raw.isNullOrBlank()) return null
            val match = SEMVER_REGEX.matchEntire(raw) ?: return null
            val maj = match.groupValues[1].toIntOrNull() ?: return null
            val min = match.groupValues[2].toIntOrNull() ?: return null
            val pat = match.groupValues[3].toIntOrNull() ?: return null
            val pre = match.groupValues[4].ifEmpty { null }
            return SemVer(maj, min, pat, pre)
        }

        @JvmStatic
        fun parse(raw: String): SemVer =
            parseOrNull(raw) ?: throw IllegalArgumentException("Invalid 3-segment SemVer: '$raw'")

        private fun isDigitsOnly(s: String): Boolean =
            s.isNotEmpty() && s.all { it in '0'..'9' }

        /**
         * 遵循 SemVer 2.0.0 §11 预发布标识符比较规则：
         * 按 `.` 拆分后逐段比对，纯非负整数段按数值大小比较（如 `alpha.2 < alpha.10`），且纯数字段优先级低于含字母段。
         */
        private fun comparePreReleaseIdentifiers(a: String, b: String): Int {
            val aParts = a.split('.')
            val bParts = b.split('.')
            val minLen = minOf(aParts.size, bParts.size)
            for (i in 0 until minLen) {
                val segA = aParts[i]
                val segB = bParts[i]
                if (segA == segB) continue
                val numA = isDigitsOnly(segA)
                val numB = isDigitsOnly(segB)
                if (numA && numB) {
                    val trimmedA = segA.trimStart('0').ifEmpty { "0" }
                    val trimmedB = segB.trimStart('0').ifEmpty { "0" }
                    if (trimmedA.length != trimmedB.length) {
                        return trimmedA.length.compareTo(trimmedB.length)
                    }
                    return trimmedA.compareTo(trimmedB)
                }
                if (numA != numB) {
                    return if (numA) -1 else 1
                }
                return segA.compareTo(segB)
            }
            return aParts.size.compareTo(bParts.size)
        }

        @JvmStatic
        fun isInClosedRange(actual: String?, minInclusive: String?, maxInclusive: String?): Boolean {
            val v = parseOrNull(actual) ?: return false
            val minV = if (minInclusive.isNullOrBlank()) null else (parseOrNull(minInclusive) ?: return false)
            val maxV = if (maxInclusive.isNullOrBlank()) null else (parseOrNull(maxInclusive) ?: return false)
            if (minV != null && v < minV) return false
            if (maxV != null && v > maxV) return false
            return true
        }
    }
}
