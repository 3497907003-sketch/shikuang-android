const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const Core = require('../web/core.js');

function fixture({ register } = {}) {
  class Element {
    constructor(id) { this.id=id;this.value='';this.hidden=false;this.disabled=false;this.checked=false;this.listeners={};this.style={};this.dataset={};this.naturalWidth=256;this.naturalHeight=256;this.clientWidth=300;this.clientHeight=300;this.classList={add(){},remove(){},toggle(){}}; }
    addEventListener(type,fn) { (this.listeners[type] ||= []).push(fn); }
    fire(type,event={}) { for(const fn of this.listeners[type] || [])fn(event); }
    focus(){} scrollIntoView(){} setAttribute(){} removeAttribute(){}
    showModal(){this.open=true;} close(){this.open=false;this.fire('close');}
    getContext(){return {drawImage:image=>{this.drawn=image;}};}
    toDataURL(){return 'data:image/jpeg;base64,'+Buffer.from(this.drawn?.src||'thumbnail').toString('base64');}
  }
  const elements=new Map(), node=id=>{if(!elements.has(id))elements.set(id,new Element(id));return elements.get(id);};
  const groups={'.view':['view-identify','view-library','view-records','view-settings'].map(node),'[data-guide-title]':Array.from({length:6},(_,i)=>{const el=node('guide-'+i);el.dataset.guideTitle='指南 '+i;return el;}),'dialog':['guideDialog','cameraDialog','videoDialog','detailDialog','recordDialog','confirmDialog'].map(node)};
  groups['[data-view]']=['identify','library','records','settings'].map(view=>{const el=node('nav-'+view);el.dataset.view=view;return el;});
  groups['[data-mode]']=['offline','online'].map(mode=>{const el=node('mode-'+mode);el.dataset.mode=mode;return el;});
  groups['[data-scene]']=['daily','lab'].map(scene=>{const el=node('scene-'+scene);el.dataset.scene=scene;return el;});
  const saved=new Map(), local=new Map(), listeners={}, confirmations=[];
  let hash='#identify',imageId=0,analysisError,confirmResult=true;
  const result=()=>({key:'quartz',score:.8,status:'uncertain',reasons:[],rankings:[{key:'quartz',score:.8}],checks:[],agreement:1,photoCount:1,modelCount:1});
  const context={ document:{querySelector:s=>s==='dialog[open]'?groups.dialog.find(el=>el.open):node(s.slice(1)),querySelectorAll:s=>groups[s]||[],createElement:tag=>new Element(tag),addEventListener(){} ,body:{classList:{add(){},remove(){}}}},
    location:{protocol:'http:',hostname:'127.0.0.1',href:'http://127.0.0.1/test/',get hash(){return hash;},set hash(v){hash=v.startsWith('#')?v:'#'+v;}},
    navigator:{onLine:true,serviceWorker:register?{register}:undefined}, caches:{},
    addEventListener:(type,fn)=>{listeners[type]=fn;},requestAnimationFrame:fn=>fn(),matchMedia:()=>({matches:true}),
    setTimeout:(fn,ms)=>{const timer=setTimeout(fn,ms);timer.unref();return timer;},clearTimeout,AbortController,DOMException,Date,Math,Promise,Map,Set,Number,String,Array,Object,
    crypto:{randomUUID:()=>`record-${saved.size+1}`},URL:{createObjectURL:()=>`blob:photo-${++imageId}`,revokeObjectURL(){}},
    localStorage:{getItem:key=>local.get(key)||null,setItem:(key,value)=>local.set(key,value)},confirm:message=>{confirmations.push(message);return confirmResult;},
    MINERAL_KB:{quartz:{name_zh:'石英',name_en:'Quartz',formula:'SiO₂',classification:{class_9:'氧化物/氢氧化物'}}},MINERAL_CLASSES:{quartz:{zh:'石英'}},MINERAL_SOURCES:[],MineralCore:Core,
    MineralEngine:{image:async src=>({src,naturalWidth:256,naturalHeight:256}),analyze:async()=>{if(analysisError)throw analysisError;return result();},models:[]},
    SpecimenStore:{migrate:async()=>{},list:async()=>[...saved.values()],put:async record=>{saved.set(record.id,record);return record;}} };
  context.window=context;context.window.scrollTo=()=>{};
  node('classScheme').value='class_9';node('precision').checked=true;
  vm.runInNewContext(fs.readFileSync(require.resolve('../web/history.js'),'utf8'),context,{filename:'history.js'});
  vm.runInNewContext(fs.readFileSync(require.resolve('../web/app.js'),'utf8'),context,{filename:'app.js'});
  const settle=async()=>{for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));};
  return {node,saved,confirmations,context,settle,setError:error=>{analysisError=error;},setConfirmation:value=>{confirmResult=value;},route:view=>{context.location.hash=view;listeners.hashchange();},click:async id=>{node(id).fire('click');await settle();},photo:async()=>{node('fileInput').files=[{name:'specimen.jpg',type:'image/jpeg',size:100}];node('fileInput').fire('change');await settle();}};
}

