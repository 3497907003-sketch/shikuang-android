const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');

const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function inventory(root) {
  const type=fs.lstatSync(root);
  if(type.isSymbolicLink())throw new Error('Symlink shared asset root: '+root);
  if(!type.isDirectory())throw new Error('Shared asset root is not a directory: '+root);
  const files=new Map();
  function walk(directory) {
    for(const entry of fs.readdirSync(directory,{withFileTypes:true})) {
      const full=path.join(directory,entry.name),name=path.relative(root,full).split(path.sep).join('/');
      if(entry.isSymbolicLink())throw new Error('Symlink in shared assets: '+name);
      if(entry.isDirectory())walk(full);
      else if(entry.isFile())files.set(name,hash(fs.readFileSync(full)));
      else throw new Error('Unsupported shared asset: '+name);
    }
  }
  walk(root);
  return files;
}

function exactShared(expected,actual,label,extras=[]) {
  const allowed=new Set(extras);
  for(const [name,digest] of expected) {
    if(actual.get(name)!==digest)throw new Error(label+' differs from verified dist: '+name);
  }
  for(const name of actual.keys()) {
    if(!expected.has(name)&&!allowed.has(name))throw new Error('Unused/stale '+label+' asset: '+name);
  }
}

function verify(dist,assets,canonicalDist) {
  const files=inventory(dist),packaged=inventory(assets);
  // Capacitor supplies only these two extra bridge files. Other stale assets,
  // including obsolete scripts, must not survive a successful sync check.
  exactShared(files,packaged,'Android',['cordova.js','cordova_plugins.js']);
  if(canonicalDist) {
    const canonical=inventory(canonicalDist),canonicalRoot=fs.realpathSync(canonicalDist);
    if([dist,assets].some(directory=>fs.realpathSync(directory)===canonicalRoot))throw new Error('Canonical Web must be a separate build tree');
    exactShared(files,canonical,'canonical Web');
  }
  const manifest=JSON.parse(fs.readFileSync(path.join(dist,'model-manifest.json'),'utf8'));
  const expected=manifest.models.map(row=>row.path).sort();
  const actual=[...packaged.keys()].filter(name=>name.startsWith('models/')).sort();
  if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Packaged models must exactly match the active manifest');
  return {assets:files.size,models:expected.length,canonicalWebCompared:Boolean(canonicalDist)};
}

if(require.main===module) {
  const args=process.argv.slice(2);
  if(args.length!==0&&(args.length!==2||args[0]!=='--canonical-dist'))throw new Error('Usage: node tools/verify-sync.cjs [--canonical-dist PATH]');
  const root=path.resolve(__dirname,'..');
  const result=verify(path.join(root,'dist'),path.join(root,'android/app/src/main/assets/public'),args.length?path.resolve(args[1]):undefined);
  console.log(`Verified ${result.assets} packaged shared assets and exactly ${result.models} active models${result.canonicalWebCompared?'; exact canonical Web bytes also verified':''}. Capacitor sync preserves user data.`);
}
module.exports={verify};
