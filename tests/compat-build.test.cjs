const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const WEB=fs.existsSync(path.join(__dirname,'../web/core.js'))?'../web/':'../';
const compat=require(WEB+'tools/compat-js.cjs'),shell=require(WEB+'tools/shell-release.cjs');
const root=path.resolve(__dirname,WEB),compile=compat.transformer();
test('one pinned offline compiler lowers real worker/vendor/MJS syntax and keeps native modules',()=>{
  assert.equal(compat.toolchain().Babel.version,'8.0.7');
  assert.throws(()=>compat.assertSyntax('bad.js','x.a ||= x?.b ?? 1;'),/exceeds/);
  for(const name of ['app.js','core.js','engine-worker.js','sw.js','compat.js','native-assets.js','vendor/lucide.min.js','vendor/ort.min.js','vendor/ort-wasm-simd-threaded.mjs']){
    const output=compile(name,fs.readFileSync(path.join(root,name))).toString();assert.equal(compat.assertSyntax(name,output),true,name);
    if(name.endsWith('.mjs')){assert.match(output,/import\.meta/);assert.match(output,/export/);}
  }
  const generated=compile('probe.js',Buffer.from('const o={method(){return this;}}; const a=o?.method?.(); let x; x ||= a ?? 3; globalThis.answer=x;'));
  const context={};vm.runInNewContext(generated.toString(),context);assert.equal(typeof context.answer.method,'function');
});
test('stamp precedes compilation, dependency queries match shell and model cache identity is unchanged',()=>{
  const id='b'.repeat(64),contexts={};
  for(const name of ['core.js','engine-worker.js','sw.js']){
    const stamped=shell.render(name,fs.readFileSync(path.join(root,name)),id);
    const output=compile(name,stamped).toString();assert.match(output,new RegExp(id));
    const imports=[],messages=[],context={URL,Map,Set,onmessage:null,postMessage:m=>messages.push(m),importScripts:(...urls)=>imports.push(...urls),self:{registration:{scope:'https://local.test/app/'},addEventListener(){}},MineralCore:require(WEB+'core.js')};
    vm.runInNewContext(output,context);contexts[name]=context;
    if(name==='engine-worker.js'){assert.equal(messages[0].type,'ready');assert.equal(imports.length,3);assert.equal(new URL(imports[0],'https://local.test/app/').pathname,'/app/compat.js');}
    if(name!=='core.js')for(const url of imports)assert.equal(new URL(url,'https://local.test/app/').searchParams.get('v'),'shell-'+id);
  }
  const core=contexts['core.js'].MineralCore;
  assert.equal(core.OFFLINE_CACHES.models,require(WEB+'core.js').OFFLINE_CACHES.models);
  for(const url of core.workerAssets('https://local.test/app/'))assert.equal(new URL(url).searchParams.get('v'),'shell-'+id);
});
test('compiler, options, and every build rule are deterministic identity inputs, without node_modules',()=>{
  const names=require(WEB+'tools/build-inputs.json');assert.deepEqual(names,compat.BUILD_INPUT_PATHS);
  assert.equal(new Set(names).size,names.length);assert.ok(names.includes('tools/build-inputs.json'));
  assert.ok(names.includes('tools/compat-target.json'));assert.ok(names.some(n=>n.endsWith('.LICENSE')));
  assert.ok(names.every(n=>!n.includes('node_modules')));
  const input=names.map(n=>['@build/'+n,fs.readFileSync(path.join(root,n))]),before=shell.revision(input);
  assert.equal(before,shell.revision([...input].reverse()));
  for(const name of ['tools/compat-target.json','tools/compat-js.cjs','tools/vendor/babel-standalone-8.0.7.cjs'])assert.notEqual(before,shell.revision(input.map(([n,b])=>[n,n==='@build/'+name?Buffer.concat([b,Buffer.from(' ')]):b])));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'shikuang-compiler-pin-'));
  try{for(const n of names){const p=path.join(dir,n);fs.mkdirSync(path.dirname(p),{recursive:true});fs.copyFileSync(path.join(root,n),p);}fs.appendFileSync(path.join(dir,'tools/vendor/babel-standalone-8.0.7.cjs'),'\n');assert.throws(()=>require(path.join(dir,'tools/compat-js.cjs')).toolchain(),/integrity/);}
  finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('staged dist replacement preserves the old complete tree on write or commit failure',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'shikuang-dist-rollback-'));
  try{
    fs.mkdirSync(path.join(root,'dist'));fs.writeFileSync(path.join(root,'dist/kept.txt'),'prior');
    const entries=[['nested/new.txt',Buffer.from('next')]];
    assert.throws(()=>compat.replaceDist(root,entries,{...fs,writeFileSync(){throw Error('injected write failure');}}),/write failure/);
    assert.equal(fs.readFileSync(path.join(root,'dist/kept.txt'),'utf8'),'prior');
    let renames=0;
    assert.throws(()=>compat.replaceDist(root,entries,{...fs,renameSync(...args){if(++renames===2)throw Error('injected commit failure');return fs.renameSync(...args);}}),/commit failure/);
    assert.equal(fs.readFileSync(path.join(root,'dist/kept.txt'),'utf8'),'prior');assert.deepEqual(fs.readdirSync(root),['dist']);
    compat.replaceDist(root,entries);assert.equal(fs.existsSync(path.join(root,'dist/kept.txt')),false);assert.equal(fs.readFileSync(path.join(root,'dist/nested/new.txt'),'utf8'),'next');assert.deepEqual(fs.readdirSync(root),['dist']);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
