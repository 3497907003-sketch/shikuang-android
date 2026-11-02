package com.shikuang.app;

/** Releases a not-yet-retained native resource without replacing its failure. */
final class NativeResourceCleanup {
    private NativeResourceCleanup() {}

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
