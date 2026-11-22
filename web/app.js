// Site do celular: conecta à sala (PeerJS), mostra a fila, busca e adiciona músicas.
// Todo texto vindo da rede entra no DOM só via textContent.
import { CONFIG, C2E, E2C, ERR_TEXT, thumbUrl } from './protocol.js';
import {
  parseHash, resolverSinalizacao, backoffDelay, podeRemover, podePular, textoErro,
  resultadoVale, normalizarState, idsNoEstado, normalizarResultados, erroSoDeSinalizacao, linkDaAreaDeTransferencia,
  acaoPlayPausa, acaoMudo,
} from './logic.js';

const $ = (id) => document.getElementById(id);

// ---------- Armazenamento tolerante (funciona sem localStorage) ----------
const memStore = new Map();
const store = {
  get(k) {
    try { const v = localStorage.getItem(k); if (v !== null) return v; } catch { /* sem storage */ }
    return memStore.has(k) ? memStore.get(k) : null;
  },
  set(k, v) {
    memStore.set(k, v);
    try { localStorage.setItem(k, v); } catch { /* sem storage */ }
  },
};

function novoId() {
  try { if (crypto.randomUUID) return crypto.randomUUID(); } catch { /* segue */ }
  return 'p' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ---------- Estado local (a fila vem sempre do último `state`) ----------
const parsed = parseHash(location.hash);
const sala = parsed.sala;
const sig = resolverSinalizacao(parsed, CONFIG.SIGNALING);

let meuPid = store.get('ktv.pid');
if (!meuPid) { meuPid = novoId(); store.set('ktv.pid', meuPid); }
let nome = (store.get('ktv.nome') || '').trim();

let lastState = null;            // último state normalizado
let connStatus = 'conectando';   // conectando | conectado | desconectado | erro
let statusDetail = '';
let peer = null;
let conn = null;
let geracao = 0;                 // invalida eventos de Peers antigos
let tentativa = 0;
let retryTimer = null;
let retryAt = 0;
let openTimer = null;
let tickTimer = null;

let ultimaBuscaId = null;
let buscaSeq = 0;
let resultados = [];
let buscaEstado = 'idle';        // idle | carregando | ok | vazio | erro
let buscaMsg = '';
let debounceTimer = null;
const pendentes = new Set();     // videoIds enviados e ainda não vistos no state
let aguardandoAdd = 0;           // adds enviados sem confirmação (para o aviso "Adicionada!")
let addTimer = null;

// ---------- Utilidades de DOM ----------
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function thumb(videoId) {
  if (!CONFIG.VIDEO_ID_RE.test(videoId || '')) return el('span', 'thumb ph');
  const img = el('img', 'thumb');
  img.src = thumbUrl(videoId);
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  return img;
}

function toast(id, texto, ms) {
  const t = $(id);
  t.textContent = texto;
  t.hidden = false;
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.hidden = true; }, ms);
}
const toastErro = (texto) => toast('error-toast', texto, 5000);
const toastOk = (texto) => toast('info-toast', texto, 2500);

// ---------- Status da conexão ----------
const ROTULOS = { conectando: 'Conectando…', conectado: 'Conectado', desconectado: 'Desconectado', erro: 'Erro' };

function setStatus(s, detalhe = '') {
  connStatus = s;
  statusDetail = detalhe;
  renderStatus();
}

function renderStatus() {
  const st = $('status');
  st.textContent = ROTULOS[connStatus];
  st.dataset.state = connStatus;
  $('status-dot').className = 'dot ' + connStatus;
  let d = statusDetail;
  if (retryTimer && (connStatus === 'desconectado' || connStatus === 'erro')) {
    const s = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
    d = (d ? d + ' ' : '') + `Nova tentativa em ${s}s.`;
  }
  $('status-detail').textContent = d;
  $('reconnect-btn').hidden = !(connStatus === 'desconectado' || connStatus === 'erro');
}

// ---------- Conexão e reconexão ----------
function limparConexao() {
  geracao++;
  clearTimeout(openTimer);
  const c = conn, p = peer;
  conn = null; peer = null;
  try { if (c) c.close(); } catch { /* ignora */ }
  try { if (p) p.destroy(); } catch { /* ignora */ }
}

