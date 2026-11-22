// Copia o contrato da extensão para o site do celular (web/protocol.js).
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const origem = join(raiz, 'extension/src/shared/protocol.js');
const destino = join(raiz, 'web/protocol.js');
copyFileSync(origem, destino);
console.log('protocol.js sincronizado: extension/src/shared -> web/');
