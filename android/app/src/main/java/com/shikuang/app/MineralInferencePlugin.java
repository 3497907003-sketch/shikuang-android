package com.shikuang.app;

import android.app.ActivityManager;
import android.content.Context;
import android.os.SystemClock;
import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OnnxJavaType;
import ai.onnxruntime.TensorInfo;
import ai.onnxruntime.NodeInfo;
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
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
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
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONArray;
import org.json.JSONObject;

/** Native CPU inference reads only the models bundled with the APK. No WebView worker or network. */
@CapacitorPlugin(name = "MineralInference")
public final class MineralInferencePlugin extends Plugin {
    private static final String CANCELLED = "分析已停止";
    private static final int INFERENCE_TIMEOUT_SECONDS = 120;

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Map<String, Job> jobs = new HashMap<>();
    // A bounded tombstone prevents cancel-before-start from launching a delayed bridge request.
    private final LinkedHashMap<String, Long> cancelledBeforeStart = new LinkedHashMap<>();
    private final Map<String, OrtSession> sessions = new LinkedHashMap<>();
    private final ScheduledExecutorService watchdog = Executors.newSingleThreadScheduledExecutor();
    private final AtomicBoolean destroyed = new AtomicBoolean(false);
    private OrtEnvironment environment;
    private MineralModelContract manifest;
    private String manifestSha256 = "";

