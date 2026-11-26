// ============================================================================
//  联动配方调整 —— 植物魔法活木枝 (Botania / Twilight Forest / Botanic Pledge)
//  许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
//  放置位置：kubejs/server_scripts/合成表-植物魔法/活木根.js
//  第三方 Mod 联动声明（整合包玩法专属，原则见 README-LLM.md §3.3）：
//    - Botania（主目标）：修改 `botania:livingwood_twig` 配方；未安装 Botania 时静默跳过。
//    - Twilight Forest（可选分支）：存在时启用 `twilightforest:liveroot` 联动合成。
//    - Botanic Pledge（可选分支）：存在时启用 `botanicpledge:world_ash_branch` 转化合成。
// ============================================================================

;(function () {
    function isModLoaded(modId) {
        if (typeof Platform !== 'undefined' && Platform != null && typeof Platform.isLoaded === 'function') {
            return Boolean(Platform.isLoaded(modId))
        }
        return true
    }

    if (!isModLoaded('botania')) return

    ServerEvents.recipes(function (event) {
        var hasTf = isModLoaded('twilightforest')
        var hasBp = isModLoaded('botanicpledge')
        if (!hasTf && !hasBp) return

        event.remove({ output: 'botania:livingwood_twig' })

        if (hasTf) {
            event.shaped(
                Item.of('botania:livingwood_twig', 1),
                [
                    'BA ',
                    'AB ',
                    '   '
                ],
                {
                    A: '#botania:livingwood_logs',
                    B: 'twilightforest:liveroot'
                }
            )
        }

        if (hasBp) {
            event.shaped(
                Item.of('botania:livingwood_twig', 1),
                [
                    'A  ',
                    '   ',
                    '   '
                ],
                {
                    A: 'botanicpledge:world_ash_branch'
                }
            )
        }
    })
})()
