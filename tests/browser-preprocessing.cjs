/* Optional real-browser/PIL geometry regression, separate from mocked unit tests.
 * PLAYWRIGHT_MODULE may point to the bundled package; CHROME_BIN selects an installed browser.
 * node tests/browser-preprocessing.cjs <inputs.json> [http://127.0.0.1:8768/]
 */
const fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
  const inputPath=process.argv[2];if(!inputPath)throw new Error('Expected preprocessing fixture inputs.json');
  const inputs=JSON.parse(fs.readFileSync(inputPath,'utf8'));
  const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
  try{
    const page=await browser.newPage();await page.goto(process.argv[3]||'http://127.0.0.1:8768/');
    await page.waitForFunction(()=>!!window.MineralEngine);
    const result=await page.evaluate(async inputs=>{
      const output={cases:[],assertions:[]};
      const encoded=bytes=>{let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s);};
      const decodedPixels=image=>{const c=document.createElement('canvas');c.width=image.naturalWidth;c.height=image.naturalHeight;const ctx=c.getContext('2d');ctx.drawImage(image,0,0);return ctx.getImageData(0,0,c.width,c.height).data;};
      for(const fixture of inputs.cases){
        const image=await MineralEngine.image(fixture.data);
        if(image.naturalWidth!==fixture.width||image.naturalHeight!==fixture.height)throw new Error(fixture.name+' EXIF dimensions incorrect');
        const row={name:fixture.name,width:image.naturalWidth,height:image.naturalHeight,crops:[]};
        if(fixture.reference){const expected=decodedPixels(await MineralEngine.image(fixture.reference)),actual=decodedPixels(image);let max=0,sum=0;for(let i=0;i<actual.length;i++){if(i%4===3)continue;const diff=Math.abs(expected[i]-actual[i]);max=Math.max(max,diff);sum+=diff;}
          if(max>4)throw new Error(fixture.name+' EXIF pixels differ (max RGB '+max+')');output.assertions.push({name:fixture.name,orientation:fixture.orientation,decoderRgbAbsMax:max,decoderRgbAbsMean:sum/(actual.length/4*3),passed:true});}
        for(const crop of fixture.crops){let geometry;
          const original=CanvasRenderingContext2D.prototype.drawImage;
          CanvasRenderingContext2D.prototype.drawImage=function(...args){geometry=args.slice(1);return original.apply(this,args);};
          let canvas;try{canvas=MineralEngine.cropCanvas(image,224,crop);}finally{CanvasRenderingContext2D.prototype.drawImage=original;}
          row.crops.push({crop,geometry,pixels:encoded(canvas.getContext('2d').getImageData(0,0,224,224).data)});
        }
        output.cases.push(row);
      }
      return output;
    },inputs);
    result.browser={version:browser.version(),userAgent:await page.evaluate(()=>navigator.userAgent),physicalDevice:false};
    const target=path.join(path.dirname(inputPath),'browser-results.json');fs.writeFileSync(target,JSON.stringify(result));console.log(JSON.stringify({cases:result.cases.length,exifChecks:result.assertions.length,output:target}));
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
