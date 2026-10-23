package com.shikuang.app;

import static org.junit.Assert.*;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Explicit finite-enum diagnostic only. Ordinary workflow does not select this class. */
@RunWith(AndroidJUnit4.class)
public final class NativeDialogEnumDiagnosticTest {
    @Test public void recoveryWindowFiniteEnums() throws Exception {
        assertTrue("Explicit diagnostic arguments required", NativeDialogDiagnostic.requested());
        android.app.UiAutomation automation = InstrumentationRegistry.getInstrumentation().getUiAutomation();
        android.accessibilityservice.AccessibilityServiceInfo original = automation.getServiceInfo();
        assertNotNull("Accessibility observer configuration unavailable", original);
        int originalFlags = original.flags;
        original.flags |= android.accessibilityservice.AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS;
        automation.setServiceInfo(original);
        MineralEngineInstrumentedTest harness = new MineralEngineInstrumentedTest();
        try {
            harness.scenario = ActivityScenario.launch(MainActivity.class);
            try {
                harness.requireSupportedWebView(); harness.awaitPage();
                harness.showMissingCapabilityRecovery();
                harness.awaitScreenshotDrawable("#native-boot-recovery");
                harness.requireNativeScreenshotWindow("native-dialog-enum-probe.png", "before");
            } finally {
                try { harness.clearMissingCapabilityRecoveryFixture(); }
                finally { harness.scenario.close(); }
            }
        } finally {
            android.accessibilityservice.AccessibilityServiceInfo restore = automation.getServiceInfo();
            if (restore != null) { restore.flags = originalFlags; automation.setServiceInfo(restore); }
        }
    }

    /** Runs the complete existing ordinary recognition test; only one gate is enumerated. */
    @Test public void recognitionWorkloadFiniteEnums() throws Exception {
        assertTrue("Explicit diagnostic arguments required", NativeDialogDiagnostic.requested());
        assertEquals("Exact post-native window scope required",
                NativeDialogDiagnostic.WORKLOAD_SCOPE, NativeDialogDiagnostic.scope());
        android.app.UiAutomation automation = InstrumentationRegistry.getInstrumentation().getUiAutomation();
        android.accessibilityservice.AccessibilityServiceInfo original = automation.getServiceInfo();
        assertNotNull("Accessibility observer configuration unavailable", original);
        int originalFlags = original.flags;
        original.flags |= android.accessibilityservice.AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS;
        automation.setServiceInfo(original);
        try {
            new MineralEngineInstrumentedTest().offlinePackagedNativeRecognitionAndRecovery();
        } finally {
            android.accessibilityservice.AccessibilityServiceInfo restore = automation.getServiceInfo();
            if (restore != null) { restore.flags = originalFlags; automation.setServiceInfo(restore); }
        }
    }
}
