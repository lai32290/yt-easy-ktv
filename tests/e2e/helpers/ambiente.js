// Ambiente e2e: Chromium real com a extensão carregada + sinalização PeerJS local +
// YouTube falso + site do celular servido localmente + "celulares" (contextos isolados).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from './playwright.js';
import { criarSinalizacao, criarSiteEstatico, EXT_DIR } from './servers.js';
import { instalarYoutubeFalso } from './fake-youtube.js';

process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS ??= '1'; // context.route também vê o fetch do SW

export const espera = (ms) => new Promise((r) => setTimeout(r, ms));

/** Repete `fn` até devolver algo verdadeiro (ou lançar o último erro no timeout). */
export async function ate(fn, { timeout = 15000, intervalo = 100, descricao = 'condição' } = {}) {
  const fim = Date.now() + timeout;
  let ultimo;
  for (;;) {
    try {
      const r = await fn();
      if (r) return r;
      ultimo = undefined;
    } catch (e) { ultimo = e; }
    if (Date.now() > fim) throw new Error(`timeout (${timeout}ms) esperando: ${descricao}${ultimo ? ` (${ultimo.message})` : ''}`);
    await espera(intervalo);
  }
}

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==', 'base64');
const ARGS_COMUNS = [
  '--no-sandbox', '--mute-audio',
  '--disable-features=WebRtcHideLocalIpsWithMdns', // candidatos ICE em IP (sem mDNS) para o loopback
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
];

/** Um "celular": contexto isolado (localStorage próprio => pid próprio) com o site da sala aberto. */
export class Celular {
  constructor(amb, nome, context) {
    this.amb = amb; this.nome = nome; this.context = context; this.page = null;
    this.erros = []; // erros de página (pageerror) e mensagens console.error
  }

  async abrir({ sala = this.amb.roomId, entrar = true } = {}) {
    if (this.page && !this.page.isClosed()) await this.page.close();
    const page = await this.context.newPage();
    page.on('pageerror', (e) => this.erros.push(String(e)));
    this.page = page;
    await page.goto(this.amb.urlCelular(sala));
    if (entrar) await this.entrar();
    return this;
  }

  /** Preenche o nome se o site pedir e espera o status "Conectado". */
  async entrar({ timeout = 30000 } = {}) {
    const p = this.page;
    const form = p.locator('#name-form');
    if (await form.isVisible().catch(() => false)) {
      await p.getByTestId('name-input').fill(this.nome);
      await p.getByTestId('name-submit').click();
    }
    await this.esperarStatus('conectado', timeout);
    return this;
  }

  status() { return this.page.getByTestId('status').getAttribute('data-state'); }
  async esperarStatus(estado, timeout = 30000) {
    await ate(async () => (await this.status()) === estado, { timeout, descricao: `celular ${this.nome} status=${estado}` });
  }
  estado() { return this.page.evaluate(() => window.__ktv.getState()); }
  async esperarEstado(pred, { timeout = 20000, descricao = 'estado do celular' } = {}) {
    let ult = null;
    await ate(async () => { ult = await this.estado(); return ult && pred(ult); }, { timeout, descricao });
    return ult;
  }
  /** Títulos na fila (sem a música atual). */
  async titulosFila() { return (await this.estado())?.fila.map((i) => i.titulo) ?? []; }

  async aba(nome) { await this.page.getByTestId(`tab-${nome}`).click(); }

