// ============================================================================
//  Epiphy 的小玩意 —— 功能测试组件 ([rnfmabj-测试] 指令广播方块 & [英佩瑞斯-测试中] 局部 3D 星轨长剑)
//  许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
//  放置位置：kubejs/startup_scripts/小玩意与案例/Epiphy的小玩意_功能测试.js
//  依赖组件：
//    - kubejs/startup_scripts/通用组件/Epiphy的-物品三维渲染器.js (global.EpiphyItem3DRenderer · v6 声明式物品 3D 渲染管线)
//    - kubejs/client_scripts/通用组件/Epiphy的-空间特效渲染器.js  (global.Epiphy3DFX / global.EpiphySpatialFX)
//    - kubejs/client_scripts/通用组件/Epiphy的-平面渲染器.js     (Epiphy2DRenderer / ScreenDanmakuClient)
//    - kubejs/server_scripts/通用组件/Epiphy的-平面渲染组件.js   (global.Epiphy2DSurface / global.ScreenDanmaku)
//    - kubejs/client_scripts/通用组件/Epiphy的-音频播放器.js     (EpiphyAudioClient)
//    - kubejs/server_scripts/通用组件/Epiphy的-音频组件.js       (global.EpiphyAudio)
//    - kubejs/startup_scripts/通用组件/创造模式栏-epiphy.js
//
//  注意：本脚本的 "……" → 随机在线玩家名 替换仅在本脚本内部生效，不影响通用弹幕组件。
// ============================================================================

