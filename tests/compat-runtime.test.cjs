const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const WEB = fs.existsSync(path.join(__dirname,'../web/core.js')) ? '../web/' : '../';

// Source and synthetic text only: this suite never loads an image, runtime WASM
// or model. Realm-local omissions must not mutate Node's own browser-like APIs.
const compatSource = fs.readFileSync(require.resolve(WEB+'compat.js'), 'utf8');
const nativeSource = fs.readFileSync(require.resolve(WEB+'native-assets.js'), 'utf8');
const coreSource = fs.readFileSync(require.resolve(WEB+'core.js'), 'utf8');

function workerRealm(extra = {}) {
  const context = vm.createContext(extra);
  vm.runInContext('self = this; globalThis = undefined;', context);
  vm.runInContext(compatSource, context, {filename:'compat.js'});
  return context;
}

test('compat bootstrap restores only a missing globalThis in a Worker realm without DOM globals', () => {
  const context = workerRealm();
  assert.equal(vm.runInContext('globalThis === self', context), true);
  assert.equal(vm.runInContext('typeof window', context), 'undefined');
  assert.equal(vm.runInContext('typeof document', context), 'undefined');
  assert.equal(vm.runInContext('typeof MineralCompat.readText', context), 'function');
  assert.equal(vm.runInContext('typeof fetch', context), 'undefined');
  assert.equal(vm.runInContext('typeof crypto', context), 'undefined');
});

test('compat bootstrap preserves an existing realm globalThis and its descriptor', () => {
  const context = vm.createContext({});
  vm.runInContext('self = this; savedGlobal = globalThis; savedDescriptor = Object.getOwnPropertyDescriptor(this, "globalThis");', context);
  vm.runInContext(compatSource, context, {filename:'compat.js'});
  assert.equal(vm.runInContext('globalThis === savedGlobal && globalThis === self', context), true);
  assert.equal(vm.runInContext('var descriptor = Object.getOwnPropertyDescriptor(this, "globalThis"); ["value", "writable", "enumerable", "configurable", "get", "set"].every(function (key) { return descriptor[key] === savedDescriptor[key]; });', context), true);
  assert.equal(vm.runInContext('typeof MineralCompat.readText', context), 'function');
});

function readerRealm(mode = 'success') {
  const readers = [], calls = [];
  class FakeFileReader {
    constructor() { readers.push(this); }
    readAsText(blob, encoding) {
      calls.push({blob, encoding});
      if (mode === 'success') queueMicrotask(() => {
        this.result = new TextDecoder('utf-8').decode(blob.bytes);
        this.onload();
      });
      else if (mode === 'error') queueMicrotask(() => this.onerror());
    }
    abort() { this.onabort(); }
  }
  const context = workerRealm({FileReader:FakeFileReader});
  return {api:context.MineralCompat, readers, calls};
}

function assertReaderReleased(reader) {
  assert.equal(reader.onload, null);
  assert.equal(reader.onerror, null);
  assert.equal(reader.onabort, null);
}

test('readText preserves caller-owned FileReader input and explicitly decodes Chinese UTF-8', async () => {
  const h = readerRealm(), text = '{"矿物":"石英","观察":"玻璃光泽，保留原文 α β"}';
  const blob = {bytes:new TextEncoder().encode(text)};
  assert.equal(await h.api.readText(blob), text);
  assert.equal(h.readers.length, 1);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].blob, blob);
  assert.equal(h.calls[0].encoding, 'UTF-8');
  assertReaderReleased(h.readers[0]);
});

test('FileReader error rejects instead of importing empty or partial backup text', async () => {
  const h = readerRealm('error');
  await assert.rejects(h.api.readText({bytes:new Uint8Array()}), /标本备份文件读取失败/);
  assertReaderReleased(h.readers[0]);
});

test('FileReader abort retains AbortError and releases all reader callbacks', async () => {
  const h = readerRealm('pending'), pending = h.api.readText({bytes:new Uint8Array()});
  h.readers[0].abort();
  await assert.rejects(pending, error => error.name === 'AbortError' && /已停止/.test(error.message));
  assertReaderReleased(h.readers[0]);
});

test('readText preserves native text method receiver and promise without constructing a FileReader', async () => {
  let readers = 0, receiver;
  const context = workerRealm({FileReader:class { constructor() { readers++; throw Error('Unnecessary fallback'); } }});
  const original = Promise.resolve('原生读取：方解石'), text = function () { receiver = this; return original; };
  const blob = {text};
  const actual = context.MineralCompat.readText(blob);
  assert.equal(actual, original);
  assert.equal(await actual, '原生读取：方解石');
  assert.equal(receiver, blob);
  assert.equal(blob.text, text);
  assert.equal(readers, 0);
  const failure = new Error('Native read failed');
  await assert.rejects(context.MineralCompat.readText({text:() => Promise.reject(failure)}), error => error === failure);
  assert.equal(readers, 0);
});

test('readText fails visibly when input or the required reading API is absent', async () => {
  const {MineralCompat:api} = workerRealm();
  await assert.rejects(api.readText(null), error => error.name === 'TypeError');
  await assert.rejects(api.readText({}), /当前环境无法读取/);
});

