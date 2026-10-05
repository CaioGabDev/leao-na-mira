// ============================================================================
// O FUNDO DO MURAL, DO LADO DO NAVEGADOR
// ----------------------------------------------------------------------------
// Duas telas mexem na mesma foto: o mural (onde se vê o resultado) e a tela de
// aparência (onde mora o resto da cara da live). A UI de cada uma é diferente,
// mas REDUZIR e ENVIAR tem que ser igual nas duas — se cada página tivesse a
// sua conta, a mesma foto sairia com qualidade diferente dependendo de onde
// foi escolhida, e isso é o tipo de diferença que ninguém encontra depois.
// ============================================================================
(function (raiz) {
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

  // ==========================================================================
  // A COR QUE O FUNDO DO POSTER PUXA DA FOTO
  // --------------------------------------------------------------------------
  // A arte do streamer pode ser azul, roxa, verde. A base do poster era #000
  // cravado, então arte colorida em cima e preto puro embaixo pareciam duas
  // peças coladas, com a emenda à mostra.
  //
  // O que resolve não é escolher "uma cor bonita": é amostrar A BORDA DE BAIXO
  // da foto -- o pixel que encosta no corte -- e continuar ela pra baixo,
  // escurecendo. A emenda some porque os dois lados saem do mesmo pixel.
  //
  // Aqui mora só a conta: entram os pixels, saem as cores. Quem mede a área e
  // desenha no canvas é o mural, que é quem tem a tela.
  // ==========================================================================

  function rgbParaHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const l = (mx + mn) / 2;
    if (mx === mn) return [0, 0, l * 100];
    const d = mx - mn;
    const sat = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    let h;
    if (mx === r)      h = ((g - b) / d + (g < b ? 6 : 0));
    else if (mx === g) h = ((b - r) / d + 2);
    else               h = ((r - g) / d + 4);
    return [h * 60, sat * 100, l * 100];
  }

  // Forma com vírgula de propósito: é a que o parser do html2canvas lê com
  // certeza, e o PNG baixado é o produto -- cor que ele não entende vira preto.
  function hsl(h, s, l) {
    return 'hsl(' + h.toFixed(0) + ', ' + s.toFixed(0) + '%, ' + l.toFixed(0) + '%)';
  }

  // Abaixo deste piso de saturação a foto é cinza/preta, e inventar matiz onde
  // não tem deixa o poster com um tom sujo que não está na arte nenhuma.
  const SAT_MINIMA = 8;
  // ONDE A COR DA FOTO PODE APARECER, E ONDE NÃO PODE.
  //
  // Primeira tentativa: pintar o poster inteiro com o matiz da foto. Deu certo
  // numa arte azul e ficou LAMA numa arte quente — porque aí o fundo virou o
  // mesmo tom do laranja das pílulas, e um poster de um tom só não tem o que
  // saltar. O preto que estava lá antes era neutro, e neutro deixa a cor
  // aparecer no que importa: a foto, os níveis, os tipos.
  //
  // Então a cor faz só o trabalho que justificou ela existir — matar a emenda
  // embaixo da foto — e morre em poucos por cento:
  //
  //   EMENDA (`base`)  cor de verdade, mas só na faixa colada na foto
  //   CORPO  (`base2`) quase preto, com um sopro do matiz
  //   PÍLULA           cinza-escuro do matiz, nunca o matiz cheio: é ela que
  //                    precisa deixar o laranja/azul/roxo do tipo saltar
  const SAT_TETO_BASE = 34;
  const LUZ_BASE = 12;
  const SAT_TETO_BASE_2 = 12, LUZ_BASE_2 = 4;
  const SAT_TETO_PILULA = 14;
  const LUZ_PILULA = 11, LUZ_PILULA_2 = 8;

  // `dados` é o RGBA de um recorte da foto JÁ do jeito que ela aparece na tela.
  // Devolve null quando não há cor pra puxar -- e null quer dizer "deixa como
  // estava", não "pinta de cinza".
  function coresDoPoster(dados, L, A) {
    if (!dados || !L || !A) return null;

    // A BORDA: as três últimas linhas do que aparece. É o pixel que encosta no
    // corte, e é dele que a base tem que sair.
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = Math.max(0, A - 3); y < A; y++) {
      for (let x = 0; x < L; x++) {
        const i = (y * L + x) * 4;
        r += dados[i]; g += dados[i + 1]; b += dados[i + 2]; n++;
      }
    }
    if (!n) return null;
    const borda = rgbParaHsl(r / n, g / n, b / n);
    if (borda[1] < SAT_MINIMA) return null;

    const satPilula = Math.min(borda[1], SAT_TETO_PILULA);
    const cores = {
      base:  hsl(borda[0], Math.min(borda[1], SAT_TETO_BASE), LUZ_BASE),
      base2: hsl(borda[0], Math.min(borda[1], SAT_TETO_BASE_2), LUZ_BASE_2),
      pilula:  hsl(borda[0], satPilula, LUZ_PILULA),
      pilula2: hsl(borda[0], satPilula, LUZ_PILULA_2)
    };

    // O ACENTO pras brasinhas: o pixel mais vivo da foto, não o mais escuro nem
    // o estourado -- faísca laranja numa arte azul destoa.
    let melhor = null, nota = -1;
    for (let i = 0; i < dados.length; i += 4) {
      const c = rgbParaHsl(dados[i], dados[i + 1], dados[i + 2]);
      if (c[2] < 25 || c[2] > 85 || c[1] < 25) continue;
      const q = c[1] * (1 - Math.abs(c[2] - 58) / 58);
      if (q > nota) { nota = q; melhor = c; }
    }
    if (melhor) {
      cores.brasa = hsl(melhor[0], Math.max(60, melhor[1]), 58);
      cores.brasaClara = hsl(melhor[0], Math.max(45, melhor[1] * 0.7), 85);
    }
    return cores;
  }

  const api = {
    ROTA, LADO_MAX, reduzir, enviar, remover, info, url, kb,
    coresDoPoster, rgbParaHsl, hsl,
    SAT_MINIMA, SAT_TETO_BASE, SAT_TETO_BASE_2, SAT_TETO_PILULA,
    LUZ_BASE, LUZ_BASE_2, LUZ_PILULA
  };
  raiz.Fundo = api;
  // o teste roda isto no Node, onde não existe `window`
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
