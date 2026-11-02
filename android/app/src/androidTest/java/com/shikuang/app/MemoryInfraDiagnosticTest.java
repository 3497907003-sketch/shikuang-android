package com.shikuang.app;

import static org.junit.Assert.*;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.os.Bundle;
import android.os.Debug;
import android.os.SystemClock;
import android.util.Base64;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FileInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;
import org.json.JSONArray;
import org.json.JSONTokener;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Explicit diagnostic only: exact class#observeArm filter, never default acceptance. */
@RunWith(AndroidJUnit4.class)
public class MemoryInfraDiagnosticTest extends MineralEngineInstrumentedTest {
    static final String BASE_SOURCE = "5a004ef9e121c3039df0645b0e08e2b27decb99f";
    static final String OBSERVER_SHA = "887863620cd5f3bcb9499ccb5b24a1430cac0e50634a1de9f7a56a4a40c02031";
    static final String MANIFEST_SHA = "ddbe27e79489df0ff63647b37c17f701e458a59e076df14d47d93873085ae7fa";
    static final Set<String> ARMS = new HashSet<>(Arrays.asList(
        "catalog-detail-only", "native-inference-only", "combined-first-detail"));
    static final long OBSERVE_MS = 30000, SAMPLE_MS = 2000;
    private static final AtomicBoolean STARTED = new AtomicBoolean();
    private Journal journal;

    static String arg(Bundle args, String name, String pattern) {
        String value = args.getString(name, "");
        assertTrue("Missing/invalid exact diagnostic argument: " + name, value.matches(pattern));
        return value;
    }

