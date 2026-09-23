// Cotización de alquileres — módulo compartido.
//
// Vive acá y no en server.js porque el eval (eval/run-eval.js) tiene que cotizar
// EXACTAMENTE igual que producción. Cuando esta lógica estaba duplicada, el mock
// del eval devolvía autos sin cotizar y la categoría B daba PASS sin haber
// probado un solo total. Una sola fuente de verdad: si cambia el criterio de
// días o el SunPass, cambia para los dos.

// Días de alquiler en bloques de 24 horas desde la hora de retiro, con 2 horas
// de tolerancia: pasadas las 2 horas se cobra un día completo más. Es el
// criterio que confirmó Patricia el 23/9/2026 (antes contábamos días de
// calendario incluyendo ambos extremos, que daba un día de más: del 20 a las
// 16:00 al 27 a las 16:00 son 7 días, no 8).
//   20 16:00 → 27 16:00 = 7 días
//   20 16:00 → 27 18:00 = 7 días (2 horas justas, dentro de la tolerancia)
//   20 16:00 → 27 18:01 = 8 días
// Las fechas llegan sin zona horaria, en hora local de Florida. Se comparan como
// hora de reloj (las dos en UTC) para que el cambio de horario de verano no
// sume ni reste una hora.
export const TOLERANCIA_MIN = 120;

export function diasDeAlquiler(startDateTime, endDateTime) {
  const inicio = Date.parse(`${startDateTime.slice(0, 19)}Z`);
  const fin = Date.parse(`${endDateTime.slice(0, 19)}Z`);
  if (Number.isNaN(inicio) || Number.isNaN(fin)) return null;
  const minutos = Math.round((fin - inicio) / 60_000);
  if (minutos <= 0) return null;
  let dias = Math.floor(minutos / 1440);
  if (minutos % 1440 > TOLERANCIA_MIN) dias += 1;
  return Math.max(dias, 1);
}

export const MINIMO_DIAS = 4;

// Horarios que se asumen cuando el cliente dio fechas pero no horas (Patricia,
// 23/9/2026: "llegando a las 7 am y saliendo 8 pm, que es lo más común"). El
// bot no frena la cotización para preguntar la hora: cotiza con estos y lo aclara.
export const RETIRO_POR_DEFECTO = '07:00';
export const DEVOLUCION_POR_DEFECTO = '20:00';

const SOLO_FECHA = /^\d{4}-\d{2}-\d{2}$/;

// Completa la hora cuando llega solo la fecha y calcula los días. Lo usan
// server.js y el eval, para que los dos coticen exactamente igual.
export function prepararRango(startDateTime, endDateTime) {
  const retiroEstimado = SOLO_FECHA.test(startDateTime);
  const devolucionEstimada = SOLO_FECHA.test(endDateTime);
  const start = retiroEstimado ? `${startDateTime}T${RETIRO_POR_DEFECTO}:00` : startDateTime;
  const end = devolucionEstimada ? `${endDateTime}T${DEVOLUCION_POR_DEFECTO}:00` : endDateTime;
  return {
    startDateTime: start,
    endDateTime: end,
    retiro: start.slice(11, 16),
    devolucion: end.slice(11, 16),
    horariosEstimados: retiroEstimado || devolucionEstimada,
    dias: diasDeAlquiler(start, end),
  };
}

// Respuesta de la herramienta cuando el período no llega al mínimo: no se
// muestran autos, y el rechazo sale del mismo cálculo que el precio.
export function respuestaMinimoNoCumplido(rango) {
  return {
    minimoNoCumplido: true,
    dias: rango.dias,
    retiro: rango.retiro,
    devolucion: rango.devolucion,
    horariosEstimados: rango.horariosEstimados,
    instruccion:
      `El período da ${rango.dias} ${rango.dias === 1 ? 'día' : 'días'} (bloques de 24 horas desde la hora de retiro` +
      `${rango.horariosEstimados ? `, con horarios estimados de retiro ${rango.retiro} y devolución ${rango.devolucion}` : ''}). ` +
      `Florida Aventura no alquila por menos de ${MINIMO_DIAS} días: informáselo al cliente con amabilidad y firmeza, ` +
      'sin excepciones ni alternativas, sin derivar a Patricia ni pasar el WhatsApp. No muestres autos ni precios.',
  };
}

