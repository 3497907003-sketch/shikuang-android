package com.shikuang.app;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.text.BidiFormatter;
import android.view.accessibility.AccessibilityNodeInfo;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;

/** Proposed explicit API35 test-only observer. Never logs text or changes UI. */
final class NativeDialogDiagnostic {
    static final String REPORT_FILE = "native-dialog-enum-report.json";
    static final int MAX_NODES = 200;
    static final long MAX_WAIT_MS = 2000;
    // The only packages queried through PackageManager. Test manifest repeats this list.
    static final String[][] PACKAGES = {
        {"android", "android_framework"},
        {"com.android.systemui", "android_systemui"},
        {"com.google.android.apps.messaging", "google_messaging"},
        {"com.google.android.gms", "play_services"},
        {"com.google.android.webview", "webview"},
        {"com.android.permissioncontroller", "permission_controller"},
        {"com.google.android.permissioncontroller", "permission_controller"},
        {"com.shikuang.app.preview", "this_app"},
        {"com.shikuang.app", "this_app"}
    };
    // AOSP AppErrorDialog + AppNotRespondingDialog and their Android15 layouts.
    static final String[] RESOURCE_ENUMS = {"aerr_restart", "aerr_app_info", "aerr_close", "aerr_report", "aerr_mute", "aerr_wait"};
    static final String[] TITLE_FORMATS = {"aerr_application", "aerr_application_repeated", "aerr_process", "aerr_process_repeated", "anr_application_process", "anr_process"};

    static boolean requested() {
        Bundle a = InstrumentationRegistry.getArguments();
        if (!"true".equals(a.getString("nativeDialogDiagnostic"))) return false;
        if (Build.VERSION.SDK_INT != 35 || !"4096".equals(a.getString("expectedPageSize"))
                || !a.getString("expectedSourceSha", "").matches("[a-f0-9]{40}")
                || !a.getString("diagnosticNonce", "").matches("[a-f0-9]{32}"))
            throw new IllegalStateException("Explicit pinned API35 diagnostic arguments required");
        return true;
    }
    static String component(CharSequence value) {
        if (value != null) for (String[] p : PACKAGES) if (p[0].contentEquals(value)) return p[1];
        return "unknown";
    }
    static String resource(String id) {
        for (String e : RESOURCE_ENUMS) if (("android:id/" + e).equals(id)) return e;
        return "unknown";
    }
    static void bump(Map<String, Integer> counts, String key) { counts.put(key, counts.getOrDefault(key, 0) + 1); }
    static JSONObject empty(String stop, Boolean focus, String root) throws Exception {
        return new JSONObject().put("completed", false).put("stop", stop).put("nodes_visited", 0)
                .put("root_component", root).put("webview_focus", focus == null ? JSONObject.NULL : focus)
                .put("node_component_counts", new JSONObject()).put("error_resource_enum_counts", new JSONObject())
                .put("system_error_controls_observed", false).put("title_comparison_performed", false)
                .put("title_component", "unknown").put("title_match_state", "none");
    }
    static boolean alive(AtomicBoolean accepting, long deadline) { return accepting.get() && SystemClock.elapsedRealtime() < deadline; }

