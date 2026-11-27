// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.client.audio

import dev.epiphy.mixin.client.AbstractSoundInstanceAccessor
import dev.epiphy.mixin.client.SoundEngineAccessor
import dev.epiphy.mixin.client.SoundManagerAccessor
import net.minecraft.client.Minecraft
import net.minecraft.client.resources.sounds.SoundInstance
import net.minecraft.resources.ResourceLocation
import net.minecraft.sounds.SoundSource
import net.minecraft.world.phys.Vec3
import java.util.Collections
import java.util.IdentityHashMap

/**
 * 基于编译期 Mixin `@Accessor` 的客户端 OpenAL 3D 音频控制桥接（替代脚本期手写 SRG 字段名的运行期反射）。
 *
 * 工作机制：通过 `SoundManagerAccessor`、`SoundEngineAccessor` 与 `AbstractSoundInstanceAccessor` 读写声源坐标、音量、声道挂起恢复及右下角字幕，
 * 并在播放受管音乐时按命名空间暂停原版 `minecraft:` 背景音乐。
 *
 * 已知边界：`ChannelAccess.ChannelHandle.execute` 会将任务异步提交至独立音频线程执行，因此在主线程调用时无法同步获知音频线程闭包内的即时返回状态。
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
     * 编译期安全更新 [SoundInstance] 内部音量字段（保底 0.0001f 防止原版 SoundEngine.tick 将 <= 0 音源直接销毁）。
     */
    @JvmStatic
    fun syncInstanceVolume(instance: SoundInstance?, volume: Float): Boolean {
        val acc = instance as? AbstractSoundInstanceAccessor ?: return false
        acc.`epiphy$setVolume`(volume.coerceIn(0.0001f, 2.0f))
        return true
    }

    /**
     * 编译期安全更新 [SoundInstance] 内部三维坐标字段。
     */
    @JvmStatic
    fun syncInstancePosition(instance: SoundInstance?, x: Double, y: Double, z: Double): Boolean {
        val acc = instance as? AbstractSoundInstanceAccessor ?: return false
        acc.`epiphy$setX`(x)
        acc.`epiphy$setY`(y)
        acc.`epiphy$setZ`(z)
        return true
    }

    /**
     * 单次原生调用完成：更新 [SoundInstance] 音量、同步底层 OpenAL `Channel` 增益、处理静音挂起/恢复保流。
     *
     * @return `1` = 声道正常同步（未暂停）；`2` = 声道已处于静音挂起保流态；`-1` = 底层 OpenAL 声道已停止；`0` = 尚未分配声道句柄。
     */
    @JvmStatic
    fun applyChannelGainAndPauseState(
        instance: SoundInstance?,
        instanceVol: Float,
        finalAlGain: Float,
        shouldPauseMute: Boolean,
        forceUnpause: Boolean
    ): Int {
        if (instance == null) return 0
        syncInstanceVolume(instance, instanceVol)
        val handle = resolveChannelMap()?.get(instance) ?: return 0
        val clampedAl = finalAlGain.coerceIn(0.0f, 2.0f)
        val stoppedObserved = java.util.concurrent.atomic.AtomicBoolean(false)
        handle.execute { channel ->
            if (channel.stopped()) {
                stoppedObserved.set(true)
                return@execute
            }
            channel.setVolume(clampedAl)
            if (shouldPauseMute) {
                channel.pause()
            } else if (forceUnpause) {
                channel.unpause()
            }
        }
        if (stoppedObserved.get()) return -1
        return if (shouldPauseMute) 2 else 1
    }

    /**
     * 实时更新正在播放的 [SoundInstance] 字段与底层 OpenAL 声道三维坐标。
     */
    @JvmStatic
    fun updateChannelPosition(instance: SoundInstance?, x: Double, y: Double, z: Double): Boolean {
        if (instance == null) return false
        syncInstancePosition(instance, x, y, z)
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
    fun setChannelPaused(instance: SoundInstance?, paused: Boolean): Boolean {
        if (instance == null) return false
        val handle = resolveChannelMap()?.get(instance) ?: return false
        handle.execute { channel ->
            if (paused) channel.pause() else channel.unpause()
        }
        return true
    }

    /**
     * 通过 `GuiAccessor` 刷新循环 3D 音源的右下角原版字幕显示与方向指示。
     */
    @JvmStatic
    fun refreshSubtitle(instance: SoundInstance?, soundId: String?): Boolean {
        if (instance == null || soundId.isNullOrBlank()) return false
        val mc = Minecraft.getInstance() ?: return false
        val rl = ResourceLocation.tryParse(soundId.trim()) ?: return false
        val weighed = mc.soundManager.getSoundEvent(rl) ?: return false
        val subtitleOverlay = (mc.gui as? dev.epiphy.mixin.client.GuiAccessor)?.`epiphy$getSubtitleOverlay`() ?: return false
        subtitleOverlay.onPlaySound(instance, weighed)
        return true
    }

    /**
     * 获取客户端合成类别增益系数（`MASTER * category`）。
     */
    @JvmStatic
    fun getCategoryGainMultiplier(categoryName: String?): Float {
        val mc = Minecraft.getInstance() ?: return 1.0f
        val opts = mc.options ?: return 1.0f
        val master = opts.getSoundSourceVolume(SoundSource.MASTER)
        val cat = runCatching {
            SoundSource.valueOf((categoryName ?: "RECORDS").trim().uppercase())
        }.getOrDefault(SoundSource.RECORDS)
        val catVol = opts.getSoundSourceVolume(cat)
        return (master * catVol).coerceIn(0.0f, 1.0f)
    }

    /**
     * 温和原版背景音乐避让：仅暂停 `minecraft:` 命名空间的 `MUSIC` 轨道，绝不触碰或停止任何第三方 Mod BGM。
     */
    @JvmStatic
    @Synchronized
    @JvmOverloads
    fun setVanillaMusicDucked(duckActive: Boolean, excludedInstances: Collection<SoundInstance>? = null): Int {
        val map = resolveChannelMap() ?: return 0
        var affected = 0
        if (duckActive) {
            for ((inst, handle) in map) {
                if (excludedInstances != null && excludedInstances.contains(inst)) continue
                if (inst.source == SoundSource.MUSIC && inst.location.namespace == "minecraft") {
                    if (duckedVanillaMusic.add(inst)) {
                        handle.execute { ch ->
                            if (!ch.stopped()) ch.pause()
                        }
                        affected++
                    }
                }
            }
            if (duckedVanillaMusic.isEmpty()) {
                runCatching { Minecraft.getInstance()?.musicManager?.stopPlaying() }
            }
        } else {
            val iter = duckedVanillaMusic.iterator()
            while (iter.hasNext()) {
                val inst = iter.next()
                val handle = map[inst]
                if (handle != null) {
                    handle.execute { ch ->
                        if (!ch.stopped()) ch.unpause()
                    }
                    affected++
                }
                iter.remove()
            }
        }
        return affected
    }
}
