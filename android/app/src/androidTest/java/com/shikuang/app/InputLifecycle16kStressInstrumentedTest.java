package com.shikuang.app;

import static org.junit.Assert.*;

import android.content.Context;
import android.graphics.Bitmap;
import android.os.Build;
import android.os.SystemClock;
import android.system.Os;
import android.system.OsConstants;
import android.util.Log;
import android.view.WindowInsets;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.view.inputmethod.InputMethodManager;
import android.webkit.WebView;
import androidx.lifecycle.Lifecycle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Proposal: no production-code hooks, no model/accuracy claim, test-only record ID. */
@RunWith(AndroidJUnit4.class)
public class InputLifecycle16kStressInstrumentedTest {
    private static final String TAG = "Shikuang16kStress";
    private static final String RECORD_ID = "runtime-16k-input-lifecycle-proof";
    private ActivityScenario<MainActivity> scenario;
    private final JSONArray events = new JSONArray();
    private final JSONArray cycles = new JSONArray();
    private long deadline;
    private String snapshot;
    private String phase = "not-started";

    private String evaluate(String source) throws Exception {
        if (SystemClock.elapsedRealtime() > deadline) throw new AssertionError("Stress total deadline exceeded");
        CountDownLatch returned = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        scenario.onActivity(a -> a.getBridge().getWebView().evaluateJavascript(source, value -> {
            result.set(value); returned.countDown();
        }));
        assertTrue("JS callback timed out in " + phase, returned.await(10, TimeUnit.SECONDS));
        Object decoded = new JSONArray("[" + result.get() + "]").get(0);
        return decoded == JSONObject.NULL ? "null" : decoded.toString();
    }

    private void await(String expression, String description, long budget) throws Exception {
        long end = Math.min(deadline, SystemClock.elapsedRealtime() + budget);
        do {
            if ("true".equals(evaluate(expression))) return;
            SystemClock.sleep(80);
        } while (SystemClock.elapsedRealtime() < end);
        fail("Timed out: " + description + " in " + phase);
    }

    private void pageReady() throws Exception {
        await("!!(window.SpecimenStore && document.getElementById('notes') && window.__shikuangBootCapabilities && window.__shikuangBootCapabilities.supported)", "real packaged supported page", 30000);
        await("!!document.getElementById('launchCover') && document.getElementById('launchCover').hidden", "startup overlay exit", 15000);
    }

    private void checkpoint(int cycle, String action) throws Exception {
        phase = action;
        JSONObject row = new JSONObject().put("cycle", cycle).put("action", action)
            .put("elapsedRealtimeMs", SystemClock.elapsedRealtime())
            .put("pid", android.os.Process.myPid());
        events.put(row);
        Log.i(TAG, row.toString());
        JSONObject report = new JSONObject().put("phase", "in-progress").put("lastAction", action)
            .put("sdk", Build.VERSION.SDK_INT).put("buildFingerprint", Build.FINGERPRINT).put("pageSize", Os.sysconf(OsConstants._SC_PAGESIZE))
            .put("cycles", cycles).put("events", events).put("inputScope", "Native WebView InputConnection and actual visible system IME; no physical Chinese keyboard suggestion selection claim");
        try (OutputStream out = RuntimeTestOutput.open("input-lifecycle-progress.json")) {
            out.write(report.toString(2).getBytes(StandardCharsets.UTF_8));
        }
    }

    private void assertStoredRecord() throws Exception {
        evaluate("window.__stressRecordSnapshot=null;window.__stressRecordError=null;(async()=>{try{window.__stressRecordSnapshot=JSON.stringify((await SpecimenStore.list()).find(r=>r.id==='" + RECORD_ID + "'));}catch(e){window.__stressRecordError=String(e);}})();");
        await("window.__stressRecordSnapshot!==null || window.__stressRecordError!==null", "stored sentinel read", 10000);
        assertEquals("Stored sentinel read failure", "null", evaluate("window.__stressRecordError"));
        assertEquals("Stored record changed across lifecycle", snapshot, evaluate("window.__stressRecordSnapshot"));
    }

