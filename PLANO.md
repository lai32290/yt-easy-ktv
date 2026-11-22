# Plano de implantação: KTV no YouTube (extensão Chrome + celulares via P2P)

Plano derivado do documento de handoff. Cada tarefa é pequena (alvo: 30–90 min), tem **entrega verificável** e indica **dependências**. Faça na ordem; tarefas sem dependência mútua podem ser feitas em paralelo.

Legenda: `[ ]` pendente · **[VALIDAR]** = ponto incerto que exige teste real no Chrome/YouTube antes de seguir · `Dep:` = depende de.

---

## M0 — Preparação do repositório

- [ ] **T0.1 Estrutura de pastas.** Criar `extension/src/{background,offscreen,content,shared}`, `extension/vendor`, `web/vendor`. Entrega: árvore igual à seção 4 do handoff, com arquivos vazios/placeholder.
- [x] **T0.2 `.gitignore` e README mínimo.** Ignorar `node_modules`, `dist`. README com 3 linhas: o que é, como carregar a extensão, onde fica o site. Dep: T0.1.
- [x] **T0.3 Baixar libs para `vendor/`.** `peerjs.min.js` (extensão e `web/`) e lib de QR (ex.: `qrcode-generator`, sem dependências). Fixar versão e anotar no README (`vendor/VERSIONS.md`). Nada carregado de CDN em runtime. Dep: T0.1.
- [ ] **T0.4 Definir `shared/protocol.js`.** Constantes dos tipos de mensagem (`hello`, `state`, `search`, `results`, `add`, `remove`, `skip`, `move`, `error` + internas `play`, `ended`, `playerError`), formato do `Item` e códigos de erro. Entrega: um único arquivo importado por todos. Dep: T0.1.
- [x] **T0.5 Decidir build.** Começar **sem bundler** (ES modules). Só adotar esbuild se T0.3/T1.x exigirem. Registrar a decisão no README.

---

## M1 — Esqueleto e P2P (sem YouTube)

**Extensão**
- [ ] **T1.1 `manifest.json` MV3.** Permissões `offscreen`, `storage`, `tabs`, `windows`; `host_permissions` `https://www.youtube.com/*`; `background.service_worker`; `content_scripts` (matches youtube, `document_idle`). Entrega: extensão carrega em `chrome://extensions` (modo desenvolvedor) sem erros. Dep: T0.1.
- [ ] **T1.2 Service worker mínimo.** Ao iniciar, garantir o offscreen document (`chrome.offscreen.hasDocument`/`createDocument`, reason `WEB_RTC`). Entrega: log mostrando o offscreen criado, sem duplicar. Dep: T1.1.
- [x] **T1.3 Offscreen: criar o Peer.** `offscreen.html` + `offscreen.js` instanciam `new Peer()`; ao `open`, enviam `roomId` ao service worker via `chrome.runtime.sendMessage`. Entrega: ID da sala visível no log do SW. Dep: T1.2, T0.3.
- [x] **T1.4 Offscreen: aceitar conexões.** `peer.on('connection')`, manter lista de conexões abertas, remover ao fechar. Repassar mensagens recebidas ao SW. Dep: T1.3, T0.4.
- [ ] **T1.5 Fila em memória + `state`.** Módulo puro `queue.js` (adicionar, remover, avançar) sem dependência do Chrome; SW usa e devolve `state` ao offscreen para broadcast. Dep: T1.4.
- [ ] **T1.6 Testes unitários de `queue.js`.** Casos: adicionar, duplicata, remover, avançar, fila vazia. Rodar com `node --test` (só dev; usuário final não precisa de Node). Dep: T1.5.

**Site do celular**
- [ ] **T1.7 Esqueleto `web/index.html` + `app.js` + `style.css`.** Mobile-first, em pt-BR, tela "Conectando…". Dep: T0.1.
- [ ] **T1.8 Ler `#sala=` e conectar.** `location.hash` → `new Peer()` → `peer.connect(sala)`. Estados: conectando / conectado / erro / desconectado (botão reconectar). Dep: T1.7, T0.3.
- [ ] **T1.9 Tela de nome + `hello`.** Pedir nome (guardar em `localStorage`), enviar `hello`. Dep: T1.8.
- [ ] **T1.10 Renderizar `state`.** Mostrar fila e música atual recebidas. Dep: T1.9.

