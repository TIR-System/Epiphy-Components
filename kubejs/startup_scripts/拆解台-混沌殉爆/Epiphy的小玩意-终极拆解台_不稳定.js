// ============================================================================
//  拆解台 · 混沌殉爆 —— 失稳阶段方块注册 & 硬度修改 (KubeJS 1.20.1 / 2001.6.5)
//  许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
//  放置位置：kubejs/startup_scripts/拆解台-混沌殉爆/Epiphy的小玩意-终极拆解台_不稳定.js
//  第三方 Mod 联动声明（玩法专属，原则见 README-LLM.md §3.3）：
//    - Twilight Forest（可选联动）：存在时将 `twilightforest:uncrafting_table` 挖掘硬度调整为 50.0；缺失时跳过修改，5 个失稳阶段方块与音效仍正常注册。
//  资源单一事实源（命名空间 epiphy，位于 kubejs/assets/epiphy/，后续可零改动迁入原生 Mod assets/）：
//    - kubejs/assets/epiphy/blockstates/ultra_uncrafting_instability_1~5.json
//    - kubejs/assets/epiphy/models/block/ultra_uncrafting_instability_1~5.json  (双层自发光 forge_data block_light=15)
//    - kubejs/assets/epiphy/models/item/ultra_uncrafting_instability_1~5.json
//    - kubejs/assets/epiphy/textures/block/ultra_uncrafting_instability_1~5_*.png
//    - kubejs/assets/epiphy/lang/zh_cn.json
//  注意：全部为普通静态资源文件，无运行时重复拼接 modelJson，无符号链接 / 硬链接 / 联接点。
//
//  5 个失稳阶段方块设计（从【外壳破损】一路到【堆芯熔毁】）：
//    - epiphy:ultra_uncrafting_instability_1 —— 终极拆解台 [外壳破损]（0s ~ 36s，浅粉红染色 #FFCCCC，光照 6）
//    - epiphy:ultra_uncrafting_instability_2 —— 终极拆解台 [阻尼失效]（36s ~ 72s，亮珊瑚红 #FF9999，光照 9）
//    - epiphy:ultra_uncrafting_instability_3 —— 终极拆解台 [超算过载]（72s ~ 108s，鲜红 #FF6666，光照 11）
//    - epiphy:ultra_uncrafting_instability_4 —— 终极拆解台 [奇点暴走]（108s ~ 144s，深赤红 #FF3333，光照 13）
//    - epiphy:ultra_uncrafting_instability_5 —— 终极拆解台 [堆芯熔毁]（144s ~ 180s，炽烈血红 #FF0000，光照 15）
//
//  材质与模型说明：
//    - 以 `epiphy:block/ultra_uncrafting_instability_1~5_*` 资源位置逐级变红（贴图自身已预烘焙阶段色彩），
//    - 双层自发光结构（forge_data block_light=15），光照等级从 6 递增至 15，
//    - 无合成配方、无战利品掉落（noDrops），黑曜石级硬度（50.0）与防爆抗性（3600000.0）。
// ============================================================================

