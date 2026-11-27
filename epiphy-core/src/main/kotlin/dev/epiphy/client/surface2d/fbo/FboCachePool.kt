// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.client.surface2d.fbo

import com.mojang.blaze3d.pipeline.TextureTarget
import com.mojang.blaze3d.platform.GlStateManager
import com.mojang.blaze3d.systems.RenderSystem
import com.mojang.blaze3d.vertex.DefaultVertexFormat
import com.mojang.blaze3d.vertex.PoseStack
import com.mojang.blaze3d.vertex.Tesselator
import com.mojang.blaze3d.vertex.VertexFormat
import net.minecraft.client.Minecraft
import net.minecraft.client.renderer.GameRenderer

/**
 * `TextureTarget` (FBO) 按需离屏缓存池，供静态或低频变更的声明式 2D 节点子树复用合成纹理。
 *
 * 工作机制：
 * 1. 尺寸对齐与上限钳制：逻辑宽高钳制在 `[32, 2048]` 并按 32px 向上对齐分桶，以便相近尺寸面板复用空闲 `TextureTarget`；
 * 2. 预乘 Alpha 混合：离屏绘制写入预乘 Alpha，贴回屏幕或世界平面时使用 `blendFunc(GL_ONE, GL_ONE_MINUS_SRC_ALPHA)`，减轻半透明边缘二次衰减发暗现象；
 * 3. 状态清理：离屏绘制结束后在 `finally` 中解绑离屏目标、重新绑定主 `RenderTarget`，并重置混合函数与着色器颜色。
 *
 * 已知边界：
 * - 仅限客户端渲染线程调用（内部执行 `RenderSystem.assertOnRenderThread()`）；
 * - 按 32px 向上对齐会产生至多 31px 的右侧/底部纹理留白开销；不适用于依赖主帧深度缓冲与场景几何相互穿插遮挡的图层。
 */
