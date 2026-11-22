// Testa o núcleo do service worker (handlers.js) com fakes, sem Chrome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarNucleo, KEY_STATE, KEY_SIGNALING } from '../../extension/src/background/handlers.js';
import { CONFIG } from '../../extension/src/shared/protocol.js';

const KTV_TAB = 7;
const sender = (tabId = KTV_TAB) => ({ tab: { id: tabId } });
const V1 = 'aaaaaaaaaa1'; const V2 = 'aaaaaaaaaa2'; const V3 = 'aaaaaaaaaa3';

// Monta um núcleo com dependências falsas; `storageMap` pode ser reaproveitado para simular "SW acordando".
function montar({ storageMap = new Map(), oembed, buscar, offscreenExiste = false, offscreenNovo = false, respostasOff } = {}) {
  let n = 0;
  const log = { off: [], tab: [], criadas: 0, focos: 0, abas: new Set([KTV_TAB]) };
  const storage = {
    get: async (k) => (storageMap.has(k) ? structuredClone(storageMap.get(k)) : undefined),
    set: async (k, v) => { storageMap.set(k, structuredClone(v)); },
  };
  const nucleo = criarNucleo({
    storage,
    send: async (m) => {
      log.off.push(m);
      if (respostasOff && respostasOff.length) { const r = respostasOff.shift(); if (r instanceof Error) throw r; return r; }
      return { ok: true };
    },
    sendToTab: async (tabId, m) => {
      if (!log.abas.has(tabId)) throw new Error('sem aba');
      log.tab.push({ tabId, ...m });
    },
    ensureOffscreen: async () => offscreenExiste || offscreenNovo,
    janelas: {
      criar: async () => { log.criadas++; log.abas.add(KTV_TAB); return { tabId: KTV_TAB, windowId: 70 }; },
      focar: async (tabId) => { log.focos++; return log.abas.has(tabId); },
      recarregar: async (tabId) => { (log.recargas ||= []).push(tabId); return log.abas.has(tabId); },
    },
    buscar: buscar || (async () => [{ videoId: V1, titulo: 'Achado', canal: 'Can', duracao: '3:00' }]),
    oembed: oembed || (async (id) => ({ titulo: `Título ${id}`, canal: 'Canal' })),
    now: () => 1000 + (n++),
    uuid: () => `uuid-${n++}`,
    sleep: async () => {},
  });
  const peer = (connId, msg, pid) => nucleo.handleMessage({ t: 'peerMsg', target: 'sw', connId, pid, msg });
  const int = (t, extra = {}, s) => nucleo.handleMessage({ t, target: 'sw', ...extra }, s);
  const paraConn = (connId) => log.off.filter((m) => m.t === 'send' && m.connId === connId).map((m) => m.msg);
  const broadcasts = () => log.off.filter((m) => m.t === 'broadcast').map((m) => m.msg);
  const ultimoState = () => broadcasts().filter((m) => m.t === 'state').at(-1);
  const comandosTab = (t) => log.tab.filter((m) => m.t === t);
  return { nucleo, storageMap, log, peer, int, paraConn, broadcasts, ultimoState, comandosTab };
}

async function prepararKtv(h) {
  await h.nucleo.abrirKtv();
  await h.peer('c1', { t: 'hello', nome: 'Ana', pid: 'pidA' });
  await h.peer('c2', { t: 'hello', nome: 'Beto', pid: 'pidB' });
}

test('init: envia initPeer com a sinalização padrão e o roomId salvo', async () => {
  const h = montar();
  await h.int('room', { roomId: 'sala-1' });
  await h.nucleo.init();
  const init = h.log.off.find((m) => m.t === 'initPeer');
  assert.equal(init.target, 'offscreen');
  assert.equal(init.roomId, 'sala-1');
  assert.deepEqual(init.signaling, CONFIG.SIGNALING);
});

