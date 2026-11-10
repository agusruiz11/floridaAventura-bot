// En las charlas que vienen de un anuncio, Meta manda un echo sin texto con la
// tarjeta "¿Marcar conversación como buena para tu negocio?". No es Patricia:
// no tiene que pausar al bot ni descartar lo que el cliente estaba escribiendo.
// Cualquier otro echo sin texto (una foto que manda Patricia) sí pausa.
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
// Adjuntos reales del echo de la tarjeta, copiados del log de Railway.
const TARJETA_META = [{ type: 'template', payload: { generic: { elements: [] } } }];
const FOTO = [{ type: 'image', payload: { url: 'https://example.com/foto.jpg' } }];

const entrante = (senderId, text, mid) => ({
  object: 'instagram',
  entry: [{ messaging: [{ sender: { id: senderId }, recipient: { id: CUENTA }, timestamp: Date.now(), message: { mid, text } }] }],
});
const echoAdjuntos = (recipientId, attachments, mid) => ({
  object: 'instagram',
  entry: [{ messaging: [{ sender: { id: CUENTA }, recipient: { id: recipientId }, timestamp: Date.now(), message: { mid, attachments, is_echo: true } }] }],
});
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function levantar(t) {
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
  };
  delete env.AUTO_DM_TEXTOS;
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

test('la tarjeta de Meta de las charlas de anuncios no pausa al bot', async (t) => {
  const { post, esperar, estado, pedidosModelo } = await levantar(t);
  const ID = 'cliente-anuncio';

  // Mismo orden que en producción: el cliente escribe y enseguida llega la tarjeta.
  await post(entrante(ID, 'Tengo las fechas exactas de entrada y salida.', 'm-a1'));
  await post(echoAdjuntos(ID, TARJETA_META, 'm-tarjeta1'));
  await esperar(() => estado.log.includes(`[handoff] Tarjeta de Meta sin contenido para ${ID}, no pauso`));
  assert.ok(!estado.log.includes(`Respuesta manual detectada para ${ID}`), 'no tiene que pausar');

  // El mensaje del cliente igual llega al modelo.
  await esperar(() => pedidosModelo.length === 1);
  const texto = (m) => (typeof m.content === 'string' ? m.content : m.content.map((b) => b.text || '').join(''));
  assert.ok(texto(pedidosModelo[0].messages.at(-1)).includes('fechas exactas'));

  // Y el siguiente tampoco queda pausado.
  await post(entrante(ID, '22 de febrero al 2 de marzo', 'm-a2'));
  await esperar(() => pedidosModelo.length === 2);
  assert.ok(texto(pedidosModelo[1].messages.at(-1)).includes('22 de febrero'));
  assert.ok(!estado.log.includes(`Charla con ${ID} pausada`));
});

test('una foto que manda Patricia (echo con imagen) sigue pausando', async (t) => {
  const { post, esperar, estado, pedidosModelo } = await levantar(t);
  const ID = 'cliente-foto';
  await post(entrante(ID, 'Hola, quiero alquilar un auto', 'm-f1'));
  await post(echoAdjuntos(ID, FOTO, 'm-foto1'));
  await esperar(() => estado.log.includes(`Respuesta manual detectada para ${ID}`));
  assert.ok(!estado.log.includes(`Tarjeta de Meta sin contenido para ${ID}`));
  await post(entrante(ID, 'Del 3 al 10', 'm-f2'));
  await esperar(() => estado.log.includes(`Charla con ${ID} pausada por handoff humano`));
  await dormir(DEBOUNCE_MS * 2);
  assert.equal(pedidosModelo.length, 0);
});
