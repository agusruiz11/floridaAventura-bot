// Levanta cotizador/server.js contra un mock de la API de Florida Aventura y de
// la API de Anthropic. Cubre el acceso, la lectura, la búsqueda y la cotización
// con valores modificados a mano.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLAVE = 'clave-de-prueba';
const AUTOS = [
  { name: 'Honda HRV', year: 2025, type: 'SMALL', passengersAmount: 5, suitcasesAmount: 2, pricePerDay: 55, imageUrl: 'https://img.test/hrv.jpg' },
  { name: 'Volkswagen Atlas(Negra)', year: 2025, type: 'LARGE', passengersAmount: 7, suitcasesAmount: 5, pricePerDay: 65, imageUrl: 'https://img.test/atlas.jpg' },
];
const EXTRAIDO = {
  retiroFecha: '2027-10-12', retiroHora: '10:00', devolucionFecha: '2027-10-27', devolucionHora: '10:00',
  lugarEntrega: 'Miami airport', lugarDevolucion: null, categoria: 'suv', pasajeros: 4, valijas: null,
  destinos: [], puertoDeCruceros: false, dudas: ['"12-10-27": ¿año 2027 o error de tipeo?'],
  campoInventado: 'no tiene que pasar',
};

async function levantar(t) {
  const pedidosModelo = [];
  const mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url.startsWith('/fa/availability')) return res.end(JSON.stringify(AUTOS));
      if (req.url.startsWith('/v1/messages')) {
        pedidosModelo.push(JSON.parse(body));
        return res.end(JSON.stringify({
          id: 'msg_test', type: 'message', role: 'assistant', model: 'test',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'registrar_datos', input: EXTRAIDO }],
          stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
        }));
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise((r) => mock.listen(0, r));
  const MOCK = `http://localhost:${mock.address().port}`;
  t.after(() => mock.close());

  const PORT = 5100 + Math.floor(Math.random() * 800);
  const srv = spawn(process.execPath, ['cotizador/server.js'], {
    cwd: RAIZ,
    env: {
      ...process.env, PORT: String(PORT), DOTENV_CONFIG_PATH: '/dev/null',
      COTIZADOR_CLAVE: CLAVE, FA_API_BASE: `${MOCK}/fa`, FA_API_TOKEN: 'test',
      ANTHROPIC_API_KEY: 'test', ANTHROPIC_BASE_URL: MOCK,
    },
  });
  t.after(() => srv.kill());
  let log = '';
  srv.stdout.on('data', (d) => { log += d; });
  srv.stderr.on('data', (d) => { log += d; });
  const fin = Date.now() + 5000;
  while (!log.includes('corriendo')) {
    if (Date.now() > fin) throw new Error(`timeout. Log:\n${log}`);
    await new Promise((r) => setTimeout(r, 25));
  }

  const base = `http://localhost:${PORT}`;
  let cookie = '';
  const post = async (ruta, cuerpo) => {
    const res = await fetch(base + ruta, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(cuerpo || {}),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  const get = (ruta) => fetch(base + ruta, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
  return { post, get, pedidosModelo, salir: () => { cookie = ''; } };
}

const VIAJE = { retiroFecha: '2027-10-12', retiroHora: '10:00', devolucionFecha: '2027-10-27', devolucionHora: '10:00', destinos: [], puertoDeCruceros: false };

test('sin clave no se ve nada; con clave sí', async (t) => {
  const { post, get } = await levantar(t);
  assert.equal((await get('/')).status, 302);
  assert.equal((await get('/app.js')).status, 302);
  assert.equal((await get('/entrar.html')).status, 200);
  assert.equal((await post('/api/buscar', VIAJE)).status, 401);
  assert.equal((await post('/api/cotizar', {})).status, 401);
  assert.equal((await post('/api/leer', { mensajes: 'hola' })).status, 401);

  assert.equal((await post('/api/entrar', { clave: 'otra' })).status, 401);
  assert.equal((await post('/api/entrar', { clave: CLAVE })).status, 200);
  assert.equal((await get('/')).status, 200);
});

test('una cookie inventada no abre la puerta', async (t) => {
  const { get } = await levantar(t);
  const res = await fetch((await get('/entrar.html')).url.replace('/entrar.html', '/'), {
    redirect: 'manual', headers: { Cookie: `cz_sesion=${Date.now() + 1e9}.${'a'.repeat(64)}` },
  });
  assert.equal(res.status, 302);
});

test('leer: devuelve solo los campos esperados y el texto va como dato', async (t) => {
  const { post, pedidosModelo } = await levantar(t);
  await post('/api/entrar', { clave: CLAVE });
  const r = await post('/api/leer', { mensajes: '12-10-27 a 27-10-27 4 pax, suv , Miami airport\n10hs retiro\n10hs devolución' });
  assert.equal(r.status, 200);
  assert.equal(r.data.datos.retiroFecha, '2027-10-12');
  assert.equal(r.data.datos.pasajeros, 4);
  assert.equal(r.data.datos.valijas, null);
  assert.equal(r.data.datos.dudas.length, 1);
  assert.ok(!('campoInventado' in r.data.datos));
  assert.equal(pedidosModelo[0].tool_choice.name, 'registrar_datos');
  assert.ok(pedidosModelo[0].messages[0].content.includes('4 pax'));
  assert.equal((await post('/api/leer', { mensajes: '' })).status, 400);
});

test('buscar y cotizar: los totales salen de las reglas y los ajustes quedan marcados', async (t) => {
  const { post } = await levantar(t);
  await post('/api/entrar', { clave: CLAVE });

  const b = await post('/api/buscar', VIAJE);
  assert.equal(b.data.ok, true);
  assert.equal(b.data.rango.dias, 15);
  assert.equal(b.data.autos.length, 2);
  assert.equal(b.data.autos[0].lineaTotal, '💵 Total: USD 870 (USD 825 por 15 días + USD 45 SunPass)');
  assert.match(b.data.avisos[0], /Confirmá el año/);

  const autos = b.data.autos.map((a, i) => ({ ...a, elegido: i === 0 }));

  // Sin tocar nada: igual a la búsqueda, un mensaje por auto elegido más el cierre.
  const c1 = await post('/api/cotizar', { viaje: VIAJE, ajustes: {}, autos });
  assert.equal(c1.data.autos[0].total, '870');
  assert.equal(c1.data.sunPass.manual, false);
  assert.equal(c1.data.mensajes.length, 2);
  assert.ok(c1.data.mensajes[0].startsWith('🚗 Honda HRV 2025 — Chico'));

  // Patricia cambia días, SunPass y precio: recalcula el servidor.
  autos[0].pricePerDay = 50;
  const c2 = await post('/api/cotizar', { viaje: VIAJE, ajustes: { dias: 17, sunPass: 38 }, autos });
  assert.equal(c2.data.dias, 17);
  assert.equal(c2.data.diasRegla, 15);
  assert.equal(c2.data.sunPass.manual, true);
  assert.equal(c2.data.autos[0].descuento, '10%');
  assert.equal(c2.data.autos[0].lineaTotal, '💵 Total: USD 803 (USD 765 por 17 días con 10% de descuento + USD 38 SunPass)');
  assert.ok(c2.data.mensajes.at(-1).includes('10% de descuento'));
  // El auto no elegido igual vuelve con su total al día.
  assert.equal(c2.data.autos[1].elegido, false);
  assert.ok(c2.data.autos[1].total);

  // Valores fuera de rango no pasan.
  assert.equal((await post('/api/cotizar', { viaje: VIAJE, ajustes: { dias: 0 }, autos })).status, 400);
  autos[0].pricePerDay = -5;
  assert.equal((await post('/api/cotizar', { viaje: VIAJE, ajustes: {}, autos })).status, 400);
});

test('menos del mínimo: no muestra autos', async (t) => {
  const { post } = await levantar(t);
  await post('/api/entrar', { clave: CLAVE });
  const r = await post('/api/buscar', { ...VIAJE, devolucionFecha: '2027-10-14' });
  assert.equal(r.data.ok, false);
  assert.match(r.data.error, /mínimo de alquiler es de 4/);
});