// Descuento por alquiler largo (Patricia, 23/9/2026): 10% sobre el alquiler
// desde 17 días inclusive. No se aplica al SunPass ni al Puerto de Cruceros.
export const DESCUENTO_DESDE_DIAS = 17;
export const DESCUENTO_PORCENTAJE = 10;

// Cargo fijo por viaje según destino (prompt.js, sección SUNPASS).
const SUNPASS_POR_DESTINO = {
  'isla morada': 15,
  naples: 20,
  'key west': 20.7,
  clearwater: 24.7,
  daytona: 30,
  'west palm beach': 32.5,
  orlando: 38,
};

export const CARGO_PUERTO_CRUCEROS = 50;

function normalizarDestino(d) {
  return String(d)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

// Sin destinos fuera de Miami: USD 15 por semana o fracción (1-7 → 15, 8-14 → 30…).
// Con destinos: suma de los cargos fijos de cada uno, como indica el prompt.
export function cargoSunPass(dias, destinos) {
  const reconocidos = (destinos || [])
    .map(normalizarDestino)
    .filter((d) => d in SUNPASS_POR_DESTINO);

  if (!reconocidos.length) {
    return {
      monto: Math.ceil(dias / 7) * 15,
      detalle: 'tarifa base Miami (estimada: puede variar según los destinos del viaje)',
      esEstimado: true,
    };
  }

  const unicos = [...new Set(reconocidos)];
  return {
    monto: unicos.reduce((suma, d) => suma + SUNPASS_POR_DESTINO[d], 0),
    detalle: unicos.join(' + '),
    esEstimado: false,
  };
}

// Los montos con decimales van con coma, como en los ejemplos del prompt (USD 20,70).
export function formatoUSD(n) {
  const redondeado = Math.round(n * 100) / 100;
  return Number.isInteger(redondeado) ? String(redondeado) : redondeado.toFixed(2).replace('.', ',');
}

// Devuelve la línea 💵 ya armada para que el modelo la copie tal cual.
export function cotizarAuto(car, dias, sunPass, puertoDeCruceros) {
  if (dias == null || typeof car.pricePerDay !== 'number') return car;

  const alquilerSinDescuento = car.pricePerDay * dias;
  const conDescuento = dias >= DESCUENTO_DESDE_DIAS;
  const descuento = conDescuento ? Math.round(alquilerSinDescuento * DESCUENTO_PORCENTAJE) / 100 : 0;
  const alquiler = alquilerSinDescuento - descuento;
  const total = alquiler + sunPass.monto + (puertoDeCruceros ? CARGO_PUERTO_CRUCEROS : 0);

  // "base" se leía como "precio base" y el cliente asumía que después le cobraban
  // más. Nombrar el concepto (los días de alquiler) cierra esa lectura.
  const diasTxt = `${dias} ${dias === 1 ? 'día' : 'días'}`;
  const alquilerTxt = conDescuento
    ? `USD ${formatoUSD(alquiler)} por ${diasTxt} con ${DESCUENTO_PORCENTAJE}% de descuento`
    : `USD ${formatoUSD(alquiler)} por ${diasTxt}`;
  const partes = [alquilerTxt, `USD ${formatoUSD(sunPass.monto)} SunPass`];
  if (puertoDeCruceros) partes.push(`USD ${CARGO_PUERTO_CRUCEROS} Puerto de Cruceros`);

  return {
    ...car,
    dias,
    precioBase: formatoUSD(alquiler),
    ...(conDescuento
      ? {
          descuento: `${DESCUENTO_PORCENTAJE}%`,
          descuentoUSD: formatoUSD(descuento),
          alquilerSinDescuento: formatoUSD(alquilerSinDescuento),
        }
      : {}),
    sunPass: formatoUSD(sunPass.monto),
    sunPassDetalle: sunPass.detalle,
    total: formatoUSD(total),
    lineaTotal: `💵 Total: USD ${formatoUSD(total)} (${partes.join(' + ')})`,
  };
}
