import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

ROOT=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('collector',ROOT/'collect_memoryinfra.py')
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)

class CollectionTests(unittest.TestCase):
    def setUp(self):
        self.expected=c.contract('b'*40,'a'*32,'native-inference-only',1234,'AP3A.241005.015')
    def row(self,index,event='before-launch',payload=None):
        return {'schema':'memoryinfra-stage-v1','sequence':index,'nonce':'a'*32,'arm':'native-inference-only',
                'sourceCommit':'b'*40,'baseAppSource':c.BASE,'pid':1234,'buildId':'AP3A.241005.015',
                'elapsedRealtimeNanos':index*2_000_000_000+1,'event':event,'payload':payload or {},
                'nativeHeapAllocated':1,'nativeHeapSize':2,'nativeHeapFree':1,'javaHeapUsed':2,'rssKiB':10}
    def archive(self,entries):
        out=io.BytesIO()
        with tarfile.open(fileobj=out,mode='w') as t:
            for name,data,kind in entries:
                info=tarfile.TarInfo(name);info.size=len(data);info.type=kind;t.addfile(info,io.BytesIO(data) if kind==tarfile.REGTYPE else None)
        return out.getvalue()
    def path(self,index):return 'memoryinfra-diagnostic-'+'a'*32+'/native-inference-only/%03d.json'%index
    def successful_rows(self,arm):
        analysis={'key':'quartz','engine':'onnx-native-android','modelCount':3,'modelVersion':'inherited-2.0-audited','manifestSha256':'ddbe27e79489df0ff63647b37c17f701e458a59e076df14d47d93873085ae7fa','elapsedMs':99}
        paths=['/data/reference-manifest.json','/data/catalog.json','/data/crystals.json','/data/image-sources.json']
        refs=[] if arm=='native-inference-only' else [{'path':p,'local':True,'status':200} for p in paths]
        snapshot={'loader':'idle' if arm=='native-inference-only' else 'ready','online':False,'photoRequests':0,'analysisCalls':0 if arm=='catalog-detail-only' else 1,'analysis':None if arm=='catalog-detail-only' else analysis,'analysisError':None,'libraryClicks':1 if arm=='catalog-detail-only' else 0,'libraryHidden':arm!='catalog-detail-only','requests':refs,'resultVisible':True,'predictEnabled':True,'dialogOpen':arm!='native-inference-only','referenceResources':0 if arm=='native-inference-only' else 4,'title':'石英','hasOfficialFields':True,'loadingMessage':False,'bookSections':3,'totalBookStatements':190,'books':11,'primarySpecies':6239,'galleryPresent':True,'galleryClosed':True}
        sequence=[('before-launch',{}),('original-ready',{'sdk':35,'pageSize':16384,'providerPackage':'com.google.android.webview','providerVersion':'124.0.6367.219','providerVersionCode':636771938,'reloadCount':0,'loader':'idle','activeNetwork':None,'connected':False}),('before-journal-reload',{'reloadCount':1}),('reloaded-ready',{'reloadCount':1}),('observer-installed',{})]
        if arm!='catalog-detail-only':sequence += [('analysis-start',{'calls':1}),('analysis-return',analysis)]
        if arm!='native-inference-only':
            for ref in refs:sequence += [('reference-start',{'path':ref['path'],'local':True}),('reference-return',ref)]
        sequence += [('action-ready',dict(snapshot))]
        sequence += [('observation-sample',{**snapshot,'index':i,'observationElapsedMs':i*2000}) for i in range(15)]
        sequence += [('observation-complete',{**snapshot,'observationElapsedMs':30000,'requestedObservationMs':30000,'samples':15,'productAcceptance':False,'reloadCount':1})]
        result=[]
        for i,(event,payload) in enumerate(sequence):
            row=self.row(i,event,payload);row['arm']=arm;result.append(row)
        return result
    def success_instrument(self):
        return ('INSTRUMENTATION_STATUS: numtests=1\nINSTRUMENTATION_STATUS: class='+c.CLASS+'\nINSTRUMENTATION_STATUS: test=observeArm\nOK (1 test)\nINSTRUMENTATION_CODE: -1\n').encode()
    def test_three_real_shape_synthetic_arms_and_mislabel_rejection(self):
        for arm in c.ARMS:
            rows=self.successful_rows(arm)
            self.assertTrue(c.assess(rows,[],self.success_instrument())['diagnostic_observation_complete'])
            index=next(i for i,r in enumerate(rows) if r['event']=='action-ready')
            rows[index]['payload']['analysisCalls']=88
            self.assertFalse(c.assess(rows,[],self.success_instrument())['diagnostic_observation_complete'])
    def test_native_return_drift_and_wrong_metadata_path_rejected(self):
        rows=self.successful_rows('native-inference-only')
        index=next(i for i,r in enumerate(rows) if r['event']=='analysis-return')
        rows[index]['payload']={**rows[index]['payload'],'key':'dog'}
        self.assertFalse(c.assess(rows,[],self.success_instrument())['diagnostic_observation_complete'])
        rows=self.successful_rows('catalog-detail-only')
        for row in rows:
            if row['event'] in ('reference-start','reference-return'):row['payload']={**row['payload'],'path':'/wrong.json'}
        self.assertFalse(c.assess(rows,[],self.success_instrument())['diagnostic_observation_complete'])
    def test_fixed_contract_rejects_old_source_and_path_input(self):
        for source,nonce,arm in [(c.BASE,'a'*32,'native-inference-only'),('b'*40,'../x','native-inference-only'),('b'*40,'a'*32,'../../bad')]:
            with self.assertRaises(ValueError):c.contract(source,nonce,arm,1,'BUILD')
    def test_preserves_partial_instead_of_pass(self):
        raw=self.archive([(self.path(0),json.dumps(self.row(0)).encode(),tarfile.REGTYPE)])
        files,rows,errors=c.parse_archive(raw,self.expected);self.assertEqual(len(rows),1);self.assertFalse(c.assess(rows,errors,b'')['diagnostic_observation_complete'])
    def test_detects_bound_pid_drift(self):
        row=self.row(0);row['pid']=999
        _,rows,errors=c.parse_archive(self.archive([(self.path(0),json.dumps(row).encode(),tarfile.REGTYPE)]),self.expected)
        self.assertFalse(rows);self.assertEqual(len(errors),1)
    def test_rejects_path_traversal_symlink_duplicate_and_gap(self):
        good=json.dumps(self.row(0)).encode()
        cases=[[('../escape',good,tarfile.REGTYPE)],[(self.path(0),b'',tarfile.SYMTYPE)],[(self.path(0),good,tarfile.REGTYPE)]*2,[(self.path(1),good,tarfile.REGTYPE)]]
        for entries in cases:
            with self.assertRaises(ValueError):c.parse_archive(self.archive(entries),self.expected)
    def test_detects_truncated_last_stage_and_duplicate_json_key(self):
        for raw in [b'',b'{',b'{"schema":1,"schema":2}']:
            _,rows,errors=c.parse_archive(self.archive([(self.path(0),raw,tarfile.REGTYPE)]),self.expected)
            self.assertFalse(rows);self.assertEqual(len(errors),1)
    def test_rejects_stage_output_cap(self):
        with self.assertRaises(ValueError):c.parse_archive(self.archive([(self.path(0),b'x'*(c.MAX_STAGE+1),tarfile.REGTYPE)]),self.expected)
    def test_one_method_instrumentation_fail_closed(self):
        text=('INSTRUMENTATION_STATUS: numtests=1\nINSTRUMENTATION_STATUS: class='+c.CLASS+'\nINSTRUMENTATION_STATUS: test=observeArm\nOK (1 test)\nINSTRUMENTATION_CODE: -1\n').encode()
        self.assertTrue(c.instrumentation_pass(text))
        for broken in [text.replace(b'numtests=1',b'numtests=9'),text+b'Process crashed',text.replace(b'observeArm',b'offlinePackagedNativeRecognitionAndRecovery'),text.replace(b'test=observeArm',b'test=observeArmWrong'),text.replace(b'INSTRUMENTATION_CODE: -1',b'INSTRUMENTATION_CODE: -10'),text.replace(c.CLASS.encode(),(c.CLASS+'Wrong').encode())]:self.assertFalse(c.instrumentation_pass(broken))
    def test_collect_exclusive_original_bytes_and_no_acceptance(self):
        with tempfile.TemporaryDirectory() as d:
            folder=Path(d);a=folder/'input.tar';a.write_bytes(self.archive([(self.path(0),json.dumps(self.row(0)).encode(),tarfile.REGTYPE)]));i=folder/'instrument.txt';i.write_bytes(b'Process crashed')
            result=c.collect(a,i,folder/'out',self.expected);self.assertFalse(result['product_acceptance']);self.assertEqual((folder/'out/original-journal.tar').read_bytes(),a.read_bytes())
            with self.assertRaises(FileExistsError):c.collect(a,i,folder/'out',self.expected)

if __name__=='__main__':unittest.main()
