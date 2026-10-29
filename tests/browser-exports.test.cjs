const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
const WEB=fs.existsSync(path.join(__dirname,'../web/core.js'))?'../web/':'../';
const root=process.env.SHIKUANG_CLASSIC_EXPORT_ROOT||path.resolve(__dirname,WEB);
const entries=[['compat.js','MineralCompat'],['history.js','SearchHistory'],['media.js','MineralMedia'],['core.js','MineralCore'],['research-input.js','ShikuangResearchInput'],['research/shikuang-research-native-roi-q16-torchf32-v1/encoded-header.js','ShikuangEncodedHeader'],['research-photo.js','ShikuangResearchPhoto'],['viewport.js','MineralViewport']];

// Source-only host contracts: no images, model weights, network, or inference.
function realm({browser=false,commonJS=false,requireTrap=false}={}){
  let requireCalls=0;
  const context=vm.createContext({localStorage:{getItem:()=>null}});
  if(browser)vm.runInContext('window=this;',context);
  if(commonJS)context.module={exports:{}};
  if(requireTrap)context.require=()=>{requireCalls++;throw Error('A browser must not use the host require');};
  return {context,requireCalls:()=>requireCalls};
}
function run(file,context){vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),context,{filename:file});}
function browserApis(context,commonJS){
  for(const [file,key] of entries){
    run(file,context);
    assert.ok(context[key],`${file} must publish ${key}`);
    if(commonJS)assert.equal(context.module.exports,context[key],`${file} must share one factory result between both exports`);
  }
  assert.equal(vm.runInContext('SearchHistory.read().length',context),0);
  assert.equal(vm.runInContext('SearchHistory.add([], "石英", "library", 1)[0].query',context),'石英');
  assert.equal(typeof context.MineralCore.workerAssets,'function');
  assert.equal(typeof context.MineralMedia.scaledDimensions,'function');
  assert.equal(typeof context.MineralViewport.start,'function');
  assert.equal(typeof context.ShikuangResearchPhoto.createClient,'function');
}
test('classic scripts publish usable browser APIs without a CommonJS host',()=>{
  browserApis(realm({browser:true}).context,false);
});
test('a browser with module.exports and no require still publishes every classic API',()=>{
  const {context}=realm({browser:true,commonJS:true});
  assert.equal(vm.runInContext('typeof require',context),'undefined');
  browserApis(context,true);
});
test('browser script dependencies ignore a coexisting host require and use the same Window APIs',()=>{
  const state=realm({browser:true,commonJS:true,requireTrap:true});
  browserApis(state.context,true);
  assert.equal(state.requireCalls(),0);
});
test('pure CommonJS retains its exports without adding browser API globals',()=>{
  for(const [file,key] of entries){
    const {context}=realm({commonJS:true});
    context.require=createRequire(path.join(root,file));
    run(file,context);
    assert.ok(Object.keys(context.module.exports).length,`${file} must retain its Node export`);
    assert.equal(context[key],undefined,`${file} must not pollute a Node global`);
    assert.equal(vm.runInContext('typeof window',context),'undefined');
  }
});
test('plain Worker globals still receive compat and core without a Window',()=>{
  const {context}=realm();vm.runInContext('self=this;',context);
  run('compat.js',context);run('core.js',context);
  assert.equal(typeof context.MineralCompat.readText,'function');
  assert.equal(typeof context.MineralCore.workerAssets,'function');
  assert.equal(vm.runInContext('typeof window',context),'undefined');
});
