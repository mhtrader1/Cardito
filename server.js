const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const app = express();
app.get("/", (req, res) => res.send("Server is running"));
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  pingInterval: 2000,  // ask the client for a heartbeat every 2 s
  pingTimeout:  5000   // consider the client disconnected if no pong in 5 s
});
const { initMemory, getBestMoveForPlay } = require('./bots');
//import { Economy } from './src/screens/Economy.js';

// ثابت‌ها
const HANDS_REQUIRED = 7;   // تعداد ترک‌های لازم برای پایان راند
const WINS_REQUIRED = 3;    // وقتی یک تیم به این تعداد راند برسد، بازی تمام می‌شود
const AUTO_PLAY_DELAY = 10000; // زمان تاخیر اتوماتیک به میلی‌ثانیه
const DELAY_TIME = 2000;       // تاخیر برای پردازش دست (2 ثانیه)
const LOBBY_DURATION = 5000;
const START_DELAY = 1000;          // کل تأخیر لازم برای تکمیل تقسیم ۵ کارت به هر بازیکن
const BOT_AVATARS = [ 'bot1.png','bot2.png','bot3.png','bot4.png','bot5.png',
                      'bot6.png','bot7.png','bot8.png','bot9.png','bot10.png' ];

function buildGameStateDelta(session) {
  return {
    step:      session.gameState.step,
    nextTurn:  session.gameState.players[session.gameState.turn].username,
    trumpSuit: session.gameState.trumpSuit
  };
}                     
// مدیریت سشن‌ها
const sessions = new Map(); // Map<sessionId, session> برای دسترسی O(1) - نگهداری سشن‌های بازی

