# Sistema de evaluación — Florida Aventura Bot

Eval de nivel 2: el script manda cada caso al bot real (misma API, mismo system prompt, mismo model), guarda las respuestas y genera un reporte para revisión manual.

## Estructura

```
eval/
├── dataset.json     # 48 casos de prueba organizados por categoría
├── run-eval.js      # Script principal: corre los casos y genera el reporte
├── review.js        # Script interactivo de revisión manual
├── results/         # Archivos JSON generados (YYYY-MM-DD-HH-mm.json)
└── README.md
```

## Uso

### 1. Correr el dataset completo

```bash
node eval/run-eval.js
```

Corre los 48 casos, muestra progreso en consola y guarda los resultados en `eval/results/`.

### 2. Correr solo una categoría

```bash
node eval/run-eval.js --categoria B
```

Categorías disponibles: `A`, `B`, `C`, `D`, `E`, `F`, `G`, `H`, `I`

### 3. Hacer la revisión manual

```bash
node eval/review.js
```

Abre el último archivo de resultados y muestra solo los casos pendientes de revisión.
Para cada caso muestra: ID, input, respuesta del bot, keywords encontradas y auto_result.

Comandos durante la revisión:
- `s` → marcar como PASS (pide nota opcional)
- `n` → marcar como FAIL (pide nota opcional)
- Enter → saltar (queda pendiente para la próxima sesión)
- `q` → salir (guarda el progreso)

## Interpretar los resultados

Cada caso tiene tres campos de resultado:

| Campo | Descripción |
|---|---|
| `auto_result` | Determinado automáticamente por keywords |
| `pass_manual` | `true`/`false`/`null` — asignado durante la revisión manual |
| `notas` | Comentario libre |

**Lógica de `auto_result`:**
- `PASS` — al menos 1 keyword_pass encontrada Y ninguna keyword_fail
- `FAIL` — alguna keyword_fail encontrada (independientemente de las pass)
- `REVIEW` — ninguna keyword_fail pero tampoco ninguna keyword_pass → requiere revisión manual

**Importante:** el auto_result es una primera aproximación. Siempre revisá manualmente los `REVIEW` y spot-chequeá los `PASS`/`FAIL`.

## Categorías del dataset

| Cat | Tema | Casos |
|---|---|---|
| A | Primer contacto | A1–A4 |
| B | Fechas y cálculo de días | B1–B6 |
| C | Búsqueda de autos | C1–C6 |
| D | Destinos y SunPass | D1–D5 |
| E | Pre-reserva | E1–E5 |
| F | Precios y negociación | F1–F4 |
| G | Preguntas frecuentes | G1–G6 |
| H | Límites del bot | H1–H8 |
| I | Alucinaciones | I1–I4 |

## Casos especiales

- **C5** — buscar_autos lanza un error (mock 503). Verifica que el bot derive a Patricia sin inventar datos.
- **C6** — buscar_autos devuelve array vacío. Verifica que el bot informe falta de disponibilidad.
- **H7, C3, C4, F2, E1–E4** — incluyen historial previo simulado para testear comportamiento con contexto.

## Agregar nuevos casos

1. Abrí `dataset.json`
2. Agregá un objeto al array con la estructura:

```json
{
  "id": "X9",
  "categoria": "X - Nombre de categoría",
  "input": "Mensaje del cliente",
  "debe_hacer": "Descripción de comportamiento esperado",
  "no_debe_hacer": "Descripción de comportamiento incorrecto",
  "keywords_pass": ["palabra1", "frase que debe aparecer"],
  "keywords_fail": ["palabra que NO debe aparecer"]
}
```

Campos opcionales:
- `historial_previo`: array de `{role, content}` para simular contexto previo
- `mock_behavior`: `"error"` (buscar_autos falla) o `"empty"` (devuelve sin autos)

## Notas técnicas

- El mock de `buscar_autos` devuelve 3 autos ficticios realistas (Honda HRV, Honda Odyssey, VW Atlas) para que el bot pueda responder naturalmente en los casos que requieren búsqueda.
- El script usa la misma API, model (`claude-sonnet-4-5`), system prompt y agentic loop que `server.js`.
- Los resultados se acumulan en `eval/results/` — nunca se sobreescriben.
