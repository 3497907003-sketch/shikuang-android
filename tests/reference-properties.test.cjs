const test=require('node:test');
const assert=require('node:assert/strict');
const core=require('../web/core.js');
const facts=values=>({verified_properties:Object.fromEntries(Object.entries(values).map(([key,value])=>[key,{value,status:'verified',source_url:'https://www.handbookofmineralogy.org/pdfs/quartz.pdf'}]))});

test('English source lustre supports the same physical comparison as Chinese observations',()=>{
  assert.equal(core.evidenceFor(facts({luster:'Vitreous; pearly on cleavage surfaces'}),{luster:'nonmetal'})[0].status,'match');
  assert.equal(core.evidenceFor(facts({luster:'Metallic'}),{luster:'nonmetal'})[0].status,'conflict');
  assert.equal(core.evidenceFor(facts({luster:'Non-metallic'}),{luster:'metal'})[0].status,'conflict');
});

test('a verified hardness range is retained instead of treating its midpoint as exact',()=>{
  assert.deepEqual(core.hardnessRange('5–6'),[5,6]);
  assert.equal(core.evidenceFor(facts({hardness:'5–6'}),{hardness:'5'})[0].status,'match');
  assert.equal(core.evidenceFor(facts({hardness:'5–6'}),{hardness:'2'})[0].status,'conflict');
});

test('crystal directions are never mistaken for hardness values',()=>{
  for(const hardness of ['2.5 ∥ [001]; 4 ⊥ [001]','5.5 ∥ [001], 7 ∥ [100]']) {
    assert.equal(core.hardnessRange(hardness),null);
    assert.deepEqual(core.evidenceFor(facts({hardness}),{hardness:'1'}),[]);
  }
  assert.deepEqual(core.hardnessRange('2½–3'),[2.5,3]);
});

test('unreviewed or inferred legacy values never claim a physical match or conflict',()=>{
  const observation={hardness:'3',luster:'metal'};
  assert.deepEqual(core.evidenceFor({hardness:7,luster:'Vitreous'},observation),[]);
  for(const status of ['candidate','source_inferred','needs_review','unavailable']){
    const k=facts({hardness:7,luster:'Vitreous'});
    for(const value of Object.values(k.verified_properties))value.status=status;
    assert.deepEqual(core.evidenceFor(k,observation),[]);
  }
  const missingSource=facts({hardness:7});delete missingSource.verified_properties.hardness.source_url;
  assert.deepEqual(core.evidenceFor(missingSource,observation),[]);
  const k=facts({hardness:7,luster:'Vitreous'});
  for(const hardness of [null,'',undefined,0,11,'not measured'])assert.deepEqual(core.evidenceFor(k,{hardness}),[]);
  assert.deepEqual(core.evidenceFor(k,{luster:'unspecified'}),[]);
});
