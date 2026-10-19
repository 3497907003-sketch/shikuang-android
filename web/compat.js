/* Small realm-local helpers. No network, storage, decoder or crypto substitute. */
(function (root) {
  'use strict';
  if (typeof root.globalThis === 'undefined') {
    Object.defineProperty(root, 'globalThis', {value:root, writable:true, configurable:true});
  }
  function readText(blob) {
    if (!blob) return Promise.reject(new TypeError('请选择完整的标本备份文件'));
    if (typeof blob.text === 'function') return blob.text();
    return new Promise(function (resolve, reject) {
      if (typeof root.FileReader !== 'function') { reject(new Error('当前环境无法读取标本备份文件')); return; }
      var reader = new root.FileReader();
      function finish(error, value) {
        reader.onload = reader.onerror = reader.onabort = null;
        if (error) reject(error); else resolve(value);
      }
      reader.onload = function () { finish(null, reader.result); };
      reader.onerror = function () { finish(new Error('标本备份文件读取失败，请重新选择')); };
      reader.onabort = function () { var e = new Error('标本备份读取已停止'); e.name = 'AbortError'; finish(e); };
      reader.readAsText(blob, 'UTF-8');
    });
  }
  var api = {readText:readText};
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MineralCompat = api;
})(typeof globalThis === 'object' ? globalThis : typeof self === 'object' ? self : this);
