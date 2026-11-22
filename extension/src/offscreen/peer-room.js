// Lógica da sala PeerJS (sem chrome/DOM, testável em Node).
// Recebe o construtor do Peer, uma função send(msgInterna) e timers injetáveis.
import { INT, TARGET } from '../shared/protocol.js';

export const MAX_MSG_BYTES = 8 * 1024;      // limite de tamanho por mensagem recebida
export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_MAX_MS = 15000;
export const MAX_UNAVAILABLE_RETRIES = 6;   // retentativas com o mesmo ID antes de trocar de ID

// 1s, 2s, 4s, 8s, 15s, 15s...
export const backoffDelay = (attempt) =>
  Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);

const SIGNALING_KEYS = ['host', 'port', 'path', 'secure'];
const pickSignaling = (s) => {
  const out = {};
  if (s && typeof s === 'object') {
    for (const k of SIGNALING_KEYS) if (s[k] !== undefined) out[k] = s[k];
  }
  return out;
};

// Mensagem do celular válida: objeto simples com `t` string e tamanho razoável.
export function validIncoming(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return false;
  if (typeof d.t !== 'string' || !d.t) return false;
  try {
    return JSON.stringify(d).length <= MAX_MSG_BYTES;
  } catch {
    return false; // referência circular etc.
  }
}

