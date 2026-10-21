package com.shikuang.app;

import android.os.Process;
import android.os.SystemClock;
import android.util.Log;
import java.util.ArrayDeque;

/** Debug-only bounded observer. No WebView calls, files, user values or cleanup. */
public final class RuntimeLifecycleDiagnostics {
    public static final boolean ENABLED = true;
    private static final String TAG = "ShikuangLifecycle";
    private static final int MAX_EVENTS = 256;
    private static final ArrayDeque<String> EVENTS = new ArrayDeque<>();
    private static long sequence;
    private static long dropped;

    private RuntimeLifecycleDiagnostics() {}

    public static void activity(String phase, Object owner, int webViewIdentity) {
        event(phase, "activity", System.identityHashCode(owner), System.identityHashCode(owner),
            webViewIdentity, -1, -1, null);
    }

    public static void plugin(String phase, Object owner, int activityIdentity, int webViewIdentity,
                              int jobs, int sessions, Boolean environmentPresent) {
        event(phase, "plugin", System.identityHashCode(owner), activityIdentity, webViewIdentity,
            jobs, sessions, environmentPresent);
    }

    private static synchronized void event(String phase, String ownerKind, int ownerIdentity,
                                            int activityIdentity, int webViewIdentity,
                                            int jobs, int sessions, Boolean environmentPresent) {
        // All names are internal literals. No exception is caught or converted
        // into a successful lifecycle transition; missing exit remains missing.
        if (phase == null || phase.isEmpty() || phase.length() > 64) throw new IllegalArgumentException("Invalid lifecycle phase");
        for (int i = 0; i < phase.length(); i++) {
            char c = phase.charAt(i);
            if (c != '-' && (c < 'a' || c > 'z')) throw new IllegalArgumentException("Invalid lifecycle phase");
        }
        String row = "{\"schema\":\"shikuang-debug-lifecycle-v1\",\"sequence\":" + (++sequence)
            + ",\"elapsedRealtimeNanos\":" + SystemClock.elapsedRealtimeNanos()
            + ",\"pid\":" + Process.myPid() + ",\"tid\":" + Process.myTid()
            + ",\"phase\":\"" + phase + "\",\"ownerKind\":\"" + ownerKind
            + "\",\"ownerIdentity\":" + ownerIdentity + ",\"activityIdentity\":" + activityIdentity
            + ",\"webViewIdentity\":" + webViewIdentity + ",\"jobs\":" + jobs
            + ",\"sessions\":" + sessions + ",\"environmentPresent\":" + environmentPresent + "}";
        if (EVENTS.size() == MAX_EVENTS) { EVENTS.removeFirst(); dropped++; }
        EVENTS.addLast(row);
        // Logcat survives a native signal before an AndroidX output can close.
        Log.i(TAG, row);
    }

    public static synchronized String snapshot() {
        StringBuilder json = new StringBuilder("{\"schema\":\"shikuang-debug-lifecycle-snapshot-v1\",\"pid\":")
            .append(Process.myPid()).append(",\"droppedEvents\":").append(dropped)
            .append(",\"events\":[");
        boolean first = true;
        for (String row : EVENTS) { if (!first) json.append(','); json.append(row); first = false; }
        return json.append("]}").toString();
    }
}
