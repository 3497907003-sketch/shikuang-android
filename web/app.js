(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const state = { photos: [], active: 0, scene: 'daily', result: null, busy: false, controller: null,
    recordId: null, records: [], selectedRecord: null, pendingDelete: null, view: 'identify', mode:'offline', mediaBusy:false, mediaController:null, offlineController:null, assistController:null, saving:false, draftDirty:false, revision:0 };
  let cameraStream,videoStream,recorder,recordTimer,discardRecording=false,mediaEpoch=0;
  function stopCamera(){cameraStream?.getTracks().forEach(t=>t.stop());cameraStream=null;$('#cameraPreview').srcObject=null;}
  function stopRecording(discard=false){discardRecording=discard;if(recorder?.state==='recording')recorder.stop();clearTimeout(recordTimer);videoStream?.getTracks().forEach(t=>t.stop());videoStream=null;$('#videoPreview').srcObject=null;$('#videoPreview').hidden=true;}
  function lockMedia(busy){state.mediaBusy=busy;for(const id of ['cameraBtn','videoBtn','galleryBtn','removePhoto','cropRange','newSample'])$('#'+id).disabled=busy||state.busy;$('#predictBtn').disabled=busy||state.busy||!state.photos.length;$('#cancelInput').hidden=!busy||!state.mediaController;document.querySelectorAll('[data-photo],[data-add-photo]').forEach(b=>{b.disabled=busy||state.busy;});}
  function cancelInput(){mediaEpoch++;state.mediaController?.abort();}
  function dismissCover(){$('#launchCover').hidden=true;}
  setTimeout(dismissCover,2000);$('#enterApp').addEventListener('click',dismissCover);
  const nativePlugins = new Map();
  const isNative = () => !!window.Capacitor?.isNativePlatform?.();
  function plugin(name) {
    if (!isNative()) return null;
    if (!nativePlugins.has(name)) nativePlugins.set(name, window.Capacitor.registerPlugin?.(name) || window.Capacitor.Plugins?.[name]);
    return nativePlugins.get(name);
  }
  const html = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const pct = v => `${Math.round(Math.min(1, Math.max(0, Number(v) || 0)) * 100)}%`;
  const kb = key => window.MINERAL_KB[key] || {};
  const name = key => kb(key).name_zh || window.MINERAL_CLASSES[key]?.zh || key;
  const date = time => new Date(time).toLocaleString('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
  const types = { amber:'有机宝石', lapis_lazuli:'岩石标本', limonite:'矿物集合体', hornblende:'矿物族', tourmaline:'矿物族', agate:'石英变种', jasper:'石英集合体', flint:'石英集合体', amethyst:'石英变种', carnelian:'玉髓变种', chalcedony:'石英集合体', chrysoprase:'玉髓变种', amazonite:'微斜长石变种', nephritis:'矿物集合体' };
  function icons() { window.lucide?.createIcons(); }
  let toastTimer;
  function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4500); }
  function status(message, error = false) { $('#progress').textContent = message; $('#progress').classList.toggle('error', error); }
  function openDialog(id) { $(id).showModal(); document.body.classList.add('dialog-open'); }
  function closeDialog(id) { $(id).close(); if (!document.querySelector('dialog[open]')) document.body.classList.remove('dialog-open'); }
  let guidePage = 0;
  const guidePages = [...document.querySelectorAll('[data-guide-title]')];
  function renderGuide(focus = false) {
    guidePages.forEach((page, i) => { page.hidden = i !== guidePage; });
    $('#guideTitle').textContent = guidePages[guidePage].dataset.guideTitle;
    $('#guideCounter').textContent = `第 ${guidePage + 1} / ${guidePages.length} 步`;
    $('#guideDots').innerHTML = guidePages.map((_, i) => `<span class="${i === guidePage ? 'active' : ''}"></span>`).join('');
    $('#guidePrev').disabled = guidePage === 0;
    $('#guideNext').textContent = guidePage === guidePages.length - 1 ? '开始识别' : '下一步 →';
    $('#guideDialog').scrollTop = 0;
    if (focus) $('#guideTitle').focus({ preventScroll:true });
  }
  function showGuide() { guidePage = 0; renderGuide(); openDialog('#guideDialog'); $('#guideTitle').focus({ preventScroll:true }); }
  $('#quickGuide').addEventListener('click', showGuide);
  $('#settingsGuide').addEventListener('click', showGuide);
  $('#closeGuide').addEventListener('click', () => closeDialog('#guideDialog'));
  $('#guidePrev').addEventListener('click', () => { if (guidePage > 0) { guidePage--; renderGuide(true); } });
  $('#guideNext').addEventListener('click', () => {
    if (guidePage < guidePages.length - 1) { guidePage++; renderGuide(true); return; }
    try { localStorage.setItem('shikuang-guide-complete-v2', '1'); } catch (_) {}
    closeDialog('#guideDialog'); $('#guideWelcome').hidden = true; location.hash = 'identify'; route();
    (state.photos.length ? $('#predictBtn') : $('#cameraBtn')).focus({ preventScroll:true });
  });
  function draftChanged(){state.draftDirty=true;state.revision++;}
  function invalidate() {
    if (state.result) status('照片或物性已改变，请重新分析。');
    state.result = null; $('#result').hidden = true; $('#analysisRecovery').hidden=true;state.assistController?.abort(); $('#assistText').textContent='';
    draftChanged();
  }
  function route() {
    const requested = location.hash.slice(1), view = ['identify','library','records','settings'].includes(requested) ? requested : 'identify';
    if(view!==state.view && view!=='identify'){cancelInput();stopCamera();if($('#cameraDialog').open)closeDialog('#cameraDialog');}
    state.view = view;
    document.querySelectorAll('.view').forEach(el => { el.hidden = el.id !== `view-${view}`; });
    document.querySelectorAll('[data-view]').forEach(el => { el.classList.toggle('active', el.dataset.view === view); if (el.dataset.view === view) el.setAttribute('aria-current','page'); else el.removeAttribute('aria-current'); });
    if (view === 'library') renderLibrary();
    if (view === 'records') void renderRecords().catch(e => toast(e.message));
    window.scrollTo({ top:0, behavior:'instant' });
    requestAnimationFrame(updateCrop);
  }
  function updateCrop() {
    const p = state.photos[state.active], img = $('#preview'), frame = $('#cropFrame'), stage = $('#stage');
    if (!p || !img.naturalWidth) return;
    const scale = Math.min(stage.clientWidth / img.naturalWidth, stage.clientHeight / img.naturalHeight);
    const side = Math.min(img.naturalWidth, img.naturalHeight) * scale * p.crop;
    Object.assign(frame.style, { left:`${(stage.clientWidth-side)/2}px`, top:`${(stage.clientHeight-side)/2}px`, width:`${side}px`, height:`${side}px`, right:'auto', bottom:'auto' });
  }
  function renderPhotos() {
    const hasPhotos = state.photos.length > 0, p = state.photos[state.active];
    $('#captureEmpty').hidden = hasPhotos; $('#preview').hidden = !hasPhotos; $('#cropFrame').hidden = !hasPhotos;
    $('#removePhoto').hidden = !hasPhotos; $('#photoStrip').hidden = !hasPhotos; $('#cropControl').hidden = !hasPhotos;
    $('#predictBtn').disabled = !hasPhotos || state.busy || state.mediaBusy;
    if (p) { $('#preview').src = p.src; $('#cropRange').value = p.crop * 100; $('#cropValue').textContent = `${Math.round(p.crop * 100)}%`; }
    else $('#preview').removeAttribute('src');
    $('#stageLabel').textContent = hasPhotos ? `角度 ${state.active+1} · 中心区域分析` : '照片留在本机';
    if(p?.kind==='video')$('#stageLabel').textContent=`视频帧 ${(p.time||0).toFixed(1)} 秒 · 中心区域分析`;
    $('#inputSummary').hidden=!hasPhotos;$('#inputSummary').textContent=hasPhotos?`已提交 ${state.photos.length} 张图像${state.photos.some(p=>p.kind==='video')?'（含视频帧）':''}，可开始分析。`:'';
    $('#photoStrip').innerHTML = state.photos.map((photo,i) => `<button type="button" class="photo-thumbnail ${i === state.active?'active':''}" data-photo="${i}" aria-label="查看角度 ${i+1}" aria-pressed="${i===state.active}"><img src="${html(photo.src)}" alt="角度 ${i+1}"><span>${i+1}</span></button>`).join('') + (state.photos.length < 3 ? '<button type="button" class="photo-add" data-add-photo aria-label="添加同一标本的另一个角度"><i data-lucide="plus"></i></button>':'') + `<span class="angle-count">${state.photos.length}/3 个角度</span>`;
    icons(); updateCrop();lockMedia(state.mediaBusy);
  }
  async function addPhoto(src,metadata={},signal) {
    if (state.busy || state.photos.length >= 3) { toast('每个标本最多 3 个角度，开始新标本可继续拍摄'); return; }
    const img = await MineralEngine.image(src);
    if(signal?.aborted)throw new DOMException('输入已停止','AbortError');
    if(state.busy||state.photos.length>=3)return;
    if (img.naturalWidth * img.naturalHeight > 40000000) throw new Error('照片分辨率过大，请选择低于 4000 万像素的图片');
    const scale = Math.min(1, 1536 / Math.max(img.naturalWidth,img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale); canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);
    const normalized = canvas.toDataURL('image/jpeg',0.9);
    if (state.photos.some(p=>p.src === normalized)) { toast('这张照片已添加，请补充同一标本的不同角度'); return; }
    invalidate(); state.photos.push({ src:normalized, crop:1,...metadata });
    state.active = state.photos.length-1; renderPhotos(); status('照片已就绪，可添加其他角度或开始分析。');
  }
  function cancelled(error) { return /cancel|取消|canceled/i.test(error?.message || ''); }
  async function capture(source) {
    if (state.busy || state.mediaBusy) return;
    if (state.photos.length >= 3) { toast('已添加 3 个角度，请先分析或移除一张照片'); return; }
    if (isNative()) {
      lockMedia(true);
      try {
        const photo = await plugin('Camera').getPhoto({ quality:90, width:1536, height:1536,
          resultType:'uri', source:source === 'camera' ? 'CAMERA':'PHOTOS', correctOrientation:true,
          allowEditing:false, saveToGallery:false });
        if (photo.webPath) await addPhoto(photo.webPath);
        else throw new Error('相机未返回可读取的照片，请重试');
      } catch (e) { if (!cancelled(e)) toast(`无法读取照片：${e.message || '请检查相机权限'}`); } finally {lockMedia(false);}
    } else if(source==='camera'){
      const epoch=++mediaEpoch;lockMedia(true);try{if(!navigator.mediaDevices?.getUserMedia)throw new Error('此环境无法打开相机，请使用安装版或 HTTPS');cameraStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});if(epoch!==mediaEpoch||state.view!=='identify'){stopCamera();return;}$('#cameraPreview').srcObject=cameraStream;openDialog('#cameraDialog');}
      catch(e){stopCamera();toast(`无法打开相机：${e.name==='NotAllowedError'?'请允许相机访问':e.message}`);}finally{lockMedia(false);}
    }else $('#fileInput').click();
  }
  async function readFiles(input) {
    if(state.busy||state.mediaBusy){input.value='';return;}lockMedia(true);
    try {
      for (const file of Array.from(input.files || [])) {
        if (state.photos.length >= 3) { toast('最多添加 3 张同一标本的照片'); break; }
        if (file.size > 20*1024*1024) throw new Error('单张照片超过 20 MB，请降低分辨率后重试');
        if (!/^(image\/(jpeg|png|webp|heic|heif|avif))$/.test(file.type) && !/\.(jpe?g|png|webp|heic|heif|avif)$/i.test(file.name)) throw new Error('请选择可读取的照片文件');
        const url = URL.createObjectURL(file);
        try { await addPhoto(url); } finally { URL.revokeObjectURL(url); }
      }
    } catch (e) { toast(e.message || '照片无法读取，请选择 JPEG 或 PNG 格式'); }
    finally { input.value = '';lockMedia(false); }
  }
  async function readVideo(input){
    const file=input.files?.[0];if(!file)return;
    if(state.busy||state.mediaBusy){input.value='';return;}
    if(state.photos.length>=3){toast('已添加 3 张图像，请先移除或开始新标本');input.value='';return;}
    if($('#videoDialog').open)closeDialog('#videoDialog');const epoch=++mediaEpoch,controller=new AbortController();state.mediaController=controller;lockMedia(true);
    try{const result=await MineralMedia.extractVideo(file,message=>{if(epoch===mediaEpoch)status(message);},{signal:controller.signal});
      for(const frame of result.frames.slice(0,3-state.photos.length)){if(epoch!==mediaEpoch||controller.signal.aborted)throw new DOMException('输入已停止','AbortError');await addPhoto(frame.src,{kind:'video',time:frame.time},controller.signal);}
      if(epoch!==mediaEpoch||controller.signal.aborted)throw new DOMException('输入已停止','AbortError');
      status(`视频已取帧（${result.duration.toFixed(1)} 秒），${state.photos.length} 张图像可分析。`);
    }catch(e){if(e.name==='AbortError')status('视频取帧已停止，已提交的照片保留。');else{status(e.message,true);toast(e.message);}}finally{input.value='';if(state.mediaController===controller){state.mediaController=null;lockMedia(false);}}
  }
  async function recordVideo(){
    if(isNative()){$('#videoInput').click();return;}
    const epoch=++mediaEpoch;$('#recordVideo').disabled=true;$('#chooseVideo').disabled=true;
    try{if(!window.MediaRecorder||!navigator.mediaDevices?.getUserMedia)throw new Error('当前环境无法录制，请选择视频文件');
      videoStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});
      if(epoch!==mediaEpoch||!$('#videoDialog').open){stopRecording(true);return;}
      $('#videoPreview').hidden=false;$('#videoPreview').srcObject=videoStream;
      const chunks=[];discardRecording=false;recorder=new MediaRecorder(videoStream);
      recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
      recorder.onstop=()=>{const cancelled=discardRecording;stopRecording(cancelled);$('#stopVideo').hidden=true;$('#recordVideo').disabled=false;$('#chooseVideo').disabled=false;if(cancelled||!chunks.length)return;
        const file=new File(chunks,'specimen-video.webm',{type:chunks[0].type||'video/webm'});void readVideo({files:[file],value:''});};
      recorder.start();$('#stopVideo').hidden=false;$('#recordVideo').disabled=true;$('#chooseVideo').disabled=true;$('#videoStatus').textContent='正在录制，同一标本缓慢变化视角；20 秒后自动结束。';
      recordTimer=setTimeout(()=>stopRecording(),20000);
    }catch(e){stopRecording(true);$('#recordVideo').disabled=false;$('#chooseVideo').disabled=false;toast(`无法录制：${e.name==='NotAllowedError'?'请允许相机访问':e.message}`);}
  }
  function observation() { return { hardness:$('#hardness').value, luster:$('#luster').value }; }
  function setBusy(busy) {
    state.busy = busy; $('#stage').classList.toggle('analyzing',busy); $('#cancelBtn').hidden = !busy;
    $('#predictLabel').textContent = busy ? '正在分析标本…':'分析矿物候选';
    for (const id of ['cameraBtn','videoBtn','galleryBtn','removePhoto','cropRange','hardness','luster','precision','newSample','saveBtn','retryAnalysis']) $('#'+id).disabled = busy;
    if(state.saving)$('#saveBtn').disabled=true;
    document.querySelectorAll('[data-scene]').forEach(b => { b.disabled = busy; });
    $('#predictBtn').disabled = busy || state.mediaBusy || !state.photos.length;
    lockMedia(state.mediaBusy);
  }
  async function predict() {
    if (state.busy || state.mediaBusy || !state.photos.length) return;
    const h = $('#hardness').value;
    if (h && (!Number.isFinite(Number(h)) || Number(h)<1 || Number(h)>10)) { toast('实测硬度需在 1–10 之间，未测量请留空'); $('#hardness').focus(); return; }
    invalidate(); setBusy(true); state.controller = new AbortController();
    try {
      const result = await MineralEngine.analyze(state.photos, { signal:state.controller.signal, report:status,
        observation:observation(), precision:$('#precision').checked });
      state.result = result; renderResult(result); status('分析完成，请比较候选并复核实测物性。');
      $('#result').scrollIntoView({ behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth', block:'start' });
    } catch (e) { if (e.name === 'AbortError') status('分析已停止，照片已保留。'); else {status(e.message || '分析失败，请重新拍摄或准备离线资源。',true);$('#analysisRecovery').hidden=false;} }
    finally { state.controller = null; setBusy(false); }
  }
  function checkMarkup(check) { return `<p class="physical-check ${check.status==='conflict'?'conflict':''}">${check.status==='conflict'?'存在冲突':'物性符合'} · ${html(check.property)}：实测 ${html(check.observed)}，资料 ${html(check.expected)}</p>`; }
  function renderResult(r) {
    const k = kb(r.key); $('#result').hidden = false;
    $('#resultHeading').textContent = name(r.key); $('#resultEnglish').textContent = k.name_en || r.key;
    $('#resultFormula').textContent = k.formula || ''; $('#resultScore').textContent = pct(r.score);
    $('#scoreFill').style.width = '0%'; requestAnimationFrame(() => { $('#scoreFill').style.width = pct(r.score); });
    $('#resultStatus').textContent = r.status === 'consistent' ? '线索较一致 · 待复核':'需要更多证据';
    $('#resultStatus').className = `result-state ${r.status==='consistent'?'consistent':''}`;
    $('#verdict').textContent = r.reasons.length ? r.reasons.join('；') + '。建议补拍晶体细节，并对照候选物性。' : '各模型和拍摄角度的线索较一致。请对照物性后记录结论；未覆盖的类别仍可能被分到相似候选。';
    $('#evidenceSummary').innerHTML = `<span>${r.photoCount} 张图像${state.photos.some(p=>p.kind==='video')?'（含视频帧）':''}</span><span>${r.modelCount} 个模型</span><span>模型一致度 ${pct(r.agreement)}</span>`;
    $('#candidates').innerHTML = r.rankings.map((x,i) => { const item = kb(x.key); return `<div class="candidate-row"><button type="button" data-detail="${html(x.key)}" aria-label="查看${html(name(x.key))}资料"><strong>${i+1}. ${html(name(x.key))}</strong><span class="candidate-score">${pct(x.score)}</span></button><div class="candidate-meta"><span>硬度 ${html(item.hardness ?? '未收录')}</span><span>光泽 ${html(item.luster || '未收录')}</span></div>${(x.checks || []).filter(c => c.status==='conflict').map(checkMarkup).join('')}</div>`; }).join('');
    $('#physicalChecks').innerHTML = (r.checks || []).filter(c => c.status==='match').map(checkMarkup).join('');
    $('#saveBtn').innerHTML = state.recordId?'<i data-lucide="bookmark-check"></i>更新标本':'<i data-lucide="bookmark-plus"></i>保存标本'; icons();
  }
  function resetSample() {
    if (state.busy || state.mediaBusy) return;
    if(state.photos.length&&state.draftDirty&&!confirm('当前标本尚有未保存内容。开始新标本将清空当前照片和观察，已保存记录保留。继续吗？'))return;
    state.photos = []; state.active = 0; invalidate();state.recordId=null;state.draftDirty=false;
    $('#notes').value = ''; $('#sampleId').value = ''; $('#hardness').value = ''; $('#luster').value = '';
    renderPhotos(); status('拍摄或选择一张照片即可开始。'); window.scrollTo({top:0,behavior:'instant'});
  }
  async function thumbnail(src) {
    const img = await MineralEngine.image(src), canvas = document.createElement('canvas'), scale = 256/Math.max(img.naturalWidth,img.naturalHeight);
    canvas.width = Math.round(img.naturalWidth*scale); canvas.height = Math.round(img.naturalHeight*scale);
    canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height); return canvas.toDataURL('image/jpeg',0.7);
  }
  async function save() {
    if (!state.result || state.busy || state.saving) return;
    state.saving=true;
    const snapshot={result:state.result,recordId:state.recordId,revision:state.revision,photos:state.photos.map(p=>({...p})),scene:state.scene,notes:$('#notes').value.trim(),sampleId:$('#sampleId').value.trim(),observation:observation()};
    $('#saveBtn').disabled = true;
    try {
      const r = snapshot.result, id = snapshot.recordId || (crypto.randomUUID?.() || `specimen-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const old = snapshot.recordId ? (await SpecimenStore.list()).find(x => x.id === snapshot.recordId) : null;
      const photos = await Promise.all(snapshot.photos.map(p => thumbnail(p.src)));
      await SpecimenStore.put({ ...r, id, time:old?.time || Date.now(), name:name(r.key), photos, scene:snapshot.scene,
        notes:snapshot.notes, sampleId:snapshot.sampleId, observation:snapshot.observation,
        confirmedKey:old?.confirmedKey || '', confirmationMethod:old?.confirmationMethod || '' });
      if(state.result===r){state.recordId = id;if(state.revision===snapshot.revision)state.draftDirty=false; $('#saveBtn').innerHTML = '<i data-lucide="bookmark-check"></i>更新标本';icons();} toast('标本已保存在这台设备');
    } catch (e) { toast(e.message); } finally { state.saving=false;$('#saveBtn').disabled = state.busy; }
  }
  function properties(k) {
    const values = [['化学式',k.formula],['摩氏硬度',k.hardness],['晶系',k.crystal_system],['光泽',k.luster],['条痕',k.streak],['颜色',k.color],['晶体习性',k.habit],['分类',k.classification?.class_9]];
    return `<dl class="detail-properties">${values.filter(([,v]) => v!==undefined && v!=='').map(([label,value]) => `<div><dt>${label}</dt><dd>${html(value)}</dd></div>`).join('')}</dl>`;
  }
  function showDetail(key) {
    const k = kb(key); if (!Object.keys(k).length) { toast('该候选暂未收录资料'); return; }
    $('#detailTitle').textContent = name(key);
    $('#detailType').textContent = `${types[key] || '矿物资料'} · ${window.MINERAL_CLASSES[key]?'图像模型支持':'仅供资料查阅'}`;
    $('#detailBody').innerHTML = `<p class="field-hint">${html(k.name_en || key)}${k.summary?' · '+html(k.summary):''}</p>${properties(k)}${k.formation?`<section class="detail-section"><h3>形成与产出</h3><p>${html(k.formation)}</p></section>`:''}${k.typical_localities?.length?`<section class="detail-section"><h3>典型产地</h3><p>${html(k.typical_localities.join('、'))}</p></section>`:''}${k.industrial_uses?.length?`<section class="detail-section"><h3>用途</h3><ul>${k.industrial_uses.map(x=>`<li>${html(x)}</li>`).join('')}</ul></section>`:''}<section class="detail-section"><h3>资料来源</h3><p class="field-hint">${html((k.source_refs || []).join('；') || '项目原有矿物知识库')}。沿用项目已有资料，尚未逐条核验；未收录的物性不参与复核。</p></section>`;
    openDialog('#detailDialog'); icons();
  }
  function renderLibrary() {
    const query = $('#librarySearch').value.trim().toLowerCase(), filter = $('#classFilter').value,scheme=$('#classScheme').value;
    const items = Object.entries(MINERAL_KB).filter(([key,k]) => [name(key), k.name_en, k.formula, key].some(x => String(x||'').toLowerCase().includes(query)) && (!filter || category(k,scheme) === filter));
    $('#libraryCount').textContent = `${items.length} 项资料`;
    $('#libraryList').innerHTML = items.length ? items.map(([key,k]) => `<button type="button" class="mineral-card" data-detail="${html(key)}"><span class="mineral-symbol" aria-hidden="true">${html((k.formula || '◇').slice(0,4))}</span><strong>${html(name(key))}</strong><small>${html(k.name_en || key)}</small><span class="card-formula formula">${html(k.formula || '化学式未收录')}</span><span class="category">${html(types[key] || category(k,scheme))} · ${MINERAL_CLASSES[key]?'模型候选':'资料'}</span></button>`).join('') : '<div class="empty-state"><h2>没有匹配的资料</h2><p>试试矿物名称、英文名或化学式。</p></div>';
  }
  const schemes={strunz_10:['自然元素','硫化物','卤化物','氧化物','硝酸盐/碳酸盐','硼酸盐','硫酸盐','磷酸盐','硅酸盐','有机化合物'],class_9:['自然元素','硫化物/硫盐','卤化物','氧化物/氢氧化物','硝酸盐','碳酸盐','钼酸盐/钨酸盐','磷酸盐/砷酸盐/钒酸盐','硅酸盐'],class_8:['自然元素','硫化物','卤化物','氧化物及氢氧化物','碳酸盐/硝酸盐/硼酸盐','硫酸盐','磷酸盐','硅酸盐']};
  function category(k,scheme){let value=k.classification?.[scheme]||'';if(scheme==='strunz_10'&&['碳酸盐','硝酸盐'].includes(value))value='硝酸盐/碳酸盐';if(scheme==='strunz_10'&&value.startsWith('氧化物'))value='氧化物';if(scheme==='class_8'&&value.startsWith('氧化物'))value='氧化物及氢氧化物';return schemes[scheme]?.includes(value)?value:'体系外 / 待核对';}
  function updateClassFilter(){const scheme=$('#classScheme').value;$('#classFilter').innerHTML='<option value="">全部类别</option>'+[...schemes[scheme],'体系外 / 待核对'].map(c=>{const count=Object.values(MINERAL_KB).filter(k=>category(k,scheme)===c).length;return `<option value="${html(c)}">${html(c)} · ${count}</option>`;}).join('');renderLibrary();}
  function renderSearchHistory(){const rows=SearchHistory.read();for(const kind of ['library','records']){const entries=rows.map((x,i)=>({...x,index:i})).filter(x=>x.kind===kind);$(kind==='library'?'#searchHistory':'#recordSearchHistory').innerHTML=entries.length?'<div class="history-heading"><span>历史搜索 · 本机</span><button type="button" data-clear-history>清空全部历史</button></div><div class="history-chips">'+entries.map(x=>`<button type="button" data-history="${x.index}">${html(x.query)}</button>`).join('')+'</div>':'';}}
  function saveSearch(kind){SearchHistory.save($(kind==='library'?'#librarySearch':'#recordSearch').value,kind);renderSearchHistory();}
  function setMode(mode){state.mode=mode==='online'?'online':'offline';document.querySelectorAll('[data-mode]').forEach(b=>{b.classList.toggle('selected',b.dataset.mode===state.mode);b.setAttribute('aria-pressed',String(b.dataset.mode===state.mode));});$('#connectionLabel').textContent=state.mode==='offline'?'本机识别':navigator.onLine?'联网 · 本机识别':'无网络 · 本机识别';$('#assistCurrent').hidden=state.mode!=='online';try{localStorage.setItem('shikuang-mode-v2',state.mode);}catch(_){} }
  async function renderRecords() {
    state.records = await SpecimenStore.list();
    const query = $('#recordSearch').value.trim().toLowerCase();
    const records = state.records.filter(r => [r.sampleId,r.notes,name(r.key),r.confirmedKey?name(r.confirmedKey):''].some(x=>String(x||'').toLowerCase().includes(query)));
    $('#recordCount').textContent = `${state.records.length}/100 条`; $('#exportBtn').disabled = !state.records.length;
    $('#recordList').innerHTML = records.length ? records.map(r => `<button type="button" class="record-card" data-record="${html(r.id)}">${r.photos[0]?`<img src="${html(r.photos[0])}" alt="保存的标本照片">`:'<span class="record-no-image"><i data-lucide="gem"></i></span>'}<div class="record-text"><strong>${html(r.confirmedKey?name(r.confirmedKey):name(r.key))}</strong><p>${html(r.sampleId || '未设置标本编号')} · ${r.confirmedKey?'已人工确认':'候选待复核'}</p><small>${html(date(r.time))} · 模型分数 ${pct(r.score)}</small></div><i data-lucide="chevron-right"></i></button>`).join('') : `<div class="empty-state"><i data-lucide="notebook-tabs"></i><h2>${query?'没有匹配的标本':'记录你的第一块标本'}</h2><p>${query?'试试标本编号、矿物名称或备注。':'拍摄、分析并保存。不同的标本会分别保留，便于回看与复核。'}</p>${query?'':'<a href="#identify" class="secondary">开始识别</a>'}</div>`;
    icons();
  }
  function showRecord(id) {
    const r = state.records.find(x => x.id === id); if (!r) return;
    state.selectedRecord = r; $('#recordTitle').textContent = r.sampleId || name(r.key);
    $('#recordBody').innerHTML = `<p class="field-hint">${html(date(r.time))} · ${r.scene==='lab'?'实验室':'日常'}记录</p><div class="record-photos">${r.photos.map(src=>`<img src="${html(src)}" alt="标本角度照片">`).join('')}</div><h3>原始模型候选：${html(name(r.key))} · ${pct(r.score)}</h3><p class="field-hint">${html(r.reasons.join('；') || '线索较一致，仍需复核')}</p><p class="assist-text">${html(r.notes || '未填写备注')}</p><div class="record-form"><label for="recordSampleId">标本编号</label><input id="recordSampleId" maxlength="100" value="${html(r.sampleId)}"><label for="confirmedKey">已确认的名称</label><select id="confirmedKey"><option value="">尚未确认</option>${Object.keys(MINERAL_KB).map(key=>`<option value="${html(key)}" ${r.confirmedKey===key?'selected':''}>${html(name(key))}</option>`).join('')}</select><label for="confirmationMethod">确认方法 / 检测报告编号</label><input id="confirmationMethod" maxlength="100" value="${html(r.confirmationMethod)}" placeholder="例如：XRD 检测，报告编号…"><p class="field-hint">人工确认单独保存，原始候选保留，便于评估模型。仅选择已知结论。</p><div class="result-actions"><button type="button" id="updateRecord" class="secondary">保存复核信息</button><button type="button" id="deleteRecord" class="danger-button">删除记录</button></div></div>`;
    openDialog('#recordDialog'); icons();
  }
  async function updateRecord() {
    const key = $('#confirmedKey').value, method = $('#confirmationMethod').value.trim();
    if (key && !method) { toast('请填写确认方法或报告编号，让结论可追溯'); return; }
    try {
      await SpecimenStore.put({ ...state.selectedRecord, sampleId:$('#recordSampleId').value.trim(), confirmedKey:key, confirmationMethod:key?method:'' });
      closeDialog('#recordDialog'); await renderRecords(); toast('复核信息已保存，原始候选已保留');
    } catch (e) { toast(e.message); }
  }
  async function exportRecords() {
    try {
      const records = await SpecimenStore.list(); if (!records.length) { toast('暂无可导出的标本'); return; }
      const text = JSON.stringify({ schema:'shikuang-records', version:2, exportedAt:new Date().toISOString(), records },null,2);
      MineralCore.checkBackupSize(text);
      const fileName = `shikuang-specimens-${new Date().toISOString().slice(0,10)}.json`;
      if (isNative()) {
        const result = await plugin('Filesystem').writeFile({ path:`exports/${fileName}`, data:text, directory:'CACHE', encoding:'utf8', recursive:true });
        await plugin('Share').share({ title:'识矿标本备份', url:result.uri, dialogTitle:'保存或分享标本备份' });
      } else {
        const url = URL.createObjectURL(new Blob([text], {type:'application/json'})), a = document.createElement('a');
        a.href = url; a.download = fileName; a.click(); setTimeout(()=>URL.revokeObjectURL(url),5000);
      }
    } catch (e) { if (!cancelled(e)) toast(`导出失败：${e.message}`); }
  }
  async function importRecords(input) {
    try {
      const file = input.files?.[0]; if (!file) return;
      MineralCore.checkBackupSize(file.size);
      const records = MineralCore.parseImport(await file.text());
      if (records.some(r=>!MINERAL_KB[r.key] || (r.confirmedKey && !MINERAL_KB[r.confirmedKey]))) throw new Error('文件包含未收录的候选或确认名称');
      const added = await SpecimenStore.merge(records); await renderRecords(); toast(`已导入 ${added} 条新记录，原记录保留`);
    } catch (e) { toast(e.message || '导入失败，请使用识矿导出的 JSON 文件'); }
    finally { input.value=''; }
  }
  async function prepareOffline() {
    if (isNative()) { toast('Android 安装包内置全部识别资源，可直接离线分析'); return; }
    if (!('caches' in window) || !('serviceWorker' in navigator)) { toast('当前浏览器不支持离线资源，请使用 Android 安装版'); return; }
    if(state.offlineController)return;
    const controller=new AbortController();state.offlineController=controller;
    $('#offlineBtn').disabled=true;$('#cancelOffline').hidden=false;
    const assets = ['./','./index.html','./styles.css','./app.js','./core.js','./inference.js','./engine-worker.js','./history.js','./media.js','./storage.js','./config.js','./manifest.webmanifest','./model-manifest.json','./icon.svg','./icon-192.png','./icon-512.png','./icon-maskable.png','./version.json','./data/classes.js','./data/minerals.js','./data/sources.js','./data/imagenet.js','./vendor/lucide.min.js','./vendor/ort.min.js','./vendor/ort-wasm-simd-threaded.mjs','./vendor/ort-wasm-simd-threaded.wasm', ...MineralEngine.models.map(m=>'./models/'+m.file),'./models/imagenet_gate.onnx'];
    try {
      await bounded(()=>navigator.serviceWorker.register('./sw.js'),15000,'离线服务启动超时',controller.signal);
      const manifest=await bounded(async signal=>{const response=await fetch('./model-manifest.json',{signal,cache:'reload'});if(!response.ok)throw new Error(`模型目录下载失败 (${response.status})`);return response.json();},30000,'模型目录读取超时',controller.signal);
      if(!Array.isArray(manifest.models))throw new Error('模型目录不完整，请重试');
      for (let i=0;i<assets.length;i++) {
        if(controller.signal.aborted)throw new DOMException('准备已停止','AbortError');
        $('#offlineProgress').textContent=`正在准备资源 ${i+1}/${assets.length}（模型共约 70 MB）…`;
        const cache = await caches.open(assets[i].includes('/models/') || assets[i].endsWith('.wasm') ? 'shikuang-models-v2-20261010':'shikuang-static-2.0.1-preview.1');
        const request = new Request(new URL(assets[i],location.href),{cache:'reload'}),model=manifest.models.find(m=>'./'+m.path===assets[i]);
        await bounded(async signal=>{
          const cached=model?await cache.match(request):null;
          if(cached&&await verifyModel(cached,model))return;
          if(cached)await cache.delete(request);
          const response=await fetch(request,{signal});if(!response.ok)throw new Error(`资源下载失败 (${response.status})`);
          if(model&&!await verifyModel(response,model))throw new Error('模型资源校验失败，请检查网络后重试');
          if(signal.aborted)throw new DOMException('准备已停止','AbortError');
          await cache.put(request,response);
        },90000,'该资源准备超过 90 秒，请检查网络后重试',controller.signal);
      }
      $('#offlineProgress').textContent='离线资源已准备。浏览器可能因空间不足回收缓存，重要现场任务建议使用 Android 安装版。';
      toast('离线资源已准备');
    } catch (e) { $('#offlineProgress').textContent=e.name==='AbortError'?'准备已停止。已完成的资源保留，可再次点击继续准备。':`准备未完成：${e.message}。请检查网络和存储空间后重试。`; }
    finally { if(state.offlineController===controller)state.offlineController=null;$('#offlineBtn').disabled=false;$('#cancelOffline').hidden=true; }
  }
  async function verifyModel(response,model){if(!crypto.subtle||!/^[a-f0-9]{64}$/i.test(model.sha256||''))throw new Error('当前环境无法校验模型，请使用支持 HTTPS 的浏览器或安装版');const bytes=await response.clone().arrayBuffer(),digest=await crypto.subtle.digest('SHA-256',bytes);return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('')===model.sha256;}
  function bounded(action,timeout,message,signal){return new Promise((resolve,reject)=>{
    const controller=new AbortController();let settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);error?reject(error):resolve(value);};
    const cancel=()=>{controller.abort();finish(new DOMException('操作已停止','AbortError'));};
    const timer=setTimeout(()=>{controller.abort();finish(new Error(message));},timeout);
    if(signal?.aborted){cancel();return;}signal?.addEventListener('abort',cancel,{once:true});
    Promise.resolve().then(()=>action(controller.signal)).then(value=>finish(null,value),error=>finish(error));
  });}
  async function assist() {
    if(state.mode!=='online'){toast('请先切换到联网模式，识别结果会继续保留');return;}
    if (!state.result) { toast('先分析一个标本，再补充文字说明'); return; }
    if(!navigator.onLine){toast('当前没有网络，本机候选仍可查看和保存');return;}
    const key = $('#apiKey').value.trim(); if (!key) { $('#apiKey').focus(); toast('请填写你自己的 DeepSeek API 密钥'); return; }
    $('#assistBtn').disabled=true; $('#assistText').textContent='正在补充文字说明…';
    const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),45000), candidate=state.result.key,revision=state.revision;state.assistController=controller;
    try {
      const prompt=`请以矿物学资料辅助比较候选 ${name(candidate)} (${kb(candidate).name_en||candidate})。用户观察：${$('#notes').value.slice(0,1000)||'未填写'}。实测硬度：${$('#hardness').value||'未测量'}，光泽：${$('#luster').value||'未确定'}。请简短说明鉴别特征、相似矿物区别、典型形成环境与工业用途，指出仍缺少的证据。这是未经确认的图像分类候选，不生成置信度，不确定当前标本产地。`;
      const content=$('#assistImage').checked?[{type:'text',text:prompt},...state.photos.map(p=>({type:'image_url',image_url:{url:p.src}}))]:prompt;
      const res=await fetch('https://api.deepseek.com/chat/completions',{method:'POST',signal:controller.signal,
        headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify({model:window.DEEPSEEK_MODEL || 'deepseek-flash',messages:[{role:'user',content}],max_tokens:1000,temperature:0.2,thinking:{type:'disabled'}})});
      if (!res.ok) throw new Error(res.status===401?'密钥无效，请检查后重试':`服务请求失败 (${res.status})`);
      const body=await res.json(), text=body.choices?.[0]?.message?.content;
      if (typeof text!=='string' || !text.trim()) throw new Error('服务未返回文字说明');
      if(revision===state.revision)$('#assistText').textContent=`${name(candidate)} · AI 文字参考（请核对资料）\n\n${text.slice(0,8000)}`;
    } catch (e) { if(revision===state.revision)$('#assistText').textContent=e.name==='AbortError'?'请求超时，请稍后重试。':e.message; }
    finally { clearTimeout(timer);if(state.assistController===controller)state.assistController=null;$('#assistBtn').disabled=false; }
  }
  $('#cameraBtn').addEventListener('click',()=>void capture('camera'));
  $('#galleryBtn').addEventListener('click',()=>void capture('gallery'));
  $('#videoBtn').addEventListener('click',()=>{if(!state.busy&&!state.mediaBusy){$('#videoStatus').textContent='';openDialog('#videoDialog');}});
  $('#recordVideo').addEventListener('click',()=>void recordVideo());$('#chooseVideo').addEventListener('click',()=>$('#videoFileInput').click());$('#stopVideo').addEventListener('click',()=>stopRecording());
  [$('#videoInput'),$('#videoFileInput')].forEach(input=>input.addEventListener('change',()=>void readVideo(input)));
  $('#closeVideo').addEventListener('click',()=>{stopRecording(true);closeDialog('#videoDialog');});
  $('#closeCamera').addEventListener('click',()=>{stopCamera();closeDialog('#cameraDialog');});
  $('#takePhoto').addEventListener('click',async()=>{const video=$('#cameraPreview');if(!video.videoWidth)return;const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;canvas.getContext('2d').drawImage(video,0,0);const src=canvas.toDataURL('image/jpeg',.9);stopCamera();closeDialog('#cameraDialog');lockMedia(true);try{await addPhoto(src);}catch(e){toast(e.message);}finally{lockMedia(false);}});
  [$('#fileInput'),$('#cameraInput')].forEach(input=>input.addEventListener('change',()=>void readFiles(input)));
  $('#preview').addEventListener('load',updateCrop); addEventListener('resize',updateCrop);
  $('#removePhoto').addEventListener('click',()=>{ if(state.busy)return; state.photos.splice(state.active,1);state.active=Math.max(0,state.active-1);invalidate();renderPhotos(); });
  $('#cropRange').addEventListener('input',()=>{ if(state.busy)return; const p=state.photos[state.active];if(p){p.crop=Number($('#cropRange').value)/100;invalidate();$('#cropValue').textContent=`${$('#cropRange').value}%`;updateCrop();} });
  document.addEventListener('click',e=>{
    const photo=e.target.closest('[data-photo]'), detail=e.target.closest('[data-detail]'), record=e.target.closest('[data-record]');
    if(photo && !state.busy&&!state.mediaBusy){state.active=Number(photo.dataset.photo);renderPhotos();}
    if(e.target.closest('[data-add-photo]') && !state.busy)void capture('camera');
    if(detail)showDetail(detail.dataset.detail);
    if(record)showRecord(record.dataset.record);
    const history=e.target.closest('[data-history]');if(history){const item=SearchHistory.read()[Number(history.dataset.history)];if(item){$(item.kind==='library'?'#librarySearch':'#recordSearch').value=item.query;location.hash=item.kind;route();}}
    if(e.target.closest('[data-clear-history]')&&confirm('清空这台设备上图鉴与标本的全部搜索历史？')){SearchHistory.clear();renderSearchHistory();}
    if(e.target.closest('#updateRecord'))void updateRecord();
    if(e.target.closest('#deleteRecord')){state.pendingDelete=state.selectedRecord?.id;openDialog('#confirmDialog');}
  });
  document.querySelectorAll('[data-scene]').forEach(b=>b.addEventListener('click',()=>{
    if(state.busy)return;state.scene=b.dataset.scene;$('#labObservations').open=state.scene==='lab';$('#sampleIdField').hidden=state.scene!=='lab';
    document.querySelectorAll('[data-scene]').forEach(el=>{el.classList.toggle('selected',el===b);el.setAttribute('aria-pressed',String(el===b));});
    $('#captureTip').textContent=state.scene==='lab'?'建议记录标本编号，拍摄整体与晶体细节，再用实测物性复核。':'同一标本添加 2–3 个角度，查看判断是否一致。每次分析一个主体。';
  }));
  ['hardness','luster','precision'].forEach(id=>$('#'+id).addEventListener('change',invalidate));
  $('#predictBtn').addEventListener('click',()=>void predict()); $('#cancelBtn').addEventListener('click',()=>state.controller?.abort());
  $('#cancelInput').addEventListener('click',cancelInput);$('#cancelOffline').addEventListener('click',()=>state.offlineController?.abort());
  $('#retryAnalysis').addEventListener('click',()=>void predict());$('#analysisSettings').addEventListener('click',()=>{location.hash='settings';route();$('#offlineBtn').focus({preventScroll:true});});
  $('#assistCurrent').addEventListener('click',()=>{location.hash='settings';route();$('#assistSection').scrollIntoView({block:'start',behavior:'instant'});$('#apiKey').focus({preventScroll:true});});
  ['notes','sampleId'].forEach(id=>$('#'+id).addEventListener('input',()=>{draftChanged();state.assistController?.abort();$('#assistText').textContent='';}));
  $('#newSample').addEventListener('click',resetSample); $('#saveBtn').addEventListener('click',()=>void save());
  $('#detailBtn').addEventListener('click',()=>{if(state.result)showDetail(state.result.key);});
  ['librarySearch','classFilter'].forEach(id=>$('#'+id).addEventListener('input',renderLibrary));
  $('#classScheme').addEventListener('change',updateClassFilter);
  for(const kind of ['library','records']){const input=$(kind==='library'?'#librarySearch':'#recordSearch');input.addEventListener('keydown',e=>{if(e.key==='Enter')saveSearch(kind);});input.addEventListener('blur',()=>saveSearch(kind));}
  document.querySelectorAll('[data-mode]').forEach(b=>b.addEventListener('click',()=>setMode(b.dataset.mode)));addEventListener('online',()=>setMode(state.mode));addEventListener('offline',()=>setMode(state.mode));
  $('#recordSearch').addEventListener('input',()=>void renderRecords().catch(e=>toast(e.message)));
  $('#exportBtn').addEventListener('click',()=>void exportRecords()); $('#importBtn').addEventListener('click',()=>$('#importInput').click());
  $('#importInput').addEventListener('change',()=>void importRecords($('#importInput')));
  $('#closeDetail').addEventListener('click',()=>closeDialog('#detailDialog'));$('#closeRecord').addEventListener('click',()=>closeDialog('#recordDialog'));
  $('#cancelDelete').addEventListener('click',()=>{state.pendingDelete=null;closeDialog('#confirmDialog');});
  $('#confirmDelete').addEventListener('click',async()=>{const id=state.pendingDelete;if(!id)return;try{await SpecimenStore.remove(id);state.pendingDelete=null;if(state.recordId===id)state.recordId=null;closeDialog('#confirmDialog');closeDialog('#recordDialog');await renderRecords();toast('记录已删除');}catch(e){toast(e.message);}});
  document.querySelectorAll('dialog').forEach(d=>d.addEventListener('close',()=>{if(d.id==='cameraDialog')stopCamera();if(d.id==='videoDialog'){if(!state.mediaController)mediaEpoch++;stopRecording(true);$('#recordVideo').disabled=false;$('#chooseVideo').disabled=false;$('#stopVideo').hidden=true;}if(!document.querySelector('dialog[open]'))document.body.classList.remove('dialog-open');}));
  $('#offlineBtn').addEventListener('click',()=>void prepareOffline());$('#assistBtn').addEventListener('click',()=>void assist());
  addEventListener('hashchange',route);
  async function init() {
    icons();
    try { $('#guideWelcome').hidden = localStorage.getItem('shikuang-guide-complete-v2') === '1'; } catch (_) {}
    updateClassFilter();renderSearchHistory();
    try{setMode(localStorage.getItem('shikuang-mode-v2'));}catch(_){setMode('offline');}
    $('#sourceList').innerHTML=MINERAL_SOURCES.map(s=>`<a href="${html(s.url)}" target="_blank" rel="noopener noreferrer"><strong>${html(s.title)}</strong><span>${html(s.status)}</span><small>${html(s.use)}</small></a>`).join('');
    $('#coverageInfo').textContent=`当前图像模型有 ${Object.keys(MINERAL_CLASSES).length} 个原有标签，资料库 ${Object.keys(MINERAL_KB).length} 条。包括矿物、变种、集合体与部分岩石标本，现场准确率和未覆盖矿物拒判能力仍待盲测。`;
    route();
    try{await SpecimenStore.migrate();}catch(e){toast(e.message);}
    if(isNative()){
      $('#offlineInfo').textContent='安装包内置原生识别引擎、模型和资料。关闭网络后仍可分析，首次使用无需下载模型。';$('#offlineBtn').hidden=true;
      const app=plugin('App');
      await app?.addListener('appRestoredResult',event=>{if(event.pluginId==='Camera' && event.success && event.data?.webPath)void addPhoto(event.data.webPath).catch(e=>toast(e.message));});
      await app?.addListener('appStateChange',event=>{if(!event.isActive){state.controller?.abort();cancelInput();stopCamera();stopRecording(true);}});
      await app?.addListener('backButton',()=>{const dialog=document.querySelector('dialog[open]');if(dialog){dialog.close();return;}if(state.busy){state.controller?.abort();return;}if(state.mediaBusy){cancelInput();return;}if(state.view!=='identify'){location.hash='identify';return;}void app.minimizeApp();});
    }else if('serviceWorker' in navigator && location.protocol==='https:' && !['127.0.0.1','localhost'].includes(location.hostname)){navigator.serviceWorker.register('./sw.js').catch(()=>{});}
    setTimeout(dismissCover,900);
  }
  void init().catch(e=>toast(`初始化失败：${e.message}`));
})();
