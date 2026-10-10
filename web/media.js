(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.MineralMedia=api;})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  const MAX_IMAGE_PIXELS=40000000,MAX_IMAGE_EDGE=1536,MAX_IMAGE_BYTES=20*1024*1024,HEADER_BYTES=512*1024;
  function scaledDimensions(width,height,label='图像'){
    if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<=0||height<=0)throw new Error(`${label}尺寸无效，请重新拍摄或选择其他文件`);
    if(width*height>MAX_IMAGE_PIXELS)throw new Error(`${label}分辨率超过 4000 万像素，请降低分辨率后重试`);
    const scale=Math.min(1,MAX_IMAGE_EDGE/Math.max(width,height));
    return {width:Math.max(1,Math.round(width*scale)),height:Math.max(1,Math.round(height*scale))};
  }
  // Read compressed headers before allocating a decoded image or large Canvas.
  // Unknown/oversized headers fail closed; filename/MIME alone are not evidence.
  function imageDimensions(buffer){
    const bytes=buffer instanceof Uint8Array?buffer:new Uint8Array(buffer),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),length=bytes.length;
    const text=(offset,size)=>String.fromCharCode(...bytes.slice(offset,offset+size));
    let width,height,format;
    if(length>=24&&[137,80,78,71,13,10,26,10].every((byte,i)=>bytes[i]===byte)&&text(12,4)==='IHDR'&&view.getUint32(8)===13){
      width=view.getUint32(16);height=view.getUint32(20);format='png';
    }else if(length>=4&&bytes[0]===255&&bytes[1]===216){
      let offset=2;
      while(offset+3<length){
        if(bytes[offset++]!==255)break;
        while(offset<length&&bytes[offset]===255)offset++;
        const marker=bytes[offset++];
        if(marker===217||marker===218)break;
        if(marker===1||(marker>=208&&marker<=215))continue;
        if(offset+2>length)break;
        const segmentLength=view.getUint16(offset);
        if(segmentLength<2)break;
        if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){
          if(segmentLength<8||offset+7>length)break;
          height=view.getUint16(offset+3);width=view.getUint16(offset+5);format='jpeg';break;
        }
        offset+=segmentLength;
      }
    }else if(length>=20&&text(0,4)==='RIFF'&&text(8,4)==='WEBP'){
      let offset=12;
      while(offset+8<=length){
        const kind=text(offset,4),size=view.getUint32(offset+4,true),payload=offset+8;
        if(kind==='VP8X'&&size>=10&&payload+10<=length){
          width=1+bytes[payload+4]+bytes[payload+5]*256+bytes[payload+6]*65536;
          height=1+bytes[payload+7]+bytes[payload+8]*256+bytes[payload+9]*65536;format='webp';break;
        }
        if(kind==='VP8L'&&size>=5&&payload+5<=length&&bytes[payload]===47){
          const bits=view.getUint32(payload+1,true);width=(bits&16383)+1;height=((bits>>>14)&16383)+1;format='webp';break;
        }
        if(kind==='VP8 '&&size>=10&&payload+10<=length&&!(bytes[payload]&1)&&bytes[payload+3]===157&&bytes[payload+4]===1&&bytes[payload+5]===42){
          width=view.getUint16(payload+6,true)&16383;height=view.getUint16(payload+8,true)&16383;format='webp';break;
        }
        offset=payload+size+(size%2);
      }
    }
    if(!format)throw new Error('无法安全读取照片尺寸，请转换为 JPEG、PNG 或 WebP 后重试');
    scaledDimensions(width,height,'照片');return {width,height,format};
  }
  async function validatePhotoFile(file,{signal}={}){
    checkAbort(signal);
    if(!file||!Number.isFinite(file.size)||file.size<=0||typeof file.slice!=='function')throw new Error('照片文件无效，请重新选择');
    if(file.size>MAX_IMAGE_BYTES)throw new Error('单张照片超过 20 MB，请降低分辨率后重试');
    const blob=file.slice(0,Math.min(file.size,HEADER_BYTES));
    const buffer=typeof blob.arrayBuffer==='function'?await blob.arrayBuffer():await new Promise((resolve,reject)=>{
      const reader=new FileReader(),cancel=()=>reader.abort();
      const finish=(error,value)=>{signal?.removeEventListener('abort',cancel);reader.onload=reader.onerror=reader.onabort=null;error?reject(error):resolve(value);};
      reader.onload=()=>finish(null,reader.result);reader.onerror=()=>finish(new Error('照片文件无法读取，请重新选择'));reader.onabort=()=>finish(abortError());signal?.addEventListener('abort',cancel,{once:true});reader.readAsArrayBuffer(blob);
    });
    checkAbort(signal);return imageDimensions(buffer);
  }
  function validateVideo(file){if(!file||(!String(file.type).startsWith('video/')&&!/\.(mp4|webm|mov|m4v)$/i.test(file.name||'')))throw new Error('视频入口仅接受 MP4、WebM 或设备可解码的视频');if(file.size>100*1024*1024)throw new Error('视频超过 100 MB，请剪短后重试');}
  function frameTimes(duration){if(!Number.isFinite(duration)||duration<=0||duration>90)throw new Error('请选择 90 秒以内的短视频');return duration<0.5?[duration/2]:[.15,.5,.85].map(x=>duration*x);}
  const abortError=()=>{const error=new Error('视频取帧已停止');error.name='AbortError';return error;};
  function checkAbort(signal){if(signal?.aborted)throw abortError();}
  function event(target,name,timeout=15000,signal){return new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(abortError());return;}
    let finished=false;
    const timer=setTimeout(()=>finish(new Error('视频读取超时，请换用 MP4 格式')),timeout);
    const done=()=>finish(),fail=()=>finish(new Error('视频无法解码，请换用 MP4 格式')),cancel=()=>finish(abortError());
    function finish(error){if(finished)return;finished=true;clearTimeout(timer);target.removeEventListener(name,done);target.removeEventListener('error',fail);signal?.removeEventListener('abort',cancel);error?reject(error):resolve();}
    target.addEventListener(name,done,{once:true});target.addEventListener('error',fail,{once:true});signal?.addEventListener('abort',cancel,{once:true});
  });}
  async function extractVideo(file,report=()=>{},{signal}={}){
    checkAbort(signal);
    validateVideo(file);const url=URL.createObjectURL(file),video=document.createElement('video');
    video.preload='auto';video.muted=true;video.playsInline=true;
    try{const ready=event(video,'loadedmetadata',15000,signal);video.src=url;video.load();await ready;checkAbort(signal);
      if(video.duration===Infinity){const end=event(video,'seeked',15000,signal);video.currentTime=1e7;await end;checkAbort(signal);}
      const dimensions=scaledDimensions(video.videoWidth,video.videoHeight,'视频');
      const times=frameTimes(video.duration),frames=[];
      const canvas=document.createElement('canvas');canvas.width=dimensions.width;canvas.height=dimensions.height;
      for(let i=0;i<times.length;i++){checkAbort(signal);report(`提取视频帧 ${i+1}/${times.length}…`);checkAbort(signal);const seek=event(video,'seeked',15000,signal);video.currentTime=times[i];await seek;checkAbort(signal);canvas.getContext('2d').drawImage(video,0,0,canvas.width,canvas.height);const src=canvas.toDataURL('image/jpeg',.9);if(!frames.some(x=>x.src===src))frames.push({src,kind:'video',time:times[i]});}
      if(!frames.length)throw new Error('视频未提供可读取的帧');return {frames,duration:video.duration,name:file.name};
    }finally{video.pause();video.removeAttribute('src');video.load();URL.revokeObjectURL(url);}
  }
  return {validatePhotoFile,imageDimensions,scaledDimensions,validateVideo,frameTimes,extractVideo};
});
