(function () {
  'use strict';
  let worker, workerReady=false, nativeEngine, configuration=null, active=false;
  const configurationHashes=new WeakMap();
  const hex = bytes => Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
  async function prepare(options={}) {
    const {signal} = options; abort(signal);
    const controller=new AbortController(),cancel=()=>controller.abort();
    signal?.addEventListener('abort',cancel,{once:true});
    let expired=false;
    const timer=setTimeout(()=>{expired=true;controller.abort();},15000);
    try {
      const response=await fetch(new URL('model-manifest.json',location.href),{cache:'no-cache',signal:controller.signal});
      const bytes=await MineralCore.readResource(response,100000);
      abort(signal);
      const loaded=MineralCore.validateManifest(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),Object.keys(MINERAL_CLASSES));
      if(!crypto.subtle)throw new Error('当前环境无法校验模型，请使用安装版或 HTTPS 地址');
      const digest=hex(await crypto.subtle.digest('SHA-256',bytes)); abort(signal);
      configuration=loaded;configurationHashes.set(loaded,digest);return loaded;
    }catch(error){configuration=null;if(expired)throw new Error('模型清单读取超过 15 秒，请重试或更新离线资源');abort(signal);throw error;}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
  }
  const abort=signal=>{if(signal?.aborted)throw new DOMException('分析已停止','AbortError');};
  async function image(src,signal) {
    abort(signal);
    const img=new Image();img.src=src;
    let timer,cancel;
    try{await Promise.race([img.decode(),new Promise((_,reject)=>{timer=setTimeout(()=>{reject(new Error('图片读取超时，请换用 JPEG 或 PNG'));img.src='';},15000);cancel=()=>reject(new DOMException('分析已停止','AbortError'));signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();})]);}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);if(signal?.aborted)img.src='';}
    abort(signal);
    if(!img.naturalWidth||!img.naturalHeight)throw new Error('无法读取图片，请重新拍摄');return img;
  }
  function cropCanvas(img,size=224,crop=1) {
    const canvas=document.createElement('canvas');canvas.width=canvas.height=size;
    const side=Math.min(img.naturalWidth,img.naturalHeight)*crop;
    const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='low';ctx.drawImage(img,(img.naturalWidth-side)/2,(img.naturalHeight-side)/2,side,side,0,0,size,size);return canvas;
  }
  function workerRun(inputs,keys,{signal,report,models,manifestHash}) {
    abort(signal);
    if(!window.Worker)throw new Error('当前 WebView 不支持后台识别，请更新系统 WebView');
    if(!worker){workerReady=false;worker=new Worker(new URL('./engine-worker.js',location.href));}
    const current=worker;
    return new Promise((resolve,reject)=>{
      let settled=false;
      const finish=(error,result,terminate=false)=>{
        if(settled)return;settled=true;clearTimeout(timer);clearTimeout(bootTimer);signal?.removeEventListener('abort',cancel);
        current.onmessage=null;current.onerror=null;
        if(terminate){current.terminate();if(worker===current){worker=null;workerReady=false;}}
        error?reject(error):resolve(result);
      };
      const cancel=()=>finish(new DOMException('分析已停止','AbortError'),null,true);
      const timer=setTimeout(()=>finish(new Error('分析超过 120 秒，已停止。请重试快速模式，或使用内置模型的安装版'),null,true),120000);
      const bootTimer=workerReady?null:setTimeout(()=>finish(new Error('识别线程启动超时，请重试或使用 Android 原生识别版'),null,true),15000);
      signal?.addEventListener('abort',cancel,{once:true});
      current.onerror=event=>{const detail=String(event.message||'浏览器未提供具体错误').slice(0,180);finish(new Error(`识别线程启动或运行失败：${detail}`),null,true);};
      let posted=false;
      const start=()=>{if(posted||settled)return;posted=true;try{current.postMessage({type:'analyze',base:new URL('./',location.href).href,inputs,labels:keys,modelIds:models.map(m=>m.id),mode:models.length===1?'fast':'ensemble',manifestSha256:manifestHash,screen:true,blocked:window.IMAGENET_BLOCKED},inputs.map(x=>x.buffer));}catch(e){finish(e,null,true);}};
      current.onmessage=({data})=>{
        if(data.type==='ready'){workerReady=true;clearTimeout(bootTimer);start();}
        if(data.type==='boot-error')finish(new Error(`识别组件初始化失败：${data.message}`),null,true);
        if(data.type==='progress')report(data.message);
        if(data.type==='partial')report(`初步候选：${window.MINERAL_KB[data.key]?.name_zh||data.key}；正在继续复核…`);
        if(data.type==='result')finish(null,data);
        if(data.type==='error')finish(new Error(data.message),null,true);
      };
      if(workerReady)start();else report('正在启动浏览器识别线程…');
    });
  }
  function encodedInput(input) {
    let bytes=new Uint8Array(input.buffer,input.byteOffset,input.byteLength);
    if(new Uint8Array(new Uint32Array([1]).buffer)[0]!==1){bytes=new Uint8Array(input.byteLength);const view=new DataView(bytes.buffer);for(let i=0;i<input.length;i++)view.setFloat32(i*4,input[i],true);}
    let binary='';
    for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
    return btoa(binary);
  }
  function nativeRun(inputs,keys,{signal,report,models,manifestHash}) {
    abort(signal);
    const cap=window.Capacitor;
    if(!cap?.isPluginAvailable?.('MineralInference'))throw new Error('安装包缺少原生识别组件，请更新 App');
    nativeEngine = nativeEngine || cap.registerPlugin?.('MineralInference') || cap.Plugins?.MineralInference;
    if(!nativeEngine)throw new Error('原生识别桥接未就绪，请重新打开或更新 App');
    const current=nativeEngine,jobId=crypto.randomUUID?.()||`mineral-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return new Promise((resolve,reject)=>{
      let settled=false,listener;
      const finish=(error,result,cancelNative=false)=>{
        if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);
        if(listener)void listener.remove().catch(()=>{});
        if(cancelNative)void current.cancel({jobId}).catch(()=>{});
        error?reject(error):resolve(result);
      };
      const cancel=()=>finish(new DOMException('分析已停止','AbortError'),null,true);
      const timer=setTimeout(()=>finish(new Error('原生分析超过 120 秒，已停止。可重试快速模式'),null,true),120000);
      signal?.addEventListener('abort',cancel,{once:true});
      Promise.resolve().then(()=>current.addListener('mineralProgress',event=>{if(!settled&&event.jobId===jobId)report(event.message);})).then(handle=>{
        if(settled){void handle.remove().catch(()=>{});return null;}
        listener=handle;abort(signal);report('正在启动 Android 原生识别…');abort(signal);
        return current.classify({jobId,inputs:inputs.map(encodedInput),inputEncoding:'float32-le-base64',labels:keys,modelIds:models.map(m=>m.id),mode:models.length===1?'fast':'ensemble',manifestSha256:manifestHash,blocked:window.IMAGENET_BLOCKED});
      }).then(result=>{if(!settled)finish(null,result);}).catch(error=>finish(error));
    });
  }
  async function analyze(photos,options={}) {
    if(active)throw new Error('已有分析正在进行，请先停止当前分析');
    active=true;
    try{return await analyzePrepared(photos,options);}finally{active=false;}
  }
  async function analyzePrepared(photos,options={}) {
    const {signal,report=()=>{},observation={},precision=true}=options;
    if(!photos.length||photos.length>3)throw new Error('请添加 1–3 张同一标本的照片或视频帧');
    const manifest=await prepare({signal}),manifestHash=configurationHashes.get(manifest),models=MineralCore.selectedModels(manifest,precision);
    const inputs=[],qualityReports=[],warnings=[];
    for(let i=0;i<photos.length;i++){
      abort(signal);report(`检查图像质量 ${i+1}/${photos.length}…`);
      const img=await image(photos[i].src,signal);abort(signal);
      if(Math.min(img.naturalWidth,img.naturalHeight)<64)throw new Error(`图像 ${i+1} 分辨率过低，请重新拍摄`);
      const crop=photos[i].crop===undefined?1:photos[i].crop;if(!Number.isFinite(crop)||crop<0.5||crop>1)throw new Error('中心分析区域需在 50%–100% 之间');
      const pixels=cropCanvas(img,224,crop).getContext('2d').getImageData(0,0,224,224);
      const q=MineralCore.quality(pixels.data,224,224);qualityReports.push(q);
      if(q.warnings.some(x=>/偏暗|过曝|纹理过少/.test(x)))throw new Error(`图像 ${i+1}：${q.warnings.join('；')}。请重拍或选择清晰视频帧`);
      warnings.push(...q.warnings.map(x=>`图像 ${i+1}：${x}`));inputs.push(MineralCore.pixelsToInput(pixels.data,manifest.input));
    }
    const native=!!window.Capacitor?.isNativePlatform?.();
    const keys=Object.keys(MINERAL_CLASSES),raw=await (native?nativeRun:workerRun)(inputs,keys,{signal,report,models,manifestHash});abort(signal);
    MineralCore.validateAnalysis(raw,photos.length,models,manifest,manifestHash);
    if(raw.rejected)throw new Error(MineralCore.NON_MINERAL);
    warnings.push(...raw.warnings);
    for(const screening of raw.screening){if(MineralCore.screen(screening.values,window.IMAGENET_BLOCKED).rejected)throw new Error(MineralCore.NON_MINERAL);}
    const calibratedRuns=raw.runs.map(run=>({...run,output:'logits',temperature:models.find(m=>m.id===run.model).temperature}));
    const result=MineralCore.summarize(calibratedRuns,keys,MINERAL_KB,observation);
    if(warnings.length){result.status='uncertain';result.reasons.push(...warnings);}
    return {...result,quality:qualityReports,observations:observation,warnings,engine:native?'onnx-native-android':'onnx-worker-wasm',modelVersion:manifest.version,manifestSha256:manifestHash,diagnostics:raw.diagnostics};
  }
  window.MineralEngine={analyze,image,cropCanvas,prepare,getModels:(precision=true)=>configuration?MineralCore.selectedModels(configuration,precision):[],get models(){return configuration?MineralCore.selectedModels(configuration,true):[];},get configuration(){return configuration;}};
})();
