// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.client.surface2d;

import com.mojang.blaze3d.systems.RenderSystem;
import com.mojang.blaze3d.vertex.BufferBuilder;
import com.mojang.blaze3d.vertex.DefaultVertexFormat;
import com.mojang.blaze3d.vertex.Tesselator;
import com.mojang.blaze3d.vertex.VertexFormat;
import dev.epiphy.client.shader.EpiphyCoreShaders;
import dev.epiphy.client.surface2d.hook.GuiInterceptionHooks;
import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.GameRenderer;
import net.minecraft.resources.ResourceLocation;
import org.joml.Matrix4f;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 2D 平面渲染原生加速算子（供 KubeJS `Epiphy2DRenderer` 外挂调用）：
 * 1. 零全局污染的会话级 GUI 贴图重映射（直连 {@link GuiInterceptionHooks} / {@code GuiGraphicsMixin}，取代危险的 {@code TextureManager.register}）；
 * 2. 资源包感知的贴图存在性并发缓存（F3+T 重载时自动清空）；
 * 3. 纯 Java 17 紧凑 {@link BufferBuilder} 渐变矩形与双采样器遮罩（{@code epiphy:ui_masked_fill}）单批次绘制。
 */
public final class NativeSurface2DAccelerator {

    public static final NativeSurface2DAccelerator INSTANCE = new NativeSurface2DAccelerator();

    private static final ConcurrentHashMap<String, Boolean> textureExistsCache = new ConcurrentHashMap<>(256);

    private NativeSurface2DAccelerator() {}

    public void clearResourceCache() {
        textureExistsCache.clear();
    }

    public boolean checkTextureExists(String rawPath) {
        if (rawPath == null || rawPath.isEmpty()) return false;
        Boolean cached = textureExistsCache.get(rawPath);
        if (cached != null) return cached;

        Minecraft mc = Minecraft.getInstance();
        if (mc == null || mc.getResourceManager() == null) return false;
        ResourceLocation rl = ResourceLocation.tryParse(rawPath.trim());
        if (rl == null) {
            textureExistsCache.put(rawPath, Boolean.FALSE);
            return false;
        }
        boolean exists = mc.getResourceManager().getResource(rl).isPresent();
        if (textureExistsCache.size() > 2048) {
            textureExistsCache.clear();
        }
        textureExistsCache.put(rawPath, exists);
        return exists;
    }

    public boolean setTextureRemap(String origPath, String repPath) {
        if (origPath == null || repPath == null || origPath.isEmpty() || repPath.isEmpty()) return false;
        ResourceLocation origRl = ResourceLocation.tryParse(origPath.trim());
        ResourceLocation repRl = ResourceLocation.tryParse(repPath.trim());
        if (origRl == null || repRl == null) return false;
        GuiInterceptionHooks.setTextureRemap(origRl, repRl);
        return true;
    }

    public void setTextureRemaps(Map<?, ?> replaceMap) {
        if (replaceMap == null || replaceMap.isEmpty()) return;
        for (Map.Entry<?, ?> entry : replaceMap.entrySet()) {
            if (entry.getKey() == null || entry.getValue() == null) continue;
            String orig = String.valueOf(entry.getKey());
            String rep = String.valueOf(entry.getValue());
            if (checkTextureExists(rep)) {
                setTextureRemap(orig, rep);
            }
        }
    }

    public void clearAllTextureRemaps() {
        GuiInterceptionHooks.clearAllTextureRemaps();
    }

    public boolean hasActiveTextureRemaps() {
        return GuiInterceptionHooks.hasTextureRemaps;
    }