test('init: usa o override ktv_signaling do storage', async () => {
  const h = montar();
  h.storageMap.set(KEY_SIGNALING, { host: 'meu.servidor', port: 9000, path: '/p', secure: false });
  await h.nucleo.init();
  const init = h.log.off.find((m) => m.t === 'initPeer');
  assert.equal(init.signaling.host, 'meu.servidor');
  assert.equal(init.roomId, undefined);
});

test('ignora mensagens com target diferente de sw', async () => {
  const h = montar();
  assert.equal(await h.nucleo.handleMessage({ t: 'room', target: 'offscreen', roomId: 'x' }), undefined);
  assert.equal(await h.nucleo.handleMessage({ t: 'room', roomId: 'x' }), undefined);
  assert.equal((await h.nucleo._estado()).estado.roomId, null);
});

test('hello registra nome/pid e responde state só àquela conexão', async () => {
  const h = montar();
  await h.peer('c1', { t: 'hello', nome: '  Ana  ', pid: 'pidA' });
  const [m] = h.paraConn('c1');
  assert.equal(m.t, 'state');
  assert.deepEqual(m.fila, []);
  assert.equal((await h.nucleo._estado()).rt.peers.c1.nome, 'Ana');
  assert.equal(h.broadcasts().length, 0);
});

test('hello inválido -> msg_invalida', async () => {
  const h = montar();
  await h.peer('c1', { t: 'hello', nome: 'Ana' }); // sem pid
  assert.equal(h.paraConn('c1')[0].codigo, 'msg_invalida');
});

test('msg inválida / tipo desconhecido -> error msg_invalida', async () => {
  const h = montar();
  await h.peer('c1', 'lixo');
  await h.peer('c1', { t: 'foo' });
  await h.peer('c1', { sem: 't' });
  assert.deepEqual(h.paraConn('c1').map((m) => m.codigo), ['msg_invalida', 'msg_invalida', 'msg_invalida']);
});

test('fluxo completo: add -> state -> started -> play -> ended -> play próximo -> idle', async () => {
  const h = montar();
  await prepararKtv(h);

  await h.peer('c1', { t: 'add', videoId: V1 });
  await h.peer('c2', { t: 'add', url: `https://youtu.be/${V2}?t=5` });
  let st = h.ultimoState();
  assert.equal(st.fila.length, 2);
  assert.equal(st.atual, null);
  assert.equal(st.fila[0].pedidoPor, 'Ana');
  assert.equal(st.fila[0].pid, 'pidA');
  assert.equal(st.fila[1].pedidoPor, 'Beto');
  assert.equal(st.fila[0].titulo, `Título ${V1}`);
  assert.ok(st.fila[0].itemId && st.fila[0].addedAt);
  assert.equal(h.comandosTab('play').length, 0, 'não toca antes do "Iniciar"');

  await h.int('started', {}, sender());
  assert.deepEqual(h.comandosTab('play').map((m) => m.videoId), [V1]);
  st = h.ultimoState();
  assert.equal(st.atual.videoId, V1);
  assert.equal(st.tocando, true);
  assert.equal(st.fila.length, 1);

  await h.int('ended', {}, sender());
  assert.deepEqual(h.comandosTab('play').map((m) => m.videoId), [V1, V2]);
  assert.equal(h.ultimoState().atual.videoId, V2);

  await h.int('ended', {}, sender());
  assert.equal(h.comandosTab('idle').length, 1);
  st = h.ultimoState();
  assert.equal(st.atual, null);
  assert.equal(st.tocando, false);

  // ocioso + novo item + já liberado -> toca direto
  await h.peer('c1', { t: 'add', videoId: V3 });
  assert.deepEqual(h.comandosTab('play').map((m) => m.videoId), [V1, V2, V3]);
  assert.equal(h.ultimoState().atual.videoId, V3);

  // add enquanto toca não reinicia a música atual
  await h.peer('c2', { t: 'add', videoId: V1 });
  assert.deepEqual(h.comandosTab('play').map((m) => m.videoId), [V1, V2, V3]);
});

