// ============================================================================
//  Epiphy的小玩意 —— 原版与其他 Mod 的隐藏物品收录模块
//  许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
//  放置位置：kubejs/startup_scripts/通用组件/Epiphy的小玩意-原版_其他Mod的隐藏物品.js
//  依赖模块：kubejs/startup_scripts/通用组件/创造模式栏-epiphy.js (epiphy:stuff)
//
//  收录物品清单：
//    - 屏障 (minecraft:barrier)
//    - 凋灵刷怪蛋 (minecraft:wither_spawn_egg)
//    - 末影龙刷怪蛋 (minecraft:ender_dragon_spawn_egg)
//    - 光源方块 (minecraft:light)
//    - 结构方块 (minecraft:structure_block)
//    - 拼图方块 (minecraft:jigsaw)
//    - 命令方块及其变体 (command_block / repeating_command_block / chain_command_block / command_block_minecart)
//    - 下界传送门、末地传送门、末地折跃门
//    - 混沌晶体 (epiphy:chaos_crystal -> 放置 draconicevolution:chaos_crystal)
//    - 建筑师的青睐 [神秘遗物] (enigmaticlegacy:cosmic_scroll)
//    - 终末之环 [诡厄巫法·启示录] (goety_revelation:halo_of_the_end)
// ============================================================================

