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

// Nota fija que se antepone al PRIMER mensaje del bot en cada conversación de Instagram.
// Se agrega por código en handleIgMessage (garantizado, no depende de que la IA la incluya).
const IG_CLOSED_NOTE = 'En este momento estamos cerrados, pero en mi rol de Asistente Comercial puedo contestar tus dudas y cotizar el alquiler de tu auto. De todas formas quedate tranquilo que mañana durante la mañana te podés contactar directamente con Patricia.';

// Contexto extra que se le agrega al prompt SOLO en el canal Instagram (horario nocturno)
const INSTAGRAM_NIGHT_SUFFIX = `
━━━━━━━━━━━━━━━━━━━━━━━ CANAL INSTAGRAM — HORARIO NOCTURNO ━━━━━━━━━━━━━━━━━━━━━━━
Estás atendiendo por Instagram fuera del horario comercial: la empresa está cerrada y Patricia atiende personalmente durante el día. Podés responder consultas y cotizar con normalidad. Si el cliente necesita hablar con una persona, aclarale con calidez que Patricia lo va a contactar durante la mañana.`;

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

const igSessions = new Map(); // senderId -> { messages: [...], updatedAt, humanUntil, lastFallbackAt }
const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6 horas de inactividad
const seenMids = new Set();   // dedupe de reintentos de Meta
const ownMids = new Set();    // ids de mensajes que mandó el bot (para no confundirlos con una respuesta humana)
const HUMAN_HANDOFF_MS = 2 * 60 * 60 * 1000; // si alguien contesta manualmente, el bot se calla en esa charla por 2hs
const FALLBACK_COOLDOWN_MS = 15 * 60 * 1000; // no repetir el mensaje de error más de una vez cada 15 min por charla

