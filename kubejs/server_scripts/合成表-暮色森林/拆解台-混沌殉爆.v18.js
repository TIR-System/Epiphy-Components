// ============================================================================
//  拆解台 · 混沌殉爆 v18（3 分钟五阶段方块演进 & 终望珍珠吞噬停机 & 防破坏保护版）
//  许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
//  放置位置：kubejs/server_scripts/合成表-暮色森林/拆解台-混沌殉爆.v18.js
//  硬前置  ：
//    - kubejs/startup_scripts/拆解台-混沌殉爆/Epiphy的小玩意-终极拆解台_不稳定.js
//    - kubejs/server_scripts/通用组件/Epiphy的-服务端核心.js (EpiphyServerCore, priority: 1080)
//    - kubejs/server_scripts/通用组件/Epiphy的-方块与区块组件.js (EpiphyWorldOps, priority: 1050)
//    - kubejs/server_scripts/通用组件/Epiphy的-屏幕弹幕组件.js (ScreenDanmaku, priority: 500)
//  可选增强：kubejs/server_scripts/通用组件/Epiphy的-音频组件.js (EpiphyAudio, priority: 500)
//  [语法规范] 遵循 README-LLM.md §1 强制语法基准（与 docs/kube-mods-rhino-es5-es6-compatibility.md）
//  资源位置：kubejs/assets/epiphy/（models / textures / blockstates / lang）—— 加载根，普通文件；
//            另有纯备份副本位于 kubejs/startup_scripts/拆解台-混沌殉爆/models/，不参与加载。
//            全部为普通文件，无符号链接/硬链接/联接点，打包换机后行为一致。
//
//  核心机制总览：
//    0. 5 个失稳阶段方块（无合成方式，仅在破坏终极拆解台时出现；创造模式放置直接进入失稳爆炸流程）：
//       - epiphy:ultra_uncrafting_instability_1 —— 终极拆解台 [外壳破损]（0s ~ 36s，浅粉红 #FFCCCC，光照 6）
//       - epiphy:ultra_uncrafting_instability_2 —— 终极拆解台 [阻尼失效]（36s ~ 72s，亮珊瑚红 #FF9999，光照 9）
//       - epiphy:ultra_uncrafting_instability_3 —— 终极拆解台 [超算过载]（72s ~ 108s，鲜红 #FF6666，光照 11）
//       - epiphy:ultra_uncrafting_instability_4 —— 终极拆解台 [奇点暴走]（108s ~ 144s，深赤红 #FF3333，光照 13）
//       - epiphy:ultra_uncrafting_instability_5 —— 终极拆解台 [堆芯熔毁]（144s ~ 180s，炽烈血红 #FF0000，光照 15）
//    1. 3 分钟（3600 tick）五阶段方块替换与随机原版药水辐射：
//       - 每 36 秒（720 tick）自动将核心方块替换为下一阶段（材质不断变红、光照逐级增强）。
//       - 期间周期性对周围玩家施加随机原版药水效果（瞬间治疗、生命恢复、中毒、凋零、反胃、失明、饥饿、虚弱、缓慢、发光、漂浮等）。
//    2. 唯一终止方式 —— 终望珍珠吞噬（avaritia:endest_pearl / avaritia:gaping_void）：
//       - 仅当无尽贪婪的【终望珍珠】或其生成的黑洞奇点【Gaping Void】吞噬/命中失稳拆解台时，才可终止爆炸，
//         并在玩家界面弹出完整的【异常停机】错误报告与全屏停机通告。
//    3. 防破坏保护：
//       - 创造模式破坏：不稳定状态的拆解台被创造模式玩家破坏时，正常破坏并终止爆炸（如同“神的力量终结了一切”）。
//       - 生存/其他方式破坏：若在生存模式下被挖掘，或被其他外力/模组强行破坏，方块立即锁死恢复并触发【致命错误】警报，
//         倒计时强制缩短至 10 秒（200 tick），10 秒后直接引爆！
//    4. 至高遗物豁免（背包 / 饰品栏持有即生效，检测方式为玩家 NBT 物品 id 匹配）：
//       - 七咒之戒（enigmaticlegacy:cursed_ring）
//       - 寰宇支配之剑（avaritia:infinity_sword）
//       - 晋升之环（goety_revelation:ascension_halo）
//       - 终末之环（goety_revelation:halo_of_the_end）
//       以上任意一件 → 普通终极拆解台可被正常拆除，不触发殉爆。
//       在此之上：
//       - 七咒之戒 → 可拆除【失稳阶段】方块，但残骸被诅咒吞没，无任何掉落。
//       - 终末之环 → 可拆除【失稳阶段】方块，并掉落一台全新的终极拆解台（twilightforest:uncrafting_table）。
//       注：创造模式下遗物检测整体不生效；持有钻石镐时跳过遗物检测。
//    5. 爆炸收尾扩展：
//       - 液体彻底清除：采用底层 LevelChunkSection 调色板（Palette）O(1) 过滤 + 原地状态剥离，
//         T+0 同步抽干核心区并在波前推进中持续扫尾，100% 清除水源、流动水、含水方块、水生植物、岩浆及模组流体。
//       - 岩浆圈层：波前到达最大半径后沿外壳浇筑一圈闭合岩浆。
//       - 基岩层：不改动（底层 / 顶层基岩仍由 clampTraces 保护）。
//       - 进度文案按 DE_PROGRESS_MULTIPLIER（3 倍）推进，与实测方块消失速度对齐。
// ============================================================================

