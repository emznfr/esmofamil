import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const DEFAULT_DURATION_SEC = 120;
const DEFAULT_CATEGORIES = ["name", "family", "city", "country", "animal", "food", "fruit", "object", "color", "job"];
const rooms = new Map();

function makeRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
}

function normalizeAnswer(v) { return String(v ?? "").trim().toLowerCase(); }

function ensureRoom(code) {
    if (!rooms.has(code)) {
        rooms.set(code, {
            code, hostSocketId: null, status: "lobby", round: 0, letter: "", endsAt: null,
            durationSec: DEFAULT_DURATION_SEC, categories: DEFAULT_CATEGORIES.slice(),
            players: new Map(), submissions: new Map(), totalScores: new Map(), timer: null
        });
    }
    return rooms.get(code);
}

function publicRoomState(room) {
    return {
        code: room.code, hostSocketId: room.hostSocketId, status: room.status,
        round: room.round, letter: room.letter, endsAt: room.endsAt,
        durationSec: room.durationSec, categories: room.categories,
        totals: Array.from(room.totalScores.entries()).map(([id, score]) => ({ id, score })),
        players: Array.from(room.players.entries()).map(([id, p]) => ({ id, name: p.name })),
        submissionsCount: room.submissions.size,
    };
}

function computeRoundScores(submissions, categories) {
    const roundScores = new Map();
    for (const pid of submissions.keys()) roundScores.set(pid, 0);
    for (const cat of categories) {
        const counts = new Map();
        for (const [, answers] of submissions.entries()) {
            const norm = normalizeAnswer(answers?.[cat]);
            if (norm) counts.set(norm, (counts.get(norm) || 0) + 1);
        }
        for (const [pid, answers] of submissions.entries()) {
            const norm = normalizeAnswer(answers?.[cat]);
            if (norm) {
                const pts = (counts.get(norm) >= 2) ? 10 : 20;
                roundScores.set(pid, (roundScores.get(pid) || 0) + pts);
            }
        }
    }
    return roundScores;
}

function startRound(room, durationSec) {
    room.submissions.clear();
    room.status = "playing";
    room.round += 1;
    room.durationSec = Math.max(30, Number(durationSec || DEFAULT_DURATION_SEC));
    const letters = ["ا","ب","پ","ت","ث","ج","چ","ح","خ","د","ذ","ر","ز","ژ","س","ش","ص","ض","ط","ظ","ع","غ","ف","ق","ک","گ","ل","م","ن","و","ه","ی"];
    room.letter = letters[Math.floor(Math.random() * letters.length)];
    room.endsAt = Date.now() + room.durationSec * 1000;

    if (room.timer) clearTimeout(room.timer);
    room.timer = setTimeout(() => endRound(room), room.durationSec * 1000);

    io.to(room.code).emit("room:state", publicRoomState(room));
}

function endRound(room) {
    if (room.status !== "playing") return;
    room.status = "lobby";
    room.endsAt = null;
    const roundScores = computeRoundScores(room.submissions, room.categories);
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
        room.totalScores.set(socket.id, 0);
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

    socket.on("round:start", ({ code, durationSec }, cb) => {
        const room = rooms.get(code);
        if (room && room.hostSocketId === socket.id) {
            startRound(room, durationSec);
            cb?.({ ok: true });
        }
    });

    socket.on("submit", ({ code, answers }, cb) => {
        const room = rooms.get(code);
        if (room && room.status === "playing") {
            const safe = {};
            for (const cat of room.categories) safe[cat] = String(answers?.[cat] ?? "");
            room.submissions.set(socket.id, safe);
            io.to(code).emit("room:state", publicRoomState(room));
            cb?.({ ok: true });
        }
    });

    socket.on("disconnect", () => {
        for (const [code, room] of rooms.entries()) {
            if (room.players.has(socket.id)) {
                room.players.delete(socket.id);
                if (room.players.size === 0) {
                    if (room.timer) clearTimeout(room.timer);
                    rooms.delete(code);
                } else {
                    if (room.hostSocketId === socket.id) room.hostSocketId = room.players.keys().next().value;
                    io.to(code).emit("room:state", publicRoomState(room));
                }
            }
        }
    });
});

server.listen(3000, () => console.log(`Server on 3000`));
