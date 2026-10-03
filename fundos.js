// ============================================================================
// O FUNDO DO MURAL — UMA FOTO POR LIVE
// ----------------------------------------------------------------------------
// O mural gera a imagem que o streamer posta no story. O fundo dela ERA uma
// constante no HTML: `foto_da_tropa_hd.jpg`, a foto da tropa do Borba. Como o
// arquivo era um só pro site inteiro, todo streamer que entrava gerava o story
// dele com a foto da tropa de outro. É o tipo de erro que não dá erro — a tela
// funciona, a imagem sai, e sai errada.
//
// Aqui cada live tem a sua, e a decisão que importa é esta:
//
//   O FUNDO NÃO SE HERDA.
//
// Todo o resto do config desce da instalação pro cliente (quem não escolhe
// título, usa o título padrão). Se o fundo descesse igual, a foto da casa
// voltaria a ser a foto de todo mundo — exatamente o problema. Então quem não
// tem foto não recebe a de ninguém: recebe um degradê nas cores da PRÓPRIA
// marca, que é discreto demais pra ofender e visível o bastante pra avisar que
// falta escolher uma.
//
// A foto mora no disco persistente, não no config.json: o config é um arquivo
// pequeno que dá pra abrir e ler com o olho, e algumas centenas de KB de
// base64 por cliente acabariam com isso. E o DISCO é a verdade — não existe um
// campo no config dizendo "tenho foto", porque dois lugares guardando o mesmo
// fato é um lugar a mais pra eles discordarem.
// ============================================================================
const fs = require('fs');
const path = require('path');

const DIR = process.env.RAILWAY_ENVIRONMENT ? '/data/fundos' : 'fundos';

// Teto de bytes. O navegador reduz a foto antes de enviar (1600px, JPEG), o
// que dá uns 300-700KB; a folga aqui é pra quem cair no caminho de upload
// direto, sem o redimensionamento.
const LIMITE_BYTES = 6 * 1024 * 1024;

// ---------- que imagem é esta? ----------
// Pelos BYTES, nunca pela extensão nem pelo Content-Type: os dois vêm de quem
// está enviando, e quem envia pode estar mentindo. O que não é imagem de
// verdade não entra — se entrasse, a gente estaria guardando arquivo arbitrário
// pra servir de volta no nosso próprio domínio.
const ASSINATURAS = [
  {
    ext: 'jpg', mime: 'image/jpeg',
    casa: b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
  },
  {
    ext: 'png', mime: 'image/png',
    casa: b => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e
      && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a
      && b[7] === 0x0a
  },
  {
    ext: 'webp', mime: 'image/webp',
    casa: b => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF'
      && b.toString('latin1', 8, 12) === 'WEBP'
  }
];
const EXTENSOES = ASSINATURAS.map(a => a.ext);

function tipoDaImagem(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) return null;
  return ASSINATURAS.find(a => a.casa(bytes)) || null;
}

// ---------- o nome do arquivo ----------
// A chave vem do `usuarioTikTok` do config, que já derruba tudo fora de
// [A-Za-z0-9._-] — então não há barra pra escapar da pasta. A conferência
// repetida aqui é de propósito: este módulo monta caminho de arquivo com ela,
// e quem monta caminho não terceiriza a validação.
function chaveSegura(dono) {
  const k = String(dono || '').trim().toLowerCase();
  if (!k || k.length > 40) return '';
  if (!/^[a-z0-9._-]+$/.test(k)) return '';
  if (k === '.' || k === '..') return '';   // nome de pasta, não de gente
  return k;
}

function garantirPasta() {
  try { fs.mkdirSync(DIR, { recursive: true }); } catch (e) {}
}

