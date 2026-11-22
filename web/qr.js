// QR code da sala no site do celular (sem innerHTML: o SVG é montado com createElementNS).
import qrcode from './vendor/qrcode.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// Dados do QR: { tam, d } (d = caminho SVG dos módulos escuros) ou null se falhar.
export function qrDados(texto) {
  try {
    const qr = qrcode(0, 'M');
    qr.addData(texto);
    qr.make();
    const n = qr.getModuleCount();
    const margem = 2;
    let d = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + margem},${r + margem}h1v1h-1z`;
    }
    return { tam: n + margem * 2, d };
  } catch {
    return null;
  }
}

export function qrSvg({ tam, d }) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${tam} ${tam}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('aria-hidden', 'true');
  const fundo = document.createElementNS(SVG_NS, 'rect');
  fundo.setAttribute('width', String(tam));
  fundo.setAttribute('height', String(tam));
  fundo.setAttribute('fill', '#fff');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', d);
  p.setAttribute('fill', '#000');
  svg.append(fundo, p);
  return svg;
}
