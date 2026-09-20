// ============================================================================
// CONFIGURAÇÃO
// ----------------------------------------------------------------------------
// O código é o mesmo pra todo mundo; o que muda mora aqui. São dois níveis:
//
//   INSTALAÇÃO  — a cara padrão do site e o @ da live da casa
//   CLIENTE     — a cara de UM cliente, por `dono` (o @ da live dele)
//
// Um cliente só precisa preencher o que quer diferente: o que ele não mexer
// cai na configuração da instalação. Por isso `get(dono)` devolve sempre um
// config completo, nunca um pela metade.
//
// Fica tudo num arquivo só, no disco persistente (mesmo critério do live.json),
// NUNCA no repositório: é um arquivo pequeno, escrito de vez em quando, e que
// dá pra abrir e ler com o olho quando alguma coisa estiver estranha.
// ============================================================================
const fs = require('fs');

const FILE = process.env.RAILWAY_ENVIRONMENT ? '/data/config.json' : 'config.json';

// O padrão é o site como ele sempre foi. Trocar qualquer coisa aqui muda o
// visual de quem ainda não configurou nada.
const PADRAO = {
  marca: {
    emoji:  '🔥',
    titulo: 'Ranking da Live',
    sub:    'Quem mais tá na treta hoje'
  },
  mural: {
    titulo: 'MURAL DA TROPA',
    sub:    'Cadastra o pessoal, escolhe o nível e o tipo, e gera a imagem final para compartilhar.'
  },
  tema: {
    bg:     '#0a0807',
    card:   '#150f0b',
    gold:   '#ffb03a',
    ember1: '#ff7a1a',
    ember2: '#ff2d2d',
    // As brasinhas que sobem no fundo. Duas cores: o miolo e a borda que
    // some. São os mesmos valores que estavam cravados no canvas.
    brasa1: '#ffaa3c',
    brasa2: '#ff3c14'
  },
  live: {
    // @ da live da casa. Vazio = usa a env var TIKTOK_USERNAME, como sempre foi.
    // Só é lido quando o servidor sobe: trocar de live com a coisa rodando
    // misturaria os dados de duas lives no mesmo lugar.
    usuario: ''
  }
};

const LIMITE = { emoji: 8, titulo: 60, sub: 160, usuario: 32 };

// ---------- saneamento ----------
// Tudo que entra aqui veio de um formulário e vai parar dentro de HTML e de
// CSS. Então nada é aproveitado como veio.

function texto(v, max) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/[\u0000-\u001F\u007F]/g, '')   // controle não entra
    .trim()
    .slice(0, max);
}

// Só hexadecimal de 6 dígitos. Qualquer outra coisa é descartada — é isso que
// impede alguém de fechar a regra do CSS e injetar o que quiser.
function corOuNada(v) {
  const t = String(v === undefined || v === null ? '' : v).trim();
  return /^#[0-9a-f]{6}$/i.test(t) ? t.toLowerCase() : null;
}

function cor(v, padrao) {
  return corOuNada(v) || padrao;
}

// O canvas monta o rgba() com a opacidade dele, então a cor vai em "r, g, b".
function rgbDoHex(hex, padrao) {
  const t = corOuNada(hex);
  if (!t) return padrao;
  return [1, 3, 5].map(i => parseInt(t.slice(i, i + 2), 16)).join(', ');
}

function grau(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(360, Math.round(n)));
}

// Sempre minúsculo: o db, o registro de clientes e o config todos usam o @ em
// caixa baixa como chave. Deixar a caixa original aqui fazia a resposta da API
// dizer "Fulano.TK" enquanto tudo que foi gravado era "fulano.tk".
function usuarioTikTok(v) {
  return texto(v, LIMITE.usuario)
    .replace(/^@+/, '')
    .replace(/[^A-Za-z0-9._-]/g, '')
    .toLowerCase();
}

