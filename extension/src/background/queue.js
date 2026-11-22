// Fila do KTV: lógica pura e imutável (sem Chrome). Toda função devolve { estado, erro? }.
// Estado: { roomId, fila: Item[], atual: Item|null, tocando: boolean }.
import { ERR } from '../shared/protocol.js';

export function criarEstado(parcial = {}) {
  return {
    roomId: typeof parcial.roomId === 'string' ? parcial.roomId : null,
    fila: Array.isArray(parcial.fila) ? parcial.fila.slice() : [],
    atual: parcial.atual && typeof parcial.atual === 'object' ? parcial.atual : null,
    tocando: Boolean(parcial.tocando && parcial.atual),
  };
}

const falha = (estado, erro) => ({ estado, erro });

// Adiciona ao fim da fila. O mesmo videoId pode entrar mais de uma vez (cada item tem seu itemId).
export function enqueue(estado, item) {
  return { estado: { ...estado, fila: [...estado.fila, item] } };
}

// Só o dono (mesmo pid) remove o item. A música atual não está na fila (use skip).
export function remove(estado, itemId, pid) {
  const idx = estado.fila.findIndex((i) => i.itemId === itemId);
  if (idx < 0) return falha(estado, ERR.NAO_ENCONTRADO);
  const item = estado.fila[idx];
  if (!pid || item.pid !== pid) return falha(estado, ERR.SEM_PERMISSAO);
  return { estado: { ...estado, fila: estado.fila.filter((_, i) => i !== idx) } };
}

// O próximo da fila vira `atual`; fila vazia deixa tudo ocioso.
export function avancar(estado) {
  if (estado.fila.length === 0) return { estado: { ...estado, atual: null, tocando: false } };
  const [proximo, ...resto] = estado.fila;
  return { estado: { ...estado, atual: proximo, fila: resto, tocando: true } };
}

// Reordena dentro da fila; toIndex é limitado aos extremos.
export function mover(estado, itemId, toIndex) {
  const idx = estado.fila.findIndex((i) => i.itemId === itemId);
  if (idx < 0) return falha(estado, ERR.NAO_ENCONTRADO);
  if (!Number.isInteger(toIndex)) return falha(estado, ERR.MSG_INVALIDA);
  const destino = Math.max(0, Math.min(estado.fila.length - 1, toIndex));
  const fila = estado.fila.slice();
  const [item] = fila.splice(idx, 1);
  fila.splice(destino, 0, item);
  return { estado: { ...estado, fila } };
}

// Payload da mensagem `state` enviada aos celulares.
export function publico(estado) {
  return { atual: estado.atual, fila: estado.fila, tocando: estado.tocando };
}
