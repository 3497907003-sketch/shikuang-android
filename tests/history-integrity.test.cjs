const test=require('node:test'),assert=require('node:assert/strict'),History=require('../web/history.js');
test('malformed empty history entries do not hide later valid searches',()=>{
 const rows=[...Array.from({length:20},()=>({query:'  ',kind:'library',time:1})),{query:'石英',kind:'library',time:2}];assert.deepEqual(History.normalize(rows),[{query:'石英',kind:'library',time:2}]);const added=History.add(rows,'方解石','records',3);assert.equal(added.length,2);assert.equal(added[1].query,'石英');
});
test('search recovery still bounds valid entries and keeps record/library kinds distinct',()=>{
 const rows=Array.from({length:30},(_,i)=>({query:'query-'+i,kind:i%2?'records':'library',time:i}));assert.equal(History.normalize(rows).length,20);const next=History.add(rows,'QUERY-0','records',99);assert.equal(next[0].kind,'records');assert.ok(next.some(x=>x.kind==='library'&&x.query==='query-0'));assert.equal(next.length,20);
});
