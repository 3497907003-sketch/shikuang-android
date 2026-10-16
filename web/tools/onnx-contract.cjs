/* Build-time metadata only; execution/export checks still use genuine ONNX Runtime.
 * Field numbers follow https://github.com/onnx/onnx/blob/v1.17.0/onnx/onnx.proto
 * No graph nodes, tensor weights, external files or arbitrary nested graphs are decoded.
 */
const invalid=()=>{throw new Error('Malformed or unsupported ONNX graph metadata');};
function fields(bytes){
  let offset=0;const result=[];
  const varint=()=>{let value=0n;for(let i=0;i<10;i++){if(offset>=bytes.length)invalid();const b=bytes[offset++];if(i===9&&b>1)invalid();value|=BigInt(b&127)<<BigInt(i*7);if(!(b&128))return value;}invalid();};
  const unsigned=value=>{if(value>BigInt(Number.MAX_SAFE_INTEGER))invalid();return Number(value);};
  while(offset<bytes.length){
    const tag=unsigned(varint()),id=Math.floor(tag/8),wire=tag%8;if(id<1||id>536870911)invalid();
    let value;
    if(wire===0)value=varint();
    else if(wire===2){const length=unsigned(varint());if(length>bytes.length-offset)invalid();value=bytes.subarray(offset,offset+length);offset+=length;}
    else if(wire===1||wire===5){const length=wire===1?8:4;if(length>bytes.length-offset)invalid();value=bytes.subarray(offset,offset+length);offset+=length;}
    else invalid();
    result.push({id,wire,value});
  }
  return result;
}
function one(rows,id,wire){const selected=rows.filter(row=>row.id===id);if(selected.length!==1||selected[0].wire!==wire)invalid();return selected[0].value;}
function text(value){return new TextDecoder('utf-8',{fatal:true}).decode(value);}
function tensor(bytes){
  const value=fields(bytes),type=fields(one(value,2,2)),descriptor=fields(one(type,1,2));
  if(one(descriptor,1,0)!==1n)throw new Error('ONNX input/output must be float32');
  const shape=fields(one(descriptor,2,2)).filter(row=>row.id===1).map(row=>{
    if(row.wire!==2)invalid();const dim=fields(row.value),number=dim.filter(x=>x.id===1),symbol=dim.filter(x=>x.id===2);
    if(number.length+symbol.length!==1)invalid();
    if(symbol.length)return text(one(dim,2,2));
    const signed=BigInt.asIntN(64,one(dim,1,0));if(signed>BigInt(Number.MAX_SAFE_INTEGER)||signed<BigInt(Number.MIN_SAFE_INTEGER))invalid();return Number(signed);
  });
  return {name:text(one(value,1,2)),type:'float32',shape};
}
function metadata(bytes){
  const graph=fields(one(fields(bytes),7,2));
  const read=id=>graph.filter(row=>row.id===id).map(row=>{if(row.wire!==2)invalid();return tensor(row.value);});
  return {inputs:read(11),outputs:read(12)};
}
function validate(bytes,model){
  const actual=metadata(bytes);
  const matches=(value,name,shape)=>value.name===name&&value.shape.length===shape.length&&value.shape.every((dimension,i)=>dimension===shape[i]||(i===0&&(dimension===-1||(typeof dimension==='string'&&dimension.length>0))));
  if(actual.inputs.length!==1||actual.outputs.length!==1||!matches(actual.inputs[0],model.inputName,[1,3,224,224])||!matches(actual.outputs[0],model.outputName,[1,model.classes]))throw new Error(model.path+' graph input/output does not match the manifest');
  return actual;
}
module.exports={metadata,validate};
