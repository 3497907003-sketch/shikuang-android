const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {revision,render}=require('../web/tools/shell-release.cjs');
const root=path.resolve(__dirname,'../web');
test('offline content changes invalidate both worker and shell while repeat builds keep their identity',()=>{
  const base=['index.html','core.js','sw.js','data/sources.js'].map(name=>[name,fs.readFileSync(path.join(root,name))]);
  const a=revision(base),again=revision([...base].reverse());assert.equal(a,again);
  const changed=base.map(([name,bytes])=>[name,name==='data/sources.js'?Buffer.concat([bytes,Buffer.from('\n// Another reviewed source')]):bytes]);
  const b=revision(changed);assert.notEqual(a,b);
  for(const name of ['index.html','core.js','sw.js'])assert.notDeepEqual(render(name,base.find(x=>x[0]===name)[1],a),render(name,base.find(x=>x[0]===name)[1],b));
  assert.throws(()=>revision([...base,base[0]]),/Duplicate/);
});
test('built HTML, application and worker share identity and preserve the model cache and script order',()=>{
  const id='a'.repeat(64),source=fs.readFileSync(path.join(root,'core.js'));
  const context={URL};vm.runInNewContext(render('core.js',source,id).toString(),context);
  const built=context.MineralCore,original=require('../web/core.js');
  assert.equal(built.OFFLINE_CACHES.shell,'shikuang-static-shell-'+id);
  assert.equal(built.OFFLINE_CACHES.models,original.OFFLINE_CACHES.models);
  const html=fs.readFileSync(path.join(root,'index.html')),output=render('index.html',html,id).toString();
  const scripts=text=>[...text.matchAll(/\bsrc="([^\"]+)"/g)].map(x=>new URL(x[1],'https://example.org/app/').pathname);
  assert.deepEqual(scripts(output),scripts(html.toString()));
  for(const url of built.shellAssets(output,'https://example.org/app/'))if(/\.(?:js|css)$/.test(new URL(url).pathname))assert.equal(new URL(url).searchParams.get('v'),'shell-'+id);
  assert.match(render('sw.js',fs.readFileSync(path.join(root,'sw.js')),id).toString(),new RegExp('core\\.js\\?v=shell-'+id));
  assert.deepEqual(render('model-manifest.json',Buffer.from('{"kept":true}'),id),Buffer.from('{"kept":true}'));
  assert.throws(()=>render('core.js',Buffer.from('marker missing'),id),/marker/);
  assert.throws(()=>render('sw.js',Buffer.from('marker missing'),id),/marker/);
});
