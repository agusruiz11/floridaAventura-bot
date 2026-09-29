// El agrupador junta los mensajes seguidos de una persona en una sola respuesta
// y nunca corre dos respuestas en paralelo para la misma persona. Timers falsos:
// no espera de verdad los 20 s.
//   npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearAgrupador } from '../agrupar.js';

const ESPERA = 20000;
const MAX = 60000;

// Deja correr las promesas encadenadas (procesar es async) sin tocar el reloj falso.
const flush = () => new Promise((r) => setImmediate(r));

function armar(t, { procesar, esperaMs = ESPERA, maxMs = MAX } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const turnos = [];
  const agrupador = crearAgrupador({
    esperaMs, maxMs,
    log: () => {}, error: () => {},
    procesar: async (id, texto, extra) => {
      turnos.push({ id, texto, textos: extra.textos });
      if (procesar) await procesar(id, texto, extra);
    },
  });
  const avanzar = async (ms) => { t.mock.timers.tick(ms); await flush(); };
  return { agrupador, turnos, avanzar };
}

test('dos mensajes a 8 s dan un solo turno con los dos textos', async (t) => {
  const { agrupador, turnos, avanzar } = armar(t);
  agrupador.agregar('u1', 'Ah no llego x la escuela sale a las 17.55');
  await avanzar(8000);
  agrupador.agregar('u1', 'Un bajon');
  await avanzar(ESPERA - 1);
  assert.equal(turnos.length, 0, 'el segundo mensaje reinició la espera');
  await avanzar(1);
  assert.equal(turnos.length, 1);
  assert.equal(turnos[0].texto, 'Ah no llego x la escuela sale a las 17.55\nUn bajon');
  assert.deepEqual(turnos[0].textos, ['Ah no llego x la escuela sale a las 17.55', 'Un bajon']);
});

test('dos mensajes en el mismo webhook dan un solo turno', async (t) => {
  const { agrupador, turnos, avanzar } = armar(t);
  agrupador.agregar('u1', 'Dale mil grandes');
  agrupador.agregar('u1', 'Gracias');
  await avanzar(ESPERA);
  assert.equal(turnos.length, 1);
  assert.equal(turnos[0].texto, 'Dale mil grandes\nGracias');
  await avanzar(MAX);
  assert.equal(turnos.length, 1, 'no vuelve a disparar sin mensajes nuevos');
});

test('el tope corta la espera aunque siga escribiendo', async (t) => {
  const { agrupador, turnos, avanzar } = armar(t);
  // Un mensaje cada 10 s: cada uno reinicia la espera de 20 s, así que sin tope
  // el bot no contestaría nunca.
  for (let i = 0; i < 12; i++) {
    agrupador.agregar('u1', `m${i}`);
    await avanzar(10000);
    if (i < 5) assert.equal(turnos.length, 0, `a los ${(i + 1) * 10} s todavía espera`);
  }
  // A los 60 s del primero (justo después de agregar m6) se dispara con m0..m6.
  assert.equal(turnos.length, 1);
  assert.deepEqual(turnos[0].textos, ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6']);
});

test('un mensaje que llega mientras responde va al turno siguiente, sin paralelo', async (t) => {
  let enCurso = 0, maxEnCurso = 0;
  let terminarTurno;
  const { agrupador, turnos, avanzar } = armar(t, {
    procesar: async () => {
      enCurso++;
      maxEnCurso = Math.max(maxEnCurso, enCurso);
      await new Promise((r) => { terminarTurno = r; });
      enCurso--;
    },
  });
  agrupador.agregar('u1', 'hola');
  await avanzar(ESPERA);
  assert.equal(turnos.length, 1);
  assert.equal(agrupador.ocupado('u1'), true);

  // Llega otro mientras contestamos y se le vence la espera: no arranca otro turno.
  agrupador.agregar('u1', 'tienen sede en Núñez?');
  await avanzar(ESPERA);
  assert.equal(turnos.length, 1, 'no corre en paralelo');
  assert.equal(enCurso, 1);

  // Termina el primero: recién ahí sale el segundo, solo con lo nuevo.
  terminarTurno();
  await flush();
  assert.equal(turnos.length, 2);
  assert.equal(turnos[1].texto, 'tienen sede en Núñez?');
  assert.equal(maxEnCurso, 1);
  assert.equal(agrupador.ocupado('u1'), true);
  terminarTurno();
  await flush();
  assert.equal(agrupador.ocupado('u1'), false);
});

test('si llega durante el turno pero la espera no venció, espera a que termine de escribir', async (t) => {
  let terminarTurno;
  const { agrupador, turnos, avanzar } = armar(t, {
    procesar: async () => { await new Promise((r) => { terminarTurno = r; }); },
  });
  agrupador.agregar('u1', 'hola');
  await avanzar(ESPERA);
  agrupador.agregar('u1', 'una cosa más');
  await avanzar(5000);
  terminarTurno();
  await flush();
  assert.equal(turnos.length, 1, 'todavía no pasaron los 20 s del último mensaje');
  await avanzar(ESPERA - 5000);
  assert.equal(turnos.length, 2);
  assert.equal(turnos[1].texto, 'una cosa más');
  terminarTurno();
});

test('cancelar descarta lo pendiente', async (t) => {
  const { agrupador, turnos, avanzar } = armar(t);
  agrupador.agregar('u1', 'hola');
  agrupador.agregar('u1', 'info?');
  await avanzar(5000);
  assert.equal(agrupador.ocupado('u1'), true);
  assert.equal(agrupador.cancelar('u1', 'respuesta manual'), 2);
  assert.equal(agrupador.ocupado('u1'), false);
  await avanzar(MAX);
  assert.equal(turnos.length, 0);
  assert.equal(agrupador.cancelar('u1'), 0, 'cancelar sin nada pendiente no rompe');
});

test('cada persona tiene su propio buffer y su propio turno', async (t) => {
  const { agrupador, turnos, avanzar } = armar(t);
  agrupador.agregar('a', 'hola');
  agrupador.agregar('b', 'buenas');
  await avanzar(ESPERA);
  assert.deepEqual(turnos.map((x) => [x.id, x.texto]), [['a', 'hola'], ['b', 'buenas']]);
});

test('con espera 0 contesta enseguida y conserva el turno por persona', async (t) => {
  const { agrupador, turnos, avanzar } = armar(t, { esperaMs: 0, maxMs: 0 });
  agrupador.agregar('u1', 'hola');
  await avanzar(0);
  assert.equal(turnos.length, 1);
});

test('un error en procesar no deja la persona trabada', async (t) => {
  let fallar = true;
  const { agrupador, turnos, avanzar } = armar(t, {
    procesar: async () => { if (fallar) throw new Error('modelo caído'); },
  });
  agrupador.agregar('u1', 'hola');
  await avanzar(ESPERA);
  assert.equal(agrupador.ocupado('u1'), false);
  fallar = false;
  agrupador.agregar('u1', 'sigo acá');
  await avanzar(ESPERA);
  assert.equal(turnos.length, 2);
});
