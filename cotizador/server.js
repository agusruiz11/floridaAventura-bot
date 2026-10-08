// Cotizador de Florida Aventura: herramienta interna para Patricia.
//
// Corre como un servicio aparte del bot (node cotizador/server.js). No importa
// server.js ni comparte memoria con él. Las reglas de plata y de días salen de
// ../cotizacion.js, el mismo módulo que usa el bot.
//
// Variables: COTIZADOR_CLAVE (obligatoria), FA_API_TOKEN, ANTHROPIC_API_KEY.
// Ver cotizador/README.md.
import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cargoSunPass, cotizarAuto, prepararRango, formatoUSD, MINIMO_DIAS, DESCUENTO_DESDE_DIAS, DESCUENTO_PORCENTAJE, CARGO_PUERTO_CRUCEROS } from '../cotizacion.js';
import { armarFechaHora, buscarAutos, hoyEnFlorida, validarRango } from './autos.js';
import { mensajesInstagram, nombreAuto, tamanioAuto, textoFechas } from './formato.js';
import { extraerDatos } from './extraer.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLICO = path.join(DIR, 'public');
const CLAVE = process.env.COTIZADOR_CLAVE || '';
const SESION_DIAS = 30;
const COOKIE = 'cz_sesion';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' https: data:; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; frame-ancestors 'none'",
  );
  next();
});

// ─── Acceso ──────────────────────────────────────────────────────────────────
// Una sola clave compartida. La cookie lleva un vencimiento firmado con la clave:
// cambiar COTIZADOR_CLAVE cierra todas las sesiones.

function firmar(vence) {
  return crypto.createHmac('sha256', CLAVE).update(`cotizador|${vence}`).digest('hex');
}

