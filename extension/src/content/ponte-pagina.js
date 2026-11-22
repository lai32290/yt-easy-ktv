// KTV: ponte no mundo principal (world: MAIN) da página do YouTube. Script clássico, sem módulos.
//
// O content script (content.js) roda num mundo isolado: enxerga o DOM, mas não os métodos que o
// YouTube pendura no #movie_player (setVolume, mute…) nem consegue disparar a navegação interna do
// YouTube (o evento `yt-navigate` precisa de um objeto em `detail`, que não atravessa os mundos).
//
// Por que isso importa (conferido no youtube.com real):
//  - Mexer direto em <video>.volume/.muted funciona só até o próximo vídeo (ou anúncio): o player
//    reaplica o volume dele. Pela API (setVolume/mute) o volume vale para as próximas músicas e o
//    controle de volume do próprio YouTube fica certo. O <video>.volume ainda vem "normalizado"
//    (volume estável), então ler dele dá um número diferente do volume que o usuário escolheu.
//  - Um <a href="/watch?v=…"> criado por script e clicado faz carga completa da página (sai da tela
//    cheia). O `yt-navigate` no <ytd-app> é a navegação interna (SPA): troca de vídeo e mantém a tela cheia.
//
// A ponte é inerte: só reage a pedidos do content script (que só existe na aba KTV).
// Protocolo (síncrono, no mesmo documento): o content dispara `ktv:pedido` em `document` com
// detail = JSON {id, op, ...}; a ponte responde gravando JSON {id, ok, ...} no atributo
// `data-ktv-resposta` do <html> antes de o dispatchEvent voltar.
(() => {
  'use strict';

  if (window.__ktvPonte) return;
  window.__ktvPonte = true;

  const EVENTO = 'ktv:pedido';
  const ATRIBUTO = 'data-ktv-resposta';
  const VIDEO_ID_RE = /^[\w-]{11}$/;
  // Só estes métodos do player podem ser chamados pelo content script.
  const METODOS = new Set(['setVolume', 'mute', 'unMute']);

  const player = () => document.getElementById('movie_player');
  const temApi = (p) => !!p && ['getVolume', 'setVolume', 'isMuted', 'mute', 'unMute']
    .every((k) => typeof p[k] === 'function');

  function status() {
    const p = player();
    if (!temApi(p)) return { ok: false };
    const volume = Number(p.getVolume());
    return { ok: true, volume: Number.isFinite(volume) ? volume : null, mudo: Boolean(p.isMuted()) };
  }

  const ops = {
    status,
    chamar({ chamadas }) {
      const p = player();
      if (!temApi(p) || !Array.isArray(chamadas)) return { ok: false };
      for (const c of chamadas) {
        if (!Array.isArray(c) || !METODOS.has(c[0])) continue;
        const args = c.slice(1);
        if (!args.every((a) => Number.isFinite(a))) continue; // só números (setVolume)
        p[c[0]](...args);
      }
      return status();
    },
    navegar({ videoId }) {
      const app = document.querySelector('ytd-app');
      if (!app || typeof videoId !== 'string' || !VIDEO_ID_RE.test(videoId)) return { ok: false };
      const url = `/watch?v=${videoId}`;
      app.dispatchEvent(new CustomEvent('yt-navigate', {
        bubbles: true,
        composed: true,
        detail: {
          endpoint: {
            commandMetadata: { webCommandMetadata: { url, webPageType: 'WEB_PAGE_TYPE_WATCH', rootVe: 3832 } },
            watchEndpoint: { videoId },
          },
        },
      }));
      return { ok: true };
    },
  };

  document.addEventListener(EVENTO, (e) => {
    let pedido;
    try { pedido = JSON.parse(e.detail); } catch { return; }
    if (!pedido || typeof pedido.op !== 'string' || !Object.prototype.hasOwnProperty.call(ops, pedido.op)) return;
    let r;
    try { r = ops[pedido.op](pedido); } catch (err) { r = { ok: false, erro: String(err && err.message) }; }
    try { document.documentElement.setAttribute(ATRIBUTO, JSON.stringify({ ...r, id: pedido.id })); } catch { /* ignora */ }
  });
})();
