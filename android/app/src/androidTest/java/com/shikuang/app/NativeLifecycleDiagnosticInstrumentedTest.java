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

    private interface Probe { void run(JSONObject proof) throws Throwable; }

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
        JSONObject proof = new JSONObject().put("schema", "shikuang-native-lifecycle-diagnostic-v2")
            .put("arm", arm).put("startedElapsedRealtimeNanos", SystemClock.elapsedRealtimeNanos())
            .put("nonce", InstrumentationRegistry.getArguments().getString("diagnosticNonce", "missing"))
            .put("fullProductAcceptance", false).put("originalFailureRemainsRecorded", true)
            .put("plannedAttempts", 1).put("completed", false);
        Throwable primary = null;
        try {
            proof.put("environment", requireExactEnvironment(arm));
            probe.run(proof);
            proof.put("completed", true);
        } catch (Throwable failure) {
            primary = failure;
            proof.put("failureType", failure.getClass().getName());
            throw failure;
        } finally {
            try {
                JSONObject snapshot = new JSONObject(RuntimeLifecycleDiagnostics.snapshot());
                proof.put("lifecycle", snapshot);
                try {
                    proof.put("ownership", ownershipSummary(snapshot, "plain".equals(arm) ? "plain-" : "", "packaged".equals(arm)));
                } catch (Throwable ownershipFailure) {
                    proof.put("completed", false);
                    proof.put("ownership", new JSONObject().put("schema", "shikuang-direct-WebView-ownership-v2")
                        .put("ownershipComplete", false).put("evaluationFailureType", ownershipFailure.getClass().getName()));
                    if (primary != null) primary.addSuppressed(ownershipFailure);
                }
                proof.put("endedElapsedRealtimeNanos", SystemClock.elapsedRealtimeNanos());
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

    private JSONObject ownershipSummary(JSONObject snapshot, String prefix, boolean requirePlugin) throws Exception {
        JSONArray events = snapshot.getJSONArray("events");
        Map<Integer, JSONObject> created = new HashMap<>(), viewCreated = new HashMap<>();
        Map<Integer, Map<String, Integer>> activities = new HashMap<>(), views = new HashMap<>(), plugins = new HashMap<>();
        Map<Integer, Map<String, Long>> viewSequences = new HashMap<>();
        Set<Integer> destroyed = new HashSet<>(), activityDetached = new HashSet<>(), decorDetached = new HashSet<>();
        Set<Integer> pluginActivities = new HashSet<>();
        long previousSequence = 0, previousTime = 0;
        boolean integrity = snapshot.getLong("droppedEvents") == 0;
        JSONObject lastCreated = null;
        for (int i = 0; i < events.length(); i++) {
            JSONObject event = events.getJSONObject(i);
            long sequence = event.getLong("sequence"), tick = event.getLong("elapsedRealtimeNanos");
            integrity &= sequence == previousSequence + 1 && tick >= previousTime;
            previousSequence = sequence; previousTime = tick;
            String phase = event.getString("phase"), kind = event.getString("ownerKind");
            int owner = event.getInt("ownerIdentity");
            if ("decor".equals(kind)) {
                if ("decor-detach".equals(phase)) decorDetached.add(event.getInt("decorIdentity"));
                continue;
            }
            Map<Integer, Map<String, Integer>> owners;
            if ("activity".equals(kind)) owners = activities;
            else if ("view".equals(kind)) owners = views;
            else if ("plugin".equals(kind)) owners = plugins;
            else { integrity = false; continue; }
            Map<String, Integer> phases = owners.get(owner);
            if (phases == null) { phases = new HashMap<>(); owners.put(owner, phases); }
            phases.put(phase, phases.containsKey(phase) ? phases.get(phase) + 1 : 1);
            if ("plugin".equals(kind) && "plugin-destroy-enter".equals(phase)) pluginActivities.add(event.getInt("activityIdentity"));
            if ("activity".equals(kind)) {
                if (phase.equals(prefix + "create-exit")) { created.put(owner, event); lastCreated = event; }
                if (phase.equals(prefix + "destroy-exit")) destroyed.add(owner);
                if (phase.equals(prefix + "detach-exit")) activityDetached.add(owner);
            } else if ("view".equals(kind)) {
                if ("view-create".equals(phase)) viewCreated.put(owner, event);
                Map<String, Long> positions = viewSequences.get(owner);
                if (positions == null) { positions = new HashMap<>(); viewSequences.put(owner, positions); }
                positions.put(phase, sequence);
            }
        }
        Set<Integer> expectedViews = new HashSet<>();
        boolean activityComplete = created.size() == 2 && created.keySet().equals(destroyed);
        for (Map.Entry<Integer, JSONObject> entry : created.entrySet()) {
            JSONObject birth = entry.getValue(); expectedViews.add(birth.getInt("webViewIdentity"));
            integrity &= birth.getInt("windowIdentity") != 0 && birth.getInt("decorIdentity") != 0;
            Map<String, Integer> phases = activities.get(entry.getKey());
            for (String stage : new String[] {"create", "destroy"})
                activityComplete &= Integer.valueOf(1).equals(phases.get(prefix + stage + "-enter"))
                    && Integer.valueOf(1).equals(phases.get(prefix + stage + "-exit"));
            for (String stage : new String[] {"resume", "pause", "stop"})
                activityComplete &= phases.containsKey(prefix + stage + "-enter")
                    && phases.get(prefix + stage + "-enter").equals(phases.get(prefix + stage + "-exit"));
        }
        boolean twoViews = expectedViews.size() == 2 && !expectedViews.contains(0) && viewCreated.keySet().equals(expectedViews);
        JSONArray dispatch = new JSONArray(), missing = new JSONArray();
        boolean destroyedBothViews = twoViews;
        for (int view : expectedViews) {
            Map<String, Integer> phases = views.get(view);
            Map<String, Long> positions = viewSequences.get(view);
            int enters = phases != null && phases.containsKey("view-destroy-enter") ? phases.get("view-destroy-enter") : 0;
            int exits = phases != null && phases.containsKey("view-destroy-exit") ? phases.get("view-destroy-exit") : 0;
            JSONObject birth = viewCreated.get(view);
            boolean ownerKnown = birth != null && created.containsKey(birth.getInt("activityIdentity"))
                && created.get(birth.getInt("activityIdentity")).getInt("webViewIdentity") == view;
            boolean complete = enters == 1 && exits == 1 && ownerKnown
                && Integer.valueOf(1).equals(phases.get("view-create"))
                && positions.get("view-create") < positions.get("view-destroy-enter")
                && positions.get("view-destroy-enter") < positions.get("view-destroy-exit");
            destroyedBothViews &= complete;
            if (!complete) missing.put(view);
            dispatch.put(new JSONObject().put("viewIdentity", view).put("destroyEnters", enters)
                .put("destroyExits", exits).put("ownerKnown", ownerKnown).put("complete", complete));
        }
        boolean pluginComplete = !requirePlugin ? plugins.isEmpty() : plugins.size() == 2 && pluginActivities.equals(created.keySet());
        if (requirePlugin) for (Map<String, Integer> phases : plugins.values())
            for (String phase : new String[] {"plugin-destroy-enter", "plugin-cancel-complete", "plugin-cleanup-enter",
                    "plugin-cleanup-complete", "plugin-shutdown-requested", "plugin-destroy-exit"})
                pluginComplete &= Integer.valueOf(1).equals(phases.get(phase));
        boolean finalDetach = lastCreated != null && activityDetached.contains(lastCreated.getInt("ownerIdentity"))
            && decorDetached.contains(lastCreated.getInt("decorIdentity"));
        // Activity recreation can preserve Decor and replace its Window callback.
        // One final Activity detach never substitutes for the first view's destroy.
        return new JSONObject().put("schema", "shikuang-direct-WebView-ownership-v2")
            .put("integrity", integrity).put("activityDestroyedComplete", activityComplete)
            .put("twoDistinctCreatedViews", twoViews).put("finalWindowAndDecorDetached", finalDetach)
            .put("activityDetachExitCount", activityDetached.size()).put("pluginCleanupComplete", pluginComplete)
            .put("viewDestroyDispatch", dispatch).put("missingWebViewDestroyIds", missing)
            .put("ownershipComplete", integrity && activityComplete && twoViews && destroyedBothViews && pluginComplete && finalDetach)
            .put("nativeMemoryFullyReleased", JSONObject.NULL);
    }

    private boolean lifecycleComplete(String prefix, boolean requirePlugin) throws Exception {
        return ownershipSummary(new JSONObject(RuntimeLifecycleDiagnostics.snapshot()), prefix, requirePlugin)
            .getBoolean("ownershipComplete");
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
        runAndRecord("plain", proof -> {
            try (ActivityScenario<PlainWebViewDiagnosticActivity> scenario = ActivityScenario.launch(PlainWebViewDiagnosticActivity.class)) {
                awaitPlainPage(scenario);
                proof.put("initialPageReady", true);
                scenario.recreate();
                awaitPlainPage(scenario);
                proof.put("recreatedPageReady", true);
            }
            proof.put("scenarioCloseReturned", true);
            awaitLifecycleCompletion("plain-", false);
        });
    }

    @Test public void packagedMigrationSingleRecreateAndClose() throws Throwable {
        runAndRecord("packaged", proof -> {
            // Invoke the existing exact migration test, including every original
            // fixture, migration assertion and cleanup. No duplicate substitute.
            new MineralEngineInstrumentedTest().legacyNativeAssetMigrationPreservesSpecimens();
            proof.put("legacyMethodReturned", true);
            awaitLifecycleCompletion("", true);
        });
    }
}