**Marco de aceite M1 (teste manual):** abrir `web/` localmente (HTTPS ou `localhost`) com `#sala=<ID do log>`; o celular se conecta, envia `hello` e vê o `state`. Dois dispositivos veem o mesmo `state`.

---

## M2 — Player (content script)

- [ ] **T2.1 Marcar a aba/janela KTV.** SW abre a janela dedicada (`chrome.windows.create`) em `youtube.com/?ktv=1` e guarda o `tabId`. Content script só age se o SW confirmar que aquela aba é a do player. Entrega: abas normais do YouTube não são tocadas. Dep: T1.2.
- [ ] **T2.2 Botão "Iniciar" (autoplay).** Overlay mínimo com botão que satisfaz a política de autoplay do Chrome; só depois disso o SW pode mandar `play`. Dep: T2.1.
- [ ] **T2.3 Receber `play {videoId}` e navegar.** **[VALIDAR]** navegação SPA vs `location.href` e se o som toca sem nova interação. Implementar a que funcionar; a outra como fallback. Dep: T2.2.
- [ ] **T2.4 Localizar `video.html5-main-video` e detectar `ended`.** Reaplicar listeners em `yt-navigate-finish`. Enviar `ended` ao SW. Dep: T2.3.
- [ ] **T2.5 Desativar o autoplay do YouTube.** **[VALIDAR]** seletor atual do botão; tolerar mudança de DOM (se não achar, logar e confiar em T2.6). Dep: T2.3.
- [ ] **T2.6 Garantir que o YouTube não troque de vídeo sozinho.** Ao `ended`, pausar e deixar o SW decidir o próximo. Dep: T2.4.
- [ ] **T2.7 SW: avançar a fila.** Em `ended`/`skip`: próximo item → `play`; fila vazia → estado ocioso. Se chegar item e estiver ocioso → `play`. Dep: T2.4, T1.5.
- [ ] **T2.8 `playerError`.** Detectar vídeo indisponível/restrito (mensagem de erro do player ou timeout sem `playing`), enviar `playerError`; SW registra, pula e envia `error` ao celular. Dep: T2.7.
- [ ] **T2.9 Persistir estado.** Gravar `{roomId, fila, atual, tocando}` em `chrome.storage.session/local` a cada mudança; restaurar ao acordar o SW. Dep: T2.7.

**Marco de aceite M2:** com 2–3 IDs fixos na fila (hardcoded), a janela toca um, termina, toca o próximo sozinha, e pula um vídeo inexistente.

---

## M3 — Entrada de músicas

- [ ] **T3.1 `parseUrl()`.** Extrair `videoId` de `youtu.be/ID`, `watch?v=ID`, `/shorts/ID`, `music.youtube.com/watch?v=ID`; ignorar `&list=`; validar `^[\w-]{11}$`. Testes unitários. Dep: T0.4.
- [ ] **T3.2 Metadados via oEmbed.** SW faz `fetch` em `youtube.com/oembed?url=…&format=json` → `titulo`, `canal`. Tratar falha (vídeo privado/removido) com `error`. Dep: T3.1.
- [ ] **T3.3 Tratar `add` no SW.** Validar, bloquear duplicata (mesmo `videoId` na fila), montar `Item` (`itemId` uuid, `pedidoPor`, `addedAt`), enfileirar, broadcast. Dep: T3.2, T1.5.
- [ ] **T3.4 UI "Colar link" no celular.** Campo + botão; mostra erro vindo de `error`. Dep: T3.3, T1.10.
- [ ] **T3.5 `search.js` — função `buscar(q)`.** **[VALIDAR]** escolher entre `GET /results?search_query=` (extrair `ytInitialData`) e `POST /youtubei/v1/search`. Implementar a mais estável, mapear `videoRenderer` → `{videoId,titulo,canal,duracao}`, limitar a 10–15. Isolada em um único módulo. Dep: T1.1.
- [ ] **T3.6 Sufixo "karaokê" configurável.** Padrão ligado; opção de desligar enviada junto do `search`. Dep: T3.5.
- [ ] **T3.7 Tratar `search` no SW.** Chamar `buscar`, responder `results {id, itens}` só à conexão que pediu; falha → `error` sugerindo colar o link. Dep: T3.5, T1.4.
- [ ] **T3.8 UI de busca no celular.** Campo, lista de resultados com miniatura (`i.ytimg.com/vi/{id}/mqdefault.jpg`), botão adicionar, estado de carregando/erro, debounce. Dep: T3.7, T3.3.
- [ ] **T3.9 Teste de fumaça da busca.** Script manual (ou página de debug na extensão) que roda 3 consultas e mostra o resultado, para detectar quebra de formato do YouTube. Dep: T3.5.