function agendarReconexao() {
  if (retryTimer) return;
  const atraso = backoffDelay(tentativa++);
  retryAt = Date.now() + atraso;
  retryTimer = setTimeout(() => { retryTimer = null; clearInterval(tickTimer); conectar(); }, atraso);
  clearInterval(tickTimer);
  tickTimer = setInterval(renderStatus, 1000);
  renderStatus();
}

function falhou(estado, detalhe) {
  limparConexao();
  setStatus(estado, detalhe);
  agendarReconexao();
}

function conectar() {
  clearTimeout(retryTimer); retryTimer = null;
  clearInterval(tickTimer);
  limparConexao();
  const minha = geracao;
  const vivo = () => minha === geracao;

  if (typeof window.Peer !== 'function') {
    setStatus('erro', 'Não foi possível carregar a biblioteca de conexão. Recarregue a página.');
    return;
  }
  setStatus('conectando', tentativa > 0 ? `Tentativa ${tentativa + 1}…` : '');

  let p;
  try {
    p = new window.Peer(undefined, { host: sig.host, port: sig.port, path: sig.path, secure: sig.secure });
  } catch (e) {
    falhou('erro', 'Falha ao iniciar a conexão.');
    return;
  }
  peer = p;

  // Se não abrir a conexão em 20s, tenta de novo.
  openTimer = setTimeout(() => {
    if (vivo()) falhou('erro', 'A conexão demorou demais.');
  }, 20000);

  p.on('open', () => {
    if (!vivo()) return;
    const c = p.connect(sala, { reliable: true });
    conn = c;
    c.on('open', () => {
      if (!vivo()) return;
      clearTimeout(openTimer);
      tentativa = 0;
      setStatus('conectado');
      enviarHello();
    });
    c.on('data', (d) => { if (vivo()) aoReceber(d); });
    c.on('close', () => { if (vivo()) falhou('desconectado', 'A conexão com o KTV caiu.'); });
    c.on('error', () => { if (vivo()) falhou('erro', 'Erro na conexão com o KTV.'); });
  });

  p.on('error', (err) => {
    if (!vivo()) return;
    const tipo = err && err.type;
    // Queda só da sinalização com o P2P aberto: não derruba a conexão com o KTV (o 'disconnected' já cuida do resto).
    if (conn && conn.open && erroSoDeSinalizacao(tipo)) return;
    let det = 'Não foi possível conectar.';
    if (tipo === 'peer-unavailable') det = 'Sala não encontrada. O KTV está aberto no computador?';
    else if (tipo === 'network' || tipo === 'socket-error' || tipo === 'socket-closed' || tipo === 'server-error') det = 'Sem acesso ao servidor de conexão.';
    else if (tipo === 'browser-incompatible') det = 'Este navegador não suporta a conexão direta.';
    falhou('erro', det);
  });

  // Caiu só do servidor de sinalização: a conexão aberta com o KTV continua valendo.
  p.on('disconnected', () => {
    if (!vivo()) return;
    if (!(conn && conn.open)) falhou('desconectado', 'Sem acesso ao servidor de conexão.');
  });
}

function reconectarManual() {
  tentativa = 0;
  conectar();
}

// ---------- Envio ----------
function enviar(msg) {
  if (conn && conn.open) {
    try { conn.send(msg); return true; } catch { /* cai abaixo */ }
  }
  toastErro('Sem conexão com o KTV. Tente reconectar.');
  return false;
}

function itemIdsNoEstado(state) {
  return new Set([state?.atual, ...(state?.fila || [])].filter(Boolean).map((it) => it.itemId));
}

function enviarHello() {
  if (nome && conn && conn.open) {
    try { conn.send({ t: C2E.HELLO, nome, pid: meuPid }); } catch { /* ignora */ }
  }
}