;(function () {
    // ------------------------------------------------------------------------
    // 基础配置项
    // ------------------------------------------------------------------------
    var TARGET_ID = 'twilightforest:uncrafting_table'
    var SAFE_TOOL = 'minecraft:diamond_pickaxe'

    // 资源引用说明：脚本内一律使用原版资源位置（namespace:path），由游戏按资源包规则解析，
    // 不出现任何盘符或绝对路径：epiphy:block/<id> 由资源包根下的
    //   assets/kubejs/models/block/<id>.json 与 assets/kubejs/textures/block/<id>.png 提供。

    // 5 个失稳阶段方块 ID 与阶段元数据（每阶段 36 秒 = 720 tick，总计 180 秒 = 3600 tick）
    var STAGE_META = [
        {
            id: 'epiphy:ultra_uncrafting_instability_1', name: '终极拆解台 [外壳破损]', tag: '外壳破损', hex: '#FFCCCC', light: 6, colorCode: '§d',
            alertColor: null, subColor: null, chatColor: null, alertBody: null, chatBody: null
        },
        {
            id: 'epiphy:ultra_uncrafting_instability_2', name: '终极拆解台 [阻尼失效]', tag: '阻尼失效', hex: '#FF9999', light: 9, colorCode: '§e',
            alertColor: 'yellow', subColor: 'gold', chatColor: 'yellow',
            alertBody: '中子素阻尼层熔穿（阶段 2/5）',
            chatBody: '[STAGE_2 // 阻尼失效] 阶段 - 阻尼失效，超重中子辐射与药水污染正在加剧！'
        },
        {
            id: 'epiphy:ultra_uncrafting_instability_3', name: '终极拆解台 [超算过载]', tag: '超算过载', hex: '#FF6666', light: 11, colorCode: '§6',
            alertColor: 'gold', subColor: 'yellow', chatColor: 'gold',
            alertBody: '65M 超越存储矩阵逻辑雪崩（阶段 3/5）',
            chatBody: '[STAGE_3 // 超算过载] 阶段 - 超算过载，逆向拆解回路彻底锁死，请尽快使用【终望珍珠】吞噬核心！'
        },
        {
            id: 'epiphy:ultra_uncrafting_instability_4', name: '终极拆解台 [奇点暴走]', tag: '奇点暴走', hex: '#FF3333', light: 13, colorCode: '§c',
            alertColor: 'red', subColor: 'gold', chatColor: 'red',
            alertBody: '深渊之心与时之核心反噬（阶段 4/5）',
            chatBody: '[STAGE_4 // 奇点暴走] 阶段 - 奇点暴走，局部时间线回滚失败，空间曲率急剧下陷！'
        },
        {
            id: 'epiphy:ultra_uncrafting_instability_5', name: '终极拆解台 [堆芯熔毁]', tag: '堆芯熔毁', hex: '#FF0000', light: 15, colorCode: '§4§l',
            alertColor: 'dark_red', subColor: 'red', chatColor: 'dark_red',
            alertBody: '四组无尽催化剂全面点燃（阶段 5/5）',
            chatBody: '[STAGE_5 // 堆芯熔毁] 警告：已至最终阶段 - 堆芯熔毁！除非立即投掷【终望珍珠】将其吞噬，否则将释放 300 格物质湮灭！'
        }
    ]

    var STAGE_BLOCKS = []
    var STAGE_MAP = {}
    for (var sIdx = 0; sIdx < STAGE_META.length; sIdx++) {
        STAGE_BLOCKS.push(STAGE_META[sIdx].id)
        STAGE_MAP[STAGE_META[sIdx].id] = sIdx
    }

    // ------------------------------------------------------------------------
    // 至高遗物：背包 / 饰品栏持有即可正常破坏终极拆解台
    //   goety_revelation 的两个环由 Curios 提供，统一交由 EpiphyServerCore.findPlayerItem 校验
    // ------------------------------------------------------------------------
    var RELIC_CURSED_RING  = 'enigmaticlegacy:cursed_ring'        // 七咒之戒
    var RELIC_INFINITY_SWD = 'avaritia:infinity_sword'            // 寰宇支配之剑
    var RELIC_ASCENSION    = 'goety_revelation:ascension_halo'    // 晋升之环
    var RELIC_HALO_OF_END  = 'goety_revelation:halo_of_the_end'   // 终末之环

    // 拆除常态拆解台时的持有检测优先度：终末之环 → 寰宇支配之剑 → 晋升之环 → 七咒之戒
    var DIVINE_RELICS = [
        RELIC_HALO_OF_END,
        RELIC_INFINITY_SWD,
        RELIC_ASCENSION,
        RELIC_CURSED_RING
    ]

    // 遗物 id → 显示名
    var RELIC_LABELS = {}
    RELIC_LABELS[RELIC_CURSED_RING]  = '七咒之戒'
    RELIC_LABELS[RELIC_INFINITY_SWD] = '寰宇支配之剑'
    RELIC_LABELS[RELIC_ASCENSION]    = '晋升之环'
    RELIC_LABELS[RELIC_HALO_OF_END]  = '终末之环'

    // T+0 报错与秒杀半径（格）
    var MSG_RADIUS  = 10
    var LEGACY_KILL = true

    // T+0 小爆炸参数（大爆炸前的初始外壳破裂小爆炸，使用 NONE 防止炸毁刚替换的阶段 1 方块）
    var INITIAL_SMALL_EXPLOSION = true
    var SMALL_EXPLOSION_POWER   = 4.0

    // 屏幕报错提示覆盖的玩家半径（格）
    var SCREEN_ALERT_RADIUS = 180

    // 以 (0, 0) 为中心、半径 2000 方块内：不触发爆炸，但触发秒杀
    var SAFE_ZONE_ENABLED = true
    var SAFE_RADIUS       = 2000
    var SAFE_SHAPE        = 'circle'

    // 基岩层保护（防止 ProcessChaosImplosion 炸穿下界 y=0 / y=127 与末地 y=0 基岩）
    var LAYER_GUARD_ENABLED   = true
    var GUARD_BOTTOM_Y_NETHER = 0
    var GUARD_BOTTOM_Y_END    = 0
    var GUARD_TOP_FROM_Y      = 127

    // 非玩家破坏检测（活塞推动、TNT/其他爆炸、其他模组破坏等）
    var ENABLE_NON_PLAYER = true
    var NEAR_DISTANCE     = 128
    var PURGE_RADIUS      = 2

    // 阶段 A：3 分钟预警失稳时间（3600 tick = 180 秒，每阶段 720 tick = 36 秒）
    var UNSTABLE_TICKS       = 3600
    var STAGE_DURATION_TICKS = 720
    // 生存模式或外力强行破坏不稳定拆解台时，立刻触发致命错误警报并在 10 秒（200 tick）后爆炸
    var FATAL_ERROR_TICKS    = 200

    var SHAKE_ENABLED     = true
    var SHAKE_INTERVAL    = 15
    var SOUND_INTERVAL    = 12
    var PARTICLE_INTERVAL = 4
    var SOUND_RANGE       = 180

    // 随机原版药水效果触发间隔与作用半径
    var POTION_INTERVAL = 60  // 每 3 秒（60 tick）爆发一次随机辐射药水效果
    var POTION_RADIUS   = 32  // 药水辐射半径 32 格

    // 原版随机药水池（含治疗、中毒、凋零等）
    var RANDOM_VANILLA_POTIONS = [
        { id: 'minecraft:instant_health', label: '瞬间治疗 (辐射回光)', duration: 1,   minAmp: 0, maxAmp: 1 },
        { id: 'minecraft:regeneration',   label: '生命恢复 (细胞增殖)', duration: 120, minAmp: 0, maxAmp: 2 },
        { id: 'minecraft:poison',         label: '剧毒 (重金属析出)',   duration: 140, minAmp: 0, maxAmp: 2 },
        { id: 'minecraft:wither',         label: '凋零 (中子辐射坏死)', duration: 120, minAmp: 0, maxAmp: 2 },
        { id: 'minecraft:nausea',         label: '反胃 (空间曲率眩晕)', duration: 160, minAmp: 0, maxAmp: 0 },
        { id: 'minecraft:blindness',      label: '失明 (切伦科夫闪盲)', duration: 100, minAmp: 0, maxAmp: 0 },
        { id: 'minecraft:darkness',       label: '黑暗 (深渊视界侵蚀)', duration: 120, minAmp: 0, maxAmp: 0 },
        { id: 'minecraft:weakness',       label: '虚弱 (肌体解构)',     duration: 140, minAmp: 0, maxAmp: 2 },
        { id: 'minecraft:slowness',       label: '缓慢 (引力场泥沼)',   duration: 120, minAmp: 0, maxAmp: 2 },
        { id: 'minecraft:hunger',         label: '饥饿 (代谢过载)',     duration: 160, minAmp: 0, maxAmp: 2 },
        { id: 'minecraft:glowing',        label: '发光 (电离荧光标记)', duration: 200, minAmp: 0, maxAmp: 0 },
        { id: 'minecraft:levitation',     label: '漂浮 (反重力乱流)',   duration: 60,  minAmp: 0, maxAmp: 1 },
        { id: 'minecraft:mining_fatigue', label: '挖掘疲劳 (时空迟滞)', duration: 140, minAmp: 0, maxAmp: 2 },
        { id: 'minecraft:absorption',     label: '伤害吸收 (虚空硬化)', duration: 160, minAmp: 0, maxAmp: 1 }
    ]

    // 阶段 B：DE 混沌爆炸参数（半径 300 格 / 300 tick）
    var DE_POWER          = 30
    var DE_LIFETIME       = DE_POWER * 10
    var FX_PACKET_RANGE   = 300
    var FX_RING_PARTICLES = 6
    var FX_BOOM_EVERY     = 6

    // 爆炸后文案推进倍率：实测方块消失比进度条快，这里让文案按 3 倍速推进以便跟上实际观感
    var DE_PROGRESS_MULTIPLIER = 3

    // 液体清除与外圈岩浆环（全权委托 EpiphyWorldOps 统一 8ms/tick 帧预算与每 tick 列数限流驱动）：
    //   1. 首轮扫描遍历柱/球域内的 16×16 区块列，利用 section.hasOnlyAir() 与调色板谓词跳过 90% 以上无流体岩石/空气区段；
    //   2. 上部柱体 + 下部半球结合外沿 1~1.5 格 flag=3 邻接唤醒，截断海平面回灌水幕同时保护深层地下水体；
    //   3. 增量复扫携带 excludeLava 过滤并在 DE_LIFETIME + 7 后浇筑闭合岩浆环，均受 EpiphyWorldOps.CONFIG.worldOpsTickBudgetMs (8ms) 与 ringBlocksPerTick (240) 约束。
    var LIQUID_PURGE_ENABLED    = true
    var LIQUID_PURGE_PADDING    = 14    // 在爆炸半径之外额外多清 14 格，截断外围海洋/湖泊向坑内回流
    var LIQUID_SYNC_INIT_RADIUS = 32    // 爆炸 T+0 瞬间同步抽干的核心半径上限（格，受 4ms 硬上限保护防初始化尖峰）
    var LIQUID_SYNC_MAX_MS      = 4     // T+0 同步预扫的时间预算硬上限（毫秒）
    var LIQUID_PURGE_LOOPS      = 5     // 热点流体区段复扫轮数（防止外围水顺着坑壁回灌）
    var LIQUID_UNLOADED_TTL     = 600   // 未加载区块挂起等待加载的最大存活时长（600 tick = 30 秒，覆盖整个湮灭周期）

    // 最外圈岩浆圈层（爆炸到达最大半径后在最外壳层交由 EpiphyWorldOps 分帧浇筑一圈岩浆，每 tick 列数与 8ms 时间预算由 EpiphyWorldOps 统一约束）
    var MAGMA_RING_ENABLED      = true
    var MAGMA_RING_THICKNESS    = 3     // 圈层厚度（格）
    var MAGMA_RING_WIDTH        = 2     // 圈层径向宽度（格）

    // 终望珍珠与黑洞实体 ID
    var ENDEST_PEARL_ITEM   = 'avaritia:endest_pearl'
    var ENDEST_PEARL_ENTITY = 'avaritia:endest_pearl'
    var GAPING_VOID_ENTITY  = 'avaritia:gaping_void'
    var VOID_SWALLOW_RADIUS = 19.5 // GapingVoidEntity 最大吞噬半径约 17.5 格，取 19.5 格确保在黑洞吞噬圈内稳定捕获

    // 允许放置并生效的三个维度
    var ALLOWED_DIMS = {
        'minecraft:overworld': true,
        'minecraft:the_nether': true,
        'minecraft:the_end': true
    }

    // ------------------------------------------------------------------------
    // 第一部分：战利品表移除 & 无尽工作台合成配方
    // ------------------------------------------------------------------------
    if (typeof LootJS !== 'undefined') {
        LootJS.modifiers(function (event) {
            event.addLootTypeModifier(LootType.ENTITY).removeLoot(TARGET_ID)
            event.addLootTypeModifier(LootType.BLOCK).removeLoot(TARGET_ID)
            event.addLootTypeModifier(LootType.CHEST).removeLoot(TARGET_ID)
            event.addLootTypeModifier(LootType.FISHING).removeLoot(TARGET_ID)
            for (var i = 0; i < STAGE_BLOCKS.length; i++) {
                event.addLootTypeModifier(LootType.BLOCK).removeLoot(STAGE_BLOCKS[i])
            }
            event.enableLogging()
            console.log('已从所有战利品类型中移除物品: ' + TARGET_ID)
        })
    }

    ServerEvents.recipes(function (event) {
        event.remove({ output: TARGET_ID })
        for (var i = 0; i < STAGE_BLOCKS.length; i++) {
            event.remove({ output: STAGE_BLOCKS[i] })
        }

        var avaritia = event.recipes.avaritia
        if (avaritia != null) {
            avaritia.shaped_table(
                4,
                TARGET_ID,
                [
                    'KOOOIOOOK',
                    'KEEEGEEEK',
                    'KEHFDFHEK',
                    'KEFCBCFEK',
                    'JGDBABDGJ',
                    'MEFCBCFEM',
                    'MEHFDFHEM',
                    'MEEEGEEEM',
                    'NLLLNLLLN'
                ],
                {
                    A: 'avaritia:endest_pearl',
                    B: 'avaritia:sculk_crafting_table',
                    C: 'avaritia:nether_crafting_table',
                    D: 'avaritia:end_crafting_table',
                    E: 'avaritia:neutron',
                    F: 'tconstruct:manyullyn_block',
                    G: 'enigmaticlegacy:abyssal_heart',
                    H: 'avaritia:crystal_matrix',
                    I: 'prinegorerouse:chronos',
                    J: 'minecraft:skeleton_skull',
                    K: 'umapyoi:ssr_uma_ticket',
                    L: 'umapyoi:ssr_card_ticket',
                    N: 'ae2additions:super_cell_65m',
                    M: 'umapyoi:ssr_card_ticket',
                    O: 'avaritia:infinity_catalyst'
                }
            )
        }
    })

    // ------------------------------------------------------------------------
    // 第二部分：硬前置校验与组件绑定（玩法层不重复实现底座工具）
    // ------------------------------------------------------------------------
    var BASE      = (typeof global !== 'undefined') ? (global.EpiphyServerCore || global.EpiphyServerBase) : null
    var WORLD_OPS = (typeof global !== 'undefined') ? (global.EpiphyWorldOps || global.EpiphyChunkEngine || global.EpiphyBlockTracker) : null
    var DANMAKU   = (typeof global !== 'undefined') ? global.ScreenDanmaku : null
    if (!BASE || !WORLD_OPS || !DANMAKU) {
        throw new Error('[拆解台-混沌殉爆] 缺少必需前置组件（EpiphyServerCore / EpiphyWorldOps / ScreenDanmaku），请确认 server_scripts/通用组件/ 已完整加载')
    }
    var AUDIO         = (typeof global !== 'undefined' && global.EpiphyAudio != null) ? global.EpiphyAudio : null
    var LOGGER        = BASE.createLogger('UncraftingChaos', 5000)
    var safeLoadClass = (cls) => BASE.loadJavaClass(cls, true)

    var ProcessChaosImplosion = safeLoadClass('com.brandon3055.draconicevolution.entity.ProcessChaosImplosion')
    var ProcessHandler        = safeLoadClass('com.brandon3055.brandonscore.handlers.ProcessHandler')
    var ChaosImplosionTrace   = safeLoadClass('com.brandon3055.draconicevolution.entity.ProcessChaosImplosion$ChaosImplosionTrace')
    var DraconicNetwork       = safeLoadClass('com.brandon3055.draconicevolution.network.DraconicNetwork')
    var DEDamage              = safeLoadClass('com.brandon3055.draconicevolution.init.DEDamage')
    var ForgeRegistries       = safeLoadClass('net.minecraftforge.registries.ForgeRegistries')
    var ResourceLocation      = safeLoadClass('net.minecraft.resources.ResourceLocation')
    var BlockPos              = safeLoadClass('net.minecraft.core.BlockPos')
    var AABB                  = safeLoadClass('net.minecraft.world.phys.AABB')
    var Level                 = safeLoadClass('net.minecraft.world.level.Level')
    var ExplosionInteraction  = safeLoadClass('net.minecraft.world.level.Level$ExplosionInteraction')

    function rawClassOf(wrapper) {
        if (wrapper == null) return null
        try {
            if (wrapper.__javaObject__ != null) return wrapper.__javaObject__
        } catch (e) { }
        try {
            if (typeof wrapper.getClassObject === 'function') return wrapper.getClassObject()
        } catch (e) { }
        return null
    }

    function reg(registry, id) {
        if (registry == null || ResourceLocation == null) return null
        try {
            return registry.getValue(new ResourceLocation(id))
        } catch (e) {
            return null
        }
    }

    var SOUND_REG    = ForgeRegistries != null ? ForgeRegistries.SOUND_EVENTS : null
    var PARTICLE_REG = ForgeRegistries != null ? ForgeRegistries.PARTICLE_TYPES : null

    // 音效
    var SND_DESTABILIZE = reg(SOUND_REG, 'draconicevolution:crystal_destabilize')
    var SND_UNSTABLE    = reg(SOUND_REG, 'draconicevolution:crystal_unstable')
    var SND_AMBIENT     = reg(SOUND_REG, 'draconicevolution:chaos_chamber_ambient')
    var SND_FUSION_BOOM = reg(SOUND_REG, 'draconicevolution:fusion_explosion')
    var SND_CHARGE      = reg(SOUND_REG, 'draconicevolution:charge')
    var SND_BOOM        = reg(SOUND_REG, 'minecraft:entity.generic.explode')
    var SND_BEACON_DEACT = reg(SOUND_REG, 'minecraft:block.beacon.deactivate')
    var SND_RESPAWN_DEP  = reg(SOUND_REG, 'minecraft:block.respawn_anchor.deplete')
    var SND_GUARDIAN_CUR = reg(SOUND_REG, 'minecraft:entity.elder_guardian.curse')
    var SND_WITHER_SPAWN = reg(SOUND_REG, 'minecraft:entity.wither.spawn')
    var SND_TOTEM_USE    = reg(SOUND_REG, 'minecraft:item.totem.use')

    var CUSTOM_SND_HW_ERROR   = 'epiphy:hardware_error'
    var CUSTOM_SND_SIREN      = 'epiphy:air_raid_siren'
    var CUSTOM_SND_ATOMIC_EXP = 'epiphy:atomic_bomb_explosion'

    var CUSTOM_SND_OBJECTS = {}
    CUSTOM_SND_OBJECTS[CUSTOM_SND_HW_ERROR]   = reg(SOUND_REG, CUSTOM_SND_HW_ERROR)
    CUSTOM_SND_OBJECTS[CUSTOM_SND_SIREN]      = reg(SOUND_REG, CUSTOM_SND_SIREN)
    CUSTOM_SND_OBJECTS[CUSTOM_SND_ATOMIC_EXP] = reg(SOUND_REG, CUSTOM_SND_ATOMIC_EXP)

    // 粒子类型
    var P_SMOKE     = reg(PARTICLE_REG, 'minecraft:large_smoke')
    var P_PORTAL    = reg(PARTICLE_REG, 'minecraft:portal')
    var P_SPARK     = reg(PARTICLE_REG, 'minecraft:electric_spark')
    var P_END_ROD   = reg(PARTICLE_REG, 'minecraft:end_rod')
    var P_EXPLOSION = reg(PARTICLE_REG, 'minecraft:explosion')
    var P_WITCH     = reg(PARTICLE_REG, 'minecraft:witch')
    var P_DRAGON    = reg(PARTICLE_REG, 'minecraft:dragon_breath')
    var P_FLASH     = reg(PARTICLE_REG, 'minecraft:flash')
    var P_SOUL_FIRE = reg(PARTICLE_REG, 'minecraft:soul_fire_flame')

    function getDimensionKey(dim, level) {
        if (level != null) {
            try {
                if (typeof level.getDimensionKey === 'function') {
                    var dk1 = level.getDimensionKey()
                    if (dk1 != null) return dk1
                }
            } catch (e0) { }
            try {
                var dk2 = level.dimensionKey
                if (dk2 != null && typeof dk2 !== 'function') return dk2
            } catch (e1) { }
        }
        try {
            if (dim === 'minecraft:overworld') return Level.OVERWORLD
            if (dim === 'minecraft:the_nether') return Level.NETHER
            if (dim === 'minecraft:the_end') return Level.END
        } catch (e2) { }
        try {
            if (level != null && typeof level.dimension === 'function') {
                return level.dimension()
            }
        } catch (e3) { }
        return null
    }

    // ------------------------------------------------------------------------
    // 保层钳制反射句柄（包含 xCoord / zCoord 距离过滤，防止多维度/多爆心互相截断）
    // ------------------------------------------------------------------------
    var F_PROCESSES = null
    var F_TRACE_X   = null
    var F_TRACE_Y   = null
    var F_TRACE_Z   = null
    var F_TRACE_PWR = null
    var TRACE_READY = false

    try {
        var phClass = rawClassOf(ProcessHandler)
        var trClass = rawClassOf(ChaosImplosionTrace)
        if (phClass != null && trClass != null) {
            F_PROCESSES = phClass.getDeclaredField('processes')
            F_PROCESSES.setAccessible(true)
            F_TRACE_Y = trClass.getDeclaredField('yCoord')
            F_TRACE_Y.setAccessible(true)
            F_TRACE_PWR = trClass.getDeclaredField('power')
            F_TRACE_PWR.setAccessible(true)
            try {
                F_TRACE_X = trClass.getDeclaredField('xCoord')
                F_TRACE_X.setAccessible(true)
                F_TRACE_Z = trClass.getDeclaredField('zCoord')
                F_TRACE_Z.setAccessible(true)
            } catch (eXZ) { }
            TRACE_READY = true
            LOGGER.info('init', '保层钳制反射初始化成功')
        }
    } catch (e) {
        LOGGER.warn('init', '保层钳制反射不可用：' + e)
    }

    // ------------------------------------------------------------------------
    // 内部状态表与跨重启原子持久化 (kubejs_epiphy_uncrafting_unstable.json)
    // ------------------------------------------------------------------------
    var UNSTABLE_STORE_FILE = 'kubejs_epiphy_uncrafting_unstable.json'
    var UNSTABLE_STORE_DIR  = 'kubejs/config/epiphy_uncrafting'
    var UNSTABLE_PDATA_KEY  = 'epiphy_uncrafting_unstable_v2'

    var watched            = {}
    var firedAt            = {}
    var unstableJobs       = []
    var layerJobs          = []
    var internalReplace    = {}  // 标记脚本自身正在替换阶段方块，避免误判为外部破坏
    var tickCounter        = 0
    var SERVER             = null
    var unstableStoreLoaded = false
    var unstableStoreDirty  = false
    var lastUnstableSaveTick = -9999
    var uncraftingTracker   = null

    var resolveLevelByDim = (dim, fallbackLevel) => (fallbackLevel != null) ? fallbackLevel : BASE.resolveLevel(dim, SERVER)

    function saveUnstableJobs(forceNow) {
        unstableStoreDirty = true
        if (!forceNow && (tickCounter - lastUnstableSaveTick) < 40) return
        if (SERVER == null) return
        lastUnstableSaveTick = tickCounter
        unstableStoreDirty   = false
        try {
            var info = BASE.resolveWorldStorageInfo(SERVER, UNSTABLE_STORE_FILE, UNSTABLE_STORE_DIR)
            var records = []
            for (var i = 0; i < unstableJobs.length; i++) {
                var j = unstableJobs[i]
                if (j == null) continue
                records.push({
                    dim:            j.dim,
                    x:              j.x,
                    y:              j.y,
                    z:              j.z,
                    t:              j.t,
                    totalTicks:     j.totalTicks,
                    stageIndex:     j.stageIndex,
                    fatalTriggered: Boolean(j.fatalTriggered)
                })
            }
            var payload = { version: 2, jobs: records }
            BASE.writeJsonAtomic(info.filePath, payload, true, LOGGER)
            if (SERVER.persistentData != null && typeof SERVER.persistentData.putString === 'function') {
                SERVER.persistentData.putString(UNSTABLE_PDATA_KEY, JSON.stringify(payload))
            }
        } catch (eSave) {
            LOGGER.catchWarn('saveUnstableJobs', eSave)
        }
    }

    function ensureUnstableJobsLoaded() {
        if (unstableStoreLoaded || SERVER == null) return
        unstableStoreLoaded = true
        try {
            var info = BASE.resolveWorldStorageInfo(SERVER, UNSTABLE_STORE_FILE, UNSTABLE_STORE_DIR)
            // 优先读取随 level.dat 同步保存的 persistentData，确保崩溃/回档后与区块存档时间戳一致；外部 JSON 仅作跨存储兜底
            var data = null
            if (SERVER.persistentData != null && typeof SERVER.persistentData.getString === 'function') {
                var rawP = SERVER.persistentData.getString(UNSTABLE_PDATA_KEY)
                if (rawP) {
                    try { data = JSON.parse(String(rawP)) } catch (eP) { data = null }
                }
            }
            if (data == null) {
                data = BASE.readJsonSafe(info.filePath, LOGGER)
            }
            var list = (data != null && Array.isArray(data.jobs)) ? data.jobs : []
            for (var i = 0; i < list.length; i++) {
                var item = list[i]
                if (item == null || !isAllowedDim(String(item.dim))) continue
                var bx = Math.floor(Number(item.x)), by = Math.floor(Number(item.y)), bz = Math.floor(Number(item.z))
                if (!isFinite(bx) || !isFinite(by) || !isFinite(bz)) continue
                if (findUnstableJob(String(item.dim), bx, by, bz) != null) continue
                unstableJobs.push({
                    level:            resolveLevelByDim(String(item.dim), null),
                    dim:              String(item.dim),
                    x:                bx,
                    y:                by,
                    z:                bz,
                    t:                Math.max(0, Math.floor(Number(item.t) || 0)),
                    spawnTick:        tickCounter,
                    restoredFromSave: true,
                    totalTicks:       Math.max(20, Math.floor(Number(item.totalTicks) || UNSTABLE_TICKS)),
                    stageIndex:       Math.max(0, Math.min(STAGE_BLOCKS.length - 1, Math.floor(Number(item.stageIndex) || 0))),
                    fatalTriggered:   Boolean(item.fatalTriggered)
                })
            }
        } catch (eLoad) {
            LOGGER.catchWarn('ensureUnstableJobsLoaded', eLoad)
        }
    }

    function dimOf(event) {
        try {
            if (event.block != null && event.block.dimension != null) {
                return String(event.block.dimension)
            }
        } catch (e) { }
        try {
            if (event.level != null && event.level.dimension != null) {
                return String(event.level.dimension)
            }
        } catch (e) { }
        return 'unknown'
    }

    function isAllowedDim(dim) {
        return ALLOWED_DIMS[dim] === true
    }

    function keyOf(dim, x, y, z) {
        return dim + '|' + x + '|' + y + '|' + z
    }

    function isStageBlockId(id) {
        return STAGE_MAP[id] != null
    }

    function findUnstableJob(dim, x, y, z) {
        for (var i = 0; i < unstableJobs.length; i++) {
            var j = unstableJobs[i]
            if (j.dim === dim && j.x === x && j.y === y && j.z === z) {
                return j
            }
        }
        return null
    }

    function removeUnstableJob(dim, x, y, z) {
        var k = keyOf(dim, x, y, z)
        delete internalReplace[k]
        for (var i = unstableJobs.length - 1; i >= 0; i--) {
            var j = unstableJobs[i]
            if (j.dim === dim && j.x === x && j.y === y && j.z === z) {
                unstableJobs.splice(i, 1)
            }
        }
    }

    // 定期清理已过期的 internalReplace 与 firedAt 坐标标记，防止服务器长期运行积累旧键
    function pruneExpiredStateMaps() {
        for (var ik in internalReplace) {
            if ((tickCounter - internalReplace[ik]) > 20) {
                delete internalReplace[ik]
            }
        }
        for (var fk in firedAt) {
            if ((tickCounter - firedAt[fk]) > 100) {
                delete firedAt[fk]
            }
        }
    }

    // 检查指定世界坐标所在的区块当前是否已在内存中加载（直接委托 EpiphyServerCore）
    var isBlockChunkLoaded = BASE.isChunkLoaded

    function setStageBlockSafely(level, dim, x, y, z, blockId) {
        var k = keyOf(dim, x, y, z)
        internalReplace[k] = tickCounter
        try {
            level.getBlock(x, y, z).set(blockId)
        } catch (e) { }
    }

    var isCreativePlayer = BASE.isCreativePlayer

    // ------------------------------------------------------------------------
    // 遗物持有检测与主手钻石镐校验（直接委托 EpiphyServerCore）
    // ------------------------------------------------------------------------
    var findPlayerRelic = (player, ids) => BASE.findPlayerItem(player, ids, { skipCreative: true })

    // 要求主手拿着钻石镐挖掘才算安全拆除
    var playerHasDiamondPickaxe = (player) => BASE.isHoldingMainHand(player, SAFE_TOOL)

    // 计算失稳核心的真实剩余倒计时秒数（兼容已登记任务与回退推算，绝不写死 0.0）
    function getRemainingSecondsText(job, fallbackStageIdx) {
        if (job != null && typeof job.totalTicks === 'number' && typeof job.t === 'number') {
            var remTicks = Math.max(0, job.totalTicks - job.t)
            return (remTicks / 20).toFixed(1)
        }
        var idx = (fallbackStageIdx != null && fallbackStageIdx >= 0 && fallbackStageIdx < STAGE_BLOCKS.length)
            ? fallbackStageIdx
            : (job != null && job.stageIndex != null ? job.stageIndex : 0)
        var estTicks = Math.max(0, UNSTABLE_TICKS - idx * STAGE_DURATION_TICKS)
        return (estTicks / 20).toFixed(1)
    }

    // ------------------------------------------------------------------------
    // 中心 2000 格区域判定（以 0, 0 为中心，半径 2000 方块以内）
    // ------------------------------------------------------------------------
    function inSafeRadius(x, z) {
        if (SAFE_SHAPE === 'square') {
            return Math.abs(x) <= SAFE_RADIUS && Math.abs(z) <= SAFE_RADIUS
        }
        return (x * x + z * z) <= (SAFE_RADIUS * SAFE_RADIUS)
    }

    function isSafeZone(dim, x, z) {
        if (!SAFE_ZONE_ENABLED) return false
        if (!isAllowedDim(dim)) return false
        return inSafeRadius(x, z)
    }

    // 范围玩家检索、音效、粒子与消息工具（直接委托 EpiphyServerCore）
    var readEntityPos     = BASE.readPos
    var forEachPlayerNear = BASE.forEachPlayerNear
    var hasPlayerNear     = BASE.hasPlayerNear
    var particleAt        = BASE.spawnParticlesSafe
    var sendActionBarNear = BASE.actionBarNear
    var sendChatNear      = (level, dim, x, y, z, radius, rawJson) => {
        if (level != null && isAllowedDim(dim) && rawJson != null) BASE.tellNear(level, x, y, z, radius, rawJson)
    }
    var sendChatLinesNear = (level, dim, x, y, z, radius, lines) => {
        if (level != null && isAllowedDim(dim) && Array.isArray(lines)) BASE.tellNear(level, x, y, z, radius, lines)
    }

    var SOUND_ID_MAP = {
        'draconicevolution:crystal_destabilize':   SND_DESTABILIZE,
        'draconicevolution:crystal_unstable':      SND_UNSTABLE,
        'draconicevolution:chaos_chamber_ambient': SND_AMBIENT,
        'draconicevolution:fusion_explosion':      SND_FUSION_BOOM,
        'draconicevolution:charge':                SND_CHARGE,
        'minecraft:entity.generic.explode':        SND_BOOM,
        'minecraft:block.beacon.deactivate':       SND_BEACON_DEACT,
        'minecraft:block.respawn_anchor.deplete':  SND_RESPAWN_DEP,
        'minecraft:entity.elder_guardian.curse':   SND_GUARDIAN_CUR,
        'minecraft:entity.wither.spawn':           SND_WITHER_SPAWN,
        'minecraft:item.totem.use':                SND_TOTEM_USE
    }

    function resolveSoundIdStr(sound) {
        if (!sound) return ''
        if (typeof sound === 'string') return sound
        try {
            if (typeof sound.getLocation === 'function') return String(sound.getLocation())
            if (sound.location != null) return String(sound.location)
        } catch (e) { }
        for (var k in SOUND_ID_MAP) {
            if (SOUND_ID_MAP[k] === sound) return k
        }
        return ''
    }

    function playAt(level, x, y, z, sound, volume, pitch, maxDist) {
        if (sound == null || level == null) return
        var limit  = maxDist != null ? maxDist : SOUND_RANGE
        var sndId  = resolveSoundIdStr(sound)
        var dimStr = BASE.dimOfLevel(level) || 'minecraft:overworld'

        if (AUDIO != null && typeof AUDIO.play === 'function' && sndId) {
            try {
                AUDIO.play({
                    sound:    sndId,
                    dim:      dimStr,
                    at:       [x + 0.5, y + 0.5, z + 0.5],
                    range:    limit,
                    volume:   volume,
                    pitch:    pitch,
                    category: 'MASTER',
                    priority: 'high'
                })
                return
            } catch (eAud) { }
        }

        forEachPlayerNear(level, x, y, z, limit, function (p, distSq) {
            var factor = Math.max(0.20, 1.0 - Math.sqrt(distSq) / (limit * 1.25))
            var vol = Math.max(0.15, Number((volume * factor).toFixed(2)))
            var pit = Math.max(0.5, Math.min(2.0, Number(pitch.toFixed(2))))
            try {
                p.playSound(sound, vol, pit)
            } catch (e) { }
        })
    }

    // 播放 kubejs/assets/epiphy/sounds.json 中定义的自定义音效（优先挂载到 EpiphyAudio 句柄，支持随时精准切断）
    function playCustomSoundAt(level, dim, x, y, z, soundId, volume, pitch, maxDist) {
        if (!soundId || level == null) return
        var limit = maxDist != null ? maxDist : SOUND_RANGE
        if (AUDIO != null && typeof AUDIO.play === 'function') {
            try {
                var keyTag = (soundId === CUSTOM_SND_SIREN)
                    ? `uncrafting_siren_${x}_${y}_${z}`
                    : ((soundId === CUSTOM_SND_HW_ERROR) ? `uncrafting_hw_${x}_${y}_${z}_${tickCounter % 8}` : '')
                var playOpts = {
                    sound:    soundId,
                    dim:      dim,
                    at:       [x + 0.5, y + 0.5, z + 0.5],
                    range:    limit,
                    volume:   volume,
                    pitch:    pitch,
                    category: 'MASTER',
                    priority: soundId === CUSTOM_SND_ATOMIC_EXP ? 'critical' : 'high'
                }
                if (keyTag) playOpts.key = keyTag
                AUDIO.play(playOpts)
                return
            } catch (eAud2) { }
        }
        var regSound = CUSTOM_SND_OBJECTS[soundId] != null ? CUSTOM_SND_OBJECTS[soundId] : reg(SOUND_REG, soundId)
        forEachPlayerNear(level, x, y, z, limit, function (p, distSq) {
            var factor = Math.max(0.25, 1.0 - Math.sqrt(distSq) / (limit * 1.3))
            var vol = Math.max(0.15, Number((volume * factor).toFixed(2)))
            var pit = Math.max(0.5, Math.min(2.0, Number(pitch.toFixed(2))))
            if (regSound != null) {
                try {
                    p.playSound(regSound, vol, pit)
                } catch (e) { }
            }
        })
    }

    // 当终望珍珠吞噬或创造模式强行终止时，立即停止周围玩家的自定义长音频
    function stopCustomSoundsNear(level, dim, x, y, z, maxDist) {
        if (AUDIO != null && typeof AUDIO.stop === 'function') {
            try {
                AUDIO.stop(`uncrafting_siren_${x}_${y}_${z}`)
                for (var hi = 0; hi < 8; hi++) {
                    AUDIO.stop(`uncrafting_hw_${x}_${y}_${z}_${hi}`)
                }
            } catch (eStop) { }
        }
        var server = SERVER || level?.server
        if (server == null || !isAllowedDim(dim)) return
        var limit = maxDist != null ? maxDist : SOUND_RANGE
        var prefix = `execute in ${dim} positioned ${x} ${y} ${z} run stopsound @a[distance=..${limit}] * `
        try {
            server.runCommandSilent(prefix + CUSTOM_SND_SIREN)
            server.runCommandSilent(prefix + CUSTOM_SND_HW_ERROR)
        } catch (e) { }
    }

    // 将原本走 `/title` 的全屏主警报全面重构并挂载到新组件 `global.ScreenDanmaku` 上
    var JSON_COLOR_MAP = {
        dark_red: '§4', red: '§c', gold: '§6', yellow: '§e',
        green: '§a', dark_green: '§2', aqua: '§b', dark_aqua: '§3',
        blue: '§9', light_purple: '§d', dark_purple: '§5',
        white: '§f', gray: '§7', dark_gray: '§8', black: '§0'
    }

    function parseJsonTextToLegacy(jsonStr) {
        if (!jsonStr) return { text: '', color: null }
        try {
            var obj = JSON.parse(jsonStr)
            var prefix = ''
            if (obj.color && JSON_COLOR_MAP[obj.color]) prefix += JSON_COLOR_MAP[obj.color]
            if (obj.bold) prefix += '§l'
            if (obj.italic) prefix += '§o'
            return { text: prefix + (obj.text || ''), color: obj.color || null }
        } catch (e) {
            return { text: String(jsonStr), color: null }
        }
    }

    function sendScreenAlert(level, dim, x, y, z, radius, titleJson, subtitleJson, fadeIn, stay, fadeOut, extraOpts) {
        if (level == null || !isAllowedDim(dim)) return
        var tInfo = parseJsonTextToLegacy(titleJson)
        var sInfo = parseJsonTextToLegacy(subtitleJson)
        if (!tInfo.text && !sInfo.text) return

        var totalStay = (stay != null ? stay : 50) + (fadeIn != null ? fadeIn : 4) + (fadeOut != null ? fadeOut : 8)
        var extra = extraOpts || {}
        sendDanmakuNear(level, x, y, z, radius, {
            namespace: DANMAKU_NAMESPACE,
            group:     extra.group || DANMAKU_GROUP,
            key:       extra.key != null ? extra.key : `main_alert_${x}_${y}_${z}`,
            priority:  extra.priority != null ? extra.priority : 'critical',
            text:      tInfo.text,
            sub:       sInfo.text,
            pos:       extra.pos || [0.47 + Math.random() * 0.06, 0.23 + Math.random() * 0.08],
            movable:   true,
            restart:   true,
            size:      extra.size || [1.28, 1.52],
            tilt:      extra.tilt != null ? extra.tilt : [-3.5, 3.5],
            color:     tInfo.color || 'red',
            subColor:  sInfo.color || 'yellow',
            mode:      extra.mode || 'all',
            charMs:    extra.charMs || 22,
            lifeMode:  'once',
            duration:  totalStay,
            shakeMode: extra.shakeMode || 'decay',
            shakeAmp:  extra.shakeAmp != null ? extra.shakeAmp : 3.2,
            fadeStyle: extra.fadeStyle || 'random',
            fadeOut:   fadeOut != null ? fadeOut : 12
        })
    }

    var PROGRESS_BAR_CACHE = []
    ;(function initProgressBarCache() {
        var total = 16
        for (var filled = 0; filled <= total; filled++) {
            var s = ''
            for (var i = 0; i < total; i++) s += (i < filled) ? '█' : '░'
            PROGRESS_BAR_CACHE[filled] = s
        }
    })()

    function makeProgressBar(progress) {
        var filled = Math.max(0, Math.min(16, Math.round(progress * 16)))
        return PROGRESS_BAR_CACHE[filled]
    }

    // ------------------------------------------------------------------------
    // 原版龙之研究混沌晶体伤害工具（调用 DEDamage.crystalMove / DEDamage.chaosImplosion）：
    //   1. DEDamage.crystalMove(level)    : 对应原版破坏/移动混沌水晶时的秒杀伤害（bypasses_invulnerability + bypasses_armor，死亡提示为 draconicevolution.crystal_move）；
    //   2. DEDamage.chaosImplosion(level) : 对应原版混沌水晶大爆炸冲击波伤害（chaotic 混沌伤害 + bypasses_armor + bypasses_cooldown，死亡提示为 draconicevolution.chaos_implosion）。
    // ------------------------------------------------------------------------
    function inflictChaosCrystalDamage(level, entity, damageType, amount) {
        if (level == null || entity == null) return false
        try {
            if (isCreativePlayer(entity) || entity.spectator) return false
        } catch (e0) { }
        try {
            if (DEDamage != null) {
                var dmgSrc = (damageType === 'crystal_move')
                    ? DEDamage.crystalMove(level)
                    : DEDamage.chaosImplosion(level)
                if (dmgSrc != null) {
                    var rawEnt = (typeof entity.self === 'function') ? entity.self() : entity
                    rawEnt.hurt(dmgSrc, Number(amount))
                    return true
                }
            }
        } catch (e1) { }
        try {
            var srv = SERVER || level.server
            var dimStr = String(level.dimension || 'minecraft:overworld')
            var ePos = readEntityPos(entity)
            if (srv != null && ePos != null) {
                var dtId = (damageType === 'crystal_move') ? 'draconicevolution:crystal_move' : 'draconicevolution:chaos_implosion'
                var targetSel = entity.username ? String(entity.username) : ('@e[x=' + ePos.x + ',y=' + ePos.y + ',z=' + ePos.z + ',distance=..1.5,limit=1]')
                srv.runCommandSilent('execute in ' + dimStr + ' run damage ' + targetSel + ' ' + Math.round(amount) + ' ' + dtId)
                return true
            }
        } catch (e2) { }
        try {
            entity.attack(Number(amount))
            return true
        } catch (e3) { }
        return false
    }

    // ------------------------------------------------------------------------
    // T+0 告警与原版混沌水晶反噬伤害逻辑（使用 draconicevolution:crystal_move / chaos_implosion）
    // ------------------------------------------------------------------------
    function executeKillAndAlarm(level, dim, x, y, z, breaker, isSafe) {
        if (level != null && isAllowedDim(dim)) {
            // 原版经典乱码报错文本（直接走 sendChatNear，无需拼接 runCommandSilent tellraw）
            sendChatNear(
                level, dim, x, y, z, MSG_RADIUS,
                '{"text":"ERROR：启动序列锟斤拷异常终止，核心锟斤拷熔断机制激活。锟斤拷日志锟斤拷溢出出出出出出锟斤拷烫烫烫烫烫烫烫烫烫烫烫烫烫烫烫烫烫","color":"gold"}'
            )

            if (isSafe) {
                sendScreenAlert(
                    level, dim, x, y, z, Math.max(MSG_RADIUS * 2, 24),
                    '{"text":"[ 无尽协议 · 强制熔断 ]","color":"red","bold":true}',
                    '{"text":"中心保护区锚点介入：已锁死终望珍珠奇点，对违规者执行抹杀","color":"gold"}',
                    5, 55, 15
                )
            } else {
                sendScreenAlert(
                    level, dim, x, y, z, SCREEN_ALERT_RADIUS,
                    '{"text":"⚠ 终极拆解台 [外壳破损] ⚠","color":"gold","bold":true}',
                    '{"text":"水晶矩阵裂解！已进入 180s 五阶段失稳序列（仅【终望珍珠】吞噬可强制停机）","color":"yellow"}',
                    5, 60, 10
                )
            }

            if (LEGACY_KILL) {
                BASE.forEachEntityNear(level, x + 0.5, y + 0.5, z + 0.5, MSG_RADIUS, (ne) => {
                    return ne != null && String(ne.type) !== 'minecraft:item'
                }, (ne) => {
                    inflictChaosCrystalDamage(level, ne, 'crystal_move', 3.4028235e38)
                })
            }
        }

        if (LEGACY_KILL && breaker != null && !isCreativePlayer(breaker)) {
            inflictChaosCrystalDamage(level, breaker, 'crystal_move', 3.4028235e38)
        }
    }

    // ------------------------------------------------------------------------
    // 需求 2：失稳期间对周围玩家施加随机原版药水效果（治疗、中毒、凋零等）
    // ------------------------------------------------------------------------
    function applyRandomInstabilityPotions(job, p) {
        if (job.level == null) return
        var stageNum = (job.stageIndex || 0) + 1

        forEachPlayerNear(job.level, job.x, job.y, job.z, POTION_RADIUS, function (player) {
            if (isCreativePlayer(player) || player.spectator) return

            // 随阶段提升，单次触发 1 ~ 2 种随机原版药水效果
            var count = (stageNum >= 4 && Math.random() < 0.5) ? 2 : 1
            for (var c = 0; c < count; c++) {
                var entry = RANDOM_VANILLA_POTIONS[Math.floor(Math.random() * RANDOM_VANILLA_POTIONS.length)]
                var amp = entry.minAmp
                if (entry.maxAmp > entry.minAmp) {
                    amp = Math.min(entry.maxAmp, Math.floor(p * (entry.maxAmp + 1)))
                }
                var dur = entry.duration > 1 ? Math.round(entry.duration * (0.85 + p * 0.65)) : entry.duration
                try {
                    player.potionEffects.add(entry.id, dur, amp, false, true)
                } catch (e) {
                    try {
                        var server = SERVER || job.level.server
                        if (server != null) {
                            var sec = Math.max(1, Math.round(dur / 20))
                            server.runCommandSilent(
                                'effect give ' + player.username + ' ' + entry.id + ' ' + sec + ' ' + amp + ' true'
                            )
                        }
                    } catch (e2) { }
                }
            }

            var pPos = readEntityPos(player)
            if (pPos != null) {
                particleAt(job.level, P_WITCH, pPos.x, pPos.y + 1.0, pPos.z, 0.4, 0.6, 0.4, 8, 0.05)
            }
        })
    }

    // ------------------------------------------------------------------------
    // 需求 3：终望珍珠吞噬检测 & 玩家界面【异常停机】错误报告
    // ------------------------------------------------------------------------
    // 检测指定坐标 (x, y, z) 是否处于终望珍珠或黑洞奇点（Gaping Void）的吞噬范围内，若是则返回触发源名称
    function findEndestSwallowSourceAt(level, x, y, z) {
        if (level == null) return null
        try {
            var r = VOID_SWALLOW_RADIUS
            var cx = x + 0.5, cy = y + 0.5, cz = z + 0.5
            var box = new AABB(cx - r, cy - r, cz - r, cx + r, cy + r, cz + r)
            var entities = level.getEntitiesWithin(box)
            for (var i = 0, len = entities.size(); i < len; i++) {
                var ent = entities.get(i)
                if (ent == null) continue
                var typeId = String(ent.type)

                // 1. 检测到终望珍珠生成的黑洞奇点实体（avaritia:gaping_void）进入吞噬范围
                if (typeId === GAPING_VOID_ENTITY && ent.getDistance(cx, cy, cz) <= VOID_SWALLOW_RADIUS) {
                    return { source: 'GAPING_VOID_SINGULARITY', entity: ent }
                }

                // 2. 检测到抛出的终望珍珠投掷物（avaritia:endest_pearl）直接命中拆解台附近
                if (typeId === ENDEST_PEARL_ENTITY && ent.getDistance(cx, cy, cz) <= 4.5) {
                    return { source: 'ENDEST_PEARL_DIRECT_IMPACT', entity: ent }
                }
            }
        } catch (e) { }
        return null
    }

    function checkEndestPearlSwallow(job) {
        if (job.level == null) return false
        var hit = findEndestSwallowSourceAt(job.level, job.x, job.y, job.z)
        if (hit != null) {
            triggerAbnormalShutdown(job, hit.source, hit.entity)
            return true
        }
        return false
    }

    // 常态终极拆解台被终望珍珠/黑洞奇点直接吞噬拆除（不进入失稳状态）
    function triggerNormalTableVoidSwallow(level, dim, x, y, z, triggerSource) {
        if (level == null) return
        delete watched[keyOf(dim, x, y, z)]
        setStageBlockSafely(level, dim, x, y, z, 'minecraft:air')

        playAt(level, x, y, z, SND_BEACON_DEACT, 5.0, 0.75, SOUND_RANGE)
        playAt(level, x, y, z, SND_RESPAWN_DEP, 4.5, 0.85, SOUND_RANGE)
        particleAt(level, P_FLASH, x + 0.5, y + 0.5, z + 0.5, 0, 0, 0, 1, 0)
        particleAt(level, P_DRAGON, x + 0.5, y + 0.5, z + 0.5, 1.2, 1.2, 1.2, 45, 0.07)
        particleAt(level, P_PORTAL, x + 0.5, y + 0.5, z + 0.5, 1.6, 1.6, 1.6, 70, 0.30)

        sendScreenAlert(
            level, dim, x, y, z, SCREEN_ALERT_RADIUS,
            '{"text":"[ 奇 点 吞 噬 // VOID SWALLOWED ]","color":"aqua","bold":true}',
            '{"text":"SYS_VOID_DISMANTLE：终望珍珠已将终极拆解台安全吞没拆除（未触发失稳序列）","color":"green"}',
            4, 55, 16,
            { shakeMode: 'decay', fadeStyle: 'shatter', size: [1.28, 1.48] }
        )
        sendActionBarNear(
            level, x, y, z, SCREEN_ALERT_RADIUS,
            '§b§l[VOID_DISMANTLE // 奇点吞噬] §a终望珍珠已将常态 §f终极拆解台 §a直接吞没拆除 §7(' + triggerSource + ')'
        )
        sendChatNear(
            level, dim, x, y, z, SCREEN_ALERT_RADIUS,
            '{"text":"[ENDEST_SWALLOW] 终望珍珠奇点已将终极拆解台 (' + x + ', ' + y + ', ' + z + ') 直接吞噬拆除，未触发混沌失稳序列。","color":"aqua"}'
        )
    }

    function triggerAbnormalShutdown(job, triggerSource, sourceEntity) {
        var level = job.level
        var dim   = job.dim
        var x     = job.x
        var y     = job.y
        var z     = job.z
        var meta  = STAGE_META[job.stageIndex || 0]
        var remainSec = getRemainingSecondsText(job, job.stageIndex)

        // 1. 移除失稳拆解台方块（被终望珍珠黑洞吞噬归零），并立即切断防空警报与全屏残留弹幕
        setStageBlockSafely(level, dim, x, y, z, 'minecraft:air')
        stopCustomSoundsNear(level, dim, x, y, z, SOUND_RANGE + 60)
        clearDanmakuNear(level, x, y, z, SCREEN_ALERT_RADIUS + 40)

        // 2. 视觉与音效反馈：虚空坍缩闪光 + 龙息/灵魂火粒子 + 信标停机音效
        playAt(level, x, y, z, SND_BEACON_DEACT, 6.0, 0.6, SOUND_RANGE)
        playAt(level, x, y, z, SND_RESPAWN_DEP, 5.0, 0.75, SOUND_RANGE)
        playAt(level, x, y, z, SND_TOTEM_USE, 4.0, 1.15, SOUND_RANGE)
        particleAt(level, P_FLASH, x + 0.5, y + 0.5, z + 0.5, 0, 0, 0, 1, 0)
        particleAt(level, P_DRAGON, x + 0.5, y + 0.5, z + 0.5, 1.5, 1.5, 1.5, 65, 0.08)
        particleAt(level, P_SOUL_FIRE, x + 0.5, y + 0.5, z + 0.5, 1.2, 1.2, 1.2, 45, 0.06)
        particleAt(level, P_PORTAL, x + 0.5, y + 0.5, z + 0.5, 2.0, 2.0, 2.0, 90, 0.35)

        // 3. 全屏大标题（逐字碎裂消散）+ 底部状态栏 + 聊天栏【异常停机】完整错误报告
        sendScreenAlert(
            level, dim, x, y, z, SCREEN_ALERT_RADIUS,
            '{"text":"[ 异 常 停 机 // ABNORMAL SHUTDOWN ]","color":"aqua","bold":true}',
            '{"text":"ERR_VOID_SWALLOWED：终望珍珠奇点已吞噬失稳核心\\n\\n混沌殉爆序列强制中断 // EXIT_CODE: 0xDEAD_VOID","color":"green"}',
            5, 90, 20,
            { shakeMode: 'decay', fadeStyle: 'shatter', size: [1.35, 1.55] }
        )

        sendActionBarNear(
            level, x, y, z, SCREEN_ALERT_RADIUS,
            '§b§l[SYSTEM_HALT // 异常停机] §a终望珍珠已吞噬 §f' + meta.name + ' §7| §e截断于倒计时 §f' + remainSec + 's §7| §aEXIT_CODE: 0xDEAD_VOID'
        )

        // 在玩家聊天界面输出结构化【异常停机】错误转储报告
        sendChatLinesNear(level, dim, x, y, z, SCREEN_ALERT_RADIUS, [
            '{"text":"====================================================","color":"dark_aqua","bold":true}',
            '{"text":"  [AVARITIA_KERNEL // 异 常 停 机 错 误 报 告]","color":"aqua","bold":true}',
            '{"text":"  STOP_CODE   : 0x0000DEAD_ENDEST_SWALLOW (奇点吞噬停机)","color":"yellow"}',
            '{"text":"  TARGET_NODE : ' + meta.id + ' (' + meta.name + ')","color":"white"}',
            '{"text":"  CORE_COORD  : (' + x + ', ' + y + ', ' + z + ') @ ' + dim + '","color":"gray"}',
            '{"text":"  INTERCEPT_AT: 剩余 ' + remainSec + ' 秒 // 捕获源: ' + triggerSource + '","color":"green"}',
            '{"text":"  DUMP_TRACE  : 水晶矩阵残骸与暴走催化剂已被【终望珍珠】事件视界彻底吞没，局部真空衰变已强制归零。锟斤拷栈追踪已挂起。","color":"gold"}',
            '{"text":"====================================================","color":"dark_aqua","bold":true}'
        ])

        console.info('[拆解台] 失稳核心已被终望珍珠吞噬停机 pos=(' + x + ',' + y + ',' + z + ') trigger=' + triggerSource)
    }

    // ------------------------------------------------------------------------
    // 遗物破拆：持有终末之环 / 七咒之戒的玩家拆除失稳阶段方块
    //   withDrop = true  → 终末之环：残骸完整回收，掉落一台终极拆解台
    //   withDrop = false → 七咒之戒：诅咒吞没残渣，无任何掉落
    // ------------------------------------------------------------------------
    function triggerRelicBreach(job, player, dim, x, y, z, withDrop, fallbackStageIdx) {
        var level = null
        if (job != null && job.level != null) {
            level = job.level
        } else if (player != null) {
            try { level = player.level } catch (e) { }
        }
        if (level == null) return

        var stageIdx = (job != null && job.stageIndex != null)
            ? job.stageIndex
            : (fallbackStageIdx != null ? fallbackStageIdx : 0)
        var meta = STAGE_META[stageIdx] || STAGE_META[0]
        var remainSec = getRemainingSecondsText(job, stageIdx)

        stopCustomSoundsNear(level, dim, x, y, z, SOUND_RANGE + 60)
        clearDanmakuNear(level, x, y, z, SCREEN_ALERT_RADIUS + 40)
        playAt(level, x, y, z, SND_BEACON_DEACT, 5.5, 1.25, SOUND_RANGE)
        particleAt(level, P_END_ROD, x + 0.5, y + 0.5, z + 0.5, 1.0, 1.0, 1.0, 50, 0.12)

        if (withDrop) {
            particleAt(level, P_FLASH, x + 0.5, y + 0.5, z + 0.5, 0, 0, 0, 1, 0)
            playAt(level, x, y, z, SND_TOTEM_USE, 4.5, 1.10, SOUND_RANGE)

            try {
                level.getBlock(x, y, z).popItem('twilightforest:uncrafting_table')
            } catch (e) {
                console.warn('[拆解台] 终末之环回收掉落失败：' + e)
            }

            sendScreenAlert(
                level, dim, x, y, z, SCREEN_ALERT_RADIUS,
                '{"text":"[ 终 末 压 制 // END SUPPRESSION ]","color":"aqua","bold":true}',
                '{"text":"SYS_ENTROPY_REVERSAL：终末神格抹平失稳核心，残骸被完整剥离回收","color":"green"}',
                4, 55, 14,
                { fadeStyle: 'char_first' }
            )
            sendChatNear(
                level, dim, x, y, z, SCREEN_ALERT_RADIUS,
                '{"text":"[HALO_OF_THE_END] 终末之环生效 —— 失稳阶段 - ' + meta.tag + ' 被强制剥离，殉爆线程已销毁；残骸已回收：终极拆解台 ×1（截断于倒计时 ' + remainSec + 's）","color":"aqua"}'
            )
        } else {
            particleAt(level, P_DRAGON, x + 0.5, y + 0.5, z + 0.5, 1.2, 1.2, 1.2, 45, 0.06)
            playAt(level, x, y, z, SND_GUARDIAN_CUR, 4.5, 1.30, SOUND_RANGE)

            sendScreenAlert(
                level, dim, x, y, z, SCREEN_ALERT_RADIUS,
                '{"text":"[ 咒 力 中 止 // CURSED HALT ]","color":"dark_purple","bold":true}',
                '{"text":"ERR_CURSE_INTERCEPT：七咒之力贯穿失稳核心，殉爆线程被强行掐断","color":"light_purple"}',
                4, 55, 16,
                { fadeStyle: 'shatter', shakeMode: 'decay' }
            )
            sendChatNear(
                level, dim, x, y, z, SCREEN_ALERT_RADIUS,
                '{"text":"[CURSED_RING] 七咒之戒生效 —— 失稳阶段 - ' + meta.tag + ' 被诅咒吞没，殉爆线程已中止；残骸连同掉落一并被拖入虚空（无掉落，截断于倒计时 ' + remainSec + 's）","color":"light_purple"}'
            )
        }
    }

    // ------------------------------------------------------------------------
    // 防破坏保护：
    //   1. 创造模式破坏 → 正常破坏并终止爆炸（[ 越 权 覆 写 // ROOT OVERRIDE ]）
    //   2. 生存模式或其他方式破坏 → 立即恢复方块、触发【致命错误】警报并在 10 秒后爆炸
    // ------------------------------------------------------------------------
    function triggerDivineTermination(job, player, fallbackLevel, fallbackDim, fallbackX, fallbackY, fallbackZ, fallbackStageIdx) {
        var level = (job != null && job.level != null) ? job.level : fallbackLevel
        var dim   = (job != null && job.dim != null) ? job.dim : fallbackDim
        var x     = (job != null && job.x != null) ? job.x : fallbackX
        var y     = (job != null && job.y != null) ? job.y : fallbackY
        var z     = (job != null && job.z != null) ? job.z : fallbackZ
        if (level == null || dim == null) return

        var stageIdx = (job != null && job.stageIndex != null)
            ? job.stageIndex
            : (fallbackStageIdx != null ? fallbackStageIdx : 0)
        var meta  = STAGE_META[stageIdx] || STAGE_META[0]
        var remainSec = getRemainingSecondsText(job, stageIdx)

        removeUnstableJob(dim, x, y, z)
        setStageBlockSafely(level, dim, x, y, z, 'minecraft:air')
        stopCustomSoundsNear(level, dim, x, y, z, SOUND_RANGE + 60)
        clearDanmakuNear(level, x, y, z, SCREEN_ALERT_RADIUS + 40)

        playAt(level, x, y, z, SND_BEACON_DEACT, 5.0, 1.35, SOUND_RANGE)
        particleAt(level, P_END_ROD, x + 0.5, y + 0.5, z + 0.5, 1.0, 1.0, 1.0, 45, 0.12)

        // 第一条（T+0）：符合错误报告风格的【越权覆写】主警报
        sendScreenAlert(
            level, dim, x, y, z, SCREEN_ALERT_RADIUS,
            '{"text":"[ 越 权 覆 写 // ROOT OVERRIDE ]","color":"aqua","bold":true}',
            '{"text":"ERR_EXTERNAL_OVERRIDE：检测到不可解析的外部强制干预，殉爆线程已被挂起","color":"green"}',
            4, 45, 10
        )
        sendActionBarNear(
            level, x, y, z, SCREEN_ALERT_RADIUS,
            '§b§l[ROOT_OVERRIDE // 越权覆写] §f' + meta.name + ' §a已被越权指令从线程中抹除 §7(0x0000ROOTP)'
        )

        // 新增第二条（延迟约 2.2 秒弹出）：因果律擦除完毕归档报告
        var server = SERVER || (level != null ? level.server : null)
        if (server != null) {
            try {
                server.scheduleInTicks(45, function () {
                    sendScreenAlert(
                        level, dim, x, y, z, SCREEN_ALERT_RADIUS,
                        '{"text":"[ 根 权 限 抹 除 // ROOT TERMINATED ]","color":"aqua","bold":true}',
                        '{"text":"SYS_CAUSALITY_RESET：无尽催化剂与终望奇点已被因果律彻底擦除（剩余 ' + remainSec + 's 线程已销毁）","color":"green"}',
                        4, 55, 15
                    )
                })
            } catch (eSched) { }
        }

        sendChatLinesNear(level, dim, x, y, z, SCREEN_ALERT_RADIUS, [
            '{"text":"====================================================","color":"dark_aqua","bold":true}',
            '{"text":"  [AVARITIA_KERNEL // 越 权 覆 写 终 止 报 告]","color":"aqua","bold":true}',
            '{"text":"  OVERRIDE_ID : 0x0000ROOTP_FORCED_PURGE","color":"aqua"}',
            '{"text":"  TARGET_NODE : ' + meta.id + ' (' + meta.name + ')","color":"white"}',
            '{"text":"  TERMINATED  : 倒计时剩余 ' + remainSec + ' 秒 // 状态码: ROOT_CAUSALITY_ERASED","color":"green"}',
            '{"text":"  CAUSE       : 外部高位权限强制介入 —— 神的力量终结了一切","color":"yellow"}',
            '{"text":"  KERNEL_NOTE : 失稳核心与混沌坍缩栈已被越权指令无条件抹除，未留残渣。","color":"gray"}',
            '{"text":"====================================================","color":"dark_aqua","bold":true}'
        ])
    }

    function triggerFatalTamperOverride(job, breaker, reason) {
        var level = job.level
        var dim   = job.dim
        var x     = job.x
        var y     = job.y
        var z     = job.z

        // 强制晋升至阶段 5 [堆芯熔毁] 并原地恢复方块，防止拆解台消失
        job.stageIndex = 4
        setStageBlockSafely(level, dim, x, y, z, STAGE_BLOCKS[4])

        // 惩罚：若非创造玩家尝试非法挖掘，予以雷击 + 原版混沌内爆伤害重创
        if (breaker != null && !isCreativePlayer(breaker)) {
            try {
                var bPos = readEntityPos(breaker)
                if (bPos != null) {
                    level.spawnLightning(bPos.x, bPos.y, bPos.z, false)
                }
                inflictChaosCrystalDamage(level, breaker, 'chaos_implosion', 50.0)
                breaker.potionEffects.add('minecraft:wither', 200, 2, false, true)
                breaker.potionEffects.add('minecraft:blindness', 80, 0, false, true)
            } catch (e) { }
        }

        // 将剩余爆炸时间强制锁定为 10 秒（200 tick）
        if (!job.fatalTriggered) {
            job.fatalTriggered = true
            job.totalTicks = FATAL_ERROR_TICKS
            job.t = 0
        } else {
            var remain = job.totalTicks - job.t
            if (remain > FATAL_ERROR_TICKS) {
                job.totalTicks = job.t + FATAL_ERROR_TICKS
            }
        }

        playAt(level, x, y, z, SND_GUARDIAN_CUR, 6.0, 0.7, SOUND_RANGE)
        playAt(level, x, y, z, SND_WITHER_SPAWN, 5.0, 0.85, SOUND_RANGE)
        playAt(level, x, y, z, SND_CHARGE, 6.0, 0.65, SOUND_RANGE)
        // 非法破坏锁死瞬间：同时奏响硬件致命错误音 + 凄厉防空警报
        playCustomSoundAt(level, dim, x, y, z, CUSTOM_SND_HW_ERROR, 2.5, 0.9, SOUND_RANGE)
        playCustomSoundAt(level, dim, x, y, z, CUSTOM_SND_SIREN, 2.8, 1.08, SOUND_RANGE + 40)
        particleAt(level, P_EXPLOSION, x + 0.5, y + 0.5, z + 0.5, 1.5, 1.5, 1.5, 10, 0.1)
        particleAt(level, P_SPARK, x + 0.5, y + 0.8, z + 0.5, 2.0, 2.0, 2.0, 45, 0.35)

        // 第一条（T+0）：符合错误报告风格的【致命错误】主警报
        sendScreenAlert(
            level, dim, x, y, z, SCREEN_ALERT_RADIUS,
            '{"text":"[ 致 命 错 误 // FATAL EXCEPTION ]","color":"dark_red","bold":true}',
            '{"text":"ERR_ILLEGAL_TAMPER：检测到非法外力破坏 (' + reason + ')，防破坏锁死已激活！","color":"red","bold":true}',
            1, 22, 6,
            { shakeMode: 'constant', shakeAmp: 4.2, fadeStyle: 'shatter', size: [1.42, 1.62] }
        )

        // 新增第二条（0.8 秒后紧接着弹出）：堆芯保护锁熔断、强制跳转最后 10 秒死刑倒计时（仅当该失稳任务尚未被终望珍珠或越权终止时触发）
        saveUnstableJobs(true)
        var server = SERVER || (level != null ? level.server : null)
        if (server != null) {
            try {
                server.scheduleInTicks(16, function () {
                    if (findUnstableJob(dim, x, y, z) == null) return
                    sendScreenAlert(
                        level, dim, x, y, z, SCREEN_ALERT_RADIUS,
                        '{"text":"[ 堆 芯 熔 毁 锁 死 // CORE LOCKDOWN ]","color":"red","bold":true}',
                        '{"text":"CRITICAL_SHORT_CIRCUIT：缓冲序列已被强制截断\\n\\n10.0 秒后执行全维度湮灭！","color":"gold","bold":true}',
                        1, 28, 8,
                        { shakeMode: 'fade_in', shakeAmp: 4.0, fadeStyle: 'shatter', size: [1.45, 1.68] }
                    )
                })
            } catch (eSched) { }
        }

        sendChatLinesNear(level, dim, x, y, z, SCREEN_ALERT_RADIUS, [
            '{"text":"====================================================","color":"dark_red","bold":true}',
            '{"text":"  [AVARITIA_KERNEL // 致 命 错 误 崩 溃 报 告]","color":"red","bold":true}',
            '{"text":"  EXCEPTION   : 0xC00000FD_TAMPER_PROTECTION_FAULT (' + reason + ')","color":"gold"}',
            '{"text":"  CORE_STATUS : 强制跃迁至 epiphy:ultra_uncrafting_instability_5 (终极拆解台 [堆芯熔毁])","color":"yellow"}',
            '{"text":"  TIME_PENALTY: 180s 缓冲保护已失效 -> 强制覆写为 10.0s 终末死刑倒计时","color":"red","bold":true}',
            '{"text":"  FATAL_STACK : 常规破坏被中子素死锁拦截！正在高速倾泻核心崩溃转储流... 锟斤拷烫烫烫","color":"dark_red"}',
            '{"text":"====================================================","color":"dark_red","bold":true}'
        ])
    }

    // ------------------------------------------------------------------------
    // 最后 10 秒（200 tick）全屏随机位置 + 正斜旋转交错 + 层层堆叠覆盖的崩溃错误弹幕流
    //   通过客户端 `epiphy:chaos_danmaku` 渲染器在屏幕各处直接绘制无背景框的倾斜/正向文本，
    //   旧的报错还没消失，新的报错就以不同角度（-22° ~ +22°）和位置一层一层往上叠加覆盖！
    // ------------------------------------------------------------------------
    var RAPID_FINAL_ERRORS = [
        {
            remain: 192,
            rawTitle: '§6§l╱╱ [ 0x00F0 // 栈 帧 撕 裂 ] ╱╱',
            rawSub:   '§eERR_STACK_UNWIND_FAIL @ 0x7FFF0004 // 异常向量表被覆写',
            rx: 0.26, ry: 0.24, angle: -13.0, scale: 1.15, stay: 85,
            chat: '{"text":"  ╱╱ [STACK_0x00F0] 异常向量表偏移 +0x18 —— 栈帧回溯断裂 (T-9.6s)","color":"gold","italic":true}'
        },
        {
            remain: 180,
            rawTitle: '§c§l[ 0x00F1 // 矩 阵 崩 解 ]',
            rawSub:   '§eERR_CRYSTAL_SHATTER：水晶矩阵晶格 100% 碎裂 (T-9.0s)',
            rx: 0.50, ry: 0.30, angle: 0.0, scale: 1.35, stay: 90,
            title: '{"text":"[ 0x00F1 // 矩 阵 崩 解 ]","color":"red","bold":true}',
            sub:   '{"text":"ERR_CRYSTAL_SHATTER：水晶矩阵晶格 100% 碎裂，约束力场归零 (T-9.0s)","color":"yellow"}',
            chat:  '{"text":"[DUMP_0x00F1] ERR_CRYSTAL_SHATTER // 水晶矩阵晶格解离 @ 0x7FFF0010 —— 约束力场: 0.00% (T-9.0s)","color":"red"}'
        },
        {
            remain: 170,
            rawTitle: '§c§o\\\\ [ 0x00F1_A // 晶 格 剥 落 ] \\\\',
            rawSub:   '§6╔══ SEGFAULT_AT_MATRIX_BUS: 0x0000DEAD ══╗',
            rx: 0.72, ry: 0.25, angle: 15.5, scale: 1.12, stay: 85,
            chat: '{"text":"\\\\ [LAYER_OVERWRITE_01] 晶格约束死锁 —— 正在覆盖上层报警栈...","color":"yellow","italic":true}'
        },
        {
            remain: 160,
            rawTitle: '§4§l[ 0x00F2 // 中 子 决 堤 ]',
            rawSub:   '§6ERR_NEUTRON_FLOOD：超重中子素突破磁流体护盾 (T-8.0s)',
            rx: 0.34, ry: 0.42, angle: 0.0, scale: 1.30, stay: 90,
            chat: '{"text":"[DUMP_0x00F2] ERR_NEUTRON_FLOOD // 中子素阻尼阀彻底蒸发 —— 核心气压: OVERFLOW (T-8.0s)","color":"gold"}'
        },
        {
            remain: 150,
            rawTitle: '§c§l»» [ 0x00F2_B // 阻 尼 蒸 发 ] ««',
            rawSub:   '§e┗━━ 0xBAD_DAMPENER // 磁流体回路短路 ━━┛',
            rx: 0.66, ry: 0.38, angle: -17.0, scale: 1.18, stay: 85,
            chat: '{"text":"      »» [LAYER_OVERWRITE_02] 阻尼回路熔穿 @ 0x7FFF0088 (T-7.5s)","color":"red","italic":true}'
        },
        {
            remain: 140,
            rawTitle: '§c§l[ 0x00F3 // 超 算 烧 穿 ]',
            rawSub:   '§eERR_AE2_65M_MELTDOWN：65M 超越存储总线熔毁 (T-7.0s)',
            rx: 0.50, ry: 0.22, angle: 0.0, scale: 1.38, stay: 90,
            title: '{"text":"[ 0x00F3 // 超 算 烧 穿 ]","color":"red","bold":true}',
            sub:   '{"text":"ERR_AE2_65M_MELTDOWN：65M 超越存储总线熔毁，内存地址全段乱码 (T-7.0s)","color":"yellow"}',
            chat:  '{"text":"[DUMP_0x00F3] ERR_AE2_65M_MELTDOWN // 65M 超算栈溢出：锟斤拷烫烫烫烫烫烫 @ 0xDEAD_BEEF (T-7.0s)","color":"yellow"}'
        },
        {
            remain: 130,
            rawTitle: '§6§l╱╱ [ 0x00F3_X // 锟 斤 拷 溢 出 ] ╱╱',
            rawSub:   '§c⟨⟨ 烫烫烫_MEM_CORRUPT // AE2_CELL_65M_DEAD ⟩⟩',
            rx: 0.25, ry: 0.58, angle: 19.0, scale: 1.16, stay: 85,
            chat: '{"text":"╱╱ [LAYER_OVERWRITE_03] 内存页表全段塌陷：0xCCCCCCCC 烫烫烫 (T-6.5s)","color":"gold","italic":true}'
        },
        {
            remain: 120,
            rawTitle: '§4§l[ 0x00F4 // 三 维 解 列 ]',
            rawSub:   '§cERR_TABLE_DESYNC：幽匿/下界/末地工作台相位撕裂 (T-6.0s)',
            rx: 0.62, ry: 0.54, angle: 0.0, scale: 1.32, stay: 85,
            chat: '{"text":"[DUMP_0x00F4] ERR_TABLE_DESYNC // 三维合成矩阵谐振失锁 —— 局部维度膜正在剥离 (T-6.0s)","color":"red"}'
        },
        {
            remain: 110,
            rawTitle: '§4§l\\\\ [ 0x00F4_C // 相 位 错 切 ] \\\\',
            rawSub:   '§6╠══ DIMENSIONAL_ANCHOR_LOST ══╣',
            rx: 0.30, ry: 0.33, angle: -21.0, scale: 1.20, stay: 80,
            chat: '{"text":"        \\\\ [LAYER_OVERWRITE_04] 空间锚脱扣 —— 坐标轴正交性丢失 (T-5.5s)","color":"dark_red","italic":true}'
        },
        {
            remain: 100,
            rawTitle: '§c§l[ 0x00F5 // 时 序 死 锁 ]',
            rawSub:   '§6ERR_CHRONOS_PARADOX：【时之核心】指针折断 (T-5.0s)',
            rx: 0.50, ry: 0.45, angle: 0.0, scale: 1.42, stay: 85,
            title: '{"text":"[ 0x00F5 // 时 序 死 锁 ]","color":"red","bold":true}',
            sub:   '{"text":"ERR_CHRONOS_PARADOX：【时之核心】指针折断，时间线回退被深渊吞没 (T-5.0s)","color":"gold"}',
            chat:  '{"text":"[DUMP_0x00F5] ERR_CHRONOS_PARADOX // 时之核心回溯线程崩溃 —— 因果律校验失败 (T-5.0s)","color":"dark_red"}'
        },
        {
            remain: 90,
            rawTitle: '§e§l«« [ 0x00F5_T // 因 果 断 裂 ] »»',
            rawSub:   '§c╱╱ CHRONOS_THREAD_DEADLOCK @ T-4.50s ╱╱',
            rx: 0.74, ry: 0.44, angle: 14.0, scale: 1.18, stay: 80,
            chat: '{"text":"«« [LAYER_OVERWRITE_05] 时间戳逆流异常 —— Δt = -∞ (T-4.5s)","color":"yellow","italic":true}'
        },
        {
            remain: 80,
            rawTitle: '§4§l[ 0x00F6 // 深 渊 暴 走 ]',
            rawSub:   '§cERR_ABYSSAL_DEVOUR：【深渊之心】逆向脉动 9999 BPM (T-4.0s)',
            rx: 0.38, ry: 0.62, angle: 0.0, scale: 1.35, stay: 80,
            chat: '{"text":"[DUMP_0x00F6] ERR_ABYSSAL_DEVOUR // 深渊之心心率 9999 BPM —— 虚空侵蚀不可逆转 (T-4.0s)","color":"red","bold":true}'
        },
        {
            remain: 70,
            rawTitle: '§5§l╱╱ [ 0x00F6_V // 熵 值 归 零 ] ╱╱',
            rawSub:   '§d\\\\ ABYSSAL_PULSE_OVERDRIVE: 9999 BPM \\\\',
            rx: 0.68, ry: 0.28, angle: -18.5, scale: 1.24, stay: 75,
            chat: '{"text":"      ╱╱ [LAYER_OVERWRITE_06] 深渊脉动覆盖主屏幕缓冲区 (T-3.5s)","color":"light_purple","italic":true}'
        },
        {
            remain: 60,
            rawTitle: '§c§l[ 0x00F7 // 视 界 坍 缩 ]',
            rawSub:   '§eERR_HORIZON_COLLAPSE：内部终望珍珠突破史瓦西半径 (T-3.0s)',
            rx: 0.50, ry: 0.36, angle: 0.0, scale: 1.48, stay: 75,
            title: '{"text":"[ 0x00F7 // 视 界 坍 缩 ]","color":"red","bold":true}',
            sub:   '{"text":"ERR_HORIZON_COLLAPSE：内部终望珍珠突破史瓦西半径，奇点裸露 (T-3.0s)","color":"yellow"}',
            chat:  '{"text":"[DUMP_0x00F7] ERR_HORIZON_COLLAPSE // 引力曲率 -> ∞ —— 事件视界正在极速合拢 (T-3.0s)","color":"dark_red","bold":true}'
        },
        {
            remain: 50,
            rawTitle: '§6§l\\\\ [ 0x00F7_S // 奇 点 裸 露 ] \\\\',
            rawSub:   '§c⟨⟨ SCHWARZSCHILD_BREACH // EVENT_HORIZON_LOCK ⟩⟩',
            rx: 0.28, ry: 0.48, angle: 22.0, scale: 1.28, stay: 70,
            chat: '{"text":"\\\\ [LAYER_OVERWRITE_07] 史瓦西半径突破阈值 —— 逃逸速度 > c (T-2.5s)","color":"gold","bold":true,"italic":true}'
        },
        {
            remain: 40,
            rawTitle: '§4§l[ 0x00F8 // 催 化 点 燃 ]',
            rawSub:   '§cERR_CATALYST_IGNITE：四组【无尽催化剂】链式聚变 (T-2.0s)',
            rx: 0.60, ry: 0.64, angle: 0.0, scale: 1.45, stay: 70,
            chat: '{"text":"[DUMP_0x00F8] ERR_CATALYST_IGNITE // 无尽催化剂裂变率 99999.9% —— 烫烫烫烫烫烫 (T-2.0s)","color":"red","bold":true}'
        },
        {
            remain: 32,
            rawTitle: '§c§l╱╱ [ 0x00F8_F // 链 式 聚 变 ] ╱╱',
            rawSub:   '§e╔══ TEMP_OVERFLOW: ∞ K // 锟斤拷烫烫烫 ══╗',
            rx: 0.35, ry: 0.25, angle: -16.0, scale: 1.32, stay: 65,
            chat: '{"text":"        ╱╱ [LAYER_OVERWRITE_08] 热力学上限崩溃 —— 正在烧穿维度基底 (T-1.6s)","color":"red","bold":true,"italic":true}'
        },
        {
            remain: 24,
            rawTitle: '§f§l[ 0x00F9 // 内 核 恐 慌 ]',
            rawSub:   '§cKERNEL_PANIC_0xDEAD：正在载入 300m 物质抹除进程 (T-1.2s)',
            rx: 0.50, ry: 0.52, angle: 0.0, scale: 1.55, stay: 65,
            title: '{"text":"[ 0x00F9 // 内 核 恐 慌 ]","color":"white","bold":true}',
            sub:   '{"text":"KERNEL_PANIC_0xDEAD：所有安全协议已蒸发，正在载入 300m 物质抹除进程 (T-1.2s)","color":"red","bold":true}',
            chat:  '{"text":"[DUMP_0x00F9] KERNEL_PANIC // SYSTEM_HALT_FAILED —— 现实擦除缓冲区已满，准备释放冲击波 (T-1.2s)","color":"dark_red","bold":true}'
        },
        {
            remain: 18,
            rawTitle: '§c§l\\\\ [ 0x00FA // 缓 冲 击 穿 ] \\\\',
            rawSub:   '§6┗━━ FATAL_BUFFER_OVERRUN: 0xFFFFFFFF ━━┛',
            rx: 0.70, ry: 0.36, angle: 19.5, scale: 1.36, stay: 55,
            chat: '{"text":"\\\\ [LAYER_OVERWRITE_09] 0x00FA 栈顶击穿 —— 现实擦除倒计时 T-0.9s","color":"red","bold":true,"italic":true}'
        },
        {
            remain: 13,
            rawTitle: '§e§l╱╱ [ 0x00FE // 奇 点 失 控 ] ╱╱',
            rawSub:   '§4»» REALITY_WIPE_COMMIT: TRUE ««',
            rx: 0.30, ry: 0.56, angle: -22.5, scale: 1.40, stay: 50,
            chat: '{"text":"          ╱╱ [LAYER_OVERWRITE_10] 0x00FE 奇点栓锁蒸发 (T-0.65s)","color":"yellow","bold":true}'
        },
        {
            remain: 8,
            rawTitle: '§4§l!! [ 0x00FF // 零 点 引 爆 ] !!',
            rawSub:   '§eFATAL_ZERO_POINT：锟斤拷烫烫烫——奇点释放——烫烫烫锟斤拷',
            rx: 0.50, ry: 0.40, angle: 0.0, scale: 1.70, stay: 48,
            title: '{"text":"!! [ 0x00FF // 零 点 引 爆 ] !!","color":"dark_red","bold":true}',
            sub:   '{"text":"FATAL_ZERO_POINT：锟斤拷烫烫烫——终极拆解台 [堆芯熔毁] 奇点释放——烫烫烫锟斤拷","color":"yellow","bold":true}',
            chat:  '{"text":"[DUMP_0x00FF] FATAL_ZERO_POINT // 0xFFFFFFFF —— 奇点引爆指令已提交！(T-0.4s)","color":"dark_red","bold":true}'
        },
        {
            remain: 4,
            rawTitle: '§f§l╱╱\\\\ [ 0xFFFF // 现 实 抹 除 ] \\\\╱╱',
            rawSub:   '§c████████ 0xDEAD_VOID // INCOMING_300M_ANNIHILATION ████████',
            rx: 0.50, ry: 0.48, angle: -8.0, scale: 1.85, stay: 45,
            chat: '{"text":"[0xFFFF_FINAL_COMMIT] ████████ 现实抹除波前已释放 ████████","color":"white","bold":true}'
        }
    ]

    var RAPID_FINAL_ERROR_MAP = {}
    for (var rfeIdx = 0; rfeIdx < RAPID_FINAL_ERRORS.length; rfeIdx++) {
        RAPID_FINAL_ERROR_MAP[RAPID_FINAL_ERRORS[rfeIdx].remain] = RAPID_FINAL_ERRORS[rfeIdx]
    }

    // 最后 10 秒高频散射叠层碎片池（去除硬编码颜色码，由渲染时动态注入随机配色与来源模块）
    var RAPID_SCATTER_SHARDS = [
        { title: '[SEGFAULT // 0xDEAD_BEEF]',      sub: 'core_dump: 锟斤拷烫烫烫' },
        { title: '╱╱ MATRIX_BUS_COLLAPSE ╱╱',      sub: '0x7FFF0010 -> NULL_PTR' },
        { title: '\\\\ NEUTRON_CONTAINMENT_LOST',  sub: 'PRESSURE: ∞ MPa // 阻尼击穿' },
        { title: '╔═ AE2_65M_STACK_OVERFLOW ═╗',   sub: '0xCCCCCCCC 内存页全段塌陷' },
        { title: '»» ABYSSAL_HEART_9999BPM ««',    sub: 'ENTROPY_DRAIN // 现实熵归零' },
        { title: '[CHRONOS_THREAD_DEADLOCK]',      sub: 'Δt = -∞ // 因果律校验失败' },
        { title: '┗━ SCHWARZSCHILD_BREACH ━┛',     sub: 'EVENT_HORIZON_EXPOSED // 奇点' },
        { title: '!! KERNEL_PANIC_0xFFFFFFFF !!',  sub: 'REALITY_WIPE_300M_READY' },
        { title: '⟨⟨ BOTANIA_MANA_BACKFLOW ⟩⟩',    sub: '活木根导管爆裂 // 魔力逆流 +999%' },
        { title: '╠═ TWILIGHT_UNCRAFT_FAULT ═╣',   sub: '逆向合成拓扑环死锁 @ 0x004F' },
        { title: '╱╱ CURSED_RING_RESONANCE ╱╱',    sub: '七咒因果偏移 // 灵魂锚点松脱' },
        { title: '\\\\ DRACONIC_CONTAINMENT_ERR',  sub: '混沌力场护盾瓦解 // 能量泄漏' },
        { title: '[QUANTUM_BRIDGE_DISCONNECT]',    sub: 'ME 量子环跨维同步丢失 (0xBAD_CH)' },
        { title: '╔═ SINGULARITY_GRAVITY_SPIKE ═╗', sub: '局部重力加速度突破 10^9 g' }
    ]

    // 随机报错来源子系统池（打破单一固定报错来源）
    var ERROR_ORIGIN_TAGS = [
        'AVARITIA_BIOS',
        'AE2_65M_CELL',
        'CHRONOS_CORE',
        'ABYSSAL_PUMP',
        'NEUTRON_VALVE',
        'MATRIX_LATTICE',
        'TWILIGHT_BUS',
        'DRACONIC_FIELD',
        'CURSE_DAEMON',
        'VOID_HORIZON',
        'MANA_CONDUIT',
        'REALITY_ANCHOR'
    ]

    // 随机色彩搭配池（打破单一红黄固定配色，涵盖赤红、琥珀金、幽紫、青蓝、翠绿、惨白、品红、深红等）
    var GLITCH_COLOR_PALETTES = [
        { titleCode: '§c§l', subCode: '§e', color: 0xFF5555, subColor: 0xFFFF55 },
        { titleCode: '§6§l', subCode: '§f', color: 0xFFAA00, subColor: 0xFFFFFF },
        { titleCode: '§d§l', subCode: '§5', color: 0xFF55FF, subColor: 0xAA00AA },
        { titleCode: '§b§l', subCode: '§3', color: 0x55FFFF, subColor: 0x00AAAA },
        { titleCode: '§a§l', subCode: '§2', color: 0x55FF55, subColor: 0x00AA00 },
        { titleCode: '§4§l', subCode: '§c', color: 0xCC0000, subColor: 0xFF5555 },
        { titleCode: '§e§l', subCode: '§7', color: 0xFFFF55, subColor: 0xAAAAAA },
        { titleCode: '§f§l', subCode: '§b', color: 0xFFFFFF, subColor: 0x55FFFF },
        { titleCode: '§5§l', subCode: '§d', color: 0xAA00AA, subColor: 0xFF55FF },
        { titleCode: '§3§l', subCode: '§a', color: 0x00AAAA, subColor: 0x55FF55 }
    ]

    function pickRandomOriginTag() {
        return ERROR_ORIGIN_TAGS[Math.floor(Math.random() * ERROR_ORIGIN_TAGS.length)]
    }

    function pickRandomPalette() {
        return GLITCH_COLOR_PALETTES[Math.floor(Math.random() * GLITCH_COLOR_PALETTES.length)]
    }

    // 统一挂载到新版 global.ScreenDanmaku v5（支持独立 namespace 隔离、持续激活 HUD 遥测面板、逐字碎片崩解与优先级保护）
    var DANMAKU_NAMESPACE = 'uncrafting_chaos'
    var DANMAKU_GROUP     = 'uncrafting_chaos'
    var TELEMETRY_GROUP   = 'uncrafting_telemetry'
    var spreadCellCursor  = 0

    // HUD 禁区检测：仅避让右上角小地图（rx > 0.68 且 ry < 0.36）与底部玩家快捷栏/生命饥饿盔甲栏（rx 在 0.25~0.75 且 ry > 0.80），其余全屏区域完全开放！
    function isInHudForbiddenZone(rx, ry) {
        if (rx > 0.68 && ry < 0.36) return true
        if (ry > 0.80 && rx > 0.24 && rx < 0.76) return true
        return false
    }

    // 全屏自由随机位置采样（不再局限于四条窄边！除右上角小地图、底部装备快捷栏与正中心准星极小圆外，全屏中区、次中心、四角与边缘均可随机生成）
    function randomFreeScreenPos(avoidCrosshair) {
        for (var attempt = 0; attempt < 12; attempt++) {
            var rx = 0.08 + Math.random() * 0.84
            var ry = 0.08 + Math.random() * 0.76
            if (isInHudForbiddenZone(rx, ry)) continue
            // 仅避开准星正中心极小区域（半径 ~0.07），允许在中区内侧各处自由弹出
            if (avoidCrosshair && Math.abs(rx - 0.50) < 0.07 && Math.abs(ry - 0.50) < 0.07) continue
            return [Number(rx.toFixed(3)), Number(ry.toFixed(3))]
        }
        return [Number((0.12 + Math.random() * 0.52).toFixed(3)), Number((0.12 + Math.random() * 0.64).toFixed(3))]
    }

    // 崩溃弹幕流全屏 4×3 广域网格 + 自由随机混合打散（彻底消除扎堆在屏幕中央的现象，铺满全屏每一个非 HUD 角落）
    var WIDE_GRID_CELLS = [0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11] // 4列×3行（排除右上角小地图格 cell=3）
    function randomSafeSpreadPos() {
        if (Math.random() < 0.45) {
            return randomFreeScreenPos(false)
        }
        spreadCellCursor = (spreadCellCursor + 1 + Math.floor(Math.random() * 4)) % WIDE_GRID_CELLS.length
        var cell = WIDE_GRID_CELLS[spreadCellCursor]
        var col = cell % 4             // 0, 1, 2, 3
        var row = Math.floor(cell / 4) // 0, 1, 2
        var rx = 0.07 + col * 0.22 + Math.random() * 0.20
        var ry = 0.08 + row * 0.25 + Math.random() * 0.23
        if (isInHudForbiddenZone(rx, ry)) {
            ry = 0.38 + Math.random() * 0.38
        }
        return [Number(rx.toFixed(3)), Number(ry.toFixed(3))]
    }

    // 生成连续丰富的随机倾角（涵盖端正 0°、微倾 ±1°~8°、中度倾斜 ±9°~20°、大倾角 ±21°~34°）
    function randomDiverseTilt() {
        var r = Math.random()
        if (r < 0.22) return 0.0
        if (r < 0.45) return Number(((Math.random() - 0.5) * 14.0).toFixed(1))
        var sign = Math.random() < 0.5 ? -1 : 1
        return Number((sign * (8.0 + Math.random() * 26.0)).toFixed(1))
    }

    function sendDanmakuNear(level, x, y, z, radius, opts) {
        opts = opts || {}
        if (!opts.namespace) opts.namespace = DANMAKU_NAMESPACE
        if (!opts.group) opts.group = DANMAKU_GROUP
        // 全局防线：若显式传入的坐标意外落入 HUD 禁区（小地图/底部快捷栏），自动移至安全区
        if (Array.isArray(opts.pos) && opts.pos.length >= 2 && isInHudForbiddenZone(opts.pos[0], opts.pos[1])) {
            opts.pos = [opts.pos[0], 0.43 + Math.random() * 0.35]
        }
        DANMAKU.inDimension(level, x, y, z, radius, opts)
    }

    function deactivateTelemetryNear(level, x, y, z, radius, slotId, fadeOutTicks) {
        DANMAKU.deactivateNear(level, x, y, z, radius, {
            namespace: DANMAKU_NAMESPACE,
            group:     TELEMETRY_GROUP,
            id:        slotId || '',
            fadeOut:   fadeOutTicks || 16
        })
    }

    function clearDanmakuNear(level, x, y, z, radius, maxPriority) {
        DANMAKU.clearNear(level, x, y, z, radius, {
            namespace:   DANMAKU_NAMESPACE,
            group:       '*',
            maxPriority: maxPriority != null ? maxPriority : 10
        })
    }

    function triggerRapidFinalErrorStream(job, remainTicks) {
        if (remainTicks <= 0 || remainTicks > FATAL_ERROR_TICKS) return

        // 0. 左上角【终末 10 秒死刑遥测面板】（持续激活模式 lifeMode: 'active'，始终稳定静止不震动，每 4 tick 原地刷新）
        if (remainTicks % 4 === 0) {
            var pFinal   = Math.max(0, Math.min(1.0, 1.0 - (remainTicks / FATAL_ERROR_TICKS)))
            var barFinal = makeProgressBar(pFinal)
            var lockTag  = job.fatalTriggered ? '§4§l[防破坏锁死 · 死刑序列]' : '§c§l[堆芯熔毁 · 终末倒计时]'
            sendDanmakuNear(job.level, job.x, job.y, job.z, SCREEN_ALERT_RADIUS, {
                group:      TELEMETRY_GROUP,
                id:         'core_telemetry_' + job.x + '_' + job.y + '_' + job.z,
                lifeMode:   'active',
                activeHold: 14,
                priority:   'active',
                text:       lockTag + ' §fT-' + (remainTicks / 20).toFixed(1) + 's',
                sub:        '§c' + barFinal + ' §e' + Math.round(pFinal * 100) + '%\n§7坐标 (' + job.x + ', ' + job.y + ', ' + job.z + ') // 奇点释放临界',
                pos:        [0.19, 0.12],
                size:       0.78,
                tilt:       0,
                shakeMode:  'none',
                shakeAmp:   0.0,
                fadeStyle:  'shatter',
                fadeOut:    14
            })
        }

        // 1. 固定时间节点的主干错误层：全屏广域打散 + 随机色彩与来源 + 40% 概率静止不震动（确保有静有动、层次分明）
        var item = RAPID_FINAL_ERROR_MAP[remainTicks]
        if (item != null) {
            var useSpread = (remainTicks > 8)
            var mainPos   = useSpread ? randomSafeSpreadPos() : [0.35 + Math.random() * 0.30, 0.25 + Math.random() * 0.35]
            var mainTilt  = randomDiverseTilt()
            var mainScale = useSpread ? Number((0.68 + Math.random() * 1.05).toFixed(2)) : Number((1.35 + Math.random() * 0.55).toFixed(2))
            var mainShakePool = ['none', 'none', 'decay', 'fade_in', 'pulse', 'constant']
            var mainShake = (remainTicks <= 16) ? 'constant' : mainShakePool[Math.floor(Math.random() * mainShakePool.length)]
            var mainFade  = (remainTicks <= 32) ? 'shatter' : 'random'
            var mainPal   = pickRandomPalette()
            var originTag = pickRandomOriginTag()
            var cleanTitle = String(item.rawTitle || '').replace(/§[0-9a-fk-or]/gi, '')
            var cleanSub   = String(item.rawSub || '').replace(/§[0-9a-fk-or]/gi, '')

            sendDanmakuNear(job.level, job.x, job.y, job.z, SCREEN_ALERT_RADIUS, {
                priority:  remainTicks <= 24 ? 'critical' : 'high',
                text:      mainPal.titleCode + cleanTitle,
                sub:       mainPal.subCode + '[' + originTag + '] ' + cleanSub,
                pos:       mainPos,
                tilt:      mainTilt,
                scale:     mainScale,
                color:     mainPal.color,
                subColor:  mainPal.subColor,
                duration:  item.stay || 75,
                shakeMode: mainShake,
                shakeAmp:  mainShake === 'none' ? 0.0 : (1.5 + Math.random() * 2.2),
                fadeStyle: mainFade,
                fadeOut:   14
            })
            // 聊天框中的错误转储报告保持原样输出，不做任何改动
            sendChatNear(job.level, job.dim, job.x, job.y, job.z, SCREEN_ALERT_RADIUS, item.chat)
            var errPitch = 0.85 + (1.0 - remainTicks / 200.0) * 0.65
            playCustomSoundAt(job.level, job.dim, job.x, job.y, job.z, CUSTOM_SND_HW_ERROR, 2.2, errPitch, SOUND_RANGE)
            playAt(job.level, job.x, job.y, job.z, SND_UNSTABLE, 5.0, 1.35 + (1.0 - remainTicks / 200.0) * 0.65, SOUND_RANGE)
        }

        // 2. 高密度全屏随机散射弹幕流：每 1~2 tick 并发喷射 1~3 条大小悬殊（0.48x 极小字 ~ 1.75x 巨型字）、色彩各异、来源随机、含 45% 静止不震动的错误碎片，铺满全屏！
        var scatterInterval = remainTicks > 140 ? 2 : 1
        if (remainTicks % scatterInterval === 0) {
            var burstCount = remainTicks > 120 ? 1 : (remainTicks > 45 ? (Math.random() < 0.55 ? 2 : 1) : (Math.random() < 0.65 ? 2 : 3))
            var shakePool  = ['none', 'none', 'none', 'decay', 'fade_in', 'pulse', 'constant']
            for (var bIdx = 0; bIdx < burstCount; bIdx++) {
                var shard     = RAPID_SCATTER_SHARDS[Math.floor(Math.random() * RAPID_SCATTER_SHARDS.length)]
                var pal       = pickRandomPalette()
                var origin    = pickRandomOriginTag()
                var shardMode = (Math.random() < 0.42) ? 'char' : 'all'
                // 字号大跨度随机分布：既有 0.48~0.75 的细密底层报错，也有 0.85~1.30 的中层报错，还有 1.35~1.78 的巨型砸屏警告
                var sizeRoll  = Math.random()
                var randScale = sizeRoll < 0.45
                    ? Number((0.48 + Math.random() * 0.30).toFixed(2))
                    : (sizeRoll < 0.82 ? Number((0.80 + Math.random() * 0.48).toFixed(2)) : Number((1.30 + Math.random() * 0.48).toFixed(2)))
                var sShake    = shakePool[Math.floor(Math.random() * shakePool.length)]

                sendDanmakuNear(job.level, job.x, job.y, job.z, SCREEN_ALERT_RADIUS, {
                    priority:  'low',
                    text:      pal.titleCode + '<' + origin + '> ' + shard.title,
                    sub:       pal.subCode + shard.sub + ' (T-' + (remainTicks / 20).toFixed(1) + 's)',
                    pos:       randomSafeSpreadPos(),
                    tilt:      randomDiverseTilt(),
                    scale:     randScale,
                    color:     pal.color,
                    subColor:  pal.subColor,
                    mode:      shardMode,
                    charMs:    10 + Math.floor(Math.random() * 14),
                    duration:  Math.min(remainTicks + 14, 36 + Math.floor(Math.random() * 40)),
                    shakeMode: sShake,
                    shakeAmp:  sShake === 'none' ? 0.0 : Number((1.2 + Math.random() * 2.4).toFixed(2)),
                    fadeStyle: 'random',
                    fadeOut:   12
                })
            }
        }
    }

    // ------------------------------------------------------------------------
    // 基岩保层钳制
    // ------------------------------------------------------------------------
    function cost(n) {
        return n > 0 ? (0.5 * n + 0.05 * n * (n - 1)) : 0
    }

    function planGuard(dim, level, x, y, z) {
        var base = { bottomY: null, topY: null, t: 0, level: level, dim: dim, x: x, y: y, z: z }
        if (!LAYER_GUARD_ENABLED) return base
        if (dim === 'minecraft:the_nether') {
            base.bottomY = GUARD_BOTTOM_Y_NETHER
            base.topY = GUARD_TOP_FROM_Y
        } else if (dim === 'minecraft:the_end') {
            base.bottomY = GUARD_BOTTOM_Y_END
        }
        return base
    }

    function clampTraces(job) {
        if (!TRACE_READY || F_PROCESSES == null) return
        var list
        try {
            list = F_PROCESSES.get(null)
        } catch (e) {
            return
        }
        if (list == null) return
        var maxRangeSq = (DE_POWER * 10 + 32) * (DE_POWER * 10 + 32)
        var size = list.size()
        for (var i = 0; i < size; i++) {
            var o
            try {
                o = list.get(i)
            } catch (e) {
                continue
            }
            if (o == null || !(o instanceof ChaosImplosionTrace)) continue

            // 仅钳制当前爆心半径范围内的 Trace，防止多爆心或不同维度同时爆炸时互相截断
            if (F_TRACE_X != null && F_TRACE_Z != null) {
                try {
                    var tx = F_TRACE_X.getInt(o) - job.x
                    var tz = F_TRACE_Z.getInt(o) - job.z
                    if (tx * tx + tz * tz > maxRangeSq) continue
                } catch (eCoord) { }
            }

            var y0, f
            try {
                y0 = F_TRACE_Y.getInt(o)
                f = F_TRACE_PWR.getFloat(o)
            } catch (e) {
                continue
            }

            var limit = f
            if (job.bottomY != null) {
                var nDown = y0 - job.bottomY
                var capDown = nDown > 0 ? (cost(nDown) - 0.05) / 10 : 0
                if (capDown < limit) limit = capDown
            }
            if (job.topY != null) {
                var nUp = job.topY - 1 - y0
                var capUp = nUp > 0 ? (cost(nUp) - 0.05) / 20 : 0
                if (capUp < limit) limit = capUp
            }
            if (limit < f) {
                try {
                    F_TRACE_PWR.setFloat(o, limit)
                } catch (e) { }
            }
        }
    }

    // ------------------------------------------------------------------------
    // 阶段 A：初始小爆炸 + 180 秒（3600 tick）五阶段方块替换与药水辐射
    // ------------------------------------------------------------------------
    function beginUnstable(level, dim, x, y, z, initialStageIdx, sourceTag) {
        if (!isAllowedDim(dim)) return

        var existing = findUnstableJob(dim, x, y, z)
        if (existing != null) return

        var startStage = initialStageIdx != null ? initialStageIdx : 0
        if (startStage < 0) startStage = 0
        if (startStage >= STAGE_BLOCKS.length) startStage = STAGE_BLOCKS.length - 1

        // 1. 触发一次不破坏中心方块的小爆炸冲击（防止把刚放下的失稳阶段方块炸飞）
        if (INITIAL_SMALL_EXPLOSION) {
            try {
                level.createExplosion(x + 0.5, y + 0.5, z + 0.5)
                    .strength(SMALL_EXPLOSION_POWER)
                    .causesFire(true)
                    .explosionMode(ExplosionInteraction.NONE)
                    .explode()
            } catch (e) { }
            particleAt(level, P_EXPLOSION, x + 0.5, y + 0.5, z + 0.5, 1.5, 1.5, 1.5, 12, 0.1)
            particleAt(level, P_SPARK, x + 0.5, y + 0.8, z + 0.5, 2.0, 2.0, 2.0, 35, 0.3)
        }

        // 2. 将坐标位置替换为对应的失稳阶段方块（默认阶段 1：终极拆解台 [外壳破损]）
        //    注意：若由 BlockEvents.broken 同步触发，原版会在事件返回后执行 removeBlock 将该坐标置为空气！
        //    因此在下一 tick 额外补一次方块写入，并给予 5 tick 的生成保护窗口，彻底防止刚进入阶段 1 就被巡检误判为“遭外力破坏”而直接跳到阶段 5！
        setStageBlockSafely(level, dim, x, y, z, STAGE_BLOCKS[startStage])
        var srv = SERVER || (level != null ? level.server : null)
        if (SERVER == null && srv != null) SERVER = srv
        if (srv != null) {
            try {
                srv.scheduleInTicks(1, function () {
                    if (findUnstableJob(dim, x, y, z) != null) {
                        setStageBlockSafely(level, dim, x, y, z, STAGE_BLOCKS[startStage])
                    }
                })
            } catch (eSched0) { }
        }

        var startTicks = startStage * STAGE_DURATION_TICKS
        var remainSec = ((UNSTABLE_TICKS - startTicks) / 20).toFixed(1)
        var meta = STAGE_META[startStage]

        playAt(level, x, y, z, SND_DESTABILIZE, 6.0, 0.9, SOUND_RANGE)
        // 初始进入失稳：播放一次硬件故障告警音；若创造模式直接放置阶段 3~5，则同步拉响防空警报
        playCustomSoundAt(level, dim, x, y, z, CUSTOM_SND_HW_ERROR, 2.0, 0.95, SOUND_RANGE)
        if (startStage >= 2) {
            playCustomSoundAt(level, dim, x, y, z, CUSTOM_SND_SIREN, 2.5, 0.92 + (startStage - 2) * 0.08, SOUND_RANGE + 40)
        }
        sendChatNear(
            level, dim, x, y, z, SCREEN_ALERT_RADIUS,
            '{"text":"[AVARITIA_BIOS] ' + (sourceTag || '拆解台外壳破损') + ' —— 当前阶段 - ' + meta.tag + '（第 ' + (startStage + 1) + '/5 阶段），预计 ' + remainSec + ' 秒后彻底熔毁引爆！唯一停机方式：投掷【终望珍珠】吞噬核心！","color":"gold"}'
        )

        unstableJobs.push({
            level: level,
            dim: dim,
            x: x,
            y: y,
            z: z,
            t: startTicks,
            spawnTick: tickCounter,
            totalTicks: UNSTABLE_TICKS,
            stageIndex: startStage,
            fatalTriggered: false
        })
        saveUnstableJobs(true)
    }

    function onStageTransition(job, newStageIdx) {
        job.stageIndex = newStageIdx
        saveUnstableJobs(true)
        var meta = STAGE_META[newStageIdx]
        var remainSec = Math.round((job.totalTicks - job.t) / 20)

        // 替换方块为新阶段方块（材质变红加深，发光等级提升）
        setStageBlockSafely(job.level, job.dim, job.x, job.y, job.z, meta.id)

        playAt(job.level, job.x, job.y, job.z, SND_DESTABILIZE, 6.0, 0.75 + newStageIdx * 0.12, SOUND_RANGE)
        // 每次阶段跃迁触发硬件错误音；进入阶段 3（超算过载）、阶段 4（奇点暴走）、阶段 5（堆芯熔毁）时拉响防空警报
        playCustomSoundAt(job.level, job.dim, job.x, job.y, job.z, CUSTOM_SND_HW_ERROR, 2.2, 0.85 + newStageIdx * 0.1, SOUND_RANGE)
        if (newStageIdx >= 2) {
            playCustomSoundAt(job.level, job.dim, job.x, job.y, job.z, CUSTOM_SND_SIREN, 2.6, 0.92 + (newStageIdx - 2) * 0.08, SOUND_RANGE + 40)
        }
        particleAt(job.level, P_EXPLOSION, job.x + 0.5, job.y + 0.5, job.z + 0.5, 1.0, 1.0, 1.0, 6, 0.08)
        particleAt(job.level, P_SPARK, job.x + 0.5, job.y + 0.8, job.z + 0.5, 1.6, 1.6, 1.6, 28, 0.3)

        if (meta.alertBody != null) {
            var isFinal = (newStageIdx === 4)
            if (isFinal) {
                playAt(job.level, job.x, job.y, job.z, SND_CHARGE, 6.0, 0.8, SOUND_RANGE)
            }
            var stageLabel = '阶段 ' + (newStageIdx + 1) + '/5 · ' + meta.name
            var titleText = isFinal ? ('!! [ ' + stageLabel + ' ] !!') : ('[ ' + stageLabel + ' ]')
            var subText = meta.alertBody + (isFinal ? (' —— 最后 ' + remainSec + ' 秒！') : (' —— 剩余 ' + remainSec + ' 秒'))
            var subBold = isFinal ? ',"bold":true' : ''
            var chatText = isFinal
                ? ('[STAGE_5 // 堆芯熔毁] 警告：已至最终阶段 - ' + meta.tag + '！除非立即投掷【终望珍珠】将其吞噬，否则 ' + remainSec + ' 秒后将释放 300 格物质湮灭！')
                : (meta.chatBody + '(剩余 ' + remainSec + ' 秒)')

            sendScreenAlert(
                job.level, job.dim, job.x, job.y, job.z, SCREEN_ALERT_RADIUS,
                '{"text":"' + titleText + '","color":"' + meta.alertColor + '","bold":true}',
                '{"text":"' + subText + '","color":"' + meta.subColor + '"' + subBold + '}',
                isFinal ? 3 : (newStageIdx === 3 ? 4 : 5),
                isFinal ? 60 : 50,
                isFinal ? 16 : 12,
                {
                    shakeMode: isFinal ? 'constant' : (newStageIdx >= 3 ? 'fade_in' : 'decay'),
                    shakeAmp:  2.5 + newStageIdx * 0.5,
                    fadeStyle: isFinal ? 'shatter' : 'random',
                    size:      isFinal ? [1.42, 1.65] : [1.25, 1.50]
                }
            )
            sendChatNear(
                job.level, job.dim, job.x, job.y, job.z, SCREEN_ALERT_RADIUS,
                '{"text":"' + chatText + '","color":"' + meta.chatColor + '"' + subBold + '}'
            )
        }
    }

    function shakePlayersNear(level, x, y, z, progress) {
        var maxDist = 110
        var intensity = 0.2 + progress * 0.85
        forEachPlayerNear(level, x, y, z, maxDist, function (p, distSq) {
            var atten = 1.0 - Math.sqrt(distSq) / maxDist
            var amp = intensity * atten * 0.26
            try {
                p.setMotionX(p.motionX + (Math.random() - 0.5) * amp)
                p.setMotionZ(p.motionZ + (Math.random() - 0.5) * amp)
            } catch (e) { }
        })
    }

    // ------------------------------------------------------------------------
    // 需求 3（新增）：进度条推进期间，时不时在主弹幕之外的位置（右上角 Toast / 副标题侧边 / 聊天框）插入小错误报告
    // ------------------------------------------------------------------------
    var MINOR_UNSTABLE_GLITCHES = [
        {
            code: 'WARN_0x01A4 // 晶格微裂',
            detail: '检测到水晶矩阵 #04 扇区应力超载 (+184%)',
            subJson: '{"text":"         ╱╱ [WARN_0x01A4] 晶格扇区 #04 应力超载 ╱╱","color":"yellow","italic":true}',
            chatJson: '{"text":"  [DIAG_0x01A4] 警告：水晶矩阵第 4 象限出现微米级裂纹，局部能量开始逸散。","color":"yellow"}'
        },
        {
            code: 'ERR_0x02B8 // 阻尼渗漏',
            detail: '超重中子素冷却回路压降 -32.6 MPa',
            subJson: '{"text":"\\\\ [ERR_0x02B8] 中子素阻尼冷却液正在渗漏 \\\\         ","color":"gold","italic":true}',
            chatJson: '{"text":"  [DIAG_0x02B8] 错误：磁流体密封圈老化，微量超重中子正在向大气游离。","color":"gold"}'
        },
        {
            code: 'ERR_0x03C1 // 扇区坏道',
            detail: '65M 超算存储簇 0x7F008910 校验和失效',
            subJson: '{"text":"            »» [ERR_0x03C1] 65M 存储簇 CRC 校验失败 ««","color":"gold","italic":true}',
            chatJson: '{"text":"  [DIAG_0x03C1] 错误：65M 超越存储单元发生位翻转，逆向合成表索引损坏：锟斤拷。","color":"yellow"}'
        },
        {
            code: 'WARN_0x04D9 // 时钟漂移',
            detail: '【时之核心】石英基准偏离 +412.8 ms',
            subJson: '{"text":"  ╔═ [WARN_0x04D9] 时之核心局部时钟源发生相位漂移 ═╗        ","color":"red","italic":true}',
            chatJson: '{"text":"  [DIAG_0x04D9] 警告：时之核心未能对齐世界线基准，局部因果延迟正在累积。","color":"gold"}'
        },
        {
            code: 'ERR_0x05E2 // 熵增倒灌',
            detail: '【深渊之心】泵压异常，负熵流逆向冲击',
            subJson: '{"text":"          \\\\ [ERR_0x05E2] 深渊之心负熵泵发生逆流 \\\\","color":"light_purple","italic":true}',
            chatJson: '{"text":"  [DIAG_0x05E2] 错误：深渊之心脉动失步，周围空间背景辐射上升 400%。","color":"light_purple"}'
        },
        {
            code: 'ERR_0x06F7 // 视界震颤',
            detail: '内部终望珍珠奇点引力波包泄漏',
            subJson: '{"text":"╱╱ [ERR_0x06F7] 终望奇点引力约束环出现谐振 ╱╱          ","color":"red","italic":true}',
            chatJson: '{"text":"  [DIAG_0x06F7] 错误：内部终望珍珠引力势阱震荡，唯有外部【终望珍珠】同频吞噬可平息！","color":"red"}'
        },
        {
            code: 'ERR_0x07A0 // 催化预热',
            detail: '无尽催化剂簇核心温度突破 1.2×10^7 K',
            subJson: '{"text":"              ┗━ [ERR_0x07A0] 无尽催化剂反应截面异常放大 ━┛","color":"red","italic":true}',
            chatJson: '{"text":"  [DIAG_0x07A0] 警报：无尽催化剂进入自持反应临界区，堆芯温度正在指数级攀升！","color":"red"}'
        },
        {
            code: 'FAULT_0x08FF // 句柄悬空',
            detail: '玛玉灵框架锚点 #11 发生热解离 (烫烫烫)',
            subJson: '{"text":"    ⟨⟨ [FAULT_0x08FF] 玛玉灵结构锚点 #11 热解离 ⟩⟩      ","color":"gold","italic":true}',
            chatJson: '{"text":"  [DIAG_0x08FF] 故障：玛玉灵合金骨架软化，拆解台外壳支撑力下降至危险阈值。","color":"gold"}'
        }
    ]

    function triggerMinorUnstableGlitch(job, p, remainTicks) {
        // 避免与阶段切换当帧（t % 720 === 0）撞车
        if ((job.t % STAGE_DURATION_TICKS) < 20 || (job.t % STAGE_DURATION_TICKS) > (STAGE_DURATION_TICKS - 20)) return

        // 随阶段升高，错误弹出频率加快：阶段1每 85 tick(4.2s) -> 阶段5每 24 tick(1.2s)
        var stageIdx = job.stageIndex || 0
        var interval = Math.max(24, 85 - stageIdx * 15)
        if (job.t % interval !== 0) return

        var step = Math.floor(job.t / interval)
        var remainSec = (remainTicks / 20).toFixed(1)

        // 1. 全屏自由随机位置 + 多样化随机配色 + 随机来源模块 + 高比例不震动（'none' 占约 50%），阶段后期可一次并发弹出 1~2 条
        var count = (stageIdx >= 3 && Math.random() < 0.45) ? 2 : 1
        var shakeChoices = stageIdx <= 1
            ? ['none', 'none', 'none', 'decay', 'fade_in']
            : ['none', 'none', 'decay', 'fade_in', 'pulse', 'constant']

        for (var c = 0; c < count; c++) {
            var gIdx        = Math.floor(Math.random() * MINOR_UNSTABLE_GLITCHES.length)
            var glitch      = MINOR_UNSTABLE_GLITCHES[gIdx]
            var pal         = pickRandomPalette()
            var originTag   = pickRandomOriginTag()
            var chosenShake = shakeChoices[Math.floor(Math.random() * shakeChoices.length)]
            var randScale   = Number((0.52 + Math.random() * 0.66).toFixed(2))
            var genMode     = Math.random() < 0.65 ? 'char' : 'all'

            sendDanmakuNear(job.level, job.x, job.y, job.z, SCREEN_ALERT_RADIUS, {
                priority:  'low',
                text:      pal.titleCode + '[' + originTag + ' // ' + glitch.code + '] §7(T-' + remainSec + 's)',
                sub:       pal.subCode + glitch.detail,
                pos:       randomFreeScreenPos(true),
                scale:     randScale,
                tilt:      randomDiverseTilt(),
                color:     pal.color,
                subColor:  pal.subColor,
                mode:      genMode,
                charMs:    16 + Math.floor(Math.random() * 20),
                duration:  55 + Math.floor(Math.random() * 40),
                shakeMode: chosenShake,
                shakeAmp:  chosenShake === 'none' ? 0.0 : Number((1.2 + Math.random() * 1.8).toFixed(2)),
                fadeStyle: 'random',
                fadeOut:   14
            })

            if (c === 0 && step % 2 === 0) {
                sendChatNear(job.level, job.dim, job.x, job.y, job.z, SCREEN_ALERT_RADIUS, glitch.chatJson)
            }
        }

        // 2. 伴随小错误报告同步播放自定义硬件故障告警音（epiphy:hardware_error）
        playCustomSoundAt(job.level, job.dim, job.x, job.y, job.z, CUSTOM_SND_HW_ERROR, 1.5, 0.88 + Math.random() * 0.28, SOUND_RANGE)
    }

    function updateUnstableScreenPrompts(job, p) {
        var remainTicks = Math.max(0, job.totalTicks - job.t)
        var remainSec = (remainTicks / 20).toFixed(1)
        var pct = Math.min(100, Math.round(p * 100))
        var stageIdx = job.stageIndex || 0
        var meta = STAGE_META[stageIdx]

        // 当剩余时间 <= 10 秒（200 tick）时（含【致命错误触发后的 10 秒】与【正常三分钟计时的最后 10 秒】），
        // 调用快速略过的崩溃错误报告流
        if (remainTicks <= FATAL_ERROR_TICKS) {
            // 正常倒计时刚进入最后 10 秒（remainTicks === 200）时，先弹出终末 10 秒警报并奏响高亢防空警报
            if (!job.fatalTriggered && remainTicks === FATAL_ERROR_TICKS) {
                playCustomSoundAt(job.level, job.dim, job.x, job.y, job.z, CUSTOM_SND_SIREN, 2.8, 1.15, SOUND_RANGE + 50)
                sendScreenAlert(
                    job.level, job.dim, job.x, job.y, job.z, SCREEN_ALERT_RADIUS,
                    '{"text":"[ 终 末 崩 溃 // FINAL 10 SECONDS ]","color":"dark_red","bold":true}',
                    '{"text":"CRITICAL_MELTDOWN_10S：堆芯约束彻底瓦解\\n\\n正在高速倾泻崩溃错误流！","color":"red","bold":true}',
                    0, 22, 8,
                    { shakeMode: 'constant', shakeAmp: 4.0, fadeStyle: 'shatter', size: [1.45, 1.68] }
                )
                sendChatNear(
                    job.level, job.dim, job.x, job.y, job.z, SCREEN_ALERT_RADIUS,
                    '{"text":"[CRITICAL_10S] 警告：已进入最后 10.0 秒终末崩溃期，核心错误栈正在高速溢出！","color":"dark_red","bold":true}'
                )
            }
            triggerRapidFinalErrorStream(job, remainTicks)
            return
        }

        // 每 8 tick 刷新一次左上角持续激活【堆芯失稳遥测面板】HUD（lifeMode: 'active'，全程静止不震动，已移除旧版物品栏上方 ActionBar 进度条）
        if (job.t % 8 === 0) {
            var bar = makeProgressBar(p)
            sendDanmakuNear(job.level, job.x, job.y, job.z, SCREEN_ALERT_RADIUS, {
                group:      TELEMETRY_GROUP,
                id:         'core_telemetry_' + job.x + '_' + job.y + '_' + job.z,
                lifeMode:   'active',
                activeHold: 22,
                priority:   'active',
                text:       meta.colorCode + '§l[堆芯遥测 · 阶段 ' + (stageIdx + 1) + '/5 ' + meta.tag + '] §fT-' + remainSec + 's',
                sub:        meta.colorCode + bar + ' §f' + pct + '%\n§7核心 (' + job.x + ', ' + job.y + ', ' + job.z + ') §8| §e投掷【终望珍珠】可吞噬停机',
                pos:        [0.19, 0.12],
                size:       0.75,
                tilt:       0,
                shakeMode:  'none',
                shakeAmp:   0.0,
                fadeStyle:  'char_last',
                fadeOut:    14
            })
        }

        // 在主进度条运行期间，时不时在屏幕安全边缘带与聊天栏插入小型故障子报
        triggerMinorUnstableGlitch(job, p, remainTicks)
    }

    function tickUnstable() {
        for (var n = unstableJobs.length - 1; n >= 0; n--) {
            var job = unstableJobs[n]
            if (job == null) {
                unstableJobs.splice(n, 1)
                continue
            }
            if (job.level == null) {
                job.level = resolveLevelByDim(job.dim, null)
                if (job.level == null) continue
            }

            // 1. 优先检测是否被【终望珍珠 / 黑洞奇点】吞噬：若触发则立即生成【异常停机】报告并终止爆炸
            if (checkEndestPearlSwallow(job)) {
                unstableJobs.splice(n, 1)
                saveUnstableJobs(true)
                continue
            }

            // 1b. 存档恢复任务首次对账（防止崩溃/回档导致 JSON 阶段与世界区块方块不同步而误触发防篡改致命引爆）
            if (job.restoredFromSave) {
                if (!isBlockChunkLoaded(job.level, job.x, job.z)) {
                    continue
                }
                var restoredBlkId = job.level.getBlock(job.x, job.y, job.z).id
                if (isStageBlockId(restoredBlkId)) {
                    var worldStage = STAGE_MAP[restoredBlkId]
                    var stageDiff = (job.stageIndex !== worldStage)
                    job.stageIndex = worldStage
                    var minTickForStage = worldStage * STAGE_DURATION_TICKS
                    var maxTickForStage = (worldStage + 1) * STAGE_DURATION_TICKS - 1
                    if (!job.fatalTriggered && (job.t < minTickForStage || job.t > maxTickForStage)) {
                        job.t = minTickForStage
                        stageDiff = true
                    }
                    internalReplace[keyOf(job.dim, job.x, job.y, job.z)] = tickCounter
                    job.spawnTick = tickCounter
                    job.restoredFromSave = false
                    if (stageDiff) saveUnstableJobs(true)
                } else if (restoredBlkId === 'twilightforest:uncrafting_table') {
                    setStageBlockSafely(job.level, job.dim, job.x, job.y, job.z, STAGE_BLOCKS[job.stageIndex])
                    job.spawnTick = tickCounter
                    job.restoredFromSave = false
                    saveUnstableJobs(true)
                } else {
                    // 世界区块已回档至放置前或被离线清理，安全丢弃孤儿任务而非误爆
                    unstableJobs.splice(n, 1)
                    saveUnstableJobs(true)
                    continue
                }
            }

            job.t++
            unstableStoreDirty = true
            var p = Math.min(1.0, job.t / job.totalTicks)

            // 2. 在 3 分钟正常失稳流程中，按时间推进阶段（0~36s, 36~72s, 72~108s, 108~144s, 144~180s）并替换方块
            if (!job.fatalTriggered) {
                var expectedStage = Math.min(STAGE_BLOCKS.length - 1, Math.floor(job.t / STAGE_DURATION_TICKS))
                if (expectedStage > job.stageIndex) {
                    onStageTransition(job, expectedStage)
                }
            }

            // 3. 防外力破坏巡检：仅在区块已加载且周围有玩家时复核方块状态（防止视距边界区块卸载误判为外力破坏）
            if ((job.spawnTick == null || (tickCounter - job.spawnTick) > 5)
                && isBlockChunkLoaded(job.level, job.x, job.z)
                && hasPlayerNear(job.level, job.x, job.y, job.z, NEAR_DISTANCE)) {
                var currentId = job.level.getBlock(job.x, job.y, job.z).id
                var expectedId = STAGE_BLOCKS[job.stageIndex]
                if (currentId !== expectedId) {
                    var k = keyOf(job.dim, job.x, job.y, job.z)
                    var lastInternal = internalReplace[k]
                    if (lastInternal == null || (tickCounter - lastInternal) > 5) {
                        // 清理周围可能被活塞推走的阶段方块副本
                        for (var dx = -PURGE_RADIUS; dx <= PURGE_RADIUS; dx++) {
                            for (var dy = -1; dy <= 1; dy++) {
                                for (var dz = -PURGE_RADIUS; dz <= PURGE_RADIUS; dz++) {
                                    if (dx === 0 && dy === 0 && dz === 0) continue
                                    var nb = job.level.getBlock(job.x + dx, job.y + dy, job.z + dz)
                                    if (isStageBlockId(nb.id)) {
                                        nb.set('minecraft:air')
                                    }
                                }
                            }
                        }
                        triggerFatalTamperOverride(job, null, 'EXTERNAL_BLOCK_DISRUPTION')
                    }
                }
            }

            // 4. 穿插屏幕提示与动态倒计时
            updateUnstableScreenPrompts(job, p)

            // 5. 周期性对周围玩家施加随机原版药水效果（瞬间治疗、中毒、凋零、失明、反胃等）
            var dynPotionInterval = job.fatalTriggered ? 25 : Math.max(25, Math.round(POTION_INTERVAL * (1.0 - p * 0.45)))
            if (job.t % dynPotionInterval === 0) {
                applyRandomInstabilityPotions(job, p)
            }

            // 6. 混沌水晶失稳报警音与环境音
            var dynSoundInterval = (job.fatalTriggered || p > 0.8) ? 4 : (p > 0.5 ? 7 : SOUND_INTERVAL)
            if (job.t % dynSoundInterval === 0) {
                playAt(job.level, job.x, job.y, job.z, SND_UNSTABLE, 2.0 + p * 4.0, 0.55 + p * 0.95, SOUND_RANGE)
            }
            if (job.t % 20 === 0) {
                playAt(job.level, job.x, job.y, job.z, SND_AMBIENT, 2.0 + p * 3.0, 0.6 + p * 0.45, SOUND_RANGE)
            }

            // 7. 能量坍缩粒子环 + 电弧闪烁
            if (job.t % PARTICLE_INTERVAL === 0) {
                for (var kIdx = 0; kIdx < 3; kIdx++) {
                    var a = Math.random() * Math.PI * 2
                    var r = (1.0 - p * 0.5) * (3.5 + Math.random() * 6.5)
                    var px = job.x + 0.5 + Math.cos(a) * r
                    var py = job.y + 0.5 + (Math.random() - 0.5) * 4.0
                    var pz = job.z + 0.5 + Math.sin(a) * r
                    particleAt(job.level, P_SMOKE, px, py, pz, 0.35, 0.8, 0.35, 4, 0.02)
                    particleAt(job.level, P_PORTAL, px, py + 0.5, pz, 0.5, 0.9, 0.5, 8, 0.25)
                    particleAt(job.level, P_END_ROD, job.x + 0.5, job.y + 0.5, job.z + 0.5, 0.5 + p * 1.8, 0.5 + p * 1.8, 0.5 + p * 1.8, 3, 0.08)
                }
                if (job.t % 12 === 0) {
                    particleAt(job.level, P_SPARK, job.x + 0.5, job.y + 1.0, job.z + 0.5, 1.2 + p, 1.2 + p, 1.2 + p, 12, 0.25)
                }
            }

            // 8. 随机闪电效果
            var lightningInterval = (job.fatalTriggered || p > 0.6) ? 15 : 30
            if (job.t % lightningInterval === 0) {
                try {
                    var spread = 8 + p * 16
                    var lx = job.x + (Math.random() - 0.5) * spread
                    var lz = job.z + (Math.random() - 0.5) * spread
                    job.level.spawnLightning(lx, job.y, lz, true)
                } catch (e) { }
            }

            // 9. 震屏冲击感（使用 ExplosionInteraction.NONE 保证不破坏核心阶段方块）
            if (SHAKE_ENABLED && job.t % SHAKE_INTERVAL === 0) {
                shakePlayersNear(job.level, job.x, job.y, job.z, p)
                if (job.t % (SHAKE_INTERVAL * 2) === 0) {
                    var ox = (Math.random() - 0.5) * 3.0
                    var oy = Math.random() * 1.5
                    var oz = (Math.random() - 0.5) * 3.0
                    try {
                        job.level.createExplosion(job.x + 0.5 + ox, job.y + 0.5 + oy, job.z + 0.5 + oz)
                            .strength(1.6)
                            .causesFire(false)
                            .explosionMode(ExplosionInteraction.NONE)
                            .explode()
                    } catch (e) { }
                    particleAt(job.level, P_EXPLOSION, job.x + 0.5 + ox, job.y + 0.5 + oy, job.z + 0.5 + oz, 0, 0, 0, 1, 0)
                }
            }

            // 10. 倒计时归零：移除阶段方块并启动 DE 300 格混沌大爆炸
            if (job.t >= job.totalTicks) {
                unstableJobs.splice(n, 1)
                saveUnstableJobs(true)
                setStageBlockSafely(job.level, job.dim, job.x, job.y, job.z, 'minecraft:air')
                launchImplosion(job.level, job.dim, job.x, job.y, job.z)
            }
        }
    }

    // ------------------------------------------------------------------------
    // 阶段 B：调用龙之研究原生爆炸特效包 + ProcessChaosImplosion 混沌湮灭
    // ------------------------------------------------------------------------
    function launchImplosion(level, dim, x, y, z) {
        if (!isAllowedDim(dim)) return

        var guard = planGuard(dim, level, x, y, z)
        if (guard != null) layerJobs.push(guard)

        console.info('[拆解台] 混沌殉爆启动 core=(' + x + ',' + y + ',' + z + ') dim=' + dim + ' traceGuard=' + TRACE_READY)

        // 1. 零点引爆瞬间：先清空屏幕上的旧倒计时崩溃弹幕并切断防空警报，再发送全新的【无尽混沌殉爆】主警报（修复旧版先发警报后被 clearDanmakuNear 立即误删的 Bug）
        clearDanmakuNear(level, x, y, z, FX_PACKET_RANGE + 100)
        stopCustomSoundsNear(level, dim, x, y, z, FX_PACKET_RANGE + 100)
        playCustomSoundAt(level, dim, x, y, z, CUSTOM_SND_ATOMIC_EXP, 4.0, 1.0, FX_PACKET_RANGE + 80)

        sendScreenAlert(
            level, dim, x, y, z, FX_PACKET_RANGE + 50,
            '{"text":"【 无 尽 混 沌 殉 爆 】","color":"white","bold":true}',
            '{"text":"FATAL_INFINITY_IMPLOSION // 终极拆解台 [堆芯熔毁] 已引爆\\n\\n半径 300 格物质抹除序列启动！","color":"red","bold":true}',
            2, 65, 18,
            { shakeMode: 'decay', shakeAmp: 5.0, fadeStyle: 'shatter', size: [1.55, 1.80] }
        )
        sendChatNear(
            level, dim, x, y, z, FX_PACKET_RANGE + 50,
            '{"text":"[ANNIHILATION_START] 混沌冲击波已释放！物质湮灭进度：0% (半径 0m / 300m)","color":"dark_red","bold":true}'
        )

        try {
            var dimKey = getDimensionKey(dim, level)
            if (dimKey != null) {
                DraconicNetwork.sendExplosionEffect(dimKey, new BlockPos(x, y, z), FX_PACKET_RANGE, true)
                console.info('[拆解台] 已发送 DE 原生爆炸特效包 radius=' + FX_PACKET_RANGE)
            } else {
                playAt(level, x, y, z, SND_FUSION_BOOM, 10.0, 0.9, 350)
            }
        } catch (e) {
            playAt(level, x, y, z, SND_FUSION_BOOM, 10.0, 0.9, 350)
        }

        // 爆炸触发瞬间：对核心区（半径 64 格）内的玩家与实体立即施加首波高额原版混沌内爆伤害（DEDamage.chaosImplosion）
        forEachPlayerNear(level, x, y, z, 64, function (p, distSq) {
            var d = Math.sqrt(distSq)
            var dmg = Math.max(200.0, 5000.0 * (1.0 - d / 70.0))
            inflictChaosCrystalDamage(level, p, 'chaos_implosion', dmg)
        })

        // 爆炸触发瞬间：先把「半径 + 14」球体内的水与岩浆通过 Section 调色板极速剥离
        startLiquidPurge(level, dim, x, y, z, FX_PACKET_RANGE)

        try {
            ProcessHandler.addProcess(new ProcessChaosImplosion(level, x, y, z))
        } catch (e) {
            console.error('[拆解台] ProcessChaosImplosion 启动失败：' + e)
            if (guard != null) layerJobs.pop()
        }
    }

    // ------------------------------------------------------------------------
    // 触发入口（区分 2000 格内秒杀免爆 与 2000 格外三分钟五阶段失稳）
    // ------------------------------------------------------------------------
    function handleIllegalBreak(level, dim, x, y, z, breaker) {
        if (!isAllowedDim(dim)) return

        var key = keyOf(dim, x, y, z)
        if (firedAt[key] != null && (tickCounter - firedAt[key]) < 40) return
        firedAt[key] = tickCounter

        var safe = isSafeZone(dim, x, z)

        executeKillAndAlarm(level, dim, x, y, z, breaker, safe)

        if (safe) {
            console.info('[拆解台] 位于 (0,0) 半径 ' + SAFE_RADIUS + ' 格内 (' + x + ',' + y + ',' + z + ')，已触发秒杀，跳过爆炸')
            return
        }

        // 半径 2000 方块以外：生成阶段 1 方块 `epiphy:ultra_uncrafting_instability_1`，开启 180 秒五阶段演进
        beginUnstable(level, dim, x, y, z, 0, '检测到终极拆解台被破坏')
    }

    // ------------------------------------------------------------------------
    // 事件监听 1：原版终极拆解台（twilightforest:uncrafting_table）放置与破坏
    // ------------------------------------------------------------------------
    BlockEvents.placed(TARGET_ID, function (event) {
        var dim = dimOf(event)
        var bx = event.block.x
        var by = event.block.y
        var bz = event.block.z

        if (!isAllowedDim(dim)) {
            var player = event.player
            if (player != null) {
                try {
                    player.statusMessage = '§c[神圣世界线之外的区域] 终极拆解台无法正常工作 —— 仅可在主世界、下界或末地放置！'
                    player.sendInventoryUpdate()
                    sendChatNear(
                        event.level, dim, bx, by, bz, 32,
                        '{"text":"[OFF_WORLDLINE] 神圣世界线之外的区域，终极拆解台无法正常工作 —— 该维度无法承载内部的中子素奇点，已退回物品栏。","color":"red"}'
                    )
                } catch (e) { }
            }
            event.cancel()
            return
        }

        var key = keyOf(dim, bx, by, bz)
        delete firedAt[key]
        watched[key] = { x: bx, y: by, z: bz, dim: dim, level: event.level }
    })

    BlockEvents.broken(TARGET_ID, function (event) {
        var dim = dimOf(event)
        var bx = event.block.x
        var by = event.block.y
        var bz = event.block.z

        delete watched[keyOf(dim, bx, by, bz)]

        if (!isAllowedDim(dim)) return

        // 若常态终极拆解台是被终望珍珠或黑洞奇点（Gaping Void）吞噬破坏，直接安全拆除，绝不进入失稳状态
        var swallowHit = findEndestSwallowSourceAt(event.level, bx, by, bz)
        if (swallowHit != null) {
            triggerNormalTableVoidSwallow(event.level, dim, bx, by, bz, swallowHit.source)
            return
        }

        var player = event.player
        if (player != null) {
            // 持有钻石镐时（手持或背包持有），直接安全拆除，不进行遗物检测
            if (playerHasDiamondPickaxe(player)) return

            // 创造模式下遗物检测不生效；仅在非创造模式下按 终末之环 → 寰宇支配之剑 → 晋升之环 → 七咒之戒 优先级检测
            if (!isCreativePlayer(player)) {
                var relic = findPlayerRelic(player, DIVINE_RELICS)
                if (relic != null) {
                    sendChatNear(
                        event.level, dim, bx, by, bz, SCREEN_ALERT_RADIUS,
                        '{"text":"[DIVINE_RELIC] 检测到持有 ' + RELIC_LABELS[relic] + '，至高遗物的位格压制了拆解台奇点 —— 本次拆除已按正常流程执行。","color":"aqua"}'
                    )
                    return
                }
            }
        }

        // 取消原版后续的 removeBlock（防止原版在事件返回后把刚生成的阶段 1 方块重新抹成空气而触发阶段 5 防破坏锁死）
        try { event.cancel() } catch (eCancel) { }
        // 若位于 (0,0) 安全区内，方块被保留在原地（仅执行秒杀不替换为失稳阶段方块），必须恢复 watched 监控记录以防后续被活塞/爆炸无视
        if (isSafeZone(dim, bx, bz)) {
            watched[keyOf(dim, bx, by, bz)] = { x: bx, y: by, z: bz, dim: dim, level: event.level }
        }
        handleIllegalBreak(event.level, dim, bx, by, bz, player)
    })

    // 支持手持终望珍珠对着常态终极拆解台右击（或潜行右击）直接吞噬拆除，不进入不稳定状态
    BlockEvents.rightClicked(TARGET_ID, function (event) {
        var player = event.player
        if (player == null) return
        var item = event.item
        if (item == null || item.id !== ENDEST_PEARL_ITEM) return

        var dim = dimOf(event)
        if (!isAllowedDim(dim)) return
        var bx = event.block.x
        var by = event.block.y
        var bz = event.block.z

        if (!isCreativePlayer(player)) {
            item.count--
        }
        triggerNormalTableVoidSwallow(event.level, dim, bx, by, bz, 'ENDEST_PEARL_DIRECT_USE')
        event.cancel()
    })

    // ------------------------------------------------------------------------
    // 事件监听 2：5 个失稳阶段方块（epiphy:ultra_uncrafting_instability_1~5）
    //   - 创造模式放置：直接进入对应阶段的失稳爆炸流程
    //   - 创造模式破坏：正常破坏并终止爆炸（[神的力量终结了一切]）
    //   - 生存模式/其他方式破坏：取消破坏、触发【致命错误】警报并在 10 秒后强制引爆
    //   - 手持终望珍珠右击：支持直接用终望珍珠右击吞噬停机（同时支持投掷出黑洞奇点吞噬）
    // ------------------------------------------------------------------------
    for (var idx = 0; idx < STAGE_BLOCKS.length; idx++) {
        ;(function (stageIndex, stageId) {
            BlockEvents.placed(stageId, function (event) {
                var dim = dimOf(event)
                var bx = event.block.x
                var by = event.block.y
                var bz = event.block.z
                var k = keyOf(dim, bx, by, bz)

                // 若是脚本内部自动替换阶段触发的假放置，直接忽略
                if (internalReplace[k] != null && (tickCounter - internalReplace[k]) <= 2) {
                    return
                }

                if (!isAllowedDim(dim)) {
                    var p = event.player
                    if (p != null) {
                        try {
                            p.statusMessage = '§c[神圣世界线之外的区域] 终极拆解台无法正常工作 —— 仅可在主世界、下界或末地激活！'
                            p.sendInventoryUpdate()
                            sendChatNear(
                                event.level, dim, bx, by, bz, 32,
                                '{"text":"[OFF_WORLDLINE] 神圣世界线之外的区域，终极拆解台无法正常工作 —— 失稳核心在该维度无法维持，已强制停止充能。","color":"red"}'
                            )
                        } catch (e) { }
                    }
                    event.cancel()
                    return
                }

                // 在创造模式（或任何方式）手动放置失稳方块时，直接进入失稳爆炸流程
                beginUnstable(event.level, dim, bx, by, bz, stageIndex, '检测到创造模式直接放置失稳核心')
            })

            BlockEvents.broken(stageId, function (event) {
                var dim = dimOf(event)
                var bx = event.block.x
                var by = event.block.y
                var bz = event.block.z
                var player = event.player
                var job = findUnstableJob(dim, bx, by, bz)

                // 创造模式破坏：正常破坏（神的力量终结了一切）
                if (isCreativePlayer(player)) {
                    triggerDivineTermination(job, player, event.level, dim, bx, by, bz, stageIndex)
                    return
                }

                // 持有终末之环 → 允许拆除并掉落新的终极拆解台；持有七咒之戒 → 允许拆除但无掉落
                if (player != null) {
                    var breachRelic = findPlayerRelic(player, [RELIC_HALO_OF_END, RELIC_CURSED_RING])
                    if (breachRelic != null) {
                        try { event.cancel() } catch (e) { }
                        removeUnstableJob(dim, bx, by, bz)
                        setStageBlockSafely(event.level, dim, bx, by, bz, 'minecraft:air')
                        triggerRelicBreach(job, player, dim, bx, by, bz, breachRelic === RELIC_HALO_OF_END, stageIndex)
                        return
                    }
                }

                // 生存模式或非创造破坏：拒绝破坏，立刻触发致命错误警报并在 10 秒后爆炸
                try {
                    event.cancel()
                } catch (e) { }

                if (job == null) {
                    beginUnstable(event.level, dim, bx, by, bz, 4, '检测到失稳核心遭非法破坏')
                    job = findUnstableJob(dim, bx, by, bz)
                }
                if (job != null) {
                    triggerFatalTamperOverride(job, player, 'SURVIVAL_ILLEGAL_MINING')
                }
            })

            // 若玩家手持终望珍珠直接对着失稳拆解台右击，允许珍珠抛出并在碰撞时立即吞噬，
            // 若贴脸右击未成功生成投掷物，也支持在潜行右击时直接消耗 1 颗终望珍珠完成吞噬停机
            BlockEvents.rightClicked(stageId, function (event) {
                var player = event.player
                if (player == null) return
                var item = event.item
                if (item == null || item.id !== ENDEST_PEARL_ITEM) return

                var dim = dimOf(event)
                var bx = event.block.x
                var by = event.block.y
                var bz = event.block.z
                var job = findUnstableJob(dim, bx, by, bz)
                if (job == null) {
                    beginUnstable(event.level, dim, bx, by, bz, stageIndex, '检测到存量失稳核心唤醒')
                    job = findUnstableJob(dim, bx, by, bz)
                }
                if (job == null) return

                if (player.crouching) {
                    if (!isCreativePlayer(player)) {
                        item.count--
                    }
                    removeUnstableJob(dim, bx, by, bz)
                    saveUnstableJobs(true)
                    triggerAbnormalShutdown(job, 'ENDEST_PEARL_CONTACT_DEVOUR', player)
                    event.cancel()
                }
            })
        })(idx, STAGE_BLOCKS[idx])
    }

    // ------------------------------------------------------------------------
    // 接入 EpiphyBlockTracker 自动发现与追踪存量拆解台及 5 阶段失稳方块
    // ------------------------------------------------------------------------
    function ensureUncraftingTrackerAttached() {
        if (uncraftingTracker != null) return
        try {
            uncraftingTracker = WORLD_OPS.createTracker({
                name:             'uncrafting_chaos',
                maintainInterval: 10,
                onFound: function (rec) {
                    if (rec == null || !isAllowedDim(rec.dim)) return
                    var lv = resolveLevelByDim(rec.dim, null)
                    if (rec.blockId === TARGET_ID) {
                        watched[keyOf(rec.dim, rec.x, rec.y, rec.z)] = {
                            x: rec.x, y: rec.y, z: rec.z, dim: rec.dim, level: lv
                        }
                    } else if (isStageBlockId(rec.blockId)) {
                        if (findUnstableJob(rec.dim, rec.x, rec.y, rec.z) == null) {
                            var sIdx = STAGE_MAP[rec.blockId] || 0
                            unstableJobs.push({
                                level:          lv,
                                dim:            rec.dim,
                                x:              rec.x,
                                y:              rec.y,
                                z:              rec.z,
                                t:              sIdx * STAGE_DURATION_TICKS,
                                spawnTick:      tickCounter,
                                totalTicks:     UNSTABLE_TICKS,
                                stageIndex:     sIdx,
                                fatalTriggered: false
                            })
                            saveUnstableJobs(false)
                        }
                    }
                },
                onRemoved: function (rec) {
                    if (rec == null) return
                    if (rec.blockId === TARGET_ID) {
                        delete watched[keyOf(rec.dim, rec.x, rec.y, rec.z)]
                    }
                }
            })
            if (uncraftingTracker != null && typeof uncraftingTracker.bind === 'function') {
                uncraftingTracker.bind(TARGET_ID, { scanRadius: 64 })
                for (var bi = 0; bi < STAGE_BLOCKS.length; bi++) {
                    uncraftingTracker.bind(STAGE_BLOCKS[bi], { scanRadius: 64 })
                }
            }
        } catch (eTrk) {
            LOGGER.catchWarn('attachTracker', eTrk)
        }
    }

    ensureUncraftingTrackerAttached()

    if (typeof ServerEvents !== 'undefined' && ServerEvents != null) {
        if (typeof ServerEvents.loaded === 'function') {
            ServerEvents.loaded(function (event) {
                if (event != null && event.server != null) SERVER = event.server
                ensureUncraftingTrackerAttached()
                ensureUnstableJobsLoaded()
            })
        }
        if (typeof ServerEvents.unloaded === 'function') {
            ServerEvents.unloaded(() => {
                try { saveUnstableJobs(true) } catch (eS) { }
                watched              = {}
                firedAt              = {}
                unstableJobs.length  = 0
                layerJobs.length     = 0
                internalReplace      = {}
                unstableStoreLoaded  = false
                unstableStoreDirty   = false
                SERVER               = null
            })
        }
    }

    // ------------------------------------------------------------------------
    // 主循环：非玩家破坏轮询 + 3 分钟失稳阶段演进 + 300 格湮灭保层钳制
    // ------------------------------------------------------------------------
    ServerEvents.tick(function (event) {
        SERVER = event.server
        tickCounter++
        ensureUnstableJobsLoaded()

        // 每 200 tick（10 秒）清理一次已过期的 internalReplace 与 firedAt 临时坐标键
        if (tickCounter % 200 === 0) {
            pruneExpiredStateMaps()
        }
        if (unstableStoreDirty && (tickCounter - lastUnstableSaveTick) >= 40) {
            saveUnstableJobs(false)
        }

        if (ENABLE_NON_PLAYER) {
            var checkSwallowThisTick = (tickCounter % 5 === 0)
            for (var key in watched) {
                var w = watched[key]
                if (w == null || !isAllowedDim(w.dim)) {
                    delete watched[key]
                    continue
                }
                if (w.level == null) {
                    w.level = resolveLevelByDim(w.dim, null)
                    if (w.level == null) continue
                }

                // 仅当拆解台所在区块已在内存中加载时才读取方块状态（避免强制加载未加载区块）
                if (!isBlockChunkLoaded(w.level, w.x, w.z)) continue

                // 若常态终极拆解台周围有玩家且已有终望珍珠或黑洞奇点进入吞噬范围，直接将其安全吞噬拆除
                if (checkSwallowThisTick && hasPlayerNear(w.level, w.x, w.y, w.z, NEAR_DISTANCE)) {
                    var preSwallow = findEndestSwallowSourceAt(w.level, w.x, w.y, w.z)
                    if (preSwallow != null) {
                        triggerNormalTableVoidSwallow(w.level, w.dim, w.x, w.y, w.z, preSwallow.source)
                        continue
                    }
                }

                var block = w.level.getBlock(w.x, w.y, w.z)
                if (block.id === TARGET_ID) continue

                // 方块已被非玩家外力破坏：立即移除监控记录
                delete watched[key]

                // 若被外力破坏时周围 NEAR_DISTANCE (128格) 内没有任何玩家，则仅清理周围可能被活塞推走的拆解台副本，不触发任何殉爆/秒杀行为（更绝不会延迟到以后玩家靠近时才突然引爆）
                var playerPresent = hasPlayerNear(w.level, w.x, w.y, w.z, NEAR_DISTANCE)

                for (var dx = -PURGE_RADIUS; dx <= PURGE_RADIUS; dx++) {
                    for (var dy = -1; dy <= 1; dy++) {
                        for (var dz = -PURGE_RADIUS; dz <= PURGE_RADIUS; dz++) {
                            var b = w.level.getBlock(w.x + dx, w.y + dy, w.z + dz)
                            if (b.id === TARGET_ID) {
                                b.set('minecraft:air')
                            }
                        }
                    }
                }

                if (playerPresent) {
                    handleIllegalBreak(w.level, w.dim, w.x, w.y, w.z, null)
                }
            }
        }

        tickUnstable()

        for (var n = layerJobs.length - 1; n >= 0; n--) {
            var job = layerJobs[n]
            job.t++
            if (job.t === DE_LIFETIME + 6) {
                triggerIncrementalLiquidSweep(job.level, job.dim, job.x, job.y, job.z, DE_POWER * 10)
            }
            if (job.t === DE_LIFETIME + 7 && MAGMA_RING_ENABLED && !job.magmaStarted) {
                job.magmaStarted = true
                startMagmaRing(job, DE_POWER * 10)
            }
            if (job.t > DE_LIFETIME + 8) {
                layerJobs.splice(n, 1)
                continue
            }
            ringFx(job)
            if (job.bottomY != null || job.topY != null) {
                clampTraces(job)
            }
        }
    })

    // ------------------------------------------------------------------------
    // 爆炸后物质湮灭进度提示（表驱动阈值，按 DE_PROGRESS_MULTIPLIER 倍速推进）
    // ------------------------------------------------------------------------
    var ANNIHILATION_TIPS = [
        {
            flag: 'tip20', minR: 60, fadeOut: 8, stay: 35,
            title: '{"text":"[ 物质湮灭进度 · 20% ]","color":"gold","bold":true}',
            sub:   '{"text":"波前半径 60m / 300m —— 内圈岩层与表层建筑正在被中子洪流解构","color":"yellow"}',
            chat:  '{"text":"[ANNIHILATION · 20%] 湮灭环已推进至 60 格，内圈常规物质已蒸发。","color":"gold"}'
        },
        {
            flag: 'tip45', minR: 135, fadeOut: 8, stay: 35,
            title: '{"text":"[ 物质湮灭进度 · 45% ]","color":"red","bold":true}',
            sub:   '{"text":"波前半径 135m / 300m —— 终望引力波横扫中圈，高硬度方块结构崩解","color":"gold"}',
            chat:  '{"text":"[ANNIHILATION · 45%] 湮灭环已推进至 135 格，地下矿脉与流体层正在汽化。","color":"red"}'
        },
        {
            flag: 'tip70', minR: 210, fadeOut: 8, stay: 35,
            title: '{"text":"[ 物质湮灭进度 · 70% ]","color":"dark_red","bold":true}',
            sub:   '{"text":"波前半径 210m / 300m —— 无尽催化裂变扩散至外圈，地貌已永久抹除","color":"red"}',
            chat:  '{"text":"[ANNIHILATION · 70%] 湮灭环已推进至 210 格，混沌能量正在剥离外围地壳。","color":"dark_red"}'
        },
        {
            flag: 'tip90', minR: 270, fadeOut: 8, stay: 30,
            title: '{"text":"[ 物质湮灭进度 · 90% ]","color":"dark_red","bold":true}',
            sub:   '{"text":"波前半径 270m / 300m —— 冲击波即将抵达边界，正在清理残余物质","color":"red"}',
            chat:  null
        },
        {
            flag: 'tip100', minR: 300, fadeOut: 20, stay: 60, fadeIn: 5,
            title: '{"text":"[ 物质湮灭完成 · 100% ]","color":"gray","bold":true}',
            sub:   '{"text":"半径 300 格现实擦除完毕 —— 仅余虚空与基岩残骸","color":"dark_gray"}',
            chat:  '{"text":"[ANNIHILATION · 100%] 物质湮灭序列执行完毕（半径 300m 已清空）。系统进入静默状态。","color":"gray"}'
        }
    ]

    function updateAnnihilationProgressPrompts(job, r, maxR) {
        var shownR = Math.min(maxR, Math.round(r * DE_PROGRESS_MULTIPLIER))
        var p = maxR > 0 ? (shownR / maxR) : 0
        var pct = Math.min(100, Math.round(p * 100))
        var alertRange = FX_PACKET_RANGE + 80

        // 1. 左上角【300m 物质湮灭实时波前监控面板】（新版持续激活 HUD，始终稳定静止不震动，已移除旧版物品栏上方 ActionBar 进度条）
        var bar = makeProgressBar(p)
        var waveSlotId = 'annihilation_hud_' + job.x + '_' + job.y + '_' + job.z
        if (shownR < maxR && job.t % 6 === 0) {
            sendDanmakuNear(job.level, job.x, job.y, job.z, alertRange, {
                group:      TELEMETRY_GROUP,
                id:         waveSlotId,
                lifeMode:   'active',
                activeHold: 18,
                priority:   'active',
                text:       '§4§l[物质湮灭波前 // REALITY WIPE] §f' + pct + '%',
                sub:        '§c' + bar + ' §e' + shownR + 'm / ' + maxR + 'm\n§7爆心 (' + job.x + ', ' + job.y + ', ' + job.z + ') §8| §6流体与岩层正在同步汽化',
                pos:        [0.20, 0.12],
                size:       0.78,
                tilt:       0,
                shakeMode:  'none',
                shakeAmp:   0.0,
                fadeStyle:  'shatter',
                fadeOut:    18
            })
        }

        // 3. 湮灭进度推进期间（shownR < maxR），在避开右上角小地图与底部快捷栏的全屏自由位置插入丰富色彩与来源的异常子报
        if (shownR < maxR && job.t % 10 === 0) {
            var g = MINOR_UNSTABLE_GLITCHES[Math.floor(Math.random() * MINOR_UNSTABLE_GLITCHES.length)]
            var pal = pickRandomPalette()
            var origin = pickRandomOriginTag()
            var waveShake = ['none', 'none', 'decay', 'fade_in', 'pulse'][Math.floor(Math.random() * 5)]
            sendDanmakuNear(job.level, job.x, job.y, job.z, alertRange, {
                priority:  'low',
                text:      pal.titleCode + '[' + origin + ' // R=' + shownR + 'm] ' + g.code,
                sub:       pal.subCode + g.detail,
                pos:       randomFreeScreenPos(true),
                scale:     Number((0.55 + Math.random() * 0.65).toFixed(2)),
                tilt:      randomDiverseTilt(),
                color:     pal.color,
                subColor:  pal.subColor,
                mode:      Math.random() < 0.6 ? 'char' : 'all',
                charMs:    16 + Math.floor(Math.random() * 14),
                duration:  45 + Math.floor(Math.random() * 28),
                shakeMode: waveShake,
                shakeAmp:  waveShake === 'none' ? 0.0 : 1.6,
                fadeStyle: 'random',
                fadeOut:   12
            })
        }

        for (var i = 0; i < ANNIHILATION_TIPS.length; i++) {
            var tip = ANNIHILATION_TIPS[i]
            var threshold = (tip.flag === 'tip100') ? maxR : tip.minR
            if (!job[tip.flag] && shownR >= threshold) {
                job[tip.flag] = true
                if (tip.flag === 'tip100') {
                    // 湮灭抵达 100% 时，让左上角实时波前遥测面板进入逐字碎裂消散
                    deactivateTelemetryNear(job.level, job.x, job.y, job.z, alertRange, waveSlotId, 20)
                }
                sendScreenAlert(
                    job.level, job.dim, job.x, job.y, job.z, alertRange,
                    tip.title, tip.sub,
                    tip.fadeIn || 2, tip.stay, tip.fadeOut,
                    tip.flag === 'tip100'
                        ? { shakeMode: 'none', fadeStyle: 'char_first', size: [1.30, 1.48] }
                        : { shakeMode: 'decay', fadeStyle: 'random' }
                )
                if (tip.chat != null) {
                    sendChatNear(job.level, job.dim, job.x, job.y, job.z, alertRange, tip.chat)
                }
            }
        }
    }

    function ringFx(job) {
        var r = job.t
        var maxR = DE_POWER * 10
        if (r <= 0) return

        // 文案按倍率推进，即使 r 已越过 maxR 也要让它跑到 100%
        updateAnnihilationProgressPrompts(job, Math.min(r, maxR), maxR)

        if (r > maxR) return

        for (var i = 0; i < FX_RING_PARTICLES; i++) {
            var a = Math.random() * Math.PI * 2
            var px = job.x + 0.5 + Math.cos(a) * r
            var pz = job.z + 0.5 + Math.sin(a) * r
            var ix = Math.floor(px), iz = Math.floor(pz)
            if (!isBlockChunkLoaded(job.level, ix, iz)) continue
            var sy = WORLD_OPS.findLoadedSurfaceY(job.level, ix, iz, job.y, 96, 16)
            if (sy == null) sy = job.y
            particleAt(job.level, P_SMOKE, px, sy + 1, pz, 1.0, 0.8, 1.0, 4, 0.04)
        }

        // 全高度混沌内爆伤害波前（弥补 DE 原生 ChaosImplosionTrace 仅在 y >= 0 结算伤害、导致 y < 0 深板岩层无伤害的缺陷）：
        // 对处于当前冲击波半径 (r + 18) 内的所有非创造玩家与生物持续施加原版 DEDamage.chaosImplosion(level) 混沌湮灭伤害！
        var waveRadius = Math.min(maxR + 16, r + 18)
        forEachPlayerNear(job.level, job.x, job.y, job.z, waveRadius, (p, distSq) => {
            var dist = Math.sqrt(distSq)
            var wavePower = Math.max(80.0, (DE_POWER - (dist / 10.0)) * 120.0)
            inflictChaosCrystalDamage(job.level, p, 'chaos_implosion', wavePower)
        })
        if (job.t % 5 === 0) {
            BASE.forEachEntityNear(job.level, job.x, job.y, job.z, waveRadius, (ent) => {
                var tid = String(ent.type || '')
                return tid !== 'minecraft:item' && tid !== 'minecraft:experience_orb' && tid !== GAPING_VOID_ENTITY
            }, (ent, distSq) => {
                var dist = Math.sqrt(distSq)
                var wavePower = Math.max(80.0, (DE_POWER - (dist / 10.0)) * 120.0)
                inflictChaosCrystalDamage(job.level, ent, 'chaos_implosion', wavePower)
            })
        }

        // 在波前推进到 25%、50%、75%、92% 以及结束瞬间，持续唤醒流体任务的增量热点与外圈防回流环带（跟紧 DE 冲击波炸开海床的节奏；最外圈岩浆环统一在 DE_LIFETIME + 7 收尾复扫启动后浇筑）
        if (r === Math.floor(maxR * 0.25) || r === Math.floor(maxR * 0.50) || r === Math.floor(maxR * 0.75) || r === Math.floor(maxR * 0.92) || r === maxR) {
            triggerIncrementalLiquidSweep(job.level, job.dim, job.x, job.y, job.z, maxR)
        }

        if (job.t % FX_BOOM_EVERY === 0) {
            playAt(job.level, job.x, job.y, job.z, SND_BOOM, 1.6, 0.5, 350)
        }
    }

    // ------------------------------------------------------------------------
    // 液体清除与外圈岩浆环：委托给通用组件 EpiphyWorldOps (Epiphy的-方块与区块组件.js)
    // ------------------------------------------------------------------------
    function triggerIncrementalLiquidSweep(level, dim, cx, cy, cz, radius) {
        if (!LIQUID_PURGE_ENABLED || level == null) return
        WORLD_OPS.triggerIncrementalFluidSweep(level, dim, cx, cy, cz, radius, {
            padding:        LIQUID_PURGE_PADDING,
            loops:          LIQUID_PURGE_LOOPS,
            unloadedTtl:    LIQUID_UNLOADED_TTL,
            syncInitRadius: 0,
            syncMaxMs:      LIQUID_SYNC_MAX_MS,
            excludeLava:    true
        })
    }

    function startLiquidPurge(level, dim, cx, cy, cz, radius, isRimOnlySweep) {
        if (!LIQUID_PURGE_ENABLED || level == null) return
        // 引爆当 tick 仅做极短同步核心预扫（syncInitRadius=32, syncMaxMs=4ms），将主开销平摊至 EpiphyWorldOps 分帧预算（8ms/tick）
        WORLD_OPS.startSphereFluidPurge(level, dim, cx, cy, cz, radius, {
            isRimOnlySweep: Boolean(isRimOnlySweep),
            padding:        LIQUID_PURGE_PADDING,
            loops:          LIQUID_PURGE_LOOPS,
            unloadedTtl:    LIQUID_UNLOADED_TTL,
            syncInitRadius: LIQUID_SYNC_INIT_RADIUS,
            syncMaxMs:      LIQUID_SYNC_MAX_MS,
            onDone: () => {
                sendChatNear(
                    level, dim, cx, cy, cz, FX_PACKET_RANGE + 120,
                    '{"text":"[LIQUID_PURGE] 湮灭流体剥离完成 —— 湮灭柱域内的水源、流动水、气泡柱、水生植物、含水方块与岩浆已全部归零。","color":"gold"}'
                )
            }
        })
    }

    function startMagmaRing(job, maxR) {
        WORLD_OPS.startRingBlockJob(job.level, job.dim, job.x, job.y, job.z, maxR, {
            blockId:   'minecraft:lava',
            width:     MAGMA_RING_WIDTH,
            thickness: MAGMA_RING_THICKNESS,
            onDone: (rJob) => {
                var placed = rJob?.placedCols != null ? rJob.placedCols : 0
                var total  = rJob?.totalCols  != null ? rJob.totalCols  : 0
                if (placed <= 0) return
                var covText = (total > 0 && placed < total)
                    ? `（已浇筑当前加载视距内 ${placed}/${total} 列）`
                    : ''
                sendChatNear(
                    job.level, job.dim, job.x, job.y, job.z, FX_PACKET_RANGE + 80,
                    `{"text":"[MAGMA_RING] 最外壳层冷却完成 —— 半径 300 格处已形成岩浆圈层${covText}。","color":"gold"}`
                )
            }
        })
    }

    BASE.registerDebugProvider({
        name:    'uncrafting',
        label:   '拆解台混沌殉爆',
        order:   60,
        summary: () => `watched=${Object.keys(watched).length} | unstableJobs=${unstableJobs.length} | layerJobs=${layerJobs.length}`,
        detail: () => {
            var lines = [
                `watchedTables: ${Object.keys(watched).length}`,
                `unstableJobs: ${unstableJobs.length}`,
                `layerJobs: ${layerJobs.length}`,
                `traceGuardReady: ${TRACE_READY}`
            ]
            for (var i = 0; i < unstableJobs.length; i++) {
                var j = unstableJobs[i]
                lines.push(`  job[${i}]: ${j.dim} (${j.x},${j.y},${j.z}) stage=${j.stageIndex + 1} t=${j.t}/${j.totalTicks} fatal=${j.fatalTriggered}`)
            }
            return lines
        },
        metrics: () => ({
            watchedCount:      Object.keys(watched).length,
            unstableJobsCount: unstableJobs.length,
            layerJobsCount:    layerJobs.length,
            traceReady:        TRACE_READY
        })
    })
})()
