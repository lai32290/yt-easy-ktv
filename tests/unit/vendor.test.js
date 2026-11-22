// Confere as libs de vendor/ e que o QR gera um SVG.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join } from 'node:path';

const raiz = fileURLToPath(new URL('../../', import.meta.url));

test('peerjs.min.js existe na extensão e no site, idêntico, e define a global Peer', () => {
  const a = join(raiz, 'extension/vendor/peerjs.min.js');
  const b = join(raiz, 'web/vendor/peerjs.min.js');
  assert.ok(existsSync(a) && existsSync(b));
  const ta = readFileSync(a, 'utf8');
  assert.equal(ta, readFileSync(b, 'utf8'));
  assert.match(ta, /window\.Peer\s*=/);
  assert.ok(ta.length > 50_000);
});

test('VERSIONS.md lista as libs', () => {
  const t = readFileSync(join(raiz, 'extension/vendor/VERSIONS.md'), 'utf8');
  assert.match(t, /peerjs/);
  assert.match(t, /qrcode-generator/);
});

test('qrcode.js (ESM) gera SVG para a URL da sala', async () => {
  const mod = await import(pathToFileURL(join(raiz, 'extension/vendor/qrcode.js')).href);
  const qrcode = mod.default;
  assert.equal(typeof qrcode, 'function');
  const qr = qrcode(0, 'M');
  qr.addData('https://exemplo.github.io/yt-easy-ktv/#sala=abc-123');
  qr.make();
  const svg = qr.createSvgTag({ cellSize: 4, margin: 2 });
  assert.match(svg, /^<svg/);
  assert.match(svg, /<\/svg>$/);
  assert.ok(qr.getModuleCount() >= 21);
});

test('web/vendor/qrcode.js é idêntico ao da extensão e web/qr.js gera os dados do QR', async () => {
  assert.equal(readFileSync(join(raiz, 'web/vendor/qrcode.js'), 'utf8'), readFileSync(join(raiz, 'extension/vendor/qrcode.js'), 'utf8'));
  const { qrDados } = await import(pathToFileURL(join(raiz, 'web/qr.js')).href);
  const dados = qrDados('https://exemplo.github.io/ktv/#sala=abc-123');
  assert.ok(dados.tam > 20);
  assert.match(dados.d, /^M\d+,\d+h1v1h-1z/);
});
