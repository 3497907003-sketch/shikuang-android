'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const PREFIX='research/shikuang-research-native-roi-q16-torchf32-v1/';
// Exact code/LUT copies reviewed in product-preprocess-profile-resume24-001.
const FROZEN=Object.freeze([
  ['profile.js',4611,'add9cb1436eeaf9f55a86d5e0337976010bf5af3e0f104085dff1a19a76f456a'],
  ['frozen/native-roi-entry.js',6877,'89b45987deb7c59c26fe686eab0bd82473f299894ecf2ba26e79231316a88da2'],
  ['frozen/vendor/native-roi-q16.js',16043,'20272af9408fb4bb9fd63c6f300b2286b923435dce06146d1f086abfce9f02a4'],
  ['frozen/vendor/normalization.js',2905,'7b325ec00c7828aae01d4a42ae3b1212d5b3a095d708769d0602704260c8666a'],
  ['frozen/vendor/normalization-lut.f32le.bin',3072,'9243928c3ab0dbc2609a421c65ce0ed601892a65d273f80dcc6d1e69c72ae159']
]);
const ASSETS=Object.freeze(['research-input.js','research-photo.js',PREFIX+'encoded-header.js',PREFIX+'worker.js',...FROZEN.map(row=>PREFIX+row[0])]);
// canonical30/shared/encoded-header.js retains its exact factory body; only
// host exports were updated for browsers that also expose module.exports.
// Original wrapper: 9655 bytes, e28e1456009e4266204731e135d1cbdfb73c12df295bef3c4820d718b2eabfb8.
const HEADER_PIN=Object.freeze(['encoded-header.js',9773,'d7d1d2993f740bf517e06ca44d98af85d245be0efcc507f6b1a13825193d6993']);
function validate(root){
  for(const [name,size,hash] of [...FROZEN,HEADER_PIN]){const bytes=fs.readFileSync(path.join(root,PREFIX,name));if(bytes.length!==size||crypto.createHash('sha256').update(bytes).digest('hex')!==hash)throw new Error('Frozen research preprocessing dependency changed: '+name);}
  return ASSETS;
}
module.exports={PREFIX,FROZEN,HEADER_PIN,ASSETS,validate};