    private void focusAndCompose(String selector, String view, String text) throws Exception {
        evaluate("(()=>{document.querySelector('[data-view=" + view + "]').click();const f=document.querySelector(" + JSONObject.quote(selector) + ");f.scrollIntoView({block:'center'});f.focus();return true;})()");
        await("document.activeElement===document.querySelector(" + JSONObject.quote(selector) + ")", "DOM editable focus", 10000);
        AtomicReference<Throwable> failure = new AtomicReference<>();
        scenario.onActivity(a -> {
            try {
                WebView web = a.getBridge().getWebView();
                web.requestFocus();
                InputMethodManager manager = (InputMethodManager) a.getSystemService(Context.INPUT_METHOD_SERVICE);
                manager.showSoftInput(web, InputMethodManager.SHOW_IMPLICIT);
            } catch (Throwable e) { failure.set(e); }
        });
        if (failure.get() != null) throw new AssertionError("IME show failed", failure.get());
        long end = Math.min(deadline, SystemClock.elapsedRealtime() + 10000);
        AtomicReference<Boolean> visible = new AtomicReference<>(false);
        do {
            scenario.onActivity(a -> {
                WindowInsets insets = a.getBridge().getWebView().getRootWindowInsets();
                visible.set(insets != null && insets.isVisible(WindowInsets.Type.ime()));
            });
            if (Boolean.TRUE.equals(visible.get())) break;
            SystemClock.sleep(80);
        } while (SystemClock.elapsedRealtime() < end);
        assertTrue("Actual IME must be visible, not a DOM-value-only test", visible.get());
        scenario.onActivity(a -> {
            try {
                WebView web = a.getBridge().getWebView();
                EditorInfo info = new EditorInfo();
                InputConnection input = web.onCreateInputConnection(info);
                assertNotNull("Actual WebView InputConnection unavailable", input);
                assertTrue(input.beginBatchEdit());
                try {
                    assertTrue(input.deleteSurroundingText(2000, 2000));
                    assertTrue(input.setComposingText(text, 1));
                } finally { input.endBatchEdit(); }
            } catch (Throwable e) { failure.set(e); }
        });
        if (failure.get() != null) throw new AssertionError("Native composing failed", failure.get());
        await("document.querySelector(" + JSONObject.quote(selector) + ").value===" + JSONObject.quote(text), "native composition reflected in DOM", 10000);
        // Intentionally keep composition active for lifecycle cleanup; no stale connection is called after destruction.
    }

