// Núcleo do service worker: toda a lógica de tratamento de mensagens, sem chrome.*.
// service-worker.js só liga as APIs reais (storage, runtime, tabs, windows, offscreen) a este núcleo.
//
// Dependências injetadas (todas assíncronas ou síncronas simples):
//   storage   { get(chave) -> valor|undefined, set(chave, valor) }
//   send(msg)              -> mensagem interna ao offscreen (devolve a resposta, se houver)
//   sendToTab(tabId, msg)  -> mensagem ao content script da aba KTV
//   ensureOffscreen()      -> garante o offscreen document
//   janelas   { criar(url) -> {tabId, windowId}, focar(tabId, windowId) -> boolean, recarregar?(tabId) -> boolean }
//   buscar(q, {karaoke}), oembed(videoId)
//   now(), uuid(), sleep(ms), log(...)
import {
  CONFIG, C2E, E2C, INT, TARGET, ERR, ERR_TEXT, ACOES_CONTROLE,
} from '../shared/protocol.js';
import {
  criarEstado, enqueue, remove, avancar, mover, publico,
} from './queue.js';
import { parseUrl } from './url.js';

export const KEY_STATE = 'ktv_state';
export const KEY_RT = 'ktv_rt';               // aba KTV, started, peers, conns
export const KEY_SIGNALING = 'ktv_signaling'; // override opcional da sinalização

const MAX_NOME = 30;
const MAX_PID = 64;
const MAX_BUSCA = 100;
const MAX_CACHE_RESULTADOS = 200;

const rtPadrao = () => ({
  ktvTabId: null, ktvWindowId: null, started: false,
  conns: { count: 0, signaling: false },
  player: { pausado: false, mudo: false, volume: 100 }, // último estado do <video> informado pelo content
  peers: {}, // connId -> { nome, pid }
});

const ehId = (x) => (typeof x === 'string' && x.length > 0) || Number.isFinite(x);

