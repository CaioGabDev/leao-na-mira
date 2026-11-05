// ============================================================================
// ALERTA NO TELEGRAM
// ----------------------------------------------------------------------------
// Uma live desconectada não pontua, e sem isto só dá pra descobrir olhando o
// painel. Quem decide QUANDO avisar é o live.js; aqui só mora o envio.
//
// Sem TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID, nada é enviado e nada quebra.
// O token vai na URL da API do Telegram, então a URL nunca entra em log.
// ============================================================================
const TEMPO_LIMITE_MS = 10 * 1000;

function configuracao() {
  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const chat = (process.env.TELEGRAM_CHAT_ID || '').trim();
  return token && chat ? { token, chat } : null;
}

// Uma linha pra jogar no log da subida.
function resumo() {
  return configuracao()
    ? 'Alertas: Telegram ligado.'
    : 'Alertas: DESLIGADOS. Defina TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID pra receber.';
}

// Devolve true se o Telegram aceitou. Nunca lança: um alerta que falha não pode
// atrapalhar a live que ele está tentando proteger.
async function enviar(texto, buscar = fetch) {
  const config = configuracao();
  if (!config) return false;
  try {
    const r = await buscar(`https://api.telegram.org/bot${config.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // sem parse_mode: o _ dos @ quebraria a formatação e o Telegram recusaria
      body: JSON.stringify({ chat_id: config.chat, text: texto }),
      signal: AbortSignal.timeout(TEMPO_LIMITE_MS)
    });
    if (r.ok) return true;
    console.error(`[ALERTA] o Telegram recusou a mensagem (HTTP ${r.status}). Confira o token e o chat.`);
    return false;
  } catch (err) {
    console.error('[ALERTA] não consegui falar com o Telegram:', err?.name || 'erro');
    return false;
  }
}

module.exports = { enviar, resumo };
