// YouTube falso: serve, via context.route, as páginas /?ktv=1 e /watch?v=ID (com <ytd-app>,
// <video class="html5-main-video"> e um WAV curto), além de /oembed e /results (fixtures).
// Também simula o autoplay do YouTube ("recomendado" ao terminar) para provar que o KTV o contém.
// Fiel ao youtube.com real (conferido com o Chromium contra o site):
//  - a navegação interna (SPA) é o evento `yt-navigate` no <ytd-app>; um <a> comum faz carga completa;
//  - o #movie_player tem a API de som (getVolume/setVolume/isMuted/mute/unMute, volume 0-100) e o
//    <video>.volume é "normalizado" (volume estável); a cada vídeo novo o player reaplica o volume DELE,
//    desfazendo o que foi mexido direto no <video>;
//  - o botão .ytp-fullscreen-button põe o documento todo em tela cheia, que sobrevive à navegação SPA.
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURES_DIR } from './servers.js';

export const ID_RECOMENDADO = 'RECOMENDADO'; // 11 caracteres: vídeo que o autoplay do YouTube tentaria tocar

/** WAV PCM 8 bits mono com um tom curto (o <video> toca áudio puro normalmente). */
export function gerarWav(segundos) {
  const taxa = 8000;
  const n = Math.max(1, Math.round(segundos * taxa));
  const buf = Buffer.alloc(44 + n);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(taxa, 24); buf.writeUInt32LE(taxa, 28); buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34);
  buf.write('data', 36); buf.writeUInt32LE(n, 40);
  for (let i = 0; i < n; i++) buf[44 + i] = 128 + Math.round(40 * Math.sin((2 * Math.PI * 440 * i) / taxa));
  return buf;
}

const lerFixture = (nome) => fs.readFileSync(path.join(FIXTURES_DIR, nome), 'utf8');

// Script da página falsa (roda no mundo "main"; o content script da extensão roda no mundo isolado).
function scriptPagina(cfg) {
  return `(() => {
  const CFG = ${JSON.stringify(cfg)};
  const REC = ${JSON.stringify(ID_RECOMENDADO)};
  const video = document.querySelector('video.html5-main-video');
  const erro = document.querySelector('.ytp-error');
  const toggle = document.querySelector('.ytp-autonav-toggle-button');
  const log = (window.__fake = { carregados: [], playing: [], ended: [], recTocou: 0, cliquesToggle: 0, api: null });
  const player = document.getElementById('movie_player');
  // API de som do player (como o YouTube): estado próprio, aplicado ao <video> com normalização.
  const som = { volume: 100, mudo: false };
  log.api = som;
  const NORMALIZACAO = 0.8;
  const aplicarSom = () => { video.volume = (som.volume / 100) * NORMALIZACAO; video.muted = som.mudo; };
  if (CFG.api !== false) {
    player.getVolume = () => som.volume;
    player.setVolume = (n) => { som.volume = Math.max(0, Math.min(100, Math.round(Number(n)))); aplicarSom(); };
    player.isMuted = () => som.mudo;
    player.mute = () => { som.mudo = true; aplicarSom(); };
    player.unMute = () => { som.mudo = false; aplicarSom(); };
  }
  document.querySelector('.ytp-fullscreen-button').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => { log.fsRecusado = (log.fsRecusado || 0) + 1; });
  });
  toggle.addEventListener('click', () => {
    log.cliquesToggle++;
    toggle.setAttribute('aria-checked', toggle.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
  });
  const idAtual = () => new URL(location.href).searchParams.get('v');
  function carregar(id) {
    log.carregados.push(id);
    erro.style.display = 'none';
    video.pause();
    if (CFG.indisponiveis.includes(id)) {
      video.removeAttribute('src'); video.load();
      erro.style.display = 'block';
      return;
    }
    const d = (CFG.duracoes && CFG.duracoes[id]) || CFG.duracao;
    video.src = '/fake.wav?d=' + d + '&v=' + id;
    aplicarSom(); // o player reaplica o volume dele a cada vídeo
    // O YouTube real tenta tocar sozinho ao abrir um vídeo (pode ser barrado pela política de autoplay).
    video.play().catch(() => {});
  }
  log.documento = Math.random(); // muda a cada carga completa da página (SPA mantém)
  function irPara(id, spa) {
    if (!spa || CFG.modo === 'full') { location.href = '/watch?v=' + id; return; }
    document.dispatchEvent(new CustomEvent('yt-navigate-start'));
    history.pushState({}, '', '/watch?v=' + id);
    carregar(id);
    document.dispatchEvent(new CustomEvent('yt-navigate-finish'));
  }
  video.addEventListener('playing', () => {
    const id = idAtual();
    log.playing.push(id);
    if (id === REC) log.recTocou++;
  });
  video.addEventListener('ended', () => {
    const id = idAtual();
    log.ended.push(id);
    // Autoplay do YouTube: vai para o "recomendado" se o botão estiver ligado (ou sempre, no modo 'sempre').
    const ligado = toggle.getAttribute('aria-checked') === 'true';
    if (CFG.autoplay === 'sempre' || (CFG.autoplay === 'botao' && ligado)) {
      // Como o YouTube: se o usuário já navegou para outro vídeo, o autoplay é cancelado.
      setTimeout(() => { if (idAtual() === id) irPara(REC, true); }, CFG.atrasoAutoplay);
    }
  });
  // Navegação SPA: o evento yt-navigate no <ytd-app> (como o YouTube; um <a> comum recarrega a página).
  document.querySelector('ytd-app').addEventListener('yt-navigate', (e) => {
    const ep = e.detail && e.detail.endpoint;
    const id = ep && ep.watchEndpoint && ep.watchEndpoint.videoId;
    if (id) irPara(id, true);
  });
  if (idAtual()) carregar(idAtual());
})();`;
}

