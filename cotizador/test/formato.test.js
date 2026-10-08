// El mensaje que arma el cotizador tiene que ser igual al que manda el bot.
// Los textos esperados están copiados de los logs de Railway del 7/10/2026.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cargoSunPass, cotizarAuto, prepararRango } from '../../cotizacion.js';
import { bloqueAuto, cierre, mensajesInstagram, nombreAuto, textoFechas } from '../formato.js';

const HRV = { name: 'Honda HRV', year: 2025, type: 'SMALL', passengersAmount: 5, suitcasesAmount: 2, pricePerDay: 55 };
const ATLAS = { name: 'Volkswagen Atlas(Negra)', year: 2025, type: 'LARGE', passengersAmount: 7, suitcasesAmount: 5, pricePerDay: 65 };

test('bloque de auto igual al del bot (22 de mayo al 4 de junio, Orlando)', () => {
  const rango = prepararRango('2027-05-22', '2027-06-04');
  const sunPass = cargoSunPass(rango.dias, ['Orlando']);
  const car = cotizarAuto(HRV, rango.dias, sunPass, false);
  assert.equal(bloqueAuto(car, rango), [
    '🚗 Honda HRV 2025 — Chico',
    '📅 Del 22 de mayo al 4 de junio · Retiro 07:00, devolución 20:00 (horarios estimados)',
    '💰 USD 55/día × 14 días | 👥 5 pasajeros | 🧳 aprox. 2 valijas | ✅ Seguro incluido | 🛣️ KM ilimitado (solo Florida) | ⛽ Tanque lleno al retirar y al devolver | 👤 1 conductor adicional incluido',
    '💵 Total: USD 808 (USD 770 por 14 días + USD 38 SunPass)',
  ].join('\n'));
});

test('auto de 7 pasajeros lleva el aviso de la tercera fila y el nombre con el color separado', () => {
  const rango = prepararRango('2027-05-22', '2027-06-04');
  const car = cotizarAuto(ATLAS, rango.dias, cargoSunPass(rango.dias, ['Orlando']), false);
  const bloque = bloqueAuto(car, rango);
  assert.ok(bloque.startsWith('🚗 Volkswagen Atlas (Negra) 2025 — Grande\n'));
  assert.ok(bloque.includes('💵 Total: USD 948 (USD 910 por 14 días + USD 38 SunPass)'));
  assert.ok(bloque.endsWith('Si viajan con valijas, el auto entra cómodamente 5 personas.'));
});

test('fechas en el mismo mes y con horarios dados', () => {
  assert.equal(textoFechas('2026-10-12T10:00:00', '2026-10-27T10:00:00'), 'Del 12 al 27 de octubre');
  const rango = prepararRango('2026-10-12T10:00:00', '2026-10-27T10:00:00');
  const car = cotizarAuto(HRV, rango.dias, cargoSunPass(rango.dias, []), false);
  const bloque = bloqueAuto(car, rango);
  assert.ok(bloque.includes('📅 Del 12 al 27 de octubre · Retiro 10:00, devolución 10:00\n'));
  assert.ok(bloque.includes('× 15 días'));
});

test('cierre: horarios estimados, SunPass estimado, descuento y aviso', () => {
  const rango = prepararRango('2027-05-01', '2027-05-20');
  const sunPass = cargoSunPass(rango.dias, []);
  const autos = [cotizarAuto(HRV, rango.dias, sunPass, false)];
  const texto = cierre({ autos, rango, sunPass });
  assert.ok(texto.includes('Coticé con retiro a las 07:00 y devolución a las 20:00.'));
  assert.ok(texto.includes('ya tiene aplicado un 10% de descuento sobre el alquiler'));
  assert.ok(texto.includes(`El cargo de SunPass estimado es de USD ${sunPass.monto}`));
  assert.ok(texto.includes('📋 Estos valores son una estimación orientativa.'));
  assert.ok(texto.endsWith('¿Te sirve esta opción?'));
});

test('cierre sin aclaraciones cuando hay horarios y destinos', () => {
  const rango = prepararRango('2026-11-03T10:00:00', '2026-11-10T10:00:00');
  const sunPass = cargoSunPass(rango.dias, ['Orlando']);
  const autos = [HRV, ATLAS].map((c) => cotizarAuto(c, rango.dias, sunPass, false));
  const texto = cierre({ autos, rango, sunPass });
  assert.ok(texto.startsWith('📋 Estos valores'));
  assert.ok(texto.endsWith('¿Alguna de estas opciones te sirve?'));
});

test('un mensaje por auto más el cierre, ninguno pasa de 950 caracteres', () => {
  const rango = prepararRango('2027-05-22', '2027-06-04');
  const sunPass = cargoSunPass(rango.dias, ['Orlando']);
  const autos = [HRV, ATLAS].map((c) => cotizarAuto(c, rango.dias, sunPass, false));
  const mensajes = mensajesInstagram({ autos, rango, sunPass });
  assert.equal(mensajes.length, 3);
  for (const m of mensajes) assert.ok(m.length <= 950);
});

test('nombre sin año', () => {
  assert.equal(nombreAuto({ name: 'Nissan Kicks' }), 'Nissan Kicks');
});
