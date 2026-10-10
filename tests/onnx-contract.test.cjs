const test=require('node:test'),assert=require('node:assert/strict');
const {validate}=require('../tools/onnx-contract.cjs');
const varint=n=>{let v=BigInt(n),bytes=[];do{let b=Number(v&127n);v>>=7n;if(v)b|=128;bytes.push(b);}while(v);return Buffer.from(bytes);};
const number=(id,value)=>Buffer.concat([varint(id*8),varint(value)]);
const message=(id,value)=>Buffer.concat([varint(id*8+2),varint(value.length),value]);
const text=(id,value)=>message(id,Buffer.from(value));
const tensor=(name,shape,type=1)=>Buffer.concat([text(1,name),message(2,message(1,Buffer.concat([number(1,type),message(2,Buffer.concat(shape.map(dim=>message(1,typeof dim==='string'?text(2,dim):number(1,dim)))))])))]);
const model=(input=['batch',3,224,224],output=['batch',98],name='logits',type=1)=>message(7,Buffer.concat([message(11,tensor('input',input,type)),message(12,tensor(name,output))]));
const contract={path:'test.onnx',inputName:'input',outputName:'logits',classes:98};
test('ONNX metadata gate checks real protobuf names/type/shape while permitting symbolic batch only',()=>{
  assert.deepEqual(validate(model(),contract).inputs[0].shape,['batch',3,224,224]);
  for(const data of [model([1,224,224,3]),model([1,3,112,112]),model([1,3,224,224],[1,99]),model([1,3,224,224],[1,'classes']),model(undefined,undefined,'other'),model(undefined,undefined,undefined,2)])assert.throws(()=>validate(data,contract));
});
test('ONNX metadata gate rejects truncated lengths and malformed protobuf fields',()=>{
  for(const data of [model().subarray(0,-1),Buffer.from([0]),Buffer.from([58,255,255,255,255,127]),Buffer.from([63]),Buffer.alloc(12,255)])assert.throws(()=>validate(data,contract));
});
