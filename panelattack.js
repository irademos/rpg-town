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
const COLORS = ['#ef4444', '#22c55e', '#3b82f6', '#f59e0b', '#a855f7', '#ec4899'];
const JUNK_COLOR = '#44403c';
const JUNK_BORDER = '#78716c';
const BG_COLOR = '#0a0a1a';
const GRID_COLOR = '#12122a';
const CURSOR_COLOR = '#06b6d4';
const TICK_MS = 80;
const RAISE_TICKS = 80;
const FALL_DELAY = 3;
const CLEAR_DELAY = 30;
const JUNK_BREAK_DELAY = 15;

// ── Lobby state ───────────────────────────────────────────────
let myId = null;
let myName = '';
let lobbyRef = null;
let myPresenceRef = null;
let incomingInviteUnsub = null;

const lobbyScreen = document.getElementById('lobby-screen');
const gameScreen = document.getElementById('game-screen');
const gameOverOverlay = document.getElementById('game-over-overlay');
const playerListEl = document.getElementById('player-list');
const inviteModal = document.getElementById('invite-modal');
const inviteText = document.getElementById('invite-text');
const nameInput = document.getElementById('name-input');
const joinBtn = document.getElementById('join-btn');

// Restore name
nameInput.value = localStorage.getItem('panelattack_name') || '';

joinBtn.addEventListener('click', joinLobby);
nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') joinLobby(); });

function joinLobby() {
  const name = nameInput.value.trim();
  if (!name) { nameInput.focus(); return; }
  myName = name;
  localStorage.setItem('panelattack_name', name);

  myId = push(ref(db, 'panelattack/lobby')).key;
  myPresenceRef = ref(db, `panelattack/lobby/${myId}`);

  set(myPresenceRef, { name, joinedAt: Date.now() });
  onDisconnect(myPresenceRef).remove();

  nameInput.disabled = true;
  joinBtn.disabled = true;

  watchLobby();
  watchInvites();
}

function watchLobby() {
  lobbyRef = ref(db, 'panelattack/lobby');
  onValue(lobbyRef, snap => {
    const data = snap.val() || {};
    renderPlayerList(data);
  });
}

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
  return { sym: idx, junk: false, clearing: false, clearTimer: 0, fallDelay: 0 };
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
  matched.forEach(key => {
    const [r, c] = key.split(',').map(Number);
    if (grid[r][c]) {
      grid[r][c].clearing = true;
      grid[r][c].clearTimer = CLEAR_DELAY;
    }
  });
}

function breakAdjacentJunk(grid, matched) {
  const toBreak = new Set();
  matched.forEach(key => {
    const [r, c] = key.split(',').map(Number);
    const neighbors = [[r-1,c],[r+1,c],[r,c-1],[r,c+1]];
    neighbors.forEach(([nr, nc]) => {
      if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS && grid[nr][nc]?.junk) {
        toBreak.add(`${nr},${nc}`);
      }
    });
  });
  toBreak.forEach(key => {
    const [r, c] = key.split(',').map(Number);
    // Convert junk to a clearing regular block
    grid[r][c] = { sym: Math.floor(Math.random() * SYMBOLS.length), junk: false, clearing: true, clearTimer: JUNK_BREAK_DELAY, fallDelay: 0 };
  });
}

// ── Apply gravity ─────────────────────────────────────────────
function applyGravity(grid) {
  let moved = false;
  for (let c = 0; c < COLS; c++) {
    for (let r = ROWS - 2; r >= 0; r--) {
      const block = grid[r][c];
      if (block && !block.clearing && grid[r+1][c] === null) {
        if (block.fallDelay > 0) { block.fallDelay--; continue; }
        grid[r+1][c] = block;
        grid[r][c] = null;
        moved = true;
      }
    }
  }
  return moved;
}

// ── Add junk ──────────────────────────────────────────────────
function addJunk(grid, count) {
  // Add `count` junk columns in top row, shifting everything down by one if needed
  // Find highest occupied row
  let topRow = ROWS;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (grid[r][c]) { topRow = r; break; }
    }
    if (topRow < ROWS) break;
  }

  // Shift everything up by 1 row if top is occupied
  if (topRow === 0) return; // board full

  const junkRow = Math.max(0, topRow - 1);
  const cols = Math.min(count, COLS);
  for (let c = 0; c < cols; c++) {
    grid[junkRow][c] = { sym: -1, junk: true, clearing: false, clearTimer: 0, fallDelay: 0 };
  }

  // Fill remaining junk if more than COLS
  if (count > COLS) {
    addJunk(grid, count - COLS);
  }
}

