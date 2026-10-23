/* Future training/serving derivative generator. It is NOT registered for any
 * current model. Inputs are original-size, already-oriented sRGB RGBA pixels;
 * previews may downscale separately but cannot be substituted here.
 */
(function(root,factory){
 if(typeof module==='object'&&module.exports)module.exports=factory(require('./vendor/native-roi-q16.js'),require('./vendor/normalization.js'));
 else root.ShikuangNativeROIEntry=factory(root.ShikuangNativeROIQ16,root.ShikuangInputNormalization);
})(typeof globalThis==='object'?globalThis:this,function(Q16,Norm){
 'use strict';
 const CONTRACT_ID='shikuang-native-roi-q16-rgba8-torchf32-001';
 const DECODE_STAGE='native-oriented-srgb-no-scale';
 const ROUTES=Object.freeze(['photo-camera','photo-file','video-camera-frame','video-file-frame','native-photo-camera','native-photo-file']);
 const fail=m=>{throw new Error(m);};
 function preflightHeader(header,limits){
  const w=header?.width,h=header?.height;
  if(!Number.isSafeInteger(w)||!Number.isSafeInteger(h)||w<3||h<3||w>16384||h>16384||w*h>40000000)fail('原尺寸超出16384边/4000万像素边界');
  if(!['file-photo','decoder-frame'].includes(header.kind)||typeof header.orientationEvidence!=='string'||!header.orientationEvidence.trim())fail('需区分压缩照片头与已呈现相机/视频帧的实际方向证据');
  let orientation=1;
  if(header.kind==='file-photo'){
   if(!Number.isInteger(header.exifOrientation)||header.exifOrientation<1||header.exifOrientation>8)fail('需由头读取器提供实际方向，不能猜测原始JPEG EXIF');orientation=header.exifOrientation;
  }else if(header.exifOrientation!==undefined||header.frameOrientationApplied!==true)fail('已呈现视频/相机帧使用显示尺寸，不能虚构EXIF标签或二次旋转');
  if(!limits||!Number.isSafeInteger(limits.inputMemoryBudgetBytes)||limits.inputMemoryBudgetBytes<2097152||!Number.isSafeInteger(limits.maxNativePixels)||limits.maxNativePixels<9||limits.maxNativePixels>40000000)fail('必须提供设备/训练进程的显式输入预算');
  // Nominal conservative browser allocation budget: decoded native bitmap,
  // native Canvas, getImageData RGBA + decoder scratch at 4 bytes/pixel each.
  // Codec internals/GC are not observable here; this is a reservation, not RSS proof.
  const encodedBytes=header.encodedBytes===undefined?0:header.encodedBytes;
  if(!Number.isSafeInteger(encodedBytes)||encodedBytes<0||encodedBytes>20*1024*1024)fail('压缩照片字节预算无效');
  const reservationBytes=w*h*16+2097152+encodedBytes;
  if(w*h>limits.maxNativePixels||reservationBytes>limits.inputMemoryBudgetBytes)fail('原图解码预算不足，请重新拍摄较低分辨率照片；不能默默1536预缩后冒充同一合同');
  return Object.freeze({storedDimensions:Object.freeze([w,h]),orientedDimensions:Object.freeze(orientation>=5?[h,w]:[w,h]),nativePixels:w*h,reservationBytes,encodedBytes,nominalCopies:4,actualPeakMemoryVerified:false,codecInternalAllocationBoundProven:false,priorResizeAuthorized:false,headerCheckedBeforeDecode:header.headerCheckedBeforeDecode===true});
 }
 function normalizedBounds(rect,width,height){
  if(!rect||!['x0','y0','x1','y1'].every(k=>Number.isFinite(rect[k]))||rect.x0<0||rect.y0<0||rect.x1>1||rect.y1>1||rect.x1<=rect.x0||rect.y1<=rect.y0)fail('需原图定向坐标下的有效normalized ROI，不能静默截断越界');
  const b={x0:Math.floor(rect.x0*width),y0:Math.floor(rect.y0*height),x1:Math.ceil(rect.x1*width),y1:Math.ceil(rect.y1*height)};
  if(b.x1-b.x0<3||b.y1-b.y0<3)fail('原图ROI短边不足3像素；这是工程边界，非识别清晰度门槛');
  return Object.freeze(b);
 }
 function validateNativeFrame(frame,limits){
  const reservation=preflightHeader(frame?.sourceHeader,limits);
  if(frame?.stage!==DECODE_STAGE||frame.colorSpace!=='srgb'||frame.orientationApplied!==true||frame.priorResizeCount!==0||frame.jpegRoundTripsCreated!==0||!ROUTES.includes(frame.route)||typeof frame.decoderEvidence!=='string'||!frame.decoderEvidence.trim())fail('原图已方向/sRGB/零预缩零再JPEG证据必需');
  if(frame.route.startsWith('video-')&&frame.sourceHeader.kind!=='decoder-frame')fail('视频帧必须使用decoder呈现尺寸与方向，不能冒充静态照片EXIF');
  if(frame.width!==reservation.orientedDimensions[0]||frame.height!==reservation.orientedDimensions[1])fail('不能把缩小预览替代native原尺寸像素');
  return reservation;
 }
 function qualityNativeROI(frame,bounds){
  const width=bounds.x1-bounds.x0,height=bounds.y1-bounds.y0,rgba=frame.rgba,sw=frame.width;
  const stride=Math.max(1,Math.ceil(Math.sqrt(width*height/2000000)));
  const luminance=(x,y)=>{const i=(y*sw+x)*4;return .2126*rgba[i]+.7152*rgba[i+1]+.0722*rgba[i+2];};
  let sum=0,sq=0,dark=0,bright=0,count=0,lap=0,lapSq=0,lapCount=0;
  for(let y=bounds.y0;y<bounds.y1;y+=stride)for(let x=bounds.x0;x<bounds.x1;x+=stride){
   const g=luminance(x,y);sum+=g;sq+=g*g;dark+=g<15;bright+=g>245;count++;
   if(x-stride>=bounds.x0&&x+stride<bounds.x1&&y-stride>=bounds.y0&&y+stride<bounds.y1){const z=luminance(x-stride,y)+luminance(x+stride,y)+luminance(x,y-stride)+luminance(x,y+stride)-4*g;lap+=z;lapSq+=z*z;lapCount++;}
  }
  const mean=sum/count;
  return Object.freeze({scope:'native-selected-unpadded-ROI-only',width,height,pixelCount:width*height,sampleCount:count,sampleStride:stride,mean,contrast:Math.sqrt(Math.max(0,sq/count-mean*mean)),darkFraction:dark/count,brightFraction:bright/count,sharpness:lapCount?Math.max(0,lapSq/lapCount-(lap/lapCount)**2):null,sharpnessNeighborSpacingNativePixels:stride,validatedRejectThreshold:null,backgroundOutsideROIIncluded:false,grayPaddingIncluded:false});
 }
 function preprocess(frame,rect,lut,limits){
  const reservation=validateNativeFrame(frame,limits),bounds=normalizedBounds(rect,frame.width,frame.height);
  const result=Q16.preprocessNativeROIAspectRGBA8({...frame,nativeROI:bounds},lut);
  Norm.normalizeRGB224Into(result.rgb224,result.tensorFloat32LE);
  return {...result,contractId:CONTRACT_ID,normId:Norm.TORCH_ID,geometryLutSha256:result.lutSha256,lutSha256:null,normNumericOrder:'float32 divide/subtract/divide with float32 mean/std',route:frame.route,normalizedROI:Object.freeze({...rect}),nativeROI:bounds,decoderEvidence:frame.decoderEvidence,decodeStage:DECODE_STAGE,sourceHeader:Object.freeze({...frame.sourceHeader}),reservation,priorResizeCount:0,jpegRoundTripsCreated:0,quality:qualityNativeROI(frame,bounds),ROI_quality_scope:'selected_native_unpadded_pixels_pending_calibration',modelRegistered:false,modelForwards:0};
 }
 function requireModel(){fail('native-ROI新合同尚未有通过验收的模型注册项；现98与失败87候选均禁止接入');}
 return Object.freeze({CONTRACT_ID,DECODE_STAGE,ROUTES,preflightHeader,normalizedBounds,validateNativeFrame,qualityNativeROI,preprocess,requireModel});
});