// ----------------- Utility Functions -----------------
// تولید دک کارت
function generateDeck() {
  const suits = ["♥", "♠", "♦", "♣"];
  const values = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
  let deck = [];
  let id = 0;
  for (let suit of suits) {
    for (let value of values) {
      deck.push({ id: id++, suit, value });
    }
  }
  // شافل کردن دک با الگوریتم Fisher-Yates
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// ————————— تابع کمکی برای نگاشتِ { id, suit(نماد), value(حرف) } → { id, suit(نام enum), rank(نام enum) } —————————
function mapCardToEnum(card) {
  if (card.id < 0) {
    // suit ممکن است نماد ♥♠♦♣ باشد
    const suitOrder = { "♥": 0, "♠": 1, "♦": 2, "♣": 3 };
    // اگر suit عدد است (انتخاب کاربر)، از خودش استفاده کن
    const idx = typeof card.suit === "number"
      ? card.suit
      : (suitOrder[card.suit] ?? 0);
    return { id: card.id, suit: idx, rank: 0 };
  }
  const suitIndex = Math.floor(card.id / 13);       // 0..3
  const rank      = (card.id % 13) + 2;             // 2..14
  return { id: card.id, suit: suitIndex, rank };
}

// مرتب‌سازی دست کارت‌ها
function sortHand(hand) {
  const suits = ["♥", "♠", "♦", "♣"];
  const values = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
  return hand.sort((a, b) => {
    if (a.suit === b.suit) {
      return values.indexOf(a.value) - values.indexOf(b.value);
    }
    return suits.indexOf(a.suit) - suits.indexOf(b.suit);
  });
}

// ایجاد وضعیت اولیه بازی (شروع بازی)
function createGame(players) {
  const positions = ['bottom', 'right', 'top', 'left'];
  const teams = [1, 2, 1, 2];
  const gamePlayers = players.map((player, index) => ({
    ...player,
    position: positions[index],
    team: teams[index],
    avatar: player.avatar || null
  }));

  const deck = generateDeck();
  const hands = {};
  // هر دست فعلاً خالی بگذار
  gamePlayers.forEach(player => {
    hands[player.username] = [];
  });
  // انتخاب تصادفی حاکم (dealer) – تنها در شروع بازی
  const randomDealer = Math.floor(Math.random() * gamePlayers.length);
  const state = {
    players: gamePlayers,
    deck: deck,
    hands: hands,
    trumpSuit: null,
    step: "start", // فاز شروع
    turn: randomDealer,  // ترتیب بازی (turn order)
    dealer: gamePlayers[randomDealer].username,  // حاکم فعلی
    autoPlayDelay: AUTO_PLAY_DELAY,
    delayTime: DELAY_TIME,
    table: [],
    leadSuit: null,
    teamPoints: { team1: 0, team2: 0 },
    teamWins: { team1: 0, team2: 0 },
    message: "",
    lastRoundWinnerTeam: null  // برای ذخیره تیم برنده آخرین راند
  };
  return state;
}

function startGameHelper(session) {
  // 1. ایجاد gameState با createGame
  session.gameState = createGame(session.waitingPlayers);
  session.gameState.step = 'start';

  // 2. آماده‌سازی payload برای پیام startGame
  const payloadPlayers = session.gameState.players.map(p => ({
    id:       p.username,
    username: p.username,
    avatar:   p.avatar || null
  }));
  // می‌توانید اینجا dealer را هم بفرستید اگر نیاز دارید:
  const payloadGameState = {
    players:   payloadPlayers,
    turnIndex: session.gameState.turn,
    dealer:    session.gameState.dealer,
    teamWins:  session.gameState.teamWins
  };

  // 3. ارسال پیام startGame به همهٔ کلاینت‌ها در سشن
  io.in(session.sessionId).emit("startGame", {
    sessionId: session.sessionId,
    gameState: payloadGameState
  });
  console.log(`[SRV] startGameHelper: sent startGame with players=[${payloadPlayers.map(p => p.username).join(", ")}]`);
  const mappedFullDeck = session.gameState.deck.map(card => mapCardToEnum(card));
  // 4. ارسال پیام initFullDeck با کل ۵۲ کارت
  io.in(session.sessionId).emit("initFullDeck", { deck: mappedFullDeck});
  console.log(`[SRV] startGameHelper: sent initFullDeck (${mappedFullDeck.length} cards)`);

  // 5. پس از START_DELAY، ارسال فاز اول (5 کارت اولیه)
  setTimeout(() => {
    const handsInitial = {};
    session.gameState.players.forEach(player => {
      const rawFive = session.gameState.deck.splice(0, 5);
      const mappedFive = rawFive.map(card => mapCardToEnum(card));
      handsInitial[player.username] = mappedFive;
      session.gameState.hands[player.username] = rawFive;
    });

    io.in(session.sessionId).emit("dealInitial5", { hands: handsInitial });
    console.log("[SRV] startGameHelper: sent dealInitial5 with 5 cards per player:", handsInitial);
   
  }, START_DELAY);
}

// شروع دور جدید
function startNewRound(session) {
  console.log("Starting a new round.");
  const gs = session.gameState;

  // ۱) تعیین حاکم جدید بر اساس winner راند قبل
  const trickDealer = gs.players.find(p => p.username === gs.dealer);
  if (gs.lastRoundWinnerTeam && trickDealer.team !== gs.lastRoundWinnerTeam) {
    const currentDealerIndex = gs.players.findIndex(p => p.username === gs.dealer);
    gs.dealer = gs.players[(currentDealerIndex + 1) % gs.players.length].username;
    console.log("Dealer changed to", gs.dealer);
  } else {
    console.log("Dealer remains same:", gs.dealer);
  }
  gs.turn = gs.players.findIndex(p => p.username === gs.dealer);

  // ۲) ریست وضعیتِ‌ راند (ولی نگهداری teamWins)
  gs.deck        = generateDeck();                         // دک جدید
  gs.teamPoints  = { team1: 0, team2: 0 };                 // امتیاز تریک‌های راند
  gs.hands       = {};                                    
  gs.players.forEach(p => { gs.hands[p.username] = []; });  // خالی کردن دست‌ها
  gs.table       = [];                                     // پاک کردن میز
  gs.leadSuit    = null;                                   // حذف lead suit
  gs.trumpSuit   = null;                                   // حذف حکم
  gs.step        = 'start';                                // فاز شروع

  // ۳) ارسال پیام startGame (بدون تغییر در teamWins)
  const payloadPlayers = gs.players.map(p => ({
    id:       p.username,
    username: p.username,
    avatar:   p.avatar || null
  }));
  io.in(session.sessionId).emit("startGame", {
    sessionId: session.sessionId,
    gameState: {
      players:   payloadPlayers,
      turnIndex: gs.turn,
      dealer:    gs.dealer,
      teamWins:  gs.teamWins
    }
  });

  // ۴) ارسال کل دک جدید
  const mappedFullDeck = gs.deck.map(card => mapCardToEnum(card));
  io.in(session.sessionId).emit("initFullDeck", { deck: mappedFullDeck });

  // ۵) پس از تأخیر، توزیع ۵ کارت اولیه
  setTimeout(() => {
    const handsInitial = {};
    gs.players.forEach(player => {
      const rawFive = gs.deck.splice(0, 5);
      handsInitial[player.username] = rawFive.map(card => mapCardToEnum(card));
      gs.hands[player.username] = rawFive;
    });
    io.in(session.sessionId).emit("dealInitial5", { hands: handsInitial });
    console.log("[SRV] startNewRound: dealt initial 5 cards", handsInitial);
  }, START_DELAY);
}

// انتخاب کارت قابل بازی
function selectPlayableCard(hand, leadSuit) {
  if (!leadSuit) return hand[0];
  const matching = hand.filter(c => c.suit === leadSuit);
  return matching.length > 0 ? matching[0] : hand[0];
}

// انتخاب بهترین حکم بر اساس دست کارت
function getBestTrump(hand) {
  const valuesOrder = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
  const suits = ["♥", "♠", "♦", "♣"];
  let suitCounts = { "♥": 0, "♠": 0, "♦": 0, "♣": 0 };
  let suitMaxValue = { "♥": -1, "♠": -1, "♦": -1, "♣": -1 };

  hand.forEach(card => {
    suitCounts[card.suit] += 1;
    const cardIndex = valuesOrder.indexOf(card.value);
    if (cardIndex > suitMaxValue[card.suit]) {
      suitMaxValue[card.suit] = cardIndex;
    }
  });

  let bestSuit = suits[0];
  suits.forEach(suit => {
    if (suitCounts[suit] > suitCounts[bestSuit]) {
      bestSuit = suit;
    } else if (suitCounts[suit] === suitCounts[bestSuit]) {
      if (suitMaxValue[suit] > suitMaxValue[bestSuit]) {
        bestSuit = suit;
      }
    }
  });
  return bestSuit;
}

// مدیریت حرکت‌های اتوماتیک
function handleAutoPlay(session) {
  const gs = session.gameState;
  if (!gs) return;
  const currentPlayer = gs.players[gs.turn];
  session.memories = session.memories || {};
  let memory;
  if (currentPlayer.isBot) {
    if (!session.memories[currentPlayer.username]) {
      session.memories[currentPlayer.username] = initMemory();
    }
    memory = session.memories[currentPlayer.username]; // (طبق قبل، حافظه‌ی بات در شروع بازی مقداردهی شده)
  } else {
    memory = initMemory(); // فقط برای این یک‌بار، بدون ذخیره برای انسان‌ها فقط یک حافظه موقت بساز
  }
  if (session.autoPlayTimer) {
    clearTimeout(session.autoPlayTimer);
    session.autoPlayTimer = null;
  }
  if (gs.step === "play") {
    const hand = gs.hands[currentPlayer.username];
    if (hand && hand.length > 0) {
      let card = getBestMoveForPlay(hand, gs.leadSuit, gs, memory);
      // اگر کارت انتخاب شده undefined بود، اولین کارت مرتب‌شده به عنوان fallback انتخاب می‌شود.
      if (!card) {
        const sortedHand = sortHand([...hand]);
        card = sortedHand[0];
      }
      const mapped = mapCardToEnum(card);
      console.log(`Auto-playing card for ${currentPlayer.username}: rank=${mapped.rank}, suit=${mapped.suit}`);
      processPlayCard(session, currentPlayer.username, card);
    } else {
      console.log(`Player ${currentPlayer.username} has no cards.`);
    }
  } else if (gs.step === "select-trump") {
    const hand = gs.hands[currentPlayer.username];
    const bestTrump = getBestTrump(hand);
    const mapped = mapCardToEnum({id: -1, suit: bestTrump, value: bestTrump});
    console.log(`Auto-selecting trump suit for ${currentPlayer.username}: ${bestTrump} → ${mapped.suit}`);
    gs.trumpSuit = mapped.suit;
    gs.step = "dealRemaining8"; //To Be Edited؟
    // تکمیل دست به ۱۳ کارت برای همه بازیکنان
    const handsRemaining = {};
    gs.players.forEach(p => {
      const extra = gs.deck.splice(0, 8);
      handsRemaining[p.username] = extra.map(card => mapCardToEnum(card));
      gs.hands[p.username] = sortHand([...gs.hands[p.username], ...handsRemaining[p.username]]);
    });
    io.in(session.sessionId).emit("dealRemaining8", { hands: handsRemaining });
    io.in(session.sessionId).emit("gameStateUpdate", buildGameStateDelta(session));
    checkAutoPlay(session);
  }
}

// تنظیم تایمر auto‑play (فقط زمانی که فاز play یا select‑trump است)
function checkAutoPlay(session) {
  if (session.autoPlayTimer) {
    clearTimeout(session.autoPlayTimer);
    session.autoPlayTimer = null;
  }
  const gs = session.gameState;
  if (!gs || (gs.step !== "play" && gs.step !== "select-trump")) return;
  const currentPlayer = gs.players[gs.turn];
  if (currentPlayer) {
    console.log(
      "[Server] checkAutoPlay:",
      "nextPlayer=", currentPlayer.username,
      "isBot=", currentPlayer.isBot,
      "socketId=", currentPlayer.socketId
    );
    if (currentPlayer.isBot || !currentPlayer.socketId) {
      // برای ربات‌ها یا بازیکن بدون socketId، autoPlay به صورت خودکار اجرا می‌شود
      const botDelay = Math.floor(gs.autoPlayDelay / 3);
      session.autoPlayTimer = setTimeout(() => {
        handleAutoPlay(session);
      }, botDelay);
    } else {
      // برای بازیکنان واقعی؛ اگر پس از ۲ برابر autoPlayDelay هیچ رویداد autoPlay از کلاینت دریافت نشود، fallback اجرا می‌شود
      session.autoPlayTimer = setTimeout(() => {
        console.log("Fallback autoPlay for local player triggered.");
        handleAutoPlay(session);
      }, gs.autoPlayDelay * 2);
    }
  }
}

// پردازش حرکت کارت
function processPlayCard(session, username, card) {
  console.log("processPlayCard invoked for", username);
  const gs = session.gameState;
  if (!gs) return;
  const player = gs.players.find(p => p.username === username);
  if (!player) return;
  const hand = gs.hands[player.username];
  const cardIndex = hand.findIndex(c => c.id === card.id);
  if (cardIndex === -1) return;
  
  // حذف کارت از دست و اضافه کردن به میز
  const playedCard = hand.splice(cardIndex, 1)[0];
  gs.table.push({ player, card: playedCard });
  io.in(session.sessionId).emit("cardOnTable", { player: username, card: mapCardToEnum(playedCard) });
  console.log("Emit cardOnTable:", { player: username, card: mapCardToEnum(playedCard) });
  // اگر اولین کارت بازی شده است، leadSuit تنظیم می‌شود
  if (gs.table.length === 1) { 
    const mappedFirst = mapCardToEnum(playedCard); 
    gs.leadSuit = mappedFirst.suit;
    console.log("Now leadSuit is:", gs.leadSuit );
  }
  // پاکسازی تایمر auto‑play
  if (session.autoPlayTimer) {
    clearTimeout(session.autoPlayTimer);
    session.autoPlayTimer = null;
  }
  
  // بررسی پایان ترک: اگر تعداد کارت‌های بازی شده برابر با تعداد بازیکنان باشد
  if (gs.table.length === gs.players.length) {
    console.log("All cards played. Last card:", gs.table[gs.players.length - 1]);
    setTimeout(() => {
      // تعیین برنده ترک
      let winnerEntry = gs.table[0];
      let winnerMapped = mapCardToEnum(winnerEntry.card);
      for (let i = 1; i < gs.table.length; i++) {
        const curr = gs.table[i];
        const currMapped = mapCardToEnum(curr.card);
        if (
          (currMapped.suit === gs.trumpSuit && winnerMapped.suit !== gs.trumpSuit) ||
          (currMapped.suit === winnerMapped.suit && currMapped.rank > winnerMapped.rank)
        ) {
          winnerEntry = curr;
          winnerMapped = currMapped;
        }
      }
      // اعطای امتیاز به تیم برنده ترک
      gs.teamPoints[`team${winnerEntry.player.team}`] += 1;
      io.in(session.sessionId).emit("gameStateUpdate", buildGameStateDelta(session));
      io.in(session.sessionId).emit("handOver", {
           winner: winnerEntry.player.username,
           cards:   gs.table.map(e => mapCardToEnum(e.card))
      });
      console.log("[SRV] processPlayCard: emitted hand-over, winner=", winnerEntry.player.username);
      gs.step = "hand-over";
      io.in(session.sessionId).emit("gameStateUpdate", buildGameStateDelta(session));
      
      // اگر امتیاز تیم برنده به حد HANDS_REQUIRED رسیده باشد
      if (gs.teamPoints[`team${winnerEntry.player.team}`] >= HANDS_REQUIRED) {
        gs.teamWins[`team${winnerEntry.player.team}`] += 1;
        gs.teamPoints = { team1: 0, team2: 0 };
        // ثبت تیم برنده آخرین راند
        gs.lastRoundWinnerTeam = winnerEntry.player.team;
        
        // بررسی پایان بازی
        if (gs.teamWins.team1 >= WINS_REQUIRED || gs.teamWins.team2 >= WINS_REQUIRED) {
          io.in(session.sessionId).emit("roundOver", { teamWins: gs.teamWins });
          setTimeout(() => {
            gs.step = "game-over";
            gs.message = gs.teamWins.team1 >= WINS_REQUIRED ? "YOU WON" : "YOU LOST";
            io.in(session.sessionId).emit("gameOver", {
              winner:  gs.teamWins.team1 >= WINS_REQUIRED ? 1 : 2,
              message: gs.message
            });
            io.in(session.sessionId).emit("gameStateUpdate", buildGameStateDelta(session));
            console.log("[SRV] processPlayCard: emitted game-over, winner=", gs.step, gs.message);
            // پاک‌سازی کامل جلسه پس از پایان بازی:
            clearTimeout(session.autoPlayTimer);
            clearTimeout(session.timeoutId);
            // از آرایه sessions حذفش کن
            sessions.delete(session.sessionId);
            
            // حذف پراپرتی sessionId از هر سوکت در اتاق
            const roomId = session.sessionId;
            const socketsInRoom = io.sockets.adapter.rooms.get(roomId);
            if (socketsInRoom) {
              for (const socketId of socketsInRoom) {
                const sock = io.sockets.sockets.get(socketId);
                if (sock) delete sock.sessionId;
              }
            }
            // خارج کردن سوکت‌ها از اتاق
            io.in(roomId).socketsLeave(roomId);
          }, DELAY_TIME * 2);
          return;
        } else {
          // پایان راند؛ وارد فاز select‑trump می‌شویم
          gs.step    = 'round-over';
          io.in(session.sessionId).emit("roundOver", { teamWins: gs.teamWins });
          io.in(session.sessionId).emit("gameStateUpdate", buildGameStateDelta(session));
          console.log("[SRV] processPlayCard: emitted roundOver", gs.teamWins);
          setTimeout(() => {
            startNewRound(session);
          }, DELAY_TIME * 2);
          return;
        }
      }
      
      // تنظیم نوبت بازی برای ترک بعدی بر اساس برنده ترک
      gs.turn = gs.players.findIndex(p => p.username === winnerEntry.player.username);
      // پاکسازی ترک و leadSuit
      gs.table = [];
      gs.leadSuit = null;
      gs.step = "play";
      io.in(session.sessionId).emit("gameStateUpdate", buildGameStateDelta(session));
      checkAutoPlay(session);
    }, DELAY_TIME);
  } else {
    // اگر ترک کامل نشده است، نوبت بازی برای بازیکن بعدی تنظیم می‌شود
    if (gs.trumpSuit === null || gs.trumpSuit === undefined) {
      console.error("Trump suit is not set. Reverting to select-trump phase.", gs.trumpSuit);
      gs.step = "select-trump"; // برگشت به فاز انتخاب حکم
      io.in(session.sessionId).emit("gameStateUpdate", buildGameStateDelta(session)); // برگشت به فاز انتخاب حکم
      checkAutoPlay(session); // فراخوانی مجدد تابع checkAutoPlay تا در صورت نیاز autoPlay اجرا شود
      return; // تغییر نوبت انجام نمی‌شود
    }
    setTimeout(() => {
      gs.turn = (gs.turn + 1) % gs.players.length;
      gs.step = "play";
      io.in(session.sessionId).emit("gameStateUpdate", buildGameStateDelta(session));
      checkAutoPlay(session);
    }, Math.floor(DELAY_TIME / 4));
  }
}

// مدیریت رویدادهای Socket.io
io.on("connection", (socket) => {
  console.log("A user connected:", socket.id);
  socket.on("register", (data) => {
    const { username } = data;
    // اعتبارسنجی ساده
    if (typeof username !== "string" || username.length < 6) {
      // پاسخ خطا
      return socket.emit("registerResponse", {
        success: false,
        userId:   null,
        message: "Invalid username"
      });
    }
    const userId = Date.now().toString();
    console.log("User registered:", username, userId);
  
    // پاسخ موفق
    socket.emit("registerResponse", {
      success: true,
      userId:   userId,
      message: "Successful Registration!"
    });
  });

  socket.on("joinWaitingRoom", data => {
    // ۱) اگر socket.sessionId وجود دارد...
    if (socket.sessionId) {
      // ۲) بررسی کن آیا هنوز آن session در sessions باقی است؟
      const existing = sessions.get(socket.sessionId);
      if (existing) {
        // هنوز در بازی جاری هستیم، پس نادیده بگیر
        console.log( `[SRV] joinWaitingRoom ignored for ${data.username}; already in session ${socket.sessionId}` );
        return;
      } else {
        // جلسه قبلی تمام شده و stale است: پراپرتی را پاک کن
        console.log( `[SRV] stale sessionId ${socket.sessionId} for ${data.username}, clearing` );
        delete socket.sessionId;
      }
    }
    console.log("[SRV] joinWaitingRoom:", data);
    let session = null;
    for (const s of sessions.values()) {  // یافتن یا ساخت سشن
      if (!s.locked && s.waitingPlayers.length < 4) {session = s; break;}
    }
    if (!session) {
      session = {
        sessionId:      Date.now().toString(),
        waitingPlayers: [],
        gameState:      null,
        locked:         false,
        timeoutId:      null,
        autoPlayTimer:  null
      };
      sessions.set(session.sessionId, session);
    }
    // اضافه کردن بازیکن
    if (!session.waitingPlayers.some(p => p.username === data.username)) { // اگر کاربر با همان یوزرنیم از قبل نیست، اضافه کن
      session.waitingPlayers.push({
        username:     data.username,
        socketId:     socket.id,
        disconnected: false,
        isBot:        false,
        avatar:       data.avatar || null
      });
    }
    socket.sessionId = session.sessionId;
    socket.join(session.sessionId);
    console.log(`[Server] Socket ${socket.id} joined room ${session.sessionId}`);
    // اگر اولین بازیکن است، تایمر لابی را آغاز کن
    if (session.waitingPlayers.length === 1) {
      let remaining = LOBBY_DURATION/1000;
      session.countdownInterval = setInterval(() => {
        remaining--;
        // ارسال مقدار جدید به همهٔ یونیتی‌های داخل همان اتاق
        io.in(socket.sessionId).emit("countdown", remaining);
        
        if (remaining <= 0) {
          clearInterval(session.countdownInterval);
          if (!session.gameState) startGameHelper(session);          
          io.in(session.sessionId).emit("playerListUpdate",
            session.waitingPlayers.map(p => ({
              username:     p.username,
              disconnected: p.disconnected,
              avatar:       p.avatar || null,
              isBot:        p.isBot
            }))
          )
          return;          
        }
      }, 1000);
    }
    console.log(
      `[SRV] Emitting playerListUpdate for sessionId ${session.sessionId}. ` +
      `Players: ${session.waitingPlayers.map(p => p.username).join(", ")}`
    );
    // به‌روزرسانی لیست فقط در این سشن
    io.in(session.sessionId).emit("playerListUpdate",
      session.waitingPlayers.map(p => ({
        username:     p.username,
        disconnected: p.disconnected,
        avatar:       p.avatar || null,
        isBot:        p.isBot
      }))
    );
    // وقتی ۴ بازیکن جمع شد
    if (session.waitingPlayers.length === 4 && !session.locked) {
      // قبل از شروع بازی، تایمر لابی قبلی را اگر فعال است لغو کن:
      if (session.timeoutId) {
        clearTimeout(session.timeoutId);
        session.timeoutId = null;
      }
      session.locked    = true;
      startGameHelper(session);
    }
    // در غیر این صورت، پس از LOBBY_DURATION شروع میکنیم (با بات‌ها)
    else if (!session.timeoutId) {
      session.timeoutId = setTimeout(() => {
        // انتساب آواتار تصادفی یکتا به هر بات
        const assigned = session.waitingPlayers.map(p => p.avatar);
        const available = BOT_AVATARS.filter(a => !assigned.includes(a));
        while (session.waitingPlayers.length < 4 && available.length > 0) {
          // انتخاب رندوم از available
          const idx = Math.floor(Math.random() * available.length);
          const avatar = available.splice(idx, 1)[0];
          const base = avatar.replace('.png', '');           // 'bot7'
          const number = base.match(/\d+$/)[0];
          const username = `Bot${number}`;
          session.waitingPlayers.push({
            username,
            socketId: null,
            isBot: true,
            disconnected: false,
            avatar
          });          
        }
        session.locked    = true;
        session.gameState = createGame(session.waitingPlayers);
        session.memories = {};
        session.waitingPlayers
          .filter(p => p.isBot)               // فقط بات‌ها
          .forEach(bot => {                   
            session.memories[bot.username] = initMemory();
          });
        setTimeout(() => {startGameHelper(session);}, START_DELAY);
        clearTimeout(session.timeoutId);
        session.timeoutId = null;
        checkAutoPlay(session);
        
      }, LOBBY_DURATION);
    }
  });
  
  socket.on("leaveWaitingRoom", data => {
    const sid = socket.sessionId;
    const session = sessions.get(sid);
    if (!session || !session.gameState || !session.gameState.hands) return;
    
    // پیدا کردن index بازیکن خروجی
    const idx = session.waitingPlayers.findIndex(p => p.username === data.username);
    if (idx === -1) return;
  
    // 1) تعیین نام بات جدید
    const botCount = session.waitingPlayers.filter(p => p.isBot).length + 1;
    const newBotUsername = `Bot${botCount}`;
  
    // 2) نگهداری دست قدیمی کاربر
    const oldUsername = data.username;
    const oldHand = session.gameState.hands[oldUsername] || [];
  
    // 3) حذف کلید قدیمی و اضافه کردن با نام بات
    delete session.gameState.hands[oldUsername];
    session.gameState.hands[newBotUsername] = oldHand;
  
    // 4) تبدیل در waitingPlayers و gameState.players
    session.waitingPlayers[idx] = {
      ...session.waitingPlayers[idx],
      username: newBotUsername,
      socketId: null,
      isBot: true,
      disconnected: false
    };
    session.gameState.players = session.gameState.players.map(p =>
      p.username === oldUsername
        ? { ...p, username: newBotUsername, socketId: null, isBot: true, disconnected: false }
        : p
    );
  
    // 5) سوکت را از روم خارج کن
    socket.leave(sid);
    socket.sessionId = null;
    
    // 6) ارسال state به بقیه
    io.in(sid).emit("gameStateUpdate", buildGameStateDelta(session));
    checkAutoPlay(session);
  });    
  
  socket.on("disconnect", () => {
    const sid = socket.sessionId;
    console.log("A user disconnected:", socket.id, "from session", sid);
    const session = sessions.get(sid);
    if (!session) return;
    const pl = session.waitingPlayers.find(p => p.socketId === socket.id);
    if (pl) {
      pl.disconnected = true;
      io.in(sid).emit("playerListUpdate",
        session.waitingPlayers.map(p => ({
          username:     p.username,
          disconnected: p.disconnected,
          avatar:       p.avatar
        }))
      );
    }
  });

  socket.on("revertToSelectTrump", (data) => {
    const session = sessions.get(socket.sessionId);
    if (session && session.gameState && session.gameState.trumpSuit === null || session.gameState.trumpSuit === undefined) {
      console.error("Reverting game phase to select-trump because trump suit is not set.");
      session.gameState.step = "select-trump";
      io.in(session.sessionId).emit("gameStateUpdate", buildGameStateDelta(session));
      checkAutoPlay(session);
    }
  });
  
  socket.on("deckReady", data => {
    // dealInitial5 is finished and ready for trump selection
    const session = sessions.get(socket.sessionId);
    session.gameState.step = 'select-trump';
    io.in(session.sessionId).emit("selectTrump", { dealer: session.gameState.dealer });
    console.log("[SRV] startGameHelper: emitted selectTrump with dealer:", session.gameState.dealer);
    // فراخوانی autoPlay
    checkAutoPlay(session);
  });

  socket.on("trumpSelected", data => {
    const sid = socket.sessionId;
    const session = sessions.get(sid);
    if (!session || !session.gameState) return;
    // فقط dealer حق انتخاب دارد
    const gs = session.gameState;
    if (gs.dealer !== data.username) return;
    // 1. تنظیم حکم
    gs.trumpSuit = data.suit;
    io.in(sid).emit("gameStateUpdate", buildGameStateDelta(session));
    console.log("Trump Suit is selected:", gs.trumpSuit);
    gs.step      = "dealing-remaining";
    // 2. ذخیرهٔ ۸ کارت باقی‌مانده در هر دست (ولی هنوز ارسال نمی‌کنیم)
    const handsRemaining = {};
    gs.players.forEach(p => {
      const extraRaw = gs.deck.splice(0, 8);
      const extraMapped = extraRaw.map(card => mapCardToEnum(card));
      // اضافه کردن به hand اولیه و مرتب‌سازی
      const combined = sortHand([...gs.hands[p.username], ...extraRaw]);
      gs.hands[p.username] = combined;
      handsRemaining[p.username] = extraMapped; // نگهداری فقط کارت‌های جدید
    });

    // 3. ارسال dealRemaining8 به کلاینت تا انیمیشن اجرا شود
    io.in(sid).emit("dealRemaining8", { hands: handsRemaining });
    console.log("dealRemaining8 sent with 8 cards per player:", handsRemaining);
  });

  socket.on('dealEnd', data => {  // پس از اتمام توزیع کارت‌ها، وارد فاز play شویم و وضعیت را اعلام کنیم
    const sid = socket.sessionId;
    const session = sessions.get(sid);
    const gs = session.gameState;
    gs.step = "play";
    io.in(sid).emit("gameStateUpdate", buildGameStateDelta(session));
    console.log("dealEnd received, gameStateUpdate sent with: ", buildGameStateDelta(session));
    checkAutoPlay(session);
  });

  socket.on('cardPlayed', data => {
    const sid = socket.sessionId;
    const session = sessions.get(sid);
    if (!session || !session.gameState) {
      console.warn(`[Server] cardPlayed: invalid session ${sid}`);
      return;
    }
    // چک کردن کارت بازی شده در سرور
    const gs = session.gameState;
    const player = gs.players[gs.turn].username;
    if (data.player !== player) {
      console.warn(`[Server] cardPlayed: not your turn (${data.player})`);
      socket.emit('invalidMove', { reason: 'not your turn' });
      return;}
    if (gs.leadSuit !== null && gs.leadSuit !== undefined) {
      const hand = gs.hands[player];
      const numericHand = hand.map(c => mapCardToEnum(c).suit);
      const hasLead = numericHand.includes(gs.leadSuit);
      if (hasLead && data.card.suit !== gs.leadSuit) { 
        console.warn(`[Server] cardPlayed: must follow suit ${gs.leadSuit}`);
        socket.emit('invalidMove', { reason: 'must follow suit', leadSuit: gs.leadSuit });
        return;}
    }
    console.log('[Server] Received valid cardPlayed:', data);
    try {
      processPlayCard(session, data.player, data.card);
    } catch (err) {
      console.error('[Server] Error in cardPlayed handler:', err);
      // Notify this client of a server‐side error
      socket.emit('serverError', {
        message: 'An unexpected server error occurred while playing your card. Your entry fee will be refunded.'
      });
    }
  });

  socket.on("rejoinWaitingRoom", data => {
    console.log("[SRV] rejoinWaitingRoom:", data);
    const session = sessions.get(data.sessionId);
    if (!session || !session.gameState || session.gameState.step === 'game-over') {
      console.log("[SRV] rejoin failed, session not found:", data.sessionId);
      socket.emit("rejoinFailed", { reason: "sessionNotFound", sessionId: data.sessionId });
      return;
    }
  
    // پیدا کردن بازیکن در waitingPlayers
    const pl = session.waitingPlayers.find(p => p.username === data.username);
    if (!pl) return;
  
    // ۱) بروزرسانی socketId و disconnected برای waitingPlayers
    pl.socketId = socket.id;
    pl.disconnected = false;
    if (data.avatar) pl.avatar = data.avatar;
  
    // ۲) پاک کردن تایمر auto-play قبلی (در صورت وجود)
    if (session.autoPlayTimer) {
      clearTimeout(session.autoPlayTimer);
      session.autoPlayTimer = null;
    }
  
    // ۳) هم‌زمان به‌روزرسانی آرایه‌ی gameState.players
    session.gameState.players = session.gameState.players.map(p =>
      p.username === data.username
        ? { ...p, socketId: socket.id, disconnected: false }
        : p
    );
  
    // عضویت دوباره‌ی سوکت در room
    socket.sessionId = session.sessionId;
    socket.join(session.sessionId);
    console.log(`Player ${data.username} rejoined session ${session.sessionId}`);
  
    // ۴) اگر بازی شروع شده، وضعیت را به آن کلاینت و بقیه emit کن
    if (session.gameState) {
      socket.emit("rejoinGame", {
        gameState: session.gameState,
        sessionId: session.sessionId
      });
      io.in(session.sessionId).emit("gameStateUpdate", buildGameStateDelta(session));
  
      // ۵) از سرگیری منطق auto-play
      checkAutoPlay(session);
  
    } else {
      // در صورتی که هنوز در لابی هستید، فقط لیست بازیکنان را به‌روز کن
      io.in(session.sessionId).emit("playerListUpdate",
        session.waitingPlayers.map(p => ({
          username: p.username,
          disconnected: p.disconnected,
          avatar: p.avatar,
          isBot: p.isBot
        }))
      );
    }
  });    
  
});

const PORT = 5000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server is running on port ${PORT}`));