    @Test(timeout = 900000)
    public void boundedNativeImeLifecycleOnGenuine16k() throws Exception {
        deadline = SystemClock.elapsedRealtime() + 720000;
        assertEquals(35, Build.VERSION.SDK_INT);
        assertEquals(16384, Os.sysconf(OsConstants._SC_PAGESIZE));
        assertEquals("x86_64", Build.SUPPORTED_ABIS[0]);
        final String[] selectors = {null, "#notes", "#librarySearch", "#recordSearch"};
        final String[] views = {null, "identify", "library", "records"};
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String packageName = context.getPackageName();
        android.content.pm.PackageInfo installed = context.getPackageManager().getPackageInfo(packageName, 0);
        assertEquals("com.shikuang.app.preview", packageName);
        android.net.ConnectivityManager connectivity = (android.net.ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        assertNotNull(connectivity);
        android.net.Network networkBefore = connectivity.getActiveNetwork();
        assertNull("Native active network must be absent before stress", networkBefore);
        try {
            for (int cycle = 0; cycle < 12; cycle++) {
                checkpoint(cycle, "launch-before");
                scenario = ActivityScenario.launch(MainActivity.class);
                pageReady();
                assertEquals("false", evaluate("navigator.onLine"));
                if (cycle == 0) {
                    evaluate("window.__stressSeeded=false;window.__stressSeedError=null;(async()=>{try{if((await SpecimenStore.list()).some(r=>r.id==='" + RECORD_ID + "'))throw Error('Sentinel ID already exists; refuse overwrite');await SpecimenStore.put({id:'" + RECORD_ID + "',key:'quartz',name:'输入生命周期回归记录',rankings:[{key:'quartz',score:.5}]});window.__stressSeeded=true;}catch(e){window.__stressSeedError=String(e);}})();");
                    await("window.__stressSeeded || window.__stressSeedError!==null", "sentinel seed", 10000);
                    assertEquals("null", evaluate("window.__stressSeedError"));
                    evaluate("window.__stressRecordSnapshot=null;(async()=>{window.__stressRecordSnapshot=JSON.stringify((await SpecimenStore.list()).find(r=>r.id==='" + RECORD_ID + "'));})();");
                    await("window.__stressRecordSnapshot!==null", "sentinel snapshot", 10000);
                    snapshot = evaluate("window.__stressRecordSnapshot");
                }
                assertStoredRecord();
                int input = cycle % 4;
                if (input != 0) {
                    checkpoint(cycle, "compose-before-background");
                    focusAndCompose(selectors[input], views[input], "quartz-实验室-" + cycle);
                }
                checkpoint(cycle, "background-before");
                scenario.moveToState(Lifecycle.State.CREATED);
                checkpoint(cycle, "foreground-before");
                scenario.moveToState(Lifecycle.State.RESUMED);
                pageReady();
                assertStoredRecord();
                if (input != 0) {
                    checkpoint(cycle, "compose-before-recreate");
                    focusAndCompose(selectors[input], views[input], "pyrite-共生-" + cycle);
                }
                checkpoint(cycle, "recreate-before");
                scenario.recreate();
                pageReady();
                assertStoredRecord();
                if (input != 0) {
                    checkpoint(cycle, "compose-before-close");
                    focusAndCompose(selectors[input], views[input], "calcite-不规则-" + cycle);
                }
                checkpoint(cycle, "close-before");
                scenario.close();
                scenario = null;
                // Same bounded observation window for controls and edited fields; not a mitigation or retry.
                SystemClock.sleep(1000);
                cycles.put(new JSONObject().put("cycle", cycle).put("selector", selectors[input] == null ? JSONObject.NULL : selectors[input])
                    .put("backgroundForegroundVerified", true).put("recreateVerified", true).put("storedRecordPreserved", true)
                    .put("nativeComposingAndVisibleImeVerified", input != 0).put("closedWithoutObservedCrash", true));
                checkpoint(cycle, "cycle-completed");
            }
            scenario = ActivityScenario.launch(MainActivity.class);
            pageReady();assertStoredRecord();
            evaluate("window.__stressRemoved=false;(async()=>{await SpecimenStore.remove('" + RECORD_ID + "');window.__stressRemoved=!(await SpecimenStore.list()).some(r=>r.id==='" + RECORD_ID + "');})();");
            await("window.__stressRemoved", "sentinel removal", 10000);
            android.net.Network networkAfter = connectivity.getActiveNetwork();
            assertNull("Native active network must remain absent after stress", networkAfter);
            JSONObject report = new JSONObject().put("phase", "passed").put("sdk", Build.VERSION.SDK_INT)
                .put("pageSize", Os.sysconf(OsConstants._SC_PAGESIZE)).put("deviceAbi", Build.SUPPORTED_ABIS[0]).put("buildFingerprint", Build.FINGERPRINT).put("securityPatch", Build.VERSION.SECURITY_PATCH)
                .put("packageName", packageName).put("versionCode", installed.versionCode).put("versionName", installed.versionName)
                .put("cycles", cycles).put("events", events).put("nativeInputCycles", 9).put("fallbackNoEditCycles", 3)
                .put("sentinelRemoved", true).put("activeNetworkBefore", networkBefore == null ? JSONObject.NULL : networkBefore.toString())
                .put("activeNetworkAfter", networkAfter == null ? JSONObject.NULL : networkAfter.toString())
                .put("productionAccuracyClaim", false).put("unsavedDraftPersistenceClaim", false)
                .put("coldProcessRestartClaim", false).put("physicalImeSuggestionSelectionClaim", false);
            try (OutputStream out = RuntimeTestOutput.open("input-lifecycle-report.json")) {out.write(report.toString(2).getBytes(StandardCharsets.UTF_8));}
            Bitmap bitmap = InstrumentationRegistry.getInstrumentation().getUiAutomation().takeScreenshot();
            assertNotNull(bitmap);
            try (OutputStream out = RuntimeTestOutput.open("input-lifecycle-final.png")) {assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, out));}
            finally {bitmap.recycle();}
        } finally {
            if (scenario != null) scenario.close();
        }
    }
}
