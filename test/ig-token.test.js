// El token de Instagram se refresca solo, se guarda lo que devuelve Meta, y el
// bot avisa cuando el token no sirve o está por vencer. Meta, el reloj y el disco
// son de mentira: no sale ningún pedido de verdad.
//   npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crearTokenIg, errorDeToken } from '../ig-token.js';

const DIA = 24 * 60 * 60 * 1000;
const SESENTA_DIAS_S = 60 * 24 * 60 * 60;
const VENCIDO = { error: { message: 'Error validating access token: Session has expired on Monday, 05-Oct-26 08:01:43 PDT.', type: 'OAuthException', code: 190 } };
const MUY_NUEVO = { error: { message: 'Token is too young to refresh', type: 'OAuthException', code: 100 } };

const respuesta = (status, cuerpo) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo)),
});

// Meta de mentira: `refresco` y `me` son funciones (token) => [status, cuerpo].
function armar(t, {
  envToken = 'IGAA-env',
  base = 'https://graph.instagram.com/v21.0',
  refresco = (tok) => [200, { access_token: tok, token_type: 'bearer', expires_in: SESENTA_DIAS_S }],
  me = () => [200, { id: '123' }],
  conArchivo = true,
  refrescoActivo = true,
  persistir = null,
  dir,
} = {}) {
  dir = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'ig-token-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const archivo = conArchivo ? path.join(dir, 'data', 'ig-token.json') : '';
  const estado = { reloj: Date.UTC(2026, 9, 5), refresco, me };
  const pedidos = [];
  const alertas = [];
  const logs = [];
  const igToken = crearTokenIg({
    envToken, base, archivo, refrescoActivo, persistir,
    ahora: () => estado.reloj,
    log: (l) => logs.push(l),
    warn: (l) => logs.push(l),
    alertar: async (clave, texto, opts) => { alertas.push({ clave, texto, opts }); return true; },
    fetchFn: async (url) => {
      const u = new URL(url);
      const tok = u.searchParams.get('access_token');
      pedidos.push({ ruta: u.origin + u.pathname, tok, grant: u.searchParams.get('grant_type') });
      if (u.pathname === '/refresh_access_token') return respuesta(...estado.refresco(tok));
      if (u.pathname.endsWith('/me')) return respuesta(...estado.me(tok));
      return respuesta(404, {});
    },
  });
  return {
    igToken, pedidos, alertas, logs, archivo, dir, estado,
    avanzar: (ms) => { estado.reloj += ms; },
  };
}

test('errorDeToken reconoce el code 190 en texto u objeto y nada más', () => {
  assert.match(errorDeToken(JSON.stringify(VENCIDO)), /Session has expired/);
  assert.match(errorDeToken(VENCIDO), /Session has expired/);
  assert.equal(errorDeToken(JSON.stringify({ error: { code: 100, message: 'otro' } })), null);
  assert.equal(errorDeToken('<html>502</html>'), null);
  assert.equal(errorDeToken(''), null);
  assert.equal(errorDeToken(null), null);
  assert.equal(errorDeToken(undefined), null);
});

test('refresca al revisar, usa el endpoint de Instagram y deja el vencimiento', async (t) => {
  const { igToken, pedidos, alertas, logs } = armar(t);
  assert.equal(igToken.token(), 'IGAA-env');
  await igToken.revisar();
  assert.deepEqual(pedidos, [{ ruta: 'https://graph.instagram.com/refresh_access_token', tok: 'IGAA-env', grant: 'ig_refresh_token' }]);
  assert.equal(igToken.token(), 'IGAA-env');
  assert.equal(igToken.estado().expiraEn, Date.UTC(2026, 9, 5) + 60 * DIA);
  assert.ok(logs.some((l) => l.includes('[token] Refrescado: vence en 60 días (2026-12-04)')));
  assert.ok(logs.some((l) => l.includes('[token] OK: vence en 60 días')));
  assert.equal(alertas.length, 0);
});

test('no vuelve a refrescar hasta que pasen 7 días', async (t) => {
  const { igToken, pedidos, avanzar } = armar(t);
  await igToken.revisar();
  avanzar(6 * DIA);
  await igToken.revisar();
  assert.equal(pedidos.length, 1);
  avanzar(DIA);
  await igToken.revisar();
  assert.equal(pedidos.length, 2);
});

