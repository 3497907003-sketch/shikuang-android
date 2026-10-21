package com.shikuang.app;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

public class MainActivity extends BridgeActivity {
    private ConnectivityManager connectivityManager;
    private ConnectivityManager.NetworkCallback networkCallback;
    private boolean networkMonitorDestroyed;
    private int diagnosticWebViewIdentity;
    private int diagnosticWindowIdentity;
    private int diagnosticDecorIdentity;
    private boolean diagnosticChangingConfigurations;

    private void lifecycleReceipt(String phase) {
        if (RuntimeLifecycleDiagnostics.ENABLED) RuntimeLifecycleDiagnostics.activity(phase, this, diagnosticWebViewIdentity,
            diagnosticWindowIdentity, diagnosticDecorIdentity, diagnosticChangingConfigurations);
    }

    int diagnosticWebViewIdentity() { return diagnosticWebViewIdentity; }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        lifecycleReceipt("create-enter");
        registerPlugin(MineralInferencePlugin.class);
        super.onCreate(savedInstanceState);
        // Cache only an identity number while the WebView is alive. Later
        // destruction receipts must never call methods on a destroyed view.
        if (RuntimeLifecycleDiagnostics.ENABLED) {
            diagnosticWebViewIdentity = System.identityHashCode(bridge.getWebView());
            android.view.Window diagnosticWindow = getWindow();
            android.view.View diagnosticDecor = diagnosticWindow == null ? null : diagnosticWindow.peekDecorView();
            diagnosticWindowIdentity = System.identityHashCode(diagnosticWindow);
            diagnosticDecorIdentity = System.identityHashCode(diagnosticDecor);
            RuntimeLifecycleDiagnostics.observeDecor(diagnosticDecor, System.identityHashCode(this),
                diagnosticWindowIdentity, diagnosticDecorIdentity);
        }
        installPackagedAssetMigration();
        connectivityManager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        updateWebViewNetworkState();
        if (connectivityManager != null) {
            networkCallback = new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(Network network) {
                    updateWebViewNetworkState();
                }

                @Override
                public void onLost(Network network) {
                    updateWebViewNetworkState();
                }

                @Override
                public void onCapabilitiesChanged(Network network, NetworkCapabilities capabilities) {
                    updateWebViewNetworkState();
                }
            };
            connectivityManager.registerDefaultNetworkCallback(networkCallback);
        }
        lifecycleReceipt("create-exit");
    }

    private void updateWebViewNetworkState() {
        runOnUiThread(() -> {
            if (networkMonitorDestroyed || bridge == null || bridge.getWebView() == null) return;
            boolean available = false;
            if (connectivityManager != null) {
                Network network = connectivityManager.getActiveNetwork();
                NetworkCapabilities capabilities = network == null ? null : connectivityManager.getNetworkCapabilities(network);
                available = capabilities != null && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
            }
            bridge.getWebView().setNetworkAvailable(available);
        });
    }

    private void installPackagedAssetMigration() {
        // Read from the signed APK, never through a possibly stale localhost Worker.
        final String script;
        try (InputStream input = getAssets().open("public/native-assets.js");
             ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096]; int size;
            while ((size = input.read(buffer)) != -1) {
                if (bytes.size() + size > 32768) throw new IllegalStateException("Native migration asset is oversized");
                bytes.write(buffer, 0, size);
            }
            script = new String(bytes.toByteArray(), StandardCharsets.UTF_8)
                + "\nwindow.MineralNativeAssets.boot(true);if(typeof Promise==='function' && typeof URL==='function')window.MineralNativeAssets.prepare(true).catch(function(error){console.error('Native asset migration: '+error.message);});";
        } catch (Exception error) {
            Log.e("ShikuangAssets", "Cannot read trusted native asset migration", error);
            return;
        }
        bridge.setWebViewClient(new BridgeWebViewClient(bridge) {
            @Override public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                if (networkMonitorDestroyed || url == null) return;
                Uri actual = Uri.parse(url), local = Uri.parse(bridge.getLocalUrl());
                if (!local.getScheme().equals(actual.getScheme()) || !local.getAuthority().equals(actual.getAuthority())) return;
                view.evaluateJavascript(script, null);
            }
        });
    }

    @Override
    public void onResume() {
        lifecycleReceipt("resume-enter");
        super.onResume();
        updateWebViewNetworkState();
        lifecycleReceipt("resume-exit");
    }

    @Override
    public void onPause() {
        lifecycleReceipt("pause-enter");
        super.onPause();
        lifecycleReceipt("pause-exit");
    }

    @Override
    public void onStop() {
        lifecycleReceipt("stop-enter");
        super.onStop();
        lifecycleReceipt("stop-exit");
    }

    @Override
    public void onDestroy() {
        if (RuntimeLifecycleDiagnostics.ENABLED) diagnosticChangingConfigurations = isChangingConfigurations();
        lifecycleReceipt("destroy-enter");
        networkMonitorDestroyed = true;
        if (connectivityManager != null && networkCallback != null) {
            try {
                connectivityManager.unregisterNetworkCallback(networkCallback);
            } catch (IllegalArgumentException error) {
                Log.w("ShikuangNetwork", "Network callback was already unregistered", error);
            }
            networkCallback = null;
        }
        super.onDestroy();
        lifecycleReceipt("destroy-exit");
    }

    @Override
    public void onDetachedFromWindow() {
        lifecycleReceipt("detach-enter");
        // Capacitor remains the sole owner of WebView.destroy().
        super.onDetachedFromWindow();
        lifecycleReceipt("detach-exit");
    }
}
