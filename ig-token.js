// ─── Token de Instagram: refresco automático y vigilancia ────────────────────
// Los tokens de "Instagram API con Instagram Login" duran 60 días y Meta no avisa
// antes de que venzan. Cuando vencen, el bot sigue recibiendo los webhooks pero
// todo envío rebota con code 190 y nadie se entera hasta que un cliente reclama
// (Florida Aventura el 15/9/2026, Futbol Queens el 5/10/2026).
//
// Este módulo es el dueño del token en memoria:
//
//   1. Lo refresca solo. Meta deja extender 60 días un token vigente con más de
//      24 hs de vida (GET /refresh_access_token?grant_type=ig_refresh_token).
//      Revisa al arrancar y una vez por día; refresca si pasaron
//      refrescarCadaDias desde el último refresco bueno.
//   2. Guarda lo que devuelve Meta. Si el token que vuelve es otro string, el de
//      la variable de entorno queda viejo: lo persistimos en `archivo` y al
//      arrancar preferimos ese. El archivo recuerda con qué token de la variable
//      se generó (solo un hash): si alguien carga un token nuevo en Railway, la
//      variable manda y el archivo se ignora. Sin volumen montado el archivo se
//      pierde en cada deploy y se vuelve a arrancar desde la variable. Para ese
//      caso existe `persistir`: una función que recibe el token nuevo y lo guarda
//      donde sobreviva a un deploy (ver railway-vars.js, que lo escribe en la
//      propia variable IG_ACCESS_TOKEN de Railway).
//   3. Avisa. Si el token deja de servir, si el refresco lleva días fallando o
//      si le quedan pocos días, llama a alertar() (ver alertas.js). Un code 190
//      suelto no alcanza: antes de avisar lo confirma contra /me.
//
// El token nunca se escribe en logs ni en alertas.
//
//   const igToken = crearTokenIg({ envToken, base, archivo, alertar });
//   igToken.token()                    → el token vigente ('' si no hay)
//   igToken.notarError(cuerpo, usado)  → true si el error de Meta era de token
//   igToken.revisar()                  → refresca si toca y chequea vencimiento
//   igToken.iniciar()                  → programa revisar() al arrancar y por día
//   igToken.estado()                   → { hayToken, expiraEn, refrescadoEn, ... }
//   igToken.quieto()                   → promesa: terminó la confirmación en curso
//
// Sin dependencias del server: se prueba con fetch, reloj y disco de mentira
// (test/ig-token.test.js).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DIA = 24 * 60 * 60 * 1000;
const CINCO_MIN = 5 * 60 * 1000;
const HOST_INSTAGRAM = 'graph.instagram.com';
// Cualquier cosa con forma de token de Meta, por si un mensaje de error lo repite.
const FORMA_DE_TOKEN = /\b(?:IG|EAA)[A-Za-z0-9_-]{20,}/g;

// Devuelve el mensaje de Meta si el cuerpo es un error de token (code 190:
// vencido, revocado o ilegible), o null si es otra cosa. Acepta el texto crudo
// de la respuesta o el objeto ya parseado.
export function errorDeToken(cuerpo) {
  let obj = cuerpo;
  if (typeof cuerpo === 'string') {
    try { obj = JSON.parse(cuerpo); } catch { return null; }
  }
  const e = obj && typeof obj === 'object' ? obj.error : null;
  if (!e || Number(e.code) !== 190) return null;
  return String(e.message || 'sin detalle');
}

const huella = (t) => crypto.createHash('sha256').update(String(t)).digest('hex').slice(0, 16);
const fechaCorta = (ms) => new Date(ms).toISOString().slice(0, 10);
// Number('') es 0 y Number(undefined) es NaN: ninguno de los dos es un valor.
const numero = (v, porDefecto) => {
  if (v === undefined || v === null || String(v).trim() === '') return porDefecto;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : porDefecto;
};