test('si Meta devuelve otro token lo usa, lo guarda y avisa que falta el volumen', async (t) => {
  const { igToken, alertas, archivo, logs } = armar(t, {
    refresco: () => [200, { access_token: 'IGAA-nuevo', expires_in: SESENTA_DIAS_S }],
  });
  await igToken.revisar();
  assert.equal(igToken.token(), 'IGAA-nuevo');
  const guardado = JSON.parse(fs.readFileSync(archivo, 'utf8'));
  assert.equal(guardado.token, 'IGAA-nuevo');
  assert.ok(!JSON.stringify(guardado).includes('IGAA-env'), 'del token de la variable solo va el hash');
  assert.equal(fs.statSync(archivo).mode & 0o777, 0o600);
  assert.deepEqual(alertas.map((a) => a.clave), ['token-rota']);
  assert.ok(logs.some((l) => l.includes('Meta devolvió un token distinto')));
});

test('con persistir: el token nuevo va a la variable y no avisa que falta volumen', async (t) => {
  const guardados = [];
  const { igToken, alertas, logs } = armar(t, {
    refresco: () => [200, { access_token: 'IGAA-nuevo', expires_in: SESENTA_DIAS_S }],
    persistir: async (v) => { guardados.push(v); },
  });
  await igToken.revisar();
  assert.deepEqual(guardados, ['IGAA-nuevo']);
  assert.equal(igToken.token(), 'IGAA-nuevo');
  assert.equal(alertas.length, 0);
  assert.ok(logs.some((l) => l.includes('guardado en la variable IG_ACCESS_TOKEN de Railway')));
});

test('con persistir: si Meta devuelve el mismo token no escribe nada', async (t) => {
  const guardados = [];
  const { igToken } = armar(t, { persistir: async (v) => { guardados.push(v); } });
  await igToken.revisar();
  assert.deepEqual(guardados, []);
});

test('con persistir que falla: usa el token nuevo igual, avisa y no filtra el token', async (t) => {
  const NUEVO = 'IGAAsecretoRefrescado0123456789ab';
  const { igToken, alertas, logs } = armar(t, {
    refresco: () => [200, { access_token: NUEVO, expires_in: SESENTA_DIAS_S }],
    persistir: async (v) => { throw new Error(`Railway rechazó el cambio: valor ${v}`); },
  });
  await igToken.revisar();
  assert.equal(igToken.token(), NUEVO);
  assert.ok(igToken.estado().expiraEn);
  assert.deepEqual(alertas.map((a) => a.clave), ['token-rota']);
  assert.ok(logs.some((l) => l.includes('No pude guardar el token nuevo en la variable de Railway')));
  assert.ok(!(logs.join('\n') + JSON.stringify(alertas)).includes('secreto'));
});

test('al reiniciar con el mismo token en la variable, retoma el guardado y no avisa', async (t) => {
  const primero = armar(t, { refresco: () => [200, { access_token: 'IGAA-nuevo', expires_in: SESENTA_DIAS_S }] });
  await primero.igToken.revisar();

  const segundo = armar(t, {
    dir: primero.dir,
    refresco: () => [200, { access_token: 'IGAA-nuevo-2', expires_in: SESENTA_DIAS_S }],
  });
  assert.equal(segundo.igToken.token(), 'IGAA-nuevo');
  assert.equal(segundo.igToken.estado().desdeArchivo, true);
  await segundo.igToken.revisar(); // refrescó recién: no toca
  assert.equal(segundo.pedidos.length, 0);
  segundo.avanzar(7 * DIA);
  await segundo.igToken.revisar();
  assert.equal(segundo.pedidos[0].tok, 'IGAA-nuevo', 'refresca el guardado, no el de la variable');
  assert.equal(segundo.igToken.token(), 'IGAA-nuevo-2');
  assert.equal(segundo.alertas.length, 0, 'el archivo sobrevivió: hay volumen, nada que avisar');
});

test('si cargan un token nuevo en la variable, la variable manda', async (t) => {
  const primero = armar(t, { refresco: () => [200, { access_token: 'IGAA-nuevo', expires_in: SESENTA_DIAS_S }] });
  await primero.igToken.revisar();
  const segundo = armar(t, { dir: primero.dir, envToken: 'IGAA-cargado-a-mano' });
  assert.equal(segundo.igToken.token(), 'IGAA-cargado-a-mano');
  assert.equal(segundo.igToken.estado().desdeArchivo, false);
});

