// Critério: "dois ou mais celulares veem a mesma fila em tempo real"; dono remove; pular funciona.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comAmbiente, ate } from './helpers/ambiente.js';
import { ERR_TEXT } from '../../extension/src/shared/protocol.js';

const ID = (n) => `cccccccccc${n}`;

test('d) dois celulares veem a mesma fila em tempo real; só o dono remove o próprio item', { timeout: 150000 }, () => comAmbiente('multi', async (amb) => {
  await amb.prepararKtv({ iniciar: false });
  const ana = await amb.novoCelular('Ana');
  const beto = await amb.novoCelular('Beto');

  await ate(async () => /2 celulares conectados/.test((await amb.painel())?.conns || ''), { descricao: 'painel mostra 2 celulares' }).catch(async () => {
    // fila vazia mostra o texto no modo ocioso (.status)
    assert.match(await amb.ktv.locator('#ktv-root .status').textContent(), /2 celulares conectados/);
  });

  // Ana adiciona; Beto vê sem fazer nada (tempo real).
  await ana.colarLink(`https://youtu.be/${ID(1)}`);
  const visto = await beto.esperarEstado((s) => s.fila.length === 1, { descricao: 'Beto vê o item da Ana' });
  assert.equal(visto.fila[0].pedidoPor, 'Ana');
  // Beto adiciona; Ana vê.
  await beto.colarLink(`https://youtu.be/${ID(2)}`);
  await ana.esperarEstado((s) => s.fila.length === 2, { descricao: 'Ana vê o item do Beto' });

  const sa = await ana.estado(); const sb = await beto.estado();
  assert.deepEqual(sa, sb, 'os dois celulares devem ver exatamente o mesmo state');
  assert.deepEqual(sa.fila.map((i) => i.pedidoPor), ['Ana', 'Beto']);

  // Botão "Remover" só aparece nos itens do próprio celular.
  await ana.aba('fila'); await beto.aba('fila');
  assert.equal(await ana.page.getByTestId('remove-btn').count(), 1);
  assert.equal(await beto.page.getByTestId('remove-btn').count(), 1);
  assert.equal(await ana.itensFila().nth(0).getByTestId('remove-btn').count(), 1);
  assert.equal(await ana.itensFila().nth(1).getByTestId('remove-btn').count(), 0);
  assert.equal(await beto.itensFila().nth(0).getByTestId('remove-btn').count(), 0);

  // Mesmo forçando a mensagem (cliente cru com outro pid), o SW recusa remover o item alheio.
  const intruso = await beto.abrirCru({ pid: 'intruso', nome: 'Intruso' });
  await intruso.enviar({ t: 'remove', itemId: sa.fila[0].itemId });
  const erro = await intruso.esperar((m) => m.t === 'error');
  assert.equal(erro.codigo, 'sem_permissao');
  assert.equal(erro.msg, ERR_TEXT.sem_permissao);
  assert.equal((await ana.estado()).fila.length, 2);
  await intruso.fechar();

  // Dono remove o próprio: os dois celulares e o storage refletem.
  await ana.itensFila().nth(0).getByTestId('remove-btn').click();
  await ana.esperarEstado((s) => s.fila.length === 1);
  const sb2 = await beto.esperarEstado((s) => s.fila.length === 1, { descricao: 'Beto vê a remoção' });
  assert.equal(sb2.fila[0].pedidoPor, 'Beto');
  const st = await amb.esperarFila((e) => e.fila.length === 1);
  assert.equal(st.fila[0].videoId, ID(2));
}));

test('d) pular a música atual avança a fila para todos e a aba KTV troca de vídeo', { timeout: 150000 }, () => comAmbiente('pular', async (amb) => {
  amb.yt.duracao = 20; // longa: só termina se for pulada
  await amb.prepararKtv({ iniciar: true });
  const ana = await amb.novoCelular('Ana');
  const beto = await amb.novoCelular('Beto');

  await ana.colarLink(`https://youtu.be/${ID(1)}`);
  await ana.esperarEstado((s) => s.atual?.videoId === ID(1), { descricao: 'ID1 tocando' });
  await ate(async () => (await amb.paginaKtv())?.fake?.playing.includes(ID(1)), { descricao: 'ID1 tocando na aba' });
  await beto.colarLink(`https://youtu.be/${ID(2)}`);
  await beto.esperarEstado((s) => s.fila.length === 1);
  await ana.colarLink(`https://youtu.be/${ID(3)}`);
  await beto.esperarEstado((s) => s.fila.length === 2);

  // O Beto (não dono da música atual) pode pular: política 'todos'.
  await beto.pular();
  for (const c of [ana, beto]) {
    const s = await c.esperarEstado((x) => x.atual?.videoId === ID(2), { descricao: `${c.nome} vê ID2 tocando` });
    assert.deepEqual(s.fila.map((i) => i.videoId), [ID(3)]);
  }
  await ate(async () => (await amb.paginaKtv())?.videoId === ID(2), { descricao: 'aba KTV foi para ID2' });
  await ate(async () => (await amb.paginaKtv())?.fake?.playing.includes(ID(2)), { descricao: 'ID2 tocando' });

  // Pular de novo: ID3; e pular a última deixa a sala ociosa.
  await ana.pular();
  await beto.esperarEstado((x) => x.atual?.videoId === ID(3) && x.fila.length === 0);
  await ate(async () => (await amb.paginaKtv())?.fake?.playing.includes(ID(3)), { descricao: 'ID3 tocando' });
  await beto.pular();
  const ocioso = await ana.esperarEstado((x) => !x.atual && x.fila.length === 0, { descricao: 'sala ociosa' });
  assert.equal(ocioso.tocando, false);
  await ate(async () => (await amb.painel())?.ocioso, { descricao: 'painel ocioso com QR grande' });
}));
