package com.shikuang.app;

import static org.junit.Assert.*;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkInfo;
import android.os.Build;
import android.os.SystemClock;
import android.system.Os;
import android.system.OsConstants;
import android.util.Base64;
import android.util.Log;
import android.webkit.WebView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.OutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Runs the installed app's real HTML, preprocessing, native ONNX engine and UI. */
@RunWith(AndroidJUnit4.class)
public class MineralEngineInstrumentedTest {
    private static final String TAG = "ShikuangRuntimeSmoke";
    private static final String NON_MINERAL = "这不是矿物，请您放入清晰的矿物照片。";
    ActivityScenario<MainActivity> scenario;

    static String script(String... lines) {
        // java.lang.String.join is API26; this harness also runs on API24.
        StringBuilder source = new StringBuilder();
        for (String line : lines) {
            if (source.length() > 0) source.append('\n');
            source.append(line);
        }
        return source.toString();
    }

    /** evaluateJavascript callbacks run on the UI thread; wait only on the test thread. */
    String evaluate(String source) throws Exception {
        CountDownLatch returned = new CountDownLatch(1);
        AtomicReference<String> value = new AtomicReference<>();
        scenario.onActivity(activity -> activity.getBridge().getWebView().evaluateJavascript(source, result -> {
            value.set(result);
            returned.countDown();
        }));
        assertTrue("WebView JS callback timed out", returned.await(10, TimeUnit.SECONDS));
        Object decoded = new JSONArray("[" + value.get() + "]").get(0);
        return decoded == JSONObject.NULL ? "null" : decoded.toString();
    }

    private JSONObject state() throws Exception {
        return new JSONObject(evaluate("JSON.stringify(window.__shikuangRuntimeSmoke || {})"));
    }

    private String shellOutput(String command) throws Exception {
        try (InputStream stream = new android.os.ParcelFileDescriptor.AutoCloseInputStream(
            InstrumentationRegistry.getInstrumentation().getUiAutomation().executeShellCommand(command))) {
            java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            int read;
            while ((read = stream.read(buffer)) != -1) output.write(buffer, 0, read);
            return new String(output.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    JSONObject nativeNetworkState() throws Exception {
        final long pageSize = Os.sysconf(OsConstants._SC_PAGESIZE);
        Context target=InstrumentationRegistry.getInstrumentation().getTargetContext();
        final android.content.pm.PackageInfo installed=target.getPackageManager().getPackageInfo(target.getPackageName(),0);
        AtomicReference<JSONObject> value = new AtomicReference<>();
        scenario.onActivity(activity -> {
            ConnectivityManager manager = (ConnectivityManager) activity.getSystemService(Context.CONNECTIVITY_SERVICE);
            Network active = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? manager.getActiveNetwork() : null;
            NetworkCapabilities capabilities = active == null ? null : manager.getNetworkCapabilities(active);
            NetworkInfo info = manager.getActiveNetworkInfo();
            try {
                value.set(new JSONObject()
                    .put("sdk", Build.VERSION.SDK_INT)
                    .put("pageSize", pageSize)
                    .put("deviceAbi", Build.SUPPORTED_ABIS[0])
                    .put("packageName", activity.getPackageName())
                    .put("versionName", installed.versionName)
                    .put("versionCode", installed.versionCode)
                    .put("supportedAbis", new JSONArray(java.util.Arrays.asList(Build.SUPPORTED_ABIS)))
                    .put("activeNetwork", active == null ? JSONObject.NULL : active.toString())
                    .put("connected", info != null && info.isConnected())
                    .put("internetCapability", capabilities != null && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET))
                    .put("validated", capabilities != null && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)));
            } catch (org.json.JSONException error) {
                throw new AssertionError(error);
            }
        });
        return value.get();
    }

    JSONObject awaitPhase(String phase, long timeoutMillis) throws Exception {
        long end = SystemClock.elapsedRealtime() + timeoutMillis;
        JSONObject latest = new JSONObject();
        do {
            latest = state();
            if (phase.equals(latest.optString("phase"))) return latest;
            if ("failed".equals(latest.optString("phase"))) fail(latest.toString());
            SystemClock.sleep(150);
        } while (SystemClock.elapsedRealtime() < end);
        fail("Timed out waiting for " + phase + ": " + latest);
        return latest;
    }

    void awaitPage() throws Exception {
        long end = SystemClock.elapsedRealtime() + 60000;
        do {
            if ("true".equals(evaluate("!!(window.__shikuangAppReady && window.MineralEngine && window.MINERAL_CLASSES && document.getElementById('predictBtn') && !document.getElementById('native-boot-recovery') && document.getElementById('launchCover').hidden)"))) return;
            SystemClock.sleep(150);
        } while (SystemClock.elapsedRealtime() < end);
        fail("Packaged main page did not initialize");
    }

    private boolean supportedWebView() throws Exception {
        long end = SystemClock.elapsedRealtime() + 30000;
        do {
            String capability = evaluate("window.__shikuangBootCapabilities ? String(window.__shikuangBootCapabilities.supported) : 'pending'");
            if ("true".equals(capability)) return true;
            if ("false".equals(capability)) return false;
            SystemClock.sleep(100);
        } while (SystemClock.elapsedRealtime() < end);
        fail("Trusted boot capability gate did not initialize");
        return false;
    }

    void requireSupportedWebView() throws Exception {
        boolean supported = supportedWebView();
        if (!supported) evaluate("window.__shikuangRuntimeSmoke={phase:'failed',fullOfflineProductVerified:false,photoRecognitionVerified:false,failure:'Full offline product requires a supported boot; recovery cannot pass this test',boot:window.__shikuangBootCapabilities,userAgent:navigator.userAgent};");
        assertTrue("Required stock WebView must open the complete App, including API24: "
            + evaluate("JSON.stringify(window.__shikuangBootCapabilities || {})"), supported);
    }

    private String fixture(String name) throws Exception {
        Context testContext = InstrumentationRegistry.getInstrumentation().getContext();
        Bitmap source;
        try (InputStream stream = testContext.getAssets().open(name)) {
            source = BitmapFactory.decodeStream(stream);
        }
        assertNotNull("Cannot decode fixture " + name, source);
        float scale = Math.min(1f, 640f / Math.max(source.getWidth(), source.getHeight()));
        Bitmap resized = Bitmap.createScaledBitmap(source,
            Math.round(source.getWidth() * scale), Math.round(source.getHeight() * scale), true);
        java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
        assertTrue(resized.compress(Bitmap.CompressFormat.JPEG, 95, bytes));
        String data = "data:image/jpeg;base64," + Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP);
        if (resized != source) resized.recycle();
        source.recycle();
        return data;
    }

    private String encodedAsset(String name, String mime) throws Exception {
        try (InputStream stream = InstrumentationRegistry.getInstrumentation().getContext().getAssets().open(name)) {
            java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();byte[] buffer = new byte[4096];int count;
            while ((count=stream.read(buffer)) != -1) bytes.write(buffer,0,count);
            return "data:"+mime+";base64,"+Base64.encodeToString(bytes.toByteArray(),Base64.NO_WRAP);
        }
    }