test('painel: content da aba KTV recebe `panel` a cada mudança', async () => {
  const h = montar();
  await prepararKtv(h);
  await h.int('room', { roomId: 'sala-9' });
  await h.int('conns', { count: 2, signaling: true });
  await h.peer('c1', { t: 'add', videoId: V1 });
  const p = h.comandosTab('panel').at(-1);
  assert.equal(p.tabId, KTV_TAB);
  assert.equal(p.target, 'content');
  assert.equal(p.roomId, 'sala-9');
  assert.equal(p.siteUrl, CONFIG.SITE_URL);
  assert.equal(p.conns, 2);
  assert.equal(p.signaling, true);
  assert.equal(p.state.fila.length, 1);
});

test('dedup: mesmo videoId na fila ou tocando -> error duplicado só para quem pediu', async () => {
  const h = montar();
  await prepararKtv(h);
  await h.peer('c1', { t: 'add', videoId: V1 });
  await h.peer('c2', { t: 'add', url: `https://www.youtube.com/watch?v=${V1}&list=PL1` });
  assert.equal(h.paraConn('c2').at(-1).codigo, 'duplicado');
  assert.equal(h.ultimoState().fila.length, 1);
  await h.int('started', {}, sender());
  await h.peer('c2', { t: 'add', videoId: V1 }); // agora é o atual
  assert.equal(h.paraConn('c2').at(-1).codigo, 'duplicado');
});

test('add: adds concorrentes do mesmo vídeo não duplicam', async () => {
  const h = montar({ oembed: async (id) => { await new Promise((r) => setTimeout(r, 5)); return { titulo: id, canal: '' }; } });
  await prepararKtv(h);
  await Promise.all([
    h.peer('c1', { t: 'add', videoId: V1 }),
    h.peer('c2', { t: 'add', videoId: V1 }),
  ]);
  assert.equal((await h.nucleo._estado()).estado.fila.length, 1);
  assert.equal(h.paraConn('c2').some((m) => m.codigo === 'duplicado') || h.paraConn('c1').some((m) => m.codigo === 'duplicado'), true);
});

test('add: link inválido, videoId inválido e msg sem campos', async () => {
  const h = montar();
  await h.peer('c1', { t: 'add', url: 'https://exemplo.com/x' });
  await h.peer('c1', { t: 'add', videoId: 'curto' });
  await h.peer('c1', { t: 'add' });
  assert.deepEqual(h.paraConn('c1').map((m) => m.codigo), ['link_invalido', 'link_invalido', 'msg_invalida']);
});

test('add: oEmbed falha -> video_indisponivel; 401 entra com título provisório', async () => {
  const h = montar({
    oembed: async (id) => {
      throw Object.assign(new Error('x'), { codigo: 'video_indisponivel', status: id === V2 ? 401 : 404 });
    },
  });
  await h.peer('c1', { t: 'add', videoId: V1 });
  assert.equal(h.paraConn('c1').at(-1).codigo, 'video_indisponivel');
  await h.peer('c1', { t: 'add', videoId: V2 });
  assert.equal(h.ultimoState().fila[0].titulo, `Vídeo ${V2}`);
});

test('remove: só o dono; não-dono recebe sem_permissao', async () => {
  const h = montar();
  await prepararKtv(h);
  await h.peer('c1', { t: 'add', videoId: V1 });
  const itemId = h.ultimoState().fila[0].itemId;

  await h.peer('c2', { t: 'remove', itemId });
  assert.equal(h.paraConn('c2').at(-1).codigo, 'sem_permissao');
  assert.equal(h.ultimoState().fila.length, 1);

  await h.peer('c2', { t: 'remove', itemId: 'nao-existe' });
  assert.equal(h.paraConn('c2').at(-1).codigo, 'nao_encontrado');

  await h.peer('c1', { t: 'remove', itemId });
  assert.equal(h.ultimoState().fila.length, 0);
});

test('remove: pid estável sobrevive a uma nova conexão (reconexão)', async () => {
  const h = montar();
  await prepararKtv(h);
  await h.peer('c1', { t: 'add', videoId: V1 });
  const itemId = h.ultimoState().fila[0].itemId;
  await h.int('peerClose', { connId: 'c1' });
  await h.peer('c9', { t: 'hello', nome: 'Ana', pid: 'pidA' });
  await h.peer('c9', { t: 'remove', itemId });
  assert.equal(h.ultimoState().fila.length, 0);
});

