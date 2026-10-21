package com.getcapacitor;

import java.util.Objects;
import java.util.concurrent.Executor;
import java.util.function.BooleanSupplier;

/** One Bridge's delivery lifetime. No provider calls or global/static owner. */
public final class WebViewLifetime {
    private final Executor mainExecutor;
    private final BooleanSupplier mainThread;
    private volatile boolean open = true;

    public WebViewLifetime(Executor mainExecutor, BooleanSupplier mainThread) {
        this.mainExecutor = Objects.requireNonNull(mainExecutor);
        this.mainThread = Objects.requireNonNull(mainThread);
    }

    public boolean isOpen() { return open; }

    public void requireMainThread() {
        if (!mainThread.getAsBoolean()) throw new IllegalStateException("WebView ownership requires the main thread");
    }

    public void beginClose() {
        requireMainThread();
        open = false;
    }

    /** Always enqueue; the decision is made at actual main-thread delivery. */
    public void execute(Runnable live, Runnable abandoned) {
        Objects.requireNonNull(live); Objects.requireNonNull(abandoned);
        mainExecutor.execute(() -> {
            requireMainThread();
            if (open) live.run(); else abandoned.run();
        });
    }
}
