// Service worker (MV3, type: module): fonte da verdade da fila.
// Só liga chrome.* ao núcleo de handlers.js; o estado fica em chrome.storage.local
// (o SW pode ser suspenso a qualquer momento, então nada depende de variáveis globais).
import { criarNucleo, KEY_SIGNALING } from './handlers.js';
import { buscar } from './search.js';
import { oembed } from './meta.js';

const OFFSCREEN_URL = 'src/offscreen/offscreen.html';

const storage = {
  get: async (chave) => (await chrome.storage.local.get(chave))[chave],
  set: (chave, valor) => chrome.storage.local.set({ [chave]: valor }),
};

let criandoOffscreen = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return false;
  console.debug('[KTV sw] criando offscreen document');
  criandoOffscreen ??= chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['WEB_RTC'],
    justification: 'Manter as conexões WebRTC (PeerJS) com os celulares da sala de karaokê.',
  }).finally(() => { criandoOffscreen = null; });
  await criandoOffscreen;
  return true;
}

const janelas = {
  // Sempre uma aba nova (na janela de quem clicou), em primeiro plano.
  async criar(url) {
    const t = await chrome.tabs.create({ url, active: true });
    return { windowId: t.windowId ?? null, tabId: t.id ?? null };
  },
  // Foca a janela/aba KTV existente; false se ela não existe mais.
  async focar(tabId, windowId) {
    try {
      const aba = await chrome.tabs.get(tabId);
      await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(aba.windowId ?? windowId, { focused: true });
      return true;
    } catch {
      return false;
    }
  },
  // Recarrega a aba (reinjeta o content script); false se ela não existe mais.
  async recarregar(tabId) {
    try {
      await chrome.tabs.reload(tabId);
      return true;
    } catch {
      return false;
    }
  },
};

const nucleo = criarNucleo({
  storage,
  send: (msg) => chrome.runtime.sendMessage(msg),
  sendToTab: (tabId, msg) => chrome.tabs.sendMessage(tabId, msg),
  ensureOffscreen,
  janelas,
  buscar,
  oembed: (id) => oembed(id),
  log: (...a) => console.debug('[KTV sw]', ...a),
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'sw') return false;
  nucleo.handleMessage(msg, sender).then(
    (resp) => sendResponse(resp),
    (e) => { console.error('[KTV sw]', e); sendResponse(undefined); },
  );
  return true; // resposta assíncrona (whoami)
});

chrome.action.onClicked.addListener(() => { nucleo.abrirKtv().catch((e) => console.error('[KTV sw]', e)); });
chrome.tabs.onRemoved.addListener((tabId) => { nucleo.abaFechada(tabId).catch(() => {}); });
chrome.windows.onRemoved.addListener((windowId) => { nucleo.janelaFechada(windowId).catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { nucleo.navegadorIniciou().catch((e) => console.error('[KTV sw]', e)); });
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'update') nucleo.extensaoAtualizada().catch((e) => console.error('[KTV sw]', e));
});

// Override da sinalização alterado em runtime (testes/servidor próprio): reenvia initPeer.
chrome.storage.onChanged.addListener((mudancas, area) => {
  if (area === 'local' && mudancas[KEY_SIGNALING]) nucleo.init().catch((e) => console.error('[KTV sw]', e));
});

// Roda a cada início do SW (instalação, browser aberto, acordar por mensagem): garante o offscreen.
nucleo.init().catch((e) => console.error('[KTV sw] init falhou', e));