    private static final class Job {
        final String id;
        final AtomicBoolean cancelled = new AtomicBoolean(false);
        OrtSession.RunOptions runOptions;
        volatile boolean timedOut;
        ScheduledFuture<?> timeout;
        final long acceptedAt = SystemClock.elapsedRealtime();
        int sessionCacheHits, modelLoads;
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
            job.timeout = watchdog.schedule(() -> { job.timedOut = true; job.cancel(); }, INFERENCE_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        }
        try {
            executor.execute(() -> {
                try {
                    checkCancelled(job);
                    JSObject result = analyze(job, call);
                    checkCancelled(job);
                    call.resolve(result);
                } catch (Exception e) {
                    if (job.timedOut) call.reject("本机分析超过 120 秒，已停止，请重试快速模式", "ENGINE_TIMEOUT");
                    else if (job.cancelled.get() || destroyed.get()) call.reject(CANCELLED, "ABORT_ERR");
                    else { releaseSessions(); call.reject(e.getMessage() == null ? "Android 本机识别失败" : e.getMessage(), "INFERENCE_ERROR"); }
                } catch (LinkageError e) {
                    releaseSessions();
                    call.reject("设备无法加载 Android 本机识别引擎，请安装匹配设备架构的新版 App", "NATIVE_RUNTIME_ERROR");
                } catch (OutOfMemoryError e) {
                    // Drop all resident model weights before suggesting a smaller, single-model retry.
                    releaseSessions();
                    call.reject("设备内存不足，请关闭其他应用后使用快速模式", "INSUFFICIENT_MEMORY");
                } finally {
                    if (job.timeout != null) job.timeout.cancel(false);
                    synchronized (jobs) { jobs.remove(job.id); }
                }
            });
        } catch (RejectedExecutionException e) {
            if (job.timeout != null) job.timeout.cancel(false);
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
                cancelledBeforeStart.put(jobId, SystemClock.elapsedRealtime());
                while (cancelledBeforeStart.size() > 64) cancelledBeforeStart.remove(cancelledBeforeStart.keySet().iterator().next());
            }
        }
        JSObject result = new JSObject(); result.put("cancelled", true); call.resolve(result);
    }

    private void pruneTombstones() {
        long cutoff = SystemClock.elapsedRealtime() - 300_000;
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
        if (!manifestSha256.equals(call.getString("manifestSha256", ""))) throw new IllegalArgumentException("模型清单版本已变化，请更新后重试");
        if (!"float32-le-base64".equals(call.getString("inputEncoding", ""))) throw new IllegalArgumentException("图像张量编码不匹配");
        List<MineralModelContract.Model> requestedModels = manifest.requested(call.getArray("labels"), call.getString("mode"), call.getArray("modelIds"));
        Set<String> wanted = new HashSet<>(); wanted.add(sessionKey(manifest.gate));
        for (MineralModelContract.Model model : requestedModels) wanted.add(sessionKey(model));
        Iterator<Map.Entry<String, OrtSession>> resident = sessions.entrySet().iterator();
        while (resident.hasNext()) { Map.Entry<String, OrtSession> entry = resident.next(); if (!wanted.contains(entry.getKey())) { entry.getValue().close(); resident.remove(); } }
        JSONArray encodedInputs = call.getArray("inputs");
        if (encodedInputs == null || encodedInputs.length() < 1 || encodedInputs.length() > 3) throw new IllegalArgumentException("请添加 1–3 张同一标本的照片或视频帧");
        JSONArray blocked = call.getArray("blocked");
        if (blocked == null || blocked.length() != 1000) throw new IllegalArgumentException("输入筛查清单不完整");
        for (int i = 0; i < blocked.length(); i++) if (!(blocked.get(i) instanceof Boolean)) throw new IllegalArgumentException("输入筛查清单不完整");
        List<FloatBuffer> inputs = new ArrayList<>();
        for (int i = 0; i < encodedInputs.length(); i++) {
            checkCancelled(job);
            inputs.add(MineralModelContract.decodeInput(encodedInputs.getString(i)));
            checkCancelled(job);
        }
        JSArray runs = new JSArray(), screening = new JSArray(), warnings = new JSArray();
        OrtSession gate = modelSession(job, manifest.gate);
        for (int i = 0; i < inputs.size(); i++) {
            progress(job, "screen-run", "筛查输入图像 " + (i + 1) + "/" + inputs.size() + " · Android 本机引擎…");
            float[] values = run(job, gate, inputs.get(i), manifest.gate);
            JSObject item = new JSObject(); item.put("photo", i); item.put("values", array(values)); screening.put(item);
            if (isNonMineral(values, blocked)) {
                JSObject result = result(job, runs, screening, warnings); result.put("rejected", true); return result;
            }
        }
        if (requestedModels.size() == 1) warnings.put("快速模式仅提供初步候选，建议使用交叉分析与实测物性复核");
        for (MineralModelContract.Model model : requestedModels) {
            OrtSession session = modelSession(job, model);
            for (int i = 0; i < inputs.size(); i++) {
                progress(job, "mineral-run", "分析图像 " + (i + 1) + "/" + inputs.size() + " · " + model.title + " · Android 本机引擎…");
                float[] values = run(job, session, inputs.get(i), model);
                JSObject item = new JSObject(); item.put("photo", i); item.put("model", model.id); item.put("values", array(values)); runs.put(item);
            }
        }
        return result(job, runs, screening, warnings);
    }

    private JSObject result(Job job, JSArray runs, JSArray screening, JSArray warnings) {
        JSObject result = new JSObject(); result.put("runs", runs); result.put("screening", screening); result.put("warnings", warnings); result.put("manifestSha256", manifestSha256); result.put("modelVersion", manifest.version);
        JSObject diagnostics = new JSObject();
        diagnostics.put("elapsedMs", SystemClock.elapsedRealtime() - job.acceptedAt);
        diagnostics.put("sessionCacheHits", job.sessionCacheHits); diagnostics.put("modelLoads", job.modelLoads);
        diagnostics.put("residentSessionCount", sessions.size());
        diagnostics.put("javaHeapUsedBytesAtResult", Runtime.getRuntime().totalMemory() - Runtime.getRuntime().freeMemory());
        result.put("diagnostics", diagnostics); return result;
    }

    private void ensureManifest(Job job) throws Exception {
        byte[] bytes;
        try (InputStream stream = getContext().getAssets().open("public/model-manifest.json")) {
            bytes = readBytes(job, stream, 100_000, null);
        }
        String actualHash = hex(MessageDigest.getInstance("SHA-256").digest(bytes));
        if (!actualHash.equals(manifestSha256)) {
            releaseSessions(); manifest = null; manifestSha256 = "";
            MineralModelContract loaded = new MineralModelContract(new JSONObject(new String(bytes, StandardCharsets.UTF_8)));
            manifest = loaded; manifestSha256 = actualHash;
            pruneModelFiles();
        }
        if (environment == null) { environment = OrtEnvironment.getEnvironment(); environment.setTelemetry(false); }
    }

    private String sessionKey(MineralModelContract.Model model) { return manifestSha256 + ":" + model.path + ":" + model.sha256; }

    private OrtSession modelSession(Job job, MineralModelContract.Model model) throws Exception {
        checkCancelled(job);
        String key = sessionKey(model);
        if (sessions.containsKey(key)) { job.sessionCacheHits++; return sessions.get(key); }
        // On low-memory devices retain the gate plus one classifier, evicting before allocating another.
        ActivityManager manager = (ActivityManager) getContext().getSystemService(Context.ACTIVITY_SERVICE);
        if (manager != null && manager.isLowRamDevice() && model.role.equals("mineral-classifier")) {
            String gateKey = sessionKey(manifest.gate);
            Iterator<Map.Entry<String, OrtSession>> old = sessions.entrySet().iterator();
            while (old.hasNext()) { Map.Entry<String, OrtSession> entry = old.next(); if (!entry.getKey().equals(gateKey)) { entry.getValue().close(); old.remove(); } }
        }
        progress(job, "model-read", "读取 " + model.title + " · Android 本机模型…");
        File verifiedFile = verifiedModelFile(job, model);
        progress(job, "model-init", model.title + " 已校验，正在初始化本机引擎…");
        OrtSession loaded;
        try (OrtSession.SessionOptions options = new OrtSession.SessionOptions()) {
            options.setIntraOpNumThreads(1); options.setInterOpNumThreads(1);
            options.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT);
            loaded = environment.createSession(verifiedFile.getAbsolutePath(), options);
        }
        try {
            checkCancelled(job);
            Map<String, NodeInfo> inputs = loaded.getInputInfo(), outputs = loaded.getOutputInfo();
            if (inputs.size() != 1 || outputs.size() != 1 || !inputs.containsKey(model.inputName) || !outputs.containsKey(model.outputName)) throw new IllegalArgumentException("模型输入输出名称与清单不匹配");
            if (!(inputs.get(model.inputName).getInfo() instanceof TensorInfo) || !(outputs.get(model.outputName).getInfo() instanceof TensorInfo)) throw new IllegalArgumentException("模型输入输出必须是张量");
            TensorInfo input = (TensorInfo) inputs.get(model.inputName).getInfo(), output = (TensorInfo) outputs.get(model.outputName).getInfo();
            if (input.type != OnnxJavaType.FLOAT || output.type != OnnxJavaType.FLOAT) throw new IllegalArgumentException("模型输入输出类型与清单不匹配");
            MineralModelContract.validateShape(input.getShape(), new long[] {1,3,224,224});
            MineralModelContract.validateShape(output.getShape(), new long[] {1,model.classes});
            sessions.put(key, loaded); job.modelLoads++; return loaded;
        } catch (Exception e) { loaded.close(); throw e; }
    }

    private File modelDirectory() {
        File directory = new File(getContext().getCacheDir(), "mineral-models");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IllegalStateException("无法准备本机模型存储空间");
        return directory;
    }

    private void pruneModelFiles() {
        Set<String> keep = new HashSet<>(); for (MineralModelContract.Model model : manifest.models.values()) keep.add(model.sha256 + ".onnx");
        File[] files = modelDirectory().listFiles();
        if (files != null) for (File file : files) if (!keep.contains(file.getName())) file.delete();
    }

    /** A 64 KiB streaming buffer replaces model-sized byte arrays and JNI byte[] copies. */
    private File verifiedModelFile(Job job, MineralModelContract.Model model) throws Exception {
        File file = new File(modelDirectory(), model.sha256 + ".onnx");
        if (file.isFile()) {
            if (file.length() == model.bytes) {
                try (InputStream stream = new FileInputStream(file)) { if (model.sha256.equals(hashStream(job, stream, model.bytes, null))) return file; }
            }
            if (!file.delete()) throw new IllegalStateException("损坏的模型缓存无法清理，请清理 App 缓存后重试");
        }
        File temporary = File.createTempFile("model-", ".tmp", modelDirectory());
        try {
            String digest;
            try (InputStream stream = getContext().getAssets().open("public/" + model.path); FileOutputStream output = new FileOutputStream(temporary)) {
                digest = hashStream(job, stream, model.bytes, output); output.getFD().sync();
            }
            checkCancelled(job);
            if (!model.sha256.equals(digest)) throw new IllegalArgumentException("模型文件校验失败，请重新安装新版 App");
            if (!temporary.renameTo(file)) throw new IllegalStateException("无法保存已校验的模型，请检查可用空间");
            return file;
        } finally { if (temporary.exists()) temporary.delete(); }
    }

    private String hashStream(Job job, InputStream stream, int expected, FileOutputStream output) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256"); byte[] buffer = new byte[65536]; int size = 0, count;
        while ((count = stream.read(buffer)) != -1) {
            checkCancelled(job); if (count > expected - size) throw new IllegalArgumentException("模型文件大小与清单不匹配");
            size += count; digest.update(buffer, 0, count); if (output != null) output.write(buffer, 0, count);
        }
        if (size != expected) throw new IllegalArgumentException("模型文件大小与清单不匹配");
        return hex(digest.digest());
    }

    private String hex(byte[] bytes) {
        StringBuilder text = new StringBuilder(); for (byte b : bytes) text.append(String.format(java.util.Locale.ROOT, "%02x", b & 0xff)); return text.toString();
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

    private float[] run(Job job, OrtSession session, FloatBuffer input, MineralModelContract.Model model) throws Exception {
        checkCancelled(job);
        OrtSession.RunOptions options = new OrtSession.RunOptions();
        try {
            synchronized (job) { job.runOptions = options; if (job.cancelled.get()) options.setTerminate(true); }
            try (OnnxTensor tensor = OnnxTensor.createTensor(environment, input.duplicate(), new long[] {1, 3, 224, 224});
                 OrtSession.Result output = session.run(Collections.singletonMap(model.inputName, tensor), options)) {
                checkCancelled(job);
                OnnxValue value = output.get(0);
                if (!(value instanceof OnnxTensor)) throw new IllegalArgumentException("模型输出类型不正确");
                TensorInfo info = ((OnnxTensor) value).getInfo();
                if (info.type != OnnxJavaType.FLOAT) throw new IllegalArgumentException("模型输出类型不正确");
                MineralModelContract.validateShape(info.getShape(), new long[] {1,model.classes});
                FloatBuffer values = ((OnnxTensor) value).getFloatBuffer();
                if (values == null || values.remaining() != model.classes) throw new IllegalArgumentException("模型输出与标签清单不匹配");
                float[] scores = new float[model.classes]; values.get(scores);
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
        } finally { executor.shutdown(); watchdog.shutdownNow(); }
        super.handleOnDestroy();
    }
}
