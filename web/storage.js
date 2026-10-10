(function () {
  'use strict';
  let database;
  const open = () => database || (database = new Promise((resolve, reject) => {
    const request = indexedDB.open('shikuang-specimens', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('records', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = null; reject(new Error('本机存储不可用，请检查 App 存储权限')); };
  }));
  async function transaction(mode, action) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('records', mode), store = tx.objectStore('records');
      let result;
      let failure;
      try { action(store, value => { result = value; }, message => { failure=new Error(message);tx.abort(); }); }
      catch (e) { failure=e;tx.abort(); }
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(new Error('保存失败，可能是本机存储空间不足；请先导出记录'));
      tx.onabort = () => reject(failure || new Error('标本存储操作未完成，请重试'));
    });
  }
  async function list() { return (await transaction('readonly', (s, done) => { const r = s.getAll(); r.onsuccess = () => done(r.result); })).sort((a, b) => b.time - a.time); }
  async function put(record) {
    const valid = MineralCore.sanitizeRecord(record);
    await transaction('readwrite', (s, done, fail) => {
      const get=s.get(valid.id);get.onsuccess=()=>{if(get.result){s.put(valid);return;}const count=s.count();count.onsuccess=()=>{if(count.result>=100)fail('已保存 100 条标本，请导出并删除部分记录后重试');else s.put(valid);};};
    });
    return valid;
  }
  async function merge(records) {
    const valid=records.map(MineralCore.sanitizeRecord);
    return transaction('readwrite',(s,done,fail)=>{const get=s.getAll();get.onsuccess=()=>{
      const ids=new Set(get.result.map(x=>x.id)),additions=[];
      for(const record of valid){if(!ids.has(record.id)){ids.add(record.id);additions.push(record);}}
      if(ids.size>100){fail('导入后将超过 100 条，请先导出并删除部分标本');return;}
      additions.forEach(x=>s.put(x));done(additions.length);
    };});
  }
  async function migrate() {
    let old;
    try {
      if (localStorage.getItem('shikuang_v2_migrated')) return;
      old = JSON.parse(localStorage.getItem('shikuang_history') || '[]');
    } catch (_) { return; }
    if (!Array.isArray(old)) return;
    const kb = window.MINERAL_KB || {}, keys = Object.keys(kb);
    const records = old.slice(0, 50).map((x, i) => {
      const key = keys.find(k => kb[k].name_zh === x?.name_zh || kb[k].name_en === x?.name_en);
      return key ? { id: `legacy-${x.time || 0}-${i}`, time: x.time, name: kb[key].name_zh, key,
        score: Math.min(1, Math.max(0, Number(x.confidence) / 100 || 0)), rankings: [{ key, score: Number(x.confidence) / 100 }],
        reasons: ['从 1.0 迁移，仅保留原始识别名称与分数'], status: 'uncertain', photoCount: 0 } : null;
    }).filter(Boolean);
    await merge(records);
    try { localStorage.setItem('shikuang_v2_migrated', '1'); } catch (_) {}
  }
  window.SpecimenStore = { list, put, merge, migrate, remove: id => transaction('readwrite', s => s.delete(id)) };
})();