export function createPeerRoom({
  PeerCtor,
  send,
  setTimeoutFn = (...a) => setTimeout(...a),
  clearTimeoutFn = (...a) => clearTimeout(...a),
  uuid = () => globalThis.crypto.randomUUID(),
  log = () => {},
}) {
  let peer = null;
  let signaling = {};
  let started = false;
  let desiredId;            // ID pedido ao servidor (undefined => servidor gera um novo)
  let roomId = null;        // ID corrente da sala, sempre devolvido ao SW
  let signalingOk = false;
  let attempt = 0;          // índice do backoff; zera no `open`
  let unavailableTries = 0;
  let timerActive = false;
  let timerHandle = null;
  const conns = new Map();  // connId -> { conn, opened }

  const emit = (m) => {
    try { send({ ...m, target: TARGET.SW }); } catch (e) { log('send falhou', e); }
  };
  const countOpen = () => { let n = 0; for (const e of conns.values()) if (e.opened) n++; return n; };
  const reportConns = () =>
    emit({ t: INT.CONNS, count: countOpen(), signaling: signalingOk });

  // ---- timers (um único agendamento pendente por vez) ----
  function schedule(fn) {
    if (timerActive) return false;
    const ms = backoffDelay(attempt++);
    timerActive = true;
    timerHandle = setTimeoutFn(() => { timerActive = false; timerHandle = null; fn(); }, ms);
    return true;
  }
  function cancelTimer() {
    if (timerActive) clearTimeoutFn(timerHandle);
    timerActive = false;
    timerHandle = null;
  }

  // ---- conexões dos celulares ----
  function removeConn(connId, { report = true, close = false } = {}) {
    const entry = conns.get(connId);
    if (!entry) return;
    conns.delete(connId);
    if (close) { try { entry.conn.close(); } catch { /* já fechada */ } }
    emit({ t: INT.PEER_CLOSE, connId });
    if (report) reportConns();
  }
  function dropAllConns({ close = false } = {}) {
    const ids = [...conns.keys()];
    for (const id of ids) removeConn(id, { report: false, close });
    if (ids.length) reportConns();
  }

  function addConn(conn) {
    const connId = uuid();
    const entry = { conn, opened: false };
    conns.set(connId, entry);
    const markOpen = () => {
      if (!conns.has(connId) || entry.opened) return;
      entry.opened = true;
      reportConns();
    };
    conn.on('open', markOpen);
    conn.on('data', (d) => {
      if (!validIncoming(d)) { log('mensagem descartada', connId); return; }
      emit({ t: INT.PEER_MSG, connId, msg: d });
    });
    conn.on('close', () => removeConn(connId));
    conn.on('error', (e) => { log('erro de conexão', connId, e); removeConn(connId, { close: true }); });
    if (conn.open) markOpen();
  }

  // ---- ciclo de vida do Peer ----
  function peerOptions() {
    return { ...signaling, debug: 1 };
  }

  function create() {
    let p;
    try {
      p = new PeerCtor(desiredId, peerOptions());
    } catch (e) {
      log('falha ao criar Peer', e);
      peer = null;
      signalingOk = false;
      schedule(create);
      return;
    }
    peer = p;
    bind(p);
  }

  // Descarta o Peer atual sem disparar a lógica de recriação.
  function retire(p) {
    if (peer === p) peer = null;
    try { p.destroy(); } catch { /* ignora */ }
  }

  function reconnect(p) {
    if (peer !== p || p.destroyed || !p.disconnected) return;
    try {
      p.reconnect();
    } catch (e) {
      log('reconnect falhou', e);
      schedule(() => reconnect(p));
    }
  }

  function onUnavailable(p) {
    retire(p);
    dropAllConns();
    signalingOk = false;
    reportConns();
    if (unavailableTries < MAX_UNAVAILABLE_RETRIES) {
      unavailableTries++;
      schedule(create); // mesmo ID: o servidor ainda segura o registro antigo
    } else {
      log('ID preso no servidor; usando ID novo');
      cancelTimer();
      desiredId = undefined; // o `open` informa o novo ID via `room`
      unavailableTries = 0;
      create();
    }
  }

  function bind(p) {
    const live = () => peer === p;

    p.on('open', (id) => {
      if (!live()) return;
      roomId = id;
      desiredId = id;       // recriações futuras mantêm este ID
      attempt = 0;
      unavailableTries = 0;
      signalingOk = true;
      emit({ t: INT.ROOM, roomId: id });
      reportConns();
    });

    p.on('connection', (conn) => {
      if (!live()) { try { conn.close(); } catch { /* ignora */ } return; }
      addConn(conn);
    });

    p.on('disconnected', () => {
      if (!live()) return;
      signalingOk = false;
      reportConns();
      if (!p.destroyed) schedule(() => reconnect(p));
    });

    p.on('error', (err) => {
      if (!live()) return;
      const type = err && err.type;
      log('erro do Peer', type);
      switch (type) {
        case 'unavailable-id':
          onUnavailable(p);
          break;
        case 'network':
        case 'server-error':
        case 'socket-error':
        case 'socket-closed':
          signalingOk = false;
          reportConns();
          // 'disconnected'/'close' costumam vir em seguida; isto é só uma rede de segurança.
          if (p.disconnected && !p.destroyed) schedule(() => reconnect(p));
          break;
        case 'invalid-id':
          // ID salvo inválido: cai para um ID novo.
          retire(p);
          dropAllConns();
          desiredId = undefined;
          cancelTimer();
          create();
          break;
        default:
          // peer-unavailable, webrtc etc.: afetam só uma conexão, não a sala.
          break;
      }
    });

    p.on('close', () => {
      if (!live()) return;
      // Peer destruído por fora: recriar com o mesmo ID.
      peer = null;
      signalingOk = false;
      dropAllConns();
      reportConns();
      schedule(create);
    });
  }

  function teardown() {
    cancelTimer();
    const p = peer;
    peer = null;
    dropAllConns({ close: true });
    signalingOk = false;
    if (p) { try { p.destroy(); } catch { /* ignora */ } }
  }

  // ---- API ----
  function initPeer(msg = {}) {
    const wanted = typeof msg.roomId === 'string' && msg.roomId ? msg.roomId : undefined;
    const sig = pickSignaling(msg.signaling);
    const sameSig = !msg.signaling || JSON.stringify(sig) === JSON.stringify(signaling);
    const sameRoom = !wanted || wanted === roomId || wanted === desiredId;
    if (started && sameSig && sameRoom) {
      // Idempotente: não recria; apenas reenvia o estado conhecido.
      if (roomId && peer && peer.open) { emit({ t: INT.ROOM, roomId }); }
      reportConns();
      return { reused: true };
    }
    if (started) teardown();
    started = true;
    signaling = sig;
    desiredId = wanted;
    roomId = wanted || null;
    attempt = 0;
    unavailableTries = 0;
    create();
    return { reused: false };
  }

  // Envia só por conexões abertas; falha em uma não afeta as outras.
  function sendTo(connId, msg) {
    const entry = conns.get(connId);
    if (!entry || !entry.conn.open) return false;
    try { entry.conn.send(msg); return true; } catch (e) { log('send falhou', connId, e); return false; }
  }
  function broadcast(msg) {
    let n = 0;
    for (const entry of conns.values()) {
      if (!entry.opened || !entry.conn.open) continue;
      try { entry.conn.send(msg); n++; } catch (e) { log('broadcast falhou', e); }
    }
    return n;
  }

  // Despacha mensagens internas vindas do SW. Retorna true se tratou.
  function handle(m) {
    if (!m || m.target !== TARGET.OFFSCREEN || typeof m.t !== 'string') return false;
    switch (m.t) {
      case INT.INIT_PEER: initPeer(m); return true;
      case INT.SEND: sendTo(m.connId, m.msg); return true;
      case INT.BROADCAST: broadcast(m.msg); return true;
      default: return false;
    }
  }

  function destroy() { teardown(); started = false; }

  const getState = () => ({
    roomId, desiredId, signaling: signalingOk, started,
    open: countOpen(), total: conns.size, retryPending: timerActive,
  });

  return { initPeer, sendTo, broadcast, handle, destroy, getState };
}