// ---------- ler ----------
// Devolve o que o servidor precisa pra entregar o arquivo, ou null. O `mtimeMs`
// sai daqui pro ETag: é o que faz o navegador pegar a foto nova depois de uma
// troca, e não baixar nada quando ela não mudou.
function ler(dono) {
  const chave = chaveSegura(dono);
  if (!chave) return null;
  for (const { ext, mime } of ASSINATURAS) {
    const caminho = path.join(DIR, chave + '.' + ext);
    try {
      const st = fs.statSync(caminho);
      if (st.isFile()) return { caminho, mime, ext, bytes: st.size, mtimeMs: st.mtimeMs };
    } catch (e) { /* não tem desta extensão; tenta a próxima */ }
  }
  return null;
}

function tem(dono) { return !!ler(dono); }

// ---------- gravar ----------
// Uma foto por live, não um histórico: gravar apaga as outras extensões da
// mesma chave. Sem isso, trocar um .jpg por um .png deixaria os dois no disco
// e o `ler()` entregaria o antigo pra sempre, pela ordem da lista.
function guardar(dono, bytes) {
  const chave = chaveSegura(dono);
  if (!chave) return { erro: 'De qual live é esta foto?' };

  const tipo = tipoDaImagem(bytes);
  if (!tipo) return { erro: 'Isso não é uma imagem JPG, PNG ou WebP.' };
  if (bytes.length > LIMITE_BYTES) {
    return { erro: 'A imagem passou de ' + Math.round(LIMITE_BYTES / 1024 / 1024) + 'MB.' };
  }

  garantirPasta();
  const caminho = path.join(DIR, chave + '.' + tipo.ext);

  // Escreve ao lado e renomeia. Se o processo morrer no meio da gravação, o
  // fundo que já estava lá continua inteiro em vez de virar meio arquivo.
  const temporario = caminho + '.novo';
  try {
    fs.writeFileSync(temporario, bytes);
    fs.renameSync(temporario, caminho);
  } catch (e) {
    try { fs.unlinkSync(temporario); } catch (e2) {}
    return { erro: 'Não deu pra gravar a imagem no disco.' };
  }

  EXTENSOES.filter(e => e !== tipo.ext).forEach(e => {
    try { fs.unlinkSync(path.join(DIR, chave + '.' + e)); } catch (e2) {}
  });

  return { ok: true, ext: tipo.ext, mime: tipo.mime, bytes: bytes.length, em: Date.now() };
}

// ---------- apagar ----------
// Volta pro degradê das cores da marca. Não é "voltar ao padrão da casa":
// padrão da casa não existe aqui, é o ponto todo do módulo.
function apagar(dono) {
  const chave = chaveSegura(dono);
  if (!chave) return false;
  let apagou = false;
  EXTENSOES.forEach(e => {
    try { fs.unlinkSync(path.join(DIR, chave + '.' + e)); apagou = true; } catch (e2) {}
  });
  return apagou;
}

// ---------- a semente da casa ----------
// A live da casa já tinha a foto dela — era a constante no HTML. Sem isto, o
// deploy que troca a constante por este módulo apagaria o fundo do mural que
// funciona hoje, e a correção de um bug tiraria uma coisa que estava certa.
// Então na primeira subida a foto do repositório entra como fundo DAQUELA live,
// e a partir daí ela é só mais uma live com fundo próprio.
//
// Semeia uma vez e anota: sem a anotação, quem apagasse o fundo de propósito
// veria ele voltar sozinho no próximo restart.
function semear(dono, origem) {
  const chave = chaveSegura(dono);
  if (!chave) return false;

  garantirPasta();
  const marca = path.join(DIR, '.semeados');
  let feitos = [];
  try {
    feitos = String(fs.readFileSync(marca, 'utf-8')).split('\n').filter(Boolean);
  } catch (e) {}
  if (feitos.includes(chave)) return false;

  let bytes;
  try { bytes = fs.readFileSync(origem); } catch (e) { return false; }

  const r = tem(chave) ? { ok: false } : guardar(chave, bytes);
  try { fs.appendFileSync(marca, chave + '\n'); } catch (e) {}
  return !!r.ok;
}

module.exports = {
  DIR, LIMITE_BYTES, EXTENSOES,
  ler, tem, guardar, apagar, semear, tipoDaImagem, chaveSegura
};
