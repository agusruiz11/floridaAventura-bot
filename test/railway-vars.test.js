// El bot guarda el token refrescado en su propia variable de Railway, sin
// redeployar. Railway es de mentira: no sale ningún pedido de verdad.
//   npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearGuardadoEnRailway } from '../railway-vars.js';

const DATOS = { apiToken: 'tok-proyecto', projectId: 'p1', environmentId: 'e1', serviceId: 's1' };
const respuesta = (status, cuerpo) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => { if (typeof cuerpo === 'string') throw new Error('no json'); return cuerpo; },
});

test('sin token de Railway o sin algún ID no hay dónde guardar', () => {
  assert.equal(crearGuardadoEnRailway({}), null);
  assert.equal(crearGuardadoEnRailway({ ...DATOS, apiToken: '' }), null);
  assert.equal(crearGuardadoEnRailway({ ...DATOS, apiToken: '   ' }), null);
  for (const k of ['projectId', 'environmentId', 'serviceId']) {
    assert.equal(crearGuardadoEnRailway({ ...DATOS, [k]: undefined }), null, k);
  }
});

test('escribe IG_ACCESS_TOKEN con skipDeploys y el header de token de proyecto', async () => {
  const pedidos = [];
  const guardar = crearGuardadoEnRailway({
    ...DATOS,
    fetchFn: async (url, opts) => { pedidos.push({ url, opts }); return respuesta(200, { data: { variableUpsert: true } }); },
  });
  assert.equal(await guardar('IGAA-nuevo'), true);
  assert.equal(pedidos.length, 1);
  assert.equal(pedidos[0].url, 'https://backboard.railway.com/graphql/v2');
  assert.equal(pedidos[0].opts.method, 'POST');
  assert.equal(pedidos[0].opts.headers['Project-Access-Token'], 'tok-proyecto');
  assert.equal(pedidos[0].opts.headers.Authorization, undefined);
  const body = JSON.parse(pedidos[0].opts.body);
  assert.match(body.query, /mutation variableUpsert\(\$input: VariableUpsertInput!\)/);
  assert.deepEqual(body.variables.input, {
    projectId: 'p1', environmentId: 'e1', serviceId: 's1',
    name: 'IG_ACCESS_TOKEN', value: 'IGAA-nuevo', skipDeploys: true,
  });
});

test('los errores nunca incluyen el valor ni el token de Railway', async () => {
  const VALOR = 'IGAAvalorSecreto0123456789abcdef';
  const casos = [
    [async () => respuesta(401, {}), /Railway respondió 401/],
    [async () => respuesta(200, { errors: [{ message: 'Not Authorized' }] }), /Railway rechazó el cambio: Not Authorized/],
    [async () => respuesta(200, { data: { variableUpsert: false } }), /no confirmó/],
    [async () => respuesta(200, 'html'), /respuesta sin datos/],
    [async () => { throw new TypeError(`fetch failed ${VALOR}`); }, /error de red \(TypeError\)/],
  ];
  for (const [fetchFn, esperado] of casos) {
    const guardar = crearGuardadoEnRailway({ ...DATOS, fetchFn });
    await assert.rejects(() => guardar(VALOR), (err) => {
      assert.match(err.message, esperado);
      assert.ok(!err.message.includes(VALOR) && !err.message.includes('tok-proyecto'), err.message);
      return true;
    });
  }
});

test('no escribe un valor vacío', async () => {
  let llamadas = 0;
  const guardar = crearGuardadoEnRailway({ ...DATOS, fetchFn: async () => { llamadas++; return respuesta(200, { data: { variableUpsert: true } }); } });
  await assert.rejects(() => guardar(''), /valor vacío/);
  await assert.rejects(() => guardar(undefined), /valor vacío/);
  assert.equal(llamadas, 0);
});
