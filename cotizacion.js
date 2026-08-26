// Cotización de alquileres — módulo compartido.
//
// Vive acá y no en server.js porque el eval (eval/run-eval.js) tiene que cotizar
// EXACTAMENTE igual que producción. Cuando esta lógica estaba duplicada, el mock
// del eval devolvía autos sin cotizar y la categoría B daba PASS sin haber
// probado un solo total. Una sola fuente de verdad: si cambia el criterio de
// días o el SunPass, cambia para los dos.

// Días de alquiler contando AMBOS extremos: 13 al 18 = 6 días.
// Compara solo la parte de fecha en UTC para que el horario de retiro/devolución
// y los cambios de horario de verano no muevan la cuenta.
export function diasDeAlquiler(startDateTime, endDateTime) {
  const inicio = Date.parse(`${startDateTime.slice(0, 10)}T00:00:00Z`);
  const fin = Date.parse(`${endDateTime.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(inicio) || Number.isNaN(fin)) return null;
  const dias = Math.round((fin - inicio) / 86_400_000) + 1;
  return dias > 0 ? dias : null;
}

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

  const base = car.pricePerDay * dias;
  const total = base + sunPass.monto + (puertoDeCruceros ? CARGO_PUERTO_CRUCEROS : 0);

  // "base" se leía como "precio base" y el cliente asumía que después le cobraban
  // más. Nombrar el concepto (los días de alquiler) cierra esa lectura.
  const partes = [`USD ${formatoUSD(base)} por ${dias} ${dias === 1 ? 'día' : 'días'}`, `USD ${formatoUSD(sunPass.monto)} SunPass`];
  if (puertoDeCruceros) partes.push(`USD ${CARGO_PUERTO_CRUCEROS} Puerto de Cruceros`);

  return {
    ...car,
    dias,
    precioBase: formatoUSD(base),
    sunPass: formatoUSD(sunPass.monto),
    sunPassDetalle: sunPass.detalle,
    total: formatoUSD(total),
    lineaTotal: `💵 Total: USD ${formatoUSD(total)} (${partes.join(' + ')})`,
  };
}
