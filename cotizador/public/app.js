// Cotizador de Florida Aventura: pantalla.
// El navegador no calcula ningún total: cada cambio de valor vuelve a pedirle
// la cuenta al servidor (/api/cotizar), que usa las reglas de cotizacion.js.

const DESTINOS = ['Orlando', 'Naples', 'Key West', 'Clearwater', 'Daytona', 'West Palm Beach', 'Isla Morada'];
const CAMPOS = ['retiroFecha', 'retiroHora', 'devolucionFecha', 'devolucionHora', 'lugarEntrega', 'lugarDevolucion', 'categoria', 'pasajeros', 'valijas'];
const WHATSAPP = '+1 305 773 1787';

const $ = (id) => document.getElementById(id);

// Crea un elemento. Todo texto entra por textContent: nada de lo que escribió
// el cliente o devolvió la API se interpreta como HTML.
function el(tag, props = {}, hijos = []) {
  const nodo = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') nodo.className = v;
    else if (k === 'text') nodo.textContent = v;
    else if (k.startsWith('on')) nodo.addEventListener(k.slice(2), v);
    else if (v === true) nodo.setAttribute(k, '');
    else nodo.setAttribute(k, v);
  }
  for (const h of [].concat(hijos)) if (h) nodo.append(h);
  return nodo;
}

const estado = {
  leido: false,     // ¿los datos vinieron de la lectura automática?
  busqueda: null,   // respuesta de /api/buscar
  viaje: null,      // lo que se mandó a buscar (fechas, destinos, puerto)
  autos: [],        // { ...ficha, elegido, precio, nota }
  cotizacion: null, // respuesta de /api/cotizar
  sunPassManual: false, // ¿Patricia tocó el SunPass?
};

async function pedir(ruta, cuerpo) {
  let res;
  try {
    res = await fetch(ruta, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo || {}) });
  } catch {
    throw new Error('No hay conexión. Probá de nuevo.');
  }
  if (res.status === 401) { window.location.href = '/entrar.html'; throw new Error('Sesión vencida.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Algo falló. Probá de nuevo.');
  return data;
}

function mostrarError(id, mensaje) {
  const nodo = $(id);
  nodo.textContent = mensaje || '';
  nodo.hidden = !mensaje;
}

const normalizar = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

// ─── Destinos ───────────────────────────────────────────────────────────────

function armarDestinos() {
  const caja = $('destinos');
  for (const d of DESTINOS) {
    caja.append(el('label', { class: 'casilla' }, [
      el('input', { type: 'checkbox', value: d, 'data-destino': '' }),
      el('span', { text: d }),
    ]));
  }
}

const destinosElegidos = () => [...document.querySelectorAll('[data-destino]:checked')].map((c) => c.value);

// ─── Leer los mensajes ──────────────────────────────────────────────────────

function cargarDatos(datos) {
  estado.leido = true;
  for (const campo of CAMPOS) {
    const valor = datos[campo];
    $(campo).value = valor ?? '';
    const nota = $(`n-${campo}`);
    if (nota) nota.textContent = valor == null ? 'No lo dijo' : '';
  }
  if (datos.retiroFecha && datos.retiroHora == null) $('n-retiroHora').textContent = 'No la dijo: se cotiza con 07:00';
  if (datos.devolucionFecha && datos.devolucionHora == null) $('n-devolucionHora').textContent = 'No la dijo: se cotiza con 20:00';
  $('puertoDeCruceros').checked = !!datos.puertoDeCruceros;

  const mencionados = (datos.destinos || []).map(normalizar);
  const otros = [];
  for (const casilla of document.querySelectorAll('[data-destino]')) casilla.checked = false;
  for (const d of datos.destinos || []) {
    const casilla = [...document.querySelectorAll('[data-destino]')].find((c) => normalizar(c.value) === normalizar(d));
    if (casilla) casilla.checked = true;
    else otros.push(d);
  }
  const nodoOtros = $('otros-destinos');
  nodoOtros.hidden = !otros.length;
  nodoOtros.textContent = otros.length ? `También mencionó: ${otros.join(', ')} (sin cargo de SunPass definido).` : '';
  if (!mencionados.length) { nodoOtros.hidden = false; nodoOtros.textContent = 'No mencionó destinos.'; }

  const lista = $('lista-dudas');
  lista.replaceChildren(...(datos.dudas || []).map((d) => el('li', { text: d })));
  $('dudas').hidden = !(datos.dudas || []).length;
}

