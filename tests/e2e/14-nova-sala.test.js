// Nova sala: troca o ID, derruba quem estava, o link antigo não entra mais; a fila é mantida.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comAmbiente, ate } from './helpers/ambiente.js';

const ID = (n) => `hhhhhhhhhh${n}`;

test('nova sala: segundo toque troca o ID, o celular antigo cai, o link antigo não conecta e a fila fica', { timeout: 180000 }, () => comAmbiente('novasala', async (amb) => {
  await amb.prepararKtv({ iniciar: true });
  const ana = await amb.novoCelular('Ana');
  amb.yt.duracao = 60;
  await ana.colarLink(`https://youtu.be/${ID(1)}`);
  await ana.colarLink(`https://youtu.be/${ID(2)}`);
  await ana.esperarEstado((s) => s.atual?.videoId === ID(1) && s.fila.length === 1);
  const salaAntiga = (await amb.storage()).ktv_state.roomId;

  const btn = amb.ktv.locator('#ktv-root .tocando .btn-nova-sala');
  await btn.click();                                   // 1º toque só arma
  assert.match(await btn.textContent(), /de novo/);
  assert.equal((await amb.storage()).ktv_state.roomId, salaAntiga);
  await btn.click();                                   // 2º toque troca

  await ate(async () => {
    const r = (await amb.storage()).ktv_state.roomId;
    return r && r !== salaAntiga;
  }, { timeout: 30000, descricao: 'roomId novo' });
  const st = (await amb.storage()).ktv_state;
  assert.equal(st.fila.length, 1, 'a fila é mantida');
  assert.equal(st.atual.videoId, ID(1));

  // O celular antigo foi derrubado e não volta (a sala antiga não existe mais).
  await ate(async () => (await ana.status()) !== 'conectado', { timeout: 30000, descricao: 'Ana desconectada' });
  const velho = await amb.novoCelular('Visita', { abrir: false });
  await velho.abrir({ sala: salaAntiga, entrar: false });
  await new Promise((r) => setTimeout(r, 8000));
  assert.notEqual(await velho.status(), 'conectado', 'link antigo não pode conectar');

  // Link novo conecta e vê a fila mantida.
  const novo = await amb.novoCelular('Beto', { abrir: false });
  await novo.abrir({ sala: st.roomId });
  const s = await novo.esperarEstado((x) => x.fila.length === 1);
  assert.equal(s.fila[0].videoId, ID(2));
}));
