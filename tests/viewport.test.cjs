const test=require('node:test'),assert=require('node:assert/strict');
const Viewport=require('../web/viewport.js');

function harness({visual=true}={}) {
  const frames=new Map(),classes=new Set();let next=0,scrollY=0;
  const target=()=>({addEventListener(type,fn){const list=this.events[type]||=new Set();list.add(fn);},removeEventListener(type,fn){this.events[type]?.delete(fn);},events:{},emit(type){for(const fn of this.events[type]||[])fn();}});
  const win=Object.assign(target(),{innerWidth:393,innerHeight:800,requestAnimationFrame(fn){const id=++next;frames.set(id,fn);return id;},cancelAnimationFrame(id){frames.delete(id);},scrollCalls:[],scrollBy(value){this.scrollCalls.push(value);scrollY+=value.top;},getComputedStyle(element){return element===nav?{display:classes.has('compact-editing')?'none':'grid',overflowY:'visible'}:{display:'block',overflowY:element.overflowY||'visible'};}});
  if(visual)win.visualViewport=Object.assign(target(),{height:800,width:393,offsetTop:0,scale:1});
  const nav={getBoundingClientRect(){const height=win.visualViewport?.height||win.innerHeight;return {top:height-64,bottom:height,width:393,height:64};}};
  const doc=Object.assign(target(),{visibilityState:'visible',activeElement:null,documentElement:{},body:{classList:{toggle(k,v){v?classes.add(k):classes.delete(k);},remove(k){classes.delete(k);}}},querySelector(selector){assert.equal(selector,'.bottom-nav');return nav;}});
  const field=(tag='TEXTAREA',type='text')=>({tagName:tag,type,value:'实验室备注：观察晶体',top:310,height:65,parentElement:null,isConnected:true,getBoundingClientRect(){let local=0;for(let p=this.parentElement;p;p=p.parentElement)local+=p.scrollTop||0;return {top:this.top-scrollY-local,bottom:this.top+this.height-scrollY-local,height:this.height,width:320};}});
  const flushOne=()=>{const batch=[...frames.values()];frames.clear();batch.forEach(fn=>fn());};
  const flush=()=>{let passes=0;while(frames.size){if(++passes>10)throw new Error('Unexpected animation loop');flushOne();}};
  const control=Viewport.start(win,doc);flush();
  return {win,doc,field,classes,flush,flushOne,control,focus(el){doc.activeElement=el;doc.emit('focusin');},blur(){doc.activeElement=null;doc.emit('focusout');},resize(height){if(win.visualViewport){win.visualViewport.height=height;win.visualViewport.emit('resize');}else{win.innerHeight=height;win.emit('resize');}},resetScroll(){scrollY=0;win.scrollCalls=[];}};
}

test('a notes field avoids the fixed navigation after visual viewport compression without losing Chinese content',()=>{
  const h=harness(),field=h.field();h.focus(field);h.resize(376);h.flush();
  assert(h.classes.has('compact-editing'));assert(field.getBoundingClientRect().bottom<=364);
  assert.equal(h.doc.activeElement,field);assert.equal(field.value,'实验室备注：观察晶体');
});
test('older layout-resizing WebViews receive the same editing protection without visualViewport',()=>{
  const h=harness({visual:false}),field=h.field();field.top=600;h.focus(field);h.resize(376);h.flush();
  assert(h.classes.has('compact-editing'));assert(field.getBoundingClientRect().bottom<=364);
});
test('ordinary desktop focus, minor browser toolbar changes and pinch zoom retain navigation',()=>{
  const h=harness(),field=h.field('INPUT','search');h.focus(field);h.flush();assert(!h.classes.has('compact-editing'));
  h.resize(745);h.flush();assert(!h.classes.has('compact-editing'));
  h.win.visualViewport.scale=2;h.resize(376);h.flush();assert(!h.classes.has('compact-editing'));
});
test('closing the keyboard while focus remains restores navigation and blur does not overwrite the full-height baseline',()=>{
  const h=harness(),field=h.field();h.focus(field);h.resize(376);h.flush();assert(h.classes.has('compact-editing'));
  h.blur();h.flush();assert(!h.classes.has('compact-editing'));
  h.focus(field);h.flush();assert(h.classes.has('compact-editing'));
  h.resize(800);h.flush();assert(!h.classes.has('compact-editing'));assert.equal(field.value,'实验室备注：观察晶体');
});
test('orientation changes do not mistake an old portrait baseline for a new landscape keyboard',()=>{
  const h=harness(),field=h.field();h.focus(field);h.resize(376);h.flush();assert(h.classes.has('compact-editing'));
  h.win.innerWidth=800;h.win.innerHeight=393;h.win.visualViewport.height=393;h.win.emit('orientationchange');h.flush();
  assert(!h.classes.has('compact-editing'));assert(field.getBoundingClientRect().bottom<=317);
  h.blur();h.flush();h.focus(field);h.resize(200);h.flush();assert(h.classes.has('compact-editing'));
});
test('viewport scroll does not repeatedly pull the reader back to a focused field',()=>{
  const h=harness(),field=h.field();h.focus(field);h.resize(376);h.flush();
  h.resetScroll();field.top=700;h.win.visualViewport.emit('scroll');h.flush();assert.equal(h.win.scrollCalls.length,0);
});
test('a dialog scrolls its own editor into view before moving the background',()=>{
  const h=harness(),field=h.field();field.top=650;field.parentElement={overflowY:'auto',scrollHeight:1000,clientHeight:220,scrollTop:0,parentElement:h.doc.documentElement};
  h.focus(field);h.resize(376);h.flush();assert(field.parentElement.scrollTop>0);assert.equal(h.win.scrollCalls.length,0);assert(field.getBoundingClientRect().bottom<=364);
});
test('a field inside the screen but clipped by a dialog scrollport remains completely visible',()=>{
  const h=harness(),field=h.field('INPUT');field.top=310;field.height=44;
  field.parentElement={overflowY:'auto',scrollHeight:1000,clientHeight:210,clientTop:0,scrollTop:0,parentElement:h.doc.documentElement,getBoundingClientRect(){return {top:80,bottom:290,width:320,height:210};}};
  h.focus(field);h.resize(376);h.flush();
  assert(field.getBoundingClientRect().top>=88);assert(field.getBoundingClientRect().bottom<=282);
  assert(field.parentElement.scrollTop>0);assert.equal(h.win.scrollCalls.length,0);assert.equal(field.value,'实验室备注：观察晶体');
});
test('a queued old editor cannot steal scrolling from a new focus and cleanup removes every listener',()=>{
  const h=harness(),first=h.field(),second=h.field('INPUT','search');first.top=700;second.top=25;
  h.focus(first);h.resize(376);
  // First update schedules alignment; the user changes focus before that frame.
  h.flushOne();h.doc.activeElement=second;h.flush();assert.equal(h.win.scrollCalls.length,0);
  h.focus(first);h.control.stop();h.flush();assert.equal(h.win.scrollCalls.length,0);assert(!h.classes.has('compact-editing'));
  for(const surface of [h.win,h.doc,h.win.visualViewport])for(const entries of Object.values(surface.events))assert.equal(entries.size,0);
});
test('sliders, file pickers, readonly and disconnected elements do not activate editing layout',()=>{
  const h=harness();for(const field of [h.field('INPUT','range'),h.field('INPUT','file'),Object.assign(h.field(),{readOnly:true}),Object.assign(h.field(),{isConnected:false})]){
    h.focus(field);h.resize(376);h.flush();assert(!h.classes.has('compact-editing'));
  }
});
