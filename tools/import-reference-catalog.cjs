// Rebuild the publishable collection from reviewed, source-preserving imports.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname,'..');
const scratch = process.argv[2];
if (!scratch) throw new Error('Usage: node tools/import-reference-catalog.cjs /path/to/reference-catalog');
const read = name => JSON.parse(fs.readFileSync(path.join(scratch,name),'utf8'));
const catalog = read('ima-catalog-2026-09.json');
const crystals = read('crystal-records.json');
const images = read('image-sources.json');
const physical = read('physical-properties.json');
if(!physical.complete||physical.verification_complete!==true)throw new Error('Physical-property import has not finished review');
for(const record of physical.records) for(const property of Object.values(record.properties)) {
  if(!['verified','source_inferred','needs_review','unavailable'].includes(property.status))throw new Error('Unreviewed physical property: '+record.key);
  if(property.status!=='verified'&&property.value!==null)throw new Error('Unverified property must remain empty: '+record.key);
}
const context = {window:{}};
vm.runInNewContext(fs.readFileSync(path.join(root,'data/minerals.js'),'utf8'),context);
const kb = context.window.MINERAL_KB;
const aliases = {antimonite:'Stibnite',cobaltin:'Cobaltite',cancrinit:'Cancrinite',scheelit:'Scheelite',vesuvian:'Vesuvianite',analcim:'Analcime',credit:'Creedite',elbait:'Elbaite',sulfur:'Sulphur',barite:'Baryte'};
const normalize = value => value.normalize('NFKC').toLowerCase().trim();
const byName = new Map(catalog.minerals.map(row=>[normalize(row.name_en),row]));
const crystalNames={Triclinic:'三斜晶系',Monoclinic:'单斜晶系',Orthorhombic:'斜方晶系',Tetragonal:'四方晶系',Trigonal:'三方晶系',Hexagonal:'六方晶系',Cubic:'等轴晶系'};
for(const record of physical.records){
  const k=kb[record.key];
  if(!k)throw new Error('Unknown physical property key: '+record.key);
  k.verified_properties=record.properties;
  for(const field of ['hardness','crystal_system','luster','streak']){
    const prop=record.properties[field];
    if(prop?.status==='verified'&&prop.value!==null&&prop.value!==undefined&&prop.value!=='')k[field]=field==='crystal_system'?(crystalNames[prop.value]||prop.value):prop.value;
  }
  const official=byName.get(normalize(record.name_en));
  if(official)official.physical_properties=record.properties;
}
for (const [key,k] of Object.entries(kb)) {
  const row = byName.get(normalize(aliases[key] || k.name_en));
  if (!row) continue; // Groups, varieties and rocks are not promoted to IMA species.
  row.legacy_keys = [...(row.legacy_keys || []),key];
  row.detail_key ??= key;
  row.name_zh ??= k.name_zh;
  if (aliases[key]) row.aliases_en = [...new Set([...(row.aliases_en || []),k.name_en])];
  // Display names/formulas may be corrected; model keys and order stay intact.
  k.name_en=row.name_en;
  k.formula=row.formula;
  k.formula_source={source_id:row.source_id,url:row.source_url,page:row.source_page,version:catalog.version};
}
fs.writeFileSync(path.join(root,'data/minerals.js'),'window.MINERAL_KB='+JSON.stringify(kb)+';\n');
catalog.crystal_stats = crystals.stats;
catalog.physical_stats={linked_labels:physical.count,unique_source_pdfs:new Set(physical.records.map(row=>row.source_pdf_sha256)).size,verified_label_fields:Object.values(physical.property_counts||{}).reduce((sum,value)=>sum+(value.verified||0),0),property_counts:physical.property_counts};
for (const row of catalog.minerals) row.crystal_record_count = crystals.by_species[row.id]?.length || 0;
if (catalog.count !== 6239 || catalog.minerals.length !== catalog.count) throw new Error('Official September 2026 catalogue must contain 6239 species');
if (new Set(catalog.minerals.map(x=>x.id)).size !== catalog.count) throw new Error('Duplicate species IDs');
for (const row of catalog.minerals) {
  if (!row.name_en || !row.formula || !row.source_url.startsWith('https://cnmnc.units.it/') || !Number.isInteger(row.source_page)) throw new Error('Incomplete source record: '+row.id);
}
const dataDir = path.join(root,'data');
const files = [['catalog',catalog],['crystals',crystals],['image-sources',images]].map(([name,data])=>{
  const bytes = Buffer.from(JSON.stringify(data)+'\n');
  const relative = `data/${name}.json`;
  fs.writeFileSync(path.join(root,relative),bytes);
  return {path:relative,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
});
const manifest={schema_version:1,version:'2026-10-10',catalog_version:catalog.version,counts:{ima_species:catalog.count,handbook_links:catalog.minerals.filter(x=>x.handbook_url).length,...crystals.stats},files};
fs.writeFileSync(path.join(dataDir,'reference-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify(manifest.counts));
