const test=require('node:test'),assert=require('node:assert/strict'),Core=require('../web/core.js');
const record=id=>({id,time:1,name:'石英',rankings:[{key:'quartz',score:.8}],score:.8});
const backup=records=>JSON.stringify({schema:'shikuang-records',version:2,records});
test('damaged backups cannot fabricate new specimens from missing or invalid IDs',()=>{
 for(const id of [undefined,null,'','   ',17,true,'x'.repeat(101)])assert.throws(()=>Core.parseImport(backup([record(id)])),/编号|记录/);
});
test('valid backup identity is stable across repeated imports',()=>{
 const text=backup([record('specimen-one')]);assert.equal(Core.parseImport(text)[0].id,'specimen-one');assert.equal(Core.parseImport(text)[0].id,'specimen-one');
});
