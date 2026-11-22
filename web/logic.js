// Lógica pura do site do celular (sem DOM, sem rede). Testada em tests/unit/web-logic.test.js.

const SALA_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const SIG_RE = /^([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(?::(\d{1,5}))?$/;

/** Lê o hash (`#sala=ID&sig=host:porta&secure=0|1`). Valores inválidos viram ''/null. */
export function parseHash(hash) {
  const p = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const salaBruta = (p.get('sala') || '').trim();
  const sala = SALA_RE.test(salaBruta) ? salaBruta : '';

  let sig = null;
  const m = SIG_RE.exec((p.get('sig') || '').trim());
  if (m) {
    const port = m[2] === undefined ? null : Number(m[2]);
    if (port === null || (port >= 1 && port <= 65535)) sig = { host: m[1], port };
  }

  const s = (p.get('secure') || '').trim().toLowerCase();
  const secure = s === '1' || s === 'true' ? true : s === '0' || s === 'false' ? false : null;
  return { sala, sig, secure };
}

/** Combina o hash com a config padrão e devolve as opções do `new Peer()`. */
export function resolverSinalizacao(parsed, base) {
  const out = { host: base.host, port: base.port, path: base.path, secure: base.secure };
  if (parsed.sig) {
    out.host = parsed.sig.host;
    const secure = parsed.secure ?? (parsed.sig.port === null || parsed.sig.port === 443);
    out.secure = secure;
    out.port = parsed.sig.port ?? (secure ? 443 : 80);
  } else if (parsed.secure !== null) {
    out.secure = parsed.secure;
  }
  return out;
}

/** Atraso de reconexão (ms): 1s, 2s, 4s, 8s, 15s, 15s... */
export function backoffDelay(tentativa, min = 1000, max = 15000) {
  const n = Math.max(0, Math.floor(tentativa) || 0);
  return Math.min(max, min * 2 ** Math.min(n, 20));
}

/** Erros do PeerJS que indicam só a queda do servidor de sinalização (a conexão P2P aberta segue valendo). */
export function erroSoDeSinalizacao(tipo) {
  return ['network', 'socket-error', 'socket-closed', 'server-error'].includes(tipo);
}

/** Só o dono do pedido pode remover o item. */
export function podeRemover(item, pid) {
  return !!item && typeof pid === 'string' && pid !== '' && item.pid === pid;
}

/** Botão "Pular" visível? (política 'anfitriao' não tem anfitrião no celular ainda). */
export function podePular(policy) {
  return policy === 'todos';
}

/** Texto do erro: usa `msg` se vier, senão a tabela pt-BR. */
export function textoErro(err, errText) {
  const msg = err && typeof err.msg === 'string' ? err.msg.trim() : '';
  if (msg) return msg.slice(0, 200);
  return (err && errText && errText[err.codigo]) || 'Algo deu errado. Tente de novo.';
}

/** Resposta de busca vale só se o id bate com o da última busca. */
export function resultadoVale(res, ultimoId) {
  return !!res && ultimoId != null && ultimoId !== '' && res.id === ultimoId;
}

const str = (v, max = 300) => (typeof v === 'string' ? v.slice(0, max) : typeof v === 'number' ? String(v) : '');

/** Normaliza um Item vindo da rede (só strings). */
export function normalizarItem(it) {
  if (!it || typeof it !== 'object') return null;
  return {
    itemId: str(it.itemId, 100),
    videoId: str(it.videoId, 32),
    titulo: str(it.titulo),
    canal: str(it.canal),
    duracao: str(it.duracao, 20),
    pedidoPor: str(it.pedidoPor, 60),
    pid: str(it.pid, 100),
  };
}

/** Normaliza o `state` recebido. */
export function normalizarState(msg) {
  const m = msg && typeof msg === 'object' ? msg : {};
  const fila = Array.isArray(m.fila) ? m.fila.slice(0, 500).map(normalizarItem).filter(Boolean) : [];
  const pl = m.player && typeof m.player === 'object' ? m.player : {};
  const vol = Number(pl.volume);
  const player = {
    pausado: !!pl.pausado,
    mudo: !!pl.mudo,
    volume: Number.isFinite(vol) ? Math.max(0, Math.min(100, Math.round(vol))) : 100,
  };
  return { atual: normalizarItem(m.atual), fila, tocando: !!m.tocando, player };
}

/** Conjunto de videoIds presentes (atual + fila). */
export function idsNoEstado(state) {
  const s = new Set();
  if (!state) return s;
  if (state.atual && state.atual.videoId) s.add(state.atual.videoId);
  for (const it of state.fila || []) if (it.videoId) s.add(it.videoId);
  return s;
}

/** Mensagem C2E.CONTROL para o botão de play/pausa e o de mudo, conforme o estado atual do player. */
export function acaoPlayPausa(player) {
  return player && player.pausado ? 'play' : 'pause';
}
export function acaoMudo(player) {
  return player && player.mudo ? 'unmute' : 'mute';
}

/** Normaliza resultados de busca. */
export function normalizarResultados(itens, max = 30) {
  if (!Array.isArray(itens)) return [];
  return itens.slice(0, max).map((r) => (r && typeof r === 'object'
    ? { videoId: str(r.videoId, 32), titulo: str(r.titulo), canal: str(r.canal), duracao: str(r.duracao, 20) }
    : null)).filter((r) => r && r.videoId);
}

/** Extrai o link do texto da área de transferência (primeiro http(s) ou, senão, a primeira palavra); '' se vazio. */
export function linkDaAreaDeTransferencia(texto) {
  if (typeof texto !== 'string') return '';
  const m = texto.match(/https?:\/\/\S+/i);
  return m ? m[0] : (texto.trim().split(/\s+/)[0] || '');
}
