package com.shikuang.app;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkInfo;
import android.net.NetworkRequest;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private ConnectivityManager connectivityManager;
    private ConnectivityManager.NetworkCallback networkCallback;
    private boolean networkMonitorDestroyed;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MineralInferencePlugin.class);
        super.onCreate(savedInstanceState);
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
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                connectivityManager.registerDefaultNetworkCallback(networkCallback);
            } else {
                connectivityManager.registerNetworkCallback(new NetworkRequest.Builder()
                    .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build(), networkCallback);
            }
        }
    }

    private void updateWebViewNetworkState() {
        runOnUiThread(() -> {
            if (networkMonitorDestroyed || bridge == null || bridge.getWebView() == null) return;
            boolean available = false;
            if (connectivityManager != null) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    Network network = connectivityManager.getActiveNetwork();
                    NetworkCapabilities capabilities = network == null ? null : connectivityManager.getNetworkCapabilities(network);
                    available = capabilities != null && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
                } else {
                    // minSdk 22 predates getActiveNetwork; retain the supported connectivity API.
                    NetworkInfo info = connectivityManager.getActiveNetworkInfo();
                    available = info != null && info.isConnected();
                }
            }
            bridge.getWebView().setNetworkAvailable(available);
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
