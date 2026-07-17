import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT } from './prompt.js';

const app = express();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use((req, res, next) => {
  const allowed = process.env.ALLOWED_ORIGIN || '*';
  res.header('Access-Control-Allow-Origin', allowed);
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Guardamos el body crudo para validar la firma de los webhooks de Meta
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.static('public'));

// ─── Tool definitions ────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'buscar_autos',
    description:
      'Consulta el catálogo de vehículos de Florida Aventura. ' +
      'Si se proporcionan startDateTime y endDateTime, devuelve solo los autos disponibles para ese rango de fechas. ' +
      'Si no se proporcionan fechas, devuelve el catálogo completo.',
    input_schema: {
      type: 'object',
      properties: {
        startDateTime: {
          type: 'string',
          description: 'Fecha y hora de inicio en formato ISO 8601 (YYYY-MM-DDTHH:mm:ss). Opcional.',
        },
        endDateTime: {
          type: 'string',
          description: 'Fecha y hora de fin en formato ISO 8601 (YYYY-MM-DDTHH:mm:ss). Opcional.',
        },
      },
      required: [],
    },
  },
];

// ─── Florida Aventura API helpers ────────────────────────────────────────────

const FA_BASE = 'https://api.floridaaventura.com/public';

async function faFetch(path) {
  const res = await fetch(`${FA_BASE}${path}`, {
    headers: { apiKey: process.env.FA_API_TOKEN },
  });
  if (!res.ok) {
    throw new Error(`Florida Aventura API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

function isValidISODate(str) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(str) && !isNaN(Date.parse(str));
}

function extractQuickReplies(text) {
  const match = text.match(/\[QUICK_REPLIES:\s*([^\]]+)\]/);
  if (!match) return { cleanText: text, quickReplies: [] };
  const quickReplies = match[1].split('|').map(s => s.trim()).filter(Boolean);
  const cleanText = text.replace(/\[QUICK_REPLIES:[^\]]+\]\n?/, '').trim();
  return { cleanText, quickReplies };
}

async function executeTool(toolName, toolInput) {
  if (toolName === 'buscar_autos') {
    const { startDateTime, endDateTime } = toolInput;

    if (startDateTime && !isValidISODate(startDateTime)) {
      return { json: JSON.stringify({ error: 'startDateTime inválido. Pedile al cliente que confirme las fechas exactas.' }), images: [] };
    }
    if (endDateTime && !isValidISODate(endDateTime)) {
      return { json: JSON.stringify({ error: 'endDateTime inválido. Pedile al cliente que confirme las fechas exactas.' }), images: [] };
    }

    let data;
    if (startDateTime && endDateTime) {
      console.log(`[buscar_autos] Consultando disponibilidad: ${startDateTime} → ${endDateTime}`);
      const params = new URLSearchParams({ startDateTime, endDateTime });
      data = await faFetch(`/availability?${params}`);
      console.log(`[buscar_autos] Autos disponibles: ${data.length}`);
    } else {
      console.log(`[buscar_autos] Sin fechas — devolviendo catálogo completo`);
      data = await faFetch('/cars');
      console.log(`[buscar_autos] Total en catálogo: ${data.length}`);
    }

    const images = data
      .filter((car) => car.imageUrl)
      .map((car) => ({ name: car.name, url: car.imageUrl, pricePerDay: car.pricePerDay }));

    const sinImagen = data.filter((c) => !c.imageUrl).map((c) => c.name);
    console.log(`[buscar_autos] Con imagen: ${images.map((i) => i.name).join(', ')}`);
    if (sinImagen.length) console.log(`[buscar_autos] SIN imagen: ${sinImagen.join(', ')}`);

    const unique = [...new Map(data.map((d) => [d.name, d])).values()];
    return { json: JSON.stringify(unique), images };
  }

  throw new Error(`Herramienta desconocida: ${toolName}`);
}

// ─── Horario / zona horaria (solo Instagram) ─────────────────────────────────

const IG_TZ = process.env.IG_TZ || 'America/New_York';

// Fecha de hoy (YYYY-MM-DD) en la zona horaria de Florida
function floridaDateStr() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: IG_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// Hora actual (0-23) en la zona horaria de Florida
function floridaHour() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: IG_TZ, hour: 'numeric', hour12: false,
  }).formatToParts(new Date());
  return Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
}

// ¿El bot de Instagram tiene que contestar en este momento?
// Por defecto activo de 23:00 a 07:00 (franja que cruza la medianoche).
function isBotActiveNow() {
  if ((process.env.IG_ENABLED || 'true') === 'false') return false;
  const start = Number(process.env.IG_BOT_START_HOUR ?? 23);
  const end = Number(process.env.IG_BOT_END_HOUR ?? 7);
  const h = floridaHour();
  return start < end ? (h >= start && h < end) : (h >= start || h < end);
}

// Instrucción extra que se le agrega al prompt SOLO en el canal Instagram (horario nocturno)
const INSTAGRAM_NIGHT_SUFFIX = `
━━━━━━━━━━━━━━━━━━━━━━━ CANAL INSTAGRAM — HORARIO NOCTURNO ━━━━━━━━━━━━━━━━━━━━━━━
Estás atendiendo por Instagram fuera del horario comercial: la empresa está cerrada y Patricia atiende personalmente durante el día.
En tu PRIMER mensaje de esta conversación —y SOLO en el primero— incluí al inicio, tal cual, esta nota:
"En este momento estamos cerrados, pero en mi rol de Asistente Comercial puedo contestar tus dudas y cotizar el alquiler de tu auto. De todas formas quedate tranquilo que mañana durante la mañana te podés contactar directamente con Patricia."
Después de esa nota seguí normalmente con tu presentación y el flujo habitual. No vuelvas a repetir la nota en los mensajes siguientes de la conversación.`;

// ─── Núcleo del bot (compartido entre la web y Instagram) ────────────────────

const FALLBACK_MSG = 'Tuve un problema procesando tu consulta. Escribile directamente a Patricia: https://wa.me/13057731787';

async function runBot(messages, { channel = 'web' } = {}) {
  let currentMessages = [...messages];
  let finalText = '';
  let lastSearchImages = [];

  const today = floridaDateStr();
  let system = `Hoy es ${today}. Cuando el cliente mencione fechas sin año, usá siempre el año corriente o el siguiente si la fecha ya pasó.\n\n${SYSTEM_PROMPT}`;
  if (channel === 'instagram') system += `\n\n${INSTAGRAM_NIGHT_SUFFIX}`;

  const MAX_ITERATIONS = 15;
  let iterations = 0;

  while (true) {
    if (++iterations > MAX_ITERATIONS) {
      console.error(`[bot:${channel}] Máximo de iteraciones alcanzado`);
      return { text: FALLBACK_MSG, images: [], quickReplies: [] };
    }

    const response = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 2048,
      system,
      tools: TOOLS,
      messages: currentMessages,
    });

    if (response.stop_reason === 'end_turn') {
      finalText = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      break;
    }

    if (response.stop_reason === 'tool_use') {
      currentMessages.push({ role: 'assistant', content: response.content });

      const toolResults = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;

        let toolContent;
        try {
          const result = await executeTool(block.name, block.input);
          toolContent = result.json;
          lastSearchImages = result.images;
        } catch (err) {
          console.error(`Error ejecutando tool ${block.name}:`, err.message);
          toolContent = JSON.stringify({ error: err.message });
        }

        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: toolContent });
      }

      currentMessages.push({ role: 'user', content: toolResults });
      continue;
    }

    // stop_reason inesperado — salir con lo que haya
    finalText = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    break;
  }

  const { cleanText, quickReplies } = extractQuickReplies(finalText);
  return { text: cleanText, images: lastSearchImages, quickReplies };
}

// ─── Chat endpoint (widget web) ──────────────────────────────────────────────

app.post('/chat', async (req, res) => {
  const { messages } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Se requiere el campo "messages" (array).' });
  }

  const timeoutId = setTimeout(() => {
    if (!res.headersSent) {
      res.json({ response: 'La consulta tardó demasiado. Por favor intentá de nuevo o escribile a Patricia: https://wa.me/13057731787', images: [], quickReplies: [] });
    }
  }, 45000);

  try {
    const { text, images, quickReplies } = await runBot(messages, { channel: 'web' });
    clearTimeout(timeoutId);
    if (res.headersSent) return;
    console.log(`[/chat] Respondiendo con ${images.length} imágenes, ${quickReplies.length} quick replies`);
    res.json({ response: text, images, quickReplies });
  } catch (err) {
    clearTimeout(timeoutId);
    console.error('Error en /chat:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

// ─── Instagram: memoria de conversaciones (por usuario) ──────────────────────
// En memoria: simple y suficiente para el turno nocturno. Se reinicia si Railway
// redeploya o reinicia el proceso. Migrar a una DB si se necesita persistencia real.

const igSessions = new Map(); // senderId -> { messages: [...], updatedAt }
const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6 horas de inactividad
const seenMids = new Set();   // dedupe de reintentos de Meta

function getIgSession(senderId) {
  const now = Date.now();
  let s = igSessions.get(senderId);
  if (!s || now - s.updatedAt > SESSION_TTL_MS) {
    s = { messages: [], updatedAt: now };
    igSessions.set(senderId, s);
  }
  return s;
}

// Instagram DM es texto plano: no renderiza markdown ni cards. Convertimos el
// formato del bot a algo legible en un DM (sin **, sin _, encabezado más humano).
function formatForInstagram(text) {
  return text
    .replace(/\*\*(SMALL|MEDIUM|LARGE)\s+(.+?)\*\*/g, (_m, size, name) => {
      const sz = { SMALL: 'Chico', MEDIUM: 'Mediano', LARGE: 'Grande' }[size] || '';
      const cleanName = name.replace(/\(([^)]+)\)/g, ' ($1)').replace(/\s+/g, ' ').trim();
      return `🚗 ${cleanName}${sz ? ` — ${sz}` : ''}`;
    })
    .replace(/\*\*/g, '')
    .replace(/_/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Instagram corta los mensajes ~1000 caracteres: partimos en trozos por líneas.
function chunkText(text, max = 950) {
  const chunks = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur && (cur + '\n' + line).length > max) {
      chunks.push(cur);
      cur = line;
    } else {
      cur = cur ? cur + '\n' + line : line;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

async function igSend(recipientId, message) {
  const base = process.env.IG_GRAPH_BASE || 'https://graph.facebook.com/v21.0';
  const token = process.env.IG_ACCESS_TOKEN;
  if (!token) { console.error('[ig] Falta IG_ACCESS_TOKEN — no puedo responder'); return; }

  const res = await fetch(`${base}/me/messages?access_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: recipientId }, message }),
  });
  if (!res.ok) {
    console.error('[ig] Error enviando mensaje:', res.status, await res.text());
  } else {
    console.log('[ig] Mensaje enviado OK');
  }
}

