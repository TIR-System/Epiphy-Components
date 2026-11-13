// ============================================================================
//  拆解台 · 混沌殉爆 —— 失稳阶段方块注册 & 硬度修改 (KubeJS 1.20.1 / 2001.6.5)
//  放置位置：kubejs/startup_scripts/拆解台-混沌殉爆/Epiphy的小玩意-终极拆解台_不稳定.js
//  资源加载位置（命名空间 epiphy；KubeJS 的加载根为 kubejs/assets/，无法用脚本改写）：
//    kubejs/assets/epiphy/textures/block/ultra_uncrafting_instability_1~5_*.png   ← 唯一必须的实体资源
//    kubejs/assets/epiphy/lang/zh_cn.json                                          ← 可选，显示名同脚本内 displayName
//  模型与方块状态：**不放磁盘文件**，由本脚本的 .texture() 与 builder.modelJson 在运行时生成，
//    与 E:\Minecraft\Deuterium_VIII 实例中 minia 命名空间的做法一致（该实例 assets 下只有 textures）。
//    若在 assets 下另放 models/ blockstates/，会以同名 key 覆盖运行时生成的内容，反而引发资源异常。
//  归档副本（普通文件，纯备份，不参与加载）：
//    kubejs/startup_scripts/拆解台-混沌殉爆/models/
//  注意：不使用符号链接 / 硬链接 / 联接点等任何操作系统级技巧，全部为普通文件，
//        打包成整合包换机器后行为完全一致。
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
                var builder = event.create(stage.id)
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

                // 与 kubejs/assets/epiphy/models/block/ultra_uncrafting_instability_1~5.json 同构（双层自发光）
                builder.modelJson = {
                    parent: 'minecraft:block/block',
                    render_type: 'minecraft:translucent',
                    textures: {
                        bottom: 'epiphy:block/' + s + '_uncrafting_particle',
                        particle: 'epiphy:block/' + s + '_uncrafting_particle',
                        top: 'epiphy:block/' + s + '_uncrafting_top',
                        top2: 'epiphy:block/' + s + '_uncrafting_glow',
                        north: 'epiphy:block/' + s + '_uncrafting_side',
                        south: 'epiphy:block/' + s + '_uncrafting_side',
                        east: 'epiphy:block/' + s + '_uncrafting_side',
                        west: 'epiphy:block/' + s + '_uncrafting_side',
                        north2: 'epiphy:block/' + s + '_uncrafting_glow_side',
                        south2: 'epiphy:block/' + s + '_uncrafting_glow_side',
                        east2: 'epiphy:block/' + s + '_uncrafting_glow_side',
                        west2: 'epiphy:block/' + s + '_uncrafting_glow_side'
                    },
                    elements: [
                        {
                            from: [-0.05, -0.05, -0.05],
                            to: [16.05, 16.05, 16.05],
                            faces: {
                                down: { cullface: 'down', texture: '#bottom' },
                                up: { cullface: 'up', texture: '#top' },
                                north: { cullface: 'north', texture: '#north' },
                                south: { cullface: 'south', texture: '#south' },
                                east: { cullface: 'east', texture: '#east' },
                                west: { cullface: 'west', texture: '#west' }
                            }
                        },
                        {
                            from: [-0.05, -0.05, -0.05],
                            to: [16.05, 16.05, 16.05],
                            faces: {
                                up: { cullface: 'up', forge_data: { block_light: 15, sky_light: 15 }, texture: '#top2' },
                                north: { cullface: 'north', forge_data: { block_light: 15, sky_light: 15 }, texture: '#north2' },
                                south: { cullface: 'south', forge_data: { block_light: 15, sky_light: 15 }, texture: '#south2' },
                                east: { cullface: 'east', forge_data: { block_light: 15, sky_light: 15 }, texture: '#east2' },
                                west: { cullface: 'west', forge_data: { block_light: 15, sky_light: 15 }, texture: '#west2' }
                            }
                        }
                    ]
                }
            })(STAGES[i])
        }
    })

    // 将原版终极拆解台挖掘硬度调为 50.0（黑曜石同款），不调高防爆抗性，不改变活塞推动属性
    BlockEvents.modification(function (event) {
        event.modify('twilightforest:uncrafting_table', function (block) {
            block.destroySpeed = 50.0
        })
    })

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
