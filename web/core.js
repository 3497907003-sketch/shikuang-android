/* Shared, testable decision rules. Model scores are not calibrated accuracy. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MineralCore = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const POLICY = Object.freeze({ score: 0.65, margin: 0.20, agreement: 2/3, version: '2.0-preview' });
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
    const numbers = String(value).match(/\d+(?:\.\d+)?/g)?.map(Number);
    if (!numbers?.length || numbers.some(x => x < 0 || x > 10)) return null;
    return [Math.min(...numbers), Math.max(...numbers)];
  }
  function evidenceFor(knowledge, observation = {}) {
    const checks = [], observed = Number(observation.hardness);
    const range = hardnessRange(knowledge?.hardness);
    if (observation.hardness !== '' && observation.hardness !== undefined && range && Number.isFinite(observed)) {
      checks.push({ property: '摩氏硬度', expected: String(knowledge.hardness), observed: String(observed),
        status: observed >= range[0] - 0.5 && observed <= range[1] + 0.5 ? 'match' : 'conflict' });
    }
    const luster = observation.luster;
    if (luster && knowledge?.luster) {
      // Non-metallic and metallic are the only mutually exclusive comparison here.
      const text = knowledge.luster;
      const hasMetal = text.replace(/非金属/g,'').includes('金属'), hasNonMetal = /非金属|玻璃|丝绢|珍珠|油脂|树脂|蜡|土状/.test(text);
      const compatible = luster === 'metal' ? hasMetal : hasNonMetal;
      const known = hasMetal || hasNonMetal;
      if (known) checks.push({ property: '光泽', expected: text, observed: luster === 'metal' ? '金属光泽' : '非金属光泽', status: compatible ? 'match' : 'conflict' });
    }
    return checks;
  }
  function summarize(runs, keys, knowledge = {}, observation = {}) {
    if (!runs.length || !keys.length) throw new Error('缺少分析结果');
    const converted = runs.map(r => ({ ...r, p: probabilities(r.values) }));
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
      sampleId: str(input.sampleId, 100), notes: str(input.notes, 2000), scene: input.scene === 'lab' ? 'lab' : 'daily',
      observation: { hardness: str(String(input.observation?.hardness ?? ''), 10),
        luster: ['metal', 'nonmetal'].includes(input.observation?.luster) ? input.observation.luster : '' },
      confirmedKey: validKey(input.confirmedKey || '') ? input.confirmedKey : '',
      confirmationMethod: str(input.confirmationMethod, 100),
      photos: Array.isArray(input.photos) ? input.photos.slice(0, 3).filter(x => typeof x === 'string' && x.length < 250000 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(x)) : [],
      policy: str(input.policy, 100) || POLICY.version, source: 'local' };
  }
  function parseImport(text) {
    if (text.length > 10 * 1024 * 1024) throw new Error('导入文件超过 10 MB');
    const data = JSON.parse(text);
    if (data?.schema !== 'shikuang-records' || data.version !== 2 || !Array.isArray(data.records) || data.records.length > 100) throw new Error('请选择识矿 2.0 导出的标本文件（最多 100 条）');
    const records = data.records.map(sanitizeRecord);
    if (new Set(records.map(r => r.id)).size !== records.length) throw new Error('导入文件包含重复记录编号');
    return records;
  }
  return { POLICY, NON_MINERAL, screen, softmax, probabilities, average, argmax, hardnessRange, evidenceFor, summarize, quality, qualityWarnings, sanitizeRecord, parseImport };
});
