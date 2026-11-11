import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT, IG_HEADER_ABIERTO, INSTAGRAM_CHANNEL_RULES } from '../prompt.js';
import { cargoSunPass, cotizarAuto, prepararRango, respuestaMinimoNoCumplido, resultadoConFechas, pasarAlAnioSiguiente, MINIMO_DIAS } from '../cotizacion.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Parámetros del modelo (los mismos que runBot en server.js) ──────────────

// Un eval que llama al modelo distinto que producción mide otra cosa: con 2048 de
// max_tokens y sin effort explícito, las cotizaciones salían cortadas a mitad de
// la lista de autos y cada modelo corría con su effort por defecto.
// BOT_MODEL y BOT_EFFORT son las mismas variables (y defaults) que lee server.js.
// EVAL_MAX_TOKENS y EVAL_THINKING existen solo acá: el server los tiene fijos.
const MODEL = process.env.BOT_MODEL || 'claude-sonnet-5';
const EFFORT = process.env.BOT_EFFORT || 'high';
const MAX_TOKENS = Number(process.env.EVAL_MAX_TOKENS || 8192);
const THINKING = process.env.EVAL_THINKING || 'adaptive';

// ─── Fechas relativas en el dataset ──────────────────────────────────────────

// {{fecha:+N}} en el input se reemplaza por "D de mes", contado desde la misma
// fecha que se inyecta en el system prompt. Así un caso como "desde hoy ..." no
// queda desfasado de la fecha que ve el modelo.
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// Copia de floridaDateStr de server.js (no se puede importar: importar server.js
// levanta el servidor). Misma zona y misma variable IG_TZ, así el eval ve el mismo
// "hoy" que el bot; en UTC, después de las 20hs de Florida ya era mañana.
const IG_TZ = process.env.IG_TZ || 'America/New_York';

function floridaDateStr() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: IG_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function renderFechas(texto, today) {
  return texto.replace(/\{\{fecha:([+-]\d+)\}\}/g, (_, offset) => {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + Number(offset));
    return `${d.getUTCDate()} de ${MESES[d.getUTCMonth()]}`;
  });
}

// ─── Argumentos --categoria y --casos ────────────────────────────────────────

const args = process.argv.slice(2);

const categoriaIdx = args.findIndex(a => a === '--categoria');
const categoriaFiltro = categoriaIdx !== -1 ? args[categoriaIdx + 1]?.toUpperCase() : null;

const casosIdx = args.findIndex(a => a === '--casos');
const casosFiltro = casosIdx !== -1
  ? args[casosIdx + 1]?.toUpperCase().split(',').map(s => s.trim()).filter(Boolean)
  : null;

// ─── Tool definition (idéntica a server.js) ───────────────────────────────────

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
            'en ese caso se cotiza el SunPass para recorrer Miami. Opcional.',
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

// ─── Mock data ────────────────────────────────────────────────────────────────

