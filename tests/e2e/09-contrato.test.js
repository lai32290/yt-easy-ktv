// Contrato: toda mensagem trocada (celular<->SW<->offscreen<->content) tem `t` válido e o formato do protocol.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comAmbiente, ate } from './helpers/ambiente.js';
import { C2E, E2C, INT, TARGET, ERR } from '../../extension/src/shared/protocol.js';

const ID = (n) => `hhhhhhhhhh${n}`;
const valores = (o) => new Set(Object.values(o));

const ITEM_CAMPOS = ['itemId', 'videoId', 'titulo', 'canal', 'duracao', 'pedidoPor', 'pid', 'addedAt'];
function conferirItem(it, onde) {
  for (const c of ITEM_CAMPOS) assert.ok(c in it, `${onde}: item sem ${c}`);
  assert.equal(typeof it.itemId, 'string');
  assert.match(it.videoId, /^[\w-]{11}$/);
  assert.equal(typeof it.titulo, 'string');
  assert.equal(typeof it.pid, 'string');
}
function conferirE2c(m, onde) {
  assert.ok(valores(E2C).has(m.t), `${onde}: t inválido "${m.t}"`);
  if (m.t === E2C.STATE) {
    assert.equal(typeof m.tocando, 'boolean');
    assert.ok(Array.isArray(m.fila));
    assert.ok(m.atual === null || typeof m.atual === 'object');
    if (m.atual) conferirItem(m.atual, `${onde} atual`);
    m.fila.forEach((i) => conferirItem(i, `${onde} fila`));
    assert.ok(!m.fila.some((i) => m.atual && i.itemId === m.atual.itemId), 'a fila não pode incluir a música atual');
  } else if (m.t === E2C.RESULTS) {
    assert.ok(m.id !== undefined);
    assert.ok(Array.isArray(m.itens));
    for (const r of m.itens) for (const c of ['videoId', 'titulo', 'canal', 'duracao']) assert.ok(c in r, `${onde}: resultado sem ${c}`);
  } else if (m.t === E2C.ERROR) {
    assert.ok(valores(ERR).has(m.codigo), `${onde}: código de erro desconhecido "${m.codigo}"`);
    assert.equal(typeof m.msg, 'string');
  }
}

