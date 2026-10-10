package com.shikuang.app;

import static org.junit.Assert.*;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkInfo;
import android.os.Build;
import android.os.SystemClock;
import android.util.Base64;
import android.util.Log;
import android.webkit.WebView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Runs the installed app's real HTML, preprocessing, native ONNX engine and UI. */
@RunWith(AndroidJUnit4.class)
public class MineralEngineInstrumentedTest {
    private static final String TAG = "ShikuangRuntimeSmoke";
    private static final String NON_MINERAL = "这不是矿物，请您放入清晰的矿物照片。";
    private ActivityScenario<MainActivity> scenario;

    private static String script(String... lines) {
        return String.join("\n", lines);
    }

    /** evaluateJavascript callbacks run on the UI thread; wait only on the test thread. */
    private String evaluate(String source) throws Exception {
        CountDownLatch returned = new CountDownLatch(1);
        AtomicReference<String> value = new AtomicReference<>();
        scenario.onActivity(activity -> activity.getBridge().getWebView().evaluateJavascript(source, result -> {
            value.set(result);
            returned.countDown();
        }));
        assertTrue("WebView JS callback timed out", returned.await(10, TimeUnit.SECONDS));
        Object decoded = new JSONArray("[" + value.get() + "]").get(0);
        return decoded == JSONObject.NULL ? "null" : decoded.toString();
    }

    private JSONObject state() throws Exception {
        return new JSONObject(evaluate("JSON.stringify(window.__shikuangRuntimeSmoke || {})"));
    }

    private String shellOutput(String command) throws Exception {
        try (InputStream stream = new android.os.ParcelFileDescriptor.AutoCloseInputStream(
            InstrumentationRegistry.getInstrumentation().getUiAutomation().executeShellCommand(command))) {
            java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            int read;
            while ((read = stream.read(buffer)) != -1) output.write(buffer, 0, read);
            return new String(output.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    private JSONObject nativeNetworkState() throws Exception {
        AtomicReference<JSONObject> value = new AtomicReference<>();
        scenario.onActivity(activity -> {
            ConnectivityManager manager = (ConnectivityManager) activity.getSystemService(Context.CONNECTIVITY_SERVICE);
            Network active = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? manager.getActiveNetwork() : null;
            NetworkCapabilities capabilities = active == null ? null : manager.getNetworkCapabilities(active);
            NetworkInfo info = manager.getActiveNetworkInfo();
            try {
                value.set(new JSONObject()
                    .put("sdk", Build.VERSION.SDK_INT)
                    .put("activeNetwork", active == null ? JSONObject.NULL : active.toString())
                    .put("connected", info != null && info.isConnected())
                    .put("internetCapability", capabilities != null && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET))
                    .put("validated", capabilities != null && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)));
            } catch (org.json.JSONException error) {
                throw new AssertionError(error);
            }
        });
        return value.get();
    }

    private JSONObject awaitPhase(String phase, long timeoutMillis) throws Exception {
        long end = SystemClock.elapsedRealtime() + timeoutMillis;
        JSONObject latest = new JSONObject();
        do {
            latest = state();
            if (phase.equals(latest.optString("phase"))) return latest;
            if ("failed".equals(latest.optString("phase"))) fail(latest.toString());
            SystemClock.sleep(150);
        } while (SystemClock.elapsedRealtime() < end);
        fail("Timed out waiting for " + phase + ": " + latest);
        return latest;
    }

    private void awaitPage() throws Exception {
        long end = SystemClock.elapsedRealtime() + 60000;
        do {
            if ("true".equals(evaluate("!!(window.MineralEngine && window.MINERAL_CLASSES && document.getElementById('predictBtn'))"))) return;
            SystemClock.sleep(150);
        } while (SystemClock.elapsedRealtime() < end);
        fail("Packaged main page did not initialize");
    }

    private String fixture(String name) throws Exception {
        Context testContext = InstrumentationRegistry.getInstrumentation().getContext();
        Bitmap source;
        try (InputStream stream = testContext.getAssets().open(name)) {
            source = BitmapFactory.decodeStream(stream);
        }
        assertNotNull("Cannot decode fixture " + name, source);
        float scale = Math.min(1f, 640f / Math.max(source.getWidth(), source.getHeight()));
        Bitmap resized = Bitmap.createScaledBitmap(source,
            Math.round(source.getWidth() * scale), Math.round(source.getHeight() * scale), true);
        java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
        assertTrue(resized.compress(Bitmap.CompressFormat.JPEG, 95, bytes));
        String data = "data:image/jpeg;base64," + Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP);
        if (resized != source) resized.recycle();
        source.recycle();
        return data;
    }

