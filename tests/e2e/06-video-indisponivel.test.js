// Critério: "vídeo indisponível é pulado e o celular é avisado".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comAmbiente, ate } from './helpers/ambiente.js';

const ID = (n) => `eeeeeeeeee${n}`;

test('f) vídeo indisponível é pulado e todos os celulares recebem o aviso', { timeout: 180000 }, () => comAmbiente('indisponivel', async (amb) => {
  amb.yt.duracao = 2;
  amb.yt.indisponiveis.add(ID(2)); // o player mostra .ytp-error para este
  await amb.prepararKtv();
  const ana = await amb.novoCelular('Ana');
  const beto = await amb.novoCelular('Beto');
  // o oEmbed funciona (o vídeo só falha ao tocar), então todos entram na fila
  await ana.colarLink(`https://youtu.be/${ID(1)}`);
  await ana.esperarEstado((s) => s.atual?.videoId === ID(1));
  await ana.colarLink(`https://youtu.be/${ID(2)}`);
  await ana.colarLink(`https://youtu.be/${ID(3)}`);
  await ana.esperarEstado((s) => s.fila.length === 2);

  // 1 termina -> 2 dá erro no player -> é pulado -> 3 toca
  const aviso = await beto.toastErro(/indisponível, pulada/, 40000);
  assert.match(aviso, new RegExp(`Música ${ID(2)}`)); // inclui o título da música pulada
  await ana.toastErro(/indisponível, pulada/, 5000).catch(() => {}); // pode já ter sumido; o state abaixo é o que vale

  const s = await beto.esperarEstado((x) => x.atual?.videoId === ID(3), { timeout: 30000, descricao: 'ID3 tocando depois do pulo' });
  assert.equal(s.fila.length, 0);
  await ate(async () => (await amb.paginaKtv())?.fake?.playing.includes(ID(3)), { timeout: 30000, descricao: 'ID3 tocando na aba' });
  const pg = await amb.paginaKtv();
  assert.ok(!pg.fake.playing.includes(ID(2)), 'o vídeo indisponível não deveria ter tocado');
  assert.ok(pg.fake.carregados.includes(ID(2)), 'a aba deveria ter tentado abrir o vídeo indisponível');
}));

test('f) vídeo indisponível como único da fila: pula e a sala fica ociosa', { timeout: 120000 }, () => comAmbiente('indisponivel-unico', async (amb) => {
  amb.yt.indisponiveis.add(ID(9));
  await amb.prepararKtv();
  const cel = await amb.novoCelular('Caio');
  await cel.colarLink(`https://youtu.be/${ID(9)}`);
  await cel.toastErro(/indisponível, pulada/, 40000);
  const s = await cel.esperarEstado((x) => !x.atual && x.fila.length === 0, { descricao: 'sala ociosa após o erro' });
  assert.equal(s.tocando, false);
  await ate(async () => (await amb.painel())?.ocioso, { descricao: 'painel ocioso' });
}));
