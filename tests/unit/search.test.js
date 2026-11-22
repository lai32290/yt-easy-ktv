import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseResultsHtml, extrairJsonBalanceado, buscar } from '../../extension/src/background/search.js';
import { CONFIG } from '../../extension/src/shared/protocol.js';

const html = readFileSync(fileURLToPath(new URL('../fixtures/search.html', import.meta.url)), 'utf8');

test('extrairJsonBalanceado: respeita chaves dentro de strings', () => {
  const t = 'x = {"a":"}{\\"}","b":{"c":1}}; resto {';
  assert.equal(extrairJsonBalanceado(t, t.indexOf('{')), '{"a":"}{\\"}","b":{"c":1}}');
  assert.equal(extrairJsonBalanceado('{"a":', 0), null);
});

test('parseResultsHtml: mapeia videoRenderer e ignora anúncio, short, ao vivo, playlist', () => {
  const itens = parseResultsHtml(html);
  assert.equal(itens.length, 5);
  assert.deepEqual(itens[0], {
    videoId: 'tfhwXKd1W_o',
    titulo: 'Evidências - Chitãozinho e Xororó (Karaokê Version)',
    canal: 'Singer! Karaokê',
    duracao: '4:58',
  });
  const ids = itens.map((i) => i.videoId);
  assert.ok(!ids.includes('AAAAAAAAAAA'), 'anúncio');
  assert.ok(!ids.includes('SHORT_ID_01'), 'short');
  assert.ok(!ids.includes('LIVE_ID_001'), 'ao vivo');
  assert.ok(!ids.includes('3ae4UnFLJu0'), 'prateleira de shorts');
  assert.equal(new Set(ids).size, ids.length);
  for (const i of itens) {
    assert.match(i.videoId, CONFIG.VIDEO_ID_RE);
    assert.ok(i.titulo && i.canal);
  }
});

test('parseResultsHtml: respeita o limite', () => {
  assert.equal(parseResultsHtml(html, 3).length, 3);
});

test('parseResultsHtml: sem ytInitialData lança busca_falhou; sem resultados devolve []', () => {
  assert.throws(() => parseResultsHtml('<html>consentimento</html>'), { codigo: 'busca_falhou' });
  assert.throws(() => parseResultsHtml(null), { codigo: 'busca_falhou' });
  assert.deepEqual(parseResultsHtml('<script>var ytInitialData = {"contents":{}};</script>'), []);
});

test('buscar: monta a URL com sufixo karaokê e hl=pt-BR', async () => {
  let pedida;
  const itens = await buscar('evidências', {
    fetchImpl: async (u) => { pedida = u; return { ok: true, status: 200, text: async () => html }; },
  });
  assert.equal(itens.length, 5);
  const u = new URL(pedida);
  assert.equal(u.origin + u.pathname, 'https://www.youtube.com/results');
  assert.equal(u.searchParams.get('search_query'), 'evidências' + CONFIG.KARAOKE_SUFFIX);
  assert.equal(u.searchParams.get('hl'), 'pt-BR');
});

test('buscar: karaoke=false não acrescenta o sufixo', async () => {
  let pedida;
  await buscar('evidências', {
    karaoke: false,
    fetchImpl: async (u) => { pedida = u; return { ok: true, status: 200, text: async () => html }; },
  });
  assert.equal(new URL(pedida).searchParams.get('search_query'), 'evidências');
});

test('buscar: falhas viram busca_falhou', async () => {
  await assert.rejects(buscar('x', { fetchImpl: async () => { throw new Error('rede'); } }), { codigo: 'busca_falhou' });
  await assert.rejects(buscar('x', { fetchImpl: async () => ({ ok: false, status: 429, text: async () => '' }) }), { codigo: 'busca_falhou' });
  await assert.rejects(buscar('x', { fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html></html>' }) }), { codigo: 'busca_falhou' });
  await assert.rejects(buscar('   ', { fetchImpl: async () => { throw new Error('não deveria chamar'); } }), { codigo: 'busca_falhou' });
});

const htmlLockup = readFileSync(fileURLToPath(new URL('../fixtures/search-lockup.html', import.meta.url)), 'utf8');

test('parseResultsHtml: variante lockupViewModel (A/B do YouTube), ignora playlist/mix e ao vivo', () => {
  const itens = parseResultsHtml(htmlLockup);
  assert.deepEqual(itens[0], {
    videoId: 'tfhwXKd1W_o',
    titulo: 'Evidências - Chitãozinho e Xororó (Karaokê Version)',
    canal: 'Singer! Karaokê',
    duracao: '4:58',
  });
  const ids = itens.map((i) => i.videoId);
  assert.equal(itens.length, 4);
  assert.ok(!ids.some((id) => id.startsWith('RD')), 'mix/playlist');
  assert.ok(!ids.includes('LIVE_ID_002'), 'ao vivo');
  for (const i of itens) assert.match(i.duracao, /^\d+:\d{2}$/);
});
