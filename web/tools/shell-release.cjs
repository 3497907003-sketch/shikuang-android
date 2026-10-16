const crypto=require('node:crypto');

// A deterministic identity for the exact inputs to this offline build. It is
// independent of mtimes, traversal order and machine-specific absolute paths.
function revision(entries) {
  const rows=entries.map(([name,bytes])=>[name,crypto.createHash('sha256').update(bytes).digest('hex')]);
  if(new Set(rows.map(([name])=>name)).size!==rows.length)throw new Error('Duplicate offline asset path');
  rows.sort(([a],[b])=>a<b?-1:a>b?1:0);
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

function render(name,bytes,id) {
  if(!/^[a-f0-9]{64}$/.test(id))throw new Error('Invalid shell content identity');
  if(!['index.html','core.js','sw.js'].includes(name))return bytes;
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
  } else {
    const marker=/importScripts\('\.\/core\.js(?:\?[^']*)?'\);/g;
    if([...text.matchAll(marker)].length!==1)throw new Error('Worker core import marker changed');
    text=text.replace(marker,`importScripts('./core.js?v=shell-${id}');`);
  }
  return Buffer.from(text);
}

module.exports={revision,render};
