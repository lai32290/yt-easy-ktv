# KTV no YouTube

Karaokê no YouTube: o PC toca os vídeos numa janela dedicada e os celulares da sala pedem músicas (busca ou link) por uma página web, sem instalar nada no celular. Tudo conversa por WebRTC (PeerJS), sem servidor próprio.

## Arquitetura (resumo)

1. **Extensão Chrome (MV3)** em `extension/`, sem bundler (ES modules); o usuário final não precisa de Node.
2. **Service worker** (`src/background/`): fila, estado, busca, abre a janela KTV e persiste em `chrome.storage`.
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
5. Clique no ícone da extensão **KTV YouTube** na barra do Chrome: abre a janela KTV do YouTube.
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
npm run test:e2e   # testes de ponta a ponta (tests/e2e, Playwright instalado globalmente)
npm run sync       # copia extension/src/shared/protocol.js -> web/protocol.js
npm run build      # gera dist/ktv-extension.zip (conteúdo de extension/)
```

### Sinalização alternativa (testes / servidor próprio)

- **Celular:** acrescente ao link `#sala=ID&sig=host:porta&secure=0` (ex.: `#sala=abc&sig=192.168.0.10:9000&secure=0`).
- **Extensão:** em `chrome.storage.local`, a chave `ktv_signaling` com `{ "host": "...", "port": 9000, "path": "/", "secure": false }`. Ela substitui `CONFIG.SIGNALING` (defina-a no console do service worker: `chrome.storage.local.set({ktv_signaling:{host:'192.168.0.10',port:9000,path:'/',secure:false}})`).
- Para trocar o padrão de vez, edite `CONFIG.SIGNALING` em `protocol.js` e rode `npm run sync`.

## Limitações

- **Wi-Fi com isolamento de clientes** (comum em redes de convidados/públicas) bloqueia a conexão P2P entre celular e PC. Não há servidor TURN neste projeto.
- **Mantenha a janela do player visível** (não minimizada nem totalmente coberta): o Chrome pode reduzir/pausar abas ocultas.
- **Servidor PeerJS público** (`0.peerjs.com`) não tem garantia de disponibilidade. Para uso sério, hospede o seu e aponte `CONFIG.SIGNALING` (ou o override acima).
- **A busca usa um formato não oficial do YouTube** (sem API) e pode quebrar a qualquer momento; colar o link continua funcionando.
- **Termos de uso do YouTube:** controlar a reprodução e raspar a busca é uma zona cinzenta. Projeto para **uso próprio**, não distribuído pela Chrome Web Store.
- Instalação "sem compactação": o Chrome pode mostrar avisos de extensão em modo desenvolvedor.
