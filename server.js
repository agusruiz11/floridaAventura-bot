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
        destinos: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Destinos fuera de Miami que el cliente dijo que va a visitar (ej: ["Orlando", "Naples"]). ' +
            'Sirve para calcular el cargo de SunPass. Omitilo si el cliente todavía no mencionó destinos: ' +
            'en ese caso se usa la tarifa base de Miami. Opcional.',
        },
        puertoDeCruceros: {
          type: 'boolean',
          description: 'true solo si el cliente dijo que va al Puerto de Cruceros. Opcional.',
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

// ─── Cotización (se calcula acá, NO en el prompt) ────────────────────────────
//
// Antes el modelo sacaba de cabeza los días, la base, el SunPass y la suma. Eso
// falla: en una cotización de 13 al 18 a USD 62/día devolvió 370 de base (no es
// ni 5×62 ni 6×62), y en otra puso la base en el lugar del total. Los campos que
// vienen calculados de la herramienta —passengersAmount, suitcasesAmount— nunca
// salieron mal, así que la plata pasa por el mismo camino.

// Días de alquiler contando AMBOS extremos: 13 al 18 = 6 días.
// Compara solo la parte de fecha en UTC para que el horario de retiro/devolución
// y los cambios de horario de verano no muevan la cuenta.
function diasDeAlquiler(startDateTime, endDateTime) {
  const inicio = Date.parse(`${startDateTime.slice(0, 10)}T00:00:00Z`);
  const fin = Date.parse(`${endDateTime.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(inicio) || Number.isNaN(fin)) return null;
  const dias = Math.round((fin - inicio) / 86_400_000) + 1;
  return dias > 0 ? dias : null;
}

// Cargo fijo por viaje según destino (prompt.js, sección SUNPASS).
const SUNPASS_POR_DESTINO = {
  'isla morada': 15,
  naples: 20,
  'key west': 20.7,
  clearwater: 24.7,
  daytona: 30,
  'west palm beach': 32.5,
  orlando: 38,
};

const CARGO_PUERTO_CRUCEROS = 50;

function normalizarDestino(d) {
  return String(d)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

// Sin destinos fuera de Miami: USD 15 por semana o fracción (1-7 → 15, 8-14 → 30…).
// Con destinos: suma de los cargos fijos de cada uno, como indica el prompt.
function cargoSunPass(dias, destinos) {
  const reconocidos = (destinos || [])
    .map(normalizarDestino)
    .filter((d) => d in SUNPASS_POR_DESTINO);

  if (!reconocidos.length) {
    return {
      monto: Math.ceil(dias / 7) * 15,
      detalle: 'tarifa base Miami (estimada: puede variar según los destinos del viaje)',
      esEstimado: true,
    };
  }

  const unicos = [...new Set(reconocidos)];
  return {
    monto: unicos.reduce((suma, d) => suma + SUNPASS_POR_DESTINO[d], 0),
    detalle: unicos.join(' + '),
    esEstimado: false,
  };
}

// Los montos con decimales van con coma, como en los ejemplos del prompt (USD 20,70).
function formatoUSD(n) {
  const redondeado = Math.round(n * 100) / 100;
  return Number.isInteger(redondeado) ? String(redondeado) : redondeado.toFixed(2).replace('.', ',');
}

// Devuelve la línea 💵 ya armada para que el modelo la copie tal cual.
function cotizarAuto(car, dias, sunPass, puertoDeCruceros) {
  if (dias == null || typeof car.pricePerDay !== 'number') return car;

  const base = car.pricePerDay * dias;
  const total = base + sunPass.monto + (puertoDeCruceros ? CARGO_PUERTO_CRUCEROS : 0);

  const partes = [`USD ${formatoUSD(base)} base`, `USD ${formatoUSD(sunPass.monto)} SunPass`];
  if (puertoDeCruceros) partes.push(`USD ${CARGO_PUERTO_CRUCEROS} Puerto de Cruceros`);

  return {
    ...car,
    dias,
    precioBase: formatoUSD(base),
    sunPass: formatoUSD(sunPass.monto),
    sunPassDetalle: sunPass.detalle,
    total: formatoUSD(total),
    lineaTotal: `💵 Total: USD ${formatoUSD(total)} (${partes.join(' + ')})`,
  };
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
    const { startDateTime, endDateTime, destinos, puertoDeCruceros } = toolInput;

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

    // Con fechas confirmadas, cada auto sale de acá con la cotización ya resuelta:
    // dias, precioBase, sunPass, total y la línea 💵 lista para copiar.
    const dias = startDateTime && endDateTime ? diasDeAlquiler(startDateTime, endDateTime) : null;
    if (dias == null) return { json: JSON.stringify(unique), images };

    const sunPass = cargoSunPass(dias, destinos);
    console.log(`[buscar_autos] ${dias} días · SunPass USD ${formatoUSD(sunPass.monto)} (${sunPass.detalle})`);

    const cotizados = unique.map((car) => cotizarAuto(car, dias, sunPass, puertoDeCruceros));
    return { json: JSON.stringify(cotizados), images };
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
Estás atendiendo por Instagram fuera del horario comercial: la empresa está cerrada y Patricia atiende personalmente durante el día. Podés responder consultas y cotizar con normalidad. Si el cliente necesita hablar con una persona, aclarale con calidez que Patricia lo va a contactar durante la mañana.

REGLAS DE ESTE CANAL — TIENEN PRIORIDAD SOBRE LAS SECCIONES DE ARRIBA
Instagram es un DM: cada bloque de auto se envía como un mensaje separado. Una lista larga se convierte en una ráfaga de mensajes que abruma al cliente. Por eso acá el criterio es "pocas opciones y bien elegidas", no "todas".

1) ANTES DE BUSCAR — CALIFICÁ MEJOR
Además de las fechas y los horarios de retiro/devolución, en este canal necesitás dos datos más antes de llamar a buscar_autos:
— Cuántas valijas llevan. Es el factor que realmente limita qué auto sirve.
— Qué destinos piensan visitar. Define el cargo de SunPass y si les conviene un auto más amplio.
Preguntalos de forma natural y en un mismo mensaje, respetando el máximo de 2 preguntas por mensaje. Ejemplo: "¡Buenísimo! ¿Cuántas valijas llevan y qué lugares tienen pensado visitar? Con eso te muestro las opciones que mejor les van."
Si el cliente no sabe o no contesta, no insistas más de una vez: buscá igual y mostrá las 3 opciones más versátiles.
Sigue vigente la regla de NUNCA sugerir modelos ni categorías antes de llamar a buscar_autos.

2) AL PRESENTAR — MÁXIMO 3 AUTOS
Llamá a buscar_autos normalmente, pero mostrale al cliente SOLO LOS 3 QUE MEJOR SE AJUSTAN a lo que pidió. Esto reemplaza la regla de "mostrá TODOS los autos disponibles" de la sección CÓMO PRESENTAR LOS AUTOS: en Instagram nunca muestres más de 3.
Para elegir esos 3 usás únicamente los datos reales que devuelve la herramienta:
— suitcasesAmount ≥ las valijas que dijo el cliente. Es el criterio principal.
— passengersAmount ≥ la cantidad de personas, si la mencionó.
— Si pidió un tipo puntual (minivan, SUV, auto chico), solo autos de ese tipo.
— A igualdad de condiciones, dale variedad de precio: una opción económica, una intermedia y una más amplia.
Si hay menos de 3 disponibles, mostrá los que haya. Nunca completes la lista con autos que no estén en el resultado de la herramienta.
El formato de cada auto es exactamente el de la sección CÓMO PRESENTAR LOS AUTOS — no lo abrevies ni le saques líneas. La foto de cada auto se envía automáticamente debajo de su bloque.

3) SIEMPRE ACLARÁ QUE HAY MÁS OPCIONES
Después del último auto, y antes del disclaimer de cotización, agregá una línea avisando que hay más opciones disponibles y ofreciendo pasarlas. Variá la redacción, no la repitas igual en cada conversación. Ejemplos:
— "Estas son las 3 que mejor se ajustan a lo que me contaste, pero tenemos más disponibles para esas fechas. Si querés ver alguna en particular, decime y te la paso."
— "Te dejo las 3 más convenientes para tu viaje. Hay otras opciones disponibles: si buscabas algo distinto (más chico, más grande, otro presupuesto), avisame y te muestro."
Nunca digas un número exacto de autos restantes.
Si el cliente pide otras opciones o un modelo puntual, volvé a llamar a buscar_autos con las mismas fechas y mostrale hasta 3 autos más, sin repetir los que ya le mandaste.`;

// Instrucciones que se suman SOLO cuando el barrido rescata una conversación
// vieja. El bot no puede tratarla como una charla en vivo: el cliente ya esperó
// horas, y abrir pidiéndole datos es lo que hace que se caiga el lead.
const RESCUE_INSTRUCTIONS = `━━━━━━━━━━━━━━━━━━━━━━━ CONTEXTO: RESCATE DE CONVERSACIÓN DEMORADA ━━━━━━━━━━━━━━━━━━━━━━━
Esta conversación quedó sin respuesta durante horas: el cliente escribió, nadie le contestó, y le estás escribiendo vos ahora. Él ya esperó. Estas reglas tienen prioridad sobre el flujo normal de este canal.

1) NO ARRANQUES PREGUNTANDO
Tu mensaje tiene que darle algo, no pedirle algo. Con los datos que el cliente ya te dio, avanzá todo lo que puedas: si alcanza para llamar a buscar_autos, buscá y mostrale las opciones con precios. Si ya venían hablando de un auto puntual, retomá desde ahí con información concreta.

2) UNA SOLA PREGUNTA, Y AL FINAL
Si te falta un dato para cerrar, pedí únicamente el más importante, y recién después de haberle dado la información. Nunca abras con una pregunta ni encadenes varias.

3) OFRECÉ EL ATAJO, PERO NO ESCRIBAS EL LINK
Junto a esa pregunta, hacele saber que puede cargar los datos él mismo sin esperar tu respuesta, en el formulario de pre-reserva de la web (le pide lugar de entrega y devolución, y fechas y horarios de cada una). NO escribas vos la dirección web: el sistema la agrega automáticamente al final del mensaje. Redactalo de manera que el link que aparece abajo se entienda solo. Ejemplo: "si preferís no esperar, podés cargar los horarios vos mismo en el formulario de pre-reserva".

4) NO REPITAS LA DISCULPA
El sistema ya antepone una nota disculpándose por la demora. No abras tu mensaje pidiendo perdón otra vez.

5) SI NO TE ALCANZA PARA NADA
Si lo que dijo el cliente no permite avanzar en absoluto, no improvises un interrogatorio: hacé una sola pregunta puntual y ofrecé el formulario.`;

// ─── Núcleo del bot (compartido entre la web y Instagram) ────────────────────

const FALLBACK_MSG = 'Tuve un problema procesando tu consulta. Escribile directamente a Patricia: https://wa.me/13057731787';

const MODEL = process.env.BOT_MODEL || 'claude-sonnet-5';
// "high" es el default de Sonnet 5 y va explícito a propósito. Estuvo un tiempo
// en "medium" para ahorrar y salió caro: abajo de "high" el modelo usa bastante
// menos las tools y acota el trabajo a lo literalmente pedido — justo lo que este
// bot no puede permitirse, porque vive de llamar a buscar_autos y de respetar un
// formato de card largo. La diferencia real son centavos por conversación.
const EFFORT = process.env.BOT_EFFORT || 'high';

// Deja UN solo breakpoint de cache en la historia: el último bloque del último
// mensaje. Los mensajes que llegan de afuera pueden traer content como string
// (no acepta cache_control), así que en ese caso no marca nada y listo.
function marcarUltimoBloque(messages) {
  for (const m of messages) {
    if (Array.isArray(m.content)) for (const b of m.content) delete b.cache_control;
  }
  const ultimo = messages[messages.length - 1];
  if (!ultimo || !Array.isArray(ultimo.content) || !ultimo.content.length) return;
  ultimo.content[ultimo.content.length - 1].cache_control = { type: 'ephemeral' };
}

async function runBot(messages, { channel = 'web', rescate = false } = {}) {
  let currentMessages = [...messages];
  let finalText = '';
  let lastSearchImages = [];

  const today = floridaDateStr();

  // El prompt + el sufijo de Instagram son ~12k tokens que se repiten en CADA
  // llamada, y en el loop de tools se repiten hasta 15 veces por conversación.
  // Por eso van primero y con cache_control: la primera llamada escribe el cache
  // y las demás lo leen a ~0,1x del precio de input.
  //
  // El cache es un match por PREFIJO: alcanza con que cambie un byte arriba para
  // invalidar todo lo que sigue. Por eso la fecha —lo único que varía— va en un
  // segundo bloque, DESPUÉS del breakpoint. Antes estaba arriba de todo, que es
  // justo lo que impide cachear. Las TOOLS se renderizan antes que el system, así
  // que este breakpoint las cubre también.
  const stable = channel === 'instagram'
    ? `${SYSTEM_PROMPT}\n\n${INSTAGRAM_NIGHT_SUFFIX}`
    : SYSTEM_PROMPT;

  const system = [
    { type: 'text', text: stable, cache_control: { type: 'ephemeral' } },
    {
      type: 'text',
      text: `Hoy es ${today}. Cuando el cliente mencione fechas sin año, usá siempre el año corriente o el siguiente si la fecha ya pasó.${rescate ? `\n\n${RESCUE_INSTRUCTIONS}` : ''}`,
    },
  ];

  const MAX_ITERATIONS = 15;
  let iterations = 0;

  while (true) {
    if (++iterations > MAX_ITERATIONS) {
      console.error(`[bot:${channel}] Máximo de iteraciones alcanzado`);
      return { text: FALLBACK_MSG, images: [], quickReplies: [] };
    }

    const response = await client.messages.create({
      model: MODEL,
      // Sonnet 5 piensa por defecto (4.5 no lo hacía), y max_tokens es el techo del
      // pensamiento MÁS el texto de la respuesta. Con los 2048 de antes una consulta
      // con varias vueltas de tools se cortaba a la mitad. 8192 da aire de sobra.
      max_tokens: 8192,
      system,
      tools: TOOLS,
      messages: currentMessages,
      // Explícito aunque hoy sea el default: si el default cambiara, apagar el
      // pensamiento sin querer haría que el modelo use todavía menos las tools.
      thinking: { type: 'adaptive' },
      output_config: { effort: EFFORT },
    });

    // Con el cache andando, la primera llamada escribe y las siguientes leen a ~0,1x.
    // Si cache_read queda en 0 llamada tras llamada, algo se volvió a meter arriba
    // del breakpoint (una fecha, una hora, un id) y hay que sacarlo de ahí.
    if (process.env.BOT_DEBUG_CACHE === 'true') {
      const u = response.usage;
      console.log(`[cache:${channel}] write=${u.cache_creation_input_tokens ?? 0} read=${u.cache_read_input_tokens ?? 0} sin_cachear=${u.input_tokens}`);
    }

    // Un rechazo de los clasificadores llega como HTTP 200 con content vacío: si no
    // se mira stop_reason antes de leer el contenido, el cliente recibe un mensaje
    // en blanco. Sonnet 5 es bastante más capaz en ciberseguridad que 4.5 y por eso
    // rechaza más seguido, aunque para este bot el riesgo es casi nulo.
    if (response.stop_reason === 'refusal') {
      console.warn(`[bot:${channel}] Respuesta rechazada por los clasificadores`);
      return { text: FALLBACK_MSG, images: [], quickReplies: [] };
    }

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

      // Los resultados de buscar_autos son JSON grandes y se reenvían enteros en
      // cada vuelta del loop. Un breakpoint móvil al final de la historia hace que
      // la vuelta siguiente lea todo eso del cache en vez de reprocesarlo. Se
      // limpia el anterior porque la API acepta 4 breakpoints por request: dejando
      // uno solo acá (más el del system) nunca nos pasamos.
      currentMessages.push({ role: 'user', content: toolResults });
      marcarUltimoBloque(currentMessages);
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
    // Con thinking activo y hasta 15 vueltas de loop de tools, 45s quedaba corto
    // y el cliente terminaba leyendo el mensaje de abajo en vez de su cotización.
  }, 90000);

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

// ─── Ritmo de envío en Instagram ─────────────────────────────────────────────
// Meta penaliza las ráfagas de mensajes automáticos. Espaciamos cada envío con
// una pausa aleatoria (el jitter importa: una cadencia exacta y constante es más
// fácil de detectar como bot que una variable) y mostramos "escribiendo…" para
// que la espera se vea natural en vez de parecer que el bot se colgó.
const IG_MSG_DELAY_MS = Number(process.env.IG_MSG_DELAY_MS ?? 3500);
const IG_MSG_JITTER_MS = Number(process.env.IG_MSG_JITTER_MS ?? 1200);
const IG_TYPING = (process.env.IG_TYPING || 'true') !== 'false';
// Tope duro de autos por respuesta. El prompt ya le pide al bot mostrar como
// máximo esta cantidad; esto es la red de seguridad por si igual manda de más.
const IG_MAX_CARS = Number(process.env.IG_MAX_CARS ?? 3);

// Pausa aleatoria alrededor de IG_MSG_DELAY_MS (con los valores por defecto: 2,3s a 4,7s)
function humanDelay() {
  const jitter = (Math.random() * 2 - 1) * IG_MSG_JITTER_MS;
  return Math.max(500, Math.round(IG_MSG_DELAY_MS + jitter));
}

async function igSendAction(recipientId, action) {
  if (!IG_TYPING) return;
  const base = process.env.IG_GRAPH_BASE || 'https://graph.facebook.com/v21.0';
  const token = process.env.IG_ACCESS_TOKEN;
  if (!token) return;
  try {
    const res = await fetch(`${base}/me/messages?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: recipientId }, sender_action: action }),
    });
    // No es crítico: si falla, seguimos enviando igual (solo perdemos el indicador)
    if (!res.ok) console.warn('[ig] sender_action falló:', res.status);
  } catch (err) {
    console.warn('[ig] sender_action error:', err.message);
  }
}

// Envía una secuencia de mensajes ya armada, respetando el ritmo humano.
async function igSendSequence(recipientId, messages) {
  const session = igSessions.get(recipientId);
  for (const [i, message] of messages.entries()) {
    // Con la pausa humana la secuencia dura ~20s: tiempo de sobra para que
    // Patricia conteste a mano en el medio. Si eso pasa, cortamos acá en vez de
    // seguir mandando mensajes encima de su respuesta.
    if (session?.humanUntil && Date.now() < session.humanUntil) {
      console.log(`[ig] Handoff humano durante el envío — corto la secuencia (quedaban ${messages.length - i} mensajes)`);
      return;
    }
    await igSendAction(recipientId, 'typing_on');
    // El primero sale antes: el cliente ya esperó lo que tardó runBot en pensar
    await sleep(i === 0 ? Math.min(1200, humanDelay()) : humanDelay());
    try {
      await igSend(recipientId, message);
    } catch (err) {
      console.error('[ig] Error enviando mensaje de la secuencia:', err.message);
    }
  }
}

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

  const outbound = buildIgOutbound(result, isFirstReply ? IG_CLOSED_NOTE : '');
  console.log(`[ig] Enviando ${outbound.length} mensajes (pausa ~${IG_MSG_DELAY_MS}ms ±${IG_MSG_JITTER_MS}ms)`);
  await igSendSequence(senderId, outbound);
}

// Arma la secuencia de salida de una respuesta del bot. `leadNote` es el texto
// que se antepone al primer mensaje (nota de "estamos cerrados" o de disculpa
// por la demora); vacío si no corresponde ninguna. `trailNote` es el texto que
// se manda como último mensaje de la ráfaga (el link de pre-reserva); va por
// código y no por prompt para que salga siempre, sin depender del modelo.
// Cuantos menos mensajes, mejor: la ráfaga es lo que Meta mira.
function buildIgOutbound(result, leadNote = '', trailNote = '') {
  const images = result.images || [];
  const sendImages = (process.env.IG_SEND_IMAGES || 'true') !== 'false';
  const { intro, cars, outro } = splitIntoSegments(result.text);

  const outbound = [];
  const pushText = (t) => {
    for (const chunk of chunkText(formatForInstagram(t))) outbound.push({ text: chunk });
  };
  const pushImage = (url) => outbound.push({ attachment: { type: 'image', payload: { url, is_reusable: false } } });

  if (cars.length === 0 || images.length === 0 || !sendImages) {
    // Caso simple (sin autos o sin fotos): todo el texto y, si hay, las fotos al final
    pushText(leadNote ? `${leadNote}\n\n${result.text}` : result.text);
    if (sendImages) for (const img of images.slice(0, IG_MAX_CARS)) pushImage(img.url);
    if (trailNote) outbound.push({ text: trailNote });
    return outbound;
  }

  // Caso con autos + fotos: intro → (texto del auto + su foto) por cada auto → cierre
  const introFull = (leadNote ? `${leadNote}${intro ? `\n\n${intro}` : ''}` : intro).trim();
  const shown = cars.slice(0, IG_MAX_CARS);

  // Si la intro es corta, la mandamos pegada al primer auto en vez de como
  // mensaje aparte — un mensaje menos en la secuencia.
  const mergeIntro = introFull && shown.length > 0 &&
    (introFull.length + shown[0].text.length) < 600;

  if (introFull && !mergeIntro) pushText(introFull);

  shown.forEach((car, i) => {
    pushText(mergeIntro && i === 0 ? `${introFull}\n\n${car.text}` : car.text);
    const img = findImageFor(car.name, images);
    if (img) pushImage(img.url);
  });

  if (outro.trim()) pushText(outro);
  if (trailNote) outbound.push({ text: trailNote });
  return outbound;
}

// ─── Barrido de rescate: contestar lo que quedó colgado ──────────────────────
// De día contesta Patricia y el bot está callado. Si un mensaje se le pasa, el
// cliente queda sin respuesta hasta que se cansa. Este barrido corre durante el
// turno del bot, lee las conversaciones REALES desde la Graph API (no desde
// igSessions, que se pierde en cada redeploy de Railway) y contesta las que
// quedaron sin respuesta.
//
// LÍMITE DE META: solo se puede escribirle a alguien dentro de las 24hs de su
// último mensaje. Lo más viejo que eso no se puede rescatar por API — el barrido
// lo saltea y lo deja listado en el log para que lo conteste Patricia a mano.
//
// El barrido es idempotente por naturaleza: apenas contesta, el último mensaje
// del hilo pasa a ser nuestro, así que el siguiente barrido ya no lo levanta.

const IG_RESCUE_ENABLED = (process.env.IG_RESCUE_ENABLED || 'true') !== 'false';
// Contesta de verdad. IG_RESCUE_DRY_RUN=true lo pasa a simulacro: loguea a quién
// le contestaría y con qué texto, sin enviar nada. Útil para depurar.
const IG_RESCUE_DRY_RUN = (process.env.IG_RESCUE_DRY_RUN || 'false') !== 'false';
const IG_RESCUE_INTERVAL_MIN = Number(process.env.IG_RESCUE_INTERVAL_MIN ?? 60);
// Margen para no pisarle una respuesta que Patricia esté escribiendo justo ahora.
// Corto a propósito: el barrido corre cuando ella ya terminó su turno, así que a
// las 23:00 tiene que levantar prácticamente todo el día.
const IG_RESCUE_MIN_AGE_MIN = Number(process.env.IG_RESCUE_MIN_AGE_MIN ?? 15);
// Tope de antigüedad, con colchón contra las 24hs de Meta.
const IG_RESCUE_MAX_AGE_H = Number(process.env.IG_RESCUE_MAX_AGE_H ?? 20);
const IG_RESCUE_MAX_CONV = Number(process.env.IG_RESCUE_MAX_CONV ?? 15);
// Pausa entre conversaciones. Contestarle a 10 personas seguidas en 30s es
// exactamente el patrón que Meta marca como spam.
const IG_RESCUE_GAP_MS = Number(process.env.IG_RESCUE_GAP_MS ?? 45000);

const IG_RESCUE_NOTE_FIRST = 'Hola, perdón por la demora. Soy el asistente comercial de Florida Aventura: te respondo ahora mismo y mañana a la mañana te atiende Patricia.';
const IG_RESCUE_NOTE_FOLLOWUP = 'Perdón por la demora, te sigo por acá.';
// Cierre fijo del rescate: el link de pre-reserva de la web. Sale como último
// mensaje de la ráfaga. El prompt de rescate tiene prohibido escribir la URL,
// así que el link aparece una sola vez y aparece siempre.
const IG_PREBOOKING_NOTE = 'Si preferís no esperar, podés dejar tu pre-reserva directamente acá: https://www.floridaaventura.com/';

async function igGraph(path, params = {}) {
  const base = process.env.IG_GRAPH_BASE || 'https://graph.facebook.com/v21.0';
  const token = process.env.IG_ACCESS_TOKEN;
  if (!token) throw new Error('Falta IG_ACCESS_TOKEN');
  const qs = new URLSearchParams({ ...params, access_token: token });
  const res = await fetch(`${base}${path}?${qs}`);
  if (!res.ok) throw new Error(`Graph ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

// Identificar "nuestra" cuenta es la parte delicada del barrido: según cómo se
// generó el token, /me puede devolver el ID de la página de Facebook mientras
// que los mensajes de Instagram vienen con el IGSID de la cuenta. Son números
// distintos. Si comparáramos contra uno solo y fuera el equivocado, NINGÚN
// mensaje figuraría como nuestro y el bot le volvería a escribir a todo el
// mundo. Por eso juntamos todos los IDs que puedan representarnos.
let igOwnIds = null;
async function getIgOwnIds() {
  if (igOwnIds) return igOwnIds;
  const ids = new Set();
  if (process.env.IG_ACCOUNT_ID) ids.add(process.env.IG_ACCOUNT_ID);
  try {
    const me = await igGraph('/me', { fields: 'user_id,username' });
    if (me.user_id) ids.add(me.user_id);
    if (me.id) ids.add(me.id);
  } catch (err) {
    console.warn('[rescate] No pude leer /me:', err.message);
  }
  if (!ids.size) throw new Error('No pude determinar el ID de nuestra cuenta — abortá el barrido');
  console.log(`[rescate] IDs propios: ${[...ids].join(', ')}`);
  igOwnIds = ids;
  return igOwnIds;
}

// Convierte los mensajes de la Graph API al formato que espera runBot.
// Dos cosas importantes: la API los devuelve del más nuevo al más viejo, y la
// API de Anthropic exige alternancia estricta user/assistant (varios mensajes
// seguidos del mismo lado hay que fusionarlos).
function toBotMessages(apiMessages, ownIds) {
  const out = [];
  for (const m of [...apiMessages].reverse()) {
    const text = (m.message || '').trim();
    if (!text) continue; // fotos, stickers y audios no aportan contexto de texto
    const role = ownIds.has(m.from?.id) ? 'assistant' : 'user';
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += `\n${text}`;
    else out.push({ role, content: text });
  }
  while (out.length && out[0].role === 'assistant') out.shift(); // tiene que arrancar con el cliente
  return out;
}

async function rescuePendingConversations() {
  const ownIds = await getIgOwnIds();
  const data = await igGraph('/me/conversations', {
    platform: 'instagram',
    limit: '50',
    fields: 'participants,updated_time,messages.limit(30){id,created_time,from,message}',
  });
  const conversations = data?.data || [];
  console.log(`[rescate] ${conversations.length} conversaciones a revisar${IG_RESCUE_DRY_RUN ? ' (SIMULACRO — no envío nada)' : ''}`);

  // Freno de mano. Si en NINGÚN mensaje de NINGUNA conversación aparece uno de
  // nuestros IDs, es que los IDs no coinciden con los que usa la API de mensajes
  // (página vs IGSID). En ese caso todo figuraría como "sin responder" y el bot
  // le escribiría de nuevo a gente ya atendida. Preferimos no hacer nada.
  const totalMsgs = conversations.reduce((n, c) => n + (c.messages?.data?.length || 0), 0);
  const propios = conversations.reduce(
    (n, c) => n + (c.messages?.data || []).filter((m) => ownIds.has(m.from?.id)).length, 0);
  if (totalMsgs > 0 && propios === 0) {
    console.error(`[rescate] ⚠️  ABORTO: revisé ${totalMsgs} mensajes y ninguno figura como nuestro. Los IDs propios (${[...ownIds].join(', ')}) no coinciden con los de la API de mensajes. Seteá IG_ACCOUNT_ID con el IGSID correcto antes de seguir.`);
    return { revisadas: conversations.length, contestadas: 0, fueraDeVentana: [], salteadas: conversations.length, abortado: true };
  }

  const summary = { revisadas: conversations.length, contestadas: 0, fueraDeVentana: [], salteadas: 0 };

  for (const conv of conversations) {
    if (summary.contestadas >= IG_RESCUE_MAX_CONV) {
      console.log(`[rescate] Tope de ${IG_RESCUE_MAX_CONV} conversaciones alcanzado — corto acá`);
      break;
    }

    const msgs = conv.messages?.data || [];
    if (!msgs.length) { summary.salteadas++; continue; }

    const last = msgs[0]; // el más nuevo
    if (ownIds.has(last.from?.id)) { summary.salteadas++; continue; } // ya está contestada

    const senderId = last.from?.id;
    if (!senderId) { summary.salteadas++; continue; }

    const who = conv.participants?.data?.find((p) => !ownIds.has(p.id));
    const label = who?.username ? `@${who.username}` : senderId;

    const ageMs = Date.now() - Date.parse(last.created_time);
    if (!Number.isFinite(ageMs)) { summary.salteadas++; continue; }

    if (ageMs < IG_RESCUE_MIN_AGE_MIN * 60000) {
      console.log(`[rescate] ${label}: sin respuesta hace ${Math.round(ageMs / 60000)} min — todavía es de Patricia, salteo`);
      summary.salteadas++;
      continue;
    }
    if (ageMs > IG_RESCUE_MAX_AGE_H * 3600000) {
      const horas = Math.round(ageMs / 3600000);
      console.log(`[rescate] ${label}: sin respuesta hace ${horas}hs — FUERA de la ventana de 24hs de Meta, lo tiene que contestar Patricia a mano`);
      summary.fueraDeVentana.push({ label, horas });
      continue;
    }

    const session = getIgSession(senderId);
    if (session.humanUntil && Date.now() < session.humanUntil) {
      console.log(`[rescate] ${label}: handoff humano activo — no me meto`);
      summary.salteadas++;
      continue;
    }

    const history = toBotMessages(msgs, ownIds);
    if (!history.length || history[history.length - 1].role !== 'user') {
      console.log(`[rescate] ${label}: no pude reconstruir la charla (¿mensajes sin texto?) — salteo`);
      summary.salteadas++;
      continue;
    }

    console.log(`[rescate] ${label}: sin respuesta hace ${Math.round(ageMs / 60000)} min — contesto (${history.length} mensajes de contexto)`);

    let result;
    try {
      result = await runBot(history, { channel: 'instagram', rescate: true });
    } catch (err) {
      console.error(`[rescate] ${label}: runBot falló — ${err.message}`);
      summary.salteadas++;
      continue;
    }

    const yaHablamos = history.some((m) => m.role === 'assistant');
    const outbound = buildIgOutbound(
      result,
      yaHablamos ? IG_RESCUE_NOTE_FOLLOWUP : IG_RESCUE_NOTE_FIRST,
      IG_PREBOOKING_NOTE
    );

    // Dejamos asentado qué se le mandó a cada uno: a la mañana siguiente es el
    // único registro para auditar el barrido sin abrir el inbox uno por uno.
    console.log(`[rescate] ${IG_RESCUE_DRY_RUN ? 'SIMULACRO — a' : 'A'} ${label} le ${IG_RESCUE_DRY_RUN ? 'mandaría' : 'mando'} ${outbound.length} mensajes:`);
    for (const m of outbound) console.log(`  · ${m.text ? m.text.slice(0, 160).replace(/\n/g, ' ⏎ ') : `[foto] ${m.attachment?.payload?.url}`}`);

    if (!IG_RESCUE_DRY_RUN) {
      // Dejamos la charla cargada en memoria para que, si el cliente responde,
      // el webhook siga la conversación en vez de arrancar de cero.
      session.messages = [...history, { role: 'assistant', content: result.text }];
      session.updatedAt = Date.now();
      await igSendSequence(senderId, outbound);
    }

    summary.contestadas++;
    await sleep(IG_RESCUE_GAP_MS);
  }

  console.log(`[rescate] Listo — ${summary.contestadas} contestadas, ${summary.salteadas} salteadas, ${summary.fueraDeVentana.length} fuera de ventana`);
  if (summary.fueraDeVentana.length) {
    console.log(`[rescate] Para Patricia (fuera de las 24hs, hay que contestarlos a mano): ${summary.fueraDeVentana.map((c) => `${c.label} (${c.horas}hs)`).join(', ')}`);
  }
  return summary;
}

// ─── Estado del token ────────────────────────────────────────────────────────
// El token de Meta puede vencer y, cuando vence, el bot deja de contestar EN
// SILENCIO: los envíos fallan y nadie se entera hasta que alguien mira el inbox.
// Lo consultamos al arrancar y una vez por día para que quede en los logs.

async function logTokenStatus() {
  const token = process.env.IG_ACCESS_TOKEN;
  if (!token) { console.warn('[token] No hay IG_ACCESS_TOKEN configurado'); return; }
  try {
    const qs = new URLSearchParams({ input_token: token, access_token: token });
    const res = await fetch(`https://graph.facebook.com/debug_token?${qs}`);
    const body = await res.json();
    if (body.error) { console.error(`[token] No pude verificarlo: ${body.error.message}`); return; }

    const d = body.data || {};
    if (!d.is_valid) { console.error('[token] ⚠️  EL TOKEN NO ES VÁLIDO — el bot no puede contestar'); return; }

    if (!d.expires_at) {
      console.log('[token] OK — no expira (token de larga duración)');
      return;
    }
    const dias = Math.round((d.expires_at * 1000 - Date.now()) / 86400000);
    const fecha = new Date(d.expires_at * 1000).toISOString().slice(0, 10);
    if (dias <= 14) console.error(`[token] ⚠️  VENCE EN ${dias} DÍAS (${fecha}) — hay que renovarlo en Meta`);
    else console.log(`[token] OK — vence en ${dias} días (${fecha})`);
  } catch (err) {
    console.error('[token] Error consultando debug_token:', err.message);
  }
}

let rescueRunning = false;
let lastRescueAt = 0;

// Chequeamos seguido pero barremos espaciado. Así el primer barrido cae apenas
// arranca el turno del bot (23:00) en vez de hasta una hora después, que es
// justo el momento que importa: es cuando Patricia deja de contestar y hay que
// levantar todo lo que quedó colgado del día.
const RESCUE_CHECK_MS = 5 * 60 * 1000;

async function rescueTick({ force = false } = {}) {
  if (!IG_RESCUE_ENABLED) return null;
  if (!force) {
    if (!isBotActiveNow()) return null;
    if (Date.now() - lastRescueAt < IG_RESCUE_INTERVAL_MIN * 60000) return null;
  }
  if (rescueRunning) { console.log('[rescate] Ya hay un barrido en curso — salteo este tick'); return null; }
  rescueRunning = true;
  lastRescueAt = Date.now();
  try {
    return await rescuePendingConversations();
  } catch (err) {
    console.error('[rescate] Error:', err.message);
    return null;
  } finally {
    rescueRunning = false;
  }
}

// Disparo manual para probar sin esperar a las 23:00. Requiere IG_RESCUE_TOKEN.
app.post('/admin/ig-rescue', async (req, res) => {
  const token = process.env.IG_RESCUE_TOKEN;
  if (!token || req.get('x-rescue-token') !== token) return res.sendStatus(403);
  const summary = await rescueTick({ force: true });
  res.json({ dryRun: IG_RESCUE_DRY_RUN, summary });
});

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
  console.log(`[ig] Ritmo: pausa ${IG_MSG_DELAY_MS}ms ±${IG_MSG_JITTER_MS}ms · typing ${IG_TYPING ? 'on' : 'off'} · máx ${IG_MAX_CARS} autos por respuesta`);

  logTokenStatus();
  setInterval(logTokenStatus, 24 * 60 * 60 * 1000);

  if (IG_RESCUE_ENABLED) {
    console.log(`[rescate] Activo: primer barrido al arrancar el turno (${process.env.IG_BOT_START_HOUR ?? 23}:00) y después cada ${IG_RESCUE_INTERVAL_MIN} min · rescata entre ${IG_RESCUE_MIN_AGE_MIN} min y ${IG_RESCUE_MAX_AGE_H}hs de antigüedad · máx ${IG_RESCUE_MAX_CONV} por barrido${IG_RESCUE_DRY_RUN ? ' · SIMULACRO (no envía)' : ''}`);
    setInterval(() => { rescueTick(); }, RESCUE_CHECK_MS);
    setTimeout(() => { rescueTick(); }, 60000); // por si el proceso arranca con el turno ya empezado
  } else {
    console.log('[rescate] Desactivado (IG_RESCUE_ENABLED=false)');
  }
});
