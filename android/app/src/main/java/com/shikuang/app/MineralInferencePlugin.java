package com.shikuang.app;

import android.util.Base64;
import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OnnxValue;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtException;
import ai.onnxruntime.OrtSession;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONArray;
import org.json.JSONObject;

/** Native CPU inference reads only the models bundled with the APK. No WebView worker or network. */
@CapacitorPlugin(name = "MineralInference")
public final class MineralInferencePlugin extends Plugin {
    private static final int ELEMENTS = 3 * 224 * 224;
    private static final int INPUT_BYTES = ELEMENTS * 4;
    private static final int MAX_MODEL_BYTES = 80_000_000;
    private static final String CANCELLED = "分析已停止";
    private static final Map<String, String> ALLOWED_MODELS;
    static {
        Map<String, String> models = new HashMap<>();
        models.put("mobilenet", "mobilenet_int8.onnx");
        models.put("efficientnet", "efficientnet.onnx");
        models.put("efficientnet-legacy", "efficientnet_legacy.onnx");
        ALLOWED_MODELS = Collections.unmodifiableMap(models);
    }

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Map<String, Job> jobs = new HashMap<>();
    // A bounded tombstone prevents cancel-before-start from launching a delayed bridge request.
    private final LinkedHashMap<String, Long> cancelledBeforeStart = new LinkedHashMap<>();
    private final Map<String, OrtSession> sessions = new HashMap<>();
    private final AtomicBoolean destroyed = new AtomicBoolean(false);
    private OrtEnvironment environment;
    private JSONObject manifest;

    private static final class Job {
        final String id;
        final AtomicBoolean cancelled = new AtomicBoolean(false);
        OrtSession.RunOptions runOptions;
        Job(String id) { this.id = id; }
        synchronized void cancel() {
            cancelled.set(true);
            if (runOptions != null) {
                try { runOptions.setTerminate(true); } catch (OrtException ignored) { }
            }
        }
    }

    @PluginMethod
    public void classify(PluginCall call) {
        String jobId = call.getString("jobId", "");
        if (!jobId.matches("[A-Za-z0-9_-]{1,80}")) {
            call.reject("识别任务编号无效", "INVALID_INPUT");
            return;
        }
        final Job job = new Job(jobId);
        synchronized (jobs) {
            pruneTombstones();
            if (destroyed.get()) { call.reject("本机识别引擎已关闭", "ENGINE_CLOSED"); return; }
            if (cancelledBeforeStart.remove(jobId) != null) { call.reject(CANCELLED, "ABORT_ERR"); return; }
            if (jobs.containsKey(jobId)) { call.reject("识别任务编号已存在", "INVALID_INPUT"); return; }
            if (jobs.size() >= 3) { call.reject("请等待当前分析停止后再试", "ENGINE_BUSY"); return; }
            jobs.put(jobId, job);
        }
        try {
            executor.execute(() -> {
                try {
                    checkCancelled(job);
                    JSObject result = analyze(job, call);
                    checkCancelled(job);
                    call.resolve(result);
                } catch (Exception e) {
                    if (job.cancelled.get() || destroyed.get()) call.reject(CANCELLED, "ABORT_ERR");
                    else call.reject(e.getMessage() == null ? "Android 本机识别失败" : e.getMessage(), "INFERENCE_ERROR");
                } catch (LinkageError e) {
                    releaseSessions();
                    call.reject("设备无法加载 Android 本机识别引擎，请安装匹配设备架构的新版 App", "NATIVE_RUNTIME_ERROR");
                } catch (OutOfMemoryError e) {
                    // Drop all resident model weights before suggesting a smaller, single-model retry.
                    releaseSessions();
                    call.reject("设备内存不足，请关闭其他应用后使用快速模式", "INSUFFICIENT_MEMORY");
                } finally {
                    synchronized (jobs) { jobs.remove(job.id); }
                }
            });
        } catch (RejectedExecutionException e) {
            synchronized (jobs) { jobs.remove(job.id); }
            call.reject("本机识别引擎已关闭", "ENGINE_CLOSED");
        }
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String jobId = call.getString("jobId", "");
        if (!jobId.matches("[A-Za-z0-9_-]{1,80}")) { call.reject("识别任务编号无效", "INVALID_INPUT"); return; }
        synchronized (jobs) {
            Job job = jobs.get(jobId);
            if (job != null) job.cancel();
            else {
                pruneTombstones();
                cancelledBeforeStart.put(jobId, System.currentTimeMillis());
                while (cancelledBeforeStart.size() > 64) cancelledBeforeStart.remove(cancelledBeforeStart.keySet().iterator().next());
            }
        }
        JSObject result = new JSObject(); result.put("cancelled", true); call.resolve(result);
    }