    @Test public void observeArm() throws Exception {
        Bundle args = InstrumentationRegistry.getArguments();
        assertEquals("true", args.getString("memoryInfraDiagnostic"));
        assertEquals("com.shikuang.app.MemoryInfraDiagnosticTest#observeArm", args.getString("class"));
        assertTrue("Only one arm/method per fresh AppPID", STARTED.compareAndSet(false, true));
        String arm = arg(args, "memoryInfraArm", "[a-z-]{1,32}");
        assertTrue("Unknown diagnostic arm", ARMS.contains(arm));
        String nonce = arg(args, "diagnosticNonce", "[a-f0-9]{32}");
        String source = arg(args, "expectedSourceSha", "[a-f0-9]{40}");
        assertNotEquals("New test source cannot be described as old App source", BASE_SOURCE, source);
        assertEquals(BASE_SOURCE, args.getString("baseAppSourceSha"));
        String buildId = arg(args, "expectedBuildId", "[A-Za-z0-9._-]{1,80}");
        assertEquals(35, Build.VERSION.SDK_INT);
        assertEquals("x86_64", Build.SUPPORTED_ABIS[0]);
        assertEquals(16384L, android.system.Os.sysconf(android.system.OsConstants._SC_PAGESIZE));
        assertEquals(buildId, Build.ID);
        assertEquals("com.shikuang.app.preview", InstrumentationRegistry.getInstrumentation().getTargetContext().getPackageName());
        Context target = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertTrue((target.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0);
        journal = new Journal(target, nonce, arm, source, buildId);
        boolean completed = false; Throwable pendingFailure = null;
        try {
            journal.write("before-launch", new JSONObject());
            scenario = ActivityScenario.launch(MainActivity.class);
            requireSupportedWebView(); awaitPage();
            JSONObject original = offline();
            PackageInfo provider = WebView.getCurrentWebViewPackage();
            assertNotNull(provider);
            assertEquals("com.google.android.webview", provider.packageName);
            assertEquals("124.0.6367.219", provider.versionName);
            assertEquals(636771938L, provider.getLongVersionCode());
            original.put("providerPackage", provider.packageName).put("providerVersion", provider.versionName)
                .put("providerVersionCode", provider.getLongVersionCode()).put("buildId", Build.ID)
                .put("buildFingerprint", Build.FINGERPRINT).put("reloadCount", 0)
                .put("loader", evaluate("MineralReference.status"));
            assertEquals("idle", original.getString("loader"));
            journal.write("original-ready", original);
            // addJavascriptInterface becomes visible only on the next document load.
            // Exactly this one explicit reload is identical across all three arms.
            journal.write("before-journal-reload", new JSONObject().put("reloadCount", 1));
            scenario.onActivity(activity -> {
                WebView web = activity.getBridge().getWebView();
                web.addJavascriptInterface(journal, "ShikuangMemoryJournal");
                web.reload();
            });
            // Reject the old ready document: the named JS interface must actually be present.
            awaitUi("typeof ShikuangMemoryJournal !== 'undefined' && window.__shikuangAppReady && document.getElementById('launchCover').hidden",
                "journal-bearing reloaded page", 60000);
            requireSupportedWebView(); awaitPage(); offline();
            assertEquals("idle", evaluate("MineralReference.status"));
            journal.write("reloaded-ready", new JSONObject().put("reloadCount", 1));
            evaluate(readTestAsset("memoryinfra-observer.js", OBSERVER_SHA));
            JSONObject baseline = snapshot();
            assertEquals(0, baseline.getInt("referenceResources"));
            assertTrue(baseline.getBoolean("identifyVisible")); assertTrue(baseline.getBoolean("libraryHidden"));
            if ("catalog-detail-only".equals(arm)) {
                journal.write("before-library-ui", baseline);
                evaluate("document.querySelector('[data-view=library]').click()");
                awaitUi("MineralReference.status==='ready' && !document.getElementById('view-library').hidden", "real library ready", 60000);
                evaluate("(() => {const q=document.getElementById('librarySearch');q.value='Quartz';q.dispatchEvent(new Event('input',{bubbles:true}));})()");
                awaitUi("!!document.querySelector('#libraryList [data-detail=quartz]')", "real Quartz library card", 15000);
                journal.write("before-detail-ui", snapshot());
                evaluate("document.querySelector('#libraryList [data-detail=quartz]').click()");
            } else {
                journal.write("before-file-ui", baseline);
                submitQuartz();
                journal.write("before-predict-ui", snapshot());
                evaluate("document.getElementById('predictBtn').click()");
                awaitUi("__memoryInfraDiagnostic.analysis!==null && !document.getElementById('result').hidden && !document.getElementById('predictBtn').disabled", "real three-model native result", 180000);
                JSONObject result = snapshot(); assertInference(result);
                assertEquals("idle", result.getString("loader")); assertEquals(0, result.getJSONArray("requests").length());
                if ("combined-first-detail".equals(arm)) {
                    journal.write("before-detail-ui", result);
                    evaluate("document.getElementById('detailBtn').click()");
                }
            }
            if (!"native-inference-only".equals(arm)) {
                awaitUi("MineralReference.status==='ready' && document.getElementById('detailDialog').open && !document.querySelector('#detailBody .detail-reference-state') && document.querySelectorAll('#detailBody .book-evidence-section').length===3 && !!document.querySelector('#detailBody .image-section')", "complete real Quartz detail", 60000);
            }
            JSONObject ready = snapshot(); assertArm(arm, ready); offline();
            journal.write("action-ready", ready);
            // Uniform observation begins only after the arm-specific target UI is ready.
            long start = SystemClock.elapsedRealtime(), deadline = start + OBSERVE_MS;
            int index = 0;
            do {
                JSONObject sample = snapshot(); assertArm(arm, sample); offline();
                journal.write("observation-sample", sample.put("index", index++)
                    .put("observationElapsedMs", SystemClock.elapsedRealtime() - start));
                long remaining = deadline - SystemClock.elapsedRealtime();
                if (remaining > 0) SystemClock.sleep(Math.min(SAMPLE_MS, remaining));
            } while (SystemClock.elapsedRealtime() < deadline);
            JSONObject last = snapshot(); assertArm(arm, last); offline();
            long elapsed = SystemClock.elapsedRealtime() - start;
            assertTrue(elapsed >= OBSERVE_MS);
            journal.write("observation-complete", last.put("observationElapsedMs", elapsed)
                .put("requestedObservationMs", OBSERVE_MS).put("samples", index)
                .put("productAcceptance", false).put("reloadCount", 1));
            completed = true;
        } catch (Exception | AssertionError error) {
            pendingFailure = error; throw error;
        } finally {
            // A native crash can bypass finally. Every prior completed journal file survives.
            try {
                if (!completed && journal != null) journal.write("java-incomplete", new JSONObject());
            } catch (Exception journalError) {
                if (pendingFailure != null) pendingFailure.addSuppressed(journalError); else throw journalError;
            } finally {
                try {if (scenario != null) scenario.close();}
                catch (RuntimeException closeError) {
                    if (pendingFailure != null) pendingFailure.addSuppressed(closeError); else throw closeError;
                }
            }
        }
    }

    private JSONObject offline() throws Exception {
        JSONObject value = nativeNetworkState();
        assertTrue(value.isNull("activeNetwork"));
        assertFalse(value.getBoolean("connected")); assertFalse(value.getBoolean("validated"));
        return value;
    }
    private JSONObject snapshot() throws Exception {
        assertNull("Journal must not silently degrade", journal.failure);
        return new JSONObject(evaluate("JSON.stringify(__memoryInfraDiagnostic.snapshot())"));
    }
    static void assertInference(JSONObject s) throws Exception {
        assertEquals(1, s.getInt("analysisCalls"));
        assertTrue(s.isNull("analysisError"));
        JSONObject a = s.getJSONObject("analysis");
        assertEquals("quartz", a.getString("key")); assertEquals("onnx-native-android", a.getString("engine"));
        assertEquals(3, a.getInt("modelCount")); assertEquals("inherited-2.0-audited", a.getString("modelVersion"));
        assertEquals(MANIFEST_SHA, a.getString("manifestSha256")); assertTrue(a.getLong("elapsedMs") > 0);
        assertTrue(s.getBoolean("resultVisible")); assertTrue(s.getBoolean("predictEnabled"));
    }
    static void assertArm(String arm, JSONObject s) throws Exception {
        assertFalse(s.getBoolean("online")); assertEquals(0, s.getInt("photoRequests"));
        if ("catalog-detail-only".equals(arm)) {
            assertEquals(0, s.getInt("analysisCalls")); assertTrue(s.isNull("analysis"));
            assertEquals(1, s.getInt("libraryClicks")); assertFalse(s.getBoolean("libraryHidden"));
        } else {assertInference(s); assertEquals(0, s.getInt("libraryClicks")); assertTrue(s.getBoolean("libraryHidden"));}
        JSONArray requests = s.getJSONArray("requests");
        if ("native-inference-only".equals(arm)) {
            assertEquals("idle", s.getString("loader")); assertEquals(0, requests.length());
            assertFalse(s.getBoolean("dialogOpen")); assertEquals(0, s.getInt("referenceResources"));
        } else {
            assertEquals("ready", s.getString("loader")); assertEquals(4, requests.length());
            Set<String> paths = new HashSet<>();
            for (int i=0;i<requests.length();i++) {JSONObject row=requests.getJSONObject(i);
                assertTrue(row.getBoolean("local")); assertEquals(200,row.getInt("status")); paths.add(row.getString("path"));}
            assertEquals(new HashSet<>(Arrays.asList("/data/reference-manifest.json", "/data/catalog.json", "/data/crystals.json", "/data/image-sources.json")), paths);
            assertTrue(s.getBoolean("dialogOpen")); assertEquals("石英", s.getString("title"));
            assertTrue(s.getBoolean("hasOfficialFields")); assertFalse(s.getBoolean("loadingMessage"));
            assertEquals(3,s.getInt("bookSections")); assertEquals(190,s.getInt("totalBookStatements"));
            assertEquals(11,s.getInt("books")); assertEquals(6239,s.getInt("primarySpecies"));
            assertTrue(s.getBoolean("galleryPresent")); assertTrue(s.getBoolean("galleryClosed"));
        }
    }
    private String readTestAsset(String name, String expected) throws Exception {
        ByteArrayOutputStream out=new ByteArrayOutputStream(); byte[] buffer=new byte[4096];
        try(InputStream in=InstrumentationRegistry.getInstrumentation().getContext().getAssets().open(name)) {
            int n;while((n=in.read(buffer))!=-1){out.write(buffer,0,n);assertTrue(out.size()<=24576);}}
        byte[] bytes=out.toByteArray();StringBuilder hex=new StringBuilder();
        for(byte b:MessageDigest.getInstance("SHA-256").digest(bytes))hex.append(String.format("%02x",b&255));
        assertEquals(expected,hex.toString());return new String(bytes,StandardCharsets.UTF_8);
    }
    private void submitQuartz() throws Exception {
        Bitmap source;
        try(InputStream in=InstrumentationRegistry.getInstrumentation().getContext().getAssets().open("quartz.jpg")){source=BitmapFactory.decodeStream(in);}
        assertNotNull(source);float scale=Math.min(1f,640f/Math.max(source.getWidth(),source.getHeight()));
        Bitmap resized=Bitmap.createScaledBitmap(source,Math.round(source.getWidth()*scale),Math.round(source.getHeight()*scale),true);
        ByteArrayOutputStream out=new ByteArrayOutputStream();assertTrue(resized.compress(Bitmap.CompressFormat.JPEG,95,out));
        String base64=Base64.encodeToString(out.toByteArray(),Base64.NO_WRAP);
        if(resized!=source)resized.recycle();source.recycle();
        evaluate("(() => {const b=atob("+JSONObject.quote(base64)+"),u=Uint8Array.from(b,c=>c.charCodeAt(0)),t=new DataTransfer();t.items.add(new File([u],'memoryinfra-real-quartz.jpg',{type:'image/jpeg'}));const i=document.getElementById('fileInput');i.files=t.files;i.dispatchEvent(new Event('change',{bubbles:true}));})()");
        awaitUi("!document.getElementById('predictBtn').disabled", "real file UI", 20000);
    }

    /** No supplied path. Nonce/arm validated before constructing this bounded private journal. */
    public static final class Journal {
        static final Set<String> EVENTS=new HashSet<>(Arrays.asList("before-launch","original-ready","before-journal-reload","reloaded-ready","observer-installed","reference-start","reference-return","reference-error","photo-start","analysis-start","analysis-return","analysis-error","library-click","detail-click","before-library-ui","before-file-ui","before-predict-ui","before-detail-ui","action-ready","observation-sample","observation-complete","java-incomplete"));
        final File folder; final String nonce,arm,source,buildId; int count=0; volatile String failure;
        Journal(Context target,String nonce,String arm,String source,String buildId) throws Exception {
            assertTrue(nonce.matches("[a-f0-9]{32}"));assertTrue(ARMS.contains(arm));
            this.nonce=nonce;this.arm=arm;this.source=source;this.buildId=buildId;
            File root=new File(target.getFilesDir(),"memoryinfra-diagnostic-"+nonce);
            assertTrue("Fresh nonce directory required",!root.exists()&&root.mkdir());
            folder=new File(root,arm);assertTrue(folder.mkdir());
            assertEquals(new File(root.getCanonicalFile(),arm).getPath(),folder.getCanonicalPath());
        }
        @JavascriptInterface public synchronized boolean record(String text) {
            try {
                if(text==null||text.length()>8192||text.getBytes(StandardCharsets.UTF_8).length>16384)throw new IllegalArgumentException("Journal input size");
                boundedDepth(text);
                JSONTokener tokener=new JSONTokener(text);Object decoded=tokener.nextValue();
                if(!(decoded instanceof JSONObject)||tokener.nextClean()!=0)throw new IllegalArgumentException("Strict JSON object required");
                JSONObject value=(JSONObject)decoded;
                if(value.length()!=2||!value.has("event")||!value.has("payload")||!(value.get("payload") instanceof JSONObject))throw new IllegalArgumentException("Exact event envelope required");
                write(value.getString("event"),value.getJSONObject("payload"));return true;
            } catch(Exception error){failure=error.getClass().getSimpleName()+": "+String.valueOf(error.getMessage());if(failure.length()>512)failure=failure.substring(0,512);Log.e("ShikuangMemoryInfra",failure);return false;}
        }
        synchronized void write(String event,JSONObject payload) throws Exception {
            if(failure!=null)throw new IllegalStateException(failure);
            if(!EVENTS.contains(event)||count>=256)throw new IllegalArgumentException("Journal scope/count");
            if(payload.toString().length()>8192)throw new IllegalArgumentException("Journal payload size");
            JSONObject row=new JSONObject().put("schema","memoryinfra-stage-v1").put("sequence",count)
                .put("nonce",nonce).put("arm",arm).put("sourceCommit",source).put("baseAppSource",BASE_SOURCE)
                .put("pid",android.os.Process.myPid()).put("buildId",buildId)
                .put("elapsedRealtimeNanos",SystemClock.elapsedRealtimeNanos()).put("event",event).put("payload",payload)
                .put("nativeHeapAllocated",Debug.getNativeHeapAllocatedSize()).put("nativeHeapSize",Debug.getNativeHeapSize())
                .put("nativeHeapFree",Debug.getNativeHeapFreeSize()).put("javaHeapUsed",Runtime.getRuntime().totalMemory()-Runtime.getRuntime().freeMemory())
                .put("rssKiB",rssKiB());
            byte[] bytes=row.toString().getBytes(StandardCharsets.UTF_8);
            if(bytes.length>24576)throw new IllegalArgumentException("Journal output size");
            File file=new File(folder,String.format(java.util.Locale.ROOT,"%03d.json",count));
            if(!file.createNewFile())throw new IllegalStateException("Journal overwrite forbidden");
            try(FileOutputStream out=new FileOutputStream(file,false)){out.write(bytes);out.flush();out.getFD().sync();}
            count++;Log.i("ShikuangMemoryInfra",row.toString());
        }
        static void boundedDepth(String text) {
            int depth=0;boolean quoted=false,escaped=false;
            for(int i=0;i<text.length();i++){char c=text.charAt(i);
                if(quoted){if(escaped)escaped=false;else if(c=='\\')escaped=true;else if(c=='"')quoted=false;}
                else if(c=='"')quoted=true;
                else if(c=='{'||c=='['){if(++depth>8)throw new IllegalArgumentException("Journal JSON depth");}
                else if(c=='}'||c==']'){if(--depth<0)throw new IllegalArgumentException("Journal JSON balance");}}
            if(depth!=0||quoted)throw new IllegalArgumentException("Journal JSON incomplete");
        }
        static long rssKiB() throws Exception {
            byte[] bytes=new byte[65536];int n;
            try(FileInputStream in=new FileInputStream("/proc/self/status")){n=in.read(bytes);if(n<=0||in.read()!=-1)throw new IllegalStateException("Bounded proc status");}
            for(String line:new String(bytes,0,n,StandardCharsets.US_ASCII).split("\n"))if(line.matches("VmRSS:\\s+[0-9]+\\s+kB"))return Long.parseLong(line.replaceAll("[^0-9]",""));
            throw new IllegalStateException("RSS missing");
        }
    }
}
