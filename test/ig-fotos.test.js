// Instagram rechaza .webp y .avif: el bot las sirve convertidas a JPEG desde
// /ig-foto/<id>.jpg. Las demás fotos pasan sin tocar.
//   npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import sharp from 'sharp';
import { crearFotosIg, formatoNoSoportadoPorIg, RUTA_FOTO_IG } from '../ig-fotos.js';

const silencio = { log: () => {}, error: () => {} };

async function levantar(t, opciones) {
  const fotos = crearFotosIg({ ...silencio, ...opciones });
  const app = express();
  app.get(RUTA_FOTO_IG, fotos.servir);
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  t.after(() => srv.close());
  const base = `http://localhost:${srv.address().port}`;
  return { fotos, base };
}

test('detecta webp y avif, sin importar querystring ni mayúsculas', () => {
  assert.ok(formatoNoSoportadoPorIg('https://i.ibb.co/x/Rogue-blanca.webp'));
  assert.ok(formatoNoSoportadoPorIg('https://i.ibb.co/x/Odyssey.AVIF?w=800#a'));
  assert.ok(!formatoNoSoportadoPorIg('https://i.ibb.co/x/Atlas.jpg'));
  assert.ok(!formatoNoSoportadoPorIg('https://i.ibb.co/x/kicks.png?f=webp'));
});

test('jpg y png pasan sin tocar; sin URL pública, webp no se manda', () => {
  const fotos = crearFotosIg({ ...silencio, baseUrl: '' });
  assert.equal(fotos.urlParaIg('https://x/a.jpg'), 'https://x/a.jpg');
  assert.equal(fotos.urlParaIg('https://x/a.png'), 'https://x/a.png');
  assert.equal(fotos.urlParaIg('https://x/a.webp'), null);
  assert.equal(fotos.urlParaIg(''), null);
});

test('un webp se sirve convertido a JPEG desde la URL propia', async (t) => {
  const webp = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#c33' } }).webp().toBuffer();
  let bajadas = 0;
  const fetchImpl = async (url) => {
    bajadas++;
    assert.equal(url, 'https://i.ibb.co/x/Rogue-blanca.webp');
    return new Response(webp, { status: 200 });
  };
  const { fotos, base } = await levantar(t, { baseUrl: 'http://bot.test/', fetchImpl });
  const url = fotos.urlParaIg('https://i.ibb.co/x/Rogue-blanca.webp');
  assert.match(url, /^http:\/\/bot\.test\/ig-foto\/[0-9a-f]{16}\.jpg$/);

  const local = url.replace('http://bot.test', base);
  const r = await fetch(local);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/jpeg');
  const meta = await sharp(Buffer.from(await r.arrayBuffer())).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, 40);

  // La segunda vez sale del cache, sin volver a bajarla.
  assert.equal((await fetch(local)).status, 200);
  assert.equal(bajadas, 1);
});

test('id desconocido da 404 y una original caída da 502 sin tirar el server', async (t) => {
  const fetchImpl = async () => new Response('no', { status: 404 });
  const { fotos, base } = await levantar(t, { baseUrl: 'http://bot.test', fetchImpl });
  assert.equal((await fetch(`${base}/ig-foto/0123456789abcdef.jpg`)).status, 404);
  const url = fotos.urlParaIg('https://i.ibb.co/x/caida.avif').replace('http://bot.test', base);
  assert.equal((await fetch(url)).status, 502);
});
