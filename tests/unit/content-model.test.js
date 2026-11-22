// Testa a lógica pura do content script (modelo do painel e decisões do player).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  panelModel, textoConns, videoIdFromHref, watchPath, novaSessao, avaliar, deveSilenciar,
  TEXTOS, MAX_PROXIMOS, PLAY_TIMEOUT_MS, statusPlayer, aplicarControle,
} from '../../extension/src/content/panel-model.js';
import { CONFIG } from '../../extension/src/shared/protocol.js';

const item = (n, quem = `pessoa${n}`) => ({ itemId: `i${n}`, videoId: `v${n}`, titulo: `Música ${n}`, pedidoPor: quem });
const SITE = 'https://exemplo.github.io/ktv/';

test('ocioso sem sala: "Conectando…" e sem URL', () => {
  const m = panelModel({ state: { atual: null, fila: [], tocando: false }, conns: 0 });
  assert.equal(m.modo, 'ocioso');
  assert.equal(m.conectando, true);
  assert.equal(m.url, null);
  assert.equal(m.urlTexto, '');
  assert.equal(m.aviso, null);
  assert.deepEqual(m.itens, []);
});

test('ocioso com sala: URL no formato roomUrl e instrução em pt-BR', () => {
  const m = panelModel({ state: { atual: null, fila: [] }, roomId: 'abc-123', siteUrl: SITE, conns: 0, signaling: true });
  assert.equal(m.modo, 'ocioso');
  assert.equal(m.conectando, false);
  assert.equal(m.url, `${SITE}#sala=abc-123`);
  assert.equal(m.urlTexto, m.url);
  assert.match(m.instrucao, /Escaneie com o celular/);
  assert.match(m.instrucao, /mesma rede/);
});

test('siteUrl ausente cai para CONFIG.SITE_URL', () => {
  const m = panelModel({ state: {}, roomId: 'x' });
  assert.equal(m.url, `${CONFIG.SITE_URL}#sala=x`);
});

test('tocando: atual + próximos (máx. 5) + "+N"', () => {
  const fila = [1, 2, 3, 4, 5, 6, 7].map((n) => item(n));
  const m = panelModel({
    state: { atual: item(0, 'Ana'), fila, tocando: true }, roomId: 'r', siteUrl: SITE, conns: 3, signaling: true,
  });
  assert.equal(m.modo, 'tocando');
  assert.equal(m.itens.length, 1 + MAX_PROXIMOS);
  assert.equal(m.itens[0].atual, true);
  assert.equal(m.itens[0].pedidoPor, 'Ana');
  assert.equal(m.itens[1].atual, false);
  assert.equal(m.itens[5].titulo, 'Música 5');
  assert.equal(m.maisN, 2);
  assert.equal(m.connsTexto, '3 celulares conectados');
});

test('sem "+N" quando cabe tudo; fila sem atual ainda é modo tocando', () => {
  const m = panelModel({ state: { atual: null, fila: [item(1), item(2)] }, roomId: 'r' });
  assert.equal(m.modo, 'tocando');
  assert.equal(m.maisN, 0);
  assert.equal(m.itens.length, 2);
  assert.ok(m.itens.every((i) => i.atual === false));
});

test('aviso só quando signaling === false', () => {
  assert.equal(panelModel({ state: {}, signaling: false }).aviso, TEXTOS.semConexao);
  assert.equal(panelModel({ state: {}, signaling: true }).aviso, null);
  assert.equal(panelModel({ state: {} }).aviso, null);
});

test('textoConns: singular, plural e zero', () => {
  assert.equal(textoConns(0), 'Nenhum celular conectado');
  assert.equal(textoConns(1), '1 celular conectado');
  assert.equal(textoConns(2), '2 celulares conectados');
});

test('conns inválido vira 0', () => {
  for (const c of [undefined, null, -1, NaN, 'x']) assert.equal(panelModel({ state: {}, conns: c }).conns, 0);
});

test('entradas inválidas não lançam e título vazio ganha texto padrão', () => {
  for (const p of [undefined, null, 42, 'x', {}, { state: null }, { state: { fila: 'x' } }]) {
    assert.doesNotThrow(() => panelModel(p));
    assert.equal(panelModel(p).modo, 'ocioso');
  }
  const m = panelModel({ state: { atual: { titulo: '  ' }, fila: [null] } });
  assert.equal(m.itens[0].titulo, TEXTOS.semTitulo);
  assert.equal(m.itens[1].titulo, TEXTOS.semTitulo);
});

