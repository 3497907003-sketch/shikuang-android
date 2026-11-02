(function(root,factory){const api=factory(),commonJS=typeof module==='object'&&module&&module.exports;if(commonJS)module.exports=api;if(typeof window==='object'&&window||!commonJS)root.SearchHistory=api;})(typeof window==='object'&&window?window:globalThis,function(){
  'use strict';
  const KEY='shikuang-searches-v2';
  function normalize(rows){
    if(!Array.isArray(rows))return [];
    const valid=[];
    for(const row of rows){
      if(!row||typeof row.query!=='string'||!['library','records'].includes(row.kind))continue;
      const query=row.query.trim().slice(0,100);if(!query)continue;
      valid.push({query,kind:row.kind,time:Number(row.time)||0});
      if(valid.length===20)break;
    }
    return valid;
  }
  function add(rows,query,kind,time=Date.now()){query=String(query||'').trim().slice(0,100);if(!query||!['library','records'].includes(kind))return normalize(rows);return [{query,kind,time},...normalize(rows).filter(x=>!(x.kind===kind&&x.query.toLowerCase()===query.toLowerCase()))].slice(0,20);}
  function read(){try{return normalize(JSON.parse(localStorage.getItem(KEY)||'[]'));}catch(_){return [];}}
  function save(query,kind){const rows=add(read(),query,kind);try{localStorage.setItem(KEY,JSON.stringify(rows));}catch(_){}return rows;}
  function clear(){try{localStorage.removeItem(KEY);}catch(_){} }
  return {normalize,add,read,save,clear};
});
