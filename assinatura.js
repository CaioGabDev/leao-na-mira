// ============================================================================
// ASSINATURA DA CONEXÃO
// ----------------------------------------------------------------------------
// Toda conexão com uma live passa por um servidor de assinatura — é ele que
// devolve a URL do websocket que o TikTok aceita. O padrão da biblioteca é o
// Euler Stream, e isso foi conferido na unha: apontando SIGN_API_URL pra um
// servidor local, a lib bate em
//     GET /webcast/anchors/<@>/room_id      (descobre a sala)
//     GET /webcast/rooms/<id>/connect       (assina a conexão)
// e o erro que volta se chama `fetchSignedWebSocketFromEulerRoute`.
//
// Sem chave, a identificação é pelo IP — e o limite é por IP. Como cada live e
// cada RECONEXÃO pedem assinatura, isso é o primeiro gargalo que aparece
// quando o servidor passa a segurar vários clientes.
//
// Este arquivo não guarda nem mostra a chave: só diz se existe uma.
// ============================================================================

const PADRAO_SERVIDOR = 'https://api.eulerstream.com';

// Os dois nomes valem: o server passa EULERSTREAM_API_KEY pra conexão, e a
// própria biblioteca lê SIGN_API_KEY sozinha. Setar qualquer um funciona.
const NOMES_DE_CHAVE = ['EULERSTREAM_API_KEY', 'SIGN_API_KEY'];

function estado() {
  const fonte = NOMES_DE_CHAVE.find(nome => {
    const v = process.env[nome];
    return typeof v === 'string' && v.trim().length > 0;
  }) || null;

  const servidor = (process.env.SIGN_API_URL || '').trim() || PADRAO_SERVIDOR;

  return {
    comChave: !!fonte,
    fonte,                                   // qual env var está valendo
    servidor,
    ehEuler: servidor.includes('eulerstream.com'),
    nomesAceitos: NOMES_DE_CHAVE
  };
}

// Uma linha pra jogar no log da subida.
function resumo() {
  const e = estado();
  if (e.comChave) {
    return `Assinatura: COM chave (${e.fonte}) em ${e.servidor}`;
  }
  return `Assinatura: SEM chave — ${e.servidor} vai te identificar pelo IP, ` +
         `e o limite é por IP. Defina ${NOMES_DE_CHAVE.join(' ou ')} antes de ` +
         `colocar mais de uma live pra rodar.`;
}

// Um 429 do assinador NÃO chega como erro de rate limit: chega como TypeError.
// Isto é bug da tiktok-live-connector 2.4.4, conferido no fonte dela — em
// `fetchSignedWebSocketFromEulerRoute`, quando o status é 429:
//
//     throw new SignatureRateLimitError(data?.message, '...', response.data)
//
// e o construtor do erro lê `response.headers['retry-after']`. Como recebeu o
// CORPO (`response.data`, um buffer) no lugar da resposta, `headers` é
// undefined e o construtor estoura antes de existir:
//
//     TypeError: Cannot read properties of undefined (reading 'retry-after')
//
// O erro que sobe tem name 'TypeError' e nenhuma palavra sobre assinatura, então
// as duas peneiras abaixo o deixavam passar como "erro genérico" — e o painel
// mostrava essa mensagem crua pro streamer, sem dizer que o limite estourou.
// Reconhecer pela assinatura do estrago (o nome do campo mais o do erro no
// stack) é o que devolve o diagnóstico certo.
function ehLimiteMascarado(err) {
  if (!err) return false;
  const msg = String(err.message || '');
  if (!/retry-after/i.test(msg)) return false;
  // `retry-after` só aparece assim no caminho do 429; o stack confirma a origem
  // quando a lib o preserva, e a mensagem sozinha basta quando não preserva.
  const pilha = String(err.stack || '');
  return !pilha || /SignatureRateLimit|lib-|tiktok-live-connector/i.test(pilha);
}

// O erro de assinatura tem cara própria: a biblioteca tem tipos pra ele
// (SignAPIError, SignatureRateLimitError, PremiumFeatureError) e o nome da
// rota aparece na mensagem. Isso aqui separa "o assinador recusou" de uma
// queda de rede qualquer — que são problemas bem diferentes.
function ehErroDeAssinatura(err) {
  if (!err) return false;
  const nome = String(err.name || '');
  const msg = String(err.message || err);
  return /Sign(API)?Error|SignatureRateLimit|PremiumFeature/i.test(nome) ||
         /\[Sign Error\]|fetchSignedWebSocket|sign server/i.test(msg) ||
         ehLimiteMascarado(err);
}

function ehLimiteEstourado(err) {
  if (!err) return false;
  const nome = String(err.name || '');
  const msg = String(err.message || err);
  return /RateLimit/i.test(nome) || /rate.?limit|429|too many requests/i.test(msg) ||
         ehLimiteMascarado(err);
}

// Mensagem pro diagnóstico quando a conexão falha por causa do assinador.
function explicar(err) {
  const e = estado();
  if (ehLimiteEstourado(err)) {
    return 'LIMITE DE ASSINATURA ESTOURADO no ' + e.servidor + '. ' +
      (e.comChave
        ? 'A chave em uso bateu no teto do plano.'
        : 'Você está sem chave, então o limite é do IP do servidor — e ele é ' +
          'compartilhado por todas as lives daqui.') +
      ' Insistir piora: cada tentativa conta pro limite. A reconexão já está ' +
      'esperando cada vez mais entre uma tentativa e outra.';
  }
  return 'O servidor de assinatura (' + e.servidor + ') recusou a conexão. ' +
    'Sem essa assinatura o TikTok não abre o websocket, então a live não conecta.';
}

module.exports = { PADRAO_SERVIDOR, NOMES_DE_CHAVE, estado, resumo, ehErroDeAssinatura, ehLimiteEstourado, ehLimiteMascarado, explicar };
