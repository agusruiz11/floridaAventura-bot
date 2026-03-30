import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT } from '../prompt.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

function executeMockTool(toolName, _toolInput, caseId) {
  if (toolName !== 'buscar_autos') throw new Error(`Herramienta desconocida: ${toolName}`);

  if (caseId === 'C5') {
    throw new Error('Florida Aventura API error: 503 Service Unavailable');
  }
  if (caseId === 'C6') {
    return JSON.stringify([]);
  }
  return JSON.stringify(MOCK_CARS);
}

// ─── Keyword check ────────────────────────────────────────────────────────────

function checkKeywords(text, keywords) {
  const lower = text.toLowerCase();
  return keywords.filter(kw => lower.includes(kw.toLowerCase()));
}

function getAutoResult(passFound, failFound) {
  if (failFound.length > 0) return 'FAIL';
  if (passFound.length > 0) return 'PASS';
  return 'REVIEW';
}

// ─── Run a single case ────────────────────────────────────────────────────────

async function runCase(caso) {
  const today = new Date().toISOString().split('T')[0];
  const systemWithDate =
    `Hoy es ${today}. Cuando el cliente mencione fechas sin año, usá siempre el año corriente o el siguiente si la fecha ya pasó.\n\n${SYSTEM_PROMPT}`;

  let currentMessages = [
    ...(caso.historial_previo || []),
    { role: 'user', content: caso.input },
  ];

  let finalText = '';

  while (true) {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 2048,
      system: systemWithDate,
      tools: TOOLS,
      messages: currentMessages,
    });

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

        let toolContent;
        try {
          toolContent = executeMockTool(block.name, block.input, caso.id);
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

    // stop_reason inesperado
    finalText = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');
    break;
  }

  return finalText;
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

  console.log(
    `\nEvaluando ${casos.length} caso(s)${categoriaFiltro ? ` (categoría ${categoriaFiltro})` : ''}...\n`
  );

  const results = [];

  for (let i = 0; i < casos.length; i++) {
    const caso = casos[i];
    process.stdout.write(`Evaluando ${caso.id} (${i + 1}/${casos.length})... `);

    let respuesta = '';
    try {
      respuesta = await runCase(caso);
    } catch (err) {
      respuesta = `[ERROR AL LLAMAR LA API: ${err.message}]`;
    }

    const passFound = checkKeywords(respuesta, caso.keywords_pass);
    const failFound = checkKeywords(respuesta, caso.keywords_fail);
    const autoResult = getAutoResult(passFound, failFound);

    console.log(autoResult);

    results.push({
      id: caso.id,
      categoria: caso.categoria,
      input: caso.input,
      respuesta,
      keywords_pass_encontradas: passFound,
      keywords_fail_encontradas: failFound,
      auto_result: autoResult,
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

  const resumen = {
    total: results.length,
    auto_pass: results.filter(r => r.auto_result === 'PASS').length,
    auto_fail: results.filter(r => r.auto_result === 'FAIL').length,
    review: results.filter(r => r.auto_result === 'REVIEW').length,
    por_categoria: porCategoria,
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
  console.log(`\nResultados guardados en: ${filename}\n`);
}

main().catch(err => {
  console.error('Error fatal:', err.message);
  process.exit(1);
});
