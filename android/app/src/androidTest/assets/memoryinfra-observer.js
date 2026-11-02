/* Test-only forwarding observer; no classifier output or App state supplied. */
(() => {
  'use strict';
  if (window.__memoryInfraDiagnostic) throw Error('Observer must be installed exactly once');
  if (location.origin !== 'https://localhost') throw Error('Unexpected packaged origin');
  const send = (event, payload = {}) => {
    const text = JSON.stringify({event, payload});
    if (text.length > 8192 || !ShikuangMemoryJournal.record(text)) throw Error('Durable journal rejected event');
  };
  const s = window.__memoryInfraDiagnostic = {
    analysisCalls: 0, analysis: null, referenceRequests: [], photoRequests: 0,
    libraryClicks: 0, analysisError: null
  };
  const baseline = () => ({loader: MineralReference.status,
    referenceResources: performance.getEntriesByType('resource').filter(r => /\/data\/(reference-manifest|catalog|crystals|image-sources)\.json(?:[?#]|$)/.test(r.name)).length,
    identifyVisible: !document.getElementById('view-identify').hidden,
    libraryHidden: document.getElementById('view-library').hidden});
  s.baseline = baseline();
  const realFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const u = new URL(args[0] instanceof Request ? args[0].url : String(args[0]), location.href);
    const ref = /\/data\/(reference-manifest|catalog|crystals|image-sources)\.json$/.test(u.pathname);
    const photo = /\/images\/reviewed-v25\//.test(u.pathname);
    const row = ref ? {path: u.pathname, local: u.origin === location.origin} : null;
    if (row) {s.referenceRequests.push(row); send('reference-start', row);}
    if (photo) {s.photoRequests++; send('photo-start', {local: u.origin === location.origin});}
    try {
      const response = await realFetch(...args);
      if (row) {row.status = response.status; send('reference-return', row);}
      return response;
    } catch (error) {
      if (row) {row.error = String(error).slice(0, 512); send('reference-error', row);}
      throw error;
    }
  };
  const realAnalyze = MineralEngine.analyze.bind(MineralEngine);
  MineralEngine.analyze = async (...args) => {
    s.analysisCalls++; send('analysis-start', {calls: s.analysisCalls});
    try {
      const r = await realAnalyze(...args);
      s.analysis = {key: r.key, engine: r.engine, modelCount: r.modelCount,
        modelVersion: r.modelVersion, manifestSha256: r.manifestSha256,
        elapsedMs: r.diagnostics && r.diagnostics.elapsedMs};
      send('analysis-return', s.analysis);
      return r;
    } catch (error) {
      s.analysisError = String(error).slice(0, 512);
      send('analysis-error', {error: s.analysisError}); throw error;
    }
  };
  document.addEventListener('click', e => {
    if (e.target.closest('[data-view=library]')) {s.libraryClicks++; send('library-click', {count: s.libraryClicks});}
    if (e.target.closest('#detailBtn,#libraryList [data-detail]')) send('detail-click', baseline());
  }, true);
  s.snapshot = () => {
    const body = document.getElementById('detailBody');
    const c = window.MINERAL_CATALOG, b = c && c.reviewed_book_evidence;
    return {...baseline(), analysisCalls: s.analysisCalls, analysis: s.analysis,
      analysisError: s.analysisError, requests: s.referenceRequests.map(r => ({...r})),
      photoRequests: s.photoRequests, libraryClicks: s.libraryClicks,
      resultVisible: !document.getElementById('result').hidden,
      predictEnabled: !document.getElementById('predictBtn').disabled,
      dialogOpen: document.getElementById('detailDialog').open,
      title: document.getElementById('detailTitle').textContent,
      hasOfficialFields: body.textContent.includes('官方目录字段'),
      loadingMessage: !!body.querySelector('.detail-reference-state'),
      bookSections: body.querySelectorAll('.book-evidence-section').length,
      totalBookStatements: b ? b.records.length : 0, books: b ? b.books.length : 0,
      primarySpecies: c ? c.minerals.length : 0,
      galleryPresent: !!body.querySelector('.image-section'),
      galleryClosed: !!body.querySelector('.image-section') && !body.querySelector('.image-section').open,
      online: navigator.onLine};
  };
  send('observer-installed', s.baseline);
})();