test('videoIdFromHref e watchPath', () => {
  assert.equal(videoIdFromHref('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1'), 'dQw4w9WgXcQ');
  assert.equal(videoIdFromHref('/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(videoIdFromHref('https://www.youtube.com/?ktv=1'), null);
  assert.equal(videoIdFromHref('https://www.youtube.com/watch?v=curto'), null);
  assert.equal(videoIdFromHref('::::'), null);
  assert.equal(watchPath('dQw4w9WgXcQ'), '/watch?v=dQw4w9WgXcQ');
  assert.equal(watchPath('inválido'), null);
  assert.equal(watchPath(undefined), null);
});

// ---- decisões do player ----
const ID = 'dQw4w9WgXcQ';
const obs = (o = {}) => ({
  urlVideoId: ID, emWatch: true, temVideo: true, pausado: false, terminou: false,
  tocando: true, anuncio: false, erroNoPlayer: false, ...o,
});

test('ended: enviado UMA vez por reprodução, com pausa', () => {
  const s = novaSessao(ID, 0);
  assert.deepEqual(avaliar(s, obs(), 1000), []);
  assert.equal(s.viuPlaying, true);
  const fim = obs({ tocando: false, pausado: true, terminou: true });
  assert.deepEqual(avaliar(s, fim, 2000), ['pausar', 'enviarEnded']);
  assert.deepEqual(avaliar(s, fim, 3000), []);
  assert.deepEqual(avaliar(s, fim, 99999), []);
});

test('ended ignorado sem ter visto `playing` (vídeo reaproveitado) e durante anúncio', () => {
  const s = novaSessao(ID, 0);
  const velho = obs({ tocando: false, pausado: true, terminou: true });
  assert.ok(!avaliar(s, velho, 100).includes('enviarEnded'));
  const s2 = novaSessao(ID, 0);
  avaliar(s2, obs(), 100);
  assert.ok(!avaliar(s2, obs({ terminou: true, pausado: true, tocando: false, anuncio: true }), 200).includes('enviarEnded'));
});

test('anúncio: não conta como playing, não dispara timeout e o fim do anúncio não é o fim da música', () => {
  const s = novaSessao(ID, 0);
  const ad = obs({ anuncio: true });
  // 3 anúncios seguidos de 30 s cada: nada de enviarErro/enviarEnded
  for (let t = 1000; t <= 90000; t += 1000) assert.deepEqual(avaliar(s, ad, t), []);
  assert.equal(s.viuPlaying, false);
  // vídeo "terminado" logo depois do anúncio, antes de a música tocar: não é ended
  assert.ok(!avaliar(s, obs({ terminou: true, pausado: true, tocando: false }), 91000).includes('enviarEnded'));
  // timeout conta a partir do fim do anúncio
  const parado = obs({ tocando: false, pausado: true });
  assert.ok(!avaliar(s, parado, 90000 + PLAY_TIMEOUT_MS - 1).includes('enviarErro'));
  // a música toca e termina normalmente
  const s2 = novaSessao(ID, 0);
  avaliar(s2, ad, 1000);
  avaliar(s2, obs(), 40000);
  assert.deepEqual(avaliar(s2, obs({ terminou: true, pausado: true, tocando: false }), 200000), ['pausar', 'enviarEnded']);
});

test('ended ignorado se a URL ainda é de outro vídeo', () => {
  const s = novaSessao(ID, 0);
  avaliar(s, obs(), 100);
  assert.deepEqual(avaliar(s, obs({ urlVideoId: 'OUTROvideo1', terminou: true, tocando: false }), 200), []);
});

test('timeout de 15 s sem playing -> um playerError', () => {
  const s = novaSessao(ID, 0);
  const parado = obs({ tocando: false, pausado: true });
  assert.ok(!avaliar(s, parado, PLAY_TIMEOUT_MS - 1).includes('enviarErro'));
  assert.deepEqual(avaliar(s, parado, PLAY_TIMEOUT_MS), ['pausar', 'enviarErro']);
  assert.deepEqual(avaliar(s, parado, PLAY_TIMEOUT_MS + 5000), []);
});

test('timeout não corre enquanto aguarda clique em "Tocar"; playing cancela o timeout', () => {
  const s = novaSessao(ID, 0);
  s.bloqueado = true;
  assert.deepEqual(avaliar(s, obs({ tocando: false, pausado: true }), PLAY_TIMEOUT_MS * 3), []);
  const s2 = novaSessao(ID, 0);
  avaliar(s2, obs(), 5000);
  assert.deepEqual(avaliar(s2, obs(), PLAY_TIMEOUT_MS * 2), []);
});

test('erro do player exige 2 avaliações seguidas e é enviado uma vez', () => {
  const s = novaSessao(ID, 0);
  const e = obs({ tocando: false, pausado: true, erroNoPlayer: true });
  assert.ok(!avaliar(s, e, 1000).includes('enviarErro'));
  assert.deepEqual(avaliar(s, e, 2000), ['pausar', 'enviarErro']);
  assert.deepEqual(avaliar(s, e, 3000), []);
});

test('erro que some entre avaliações não dispara', () => {
  const s = novaSessao(ID, 0);
  avaliar(s, obs({ tocando: false, pausado: true, erroNoPlayer: true }), 1000);
  avaliar(s, obs({ tocando: false, pausado: true, erroNoPlayer: false }), 2000);
  assert.ok(!avaliar(s, obs({ tocando: false, pausado: true, erroNoPlayer: true }), 3000).includes('enviarErro'));
});

test('tenta tocar quando pausado, com intervalo mínimo entre tentativas', () => {
  const s = novaSessao(ID, 0);
  const p = obs({ tocando: false, pausado: true });
  assert.deepEqual(avaliar(s, p, 2000), ['tocar']);
  assert.deepEqual(avaliar(s, p, 2500), []);
  assert.deepEqual(avaliar(s, p, 3600), ['tocar']);
  // vídeo reaproveitado já terminado também recebe play() (reinicia)
  const s2 = novaSessao(ID, 0);
  assert.deepEqual(avaliar(s2, obs({ tocando: false, pausado: true, terminou: true }), 2000), ['tocar']);
});

test('sem sessão ou sessão encerrada: nenhuma ação', () => {
  assert.deepEqual(avaliar(null, obs(), 0), []);
  const s = novaSessao(ID, 0);
  s.endedEnviado = true;
  assert.deepEqual(avaliar(s, obs(), PLAY_TIMEOUT_MS * 2), []);
});

test('guarda anti-autoplay: silencia vídeo que toca sem sessão ativa', () => {
  const tocando = { emWatch: true, pausado: false, urlVideoId: 'OUTROvideo1' };
  assert.equal(deveSilenciar(null, tocando), true);
  const s = novaSessao(ID, 0);
  assert.equal(deveSilenciar(s, tocando), true); // YouTube trocou para outro vídeo
  assert.equal(deveSilenciar(s, { ...tocando, urlVideoId: ID }), false);
  s.endedEnviado = true;
  assert.equal(deveSilenciar(s, { ...tocando, urlVideoId: ID }), true); // pós-fim
  assert.equal(deveSilenciar(null, { ...tocando, pausado: true }), false);
  assert.equal(deveSilenciar(null, { ...tocando, emWatch: false }), false);
});

test('content.js tem sintaxe válida (node --check)', () => {
  const arq = fileURLToPath(new URL('../../extension/src/content/content.js', import.meta.url));
  const r = spawnSync(process.execPath, ['--check', arq], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('aplicarControle: pause, saltos limitados, mudo e volume', () => {
  const v = { paused: false, muted: false, volume: 0.5, currentTime: 5, duration: 100, pause() { this.paused = true; } };
  assert.equal(aplicarControle(v, 'pause'), null);
  assert.equal(v.paused, true);
  assert.equal(aplicarControle(v, 'play'), 'tocar');
  aplicarControle(v, 'back');
  assert.equal(v.currentTime, 0, 'não passa de 0');
  v.currentTime = 95;
  aplicarControle(v, 'forward');
  assert.equal(v.currentTime, 100, 'não passa da duração');
  aplicarControle(v, 'restart');
  assert.equal(v.currentTime, 0);
  aplicarControle(v, 'mute');
  assert.equal(v.muted, true);
  aplicarControle(v, 'volUp');
  assert.equal(v.muted, false);
  assert.equal(v.volume, 0.6);
  aplicarControle(v, 'volDown');
  aplicarControle(v, 'volDown');
  assert.equal(v.volume, 0.4);
  v.volume = 0.05;
  aplicarControle(v, 'volDown');
  assert.equal(v.volume, 0);
  aplicarControle(v, 'unmute');
  assert.equal(v.volume, 0.1, 'desmutar com volume 0 sobe um passo');
  assert.equal(aplicarControle(v, 'lixo'), null);
});

test('statusPlayer: pausado, mudo (ou volume 0) e volume em %', () => {
  assert.deepEqual(statusPlayer({ paused: true, muted: false, volume: 0.35 }), { pausado: true, mudo: false, volume: 35 });
  assert.equal(statusPlayer({ paused: false, muted: false, volume: 0 }).mudo, true);
  assert.equal(statusPlayer({ paused: false, muted: true, volume: 1 }).mudo, true);
});