    private void checkPhotoGeometry() throws Exception {
        String exif=encodedAsset("quartz-exif6.jpg","image/jpeg"),upright=encodedAsset("quartz-exif6-upright.png","image/png");
        evaluate(script(
            "(async()=>{const s=window.__shikuangRuntimeSmoke;s.phase='geometry-running';try{",
            " const jpeg=await MineralEngine.image("+JSONObject.quote(exif)+"),png=await MineralEngine.image("+JSONObject.quote(upright)+");",
            " if(jpeg.naturalWidth!==320||jpeg.naturalHeight!==512||png.naturalWidth!==320||png.naturalHeight!==512)throw new Error('EXIF 6 photo was not rotated upright');",
            " const draw=image=>{const c=document.createElement('canvas');c.width=image.naturalWidth;c.height=image.naturalHeight;const x=c.getContext('2d');x.drawImage(image,0,0);return x.getImageData(0,0,c.width,c.height).data;};",
            " const difference=(a,b)=>{let maximum=0;for(let i=0;i<a.length;i++)if(i%4!==3)maximum=Math.max(maximum,Math.abs(a[i]-b[i]));return maximum;};",
            " const decoderRgbAbsMax=difference(draw(jpeg),draw(png));if(decoderRgbAbsMax>4)throw new Error('EXIF decoder differs from upright reference');",
            " const crops=[];for(const crop of [1,.75,.5]){let geometry;const original=CanvasRenderingContext2D.prototype.drawImage;CanvasRenderingContext2D.prototype.drawImage=function(...args){geometry=args.slice(1);return original.apply(this,args);};let canvas;try{canvas=MineralEngine.cropCanvas(jpeg,224,crop);}finally{CanvasRenderingContext2D.prototype.drawImage=original;}",
            " const side=320*crop,expected=[(320-side)/2,(512-side)/2,side,side,0,0,224,224];if(JSON.stringify(geometry)!==JSON.stringify(expected))throw new Error('Center-square ROI geometry changed');",
            " const uprightCrop=MineralEngine.cropCanvas(png,224,crop),actual=canvas.getContext('2d').getImageData(0,0,224,224).data,reference=uprightCrop.getContext('2d').getImageData(0,0,224,224).data;let sum=0;for(let i=0;i<actual.length;i++)if(i%4!==3)sum+=Math.abs(actual[i]-reference[i]);crops.push({crop,geometry,resizedSourceFormatRgbAbsMax:difference(actual,reference),resizedSourceFormatRgbAbsMean:sum/(224*224*3)});}",
            " const pattern=document.createElement('canvas');pattern.width=512;pattern.height=320;const pc=pattern.getContext('2d'),pd=pc.createImageData(512,320);for(let y=0;y<320;y++)for(let x=0;x<512;x++){const i=(y*512+x)*4;pd.data[i]=Math.floor(x/2);pd.data[i+1]=Math.round(y*255/319);pd.data[i+2]=91;pd.data[i+3]=255;}pc.putImageData(pd,0,0);const coordinateImage=await MineralEngine.image(pattern.toDataURL('image/png')),coordinateCrops=[];",
            " for(const crop of [1,.75,.5]){const side=320*crop,left=(512-side)/2,top=(320-side)/2,c=MineralEngine.cropCanvas(coordinateImage,224,crop),p=c.getContext('2d').getImageData(0,0,224,224).data;let max=0;for(let y=0;y<224;y++)for(let x=0;x<224;x++){const i=(y*224+x)*4,sx=left+(x+.5)*side/224-.5,sy=top+(y+.5)*side/224-.5;max=Math.max(max,Math.abs(p[i]-sx/2),Math.abs(p[i+1]-sy*255/319),Math.abs(p[i+2]-91));}if(max>2)throw new Error('Coordinate-pattern center-square bilinear boundary differs: '+max);coordinateCrops.push({crop,rgbBoundaryAbsMax:max});}",
            " s.photoGeometry={source:'Derived from existing quartz smoke photo; algorithm regression only, no accuracy claim',exifOrientation:6,width:jpeg.naturalWidth,height:jpeg.naturalHeight,decoderRgbAbsMax,crops,coordinateCrops,sourceFormatResizePixelParityClaim:false,pilCanvasResizePixelParityClaim:false};s.phase='geometry-passed';",
            " }catch(e){s.phase='failed';s.failure=String(e);}})();"
        ));
        awaitPhase("geometry-passed",30000);
    }

