// ============================================================================
// O FUNDO DO MURAL, DO LADO DO NAVEGADOR
// ----------------------------------------------------------------------------
// Duas telas mexem na mesma foto: o mural (onde se vê o resultado) e a tela de
// aparência (onde mora o resto da cara da live). A UI de cada uma é diferente,
// mas REDUZIR e ENVIAR tem que ser igual nas duas — se cada página tivesse a
// sua conta, a mesma foto sairia com qualidade diferente dependendo de onde
// foi escolhida, e isso é o tipo de diferença que ninguém encontra depois.
// ============================================================================
window.Fundo = (function () {
  'use strict';

  const ROTA = '/api/fundo';

  // Arquivo que já é pequeno sobe como está: recomprimir de graça só perde
  // qualidade. O resto cai pra 1600px no lado maior — o poster tem ~400px na
  // tela e sai em 1080px no PNG, então o que passa disso é peso puro (upload
  // lento no 4G do streamer, disco gasto, decode mais pesado na hora de gerar).
  const SOBE_COMO_ESTA = 900 * 1024;
  const LADO_MAX = 1600;
  const QUALIDADE = 0.92;

  async function reduzir(file) {
    if (!file || file.size <= SOBE_COMO_ESTA || !window.createImageBitmap) return file;
    try {
      // from-image respeita o EXIF: sem isso, foto tirada de lado sobe de lado
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const maior = Math.max(bitmap.width, bitmap.height);
      if (maior <= LADO_MAX) { if (bitmap.close) bitmap.close(); return file; }

      const escala = LADO_MAX / maior;
      const tela = document.createElement('canvas');
      tela.width  = Math.round(bitmap.width  * escala);
      tela.height = Math.round(bitmap.height * escala);
      tela.getContext('2d').drawImage(bitmap, 0, 0, tela.width, tela.height);
      if (bitmap.close) bitmap.close();

      const blob = await new Promise(r => tela.toBlob(r, 'image/jpeg', QUALIDADE));
      // se a conta não fechou (ficou maior que o original), manda o original
      return (blob && blob.size < file.size) ? blob : file;
    } catch (e) {
      return file;   // navegador que não topou: o servidor aceita o original
    }
  }

  // `dono` só vai quando quem está mexendo é o administrador numa live que não
  // é a dele; pro streamer a rota resolve pela sessão e o parâmetro nem existe.
  function comDono(dono) {
    return dono ? ROTA + '?dono=' + encodeURIComponent(dono) : ROTA;
  }

  async function enviar(file, dono) {
    const corpo = await reduzir(file);
    const res = await fetch(comDono(dono), {
      method: 'POST',
      headers: { 'Content-Type': corpo.type || 'application/octet-stream' },
      body: corpo
    });
    const dados = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(dados.error || 'Não deu pra enviar a imagem.');
    return dados;
  }

  async function remover(dono) {
    const res = await fetch(comDono(dono), { method: 'DELETE' });
    const dados = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(dados.error || 'Não deu pra tirar a foto.');
    return dados;
  }

  async function info(dono) {
    const res = await fetch(dono ? '/api/fundo/info?dono=' + encodeURIComponent(dono)
                                 : '/api/fundo/info');
    if (!res.ok) throw new Error('Não deu pra ler o estado do fundo.');
    return res.json();
  }

  // Endereço da imagem pra exibir. `versao` entra depois de uma troca: na carga
  // normal a URL é fixa e o ETag do servidor resolve (304 quando não mudou).
  function url(dono, versao) {
    const base = comDono(dono);
    if (!versao) return base;
    return base + (base.includes('?') ? '&' : '?') + 'v=' + versao;
  }

  function kb(bytes) { return Math.round((bytes || 0) / 1024) + 'KB'; }

  return { ROTA, LADO_MAX, reduzir, enviar, remover, info, url, kb };
})();
