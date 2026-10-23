/* Explicit research input preparation only. This module never decodes photos,
 * selects/loads a model, or treats the production 1536 preview as native input. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.ShikuangResearchInput=api;
})(typeof globalThis==='object'?globalThis:this,function(){
  'use strict';
  const PROFILE_ID='shikuang-research-native-roi-q16-torchf32-v1';
  const RESOURCE_PATH='research/'+PROFILE_ID+'/worker.js';
  const OUTPUT_BYTES=3*224*224*4;
  const forbidden=['src','photos','crop','cropPercent','legacyInput','manifest','researchManifest','models','modelId','modelPath'];
  const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
  const typed=Object.getPrototypeOf(Uint8Array.prototype);
  const getter=key=>Object.getOwnPropertyDescriptor(typed,key).get;
  const kind=getter(Symbol.toStringTag),buffer=getter('buffer'),offset=getter('byteOffset'),length=getter('byteLength');
  const bufferLength=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'byteLength').get;
  const stopped=()=>new DOMException('分析已停止','AbortError');
  function checkSignal(signal){if(signal?.aborted)throw stopped();}
  function byteStorage(rgba,expected){
    let store,bytes,backing,at,name;
    try{name=kind.call(rgba);store=buffer.call(rgba);at=offset.call(rgba);bytes=length.call(rgba);backing=bufferLength.call(store);}
    catch(_){throw new Error('研究输入需非共享真实RGBA字节数组');}
    if(!['Uint8Array','Uint8ClampedArray'].includes(name)||bytes!==expected||at!==0||backing!==expected||store.resizable===true)throw new Error('研究输入需独占且长度精确的native RGBA缓冲区');
    return store;
  }
  function validateRequest(options){
    if(!options||options.profileId!==PROFILE_ID||options.profileVersion!==1)throw new Error('必须显式选择精确的研究profile及版本');
    if(forbidden.some(key=>own(options,key)))throw new Error('研究输入禁止生产预览、中心裁切选项或模型加载参数');
    if(options.transferOwnership!==true)throw new Error('研究输入需显式transferOwnership；派发后原像素缓冲区将失效');
    const f=options.frame,h=f?.sourceHeader,l=options.limits,r=options.normalizedROI;
    if(!h||!Number.isSafeInteger(h.width)||!Number.isSafeInteger(h.height)||h.width<3||h.height<3||h.width>16384||h.height>16384||h.width*h.height>40000000)throw new Error('研究原图尺寸无效或超过4000万像素');
    if(!['file-photo','decoder-frame'].includes(h.kind)||typeof h.orientationEvidence!=='string'||!h.orientationEvidence.trim())throw new Error('研究输入缺少原尺寸头与方向证据');
    if(h.kind==='file-photo'&&(!Number.isInteger(h.exifOrientation)||h.exifOrientation<1||h.exifOrientation>8||h.headerCheckedBeforeDecode!==true))throw new Error('研究照片需先读取压缩头和实际EXIF方向');
    if(h.format!==undefined&&!['jpeg','png','webp'].includes(h.format)||h.profilePresent!==undefined&&typeof h.profilePresent!=='boolean'||h.headerEvidence!==undefined&&(typeof h.headerEvidence!=='string'||!h.headerEvidence.trim()))throw new Error('研究照片头部格式、ICC或读取器证据无效');
    if(h.kind==='decoder-frame'&&(h.exifOrientation!==undefined||h.frameOrientationApplied!==true))throw new Error('已呈现帧不能冒充照片EXIF');
    const turned=h.kind==='file-photo'&&h.exifOrientation>=5;
    if(f.width!==(turned?h.height:h.width)||f.height!==(turned?h.width:h.height)||f.stage!=='native-oriented-srgb-no-scale'||f.colorSpace!=='srgb'||f.orientationApplied!==true||f.priorResizeCount!==0||f.jpegRoundTripsCreated!==0||typeof f.decoderEvidence!=='string'||!f.decoderEvidence.trim())throw new Error('研究输入必须为原尺寸定向sRGB；禁止预缩、再JPEG或1536预览冒充native');
    const routes=['photo-camera','photo-file','video-camera-frame','video-file-frame','native-photo-camera','native-photo-file'];
    if(!routes.includes(f.route)||(f.route.startsWith('video-')&&h.kind!=='decoder-frame'))throw new Error('研究输入来源类型不符合照片/视频帧合同');
    const encoded=h.encodedBytes===undefined?0:h.encodedBytes;
    if(!Number.isSafeInteger(encoded)||encoded<0||encoded>20*1024*1024)throw new Error('研究照片字节预算无效');
    if(!l||!Number.isSafeInteger(l.inputMemoryBudgetBytes)||l.inputMemoryBudgetBytes<2097152||!Number.isSafeInteger(l.maxNativePixels)||l.maxNativePixels<9||l.maxNativePixels>40000000)throw new Error('研究输入需显式内存及原图像素预算');
    // Same frozen header reservation: four nominal native RGBA allocations and
    // 2 MiB working allowance. Transfer avoids a fifth full-size Worker clone.
    if(h.width*h.height>l.maxNativePixels||h.width*h.height*16+2097152+encoded>l.inputMemoryBudgetBytes)throw new Error('研究原图预算不足；不能默默预缩后继续');
    if(!r||!['x0','y0','x1','y1'].every(k=>Number.isFinite(r[k]))||r.x0<0||r.y0<0||r.x1>1||r.y1>1||r.x1<=r.x0||r.y1<=r.y0||Math.ceil(r.x1*f.width)-Math.floor(r.x0*f.width)<3||Math.ceil(r.y1*f.height)-Math.floor(r.y0*f.height)<3)throw new Error('研究输入需有效原尺寸normalized ROI，不能裁剪越界');
    if(options.timeoutMs!==undefined&&(!Number.isInteger(options.timeoutMs)||options.timeoutMs<1||options.timeoutMs>120000))throw new Error('研究输入整体上限需为1至120000毫秒');
    const store=byteStorage(f.rgba,f.width*f.height*4);
    // Snapshot metadata before asynchronous Worker bootstrap. Caller-owned
    // getters/functions and subsequent metadata edits cannot change this job.
    const frame={width:f.width,height:f.height,rgba:f.rgba,colorSpace:f.colorSpace,orientationApplied:true,stage:f.stage,priorResizeCount:0,jpegRoundTripsCreated:0,route:f.route,decoderEvidence:f.decoderEvidence,sourceHeader:{kind:h.kind,width:h.width,height:h.height,exifOrientation:h.exifOrientation,frameOrientationApplied:h.frameOrientationApplied,orientationEvidence:h.orientationEvidence,encodedBytes:encoded,headerCheckedBeforeDecode:h.headerCheckedBeforeDecode,format:h.format,profilePresent:h.profilePresent,headerEvidence:h.headerEvidence}};
    return {store,request:{type:'prepare-input',profileId:PROFILE_ID,profileVersion:1,frame,normalizedROI:{x0:r.x0,y0:r.y0,x1:r.x1,y1:r.y1},limits:{inputMemoryBudgetBytes:l.inputMemoryBudgetBytes,maxNativePixels:l.maxNativePixels}}};
  }
  function validateResult(result){
    if(!result||result.profileId!==PROFILE_ID||result.profileVersion!==1||result.contractId!=='shikuang-native-roi-q16-rgba8-torchf32-001'||result.normId!=='imagenet-rgb-stepwise-f32-div-sub-div-001'||result.algorithmVersion!=='shikuang-private-full-aspect-virtual-rgba8-q16-v3-003'||JSON.stringify(result.tensorShape)!=='[1,3,224,224]'||!(result.runtimeTensor instanceof Float32Array)||result.runtimeTensor.byteLength!==OUTPUT_BYTES||result.runtimeTensor.some(x=>!Number.isFinite(x))||result.modelRegistered!==false||result.modelForwards!==0||result.productionRegistration!==false)throw new Error('研究输入结果profile、张量或模型边界不匹配');
    return result;
  }
  function createClient(host){
    return Object.freeze({prepare(options){
      const signal=options?.signal;checkSignal(signal);
      const {store,request}=validateRequest(options);
      if(typeof host.Worker!=='function')throw new Error('当前环境不支持可取消的研究预处理Worker');
      return new Promise((resolve,reject)=>{
        let worker,settled=false,posted=false,timer,bootTimer;
        const finish=(error,result)=>{if(settled)return;settled=true;host.clearTimeout(timer);host.clearTimeout(bootTimer);signal?.removeEventListener('abort',cancel);if(worker){worker.onmessage=null;worker.onerror=null;worker.terminate();}error?reject(error):resolve(result);};
        const cancel=()=>finish(stopped());
        signal?.addEventListener('abort',cancel,{once:true});
        timer=host.setTimeout(()=>finish(new Error('研究输入准备超过整体上限，已停止；不会降质重试')),options.timeoutMs??120000);
        bootTimer=host.setTimeout(()=>finish(new Error('研究预处理线程启动超过15秒，请重试')),15000);
        try{
          worker=new host.Worker(host.resourceURL(RESOURCE_PATH));
          if(settled){worker.terminate();return;}
          worker.onerror=event=>finish(new Error('研究预处理线程失败：'+String(event.message||'未知错误').slice(0,180)));
          worker.onmessage=({data})=>{
            if(settled)return;
            try{
              if(data.type==='ready'){
                if(data.profileId!==PROFILE_ID||data.profileVersion!==1)throw new Error('研究预处理线程profile版本不匹配');
                host.clearTimeout(bootTimer);checkSignal(signal);
                if(!posted){posted=true;worker.postMessage(request,[store]);}
              }else if(data.type==='result'){if(!posted)throw new Error('研究线程未接收输入');checkSignal(signal);finish(null,validateResult(data.result));}
              else if(data.type==='error'||data.type==='boot-error')throw new Error(String(data.message||'研究预处理失败'));
            }catch(error){finish(error);}
          };
          // Covers an abort synchronously triggered while constructing a host Worker.
          if(signal?.aborted)cancel();
        }catch(error){finish(error);}
      });
    }});
  }
  return Object.freeze({PROFILE_ID,PROFILE_VERSION:1,RESOURCE_PATH,validateRequest,validateResult,createClient});
});