// Flota real sincronizada con https://api.floridaaventura.com/public/cars (2026-03-30)
const MOCK_CARS = [
  { id: 1,  brand: 'Honda',      model: 'HRV',       name: 'Honda HRV',                      showColorInName: false, year: 2025, color: 'Gris',            passengersAmount: 5, manual: false, suitcasesAmount: 3, pricePerDay: 55.0, type: 'MEDIUM', imageUrl: 'https://example.com/hrv.jpg' },
  { id: 2,  brand: 'Nissan',     model: 'Kicks',     name: 'Nissan Kicks',                   showColorInName: false, year: 2024, color: 'Gris',            passengersAmount: 5, manual: false, suitcasesAmount: 3, pricePerDay: 54.0, type: 'MEDIUM', imageUrl: 'https://example.com/kicks.jpg' },
  { id: 3,  brand: 'Nissan',     model: 'New Kicks', name: 'Nissan New Kicks',               showColorInName: false, year: 2025, color: 'Blanca',          passengersAmount: 5, manual: false, suitcasesAmount: 3, pricePerDay: 55.0, type: 'MEDIUM', imageUrl: 'https://example.com/new-kicks.jpg' },
  { id: 4,  brand: 'Nissan',     model: 'Rogue',     name: 'Nissan Rogue(Blanca)',           showColorInName: true,  year: 2024, color: 'Blanca',          passengersAmount: 5, manual: false, suitcasesAmount: 3, pricePerDay: 59.0, type: 'MEDIUM', imageUrl: 'https://example.com/rogue-blanca.jpg' },
  { id: 5,  brand: 'Nissan',     model: 'Rogue',     name: 'Nissan Rogue(Camel)',            showColorInName: true,  year: 2024, color: 'Camel',           passengersAmount: 5, manual: false, suitcasesAmount: 3, pricePerDay: 59.0, type: 'MEDIUM', imageUrl: 'https://example.com/rogue-camel.jpg' },
  { id: 6,  brand: 'Nissan',     model: 'Rogue',     name: 'Nissan Rogue(Negra)',            showColorInName: true,  year: 2024, color: 'Negra',           passengersAmount: 5, manual: false, suitcasesAmount: 3, pricePerDay: 59.0, type: 'MEDIUM', imageUrl: 'https://example.com/rogue-negra.jpg' },
  { id: 7,  brand: 'Honda',      model: 'Odyssey',   name: 'Honda Odyssey',                  showColorInName: false, year: 2025, color: 'Celeste',         passengersAmount: 8, manual: false, suitcasesAmount: 4, pricePerDay: 78.0, type: 'LARGE',  imageUrl: 'https://example.com/odyssey.jpg' },
  { id: 8,  brand: 'Honda',      model: 'CRV',       name: 'Honda CRV',                      showColorInName: false, year: 2024, color: 'Blanca',          passengersAmount: 5, manual: false, suitcasesAmount: 3, pricePerDay: 62.0, type: 'MEDIUM', imageUrl: 'https://example.com/crv.jpg' },
  { id: 9,  brand: 'Volkswagen', model: 'Tiguan',    name: 'Volkswagen Tiguan',              showColorInName: false, year: 2024, color: 'Gris',            passengersAmount: 7, manual: false, suitcasesAmount: 2, pricePerDay: 62.0, type: 'LARGE',  imageUrl: 'https://example.com/tiguan.jpg' },
  { id: 10, brand: 'Volkswagen', model: 'Atlas',     name: 'Volkswagen Atlas(Negra)',        showColorInName: true,  year: 2025, color: 'Negra',           passengersAmount: 8, manual: false, suitcasesAmount: 2, pricePerDay: 65.0, type: 'LARGE',  imageUrl: 'https://example.com/atlas-negra.jpg' },
  { id: 11, brand: 'Volkswagen', model: 'Atlas',     name: 'Volkswagen Atlas(Cristal (Negra))', showColorInName: true, year: 2025, color: 'Cristal (Negra)', passengersAmount: 8, manual: false, suitcasesAmount: 2, pricePerDay: 65.0, type: 'LARGE',  imageUrl: 'https://example.com/atlas-cristal.jpg' },
  { id: 12, brand: 'Hyunday',    model: 'Santa Fe',  name: 'Hyunday Santa Fe',               showColorInName: false, year: 2026, color: 'Blanca',          passengersAmount: 7, manual: false, suitcasesAmount: 2, pricePerDay: 65.0, type: 'LARGE',  imageUrl: 'https://example.com/santa-fe.jpg' },
];

// ─── Mock tool executor ───────────────────────────────────────────────────────

// Copia de floridaTodayISO y errorFechasPasadas de server.js (no se pueden
// importar sin levantar el server). Sin este chequeo, una búsqueda con un año
// ya pasado (julio 2026 consultado en octubre 2026) cotizaba normal en el eval
// y daba PASS, cuando en producción se corta y el modelo tiene que confirmar el año.
function floridaTodayISO() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.FA_TIMEZONE || 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function errorFechasPasadas(startDateTime, endDateTime) {
  const hoy = floridaTodayISO();
  const inicio = startDateTime.slice(0, 10);
  const fin = endDateTime.slice(0, 10);
  if (inicio < hoy) {
    return `La fecha de retiro ${inicio} ya pasó (hoy es ${hoy}). Probablemente el cliente se refiere al año siguiente: confirmá con él el año exacto y volvé a buscar. No le digas que no hay disponibilidad.`;
  }
  if (fin < inicio) {
    return `La fecha de devolución ${fin} es anterior a la de retiro ${inicio}. Confirmá las fechas con el cliente y volvé a buscar.`;
  }
  return null;
}