async function leerMensajes() {
  const mensajes = $('mensajes').value.trim();
  mostrarError('error-leer', '');
  if (!mensajes) { mostrarError('error-leer', 'Pegá los mensajes del cliente, o completá los datos a mano abajo.'); return; }
  const boton = $('btn-leer');
  boton.disabled = true;
  $('estado-leer').textContent = 'Leyendo…';
  try {
    const { datos } = await pedir('/api/leer', { mensajes });
    cargarDatos(datos);
    $('estado-leer').textContent = 'Listo. Revisá los datos abajo.';
    $('t-datos').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    $('estado-leer').textContent = '';
    mostrarError('error-leer', err.message);
  } finally {
    boton.disabled = false;
  }
}

// ─── Buscar autos ───────────────────────────────────────────────────────────

function viajeDelFormulario() {
  return {
    retiroFecha: $('retiroFecha').value,
    retiroHora: $('retiroHora').value,
    devolucionFecha: $('devolucionFecha').value,
    devolucionHora: $('devolucionHora').value,
    destinos: destinosElegidos(),
    puertoDeCruceros: $('puertoDeCruceros').checked,
  };
}

// Preselecciona hasta 3 autos que cumplen con pasajeros y valijas: el más
// económico, uno intermedio y el más amplio.
function preseleccionar(autos) {
  const pasajeros = Number($('pasajeros').value) || 0;
  const valijas = Number($('valijas').value) || 0;
  const tipo = normalizar($('categoria').value);
  for (const a of autos) {
    a.ajusta = (!pasajeros || (a.passengersAmount ?? 0) >= pasajeros) && (!valijas || (a.suitcasesAmount ?? 0) >= valijas);
    a.coincideTipo = !!tipo && (normalizar(a.name).includes(tipo) || normalizar(a.tamanio).includes(tipo));
  }
  autos.sort((x, y) => (y.ajusta - x.ajusta) || (x.pricePerDay - y.pricePerDay));
  if (!pasajeros && !valijas) return;
  const aptos = autos.filter((a) => a.ajusta);
  const indices = [...new Set([0, Math.floor((aptos.length - 1) / 2), aptos.length - 1])];
  for (const i of indices) if (aptos[i]) aptos[i].elegido = true;
}

async function buscar(e) {
  e.preventDefault();
  mostrarError('error-buscar', '');
  const viaje = viajeDelFormulario();
  if (!viaje.retiroFecha || !viaje.devolucionFecha) {
    mostrarError('error-buscar', 'Faltan las fechas de retiro y devolución.');
    return;
  }
  const boton = $('btn-buscar');
  boton.disabled = true;
  $('estado-buscar').textContent = 'Buscando…';
  try {
    const r = await pedir('/api/buscar', viaje);
    if (!r.ok) { mostrarError('error-buscar', r.error); $('estado-buscar').textContent = ''; return; }
    estado.viaje = viaje;
    estado.busqueda = r;
    estado.autos = r.autos.map((a) => ({ ...a, elegido: false, precio: a.pricePerDay, nota: '' }));
    estado.cotizacion = null;
    estado.sunPassManual = false;
    preseleccionar(estado.autos);

    $('aj-dias').value = r.rango.dias;
    $('aj-sunpass').value = r.sunPass.monto;
    pintarBusqueda();
    $('s-autos').hidden = false;
    $('estado-buscar').textContent = '';
    $('t-autos').scrollIntoView({ behavior: 'smooth', block: 'start' });
    await cotizar();
  } catch (err) {
    $('estado-buscar').textContent = '';
    mostrarError('error-buscar', err.message);
  } finally {
    boton.disabled = false;
  }
}

