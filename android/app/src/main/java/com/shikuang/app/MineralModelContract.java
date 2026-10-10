package com.shikuang.app;

import android.util.Base64;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Validates the same bounded manifest used by MineralCore. No weight hash is embedded in Java. */
final class MineralModelContract {
    static final int INPUT_ELEMENTS = 3 * 224 * 224;
    static final int INPUT_BYTES = INPUT_ELEMENTS * 4;
    static final int MAX_MODEL_BYTES = 80_000_000;
    private static final Set<String> PATHS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
        "models/mobilenet_int8.onnx", "models/efficientnet.onnx", "models/efficientnet_legacy.onnx", "models/imagenet_gate.onnx")));

    static final class Model {
        final String id, role, path, title, sha256, inputName, outputName;
        final int bytes, classes;
        final double temperature;
        Model(JSONObject row, int labels) throws JSONException {
            id = string(row, "id"); role = string(row, "role"); path = string(row, "path");
            sha256 = string(row, "sha256"); inputName = string(row, "inputName"); outputName = string(row, "outputName");
            bytes = integer(row, "bytes"); classes = integer(row, "classes");
            String text = row.opt("title") instanceof String ? row.getString("title") : id;
            title = text.substring(0, Math.min(40, text.length()));
            temperature = row.has("temperature") ? number(row, "temperature") : 1;
            require(id.matches("[a-z][a-z0-9-]{0,39}") && PATHS.contains(path));
            require(role.equals("input-gate") || role.equals("mineral-classifier"));
            require(path.equals("models/imagenet_gate.onnx") == role.equals("input-gate"));
            require(classes == (role.equals("input-gate") ? 1000 : labels));
            require(bytes > 0 && bytes <= MAX_MODEL_BYTES && sha256.matches("[a-f0-9]{64}"));
            require(string(row, "output").equals("logits"));
            require(inputName.matches("[A-Za-z0-9_.:/-]{1,120}") && outputName.matches("[A-Za-z0-9_.:/-]{1,120}"));
            require(temperature >= 0.05 && temperature <= 10 && (!role.equals("input-gate") || temperature == 1));
        }
    }

    final String version;
    final List<String> labels;
    final Map<String, Model> models;
    final List<String> fast, ensemble;
    final Model gate;

    MineralModelContract(JSONObject manifest) throws JSONException {
        require(integer(manifest, "schemaVersion") == 1);
        version = string(manifest, "version"); require(version.matches("[A-Za-z0-9._-]{1,80}"));
        JSONObject input = manifest.getJSONObject("input");
        require(string(input, "dtype").equals("float32") && string(input, "layout").equals("NCHW"));
        require(string(input, "colorSpace").equals("RGB") && number(input, "pixelScale") == 255);
        require(string(input, "resize").equals("bilinear") && string(input, "crop").equals("user-selected center square"));
        vector(input.getJSONArray("shape"), new double[] {1,3,224,224});
        JSONObject normalization = input.getJSONObject("normalization");
        vector(normalization.getJSONArray("mean"), new double[] {.485,.456,.406});
        vector(normalization.getJSONArray("std"), new double[] {.229,.224,.225});
        labels = strings(manifest.getJSONArray("labels"));
        require(labels.size() >= 2 && labels.size() <= 256 && new HashSet<>(labels).size() == labels.size());
        for (String label : labels) require(label.matches("[a-z][a-z0-9_]{0,60}"));
        JSONArray rows = manifest.getJSONArray("models"); require(rows.length() >= 3 && rows.length() <= 4);
        Map<String, Model> parsed = new LinkedHashMap<>(); Set<String> paths = new HashSet<>(); Model parsedGate = null;
        List<String> classifiers = new ArrayList<>();
        for (int i = 0; i < rows.length(); i++) {
            Model model = new Model(rows.getJSONObject(i), labels.size());
            require(!parsed.containsKey(model.id) && paths.add(model.path)); parsed.put(model.id, model);
            if (model.role.equals("input-gate")) { require(parsedGate == null); parsedGate = model; }
            else classifiers.add(model.id);
        }
        require(parsedGate != null); gate = parsedGate; models = Collections.unmodifiableMap(parsed);
        JSONObject modes = manifest.getJSONObject("modes");
        fast = strings(modes.getJSONArray("fast")); ensemble = strings(modes.getJSONArray("ensemble"));
        require(fast.size() == 1 && ensemble.size() >= 2 && ensemble.size() <= 3);
        require(ensemble.size() == classifiers.size() && new HashSet<>(ensemble).size() == ensemble.size());
        require(ensemble.contains(fast.get(0)) && new HashSet<>(ensemble).equals(new HashSet<>(classifiers)));
    }

    List<Model> requested(JSONArray suppliedLabels, String mode, JSONArray ids) throws JSONException {
        require(suppliedLabels != null && labels.equals(strings(suppliedLabels)));
        require(mode != null && (mode.equals("fast") || mode.equals("ensemble")));
        List<String> expected = mode.equals("fast") ? fast : ensemble;
        require(ids != null && expected.equals(strings(ids)));
        List<Model> selected = new ArrayList<>(); for (String id : expected) selected.add(models.get(id));
        return selected;
    }

    static void validateShape(long[] actual, long[] expected) {
        require(actual.length == expected.length);
        for (int i = 0; i < expected.length; i++) require(actual[i] == expected[i] || (i == 0 && actual[i] == -1));
    }

    static FloatBuffer decodeInput(String encoded) {
        require(encoded != null && encoded.length() == ((INPUT_BYTES + 2) / 3) * 4);
        byte[] bytes = Base64.decode(encoded, Base64.NO_WRAP); require(bytes.length == INPUT_BYTES);
        FloatBuffer source = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer();
        FloatBuffer result = ByteBuffer.allocateDirect(INPUT_BYTES).order(ByteOrder.nativeOrder()).asFloatBuffer();
        while (source.hasRemaining()) {
            float value = source.get(); require(!Float.isNaN(value) && !Float.isInfinite(value)); result.put(value);
        }
        result.flip(); return result;
    }

    static List<String> strings(JSONArray array) throws JSONException {
        List<String> values = new ArrayList<>();
        for (int i = 0; i < array.length(); i++) { require(array.get(i) instanceof String); values.add(array.getString(i)); }
        return Collections.unmodifiableList(values);
    }
    private static String string(JSONObject value, String key) throws JSONException {
        require(value.get(key) instanceof String); return value.getString(key);
    }
    private static double number(JSONObject value, String key) throws JSONException {
        require(value.get(key) instanceof Number); double number = value.getDouble(key);
        require(!Double.isNaN(number) && !Double.isInfinite(number)); return number;
    }
    private static int integer(JSONObject value, String key) throws JSONException {
        double number = number(value, key); require(number == Math.rint(number) && number >= Integer.MIN_VALUE && number <= Integer.MAX_VALUE);
        return (int) number;
    }
    private static void vector(JSONArray array, double[] expected) throws JSONException {
        require(array.length() == expected.length);
        for (int i = 0; i < expected.length; i++) require(array.get(i) instanceof Number && array.getDouble(i) == expected[i]);
    }
    private static void require(boolean valid) {
        if (!valid) throw new IllegalArgumentException("模型清单或输入契约不匹配，请更新 App 或离线资源");
    }
}
