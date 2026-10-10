package com.shikuang.app;

import static org.junit.Assert.*;
import android.util.Base64;
import android.content.Context;
import android.os.Build;
import android.system.Os;
import android.system.OsConstants;
import ai.onnxruntime.OnnxJavaType;
import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OnnxValue;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtSession;
import ai.onnxruntime.TensorInfo;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Collections;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public final class MineralModelContractTest {
    private JSONObject bundled() throws Exception {
        try (InputStream stream = InstrumentationRegistry.getInstrumentation().getTargetContext().getAssets().open("public/model-manifest.json")) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream(); byte[] buffer = new byte[4096]; int count;
            while ((count = stream.read(buffer)) != -1) { bytes.write(buffer,0,count); assertTrue(bytes.size() <= 100000); }
            return new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8));
        }
    }
    private void rejects(JSONObject value) throws Exception {
        try { new MineralModelContract(value); fail("Invalid model contract was accepted"); }
        catch (IllegalArgumentException | org.json.JSONException expected) { }
    }
    @Test public void realBundledManifestSelectsExactFastAndEnsembleModels() throws Exception {
        JSONObject json = bundled(); MineralModelContract contract = new MineralModelContract(json);
        assertTrue(contract.ensemble.size() >= 2 && contract.ensemble.size() <= 3);
        assertEquals(1, contract.fast.size()); assertEquals(1000, contract.gate.classes);
        assertEquals(contract.ensemble.size(), contract.requested(json.getJSONArray("labels"), "ensemble",json.getJSONObject("modes").getJSONArray("ensemble")).size());
        assertEquals(1, contract.requested(json.getJSONArray("labels"), "fast",json.getJSONObject("modes").getJSONArray("fast")).size());
        try { contract.requested(json.getJSONArray("labels"),"ensemble",json.getJSONObject("modes").getJSONArray("fast")); fail("Partial ensemble was accepted"); }
        catch (IllegalArgumentException expected) { }
    }
    @Test public void unsafeModelsAndChangedInputContractsAreRejected() throws Exception {
        JSONObject value = bundled(); value.getJSONObject("input").put("layout","NHWC"); rejects(value);
        value = bundled(); value.getJSONObject("input").getJSONObject("normalization").put("mean",new JSONArray("[0,0,0]")); rejects(value);
        value = bundled(); value.getJSONArray("models").getJSONObject(0).put("path","models/../secret.onnx"); rejects(value);
        value = bundled(); value.getJSONArray("models").getJSONObject(0).put("bytes",80_000_001); rejects(value);
        value = bundled(); value.getJSONArray("models").getJSONObject(0).put("classes",9999); rejects(value);
        value = bundled(); value.put("schemaVersion",2); rejects(value);
        value = bundled(); value.getJSONObject("modes").put("ensemble",value.getJSONObject("modes").getJSONArray("fast")); rejects(value);
    }
    @Test public void littleEndianFloat32TensorRoundTripsWithoutRenormalization() {
        ByteBuffer source = ByteBuffer.allocate(MineralModelContract.INPUT_BYTES).order(ByteOrder.LITTLE_ENDIAN);
        float red=(float)((0.0 / 255 - .485) / .229),green=(float)((127.0 / 255 - .456) / .224),blue=(float)((255.0 / 255 - .406) / .225);
        source.putFloat(0,red); source.putFloat(224*224*4,green); source.putFloat(2*224*224*4,blue);
        FloatBuffer decoded = MineralModelContract.decodeInput(Base64.encodeToString(source.array(),Base64.NO_WRAP));
        assertTrue(decoded.isDirect());assertEquals(MineralModelContract.INPUT_ELEMENTS,decoded.remaining());
        assertEquals(Float.floatToIntBits(red),Float.floatToIntBits(decoded.get(0)));
        assertEquals(Float.floatToIntBits(green),Float.floatToIntBits(decoded.get(224*224)));
        assertEquals(Float.floatToIntBits(blue),Float.floatToIntBits(decoded.get(2*224*224)));
        source.putFloat(0,Float.NaN);
        try { MineralModelContract.decodeInput(Base64.encodeToString(source.array(),Base64.NO_WRAP)); fail("NaN tensor was accepted"); }
        catch (IllegalArgumentException expected) { }
    }
    @Test public void tensorShapeCannotChangeSpatialSizeClassCountOrChannelOrder() {
        MineralModelContract.validateShape(new long[] {-1,3,224,224},new long[] {1,3,224,224});
        for (long[] shape : new long[][] {{1,224,224,3},{1,3,112,112},{1,3,-1,224},{2,3,224,224}}) {
            try { MineralModelContract.validateShape(shape,new long[] {1,3,224,224}); fail("Wrong shape accepted"); }
            catch (IllegalArgumentException expected) { }
        }
    }

    @Test public void everyPackagedGraphExecutesInActualNativeRuntime() throws Exception {
        Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();
        JSONObject json=bundled();MineralModelContract contract=new MineralModelContract(json);
        OrtEnvironment environment=OrtEnvironment.getEnvironment();environment.setTelemetry(false);
        assertEquals("1.24.3",environment.getVersion());
        JSONObject report=new JSONObject().put("sdk",Build.VERSION.SDK_INT).put("pageSize",Os.sysconf(OsConstants._SC_PAGESIZE))
            .put("runtimeVersion",environment.getVersion()).put("deviceAbi",Build.SUPPORTED_ABIS[0])
            .put("input","zero float32 NCHW [1,3,224,224]; runtime compatibility only, not photo accuracy");
        JSONArray graphs=new JSONArray();
        for(MineralModelContract.Model model:contract.models.values()) {
            File file=File.createTempFile("runtime-contract-",".onnx",context.getCacheDir());
            try {
                MessageDigest digest=MessageDigest.getInstance("SHA-256");int total=0;
                try(InputStream input=context.getAssets().open("public/"+model.path);FileOutputStream output=new FileOutputStream(file)) {
                    byte[] buffer=new byte[65536];int count;
                    while((count=input.read(buffer))!=-1){total+=count;assertTrue(total<=model.bytes);digest.update(buffer,0,count);output.write(buffer,0,count);}
                }
                assertEquals(model.bytes,total);StringBuilder hash=new StringBuilder();for(byte b:digest.digest())hash.append(String.format(java.util.Locale.ROOT,"%02x",b&255));assertEquals(model.sha256,hash.toString());
                try(OrtSession.SessionOptions options=new OrtSession.SessionOptions()) {
                    options.setIntraOpNumThreads(2);options.setInterOpNumThreads(1);
                    try(OrtSession session=environment.createSession(file.getAbsolutePath(),options);
                        OnnxTensor tensor=OnnxTensor.createTensor(environment,ByteBuffer.allocateDirect(MineralModelContract.INPUT_BYTES).order(ByteOrder.nativeOrder()).asFloatBuffer(),new long[]{1,3,224,224});
                        OrtSession.Result output=session.run(Collections.singletonMap(model.inputName,tensor))) {
                        assertEquals(1,session.getInputNames().size());assertEquals(1,session.getOutputNames().size());
                        TensorInfo input=(TensorInfo)session.getInputInfo().get(model.inputName).getInfo();assertEquals(OnnxJavaType.FLOAT,input.type);MineralModelContract.validateShape(input.getShape(),new long[]{1,3,224,224});
                        OnnxValue value=output.get(model.outputName).orElseThrow(()->new AssertionError("Missing graph output"));assertTrue(value instanceof OnnxTensor);
                        TensorInfo info=((OnnxTensor)value).getInfo();assertEquals(OnnxJavaType.FLOAT,info.type);assertArrayEquals(new long[]{1,model.classes},info.getShape());
                        FloatBuffer values=((OnnxTensor)value).getFloatBuffer();assertEquals(model.classes,values.remaining());while(values.hasRemaining())assertTrue(Float.isFinite(values.get()));
                        graphs.put(new JSONObject().put("id",model.id).put("sha256",model.sha256).put("classes",model.classes).put("finiteOutput",true));
                    }
                }
            } finally {assertTrue(file.delete());}
        }
        report.put("graphs",graphs).put("phase","passed");File directory=new File(context.getExternalFilesDir(null),"runtime-smoke");assertTrue(directory.isDirectory()||directory.mkdirs());
        try(FileOutputStream output=new FileOutputStream(new File(directory,"native-contract-runtime.json"))){output.write(report.toString(2).getBytes(StandardCharsets.UTF_8));}
    }
}
