# Cotizador de Florida Aventura

Herramienta interna para Patricia. Pega los mensajes del cliente, revisa los datos en un formulario, elige autos, ajusta días y valores, y obtiene la cotización como mensaje para Instagram y como página para guardar en PDF.

Corre como un servicio aparte del bot. No importa `server.js` ni comparte memoria con él.

## Cómo se reparte el trabajo

- La plata y los días salen de `../cotizacion.js`, el mismo módulo que usa el bot. Acá no hay ninguna fórmula.
- El modelo solo lee datos del texto pegado (`extraer.js`). No cotiza ni elige autos. Si la lectura falla, el formulario se completa a mano.
- El navegador no suma: cada cambio vuelve a pedirle la cuenta al servidor (`POST /api/cotizar`).
- El mensaje de Instagram se arma por código en `formato.js`, con el mismo formato que escribe el bot desde la plantilla de `../prompt.js`. Si cambia el formato del bot, hay que cambiarlo en los dos lados.

## Archivos

| Archivo | Qué hace |
|---|---|
| `server.js` | Acceso con clave, rutas `/api/leer`, `/api/buscar`, `/api/cotizar` |
| `autos.js` | Valida fechas, consulta la API de Florida Aventura y cotiza (lo mismo que `buscar_autos` del bot) |
| `formato.js` | Arma los mensajes para Instagram |
| `extraer.js` | Lectura de los mensajes del cliente con el modelo |
| `public/` | Pantalla, estilos, logo y tipografías |
| `test/` | Tests (`npm test` desde la raíz del repo) |

## Variables de entorno

| Variable | Para qué | Obligatoria |
|---|---|---|
| `COTIZADOR_CLAVE` | Clave de acceso compartida. Sin ella nadie puede entrar. Cambiarla cierra todas las sesiones | Sí |
| `FA_API_TOKEN` | Token de la API de Florida Aventura (el mismo del bot) | Sí |
| `ANTHROPIC_API_KEY` | Lectura de mensajes. Sin ella el formulario se completa a mano | No |
| `COTIZADOR_MODEL` | Modelo para la lectura. Por defecto usa `BOT_MODEL` o `claude-sonnet-5` | No |
| `COTIZADOR_LECTURAS_HORA` | Tope de lecturas por hora (60 por defecto) | No |
| `FA_TIMEZONE` | Zona horaria para "hoy" (`America/New_York` por defecto) | No |

## Correrlo en la máquina

Desde la raíz del repo, con `COTIZADOR_CLAVE` agregada al `.env`:

```
node cotizador/server.js
```

Abre en `http://localhost:3100`.

## Railway

Segundo servicio del mismo proyecto, conectado al mismo repo y rama:

- Comando de arranque: `node cotizador/server.js`
- Watch paths: `/cotizador/**`, `/cotizacion.js`, `/package.json`, `/package-lock.json`
- El servicio del bot tiene `**` y `!/cotizador/**`: un push que toca solo esta carpeta no lo redeploya.

## Qué puede modificar Patricia

Días a cobrar, SunPass y precio por día de cada auto. Cada valor tocado queda marcado como modificado a mano y se puede restaurar. El descuento por alquiler largo sigue la regla (10% desde 17 días) según los días a cobrar.

## Historial

Las cotizaciones se guardan solas en el navegador (`localStorage`), hasta 50, con todo lo necesario para reabrirlas tal como estaban. "Nueva cotización" guarda la abierta y abre una en blanco. No pasan por el servidor: cada dispositivo tiene su propio historial y se pierde si se borran los datos del navegador. Al reabrir una cotización con más de 30 minutos, avisa que los precios y la disponibilidad son los del momento de la búsqueda.

## Pendiente

- Historial compartido entre dispositivos (necesita una base de datos) y lista de seguimiento.
- Creador de contratos.
- PDF armado en el servidor.
- Que el bot use `autos.js` y `formato.js` (hoy tiene su propia copia en `server.js` y en el prompt).
