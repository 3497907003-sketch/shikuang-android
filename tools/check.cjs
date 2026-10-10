const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../web');
for (const file of ['app.js','core.js','inference.js','storage.js','sw.js','engine-worker.js','media.js','history.js','data/sources.js']) new vm.Script(fs.readFileSync(path.join(root,file),'utf8'), { filename:file });
const context = { window: {} };
for (const file of ['classes','minerals','imagenet']) vm.runInNewContext(fs.readFileSync(path.join(root,`data/${file}.js`),'utf8'),context);
const keys = Object.keys(context.window.MINERAL_CLASSES);
const manifest = JSON.parse(fs.readFileSync(path.join(root,'model-manifest.json'),'utf8'));
if (JSON.stringify(keys) !== JSON.stringify(manifest.labels)) throw new Error('Label order changed: model retraining/remapping is required');
if (keys.some(key => !context.window.MINERAL_KB[key])) throw new Error('A model label has no knowledge entry');
for (const model of manifest.models) {
  const bytes = fs.readFileSync(path.join(root,model.path));
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== model.sha256) throw new Error(`${model.path} checksum does not match manifest`);
}
const index = fs.readFileSync(path.join(root,'index.html'),'utf8');
for (const match of index.matchAll(/(?:src|href)="\.\/([^"#]+)"/g)) if (!fs.existsSync(path.join(root,match[1].split('?')[0]))) throw new Error(`Missing asset: ${match[1]}`);
const app = fs.readFileSync(path.join(root,'app.js'),'utf8');
for (const match of app.matchAll(/\$\('#([a-zA-Z0-9]+)'\)/g)) {
  if (!index.includes(`id="${match[1]}"`) && !app.includes(`id="${match[1]}"`)) throw new Error(`Missing UI element: ${match[1]}`);
}
console.log(`Syntax, assets, ${keys.length} ordered labels and ${manifest.models.length} model checksums verified.`);