function escaparHtml(t) {
  return String(t).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Monta um config completo a partir de qualquer bagunça que venha do arquivo
// ou do formulário. `base` é em cima de quem os campos que faltam caem:
// pra instalação é o PADRAO; pra um cliente é a configuração da instalação.
function normalizar(bruto, base) {
  const b = (bruto && typeof bruto === 'object') ? bruto : {};
  const p = base || PADRAO;
  const m = (b.marca && typeof b.marca === 'object') ? b.marca : {};
  const u = (b.mural && typeof b.mural === 'object') ? b.mural : {};
  const t = (b.tema  && typeof b.tema  === 'object') ? b.tema  : {};
  const l = (b.live  && typeof b.live  === 'object') ? b.live  : {};

  return {
    marca: {
      emoji:  texto(m.emoji,  LIMITE.emoji)  || p.marca.emoji,
      titulo: texto(m.titulo, LIMITE.titulo) || p.marca.titulo,
      sub:    texto(m.sub,    LIMITE.sub)    || p.marca.sub
    },
    mural: {
      titulo: texto(u.titulo, LIMITE.titulo) || p.mural.titulo,
      sub:    texto(u.sub,    LIMITE.sub)    || p.mural.sub
    },
    tema: {
      bg:     cor(t.bg,     p.tema.bg),
      card:   cor(t.card,   p.tema.card),
      gold:   cor(t.gold,   p.tema.gold),
      ember1: cor(t.ember1, p.tema.ember1),
      ember2: cor(t.ember2, p.tema.ember2),
      brasa1: cor(t.brasa1, p.tema.brasa1),
      brasa2: cor(t.brasa2, p.tema.brasa2)
    },
    live: { usuario: usuarioTikTok(l.usuario) }
  };
}

const chaveDono = dono => String(dono || '').trim().toLowerCase();

// ---------- disco ----------
// `bruto` é o arquivo como está; os configs completos saem de `get()`.
let bruto = null;
let versao = 0;   // muda a cada gravação; serve de chave de cache das páginas

function lerArquivo() {
  if (bruto) return bruto;
  let lido = {};
  if (fs.existsSync(FILE)) {
    try {
      lido = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
    } catch (e) {
      console.error('config.json ilegível, usando o padrão:', e.message);
      lido = {};
    }
  }
  if (!lido || typeof lido !== 'object') lido = {};
  if (!lido.clientes || typeof lido.clientes !== 'object') lido.clientes = {};
  bruto = lido;
  return bruto;
}

// Config completo. Sem `dono`, é o da instalação. Com `dono`, é o do cliente
// caindo na instalação no que ele não mexeu.
function get(dono) {
  const arq = lerArquivo();
  const instalacao = normalizar(arq, PADRAO);
  const chave = chaveDono(dono);
  if (!chave) return instalacao;
  return normalizar(arq.clientes[chave], instalacao);
}

// ---------- gravação ESPARSA ----------
// Guarda só o que a pessoa realmente mexeu. É isso que faz a herança
// funcionar: o que o cliente não define continua vindo da instalação, hoje e
// depois que a instalação mudar. Guardar o config completo (foi o meu primeiro
// erro aqui) congela a cara do dia em que ele salvou.
//
// Campo enviado VAZIO (ou cor inválida) apaga o que estava guardado — é assim
// que o "voltar ao padrão" funciona sem precisar de rota própria.
const CAMPOS_TEXTO = {
  marca: { emoji: LIMITE.emoji, titulo: LIMITE.titulo, sub: LIMITE.sub },
  mural: { titulo: LIMITE.titulo, sub: LIMITE.sub }
};
const CORES_DO_TEMA = ['bg', 'card', 'gold', 'ember1', 'ember2', 'brasa1', 'brasa2'];

function aplicarParcial(destino, parcial, aceitaLive) {
  const p = (parcial && typeof parcial === 'object') ? parcial : {};

  for (const [secao, campos] of Object.entries(CAMPOS_TEXTO)) {
    const vindo = p[secao];
    if (!vindo || typeof vindo !== 'object') continue;
    destino[secao] = destino[secao] || {};
    for (const [campo, limite] of Object.entries(campos)) {
      if (vindo[campo] === undefined) continue;
      const limpo = texto(vindo[campo], limite);
      if (limpo) destino[secao][campo] = limpo;
      else delete destino[secao][campo];
    }
    if (!Object.keys(destino[secao]).length) delete destino[secao];
  }

  if (p.tema && typeof p.tema === 'object') {
    destino.tema = destino.tema || {};
    CORES_DO_TEMA.forEach(campo => {
      if (p.tema[campo] === undefined) return;
      const limpa = corOuNada(p.tema[campo]);
      if (limpa) destino.tema[campo] = limpa;
      else delete destino.tema[campo];
    });
    if (!Object.keys(destino.tema).length) delete destino.tema;
  }

  // o @ da live de um cliente é o `dono` dele, não um campo editável por ele
  if (aceitaLive && p.live && typeof p.live === 'object' && p.live.usuario !== undefined) {
    const u = usuarioTikTok(p.live.usuario);
    if (u) destino.live = { usuario: u };
    else delete destino.live;
  }
}

function salvar(parcial, dono) {
  const arq = lerArquivo();
  const chave = chaveDono(dono);

  if (chave) {
    arq.clientes[chave] = arq.clientes[chave] || {};
    aplicarParcial(arq.clientes[chave], parcial, false);
  } else {
    aplicarParcial(arq, parcial, true);
  }

  fs.writeFileSync(FILE, JSON.stringify(arq, null, 2));
  versao++;
  return get(dono);
}

function listarClientes() {
  return Object.keys(lerArquivo().clientes).sort();
}

// Tira a configuração de um cliente. Ele volta a ver a cara da instalação —
// os DADOS da live dele não são tocados aqui (isso é do banco.js).
function removerCliente(dono) {
  const arq = lerArquivo();
  const chave = chaveDono(dono);
  if (!chave || !arq.clientes[chave]) return false;
  delete arq.clientes[chave];
  fs.writeFileSync(FILE, JSON.stringify(arq, null, 2));
  versao++;
  return true;
}

function getVersao() { return versao; }

// ---------- o que vai pra página ----------

// As cores viram uma sobrescrita dos tokens que o theme.css já define. Como
// todo o site consome esses tokens, isso repinta tudo sem CSS novo.
function blocoDeTema(dono) {
  const t = get(dono).tema;
  const cores =
    `--bg:${t.bg};--card:${t.card};--gold:${t.gold};--ember1:${t.ember1};--ember2:${t.ember2};`;
  // as brasinhas vão em "r, g, b": é assim que o canvas do ranking consome
  const brasas =
    `--brasa-1:${rgbDoHex(t.brasa1, '255, 170, 60')};--brasa-2:${rgbDoHex(t.brasa2, '255, 60, 20')};`;
  return `<style id="tema-do-cliente">:root{${cores}${brasas}}</style>`;
}

// Troca os {{marcadores}} do HTML. Marcador desconhecido fica como está, de
// propósito: some sem avisar é pior que aparecer errado na tela.
// Tarja de quem está espiando: sem ela, o administrador olha a tela de um
// cliente e não tem como saber de quem ela é — nem como voltar.
function barraDeEspiar(dono) {
  return '<div style="background:var(--card-3);border-bottom:1px solid var(--line);' +
    'padding:8px 16px;font-size:13px;color:var(--ink-dim);display:flex;gap:10px;' +
    'align-items:center;flex-wrap:wrap;justify-content:center">' +
    '<span>👁️ Você está vendo a live de <b style="color:var(--gold)">@' + escaparHtml(dono) + '</b></span>' +
    '<a class="app-btn" href="/api/espiar/sair">⬅️ Voltar ao painel</a></div>';
}

function aplicar(html, ctx) {
  const c = get(ctx && ctx.dono);
  const ehAdmin = !!(ctx && ctx.ehAdmin);
  const espiando = !!(ctx && ctx.espiando);
  const mapa = {
    '{{marca.emoji}}':  escaparHtml(c.marca.emoji),
    '{{marca.titulo}}': escaparHtml(c.marca.titulo),
    '{{marca.sub}}':    escaparHtml(c.marca.sub),
    '{{mural.titulo}}': escaparHtml(c.mural.titulo),
    '{{mural.sub}}':    escaparHtml(c.mural.sub),
    '{{tema}}':         blocoDeTema(ctx && ctx.dono),
    // o atalho do topo muda com o papel: o dono vai pro painel, o cliente
    // vai mexer na cara da live dele
    '{{linkAdmin}}':    ehAdmin
      ? '<a class="app-btn" href="/admin.html" title="Painel do administrador">📊 Painel</a>'
      : '<a class="app-btn" href="/config.html" title="Mudar a cara da sua live">🎨 Aparência</a>',
    '{{barraEspiando}}': (ehAdmin && espiando) ? barraDeEspiar(ctx.dono) : ''
  };
  return String(html).replace(/\{\{[a-zA-Z.]+\}\}/g, m => (m in mapa ? mapa[m] : m));
}

module.exports = {
  FILE, PADRAO, get, salvar, getVersao, aplicar, blocoDeTema,
  listarClientes, removerCliente,
  normalizar, escaparHtml, texto, cor, corOuNada, grau, rgbDoHex, usuarioTikTok
};
