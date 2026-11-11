// Al arrancar, server.js loguea con qué modelo y effort va a contestar, para
// poder confirmarlo en los logs de Railway sin mirar las variables. Sin secretos.
//   npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function arrancar(t, envExtra) {
  const PORT = 4100 + Math.floor(Math.random() * 800);
  const env = {
    ...process.env, PORT: String(PORT), DOTENV_CONFIG_PATH: '/dev/null',
    IG_APP_SECRET: '', IG_ACCESS_TOKEN: 'test', IG_GRAPH_BASE: 'http://localhost:9', IG_TOKEN_REFRESH: 'false',
    IG_RESCUE_ENABLED: 'false', ANTHROPIC_API_KEY: 'sk-ant-secreto-de-prueba', SLACK_WEBHOOK_URL: '', RAILWAY_API_TOKEN: '',
    ...envExtra,
  };
  for (const k of ['BOT_MODEL', 'BOT_EFFORT']) if (!(k in envExtra)) delete env[k];
  const srv = spawn(process.execPath, ['server.js'], { cwd: RAIZ, env });
  t.after(() => srv.kill());
  let log = '';
  srv.stdout.on('data', (d) => { log += d; });
  srv.stderr.on('data', (d) => { log += d; });
  const fin = Date.now() + 5000;
  while (!log.includes('[bot] Modelo')) {
    if (Date.now() > fin) throw new Error(`timeout. Log:\n${log}`);
    await dormir(25);
  }
  return log;
}

test('loguea el modelo y el effort de BOT_MODEL / BOT_EFFORT', async (t) => {
  const log = await arrancar(t, { BOT_MODEL: 'claude-opus-5-5', BOT_EFFORT: 'medium' });
  assert.ok(log.includes('[bot] Modelo claude-opus-5-5 | effort medium'));
  assert.ok(!log.includes('sk-ant-secreto-de-prueba'), 'no loguea la key');
});

test('sin variables loguea los defaults', async (t) => {
  const log = await arrancar(t, {});
  assert.match(log, /\[bot\] Modelo claude-sonnet-5 \| effort high/);
});
