// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.client.fx3d.world;

import com.mojang.blaze3d.vertex.PoseStack;
import com.mojang.blaze3d.vertex.VertexConsumer;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.renderer.MultiBufferSource;
import net.minecraft.client.renderer.RenderType;
import net.minecraft.client.renderer.texture.OverlayTexture;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.world.entity.Entity;
import org.joml.Matrix4f;

import java.util.Map;
import java.util.UUID;
import java.util.WeakHashMap;

/**
 * 世界空间 3D 基础几何图元（光环、光柱、双螺旋、球壳）顶点批发射工具。
 *
 * 工作方式：在客户端渲染阶段复用线程局部旋转矩阵数组计算局部欧拉变换，将图元 Quad 顶点直接写入传入的 {@link VertexConsumer}，
 * 并通过按维度清理的 {@link WeakHashMap} 缓存客户端实体 UUID 查找结果。
 * 已知边界：所有发射方法须在客户端渲染线程且持有有效 {@link PoseStack} 与 {@link MultiBufferSource} 的阶段调用。
 */
public final class NativeWorld3DBatchRenderer {

    private static final int FULL_BRIGHT_LIGHT = 15728880;
    private static final int NO_OVERLAY = OverlayTexture.NO_OVERLAY;
    private static final ResourceLocation WHITE_PIXEL = new ResourceLocation("epiphy", "textures/effect/white_pixel.png");
    private static RenderType cachedEmissiveRenderType;

    // 线程局部欧拉旋转矩阵缓存（避免每帧 new float[9]）
    private static final ThreadLocal<float[]> ROT_SCRATCH = ThreadLocal.withInitial(() -> new float[9]);

    // 客户端实体 UUID 弱引用缓存，消除全实体列表线性字符串扫描
    private static ClientLevel lastCachedLevel;
    private static final Map<UUID, Entity> entityUuidCache = new WeakHashMap<>();

    private NativeWorld3DBatchRenderer() {}

    public static RenderType getDefaultEmissiveRenderType() {
        RenderType rt = cachedEmissiveRenderType;
        if (rt == null) {
            rt = RenderType.entityTranslucentEmissive(WHITE_PIXEL, false);
            cachedEmissiveRenderType = rt;
        }
        return rt;
    }

    public static VertexConsumer acquireEmissiveBuffer(MultiBufferSource bufferSource) {
        if (bufferSource == null) return null;
        return bufferSource.getBuffer(getDefaultEmissiveRenderType());
    }

    public static void flushEmissiveBuffer(MultiBufferSource bufferSource) {
        if (bufferSource instanceof MultiBufferSource.BufferSource bs && cachedEmissiveRenderType != null) {
            bs.endBatch(cachedEmissiveRenderType);
        }
    }

    /**
     * 按 UUID 查找当前客户端世界中的实体并计算帧间线性插值坐标 {@code [x, y, z]}。
     */
    public static boolean resolveEntityInterpolatedPos(String uuidStr, float partialTick, double[] outXyz) {
        if (uuidStr == null || uuidStr.isEmpty() || outXyz == null || outXyz.length < 3) return false;
        Minecraft mc = Minecraft.getInstance();
        if (mc == null || mc.level == null) return false;
        ClientLevel level = mc.level;
        if (level != lastCachedLevel) {
            entityUuidCache.clear();
            lastCachedLevel = level;
        }

        UUID targetUuid;
        try {
            targetUuid = UUID.fromString(uuidStr.trim());
        } catch (IllegalArgumentException ex) {
            return false;
        }

        if (mc.player != null && !mc.player.isRemoved() && targetUuid.equals(mc.player.getUUID())) {
            writeInterp(mc.player, partialTick, outXyz);
            return true;
        }

        Entity cached = entityUuidCache.get(targetUuid);
        if (cached != null) {
            if (!cached.isRemoved() && cached.level() == level) {
                writeInterp(cached, partialTick, outXyz);
                return true;
            }
            entityUuidCache.remove(targetUuid);
        }

        for (Entity ent : level.entitiesForRendering()) {
            if (ent != null && !ent.isRemoved() && targetUuid.equals(ent.getUUID())) {
                entityUuidCache.put(targetUuid, ent);
                writeInterp(ent, partialTick, outXyz);
                return true;
            }
        }
        return false;
    }

