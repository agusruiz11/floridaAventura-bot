// ─── Guardar una variable en Railway desde el propio bot ─────────────────────
// Meta entrega un token de Instagram distinto en cada refresco (ver ig-token.js).
// Este servicio no tiene volumen a propósito: un servicio con volumen se corta
// unos segundos en cada deploy y acá eso pega también en el chat de la web. En
// vez de guardar el token en disco lo escribimos en la variable IG_ACCESS_TOKEN
// del servicio, con skipDeploys para que el cambio NO dispare un redeploy: el
// proceso sigue con el token en memoria y el próximo deploy ya arranca con el
// token nuevo.
//
// Necesita un token de proyecto de Railway (Project Settings > Tokens, ambiente
// production) en RAILWAY_API_TOKEN. Los IDs los pone Railway solo en cada
// servicio (RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT_ID, RAILWAY_SERVICE_ID).
//
//   const guardar = crearGuardadoEnRailway({ apiToken, projectId, environmentId, serviceId });
//   guardar           → null si falta algún dato (no hay dónde guardar)
//   await guardar(v)  → escribe la variable; tira un Error sin el valor si falla
//
// Sin dependencias del server: se prueba con fetch falso (test/railway-vars.test.js).

const API_RAILWAY = 'https://backboard.railway.com/graphql/v2';

const MUTACION = `mutation variableUpsert($input: VariableUpsertInput!) {
  variableUpsert(input: $input)
}`;

export function crearGuardadoEnRailway({
  apiToken = '',
  projectId = '',
  environmentId = '',
  serviceId = '',
  nombre = 'IG_ACCESS_TOKEN',
  api = API_RAILWAY,
  fetchFn = globalThis.fetch,
} = {}) {
  apiToken = String(apiToken || '').trim();
  if (!apiToken || !projectId || !environmentId || !serviceId) return null;

  return async function guardar(valor) {
    if (typeof valor !== 'string' || !valor) throw new Error('valor vacío');
    let res;
    try {
      res = await fetchFn(api, {
        method: 'POST',
        headers: {
          // Los tokens de proyecto van en este header, no en Authorization.
          'Project-Access-Token': apiToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: MUTACION,
          variables: {
            input: { projectId, environmentId, serviceId, name: nombre, value: valor, skipDeploys: true },
          },
        }),
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      throw new Error(err.name === 'TimeoutError' ? 'Railway no respondió a tiempo' : `error de red (${err.name})`);
    }
    if (!res.ok) throw new Error(`Railway respondió ${res.status}`);
    let cuerpo = null;
    try { cuerpo = await res.json(); } catch { /* no era JSON */ }
    if (!cuerpo || cuerpo.errors?.length) {
      // Solo el mensaje del primer error, recortado: nunca el cuerpo entero.
      const detalle = String(cuerpo?.errors?.[0]?.message || 'respuesta sin datos').slice(0, 120);
      throw new Error(`Railway rechazó el cambio: ${detalle}`);
    }
    if (!cuerpo.data || cuerpo.data.variableUpsert === false) throw new Error('Railway no confirmó el cambio');
    return true;
  };
}