    public void drawGradientRect(
            Matrix4f mat,
            float x, float y, float z, float w, float h,
            int fromArgb, int toArgb,
            boolean vertical,
            boolean hasMid, int midArgb, float midPos
    ) {
        if (mat == null || w <= 0.0f || h <= 0.0f) return;
        RenderSystem.enableBlend();
        RenderSystem.defaultBlendFunc();
        RenderSystem.setShader(GameRenderer::getPositionColorShader);

        BufferBuilder buf = Tesselator.getInstance().getBuilder();
        buf.begin(VertexFormat.Mode.QUADS, DefaultVertexFormat.POSITION_COLOR);

        if (hasMid) {
            float mp = Math.max(0.05f, Math.min(0.95f, midPos));
            if (!vertical) {
                float xm = x + w * mp;
                putColorQuad(buf, mat, z, x, y, xm, y + h, fromArgb, midArgb, fromArgb, midArgb);
                putColorQuad(buf, mat, z, xm, y, x + w, y + h, midArgb, toArgb, midArgb, toArgb);
            } else {
                float ym = y + h * mp;
                putColorQuad(buf, mat, z, x, y, x + w, ym, fromArgb, fromArgb, midArgb, midArgb);
                putColorQuad(buf, mat, z, x, ym, x + w, y + h, midArgb, midArgb, toArgb, toArgb);
            }
        } else {
            int tl = fromArgb;
            int tr = vertical ? fromArgb : toArgb;
            int bl = vertical ? toArgb : fromArgb;
            int br = toArgb;
            putColorQuad(buf, mat, z, x, y, x + w, y + h, tl, tr, bl, br);
        }

        Tesselator.getInstance().end();
    }

    public boolean drawMaskedRect(
            Matrix4f mat,
            String baseTexPath,
            String maskTexPath,
            float x, float y, float z, float w, float h,
            float u0, float v0, float u1, float v1,
            int tintArgb, float threshold
    ) {
        if (mat == null || maskTexPath == null || w <= 0.0f || h <= 0.0f) return false;
        EpiphyCoreShaders.CompiledShaderHandle handle = EpiphyCoreShaders.INSTANCE.getUiMaskedFillShader();
        if (handle == null) return false;

        ResourceLocation baseRl = (baseTexPath != null && !baseTexPath.isEmpty())
                ? ResourceLocation.tryParse(baseTexPath.trim())
                : new ResourceLocation("epiphy", "textures/effect/white_pixel.png");
        ResourceLocation maskRl = ResourceLocation.tryParse(maskTexPath.trim());
        if (baseRl == null || maskRl == null) return false;

        var threshUniform = handle.uniform("MaskThreshold");
        if (threshUniform != null) {
            threshUniform.set(Math.max(0.0f, Math.min(1.0f, threshold)));
        }

        RenderSystem.enableBlend();
        RenderSystem.defaultBlendFunc();
        RenderSystem.setShader(handle::getInstance);
        RenderSystem.setShaderTexture(0, baseRl);
        RenderSystem.setShaderTexture(1, maskRl);

        int a = (tintArgb >>> 24) & 0xFF;
        int r = (tintArgb >>> 16) & 0xFF;
        int g = (tintArgb >>> 8) & 0xFF;
        int b = tintArgb & 0xFF;
        int fullLight = 15728880;

        BufferBuilder buf = Tesselator.getInstance().getBuilder();
        buf.begin(VertexFormat.Mode.QUADS, DefaultVertexFormat.POSITION_COLOR_TEX_LIGHTMAP);
        buf.vertex(mat, x, y + h, z).color(r, g, b, a).uv(u0, v1).uv2(fullLight).endVertex();
        buf.vertex(mat, x + w, y + h, z).color(r, g, b, a).uv(u1, v1).uv2(fullLight).endVertex();
        buf.vertex(mat, x + w, y, z).color(r, g, b, a).uv(u1, v0).uv2(fullLight).endVertex();
        buf.vertex(mat, x, y, z).color(r, g, b, a).uv(u0, v0).uv2(fullLight).endVertex();
        Tesselator.getInstance().end();
        return true;
    }

    private static void putColorQuad(
            BufferBuilder buf, Matrix4f mat, float z,
            float x0, float y0, float x1, float y1,
            int tl, int tr, int bl, int br
    ) {
        putColorVert(buf, mat, x1, y0, z, tr);
        putColorVert(buf, mat, x0, y0, z, tl);
        putColorVert(buf, mat, x0, y1, z, bl);
        putColorVert(buf, mat, x1, y1, z, br);
    }

    private static void putColorVert(BufferBuilder buf, Matrix4f mat, float x, float y, float z, int argb) {
        int a = (argb >>> 24) & 0xFF;
        int r = (argb >>> 16) & 0xFF;
        int g = (argb >>> 8) & 0xFF;
        int b = argb & 0xFF;
        buf.vertex(mat, x, y, z).color(r, g, b, a).endVertex();
    }
}
