# Roteiro de teste manual (YouTube real + celulares reais)

Os testes automatizados (`npm run test:e2e`) usam um Chromium real com a extensão carregada, mas com um **YouTube falso**, um servidor PeerJS local e "celulares" que são navegadores no mesmo PC. Tudo o que depende do YouTube de verdade, de celulares de verdade ou da rede de verdade está aqui. Marque cada item ao testar e anote o que falhou (com a versão do Chrome e o modelo do celular).

Preparação: Chrome 116+ com a extensão carregada (modo desenvolvedor), um perfil limpo, 2 celulares (ideal: 1 Android + 1 iPhone) no mesmo Wi-Fi do PC, 3 a 5 músicas de karaokê em mente (inclua uma muito curta, uma de canal que bloqueia incorporação e um link de playlist).

## 0. Sobre o servidor de sinalização e o site

- [ ] **Site publicado (HTTPS):** abra a URL do GitHub Pages no celular. Sem `#sala=` deve aparecer "Escaneie o QR code na tela do KTV".
- [ ] **PeerJS público `0.peerjs.com` + site em HTTPS:** com `CONFIG.SIGNALING` padrão, o QR da tela abre o site e o status vira **Conectado** em poucos segundos. Se ficar em "Conectando…"/erro, anote a mensagem (o site mostra o motivo). Repita 2 vezes: o servidor público pode estar fora do ar.
- [ ] **Wi-Fi com isolamento de clientes** (rede de convidados): a conexão P2P deve falhar com mensagem clara ("Sala não encontrada"/"A conexão demorou demais") e o botão **Reconectar** deve aparecer. Não há TURN: isso é limitação conhecida (README).
- [ ] **Celular em 4G/5G** (fora do Wi-Fi): pode funcionar ou não (depende da operadora, sem TURN). Só registre o resultado.
- [ ] **iOS Safari:** abre o site, pede o nome, conecta, busca e adiciona. Bloquear a tela e voltar: o status deve voltar a **Conectado** (reconexão automática ou botão). Teste também "voltar" do histórico (bfcache): o site deve reconectar sozinho.

## 1. Abrir a janela KTV e liberar o som

- [ ] Clique no ícone da extensão: abre **uma** janela do YouTube (`?ktv=1`) com o painel (QR grande + "Iniciar KTV"). Clicar no ícone de novo apenas foca a janela. Clicando no ícone numa aba comum do YouTube **que já tem fila** (e sem janela KTV aberta), essa aba vira a aba KTV com a fila mantida e o botão "Iniciar KTV" de volta.
- [ ] Uma aba normal do YouTube aberta ao mesmo tempo **não** mostra painel nem é controlada.
- [ ] Clique em **Iniciar KTV**: o painel muda para o modo "fila vazia" (QR grande, instrução em pt-BR, "Nenhum celular conectado").
- [ ] **[VALIDAR] Som sem novo clique:** depois de Iniciar, peça uma música pelo celular. Ela deve **tocar com som**, sem você clicar de novo no PC. Se aparecer o botão **▶ Tocar**, o Chrome barrou o autoplay: anote em que situação (primeira música? depois de recarregar?).
- [ ] Escaneie o QR com a câmera do celular: o site abre **já conectado** (informe o nome na primeira vez).
- [ ] Com o site já aberto no celular, escaneie um QR de **outra sala** (ex.: depois de a sala trocar de ID): o site deve recarregar e entrar na sala nova.

## 2. Navegação entre músicas

- [ ] **[VALIDAR] SPA vs recarga completa:** com 3 músicas na fila, observe a troca: a página do YouTube deve trocar de vídeo **sem recarregar** (o painel não pisca). Se recarregar a página inteira, o som deve continuar a tocar sozinho (anote se pedir clique).
- [ ] A música termina e a **próxima toca sozinha**, na ordem da fila. Nada de "recomendado" tocando.
- [ ] **[VALIDAR] Player certo:** a janela KTV abre na home do YouTube, que tem prévias de vídeo ao passar o mouse nas miniaturas. Passe o mouse sobre miniaturas antes da primeira música: nada deve ser pausado/pulado por engano (o KTV procura o vídeo dentro de `#movie_player`).
- [ ] **Pular com toque duplo / dois celulares ao mesmo tempo:** deve pular **uma** música só.
- [ ] **[VALIDAR] Botão de autoplay do YouTube:** na barra do player, o botão "Reprodução automática" deve ser **desligado** pelo KTV (ícone cinza). Se o YouTube mudou o seletor, o log do console da aba mostra `[KTV] autoplay do YouTube desligado` (ou nada). Mesmo com ele ligado, o KTV deve conter o "próximo vídeo" (guarda anti-autoplay).
- [ ] Ao terminar a **última** música: volta ao modo ocioso (QR grande). Um novo pedido toca sem clicar de novo.
- [ ] **Pular** (de qualquer celular): troca de música imediatamente; pular a última deixa a sala ociosa.

