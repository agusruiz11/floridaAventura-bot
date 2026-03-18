import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getLatestResultsFile() {
  const dir = join(__dirname, 'results');
  const files = readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort();
  if (files.length === 0) {
    throw new Error('No hay archivos en eval/results/. Corré primero: node eval/run-eval.js');
  }
  return join(dir, files[files.length - 1]);
}

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

function colorResult(result) {
  if (result === 'PASS') return '\x1b[32mPASS\x1b[0m';
  if (result === 'FAIL') return '\x1b[31mFAIL\x1b[0m';
  return '\x1b[33mREVIEW\x1b[0m';
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const filePath = getLatestResultsFile();
  const data = JSON.parse(readFileSync(filePath, 'utf-8'));

  const pendientes = data.casos.filter(c => c.pass_manual === null);

  if (pendientes.length === 0) {
    console.log('\nNo hay casos pendientes de revisión manual.\n');
    printSummary(data);
    process.exit(0);
  }

  console.log(`\nRevisión manual — ${pendientes.length} caso(s) pendiente(s)`);
  console.log(`Archivo: ${filePath}\n`);
  console.log('Comandos: [s] PASS  [n] FAIL  [Enter] saltar  [q] salir\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  for (const caso of pendientes) {
    console.log(`\n${'─'.repeat(65)}`);
    console.log(`ID: \x1b[1m${caso.id}\x1b[0m | ${caso.categoria}`);
    console.log(`INPUT: "${caso.input}"`);
    console.log(`\nRESPUESTA DEL BOT:\n${caso.respuesta}`);
    console.log(`\nAUTO RESULT: ${colorResult(caso.auto_result)}`);

    if (caso.keywords_pass_encontradas.length > 0) {
      console.log(`  ✅ Pass keywords encontradas: ${caso.keywords_pass_encontradas.join(', ')}`);
    } else {
      console.log(`  ⚪ Ninguna keyword_pass encontrada`);
    }
    if (caso.keywords_fail_encontradas.length > 0) {
      console.log(`  ❌ Fail keywords encontradas: ${caso.keywords_fail_encontradas.join(', ')}`);
    }

    const respuesta = await ask(rl, '\n¿Pasó? [s/n/Enter para saltar/q para salir]: ');

    if (respuesta.toLowerCase() === 'q') {
      console.log('\nSaliendo de la revisión. Progreso guardado.');
      rl.close();
      writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
      printSummary(data);
      return;
    }

    const idx = data.casos.findIndex(c => c.id === caso.id);

    if (respuesta.toLowerCase() === 's') {
      data.casos[idx].pass_manual = true;
      const nota = await ask(rl, 'Nota (opcional, Enter para saltar): ');
      if (nota.trim()) data.casos[idx].notas = nota.trim();
      console.log('  → Marcado como PASS');
    } else if (respuesta.toLowerCase() === 'n') {
      data.casos[idx].pass_manual = false;
      const nota = await ask(rl, 'Nota (opcional, Enter para saltar): ');
      if (nota.trim()) data.casos[idx].notas = nota.trim();
      console.log('  → Marcado como FAIL');
    } else if (respuesta.trim() === '') {
      console.log('  → Saltado');
    } else {
      // Cualquier otro texto se guarda como nota
      data.casos[idx].notas = respuesta.trim();
      console.log('  → Guardado como nota (pass_manual sigue pendiente)');
    }

    writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  rl.close();
  console.log('\nRevisión completada.');
  printSummary(data);
}

function printSummary(data) {
  const total = data.casos.length;
  const autoPass = data.casos.filter(c => c.auto_result === 'PASS').length;
  const autoFail = data.casos.filter(c => c.auto_result === 'FAIL').length;
  const autoReview = data.casos.filter(c => c.auto_result === 'REVIEW').length;
  const manualPass = data.casos.filter(c => c.pass_manual === true).length;
  const manualFail = data.casos.filter(c => c.pass_manual === false).length;
  const pendiente = data.casos.filter(c => c.pass_manual === null).length;

  console.log('\n── RESUMEN ──────────────────────────────────────────────');
  console.log(`Auto:   PASS ${autoPass} | FAIL ${autoFail} | REVIEW ${autoReview} (de ${total})`);
  console.log(`Manual: PASS ${manualPass} | FAIL ${manualFail} | Pendiente ${pendiente}`);

  const failCases = data.casos.filter(c => c.pass_manual === false || (c.pass_manual === null && c.auto_result === 'FAIL'));
  if (failCases.length > 0) {
    console.log('\nCasos con FAIL:');
    for (const c of failCases) {
      const label = c.pass_manual === false ? 'manual FAIL' : 'auto FAIL';
      const nota = c.notas ? ` — ${c.notas}` : '';
      console.log(`  ${c.id}: ${c.input.slice(0, 50)}... [${label}]${nota}`);
    }
  }
  console.log('');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
