// Con fechas, buscar_autos nombra aparte los autos de la flota que están
// ocupados, para que el modelo no diga "no lo tenemos" de un auto que existe.
//   npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resultadoConFechas } from '../cotizacion.js';

const flota = [{ name: 'Nissan Kicks' }, { name: 'Nissan New Kicks' }, { name: 'Honda CRV' }];

test('si hay autos ocupados, los nombra aparte y deja los libres en autosDisponibles', () => {
  const libres = [{ name: 'Nissan Kicks', total: '678' }, { name: 'Honda CRV', total: '774' }];
  const r = resultadoConFechas(libres, flota);
  assert.deepEqual(r.autosDisponibles, libres);
  assert.deepEqual(r.noDisponiblesEnEstasFechas, ['Nissan New Kicks']);
  assert.match(r.nota, /no está disponible para esas fechas/);
});

test('si están todos libres, queda la lista de siempre', () => {
  const libres = flota.map((c) => ({ ...c, total: '1' }));
  assert.deepEqual(resultadoConFechas(libres, flota), libres);
});

test('sin la flota (falló /cars), queda la lista de siempre', () => {
  const libres = [{ name: 'Nissan Kicks' }];
  assert.deepEqual(resultadoConFechas(libres, null), libres);
  assert.deepEqual(resultadoConFechas(libres, []), libres);
});

test('colores repetidos de la flota no se duplican', () => {
  const r = resultadoConFechas([], [{ name: 'VW Atlas' }, { name: 'VW Atlas' }]);
  assert.deepEqual(r.noDisponiblesEnEstasFechas, ['VW Atlas']);
});

test('fecha ya pasada con el año en curso: se corre al año siguiente', async () => {
  const { pasarAlAnioSiguiente } = await import('../cotizacion.js');
  const r = pasarAlAnioSiguiente('2026-01-03T07:00:00', '2026-01-08T20:00:00', '2026-11-10');
  assert.equal(r.startDateTime, '2027-01-03T07:00:00');
  assert.equal(r.endDateTime, '2027-01-08T20:00:00');
  assert.match(r.aviso, /ya pasó/);
  // Un rango que cruza el año también se corre entero.
  assert.equal(pasarAlAnioSiguiente('2025-12-28T07:00:00', '2026-01-05T20:00:00', '2026-11-10').endDateTime, '2027-01-05T20:00:00');
});

test('no corre fechas futuras, de hace más de un año, ni un 29/2 que no existe', async () => {
  const { pasarAlAnioSiguiente } = await import('../cotizacion.js');
  assert.equal(pasarAlAnioSiguiente('2027-01-03T07:00:00', '2027-01-08T20:00:00', '2026-11-10'), null);
  assert.equal(pasarAlAnioSiguiente('2026-11-10T07:00:00', '2026-11-15T20:00:00', '2026-11-10'), null);
  assert.equal(pasarAlAnioSiguiente('2024-01-03T07:00:00', '2024-01-08T20:00:00', '2026-11-10'), null);
  assert.equal(pasarAlAnioSiguiente('2024-02-29T07:00:00', '2024-03-05T20:00:00', '2024-11-10'), null);
});

test('con el año corrido, el resultado lleva el aviso aunque no haya ocupados', () => {
  const libres = flota.map((c) => ({ ...c, total: '1' }));
  const r = resultadoConFechas(libres, flota, { avisoAnio: 'se cotizó 2027' });
  assert.deepEqual(r.autosDisponibles, libres);
  assert.equal(r.fechasCorridasAlAnioSiguiente, 'se cotizó 2027');
  assert.equal(r.noDisponiblesEnEstasFechas, undefined);
});
