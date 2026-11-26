// ============================================================================
//  联动配方调整 —— 神秘遗物七咒之戒 (Enigmatic Legacy)
//  许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
//  放置位置：kubejs/server_scripts/合成表-魔法遗物相关/七咒.js
//  第三方 Mod 联动声明（整合包玩法专属，原则见 README-LLM.md §3.3）：
//    - Enigmatic Legacy（主目标）：新增 `enigmaticlegacy:cursed_ring` 合成配方；缺失该 Mod 时静默跳过。
// ============================================================================

;(function () {
    if (typeof Platform !== 'undefined' && Platform != null && typeof Platform.isLoaded === 'function' && !Platform.isLoaded('enigmaticlegacy')) {
        return
    }

    ServerEvents.recipes(function (event) {
        event.shaped(
            Item.of('enigmaticlegacy:cursed_ring', 1),
            [
                'ABA',
                'CDC',
                ' E '
            ],
            {
                A: 'minecraft:emerald',
                B: 'minecraft:ender_eye',
                C: 'minecraft:iron_block',
                D: 'minecraft:enchanted_golden_apple',
                E: 'minecraft:totem_of_undying'
            }
        )
    })
})()
