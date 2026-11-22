// Testa a ponte do mundo principal (ponte-pagina.js) com um DOM mínimo simulado:
// pedidos síncronos por evento, resposta no atributo do <html>, só métodos permitidos e yt-navigate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const codigo = readFileSync(new URL('../../extension/src/content/ponte-pagina.js', import.meta.url), 'utf8');

function montar({ comApi = true, comApp = true } = {}) {
  const chamadas = [];
  const navegacoes = [];
  const attrs = new Map();
  const ouvintes = new Map();
  const player = comApi ? {
    volume: 70, mudo: false,
    getVolume() { return this.volume; }, isMuted() { return this.mudo; },
    setVolume(n) { chamadas.push(['setVolume', n]); this.volume = n; },
    mute() { chamadas.push(['mute']); this.mudo = true; },
    unMute() { chamadas.push(['unMute']); this.mudo = false; },
    pauseVideo() { chamadas.push(['pauseVideo']); },
  } : {};
  const app = { dispatchEvent(e) { navegacoes.push(e); return true; } };
  class CustomEvent { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } }
  const document = {
    documentElement: {
      setAttribute: (k, v) => attrs.set(k, String(v)),
      getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
      removeAttribute: (k) => attrs.delete(k),
    },
    getElementById: (id) => (id === 'movie_player' ? player : null),
    querySelector: (sel) => (sel === 'ytd-app' && comApp ? app : null),
    addEventListener: (t, f) => ouvintes.set(t, f),
  };
  const window = {};
  vm.runInNewContext(codigo, { window, document, CustomEvent, JSON, Number, Boolean, String, Array, Object });
  let id = 0;
  const pedir = (op, dados = {}) => {
    const meu = ++id;
    ouvintes.get('ktv:pedido')({ detail: JSON.stringify({ ...dados, op, id: meu }) });
    const r = JSON.parse(attrs.get('data-ktv-resposta'));
    assert.equal(r.id, meu);
    return r;
  };
  return { pedir, chamadas, navegacoes, player, ouvintes, window };
}

test('status lê volume/mudo da API do player', () => {
  const { pedir } = montar();
  assert.deepEqual(pedir('status'), { ok: true, volume: 70, mudo: false, id: 1 });
});

test('sem API do player: ok:false (o content cai no <video>)', () => {
  const { pedir } = montar({ comApi: false });
  assert.equal(pedir('status').ok, false);
  assert.equal(pedir('chamar', { chamadas: [['mute']] }).ok, false);
});

test('chamar executa só setVolume/mute/unMute e devolve o status novo', () => {
  const { pedir, chamadas } = montar();
  const r = pedir('chamar', { chamadas: [['setVolume', 40], ['mute'], ['pauseVideo'], ['setVolume', 'x'], 'lixo'] });
  assert.deepEqual(chamadas, [['setVolume', 40], ['mute']]);
  assert.equal(r.ok, true);
  assert.equal(r.mudo, true);
});

test('navegar dispara yt-navigate no ytd-app com o endpoint de watch', () => {
  const { pedir, navegacoes } = montar();
  assert.equal(pedir('navegar', { videoId: 'abcdefghijk' }).ok, true);
  assert.equal(navegacoes.length, 1);
  const e = navegacoes[0];
  assert.equal(e.type, 'yt-navigate');
  assert.equal(e.bubbles, true);
  assert.equal(e.detail.endpoint.watchEndpoint.videoId, 'abcdefghijk');
  assert.equal(e.detail.endpoint.commandMetadata.webCommandMetadata.url, '/watch?v=abcdefghijk');
  assert.equal(pedir('navegar', { videoId: 'curto' }).ok, false, 'ID inválido');
  assert.equal(navegacoes.length, 1);
});

test('navegar sem ytd-app: ok:false', () => {
  const { pedir } = montar({ comApp: false });
  assert.equal(pedir('navegar', { videoId: 'abcdefghijk' }).ok, false);
});

test('pedido inválido ou op desconhecida é ignorado (sem resposta)', () => {
  const { ouvintes } = montar();
  const h = ouvintes.get('ktv:pedido');
  assert.doesNotThrow(() => h({ detail: '{não é json' }));
  assert.doesNotThrow(() => h({ detail: JSON.stringify({ op: 'constructor', id: 1 }) }));
  assert.doesNotThrow(() => h({ detail: JSON.stringify({ op: 'eval', id: 1 }) }));
});
