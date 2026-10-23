'use strict';
let bootError;
try{
  importScripts('../../compat.js');
  importScripts('../../core.js');
  importScripts('../../research-input.js');
  importScripts('./frozen/vendor/native-roi-q16.js');
  importScripts('./frozen/vendor/normalization.js');
  importScripts('./frozen/native-roi-entry.js');
  importScripts('./profile.js');
}catch(error){bootError=error.message||String(error);}
let busy=false;
onmessage=async({data})=>{
  if(data?.type!=='prepare-input')return;
  if(busy){postMessage({type:'error',message:'已有研究输入正在处理'});return;}
  busy=true;
  try{
    if(bootError)throw new Error(bootError);
    // Repeat the public contract in the Worker before resource reads or kernel
    // allocation. Direct Worker messages receive no legacy/model fallback.
    ShikuangResearchInput.validateRequest({...data,transferOwnership:true});
    ShikuangResearchPreprocessProfile.selectResearchProfile(data.profileId);
    const url=new URL('./frozen/vendor/normalization-lut.f32le.bin',self.location.href);
    const shell=new URL(self.location.href).searchParams.get('v');if(shell)url.searchParams.set('v',shell);
    const lut=await MineralCore.readResource(await fetch(url),3072,3072,undefined,{timeout:15000});
    const result=ShikuangResearchPreprocessProfile.preprocess({profileId:data.profileId,frame:data.frame,normalizedROI:data.normalizedROI,geometryLUTBytes:lut,limits:data.limits});
    const runtimeTensor=ShikuangResearchPreprocessProfile.toRuntimeTensor(data.profileId,result.tensorFloat32LE);
    result.runtimeTensor=runtimeTensor;
    result.memoryLedger.runtimeTensorCopyBytes=runtimeTensor.byteLength;
    result.memoryLedger.workerSourceCloneBytes=0;
    result.sourceOwnershipTransferred=true;
    ShikuangResearchInput.validateResult(result);
    postMessage({type:'result',result},[result.rgb224.buffer,result.tensorFloat32LE.buffer,runtimeTensor.buffer]);
  }catch(error){postMessage({type:'error',message:error.message||String(error)});}
  finally{busy=false;}
};
postMessage(bootError?{type:'boot-error',message:bootError}:{type:'ready',profileId:ShikuangResearchInput.PROFILE_ID,profileVersion:1});
