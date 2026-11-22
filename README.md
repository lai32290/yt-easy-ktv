# KTV no YouTube

Karaokê no YouTube: o PC toca os vídeos numa janela dedicada e os celulares da sala pedem músicas (busca ou link) por uma página web, sem instalar nada no celular. Tudo conversa por WebRTC (PeerJS), sem servidor próprio.

## Arquitetura (resumo)

1. **Extensão Chrome (MV3)** em `extension/`, sem bundler (ES modules); o usuário final não precisa de Node.
2. **Service worker** (`src/background/`): fila, estado, busca, abre a aba KTV e persiste em `chrome.storage`.
3. **Offscreen document** (`src/offscreen/`): hospeda o PeerJS (WebRTC não roda no service worker) e cria a sala.
4. **Content script** (`src/content/`): roda só na aba KTV do youtube.com; toca o vídeo, detecta o fim e mostra QR/fila num painel (shadow DOM).
5. **Site do celular** em `web/` (HTML/JS estáticos, pt-BR): lê `#sala=ID` do link, conecta ao PC por PeerJS, busca/cola links e mostra a fila.
6. **Contrato único** em `extension/src/shared/protocol.js` (mensagens e `CONFIG`); `web/protocol.js` é uma cópia idêntica (`npm run sync`).

Decisão de build: **sem bundler**. Bibliotecas de terceiros ficam em `vendor/` (versões em `extension/vendor/VERSIONS.md`) e nada é carregado de CDN em runtime.

## Instalação (usuário final)

1. Baixe o arquivo `ktv-extension.zip` (página de Releases) e **extraia** numa pasta que você não vá apagar.
2. No Chrome, abra `chrome://extensions`.
3. Ative o **Modo do desenvolvedor** (canto superior direito).
4. Clique em **Carregar sem compactação** e escolha a pasta extraída (a que contém `manifest.json`).
5. Clique no ícone da extensão **KTV YouTube** na barra do Chrome: abre **uma nova aba** KTV do YouTube (se ela já existir, só a foca). O KTV nunca assume a aba que você está usando.
6. Na janela, clique em **Iniciar** (necessário para o Chrome liberar o som) e **escaneie o QR** com o celular, no mesmo Wi-Fi do PC.
7. No celular, informe seu nome, busque uma música ou cole um link e adicione à fila.

## Publicar o site do celular (GitHub Pages)

1. No repositório do GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. O workflow `.github/workflows/pages.yml` publica a pasta `web/` a cada push na `main` (ou manualmente em **Actions → Publicar site → Run workflow**).
3. A URL final é `https://<usuario>.github.io/<repositorio>/`. Ajuste `CONFIG.SITE_URL` em `extension/src/shared/protocol.js` (com a barra final), rode `npm run sync` para copiar o contrato para `web/protocol.js` e faça commit/push.
4. Gere de novo o zip (`npm run build`) e recarregue a extensão.

## Desenvolvimento e testes

Requer Node 20+ (só em desenvolvimento).

```bash
npm install        # instala o servidor PeerJS local (devDependency "peer") usado nos testes e2e
npm test           # testes unitários (node --test)
npm run test:e2e   # integração com Chromium real (tests/e2e; Playwright instalado globalmente)
npm run sync       # copia extension/src/shared/protocol.js -> web/protocol.js
npm run build      # gera dist/ktv-extension.zip (conteúdo de extension/)
```

### Testes e2e (Chromium real + extensão)

`npm run test:e2e` roda um arquivo por vez (`--test-concurrency=1`), cada teste com ambiente novo (~3 a 10 s; a suíte toda leva alguns minutos). Requisitos: Chromium e `playwright` instalados (o `playwright` é resolvido do módulo global; não rodar `playwright install`).

O que sobe em cada teste (`tests/e2e/helpers/`):

