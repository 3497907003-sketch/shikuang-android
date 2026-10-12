/* Shared, testable decision rules. Model scores are not calibrated accuracy. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MineralCore = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const POLICY = Object.freeze({ score: 0.65, margin: 0.20, agreement: 2/3, version: '2.0-preview' });
  const OFFLINE_CACHES = Object.freeze({ shell:'shikuang-static-2.5.0-preview.1-r9', models:'shikuang-models-v2-20261010' });
  function offlineCaches(base) {
    const scope = new URL('./', base);
    if (!['https:','http:'].includes(scope.protocol) || scope.username || scope.password) throw new Error('离线应用地址无效');
    const prefix = 'shikuang-scope-' + encodeURIComponent(scope.href) + '::';
    return Object.freeze({ scope:scope.href, prefix, shell:prefix+OFFLINE_CACHES.shell, models:prefix+OFFLINE_CACHES.models });
  }
  async function offlineWorkerIdentity(serviceWorker, base, signal, Channel) {
    const expected = offlineCaches(base), scriptURL = new URL('sw.js', expected.scope).href;
    const stopped = () => new DOMException('离线准备已停止','AbortError');
    if (signal?.aborted) throw stopped();
    const registration = await new Promise((resolve,reject) => {
      const finish = (error,value) => { signal?.removeEventListener('abort',cancel); error?reject(error):resolve(value); };
      const cancel = () => finish(stopped());
      signal?.addEventListener('abort',cancel,{once:true});
      Promise.resolve(serviceWorker.ready).then(value=>finish(null,value),finish);
    });
    if (signal?.aborted) throw stopped();
    if (!registration || registration.scope !== expected.scope) throw new Error('离线服务范围不一致，请刷新页面后重试');
    const worker = await new Promise((resolve,reject) => {
      const watched = new Set(); let settled = false;
      const finish = (error,value) => {
        if (settled) return; settled = true;
        signal?.removeEventListener('abort',cancel);
        serviceWorker.removeEventListener('controllerchange',check);
        registration.removeEventListener('updatefound',check);
        watched.forEach(item=>item.removeEventListener('statechange',check));
        error?reject(error):resolve(value);
      };
      const cancel = () => finish(stopped());
      const check = () => {
        if (signal?.aborted) { cancel(); return; }
        for (const item of [registration.installing,registration.waiting,registration.active,serviceWorker.controller]) {
          if (item && !watched.has(item)) { watched.add(item); item.addEventListener('statechange',check); }
        }
        if (registration.installing && registration.installing.state !== 'redundant') return;
        if (registration.waiting) { registration.waiting.postMessage({type:'ACTIVATE_UPDATE'}); return; }
        const controller = serviceWorker.controller;
        if (registration.active?.state !== 'activated' || controller?.state !== 'activated') return;
        if (controller.scriptURL !== scriptURL) { finish(new Error('离线服务已变更，请刷新页面后重试')); return; }
        finish(null,controller);
      };
      signal?.addEventListener('abort',cancel,{once:true});
      serviceWorker.addEventListener('controllerchange',check);
      registration.addEventListener('updatefound',check); check();
    });
    if (typeof Channel !== 'function') throw new Error('浏览器无法检查离线服务，请使用安装版');
    return new Promise((resolve,reject) => {
      const channel = new Channel(); let settled = false;
      const finish = (error,value) => {
        if (settled) return; settled = true;
        signal?.removeEventListener('abort',cancel); channel.port1.close(); channel.port2.close();
        error?reject(error):resolve(value);
      };
      const cancel = () => finish(stopped());
      signal?.addEventListener('abort',cancel,{once:true});
      channel.port1.onmessage = event => {
        const value = event.data;
        if (signal?.aborted) { cancel(); return; }
        if (serviceWorker.controller !== worker || value?.scope !== expected.scope || value?.shell !== expected.shell || value?.models !== expected.models) {
          finish(new Error('页面与离线资源版本不一致，请刷新页面后重新准备')); return;
        }
        finish(null,expected);
      };
      if (signal?.aborted) { cancel(); return; }
      try { worker.postMessage({type:'OFFLINE_IDENTITY'},[channel.port2]); }
      catch (error) { finish(error); }
    });
  }
  // The entry document owns its exact dependency URLs, including version queries.
  // Keep these identities in Cache Storage; stripping queries can mix releases.
  function shellAssets(html, base) {
    if (typeof html !== 'string' || html.length > 1000000) throw new Error('离线页面内容无效');
    const scope = new URL('./', base), urls = new Set();
    const attribute = (tag, name) => tag.match(new RegExp('(?:^|\\s)'+name+'\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')','i'))?.slice(1).find(value => value !== undefined);
    for (const match of html.matchAll(/<(script|link)\b[^>]*>/gi)) {
      const tag = match[0], script = match[1].toLowerCase() === 'script';
      if (!script && !/\b(?:stylesheet|manifest|icon)\b/i.test(attribute(tag,'rel') || '')) continue;
      const value = attribute(tag, script ? 'src' : 'href');
      if (!value) continue;
      const url = new URL(value.replace(/&amp;/g,'&'), base);
      if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) throw new Error('离线页面资源超出应用范围');
      if (url.hash || url.username || url.password || !/\.(?:js|css|svg|png|webmanifest)$/i.test(url.pathname)) throw new Error('离线页面资源地址无效');
      urls.add(url.href);
    }
    return [...urls];
  }
  const BACKUP_LIMIT_BYTES = 100 * 1024 * 1024;
  function checkBackupSize(value) {
    const bytes = typeof value === 'number' ? value : typeof value === 'string' ? new TextEncoder().encode(value).byteLength : NaN;
    if (!Number.isFinite(bytes) || bytes < 0) throw new Error('备份文件大小无效');
    if (bytes > BACKUP_LIMIT_BYTES) throw new Error('备份文件超过 100 MB，请选择完整的识矿标本备份文件');
    return bytes;
  }
  function softmax(values) {
    const a = Array.from(values);
    if (!a.length || a.some(x => !Number.isFinite(x))) throw new Error('模型输出包含无效数值');
    const max = Math.max(...a), exp = a.map(x => Math.exp(x - max));
    const sum = exp.reduce((s, x) => s + x, 0);
    return exp.map(x => x / sum);
  }
  function probabilities(values) {
    const a = Array.from(values);
    if (!a.length || a.some(x => !Number.isFinite(x))) throw new Error('模型输出包含无效数值');
    const sum = a.reduce((s, x) => s + x, 0);
    return a.every(x => x >= 0 && x <= 1) && Math.abs(sum - 1) < 0.001 ? a : softmax(a);
  }
  const NON_MINERAL = '这不是矿物，请您放入清晰的矿物照片。';
  const MODEL_MAX_BYTES = 80000000;
  const MODEL_PATHS = ['models/mobilenet.onnx','models/mobilenet_int8.onnx','models/efficientnet.onnx','models/efficientnet_legacy.onnx','models/imagenet_gate.onnx'];
  /** The manifest selects weights and modes; this bounded contract selects supported runtime formats. */
  function validateManifest(value, expectedLabels) {
    const invalid = () => { throw new Error('模型清单或输入契约不匹配，请更新 App 或离线资源'); };
    if (!value || value.schemaVersion !== 1 || typeof value.version !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(value.version)) invalid();
    const input = value.input;
    if (!input || input.dtype !== 'float32' || input.layout !== 'NCHW' || input.colorSpace !== 'RGB' || input.pixelScale !== 255 || input.resize !== 'bilinear' || input.crop !== 'user-selected center square' || JSON.stringify(input.shape) !== '[1,3,224,224]') invalid();
    if (JSON.stringify(input.normalization?.mean) !== '[0.485,0.456,0.406]' || JSON.stringify(input.normalization?.std) !== '[0.229,0.224,0.225]') invalid();
    const labels = value.labels;
    if (!Array.isArray(labels) || labels.length < 2 || labels.length > 256 || new Set(labels).size !== labels.length || labels.some(k => typeof k !== 'string' || !/^[a-z][a-z0-9_]{0,60}$/.test(k))) invalid();
    if (expectedLabels && JSON.stringify(labels) !== JSON.stringify(expectedLabels)) throw new Error('模型标签类序不匹配，请更新 App');
    if (!Array.isArray(value.models) || value.models.length < 3 || value.models.length > 4) invalid();
    const ids = new Set(), paths = new Set();
    const models = value.models.map(row => {
      if (!row || typeof row.id !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(row.id) || ids.has(row.id) || paths.has(row.path) || !MODEL_PATHS.includes(row.path)) invalid();
      ids.add(row.id); paths.add(row.path);
      if (!['input-gate','mineral-classifier'].includes(row.role) || row.classes !== (row.role === 'input-gate' ? 1000 : labels.length) || (row.path === 'models/imagenet_gate.onnx') !== (row.role === 'input-gate')) invalid();
      if (!Number.isInteger(row.bytes) || row.bytes < 1 || row.bytes > MODEL_MAX_BYTES || !/^[a-f0-9]{64}$/.test(row.sha256) || row.output !== 'logits') invalid();
      if (![row.inputName,row.outputName].every(x => typeof x === 'string' && /^[A-Za-z0-9_.:/-]{1,120}$/.test(x))) invalid();
      const temperature = row.temperature === undefined ? 1 : row.temperature;
      if (!Number.isFinite(temperature) || temperature < 0.05 || temperature > 10 || (row.role === 'input-gate' && temperature !== 1)) invalid();
      return Object.freeze({id:row.id,role:row.role,path:row.path,file:row.path.slice(7),title:typeof row.title === 'string' ? row.title.slice(0,40) : row.id,bytes:row.bytes,sha256:row.sha256,classes:row.classes,output:'logits',inputName:row.inputName,outputName:row.outputName,temperature});
    });
    if (models.filter(m => m.role === 'input-gate').length !== 1) invalid();
    const classifiers = models.filter(m => m.role === 'mineral-classifier');
    const fast = value.modes?.fast, ensemble = value.modes?.ensemble;
    if (!Array.isArray(fast) || fast.length !== 1 || !Array.isArray(ensemble) || ensemble.length < 2 || ensemble.length > 3 || new Set(ensemble).size !== ensemble.length || ensemble.length !== classifiers.length || !ensemble.includes(fast[0]) || ensemble.some(id => !classifiers.some(m => m.id === id))) invalid();
    return Object.freeze({schemaVersion:1,version:value.version,input:Object.freeze({...input,shape:Object.freeze([...input.shape]),normalization:Object.freeze({mean:Object.freeze([...input.normalization.mean]),std:Object.freeze([...input.normalization.std])})}),labels:Object.freeze([...labels]),models:Object.freeze(models),modes:Object.freeze({fast:Object.freeze([...fast]),ensemble:Object.freeze([...ensemble])})});
  }
  function selectedModels(manifest, precision = true) {
    return manifest.modes[precision ? 'ensemble' : 'fast'].map(id => manifest.models.find(m => m.id === id));
  }
  function modelResourceURL(model, manifestSha256, base) {
    if (!model || !MODEL_PATHS.includes(model.path) || !/^[a-f0-9]{64}$/.test(model.sha256) || !/^[a-f0-9]{64}$/.test(manifestSha256)) throw new Error('模型资源身份不完整，请重新读取清单');
    const url = new URL(model.path, base);
    if (!['http:','https:'].includes(url.protocol)) throw new Error('模型资源协议不正确');
    url.searchParams.set('manifest',manifestSha256);url.searchParams.set('model',model.sha256);
    return url;
  }
  async function readResource(response, maximum, expectedBytes, progress = () => {}, options = {}) {
    if (!response.ok) throw new Error(`识别资源读取失败 (${response.status})，请更新或准备离线资源`);
    if ((response.headers?.get('content-type') || '').includes('text/html')) throw new Error('识别资源地址返回了网页，请更新 App 资源');
    let reader, size = 0, timer, cancel;
    const stopped=new Promise((_,reject)=>{
      cancel=()=>reject(new DOMException('资源读取已停止','AbortError'));
      options.signal?.addEventListener('abort',cancel,{once:true});
      if(options.signal?.aborted)cancel();
      timer=setTimeout(()=>reject(new Error('识别资源读取超时，请重试或准备离线资源')),options.timeout||90000);
    });
    try {
      if (response.body?.getReader) {
        reader = response.body.getReader();
        // ONNX size comes from the validated manifest: one allocation instead of chunks + joined bytes.
        const bytes = expectedBytes ? new Uint8Array(expectedBytes) : null, chunks = [];
        for (;;) {
          const part = await Promise.race([reader.read(),stopped]); if (part.done) break;
          if (size + part.value.length > maximum || (bytes && size + part.value.length > bytes.length)) throw new Error('识别资源大小不匹配，请更新 App 或离线资源');
          if (bytes) bytes.set(part.value,size); else chunks.push(part.value);
          size += part.value.length; progress(size);
        }
        if (expectedBytes && size !== expectedBytes) throw new Error('识别资源大小不匹配，请更新 App 或离线资源');
        if (bytes) return bytes;
        const joined = new Uint8Array(size); let offset = 0;
        for (const part of chunks) { joined.set(part,offset); offset += part.length; }
        return joined;
      }
      const bytes = new Uint8Array(await Promise.race([response.arrayBuffer(),stopped]));
      if (bytes.length > maximum || (expectedBytes && bytes.length !== expectedBytes)) throw new Error('识别资源大小不匹配，请更新 App 或离线资源');
      return bytes;
    } catch (error) { if (reader) void reader.cancel().catch(()=>{}); throw error; }
    finally { clearTimeout(timer);options.signal?.removeEventListener('abort',cancel);try{reader?.releaseLock();}catch(_){} }
  }
  function pixelsToInput(rgba, input) {
    if (!rgba || rgba.length !== 224 * 224 * 4) throw new Error('图像张量大小不正确');
    const tensor = new Float32Array(3 * 224 * 224);
    const {mean,std} = input.normalization;
    for (let c=0;c<3;c++) for (let i=0;i<224*224;i++) tensor[c*224*224+i]=(rgba[i*4+c]/input.pixelScale-mean[c])/std[c];
    return tensor;
  }
  function validateAnalysis(raw, photoCount, models, manifest, manifestHash) {
    if (!raw || !Array.isArray(raw.runs) || !Array.isArray(raw.screening) || !Array.isArray(raw.warnings) || raw.manifestSha256 !== manifestHash || raw.modelVersion !== manifest.version) throw new Error('识别组件与模型清单版本不匹配，请更新后重试');
    if (raw.rejected) return;
    if (raw.screening.length !== photoCount || new Set(raw.screening.map(r => r?.photo)).size !== photoCount || raw.screening.some(r => !r || !Number.isInteger(r.photo) || r.photo < 0 || r.photo >= photoCount || !Array.isArray(r.values) || r.values.length !== 1000 || r.values.some(x => !Number.isFinite(x)))) throw new Error('输入筛查未完成，请重试；本次不生成矿物候选');
    if (raw.runs.length !== models.length * photoCount) throw new Error('所选模型分析未完成，本次不生成矿物候选；请重试或主动选择快速模式');
    const seen = new Set();
    for (const run of raw.runs) {
      if (!run) throw new Error('模型输出与所选模型或标签清单不匹配');
      const model = models.find(m => m.id === run.model), key = `${run.photo}:${run.model}`;
      if (!model || !Number.isInteger(run.photo) || run.photo < 0 || run.photo >= photoCount || seen.has(key) || !Array.isArray(run.values) || run.values.length !== manifest.labels.length || run.values.some(x => !Number.isFinite(x))) throw new Error('模型输出与所选模型或标签清单不匹配');
      seen.add(key);
    }
  }
  function screen(values, blocked = []) {
    const p=softmax(values); if(p.length!==1000)throw new Error('筛查模型类别数量不匹配');
    const top=argmax(p), living=top<=397 || [981,982,983].includes(top);
    return { rejected:(living || !!blocked[top]) && p[top]>=0.65, key:top, score:p[top], message:NON_MINERAL };
  }
  function argmax(a) { return a.reduce((best, x, i) => x > a[best] ? i : best, 0); }
  function average(vectors) {
    if (!vectors.length || vectors.some(v => v.length !== vectors[0].length)) throw new Error('模型输出类别数量不一致');
    return vectors[0].map((_, i) => vectors.reduce((s, v) => s + v[i], 0) / vectors.length);
  }
  function hardnessRange(value) {
    if (value === null || value === undefined || value === '') return null;
    // Directional measurements cannot be compared with an unoriented scratch test.
    const text = String(value);
    if (/[∥⊥]|parallel|perpendicular|\[[\d\s+-]+\]/i.test(text)) return null;
    const normalized = text.replace(/(\d+)([¼½¾])/g, (_, whole, part) => String(Number(whole) + ({'¼':0.25,'½':0.5,'¾':0.75})[part]));
    if (/[¼½¾]/.test(normalized)) return null;
    const numbers = normalized.match(/\d+(?:\.\d+)?/g)?.map(Number);
    if (!numbers?.length || numbers.some(x => x < 0 || x > 10)) return null;
    return [Math.min(...numbers), Math.max(...numbers)];
  }
  function evidenceFor(knowledge, observation = {}) {
    // Displayable legacy text is not sufficient evidence for a physical check.
    // Only source-reviewed facts can support a match or conflict conclusion.
    const fact = field => {
      const item = knowledge?.verified_properties?.[field];
      return item?.status === 'verified' && typeof item.source_url === 'string' &&
        /^https:\/\/[^\s]+$/i.test(item.source_url) && item.value !== null && item.value !== undefined && item.value !== '' ? item.value : null;
    };
    const hardness = fact('hardness'), sourceLuster = fact('luster');
    const checks = [], observed = Number(observation.hardness);
    const range = hardnessRange(hardness);
    if (observation.hardness !== '' && observation.hardness !== undefined && observation.hardness !== null && range && Number.isFinite(observed) && observed >= 1 && observed <= 10) {
      checks.push({ property: '摩氏硬度', expected: String(hardness), observed: String(observed),
        status: observed >= range[0] - 0.5 && observed <= range[1] + 0.5 ? 'match' : 'conflict' });
    }
    const luster = observation.luster;
    if (['metal','nonmetal'].includes(luster) && sourceLuster !== null) {
      // Non-metallic and metallic are the only mutually exclusive comparison here.
      const text = String(sourceLuster);
      const hasMetal = /金属|metallic/i.test(text.replace(/非金属|non[-\s]?metallic/gi,'')), hasNonMetal = /非金属|玻璃|丝绢|珍珠|油脂|树脂|蜡|土状|non[-\s]?metallic|vitreous|silky|pearly|greasy|resinous|waxy|earthy|adamantine/i.test(text);
      const compatible = luster === 'metal' ? hasMetal : hasNonMetal;
      const known = hasMetal || hasNonMetal;
      if (known) checks.push({ property: '光泽', expected: text, observed: luster === 'metal' ? '金属光泽' : '非金属光泽', status: compatible ? 'match' : 'conflict' });
    }
    return checks;
  }
  function summarize(runs, keys, knowledge = {}, observation = {}) {
    if (!runs.length || !keys.length) throw new Error('缺少分析结果');
    const converted = runs.map(r => {
      const temperature = r.temperature === undefined ? 1 : r.temperature;
      if (!Number.isFinite(temperature) || temperature < 0.05 || temperature > 10) throw new Error('模型校准温度无效');
      return {...r,p:r.output === 'logits' || temperature !== 1 ? softmax(Array.from(r.values,x=>x/temperature)) : probabilities(r.values)};
    });
    if (converted.some(r => r.p.length !== keys.length)) throw new Error('模型类别与标签表不匹配');
    // Equal weight per photo first; adding more outputs for one photo cannot dominate.
    const photoIds = [...new Set(converted.map(r => r.photo))];
    const byPhoto = photoIds.map(id => average(converted.filter(r => r.photo === id).map(r => r.p)));
    const mean = average(byPhoto), top = argmax(mean);
    const order = mean.map((_, i) => i).sort((a, b) => mean[b] - mean[a]);
    const agreement = converted.filter(r => argmax(r.p) === top).length / converted.length;
    const viewAgreement = byPhoto.filter(p => argmax(p) === top).length / byPhoto.length;
    const rankings = order.slice(0, 5).map(i => ({ key: keys[i], score: mean[i], checks: evidenceFor(knowledge[keys[i]], observation) }));
    const conflict = rankings[0].checks.some(c => c.status === 'conflict');
    const margin = mean[top] - (mean[order[1]] || 0);
    const reasons = [];
    if (mean[top] < POLICY.score) reasons.push('图像模型分数较低');
    if (margin < POLICY.margin) reasons.push('前两项候选接近');
    if (agreement < POLICY.agreement) reasons.push('不同模型的判断不一致');
    if (viewAgreement < 1) reasons.push('不同拍摄角度的判断不一致');
    if (conflict) reasons.push('实测物性与首选候选冲突');
    return { key: keys[top], score: mean[top], margin, agreement, viewAgreement, photoCount: photoIds.length,
      modelCount: new Set(converted.map(r => r.model)).size, rankings, checks: rankings[0].checks,
      status: reasons.length ? 'uncertain' : 'consistent', reasons, policy: POLICY.version,
      scores: mean, source: 'local' };
  }
  function qualityWarnings({mean, contrast, sharpness, darkFraction, brightFraction}) {
    const warnings = [];
    if (mean < 35 || darkFraction > 0.8) warnings.push('画面偏暗，请增加均匀照明');
    if (mean > 235 || brightFraction > 0.8) warnings.push('画面过曝，请避免直射反光');
    if (contrast < 8) warnings.push('画面纹理过少，请靠近标本或对焦');
    else if (sharpness < 12) warnings.push('画面可能模糊，请保持手机稳定并对焦');
    return warnings;
  }
  function quality(rgba, width, height) {
    const count = width * height;
    if (rgba.length !== count * 4 || count < 9) throw new Error('无效图像');
    const gray = new Float64Array(count);
    let mean = 0, dark = 0, bright = 0;
    for (let i = 0; i < count; i++) {
      gray[i] = 0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2];
      mean += gray[i]; dark += gray[i] < 15; bright += gray[i] > 245;
    }
    mean /= count;
    let variance = 0, lapSum = 0, lapSquare = 0, n = 0;
    for (let i = 0; i < count; i++) variance += (gray[i] - mean) ** 2;
    for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
      const i = y * width + x, lap = gray[i - 1] + gray[i + 1] + gray[i - width] + gray[i + width] - 4 * gray[i];
      lapSum += lap; lapSquare += lap * lap; n++;
    }
    const sharpness = lapSquare / n - (lapSum / n) ** 2;
    const stats = { mean, sharpness, contrast: Math.sqrt(variance / count), darkFraction:dark/count, brightFraction:bright/count };
    return { ...stats, warnings:qualityWarnings(stats) };
  }
  function sanitizeRecord(input) {
    if (!input || typeof input !== 'object' || !Array.isArray(input.rankings) || !input.rankings.length) throw new Error('无效标本记录');
    const str = (v, max = 500) => typeof v === 'string' ? v.slice(0, max) : '';
    const score = x => Number.isFinite(x) && x >= 0 && x <= 1 ? x : 0;
    const validKey = key => /^[a-z][a-z0-9_]{0,60}$/.test(key);
    const rankings = input.rankings.slice(0, 5).filter(r => r && validKey(r.key)).map(r => ({ key: r.key, score: score(r.score) }));
    if (!rankings.length) throw new Error('记录缺少有效候选');
    return { id: str(input.id, 100) || `import-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      time: Number.isFinite(input.time) && input.time > 0 ? input.time : Date.now(),
      key: rankings[0].key, name: str(input.name, 100), score: score(input.score), rankings,
      status: input.status === 'consistent' ? 'consistent' : 'uncertain',
      reasons: Array.isArray(input.reasons) ? input.reasons.slice(0, 10).map(x => str(x, 200)) : [],
      agreement: score(input.agreement), viewAgreement: score(input.viewAgreement),
      photoCount: Math.max(0, Math.min(3, Number(input.photoCount) || 0)),
      modelCount: Math.max(0, Math.min(3, Number(input.modelCount) || 0)),
      modelVersion: typeof input.modelVersion === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(input.modelVersion) ? input.modelVersion : '',
      manifestSha256: typeof input.manifestSha256 === 'string' && /^[a-f0-9]{64}$/.test(input.manifestSha256) ? input.manifestSha256 : '',
      sampleId: str(input.sampleId, 100), notes: str(input.notes, 2000), scene: input.scene === 'lab' ? 'lab' : 'daily',
      observation: { hardness: str(String(input.observation?.hardness ?? ''), 10),
        luster: ['metal', 'nonmetal'].includes(input.observation?.luster) ? input.observation.luster : '' },
      confirmedKey: validKey(input.confirmedKey || '') ? input.confirmedKey : '',
      confirmationMethod: str(input.confirmationMethod, 100),
      photos: Array.isArray(input.photos) ? input.photos.slice(0, 3).filter(x => typeof x === 'string' && x.length < 250000 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(x)) : [],
      policy: str(input.policy, 100) || POLICY.version, source: 'local' };
  }
  function parseImport(text) {
    checkBackupSize(text);
    const data = JSON.parse(text);
    if (data?.schema !== 'shikuang-records' || data.version !== 2 || !Array.isArray(data.records) || data.records.length > 100) throw new Error('请选择识矿导出的标本文件（最多 100 条）');
    const records = data.records.map(sanitizeRecord);
    if (new Set(records.map(r => r.id)).size !== records.length) throw new Error('导入文件包含重复记录编号');
    return records;
  }
  return { POLICY, OFFLINE_CACHES, offlineCaches, offlineWorkerIdentity, shellAssets, NON_MINERAL, BACKUP_LIMIT_BYTES, MODEL_MAX_BYTES, validateManifest, selectedModels, modelResourceURL, readResource, pixelsToInput, validateAnalysis, checkBackupSize, screen, softmax, probabilities, average, argmax, hardnessRange, evidenceFor, summarize, quality, qualityWarnings, sanitizeRecord, parseImport };
});
