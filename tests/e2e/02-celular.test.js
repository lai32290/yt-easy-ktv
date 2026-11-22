// Critério: "o celular conecta via #sala=, envia o nome e vê o state".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comAmbiente, ate } from './helpers/ambiente.js';

test('b) celular conecta por #sala=, informa o nome e recebe o state', { timeout: 120000 }, () => comAmbiente('celular', async (amb) => {
  await amb.prepararKtv({ iniciar: false });
  const cel = await amb.novoCelular('Carla', { abrir: false });
  await cel.abrir({ entrar: false });

  // Primeira visita: pede o nome antes de qualquer coisa.
  await cel.page.locator('#name-form').waitFor({ state: 'visible' });
  await cel.entrar();
  assert.equal(await cel.status(), 'conectado');

  const s = await cel.esperarEstado(() => true, { descricao: 'primeiro state' });
  assert.deepEqual(s, { atual: null, fila: [], tocando: false, player: { pausado: false, mudo: false, volume: 100 } });
  assert.match(await cel.page.locator('#now-playing').textContent(), /Nada tocando/);

  // O painel do KTV passa a contar 1 celular.
  await ate(async () => /1 celular conectado/.test((await amb.painel())?.conns || (await amb.ktv.locator('#ktv-root .status').textContent())),
    { descricao: 'painel mostra 1 celular' });

  // O nome informado aparece em quem pediu a música (prova que o hello chegou ao SW).
  await cel.colarLink('https://youtu.be/aaaaaaaaaa1');
  const s2 = await cel.esperarEstado((x) => x.fila.length === 1, { descricao: 'item adicionado' });
  assert.equal(s2.fila[0].pedidoPor, 'Carla');
  assert.match(await cel.itensFila().first().textContent(), /pedido por Carla/);
  const st = await amb.storage();
  assert.deepEqual(Object.values(st.ktv_rt.peers).map((p) => p.nome), ['Carla']);
}));

test('b) sem #sala= o site pede para escanear o QR', { timeout: 60000 }, () => comAmbiente('sem-sala', async (amb) => {
  const c = await amb.celBrowser.newContext();
  amb.celulares.push({ fechar: () => c.close() });
  const page = await c.newPage();
  await page.goto(amb.site.url);
  await page.getByTestId('no-room').waitFor({ state: 'visible' });
  assert.match(await page.getByTestId('no-room').textContent(), /Escaneie o QR code/);
}));

test('b) sala inexistente: o celular mostra erro pt-BR e oferece reconectar', { timeout: 90000 }, () => comAmbiente('sala-errada', async (amb) => {
  await amb.apontarSinalizacao();
  await amb.esperarSala();
  const cel = await amb.novoCelular('Dani', { abrir: false });
  await cel.abrir({ sala: 'sala-que-nao-existe', entrar: false });
  await cel.page.getByTestId('name-input').fill('Dani');
  await cel.page.getByTestId('name-submit').click();
  await cel.esperarStatus('erro', 30000);
  assert.match(await cel.page.locator('#status-detail').textContent(), /Sala não encontrada/);
  assert.ok(await cel.page.getByTestId('reconnect-btn').isVisible());
}));