export function criarNucleo(deps) {
  const {
    storage, send, sendToTab, ensureOffscreen, janelas, buscar, oembed,
    now = () => Date.now(),
    uuid = () => globalThis.crypto.randomUUID(),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    log = () => {},
  } = deps;

  let estado = null;
  let rt = null;
  let carregando = null;
  let trava = Promise.resolve();
  const resultadosRecentes = new Map(); // videoId -> item vindo da busca (evita oEmbed e dá duração)

  // ---------- persistência ----------
  function carregar() {
    if (estado) return Promise.resolve();
    carregando ??= (async () => {
      const [e, r] = await Promise.all([storage.get(KEY_STATE), storage.get(KEY_RT)]);
      estado = criarEstado(e || {});
      rt = { ...rtPadrao(), ...(r || {}) };
      rt.conns = { ...rtPadrao().conns, ...(rt.conns || {}) };
      rt.peers = rt.peers && typeof rt.peers === 'object' ? rt.peers : {};
      rt.player = { ...rtPadrao().player, ...(rt.player || {}) };
    })().finally(() => { carregando = null; });
    return carregando;
  }
  const salvarEstado = () => storage.set(KEY_STATE, estado);
  const salvarRt = () => storage.set(KEY_RT, rt);

  // Seções críticas em série: estado sempre relido/gravado sem corrida entre mensagens.
  function travar(fn) {
    const p = trava.then(async () => { await carregar(); return fn(); });
    trava = p.catch(() => {});
    return p;
  }

  // ---------- envio ----------
  const seguro = async (fn) => {
    try { return await fn(); } catch (e) { log('envio ignorado:', e?.message || e); return undefined; }
  };
  const aoOffscreen = (m) => seguro(() => send({ ...m, target: TARGET.OFFSCREEN }));
  const aConexao = (connId, msg) => aoOffscreen({ t: INT.SEND, connId, msg });
  const aTodos = (msg) => aoOffscreen({ t: INT.BROADCAST, msg });
  const aoContent = (m) => (rt.ktvTabId == null
    ? undefined
    : seguro(() => sendToTab(rt.ktvTabId, { ...m, target: TARGET.CONTENT })));

  const dadosPainel = () => ({
    state: publico(estado),
    roomId: estado.roomId,
    siteUrl: CONFIG.SITE_URL,
    conns: rt.conns.count,
    signaling: rt.conns.signaling,
  });
  const painel = () => aoContent({ t: INT.PANEL, ...dadosPainel() });
  const msgEstado = () => ({ t: E2C.STATE, ...publico(estado), player: { ...rt.player } });
  async function difundirEstado() {
    await Promise.all([aTodos(msgEstado()), painel()]);
  }
  const msgErro = (codigo, extra = {}) => ({ t: E2C.ERROR, codigo, msg: ERR_TEXT[codigo] || '', ...extra });

  // ---------- fluxo do player ----------
  // Chamado depois de `avancar`: manda tocar o novo `atual` ou avisa que ficou ocioso.
  async function acionarPlayer() {
    if (!rt.started) return;
    if (estado.atual) await aoContent({ t: INT.PLAY, videoId: estado.atual.videoId });
    else await aoContent({ t: INT.IDLE });
  }
  async function proximaMusica() {
    estado = avancar(estado).estado;
    rt.player = { ...rt.player, pausado: false }; // música nova começa tocando (o mudo/volume ficam)
    await Promise.all([salvarEstado(), salvarRt()]);
    await acionarPlayer();
  }
  const doKtv = (sender) => sender?.tab?.id != null && sender.tab.id === rt.ktvTabId;

  // ---------- inicialização ----------
  async function init() {
    await carregar();
    if (await ensureOffscreen()) {
      // Offscreen novo: as conexões antigas morreram com o anterior (sem peerClose).
      await travar(async () => {
        rt.peers = {};
        rt.conns = { count: 0, signaling: false };
        await salvarRt();
      });
    }
    const sobre = await storage.get(KEY_SIGNALING);
    const signaling = sobre && typeof sobre === 'object' ? sobre : CONFIG.SIGNALING;
    const msg = { t: INT.INIT_PEER, signaling };
    if (estado.roomId) msg.roomId = estado.roomId;
    // O offscreen confirma com { ok }; recém-criado pode demorar a registrar o listener.
    for (let i = 0; i < 4; i++) {
      const r = await seguro(() => send({ ...msg, target: TARGET.OFFSCREEN }));
      // Sem resposta (listener ainda não registrado) ou ok:false: tenta de novo.
      if (r && r.ok !== false) break;
      if (i < 3) await sleep(300 * (i + 1));
    }
  }

  // ---------- janela KTV ----------
  async function abrirKtv() {
    return travar(async () => {
      if (rt.ktvTabId != null) {
        const ok = await seguro(() => janelas.focar(rt.ktvTabId, rt.ktvWindowId));
        if (ok) return;
      }
      const url = `https://www.youtube.com/?${CONFIG.KTV_FLAG}=1`;
      const r = await janelas.criar(url);
      rt.ktvTabId = r.tabId ?? null;
      rt.ktvWindowId = r.windowId ?? null;
      rt.started = false;
      await salvarRt();
    });
  }
  // Aba/janela KTV fechada: a música atual fica guardada, mas os celulares passam a ver "Pausado".
  async function fechouKtvDentro() {
    await limparKtvDentro();
    if (estado.tocando) {
      estado = { ...estado, tocando: false };
      await salvarEstado();
      await aTodos(msgEstado());
    }
  }
  const abaFechada = (tabId) => travar(async () => {
    if (rt.ktvTabId == null || rt.ktvTabId !== tabId) return undefined;
    return fechouKtvDentro();
  });
  const janelaFechada = (windowId) => travar(async () => {
    if (rt.ktvWindowId == null || rt.ktvWindowId !== windowId) return undefined;
    return fechouKtvDentro();
  });
  async function limparKtvDentro() {
    rt.ktvTabId = null; rt.ktvWindowId = null; rt.started = false;
    await salvarRt();
  }
  // Navegador recém-aberto: os IDs de aba/janela recomeçam do zero, então o tabId salvo
  // poderia apontar para uma aba qualquer do YouTube. A fila (estado) é mantida.
  const navegadorIniciou = () => travar(async () => {
    rt.peers = {};
    rt.conns = { count: 0, signaling: false };
    return limparKtvDentro();
  });
  // Extensão recarregada/atualizada: o content script da aba KTV ficou órfão.
  // Recarrega a aba para reinjetar o script (fila e sala vêm do storage).
  const extensaoAtualizada = () => travar(async () => {
    if (rt.ktvTabId == null || !janelas.recarregar) return;
    const ok = await seguro(() => janelas.recarregar(rt.ktvTabId));
    if (ok === false) await limparKtvDentro();
  });

  // ---------- mensagens do celular ----------
  function resolverMetadados(videoId) {
    const cache = resultadosRecentes.get(videoId);
    if (cache) return Promise.resolve({ titulo: cache.titulo, canal: cache.canal, duracao: cache.duracao || '' });
    return oembed(videoId).then(
      (m) => ({ duracao: '', ...m }),
      (e) => {
        // 401/403: o oEmbed recusa vídeos com incorporação desligada, mas eles tocam no youtube.com.
        // Aceita com título provisório; se for privado, o playerError pula depois.
        if (e && (e.status === 401 || e.status === 403)) return { titulo: `Vídeo ${videoId}`, canal: '', duracao: '' };
        throw e;
      },
    );
  }

  function guardarResultados(itens) {
    for (const it of itens) {
      resultadosRecentes.delete(it.videoId);
      resultadosRecentes.set(it.videoId, it);
    }
    while (resultadosRecentes.size > MAX_CACHE_RESULTADOS) {
      resultadosRecentes.delete(resultadosRecentes.keys().next().value);
    }
  }

  async function tratarPeerMsg({ connId, pid: pidEnvelope, msg }) {
    if (!ehId(connId)) return;
    const erroPara = (codigo, extra) => aConexao(connId, msgErro(codigo, extra));
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') {
      return erroPara(ERR.MSG_INVALIDA);
    }
    await carregar();
    // Identidade lida DENTRO das seções travadas: um `hello` ainda na fila da trava
    // (ex.: hello e add em sequência rápida) já terá sido aplicado quando ela for usada.
    const quem = () => {
      const peer = rt.peers[connId] || {};
      return {
        pid: (typeof pidEnvelope === 'string' && pidEnvelope) || peer.pid || String(connId),
        nome: peer.nome || 'Convidado',
      };
    };

    switch (msg.t) {
      case C2E.HELLO: {
        const novoPid = typeof msg.pid === 'string' ? msg.pid : pidEnvelope;
        if (typeof novoPid !== 'string' || !novoPid || novoPid.length > MAX_PID
          || (msg.nome != null && typeof msg.nome !== 'string')) {
          return erroPara(ERR.MSG_INVALIDA);
        }
        const novoNome = (msg.nome || '').trim().slice(0, MAX_NOME) || 'Convidado';
        await travar(async () => {
          rt.peers[connId] = { nome: novoNome, pid: novoPid };
          await salvarRt();
        });
        return aConexao(connId, msgEstado());
      }

      case C2E.SEARCH: {
        const id = msg.id;
        const comId = ehId(id) ? { id } : {};
        const q = typeof msg.q === 'string' ? msg.q.trim() : '';
        if (!q || q.length > MAX_BUSCA) return erroPara(ERR.MSG_INVALIDA, comId);
        try {
          const itens = await buscar(q, { karaoke: msg.karaoke !== false });
          guardarResultados(itens);
          return aConexao(connId, { t: E2C.RESULTS, id, itens });
        } catch (e) {
          log('busca falhou:', e?.message || e);
          return erroPara(ERR.BUSCA_FALHOU, comId);
        }
      }

      case C2E.ADD: {
        let videoId;
        if (typeof msg.videoId === 'string') videoId = CONFIG.VIDEO_ID_RE.test(msg.videoId) ? msg.videoId : null;
        else if (typeof msg.url === 'string') videoId = parseUrl(msg.url);
        else return erroPara(ERR.MSG_INVALIDA);
        if (!videoId) return erroPara(ERR.LINK_INVALIDO);

        const jaExiste = () => estado.atual?.videoId === videoId || estado.fila.some((i) => i.videoId === videoId);
        if (jaExiste()) return erroPara(ERR.DUPLICADO);

        let meta;
        try {
          meta = await resolverMetadados(videoId);
        } catch (e) {
          log('oEmbed falhou:', e?.message || e);
          return erroPara(ERR.VIDEO_INDISPONIVEL);
        }
        return travar(async () => {
          const { nome, pid } = quem();
          const item = {
            itemId: uuid(), videoId, titulo: meta.titulo, canal: meta.canal || '', duracao: meta.duracao || '',
            pedidoPor: nome, pid, addedAt: now(),
          };
          const r = enqueue(estado, item); // dedup de novo: outra mensagem pode ter entrado durante o oEmbed
          if (r.erro) return erroPara(r.erro);
          estado = r.estado;
          const ocioso = !estado.atual && rt.started;
          if (ocioso) estado = avancar(estado).estado;
          await salvarEstado();
          if (ocioso) await acionarPlayer(); // só toca se estava ocioso; senão não reinicia a música atual
          return difundirEstado();
        });
      }

      case C2E.REMOVE: {
        if (typeof msg.itemId !== 'string') return erroPara(ERR.MSG_INVALIDA);
        return travar(async () => {
          const r = remove(estado, msg.itemId, quem().pid);
          if (r.erro) return erroPara(r.erro);
          estado = r.estado;
          await salvarEstado();
          return difundirEstado();
        });
      }

      case C2E.SKIP: {
        if (CONFIG.SKIP_POLICY !== 'todos') return erroPara(ERR.SEM_PERMISSAO);
        if (msg.itemId != null && typeof msg.itemId !== 'string') return erroPara(ERR.MSG_INVALIDA);
        return travar(async () => {
          if (!estado.atual) return undefined;
          // Dois toques em "Pular" (ou dois celulares ao mesmo tempo) não pulam duas músicas.
          if (msg.itemId && msg.itemId !== estado.atual.itemId) return undefined;
          await proximaMusica();
          return difundirEstado();
        });
      }

      case C2E.CONTROL: {
        if (!ACOES_CONTROLE.includes(msg.acao)) return erroPara(ERR.MSG_INVALIDA);
        return travar(async () => {
          if (!estado.atual || !rt.started) return undefined; // nada tocando: ignora
          return aoContent({ t: INT.CONTROL, acao: msg.acao });
        });
      }

      case C2E.MOVE: {
        if (typeof msg.itemId !== 'string' || !Number.isInteger(msg.toIndex)) return erroPara(ERR.MSG_INVALIDA);
        return travar(async () => {
          const r = mover(estado, msg.itemId, msg.toIndex);
          if (r.erro) return erroPara(r.erro);
          estado = r.estado;
          await salvarEstado();
          return difundirEstado();
        });
      }

      default:
        return erroPara(ERR.MSG_INVALIDA);
    }
  }

  // ---------- mensagens internas ----------
  async function handleMessage(msg, sender) {
    if (!msg || typeof msg !== 'object' || msg.target !== TARGET.SW) return undefined;
    switch (msg.t) {
      case INT.ROOM:
        if (typeof msg.roomId !== 'string' || !msg.roomId) return undefined;
        return travar(async () => {
          estado = { ...estado, roomId: msg.roomId };
          await salvarEstado();
          await painel();
        });

      case INT.CONNS:
        return travar(async () => {
          rt.conns = { count: Math.max(0, Number(msg.count) || 0), signaling: Boolean(msg.signaling) };
          await salvarRt();
          await painel();
        });

      case INT.PEER_MSG:
        return tratarPeerMsg(msg);

      case INT.PEER_CLOSE:
        return travar(async () => {
          if (rt.peers[msg.connId]) {
            delete rt.peers[msg.connId];
            await salvarRt();
          }
        });

      case INT.WHOAMI: {
        // Pela trava: espera, p.ex., o navegadorIniciou() limpar um tabId de outra sessão do Chrome.
        const ktv = await travar(async () => doKtv(sender));
        // Offscreen sumiu com o SW vivo (ex.: renderer caiu): recria e religa o Peer com a mesma sala.
        if (ktv) await seguro(async () => { if (await ensureOffscreen()) await init(); });
        return { ktv: doKtv(sender), ...dadosPainel() };
      }

      case INT.STARTED:
        return travar(async () => {
          if (!doKtv(sender)) return undefined;
          // `started` repetido (aba recarregada com música em andamento): o content retoma sozinho,
          // então não reenvia `play` da atual. Primeira liberação: toca a atual (se houver) ou puxa a próxima.
          const jaLiberado = rt.started;
          rt.started = true;
          await salvarRt();
          const puxou = !estado.atual && estado.fila.length > 0;
          if (puxou) estado = avancar(estado).estado;
          else if (estado.atual && !estado.tocando) estado = { ...estado, tocando: true }; // janela reaberta
          await salvarEstado();
          if (puxou || !jaLiberado) await acionarPlayer();
          return difundirEstado();
        });

      case INT.PLAYER_STATUS:
        return travar(async () => {
          if (!doKtv(sender)) return undefined;
          const volume = Number(msg.volume);
          const novo = {
            pausado: Boolean(msg.pausado),
            mudo: Boolean(msg.mudo),
            volume: Number.isFinite(volume) ? Math.max(0, Math.min(100, Math.round(volume))) : rt.player.volume,
          };
          const p = rt.player;
          if (p.pausado === novo.pausado && p.mudo === novo.mudo && p.volume === novo.volume) return undefined;
          rt.player = novo;
          await salvarRt();
          return aTodos(msgEstado());
        });

      case INT.ENDED:
        return travar(async () => {
          if (!doKtv(sender) || !estado.atual) return undefined;
          if (msg.videoId && msg.videoId !== estado.atual.videoId) return undefined; // ended atrasado/duplicado
          await proximaMusica();
          return difundirEstado();
        });

      case INT.PLAYER_ERROR:
        return travar(async () => {
          if (!doKtv(sender) || !estado.atual) return undefined;
          if (msg.videoId && msg.videoId !== estado.atual.videoId) return undefined;
          const { titulo, videoId } = estado.atual;
          log('playerError:', videoId, msg.codigo);
          await aTodos(msgErro(ERR.VIDEO_INDISPONIVEL, { msg: `${titulo} indisponível, pulada` }));
          await proximaMusica();
          return difundirEstado();
        });

      default:
        return undefined;
    }
  }

  return {
    init, handleMessage, abrirKtv, abaFechada, janelaFechada, navegadorIniciou, extensaoAtualizada,
    // Só para testes/diagnóstico.
    _estado: async () => { await carregar(); return { estado, rt }; },
  };
}
