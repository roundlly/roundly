// Turkish voiceover for the Mafia how-to video.
// Voice: Doga - Upbeat and Rich (IuRRIAcbQK5AQk1XevPj)
//   — 270K clones on ElevenLabs (the most-used Turkish voice in the library).
//   — Istanbul accent, broadcast quality, middle-aged male.
//
// Translation notes:
//   - Vocabulary mirrors the existing app TR strings (Mafya, Köylü, Anlatıcı,
//     Dedektif, Doktor) so it feels native to a returning Huddle player.
//   - "Have fun" → "İyi eğlenceler" (idiomatic Turkish farewell), not the
//     command form "Eğlen" which would feel curt.
//   - "Try to spot the lie" → "Yalanı yakalamaya çalış" (informal "sen"
//     command form — matches the friendly, conversational tone of the EN
//     voiceover rather than the formal "siz" plural).
//
// Run: node tools/generate_howto_voiceover_tr.js
// Output: assets/howto/mafia-tr.mp3 + mafia-tr.alignment.json

const fs = require('fs');
const path = require('path');
const https = require('https');

const env = Object.fromEntries(
  fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8')
    .split(/\r?\n/).filter(Boolean)
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const API_KEY = env.ELEVENLABS_API_KEY;
// Voice selection. The native-Turkish "Doga" voice (IuRRIAcbQK5AQk1XevPj) is a
// community/library voice that requires ElevenLabs Creator tier or above —
// a free-tier key returns HTTP 400 "free_users_not_allowed". So we default to
// George (JBFqnCBsd6RMkjVDRZzb), the SAME premade voice used by the English
// video, which free tier can use and eleven_multilingual_v2 reads in Turkish
// (mild non-native accent). To use Doga after upgrading, set HOWTO_VOICE_ID in
// .env (or flip the default below) and re-run — the alignment + scene cues
// regenerate automatically.
const DOGA_VOICE_ID = 'IuRRIAcbQK5AQk1XevPj';   // native Turkish, Creator tier+
const GEORGE_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb'; // free-tier premade (EN video voice)
const VOICE_ID = env.HOWTO_VOICE_ID || GEORGE_VOICE_ID;

const SCENES = [
  { id: 1, text: "Mafya, gizli rollü bir parti oyunudur. Beş arkadaşını bir araya getir ve aranızdan birini anlatıcı seç — o oyunu yönetir ama oynamaz." },
  { id: 2, text: "Uygulama her oyuncuya gizlice bir rol verir. Çoğu Köylüdür. Birkaçı Mafyadır ve gizlice öldürürler. Hayat kurtaran bir Doktor ve araştırma yapan bir Dedektif vardır." },
  { id: 3, text: "Gece olur, herkes gözlerini kapatır. Anlatıcı her rolü tek tek uyandırır. Mafya sessizce kimi öldüreceğini seçer. Doktor kimi koruyacağını seçer. Dedektif birini gösterir — eğer o kişi Mafyaysa anlatıcı sessizce baş parmağını yukarı kaldırır." },
  { id: 4, text: "Sabah olur ve anlatıcı kimin öldüğünü duyurur. Kasaba konuşur. Yalanı yakalamaya çalış." },
  { id: 5, text: "Sonra herkes oy verir. En çok oy alan oyuncu elenir. Eğer Mafyaysa, kasaba zafere bir adım daha yaklaşır." },
  { id: 6, text: "Tüm Mafya yakalanırsa kasaba kazanır. Mafya sayıca üstün gelirse Mafya kazanır. Kimseye güvenme. İyi blöf yap. İyi eğlenceler." },
];
const BREAK = '<break time="0.7s"/>';
const FULL_TEXT = SCENES.map(s => s.text).join(' ' + BREAK + ' ');

const outDir = path.join(__dirname, '..', 'assets', 'howto');
fs.mkdirSync(outDir, { recursive: true });

function tts() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      text: FULL_TEXT,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.55, similarity_boost: 0.75, style: 0.15, use_speaker_boost: true },
    });
    const req = https.request({
      hostname: 'api.elevenlabs.io',
      path: `/v1/text-to-speech/${VOICE_ID}/with-timestamps`,
      method: 'POST',
      headers: { 'xi-api-key': API_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0,500)}`));
        try { resolve(JSON.parse(data)); } catch(e) { reject(new Error('Bad JSON: ' + data.slice(0,200))); }
      });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

(async () => {
  console.log('Generating Turkish voiceover (Doga) with per-character timestamps…');
  const result = await tts();
  if (!result.audio_base64) throw new Error('No audio in response');
  const mp3Buf = Buffer.from(result.audio_base64, 'base64');
  fs.writeFileSync(path.join(outDir, 'mafia-tr.mp3'), mp3Buf);
  console.log(`  audio → mafia-tr.mp3 (${Math.round(mp3Buf.length/1024)}KB)`);

  const align = result.alignment;
  if (align?.characters) {
    const sceneCues = [];
    let cursor = 0;
    const built = align.characters.join('');
    for (const scene of SCENES) {
      const idx = built.indexOf(scene.text, cursor);
      if (idx >= 0) {
        sceneCues.push({ scene: scene.id, startSec: align.character_start_times_seconds[idx], text: scene.text });
        cursor = idx + scene.text.length;
      } else {
        sceneCues.push({ scene: scene.id, startSec: null, text: scene.text, note: 'no exact match' });
      }
    }
    const out = {
      voice: VOICE_ID === DOGA_VOICE_ID ? 'Doga - Upbeat and Rich (TR native)'
           : VOICE_ID === GEORGE_VOICE_ID ? 'George (premade, multilingual TR)'
           : VOICE_ID,
      voice_id: VOICE_ID,
      total_duration_sec: align.character_end_times_seconds[align.character_end_times_seconds.length - 1],
      sceneCues,
    };
    fs.writeFileSync(path.join(outDir, 'mafia-tr.alignment.json'), JSON.stringify(out, null, 2));
    console.log(`  alignment → mafia-tr.alignment.json`);
    console.log(`  total duration: ${out.total_duration_sec.toFixed(2)}s`);
    console.log('  scene cues:');
    sceneCues.forEach(c => console.log(`    Scene ${c.scene}: starts at ${c.startSec?.toFixed(2)}s`));
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