    private static void writeInterp(Entity ent, float partialTick, double[] out) {
        float pt = Math.max(0.0f, Math.min(1.0f, partialTick));
        out[0] = ent.xo + (ent.getX() - ent.xo) * pt;
        out[1] = ent.yo + (ent.getY() - ent.yo) * pt;
        out[2] = ent.zo + (ent.getZ() - ent.zo) * pt;
    }

    public static void emitRing(
            PoseStack poseStack,
            VertexConsumer vc,
            float ox, float oy, float oz,
            float tiltX, float rotY, float tiltZ,
            float radius, float width, int segments,
            int rgbHex, float alpha
    ) {
        if (poseStack == null || vc == null || alpha <= 0.004f) return;
        Matrix4f pose = poseStack.last().pose();
        float[] rot = buildEulerRot3(tiltX, rotY, tiltZ);
        float r = ((rgbHex >> 16) & 0xFF) / 255.0f;
        float g = ((rgbHex >> 8) & 0xFF) / 255.0f;
        float b = (rgbHex & 0xFF) / 255.0f;
        float a = clamp01(alpha);
        float sideA = a * 0.72f;

        float effRadius = Math.max(0.1f, radius);
        float halfW = Math.max(0.02f, width * 0.5f);
        int segs = Math.max(8, Math.min(64, segments));
        float rIn = Math.max(0.02f, effRadius - halfW);
        float rOut = effRadius + halfW;
        double step = (Math.PI * 2.0) / segs;

        for (int i = 0; i < segs; i++) {
            double a0 = i * step;
            double a1 = (i + 1) * step;
            float c0 = (float) Math.cos(a0), s0 = (float) Math.sin(a0);
            float c1 = (float) Math.cos(a1), s1 = (float) Math.sin(a1);

            emitQuad(vc, pose, rot, ox, oy, oz,
                    c0 * rIn, 0f, s0 * rIn,
                    c0 * rOut, 0f, s0 * rOut,
                    c1 * rOut, 0f, s1 * rOut,
                    c1 * rIn, 0f, s1 * rIn,
                    r, g, b, a);

            emitQuad(vc, pose, rot, ox, oy, oz,
                    c0 * effRadius, -halfW, s0 * effRadius,
                    c0 * effRadius, halfW, s0 * effRadius,
                    c1 * effRadius, halfW, s1 * effRadius,
                    c1 * effRadius, -halfW, s1 * effRadius,
                    r, g, b, sideA);
        }
    }

    public static void emitBeam(
            PoseStack poseStack,
            VertexConsumer vc,
            float ox, float oy, float oz,
            float tiltX, float rotY, float tiltZ,
            float height, float width,
            int rgbHex, float alpha
    ) {
        if (poseStack == null || vc == null || alpha <= 0.004f) return;
        Matrix4f pose = poseStack.last().pose();
        float[] rot = buildEulerRot3(tiltX, rotY, tiltZ);
        float r = ((rgbHex >> 16) & 0xFF) / 255.0f;
        float g = ((rgbHex >> 8) & 0xFF) / 255.0f;
        float b = (rgbHex & 0xFF) / 255.0f;
        float a = clamp01(alpha);
        float outerA = a * 0.72f;

        float h = Math.max(0.2f, height);
        float hw = Math.max(0.04f, width * 0.5f);

        emitQuad(vc, pose, rot, ox, oy, oz, -hw, 0f, 0f, hw, 0f, 0f, hw, h, 0f, -hw, h, 0f, r, g, b, outerA);
        emitQuad(vc, pose, rot, ox, oy, oz, 0f, 0f, -hw, 0f, 0f, hw, 0f, h, hw, 0f, h, -hw, r, g, b, outerA);

        float cw = hw * 0.45f;
        float cr = Math.min(1.0f, r * 0.6f + 0.4f);
        float cg = Math.min(1.0f, g * 0.6f + 0.4f);
        float cb = Math.min(1.0f, b * 0.6f + 0.4f);
        emitQuad(vc, pose, rot, ox, oy, oz, -cw, 0f, 0f, cw, 0f, 0f, cw, h, 0f, -cw, h, 0f, cr, cg, cb, a);
        emitQuad(vc, pose, rot, ox, oy, oz, 0f, 0f, -cw, 0f, 0f, cw, 0f, h, cw, 0f, h, -cw, cr, cg, cb, a);
    }

