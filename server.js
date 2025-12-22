// server.js
import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const DEFAULT_DURATION_SEC = 120;

const DEFAULT_CATEGORIES = [
  "name",
  "family",
  "city",
  "country",
  "animal",
  "food",
  "fruit",
  "object",
  "color",
  "job",
];

const rooms = new Map(); // code -> roomState

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function normalizeAnswer(v) {
  return String(v ?? "").trim().toLowerCase();
}

function ensureRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, {
      code,
      hostSocketId: null,
      status: "lobby", // lobby | playing
      round: 0,
      letter: "",
      endsAt: null,
      durationSec: DEFAULT_DURATION_SEC,
      categories: DEFAULT_CATEGORIES.slice(),
      players: new Map(), // socketId -> { name }
      submissions: new Map(), // socketId -> { [cat]: answer }
      totalScores: new Map(), // socketId -> total
      timer: null,
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

    // ✅ امتیاز کل برای نمایش
    totals: Array.from(room.totalScores.entries()).map(([id, score]) => ({ id, score })),

    players: Array.from(room.players.entries()).map(([id, p]) => ({ id, name: p.name })),
    submissionsCount: room.submissions.size,
  };
}

/**
 * submissions: Map(socketId -> answersObj)
 * categories: string[]
 * returns roundScores: Map(socketId->points)
 */
function computeRoundScores(submissions, categories) {
  const roundScores = new Map();
  for (const pid of submissions.keys()) roundScores.set(pid, 0);

  for (const cat of categories) {
    const counts = new Map();

    for (const [, answers] of submissions.entries()) {
      const norm = normalizeAnswer(answers?.[cat]);
      if (!norm) continue;
      counts.set(norm, (counts.get(norm) || 0) + 1);
    }

    for (const [pid, answers] of submissions.entries()) {
      const norm = normalizeAnswer(answers?.[cat]);
      let pts = 0;
      if (!norm) pts = 0;
      else pts = (counts.get(norm) >= 2) ? 10 : 20; // تکراری 10، یکتا 20
      roundScores.set(pid, (roundScores.get(pid) || 0) + pts);
    }
  }

  return roundScores;
}

function startRound(room, durationSec) {
  // پاک‌سازی submissions راند قبل
  room.submissions.clear();

  room.status = "playing";
  room.round += 1;
  room.durationSec = Math.max(DEFAULT_DURATION_SEC, Number(durationSec || DEFAULT_DURATION_SEC));

  // حرف رندوم فارسی (ساده)
  const letters = ["ا","ب","پ","ت","ث","ج","چ","ح","خ","د","ذ","ر","ز","ژ","س","ش","ص","ض","ط","ظ","ع","غ","ف","ق","ک","گ","ل","م","ن","و","ه","ی"];
  room.letter = letters[Math.floor(Math.random() * letters.length)];

  const now = Date.now();
  room.endsAt = now + room.durationSec * 1000;

  // تایمر سرور
  if (room.timer) clearTimeout(room.timer);
  room.timer = setTimeout(() => endRound(room), room.durationSec * 1000);

  io.to(room.code).emit("room:state", publicRoomState(room));
}

function endRound(room) {
  if (room.status !== "playing") return;

  room.status = "lobby";
  room.endsAt = null;

  // محاسبه نمره این راند
  const roundScores = computeRoundScores(room.submissions, room.categories);

  // جمع به امتیاز کل
  for (const [pid, pts] of roundScores.entries()) {
    room.totalScores.set(pid, (room.totalScores.get(pid) || 0) + pts);
  }

  io.to(room.code).emit("scores:update", {
    totals: Array.from(room.totalScores.entries()).map(([id, score]) => ({ id, score })),
    round: Array.from(roundScores.entries()).map(([id, score]) => ({ id, score })),
  });

  io.to(room.code).emit("room:state", publicRoomState(room));
}

io.on("connection", (socket) => {
  socket.on("room:create", ({ name }, cb) => {
    const code = makeRoomCode();
    const room = ensureRoom(code);

    room.hostSocketId = socket.id;
    room.players.set(socket.id, { name: String(name || "Player").slice(0, 20) });
    if (!room.totalScores.has(socket.id)) room.totalScores.set(socket.id, 0);

    socket.join(code);
    io.to(code).emit("room:state", publicRoomState(room));
    cb?.({ ok: true, code });
  });

  socket.on("room:join", ({ code, name }, cb) => {
    code = String(code || "").toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, error: "ROOM_NOT_FOUND" });

    room.players.set(socket.id, { name: String(name || "Player").slice(0, 20) });
    if (!room.totalScores.has(socket.id)) room.totalScores.set(socket.id, 0);

    socket.join(code);
    io.to(code).emit("room:state", publicRoomState(room));
    cb?.({ ok: true, code });
  });

  socket.on("room:leave", ({ code }) => {
    code = String(code || "").toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return;

    room.players.delete(socket.id);
    room.submissions.delete(socket.id);
    room.totalScores.delete(socket.id);

    socket.leave(code);

    // اگر میزبان رفت، یک میزبان جدید تعیین کن
    if (room.hostSocketId === socket.id) {
      const next = room.players.keys().next().value || null;
      room.hostSocketId = next;
    }

    // اگر هیچ‌کس نماند، اتاق را پاک کن
    if (room.players.size === 0) {
      if (room.timer) clearTimeout(room.timer);
      rooms.delete(code);
      return;
    }

    io.to(code).emit("room:state", publicRoomState(room));
  });

  socket.on("round:start", ({ code, durationSec }, cb) => {
    code = String(code || "").toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, error: "ROOM_NOT_FOUND" });
    if (room.hostSocketId !== socket.id) return cb?.({ ok: false, error: "NOT_HOST" });

    startRound(room, durationSec);
    cb?.({ ok: true });
  });

  socket.on("round:end", ({ code }, cb) => {
    code = String(code || "").toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, error: "ROOM_NOT_FOUND" });
    if (room.hostSocketId !== socket.id) return cb?.({ ok: false, error: "NOT_HOST" });

    endRound(room);
    cb?.({ ok: true });
  });

  socket.on("submit", ({ code, answers }, cb) => {
    code = String(code || "").toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, error: "ROOM_NOT_FOUND" });
    if (room.status !== "playing") return cb?.({ ok: false, error: "NOT_PLAYING" });

    // فقط دسته‌های مجاز
    const safe = {};
    for (const cat of room.categories) safe[cat] = String(answers?.[cat] ?? "");

    room.submissions.set(socket.id, safe);

    io.to(code).emit("room:state", publicRoomState(room));
    cb?.({ ok: true });
  });

  socket.on("disconnect", () => {
    // حذف از همه اتاق‌ها
    for (const [code, room] of rooms.entries()) {
      if (room.players.has(socket.id)) {
        room.players.delete(socket.id);
        room.submissions.delete(socket.id);
        room.totalScores.delete(socket.id);

        if (room.hostSocketId === socket.id) {
          const next = room.players.keys().next().value || null;
          room.hostSocketId = next;
        }

        if (room.players.size === 0) {
          if (room.timer) clearTimeout(room.timer);
          rooms.delete(code);
        } else {
          io.to(code).emit("room:state", publicRoomState(room));
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