    private void pruneTombstones() {
        long cutoff = System.currentTimeMillis() - 300_000;
        Iterator<Map.Entry<String, Long>> entries = cancelledBeforeStart.entrySet().iterator();
        while (entries.hasNext()) if (entries.next().getValue() < cutoff) entries.remove();
    }

    private void checkCancelled(Job job) throws InterruptedException {
        if (job.cancelled.get() || destroyed.get() || Thread.currentThread().isInterrupted()) throw new InterruptedException(CANCELLED);
    }

    private void progress(Job job, String stage, String message) throws InterruptedException {
        checkCancelled(job);
        JSObject event = new JSObject();
        event.put("jobId", job.id); event.put("stage", stage); event.put("message", message);
        notifyListeners("mineralProgress", event);
    }

    private JSObject analyze(Job job, PluginCall call) throws Exception {
        ensureManifest(job);
        JSONArray labels = call.getArray("labels");
        JSONArray expectedLabels = manifest.getJSONArray("labels");
        if (labels == null || labels.length() != 98 || !labels.toString().equals(expectedLabels.toString())) {
            throw new IllegalArgumentException("模型标签类序不匹配，请更新 App");
        }
        JSONArray encodedInputs = call.getArray("inputs");
        if (encodedInputs == null || encodedInputs.length() < 1 || encodedInputs.length() > 3) {
            throw new IllegalArgumentException("请添加 1–3 张同一标本的照片或视频帧");
        }
        JSONArray requestedModels = call.getArray("models");
        if (requestedModels == null || requestedModels.length() < 1 || requestedModels.length() > 3) {
            throw new IllegalArgumentException("请选择快速模式或多模型交叉分析");
        }
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < requestedModels.length(); i++) {
            JSONObject model = requestedModels.getJSONObject(i);
            String id = model.getString("id");
            if (!model.getString("file").equals(ALLOWED_MODELS.get(id)) || !seen.add(id)) {
                throw new IllegalArgumentException("模型请求不在安装包允许清单中");
            }
        }
        List<FloatBuffer> inputs = new ArrayList<>();
        for (int i = 0; i < encodedInputs.length(); i++) {
            checkCancelled(job);
            String encoded = encodedInputs.getString(i);
            if (encoded.length() != ((INPUT_BYTES + 2) / 3) * 4) throw new IllegalArgumentException("图像张量大小不正确");
            byte[] bytes = Base64.decode(encoded, Base64.NO_WRAP);
            if (bytes.length != INPUT_BYTES) throw new IllegalArgumentException("图像张量大小不正确");
            FloatBuffer decoded = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer();
            FloatBuffer nativeInput = ByteBuffer.allocateDirect(INPUT_BYTES).order(ByteOrder.nativeOrder()).asFloatBuffer();
            while (decoded.hasRemaining()) {
                float value = decoded.get();
                if (Float.isNaN(value) || Float.isInfinite(value)) throw new IllegalArgumentException("图像张量包含无效数值");
                nativeInput.put(value);
            }
            nativeInput.flip(); inputs.add(nativeInput);
        }
        JSArray runs = new JSArray(), screening = new JSArray(), warnings = new JSArray();
        OrtSession gate = modelSession(job, "imagenet_gate.onnx", "输入筛查", 1000);
        JSONArray blocked = call.getArray("blocked");
        for (int i = 0; i < inputs.size(); i++) {
            progress(job, "screen-run", "筛查输入图像 " + (i + 1) + "/" + inputs.size() + " · Android 本机引擎…");
            float[] values = run(job, gate, inputs.get(i), 1000);
            JSObject item = new JSObject(); item.put("photo", i); item.put("values", array(values)); screening.put(item);
            if (isNonMineral(values, blocked)) {
                JSObject result = result(runs, screening, warnings); result.put("rejected", true); return result;
            }
        }
        if (requestedModels.length() == 1) warnings.put("快速模式仅提供初步候选，建议使用交叉分析与实测物性复核");
        for (int m = 0; m < requestedModels.length(); m++) {
            JSONObject model = requestedModels.getJSONObject(m);
            String id = model.getString("id"), file = model.getString("file"), title = model.optString("title", id);
            // Display text is bounded; file access always uses the hardcoded id/path map above.
            title = title.substring(0, Math.min(title.length(), 40));
            OrtSession session;
            try { session = modelSession(job, file, title, 98); }
            catch (InterruptedException e) { throw e; }
            catch (Exception e) {
                checkCancelled(job);
                if (runs.length() == 0) throw e;
                warnings.put(title + " 不可用，已使用其他模型"); continue;
            }
            for (int i = 0; i < inputs.size(); i++) {
                progress(job, "mineral-run", "分析图像 " + (i + 1) + "/" + inputs.size() + " · " + title + " · Android 本机引擎…");
                float[] values = run(job, session, inputs.get(i), 98);
                JSObject item = new JSObject(); item.put("photo", i); item.put("model", id); item.put("values", array(values)); runs.put(item);
            }
        }
        return result(runs, screening, warnings);
    }

    private JSObject result(JSArray runs, JSArray screening, JSArray warnings) {
        JSObject result = new JSObject(); result.put("runs", runs); result.put("screening", screening); result.put("warnings", warnings); return result;
    }

    private void ensureManifest(Job job) throws Exception {
        if (manifest == null) {
            try (InputStream stream = getContext().getAssets().open("public/model-manifest.json")) {
                byte[] data = readBytes(job, stream, 100_000, null);
                JSONObject loaded = new JSONObject(new String(data, StandardCharsets.UTF_8));
                JSONArray inputShape = loaded.getJSONObject("input").getJSONArray("shape");
                if (!inputShape.toString().equals("[1,3,224,224]")) throw new IllegalArgumentException("模型输入清单不匹配");
                manifest = loaded;
            }
        }
        if (environment == null) {
            environment = OrtEnvironment.getEnvironment();
            environment.setTelemetry(false);
        }
    }

    private OrtSession modelSession(Job job, String file, String title, int classes) throws Exception {
        checkCancelled(job);
        if (sessions.containsKey(file)) return sessions.get(file);
        JSONObject expected = null;
        JSONArray models = manifest.getJSONArray("models");
        for (int i = 0; i < models.length(); i++) {
            JSONObject model = models.getJSONObject(i);
            if (("models/" + file).equals(model.optString("path"))) { expected = model; break; }
        }
        if (expected == null || expected.getInt("classes") != classes || !expected.getString("sha256").matches("[a-f0-9]{64}")) {
            throw new IllegalArgumentException("模型清单不完整，请重新安装或更新 App");
        }
        progress(job, "model-read", "读取 " + title + " · Android 本机模型…");
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] data;
        try (InputStream stream = getContext().getAssets().open("public/models/" + file)) {
            data = readBytes(job, stream, MAX_MODEL_BYTES, digest);
        }
        StringBuilder actualHash = new StringBuilder();
        for (byte b : digest.digest()) actualHash.append(String.format(java.util.Locale.ROOT, "%02x", b & 0xff));
        if (!actualHash.toString().equals(expected.getString("sha256"))) throw new IllegalArgumentException("模型文件校验失败，请重新安装新版 App");
        progress(job, "model-init", title + " 已校验，正在初始化本机引擎…");
        OrtSession loaded;
        try (OrtSession.SessionOptions options = new OrtSession.SessionOptions()) {
            options.setIntraOpNumThreads(1); options.setInterOpNumThreads(1);
            options.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT);
            loaded = environment.createSession(data, options);
        }
        try {
            checkCancelled(job);
            if (loaded.getInputNames().size() != 1 || loaded.getOutputNames().size() != 1) throw new IllegalArgumentException("模型输入输出与安装包清单不匹配");
            sessions.put(file, loaded); return loaded;
        } catch (Exception e) { loaded.close(); throw e; }
    }

    private byte[] readBytes(Job job, InputStream stream, int maximum, MessageDigest digest) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream(); byte[] buffer = new byte[65536]; int count;
        while ((count = stream.read(buffer)) != -1) {
            checkCancelled(job);
            if (output.size() + count > maximum) throw new IllegalArgumentException("识别资源大小异常，请重新安装 App");
            output.write(buffer, 0, count); if (digest != null) digest.update(buffer, 0, count);
        }
        return output.toByteArray();
    }

    private float[] run(Job job, OrtSession session, FloatBuffer input, int count) throws Exception {
        checkCancelled(job);
        OrtSession.RunOptions options = new OrtSession.RunOptions();
        try {
            synchronized (job) { job.runOptions = options; if (job.cancelled.get()) options.setTerminate(true); }
            try (OnnxTensor tensor = OnnxTensor.createTensor(environment, input.duplicate(), new long[] {1, 3, 224, 224});
                 OrtSession.Result output = session.run(Collections.singletonMap(session.getInputNames().iterator().next(), tensor), options)) {
                checkCancelled(job);
                OnnxValue value = output.get(0);
                if (!(value instanceof OnnxTensor)) throw new IllegalArgumentException("模型输出类型不正确");
                FloatBuffer values = ((OnnxTensor) value).getFloatBuffer();
                if (values == null || values.remaining() != count) throw new IllegalArgumentException("模型输出与标签清单不匹配");
                float[] scores = new float[count]; values.get(scores);
                for (float score : scores) if (Float.isNaN(score) || Float.isInfinite(score)) throw new IllegalArgumentException("模型输出包含无效数值");
                return scores;
            }
        } finally {
            synchronized (job) { job.runOptions = null; options.close(); }
        }
    }

    private JSArray array(float[] values) throws org.json.JSONException {
        JSArray array = new JSArray(); for (float value : values) array.put((double) value); return array;
    }

    private boolean isNonMineral(float[] values, JSONArray blocked) {
        int top = 0; for (int i = 1; i < values.length; i++) if (values[i] > values[top]) top = i;
        double sum = 0; for (float value : values) sum += Math.exp(value - values[top]);
        boolean living = top <= 397 || top == 981 || top == 982 || top == 983;
        return (living || (blocked != null && blocked.optBoolean(top, false))) && 1.0 / sum >= 0.65;
    }

    /** Called only on the serialized inference executor, after the active run has unwound. */
    private void releaseSessions() {
        try {
            for (OrtSession session : sessions.values()) {
                try { session.close(); } catch (OrtException | RuntimeException | LinkageError ignored) { }
            }
        } finally { sessions.clear(); }
    }

    @Override
    protected void handleOnDestroy() {
        destroyed.set(true);
        synchronized (jobs) { for (Job job : jobs.values()) job.cancel(); cancelledBeforeStart.clear(); }
        try {
            executor.execute(() -> {
                releaseSessions();
                if (environment != null) { environment.close(); environment = null; }
            });
        } finally { executor.shutdown(); }
        super.handleOnDestroy();
    }
}
