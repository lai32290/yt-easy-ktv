// Valida o manifest MV3, a existência dos arquivos referenciados e regras de CSP/MV3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = fileURLToPath(new URL('../../', import.meta.url));
const extDir = join(raiz, 'extension');
const manifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));

function listar(dir) {
  if (!existsSync(dir)) return [];
  const r = [];
  for (const nome of readdirSync(dir)) {
    const p = join(dir, nome);
    if (nome === 'node_modules') continue;
    if (statSync(p).isDirectory()) r.push(...listar(p));
    else r.push(p);
  }
  return r;
}

test('manifest é MV3 válido', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.name && manifest.version, 'name e version obrigatórios');
  assert.match(manifest.version, /^\d+(\.\d+){0,3}$/);
  for (const p of ['offscreen', 'storage', 'tabs', 'windows']) {
    assert.ok(manifest.permissions.includes(p), `permissão ausente: ${p}`);
  }
  assert.ok(manifest.host_permissions.includes('https://www.youtube.com/*'));
  assert.ok(manifest.background?.service_worker, 'service_worker ausente');
  assert.ok(manifest.content_scripts?.length, 'content_scripts ausente');
  assert.ok(manifest.action, 'action ausente');
});

test('todo arquivo referenciado no manifest existe', () => {
  const refs = new Set();
  refs.add(manifest.background.service_worker);
  for (const cs of manifest.content_scripts) {
    for (const f of [...(cs.js || []), ...(cs.css || [])]) refs.add(f);
  }
  for (const war of manifest.web_accessible_resources || []) {
    for (const f of war.resources) refs.add(f);
  }
  const icones = [
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action?.default_icon || {}),
  ];
  for (const f of icones) refs.add(f);
  if (manifest.action?.default_popup) refs.add(manifest.action.default_popup);

  const faltando = [...refs].filter((f) => !existsSync(join(extDir, f)));
  assert.deepEqual(faltando, [], `arquivos referenciados que não existem: ${faltando.join(', ')}`);
});

test('sem eval/new Function/script remoto fora de vendor/', () => {
  const alvos = [...listar(extDir), ...listar(join(raiz, 'web'))].filter((p) => {
    const rel = relative(raiz, p).split(sep).join('/');
    return /\.(js|mjs|html|css)$/.test(rel) && !rel.includes('/vendor/');
  });
  const proibidos = [
    [/\beval\s*\(/, 'eval('],
    [/\bnew\s+Function\s*\(/, 'new Function('],
    [/<script[^>]*\ssrc\s*=\s*["']?(https?:)?\/\//i, '<script src> remoto'],
  ];
  const problemas = [];
  for (const p of alvos) {
    const txt = readFileSync(p, 'utf8');
    for (const [re, nome] of proibidos) {
      if (re.test(txt)) problemas.push(`${relative(raiz, p)}: ${nome}`);
    }
  }
  assert.deepEqual(problemas, []);
});
