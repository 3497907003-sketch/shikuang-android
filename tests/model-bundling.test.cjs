const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const WEB=fs.existsSync(path.join(__dirname,'../web/core.js'))?'../web/':'../';
const {fixture,hash}=require('./helpers/model-contract.cjs');
const runtimeDescriptor=source=>require('node:vm').runInNewContext('JSON.stringify('+source.match(/const RUNTIME_WASM = Object\.freeze\((\{[\s\S]*?\})\);/)[1]+')');
// Graph metadata only, not executable/training weights. Real packaged graphs have
// their own metadata/checksum gate and instrumented ONNX inference tests.
const v=n=>{let bytes=[];do{let b=n&127;n>>>=7;if(n)b|=128;bytes.push(b);}while(n);return Buffer.from(bytes);};
const number=(id,value)=>Buffer.concat([v(id*8),v(value)]),message=(id,b)=>Buffer.concat([v(id*8+2),v(b.length),b]),text=(id,s)=>message(id,Buffer.from(s));
function tensor(name,shape) {
  const dimensions=Buffer.concat(shape.map(size=>message(1,number(1,size))));
  const descriptor=Buffer.concat([number(1,1),message(2,dimensions)]);
  return Buffer.concat([text(1,name),message(2,message(1,descriptor))]);
}
const graph=classes=>message(7,Buffer.concat([message(11,tensor('input',[1,3,224,224])),message(12,tensor('output',[1,classes]))]));
test('build follows the active two-classifier manifest, excludes unused legacy files and fails before replacing good assets',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'shikuang-bundling-'));
  try {
    const write=(file,body)=>{const p=path.join(dir,file);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,body);};
    const sourcePrefix=WEB==='../web/'?'web/':'';
    const writeSource=(file,body)=>write(sourcePrefix+file,body);
    const build=fs.readFileSync(require.resolve(WEB+'tools/build.cjs'),'utf8');
    // Parse the canonical builder in both layouts, not Android's root wrapper.
    // Populate literal shell assets; classifier paths are deliberately absent from this list.
    for(const match of build.matchAll(/'([\w./-]+\.(?:js|cjs|html|css|json|webmanifest|svg|png|mjs|wasm|txt))'/g))if(!match[1].startsWith('..'))writeSource(match[1],'asset');
    for(const file of require(WEB+'tools/compat-js.cjs').BUILD_INPUT_PATHS)writeSource(file,fs.readFileSync(path.resolve(__dirname,WEB,file)));
    // Android consumes the same source-prefixed closure, then its existing
    // wrapper moves the successful web/dist to root dist. A failed shared
    // build must leave the previous root dist intact.
    if(sourcePrefix)write('tools/build.cjs',fs.readFileSync(require.resolve('../tools/build.cjs')));
    writeSource('engine-worker.js',fs.readFileSync(require.resolve(WEB+'engine-worker.js')));
    const data=fixture();data.manifest.models[0].path='models/mobilenet.onnx';
    for(const model of data.manifest.models){const bytes=graph(model.classes);model.bytes=bytes.length;model.sha256=hash(bytes);writeSource(model.path,bytes);}
    writeSource('models/mobilenet_int8.onnx','unused old weight');writeSource('models/efficientnet_legacy.onnx','unused old weight');write('dist/models/orphan.onnx','stale package');
    writeSource('gallery.js',fs.readFileSync(require.resolve(WEB+'gallery.js')));writeSource('data/reviewed-photo-assets.json',JSON.stringify({schema_version:1,assets:[]}));writeSource('data/image-sources.json',JSON.stringify({schema_version:1,records:[]}));
    writeSource('data/classes.js','window.MINERAL_CLASSES='+JSON.stringify(Object.fromEntries(data.manifest.labels.map(x=>[x,x]))));
    const runtime=Buffer.from([0,97,115,109,1,0,0,0,0,2,0,1]);writeSource('vendor/ort-wasm-simd-threaded.wasm',runtime);
    writeSource('model-manifest.json',JSON.stringify(data.manifest));writeSource('core.js',fs.readFileSync(require.resolve(WEB+'core.js')));writeSource('sw.js',fs.readFileSync(require.resolve(WEB+'sw.js')));
    const run=()=>spawnSync(process.execPath,['tools/build.cjs'],{cwd:dir,encoding:'utf8'});
    const result=run();assert.equal(result.status,0,result.stderr);
    if(sourcePrefix)assert.equal(fs.existsSync(path.join(dir,'web/dist')),false,'Android wrapper must move the shared output into root dist');
    assert.deepEqual(fs.readdirSync(path.join(dir,'dist/models')).sort(),['efficientnet.onnx','imagenet_gate.onnx','mobilenet.onnx']);
    const firstWorker=fs.readFileSync(path.join(dir,'dist/sw.js'),'utf8');
    assert.deepEqual(JSON.parse(runtimeDescriptor(firstWorker)),{path:'vendor/ort-wasm-simd-threaded.wasm',bytes:runtime.length,sha256:hash(runtime)});
    const nextRuntime=Buffer.from(runtime);nextRuntime[nextRuntime.length-1]=2;writeSource('vendor/ort-wasm-simd-threaded.wasm',nextRuntime);assert.equal(run().status,0);
    const nextWorker=fs.readFileSync(path.join(dir,'dist/sw.js'),'utf8');assert.notEqual(nextWorker,firstWorker);
    assert.equal(JSON.parse(runtimeDescriptor(nextWorker)).sha256,hash(nextRuntime));
    fs.appendFileSync(path.join(dir,sourcePrefix,'tools/shell-release.cjs'),'\n// Build-only revision regression\n');
    assert.equal(run().status,0);
    assert.notEqual(fs.readFileSync(path.join(dir,'dist/sw.js'),'utf8'),nextWorker,'Build rules must invalidate an installed worker even when asset inputs are unchanged');
    const goodWorker=fs.readFileSync(path.join(dir,'dist/sw.js'),'utf8');
    writeSource('app.js','const broken = ;');assert.notEqual(run().status,0);
    assert.equal(fs.readFileSync(path.join(dir,'dist/sw.js'),'utf8'),goodWorker,'Compiler rejection must preserve prior dist');
    writeSource('app.js','asset');
    writeSource('vendor/ort-wasm-simd-threaded.wasm',runtime.subarray(0,8));assert.notEqual(run().status,0);
    assert.equal(fs.readFileSync(path.join(dir,'dist/sw.js'),'utf8'),goodWorker,'Invalid runtime must not replace the previous complete build');
    writeSource('vendor/ort-wasm-simd-threaded.wasm',nextRuntime);
    const good=fs.readFileSync(path.join(dir,'dist/model-manifest.json'),'utf8');
    writeSource(data.manifest.models[0].path,'corrupt');assert.notEqual(run().status,0);assert.equal(fs.readFileSync(path.join(dir,'dist/model-manifest.json'),'utf8'),good);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