    public static void emitHelix(
            PoseStack poseStack,
            VertexConsumer vc,
            float ox, float oy, float oz,
            float tiltX, float rotY, float tiltZ,
            float radius, float height, float width, int segments, float turns,
            int rgbHex, float alpha
    ) {
        if (poseStack == null || vc == null || alpha <= 0.004f) return;
        Matrix4f pose = poseStack.last().pose();
        float[] rot = buildEulerRot3(tiltX, rotY, tiltZ);
        float r = ((rgbHex >> 16) & 0xFF) / 255.0f;
        float g = ((rgbHex >> 8) & 0xFF) / 255.0f;
        float b = (rgbHex & 0xFF) / 255.0f;
        float a = clamp01(alpha);

        float effRadius = Math.max(0.1f, radius);
        float h = Math.max(0.2f, height);
        float halfW = Math.max(0.03f, width * 0.5f);
        int segs = Math.max(8, Math.min(64, segments));
        float effTurns = Math.max(0.5f, turns);

        for (int strand = 0; strand < 2; strand++) {
            double phase = strand * Math.PI;
            for (int i = 0; i < segs; i++) {
                float t0 = (float) i / segs;
                float t1 = (float) (i + 1) / segs;
                double a0 = phase + t0 * effTurns * Math.PI * 2.0;
                double a1 = phase + t1 * effTurns * Math.PI * 2.0;
                float y0 = t0 * h;
                float y1 = t1 * h;
                float x0 = (float) Math.cos(a0) * effRadius;
                float z0 = (float) Math.sin(a0) * effRadius;
                float x1 = (float) Math.cos(a1) * effRadius;
                float z1 = (float) Math.sin(a1) * effRadius;

                emitQuad(vc, pose, rot, ox, oy, oz,
                        x0, y0 - halfW, z0,
                        x0, y0 + halfW, z0,
                        x1, y1 + halfW, z1,
                        x1, y1 - halfW, z1,
                        r, g, b, a);
            }
        }
    }

    public static void emitSphere(
            PoseStack poseStack,
            VertexConsumer vc,
            float ox, float oy, float oz,
            float tiltX, float rotY, float tiltZ,
            float radius, int segments,
            int rgbHex, float alpha
    ) {
        if (poseStack == null || vc == null || alpha <= 0.004f) return;
        Matrix4f pose = poseStack.last().pose();
        float[] rot = buildEulerRot3(tiltX, rotY, tiltZ);
        float r = ((rgbHex >> 16) & 0xFF) / 255.0f;
        float g = ((rgbHex >> 8) & 0xFF) / 255.0f;
        float b = (rgbHex & 0xFF) / 255.0f;
        float shellA = clamp01(alpha) * 0.55f;

        float effRadius = Math.max(0.1f, radius);
        int lonSegs = Math.max(6, Math.min(24, segments));
        int latSegs = Math.max(4, Math.min(12, Math.round(lonSegs * 0.5f)));
        double halfPi = Math.PI * 0.5;

        for (int la = 0; la < latSegs; la++) {
            double phi0 = -halfPi + ((double) la / latSegs) * Math.PI;
            double phi1 = -halfPi + ((double) (la + 1) / latSegs) * Math.PI;
            float cp0 = (float) Math.cos(phi0), sp0 = (float) Math.sin(phi0);
            float cp1 = (float) Math.cos(phi1), sp1 = (float) Math.sin(phi1);
            for (int lo = 0; lo < lonSegs; lo++) {
                double th0 = ((double) lo / lonSegs) * Math.PI * 2.0;
                double th1 = ((double) (lo + 1) / lonSegs) * Math.PI * 2.0;
                float ct0 = (float) Math.cos(th0), st0 = (float) Math.sin(th0);
                float ct1 = (float) Math.cos(th1), st1 = (float) Math.sin(th1);

                emitQuad(vc, pose, rot, ox, oy, oz,
                        effRadius * cp0 * ct0, effRadius * sp0, effRadius * cp0 * st0,
                        effRadius * cp0 * ct1, effRadius * sp0, effRadius * cp0 * st1,
                        effRadius * cp1 * ct1, effRadius * sp1, effRadius * cp1 * st1,
                        effRadius * cp1 * ct0, effRadius * sp1, effRadius * cp1 * st0,
                        r, g, b, shellA);
            }
        }
    }