function pintarBusqueda() {
  const { rango, fechas, avisos, autos } = estado.busqueda;
  $('resumen-busqueda').textContent =
    `${fechas} · Retiro ${rango.retiro}, devolución ${rango.devolucion}${rango.horariosEstimados ? ' (horarios estimados)' : ''} · ` +
    `${autos.length} ${autos.length === 1 ? 'auto disponible' : 'autos disponibles'}`;
  const caja = $('avisos-busqueda');
  caja.replaceChildren(...(avisos || []).map((a) => el('p', { text: a })));
  caja.hidden = !(avisos || []).length;
  pintarAutos();
}

function marcarAjuste(idCampo, idNota, modificado, textoRegla) {
  $(idCampo).closest('.campo').classList.toggle('modificado', modificado);
  const nota = $(idNota);
  nota.replaceChildren();
  if (modificado) {
    nota.append('Modificado a mano. ', textoRegla, ' ');
    nota.append(el('button', { type: 'button', class: 'boton-texto', text: 'Restaurar', onclick: () => restaurar(idCampo) }));
  } else {
    nota.textContent = textoRegla;
  }
}

function restaurar(idCampo) {
  const { rango, sunPass } = estado.busqueda;
  if (idCampo === 'aj-dias') $('aj-dias').value = rango.dias;
  if (idCampo === 'aj-sunpass') {
    estado.sunPassManual = false;
    $('aj-sunpass').value = estado.cotizacion?.sunPassRegla?.monto ?? sunPass.monto;
  }
  cotizar();
}

