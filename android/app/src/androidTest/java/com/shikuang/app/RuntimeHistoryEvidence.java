package com.shikuang.app;

import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.json.JSONArray;
import org.json.JSONObject;

/** Hash actual persisted bytes; this helper does not write or seed App data. */
final class RuntimeHistoryEvidence {
    private RuntimeHistoryEvidence() {}

    static String sha256(byte[] bytes) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
        StringBuilder result = new StringBuilder();
        final char[] hex = "0123456789abcdef".toCharArray();
        for (byte value : digest) { result.append(hex[(value & 255) >>> 4]); result.append(hex[value & 15]); }
        return result.toString();
    }

    static String textSha256(String text) throws Exception { return sha256(text.getBytes(StandardCharsets.UTF_8)); }

    static JSONObject identity(String recordJson, String searchJson) throws Exception {
        if (recordJson.length() > 2 * 1024 * 1024 || searchJson.length() > 128 * 1024) throw new IllegalArgumentException("History evidence exceeds bounds");
        JSONObject row = new JSONObject(recordJson);
        JSONArray photos = row.getJSONArray("photos"), searches = new JSONArray(searchJson);
        if (photos.length() != 1 || row.getInt("photoCount") != 1 || !"quartz".equals(row.getString("key")) || row.getInt("modelCount") != 3) throw new IllegalArgumentException("Expected real three-model one-photo quartz record");
        boolean savedSearch = false;
        for (int i = 0; i < searches.length(); i++) {
            JSONObject query = searches.getJSONObject(i);
            if ("records".equals(query.optString("kind")) && "石英".equals(query.optString("query"))) savedSearch = true;
        }
        if (!savedSearch) throw new IllegalArgumentException("Actual saved record search is missing");
        JSONArray dataUrlHashes = new JSONArray(), photoByteHashes = new JSONArray();
        for (int i = 0; i < photos.length(); i++) {
            String url = photos.getString(i);
            if (!url.matches("data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}")) throw new IllegalArgumentException("Persisted photo must be a bounded actual data URL");
            byte[] bytes = Base64.decode(url.substring(url.indexOf(',') + 1), Base64.DEFAULT);
            if (bytes.length == 0 || bytes.length > 2 * 1024 * 1024) throw new IllegalArgumentException("Invalid persisted photo bytes");
            dataUrlHashes.put(textSha256(url)); photoByteHashes.put(sha256(bytes));
        }
        return new JSONObject().put("recordId",row.getString("id"))
            .put("recordSnapshotSha256",textSha256(recordJson)).put("searchSnapshotSha256",textSha256(searchJson))
            .put("photoDataUrlSha256s",dataUrlHashes).put("photoByteSha256s",photoByteHashes)
            .put("photoCount",photos.length()).put("modelCount",row.getInt("modelCount"))
            .put("modelVersion",row.getString("modelVersion")).put("manifestSha256",row.getString("manifestSha256"));
    }
}
