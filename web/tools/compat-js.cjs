'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'..');
const BUILD_INPUT_PATHS=Object.freeze(require('./build-inputs.json'));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
let compiler;
function toolchain() {
  const c=JSON.parse(fs.readFileSync(path.join(ROOT,'tools/compat-target.json'),'utf8'));
  if(c.schema!==1||c.targets.chrome!=='69'||c.preset!=='env'||c.modules!==false||c.ignoreBrowserslistConfig!==true||c.automaticRuntimePolyfills!==false)throw Error('Compatibility target contract changed');
  const provenance=JSON.parse(fs.readFileSync(path.join(ROOT,c.compiler.provenance),'utf8'));
  const pkg=JSON.parse(fs.readFileSync(path.join(ROOT,c.compiler.package),'utf8'));
  if(pkg.name!==c.compiler.name||pkg.version!==c.compiler.version||pkg.license!=='MIT'||!provenance.registry_sha512_and_sha1_verified)throw Error('Compiler provenance/version mismatch');
  for(const entry of provenance.files){const bytes=fs.readFileSync(path.join(ROOT,entry.path));if(bytes.length!==entry.bytes||sha(bytes)!==entry.sha256)throw Error('Compiler source/license integrity mismatch: '+entry.path);}
  const bytes=fs.readFileSync(path.join(ROOT,c.compiler.path));
  if(bytes.length!==c.compiler.bytes||sha(bytes)!==c.compiler.sha256)throw Error('Compiler target integrity mismatch');
  compiler=compiler||require(path.join(ROOT,c.compiler.path));
  if(compiler.version!==c.compiler.version)throw Error('Loaded compiler version mismatch');
  return {contract:c,Babel:compiler};
}
function assertSyntax(name,code,Babel=toolchain().Babel) {
  const ast=Babel.packages.parser.parse(code,{sourceType:name.endsWith('.mjs')?'module':'script'});
  const unsupported=new Set(['OptionalMemberExpression','OptionalCallExpression','ClassProperty','ClassPrivateProperty','ClassPrivateMethod','StaticBlock','PrivateName']);
  const pending=[ast];
  while(pending.length){const node=pending.pop();if(!node||typeof node!=='object')continue;
    if(unsupported.has(node.type)||(node.type==='LogicalExpression'&&node.operator==='??')||(node.type==='AssignmentExpression'&&['||=','&&=','??='].includes(node.operator))||(node.type==='NumericLiteral'&&node.extra?.raw?.includes('_')))throw Error('Emitted syntax exceeds Chrome69 contract: '+name+' '+node.type);
    for(const [key,value] of Object.entries(node)){if(['loc','tokens','comments','leadingComments','trailingComments','innerComments','extra'].includes(key))continue;if(Array.isArray(value))pending.push(...value);else if(value&&typeof value==='object')pending.push(value);}
  }
  return true;
}
function transformer() {
  const {contract:c,Babel}=toolchain();
  return function compile(name,bytes){
    if(!/\.(?:js|mjs)$/.test(name))return bytes;
    const output=Babel.transform(bytes.toString('utf8'),{filename:name,sourceType:name.endsWith('.mjs')?'module':'script',presets:[[c.preset,{targets:c.targets,modules:c.modules,ignoreBrowserslistConfig:c.ignoreBrowserslistConfig}]],comments:c.comments,compact:c.compact,minified:c.minified,sourceMaps:c.sourceMaps}).code;
    assertSyntax(name,output,Babel);return Buffer.from(output+'\n');
  };
}
// Stage complete outputs before touching the prior dist. Two same-directory
// renames commit a complete tree; on commit failure the old tree is restored.
// This is rollback-safe replacement, not a claim of directory-exchange support.
function replaceDist(root,entries,io=fs) {
  const output=path.join(root,'dist'),staging=io.mkdtempSync(path.join(root,'.dist-stage-'));
  let backup=null,committed=false;
  try {
    for(const [name,bytes] of entries){if(path.isAbsolute(name)||name.split(/[\\/]/).includes('..'))throw Error('Invalid dist path');const target=path.join(staging,name);io.mkdirSync(path.dirname(target),{recursive:true});io.writeFileSync(target,bytes);}
    if(io.existsSync(output)){backup=io.mkdtempSync(path.join(root,'.dist-prior-'));io.rmdirSync(backup);io.renameSync(output,backup);}
    try{io.renameSync(staging,output);committed=true;}
    catch(error){if(backup){io.renameSync(backup,output);backup=null;}throw error;}
    if(backup){io.rmSync(backup,{recursive:true,force:true});backup=null;}
  }finally{if(!committed)io.rmSync(staging,{recursive:true,force:true});}
}
module.exports={BUILD_INPUT_PATHS,toolchain,transformer,assertSyntax,replaceDist};