test('pid vindo no envelope do offscreen é aceito sem hello prévio', async () => {
  const h = montar();
  await h.peer('c5', { t: 'add', videoId: V1 }, 'pidZ');
  assert.equal(h.ultimoState().fila[0].pid, 'pidZ');
});

test('skip: qualquer um pula a atual (SKIP_POLICY todos); sem atual não faz nada', async () => {
  const h = montar();
  await prepararKtv(h);
  await h.peer('c2', { t: 'skip' });
  assert.equal(h.broadcasts().length, 0);
  await h.peer('c1', { t: 'add', videoId: V1 });
  await h.peer('c1', { t: 'add', videoId: V2 });
  await h.int('started', {}, sender());
  await h.peer('c2', { t: 'skip' });
  assert.equal(h.ultimoState().atual.videoId, V2);
  assert.deepEqual(h.comandosTab('play').map((m) => m.videoId), [V1, V2]);
});

test('move: reordena e valida entrada', async () => {
  const h = montar();
  await h.peer('c1', { t: 'add', videoId: V1 });
  await h.peer('c1', { t: 'add', videoId: V2 });
  const ids = h.ultimoState().fila.map((i) => i.itemId);
  await h.peer('c1', { t: 'move', itemId: ids[1], toIndex: 0 });
  assert.deepEqual(h.ultimoState().fila.map((i) => i.itemId), [ids[1], ids[0]]);
  await h.peer('c1', { t: 'move', itemId: ids[1], toIndex: 'x' });
  assert.equal(h.paraConn('c1').at(-1).codigo, 'msg_invalida');
  await h.peer('c1', { t: 'move', itemId: 'zzz', toIndex: 0 });
  assert.equal(h.paraConn('c1').at(-1).codigo, 'nao_encontrado');
});

test('playerError: registra, avisa todos, pula e toca o próximo', async () => {
  const h = montar();
  await prepararKtv(h);
  await h.peer('c1', { t: 'add', videoId: V1 });
  await h.peer('c1', { t: 'add', videoId: V2 });
  await h.int('started', {}, sender());
  await h.int('playerError', { codigo: 'timeout' }, sender());
  const erro = h.broadcasts().find((m) => m.t === 'error');
  assert.equal(erro.codigo, 'video_indisponivel');
  assert.equal(erro.msg, `Título ${V1} indisponível, pulada`);
  assert.equal(h.ultimoState().atual.videoId, V2);
  assert.deepEqual(h.comandosTab('play').map((m) => m.videoId), [V1, V2]);
  // erro no último -> idle
  await h.int('playerError', { codigo: 'timeout' }, sender());
  assert.equal(h.ultimoState().atual, null);
  assert.equal(h.comandosTab('idle').length, 1);
});

test('ended/playerError duplicado ou atrasado não pula a música seguinte', async () => {
  const h = montar();
  await prepararKtv(h);
  for (const v of [V1, V2, V3]) await h.peer('c1', { t: 'add', videoId: v });
  await h.int('started', {}, sender());
  await h.int('ended', { videoId: V1 }, sender());
  await h.int('ended', { videoId: V1 }, sender()); // duplicado: o atual agora é V2
  assert.equal(h.ultimoState().atual.videoId, V2);
});

test('eventos do player só valem vindos da aba KTV', async () => {
  const h = montar();
  await prepararKtv(h);
  await h.peer('c1', { t: 'add', videoId: V1 });
  await h.int('started', {}, sender(99)); // aba qualquer do YouTube
  assert.equal(h.ultimoState().atual, null);
  await h.int('started', {}, undefined);
  assert.equal(h.comandosTab('play').length, 0);
});