function pintarAutos() {
  const lista = $('lista-autos');
  lista.replaceChildren(...estado.autos.map((a, i) => {
    const idPrecio = `precio-${i}`;
    const idNota = `nota-${i}`;
    const idCheck = `elegir-${i}`;
    const datos = [a.tamanio, a.passengersAmount != null ? `${a.passengersAmount} pasajeros` : '', a.suitcasesAmount != null ? `aprox. ${a.suitcasesAmount} valijas` : '']
      .filter(Boolean).join(' · ');
    const modificado = Number(a.precio) !== Number(a.pricePerDay);

    const item = el('li', { class: `auto${a.elegido ? ' elegido' : ''}` }, [
      el('input', {
        type: 'checkbox', id: idCheck, checked: a.elegido, 'aria-label': `Elegir ${a.titulo}`,
        onchange: (e) => { a.elegido = e.target.checked; item.classList.toggle('elegido', a.elegido); pintarNota(); cotizar(); },
      }),
      a.imageUrl
        ? el('img', { class: 'auto-foto', src: a.imageUrl, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
        : el('div', { class: 'auto-foto' }),
      el('div', {}, [
        el('label', { class: 'auto-nombre', for: idCheck, text: a.titulo }),
        el('p', { class: 'auto-datos' }, [
          datos,
          a.ajusta && (Number($('pasajeros').value) || Number($('valijas').value)) ? el('span', { class: 'auto-ajusta', text: ' · Se ajusta al pedido' }) : null,
        ]),
      ]),
      el('div', { class: 'auto-detalle' }, [
        el('div', { class: `campo${modificado ? ' modificado' : ''}` }, [
          el('label', { for: idPrecio, text: 'USD por día' }),
          el('input', {
            id: idPrecio, type: 'number', min: '1', max: '5000', step: '0.01', inputmode: 'decimal', value: a.precio,
            oninput: (e) => { a.precio = e.target.value; cotizarPronto(); },
          }),
          el('span', { class: 'nota', text: modificado ? `Modificado a mano. Lista: USD ${a.pricePerDay}` : '' }),
        ]),
        el('div', { class: 'auto-total' }, ['Total', el('strong', { 'data-total': a.name, text: a.total ? `USD ${a.total}` : '' })]),
      ]),
    ]);

    const cajaNota = el('div', { class: 'campo auto-nota', hidden: !a.elegido }, [
      el('label', { for: idNota, text: 'Comentario para el cliente (opcional)' }),
      el('input', { id: idNota, type: 'text', maxlength: '160', value: a.nota, oninput: (e) => { a.nota = e.target.value; cotizarPronto(); } }),
    ]);
    item.append(cajaNota);
    function pintarNota() { cajaNota.hidden = !a.elegido; }
    return item;
  }));
}

// ─── Cotizar ────────────────────────────────────────────────────────────────

let temporizador = null;
function cotizarPronto() {
  clearTimeout(temporizador);
  temporizador = setTimeout(cotizar, 450);
}

let pedidoEnCurso = 0;
async function cotizar() {
  if (!estado.busqueda) return;
  mostrarError('error-cotizar', '');
  const { rango } = estado.busqueda;
  const dias = Number($('aj-dias').value);
  const sunPassIngresado = $('aj-sunpass').value === '' ? null : Number($('aj-sunpass').value);
  // El SunPass se manda como ajuste solo si Patricia lo tocó. Si no, lo calcula
  // la regla (y se recalcula sola cuando cambian los días).
  const sunPassManual = estado.sunPassManual && sunPassIngresado != null;

  const cuerpo = {
    viaje: estado.viaje,
    ajustes: {
      dias: dias !== rango.dias ? dias : null,
      sunPass: sunPassManual ? sunPassIngresado : null,
    },
    autos: estado.autos.map((a) => ({
      name: a.name, year: a.year, type: a.type, color: a.color,
      passengersAmount: a.passengersAmount, suitcasesAmount: a.suitcasesAmount, imageUrl: a.imageUrl,
      pricePerDay: Number(a.precio), elegido: a.elegido, nota: a.nota,
    })),
  };

  const turno = ++pedidoEnCurso;
  try {
    const c = await pedir('/api/cotizar', cuerpo);
    if (turno !== pedidoEnCurso) return; // llegó una respuesta vieja
    estado.cotizacion = c;
    if (!sunPassManual) $('aj-sunpass').value = c.sunPassRegla.monto;
    pintarCotizacion();
  } catch (err) {
    if (turno !== pedidoEnCurso) return;
    mostrarError('error-cotizar', err.message);
  }
}

function pintarCotizacion() {
  const c = estado.cotizacion;
  const { reglas } = estado.busqueda;

  marcarAjuste('aj-dias', 'n-aj-dias', c.dias !== c.diasRegla, `Por las fechas y horarios: ${c.diasRegla}.`);
  marcarAjuste('aj-sunpass', 'n-aj-sunpass', c.sunPass.manual, `Por regla: USD ${c.sunPassRegla.texto} (${c.sunPassRegla.detalle}).`);

  const notaDescuento = $('nota-descuento');
  const conDescuento = c.autos.some((a) => a.descuento);
  notaDescuento.hidden = false;
  notaDescuento.textContent = conDescuento
    ? `Con ${c.dias} días se aplica el ${reglas.descuentoPorcentaje}% de descuento sobre el alquiler.`
    : `El ${reglas.descuentoPorcentaje}% de descuento se aplica desde ${reglas.descuentoDesdeDias} días.`;
  if (c.dias < reglas.minimoDias) notaDescuento.textContent += ` Atención: ${c.dias} días está por debajo del mínimo de ${reglas.minimoDias}.`;

  for (const a of c.autos) {
    const nodo = [...document.querySelectorAll('[data-total]')].find((n) => n.getAttribute('data-total') === a.name);
    if (nodo) nodo.textContent = `USD ${a.total}`;
  }
  // Marca de precio modificado, sin redibujar la lista (se perdería el foco).
  estado.autos.forEach((a, i) => {
    const campo = $(`precio-${i}`)?.closest('.campo');
    if (!campo) return;
    const modificado = Number(a.precio) !== Number(a.pricePerDay);
    campo.classList.toggle('modificado', modificado);
    campo.querySelector('.nota').textContent = modificado ? `Modificado a mano. Lista: USD ${a.pricePerDay}` : '';
  });

  const elegidos = c.autos.filter((a) => a.elegido);
  $('s-salida').hidden = !elegidos.length;
  if (!elegidos.length) return;
  pintarMensajes(c.mensajes);
  pintarHoja(c, elegidos);
}

// ─── Salida: mensajes para Instagram ────────────────────────────────────────

async function copiar(texto, boton) {
  try {
    await navigator.clipboard.writeText(texto);
  } catch {
    const area = el('textarea', { readonly: true });
    area.value = texto;
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  if (boton) {
    const antes = boton.textContent;
    boton.textContent = 'Copiado';
    setTimeout(() => { boton.textContent = antes; }, 1600);
  }
}

function pintarMensajes(mensajes) {
  $('lista-mensajes').replaceChildren(...mensajes.map((m, i) => el('li', { class: 'mensaje' }, [
    el('div', { class: 'mensaje-cabeza' }, [
      el('span', { text: `Mensaje ${i + 1} de ${mensajes.length}` }),
      el('button', { type: 'button', class: 'boton boton-secundario boton-chico', text: 'Copiar', onclick: (e) => copiar(m, e.currentTarget) }),
    ]),
    el('pre', { text: m }),
  ])));
}

// ─── Salida: hoja para PDF ──────────────────────────────────────────────────

function filaCuenta(concepto, monto, clase) {
  return el('tr', { class: clase }, [el('td', { text: concepto }), el('td', { text: monto })]);
}

function pintarHoja(c, elegidos) {
  const hoy = new Date().toLocaleDateString('es-AR', { day: 'numeric', month: 'long', year: 'numeric' });
  const lugarEntrega = $('lugarEntrega').value.trim();
  const lugarDevolucion = $('lugarDevolucion').value.trim();
  const dato = (titulo, valor) => (valor ? el('div', {}, [el('dt', { text: titulo }), el('dd', { text: valor })]) : null);
  const dias = `${c.dias} ${c.dias === 1 ? 'día' : 'días'}`;

  const hoja = $('hoja');
  const partes = [
    el('header', { class: 'hoja-cabeza' }, [
      el('img', { src: '/logo.png', alt: 'Florida Aventura Car Rental' }),
      el('div', {}, [
        el('h1', { class: 'hoja-titulo', text: 'Tu cotización' }),
        el('p', { class: 'hoja-fecha', text: `Emitida el ${hoy}` }),
      ]),
    ]),
    el('h3', { text: 'Tu viaje' }),
    el('dl', { class: 'hoja-viaje' }, [
      dato('Fechas', c.fechas),
      dato('Duración', dias),
      dato('Retiro', `${c.rango.retiro} hs${c.rango.horariosEstimados ? ' (estimado)' : ''}${lugarEntrega ? ` · ${lugarEntrega}` : ''}`),
      dato('Devolución', `${c.rango.devolucion} hs${c.rango.horariosEstimados ? ' (estimado)' : ''}${lugarDevolucion ? ` · ${lugarDevolucion}` : ''}`),
    ]),
    el('h3', { text: elegidos.length === 1 ? 'Opción' : 'Opciones' }),
    ...elegidos.map((a) => {
      const datos = [a.tamanio, a.passengersAmount != null ? `${a.passengersAmount} pasajeros` : '', a.suitcasesAmount != null ? `aprox. ${a.suitcasesAmount} valijas` : '']
        .filter(Boolean).join(' · ');
      const cuenta = el('table', { class: 'hoja-cuenta' }, el('tbody', {}, [
        a.descuento
          ? filaCuenta(`Alquiler: USD ${a.precioPorDia} por día × ${dias}`, `USD ${a.alquilerSinDescuento}`)
          : filaCuenta(`Alquiler: USD ${a.precioPorDia} por día × ${dias}`, `USD ${a.precioBase}`),
        a.descuento ? filaCuenta(`Descuento ${a.descuento} por alquiler largo`, `menos USD ${a.descuentoUSD}`) : null,
        filaCuenta('SunPass (peajes)', `USD ${a.sunPass}`),
        c.puertoDeCruceros ? filaCuenta('Entrega en el Puerto de Cruceros', `USD ${c.cargoPuerto}`) : null,
        filaCuenta('Total', `USD ${a.total}`, 'total'),
      ]));
      return el('section', { class: 'hoja-auto' }, [
        a.imageUrl ? el('img', { src: a.imageUrl, alt: a.titulo, referrerpolicy: 'no-referrer' }) : el('div', {}),
        el('div', {}, [
          el('h4', { text: a.titulo }),
          el('p', { class: 'hoja-auto-datos', text: datos }),
          a.nota ? el('p', { class: 'hoja-auto-nota', text: a.nota }) : null,
          cuenta,
          Number(a.passengersAmount) === 7
            ? el('p', { class: 'hoja-letra', text: 'Los 7 asientos se logran usando el espacio del baúl para la tercera fila. Si viajan con valijas, el auto entra cómodamente 5 personas.' })
            : null,
        ]),
      ]);
    }),
    el('h3', { text: 'Incluye' }),
    el('ul', { class: 'hoja-incluye' }, [
      el('li', { text: 'Seguro del vehículo' }),
      el('li', { text: 'Kilometraje ilimitado dentro de Florida' }),
      el('li', { text: 'Tanque lleno al retirar y al devolver' }),
      el('li', { text: '1 conductor adicional' }),
    ]),
    c.rango.horariosEstimados
      ? el('p', { class: 'hoja-letra', text: `Cotizado con retiro a las ${c.rango.retiro} y devolución a las ${c.rango.devolucion}. Con tus horarios exactos se ajusta el total.` })
      : null,
    el('p', { class: 'hoja-letra', text: 'Estos valores son una estimación orientativa. El cargo de SunPass puede variar según los destinos que visites y la duración del viaje. Los montos y la disponibilidad definitivos se confirman con nuestro equipo comercial al momento de la reserva.' }),
    el('footer', { class: 'hoja-pie' }, [
      el('span', { text: `WhatsApp ${WHATSAPP}` }),
      el('span', { text: 'floridaaventura.com' }),
      el('span', { text: 'Instagram @floridaaventura' }),
    ]),
  ];
  hoja.replaceChildren(...partes.filter(Boolean));
}

// ─── Pestañas, inicio ───────────────────────────────────────────────────────

function elegirPestana(cual) {
  for (const [tab, panel] of [['tab-ig', 'panel-ig'], ['tab-pdf', 'panel-pdf']]) {
    const activa = tab === cual;
    $(tab).setAttribute('aria-selected', String(activa));
    $(panel).hidden = !activa;
  }
}

function nuevaCotizacion() {
  $('mensajes').value = '';
  $('form-datos').reset();
  for (const nota of document.querySelectorAll('#form-datos .nota')) nota.textContent = '';
  $('otros-destinos').hidden = true;
  $('dudas').hidden = true;
  $('s-autos').hidden = true;
  $('s-salida').hidden = true;
  $('estado-leer').textContent = '';
  for (const id of ['error-leer', 'error-buscar', 'error-cotizar']) mostrarError(id, '');
  Object.assign(estado, { leido: false, busqueda: null, viaje: null, autos: [], cotizacion: null, sunPassManual: false });
  window.scrollTo({ top: 0 });
}

armarDestinos();
$('btn-leer').addEventListener('click', leerMensajes);
$('form-datos').addEventListener('submit', buscar);
$('aj-dias').addEventListener('input', cotizarPronto);
$('aj-sunpass').addEventListener('input', () => { estado.sunPassManual = true; cotizarPronto(); });
$('tab-ig').addEventListener('click', () => elegirPestana('tab-ig'));
$('tab-pdf').addEventListener('click', () => elegirPestana('tab-pdf'));
$('btn-copiar-todo').addEventListener('click', (e) => copiar((estado.cotizacion?.mensajes || []).join('\n\n'), e.currentTarget));
$('btn-pdf').addEventListener('click', () => { elegirPestana('tab-pdf'); window.print(); });
$('btn-nueva').addEventListener('click', nuevaCotizacion);
$('btn-salir').addEventListener('click', async () => { await pedir('/api/salir').catch(() => {}); window.location.href = '/entrar.html'; });
