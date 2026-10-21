package com.shikuang.app;

import com.getcapacitor.WebViewLifetime;
import java.util.ArrayDeque;
import java.util.concurrent.Executor;
import org.junit.Test;
import static org.junit.Assert.*;

/** Tests the production lifetime class with deterministic queue interleavings. */
public final class WebViewLifetimeTest {
    private static final class MainQueue implements Executor {
        final ArrayDeque<Runnable> queue = new ArrayDeque<>();
        boolean main;
        public void execute(Runnable task) { queue.add(task); }
        void onMain(Runnable task) {
            boolean prior = main; main = true;
            try { task.run(); } finally { main = prior; }
        }
        void drain() { while (!queue.isEmpty()) onMain(queue.remove()); }
        WebViewLifetime owner() { return new WebViewLifetime(this, () -> main); }
    }

    @Test public void queuedBeforeCloseReleasesInsteadOfDelivering() {
        MainQueue q = new MainQueue(); WebViewLifetime owner = q.owner(); int[] calls = {0, 0};
        owner.execute(() -> calls[0]++, () -> calls[1]++);
        q.onMain(owner::beginClose); q.drain();
        assertArrayEquals(new int[] {0, 1}, calls);
    }

    @Test public void nativeProducerAfterCloseCannotReviveOwner() {
        MainQueue q = new MainQueue(); WebViewLifetime owner = q.owner(); int[] calls = {0, 0};
        q.onMain(owner::beginClose);
        owner.execute(() -> calls[0]++, () -> calls[1]++); q.drain();
        assertArrayEquals(new int[] {0, 1}, calls);
    }

    @Test public void oldAndNewActivityOwnersStaySeparate() {
        MainQueue q = new MainQueue(); WebViewLifetime old = q.owner(), fresh = q.owner(); int[] calls = {0, 0, 0};
        old.execute(() -> calls[0]++, () -> calls[1]++); q.onMain(old::beginClose);
        fresh.execute(() -> calls[2]++, () -> fail("new owner was abandoned")); q.drain();
        assertArrayEquals(new int[] {0, 1, 1}, calls);
    }

    @Test public void liveCancellationReplyIsDeliveredNormally() {
        MainQueue q = new MainQueue(); WebViewLifetime owner = q.owner(); StringBuilder replies = new StringBuilder();
        owner.execute(() -> replies.append("ABORT_ERR;cancelled=true"), () -> fail("live reply lost")); q.drain();
        assertEquals("ABORT_ERR;cancelled=true", replies.toString());
    }

    @Test public void mainCallerStillQueuesAndChecksAtDelivery() {
        MainQueue q = new MainQueue(); WebViewLifetime owner = q.owner(); int[] calls = {0, 0};
        q.onMain(() -> {
            owner.execute(() -> calls[0]++, () -> calls[1]++);
            assertArrayEquals(new int[] {0, 0}, calls);
            owner.beginClose();
        }); q.drain(); assertArrayEquals(new int[] {0, 1}, calls);
    }

    @Test public void closeOnWorkerFailsWithoutChangingOwner() {
        MainQueue q = new MainQueue(); WebViewLifetime owner = q.owner();
        try { owner.beginClose(); fail("worker close accepted"); } catch (IllegalStateException expected) { }
        assertTrue(owner.isOpen());
    }

    @Test public void miswiredExecutorCannotDeliverOnWorker() {
        WebViewLifetime owner = new WebViewLifetime(Runnable::run, () -> false); int[] calls = {0};
        try { owner.execute(() -> calls[0]++, () -> calls[0]++); fail("worker delivery accepted"); }
        catch (IllegalStateException expected) { }
        assertEquals(0, calls[0]);
    }

    @Test public void schedulerFailureIsNotConvertedIntoSuccess() {
        WebViewLifetime owner = new WebViewLifetime(task -> { throw new IllegalStateException("queue unavailable"); }, () -> true);
        try { owner.execute(() -> fail("unreachable"), () -> fail("unreachable")); fail("failure swallowed"); }
        catch (IllegalStateException expected) { assertEquals("queue unavailable", expected.getMessage()); }
    }

    @Test public void liveCallbackFailureRemainsVisible() {
        MainQueue q = new MainQueue(); WebViewLifetime owner = q.owner();
        owner.execute(() -> { throw new IllegalStateException("provider failed"); }, () -> fail("unreachable"));
        try { q.drain(); fail("provider failure swallowed"); }
        catch (IllegalStateException expected) { assertEquals("provider failed", expected.getMessage()); }
    }
}