test('search: results só à conexão que pediu, com id; karaoke repassado', async () => {
  const chamadas = [];
  const h = montar({ buscar: async (q, o) => { chamadas.push([q, o]); return [{ videoId: V1, titulo: 'A', canal: 'B', duracao: '1:00' }]; } });
  await h.peer('c1', { t: 'search', id: 'r1', q: 'evidências' });
  await h.peer('c1', { t: 'search', id: 'r2', q: 'x', karaoke: false });
  const rs = h.paraConn('c1');
  assert.equal(rs[0].t, 'results');
  assert.equal(rs[0].id, 'r1');
  assert.equal(rs[0].itens.length, 1);
  assert.deepEqual(chamadas.map((c) => c[1].karaoke), [true, false]);
  assert.equal(h.broadcasts().length, 0);
});

test('search: usa os metadados do resultado ao adicionar (sem oEmbed)', async () => {
  let oembeds = 0;
  const h = montar({ oembed: async () => { oembeds++; return { titulo: 'oembed', canal: '' }; } });
  await h.peer('c1', { t: 'search', id: 1, q: 'a' });
  await h.peer('c1', { t: 'add', videoId: V1 });
  assert.equal(oembeds, 0);
  assert.equal(h.ultimoState().fila[0].titulo, 'Achado');
  assert.equal(h.ultimoState().fila[0].duracao, '3:00');
});

test('search: falha -> error busca_falhou com id; consulta inválida -> msg_invalida', async () => {
  const h = montar({ buscar: async () => { throw Object.assign(new Error('x'), { codigo: 'busca_falhou' }); } });
  await h.peer('c1', { t: 'search', id: 'r9', q: 'abc' });
  const e = h.paraConn('c1')[0];
  assert.equal(e.codigo, 'busca_falhou');
  assert.equal(e.id, 'r9');
  await h.peer('c1', { t: 'search', id: 'r10', q: '' });
  assert.equal(h.paraConn('c1')[1].codigo, 'msg_invalida');
  assert.equal(h.paraConn('c1')[1].id, 'r10');
});

test('whoami: ktv só para o tabId guardado; devolve dados do painel', async () => {
  const h = montar();
  await h.int('room', { roomId: 'sala-2' });
  await h.nucleo.abrirKtv();
  const ok = await h.int('whoami', {}, sender());
  assert.equal(ok.ktv, true);
  assert.equal(ok.roomId, 'sala-2');
  assert.equal(ok.siteUrl, CONFIG.SITE_URL);
  assert.deepEqual(ok.state, { atual: null, fila: [], tocando: false });
  assert.equal((await h.int('whoami', {}, sender(8))).ktv, false);
  assert.equal((await h.int('whoami', {}, undefined)).ktv, false);
});

test('whoami da aba KTV recria o offscreen que sumiu e reenvia initPeer com a sala salva', async () => {
  const h = montar({ offscreenExiste: true }); // ensureOffscreen devolve true = acabou de criar
  await h.int('room', { roomId: 'sala-9' });
  await h.nucleo.abrirKtv();
  h.log.off.length = 0;
  await h.int('whoami', {}, sender(8)); // aba qualquer: não mexe no offscreen
  assert.equal(h.log.off.filter((m) => m.t === 'initPeer').length, 0);
  await h.int('whoami', {}, sender());
  assert.equal(h.log.off.find((m) => m.t === 'initPeer').roomId, 'sala-9');
});

test('janela KTV: cria uma vez, foca nas seguintes e recria se a aba sumiu', async () => {
  const h = montar();
  await h.nucleo.abrirKtv();
  await h.nucleo.abrirKtv();
  assert.equal(h.log.criadas, 1);
  assert.equal(h.log.focos, 1);
  h.log.abas.delete(KTV_TAB); // aba foi fechada sem evento chegar
  await h.nucleo.abrirKtv();
  assert.equal(h.log.criadas, 2);
});

