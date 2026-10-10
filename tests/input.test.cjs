const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../web/core.js'),H=require('../web/history.js'),M=require('../web/media.js');
test('animal classes never receive mineral candidates when screening is strong',()=>{
 const scores=Array(1000).fill(-10); scores[258]=10;
 assert.equal(C.screen(scores,[]).rejected,true);
 assert.equal(C.screen(scores,[]).message,'这不是矿物，请您放入清晰的矿物照片。');
 const uncertain=Array(1000).fill(0);assert.equal(C.screen(uncertain,Array(1000).fill(true)).rejected,false);
});
test('screening validates outputs before any decision',()=>{assert.throws(()=>C.screen([1,2]));assert.throws(()=>C.screen(Array(1000).fill(NaN)));});
test('search history preserves separate record and library searches and deduplicates',()=>{
 let rows=H.add([], ' Calcite ', 'library',1);rows=H.add(rows,'CALCITE','library',2);rows=H.add(rows,'calcite','records',3);
 assert.equal(rows.length,2);assert.equal(rows[1].time,2);assert.equal(rows[0].kind,'records');
 for(let i=0;i<30;i++)rows=H.add(rows,String(i),'library',i);assert.equal(rows.length,20);
 assert.deepEqual(H.normalize([{query:' ',kind:'library'},{query:'q',kind:'other'}]),[]);
});
test('video entrance rejects images and oversized uploads',()=>{
 assert.throws(()=>M.validateVideo({name:'sample.jpg',type:'image/jpeg',size:100}));
 assert.throws(()=>M.validateVideo({name:'sample.mp4',type:'video/mp4',size:101*1024*1024}));
 assert.doesNotThrow(()=>M.validateVideo({name:'sample.mp4',type:'',size:100}));
});
test('video frames stay within duration and reject invalid or long videos',()=>{
 assert.deepEqual(M.frameTimes(20),[3,10,17]);assert.deepEqual(M.frameTimes(.2),[.1]);
 for(const value of [0,NaN,Infinity,91])assert.throws(()=>M.frameTimes(value));
});
