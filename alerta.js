// ============================================================================
// ALERTA NO TELEGRAM
// ----------------------------------------------------------------------------
// Uma live desconectada não pontua, e sem isto só dá pra descobrir olhando o
// painel. Quem decide QUANDO avisar é o live.js; aqui moram o texto e o envio.
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

// O servidor roda em UTC, e quem lê o alerta está no Brasil.
const hora = ms => new Date(ms).toLocaleTimeString('pt-BR', {
  timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit'
});

const SE_NAO_VOLTAR = [
  'Se estiver, clique uma vez em Reconectar no painel admin.',
  'Se não voltar, espere de 5 a 10 min. O sistema continua tentando sozinho.',
  'Passou disso? Mande esta mensagem e o log do Railway pra investigar.'
];

// A chave é o `motivo` da última tentativa no live.js. Os passos mudam junto:
// no limite do Euler, por exemplo, clicar em Reconectar só piora.
const GUIAS = {
  incerto: {
    oQue: 'As consultas ao TikTok falharam, então não deu pra confirmar se a live está no ar.',
    passos: SE_NAO_VOLTAR
  },
  bloqueio: {
    oQue: 'O TikTok bloqueou o servidor e não deu pra achar a sala da live.',
    passos: SE_NAO_VOLTAR
  },
  assinatura: {
    oQue: 'O Euler recusou a assinatura da conexão. Pode ser a cota ou o limite de uso.',
    passos: [
      'Se estiver, NÃO clique em Reconectar: insistir piora o limite.',
      'Veja o consumo no painel do Euler.',
      'O sistema continua tentando sozinho, com mais espaço entre as tentativas.'
    ]
  },
  arroba: {
    oQue: 'Não achei a live desse @.',
    passos: [
      'Se estiver, compare o @ com o do perfil no TikTok.',
      'Se mudou, remova o antigo e adicione o novo no painel admin.',
      'Se o @ estiver certo, clique uma vez em Reconectar.'
    ]
  }
};

const GUIA_PADRAO = {
  oQue: 'A conexão com a live falhou por um erro inesperado.',
  passos: SE_NAO_VOLTAR
};

function textoDoProblema({ dono, desde, agora = Date.now(), motivo, recado }) {
  const guia = GUIAS[motivo] || GUIA_PADRAO;
  const passos = [`Veja no TikTok se @${dono} está ao vivo. Se não estiver, não precisa fazer nada.`, ...guia.passos];
  return [
    `⚠️ @${dono} sem conexão há ${Math.round((agora - desde) / 60000)} min (desde as ${hora(desde)})`,
    '',
    'O que aconteceu:',
    `${guia.oQue} Se estiver ao vivo, não está pontuando.`,
    '',
    'Próximos passos:',
    ...passos.map((p, i) => `${i + 1}. ${p}`),
    '',
    `Detalhe técnico: ${String(recado || 'sem detalhes').slice(0, 300)}`
  ].join('\n');
}

function textoDaSolucao({ dono, desde, agora = Date.now(), resultado }) {
  const periodo = `das ${hora(desde)} às ${hora(agora)} (${Math.round((agora - desde) / 60000)} min)`;
  const guarde = 'Guarde esta mensagem caso a campanha decida compensar.';
  if (resultado === 'conectou') {
    return [
      `✅ @${dono} conectou de novo`,
      '',
      'O que aconteceu:',
      `Ficou sem conexão ${periodo}.`,
      '',
      'Próximo passo:',
      `Se estava ao vivo nesse período, esses pontos não foram contados. ${guarde}`
    ].join('\n');
  }
  return [
    `✅ @${dono} está offline`,
    '',
    'O que aconteceu:',
    `A conexão teve problema ${periodo}, e agora foi confirmado que não há live no ar.`,
    '',
    'Próximo passo:',
    `Se não estava ao vivo, pode ignorar. Se estava, a live pode ter acabado durante a falha e não ter sido contada. ${guarde}`
  ].join('\n');
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

module.exports = { enviar, resumo, textoDoProblema, textoDaSolucao };