    /** The caller owns the wait cap. A blocked Android IPC may return later; it cannot publish late. */
    static JSONObject bounded(AccessibilityNodeInfo ownedRoot, Boolean focus, long gateDeadline) throws Exception {
        long deadline = Math.min(gateDeadline, SystemClock.elapsedRealtime() + MAX_WAIT_MS);
        if (SystemClock.elapsedRealtime() >= deadline) { ownedRoot.recycle(); return empty("time_cap", focus, "unknown"); }
        AtomicBoolean accepting = new AtomicBoolean(true);
        AtomicReference<JSONObject> published = new AtomicReference<>();
        CountDownLatch returned = new CountDownLatch(1); Object lock = new Object();
        Thread worker = new Thread(() -> {
            JSONObject safe = null;
            try { safe = walk(ownedRoot, focus, deadline, accepting); }
            catch (Throwable ignored) { try { safe = empty("exception", focus, "unknown"); } catch (Exception alsoIgnored) { } }
            finally {
                synchronized (lock) { if (alive(accepting, deadline)) published.set(safe); }
                returned.countDown();
            }
        }, "shikuang-finite-dialog-observer");
        worker.setDaemon(true);
        try { worker.start(); } catch (RuntimeException error) { ownedRoot.recycle(); throw error; }
        boolean done;
        try { done = returned.await(Math.max(1, deadline - SystemClock.elapsedRealtime()), TimeUnit.MILLISECONDS); }
        finally { synchronized (lock) { accepting.set(false); } }
        synchronized (lock) {
            JSONObject safe = published.get();
            return done && safe != null && SystemClock.elapsedRealtime() < deadline
                    ? safe : empty("ipc_timeout", focus, "unknown");
        }
    }
    private static JSONObject walk(AccessibilityNodeInfo root, Boolean focus, long deadline, AtomicBoolean accepting) throws Exception {
        ArrayDeque<AccessibilityNodeInfo> queue = new ArrayDeque<>();
        ArrayList<AccessibilityNodeInfo> titles = new ArrayList<>();
        Map<String,Integer> packages = new TreeMap<>(), resources = new TreeMap<>();
        String rootEnum = "unknown"; int acquired = 1, visited = 0;
        boolean framework = false;
        queue.add(root);
        try {
            rootEnum = component(root.getPackageName()); framework = "android_framework".equals(rootEnum);
            while (!queue.isEmpty() && visited < MAX_NODES && alive(accepting, deadline)) {
                AccessibilityNodeInfo n = queue.remove(); boolean retained = false;
                try {
                    visited++; bump(packages, component(n.getPackageName()));
                    String id = n.getViewIdResourceName();
                    if (framework && n.isVisibleToUser()) {
                        String e = resource(id); if (!"unknown".equals(e)) bump(resources, e);
                        // No other node text/contentDescription is ever accessed.
                        if ("android:id/alertTitle".equals(id) && titles.size() < 4) { titles.add(n); retained = true; }
                    }
                    int children = n.getChildCount();
                    for (int i = 0; i < children && acquired < MAX_NODES && alive(accepting, deadline); i++) {
                        acquired++; // Reserve a node slot even when the provider returns null.
                        AccessibilityNodeInfo child = n.getChild(i);
                        if (child != null) queue.add(child);
                    }
                } finally { if (!retained) n.recycle(); }
            }
            int controls = 0; for (int count : resources.values()) controls += count;
            boolean errorControls = framework && resources.getOrDefault("aerr_close", 0) > 0 && controls >= 2;
            JSONObject safe = empty("complete", focus, rootEnum).put("completed", true).put("nodes_visited", visited)
                    .put("node_component_counts", new JSONObject(packages)).put("error_resource_enum_counts", new JSONObject(resources))
                    .put("system_error_controls_observed", errorControls);
            if (!alive(accepting, deadline)) return safe.put("stop", "time_cap");
            if (acquired >= MAX_NODES) safe.put("stop", "node_cap");
            if (!errorControls || titles.isEmpty()) return safe;
            // Match only exact, locally formatted AOSP framework titles for fixed packages.
            Context context = InstrumentationRegistry.getInstrumentation().getContext();
            PackageManager pm = context.getPackageManager(); BidiFormatter bidi = BidiFormatter.getInstance();
            Map<String,Set<String>> expected = new HashMap<>();
            for (String[] entry : PACKAGES) {
                if (!alive(accepting, deadline)) return safe.put("stop", "time_cap");
                try {
                    ApplicationInfo info = pm.getApplicationInfo(entry[0], 0);
                    CharSequence rawLabel = pm.getApplicationLabel(info);
                    if (rawLabel == null || rawLabel.length() > 256 || info.processName == null || info.processName.length() > 256) continue;
                    String label = bidi.unicodeWrap(rawLabel.toString()), process = bidi.unicodeWrap(info.processName);
                    Set<String> values = expected.computeIfAbsent(entry[1], ignored -> new HashSet<>());
                    for (String format : TITLE_FORMATS) {
                        if (!alive(accepting, deadline)) return safe.put("stop", "time_cap");
                        int id = context.getResources().getIdentifier(format, "string", "android");
                        if (id == 0) continue;
                        if (format.equals("anr_application_process") || format.startsWith("aerr_application")) values.add(context.getString(id, label, process));
                        else values.add(context.getString(id, process));
                    }
                } catch (PackageManager.NameNotFoundException | android.content.res.Resources.NotFoundException ignored) { }
            }
            Set<String> matches = new HashSet<>();
            for (AccessibilityNodeInfo title : titles) {
                if (!alive(accepting, deadline)) return safe.put("stop", "time_cap");
                CharSequence text = title.getText();
                if (text == null || text.length() > 512) continue;
                String localTitle = text.toString();
                for (Map.Entry<String,Set<String>> entry : expected.entrySet()) if (entry.getValue().contains(localTitle)) matches.add(entry.getKey());
            }
            return safe.put("title_comparison_performed", true)
                    .put("title_component", matches.size() == 1 ? matches.iterator().next() : "unknown")
                    .put("title_match_state", matches.isEmpty() ? "none" : matches.size() == 1 ? "unique" : "ambiguous");
        } finally {
            while (!queue.isEmpty()) queue.remove().recycle();
            for (AccessibilityNodeInfo n : titles) n.recycle();
        }
    }
    static JSONObject report(boolean passed, int observations, Boolean lastFocus, JSONObject tree) throws Exception {
        Bundle args = InstrumentationRegistry.getArguments();
        return new JSONObject().put("schema", "android-native-dialog-finite-enums-v1")
                .put("source_sha_argument", args.getString("expectedSourceSha"))
                .put("diagnostic_nonce", args.getString("diagnosticNonce"))
                .put("gate_passed", passed).put("gate_observation_count", observations)
                .put("last_gate_webview_focus", lastFocus == null ? JSONObject.NULL : lastFocus)
                .put("first_mismatch_tree", tree == null ? empty("not_observed", lastFocus, "unknown") : tree)
                .put("dialog_cause_or_current_identity_established", false).put("release_acceptance", false);
    }
    static void writeReport(JSONObject safe) throws Exception {
        byte[] bytes = safe.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
        if (bytes.length > 65536) throw new IllegalStateException("Finite diagnostic JSON cap exceeded");
        try (java.io.OutputStream output = RuntimeTestOutput.open(REPORT_FILE)) { output.write(bytes); }
    }
}
