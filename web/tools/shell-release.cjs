const crypto=require('node:crypto');

// A deterministic identity for the exact inputs to this offline build. It is
// independent of mtimes, traversal order and machine-specific absolute paths.
function revision(entries) {
  const rows=entries.map(([name,bytes])=>[name,crypto.createHash('sha256').update(bytes).digest('hex')]);
  if(new Set(rows.map(([name])=>name)).size!==rows.length)throw new Error('Duplicate offline asset path');
  rows.sort(([a],[b])=>a<b?-1:a>b?1:0);
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

function runtimeWasm(entries) {
  const path='vendor/ort-wasm-simd-threaded.wasm',matches=entries.filter(([name])=>name===path);
  if(matches.length!==1)throw new Error('Exactly one bundled runtime WASM is required');
  const bytes=matches[0][1];
  if(bytes.length<=8||bytes.length>32*1024*1024||![0,97,115,109,1,0,0,0].every((value,i)=>bytes[i]===value))throw new Error('Bundled runtime WASM is invalid');
  return {path,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
}

function render(name,bytes,id,wasm) {
  if(!/^[a-f0-9]{64}$/.test(id))throw new Error('Invalid shell content identity');
  if(!['index.html','core.js','sw.js','engine-worker.js'].includes(name))return bytes;
  let text=bytes.toString('utf8');
  if(name==='index.html') {
    text=text.replace(/\b(src|href)="(\.\/[^"#]+)"/g,(whole,attr,value)=>{
      const url=new URL(value,'https://shell.invalid/');
      if(!/\.(?:js|css)$/.test(url.pathname))return whole;
      url.searchParams.set('v','shell-'+id);
      return `${attr}=".${url.pathname}${url.search}"`;
    });
  } else if(name==='core.js') {
    const marker=/shell:'shikuang-static-[^']+'/g;
    if([...text.matchAll(marker)].length!==1)throw new Error('Shell cache identity marker changed');
    text=text.replace(marker,`shell:'shikuang-static-shell-${id}'`);
  } else if(name==='engine-worker.js') {
    for(const dependency of ['compat.js','vendor/ort.min.js','core.js']) {
      const marker="importScripts('./"+dependency+"');";
      if(text.split(marker).length!==2)throw new Error('Engine dependency import marker changed: '+dependency);
      text=text.replace(marker,"importScripts('./"+dependency+"?v=shell-"+id+"');");
    }
  } else {
    const compat="importScripts('./compat.js');";
    if(text.split(compat).length!==2)throw new Error('Worker compatibility import marker changed');
    text=text.replace(compat,"importScripts('./compat.js?v=shell-"+id+"');");
    const marker=/importScripts\('\.\/core\.js(?:\?[^']*)?'\);/g;
    if([...text.matchAll(marker)].length!==1)throw new Error('Worker core import marker changed');
    text=text.replace(marker,`importScripts('./core.js?v=shell-${id}');`);
    const runtimeMarker=/const RUNTIME_WASM = Object\.freeze\((\{[^\n]+\})\);/g;
    const descriptors=[...text.matchAll(runtimeMarker)];
    if(descriptors.length!==1)throw new Error('Worker runtime WASM descriptor marker changed');
    const descriptor=wasm||JSON.parse(descriptors[0][1]);
    if(descriptor.path!=='vendor/ort-wasm-simd-threaded.wasm'||!Number.isInteger(descriptor.bytes)||descriptor.bytes<=8||descriptor.bytes>32*1024*1024||!/^[a-f0-9]{64}$/.test(descriptor.sha256))throw new Error('Worker runtime WASM descriptor is invalid');
    text=text.replace(runtimeMarker,`const RUNTIME_WASM = Object.freeze(${JSON.stringify(descriptor)});`);
  }
  return Buffer.from(text);
}

module.exports={revision,render,runtimeWasm};
