const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');

function fixture({metadata=true,onSeek}={}){
  const events=new Map(),revoked=[],draws=[];
  const video={duration:4,videoWidth:640,videoHeight:480,paused:false,
    addEventListener(name,fn){(events.get(name)||events.set(name,new Set()).get(name)).add(fn);},
    removeEventListener(name,fn){events.get(name)?.delete(fn);},
    emit(name){for(const fn of [...events.get(name)||[]])fn();},
    load(){if(metadata&&this.src)queueMicrotask(()=>this.emit('loadedmetadata'));},
    pause(){this.paused=true;},removeAttribute(name){delete this[name];},
    set currentTime(value){this.time=value;if(onSeek)onSeek(this,value);else queueMicrotask(()=>this.emit('seeked'));}
  };
  const canvas={getContext:()=>({drawImage:()=>draws.push(video.time)}),toDataURL:()=>`frame-${video.time}`};
  const ctx={module:{exports:{}},setTimeout,clearTimeout,Number,Error,URL:{createObjectURL:()=> 'blob:video',revokeObjectURL:url=>revoked.push(url)},document:{createElement:type=>type==='video'?video:canvas}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../web/media.js'),'utf8'),ctx,{filename:'media.js'});
  return {api:ctx.module.exports,video,events,revoked,draws};
}
const file={name:'specimen.mp4',type:'video/mp4',size:100};

test('cancel before metadata immediately releases video URL and listeners',async()=>{
  const f=fixture({metadata:false}),controller=new AbortController();
  const extraction=f.api.extractVideo(file,()=>{},{signal:controller.signal});controller.abort();
  await assert.rejects(extraction,{name:'AbortError'});assert.deepEqual(f.revoked,['blob:video']);assert.equal(f.video.paused,true);
  assert.equal([...f.events.values()].reduce((total,set)=>total+set.size,0),0);assert.equal(f.draws.length,0);
});

test('cancel during seek prevents late frames being drawn or returned',async()=>{
  const controller=new AbortController(),f=fixture({onSeek:(video)=>{controller.abort();queueMicrotask(()=>video.emit('seeked'));}});
  await assert.rejects(f.api.extractVideo(file,()=>{},{signal:controller.signal}),{name:'AbortError'});
  assert.equal(f.draws.length,0);assert.deepEqual(f.revoked,['blob:video']);
});

test('successful video extraction returns chronological distinct frames and cleans resources',async()=>{
  const f=fixture();const result=await f.api.extractVideo(file);
  assert.deepEqual(Array.from(result.frames,x=>x.time),[.6,2,3.4]);assert.deepEqual(f.draws,[.6,2,3.4]);assert.deepEqual(f.revoked,['blob:video']);assert.equal(f.video.paused,true);
});