function nativeBoot(changes = {}) {
  const probes = [], timers = [];
  function LegacyFunction(...parts) {
    const source = parts.join('\n');
    probes.push(source);
    if (/\?\.|\?\?/.test(source)) throw new SyntaxError('Chrome 69: modern syntax is unsupported');
    return Function(...parts);
  }
  assert.throws(() => LegacyFunction('var x={}; return x?.value ?? 0;'), SyntaxError);
  probes.length = 0;
  function Image() {}
  Image.prototype.decode = function () {};
  const root = Object.assign({
    __shikuangAppReady:true, Promise, URL, AbortController, crypto:{subtle:{}}, Image,
    Function:LegacyFunction, Capacitor:{isNativePlatform:() => true},
    setTimeout:(callback, milliseconds) => (timers.push({callback, milliseconds}), timers.length),
    clearTimeout() {}
  }, changes);
  vm.runInNewContext(nativeSource, {window:root, Function:LegacyFunction}, {filename:'native-assets.js'});
  return {root, probes, timers};
}

test('native boot accepts compiled code even when Function rejects optional chaining and nullish coalescing', () => {
  const h = nativeBoot(), result = h.root.MineralNativeAssets.boot(true);
  assert.equal(result.active, true);
  assert.equal(result.supported, true);
  assert.equal(result.missing.length, 0);
  assert.equal(h.root.__shikuangBootRecovery, undefined);
  assert.equal(h.probes.length, 0, 'Boot must check platform capabilities, not unshipped source syntax');
  assert.equal(h.timers.length, 0);
});

test('native boot still rejects genuinely missing AbortController, SHA-256 or image decode', () => {
  const NoDecode = function () {};
  for (const [change, missing] of [
    [{AbortController:undefined}, 'AbortController'],
    [{crypto:undefined}, 'SHA-256'],
    [{crypto:{}}, 'SHA-256'],
    [{Image:NoDecode}, '图片解码']
  ]) {
    const h = nativeBoot(change), result = h.root.MineralNativeAssets.boot(true);
    assert.equal(result.supported, false);
    assert.ok(Array.from(result.missing).includes(missing));
    assert.ok(h.root.__shikuangBootRecovery.message.includes(missing));
    assert.equal(h.probes.length, 0);
  }
});

function legacyCore() {
  const context = vm.createContext({URL});
  vm.runInContext('String.prototype.matchAll = undefined;', context);
  vm.runInContext(coreSource, context, {filename:'core.js'});
  return {context, core:context.MineralCore};
}

test('shellAssets needs no matchAll and retains exact query strings, entity decoding and deduplication', () => {
  const {context, core} = legacyCore(), base = 'https://example.test/shikuang/index.html';
  const html = '<script data-src="./ignored.js" src=\'./core.js?v=shell-old&amp;x=2\'></script>'
    + '<link rel="stylesheet" href="./styles.css?v=release-1&amp;theme=light">'
    + '<link rel="preload" href="./not-offline.js">'
    + '<script src="./core.js?v=shell-old&amp;x=2"></script>';
  assert.deepEqual(Array.from(core.shellAssets(html, base)), [
    'https://example.test/shikuang/core.js?v=shell-old&x=2',
    'https://example.test/shikuang/styles.css?v=release-1&theme=light'
  ]);
  assert.equal(vm.runInContext('typeof String.prototype.matchAll', context), 'undefined');
  for (const src of ['../other/app.js', '/shikuang-other/app.js', 'https://foreign.test/shikuang/app.js', './app.js#fragment', 'https://user@example.test/shikuang/app.js']) {
    assert.throws(() => core.shellAssets('<script src="' + src + '"></script>', base), /范围|地址无效/);
  }
});

test('workerAssets and shellResourceURL bind every dependency to the same shell and application scope', () => {
  const {core} = legacyCore(), base = 'https://example.test/shikuang/index.html?entry=old';
  const expectedVersion = core.OFFLINE_CACHES.shell.replace(/^shikuang-static-/, '');
  const result = new URL(core.shellResourceURL('vendor/ort.min.js?v=stale&source=local', base));
  assert.equal(result.href, 'https://example.test/shikuang/vendor/ort.min.js?v=' + expectedVersion + '&source=local');
  assert.deepEqual(result.searchParams.getAll('v'), [expectedVersion]);
  const assets = Array.from(core.workerAssets(base));
  assert.deepEqual(assets.map(value => new URL(value).pathname), [
    '/shikuang/compat.js', '/shikuang/engine-worker.js', '/shikuang/core.js',
    '/shikuang/vendor/ort.min.js', '/shikuang/vendor/ort-wasm-simd-threaded.mjs',
    '/shikuang/vendor/ort-wasm-simd-threaded.wasm',
    '/shikuang/research-input.js', '/shikuang/research-photo.js',
    '/shikuang/research/shikuang-research-native-roi-q16-torchf32-v1/encoded-header.js',
    '/shikuang/research/shikuang-research-native-roi-q16-torchf32-v1/worker.js',
    '/shikuang/research/shikuang-research-native-roi-q16-torchf32-v1/profile.js',
    '/shikuang/research/shikuang-research-native-roi-q16-torchf32-v1/frozen/native-roi-entry.js',
    '/shikuang/research/shikuang-research-native-roi-q16-torchf32-v1/frozen/vendor/native-roi-q16.js',
    '/shikuang/research/shikuang-research-native-roi-q16-torchf32-v1/frozen/vendor/normalization.js',
    '/shikuang/research/shikuang-research-native-roi-q16-torchf32-v1/frozen/vendor/normalization-lut.f32le.bin'
  ]);
  assert.equal(new Set(assets).size, assets.length);
  for (const value of assets) {
    const url = new URL(value);
    assert.equal(url.origin, 'https://example.test');
    assert.equal(url.hash, '');
    assert.deepEqual(url.searchParams.getAll('v'), [expectedVersion]);
  }
  for (const name of ['../core.js', '/shikuang-other/core.js', 'https://foreign.test/shikuang/core.js', 'https://user@example.test/shikuang/core.js', './core.js#fragment']) {
    assert.throws(() => core.shellResourceURL(name, base), /范围/);
  }
});
