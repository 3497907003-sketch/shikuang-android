package com.shikuang.app;

/** Release no-op counterpart; the source-set constant also removes observers. */
public final class RuntimeLifecycleDiagnostics {
    public static final boolean ENABLED = false;
    private RuntimeLifecycleDiagnostics() {}
    public static void activity(String phase, Object owner, int webViewIdentity) {}
    public static void plugin(String phase, Object owner, int activityIdentity, int webViewIdentity,
                              int jobs, int sessions, Boolean environmentPresent) {}
}
