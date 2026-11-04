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

    @Test public void strictHandoffClosesAndRemovesAllOwnersBeforeNextAllocation() throws Exception {
        Resource gate=new Resource(),prior=new Resource();
        java.util.Map<String,Resource> owners=new java.util.LinkedHashMap<>();owners.put("prior",prior);owners.put("gate",gate);
        NativeResourceCleanup.closeAllStrict(owners);
        assertTrue(owners.isEmpty());assertEquals(1,prior.closes);assertEquals(1,gate.closes);
    }

    @Test public void strictHandoffRetainsFailedAndUnattemptedOwnersAndStopsNextAllocation() {
        Resource prior=new Resource(),gate=new Resource(),unattempted=new Resource();
        gate.closeFailure=new Exception("gate close failed");
        java.util.Map<String,Resource> owners=new java.util.LinkedHashMap<>();owners.put("prior",prior);owners.put("gate",gate);owners.put("unattempted",unattempted);
        boolean allocated=false;
        try {NativeResourceCleanup.closeAllStrict(owners);allocated=true;fail("close failure accepted");}
        catch (Exception expected) {assertSame(gate.closeFailure,expected);}
        assertFalse(allocated);assertEquals(1,prior.closes);assertEquals(1,gate.closes);assertEquals(0,unattempted.closes);
        assertFalse(owners.containsKey("prior"));assertTrue(owners.containsKey("gate"));assertTrue(owners.containsKey("unattempted"));
    }

    @Test public void strictHandoffDoesNotSwallowNativeLinkageOrAllocationErrors() throws Exception {
        for (Error error:new Error[]{new LinkageError("JNI close"),new OutOfMemoryError("close")}) {
            Resource gate=new Resource();gate.closeFailure=error;
            java.util.Map<String,Resource> owners=new java.util.LinkedHashMap<>();owners.put("gate",gate);
            try {NativeResourceCleanup.closeAllStrict(owners);fail("native Error accepted");}
            catch (Error expected) {assertSame(error,expected);}
            assertEquals(1,gate.closes);assertTrue(owners.containsKey("gate"));
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
