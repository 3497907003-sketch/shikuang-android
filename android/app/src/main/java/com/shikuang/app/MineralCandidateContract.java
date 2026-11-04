package com.shikuang.app;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Explicit engineering-only schema2. Never relaxes the production schema1 contract. */
final class MineralCandidateContract {
    static final String PURPOSE = "candidate-engineering-validation";
    static final String PROFILE_ID = "shikuang-research-native-roi-q16-torchf32-v1";
    static final String GATE_PROFILE_ID = "schema1-center-square-bilinear-final-f32-v1";
    static final String LABEL_ORDER_SHA256 = "c167fa68e1019852a93d7b304237baf5ebe3e7ed4d0eb5a50b4e4dc1214c67bc";
    static final int MAX_MODEL_BYTES = 128 * 1024 * 1024;
    static final List<String> LABELS = Collections.unmodifiableList(Arrays.asList(
        "ima-graphite",
        "ima-gold",
        "ima-silver",
        "ima-stibnite",
        "ima-copper",
        "ima-sulphur",
        "ima-hematite",
        "ima-cassiterite",
        "ima-microcline",
        "ima-quartz",
        "ima-bournonite",
        "ima-pyrargyrite",
        "ima-marcasite",
        "ima-arsenopyrite",
        "ima-cobaltite",
        "ima-arsenic",
        "ima-pyrite",
        "ima-chromite",
        "ima-opal",
        "ima-bismuth",
        "ima-magnetite",
        "ima-chrysoberyl",
        "ima-topaz",
        "ima-cinnabar",
        "ima-beryl",
        "ima-gypsum",
        "ima-proustite",
        "ima-spodumene",
        "ima-augite",
        "ima-spinel",
        "ima-andalusite",
        "ima-pollucite",
        "ima-cuprite",
        "ima-hedenbergite",
        "ima-ilmenite",
        "ima-actinolite",
        "ima-diopside",
        "ima-tremolite",
        "ima-albite",
        "ima-rutile",
        "ima-zircon",
        "ima-corundum",
        "ima-celestine",
        "ima-malachite",
        "ima-sphalerite",
        "ima-wollastonite",
        "ima-rhodonite",
        "ima-fluorite",
        "ima-orthoclase",
        "ima-aragonite",
        "ima-dolomite",
        "ima-pectolite",
        "ima-grossular",
        "ima-kyanite",
        "ima-cancrinite",
        "ima-andradite",
        "ima-almandine",
        "ima-baryte",
        "ima-galena",
        "ima-muscovite",
        "ima-calcite",
        "ima-aegirine",
        "ima-eudialyte",
        "ima-azurite",
        "ima-goethite",
        "ima-epidote",
        "ima-scheelite",
        "ima-vesuvianite",
        "ima-chalcopyrite",
        "ima-analcime",
        "ima-natrolite",
        "ima-molybdenite",
        "ima-pyrrhotite",
        "ima-prehnite",
        "ima-siderite",
        "ima-creedite",
        "ima-vivianite",
        "ima-titanite",
        "ima-elbaite",
        "ima-fluorapatite",
        "ima-diamond",
        "ima-lazurite",
        "ima-phlogopite",
        "ima-rhodochrosite",
        "ima-smithsonite",
        "ima-clinochlore",
        "ima-halite"));

    /** Only the fully validated schema2 constructor below can create this token. */
    static final class ValidatedClassifier {
        final String id, path, sha256, inputName, outputName;
        final int bytes;
        private ValidatedClassifier(JSONObject row) throws JSONException {
            id=string(row,"id"); path=string(row,"path"); sha256=string(row,"sha256");
            inputName=string(row,"inputName"); outputName=string(row,"outputName"); bytes=integer(row,"bytes");
        }
    }
    final String version;
    final int fold, selectedEpoch;
    final MineralModelContract.Model classifier;