  async buscar(q) {
    await this.aba('buscar');
    await this.page.getByTestId('search-input').fill(q);
    await this.page.getByTestId('search-btn').click();
    await this.page.getByTestId('result-item').first().waitFor({ timeout: 15000 });
    return this.page.getByTestId('result-item').count();
  }
  async adicionarResultado(i = 0) {
    await this.page.getByTestId('result-item').nth(i).getByTestId('add-btn').click();
  }
  async colarLink(url) {
    await this.aba('link');
    await this.page.getByTestId('link-input').fill(url);
    await this.page.getByTestId('link-add').click();
  }
  /** Espera o toast de erro (e, se `esperado` for passado, com exatamente esse texto) e devolve o texto. */
  async toastErro(esperado, timeout = 8000) {
    const t = this.page.getByTestId('error-toast');
    let texto = '';
    await ate(async () => {
      if (!(await t.isVisible())) return false;
      texto = ((await t.textContent()) || '').trim();
      return esperado === undefined || (esperado instanceof RegExp ? esperado.test(texto) : texto === esperado);
    }, { timeout, descricao: `toast de erro ${esperado ?? ''}` });
    return texto;
  }
  async pular() { await this.aba('fila'); await this.page.getByTestId('skip-btn').click(); }
  itensFila() { return this.page.getByTestId('queue-item'); }
  /**
   * Cliente PeerJS "cru" dentro da página do celular: manda/recebe mensagens JSON sem passar pela UI
   * (para testar permissões, mensagens inválidas e o contrato de `t`).
   */
  async abrirCru({ pid = `cru-${this.nome}`, nome = this.nome, hello = true, sala = this.amb.roomId } = {}) {
    const { sinal } = this.amb;
    await this.page.evaluate(({ sala, cfg, pid, nome, hello }) => new Promise((resolve, reject) => {
      const raw = (window.__cru = { msgs: [], conn: null, peer: null });
      const peer = new window.Peer(undefined, cfg);
      raw.peer = peer;
      peer.on('error', (e) => reject(new Error('peer cru: ' + (e && e.type))));
      peer.on('open', () => {
        const conn = peer.connect(sala, { reliable: true });
        raw.conn = conn;
        conn.on('data', (d) => raw.msgs.push(d));
        conn.on('open', () => { if (hello) conn.send({ t: 'hello', nome, pid }); resolve(); });
      });
    }), { sala, cfg: { host: sinal.host, port: sinal.port, path: '/', secure: false }, pid, nome, hello });
    const page = this.page;
    return {
      enviar: (msg) => page.evaluate((m) => window.__cru.conn.send(m), msg),
      mensagens: () => page.evaluate(() => window.__cru.msgs.slice()),
      limpar: () => page.evaluate(() => { window.__cru.msgs.length = 0; }),
      esperar: (pred, descricao = 'mensagem do KTV') => ate(async () => (await page.evaluate(() => window.__cru.msgs.slice())).find(pred), { descricao }),
      fechar: () => page.evaluate(() => { try { window.__cru.conn.close(); window.__cru.peer.destroy(); } catch { /* ignora */ } }),
    };
  }
  async fechar() { await this.context.close().catch(() => {}); }
}

