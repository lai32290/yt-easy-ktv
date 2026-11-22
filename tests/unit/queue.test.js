import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  criarEstado, enqueue, remove, avancar, mover, publico,
} from '../../extension/src/background/queue.js';

const item = (n, pid = 'p1') => ({
  itemId: `i${n}`, videoId: `video${String(n).padStart(6, '0')}`, titulo: `T${n}`, canal: 'C', duracao: '3:00',
  pedidoPor: 'Ana', pid, addedAt: n,
});

test('criarEstado: vazio por padrão', () => {
  assert.deepEqual(criarEstado(), { roomId: null, fila: [], atual: null, tocando: false });
});

test('enqueue: adiciona sem mutar o estado original', () => {
  const e0 = criarEstado();
  const { estado, erro } = enqueue(e0, item(1));
  assert.equal(erro, undefined);
  assert.equal(estado.fila.length, 1);
  assert.equal(e0.fila.length, 0);
});

test('enqueue: bloqueia videoId já na fila', () => {
  let { estado } = enqueue(criarEstado(), item(1));
  const r = enqueue(estado, { ...item(2), videoId: item(1).videoId });
  assert.equal(r.erro, 'duplicado');
  assert.equal(r.estado.fila.length, 1);
});

test('enqueue: bloqueia videoId igual ao atual', () => {
  const e = { ...criarEstado(), atual: item(1), tocando: true };
  assert.equal(enqueue(e, { ...item(2), videoId: item(1).videoId }).erro, 'duplicado');
});

test('remove: dono remove o próprio item', () => {
  const { estado } = enqueue(criarEstado(), item(1, 'dono'));
  const r = remove(estado, 'i1', 'dono');
  assert.equal(r.erro, undefined);
  assert.equal(r.estado.fila.length, 0);
});

test('remove: não-dono recebe sem_permissao e nada muda', () => {
  const { estado } = enqueue(criarEstado(), item(1, 'dono'));
  const r = remove(estado, 'i1', 'outro');
  assert.equal(r.erro, 'sem_permissao');
  assert.equal(r.estado.fila.length, 1);
  assert.equal(remove(estado, 'i1', undefined).erro, 'sem_permissao');
});

test('remove: item inexistente -> nao_encontrado', () => {
  assert.equal(remove(criarEstado(), 'zzz', 'p1').erro, 'nao_encontrado');
});

test('avancar: próximo vira atual e tocando=true', () => {
  let e = criarEstado();
  e = enqueue(e, item(1)).estado;
  e = enqueue(e, item(2)).estado;
  e = avancar(e).estado;
  assert.equal(e.atual.itemId, 'i1');
  assert.equal(e.tocando, true);
  assert.deepEqual(e.fila.map((i) => i.itemId), ['i2']);
});

test('avancar: fila vazia deixa atual null e tocando=false', () => {
  let e = { ...criarEstado(), atual: item(1), tocando: true };
  e = avancar(e).estado;
  assert.equal(e.atual, null);
  assert.equal(e.tocando, false);
});

test('mover: reordena e limita o índice', () => {
  let e = criarEstado();
  for (const n of [1, 2, 3]) e = enqueue(e, item(n)).estado;
  e = mover(e, 'i3', 0).estado;
  assert.deepEqual(e.fila.map((i) => i.itemId), ['i3', 'i1', 'i2']);
  e = mover(e, 'i3', 99).estado;
  assert.deepEqual(e.fila.map((i) => i.itemId), ['i1', 'i2', 'i3']);
  e = mover(e, 'i1', -5).estado;
  assert.deepEqual(e.fila.map((i) => i.itemId), ['i1', 'i2', 'i3']);
});

test('mover: erros', () => {
  const { estado } = enqueue(criarEstado(), item(1));
  assert.equal(mover(estado, 'x', 0).erro, 'nao_encontrado');
  assert.equal(mover(estado, 'i1', 'a').erro, 'msg_invalida');
});

test('publico: só atual, fila e tocando', () => {
  const e = { roomId: 'abc', fila: [item(1)], atual: null, tocando: false };
  assert.deepEqual(publico(e), { atual: null, fila: [item(1)], tocando: false });
});
