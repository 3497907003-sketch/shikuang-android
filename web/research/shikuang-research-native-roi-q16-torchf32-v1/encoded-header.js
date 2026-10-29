/* Bounded, seekable compressed-header inspection; no image decode or resize.
 * JPEG headers are walked to SOS, PNG/WebP chunk directories to their end.
 * Large pixel payloads are skipped using Blob.slice offsets, not materialized.
 */
(function(root,factory){
 const api=factory(),commonJS=typeof module==='object'&&module&&module.exports;
 if(commonJS)module.exports=api;
 if(typeof window==='object'&&window||!commonJS)root.ShikuangEncodedHeader=api;
})(typeof window==='object'&&window?window:typeof globalThis==='object'?globalThis:this,function(){
 'use strict';
 const ID='shikuang-encoded-native-header-seek002',MAX_BYTES=20*1024*1024,MAX_READ=512*1024,MAX_REQUESTS=512,MAX_CHUNKS=4096;
 const fail=m=>{throw new Error(m);},abort=()=>{const e=new Error('照片输入已停止');e.name='AbortError';return e;};
 const txt=(a,o,n)=>String.fromCharCode(...a.subarray(o,o+n));
 const view=a=>new DataView(a.buffer,a.byteOffset,a.byteLength);
 function exifOrientation(payload){
  let a=payload;
  if(a.length>=6&&txt(a,0,6)==='Exif\0\0')a=a.subarray(6);
  if(a.length<8)fail('Exif 头不完整，不能猜测方向');
  const endian=txt(a,0,2),le=endian==='II',v=view(a);
  if(!['II','MM'].includes(endian)||v.getUint16(2,le)!==42)fail('Exif TIFF 格式不支持');
  const off=v.getUint32(4,le);
  if(off<8||off+2>a.length)fail('Exif IFD0 越界');
  const count=v.getUint16(off,le);
  if(count>2048||off+2+count*12+4>a.length)fail('Exif IFD0 不完整或过大');
  let result=null;
  for(let i=0;i<count;i++){
   const p=off+2+i*12;
   if(v.getUint16(p,le)!==0x112)continue;
   if(v.getUint16(p+2,le)!==3||v.getUint32(p+4,le)!==1)fail('Exif 方向类型或计数无效');
   const value=v.getUint16(p+8,le);
   if(value<1||value>8)fail('Exif 方向不在 1–8 范围');
   // Redundant identical valid entries in this IFD0 have one direction.
   // Conflicts and additional Exif APP1 blocks remain rejected.
   if(result!==null&&result!==value)fail('Exif 方向重复且冲突');
   result=value;
  }
  return {orientation:result===null?1:result,tagPresent:result!==null};
 }
 async function inspect(blob,{signal,timeoutMs=5000}={}){
  if(!blob||!Number.isSafeInteger(blob.size)||blob.size<12||blob.size>MAX_BYTES||typeof blob.slice!=='function')fail('照片需为不超过 20 MiB 的 JPEG、PNG 或 WebP 文件');
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>15000)fail('照片头检查限时无效');
  const started=Date.now(),deadline=started+timeoutMs;
  let readBytes=0,requests=0,chunks=0;
  const check=()=>{if(signal?.aborted)throw abort();if(Date.now()>=deadline)fail('照片头检查超时');};
  async function read(offset,length){
   check();
   if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||length<1||offset<0||offset+length>blob.size)fail('压缩照片头越界或截断');
   if(readBytes+length>MAX_READ||requests+1>MAX_REQUESTS)fail('照片头超过有界检查预算，请转换格式后重试');
   readBytes+=length;requests++;
   const part=blob.slice(offset,offset+length);
   if(part.size!==length||typeof part.arrayBuffer!=='function')fail('需要可有界读取的不可变 Blob');
   let timer,cancel;
   const stopped=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('照片头检查超时')),Math.max(1,deadline-Date.now()));cancel=()=>reject(abort());signal?.addEventListener('abort',cancel,{once:true});});
   try{
    const b=await Promise.race([part.arrayBuffer(),stopped]);check();
    if(!(b instanceof ArrayBuffer)||b.byteLength!==length)fail('照片头读取长度不一致');
    return new Uint8Array(b);
   }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
  }
  const bump=()=>{check();if(++chunks>MAX_CHUNKS)fail('照片块目录过多');};
  const sig=await read(0,12);let format,width,height,orientation=1,orientationEvidence,profilePresent=false,orientationSeen=false;
  const setExif=(payload,where)=>{if(orientationSeen)fail('多份 Exif 元数据不能安全合并');const ex=exifOrientation(payload);orientation=ex.orientation;orientationEvidence=where+(ex.tagPresent?':IFD0_Orientation':':IFD0_no_Orientation_default1');orientationSeen=true;};
  if(sig[0]===255&&sig[1]===216){
   format='jpeg';let offset=2,foundSOS=false;
   while(offset<blob.size){
    bump();let markerHead=await read(offset,2);
    if(markerHead[0]!==255)fail('JPEG 标记无效');
    while(markerHead[1]===255){offset++;markerHead=await read(offset,2);}
    const marker=markerHead[1];offset+=2;
    if(marker===0||marker===216)fail('JPEG 头标记无效');
    if(marker===217)break;
    if(marker===1||(marker>=208&&marker<=215))continue;
    const lenBytes=await read(offset,2),len=view(lenBytes).getUint16(0);
    if(len<2||offset+len>blob.size)fail('JPEG 段长度无效');
    if(marker===218){if(!width)fail('JPEG 扫描前无尺寸');foundSOS=true;break;}
    if([192,193,194].includes(marker)){
     if(width)fail('JPEG 多帧尺寸不支持');
     const a=await read(offset+2,Math.min(len-2,6));
     if(a.length!==6||a[0]!==8||len!==8+3*a[5])fail('JPEG 仅支持 8 位单帧基线/渐进照片');
     height=view(a).getUint16(1);width=view(a).getUint16(3);
    }else if(marker>=192&&marker<=207&&![196,200,204].includes(marker))fail('此 JPEG 编码需先转换为常规 8 位照片');
    if(marker===225&&len>=8){
     const prefix=await read(offset+2,6);
     if(txt(prefix,0,6)==='Exif\0\0')setExif(await read(offset+2,len-2),'JPEG_APP1_Exif');
    }
    if(marker===226&&len>=14){const prefix=await read(offset+2,12);if(txt(prefix,0,12)==='ICC_PROFILE\0')profilePresent=true;}
    offset+=len;
   }
   if(!foundSOS||!width||!height)fail('JPEG 头不完整');
   if(!orientationSeen)orientationEvidence='JPEG_all_preSOS_APP1_scanned_no_Exif_default1';
  }else if([137,80,78,71,13,10,26,10].every((n,i)=>sig[i]===n)){
   format='png';let offset=8,hasData=false,ended=false;
   while(offset<blob.size){
    bump();const a=await read(offset,8),n=view(a).getUint32(0),kind=txt(a,4,4),end=offset+12+n;
    if(n>0x7fffffff||end>blob.size)fail('PNG 块长度无效');
    if(offset===8){if(kind!=='IHDR'||n!==13)fail('PNG 缺少标准 IHDR');const q=await read(offset+8,13);width=view(q).getUint32(0);height=view(q).getUint32(4);}
    else if(kind==='IHDR')fail('PNG 多份尺寸头无效');
    if(['acTL','fcTL','fdAT'].includes(kind))fail('动态 PNG 请通过视频入口取帧，不能冒充单张照片');
    if(kind==='eXIf')setExif(await read(offset+8,n),'PNG_eXIf');
    if(kind==='iCCP')profilePresent=true;
    if(kind==='IDAT')hasData=true;
    if(kind==='IEND'){if(n!==0||end!==blob.size)fail('PNG 尾部无效');ended=true;break;}
    offset=end;
   }
   if(!ended||!hasData||!width||!height)fail('PNG 块目录不完整');
   if(!orientationSeen)orientationEvidence='PNG_complete_chunk_directory_no_eXIf_default1';
   if(orientation!==1)fail('带非标准方向的 PNG 请先转换为已正确旋转的 JPEG，避免浏览器方向解释不同');
  }else if(txt(sig,0,4)==='RIFF'&&txt(sig,8,4)==='WEBP'){
   format='webp';const end=view(sig).getUint32(4,true)+8;
   if(end!==blob.size)fail('WebP RIFF 长度不一致');
   let offset=12,bitstream=false,extended=false,flags=0;
   while(offset<end){
    bump();const a=await read(offset,8),kind=txt(a,0,4),n=view(a).getUint32(4,true),p=offset+8,next=p+n+(n%2);
    if(next>end)fail('WebP 块长度无效');
    if(kind==='VP8X'){
     if(offset!==12||n!==10||extended)fail('WebP 扩展头无效');
     const q=await read(p,10);flags=q[0];extended=true;
     if(flags&2)fail('动态 WebP 请通过视频入口取帧');
     width=1+q[4]+q[5]*256+q[6]*65536;height=1+q[7]+q[8]*256+q[9]*65536;
    }
    if(['ANIM','ANMF'].includes(kind))fail('动态 WebP 请通过视频入口取帧');
    if(kind==='VP8 '||kind==='VP8L'){
     if(bitstream)fail('WebP 多帧位流不支持');bitstream=true;
     const q=await read(p,kind==='VP8L'?5:10);let bw,bh;
     if(n<q.length)fail('WebP 位流头截断');
     if(kind==='VP8L'){if(q[0]!==47)fail('WebP VP8L 标记无效');const bits=view(q).getUint32(1,true);bw=(bits&16383)+1;bh=((bits>>>14)&16383)+1;}
     else{if((q[0]&1)||q[3]!==157||q[4]!==1||q[5]!==42)fail('WebP VP8 标记无效');bw=view(q).getUint16(6,true)&16383;bh=view(q).getUint16(8,true)&16383;}
     if(!extended){width=bw;height=bh;}else if(width!==bw||height!==bh)fail('WebP 画布与位流尺寸冲突');
    }
    if(kind==='EXIF')setExif(await read(p,n),'WebP_EXIF');
    if(kind==='ICCP')profilePresent=true;
    if(n%2){const pad=await read(p+n,1);if(pad[0]!==0)fail('WebP 对齐字节无效');}
    offset=next;
   }
   if(!bitstream||offset!==end||!width||!height)fail('WebP 块目录不完整');
   if(extended&&Boolean(flags&8)!==orientationSeen)fail('WebP Exif 标志与实际块不一致');
   if(!orientationSeen)orientationEvidence='WebP_complete_chunk_directory_no_Exif_default1';
   if(orientation!==1)fail('带非标准方向的 WebP 请先转换为已正确旋转的 JPEG，避免浏览器方向解释不同');
  }else fail('暂不支持 HEIC、AVIF 或未知格式，请先转换为 JPEG、PNG 或静态 WebP');
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<3||height<3||width>16384||height>16384||width*height>40000000)fail('原图超出 16384 边或 4000 万像素边界');
  check();
  return Object.freeze({kind:'file-photo',format,width,height,exifOrientation:orientation,orientationEvidence,profilePresent,encodedBytes:blob.size,headerEvidence:ID,headerReadBytes:readBytes,headerReadRequests:requests,headerDirectoryChunks:chunks,pixelPayloadsRead:false,headerCRCOrCodecIntegrityValidated:false,headerCheckedBeforeDecode:true});
 }
 return Object.freeze({ID,MAX_BYTES,MAX_READ,MAX_REQUESTS,MAX_CHUNKS,exifOrientation,inspect});
});