    static void requireProductionOnly(JSONObject request) {
        require(request!=null);
        for (String key:new String[]{"profileId","profileVersion","inputProfile","researchProfile","researchManifest",
                "candidateManifest","candidateProfile","candidateManifestPath","candidateManifestSha256","legacyManifestSha256",
                "diagnostic","purpose","gateInputs","gateProfileId"}) {
            if(request.has(key)) throw new IllegalArgumentException("生产识别禁止候选或研究profile，请显式使用开发候选入口");
        }
    }
    static void validateIntent(JSONObject request) throws JSONException {
        require(Boolean.TRUE.equals(request.opt("diagnostic")) && PURPOSE.equals(request.opt("purpose")));
        require(PROFILE_ID.equals(request.opt("profileId")) && integer(request,"profileVersion")==1);
        require(GATE_PROFILE_ID.equals(request.opt("gateProfileId")) && "float32-le-base64".equals(request.opt("inputEncoding")));
        require(!request.has("mode") && !request.has("modelIds") && !request.has("researchManifest"));
    }
    static String manifestPath(String path) {
        require(path!=null && path.matches("research/candidates/[A-Za-z0-9_.-]+\\.json")); return path;
    }
    MineralCandidateContract(JSONObject value, MineralModelContract legacy, String legacyHash) throws JSONException {
        keys(value,"schemaVersion","version","purpose","productionRegistered","independentAcceptance","inputProfile","labelOrderSha256","labels","catalogMap","classifier","gate","policy");
        require(integer(value,"schemaVersion")==2 && PURPOSE.equals(string(value,"purpose"))
            && Boolean.FALSE.equals(value.get("productionRegistered")) && Boolean.FALSE.equals(value.get("independentAcceptance")));
        version=string(value,"version"); require(version.matches("[A-Za-z0-9._-]{1,80}"));
        JSONObject profile=value.getJSONObject("inputProfile");
        keys(profile,"profileId","profileVersion","inputContract","normId","geometryAlgorithm","shape","dtype","encoding");
        require(PROFILE_ID.equals(string(profile,"profileId")) && integer(profile,"profileVersion")==1
            && "shikuang-native-roi-q16-rgba8-torchf32-001".equals(string(profile,"inputContract"))
            && "imagenet-rgb-stepwise-f32-div-sub-div-001".equals(string(profile,"normId"))
            && "shikuang-private-full-aspect-virtual-rgba8-q16-v3-003".equals(string(profile,"geometryAlgorithm"))
            && "float32".equals(string(profile,"dtype")) && "float32-le".equals(string(profile,"encoding")));
        JSONArray shape=profile.getJSONArray("shape");require(shape.length()==4);
        for(int i=0;i<4;i++)require(integer(shape,i)==new int[]{1,3,224,224}[i]);
        require(LABEL_ORDER_SHA256.equals(string(value,"labelOrderSha256")) && LABELS.equals(MineralModelContract.strings(value.getJSONArray("labels"))));
        JSONArray map=value.getJSONArray("catalogMap");require(map.length()==87);
        for(int i=0;i<87;i++){
            JSONObject entry=map.getJSONObject(i);keys(entry,"index","label","catalogId");
            require(integer(entry,"index")==i && LABELS.get(i).equals(string(entry,"label")) && LABELS.get(i).equals(string(entry,"catalogId")));
        }
        JSONObject row=value.getJSONObject("classifier");
        keys(row,"id","role","path","bytes","sha256","classes","inputName","outputName","output","backbone","descriptor","fold","selectedEpoch","provenance");
        fold=integer(row,"fold");selectedEpoch=integer(row,"selectedEpoch");String modelHash=string(row,"sha256");
        require((fold==0||fold==1) && selectedEpoch>=1 && selectedEpoch<=24 && integer(row,"classes")==87
            && integer(row,"bytes")>0 && integer(row,"bytes")<=MAX_MODEL_BYTES && hash(modelHash)
            && ("models/candidates/"+modelHash+".onnx").equals(string(row,"path"))
            && ("dinov2-s14-capture24-fold"+fold).equals(string(row,"id")) && "mineral-classifier".equals(string(row,"role"))
            && "dinov2_vits14".equals(string(row,"backbone")) && "CLS384".equals(string(row,"descriptor"))
            && "input".equals(string(row,"inputName")) && "logits".equals(string(row,"outputName")) && "logits".equals(string(row,"output")));
        JSONObject proof=row.getJSONObject("provenance");
        String[] hashes={"trainingPlanSha256","trainingCompletionSha256","selectedLockSha256","selectedDeltaSha256","officialBaseSha256","captureKernelSha256","exporterSha256","exportCompletionSha256"};
        keys(proof,"trainingPlanSha256","trainingCompletionSha256","selectedLockSha256","selectedDeltaSha256","officialBaseSha256","captureKernelSha256","exporterSha256","exportCompletionSha256","condition","trainingPhotos","selectionRule","independentKappa");
        for(String key:hashes)require(hash(string(proof,key)));
        require("b938bf1bc15cd2ec0feacfe3a1bb553fe8ea9ca46a7e1d8d00217f29aef60cd9".equals(string(proof,"officialBaseSha256"))
            && "capture24".equals(string(proof,"condition")) && integer(proof,"trainingPhotos")>=87
            && "min_full87_group_mean_CE_tie_earliest_at_declared_condition_horizon".equals(string(proof,"selectionRule"))
            && proof.isNull("independentKappa"));
        JSONObject gate=value.getJSONObject("gate");keys(gate,"legacyManifestSha256","inputProfile","model");
        require(legacy!=null && hash(legacyHash) && legacyHash.equals(string(gate,"legacyManifestSha256")) && GATE_PROFILE_ID.equals(string(gate,"inputProfile")));
        JSONObject gateModel=gate.getJSONObject("model");keys(gateModel,"id","role","path","bytes","sha256","classes","inputName","outputName","output");
        MineralModelContract.Model old=legacy.gate;
        require(old.id.equals(string(gateModel,"id")) && old.role.equals(string(gateModel,"role")) && old.path.equals(string(gateModel,"path"))
            && old.bytes==integer(gateModel,"bytes") && old.sha256.equals(string(gateModel,"sha256")) && old.classes==integer(gateModel,"classes")
            && old.inputName.equals(string(gateModel,"inputName")) && old.outputName.equals(string(gateModel,"outputName")) && "logits".equals(string(gateModel,"output")));
        JSONObject policy=value.getJSONObject("policy");keys(policy,"modelSelection","output","calibrated","unknownRejectionValidated","independentKappa");
        require("explicit-single-fold".equals(string(policy,"modelSelection")) && "raw87-per-photo-diagnostic".equals(string(policy,"output"))
            && Boolean.FALSE.equals(policy.get("calibrated")) && Boolean.FALSE.equals(policy.get("unknownRejectionValidated")) && policy.isNull("independentKappa"));
        classifier=new MineralModelContract.Model(new ValidatedClassifier(row));
    }
    private static void keys(JSONObject value,String... expected) throws JSONException {
        HashSet<String> actual=new HashSet<>();Iterator<String> names=value.keys();while(names.hasNext())actual.add(names.next());
        require(actual.equals(new HashSet<>(Arrays.asList(expected))));
    }
    static boolean hash(String value){return value!=null&&value.matches("[a-f0-9]{64}");}
    private static String string(JSONObject object,String key) throws JSONException {require(object.get(key)instanceof String);return object.getString(key);}
    private static int integer(JSONObject object,String key) throws JSONException {return integerValue(object.get(key));}
    private static int integer(JSONArray array,int index) throws JSONException {return integerValue(array.get(index));}
    private static int integerValue(Object value){require(value instanceof Number);double d=((Number)value).doubleValue();require(!Double.isNaN(d)&&!Double.isInfinite(d)&&d==Math.rint(d)&&d>=Integer.MIN_VALUE&&d<=Integer.MAX_VALUE);return(int)d;}
    private static void require(boolean valid){if(!valid)throw new IllegalArgumentException("开发候选契约不匹配，未注册为正式识别模型");}
}
