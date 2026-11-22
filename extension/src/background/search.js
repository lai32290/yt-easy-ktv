// Busca sem API oficial: GET /results e leitura do `ytInitialData` embutido no HTML.
// Módulo isolado: se o YouTube mudar o formato, só este arquivo precisa mudar
// (use tests/smoke-search.mjs para detectar quebra).
import { CONFIG } from '../shared/protocol.js';

function erro(msg, codigo) {
  return Object.assign(new Error(msg), { codigo });
}

// Extrai o objeto JSON que começa em `inicio` ('{'), contando chaves e respeitando strings.
export function extrairJsonBalanceado(texto, inicio) {
  let prof = 0;
  let emString = false;
  let escape = false;
  for (let i = inicio; i < texto.length; i++) {
    const c = texto[i];
    if (emString) {
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') emString = false;
      continue;
    }
    if (c === '"') emString = true;
    else if (c === '{') prof++;
    else if (c === '}' && --prof === 0) return texto.slice(inicio, i + 1);
  }
  return null;
}

// Acha `ytInitialData = {...}` no HTML e devolve o objeto (ou null).
export function extrairInitialData(html) {
  const re = /(?:window\[\s*['"]ytInitialData['"]\s*\]|ytInitialData)\s*=\s*\{/g;
  let m;
  while ((m = re.exec(html))) {
    const inicio = m.index + m[0].length - 1;
    const json = extrairJsonBalanceado(html, inicio);
    if (!json) continue;
    try {
      return JSON.parse(json);
    } catch { /* tenta a próxima ocorrência */ }
  }
  return null;
}

const texto = (x) => {
  if (!x) return '';
  if (typeof x.simpleText === 'string') return x.simpleText;
  if (Array.isArray(x.runs)) return x.runs.map((r) => r.text || '').join('');
  return '';
};

// Chaves cujo conteúdo não deve ser percorrido: anúncios e prateleiras de Shorts.
const IGNORAR = /^(ad[A-Z]|promoted|reelShelf|gridShelfViewModel|shortsLockup|reelItem)/;

function ehShortOuAoVivo(v) {
  const url = v.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url || '';
  if (url.startsWith('/shorts/')) return true;
  const sinais = JSON.stringify([v.thumbnailOverlays || [], v.badges || []]);
  return /"style":"(SHORTS|LIVE)"|BADGE_STYLE_TYPE_LIVE_NOW/.test(sinais);
}

function mapear(v) {
  const videoId = v.videoId;
  if (typeof videoId !== 'string' || !CONFIG.VIDEO_ID_RE.test(videoId)) return null;
  const titulo = texto(v.title);
  if (!titulo || ehShortOuAoVivo(v)) return null;
  return {
    videoId,
    titulo,
    canal: texto(v.ownerText) || texto(v.longBylineText) || texto(v.shortBylineText),
    duracao: texto(v.lengthText),
  };
}

// O YouTube alterna (A/B por requisição) entre `videoRenderer` e `lockupViewModel` para o mesmo vídeo.
const RE_DURACAO = /^\d{1,2}(:\d{2}){1,2}$/;

function mapearLockup(l) {
  if (l.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO') return null; // playlists, mixes, canais...
  const videoId = l.contentId;
  if (typeof videoId !== 'string' || !CONFIG.VIDEO_ID_RE.test(videoId)) return null;
  const meta = l.metadata?.lockupMetadataViewModel;
  const titulo = meta?.title?.content;
  if (!titulo) return null;
  const parte = meta.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0];
  const canal = parte?.avatarStack?.avatarStackViewModel?.text?.content || parte?.text?.content || '';
  const sobreposicoes = JSON.stringify(l.contentImage?.thumbnailViewModel?.overlays || []);
  if (/"badgeStyle":"[A-Z_]*LIVE|"imageName":"LIVE/.test(sobreposicoes)) return null;
  let duracao = '';
  for (const o of l.contentImage?.thumbnailViewModel?.overlays || []) {
    for (const b of o.thumbnailBottomOverlayViewModel?.badges || []) {
      const t = b.thumbnailBadgeViewModel?.text;
      if (typeof t === 'string' && RE_DURACAO.test(t)) duracao = t;
    }
  }
  return { videoId, titulo, canal, duracao };
}

// Função pura: HTML da página de resultados -> lista de { videoId, titulo, canal, duracao }.
// Lança `busca_falhou` se o HTML não tiver ytInitialData (formato mudou / página de consentimento).
export function parseResultsHtml(html, max = CONFIG.MAX_RESULTS) {
  const dados = typeof html === 'string' ? extrairInitialData(html) : null;
  if (!dados) throw erro('ytInitialData não encontrado', 'busca_falhou');
  const itens = [];
  const vistos = new Set();
  const adicionar = (item) => {
    if (item && !vistos.has(item.videoId)) {
      vistos.add(item.videoId);
      itens.push(item);
    }
  };
  const percorrer = (no) => {
    if (itens.length >= max || !no || typeof no !== 'object') return;
    if (Array.isArray(no)) {
      for (const filho of no) percorrer(filho);
      return;
    }
    for (const [chave, valor] of Object.entries(no)) {
      if (itens.length >= max) return;
      if (IGNORAR.test(chave) || !valor || typeof valor !== 'object') continue;
      if (chave === 'videoRenderer') adicionar(mapear(valor));
      else if (chave === 'lockupViewModel') adicionar(mapearLockup(valor));
      else percorrer(valor);
    }
  };
  percorrer(dados.contents ?? dados);
  return itens;
}

export async function buscar(q, { karaoke = true, fetchImpl = fetch } = {}) {
  const consulta = String(q ?? '').trim();
  if (!consulta) throw erro('consulta vazia', 'busca_falhou');
  const termo = karaoke ? consulta + CONFIG.KARAOKE_SUFFIX : consulta;
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(termo)}&hl=pt-BR`;
  try {
    const opts = { headers: { 'Accept-Language': 'pt-BR,pt;q=0.9' } };
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(10000);
    const resp = await fetchImpl(url, opts);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return parseResultsHtml(await resp.text());
  } catch (e) {
    throw Object.assign(erro(`busca falhou: ${e.message}`, 'busca_falhou'), { causa: e });
  }
}
