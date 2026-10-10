(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.MineralMedia=api;})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
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
      if(video.videoWidth*video.videoHeight>40000000)throw new Error('视频分辨率过大，请降低分辨率');
      const times=frameTimes(video.duration),frames=[],scale=Math.min(1,1536/Math.max(video.videoWidth,video.videoHeight));
      const canvas=document.createElement('canvas');canvas.width=Math.round(video.videoWidth*scale);canvas.height=Math.round(video.videoHeight*scale);
      for(let i=0;i<times.length;i++){checkAbort(signal);report(`提取视频帧 ${i+1}/${times.length}…`);checkAbort(signal);const seek=event(video,'seeked',15000,signal);video.currentTime=times[i];await seek;checkAbort(signal);canvas.getContext('2d').drawImage(video,0,0,canvas.width,canvas.height);const src=canvas.toDataURL('image/jpeg',.9);if(!frames.some(x=>x.src===src))frames.push({src,kind:'video',time:times[i]});}
      if(!frames.length)throw new Error('视频未提供可读取的帧');return {frames,duration:video.duration,name:file.name};
    }finally{video.pause();video.removeAttribute('src');video.load();URL.revokeObjectURL(url);}
  }
  return {validateVideo,frameTimes,extractVideo};
});
