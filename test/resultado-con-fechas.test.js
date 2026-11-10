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
