(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MineralGallery = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  const MAX_BYTES = 1048576;
  function checked(path, bytes, sha256) {
    if (!/^images\/reviewed-v25\/commons-\d+\.jpg$/.test(path || '') ||
        !Number.isSafeInteger(bytes) || bytes < 4 || bytes > MAX_BYTES ||
        !/^[a-f0-9]{64}$/.test(sha256 || '')) throw new Error('内置图库资源记录无效');
    return {path, bytes, sha256};
  }
  function asset(record) {
    if (!record?.local_image_url) return null;
    if (record.permission_status !== 'per_file_license_and_source_reviewed' ||
        !record.image_page_url?.startsWith('https://') || !record.license_url?.startsWith('https://') ||
        !record.author || !record.quality_review || !record.group_id ||
        !Number.isSafeInteger(record.width) || !Number.isSafeInteger(record.height) ||
        Math.min(record.width, record.height) < 224 || Math.max(record.width, record.height) > 512) {
      throw new Error('内置照片缺少审核来源或有效尺寸');
    }
    return checked(record.local_image_url, record.bytes, record.sha256);
  }
  function validateAssets(manifest) {
    if (manifest?.schema_version !== 1 || !Array.isArray(manifest.assets) || manifest.assets.length > 1000) throw new Error('内置图库清单格式不兼容');
    const paths = new Set();
    return manifest.assets.map(row => {
      const value = checked(row.path, row.bytes, row.sha256);
      if (paths.has(value.path)) throw new Error('内置图库清单含重复资源');
      paths.add(value.path); return value;
    });
  }
  function url(value, base) {
    const resource = new URL('./' + value.path, base);
    resource.searchParams.set('image', value.sha256);
    return resource.href;
  }
  async function read(record, {signal, fetch:fetcher=globalThis.fetch, crypto:hashing=globalThis.crypto, core=globalThis.MineralCore, base=globalThis.location?.href}={}) {
    const value=asset(record);
    if (!value || !core?.readResource || !hashing?.subtle) throw new Error('当前环境无法核验内置照片');
    const originalSignal=signal,controller=new AbortController();signal=controller.signal;
    const cancel=()=>controller.abort();originalSignal?.addEventListener('abort',cancel,{once:true});
    if(originalSignal?.aborted)cancel();
    let timer;
    const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('内置照片读取超时，可重新打开图库重试'));},15000);});
    const check=()=>{if(signal.aborted)throw new DOMException('照片读取已停止','AbortError');};
    const bytesFrom=async cache=>{
      const response=await fetcher(url(value,base),{signal,cache});
      if(!response.ok)throw new Error('内置照片暂不可用，请重新准备离线资源');
      const bytes=await core.readResource(response,MAX_BYTES,value.bytes,check,{signal,timeout:15000});check();
      const actual=Array.from(new Uint8Array(await hashing.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');check();
      if(actual!==value.sha256 || bytes[0]!==0xff || bytes[1]!==0xd8)throw new Error('内置照片校验失败，请重新准备离线资源');
      return bytes;
    };
    try{return await Promise.race([(async()=>{
      check();
      try {return await bytesFrom('default');}
      catch(error){if(signal.aborted || error.name==='AbortError')throw error;return bytesFrom('reload');}
    })(),deadline]);}
    finally{clearTimeout(timer);originalSignal?.removeEventListener('abort',cancel);}
  }
  return {MAX_BYTES, asset, validateAssets, url, read};
});
