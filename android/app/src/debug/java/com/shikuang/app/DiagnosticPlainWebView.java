package com.shikuang.app;

import android.content.Context;
import android.webkit.WebView;

/** Plain arm uses the same observation points without changing cleanup. */
public final class DiagnosticPlainWebView extends WebView {
    private final DiagnosticViewIdentity identity;
    public DiagnosticPlainWebView(Context context) {
        super(context);
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
