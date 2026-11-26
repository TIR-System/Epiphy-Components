// ============================================================================
//  原版配方补充 —— 附魔金苹果 (Minecraft Vanilla)
//  许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
//  放置位置：kubejs/server_scripts/合成表-原版/附魔苹果.js
//  依赖说明：纯原版物品配方，零第三方 Mod 依赖。
// ============================================================================

;(function () {
    ServerEvents.recipes(function (event) {
        event.shaped(
            Item.of('minecraft:enchanted_golden_apple', 1),
            [
                'AAA',
                'ABA',
                'AAA'
            ],
            {
                A: 'minecraft:gold_block',
                B: 'minecraft:apple'
            }
        )
    })
})()
