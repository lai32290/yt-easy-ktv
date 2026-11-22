// Contrato único de mensagens e configuração do KTV.
// ES module. Cópia idêntica em web/protocol.js (conferida por teste).

export const CONFIG = {
  // Servidor de sinalização do PeerJS. Para migrar para um próprio, mude só aqui.
  SIGNALING: { host: '0.peerjs.com', port: 443, path: '/', secure: true },
  // URL do site do celular (GitHub Pages). A sala vai no hash: SITE_URL + '#sala=ID'.
  SITE_URL: 'https://lai32290.github.io/yt-easy-ktv/',
  // Quem pode pular a música atual: 'todos' | 'anfitriao' (anfitrião = fase opcional).
  SKIP_POLICY: 'todos',
  KARAOKE_SUFFIX: ' karaokê',
  MAX_RESULTS: 12,
  VIDEO_ID_RE: /^[\w-]{11}$/,
  // Parâmetro que marca a aba do player na URL aberta pelo service worker.
  KTV_FLAG: 'ktv',
};

// ---- Celular -> extensão (DataChannel do PeerJS) ----
export const C2E = {
  HELLO: 'hello',   // { nome, pid }   pid = id estável do participante (localStorage)
  SEARCH: 'search', // { id, q, karaoke? }  karaoke=false desliga o sufixo
  ADD: 'add',       // { videoId } | { url }
  REMOVE: 'remove', // { itemId }
  SKIP: 'skip',     // { itemId? }  itemId = música que o celular quer pular (pulo repetido/atrasado é ignorado)
  MOVE: 'move',     // { itemId, toIndex }  (opcional)
  CONTROL: 'control', // { acao }  acao ∈ ACOES_CONTROLE (controle do player da música atual)
};

// Ações da aba "Controle" do celular (C2E.CONTROL). "Próxima" usa C2E.SKIP.
export const ACOES_CONTROLE = ['play', 'pause', 'restart', 'back', 'forward', 'mute', 'unmute', 'volDown', 'volUp'];
export const CONTROLE_SALTO_S = 10;   // segundos de back/forward
export const CONTROLE_VOLUME_PASSO = 10; // pontos percentuais de volDown/volUp

// ---- Extensão -> celular ----
export const E2C = {
  STATE: 'state',     // { atual: Item|null, fila: Item[], tocando: boolean, player: { pausado, mudo, volume 0-100 } }
  RESULTS: 'results', // { id, itens: [{videoId,titulo,canal,duracao}] }
  ERROR: 'error',     // { id?, codigo, msg }
};

// ---- Mensagens internas (chrome.runtime / chrome.tabs) ----
// Todas levam { t, target } onde target ∈ 'sw' | 'offscreen' | 'content'.
//
// offscreen -> sw   (target:'sw')
//   room      { roomId }                      Peer aberto; roomId é o ID da sala
//   peerMsg   { connId, pid?, msg }           msg = mensagem do celular (C2E)
//   conns     { count, signaling: bool }      nº de celulares conectados / sinalização ok
//   peerClose { connId }
// sw -> offscreen   (target:'offscreen')
//   initPeer  { roomId?, signaling }          criar Peer (reusar roomId salvo, se houver)
//   send      { connId, msg }                 mensagem a uma conexão (E2C)
//   broadcast { msg }                         mensagem a todas as conexões (E2C)
// content -> sw     (target:'sw')
//   whoami    {}                -> resposta { ktv: boolean, state, roomId, siteUrl, conns }
//   started   {}                              usuário clicou "Iniciar" (autoplay liberado)
//   ended     { videoId }                     vídeo terminou (o SW ignora se não for o `atual`)
//   playerError { codigo, videoId }           vídeo indisponível/restrito/timeout
//   playerStatus { pausado, mudo, volume }    estado do <video> (mudou); vira `player` no state
// sw -> content     (target:'content', via chrome.tabs.sendMessage)
//   play      { videoId }
//   control   { acao }                        comando do player (ACOES_CONTROLE)
//   idle      {}                              fila acabou; parar/mostrar QR grande
//   panel     { state, roomId, siteUrl, conns, signaling }   dados do painel (QR/fila)
export const INT = {
  ROOM: 'room', PEER_MSG: 'peerMsg', CONNS: 'conns', PEER_CLOSE: 'peerClose',
  INIT_PEER: 'initPeer', SEND: 'send', BROADCAST: 'broadcast',
  WHOAMI: 'whoami', STARTED: 'started', ENDED: 'ended', PLAYER_ERROR: 'playerError',
  PLAYER_STATUS: 'playerStatus', CONTROL: 'control',
  PLAY: 'play', IDLE: 'idle', PANEL: 'panel',
};
export const TARGET = { SW: 'sw', OFFSCREEN: 'offscreen', CONTENT: 'content' };

// ---- Códigos de erro (campo `codigo` de E2C.ERROR) ----
export const ERR = {
  BUSCA_FALHOU: 'busca_falhou',
  LINK_INVALIDO: 'link_invalido',
  VIDEO_INDISPONIVEL: 'video_indisponivel',
  DUPLICADO: 'duplicado',
  SEM_PERMISSAO: 'sem_permissao',
  NAO_ENCONTRADO: 'nao_encontrado',
  MSG_INVALIDA: 'msg_invalida',
};

// Textos em pt-BR por código (o celular usa estes se `msg` vier vazio).
export const ERR_TEXT = {
  [ERR.BUSCA_FALHOU]: 'A busca falhou. Tente colar o link do YouTube.',
  [ERR.LINK_INVALIDO]: 'Link inválido. Cole um link de vídeo do YouTube.',
  [ERR.VIDEO_INDISPONIVEL]: 'Esse vídeo não está disponível e foi pulado.',
  [ERR.DUPLICADO]: 'Essa música já está na fila.',
  [ERR.SEM_PERMISSAO]: 'Você não pode fazer isso.',
  [ERR.NAO_ENCONTRADO]: 'Item não encontrado.',
  [ERR.MSG_INVALIDA]: 'Mensagem inválida.',
};

/**
 * Item da fila:
 * { itemId, videoId, titulo, canal, duracao, pedidoPor, pid, addedAt }
 *   pid = id estável do participante que pediu (para "remover o próprio item")
 */
export const thumbUrl = (videoId) => `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
export const roomUrl = (siteUrl, roomId) => `${siteUrl}#sala=${roomId}`;
