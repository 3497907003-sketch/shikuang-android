const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {verify}=require('../tools/verify-sync.cjs');

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'shikuang-shared-assets-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const dist=path.join(root,'dist'),assets=path.join(root,'assets'),canonical=path.join(root,'canonical');
  for(const directory of [dist,assets,canonical]) {
    fs.mkdirSync(path.join(directory,'models'),{recursive:true});
    fs.writeFileSync(path.join(directory,'index.html'),'<main>识矿</main>');
    fs.writeFileSync(path.join(directory,'model-manifest.json'),JSON.stringify({models:[{path:'models/fixture.onnx'}]}));
    fs.writeFileSync(path.join(directory,'models/fixture.onnx'),'public engineering bytes; no executable model');
  }
  fs.writeFileSync(path.join(assets,'cordova.js'),'bridge');
  fs.writeFileSync(path.join(assets,'cordova_plugins.js'),'bridge plugins');
  return {dist,assets,canonical};
}

function symlink(t,target,name,type) {
  try {fs.symlinkSync(target,name,type);return true;}
  catch(error){if(['EPERM','EACCES','ENOSYS','ENOTSUP'].includes(error.code)){t.skip('Host cannot create the symlink test fixture: '+error.code);return false;}throw error;}
}

test('packaged shared assets are also identical to canonical Web assets',t=>{
  const {dist,assets,canonical}=fixture(t);
  assert.deepEqual(verify(dist,assets,canonical),{assets:3,models:1,canonicalWebCompared:true});
});
test('locally matching Android files cannot conceal a different canonical release',t=>{
  const {dist,assets,canonical}=fixture(t);
  fs.writeFileSync(path.join(canonical,'index.html'),'<main>stale release</main>');
  assert.throws(()=>verify(dist,assets,canonical),/canonical Web differs/);
});
test('stale packaged non-model scripts fail sync verification',t=>{
  const {dist,assets}=fixture(t);
  fs.writeFileSync(path.join(assets,'obsolete-worker.js'),'stale');
  assert.throws(()=>verify(dist,assets),/Unused\/stale Android asset: obsolete-worker/);
});
test('canonical asset set must also be exact',t=>{
  const {dist,assets,canonical}=fixture(t);
  fs.writeFileSync(path.join(canonical,'extra.js'),'not shared');
  assert.throws(()=>verify(dist,assets,canonical),/Unused\/stale canonical Web asset/);
});
test('symlink cannot replace a packaged asset',t=>{
  const {dist,assets}=fixture(t);
  fs.unlinkSync(path.join(assets,'index.html'));
  if(!symlink(t,path.join(dist,'index.html'),path.join(assets,'index.html'),'file'))return;
  assert.throws(()=>verify(dist,assets),/Symlink in shared assets/);
});
test('a symlink root cannot masquerade as canonical Web provenance',t=>{
  const {dist,assets,canonical}=fixture(t),link=canonical+'-link';
  if(!symlink(t,dist,link,'dir'))return;
  assert.throws(()=>verify(dist,assets,link),/Symlink shared asset root/);
});
test('Android build tree cannot be passed as its own canonical Web comparison',t=>{
  const {dist,assets}=fixture(t);
  assert.throws(()=>verify(dist,assets,dist),/Canonical Web must be a separate build tree/);
});
