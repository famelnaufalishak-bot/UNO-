const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const COLORS = ['red', 'yellow', 'green', 'blue'];
const rooms = {}; // code -> room state

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let s = '';
  for (let i = 0; i < 4; i++) s += letters[Math.floor(Math.random() * letters.length)];
  return s;
}

function buildDeck() {
  let d = [];
  COLORS.forEach((c) => {
    d.push({ color: c, value: '0' });
    for (let n = 1; n <= 9; n++) {
      d.push({ color: c, value: String(n) });
      d.push({ color: c, value: String(n) });
    }
    ['skip', 'reverse', 'draw2'].forEach((v) => {
      d.push({ color: c, value: v });
      d.push({ color: c, value: v });
    });
  });
  for (let i = 0; i < 4; i++) {
    d.push({ color: 'wild', value: 'wild' });
    d.push({ color: 'wild', value: 'wild4' });
  }
  return d;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function cardScore(c) {
  if (c.value === 'wild' || c.value === 'wild4') return 50;
  if (c.value === 'skip' || c.value === 'reverse' || c.value === 'draw2') return 20;
  return parseInt(c.value, 10);
}

function makeRoom(code, hostSocketId, hostName) {
  return {
    code,
    seats: [
      { socketId: hostSocketId, name: hostName || 'Player 1', bot: false, connected: true },
      null,
      null,
      null,
    ],
    scores: [0, 0, 0, 0],
    started: false,
    game: null,
  };
}

function publicRoomState(room) {
  return {
    code: room.code,
    seats: room.seats.map((s) =>
      s ? { name: s.name, bot: s.bot, connected: s.connected } : null
    ),
    scores: room.scores,
    started: room.started,
  };
}

// Per-player view of the game: own hand full, others just counts
function publicGameState(room, forSeatIdx) {
  const g = room.game;
  if (!g) return null;
  return {
    hands: g.hands.map((h, i) => (i === forSeatIdx ? h : h.length)),
    discardTop: g.discard[g.discard.length - 1],
    currentColor: g.currentColor,
    deckCount: g.deck.length,
    turn: g.turn,
    direction: g.direction,
    drawPending: g.drawPending,
    drawType: g.drawType,
    winnerSeat: g.winnerSeat,
    message: g.message,
    calledUno: g.calledUno,
    unoPenaltyAvailable: g.unoPenaltyAvailable,
    activeSeats: g.activeSeats,
    turnStartedAt: g.turnStartedAt || null,
    turnSeconds: g.turnSeconds || null,
  };
}

function broadcastRoom(room) {
  io.to(room.code).emit('room_update', publicRoomState(room));
}

function broadcastGame(room) {
  room.seats.forEach((seat, idx) => {
    if (seat && seat.socketId && !seat.bot) {
      io.to(seat.socketId).emit('game_update', publicGameState(room, idx));
    }
  });
}

function activeSeatIndices(room) {
  const arr = [];
  room.seats.forEach((s, i) => {
    if (s) arr.push(i);
  });
  return arr;
}

function nextSeat(room, from) {
  const active = room.game.activeSeats;
  const idx = active.indexOf(from);
  const dir = room.game.direction;
  const n = active.length;
  const nextIdx = (idx + dir + n) % n;
  return active[nextIdx];
}

function startGame(room) {
  const active = activeSeatIndices(room);
  const deck = shuffle(buildDeck());
  const hands = [[], [], [], []];
  active.forEach((seatIdx) => {
    for (let i = 0; i < 7; i++) hands[seatIdx].push(deck.pop());
  });
  let top;
  do {
    top = deck.pop();
  } while (top.color === 'wild' || top.value === 'draw2');
  const discard = [top];
  room.started = true;
  room.game = {
    deck,
    hands,
    discard,
    currentColor: top.color,
    turn: active[0],
    direction: 1,
    drawPending: 0,
    drawType: null,
    winnerSeat: null,
    message: seatName(room, active[0]) + "'s turn.",
    calledUno: [false, false, false, false],
    unoPenaltyAvailable: null,
    activeSeats: active,
  };
  broadcastRoom(room);
  broadcastGame(room);
  startTurnTimer(room);
  maybeRunBot(room);
}

function seatName(room, idx) {
  const s = room.seats[idx];
  return s ? s.name : 'Player';
}

function canPlay(room, card) {
  const g = room.game;
  if (g.drawPending > 0) {
    if (g.drawType === 'draw2') return card.value === 'draw2';
    if (g.drawType === 'wild4') return false;
  }
  const top = g.discard[g.discard.length - 1];
  if (card.color === 'wild') return true;
  if (card.color === g.currentColor) return true;
  if (card.value === top.value) return true;
  return false;
}

function reshuffleIfNeeded(room) {
  const g = room.game;
  if (g.deck.length === 0) {
    const t = g.discard.pop();
    g.deck = shuffle(g.discard);
    g.discard = [t];
  }
}

function drawCards(room, seatIdx, n) {
  const g = room.game;
  for (let i = 0; i < n; i++) {
    reshuffleIfNeeded(room);
    if (g.deck.length === 0) break;
    g.hands[seatIdx].push(g.deck.pop());
  }
}

function checkRoundOver(room) {
  const g = room.game;
  for (const idx of g.activeSeats) {
    if (g.hands[idx].length === 0) {
      let pts = 0;
      g.activeSeats.forEach((other) => {
        if (other !== idx) g.hands[other].forEach((c) => (pts += cardScore(c)));
      });
      room.scores[idx] += pts;
      g.winnerSeat = idx;
      g.message = seatName(room, idx) + ' wins the round! +' + pts + ' points.';
      clearTurnTimer(room);
      return true;
    }
  }
  return false;
}

function playCard(room, seatIdx, cardIndex, chosenColor) {
  const g = room.game;
  const hand = g.hands[seatIdx];
  const card = hand[cardIndex];
  if (!card) return;
  hand.splice(cardIndex, 1);
  g.discard.push(card);
  g.currentColor = card.color === 'wild' ? chosenColor : card.color;

  const forgotUno = hand.length === 1 && !g.calledUno[seatIdx];
  g.calledUno[seatIdx] = false;

  if (checkRoundOver(room)) {
    broadcastRoom(room);
    broadcastGame(room);
    return;
  }

  let next = nextSeat(room, seatIdx);

  if (card.value === 'skip') {
    next = nextSeat(room, next);
  }
  if (card.value === 'reverse') {
    if (g.activeSeats.length === 2) {
      next = seatIdx;
    } else {
      g.direction *= -1;
      next = nextSeat(room, seatIdx);
    }
  }
  if (card.value === 'draw2') {
    g.drawPending += 2;
    g.drawType = 'draw2';
    g.message = seatName(room, seatIdx) + ' played draw 2.';
  } else if (card.value === 'wild4') {
    g.drawPending += 4;
    g.drawType = 'wild4';
    g.message = seatName(room, seatIdx) + ' played wild draw 4.';
  } else {
    g.message = seatName(room, next) + "'s turn.";
  }

  if (forgotUno) {
    drawCards(room, seatIdx, 2);
    g.message = seatName(room, seatIdx) + ' forgot to call uno and drew 2.';
  }

  if (hand.length === 1 && !forgotUno) {
    g.unoPenaltyAvailable = seatIdx;
  } else {
    g.unoPenaltyAvailable = null;
  }

  g.turn = next;
  broadcastRoom(room);
  broadcastGame(room);
  startTurnTimer(room);
  maybeRunBot(room);
}

function drawForTurn(room, seatIdx) {
  const g = room.game;
  if (g.drawPending > 0) {
    drawCards(room, seatIdx, g.drawPending);
    g.message = seatName(room, seatIdx) + ' drew ' + g.drawPending + ' cards.';
    g.drawPending = 0;
    g.drawType = null;
    g.turn = nextSeat(room, seatIdx);
    broadcastGame(room);
    startTurnTimer(room);
    maybeRunBot(room);
    return;
  }
  drawCards(room, seatIdx, 1);
  const drawn = g.hands[seatIdx][g.hands[seatIdx].length - 1];
  if (drawn && canPlay(room, drawn)) {
    g.message = seatName(room, seatIdx) + ' drew a playable card.';
    broadcastGame(room);
  } else {
    g.message = seatName(room, seatIdx) + ' drew a card.';
    g.turn = nextSeat(room, seatIdx);
    broadcastGame(room);
    startTurnTimer(room);
    maybeRunBot(room);
  }
}

function passTurn(room, seatIdx) {
  const g = room.game;
  if (g.drawPending > 0) return;
  g.turn = nextSeat(room, seatIdx);
  g.message = seatName(room, g.turn) + "'s turn.";
  broadcastGame(room);
  startTurnTimer(room);
  maybeRunBot(room);
}

function callUno(room, seatIdx) {
  const g = room.game;
  if (g.hands[seatIdx].length <= 2) {
    g.calledUno[seatIdx] = true;
    broadcastGame(room);
  }
}

function catchUno(room, catcherIdx) {
  const g = room.game;
  if (g.unoPenaltyAvailable !== null) {
    const target = g.unoPenaltyAvailable;
    drawCards(room, target, 2);
    g.message = seatName(room, catcherIdx) + ' caught ' + seatName(room, target) + '! Drew 2.';
    g.unoPenaltyAvailable = null;
    broadcastGame(room);
  }
}

function bestBotIndex(room, seatIdx) {
  const g = room.game;
  const hand = g.hands[seatIdx];
  const playable = [];
  for (let i = 0; i < hand.length; i++) {
    if (canPlay(room, hand[i]) && hand[i].color !== 'wild') playable.push(i);
  }
  if (playable.length > 0) {
    playable.sort((a, b) => {
      const rank = (c) =>
        c.value === 'draw2' ? 3 : c.value === 'skip' || c.value === 'reverse' ? 2 : 1;
      return rank(hand[b]) - rank(hand[a]) || cardScore(hand[b]) - cardScore(hand[a]);
    });
    return playable[0];
  }
  if (!(g.drawPending > 0 && g.drawType === 'wild4')) {
    for (let i = 0; i < hand.length; i++) {
      if (hand[i].color === 'wild') return i;
    }
  }
  return -1;
}

const TURN_SECONDS = 20;

function clearTurnTimer(room) {
  if (room.turnTimeout) {
    clearTimeout(room.turnTimeout);
    room.turnTimeout = null;
  }
}

function startTurnTimer(room) {
  clearTurnTimer(room);
  if (!room.game || room.game.winnerSeat !== null) return;
  const seat = room.seats[room.game.turn];
  if (!seat || seat.bot) return;
  room.game.turnStartedAt = Date.now();
  room.game.turnSeconds = TURN_SECONDS;
  room.turnTimeout = setTimeout(() => {
    if (!room.game || room.game.winnerSeat !== null) return;
    const idx = room.game.turn;
    room.game.message = seatName(room, idx) + ' ran out of time and drew a card.';
    if (room.game.drawPending > 0) {
      drawCards(room, idx, room.game.drawPending);
      room.game.drawPending = 0;
      room.game.drawType = null;
      room.game.turn = nextSeat(room, idx);
      broadcastGame(room);
      startTurnTimer(room);
      maybeRunBot(room);
      return;
    }
    drawCards(room, idx, 1);
    const drawn = room.game.hands[idx][room.game.hands[idx].length - 1];
    if (!(drawn && canPlay(room, drawn))) {
      room.game.turn = nextSeat(room, idx);
    }
    broadcastGame(room);
    startTurnTimer(room);
    maybeRunBot(room);
  }, TURN_SECONDS * 1000);
}

function maybeRunBot(room) {
  const g = room.game;
  if (!g || g.winnerSeat !== null) return;
  const seat = room.seats[g.turn];
  if (!seat || !seat.bot) return;
  setTimeout(() => {
    if (!room.game || room.game.winnerSeat !== null) return;
    const idx = g.turn;
    let playIdx = bestBotIndex(room, idx);
    if (playIdx === -1) {
      if (g.drawPending > 0) {
        drawCards(room, idx, g.drawPending);
        g.message = seatName(room, idx) + ' drew ' + g.drawPending + ' cards.';
        g.drawPending = 0;
        g.drawType = null;
        g.turn = nextSeat(room, idx);
        broadcastGame(room);
        startTurnTimer(room);
        maybeRunBot(room);
        return;
      }
      drawCards(room, idx, 1);
      const drawn = g.hands[idx][g.hands[idx].length - 1];
      if (drawn && canPlay(room, drawn)) {
        playIdx = g.hands[idx].length - 1;
      } else {
        g.message = seatName(room, idx) + ' drew a card.';
        g.turn = nextSeat(room, idx);
        broadcastGame(room);
        startTurnTimer(room);
        maybeRunBot(room);
        return;
      }
    }
    const card = g.hands[idx][playIdx];
    let chosenColor = null;
    if (card.color === 'wild') {
      const counts = { red: 0, yellow: 0, green: 0, blue: 0 };
      g.hands[idx].forEach((c) => {
        if (counts[c.color] !== undefined) counts[c.color]++;
      });
      chosenColor = Object.keys(counts).reduce((a, b) => (counts[a] >= counts[b] ? a : b));
    }
    if (g.hands[idx].length === 2) {
      g.calledUno[idx] = Math.random() < 0.7;
    }
    playCard(room, idx, playIdx, chosenColor);
  }, 900);
}

function nextRound(room) {
  startGame(room);
}

io.on('connection', (socket) => {
  socket.on('create_room', (name, cb) => {
    let c = makeCode();
    while (rooms[c]) c = makeCode();
    const room = makeRoom(c, socket.id, name);
    rooms[c] = room;
    socket.join(c);
    socket.data.roomCode = c;
    socket.data.seatIdx = 0;
    cb({ ok: true, code: c, seatIdx: 0, state: publicRoomState(room) });
  });

  socket.on('join_room', ({ code, name }, cb) => {
    const room = rooms[(code || '').toUpperCase()];
    if (!room) return cb({ ok: false, error: 'Room not found.' });
    if (room.started) return cb({ ok: false, error: 'Game already started.' });
    const seatIdx = room.seats.findIndex((s) => s === null);
    if (seatIdx === -1) return cb({ ok: false, error: 'Room is full.' });
    room.seats[seatIdx] = { socketId: socket.id, name: name || 'Player ' + (seatIdx + 1), bot: false, connected: true };
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.seatIdx = seatIdx;
    broadcastRoom(room);
    cb({ ok: true, code: room.code, seatIdx, state: publicRoomState(room) });
  });

  socket.on('add_bot', (seatIdx) => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.started) return;
    if (socket.data.seatIdx !== 0) return;
    if (room.seats[seatIdx]) return;
    room.seats[seatIdx] = { socketId: null, name: 'Bot ' + (seatIdx + 1), bot: true, connected: true };
    broadcastRoom(room);
  });

  socket.on('remove_seat', (seatIdx) => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.started) return;
    if (socket.data.seatIdx !== 0) return;
    if (!room.seats[seatIdx] || !room.seats[seatIdx].bot) return;
    room.seats[seatIdx] = null;
    broadcastRoom(room);
  });

  socket.on('start_game', () => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.started) return;
    if (socket.data.seatIdx !== 0) return;
    const filled = room.seats.filter((s) => s).length;
    if (filled < 2) return;
    startGame(room);
  });

  socket.on('play_card', ({ cardIndex, chosenColor }) => {
    const room = rooms[socket.data.roomCode];
    if (!room || !room.game || room.game.winnerSeat !== null) return;
    const seatIdx = socket.data.seatIdx;
    if (room.game.turn !== seatIdx) return;
    const card = room.game.hands[seatIdx][cardIndex];
    if (!card || !canPlay(room, card)) return;
    if (card.color === 'wild' && !chosenColor) return;
    playCard(room, seatIdx, cardIndex, chosenColor);
  });

  socket.on('draw_card', () => {
    const room = rooms[socket.data.roomCode];
    if (!room || !room.game || room.game.winnerSeat !== null) return;
    const seatIdx = socket.data.seatIdx;
    if (room.game.turn !== seatIdx) return;
    drawForTurn(room, seatIdx);
  });

  socket.on('pass_turn', () => {
    const room = rooms[socket.data.roomCode];
    if (!room || !room.game || room.game.winnerSeat !== null) return;
    const seatIdx = socket.data.seatIdx;
    if (room.game.turn !== seatIdx) return;
    passTurn(room, seatIdx);
  });

  socket.on('call_uno', () => {
    const room = rooms[socket.data.roomCode];
    if (!room || !room.game) return;
    callUno(room, socket.data.seatIdx);
  });

  socket.on('catch_uno', () => {
    const room = rooms[socket.data.roomCode];
    if (!room || !room.game) return;
    catchUno(room, socket.data.seatIdx);
  });

  socket.on('next_round', () => {
    const room = rooms[socket.data.roomCode];
    if (!room || !room.game || room.game.winnerSeat === null) return;
    if (socket.data.seatIdx !== 0) return;
    nextRound(room);
  });

  socket.on('disconnect', () => {
    const room = rooms[socket.data.roomCode];
    if (!room) return;
    const idx = socket.data.seatIdx;
    if (room.seats[idx]) {
      room.seats[idx].connected = false;
    }
    broadcastRoom(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Uno online listening on port ' + PORT);
});
