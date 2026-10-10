package com.shikuang.app;

import static org.junit.Assert.*;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.SystemClock;
import android.util.Base64;
import android.util.Log;
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

    private File outputDirectory() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File directory = new File(context.getExternalFilesDir(null), "runtime-smoke");
        assertTrue(directory.isDirectory() || directory.mkdirs());
        return directory;
    }

    private void screenshot(String filename) throws Exception {
        SystemClock.sleep(350);
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
                "MineralEngine.analyze=async(...args)=>{try{const r=await window.__smokeRealAnalyze(...args);smoke.lastResult={key:r.key,modelCount:r.modelCount,engine:r.engine,score:r.score,status:r.status};return r;}catch(e){smoke.lastError={name:e.name,message:e.message};throw e;}};",
                "(async()=>{try{",
                " smoke.resources=[];",
                " for(const path of ['engine-worker.js','core.js','vendor/ort.min.js','vendor/ort-wasm-simd-threaded.mjs','vendor/ort-wasm-simd-threaded.wasm','model-manifest.json']){const r=await fetch(new URL(path,location.href));smoke.resources.push({path,status:r.status,type:r.headers.get('content-type')});if(!r.ok)throw new Error(path+' status '+r.status);if(/\\.(?:m?js)$/.test(path)&&!/(?:javascript|ecmascript)/.test(r.headers.get('content-type')||''))throw new Error(path+' wrong script MIME');await r.arrayBuffer();}",
                " smoke.workerProbe={status:'not-attempted'};",
                " if(NativeWorker){await new Promise(resolve=>{let worker;const timer=setTimeout(()=>{smoke.workerProbe.status='no-error-within-3000ms';worker?.terminate();resolve();},3000);try{worker=new Worker(new URL('engine-worker.js',location.href));worker.onerror=e=>{smoke.workerProbe={status:'error',message:e.message,file:e.filename,line:e.lineno,column:e.colno};clearTimeout(timer);worker.terminate();resolve();};worker.onmessage=e=>{smoke.workerProbe={status:'message',message:e.data};clearTimeout(timer);worker.terminate();resolve();};}catch(e){smoke.workerProbe={status:'constructor-error',message:String(e)};clearTimeout(timer);resolve();}});}",
                " smoke.phase='resources';",
                " }catch(e){smoke.phase='failed';smoke.failure=String(e);}})();"
            ));
            JSONObject resources = awaitPhase("resources", 60000);
            assertEquals(98, resources.getInt("labels"));
            assertTrue("Packaged app origin must be secure", resources.getBoolean("secureContext"));
            Log.i(TAG, "Worker probe is diagnostic only; native inference is required: " + resources);

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
            assertEquals(3, result.getInt("modelCount"));
            assertEquals("onnx-native-android", result.getString("engine"));
            assertEquals("石英", evaluate("document.getElementById('resultHeading').textContent"));
            evaluate("document.getElementById('result').scrollIntoView({block:'start',behavior:'instant'});");
            screenshot("quartz-result.png");

            evaluate("document.getElementById('saveBtn').click();");
            deadline = SystemClock.elapsedRealtime() + 30000;
            boolean saved = false;
            do {
                saved = "true".equals(evaluate("!document.getElementById('saveBtn').disabled && document.getElementById('saveBtn').textContent.includes('更新标本')"));
                if (saved) break;
                SystemClock.sleep(100);
            } while (SystemClock.elapsedRealtime() < deadline);
            assertTrue("Quartz record was not saved; preserve the draft instead of starting a new sample", saved);
            evaluate("(async()=>{const s=window.__shikuangRuntimeSmoke;s.savedRecords=(await SpecimenStore.list()).map(r=>({id:r.id,key:r.key,modelCount:r.modelCount,photoCount:r.photoCount}));s.phase='quartz-saved';})();");
            JSONArray savedRecords = awaitPhase("quartz-saved", 30000).getJSONArray("savedRecords");
            assertEquals(1, savedRecords.length());
            assertEquals("quartz", savedRecords.getJSONObject(0).getString("key"));
            assertEquals(3, savedRecords.getJSONObject(0).getInt("modelCount"));
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
            screenshot("dog-rejection.png");
            evaluate("(async()=>{const s=window.__shikuangRuntimeSmoke;s.recordsAfterRejection=(await SpecimenStore.list()).map(r=>({id:r.id,key:r.key,modelCount:r.modelCount}));s.phase='passed';})();");
            JSONArray preserved = awaitPhase("passed", 30000).getJSONArray("recordsAfterRejection");
            assertEquals("Non-mineral rejection must not add or delete a specimen record", 1, preserved.length());
            assertEquals(savedRecords.getJSONObject(0).getString("id"), preserved.getJSONObject(0).getString("id"));
            assertEquals("quartz", preserved.getJSONObject(0).getString("key"));
            assertEquals(3, preserved.getJSONObject(0).getInt("modelCount"));
        } finally {
            writeDiagnostics();
            scenario.close();
        }
    }
}
