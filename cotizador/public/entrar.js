const form = document.getElementById('form-entrar');
const error = document.getElementById('error-entrar');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  error.hidden = true;
  const boton = form.querySelector('button');
  boton.disabled = true;
  try {
    const res = await fetch('/api/entrar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clave: document.getElementById('clave').value }),
    });
    if (res.ok) { window.location.href = '/'; return; }
    const data = await res.json().catch(() => ({}));
    error.textContent = data.error || 'No se pudo entrar.';
  } catch {
    error.textContent = 'No hay conexión. Probá de nuevo.';
  }
  error.hidden = false;
  boton.disabled = false;
});
