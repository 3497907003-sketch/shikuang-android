const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');

// Run the exact shared Web builder in its original directory layout. Its
// content identity includes the unmodified builder/helper bytes, so Android
// produces the same shell cache identity as the reviewed Web dist.
const root=path.resolve(__dirname,'..');
const result=spawnSync(process.execPath,[path.join(root,'web/tools/build.cjs')],{cwd:root,stdio:'inherit'});
if(result.error)throw result.error;
if(result.status!==0)process.exit(result.status||1);
const built=path.join(root,'web/dist'),output=path.join(root,'dist');
if(!fs.statSync(built).isDirectory())throw new Error('Shared Web builder did not produce dist');
fs.rmSync(output,{recursive:true,force:true});
fs.renameSync(built,output);
