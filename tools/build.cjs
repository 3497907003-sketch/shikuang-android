const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../web');
const vm = require('node:vm');
const crypto = require('node:crypto');
const context = {window:{}};
vm.runInNewContext(fs.readFileSync(path.join(root,'data/classes.js'),'utf8'),context);
const manifest = require('../web/core.js').validateManifest(JSON.parse(fs.readFileSync(path.join(root,'model-manifest.json'),'utf8')),Object.keys(context.window.MINERAL_CLASSES));
// Validate before replacing dist: a malformed/partial new model must never ship.
for (const model of manifest.models) {
  const bytes = fs.readFileSync(path.join(root,model.path));
  if(bytes.length!==model.bytes || crypto.createHash('sha256').update(bytes).digest('hex')!==model.sha256) throw new Error('Model file does not match manifest: '+model.path);
  require('./onnx-contract.cjs').validate(bytes,model);
}
const output = path.resolve(__dirname, '../dist');
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
const files = ['index.html', 'styles.css', 'app.js', 'native-assets.js', 'core.js', 'inference.js', 'engine-worker.js', 'media.js', 'history.js', 'storage.js', 'config.js', 'sw.js', 'version.json', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable.png', 'model-manifest.json', 'data/classes.js', 'data/minerals.js', 'data/sources.js', 'data/imagenet.js', 'vendor/lucide.min.js', 'vendor/ort.min.js', 'vendor/ort-wasm-simd-threaded.mjs', 'vendor/ort-wasm-simd-threaded.wasm', ...manifest.models.map(model=>model.path)];
for (const file of files) {
  const target = path.join(output, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(root, file), target);
}
for (const file of ['reference-loader.js','data/catalog.json','data/crystals.json','data/image-sources.json','data/reference-manifest.json','data/licenses/ima-cnmnc-2026-09.txt']) {
  fs.mkdirSync(path.dirname(path.join(output,file)),{recursive:true});
  fs.copyFileSync(path.join(root,file),path.join(output,file));
  files.push(file);
}
console.log(`Built ${files.length} offline assets in dist/`);
