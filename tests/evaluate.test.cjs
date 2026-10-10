const test=require('node:test'), assert=require('node:assert/strict');
const {evaluate}=require('../tools/evaluate.cjs');
const labels=['quartz','calcite'];
const make=(id,label,values,scene='lab')=>({id,label,scene,split:'test',runs:[{model:'a',photo:0,values},{model:'b',photo:0,values}]});
test('evaluation separates coverage, correctness and unknown false certainty',()=>{
 const report=evaluate({schema:'shikuang-evaluation-v2',labels,specimens:[make('q','quartz',[.9,.1]),make('c','calcite',[.51,.49]),make('n','unknown',[.99,.01],'daily')]},labels,{});
 const m=report.groups['test/all'];assert.equal(m.top1,.5);assert.equal(m.kappa,0);assert.equal(m.top5,1);assert.equal(m.strongSignalCoverage,.5);assert.equal(m.strongSignalAccuracy,1);assert.equal(m.unknownStrongSignalRate,1);
});
test('evaluation never reports accuracy without data or across conflicting label maps',()=>{
 assert.throws(()=>evaluate({schema:'shikuang-evaluation-v2',labels,specimens:[]},labels,{}));
 assert.throws(()=>evaluate({schema:'shikuang-evaluation-v2',labels:[...labels].reverse(),specimens:[make('q','quartz',[.9,.1])]},labels,{}));
});
test('duplicate specimens across calibration and test cannot inflate reported accuracy',()=>{
 const a=make('same','quartz',[.9,.1]), b={...a,split:'calibration'};
 assert.throws(()=>evaluate({schema:'shikuang-evaluation-v2',labels,specimens:[a,b]},labels,{}));
});
test('current reports use manifest temperatures and the explicitly selected mode',()=>{
 const {fixture,raw,hash}=require('./helpers/model-contract.cjs'),{manifest}=fixture();manifest.models[0].temperature=2;
 const manifestHash=hash(Buffer.from(JSON.stringify(manifest))),result=raw(manifest);
 const data={schema:'shikuang-evaluation-v3',labels,modelVersion:manifest.version,manifestSha256:manifestHash,models:manifest.models.map(m=>({id:m.id,sha256:m.sha256,temperature:m.temperature})),specimens:[{...make('lab:q','quartz',[]),...result,label_basis:'arithmetic fixture, not real accuracy',photos:[{sha256:'a'.repeat(64)}]}]};
 const contract={manifest,manifestHash,mode:'fast'},fast=evaluate(data,labels,{},[],contract);
 assert.equal(fast.mode,'fast');assert.equal(fast.prediction_manifest_audited,true);assert.ok(Math.abs(fast.rows[0].score-1/(1+Math.exp(-2)))<1e-12);
 const ensemble=evaluate(data,labels,{},[],{...contract,mode:'ensemble'});assert.ok(ensemble.rows[0].score>fast.rows[0].score);
 assert.throws(()=>evaluate({...data,manifestSha256:'b'.repeat(64)},labels,{},[],contract),/different model/);
 data.specimens[0].runs.pop();assert.throws(()=>evaluate(data,labels,{},[],contract),/未完成/);
});
test('current reports cannot duplicate a photo under different specimen identifiers',()=>{
 const {fixture,raw,hash}=require('./helpers/model-contract.cjs'),{manifest}=fixture(),result=raw(manifest),manifestHash=hash(Buffer.from(JSON.stringify(manifest)));
 const specimen={...make('lab:q','quartz',[]),...result,label_basis:'arithmetic fixture',photos:[{sha256:'a'.repeat(64)}]};
 const data={schema:'shikuang-evaluation-v3',labels,modelVersion:manifest.version,manifestSha256:manifestHash,models:manifest.models.map(m=>({id:m.id,sha256:m.sha256,temperature:m.temperature})),specimens:[specimen,{...specimen,id:'another:q'}]};
 assert.throws(()=>evaluate(data,labels,{},[],{manifest,manifestHash}),/photo cannot be repeated/);
});
