package com.shikuang.app;

import static org.junit.Assert.*;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.ConnectivityManager;
import android.os.Build;
import android.system.Os;
import android.system.OsConstants;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Genuine packaged JPEG decoding; source labels are not laboratory confirmation. */
@RunWith(AndroidJUnit4.class)
public final class ReviewedPhotoAssetsInstrumentedTest {
    private byte[] bytes(Context context, String path, int limit) throws Exception {
        try (InputStream input = context.getAssets().open("public/" + path);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16384]; int count;
            while ((count = input.read(buffer)) != -1) {
                assertTrue("Packaged resource exceeded its byte bound: " + path, output.size() + count <= limit);
                output.write(buffer, 0, count);
            }
            return output.toByteArray();
        }
    }

    private JSONObject json(Context context, String path, int limit) throws Exception {
        return new JSONObject(new String(bytes(context, path, limit), StandardCharsets.UTF_8));
    }

    private String sha256(byte[] bytes) throws Exception {
        StringBuilder text = new StringBuilder();
        for (byte value : MessageDigest.getInstance("SHA-256").digest(bytes))
            text.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
        return text.toString();
    }

    @Test public void everyReviewedPackagedPhotoHasExactBytesAndDecodesOffline() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        ConnectivityManager network = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        assertNotNull(network);
        assertNull("Photo decoding test requires genuinely unavailable networking", network.getActiveNetwork());
        JSONObject reference = json(context, "data/reference-manifest.json", 100000);
        byte[] manifestBytes = bytes(context, "data/reviewed-photo-assets.json", 262144);
        JSONObject manifest = new JSONObject(new String(manifestBytes, StandardCharsets.UTF_8));
        JSONObject sources = json(context, "data/image-sources.json", 10000000);
        assertEquals(1, manifest.getInt("schema_version"));
        JSONArray assets = manifest.getJSONArray("assets"), records = sources.getJSONArray("records");
        assertEquals(reference.getJSONObject("counts").getInt("source_image_records"), records.length());
        assertEquals(reference.getJSONObject("counts").getInt("local_reviewed_photos"), assets.length());
        assertTrue(assets.length() > 0 && assets.length() <= 1000);
        Map<String, JSONObject> byPath = new HashMap<>();
        for (int index = 0; index < records.length(); index++) {
            JSONObject row = records.getJSONObject(index);
            if (!row.has("local_image_url") || row.isNull("local_image_url")) continue;
            String path = row.getString("local_image_url");
            assertNull("Duplicate local photo source: " + path, byPath.put(path, row));
        }
        assertEquals(assets.length(), byPath.size());
        JSONArray decoded = new JSONArray(); Set<String> paths = new HashSet<>();
        for (int index = 0; index < assets.length(); index++) {
            JSONObject asset = assets.getJSONObject(index); String path = asset.getString("path");
            assertTrue(path.matches("images/reviewed-v25/commons-[0-9]+\\.jpg"));
            assertTrue("Repeated photo asset", paths.add(path));
            int expectedBytes = asset.getInt("bytes");
            assertTrue(expectedBytes >= 4 && expectedBytes <= 1048576);
            JSONObject source = byPath.get(path); assertNotNull(source);
            assertEquals(expectedBytes, source.getInt("bytes"));
            assertEquals(asset.getString("sha256"), source.getString("sha256"));
            assertEquals("per_file_license_and_source_reviewed", source.getString("permission_status"));
            assertTrue(source.getString("image_page_url").startsWith("https://"));
            assertTrue(source.getString("license_url").startsWith("https://"));
            assertFalse(source.getString("author").isEmpty());
            byte[] jpeg = bytes(context, path, expectedBytes);
            assertEquals(expectedBytes, jpeg.length);
            assertEquals(asset.getString("sha256"), sha256(jpeg));
            assertEquals(255, jpeg[0] & 255); assertEquals(216, jpeg[1] & 255);
            Bitmap photo = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.length);
            assertNotNull("Native JPEG decoder rejected " + path, photo);
            try {
                assertEquals(source.getInt("width"), photo.getWidth());
                assertEquals(source.getInt("height"), photo.getHeight());
                assertTrue(Math.min(photo.getWidth(), photo.getHeight()) >= 224);
                assertTrue(Math.max(photo.getWidth(), photo.getHeight()) <= 512);
                decoded.put(new JSONObject().put("path", path).put("sha256", asset.getString("sha256"))
                    .put("bytes", jpeg.length).put("width", photo.getWidth()).put("height", photo.getHeight())
                    .put("sourceId", source.getString("id")).put("actualNativeDecode", true));
            } finally { photo.recycle(); }
        }
        assertNull("Network returned during offline image decoding", network.getActiveNetwork());
        long pageSize = Os.sysconf(OsConstants._SC_PAGESIZE);
        String expectedPageSize = InstrumentationRegistry.getArguments().getString("expectedPageSize");
        if (expectedPageSize != null) assertEquals(Long.parseLong(expectedPageSize), pageSize);
        JSONObject report = new JSONObject().put("phase", "passed").put("sdk", Build.VERSION.SDK_INT)
            .put("pageSize", pageSize).put("deviceAbi", Build.SUPPORTED_ABIS[0])
            .put("packageName", context.getPackageName()).put("versionName", BuildConfig.VERSION_NAME).put("versionCode", BuildConfig.VERSION_CODE)
            .put("photoManifestSha256", sha256(manifestBytes)).put("sourceRecords", records.length())
            .put("photosDecoded", decoded.length()).put("photos", decoded)
            .put("activeNetworkBefore", JSONObject.NULL).put("activeNetworkAfter", JSONObject.NULL)
            .put("scope", "Packaged bytes, source metadata identity and native JPEG decoding only; no mineral-label, training or accuracy claim");
        File directory = new File(context.getExternalFilesDir(null), "runtime-smoke");
        assertTrue(directory.isDirectory() || directory.mkdirs());
        try (FileOutputStream output = new FileOutputStream(new File(directory, "reviewed-photo-runtime.json"))) {
            output.write(report.toString(2).getBytes(StandardCharsets.UTF_8));
        }
    }
}
