package com.shikuang.app;

import static org.junit.Assert.*;

import android.content.Context;
import android.graphics.Bitmap;
import android.os.Build;
import android.os.Handler;
import android.os.SystemClock;
import android.os.ParcelFileDescriptor;
import android.system.Os;
import android.system.OsConstants;
import android.util.Log;
import android.view.WindowInsets;
import android.view.MotionEvent;
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

    private void screenshot(String name) throws Exception {
        Bitmap bitmap = InstrumentationRegistry.getInstrumentation().getUiAutomation().takeScreenshot();
        assertNotNull(bitmap);
        try (OutputStream out = RuntimeTestOutput.open(name)) {
            assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, out));
        } finally { bitmap.recycle(); }
    }

    private void shellSnapshot(String command, String name) throws Exception {
        try (ParcelFileDescriptor.AutoCloseInputStream input = new ParcelFileDescriptor.AutoCloseInputStream(
                 InstrumentationRegistry.getInstrumentation().getUiAutomation().executeShellCommand(command));
             OutputStream output = RuntimeTestOutput.open(name)) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
        }
    }

    private boolean waitForRenderedFrame() throws Exception {
        CountDownLatch drawn = new CountDownLatch(1);
        AtomicReference<Throwable> drawFailure = new AtomicReference<>();
        scenario.onActivity(a -> {
            WebView web = a.getBridge().getWebView();
            web.postVisualStateCallback(SystemClock.uptimeMillis(), new WebView.VisualStateCallback() {
                @Override public void onComplete(long requestId) {
                    try {
                        assertTrue("Visible attached WebView required for actual draw", web.isAttachedToWindow() && web.getVisibility() == android.view.View.VISIBLE);
                        final android.view.ViewTreeObserver.OnDrawListener[] listener = new android.view.ViewTreeObserver.OnDrawListener[1];
                        listener[0] = () -> web.post(() -> {
                            if (web.getViewTreeObserver().isAlive()) web.getViewTreeObserver().removeOnDrawListener(listener[0]);
                            // A callback is readiness, not displayed pixels: observe draw,
                            // then two actual animation callbacks before Surface screenshot.
                            web.postOnAnimation(() -> web.postOnAnimation(drawn::countDown));
                        });
                        web.getViewTreeObserver().addOnDrawListener(listener[0]);
                        web.invalidate();
                    } catch (Throwable error) { drawFailure.set(error); drawn.countDown(); }
                }
            });
        });
        boolean observed = drawn.await(10, TimeUnit.SECONDS);
        if (drawFailure.get() != null) throw new AssertionError("Actual WebView draw failed", drawFailure.get());
        return observed;
    }

    private void inputEvidence(String stem, String selector) throws Exception {
        boolean visualFrameObserved = waitForRenderedFrame();
        JSONObject evidence = new JSONObject().put("phase", phase).put("selector", selector)
            .put("dom", new JSONObject(evaluate("JSON.stringify((()=>{const f=document.querySelector(" + JSONObject.quote(selector) + ");const r=f.getBoundingClientRect();const n=document.querySelector('.bottom-nav');const b=n&&getComputedStyle(n).display!=='none'?n.getBoundingClientRect():null;const overlap=b?Math.max(0,Math.min(r.right,b.right)-Math.max(r.left,b.left))*Math.max(0,Math.min(r.bottom,b.bottom)-Math.max(r.top,b.top)):0;return {active:document.activeElement===f,value:f.value,left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight,devicePixelRatio:devicePixelRatio,bottomNav:b?{left:b.left,top:b.top,right:b.right,bottom:b.bottom,width:b.width,height:b.height}:null,bottomNavOverlapCssPixels:overlap,inputFullyUnobscured:r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&overlap===0,visualViewport:window.visualViewport?{height:visualViewport.height,width:visualViewport.width,offsetTop:visualViewport.offsetTop,offsetLeft:visualViewport.offsetLeft}:null};})())")));
        scenario.onActivity(a -> {
            WebView web = a.getBridge().getWebView();
            WindowInsets insets = web.getRootWindowInsets();
            try {
                evidence.put("windowFocus", web.hasWindowFocus()).put("nativeViewFocus", web.hasFocus())
                    .put("imeVisible", insets != null && insets.isVisible(WindowInsets.Type.ime()))
                    .put("visualFrameObserved", visualFrameObserved).put("nativeWebWidth", web.getWidth()).put("nativeWebHeight", web.getHeight())
                    .put("imeBottomInsetPixels", insets == null ? -1 : insets.getInsets(WindowInsets.Type.ime()).bottom);
            } catch (Exception e) { throw new AssertionError(e); }
        });
        try (OutputStream out = RuntimeTestOutput.open(stem + ".json")) {
            out.write(evidence.toString(2).getBytes(StandardCharsets.UTF_8));
        }
        screenshot(stem + ".png");
        shellSnapshot("dumpsys input_method", stem + "-input-method.txt");
        shellSnapshot("dumpsys window", stem + "-window.txt");
        shellSnapshot("settings get secure show_ime_with_hard_keyboard", stem + "-hard-keyboard-setting.txt");
        assertTrue("WebView DOM was not observed in a real drawn frame; raw PNG/JSON retained", visualFrameObserved);
    }

    private void focusAndCompose(int cycle, String selector, String view, String text) throws Exception {
        final String composePhase = phase;
        // Real touch is essential: script focus alone is not a user gesture in WebView.
        checkpoint(cycle, composePhase + "/view-switch-before");
        evaluate("(()=>{const target='#" + view + "';window.__stressRouteObserved=location.hash===target;if(!window.__stressRouteObserved){addEventListener('hashchange',()=>{window.__stressRouteObserved=location.hash===target;},{once:true});document.querySelector('[data-view=" + view + "]').click();}return true;})()");
        try {
            await("window.__stressRouteObserved && !document.getElementById('view-" + view + "').hidden", "actual route completed before scroll", 10000);
        } catch (AssertionError failure) {
            inputEvidence("input-lifecycle-route-failure-" + cycle, selector);
            throw failure;
        }
        checkpoint(cycle, composePhase + "/view-switch-after");
        evaluate("document.querySelector(" + JSONObject.quote(selector) + ").scrollIntoView({block:'center',behavior:'instant'});true");
        checkpoint(cycle, composePhase + "/scroll-after-route");
        try {
            await("(()=>{const r=document.querySelector(" + JSONObject.quote(selector) + ").getBoundingClientRect();return r.width>0&&r.height>0&&r.top>=0&&r.bottom<=innerHeight;})()", "visible input bounds", 10000);
        } catch (AssertionError failure) {
            inputEvidence("input-lifecycle-bounds-failure-" + cycle, selector);
            throw failure;
        }
        checkpoint(cycle, composePhase + "/bounds-visible");
        JSONObject bounds = new JSONObject(evaluate("JSON.stringify((()=>{const r=document.querySelector(" + JSONObject.quote(selector) + ").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,w:innerWidth,h:innerHeight};})())"));
        final float[] point = new float[2];
        scenario.onActivity(a -> {
            WebView web = a.getBridge().getWebView();
            assertTrue("Window must be focused before native touch", web.hasWindowFocus());
            int[] location = new int[2];web.getLocationOnScreen(location);
            point[0] = location[0] + (float)(bounds.optDouble("x") * web.getWidth() / bounds.optDouble("w"));
            point[1] = location[1] + (float)(bounds.optDouble("y") * web.getHeight() / bounds.optDouble("h"));
        });
        long downAt = SystemClock.uptimeMillis();
        MotionEvent down = MotionEvent.obtain(downAt, downAt, MotionEvent.ACTION_DOWN, point[0], point[1], 0);
        MotionEvent up = MotionEvent.obtain(downAt, downAt + 80, MotionEvent.ACTION_UP, point[0], point[1], 0);
        checkpoint(cycle, composePhase + "/native-touch-before");
        try {
            InstrumentationRegistry.getInstrumentation().sendPointerSync(down);
            SystemClock.sleep(80);
            InstrumentationRegistry.getInstrumentation().sendPointerSync(up);
        } finally {down.recycle();up.recycle();}
        checkpoint(cycle, composePhase + "/native-touch-after");
        if (cycle <= 3 && composePhase.equals("compose-before-background")) inputEvidence("input-lifecycle-" + view + "-after-touch", selector);
        await("document.activeElement===document.querySelector(" + JSONObject.quote(selector) + ")", "DOM focus after actual native touch", 10000);
        checkpoint(cycle, composePhase + "/dom-focused");
        AtomicReference<Throwable> failure = new AtomicReference<>();
        checkpoint(cycle, composePhase + "/show-ime-before");
        scenario.onActivity(a -> {
            try {
                WebView web = a.getBridge().getWebView();
                web.requestFocus();
                InputMethodManager manager = (InputMethodManager) a.getSystemService(Context.INPUT_METHOD_SERVICE);
                manager.showSoftInput(web, InputMethodManager.SHOW_IMPLICIT);
            } catch (Throwable e) { failure.set(e); }
        });
        if (failure.get() != null) throw new AssertionError("IME show failed", failure.get());
        checkpoint(cycle, composePhase + "/show-ime-after");
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
        if (!Boolean.TRUE.equals(visible.get())) inputEvidence("input-lifecycle-ime-failure-" + cycle, selector);
        assertTrue("Actual IME must be visible, not a DOM-value-only test", visible.get());
        checkpoint(cycle, composePhase + "/ime-visible");
        if (cycle <= 3 && composePhase.equals("compose-before-background")) inputEvidence("input-lifecycle-" + view + "-ime-visible", selector);
        checkpoint(cycle, composePhase + "/input-connection-before");
        JSONObject connectionEvidence = new JSONObject().put("cycle", cycle).put("composePhase", composePhase).put("selector", selector);
        AtomicReference<InputConnection> currentInput = new AtomicReference<>();
        AtomicReference<Handler> currentInputHandler = new AtomicReference<>();
        scenario.onActivity(a -> {
            try {
                WebView web = a.getBridge().getWebView();
                EditorInfo info = new EditorInfo();
                InputConnection input = web.onCreateInputConnection(info);
                assertNotNull("Actual WebView InputConnection unavailable", input);
                currentInput.set(input);
                Handler handler = input.getHandler();
                assertNotNull("Actual Chromium InputConnection handler unavailable", handler);
                currentInputHandler.set(handler);
                connectionEvidence.put("inputConnectionClass", input.getClass().getName()).put("inputType", info.inputType)
                    .put("imeOptions", info.imeOptions).put("initialSelStart", info.initialSelStart).put("initialSelEnd", info.initialSelEnd)
                    .put("handlerThreadName", handler.getLooper().getThread().getName()).put("handlerThreadId", handler.getLooper().getThread().getId());
            } catch (Throwable e) { failure.set(e); }
        });
        if (failure.get() != null) throw new AssertionError("Native input connection failed", failure.get());
        try (OutputStream out = RuntimeTestOutput.open("input-lifecycle-connection-" + cycle + "-" + composePhase + ".json")) {
            out.write(connectionEvidence.toString(2).getBytes(StandardCharsets.UTF_8));
        }
        checkpoint(cycle, composePhase + "/input-connection-after");
        checkpoint(cycle, composePhase + "/set-composing-before");
        CountDownLatch composingReturned = new CountDownLatch(1);
        boolean posted = currentInputHandler.get().post(() -> {
            try {
                assertSame("InputConnection must run on its declared handler looper", currentInputHandler.get().getLooper(), android.os.Looper.myLooper());
                connectionEvidence.put("actualCallThreadName", Thread.currentThread().getName()).put("actualCallThreadId", Thread.currentThread().getId());
                InputConnection input = currentInput.get();
                assertNotNull("Actual WebView InputConnection unavailable during composition", input);
                assertTrue(input.beginBatchEdit());
                try {
                    assertTrue(input.deleteSurroundingText(2000, 2000));
                    assertTrue(input.setComposingText(text, 1));
                } finally { input.endBatchEdit(); }
                connectionEvidence.put("nativeCompositionReturned", true);
            } catch (Throwable e) { failure.set(e); }
            finally { composingReturned.countDown(); }
        });
        assertTrue("InputConnection handler rejected bounded composition", posted);
        assertTrue("InputConnection handler composition timed out", composingReturned.await(10, TimeUnit.SECONDS));
        if (failure.get() != null) connectionEvidence.put("failure", failure.get().toString());
        try (OutputStream out = RuntimeTestOutput.open("input-lifecycle-connection-result-" + cycle + "-" + composePhase + ".json")) {
            out.write(connectionEvidence.toString(2).getBytes(StandardCharsets.UTF_8));
        }
        if (failure.get() != null) {
            inputEvidence("input-lifecycle-compose-failure-" + cycle, selector);
            throw new AssertionError("Native composing failed", failure.get());
        }
        checkpoint(cycle, composePhase + "/set-composing-after");
        await("document.querySelector(" + JSONObject.quote(selector) + ").value===" + JSONObject.quote(text), "native composition reflected in DOM", 10000);
        checkpoint(cycle, composePhase + "/chinese-dom-verified");
        if (cycle <= 3 && composePhase.equals("compose-before-background")) inputEvidence("input-lifecycle-" + view + "-composing", selector);
        // Intentionally keep composition active for lifecycle cleanup; no stale connection is called after destruction.
    }

    @Test(timeout = 900000)
    public void boundedNativeImeLifecycleOnGenuine16k() throws Exception {
        deadline = SystemClock.elapsedRealtime() + 720000;
        int expectedSdk = Integer.parseInt(InstrumentationRegistry.getArguments().getString("expectedSdk", "35"));
        assertTrue("Only the two authorized official image SDKs are allowed", expectedSdk == 35 || expectedSdk == 36);
        assertEquals("Actual SDK must match the selected official image", expectedSdk, Build.VERSION.SDK_INT);
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
                    focusAndCompose(cycle, selectors[input], views[input], "quartz-实验室-" + cycle);
                }
                checkpoint(cycle, "background-before");
                scenario.moveToState(Lifecycle.State.CREATED);
                checkpoint(cycle, "foreground-before");
                scenario.moveToState(Lifecycle.State.RESUMED);
                pageReady();
                assertStoredRecord();
                if (input != 0) {
                    checkpoint(cycle, "compose-before-recreate");
                    focusAndCompose(cycle, selectors[input], views[input], "pyrite-共生-" + cycle);
                }
                checkpoint(cycle, "recreate-before");
                scenario.recreate();
                pageReady();
                assertStoredRecord();
                if (input != 0) {
                    checkpoint(cycle, "compose-before-close");
                    focusAndCompose(cycle, selectors[input], views[input], "calcite-不规则-" + cycle);
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
            screenshot("input-lifecycle-final.png");
        } finally {
            if (scenario != null) scenario.close();
        }
    }
}