**Marco de aceite M3:** do celular, buscar uma música e colar um link; ambos entram na fila e tocam.

---

## M4 — QR e painel

- [ ] **T4.1 Montar a URL da sala.** `https://<host-do-site>/#sala=<ID>`; host vem de uma constante configurável. Dep: T1.3.
- [ ] **T4.2 Gerar QR localmente.** Usar a lib de `vendor/` no content script (ou no SW) → SVG/canvas. Dep: T4.1, T0.3.
- [ ] **T4.3 Painel em shadow DOM.** Container injetado na aba KTV, CSS isolado em `overlay.css`; sem vazar para a página. Dep: T2.1.
- [ ] **T4.4 Modo fila vazia.** QR grande + URL em texto + instrução em pt-BR. Dep: T4.2, T4.3.
- [ ] **T4.5 Modo tocando.** QR pequeno no canto + fila compacta (próximos itens, quem pediu). Atualiza a cada `state`. Dep: T4.4, T1.5.
- [ ] **T4.6 Indicador de conexão.** Mostrar nº de celulares conectados e status da sinalização. Dep: T4.3.

**Marco de aceite M4:** escanear o QR na tela e cair direto no site conectado.

---

## M5 — Robustez

- [~] **T5.1 Reconexão do PeerJS.** _(lado offscreen feito e testado com Peer falso; falta persistência do roomId no SW e teste real)_ `peer.on('disconnected')` → `peer.reconnect()`; se `peer.destroyed`, recriar com o **mesmo ID**. Persistir o ID da sala em `chrome.storage` (via SW) e passá-lo ao offscreen. Dep: T1.3, T2.9.
- [ ] **T5.2 Reconexão no celular.** Botão "reconectar" + tentativa automática com backoff, reaproveitando o mesmo `#sala`. Dep: T1.8.
- [ ] **T5.3 Regras de permissão.** `remove` só do próprio item (comparar participante); `skip` liberado a todos (configurável por constante). Dep: T3.3.
- [ ] **T5.4 Identidade do participante.** ID estável por celular (guardado em `localStorage`) enviado no `hello`, para que "remover o próprio item" sobreviva a reconexões. Dep: T1.9.
- [ ] **T5.5 Mensagens de erro padronizadas.** Tabela de códigos em `protocol.js` → textos em pt-BR no celular. Dep: T0.4.
- [ ] **T5.6 Recuperação após suspensão do SW.** Teste: matar o SW em `chrome://serviceworker-internals` e conferir que fila, música atual e sala voltam. Dep: T2.9, T5.1.
- [ ] **T5.7 Host de sinalização configurável.** `host/port/path/secure` do PeerJS em constante única, para trocar de `0.peerjs.com` por um servidor próprio. Dep: T1.3.
- [ ] **T5.8 `move` (reordenar) — opcional.** Só se sobrar tempo; incluir na UI do celular. Dep: T5.3.

**Marco de aceite M5:** todos os itens da seção 12 do handoff marcados (ver checklist abaixo).

---

## M6 — Implantação (publicar o que o usuário final usa)

