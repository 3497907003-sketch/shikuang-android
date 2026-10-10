const test=require('node:test'),assert=require('node:assert/strict'),{webcrypto,createHash}=require('node:crypto');
const Gallery=require('../web/gallery.js'),Core=require('../web/core.js');
const bytes=Uint8Array.from([255,216,255,217]); // Byte contract fixture, not a training photo.
const record=()=>({local_image_url:'images/reviewed-v25/commons-42.jpg',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),
 permission_status:'per_file_license_and_source_reviewed',image_page_url:'https://example.test/photo/42',license_url:'https://creativecommons.org/licenses/by-sa/3.0',author:'Contract author',quality_review:'Byte contract only',group_id:'test:42',width:224,height:512});
const options={crypto:webcrypto,core:Core,base:'https://example.test/shikuang/'};
test('reviewed local photos require source evidence and bounded paths sizes and dimensions',()=>{
 const r=record();assert.equal(Gallery.asset(r).path,r.local_image_url);assert.equal(Gallery.asset({}),null);
 for(const change of [{local_image_url:'../secret.jpg'},{local_image_url:'https://other.test/a.jpg'},{bytes:Gallery.MAX_BYTES+1},{width:223},{height:513},{permission_status:'unverified_photo_reuse_permission'},{quality_review:''}])assert.throws(()=>Gallery.asset({...r,...change}));
 assert.throws(()=>Gallery.validateAssets({schema_version:1,assets:[{path:r.local_image_url,bytes:r.bytes,sha256:r.sha256},{path:r.local_image_url,bytes:r.bytes,sha256:r.sha256}]}),/重复/);
});
test('corrupt cached photo cannot display; a verified reload repairs the exact identity',async()=>{
 const calls=[],r=record(),fetch=async(url,init)=>{calls.push({url,cache:init.cache});return new Response(calls.length===1?Uint8Array.from([255,216,0,0]):bytes,{headers:{'Content-Type':'image/jpeg'}});};
 const actual=await Gallery.read(r,{...options,fetch});assert.deepEqual(actual,bytes);assert.deepEqual(calls.map(x=>x.cache),['default','reload']);assert.ok(calls.every(x=>new URL(x.url).searchParams.get('image')===r.sha256));
});
test('a canceled body stops without waiting for the stream or publishing photo bytes',async()=>{
 let canceled=false;const controller=new AbortController();
 const stream=new ReadableStream({pull(){},cancel(){canceled=true;return new Promise(()=>{});}});
 const pending=Gallery.read(record(),{...options,signal:controller.signal,fetch:async()=>new Response(stream)});
 await new Promise(resolve=>setImmediate(resolve));controller.abort();await assert.rejects(pending,error=>error.name==='AbortError');assert.equal(canceled,true);
});
