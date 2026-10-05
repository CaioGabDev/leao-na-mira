// ============================================================================
// A COR QUE O FUNDO DO POSTER PUXA DA FOTO
// ----------------------------------------------------------------------------
// O print que originou isto: arte azul da "Tropa dos Macacos" em cima, preto
// cravado embaixo. Duas peças coladas, emenda à mostra.
//
// O que este teste protege não é "ficou bonito" — é o conjunto de decisões que
// separa "o fundo puxou a cor da arte" de "o poster ficou com um tom sujo":
//
//   - a cor sai da BORDA DE BAIXO do que aparece, não da foto inteira;
//   - foto cinza NÃO vira cor (inventar matiz onde não tem é pior que preto);
//   - a base entra escura e dessaturada, senão o nome de quem está na lista
//     briga com ela pra ser lido;
//   - a cor sai em `hsl(h, s%, l%)` com vírgula, que é a forma que o parser do
//     html2canvas lê — o PNG baixado é o produto.
//
// Roda com:  node teste/fundo-cores.js
const path = require('path');
const Fundo = require(path.join(__dirname, '..', 'public', 'assets', 'fundo.js'));

let falhas = 0;
const ok = (c, m, e) => {
  console.log((c ? '  OK  ' : '  FALHA') + '  ' + m + (e !== undefined ? '  -> ' + e : ''));
  if (!c) falhas++;
};

// monta um recorte RGBA: `pinta(x, y)` devolve [r,g,b] pra cada pixel
function recorte(L, A, pinta) {
  const d = new Uint8ClampedArray(L * A * 4);
  for (let y = 0; y < A; y++) {
    for (let x = 0; x < L; x++) {
      const [r, g, b] = pinta(x, y);
      const i = (y * L + x) * 4;
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
    }
  }
  return d;
}
const partesHsl = s => {
  const m = /^hsl\((-?[\d.]+), ([\d.]+)%, ([\d.]+)%\)$/.exec(s);
  return m ? { h: +m[1], s: +m[2], l: +m[3] } : null;
};

const L = 40, A = 42;

console.log('=== a conversao pra HSL ===');
{
  ok(Fundo.rgbParaHsl(255, 0, 0)[0] === 0, 'vermelho no zero');
  const verde = Fundo.rgbParaHsl(0, 255, 0);
  ok(Math.round(verde[0]) === 120, 'verde em 120', Math.round(verde[0]));
  const azul = Fundo.rgbParaHsl(0, 0, 255);
  ok(Math.round(azul[0]) === 240, 'azul em 240', Math.round(azul[0]));
  ok(Fundo.rgbParaHsl(128, 128, 128)[1] === 0, 'cinza nao tem saturacao');
  ok(Fundo.rgbParaHsl(0, 0, 0)[2] === 0, 'preto sem luz');
  ok(Fundo.rgbParaHsl(255, 255, 255)[2] === 100, 'branco com luz cheia');
}

console.log('\n=== a forma do hsl() que o html2canvas le ===');
{
  const s = Fundo.hsl(224.4, 42.7, 11.2);
  ok(s === 'hsl(224, 43%, 11%)', 'com virgula e sem decimal', s);
  ok(!!partesHsl(s), 'e no formato que da pra ler de volta');
}

console.log('\n=== a cor sai da BORDA DE BAIXO, nao da foto inteira ===');
// O pixel que encosta no corte e o que tem que continuar: e ali que a emenda
// aparece. Topo vermelho, base azul -> a base do poster tem que ser AZUL.
{
  const d = recorte(L, A, (x, y) => (y < A - 6 ? [200, 30, 30] : [30, 60, 170]));
  const c = Fundo.coresDoPoster(d, L, A);
  ok(!!c, 'achou cor');
  const base = partesHsl(c.base);
  ok(base.h > 200 && base.h < 250, 'a base e azul, nao vermelha', Math.round(base.h));
}

console.log('\n=== a base entra escura e dessaturada ===');
// Cor cheia aqui faz o nome de quem esta na lista brigar com o fundo.
{
  const d = recorte(L, A, () => [0, 90, 255]);   // azul berrante
  const c = Fundo.coresDoPoster(d, L, A);
  const base = partesHsl(c.base), base2 = partesHsl(c.base2);
  ok(base.l <= 14, 'a luz da base fica baixa', base.l);
  ok(base.s <= Fundo.SAT_TETO_BASE, 'a saturacao entra cortada no teto', base.s);
  ok(base2.l < base.l, 'e o pe do poster e mais escuro que o topo da base',
     base2.l + ' < ' + base.l);
  ok(Math.abs(base2.h - base.h) < 2, 'as duas no mesmo matiz (senao vira degrade sujo)');
}

