// Panel Attack — lobby + puzzle battle game
import { initializeApp } from 'firebase/app';
import {
  getDatabase,
  ref,
  set,
  remove,
  onValue,
  onDisconnect,
  push,
  get,
  serverTimestamp
} from 'firebase/database';

// ── Firebase init ─────────────────────────────────────────────
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};

const app = initializeApp(firebaseConfig, 'panelattack');
const db = getDatabase(app);

// ── Constants ─────────────────────────────────────────────────
const COLS = 6;
const ROWS = 12;
const CELL = 32;
const SYMBOLS = ['★', '●', '▲', '♦', '✿', '♠'];
const EMOJI_SYMBOLS = ['🐱', '🐶', '🐸', '🦊', '🐼', '🐨'];
const COLORS = ['#ef4444', '#22c55e', '#3b82f6', '#f59e0b', '#a855f7', '#ec4899'];
const JUNK_COLOR = '#44403c';
const JUNK_BORDER = '#78716c';
const BG_COLOR = '#0a0a1a';
const GRID_COLOR = '#12122a';
const CURSOR_COLOR = '#06b6d4';
const TICK_MS = 80;
// Frame values converted from 60 FPS: divide by 4.8 (80ms tick = 4.8 frames)
const CLEAR_TICKS = 10;           // 49 frames total (36 flash + 13 face)
const POP_STAGGER_TICKS = 2;      // 8 frames between pops
const HOVER_TICKS = 2;            // 9 frames hover after support removed
const STOP_COMBO_TICKS = 25;      // 120 frames stop time for normal combo
const STOP_CHAIN_TICKS = 38;      // 180 frames stop time for chain
const STOP_TOPOUT_TICKS = 88;     // 420 frames stop time when topped out
const JUNK_TELEGRAPH_TICKS = 16;  // 78 frames garbage telegraph
const RISE_TICKS_PER_ROW = 99;    // speed 11: 474 frames/row

let junkSetCounter = 0;

// ── Lobby state ───────────────────────────────────────────────
let myId = null;
let myName = '';
let lobbyRef = null;
let myPresenceRef = null;
let incomingInviteUnsub = null;
let currentLobbyData = {};

const lobbyScreen = document.getElementById('lobby-screen');
const gameScreen = document.getElementById('game-screen');
const gameOverOverlay = document.getElementById('game-over-overlay');
const playerListEl = document.getElementById('player-list');
const inviteModal = document.getElementById('invite-modal');
const inviteText = document.getElementById('invite-text');
const nameInput = document.getElementById('name-input');
const joinBtn = document.getElementById('join-btn');
const errorEl = document.getElementById('lobby-error');

function showLobbyError(msg) {
  errorEl.textContent = msg;
  errorEl.style.display = 'block';
}

function clearLobbyError() {
  errorEl.textContent = '';
  errorEl.style.display = 'none';
}

// ── Bot game entry ────────────────────────────────────────────
document.getElementById('vs-bot-btn').addEventListener('click', () => {
  const name = nameInput.value.trim() || 'Player';
  myName = name;
  localStorage.setItem('panelattack_name', name);
  const difficultyEl = document.querySelector('input[name="bot-difficulty"]:checked');
  const difficulty = difficultyEl ? difficultyEl.value : 'medium';
  lobbyScreen.style.display = 'none';
  gameScreen.style.display = 'flex';
  document.getElementById('my-label').textContent = myName;
  document.getElementById('enemy-label').textContent = `BOT (${difficulty.toUpperCase()})`;
  gameSession = createBotGameSession({
    difficulty,
    onGameOver: (won) => showGameOver(won, `BOT (${difficulty.toUpperCase()})`)
  });
  gameSession.start();
});

// Restore name
nameInput.value = localStorage.getItem('panelattack_name') || '';

joinBtn.addEventListener('click', joinLobby);
nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') joinLobby(); });

async function joinLobby() {
  const name = nameInput.value.trim();
  if (!name) { nameInput.focus(); return; }
  clearLobbyError();
  myName = name;
  localStorage.setItem('panelattack_name', name);

  myId = push(ref(db, 'panelattack/lobby')).key;
  myPresenceRef = ref(db, `panelattack/lobby/${myId}`);

  nameInput.disabled = true;
  joinBtn.disabled = true;

  // Optimistically show yourself immediately
  currentLobbyData = { ...currentLobbyData, [myId]: { name, joinedAt: Date.now() } };
  renderPlayerList(currentLobbyData);

  try {
    await set(myPresenceRef, { name, joinedAt: Date.now() });
    onDisconnect(myPresenceRef).remove();
    watchInvites();
  } catch (err) {
    showLobbyError(`Failed to join lobby: ${err.message}`);
    // Revert optimistic update
    delete currentLobbyData[myId];
    renderPlayerList(currentLobbyData);
    myId = null;
    myPresenceRef = null;
    nameInput.disabled = false;
    joinBtn.disabled = false;
  }
}

function watchLobby() {
  lobbyRef = ref(db, 'panelattack/lobby');
  onValue(
    lobbyRef,
    snap => {
      currentLobbyData = snap.val() || {};
      renderPlayerList(currentLobbyData);
    },
    err => {
      showLobbyError(`Lobby connection error: ${err.message}`);
    }
  );
}

// Watch lobby immediately so players are visible before joining
watchLobby();

