const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const WEB=fs.existsSync(path.join(__dirname,'../web/core.js'))?'../web/':'../';
const {fixture,hash}=require('./helpers/model-contract.cjs');
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
    const build=fs.readFileSync(require.resolve('../tools/build.cjs'),'utf8');
    // Populate literal shell assets; classifier paths are deliberately absent from this list.
    for(const match of build.matchAll(/'([\w./-]+\.(?:js|cjs|html|css|json|webmanifest|svg|png|mjs|wasm|txt))'/g))if(!match[1].startsWith('..'))write((WEB==='../web/'?'web/':'')+match[1],'asset');
    const sourcePrefix=WEB==='../web/'?'web/':'';
    const writeSource=(file,body)=>write(sourcePrefix+file,body);
    const data=fixture();data.manifest.models[0].path='models/mobilenet.onnx';
    for(const model of data.manifest.models){const bytes=graph(model.classes);model.bytes=bytes.length;model.sha256=hash(bytes);writeSource(model.path,bytes);}
    writeSource('models/mobilenet_int8.onnx','unused old weight');writeSource('models/efficientnet_legacy.onnx','unused old weight');write('dist/models/orphan.onnx','stale package');
    writeSource('gallery.js',fs.readFileSync(require.resolve(WEB+'gallery.js')));writeSource('data/reviewed-photo-assets.json',JSON.stringify({schema_version:1,assets:[]}));writeSource('data/image-sources.json',JSON.stringify({schema_version:1,records:[]}));
    writeSource('data/classes.js','window.MINERAL_CLASSES='+JSON.stringify(Object.fromEntries(data.manifest.labels.map(x=>[x,x]))));
    writeSource('model-manifest.json',JSON.stringify(data.manifest));writeSource('core.js',fs.readFileSync(require.resolve(WEB+'core.js')));write('tools/onnx-contract.cjs',fs.readFileSync(require.resolve('../tools/onnx-contract.cjs')));write('tools/build.cjs',build);
    const run=()=>spawnSync(process.execPath,['tools/build.cjs'],{cwd:dir,encoding:'utf8'});
    const result=run();assert.equal(result.status,0,result.stderr);
    assert.deepEqual(fs.readdirSync(path.join(dir,'dist/models')).sort(),['efficientnet.onnx','imagenet_gate.onnx','mobilenet.onnx']);
    const good=fs.readFileSync(path.join(dir,'dist/model-manifest.json'),'utf8');
    writeSource(data.manifest.models[0].path,'corrupt');assert.notEqual(run().status,0);assert.equal(fs.readFileSync(path.join(dir,'dist/model-manifest.json'),'utf8'),good);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
