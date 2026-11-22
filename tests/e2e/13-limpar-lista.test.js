// Limpar lista: esvazia as próximas para todos, mantém a música atual; exige segundo toque.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comAmbiente } from './helpers/ambiente.js';

const ID = (n) => `eeeeeeeeee${n}`;

test('limpar lista: segundo toque confirma, todos veem a fila vazia e a atual segue tocando', { timeout: 150000 }, () => comAmbiente('limpar', async (amb) => {
  amb.yt.duracao = 30;
  await amb.prepararKtv({ iniciar: true });
  const ana = await amb.novoCelular('Ana');
  const beto = await amb.novoCelular('Beto');

  await ana.aba('fila');
  assert.equal(await ana.page.getByTestId('clear-btn').isVisible(), false); // fila vazia: sem botão

  for (const n of [1, 2, 3]) await ana.colarLink(`https://youtu.be/${ID(n)}`);
  await beto.esperarEstado((s) => s.atual?.videoId === ID(1) && s.fila.length === 2);

  await ana.aba('fila');
  const btn = ana.page.getByTestId('clear-btn');
  await btn.click();                      // 1º toque só arma
  assert.match(await btn.textContent(), /de novo/);
  assert.equal((await beto.estado()).fila.length, 2);
  await btn.click();                      // 2º toque limpa
  const s = await beto.esperarEstado((x) => x.fila.length === 0, { descricao: 'Beto vê a fila vazia' });
  assert.equal(s.atual.videoId, ID(1));
  assert.equal(s.tocando, true);
  await amb.esperarFila((e) => e.fila.length === 0);
}));