function executeMockTool(toolName, toolInput, caso) {
  const caseId = caso.id;
  if (toolName !== 'buscar_autos') throw new Error(`Herramienta desconocida: ${toolName}`);

  // Mismo camino y mismo orden que executeTool en server.js: validación de
  // fechas y mínimo primero, después la "API" (acá C5 falla y C6 viene vacía).
  // Con fechas, cada auto sale cotizado (dias, precioBase, sunPass, total y la
  // línea 💵). Sin fechas, catálogo pelado. Las funciones son las de
  // cotizacion.js, las mismas que corren en producción: si el eval cotizara por
  // su cuenta, podría dar PASS con una cuenta que el server hace distinto.
  const { startDateTime, endDateTime, destinos, puertoDeCruceros } = toolInput || {};
  let rango = null;
  let avisoAnio = null;
  if (startDateTime && endDateTime) {
    rango = prepararRango(startDateTime, endDateTime);
    // Igual que server.js: retiro ya pasado → se cotiza el año siguiente.
    const corrido = pasarAlAnioSiguiente(rango.startDateTime, rango.endDateTime, floridaTodayISO());
    if (corrido) {
      avisoAnio = corrido.aviso;
      rango = { ...prepararRango(corrido.startDateTime, corrido.endDateTime), horariosEstimados: rango.horariosEstimados };
    }
    const errorFechas = errorFechasPasadas(rango.startDateTime, rango.endDateTime);
    if (errorFechas) return JSON.stringify({ error: errorFechas });
    if (rango.dias == null) return JSON.stringify({ error: 'La devolución tiene que ser posterior al retiro. Confirmá fechas y horarios con el cliente.' });
    if (rango.dias < MINIMO_DIAS) return JSON.stringify(respuestaMinimoNoCumplido(rango));
  }

  if (caseId === 'C5') {
    throw new Error('Florida Aventura API error: 503 Service Unavailable');
  }
  if (caseId === 'C6') {
    return JSON.stringify([]);
  }

  if (!rango) return JSON.stringify(MOCK_CARS);

  // mock_ocupados: autos que existen en la flota pero no están libres para las
  // fechas del caso (con fechas no vuelven; sin fechas, sí).
  // EVAL_OCUPADOS="Auto A,Auto B" simula ocupados en todos los casos (como en producción).
  const ocupados = caso.mock_ocupados || (process.env.EVAL_OCUPADOS ? process.env.EVAL_OCUPADOS.split(',').map((n) => n.trim()) : []);
  const libres = MOCK_CARS.filter((car) => !ocupados.includes(car.name));

  const sunPass = cargoSunPass(rango.dias, destinos);
  const cotizados = libres.map((car) => ({
    ...cotizarAuto(car, rango.dias, sunPass, puertoDeCruceros),
    retiro: rango.retiro,
    devolucion: rango.devolucion,
    horariosEstimados: rango.horariosEstimados,
  }));
  // Igual que server.js: la flota completa para nombrar los ocupados.
  return JSON.stringify(resultadoConFechas(cotizados, MOCK_CARS, { avisoAnio }));
}

// ─── Keyword check ────────────────────────────────────────────────────────────

function checkKeywords(text, keywords) {
  const lower = text.toLowerCase();
  return keywords.filter(kw => lower.includes(kw.toLowerCase()));
}

// keywords_fail_condicional: [{ si_aparece: [...], y_falta: [...] }] → FAIL si
// aparece alguna de si_aparece y ninguna de y_falta. Ej. C7: cotizar (USD) sin
// derivar (wa.me / Patricia). Devuelve descripciones para keywords_fail_encontradas.
function checkCondicionales(text, reglas = []) {
  return reglas
    .filter(r => checkKeywords(text, r.si_aparece).length > 0 && checkKeywords(text, r.y_falta).length === 0)
    .map(r => `${r.si_aparece.join('/')} sin ${r.y_falta.join('/')}`);
}

function getAutoResult(passFound, failFound) {
  if (failFound.length > 0) return 'FAIL';
  if (passFound.length > 0) return 'PASS';
  return 'REVIEW';
}

// ─── Run a single case ────────────────────────────────────────────────────────

