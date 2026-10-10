package com.shikuang.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MineralInferencePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
