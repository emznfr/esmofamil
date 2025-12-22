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
        submissions: Array.from(room.submissions.entries()).map(([id, answers]) => ({
            id, name: room.players.get(id)?.name, answers
        }))
    };
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

    socket.on("round:start", ({ code, durationSec }) => {
        const room = rooms.get(code);
        if (room && room.hostSocketId === socket.id) {
            room.submissions.clear();
            room.status = "playing";
            room.round += 1;
            room.durationSec = Number(durationSec || DEFAULT_DURATION_SEC);
            const letters = ["ا","ب","پ","ت","ث","ج","چ","ح","خ","د","ذ","ر","ز","ژ","س","ش","ص","ض","ط","ظ","ع","غ","ف","ق","ک","گ","ل","م","ن","و","ه","ی"];
            room.letter = letters[Math.floor(Math.random() * letters.length)];
            room.endsAt = Date.now() + room.durationSec * 1000;
            if (room.timer) clearTimeout(room.timer);
            room.timer = setTimeout(() => {
                room.status = "review"; // تغییر وضعیت به بازبینی کلمات
                io.to(room.code).emit("room:state", publicRoomState(room));
            }, room.durationSec * 1000);
            io.to(room.code).emit("room:state", publicRoomState(room));
        }
    });

    socket.on("submit", ({ code, answers }, cb) => {
        const room = rooms.get(code);
        if (room && room.status === "playing") {
            room.submissions.set(socket.id, answers);
            cb?.({ ok: true });
        }
    });

    // ثبت امتیاز دستی توسط میزبان
    socket.on("host:assign_score", ({ code, playerId, points }) => {
        const room = rooms.get(code);
        if (room && room.hostSocketId === socket.id) {
            const currentTotal = room.totalScores.get(playerId) || 0;
            room.totalScores.set(playerId, currentTotal + Number(points));
            io.to(code).emit("room:state", publicRoomState(room));
        }
    });

    socket.on("round:finish_review", ({ code }) => {
        const room = rooms.get(code);
        if (room && room.hostSocketId === socket.id) {
            room.status = "lobby";
            io.to(code).emit("room:state", publicRoomState(room));
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

server.listen(3000, () => console.log("Server running on port 3000"));
