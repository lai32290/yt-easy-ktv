// Testes da lógica da sala PeerJS com Peer/Conn falsos e timers determinísticos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPeerRoom, backoffDelay, validIncoming, MAX_MSG_BYTES, MAX_UNAVAILABLE_RETRIES,
} from '../../extension/src/offscreen/peer-room.js';

class Emitter {
  #h = {};
  on(ev, fn) { (this.#h[ev] ||= []).push(fn); return this; }
  emit(ev, ...a) { for (const fn of [...(this.#h[ev] || [])]) fn(...a); }
}

class FakeConn extends Emitter {
  constructor() { super(); this.open = false; this.sent = []; this.failSend = false; this.closed = false; }
  send(m) { if (this.failSend) throw new Error('boom'); this.sent.push(m); }
  close() { this.closed = true; this.open = false; }
  simulateOpen() { this.open = true; this.emit('open'); }
  simulateClose() { this.open = false; this.emit('close'); }
}

class FakePeer extends Emitter {
  static instances = [];
  static throwOnCreate = false;
  constructor(id, opts) {
    super();
    if (FakePeer.throwOnCreate) throw new Error('sem WebRTC');
    this.requestedId = id; this.opts = opts;
    this.open = false; this.disconnected = false; this.destroyed = false;
    this.reconnects = 0; this.id = null;
    FakePeer.instances.push(this);
  }
  reconnect() { this.reconnects++; }
  destroy() { // como o PeerJS real: 'close' antes de marcar destruído
    if (this.destroyed) return;
    this.emit('close'); this.destroyed = true; this.open = false;
  }
  simulateOpen(id = this.requestedId ?? `srv-${FakePeer.instances.length}`) {
    this.id = id; this.open = true; this.disconnected = false; this.emit('open', id);
  }
  simulateDisconnected() { this.open = false; this.disconnected = true; this.emit('disconnected', this.id); }
  simulateConn() { const c = new FakeConn(); this.emit('connection', c); return c; }
}

function makeTimers() {
  const q = []; let n = 0;
  return {
    setTimeoutFn: (fn, ms) => { const id = ++n; q.push({ id, fn, ms }); return id; },
    clearTimeoutFn: (id) => { const i = q.findIndex((t) => t.id === id); if (i >= 0) q.splice(i, 1); },
    pending: () => q.length,
    delays: () => q.map((t) => t.ms),
    runNext() { const t = q.shift(); assert.ok(t, 'sem timer pendente'); t.fn(); return t.ms; },
  };
}

function setup() {
  FakePeer.instances = []; FakePeer.throwOnCreate = false;
  const out = []; const timers = makeTimers(); let u = 0;
  const room = createPeerRoom({
    PeerCtor: FakePeer, send: (m) => out.push(m), uuid: () => `c${++u}`,
    setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn,
  });
  const of = (t) => out.filter((m) => m.t === t);
  const lastConns = () => of('conns').at(-1);
  const peer = () => FakePeer.instances.at(-1);
  return { room, out, of, timers, lastConns, peer };
}

const SIG = { host: 'h.example', port: 443, path: '/', secure: true };
const init = (room, extra = {}) => room.handle({ t: 'initPeer', target: 'offscreen', signaling: SIG, ...extra });

test('backoff: 1s,2s,4s,8s e teto de 15s', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(backoffDelay), [1000, 2000, 4000, 8000, 15000, 15000, 15000]);
});

test('initPeer cria Peer com sinalização e informa a sala no open', () => {
  const { room, of, lastConns, peer } = setup();
  init(room, { roomId: 'abc' });
  assert.equal(FakePeer.instances.length, 1);
  assert.equal(peer().requestedId, 'abc');
  assert.deepEqual(peer().opts, { ...SIG, debug: 1 });
  assert.equal(of('room').length, 0);
  peer().simulateOpen();
  assert.deepEqual(of('room'), [{ t: 'room', target: 'sw', roomId: 'abc' }]);
  assert.deepEqual(lastConns(), { t: 'conns', target: 'sw', count: 0, signaling: true });
});

test('initPeer sem roomId deixa o servidor gerar o ID', () => {
  const { room, of, peer } = setup();
  init(room);
  assert.equal(peer().requestedId, undefined);
  peer().simulateOpen('gerado1');
  assert.equal(of('room')[0].roomId, 'gerado1');
});

test('initPeer é idempotente com o mesmo roomId; roomId diferente recria', () => {
  const { room, of, peer } = setup();
  init(room, { roomId: 'abc' });
  const p1 = peer(); p1.simulateOpen();
  init(room, { roomId: 'abc' });
  init(room); // sem roomId também reaproveita
  assert.equal(FakePeer.instances.length, 1);
  assert.equal(of('room').length, 3); // reenvia o estado conhecido
  init(room, { roomId: 'outro' });
  assert.equal(FakePeer.instances.length, 2);
  assert.ok(p1.destroyed);
  assert.equal(peer().requestedId, 'outro');
});

test('initPeer repetido antes do open não cria segundo Peer', () => {
  const { room } = setup();
  init(room, { roomId: 'abc' });
  init(room, { roomId: 'abc' });
  assert.equal(FakePeer.instances.length, 1);
});

test('duas conexões: contagem, mensagens viram peerMsg, close gera peerClose', () => {
  const { room, of, lastConns, peer } = setup();
  init(room, { roomId: 'abc' }); peer().simulateOpen();
  const a = peer().simulateConn(); const b = peer().simulateConn();
  assert.equal(lastConns().count, 0); // ainda não abriram
  a.simulateOpen(); b.simulateOpen();
  assert.equal(lastConns().count, 2);
  a.emit('data', { t: 'hello', nome: 'Ana' });
  b.emit('data', { t: 'skip' });
  assert.deepEqual(of('peerMsg'), [
    { t: 'peerMsg', target: 'sw', connId: 'c1', msg: { t: 'hello', nome: 'Ana' } },
    { t: 'peerMsg', target: 'sw', connId: 'c2', msg: { t: 'skip' } },
  ]);
  a.simulateClose();
  assert.deepEqual(of('peerClose'), [{ t: 'peerClose', target: 'sw', connId: 'c1' }]);
  assert.equal(lastConns().count, 1);
  b.emit('error', new Error('x'));
  assert.equal(of('peerClose').length, 2);
  assert.ok(b.closed);
  assert.equal(lastConns().count, 0);
  a.simulateClose(); // duplicado não reenvia
  assert.equal(of('peerClose').length, 2);
});

test('conexão que já chega aberta é contada', () => {
  const { room, lastConns, peer } = setup();
  init(room, { roomId: 'abc' }); peer().simulateOpen();
  const c = new FakeConn(); c.open = true;
  peer().emit('connection', c);
  assert.equal(lastConns().count, 1);
});

test('descarta mensagens inválidas ou grandes demais', () => {
  const { room, of, peer } = setup();
  init(room, { roomId: 'abc' }); peer().simulateOpen();
  const c = peer().simulateConn(); c.simulateOpen();
  const circ = { t: 'x' }; circ.self = circ;
  for (const bad of [null, undefined, 'texto', 42, [], {}, { t: 5 }, { t: '' }, new ArrayBuffer(4),
    { t: 'add', x: 'y'.repeat(MAX_MSG_BYTES) }, circ]) c.emit('data', bad);
  assert.equal(of('peerMsg').length, 0);
  c.emit('data', { t: 'add', videoId: 'dQw4w9WgXcQ' });
  assert.equal(of('peerMsg').length, 1);
  assert.equal(validIncoming({ t: 'a' }), true);
});

test('send e broadcast só usam conexões abertas; falha isolada', () => {
  const { room, peer } = setup();
  init(room, { roomId: 'abc' }); peer().simulateOpen();
  const a = peer().simulateConn(); const b = peer().simulateConn(); const c = peer().simulateConn();
  a.simulateOpen(); b.simulateOpen(); // c ainda conectando
  b.failSend = true;
  room.handle({ t: 'broadcast', target: 'offscreen', msg: { t: 'state', n: 1 } });
  assert.deepEqual(a.sent, [{ t: 'state', n: 1 }]);
  assert.deepEqual(b.sent, []);
  assert.deepEqual(c.sent, []);
  b.failSend = false;
  room.handle({ t: 'send', target: 'offscreen', connId: 'c2', msg: { t: 'results' } });
  assert.deepEqual(b.sent, [{ t: 'results' }]);
  assert.deepEqual(a.sent.length, 1);
  assert.equal(room.sendTo('c3', { t: 'x' }), false); // não aberta
  assert.equal(room.sendTo('inexistente', { t: 'x' }), false);
  a.open = false; // fechou mas o evento ainda não chegou
  assert.equal(room.broadcast({ t: 'y' }), 1);
});

test('handle ignora mensagens de outro alvo ou desconhecidas', () => {
  const { room } = setup();
  assert.equal(room.handle({ t: 'initPeer', target: 'sw' }), false);
  assert.equal(room.handle({ t: 'ping', target: 'offscreen' }), false);
  assert.equal(room.handle(null), false);
  assert.equal(FakePeer.instances.length, 0);
});

test('disconnected: sinalização false, reconnect com backoff crescente e reset no open', () => {
  const { room, timers, lastConns, peer } = setup();
  init(room, { roomId: 'abc' }); const p = peer(); p.simulateOpen();
  const delays = [];
  for (let i = 0; i < 6; i++) {
    p.simulateDisconnected();
    assert.equal(lastConns().signaling, false);
    assert.equal(p.reconnects, i);
    delays.push(timers.runNext());
    assert.equal(p.reconnects, i + 1);
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 15000, 15000]);
  p.simulateOpen('abc'); // reconectou
  assert.equal(lastConns().signaling, true);
  p.simulateDisconnected();
  assert.deepEqual(timers.delays(), [1000]);
  assert.equal(FakePeer.instances.length, 1); // nunca recriou
});

test('disconnected repetido não agenda timers duplicados', () => {
  const { room, timers, peer } = setup();
  init(room, { roomId: 'abc' }); peer().simulateOpen();
  peer().simulateDisconnected(); peer().simulateDisconnected();
  peer().emit('error', { type: 'network' });
  assert.equal(timers.pending(), 1);
});

test('erro network/socket com peer desconectado agenda reconexão', () => {
  const { room, timers, lastConns, peer } = setup();
  init(room, { roomId: 'abc' }); const p = peer(); p.simulateOpen();
  p.disconnected = true;
  p.emit('error', { type: 'socket-error' });
  assert.equal(lastConns().signaling, false);
  timers.runNext();
  assert.equal(p.reconnects, 1);
});

test('erros de uma conexão específica não derrubam a sala', () => {
  const { room, timers, lastConns, peer } = setup();
  init(room, { roomId: 'abc' }); peer().simulateOpen();
  peer().emit('error', { type: 'peer-unavailable' });
  peer().emit('error', { type: 'webrtc' });
  assert.equal(timers.pending(), 0);
  assert.equal(lastConns().signaling, true);
});

test('unavailable-id: retenta com o mesmo ID e sucesso zera o contador', () => {
  const { room, of, timers, peer } = setup();
  init(room, { roomId: 'abc' });
  peer().emit('error', { type: 'unavailable-id' });
  assert.equal(timers.runNext(), 1000);
  assert.equal(FakePeer.instances.length, 2);
  assert.equal(peer().requestedId, 'abc');
  peer().emit('error', { type: 'unavailable-id' });
  assert.equal(timers.runNext(), 2000);
  assert.equal(peer().requestedId, 'abc');
  peer().simulateOpen();
  assert.deepEqual(of('room').map((m) => m.roomId), ['abc']);
  // depois de abrir, o orçamento de retentativas volta ao início
  peer().emit('close');
  assert.equal(timers.runNext(), 1000);
});

test('unavailable-id: após 6 retentativas cai para ID novo e avisa room', () => {
  const { room, of, timers, peer } = setup();
  init(room, { roomId: 'abc' });
  const delays = [];
  for (let i = 0; i < MAX_UNAVAILABLE_RETRIES; i++) {
    peer().emit('error', { type: 'unavailable-id' });
    delays.push(timers.runNext());
    assert.equal(peer().requestedId, 'abc');
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 15000, 15000]);
  assert.equal(FakePeer.instances.length, 1 + MAX_UNAVAILABLE_RETRIES);
  peer().emit('error', { type: 'unavailable-id' }); // 7º erro: desiste do ID
  assert.equal(timers.pending(), 0);
  assert.equal(peer().requestedId, undefined);
  assert.equal(FakePeer.instances.length, 2 + MAX_UNAVAILABLE_RETRIES);
  peer().simulateOpen('novoid');
  assert.deepEqual(of('room'), [{ t: 'room', target: 'sw', roomId: 'novoid' }]);
  // a recriação seguinte mantém o ID novo
  peer().emit('close');
  timers.runNext();
  assert.equal(peer().requestedId, 'novoid');
});

test('peer destruído (close): recria com o mesmo ID, solta conexões e ignora eventos do Peer velho', () => {
  const { room, of, timers, lastConns, peer } = setup();
  init(room, { roomId: 'abc' }); const p1 = peer(); p1.simulateOpen();
  const c = p1.simulateConn(); c.simulateOpen();
  assert.equal(lastConns().count, 1);
  p1.destroyed = true; p1.emit('close');
  assert.equal(lastConns().signaling, false);
  assert.equal(of('peerClose').length, 1);
  assert.equal(lastConns().count, 0);
  assert.equal(timers.runNext(), 1000);
  const p2 = peer();
  assert.notEqual(p1, p2);
  assert.equal(p2.requestedId, 'abc');
  p2.simulateOpen();
  assert.equal(of('room').at(-1).roomId, 'abc');
  assert.equal(lastConns().signaling, true);
  p1.simulateDisconnected(); // evento tardio do Peer velho
  p1.emit('open', 'lixo');
  assert.equal(timers.pending(), 0);
  assert.equal(of('room').at(-1).roomId, 'abc');
});

test('falha ao criar o Peer (construtor lança) agenda nova tentativa', () => {
  const { room, timers } = setup();
  FakePeer.throwOnCreate = true;
  init(room, { roomId: 'abc' });
  assert.equal(FakePeer.instances.length, 0);
  FakePeer.throwOnCreate = false;
  assert.equal(timers.runNext(), 1000);
  assert.equal(FakePeer.instances.length, 1);
});

test('invalid-id cai para ID novo; destroy limpa tudo', () => {
  const { room, timers, peer } = setup();
  init(room, { roomId: 'invalido' });
  peer().emit('error', { type: 'invalid-id' });
  assert.equal(FakePeer.instances.length, 2);
  assert.equal(peer().requestedId, undefined);
  const p = peer(); p.simulateOpen('x');
  p.simulateDisconnected();
  assert.equal(timers.pending(), 1);
  room.destroy();
  assert.equal(timers.pending(), 0);
  assert.ok(p.destroyed);
  assert.equal(room.getState().started, false);
});