test('token recién generado: el refresco falla, el token sirve y no hay alarma', async (t) => {
  const { igToken, alertas, logs, pedidos, avanzar, estado } = armar(t, { refresco: () => [400, MUY_NUEVO] });
  await igToken.revisar();
  assert.equal(igToken.token(), 'IGAA-env');
  assert.deepEqual(pedidos.map((p) => new URL(p.ruta).pathname), ['/refresh_access_token', '/v21.0/me']);
  assert.equal(alertas.length, 0);
  assert.ok(logs.some((l) => l.includes('[token] No pude refrescarlo: 400 Token is too young')));

  // Al otro día ya se puede.
  estado.refresco = (tok) => [200, { access_token: tok, expires_in: SESENTA_DIAS_S }];
  avanzar(DIA);
  await igToken.revisar();
  assert.ok(igToken.estado().refrescadoEn);
  assert.equal(alertas.length, 0);
});

test('tres días seguidos sin poder refrescar: avisa aunque el token todavía sirva', async (t) => {
  const { igToken, alertas, avanzar } = armar(t, { refresco: () => [400, MUY_NUEVO] });
  await igToken.revisar();
  avanzar(2 * DIA);
  await igToken.revisar();
  assert.equal(alertas.length, 0);
  avanzar(DIA);
  await igToken.revisar();
  assert.deepEqual(alertas.map((a) => a.clave), ['token-refresco']);
  assert.match(alertas[0].texto, /hace 3 días/);
});

test('una falla suelta del refresco semanal no dice "hace 7 días"', async (t) => {
  const { igToken, alertas, avanzar, estado } = armar(t);
  await igToken.revisar();
  estado.refresco = () => [500, 'upstream error'];
  avanzar(7 * DIA);
  await igToken.revisar();
  assert.equal(alertas.length, 0, 'primer intento fallido: todavía no es noticia');
  estado.refresco = (tok) => [200, { access_token: tok, expires_in: SESENTA_DIAS_S }];
  avanzar(DIA);
  await igToken.revisar();
  assert.equal(igToken.estado().fallandoDesde, null, 'un refresco bueno corta la racha');
  assert.equal(alertas.length, 0);
});

test('token vencido al revisar: una sola alerta de code 190', async (t) => {
  const { igToken, alertas } = armar(t, { refresco: () => [400, VENCIDO], me: () => [400, VENCIDO] });
  await igToken.revisar();
  assert.deepEqual(alertas.map((a) => a.clave), ['token-190']);
  assert.match(alertas[0].texto, /code 190/);
  assert.match(alertas[0].texto, /IG_ACCESS_TOKEN/);
});

test('notarError: un 190 de un envío se confirma contra /me antes de avisar', async (t) => {
  const { igToken, alertas, pedidos, estado } = armar(t);
  assert.equal(igToken.notarError(JSON.stringify({ error: { code: 10, message: 'fuera de la ventana de 24 hs' } }), 'IGAA-env'), false);
  assert.equal(igToken.notarError('', 'IGAA-env'), false);
  assert.equal(pedidos.length, 0, 'otros errores no consultan nada');

  estado.me = () => [400, VENCIDO];
  assert.equal(igToken.notarError(JSON.stringify(VENCIDO), 'IGAA-env'), true);
  assert.equal(alertas.length, 0, 'todavía no confirmó');
  await igToken.quieto();
  assert.deepEqual(pedidos.map((p) => new URL(p.ruta).pathname), ['/v21.0/me']);
  assert.deepEqual(alertas.map((a) => a.clave), ['token-190']);
});

test('notarError: un 190 suelto con el token sano no avisa ni cambia nada', async (t) => {
  const { igToken, alertas, logs } = armar(t);
  igToken.notarError(JSON.stringify(VENCIDO), 'IGAA-env');
  await igToken.quieto();
  assert.equal(alertas.length, 0);
  assert.equal(igToken.token(), 'IGAA-env');
  assert.ok(logs.some((l) => l.includes('code 190 suelto')));
});

