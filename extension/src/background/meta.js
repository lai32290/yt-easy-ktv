// Metadados via oEmbed (sem chave de API). A duração não vem do oEmbed.

function erro(msg, codigo, extra = {}) {
  return Object.assign(new Error(msg), { codigo }, extra);
}

export async function oembed(videoId, fetchImpl = fetch) {
  const alvo = `https://www.youtube.com/watch?v=${videoId}`;
  const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(alvo)}&format=json`;
  let resp;
  try {
    resp = await fetchImpl(url);
  } catch (e) {
    throw erro(`oEmbed falhou: ${e.message}`, 'video_indisponivel', { rede: true });
  }
  if (!resp.ok) throw erro(`oEmbed HTTP ${resp.status}`, 'video_indisponivel', { status: resp.status });
  let j;
  try {
    j = await resp.json();
  } catch {
    throw erro('oEmbed devolveu JSON inválido', 'video_indisponivel');
  }
  if (!j || typeof j.title !== 'string' || !j.title) {
    throw erro('oEmbed sem título', 'video_indisponivel');
  }
  return { titulo: j.title, canal: typeof j.author_name === 'string' ? j.author_name : '', duracao: '' };
}