export function crearTokenIg({
  envToken = '',
  base = `https://${HOST_INSTAGRAM}/v21.0`,
  archivo = '',
  refrescoActivo = true,
  fetchFn = globalThis.fetch,
  ahora = Date.now,
  alertar = async () => false,
  persistir = null,
  log = console.log,
  warn = console.warn,
  diasAviso,
  refrescarCadaDias,
  diasSinRefresco,
} = {}) {
  envToken = String(envToken || '').trim();
  base = String(base || '').replace(/\/+$/, '');
  archivo = String(archivo || '').trim();
  diasAviso = numero(diasAviso, 10);
  refrescarCadaDias = numero(refrescarCadaDias, 7);
  diasSinRefresco = numero(diasSinRefresco, 3);

  let origen = '';
  try { origen = new URL(base).origin; } catch { /* base inválida: no refrescamos */ }
  // Solo los tokens de Instagram Login se refrescan así. Con Facebook Login
  // (graph.facebook.com) el endpoint no existe y no tocamos nada.
  const esInstagram = origen === `https://${HOST_INSTAGRAM}`;
  const refrescable = esInstagram && !!refrescoActivo;

  let token = envToken;
  let expiraEn = null;       // ms, o null si todavía no lo sabemos
  let refrescadoEn = null;   // ms del último refresco bueno
  let fallandoDesde = null;  // ms del primer refresco fallido de la racha actual
  let desdeArchivo = false;  // el archivo sobrevivió a un reinicio: hay volumen
  let revisando = false;
  let confirmacion = null;   // promesa de la confirmación en curso, si hay
  let confirmado = { token: null, en: -Infinity };

  // Avisar nunca puede romper el flujo que lo llama.
  const avisar = (...args) => {
    try { Promise.resolve(alertar(...args)).catch(() => {}); } catch { /* nada */ }
  };

  // Saca el token de cualquier texto que vaya a un log o a una alerta.
  const limpiar = (texto) => {
    let t = String(texto ?? '');
    for (const secreto of [token, envToken]) {
      if (secreto) t = t.split(secreto).join('[token]');
    }
    return t.replace(FORMA_DE_TOKEN, '[token]').slice(0, 200);
  };

  cargar();

  function cargar() {
    if (!archivo || !envToken) return;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(archivo, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') warn(`[token] No pude leer el archivo del token (${err.code || err.name}): uso la variable`);
      return;
    }
    if (!data || typeof data.token !== 'string' || !data.token) return;
    if (data.envHash !== huella(envToken)) {
      log('[token] La variable IG_ACCESS_TOKEN cambió desde el último refresco guardado: uso la variable');
      return;
    }
    token = data.token;
    expiraEn = numero(data.expiraEn, null) || null;
    refrescadoEn = numero(data.refrescadoEn, null) || null;
    desdeArchivo = true;
  }

  function guardar() {
    if (!archivo) return false;
    try {
      fs.mkdirSync(path.dirname(archivo), { recursive: true });
      const tmp = `${archivo}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({
        token, expiraEn, refrescadoEn, envHash: huella(envToken),
      }), { mode: 0o600 });
      fs.renameSync(tmp, archivo);
      return true;
    } catch (err) {
      warn(`[token] No pude guardar el archivo del token (${err.code || err.name})`);
      return false;
    }
  }

  function borrarArchivo() {
    if (!archivo) return;
    try { fs.unlinkSync(archivo); } catch { /* no estaba */ }
  }

  // Meta confirmó que el token no sirve. Si estábamos usando uno refrescado,
  // antes de dar la alarma volvemos al de la variable: puede seguir vigente.
  function tokenInvalido(mensaje, usado) {
    if (usado !== token) return; // respuesta vieja de un token que ya cambiamos
    const detalle = limpiar(mensaje);
    if (envToken && token !== envToken) {
      warn(`[token] El token refrescado dejó de servir (${detalle}): vuelvo al de la variable IG_ACCESS_TOKEN`);
      token = envToken;
      expiraEn = null;
      refrescadoEn = null;
      desdeArchivo = false;
      borrarArchivo();
      return;
    }
    avisar(
      'token-190',
      `el token de Instagram no sirve y el bot no puede contestar por Instagram. Meta responde code 190: "${detalle}". Hay que generar un token nuevo en la app de Meta y cargarlo en la variable IG_ACCESS_TOKEN de Railway.`,
    );
  }

  async function pedir(url) {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(15000) });
    const texto = await res.text();
    let cuerpo = null;
    try { cuerpo = JSON.parse(texto); } catch { /* no era JSON */ }
    return { ok: res.ok, status: res.status, cuerpo };
  }

  // 'ok' | 'vencido' | 'desconocido'. Una llamada barata a /me: es la que decide
  // si el token sirve. Si Meta responde 190 acá, actúa (fallback o alerta).
  async function verificar() {
    const usado = token;
    if (!usado) return 'desconocido';
    try {
      const qs = new URLSearchParams({ fields: 'id', access_token: usado });
      const r = await pedir(`${base}/me?${qs}`);
      if (r.ok && r.cuerpo && !r.cuerpo.error) return 'ok';
      const mensaje = errorDeToken(r.cuerpo);
      if (mensaje) { tokenInvalido(mensaje, usado); return 'vencido'; }
      return 'desconocido';
    } catch {
      return 'desconocido';
    }
  }

  // Un envío o una lectura rebotó. Si el error es de token (code 190) lo
  // confirmamos contra /me en segundo plano antes de hacer nada: un 190 suelto
  // no puede ni disparar una alarma ni hacernos descartar un token sano.
  function notarError(cuerpo, usado = token) {
    if (!errorDeToken(cuerpo)) return false;
    if (usado !== token || !token || confirmacion) return true;
    // Durante una caída falla cada envío: una confirmación cada 5 min alcanza.
    if (confirmado.token === token && ahora() - confirmado.en < CINCO_MIN) return true;
    confirmado = { token, en: ahora() };
    confirmacion = verificar()
      .then((salud) => {
        if (salud === 'ok') warn('[token] Meta devolvió un code 190 suelto pero el token responde bien: no aviso');
      })
      .catch(() => {})
      .finally(() => { confirmacion = null; });
    return true;
  }

  // Guarda el token nuevo fuera del proceso, si hay dónde. Nunca tira.
  async function persistirNuevo(nuevo) {
    if (typeof persistir !== 'function') return false;
    try {
      await persistir(nuevo);
      return true;
    } catch (err) {
      warn(`[token] No pude guardar el token nuevo en la variable de Railway: ${limpiar(err.message)}`);
      return false;
    }
  }

  async function refrescar() {
    if (!token || !refrescable) return false;
    const usado = token;
    let motivo;
    try {
      const qs = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: usado });
      const r = await pedir(`${origen}/refresh_access_token?${qs}`);
      const nuevo = r.cuerpo?.access_token;
      const segundos = Number(r.cuerpo?.expires_in);
      if (r.ok && typeof nuevo === 'string' && nuevo && segundos > 0) {
        if (usado !== token) return false; // cambió mientras esperábamos
        const cambio = nuevo !== usado;
        const t = ahora();
        token = nuevo;
        expiraEn = t + segundos * 1000;
        refrescadoEn = t;
        fallandoDesde = null;
        const guardado = guardar();
        log(`[token] Refrescado: vence en ${Math.floor(segundos / 86400)} días (${fechaCorta(expiraEn)})`);
        if (cambio) {
          const enVariable = await persistirNuevo(nuevo);
          if (enVariable) {
            log('[token] Meta devolvió un token distinto: guardado en la variable IG_ACCESS_TOKEN de Railway');
          } else {
            warn(`[token] Meta devolvió un token distinto al de la variable IG_ACCESS_TOKEN${guardado ? ' (guardado en el archivo del token)' : ' y NO quedó guardado en disco'}`);
          }
          // Si quedó en la variable, o el archivo ya sobrevivió a un reinicio
          // (hay volumen), no hay nada que avisar. Si no, el token nuevo se
          // pierde en el próximo deploy.
          if (!enVariable && !desdeArchivo) {
            avisar(
              'token-rota',
              'Meta entregó un token de Instagram nuevo al refrescar. El bot ya lo usa, pero sin un volumen de Railway montado en la carpeta del archivo se pierde en el próximo deploy y vuelve al de la variable IG_ACCESS_TOKEN. Hay que definir dónde guardarlo antes de volver a deployar.',
              { cadaMs: 7 * DIA },
            );
          }
        }
        return true;
      }
      motivo = r.cuerpo?.error?.message
        ? `${r.status} ${r.cuerpo.error.message}`
        : `respuesta inesperada (${r.status})`;
    } catch (err) {
      motivo = err.name === 'TimeoutError' ? 'Meta no respondió a tiempo' : err.message;
    }
    if (fallandoDesde === null) fallandoDesde = ahora();
    warn(`[token] No pude refrescarlo: ${limpiar(motivo)}`);
    return false;
  }

  // Refresca si toca y revisa cuánto le queda. Corre al arrancar y una vez por
  // día. Nunca tira.
  async function revisar() {
    if (revisando) return;
    revisando = true;
    try {
      if (!token) { warn('[token] No hay IG_ACCESS_TOKEN configurado'); return; }
      if (!refrescable) {
        if (!esInstagram && token.startsWith('IG')) {
          warn(`[token] El token es de Instagram Login pero IG_GRAPH_BASE no apunta a ${HOST_INSTAGRAM}: no puedo refrescarlo`);
        } else {
          log(`[token] Refresco automático apagado${esInstagram ? ' (IG_TOKEN_REFRESH)' : `: IG_GRAPH_BASE no apunta a ${HOST_INSTAGRAM}`}`);
        }
        // Sin refresco igual dejamos dicho si el token sirve.
        const salud = await verificar();
        if (salud === 'ok') log('[token] OK: responde bien (vencimiento desconocido)');
        return;
      }

      const toca = refrescadoEn === null || ahora() - refrescadoEn >= refrescarCadaDias * DIA;
      let refrescado = !toca || await refrescar();
      if (!refrescado) {
        // Un token con menos de 24 hs de vida no se puede refrescar y eso no es
        // una falla. Sí lo es que el token ya no sirva, o que pasen los días.
        const antes = token;
        let salud = await verificar();
        if (salud === 'vencido' && token !== antes) {
          // Volvimos al token de la variable: probamos con ese.
          refrescado = await refrescar();
          if (!refrescado) salud = await verificar();
        }
        if (!refrescado) {
          if (salud === 'vencido') return; // ya actuó tokenInvalido()
          const dias = Math.floor((ahora() - (fallandoDesde ?? ahora())) / DIA);
          if (dias >= diasSinRefresco) {
            avisar(
              'token-refresco',
              `hace ${dias} días que no puedo refrescar el token de Instagram. Sigue funcionando, pero si no se renueva vence a los 60 días de generado. Revisar los logs de Railway que empiezan con [token].`,
              { cadaMs: DIA },
            );
          }
        }
      }
      avisarSiVencePronto();
    } catch (err) {
      warn(`[token] Error revisando el token: ${limpiar(err.message)}`);
    } finally {
      revisando = false;
    }
  }

  function avisarSiVencePronto() {
    if (!expiraEn) {
      log('[token] Vencimiento desconocido hasta el primer refresco bueno');
      return;
    }
    const dias = Math.floor((expiraEn - ahora()) / DIA);
    if (dias > diasAviso) {
      log(`[token] OK: vence en ${dias} días (${fechaCorta(expiraEn)})`);
      return;
    }
    avisar(
      'token-vence',
      `al token de Instagram le quedan ${Math.max(dias, 0)} días (vence el ${fechaCorta(expiraEn)}) y el refresco automático no lo está renovando. Hay que generar un token nuevo en la app de Meta y cargarlo en la variable IG_ACCESS_TOKEN de Railway.`,
      { cadaMs: DIA },
    );
  }

  function iniciar({ primeraMs = 30000, cadaMs = DIA } = {}) {
    const primera = setTimeout(() => { revisar(); }, primeraMs);
    const diaria = setInterval(() => { revisar(); }, cadaMs);
    primera.unref?.();
    diaria.unref?.();
    return () => { clearTimeout(primera); clearInterval(diaria); };
  }

  return {
    token: () => token,
    notarError,
    revisar,
    iniciar,
    quieto: () => confirmacion || Promise.resolve(),
    estado: () => ({
      hayToken: !!token, refrescable, expiraEn, refrescadoEn, fallandoDesde, desdeArchivo,
      esElDeLaVariable: token === envToken,
    }),
  };
}