function igual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function sesionValida(req) {
  if (!CLAVE) return false;
  const crudo = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE}=`));
  if (!crudo) return false;
  const [vence, firma] = crudo.slice(COOKIE.length + 1).split('.');
  if (!vence || !firma || Number(vence) < Date.now()) return false;
  return igual(firma, firmar(vence));
}

function cookieDeSesion(req, valor, maxAgeSeg) {
  const segura = req.secure ? '; Secure' : '';
  return `${COOKIE}=${valor}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeg}${segura}`;
}

// Tope de intentos por IP, en memoria: 10 cada 15 minutos.
const intentos = new Map();
function demasiadosIntentos(ip) {
  const ahora = Date.now();
  const lista = (intentos.get(ip) || []).filter((t) => ahora - t < 15 * 60_000);
  lista.push(ahora);
  intentos.set(ip, lista);
  if (intentos.size > 5000) intentos.clear();
  return lista.length > 10;
}

app.post('/api/entrar', (req, res) => {
  if (!CLAVE) return res.status(503).json({ error: 'Falta configurar la clave de acceso (COTIZADOR_CLAVE).' });
  if (demasiadosIntentos(req.ip)) return res.status(429).json({ error: 'Demasiados intentos. Probá de nuevo en unos minutos.' });
  const clave = typeof req.body?.clave === 'string' ? req.body.clave : '';
  const ok = igual(crypto.createHash('sha256').update(clave).digest('hex'), crypto.createHash('sha256').update(CLAVE).digest('hex'));
  if (!ok) return res.status(401).json({ error: 'Clave incorrecta.' });
  const vence = Date.now() + SESION_DIAS * 86_400_000;
  res.setHeader('Set-Cookie', cookieDeSesion(req, `${vence}.${firmar(vence)}`, SESION_DIAS * 86_400));
  res.json({ ok: true });
});

app.post('/api/salir', (req, res) => {
  res.setHeader('Set-Cookie', cookieDeSesion(req, '', 0));
  res.json({ ok: true });
});

app.get('/salud', (_req, res) => res.json({ ok: true }));

// Archivos que se ven sin sesión: la pantalla de acceso y lo que necesita.
const ABIERTOS = new Set(['/entrar.html', '/entrar.js', '/app.css', '/logo.png', '/fonts/NeueEinstellung-Regular.woff2', '/fonts/NeueEinstellung-Bold.woff2']);

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    if (!sesionValida(req)) return res.status(401).json({ error: 'Sesión vencida. Volvé a entrar.' });
    return next();
  }
  if (ABIERTOS.has(req.path)) return next();
  if (!sesionValida(req)) return res.redirect('/entrar.html');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use(express.static(PUBLICO, { index: 'index.html' }));

// ─── Leer datos de los mensajes ──────────────────────────────────────────────

const lecturas = [];
const LECTURAS_POR_HORA = Number(process.env.COTIZADOR_LECTURAS_HORA ?? 60);

app.post('/api/leer', async (req, res) => {
  const mensajes = typeof req.body?.mensajes === 'string' ? req.body.mensajes.trim() : '';
  if (!mensajes) return res.status(400).json({ error: 'Pegá los mensajes del cliente.' });
  if (mensajes.length > 6000) return res.status(400).json({ error: 'El texto es demasiado largo. Pegá solo los mensajes del cliente.' });

  const ahora = Date.now();
  while (lecturas.length && ahora - lecturas[0] > 3_600_000) lecturas.shift();
  if (lecturas.length >= LECTURAS_POR_HORA) {
    return res.status(429).json({ error: 'Se alcanzó el tope de lecturas por hora. Completá los datos a mano.' });
  }
  lecturas.push(ahora);

  try {
    const datos = await extraerDatos(mensajes, { hoy: hoyEnFlorida() });
    console.log('[leer] Datos extraídos');
    res.json({ ok: true, datos });
  } catch (err) {
    // Sin lectura automática el formulario se completa a mano y todo sigue igual.
    console.error('[leer] No pude leer los mensajes:', err.message);
    res.status(502).json({ error: 'No pude leer los mensajes. Completá los datos a mano.' });
  }
});

// ─── Buscar autos ────────────────────────────────────────────────────────────

function leerViaje(body = {}) {
  const fecha = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '');
  const hora = (v) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : '');
  return {
    startDateTime: armarFechaHora(fecha(body.retiroFecha), hora(body.retiroHora)),
    endDateTime: armarFechaHora(fecha(body.devolucionFecha), hora(body.devolucionHora)),
    destinos: Array.isArray(body.destinos) ? body.destinos.filter((d) => typeof d === 'string').slice(0, 10) : [],
    puertoDeCruceros: body.puertoDeCruceros === true,
  };
}

function fichaAuto(car) {
  return {
    name: car.name,
    year: car.year ?? null,
    type: car.type ?? null,
    color: car.color ?? null,
    passengersAmount: car.passengersAmount ?? null,
    suitcasesAmount: car.suitcasesAmount ?? null,
    imageUrl: car.imageUrl ?? null,
    pricePerDay: car.pricePerDay,
    titulo: nombreAuto(car),
    tamanio: tamanioAuto(car),
    total: car.total,
    lineaTotal: car.lineaTotal,
  };
}

app.post('/api/buscar', async (req, res) => {
  const viaje = leerViaje(req.body);
  if (!viaje.startDateTime || !viaje.endDateTime) {
    return res.status(400).json({ error: 'Faltan las fechas de retiro y devolución.' });
  }
  try {
    const r = await buscarAutos(viaje);
    if (!r.ok && r.minimoNoCumplido) {
      return res.json({ ok: false, error: `El período da ${r.dias} ${r.dias === 1 ? 'día' : 'días'} y el mínimo de alquiler es de ${r.minimo}.` });
    }
    if (!r.ok) return res.json({ ok: false, error: r.error });
    console.log(`[buscar] ${r.rango.startDateTime} → ${r.rango.endDateTime}: ${r.autos.length} autos, ${r.rango.dias} días`);
    res.json({
      ok: true,
      rango: r.rango,
      fechas: textoFechas(r.rango.startDateTime, r.rango.endDateTime),
      sunPass: r.sunPass,
      avisos: r.avisos,
      autos: r.autos.filter((a) => typeof a.pricePerDay === 'number').map(fichaAuto),
      reglas: { minimoDias: MINIMO_DIAS, descuentoDesdeDias: DESCUENTO_DESDE_DIAS, descuentoPorcentaje: DESCUENTO_PORCENTAJE, cargoPuerto: CARGO_PUERTO_CRUCEROS },
    });
  } catch (err) {
    console.error('[buscar] Error:', err.message);
    res.status(502).json({ error: 'No pude consultar la disponibilidad. Probá de nuevo en un momento.' });
  }
});

// ─── Cotizar con los valores que validó Patricia ─────────────────────────────
// Recibe los autos elegidos y los ajustes (días, SunPass, precio por día) y
// devuelve los totales recalculados por cotizacion.js y los mensajes armados.
// El navegador nunca suma: todo total que se muestra sale de acá.

const numero = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

app.post('/api/cotizar', (req, res) => {
  const viaje = leerViaje(req.body?.viaje);
  const validacion = validarRango(viaje.startDateTime, viaje.endDateTime);
  if (!validacion.ok) {
    return res.status(400).json({ error: validacion.error || `El período no llega al mínimo de ${MINIMO_DIAS} días.` });
  }
  const rango = prepararRango(viaje.startDateTime, viaje.endDateTime);

  const ajustes = req.body?.ajustes || {};
  const diasAjustados = numero(ajustes.dias);
  if (diasAjustados != null && (!Number.isInteger(diasAjustados) || diasAjustados < 1 || diasAjustados > 365)) {
    return res.status(400).json({ error: 'Los días tienen que ser un número entero entre 1 y 365.' });
  }
  const dias = diasAjustados ?? rango.dias;

  const sunPassRegla = cargoSunPass(dias, viaje.destinos);
  const sunPassAjustado = numero(ajustes.sunPass);
  if (sunPassAjustado != null && (sunPassAjustado < 0 || sunPassAjustado > 1000)) {
    return res.status(400).json({ error: 'El SunPass tiene que ser un monto entre 0 y 1000.' });
  }
  const sunPassManual = sunPassAjustado != null && sunPassAjustado !== sunPassRegla.monto;
  const sunPass = sunPassManual
    ? { monto: sunPassAjustado, detalle: 'ajustado a mano', esEstimado: false }
    : sunPassRegla;

  // Llegan todos los autos de la búsqueda, cada uno con su precio por día y la
  // marca de si Patricia lo eligió: así la lista entera muestra totales al día.
  const recibidos = Array.isArray(req.body?.autos) ? req.body.autos.slice(0, 40) : [];
  if (!recibidos.length) return res.status(400).json({ error: 'No hay autos para cotizar.' });

  const autos = [];
  for (const a of recibidos) {
    const precio = numero(a?.pricePerDay);
    if (typeof a?.name !== 'string' || precio == null || precio <= 0 || precio > 5000) {
      return res.status(400).json({ error: 'Revisá el precio por día: tiene que ser un monto mayor a cero.' });
    }
    const car = {
      name: a.name.slice(0, 80),
      year: a.year ?? null,
      type: a.type ?? null,
      color: a.color ?? null,
      passengersAmount: numero(a.passengersAmount),
      suitcasesAmount: numero(a.suitcasesAmount),
      imageUrl: typeof a.imageUrl === 'string' && a.imageUrl.startsWith('https://') ? a.imageUrl : null,
      pricePerDay: precio,
    };
    const cotizado = cotizarAuto(car, dias, sunPass, viaje.puertoDeCruceros);
    autos.push({
      ...cotizado,
      elegido: a.elegido === true,
      nota: typeof a.nota === 'string' ? a.nota.trim().slice(0, 160) : '',
      titulo: nombreAuto(car),
      tamanio: tamanioAuto(car),
      precioPorDia: formatoUSD(precio),
    });
  }
  const elegidos = autos.filter((a) => a.elegido).slice(0, 6);

  const rangoFinal = { ...rango, dias };
  res.json({
    ok: true,
    rango: rangoFinal,
    fechas: textoFechas(rango.startDateTime, rango.endDateTime),
    dias,
    diasRegla: rango.dias,
    sunPass: { ...sunPass, texto: formatoUSD(sunPass.monto), manual: sunPassManual },
    sunPassRegla: { ...sunPassRegla, texto: formatoUSD(sunPassRegla.monto) },
    puertoDeCruceros: viaje.puertoDeCruceros,
    cargoPuerto: CARGO_PUERTO_CRUCEROS,
    hayDescuento: elegidos.some((a) => a.descuento),
    descuentoPorcentaje: DESCUENTO_PORCENTAJE,
    autos,
    mensajes: elegidos.length
      ? mensajesInstagram({ autos: elegidos, rango: rangoFinal, sunPass, sunPassAjustado: sunPassManual })
      : [],
  });
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'No existe.' }));

const PORT = process.env.PORT || 3100;
app.listen(PORT, () => {
  console.log(`Cotizador de Florida Aventura corriendo en http://localhost:${PORT}`);
  if (!CLAVE) console.warn('[acceso] Falta COTIZADOR_CLAVE: nadie puede entrar hasta que se configure.');
  if (!process.env.FA_API_TOKEN) console.warn('[buscar] Falta FA_API_TOKEN: la búsqueda de autos va a fallar.');
  if (!process.env.ANTHROPIC_API_KEY) console.warn('[leer] Falta ANTHROPIC_API_KEY: la lectura de mensajes va a fallar, el formulario se completa a mano.');
});