- [~] **D1 Publicar o site do celular.** (workflow criado em `.github/workflows/pages.yml`, falta habilitar Pages) GitHub Pages (padrão) servindo `web/` (via Action ou pasta `docs/`). Confirmar HTTPS e que o `#sala=` abre. Dep: M1 pronto.
- [ ] **D2 Apontar a extensão para o site publicado.** Atualizar a constante do host (T4.1) para a URL do Pages. Dep: D1.
- [x] **D3 Empacotar a extensão.** Gerar `ktv-extension.zip` (conteúdo de `extension/`, sem arquivos de dev). Dep: M5.
- [x] **D4 Guia de instalação (pt-BR).** Passo a passo curto: baixar zip → extrair → `chrome://extensions` → modo desenvolvedor → "Carregar sem compactação" → abrir janela KTV → escanear QR. Dep: D3.
- [x] **D5 Aviso de limitações no guia.** Wi-Fi com isolamento de clientes bloqueia P2P; manter a janela do player visível; servidor PeerJS público sem garantia. Dep: D4.
- [ ] **D6 Teste de ponta a ponta em máquina limpa.** Perfil novo do Chrome, 2 celulares reais no mesmo Wi-Fi, sessão de 30 min. Dep: D2, D3.
- [ ] **D7 Release.** Tag `v0.1.0` com o zip anexado. Dep: D6.

---

## Fase opcional (M7)

- [ ] **O1 PIN de 4 dígitos** exibido no painel e exigido no `hello`.
- [ ] **O2 Rodízio justo** entre pessoas ao enfileirar.
- [ ] **O3 Modo anfitrião** (só ele pula/reordena).
- [ ] **O4 PWA + Web Share Target** (Android) no site do celular.
- [ ] **O5 Tema/visual.**

---

## Checklist de aceite do MVP (da seção 12 do handoff)

- [ ] Instalo a extensão (modo desenvolvedor) e abro a janela KTV sem instalar mais nada.
- [ ] QR aparece na tela do player; ao escanear, o site abre conectado.
- [ ] Posso buscar uma música e colar um link; ambos adicionam à fila.
- [ ] Dois ou mais celulares veem a mesma fila em tempo real.
- [ ] A música termina e a próxima toca sozinha, sem interferência do autoplay do YouTube.
- [ ] Vídeo indisponível é pulado e o celular é avisado.
- [ ] Recarregar a extensão / suspender o SW não perde a fila.
- [ ] Celular desconectado reconecta sem novo QR enquanto a sala existir.
- [ ] Nenhum Node/executável é necessário para o usuário final.

---

## Ordem sugerida e caminho crítico

1. **M0 → M1** (prova de que P2P funciona; maior risco técnico de infraestrutura).
2. **T2.3 e T3.5** cedo, em paralelo: são os dois pontos **[VALIDAR]** mais frágeis (navegação/autoplay do YouTube e busca sem API). Se algum falhar, a mitigação já está no handoff (fallback `location.href`; colar link como via principal).
3. M2 → M3 → M4 → M5 → M6.

## Decisões padrão assumidas (da seção 13 do handoff)

Qualquer pessoa pode pular · sem PIN no MVP · hospedagem GitHub Pages · extensão distribuída "sem compactação" (Web Store fora do escopo) · sufixo "karaokê" ligado, com opção de desligar · UI em pt-BR.

## Riscos a monitorar durante a execução

| Risco | Onde aparece | Mitigação |
|---|---|---|
| SW MV3 suspenso | T2.9, T5.6 | Persistir tudo em `chrome.storage` |
| WebRTC fora do SW | T1.2–T1.4 | Offscreen document |
| CSP do YouTube | T1.3 | PeerJS só no offscreen |
| Autoplay bloqueado | T2.2, T2.3 | Botão "Iniciar", fallback de navegação |
| Formato do YouTube muda | T2.5, T3.5 | Módulo isolado + T3.9 |
| Servidor PeerJS público | T5.7 | Host configurável |
| Wi-Fi com isolamento | D5 | Documentar; TURN fora do escopo |
