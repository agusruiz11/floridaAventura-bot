// Arma por código el mensaje de cotización para Instagram, con el mismo formato
// que hoy escribe el bot siguiendo la plantilla de prompt.js ("CÓMO PRESENTAR LOS
// AUTOS") y que después pasa por formatForInstagram en server.js. Si cambia el
// formato del bot, hay que cambiarlo también acá.
//
// No calcula nada: recibe los autos ya cotizados por ../cotizacion.js y copia la
// línea 💵 tal cual viene.
import { DESCUENTO_DESDE_DIAS, DESCUENTO_PORCENTAJE, formatoUSD } from '../cotizacion.js';

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const TAMANIOS = { SMALL: 'Chico', MEDIUM: 'Mediano', LARGE: 'Grande' };

export const AVISO_COTIZACION =
  '📋 Estos valores son una estimación orientativa. El cargo de SunPass puede variar según los destinos que visites y la duración del viaje. Los montos y la disponibilidad definitivos se confirman con nuestro equipo comercial al momento de la reserva.';
export const AVISO_7_PASAJEROS =
  'Tené en cuenta que los 7 asientos se logran usando el espacio del baúl para la tercera fila. Si viajan con valijas, el auto entra cómodamente 5 personas.';

// "Del 20 al 27 de septiembre" o "Del 28 de julio al 5 de agosto".
export function textoFechas(inicioISO, finISO) {
  const [, m1, d1] = inicioISO.slice(0, 10).split('-').map(Number);
  const [, m2, d2] = finISO.slice(0, 10).split('-').map(Number);
  return m1 === m2
    ? `Del ${d1} al ${d2} de ${MESES[m2 - 1]}`
    : `Del ${d1} de ${MESES[m1 - 1]} al ${d2} de ${MESES[m2 - 1]}`;
}

// "Nissan Rogue(Blanca)" + 2024 → "Nissan Rogue (Blanca) 2024"
export function nombreAuto(car) {
  const base = String(car.name || '').replace(/\(([^)]+)\)/g, ' ($1)').replace(/\s+/g, ' ').trim();
  return car.year ? `${base} ${car.year}` : base;
}

export function tamanioAuto(car) {
  return TAMANIOS[String(car.type || '').toUpperCase()] || '';
}

const plural = (n, uno, muchos) => `${n} ${n === 1 ? uno : muchos}`;

// El bloque de un auto, igual al que le llega hoy al cliente por Instagram.
export function bloqueAuto(car, rango) {
  const tamanio = tamanioAuto(car);
  const lineas = [`🚗 ${nombreAuto(car)}${tamanio ? ` — ${tamanio}` : ''}`];
  if (rango) {
    lineas.push(
      `📅 ${textoFechas(rango.startDateTime, rango.endDateTime)} · Retiro ${rango.retiro}, devolución ${rango.devolucion}` +
      `${rango.horariosEstimados ? ' (horarios estimados)' : ''}`,
    );
  }
  const partes = [`💰 USD ${formatoUSD(car.pricePerDay)}/día × ${plural(car.dias, 'día', 'días')}`];
  if (car.passengersAmount != null) partes.push(`👥 ${plural(car.passengersAmount, 'pasajero', 'pasajeros')}`);
  if (car.suitcasesAmount != null) partes.push(`🧳 aprox. ${plural(car.suitcasesAmount, 'valija', 'valijas')}`);
  partes.push('✅ Seguro incluido', '🛣️ KM ilimitado (solo Florida)', '⛽ Tanque lleno al retirar y al devolver', '👤 1 conductor adicional incluido');
  lineas.push(partes.join(' | '));
  lineas.push(car.lineaTotal);
  if (car.nota) lineas.push(`→ ${String(car.nota).trim()}`);
  if (Number(car.passengersAmount) === 7) lineas.push(AVISO_7_PASAJEROS);
  return lineas.join('\n');
}

// El mensaje de cierre: aclaraciones, aviso de cotización y pregunta de avance.
export function cierre({ autos, rango, sunPass, sunPassAjustado = false }) {
  const parrafos = [];
  if (rango?.horariosEstimados) {
    parrafos.push(`Coticé con retiro a las ${rango.retiro} y devolución a las ${rango.devolucion}. Si me pasás tus horarios exactos, ajusto el total.`);
  }
  if (autos.some((a) => a.descuento)) {
    parrafos.push(`Como el alquiler es de ${DESCUENTO_DESDE_DIAS} días o más, ya tiene aplicado un ${DESCUENTO_PORCENTAJE}% de descuento sobre el alquiler.`);
  }
  if (sunPass?.esEstimado && !sunPassAjustado) {
    parrafos.push(`El cargo de SunPass estimado es de USD ${formatoUSD(sunPass.monto)} (tarifa base para Miami). Puede variar según los destinos que visites durante tu viaje.`);
  }
  parrafos.push(AVISO_COTIZACION);
  parrafos.push(autos.length === 1 ? '¿Te sirve esta opción?' : '¿Alguna de estas opciones te sirve?');
  return parrafos.join('\n\n');
}

// Instagram corta los mensajes cerca de los 1000 caracteres: se parte por líneas.
export function partir(texto, max = 950) {
  const trozos = [];
  let actual = '';
  for (const linea of texto.split('\n')) {
    if (actual && (actual + '\n' + linea).length > max) {
      trozos.push(actual);
      actual = linea;
    } else {
      actual = actual ? `${actual}\n${linea}` : linea;
    }
  }
  if (actual) trozos.push(actual);
  return trozos;
}

// Devuelve la lista de mensajes a pegar en Instagram, en orden: uno por auto y
// el cierre, igual que la ráfaga del bot.
export function mensajesInstagram({ autos, rango, sunPass, sunPassAjustado = false }) {
  const mensajes = [];
  for (const car of autos) mensajes.push(...partir(bloqueAuto(car, rango)));
  mensajes.push(...partir(cierre({ autos, rango, sunPass, sunPassAjustado })));
  return mensajes;
}
