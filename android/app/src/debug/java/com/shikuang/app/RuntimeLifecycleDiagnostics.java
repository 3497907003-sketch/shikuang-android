package com.shikuang.app;

import android.os.Process;
import android.os.SystemClock;
import android.util.Log;
import android.view.View;
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

    public static void activity(String phase, Object owner, int webViewIdentity,
                                int windowIdentity, int decorIdentity, boolean changingConfigurations) {
        event(phase, "activity", System.identityHashCode(owner), System.identityHashCode(owner),
            webViewIdentity, windowIdentity, decorIdentity, changingConfigurations, -1, -1, null);
    }

    public static void plugin(String phase, Object owner, int activityIdentity, int webViewIdentity,
                              int jobs, int sessions, Boolean environmentPresent) {
        event(phase, "plugin", System.identityHashCode(owner), activityIdentity, webViewIdentity,
            0, 0, null, jobs, sessions, environmentPresent);
    }

    public static void view(String phase, int viewIdentity, int activityIdentity,
                            int windowIdentity, int decorIdentity) {
        event(phase, "view", viewIdentity, activityIdentity, viewIdentity,
            windowIdentity, decorIdentity, null, -1, -1, null);
    }

    public static void observeDecor(View decor, final int activityIdentity,
                                    final int windowIdentity, final int decorIdentity) {
        if (decor == null) return;
        // The listener captures integers only. A preserved Decor can have both
        // registrations; receipts describe their origin, not two detach events.
        decor.addOnAttachStateChangeListener(new View.OnAttachStateChangeListener() {
            @Override public void onViewAttachedToWindow(View ignored) { receipt("decor-attach"); }
            @Override public void onViewDetachedFromWindow(View ignored) { receipt("decor-detach"); }
            private void receipt(String phase) {
                // Android can invoke this before mAttachInfo is cleared. Do not
                // inspect isAttachedToWindow/parent or query a destroyed WebView.
                event(phase, "decor", decorIdentity, activityIdentity, 0,
                    windowIdentity, decorIdentity, null, -1, -1, null);
            }
        });
    }

    private static synchronized void event(String phase, String ownerKind, int ownerIdentity,
                                            int activityIdentity, int webViewIdentity,
                                            int windowIdentity, int decorIdentity, Boolean changingConfigurations,
                                            int jobs, int sessions, Boolean environmentPresent) {
        // All names are internal literals. No exception is caught or converted
        // into a successful lifecycle transition; missing exit remains missing.
        if (phase == null || phase.isEmpty() || phase.length() > 64) throw new IllegalArgumentException("Invalid lifecycle phase");
        for (int i = 0; i < phase.length(); i++) {
            char c = phase.charAt(i);
            if (c != '-' && (c < 'a' || c > 'z')) throw new IllegalArgumentException("Invalid lifecycle phase");
        }
        String row = "{\"schema\":\"shikuang-debug-lifecycle-v2\",\"sequence\":" + (++sequence)
            + ",\"elapsedRealtimeNanos\":" + SystemClock.elapsedRealtimeNanos()
            + ",\"pid\":" + Process.myPid() + ",\"tid\":" + Process.myTid()
            + ",\"phase\":\"" + phase + "\",\"ownerKind\":\"" + ownerKind
            + "\",\"ownerIdentity\":" + ownerIdentity + ",\"activityIdentity\":" + activityIdentity
            + ",\"webViewIdentity\":" + webViewIdentity + ",\"jobs\":" + jobs
            + ",\"windowIdentity\":" + windowIdentity + ",\"decorIdentity\":" + decorIdentity
            + ",\"changingConfigurations\":" + changingConfigurations
            + ",\"sessions\":" + sessions + ",\"environmentPresent\":" + environmentPresent + "}";
        if (EVENTS.size() == MAX_EVENTS) { EVENTS.removeFirst(); dropped++; }
        EVENTS.addLast(row);
        // Logcat survives a native signal before an AndroidX output can close.
        Log.i(TAG, row);
    }

    public static synchronized String snapshot() {
        StringBuilder json = new StringBuilder("{\"schema\":\"shikuang-debug-lifecycle-snapshot-v2\",\"pid\":")
            .append(Process.myPid()).append(",\"droppedEvents\":").append(dropped)
            .append(",\"events\":[");
        boolean first = true;
        for (String row : EVENTS) { if (!first) json.append(','); json.append(row); first = false; }
        return json.append("]}").toString();
    }
}