- Chromium (`--headless=new`, contexto persistente) com a extensão `extension/` carregada; o service worker é apontado para a sinalização local pela chave `ktv_signaling` (o SW reenvia `initPeer` quando ela muda). `0.peerjs.com` é bloqueado por DNS para nunca tocar a rede pública.
- Servidor PeerJS local (`peer`, processo filho em `127.0.0.1`, porta livre) que o teste derruba/religa para simular queda.
- **YouTube falso** via `context.route('https://www.youtube.com/**')` (inclui o `fetch` do service worker, com `PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1`): `/?ktv=1` e `/watch?v=ID` com `<ytd-app>`, `<video class="html5-main-video">` e um WAV curto gerado em memória; `/oembed`; `/results` (fixtures de `tests/fixtures/`); vídeos "indisponíveis" por ID (`.ytp-error`); navegação SPA pelo evento `yt-navigate` no `<ytd-app>` (um `<a>` comum recarrega a página, como no YouTube real) ou recarga completa; API de som do `#movie_player` (`getVolume`/`setVolume`/`isMuted`/`mute`/`unMute`, que reaplica o volume dela a cada vídeo); botão `.ytp-fullscreen-button`; e autoplay do "recomendado" ao terminar, para provar que o KTV o contém. Atenção: a primeira carga da janela KTV (`/?ktv=1`, aberta pelo `chrome.tabs.create`) escapa do `context.route` e vem do youtube.com real, então os testes precisam de rede.
- Site do celular (`web/`) servido por um HTTP estático local e aberto em **contextos isolados** de um segundo navegador (cada "celular" tem seu `localStorage`/`pid`) em `#sala=<ID>&sig=127.0.0.1:<porta>&secure=0`.

Cenários (um arquivo por critério de aceite do MVP): `01` janela KTV/QR · `02` celular conecta · `03` busca, links e vídeo repetido · `04` fila com 2 celulares, remover só o dono, pular · `05` próxima música sozinha, autoplay contido, modo ocioso · `06` vídeo indisponível · `07` reinício do service worker e perda do offscreen · `08` reconexão do celular e queda da sinalização · `09` contrato de mensagens · `10` aba Controle do celular · `11` tela cheia entre músicas · `12` 插播 (furar a fila). O que não é automatizável (YouTube real, anúncios, iOS, Wi-Fi real) está em [`docs/TESTE-MANUAL.md`](docs/TESTE-MANUAL.md).

### Sinalização alternativa (testes / servidor próprio)

- **Celular:** acrescente ao link `#sala=ID&sig=host:porta&secure=0` (ex.: `#sala=abc&sig=192.168.0.10:9000&secure=0`).
- **Extensão:** em `chrome.storage.local`, a chave `ktv_signaling` com `{ "host": "...", "port": 9000, "path": "/", "secure": false }`. Ela substitui `CONFIG.SIGNALING` e vale na hora (o service worker reinicia o Peer quando a chave muda) (defina-a no console do service worker: `chrome.storage.local.set({ktv_signaling:{host:'192.168.0.10',port:9000,path:'/',secure:false}})`).
- Para trocar o padrão de vez, edite `CONFIG.SIGNALING` em `protocol.js` e rode `npm run sync`.

## Limitações

- **Wi-Fi com isolamento de clientes** (comum em redes de convidados/públicas) bloqueia a conexão P2P entre celular e PC. Não há servidor TURN neste projeto.
- **Mantenha a janela do player visível** (não minimizada nem totalmente coberta): o Chrome pode reduzir/pausar abas ocultas.
- **Servidor PeerJS público** (`0.peerjs.com`) não tem garantia de disponibilidade. Para uso sério, hospede o seu e aponte `CONFIG.SIGNALING` (ou o override acima).
- **A busca usa um formato não oficial do YouTube** (sem API) e pode quebrar a qualquer momento; colar o link continua funcionando.
- **Termos de uso do YouTube:** controlar a reprodução e raspar a busca é uma zona cinzenta. Projeto para **uso próprio**, não distribuído pela Chrome Web Store.
- Instalação "sem compactação": o Chrome pode mostrar avisos de extensão em modo desenvolvedor.
