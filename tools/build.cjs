const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../web');
const output = path.resolve(__dirname, '../dist');
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
const files = ['index.html', 'styles.css', 'app.js', 'core.js', 'inference.js', 'engine-worker.js', 'media.js', 'history.js', 'storage.js', 'config.js', 'sw.js', 'version.json', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable.png', 'model-manifest.json', 'data/classes.js', 'data/minerals.js', 'data/sources.js', 'data/imagenet.js', 'vendor/lucide.min.js', 'vendor/ort.min.js', 'vendor/ort-wasm-simd-threaded.mjs', 'vendor/ort-wasm-simd-threaded.wasm', 'models/mobilenet_int8.onnx', 'models/efficientnet.onnx', 'models/efficientnet_legacy.onnx', 'models/imagenet_gate.onnx'];
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
