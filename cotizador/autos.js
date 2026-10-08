// Consulta de autos para el cotizador.
//
// Hace lo mismo que la herramienta buscar_autos del bot (server.js, executeTool):
// completa horarios, rechaza fechas pasadas, aplica el mínimo, consulta la API de
// Florida Aventura y cotiza cada auto. La plata y los días salen SIEMPRE de
// ../cotizacion.js, el mismo módulo que usa el bot: acá no hay ninguna fórmula.
//
// Vive dentro de cotizador/ para que un push de esta carpeta no redeploye el bot.
// Cuando el bot pase a usar este módulo, se mueve a la raíz.
import { cargoSunPass, cotizarAuto, prepararRango, MINIMO_DIAS } from '../cotizacion.js';

const FA_BASE = process.env.FA_API_BASE || 'https://api.floridaaventura.com/public';
// A partir de cuántos días de anticipación avisamos que conviene confirmar el año.
const DIAS_FECHA_LEJANA = 330;

function esISOCompleta(str) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(str) && !Number.isNaN(Date.parse(str));
}

// Acepta fecha con hora o solo la fecha (cuando el cliente no dio horario).
export function esFechaValida(str) {
  return typeof str === 'string' && (esISOCompleta(str) || esISOCompleta(`${str}T00:00:00`));
}

// Fecha de hoy en Florida como "YYYY-MM-DD".
export function hoyEnFlorida(ahora = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.FA_TIMEZONE || 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(ahora);
}

// Junta fecha ("YYYY-MM-DD") y hora ("HH:mm", opcional) en lo que espera
// prepararRango: con hora va completa, sin hora va solo la fecha.
export function armarFechaHora(fecha, hora) {
  if (!fecha) return '';
  return hora ? `${fecha}T${hora}:00` : fecha;
}

function diasEntre(desdeISO, hastaISO) {
  return Math.round((Date.parse(`${hastaISO}T00:00:00Z`) - Date.parse(`${desdeISO}T00:00:00Z`)) / 86_400_000);
}

async function faFetch(path, fetchImpl) {
  const res = await fetchImpl(`${FA_BASE}${path}`, { headers: { apiKey: process.env.FA_API_TOKEN || '' } });
  if (!res.ok) throw new Error(`La API de Florida Aventura respondió ${res.status}`);
  return res.json();
}

// Valida el rango y devuelve { ok: true, rango, avisos } o { ok: false, error }
// o { ok: false, minimoNoCumplido: true, dias, minimo }.
export function validarRango(startDateTime, endDateTime, { hoy = hoyEnFlorida() } = {}) {
  if (!esFechaValida(startDateTime)) return { ok: false, error: 'La fecha de retiro no es válida.' };
  if (!esFechaValida(endDateTime)) return { ok: false, error: 'La fecha de devolución no es válida.' };

  const rango = prepararRango(startDateTime, endDateTime);
  const inicio = rango.startDateTime.slice(0, 10);
  const fin = rango.endDateTime.slice(0, 10);

  if (inicio < hoy) return { ok: false, error: `La fecha de retiro (${inicio}) ya pasó. Revisá el año.` };
  if (fin < inicio || rango.dias == null) {
    return { ok: false, error: 'La devolución tiene que ser posterior al retiro.' };
  }
  if (rango.dias < MINIMO_DIAS) {
    return { ok: false, minimoNoCumplido: true, dias: rango.dias, minimo: MINIMO_DIAS, rango };
  }

  const avisos = [];
  if (diasEntre(hoy, inicio) > DIAS_FECHA_LEJANA) {
    avisos.push(`El retiro es el ${inicio}, a más de 11 meses. Confirmá el año con el cliente.`);
  }
  return { ok: true, rango, avisos };
}

// Busca disponibilidad y devuelve los autos ya cotizados.
export async function buscarAutos(
  { startDateTime, endDateTime, destinos = [], puertoDeCruceros = false },
  { fetchImpl = fetch, hoy } = {},
) {
  const validacion = validarRango(startDateTime, endDateTime, { hoy });
  if (!validacion.ok) return validacion;
  const { rango, avisos } = validacion;

  const params = new URLSearchParams({ startDateTime: rango.startDateTime, endDateTime: rango.endDateTime });
  const data = await faFetch(`/availability?${params}`, fetchImpl);
  const unicos = [...new Map((Array.isArray(data) ? data : []).map((d) => [d.name, d])).values()];

  const sunPass = cargoSunPass(rango.dias, destinos);
  const autos = unicos.map((car) => cotizarAuto(car, rango.dias, sunPass, puertoDeCruceros));
  return { ok: true, rango, sunPass, autos, avisos };
}
