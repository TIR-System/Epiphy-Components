// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.client.audio

import dev.epiphy.mixin.client.SoundEngineAccessor
import dev.epiphy.mixin.client.SoundManagerAccessor
import net.minecraft.client.Minecraft
import net.minecraft.client.resources.sounds.SoundInstance
import net.minecraft.sounds.SoundSource
import net.minecraft.world.phys.Vec3
import java.util.Collections
import java.util.IdentityHashMap

/**
 * 零反射 OpenAL 3D 音频底层安全桥接（编译期由 Mixin `@Accessor` 保障，彻底淘汰脚本期脆弱的 SRG 字段反射）。
 */
object NativeAudioClientAccess {

    private val duckedVanillaMusic: MutableSet<SoundInstance> =
        Collections.newSetFromMap(IdentityHashMap())

    private fun resolveChannelMap(): Map<SoundInstance, net.minecraft.client.sounds.ChannelAccess.ChannelHandle>? {
        val mc = Minecraft.getInstance() ?: return null
        val sm = mc.soundManager as? SoundManagerAccessor ?: return null
        val se = sm.`epiphy$getSoundEngine`() as? SoundEngineAccessor ?: return null
        return se.`epiphy$getInstanceToChannel`()
    }

    /**
     * 实时更新正在播放的 OpenAL 声道三维坐标。
     */
    @JvmStatic
    fun updateChannelPosition(instance: SoundInstance, x: Double, y: Double, z: Double): Boolean {
        val handle = resolveChannelMap()?.get(instance) ?: return false
        val pos = Vec3(x, y, z)
        handle.execute { channel ->
            channel.setSelfPosition(pos)
        }
        return true
    }

    /**
     * 挂起或恢复单个声道流（用于出界静音保流或 ESC 恢复同步）。
     */
    @JvmStatic
    fun setChannelPaused(instance: SoundInstance, paused: Boolean): Boolean {
        val handle = resolveChannelMap()?.get(instance) ?: return false
        handle.execute { channel ->
            if (paused) channel.pause() else channel.unpause()
        }
        return true
    }

    /**
     * 温和原版背景音乐避让：仅暂停 `minecraft:` 命名空间的 `MUSIC` 轨道，绝不触碰或停止任何第三方 Mod BGM。
     */
    @JvmStatic
    @Synchronized
    fun setVanillaMusicDucked(duckActive: Boolean): Int {
        val map = resolveChannelMap() ?: return 0
        var affected = 0
        if (duckActive) {
            for ((inst, handle) in map) {
                if (inst.source == SoundSource.MUSIC && inst.location.namespace == "minecraft") {
                    if (duckedVanillaMusic.add(inst)) {
                        handle.execute { it.pause() }
                        affected++
                    }
                }
            }
        } else {
            val iter = duckedVanillaMusic.iterator()
            while (iter.hasNext()) {
                val inst = iter.next()
                val handle = map[inst]
                if (handle != null) {
                    handle.execute { it.unpause() }
                    affected++
                }
                iter.remove()
            }
        }
        return affected
    }
}
