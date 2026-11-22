// ============================================================================
//  拆解台 · 混沌殉爆 —— 终极拆解台物品栏描述提示 (Client Tooltip)
//  许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
//  放置位置：kubejs/client_scripts/方块注册-暮色森林/拆解台描述.js
//  第三方 Mod 联动声明（玩法专属，原则见 README-LLM.md §3.3）：
//    - Twilight Forest（可选联动）：为 `twilightforest:uncrafting_table` 追加幂等警告提示；缺失该 Mod 时静默跳过。
// ============================================================================

;(function () {
    if (typeof Platform !== 'undefined' && Platform != null && typeof Platform.isLoaded === 'function' && !Platform.isLoaded('twilightforest')) {
        return
    }

    var LINES = [
        '可以将任何物品还原成它的材料...甚至一些更原始的东西。',
        '藉由无尽之力运行，它相当不稳定。',
        '§6谨慎放置！'
    ]

    ItemEvents.tooltip(function (event) {
        event.addAdvanced('twilightforest:uncrafting_table', function (stack, advanced, text) {
            // 幂等：先移除已存在的同内容行（倒序删，避免索引位移）
            for (var i = text.size() - 1; i >= 0; i--) {
                if (LINES.indexOf(String(text.get(i).getString())) >= 0) {
                    text.remove(i)
                }
            }
            for (var j = 0; j < LINES.length; j++) {
                text.add(LINES[j])
            }
        })
    })
})()
