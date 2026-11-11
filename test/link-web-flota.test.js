// Instagram: debajo de la lista corta (3 autos con bloque + el resto en una
// línea cada uno) va el link a la web para ver todos los autos con fotos
// (pedido de Patricia, 11/11/2026). El modelo pone [[LINK_WEB]]; server.js lo
// saca y manda el link como último mensaje. Con bloques de auto el texto es el
// de la flota (IG_WEB_FLOTA_URL); sin bloques, el de probar fechas de siempre.
// Levanta server.js contra un mock de la Graph API de Instagram y de Anthropic.
//   npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CUENTA = '17841421089633305';
const DEBOUNCE_MS = 300;

const BLOQUE = (tipo, nombre, precio, dias, total) => [
  `**${tipo} ${nombre} 2025**`,
  `📅 Del 10 al 20 de enero · Retiro 07:00, devolución 20:00 (horario a confirmar)`,
  `💰 USD ${precio}/día × ${dias} días | 👥 5 pasajeros | 🧳 aprox. 3 valijas | ✅ Seguro incluido | 🛣️ KM ilimitado (solo Florida) | ⛽ Tanque lleno al retirar y al devolver | 👤 1 conductor adicional incluido`,
  `💵 Total: USD ${total} (USD ${total - 30} por ${dias} días + USD 30 SunPass)`,
  `→ SUV mediana para 5 pasajeros`,
].join('\n');

const COTIZACION = [
  'Para el 10 al 20 de enero te paso las 3 opciones más versátiles:',
  BLOQUE('SMALL', 'Nissan Kicks', 54, 11, 624),
  BLOQUE('MEDIUM', 'Honda HRV', 55, 11, 635),
  BLOQUE('LARGE', 'Honda Odyssey', 78, 11, 888),
  'Otras opciones disponibles para esas fechas:\n• Nissan Versa 2025 · 👥 5 · 🧳 aprox. 2 · USD 580 total\n• Volkswagen Atlas(Negra) 2025 · 👥 7 · 🧳 aprox. 5 · USD 745 total\nSi te interesa alguna, decime y te paso el detalle con foto.',
  'Coticé con retiro a las 07:00 y devolución a las 20:00. Si son otros horarios, pasámelos y te confirmo el total.',
  '_📋 Es el precio final: incluye seguro, kilometraje ilimitado en Florida, SunPass y un conductor adicional. Si cambian las fechas, los horarios o los destinos, te lo recalculo._',
  '¿Cuántas valijas llevan y qué lugares piensan visitar además de Miami?',
].join('\n\n');

// Lo que contesta el "modelo" según la consulta del cliente.
const RESPUESTAS = {
  'con lista y link': `${COTIZACION}\n[[LINK_WEB]]`,
  'con lista sin link': COTIZACION,
  'sin fechas': 'Te paso la web para que pruebes fechas y veas los autos disponibles. Cuando tengas un rango aproximado, escribime y te lo cotizo.\n[[LINK_WEB]]',
};

const entrante = (senderId, text, mid) => ({
  object: 'instagram',
  entry: [{ messaging: [{ sender: { id: senderId }, recipient: { id: CUENTA }, timestamp: Date.now(), message: { mid, text } }] }],
});
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function levantar(t, envExtra = {}) {
  const enviados = {}; // recipientId → [message]
  const mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url.startsWith('/me/messages')) {
        const b = JSON.parse(body);
        if (b.message) (enviados[b.recipient.id] ||= []).push(b.message);
        return res.end(JSON.stringify({ message_id: `m-${Math.random()}` }));
      }
      if (req.url.startsWith('/v1/messages')) {
        const { messages } = JSON.parse(body);
        const ultimo = messages[messages.length - 1];
        const texto = typeof ultimo.content === 'string' ? ultimo.content : ultimo.content.map((b) => b.text || '').join('');
        const clave = Object.keys(RESPUESTAS).find((k) => texto.includes(k));
        return res.end(JSON.stringify({
          id: 'msg_test', type: 'message', role: 'assistant', model: 'test',
          content: [{ type: 'text', text: RESPUESTAS[clave] || 'ok' }],
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
  if (!('IG_WEB_FLOTA_URL' in envExtra)) delete env.IG_WEB_FLOTA_URL;
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
  // Manda la consulta y espera a que termine la ráfaga completa.
  const envios = () => (estado.log.match(/\[ig\] Enviando (\d+) mensajes/g) || []);
  const conversar = async (id, texto) => {
    const antes = envios().length;
    await post(entrante(id, texto, `m-${id}`));
    await esperar(() => envios().length > antes);
    const esperados = Number(envios()[antes].match(/\d+/)[0]);
    await esperar(() => (enviados[id] || []).length >= esperados);
    return enviados[id];
  };
  return { conversar, estado };
}

test('3 bloques + lista corta + [[LINK_WEB]]: el último mensaje es el link a la flota con fotos', async (t) => {
  const { conversar, estado } = await levantar(t, { IG_WEB_FLOTA_URL: 'https://flota.example.com/autos' });

  const conLink = await conversar('cliente-lista-link', 'del 10 al 20 de enero, con lista y link');
  const ultimo = conLink[conLink.length - 1];
  assert.equal(ultimo.text, 'Acá podés ver todos los autos con sus fotos: https://flota.example.com/autos');
  // El link va solo, en un mensaje aparte; el marcador no le llega al cliente.
  assert.ok(conLink.slice(0, -1).every((m) => !m.text || !m.text.includes('flota.example.com')));
  assert.ok(conLink.every((m) => !m.text || !/LINK_WEB/.test(m.text)));
  assert.ok(!conLink.some((m) => m.text && m.text.includes('probar distintas fechas')));
  assert.ok(estado.log.includes('Link a la web pedido para cliente-lista-link (flota con fotos)'));

  // La misma respuesta sin el marcador: la ráfaga tiene exactamente un mensaje menos.
  const sinLink = await conversar('cliente-lista-sin-link', 'del 10 al 20 de enero, con lista sin link');
  assert.equal(conLink.length, sinLink.length + 1);
  assert.deepEqual(conLink.slice(0, -1), sinLink);
});

test('con la variable sin definir usa https://www.floridaaventura.com/', async (t) => {
  const { conversar } = await levantar(t);
  const msgs = await conversar('cliente-default', 'del 10 al 20 de enero, con lista y link');
  assert.equal(msgs[msgs.length - 1].text, 'Acá podés ver todos los autos con sus fotos: https://www.floridaaventura.com/');
});

test('sin bloques de auto sigue el link para probar fechas', async (t) => {
  const { conversar } = await levantar(t, { IG_WEB_FLOTA_URL: 'https://flota.example.com/autos' });
  const msgs = await conversar('cliente-sin-fechas', 'todavía no tengo fechas, sin fechas');
  assert.equal(msgs[msgs.length - 1].text, 'Acá podés probar distintas fechas y ver las opciones disponibles: https://www.floridaaventura.com/');
  assert.ok(!msgs.some((m) => m.text && m.text.includes('flota.example.com')));
});
