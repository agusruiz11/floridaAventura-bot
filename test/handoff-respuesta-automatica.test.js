// La respuesta automática de Instagram a una pregunta frecuente ("Los requisitos
// son: ...") no tiene que pausar al bot ni descartar lo que la persona escribe
// después; una respuesta manual de Patricia sí. Levanta server.js contra un mock
// de la Graph API de Instagram y de la API de Anthropic.
//   npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CUENTA = '17841421089633305';
const PREGUNTA = '¿Cuáles son los requisitos para alquilar un carro?';
// Texto real del echo, copiado del log de Railway del 3/10/2026.
const RESPUESTA_AUTO = 'Los requisitos son:\n* Renta mínima de 4 días\n* Conductores mayores de 25 años\n* Uso exclusivo dentro del estado de Florida\n\nSi ya tenes la fecha de viaje con horario incluido podemos cotizarte hoy mismo.';
const DEBOUNCE_MS = 300;

const entrante = (senderId, text, mid) => ({
  object: 'instagram',
  entry: [{ messaging: [{ sender: { id: senderId }, recipient: { id: CUENTA }, timestamp: Date.now(), message: { mid, text } }] }],
});
const echo = (recipientId, text, mid) => ({
  object: 'instagram',
  entry: [{ messaging: [{ sender: { id: CUENTA }, recipient: { id: recipientId }, timestamp: Date.now(), message: { mid, text, is_echo: true } }] }],
});
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function levantar(t, envExtra = {}) {
  const pedidosModelo = [];
  const mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url.startsWith('/me/messages')) return res.end(JSON.stringify({ message_id: `m-${Math.random()}` }));
      if (req.url.startsWith('/v1/messages')) {
        pedidosModelo.push(JSON.parse(body));
        return res.end(JSON.stringify({
          id: 'msg_test', type: 'message', role: 'assistant', model: 'test',
          content: [{ type: 'text', text: 'Perfecto, ¿cuántas valijas llevan?' }],
          stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
        }));
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise((r) => mock.listen(0, r));
  const MOCK = `http://localhost:${mock.address().port}`;
  t.after(() => mock.close());

  const PORT = 4100 + Math.floor(Math.random() * 800);
  const env = {
    ...process.env, PORT: String(PORT), DOTENV_CONFIG_PATH: '/dev/null',
    IG_APP_SECRET: '', IG_ACCESS_TOKEN: 'test', IG_GRAPH_BASE: MOCK, IG_TOKEN_REFRESH: 'false',
    IG_RESCUE_ENABLED: 'false', IG_TYPING: 'false', IG_MSG_DELAY_MS: '0', IG_MSG_JITTER_MS: '0',
    IG_DEBOUNCE_MS: String(DEBOUNCE_MS), IG_DEBOUNCE_MAX_MS: String(DEBOUNCE_MS),
    ANTHROPIC_API_KEY: 'test', ANTHROPIC_BASE_URL: MOCK, SLACK_WEBHOOK_URL: '', RAILWAY_API_TOKEN: '',
    ...envExtra,
  };
  if (!('AUTO_DM_TEXTOS' in envExtra)) delete env.AUTO_DM_TEXTOS;
  const srv = spawn(process.execPath, ['server.js'], { cwd: RAIZ, env });
  t.after(() => srv.kill());
  const estado = { log: '' };
  srv.stdout.on('data', (d) => { estado.log += d; });
  srv.stderr.on('data', (d) => { estado.log += d; });

  const esperar = async (cond, ms = 5000) => {
    const fin = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > fin) throw new Error(`timeout. Log:\n${estado.log}`);
      await dormir(25);
    }
  };
  await esperar(() => estado.log.includes('corriendo'));
  const post = (body) => fetch(`http://localhost:${PORT}/webhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { post, esperar, estado, pedidosModelo };
}

test('la respuesta automática de la pregunta frecuente no pausa y queda en el historial', async (t) => {
  const { post, esperar, estado, pedidosModelo } = await levantar(t);
  const ID = 'cliente-faq';

  // Mismo orden que en producción: primero la pregunta, enseguida el echo.
  await post(entrante(ID, PREGUNTA, 'm-q1'));
  await post(echo(ID, RESPUESTA_AUTO, 'm-auto1'));
  await esperar(() => estado.log.includes(`[handoff] Respuesta automática de Instagram para ${ID}, no pauso`));
  assert.ok(!estado.log.includes(`Respuesta manual detectada para ${ID}`), 'no tiene que pausar');
  assert.ok(!estado.log.includes('(respuesta manual)'), 'no tiene que descartar por respuesta manual');

  // Instagram ya contestó la pregunta: el bot no la contesta de nuevo.
  await dormir(DEBOUNCE_MS * 3);
  assert.equal(pedidosModelo.length, 0, 'la pregunta frecuente sola no dispara una respuesta del bot');

  // Lo que la persona escribe después sí se contesta, con los requisitos ya en el historial.
  await post(entrante(ID, 'Del 12 al 27 de octubre, somos 4', 'm-q2'));
  await esperar(() => pedidosModelo.length === 1);
  const { messages } = pedidosModelo[0];
  const texto = (m) => (typeof m.content === 'string' ? m.content : m.content.map((b) => b.text || '').join(''));
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.ok(texto(messages[0]).includes(PREGUNTA));
  assert.ok(texto(messages[1]).startsWith('Los requisitos son:'));
  assert.ok(texto(messages[2]).includes('12 al 27 de octubre'));
  assert.ok(!estado.log.includes(`Charla con ${ID} pausada`));
});

test('si el echo llega antes que la pregunta, tampoco se contesta dos veces', async (t) => {
  const { post, esperar, estado, pedidosModelo } = await levantar(t);
  const ID = 'cliente-faq-invertido';
  await post(echo(ID, RESPUESTA_AUTO, 'm-auto2'));
  await esperar(() => estado.log.includes(`Respuesta automática de Instagram para ${ID}, no pauso`));
  await post(entrante(ID, PREGUNTA, 'm-q3'));
  await dormir(DEBOUNCE_MS * 3);
  assert.equal(pedidosModelo.length, 0);
  await post(entrante(ID, 'Viajo del 3 al 10 de noviembre', 'm-q4'));
  await esperar(() => pedidosModelo.length === 1);
  assert.deepEqual(pedidosModelo[0].messages.map((m) => m.role), ['user', 'assistant', 'user']);
});

test('una respuesta manual sigue pausando al bot', async (t) => {
  const { post, esperar, estado, pedidosModelo } = await levantar(t);
  const ID = 'cliente-manual';
  await post(entrante(ID, 'Hola, quiero alquilar un auto', 'm-q5'));
  await post(echo(ID, 'Hola! Soy Patricia, contame las fechas', 'm-man1'));
  await esperar(() => estado.log.includes(`Respuesta manual detectada para ${ID}`));
  assert.ok(!estado.log.includes(`Respuesta automática de Instagram para ${ID}`));
  await post(entrante(ID, 'Del 3 al 10', 'm-q6'));
  await esperar(() => estado.log.includes(`Charla con ${ID} pausada por handoff humano`));
  await dormir(DEBOUNCE_MS * 2);
  assert.equal(pedidosModelo.length, 0);
});

test('con AUTO_DM_TEXTOS vacío vuelve el comportamiento anterior', async (t) => {
  const { post, esperar, estado } = await levantar(t, { AUTO_DM_TEXTOS: '' });
  const ID = 'cliente-apagado';
  await post(entrante(ID, PREGUNTA, 'm-q7'));
  await post(echo(ID, RESPUESTA_AUTO, 'm-auto3'));
  await esperar(() => estado.log.includes(`Respuesta manual detectada para ${ID}`));
});
