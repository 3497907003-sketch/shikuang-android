package com.shikuang.app;

import android.app.Activity;
import android.content.Context;
import android.content.ContextWrapper;
import android.view.View;
import android.view.Window;

/** Cached integers only; no strong Activity/View/Context retained by observers. */
final class DiagnosticViewIdentity {
    final int viewIdentity, activityIdentity, windowIdentity, decorIdentity;

    DiagnosticViewIdentity(Object view, Context context) {
        Activity activity = null;
        Context cursor = context;
        for (int depth = 0; cursor != null && depth < 8; depth++) {
            if (cursor instanceof Activity) { activity = (Activity) cursor; break; }
            if (!(cursor instanceof ContextWrapper)) break;
            Context next = ((ContextWrapper) cursor).getBaseContext();
            if (next == cursor) break;
            cursor = next;
        }
        Window window = activity == null ? null : activity.getWindow();
        View decor = window == null ? null : window.peekDecorView();
        viewIdentity = System.identityHashCode(view);
        activityIdentity = System.identityHashCode(activity);
        windowIdentity = System.identityHashCode(window);
        decorIdentity = System.identityHashCode(decor);
        receipt("view-create");
    }

    void receipt(String phase) {
        RuntimeLifecycleDiagnostics.view(phase, viewIdentity, activityIdentity, windowIdentity, decorIdentity);
    }
}
