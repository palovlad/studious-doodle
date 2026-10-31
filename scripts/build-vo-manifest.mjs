// Składa public/audio/vo/manifest.json z listy kwestii (scripts/voice-lines.json)
// i wygenerowanych plików MP3 (czas trwania z ffprobe). Brak pliku = błąd.
// Użycie: node scripts/build-vo-manifest.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const spec = JSON.parse(readFileSync('scripts/voice-lines.json', 'utf8'));
const dir = 'public/audio/vo';
const missing = [];
const lines = spec.lines.map((l) => {
  const file = `${l.id}.mp3`;
  const path = `${dir}/${file}`;
  if (!existsSync(path)) {
    missing.push(file);
    return null;
  }
  const duration = Number(
    execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path])
      .toString()
      .trim(),
  );
  const role = spec.roles[l.role];
  return {
    id: l.id,
    file,
    text: l.text,
    category: l.category,
    trigger: l.trigger ?? null,
    phase: l.phase ?? null,
    role: l.role,
    voice: role.voice,
    duration: Math.round(duration * 100) / 100,
  };
});
if (missing.length) {
  console.error('Brak plików:', missing.join(', '));
  process.exit(1);
}
writeFileSync(`${dir}/manifest.json`, JSON.stringify({ model: spec.model, lines }, null, 2) + '\n');
console.log(`manifest: ${lines.length} kwestii, łącznie ${lines.reduce((a, l) => a + l.duration, 0).toFixed(1)} s`);