// Página inicial: sem player; o yt-navigate para um vídeo vira carga da /watch.
function scriptInicio() {
  return `document.querySelector('ytd-app').addEventListener('yt-navigate', (e) => {
  const ep = e.detail && e.detail.endpoint;
  const id = ep && ep.watchEndpoint && ep.watchEndpoint.videoId;
  if (id) location.href = '/watch?v=' + id;
});`;
}

function paginaHtml(cfg, videoId) {
  const watch = !!videoId;
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>${watch ? 'Vídeo falso' : 'YouTube falso'} - YouTube</title>
<style>body{margin:0;background:#0f0f0f;color:#eee;font:16px sans-serif}#movie_player{position:relative;width:640px;height:360px;background:#000}
video{width:640px;height:360px}.ytp-error{position:absolute;inset:0;background:#222;padding:40px}</style></head>
<body><ytd-app>
<h1>${watch ? 'Assistindo ' + videoId : 'Página inicial do YouTube falso'}</h1>
${watch ? `<div id="movie_player" class="html5-video-player">
  <video class="html5-main-video" playsinline></video>
  <button class="ytp-autonav-toggle-button" aria-checked="true" aria-label="Reprodução automática">Autoplay</button>
  <button class="ytp-fullscreen-button" aria-label="Tela cheia">Tela cheia</button>
  <div class="ytp-error" style="display:none"><div class="ytp-error-content">Este vídeo não está disponível</div></div>
</div>` : ''}
</ytd-app>
<script>${watch ? scriptPagina(cfg) : scriptInicio()}</script>
</body></html>`;
}

/**
 * Instala as rotas do YouTube falso no contexto. Devolve o controle (campos mutáveis):
 *  indisponiveis: Set de videoIds com erro no player; oembedFalha: Map id -> status HTTP;
 *  titulos: Map id -> título do oEmbed; busca: 'normal'|'lockup'|'falha'|'vazia';
 *  modo: 'spa'|'full'; autoplay: 'botao'|'sempre'|'nunca'; duracao (s); duracoes: Map id -> s;
 *  api: false tira a API de som do #movie_player (o KTV cai no <video> direto).
 */
export async function instalarYoutubeFalso(context) {
  const ctl = {
    indisponiveis: new Set(), oembedFalha: new Map(), titulos: new Map(),
    busca: 'normal', modo: 'spa', autoplay: 'botao', duracao: 1.5, duracoes: new Map(), atrasoAutoplay: 300, api: true,
    pedidos: [], // { tipo, url, doSw }
    consultas: [], // termos de busca recebidos
  };
  const wavs = new Map();
  const cfg = () => ({
    indisponiveis: [...ctl.indisponiveis], modo: ctl.modo, autoplay: ctl.autoplay, duracao: ctl.duracao,
    duracoes: Object.fromEntries(ctl.duracoes), atrasoAutoplay: ctl.atrasoAutoplay, api: ctl.api,
  });

  await context.route('https://www.youtube.com/**', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const doSw = !!req.serviceWorker();
    // Como o youtube.com real: página com Trusted Types obrigatório (o painel não usa innerHTML).
    const html = (body, status = 200) => route.fulfill({
      status, contentType: 'text/html; charset=utf-8', body,
      headers: { 'content-security-policy': "require-trusted-types-for 'script'" },
    });
    switch (u.pathname) {
      case '/':
        ctl.pedidos.push({ tipo: 'home', url: req.url(), doSw });
        return html(paginaHtml(cfg(), null));
      case '/watch':
        ctl.pedidos.push({ tipo: 'watch', url: req.url(), doSw });
        return html(paginaHtml(cfg(), u.searchParams.get('v')));
      case '/fake.wav': {
        const d = Number(u.searchParams.get('d')) || 1.5;
        if (!wavs.has(d)) wavs.set(d, gerarWav(d));
        const wav = wavs.get(d);
        const faixa = /bytes=(\d+)-(\d*)/.exec(req.headers().range || '');
        if (faixa) { // o <video> pede por Range
          const ini = Number(faixa[1]);
          const fim = faixa[2] ? Number(faixa[2]) : wav.length - 1;
          return route.fulfill({
            status: 206, contentType: 'audio/wav',
            headers: { 'content-range': `bytes ${ini}-${fim}/${wav.length}`, 'accept-ranges': 'bytes' },
            body: wav.subarray(ini, fim + 1),
          });
        }
        return route.fulfill({ status: 200, contentType: 'audio/wav', headers: { 'accept-ranges': 'bytes' }, body: wav });
      }
      case '/oembed': {
        ctl.pedidos.push({ tipo: 'oembed', url: req.url(), doSw });
        const alvo = new URL(u.searchParams.get('url') || 'https://x/');
        const id = alvo.searchParams.get('v');
        if (ctl.oembedFalha.has(id)) return route.fulfill({ status: ctl.oembedFalha.get(id), body: 'Not Found' });
        return route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ title: ctl.titulos.get(id) || `Música ${id}`, author_name: `Canal ${id}`, type: 'video' }),
        });
      }
      case '/results': {
        const q = u.searchParams.get('search_query') || '';
        ctl.consultas.push(q);
        ctl.pedidos.push({ tipo: 'busca', url: req.url(), doSw });
        if (ctl.busca === 'falha') return route.fulfill({ status: 503, body: 'indisponível' });
        if (ctl.busca === 'vazia') return html('<html><body>sem dados</body></html>');
        return html(lerFixture(ctl.busca === 'lockup' ? 'search-lockup.html' : 'search.html'));
      }
      default:
        return route.fulfill({ status: 204, body: '' });
    }
  });
  return ctl;
}