// ── Render board ──────────────────────────────────────────────
function renderBoard(ctx, grid, cursorRow, cursorCol, riseOffset, showCursor) {
  ctx.fillStyle = BG_COLOR;
  ctx.fillRect(0, 0, COLS * CELL, ROWS * CELL);

  // Grid lines
  ctx.strokeStyle = GRID_COLOR;
  ctx.lineWidth = 1;
  for (let r = 0; r <= ROWS; r++) {
    ctx.beginPath();
    ctx.moveTo(0, r * CELL - riseOffset);
    ctx.lineTo(COLS * CELL, r * CELL - riseOffset);
    ctx.stroke();
  }
  for (let c = 0; c <= COLS; c++) {
    ctx.beginPath();
    ctx.moveTo(c * CELL, 0);
    ctx.lineTo(c * CELL, ROWS * CELL);
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
      } else {
        const col = COLORS[block.sym] || '#fff';
        const alpha = block.clearing ? (block.clearTimer / CLEAR_DELAY) : 1;
        ctx.globalAlpha = alpha;

        // Block background with gradient feel
        ctx.fillStyle = col;
        ctx.fillRect(x + 1, y + 1, CELL - 2, CELL - 2);

        // Highlight
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.fillRect(x + 2, y + 2, CELL - 4, 6);

        // Flash when clearing
        if (block.clearing && Math.floor(block.clearTimer / 4) % 2 === 0) {
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
  let riseTick = 0;
  let nextRow = generateNextRow(myGrid);
  let gameOver = false;
  let animFrame = null;
  let tickInterval = null;
  let junkQueue = 0;

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

  // Watch junk sent to me
  const junkUnsub = onValue(junkRef, snap => {
    const val = snap.val();
    if (val && val.count) {
      junkQueue += val.count;
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

  function sendJunk(count) {
    const ref2 = ref(db, `panelattack/junk/${gameId}/${oppId}`);
    get(ref2).then(snap => {
      const existing = snap.val()?.count || 0;
      set(ref2, { count: existing + count });
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

    // Apply junk queue
    if (junkQueue > 0) {
      addJunk(myGrid, junkQueue);
      junkQueue = 0;
    }

    // Rise
    const riseRate = speedRising ? 4 : 1;
    riseOffset += riseRate;
    speedRising = false;

    riseTick++;
    if (riseOffset >= CELL) {
      riseOffset -= CELL;
      // Shift grid up
      myGrid.shift();
      myGrid.push([...nextRow]);
      nextRow = generateNextRow(myGrid);
      cursorRow = Math.max(0, cursorRow - 1);

      // Check lose condition
      if (myGrid[0].some(b => b !== null)) {
        triggerLose();
        return;
      }
    }

    // Gravity
    applyGravity(myGrid);

    // Tick clearing blocks
    let anyClearing = false;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const b = myGrid[r][c];
        if (b?.clearing) {
          anyClearing = true;
          b.clearTimer--;
          if (b.clearTimer <= 0) {
            myGrid[r][c] = null;
          }
        }
      }
    }

    // Match if no clearing in progress
    if (!anyClearing) {
      const matched = findMatches(myGrid);
      if (matched.size > 0) {
        const size = countMatchSize(matched);
        markClearing(myGrid, matched);
        breakAdjacentJunk(myGrid, matched);
        if (size >= 4) {
          sendJunk(size - 3);
        }
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
    oppUnsub();
    junkUnsub();
    // Clean up firebase game data
    remove(gameStateRef);
    remove(ref(db, `panelattack/games/${gameId}/${oppId}`));
  }

  // Render loop
  function renderLoop() {
    if (gameOver) return;
    renderBoard(myCtx, myGrid, cursorRow, cursorCol, riseOffset, true);
    renderBoard(enemyCtx, oppGrid, -1, -1, 0, false);
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