function renderPlayerList(data) {
  const ids = Object.keys(data);
  if (ids.length === 0) {
    playerListEl.innerHTML = '<div class="empty-lobby">No players online yet…</div>';
    return;
  }

  playerListEl.innerHTML = '';
  ids.forEach(id => {
    const p = data[id];
    const row = document.createElement('div');
    row.className = 'player-row' + (id === myId ? ' me' : '');
    row.innerHTML = `
      <div class="dot"></div>
      <span class="name">${escHtml(p.name)}${id === myId ? ' (you)' : ''}</span>
      ${id !== myId && myId ? `<button class="btn cyan" data-target="${id}" data-name="${escHtml(p.name)}">Challenge</button>` : ''}
    `;
    if (id !== myId && myId) {
      row.querySelector('button').addEventListener('click', () => sendInvite(id, p.name));
    }
    playerListEl.appendChild(row);
  });
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Invite system ─────────────────────────────────────────────
let pendingInviteId = null;
let pendingInviterName = '';

function sendInvite(targetId, targetName) {
  if (!myId) return;
  const invRef = ref(db, `panelattack/invites/${targetId}`);
  set(invRef, { from: myId, fromName: myName, sentAt: Date.now() });
  // Wait for response
  const responseRef = ref(db, `panelattack/responses/${myId}`);
  const unsub = onValue(responseRef, snap => {
    const val = snap.val();
    if (!val) return;
    unsub();
    remove(responseRef);
    if (val.accepted) {
      startGame(myId, targetId, targetName, true);
    }
  });
}

function watchInvites() {
  if (!myId) return;
  const invRef = ref(db, `panelattack/invites/${myId}`);
  incomingInviteUnsub = onValue(invRef, snap => {
    const val = snap.val();
    if (!val) return;
    pendingInviteId = val.from;
    pendingInviterName = val.fromName;
    inviteText.textContent = `${val.fromName} wants to battle you!`;
    inviteModal.classList.add('open');
  });
}

document.getElementById('accept-btn').addEventListener('click', () => {
  inviteModal.classList.remove('open');
  if (!pendingInviteId) return;
  remove(ref(db, `panelattack/invites/${myId}`));
  set(ref(db, `panelattack/responses/${pendingInviteId}`), { accepted: true });
  startGame(myId, pendingInviteId, pendingInviterName, false);
});

document.getElementById('decline-btn').addEventListener('click', () => {
  inviteModal.classList.remove('open');
  if (!pendingInviteId) return;
  remove(ref(db, `panelattack/invites/${myId}`));
  set(ref(db, `panelattack/responses/${pendingInviteId}`), { accepted: false });
  pendingInviteId = null;
});

// ── Game bootstrap ────────────────────────────────────────────
let gameSession = null;

function startGame(myPlayerId, oppId, oppName, isHost) {
  lobbyScreen.style.display = 'none';
  gameScreen.style.display = 'flex';
  document.getElementById('my-label').textContent = myName || 'YOU';
  document.getElementById('enemy-label').textContent = oppName || 'OPPONENT';

  const gameId = isHost
    ? [myPlayerId, oppId].sort().join('_')
    : [myPlayerId, oppId].sort().join('_');

  gameSession = createGameSession({
    myId: myPlayerId,
    oppId,
    gameId,
    isHost,
    onGameOver: (won) => showGameOver(won, oppName)
  });

  gameSession.start();
}

// ── Game Over UI ──────────────────────────────────────────────
function showGameOver(won, oppName) {
  const title = document.getElementById('game-over-title');
  const msg = document.getElementById('game-over-msg');
  title.textContent = won ? 'YOU WIN!' : 'GAME OVER';
  title.className = won ? 'win' : 'lose';
  msg.textContent = won
    ? `${oppName} ran out of space!`
    : 'Your blocks reached the top!';
  gameOverOverlay.classList.add('open');
}

document.getElementById('rematch-btn').addEventListener('click', () => {
  gameOverOverlay.classList.remove('open');
  if (gameSession) {
    gameSession.destroy();
    gameSession = null;
  }
  // restart with same opponent — for simplicity go back to lobby
  returnToLobby();
});

document.getElementById('lobby-btn').addEventListener('click', () => {
  gameOverOverlay.classList.remove('open');
  if (gameSession) { gameSession.destroy(); gameSession = null; }
  returnToLobby();
});

document.getElementById('forfeit-btn').addEventListener('click', () => {
  if (gameSession) {
    gameSession.forfeit();
    gameSession.destroy();
    gameSession = null;
  }
  returnToLobby();
});

function returnToLobby() {
  gameScreen.style.display = 'none';
  lobbyScreen.style.display = 'flex';
}

// ── Board state helpers ───────────────────────────────────────
function emptyGrid() {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(null));
}

function randomBlock() {
  const idx = Math.floor(Math.random() * SYMBOLS.length);
  return { sym: idx, junk: false, clearing: false, clearTimer: 0, hover: false, hoverTimer: 0 };
}

function fillInitialRows(grid, count) {
  for (let r = ROWS - count; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      let block;
      let attempts = 0;
      do {
        block = randomBlock();
        attempts++;
      } while (
        attempts < 10 &&
        (
          (c >= 2 && grid[r][c-1]?.sym === block.sym && grid[r][c-2]?.sym === block.sym) ||
          (r >= 2 && grid[r-1]?.[c]?.sym === block.sym && grid[r-2]?.[c]?.sym === block.sym)
        )
      );
      grid[r][c] = block;
    }
  }
}

function generateNextRow(grid) {
  const row = [];
  for (let c = 0; c < COLS; c++) {
    let block;
    let attempts = 0;
    do {
      block = randomBlock();
      attempts++;
    } while (
      attempts < 10 &&
      (
        (c >= 2 && row[c-1]?.sym === block.sym && row[c-2]?.sym === block.sym) ||
        (grid[ROWS-1][c]?.sym === block.sym && grid[ROWS-2]?.[c]?.sym === block.sym)
      )
    );
    row.push(block);
  }
  return row;
}

// ── Match detection ───────────────────────────────────────────
function findMatches(grid) {
  const matched = new Set();

  // Horizontal
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS - 2; c++) {
      const a = grid[r][c], b = grid[r][c+1], cc = grid[r][c+2];
      if (a && b && cc && !a.junk && !b.junk && !cc.junk && !a.clearing && !b.clearing && !cc.clearing
          && a.sym === b.sym && b.sym === cc.sym) {
        matched.add(`${r},${c}`); matched.add(`${r},${c+1}`); matched.add(`${r},${c+2}`);
      }
    }
  }

  // Vertical
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS - 2; r++) {
      const a = grid[r][c], b = grid[r+1][c], cc = grid[r+2][c];
      if (a && b && cc && !a.junk && !b.junk && !cc.junk && !a.clearing && !b.clearing && !cc.clearing
          && a.sym === b.sym && b.sym === cc.sym) {
        matched.add(`${r},${c}`); matched.add(`${r+1},${c}`); matched.add(`${r+2},${c}`);
      }
    }
  }

  return matched;
}

function countMatchSize(matched) { return matched.size; }

function markClearing(grid, matched) {
  // Sort for consistent stagger order (row then col)
  const keys = [...matched].sort((a, b) => {
    const [ar, ac] = a.split(',').map(Number);
    const [br, bc] = b.split(',').map(Number);
    return ar !== br ? ar - br : ac - bc;
  });
  keys.forEach((key, i) => {
    const [r, c] = key.split(',').map(Number);
    if (grid[r][c]) {
      grid[r][c].clearing = true;
      grid[r][c].clearTimer = CLEAR_TICKS + i * POP_STAGGER_TICKS;
    }
  });
}

function breakAdjacentJunk(grid, matched) {
  const setsToBreak = new Set();
  matched.forEach(key => {
    const [r, c] = key.split(',').map(Number);
    [[r-1,c],[r+1,c],[r,c-1],[r,c+1]].forEach(([nr, nc]) => {
      if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS && grid[nr][nc]?.junk) {
        setsToBreak.add(grid[nr][nc].junkSetId);
      }
    });
  });
  if (setsToBreak.size === 0) return;

  // Peel only the BOTTOM row of each adjacent junk set (one row at a time)
  for (const setId of setsToBreak) {
    const setCells = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (grid[r][c]?.junk && grid[r][c].junkSetId === setId) {
          setCells.push({ r, c });
        }
      }
    }
    if (setCells.length === 0) continue;

    // Bottommost row of the set
    const maxRow = Math.max(...setCells.map(({ r }) => r));
    const bottomCells = setCells.filter(({ r }) => r === maxRow);
    const upperCells = setCells.filter(({ r }) => r < maxRow);

    // Peeled blocks become normal (can fall and chain)
    for (const { r, c } of bottomCells) {
      grid[r][c] = {
        sym: Math.floor(Math.random() * SYMBOLS.length),
        junk: false, clearing: false, clearTimer: 0,
        hover: false, hoverTimer: 0
      };
    }

    // Remaining rows keep junk status under a new set ID
    if (upperCells.length > 0) {
      const newSetId = ++junkSetCounter;
      for (const { r, c } of upperCells) {
        grid[r][c] = { ...grid[r][c], junkSetId: newSetId };
      }
    }
  }
}

