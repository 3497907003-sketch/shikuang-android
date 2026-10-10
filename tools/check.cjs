const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../web');
for (const file of ['app.js','native-assets.js','core.js','inference.js','storage.js','sw.js','engine-worker.js','media.js','history.js','reference-loader.js','data/sources.js']) new vm.Script(fs.readFileSync(path.join(root,file),'utf8'), { filename:file });
const context = { window: {} };
for (const file of ['classes','minerals','imagenet']) vm.runInNewContext(fs.readFileSync(path.join(root,`data/${file}.js`),'utf8'),context);
const keys = Object.keys(context.window.MINERAL_CLASSES);
const manifest = JSON.parse(fs.readFileSync(path.join(root,'model-manifest.json'),'utf8'));
require(path.join(root,'core.js')).validateManifest(manifest,keys);
if (JSON.stringify(keys) !== JSON.stringify(manifest.labels)) throw new Error('Label order changed: model retraining/remapping is required');
if (keys.some(key => !context.window.MINERAL_KB[key])) throw new Error('A model label has no knowledge entry');
for (const model of manifest.models) {
  const bytes = fs.readFileSync(path.join(root,model.path));
  if (bytes.length !== model.bytes) throw new Error(`${model.path} size does not match manifest`);
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== model.sha256) throw new Error(`${model.path} checksum does not match manifest`);
  require('./onnx-contract.cjs').validate(bytes,model);
}
const index = fs.readFileSync(path.join(root,'index.html'),'utf8');
for (const match of index.matchAll(/(?:src|href)="\.\/([^"#]+)"/g)) if (!fs.existsSync(path.join(root,match[1].split('?')[0]))) throw new Error(`Missing asset: ${match[1]}`);
const app = fs.readFileSync(path.join(root,'app.js'),'utf8');
for (const match of app.matchAll(/\$\('#([a-zA-Z0-9]+)'\)/g)) {
  if (!index.includes(`id="${match[1]}"`) && !app.includes(`id="${match[1]}"`)) throw new Error(`Missing UI element: ${match[1]}`);
}
const referenceManifest=JSON.parse(fs.readFileSync(path.join(root,'data/reference-manifest.json'),'utf8'));
for(const file of referenceManifest.files){const bytes=fs.readFileSync(path.join(root,file.path));if(bytes.length!==file.bytes||crypto.createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw new Error(`Reference checksum mismatch: ${file.path}`);}
const catalog=JSON.parse(fs.readFileSync(path.join(root,'data/catalog.json'),'utf8'));
if(catalog.count!==catalog.minerals.length||new Set(catalog.minerals.map(x=>x.id)).size!==catalog.count)throw new Error('Reference catalogue count/ID mismatch');
const byId=new Map(catalog.minerals.map(x=>[x.id,x]));
const crystals=JSON.parse(fs.readFileSync(path.join(root,'data/crystals.json'),'utf8'));
let recordCount=0;
for(const [id,records] of Object.entries(crystals.by_species)){
  if(!byId.has(id)||byId.get(id).crystal_record_count!==records.length)throw new Error('Unmatched crystal species: '+id);
  for(const row of records){if(!Object.values(row.cell).every(Number.isFinite)||/synthetic|synthesi|simulat|hypothetical|theoretical|idealized|ab initio|first.princip|density functional|\bDFT\b|quantum|mathematical model|optimized|predicted/i.test(row.article_title+' '+row.experimental_notes))throw new Error('Invalid/simulated crystal record: '+row.id);recordCount++;}
}
if(recordCount!==crystals.stats.matched_records||Object.keys(crystals.by_species).length!==crystals.stats.species_with_records)throw new Error('Crystal record count mismatch');
let verifiedFields=0;
for(const row of catalog.minerals) for(const prop of Object.values(row.physical_properties||{})) {
  if(!['verified','source_inferred','needs_review','unavailable'].includes(prop.status)||!prop.source_url?.startsWith('https://www.handbookofmineralogy.org/')||prop.source_page!==1)throw new Error('Invalid physical source: '+row.id);
  if(prop.status==='verified'){if(prop.value===null||prop.value===undefined||prop.value==='')throw new Error('Empty verified field: '+row.id);verifiedFields++;}
  else if(prop.value!==null)throw new Error('Unverified value published: '+row.id);
}
const images=JSON.parse(fs.readFileSync(path.join(root,'data/image-sources.json'),'utf8'));
if(images.records.length!==images.stats.image_references||new Set(images.records.map(x=>x.id)).size!==images.records.length)throw new Error('Image count/ID mismatch');
for(const row of images.records)if(row.training_ready!==false||!row.image_page_url?.startsWith('https://')||!row.original_image_url?.startsWith('https://')||!row.permission_status||!row.identification_evidence)throw new Error('Invalid image provenance: '+row.id);
if(images.stats.training_ready!==0)throw new Error('Image training review has not been completed');
console.log(`Syntax, bounded model contract, ${keys.length} ordered labels, ${manifest.models.length} model sizes/checksums/graph metadata, ${catalog.count} reference species and ${recordCount} crystal records verified. Runtime compatibility and accuracy require separate execution tests.`);
