(function () {
  'use strict';
  const MODELS = [
    {id:'mobilenet',file:'mobilenet_int8.onnx',title:'MobileNet'},
    {id:'efficientnet',file:'efficientnet.onnx',title:'EfficientNet'},
    {id:'efficientnet-legacy',file:'efficientnet_legacy.onnx',title:'交叉模型'}
  ];
  let worker;
  const abort=signal=>{if(signal?.aborted)throw new DOMException('分析已停止','AbortError');};
  async function image(src) {
    const img=new Image();img.src=src;
    let timer;
    try{await Promise.race([img.decode(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('图片读取超时，请换用 JPEG 或 PNG')),15000);})]);}
    finally{clearTimeout(timer);}
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
    if(!worker)worker=new Worker(new URL('./engine-worker.js',location.href));
    const current=worker;
    return new Promise((resolve,reject)=>{
      let settled=false;
      const finish=(error,result,terminate=false)=>{
        if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);
        current.onmessage=null;current.onerror=null;
        if(terminate){current.terminate();if(worker===current)worker=null;}
        error?reject(error):resolve(result);
      };
      const cancel=()=>finish(new DOMException('分析已停止','AbortError'),null,true);
      const timer=setTimeout(()=>finish(new Error('分析超过 120 秒，已停止。请重试快速模式，或使用内置模型的安装版'),null,true),120000);
      signal?.addEventListener('abort',cancel,{once:true});
      current.onerror=()=>finish(new Error('后台识别组件无法运行，请更新 App 或重新准备离线资源'),null,true);
      current.onmessage=({data})=>{
        if(data.type==='progress')report(data.message);
        if(data.type==='partial')report(`初步候选：${window.MINERAL_KB[data.key]?.name_zh||data.key}；正在继续复核…`);
        if(data.type==='result')finish(null,data);
        if(data.type==='error')finish(new Error(data.message),null,true);
      };
      try{current.postMessage({type:'analyze',base:new URL('./',location.href).href,inputs,labels:keys,models:precision?MODELS:MODELS.slice(0,1),screen:true,blocked:window.IMAGENET_BLOCKED},inputs.map(x=>x.buffer));}
      catch(e){finish(e,null,true);}
    });
  }
  async function analyze(photos,options={}) {
    const {signal,report=()=>{},observation={},precision=true}=options;
    if(!photos.length||photos.length>3)throw new Error('请添加 1–3 张同一标本的照片或视频帧');
    const inputs=[],qualityReports=[],warnings=[];
    for(let i=0;i<photos.length;i++){
      abort(signal);report(`检查图像质量 ${i+1}/${photos.length}…`);
      const img=await image(photos[i].src);abort(signal);
      if(Math.min(img.naturalWidth,img.naturalHeight)<64)throw new Error(`图像 ${i+1} 分辨率过低，请重新拍摄`);
      const pixels=cropCanvas(img,224,photos[i].crop||1).getContext('2d').getImageData(0,0,224,224);
      const q=MineralCore.quality(pixels.data,224,224);qualityReports.push(q);
      if(q.warnings.some(x=>/偏暗|过曝|纹理过少/.test(x)))throw new Error(`图像 ${i+1}：${q.warnings.join('；')}。请重拍或选择清晰视频帧`);
      warnings.push(...q.warnings.map(x=>`图像 ${i+1}：${x}`));inputs.push(pixelsToInput(pixels.data));
    }
    const keys=Object.keys(MINERAL_CLASSES),raw=await workerRun(inputs,keys,{signal,report,precision});abort(signal);
    warnings.push(...raw.warnings);
    for(const screening of raw.screening){if(MineralCore.screen(screening.values,window.IMAGENET_BLOCKED).rejected)throw new Error(MineralCore.NON_MINERAL);}
    const result=MineralCore.summarize(raw.runs,keys,MINERAL_KB,observation);
    if(warnings.length){result.status='uncertain';result.reasons.push(...warnings);}
    return {...result,quality:qualityReports,observations:observation,warnings,engine:'onnx-worker-wasm',version:'2.0.0-preview'};
  }
  window.MineralEngine={analyze,image,cropCanvas,models:MODELS};
})();