// ── Apply gravity ─────────────────────────────────────────────
function applyGravity(grid) {
  let moved = false;

  // Regular blocks: 9-frame hover before falling (processed bottom-to-top)
  for (let c = 0; c < COLS; c++) {
    for (let r = ROWS - 2; r >= 0; r--) {
      const block = grid[r][c];
      if (!block || block.junk || block.clearing) continue;

      if (grid[r + 1][c] === null) {
        // No solid support below — start hover on first tick and decrement immediately
        if (!block.hover) {
          block.hover = true;
          block.hoverTimer = HOVER_TICKS;
        }
        moved = true;
        block.hoverTimer--;
        if (block.hoverTimer <= 0) {
          block.hover = false;
          if (grid[r + 1][c] === null) {
            grid[r + 1][c] = block;
            grid[r][c] = null;
          }
        }
      } else if (block.hover) {
        // Support returned before hover expired
        block.hover = false;
        block.hoverTimer = 0;
      }
    }
  }

  // Junk sets fall as rigid horizontal units (no hover)
  const junkSets = new Map();
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const block = grid[r][c];
      if (block?.junk) {
        if (!junkSets.has(block.junkSetId)) junkSets.set(block.junkSetId, []);
        junkSets.get(block.junkSetId).push({ r, c });
      }
    }
  }

  for (const [, cells] of junkSets) {
    const setPositions = new Set(cells.map(({ r, c }) => `${r},${c}`));
    let canFall = true;
    for (const { r, c } of cells) {
      if (r + 1 >= ROWS) { canFall = false; break; }
      const below = grid[r + 1][c];
      if (below !== null && !setPositions.has(`${r + 1},${c}`)) { canFall = false; break; }
    }
    if (canFall) {
      const sorted = [...cells].sort((a, b) => b.r - a.r);
      for (const { r, c } of sorted) {
        grid[r + 1][c] = grid[r][c];
        grid[r][c] = null;
      }
      moved = true;
    }
  }

  return moved;
}

// ── Add junk ──────────────────────────────────────────────────
// Add a single garbage rod (width × height) above existing content
function addJunkRod(grid, width, height) {
  let topRow = ROWS;
  for (let r = 0; r < ROWS; r++) {
    if (grid[r].some(b => b !== null)) { topRow = r; break; }
  }
  if (topRow === 0) return;

  const setId = ++junkSetCounter;
  for (let h = 0; h < height; h++) {
    const r = Math.max(0, topRow - height) + h;
    if (r >= ROWS) break;
    for (let c = 0; c < Math.min(width, COLS); c++) {
      grid[r][c] = { sym: -1, junk: true, junkSetId: setId, clearing: false, clearTimer: 0, hover: false, hoverTimer: 0 };
    }
  }
}

// Garbage table: returns array of rod descriptors for a combo of given panel count
function comboGarbageRods(size) {
  if (size < 4)  return [];
  if (size === 4)  return [{ width: 3, height: 1 }];
  if (size === 5)  return [{ width: 4, height: 1 }];
  if (size === 6)  return [{ width: 5, height: 1 }];
  if (size === 7)  return [{ width: 6, height: 1 }];
  if (size === 8)  return [{ width: 3, height: 1 }, { width: 4, height: 1 }];
  if (size === 9)  return [{ width: 4, height: 1 }, { width: 4, height: 1 }];
  if (size === 10) return [{ width: 5, height: 1 }, { width: 5, height: 1 }];
  if (size === 11) return [{ width: 5, height: 1 }, { width: 6, height: 1 }];
  if (size === 12) return [{ width: 6, height: 1 }, { width: 6, height: 1 }];
  if (size === 13) return [{ width: 6, height: 1 }, { width: 6, height: 1 }, { width: 6, height: 1 }];
  if (size <= 19)  return Array(4).fill(null).map(() => ({ width: 6, height: 1 }));
  return Array(6).fill(null).map(() => ({ width: 6, height: 1 }));
}

// K-chain garbage: (K-1) full-width rows as a single block
function chainGarbageRod(chainLevel) {
  if (chainLevel < 2) return null;
  return { width: COLS, height: chainLevel - 1 };
}

// Check if any block in grid is clearing or hovering (chain/motion check)
function gridHasClearingOrHovering(grid) {
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const b = grid[r][c];
      if (b?.clearing || b?.hover) return true;
    }
  }
  return false;
}

// ── Settings helper ───────────────────────────────────────────
function getBlockStyle() {
  return localStorage.getItem('pa_block_style') || 'classic';
}

