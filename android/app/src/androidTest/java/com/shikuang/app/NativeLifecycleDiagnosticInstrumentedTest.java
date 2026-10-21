package com.shikuang.app;

import static org.junit.Assert.*;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.net.ConnectivityManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Process;
import android.os.SystemClock;
import android.system.Os;
import android.system.OsConstants;
import android.webkit.WebView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Explicit one-arm instrumentation only. Never part of normal acceptance. */
@RunWith(AndroidJUnit4.class)
public final class NativeLifecycleDiagnosticInstrumentedTest {
    private static final AtomicBoolean STARTED = new AtomicBoolean();

    private interface Probe { void run() throws Throwable; }

    private JSONObject requireExactEnvironment(String arm) throws Exception {
        Bundle args = InstrumentationRegistry.getArguments();
        assertEquals("Explicit diagnostic opt-in is required", "true", args.getString("nativeLifecycleDiagnostic"));
        assertEquals("Select exactly one diagnostic arm per instrumentation process", arm, args.getString("diagnosticArm"));
        assertTrue("Fresh receipt nonce is required", args.getString("diagnosticNonce", "").matches("[a-f0-9]{32}"));
        assertTrue("No second diagnostic arm or retry in the same process", STARTED.compareAndSet(false, true));
        assertTrue("Debug-only observer required", RuntimeLifecycleDiagnostics.ENABLED);
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertTrue("Release apps cannot run this diagnostic", (context.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0);
        assertEquals("This control is scoped to the failed stock API35 image", 35, Build.VERSION.SDK_INT);
        assertEquals("This is the failed x86_64 emulator scope", "x86_64", Build.SUPPORTED_ABIS[0]);
        long pageSize = Os.sysconf(OsConstants._SC_PAGESIZE);
        assertEquals("A genuine 16KB kernel/libc is required", 16384L, pageSize);
        PackageInfo provider = WebView.getCurrentWebViewPackage();
        assertNotNull("Stock WebView provider must be present", provider);
        assertEquals("com.google.android.webview", provider.packageName);
        assertEquals("The failed run's stock provider must remain fixed", "124.0.6367.219", provider.versionName);
        assertEquals(636771938L, provider.getLongVersionCode());
        ConnectivityManager network = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        assertNotNull(network);
        assertNull("Device must remain genuinely offline", network.getActiveNetwork());
        return new JSONObject().put("sdk", Build.VERSION.SDK_INT).put("pageSize", pageSize)
            .put("providerPackage", provider.packageName).put("providerVersion", provider.versionName)
            .put("providerVersionCode", provider.getLongVersionCode()).put("pid", Process.myPid())
            .put("activeNetwork", JSONObject.NULL);
    }

    private void runAndRecord(String arm, Probe probe) throws Throwable {
        JSONObject proof = new JSONObject().put("schema", "shikuang-native-lifecycle-diagnostic-v1")
            .put("arm", arm).put("startedElapsedRealtimeNanos", SystemClock.elapsedRealtimeNanos())
            .put("nonce", InstrumentationRegistry.getArguments().getString("diagnosticNonce", "missing"))
            .put("fullProductAcceptance", false).put("originalFailureRemainsRecorded", true)
            .put("plannedAttempts", 1).put("completed", false);
        Throwable primary = null;
        try {
            proof.put("environment", requireExactEnvironment(arm));
            probe.run();
            proof.put("completed", true);
        } catch (Throwable failure) {
            primary = failure;
            proof.put("failureType", failure.getClass().getName());
            throw failure;
        } finally {
            try {
                proof.put("endedElapsedRealtimeNanos", SystemClock.elapsedRealtimeNanos());
                proof.put("lifecycle", new JSONObject(RuntimeLifecycleDiagnostics.snapshot()));
                try (OutputStream output = RuntimeTestOutput.open("native-lifecycle-" + arm + ".json")) {
                    output.write(proof.toString(2).getBytes(StandardCharsets.UTF_8));
                }
            } catch (Throwable outputFailure) {
                if (primary != null) primary.addSuppressed(outputFailure);
                else throw outputFailure;
            }
        }
    }

    private void awaitPlainPage(ActivityScenario<PlainWebViewDiagnosticActivity> scenario) throws Exception {
        long end = SystemClock.elapsedRealtime() + 15000;
        do {
            CountDownLatch returned = new CountDownLatch(1);
            AtomicReference<String> result = new AtomicReference<>();
            scenario.onActivity(activity -> {
                WebView view = activity.liveWebView();
                if (!view.isAttachedToWindow() || !view.isShown()) {
                    result.set("waiting-for-visible-attached-view"); returned.countDown(); return;
                }
                view.evaluateJavascript("!!(window.__plainDiagnosticReady && document.getElementById('plain-control'))", value -> {
                    result.set(value); returned.countDown();
                });
            });
            assertTrue("Control JS callback timed out", returned.await(5, TimeUnit.SECONDS));
            if ("true".equals(result.get())) return;
            SystemClock.sleep(100);
        } while (SystemClock.elapsedRealtime() < end);
        fail("Inline control did not become ready");
    }

    private boolean lifecycleComplete(String prefix, boolean requirePlugin) throws Exception {
        JSONObject snapshot = new JSONObject(RuntimeLifecycleDiagnostics.snapshot());
        assertEquals("Lifecycle evidence must not be truncated", 0L, snapshot.getLong("droppedEvents"));
        JSONArray events = snapshot.getJSONArray("events");
        Set<Integer> created = new HashSet<>(), destroyed = new HashSet<>(), detached = new HashSet<>();
        Set<Integer> pluginEntered = new HashSet<>(), pluginCompleted = new HashSet<>();
        Set<Integer> viewIdentities = new HashSet<>();
        Map<Integer, Map<String, Integer>> activityPhases = new HashMap<>();
        Map<Integer, Map<String, Integer>> pluginPhases = new HashMap<>();
        long previousSequence = 0, previousTime = 0;
        for (int i = 0; i < events.length(); i++) {
            JSONObject event = events.getJSONObject(i);
            String phase = event.getString("phase");
            int owner = event.getInt("ownerIdentity");
            assertTrue("Receipt sequence must strictly increase", event.getLong("sequence") > previousSequence);
            assertTrue("Receipt time must be monotonic", event.getLong("elapsedRealtimeNanos") >= previousTime);
            previousSequence = event.getLong("sequence"); previousTime = event.getLong("elapsedRealtimeNanos");
            Map<Integer, Map<String, Integer>> owners = phase.startsWith("plugin-") ? pluginPhases : activityPhases;
            Map<String, Integer> phases = owners.get(owner);
            if (phases == null) { phases = new HashMap<>(); owners.put(owner, phases); }
            phases.put(phase, phases.containsKey(phase) ? phases.get(phase) + 1 : 1);
            if (phase.equals(prefix + "create-exit")) { created.add(owner); viewIdentities.add(event.getInt("webViewIdentity")); }
            if (phase.equals(prefix + "destroy-exit")) destroyed.add(owner);
            if (phase.equals(prefix + "detach-exit")) detached.add(owner);
            if (phase.equals("plugin-destroy-enter")) pluginEntered.add(owner);
            if (phase.equals("plugin-cleanup-complete")) pluginCompleted.add(owner);
        }
        if (created.size() != 2 || viewIdentities.size() != 2 || viewIdentities.contains(0)
                || !created.equals(destroyed) || !created.equals(detached)) return false;
        for (int owner : created) {
            Map<String, Integer> phases = activityPhases.get(owner);
            for (String stage : new String[] {"create", "destroy", "detach"}) {
                assertEquals("No duplicate " + stage + " enter per Activity", Integer.valueOf(1), phases.get(prefix + stage + "-enter"));
                assertEquals("No duplicate " + stage + " exit per Activity", Integer.valueOf(1), phases.get(prefix + stage + "-exit"));
            }
            for (String stage : new String[] {"resume", "pause", "stop"}) {
                if (!phases.containsKey(prefix + stage + "-enter") || !phases.get(prefix + stage + "-enter").equals(phases.get(prefix + stage + "-exit"))) return false;
            }
        }
        if (!requirePlugin) {
            assertTrue("Plain control must not create the mineral plugin", pluginEntered.isEmpty());
            return true;
        }
        if (pluginEntered.size() != 2 || !pluginEntered.equals(pluginCompleted)) return false;
        for (int owner : pluginEntered) for (String phase : new String[] {
                "plugin-destroy-enter", "plugin-cancel-complete", "plugin-cleanup-enter",
                "plugin-cleanup-complete", "plugin-shutdown-requested", "plugin-destroy-exit"}) {
            Integer count = pluginPhases.get(owner).get(phase);
            if (count == null) return false;
            assertEquals("No duplicate plugin lifecycle phase", Integer.valueOf(1), count);
        }
        return true;
    }

    private void awaitLifecycleCompletion(String prefix, boolean requirePlugin) throws Exception {
        long end = SystemClock.elapsedRealtime() + 10000;
        do {
            if (lifecycleComplete(prefix, requirePlugin)) return;
            SystemClock.sleep(100);
        } while (SystemClock.elapsedRealtime() < end);
        fail("Destroyed/detached/queued cleanup did not finish within 10 seconds; receipts retained");
    }

    @Test public void plainWebViewSingleRecreateAndClose() throws Throwable {
        runAndRecord("plain", () -> {
            try (ActivityScenario<PlainWebViewDiagnosticActivity> scenario = ActivityScenario.launch(PlainWebViewDiagnosticActivity.class)) {
                awaitPlainPage(scenario);
                scenario.recreate();
                awaitPlainPage(scenario);
            }
            awaitLifecycleCompletion("plain-", false);
        });
    }

    @Test public void packagedMigrationSingleRecreateAndClose() throws Throwable {
        runAndRecord("packaged", () -> {
            // Invoke the existing exact migration test, including every original
            // fixture, migration assertion and cleanup. No duplicate substitute.
            new MineralEngineInstrumentedTest().legacyNativeAssetMigrationPreservesSpecimens();
            awaitLifecycleCompletion("", true);
        });
    }
}
