// YouTube falso: serve, via context.route, as páginas /?ktv=1 e /watch?v=ID (com <ytd-app>,
// <video class="html5-main-video"> e um WAV curto), além de /oembed e /results (fixtures).
// Também simula o autoplay do YouTube ("recomendado" ao terminar) para provar que o KTV o contém.
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
  const log = (window.__fake = { carregados: [], playing: [], ended: [], recTocou: 0, cliquesToggle: 0 });
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
    // O YouTube real tenta tocar sozinho ao abrir um vídeo (pode ser barrado pela política de autoplay).
    video.play().catch(() => {});
  }
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
  // Navegação SPA: o clique em <a href="/watch?v=…"> não recarrega a página (como no YouTube).
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    const u = new URL(a.href, location.href);
    if (u.pathname !== '/watch' || CFG.modo === 'full') return;
    e.preventDefault();
    irPara(u.searchParams.get('v'), true);
  }, true);
  if (idAtual()) carregar(idAtual());
})();`;
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
  <div class="ytp-error" style="display:none"><div class="ytp-error-content">Este vídeo não está disponível</div></div>
</div>` : ''}
</ytd-app>
${watch ? `<script>${scriptPagina(cfg)}</script>` : ''}
</body></html>`;
}

/**
 * Instala as rotas do YouTube falso no contexto. Devolve o controle (campos mutáveis):
 *  indisponiveis: Set de videoIds com erro no player; oembedFalha: Map id -> status HTTP;
 *  titulos: Map id -> título do oEmbed; busca: 'normal'|'lockup'|'falha'|'vazia';
 *  modo: 'spa'|'full'; autoplay: 'botao'|'sempre'|'nunca'; duracao (s); duracoes: Map id -> s.
 */
export async function instalarYoutubeFalso(context) {
  const ctl = {
    indisponiveis: new Set(), oembedFalha: new Map(), titulos: new Map(),
    busca: 'normal', modo: 'spa', autoplay: 'botao', duracao: 1.5, duracoes: new Map(), atrasoAutoplay: 300,
    pedidos: [], // { tipo, url, doSw }
    consultas: [], // termos de busca recebidos
  };
  const wavs = new Map();
  const cfg = () => ({
    indisponiveis: [...ctl.indisponiveis], modo: ctl.modo, autoplay: ctl.autoplay, duracao: ctl.duracao,
    duracoes: Object.fromEntries(ctl.duracoes), atrasoAutoplay: ctl.atrasoAutoplay,
  });

  await context.route('https://www.youtube.com/**', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const doSw = !!req.serviceWorker();
    const html = (body, status = 200) => route.fulfill({ status, contentType: 'text/html; charset=utf-8', body });
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