    private String encodedAsset(String name, String mime) throws Exception {
        try (InputStream stream = InstrumentationRegistry.getInstrumentation().getContext().getAssets().open(name)) {
            java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();byte[] buffer = new byte[4096];int count;
            while ((count=stream.read(buffer)) != -1) bytes.write(buffer,0,count);
            return "data:"+mime+";base64,"+Base64.encodeToString(bytes.toByteArray(),Base64.NO_WRAP);
        }
    }

    private void checkPhotoGeometry() throws Exception {
        String exif=encodedAsset("quartz-exif6.jpg","image/jpeg"),upright=encodedAsset("quartz-exif6-upright.png","image/png");
        evaluate(script(
            "(async()=>{const s=window.__shikuangRuntimeSmoke;s.phase='geometry-running';try{",
            " const jpeg=await MineralEngine.image("+JSONObject.quote(exif)+"),png=await MineralEngine.image("+JSONObject.quote(upright)+");",
            " if(jpeg.naturalWidth!==320||jpeg.naturalHeight!==512||png.naturalWidth!==320||png.naturalHeight!==512)throw new Error('EXIF 6 photo was not rotated upright');",
            " const draw=image=>{const c=document.createElement('canvas');c.width=image.naturalWidth;c.height=image.naturalHeight;const x=c.getContext('2d');x.drawImage(image,0,0);return x.getImageData(0,0,c.width,c.height).data;};",
            " const difference=(a,b)=>{let maximum=0;for(let i=0;i<a.length;i++)if(i%4!==3)maximum=Math.max(maximum,Math.abs(a[i]-b[i]));return maximum;};",
            " const decoderRgbAbsMax=difference(draw(jpeg),draw(png));if(decoderRgbAbsMax>4)throw new Error('EXIF decoder differs from upright reference');",
            " const crops=[];for(const crop of [1,.75,.5]){let geometry;const original=CanvasRenderingContext2D.prototype.drawImage;CanvasRenderingContext2D.prototype.drawImage=function(...args){geometry=args.slice(1);return original.apply(this,args);};let canvas;try{canvas=MineralEngine.cropCanvas(jpeg,224,crop);}finally{CanvasRenderingContext2D.prototype.drawImage=original;}",
            " const side=320*crop,expected=[(320-side)/2,(512-side)/2,side,side,0,0,224,224];if(JSON.stringify(geometry)!==JSON.stringify(expected))throw new Error('Center-square ROI geometry changed');",
            " const uprightCrop=MineralEngine.cropCanvas(png,224,crop),max=difference(canvas.getContext('2d').getImageData(0,0,224,224).data,uprightCrop.getContext('2d').getImageData(0,0,224,224).data);if(max>4)throw new Error('ROI differs after EXIF normalization');crops.push({crop,geometry,decoderRgbAbsMax:max});}",
            " s.photoGeometry={source:'Derived from existing quartz smoke photo; algorithm regression only, no accuracy claim',exifOrientation:6,width:jpeg.naturalWidth,height:jpeg.naturalHeight,decoderRgbAbsMax,crops,pilCanvasResizePixelParityClaim:false};s.phase='geometry-passed';",
            " }catch(e){s.phase='failed';s.failure=String(e);}})();"
        ));
        awaitPhase("geometry-passed",30000);
    }

