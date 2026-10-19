/* Trusted package migration, ES5 syntax so an old cached app can be repaired.
 * MainActivity also injects this exact asset after load: cached old HTML cannot
 * prevent migration. CacheStorage is separate from specimen IndexedDB.
 */
(function (root) {
  'use strict';
  if (root.MineralNativeAssets) return;
  var pending = null, bootTimer = null;
  function isNative() {
    var cap = root.Capacitor;
    return !!(cap && ((cap.isNativePlatform && cap.isNativePlatform()) || (cap.getPlatform && cap.getPlatform() === 'android')));
  }
  function recovery(message) {
    root.__shikuangBootRecovery = { message: message };
    var document = root.document;
    if (!document || !document.body) return;
    document.body.style.cssText = 'display:block;margin:0;background:#eef4f4;color:#143f40;min-height:100vh;font-family:Arial,sans-serif;';
    document.body.innerHTML = '<main id="native-boot-recovery" style="box-sizing:border-box;max-width:34rem;padding:28px 22px;margin:0 auto;line-height:1.8">'
      + '<h1 style="font-size:26px">识矿 · 系统组件需要更新</h1><p id="native-boot-message"></p>'
      + '<p>安装版适用于 Android 7 及以上。系统组件缺少上述必要能力时，请更新系统 WebView，然后重新打开 App。本机标本和历史记录会保留。</p>'
      + '<p>更新后，可分别拍照、选择照片文件或从视频取帧；每次分析同一个矿物主体，结合实测物性复核候选。</p>'
      + '<a href="https://play.google.com/store/apps/details?id=com.google.android.webview" style="color:#096e6a">更新系统 WebView</a>'
      + '<p>也可在手机应用商店或系统设置中更新 Android System WebView / Chrome；首次更新需要联网。</p>'
      + '<button id="native-boot-retry" style="padding:12px 24px;font-size:16px">重新加载</button></main>';
    document.getElementById('native-boot-message').textContent = message;
    document.getElementById('native-boot-retry').onclick = function () { root.location.reload(); };
  }
  function boot(force) {
    if (!force && !isNative()) return { active: false };
    var missing = [];
    if (typeof root.Promise !== 'function') missing.push('Promise');
    if (typeof root.URL !== 'function') missing.push('URL');
    if (typeof root.AbortController !== 'function') missing.push('AbortController');
    if (!root.crypto || !root.crypto.subtle) missing.push('SHA-256');
    if (!root.Image || !root.Image.prototype.decode) missing.push('图片解码');
    // Shipped JS is built for Chrome69. Testing modern source syntax here would
    // reject a compatible compiled app; still require the actual platform APIs.
    var result = { active: true, supported: missing.length === 0, missing: missing };
    root.__shikuangBootCapabilities = result;
    if (!result.supported) { recovery('系统 WebView 过旧或缺少必要能力：' + missing.join('、') + '。'); return result; }
    if (!root.__shikuangAppReady && bootTimer === null) bootTimer = root.setTimeout(function () {
      bootTimer = null;
      if (!root.__shikuangAppReady) recovery('页面启动超过 15 秒。请重新打开；若问题持续，请更新系统 WebView 或重新安装最新版 App。');
    }, 15000);
    return result;
  }
  function prepare(force) {
    if (!force && !isNative()) return Promise.resolve({ native: false });
    if (pending) return pending;
    var timedOut = false, timer;
    var scope = new URL('./', root.location.href);
    var removedRegistrations = 0, removedCaches = 0;
    var cleanup = Promise.resolve().then(function () {
      if (!root.navigator.serviceWorker) return [];
      return root.navigator.serviceWorker.getRegistrations();
    }).then(function (registrations) {
      return Promise.all(registrations.map(function (registration) {
        var url = new URL(registration.scope);
        if (url.origin !== scope.origin || url.pathname.indexOf(scope.pathname) !== 0) return false;
        return registration.unregister().then(function (removed) { if (removed) removedRegistrations++; });
      }));
    }).then(function () { return root.caches ? root.caches.keys() : []; }).then(function (names) {
      return Promise.all(names.filter(function (name) { return name.indexOf('shikuang-') === 0; }).map(function (name) {
        return root.caches.delete(name).then(function (removed) { if (removed) removedCaches++; });
      }));
    }).then(function () {
      if (timedOut) throw new Error('本机资源迁移超时，请重新打开 App');
      var controller = root.navigator.serviceWorker && root.navigator.serviceWorker.controller;
      var controllerURL = controller && new URL(controller.scriptURL);
      var ownedController = controllerURL && controllerURL.origin === scope.origin && controllerURL.pathname.indexOf(scope.pathname) === 0;
      var result = { native: true, removedRegistrations: removedRegistrations, removedCaches: removedCaches, restartRequired: !!ownedController };
      root.__shikuangNativeAssetMigration = result;
      if (ownedController) root.location.reload();
      return result;
    });
    pending = new Promise(function (resolve, reject) {
      timer = root.setTimeout(function () { timedOut = true; pending = null; reject(new Error('本机资源迁移超过 5 秒，请重新打开 App')); }, 5000);
      cleanup.then(function (value) { root.clearTimeout(timer); resolve(value); }, function (error) { root.clearTimeout(timer); pending = null; reject(error); });
    });
    return pending;
  }
  root.MineralNativeAssets = { prepare: prepare, boot: boot };
  boot();
})(window);
