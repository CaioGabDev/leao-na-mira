// ============================================================================
// O FUNDO DO MURAL — uma foto por live
// ----------------------------------------------------------------------------
// Este módulo tem duas coisas que merecem teste de verdade:
//
//   1. Ele decide se um upload é imagem OLHANDO OS BYTES. Se essa conferência
//      falhar, a gente passa a guardar arquivo arbitrário e a servir de volta
//      no nosso próprio domínio.
//   2. Ele MONTA CAMINHO DE ARQUIVO com o @ do streamer. Caminho montado com
//      texto de fora é onde moram as fugas de pasta.
//
// Roda com:  node teste/fundos.js
// ============================================================================
const fs = require('fs');
const os = require('os');
const path = require('path');

// A pasta de fundos é escolhida quando o módulo carrega, então o destino tem
// que estar de pé ANTES do require — senão o teste escreveria na pasta real.
const CAIXA = fs.mkdtempSync(path.join(os.tmpdir(), 'fundos-teste-'));
process.env.RAILWAY_ENVIRONMENT = '';
process.chdir(CAIXA);

const fundos = require(path.join(__dirname, '..', 'fundos.js'));

let falhas = 0;
const ok = (c, m, e) => {
  console.log((c ? '  OK  ' : '  FALHA') + '  ' + m + (e !== undefined ? '  -> ' + e : ''));
  if (!c) falhas++;
};

// imagens mínimas, só com a assinatura que o módulo procura
const JPG  = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
const PNG  = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4, 0), Buffer.from('WEBP'), Buffer.alloc(200, 7)]);

console.log('=== o que e imagem, pelos BYTES ===');
{
  ok(fundos.tipoDaImagem(JPG).ext === 'jpg', 'jpg pela assinatura', fundos.tipoDaImagem(JPG).ext);
  ok(fundos.tipoDaImagem(PNG).ext === 'png', 'png pela assinatura');
  ok(fundos.tipoDaImagem(WEBP).ext === 'webp', 'webp pelo RIFF....WEBP');
  ok(fundos.tipoDaImagem(Buffer.from('<?php system($_GET[0]); ?>')) === null,
     'texto nao passa por imagem');
  ok(fundos.tipoDaImagem(Buffer.from('GIF89a' + 'x'.repeat(50))) === null,
     'gif tambem nao (nao esta na lista de propósito)');
  ok(fundos.tipoDaImagem(Buffer.alloc(0)) === null, 'vazio nao e imagem');
  ok(fundos.tipoDaImagem('nao sou buffer') === null, 'string nao e imagem');
  // RIFF sem WEBP é um .wav — a conferência de 4 bytes sozinha deixaria passar
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4, 0), Buffer.from('WAVE'), Buffer.alloc(60, 1)]);
  ok(fundos.tipoDaImagem(wav) === null, 'RIFF de audio nao passa por webp');
}

console.log('\n=== o @ virando nome de arquivo ===');
{
  ok(fundos.chaveSegura('VitorB0rba') === 'vitorb0rba', 'normaliza pra minuscula');
  ok(fundos.chaveSegura('  fulano  ') === 'fulano', 'tira o respiro');
  ok(fundos.chaveSegura('..') === '', 'ponto-ponto nao e nome de gente');
  ok(fundos.chaveSegura('.') === '', 'ponto sozinho tambem nao');
  ok(fundos.chaveSegura('a/b') === '', 'barra nao passa');
  ok(fundos.chaveSegura('a\\b') === '', 'barra invertida nao passa');
  ok(fundos.chaveSegura('../../etc/passwd') === '', 'fuga de pasta nao passa');
  ok(fundos.chaveSegura('') === '', 'vazio nao passa');
  ok(fundos.chaveSegura('x'.repeat(41)) === '', 'nome absurdamente longo nao passa');
  ok(fundos.chaveSegura('nome com espaco') === '', 'espaco no meio nao passa');
  ok(fundos.chaveSegura('ponto.no.meio') === 'ponto.no.meio', 'ponto no meio e @ valido');
}

console.log('\n=== gravar e ler ===');
{
  ok(fundos.ler('ninguem') === null, 'quem nunca escolheu nao tem fundo');
  ok(fundos.tem('ninguem') === false, 'e o tem() concorda');

  const r = fundos.guardar('fulano', JPG);
  ok(r.ok === true, 'gravou', JSON.stringify(r).slice(0, 80));
  ok(r.ext === 'jpg', 'com a extensao dos bytes', r.ext);

  const lido = fundos.ler('fulano');
  ok(!!lido, 'e da pra ler de volta');
  ok(lido.mime === 'image/jpeg', 'com o mime certo', lido && lido.mime);
  ok(lido.bytes === JPG.length, 'do tamanho que entrou', lido && lido.bytes);
  ok(fs.readFileSync(lido.caminho).equals(JPG), 'e com os bytes intactos');
}

