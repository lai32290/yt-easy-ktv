// Critério: "celular desconectado reconecta sem novo QR enquanto a sala existir".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comAmbiente, ate } from './helpers/ambiente.js';

const ID = (n) => `gggggggggg${n}`;
const statusOcioso = (amb) => amb.ktv.locator('#ktv-root .status').textContent();

test('h) celular fecha a página e reabre o mesmo link: reconecta sem novo QR, com nome e identidade preservados', { timeout: 150000 }, () => comAmbiente('reabrir', async (amb) => {
  await amb.prepararKtv({ iniciar: false });
  const ana = await amb.novoCelular('Ana');
  await ana.colarLink(`https://youtu.be/${ID(1)}`);
  const antes = await ana.esperarEstado((s) => s.fila.length === 1);
  await ate(async () => /1 celular conectado/.test(await statusOcioso(amb)), { descricao: 'painel: 1 celular' });
  const urlCelular = ana.page.url(); // o mesmo hash #sala=...

  await ana.page.close(); // celular "desligou a tela"/fechou a aba
  await ate(async () => /Nenhum celular conectado/.test(await statusOcioso(amb)), { timeout: 30000, descricao: 'painel: nenhum celular' });
  const roomAntes = (await amb.storage()).ktv_state.roomId;

  // Reabre com o MESMO link (sem novo QR).
  const page = await ana.context.newPage();
  ana.page = page;
  await page.goto(urlCelular);
  await ana.esperarStatus('conectado', 40000);
  assert.equal(await page.locator('#name-form').isVisible(), false, 'não deveria pedir o nome de novo');
  const depois = await ana.esperarEstado((s) => s.fila.length === 1, { descricao: 'state recebido de novo' });
  assert.equal(depois.fila[0].itemId, antes.fila[0].itemId);
  assert.equal((await amb.storage()).ktv_state.roomId, roomAntes, 'a sala não pode mudar');
  await ate(async () => /1 celular conectado/.test(await statusOcioso(amb)), { descricao: 'painel: 1 celular de novo' });

  // A identidade (pid) sobreviveu: ainda pode remover o próprio item.
  assert.equal(await ana.itensFila().first().getByTestId('remove-btn').count(), 1);
  await ana.itensFila().first().getByTestId('remove-btn').click();
  await ana.esperarEstado((s) => s.fila.length === 0);
}));

test('h) conexão P2P derrubada com o site aberto: o site reconecta sozinho, sem novo QR', { timeout: 150000 }, () => comAmbiente('derrubar', async (amb) => {
  await amb.prepararKtv({ iniciar: false });
  const ana = await amb.novoCelular('Ana');
  await ana.colarLink(`https://youtu.be/${ID(1)}`);
  const antes = await ana.esperarEstado((s) => s.fila.length === 1);
  const roomAntes = (await amb.storage()).ktv_state.roomId;

  // Derruba o canal de dados pelo lado do celular (como perder a rede/trocar de Wi-Fi).
  await ana.page.evaluate(() => { for (const pc of window.__pcs) pc.close(); });
  await ana.esperarStatus('desconectado', 20000);
  assert.ok(await ana.page.getByTestId('reconnect-btn').isVisible(), 'botão Reconectar deveria aparecer');
  assert.match(await ana.page.locator('#status-detail').textContent(), /A conexão com o KTV caiu\./);

  // Reconexão automática (backoff de 1s): mesmo link, mesma sala, sem QR.
  await ana.esperarStatus('conectado', 40000);
  const depois = await ana.esperarEstado((s) => s.fila.length === 1);
  assert.equal(depois.fila[0].itemId, antes.fila[0].itemId);
  assert.equal((await amb.storage()).ktv_state.roomId, roomAntes);
  // pedidos voltam a funcionar
  await ana.colarLink(`https://youtu.be/${ID(2)}`);
  await ana.esperarEstado((s) => s.fila.length === 2);
}));

test('h) queda e volta do servidor de sinalização: quem já está conectado segue; novos celulares entram quando ele volta', { timeout: 240000 }, () => comAmbiente('sinalizacao', async (amb) => {
  await amb.prepararKtv({ iniciar: false });
  const roomAntes = amb.roomId;
  const ana = await amb.novoCelular('Ana');
  await ana.colarLink(`https://youtu.be/${ID(1)}`);
  await ana.esperarEstado((s) => s.fila.length === 1);

  await amb.sinal.parar(); // servidor de sinalização cai
  await ate(async () => (await amb.storage()).ktv_rt?.conns?.signaling === false, { timeout: 40000, descricao: 'SW sabe que a sinalização caiu' });
  await ate(async () => /sem conex/i.test((await amb.ktv.locator('#ktv-root .aviso').first().textContent()) || ''), { timeout: 10000, descricao: 'painel avisa "Sem conexão com o servidor"' });

  // A conexão P2P já aberta independe da sinalização: Ana continua pedindo músicas.
  assert.equal(await ana.status(), 'conectado');
  await ana.colarLink(`https://youtu.be/${ID(2)}`);
  await ana.esperarEstado((s) => s.fila.length === 2, { descricao: 'pedido durante a queda' });

  // Um celular que abre durante a queda não conecta, mostra o motivo e fica tentando (backoff).
  const bia = await amb.novoCelular('Bia', { abrir: false });
  await bia.abrir({ entrar: false });
  await bia.page.getByTestId('name-input').fill('Bia');
  await bia.page.getByTestId('name-submit').click();
  await bia.esperarStatus('erro', 40000);
  assert.match(await bia.page.locator('#status-detail').textContent(), /servidor de conexão|Nova tentativa/);

  await amb.sinal.iniciar(); // servidor volta
  await ate(async () => (await amb.storage()).ktv_rt?.conns?.signaling === true, { timeout: 90000, descricao: 'sinalização restabelecida (offscreen reconectou)' });
  assert.equal((await amb.storage()).ktv_state.roomId, roomAntes, 'a sala mudou depois da queda');
  await bia.esperarStatus('conectado', 90000); // reconexão automática do site, sem recarregar
  const s = await bia.esperarEstado((x) => x.fila.length === 2);
  assert.deepEqual(s.fila.map((i) => i.videoId), [ID(1), ID(2)]);
  assert.equal(await ana.status(), 'conectado');
}));