// ---------- Recebimento ----------
function aoReceber(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === E2C.STATE) {
    const antes = itemIdsNoEstado(lastState);
    lastState = normalizarState(msg);
    // O mesmo vídeo pode estar várias vezes na fila: o que conta é o itemId novo, não o videoId.
    const novos = [lastState.atual, ...lastState.fila].filter((it) => it && !antes.has(it.itemId));
    if (aguardandoAdd > 0 && novos.length) {
      aguardandoAdd = 0;
      toastOk('Adicionada!');
    }
    for (const it of novos) pendentes.delete(it.videoId);
    renderFila();
    renderResultados();
    renderControle();
  } else if (msg.t === E2C.RESULTS) {
    if (!resultadoVale(msg, ultimaBuscaId)) return; // resposta antiga
    resultados = normalizarResultados(msg.itens);
    buscaEstado = resultados.length ? 'ok' : 'vazio';
    renderResultados();
  } else if (msg.t === E2C.ERROR) {
    const texto = textoErro(msg, ERR_TEXT);
    aguardandoAdd = 0;
    pendentes.clear();
    if (buscaEstado === 'carregando' && ((msg.id != null && msg.id === ultimaBuscaId) || msg.codigo === 'busca_falhou')) {
      buscaEstado = 'erro';
      buscaMsg = texto;
    }
    toastErro(texto);
    renderResultados();
  }
}

// ---------- Fila ----------
function renderFila() {
  const st = lastState;
  const now = $('now-playing');
  now.replaceChildren();
  now.classList.toggle('playing', !!(st && st.atual));

  if (st && st.atual) {
    const a = st.atual;
    now.append(thumb(a.videoId));
    const body = el('div', 'now-body');
    const info = el('div', 'info');
    info.append(el('span', 'badge', st.tocando ? 'Tocando' : 'Pausado'));
    info.append(el('span', 'title', a.titulo || 'Sem título'));
    info.append(el('span', 'meta', [a.canal, a.pedidoPor ? 'pedido por ' + a.pedidoPor : ''].filter(Boolean).join(' · ')));
    body.append(info);
    if (podePular(CONFIG.SKIP_POLICY)) {
      const skip = el('button', 'btn btn-small', 'Pular');
      skip.type = 'button';
      skip.setAttribute('data-testid', 'skip-btn');
      skip.addEventListener('click', () => {
        // Leva o itemId: o KTV ignora o pulo se essa música já saiu (toque duplo, outro celular).
        if (enviar({ t: C2E.SKIP, itemId: a.itemId })) skip.disabled = true;
      });
      body.append(skip);
    }
    now.append(body);
  } else {
    now.append(el('div', 'now-empty', st ? 'Nada tocando no momento.' : 'Aguardando o KTV…'));
  }

  const lista = $('queue-list');
  lista.replaceChildren();
  const fila = st ? st.fila : [];
  $('queue-count').textContent = fila.length ? `(${fila.length})` : '';
  $('queue-empty').hidden = !st || fila.length > 0;

  for (const it of fila) {
    const li = el('li', 'item');
    li.setAttribute('data-testid', 'queue-item');
    li.dataset.itemId = it.itemId;
    li.append(thumb(it.videoId));
    const info = el('div', 'info');
    info.append(el('span', 'title', it.titulo || 'Sem título'));
    if (it.canal) info.append(el('span', 'meta', it.canal));
    info.append(el('span', 'meta', 'pedido por ' + (it.pedidoPor || 'alguém')));
    li.append(info);
    if (podeRemover(it, meuPid)) {
      const rm = el('button', 'btn btn-small btn-danger', 'Remover');
      rm.type = 'button';
      rm.setAttribute('data-testid', 'remove-btn');
      rm.addEventListener('click', () => enviar({ t: C2E.REMOVE, itemId: it.itemId }));
      li.append(rm);
    }
    lista.append(li);
  }
}

// ---------- Controle do player ----------
const PLAYER_PADRAO = { pausado: false, mudo: false, volume: 100 };

