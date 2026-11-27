// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.client.surface2d.text;

import net.minecraft.client.gui.Font;
import net.minecraft.client.renderer.MultiBufferSource;

/**
 * 可选高精度字形网格捕获后端 SPI（主模块保持零第三方依赖；当软兼容模块检测到 ModernUI 等排版引擎时可按需注入）。
 */
public interface GlyphCaptureBackend {

    /**
     * 当前后端排版缓存纪元（字体重载或设置变更时递增，驱动字形缓存自动失效）。
     */
    int currentEpoch();

    /**
     * 将给定文本在原点 {@code (0, 0)} 处的字形 Quad 写入捕获缓冲源。
     *
     * @param font          当前客户端原版 {@link Font}
     * @param rawText       含可选 {@code §} 样式前缀的文本片段
     * @param seeThrough    是否为透视模式（如 {@code world_plane} {@code seeThrough=true}）
     * @param preferSdf     是否倾向启用 SDF 矢量距离场模式（用于旋转、缩放或平滑描边场景）
     * @param capturer      拦截 {@code RenderType} 与 Quad 顶点的内存缓冲源
     * @param sentinelR     用于区分默认继承色与显式 {@code §} 颜色码的哨兵 R 通道 (0..255)
     * @param sentinelG     哨兵 G 通道 (0..255)
     * @param sentinelB     哨兵 B 通道 (0..255)
     * @return 若成功由该后端完成字形发射则返回 {@code true}；返回 {@code false} 时自动无缝回退原版 {@link Font}
     */
    boolean captureGlyphs(
            Font font,
            String rawText,
            boolean seeThrough,
            boolean preferSdf,
            MultiBufferSource capturer,
            int sentinelR,
            int sentinelG,
            int sentinelB
    );
}
