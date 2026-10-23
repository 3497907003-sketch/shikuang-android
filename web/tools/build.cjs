const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const vm = require('node:vm');
const crypto = require('node:crypto');
const researchAssets=require('./research-input-contract.cjs').validate(root);
const context = {window:{}};
vm.runInNewContext(fs.readFileSync(path.join(root,'data/classes.js'),'utf8'),context);
const manifest = require('../core.js').validateManifest(JSON.parse(fs.readFileSync(path.join(root,'model-manifest.json'),'utf8')),Object.keys(context.window.MINERAL_CLASSES));
const gallery=require('../gallery.js');
const photos=gallery.validateAssets(JSON.parse(fs.readFileSync(path.join(root,'data/reviewed-photo-assets.json'),'utf8')));
const photoRows=JSON.parse(fs.readFileSync(path.join(root,'data/image-sources.json'),'utf8')).records.filter(row=>row.local_image_url);
if(photoRows.length!==photos.length)throw new Error('Gallery source and asset counts differ');
for(const photo of photos){
  const record=photoRows.find(row=>row.local_image_url===photo.path),checked=gallery.asset(record);
  if(checked.bytes!==photo.bytes||checked.sha256!==photo.sha256)throw new Error('Gallery source identity differs: '+photo.path);
  const bytes=fs.readFileSync(path.join(root,photo.path));
  if(bytes.length!==photo.bytes||crypto.createHash('sha256').update(bytes).digest('hex')!==photo.sha256||bytes[0]!==255||bytes[1]!==216)throw new Error('Reviewed gallery image changed: '+photo.path);
}
// Validate before replacing dist: a malformed/partial new model must never ship.
for (const model of manifest.models) {
  const bytes = fs.readFileSync(path.join(root,model.path));
  if(bytes.length!==model.bytes || crypto.createHash('sha256').update(bytes).digest('hex')!==model.sha256) throw new Error('Model file does not match manifest: '+model.path);
  require('./onnx-contract.cjs').validate(bytes,model);
}
const files = ['index.html', 'styles.css', 'app.js', 'compat.js', 'native-assets.js', 'core.js', 'inference.js', 'engine-worker.js', 'media.js', 'history.js', 'storage.js', 'config.js', 'sw.js', 'version.json', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable.png', 'model-manifest.json', 'data/classes.js', 'data/minerals.js', 'data/sources.js', 'data/imagenet.js', 'vendor/lucide.min.js', 'vendor/ort.min.js', 'vendor/ort-wasm-simd-threaded.mjs', 'vendor/ort-wasm-simd-threaded.wasm', ...manifest.models.map(model=>model.path), 'reference-loader.js', 'gallery.js', 'viewport.js', 'data/catalog.json', 'data/crystals.json', 'data/image-sources.json', 'data/reference-manifest.json', 'data/reviewed-photo-assets.json', 'data/licenses/ima-cnmnc-2026-09.txt', 'data/licenses/reviewed-photos-v25.txt', ...photos.map(row=>row.path)];
// A missing optional-looking attribution or reference asset is still a broken
// installable package. Check the complete set before replacing the prior build.
files.push(...researchAssets);
for(const file of files)if(!fs.statSync(path.join(root,file)).isFile())throw new Error('Offline asset is not a file: '+file);
const shellRelease=require('./shell-release.cjs');
const inputs=files.map(file=>[file,fs.readFileSync(path.join(root,file))]);
const compat=require('./compat-js.cjs');
const buildInputs=compat.BUILD_INPUT_PATHS.map(file=>['@build/'+file,fs.readFileSync(path.join(root,file))]);
const compile=compat.transformer();
const shellRevision=shellRelease.revision([...inputs,...buildInputs]);
const runtimeWasm=shellRelease.runtimeWasm(inputs);
// Render and validate every transformed asset before replacing a prior build.
const rendered=inputs.map(([file,bytes])=>[file,compile(file,shellRelease.render(file,bytes,shellRevision,runtimeWasm))]);
compat.replaceDist(root,rendered);
console.log(`Built ${files.length} offline assets in dist/; shell ${shellRevision}`);