async function runCase(caso, input, today) {
  // Misma estructura que server.js: el prompt estable primero y con cache_control,
  // la fecha DESPUES del breakpoint. Si la fecha fuera arriba invalidaria el cache
  // del prompt entero, que es lo que hace cara cada corrida del eval.
  // canal "instagram": el mismo prompt que arma server.js para Instagram con la
  // oficina abierta (`${SYSTEM_PROMPT}\n\n${instagramSuffix()}`).
  const prompt = caso.canal === 'instagram'
    ? `${SYSTEM_PROMPT}\n\n\n${IG_HEADER_ABIERTO}\n\n${INSTAGRAM_CHANNEL_RULES}`
    : SYSTEM_PROMPT;
  const system = [
    { type: 'text', text: prompt, cache_control: { type: 'ephemeral' } },
    {
      type: 'text',
      text: `Hoy es ${today}. Cuando el cliente mencione fechas sin año, usá siempre el año corriente o el siguiente si la fecha ya pasó.`,
    },
  ];

  let currentMessages = [
    ...(caso.historial_previo || []),
    { role: 'user', content: input },
  ];

  let finalText = '';
  const metricas = {
    ms: 0,
    llamadas_api: 0,
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    stop_reasons: [],
    buscar_autos: [],
  };
  const t0 = Date.now();

  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      tools: TOOLS,
      messages: currentMessages,
      thinking: { type: THINKING },
      output_config: { effort: EFFORT },
    });

    metricas.llamadas_api++;
    metricas.stop_reasons.push(response.stop_reason);
    for (const k of ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']) {
      metricas[k] += response.usage?.[k] ?? 0;
    }

    if (response.stop_reason === 'end_turn') {
      finalText = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');
      break;
    }

    if (response.stop_reason === 'tool_use') {
      currentMessages.push({ role: 'assistant', content: response.content });

      const toolResults = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        if (block.name === 'buscar_autos') metricas.buscar_autos.push(block.input);

        let toolContent;
        try {
          toolContent = executeMockTool(block.name, block.input, caso);
        } catch (err) {
          toolContent = JSON.stringify({ error: err.message });
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: toolContent,
        });
      }

      currentMessages.push({ role: 'user', content: toolResults });
      continue;
    }

    // stop_reason inesperado (max_tokens, refusal): queda registrado en metricas
    finalText = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');
    break;
  }

  metricas.ms = Date.now() - t0;
  return { texto: finalText, metricas };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const dataset = JSON.parse(
    readFileSync(join(__dirname, 'dataset.json'), 'utf-8')
  );

  let casos = categoriaFiltro
    ? dataset.filter(c => c.id.startsWith(categoriaFiltro))
    : dataset;

  if (casosFiltro) {
    casos = casos.filter(c => casosFiltro.includes(c.id.toUpperCase()));
  }

  if (casos.length === 0) {
    console.error(`No se encontraron casos para la categoría "${categoriaFiltro}".`);
    process.exit(1);
  }

  // Una sola fecha para toda la corrida: la usan el system prompt y {{fecha:+N}}.
  const today = floridaDateStr();
  const config = { model: MODEL, effort: EFFORT, thinking: THINKING, max_tokens: MAX_TOKENS, fecha: today };

  console.log(
    `\nEvaluando ${casos.length} caso(s)${categoriaFiltro ? ` (categoría ${categoriaFiltro})` : ''}...`
  );
  console.log(`Modelo ${MODEL} | effort ${EFFORT} | thinking ${THINKING} | max_tokens ${MAX_TOKENS}\n`);

  const results = [];

  for (let i = 0; i < casos.length; i++) {
    const caso = casos[i];
    const input = renderFechas(caso.input, today);
    process.stdout.write(`Evaluando ${caso.id} (${i + 1}/${casos.length})... `);

    let respuesta = '';
    let metricas = null;
    try {
      ({ texto: respuesta, metricas } = await runCase(caso, input, today));
    } catch (err) {
      respuesta = `[ERROR AL LLAMAR LA API: ${err.message}]`;
    }

    const passFound = checkKeywords(respuesta, caso.keywords_pass);
    const failFound = [
      ...checkKeywords(respuesta, caso.keywords_fail),
      ...checkCondicionales(respuesta, caso.keywords_fail_condicional),
    ];
    // max_bloques (opcional): FAIL si hay más bloques completos de auto
    // (**SMALL|MEDIUM|LARGE nombre**) que los permitidos. En Instagram son 3.
    if (typeof caso.max_bloques === 'number') {
      const bloques = (respuesta.match(/\*\*(SMALL|MEDIUM|LARGE)\s/g) || []).length;
      if (bloques > caso.max_bloques) failFound.push(`${bloques} bloques de auto (máx ${caso.max_bloques})`);
    }
    // termina_con (opcional): FAIL si la respuesta no termina con ese texto
    // (ej. J4: el marcador [[LINK_WEB]] en la última línea).
    if (caso.termina_con && !respuesta.trim().endsWith(caso.termina_con)) {
      failFound.push(`no termina con ${caso.termina_con}`);
    }
    // min_lineas_con (opcional): { prefijo, minimo } → FAIL si hay menos de
    // `minimo` líneas que empiecen con `prefijo` (ej. J4: la lista corta, una
    // línea por auto con "•", no todo en un renglón separado con ";").
    if (caso.min_lineas_con) {
      const { prefijo, minimo } = caso.min_lineas_con;
      const lineas = respuesta.split('\n').filter((l) => l.trimStart().startsWith(prefijo)).length;
      if (lineas < minimo) failFound.push(`${lineas} líneas con "${prefijo}" (mín ${minimo})`);
    }
    // debe_buscar (opcional): FAIL si el modelo llamó, o no, a buscar_autos.
    if (typeof caso.debe_buscar === 'boolean' && metricas) {
      const busco = metricas.buscar_autos.length > 0;
      if (busco !== caso.debe_buscar) failFound.push(caso.debe_buscar ? 'no llamó a buscar_autos' : 'llamó a buscar_autos');
    }
    const autoResult = getAutoResult(passFound, failFound);

    const cortada = metricas?.stop_reasons.includes('max_tokens') ? ' (cortada por max_tokens)' : '';
    console.log(`${autoResult}${cortada}`);

    results.push({
      id: caso.id,
      categoria: caso.categoria,
      canal: caso.canal || 'web',
      input,
      respuesta,
      keywords_pass_encontradas: passFound,
      keywords_fail_encontradas: failFound,
      auto_result: autoResult,
      metricas,
      pass_manual: null,
      notas: '',
    });
  }

  // ─── Resumen ──────────────────────────────────────────────────────────────

  const categorias = [...new Set(results.map(r => r.id.charAt(0)))].sort();
  const porCategoria = {};
  for (const cat of categorias) {
    const catResults = results.filter(r => r.id.startsWith(cat));
    porCategoria[cat] = {
      pass: catResults.filter(r => r.auto_result === 'PASS').length,
      fail: catResults.filter(r => r.auto_result === 'FAIL').length,
      review: catResults.filter(r => r.auto_result === 'REVIEW').length,
    };
  }

  const medidos = results.filter(r => r.metricas);
  const suma = k => medidos.reduce((acc, r) => acc + r.metricas[k], 0);
  const masLento = medidos.reduce((a, r) => (!a || r.metricas.ms > a.metricas.ms ? r : a), null);

  const resumen = {
    config,
    total: results.length,
    auto_pass: results.filter(r => r.auto_result === 'PASS').length,
    auto_fail: results.filter(r => r.auto_result === 'FAIL').length,
    review: results.filter(r => r.auto_result === 'REVIEW').length,
    por_categoria: porCategoria,
    metricas: {
      ms_promedio: medidos.length ? Math.round(suma('ms') / medidos.length) : null,
      ms_max: masLento?.metricas.ms ?? null,
      ms_max_caso: masLento?.id ?? null,
      llamadas_api: suma('llamadas_api'),
      input_tokens: suma('input_tokens'),
      cache_creation_input_tokens: suma('cache_creation_input_tokens'),
      cache_read_input_tokens: suma('cache_read_input_tokens'),
      output_tokens: suma('output_tokens'),
      llamadas_buscar_autos: medidos.reduce((acc, r) => acc + r.metricas.buscar_autos.length, 0),
      cortadas_por_max_tokens: medidos.filter(r => r.metricas.stop_reasons.includes('max_tokens')).map(r => r.id),
    },
  };

  // ─── Guardar resultados ───────────────────────────────────────────────────

  const resultsDir = join(__dirname, 'results');
  if (!existsSync(resultsDir)) mkdirSync(resultsDir);

  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}`;
  const filename = join(resultsDir, `${timestamp}.json`);

  writeFileSync(filename, JSON.stringify({ casos: results, resumen }, null, 2), 'utf-8');

  // ─── Output final ─────────────────────────────────────────────────────────

  console.log('\n── RESUMEN ──────────────────────────────────────────────');
  console.log(`Total: ${resumen.total} | PASS: ${resumen.auto_pass} | FAIL: ${resumen.auto_fail} | REVIEW: ${resumen.review}`);
  console.log('\nPor categoría:');
  for (const [cat, counts] of Object.entries(resumen.por_categoria)) {
    console.log(`  ${cat}: PASS ${counts.pass} | FAIL ${counts.fail} | REVIEW ${counts.review}`);
  }
  const m = resumen.metricas;
  console.log(`\nDemora por caso: promedio ${(m.ms_promedio / 1000).toFixed(1)}s | máx ${(m.ms_max / 1000).toFixed(1)}s (${m.ms_max_caso})`);
  console.log(`Tokens: input ${m.input_tokens} | cache write ${m.cache_creation_input_tokens} | cache read ${m.cache_read_input_tokens} | output ${m.output_tokens}`);
  console.log(`buscar_autos: ${m.llamadas_buscar_autos} llamadas | cortadas por max_tokens: ${m.cortadas_por_max_tokens.join(', ') || 'ninguna'}`);
  console.log(`\nResultados guardados en: ${filename}\n`);
}

main().catch(err => {
  console.error('Error fatal:', err.message);
  process.exit(1);
});