function renderControle() {
  const st = lastState;
  const ativo = !!(st && st.atual);
  const pl = (st && st.player) || PLAYER_PADRAO;
  $('ctl-titulo').textContent = ativo ? st.atual.titulo || 'Sem título' : 'Nada tocando no momento.';
  for (const b of $('ctl-grid').querySelectorAll('button')) b.disabled = !ativo;
  $('ctl-playpause-txt').textContent = pl.pausado ? 'Tocar' : 'Pausar';
  $('ctl-playpause-ico').textContent = pl.pausado ? '\u25B6' : '\u23F8';
  $('ctl-mute-txt').textContent = pl.mudo ? 'Ativar som' : 'Mudo';
  $('ctl-volume').textContent = ativo ? `Volume: ${pl.mudo ? 'mudo' : pl.volume + '%'}` : '';
}

function controlar(acao) {
  enviar({ t: C2E.CONTROL, acao });
}

function ligarControle() {
  const player = () => (lastState && lastState.player) || PLAYER_PADRAO;
  $('ctl-playpause').addEventListener('click', () => controlar(acaoPlayPausa(player())));
  $('ctl-mute').addEventListener('click', () => controlar(acaoMudo(player())));
  $('ctl-restart').addEventListener('click', () => controlar('restart'));
  $('ctl-back').addEventListener('click', () => controlar('back'));
  $('ctl-forward').addEventListener('click', () => controlar('forward'));
  $('ctl-voldown').addEventListener('click', () => controlar('volDown'));
  $('ctl-volup').addEventListener('click', () => controlar('volUp'));
  $('ctl-skip').addEventListener('click', () => {
    const a = lastState && lastState.atual;
    if (a && podePular(CONFIG.SKIP_POLICY)) enviar({ t: C2E.SKIP, itemId: a.itemId });
  });
}

// ---------- Busca ----------
function buscar() {
  clearTimeout(debounceTimer);
  const q = $('search-input').value.trim();
  if (!q) return;
  const id = `${meuPid.slice(0, 6)}-${Date.now().toString(36)}-${++buscaSeq}`;
  ultimaBuscaId = id;
  buscaEstado = 'carregando';
  resultados = [];
  renderResultados();
  const ok = enviar({ t: C2E.SEARCH, id, q, karaoke: $('karaoke-check').checked });
  if (!ok) { buscaEstado = 'erro'; buscaMsg = 'Sem conexão com o KTV.'; renderResultados(); }
}

function adicionar(videoId, btn) {
  if (!enviar({ t: C2E.ADD, videoId })) return;
  pendentes.add(videoId);
  marcarAguardando();
  if (btn) { btn.disabled = true; btn.textContent = 'Enviando…'; }
}

function marcarAguardando() {
  aguardandoAdd++;
  clearTimeout(addTimer);
  addTimer = setTimeout(() => { aguardandoAdd = 0; pendentes.clear(); renderResultados(); }, 8000);
}

function renderResultados() {
  const msg = $('search-status');
  const lista = $('results-list');
  lista.replaceChildren();

  const textos = {
    carregando: 'Buscando…',
    vazio: 'Nada encontrado. Tente outras palavras ou cole o link.',
    erro: buscaMsg,
  };
  msg.hidden = !textos[buscaEstado];
  msg.textContent = textos[buscaEstado] || '';

  if (buscaEstado !== 'ok') return;
  const emUso = idsNoEstado(lastState);
  for (const r of resultados) {
    const li = el('li', 'item');
    li.setAttribute('data-testid', 'result-item');
    li.append(thumb(r.videoId));
    const info = el('div', 'info');
    info.append(el('span', 'title', r.titulo || 'Sem título'));
    info.append(el('span', 'meta', [r.canal, r.duracao].filter(Boolean).join(' · ')));
    li.append(info);
    const naFila = emUso.has(r.videoId);
    const enviado = pendentes.has(r.videoId);
    const b = el('button', 'btn btn-small' + (naFila || enviado ? '' : ' btn-primary'),
      enviado ? 'Enviando…' : naFila ? 'Adicionar de novo' : 'Adicionar');
    b.type = 'button';
    b.setAttribute('data-testid', 'add-btn');
    b.disabled = enviado;
    if (!b.disabled) b.addEventListener('click', () => adicionar(r.videoId, b));
    li.append(b);
    lista.append(li);
  }
}

