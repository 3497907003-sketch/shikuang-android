# 2.5 feature-branch system regression

Current package/version remains 2.0.2-preview. Model manifest `inherited-2.0-audited` retains inherited weights; compatibility checks and regression photos do not establish independent accuracy or Kappa. Root training/evaluation work supplies future weights and validation evidence separately.

## Shared contract and recovery matrix

- Manifest validation: ordered labels, float32 RGB NCHW224, declared normalization, center-square ROI, calibrated temperature, safe model allowlist and bounded sizes; actual ONNX graph names/types/shapes, bytes and hashes checked before build.
- Packaged assets: only active manifest weights; cleaned `dist`, Capacitor replaces its asset directory, then every file hash and exact model list are checked. Source-only unused legacy weights cannot enter the APK.
- PWA: manifest network-first with finite deadlines and explicit verified offline fallback. New invalid contents fail visibly. Models bind both manifest SHA and model SHA; old URL-only entries migrate only after exact bytes/hash verification. Partial or mixed ensembles never produce a result. Failed model caches are evicted with acknowledgment before retry.
- Native: no dependence on WebView Worker/WASM execution. Signed-package ES5 migration repairs even stale cached HTML, unregisters only this origin/scope's Workers and deletes only `shikuang-*` asset caches. Specimen IndexedDB is never deleted. Startup capabilities and a 15-second watchdog show a recovery page for unsupported/stalled WebViews.
- Resource lifetime: finite manifest/body/decode/inference deadlines; canceled listener/jobs cannot modify newer results; failed selected models release sessions; fast mode retains its gate plus chosen classifier. Native low-RAM mode evicts other classifiers before allocating another. Camera/file limits are enforced before large canvases or image decode where supported.
- Existing storage schema: blocked open/version changes close old connections, finite transaction timeout, recoverable retry, preserve existing records.

## Platform migration

ORT fixed to 1.24.3; minimum Android7/API24; four ABI libraries; explicitly compressed `.so` packaging with AGP8.2.1. Actual Maven AAR inspection found 1.20 JNI LOAD alignment4096, while 1.24.3 both arm64/x86_64 libraries have LOAD alignment16384 and GNU_RELRO ends on16KB boundaries. These static facts do not claim a physical-device run. Official SDK35 `zipalign -v -c -P16 4` and independent bounded ELF parsing validate every final APK.

Runtime matrix uses official Android Google API x86_64 images: API24,30,35 and `system-images;android-35;google_apis_ps16k;x86_64`. Actual `getconf PAGE_SIZE` and native `Os.sysconf` must equal4096/16384. No page-size property simulation. Device has no active network, no external default routes, and navigator.onLine is false at both start/end.

Factory API24 WebView may lack modern syntax/APIs. That environment must show a readable system-component update page with bounded loading; photo recognition is explicitly not claimed. Each actual packaged graph separately executes in Java ONNX Runtime using a zero tensor, proving runtime/ABI/graph compatibility rather than photo accuracy. API30/35/16KB require genuine UI photos: Quartz ensemble, exact dog rejection, cancellation followed by recovery, one saved record unchanged after rejection, fast-mode release, offline6239-species reference directory and source data, and real screenshot/JSON preservation. Legacy Worker migration deliberately poisons cached HTML without migration scripts and checks trusted package recovery while preserving a specimen and unrelated cache.

## Evidence before this matrix

Baseline feature head540d844: API30 Chrome83 and API35 Chrome124 both passed real native photo/UI tests with ORT1.20.0. The earlier API35 EXIF JPEG-vs-PNG pixel assumption failed despite correct ROI coordinates; it was replaced with independent geometry/Canvas-boundary checks, retaining measured rasterizer differences. PIL vs Canvas numerical equality is not claimed. Actual Chrome154 PWA lifecycle regression passed online→offline Quartz, exact dog rejection, corrupt-cache failure/eviction, online retry, and legacy-cache cleanup preserving history: workspace `work/asset-lifecycle-2.5/browser-report.json`.

Migration/platform CI results are recorded by run/head and artifacts after execution. Final new-weight delivery requires a second complete regression round. Physical ARM64/OEM camera/low-memory devices, all brands, inaccessible source truth, and independent field accuracy remain unverified until measured; Mi10 is a reproduction clue, not a device-specific target.
