/* Native ROI index adapter of frozen aspect003. Same Q16 coefficients, rounding, gray127 and rolling cache. No source ROI copy, decoder, Canvas, JPEG or model. */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.ShikuangNativeROIQ16=factory();
})(typeof self==='object'?self:this,function(){
  'use strict';
  // Capture trusted built-in intrinsics before accepting any caller objects.
  // This validates genuine byte storage; it is not hostile same-realm isolation.
  var NativeUint8Array=Uint8Array,NativeDataView=DataView;
  var typedPrototype=Object.getPrototypeOf(Uint8Array.prototype);
  var typedName=Object.getOwnPropertyDescriptor(typedPrototype,Symbol.toStringTag).get;
  var typedLength=Object.getOwnPropertyDescriptor(typedPrototype,'length').get;
  var typedByteLength=Object.getOwnPropertyDescriptor(typedPrototype,'byteLength').get;
  var typedByteOffset=Object.getOwnPropertyDescriptor(typedPrototype,'byteOffset').get;
  var typedBuffer=Object.getOwnPropertyDescriptor(typedPrototype,'buffer').get;
  var ordinaryBufferByteLength=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'byteLength').get;
  function stableByteView(value,role){
    var name=typedName.call(value);
    if(name!=='Uint8Array'&&name!=='Uint8ClampedArray')throw new Error(role+' genuine RGBA/LUT byte typed array required');
    var buffer=typedBuffer.call(value),length=typedLength.call(value);
    var bytes=typedByteLength.call(value),offset=typedByteOffset.call(value),backing;
    try{backing=ordinaryBufferByteLength.call(buffer);}
    catch(error){throw new Error(role+' unshared ordinary ArrayBuffer required');}
    if(length!==bytes||offset<0||offset+bytes>backing)throw new Error(role+' actual byte storage mismatch');
    return new NativeUint8Array(buffer,offset,bytes);
  }
  var SIZE=224,Q=65536,MAX_EDGE=16384,MAX_PIXELS=40000000;
  var VERSION='shikuang-private-full-aspect-virtual-rgba8-q16-v3-003';
  var LUT_SHA='9243928c3ab0dbc2609a421c65ce0ed601892a65d273f80dcc6d1e69c72ae159';
  var LUT_HEX='bd8b07c02b7306c0985a05c0064204c0732903c0e11002c04ef800c078bfffbf538efdbf2e5dfbbf092cf9bfe5faf6bfc0c9f4bf9b98f2bf7667f0bf5136eebf2c05ecbf07d4e9bfe3a2e7bfbe71e5bf9940e3bf740fe1bf4fdedebf2aaddcbf067cdabfe14ad8bfbc19d6bf97e8d3bf72b7d1bf4d86cfbf2855cdbf0424cbbfdff2c8bfbac1c6bf9590c4bf705fc2bf4b2ec0bf27fdbdbf02ccbbbfdd9ab9bfb869b7bf9338b5bf6e07b3bf49d6b0bf25a5aebf0074acbfdb42aabfb611a8bf91e0a5bf6cafa3bf487ea1bf234d9fbffe1b9dbfd9ea9abfb4b998bf8f8896bf6a5794bf462692bf21f58fbffcc38dbfd7928bbfb26189bf8d3087bf68ff84bf44ce82bf1f9d80bff4d77cbfaa7578bf611374bf17b16fbfcd4e6bbf83ec66bf3a8a62bff0275ebfa6c559bf5d6355bf130151bfc99e4cbf803c48bf36da43bfec773fbfa2153bbf59b336bf0f5132bfc5ee2dbf7c8c29bf322a25bfe8c720bf9f651cbf550318bf0ba113bfc23e0fbf78dc0abf2e7a06bfe41702bf366bfbbea2a6f2be0fe2e9be7b1de1bee858d8be5594cfbec1cfc6be2e0bbebe9a46b5be0782acbe74bda3bee0f89abe4d3492beba6f89be26ab80be25cd6fbeff435ebed8ba4cbeb1313bbe8aa829be641f18be3d9606be2c1aeabddf07c7bd91f5a3bd43e380bdeca13bbda1faeabcd6623dbc2d5fb63b01e1b93c1c15233db739693d29af973d77c1ba3dc4d3dd3d0973003e30fc113e5685233e7d0e353ea497463ecb20583ef1a9693e18337b3e205e863eb3228f3e46e7973edaaba03e6d70a93e0035b23e94f9ba3e27bec33ebb82cc3e4e47d53ee10bde3e75d0e63e0895ef3e9c59f83e178f003f61f1043fab53093ff5b50d3f3e18123f887a163fd2dc1a3f1b3f1f3f65a1233faf03283ff8652c3f42c8303f8c2a353fd58c393f1fef3d3f6951423fb3b3463ffc154b3f46784f3f90da533fd93c583f239f5c3f6d01613fb663653f00c6693f4a286e3f948a723fddec763f274f7b3f71b17f3fdd09823f023b843f276c863f4c9d883f71ce8a3f95ff8c3fba308f3fdf61913f0493933f29c4953f4ef5973f72269a3f97579c3fbc889e3fe1b9a03f06eba23f2b1ca53f504da73f747ea93f99afab3fbee0ad3fe311b03f0843b23f2d74b43f51a5b63f76d6b83f9b07bb3fc038bd3fe569bf3f0a9bc13f2fccc33f53fdc53f782ec83f9d5fca3fc290cc3fe7c1ce3f0cf3d03f3024d33f5555d53f7a86d73f9fb7d93fc4e8db3fe919de3f0e4be03f327ce23f57ade43f7cdee63fa10fe93fc640eb3feb71ed3f0fa3ef3f34d4f13f5905f43f7e36f63fa367f83fc898fa3fedc9fc3f11fbfe3f1b960040aeae014040c70240d2df034065f80440f71006408a2907401c420840af5a094041730a40d38b0b4066a40c40f8bc0d408bd50e401dee0f40254902c04f2a01c0790b00c047d9fdbf9c9bfbbff05df9bf4520f7bf99e2f4bfeea4f2bf4367f0bf9729eebfecebebbf41aee9bf9570e7bfea32e5bf3ef5e2bf93b7e0bfe879debf3c3cdcbf91fed9bfe5c0d7bf3a83d5bf8f45d3bfe307d1bf38cacebf8d8cccbfe14ecabf3611c8bf8ad3c5bfdf95c3bf3458c1bf881abfbfdddcbcbf319fbabf8661b8bfdb23b6bf2fe6b3bf84a8b1bfd96aafbf2d2dadbf82efaabfd6b1a8bf2b74a6bf8036a4bfd4f8a1bf29bb9fbf7d7d9dbfd23f9bbf270299bf7bc496bfd08694bf254992bf790b90bfcecd8dbf22908bbf775289bfcc1487bf20d784bf759982bfca5b80bf3c3c7cbfe5c077bf8f4573bf38ca6ebfe14e6abf8ad365bf345861bfdddc5cbf866158bf2fe653bfd96a4fbf82ef4abf2b7446bfd4f841bf7d7d3dbf270239bfd08634bf790b30bf22902bbfcc1427bf759922bf1e1e1ebfc7a219bf712715bf1aac10bfc3300cbf6cb507bf163a03bf7d7dfdbed086f4be2290ebbe7599e2bec7a2d9be1aacd0be6cb5c7bebfbebebe11c8b5be64d1acbeb6daa3be09e49abe5bed91beaef688be000080bea5126ebe4a255cbeef374abe944a38be395d26bede6f14be838202be4f2ae1bd994fbdbde37499bd59346bbded7e23bd0193b7bca1a0a0bb61854e3c89adf63c310c433dcf60853d853ba93d3b16cd3df1f0f03dd4650a3e2f531c3e8a402e3ee52d403e401b523e9b08643ef6f5753ea9f1833e56e88c3e04df953eb1d59e3e5fcca73e0cc3b03ebab9b93e67b0c23e15a7cb3ec29dd43e7094dd3e1d8be63ecb81ef3e7878f83e93b7003fea32053f41ae093f97290e3feea4123f4520173f9c9b1b3ff216203f4992243fa00d293ff7882d3f4d04323fa47f363ffbfa3a3f52763f3fa9f1433fff6c483f56e84c3fad63513f04df553f5a5a5a3fb1d55e3f0851633f5fcc673fb5476c3f0cc3703f633e753fbab9793f10357e3f3458813fdf95833f8ad3853f3611883fe14e8a3f8d8c8c3f38ca8e3fe307913f8f45933f3a83953fe5c0973f91fe993f3c3c9c3fe8799e3f93b7a03f3ef5a23fea32a53f9570a73f41aea93fecebab3f9729ae3f4367b03feea4b23f99e2b43f4520b73ff05db93f9c9bbb3f47d9bd3ff216c03f9e54c23f4992c43ff5cfc63fa00dc93f4b4bcb3ff788cd3fa2c6cf3f4d04d23ff941d43fa47fd63f50bdd83ffbfada3fa638dd3f5276df3ffdb3e13fa9f1e33f542fe63fff6ce83fabaaea3f56e8ec3f0126ef3fad63f13f58a1f33f04dff53faf1cf83f5a5afa3f0698fc3fb1d5fe3fae89004084a801405ac702402fe6034005050540db230640b0420740866108405c800940319f0a4007be0b40dddc0c40b3fb0d40881a0f405e3910403458114009771240df951340b5b414408ad3154060f21640361118400b301940e14e1a40b76d1b4009f8e6bfeabce4bfcc81e2bfad46e0bf8e0bdebf70d0dbbf5195d9bf325ad7bf141fd5bff5e3d2bfd6a8d0bfb86dcebf9932ccbf7af7c9bf5cbcc7bf3d81c5bf1e46c3bf000bc1bfe1cfbebfc294bcbfa459babf851eb8bf66e3b5bf48a8b3bf296db1bf0a32afbfecf6acbfcdbbaabfae80a8bf9045a6bf710aa4bf52cfa1bf33949fbf15599dbff61d9bbfd7e298bfb9a796bf9a6c94bf7b3192bf5df68fbf3ebb8dbf1f808bbf014589bfe20987bfc3ce84bfa59382bf865880bfcf3a7cbf91c477bf544e73bf17d86ebfd9616abf9ceb65bf5f7561bf21ff5cbfe48858bfa71254bf699c4fbf2c264bbfefaf46bfb13942bf74c33dbf364d39bff9d634bfbc6030bf7eea2bbf417427bf04fe22bfc6871ebf89111abf4c9b15bf0e2511bfd1ae0cbf943808bf56c203bf3298febeb7abf5be3cbfecbec2d2e3be47e6dabeccf9d1be520dc9bed720c0be5c34b7bee147aebe675ba5beec6e9cbe718293bef7958abe7ca981be037a71be0da15fbe18c84dbe22ef3bbe2d162abe383d18be426406be9916e9bdaf64c5bdc4b2a1bdb2017cbddc9d34bd0e74dabcc55817bc9236063cf4e2d13c5055303d25b9773d7d8e9f3d6840c33d53f2e63d1f52053e142b173e0a04293effdc3a3ef5b54c3eea8e5e3edf67703e6a20813ee50c8a3e60f9923edae59b3e55d2a43ed0bead3e4babb63ec597bf3e4084c83ebb70d13e355dda3eb049e33e2b36ec3ea522f53e200ffe3ecd7d033f0bf4073f486a0c3f85e0103fc356153f00cd193f3e431e3f7bb9223fb82f273ff6a52b3f331c303f7092343fae08393feb7e3d3f28f5413f666b463fa3e14a3fe0574f3f1ece533f5b44583f98ba5c3fd630613f13a7653f511d6a3f8e936e3fcb09733f0980773f46f67b3f4236803f6071823f7fac843f9ee7863fbc22893fdb5d8b3ffa988d3f18d48f3f370f923f564a943f7485963f93c0983fb2fb9a3fd0369d3fef719f3f0eada13f2ce8a33f4b23a63f6a5ea83f8899aa3fa7d4ac3fc60faf3fe44ab13f0386b33f22c1b53f41fcb73f5f37ba3f7e72bc3f9dadbe3fbbe8c03fda23c33ff95ec53f179ac73f36d5c93f5510cc3f734bce3f9286d03fb1c1d23fcffcd43fee37d73f0d73d93f2baedb3f4ae9dd3f6924e03f875fe23fa69ae43fc5d5e63fe310e93f024ceb3f2187ed3f3fc2ef3f5efdf13f7d38f43f9b73f63fbaaef83fd9e9fa3ff724fd3f1660ff3f9acd00402aeb0140b908034048260440d843054067610640f67e0740869c084015ba0940a4d70a4034f50b40c3120d4052300e40e24d0f40716b10400089114090a612401fc41340aee114403eff1540cd1c17405c3a1840ec5719407b751a400b931b409ab01c4029ce1d40b9eb1e4048092040d726214067442240f6612340857f2440159d2540a4ba264033d82740c3f52840';
  function integer(v){return typeof v==='number'&&isFinite(v)&&Math.floor(v)===v;}
  function dimensions(w,h,p){
    if(!integer(w)||!integer(h)||w<1||h<1||w>MAX_EDGE||h>MAX_EDGE||w*h>MAX_PIXELS)throw new Error('Unsupported source dimensions');
    if(!integer(p)||p<50||p>100||p%5!==0)throw new Error('ROI percent requires 50..100, step5');
  }
  function span(length,shortSide,percent,j){
    var A=100*SIZE,center=(length*100-shortSide*percent)*SIZE+(2*j+1)*shortSide*percent;
    var radius=Math.max(200*SIZE,2*shortSide*percent);
    var lo=Math.max(0,Math.floor((center-radius-A)/(2*A))+1);
    var hi=Math.min(length,Math.ceil((center+radius-A)/(2*A)));
    return {lo:lo,hi:hi,center:center,radius:radius};
  }
  function axisPlan(length,shortSide,percent){
    var offsets=new Uint32Array(SIZE+1),max=0;
    for(var j=0;j<SIZE;j++){
      var s=span(length,shortSide,percent,j),count=s.hi-s.lo;
      if(count<1||count>150)throw new Error('Invalid bounded support');
      offsets[j+1]=offsets[j]+count;max=Math.max(max,count);
    }
    return {offsets:offsets,max:max,count:offsets[SIZE],length:length,shortSide:shortSide,percent:percent};
  }
  function axisCoefficients(plan,scratch){
    var indices=new Uint16Array(plan.count),weights=new Uint32Array(plan.count),A=100*SIZE;
    for(var j=0;j<SIZE;j++){
      var s=span(plan.length,plan.shortSide,plan.percent,j),at=plan.offsets[j],count=s.hi-s.lo,total=0,sum=0;
      for(var k=0;k<count;k++){
        var i=s.lo+k,r=s.radius-Math.abs((2*i+1)*A-s.center);
        if(r<=0)throw new Error('Nonpositive support coefficient');
        indices[at+k]=i;scratch.raw[k]=r;total+=r;
      }
      for(var k=0;k<count;k++){
        var numerator=Q*scratch.raw[k],w=Math.floor(numerator/total);
        weights[at+k]=w;scratch.rem[k]=numerator-w*total;sum+=w;
        var pos=k;
        while(pos>0&&scratch.rem[scratch.order[pos-1]]<scratch.rem[k]){
          scratch.order[pos]=scratch.order[pos-1];pos--;
        }
        scratch.order[pos]=k;
      }
      for(var k=0;k<Q-sum;k++)weights[at+scratch.order[k]]++;
      var checked=0;for(var k=0;k<count;k++)checked+=weights[at+k];
      if(checked!==Q)throw new Error('Coefficient sum mismatch');
    }
    return {offsets:plan.offsets,indices:indices,weights:weights,max:plan.max};
  }
  function frozenLUT(bytes){
    bytes=stableByteView(bytes,'LUT');
    if(bytes.length!==3072)throw new Error('LUT byte count mismatch');
    for(var i=0;i<3072;i++)if(bytes[i]!==parseInt(LUT_HEX.substr(i*2,2),16))throw new Error('Frozen LUT bytes mismatch');
    var bits=new Uint32Array(768),view=new NativeDataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    for(var i=0;i<768;i++)bits[i]=view.getUint32(i*4,true);
    return bits;
  }
  function preprocessNativeROIAspectRGBA8(input,lutBytes){
    if(!input||input.colorSpace!=='srgb'||input.orientationApplied!==true)throw new Error('Already oriented sRGB declaration required');
    if(Object.prototype.hasOwnProperty.call(input,'percent'))throw new Error('Full-aspect input has no crop percent; localize ROI before this API');
    var originalSource=input.rgba,sourceWidth=input.width,sourceHeight=input.height;
    var source=stableByteView(originalSource,'RGBA');
    dimensions(sourceWidth,sourceHeight,100);
    if(source.length!==sourceWidth*sourceHeight*4)throw new Error('RGBA byte count mismatch');
    var roi=input.nativeROI;
    if(!roi||![roi.x0,roi.y0,roi.x1,roi.y1].every(integer)||roi.x0<0||roi.y0<0||roi.x1>sourceWidth||roi.y1>sourceHeight||roi.x1-roi.x0<3||roi.y1-roi.y0<3)throw new Error('Exact integer native ROI required');
    var width=roi.x1-roi.x0,height=roi.y1-roi.y0;
    dimensions(width,height,100);
    for(var y0=roi.y0;y0<roi.y1;y0++)for(var x0=roi.x0;x0<roi.x1;x0++)if(source[(y0*sourceWidth+x0)*4+3]!==255)throw new Error('Selected native ROI requires opaque alpha255');
    var lut=frozenLUT(lutBytes),edge=Math.max(width,height);
    var offsetX=Math.floor((edge-width)/2),offsetY=Math.floor((edge-height)/2);
    var xp=axisPlan(edge,edge,100),yp=axisPlan(edge,edge,100),max=Math.max(xp.max,yp.max);
    var scratch={raw:new Float64Array(max),rem:new Float64Array(max),order:new Uint16Array(max)};
    var xs=axisCoefficients(xp,scratch),ys=axisCoefficients(yp,scratch);
    var cache=new Uint8Array(ys.max*SIZE*3),tags=new Uint16Array(ys.max);tags.fill(65535);
    var rgb=new Uint8Array(SIZE*SIZE*3),tensor=new Uint8Array(SIZE*SIZE*3*4);
    var view=new NativeDataView(tensor.buffer),horizontalRows=0;
    function fillRow(sourceY,slot){
      var actualY=sourceY-offsetY;
      for(var x=0;x<SIZE;x++){
        var s0=0,s1=0,s2=0;
        for(var k=xs.offsets[x];k<xs.offsets[x+1];k++){
          var actualX=xs.indices[k]-offsetX,w=xs.weights[k];
          if(actualY<0||actualY>=height||actualX<0||actualX>=width){
            s0+=127*w;s1+=127*w;s2+=127*w;
          }else{
            var p=((actualY+roi.y0)*sourceWidth+actualX+roi.x0)*4;
            s0+=source[p]*w;s1+=source[p+1]*w;s2+=source[p+2]*w;
          }
        }
        var at=(slot*SIZE+x)*3;
        cache[at]=Math.floor((s0+Q/2)/Q);cache[at+1]=Math.floor((s1+Q/2)/Q);cache[at+2]=Math.floor((s2+Q/2)/Q);
      }
      tags[slot]=sourceY;horizontalRows++;
    }
    for(var y=0;y<SIZE;y++){
      for(var k=ys.offsets[y];k<ys.offsets[y+1];k++){
        var sourceY=ys.indices[k],slot=sourceY%ys.max;
        if(tags[slot]!==sourceY)fillRow(sourceY,slot);
      }
      for(var x=0;x<SIZE;x++){
        var s0=0,s1=0,s2=0;
        for(var k=ys.offsets[y];k<ys.offsets[y+1];k++){
          var sourceY=ys.indices[k],slot=sourceY%ys.max;
          if(tags[slot]!==sourceY)throw new Error('Rolling cache tag mismatch');
          var at=(slot*SIZE+x)*3,w=ys.weights[k];
          s0+=cache[at]*w;s1+=cache[at+1]*w;s2+=cache[at+2]*w;
        }
        var at=(y*SIZE+x)*3;
        rgb[at]=Math.floor((s0+Q/2)/Q);rgb[at+1]=Math.floor((s1+Q/2)/Q);rgb[at+2]=Math.floor((s2+Q/2)/Q);
      }
    }
    for(var c=0;c<3;c++)for(var k=0;k<SIZE*SIZE;k++)view.setUint32((c*SIZE*SIZE+k)*4,lut[c*256+rgb[k*3+c]],true);
    var buffers={xOffsets:xs.offsets.byteLength,yOffsets:ys.offsets.byteLength,
      xIndices:xs.indices.byteLength,xWeights:xs.weights.byteLength,yIndices:ys.indices.byteLength,yWeights:ys.weights.byteLength,
      coefficientRaw:scratch.raw.byteLength,coefficientRemainders:scratch.rem.byteLength,coefficientOrder:scratch.order.byteLength,
      horizontalRowCache:cache.byteLength,rowTags:tags.byteLength,rgb224:rgb.byteLength,tensorFloat32LE:tensor.byteLength,lutBits:lut.byteLength};
    var owned=Object.keys(buffers).reduce(function(sum,k){return sum+buffers[k];},0);
    return {algorithmVersion:VERSION,lutSha256:LUT_SHA,rgb224:rgb,tensorFloat32LE:tensor,tensorShape:[1,3,SIZE,SIZE],
      geometry:{kind:'full-aspect-virtual-grey-padding',virtualEdge:edge,offsetXY:[offsetX,offsetY],paddingRGBA:[127,127,127,255],inputCrop:false,nativeROI:[roi.x0,roi.y0,roi.x1,roi.y1],nativeSourceDimensions:[sourceWidth,sourceHeight],nativeROIIndexAdapter:'zero-copy-native-roi-view001'},
      memoryLedger:{borrowedRGBAViewBytes:source.byteLength,borrowedRGBABackingBytes:source.buffer.byteLength,borrowedLUTBytes:3072,
        ownedBufferBytes:owned,buffers:buffers,cacheRows:ys.max,horizontalRowsComputed:horizontalRows,
        sourceRGBCopyBytes:0,sourceROICopyBytes:0,fullHeightHorizontalBufferBytes:0,materializedPaddingRGBABytes:0,
        excludes:'Decoder, encoded source, runtime/object/string heap, GC delay and caller hashing/serialization allocations; not a device memory guarantee'}};
  }
  return {VERSION:VERSION,LUT_SHA256:LUT_SHA,SIZE:SIZE,Q:Q,MAX_EDGE:MAX_EDGE,MAX_PIXELS:MAX_PIXELS,
    dimensions:dimensions,axisPlan:axisPlan,axisCoefficients:axisCoefficients,preprocessNativeROIAspectRGBA8:preprocessNativeROIAspectRGBA8};
});
