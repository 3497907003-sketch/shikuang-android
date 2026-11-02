// The large reference collection loads when opening the library or a detail. Photo
// inference and saving specimens do not wait for this download.
(() => {
  let pending = null;
  const api = {status:'idle', error:'', completed:0, total:3, load};
  window.MineralReference = api;
  async function read(path, signal, retry, expected) {
    const response = await fetch(path, {signal, cache:retry?'reload':'default'});
    if (!response.ok) throw new Error(`资料资源请求失败（${response.status}）`);
    if(!window.MineralCore?.readResource)throw new Error('资料读取组件未就绪，请更新页面或 App');
    try{return await window.MineralCore.readResource(response,path.endsWith('reference-manifest.json')?65536:12*1048576,expected,
      ()=>{if(signal.aborted)throw new DOMException('资料读取已停止','AbortError');},{signal,timeout:45000});}
    catch(error){if(error.name==='AbortError')throw error;throw new Error('资料资源不完整，请重试修复缓存：'+error.message);}
  }
  async function digest(bytes) {
    if (!globalThis.crypto?.subtle) throw new Error('当前浏览器无法核验资料资源，请更新浏览器或 App');
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), x => x.toString(16).padStart(2,'0')).join('');
  }
  function load({retry=false}={}) {
    if (api.status === 'ready') return Promise.resolve(window.MINERAL_CATALOG);
    if (pending) return pending;
    api.status='loading'; api.error=''; api.completed=0;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    pending = (async () => {
      try {
        const decoder = new TextDecoder('utf-8', {fatal:true});
        const manifest = JSON.parse(decoder.decode(await read('./data/reference-manifest.json', controller.signal, retry)));
        if (manifest.schema_version !== 1 || !Array.isArray(manifest.files) || manifest.files.length !== 3) throw new Error('资料清单格式不兼容');
        const allow = new Set(['data/catalog.json','data/crystals.json','data/image-sources.json']);
        const staged = {};
        for (const file of manifest.files) {
          if (!allow.delete(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes<1 || file.bytes>12*1048576) throw new Error('资料清单包含无效资源');
          const bytes = await read('./'+file.path, controller.signal, retry, file.bytes);
          if (bytes.length !== file.bytes || await digest(bytes) !== file.sha256) throw new Error('资料资源不完整，请重试修复缓存');
          staged[file.path] = JSON.parse(decoder.decode(bytes));
          api.completed++;
        }
        const catalog = staged['data/catalog.json'];
        if (catalog.schema_version !== 1 || !Array.isArray(catalog.minerals) || catalog.minerals.length !== catalog.count) throw new Error('矿物目录条数不一致');
        const crystals = staged['data/crystals.json'];
        if (crystals.schema_version !== 1 || !crystals.by_species) throw new Error('晶胞资料格式不兼容');
        window.MINERAL_CATALOG=catalog;
        window.MINERAL_CRYSTAL_RECORDS=crystals;
        window.MINERAL_IMAGE_SOURCES=staged['data/image-sources.json'];
        api.status='ready';
        return catalog;
      } catch (error) {
        controller.abort();
        api.status='error';
        api.error=error.name==='AbortError'?'打开完整资料库超时；照片识别仍可使用。请重试或准备离线资源。':error.message;
        throw new Error(api.error);
      } finally {
        clearTimeout(timer); pending=null;
      }
    })();
    return pending;
  }
})();
