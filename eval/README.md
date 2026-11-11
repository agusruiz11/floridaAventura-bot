# Sistema de evaluación — Florida Aventura Bot

Eval de nivel 2: el script manda cada caso al bot real (misma API, mismo system prompt, mismo model), guarda las respuestas y genera un reporte para revisión manual.

## Estructura

```
eval/
├── dataset.json     # 65 casos de prueba organizados por categoría
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

Corre los 65 casos, muestra progreso en consola y guarda los resultados en `eval/results/`.

### 2. Correr solo una categoría

```bash
node eval/run-eval.js --categoria B
```

Categorías disponibles: `A`, `B`, `C`, `D`, `E`, `F`, `G`, `H`, `I`

### 3. Correr casos específicos

```bash
node eval/run-eval.js --casos B4,E4,C7
```

Útil para re-evaluar casos puntuales después de un fix en el prompt. Se puede combinar con `--categoria` (actúa como segundo filtro).

### 4. Hacer la revisión manual

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
| B | Fechas y cálculo de días | B1–B13 |
| C | Búsqueda de autos | C1–C8 |
| D | Destinos y SunPass | D1–D5 |
| E | Pre-reserva | E1–E5 |
| F | Precios y negociación | F1–F4 |
| G | Preguntas frecuentes | G1–G6 |
| H | Límites del bot | H1–H8 |
| I | Alucinaciones | I1–I6 |

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
- `keywords_fail_condicional`: `[{ "si_aparece": [...], "y_falta": [...] }]` → FAIL si aparece alguna de `si_aparece` y ninguna de `y_falta` (ej. C7: cotizar con `USD` sin derivar con `wa.me`/`Patricia`)
- `termina_con`: texto con el que tiene que terminar la respuesta (sin espacios finales); si no, FAIL (ej. J4: `[[LINK_WEB]]` debajo de la lista corta)
- `min_lineas_con`: `{ "prefijo": "•", "minimo": 3 }` → FAIL si hay menos de `minimo` líneas que empiecen con `prefijo` (ej. J4: la lista corta, una línea por auto)

Fechas relativas: en `input`, `{{fecha:+N}}` se reemplaza por "D de mes" contando N días desde la fecha que el eval inyecta en el system prompt (ej: `desde hoy {{fecha:+0}} hasta el {{fecha:+6}}`). Usalo en todo caso que dependa de "hoy".

## Parámetros del modelo

**El eval tiene que correr con el modelo de producción.** Producción usa `claude-opus-5-5` (variable `BOT_MODEL` en Railway); el default del código (`claude-sonnet-5`) es otro modelo y da resultados distintos. Poné `BOT_MODEL=claude-opus-5-5` en el `.env` local (el eval lo lee con dotenv) y fijate que la línea `Modelo …` que imprime al arrancar, y `resumen.config.model` en el JSON, digan ese modelo. Si cambia el modelo en Railway, cambialo también en el `.env`. Una corrida con otro modelo sirve para comparar, no para aprobar un cambio.

Por defecto el eval llama al modelo igual que `runBot` en `server.js`. Se pueden cambiar por entorno:

| Variable | Default | Notas |
|---|---|---|
| `BOT_MODEL` | `claude-sonnet-5` | Misma variable que lee `server.js` |
| `BOT_EFFORT` | `high` | Misma variable que lee `server.js` (`output_config.effort`) |
| `EVAL_MAX_TOKENS` | `8192` | Solo eval; en `server.js` está fijo en 8192 |
| `EVAL_THINKING` | `adaptive` | Solo eval; en `server.js` está fijo en `adaptive` |

```bash
BOT_MODEL=claude-opus-5-5 BOT_EFFORT=medium node eval/run-eval.js --categoria B
```

Cada caso guarda en `metricas` la demora, los tokens, los `stop_reason` y las llamadas a `buscar_autos`; el `resumen` trae la config usada y los totales, incluidas las respuestas cortadas por `max_tokens`.

## Notas técnicas

- El mock de `buscar_autos` devuelve la flota real (12 autos) cotizada con las mismas funciones de `cotizacion.js` que usa el server.
- El script usa la misma API, model, parámetros, system prompt y agentic loop que `server.js`. Si cambiás los parámetros de `runBot`, cambialos también acá.
- Los resultados se acumulan en `eval/results/` — nunca se sobreescriben.
