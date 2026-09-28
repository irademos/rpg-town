// Panel Attack — persistent player stats + global leaderboard (Firebase RTDB)
//
// Data layout:
//   panelattack/players/{uid} = {
//     name,                 // latest name the player entered (null if never)
//     updatedAt,
//     bot: {
//       easy|medium|hard|extreme: { wins, losses, bestTimeMs, fastestWinMs }
//     },
//     pvp: { wins, losses }
//   }
import { ref, update, onValue, runTransaction } from 'firebase/database';

export const DIFFICULTIES = ['easy', 'medium', 'hard', 'extreme'];

const UID_KEY = 'panelattack_uid';

// Stable per-browser player id, so stats survive reloads and lobby rejoins.
export function getPlayerUid() {
  let uid = null;
  try { uid = localStorage.getItem(UID_KEY); } catch {}
  if (!uid) {
    uid = 'p' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    try { localStorage.setItem(UID_KEY, uid); } catch {}
  }
  return uid;
}

export function displayName(uid, name) {
  return name || `Player #${uid.slice(-4).toUpperCase()}`;
}

export function formatDuration(ms) {
  if (!ms) return '0:00';
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function playerRef(db, uid) {
  return ref(db, `panelattack/players/${uid}`);
}

// Remember the latest name the player entered.
export function saveName(db, uid, name) {
  if (!name) return Promise.resolve();
  return update(playerRef(db, uid), { name, updatedAt: Date.now() }).catch(err => {
    console.warn('[panelattack] failed to save name', err);
  });
}

// Records a finished bot match. Resolves to a summary of what improved, for the
// game-over screen: { firstWin, newFastest, newBest }.
export async function recordBotResult(db, uid, name, difficulty, won, elapsedMs) {
  if (!DIFFICULTIES.includes(difficulty)) return {};
  const summary = { firstWin: false, newFastest: false, newBest: false };
  try {
    await runTransaction(playerRef(db, uid), cur => {
      const p = cur || {};
      if (name) p.name = name;
      p.updatedAt = Date.now();
      p.bot = p.bot || {};
      const d = p.bot[difficulty] || { wins: 0, losses: 0, bestTimeMs: 0, fastestWinMs: 0 };
      summary.firstWin = summary.newFastest = summary.newBest = false;
      if (won) {
        summary.firstWin = !d.wins;
        d.wins = (d.wins || 0) + 1;
        if (!d.fastestWinMs || elapsedMs < d.fastestWinMs) {
          summary.newFastest = !summary.firstWin;
          d.fastestWinMs = elapsedMs;
        }
      } else {
        d.losses = (d.losses || 0) + 1;
      }
      if (elapsedMs > (d.bestTimeMs || 0)) {
        summary.newBest = !won && (d.bestTimeMs || 0) > 0;
        d.bestTimeMs = elapsedMs;
      }
      p.bot[difficulty] = d;
      return p;
    });
  } catch (err) {
    console.warn('[panelattack] failed to record bot result', err);
  }
  return summary;
}

export async function recordPvpResult(db, uid, name, won) {
  try {
    await runTransaction(playerRef(db, uid), cur => {
      const p = cur || {};
      if (name) p.name = name;
      p.updatedAt = Date.now();
      p.pvp = p.pvp || { wins: 0, losses: 0 };
      if (won) p.pvp.wins = (p.pvp.wins || 0) + 1;
      else p.pvp.losses = (p.pvp.losses || 0) + 1;
      return p;
    });
  } catch (err) {
    console.warn('[panelattack] failed to record pvp result', err);
  }
}

// ── Leaderboard ranking ─────────────────────────────────────────
function highestBeaten(p) {
  for (let i = DIFFICULTIES.length - 1; i >= 0; i--) {
    if (p.bot?.[DIFFICULTIES[i]]?.wins > 0) return i;
  }
  return -1;
}

// Longest survival on the easiest difficulty not yet beaten — the "next challenge".
function nextChallengeBest(p) {
  const next = DIFFICULTIES[highestBeaten(p) + 1];
  return next ? (p.bot?.[next]?.bestTimeMs || 0) : 0;
}

function compareEntries(a, b) {
  return (highestBeaten(b.p) - highestBeaten(a.p))
    || ((b.p.pvp?.wins || 0) - (a.p.pvp?.wins || 0))
    || (nextChallengeBest(b.p) - nextChallengeBest(a.p))
    || ((a.p.pvp?.losses || 0) - (b.p.pvp?.losses || 0));
}

function hasPlayed(p) {
  if (p.pvp && (p.pvp.wins || p.pvp.losses)) return true;
  return DIFFICULTIES.some(d => p.bot?.[d] && (p.bot[d].wins || p.bot[d].losses));
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function difficultyCell(d) {
  if (!d || (!d.wins && !d.losses)) return '<td class="lb-none">—</td>';
  if (d.wins > 0) {
    return `<td class="lb-beaten" title="Beaten ${d.wins}× · fastest win ${formatDuration(d.fastestWinMs)}">✓ ${formatDuration(d.fastestWinMs)}</td>`;
  }
  return `<td class="lb-survived" title="Not beaten yet · longest game ${formatDuration(d.bestTimeMs)}">${formatDuration(d.bestTimeMs)}</td>`;
}

const LEADERBOARD_LIMIT = 50;

// Live-render the leaderboard table and the current player's stats summary.
export function watchLeaderboard(db, uid, { tableBody, myStatsEl, onError }) {
  return onValue(
    ref(db, 'panelattack/players'),
    snap => {
      const all = snap.val() || {};
      const entries = Object.entries(all)
        .filter(([, p]) => p && hasPlayed(p))
        .map(([id, p]) => ({ id, p }))
        .sort(compareEntries);

      if (entries.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="7" class="lb-empty">No games recorded yet — be the first!</td></tr>';
      } else {
        tableBody.innerHTML = entries.slice(0, LEADERBOARD_LIMIT).map(({ id, p }, i) => {
          const pvp = p.pvp || {};
          return `<tr class="${id === uid ? 'lb-me' : ''}">
            <td class="lb-rank">${i + 1}</td>
            <td class="lb-name">${escHtml(displayName(id, p.name))}${id === uid ? ' (you)' : ''}</td>
            ${DIFFICULTIES.map(d => difficultyCell(p.bot?.[d])).join('')}
            <td class="lb-pvp">${pvp.wins || 0}-${pvp.losses || 0}</td>
          </tr>`;
        }).join('');
      }

      if (myStatsEl) {
        const me = all[uid];
        const myRank = entries.findIndex(e => e.id === uid);
        if (!me || !hasPlayed(me)) {
          myStatsEl.textContent = 'Play a match to get on the leaderboard!';
        } else {
          const beaten = DIFFICULTIES.filter(d => me.bot?.[d]?.wins > 0).map(d => d.toUpperCase());
          const pvp = me.pvp || {};
          myStatsEl.innerHTML =
            `<span>RANK <b>#${myRank + 1}</b></span>` +
            `<span>BOTS BEATEN <b>${beaten.length ? escHtml(beaten.join(' · ')) : 'NONE'}</b></span>` +
            `<span>ONLINE <b>${pvp.wins || 0}W ${pvp.losses || 0}L</b></span>`;
        }
      }
    },
    err => onError?.(err)
  );
}
