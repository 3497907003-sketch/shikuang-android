package com.shikuang.app;

import android.content.Context;
import android.util.AttributeSet;
import com.getcapacitor.CapacitorWebView;

/** Debug-only dispatch observer; each override calls the original super once. */
public final class DiagnosticCapacitorWebView extends CapacitorWebView {
    private final DiagnosticViewIdentity identity;
    public DiagnosticCapacitorWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
        identity = new DiagnosticViewIdentity(this, context);
    }
    private void receipt(String phase) { if (identity != null) identity.receipt(phase); }
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
