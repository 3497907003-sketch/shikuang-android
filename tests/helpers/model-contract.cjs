const {createHash}=require('node:crypto');
const labels=['quartz','calcite'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const files={
    'models/mobilenet_int8.onnx':Buffer.from([1]),
    'models/efficientnet.onnx':Buffer.from([2]),
    'models/imagenet_gate.onnx':Buffer.from([3])
  };
  const manifest={schemaVersion:1,version:'2.5.0-test',input:{shape:[1,3,224,224],dtype:'float32',layout:'NCHW',colorSpace:'RGB',pixelScale:255,resize:'bilinear',crop:'user-selected center square',normalization:{mean:[.485,.456,.406],std:[.229,.224,.225]}},labels:[...labels],modes:{fast:['mobilenet'],ensemble:['mobilenet','efficientnet']},models:Object.entries(files).map(([path,bytes],i)=>({id:['mobilenet','efficientnet','imagenet-gate'][i],role:i===2?'input-gate':'mineral-classifier',title:['MobileNet','EfficientNet','输入筛查'][i],path,sha256:hash(bytes),bytes:bytes.length,classes:i===2?1000:labels.length,output:'logits',inputName:'input',outputName:'output',temperature:1}))};
  return {manifest,files};
}
function response(bytes,status=200) {
  const buffer=Buffer.from(bytes);
  return {ok:status===200,status,headers:{get:()=> 'application/octet-stream'},arrayBuffer:async()=>buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.length)};
}
function raw(manifest,payload={}) {
  const photos=payload.inputs?.length||1,ids=payload.modelIds||manifest.modes.ensemble;
  return {runs:Array.from({length:photos},(_,photo)=>ids.map(model=>({photo,model,values:[4,0]}))).flat(),screening:Array.from({length:photos},(_,photo)=>({photo,values:Array(1000).fill(0)})),warnings:[],manifestSha256:hash(Buffer.from(JSON.stringify(manifest))),modelVersion:manifest.version};
}
module.exports={fixture,response,raw,hash,labels};
