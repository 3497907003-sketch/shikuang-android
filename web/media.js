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
  // Only IFD0 controls the full JPEG. Neutralize every IFD0 orientation value
  // before decoding, so old and automatically orienting decoders see the same
  // encoded raster. Never trust TIFF offsets outside their own APP1 segment.
  function jpegOrientation(buffer){
    const bytes=buffer instanceof Uint8Array?buffer:new Uint8Array(buffer),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    const invalid=()=>new Error('JPEG / EXIF 头部不完整或无效，请转换照片后重试');
    if(bytes.length>HEADER_BYTES||bytes[0]!==255||bytes[1]!==216)throw invalid();
    let offset=2,orientation=1,seen=false;const positions=[];
    while(offset<bytes.length){
      if(bytes[offset++]!==255)throw invalid();
      while(bytes[offset]===255)offset++;
      const marker=bytes[offset++];
      if(marker===1||(marker>=208&&marker<=215))continue;
      if(marker===0||marker===216||marker===217||offset+2>bytes.length)throw invalid();
      const size=view.getUint16(offset),end=offset+size;
      if(size<2||end>bytes.length)throw invalid();
      if(marker===218)return {orientation,positions};
      const start=offset+2;
      if(marker===225&&end-start>=4&&String.fromCharCode(...bytes.slice(start,start+4))==='Exif'){
        if(end-start<14||bytes[start+4]!==0||bytes[start+5]!==0)throw invalid();
        const tiff=start+6,little=bytes[tiff]===73&&bytes[tiff+1]===73;
        if(!little&&!(bytes[tiff]===77&&bytes[tiff+1]===77))throw invalid();
        if(view.getUint16(tiff+2,little)!==42)throw invalid();
        let next=view.getUint32(tiff+4,little),first=true;const visited=new Set();if(!next)throw invalid();
        while(next){
          if(next<8||next>end-tiff-2||visited.has(next)||visited.size>=64)throw invalid();
          visited.add(next);const ifd=tiff+next,count=view.getUint16(ifd,little),tail=ifd+2+12*count;
          if(tail+4>end)throw invalid();
          for(let i=0;i<count;i++){
            const entry=ifd+2+i*12,tag=view.getUint16(entry,little),type=view.getUint16(entry+2,little),n=view.getUint32(entry+4,little);
            const units=[0,1,1,2,4,8,1,1,2,4,8,4,8,4],unit=units[type];
            // Unknown manufacturer types are not read. Known out-of-line data
            // must still be contained in this TIFF, including thumbnail fields.
            if(unit&&unit*n>4){const data=view.getUint32(entry+8,little);if(data<8||data>end-tiff-unit*n)throw invalid();}
            if(first&&tag===274){
              if(type!==3||n!==1)throw invalid();
              const value=view.getUint16(entry+8,little);if(value<1||value>8||(seen&&value!==orientation))throw invalid();
              orientation=value;seen=true;positions.push({offset:entry+8,little});
            }
          }
          next=view.getUint32(tail,little);first=false;
        }
      }
      offset=end;
    }
    throw invalid(); // SOS was not within the bounded header.
  }
  function orientationTransform(orientation,width,height){
    const transforms={1:[1,0,0,1,0,0],2:[-1,0,0,1,width,0],3:[-1,0,0,-1,width,height],4:[1,0,0,-1,0,height],5:[0,1,1,0,0,0],6:[0,1,-1,0,height,0],7:[0,-1,-1,0,height,width],8:[0,-1,1,0,0,width]};
    if(!transforms[orientation])throw new Error('EXIF 方向无效');return transforms[orientation];
  }
  function photoError(){const e=new Error('图片读取已停止');e.name='AbortError';return e;}
  async function photoTask(signal,work){
    const controller=new AbortController(),deadline=Date.now()+15000,cleanups=[];
    let rejectStop,closed=false,expired=false;
    const stopped=new Promise((_,reject)=>{rejectStop=reject;});
    const cancel=()=>{controller.abort();rejectStop(photoError());};
    const timer=setTimeout(()=>{expired=true;controller.abort();rejectStop(new Error('图片读取超时，请换用 JPEG 或 PNG'));},15000);
    const job={signal:controller.signal,cleanup:fn=>cleanups.push(fn),check(){if(expired||Date.now()>=deadline)throw new Error('图片读取超时，请换用 JPEG 或 PNG');if(closed||signal?.aborted||controller.signal.aborted)throw photoError();},async wait(value){const result=await Promise.race([value,stopped]);job.check();return result;}};
    signal?.addEventListener('abort',cancel,{once:true});
    try{if(signal?.aborted)throw photoError();const result=await job.wait(work(job));job.accepted=true;return result;}
    finally{closed=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);controller.abort();for(const cleanup of cleanups.reverse())try{cleanup();}catch(_){} }
  }
  async function blobBytes(blob,limit,job){
    job.check();if(Number.isFinite(blob.size)&&blob.size>limit)throw new Error('照片数据超过安全读取上限');
    let buffer;
    if(typeof blob.arrayBuffer==='function')buffer=await job.wait(blob.arrayBuffer());
    else buffer=await job.wait(new Promise((resolve,reject)=>{
      const reader=new FileReader();job.cleanup(()=>{reader.onload=reader.onerror=reader.onabort=null;if(reader.readyState===1)reader.abort();});
      reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('照片文件无法读取，请重新选择'));reader.onabort=()=>reject(photoError());reader.readAsArrayBuffer(blob);
    }));
    if(buffer.byteLength>limit)throw new Error('照片数据超过安全读取上限');return new Uint8Array(buffer);
  }
  async function sourceBytes(src,job){
    job.check();
    if(src&&typeof src==='object'&&typeof src.slice==='function'){
      if(!Number.isFinite(src.size)||src.size<=0||src.size>MAX_IMAGE_BYTES)throw new Error('单张照片超过 20 MB 或文件无效');
      return blobBytes(src,MAX_IMAGE_BYTES,job);
    }
    if(typeof src!=='string'||!src)throw new Error('照片地址无效，请重新选择');
    if(src.startsWith('data:')){
      const comma=src.indexOf(',');if(comma<0||!/^data:image\/(?:jpeg|png|webp);base64$/i.test(src.slice(0,comma)))throw new Error('照片格式无效，请转换为 JPEG、PNG 或 WebP');
      const data=src.slice(comma+1);if(data.length>4*Math.ceil(MAX_IMAGE_BYTES/3))throw new Error('单张照片超过 20 MB，请降低分辨率后重试');
      if(!data.length||data.length%4||!/^[a-z\d+/]*={0,2}$/i.test(data))throw new Error('照片数据不完整，请重新选择');
      const raw=atob(data);if(raw.length>MAX_IMAGE_BYTES)throw new Error('单张照片超过 20 MB，请降低分辨率后重试');
      const bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);job.check();return bytes;
    }
    let response;try{response=await job.wait(fetch(src,{signal:job.signal}));}catch(error){job.check();throw new Error('照片文件无法读取，请重新选择');}
    job.cleanup(()=>{if(response.body&&!response.body.locked)void response.body.cancel().catch(()=>{});});
    if(!response.ok)throw new Error(`照片文件读取失败 (${response.status})`);
    const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>MAX_IMAGE_BYTES))throw new Error('单张照片超过 20 MB 或大小无效');
    if(!response.body||typeof response.body.getReader!=='function')throw new Error('当前环境无法安全读取照片，请使用照片文件或更新 WebView');
    const reader=response.body.getReader(),chunks=[];let size=0,finished=false;
    job.cleanup(()=>{if(!finished)void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch(_){}chunks.length=0;});
    while(true){const item=await job.wait(reader.read());if(item.done){finished=true;break;}size+=item.value.byteLength;if(size>MAX_IMAGE_BYTES)throw new Error('单张照片超过 20 MB，请降低分辨率后重试');chunks.push(item.value);}
    if(!size||(length!==null&&size!==Number(length)))throw new Error('照片数据不完整，请重新选择');
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}chunks.length=0;return bytes;
  }
  async function validatePhotoFile(file,{signal}={}){
    return photoTask(signal,async job=>{
      if(!file||!Number.isFinite(file.size)||file.size<=0||typeof file.slice!=='function')throw new Error('照片文件无效，请重新选择');
      if(file.size>MAX_IMAGE_BYTES)throw new Error('单张照片超过 20 MB，请降低分辨率后重试');
      return imageDimensions(await blobBytes(file.slice(0,Math.min(file.size,HEADER_BYTES)),HEADER_BYTES,job));
    });
  }
  async function decodePhoto(src,{signal}={}){
    return photoTask(signal,async job=>{
      let bytes=await sourceBytes(src,job);job.check();
      const header=bytes.subarray(0,HEADER_BYTES),dimensions=imageDimensions(header);
      const exif=dimensions.format==='jpeg'?jpegOrientation(header):{orientation:1,positions:[]};
      for(const position of exif.positions)new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).setUint16(position.offset,1,position.little);
      job.check();
      const url=URL.createObjectURL(new Blob([bytes],{type:'image/'+dimensions.format}));bytes=null;
      let revoked=false;const revoke=()=>{if(!revoked){revoked=true;URL.revokeObjectURL(url);}};job.cleanup(revoke);
      const img=new Image();let returned=false;job.cleanup(()=>{if(!returned||!job.accepted)img.src='';});img.src=url;
      try{await job.wait(img.decode());}catch(error){job.check();throw new Error('照片无法解码，请重新拍摄或转换为 JPEG 或 PNG');}revoke();scaledDimensions(img.naturalWidth,img.naturalHeight,'照片');
      if(dimensions.format==='jpeg'&&(img.naturalWidth!==dimensions.width||img.naturalHeight!==dimensions.height))throw new Error('照片解码尺寸与原始方向不符，请转换照片后重试');
      if(exif.orientation===1){returned=true;return img;}
      const swap=exif.orientation>=5,width=swap?dimensions.height:dimensions.width,height=swap?dimensions.width:dimensions.height;
      const output=scaledDimensions(width,height,'照片'),canvas=document.createElement('canvas');canvas.width=output.width;canvas.height=output.height;job.cleanup(()=>{canvas.width=canvas.height=0;});
      const context=canvas.getContext('2d');if(!context)throw new Error('当前环境无法调整照片方向');
      const [a,b,c,d,e,f]=orientationTransform(exif.orientation,dimensions.width,dimensions.height),sx=output.width/width,sy=output.height/height;
      context.setTransform(a*sx,b*sy,c*sx,d*sy,e*sx,f*sy);context.drawImage(img,0,0);job.check();
      const normalized=canvas.toDataURL('image/png');img.src='';job.check();
      const upright=new Image();let keep=false;job.cleanup(()=>{if(!keep||!job.accepted)upright.src='';});upright.src=normalized;
      try{await job.wait(upright.decode());}catch(error){job.check();throw new Error('照片方向调整失败，请重新选择');}if(upright.naturalWidth!==output.width||upright.naturalHeight!==output.height)throw new Error('照片方向调整失败，请重新选择');keep=true;return upright;
    });
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
  return {validatePhotoFile,imageDimensions,jpegOrientation,orientationTransform,decodePhoto,scaledDimensions,validateVideo,frameTimes,extractVideo};
});
