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

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MineralInferencePlugin.class);
        super.onCreate(savedInstanceState);
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
        super.onResume();
        updateWebViewNetworkState();
    }

    @Override
    public void onDestroy() {
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
    }
}
