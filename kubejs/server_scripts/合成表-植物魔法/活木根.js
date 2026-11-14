// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
ServerEvents.recipes(event => {
    event.remove({output:'botania:livingwood_twig'})
     
})

ServerEvents.recipes(event => {
	event.shaped(
 Item.of('botania:livingwood_twig', 1),
 [
'BA ',
'AB ',
'   '
 ],
 {
A:'#botania:livingwood_logs',
B:'twilightforest:liveroot'
})})

ServerEvents.recipes(event => {
	event.shaped(
 Item.of('botania:livingwood_twig', 1),
 [
'A  ',
'   ',
'   '
 ],
 {
A:'botanicpledge:world_ash_branch'
})})
