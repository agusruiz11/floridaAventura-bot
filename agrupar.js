// ─── Agrupador de mensajes por persona ───────────────────────────────────────
// La gente escribe como habla: la idea llega partida en varios mensajes, con
// segundos de diferencia. Si arrancamos una respuesta por cada uno, el modelo
// corre varias veces sobre casi el mismo historial y contesta lo mismo dos o tres
// veces seguidas (Futbol Queens, 28/9/2026). Acá cada mensaje entra a un buffer de
// esa persona y reinicia una espera; al vencer, se juntan los textos y se corre el
// flujo una sola vez. Mientras se responde, lo que llega queda para el turno
// siguiente: nunca dos respuestas en paralelo para la misma persona.
//
// Sin dependencias del server: solo timers y Date.now, así se prueba con timers
// falsos (test/agrupar.test.js).
//
//   const agrupador = crearAgrupador({ esperaMs, maxMs, procesar });
//   agrupador.agregar(id, texto)        → cuántos mensajes hay en espera
//   agrupador.cancelar(id, motivo)      → cuántos mensajes se descartaron
//   agrupador.retirarUltimo(id, motivo) → el último texto en espera, o null
//   agrupador.ocupado(id)               → true si está respondiendo o tiene
//                                          mensajes esperando turno
//
// procesar(id, texto, { textos }) recibe los textos unidos con "\n" y también el
// array original (sirve para depurarlos del historial de Instagram).

export function crearAgrupador({
  esperaMs = 20000,
  maxMs = 60000,
  procesar,
  log = console.log,
  error = console.error,
} = {}) {
  if (typeof procesar !== 'function') throw new TypeError('crearAgrupador: falta procesar()');
  esperaMs = Math.max(0, Number(esperaMs) || 0);
  maxMs = Math.max(esperaMs, Number(maxMs) || 0);

  const estados = new Map(); // id -> { textos, timer, primeroEn, respondiendo }

  function estadoDe(id) {
    let e = estados.get(id);
    if (!e) {
      e = { textos: [], timer: null, primeroEn: 0, respondiendo: false };
      estados.set(id, e);
    }
    return e;
  }

  function limpiarSiVacio(id, e) {
    if (!e.textos.length && !e.timer && !e.respondiendo) estados.delete(id);
  }

  function programar(id, e) {
    clearTimeout(e.timer);
    const ahora = Date.now();
    if (!e.primeroEn) e.primeroEn = ahora;
    // Cada mensaje reinicia la espera, pero nunca más allá del tope contado
    // desde el primer mensaje que sigue sin respuesta.
    const hastaTope = e.primeroEn + maxMs - ahora;
    const espera = Math.max(0, Math.min(esperaMs, hastaTope));
    e.timer = setTimeout(() => { e.timer = null; disparar(id, e); }, espera);
  }

  async function disparar(id, e) {
    // Todavía estamos contestando lo anterior: lo que hay queda para el turno
    // siguiente, que arranca apenas termine este.
    if (e.respondiendo) return;
    if (!e.textos.length) { limpiarSiVacio(id, e); return; }

    const textos = e.textos;
    e.textos = [];
    e.primeroEn = 0;
    e.respondiendo = true;
    if (textos.length > 1) log(`[agrupar] ${id}: junto ${textos.length} mensajes en una sola respuesta`);
    try {
      await procesar(id, textos.join('\n'), { textos });
    } catch (err) {
      error(`[agrupar] ${id}: error al procesar:`, err?.message || err);
    } finally {
      e.respondiendo = false;
    }

    // Llegó algo mientras contestábamos. Si su espera ya venció, lo atendemos
    // ahora; si no, dejamos que termine de escribir.
    if (e.textos.length && !e.timer) {
      log(`[agrupar] ${id}: atiendo ${e.textos.length} mensaje(s) que llegaron mientras respondía`);
      await disparar(id, e);
    } else {
      limpiarSiVacio(id, e);
    }
  }

  function agregar(id, texto) {
    const e = estadoDe(id);
    e.textos.push(texto);
    if (e.respondiendo) log(`[agrupar] ${id}: llegó un mensaje mientras respondo — va al turno siguiente`);
    programar(id, e);
    return e.textos.length;
  }

  function cancelar(id, motivo = '') {
    const e = estados.get(id);
    if (!e) return 0;
    clearTimeout(e.timer);
    e.timer = null;
    const descartados = e.textos.length;
    e.textos = [];
    e.primeroEn = 0;
    if (descartados) log(`[agrupar] ${id}: descarto ${descartados} mensaje(s) en espera${motivo ? ` (${motivo})` : ''}`);
    limpiarSiVacio(id, e);
    return descartados;
  }

  // Saca de la espera solo el último mensaje y lo devuelve (null si no hay o si
  // hay una respuesta en curso). Lo usa el server cuando Instagram ya contestó
  // ese mensaje con una respuesta automática: lo anterior sigue esperando turno.
  function retirarUltimo(id, motivo = '') {
    const e = estados.get(id);
    if (!e || e.respondiendo || !e.textos.length) return null;
    const texto = e.textos.pop();
    if (!e.textos.length) {
      clearTimeout(e.timer);
      e.timer = null;
      e.primeroEn = 0;
    }
    log(`[agrupar] ${id}: retiro 1 mensaje en espera${motivo ? ` (${motivo})` : ''}`);
    limpiarSiVacio(id, e);
    return texto;
  }

  function ocupado(id) {
    const e = estados.get(id);
    return !!e && (e.respondiendo || e.textos.length > 0);
  }

  return { agregar, cancelar, retirarUltimo, ocupado, esperaMs, maxMs };
}
