// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
ItemEvents.tooltip(event => {
  var LINES = [
    '可以将任何物品还原成它的材料...甚至一些更原始的东西。',
    '藉由无尽之力运行，它相当不稳定。',
    '§6谨慎放置！'
  ]

  event.addAdvanced('twilightforest:uncrafting_table', (stack, advanced, text) => {
    // 幂等：先移除已存在的同内容行（倒序删，避免索引位移）
    for (var i = text.size() - 1; i >= 0; i--) {
      if (LINES.includes(text.get(i).getString())) text.remove(i)
    }
    LINES.forEach(s => text.add(s))
  })
})