console.log('\n=== o CORPO do poster e quase preto, so a EMENDA tem cor ===');
// A licao que custou um "ficou horrivel": pintar o poster inteiro com o matiz
// da foto deu certo numa arte azul e virou lama numa arte quente -- porque ai o
// fundo ficou do mesmo tom do laranja das pilulas, e poster de um tom so nao
// tem o que saltar. O preto que estava la antes era NEUTRO, e neutro deixa a
// cor aparecer no que importa.
//
// Entao a cor faz so o trabalho que justificou ela existir (matar a emenda
// embaixo da foto) e morre logo.
{
  const quente = recorte(L, A, () => [150, 70, 30]);   // a foto do Borba
  const c = Fundo.coresDoPoster(quente, L, A);
  const emenda = partesHsl(c.base), corpo = partesHsl(c.base2), pilula = partesHsl(c.pilula);

  ok(corpo.l <= 5, 'o corpo e quase preto', corpo.l + '%');
  ok(corpo.s <= 14, 'e quase sem cor -- so um sopro do matiz', corpo.s + '%');
  ok(corpo.s < emenda.s / 2, 'bem menos colorido que a emenda',
     corpo.s + ' << ' + emenda.s);

  // a pilula tem que deixar o laranja/azul/roxo do TIPO saltar; se ela
  // carregasse o matiz cheio, numa arte quente ela brigaria com o laranja
  ok(pilula.s <= 16, 'a pilula e cinza-escuro do matiz, nao o matiz cheio', pilula.s + '%');
  ok(pilula.l > corpo.l, 'mas ainda se destaca do corpo', pilula.l + ' > ' + corpo.l);
  ok(pilula.l <= 13, 'sem clarear a ponto de virar mancha', pilula.l + '%');

  // e o mesmo vale pra arte fria: a regra nao pode valer so pra um lado
  const fria = Fundo.coresDoPoster(recorte(L, A, () => [30, 60, 170]), L, A);
  ok(partesHsl(fria.base2).l <= 5, 'arte fria: corpo igualmente preto',
     partesHsl(fria.base2).l + '%');
  ok(partesHsl(fria.pilula).s <= 16, 'arte fria: pilula igualmente contida',
     partesHsl(fria.pilula).s + '%');
}

console.log('\n=== foto sem cor NAO vira cor ===');
// Inventar matiz onde nao tem deixa o poster com um tom que nao esta na arte.
{
  ok(Fundo.coresDoPoster(recorte(L, A, () => [20, 20, 20]), L, A) === null,
     'quase preto devolve null');
  ok(Fundo.coresDoPoster(recorte(L, A, () => [128, 128, 128]), L, A) === null,
     'cinza puro devolve null');
  ok(Fundo.coresDoPoster(recorte(L, A, () => [250, 250, 250]), L, A) === null,
     'branco devolve null');
  // um tiquinho de cor tambem nao conta
  ok(Fundo.coresDoPoster(recorte(L, A, () => [130, 128, 126]), L, A) === null,
     'cinza levemente quente ainda e cinza');
}

console.log('\n=== o acento das brasinhas ===');
// Faisca laranja numa arte azul destoa; a brasinha segue a foto.
{
  // base azul escura + um miolo vivo no meio
  const d = recorte(L, A, (x, y) =>
    (y > 10 && y < 20 && x > 10 && x < 30) ? [40, 150, 255] : [12, 20, 48]);
  const c = Fundo.coresDoPoster(d, L, A);
  ok(!!c.brasa, 'achou acento', c.brasa);
  const br = partesHsl(c.brasa);
  ok(br.h > 190 && br.h < 230, 'no azul da arte', Math.round(br.h));
  ok(br.s >= 60, 'e vivo o bastante pra aparecer', br.s);
  const clara = partesHsl(c.brasaClara);
  ok(clara.l > br.l, 'o miolo da brasinha e mais claro que a borda',
     clara.l + ' > ' + br.l);
}

console.log('\n=== foto escura sem nenhum pixel vivo ===');
{
  // borda com cor (passa do piso) mas nada vivo pra virar brasinha
  const d = recorte(L, A, () => [16, 22, 52]);
  const c = Fundo.coresDoPoster(d, L, A);
  ok(!!c && !!c.base, 'ainda da base', c && c.base);
  ok(!c.brasa, 'mas nao inventa brasinha', c && c.brasa);
}

console.log('\n=== lixo na entrada ===');
{
  let estourou = false;
  try {
    ok(Fundo.coresDoPoster(null, L, A) === null, 'dados nulos');
    ok(Fundo.coresDoPoster(recorte(L, A, () => [0, 0, 255]), 0, A) === null, 'largura zero');
    ok(Fundo.coresDoPoster(recorte(L, A, () => [0, 0, 255]), L, 0) === null, 'altura zero');
    ok(Fundo.coresDoPoster(undefined, undefined, undefined) === null, 'tudo indefinido');
    // recorte de 1 pixel de altura: o laco da borda nao pode rodar vazio
    const um = Fundo.coresDoPoster(recorte(4, 1, () => [30, 60, 170]), 4, 1);
    ok(um !== undefined, 'recorte de uma linha nao estoura', JSON.stringify(um));
  } catch (e) { estourou = true; console.log('     estourou: ' + e.message); }
  ok(!estourou, 'nada quebrou');
}

console.log(falhas ? '\n>>> ' + falhas + ' FALHA(S)' : '\n>>> TODOS OS TESTES PASSARAM');
process.exit(falhas ? 1 : 0);
