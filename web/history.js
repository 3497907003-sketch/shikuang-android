(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.SearchHistory=api;})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  const KEY='shikuang-searches-v2';
  function normalize(rows){return Array.isArray(rows)?rows.filter(x=>x&&typeof x.query==='string'&&['library','records'].includes(x.kind)).slice(0,20).map(x=>({query:x.query.trim().slice(0,100),kind:x.kind,time:Number(x.time)||0})).filter(x=>x.query):[];}
  function add(rows,query,kind,time=Date.now()){query=String(query||'').trim().slice(0,100);if(!query||!['library','records'].includes(kind))return normalize(rows);return [{query,kind,time},...normalize(rows).filter(x=>!(x.kind===kind&&x.query.toLowerCase()===query.toLowerCase()))].slice(0,20);}
  function read(){try{return normalize(JSON.parse(localStorage.getItem(KEY)||'[]'));}catch(_){return [];}}
  function save(query,kind){const rows=add(read(),query,kind);try{localStorage.setItem(KEY,JSON.stringify(rows));}catch(_){}return rows;}
  function clear(){try{localStorage.removeItem(KEY);}catch(_){} }
  return {normalize,add,read,save,clear};
});