test('fechar aba/janela limpa a marca KTV e o started', async () => {
  const h = montar();
  await h.nucleo.abrirKtv();
  await h.int('started', {}, sender());
  await h.nucleo.abaFechada(123); // outra aba: nada
  assert.equal((await h.int('whoami', {}, sender())).ktv, true);
  await h.nucleo.abaFechada(KTV_TAB);
  assert.equal((await h.int('whoami', {}, sender())).ktv, false);
  assert.equal((await h.nucleo._estado()).rt.started, false);

  await h.nucleo.abrirKtv();
  await h.nucleo.janelaFechada(70);
  assert.equal((await h.int('whoami', {}, sender())).ktv, false);
});

test('restauração: novo núcleo com o mesmo storage mantém fila, atual, sala e aba KTV', async () => {
  const a = montar();
  await prepararKtv(a);
  await a.int('room', { roomId: 'sala-3' });
  await a.peer('c1', { t: 'add', videoId: V1 });
  await a.peer('c1', { t: 'add', videoId: V2 });
  await a.int('started', {}, sender());
  assert.ok(a.storageMap.get(KEY_STATE));

  // SW "acordou": instância nova, só o storage sobrevive
  const b = montar({ storageMap: a.storageMap });
  const w = await b.int('whoami', {}, sender());
  assert.equal(w.ktv, true);
  assert.equal(w.roomId, 'sala-3');
  assert.equal(w.state.atual.videoId, V1);
  assert.equal(w.state.fila[0].videoId, V2);
  assert.equal(w.state.tocando, true);

  // peers também voltam: o dono ainda consegue remover; o fluxo segue
  await b.peer('c1', { t: 'add', videoId: V3 });
  const id3 = b.ultimoState().fila.at(-1).itemId;
  await b.peer('c1', { t: 'remove', itemId: id3 });
  assert.equal(b.ultimoState().fila.length, 1);
  await b.int('ended', {}, sender());
  assert.equal(b.ultimoState().atual.videoId, V2);
  assert.deepEqual(b.comandosTab('play').map((m) => m.videoId), [V2]);

  // init na instância nova reaproveita a sala salva
  await b.nucleo.init();
  assert.equal(b.log.off.find((m) => m.t === 'initPeer').roomId, 'sala-3');
});

test('started repetido (aba recarregada) não reenvia play; primeiro started toca a atual existente', async () => {
  const h = montar();
  await prepararKtv(h);
  await h.peer('c1', { t: 'add', videoId: V1 });
  await h.int('started', {}, sender());
  await h.int('started', {}, sender()); // recarga: o content retoma sozinho
  assert.deepEqual(h.comandosTab('play').map((m) => m.videoId), [V1]);
  assert.equal(h.ultimoState().fila.length, 0);
  assert.equal(h.ultimoState().atual.videoId, V1);

  // aba fechada e reaberta com atual restaurada: o primeiro started toca a atual
  await h.nucleo.abaFechada(KTV_TAB);
  await h.nucleo.abrirKtv();
  await h.int('started', {}, sender());
  assert.deepEqual(h.comandosTab('play').map((m) => m.videoId), [V1, V1]);
});

test('falhas ao enviar (aba/offscreen ausentes) não quebram o fluxo', async () => {
  const h = montar();
  h.log.abas.clear();
  await h.nucleo.abrirKtv(); // cria (adiciona) a aba
  h.log.abas.clear();
  await h.peer('c1', { t: 'add', videoId: V1 });
  assert.equal(h.ultimoState().fila.length, 1);
});

test('hello seguido de add sem esperar: o item já sai com o nome e o pid do hello', async () => {
  let liberar;
  const h = montar({ oembed: (id) => new Promise((r) => { liberar = () => r({ titulo: `T ${id}`, canal: 'C' }); }) });
  await h.nucleo.abrirKtv();
  // simula a trava ocupada: o hello entra na fila da trava enquanto o add já começou
  const pHello = h.peer('c9', { t: 'hello', nome: 'Cida', pid: 'pidC' });
  const pAdd = h.peer('c9', { t: 'add', videoId: V1 });
  await new Promise((r) => setImmediate(r));
  liberar();
  await Promise.all([pHello, pAdd]);
  const { estado } = await h.nucleo._estado();
  const it = estado.fila[0] || estado.atual;
  assert.equal(it.pedidoPor, 'Cida');
  assert.equal(it.pid, 'pidC');
});

