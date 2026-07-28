# Guía — Dejar el bot de Instagram funcionando al público

## Dónde estamos hoy

El bot **ya funciona** en el Instagram de Florida (@floridaaventura), pero **solo le responde a cuentas "tester"** (como posicionarte.online). Para que le conteste a **cualquier cliente real**, Meta tiene que aprobar el permiso `instagram_business_manage_messages` con **"Acceso avanzado"** (App Review).

Todo lo demás ya está listo: app publicada (Live) ✅, política de privacidad ✅, webhook ✅, token ✅.

---

## ✅ Checklist final de producción

- [ ] **Horas reales en Railway:** `IG_BOT_START_HOUR=23` y `IG_BOT_END_HOUR=7` (o borrar esas 2 variables → usa 23/7 por defecto).
- [ ] **App Review aprobado** (lo de abajo) → para clientes reales, no solo testers.
- [ ] *(Opcional, seguridad)* `IG_APP_SECRET` seteado en Railway (Configuración → Básico → App Secret).
- [ ] *(Si Meta lo pide)* Verificación del negocio (Business Verification) en el Business Manager.

Comportamiento final una vez aprobado:
- 🌙 **23:00–07:00 (Florida)** → contesta el bot (con la nota de "estamos cerrados").
- ☀️ **07:00–23:00 (Florida)** → contesta Patricia (bot callado).

---

## Paso a paso del App Review

### 1. Dónde se pide
Meta for Developers → tu app **Florida Aventura bot** → menú **Casos de uso** → **API de Instagram** → pestaña **Permisos y funciones**.

Buscá la fila **`instagram_business_manage_messages`** (hoy dice "Listo para la prueba" / acceso estándar) → botón **"Acciones"** → **"Solicitar acceso avanzado"**.

> Si te pide primero **verificar el negocio** (Business Verification), hacé ese trámite en el Business Manager y volvé.

### 2. Qué te va a pedir Meta
Un formulario con:
1. **Descripción de cómo tu app usa el permiso** → pegá el texto del punto 3.
2. **Un video (screen recording)** mostrando el flujo → guión en el punto 4.
3. A veces, **instrucciones para el revisor** → texto en el punto 5.

### 3. Texto: "cómo usa tu app este permiso"

> **Recomendado en inglés** (los revisores de Meta suelen leer en inglés). Copiá y pegá tal cual:

```
Our app is a customer-service assistant for Florida Aventura Rent a Car, a car
rental business in Miami. We use the instagram_business_manage_messages permission
to read and reply to Instagram Direct messages sent to our own business account
(@floridaaventura).

Flow: a customer sends a Direct Message to @floridaaventura asking about renting a
car. Our server receives the message through the "messages" webhook, generates a
helpful reply (answering questions about available vehicles, dates, prices,
insurance and requirements, and helping the customer start a reservation), and
sends that reply back to the customer through the Instagram messaging API.

We only read and respond to messages that customers send to our own business
account, and only to assist them with their rental inquiry. We never initiate
conversations with users who have not messaged us first, and we do not use message
data for any purpose other than answering the customer. This lets us respond
instantly, including outside business hours.
```

> Versión en español (por si preferís o Meta lo permite):

```
Nuestra app es un asistente de atención al cliente para Florida Aventura Rent a Car,
una empresa de alquiler de autos en Miami. Usamos el permiso
instagram_business_manage_messages para leer y responder los mensajes directos de
Instagram que llegan a nuestra propia cuenta de negocio (@floridaaventura).

Flujo: un cliente nos escribe un DM a @floridaaventura preguntando por alquilar un
auto. Nuestro servidor recibe el mensaje por el webhook "messages", genera una
respuesta útil (responde sobre vehículos disponibles, fechas, precios, seguro y
requisitos, y ayuda a iniciar una reserva) y la envía de vuelta al cliente por la
API de mensajería de Instagram.

Solo leemos y respondemos mensajes que los clientes envían a nuestra propia cuenta
de negocio, y únicamente para ayudarlos con su consulta de alquiler. Nunca
iniciamos conversaciones con personas que no nos escribieron primero, y no usamos
los datos para ningún otro fin. Esto nos permite responder al instante, incluso
fuera del horario comercial.
```

### 4. El video (guión de 1–2 min)
Grabá la pantalla mostrando, de punta a punta:
1. Una cuenta de Instagram abriendo un chat con **@floridaaventura**.
2. El usuario manda: *"Hola, quiero alquilar un auto en Miami"*.
3. El bot responde (saludo + pregunta las fechas).
4. El usuario da fechas y horarios: *"Del 15 al 25 de septiembre, retiro 10am, devuelvo 8pm, somos 2"*.
5. El bot muestra las opciones de autos con precios y fotos.
6. *(Suma puntos)* Mostrar brevemente tu app en developers.facebook.com y cómo la cuenta de negocio quedó conectada (paso 2 "Generar tokens de acceso").

Que quede claro que el permiso se usa para **responder DMs en tu propia cuenta de negocio**.

### 5. Instrucciones para el revisor (si las pide)

```
Our app automatically replies to Direct Messages received on our own business
account, @floridaaventura. The attached screen recording demonstrates the full
flow: a user sends a DM asking about a car rental and receives an automated reply
from our assistant with available vehicles and prices.
```

### 6. Enviar y esperar
Enviás la solicitud → Meta revisa (suele tardar **unos días a 1–2 semanas**). Te avisan por email y en **"Acciones requeridas"** del dashboard.

---

## Después de la aprobación
- El bot le responde a **cualquier cliente** que escriba al Instagram de Florida, en el horario 23–07.
- **No hay que tocar nada en el código** — es solo el permiso de Meta.

## Si algo se rechaza
Meta te dice el motivo. Lo más común: el video no muestra bien el flujo, o falta la Business Verification. Se corrige y se reenvía — no hay límite de reintentos.
