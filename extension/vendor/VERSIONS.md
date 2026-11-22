# Bibliotecas de terceiros (vendor)

Nada é carregado de CDN em runtime. Arquivos baixados do registry npm e fixados nestas versões.

| Arquivo | Pacote | Versão | Licença | Origem |
|---|---|---|---|---|
| `peerjs.min.js` (também em `web/vendor/`) | peerjs | 1.5.5 | MIT | `dist/peerjs.min.js` do pacote npm `peerjs@1.5.5` (build IIFE que define a global `Peer`; apenas a linha `sourceMappingURL` foi removida) |
| `qrcode.js` | qrcode-generator | 2.0.4 | MIT | `dist/qrcode.mjs` do pacote npm `qrcode-generator@2.0.4` (ES module com `export default qrcode`; copiado sem alterações) |

Para atualizar: baixe a nova versão com `npm pack`/`npm install` em um diretório temporário, copie os arquivos, atualize esta tabela e rode `npm test`.