    private File outputDirectory() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File directory = new File(context.getExternalFilesDir(null), "runtime-smoke");
        assertTrue(directory.isDirectory() || directory.mkdirs());
        return directory;
    }

    private JSONObject bundledJson(String path) throws Exception {
        try (InputStream stream = InstrumentationRegistry.getInstrumentation().getTargetContext().getAssets().open("public/" + path)) {
            java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream(); byte[] buffer = new byte[4096]; int count;
            while ((count = stream.read(buffer)) != -1) { bytes.write(buffer,0,count); assertTrue("Oversized test metadata", bytes.size() <= 10_000_000); }
            return new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8));
        }
    }

    private void screenshot(String filename, String selector) throws Exception {
        awaitUi("(() => {const e=document.querySelector(" + JSONObject.quote(selector) + ");if(!e)return false;const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth;})()",
            "visible screenshot target " + selector,10000);
        awaitUi("!document.getElementById('toast') || document.getElementById('toast').hidden", "toast to finish naturally",10000);
        CountDownLatch drawn = new CountDownLatch(1);
        scenario.onActivity(activity -> {
            WebView view = activity.getBridge().getWebView();
            Runnable nextFrames = () -> { view.invalidate(); view.postOnAnimation(() -> view.postOnAnimation(drawn::countDown)); };
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) view.postVisualStateCallback(SystemClock.elapsedRealtime(),new WebView.VisualStateCallback() {
                @Override public void onComplete(long id) { nextFrames.run(); }
            });
            else nextFrames.run();
        });
        assertTrue("WebView visual state did not become drawable",drawn.await(10,TimeUnit.SECONDS));
        SystemClock.sleep(150);
        evaluate("(() => {const e=document.querySelector(" + JSONObject.quote(selector) + "),r=e.getBoundingClientRect(),s=window.__shikuangRuntimeSmoke;s.screenshots=s.screenshots||[];s.screenshots.push({filename:" + JSONObject.quote(filename) + ",selector:" + JSONObject.quote(selector) + ",text:e.textContent.slice(0,600),rect:{top:r.top,bottom:r.bottom,left:r.left,right:r.right},viewport:{width:innerWidth,height:innerHeight},visualStateSynchronized:true});})()");
        Bitmap bitmap = InstrumentationRegistry.getInstrumentation().getUiAutomation().takeScreenshot();
        assertNotNull("Screenshot unavailable", bitmap);
        try (FileOutputStream stream = new FileOutputStream(new File(outputDirectory(), filename))) {
            assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream));
        } finally {
            bitmap.recycle();
        }
    }

    private void writeDiagnostics() {
        try {
            JSONObject report = state();
            Log.i(TAG, report.toString());
            try (FileOutputStream stream = new FileOutputStream(new File(outputDirectory(), "runtime-report.json"))) {
                stream.write(report.toString(2).getBytes(StandardCharsets.UTF_8));
            }
        } catch (Exception error) {
            Log.e(TAG, "Could not save runtime diagnostics", error);
        }
    }

    private void submitFixture(String data, String name) throws Exception {
        evaluate(script(
            "(() => {",
            " const binary=atob(" + JSONObject.quote(data.substring(data.indexOf(',') + 1)) + ");",
            " const bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));",
            " const transfer=new DataTransfer();",
            " transfer.items.add(new File([bytes]," + JSONObject.quote(name) + ",{type:'image/jpeg'}));",
            " const input=document.getElementById('fileInput');input.files=transfer.files;",
            " input.dispatchEvent(new Event('change',{bubbles:true}));",
            "})()"
        ));
        long end = SystemClock.elapsedRealtime() + 20000;
        do {
            if ("true".equals(evaluate("!document.getElementById('predictBtn').disabled"))) return;
            SystemClock.sleep(100);
        } while (SystemClock.elapsedRealtime() < end);
        fail("Photo file UI remained unavailable: " + evaluate("document.getElementById('progress').textContent"));
    }

    private void awaitUi(String predicate, String description, long timeoutMillis) throws Exception {
        long end = SystemClock.elapsedRealtime() + timeoutMillis;
        do {
            if ("true".equals(evaluate("!!(" + predicate + ")"))) return;
            SystemClock.sleep(150);
        } while (SystemClock.elapsedRealtime() < end);
        fail("Timed out waiting for " + description + ": " + evaluate("document.getElementById('catalogLoadState')?.textContent || 'No catalog UI'"));
    }

    /** Exercise the real lazy loader, SHA-256 checks, searches and detail dialogs while disconnected. */
    private void checkOfflineReferenceCatalog() throws Exception {
        JSONObject reference = bundledJson("data/reference-manifest.json"),counts=reference.getJSONObject("counts");
        int species = counts.getInt("ima_species"),crystals=counts.getInt("species_with_records");
        int images = bundledJson("data/image-sources.json").getJSONArray("records").length();
        assertEquals("Reference collection should not delay mineral inference", "idle",
            evaluate("window.MineralReference?.status"));
        evaluate(script(
            "(() => {const s=window.__shikuangRuntimeSmoke;s.phase='library-loading';s.catalogFetches=[];",
            " const realFetch=window.fetch.bind(window);",
            " window.fetch=async(...args)=>{const response=await realFetch(...args);const url=new URL(args[0] instanceof Request?args[0].url:String(args[0]),location.href);if(/\\/data\\/(reference-manifest|catalog|crystals|image-sources)\\.json$/.test(url.pathname))s.catalogFetches.push({path:url.pathname,url:url.href,status:response.status,type:response.headers.get('content-type'),local:url.origin===location.origin});return response;};",
            " document.querySelector('[data-view=library]').click();})()"
        ));
        awaitUi("window.MineralReference?.status==='ready' && document.getElementById('catalogLoadState').textContent.includes('" + species + "')",
            species + "-species packaged reference collection", 60000);
        JSONObject catalog = new JSONObject(evaluate(script(
            "JSON.stringify({imaSpecies:MINERAL_CATALOG.minerals.length,crystalSpecies:Object.keys(MINERAL_CRYSTAL_RECORDS.by_species).length,imageReferences:MINERAL_IMAGE_SOURCES.records.length,completed:MineralReference.completed,online:navigator.onLine,cardsShown:document.querySelectorAll('#libraryList [data-detail]').length,intro:document.getElementById('catalogIntro').textContent,localFetches:window.__shikuangRuntimeSmoke.catalogFetches.length})"
        )));
        assertEquals(species, catalog.getInt("imaSpecies"));
        assertEquals(crystals, catalog.getInt("crystalSpecies"));
        assertEquals(images, catalog.getInt("imageReferences"));
        assertEquals(reference.getJSONArray("files").length(), catalog.getInt("completed"));
        assertEquals(80, catalog.getInt("cardsShown"));
        assertFalse("Catalog must load while WebView detects unavailable networking", catalog.getBoolean("online"));
        assertTrue(catalog.getString("intro").contains(String.valueOf(images)));
        assertTrue(catalog.getString("intro").contains(String.valueOf(crystals)));
        JSONArray fetches = state().getJSONArray("catalogFetches");
        assertEquals("Manifest and all reference files must be read locally", 1+reference.getJSONArray("files").length(), fetches.length());
        for (int index = 0; index < fetches.length(); index++) {
            JSONObject request = fetches.getJSONObject(index);
            assertTrue("Reference request left packaged app origin: " + request, request.getBoolean("local"));
            assertEquals(200, request.getInt("status"));
        }
        assertEquals(state().getJSONObject("modelContract").getInt("labels"),Integer.parseInt(evaluate("Object.keys(MINERAL_CLASSES).length")));
        evaluate("window.__shikuangRuntimeSmoke.catalog=" + catalog + ";window.scrollTo({top:0,behavior:'instant'});");
        screenshot("library-offline-overview.png", "#catalogIntro");

        evaluate("const quartzSearch=document.getElementById('librarySearch');quartzSearch.value='Quartz';quartzSearch.dispatchEvent(new Event('input',{bubbles:true}));");
        awaitUi("document.querySelector('#libraryList [data-detail=quartz]')", "Quartz search card", 10000);
        evaluate("document.querySelector('#libraryList [data-detail=quartz]').click();");
        awaitUi("document.getElementById('detailDialog').open && document.getElementById('detailTitle').textContent==='石英'", "Quartz reference detail", 10000);
        assertTrue(evaluate("document.getElementById('detailBody').textContent").contains("Quartz"));
        assertTrue(evaluate("document.getElementById('detailBody').textContent").contains("官方目录字段"));
        assertTrue(evaluate("document.getElementById('crystalRecords').textContent").contains("空间群"));
        assertEquals("5", evaluate("document.querySelectorAll('#crystalRecords .crystal-record').length"));
        evaluate("document.getElementById('detailDialog').scrollTop=0;");
        screenshot("quartz-reference-details.png", "#detailTitle");
        evaluate(script(
            "document.querySelector('#detailBody .image-section').open=true;",
            "document.querySelector('#detailBody .image-section').scrollIntoView({block:'start',behavior:'instant'});",
            "window.__shikuangRuntimeSmoke.quartzReference={title:document.getElementById('detailTitle').textContent,crystalRecordsShown:document.querySelectorAll('#crystalRecords .crystal-record').length,imageRecordsTotal:MINERAL_IMAGE_SOURCES.records.filter(row=>row.mineral_name==='Quartz').length,imageRecordsShown:document.querySelectorAll('#imageRecords .image-record').length,imageEvidence:document.getElementById('imageRecords').textContent};"
        ));
        JSONObject quartzReference = state().getJSONObject("quartzReference");
        assertTrue("Packaged Quartz image-source metadata must be present", quartzReference.getInt("imageRecordsTotal") > 0);
        assertEquals(Math.min(5, quartzReference.getInt("imageRecordsTotal")), quartzReference.getInt("imageRecordsShown"));
        assertTrue(evaluate("document.getElementById('imageRecords').textContent").contains("尚未通过训练审核"));
        assertEquals("0", evaluate("document.querySelectorAll('#imageRecords img').length"));
        screenshot("quartz-image-references.png", "#imageRecords");
        evaluate("document.getElementById('closeDetail').click();const rareSearch=document.getElementById('librarySearch');rareSearch.value='Abellaite';rareSearch.dispatchEvent(new Event('input',{bubbles:true}));");
        awaitUi("document.querySelector('#libraryList [data-detail=\"catalog:ima-abellaite\"]')", "Abellaite search card", 10000);
        evaluate("document.querySelector('#libraryList [data-detail=\"catalog:ima-abellaite\"]').click();");
        awaitUi("document.getElementById('detailDialog').open && document.getElementById('detailTitle').textContent==='Abellaite'", "Abellaite reference detail", 10000);
        String rareDetails = evaluate("document.getElementById('detailBody').textContent");
        assertEquals("NaPb₂(CO₃)₂(OH)",evaluate("document.querySelector('#detailBody .formula').getAttribute('aria-label')"));
        assertEquals("true",evaluate("document.querySelectorAll('#detailBody .formula sub').length>0"));
        assertTrue(rareDetails.contains("2014-111"));
        assertTrue(rareDetails.contains("Spain"));
        assertTrue(rareDetails.contains("空间群"));
        assertFalse("Directory-only mineral must not claim model recognition", evaluate("document.getElementById('detailType').textContent").contains("图像模型支持"));
        evaluate("window.__shikuangRuntimeSmoke.abellaiteReference={title:document.getElementById('detailTitle').textContent,type:document.getElementById('detailType').textContent,details:document.getElementById('detailBody').textContent};document.getElementById('detailDialog').scrollTop=0;");
        screenshot("abellaite-reference-details.png", "#detailTitle");
        String finalRoutes4 = shellOutput("ip route show");
        String finalRoutes6 = shellOutput("ip -6 route show");
        assertFalse("IPv4 default route returned during catalog load", finalRoutes4.contains("default "));
        assertFalse("IPv6 default route returned during catalog load", finalRoutes6.contains("default "));
        JSONObject nativeNetwork = nativeNetworkState();
        assertTrue("Android gained an active network during catalog load: " + nativeNetwork, nativeNetwork.isNull("activeNetwork"));
        assertFalse(nativeNetwork.getBoolean("connected"));
        assertEquals("false", evaluate("navigator.onLine"));
        evaluate("window.__shikuangRuntimeSmoke.networkAfterCatalog={ipv4Routes:" + JSONObject.quote(finalRoutes4)
            + ",ipv6Routes:" + JSONObject.quote(finalRoutes6) + ",native:" + nativeNetwork + "};window.__shikuangRuntimeSmoke.phase='passed';");
    }

    @Test
    public void offlinePackagedNativeRecognitionAndRecovery() throws Exception {
        scenario = ActivityScenario.launch(MainActivity.class);
        try {
            awaitPage();
            evaluate(script(
                "window.__shikuangRuntimeSmoke={phase:'started',logs:[],errors:[],origin:location.origin,online:navigator.onLine,userAgent:navigator.userAgent,secureContext:isSecureContext,wasm:typeof WebAssembly,labels:Object.keys(MINERAL_CLASSES).length};",
                "const smoke=window.__shikuangRuntimeSmoke;",
                "const log=(kind,value)=>{smoke.logs.push({kind,value:String(value)});if(smoke.logs.length>60)smoke.logs.shift();};",
                "addEventListener('error',e=>smoke.errors.push({message:e.message,file:e.filename,line:e.lineno,column:e.colno}));",
                "addEventListener('unhandledrejection',e=>smoke.errors.push({rejection:String(e.reason)}));",
                "for(const level of ['log','warn','error']){const original=console[level].bind(console);console[level]=(...args)=>{log(level,args.join(' '));original(...args);};}",
                "const NativeWorker=window.Worker;",
                "if(NativeWorker){window.Worker=function(...args){try{const worker=new NativeWorker(...args);worker.addEventListener('error',e=>smoke.errors.push({worker:args[0].toString(),message:e.message,file:e.filename,line:e.lineno,column:e.colno}));return worker;}catch(e){smoke.errors.push({workerConstructor:String(e)});throw e;}};window.Worker.prototype=NativeWorker.prototype;Object.setPrototypeOf(window.Worker,NativeWorker);}",
                "window.__smokeRealAnalyze=MineralEngine.analyze.bind(MineralEngine);",
                "MineralEngine.analyze=async(...args)=>{try{const r=await window.__smokeRealAnalyze(...args);smoke.lastResult={key:r.key,modelCount:r.modelCount,engine:r.engine,score:r.score,status:r.status,modelVersion:r.modelVersion,manifestSha256:r.manifestSha256,diagnostics:r.diagnostics};return r;}catch(e){smoke.lastError={name:e.name,message:e.message};throw e;}};",
                "(async()=>{try{",
                " smoke.resources=[];",
                " for(const path of ['engine-worker.js','core.js','vendor/ort.min.js','vendor/ort-wasm-simd-threaded.mjs','vendor/ort-wasm-simd-threaded.wasm','model-manifest.json']){const r=await fetch(new URL(path,location.href));smoke.resources.push({path,status:r.status,type:r.headers.get('content-type')});if(!r.ok)throw new Error(path+' status '+r.status);if(/\\.(?:m?js)$/.test(path)&&!/(?:javascript|ecmascript)/.test(r.headers.get('content-type')||''))throw new Error(path+' wrong script MIME');await r.arrayBuffer();}",
                " smoke.workerProbe={status:'not-attempted'};",
                " if(NativeWorker){await new Promise(resolve=>{let worker;const timer=setTimeout(()=>{smoke.workerProbe.status='no-error-within-3000ms';worker?.terminate();resolve();},3000);try{worker=new Worker(new URL('engine-worker.js',location.href));worker.onerror=e=>{smoke.workerProbe={status:'error',message:e.message,file:e.filename,line:e.lineno,column:e.colno};clearTimeout(timer);worker.terminate();resolve();};worker.onmessage=e=>{smoke.workerProbe={status:'message',message:e.data};clearTimeout(timer);worker.terminate();resolve();};}catch(e){smoke.workerProbe={status:'constructor-error',message:String(e)};clearTimeout(timer);resolve();}});}",
                " const config=await MineralEngine.prepare();smoke.modelContract={modelVersion:config.version,labels:config.labels.length,ensembleIds:config.modes.ensemble,fastIds:config.modes.fast,input:config.input};",
                " smoke.phase='resources';",
                " }catch(e){smoke.phase='failed';smoke.failure=String(e);}})();"
            ));
            JSONObject resources = awaitPhase("resources", 60000);
            JSONObject contract = resources.getJSONObject("modelContract");
            assertEquals(bundledJson("model-manifest.json").getJSONArray("labels").length(),resources.getInt("labels"));
            assertEquals(contract.getInt("labels"),resources.getInt("labels"));
            int expectedModels = contract.getJSONArray("ensembleIds").length();
            assertTrue(expectedModels >= 2 && expectedModels <= 3);
            assertEquals(1,contract.getJSONArray("fastIds").length());
            assertTrue("Packaged app origin must be secure", resources.getBoolean("secureContext"));
            String routes4 = shellOutput("ip route show");
            String routes6 = shellOutput("ip -6 route show");
            JSONObject nativeNetwork = nativeNetworkState();
            evaluate("window.__shikuangRuntimeSmoke.network={ipv4Routes:" + JSONObject.quote(routes4)
                + ",ipv6Routes:" + JSONObject.quote(routes6) + ",native:" + nativeNetwork + "};");
            assertFalse("External IPv4 default route remains active: " + routes4, routes4.contains("default "));
            assertFalse("External IPv6 default route remains active: " + routes6, routes6.contains("default "));
            assertTrue("Android must report no active network: " + nativeNetwork, nativeNetwork.isNull("activeNetwork"));
            assertFalse(nativeNetwork.getBoolean("connected"));
            assertFalse("WebView should detect unavailable networking", resources.getBoolean("online"));
            Log.i(TAG, "Worker probe is diagnostic only; native inference is required: " + resources);

            checkPhotoGeometry();

            String quartz = fixture("quartz.jpg");
            evaluate(script(
                "window.__shikuangRuntimeSmoke.phase='cancelling';",
                "(async()=>{const s=window.__shikuangRuntimeSmoke,c=new AbortController();const timer=setTimeout(()=>{s.cancelTrigger='deadline';c.abort();},30000);try{",
                " await window.__smokeRealAnalyze([{src:" + JSONObject.quote(quartz) + ",crop:1}],{precision:true,signal:c.signal,report:message=>{s.logs.push({kind:'cancel-progress',value:message});if(/输入筛查|读取|初始化|分析图像/.test(message)&&!c.signal.aborted){s.cancelTrigger='native-progress';c.abort();}}});",
                " s.phase='failed';s.failure='Cancelled native inference unexpectedly resolved';",
                " }catch(e){s.cancelError={name:e.name,message:e.message};s.phase=e.name==='AbortError'?'cancelled':'failed';if(s.phase==='failed')s.failure=String(e);}finally{clearTimeout(timer);}})();"
            ));
            JSONObject cancellation = awaitPhase("cancelled", 180000);
            assertEquals("native-progress", cancellation.getString("cancelTrigger"));
            assertEquals("AbortError", cancellation.getJSONObject("cancelError").getString("name"));

            submitFixture(quartz, "quartz.jpg");
            evaluate("window.__shikuangRuntimeSmoke.phase='quartz-ui';document.getElementById('precision').checked=true;document.getElementById('predictBtn').click();");
            long deadline = SystemClock.elapsedRealtime() + 180000;
            JSONObject quartzState = null;
            do {
                quartzState = state();
                if (quartzState.has("lastError")) fail(quartzState.toString());
                if (quartzState.has("lastResult") && "true".equals(evaluate("!document.getElementById('result').hidden && !document.getElementById('predictBtn').disabled"))) break;
                SystemClock.sleep(150);
            } while (SystemClock.elapsedRealtime() < deadline);
            assertNotNull(quartzState);
            assertTrue("Quartz result timed out: " + quartzState, quartzState.has("lastResult"));
            JSONObject result = quartzState.getJSONObject("lastResult");
            assertEquals("quartz", result.getString("key"));
            assertEquals(expectedModels, result.getInt("modelCount"));
            assertEquals("onnx-native-android", result.getString("engine"));
            assertEquals(contract.getString("modelVersion"),result.getString("modelVersion"));
            assertTrue(result.getString("manifestSha256").matches("[a-f0-9]{64}"));
            assertTrue(result.getJSONObject("diagnostics").getLong("elapsedMs") > 0);
            assertTrue(result.getJSONObject("diagnostics").getInt("residentSessionCount") <= expectedModels+1);
            assertEquals("石英", evaluate("document.getElementById('resultHeading').textContent"));
            evaluate("document.getElementById('result').scrollIntoView({block:'start',behavior:'instant'});");
            screenshot("quartz-result.png", "#resultHeading");

            evaluate(script(
                "(async()=>{const s=window.__shikuangRuntimeSmoke;s.phase='fast-running';try{const r=await window.__smokeRealAnalyze([{src:"+JSONObject.quote(quartz)+",crop:1}],{precision:false});s.fast={key:r.key,modelCount:r.modelCount,modelVersion:r.modelVersion,manifestSha256:r.manifestSha256,engine:r.engine,diagnostics:r.diagnostics};s.phase='fast-passed';}catch(e){s.phase='failed';s.failure=String(e);}})();"
            ));
            JSONObject fast = awaitPhase("fast-passed",180000).getJSONObject("fast");
            assertEquals(1,fast.getInt("modelCount"));
            assertEquals("onnx-native-android",fast.getString("engine"));
            assertEquals(result.getString("modelVersion"),fast.getString("modelVersion"));
            assertEquals(result.getString("manifestSha256"),fast.getString("manifestSha256"));
            assertTrue("Fast mode must release unselected resident classifiers",fast.getJSONObject("diagnostics").getInt("residentSessionCount") <= 2);

            evaluate("document.getElementById('saveBtn').click();");
            deadline = SystemClock.elapsedRealtime() + 30000;
            boolean saved = false;
            do {
                saved = "true".equals(evaluate("!document.getElementById('saveBtn').disabled && document.getElementById('saveBtn').textContent.includes('更新标本')"));
                if (saved) break;
                SystemClock.sleep(100);
            } while (SystemClock.elapsedRealtime() < deadline);
            assertTrue("Quartz record was not saved; preserve the draft instead of starting a new sample", saved);
            evaluate("(async()=>{const s=window.__shikuangRuntimeSmoke;s.savedRecords=(await SpecimenStore.list()).map(r=>({id:r.id,key:r.key,modelCount:r.modelCount,photoCount:r.photoCount,modelVersion:r.modelVersion,manifestSha256:r.manifestSha256}));s.phase='quartz-saved';})();");
            JSONArray savedRecords = awaitPhase("quartz-saved", 30000).getJSONArray("savedRecords");
            assertEquals(1, savedRecords.length());
            assertEquals("quartz", savedRecords.getJSONObject(0).getString("key"));
            assertEquals(expectedModels, savedRecords.getJSONObject(0).getInt("modelCount"));
            assertEquals(result.getString("modelVersion"),savedRecords.getJSONObject(0).getString("modelVersion"));
            assertEquals(result.getString("manifestSha256"),savedRecords.getJSONObject(0).getString("manifestSha256"));
            assertEquals(1, savedRecords.getJSONObject(0).getInt("photoCount"));

            evaluate("window.__shikuangRuntimeSmoke.quartz=window.__shikuangRuntimeSmoke.lastResult;delete window.__shikuangRuntimeSmoke.lastResult;delete window.__shikuangRuntimeSmoke.lastError;document.getElementById('newSample').click();");
            submitFixture(fixture("dog.jpg"), "dog.jpg");
            evaluate("document.getElementById('predictBtn').click();");
            deadline = SystemClock.elapsedRealtime() + 180000;
            JSONObject dogState;
            do {
                dogState = state();
                if (dogState.has("lastError") && "true".equals(evaluate("!document.getElementById('predictBtn').disabled"))) break;
                SystemClock.sleep(150);
            } while (SystemClock.elapsedRealtime() < deadline);
            assertTrue("Dog rejection timed out: " + dogState, dogState.has("lastError"));
            assertEquals(NON_MINERAL, dogState.getJSONObject("lastError").getString("message"));
            assertEquals(NON_MINERAL, evaluate("document.getElementById('progress').textContent"));
            assertEquals("true", evaluate("document.getElementById('result').hidden"));
            evaluate("document.getElementById('progress').scrollIntoView({block:'center',behavior:'instant'});");
            screenshot("dog-rejection.png", "#progress");
            evaluate("(async()=>{const s=window.__shikuangRuntimeSmoke;s.recordsAfterRejection=(await SpecimenStore.list()).map(r=>({id:r.id,key:r.key,modelCount:r.modelCount}));s.phase='passed';})();");
            JSONArray preserved = awaitPhase("passed", 30000).getJSONArray("recordsAfterRejection");
            assertEquals("Non-mineral rejection must not add or delete a specimen record", 1, preserved.length());
            assertEquals(savedRecords.getJSONObject(0).getString("id"), preserved.getJSONObject(0).getString("id"));
            assertEquals("quartz", preserved.getJSONObject(0).getString("key"));
            assertEquals(expectedModels, preserved.getJSONObject(0).getInt("modelCount"));
            checkOfflineReferenceCatalog();
        } finally {
            writeDiagnostics();
            scenario.close();
        }
    }
}
