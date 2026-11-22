// Offscreen document: hospeda o PeerJS (service worker MV3 não tem WebRTC).
// Só liga chrome.runtime à lógica de peer-room.js.
import { TARGET } from '../shared/protocol.js';
import { createPeerRoom } from './peer-room.js';

if (typeof window.Peer !== 'function') {
  console.error('[KTV offscreen] PeerJS não carregou (vendor/peerjs.min.js).');
}

const room = createPeerRoom({
  PeerCtor: window.Peer,
  send: (m) => {
    // O SW pode estar dormindo/ausente; ignora "Receiving end does not exist".
    chrome.runtime.sendMessage(m).catch(() => {});
  },
  log: (...a) => console.debug('[KTV offscreen]', ...a),
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== TARGET.OFFSCREEN) return false;
  const handled = room.handle(msg);
  // Confirma o recebimento: se o offscreen ainda não carregou, o SW recebe erro e pode tentar de novo.
  sendResponse({ ok: handled });
  return false;
});