test('init: tenta de novo quando o offscreen não responde (listener ainda não registrado)', async () => {
  const h = montar({ respostasOff: [new Error('Receiving end does not exist'), undefined, { ok: true }] });
  await h.nucleo.init();
  assert.equal(h.log.off.filter((m) => m.t === 'initPeer').length, 3);
});

test('init com offscreen novo zera peers/conns antigos (conexões morreram com o anterior)', async () => {
  const storageMap = new Map();
  const a = montar({ storageMap });
  await a.peer('c1', { t: 'hello', nome: 'Ana', pid: 'pidA' });
  await a.int('conns', { count: 1, signaling: true });
  const b = montar({ storageMap, offscreenNovo: true });
  await b.nucleo.init();
  const { rt } = await b.nucleo._estado();
  assert.deepEqual(rt.peers, {});
  assert.equal(rt.conns.count, 0);
});

test('navegador reiniciado: esquece a aba KTV (IDs de aba recomeçam) e mantém a fila', async () => {
  const h = montar();
  await prepararKtv(h);
  await h.peer('c1', { t: 'add', videoId: V1 });
  await h.int('started', {}, sender());
  await h.nucleo.navegadorIniciou();
  // uma aba comum do YouTube que ganhou o mesmo tabId não vira a aba KTV
  assert.equal((await h.int('whoami', {}, sender())).ktv, false);
  const { estado, rt } = await h.nucleo._estado();
  assert.equal(estado.atual.videoId, V1);
  assert.equal(rt.started, false);
  assert.deepEqual(rt.peers, {});
});

test('extensão atualizada/recarregada: recarrega a aba KTV para reinjetar o content script', async () => {
  const h = montar();
  await h.nucleo.extensaoAtualizada(); // sem aba KTV: nada
  assert.equal(h.log.recargas, undefined);
  await h.nucleo.abrirKtv();
  await h.nucleo.extensaoAtualizada();
  assert.deepEqual(h.log.recargas, [KTV_TAB]);
  assert.equal((await h.int('whoami', {}, sender())).ktv, true);
  h.log.abas.delete(KTV_TAB); // aba não existe mais: limpa a marca
  await h.nucleo.extensaoAtualizada();
  assert.equal((await h.int('whoami', {}, sender())).ktv, false);
});

test('fechar a janela KTV com música tocando: celulares veem "pausado"; ao reabrir e Iniciar, volta a tocar', async () => {
  const h = montar();
  await prepararKtv(h);
  await h.peer('c1', { t: 'add', videoId: V1 });
  await h.int('started', {}, sender());
  assert.equal(h.ultimoState().tocando, true);
  await h.nucleo.janelaFechada(70);
  assert.equal(h.ultimoState().tocando, false);
  assert.equal(h.ultimoState().atual.videoId, V1);
  await h.nucleo.abrirKtv();
  await h.int('started', {}, sender());
  assert.equal(h.ultimoState().tocando, true);
  assert.equal(h.comandosTab('play').at(-1).videoId, V1);
});

test('skip com itemId: dois pulos da mesma música (toque duplo / dois celulares) pulam só uma', async () => {
  const h = montar();
  await prepararKtv(h);
  for (const v of [V1, V2, V3]) await h.peer('c1', { t: 'add', videoId: v });
  await h.int('started', {}, sender());
  const atualId = h.ultimoState().atual.itemId;
  await Promise.all([
    h.peer('c1', { t: 'skip', itemId: atualId }),
    h.peer('c2', { t: 'skip', itemId: atualId }),
  ]);
  assert.equal(h.ultimoState().atual.videoId, V2);
  assert.deepEqual(h.comandosTab('play').map((m) => m.videoId), [V1, V2]);
  await h.peer('c2', { t: 'skip', itemId: 123 });
  assert.equal(h.paraConn('c2').at(-1).codigo, 'msg_invalida');
});