;(function () {
    // 原版下界传送门、末地传送门、末地折跃门，以及龙之研究 1.20.1 的混沌晶体（DEContent 中注释了 ITEM_CHAOS_CRYSTAL）仅有 Block 而无对应 Item：
    //   注意：原版并不存在名为 `minecraft:block/end_portal` 的方块图集纹理（原版末地传送门使用的是 Special BlockEntity 渲染器与 `entity/end_portal.png`，
    //   直接写 `.texture('minecraft:block/end_portal')` 会因找不到贴图变成紫黑丢失材质块）。
    //   因此这里为末地传送门与末地折跃门直接生成引用原版真实存在的方块图集纹理（`end_portal_frame_top` / `black_concrete` / `sculk` / `bedrock`）的 3D 模型；
    //   为 `epiphy:chaos_crystal` 挂载与 DE `RenderTileChaosCrystal` / `RenderItemChaosShard` 同源的 CCL 3D OBJ + Chaos Shader 物品渲染器（直接读取 `draconicevolution:models/block/chaos_crystal.obj` 与 DE 纹理/着色器，不在 kubejs/assets/epiphy 下新增任何资源文件）。
    StartupEvents.registry('item', function (event) {
        // 1. 下界传送门（使用原版真实存在的动态流体纹理 minecraft:block/nether_portal）
        event.create('epiphy:nether_portal')
            .displayName('下界传送门')
            .texture('minecraft:block/nether_portal')
            .rarity('epic')

        // 2. 末地传送门（扁平传送门平面模型，使用原版图集内真实存在的 end_portal_frame_top 与 black_concrete 纹理，消除紫黑块）
        var endPortalItem = event.create('epiphy:end_portal')
            .displayName('末地传送门')
            .rarity('epic')
        endPortalItem.modelJson({
            parent: 'minecraft:block/block',
            textures: {
                particle: 'minecraft:block/end_portal_frame_top',
                top:      'minecraft:block/black_concrete',
                side:     'minecraft:block/end_portal_frame_side',
                bottom:   'minecraft:block/end_portal_frame_top'
            },
            elements: [
                {
                    from: [0, 6, 0],
                    to:   [16, 12, 16],
                    faces: {
                        down:  { texture: '#bottom' },
                        up:    { texture: '#top' },
                        north: { texture: '#side' },
                        south: { texture: '#side' },
                        west:  { texture: '#side' },
                        east:  { texture: '#side' }
                    }
                }
            ]
        })

        // 3. 末地折跃门（还原天然折跃门“上下基岩夹星芒暗域核心”的 3 层立体模型：与扁平的末地传送门风格呼应而轮廓有别）
        var endGatewayItem = event.create('epiphy:end_gateway')
            .displayName('末地折跃门')
            .rarity('epic')
        endGatewayItem.modelJson({
            parent: 'minecraft:block/block',
            textures: {
                particle: 'minecraft:block/sculk',
                core:     'minecraft:block/sculk',
                cap:      'minecraft:block/bedrock'
            },
            elements: [
                {
                    from: [2, 2.5, 2],
                    to:   [14, 13.5, 14],
                    faces: {
                        down:  { texture: '#core' },
                        up:    { texture: '#core' },
                        north: { texture: '#core' },
                        south: { texture: '#core' },
                        west:  { texture: '#core' },
                        east:  { texture: '#core' }
                    }
                },
                {
                    from: [3.5, 0, 3.5],
                    to:   [12.5, 2.5, 12.5],
                    faces: {
                        down:  { texture: '#cap' },
                        up:    { texture: '#cap' },
                        north: { texture: '#cap' },
                        south: { texture: '#cap' },
                        west:  { texture: '#cap' },
                        east:  { texture: '#cap' }
                    }
                },
                {
                    from: [3.5, 13.5, 3.5],
                    to:   [12.5, 16, 12.5],
                    faces: {
                        down:  { texture: '#cap' },
                        up:    { texture: '#cap' },
                        north: { texture: '#cap' },
                        south: { texture: '#cap' },
                        west:  { texture: '#cap' },
                        east:  { texture: '#cap' }
                    }
                }
            ]
        })

        // 4. 混沌晶体（方块物品形式：直接复用 draconicevolution 命名空间下的资源与 CCL OBJ + Shader 渲染管线）
        event.create('epiphy:chaos_crystal')
            .displayName('混沌晶体')
            .texture('draconicevolution:item/chaos_crystal')
            .rarity('epic')
    })

    // ------------------------------------------------------------------------
    // 客户端：为 epiphy:chaos_crystal 注册与 DE 原生一致的 3D 混沌晶体方块物品渲染器 (IItemRenderer)
    //   完全调用 Draconic Evolution 1.20.1 与 BrandonsCore / CodeChickenLib 内部资源：
    //   - 通过 KubeJS 原生 Platform / ForgeModEvents 挂载 ModelEvent$ModifyBakingResult，
    //     避开 ClassFilter 对 net.minecraftforge.fml.* 的拦截；
    //   - KubeJS/Rhino 在运行期加载了 MinecraftRemapper (mm.jsmappings) 与 TypeWrappers (EnumTypeWrapper)：
    //     1) JS 调用 MC 类须用 Mojmap（仅当 Mojmap 成员不存在时才回退 SRG，切勿吞掉方法调用异常）；
    //     2) CompositeStateBuilder.createCompositeState 同时存在 (boolean) 与 (OutlineProperty) 重载，
    //        因 EnumTypeWrapper 对 enum 权重为 0，传 boolean false 会误匹配 enum 重载并抛 argument type mismatch，
    //        故须显式传入 OutlineProperty.NONE（或无 AT 时的字符串 'none'）命中 m_110689_；
    //     3) JS 代理对象被 Java InterfaceAdapter 回调时按原生字节码名查找，须提供 SRG (m_7541_/m_7539_/m_7547_)；
    //   - 替换模型 key 使用标准物品变体 'inventory'；
    //   - 模型：draconicevolution:models/block/chaos_crystal.obj（与 RenderTileChaosCrystal 相同，多面体水晶柱）
    //   - 内层着色器：BCShaders.CHAOS_ENTITY_SHADER + draconicevolution:textures/item/equipment/chaos_shader.png
    //   - 外层半透明纹理：GameRenderer.getRendertypeCutoutShader() + draconicevolution:textures/block/chaos_crystal.png
    //   - 视角变换：TransformUtils.DEFAULT_BLOCK（标准 3D 方块物品视角，随游戏时间缓慢自转）
    // ------------------------------------------------------------------------
    var readMcMember = function (target, mojName, srgName) {
        if (target == null) return null
        var val
        var found = false
        try {
            val = target[mojName]
            if (val !== undefined) found = true
        } catch (eMoj) { }
        if (found) return val
        return target[srgName]
    }
    var callMcMember = function (target, mojName, srgName, arg0, arg1, arg2, arg3, arg4, arg5, arg6) {
        if (target == null) {
            throw new Error('Cannot call ' + mojName + ' / ' + srgName + ' on null target')
        }
        var fn
        try { fn = target[mojName] } catch (eMoj) { }
        var name = (typeof fn === 'function') ? mojName : srgName
        if (typeof fn !== 'function') {
            var srgFn = target[srgName]
            if (typeof srgFn !== 'function') {
                throw new Error('Missing Java method ' + mojName + ' / ' + srgName)
            }
        }
        var argc = arguments.length - 3
        switch (argc) {
            case 0: return target[name]()
            case 1: return target[name](arg0)
            case 7: return target[name](arg0, arg1, arg2, arg3, arg4, arg5, arg6)
        }
        throw new Error('Unsupported callMcMember argc=' + argc)
    }
    var buildCompositeStateNone = function (builder) {
        var outlineNone = null
        try {
            var $OutlineProperty = Java.loadClass('net.minecraft.client.renderer.RenderType$OutlineProperty')
            if ($OutlineProperty != null) {
                outlineNone = readMcMember($OutlineProperty, 'NONE', 'NONE')
            }
        } catch (eOutline) { }
        if (outlineNone != null) {
            return callMcMember(builder, 'createCompositeState', 'm_110689_', outlineNone)
        }
        return callMcMember(builder, 'createCompositeState', 'm_110689_', 'none')
    }

    if (typeof Platform !== 'undefined' && Platform.isClientEnvironment() && typeof ForgeModEvents !== 'undefined') {
        try {
            ForgeModEvents.onEvent('net.minecraftforge.client.event.ModelEvent$ModifyBakingResult', function (event) {
                try {
                    var $ModelResourceLocation = Java.loadClass('net.minecraft.client.resources.model.ModelResourceLocation')
                    var $ResourceLocation      = Java.loadClass('net.minecraft.resources.ResourceLocation')
                    var $OBJParser             = Java.loadClass('codechicken.lib.render.model.OBJParser')
                    var $CCModel               = Java.loadClass('codechicken.lib.render.CCModel')
                    var $CCRenderState         = Java.loadClass('codechicken.lib.render.CCRenderState')
                    var $IItemRenderer         = Java.loadClass('codechicken.lib.render.item.IItemRenderer')
                    var $TransformUtils        = Java.loadClass('codechicken.lib.util.TransformUtils')
                    var $Matrix4               = Java.loadClass('codechicken.lib.vec.Matrix4')
                    var $Vector3               = Java.loadClass('codechicken.lib.vec.Vector3')
                    var $BCShaders             = Java.loadClass('com.brandon3055.brandonscore.client.shader.BCShaders')
                    var $TimeKeeper            = Java.loadClass('com.brandon3055.brandonscore.api.TimeKeeper')
                    var $Minecraft             = Java.loadClass('net.minecraft.client.Minecraft')
                    var $GameRenderer          = Java.loadClass('net.minecraft.client.renderer.GameRenderer')
                    var $RenderStateShard      = Java.loadClass('net.minecraft.client.renderer.RenderStateShard')
                    var $ShaderStateShard      = Java.loadClass('net.minecraft.client.renderer.RenderStateShard$ShaderStateShard')
                    var $TextureStateShard     = Java.loadClass('net.minecraft.client.renderer.RenderStateShard$TextureStateShard')
                    var $RenderType            = Java.loadClass('net.minecraft.client.renderer.RenderType')
                    var $CompositeState        = Java.loadClass('net.minecraft.client.renderer.RenderType$CompositeState')
                    var $DefaultVertexFormat   = Java.loadClass('com.mojang.blaze3d.vertex.DefaultVertexFormat')
                    var $VertexFormatMode      = Java.loadClass('com.mojang.blaze3d.vertex.VertexFormat$Mode')
                    var $Supplier              = Java.loadClass('java.util.function.Supplier')

                    var map = new $OBJParser(new $ResourceLocation('draconicevolution', 'models/block/chaos_crystal.obj'))
                        .ignoreMtl()
                        .parse()
                    if (map == null || map.isEmpty()) {
                        console.warn('[Epiphy] 挂载混沌晶体 3D 物品模型失败：chaos_crystal.obj 解析为空')
                        return
                    }
                    var crystalModel = $CCModel.combine(map.values())
                        .backfacedCopy()
                        .computeNormals()

                    var newEntityFormat = readMcMember($DefaultVertexFormat, 'NEW_ENTITY', 'f_85812_')
                    var translucentTrans = readMcMember($RenderStateShard, 'TRANSLUCENT_TRANSPARENCY', 'f_110139_')
                    var noCull = readMcMember($RenderStateShard, 'NO_CULL', 'f_110110_')
                    var lightmapShard = readMcMember($RenderStateShard, 'LIGHTMAP', 'f_110152_')
                    var overlayShard = readMcMember($RenderStateShard, 'OVERLAY', 'f_110154_')

                    var innerShaderSup = new $Supplier({
                        get: function () {
                            return $BCShaders.CHAOS_ENTITY_SHADER.getShaderInstance()
                        }
                    })
                    var innerBuilder = callMcMember($CompositeState, 'builder', 'm_110628_')
                    innerBuilder = callMcMember(innerBuilder, 'setShaderState', 'm_173292_', new $ShaderStateShard(innerShaderSup))
                    innerBuilder = callMcMember(innerBuilder, 'setTextureState', 'm_173290_', new $TextureStateShard(new $ResourceLocation('draconicevolution', 'textures/item/equipment/chaos_shader.png'), true, false))
                    innerBuilder = callMcMember(innerBuilder, 'setTransparencyState', 'm_110685_', translucentTrans)
                    innerBuilder = callMcMember(innerBuilder, 'setCullState', 'm_110661_', noCull)
                    innerBuilder = callMcMember(innerBuilder, 'setLightmapState', 'm_110671_', lightmapShard)
                    innerBuilder = callMcMember(innerBuilder, 'setOverlayState', 'm_110677_', overlayShard)
                    var innerState = buildCompositeStateNone(innerBuilder)
                    var innerType = callMcMember(
                        $RenderType, 'create', 'm_173215_',
                        'draconicevolution:chaos_crystal_item_inner',
                        newEntityFormat,
                        $VertexFormatMode.TRIANGLES,
                        256,
                        false,
                        false,
                        innerState
                    )

                    var outerShaderSup = new $Supplier({
                        get: function () {
                            return callMcMember($GameRenderer, 'getRendertypeCutoutShader', 'm_172646_')
                        }
                    })
                    var outerBuilder = callMcMember($CompositeState, 'builder', 'm_110628_')
                    outerBuilder = callMcMember(outerBuilder, 'setShaderState', 'm_173292_', new $ShaderStateShard(outerShaderSup))
                    outerBuilder = callMcMember(outerBuilder, 'setTextureState', 'm_173290_', new $TextureStateShard(new $ResourceLocation('draconicevolution', 'textures/block/chaos_crystal.png'), false, false))
                    outerBuilder = callMcMember(outerBuilder, 'setTransparencyState', 'm_110685_', translucentTrans)
                    outerBuilder = callMcMember(outerBuilder, 'setLightmapState', 'm_110671_', lightmapShard)
                    outerBuilder = callMcMember(outerBuilder, 'setOverlayState', 'm_110677_', overlayShard)
                    var outerState = buildCompositeStateNone(outerBuilder)
                    var outerType = callMcMember(
                        $RenderType, 'create', 'm_173215_',
                        'draconicevolution:chaos_crystal_item_outer',
                        newEntityFormat,
                        $VertexFormatMode.TRIANGLES,
                        256,
                        false,
                        false,
                        outerState
                    )

                    var fnFalse = function () { return false }
                    var fnTrue = function () { return true }
                    var renderer = new $IItemRenderer({
                        renderItem: function (stack, displayContext, mStack, getter, packedLight, packedOverlay) {
                            var mat = new $Matrix4(mStack)
                            var ccrs = $CCRenderState.instance()
                            ccrs.reset()
                            ccrs.brightness = packedLight
                            ccrs.overlay = packedOverlay

                            var mc = callMcMember($Minecraft, 'getInstance', 'm_91087_')
                            var frameTime = (mc != null) ? callMcMember(mc, 'getFrameTime', 'm_91296_') : 0.0
                            var rot = ($TimeKeeper.getClientTick() + frameTime) / 40.0
                            mat.translate(0.5, 0.5, 0.5)
                            mat.rotate(rot, $Vector3.Y_POS)
                            // chaos_crystal.obj 高度跨度为 [-3.55, 3.29]（约 6.84 格），缩放到 0.22 使其刚好饱满呈现在物品栏与手持方块视角中
                            mat.scale(0.22)

                            var chaosShader = $BCShaders.CHAOS_ENTITY_SHADER
                            if (chaosShader != null) {
                                if (chaosShader.hasModelMatUniform()) chaosShader.getModelMatUniform().glUniformMatrix4f(new $Matrix4())
                                if (chaosShader.hasSimpleLightUniform()) chaosShader.getSimpleLightUniform().glUniform1b(true)
                                if (chaosShader.hasDisableLightUniform()) chaosShader.getDisableLightUniform().glUniform1b(false)
                                if (chaosShader.hasDisableOverlayUniform()) chaosShader.getDisableOverlayUniform().glUniform1b(false)
                            }

                            ccrs.bind(innerType, getter)
                            crystalModel.render(ccrs, mat)

                            ccrs.baseColour = -16 // 0xFFFFFFF0
                            ccrs.bind(outerType, getter)
                            crystalModel.render(ccrs, mat)
                        },
                        getModelState: function () {
                            return $TransformUtils.DEFAULT_BLOCK
                        },
                        m_7541_: fnFalse,
                        useAmbientOcclusion: fnFalse,
                        m_7539_: fnTrue,
                        isGui3d: fnTrue,
                        m_7547_: fnTrue,
                        usesBlockLight: fnTrue
                    })

                    var mrl = new $ModelResourceLocation(new $ResourceLocation('epiphy', 'chaos_crystal'), 'inventory')
                    event.getModels().put(mrl, renderer)
                } catch (eBake) {
                    console.warn('[Epiphy] 挂载混沌晶体 3D 物品模型失败：' + eBake)
                }
            })
        } catch (eClientInit) {
            console.warn('[Epiphy] 注册混沌晶体 3D 渲染监听失败：' + eClientInit)
        }
    }

    // ------------------------------------------------------------------------
    // 手持 epiphy:nether_portal / epiphy:end_portal / epiphy:end_gateway / epiphy:chaos_crystal 右键方块时，
    // 直接放置对应方块（在 startup_scripts 内通过 ForgeEvents 闭环）
    // ------------------------------------------------------------------------
    var $Blocks            = Java.loadClass('net.minecraft.world.level.block.Blocks')
    var $NetherPortalBlock = Java.loadClass('net.minecraft.world.level.block.NetherPortalBlock')
    var $DirectionAxis     = Java.loadClass('net.minecraft.core.Direction$Axis')
    var $SoundEvents       = Java.loadClass('net.minecraft.sounds.SoundEvents')
    var $SoundSource       = Java.loadClass('net.minecraft.sounds.SoundSource')
    var $InteractionResult = Java.loadClass('net.minecraft.world.InteractionResult')
    var $DEContent         = null
    var $DEDamage          = null
    var $TileChaosCrystal  = null
    try {
        $DEContent        = Java.loadClass('com.brandon3055.draconicevolution.init.DEContent')
        $DEDamage         = Java.loadClass('com.brandon3055.draconicevolution.init.DEDamage')
        $TileChaosCrystal = Java.loadClass('com.brandon3055.draconicevolution.blocks.tileentity.TileChaosCrystal')
    } catch (eDE) { }

    var PORTAL_ITEM_MAP = {
        'epiphy:end_portal':    'end_portal',
        'epiphy:end_gateway':   'end_gateway',
        'epiphy:nether_portal': 'nether_portal',
        'epiphy:chaos_crystal': 'chaos_crystal'
    }

    ForgeEvents.onEvent('net.minecraftforge.event.entity.player.PlayerInteractEvent$RightClickBlock', function (event) {
        var stack = event.getItemStack()
        if (stack == null || stack.isEmpty()) return

        var itemId = String(stack.getId())
        var portalType = PORTAL_ITEM_MAP[itemId]
        if (!portalType) return

        var level = event.getLevel()
        var player = event.getEntity()
        var clickedPos = event.getPos()
        var face = event.getFace()
        var clickedState = level.getBlockState(clickedPos)

        // 若被点击的方块本身可被替换（如草、雪层、蕨等）则原地替换，否则放置在点击面的相邻格
        var targetPos = clickedState.canBeReplaced()
            ? clickedPos
            : (face != null ? clickedPos.relative(face) : clickedPos)

        // ---- 混沌晶体专属放置与惩罚逻辑（对照 DE 1.20.1 ChaosCrystal.java:71-80 & TileChaosCrystal.java:51-63）----
        // 1. 空间校验（5 格高：placeCenter 及上下各 2 格）：
        //    - 若贴地面上表面点击且下方 2 格非空，自动将中心点上抬 2 格，使 5 格高水晶底座刚好落在地面上；
        //    - 校验 [placeCenter - 2, placeCenter + 2] 共 5 格垂直空间是否全部为空气或可替换方块；
        //    - 若高度不足 5 格，则默认不可放置（直接静默返回，不放置方块、不触发惩罚、也没有任何提示）。
        // 2. 5 格空间充足时：
        //    - 生存/冒险模式：放置无效，并使用新版 ChaosCrystal.java:79 的伤害源 DEDamage.chaosImplosion(level) 触发 Float.MAX_VALUE 惩罚；
        //    - 创造模式：放置中心方块并设为无保护模式（guardianDefeated = true）且调用 onValidPlacement() 自动生成上下各 2 格 chaos_crystal_part。
        if (portalType === 'chaos_crystal') {
            if ($DEContent == null || $TileChaosCrystal == null) return

            var placeCenter = targetPos
            if (face != null && String(face.getName()) === 'up') {
                var below1 = level.getBlockState(placeCenter.below(1))
                var below2 = level.getBlockState(placeCenter.below(2))
                if ((!below1.isAir() && !below1.canBeReplaced()) || (!below2.isAir() && !below2.canBeReplaced())) {
                    placeCenter = placeCenter.above(2)
                }
            }

            // 严格检查垂直 5 格（placeCenter - 2 到 placeCenter + 2）是否全部可放置；不足 5 格直接静默退出（不触发惩罚、无提示）
            for (var dy = -2; dy <= 2; dy++) {
                var checkPos = (dy === 0) ? placeCenter : (dy > 0 ? placeCenter.above(dy) : placeCenter.below(-dy))
                var checkState = level.getBlockState(checkPos)
                if (!checkState.isAir() && !checkState.canBeReplaced()) {
                    return
                }
            }

            var isCreative = (player != null && typeof player.isCreative === 'function')
                ? player.isCreative()
                : (player != null && player.getAbilities != null && player.getAbilities().instabuild)

            if (!isCreative) {
                if (!level.isClientSide() && player != null) {
                    try {
                        var dmgSource = ($DEDamage != null)
                            ? $DEDamage.chaosImplosion(level)
                            : level.damageSources().fellOutOfWorld()
                        player.hurt(dmgSource, 3.4028235e38) // Float.MAX_VALUE，严格对齐 1.20.1 ChaosCrystal.java:79
                    } catch (eHurt) { }
                }
                event.setCancellationResult($InteractionResult.sidedSuccess(level.isClientSide()))
                event.setCanceled(true)
                return
            }

            if (!level.isClientSide()) {
                var crystalState = $DEContent.CHAOS_CRYSTAL.get().defaultBlockState()
                level.setBlock(placeCenter, crystalState, 3)
                var be = level.getBlockEntity(placeCenter)
                if (be instanceof $TileChaosCrystal) {
                    be.onValidPlacement()
                    be.guardianDefeated.set(true) // 无保护模式（解除红色护盾与无敌锁）
                }
                level.playSound(
                    null,
                    placeCenter,
                    $SoundEvents.END_PORTAL_FRAME_FILL,
                    $SoundSource.BLOCKS,
                    1.0,
                    0.75
                )
            }

            event.setCancellationResult($InteractionResult.sidedSuccess(level.isClientSide()))
            event.setCanceled(true)
            return
        }

        var targetState = level.getBlockState(targetPos)
        if (!targetState.isAir() && !targetState.canBeReplaced()) return

        if (!level.isClientSide()) {
            var newState = null
            if (portalType === 'end_portal') {
                newState = $Blocks.END_PORTAL.defaultBlockState()
            } else if (portalType === 'end_gateway') {
                newState = $Blocks.END_GATEWAY.defaultBlockState()
            } else if (portalType === 'nether_portal') {
                // 注意：KubeJS 的 EntityKJS 混入将 Entity.getDirection() 重命名为了 getFacing() / getHorizontalFacing()，
                // 直接调用 player.getDirection() 会因找不到方法抛出 TypeError 中断放置！
                var axis = $DirectionAxis.X
                try {
                    if (player != null) {
                        var dir = (typeof player.getHorizontalFacing === 'function')
                            ? player.getHorizontalFacing()
                            : player.facing
                        if (dir != null && dir.getAxis() === $DirectionAxis.X) {
                            axis = $DirectionAxis.Z
                        }
                    }
                } catch (eAxis) { }
                newState = $Blocks.NETHER_PORTAL.defaultBlockState().setValue($NetherPortalBlock.AXIS, axis)
            }

            if (newState != null) {
                // 下界传送门（minecraft:nether_portal）在 updateShape 收到邻居状态更新时会校验周围是否有完整黑曜石框架，
                // 若直接用 flag=3 (UPDATE_ALL = BLOCK_UPDATE | SEND_TO_CLIENTS) 放置单个下界传送门方块，
                // 触发邻居形状更新后会立刻因“无黑曜石外框”自毁消失！
                // 因此使用 flag = 2 | 16 (SEND_TO_CLIENTS | KNOWN_SHAPE = 18) 同步客户端并跳过 updateShape 自检，使其可以像 /setblock ... keep 一样独立稳定存在。
                var placeFlags = (portalType === 'nether_portal') ? 18 : 3
                level.setBlock(targetPos, newState, placeFlags)
                level.playSound(
                    null,
                    targetPos,
                    (portalType === 'nether_portal') ? $SoundEvents.GLASS_PLACE : $SoundEvents.END_PORTAL_FRAME_FILL,
                    $SoundSource.BLOCKS,
                    1.0,
                    1.0
                )
                if (player == null || !player.isCreative()) {
                    stack.shrink(1)
                }
            }
        }

        event.setCancellationResult($InteractionResult.sidedSuccess(level.isClientSide()))
        event.setCanceled(true)
    })

    var HIDDEN_ITEMS = [
        // 1. 屏障
        'minecraft:barrier',

        // 2. 凋灵刷怪蛋与末影龙刷怪蛋
        'minecraft:wither_spawn_egg',
        'minecraft:ender_dragon_spawn_egg',

        // 3. 光源方块（仅保留 1 个标准光源方块）
        'minecraft:light',

        // 4. 结构方块与拼图方块
        'minecraft:structure_block',
        'minecraft:jigsaw',

        // 5. 命令方块及其全部变体
        'minecraft:command_block',
        'minecraft:repeating_command_block',
        'minecraft:chain_command_block',
        'minecraft:command_block_minecart',

        // 6. 下界传送门、末地传送门、末地折跃门（不含非隐藏物品末地传送门框架）
        'epiphy:nether_portal',
        'epiphy:end_portal',
        'epiphy:end_gateway',

        // 7. 混沌晶体 [龙之研究]
        'epiphy:chaos_crystal',

        // 8. 建筑师的青睐 [神秘遗物] & 终末之环 [启示录]
        'enigmaticlegacy:cosmic_scroll',
        'goety_revelation:halo_of_the_end'
    ]

    if (typeof global !== 'undefined' && global != null) {
        if (global.EpiphyCreativeTab != null && typeof global.EpiphyCreativeTab.register === 'function') {
            global.EpiphyCreativeTab.register(HIDDEN_ITEMS)
        } else {
            if (!Array.isArray(global.EpiphyCreativeTabQueue)) {
                global.EpiphyCreativeTabQueue = []
            }
            for (var i = 0; i < HIDDEN_ITEMS.length; i++) {
                global.EpiphyCreativeTabQueue.push(HIDDEN_ITEMS[i])
            }
        }
    }
})()
