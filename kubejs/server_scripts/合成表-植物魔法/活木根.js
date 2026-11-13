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
