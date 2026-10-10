const fs=require('node:fs'),vm=require('node:vm'),Core=require('../../web/core.js');

function fixture({ register, catalog, crystals, images, crystalSystems, loader, knowledge, classes, engine, native, timers } = {}) {
  class Element {
    constructor(id) { this.id=id;this.innerHTML='';this.value='';this.hidden=false;this.disabled=false;this.checked=false;this.listeners={};this.style={};this.dataset={};this.naturalWidth=256;this.naturalHeight=256;this.clientWidth=300;this.clientHeight=300;this.classList={add(){},remove(){},toggle(){}}; }
    addEventListener(type,fn) { (this.listeners[type] ||= []).push(fn); }
    fire(type,event={}) { for(const fn of this.listeners[type] || [])fn(event); }
    insertAdjacentHTML(position,markup){if(position==='beforeend')this.innerHTML+=markup;else if(position==='afterbegin')this.innerHTML=markup+this.innerHTML;else (this.adjacent ||= []).push({position,markup});}
    focus(){} scrollIntoView(){} setAttribute(){} removeAttribute(){}
    showModal(){this.open=true;} close(){this.open=false;this.fire('close');}
    getContext(){return {drawImage:(...args)=>{this.drawn=args[0];this.drawArgs=args;}};}
    toDataURL(){return 'data:image/jpeg;base64,'+Buffer.from(this.drawn?.src||'thumbnail').toString('base64');}
  }
  const elements=new Map(),created=[],revoked=[], node=id=>{if(!elements.has(id))elements.set(id,new Element(id));return elements.get(id);};
  const groups={'.view':['view-identify','view-library','view-records','view-settings'].map(node),'[data-guide-title]':Array.from({length:6},(_,i)=>{const el=node('guide-'+i);el.dataset.guideTitle='指南 '+i;return el;}),'dialog':['guideDialog','cameraDialog','videoDialog','detailDialog','recordDialog','confirmDialog'].map(node)};
  groups['[data-view]']=['identify','library','records','settings'].map(view=>{const el=node('nav-'+view);el.dataset.view=view;return el;});
  groups['[data-mode]']=['offline','online'].map(mode=>{const el=node('mode-'+mode);el.dataset.mode=mode;return el;});
  groups['[data-scene]']=['daily','lab'].map(scene=>{const el=node('scene-'+scene);el.dataset.scene=scene;return el;});
  const saved=new Map(), local=new Map(), listeners={}, documentListeners={}, confirmations=[];
  let hash='#identify',imageId=0,analysisError,confirmResult=true;
  const result=()=>({key:'quartz',score:.8,status:'uncertain',reasons:[],rankings:[{key:'quartz',score:.8}],checks:[],agreement:1,photoCount:1,modelCount:1});
  const context={ document:{querySelector:s=>s==='dialog[open]'?groups.dialog.find(el=>el.open):node(s.slice(1)),querySelectorAll:s=>groups[s]||[],createElement:tag=>{const element=new Element(tag);created.push(element);return element;},addEventListener:(type,fn)=>{(documentListeners[type] ||= []).push(fn);} ,body:{classList:{add(){},remove(){}}}},
    location:{protocol:'http:',hostname:'127.0.0.1',href:'http://127.0.0.1/test/',get hash(){return hash;},set hash(v){hash=v.startsWith('#')?v:'#'+v;}},
    navigator:{onLine:true,serviceWorker:register?{register}:undefined}, caches:{},
    addEventListener:(type,fn)=>{listeners[type]=fn;},requestAnimationFrame:fn=>fn(),matchMedia:()=>({matches:true}),
    setTimeout:timers?.setTimeout||( (fn,ms)=>{const timer=setTimeout(fn,ms);timer.unref();return timer;}),clearTimeout:timers?.clearTimeout||clearTimeout,AbortController,DOMException,Date,Math,Promise,Map,Set,Number,String,Array,Object,Blob,TextDecoder,
    crypto:{randomUUID:()=>`record-${saved.size+1}`},URL:{createObjectURL:()=>`blob:photo-${++imageId}`,revokeObjectURL:url=>revoked.push(url)},
    localStorage:{getItem:key=>local.get(key)||null,setItem:(key,value)=>local.set(key,value)},confirm:message=>{confirmations.push(message);return confirmResult;},
    MINERAL_KB:{quartz:{name_zh:'石英',name_en:'Quartz',formula:'SiO₂',classification:{class_9:'氧化物/氢氧化物'}}},MINERAL_CLASSES:{quartz:{zh:'石英'}},MINERAL_SOURCES:[],MineralCore:Core,MineralGallery:require('../../web/gallery.js'),
    MineralEngine:{image:async src=>({src,naturalWidth:256,naturalHeight:256}),analyze:async()=>{if(analysisError)throw analysisError;return result();},models:[],modelResources:manifest=>manifest.models.map(model=>({...model,url:new URL(model.path,'http://127.0.0.1/test/').href+'?fixture-model-sha='+model.sha256}))},
    SpecimenStore:{migrate:async()=>{},list:async()=>[...saved.values()],put:async record=>{saved.set(record.id,record);return record;}} };
  context.window=context;context.window.scrollTo=()=>{};if(catalog)context.MINERAL_CATALOG=catalog;if(crystals)context.MINERAL_CRYSTAL_RECORDS=crystals;if(images)context.MINERAL_IMAGE_SOURCES=images;if(crystalSystems)context.MINERAL_CRYSTAL_SYSTEM_ANNOTATIONS=crystalSystems;if(loader)context.MineralReference=loader;if(knowledge)context.MINERAL_KB=knowledge;if(classes)context.MINERAL_CLASSES=classes;if(engine)Object.assign(context.MineralEngine,engine);if(native)context.Capacitor={isNativePlatform:()=>true,registerPlugin:name=>native[name]};
  node('classScheme').value='class_9';node('precision').checked=true;
  for(const id of ['preview','cropFrame','result','analysisRecovery','inputSummary'])node(id).hidden=true;
  vm.runInNewContext(fs.readFileSync(require.resolve('../../web/history.js'),'utf8'),context,{filename:'history.js'});
  vm.runInNewContext(fs.readFileSync(require.resolve('../../web/media.js'),'utf8'),context,{filename:'media.js'});
  vm.runInNewContext(fs.readFileSync(require.resolve('../../web/app.js'),'utf8'),context,{filename:'app.js'});
  const settle=async()=>{for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));};
  const photoFile=(width=256,height=256)=>{const bytes=Buffer.alloc(33);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);bytes.writeUInt32BE(13,8);bytes.write('IHDR',12);bytes.writeUInt32BE(width,16);bytes.writeUInt32BE(height,20);const file=new Blob([bytes],{type:'image/png'});file.name='specimen.png';return file;};
  return {node,saved,created,revoked,confirmations,context,settle,photoFile,documentClick:async(selector,dataset={})=>{const target={closest:query=>query===selector?{dataset}:null};for(const fn of documentListeners.click||[])fn({target});await settle();},setError:error=>{analysisError=error;},setConfirmation:value=>{confirmResult=value;},route:view=>{context.location.hash=view;listeners.hashchange();},click:async id=>{node(id).fire('click');await settle();},photo:async()=>{node('fileInput').files=[photoFile()];node('fileInput').fire('change');await settle();}};
}

module.exports={fixture};
