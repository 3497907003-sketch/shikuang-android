const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const Media=require('../web/media.js'),source=fs.readFileSync(require.resolve('../web/media.js'),'utf8');
// Header/decoder engineering fixtures only. No photo, model, private test or
// real browser decode is loaded. Root separately checks actual JPEG/PNG parity.
const segment=(marker,payload)=>{const h=Buffer.from([255,marker,0,0]);h.writeUInt16BE(payload.length+2,2);return Buffer.concat([h,payload]);};
function exif(orientation,little=true){
  const t=Buffer.alloc(26),u16=(n,p)=>little?t.writeUInt16LE(n,p):t.writeUInt16BE(n,p),u32=(n,p)=>little?t.writeUInt32LE(n,p):t.writeUInt32BE(n,p);
  t.write(little?'II':'MM');u16(42,2);u32(8,4);u16(1,8);u16(274,10);u16(3,12);u32(1,14);u16(orientation,18);return segment(225,Buffer.concat([Buffer.from('Exif\0\0'),t]));
}
function jpeg(orientation=1,width=3,height=2,{little=true,extra=[],afterSOF=false,noExif=false}={}){
  const sof=Buffer.from([8,0,0,0,0,1,1,17,0]);sof.writeUInt16BE(height,1);sof.writeUInt16BE(width,3);
  const app=noExif?[]:[exif(orientation,little)],frame=segment(192,sof),scan=segment(218,Buffer.from([1,1,0,0,63,0]));
  return Buffer.concat([Buffer.from([255,216]),...(afterSOF?[frame,...app]:[...app,frame]),...extra,scan,Buffer.from([0,255,217])]);
}
function png(width,height){const b=Buffer.alloc(33);Buffer.from([137,80,78,71,13,10,26,10]).copy(b);b.writeUInt32BE(13,8);b.write('IHDR',12);b.writeUInt32BE(width,16);b.writeUInt32BE(height,20);return b;}
const data=bytes=>'data:image/jpeg;base64,'+bytes.toString('base64');
const expected={1:['ABC','DEF'],2:['CBA','FED'],3:['FED','CBA'],4:['DEF','ABC'],5:['AD','BE','CF'],6:['DA','EB','FC'],7:['FC','EB','DA'],8:['CF','BE','AD']};
function fixture({auto=false,fetcher,stallDecode=0,failDecode=0,manualTimers=false,FileReader}={}){
  const blobs=new Map(),normalized=new Map(),images=[],canvases=[],revoked=[],encoded=[],timers=new Map(),requests=[];let id=0,decodeCalls=0;
  class URLFixture extends URL{static createObjectURL(blob){const url='blob:engineering-'+(++id);blobs.set(url,blob);return url;}static revokeObjectURL(url){revoked.push(url);blobs.delete(url);}}
  class Decoder{
    constructor(){images.push(this);this.src='';}
    async decode(){
      decodeCalls++;if(stallDecode===decodeCalls)return new Promise(()=>{});if(failDecode===decodeCalls)throw Error('Browser decoder English error');
      if(normalized.has(this.src)){Object.assign(this,normalized.get(this.src));return;}
      const b=new Uint8Array(await blobs.get(this.src).arrayBuffer()),d=Media.imageDimensions(b);let orientation=1;
      if(d.format==='jpeg'){orientation=Media.jpegOrientation(b.subarray(0,512*1024)).orientation;encoded.push({bytes:b,orientation});}
      this.naturalWidth=d.width;this.naturalHeight=d.height;this.cells=d.width===3&&d.height===2?['ABC','DEF']:null;
      // Two distinct decoder behaviors. Production code must neutralize EXIF,
      // rather than branch on this behavior or a browser user agent.
      if(auto&&orientation!==1&&this.cells){this.cells=expected[orientation];this.naturalWidth=this.cells[0].length;this.naturalHeight=this.cells.length;}
    }
  }
  const document={createElement(type){assert.equal(type,'canvas');const c={width:0,height:0,matrix:[1,0,0,1,0,0],getContext(){return {setTransform:(...m)=>c.matrix=m,drawImage:img=>{
    if(!img.cells){c.cells=null;return;}const output=Array.from({length:c.height},()=>Array(c.width).fill('?')),[a,b,d,e,x,y]=c.matrix;
    for(let row=0;row<img.naturalHeight;row++)for(let col=0;col<img.naturalWidth;col++){const dx=Math.floor(a*(col+.5)+d*(row+.5)+x),dy=Math.floor(b*(col+.5)+e*(row+.5)+y);output[dy][dx]=img.cells[row][col];}c.cells=output.map(r=>r.join(''));
  }};},toDataURL(type){assert.equal(type,'image/png');const url='data:image/png;base64,engineering-'+(++id);normalized.set(url,{naturalWidth:c.width,naturalHeight:c.height,cells:c.cells});return url;}};canvases.push(c);return c;}};
  const context={window:{},URL:URLFixture,Blob,Image:Decoder,document,AbortController,FileReader,
    atob:s=>Buffer.from(s,'base64').toString('binary'),setTimeout:manualTimers?(fn,ms)=>{const id=timers.size+1;timers.set(id,{fn,ms});return id;}:setTimeout,clearTimeout:manualTimers?id=>timers.delete(id):clearTimeout,
    fetch:async(url,options)=>{requests.push({url,options});return fetcher?fetcher(url,options):new Response(jpeg());}};
  vm.runInNewContext(source,context);
  return {api:context.window.MineralMedia,images,canvases,revoked,encoded,blobs,timers,requests,get decodeCalls(){return decodeCalls;},expire(){const t=[...timers.values()].find(t=>t.ms===15000);assert.ok(t);t.fn();}};
}
test('bounded TIFF parser reads all eight directions, both byte orders, APP1 after SOF and repeated consistent tags',()=>{
  for(const little of [true,false])for(let o=1;o<=8;o++)assert.equal(Media.jpegOrientation(jpeg(o,3,2,{little})).orientation,o);
  assert.equal(Media.jpegOrientation(jpeg(6,3,2,{afterSOF:true})).orientation,6);
  assert.equal(Media.jpegOrientation(jpeg(1,3,2,{noExif:true})).positions.length,0);
  assert.equal(Media.jpegOrientation(jpeg(6,3,2,{extra:[exif(6,false)]})).positions.length,2);
});
test('malformed TIFF fields, loops, offsets, conflicting tags and incomplete JPEG headers fail closed',()=>{
  const mutations=[(b,t)=>b.write('ZZ',t),(b,t)=>b.writeUInt16LE(43,t+2),(b,t)=>b.writeUInt32LE(0xffffffff,t+4),(b,t)=>b.writeUInt32LE(0,t+4),(b,t)=>b.writeUInt16LE(65535,t+8),(b,t)=>b.writeUInt16LE(4,t+12),(b,t)=>b.writeUInt32LE(2,t+14),(b,t)=>b.writeUInt16LE(9,t+18),(b,t)=>b.writeUInt32LE(8,t+22),
    (b,t)=>{b.writeUInt16LE(270,t+10);b.writeUInt16LE(2,t+12);b.writeUInt32LE(20,t+14);b.writeUInt32LE(0xffffffff,t+18);}];
  for(const mutate of mutations){const b=jpeg(6),t=b.indexOf(Buffer.from('Exif\0\0'))+6;mutate(b,t);assert.throws(()=>Media.jpegOrientation(b),/EXIF/);}
  assert.throws(()=>Media.jpegOrientation(jpeg(6,3,2,{extra:[exif(8)]})),/EXIF/);
  for(const end of [0,3,12,30,40])assert.throws(()=>Media.jpegOrientation(jpeg(6).subarray(0,end)),/EXIF/);
});
test('all eight corner permutations are identical with legacy and auto-orienting decoders; input bytes are preserved',async()=>{
  for(let o=1;o<=8;o++){
    const original=jpeg(o),before=Buffer.from(original);
    for(const auto of [false,true]){
      const f=fixture({auto}),img=await f.api.decodePhoto(data(original));
      assert.deepEqual(img.cells,expected[o],`orientation ${o}, auto ${auto}`);assert.equal(img.naturalWidth,expected[o][0].length);assert.equal(img.naturalHeight,expected[o].length);
      assert.equal(f.encoded[0].orientation,1);assert.equal(f.blobs.size,0);assert.equal(f.revoked.length,1);
      assert.ok(f.canvases.every(c=>c.width===0&&c.height===0));assert.ok(img.src);
      assert.equal(f.decodeCalls,o===1?1:2);assert.deepEqual(original,before);
    }
  }
});
test('no EXIF/orientation1/PNG avoids a canvas or another lossy image encoding',async()=>{
  for(const bytes of [jpeg(1),jpeg(1,3,2,{noExif:true}),png(3,2)]){
    const f=fixture(),uri=bytes[0]===137?'data:image/png;base64,'+bytes.toString('base64'):data(bytes);
    const img=await f.api.decodePhoto(uri);assert.equal(img.naturalWidth,3);assert.equal(f.canvases.length,0);assert.equal(f.decodeCalls,1);
  }
});
test('rotated output canvas is limited to 1536 after exchanging axes; original JPEG dimensions remain checked',async()=>{
  const f=fixture(),img=await f.api.decodePhoto(data(jpeg(6,6000,4000)));
  assert.equal(img.naturalWidth,1024);assert.equal(img.naturalHeight,1536);assert.equal(f.canvases.length,1);
  assert.deepEqual(f.canvases[0].matrix,[0,1536/6000,-1024/4000,0,1024,0]);
});
test('blob and native restored URLs use the same bounded source/header/decoder path',async()=>{
  for(const url of ['blob:chosen-file','https://localhost/_capacitor_file_/external/DCIM/specimen.jpg']){
    const f=fixture({fetcher:()=>new Response(jpeg(8))}),img=await f.api.decodePhoto(url);
    assert.deepEqual(img.cells,expected[8]);assert.equal(f.requests[0].url,url);assert.ok(f.requests[0].options.signal);assert.equal(f.blobs.size,0);
  }
});
test('20MiB/40MP/512KiB header rejection precedes Image/Canvas allocation',async()=>{
  let reads=0;const f=fixture();await assert.rejects(f.api.decodePhoto({size:20*1024*1024+1,slice(){},arrayBuffer(){reads++;}}),/20 MB/);assert.equal(reads,0);
  await assert.rejects(f.api.decodePhoto(data(jpeg(6,10000,10000))),/4000 万/);
  const huge=jpeg(6,3,2,{extra:Array.from({length:9},()=>segment(226,Buffer.alloc(65000)))});await assert.rejects(f.api.decodePhoto(data(huge)),/EXIF/);
  const g=fixture({fetcher:()=>new Response(new Uint8Array(1),{headers:{'content-length':String(20*1024*1024+1)}})});await assert.rejects(g.api.decodePhoto('blob:oversized'),/20 MB/);
  assert.equal(f.images.length+g.images.length,0);assert.equal(f.canvases.length+g.canvases.length,0);
});
test('15s covers stalled fetch and decode, aborts transports, releases URLs/images and suppresses late work',async()=>{
  let release;const response=new Promise(resolve=>release=resolve),f=fixture({manualTimers:true,fetcher:()=>response});
  const pending=f.api.decodePhoto('blob:stalled');await new Promise(resolve=>setImmediate(resolve));f.expire();await assert.rejects(pending,/超时/);assert.equal(f.requests[0].options.signal.aborted,true);
  release(new Response(jpeg(6)));await new Promise(resolve=>setImmediate(resolve));assert.equal(f.images.length,0);assert.equal(f.timers.size,0);
  const g=fixture({manualTimers:true,stallDecode:1}),decode=g.api.decodePhoto(data(jpeg(6)));await new Promise(resolve=>setImmediate(resolve));g.expire();await assert.rejects(decode,/超时/);
  assert.equal(g.images[0].src,'');assert.equal(g.blobs.size,0);assert.equal(g.canvases.length,0);
});
test('abort during final upright decode clears both Image sources and canvas without returning a late result',async()=>{
  const f=fixture({stallDecode:2}),c=new AbortController(),pending=f.api.decodePhoto(data(jpeg(7)),{signal:c.signal});
  while(f.decodeCalls<2)await new Promise(resolve=>setImmediate(resolve));c.abort();await assert.rejects(pending,{name:'AbortError'});
  assert.ok(f.images.every(i=>i.src===''));assert.equal(f.blobs.size,0);assert.ok(f.canvases.every(c=>c.width===0&&c.height===0));
});
test('old FileReader bytes share the deadline, support abort and release all callbacks',async()=>{
  let reader;class Reader{constructor(){reader=this;this.readyState=1;}readAsArrayBuffer(){}abort(){this.readyState=2;this.aborted=true;}}
  const f=fixture({FileReader:Reader,manualTimers:true}),c=new AbortController();const pending=f.api.decodePhoto({size:100,slice(){}},{signal:c.signal});await new Promise(resolve=>setImmediate(resolve));c.abort();await assert.rejects(pending,{name:'AbortError'});
  assert.equal(reader.aborted,true);assert.equal(reader.onload,null);assert.equal(reader.onerror,null);assert.equal(reader.onabort,null);assert.equal(f.images.length,0);
});
test('a stalled response body cannot outlive the total deadline even when reader cancellation never settles',async()=>{
  let cancelled=0;const body=new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled++;return new Promise(()=>{});}});
  const f=fixture({manualTimers:true,fetcher:()=>new Response(body)}),pending=f.api.decodePhoto('/native-stalled.jpg');await new Promise(resolve=>setImmediate(resolve));f.expire();await assert.rejects(pending,/超时/);
  assert.equal(cancelled,1);assert.equal(f.images.length,0);assert.equal(f.timers.size,0);
});
test('response length drift and unknown decoder errors fail in Chinese, release resources and permit a valid retry',async()=>{
  const f=fixture({fetcher:()=>new Response(jpeg(6),{headers:{'content-length':'999'}})});await assert.rejects(f.api.decodePhoto('/truncated.jpg'),/不完整/);assert.equal(f.images.length,0);
  for(const failDecode of [1,2]){const f=fixture({failDecode});await assert.rejects(f.api.decodePhoto(data(jpeg(6))),/无法解码|方向调整失败/);assert.equal(f.blobs.size,0);assert.ok(f.images.every(i=>i.src===''));assert.ok(f.canvases.every(c=>c.width===0&&c.height===0));assert.deepEqual((await f.api.decodePhoto(data(jpeg(6)))).cells,expected[6]);}
  const g=fixture({fetcher:()=>{throw TypeError('Failed to fetch');}});await assert.rejects(g.api.decodePhoto('/unreadable.jpg'),/照片文件无法读取/);
});
