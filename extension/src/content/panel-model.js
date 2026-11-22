// Lógica pura do content script (sem DOM, sem chrome.*): modelo do painel e
// decisões do player. Importável no Node (testes) e no content script.
import { CONFIG, roomUrl } from '../shared/protocol.js';

export const MAX_PROXIMOS = 5;
export const PLAY_TIMEOUT_MS = 15000;
export const TENTATIVA_PLAY_MS = 1500;
export const ERROS_SEGUIDOS = 2;

export const TEXTOS = {
  instrucao: 'Escaneie com o celular, na mesma rede Wi‑Fi, para escolher sua música',
  conectando: 'Conectando…',
  semConexao: 'Sem conexão com o servidor',
  semTitulo: 'Sem título',
  tocandoAgora: 'Tocando agora',
  filaVazia: 'Nenhuma música na fila',
};

const ehObj = (x) => x !== null && typeof x === 'object';

/** "1 celular conectado" / "N celulares conectados" / "Nenhum celular conectado". */
export function textoConns(n) {
  if (!n) return 'Nenhum celular conectado';
  return n === 1 ? '1 celular conectado' : `${n} celulares conectados`;
}

function itemVisual(it, atual) {
  const x = ehObj(it) ? it : {};
  return {
    itemId: x.itemId ?? null,
    titulo: String(x.titulo || '').trim() || TEXTOS.semTitulo,
    pedidoPor: String(x.pedidoPor || '').trim(),
    atual,
  };
}

/**
 * Dado o `panel` do service worker ({state, roomId, siteUrl, conns, signaling})
 * devolve o modelo de visualização:
 * { modo: 'ocioso'|'tocando', conectando, url, urlTexto, itens, maisN, conns,
 *   connsTexto, aviso, instrucao }
 * `itens` = [música atual (atual:true), até 5 próximas]; `maisN` = quantas ficaram de fora.
 * Suposição: `state.fila` NÃO inclui `state.atual`.
 */
export function panelModel(panel) {
  const p = ehObj(panel) ? panel : {};
  const state = ehObj(p.state) ? p.state : {};
  const fila = Array.isArray(state.fila) ? state.fila : [];
  const atual = ehObj(state.atual) ? state.atual : null;

  const ocioso = atual == null && fila.length === 0;
  const temSala = typeof p.roomId === 'string' && p.roomId !== '';
  const siteUrl = typeof p.siteUrl === 'string' && p.siteUrl ? p.siteUrl : CONFIG.SITE_URL;
  const url = temSala ? roomUrl(siteUrl, p.roomId) : null;

  const itens = [];
  if (atual) itens.push(itemVisual(atual, true));
  for (const it of fila.slice(0, MAX_PROXIMOS)) itens.push(itemVisual(it, false));
  const maisN = Math.max(0, fila.length - MAX_PROXIMOS);

  const conns = Number.isFinite(p.conns) && p.conns > 0 ? Math.floor(p.conns) : 0;
  return {
    modo: ocioso ? 'ocioso' : 'tocando',
    conectando: !temSala,
    url,
    urlTexto: url || '',
    itens,
    maisN,
    conns,
    connsTexto: textoConns(conns),
    // só avisa quando sabemos que caiu (undefined = ainda não informado)
    aviso: p.signaling === false ? TEXTOS.semConexao : null,
    instrucao: TEXTOS.instrucao,
  };
}

// ---- Navegação ----

/** videoId de uma URL /watch?v=ID (ou null). */
export function videoIdFromHref(href, base = 'https://www.youtube.com') {
  try {
    const u = new URL(href, base);
    if (u.pathname !== '/watch') return null;
    const v = u.searchParams.get('v');
    return v && CONFIG.VIDEO_ID_RE.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** Caminho de navegação para o vídeo (ou null se o ID for inválido). */
export function watchPath(videoId) {
  return typeof videoId === 'string' && CONFIG.VIDEO_ID_RE.test(videoId)
    ? `/watch?v=${videoId}`
    : null;
}

// ---- Decisões do player (puras: o DOM só observa e executa) ----

/** Sessão = uma reprodução pedida pelo SW. */
export function novaSessao(videoId, agora) {
  return {
    videoId,
    t0: agora,
    viuPlaying: false,
    bloqueado: false, // play() recusado pela política de autoplay (aguardando clique)
    endedEnviado: false,
    erroEnviado: false,
    errosSeguidos: 0,
    ultimaTentativa: 0,
  };
}

/**
 * obs: { urlVideoId, temVideo, pausado, terminou, tocando, anuncio, erroNoPlayer }
 * Devolve ações: 'enviarEnded' | 'enviarErro' | 'pausar' | 'tocar'.
 * Muta a sessão (flags) para garantir "uma vez por reprodução".
 */
export function avaliar(s, obs, agora) {
  if (!s || s.endedEnviado || s.erroEnviado) return [];
  const naPagina = obs.urlVideoId === s.videoId;

  // Anúncio (pré-roll ou no meio): o <video> é o mesmo, mas o que toca não é a música.
  // Não conta como `playing` da música e empurra o timeout (anúncios longos não podem pular a música).
  if (naPagina && obs.anuncio) {
    s.t0 = agora;
    return [];
  }

  if (naPagina && obs.tocando) {
    s.viuPlaying = true;
    s.bloqueado = false;
  }

  // Erro do player: precisa persistir por 2 avaliações (evita piscadas na navegação).
  if (naPagina && obs.erroNoPlayer && !obs.anuncio) s.errosSeguidos += 1;
  else s.errosSeguidos = 0;
  if (s.errosSeguidos >= ERROS_SEGUIDOS) {
    s.erroEnviado = true;
    return ['pausar', 'enviarErro'];
  }

  // Fim: só vale depois de ver `playing` nesta sessão (o <video> pode ser reaproveitado
  // e ainda carregar o "ended" do vídeo anterior) e fora de anúncio.
  if (naPagina && obs.terminou && s.viuPlaying && !obs.anuncio) {
    s.endedEnviado = true;
    return ['pausar', 'enviarEnded'];
  }

  // Timeout sem `playing` (não conta enquanto aguarda o clique em "Tocar").
  if (!s.viuPlaying && !s.bloqueado && agora - s.t0 >= PLAY_TIMEOUT_MS) {
    s.erroEnviado = true;
    return ['pausar', 'enviarErro'];
  }

  // Pausado (ou reaproveitado já terminado) e ainda sem `playing`: tenta tocar.
  // play() num vídeo terminado reinicia do começo.
  if (
    naPagina && obs.temVideo && (obs.pausado || obs.terminou) && !s.viuPlaying &&
    !s.bloqueado && agora - s.ultimaTentativa >= TENTATIVA_PLAY_MS
  ) {
    s.ultimaTentativa = agora;
    return ['tocar'];
  }
  return [];
}

/**
 * Guarda anti-autoplay do YouTube: na página /watch, nada deve tocar se não há
 * sessão ativa para aquele vídeo (ex.: "próximo vídeo" automático após o fim).
 * obs: { emWatch, pausado, urlVideoId }
 */
export function deveSilenciar(s, obs) {
  if (!obs.emWatch || obs.pausado) return false;
  if (!s || s.endedEnviado || s.erroEnviado) return true;
  return obs.urlVideoId !== s.videoId;
}