test('same specimen updates its saved record after retry, precision changes and crop edits',async()=>{
  const f=fixture();await f.photo();await f.click('predictBtn');await f.click('saveBtn');
  assert.equal(f.saved.size,1);const id=[...f.saved.keys()][0];
  f.node('precision').checked=false;f.node('precision').fire('change');await f.click('predictBtn');await f.click('saveBtn');
  f.node('cropRange').value='75';f.node('cropRange').fire('input');await f.click('predictBtn');await f.click('saveBtn');
  assert.equal(f.saved.size,1);assert.equal([...f.saved.keys()][0],id);
  f.node('notes').value='新的观察';f.node('notes').fire('input');await f.click('newSample');
  assert.equal(f.confirmations.length,1);assert.equal(f.saved.size,1);assert.equal(f.node('notes').value,'');assert.equal(f.node('preview').hidden,true);
  await f.photo();await f.click('predictBtn');await f.click('saveBtn');assert.equal(f.saved.size,2);
});

test('failed analysis keeps submitted photos and exposes a working retry',async()=>{
  const f=fixture();await f.photo();f.setError(new Error('资源读取失败'));await f.click('predictBtn');
  assert.equal(f.node('analysisRecovery').hidden,false);assert.equal(f.node('preview').hidden,false);assert.equal(f.node('predictBtn').disabled,false);
  f.setError(null);await f.click('retryAnalysis');assert.equal(f.node('analysisRecovery').hidden,true);assert.equal(f.node('result').hidden,false);
});

test('offline preparation can cancel a stalled service worker and restore retry controls',async()=>{
  const f=fixture({register:()=>new Promise(()=>{})});await f.click('offlineBtn');
  assert.equal(f.node('offlineBtn').disabled,true);assert.equal(f.node('cancelOffline').hidden,false);
  await f.click('cancelOffline');assert.equal(f.node('offlineBtn').disabled,false);assert.equal(f.node('cancelOffline').hidden,true);assert.match(f.node('offlineProgress').textContent,/准备已停止/);
});

test('declining new specimen confirmation preserves unsaved photo and observations',async()=>{
  const f=fixture();await f.photo();f.node('notes').value='保留观察';f.node('notes').fire('input');f.setConfirmation(false);
  await f.click('newSample');assert.equal(f.node('preview').hidden,false);assert.equal(f.node('notes').value,'保留观察');assert.equal(f.node('predictBtn').disabled,false);
});

test('leaving identification cancels video extraction and refuses late frames',async()=>{
  const f=fixture();await f.photo();let complete,signal;
  f.context.MineralMedia={extractVideo:(_file,_report,options)=>{signal=options.signal;return new Promise(resolve=>{complete=resolve;});}};
  f.node('videoInput').files=[{name:'specimen.mp4',type:'video/mp4',size:100}];f.node('videoInput').fire('change');await f.settle();
  assert.equal(f.node('cancelInput').hidden,false);assert.equal(f.node('predictBtn').disabled,true);
  f.route('records');assert.equal(signal.aborted,true);
  complete({duration:4,frames:[{src:'data:image/jpeg;base64,TEFURQ==',time:2}]});await f.settle();
  assert.match(f.node('inputSummary').textContent,/已提交 1 张/);assert.equal(f.node('cancelInput').hidden,true);assert.equal(f.node('galleryBtn').disabled,false);
});
