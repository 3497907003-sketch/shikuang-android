package com.shikuang.app;

import static org.junit.Assert.*;
import org.junit.Test;

/** Resource fault injection only; no ONNX model or Android device is used. */
public class NativeResourceCleanupTest {
    private static final class Resource implements AutoCloseable {
        int closes;
        Throwable closeFailure;

        @Override public void close() throws Exception {
            closes++;
            if (closeFailure instanceof Error) throw (Error) closeFailure;
            if (closeFailure instanceof Exception) throw (Exception) closeFailure;
        }
    }

    @Test public void initializationOomStillClosesTheUnretainedResource() {
        Resource resource = new Resource();
        OutOfMemoryError failure = new OutOfMemoryError("metadata allocation");
        NativeResourceCleanup.closeAfterFailure(resource, failure);
        assertEquals(1, resource.closes);
        assertEquals(0, failure.getSuppressed().length);
    }

    @Test public void initializationLinkageErrorStillClosesTheUnretainedResource() {
        Resource resource = new Resource();
        LinkageError failure = new LinkageError("metadata JNI binding");
        NativeResourceCleanup.closeAfterFailure(resource, failure);
        assertEquals(1, resource.closes);
        assertEquals(0, failure.getSuppressed().length);
    }

    @Test public void cleanupExceptionDoesNotReplaceThePrimaryError() {
        Resource resource = new Resource();
        OutOfMemoryError failure = new OutOfMemoryError("metadata allocation");
        Exception cleanupFailure = new Exception("close failed");
        resource.closeFailure = cleanupFailure;
        NativeResourceCleanup.closeAfterFailure(resource, failure);
        assertEquals(1, resource.closes);
        assertArrayEquals(new Throwable[] { cleanupFailure }, failure.getSuppressed());
    }

    @Test public void cleanupOomDoesNotReplaceThePrimaryException() {
        Resource resource = new Resource();
        Exception failure = new Exception("invalid model shape");
        OutOfMemoryError cleanupFailure = new OutOfMemoryError("close allocation");
        resource.closeFailure = cleanupFailure;
        NativeResourceCleanup.closeAfterFailure(resource, failure);
        assertEquals(1, resource.closes);
        assertArrayEquals(new Throwable[] { cleanupFailure }, failure.getSuppressed());
    }

    @Test public void sameFailureCannotTriggerIllegalSelfSuppression() {
        Resource resource = new Resource();
        OutOfMemoryError failure = new OutOfMemoryError("same JNI failure");
        resource.closeFailure = failure;
        NativeResourceCleanup.closeAfterFailure(resource, failure);
        assertEquals(1, resource.closes);
        assertEquals(0, failure.getSuppressed().length);
    }
}