;(function () {
    var STAGES = [
        {
            id: 'epiphy:ultra_uncrafting_instability_1',
            shortId: 'ultra_uncrafting_instability_1',
            name: '终极拆解台 [外壳破损]',
            light: 6 / 15.0 // 光照 6
        },
        {
            id: 'epiphy:ultra_uncrafting_instability_2',
            shortId: 'ultra_uncrafting_instability_2',
            name: '终极拆解台 [阻尼失效]',
            light: 9 / 15.0 // 光照 9
        },
        {
            id: 'epiphy:ultra_uncrafting_instability_3',
            shortId: 'ultra_uncrafting_instability_3',
            name: '终极拆解台 [超算过载]',
            light: 11 / 15.0 // 光照 11
        },
        {
            id: 'epiphy:ultra_uncrafting_instability_4',
            shortId: 'ultra_uncrafting_instability_4',
            name: '终极拆解台 [奇点暴走]',
            light: 13 / 15.0 // 光照 13
        },
        {
            id: 'epiphy:ultra_uncrafting_instability_5',
            shortId: 'ultra_uncrafting_instability_5',
            name: '终极拆解台 [堆芯熔毁]',
            light: 15 / 15.0 // 光照 15
        }
    ]

    StartupEvents.registry('block', function (event) {
        for (var i = 0; i < STAGES.length; i++) {
            ;(function (stage) {
                var s = stage.shortId
                // 方块状态与双层自发光模型由 kubejs/assets/epiphy/{blockstates,models}/ 静态 JSON 单一事实源提供
                event.create(stage.id)
                    .displayName(stage.name)
                    .soundType('NETHERITE_BLOCK')
                    .hardness(50.0)
                    .resistance(3600000.0)
                    .lightLevel(stage.light)
                    .noDrops()
                    .defaultTranslucent()
                    .texture('up', 'epiphy:block/' + s + '_uncrafting_top')
                    .texture('down', 'epiphy:block/' + s + '_uncrafting_particle')
                    .texture('north', 'epiphy:block/' + s + '_uncrafting_side')
                    .texture('south', 'epiphy:block/' + s + '_uncrafting_side')
                    .texture('east', 'epiphy:block/' + s + '_uncrafting_side')
                    .texture('west', 'epiphy:block/' + s + '_uncrafting_side')
                    .texture('particle', 'epiphy:block/' + s + '_uncrafting_particle')
            })(STAGES[i])
        }
    })

    // 将原版终极拆解台挖掘硬度调为 50.0（黑曜石同款），不调高防爆抗性，不改变活塞推动属性
    if (typeof BlockEvents !== 'undefined' && BlockEvents != null && typeof BlockEvents.modification === 'function') {
        if (typeof Platform === 'undefined' || Platform == null || typeof Platform.isLoaded !== 'function' || Platform.isLoaded('twilightforest')) {
            BlockEvents.modification(function (event) {
                event.modify('twilightforest:uncrafting_table', function (block) {
                    block.destroySpeed = 50.0
                })
            })
        }
    }

    // ------------------------------------------------------------------------
    // 将 5 个失稳阶段方块声明加入独立创造模式物品栏模块 [kubejs/startup_scripts/通用组件/创造模式栏-epiphy.js]
    // ------------------------------------------------------------------------
    var stageItemIds = []
    for (var sIdx = 0; sIdx < STAGES.length; sIdx++) {
        stageItemIds.push(STAGES[sIdx].id)
    }
    if (typeof global !== 'undefined' && global != null) {
        if (global.EpiphyCreativeTab != null && typeof global.EpiphyCreativeTab.register === 'function') {
            global.EpiphyCreativeTab.register(stageItemIds)
            if (typeof global.EpiphyCreativeTab.setIcon === 'function') {
                global.EpiphyCreativeTab.setIcon('epiphy:ultra_uncrafting_instability_5')
            }
        } else {
            if (!Array.isArray(global.EpiphyCreativeTabQueue)) {
                global.EpiphyCreativeTabQueue = []
            }
            for (var qIdx = 0; qIdx < stageItemIds.length; qIdx++) {
                global.EpiphyCreativeTabQueue.push(stageItemIds[qIdx])
            }
        }
    }

    // ------------------------------------------------------------------------
    // 自定义音效注册（对应 kubejs/assets/epiphy/sounds.json 与 sounds/*.ogg）
    //   - epiphy:atomic_bomb_explosion —— 零点核聚变殉爆巨响
    //   - epiphy:air_raid_siren        —— 失稳阶段防空凄厉警报
    //   - epiphy:hardware_error        —— 硬件致命错误 / 子系统故障短促告警
    // ------------------------------------------------------------------------
    StartupEvents.registry('sound_event', function (event) {
        event.create('epiphy:atomic_bomb_explosion')
        event.create('epiphy:air_raid_siren')
        event.create('epiphy:hardware_error')
    })
})()
