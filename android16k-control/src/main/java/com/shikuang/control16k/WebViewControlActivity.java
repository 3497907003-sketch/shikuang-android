package com.shikuang.control16k;

import android.app.Activity;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.WebView;

/** Independent control APK only. No product classes, assets, models or Capacitor. */
public final class WebViewControlActivity extends Activity {
    private WebView web;
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        web = new WebView(this);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        android.net.ConnectivityManager network = (android.net.ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        web.setNetworkAvailable(network != null && network.getActiveNetwork() != null);
        setContentView(web);
        web.loadDataWithBaseURL("https://control.invalid/", "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'><meta charset='UTF-8'></head><body style='margin:20px;font-family:sans-serif'><h2>16KB WebView control</h2><label>实验观察<textarea id='notes' style='display:block;box-sizing:border-box;width:100%;height:90px;font-size:18px'></textarea></label><label>矿物搜索<input id='librarySearch' style='display:block;box-sizing:border-box;width:100%;height:48px;font-size:18px'></label><label>标本搜索<input id='recordSearch' style='display:block;box-sizing:border-box;width:100%;height:48px;font-size:18px'></label><script>window.controlReady=true;</script></body></html>", "text/html", "UTF-8", null);
    }
    public WebView getWebView() { return web; }
    @Override public void onDestroy() {
        if (web != null) {
            if (web.getParent() instanceof ViewGroup) ((ViewGroup) web.getParent()).removeView(web);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