test('notarError: en una caída confirma una vez cada 5 minutos, no por cada envío', async (t) => {
  const { igToken, pedidos, avanzar } = armar(t, { me: () => [400, VENCIDO] });
  for (let i = 0; i < 5; i++) igToken.notarError(JSON.stringify(VENCIDO), 'IGAA-env');
  await igToken.quieto();
  igToken.notarError(JSON.stringify(VENCIDO), 'IGAA-env');
  await igToken.quieto();
  assert.equal(pedidos.length, 1);
  avanzar(5 * 60 * 1000);
  igToken.notarError(JSON.stringify(VENCIDO), 'IGAA-env');
  await igToken.quieto();
  assert.equal(pedidos.length, 2);
});

test('si Meta no contesta la confirmación, no avisa ni descarta el token', async (t) => {
  const { igToken, alertas } = armar(t, { me: () => { throw new Error('fetch failed'); } });
  igToken.notarError(JSON.stringify(VENCIDO), 'IGAA-env');
  await igToken.quieto();
  assert.equal(alertas.length, 0);
  assert.equal(igToken.token(), 'IGAA-env');
});

test('si el token refrescado deja de servir, vuelve al de la variable antes de alarmar', async (t) => {
  const { igToken, alertas, archivo, estado } = armar(t, {
    refresco: () => [200, { access_token: 'IGAA-nuevo', expires_in: SESENTA_DIAS_S }],
  });
  await igToken.revisar();
  alertas.length = 0;

  // Un 190 suelto con el token guardado sano no lo descarta.
  igToken.notarError(JSON.stringify(VENCIDO), 'IGAA-nuevo');
  await igToken.quieto();
  assert.equal(igToken.token(), 'IGAA-nuevo');
  assert.equal(fs.existsSync(archivo), true);

  // Confirmado por /me: vuelve al de la variable y todavía no alarma.
  estado.me = (tok) => (tok === 'IGAA-nuevo' ? [400, VENCIDO] : [200, { id: '1' }]);
  estado.reloj += 5 * 60 * 1000;
  igToken.notarError(JSON.stringify(VENCIDO), 'IGAA-nuevo');
  await igToken.quieto();
  assert.equal(igToken.token(), 'IGAA-env');
  assert.equal(fs.existsSync(archivo), false, 'el archivo con el token malo se borra');
  assert.equal(alertas.length, 0, 'el de la variable puede servir');

  // Un rebote atrasado del token viejo no dispara nada.
  igToken.notarError(JSON.stringify(VENCIDO), 'IGAA-nuevo');
  await igToken.quieto();
  assert.equal(alertas.length, 0);

  // Si el de la variable también está vencido, ahí sí.
  estado.me = () => [400, VENCIDO];
  igToken.notarError(JSON.stringify(VENCIDO), 'IGAA-env');
  await igToken.quieto();
  assert.deepEqual(alertas.map((a) => a.clave), ['token-190']);
});

test('revisar con el token guardado vencido: cae al de la variable y lo refresca', async (t) => {
  const primero = armar(t, { refresco: () => [200, { access_token: 'IGAA-nuevo', expires_in: SESENTA_DIAS_S }] });
  await primero.igToken.revisar();

  const segundo = armar(t, {
    dir: primero.dir,
    refresco: (tok) => (tok === 'IGAA-env' ? [200, { access_token: 'IGAA-env', expires_in: SESENTA_DIAS_S }] : [400, VENCIDO]),
    me: (tok) => (tok === 'IGAA-env' ? [200, { id: '1' }] : [400, VENCIDO]),
  });
  segundo.avanzar(8 * DIA);
  await segundo.igToken.revisar();
  assert.equal(segundo.igToken.token(), 'IGAA-env');
  assert.ok(segundo.igToken.estado().expiraEn);
  assert.equal(segundo.alertas.length, 0);
});

test('avisa cuando quedan pocos días y el refresco no lo renueva', async (t) => {
  const { igToken, alertas, avanzar, estado } = armar(t);
  await igToken.revisar(); // 60 días
  estado.refresco = () => [500, 'upstream error'];
  avanzar(49 * DIA);
  await igToken.revisar(); // quedan 11
  assert.ok(!alertas.some((a) => a.clave === 'token-vence'));
  avanzar(DIA);
  await igToken.revisar(); // quedan 10
  const vence = alertas.filter((a) => a.clave === 'token-vence');
  assert.equal(vence.length, 1);
  assert.match(vence[0].texto, /le quedan 10 días \(vence el 2026-12-04\)/);
});

