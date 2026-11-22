// Critério (issue #6): em tela cheia, a próxima música continua em tela cheia.
// Caminho principal: a troca é navegação interna do YouTube (yt-navigate, sem recarregar a página),
// então a tela cheia nem cai. Se a página recarregar, o Chrome só deixa voltar com um gesto: o KTV
// lembra e volta no próximo toque/tecla.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comAmbiente, ate } from './helpers/ambiente.js';

const ID = (n) => `ffffffffff${n}`;

async function prepararFila(amb, n, duracao) {
  amb.yt.duracao = duracao;
  await amb.prepararKtv();
  const cel = await amb.novoCelular('Rui');
  for (let i = 1; i <= n; i++) {
    await cel.colarLink(`https://youtu.be/${ID(i)}`);
    await cel.esperarEstado((s) => [s.atual, ...s.fila].some((x) => x && x.videoId === ID(i)));
  }
  return cel;
}
const tocando = (amb, id) => ate(async () => {
  const p = await amb.paginaKtv();
  return p && p.videoId === id && !p.pausado && p.tempo > 0.3 && p;
}, { timeout: 40000, descricao: `música ${id} tocando` });
// Gesto real do usuário (Playwright): clique no botão de tela cheia do player.
const entrarTelaCheia = async (amb) => {
  await amb.ktv.locator('.ytp-fullscreen-button').click();
  await ate(async () => { const p = await amb.paginaKtv(); return p?.telaCheia && p.memoriaTelaCheia === '1'; }, { descricao: 'entrou em tela cheia (e lembrou)' });
};

test('fullscreen: a próxima música (fim ou "Próxima") continua em tela cheia, sem recarregar', { timeout: 180000 }, () => comAmbiente('fullscreen', async (amb) => {
  const cel = await prepararFila(amb, 3, 6);
  const p1 = await tocando(amb, ID(1));
  await entrarTelaCheia(amb);

  // fim natural da música 1 -> 2
  const p2 = await tocando(amb, ID(2));
  assert.ok(p2.telaCheia, 'a música 2 deveria continuar em tela cheia');
  assert.equal(p2.fake.documento, p1.fake.documento, 'a troca deveria ser SPA (sem recarregar a página)');

  // "Próxima" pelo celular no meio da música 2 -> 3
  await cel.aba('controle');
  await cel.page.getByTestId('ctl-skip').click();
  const p3 = await tocando(amb, ID(3));
  assert.ok(p3.telaCheia, 'a música 3 deveria continuar em tela cheia');
  assert.equal(p3.memoriaTelaCheia, '1');
}));

test('fullscreen: sair da tela cheia no meio da música desliga a lembrança', { timeout: 180000 }, () => comAmbiente('fullscreen-sair', async (amb) => {
  await prepararFila(amb, 2, 6);
  await tocando(amb, ID(1));
  await entrarTelaCheia(amb);
  await amb.ktv.evaluate(() => document.exitFullscreen());
  await ate(async () => (await amb.paginaKtv())?.memoriaTelaCheia === '0', { descricao: 'lembrança desligada' });
  const p2 = await tocando(amb, ID(2));
  assert.equal(p2.telaCheia, false, 'o usuário saiu da tela cheia: a próxima não deveria voltar a ela');
}));

test('fullscreen: com recarga completa da página, volta no próximo toque', { timeout: 180000 }, () => comAmbiente('fullscreen-recarga', async (amb) => {
  amb.yt.modo = 'full'; // a navegação do YouTube recarrega a página (o pior caso)
  await prepararFila(amb, 2, 5);
  const p1 = await tocando(amb, ID(1));
  await entrarTelaCheia(amb);
  const p2 = await tocando(amb, ID(2));
  assert.notEqual(p2.fake.documento, p1.fake.documento, 'deveria ter recarregado (teste sem efeito)');
  assert.equal(p2.memoriaTelaCheia, '1', 'a recarga não pode apagar a lembrança');
  // Sem gesto o Chrome não deixa voltar à tela cheia; um toque qualquer na página devolve.
  await amb.ktv.mouse.click(5, 5);
  await ate(async () => (await amb.paginaKtv())?.telaCheia, { descricao: 'voltou à tela cheia no toque' });
  const p = await amb.paginaKtv();
  assert.equal(p.pausado, false, 'o toque que devolve a tela cheia não deveria pausar o vídeo');
}));