    private JSONObject bundledJson(String path) throws Exception {
        try (InputStream stream = InstrumentationRegistry.getInstrumentation().getTargetContext().getAssets().open("public/" + path)) {
            java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream(); byte[] buffer = new byte[4096]; int count;
            while ((count = stream.read(buffer)) != -1) { bytes.write(buffer,0,count); assertTrue("Oversized test metadata", bytes.size() <= 10_000_000); }
            return new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8));
        }
    }

    void screenshot(String filename, String selector) throws Exception {
        awaitUi("(() => {const e=document.querySelector(" + JSONObject.quote(selector) + ");if(!e)return false;const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth;})()",
            "visible screenshot target " + selector,10000);
        awaitUi("!document.getElementById('toast') || document.getElementById('toast').hidden", "toast to finish naturally",10000);
        CountDownLatch drawn = new CountDownLatch(1);
        scenario.onActivity(activity -> {
            WebView view = activity.getBridge().getWebView();
            Runnable nextFrames = () -> { view.invalidate(); view.postOnAnimation(() -> view.postOnAnimation(drawn::countDown)); };
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) view.postVisualStateCallback(SystemClock.elapsedRealtime(),new WebView.VisualStateCallback() {
                @Override public void onComplete(long id) { nextFrames.run(); }
            });
            else nextFrames.run();
        });
        assertTrue("WebView visual state did not become drawable",drawn.await(10,TimeUnit.SECONDS));
        // Chromium's visual callback precedes the display compositor on some
        // emulator images. Await stable genuine display pixels as well.
        SystemClock.sleep(750);
        evaluate("(() => {const e=document.querySelector(" + JSONObject.quote(selector) + "),r=e.getBoundingClientRect(),s=window.__shikuangRuntimeSmoke;s.screenshots=s.screenshots||[];s.screenshots.push({filename:" + JSONObject.quote(filename) + ",selector:" + JSONObject.quote(selector) + ",text:e.textContent.slice(0,600),rect:{top:r.top,bottom:r.bottom,left:r.left,right:r.right},viewport:{width:innerWidth,height:innerHeight},visualStateSynchronized:true});})()");
        Bitmap bitmap = InstrumentationRegistry.getInstrumentation().getUiAutomation().takeScreenshot();
        assertNotNull("Screenshot unavailable", bitmap);
        boolean stable = false;
        for (int attempt = 0; attempt < 8; attempt++) {
            SystemClock.sleep(200);
            Bitmap next = InstrumentationRegistry.getInstrumentation().getUiAutomation().takeScreenshot();
            assertNotNull("Screenshot unavailable while waiting for display composition", next);
            stable = bitmap.sameAs(next);
            bitmap.recycle();
            bitmap = next;
            if (stable) break;
        }
        if (!stable) { bitmap.recycle(); fail("Display pixels did not stabilize for " + filename); }
        try (OutputStream stream = RuntimeTestOutput.open(filename)) {
            assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream));
        } finally {
            bitmap.recycle();
        }
    }

    private void writeDiagnostics() {
        try {
            JSONObject report = state();
            Log.i(TAG, report.toString());
            try (OutputStream stream = RuntimeTestOutput.open("runtime-report.json")) {
                stream.write(report.toString(2).getBytes(StandardCharsets.UTF_8));
            }
        } catch (Exception error) {
            Log.e(TAG, "Could not save runtime diagnostics", error);
        }
    }

    private void submitFixture(String data, String name) throws Exception {
        evaluate(script(
            "(() => {",
            " const binary=atob(" + JSONObject.quote(data.substring(data.indexOf(',') + 1)) + ");",
            " const bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));",
            " const transfer=new DataTransfer();",
            " transfer.items.add(new File([bytes]," + JSONObject.quote(name) + ",{type:'image/jpeg'}));",
            " const input=document.getElementById('fileInput');input.files=transfer.files;",
            " input.dispatchEvent(new Event('change',{bubbles:true}));",
            "})()"
        ));
        long end = SystemClock.elapsedRealtime() + 20000;
        do {
            if ("true".equals(evaluate("!document.getElementById('predictBtn').disabled"))) return;
            SystemClock.sleep(100);
        } while (SystemClock.elapsedRealtime() < end);
        fail("Photo file UI remained unavailable: " + evaluate("document.getElementById('progress').textContent"));
    }

    void awaitUi(String predicate, String description, long timeoutMillis) throws Exception {
        long end = SystemClock.elapsedRealtime() + timeoutMillis;
        do {
            if ("true".equals(evaluate("!!(" + predicate + ")"))) return;
            SystemClock.sleep(150);
        } while (SystemClock.elapsedRealtime() < end);
        fail("Timed out waiting for " + description + ": " + evaluate("document.getElementById('catalogLoadState') ? document.getElementById('catalogLoadState').textContent : 'No catalog UI'"));
    }

    private JSONArray checkDecodedGalleryPhotos(int expected, String field) throws Exception {
        awaitUi("document.querySelectorAll('#imageRecords img').length==="+expected+" && [...document.querySelectorAll('#imageRecords img')].every(i=>!i.hidden && i.complete && i.naturalWidth>0 && i.naturalWidth===Number(i.getAttribute('width')) && i.naturalHeight===Number(i.getAttribute('height')))",
            "genuine offline gallery JPEGs to decode", 30000);
        evaluate(script(
            "(async()=>{const s=window.__shikuangRuntimeSmoke;try{const photos=[];",
            " for(const image of document.querySelectorAll('#imageRecords img')){const record=MINERAL_IMAGE_SOURCES.records.find(row=>'gallery-image-'+row.id===image.id),blob=image.currentSrc||image.src;if(!record||!blob.startsWith('blob:'))throw Error('Gallery does not display the source-bound blob');",
            " const asset=MineralGallery.asset(record),response=await fetch(blob),bytes=await MineralCore.readResource(response,1048576,asset.bytes,undefined,{timeout:15000}),sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');",
            " if(sha256!==asset.sha256||image.naturalWidth!==record.width||image.naturalHeight!==record.height)throw Error('Displayed photo SHA or decoded dimensions differ from source');",
            " photos.push({id:record.id,path:asset.path,url:MineralGallery.url(asset,location.href),blobUrl:blob,sha256,bytes:bytes.length,width:image.naturalWidth,height:image.naturalHeight,complete:image.complete,decoded:true,sourceUrl:record.image_page_url,licenseUrl:record.license_url});}",
            " s["+JSONObject.quote(field)+"]=photos;s.phase="+JSONObject.quote(field+"-passed")+";",
            " }catch(e){s.phase='failed';s.failure=String(e);}})();"
        ));
        JSONArray photos = awaitPhase(field+"-passed",30000).getJSONArray(field);
        assertEquals(expected,photos.length());
        for(int i=0;i<photos.length();i++)assertTrue(photos.getJSONObject(i).getBoolean("decoded"));
        return photos;
    }

    /** Recreate the Activity offline and verify real IndexedDB and search history UI. */
    private void checkHistoryAfterActivityRecreate(String recordId) throws Exception {
        evaluate(script(
            "(() => {const s=window.__shikuangRuntimeSmoke;s.phase='history-before-activity-recreate';document.getElementById('closeDetail').click();document.querySelector('[data-view=records]').click();",
            " const input=document.getElementById('recordSearch');input.value='石英';input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})();"
        ));
        awaitUi("!document.getElementById('view-records').hidden && document.querySelectorAll('#recordList [data-record]').length===1 && document.getElementById('recordSearchHistory').textContent.includes('石英')",
            "saved specimen and genuine search history UI",15000);
        evaluate("(async()=>{const s=window.__shikuangRuntimeSmoke;s.historySnapshot=JSON.stringify((await SpecimenStore.list()).find(r=>r.id==="+JSONObject.quote(recordId)+"));s.phase='history-snapshot';})();");
        JSONObject before = awaitPhase("history-snapshot",15000);
        String snapshot = before.getString("historySnapshot");
        assertFalse("Saved specimen snapshot must exist", "undefined".equals(snapshot));
        scenario.recreate();
        requireSupportedWebView();
        awaitPage();
        evaluate("window.__shikuangRuntimeSmoke="+before+";window.__shikuangRuntimeSmoke.phase='history-activity-recreating';");
        evaluate(script(
            "(async()=>{const s=window.__shikuangRuntimeSmoke;try{const rows=await SpecimenStore.list(),row=rows.find(r=>r.id==="+JSONObject.quote(recordId)+");",
            " if(JSON.stringify(row)!=="+JSONObject.quote(snapshot)+")throw Error('Saved specimen changed after offline Activity restart');",
            " const search=SearchHistory.read().some(r=>r.kind==='records'&&r.query==='石英');if(!search)throw Error('Search history did not survive restart');",
            " s.history={recordId:row.id,key:row.key,records:rows.length,photoCount:row.photoCount,recordUnchanged:true,searchPreserved:true,activityRecreatePreserved:true};document.querySelector('[data-view=records]').click();s.phase='history-activity-recreated';",
            " }catch(e){s.phase='failed';s.failure=String(e);}})();"
        ));
        JSONObject history = awaitPhase("history-activity-recreated",15000).getJSONObject("history");
        assertEquals("quartz",history.getString("key"));
        assertEquals(1,history.getInt("records"));
        assertEquals(1,history.getInt("photoCount"));
        awaitUi("!document.getElementById('view-records').hidden && document.querySelectorAll('#recordList [data-record]').length===1 && document.getElementById('recordSearchHistory').textContent.includes('石英')",
            "history and search chips after Activity recreate",15000);
        evaluate("document.querySelector('#recordList [data-record]').click();");
        awaitUi("document.getElementById('recordDialog').open && document.querySelector('#recordBody img') && document.querySelector('#recordBody img').complete && document.querySelector('#recordBody img').naturalWidth>0",
            "saved specimen photo in history detail",15000);
        JSONObject network = nativeNetworkState();
        assertTrue(network.isNull("activeNetwork"));assertFalse(network.getBoolean("connected"));
        assertEquals("false",evaluate("navigator.onLine"));
        evaluate("document.getElementById('closeRecord').click();window.__shikuangRuntimeSmoke.networkAfterActivityRecreate={native:"+network+"};window.__shikuangRuntimeSmoke.history.detailPhotoDecoded=true;window.__shikuangRuntimeSmoke.fullOfflineProductVerified=true;window.__shikuangRuntimeSmoke.photoRecognitionVerified=true;window.__shikuangRuntimeSmoke.phase='passed';");
    }

    /** Metadata from the real UI-saved record, never a seeded persistence fixture. */
    private void captureColdProcessBaseline(String recordId) throws Exception {
        evaluate(script(
            "(async()=>{const s=window.__shikuangRuntimeSmoke;s.phase='cold-baseline-reading';try{const rows=await SpecimenStore.list(),row=rows.find(r=>r.id==="+JSONObject.quote(recordId)+");",
            " if(rows.length!==1||!row||row.key!=='quartz'||row.modelCount!==3||row.photoCount!==1)throw Error('Real UI saved-record baseline missing');",
            " s.historySnapshot=JSON.stringify(row);s.searchHistorySnapshot=JSON.stringify(SearchHistory.read());s.phase='cold-baseline-read';",
            " }catch(e){s.phase='failed';s.failure=String(e);}})();"
        ));
        JSONObject state = awaitPhase("cold-baseline-read",15000);
        JSONObject row = new JSONObject(state.getString("historySnapshot"));
        JSONObject baseline = RuntimeHistoryEvidence.identity(state.getString("historySnapshot"),state.getString("searchHistorySnapshot"));
        assertEquals(recordId,row.getString("id"));
        baseline.put("source", "real-ui-native-three-model-record")
            .put("firstPhasePid",android.os.Process.myPid())
            .put("firstPhaseElapsedRealtimeMs",SystemClock.elapsedRealtime())
            .put("origin",evaluate("location.origin"));
        evaluate("window.__shikuangRuntimeSmoke.coldProcessBaseline="+baseline+";window.__shikuangRuntimeSmoke.phase='passed';");
    }

    /** Exercise the real lazy loader, SHA-256 checks, searches and detail dialogs while disconnected. */
    private void checkOfflineReferenceCatalog() throws Exception {
        JSONObject reference = bundledJson("data/reference-manifest.json"),counts=reference.getJSONObject("counts");
        int species = counts.getInt("ima_species"),crystals=counts.getInt("species_with_records");
        int images = bundledJson("data/image-sources.json").getJSONArray("records").length();
        JSONArray photoAssets = bundledJson("data/reviewed-photo-assets.json").getJSONArray("assets");
        assertEquals(counts.getInt("source_image_records"),images);
        assertEquals(counts.getInt("local_reviewed_photos"),photoAssets.length());
        assertEquals("Reference collection should not delay mineral inference", "idle",
            evaluate("window.MineralReference && window.MineralReference.status"));
        evaluate(script(
            "(() => {const s=window.__shikuangRuntimeSmoke;s.phase='library-loading';s.catalogFetches=[];s.catalogPhotoFetches=[];",
            " const realFetch=window.fetch.bind(window);",
            " window.fetch=async(...args)=>{const response=await realFetch(...args);const url=new URL(args[0] instanceof Request?args[0].url:String(args[0]),location.href);if(/\\/data\\/(reference-manifest|catalog|crystals|image-sources)\\.json$/.test(url.pathname))s.catalogFetches.push({path:url.pathname,url:url.href,status:response.status,type:response.headers.get('content-type'),local:url.origin===location.origin});if(/\\/images\\/reviewed-v25\\/commons-\\d+\\.jpg$/.test(url.pathname))s.catalogPhotoFetches.push({path:url.pathname,url:url.href,status:response.status,local:url.origin===location.origin});return response;};",
            " document.querySelector('[data-view=library]').click();})()"
        ));
        awaitUi("window.MineralReference && window.MineralReference.status==='ready' && document.getElementById('catalogLoadState').textContent.includes('" + species + "')",
            species + "-species packaged reference collection", 60000);
        JSONObject catalog = new JSONObject(evaluate(script(
            "JSON.stringify({imaSpecies:MINERAL_CATALOG.minerals.length,crystalSpecies:Object.keys(MINERAL_CRYSTAL_RECORDS.by_species).length,imageReferences:MINERAL_IMAGE_SOURCES.records.length,completed:MineralReference.completed,online:navigator.onLine,cardsShown:document.querySelectorAll('#libraryList [data-detail]').length,intro:document.getElementById('catalogIntro').textContent,localFetches:window.__shikuangRuntimeSmoke.catalogFetches.length})"
        )));
        assertEquals(species, catalog.getInt("imaSpecies"));
        assertEquals(crystals, catalog.getInt("crystalSpecies"));
        assertEquals(images, catalog.getInt("imageReferences"));
        assertEquals(reference.getJSONArray("files").length(), catalog.getInt("completed"));
        assertEquals(80, catalog.getInt("cardsShown"));
        assertFalse("Catalog must load while WebView detects unavailable networking", catalog.getBoolean("online"));
        assertEquals("Opening the catalogue must not eagerly fetch specimen photos",0,state().getJSONArray("catalogPhotoFetches").length());
        assertTrue(catalog.getString("intro").contains(String.valueOf(images)));
        assertTrue(catalog.getString("intro").contains(String.valueOf(crystals)));
        JSONArray fetches = state().getJSONArray("catalogFetches");
        assertEquals("Manifest and all reference files must be read locally", 1+reference.getJSONArray("files").length(), fetches.length());
        for (int index = 0; index < fetches.length(); index++) {
            JSONObject request = fetches.getJSONObject(index);
            assertTrue("Reference request left packaged app origin: " + request, request.getBoolean("local"));
            assertEquals(200, request.getInt("status"));
        }
        assertEquals(state().getJSONObject("modelContract").getInt("labels"),Integer.parseInt(evaluate("Object.keys(MINERAL_CLASSES).length")));
        evaluate("window.__shikuangRuntimeSmoke.catalog=" + catalog + ";window.scrollTo({top:0,behavior:'instant'});");
        screenshot("library-offline-overview.png", "#catalogIntro");

        evaluate("const quartzSearch=document.getElementById('librarySearch');quartzSearch.value='Quartz';quartzSearch.dispatchEvent(new Event('input',{bubbles:true}));");
        awaitUi("document.querySelector('#libraryList [data-detail=quartz]')", "Quartz search card", 10000);
        evaluate("document.querySelector('#libraryList [data-detail=quartz]').click();");
        awaitUi("document.getElementById('detailDialog').open && document.getElementById('detailTitle').textContent==='石英'", "Quartz reference detail", 10000);
        assertTrue(evaluate("document.getElementById('detailBody').textContent").contains("Quartz"));
        assertTrue(evaluate("document.getElementById('detailBody').textContent").contains("官方目录字段"));
        assertTrue(evaluate("document.getElementById('crystalRecords').textContent").contains("空间群"));
        assertEquals("5", evaluate("document.querySelectorAll('#crystalRecords .crystal-record').length"));
        evaluate("document.getElementById('detailDialog').scrollTop=0;");
        assertEquals("Opening mineral facts must not fetch the closed photo section",0,state().getJSONArray("catalogPhotoFetches").length());
        screenshot("quartz-reference-details.png", "#detailTitle");
        evaluate(script(
            "document.querySelector('#detailBody .image-section').open=true;",
            "document.querySelector('#detailBody .image-section').scrollIntoView({block:'start',behavior:'instant'});",
            "window.__shikuangRuntimeSmoke.quartzReference={title:document.getElementById('detailTitle').textContent,crystalRecordsShown:document.querySelectorAll('#crystalRecords .crystal-record').length,imageRecordsTotal:MINERAL_IMAGE_SOURCES.records.filter(row=>row.mineral_name==='Quartz').length,imageRecordsShown:document.querySelectorAll('#imageRecords .image-record').length,imageEvidence:document.getElementById('imageRecords').textContent};"
        ));
        JSONObject quartzReference = state().getJSONObject("quartzReference");
        assertTrue("Packaged Quartz image-source metadata must be present", quartzReference.getInt("imageRecordsTotal") > 0);
        assertEquals(Math.min(5, quartzReference.getInt("imageRecordsTotal")), quartzReference.getInt("imageRecordsShown"));
        assertTrue(evaluate("document.getElementById('imageRecords').textContent").contains("不代表随包模型已训练本照片"));
        int quartzPhotoCount=Integer.parseInt(evaluate("Math.min(5,MINERAL_IMAGE_SOURCES.records.filter(row=>row.mineral_name==='Quartz'&&row.local_image_url).length)"));
        assertTrue("Reviewed Quartz reference photos must be included",quartzPhotoCount>0);
        JSONArray gallery = checkDecodedGalleryPhotos(quartzPhotoCount,"galleryPhotos");
        evaluate("document.querySelector('#imageRecords .reference-photo').scrollIntoView({block:'start',behavior:'instant'});");
        screenshot("quartz-image-references.png", "#imageRecords .reference-photo img");
        evaluate("document.getElementById('closeDetail').click();");
        evaluate(script(
            "(async()=>{const s=window.__shikuangRuntimeSmoke;try{await new Promise(resolve=>setTimeout(resolve,250));let revoked=0;",
            " for(const photo of s.galleryPhotos){let stillReadable=false;try{await fetch(photo.blobUrl);stillReadable=true;}catch(_){revoked++;}if(stillReadable)throw Error('Gallery blob survived dialog close');}",
            " s.galleryRevokedCount=revoked;s.phase='gallery-released';}catch(e){s.phase='failed';s.failure=String(e);}})();"
        ));
        assertEquals(gallery.length(),awaitPhase("gallery-released",10000).getInt("galleryRevokedCount"));
        evaluate("document.querySelector('#libraryList [data-detail=quartz]').click();");
        awaitUi("document.getElementById('detailDialog').open && document.getElementById('detailTitle').textContent==='石英'", "Quartz gallery reopen", 10000);
        evaluate("document.querySelector('#detailBody .image-section').open=true;");
        JSONArray reopened = checkDecodedGalleryPhotos(quartzPhotoCount,"galleryReopened");
        for(int i=0;i<reopened.length();i++)assertNotEquals(gallery.getJSONObject(i).getString("blobUrl"),reopened.getJSONObject(i).getString("blobUrl"));
        JSONArray photoFetches=state().getJSONArray("catalogPhotoFetches");
        for(int i=0;i<photoFetches.length();i++){
            JSONObject request=photoFetches.getJSONObject(i);
            assertTrue("Photo request left packaged origin",request.getBoolean("local"));assertEquals(200,request.getInt("status"));
            assertTrue("Photo request is missing SHA identity",request.getString("url").matches(".*[?&]image=[a-f0-9]{64}.*"));
        }
        evaluate("document.getElementById('closeDetail').click();const rareSearch=document.getElementById('librarySearch');rareSearch.value='Abellaite';rareSearch.dispatchEvent(new Event('input',{bubbles:true}));");
        awaitUi("document.querySelector('#libraryList [data-detail=\"catalog:ima-abellaite\"]')", "Abellaite search card", 10000);
        evaluate("document.querySelector('#libraryList [data-detail=\"catalog:ima-abellaite\"]').click();");
        awaitUi("document.getElementById('detailDialog').open && document.getElementById('detailTitle').textContent==='Abellaite'", "Abellaite reference detail", 10000);
        String rareDetails = evaluate("document.getElementById('detailBody').textContent");
        assertEquals("NaPb₂(CO₃)₂(OH)",evaluate("document.querySelector('#detailBody .formula').getAttribute('aria-label')"));
        assertEquals("true",evaluate("document.querySelectorAll('#detailBody .formula sub').length>0"));
        assertTrue(rareDetails.contains("2014-111"));
        assertTrue(rareDetails.contains("Spain"));
        assertTrue(rareDetails.contains("空间群"));
        assertFalse("Directory-only mineral must not claim model recognition", evaluate("document.getElementById('detailType').textContent").contains("图像模型支持"));
        evaluate("window.__shikuangRuntimeSmoke.abellaiteReference={title:document.getElementById('detailTitle').textContent,type:document.getElementById('detailType').textContent,details:document.getElementById('detailBody').textContent};document.getElementById('detailDialog').scrollTop=0;");
        screenshot("abellaite-reference-details.png", "#detailTitle");
        String finalRoutes4 = shellOutput("ip route show");
        String finalRoutes6 = shellOutput("ip -6 route show");
        assertFalse("IPv4 default route returned during catalog load", finalRoutes4.contains("default "));
        assertFalse("IPv6 default route returned during catalog load", finalRoutes6.contains("default "));
        JSONObject nativeNetwork = nativeNetworkState();
        assertTrue("Android gained an active network during catalog load: " + nativeNetwork, nativeNetwork.isNull("activeNetwork"));
        assertFalse(nativeNetwork.getBoolean("connected"));
        assertEquals("false", evaluate("navigator.onLine"));
        evaluate("window.__shikuangRuntimeSmoke.networkAfterCatalog={ipv4Routes:" + JSONObject.quote(finalRoutes4)
            + ",ipv6Routes:" + JSONObject.quote(finalRoutes6) + ",native:" + nativeNetwork + "};window.__shikuangRuntimeSmoke.phase='passed';");
    }

    @Test
    public void explicitlyMissingCapabilityRecoveryDoesNotReplaceProductAcceptance() throws Exception {
        scenario = ActivityScenario.launch(MainActivity.class);
        try {
            requireSupportedWebView();
            awaitPage();
            evaluate("window.__shikuangRuntimeSmoke={phase:'negative-seeding'};(async()=>{try{await SpecimenStore.put({id:'runtime-missing-capability-proof',key:'quartz',name:'恢复负例保留记录',rankings:[{key:'quartz',score:.5}]});window.__shikuangRuntimeSmoke.snapshot=JSON.stringify((await SpecimenStore.list()).find(r=>r.id==='runtime-missing-capability-proof'));window.__shikuangRuntimeSmoke.phase='negative-seeded';}catch(e){window.__shikuangRuntimeSmoke={phase:'failed',failure:String(e)};}})();");
            JSONObject seeded = awaitPhase("negative-seeded",15000);
            evaluate("(() => {const saved=window.AbortController;try{window.AbortController=undefined;window.__shikuangRuntimeSmoke.boot=MineralNativeAssets.boot(true);}finally{window.AbortController=saved;}})();");
            assertEquals("false",evaluate("window.__shikuangRuntimeSmoke.boot.supported"));
            assertEquals("true",evaluate("window.__shikuangRuntimeSmoke.boot.missing.indexOf('AbortController')>=0"));
            assertEquals("true",evaluate("!!document.getElementById('native-boot-recovery')"));
            assertTrue(evaluate("document.getElementById('native-boot-recovery').textContent").contains("本机标本和历史记录会保留"));
            screenshot("expected-missing-capability-recovery.png","#native-boot-recovery");
            scenario.recreate();
            requireSupportedWebView();
            awaitPage();
            evaluate("window.__shikuangRuntimeSmoke={phase:'negative-check'};(async()=>{try{const row=(await SpecimenStore.list()).find(r=>r.id==='runtime-missing-capability-proof');if(JSON.stringify(row)!=="+JSONObject.quote(seeded.getString("snapshot"))+")throw Error('History changed during expected recovery');window.__shikuangRuntimeSmoke={phase:'expected-missing-capability-recovery-verified',intentionalMissingCapability:'AbortController',historyPreserved:true,fullProductAcceptance:false};}catch(e){window.__shikuangRuntimeSmoke={phase:'failed',failure:String(e)};}})();");
            JSONObject proof = awaitPhase("expected-missing-capability-recovery-verified",15000);
            try (OutputStream stream = RuntimeTestOutput.open("missing-capability-recovery-report.json")) {
                stream.write(proof.toString(2).getBytes(StandardCharsets.UTF_8));
            }
        } finally {
            try {
                evaluate("window.__negativeCleanup=false;window.__negativeCleanupError=null;(async()=>{try{if(window.SpecimenStore){await SpecimenStore.remove('runtime-missing-capability-proof');if((await SpecimenStore.list()).some(r=>r.id==='runtime-missing-capability-proof'))throw Error('Negative fixture survived cleanup');}}catch(e){window.__negativeCleanupError=String(e);}finally{window.__negativeCleanup=true;}})();");
                awaitUi("window.__negativeCleanup===true","only negative-test fixture cleanup",10000);
                assertEquals("Negative fixture cleanup failed","null",evaluate("window.__negativeCleanupError"));
            } finally { scenario.close(); }
        }
    }

    @Test
    public void legacyNativeAssetMigrationPreservesSpecimens() throws Exception {
        scenario = ActivityScenario.launch(MainActivity.class);
        JSONObject seed = null;
        boolean pageReady = false;
        try {
            requireSupportedWebView();
            awaitPage();
            pageReady = true;
            evaluate(script(
                "window.__shikuangRuntimeSmoke={phase:'migration-start'};",
                "(async()=>{try{await MineralNativeAssets.prepare();await SpecimenStore.put({id:'runtime-migration-proof',key:'quartz',name:'迁移保留记录',rankings:[{key:'quartz',score:.5}]});",
                " let registrationSupported=false,registrationError=null;try{await Promise.race([navigator.serviceWorker.register('./sw.js').then(()=>navigator.serviceWorker.ready),new Promise((_,reject)=>setTimeout(()=>reject(Error('Native Worker registration exceeded 15 seconds')),15000))]);registrationSupported=true;}catch(e){registrationError=String(e);}",
                " const name=(await caches.keys()).find(n=>n.startsWith('shikuang-static-'))||'shikuang-static-runtime-migration-fixture';",
                " const cache=await caches.open(name),html='<!doctype html><html><head><title>旧缓存</title></head><body><p id=legacy-poison>cached legacy HTML without migration scripts</p></body></html>';",
                " await cache.put(new URL('./',location.href),new Response(html,{headers:{'content-type':'text/html'}}));await cache.put(new URL('index.html',location.href),new Response(html,{headers:{'content-type':'text/html'}}));",
                " await (await caches.open('runtime-unrelated-cache')).put(new URL('unrelated',location.href),new Response('keep'));",
                " window.__shikuangRuntimeSmoke={phase:'migration-seeded',registration_supported:registrationSupported,registration_error:registrationError,cacheSeeded:true};",
                " }catch(e){window.__shikuangRuntimeSmoke={phase:'failed',failure:String(e)};}})();"
            ));
            seed = awaitPhase("migration-seeded",60000);
            if (seed.getBoolean("registration_supported")) {
                long deadline = SystemClock.elapsedRealtime() + 15000;
                while (!"true".equals(evaluate("!!navigator.serviceWorker.controller")) && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(100);
                assertEquals("When registration is supported, a genuine legacy Worker must control the page before recreation", "true",evaluate("!!navigator.serviceWorker.controller"));
            }
            seed.put("controllerSeeded", "true".equals(evaluate("!!navigator.serviceWorker.controller")));
            evaluate("(async()=>{window.__shikuangRuntimeSmoke.fixtureStored=(await SpecimenStore.list()).some(r=>r.id==='runtime-migration-proof');window.__shikuangRuntimeSmoke.phase='migration-fixture-checked';})();");
            assertTrue(awaitPhase("migration-fixture-checked",10000).getBoolean("fixtureStored"));
            evaluate("(async()=>{window.__shikuangRuntimeSmoke.fixtureSnapshot=JSON.stringify((await SpecimenStore.list()).find(r=>r.id==='runtime-migration-proof'));window.__shikuangRuntimeSmoke.phase='migration-snapshot';})();");
            String fixtureSnapshot = awaitPhase("migration-snapshot",10000).getString("fixtureSnapshot");
            scenario.recreate();
            awaitPage();
            evaluate(script(
                "window.__shikuangRuntimeSmoke={phase:'migration-check'};",
                "(async()=>{try{await MineralNativeAssets.prepare();const records=await SpecimenStore.list(),names=await caches.keys(),registrations=await navigator.serviceWorker.getRegistrations();",
                " window.__shikuangRuntimeSmoke={phase:'migration-verified',historyPreserved:JSON.stringify(records.find(r=>r.id==='runtime-migration-proof'))==="+JSONObject.quote(fixtureSnapshot)+",controller:!!navigator.serviceWorker.controller,registrationCount:registrations.length,cacheNames:names,poisonedPage:!!document.getElementById('legacy-poison'),trustedMigration:window.__shikuangNativeAssetMigration};",
                " await SpecimenStore.remove('runtime-migration-proof');await caches.delete('runtime-unrelated-cache');window.__shikuangRuntimeSmoke.phase='migration-passed';",
                " }catch(e){window.__shikuangRuntimeSmoke={phase:'failed',failure:String(e)};}})();"
            ));
            JSONObject proof = awaitPhase("migration-passed",30000);
            proof.put("registration_supported", seed.getBoolean("registration_supported"));
            proof.put("registration_error", seed.opt("registration_error"));
            proof.put("controllerSeeded", seed.getBoolean("controllerSeeded"));
            proof.put("cacheSeeded", true);
            assertTrue(proof.toString(),proof.getBoolean("historyPreserved"));
            assertFalse(proof.getBoolean("poisonedPage"));
            assertFalse(proof.getBoolean("controller"));
            assertEquals(0,proof.getInt("registrationCount"));
            assertTrue(proof.getJSONArray("cacheNames").toString().contains("runtime-unrelated-cache"));
            assertFalse(proof.getJSONArray("cacheNames").toString().contains("shikuang-"));
            try (OutputStream stream = RuntimeTestOutput.open("asset-migration-report.json")) {
                stream.write(proof.toString(2).getBytes(StandardCharsets.UTF_8));
            }
        } finally {
            if (scenario != null) {
                // A failed probe must not leak its record into another test.
                // Delete only this test's explicit ID and its unrelated cache.
                try {
                    if (pageReady) {
                        evaluate("window.__migrationFixtureCleanup=false;window.__migrationFixtureCleanupError=null;(async()=>{try{if(window.SpecimenStore){await SpecimenStore.remove('runtime-migration-proof');if((await SpecimenStore.list()).some(r=>r.id==='runtime-migration-proof'))throw Error('Test fixture record survived cleanup');}if(window.caches)await caches.delete('runtime-unrelated-cache');}catch(e){window.__migrationFixtureCleanupError=String(e);}finally{window.__migrationFixtureCleanup=true;}})();");
                        long deadline=SystemClock.elapsedRealtime()+10000;
                        while(!"true".equals(evaluate("window.__migrationFixtureCleanup")) && SystemClock.elapsedRealtime()<deadline)SystemClock.sleep(100);
                        assertEquals("Migration fixture cleanup timed out", "true", evaluate("window.__migrationFixtureCleanup"));
                        assertEquals("Migration fixture cleanup failed", "null", evaluate("window.__migrationFixtureCleanupError"));
                    }
                } finally { scenario.close(); }
            }
        }
    }

    @Test
    public void offlinePackagedNativeRecognitionAndRecovery() throws Exception {
        scenario = ActivityScenario.launch(MainActivity.class);
        try {
            requireSupportedWebView();
            awaitPage();
            evaluate(script(
                "window.__shikuangRuntimeSmoke={phase:'started',fullOfflineProductVerified:false,photoRecognitionVerified:false,boot:window.__shikuangBootCapabilities,logs:[],errors:[],origin:location.origin,online:navigator.onLine,userAgent:navigator.userAgent,secureContext:isSecureContext,wasm:typeof WebAssembly,labels:Object.keys(MINERAL_CLASSES).length};",
                "const smoke=window.__shikuangRuntimeSmoke;smoke.visibleVersion=document.querySelector('.brand .version').textContent;",
                "smoke.initialReferenceRequests=performance.getEntriesByType('resource').filter(row=>/\\/data\\/(catalog|crystals|image-sources)\\.json(?:[?#]|$)|\\/images\\/reviewed-v25\\//.test(row.name)).map(row=>row.name);",
                "const log=(kind,value)=>{smoke.logs.push({kind,value:String(value)});if(smoke.logs.length>60)smoke.logs.shift();};",
                "addEventListener('error',e=>smoke.errors.push({message:e.message,file:e.filename,line:e.lineno,column:e.colno}));",
                "addEventListener('unhandledrejection',e=>smoke.errors.push({rejection:String(e.reason)}));",
                "for(const level of ['log','warn','error']){const original=console[level].bind(console);console[level]=(...args)=>{log(level,args.join(' '));original(...args);};}",
                "const NativeWorker=window.Worker;",
                "if(NativeWorker){window.Worker=function(...args){try{const worker=new NativeWorker(...args);worker.addEventListener('error',e=>smoke.errors.push({worker:args[0].toString(),message:e.message,file:e.filename,line:e.lineno,column:e.colno}));return worker;}catch(e){smoke.errors.push({workerConstructor:String(e)});throw e;}};window.Worker.prototype=NativeWorker.prototype;Object.setPrototypeOf(window.Worker,NativeWorker);}",
                "window.__smokeRealAnalyze=MineralEngine.analyze.bind(MineralEngine);",
                "MineralEngine.analyze=async(...args)=>{try{const r=await window.__smokeRealAnalyze(...args);smoke.lastResult={key:r.key,modelCount:r.modelCount,engine:r.engine,score:r.score,status:r.status,modelVersion:r.modelVersion,manifestSha256:r.manifestSha256,diagnostics:r.diagnostics};return r;}catch(e){smoke.lastError={name:e.name,message:e.message};throw e;}};",
                "(async()=>{try{",
                " smoke.resources=[];",
                " for(const path of ['engine-worker.js','core.js','vendor/ort.min.js','vendor/ort-wasm-simd-threaded.mjs','vendor/ort-wasm-simd-threaded.wasm','model-manifest.json']){const r=await fetch(new URL(path,location.href));smoke.resources.push({path,status:r.status,type:r.headers.get('content-type')});if(!r.ok)throw new Error(path+' status '+r.status);if(/\\.(?:m?js)$/.test(path)&&!/(?:javascript|ecmascript)/.test(r.headers.get('content-type')||''))throw new Error(path+' wrong script MIME');await r.arrayBuffer();}",
                " smoke.wasmPlatform={webAssembly:typeof WebAssembly==='object',sharedArrayBuffer:typeof SharedArrayBuffer==='function',bigInt:typeof BigInt==='function',simd:false,sharedMemory:false,inferenceVerified:false};",
                // Use the shipped ORT vendor's SIMD validation bytes, not a fake feature flag.
                " try{smoke.wasmPlatform.simd=WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,10,30,1,28,0,65,0,253,15,253,12,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,253,186,1,26,11]));}catch(e){smoke.wasmPlatform.simdError=String(e);}",
                " try{const memory=new WebAssembly.Memory({initial:1,maximum:1,shared:true});smoke.wasmPlatform.sharedMemory=typeof SharedArrayBuffer==='function' && memory.buffer instanceof SharedArrayBuffer;}catch(e){smoke.wasmPlatform.sharedMemoryError=String(e);}",
                " smoke.workerProbe={status:'unavailable',bootstrapOnly:true,wasmInferenceVerified:false};",
                " if(NativeWorker){await new Promise(resolve=>{let worker,settled=false;const finish=probe=>{if(settled)return;settled=true;smoke.workerProbe=Object.assign({bootstrapOnly:true,wasmInferenceVerified:false},probe);clearTimeout(timer);if(worker)worker.terminate();resolve();};const timer=setTimeout(()=>finish({status:'timeout',timeoutMs:15000}),15000);try{worker=new Worker(new URL('engine-worker.js',location.href));worker.onerror=e=>finish({status:'error',message:e.message,file:e.filename,line:e.lineno,column:e.colno});worker.onmessage=e=>finish({status:'message',message:e.data});}catch(e){finish({status:'constructor-error',message:String(e)});}});}",
                " if(smoke.workerProbe.status!=='message'||!smoke.workerProbe.message||smoke.workerProbe.message.type!=='ready')throw new Error('Worker bootstrap did not emit ready: '+JSON.stringify(smoke.workerProbe));",
                " const config=await MineralEngine.prepare();smoke.modelContract={modelVersion:config.version,labels:config.labels.length,ensembleIds:config.modes.ensemble,fastIds:config.modes.fast,input:config.input};",
                " smoke.phase='resources';",
                " }catch(e){smoke.phase='failed';smoke.failure=String(e);}})();"
            ));
            JSONObject resources = awaitPhase("resources", 60000);
            assertTrue(resources.getJSONObject("boot").getBoolean("supported"));
            assertEquals("message",resources.getJSONObject("workerProbe").getString("status"));
            assertEquals("ready",resources.getJSONObject("workerProbe").getJSONObject("message").getString("type"));
            assertTrue(resources.getJSONObject("workerProbe").getBoolean("bootstrapOnly"));
            assertFalse("Worker import success is not browser WASM inference",resources.getJSONObject("wasmPlatform").getBoolean("inferenceVerified"));
            evaluate("(() => {const ids=['cameraBtn','videoBtn','galleryBtn'],rects=ids.map(id=>{const e=document.getElementById(id),r=e.getBoundingClientRect();if(!e||r.width<=0||r.height<=0||e.disabled)throw Error('Input entry unavailable: '+id);return {id,left:r.left,right:r.right,top:r.top,bottom:r.bottom};});for(let i=0;i<rects.length;i++)for(let j=i+1;j<rects.length;j++){const a=rects[i],b=rects[j];if(Math.min(a.right,b.right)>Math.max(a.left,b.left)&&Math.min(a.bottom,b.bottom)>Math.max(a.top,b.top))throw Error('Input buttons overlap');}if(!document.getElementById('fileInput').accept.includes('image/')||!document.getElementById('videoFileInput').accept.includes('video/'))throw Error('Photo and video inputs are not distinct');window.__shikuangRuntimeSmoke.inputEntrypoints=rects;})();");
            assertEquals(3,state().getJSONArray("inputEntrypoints").length());
            assertEquals("Startup must not fetch the large reference JSON or specimen photos",0,resources.getJSONArray("initialReferenceRequests").length());
            assertEquals("2.5",resources.getString("visibleVersion"));
            JSONObject contract = resources.getJSONObject("modelContract");
            assertEquals(bundledJson("model-manifest.json").getJSONArray("labels").length(),resources.getInt("labels"));
            assertEquals(contract.getInt("labels"),resources.getInt("labels"));
            int expectedModels = contract.getJSONArray("ensembleIds").length();
            assertTrue(expectedModels >= 2 && expectedModels <= 3);
            assertEquals(1,contract.getJSONArray("fastIds").length());
            assertTrue("Packaged app origin must be secure", resources.getBoolean("secureContext"));
            String routes4 = shellOutput("ip route show");
            String routes6 = shellOutput("ip -6 route show");
            JSONObject nativeNetwork = nativeNetworkState();
            evaluate("window.__shikuangRuntimeSmoke.network={ipv4Routes:" + JSONObject.quote(routes4)
                + ",ipv6Routes:" + JSONObject.quote(routes6) + ",native:" + nativeNetwork + "};");
            assertFalse("External IPv4 default route remains active: " + routes4, routes4.contains("default "));
            assertFalse("External IPv6 default route remains active: " + routes6, routes6.contains("default "));
            assertTrue("Android must report no active network: " + nativeNetwork, nativeNetwork.isNull("activeNetwork"));
            assertFalse(nativeNetwork.getBoolean("connected"));
            String expectedPageSize = InstrumentationRegistry.getArguments().getString("expectedPageSize");
            if (expectedPageSize != null) assertEquals("Native libc page size must match the selected official system image",
                Long.parseLong(expectedPageSize), nativeNetwork.getLong("pageSize"));
            assertFalse("WebView should detect unavailable networking", resources.getBoolean("online"));
            Log.i(TAG, "Worker ready verified separately from WASM platform support; native photo inference is required: " + resources);

            checkPhotoGeometry();

            String quartz = fixture("quartz.jpg");
            evaluate(script(
                "window.__shikuangRuntimeSmoke.phase='cancelling';",
                "(async()=>{const s=window.__shikuangRuntimeSmoke,c=new AbortController();const timer=setTimeout(()=>{s.cancelTrigger='deadline';c.abort();},30000);try{",
                " await window.__smokeRealAnalyze([{src:" + JSONObject.quote(quartz) + ",crop:1}],{precision:true,signal:c.signal,report:message=>{s.logs.push({kind:'cancel-progress',value:message});if(/输入筛查|读取|初始化|分析图像/.test(message)&&!c.signal.aborted){s.cancelTrigger='native-progress';c.abort();}}});",
                " s.phase='failed';s.failure='Cancelled native inference unexpectedly resolved';",
                " }catch(e){s.cancelError={name:e.name,message:e.message};s.phase=e.name==='AbortError'?'cancelled':'failed';if(s.phase==='failed')s.failure=String(e);}finally{clearTimeout(timer);}})();"
            ));
            JSONObject cancellation = awaitPhase("cancelled", 180000);
            assertEquals("native-progress", cancellation.getString("cancelTrigger"));
            assertEquals("AbortError", cancellation.getJSONObject("cancelError").getString("name"));

            submitFixture(quartz, "quartz.jpg");
            assertEquals("true",evaluate("!document.getElementById('preview').hidden && document.getElementById('captureEmpty').hidden"));
            // Click the real control synchronously during this native progress
            // callback. A Java polling round-trip could miss a fast completion.
            evaluate(script(
                "(() => {const s=window.__shikuangRuntimeSmoke,real=MineralEngine.analyze;delete s.lastError;delete s.lastResult;s.uiCancelAttempt={clicked:false};",
                " MineralEngine.analyze=function(photos,options){MineralEngine.analyze=real;const report=options.report;return real(photos,Object.assign({},options,{report:function(message,...rest){",
                " if(report)report(message,...rest);const button=document.getElementById('cancelBtn');if(!s.uiCancelAttempt.clicked&&/输入筛查|读取|初始化|分析图像/.test(message)&&!options.signal.aborted&&button&&!button.hidden&&!button.disabled){",
                " s.uiCancelAttempt={clicked:true,trigger:'native-progress',message:String(message),signalWasRunning:true,buttonWasVisible:true};button.click();s.uiCancelAttempt.signalAborted=options.signal.aborted;}",
                " }}));};document.getElementById('precision').checked=true;document.getElementById('predictBtn').click();})();"
            ));
            awaitUi("window.__shikuangRuntimeSmoke.uiCancelAttempt.clicked && window.__shikuangRuntimeSmoke.uiCancelAttempt.signalAborted && window.__shikuangRuntimeSmoke.lastError && window.__shikuangRuntimeSmoke.lastError.name==='AbortError' && !window.__shikuangRuntimeSmoke.lastResult && !document.getElementById('predictBtn').disabled && !document.getElementById('preview').hidden && document.getElementById('cancelBtn').hidden && document.getElementById('progress').textContent==='分析已停止，照片已保留。'",
                "UI cancellation to retain photo and release retry",30000);
            assertEquals("native-progress",state().getJSONObject("uiCancelAttempt").getString("trigger"));
            evaluate("window.__shikuangRuntimeSmoke.uiCancelRetry={cancelled:true,photoRetained:true,retried:false};delete window.__shikuangRuntimeSmoke.lastError;delete window.__shikuangRuntimeSmoke.lastResult;");
            evaluate("window.__shikuangRuntimeSmoke.phase='quartz-ui';document.getElementById('precision').checked=true;document.getElementById('predictBtn').click();");
            long deadline = SystemClock.elapsedRealtime() + 180000;
            JSONObject quartzState = null;
            do {
                quartzState = state();
                if (quartzState.has("lastError")) fail(quartzState.toString());
                if (quartzState.has("lastResult") && "true".equals(evaluate("!document.getElementById('result').hidden && !document.getElementById('predictBtn').disabled"))) break;
                SystemClock.sleep(150);
            } while (SystemClock.elapsedRealtime() < deadline);
            assertNotNull(quartzState);
            assertTrue("Quartz result timed out: " + quartzState, quartzState.has("lastResult"));
            JSONObject result = quartzState.getJSONObject("lastResult");
            assertEquals("quartz", result.getString("key"));
            assertEquals(expectedModels, result.getInt("modelCount"));
            assertEquals("onnx-native-android", result.getString("engine"));
            assertEquals(contract.getString("modelVersion"),result.getString("modelVersion"));
            assertTrue(result.getString("manifestSha256").matches("[a-f0-9]{64}"));
            assertTrue(result.getJSONObject("diagnostics").getLong("elapsedMs") > 0);
            assertTrue(result.getJSONObject("diagnostics").getInt("residentSessionCount") <= expectedModels+1);
            assertEquals("石英", evaluate("document.getElementById('resultHeading').textContent"));
            evaluate("window.__shikuangRuntimeSmoke.uiCancelRetry.retried=true;");
            evaluate("document.getElementById('result').scrollIntoView({block:'start',behavior:'instant'});");
            screenshot("quartz-result.png", "#resultHeading");

            evaluate(script(
                "(async()=>{const s=window.__shikuangRuntimeSmoke;s.phase='fast-running';try{const r=await window.__smokeRealAnalyze([{src:"+JSONObject.quote(quartz)+",crop:1}],{precision:false});s.fast={key:r.key,modelCount:r.modelCount,modelVersion:r.modelVersion,manifestSha256:r.manifestSha256,engine:r.engine,diagnostics:r.diagnostics};s.phase='fast-passed';}catch(e){s.phase='failed';s.failure=String(e);}})();"
            ));
            JSONObject fast = awaitPhase("fast-passed",180000).getJSONObject("fast");
            assertEquals(1,fast.getInt("modelCount"));
            assertEquals("onnx-native-android",fast.getString("engine"));
            assertEquals(result.getString("modelVersion"),fast.getString("modelVersion"));
            assertEquals(result.getString("manifestSha256"),fast.getString("manifestSha256"));
            assertTrue("Fast mode must release unselected resident classifiers",fast.getJSONObject("diagnostics").getInt("residentSessionCount") <= 2);

            evaluate("document.getElementById('saveBtn').click();");
            deadline = SystemClock.elapsedRealtime() + 30000;
            boolean saved = false;
            do {
                saved = "true".equals(evaluate("!document.getElementById('saveBtn').disabled && document.getElementById('saveBtn').textContent.includes('更新标本')"));
                if (saved) break;
                SystemClock.sleep(100);
            } while (SystemClock.elapsedRealtime() < deadline);
            assertTrue("Quartz record was not saved; preserve the draft instead of starting a new sample", saved);
            evaluate("(async()=>{const s=window.__shikuangRuntimeSmoke;s.savedRecords=(await SpecimenStore.list()).map(r=>({id:r.id,key:r.key,modelCount:r.modelCount,photoCount:r.photoCount,modelVersion:r.modelVersion,manifestSha256:r.manifestSha256}));s.phase='quartz-saved';})();");
            JSONArray savedRecords = awaitPhase("quartz-saved", 30000).getJSONArray("savedRecords");
            assertEquals(1, savedRecords.length());
            assertEquals("quartz", savedRecords.getJSONObject(0).getString("key"));
            assertEquals(expectedModels, savedRecords.getJSONObject(0).getInt("modelCount"));
            assertEquals(result.getString("modelVersion"),savedRecords.getJSONObject(0).getString("modelVersion"));
            assertEquals(result.getString("manifestSha256"),savedRecords.getJSONObject(0).getString("manifestSha256"));
            assertEquals(1, savedRecords.getJSONObject(0).getInt("photoCount"));

            evaluate("window.__shikuangRuntimeSmoke.quartz=window.__shikuangRuntimeSmoke.lastResult;delete window.__shikuangRuntimeSmoke.lastResult;delete window.__shikuangRuntimeSmoke.lastError;document.getElementById('newSample').click();");
            submitFixture(fixture("dog.jpg"), "dog.jpg");
            evaluate("document.getElementById('predictBtn').click();");
            deadline = SystemClock.elapsedRealtime() + 180000;
            JSONObject dogState;
            do {
                dogState = state();
                if (dogState.has("lastError") && "true".equals(evaluate("!document.getElementById('predictBtn').disabled"))) break;
                SystemClock.sleep(150);
            } while (SystemClock.elapsedRealtime() < deadline);
            assertTrue("Dog rejection timed out: " + dogState, dogState.has("lastError"));
            assertEquals(NON_MINERAL, dogState.getJSONObject("lastError").getString("message"));
            assertEquals(NON_MINERAL, evaluate("document.getElementById('progress').textContent"));
            assertEquals("true", evaluate("document.getElementById('result').hidden"));
            evaluate("document.getElementById('progress').scrollIntoView({block:'center',behavior:'instant'});");
            screenshot("dog-rejection.png", "#progress");
            evaluate("(async()=>{const s=window.__shikuangRuntimeSmoke;s.recordsAfterRejection=(await SpecimenStore.list()).map(r=>({id:r.id,key:r.key,modelCount:r.modelCount}));s.phase='passed';})();");
            JSONArray preserved = awaitPhase("passed", 30000).getJSONArray("recordsAfterRejection");
            assertEquals("Non-mineral rejection must not add or delete a specimen record", 1, preserved.length());
            assertEquals(savedRecords.getJSONObject(0).getString("id"), preserved.getJSONObject(0).getString("id"));
            assertEquals("quartz", preserved.getJSONObject(0).getString("key"));
            assertEquals(expectedModels, preserved.getJSONObject(0).getInt("modelCount"));
            checkOfflineReferenceCatalog();
            checkHistoryAfterActivityRecreate(savedRecords.getJSONObject(0).getString("id"));
            captureColdProcessBaseline(savedRecords.getJSONObject(0).getString("id"));
        } finally {
            writeDiagnostics();
            scenario.close();
        }
    }
}
