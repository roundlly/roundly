// Phase 2 analysis: for each duplicated function family, extract all 4 game
// copies, normalize away game-specific identifiers, and report whether they are
// IDENTICAL (safe to merge into one shared helper) or DIVERGED (must not blindly
// merge — would change behavior). Pure analysis: writes nothing, changes nothing.
const fs = require('fs');

const FILES = ['app-01-core-hotseat.js','app-06-chameleon.js','app-07-liar.js','app-08-mafia.js','app-09-shared-sheets-liar-cup.js'];
const SRC = Object.fromEntries(FILES.map(f => [f, fs.readFileSync(f, 'utf8').replace(/\r\n/g,'\n').split('\n')]));

const GAMES = {
  hot:   { state: 'state',      me: 'hotMe' },
  cham:  { state: 'chamState',  me: 'chamMe' },
  liar:  { state: 'cardLobbyState',  me: 'cardLobbyMe' },
  mafia: { state: 'mafiaState', me: 'mafiaMe' },
};
const FAMILIES = ['WireSync','SyncUrlToRoom','StateReset','StartLeaveGrace','ResetPresenceState',
  'ResetPlayers','Rerender','ReadUrlRoom','LoadRoom','LeaveRoom','JoinUrl','GetSessionId',
  'FindRecentRoomCode','ConfirmUserGone','CancelLeaveGrace','Bootstrap','AutoClaimIfNeeded'];

// Extract a top-level function body: from the line containing `function <name>`
// to the next line that is exactly 4-space `}` (top-level close).
function extract(name) {
  for (const f of FILES) {
    const lines = SRC[f];
    for (let i = 0; i < lines.length; i++) {
      if (new RegExp(`\\bfunction ${name}\\b`).test(lines[i])) {
        for (let j = i; j < lines.length; j++) {
          if (j > i && lines[j] === '    }') return { file: f, body: lines.slice(i, j + 1).join('\n') };
        }
      }
    }
  }
  return null;
}

// Normalize game-specific tokens to canonical placeholders.
function norm(body, g) {
  const { state, me } = GAMES[g];
  return body
    .replace(new RegExp(`\\b${state}\\b`, 'g'), 'STATE')
    .replace(new RegExp(`\\b${me}\\b`, 'g'), 'ME')
    .replace(new RegExp(`\\b${g}([A-Z])`, 'g'), '$1')      // strip prefix on calls: hotPersist -> Persist
    .replace(new RegExp(`_${g}`, 'g'), '_G')               // private vars: _hotChannel -> _GChannel
    .replace(/[a-z]+_rooms/g, 'TROOMS')                    // table names
    .replace(/'[a-z]+-room-[^']*'/g, 'CHAN')               // channel name strings
    .replace(/\s+/g, ' ').trim();                          // ignore whitespace diffs
}

let identical = [], diverged = [], partial = [];
for (const F of FAMILIES) {
  const copies = {};
  for (const g of Object.keys(GAMES)) {
    const r = extract(g + F);
    if (r) copies[g] = norm(r.body, g);
  }
  const present = Object.keys(copies);
  if (present.length < 2) { partial.push(`${F} (only ${present.length} copy: ${present})`); continue; }
  const set = new Set(Object.values(copies));
  if (set.size === 1) identical.push(`${F} (${present.length} copies)`);
  else diverged.push(`${F} (${present.length} copies, ${set.size} distinct)`);
}

console.log('\n=== IDENTICAL (safe to merge into one shared helper) ===');
identical.forEach(x => console.log('  ' + x));
console.log('\n=== DIVERGED (NOT safe to blindly merge — would change behavior) ===');
diverged.forEach(x => console.log('  ' + x));
console.log('\n=== PARTIAL / not 4 copies ===');
partial.forEach(x => console.log('  ' + x));
console.log(`\nsummary: ${identical.length} identical, ${diverged.length} diverged, ${partial.length} partial`);
