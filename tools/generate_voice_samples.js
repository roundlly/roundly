// Generates one ~12-second MP3 per voice candidate so the user can audition
// them side-by-side in the voice-lab UI. Uses the same script chunk across
// all voices for a fair comparison.
//
// Run: node tools/generate_voice_samples.js
// Requires .env at repo root with ELEVENLABS_API_KEY

const fs = require('fs');
const path = require('path');
const https = require('https');

// Load .env manually (no dotenv dep)
const envPath = path.join(__dirname, '..', '.env');
const envText = fs.readFileSync(envPath, 'utf8');
const env = Object.fromEntries(envText.split(/\r?\n/).filter(Boolean).map(l => {
  const i = l.indexOf('=');
  return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
}));
const API_KEY = env.ELEVENLABS_API_KEY;
if (!API_KEY) { console.error('ELEVENLABS_API_KEY missing in .env'); process.exit(1); }

// Hand-picked from the ElevenLabs library based on the actual labels
// (informative_educational / narrative_story use-cases). Variety: gender,
// accent, age, tone — so the user has REAL choices to compare.
const VOICES = [
  { slug: 'george',  name: 'George',  id: 'JBFqnCBsd6RMkjVDRZzb', why: 'British male · warm narrator · captivating tone' },
  { slug: 'daniel',  name: 'Daniel',  id: 'onwK4e9ZLuTAKqWW03F9', why: 'British male · formal broadcast · authoritative mystery' },
  { slug: 'brian',   name: 'Brian',   id: 'nPczCjzI2devNBz1zQrb', why: 'American male · resonant + comforting · classic narrator' },
  { slug: 'matilda', name: 'Matilda', id: 'XrExE9yKIg1WjnnlVkGX', why: 'American female · upbeat educational · clear and friendly' },
  { slug: 'alice',   name: 'Alice',   id: 'Xb7hH8MSUJpSbSDYk0k2', why: 'British female · clear and engaging · e-learning polished' },
  { slug: 'bella',   name: 'Bella',   id: 'EXAVITQu4vr4xnSDxMaL', why: 'American female · warm and bright · professional explainer' },
];

// Short sample of the full script — same line per voice so user compares apples-to-apples.
const SAMPLE_TEXT = "Mafia is a hidden-roles party game. Get five friends together, pick one person to narrate, and try to spot the killer hiding among you.";

const outDir = path.join(__dirname, '..', 'assets', 'voice-samples');
fs.mkdirSync(outDir, { recursive: true });

function tts(voiceId, outFile) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      text: SAMPLE_TEXT,
      model_id: 'eleven_multilingual_v2',  // supports EN + TR with same voice
      voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true },
    });
    const req = https.request({
      hostname: 'api.elevenlabs.io',
      path: `/v1/text-to-speech/${voiceId}`,
      method: 'POST',
      headers: {
        'xi-api-key': API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
    }, res => {
      if (res.statusCode !== 200) {
        let err = '';
        res.on('data', c => err += c);
        res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${err}`)));
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        fs.writeFileSync(outFile, buf);
        resolve({ bytes: buf.length });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  const manifest = [];
  for (const v of VOICES) {
    const out = path.join(outDir, `${v.slug}.mp3`);
    process.stdout.write(`→ ${v.name.padEnd(8)} (${v.id})  ... `);
    try {
      const { bytes } = await tts(v.id, out);
      console.log(`OK (${Math.round(bytes / 1024)}KB)`);
      manifest.push({ ...v, file: `assets/voice-samples/${v.slug}.mp3`, bytes });
    } catch (e) {
      console.log('FAILED →', e.message);
    }
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\nDone. ${manifest.length}/${VOICES.length} samples generated.`);
})();