;(function () {
    var BLOCK_ID       = 'epiphy:rnfmabj_test'
    var SWORD_ID       = 'epiphy:imperius_test'
    var SWORD_NAME     = '英佩瑞斯-测试中'
    var SWORD_DAMAGE   = 50.0
    // 公开仓库因版权与体积原因不随库分发 children_of_the_city.ogg（详见 docs/audio-assets.md）；
    // 仍保留该 SoundEvent 槽位供本地自备或替换为自定义音频，缺省时测试方块的其余功能可正常运行。
    var SOUND_ID       = 'epiphy:children_of_the_city'
    var DANMAKU_GROUP  = 'rnfmabj_test'
    var EFFECT_RADIUS  = 30
    var EMIT_STEP_TICK = 140 // 约 7.0 秒推送一条新弹幕（配合 64ms/字慢速打字与停留时长，避免屏幕拥挤）

    var PRESCRIPT_TEXTS = [
        '致…… :制作便当，在下午1点时于11区内的垃圾桶上享用它。',
        '致…… :在时针位于7与8之间时制作蛋白酥皮奶油卷筒并一边看电影一边享用它。',
        '致…… :和你今天遇到的前五个人中的第5位进行折手指游戏。手指折下去时需要被折断。',
        '致…… :将你所遇到的第62个人的指甲修剪整齐。',
        '致…… :抚摸5次用四足行走的动物。',
        '致…… :通过旋转转盘选出某个被指定的人并朝他扔蛋糕。',
        '致…… :吃放置在常温环境下的螃蟹与熟透了的柿子，每样各吃8个。',
        '致…… :在屋顶的围栏上大声喊出你所厌恶的人的名字后跳下屋顶。屋顶距离地面的高度无关紧要。',
        '致…… :将用餐后余下的碗全部丢弃。',
        '致…… :于接受指令后的第二天早上睁开眼睛时便立刻喝下3杯水。',
        '致…… :与居住在同一栋楼中的居民们一同进行一场目的地为7区的赛跑比赛。每隔23分钟便测量一次距离，测量距离时与7区相距最远的人将会被淘汰。',
        '致…… :在3天内织好一条带有蝴蝶图案的围巾。',
        '致…… :随意地拨一通电话。为接电话的人送上新年贺词。',
        '致…… :在白色的墙壁上看到绿色。',
        '致…… :在你肚子饿时吃添加了洋葱的鸡肉奶酪汉堡。',
        '致…… :折39个纸鹤并令它们在屋顶上飞扬。',
        '致…… :把首个在职场中大声训斥你的人的耳朵剪掉。',
        '致…… :与和自己视线相交了的人打招呼。',
        '致…… :立刻回家。有狗在家门前叫过一次后才可以出来。',
        '致…… :身着淡绿色的衣物并在三角形的街道上走十步。'
    ]

    function registerToEpiphyTab(itemId) {
        if (global.EpiphyCreativeTab && typeof global.EpiphyCreativeTab.add === 'function') {
            global.EpiphyCreativeTab.add(itemId)
            return
        }
        if (!Array.isArray(global.EpiphyCreativeTabQueue)) {
            global.EpiphyCreativeTabQueue = []
        }
        if (global.EpiphyCreativeTabQueue.indexOf(itemId) < 0) {
            global.EpiphyCreativeTabQueue.push(itemId)
        }
    }

    // ======================================================================== 1. 注册方块、音效与创造模式物品栏
    StartupEvents.registry('sound_event', function (event) {
        event.create(SOUND_ID)
    })

    StartupEvents.registry('block', function (event) {
        event.create(BLOCK_ID)
            .displayName('[rnfmabj-测试]')
            .soundType('WOOD')
            .hardness(1.0)
            .resistance(1.0)
            .textureAll('minecraft:block/oak_planks')
            .texture('all', 'minecraft:block/oak_planks')

        registerToEpiphyTab(BLOCK_ID)
    })

    StartupEvents.registry('item', function (event) {
        var sb = event.create(SWORD_ID, 'sword')
        if (sb != null) {
            if (typeof sb.displayName === 'function') sb.displayName(SWORD_NAME)
            if (typeof sb.tier === 'function') sb.tier('netherite')
            if (typeof sb.attackDamageBaseline === 'function') sb.attackDamageBaseline(SWORD_DAMAGE)
            if (typeof sb.attackDamageBonus === 'function') sb.attackDamageBonus(0.0)
            if (typeof sb.maxDamage === 'function') sb.maxDamage(0)
            if (typeof sb.unstackable === 'function') sb.unstackable()
            if (typeof sb.modifyTier === 'function') {
                sb.modifyTier(function (tier) {
                    if (tier != null) {
                        tier.uses              = 0
                        tier.attackDamageBonus = 0.0
                        tier.enchantmentValue  = 22
                    }
                })
            }
            if (typeof sb.texture === 'function') sb.texture('epiphy:item/imperius_test')
            if (typeof sb.parentModel === 'function') sb.parentModel('minecraft:item/handheld')
            if (typeof sb.tag === 'function') {
                sb.tag('minecraft:swords')
                sb.tag('forge:tools/swords')
            }
        }

        registerToEpiphyTab(SWORD_ID)
    })

    registerToEpiphyTab(BLOCK_ID)
    registerToEpiphyTab(SWORD_ID)

    // 热重载材质补丁：若当前游戏进程已启动过且 Builder 已在 RegistryInfo 内存中，
    // 直接为其补齐贴图，使 /kubejs reload startup_scripts 后按 F3+T 即可恢复材质而无需重启游戏
    try {
        var RegistryInfo     = Java.loadClass('dev.latvian.mods.kubejs.registry.RegistryInfo')
        var ResourceLocation = Java.loadClass('net.minecraft.resources.ResourceLocation')
        var rl               = new ResourceLocation(BLOCK_ID)
        var blockBuilder     = RegistryInfo.BLOCK.objects.get(rl)
        if (blockBuilder != null) {
            blockBuilder.textureAll('minecraft:block/oak_planks')
            blockBuilder.texture('all', 'minecraft:block/oak_planks')
        }
        var swordRl          = new ResourceLocation(SWORD_ID)
        var swordBuilder     = RegistryInfo.ITEM.objects.get(swordRl)
        if (swordBuilder != null) {
            swordBuilder.texture('epiphy:item/imperius_test')
            swordBuilder.parentModel('minecraft:item/handheld')
        }
    } catch (ePatch) { }

    // ======================================================================== 2. 在线玩家名提取与指令文本生成
    function toSafeArray(listObj) {
        var out = []
        if (listObj == null) return out
        var i, n
        try {
            if (typeof listObj.size === 'function' && typeof listObj.get === 'function') {
                n = Number(listObj.size())
                for (i = 0; i < n; i++) out.push(listObj.get(i))
                return out
            }
        } catch (e0) { }
        try {
            if (typeof listObj.length === 'number') {
                n = Number(listObj.length)
                for (i = 0; i < n; i++) out.push(listObj[i])
                return out
            }
        } catch (e1) { }
        return out
    }

    function getLevelPlayers(rawLevel) {
        if (rawLevel == null) return []
        try {
            var pProp = rawLevel.players
            if (pProp != null && typeof pProp !== 'function') return toSafeArray(pProp)
            if (typeof pProp === 'function') return toSafeArray(pProp.call(rawLevel))
        } catch (e0) { }
        try {
            if (typeof rawLevel.getPlayers === 'function') return toSafeArray(rawLevel.getPlayers())
        } catch (e1) { }
        return []
    }

    function getServerPlayers(srv, fallbackLevel) {
        if (srv != null) {
            try {
                var sp = srv.players
                if (sp != null && typeof sp !== 'function') {
                    var arr1 = toSafeArray(sp)
                    if (arr1.length > 0) return arr1
                }
            } catch (e0) { }
            try {
                if (typeof srv.getPlayers === 'function') {
                    var arr2 = toSafeArray(srv.getPlayers())
                    if (arr2.length > 0) return arr2
                }
            } catch (e1) { }
            try {
                if (typeof srv.getPlayerList === 'function') {
                    var pl = srv.getPlayerList()
                    if (pl != null && typeof pl.getPlayers === 'function') {
                        var arr3 = toSafeArray(pl.getPlayers())
                        if (arr3.length > 0) return arr3
                    }
                }
            } catch (e2) { }
        }
        return getLevelPlayers(fallbackLevel)
    }

    function extractPlayerName(p) {
        if (p == null) return '某人'
        try { if (p.username != null) return String(p.username) } catch (e0) { }
        try { if (typeof p.getUsername === 'function') return String(p.getUsername()) } catch (e1) { }
        try {
            if (typeof p.getGameProfile === 'function') return String(p.getGameProfile().getName())
        } catch (e2) { }
        try {
            if (p.name != null && typeof p.name.getString === 'function') return String(p.name.getString())
        } catch (e3) { }
        return '某人'
    }

    function pickPrescriptForOnlinePlayer(srv, rawLevel) {
        var rawTemplate = PRESCRIPT_TEXTS[Math.floor(Math.random() * PRESCRIPT_TEXTS.length)]
        var chosenName  = '某人'
        var plist       = getServerPlayers(srv, rawLevel)
        if (plist.length > 0) {
            chosenName = extractPlayerName(plist[Math.floor(Math.random() * plist.length)])
        }
        return rawTemplate.replace('……', chosenName)
    }

    // ======================================================================== 3. 向上提交音频/渲染预设并绑定到通用组件 bindBlock 接口
    // 渐进式区块分段扫描、坐标持久化、放置与破坏事件生命周期均由通用组件的 bindBlock 接口统一托管
    var AUDIO_PRESET_ID   = 'rnfmabj_test_bgm'
    var DANMAKU_PRESET_ID = 'rnfmabj_test_prescript'
    var SPEC              = global.EpiphySpec

    SPEC.registerPreset('audio', AUDIO_PRESET_ID, {
        sound:            SOUND_ID,
        category:         'records',
        range:            EFFECT_RADIUS,
        volume:           1.0,
        loop:             true,
        duckMusic:        true,          // BGM 生效期间自动避让原版背景音乐
        falloff:          'smooth',
        fadeIn:           '1s',
        fadeOut:          '1s',
        outOfRangeMode:   'mute',        // 出界后静音保活，再进入接续当前进度
        conflictMode:     'merge',       // 多块相邻合并：以最先放置的方块为准、其余静默不单独建句柄，范围取并集并在敲掉时重算
        conflictScope:    'sound',
        stopOnBlockBreak: true
    })

    SPEC.registerPreset('surface', DANMAKU_PRESET_ID, {
        scale:             [1.15, 1.60],    // 原先 small_random (~0.76) 的 1.5~2.0 倍随机缩放
        color:             0x8CE6FF,        // 冰青蓝主字色（保留明显青色调，与红色外圈形成对比）
        outline:           'glow',          // 柔和发光外圈
        outlineColor:      0xD82038,        // 绯红色外圈光晕
        outlineWidth:      1.05,            // 外圈发光半径
        shadow:            false,           // 使用外圈发光替代默认右下硬阴影，字形更干净
        letterSpacing:     1.0,             // 相对字宽等比字间距（全角汉字 +1.0px，英文按真实字宽等比缩放）
        letterSpacingMode: 'relative',      // 避免英文窄字符被固定像素撑得过宽
        pos:               'spread',
        tilt:              [-40, 40],       // 以水平为 0，±40° 随机倾斜
        typewriter:        true,
        charMs:            64,              // 打字速度降至原先一半（64ms/字）
        duration:          130,             // 打字全部显示完毕后，额外完整停留 130 tick (6.5 秒)
        fade:              'blur',          // 柔和失焦虚化淡出（不放大字号、不分裂重影）
        fadeOut:           28,              // 1.4 秒平滑虚化消散
        shake:             'per_char',      // 逐字独立微抖动
        charShakeStyle:    'horizontal_step', // 每周期 1 次轻微位移 + 水平/垂直与朝向晃动
        charShakeShiftX:   0.31,            // 水平落点微位移幅度倍率（约 ±0.23px 轻微位移）
        charShakeShiftY:   0.36,            // 垂直落点微位移幅度倍率（约 ±0.27px 轻微位移）
        charShakeSwayX:    0.32,            // 水平方向轻度阻尼晃动幅度倍率
        charShakeSwayY:    0.22,            // 垂直方向轻度阻尼晃动幅度倍率
        charShakeRotDeg:   2.5,             // 单字朝向（角度）轻微随机变更与晃动幅度（度）
        charShakeWin:      0.38,            // 周期初段晃动窗口占比
        charShakeSnap:     true,            // false=平滑过渡位移，true=每周期直接瞬移
        shakeFreq:         800,             // 每 0.8 秒触发 1 次
        shakeAmp:          0.75,            // 轻微且清晰可辨的逐字微抖动幅度
        avoidOverlap:      true,            // 随机落点时尽量避开同组近期弹幕，防止几乎重叠
        minSepX:           0.28,
        minSepY:           0.22,
        group:             DANMAKU_GROUP,
        maxGroup:          3,               // 同屏最多 3 条
        debug:             false            // 调试日志默认关闭
    })

    var audioBindingSpec = { preset: AUDIO_PRESET_ID }

    function buildDanmakuSpec(ctx) {
        return {
            preset: DANMAKU_PRESET_ID,
            text:   pickPrescriptForOnlinePlayer(ctx != null ? ctx.server : null, ctx != null ? ctx.level : null)
        }
    }

    var danmakuBindingExtra = {
        radius:        EFFECT_RADIUS,
        intervalTicks: EMIT_STEP_TICK,
        group:         DANMAKU_GROUP,
        conflictMode:  'merge',          // 同组相邻方块合并：以最先放置方块为主控运行，其余静默合并、范围取并集并在敲掉时重算
        conflictScope: 'block'           // 'block'(同类方块) | 'group'(同组) | 'all'(全局)
    }

    // 写入全局绑定表（当 server_scripts 晚于 startup_scripts 加载或 /reload 时自动吸收）
    if (!global.EpiphyAudioBlockBindings || typeof global.EpiphyAudioBlockBindings !== 'object') {
        global.EpiphyAudioBlockBindings = {}
    }
    global.EpiphyAudioBlockBindings[BLOCK_ID] = audioBindingSpec

    if (!global.ScreenDanmakuBlockBindings || typeof global.ScreenDanmakuBlockBindings !== 'object') {
        global.ScreenDanmakuBlockBindings = {}
    }
    global.ScreenDanmakuBlockBindings[BLOCK_ID] = {
        specOrFn:  buildDanmakuSpec,
        extraOpts: danmakuBindingExtra
    }

    // 声明旧版持久化数据一次性迁移（由方块追踪组件在服务端就绪后统一迁入并分发给所有订阅者，防重复入队）
    if (!Array.isArray(global.EpiphyLegacyBlockMigrations)) {
        global.EpiphyLegacyBlockMigrations = []
    }
    var hasSameMigration = global.EpiphyLegacyBlockMigrations.some(function (m) {
        return m != null && m.serverKey === 'epiphy_rnfmabj_emitters' && m.levelField === 'danmakuLoop' && m.blockId === BLOCK_ID
    })
    if (!hasSameMigration) {
        global.EpiphyLegacyBlockMigrations.push({
            serverKey:  'epiphy_rnfmabj_emitters',
            levelField: 'danmakuLoop',
            blockId:    BLOCK_ID
        })
    }

    // ======================================================================== 4. 案例装配：调用通用 EpiphyItem3DRenderer (v6 声明式格式) 装配【英佩瑞斯-测试中】
    var ITEM3D = (typeof global !== 'undefined' && global != null) ? global.EpiphyItem3DRenderer : null
    var IMPERIUS_3DFX_PRESET_ID = 'imperius_test_cosmos_vfx'
    var IMPERIUS_SHADER_ID      = 'epiphy:epiphy_cosmos'

    // 4.1 由下游案例按需向通用渲染器注册本案例使用的核心着色器
    if (ITEM3D && typeof ITEM3D.registerShader === 'function') {
        ITEM3D.registerShader(IMPERIUS_SHADER_ID, {
            vertexFormat: 'POSITION_COLOR_TEX',
            uniforms:     ['EpiphyTime', 'EpiphyYawPitch', 'EpiphyGuiMode']
        })
    }

    // 4.2 使用 v6 分层声明式格式（model / frame / motion / lod / layers）与 fx() 构造器组合具体视觉效果
    // 像素级实测包络：校正中轴 pixelOrigin=[23.4, 42.3] 后剑身 u∈[8..56] 严格对称在 v∈[-4.71, +4.62] px、厚度 ±2.0 px；
    // 以下星盘环、悬浮残弧、双股星链螺旋与外围星芒的最小安全半径与轴向起点均严格处于剑身与护手包络之外（数学零穿模）。
    var imperiusLayers = (ITEM3D && typeof ITEM3D.fx === 'function')
        ? ITEM3D.fx()
            .surfaceOverlay('cosmos_window', IMPERIUS_SHADER_ID, 'epiphy:textures/item/imperius_test_cosmos_mask.png', {
                visibleIn: 'all',
                geometry:  { zFront: 0.5318, zBack: 0.4682 },
                uniforms:  {
                    EpiphyTime:     'time',
                    EpiphyYawPitch: 'viewYawPitch',
                    EpiphyGuiMode:  'isGui'
                }
            })
            .ribbonRing('primary_gold_ring', {
                visibleIn: 'all',
                material:       { texture: 'epiphy:textures/effect/glow_ribbon.png', blend: 'additive', blur: true },
                markerMaterial: { texture: 'epiphy:textures/effect/star_flare.png',  blend: 'additive', blur: true },
                transform:      { axisOffset: 12.2, tiltU: 0.34, tiltV: 0.14, spinSpeed: 0.58, scaleWithAttack: 'uniform' },
                geometry: {
                    radius: 10.6, width: 0.58, segments: 40,
                    color: 0xE89B24, colorEnd: 0xF5749E,
                    coreColor: 0xFFCE6A, coreColorEnd: 0xFFA2C4,
                    alpha: 158, crossAlpha: 88, gradientCycles: 2, pulseAmp: 0.18, pulseFreq: 2,
                    ticks: 16, markers: 3, markerRadius: 2.10, markerColor: 0xFFE39E
                }
            })
            .ribbonRing('inner_astral_arc_a', {
                visibleIn: 'all',
                material:       { texture: 'epiphy:textures/effect/glow_ribbon.png', blend: 'additive', blur: true },
                markerMaterial: { texture: 'epiphy:textures/effect/star_flare.png',  blend: 'additive', blur: true },
                transform:      { axisOffset: 12.2, tiltU: 0.34, tiltV: 0.14, spinSpeed: -0.95, scaleWithAttack: 'uniform' },
                geometry: {
                    radius: 8.1, width: 0.46, segments: 24,
                    arcStart: 0.0, arcSpan: 2.25,
                    color: 0x7A3CFF, colorEnd: 0x1CC8FF,
                    coreColor: 0xA878FF, coreColorEnd: 0x7CE6FF,
                    alpha: 156, crossAlpha: 84,
                    ticks: 0, markers: 1, markerRadius: 1.75, markerColor: 0x9EE8FF
                }
            })
            .ribbonRing('inner_astral_arc_b', {
                visibleIn: 'all',
                material:       { texture: 'epiphy:textures/effect/glow_ribbon.png', blend: 'additive', blur: true },
                markerMaterial: { texture: 'epiphy:textures/effect/star_flare.png',  blend: 'additive', blur: true },
                transform:      { axisOffset: 12.2, tiltU: 0.34, tiltV: 0.14, spinSpeed: -0.95, scaleWithAttack: 'uniform' },
                geometry: {
                    radius: 8.1, width: 0.46, segments: 24,
                    arcStart: 3.141592653589793, arcSpan: 2.25,
                    color: 0xF24496, colorEnd: 0xFFBC4A,
                    coreColor: 0xFF8CC4, coreColorEnd: 0xFFE08C,
                    alpha: 156, crossAlpha: 84,
                    ticks: 0, markers: 1, markerRadius: 1.75, markerColor: 0xFFD8E8
                }
            })
            .ribbonRing('outer_celestial_ring', {
                visibleIn: 'hand',
                material:       { texture: 'epiphy:textures/effect/glow_ribbon.png', blend: 'additive', blur: true },
                markerMaterial: { texture: 'epiphy:textures/effect/star_flare.png',  blend: 'additive', blur: true },
                transform:      { axisOffset: 15.2, tiltU: -0.54, tiltV: -0.20, spinSpeed: -0.44, scaleWithAttack: 'uniform' },
                geometry: {
                    radius: 13.0, width: 0.52, segments: 44,
                    waveAmp: 0.55, waveFreq: 3,
                    color: 0x7B42FF, colorEnd: 0x1FD2FF,
                    coreColor: 0xB88BFF, coreColorEnd: 0x7CEBFF,
                    alpha: 152, crossAlpha: 82, gradientCycles: 2, pulseAmp: 0.22, pulseFreq: 3,
                    ticks: 0, markers: 2, markerRadius: 2.25, markerColor: 0xB8D8FF
                }
            })
            .ribbonHelix('dual_spiral_threads', {
                visibleIn: 'hand',
                material:     { texture: 'epiphy:textures/effect/glow_ribbon.png', blend: 'additive', blur: true },
                nodeMaterial: { texture: 'epiphy:textures/effect/star_flare.png',  blend: 'additive', blur: true },
                transform:    { axisOffset: 0.0, spinSpeed: 1.05, scaleWithAttack: 'radial' },
                geometry: {
                    steps: 40, start: 8.5, span: 45.5,
                    minRadius: 6.4, radius: 8.8, ellipticZ: 1.0,
                    freq: 0.185, width: 0.48, pulseAmp: 0.18, pulseFreq: 2,
                    nodes: 3, nodeRadius: 1.55, nodeAlpha: 162,
                    strands: [
                        {
                            phase: 0.0,
                            color: 0xF24496, colorEnd: 0xF5AD3C,
                            coreColor: 0xFF8CC4, coreColorEnd: 0xFFD978,
                            alpha: 154, crossAlpha: 86
                        },
                        {
                            phase: 3.141592653589793,
                            color: 0x1CC8FF, colorEnd: 0x8A4FFF,
                            coreColor: 0x7CE6FF, coreColorEnd: 0xC49BFF,
                            alpha: 154, crossAlpha: 86
                        }
                    ]
                }
            })
            .spriteCluster('floating_star_flares', {
                visibleIn: 'hand',
                material:  { texture: 'epiphy:textures/effect/star_flare.png', blend: 'additive', blur: true },
                transform: { orbitSpeeds: [0.40, -0.32], bobAmp: 0.85, bobFreq: 1.05, scaleWithAttack: 'radial' },
                geometry: {
                    count: 6, groups: 2, spanStart: 12.0, spanLength: 38.0,
                    orbitMin: 8.0, orbitMax: 12.2, ellipticZ: 1.0,
                    spriteMin: 1.70, spriteMax: 2.45,
                    palette: [0xFF72B8, 0x38D4FF, 0xFFCE63, 0xA86EFF],
                    alpha: 150
                }
            })
            .build()
        : []

    var imperiusPresetSpec = {
        proto: 6,
        model: {
            state:            'tool',
            isGui3d:          false,
            usesBlockLight:   false,
            ambientOcclusion: false,
            renderBase:       true,
            flushBase:        true
        },
        frame: {
            pixelCanvas: 64,
            pixelOrigin: [23.4, 42.3, 0.5],
            axisDir:     [0.698, 0.716]
        },
        motion: {
            speed:        1.0,
            attackExpand: 0.45
        },
        lod: {
            guiScale: 0.86
        },
        layers: imperiusLayers
    }

    if (ITEM3D && typeof ITEM3D.registerPreset === 'function') {
        ITEM3D.registerPreset(IMPERIUS_3DFX_PRESET_ID, imperiusPresetSpec)
    } else if (SPEC && typeof SPEC.registerPreset === 'function') {
        SPEC.registerPreset('item3d', IMPERIUS_3DFX_PRESET_ID, imperiusPresetSpec)
    }

    var imperius3DFXBindingSpec = { preset: IMPERIUS_3DFX_PRESET_ID }

    if (!global.EpiphyItem3DBindings || typeof global.EpiphyItem3DBindings !== 'object') {
        global.EpiphyItem3DBindings = {}
    }
    global.EpiphyItem3DBindings[SWORD_ID] = imperius3DFXBindingSpec

    // 若通用组件已加载，立即调用 bindBlock / EpiphyItem3DRenderer.bindItem 生效
    if (global.EpiphyAudio && typeof global.EpiphyAudio.bindBlock === 'function') {
        global.EpiphyAudio.bindBlock(BLOCK_ID, audioBindingSpec)
    }
    if (global.ScreenDanmaku && typeof global.ScreenDanmaku.bindBlock === 'function') {
        global.ScreenDanmaku.bindBlock(BLOCK_ID, buildDanmakuSpec, danmakuBindingExtra)
    }
    if (ITEM3D && typeof ITEM3D.bindItem === 'function') {
        ITEM3D.bindItem(SWORD_ID, imperius3DFXBindingSpec)
    }
    if (global.Epiphy3DFX && typeof global.Epiphy3DFX.bindItem === 'function') {
        global.Epiphy3DFX.bindItem(SWORD_ID, imperius3DFXBindingSpec)
    }
})()