test('i) toda mensagem trocada tem `t` do contrato (celular, offscreen, SW e content script)', { timeout: 180000 }, () => comAmbiente('contrato', async (amb) => {
  amb.yt.duracao = 2;
  amb.yt.indisponiveis.add(ID(3));
  const sw = await amb.sw();
  await sw.evaluate(() => {
    globalThis.__trafego = [];
    const reg = (dir, m) => { try { __trafego.push({ dir, m: JSON.parse(JSON.stringify(m)) }); } catch { /* ignora */ } };
    const rs = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (m, ...r) => { reg('sw->runtime', m); return rs(m, ...r); };
    const ts = chrome.tabs.sendMessage.bind(chrome.tabs);
    chrome.tabs.sendMessage = (id, m, ...r) => { reg('sw->tab', m); return ts(id, m, ...r); };
    chrome.runtime.onMessage.addListener((m) => { reg('->sw', m); return false; });
  });

  await amb.prepararKtv(); // o gancho já está instalado: pega room/whoami/started/conns
  const ana = await amb.novoCelular('Ana');
  const cru = await ana.abrirCru({ pid: 'cru-1', nome: 'Cru' });

  // Cenário: busca, add por url e por videoId, link inválido, remove, move, skip, indisponível, fim.
  await cru.enviar({ t: C2E.SEARCH, id: 'b1', q: 'evidencias' });
  const res = await cru.esperar((m) => m.t === E2C.RESULTS && m.id === 'b1');
  assert.equal(res.itens.length, 5);
  await cru.enviar({ t: C2E.ADD, videoId: res.itens[0].videoId });
  await cru.enviar({ t: C2E.ADD, url: `https://youtu.be/${ID(1)}` });
  await cru.enviar({ t: C2E.ADD, url: `https://youtu.be/${ID(2)}` });
  await cru.enviar({ t: C2E.ADD, url: `https://youtu.be/${ID(3)}` });
  await cru.enviar({ t: C2E.ADD, url: 'nada a ver' });                      // inválido
  await cru.enviar({ t: C2E.ADD });                                         // sem videoId/url
  await cru.enviar({ t: 'zzz' });                                           // t desconhecido
  await cru.enviar({ t: C2E.MOVE, itemId: 'nao-existe', toIndex: 0 });
  await cru.esperar((m) => m.t === E2C.STATE && m.atual && m.fila.length === 3, 'state com atual + 3 na fila');
  const st = (await cru.mensagens()).filter((m) => m.t === E2C.STATE).at(-1);
  await cru.enviar({ t: C2E.MOVE, itemId: st.fila[2].itemId, toIndex: 0 });
  await cru.enviar({ t: C2E.REMOVE, itemId: st.fila[0].itemId });
  await cru.enviar({ t: C2E.SKIP });
  // passa pelo indisponível (ID3) e termina tudo
  await cru.esperar((m) => m.t === E2C.ERROR && m.codigo === ERR.VIDEO_INDISPONIVEL, 'erro de vídeo indisponível');
  await ate(async () => { const s = (await cru.mensagens()).filter((m) => m.t === E2C.STATE).at(-1); return s && !s.atual && s.fila.length === 0; }, { timeout: 60000, descricao: 'fila esgotada' });

  // --- confere o que o celular recebeu ---
  const recebidas = await cru.mensagens();
  assert.ok(recebidas.length > 5);
  recebidas.forEach((m, i) => conferirE2c(m, `celular #${i}`));
  const codigos = new Set(recebidas.filter((m) => m.t === E2C.ERROR).map((m) => m.codigo));
  for (const c of [ERR.LINK_INVALIDO, ERR.MSG_INVALIDA, ERR.NAO_ENCONTRADO, ERR.VIDEO_INDISPONIVEL]) {
    assert.ok(codigos.has(c), `deveria ter recebido o erro ${c}; recebeu ${[...codigos]}`);
  }

  // --- confere o tráfego interno visto pelo SW ---
  const trafego = await sw.evaluate(() => globalThis.__trafego);
  assert.ok(trafego.length > 20, `tráfego pequeno demais (${trafego.length})`);
  const internas = valores(INT); const alvos = valores(TARGET);
  const vistos = new Set();
  for (const { dir, m } of trafego) {
    assert.ok(internas.has(m.t), `${dir}: t interno inválido "${m.t}"`);
    assert.ok(alvos.has(m.target), `${dir}: target inválido "${m.target}" em ${m.t}`);
    vistos.add(m.t);
    if (dir === '->sw') {
      assert.equal(m.target, TARGET.SW);
      assert.ok([INT.ROOM, INT.PEER_MSG, INT.CONNS, INT.PEER_CLOSE, INT.WHOAMI, INT.STARTED, INT.ENDED, INT.PLAYER_ERROR].includes(m.t), `->sw: ${m.t} inesperado`);
      // 'zzz' é o `t` inválido que este próprio teste injeta (o SW deve responder msg_invalida)
      if (m.t === INT.PEER_MSG && m.msg.t !== 'zzz') assert.ok(valores(C2E).has(m.msg.t), `peerMsg com t do celular inválido "${m.msg.t}"`);
      if (m.t === INT.ROOM) assert.equal(typeof m.roomId, 'string');
      if (m.t === INT.CONNS) { assert.equal(typeof m.count, 'number'); assert.equal(typeof m.signaling, 'boolean'); }
    } else if (dir === 'sw->runtime') {
      assert.equal(m.target, TARGET.OFFSCREEN);
      assert.ok([INT.INIT_PEER, INT.SEND, INT.BROADCAST].includes(m.t), `sw->offscreen: ${m.t} inesperado`);
      if (m.t === INT.SEND || m.t === INT.BROADCAST) conferirE2c(m.msg, `sw ${m.t}`);
    } else if (dir === 'sw->tab') {
      assert.equal(m.target, TARGET.CONTENT);
      assert.ok([INT.PLAY, INT.IDLE, INT.PANEL].includes(m.t), `sw->content: ${m.t} inesperado`);
      if (m.t === INT.PLAY) assert.match(m.videoId, /^[\w-]{11}$/);
      if (m.t === INT.PANEL) {
        assert.ok(m.state && Array.isArray(m.state.fila));
        assert.equal(typeof m.conns, 'number');
        assert.equal(typeof m.roomId, 'string');
        assert.equal(typeof m.siteUrl, 'string');
      }
    }
  }
  for (const t of [INT.ROOM, INT.PEER_MSG, INT.CONNS, INT.WHOAMI, INT.STARTED, INT.ENDED, INT.PLAYER_ERROR, INT.SEND, INT.BROADCAST, INT.PLAY, INT.IDLE, INT.PANEL]) {
    assert.ok(vistos.has(t), `mensagem interna "${t}" nunca apareceu no cenário (cobertura do contrato)`);
  }
}));
