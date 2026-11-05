// ============================================================================
// CORREÇÕES — os diamantes e minutos reais que o sistema não contou
// ----------------------------------------------------------------------------
// Live que o sistema não acompanhou não existe pra conta. Aqui o administrador
// digita o número REAL do sniper, e a pontuação sai da mesma conta de sempre:
// 300 diamantes corrigidos pra 500 fecham um bloco sozinhos, sem ninguém
// calcular ponto à mão.
//
// O que se guarda é a DIFERENÇA, não o número digitado. Guardando o número, a
// próxima live não somaria: ele ficaria congelado no valor corrigido. Com a
// diferença, as lives seguintes continuam entrando por cima.
//
// Cada correção é uma linha própria, com motivo e autor, e o "de -> para" fica
// guardado pra leitura. Uma correção errada se desfaz removendo a linha.
//
// Mora no mesmo dados.db, do mesmo jeito do indicacoes.js.
// ============================================================================
const crypto = require('crypto');
const banco = require('./banco');

// o teto pega dedo escorregando: nenhuma campanha chega perto disto
const MAXIMO_DIAMANTES = 100000000;
const MAXIMO_MINUTOS = 100000;
const MOTIVO_MINIMO = 3;
const MOTIVO_MAXIMO = 200;

let preparado = null;
function bd() {
  const b = banco.abrir();
  if (preparado !== b) {
    b.exec(`CREATE TABLE IF NOT EXISTS correcoes (
      id    TEXT NOT NULL PRIMARY KEY,
      dados TEXT NOT NULL
    ) WITHOUT ROWID`);
    preparado = b;
  }
  return b;
}

function listar() {
  const saida = [];
  for (const l of bd().prepare('SELECT dados FROM correcoes').all()) {
    try { saida.push(JSON.parse(l.dados)); } catch (e) { /* linha torta: pula */ }
  }
  return saida.sort((a, b) => b.criadoEm - a.criadoEm);
}

function buscar(id) {
  const l = bd().prepare('SELECT dados FROM correcoes WHERE id = ?').get(String(id));
  try { return l ? JSON.parse(l.dados) : null; } catch (e) { return null; }
}

// Campo que não veio não muda. É o que protege uma live no ar: o minuto que a
// tela mostrava já ficou velho, e reenviar ele cortaria o tempo que passou.
const naoVeio = valor => valor === undefined || valor === null || valor === '';

// `atual` é o que o ranking usa agora, já com as correções anteriores.
function criar({ arroba, atual, diamantes, minutos, motivo }, autor) {
  const texto = String(motivo || '').trim();
  const mudaDiamantes = !naoVeio(diamantes);
  const mudaMinutos = !naoVeio(minutos);
  const novosDiamantes = Number(diamantes);
  const novosMinutos = Number(minutos);

  if (mudaDiamantes && (!Number.isInteger(novosDiamantes) || novosDiamantes < 0 || novosDiamantes > MAXIMO_DIAMANTES)) {
    return { erro: 'Os diamantes precisam ser um número inteiro, de zero pra cima.' };
  }
  if (mudaMinutos && (!Number.isInteger(novosMinutos) || novosMinutos < 0 || novosMinutos > MAXIMO_MINUTOS)) {
    return { erro: 'Os minutos precisam ser um número inteiro, de zero pra cima.' };
  }
  if (texto.length < MOTIVO_MINIMO) return { erro: 'Escreva o motivo: é o que explica essa correção depois.' };
  if (texto.length > MOTIVO_MAXIMO) return { erro: `O motivo pode ter até ${MOTIVO_MAXIMO} caracteres.` };

  const minutosAtuais = Math.floor(atual.segundos / 60);
  const diferencaDiamantes = mudaDiamantes ? novosDiamantes - atual.diamantes : 0;
  // o mesmo minuto não mexe nos segundos que a tela não mostra
  const diferencaSegundos = mudaMinutos && novosMinutos !== minutosAtuais
    ? novosMinutos * 60 - atual.segundos
    : 0;
  if (!diferencaDiamantes && !diferencaSegundos) {
    return { erro: 'Esses já são os números atuais. Nada mudou.' };
  }

  const item = {
    id: crypto.randomUUID(),
    arroba,
    diamantes: diferencaDiamantes,
    segundos: diferencaSegundos,
    de: { diamantes: atual.diamantes, minutos: minutosAtuais },
    para: {
      diamantes: diferencaDiamantes ? novosDiamantes : null,
      minutos: diferencaSegundos ? novosMinutos : null
    },
    motivo: texto,
    criadoEm: Date.now(),
    autor: String(autor || '')
  };
  bd().prepare('INSERT INTO correcoes (id, dados) VALUES (?, ?)').run(item.id, JSON.stringify(item));
  return { correcao: item };
}

function remover(id) {
  const r = bd().prepare('DELETE FROM correcoes WHERE id = ?').run(String(id));
  return Number(r.changes || 0) > 0;
}

// Devolve quantas saíram, pro log do zerar.
function removerDoSniper(arroba) {
  const dele = listar().filter(c => c.arroba === arroba);
  dele.forEach(c => remover(c.id));
  return dele.length;
}

// sniper -> { diamantes, segundos } somando as diferenças
function somaPorSniper() {
  const conta = new Map();
  for (const c of listar()) {
    const atual = conta.get(c.arroba) || { diamantes: 0, segundos: 0 };
    conta.set(c.arroba, { diamantes: atual.diamantes + c.diamantes, segundos: atual.segundos + c.segundos });
  }
  return conta;
}

module.exports = { listar, buscar, criar, remover, removerDoSniper, somaPorSniper };
