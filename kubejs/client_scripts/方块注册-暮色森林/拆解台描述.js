ItemEvents.tooltip(event => {
  const LINES = [
    '可以将任何物品还原成它的材料...甚至一些更原始的东西。',
    '藉由无尽之力运行，它相当不稳定。',
    '§6谨慎放置！'
  ]

  event.addAdvanced('twilightforest:uncrafting_table', (stack, advanced, text) => {
    // 幂等：先移除已存在的同内容行（倒序删，避免索引位移）
    for (let i = text.size() - 1; i >= 0; i--) {
      if (LINES.indexOf(text.get(i).getString()) !== -1) text.remove(i)
    }
    LINES.forEach(s => text.add(s))
  })
})