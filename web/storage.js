(function () {
  'use strict';
  let database;
  function open() {
    if (database) return database;
    let candidate;
    candidate = new Promise((resolve, reject) => {
      let finished = false;
      const reset = () => { if (database === candidate) database = null; };
      const fail = message => { if (finished) return; finished = true; clearTimeout(timer); reset(); reject(new Error(message)); };
      const timer = setTimeout(() => fail('本机记录存储打开超时，请关闭其他识矿页面后重试'), 10000);
      let request;
      try { request = indexedDB.open('shikuang-specimens', 1); }
      catch (_) { fail('本机存储不可用，请检查浏览器或 App 的存储权限'); return; }
      request.onblocked = () => fail('本机记录存储被其他页面占用，请关闭其他识矿页面后重试');
      request.onupgradeneeded = () => {
        if (finished) { request.transaction.abort(); return; }
        if (!request.result.objectStoreNames.contains('records')) request.result.createObjectStore('records', { keyPath: 'id' });
      };
      request.onsuccess = () => {
        const db = request.result;
        // An IndexedDB open cannot be cancelled. Close a late connection instead of keeping a hidden blocker.
        if (finished) { db.close(); return; }
        finished = true; clearTimeout(timer);
        db.onversionchange = () => { reset(); db.close(); };
        db.onclose = reset;
        resolve(db);
      };
      request.onerror = () => fail(request.error?.name === 'VersionError'
        ? '本机记录来自更新版本的识矿，请更新 App 后打开；原有记录已保留'
        : '本机存储不可用，请检查浏览器或 App 的存储权限');
    });
    database = candidate;
    // A synchronous open failure still clears this same promise on the next microtask.
    candidate.catch(() => { if (database === candidate) database = null; });
    return candidate;
  }
  async function transaction(mode, action) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('records', mode), store = tx.objectStore('records');
      let result;
      let failure;
      const timer = setTimeout(() => { failure = new Error('本机记录操作超时，请重试；请先导出备份再清理存储'); try { tx.abort(); } catch (_) { reject(failure); } }, 20000);
      try { action(store, value => { result = value; }, message => { failure=message instanceof Error?message:new Error(message);tx.abort(); }); }
      catch (e) { failure=e;tx.abort(); }
      tx.oncomplete = () => { clearTimeout(timer); resolve(result); };
      tx.onerror = () => { clearTimeout(timer); reject(new Error('记录操作失败，可能是本机存储空间不足；请先导出记录')); };
      tx.onabort = () => { clearTimeout(timer); reject(failure || new Error('标本存储操作未完成，请重试')); };
    });
  }
  async function list() { return (await transaction('readonly', (s, done) => { const r = s.getAll(); r.onsuccess = () => done(r.result); })).sort((a, b) => b.time - a.time); }
  async function put(record, options = {}) {
    const valid = MineralCore.sanitizeRecord(record);
    let saved = valid;
    await transaction('readwrite', (s, done, fail) => {
      const get=s.get(valid.id);get.onsuccess=()=>{
        if(get.result){
          // Analysis can finish after a manual review. Read the latest review
          // inside this same write transaction instead of trusting a UI snapshot.
          let sampleId=valid.sampleId;
          if(options.preserveReview&&Object.prototype.hasOwnProperty.call(options,'expectedSampleId')){
            const expected=typeof options.expectedSampleId==='string'?options.expectedSampleId:'',latest=typeof get.result.sampleId==='string'?get.result.sampleId:'';
            // An untouched form follows the latest review; two intentional
            // edits must be resolved by an explicit retry, never silently lost.
            if(latest!==expected&&sampleId!==latest){
              if(sampleId!==expected){const error=new Error(`标本编号已由其他操作更新为“${latest||'未设置'}”，请核对后重试`);error.code='SAMPLE_ID_CONFLICT';error.latestSampleId=latest;fail(error);return;}
              sampleId=latest;
            }
          }
          saved=options.preserveReview?MineralCore.sanitizeRecord({...valid,sampleId,confirmedKey:get.result.confirmedKey,confirmationMethod:get.result.confirmationMethod}):valid;
          s.put(saved);return;
        }
        if(options.requireExisting){fail('该标本已被删除，未重新创建；请开始新标本');return;}
        const count=s.count();count.onsuccess=()=>{if(count.result>=100)fail('已保存 100 条标本，请导出并删除部分记录后重试');else s.put(saved);};
      };
    });
    return saved;
  }
  async function review(id, fields) {
    if (!fields || typeof fields !== 'object' || Object.keys(fields).some(key => !['sampleId','confirmedKey','confirmationMethod'].includes(key))) throw new Error('仅支持更新标本编号与人工复核信息');
    return transaction('readwrite', (s, done, fail) => {
      const get=s.get(id);get.onsuccess=()=>{
        if(!get.result){fail('该标本已被删除，复核信息未保存');return;}
        try {
          const clean=MineralCore.sanitizeRecord({...get.result,...fields,id:get.result.id});
          const saved={...get.result};for(const key of Object.keys(fields))saved[key]=clean[key];
          s.put(saved);done(saved);
        } catch (error) { fail(error.message || '复核信息无效，原记录已保留'); }
      };
    });
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
    if (old.length > 100) throw new Error('旧版记录超过 100 条，未迁移或截断；原始记录已保留，请先备份并整理后重试');
    const kb = window.MINERAL_KB || {}, keys = Object.keys(kb);
    const records = old.map((x, i) => {
      const key = keys.find(k =>
        (typeof x?.name_zh === 'string' && x.name_zh.trim() && kb[k]?.name_zh === x.name_zh) ||
        (typeof x?.name_en === 'string' && x.name_en.trim() && kb[k]?.name_en === x.name_en));
      return key ? { id: `legacy-${x.time || 0}-${i}`, time: x.time, name: kb[key].name_zh, key,
        score: Math.min(1, Math.max(0, Number(x.confidence) / 100 || 0)), rankings: [{ key, score: Number(x.confidence) / 100 }],
        reasons: ['从 1.0 迁移，仅保留原始识别名称与分数'], status: 'uncertain', photoCount: 0 } : null;
    }).filter(Boolean);
    await merge(records);
    // Do not permanently hide unmatched legacy records when knowledge failed
    // to load. Deterministic IDs make a later partial retry idempotent.
    if (records.length === old.length) {
      try { localStorage.setItem('shikuang_v2_migrated', '1'); } catch (_) {}
    }
  }
  window.SpecimenStore = { list, put, review, merge, migrate, remove: id => transaction('readwrite', s => s.delete(id)) };
})();
