(function () {
  'use strict';
  const MODELS = [
    {id:'mobilenet',file:'mobilenet_int8.onnx',title:'MobileNet'},
    {id:'efficientnet',file:'efficientnet.onnx',title:'EfficientNet'},
    {id:'efficientnet-legacy',file:'efficientnet_legacy.onnx',title:'交叉模型'}
  ];
  let worker, workerReady=false, nativeEngine;
  const abort=signal=>{if(signal?.aborted)throw new DOMException('分析已停止','AbortError');};
  async function image(src,signal) {
    abort(signal);
    const img=new Image();img.src=src;
    let timer,cancel;
    try{await Promise.race([img.decode(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('图片读取超时，请换用 JPEG 或 PNG')),15000);cancel=()=>reject(new DOMException('分析已停止','AbortError'));signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();})]);}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);if(signal?.aborted)img.src='';}
    abort(signal);
    if(!img.naturalWidth||!img.naturalHeight)throw new Error('无法读取图片，请重新拍摄');return img;
  }
  function cropCanvas(img,size=224,crop=1) {
    const canvas=document.createElement('canvas');canvas.width=canvas.height=size;
    const side=Math.min(img.naturalWidth,img.naturalHeight)*crop;
    canvas.getContext('2d',{willReadFrequently:true}).drawImage(img,(img.naturalWidth-side)/2,(img.naturalHeight-side)/2,side,side,0,0,size,size);return canvas;
  }
  function pixelsToInput(data) {
    const input=new Float32Array(3*224*224),mean=[.485,.456,.406],std=[.229,.224,.225];
    for(let c=0;c<3;c++)for(let i=0;i<224*224;i++)input[c*224*224+i]=(data[i*4+c]/255-mean[c])/std[c];return input;
  }
  function workerRun(inputs,keys,{signal,report,precision}) {
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
      const start=()=>{if(posted||settled)return;posted=true;try{current.postMessage({type:'analyze',base:new URL('./',location.href).href,inputs,labels:keys,models:precision?MODELS:MODELS.slice(0,1),screen:true,blocked:window.IMAGENET_BLOCKED},inputs.map(x=>x.buffer));}catch(e){finish(e,null,true);}};
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
    const bytes=new Uint8Array(input.buffer,input.byteOffset,input.byteLength);let binary='';
    for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
    return btoa(binary);
  }
  function nativeRun(inputs,keys,{signal,report,precision}) {
    abort(signal);
    const cap=window.Capacitor;
    if(!cap?.isPluginAvailable?.('MineralInference'))throw new Error('安装包缺少原生识别组件，请安装识矿 2.0.1 或更新版本');
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
        return current.classify({jobId,inputs:inputs.map(encodedInput),labels:keys,models:precision?MODELS:MODELS.slice(0,1),blocked:window.IMAGENET_BLOCKED});
      }).then(result=>{if(!settled)finish(null,result);}).catch(error=>finish(error));
    });
  }
  async function analyze(photos,options={}) {
    const {signal,report=()=>{},observation={},precision=true}=options;
    if(!photos.length||photos.length>3)throw new Error('请添加 1–3 张同一标本的照片或视频帧');
    const inputs=[],qualityReports=[],warnings=[];
    for(let i=0;i<photos.length;i++){
      abort(signal);report(`检查图像质量 ${i+1}/${photos.length}…`);
      const img=await image(photos[i].src,signal);abort(signal);
      if(Math.min(img.naturalWidth,img.naturalHeight)<64)throw new Error(`图像 ${i+1} 分辨率过低，请重新拍摄`);
      const pixels=cropCanvas(img,224,photos[i].crop||1).getContext('2d').getImageData(0,0,224,224);
      const q=MineralCore.quality(pixels.data,224,224);qualityReports.push(q);
      if(q.warnings.some(x=>/偏暗|过曝|纹理过少/.test(x)))throw new Error(`图像 ${i+1}：${q.warnings.join('；')}。请重拍或选择清晰视频帧`);
      warnings.push(...q.warnings.map(x=>`图像 ${i+1}：${x}`));inputs.push(pixelsToInput(pixels.data));
    }
    const native=!!window.Capacitor?.isNativePlatform?.();
    const keys=Object.keys(MINERAL_CLASSES),raw=await (native?nativeRun:workerRun)(inputs,keys,{signal,report,precision});abort(signal);
    if(!raw||!Array.isArray(raw.runs)||!Array.isArray(raw.screening)||!Array.isArray(raw.warnings))throw new Error('识别组件返回的数据不完整，请重试');
    if(raw.rejected)throw new Error(MineralCore.NON_MINERAL);
    if(raw.screening.length!==photos.length)throw new Error('输入筛查未完成，请重试；本次不生成矿物候选');
    warnings.push(...raw.warnings);
    for(const screening of raw.screening){if(MineralCore.screen(screening.values,window.IMAGENET_BLOCKED).rejected)throw new Error(MineralCore.NON_MINERAL);}
    const result=MineralCore.summarize(raw.runs,keys,MINERAL_KB,observation);
    if(warnings.length){result.status='uncertain';result.reasons.push(...warnings);}
    return {...result,quality:qualityReports,observations:observation,warnings,engine:native?'onnx-native-android':'onnx-worker-wasm',version:'2.0.1-preview'};
  }
  window.MineralEngine={analyze,image,cropCanvas,models:MODELS};
})();
