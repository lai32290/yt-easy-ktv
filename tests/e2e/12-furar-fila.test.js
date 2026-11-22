// 插播: "Tocar a seguir" fura a fila (FIFO entre os furados) e "Passar pra frente" move um item existente.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comAmbiente } from './helpers/ambiente.js';

const ID = (n) => `dddddddddd${n}`;

test('插播: tocar a seguir entra na frente da fila; o 2º 插播 fica depois do 1º', { timeout: 150000 }, () => comAmbiente('furar', async (amb) => {
  amb.yt.duracao = 30;
  await amb.prepararKtv({ iniciar: true });
  const ana = await amb.novoCelular('Ana');
  const beto = await amb.novoCelular('Beto');

  await ana.colarLink(`https://youtu.be/${ID(1)}`);
  await ana.esperarEstado((s) => s.atual?.videoId === ID(1));
  await ana.colarLink(`https://youtu.be/${ID(2)}`);
  await ana.colarLink(`https://youtu.be/${ID(3)}`);
  await ana.esperarEstado((s) => s.fila.length === 2);

  // Beto fura duas vezes pela aba Link.
  await beto.aba('link');
  for (const n of [4, 5]) {
    await beto.page.getByTestId('link-input').fill(`https://youtu.be/${ID(n)}`);
    await beto.page.getByTestId('link-next').click();
    await beto.esperarEstado((s) => s.fila.length === 2 + (n - 3));
  }
  const s = await ana.esperarEstado((x) => x.fila.length === 4);
  assert.deepEqual(s.fila.map((i) => i.videoId), [ID(4), ID(5), ID(2), ID(3)]);
  assert.deepEqual(s.fila.map((i) => !!i.furou), [true, true, false, false]);

  // Selo na UI e "Passar pra frente" (MOVE) no último item.
  await ana.aba('fila');
  assert.equal(await ana.page.getByTestId('furou-badge').count(), 2);
  await ana.itensFila().nth(3).getByTestId('move-front-btn').click();
  const m = await ana.esperarEstado((x) => x.fila[0]?.videoId === ID(3));
  assert.deepEqual(m.fila.map((i) => i.videoId), [ID(3), ID(4), ID(5), ID(2)]);

  // `proximo` inválido é recusado.
  const cru = await beto.abrirCru({ pid: 'cru', nome: 'Cru' });
  await cru.enviar({ t: 'add', videoId: ID(6), proximo: 'sim' });
  const erro = await cru.esperar((x) => x.t === 'error');
  assert.equal(erro.codigo, 'msg_invalida');
  await cru.fechar();
}));