async function handleIgMessage(senderId, text) {
  console.log(`[ig] Procesando mensaje de ${senderId}: "${text}"`);
  const session = getIgSession(senderId);
  session.messages.push({ role: 'user', content: text });
  if (session.messages.length > 40) session.messages = session.messages.slice(-40);

  let result;
  try {
    result = await runBot(session.messages, { channel: 'instagram' });
  } catch (err) {
    console.error('[ig] runBot error:', err.message);
    result = { text: 'Disculpá, tuve un inconveniente. Escribile a Patricia: https://wa.me/13057731787', images: [], quickReplies: [] };
  }

  session.messages.push({ role: 'assistant', content: result.text });
  session.updatedAt = Date.now();

  // 1) Texto (formateado para DM y partido en trozos)
  const outText = formatForInstagram(result.text);
  for (const chunk of chunkText(outText)) {
    await igSend(senderId, { text: chunk });
  }

  // 2) Fotos de los autos (como adjuntos separados)
  if ((process.env.IG_SEND_IMAGES || 'true') !== 'false') {
    for (const img of (result.images || []).slice(0, 5)) {
      try {
        await igSend(senderId, { attachment: { type: 'image', payload: { url: img.url, is_reusable: false } } });
      } catch (err) {
        console.error('[ig] Error enviando imagen:', err.message);
      }
    }
  }
}

