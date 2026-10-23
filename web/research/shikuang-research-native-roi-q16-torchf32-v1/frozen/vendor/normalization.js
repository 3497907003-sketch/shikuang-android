/* Numeric engineering adapter only. No decoder, model, weights or network. */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.ShikuangInputNormalization=factory();
})(typeof globalThis==='object'?globalThis:this,function(){
  'use strict';
  const LEGACY_ID='imagenet-rgb-double-to-f32-lut-9243928c-001';
  const TORCH_ID='imagenet-rgb-stepwise-f32-div-sub-div-001';
  const LEGACY_CONTRACT='shikuang-target-region-aspect003-prototype-001';
  const MOBILE_CONTRACT='shikuang-target-region-aspect003-mobile87-torchf32-001';
  const MOBILE_FAMILY='mobilenet-v3-small-supervised344-development';
  const MEAN=Object.freeze([.485,.456,.406]);
  const STD=Object.freeze([.229,.224,.225]);
  const f32=Math.fround;
  const mean32=MEAN.map(f32),std32=STD.map(f32);
  const typed=Object.getPrototypeOf(Uint8Array.prototype);
  const tag=Object.getOwnPropertyDescriptor(typed,Symbol.toStringTag).get;
  const length=Object.getOwnPropertyDescriptor(typed,'length').get;
  const buffer=Object.getOwnPropertyDescriptor(typed,'buffer').get;
  const offset=Object.getOwnPropertyDescriptor(typed,'byteOffset').get;
  const bufferLength=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'byteLength').get;
  function bytes(value,n){
    let kind,b,actual,off;
    try{kind=tag.call(value);b=buffer.call(value);actual=length.call(value);off=offset.call(value);bufferLength.call(b);}catch(_){throw new Error('归一化需要非共享真实字节数组');}
    if(!['Uint8Array','Uint8ClampedArray'].includes(kind)||actual!==n)throw new Error('归一化字节长度无效');
    return new Uint8Array(b,off,n);
  }
  function value(channel,u8){
    if(!Number.isInteger(channel)||channel<0||channel>2||!Number.isInteger(u8)||u8<0||u8>255)throw new Error('RGB数值域无效');
    // CPU Torch expression performs three separate float32 operations. Never
    // combine this as binary64 followed by one final fround.
    return f32(f32(f32(u8/f32(255))-mean32[channel])/std32[channel]);
  }
  function normalizeRGB224Into(rgb,target){
    rgb=bytes(rgb,224*224*3);target=bytes(target,224*224*3*4);
    const out=new DataView(target.buffer,target.byteOffset,target.byteLength);
    for(let c=0;c<3;c++)for(let k=0;k<224*224;k++)out.setFloat32((c*224*224+k)*4,value(c,rgb[k*3+c]),true);
    return target;
  }
  function contract(normId){
    if(normId===LEGACY_ID)return Object.freeze({normId,inputContract:LEGACY_CONTRACT,modelFamily:'legacy-contract-engineering-only',classCount:98});
    if(normId===TORCH_ID)return Object.freeze({normId,inputContract:MOBILE_CONTRACT,modelFamily:MOBILE_FAMILY,classCount:87});
    throw new Error('需明确选择已审查归一化合同，不能混用CLIP或其他表达式');
  }
  return Object.freeze({LEGACY_ID,TORCH_ID,LEGACY_CONTRACT,MOBILE_CONTRACT,MOBILE_FAMILY,MEAN,STD,contract,value,normalizeRGB224Into});
});
