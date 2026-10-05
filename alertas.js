// ─── Alertas al equipo ───────────────────────────────────────────────────────
// Cuando el bot detecta que algo le impide contestar (el token de Instagram
// vencido, por ejemplo) lo deja en el log con la marca [alerta] y, si hay un
// webhook de Slack configurado, avisa ahí. Sin SLACK_WEBHOOK_URL solo loguea.
//
// Cada alerta tiene una clave: la misma clave no se repite hasta que pase cadaMs,
// así una caída no llena el canal con un aviso por cada mensaje que falla.
//
// alertar() nunca tira: un Slack caído no puede romper el envío de un mensaje.
//
//   const { alertar } = crearAlertas({ webhookUrl, bot: 'Futbol Queens' });
//   alertar('token-190', 'el token no sirve');            → true si salió
//   alertar('token-vence', 'quedan 5 días', { cadaMs });  → false si se frenó
//
// Sin dependencias del server: se prueba con fetch y reloj falsos
// (test/alertas.test.js).

const SEIS_HORAS = 6 * 60 * 60 * 1000;
const CINCO_MIN = 5 * 60 * 1000;

export function crearAlertas({
  webhookUrl = '',
  bot = 'bot',
  fetchFn = globalThis.fetch,
  ahora = Date.now,
  log = console.error,
} = {}) {
  let url = String(webhookUrl || '').trim();
  if (url) {
    // La URL del webhook es un secreto: si está mal escrita lo decimos sin mostrarla.
    let valida = false;
    try { valida = ['https:', 'http:'].includes(new URL(url).protocol); } catch { /* no es una URL */ }
    if (!valida) {
      log('[alerta] SLACK_WEBHOOK_URL no es una URL válida: los avisos quedan solo en el log');
      url = '';
    }
  }
  const ultimas = new Map(); // clave -> momento del último aviso

  // Devuelve true si el aviso salió (a Slack, o al log si no hay Slack) y false
  // si se frenó por repetido o si Slack no lo recibió.
  async function alertar(clave, texto, { cadaMs = SEIS_HORAS } = {}) {
    const t = ahora();
    const ultima = ultimas.get(clave);
    if (ultima !== undefined && t - ultima < cadaMs) return false;
    ultimas.set(clave, t);

    log(`[alerta] ${texto}`);
    if (!url) return true;
    let motivo;
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `*${bot}*: ${texto}` }),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) return true;
      motivo = `Slack respondió ${res.status}`;
    } catch (err) {
      motivo = err.name === 'TimeoutError' ? 'Slack no respondió a tiempo' : `error de red (${err.name})`;
    }
    // No llegó: que no quede callada toda la ventana. Reintenta con la próxima
    // ocurrencia, pero no antes de 5 minutos.
    log(`[alerta] El aviso no llegó a Slack: ${motivo}`);
    ultimas.set(clave, t - Math.max(cadaMs - CINCO_MIN, 0));
    return false;
  }

  return { alertar, conSlack: !!url };
}