// ---------- Abas ----------
const ABAS = ['fila', 'buscar', 'link', 'controle'];
function mostrarAba(nomeAba) {
  for (const a of ABAS) {
    $('panel-' + a).hidden = a !== nomeAba;
    $('tab-' + a).setAttribute('aria-selected', String(a === nomeAba));
  }
  if (nomeAba === 'buscar' && !('ontouchstart' in window)) $('search-input').focus();
}

// ---------- Nome ----------
function mostrarNome(sim) {
  $('name-form').hidden = !sim;
  if (sim) {
    $('name-input').value = nome;
    setTimeout(() => $('name-input').focus(), 0);
  }
  $('rename-btn').hidden = sim || !nome;
}

function salvarNome(e) {
  e.preventDefault();
  const v = $('name-input').value.trim().slice(0, 30);
  if (!v) { $('name-input').focus(); return; }
  nome = v;
  store.set('ktv.nome', nome);
  mostrarNome(false);
  enviarHello();
}

// ---------- Inicialização ----------
function iniciar() {
  window.__ktv = Object.freeze({
    getState: () => (lastState ? JSON.parse(JSON.stringify(lastState)) : null),
    getConnStatus: () => connStatus,
  });

  // Novo QR lido com o site já aberto na mesma aba: o navegador só troca o hash (sem recarregar).
  // Recarrega para entrar na sala nova em vez de continuar na antiga.
  window.addEventListener('hashchange', () => {
    if (parseHash(location.hash).sala !== sala) location.reload();
  });

  if (!sala) {
    $('no-room').hidden = false;
    return;
  }
  $('app').hidden = false;

  const k = store.get('ktv.karaoke');
  if (k === '0') $('karaoke-check').checked = false;
  $('karaoke-check').addEventListener('change', (e) => store.set('ktv.karaoke', e.target.checked ? '1' : '0'));

  for (const a of ABAS) $('tab-' + a).addEventListener('click', () => mostrarAba(a));
  $('name-form').addEventListener('submit', salvarNome);
  $('rename-btn').addEventListener('click', () => mostrarNome(true));
  $('reconnect-btn').addEventListener('click', reconectarManual);

  $('search-form').addEventListener('submit', (e) => { e.preventDefault(); buscar(); });
  $('search-input').addEventListener('input', () => {
    clearTimeout(debounceTimer);
    if ($('search-input').value.trim().length >= 3) debounceTimer = setTimeout(buscar, 700);
  });

  $('link-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const url = $('link-input').value.trim();
    if (!url) return;
    if (enviar({ t: C2E.ADD, url })) {
      $('link-input').value = '';
      marcarAguardando();
      toastOk('Enviando…');
    }
  });

  $('link-clipboard').addEventListener('click', async () => {
    let texto = '';
    try {
      texto = await navigator.clipboard.readText();
    } catch {
      toastErro('Não consegui ler a área de transferência. Cole o link no campo acima.');
      return;
    }
    const url = linkDaAreaDeTransferencia(texto);
    if (!url) {
      toastErro('A área de transferência está vazia. Copie o link de um vídeo do YouTube.');
      return;
    }
    if (enviar({ t: C2E.ADD, url })) {
      marcarAguardando();
      toastOk('Enviando…');
    }
  });

  // Ao voltar para a aba/tela (celular bloqueado), checa se a conexão ainda vive.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && connStatus === 'conectado' && !(conn && conn.open)) {
      falhou('desconectado', 'A conexão com o KTV caiu.');
    }
  });

  // Fechar/sair da página: encerra a conexão de forma limpa para o KTV não manter um "celular fantasma"
  // (sem isso o canal de dados só é dado como morto depois de muito tempo).
  window.addEventListener('pagehide', () => {
    clearTimeout(retryTimer); retryTimer = null; clearInterval(tickTimer);
    limparConexao();
  });
  // Voltou do cache de navegação (bfcache, comum no iOS): reconecta.
  window.addEventListener('pageshow', (e) => { if (e.persisted) reconectarManual(); });

  ligarControle();
  mostrarNome(!nome);
  renderFila();
  renderControle();
  renderResultados();
  renderStatus();
  conectar();
}

iniciar();
