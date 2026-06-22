const v = JSON.parse(require('fs').readFileSync('tmp/tr_voices.json', 'utf8'));
const rows = v.voices.map(x => ({
  name: x.name,
  id: x.voice_id,
  cloned: x.cloned_by_count || 0,
  gender: x.gender || '?',
  age: x.age || '?',
  accent: x.accent || '?',
  use: x.use_case || '?',
  descriptive: x.descriptive || '?',
  langs: (x.verified_languages || []).map(l => l.language).join(','),
  description: (x.description || '').slice(0, 90),
}));
console.log('Top Turkish-language voices in ElevenLabs shared library (sorted by clone count = popularity):\n');
rows.forEach((r, i) => {
  console.log(`${String(i+1).padStart(2)}. ${r.name.padEnd(28)} | ${r.gender.padEnd(6)} | ${r.age.padEnd(10)} | clones: ${String(r.cloned).padStart(6)} | use: ${r.use.padEnd(20)} | langs: ${r.langs}`);
  if (r.description) console.log(`    "${r.description}"`);
});