class FboCachePool(
    val maxActiveEntries: Int = 32,
    val maxIdleBuckets: Int = 16,
    val idleExpireMs: Long = 30_000L
) {
    class CachedFboSurface internal constructor(
        val key: String,
        var logicalWidth: Int,
        var logicalHeight: Int,
        val bucketWidth: Int,
        val bucketHeight: Int,
        val target: TextureTarget,
        var dirty: Boolean = true,
        var lastUsedAtMs: Long = System.currentTimeMillis()
    )

    private val activeSurfaces = LinkedHashMap<String, CachedFboSurface>(32, 0.75f, true)
    private val idlePoolByBucket = HashMap<Long, ArrayDeque<TextureTarget>>()

    val activeCount: Int
        @Synchronized get() = activeSurfaces.size

    @Synchronized
    fun invalidate(key: String) {
        activeSurfaces[key]?.dirty = true
    }

    @Synchronized
    fun release(key: String) {
        val removed = activeSurfaces.remove(key) ?: return
        recycleTarget(removed.bucketWidth, removed.bucketHeight, removed.target)
    }

    @Synchronized
    fun acquireOrRender(
        key: String,
        width: Int,
        height: Int,
        forceDirty: Boolean = false,
        drawAction: (TextureTarget) -> Unit
    ): CachedFboSurface {
        RenderSystem.assertOnRenderThread()
        val lw = width.coerceIn(1, MAX_FBO_DIM)
        val lh = height.coerceIn(1, MAX_FBO_DIM)
        val bw = alignBucketDim(lw)
        val bh = alignBucketDim(lh)
        val now = System.currentTimeMillis()

        var entry = activeSurfaces[key]
        if (entry != null && (entry.bucketWidth != bw || entry.bucketHeight != bh)) {
            activeSurfaces.remove(key)
            recycleTarget(entry.bucketWidth, entry.bucketHeight, entry.target)
            entry = null
        }

        if (entry == null) {
            while (activeSurfaces.size >= maxActiveEntries) {
                val eldestKey = activeSurfaces.keys.firstOrNull() ?: break
                val evicted = activeSurfaces.remove(eldestKey)
                if (evicted != null) {
                    recycleTarget(evicted.bucketWidth, evicted.bucketHeight, evicted.target)
                }
            }
            val borrowed = borrowOrCreateTarget(bw, bh)
            entry = CachedFboSurface(
                key = key,
                logicalWidth = lw,
                logicalHeight = lh,
                bucketWidth = bw,
                bucketHeight = bh,
                target = borrowed,
                dirty = true,
                lastUsedAtMs = now
            )
            activeSurfaces[key] = entry
        } else {
            entry.logicalWidth = lw
            entry.logicalHeight = lh
            entry.lastUsedAtMs = now
            if (forceDirty) entry.dirty = true
        }

        if (entry.dirty) {
            val mc = Minecraft.getInstance()
            val mainTarget = mc.mainRenderTarget
            try {
                entry.target.setClearColor(0f, 0f, 0f, 0f)
                entry.target.clear(Minecraft.ON_OSX)
                entry.target.bindWrite(true)
                RenderSystem.enableBlend()
                RenderSystem.blendFuncSeparate(
                    GlStateManager.SourceFactor.SRC_ALPHA,
                    GlStateManager.DestFactor.ONE_MINUS_SRC_ALPHA,
                    GlStateManager.SourceFactor.ONE,
                    GlStateManager.DestFactor.ONE_MINUS_SRC_ALPHA
                )
                drawAction(entry.target)
                entry.dirty = false
            } finally {
                entry.target.unbindWrite()
                mainTarget.bindWrite(true)
                RenderSystem.defaultBlendFunc()
                RenderSystem.setShaderColor(1f, 1f, 1f, 1f)
            }
        }

        return entry
    }

    /**
     * 使用预乘 Alpha 混合方程将已缓存的离屏 FBO 绘制为单个纹理矩形。
     */
    fun blitPremultiplied(
        surface: CachedFboSurface,
        poseStack: PoseStack,
        x: Float,
        y: Float,
        width: Float = surface.logicalWidth.toFloat(),
        height: Float = surface.logicalHeight.toFloat(),
        alpha: Float = 1.0f
    ) {
        RenderSystem.assertOnRenderThread()
        val clampedAlpha = alpha.coerceIn(0f, 1f)
        if (clampedAlpha <= 0.001f) return

        val uMax = surface.logicalWidth.toFloat() / surface.bucketWidth.toFloat()
        val vMin = 1.0f - (surface.logicalHeight.toFloat() / surface.bucketHeight.toFloat())

        RenderSystem.enableBlend()
        // 预乘 Alpha 贴回方程：RGB 已含 Alpha，乘 clampedAlpha 同步缩放 RGB 与 A
        RenderSystem.blendFunc(GlStateManager.SourceFactor.ONE, GlStateManager.DestFactor.ONE_MINUS_SRC_ALPHA)
        RenderSystem.setShader { GameRenderer.getPositionTexShader() }
        RenderSystem.setShaderTexture(0, surface.target.colorTextureId)
        RenderSystem.setShaderColor(clampedAlpha, clampedAlpha, clampedAlpha, clampedAlpha)

        try {
            val mat = poseStack.last().pose()
            val tesselator = Tesselator.getInstance()
            val buf = tesselator.builder
            buf.begin(VertexFormat.Mode.QUADS, DefaultVertexFormat.POSITION_TEX)
            buf.vertex(mat, x, y + height, 0f).uv(0f, vMin).endVertex()
            buf.vertex(mat, x + width, y + height, 0f).uv(uMax, vMin).endVertex()
            buf.vertex(mat, x + width, y, 0f).uv(uMax, 1f).endVertex()
            buf.vertex(mat, x, y, 0f).uv(0f, 1f).endVertex()
            tesselator.end()
        } finally {
            RenderSystem.setShaderColor(1f, 1f, 1f, 1f)
            RenderSystem.defaultBlendFunc()
        }
    }

    @Synchronized
    fun purgeIdle(nowMs: Long = System.currentTimeMillis()) {
        val iter = activeSurfaces.entries.iterator()
        while (iter.hasNext()) {
            val (_, entry) = iter.next()
            if ((nowMs - entry.lastUsedAtMs) > idleExpireMs) {
                iter.remove()
                entry.target.destroyBuffers()
            }
        }
    }

    @Synchronized
    fun destroyAll() {
        for (entry in activeSurfaces.values) {
            runCatching { entry.target.destroyBuffers() }
        }
        activeSurfaces.clear()
        for (q in idlePoolByBucket.values) {
            for (t in q) {
                runCatching { t.destroyBuffers() }
            }
            q.clear()
        }
        idlePoolByBucket.clear()
    }

    private fun borrowOrCreateTarget(bw: Int, bh: Int): TextureTarget {
        val bKey = packBucketKey(bw, bh)
        val queue = idlePoolByBucket[bKey]
        if (queue != null && queue.isNotEmpty()) {
            return queue.removeLast()
        }
        return TextureTarget(bw, bh, true, Minecraft.ON_OSX).apply {
            setClearColor(0f, 0f, 0f, 0f)
        }
    }

    private fun recycleTarget(bw: Int, bh: Int, target: TextureTarget) {
        var totalIdle = 0
        for (q in idlePoolByBucket.values) totalIdle += q.size
        if (totalIdle >= maxIdleBuckets) {
            runCatching { target.destroyBuffers() }
            return
        }
        val bKey = packBucketKey(bw, bh)
        idlePoolByBucket.getOrPut(bKey) { ArrayDeque(4) }.addLast(target)
    }

    companion object {
        const val MIN_FBO_DIM: Int = 32
        const val MAX_FBO_DIM: Int = 2048
        private const val BUCKET_STEP: Int = 32

        @JvmStatic
        fun alignBucketDim(raw: Int): Int {
            val clamped = raw.coerceIn(MIN_FBO_DIM, MAX_FBO_DIM)
            val rem = clamped % BUCKET_STEP
            return if (rem == 0) clamped else (clamped + BUCKET_STEP - rem).coerceAtMost(MAX_FBO_DIM)
        }

        private fun packBucketKey(w: Int, h: Int): Long =
            (w.toLong() shl 32) or (h.toLong() and 0xFFFF_FFFFL)
    }
}
