// ============================================================================
// O ENVIO DO ALERTA NO TELEGRAM
// ----------------------------------------------------------------------------
// Quando avisar é testado em teste/reconexao.js. Aqui é só o envio: ele nunca
// pode derrubar nada, nem deixar o token escapar pro log.
//
// Roda com:  node --test teste/alerta.js
// ============================================================================
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const alerta = require(path.join(__dirname, '..', 'alerta.js'));

const TOKEN = '123:segredo';

function configurar(token, chat) {
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  if (token) process.env.TELEGRAM_BOT_TOKEN = token;
  if (chat) process.env.TELEGRAM_CHAT_ID = chat;
}

test.afterEach(() => {
  configurar();
  mock.restoreAll();
});

// 04:20 em UTC são 01:20 em Brasília
const DESDE = Date.UTC(2026, 10, 5, 4, 20);
const CINCO_MIN = 5 * 60 * 1000;

test('problema: diz o que houve, quando começou e os passos, em horário do Brasil', () => {
  const texto = alerta.textoDoProblema({
    dono: 'fulano', desde: DESDE, agora: DESDE + CINCO_MIN, motivo: 'bloqueio', recado: 'status 403'
  });
  assert.match(texto, /@fulano sem conexão há 5 min \(desde as 01:20\)/);
  assert.match(texto, /O que aconteceu:\nO TikTok bloqueou o servidor/);
  assert.match(texto, /1\. Veja no TikTok se @fulano está ao vivo/);
  assert.match(texto, /2\. Se estiver, clique uma vez em Reconectar/);
  assert.match(texto, /Detalhe técnico: status 403/);
});

test('limite do Euler: manda NÃO clicar em Reconectar', () => {
  const texto = alerta.textoDoProblema({ dono: 'fulano', desde: DESDE, motivo: 'assinatura' });
  assert.match(texto, /NÃO clique em Reconectar/);
  assert.doesNotMatch(texto, /clique uma vez em Reconectar/);
});

test('@ não achado: manda comparar o @', () => {
  const texto = alerta.textoDoProblema({ dono: 'fulano', desde: DESDE, motivo: 'arroba' });
  assert.match(texto, /compare o @/);
});

test('motivo desconhecido ainda dá passos pra seguir', () => {
  const texto = alerta.textoDoProblema({ dono: 'fulano', desde: DESDE, motivo: 'novidade' });
  assert.match(texto, /erro inesperado/);
  assert.match(texto, /Próximos passos:/);
  assert.match(texto, /Detalhe técnico: sem detalhes/);
});

test('resolvido: mostra o período e diz o que fazer com os pontos', () => {
  const conectou = alerta.textoDaSolucao({
    dono: 'fulano', desde: DESDE, agora: DESDE + CINCO_MIN, resultado: 'conectou'
  });
  assert.match(conectou, /@fulano conectou de novo/);
  assert.match(conectou, /das 01:20 às 01:25 \(5 min\)/);
  assert.match(conectou, /não foram contados/);

  const offline = alerta.textoDaSolucao({
    dono: 'fulano', desde: DESDE, agora: DESDE + CINCO_MIN, resultado: 'offline'
  });
  assert.match(offline, /@fulano está offline/);
  assert.match(offline, /pode ter acabado durante a falha/);
});

test('sem configuração, não chama o Telegram', async () => {
  configurar();
  const buscar = mock.fn();
  assert.equal(await alerta.enviar('oi', buscar), false);
  assert.equal(buscar.mock.callCount(), 0);
  assert.match(alerta.resumo(), /DESLIGADOS/);
});

test('só o token, sem o chat, conta como desligado', async () => {
  configurar(TOKEN);
  const buscar = mock.fn();
  assert.equal(await alerta.enviar('oi', buscar), false);
  assert.equal(buscar.mock.callCount(), 0);
});

test('envia o texto puro pro chat configurado', async () => {
  configurar(TOKEN, '42');
  const buscar = mock.fn(async () => ({ ok: true, status: 200 }));
  assert.equal(await alerta.enviar('@nome_com_underline caiu', buscar), true);

  const [url, opcoes] = buscar.mock.calls[0].arguments;
  assert.equal(url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.equal(opcoes.method, 'POST');
  assert.deepEqual(JSON.parse(opcoes.body), { chat_id: '42', text: '@nome_com_underline caiu' });
  assert.match(alerta.resumo(), /ligado/);
});

test('Telegram recusou: devolve false e o log não mostra o token', async () => {
  configurar(TOKEN, '42');
  const erro = mock.method(console, 'error', () => {});
  assert.equal(await alerta.enviar('oi', async () => ({ ok: false, status: 401 })), false);
  const logado = JSON.stringify(erro.mock.calls.map(c => c.arguments));
  assert.match(logado, /401/);
  assert.doesNotMatch(logado, /segredo/);
});

test('rede caiu: não lança e o log não mostra o token', async () => {
  configurar(TOKEN, '42');
  const erro = mock.method(console, 'error', () => {});
  const buscar = async url => { throw new TypeError(`fetch failed ${url}`); };
  assert.equal(await alerta.enviar('oi', buscar), false);
  assert.doesNotMatch(JSON.stringify(erro.mock.calls.map(c => c.arguments)), /segredo/);
});
