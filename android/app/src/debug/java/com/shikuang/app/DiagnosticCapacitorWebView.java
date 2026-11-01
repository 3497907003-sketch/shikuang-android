package com.shikuang.app;

import android.content.Context;
import android.graphics.Canvas;
import android.os.Process;
import android.os.SystemClock;
import android.util.Log;
import android.util.AttributeSet;
import com.getcapacitor.CapacitorWebView;

/** Debug-only dispatch observer; each override calls the original super once. */
public final class DiagnosticCapacitorWebView extends CapacitorWebView {
    private final DiagnosticViewIdentity identity;
    private boolean firstDrawObserved;
    public DiagnosticCapacitorWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
        identity = new DiagnosticViewIdentity(this, context);
    }
    private void receipt(String phase) { if (identity != null) identity.receipt(phase); }
    @Override protected void onDraw(Canvas canvas) {
        final boolean first = !firstDrawObserved;
        if (first) {
            firstDrawObserved = true;
            // View/Canvas facts, not a claim that Chromium's GPU thread is absent.
            Log.i("ShikuangRendering", "{\"schema\":\"debug-first-draw-v1\",\"phase\":\"enter\",\"pid\":"
                + Process.myPid() + ",\"elapsedRealtimeNanos\":" + SystemClock.elapsedRealtimeNanos()
                + ",\"viewIdentity\":" + System.identityHashCode(this)
                + ",\"viewHardwareAccelerated\":" + isHardwareAccelerated()
                + ",\"canvasHardwareAccelerated\":" + canvas.isHardwareAccelerated()
                + ",\"layerType\":" + getLayerType() + "}");
        }
        super.onDraw(canvas);
        if (first) Log.i("ShikuangRendering", "{\"schema\":\"debug-first-draw-v1\",\"phase\":\"exit\",\"pid\":"
            + Process.myPid() + ",\"elapsedRealtimeNanos\":" + SystemClock.elapsedRealtimeNanos()
            + ",\"viewIdentity\":" + System.identityHashCode(this) + "}");
    }
    @Override public void destroy() {
        receipt("view-destroy-enter"); super.destroy(); receipt("view-destroy-exit");
    }
    @Override protected void onAttachedToWindow() {
        receipt("view-attach-enter"); super.onAttachedToWindow(); receipt("view-attach-exit");
    }
    @Override protected void onDetachedFromWindow() {
        receipt("view-detach-enter"); super.onDetachedFromWindow(); receipt("view-detach-exit");
    }
}
