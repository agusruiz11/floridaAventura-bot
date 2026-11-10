// ─── Fotos para Instagram ────────────────────────────────────────────────────
// Instagram rechaza las fotos .webp y .avif ("Upload attachment failure", code
// 100, subcode 2018047), y varias fotos del catálogo están en esos formatos. En
// vez de pedir que las re-suban, el bot las convierte a JPEG: le pasa a Instagram
// una URL propia (/ig-foto/<id>.jpg) que baja la original, la convierte con sharp
// y la sirve. Las demás fotos pasan sin tocar.
//
// Sin URL pública (baseUrl vacío) no hay a dónde apuntar a Instagram: esas fotos
// no se mandan y el texto del auto sale igual, como antes.
//
//   const fotos = crearFotosIg({ baseUrl });
//   fotos.urlParaIg(url)      → la URL a mandar, o null si no se puede mandar
//   app.get(RUTA_FOTO_IG, fotos.servir)

import crypto from 'crypto';

export const RUTA_FOTO_IG = '/ig-foto/:id';

// Mira la URL sin querystring ni fragmento.
export function formatoNoSoportadoPorIg(url) {
  const ruta = String(url || '').split(/[?#]/)[0].toLowerCase();
  return ruta.endsWith('.avif') || ruta.endsWith('.webp');
}

// sharp se carga recién la primera vez que hace falta: si no llegara a cargar,
// el bot arranca igual y solo fallan estas fotos.
async function aJpeg(buffer) {
  const sharp = (await import('sharp')).default;
  return sharp(buffer)
    .rotate()
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 85 })
    .toBuffer();
}

export function crearFotosIg({
  baseUrl = '',
  convertir = aJpeg,
  fetchImpl = fetch,
  maxCache = 30,
  maxRegistro = 500,
  log = console.log,
  error = console.error,
} = {}) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const registro = new Map(); // id → URL original
  const cache = new Map();    // id → JPEG ya convertido

  const recortar = (mapa, max) => {
    while (mapa.size > max) mapa.delete(mapa.keys().next().value);
  };

  function urlParaIg(url) {
    if (!url) return null;
    if (!formatoNoSoportadoPorIg(url)) return url;
    if (!base) return null;
    const id = crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
    registro.delete(id);
    registro.set(id, url);
    recortar(registro, maxRegistro);
    return `${base}/ig-foto/${id}.jpg`;
  }

  async function servir(req, res) {
    const id = String(req.params.id || '').replace(/\.jpg$/i, '');
    const original = registro.get(id);
    if (!original) return res.sendStatus(404);
    try {
      let jpeg = cache.get(id);
      if (!jpeg) {
        const r = await fetchImpl(original);
        if (!r.ok) throw new Error(`la foto original respondió ${r.status}`);
        jpeg = await convertir(Buffer.from(await r.arrayBuffer()));
        cache.set(id, jpeg);
        recortar(cache, maxCache);
        log(`[ig] Foto convertida a JPEG: ${original} (${jpeg.length} bytes)`);
      }
      res.set('Cache-Control', 'public, max-age=86400');
      res.type('image/jpeg').send(jpeg);
    } catch (err) {
      error(`[ig] No pude convertir la foto ${original}: ${err.message}`);
      res.sendStatus(502);
    }
  }

  return { urlParaIg, servir };
}