## 3. Player real: erros, anúncios e diálogos

- [ ] **[VALIDAR] Detecção de erro do player:** adicione um vídeo **privado/removido** (cole o link) e um vídeo com **restrição de idade/região**. O KTV deve pular em poucos segundos e todos os celulares recebem o aviso "<título> indisponível, pulada". Anote o texto que o YouTube mostrou no player e se o seletor (`.ytp-error` etc.) pegou.
- [ ] Vídeo **sem incorporação** (oEmbed 401/403): deve entrar na fila com o título provisório "Vídeo <id>" e tocar normalmente no youtube.com.
- [ ] **[VALIDAR] Anúncios:** com uma conta sem Premium, deixe tocar uma música que tenha anúncio antes. O fim do **anúncio** não pode ser tratado como fim da música (a música não pode ser pulada sozinha). Enquanto o player tem a classe `ad-showing`/`ad-interrupting` (no `#movie_player`), o KTV não conta "tocando" nem o timeout de 15 s. Teste também **2 anúncios seguidos** e um anúncio **no meio** da música. Anote o que aconteceu.
- [ ] **[VALIDAR] "Continuar assistindo?":** deixe a fila rodar por 1 a 2 horas (ou mais) e veja se o YouTube pergunta "Continuar assistindo?". O KTV tenta confirmar sozinho (clica em `#confirm-button` do `yt-confirm-dialog-renderer`; o console da aba mostra `[KTV] "Continuar assistindo?" confirmado`). Se o diálogo aparecer e a música ficar parada, anote o HTML do diálogo: no meio de uma música (depois de começar a tocar) **não há timeout** que a pule.
- [ ] **[VALIDAR] Tela cheia:** coloque o vídeo em tela cheia (F11 ou botão do player). O painel do KTV (QR/fila) **some** junto com a página; ao sair da tela cheia ele volta. Anote se isso atrapalha (talvez seja melhor usar a janela maximizada sem tela cheia).
- [ ] **Tela cheia entre músicas (#6):** em tela cheia (botão do player ou tecla `f`), deixe a música terminar e também use "Próxima" no celular: a próxima deve começar **sem sair** da tela cheia (a troca é navegação interna do YouTube). Se a página recarregar mesmo assim (ex.: o YouTube mudou), a tela cheia cai e volta no **próximo toque ou tecla** na janela KTV: limite do Chrome, que não deixa entrar em tela cheia sem gesto do usuário. Sair da tela cheia no meio da música desliga a lembrança.
- [ ] **Aba Controle do celular (#3):** com música tocando (e também durante um anúncio), teste tocar/pausar, do início, -10s/+10s, mudo, volume -/+ e próxima. O volume e o mudo devem aparecer iguais no controle de volume do próprio YouTube e **continuar valendo na música seguinte**. Durante anúncio, só os saltos (-10s/+10s/do início) são ignorados.
- [ ] Janela do player **minimizada** ou totalmente coberta: veja se a música continua a tocar e a trocar (o Chrome pode reduzir abas ocultas; o README manda manter a janela visível).

## 4. Pedidos pelo celular

- [ ] **Busca real:** busque "evidências" (com e sem o sufixo "karaokê"). Devem aparecer ~12 resultados com miniatura, canal e duração; Shorts/ao vivo/anúncios não entram.
- [ ] **[VALIDAR] `fetch` da busca e do oEmbed a partir do service worker real:** a busca e a adição por link funcionam sem erros no console do service worker (`chrome://extensions` → KTV YouTube → "service worker" → Console). Na **União Europeia** a página de consentimento do YouTube pode devolver HTML sem `ytInitialData`: a busca deve falhar com a mensagem "A busca falhou. Tente colar o link do YouTube." e **colar o link continua funcionando**.
- [ ] **[VALIDAR] `lockupViewModel` ao vivo:** o YouTube alterna formatos de resultado (`videoRenderer` / `lockupViewModel`). Rode `node tests/smoke-search.mjs` algumas vezes (3 consultas reais): todas devem voltar com resultados. Se alguma voltar vazia, salve o HTML e atualize os fixtures em `tests/fixtures/`.
- [ ] **Botão "Adicionar o link copiado":** copie um link do YouTube, abra a aba Colar link e toque no botão: o vídeo entra na fila (o navegador pode pedir permissão para ler a área de transferência; se negada, aparece um aviso). Área vazia: aviso.
- [ ] **Colar link:** `youtu.be/ID`, `youtube.com/watch?v=ID&list=...` (a lista é ignorada), `youtube.com/shorts/ID`, `music.youtube.com/watch?v=ID`. Todos entram. Link de outro site ou texto qualquer: "Link inválido…".
- [ ] **Duplicata:** o mesmo vídeo duas vezes (por formatos de link diferentes) é recusado com "Essa música já está na fila.".
- [ ] **Dois celulares:** veem a **mesma fila** ao mesmo tempo; o botão "Remover" aparece só nos itens de cada um; "Pular" aparece para todos.
- [ ] Nome com acentos/emoji e nome muito longo (máx. 30) aparecem corretamente em "pedido por".

## 5. Robustez

- [ ] **Reconexão do celular:** bloqueie a tela do celular por 1 minuto e desbloqueie: o site volta a **Conectado** sozinho (ou pelo botão Reconectar) **sem novo QR**; seus itens continuam removíveis por você.
- [ ] **Celular "fantasma":** tire o celular do Wi-Fi abruptamente (modo avião). O contador "N celulares conectados" no painel pode demorar para cair (o canal de dados só é dado como morto depois de um tempo; ao fechar a página normalmente cai na hora). Anote quanto demora.
- [ ] **Recarregar a aba KTV (F5)** no meio de uma música: a fila e a música atual continuam; a música é retomada (talvez com o botão **▶ Tocar** se o Chrome barrar o som); os celulares seguem conectados.
- [ ] **Recarregar a extensão** em `chrome://extensions` (botão ↻) no meio de uma sessão: a **fila e a sala** voltam (mesmo QR); a aba KTV é **recarregada sozinha** (para reinjetar o script; a música atual recomeça do início, talvez pedindo **▶ Tocar**) e os celulares reconectam sozinhos.
- [ ] **Fechar e reabrir o Chrome** com fila pendente: nenhuma aba comum do YouTube vira "aba KTV" (os IDs de aba recomeçam a cada abertura do navegador). Clique no ícone: abre uma nova janela KTV com a fila mantida.
- [ ] **Suspensão do service worker:** deixe a fila parada por 5+ minutos e peça uma música: deve ser processada normalmente (o SW acorda pelas mensagens do celular).
- [ ] **Fechar a janela KTV** e clicar no ícone de novo: abre outra janela; a fila anterior é mantida e o botão **Iniciar KTV** reaparece.
- [ ] **Sessão longa (30 min, D6):** perfil limpo, 2 celulares reais, 8 a 10 músicas variadas. Anote travamentos, perdas de conexão e qualquer vídeo que não tocou.

## O que os testes automatizados já cobrem (não precisa repetir à mão)

Abertura da janela KTV e QR (conteúdo e URL `#sala=`), conexão do celular por `#sala=`, nome/`hello`/`state`, busca e adição (fixtures `videoRenderer` e `lockupViewModel`), links (`youtu.be`, `watch?v=&list=`, `shorts`), adicionar o mesmo vídeo de novo, fila compartilhada em tempo real, remover só o próprio item, pular, avanço automático com contenção do autoplay (SPA e recarga completa), modo ocioso, vídeo indisponível, parada/reinício do service worker, perda do offscreen, reabertura do site, queda/volta da sinalização e o contrato de mensagens. O que **não** dá para provar com o YouTube falso é o comportamento real do player, dos anúncios, do consentimento e da CSP do YouTube; nem a rede/hardware reais (Wi-Fi, iOS, NAT).
