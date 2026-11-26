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
        if (preRelease == other.preRelease) return 0
        if (preRelease == null) return 1
        if (other.preRelease == null) return -1
        return preRelease.compareTo(other.preRelease)
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
