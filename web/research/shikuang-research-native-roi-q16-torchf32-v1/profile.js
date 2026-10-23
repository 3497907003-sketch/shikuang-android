/* Explicit research-only input profile. No decoder, model, registration,
 * network, production-default selection or training admission is provided.
 * The caller must supply audited original-size, already-oriented sRGB RGBA.
 */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory(require('./frozen/native-roi-entry.js'),require('./frozen/vendor/native-roi-q16.js'),require('./frozen/vendor/normalization.js'));
  else root.ShikuangResearchPreprocessProfile=factory(root.ShikuangNativeROIEntry,root.ShikuangNativeROIQ16,root.ShikuangInputNormalization);
})(typeof globalThis==='object'?globalThis:this,function(Entry,Q16,Norm){
  'use strict';
  if(!Entry||!Q16||!Norm)throw new Error('Research preprocessing dependencies are required');
  if(Entry.CONTRACT_ID!=='shikuang-native-roi-q16-rgba8-torchf32-001'||
     Q16.VERSION!=='shikuang-private-full-aspect-virtual-rgba8-q16-v3-003'||
     Norm.TORCH_ID!=='imagenet-rgb-stepwise-f32-div-sub-div-001')throw new Error('Research preprocessing dependency version mismatch');
  const PROFILE_ID='shikuang-research-native-roi-q16-torchf32-v1';
  const SIZE=224,COUNT=3*SIZE*SIZE,BYTES=COUNT*4;
  const PROFILE=Object.freeze({
    profileId:PROFILE_ID,profileVersion:1,purpose:'research-preprocessing-only',
    inputContract:Entry.CONTRACT_ID,geometryAlgorithm:Q16.VERSION,normId:Norm.TORCH_ID,
    sourceStage:Entry.DECODE_STAGE,colorSpace:'srgb',sourceData:'native-oriented-opaque-selected-ROI-rgba8',
    geometry:'integer-native-ROI; virtual-square-gray127; Q16-separable-antialias; horizontal-then-vertical-u8-rounding',
    normNumericOrder:'float32 divide/subtract/divide with float32 mean/std',
    outputLayout:'NCHW',outputDtype:'float32',outputEncoding:'float32-le',
    outputShape:Object.freeze([1,3,SIZE,SIZE]),runtimeTensorCopyBytes:BYTES,
    decoderProvided:false,decoderCrossPlatformParityProven:false,
    productRegistered:false,trainingAdmissionGranted:false,independentPhaseTruthGranted:false
  });
  const typed=Object.getPrototypeOf(Uint8Array.prototype);
  const tag=Object.getOwnPropertyDescriptor(typed,Symbol.toStringTag).get;
  const length=Object.getOwnPropertyDescriptor(typed,'length').get;
  const buffer=Object.getOwnPropertyDescriptor(typed,'buffer').get;
  const offset=Object.getOwnPropertyDescriptor(typed,'byteOffset').get;
  const ordinaryLength=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'byteLength').get;
  function exactBytes(value,n){
    let kind,b,len,off;
    try{kind=tag.call(value);b=buffer.call(value);len=length.call(value);off=offset.call(value);ordinaryLength.call(b);}
    catch(_){throw new Error('Real unshared byte storage required');}
    if(!['Uint8Array','Uint8ClampedArray'].includes(kind)||len!==n)throw new Error('Tensor byte storage or length mismatch');
    return new Uint8Array(b,off,n);
  }
  function selectResearchProfile(id){
    if(id!==PROFILE_ID)throw new Error('Explicit exact research profile ID required; no default or legacy fallback');
    return PROFILE;
  }
  function preprocess(options){
    if(!options||typeof options!=='object')throw new Error('Research preprocessing options required');
    selectResearchProfile(options.profileId);
    if(Object.prototype.hasOwnProperty.call(options,'cropPercent')||Object.prototype.hasOwnProperty.call(options,'legacyInput'))throw new Error('Legacy center-square input cannot be reinterpreted as native ROI');
    const result=Entry.preprocess(options.frame,options.normalizedROI,options.geometryLUTBytes,options.limits);
    return {...result,profileId:PROFILE_ID,profileVersion:1,
      decoderCrossPlatformParity:false,productionRegistration:false,modelRegistered:false,modelForwards:0,
      trainingAdmissionGrantedByThisModule:false,independentPhaseTruthGrantedByThisModule:false};
  }
  // A future Worker or native bridge can consume these values. Read LE
  // explicitly, including unaligned subarrays; never assume host endianness.
  // This allocates one additional 602112-byte tensor, outside kernel ledger.
  function toRuntimeTensor(profileId,tensorFloat32LE){
    selectResearchProfile(profileId);
    const bytes=exactBytes(tensorFloat32LE,BYTES),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    const tensor=new Float32Array(COUNT);
    for(let i=0;i<COUNT;i++){
      const value=view.getFloat32(i*4,true);
      if(!Number.isFinite(value))throw new Error('Tensor contains non-finite values');
      tensor[i]=value;
    }
    return tensor;
  }
  return Object.freeze({PROFILE_ID,PROFILE,selectResearchProfile,preprocess,toRuntimeTensor});
});