function getIgSession(senderId) {
  const now = Date.now();
  let s = igSessions.get(senderId);
  if (!s || now - s.updatedAt > SESSION_TTL_MS) {
    s = { messages: [], updatedAt: now, humanUntil: 0, lastFallbackAt: 0 };
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
    const data = await res.json().catch(() => null);
    if (data?.message_id) {
      ownMids.add(data.message_id);
      if (ownMids.size > 1000) ownMids.clear();
    }
    console.log('[ig] Mensaje enviado OK');
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Normaliza el nombre de un auto para poder matchear el texto con su imagen
function normalizeCarName(s) {
  return s
    .replace(/\s*\(\d{4}\)\s*$/, '')
    .replace(/\s+\d{4}\s*$/, '')
    .replace(/\s*\(([^)]+)\)\s*/g, '($1)')
    .replace(/[-–—]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Separa la respuesta del bot en: intro + un bloque por auto + cierre (disclaimer)
function splitIntoSegments(text) {
  const normalized = text.replace(/([^\n])\n(\*\*(SMALL|MEDIUM|LARGE)\s)/g, '$1\n\n$2');
  const paras = normalized.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
  const carRegex = /^\*\*(SMALL|MEDIUM|LARGE)\s+(.+?)\*\*/;
  const intro = [], cars = [], outro = [];
  let inCars = false;
  for (const para of paras) {
    const m = para.match(carRegex);
    if (m) { inCars = true; cars.push({ text: para, name: m[2] }); }
    else if (!inCars) intro.push(para);
    else outro.push(para);
  }
  return { intro: intro.join('\n\n'), cars, outro: outro.join('\n\n') };
}

function findImageFor(carName, images) {
  const target = normalizeCarName(carName);
  return images.find((img) => img.name && normalizeCarName(img.name) === target) || null;
}

async function handleIgMessage(senderId, text) {
  console.log(`[ig] Procesando mensaje de ${senderId}: "${text}"`);
  const session = getIgSession(senderId);
  // ¿Es la primera respuesta del bot en esta conversación? (para anteponer la nota de cierre)
  const isFirstReply = !session.messages.some((m) => m.role === 'assistant');
  session.messages.push({ role: 'user', content: text });
  if (session.messages.length > 40) session.messages = session.messages.slice(-40);

  let result;
  try {
    result = await runBot(session.messages, { channel: 'instagram' });
  } catch (err) {
    console.error('[ig] runBot error:', err.message);
    const now = Date.now();
    if (now - session.lastFallbackAt < FALLBACK_COOLDOWN_MS) {
      // Ya le avisamos hace poco que hubo un problema — no lo repetimos por cada mensaje nuevo.
      console.log(`[ig] Falla repetida con ${senderId} — no reenvío el aviso (cooldown), atiende Patricia`);
      session.messages.pop(); // sacamos el mensaje que no pudimos procesar para no romper la alternancia user/assistant
      return;
    }
    session.lastFallbackAt = now;
    result = { text: 'Disculpá, tuve un inconveniente. Escribile a Patricia: https://wa.me/13057731787', images: [], quickReplies: [] };
  }

  session.messages.push({ role: 'assistant', content: result.text });
  session.updatedAt = Date.now();

  // Enviamos intercalando: el texto de cada auto y su foto justo debajo, en vez de
  // mandar todo el texto primero y todas las fotos juntas al final.
  const images = result.images || [];
  const sendImages = (process.env.IG_SEND_IMAGES || 'true') !== 'false';
  const { intro, cars, outro } = splitIntoSegments(result.text);

  // Caso simple (sin autos o sin fotos): todo el texto y, si hay, las fotos al final
  if (cars.length === 0 || images.length === 0 || !sendImages) {
    const full = isFirstReply ? `${IG_CLOSED_NOTE}\n\n${result.text}` : result.text;
    for (const chunk of chunkText(formatForInstagram(full))) { await igSend(senderId, { text: chunk }); await sleep(250); }
    if (sendImages) {
      for (const img of images.slice(0, 6)) {
        try { await igSend(senderId, { attachment: { type: 'image', payload: { url: img.url, is_reusable: false } } }); await sleep(250); }
        catch (err) { console.error('[ig] Error enviando imagen:', err.message); }
      }
    }
    return;
  }

  // Caso con autos + fotos: intro → (texto del auto + su foto) por cada auto → cierre/disclaimer
  const introFull = isFirstReply ? `${IG_CLOSED_NOTE}${intro ? `\n\n${intro}` : ''}` : intro;
  if (introFull.trim()) {
    for (const chunk of chunkText(formatForInstagram(introFull))) { await igSend(senderId, { text: chunk }); await sleep(250); }
  }
  for (const car of cars) {
    for (const chunk of chunkText(formatForInstagram(car.text))) { await igSend(senderId, { text: chunk }); await sleep(250); }
    const img = findImageFor(car.name, images);
    if (img) {
      try { await igSend(senderId, { attachment: { type: 'image', payload: { url: img.url, is_reusable: false } } }); await sleep(300); }
      catch (err) { console.error('[ig] Error enviando imagen:', err.message); }
    }
  }
  if (outro.trim()) {
    for (const chunk of chunkText(formatForInstagram(outro))) { await igSend(senderId, { text: chunk }); await sleep(250); }
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

  console.log('[webhook] POST recibido — RAW:', JSON.stringify(req.body));

  try {
    if (!verifySignature(req)) { console.warn('[webhook] Firma inválida — descartado'); return; }

    const body = req.body;
    if (!body || body.object !== 'instagram') {
      console.log(`[webhook] Ignorado — object no es "instagram" (es: ${body?.object})`);
      return;
    }

    for (const entry of body.entry || []) {
      // Instagram manda los mensajes en 2 formatos posibles:
      //  - entry.messaging[]      → DMs reales (producto Webhooks / messaging)
      //  - entry.changes[].value  → Casos de uso / botón de prueba del dashboard
      const events = [
        ...(entry.messaging || []),
        ...(entry.changes || []).filter((c) => c.field === 'messages').map((c) => c.value),
      ];

      for (const event of events) {
        const senderId = event?.sender?.id;
        const recipientId = event?.recipient?.id;
        const msg = event?.message;
        console.log(`[webhook] evento de ${senderId} — texto: "${msg?.text ?? '(sin texto)'}" — echo: ${!!msg?.is_echo}`);

        if (!msg) continue;

        if (msg.is_echo) {
          // Es un mensaje que salió desde la página hacia el cliente (recipientId).
          // Si el mid no es nuestro, alguien lo contestó a mano (Patricia u otro humano):
          // pausamos al bot en esa charla para que no se pisen las respuestas.
          if (msg.mid && ownMids.has(msg.mid)) continue;
          if (recipientId) {
            const session = getIgSession(recipientId);
            session.humanUntil = Date.now() + HUMAN_HANDOFF_MS;
            console.log(`[webhook] Respuesta manual detectada para ${recipientId} — pauso el bot ${HUMAN_HANDOFF_MS / 60000} min`);
          }
          continue;
        }

        if (!senderId) continue;
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

        const session = getIgSession(senderId);
        if (session.humanUntil && Date.now() < session.humanUntil) {
          console.log(`[webhook] Charla con ${senderId} pausada por handoff humano — no contesto`);
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
