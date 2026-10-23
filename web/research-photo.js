/* Explicit encoded-photo provider for research input only. This follows the
 * canonical30 HTMLImageElement -> native sRGB Canvas path. It never calls the
 * production preview decoder, resizes, re-encodes, or loads a model. */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory(require('./research/shikuang-research-native-roi-q16-torchf32-v1/encoded-header.js'),require('./research-input.js'));
  else root.ShikuangResearchPhoto=factory(root.ShikuangEncodedHeader,root.ShikuangResearchInput);
})(typeof globalThis==='object'?globalThis:this,function(Header,Input){
  'use strict';
  const ID='shikuang-browser-native-srgb-research-photo-v1';
  const routes=['photo-camera','photo-file','native-photo-camera','native-photo-file'];
  const stopped=()=>new DOMException('研究照片输入已停止','AbortError');
  function request(options){
    if(!options||options.profileId!==Input.PROFILE_ID||options.profileVersion!==1)throw new Error('研究照片需显式选择精确profile及版本');
    if(['frame','src','photos','crop','cropPercent','legacyInput','manifest','researchManifest','models','modelId','modelPath'].some(key=>Object.prototype.hasOwnProperty.call(options,key)))throw new Error('研究照片只接受encodedPhoto Blob及原尺寸ROI，禁止生产预览或模型选项');
    if(options.transferOwnership!==true)throw new Error('研究照片需显式移交native像素所有权');
    if(!routes.includes(options.route))throw new Error('研究照片需明确相机或照片文件来源；视频另用帧合同');
    const l=options.limits,r=options.normalizedROI;
    if(!l||!Number.isSafeInteger(l.inputMemoryBudgetBytes)||l.inputMemoryBudgetBytes<2097152||!Number.isSafeInteger(l.maxNativePixels)||l.maxNativePixels<9||l.maxNativePixels>40000000)throw new Error('研究照片需显式内存和像素预算');
    if(!r||!['x0','y0','x1','y1'].every(k=>Number.isFinite(r[k]))||r.x0<0||r.y0<0||r.x1>1||r.y1>1||r.x1<=r.x0||r.y1<=r.y0)throw new Error('研究照片需有效原尺寸normalized ROI');
    const timeoutMs=options.timeoutMs??120000;
    if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000)throw new Error('研究照片整体上限需为1至120000毫秒');
    return {profileId:Input.PROFILE_ID,profileVersion:1,transferOwnership:true,route:options.route,normalizedROI:{x0:r.x0,y0:r.y0,x1:r.x1,y1:r.y1},limits:{inputMemoryBudgetBytes:l.inputMemoryBudgetBytes,maxNativePixels:l.maxNativePixels},timeoutMs,signal:options.signal,encodedPhoto:options.encodedPhoto};
  }
  function createClient(host){
    function job(options,work){
      const o=request(options),signal=o.signal;
      if(signal?.aborted)throw stopped();
      if(!(o.encodedPhoto instanceof host.Blob)||o.encodedPhoto.size<12||o.encodedPhoto.size>20*1048576)throw new Error('研究照片需不超过20MiB的不可变encoded Blob');
      const controller=new AbortController(),deadline=Date.now()+o.timeoutMs;
      return new Promise((resolve,reject)=>{
        let settled=false,timer;const cleanups=[];
        const finish=(error,value)=>{if(settled)return;settled=true;host.clearTimeout(timer);signal?.removeEventListener('abort',cancel);controller.abort();for(const cleanup of cleanups.reverse())try{cleanup();}catch(_){}error?reject(error):resolve(value);};
        const cancel=()=>finish(stopped());
        const check=()=>{if(signal?.aborted||controller.signal.aborted)throw stopped();if(Date.now()>=deadline)throw new Error('研究照片输入超过整体上限，已停止；不会预缩重试');};
        signal?.addEventListener('abort',cancel,{once:true});
        timer=host.setTimeout(()=>finish(new Error('研究照片输入超过整体上限，已停止；不会预缩重试')),o.timeoutMs);
        const context={signal:controller.signal,check,cleanup:fn=>cleanups.push(fn),remaining:()=>Math.max(1,deadline-Date.now())};
        Promise.resolve().then(()=>{check();return work(o,context);}).then(v=>{try{check();finish(null,v);}catch(e){finish(e);}},e=>finish(e));
      });
    }
    async function decode(o,j){
      const h=await Header.inspect(o.encodedPhoto,{signal:j.signal,timeoutMs:Math.min(5000,j.remaining())});j.check();
      // This is the same nominal four-native-RGBA reservation as the frozen
      // entry. It is checked before Image/object URL or Canvas allocation.
      const reservationBytes=h.width*h.height*16+2097152+h.encodedBytes;
      if(h.width*h.height>o.limits.maxNativePixels||reservationBytes>o.limits.inputMemoryBudgetBytes)throw new Error('研究原图解码预算不足；不能预缩后冒充native');
      const swap=h.exifOrientation>=5,width=swap?h.height:h.width,height=swap?h.width:h.height;
      const r=o.normalizedROI;
      if(Math.ceil(r.x1*width)-Math.floor(r.x0*width)<3||Math.ceil(r.y1*height)-Math.floor(r.y0*height)<3)throw new Error('研究照片native ROI短边不足3像素');
      const url=host.URL.createObjectURL(o.encodedPhoto);j.cleanup(()=>host.URL.revokeObjectURL(url));
      const image=new host.Image();j.cleanup(()=>image.removeAttribute('src'));
      image.src=url;
      let decodeTimer,cancelDecode;
      try{
        await Promise.race([image.decode(),new Promise((_,reject)=>{decodeTimer=host.setTimeout(()=>reject(new Error('研究照片native解码超过15秒')),Math.min(15000,j.remaining()));cancelDecode=()=>reject(stopped());j.signal.addEventListener('abort',cancelDecode,{once:true});})]);
      }finally{host.clearTimeout(decodeTimer);j.signal.removeEventListener('abort',cancelDecode);}
      j.check();
      if(!image.complete||image.naturalWidth!==width||image.naturalHeight!==height)throw new Error('实际native解码尺寸与定向压缩头不符；不会缩放补救');
      const canvas=host.document.createElement('canvas');canvas.width=width;canvas.height=height;j.cleanup(()=>{canvas.width=canvas.height=1;});
      const ctx=canvas.getContext('2d',{willReadFrequently:true,colorSpace:'srgb'});
      if(!ctx)throw new Error('无法创建原尺寸sRGB研究画布');
      ctx.drawImage(image,0,0,width,height); // intrinsic dimensions exactly, 1:1
      const pixels=ctx.getImageData(0,0,width,height),colorSpace=pixels.colorSpace||ctx.getContextAttributes?.().colorSpace;
      if(colorSpace!=='srgb')throw new Error('浏览器不能确认native sRGB像素，研究输入停止');
      j.check();
      const frame={width,height,rgba:pixels.data,colorSpace:'srgb',orientationApplied:true,stage:'native-oriented-srgb-no-scale',priorResizeCount:0,jpegRoundTripsCreated:0,route:o.route,decoderEvidence:ID+'; HTMLImageElement.decode once; EXIF by browser decoder exactly once; observedCanvasColorSpace='+colorSpace+'; nativeDrawDimensions='+width+'x'+height,sourceHeader:h};
      // Validate exclusive byte ownership and all metadata before returning it.
      Input.validateRequest({...o,frame});return frame;
    }
    return Object.freeze({
      decodePhoto:options=>job(options,(o,j)=>decode(o,j)),
      prepare:options=>job(options,async(o,j)=>{
        const frame=await decode(o,j);j.check();
        if(!host.inputClient)throw new Error('研究预处理Worker客户端缺失');
        return host.inputClient.prepare({profileId:o.profileId,profileVersion:1,transferOwnership:true,frame,normalizedROI:o.normalizedROI,limits:o.limits,signal:j.signal,timeoutMs:j.remaining()});
      })
    });
  }
  return Object.freeze({ID,createClient});
});
