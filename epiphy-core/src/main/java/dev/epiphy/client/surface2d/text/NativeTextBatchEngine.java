// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.client.surface2d.text;

import com.mojang.blaze3d.vertex.VertexConsumer;
import dev.epiphy.client.util.RenderFaultCircuitBreaker;
import dev.epiphy.core.config.EpiphyConfig;
import net.minecraft.client.gui.Font;
import net.minecraft.client.renderer.MultiBufferSource;
import net.minecraft.client.renderer.RenderType;
import org.joml.Matrix4f;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 通用 2D 富文本字形网格捕获与按字体纹理图集（{@link RenderType}）分桶合批的逐字渲染器。
 *
 * <h3>工作机制</h3>
 * <ol>
 *   <li><b>字形 Quad 捕获（{@link GlyphQuadCapturer}）</b>：首次遇到某文本片段时，在单位矩阵下执行一次排版输出
 *       （支持可选软兼容 SDF 后端与原版 {@link Font#drawInBatch} 回退），记录产出的 {@link RenderType}、局部顶点坐标、UV 与固有色并存入有界 LRU 缓存；</li>
 *   <li><b>场景预编译（{@link CompiledPerCharScene}）</b>：将分段后的富文本单元编译为紧凑原始类型数组，后续每帧通过单次方法调用完成可见区间定位、视口裁剪与逐字运动学偏移计算；</li>
 *   <li><b>分阶段与按图集归并提交</b>：按深度阶段（Pass 0 外圈 ➔ Pass 1 阴影/残影 ➔ Pass 2 正文）顺序，在每个阶段内将落入同一纹理页 {@link RenderType} 的字符 Quad 归并到同一缓冲区后集中写入 {@link VertexConsumer}，减少多纹理页交替切换带来的断批次数。</li>
 * </ol>
 *
 * <h3>已知边界</h3>
 * <ul>
 *   <li>捕获器与分桶缓冲通过 {@link ThreadLocal} 隔离线程状态（客户端主渲染线程每帧复用同一实例，同时兼容无头单元测试）；</li>
 *   <li>若自定义字体渲染后端输出非 4 顶点整数倍的图元或含非有限坐标，该片段会被标记为不可捕获并交由上层常规路径回退绘制。</li>
 * </ul>
 */
public final class NativeTextBatchEngine {

    public static final NativeTextBatchEngine INSTANCE = new NativeTextBatchEngine();

    private static final int SENTINEL_R = 254;
    private static final int SENTINEL_G = 253;
    private static final int SENTINEL_B = 252;
    private static final int SENTINEL_PACKED_ARGB = (0xFF << 24) | (SENTINEL_R << 16) | (SENTINEL_G << 8) | SENTINEL_B;
    private static final int FULL_BRIGHT_LIGHT = 15728880;
    private static final int OUTLINE_ALPHA_CUTOFF = 6;
    private static final int MAX_GLYPH_CACHE_ENTRIES = 2048;

    private static final float DEG_TO_RAD = 0.017453292519943295f;
    private static final double INV_TWO_PI = 0.15915494309189535;
    private static final int SIN_LUT_BITS = 10;
    private static final int SIN_LUT_SIZE = 1 << SIN_LUT_BITS;
    private static final int SIN_LUT_MASK = SIN_LUT_SIZE - 1;
    private static final float[] SIN_LUT = new float[SIN_LUT_SIZE];

    private static final float[] GLOW_4_DX = { -0.7071f, 0.7071f, -0.7071f, 0.7071f };
    private static final float[] GLOW_4_DY = { -0.7071f, -0.7071f, 0.7071f, 0.7071f };

    private static final float[] OUTLINE_8_DX = { -1f, 1f, 0f, 0f, -0.7071f, 0.7071f, -0.7071f, 0.7071f };
    private static final float[] OUTLINE_8_DY = { 0f, 0f, -1f, 1f, -0.7071f, -0.7071f, 0.7071f, 0.7071f };

    private static final float[] CARDINAL_4_DX = { -1f, 1f, 0f, 0f };
    private static final float[] CARDINAL_4_DY = { 0f, 0f, -1f, 1f };

    private static final byte OUT_INHERIT = 0;
    private static final byte OUT_NONE = 1;
    private static final byte OUT_GLOW = 2;
    private static final byte OUT_STROKE = 3;
    private static final byte OUT_MUI_STROKE = 4;

    static {
        for (int i = 0; i < SIN_LUT_SIZE; i++) {
            SIN_LUT[i] = (float) Math.sin((i * Math.PI * 2.0) / SIN_LUT_SIZE);
        }
    }

    private volatile GlyphCaptureBackend optionalBackend = null;
    private final Matrix4f identityMatrix = new Matrix4f();

    // 仅在客户端主渲染线程访问的 LRU 字形网格缓存与可复用分桶缓冲
    private final LinkedHashMap<GlyphCacheKey, CapturedGlyphUnit> glyphCache =
            new LinkedHashMap<>(512, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<GlyphCacheKey, CapturedGlyphUnit> eldest) {
                    return size() > MAX_GLYPH_CACHE_ENTRIES;
                }
            };
    private Font lastSeenFont = null;
    private int lastSeenBackendEpoch = -1;

    private static final class ThreadScratch {
        final GlyphQuadCapturer capturer = new GlyphQuadCapturer();
        final PassBucketBuffer pass0Buckets = new PassBucketBuffer(); // 外圈 (glow / stroke / split halo)
        final PassBucketBuffer pass1Buckets = new PassBucketBuffer(); // 阴影 / 虚化残影 (shadow / blur mist)
        final PassBucketBuffer pass2Buckets = new PassBucketBuffer(); // 正文前景 (foreground)
    }

    private final ThreadLocal<ThreadScratch> threadScratch = ThreadLocal.withInitial(ThreadScratch::new);
    private final RenderFaultCircuitBreaker captureBreaker =
            new RenderFaultCircuitBreaker("EpiphySurface2D", "NativeTextCapture", 16, 5_000L, null);

    // 遥测计数器
    private final AtomicLong scenesCompiled = new AtomicLong(0L);
    private final AtomicLong framesRendered = new AtomicLong(0L);
    private final AtomicLong quadsSubmitted = new AtomicLong(0L);
    private final AtomicLong bucketFlushes = new AtomicLong(0L);
    private final AtomicLong totalRenderNanos = new AtomicLong(0L);
    private volatile long lastRenderUs = 0L;
    private volatile long maxRenderUs = 0L;

    private NativeTextBatchEngine() {}

    public void setOptionalBackend(GlyphCaptureBackend backend) {
        this.optionalBackend = backend;
        clearCache();
    }

    public GlyphCaptureBackend getOptionalBackend() {
        return this.optionalBackend;
    }

    public void clearCache() {
        synchronized (glyphCache) {
            glyphCache.clear();
            lastSeenFont = null;
            lastSeenBackendEpoch = -1;
        }
        captureBreaker.reset();
    }

    private static float fastSinTurns(double turns) {
        int idx = ((int) Math.floor(turns * SIN_LUT_SIZE)) & SIN_LUT_MASK;
        return SIN_LUT[idx];
    }

    private static float fastCosTurns(double turns) {
        int idx = (((int) Math.floor(turns * SIN_LUT_SIZE)) + (SIN_LUT_SIZE >> 2)) & SIN_LUT_MASK;
        return SIN_LUT[idx];
    }

    private static double hashUnit(double n) {
        double x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
        return x - Math.floor(x);
    }

    private static byte encodeOutlineMode(String raw, byte emptyCode) {
        if (raw == null || raw.isEmpty()) return emptyCode;
        String s = raw.trim().toLowerCase();
        return switch (s) {
            case "none" -> OUT_NONE;
            case "glow" -> OUT_GLOW;
            case "stroke" -> OUT_STROKE;
            case "mui_stroke" -> OUT_MUI_STROKE;
            default -> emptyCode;
        };
    }

    /**
     * 将 JS 侧已分段好的 {@code charUnits} 编译为纯原生扁平结构（每条富文本生命周期内仅需编译 1 次）。
     */
    public CompiledPerCharScene compileScene(
            List<?> rawUnits,
            boolean unifiedFreq,
            double sharedPeriodMs,
            int styleCode,
            double shiftXScale,
            double shiftYScale,
            double swayXScale,
            double swayYScale,
            double rotDegAmp,
            double swayWin,
            boolean isSnap,
            double transWin,
            double jitterWin,
            double maxDxPx,
            double maxDyPx
    ) {
        if (rawUnits == null || rawUnits.isEmpty()) return null;

        int topCount = rawUnits.size();
        // 先统计合并段展开后的子字素总数，以便一次性分配连续数组
        int subTotal = 0;
        for (int i = 0; i < topCount; i++) {
            Object obj = rawUnits.get(i);
            if (!(obj instanceof Map<?, ?> m)) continue;
            if (Boolean.TRUE.equals(m.get("isMerged"))) {
                Object subs = m.get("subFrags");
                if (subs instanceof List<?> subList) {
                    subTotal += subList.size();
                }
            }
        }

        int totalNodes = topCount + subTotal;
        String[] rawTexts = new String[totalNodes];
        boolean[] isMerged = new boolean[totalNodes];
        boolean[] isBlank = new boolean[totalNodes];
        int[] subStart = new int[totalNodes];
        int[] subEnd = new int[totalNodes];
        int[] visIndex = new int[totalNodes];
        int[] visStart = new int[totalNodes];
        int[] visEnd = new int[totalNodes];
        float[] baseX = new float[totalNodes];
        float[] baseY = new float[totalNodes];
        float[] width = new float[totalNodes];
        float[] charScale = new float[totalNodes];
        int[] colorRgb = new int[totalNodes];
        byte[] shakeFlag = new byte[totalNodes];
        byte[] outlineCode = new byte[totalNodes];
        int[] outlineColor = new int[totalNodes];
        double[] cSeed = new double[totalNodes];
        double[] periodMs = new double[totalNodes];
        double[] invPeriod = new double[totalNodes];
        double[] phaseOff = new double[totalNodes];

        int validTop = 0;
        int subCursor = topCount;

        for (int i = 0; i < topCount; i++) {
            Object obj = rawUnits.get(i);
            if (!(obj instanceof Map<?, ?> m)) continue;
            int idx = validTop++;
            populateNodeFromMap(
                    m, idx,
                    rawTexts, isMerged, isBlank, visIndex, visStart, visEnd,
                    baseX, baseY, width, charScale, colorRgb, shakeFlag, outlineCode, outlineColor,
                    cSeed, periodMs, invPeriod, phaseOff
            );
            if (isMerged[idx]) {
                subStart[idx] = subCursor;
                Object subs = m.get("subFrags");
                if (subs instanceof List<?> subList) {
                    for (int s = 0; s < subList.size(); s++) {
                        Object subObj = subList.get(s);
                        if (!(subObj instanceof Map<?, ?> sm)) continue;
                        int sIdx = subCursor++;
                        populateNodeFromMap(
                                sm, sIdx,
                                rawTexts, isMerged, isBlank, visIndex, visStart, visEnd,
                                baseX, baseY, width, charScale, colorRgb, shakeFlag, outlineCode, outlineColor,
                                cSeed, periodMs, invPeriod, phaseOff
                        );
                        isMerged[sIdx] = false;
                    }
                }
                subEnd[idx] = subCursor;
            }
        }

        if (validTop == 0) return null;
        scenesCompiled.incrementAndGet();

        return new CompiledPerCharScene(
                validTop,
                totalNodes,
                rawTexts,
                isMerged,
                isBlank,
                subStart,
                subEnd,
                visIndex,
                visStart,
                visEnd,
                baseX,
                baseY,
                width,
                charScale,
                colorRgb,
                shakeFlag,
                outlineCode,
                outlineColor,
                cSeed,
                periodMs,
                invPeriod,
                phaseOff,
                unifiedFreq,
                sharedPeriodMs,
                styleCode,
                (float) shiftXScale,
                (float) shiftYScale,
                (float) swayXScale,
                (float) swayYScale,
                (float) rotDegAmp,
                swayWin,
                isSnap,
                transWin,
                jitterWin,
                (float) maxDxPx,
                (float) maxDyPx
        );
    }

    private static void populateNodeFromMap(
            Map<?, ?> m,
            int idx,
            String[] rawTexts,
            boolean[] isMerged,
            boolean[] isBlank,
            int[] visIndex,
            int[] visStart,
            int[] visEnd,
            float[] baseX,
            float[] baseY,
            float[] width,
            float[] charScale,
            int[] colorRgb,
            byte[] shakeFlag,
            byte[] outlineCode,
            int[] outlineColor,
            double[] cSeed,
            double[] periodMs,
            double[] invPeriod,
            double[] phaseOff
    ) {
        Object rtObj = m.get("rawText");
        rawTexts[idx] = rtObj != null ? String.valueOf(rtObj) : "";
        isMerged[idx] = Boolean.TRUE.equals(m.get("isMerged"));
        isBlank[idx] = Boolean.TRUE.equals(m.get("isBlank"));

        int vIdx = readInt(m.get("visIndex"), 0);
        visIndex[idx] = vIdx;
        visStart[idx] = readInt(m.get("visStart"), vIdx);
        visEnd[idx] = readInt(m.get("visEnd"), vIdx + 1);

        baseX[idx] = readFloat(m.get("baseX"), 0.0f);
        baseY[idx] = readFloat(m.get("baseY"), 0.0f);
        width[idx] = readFloat(m.get("w"), 0.0f);
        charScale[idx] = readFloat(m.get("charScale"), 1.0f);
        colorRgb[idx] = readInt(m.get("color"), 0xFF5555) & 0xFFFFFF;
        shakeFlag[idx] = (byte) readInt(m.get("shakeFlag"), 0);

        Object omObj = m.get("outlineMode");
        outlineCode[idx] = encodeOutlineMode(omObj != null ? String.valueOf(omObj) : "", OUT_INHERIT);
        outlineColor[idx] = readInt(m.get("outlineColor"), -1);

        cSeed[idx] = readDouble(m.get("cSeed"), 1.0);
        double pMs = Math.max(60.0, readDouble(m.get("periodMs"), 800.0));
        periodMs[idx] = pMs;
        invPeriod[idx] = 1.0 / pMs;
        phaseOff[idx] = readDouble(m.get("phaseOff"), 0.0);
    }

    private static int readInt(Object o, int def) {
        if (o instanceof Number n) {
            double d = n.doubleValue();
            return Double.isFinite(d) ? (int) Math.round(d) : def;
        }
        return def;
    }

    private static float readFloat(Object o, float def) {
        if (o instanceof Number n) {
            float f = n.floatValue();
            return Float.isFinite(f) ? f : def;
        }
        return def;
    }

    private static double readDouble(Object o, double def) {
        if (o instanceof Number n) {
            double d = n.doubleValue();
            return Double.isFinite(d) ? d : def;
        }
        return def;
    }

    /**
     * 单次调用完成整条富文本所有可见字素的运动学更新、视口裁剪、按 Pass 分组与纹理图集分桶批量绘制。
     *
     * @return 成功绘制返回最后一个可见字素的打包坐标锚点（或 {@code true}）；若环境不支持捕获则安全返回 {@code false} 交由脚本层兜底。
     */
    public boolean renderScene(
            Object sceneHandle,
            Matrix4f baseItemMat,
            MultiBufferSource bufferSource,
            Font font,
            boolean seeThrough,
            int startSkipVis,
            int keepEndVis,
            double ageMs,
            double activeShakeAmp,
            boolean isPerCharShake,
            boolean shadow,
            String defOutlineModeStr,
            int defOutlineColor,
            float defOutlineWidth,
            boolean inFade,
            String fadeStyleStr,
            float fadeProgress,
            float px,
            float py,
            float mxx,
            float mxy,
            float myx,
            float myy,
            float screenW,
            float screenH,
            float offPadPx
    ) {
        if (!EpiphyConfig.surface2DEnabled || !EpiphyConfig.nativeTextBatcherEnabled) {
            return false;
        }
        if (!(sceneHandle instanceof CompiledPerCharScene scene) || baseItemMat == null || bufferSource == null) {
            return false;
        }
        if (font == null && this.optionalBackend == null) {
            return false;
        }
        if (keepEndVis <= startSkipVis || scene.topCount == 0) {
            return true;
        }

        long t0Ns = System.nanoTime();

        // 0. 检查字体或排版后端 Epoch 是否发生重载
        GlyphCaptureBackend backend = this.optionalBackend;
        int curEpoch = backend != null ? backend.currentEpoch() : 0;
        if (font != lastSeenFont || curEpoch != lastSeenBackendEpoch) {
            synchronized (glyphCache) {
                glyphCache.clear();
                lastSeenFont = font;
                lastSeenBackendEpoch = curEpoch;
            }
        }

        boolean isBlurFade = inFade && "blur".equals(fadeStyleStr);
        boolean isSplitFade = inFade && "split".equals(fadeStyleStr);
        if ((isBlurFade || isSplitFade) && fadeProgress >= 0.97f) {
            return true;
        }
        float invP = inFade ? Math.max(0.0f, Math.min(1.0f, 1.0f - fadeProgress)) : 1.0f;
        float baseA = (isBlurFade || isSplitFade) ? (invP * invP) : 1.0f;
        if (baseA <= 0.025f) {
            return true;
        }

        int qualityLevel = EpiphyConfig.outlineQualityLevel;
        byte defOutCode = qualityLevel <= 0 ? OUT_NONE : encodeOutlineMode(defOutlineModeStr, OUT_NONE);

        // 预计算 Split / Blur 淡出常量
        int splitHaloAlpha = 0;
        int splitCoreByte = 255;
        float splitSpreadPx = 0.65f;
        boolean splitCoreShd = false;
        float blurRad = 0.35f;
        float blurY = 0.2275f;
        int blurMistByte = 0;
        int blurCoreByte = 255;
        float blurGlowOutAlpha = 1.0f;
        boolean blurAllowShadow = false;

        if (isSplitFade) {
            float clampedFp = Math.max(0.05f, Math.min(0.95f, fadeProgress));
            float haloBellS = (float) Math.sin(clampedFp * Math.PI);
            splitHaloAlpha = clampInt(Math.round((invP * 0.72f + haloBellS * 0.28f) * 72.0f), 5, 96);
            splitCoreByte = clampInt(Math.round(baseA * 245.0f + 6.0f), 5, 255);
            splitSpreadPx = 0.65f + fadeProgress * 2.85f;
            splitCoreShd = shadow && fadeProgress < 0.42f;
        } else if (isBlurFade) {
            blurRad = 0.35f + fadeProgress * 0.48f;
            blurY = blurRad * 0.65f;
            float mistAlpha = Math.max(0.03f, Math.min(0.56f, invP * (0.36f + 0.24f * (float) Math.sin(fadeProgress * Math.PI))));
            float coreBlurUnit = Math.max(0.03f, Math.min(1.0f, invP * invP * (1.0f - fadeProgress * 0.35f)));
            blurMistByte = clampInt(Math.round(mistAlpha * 255.0f), 5, 145);
            blurCoreByte = clampInt(Math.round(coreBlurUnit * 255.0f), 5, 255);
            blurGlowOutAlpha = fadeProgress >= 0.42f ? 0.0f : (baseA * (1.0f - fadeProgress / 0.42f));
            blurAllowShadow = shadow && fadeProgress < 0.35f;
        }

        // 1. 二分定位可见顶层单元区间 [lo, hi)
        int lo = lowerBoundVisEnd(scene.visEnd, scene.topCount, startSkipVis);
        int hi = upperBoundVisStart(scene.visStart, lo, scene.topCount, keepEndVis);
        if (lo >= hi) {
            return true;
        }

        // 2. 共享抖动时序预计算
        boolean canShareTiming = false;
        double sharedCyc = 0.0;
        long sharedStepIdx = 0L;
        double sharedFrac = 0.0;
        float sharedPulse = 0.0f;
        float sharedWave = 0.0f;
        float sharedTransT = 1.0f;

        if (scene.unifiedFreq && ageMs >= 0.0 && Double.isFinite(ageMs) && scene.styleCode != 2 && scene.sharedPeriodMs > 0.0) {
            canShareTiming = true;
            sharedCyc = ageMs / scene.sharedPeriodMs;
            sharedStepIdx = (long) Math.floor(sharedCyc);
            sharedFrac = sharedCyc - sharedStepIdx;
            if (scene.styleCode == 1) {
                if (!scene.isSnap && scene.transWin > 0.0 && sharedFrac < scene.transWin) {
                    sharedTransT = (float) (sharedFrac / scene.transWin);
                }
                if (sharedFrac < scene.swayWin) {
                    double u = sharedFrac / scene.swayWin;
                    sharedWave = fastSinTurns(u * 1.25) * (float) (1.0 - u);
                }
            } else {
                if (sharedFrac < scene.jitterWin) {
                    double pu = sharedFrac / scene.jitterWin;
                    sharedPulse = fastSinTurns(pu * 1.5) * (float) ((1.0 - pu) * 0.85);
                }
            }
        }

        float effShakeAmp = 0.0f;
        if (Double.isFinite(activeShakeAmp) && activeShakeAmp > 0.0) {
            effShakeAmp = (float) Math.max(0.05, Math.min(2.5, activeShakeAmp));
        }

        boolean preferSdfGlobal = backend != null && (defOutCode != OUT_NONE || isBlurFade || isSplitFade || (isPerCharShake && scene.rotDegAmp > 0.0f));

        ThreadScratch scratch = threadScratch.get();
        PassBucketBuffer pass0Buckets = scratch.pass0Buckets;
        PassBucketBuffer pass1Buckets = scratch.pass1Buckets;
        PassBucketBuffer pass2Buckets = scratch.pass2Buckets;
        pass0Buckets.reset();
        pass1Buckets.reset();
        pass2Buckets.reset();

        int lastVisNodeIdx = -1;

        for (int uIdx = lo; uIdx < hi; uIdx++) {
            if (scene.isMerged[uIdx]) {
                if (startSkipVis <= scene.visStart[uIdx] && keepEndVis >= scene.visEnd[uIdx]) {
                    lastVisNodeIdx = uIdx;
                    float uw = scene.width[uIdx];
                    if (!isOutOfViewport(scene.baseX[uIdx] + uw * 0.5f, scene.baseY[uIdx] + 4.0f, uw * 0.5f + 4.0f, 6.0f, px, py, mxx, mxy, myx, myy, screenW, screenH, offPadPx)) {
                        if (!emitSingleNodeToBuckets(
                                scratch, scene, uIdx, scene.baseX[uIdx], scene.baseY[uIdx], 0.0f,
                                font, backend, seeThrough, preferSdfGlobal,
                                qualityLevel, defOutCode, defOutlineColor, defOutlineWidth,
                                shadow, baseA, isSplitFade, isBlurFade,
                                splitHaloAlpha, splitCoreByte, splitSpreadPx, splitCoreShd,
                                blurRad, blurY, blurMistByte, blurCoreByte, blurGlowOutAlpha, blurAllowShadow
                        )) {
                            return false;
                        }
                    }
                } else {
                    int sFrom = scene.subStart[uIdx];
                    int sTo = scene.subEnd[uIdx];
                    for (int sIdx = sFrom; sIdx < sTo; sIdx++) {
                        int vIdx = scene.visIndex[sIdx];
                        if (vIdx < startSkipVis) continue;
                        if (vIdx >= keepEndVis) break;
                        lastVisNodeIdx = sIdx;
                        if (scene.isBlank[sIdx]) continue;
                        float sw = scene.width[sIdx];
                        if (isOutOfViewport(scene.baseX[sIdx] + sw * 0.5f, scene.baseY[sIdx] + 4.0f, sw * 0.5f + 4.0f, 6.0f, px, py, mxx, mxy, myx, myy, screenW, screenH, offPadPx)) {
                            continue;
                        }
                        if (!emitSingleNodeToBuckets(
                                scratch, scene, sIdx, scene.baseX[sIdx], scene.baseY[sIdx], 0.0f,
                                font, backend, seeThrough, preferSdfGlobal,
                                qualityLevel, defOutCode, defOutlineColor, defOutlineWidth,
                                shadow, baseA, isSplitFade, isBlurFade,
                                splitHaloAlpha, splitCoreByte, splitSpreadPx, splitCoreShd,
                                blurRad, blurY, blurMistByte, blurCoreByte, blurGlowOutAlpha, blurAllowShadow
                        )) {
                            return false;
                        }
                    }
                }
                continue;
            }

            int vIdx = scene.visIndex[uIdx];
            if (vIdx < startSkipVis || vIdx >= keepEndVis) continue;
            lastVisNodeIdx = uIdx;
            if (scene.isBlank[uIdx]) continue;

            float sc = scene.charScale[uIdx] > 0.2f ? scene.charScale[uIdx] : 1.0f;
            float uw = scene.width[uIdx];
            if (isOutOfViewport(scene.baseX[uIdx] + uw * 0.5f, scene.baseY[uIdx] + 4.0f, uw * 0.5f * sc + 6.0f, 6.0f * sc + 6.0f, px, py, mxx, mxy, myx, myy, screenW, screenH, offPadPx)) {
                continue;
            }

            byte sFlag = scene.shakeFlag[uIdx];
            boolean shouldShake = (sFlag == 1) || (isPerCharShake && sFlag != -1);
            float offDx = 0.0f;
            float offDy = 0.0f;
            float offRot = 0.0f;

            if (shouldShake && effShakeAmp > 0.0f) {
                double seed = scene.cSeed[uIdx];
                boolean useShared = canShareTiming
                        && Math.abs(scene.periodMs[uIdx] - scene.sharedPeriodMs) <= 1e-3
                        && Math.abs(scene.phaseOff[uIdx]) <= 1e-6;

                double cyc;
                long stepIdx;
                double frac;
                if (useShared) {
                    cyc = sharedCyc;
                    stepIdx = sharedStepIdx;
                    frac = sharedFrac;
                } else {
                    double ageN = (ageMs >= 0.0 && Double.isFinite(ageMs)) ? ageMs : 0.0;
                    cyc = ageN * scene.invPeriod[uIdx] + scene.phaseOff[uIdx];
                    stepIdx = (long) Math.floor(cyc);
                    frac = cyc - stepIdx;
                }

                float rawDx = 0.0f;
                float rawDy = 0.0f;
                float rawRot = 0.0f;

                if (scene.styleCode == 1) {
                    float nextDx = (float) (hashUnit(stepIdx * 17.13 + seed) * 2.0 - 1.0) * scene.shiftXScale * effShakeAmp;
                    float nextDy = (float) (hashUnit(stepIdx * 29.71 + seed + 5.3) * 2.0 - 1.0) * scene.shiftYScale * effShakeAmp;
                    float nextRot = scene.rotDegAmp > 0.0f
                            ? (float) (hashUnit(stepIdx * 61.37 + seed + 13.7) * 2.0 - 1.0) * scene.rotDegAmp * 0.65f
                            : 0.0f;
                    float dirSignX = hashUnit(stepIdx * 43.17 + seed + 9.1) >= 0.5 ? 1.0f : -1.0f;
                    float dirSignY = hashUnit(stepIdx * 53.29 + seed + 3.7) >= 0.5 ? 1.0f : -1.0f;

                    if (!scene.isSnap && scene.transWin > 0.0 && frac < scene.transWin) {
                        long prevStep = stepIdx - 1L;
                        float prevDx = (float) (hashUnit(prevStep * 17.13 + seed) * 2.0 - 1.0) * scene.shiftXScale * effShakeAmp;
                        float prevDy = (float) (hashUnit(prevStep * 29.71 + seed + 5.3) * 2.0 - 1.0) * scene.shiftYScale * effShakeAmp;
                        float shiftT = useShared ? sharedTransT : (float) (frac / scene.transWin);
                        rawDx = prevDx + (nextDx - prevDx) * shiftT;
                        rawDy = prevDy + (nextDy - prevDy) * shiftT;
                        if (scene.rotDegAmp > 0.0f) {
                            float prevRot = (float) (hashUnit(prevStep * 61.37 + seed + 13.7) * 2.0 - 1.0) * scene.rotDegAmp * 0.65f;
                            rawRot = prevRot + (nextRot - prevRot) * shiftT;
                        }
                    } else {
                        rawDx = nextDx;
                        rawDy = nextDy;
                        rawRot = nextRot;
                    }

                    if (frac < scene.swayWin) {
                        float wave = useShared
                                ? sharedWave
                                : fastSinTurns((frac / scene.swayWin) * 1.25) * (float) (1.0 - frac / scene.swayWin);
                        rawDx += dirSignX * wave * effShakeAmp * scene.swayXScale;
                        rawDy += dirSignY * wave * effShakeAmp * scene.swayYScale;
                        if (scene.rotDegAmp > 0.0f) {
                            rawRot += dirSignX * wave * scene.rotDegAmp * 0.55f;
                        }
                    }

                    double seedTurns = seed * INV_TWO_PI;
                    if (scene.swayXScale != 0.0f) {
                        rawDx += fastSinTurns(frac + seedTurns) * 0.10f * scene.swayXScale * effShakeAmp;
                    }
                    if (scene.swayYScale != 0.0f) {
                        rawDy += fastCosTurns(frac + seedTurns * 1.3) * 0.10f * scene.swayYScale * effShakeAmp;
                    }
                } else if (scene.styleCode == 2) {
                    double sT = seed * INV_TWO_PI;
                    float nx = fastSinTurns(cyc + sT * 1.73) * 0.72f + fastCosTurns(cyc * 0.53 + sT * 3.11) * 0.28f;
                    float ny = fastCosTurns(cyc * 0.87 + sT * 2.37) * 0.72f + fastSinTurns(cyc * 0.47 + sT * 4.19) * 0.28f;
                    rawDx = nx * effShakeAmp * 0.95f;
                    rawDy = ny * effShakeAmp * 1.15f;
                } else {
                    double turn0 = hashUnit(stepIdx * 19.37 + seed);
                    float cosTheta = fastCosTurns(turn0);
                    float sinTheta = fastSinTurns(turn0);
                    float pulse = 0.0f;
                    if (frac < scene.jitterWin) {
                        pulse = useShared
                                ? sharedPulse
                                : fastSinTurns((frac / scene.jitterWin) * 1.5) * (float) ((1.0 - frac / scene.jitterWin) * 0.85);
                    }
                    float mag = (0.22f + pulse) * effShakeAmp;
                    rawDx = cosTheta * mag * 0.78f;
                    rawDy = sinTheta * mag * 0.92f;
                }

                offDx = clampFloat(rawDx, -scene.maxDxPx, scene.maxDxPx);
                offDy = clampFloat(rawDy, -scene.maxDyPx, scene.maxDyPx);
                offRot = Float.isFinite(rawRot) ? rawRot : 0.0f;
            }

            if (!emitSingleNodeToBuckets(
                    scratch, scene, uIdx, scene.baseX[uIdx] + offDx, scene.baseY[uIdx] + offDy, offRot,
                    font, backend, seeThrough, preferSdfGlobal,
                    qualityLevel, defOutCode, defOutlineColor, defOutlineWidth,
                    shadow, baseA, isSplitFade, isBlurFade,
                    splitHaloAlpha, splitCoreByte, splitSpreadPx, splitCoreShd,
                    blurRad, blurY, blurMistByte, blurCoreByte, blurGlowOutAlpha, blurAllowShadow
            )) {
                return false;
            }
        }

        // 3. 按深度阶段依次将各纹理图集桶一次性冲刷至 MultiBufferSource
        int flushes = 0;
        long quads = 0L;
        flushes += pass0Buckets.flushAll(baseItemMat, bufferSource);
        quads += pass0Buckets.totalQuads;
        flushes += pass1Buckets.flushAll(baseItemMat, bufferSource);
        quads += pass1Buckets.totalQuads;
        flushes += pass2Buckets.flushAll(baseItemMat, bufferSource);
        quads += pass2Buckets.totalQuads;

        framesRendered.incrementAndGet();
        bucketFlushes.addAndGet(flushes);
        quadsSubmitted.addAndGet(quads);

        long dtNs = Math.max(0L, System.nanoTime() - t0Ns);
        totalRenderNanos.addAndGet(dtNs);
        long dtUs = Math.round(dtNs / 1000.0);
        lastRenderUs = dtUs;
        if (dtUs > maxRenderUs) {
            maxRenderUs = dtUs;
        }
        return true;
    }

    private boolean emitSingleNodeToBuckets(
            ThreadScratch scratch,
            CompiledPerCharScene scene,
            int nodeIdx,
            float floatX,
            float floatY,
            float rotDeg,
            Font font,
            GlyphCaptureBackend backend,
            boolean seeThrough,
            boolean preferSdfGlobal,
            int qualityLevel,
            byte defOutCode,
            int defOutlineColor,
            float defOutlineWidth,
            boolean shadow,
            float baseA,
            boolean isSplitFade,
            boolean isBlurFade,
            int splitHaloAlpha,
            int splitCoreByte,
            float splitSpreadPx,
            boolean splitCoreShd,
            float blurRad,
            float blurY,
            int blurMistByte,
            int blurCoreByte,
            float blurGlowOutAlpha,
            boolean blurAllowShadow
    ) {
        String rawText = scene.rawTexts[nodeIdx];
        if (rawText == null || rawText.isEmpty()) return true;

        PassBucketBuffer pass0Buckets = scratch.pass0Buckets;
        PassBucketBuffer pass1Buckets = scratch.pass1Buckets;
        PassBucketBuffer pass2Buckets = scratch.pass2Buckets;

        byte rawOut = scene.outlineCode[nodeIdx];
        byte outMode = rawOut == OUT_INHERIT ? defOutCode : (qualityLevel <= 0 ? OUT_NONE : rawOut);
        int outCol = scene.outlineColor[nodeIdx] >= 0 ? scene.outlineColor[nodeIdx] : defOutlineColor;
        int rgbColor = scene.colorRgb[nodeIdx];
        float sc = scene.charScale[nodeIdx] > 0.2f ? scene.charScale[nodeIdx] : 1.0f;
        boolean hasScale = Math.abs(sc - 1.0f) > 0.01f;
        boolean hasRot = Math.abs(rotDeg) > 0.15f;
        boolean needTransform = hasScale || hasRot;
        boolean preferSdf = backend != null && (preferSdfGlobal || outMode != OUT_NONE || needTransform);

        CapturedGlyphUnit unit = getOrCaptureGlyphUnit(scratch.capturer, font, backend, rawText, seeThrough, preferSdf);
        if (unit == null || !unit.capturable) {
            return false;
        }
        if (unit.quadCount == 0) {
            return true;
        }

        int cR = (rgbColor >>> 16) & 0xFF;
        int cG = (rgbColor >>> 8) & 0xFF;
        int cB = rgbColor & 0xFF;

        // 计算局部 2D 仿射矩阵:
        //   lx = a00 * (qx + gx) + a01 * (qy + gy) + atx
        //   ly = a10 * (qx + gx) + a11 * (qy + gy) + aty
        float a00 = 1.0f, a01 = 0.0f, a10 = 0.0f, a11 = 1.0f;
        float atx = 0.0f, aty = 0.0f;
        float gx = floatX, gy = floatY;

        if (!isSplitFade && needTransform) {
            float halfW = scene.width[nodeIdx] * 0.5f;
            atx = floatX + halfW;
            aty = floatY + 4.0f;
            gx = -halfW;
            gy = -4.0f;
            if (hasRot) {
                float rad = rotDeg * DEG_TO_RAD;
                float cos = (float) Math.cos(rad);
                float sin = (float) Math.sin(rad);
                a00 = cos * sc;
                a01 = -sin * sc;
                a10 = sin * sc;
                a11 = cos * sc;
            } else {
                a00 = sc;
                a11 = sc;
            }
        }

        if (isSplitFade) {
            if (splitHaloAlpha >= OUTLINE_ALPHA_CUTOFF) {
                pass0Buckets.appendGlyph(unit, 1.0f, 0.0f, 0.0f, 1.0f, 0.0f, 0.0f, floatX - splitSpreadPx, floatY, -0.024f, cR, cG, cB, splitHaloAlpha, false);
                pass0Buckets.appendGlyph(unit, 1.0f, 0.0f, 0.0f, 1.0f, 0.0f, 0.0f, floatX + splitSpreadPx, floatY, -0.024f, cR, cG, cB, splitHaloAlpha, false);
                pass0Buckets.appendGlyph(unit, 1.0f, 0.0f, 0.0f, 1.0f, 0.0f, 0.0f, floatX, floatY - splitSpreadPx * 0.78f, -0.024f, cR, cG, cB, splitHaloAlpha, false);
                pass0Buckets.appendGlyph(unit, 1.0f, 0.0f, 0.0f, 1.0f, 0.0f, 0.0f, floatX, floatY + splitSpreadPx * 0.78f, -0.024f, cR, cG, cB, splitHaloAlpha, false);
            }
            if (splitCoreShd) {
                pass1Buckets.appendGlyph(unit, 1.0f, 0.0f, 0.0f, 1.0f, 0.0f, 0.0f, floatX + 1.0f, floatY + 1.0f, 0.0f, cR >>> 2, cG >>> 2, cB >>> 2, splitCoreByte, false);
                pass2Buckets.appendGlyph(unit, 1.0f, 0.0f, 0.0f, 1.0f, 0.0f, 0.0f, floatX, floatY, 0.03f, cR, cG, cB, splitCoreByte, false);
            } else {
                pass2Buckets.appendGlyph(unit, 1.0f, 0.0f, 0.0f, 1.0f, 0.0f, 0.0f, floatX, floatY, 0.0f, cR, cG, cB, splitCoreByte, false);
            }
            return true;
        }

        // Pass 0: 外圈描边或柔光
        if (outMode != OUT_NONE) {
            boolean isGlow = (outMode == OUT_GLOW);
            float effOutAlpha = (isBlurFade && isGlow) ? blurGlowOutAlpha : baseA;
            if (effOutAlpha > 0.01f) {
                int effOutRgb = outCol >= 0 ? outCol : (isGlow ? rgbColor : 0x050A10);
                int oR = (effOutRgb >>> 16) & 0xFF;
                int oG = (effOutRgb >>> 8) & 0xFF;
                int oB = effOutRgb & 0xFF;
                float oRad = clampFloat(defOutlineWidth > 0.0f ? defOutlineWidth : (isGlow ? 0.85f : 0.72f), 0.25f, 2.5f);

                if (isGlow) {
                    int glowByte = Math.round(0.41f * effOutAlpha * 255.0f);
                    if (glowByte >= OUTLINE_ALPHA_CUTOFF) {
                        float r = oRad * 0.90f;
                        for (int k = 0; k < 4; k++) {
                            pass0Buckets.appendGlyph(unit, a00, a01, a10, a11, atx, aty, gx + GLOW_4_DX[k] * r, gy + GLOW_4_DY[k] * r, -0.055f, oR, oG, oB, glowByte, true);
                        }
                    }
                } else {
                    int strokeByte = Math.round(0.92f * effOutAlpha * 255.0f);
                    if (strokeByte >= OUTLINE_ALPHA_CUTOFF) {
                        if (qualityLevel == 1) {
                            // PERFORMANCE 档位：4 向轻量轮廓
                            for (int k = 0; k < 4; k++) {
                                pass0Buckets.appendGlyph(unit, a00, a01, a10, a11, atx, aty, gx + OUTLINE_8_DX[k] * oRad, gy + OUTLINE_8_DY[k] * oRad, -0.045f, oR, oG, oB, strokeByte, true);
                            }
                        } else {
                            for (int k = 0; k < 8; k++) {
                                pass0Buckets.appendGlyph(unit, a00, a01, a10, a11, atx, aty, gx + OUTLINE_8_DX[k] * oRad, gy + OUTLINE_8_DY[k] * oRad, -0.045f, oR, oG, oB, strokeByte, true);
                            }
                            float midThresh = unit.fromCompatBackend ? 1.15f : 0.82f;
                            if (qualityLevel >= 3 && oRad > midThresh) {
                                float innerR = oRad * 0.48f;
                                for (int k = 0; k < 4; k++) {
                                    pass0Buckets.appendGlyph(unit, a00, a01, a10, a11, atx, aty, gx + CARDINAL_4_DX[k] * innerR, gy + CARDINAL_4_DY[k] * innerR, -0.018f, oR, oG, oB, strokeByte, true);
                                }
                            }
                        }
                    }
                }
            }
        }

        // Pass 1 & Pass 2: 虚化淡出或常规阴影+前景
        if (isBlurFade) {
            if (blurMistByte >= OUTLINE_ALPHA_CUTOFF) {
                pass1Buckets.appendGlyph(unit, a00, a01, a10, a11, atx, aty, gx - blurRad, gy - blurY, -0.020f, cR, cG, cB, blurMistByte, false);
                pass1Buckets.appendGlyph(unit, a00, a01, a10, a11, atx, aty, gx + blurRad, gy + blurY, -0.020f, cR, cG, cB, blurMistByte, false);
            }
            boolean blurShd = blurAllowShadow && (outMode == OUT_NONE);
            if (blurShd) {
                pass1Buckets.appendGlyph(unit, a00, a01, a10, a11, atx, aty, gx + 1.0f, gy + 1.0f, 0.0f, cR >>> 2, cG >>> 2, cB >>> 2, blurCoreByte, false);
                pass2Buckets.appendGlyph(unit, a00, a01, a10, a11, atx, aty, gx, gy, 0.03f, cR, cG, cB, blurCoreByte, false);
            } else {
                pass2Buckets.appendGlyph(unit, a00, a01, a10, a11, atx, aty, gx, gy, 0.0f, cR, cG, cB, blurCoreByte, false);
            }
            return true;
        }

        boolean useShadow = shadow && (outMode == OUT_NONE);
        if (useShadow) {
            pass1Buckets.appendGlyph(unit, a00, a01, a10, a11, atx, aty, gx + 1.0f, gy + 1.0f, 0.0f, cR >>> 2, cG >>> 2, cB >>> 2, 255, false);
            pass2Buckets.appendGlyph(unit, a00, a01, a10, a11, atx, aty, gx, gy, 0.03f, cR, cG, cB, 255, false);
        } else {
            pass2Buckets.appendGlyph(unit, a00, a01, a10, a11, atx, aty, gx, gy, 0.0f, cR, cG, cB, 255, false);
        }
        return true;
    }

    private CapturedGlyphUnit getOrCaptureGlyphUnit(
            GlyphQuadCapturer capturer,
            Font font,
            GlyphCaptureBackend backend,
            String rawText,
            boolean seeThrough,
            boolean preferSdf
    ) {
        GlyphCacheKey key = new GlyphCacheKey(rawText, seeThrough, preferSdf);
        synchronized (glyphCache) {
            CapturedGlyphUnit existing = glyphCache.get(key);
            if (existing != null) {
                return existing;
            }
        }

        capturer.reset();
        boolean usedCompat = false;
        boolean ok = false;

        if (backend != null && !captureBreaker.isTripped()) {
            try {
                if (backend.captureGlyphs(font, rawText, seeThrough, preferSdf, capturer, SENTINEL_R, SENTINEL_G, SENTINEL_B)) {
                    usedCompat = true;
                    ok = true;
                    captureBreaker.recordSuccess();
                }
            } catch (Throwable err) {
                RenderFaultCircuitBreaker.rethrowIfFatalJvmError(err);
                captureBreaker.recordFailure(err, "compatBackend");
                capturer.reset();
            }
        }

        if (!ok && font != null) {
            try {
                Font.DisplayMode mode = seeThrough ? Font.DisplayMode.SEE_THROUGH : Font.DisplayMode.NORMAL;
                font.drawInBatch(
                        rawText,
                        0.0f,
                        0.0f,
                        SENTINEL_PACKED_ARGB,
                        false,
                        identityMatrix,
                        capturer,
                        mode,
                        0,
                        FULL_BRIGHT_LIGHT
                );
                ok = true;
            } catch (Throwable err) {
                RenderFaultCircuitBreaker.rethrowIfFatalJvmError(err);
                captureBreaker.recordFailure(err, "vanillaFont");
                ok = false;
            }
        }

        CapturedGlyphUnit built = ok ? capturer.buildUnit(usedCompat) : CapturedGlyphUnit.UNCAPTURABLE;
        synchronized (glyphCache) {
            glyphCache.put(key, built);
        }
        return built;
    }

    private static int lowerBoundVisEnd(int[] visEnd, int count, int startSkipVis) {
        int l = 0, r = count;
        while (l < r) {
            int mid = (l + r) >>> 1;
            if (visEnd[mid] <= startSkipVis) l = mid + 1;
            else r = mid;
        }
        return l;
    }

    private static int upperBoundVisStart(int[] visStart, int from, int count, int keepEndVis) {
        int l = from, r = count;
        while (l < r) {
            int mid = (l + r) >>> 1;
            if (visStart[mid] < keepEndVis) l = mid + 1;
            else r = mid;
        }
        return l;
    }

    private static boolean isOutOfViewport(
            float localCx, float localCy, float halfW, float halfH,
            float px, float py, float mxx, float mxy, float myx, float myy,
            float sw, float sh, float extraPadPx
    ) {
        if (!(sw > 0.0f && sh > 0.0f)) return false;
        float wx = px + mxx * localCx + mxy * localCy;
        float wy = py + myx * localCx + myy * localCy;
        float extX = Math.abs(mxx) * halfW + Math.abs(mxy) * halfH + extraPadPx;
        float extY = Math.abs(myx) * halfW + Math.abs(myy) * halfH + extraPadPx;
        return (wx + extX) < 0.0f || (wx - extX) > sw || (wy + extY) < 0.0f || (wy - extY) > sh;
    }

    private static int clampInt(int v, int lo, int hi) {
        return v < lo ? lo : (Math.min(v, hi));
    }

    private static float clampFloat(float v, float lo, float hi) {
        if (!Float.isFinite(v)) return 0.0f;
        return v < lo ? lo : (Math.min(v, hi));
    }

    public Map<String, Object> collectStats() {
        long frames = framesRendered.get();
        long avgUs = frames > 0L ? Math.round((totalRenderNanos.get() / 1000.0) / frames) : 0L;
        int cachedSize;
        synchronized (glyphCache) {
            cachedSize = glyphCache.size();
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("enabled", EpiphyConfig.nativeTextBatcherEnabled);
        out.put("outlineQualityLevel", EpiphyConfig.outlineQualityLevel);
        out.put("hasCompatBackend", optionalBackend != null);
        out.put("cachedGlyphUnits", cachedSize);
        out.put("scenesCompiled", scenesCompiled.get());
        out.put("framesRendered", frames);
        out.put("quadsSubmitted", quadsSubmitted.get());
        out.put("bucketFlushes", bucketFlushes.get());
        out.put("lastRenderUs", lastRenderUs);
        out.put("maxRenderUs", maxRenderUs);
        out.put("avgRenderUs", avgUs);
        return out;
    }

    // ========================================================================
    // 内部紧凑数据结构
    // ========================================================================

    private record GlyphCacheKey(String rawText, boolean seeThrough, boolean preferSdf) {}

    public static final class CompiledPerCharScene {
        final int topCount;
        final int totalNodes;
        final String[] rawTexts;
        final boolean[] isMerged;
        final boolean[] isBlank;
        final int[] subStart;
        final int[] subEnd;
        final int[] visIndex;
        final int[] visStart;
        final int[] visEnd;
        final float[] baseX;
        final float[] baseY;
        final float[] width;
        final float[] charScale;
        final int[] colorRgb;
        final byte[] shakeFlag;
        final byte[] outlineCode;
        final int[] outlineColor;
        final double[] cSeed;
        final double[] periodMs;
        final double[] invPeriod;
        final double[] phaseOff;

        final boolean unifiedFreq;
        final double sharedPeriodMs;
        final int styleCode;
        final float shiftXScale;
        final float shiftYScale;
        final float swayXScale;
        final float swayYScale;
        final float rotDegAmp;
        final double swayWin;
        final boolean isSnap;
        final double transWin;
        final double jitterWin;
        final float maxDxPx;
        final float maxDyPx;

        CompiledPerCharScene(
                int topCount,
                int totalNodes,
                String[] rawTexts,
                boolean[] isMerged,
                boolean[] isBlank,
                int[] subStart,
                int[] subEnd,
                int[] visIndex,
                int[] visStart,
                int[] visEnd,
                float[] baseX,
                float[] baseY,
                float[] width,
                float[] charScale,
                int[] colorRgb,
                byte[] shakeFlag,
                byte[] outlineCode,
                int[] outlineColor,
                double[] cSeed,
                double[] periodMs,
                double[] invPeriod,
                double[] phaseOff,
                boolean unifiedFreq,
                double sharedPeriodMs,
                int styleCode,
                float shiftXScale,
                float shiftYScale,
                float swayXScale,
                float swayYScale,
                float rotDegAmp,
                double swayWin,
                boolean isSnap,
                double transWin,
                double jitterWin,
                float maxDxPx,
                float maxDyPx
        ) {
            this.topCount = topCount;
            this.totalNodes = totalNodes;
            this.rawTexts = rawTexts;
            this.isMerged = isMerged;
            this.isBlank = isBlank;
            this.subStart = subStart;
            this.subEnd = subEnd;
            this.visIndex = visIndex;
            this.visStart = visStart;
            this.visEnd = visEnd;
            this.baseX = baseX;
            this.baseY = baseY;
            this.width = width;
            this.charScale = charScale;
            this.colorRgb = colorRgb;
            this.shakeFlag = shakeFlag;
            this.outlineCode = outlineCode;
            this.outlineColor = outlineColor;
            this.cSeed = cSeed;
            this.periodMs = periodMs;
            this.invPeriod = invPeriod;
            this.phaseOff = phaseOff;
            this.unifiedFreq = unifiedFreq;
            this.sharedPeriodMs = sharedPeriodMs;
            this.styleCode = styleCode;
            this.shiftXScale = shiftXScale;
            this.shiftYScale = shiftYScale;
            this.swayXScale = swayXScale;
            this.swayYScale = swayYScale;
            this.rotDegAmp = rotDegAmp;
            this.swayWin = swayWin;
            this.isSnap = isSnap;
            this.transWin = transWin;
            this.jitterWin = jitterWin;
            this.maxDxPx = maxDxPx;
            this.maxDyPx = maxDyPx;
        }
    }

    private static final class CapturedGlyphUnit {
        static final CapturedGlyphUnit UNCAPTURABLE =
                new CapturedGlyphUnit(false, false, 0, new RenderType[0], new float[0], new int[0], new boolean[0]);

        final boolean capturable;
        final boolean fromCompatBackend;
        final int quadCount;
        final RenderType[] quadTypes;
        /** 每 Quad 20 个 float：4 个顶点 x (x, y, z, u, v) */
        final float[] quadXyzUv;
        /** 每 Quad 4 个 int：4 个顶点的固有 0xRRGGBBAA */
        final int[] quadRgba;
        /** 每顶点是否继承外部传入的基础 RGB（即捕获时匹配了哨兵白色而非显式 § 颜色码） */
        final boolean[] inheritCallerRgb;

        CapturedGlyphUnit(
                boolean capturable,
                boolean fromCompatBackend,
                int quadCount,
                RenderType[] quadTypes,
                float[] quadXyzUv,
                int[] quadRgba,
                boolean[] inheritCallerRgb
        ) {
            this.capturable = capturable;
            this.fromCompatBackend = fromCompatBackend;
            this.quadCount = quadCount;
            this.quadTypes = quadTypes;
            this.quadXyzUv = quadXyzUv;
            this.quadRgba = quadRgba;
            this.inheritCallerRgb = inheritCallerRgb;
        }
    }

    private static final class GlyphQuadCapturer implements MultiBufferSource {
        private final List<PerTypeCapture> captures = new ArrayList<>(4);
        private boolean malformed = false;

        void reset() {
            for (int i = 0; i < captures.size(); i++) {
                captures.get(i).reset();
            }
            malformed = false;
        }

        @Override
        public VertexConsumer getBuffer(RenderType renderType) {
            for (int i = 0; i < captures.size(); i++) {
                PerTypeCapture c = captures.get(i);
                if (c.active && c.renderType == renderType) {
                    return c;
                }
            }
            for (int i = 0; i < captures.size(); i++) {
                PerTypeCapture c = captures.get(i);
                if (!c.active) {
                    c.activate(renderType);
                    return c;
                }
            }
            PerTypeCapture created = new PerTypeCapture();
            created.activate(renderType);
            captures.add(created);
            return created;
        }

        CapturedGlyphUnit buildUnit(boolean fromCompatBackend) {
            if (malformed) return CapturedGlyphUnit.UNCAPTURABLE;
            int totalVertices = 0;
            for (int i = 0; i < captures.size(); i++) {
                PerTypeCapture c = captures.get(i);
                if (!c.active) continue;
                if ((c.vertCount & 3) != 0) {
                    return CapturedGlyphUnit.UNCAPTURABLE;
                }
                totalVertices += c.vertCount;
            }
            int quadCount = totalVertices >>> 2;
            if (quadCount == 0) {
                return new CapturedGlyphUnit(true, fromCompatBackend, 0, new RenderType[0], new float[0], new int[0], new boolean[0]);
            }

            RenderType[] qTypes = new RenderType[quadCount];
            float[] qXyzUv = new float[quadCount * 20];
            int[] qRgba = new int[totalVertices];
            boolean[] inherit = new boolean[totalVertices];

            int qCursor = 0;
            int vCursor = 0;
            for (int i = 0; i < captures.size(); i++) {
                PerTypeCapture c = captures.get(i);
                if (!c.active || c.vertCount == 0) continue;
                int cQuads = c.vertCount >>> 2;
                for (int q = 0; q < cQuads; q++) {
                    qTypes[qCursor++] = c.renderType;
                }
                System.arraycopy(c.xyzUv, 0, qXyzUv, vCursor * 5, c.vertCount * 5);
                System.arraycopy(c.rgba, 0, qRgba, vCursor, c.vertCount);
                System.arraycopy(c.inheritRgb, 0, inherit, vCursor, c.vertCount);
                vCursor += c.vertCount;
            }

            return new CapturedGlyphUnit(true, fromCompatBackend, quadCount, qTypes, qXyzUv, qRgba, inherit);
        }

        private final class PerTypeCapture implements VertexConsumer {
            RenderType renderType;
            boolean active = false;
            int vertCount = 0;
            float[] xyzUv = new float[160];
            int[] rgba = new int[32];
            boolean[] inheritRgb = new boolean[32];

            private float cx, cy, cz, cu, cv;
            private int cr = 255, cg = 255, cb = 255, ca = 255;

            void activate(RenderType rt) {
                this.renderType = rt;
                this.active = true;
                this.vertCount = 0;
            }

            void reset() {
                this.renderType = null;
                this.active = false;
                this.vertCount = 0;
            }

            private void ensureCapacity(int nextVerts) {
                if (nextVerts > rgba.length) {
                    int newCap = Math.max(rgba.length << 1, nextVerts);
                    xyzUv = Arrays.copyOf(xyzUv, newCap * 5);
                    rgba = Arrays.copyOf(rgba, newCap);
                    inheritRgb = Arrays.copyOf(inheritRgb, newCap);
                }
            }

            @Override
            public VertexConsumer vertex(double x, double y, double z) {
                this.cx = (float) x;
                this.cy = (float) y;
                this.cz = (float) z;
                return this;
            }

            @Override
            public VertexConsumer color(int r, int g, int b, int a) {
                this.cr = r & 0xFF;
                this.cg = g & 0xFF;
                this.cb = b & 0xFF;
                this.ca = a & 0xFF;
                return this;
            }

            @Override
            public VertexConsumer uv(float u, float v) {
                this.cu = u;
                this.cv = v;
                return this;
            }

            @Override
            public VertexConsumer overlayCoords(int u, int v) {
                return this;
            }

            @Override
            public VertexConsumer uv2(int u, int v) {
                return this;
            }

            @Override
            public VertexConsumer normal(float x, float y, float z) {
                return this;
            }

            @Override
            public void endVertex() {
                if (!Float.isFinite(cx) || !Float.isFinite(cy) || !Float.isFinite(cz)) {
                    malformed = true;
                    return;
                }
                int idx = vertCount++;
                ensureCapacity(vertCount);
                int fBase = idx * 5;
                xyzUv[fBase] = cx;
                xyzUv[fBase + 1] = cy;
                xyzUv[fBase + 2] = cz;
                xyzUv[fBase + 3] = cu;
                xyzUv[fBase + 4] = cv;
                rgba[idx] = (cr << 24) | (cg << 16) | (cb << 8) | ca;
                inheritRgb[idx] = (Math.abs(cr - SENTINEL_R) <= 1 && Math.abs(cg - SENTINEL_G) <= 1 && Math.abs(cb - SENTINEL_B) <= 1);
            }

            @Override
            public void defaultColor(int r, int g, int b, int a) {
                this.cr = r & 0xFF;
                this.cg = g & 0xFF;
                this.cb = b & 0xFF;
                this.ca = a & 0xFF;
            }

            @Override
            public void unsetDefaultColor() {}
        }
    }

    /**
     * 单个深度阶段内按 {@link RenderType}（字体纹理图集页）自动归并的可复用批缓冲。
     */
    private static final class PassBucketBuffer {
        private final List<AtlasBucket> buckets = new ArrayList<>(8);
        int activeCount = 0;
        int totalQuads = 0;

        void reset() {
            for (int i = 0; i < activeCount; i++) {
                buckets.get(i).reset();
            }
            activeCount = 0;
            totalQuads = 0;
        }

        private AtlasBucket acquireBucket(RenderType rt) {
            for (int i = 0; i < activeCount; i++) {
                AtlasBucket b = buckets.get(i);
                if (b.renderType == rt) {
                    return b;
                }
            }
            AtlasBucket b;
            if (activeCount < buckets.size()) {
                b = buckets.get(activeCount);
            } else {
                b = new AtlasBucket();
                buckets.add(b);
            }
            b.renderType = rt;
            b.vertCount = 0;
            activeCount++;
            return b;
        }

        void appendGlyph(
                CapturedGlyphUnit unit,
                float a00, float a01, float a10, float a11, float atx, float aty,
                float gx, float gy, float zOff,
                int r, int g, int b, int a,
                boolean forceOverrideRgb
        ) {
            int qCnt = unit.quadCount;
            RenderType[] qTypes = unit.quadTypes;
            float[] srcXyzUv = unit.quadXyzUv;
            int[] srcRgba = unit.quadRgba;
            boolean[] srcInherit = unit.inheritCallerRgb;

            AtlasBucket lastBucket = null;
            RenderType lastRt = null;

            for (int q = 0; q < qCnt; q++) {
                RenderType rt = qTypes[q];
                if (rt != lastRt) {
                    lastRt = rt;
                    lastBucket = acquireBucket(rt);
                }
                int vBase = q << 2;
                int fBase = q * 20;
                lastBucket.ensureCapacity(lastBucket.vertCount + 4);
                float[] dstF = lastBucket.xyzUv;
                int[] dstC = lastBucket.rgba;
                int outV = lastBucket.vertCount;
                int outF = outV * 5;

                for (int k = 0; k < 4; k++) {
                    float qx = srcXyzUv[fBase] + gx;
                    float qy = srcXyzUv[fBase + 1] + gy;
                    float qz = srcXyzUv[fBase + 2] + zOff;
                    dstF[outF] = a00 * qx + a01 * qy + atx;
                    dstF[outF + 1] = a10 * qx + a11 * qy + aty;
                    dstF[outF + 2] = qz;
                    dstF[outF + 3] = srcXyzUv[fBase + 3];
                    dstF[outF + 4] = srcXyzUv[fBase + 4];

                    int capCol = srcRgba[vBase + k];
                    int capA = capCol & 0xFF;
                    int effA = (capA * a + 127) / 255;
                    int effR, effG, effB;
                    if (forceOverrideRgb || srcInherit[vBase + k]) {
                        effR = r;
                        effG = g;
                        effB = b;
                    } else {
                        effR = (capCol >>> 24) & 0xFF;
                        effG = (capCol >>> 16) & 0xFF;
                        effB = (capCol >>> 8) & 0xFF;
                        if (r == (255 >>> 2) && g == (255 >>> 2) && b == (255 >>> 2)) {
                            // 阴影衰减支持保留 § 固有色系的 1/4 暗化
                            effR >>>= 2;
                            effG >>>= 2;
                            effB >>>= 2;
                        }
                    }
                    dstC[outV] = (effR << 24) | (effG << 16) | (effB << 8) | (effA & 0xFF);

                    fBase += 5;
                    outV++;
                    outF += 5;
                }
                lastBucket.vertCount = outV;
            }
            totalQuads += qCnt;
        }

        int flushAll(Matrix4f mat, MultiBufferSource bufferSource) {
            if (activeCount == 0) return 0;
            float m00 = mat.m00(), m01 = mat.m01(), m02 = mat.m02(), m03 = mat.m03();
            float m10 = mat.m10(), m11 = mat.m11(), m12 = mat.m12(), m13 = mat.m13();
            float m20 = mat.m20(), m21 = mat.m21(), m22 = mat.m22(), m23 = mat.m23();
            float m30 = mat.m30(), m31 = mat.m31(), m32 = mat.m32(), m33 = mat.m33();
            boolean isAffine2D = (m03 == 0.0f && m13 == 0.0f && m23 == 0.0f && m33 == 1.0f);

            int flushed = 0;
            for (int i = 0; i < activeCount; i++) {
                AtlasBucket bucket = buckets.get(i);
                int vcCount = bucket.vertCount;
                if (vcCount <= 0) continue;
                VertexConsumer vc = bufferSource.getBuffer(bucket.renderType);
                float[] fArr = bucket.xyzUv;
                int[] cArr = bucket.rgba;
                int fIdx = 0;
                if (isAffine2D) {
                    for (int v = 0; v < vcCount; v++) {
                        float lx = fArr[fIdx];
                        float ly = fArr[fIdx + 1];
                        float lz = fArr[fIdx + 2];
                        float wx = m00 * lx + m10 * ly + m20 * lz + m30;
                        float wy = m01 * lx + m11 * ly + m21 * lz + m31;
                        float wz = m02 * lx + m12 * ly + m22 * lz + m32;
                        int col = cArr[v];
                        vc.vertex(wx, wy, wz)
                                .color((col >>> 24) & 0xFF, (col >>> 16) & 0xFF, (col >>> 8) & 0xFF, col & 0xFF)
                                .uv(fArr[fIdx + 3], fArr[fIdx + 4])
                                .uv2(FULL_BRIGHT_LIGHT)
                                .endVertex();
                        fIdx += 5;
                    }
                } else {
                    for (int v = 0; v < vcCount; v++) {
                        int col = cArr[v];
                        vc.vertex(mat, fArr[fIdx], fArr[fIdx + 1], fArr[fIdx + 2])
                                .color((col >>> 24) & 0xFF, (col >>> 16) & 0xFF, (col >>> 8) & 0xFF, col & 0xFF)
                                .uv(fArr[fIdx + 3], fArr[fIdx + 4])
                                .uv2(FULL_BRIGHT_LIGHT)
                                .endVertex();
                        fIdx += 5;
                    }
                }
                flushed++;
            }
            return flushed;
        }

        private static final class AtlasBucket {
            RenderType renderType;
            int vertCount = 0;
            float[] xyzUv = new float[1280]; // 256 vertices initial
            int[] rgba = new int[256];

            void reset() {
                this.renderType = null;
                this.vertCount = 0;
            }

            void ensureCapacity(int neededVerts) {
                if (neededVerts > rgba.length) {
                    int nextCap = Math.max(rgba.length << 1, neededVerts);
                    xyzUv = Arrays.copyOf(xyzUv, nextCap * 5);
                    rgba = Arrays.copyOf(rgba, nextCap);
                }
            }
        }
    }
}
