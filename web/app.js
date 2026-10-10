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
  const libraryPageSize=80,catalogById=new Map(),catalogByDetail=new Map();
  let catalog={},catalogRows=[],crystalSource={},crystalById=new Map(),imageSource={},imageRows=[],imagesByName=new Map(),libraryItems=[],referenceLoading;
  let selectedCrystals=[],crystalsShown=0,selectedImages=[],imagesShown=0;
  const normalizeSearch=value=>String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  const referenceModelSupported=(reference,key)=>[key,reference?.detail_key,...(Array.isArray(reference?.legacy_keys)?reference.legacy_keys:[])].some(label=>!!MINERAL_CLASSES[label]);
  const makeLibraryItem=(key,detail,reference)=>({key,detail,reference,
    title:detail?.name_zh||reference?.name_en||detail?.name_en||key,
    english:reference?.name_en||detail?.name_en||'',formula:reference?.formula||detail?.formula||'',
    model:referenceModelSupported(reference,key),expanded:!!detail,crystals:reference?crystalById.get(reference.id)||[]:[],
    search:normalizeSearch([key,detail?.name_zh,detail?.name_en,detail?.formula,reference?.name_en,reference?.formula,...(Array.isArray(reference?.aliases_en)?reference.aliases_en:[])].filter(Boolean).join('\n'))});
  function rebuildReferenceIndex(){
    catalog=window.MINERAL_CATALOG||{};crystalSource=window.MINERAL_CRYSTAL_RECORDS||{};imageSource=window.MINERAL_IMAGE_SOURCES||{};
    catalogRows=(Array.isArray(catalog.minerals)?catalog.minerals:Array.isArray(catalog.entries)?catalog.entries:[]).filter(row=>row&&typeof row.id==='string'&&typeof row.name_en==='string'&&row.name_en.trim());
    catalogById.clear();catalogByDetail.clear();crystalById=new Map();
    imageRows=Array.isArray(imageSource.records)?imageSource.records.filter(row=>row&&row.mineral_name&&safeLink(row.image_page_url)):[];imagesByName=new Map();
    for(const row of imageRows){const key=normalizeSearch(row.mineral_name);if(!imagesByName.has(key))imagesByName.set(key,[]);imagesByName.get(key).push(row);}
    for(const row of catalogRows){
      catalogById.set(row.id,row);
      for(const key of [row.detail_key,...(Array.isArray(row.legacy_keys)?row.legacy_keys:[])])if(key&&window.MINERAL_KB[key]&&!catalogByDetail.has(key))catalogByDetail.set(key,row);
      const raw=crystalSource.by_species?.[row.id]||crystalSource.by_species?.[row.name_en]||[];
      const records=Array.isArray(raw)?raw.filter(r=>r&&r.cell&&!/\b(synthetic|theoretical|simulat\w*|hypothetical|idealized)\b/i.test([r.article_title,r.experimental_notes].join(' '))):[];
      if(records.length)crystalById.set(row.id,records);
    }
    libraryItems=catalogRows.map(row=>{const detail=window.MINERAL_KB[row.detail_key];return makeLibraryItem(detail?row.detail_key:'catalog:'+row.id,detail||null,row);})
      .concat(Object.entries(window.MINERAL_KB).filter(([key])=>!catalogByDetail.has(key)).map(([key,detail])=>makeLibraryItem(key,detail,null)));
    libraryFingerprint=undefined;
  }
  let libraryMatches=[],libraryShown=0,libraryFingerprint;
  const safeLink=value=>/^https?:\/\//i.test(String(value||''))?String(value):'';
  function catalogSourceMarkup(row){
    const source=catalog.source||{},url=safeLink(row?.source_url||source.url),page=Number(row?.source_page),licenseUrl=safeLink(source.license_url),link=url.replace(/#.*$/,'')+(Number.isInteger(page)&&page>0?'#page='+page:'');
    return `<p>${html(source.title||'IMA–CNMNC 矿物清单')}${catalog.version?' · '+html(catalog.version):''}${catalog.retrieved_at?' · 获取于 '+html(catalog.retrieved_at):''}</p>${url?`<p><a href="${html(link)}" target="_blank" rel="noopener noreferrer">查看官方清单${Number.isInteger(page)&&page>0?' · 第 '+page+' 页':''}</a></p>`:''}${source.license?`<p class="field-hint">许可：${licenseUrl?`<a href="${html(licenseUrl)}" target="_blank" rel="noopener noreferrer">${html(source.license)}</a>`:html(source.license)}。基础字段来自以上原始清单；本应用保留来源与页码。</p>`:''}${source.attribution?`<p class="field-hint">${html(source.attribution)}</p>`:''}`;
  }
  function renderCatalogIntro(){
    const handbookCount=catalogRows.filter(row=>safeLink(row.handbook_url)).length;
    $('#catalogIntro').innerHTML=`<strong>${catalogRows.length?`官方目录 ${catalogRows.length} 种 · ${handbookCount} 个详细 PDF 链接 · ${crystalById.size} 种有晶胞记录`:'原有矿物资料'}</strong><p>名称与化学式可离线搜索。基础目录未提供的中文名、物性与成因不会自动补写；新增资料不会增加图像模型类别。${catalogRows.length?'IMA 状态与首次发现国家按原表保留。晶胞为文献样品数据，PDF 全文需要联网。':''}</p>${imageRows.length?`<p>标本图库：${imageRows.length} 条图片出处，涉及 ${imagesByName.size} 个矿物名称；通过训练审核 ${imageRows.filter(row=>row.training_ready===true).length} 条。图库用于查阅来源，不能作为已完成训练或已验证标签的证明。</p>`:''}${catalogRows.length?`<details class="catalog-attribution"><summary>资料来源与许可</summary>${catalogSourceMarkup()}</details>`:''}`;
    $('#coverageInfo').textContent=`当前图像模型有 ${Object.keys(MINERAL_CLASSES).length} 个原有标签，原有扩展资料 ${Object.keys(MINERAL_KB).length} 条${catalogRows.length?`，官方基础目录 ${catalogRows.length} 种、${handbookCount} 个在线详细 PDF 链接、${crystalById.size} 种文献晶胞记录`:''}。目录覆盖不等于图像识别范围；现场准确率与未覆盖对象拒判能力仍待盲测。`;
  }
  function initializeCatalogUi(){
    rebuildReferenceIndex();
    $('.library-tools').insertAdjacentHTML('afterbegin','<select id="libraryScope" aria-label="按资料范围筛选"><option value="all">全部目录</option><option value="expanded">有扩展资料</option><option value="model">图像模型范围</option><option value="crystals">有晶胞记录</option></select>');
    $('#libraryList').insertAdjacentHTML('beforebegin','<aside id="catalogIntro" class="catalog-intro"></aside><div class="catalog-loading"><p id="catalogLoadState" role="status" aria-live="polite"></p><button id="catalogRetry" type="button" class="secondary" hidden>重试打开完整资料库</button></div>');
    $('#libraryList').insertAdjacentHTML('afterend','<div class="library-pagination"><p id="libraryStatus" role="status" aria-live="polite"></p><button id="libraryMore" type="button" class="secondary" hidden>加载更多 80 项</button></div>');
    $('#libraryScope').addEventListener('change',()=>{updateClassFilter();});$('#libraryMore').addEventListener('click',()=>{appendLibraryPage();});
    $('#librarySearch').placeholder='搜索中文 / 英文矿物名或化学式';
    $('#catalogRetry').addEventListener('click',()=>{void ensureReferenceCatalog(true);});renderCatalogIntro();
    guidePages[0]?.insertAdjacentHTML('beforeend','<p class="guide-note">图鉴可打开 IMA 基础目录与文献晶胞记录，按“全部目录 / 有扩展资料 / 图像模型范围 / 有晶胞记录”筛选，支持英文与化学式离线搜索。每次展示 80 项，可继续加载。首次发现国家不代表当前标本产地；晶胞来自文献样品，不从照片推定。官网清单、详细 PDF 与标本图库原页需要联网。图库只列来源链接；照片质量、许可、共生矿物与标签仍需专家审核，不代表已经加入识别训练。未收录的物性明确留空。</p>');
  }
  function ensureReferenceCatalog(retry=false){
    const loader=window.MineralReference;if(!loader?.load)return Promise.resolve();
    if(referenceLoading)return referenceLoading;
    if(loader.status==='ready'&&catalog===window.MINERAL_CATALOG)return Promise.resolve();
    $('#catalogLoadState').textContent='正在打开完整资料库，可先搜索原有资料。图像识别不等待目录加载。';$('#catalogRetry').hidden=true;
    referenceLoading=Promise.resolve().then(()=>loader.load({retry})).then(()=>{rebuildReferenceIndex();renderCatalogIntro();updateClassFilter();$('#catalogLoadState').textContent=`完整资料库已就绪：${catalogRows.length} 种官方矿物目录，支持离线搜索。`;}).catch(error=>{$('#catalogLoadState').textContent=`完整资料库暂未打开：${String(error.message||'资源读取失败').slice(0,160)}。原有资料仍可查阅。`;$('#catalogRetry').hidden=false;}).finally(()=>{referenceLoading=null;});
    return referenceLoading;
  }
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
    if (view === 'library') { renderLibrary(); void ensureReferenceCatalog(); }
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
  function properties(k,reference) {
    const facts=reference?.physical_properties||k.verified_properties||{},values=[['化学式',reference?.formula||k.formula,'formula'],['摩氏硬度',k.hardness,'hardness'],['实测密度',null,'density_measured'],['晶系',k.crystal_system,'crystal_system'],['解理',k.cleavage,'cleavage'],['光泽',k.luster,'luster'],['条痕',k.streak,'streak'],['颜色',k.color,'color'],['晶体习性',k.habit,'habit'],['分类',k.classification?.class_9,'classification']];
    return `<dl class="detail-properties">${values.map(([label,legacy,field])=>{
      const fact=facts[field],value=fact?.value,usable=fact?.status!=='unavailable'&&value!==undefined&&value!==null&&String(value).trim()!==''&&!/^(?:n\.?\s*d\.?|not determined|unknown)$/i.test(String(value).trim());
      let text,provenance='';
      if(usable){const url=safeLink(fact.source_url),page=Number(fact.source_page);text=html(value)+(fact.unit&&fact.unit!=='Mohs'?' '+html(fact.unit):'');if(fact.raw&&String(fact.raw)!==String(value))text+=`<small class="property-raw">原文：${html(fact.raw)}</small>`;provenance=url?`<a class="property-source" href="${html(url.replace(/#.*$/,'')+(Number.isInteger(page)&&page>0?'#page='+page:''))}" target="_blank" rel="noopener noreferrer">MSA 矿物手册${Number.isInteger(page)&&page>0?' · 第 '+page+' 页':''}</a>`:'<small class="property-source">已收录来源字段</small>';if(fact.status!=='verified')provenance+=`<small class="property-source">${fact.status==='source_inferred'?'据来源推定 · ':''}待复核</small>`;}
      else if(field==='formula'&&(reference?.formula||k.formula_source)){const source=reference?{url:reference.source_url,page:reference.source_page}:k.formula_source,url=safeLink(source.url),page=Number(source.page);text=html(reference?.formula||k.formula);provenance=url?`<a class="property-source" href="${html(url.replace(/#.*$/,'')+(Number.isInteger(page)&&page>0?'#page='+page:''))}" target="_blank" rel="noopener noreferrer">IMA 官方清单${Number.isInteger(page)&&page>0?' · 第 '+page+' 页':''}</a>`:'<small class="property-source">IMA 官方清单</small>';}
      else if(fact){const url=safeLink(fact.source_url),page=Number(fact.source_page),review=fact.status==='needs_review';text=review?'待复核':'未收录';provenance=`<small class="property-source">${review?'提取内容待复核，暂不作为有效物性':fact.status==='source_inferred'?'来源推测尚无可核验值':'原文未给出可用值'}${review&&fact.note?'；'+html(fact.note):''}</small>`+(url?`<a class="property-source" href="${html(url.replace(/#.*$/,'')+(Number.isInteger(page)&&page>0?'#page='+page:''))}" target="_blank" rel="noopener noreferrer">查看原始物性页</a>`:'');}
      else{const present=legacy!==undefined&&legacy!==null&&legacy!=='';text=html(present?legacy:'未收录');if(present)provenance='<small class="property-source">原项目资料 · 待复核</small>';}
      return `<div><dt>${label}</dt><dd>${text}${provenance}</dd></div>`;
    }).join('')}</dl>`;
  }
  function showDetail(key) {
    const reference=key.startsWith('catalog:')?catalogById.get(key.slice(8)):catalogByDetail.get(key),detailKey=window.MINERAL_KB[key]?key:reference?.detail_key||key,k=kb(detailKey);
    if (!Object.keys(k).length&&!reference) { toast('该候选暂未收录资料'); return; }
    $('#detailTitle').textContent = k.name_zh||reference?.name_en||name(detailKey);
    $('#detailType').textContent = `${types[detailKey] || (reference?'IMA 基础目录':'矿物资料')} · ${referenceModelSupported(reference,detailKey)?'图像模型支持':Object.keys(k).length?'有扩展资料':'资料查阅'}`;
    const referenceFields=reference?[['IMA 英文名称',reference.name_en],['IMA 状态（原表代码）',reference.ima_status],['IMA 编号 / 原表年份',reference.ima_number],['首次发现国家',reference.discovery_country],['矿物符号',reference.symbol]]:[];
    const handbook=safeLink(reference?.handbook_url);
    $('#detailBody').innerHTML = `<p class="field-hint">${html(reference?.name_en||k.name_en||key)}${k.summary?' · '+html(k.summary):''}</p>${properties(k,reference)}${reference?`<section class="detail-section"><h3>官方目录字段</h3><dl class="detail-properties">${referenceFields.filter(([,value])=>value!==undefined&&value!=='').map(([label,value])=>`<div><dt>${html(label)}</dt><dd>${html(value)}</dd></div>`).join('')}</dl><p class="field-hint">以上按原表保留。IMA 编号中的年份不推算为批准时间；首次发现国家不代表当前标本产地。</p></section>`:''}${k.formation?`<section class="detail-section"><h3>形成与产出</h3><p>${html(k.formation)}</p></section>`:reference?'<section class="detail-section"><h3>形成与产出</h3><p>未收录</p></section>':''}${k.typical_localities?.length?`<section class="detail-section"><h3>典型产地</h3><p>${html(k.typical_localities.join('、'))}</p></section>`:''}${k.industrial_uses?.length?`<section class="detail-section"><h3>用途</h3><ul>${k.industrial_uses.map(x=>`<li>${html(x)}</li>`).join('')}</ul></section>`:reference?'<section class="detail-section"><h3>用途</h3><p>未收录</p></section>':''}${reference?`<section class="detail-section"><h3>原表参考文献</h3>${[reference.first_reference,reference.second_reference].filter(Boolean).map(text=>`<p>${html(text)}</p>`).join('')||'<p>未收录</p>'}</section>`:''}${handbook?`<section class="detail-section"><h3>在线详细资料</h3><p><a href="${html(handbook)}" target="_blank" rel="noopener noreferrer">打开官方矿物手册 PDF</a></p><p class="field-hint">需要联网，按官方英文名称匹配的详细资料链接。全文未打包进离线目录。</p></section>`:''}<section class="detail-section"><h3>资料来源</h3>${reference?catalogSourceMarkup(reference):''}${Object.keys(k).length?`<p class="field-hint">原项目扩展资料：${html((k.source_refs || []).join('；') || '项目原有矿物知识库')}。物性按字段标注来源；形成、产地、用途与其他未标官方出处的原项目资料仍待复核。未收录的物性不参与复核。</p>`:'<p class="field-hint">当前展示官方基础字段与已列明的文献数据。未补充的中文名和物性明确留空；目录范围不代表图像识别能力。</p>'}</section>`;
    selectedCrystals=reference?crystalById.get(reference.id)||[]:[];crystalsShown=0;
    if(reference){$('#detailBody').insertAdjacentHTML('beforeend',crystalSectionMarkup());appendCrystalRecords();}
    selectedImages=imagesByName.get(normalizeSearch(reference?.name_en||k.name_en))||[];imagesShown=0;
    if(selectedImages.length){$('#detailBody').insertAdjacentHTML('beforeend',imageSectionMarkup());appendImageRecords();}
    openDialog('#detailDialog'); icons();
  }
  function imageSectionMarkup(){
    return `<details class="detail-section image-section"><summary>标本图库与鉴定出处（联网） · ${selectedImages.length} 条</summary><p class="field-hint">这里只列在线图片出处，未下载图片或把这些照片加入识别训练。公开许可不等于标签正确；共生标本需专家标注目标矿物。鉴定水平来自来源记录，本项目尚未独立核验。</p><div id="imageRecords" class="image-records"></div><p id="imageStatus" class="field-hint" role="status" aria-live="polite"></p><button type="button" class="secondary" id="moreImages" data-more-images>查看更多图库出处</button></details>`;
  }
  function imageRecordMarkup(record){
    const evidence=record.identification_evidence||{},levels={rruff_xrd_and_chemical_analysis:'来源称已用 X 射线衍射与化学分析确认',rruff_single_crystal_xrd:'来源标注单晶 X 射线衍射',rruff_raman_only:'来源标注拉曼证据，其他鉴定待复核',rruff_status_requires_review:'来源鉴定状态待复核',museum_photo_label_only_requires_expert_review:'博物馆照片标签，需专家复核'},permissions={unverified_photo_reuse_permission:'照片再使用权限待确认',per_file_open_license_requires_compliance_and_review:'原页注明公开许可，转载与训练仍需合规复核',per_file_public_domain_claim_requires_review:'原页标为公有领域，权利状态待复核'},licenseUrl=safeLink(record.license_url),evidenceUrl=safeLink(evidence.evidence_url);
    const components=Array.isArray(record.additional_indexed_components)?record.additional_indexed_components.map(item=>typeof item==='string'?item:item?.name_en||item?.mineral_name).filter(Boolean):[];
    return `<article class="image-record"><h4><a href="${html(safeLink(record.image_page_url))}" target="_blank" rel="noopener noreferrer">打开 ${html(record.source||'原始来源')} 图片原页</a></h4><p>样品编号：${html(record.sample_id||'未注明')} · 矿物：${html(record.mineral_name)}</p><p>来源鉴定：${html(levels[evidence.level]||evidence.level||'未注明，需复核')}${evidenceUrl?` · <a href="${html(evidenceUrl)}" target="_blank" rel="noopener noreferrer">查看鉴定记录</a>`:''}</p>${evidence.sample_locality?`<p>来源记录产地：${html(evidence.sample_locality)}</p>`:''}${components.length?`<p>同时索引的组分：${html(components.join('、'))}。共生目标需专家核定。</p>`:''}<p>作者：${html(record.author||'未注明')} · 许可：${record.license?(licenseUrl?`<a href="${html(licenseUrl)}" target="_blank" rel="noopener noreferrer">${html(record.license)}</a>`:html(record.license)):'待查'}</p><p class="field-hint">${html(permissions[record.permission_status]||'权利状态待复核')}。图像质量与矿物标签尚需审核；本条${record.training_ready===true?'被元数据标为可训练，新增模型仍需单独验证':'尚未通过训练审核'}。</p></article>`;
  }
  function appendImageRecords(){
    if(!selectedImages.length)return;
    const next=selectedImages.slice(imagesShown,imagesShown+5);$('#imageRecords').insertAdjacentHTML('beforeend',next.map(imageRecordMarkup).join(''));imagesShown+=next.length;
    $('#imageStatus').textContent=`已展示 ${imagesShown} / ${selectedImages.length} 条图库出处`;
    $('#moreImages').hidden=imagesShown>=selectedImages.length;$('#moreImages').textContent=`查看更多 ${Math.min(5,selectedImages.length-imagesShown)} 条出处`;
  }
  function crystalSectionMarkup(){
    const source=crystalSource.source||{},url=safeLink(source.url);
    return `<section class="detail-section crystal-section"><h3>实验晶胞与结构文献</h3><p class="field-hint">以下为文献中各样品的测量记录，长度单位 Å，角度单位 °；空间群按原文保留。不能从标本照片推定晶胞，也不能因原文未注明合成就认定样品天然。</p>${selectedCrystals.length?'<div id="crystalRecords" class="crystal-records"></div><p id="crystalStatus" class="field-hint" role="status" aria-live="polite"></p><button type="button" class="secondary" id="moreCrystals" data-more-crystals>查看更多晶胞记录</button>':'<p>该矿物的实验晶胞记录尚未收录。</p>'}${source.title?`<p class="field-hint">资料来源：${url?`<a href="${html(url)}" target="_blank" rel="noopener noreferrer">${html(source.title)}</a>`:html(source.title)}。${html(source.scope||'测量事实与书目信息，未转载论文全文。')}</p>`:''}</section>`;
  }
  function crystalRecordMarkup(record,index){
    const values=[['a',record.cell.a,'Å'],['b',record.cell.b,'Å'],['c',record.cell.c,'Å'],['α',record.cell.alpha,'°'],['β',record.cell.beta,'°'],['γ',record.cell.gamma,'°']],url=safeLink(record.source_url);
    return `<article class="crystal-record"><h4>样品记录 ${index+1} · ${html(record.id||'编号未收录')}</h4><dl class="crystal-cell">${values.map(([label,value,unit])=>`<div><dt>${label}</dt><dd>${html(value===undefined||value===null?'未收录':value+' '+unit)}</dd></div>`).join('')}</dl><p><strong>空间群：</strong>${html(record.space_group||'未收录')}</p>${record.authors?`<p><strong>作者：</strong>${html(record.authors)}</p>`:''}${record.article_title?`<p><strong>论文：</strong>${html(record.article_title)}</p>`:''}${record.citation?`<p><strong>出处：</strong>${html(record.citation)}</p>`:''}<p class="experimental-notes"><strong>实验条件 / 原文备注：</strong>${html(record.experimental_notes||'未注明')}</p><p><strong>样品来源状态：</strong>${html(record.sample_origin||'原文未注明；不能据此推定天然来源')}</p><p class="field-hint">记录 ID：${html(record.id||'未收录')} · 原始文件：${html(record.source_file||'未收录')}${url?` · <a href="${html(url)}" target="_blank" rel="noopener noreferrer">查看原始数据库</a>`:''}</p></article>`;
  }
  function appendCrystalRecords(){
    if(!selectedCrystals.length)return;
    const next=selectedCrystals.slice(crystalsShown,crystalsShown+5);
    $('#crystalRecords').insertAdjacentHTML('beforeend',next.map((record,index)=>crystalRecordMarkup(record,crystalsShown+index)).join(''));crystalsShown+=next.length;
    $('#crystalStatus').textContent=`已展示 ${crystalsShown} / ${selectedCrystals.length} 条文献样品记录`;
    $('#moreCrystals').hidden=crystalsShown>=selectedCrystals.length;
    $('#moreCrystals').textContent=`查看更多 ${Math.min(5,selectedCrystals.length-crystalsShown)} 条记录`;
  }
  function libraryCard(item){const detail=item.detail||{},kind=item.model?'模型候选':item.expanded?'扩展资料':'基础目录';return `<button type="button" class="mineral-card" data-detail="${html(item.key)}"><span class="mineral-symbol" aria-hidden="true">${html((item.formula || '◇').slice(0,4))}</span><strong>${html(item.title)}</strong>${item.title!==item.english?`<small>${html(item.english)}</small>`:''}<span class="card-formula formula">${html(item.formula || '化学式未收录')}</span><span class="category">${html(types[item.key] || (detail.classification?category(detail,$('#classScheme').value):'分类未收录'))} · ${kind}</span></button>`;}
  function updateLibraryPageStatus(){
    $('#libraryStatus').textContent=`已展示 ${libraryShown} / ${libraryMatches.length} 项${libraryMatches.length?' · 每次加载 80 项':''}`;
    $('#libraryMore').hidden=libraryShown>=libraryMatches.length;
    $('#libraryMore').textContent=`加载更多 ${Math.min(libraryPageSize,libraryMatches.length-libraryShown)} 项`;
  }
  function appendLibraryPage(){const next=libraryMatches.slice(libraryShown,libraryShown+libraryPageSize);if(next.length){$('#libraryList').insertAdjacentHTML('beforeend',next.map(libraryCard).join(''));libraryShown+=next.length;}updateLibraryPageStatus();}
  function renderLibrary() {
    const query=normalizeSearch($('#librarySearch').value.trim()),filter=$('#classFilter').value,scheme=$('#classScheme').value,scope=$('#libraryScope').value||'all',fingerprint=JSON.stringify([query,filter,scheme,scope]);
    if(fingerprint===libraryFingerprint){updateLibraryPageStatus();return;}
    libraryFingerprint=fingerprint;libraryShown=0;
    libraryMatches=libraryItems.filter(item=>item.search.includes(query)&&(!filter||libraryCategory(item,scheme)===filter)&&libraryScopeMatches(item,scope));
    $('#libraryCount').textContent=`${libraryMatches.length} 项资料`;
    $('#libraryList').innerHTML=libraryMatches.length?'':'<div class="empty-state"><h2>没有匹配的资料</h2><p>试试英文矿物名称、中文名或化学式，也可切换资料范围。</p></div>';
    appendLibraryPage();
  }
  const schemes={strunz_10:['自然元素','硫化物','卤化物','氧化物','硝酸盐/碳酸盐','硼酸盐','硫酸盐','磷酸盐','硅酸盐','有机化合物'],class_9:['自然元素','硫化物/硫盐','卤化物','氧化物/氢氧化物','硝酸盐','碳酸盐','钼酸盐/钨酸盐','磷酸盐/砷酸盐/钒酸盐','硅酸盐'],class_8:['自然元素','硫化物','卤化物','氧化物及氢氧化物','碳酸盐/硝酸盐/硼酸盐','硫酸盐','磷酸盐','硅酸盐']};
  function category(k,scheme){let value=k.classification?.[scheme]||'';if(scheme==='strunz_10'&&['碳酸盐','硝酸盐'].includes(value))value='硝酸盐/碳酸盐';if(scheme==='strunz_10'&&value.startsWith('氧化物'))value='氧化物';if(scheme==='class_8'&&value.startsWith('氧化物'))value='氧化物及氢氧化物';return schemes[scheme]?.includes(value)?value:'体系外 / 待核对';}
  function libraryCategory(item,scheme){return item.detail?.classification?category(item.detail,scheme):'分类未收录';}
  function libraryScopeMatches(item,scope){return scope==='expanded'?item.expanded:scope==='model'?item.model:scope==='crystals'?item.crystals.length>0:true;}
  function updateClassFilter(){const scheme=$('#classScheme').value,scope=$('#libraryScope').value||'all',previous=$('#classFilter').value,available=libraryItems.filter(item=>libraryScopeMatches(item,scope));const counts=new Map();available.forEach(item=>{const key=libraryCategory(item,scheme);counts.set(key,(counts.get(key)||0)+1);});const labels=[...schemes[scheme],'体系外 / 待核对','分类未收录'];$('#classFilter').innerHTML='<option value="">全部类别</option>'+labels.map(c=>`<option value="${html(c)}">${html(c)} · ${counts.get(c)||0}</option>`).join('');$('#classFilter').value=labels.includes(previous)?previous:'';renderLibrary();}
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
    const assets = ['./','./index.html','./styles.css','./app.js','./core.js','./inference.js','./engine-worker.js','./history.js','./media.js','./storage.js','./reference-loader.js','./config.js','./manifest.webmanifest','./model-manifest.json','./icon.svg','./icon-192.png','./icon-512.png','./icon-maskable.png','./version.json','./data/classes.js','./data/minerals.js','./data/sources.js','./data/imagenet.js','./data/catalog.json','./data/crystals.json','./data/image-sources.json','./data/reference-manifest.json','./data/licenses/ima-cnmnc-2026-09.txt','./vendor/lucide.min.js','./vendor/ort.min.js','./vendor/ort-wasm-simd-threaded.mjs','./vendor/ort-wasm-simd-threaded.wasm', ...MineralEngine.models.map(m=>'./models/'+m.file),'./models/imagenet_gate.onnx'];
    try {
      await bounded(()=>navigator.serviceWorker.register('./sw.js'),15000,'离线服务启动超时',controller.signal);
      const manifest=await bounded(async signal=>{const response=await fetch('./model-manifest.json',{signal,cache:'reload'});if(!response.ok)throw new Error(`模型目录下载失败 (${response.status})`);return response.json();},30000,'模型目录读取超时',controller.signal);
      if(!Array.isArray(manifest.models))throw new Error('模型目录不完整，请重试');
      for (let i=0;i<assets.length;i++) {
        if(controller.signal.aborted)throw new DOMException('准备已停止','AbortError');
        $('#offlineProgress').textContent=`正在准备资源 ${i+1}/${assets.length}（模型共约 70 MB）…`;
        const cache = await caches.open(assets[i].includes('/models/') || assets[i].endsWith('.wasm') ? 'shikuang-models-v2-20261010':'shikuang-static-2.0.2-preview.1');
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
    if(e.target.closest('[data-more-crystals]'))appendCrystalRecords();
    if(e.target.closest('[data-more-images]'))appendImageRecords();
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
    initializeCatalogUi();updateClassFilter();renderSearchHistory();
    try{setMode(localStorage.getItem('shikuang-mode-v2'));}catch(_){setMode('offline');}
    $('#sourceList').innerHTML=MINERAL_SOURCES.map(s=>`<a href="${html(s.url)}" target="_blank" rel="noopener noreferrer"><strong>${html(s.title)}</strong><span>${html(s.status)}</span><small>${html(s.use)}</small></a>`).join('');
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