export async function criarAmbiente({ nomeTeste = 'e2e' } = {}) {
  const sinal = await criarSinalizacao();
  const site = await criarSiteEstatico();
  const perfil = fs.mkdtempSync(path.join(process.env.KTV_E2E_TMP || os.tmpdir(), `ktv-${nomeTeste}-`));

  const ctx = await chromium.launchPersistentContext(perfil, {
    headless: false, // com --headless=new: extensões só carregam em contexto persistente e fora do headless antigo
    args: [
      '--headless=new', `--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`,
      '--host-resolver-rules=MAP 0.peerjs.com ~NOTFOUND', // nunca toca o servidor público (sinalização é a local)
      ...ARGS_COMUNS,
    ],
  });
  const celBrowser = await chromium.launch({ args: ARGS_COMUNS });
  const yt = await instalarYoutubeFalso(ctx);

  const amb = {
    sinal, site, ctx, yt, celBrowser, perfil, ktv: null, celulares: [], roomId: null,
    logsKtv: [], errosKtv: [],

    /**
     * Service worker da extensão (o mais recente). Atenção: o Playwright reaproveita o mesmo objeto
     * quando o SW é parado e acordado de novo, e um evaluate num SW parado fica pendurado até que
     * algum evento o acorde (mensagem do celular, da aba KTV, etc.).
     */
    async sw({ timeout = 20000 } = {}) {
      return ate(() => ctx.serviceWorkers().filter((w) => w.url().startsWith('chrome-extension://')).at(-1),
        { timeout, descricao: 'service worker da extensão' });
    },
    async storage() {
      return ate(async () => {
        const sw = await amb.sw();
        return sw.evaluate(() => chrome.storage.local.get(null));
      }, { timeout: 20000, descricao: 'ler chrome.storage do SW' });
    },
    async extId() { return new URL((await amb.sw()).url()).host; },

    /** Define o override de sinalização (o SW reenvia initPeer ao mudar a chave). */
    async apontarSinalizacao(cfg = sinal.config) {
      const sw = await amb.sw();
      await sw.evaluate((c) => chrome.storage.local.set({ ktv_signaling: c }), cfg);
    },
    /** Espera a sala existir e a sinalização estar ok; devolve o roomId. */
    async esperarSala({ timeout = 30000 } = {}) {
      const st = await ate(async () => {
        const s = await amb.storage();
        return s.ktv_state?.roomId && s.ktv_rt?.conns?.signaling === true ? s : null;
      }, { timeout, descricao: 'roomId + sinalização ok no storage' });
      amb.roomId = st.ktv_state.roomId;
      return amb.roomId;
    },
    urlCelular(sala = amb.roomId) {
      return `${site.url}#sala=${sala}&sig=127.0.0.1:${sinal.port}&secure=0`;
    },

    /** Dispara o mesmo caminho do clique no ícone (chrome.action.onClicked) e devolve a aba KTV. */
    async abrirKtv() {
      const sw = await amb.sw();
      const antes = new Set(ctx.pages());
      const novaP = ctx.waitForEvent('page', { timeout: 15000 });
      await sw.evaluate(() => { chrome.action.onClicked.dispatch({ id: 0 }); });
      let page = await novaP;
      if (antes.has(page)) page = ctx.pages().find((p) => !antes.has(p));
      amb.ktv = page;
      page.on('console', (m) => { amb.logsKtv.push(`[${m.type()}] ${m.text()}`); });
      page.on('pageerror', (e) => amb.errosKtv.push(String(e)));
      await page.waitForLoadState('domcontentloaded');
      return page;
    },
    /** Clica em "Iniciar" (gesto real do usuário, libera autoplay). */
    async iniciar() {
      const btn = amb.ktv.locator('#ktv-root .btn-iniciar');
      await btn.waitFor({ state: 'visible', timeout: 20000 });
      await btn.click();
      await ate(async () => (await amb.storage()).ktv_rt?.started === true, { descricao: 'SW marcar started' });
    },
    /** Sobe tudo até o KTV pronto (extensão -> sinalização local -> sala -> janela KTV -> Iniciar). */
    async prepararKtv({ iniciar = true } = {}) {
      await amb.apontarSinalizacao();
      await amb.esperarSala();
      await amb.abrirKtv();
      if (iniciar) await amb.iniciar();
      return amb.ktv;
    },

    async novoCelular(nome, { abrir = true } = {}) {
      const c = await celBrowser.newContext({ viewport: { width: 390, height: 800 } });
      // guarda os RTCPeerConnection para os testes poderem derrubar a conexão P2P do "celular"
      await c.addInitScript(() => {
        const Orig = window.RTCPeerConnection;
        window.__pcs = [];
        window.RTCPeerConnection = function RTCPeerConnection(...a) { const pc = new Orig(...a); window.__pcs.push(pc); return pc; };
        window.RTCPeerConnection.prototype = Orig.prototype;
      });
      await c.route('https://i.ytimg.com/**', (r) => r.fulfill({ contentType: 'image/png', body: PNG_1X1 }));
      const cel = new Celular(amb, nome, c);
      amb.celulares.push(cel);
      if (abrir) await cel.abrir();
      return cel;
    },

    /** Estado da aba KTV: vídeo atual da página falsa e do <video>. */
    async paginaKtv() {
      return amb.ktv.evaluate(() => {
        const v = document.querySelector('video.html5-main-video');
        const f = window.__fake || null;
        return {
          url: location.href,
          videoId: new URL(location.href).searchParams.get('v'),
          pausado: v ? v.paused : null, terminou: v ? v.ended : null, tempo: v ? v.currentTime : null,
          fake: f && { carregados: [...f.carregados], playing: [...f.playing], ended: [...f.ended], recTocou: f.recTocou, cliquesToggle: f.cliquesToggle },
        };
      }).catch(() => null);
    },
    /** Texto/visibilidade do painel do KTV (shadow DOM). */
    painel() {
      return amb.ktv.evaluate(() => {
        const sr = document.querySelector('#ktv-root')?.shadowRoot;
        if (!sr) return null;
        const vis = (s) => { const e = sr.querySelector(s); return !!e && !e.hidden && e.getClientRects().length > 0; };
        return {
          ocioso: vis('.ocioso'), tocando: vis('.tocando'), iniciar: vis('.iniciar'),
          url: sr.querySelector('.ocioso .url')?.textContent || '',
          conns: sr.querySelector('.tocando .conns')?.textContent || '',
          fila: [...sr.querySelectorAll('.fila li')].map((li) => li.textContent),
          qrGrande: sr.querySelector('.qr-grande svg')?.outerHTML || '',
          qrPequeno: sr.querySelector('.qr-pequeno svg')?.outerHTML || '',
        };
      }).catch(() => null);
    },

    /** Espera o SW (storage) refletir uma condição sobre o estado da fila. */
    async esperarFila(pred, { timeout = 20000, descricao = 'fila no storage' } = {}) {
      let ult;
      await ate(async () => { ult = (await amb.storage()).ktv_state; return ult && pred(ult); }, { timeout, descricao });
      return ult;
    },

    /**
     * Para o service worker (CDP ServiceWorker.stopAllWorkers), como o Chrome faz ao suspender.
     * Ele só volta quando um evento o acordar. Marca a global `__vivo` para provar o reinício depois.
     */
    async pararSw() {
      const sw = await amb.sw();
      await sw.evaluate(() => { globalThis.__vivo = true; });
      const pagina = amb.ktv && !amb.ktv.isClosed() ? amb.ktv : ctx.pages()[0];
      const cdp = await ctx.newCDPSession(pagina);
      await cdp.send('ServiceWorker.enable');
      await cdp.send('ServiceWorker.stopAllWorkers');
      await cdp.detach().catch(() => {});
    },
    /** true se o SW foi mesmo reiniciado desde pararSw() (a global marcada sumiu). Só chamar com o SW já acordado. */
    async swReiniciou() {
      const sw = await amb.sw();
      return sw.evaluate(() => globalThis.__vivo === undefined);
    },
    /** Recarrega a extensão (chrome.runtime.reload): o SW novo nasce sozinho. */
    async recarregarExtensao() {
      const antigo = await amb.sw();
      await antigo.evaluate(() => { setTimeout(() => chrome.runtime.reload(), 50); }).catch(() => {});
      await ate(() => { const w = ctx.serviceWorkers().filter((x) => x.url().startsWith('chrome-extension://')).at(-1); return w && w !== antigo; },
        { timeout: 30000, descricao: 'SW novo após chrome.runtime.reload' });
    },

    async fechar() {
      for (const c of amb.celulares) await c.fechar();
      await celBrowser.close().catch(() => {});
      await ctx.close().catch(() => {});
      await sinal.parar();
      await site.fechar();
      fs.rmSync(perfil, { recursive: true, force: true });
    },
  };
  return amb;
}

/** Roda `fn(amb)` com ambiente novo e sempre fecha tudo. */
export async function comAmbiente(nomeTeste, fn) {
  const amb = await criarAmbiente({ nomeTeste });
  try {
    await fn(amb);
  } catch (e) {
    e.message += `\n--- console da aba KTV (últimos) ---\n${amb.logsKtv.slice(-25).join('\n')}\n--- erros KTV ---\n${amb.errosKtv.join('\n')}`;
    throw e;
  } finally {
    await amb.fechar();
  }
}
