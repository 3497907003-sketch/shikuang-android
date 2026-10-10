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