    private static float[] buildEulerRot3(float rx, float ry, float rz) {
        float[] out = ROT_SCRATCH.get();
        float cx = (float) Math.cos(rx), sx = (float) Math.sin(rx);
        float cy = (float) Math.cos(ry), sy = (float) Math.sin(ry);
        float cz = (float) Math.cos(rz), sz = (float) Math.sin(rz);
        out[0] = cy * cz + sy * sx * sz;
        out[1] = -cy * sz + sy * sx * cz;
        out[2] = sy * cx;
        out[3] = cx * sz;
        out[4] = cx * cz;
        out[5] = -sx;
        out[6] = -sy * cz + cy * sx * sz;
        out[7] = sy * sz + cy * sx * cz;
        out[8] = cy * cx;
        return out;
    }

    private static void emitQuad(
            VertexConsumer vc,
            Matrix4f pose,
            float[] rot,
            float ox, float oy, float oz,
            float x0, float y0, float z0,
            float x1, float y1, float z1,
            float x2, float y2, float z2,
            float x3, float y3, float z3,
            float r, float g, float b, float a
    ) {
        emitVert(vc, pose, rot, ox, oy, oz, x0, y0, z0, 0f, 0f, r, g, b, a);
        emitVert(vc, pose, rot, ox, oy, oz, x1, y1, z1, 1f, 0f, r, g, b, a);
        emitVert(vc, pose, rot, ox, oy, oz, x2, y2, z2, 1f, 1f, r, g, b, a);
        emitVert(vc, pose, rot, ox, oy, oz, x3, y3, z3, 0f, 1f, r, g, b, a);
    }

    private static void emitVert(
            VertexConsumer vc,
            Matrix4f pose,
            float[] rot,
            float ox, float oy, float oz,
            float lx, float ly, float lz,
            float u, float v,
            float r, float g, float b, float a
    ) {
        float rx = rot[0] * lx + rot[1] * ly + rot[2] * lz + ox;
        float ry = rot[3] * lx + rot[4] * ly + rot[5] * lz + oy;
        float rz = rot[6] * lx + rot[7] * ly + rot[8] * lz + oz;

        float wx = pose.m00() * rx + pose.m10() * ry + pose.m20() * rz + pose.m30();
        float wy = pose.m01() * rx + pose.m11() * ry + pose.m21() * rz + pose.m31();
        float wz = pose.m02() * rx + pose.m12() * ry + pose.m22() * rz + pose.m32();

        vc.vertex(wx, wy, wz, r, g, b, a, u, v, NO_OVERLAY, FULL_BRIGHT_LIGHT, 0.0f, 1.0f, 0.0f);
    }

    private static float clamp01(float v) {
        return v < 0.0f ? 0.0f : (Math.min(v, 1.0f));
    }
}
