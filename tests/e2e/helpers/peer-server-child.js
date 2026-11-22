// Processo filho: roda o servidor PeerJS local. Matar o processo = derrubar a sinalização
// (o PeerServer mantém timers que nunca param, então não dá para rodá-lo no processo do teste).
import { PeerServer } from 'peer';

const port = Number(process.argv[2]);
PeerServer({ host: '127.0.0.1', port, path: '/', alive_timeout: 60000 }, () => {
  process.send?.('pronto');
});
process.on('disconnect', () => process.exit(0)); // pai morreu
