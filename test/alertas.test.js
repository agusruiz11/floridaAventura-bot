// Las alertas salen una vez por clave dentro de la ventana, van a Slack si hay
// webhook y nunca tiran aunque Slack esté caído.
//   npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearAlertas } from '../alertas.js';

const HORA = 60 * 60 * 1000;

function armar({ webhookUrl = 'https://hooks.slack.test/abc', fetchFn } = {}) {
  let reloj = 1_000_000;
  const pedidos = [];
  const logs = [];
  const alertas = crearAlertas({
    webhookUrl, bot: 'Florida Aventura',
    ahora: () => reloj,
    log: (l) => logs.push(l),
    fetchFn: fetchFn || (async (url, opts) => { pedidos.push({ url, opts }); return { ok: true, status: 200 }; }),
  });
  return { alertas, pedidos, logs, avanzar: (ms) => { reloj += ms; } };
}

test('manda el aviso a Slack con el nombre del bot y lo deja en el log', async () => {
  const { alertas, pedidos, logs } = armar();
  assert.equal(await alertas.alertar('token-190', 'el token no sirve'), true);
  assert.equal(pedidos.length, 1);
  assert.equal(pedidos[0].url, 'https://hooks.slack.test/abc');
  assert.equal(pedidos[0].opts.method, 'POST');
  assert.deepEqual(JSON.parse(pedidos[0].opts.body), { text: '*Florida Aventura*: el token no sirve' });
  assert.deepEqual(logs, ['[alerta] el token no sirve']);
});

test('la misma clave no se repite dentro de la ventana; otra clave sí sale', async () => {
  const { alertas, pedidos, avanzar } = armar();
  await alertas.alertar('token-190', 'a');
  avanzar(5 * HORA);
  assert.equal(await alertas.alertar('token-190', 'a'), false);
  assert.equal(await alertas.alertar('token-vence', 'b'), true);
  assert.equal(pedidos.length, 2);
  avanzar(HORA); // se cumplen las 6 hs por defecto
  assert.equal(await alertas.alertar('token-190', 'a'), true);
  assert.equal(pedidos.length, 3);
});

test('cadaMs propio por alerta', async () => {
  const { alertas, pedidos, avanzar } = armar();
  await alertas.alertar('token-vence', 'x', { cadaMs: 24 * HORA });
  avanzar(23 * HORA);
  assert.equal(await alertas.alertar('token-vence', 'x', { cadaMs: 24 * HORA }), false);
  avanzar(HORA);
  assert.equal(await alertas.alertar('token-vence', 'x', { cadaMs: 24 * HORA }), true);
  assert.equal(pedidos.length, 2);
});

test('sin webhook solo loguea', async () => {
  const { alertas, pedidos, logs } = armar({ webhookUrl: '' });
  assert.equal(alertas.conSlack, false);
  assert.equal(await alertas.alertar('k', 'hola'), true);
  assert.equal(pedidos.length, 0);
  assert.deepEqual(logs, ['[alerta] hola']);
});

test('Slack caído o respondiendo error: no tira y reintenta a los 5 minutos', async () => {
  let falla = true;
  const pedidos = [];
  const a = armar({ fetchFn: async (url) => { pedidos.push(url); if (falla) throw new TypeError('fetch failed'); return { ok: true, status: 200 }; } });
  assert.equal(await a.alertas.alertar('k', 'hola'), false);
  assert.ok(a.logs.some((l) => l.includes('El aviso no llegó a Slack: error de red')));
  a.avanzar(4 * 60 * 1000);
  assert.equal(await a.alertas.alertar('k', 'hola'), false, 'antes de 5 min no insiste');
  assert.equal(pedidos.length, 1);
  falla = false;
  a.avanzar(60 * 1000);
  assert.equal(await a.alertas.alertar('k', 'hola'), true, 'no esperó las 6 hs');
  assert.equal(pedidos.length, 2);
  assert.equal(await a.alertas.alertar('k', 'hola'), false, 'ahora sí rige la ventana completa');

  const con500 = armar({ fetchFn: async () => ({ ok: false, status: 500 }) });
  assert.equal(await con500.alertas.alertar('k', 'hola'), false);
  assert.ok(con500.logs.some((l) => l.includes('Slack respondió 500')));
});

test('webhook mal escrito: se apaga Slack y la URL no aparece en el log', async () => {
  const a = armar({ webhookUrl: 'hooks.slack.com/services/T000/B000/SECRETO' });
  assert.equal(a.alertas.conSlack, false);
  assert.equal(await a.alertas.alertar('k', 'hola'), true);
  assert.equal(a.pedidos.length, 0);
  assert.ok(a.logs.some((l) => l.includes('no es una URL válida')));
  assert.ok(!a.logs.join('\n').includes('SECRETO'));
});
