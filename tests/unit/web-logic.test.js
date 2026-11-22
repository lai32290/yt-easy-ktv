import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHash, resolverSinalizacao, backoffDelay, podeRemover, podePular, textoErro,
  resultadoVale, normalizarState, idsNoEstado, normalizarResultados, erroSoDeSinalizacao,
} from '../../web/logic.js';
import { CONFIG, ERR, ERR_TEXT } from '../../web/protocol.js';

test('parseHash: sala simples', () => {
  assert.deepEqual(parseHash('#sala=abc-123'), { sala: 'abc-123', sig: null, secure: null });
});

test('parseHash: sem sala / vazio / inválida', () => {
  assert.equal(parseHash('').sala, '');
  assert.equal(parseHash('#').sala, '');
  assert.equal(parseHash('#sala=a<b>').sala, '');
  assert.equal(parseHash(undefined).sala, '');
});

test('parseHash: sig e secure', () => {
  assert.deepEqual(parseHash('#sala=x&sig=localhost:9000&secure=0'),
    { sala: 'x', sig: { host: 'localhost', port: 9000 }, secure: false });
  assert.deepEqual(parseHash('sala=x&sig=meu.host&secure=1'),
    { sala: 'x', sig: { host: 'meu.host', port: null }, secure: true });
  assert.equal(parseHash('#sala=x&sig=ruim host:1').sig, null);
  assert.equal(parseHash('#sala=x&sig=h:99999').sig, null);
});

test('resolverSinalizacao', () => {
  const base = CONFIG.SIGNALING;
  assert.deepEqual(resolverSinalizacao(parseHash('#sala=x'), base), base);
  assert.deepEqual(resolverSinalizacao(parseHash('#sala=x&sig=localhost:9000&secure=0'), base),
    { host: 'localhost', port: 9000, path: '/', secure: false });
  assert.deepEqual(resolverSinalizacao(parseHash('#sala=x&sig=localhost:9000'), base),
    { host: 'localhost', port: 9000, path: '/', secure: false });
  assert.deepEqual(resolverSinalizacao(parseHash('#sala=x&sig=ex.com'), base),
    { host: 'ex.com', port: 443, path: '/', secure: true });
  assert.equal(resolverSinalizacao(parseHash('#sala=x&secure=0'), base).secure, false);
});

test('backoffDelay: 1s até 15s', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 50].map((n) => backoffDelay(n)), [1000, 2000, 4000, 8000, 15000, 15000, 15000]);
});

test('podeRemover só para o dono', () => {
  assert.equal(podeRemover({ pid: 'a' }, 'a'), true);
  assert.equal(podeRemover({ pid: 'a' }, 'b'), false);
  assert.equal(podeRemover({ pid: '' }, ''), false);
  assert.equal(podeRemover(null, 'a'), false);
});

test('podePular segue a política', () => {
  assert.equal(podePular('todos'), true);
  assert.equal(podePular('anfitriao'), false);
});

test('textoErro: msg tem prioridade, senão tabela', () => {
  assert.equal(textoErro({ codigo: ERR.DUPLICADO, msg: 'Já tem!' }, ERR_TEXT), 'Já tem!');
  assert.equal(textoErro({ codigo: ERR.DUPLICADO, msg: '' }, ERR_TEXT), ERR_TEXT[ERR.DUPLICADO]);
  assert.match(textoErro({ codigo: 'zzz' }, ERR_TEXT), /Algo deu errado/);
  assert.match(textoErro(null, ERR_TEXT), /Algo deu errado/);
});

test('resultadoVale ignora respostas antigas', () => {
  assert.equal(resultadoVale({ id: 's2' }, 's2'), true);
  assert.equal(resultadoVale({ id: 's1' }, 's2'), false);
  assert.equal(resultadoVale({ id: 's1' }, null), false);
});

test('normalizarState e idsNoEstado', () => {
  const st = normalizarState({
    atual: { itemId: 1, videoId: 'AAAAAAAAAAA', titulo: 'T', pid: 'p' },
    fila: [{ videoId: 'BBBBBBBBBBB' }, 'lixo', null],
    tocando: 1,
  });
  assert.equal(st.tocando, true);
  assert.equal(st.fila.length, 1);
  assert.equal(st.atual.itemId, '1');
  assert.deepEqual([...idsNoEstado(st)].sort(), ['AAAAAAAAAAA', 'BBBBBBBBBBB']);
  assert.deepEqual(normalizarState(null), { atual: null, fila: [], tocando: false });
});

test('normalizarResultados descarta itens sem videoId', () => {
  const r = normalizarResultados([{ videoId: 'x', titulo: 'a' }, { titulo: 'sem' }, 5]);
  assert.equal(r.length, 1);
  assert.deepEqual(normalizarResultados('x'), []);
});

test('erroSoDeSinalizacao reconhece só erros do servidor de sinalização', () => {
  for (const t of ['network', 'socket-error', 'socket-closed', 'server-error']) assert.equal(erroSoDeSinalizacao(t), true);
  for (const t of ['peer-unavailable', 'webrtc', 'browser-incompatible', undefined]) assert.equal(erroSoDeSinalizacao(t), false);
});
