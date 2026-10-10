package com.shikuang.app;

import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.platform.io.PlatformTestStorageRegistry;
import java.io.IOException;
import java.io.OutputStream;

/** Test-only output contract: the storage service owns files collected by UTP. */
final class RuntimeTestOutput {
    private RuntimeTestOutput() {}

    static OutputStream open(String name) throws IOException {
        if (!name.matches("[a-z0-9-]+\\.(json|png)")) {
            throw new IOException("Unsafe runtime evidence filename: " + name);
        }
        if (!"true".equals(InstrumentationRegistry.getArguments().getString("useTestStorageService"))) {
            throw new IOException("Runtime evidence requires AndroidX test storage service");
        }
        // The provider exposes a writeable stream to the instrumented app UID.
        // AGP pulls these same bytes after tests, even if later ADB disconnects.
        return PlatformTestStorageRegistry.getInstance().openOutputFile(name);
    }
}
