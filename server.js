// server.js
import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const rooms = new Map(); // roomCode -> roomState

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function getRandomLetter() {
  // فارسی: می‌تونی بعداً لیست حروف رو دقیق‌تر کنی
  const letters = ["ا","ب","پ","ت","ث","ج","چ","ح","خ","د","ذ","ر","ز","ژ","س","ش","ص","ض","ط","ظ","ع","غ","ف","ق","ک","گ","ل","م","ن","و","ه","ی"];
  return letters[Math.floor(Math.random() * letters.length)];
}

function ensureRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, {
      code,
      hostSocketId: null,
      players: new Map(), // socketId -> {name}
      status: "lobby", // lobby | playing | reviewing
      round: 0,
      letter: null,
      endsAt: null,
      durationSec: 90,
      submissions: new Map(), // socketId -> answers
      categories: ["name","family","city","country","food","animal"] // ids ثابت
    });
  }
  return rooms.get(code);
}

function publicRoomState(room) {
  return {
    code: room.code,
    hostSocketId: room.hostSocketId,
    status: room.status,
    round: room.round,
    letter: room.letter,
    endsAt: room.endsAt,
    durationSec: room.durationSec,
    categories: room.categories,
    players: Array.from(room.players.entries()).map(([id, p]) => ({ id, name: p.name })),
    submissionsCount: room.submissions.size
  };
}

io.on("connection", (socket) => {
  socket.on("room:create", ({ name }, cb) => {
    const code = makeRoomCode();
    const room = ensureRoom(code);
    room.hostSocketId = socket.id;
    room.players.set(socket.id, { name: String(name || "Player").slice(0, 20) });

    socket.join(code);
    io.to(code).emit("room:state", publicRoomState(room));
    cb?.({ ok: true, code, isHost: true });
  });

  socket.on("room:join", ({ code, name }, cb) => {
    code = String(code || "").trim().toUpperCase();
    if (!rooms.has(code)) return cb?.({ ok: false, error: "ROOM_NOT_FOUND" });

    const room = rooms.get(code);
    room.players.set(socket.id, { name: String(name || "Player").slice(0, 20) });
    socket.join(code);

    io.to(code).emit("room:state", publicRoomState(room));
    cb?.({ ok: true, code, isHost: room.hostSocketId === socket.id });
  });

  socket.on("game:start", ({ code, durationSec }, cb) => {
    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, error: "ROOM_NOT_FOUND" });
    if (room.hostSocketId !== socket.id) return cb?.({ ok: false, error: "NOT_HOST" });
    if (room.players.size < 1) return cb?.({ ok: false, error: "NO_PLAYERS" });

    room.status = "playing";
    room.round += 1;
    room.letter = getRandomLetter();
    room.durationSec = Math.min(Math.max(parseInt(durationSec || 90, 10), 20), 300);
    room.endsAt = Date.now() + room.durationSec * 1000;
    room.submissions = new Map();

    io.to(code).emit("game:started", publicRoomState(room));
    io.to(code).emit("room:state", publicRoomState(room));
    cb?.({ ok: true });
  });

  socket.on("game:submit", ({ code, answers }, cb) => {
    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, error: "ROOM_NOT_FOUND" });
    if (room.status !== "playing") return cb?.({ ok: false, error: "NOT_PLAYING" });

    // answers: { name:"", family:"", ... }
    const clean = {};
    for (const cat of room.categories) {
      clean[cat] = String(answers?.[cat] ?? "").slice(0, 60);
    }
    room.submissions.set(socket.id, clean);

    io.to(code).emit("room:state", publicRoomState(room));

    // اگر همه ارسال کردند، زودتر برو به review
    if (room.submissions.size === room.players.size) {
      room.status = "reviewing";
      io.to(code).emit("game:review", { room: publicRoomState(room), submissions: getSubmissions(room) });
      io.to(code).emit("room:state", publicRoomState(room));
    }

    cb?.({ ok: true });
  });

  socket.on("game:forceReview", ({ code }, cb) => {
    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, error: "ROOM_NOT_FOUND" });
    if (room.hostSocketId !== socket.id) return cb?.({ ok: false, error: "NOT_HOST" });

    room.status = "reviewing";
    io.to(code).emit("game:review", { room: publicRoomState(room), submissions: getSubmissions(room) });
    io.to(code).emit("room:state", publicRoomState(room));
    cb?.({ ok: true });
  });

  socket.on("disconnecting", () => {
    for (const code of socket.rooms) {
      if (code === socket.id) continue;
      const room = rooms.get(code);
      if (!room) continue;

      room.players.delete(socket.id);
      room.submissions.delete(socket.id);

      // اگر میزبان رفت، میزبان را اولین نفر کن
      if (room.hostSocketId === socket.id) {
        const next = room.players.keys().next().value || null;
        room.hostSocketId = next;
      }

      // اگر اتاق خالی شد حذفش کن
      if (room.players.size === 0) {
        rooms.delete(code);
      } else {
        io.to(code).emit("room:state", publicRoomState(room));
      }
    }
  });
});

function getSubmissions(room) {
  return Array.from(room.submissions.entries()).map(([socketId, ans]) => ({
    playerId: socketId,
    playerName: room.players.get(socketId)?.name || "Player",
    answers: ans
  }));
}

// تایمر سمت سرور: وقتی راند شروع شد، بعد از durationSec برو review
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.status === "playing" && room.endsAt && now >= room.endsAt) {
      room.status = "reviewing";
      io.to(room.code).emit("game:review", { room: publicRoomState(room), submissions: getSubmissions(room) });
      io.to(room.code).emit("room:state", publicRoomState(room));
    }
  }
}, 500);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));

