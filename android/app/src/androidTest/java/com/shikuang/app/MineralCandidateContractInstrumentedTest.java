package com.shikuang.app;

import static org.junit.Assert.*;
import android.util.Base64;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Metadata and synthetic buffers only. No model/photo asset or ORT forward is opened. */
@RunWith(AndroidJUnit4.class)
public final class MineralCandidateContractInstrumentedTest {
    private interface Attempt { void run() throws Exception; }
    private static void rejects(Attempt attempt) throws Exception {
        try { attempt.run(); fail("Invalid candidate/production contract accepted"); }
        catch (IllegalArgumentException | org.json.JSONException expected) { }
    }
    private static String repeated(char value) { StringBuilder out=new StringBuilder();for(int i=0;i<64;i++)out.append(value);return out.toString(); }
    private static String sha(byte[] raw) throws Exception {
        byte[] digest=MessageDigest.getInstance("SHA-256").digest(raw);StringBuilder out=new StringBuilder();
        for(byte value:digest)out.append(String.format(java.util.Locale.ROOT,"%02x",value&255));return out.toString();
    }
    private static JSONObject copy(JSONObject value) throws Exception { return new JSONObject(value.toString()); }
    private static final class Fixture {
        final MineralModelContract legacy;final String legacyHash;final JSONObject manifest;
        Fixture() throws Exception {
            byte[] raw;
            try(InputStream stream=InstrumentationRegistry.getInstrumentation().getTargetContext().getAssets().open("public/model-manifest.json")) {
                ByteArrayOutputStream bytes=new ByteArrayOutputStream();byte[] buffer=new byte[4096];int count;
                while((count=stream.read(buffer))!=-1){bytes.write(buffer,0,count);assertTrue(bytes.size()<=100000);}raw=bytes.toByteArray();
            }
            legacy=new MineralModelContract(new JSONObject(new String(raw,StandardCharsets.UTF_8)));legacyHash=sha(raw);
            JSONObject profile=new JSONObject().put("profileId",MineralCandidateContract.PROFILE_ID).put("profileVersion",1)
                .put("inputContract","shikuang-native-roi-q16-rgba8-torchf32-001").put("normId","imagenet-rgb-stepwise-f32-div-sub-div-001")
                .put("geometryAlgorithm","shikuang-private-full-aspect-virtual-rgba8-q16-v3-003").put("shape",new JSONArray("[1,3,224,224]")).put("dtype","float32").put("encoding","float32-le");
            JSONArray labels=new JSONArray(),map=new JSONArray();
            for(int i=0;i<MineralCandidateContract.LABELS.size();i++){String id=MineralCandidateContract.LABELS.get(i);labels.put(id);map.put(new JSONObject().put("index",i).put("label",id).put("catalogId",id));}
            JSONObject proof=new JSONObject();
            for(String key:new String[]{"trainingPlanSha256","trainingCompletionSha256","selectedLockSha256","selectedDeltaSha256","captureKernelSha256","exporterSha256","exportCompletionSha256"})proof.put(key,repeated('b'));
            proof.put("officialBaseSha256","b938bf1bc15cd2ec0feacfe3a1bb553fe8ea9ca46a7e1d8d00217f29aef60cd9").put("condition","capture24").put("trainingPhotos",2272)
                .put("selectionRule","min_full87_group_mean_CE_tie_earliest_at_declared_condition_horizon").put("independentKappa",JSONObject.NULL);
            JSONObject classifier=new JSONObject().put("id","dinov2-s14-capture24-fold0").put("role","mineral-classifier").put("path","models/candidates/"+repeated('a')+".onnx")
                .put("bytes",88_450_004).put("sha256",repeated('a')).put("classes",87).put("inputName","input").put("outputName","logits").put("output","logits")
                .put("backbone","dinov2_vits14").put("descriptor","CLS384").put("fold",0).put("selectedEpoch",9).put("provenance",proof);
            MineralModelContract.Model g=legacy.gate;
            JSONObject gateModel=new JSONObject().put("id",g.id).put("role",g.role).put("path",g.path).put("bytes",g.bytes).put("sha256",g.sha256).put("classes",g.classes)
                .put("inputName",g.inputName).put("outputName",g.outputName).put("output","logits");
            manifest=new JSONObject().put("schemaVersion",2).put("version","synthetic-contract-only").put("purpose",MineralCandidateContract.PURPOSE)
                .put("productionRegistered",false).put("independentAcceptance",false).put("inputProfile",profile).put("labelOrderSha256",MineralCandidateContract.LABEL_ORDER_SHA256)
                .put("labels",labels).put("catalogMap",map).put("classifier",classifier)
                .put("gate",new JSONObject().put("legacyManifestSha256",legacyHash).put("inputProfile",MineralCandidateContract.GATE_PROFILE_ID).put("model",gateModel))
                .put("policy",new JSONObject().put("modelSelection","explicit-single-fold").put("output","raw87-per-photo-diagnostic").put("calibrated",false).put("unknownRejectionValidated",false).put("independentKappa",JSONObject.NULL));
        }
        MineralCandidateContract validate(JSONObject value) throws Exception { return new MineralCandidateContract(value,legacy,legacyHash); }
    }
    private static JSONObject intent() throws Exception {
        return new JSONObject().put("diagnostic",true).put("purpose",MineralCandidateContract.PURPOSE).put("profileId",MineralCandidateContract.PROFILE_ID).put("profileVersion",1)
            .put("gateProfileId",MineralCandidateContract.GATE_PROFILE_ID).put("inputEncoding","float32-le-base64");
    }
    @Test public void scientific87OrderMatchesIndependentReferenceDigestAndRejectsRemapping() throws Exception {
        Fixture f=new Fixture();assertEquals(87,f.validate(f.manifest).classifier.classes);
        // Independent compact-JSON order digest of the reviewed Web scientific87 contract.
        assertEquals("a26c30e60293421fc1af2ebe40ef8c1950cbbb11e9b6ac079bf8269f247c739f",sha(f.manifest.getJSONArray("labels").toString().getBytes(StandardCharsets.UTF_8)));
        JSONObject bad=copy(f.manifest);bad.getJSONArray("labels").put(0,"ima-quartz");rejects(()->f.validate(bad));
        JSONObject wrongMap=copy(f.manifest);wrongMap.getJSONArray("catalogMap").getJSONObject(0).put("catalogId","ima-quartz");rejects(()->f.validate(wrongMap));
        rejects(()->new MineralModelContract(f.manifest));
    }
    @Test public void onlyCandidateReceives128MiBAndLegacy80MBStaysClosed() throws Exception {
        Fixture f=new Fixture();assertEquals(80_000_000,MineralModelContract.MAX_MODEL_BYTES);
        for(int size:new int[]{80_000_001,88_450_004,128*1024*1024}){JSONObject candidate=copy(f.manifest);candidate.getJSONObject("classifier").put("bytes",size);assertEquals(size,f.validate(candidate).classifier.bytes);}
        for(int size:new int[]{0,-1,128*1024*1024+1}){JSONObject candidate=copy(f.manifest);candidate.getJSONObject("classifier").put("bytes",size);rejects(()->f.validate(candidate));}
        JSONObject old=new JSONObject();MineralModelContract.Model gate=f.legacy.gate;
        old.put("id",gate.id).put("role",gate.role).put("path",gate.path).put("sha256",gate.sha256).put("inputName",gate.inputName).put("outputName",gate.outputName)
            .put("bytes",80_000_001).put("classes",1000).put("output","logits");rejects(()->new MineralModelContract.Model(old,98));
    }
    @Test public void productionRejectsCandidateMarkersEvenWhenFalseBeforeLoadingResources() throws Exception {
        MineralCandidateContract.requireProductionOnly(new JSONObject().put("mode","fast").put("manifestSha256",repeated('a')));
        for(String key:new String[]{"profileId","profileVersion","inputProfile","researchProfile","researchManifest","candidateManifest","candidateProfile","candidateManifestPath","candidateManifestSha256","legacyManifestSha256","diagnostic","purpose","gateInputs","gateProfileId"}) {
            JSONObject request=new JSONObject().put(key,false);rejects(()->MineralCandidateContract.requireProductionOnly(request));
        }
    }
    @Test public void diagnosticRequiresBothExplicitProfilesAndRejectsLegacyMode() throws Exception {
        MineralCandidateContract.validateIntent(intent());
        for(String field:new String[]{"diagnostic","purpose","profileId","profileVersion","gateProfileId","inputEncoding"}){JSONObject request=intent();request.remove(field);rejects(()->MineralCandidateContract.validateIntent(request));}
        JSONObject gate=intent().put("gateProfileId",MineralCandidateContract.PROFILE_ID);rejects(()->MineralCandidateContract.validateIntent(gate));
        JSONObject mode=intent().put("mode","ensemble");rejects(()->MineralCandidateContract.validateIntent(mode));
    }
    @Test public void forgedGateIdentityProfileOrAcceptanceNeverCreatesClassifier() throws Exception {
        Fixture f=new Fixture();
        JSONObject hash=copy(f.manifest);hash.getJSONObject("gate").getJSONObject("model").put("sha256",repeated('0'));rejects(()->f.validate(hash));
        JSONObject profile=copy(f.manifest);profile.getJSONObject("gate").put("inputProfile",MineralCandidateContract.PROFILE_ID);rejects(()->f.validate(profile));
        JSONObject legacy=copy(f.manifest);legacy.getJSONObject("gate").put("legacyManifestSha256",repeated('0'));rejects(()->f.validate(legacy));
        JSONObject provenance=copy(f.manifest);provenance.getJSONObject("classifier").getJSONObject("provenance").put("selectionRule","best_outer_score");rejects(()->f.validate(provenance));
        JSONObject score=copy(f.manifest);score.getJSONObject("classifier").getJSONObject("provenance").put("independentKappa",.8);rejects(()->f.validate(score));
        JSONObject registered=copy(f.manifest).put("productionRegistered",true);rejects(()->f.validate(registered));
    }
    @Test public void dualSyntheticTensorsHaveIndependentFiniteNativeBuffers() throws Exception {
        byte[] bytes=new byte[MineralModelContract.INPUT_BYTES];String input=Base64.encodeToString(bytes,Base64.NO_WRAP);
        FloatBuffer gate=MineralModelContract.decodeInput(input),candidate=MineralModelContract.decodeInput(input);
        assertTrue(gate.isDirect()&&candidate.isDirect());assertNotSame(gate,candidate);gate.put(0,42f);assertEquals(0f,candidate.get(0),0f);
        ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).putFloat(Float.NaN);String invalid=Base64.encodeToString(bytes,Base64.NO_WRAP);rejects(()->MineralModelContract.decodeInput(invalid));
    }
    @Test public void candidateMetadataCannotEscapeBundledNamespace() throws Exception {
        assertEquals("research/candidates/fold0.json",MineralCandidateContract.manifestPath("research/candidates/fold0.json"));
        for(String path:new String[]{"../candidate.json","research/candidates/../x.json","https://other/x.json","research/candidates/x.json?token=1","research/candidates/x.json#x"})rejects(()->MineralCandidateContract.manifestPath(path));
    }
}
