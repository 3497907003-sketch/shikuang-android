const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./helpers/app-fixture.cjs');

async function savingHarness(failure){
  const f=fixture();await f.settle();await f.photo();await f.click('predictBtn');
  const images=[],canvases=[],create=f.context.document.createElement;
  f.context.MineralEngine.image=async src=>{const img={src,naturalWidth:256,naturalHeight:256,removeAttribute(name){assert.equal(name,'src');this.src='';}};images.push(img);return img;};
  f.context.document.createElement=tag=>{
    if(tag!=='canvas')return create(tag);
    if(failure==='create')throw Error('synthetic canvas construction failure');
    const canvas={width:0,height:0,getContext(){if(failure==='context')return null;return {drawImage(){if(failure==='draw')throw Error('synthetic thumbnail draw failure');}};},toDataURL(){if(failure==='encode')throw Error('synthetic thumbnail encoding failure');return 'data:image/jpeg;base64,AAAA';}};
    canvases.push(canvas);return canvas;
  };
  return {f,images,canvases};
}
function released(h){assert.equal(h.images.length,1);assert.equal(h.images[0].src,'','thumbnail must release the owned decoded image');assert.ok(h.canvases.every(canvas=>canvas.width===0&&canvas.height===0),'thumbnail must release owned canvas backing');}

test('saving a thumbnail releases working surfaces and retains the submitted source and encoded record',async()=>{
  const h=await savingHarness();const source=h.f.node('preview').src;await h.f.click('saveBtn');await h.f.until(()=>!h.f.node('saveBtn').disabled);released(h);assert.equal(h.f.node('preview').src,source);assert.equal([...h.f.saved.values()][0].photos[0],'data:image/jpeg;base64,AAAA');
});
test('thumbnail canvas creation or unavailable context releases the decoded image without saving a partial record',async()=>{
  for(const failure of ['create','context']){const h=await savingHarness(failure);await h.f.click('saveBtn');await h.f.until(()=>!h.f.node('saveBtn').disabled);released(h);assert.equal(h.f.saved.size,0);}
});
test('thumbnail drawing or encoding failure releases working surfaces and permits an explicit retry',async()=>{
  for(const failure of ['draw','encode']){
    const h=await savingHarness(failure);await h.f.click('saveBtn');await h.f.until(()=>!h.f.node('saveBtn').disabled);released(h);assert.equal(h.f.saved.size,0);
    h.f.context.document.createElement=()=>({width:0,height:0,getContext:()=>({drawImage(){}}),toDataURL:()=> 'data:image/jpeg;base64,AAAA'});
    await h.f.click('saveBtn');await h.f.until(()=>!h.f.node('saveBtn').disabled);assert.equal(h.f.saved.size,1);assert.ok(h.images.every(image=>image.src===''));
  }
});