// ── Render board ──────────────────────────────────────────────
function renderBoard(ctx, grid, cursorRow, cursorCol, riseOffset, showCursor, nextRow) {
  const emojiMode = getBlockStyle() === 'emoji';
  ctx.fillStyle = BG_COLOR;
  ctx.fillRect(0, 0, COLS * CELL, (ROWS + 1) * CELL);

  // Grid lines
  ctx.strokeStyle = GRID_COLOR;
  ctx.lineWidth = 1;
  for (let r = 0; r <= ROWS + 1; r++) {
    ctx.beginPath();
    ctx.moveTo(0, r * CELL - riseOffset);
    ctx.lineTo(COLS * CELL, r * CELL - riseOffset);
    ctx.stroke();
  }
  for (let c = 0; c <= COLS; c++) {
    ctx.beginPath();
    ctx.moveTo(c * CELL, 0);
    ctx.lineTo(c * CELL, (ROWS + 1) * CELL);
    ctx.stroke();
  }

  // Cells
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const block = grid[r][c];
      if (!block) continue;

      const x = c * CELL;
      const y = r * CELL - riseOffset;

      if (block.junk) {
        if (emojiMode) {
          ctx.fillStyle = '#2a1a00';
          ctx.fillRect(x + 1, y + 1, CELL - 2, CELL - 2);
          ctx.font = `${CELL * 0.72}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('💀', x + CELL / 2, y + CELL / 2 + 1);
        } else {
          ctx.fillStyle = JUNK_COLOR;
          ctx.fillRect(x + 1, y + 1, CELL - 2, CELL - 2);
          ctx.strokeStyle = JUNK_BORDER;
          ctx.lineWidth = 2;
          ctx.strokeRect(x + 2, y + 2, CELL - 4, CELL - 4);
          ctx.fillStyle = '#92400e';
          ctx.font = `bold ${CELL * 0.45}px monospace`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('✖', x + CELL / 2, y + CELL / 2);
        }
      } else if (emojiMode) {
        const alpha = block.clearing ? Math.min(1, block.clearTimer / CLEAR_TICKS) : 1;
        ctx.globalAlpha = alpha;
        if (block.clearing && Math.floor(block.clearTimer / 2) % 2 === 0) {
          ctx.fillStyle = 'rgba(255,255,255,0.6)';
          ctx.fillRect(x + 1, y + 1, CELL - 2, CELL - 2);
        }
        ctx.font = `${CELL * 0.82}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(EMOJI_SYMBOLS[block.sym] || '🐱', x + CELL / 2, y + CELL / 2 + 1);
        ctx.globalAlpha = 1;
      } else {
        const col = COLORS[block.sym] || '#fff';
        const alpha = block.clearing ? Math.min(1, block.clearTimer / CLEAR_TICKS) : 1;
        ctx.globalAlpha = alpha;

        // Block background with gradient feel
        ctx.fillStyle = col;
        ctx.fillRect(x + 1, y + 1, CELL - 2, CELL - 2);

        // Highlight
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.fillRect(x + 2, y + 2, CELL - 4, 6);

        // Flash when clearing
        if (block.clearing && Math.floor(block.clearTimer / 2) % 2 === 0) {
          ctx.fillStyle = 'rgba(255,255,255,0.5)';
          ctx.fillRect(x + 1, y + 1, CELL - 2, CELL - 2);
        }

        ctx.globalAlpha = 1;

        // Symbol
        ctx.fillStyle = '#fff';
        ctx.font = `${CELL * 0.4}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(SYMBOLS[block.sym], x + CELL / 2, y + CELL / 2);
      }
    }
  }

  // Incoming next row (dimmed, rising from below)
  if (nextRow) {
    ctx.globalAlpha = 0.45;
    for (let c = 0; c < COLS; c++) {
      const block = nextRow[c];
      if (!block) continue;
      const x = c * CELL;
      const y = ROWS * CELL - riseOffset;
      if (emojiMode) {
        ctx.font = `${CELL * 0.82}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(EMOJI_SYMBOLS[block.sym] || '🐱', x + CELL / 2, y + CELL / 2 + 1);
      } else {
        const col = COLORS[block.sym] || '#fff';
        ctx.fillStyle = col;
        ctx.fillRect(x + 1, y + 1, CELL - 2, CELL - 2);
        ctx.fillStyle = '#fff';
        ctx.font = `${CELL * 0.4}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(SYMBOLS[block.sym], x + CELL / 2, y + CELL / 2);
      }
    }
    ctx.globalAlpha = 1;
  }

  // Cursor
  if (showCursor && cursorRow >= 0 && cursorCol >= 0 && cursorCol < COLS - 1) {
    const x = cursorCol * CELL;
    const y = cursorRow * CELL - riseOffset;
    ctx.strokeStyle = CURSOR_COLOR;
    ctx.lineWidth = 3;
    ctx.strokeRect(x + 1, y + 1, CELL * 2 - 2, CELL - 2);
  }
}

// ── Game Session ──────────────────────────────────────────────
function createGameSession({ myId, oppId, gameId, isHost, onGameOver }) {
  const myCanvas = document.getElementById('my-canvas');
  const enemyCanvas = document.getElementById('enemy-canvas');
  const myCtx = myCanvas.getContext('2d');
  const enemyCtx = enemyCanvas.getContext('2d');

  // Local board
  const myGrid = emptyGrid();
  fillInitialRows(myGrid, 5);

  // Opponent display grid (received over firebase)
  const oppGrid = emptyGrid();

  let cursorRow = ROWS - 3;
  let cursorCol = 2;
  let riseOffset = 0;
  let nextRow = generateNextRow(myGrid);
  let gameOver = false;
  let animFrame = null;
  let tickInterval = null;
  // Chain state
  let chainLevel = 0;
  let chainActive = false;
  let stopTimer = 0;
  // Incoming junk telegraph queue
  let junkPending = [];

  const gameStateRef = ref(db, `panelattack/games/${gameId}/${myId}`);
  const oppStateRef = ref(db, `panelattack/games/${gameId}/${oppId}`);
  const junkRef = ref(db, `panelattack/junk/${gameId}/${myId}`);

  // Watch opponent board
  const oppUnsub = onValue(oppStateRef, snap => {
    const data = snap.val();
    if (!data) return;
    // Deserialise opponent grid
    if (data.grid) {
      const flat = data.grid;
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          oppGrid[r][c] = flat[r * COLS + c] || null;
        }
      }
    }
    if (data.lost) {
      if (!gameOver) {
        gameOver = true;
        cleanup();
        onGameOver(true);
      }
    }
  });

  // Watch junk sent to me — queue with telegraph delay
  const junkUnsub = onValue(junkRef, snap => {
    const val = snap.val();
    if (val && val.rods && val.rods.length > 0) {
      junkPending.push({ rods: val.rods, timer: JUNK_TELEGRAPH_TICKS });
      remove(junkRef);
    } else if (val && val.count) {
      // legacy: convert count to full-width rods
      const rods = [];
      for (let i = 0; i < val.count; i++) rods.push({ width: COLS, height: 1 });
      junkPending.push({ rods, timer: JUNK_TELEGRAPH_TICKS });
      remove(junkRef);
    }
  });

  // Push my state every few ticks
  let pushCounter = 0;
  function pushState(lost = false) {
    const flat = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const b = myGrid[r][c];
        flat.push(b ? { sym: b.sym, junk: b.junk } : null);
      }
    }
    set(gameStateRef, { grid: flat, lost });
  }

  function sendJunkRods(rods) {
    if (!rods || rods.length === 0) return;
    const ref2 = ref(db, `panelattack/junk/${gameId}/${oppId}`);
    get(ref2).then(snap => {
      const existing = snap.val()?.rods || [];
      set(ref2, { rods: [...existing, ...rods] });
    });
  }

  // Input
  const keys = new Set();
  const keyRepeat = {};
  const KEY_INITIAL_DELAY = 200;
  const KEY_REPEAT_DELAY = 80;

  function handleKey(e) {
    if (gameOver) return;
    const now = Date.now();

    const process = (key) => {
      if (key === 'ArrowLeft') { cursorCol = Math.max(0, cursorCol - 1); }
      else if (key === 'ArrowRight') { cursorCol = Math.min(COLS - 2, cursorCol + 1); }
      else if (key === 'ArrowUp') { cursorRow = Math.max(0, cursorRow - 1); }
      else if (key === 'ArrowDown') { cursorRow = Math.min(ROWS - 1, cursorRow + 1); }
      else if (key === 'z' || key === ' ') { swapAtCursor(); }
      else if (key === 'x') { speedRise(); }
    };

    if (e.type === 'keydown') {
      if (!keys.has(e.key)) {
        keys.add(e.key);
        keyRepeat[e.key] = { next: now + KEY_INITIAL_DELAY };
        process(e.key);
        e.preventDefault();
      }
    } else if (e.type === 'keyup') {
      keys.delete(e.key);
      delete keyRepeat[e.key];
    }
  }

  function processKeyRepeats() {
    const now = Date.now();
    for (const key of keys) {
      if (keyRepeat[key] && now >= keyRepeat[key].next) {
        keyRepeat[key].next = now + KEY_REPEAT_DELAY;
        if (key === 'ArrowLeft') cursorCol = Math.max(0, cursorCol - 1);
        else if (key === 'ArrowRight') cursorCol = Math.min(COLS - 2, cursorCol + 1);
        else if (key === 'ArrowUp') cursorRow = Math.max(0, cursorRow - 1);
        else if (key === 'ArrowDown') cursorRow = Math.min(ROWS - 1, cursorRow + 1);
      }
    }
  }

  window.addEventListener('keydown', handleKey);
  window.addEventListener('keyup', handleKey);

  // Mobile d-pad with repeat while held
  const mobileHeld = {};
  function startMobileRepeat(action) {
    if (mobileHeld[action]) return;
    action();
    const timer = { id: null };
    const repeat = () => {
      action();
      timer.id = setTimeout(repeat, KEY_REPEAT_DELAY);
    };
    timer.id = setTimeout(repeat, KEY_INITIAL_DELAY);
    mobileHeld[action] = timer;
  }
  function stopMobileRepeat(action) {
    const timer = mobileHeld[action];
    if (timer) { clearTimeout(timer.id); delete mobileHeld[action]; }
  }

  const dpadMap = {
    'dpad-up':    () => { cursorRow = Math.max(0, cursorRow - 1); },
    'dpad-down':  () => { cursorRow = Math.min(ROWS - 1, cursorRow + 1); },
    'dpad-left':  () => { cursorCol = Math.max(0, cursorCol - 1); },
    'dpad-right': () => { cursorCol = Math.min(COLS - 2, cursorCol + 1); },
  };

  Object.entries(dpadMap).forEach(([id, action]) => {
    const el = document.getElementById(id);
    if (!el) return;
    const start = (e) => { e.preventDefault(); if (!gameOver) startMobileRepeat(action); };
    const end   = () => stopMobileRepeat(action);
    el.addEventListener('touchstart', start, { passive: false });
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
  });

  const swapEl = document.getElementById('mobile-swap');
  const raiseEl = document.getElementById('mobile-raise');
  if (swapEl) {
    swapEl.addEventListener('touchstart', (e) => { e.preventDefault(); if (!gameOver) swapAtCursor(); }, { passive: false });
  }
  if (raiseEl) {
    raiseEl.addEventListener('touchstart', (e) => { e.preventDefault(); if (!gameOver) speedRise(); }, { passive: false });
  }

  function cleanupMobile() {
    Object.keys(mobileHeld).forEach(k => stopMobileRepeat(k));
  }

  function swapAtCursor() {
    if (gameOver) return;
    const r = cursorRow;
    const c = cursorCol;
    if (r < 0 || r >= ROWS || c < 0 || c + 1 >= COLS) return;
    const a = myGrid[r][c];
    const b = myGrid[r][c+1];
    if (a?.junk || b?.junk) return;
    if (a?.clearing || b?.clearing) return;
    myGrid[r][c] = b || null;
    myGrid[r][c+1] = a || null;
  }

  let speedRising = false;
  function speedRise() { speedRising = true; }

  // Game tick
  function tick() {
    if (gameOver) return;

    processKeyRepeats();

    // Tick down clearing blocks and check motion state BEFORE clearing
    const wasMoving = gridHasClearingOrHovering(myGrid);
    let anyClearing = false;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const b = myGrid[r][c];
        if (b?.clearing) {
          anyClearing = true;
          b.clearTimer--;
          if (b.clearTimer <= 0) myGrid[r][c] = null;
        }
      }
    }

    // Process telegraphed junk arrivals
    for (let i = junkPending.length - 1; i >= 0; i--) {
      junkPending[i].timer--;
      if (junkPending[i].timer <= 0) {
        for (const rod of junkPending[i].rods) addJunkRod(myGrid, rod.width, rod.height);
        junkPending.splice(i, 1);
      }
    }

    // Rise (frozen during stop time)
    if (stopTimer > 0) {
      stopTimer--;
    } else {
      const riseRate = speedRising ? (CELL / 10) : (CELL / RISE_TICKS_PER_ROW);
      riseOffset += riseRate;
      speedRising = false;

      if (riseOffset >= CELL) {
        riseOffset -= CELL;
        myGrid.shift();
        myGrid.push([...nextRow]);
        nextRow = generateNextRow(myGrid);
        cursorRow = Math.max(0, cursorRow - 1);

        if (myGrid[0].some(b => b !== null)) {
          triggerLose();
          return;
        }
      }
    }
    speedRising = false;

    // Gravity (hover + fall)
    applyGravity(myGrid);

    // Match detection — only when no clearing or hovering blocks remain
    if (!gridHasClearingOrHovering(myGrid)) {
      const matched = findMatches(myGrid);
      if (matched.size > 0) {
        const size = matched.size;

        // Determine chain vs fresh combo
        const isChain = chainActive && wasMoving;
        if (isChain) {
          chainLevel++;
        } else {
          chainLevel = 1;
          chainActive = true;
        }

        markClearing(myGrid, matched);
        breakAdjacentJunk(myGrid, matched);

        // Send combo garbage
        const comboRods = comboGarbageRods(size);
        // Send chain garbage
        const chainRod = isChain ? chainGarbageRod(chainLevel) : null;
        const allRods = chainRod ? [...comboRods, chainRod] : comboRods;
        sendJunkRods(allRods);

        // Stop time
        const topped = myGrid[0].some(b => b !== null);
        const newStop = topped ? STOP_TOPOUT_TICKS : isChain ? STOP_CHAIN_TICKS : STOP_COMBO_TICKS;
        stopTimer = Math.max(stopTimer, newStop);
      } else if (!wasMoving) {
        // Board settled with no match — end chain
        chainActive = false;
        chainLevel = 0;
      }
    }

    // Push state every 3 ticks
    pushCounter++;
    if (pushCounter % 3 === 0) pushState();
  }

  function triggerLose() {
    gameOver = true;
    pushState(true);
    cleanup();
    onGameOver(false);
  }

  function cleanup() {
    clearInterval(tickInterval);
    cancelAnimationFrame(animFrame);
    window.removeEventListener('keydown', handleKey);
    window.removeEventListener('keyup', handleKey);
    cleanupMobile();
    oppUnsub();
    junkUnsub();
    // Clean up firebase game data
    remove(gameStateRef);
    remove(ref(db, `panelattack/games/${gameId}/${oppId}`));
  }

  // Render loop
  function renderLoop() {
    if (gameOver) return;
    renderBoard(myCtx, myGrid, cursorRow, cursorCol, riseOffset, true, nextRow);
    renderBoard(enemyCtx, oppGrid, -1, -1, 0, false, null);
    animFrame = requestAnimationFrame(renderLoop);
  }

  return {
    start() {
      tickInterval = setInterval(tick, TICK_MS);
      renderLoop();
    },
    destroy() {
      gameOver = true;
      cleanup();
    },
    forfeit() {
      pushState(true);
    }
  };
}

// ── Bot Game Session ──────────────────────────────────────────
function createBotGameSession({ onGameOver, difficulty = 'medium' }) {
  const myCanvas = document.getElementById('my-canvas');
  const enemyCanvas = document.getElementById('enemy-canvas');
  const myCtx = myCanvas.getContext('2d');
  const enemyCtx = enemyCanvas.getContext('2d');

  // Player board
  const myGrid = emptyGrid();
  fillInitialRows(myGrid, 5);

  // Bot board
  const botGrid = emptyGrid();
  fillInitialRows(botGrid, 5);

  let cursorRow = ROWS - 3;
  let cursorCol = 2;
  let riseOffset = 0;
  let myNextRow = generateNextRow(myGrid);
  let gameOver = false;
  let animFrame = null;
  let tickInterval = null;
  // Bot state
  let botNextRow = generateNextRow(botGrid);
  let botCursorRow = ROWS - 3;
  let botCursorCol = 2;
  let botThinkTick = 0;
  const BOT_THINK_RATE = difficulty === 'easy' ? 15 : difficulty === 'hard' ? 2 : difficulty === 'extreme' ? 1 : 6;
  const BOT_DANGER_ROW = difficulty === 'easy' ? 2 : difficulty === 'hard' ? 4 : difficulty === 'extreme' ? 6 : 3;
  const BOT_SPEED_RISE = difficulty === 'extreme'; // extreme bot also speed-raises aggressively

  // ── Bot AI ────────────────────────────────────────────────
  function countNearMatches(grid) {
    let count = 0;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS - 1; c++) {
        const a = grid[r][c], b = grid[r][c + 1];
        if (a && b && !a.junk && !b.junk && !a.clearing && !b.clearing && a.sym === b.sym) count++;
      }
    }
    for (let c = 0; c < COLS; c++) {
      for (let r = 0; r < ROWS - 1; r++) {
        const a = grid[r][c], b = grid[r + 1][c];
        if (a && b && !a.junk && !b.junk && !a.clearing && !b.clearing && a.sym === b.sym) count++;
      }
    }
    return count;
  }

  function getColumnTopRow(grid, col) {
    for (let r = 0; r < ROWS; r++) {
      if (grid[r][col] && !grid[r][col].clearing) return r;
    }
    return ROWS;
  }

  function botFindSurvivalSwap(grid) {
    const tops = Array.from({ length: COLS }, (_, c) => getColumnTopRow(grid, c));
    const minTop = Math.min(...tops);
    if (minTop > BOT_DANGER_ROW) return null;

    // Collect all danger columns sorted tallest first
    const dangerCols = tops
      .map((t, c) => ({ c, t }))
      .filter(({ t }) => t <= BOT_DANGER_ROW)
      .sort((a, b) => a.t - b.t);

    for (const { c: dangerCol, t: colTop } of dangerCols) {
      // If the top of this column is junk, moving blocks below it doesn't reduce column height.
      // Skip it and let junk-break logic handle it instead.
      if (grid[colTop]?.[dangerCol]?.junk) continue;

      // Try every row near the top of this column
      for (let r = colTop; r < colTop + 6 && r < ROWS; r++) {
        const block = grid[r][dangerCol];
        if (!block || block.junk || block.clearing) continue;

        // Candidate swaps: move block left (swapCol = dangerCol-1) or right (swapCol = dangerCol)
        // A swap at swapCol exchanges columns swapCol and swapCol+1
        const candidates = [];
        if (dangerCol > 0) candidates.push({ swapCol: dangerCol - 1, destCol: dangerCol - 1 });
        if (dangerCol < COLS - 1) candidates.push({ swapCol: dangerCol, destCol: dangerCol + 1 });

        // Sort by destination column height (prefer moving to shortest)
        candidates.sort((a, b) => tops[b.destCol] - tops[a.destCol]);

        for (const { swapCol, destCol } of candidates) {
          if (tops[destCol] <= colTop + 1) continue; // dest not meaningfully shorter
          const a = grid[r][swapCol];
          const b = grid[r][swapCol + 1];
          if (a?.junk || b?.junk || a?.clearing || b?.clearing) continue;
          return { row: r, col: swapCol, score: 999 };
        }
      }
    }
    return null;
  }

  function botFindJunkBreakSwap(grid) {
    let bestScore = 0, bestRow = -1, bestCol = -1;
    for (let r = ROWS - 1; r >= 0; r--) {
      for (let c = 0; c < COLS - 1; c++) {
        const a = grid[r][c], b = grid[r][c + 1];
        if (a?.junk || b?.junk || a?.clearing || b?.clearing) continue;
        if (!a && !b) continue;
        grid[r][c] = b || null;
        grid[r][c + 1] = a || null;
        const matched = findMatches(grid);
        grid[r][c] = a;
        grid[r][c + 1] = b;
        if (matched.size === 0) continue;
        let adjacentToJunk = false;
        for (const key of matched) {
          const [mr, mc] = key.split(',').map(Number);
          for (const [nr, nc] of [[mr-1,mc],[mr+1,mc],[mr,mc-1],[mr,mc+1]]) {
            if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS && grid[nr][nc]?.junk) {
              adjacentToJunk = true;
              break;
            }
          }
          if (adjacentToJunk) break;
        }
        if (adjacentToJunk && matched.size > bestScore) {
          bestScore = matched.size;
          bestRow = r;
          bestCol = c;
        }
      }
    }
    return bestScore > 0 ? { row: bestRow, col: bestCol, score: bestScore } : null;
  }

  // Find a swap that doesn't immediately match adjacent to junk, but after making it,
  // a direct junk-break swap becomes available (2-ply lookahead for junk clearing).
  function botFindJunkBreakSetupSwap(grid) {
    for (let r = ROWS - 1; r >= 0; r--) {
      for (let c = 0; c < COLS - 1; c++) {
        const a = grid[r][c], b = grid[r][c + 1];
        if (a?.junk || b?.junk || a?.clearing || b?.clearing) continue;
        if (!a && !b) continue;
        grid[r][c] = b || null;
        grid[r][c + 1] = a || null;
        const followUp = botFindJunkBreakSwap(grid);
        grid[r][c] = a;
        grid[r][c + 1] = b;
        if (followUp) return { row: r, col: c, score: 1 };
      }
    }
    return null;
  }

  function botFindBestSwap(grid) {
    const survivalSwap = botFindSurvivalSwap(grid);
    if (survivalSwap) return survivalSwap;

    // Prioritize breaking junk blocks by matching adjacent to them
    const junkBreakSwap = botFindJunkBreakSwap(grid);
    if (junkBreakSwap) return junkBreakSwap;

    // Fall back to a setup swap that enables a junk-break on the next move
    const junkBreakSetupSwap = botFindJunkBreakSetupSwap(grid);
    if (junkBreakSetupSwap) return junkBreakSetupSwap;

    let bestMatchScore = -1, bestMatchRow = -1, bestMatchCol = -1;
    let bestSetupScore = -1, bestSetupRow = -1, bestSetupCol = -1;

    // Scan bottom-up so lower rows are preferred when tied
    for (let r = ROWS - 1; r >= 0; r--) {
      for (let c = 0; c < COLS - 1; c++) {
        const a = grid[r][c], b = grid[r][c + 1];
        if (a?.junk || b?.junk || a?.clearing || b?.clearing) continue;
        if (!a && !b) continue; // nothing to swap

        // Simulate swap
        grid[r][c] = b || null;
        grid[r][c + 1] = a || null;
        const matchScore = findMatches(grid).size;
        const setupScore = matchScore === 0 ? countNearMatches(grid) : 0;
        grid[r][c] = a;
        grid[r][c + 1] = b;

        if (matchScore > bestMatchScore) {
          bestMatchScore = matchScore; bestMatchRow = r; bestMatchCol = c;
        }
        if (matchScore === 0 && setupScore > bestSetupScore) {
          bestSetupScore = setupScore; bestSetupRow = r; bestSetupCol = c;
        }
      }
    }

    if (bestMatchScore > 0) return { row: bestMatchRow, col: bestMatchCol, score: bestMatchScore };

    // No immediate match — try multi-step slide search (throttled) before falling back to setup
    botMultiStepTick++;
    if (botMultiStepTick >= BOT_MULTISTEP_RATE) {
      botMultiStepTick = 0;
      botMultiStepTarget = botFindMultiStepSwap(grid);
    }
    if (botMultiStepTarget) {
      const { row: mr, col: mc } = botMultiStepTarget;
      const ma = grid[mr]?.[mc], mb = grid[mr]?.[mc + 1];
      if (!ma?.junk && !mb?.junk && !ma?.clearing && !mb?.clearing && (ma || mb)) {
        return botMultiStepTarget;
      }
      botMultiStepTarget = null;
    }

    if (bestSetupScore > 0) return { row: bestSetupRow, col: bestSetupCol, score: bestSetupScore };
    return null;
  }

  // Find any symbol block that can be swapped sideways into an empty cell that has
  // empty below it, so the block drops down — scans top-down to prefer high blocks.
  function botFindDropSwap(grid) {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const block = grid[r][c];
        if (!block || block.junk || block.clearing) continue;
        // Try moving left into col c-1
        if (c > 0 && grid[r][c - 1] === null && (r + 1 >= ROWS || grid[r + 1][c - 1] === null)) {
          return { row: r, col: c - 1, score: 1 };
        }
        // Try moving right into col c+1
        if (c < COLS - 1 && grid[r][c + 1] === null && (r + 1 >= ROWS || grid[r + 1][c + 1] === null)) {
          return { row: r, col: c, score: 1 };
        }
      }
    }
    return null;
  }

  // Find the first swap in a multi-step slide that eventually creates a match.
  // Simulates moving a block up to MAX_SLIDE columns left or right one swap at a time,
  // checking for a match after each intermediate step. Returns the *first* swap in the
  // sequence (i.e. the immediate swap to make now), not the final destination.
  function botFindMultiStepSwap(grid, maxSlide = 4) {
    for (let r = ROWS - 1; r >= 0; r--) {
      for (let c = 0; c < COLS; c++) {
        const block = grid[r][c];
        if (!block || block.junk || block.clearing) continue;

        // Try sliding right
        {
          const tmp = grid[r].slice();
          let firstSwapCol = -1;
          for (let steps = 1; steps <= maxSlide && c + steps < COLS; steps++) {
            const neighbor = tmp[c + steps - 1 + 1]; // cell being swapped into
            if (neighbor?.junk || neighbor?.clearing) break;
            // perform swap on tmp row
            [tmp[c + steps - 1], tmp[c + steps]] = [tmp[c + steps], tmp[c + steps - 1]];
            if (firstSwapCol === -1) firstSwapCol = c + steps - 1;
            // check for match after this step
            const testGrid = grid.map((row, ri) => ri === r ? tmp.slice() : row);
            if (findMatches(testGrid).size > 0) {
              return { row: r, col: firstSwapCol, score: 1 };
            }
          }
        }

        // Try sliding left
        {
          const tmp = grid[r].slice();
          let firstSwapCol = -1;
          for (let steps = 1; steps <= maxSlide && c - steps >= 0; steps++) {
            const neighbor = tmp[c - steps + 1 - 1]; // cell being swapped into
            if (neighbor?.junk || neighbor?.clearing) break;
            [tmp[c - steps + 1], tmp[c - steps]] = [tmp[c - steps], tmp[c - steps + 1]];
            if (firstSwapCol === -1) firstSwapCol = c - steps;
            const testGrid = grid.map((row, ri) => ri === r ? tmp.slice() : row);
            if (findMatches(testGrid).size > 0) {
              return { row: r, col: firstSwapCol, score: 1 };
            }
          }
        }
      }
    }
    return null;
  }

  let botTarget = null;
  let botDropTick = 0;
  const BOT_DROP_RATE = 8; // force a drop-flatten move every N think ticks
  let botMultiStepTick = 0;
  let botMultiStepTarget = null; // cached result from last multi-step search
  const BOT_MULTISTEP_RATE = 10; // re-run multi-step search every N think ticks

  function botThink() {
    // Survival threat always overrides current target
    const survivalSwap = botFindSurvivalSwap(botGrid);
    if (survivalSwap) botTarget = survivalSwap;

    // Periodically override with a drop move to keep the board flat
    if (!survivalSwap) {
      botDropTick++;
      if (botDropTick >= BOT_DROP_RATE) {
        botDropTick = 0;
        const dropSwap = botFindDropSwap(botGrid);
        if (dropSwap) { botTarget = dropSwap; }
      }
    }

    if (!botTarget) botTarget = botFindBestSwap(botGrid);
    if (!botTarget) return;

    const { row, col } = botTarget;

    // Validate target is still swappable; if stale, clear and pick fresh next tick
    const ta = botGrid[row][col], tb = botGrid[row][col + 1];
    if (ta?.junk || tb?.junk || ta?.clearing || tb?.clearing || (!ta && !tb)) { // stale if both null or either is junk/clearing
      botTarget = null;
      botTarget = botFindBestSwap(botGrid);
      if (!botTarget) return;
    }

    // Move cursor one step toward target
    const { row: tr, col: tc } = botTarget;
    if (botCursorRow !== tr) { botCursorRow += botCursorRow < tr ? 1 : -1; return; }
    if (botCursorCol !== tc) { botCursorCol += botCursorCol < tc ? 1 : -1; return; }

    // At target — swap (allow swapping with empty cell, same as player)
    const a = botGrid[botCursorRow][botCursorCol];
    const b = botGrid[botCursorRow][botCursorCol + 1];
    if (!a?.junk && !b?.junk && !a?.clearing && !b?.clearing && (a || b)) {
      botGrid[botCursorRow][botCursorCol] = b || null;
      botGrid[botCursorRow][botCursorCol + 1] = a || null;
    }
    botTarget = null;
    botMultiStepTarget = null;       // board changed, invalidate multi-step cache
    botMultiStepTick = BOT_MULTISTEP_RATE; // search again immediately next tick if needed

    // Extreme: speed-raise only when board is safe
    if (BOT_SPEED_RISE && !botFindSurvivalSwap(botGrid) && Math.random() < 0.03) {
      botState.speedRising = true;
    }
  }

  // ── Input ─────────────────────────────────────────────────
  const keys = new Set();
  const keyRepeat = {};
  const KEY_INITIAL_DELAY = 200;
  const KEY_REPEAT_DELAY = 80;

  function handleKey(e) {
    if (gameOver) return;
    const now = Date.now();
    const process = (key) => {
      if (key === 'ArrowLeft') cursorCol = Math.max(0, cursorCol - 1);
      else if (key === 'ArrowRight') cursorCol = Math.min(COLS - 2, cursorCol + 1);
      else if (key === 'ArrowUp') cursorRow = Math.max(0, cursorRow - 1);
      else if (key === 'ArrowDown') cursorRow = Math.min(ROWS - 1, cursorRow + 1);
      else if (key === 'z' || key === ' ') playerSwap();
      else if (key === 'x') playerSpeedRise();
    };
    if (e.type === 'keydown') {
      if (!keys.has(e.key)) {
        keys.add(e.key);
        keyRepeat[e.key] = { next: now + KEY_INITIAL_DELAY };
        process(e.key);
        e.preventDefault();
      }
    } else if (e.type === 'keyup') {
      keys.delete(e.key);
      delete keyRepeat[e.key];
    }
  }

  function processKeyRepeats() {
    const now = Date.now();
    for (const key of keys) {
      if (keyRepeat[key] && now >= keyRepeat[key].next) {
        keyRepeat[key].next = now + KEY_REPEAT_DELAY;
        if (key === 'ArrowLeft') cursorCol = Math.max(0, cursorCol - 1);
        else if (key === 'ArrowRight') cursorCol = Math.min(COLS - 2, cursorCol + 1);
        else if (key === 'ArrowUp') cursorRow = Math.max(0, cursorRow - 1);
        else if (key === 'ArrowDown') cursorRow = Math.min(ROWS - 1, cursorRow + 1);
      }
    }
  }

  window.addEventListener('keydown', handleKey);
  window.addEventListener('keyup', handleKey);

  // Mobile controls
  const mobileHeld = {};
  function startMobileRepeat(action) {
    if (mobileHeld[action]) return;
    action();
    const timer = { id: null };
    const repeat = () => { action(); timer.id = setTimeout(repeat, KEY_REPEAT_DELAY); };
    timer.id = setTimeout(repeat, KEY_INITIAL_DELAY);
    mobileHeld[action] = timer;
  }
  function stopMobileRepeat(action) {
    const timer = mobileHeld[action];
    if (timer) { clearTimeout(timer.id); delete mobileHeld[action]; }
  }

  const dpadMap = {
    'dpad-up':    () => { cursorRow = Math.max(0, cursorRow - 1); },
    'dpad-down':  () => { cursorRow = Math.min(ROWS - 1, cursorRow + 1); },
    'dpad-left':  () => { cursorCol = Math.max(0, cursorCol - 1); },
    'dpad-right': () => { cursorCol = Math.min(COLS - 2, cursorCol + 1); },
  };
  Object.entries(dpadMap).forEach(([id, action]) => {
    const el = document.getElementById(id);
    if (!el) return;
    const start = (e) => { e.preventDefault(); if (!gameOver) startMobileRepeat(action); };
    const end = () => stopMobileRepeat(action);
    el.addEventListener('touchstart', start, { passive: false });
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
  });

  const swapEl = document.getElementById('mobile-swap');
  const raiseEl = document.getElementById('mobile-raise');
  if (swapEl) swapEl.addEventListener('touchstart', (e) => { e.preventDefault(); if (!gameOver) playerSwap(); }, { passive: false });
  if (raiseEl) raiseEl.addEventListener('touchstart', (e) => { e.preventDefault(); if (!gameOver) playerSpeedRise(); }, { passive: false });

  function cleanupMobile() {
    Object.keys(mobileHeld).forEach(k => stopMobileRepeat(k));
  }

  let speedRising = false;
  function playerSpeedRise() { speedRising = true; }

  function playerSwap() {
    if (gameOver) return;
    const r = cursorRow, c = cursorCol;
    if (r < 0 || r >= ROWS || c < 0 || c + 1 >= COLS) return;
    const a = myGrid[r][c], b = myGrid[r][c + 1];
    if (a?.junk || b?.junk || a?.clearing || b?.clearing) return;
    myGrid[r][c] = b || null;
    myGrid[r][c + 1] = a || null;
  }

  // ── Tick ──────────────────────────────────────────────────
  function tickBoard(grid, state) {
    const wasMoving = gridHasClearingOrHovering(grid);

    // Tick down clearing blocks
    let anyClearing = false;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const b = grid[r][c];
        if (b?.clearing) {
          anyClearing = true;
          b.clearTimer--;
          if (b.clearTimer <= 0) grid[r][c] = null;
        }
      }
    }

    // Process telegraphed junk arrivals
    for (let i = state.junkPending.length - 1; i >= 0; i--) {
      state.junkPending[i].timer--;
      if (state.junkPending[i].timer <= 0) {
        for (const rod of state.junkPending[i].rods) addJunkRod(grid, rod.width, rod.height);
        state.junkPending.splice(i, 1);
      }
    }

    // Rise (frozen during stop time)
    if (state.stopTimer > 0) {
      state.stopTimer--;
    } else {
      const riseRate = state.speedRising ? (CELL / 10) : (CELL / RISE_TICKS_PER_ROW);
      state.riseOffset += riseRate;
      state.speedRising = false;

      if (state.riseOffset >= CELL) {
        state.riseOffset -= CELL;
        grid.shift();
        grid.push([...state.nextRow]);
        state.nextRow = generateNextRow(grid);
        state.cursorRow = Math.max(0, state.cursorRow - 1);
        if (grid[0].some(b => b !== null)) return 'lose';
      }
    }
    state.speedRising = false;

    applyGravity(grid);

    // Match detection — only when no clearing or hovering
    if (!gridHasClearingOrHovering(grid)) {
      const matched = findMatches(grid);
      if (matched.size > 0) {
        const size = matched.size;

        const isChain = state.chainActive && wasMoving;
        if (isChain) {
          state.chainLevel++;
        } else {
          state.chainLevel = 1;
          state.chainActive = true;
        }

        markClearing(grid, matched);
        breakAdjacentJunk(grid, matched);

        const comboRods = comboGarbageRods(size);
        const chainRod = isChain ? chainGarbageRod(state.chainLevel) : null;
        const allRods = chainRod ? [...comboRods, chainRod] : comboRods;
        if (allRods.length > 0) state.sendJunkRods(allRods);

        const topped = grid[0].some(b => b !== null);
        const newStop = topped ? STOP_TOPOUT_TICKS : isChain ? STOP_CHAIN_TICKS : STOP_COMBO_TICKS;
        state.stopTimer = Math.max(state.stopTimer, newStop);
      } else if (!wasMoving) {
        state.chainActive = false;
        state.chainLevel = 0;
      }
    }

    return 'ok';
  }

  const playerState = {
    riseOffset: 0,
    speedRising: false,
    nextRow: myNextRow,
    cursorRow,
    cursorCol,
    junkPending: [],
    chainLevel: 0,
    chainActive: false,
    stopTimer: 0,
    sendJunkRods: (rods) => { botState.junkPending.push({ rods, timer: JUNK_TELEGRAPH_TICKS }); }
  };

  const botState = {
    riseOffset: 0,
    speedRising: false,
    nextRow: botNextRow,
    cursorRow: botCursorRow,
    cursorCol: botCursorCol,
    junkPending: [],
    chainLevel: 0,
    chainActive: false,
    stopTimer: 0,
    sendJunkRods: (rods) => { playerState.junkPending.push({ rods, timer: JUNK_TELEGRAPH_TICKS }); }
  };

  function tick() {
    if (gameOver) return;

    processKeyRepeats();

    // Sync player cursor into state
    playerState.cursorRow = cursorRow;
    playerState.cursorCol = cursorCol;
    playerState.speedRising = speedRising;
    speedRising = false;

    // Bot AI
    botThinkTick++;
    if (botThinkTick >= BOT_THINK_RATE) {
      botThinkTick = 0;
      botThink();
      botState.cursorRow = botCursorRow;
      botState.cursorCol = botCursorCol;
    }

    const playerResult = tickBoard(myGrid, playerState);
    const botResult = tickBoard(botGrid, botState);

    cursorRow = playerState.cursorRow;

    if (playerResult === 'lose') { gameOver = true; cleanup(); onGameOver(false); return; }
    if (botResult === 'lose') { gameOver = true; cleanup(); onGameOver(true); return; }
  }

  function cleanup() {
    clearInterval(tickInterval);
    cancelAnimationFrame(animFrame);
    window.removeEventListener('keydown', handleKey);
    window.removeEventListener('keyup', handleKey);
    cleanupMobile();
  }

  function renderLoop() {
    if (gameOver) return;
    renderBoard(myCtx, myGrid, cursorRow, cursorCol, playerState.riseOffset, true, playerState.nextRow);
    renderBoard(enemyCtx, botGrid, botCursorRow, botCursorCol, botState.riseOffset, true, botState.nextRow);
    animFrame = requestAnimationFrame(renderLoop);
  }

  return {
    start() {
      tickInterval = setInterval(tick, TICK_MS);
      renderLoop();
    },
    destroy() {
      gameOver = true;
      cleanup();
    },
    forfeit() {
      // no-op for bot game
    }
  };
}