// Valida que el webhook venga realmente de Meta (firma HMAC con el App Secret)
function verifySignature(req) {
  const secret = process.env.IG_APP_SECRET;
  if (!secret) return true; // si no está configurado, no bloqueamos (útil para probar)
  const sig = req.get('x-hub-signature-256');
  if (!sig || !req.rawBody) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ─── Webhook de Instagram ────────────────────────────────────────────────────

// Verificación inicial que hace Meta al configurar el webhook (handshake)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.IG_VERIFY_TOKEN) {
    console.log('[webhook] Verificación OK');
    return res.status(200).send(challenge);
  }
  console.warn('[webhook] Verificación fallida');
  return res.sendStatus(403);
});

// Recepción de mensajes de Instagram
app.post('/webhook', (req, res) => {
  res.sendStatus(200); // respondemos rápido para que Meta no reintente

  console.log(`[webhook] POST recibido — object: ${req.body?.object} | entries: ${req.body?.entry?.length ?? 0}`);

  try {
    if (!verifySignature(req)) { console.warn('[webhook] Firma inválida — descartado'); return; }

    const body = req.body;
    if (!body || body.object !== 'instagram') {
      console.log(`[webhook] Ignorado — object no es "instagram" (es: ${body?.object})`);
      return;
    }

    for (const entry of body.entry || []) {
      for (const event of entry.messaging || []) {
        const senderId = event.sender?.id;
        const msg = event.message;
        console.log(`[webhook] evento de ${senderId} — texto: "${msg?.text ?? '(sin texto)'}" — echo: ${!!msg?.is_echo}`);

        if (!senderId || !msg) continue;
        if (msg.is_echo) continue;          // ignorar los mensajes que enviamos nosotros
        if (!msg.text) continue;            // por ahora solo texto (no stickers/adjuntos)

        // dedupe de reintentos
        if (msg.mid) {
          if (seenMids.has(msg.mid)) continue;
          seenMids.add(msg.mid);
          if (seenMids.size > 1000) seenMids.clear();
        }

        // Fuera del horario del bot → no contestamos, atiende Patricia
        if (!isBotActiveNow()) {
          console.log(`[webhook] Fuera de horario del bot (hora Florida: ${floridaHour()}) — atiende Patricia`);
          continue;
        }

        handleIgMessage(senderId, msg.text).catch((err) => console.error('[ig] handle error:', err.message));
      }
    }
  } catch (err) {
    console.error('[webhook] Error:', err.message);
  }
});

// ─── Start server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Florida Aventura Bot corriendo en http://localhost:${PORT}`);
  console.log(`[ig] Canal Instagram: ${(process.env.IG_ENABLED || 'true') === 'false' ? 'APAGADO' : `activo ${process.env.IG_BOT_START_HOUR ?? 23}:00–${process.env.IG_BOT_END_HOUR ?? 7}:00 (${IG_TZ})`}`);
});
