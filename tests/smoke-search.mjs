// Teste de fumaça MANUAL da busca (usa a rede de verdade): node tests/smoke-search.mjs
// Roda 3 consultas reais no YouTube e imprime os resultados, para detectar quebra de formato.
// Sai com código 1 se alguma consulta falhar ou voltar vazia.
import { buscar } from '../extension/src/background/search.js';

const consultas = ['evidências', 'bohemian rhapsody', 'trem bala ana vilela'];
let falhas = 0;

for (const q of consultas) {
  try {
    const itens = await buscar(q);
    console.log(`\n== "${q}" -> ${itens.length} resultado(s)`);
    for (const i of itens) console.log(`  ${i.videoId}  ${i.duracao.padStart(6)}  ${i.titulo}  [${i.canal}]`);
    if (itens.length === 0) { console.error('  VAZIO: formato do YouTube pode ter mudado'); falhas++; }
  } catch (e) {
    console.error(`\n== "${q}" FALHOU: ${e.codigo || ''} ${e.message}`);
    falhas++;
  }
}
console.log(falhas ? `\n${falhas} consulta(s) com problema.` : '\nOK: 3/3 consultas devolveram resultados.');
process.exit(falhas ? 1 : 0);
