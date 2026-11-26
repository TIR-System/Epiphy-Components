// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.core.world;

import net.minecraft.resources.ResourceLocation;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunkSection;
import net.minecraftforge.registries.ForgeRegistries;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 原生 16x16x16 {@link LevelChunkSection} 极速调色板预筛与扫描算子。
 * 将过渡期 KubeJS 脚本中每区块段 4096 次 Rhino 跨界调用压缩为单次纯 Java 紧凑指针扫描。
 */
public final class NativeSectionScanner {

    public record MatchedBlockPos(String blockId, int x, int y, int z) {}

    private NativeSectionScanner() {}

    /**
     * 在给定 {@link LevelChunkSection} 中扫描命中 {@code targetBlockIds} 的全部方块坐标。
     *
     * @return 若整段仅含空气或调色板不含目标方块则 O(palette) 立即返回空列表；否则返回紧凑命中列表。
     */
    public static List<MatchedBlockPos> scanSection(
            LevelChunkSection section,
            int sectionX,
            int sectionY,
            int sectionZ,
            Collection<String> targetBlockIds
    ) {
        if (section == null || section.hasOnlyAir() || targetBlockIds == null || targetBlockIds.isEmpty()) {
            return Collections.emptyList();
        }

        final Map<Block, String> targetMap = new IdentityHashMap<>(targetBlockIds.size() * 2);
        for (String rawId : targetBlockIds) {
            if (rawId == null || rawId.isEmpty()) continue;
            ResourceLocation rl = ResourceLocation.tryParse(rawId.trim());
            if (rl == null) continue;
            Block block = ForgeRegistries.BLOCKS.getValue(rl);
            if (block != null && !block.defaultBlockState().isAir()) {
                targetMap.put(block, rl.toString());
            }
        }
        if (targetMap.isEmpty()) {
            return Collections.emptyList();
        }

        final Set<Block> targetBlocks = targetMap.keySet();
        if (!section.maybeHas(state -> state != null && !state.isAir() && targetBlocks.contains(state.getBlock()))) {
            return Collections.emptyList();
        }

        final int baseX = sectionX << 4;
        final int baseY = sectionY << 4;
        final int baseZ = sectionZ << 4;
        List<MatchedBlockPos> out = null;

        for (int ly = 0; ly < 16; ly++) {
            final int wy = baseY + ly;
            for (int lx = 0; lx < 16; lx++) {
                final int wx = baseX + lx;
                for (int lz = 0; lz < 16; lz++) {
                    BlockState st = section.getBlockState(lx, ly, lz);
                    if (st == null || st.isAir()) continue;
                    String matchedId = targetMap.get(st.getBlock());
                    if (matchedId != null) {
                        if (out == null) {
                            out = new ArrayList<>(8);
                        }
                        out.add(new MatchedBlockPos(matchedId, wx, wy, baseZ + lz));
                    }
                }
            }
        }
        return out != null ? out : Collections.emptyList();
    }
}
