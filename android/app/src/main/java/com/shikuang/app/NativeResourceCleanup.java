package com.shikuang.app;

/** Releases a not-yet-retained native resource without replacing its failure. */
final class NativeResourceCleanup {
    private NativeResourceCleanup() {}

    /** Candidate gate handoff: retain failures and unattempted owners for cleanup. */
    static <T extends AutoCloseable> void closeAllStrict(java.util.Map<String,T> resources) throws Exception {
        java.util.Iterator<java.util.Map.Entry<String,T>> entries=resources.entrySet().iterator();
        while (entries.hasNext()) {
            java.util.Map.Entry<String,T> entry=entries.next();
            entry.getValue().close(); // Do not allocate the next model after failure.
            entries.remove();
        }
    }

    static void closeAfterFailure(AutoCloseable resource, Throwable failure) {
        try {
            resource.close();
        } catch (Exception | Error cleanupFailure) {
            if (cleanupFailure != failure) {
                try {
                    failure.addSuppressed(cleanupFailure);
                } catch (OutOfMemoryError ignored) {
                    // Suppression is diagnostic allocation; preserve the original
                    // failure even when the VM cannot allocate its suppressed list.
                }
            }
        }
    }
}
