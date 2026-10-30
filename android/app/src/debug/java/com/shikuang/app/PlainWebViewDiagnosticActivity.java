package com.shikuang.app;

import android.app.Activity;
import android.os.Bundle;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

/** Single-owner inline WebView control: no Capacitor, assets, models or requests. */
public final class PlainWebViewDiagnosticActivity extends Activity {
    private WebView webView;
    private int webViewIdentity;
    private int windowIdentity;
    private int decorIdentity;
    private boolean changingConfigurations;
    // 0=open, 1=retiring, 2=retired, 3=failed; a failed close is never retried.
    private int webViewRetirement;

    private void receipt(String phase) {
        RuntimeLifecycleDiagnostics.activity("plain-" + phase, this, webViewIdentity,
            windowIdentity, decorIdentity, changingConfigurations);
    }

    public WebView liveWebView() {
        if (webView == null) throw new IllegalStateException("Diagnostic WebView is not alive");
        return webView;
    }

    @Override public void onCreate(Bundle savedInstanceState) {
        receipt("create-enter");
        super.onCreate(savedInstanceState);
        FrameLayout container = new FrameLayout(this);
        setContentView(container);
        webView = new DiagnosticPlainWebView(this);
        webViewIdentity = System.identityHashCode(webView);
        if (RuntimeLifecycleDiagnostics.ENABLED) {
            android.view.Window window = getWindow();
            android.view.View decor = window == null ? null : window.peekDecorView();
            windowIdentity = System.identityHashCode(window);
            decorIdentity = System.identityHashCode(decor);
            RuntimeLifecycleDiagnostics.observeDecor(decor, System.identityHashCode(this), windowIdentity, decorIdentity);
        }
        container.addView(webView, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        webView.getSettings().setJavaScriptEnabled(true);
        webView.setWebViewClient(new WebViewClient());
        webView.loadDataWithBaseURL("https://localhost/diagnostic-plain", "<!doctype html><html>"
            + "<head><meta name='viewport' content='width=device-width,initial-scale=1'><title>WebView control</title></head>"
            + "<body><main id='plain-control'>Inline lifecycle control</main>"
            + "<script>window.__plainDiagnosticReady=true;</script></body></html>", "text/html", "UTF-8", null);
        receipt("create-exit");
    }

    @Override public void onResume() {
        receipt("resume-enter"); super.onResume(); receipt("resume-exit");
    }

    @Override public void onPause() {
        receipt("pause-enter"); super.onPause(); receipt("pause-exit");
    }

    @Override public void onStop() {
        receipt("stop-enter"); super.onStop(); receipt("stop-exit");
    }

    @Override public void onDestroy() {
        if (RuntimeLifecycleDiagnostics.ENABLED) changingConfigurations = isChangingConfigurations();
        receipt("destroy-enter");
        Throwable teardownFailure = null;
        try {
            retireWebViewOnce();
        } catch (RuntimeException | Error failure) {
            teardownFailure = failure;
        }
        try {
            super.onDestroy();
        } catch (RuntimeException | Error failure) {
            if (teardownFailure == null) teardownFailure = failure;
            else if (teardownFailure != failure) teardownFailure.addSuppressed(failure);
        }
        if (teardownFailure instanceof RuntimeException) throw (RuntimeException) teardownFailure;
        if (teardownFailure != null) throw (Error) teardownFailure;
        receipt("destroy-exit");
    }

    private void retireWebViewOnce() {
        if (webViewRetirement == 1 || webViewRetirement == 2) return;
        if (webViewRetirement == 3) throw new IllegalStateException("Prior control WebView retirement failed; not retrying");
        webViewRetirement = 1;
        WebView retiring = webView;
        // Remove the live handle before any provider call, including reentrant detach.
        webView = null;
        receipt("owner-close-enter");
        try {
            if (retiring == null) throw new IllegalStateException("Control WebView owner has no view");
            ViewParent parent = retiring.getParent();
            if (parent != null) {
                if (!(parent instanceof ViewGroup)) throw new IllegalStateException("Control WebView parent is not removable");
                ((ViewGroup) parent).removeView(retiring);
                if (retiring.getParent() != null) throw new IllegalStateException("Control WebView parent removal did not complete");
            }
            retiring.stopLoading();
            retiring.setWebViewClient(new WebViewClient());
            retiring.setWebChromeClient(null);
            retiring.removeAllViews();
            retiring.destroy();
            webViewRetirement = 2;
            receipt("owner-close-exit");
        } catch (RuntimeException | Error failure) {
            webViewRetirement = 3;
            receipt("owner-close-failed");
            throw failure;
        }
    }

    @Override public void onDetachedFromWindow() {
        receipt("detach-enter");
        super.onDetachedFromWindow();
        // Preserved-window recreation may skip this callback for the old Activity.
        // Only an owner not yet closed can use this bounded fallback.
        retireWebViewOnce();
        receipt("detach-exit");
    }
}
