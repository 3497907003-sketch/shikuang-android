'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { apply } = require('../tools/apply-webview-lifetime-patch.cjs');

const project = path.resolve(__dirname, '..');
const sourceManifest = JSON.parse(fs.readFileSync(path.join(project, 'patches/webview-lifetime/manifest.json'), 'utf8'));
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shikuang-lifetime-install-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Use the real tracked payload and its real after hashes. The only changed
  // manifest fields are fixture before_sha256 values for clearly synthetic input.
  const manifest = JSON.parse(JSON.stringify(sourceManifest));
  for (const [name, version] of Object.entries(manifest.packages)) {
    const folder = path.join(root, 'node_modules', name);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ name, version }));
  }
  for (const row of manifest.files) {
    const payload = path.join(root, row.payload);
    fs.mkdirSync(path.dirname(payload), { recursive: true });
    fs.copyFileSync(path.join(project, row.payload), payload);
    if (row.before_sha256 !== null) {
      const syntheticBefore = Buffer.from('SYNTHETIC INSTALLER TEST INPUT; NOT UPSTREAM JAVA\n' + row.target + '\n', 'utf8');
      const target = path.join(root, row.target);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, syntheticBefore);
      row.before_sha256 = digest(syntheticBefore);
    }
  }
  const manifestPath = path.join(root, 'patches/webview-lifetime/manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  return { root, manifest };
}

function targetSnapshot(root, manifest) {
  return manifest.files.map(row => {
    const target = path.join(root, row.target);
    return [row.target, fs.existsSync(target) ? fs.readFileSync(target).toString('hex') : null];
  });
}

function observeWrites(action) {
  const mutations = [];
  const originals = new Map();
  // Observe the real installer's mutation primitives during only its synchronous
  // call. Setup, cleanup and the Node test runner operate outside this window.
  for (const name of ['writeFileSync', 'renameSync', 'mkdirSync', 'unlinkSync']) {
    const original = fs[name]; originals.set(name, original);
    fs[name] = function (...args) { mutations.push([name, String(args[0])]); return original.apply(this, args); };
  }
  try { action(); } finally { for (const [name, original] of originals) fs[name] = original; }
  return mutations;
}

function rejectWithoutWrites(root, manifest, expected) {
  const before = targetSnapshot(root, manifest);
  const writes = observeWrites(() => assert.throws(() => apply(root), expected));
  assert.deepEqual(writes, [], 'validation failure must happen before every mutation');
  assert.deepEqual(targetSnapshot(root, manifest), before, 'all target bytes/existence must be retained');
}

function assertInstalled(root, manifest) {
  for (const row of manifest.files) {
    const actual = fs.readFileSync(path.join(root, row.target));
    assert.equal(actual.length, row.after_bytes);
    assert.equal(digest(actual), row.after_sha256);
    assert.deepEqual(actual, fs.readFileSync(path.join(project, row.payload)));
  }
}

test('installs the real payload from synthetic before inputs and verifies without writes', t => {
  const { root, manifest } = fixture(t);
  assert.deepEqual(apply(root), { files: manifest.files.length, changed: manifest.files.length, checkOnly: false });
  assertInstalled(root, manifest);
  assert.deepEqual(observeWrites(() => assert.deepEqual(apply(root, true), { files: manifest.files.length, changed: 0, checkOnly: true })), []);
});

test('repeated installation is byte-stable and performs zero mutations', t => {
  const { root, manifest } = fixture(t); apply(root);
  const before = targetSnapshot(root, manifest);
  const writes = observeWrites(() => assert.equal(apply(root).changed, 0));
  assert.deepEqual(writes, []); assert.deepEqual(targetSnapshot(root, manifest), before);
});

test('unknown late source is rejected before any target mutation', t => {
  const { root, manifest } = fixture(t);
  const row = manifest.files.at(-1);
  fs.writeFileSync(path.join(root, row.target), 'SYNTHETIC FOREIGN SOURCE\n');
  rejectWithoutWrites(root, manifest, /Unknown dependency source SHA/);
});

test('corrupt late payload is rejected before any target mutation', t => {
  const { root, manifest } = fixture(t);
  fs.appendFileSync(path.join(root, manifest.files.at(-1).payload), 'SYNTHETIC CORRUPTION\n');
  rejectWithoutWrites(root, manifest, /Patch payload SHA\/size mismatch/);
});

test('version drift is rejected without installing any target', t => {
  const { root, manifest } = fixture(t);
  const name = Object.keys(manifest.packages)[0];
  fs.writeFileSync(path.join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '0.0.0-synthetic-drift' }));
  rejectWithoutWrites(root, manifest, /Pinned dependency version mismatch/);
});

test('symbolic target is rejected without changing its referent or any target', t => {
  const { root, manifest } = fixture(t);
  const row = manifest.files.find(item => item.before_sha256 !== null);
  const target = path.join(root, row.target), referent = path.join(root, 'synthetic-referent.txt');
  const original = fs.readFileSync(target); fs.writeFileSync(referent, original); fs.unlinkSync(target); fs.symlinkSync(referent, target);
  rejectWithoutWrites(root, manifest, /symbolic-link target\/ancestor/);
  assert.deepEqual(fs.readFileSync(referent), original);
});

test('symbolic ancestor is rejected before any target mutation', t => {
  const { root, manifest } = fixture(t);
  const row = manifest.files.at(-1), originalParent = path.dirname(path.join(root, row.target));
  const movedParent = path.join(root, 'synthetic-moved-parent');
  fs.renameSync(originalParent, movedParent); fs.symlinkSync(movedParent, originalParent, 'dir');
  rejectWithoutWrites(root, manifest, /symbolic-link target\/ancestor/);
});

test('uninstalled --check state is rejected without mutations', t => {
  const { root, manifest } = fixture(t); const before = targetSnapshot(root, manifest);
  const writes = observeWrites(() => assert.throws(() => apply(root, true), /Dependency patch is not installed/));
  assert.deepEqual(writes, []); assert.deepEqual(targetSnapshot(root, manifest), before);
});

test('foreign preexisting new source is never overwritten', t => {
  const { root, manifest } = fixture(t);
  const row = manifest.files.find(item => item.before_sha256 === null);
  assert.ok(row, 'current patch includes a newly added lifetime source');
  const target = path.join(root, row.target); fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'SYNTHETIC UNREVIEWED NEW SOURCE\n');
  rejectWithoutWrites(root, manifest, /Unknown dependency source SHA/);
});