test('con Facebook Login (graph.facebook.com) no refresca, solo verifica', async (t) => {
  const { igToken, pedidos, logs } = armar(t, { envToken: 'EAA-env', base: 'https://graph.facebook.com/v21.0' });
  await igToken.revisar();
  assert.deepEqual(pedidos.map((p) => p.ruta), ['https://graph.facebook.com/v21.0/me']);
  assert.ok(logs.some((l) => l.includes('Refresco automático apagado')));
  assert.ok(logs.some((l) => l.includes('[token] OK: responde bien')));
  assert.equal(igToken.token(), 'EAA-env');
});

test('token de Instagram con la base de Facebook: lo advierte', async (t) => {
  const { igToken, logs } = armar(t, { base: 'https://graph.facebook.com/v21.0' });
  await igToken.revisar();
  assert.ok(logs.some((l) => l.includes('IG_GRAPH_BASE no apunta a graph.instagram.com: no puedo refrescarlo')));
});

test('refresco apagado (desarrollo local): no refresca, y avisa si el token no sirve', async (t) => {
  const sano = armar(t, { refrescoActivo: false });
  await sano.igToken.revisar();
  assert.deepEqual(sano.pedidos.map((p) => new URL(p.ruta).pathname), ['/v21.0/me']);
  assert.equal(sano.alertas.length, 0);

  const vencido = armar(t, { refrescoActivo: false, me: () => [400, VENCIDO] });
  await vencido.igToken.revisar();
  assert.deepEqual(vencido.alertas.map((a) => a.clave), ['token-190']);
});

test('sin token no llama a Meta ni tira', async (t) => {
  const { igToken, pedidos, logs } = armar(t, { envToken: '' });
  assert.equal(igToken.token(), '');
  await igToken.revisar();
  assert.equal(pedidos.length, 0);
  assert.ok(logs.some((l) => l.includes('No hay IG_ACCESS_TOKEN')));
});

test('sin archivo configurado funciona igual en memoria', async (t) => {
  const { igToken, dir } = armar(t, {
    conArchivo: false,
    refresco: () => [200, { access_token: 'IGAA-nuevo', expires_in: SESENTA_DIAS_S }],
  });
  await igToken.revisar();
  assert.equal(igToken.token(), 'IGAA-nuevo');
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('Meta caído o respuesta rara: no tira, no cambia el token, no alarma el primer día', async (t) => {
  const caido = armar(t, { refresco: () => { throw new Error('fetch failed'); }, me: () => { throw new Error('fetch failed'); } });
  await caido.igToken.revisar();
  assert.equal(caido.igToken.token(), 'IGAA-env');
  assert.equal(caido.alertas.length, 0);

  const rara = armar(t, { refresco: () => [200, { access_token: '', expires_in: 0 }] });
  await rara.igToken.revisar();
  assert.equal(rara.igToken.token(), 'IGAA-env');
  assert.equal(rara.igToken.estado().expiraEn, null);
});

test('una alerta que tira o que rechaza no rompe nada', async (t) => {
  const { estado, dir } = armar(t);
  for (const alertar of [() => { throw new Error('boom'); }, async () => { throw new Error('boom'); }]) {
    const igToken = crearTokenIg({
      envToken: 'IGAA-env', archivo: path.join(dir, 'x.json'),
      ahora: () => estado.reloj, log: () => {}, warn: () => {}, alertar,
      fetchFn: async () => respuesta(400, VENCIDO),
    });
    await igToken.revisar();
    assert.equal(igToken.notarError(JSON.stringify(VENCIDO)), true);
    await igToken.quieto();
  }
  await new Promise((r) => setImmediate(r)); // un rechazo sin manejar haría fallar el test
});

test('el token nunca aparece en logs ni en alertas, aunque Meta lo repita en el error', async (t) => {
  const ENV = 'IGAAsecretoDeLaVariable0123456789';
  const NUEVO = 'IGAAsecretoRefrescado0123456789ab';
  const eco = (tok) => ({ error: { message: `Malformed access token ${tok}`, type: 'OAuthException', code: 190 } });

  // Refresco bueno con rotación, después el token nuevo y el de la variable rebotan.
  const a = armar(t, { envToken: ENV, refresco: () => [200, { access_token: NUEVO, expires_in: SESENTA_DIAS_S }] });
  await a.igToken.revisar();
  a.estado.me = (tok) => [400, eco(tok)];
  a.igToken.notarError(JSON.stringify(eco(NUEVO)), NUEVO);
  await a.igToken.quieto();
  a.igToken.notarError(JSON.stringify(eco(ENV)), ENV);
  await a.igToken.quieto();
  assert.deepEqual(a.alertas.map((x) => x.clave), ['token-rota', 'token-190']);

  // Refresco que falla repitiendo el token, y fetch que tira con el token en el mensaje.
  const b = armar(t, { envToken: ENV, refresco: (tok) => [400, { error: { message: `Cannot refresh ${tok}`, code: 100 } }] });
  await b.igToken.revisar();
  const c = armar(t, { envToken: ENV, refresco: (tok) => { throw new Error(`fetch failed for ${tok}`); } });
  await c.igToken.revisar();

  for (const x of [a, b, c]) {
    const salida = x.logs.join('\n') + JSON.stringify(x.alertas);
    assert.ok(!salida.includes('secreto'), salida);
  }
  assert.ok(b.logs.some((l) => l.includes('Cannot refresh [token]')));
});

test('archivo corrupto o imposible de escribir: sigue con la variable sin tirar', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-token-'));
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'data', 'ig-token.json'), '{esto no es json');
  const corrupto = armar(t, { dir });
  assert.equal(corrupto.igToken.token(), 'IGAA-env');
  await corrupto.igToken.revisar();
  assert.ok(corrupto.igToken.estado().expiraEn, 'refresca igual y pisa el archivo roto');
  assert.equal(JSON.parse(fs.readFileSync(corrupto.archivo, 'utf8')).token, 'IGAA-env');

  // La carpeta del archivo es en realidad un archivo: mkdir falla.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-token-'));
  fs.writeFileSync(path.join(dir2, 'data'), 'soy un archivo');
  const sinDisco = armar(t, { dir: dir2, refresco: () => [200, { access_token: 'IGAA-nuevo', expires_in: SESENTA_DIAS_S }] });
  await sinDisco.igToken.revisar();
  assert.equal(sinDisco.igToken.token(), 'IGAA-nuevo', 'en memoria lo usa igual');
  assert.ok(sinDisco.logs.some((l) => l.includes('NO quedó guardado en disco')));
});

