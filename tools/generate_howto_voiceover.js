// Generates the FINAL English voiceover for the Mafia how-to video.
// Voice: George (JBFqnCBsd6RMkjVDRZzb). Uses break tags between scenes
// so the visuals can sync to a natural pause cue between beats.
//
// Run: node tools/generate_howto_voiceover.js
// Output: assets/howto/mafia-en.mp3  +  mafia-en.alignment.json (per-character timing)

const fs = require('fs');
const path = require('path');
const https = require('https');

const env = Object.fromEntries(
  fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8')
    .split(/\r?\n/).filter(Boolean)
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const API_KEY = env.ELEVENLABS_API_KEY;
const VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb'; // George

// The 6 scenes. Each starts on a clean sentence boundary so we can split
// the audio at break points for scene-by-scene visual sync. The breaks are
// inserted as actual silence in the audio via the <break> tag.
const SCENES = [
  { id: 1, text: "Mafia is a hidden-roles party game. Get five friends together, pick one person to be the narrator — they run the game but don't play." },
  { id: 2, text: "The app secretly gives each player a role. Most are Villagers. A few are Mafia — they kill in secret. There's a Doctor who saves lives, and a Detective who investigates." },
  { id: 3, text: "At night, everyone closes their eyes. The narrator calls each role awake one at a time. Mafia silently choose who to kill. Doctor chooses who to save. Detective points at someone — and the narrator gives a quiet thumbs-up if they're Mafia." },
  { id: 4, text: "In the morning, the narrator announces who died. The town talks. Try to spot the lie." },
  { id: 5, text: "Then everyone votes. The most-voted player is eliminated. If they were Mafia, the town gets closer to winning." },
  { id: 6, text: "Town wins if every Mafia is caught. Mafia win if they outnumber the town. Trust no one. Bluff well. Have fun." },
];
const BREAK = '<break time="0.7s"/>';
const FULL_TEXT = SCENES.map(s => s.text).join(' ' + BREAK + ' ');

const outDir = path.join(__dirname, '..', 'assets', 'howto');
fs.mkdirSync(outDir, { recursive: true });

function ttsWithTimestamps() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      text: FULL_TEXT,
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        stability: 0.55,        // a touch more stable for a long-form narration
        similarity_boost: 0.75,
        style: 0.15,            // a hint of expressiveness, not over the top
        use_speaker_boost: true,
      },
    });
    const req = https.request({
      hostname: 'api.elevenlabs.io',
      // /with-timestamps returns JSON with base64 audio + per-character alignment
      path: `/v1/text-to-speech/${VOICE_ID}/with-timestamps`,
      method: 'POST',
      headers: {
        'xi-api-key': API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 500)}`));
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (e) {
          reject(new Error('Bad JSON: ' + data.slice(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  console.log('Generating voiceover (George, ~85s) with per-character timestamps…');
  const result = await ttsWithTimestamps();
  if (!result.audio_base64) throw new Error('No audio in response');
  const mp3Buf = Buffer.from(result.audio_base64, 'base64');
  const mp3Path = path.join(outDir, 'mafia-en.mp3');
  fs.writeFileSync(mp3Path, mp3Buf);
  console.log(`  audio → ${mp3Path} (${Math.round(mp3Buf.length / 1024)}KB)`);

  // alignment shape: { characters: string[], character_start_times_seconds: number[], character_end_times_seconds: number[] }
  const align = result.alignment;
  if (align && Array.isArray(align.characters)) {
    // Reduce to scene-level cue points by finding each scene's first character
    // index in the rebuilt string, then reading the start time for that char.
    const sceneCues = [];
    let cursor = 0;
    for (const scene of SCENES) {
      // Each scene's text appears verbatim in FULL_TEXT (BREAK tags get stripped
      // from the spoken text — they only affect silence). Search starting at cursor.
      const needle = scene.text;
      const built = align.characters.join('');
      const idx = built.indexOf(needle, cursor);
      if (idx >= 0) {
        const startT = align.character_start_times_seconds[idx];
        sceneCues.push({ scene: scene.id, startSec: startT, text: scene.text });
        cursor = idx + needle.length;
      } else {
        sceneCues.push({ scene: scene.id, startSec: null, text: scene.text, note: 'no exact match' });
      }
    }
    const alignmentOut = {
      voice: 'George',
      voice_id: VOICE_ID,
      total_chars: align.characters.length,
      total_duration_sec: align.character_end_times_seconds[align.character_end_times_seconds.length - 1],
      sceneCues,
    };
    fs.writeFileSync(path.join(outDir, 'mafia-en.alignment.json'), JSON.stringify(alignmentOut, null, 2));
    console.log(`  alignment → mafia-en.alignment.json`);
    console.log(`  total duration: ${alignmentOut.total_duration_sec.toFixed(2)}s`);
    console.log('  scene cues:');
    sceneCues.forEach(c => console.log(`    Scene ${c.scene}: starts at ${c.startSec?.toFixed(2)}s`));
  } else {
    console.log('  (no alignment data returned — visuals will use estimated timing)');
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
