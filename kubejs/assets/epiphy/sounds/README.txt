Epiphy 音频资源说明 (Audio Assets Notes)
========================================

1. 随仓库分发的运行期音效（Ogg Vorbis, 供 sounds.json 与游戏内事件使用）：
   - air_raid_siren.ogg        (epiphy:air_raid_siren)
   - atomic_bomb_explosion.ogg (epiphy:atomic_bomb_explosion)
   - hardware_error.ogg        (epiphy:hardware_error)

2. 公开仓库刻意排除的内容（已加入 .gitignore）：
   - children_of_the_city.ogg：第三方商业版权音乐，因许可证与体积原因不随公开代码库分发。
     sounds.json 与功能测试方块 (epiphy:rnfmabj_test) 仍保留 `epiphy:children_of_the_city`
     事件槽位；如在本地实机需要对应 BGM，请自行将合规 .ogg 放入此处命名为
     `children_of_the_city.ogg`，或在 `Epiphy的小玩意_功能测试.js` 中替换为自定义音效 ID。
     缺省该文件时仅无对应音乐播放，不影响测试方块的放置与屏幕弹幕功能。
   - 冗余 `.mp3` 源文件（atomic_bomb_explosion.mp3 / air_raid_siren.mp3 / hardware_error.mp3）：
     Minecraft 音频系统仅读取 `.ogg` 格式，故未再保留重复源音频。