test('dos revisiones a la vez no refrescan dos veces', async (t) => {
  const { igToken, pedidos } = armar(t);
  await Promise.all([igToken.revisar(), igToken.revisar()]);
  assert.equal(pedidos.length, 1);
});

test('días de aviso configurables, incluido 0 y valores vacíos', async (t) => {
  const { estado, dir } = armar(t);
  const crear = (diasAviso) => {
    const alertas = [];
    const igToken = crearTokenIg({
      envToken: 'IGAA-env', archivo: path.join(dir, `${String(diasAviso)}.json`), diasAviso,
      ahora: () => estado.reloj, log: () => {}, warn: () => {},
      alertar: async (clave) => { alertas.push(clave); },
      fetchFn: async () => respuesta(200, { access_token: 'IGAA-env', expires_in: 5 * 24 * 60 * 60 }),
    });
    return { igToken, alertas };
  };
  for (const [valor, espera] of [[undefined, ['token-vence']], ['', ['token-vence']], ['20', ['token-vence']], ['0', []], ['3', []]]) {
    const { igToken, alertas } = crear(valor);
    await igToken.revisar(); // quedan 5 días
    assert.deepEqual(alertas, espera, `diasAviso=${JSON.stringify(valor)}`);
  }
});

test('iniciar programa la primera revisión y la diaria, y se puede frenar', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { igToken, pedidos, avanzar } = armar(t);
  const frenar = igToken.iniciar({ primeraMs: 30000, cadaMs: DIA });
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  t.mock.timers.tick(29999);
  await flush();
  assert.equal(pedidos.length, 0);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(pedidos.length, 1, 'primera revisión a los 30 s');
  // Pasa una semana: la revisión diaria corre sola y vuelve a refrescar.
  for (let d = 0; d < 7; d++) { avanzar(DIA); t.mock.timers.tick(DIA); await flush(); }
  assert.equal(pedidos.length, 2, 'la diaria refrescó al cumplirse los 7 días');
  frenar();
  for (let d = 0; d < 10; d++) { avanzar(DIA); t.mock.timers.tick(DIA); await flush(); }
  assert.equal(pedidos.length, 2);
});
