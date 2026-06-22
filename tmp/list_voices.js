const v = JSON.parse(require('fs').readFileSync('tmp/voices.json','utf8'));
const rows = v.voices.map(x => ({
  name: x.name.split(' - ')[0],
  id: x.voice_id,
  gender: x.labels?.gender || '?',
  age: x.labels?.age || '?',
  accent: x.labels?.accent || '?',
  use: x.labels?.use_case || '?',
  desc_label: x.labels?.descriptive || '?',
  blurb: (x.description || '').slice(0, 90)
}));
console.log('Voices available (n=' + rows.length + '):\n');
rows.forEach(r => {
  console.log(`${r.name.padEnd(13)} | ${r.gender.padEnd(7)} | ${r.age.padEnd(13)} | ${r.accent.padEnd(11)} | ${r.use.padEnd(22)} | ${r.desc_label.padEnd(15)} | ${r.blurb}`);
});
