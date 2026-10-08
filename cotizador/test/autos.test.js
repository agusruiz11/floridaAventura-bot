import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armarFechaHora, buscarAutos, validarRango } from '../autos.js';

const HOY = '2026-10-07';
const API = [
  { name: 'Honda HRV', year: 2025, type: 'SMALL', passengersAmount: 5, suitcasesAmount: 2, pricePerDay: 55, imageUrl: 'https://img/hrv.jpg' },
  { name: 'Honda HRV', year: 2025, type: 'SMALL', passengersAmount: 5, suitcasesAmount: 2, pricePerDay: 55 },
  { name: 'Nissan Rogue(Blanca)', year: 2024, type: 'MEDIUM', passengersAmount: 5, suitcasesAmount: 3, pricePerDay: 59 },
];
const fetchFalso = (pedidos = []) => async (url) => { pedidos.push(String(url)); return { ok: true, json: async () => API }; };

test('fecha y hora se arman como las espera la cotización', () => {
  assert.equal(armarFechaHora('2026-10-12', '10:00'), '2026-10-12T10:00:00');
  assert.equal(armarFechaHora('2026-10-12', ''), '2026-10-12');
});

test('busca, quita duplicados y cotiza con las reglas del bot', async () => {
  const pedidos = [];
  const r = await buscarAutos(
    { startDateTime: '2026-10-12T10:00:00', endDateTime: '2026-10-27T10:00:00', destinos: [] },
    { fetchImpl: fetchFalso(pedidos), hoy: HOY },
  );
  assert.equal(r.ok, true);
  assert.equal(r.rango.dias, 15);
  assert.equal(r.autos.length, 2);
  assert.equal(r.sunPass.monto, 45);
  assert.equal(r.autos[0].lineaTotal, '💵 Total: USD 870 (USD 825 por 15 días + USD 45 SunPass)');
  assert.ok(pedidos[0].includes('/availability?startDateTime=2026-10-12T10%3A00%3A00&endDateTime=2026-10-27T10%3A00%3A00'));
});

test('sin horarios usa 07:00 y 20:00 y lo marca como estimado', async () => {
  const r = await buscarAutos({ startDateTime: '2026-10-12', endDateTime: '2026-10-20' }, { fetchImpl: fetchFalso(), hoy: HOY });
  assert.equal(r.rango.horariosEstimados, true);
  assert.equal(r.rango.retiro, '07:00');
  assert.equal(r.rango.dias, 9);
});

test('fecha pasada, devolución anterior y mínimo se cortan antes de consultar', async () => {
  const pedidos = [];
  const opciones = { fetchImpl: fetchFalso(pedidos), hoy: HOY };
  assert.match((await buscarAutos({ startDateTime: '2026-01-23', endDateTime: '2026-01-31' }, opciones)).error, /ya pasó/);
  assert.match((await buscarAutos({ startDateTime: '2026-11-10', endDateTime: '2026-11-05' }, opciones)).error, /posterior/);
  const corto = await buscarAutos({ startDateTime: '2026-11-10T10:00:00', endDateTime: '2026-11-12T10:00:00' }, opciones);
  assert.equal(corto.minimoNoCumplido, true);
  assert.equal(corto.dias, 2);
  assert.equal(pedidos.length, 0);
});

test('retiro a más de 11 meses: cotiza y avisa que hay que confirmar el año', () => {
  const r = validarRango('2027-10-12T10:00:00', '2027-10-27T10:00:00', { hoy: HOY });
  assert.equal(r.ok, true);
  assert.match(r.avisos[0], /Confirmá el año/);
  assert.equal(validarRango('2026-10-12', '2026-10-27', { hoy: HOY }).avisos.length, 0);
});
