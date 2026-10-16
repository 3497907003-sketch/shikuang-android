const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./helpers/app-fixture.cjs');

test('a previous queued close does not abort a newly opened gallery read',async()=>{
  const record={id:'commons-42',mineral_name:'Quartz',model_key:'quartz',local_image_url:'images/reviewed-v25/commons-42.jpg',
    bytes:4,sha256:'a'.repeat(64),permission_status:'per_file_license_and_source_reviewed',
    image_page_url:'https://example.test/photo',license_url:'https://creativecommons.org/licenses/by-sa/4.0/',
    author:'Contract fixture',quality_review:'Contract only, not a training photo',group_id:'fixture:42',width:224,height:224};
  const f=fixture({images:{records:[record]}});await f.settle();
  f.context.document.getElementById=id=>f.node(id);
  const image=f.node('gallery-image-commons-42');image.getAttribute=key=>image[key]||null;
  let finish,signal;f.context.MineralGallery={...f.context.MineralGallery,read:(_,options)=>{
    signal=options.signal;return new Promise(resolve=>{finish=resolve;});
  }};
  await f.documentClick('[data-detail]',{detail:'quartz'});
  const section=f.node('detailBody .image-section');section.open=true;section.fire('toggle');
  assert.equal(f.node('detailDialog').open,true);assert.equal(signal.aborted,false);
  f.node('detailDialog').fire('close');assert.equal(signal.aborted,false);
  finish(Uint8Array.from([255,216,255,217]));await f.settle();assert.match(image.src,/^blob:/);assert.equal(f.revoked.length,0);
  f.node('detailDialog').close();assert.equal(signal.aborted,true);assert.deepEqual(f.revoked,[image.src]);
});
