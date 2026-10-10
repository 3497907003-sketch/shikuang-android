'use strict';
let bootError;
try{importScripts('./vendor/ort.min.js','./core.js');}catch(error){bootError=error.message||String(error);}
const sessions = new Map();
let manifest;
const send = (type, value) => postMessage({ type, ...value });
async function modelSession(model, base) {
  if (sessions.has(model.file)) return sessions.get(model.file);
  const expected = manifest.models.find(m => m.path === `models/${model.file}`);
  if (!expected) throw new Error('模型清单不完整，请重新安装或更新离线资源');
  const res = await fetch(new URL(`models/${model.file}`, base));
  if (!res.ok) throw new Error(`模型文件读取失败 (${res.status})，请准备离线资源或使用安装版`);
  if ((res.headers.get('content-type') || '').includes('text/html')) throw new Error('模型地址返回了网页，请更新 App 资源');
  const total = Number(res.headers.get('content-length')) || 0;
  let bytes;
  if (res.body?.getReader) {
    const reader = res.body.getReader(), chunks = [];
    let size = 0, previous = 0;
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.length; chunks.push(part.value);
      if (size > 80000000) { await reader.cancel(); throw new Error('模型文件大小异常，请重新安装'); }
      if (Date.now() - previous > 250) {
        send('progress', { message:`读取 ${model.title} ${(size/1048576).toFixed(1)}${total ? '/'+(total/1048576).toFixed(1) : ''} MB…` }); previous=Date.now();
      }
    }
    const joined=new Uint8Array(size); let offset=0;
    for (const chunk of chunks) { joined.set(chunk,offset);offset+=chunk.length; }
    bytes=joined.buffer;
  } else bytes=await res.arrayBuffer();
  if (!crypto.subtle) throw new Error('当前环境无法校验模型，请使用安装版或 HTTPS 地址');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(b=>b.toString(16).padStart(2,'0')).join('');
  if (hash !== expected.sha256) throw new Error('模型文件校验失败，请重新准备离线资源或安装新版');
  send('progress',{message:`${model.title} 已校验，正在初始化…`});
  const loaded = await ort.InferenceSession.create(bytes,{executionProviders:['wasm'],graphOptimizationLevel:'all'});
  sessions.set(model.file,loaded);return loaded;
}
async function run(session, data, count) {
  const input = new ort.Tensor('float32',data,[1,3,224,224]);
  let output;
  try {
    if(bootError)throw new Error(`识别依赖加载失败：${bootError}`);
    output=await session.run({[session.inputNames[0]]:input});
    const values=Array.from(output[session.outputNames[0]]?.data || []);
    if(values.length!==count || values.some(x=>!Number.isFinite(x)))throw new Error('模型输出与标签清单不匹配');
    return values;
  } finally {input.dispose(); if(output)Object.values(output).forEach(t=>t.dispose?.());}
}
onmessage = async ({data}) => {
  if(data.type!=='analyze')return;
  try {
    if(bootError)throw new Error(`识别依赖加载失败：${bootError}`);
    const {base,inputs,models,labels,screen,blocked}=data;
    ort.env.wasm.wasmPaths=new URL('vendor/',base).href;ort.env.wasm.numThreads=1;ort.env.wasm.proxy=false;
    if(!manifest){const res=await fetch(new URL('model-manifest.json',base));if(!res.ok)throw new Error('模型清单无法读取');manifest=await res.json();}
    if(JSON.stringify(labels)!==JSON.stringify(manifest.labels))throw new Error('模型标签类序不匹配，请更新 App');
    const runs=[],screening=[],warnings=[];
    if(screen){
      const gate=await modelSession({file:'imagenet_gate.onnx',title:'输入筛查'},base);
      if(gate)for(let i=0;i<inputs.length;i++){
        send('progress',{message:`筛查输入图像 ${i+1}/${inputs.length}…`});
        const values=await run(gate,inputs[i],1000);screening.push({photo:i,values});
        if(MineralCore.screen(values,blocked).rejected)throw new Error(MineralCore.NON_MINERAL);
      }
    }
    if(models.length===1)warnings.push('快速模式仅提供初步候选，建议使用交叉分析与实测物性复核');
    for(let m=0;m<models.length;m++){
      const model=models[m];let loaded;
      try{loaded=await modelSession(model,base);}catch(e){if(!runs.length)throw e;warnings.push(`${model.title} 不可用，已使用其他模型`);continue;}
      for(let i=0;i<inputs.length;i++){
        send('progress',{message:`分析图像 ${i+1}/${inputs.length} · ${model.title}`});
        const values=await run(loaded,inputs[i],labels.length);runs.push({photo:i,model:model.id,values});
        if(m===0&&i===0){const top=values.indexOf(Math.max(...values));send('partial',{key:labels[top]});}
      }
    }
    send('result',{runs,screening,warnings});
  }catch(e){send('error',{message:e.message||'识别资源无法运行，请更新 App'});}
};
postMessage(bootError?{type:'boot-error',message:bootError}:{type:'ready'});
