// Read-only, bounded observation of this World. Never reads Persona Memory or credentials.
import { writeFile } from 'node:fs/promises';
const base = 'http://127.0.0.1:17788';
const rows = [];
let last = '';
const duration = Number(process.argv[2] ?? 1500) * 1000;
const end = Date.now() + duration;
while (Date.now() < end) {
  try {
    const r = await fetch(`${base}/api/webui/providers/world%3Abookfish/panels/status/get`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"args":[]}', signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { status: s } = await r.json();
    const row = { lifecycle: s.lifecycle, mode: s.selectedMode, cognition: s.cognition,
      paused: s.library.paused, confirmedSegments: s.library.current?.confirmedSegments ?? 0,
      confirmedChars: s.library.current?.confirmedChars ?? 0, providedChars: s.library.providedChars,
      ...s.scheduler };
    const signature = JSON.stringify(row);
    if (signature !== last) {
      last = signature; const record = { at: new Date().toISOString(), ...row }; rows.push(record);
      await writeFile('output/live-stage4-observations.json', JSON.stringify(rows, null, 2));
      console.log(JSON.stringify(record));
    }
    if (row.confirmedSegments >= 2 && row.reason === 'daily_budget') break;
  } catch (e) { console.log(JSON.stringify({ at: new Date().toISOString(), monitorError: String(e) })); }
  await new Promise(resolve => setTimeout(resolve, 5000));
}
console.log(JSON.stringify({ observationEnded: new Date().toISOString(), changes: rows.length }));
