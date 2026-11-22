// Critério: "abro a janela KTV; Iniciar e QR visíveis; a URL do QR contém #sala=".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import qrcode from '../../extension/vendor/qrcode.js';
import { comAmbiente, ate } from './helpers/ambiente.js';

test('a) ícone abre a janela KTV com botão Iniciar e QR da sala', { timeout: 120000 }, () => comAmbiente('janela', async (amb) => {
  await amb.apontarSinalizacao();
  const roomId = await amb.esperarSala();
  assert.match(roomId, /\S+/);

  const ktv = await amb.abrirKtv();
  await ktv.locator('#ktv-root .btn-iniciar').waitFor({ state: 'visible', timeout: 20000 });
  assert.match(ktv.url(), /^https:\/\/www\.youtube\.com\/\?ktv=1/);

  // Fila vazia: modo ocioso com QR grande e URL em texto contendo #sala=
  const p = await ate(async () => {
    const x = await amb.painel();
    return x && x.ocioso && x.url ? x : null;
  }, { descricao: 'painel ocioso com URL da sala' });
  assert.match(p.url, /#sala=/);
  assert.ok(p.url.endsWith(`#sala=${roomId}`), p.url);
  assert.ok(p.qrGrande.includes('<svg'), 'QR grande ausente');
  assert.ok(await ktv.locator('#ktv-root .qr-grande svg').isVisible(), 'QR grande invisível');
  assert.ok(await ktv.locator('#ktv-root .btn-iniciar').isVisible(), 'botão Iniciar invisível');

  // O QR é exatamente o da URL exibida (gerado com a mesma lib, no Node).
  const qr = qrcode(0, 'M');
  qr.addData(p.url); qr.make();
  // O painel desenha cada módulo escuro como `M{x},{y}h1v1h-1z` (margem de 2 módulos).
  const d = /<path[^>]* d="([^"]+)"/.exec(p.qrGrande)?.[1] || '';
  const escuros = new Set([...d.matchAll(/M(\d+),(\d+)/g)].map((m) => `${m[2] - 2},${m[1] - 2}`));
  const esperado = new Set();
  const n = qr.getModuleCount();
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) esperado.add(`${r},${c}`);
  assert.ok(esperado.size > 0, 'QR esperado vazio');
  assert.deepEqual(escuros, esperado, 'o QR do painel não é o da URL exibida');

  // Clicar o ícone de novo não abre uma segunda janela: foca a existente.
  const sw = await amb.sw();
  await sw.evaluate(() => { chrome.action.onClicked.dispatch({ id: 0 }); });
  await new Promise((r) => setTimeout(r, 1500));
  const abasYoutube = amb.ctx.pages().filter((x) => x.url().startsWith('https://www.youtube.com/'));
  assert.equal(abasYoutube.length, 1);
}));

test('a) abas normais do YouTube não são tocadas pelo KTV', { timeout: 120000 }, () => comAmbiente('abas-normais', async (amb) => {
  await amb.apontarSinalizacao();
  await amb.esperarSala();
  const ktv = await amb.abrirKtv();
  await ktv.locator('#ktv-root .btn-iniciar').waitFor({ state: 'visible', timeout: 20000 });

  const normal = await amb.ctx.newPage();
  await normal.goto('https://www.youtube.com/watch?v=aaaaaaaaaa1');
  await new Promise((r) => setTimeout(r, 3000)); // dá tempo ao content script de perguntar ao SW
  assert.equal(await normal.locator('#ktv-root').count(), 0, 'painel KTV apareceu numa aba comum');
  const fake = await normal.evaluate(() => window.__fake.cliquesToggle);
  assert.equal(fake, 0, 'o KTV mexeu no autoplay de uma aba comum');
}));

test('a) música pedida antes do "Iniciar" só toca depois do clique', { timeout: 120000 }, () => comAmbiente('pre-iniciar', async (amb) => {
  await amb.prepararKtv({ iniciar: false });
  const cel = await amb.novoCelular('Bia');
  await cel.colarLink('https://youtu.be/aaaaaaaaaa1');
  await cel.esperarEstado((s) => s.fila.length === 1 && !s.atual, { descricao: 'item na fila, nada tocando' });
  await new Promise((r) => setTimeout(r, 1500));
  const antes = await amb.paginaKtv();
  assert.equal(antes.videoId, null, 'tocou antes do Iniciar');

  await amb.iniciar();
  const s = await cel.esperarEstado((x) => x.atual?.videoId === 'aaaaaaaaaa1', { descricao: 'atual = aaaaaaaaaa1' });
  assert.equal(s.fila.length, 0);
  await ate(async () => (await amb.paginaKtv())?.fake?.playing.includes('aaaaaaaaaa1'), { descricao: 'vídeo tocando na aba KTV' });
}));
