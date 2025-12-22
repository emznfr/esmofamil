import express from "express";
import http from "http";
import { Server } from "socket.io";
import crypto from "crypto";

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const DEFAULT_DURATION_SEC = 120;
const rooms = new Map();

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
      code, hostSocketId: null, status: "lobby", round: 0, letter: "",
      endsAt: null, durationSec: DEFAULT_DURATION_SEC, 
      categories: ["نام", "فامیل", "شهر", "کشور", "حیوان", "غذا", "میوه", "اشیاء", "رنگ", "شغل"],
      players: new Map(), submissions: new Map(), totalScores: new Map(), timer: null, lang: 'fa'
    });
  }
  return rooms.get(code);
}

function publicRoomState(room) {
  return {
    code: room.code, hostSocketId: room.hostSocketId, status: room.status,
    round: room.round, letter: room.letter, categories: room.categories,
    totals: Array.from(room.totalScores.entries()).map(([id, score]) => ({ id, score })),
    players: Array.from(room.players.entries()).map(([id, p]) => ({ id, name: p.name })),
    submissionsCount: room.submissions.size, lang: room.lang
  };
}

function computeRoundScores(submissions, categories, players) {
  const roundScores = new Map();
  players.forEach((_, pid) => roundScores.set(pid, 0));

  for (const cat of categories) {
    const counts = new Map();
    submissions.forEach(ans => {
      const norm = normalizeAnswer(ans?.[cat]);
      if (norm) counts.set(norm, (counts.get(norm) || 0) + 1);
    });

    players.forEach((_, pid) => {
      const answers = submissions.get(pid);
      const norm = normalizeAnswer(answers?.[cat]);
      if (norm) {
        const count = counts.get(norm);
        if (count === 1) {
          const othersHaveAnswer = Array.from(submissions.entries())
            .some(([id, a]) => id !== pid && normalizeAnswer(a[cat]));
          roundScores.set(pid, roundScores.get(pid) + (othersHaveAnswer ? 10 : 20));
        } else {
          roundScores.set(pid, roundScores.get(pid) + 5);
        }
      }
    });
  }
  return roundScores;
}

function endRound(room) {
  if (room.status !== "playing") return;
  if (room.timer) clearInterval(room.timer);
  room.status = "lobby";
  
  const roundScores = computeRoundScores(room.submissions, room.categories, room.players);
  roundScores.forEach((pts, pid) => {
    room.totalScores.set(pid, (room.totalScores.get(pid) || 0) + pts);
  });

  io.to(room.code).emit("scores:update", {
    totals: Array.from(room.totalScores.entries()).map(([id, score]) => ({ id, score })),
    round: Array.from(roundScores.entries()).map(([id, score]) => ({ id, score }))
  });
  io.to(room.code).emit("room:state", publicRoomState(room));
}

io.on("connection", (socket) => {
  socket.on("room:create", ({ name, lang }, cb) => {
    const code = makeRoomCode();
    const room = ensureRoom(code);
    room.lang = lang || 'fa';
    room.hostSocketId = socket.id;
    room.players.set(socket.id, { name: name || "Player" });
    room.totalScores.set(socket.id, 0);
    socket.join(code);
    cb?.({ ok: true, code });
    io.to(code).emit("room:state", publicRoomState(room));
  });

  socket.on("room:join", ({ code, name }, cb) => {
    const room = rooms.get(code?.toUpperCase());
    if (!room) return cb?.({ ok: false });
    room.players.set(socket.id, { name: name || "Player" });
    if (!room.totalScores.has(socket.id)) room.totalScores.set(socket.id, 0);
    socket.join(room.code);
    socket.emit("submissions:init", Array.from(room.submissions.entries()).map(([pid, answers]) => ({
      playerId: pid, name: room.players.get(pid)?.name, answers
    })));
    io.to(room.code).emit("room:state", publicRoomState(room));
    cb?.({ ok: true, code: room.code });
  });

  socket.on("round:start", ({ code }) => {
    const room = rooms.get(code);
    if (room && room.hostSocketId === socket.id && room.status !== "playing") {
      room.submissions.clear();
      room.status = "playing";
      room.round += 1;
      const alphabets = {
        fa: "ابپتثجچحخدذرژسشصضطظعغفقکگلمنوهی".split(""),
        en: "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""),
        fr: "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("")
      };
      room.letter = alphabets[room.lang][Math.floor(Math.random() * alphabets[room.lang].length)];
      
      let timeLeft = room.durationSec;
      io.to(room.code).emit("room:state", publicRoomState(room));
      
      if (room.timer) clearInterval(room.timer);
      room.timer = setInterval(() => {
        timeLeft--;
        io.to(room.code).emit("timer:tick", timeLeft);
        if (timeLeft <= 0) {
          clearInterval(room.timer);
          endRound(room);
        }
      }, 1000);
    }
  });

  socket.on("submit", ({ code, answers }, cb) => {
    const room = rooms.get(code);
    if (room && room.status === "playing") {
      room.submissions.set(socket.id, answers);
      io.to(code).emit("submission:added", {
        playerId: socket.id, name: room.players.get(socket.id)?.name, answers
      });
      cb?.({ ok: true });
    }
  });

  socket.on("disconnect", () => {
    rooms.forEach((room, code) => {
      if (room.players.has(socket.id)) {
        room.players.delete(socket.id);
        if (room.players.size === 0) {
          if (room.timer) clearInterval(room.timer);
          rooms.delete(code);
        } else {
          if (room.hostSocketId === socket.id) room.hostSocketId = room.players.keys().next().value;
          io.to(code).emit("room:state", publicRoomState(room));
        }
      }
    });
  });
});

server.listen(3000, () => console.log("Server ready on port 3000"));
