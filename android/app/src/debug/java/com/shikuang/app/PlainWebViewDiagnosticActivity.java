package com.shikuang.app;

import android.app.Activity;
import android.os.Bundle;
import android.view.ViewGroup;
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
        receipt("destroy-enter"); super.onDestroy(); receipt("destroy-exit");
    }

    @Override public void onDetachedFromWindow() {
        receipt("detach-enter");
        super.onDetachedFromWindow();
        // Match Capacitor's window-detach destruction boundary, while retaining
        // sole ownership of this control view. Never call destroy a second time.
        WebView retiring = webView;
        webView = null;
        if (retiring != null) {
            if (retiring.getParent() instanceof ViewGroup) ((ViewGroup) retiring.getParent()).removeView(retiring);
            retiring.stopLoading();
            retiring.removeAllViews();
            retiring.destroy();
        }
        receipt("detach-exit");
    }
}
