'use strict';
// The tracked manifest and complete MIT-licensed source payload are reviewed
// together. Never replace unknown dependency bytes or silently accept drift.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function inside(root, rel, prefix) {
  if (typeof rel !== 'string' || rel.includes('\\') || !rel.startsWith(prefix) || rel.split('/').some(x => !x || x === '.' || x === '..')) throw new Error('Invalid patch path');
  const result = path.resolve(root, rel);
  if (!result.startsWith(path.resolve(root) + path.sep)) throw new Error('Patch path escaped root');
  return result;
}
function requireOrdinaryAncestors(root, target) {
  let parent = target;
  while (parent !== root) {
    if (fs.existsSync(parent) && fs.lstatSync(parent).isSymbolicLink()) throw new Error('Patch refuses symbolic-link target/ancestor');
    parent = path.dirname(parent);
    if (!parent.startsWith(root)) throw new Error('Patch ancestor escaped root');
  }
}
function apply(root, checkOnly = false) {
  root = fs.realpathSync(root);
  const manifestPath = path.join(root, 'patches/webview-lifetime/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schema !== 'shikuang-pinned-webview-lifetime-patch-v1' || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Invalid patch manifest');
  for (const [pkg, version] of Object.entries(manifest.packages)) {
    if (!['@capacitor/android', '@capacitor/app'].includes(pkg)) throw new Error('Unexpected patched package');
    const actual = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', pkg, 'package.json'), 'utf8'));
    if (actual.name !== pkg || actual.version !== version) throw new Error('Pinned dependency version mismatch: ' + pkg);
  }
  const seen = new Set();
  const prepared = manifest.files.map(row => {
    const target = inside(root, row.target, 'node_modules/');
    const payloadPath = inside(root, row.payload, 'patches/webview-lifetime/');
    if (seen.has(target)) throw new Error('Duplicate patch target');
    seen.add(target);
    requireOrdinaryAncestors(root, target);
    requireOrdinaryAncestors(root, payloadPath);
    const bytes = fs.readFileSync(payloadPath);
    if (bytes.length !== row.after_bytes || digest(bytes) !== row.after_sha256) throw new Error('Patch payload SHA/size mismatch: ' + row.target);
    const present = fs.existsSync(target);
    const current = present ? digest(fs.readFileSync(target)) : null;
    if (current !== row.before_sha256 && current !== row.after_sha256) throw new Error('Unknown dependency source SHA: ' + row.target);
    if (checkOnly && current !== row.after_sha256) throw new Error('Dependency patch is not installed: ' + row.target);
    return { target, bytes, changed: current !== row.after_sha256 };
  });
  // Validate every input before the first dependency write. Atomic per file;
  // re-entry accepts only exact before/after hashes after interrupted installs.
  let changed = 0;
  if (!checkOnly) for (const entry of prepared) {
    if (!entry.changed) continue;
    fs.mkdirSync(path.dirname(entry.target), { recursive: true });
    const temporary = entry.target + '.shikuang-lifetime-' + process.pid + '.tmp';
    try { fs.writeFileSync(temporary, entry.bytes, { flag: 'wx' }); fs.renameSync(temporary, entry.target); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    changed++;
  }
  return { files: prepared.length, changed, checkOnly };
}
if (require.main === module) {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--check')) throw new Error('Usage: apply-webview-lifetime-patch.cjs [--check]');
  console.log(JSON.stringify(apply(path.resolve(__dirname, '..'), process.argv[2] === '--check')));
}
module.exports = { apply };
