// KTV: content script (clássico, sem módulos). Só age na aba marcada pelo service worker.
// Lógica pura em panel-model.js; aqui ficam o DOM, o player e a ponte com o SW.
(() => {
  'use strict';

  if (window.__ktvContentLoaded) return; // proteção contra injeção dupla
  window.__ktvContentLoaded = true;

  const log = (...a) => console.debug('[KTV]', ...a);
  let morto = false; // contexto da extensão invalidado (recarregou)
  const limpezas = [];

  function encerrar() {
    if (morto) return;
    morto = true;
    for (const f of limpezas.splice(0)) {
      try { f(); } catch { /* ignora */ }
    }
  }

  function contextoOk() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch { return false; }
  }

  // Envia ao SW; nunca lança. Contexto invalidado -> desmonta tudo.
  async function enviar(msg) {
    if (morto) return undefined;
    if (!contextoOk()) { encerrar(); return undefined; }
    try {
      return await chrome.runtime.sendMessage({ ...msg, target: 'sw' });
    } catch (e) {
      if (/context invalidated/i.test(String(e && e.message))) encerrar();
      else log('sendMessage falhou:', msg.t, e && e.message);
      return undefined;
    }
  }

  const espera = (ms) => new Promise((r) => setTimeout(r, ms));

  // Passo 1: perguntar ao SW se esta aba é a do KTV. Se não for, não faz NADA.
  async function perguntarQuemSou() {
    // A aba pode ser registrada no SW um instante depois de abrir: se a URL traz
    // o marcador `ktv=` (KTV_FLAG), tenta mais algumas vezes.
    const comMarcador = /[?&]ktv=/.test(location.search);
    const tentativas = comMarcador ? 6 : 2; // 2: cobre SW acordando; sem marcador, não insiste
    for (let i = 0; i < tentativas; i++) {
      const r = await enviar({ t: 'whoami' });
      if (morto) return null;
      if (r && r.ktv) return r;
      if (r && !r.ktv && !comMarcador) return null;
      await espera(500);
    }
    return null;
  }

  async function main() {
    const quem = await perguntarQuemSou();
    if (!quem || !quem.ktv || morto) return;

    const url = (p) => chrome.runtime.getURL(p);
    const [proto, modelo, qrMod, css] = await Promise.all([
      import(url('src/shared/protocol.js')),
      import(url('src/content/panel-model.js')),
      import(url('vendor/qrcode.js')).catch((e) => { log('qrcode.js indisponível', e); return null; }),
      carregarCss(url('src/content/overlay.css')),
    ]);
    if (morto) return;
    const { INT, TARGET } = proto;
    const {
      panelModel, videoIdFromHref, watchPath, novaSessao, avaliar, deveSilenciar,
    } = modelo;
    const qrcode = qrMod && qrMod.default;

    // ================= Estado =================
    let painel = {
      state: quem.state, roomId: quem.roomId, siteUrl: quem.siteUrl, conns: quem.conns,
    };
    let iniciou = lerSessao('ktv.iniciou') === '1';
    let recolhido = lerSessao('ktv.recolhido') === '1';
    let sessao = null; // reprodução atual (ver novaSessao)
    let jogoPendente = null; // play recebido antes do clique em "Iniciar"
    let videoAnexado = null;
    let autonavTentativas = 0;
    let ultimoQrUrl = null;
    let ultimoQrSvg = null;

    // ================= Painel (shadow DOM) =================
    const raiz = document.createElement('div');
    raiz.id = 'ktv-root';
    raiz.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;pointer-events:none;margin:0;padding:0;border:0;';
    const sombra = raiz.attachShadow({ mode: 'open' });
    const estilo = document.createElement('style');
    estilo.textContent = css;
    sombra.innerHTML = `
      <div class="ktv">
        <section class="ocioso" aria-label="Entrar na sala do KTV" hidden>
          <div class="ocioso-card">
            <h1>KTV</h1>
            <div class="qr qr-grande" role="img" aria-label="QR Code para entrar na sala"></div>
            <p class="instrucao"></p>
            <p class="url"></p>
            <p class="status" role="status"></p>
            <p class="aviso" role="alert" hidden></p>
          </div>
        </section>
        <aside class="tocando" aria-label="Fila do KTV" hidden>
          <header>
            <span class="conns" role="status"></span>
            <button type="button" class="btn-recolher" aria-label="Recolher painel" aria-expanded="true">–</button>
          </header>
          <div class="corpo">
            <div class="qr qr-pequeno" role="img" aria-label="QR Code para entrar na sala"></div>
            <div class="lista">
              <ol class="fila"></ol>
              <p class="mais" hidden></p>
            </div>
          </div>
          <p class="aviso" role="alert" hidden></p>
        </aside>
      </div>
      <div class="iniciar" hidden>
        <button type="button" class="btn-iniciar" aria-label="Iniciar KTV">▶ Iniciar KTV</button>
      </div>
      <button type="button" class="btn-tocar" aria-label="Tocar vídeo" hidden>▶ Tocar</button>
    `;
    sombra.prepend(estilo);
    const $ = (sel) => sombra.querySelector(sel);
    const el = {
      ocioso: $('.ocioso'), tocando: $('.tocando'), iniciar: $('.iniciar'),
      btnIniciar: $('.btn-iniciar'), btnTocar: $('.btn-tocar'), btnRecolher: $('.btn-recolher'),
      qrGrande: $('.qr-grande'), qrPequeno: $('.qr-pequeno'),
      instrucao: $('.ocioso .instrucao'), urlTexto: $('.ocioso .url'), status: $('.ocioso .status'),
      avisoOcioso: $('.ocioso .aviso'), avisoTocando: $('.tocando .aviso'),
      conns: $('.tocando .conns'), fila: $('.fila'), mais: $('.mais'),
    };

    function anexarRaiz() {
      if (raiz.isConnected) return;
      (document.body || document.documentElement).appendChild(raiz);
    }

    function gerarQr(texto) {
      if (!qrcode) return null;
      try {
        const qr = qrcode(0, 'M');
        qr.addData(texto);
        qr.make();
        return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
      } catch (e) {
        log('falha ao gerar QR', e);
        return null;
      }
    }

    // Só regenera o QR se a URL mudar.
    function atualizarQr(urlSala, ...alvos) {
      if (urlSala !== ultimoQrUrl) {
        ultimoQrUrl = urlSala;
        ultimoQrSvg = urlSala ? gerarQr(urlSala) : null;
        for (const a of alvos) a.dataset.pronto = '';
      }
      for (const a of alvos) {
        if (a.dataset.pronto === '1') continue;
        a.dataset.pronto = '1';
        if (ultimoQrSvg) {
          a.innerHTML = ultimoQrSvg; // SVG gerado localmente pela lib, sem conteúdo externo
        } else {
          a.textContent = '';
          const s = document.createElement('span');
          s.className = 'vazio';
          s.textContent = urlSala ? 'QR indisponível' : modelo.TEXTOS.conectando;
          a.appendChild(s);
        }
      }
    }

    function renderizar() {
      if (morto) return;
      anexarRaiz();
      const m = panelModel(painel);
      const ocioso = m.modo === 'ocioso';
      el.ocioso.hidden = !ocioso;
      el.tocando.hidden = ocioso;

      atualizarQr(m.url, el.qrGrande, el.qrPequeno);
      el.instrucao.textContent = m.conectando ? modelo.TEXTOS.conectando : m.instrucao;
      el.urlTexto.textContent = m.urlTexto;
      el.urlTexto.hidden = !m.urlTexto;
      el.status.textContent = m.connsTexto;
      for (const a of [el.avisoOcioso, el.avisoTocando]) {
        a.hidden = !m.aviso;
        a.textContent = m.aviso || '';
      }
      el.conns.textContent = m.connsTexto;

      // fila compacta
      el.fila.textContent = '';
      for (const it of m.itens) {
        const li = document.createElement('li');
        if (it.atual) li.className = 'atual';
        if (it.atual) {
          const r = document.createElement('span');
          r.className = 'rotulo';
          r.textContent = modelo.TEXTOS.tocandoAgora;
          li.appendChild(r);
        }
        const t = document.createElement('span');
        t.className = 'titulo';
        t.textContent = it.titulo;
        t.title = it.titulo;
        li.appendChild(t);
        if (it.pedidoPor) {
          const q = document.createElement('span');
          q.className = 'quem';
          q.textContent = `pedido por ${it.pedidoPor}`;
          li.appendChild(q);
        }
        el.fila.appendChild(li);
      }
      el.mais.hidden = m.maisN === 0;
      el.mais.textContent = m.maisN > 0 ? `+${m.maisN}` : '';
      aplicarRecolhido();
    }

    function aplicarRecolhido() {
      el.tocando.classList.toggle('recolhido', recolhido);
      el.btnRecolher.setAttribute('aria-expanded', String(!recolhido));
      el.btnRecolher.setAttribute('aria-label', recolhido ? 'Expandir painel' : 'Recolher painel');
      el.btnRecolher.textContent = recolhido ? '+' : '–';
    }

    el.btnRecolher.addEventListener('click', () => {
      recolhido = !recolhido;
      gravarSessao('ktv.recolhido', recolhido ? '1' : '0');
      aplicarRecolhido();
    });

    // "Iniciar": o clique libera o autoplay (gesto do usuário neste documento).
    function mostrarIniciar(mostrar) {
      el.iniciar.hidden = !mostrar;
    }
    function aoIniciar() {
      iniciou = true;
      gravarSessao('ktv.iniciou', '1');
      mostrarIniciar(false);
      enviar({ t: INT.STARTED });
      if (jogoPendente) {
        const id = jogoPendente;
        jogoPendente = null;
        iniciarSessao(id);
      }
    }
    el.btnIniciar.addEventListener('click', aoIniciar);

    // "Tocar": reserva quando o navegador recusa o play() automático.
    el.btnTocar.addEventListener('click', async () => {
      const v = achaVideo();
      el.btnTocar.hidden = true;
      if (sessao) sessao.bloqueado = false;
      if (v) {
        try { await v.play(); } catch (e) { log('play via botão falhou', e && e.name); }
      }
      tick();
    });

    // ================= Player =================
    // O player da página /watch é o #movie_player. A home e as listas também têm players de
    // prévia (passar o mouse na miniatura) com `video.html5-main-video`: nunca usar esses primeiro.
    const SEL_VIDEO = 'video.html5-main-video';
    const achaPlayer = () =>
      document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
    const achaVideo = () => {
      const p = achaPlayer();
      return (p && (p.querySelector(SEL_VIDEO) || p.querySelector('video'))) || document.querySelector(SEL_VIDEO);
    };
    const urlVideoId = () => videoIdFromHref(location.href);
    const emWatch = () => location.pathname === '/watch';

    // [VALIDAR] seletores do player com erro (variam com o redesign do YouTube).
    function erroNoPlayer() {
      const candidatos = [
        '.ytp-error',
        'ytd-player #error-screen',
        'yt-player-error-message-renderer',
        '.player-error-message',
      ];
      const p = achaPlayer();
      for (const sel of candidatos) {
        const e = (p && p.querySelector(sel)) || document.querySelector(sel);
        if (e && (e.textContent || '').trim() && e.getClientRects().length > 0) return true;
      }
      return false;
    }
    const anuncioTocando = () => {
      const p = achaPlayer();
      return p ? p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting') : false;
    };

    // [VALIDAR] botão de autoplay ("Reprodução automática") na barra do player.
    const SEL_AUTONAV_LIGADO = [
      '.ytp-autonav-toggle-button[aria-checked="true"]',
      'button.ytp-autonav-toggle-button[aria-checked="true"]',
      '.ytp-autonav-toggle-button-container [aria-checked="true"]',
    ];
    function desligarAutonav() {
      try {
        for (const sel of SEL_AUTONAV_LIGADO) {
          const b = document.querySelector(sel);
          if (b) { b.click(); log('autoplay do YouTube desligado'); return false; } // confere no próximo tick
        }
        return !!document.querySelector('.ytp-autonav-toggle-button'); // achou e já estava desligado
      } catch (e) {
        log('autonav:', e && e.message);
        return true;
      }
    }
    // [VALIDAR] cancelar a contagem "Próximo vídeo" da tela final.
    function cancelarProximo() {
      try {
        const b = document.querySelector(
          '.ytp-autonav-endscreen-upnext-cancel-button, .ytp-upnext-cancel-button',
        );
        if (b) b.click();
      } catch { /* ignora */ }
    }

    // [VALIDAR] diálogo "Vídeo pausado. Continuar assistindo?" do YouTube em sessões longas:
    // pausa a música no meio (depois de `playing`, então o timeout não cobre). Confirma sozinho.
    function confirmarContinuarAssistindo() {
      try {
        const d = document.querySelector('ytd-popup-container yt-confirm-dialog-renderer');
        if (!d || d.getClientRects().length === 0) return;
        const b = d.querySelector('#confirm-button button, #confirm-button');
        if (b) { b.click(); log('"Continuar assistindo?" confirmado'); }
      } catch { /* ignora */ }
    }

    function observar() {
      const v = achaVideo();
      return {
        urlVideoId: urlVideoId(),
        emWatch: emWatch(),
        temVideo: !!v,
        pausado: v ? v.paused : true,
        terminou: v ? v.ended : false,
        tocando: v ? !v.paused && !v.ended && v.readyState >= 3 && v.currentTime > 0 : false,
        anuncio: anuncioTocando(),
        erroNoPlayer: erroNoPlayer(),
      };
    }

    function anexarVideo(v) {
      if (v === videoAnexado) return;
      if (videoAnexado) {
        for (const ev of EVENTOS_VIDEO) videoAnexado.removeEventListener(ev, aoEventoVideo);
      }
      videoAnexado = v;
      if (v) for (const ev of EVENTOS_VIDEO) v.addEventListener(ev, aoEventoVideo);
    }
    const EVENTOS_VIDEO = ['playing', 'ended', 'error', 'loadeddata', 'pause'];
    function aoEventoVideo() { tick(); }

    async function tentarTocar(v) {
      try {
        await v.play();
        el.btnTocar.hidden = true;
      } catch (e) {
        if (e && e.name === 'NotAllowedError') {
          if (sessao) sessao.bloqueado = true;
          el.btnTocar.hidden = false;
        } else {
          log('play() falhou:', e && e.name); // ex.: AbortError durante troca de vídeo; tenta de novo
        }
      }
    }

    function tick() {
      if (morto) return;
      try {
        if (!contextoOk()) { encerrar(); return; }
        anexarRaiz();
        anexarVideo(achaVideo());
        const obs = observar();

        // YouTube pode ter tocado algo por conta própria (próximo vídeo automático)
        if (deveSilenciar(sessao, obs)) {
          const v = achaVideo();
          if (v) v.pause();
          cancelarProximo();
        }

        // autoplay do YouTube: reaplica a cada página /watch, algumas tentativas
        if (obs.emWatch && autonavTentativas < 20) {
          autonavTentativas += 1;
          if (desligarAutonav()) autonavTentativas = 99;
        }

        if (!sessao) return;
        if (sessao.viuPlaying && obs.pausado && !sessao.endedEnviado) confirmarContinuarAssistindo();
        for (const acao of avaliar(sessao, obs, Date.now())) {
          if (acao === 'pausar') {
            const v = achaVideo();
            if (v) v.pause();
            cancelarProximo();
          } else if (acao === 'enviarEnded') {
            log('vídeo terminou');
            enviar({ t: INT.ENDED, videoId: sessao.videoId }); // o SW ignora ended atrasado de outro vídeo
          } else if (acao === 'enviarErro') {
            log('erro no player / timeout');
            enviar({ t: INT.PLAYER_ERROR, codigo: 'video_indisponivel', videoId: sessao.videoId });
          } else if (acao === 'tocar') {
            const v = achaVideo();
            if (v) tentarTocar(v);
          }
        }
      } catch (e) {
        log('tick falhou:', e && e.message);
      }
    }

    // Navega para o vídeo. [VALIDAR] se o YouTube trata o clique em <a> como navegação
    // SPA; senão o navegador faz carga completa (o script reinicia e retoma pelo whoami).
    function navegar(videoId) {
      const caminho = watchPath(videoId);
      if (!caminho) return;
      const t0 = Date.now();
      try {
        const host = document.querySelector('ytd-app') || document.body;
        const a = document.createElement('a');
        a.href = caminho;
        a.style.display = 'none';
        host.appendChild(a);
        a.click();
        a.remove();
      } catch (e) {
        log('navegação por <a> falhou, usando location.href', e && e.message);
        location.href = caminho;
        return;
      }
      const conferir = () => {
        if (morto || !sessao || sessao.videoId !== videoId) return;
        if (urlVideoId() === videoId) return;
        if (sessao.navIniciada && Date.now() - t0 < 8000) { setTimeout(conferir, 4000); return; }
        log('navegação não ocorreu, fallback location.href');
        location.href = caminho;
      };
      setTimeout(conferir, 3000);
    }

    function iniciarSessao(videoId) {
      if (!iniciou) { jogoPendente = videoId; mostrarIniciar(true); return; }
      sessao = novaSessao(videoId, Date.now());
      autonavTentativas = 0;
      el.btnTocar.hidden = true;
      if (urlVideoId() === videoId) {
        // já está nesse vídeo (ex.: recarga ou repetição): só garantir que toque
        const v = achaVideo();
        if (v && v.ended) v.currentTime = 0;
      } else {
        navegar(videoId);
      }
      tick();
    }

    function parar() {
      sessao = null;
      jogoPendente = null;
      el.btnTocar.hidden = true;
      const v = achaVideo();
      if (v && emWatch()) v.pause();
      cancelarProximo();
    }

    // ================= Mensagens do SW =================
    const bufferMsgs = [];
    let pronto = false;
    function tratar(msg) {
      switch (msg.t) {
        case INT.PLAY:
          if (!msg.videoId) return;
          // play repetido para o que já está tocando: ignora
          if (sessao && sessao.videoId === msg.videoId && !sessao.endedEnviado && !sessao.erroEnviado) return;
          iniciarSessao(msg.videoId);
          break;
        case INT.IDLE:
          parar();
          break;
        case INT.PANEL:
          painel = {
            state: msg.state, roomId: msg.roomId, siteUrl: msg.siteUrl,
            conns: msg.conns, signaling: msg.signaling,
          };
          renderizar();
          break;
        default:
      }
    }
    const aoMensagem = (msg, _sender, responder) => {
      if (morto || !msg || msg.target !== TARGET.CONTENT) return false;
      try { responder({ ok: true }); } catch { /* ignora */ }
      if (!pronto) bufferMsgs.push(msg);
      else tratar(msg);
      return false;
    };
    try {
      chrome.runtime.onMessage.addListener(aoMensagem);
      limpezas.push(() => chrome.runtime.onMessage.removeListener(aoMensagem));
    } catch (e) {
      log('onMessage indisponível', e);
      return;
    }

    // ================= Eventos da página / YouTube =================
    const aoNavegarInicio = () => { if (sessao) sessao.navIniciada = true; };
    const aoNavegarFim = () => {
      autonavTentativas = 0;
      el.btnTocar.hidden = true;
      anexarVideo(achaVideo()); // o <video> pode ter sido trocado
      tick();
    };
    // 'play' não borbulha: captura para pegar qualquer <video> (guarda anti-autoplay)
    const aoPlayCapturado = (e) => {
      if (e.target instanceof HTMLVideoElement) tick();
    };
    document.addEventListener('yt-navigate-start', aoNavegarInicio);
    document.addEventListener('yt-navigate-finish', aoNavegarFim);
    document.addEventListener('play', aoPlayCapturado, true);
    const intervalo = setInterval(tick, 1000);
    limpezas.push(() => {
      document.removeEventListener('yt-navigate-start', aoNavegarInicio);
      document.removeEventListener('yt-navigate-finish', aoNavegarFim);
      document.removeEventListener('play', aoPlayCapturado, true);
      clearInterval(intervalo);
      anexarVideo(null);
      raiz.remove();
    });

    // ================= Partida =================
    renderizar();
    const atual = quem.state && quem.state.atual;
    if (iniciou) {
      // recarga da página no meio de uma música: avisa o SW e retoma o que estava tocando
      enviar({ t: INT.STARTED });
      // Também quando a página recarregou em OUTRO vídeo (ex.: autoplay do YouTube em carga completa
      // venceu a corrida com o `play` do SW, que se perdeu): navega de volta para a música atual.
      if (atual && atual.videoId && quem.state.tocando !== false) {
        iniciarSessao(atual.videoId);
      }
    } else {
      mostrarIniciar(true);
    }
    pronto = true;
    for (const m of bufferMsgs.splice(0)) tratar(m);
    tick();
  }

  // CSS isolado do painel; se o fetch falhar, usa um mínimo embutido.
  async function carregarCss(href) {
    try {
      const r = await fetch(href);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } catch (e) {
      log('overlay.css indisponível, usando CSS mínimo', e && e.message);
      return '[hidden]{display:none!important}.ocioso,.iniciar{position:fixed;inset:0;display:flex;' +
        'align-items:center;justify-content:center;background:#111;color:#fff;pointer-events:auto}' +
        '.tocando{position:fixed;top:8px;right:8px;width:300px;background:rgba(0,0,0,.8);color:#fff;' +
        'pointer-events:auto}.qr svg{width:100%;height:auto}.qr-grande{width:360px}.qr-pequeno{width:90px}' +
        '.btn-tocar{position:fixed;left:50%;top:50%;pointer-events:auto}';
    }
  }

  // sessionStorage pode falhar (bloqueado): sempre com try/catch
  function lerSessao(k) {
    try { return sessionStorage.getItem(k); } catch { return null; }
  }
  function gravarSessao(k, v) {
    try { sessionStorage.setItem(k, v); } catch { /* ignora */ }
  }

  main().catch((e) => {
    if (/context invalidated/i.test(String(e && e.message))) encerrar();
    else log('falha no content script:', e);
  });
})();
