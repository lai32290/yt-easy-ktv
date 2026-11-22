// Extrai o videoId de links do YouTube (ou de um ID puro de 11 caracteres).
import { CONFIG } from '../shared/protocol.js';

const valido = (id) => (typeof id === 'string' && CONFIG.VIDEO_ID_RE.test(id) ? id : null);

const HOSTS_YT = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
  'youtube-nocookie.com', 'www.youtube-nocookie.com',
]);

export function parseUrl(texto) {
  if (typeof texto !== 'string') return null;
  const t = texto.trim();
  if (!t) return null;
  if (valido(t)) return t;

  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase();
  const partes = u.pathname.split('/').filter(Boolean);

  if (host === 'youtu.be' || host === 'www.youtu.be') return valido(partes[0]);
  if (!HOSTS_YT.has(host)) return null;
  if (partes[0] === 'watch') return valido(u.searchParams.get('v'));
  if (['shorts', 'embed', 'live', 'v'].includes(partes[0])) return valido(partes[1]);
  return null;
}
