package com.shikuang.app;

import static org.junit.Assert.*;

import android.os.Bundle;
import android.os.Process;
import android.os.SystemClock;
import android.util.Base64;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Host-selected second phase. Never seeds data or inherits the first phase's tests. */
@RunWith(AndroidJUnit4.class)
public class ColdProcessHistoryInstrumentedTest {
    @Test
    public void existingUiRecordAfterHostForceStop() throws Exception {
        Bundle arguments = InstrumentationRegistry.getArguments();
        assertEquals("Cold test must be explicitly selected by the host", "verify-existing-after-force-stop", arguments.getString("coldProcessPhase"));
        assertEquals("true",arguments.getString("useTestStorageService"));
        String encoded = arguments.getString("coldProcessExpected");
        assertNotNull("Previous actual UI report is required; no implicit seed",encoded);
        assertTrue(encoded.length() <= 16384 && encoded.matches("[A-Za-z0-9+/]+={0,2}"));
        JSONObject expected = new JSONObject(new String(Base64.decode(encoded,Base64.DEFAULT),StandardCharsets.UTF_8));
        JSONObject baseline = expected.getJSONObject("baseline");
        String nonce = expected.getString("nonce"), sourceSha = expected.getString("sourceReportSha256");
        assertTrue(nonce.matches("[a-f0-9]{32}")); assertTrue(sourceSha.matches("[a-f0-9]{64}"));
        int beforePid = expected.getInt("beforePid"), actualPid = Process.myPid();
        assertTrue(beforePid > 0 && actualPid > 0 && actualPid != beforePid);
        assertEquals("real-ui-native-three-model-record",baseline.getString("source"));
        assertTrue(baseline.getInt("firstPhasePid") > 0);
        MineralEngineInstrumentedTest ui = new MineralEngineInstrumentedTest();
        JSONObject report = new JSONObject().put("schema","android-cold-process-ui-history-v1")
            .put("phase","cold-process-history-started").put("passed",false)
            .put("nonce",nonce).put("sourceReportSha256",sourceSha)
            .put("firstPhasePid",baseline.getInt("firstPhasePid")).put("hostBeforePid",beforePid)
            .put("actualProcessPid",actualPid).put("startedElapsedRealtimeMs",SystemClock.elapsedRealtime());
        try {
            ui.scenario = ActivityScenario.launch(MainActivity.class);
            ui.requireSupportedWebView(); ui.awaitPage();
            JSONObject beforeNetwork = ui.nativeNetworkState();
            assertEquals(expected.getInt("expectedSdk"),beforeNetwork.getInt("sdk"));
            assertEquals(expected.getLong("expectedPageSize"),beforeNetwork.getLong("pageSize"));
            assertEquals("com.shikuang.app.preview",beforeNetwork.getString("packageName"));
            assertTrue(beforeNetwork.isNull("activeNetwork")); assertFalse(beforeNetwork.getBoolean("connected"));
            assertFalse(beforeNetwork.getBoolean("internetCapability"));
            assertEquals("false",ui.evaluate("navigator.onLine"));
            assertEquals(baseline.getString("origin"),ui.evaluate("location.origin"));
            report.put("networkBefore",beforeNetwork).put("navigatorOnlineBefore",false);
            ui.evaluate(MineralEngineInstrumentedTest.script(
                "window.__shikuangRuntimeSmoke={phase:'cold-reading',screenshots:[]};",
                "(async()=>{const s=window.__shikuangRuntimeSmoke;try{const rows=await SpecimenStore.list(),row=rows.find(r=>r.id==="+JSONObject.quote(baseline.getString("recordId"))+");",
                " if(rows.length!==1||!row)throw Error('Previously UI-saved record missing after force-stop');",
                " s.recordSnapshot=JSON.stringify(row);s.searchSnapshot=JSON.stringify(SearchHistory.read());s.recordCount=rows.length;s.phase='cold-read';",
                " }catch(e){s.phase='failed';s.failure=String(e);}})();"
            ));
            JSONObject read = ui.awaitPhase("cold-read",15000);
            JSONObject actual = RuntimeHistoryEvidence.identity(read.getString("recordSnapshot"),read.getString("searchSnapshot"));
            for (String key : new String[]{"recordId","recordSnapshotSha256","searchSnapshotSha256","modelVersion","manifestSha256"}) assertEquals("Persisted "+key+" changed",baseline.getString(key),actual.getString(key));
            for (String key : new String[]{"photoDataUrlSha256s","photoByteSha256s"}) assertEquals(baseline.getJSONArray(key).toString(),actual.getJSONArray(key).toString());
            assertEquals(1,read.getInt("recordCount")); assertEquals(1,actual.getInt("photoCount")); assertEquals(3,actual.getInt("modelCount"));
            report.put("actualIdentity",actual).put("recordUnchanged",true).put("searchHistoryUnchanged",true);
            // Read-only UI navigation: no save, import, put, search resubmission or inference.
            ui.evaluate("document.querySelector('[data-view=records]').click();");
            ui.awaitUi("!document.getElementById('view-records').hidden && document.querySelectorAll('#recordList [data-record]').length===1 && document.getElementById('recordSearchHistory').textContent.includes('石英')","previous history/search UI after cold process launch",15000);
            ui.screenshot("cold-process-records.png","#recordList");
            // Check the real legacy WebView, not only a desktop CSS simulation.
            JSONObject navigation = new JSONObject(ui.evaluate(MineralEngineInstrumentedTest.script(
                "JSON.stringify((()=>{const nav=document.querySelector('.bottom-nav');if(!nav)throw Error('Navigation missing');",
                " const bounds=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};",
                " const r=bounds(nav),css=getComputedStyle(nav),links=Array.from(nav.querySelectorAll('a')),expected=Math.min(innerWidth,1120);",
                " if(css.display==='none'||links.length!==4||Math.abs(r.width-expected)>2||Math.abs(r.left-(innerWidth-expected)/2)>2||r.bottom>innerHeight+2)throw Error('Navigation width or placement differs');",
                " const columns=links.map(a=>{const q=bounds(a),label=a.querySelector('span');if(!label)throw Error('Navigation label missing');const t=bounds(label);if(q.width<44||q.height<44||t.left<q.left-1||t.right>q.right+1)throw Error('Navigation target or label clipped');return {href:a.getAttribute('href'),label:label.textContent.trim(),rect:q,labelRect:t};});",
                " if(Math.max(...columns.map(c=>c.rect.width))-Math.min(...columns.map(c=>c.rect.width))>2)throw Error('Navigation columns unequal');",
                " for(let i=1;i<columns.length;i++)if(columns[i].rect.left<columns[i-1].rect.right-1)throw Error('Navigation columns overlap');",
                " return {passed:true,viewport:{width:innerWidth,height:innerHeight},rect:r,columns};})())"
            )));
            assertTrue(navigation.getBoolean("passed"));
            report.put("navigationLayout",navigation);
            ui.evaluate("Array.from(document.querySelectorAll('#recordList [data-record]')).find(e=>e.dataset.record==="+JSONObject.quote(baseline.getString("recordId"))+").click();");
            ui.awaitUi("document.getElementById('recordDialog').open && document.querySelector('#recordBody img') && document.querySelector('#recordBody img').complete && document.querySelector('#recordBody img').naturalWidth>0","actual persisted photo after cold process launch",15000);
            ui.evaluate(MineralEngineInstrumentedTest.script(
                "(async()=>{const s=window.__shikuangRuntimeSmoke;try{const image=document.querySelector('#recordBody img'),r=await fetch(image.currentSrc||image.src),b=await r.arrayBuffer();",
                " if(b.byteLength===0||b.byteLength>2097152)throw Error('Displayed stored photo exceeds evidence bounds');",
                " s.displayedPhotoSha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),v=>v.toString(16).padStart(2,'0')).join('');s.phase='cold-photo-read';",
                " }catch(e){s.phase='failed';s.failure=String(e);}})();"
            ));
            JSONObject photo = ui.awaitPhase("cold-photo-read",15000);
            assertEquals(baseline.getJSONArray("photoByteSha256s").getString(0),photo.getString("displayedPhotoSha256"));
            ui.screenshot("cold-process-record-detail.png","#recordBody");
            ui.evaluate(MineralEngineInstrumentedTest.script(
                "(async()=>{const s=window.__shikuangRuntimeSmoke;try{const rows=await SpecimenStore.list(),row=rows.find(r=>r.id==="+JSONObject.quote(baseline.getString("recordId"))+");",
                " if(rows.length!==1||!row)throw Error('Persisted row changed while opening history UI');",
                " s.afterUiRecordSnapshot=JSON.stringify(row);s.afterUiSearchSnapshot=JSON.stringify(SearchHistory.read());s.phase='cold-after-ui-read';",
                " }catch(e){s.phase='failed';s.failure=String(e);}})();"
            ));
            JSONObject afterUi = ui.awaitPhase("cold-after-ui-read",15000);
            JSONObject afterUiIdentity = RuntimeHistoryEvidence.identity(afterUi.getString("afterUiRecordSnapshot"),afterUi.getString("afterUiSearchSnapshot"));
            assertEquals(actual.toString(),afterUiIdentity.toString());
            JSONObject afterNetwork = ui.nativeNetworkState();
            assertTrue(afterNetwork.isNull("activeNetwork")); assertFalse(afterNetwork.getBoolean("connected"));
            assertFalse(afterNetwork.getBoolean("internetCapability")); assertEquals("false",ui.evaluate("navigator.onLine"));
            JSONObject drawn = new JSONObject(ui.evaluate("JSON.stringify(window.__shikuangRuntimeSmoke)"));
            report.put("displayedPhotoSha256",photo.getString("displayedPhotoSha256")).put("photoDecodedInActualUi",true)
                .put("afterUiIdentity",afterUiIdentity)
                .put("screenshots",drawn.getJSONArray("screenshots")).put("networkAfter",afterNetwork)
                .put("navigatorOnlineAfter",false).put("coldProcessUiReadVerified",true)
                .put("passed",true).put("phase","cold-process-history-passed");
        } catch (Exception error) {
            report.put("phase","cold-process-history-failed").put("failure",error.toString()); throw error;
        } catch (AssertionError error) {
            report.put("phase","cold-process-history-failed").put("failure",error.toString()); throw error;
        } finally {
            report.put("finishedElapsedRealtimeMs",SystemClock.elapsedRealtime());
            try (OutputStream output = RuntimeTestOutput.open("cold-process-report.json")) { output.write(report.toString(2).getBytes(StandardCharsets.UTF_8)); }
            finally { if (ui.scenario != null) ui.scenario.close(); }
        }
    }
}
