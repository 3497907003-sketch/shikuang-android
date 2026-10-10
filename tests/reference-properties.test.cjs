const test=require('node:test');
const assert=require('node:assert/strict');
const core=require('../web/core.js');

test('English source lustre supports the same physical comparison as Chinese observations',()=>{
  assert.equal(core.evidenceFor({luster:'Vitreous; pearly on cleavage surfaces'},{luster:'nonmetal'})[0].status,'match');
  assert.equal(core.evidenceFor({luster:'Metallic'},{luster:'nonmetal'})[0].status,'conflict');
  assert.equal(core.evidenceFor({luster:'Non-metallic'},{luster:'metal'})[0].status,'conflict');
});

test('a verified hardness range is retained instead of treating its midpoint as exact',()=>{
  assert.deepEqual(core.hardnessRange('5–6'),[5,6]);
  assert.equal(core.evidenceFor({hardness:'5–6'},{hardness:'5'})[0].status,'match');
  assert.equal(core.evidenceFor({hardness:'5–6'},{hardness:'2'})[0].status,'conflict');
});

test('crystal directions are never mistaken for hardness values',()=>{
  for(const hardness of ['2.5 ∥ [001]; 4 ⊥ [001]','5.5 ∥ [001], 7 ∥ [100]']) {
    assert.equal(core.hardnessRange(hardness),null);
    assert.deepEqual(core.evidenceFor({hardness},{hardness:'1'}),[]);
  }
  assert.deepEqual(core.hardnessRange('2½–3'),[2.5,3]);
});