console.log('\n=== uma foto por live, nao um historico ===');
// Era o bug esperando acontecer: trocar jpg por png deixaria os dois no disco,
// e o ler() entregaria o antigo pra sempre, pela ordem da lista de assinaturas.
{
  fundos.guardar('fulano', PNG);
  const lido = fundos.ler('fulano');
  ok(lido.ext === 'png', 'depois de trocar, le a NOVA', lido.ext);
  ok(!fs.existsSync(path.join(fundos.DIR, 'fulano.jpg')), 'e a antiga saiu do disco');

  const sobrando = fs.readdirSync(fundos.DIR).filter(f => f.startsWith('fulano'));
  ok(sobrando.length === 1, 'um arquivo so pra esta live', JSON.stringify(sobrando));
}

console.log('\n=== nao grava lixo ===');
{
  const r1 = fundos.guardar('fulano', Buffer.from('nao sou imagem'));
  ok(!!r1.erro, 'recusa o que nao e imagem', r1.erro);
  ok(fundos.ler('fulano').ext === 'png', 'e a foto boa que estava la continua la');

  const grande = Buffer.concat([JPG, Buffer.alloc(fundos.LIMITE_BYTES, 1)]);
  const r2 = fundos.guardar('fulano', grande);
  ok(!!r2.erro, 'recusa acima do teto', r2.erro);
  ok(fundos.ler('fulano').bytes === PNG.length, 'sem estragar a que estava la');

  const r3 = fundos.guardar('..', JPG);
  ok(!!r3.erro, 'recusa chave que nao e nome de gente', r3.erro);
  const r4 = fundos.guardar('', JPG);
  ok(!!r4.erro, 'recusa chave vazia', r4.erro);
}

console.log('\n=== cada live com a sua (o bug que originou tudo) ===');
{
  fundos.guardar('streamer-a', JPG);
  fundos.guardar('streamer-b', WEBP);
  ok(fundos.ler('streamer-a').ext === 'jpg', 'A tem a dele');
  ok(fundos.ler('streamer-b').ext === 'webp', 'B tem a dele');
  // o que o bug fazia: um arquivo so, servido pra todos
  ok(fundos.ler('streamer-a').caminho !== fundos.ler('streamer-b').caminho,
     'e nao e o mesmo arquivo pros dois');
  ok(fundos.ler('streamer-c') === null, 'quem nao escolheu NAO herda a de ninguem');
}

console.log('\n=== apagar ===');
{
  ok(fundos.apagar('streamer-a') === true, 'apagou');
  ok(fundos.ler('streamer-a') === null, 'e ficou sem fundo');
  ok(fundos.apagar('streamer-a') === false, 'apagar de novo nao mente dizendo que apagou');
  ok(fundos.ler('streamer-b') !== null, 'sem encostar no fundo do vizinho');
  ok(fundos.apagar('..') === false, 'chave torta nao apaga nada');
}

console.log('\n=== a semente da casa ===');
// A live da casa já tinha a foto dela cravada no HTML. Sem semear, arrumar o
// bug começaria apagando a única foto que estava certa.
{
  const origem = path.join(CAIXA, 'foto-da-casa.jpg');
  fs.writeFileSync(origem, JPG);

  ok(fundos.semear('acasa', origem) === true, 'semeia na primeira vez');
  ok(fundos.ler('acasa').bytes === JPG.length, 'e a foto da casa esta no lugar');

  ok(fundos.semear('acasa', origem) === false, 'na segunda vez nao faz nada');

  // o motivo de existir a anotação: quem apaga de propósito nao quer de volta
  fundos.apagar('acasa');
  fundos.semear('acasa', origem);
  ok(fundos.ler('acasa') === null, 'e NAO ressuscita o que foi apagado de proposito');

  ok(fundos.semear('outra', path.join(CAIXA, 'nao-existe.jpg')) === false,
     'origem que nao existe nao estoura');
}

console.log('\n=== lixo na entrada nao quebra nada ===');
{
  let estourou = false;
  try {
    fundos.ler(null); fundos.ler(undefined); fundos.ler(123); fundos.ler({});
    fundos.tem(null);
    fundos.apagar(null);
    fundos.guardar(null, null);
    fundos.guardar('alguem', null);
    fundos.guardar('alguem', 'texto');
    fundos.semear(null, null);
  } catch (e) { estourou = true; console.log('     estourou: ' + e.message); }
  ok(!estourou, 'engole lixo sem quebrar');
}

try { fs.rmSync(CAIXA, { recursive: true, force: true }); } catch (e) {}
console.log(falhas ? '\n>>> ' + falhas + ' FALHA(S)' : '\n>>> TODOS OS TESTES PASSARAM');
process.exit(falhas ? 1 : 0);
