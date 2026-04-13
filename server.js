import 'dotenv/config';
import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT } from './prompt.js';

const app = express();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(express.json());
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

async function executeTool(toolName, toolInput) {
  if (toolName === 'buscar_autos') {
    const { startDateTime, endDateTime } = toolInput;

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

    return { json: JSON.stringify(data), images };
  }

  throw new Error(`Herramienta desconocida: ${toolName}`);
}

// ─── Chat endpoint ────────────────────────────────────────────────────────────

app.post('/chat', async (req, res) => {
  const { messages } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Se requiere el campo "messages" (array).' });
  }

  try {
    // Agentic loop: sigue mientras Claude devuelva tool_use
    let currentMessages = [...messages];
    let finalText = '';
    let lastSearchImages = [];

    while (true) {
      const today = new Date().toISOString().split('T')[0];
      const response = await client.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 2048,
        system: `Hoy es ${today}. Cuando el cliente mencione fechas sin año, usá siempre el año corriente o el siguiente si la fecha ya pasó.\n\n${SYSTEM_PROMPT}`,
        tools: TOOLS,
        messages: currentMessages,
      });

      // Si Claude terminó normalmente sin usar tools
      if (response.stop_reason === 'end_turn') {
        finalText = response.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('');
        break;
      }

      // Si Claude quiere usar una o más herramientas
      if (response.stop_reason === 'tool_use') {
        // Agregar la respuesta de Claude (con tool_use blocks) al historial
        currentMessages.push({ role: 'assistant', content: response.content });

        // Ejecutar cada tool y construir los tool_result
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

          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: toolContent,
          });
        }

        // Agregar resultados al historial y seguir el loop
        currentMessages.push({ role: 'user', content: toolResults });
        continue;
      }

      // stop_reason inesperado — salir del loop con lo que haya
      finalText = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      break;
    }

    console.log(`[/chat] Respondiendo con ${lastSearchImages.length} imágenes`);
    res.json({ response: finalText, images: lastSearchImages });
  } catch (err) {
    console.error('Error en /chat:', err.message);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

// ─── Start server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Florida Aventura Bot corriendo en http://localhost:${PORT}`);
});
