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
    for (let i = 0; i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
}

function ensureRoom(code) {
    if (!rooms.has(code)) {
        rooms.set(code, {
            code,
            hostSocketId: null,
            status: "lobby",
            round: 0,
            letter: "",
            endsAt: null,
            durationSec: DEFAULT_DURATION_SEC,
            categories: DEFAULT_CATEGORIES.slice(),
            players: new Map(),
            submissions: new Map(),
            roundScores: new Map(),  // new: امتیاز این راند برای هر بازیکن
            totalScores: new Map(),
            timer: null
        });
    }
    return rooms.get(code);
}

function publicRoomState(room) {
    const submissions = Array.from(room.submissions.entries()).map(([id, answers]) => {
        const player = room.players.get(id);
        const roundScore = room.roundScores.get(id) || 0;
        return { id, name: player?.name, answers, roundScore };
    });

    return {
        code: room.code,
        hostSocketId: room.hostSocketId,
        status: room.status,
        round: room.round,
        letter: room.letter,
        endsAt: room.endsAt,
        durationSec: room.durationSec,
        categories: room.categories,
        totals: Array.from(room.totalScores.entries()).map(([id, score]) => ({ id, score })),
        players: Array.from(room.players.entries()).map(([id, p]) => ({ id, name: p.name })),
        submissions
    };
}

io.on("connection", (socket) => {
    socket.on("room:create", ({ name }, cb) => {
        const code = makeRoomCode();
        const room = ensureRoom(code);
        room.hostSocketId = socket.id;
        const safeName = String(name || "Player").slice(0, 20);
        room.players.set(socket.id, { name: safeName });
        room.totalScores.set(socket.id, 0);
        room.roundScores.set(socket.id, 0);
        socket.join(code);
        io.to(code).emit("room:state", publicRoomState(room));
        cb?.({ ok: true, code });
    });

    socket.on("room:join", ({ code, name }, cb) => {
        code = String(code || "").toUpperCase().trim();
        const room = rooms.get(code);
        if (!room) return cb?.({ ok: false });
        const safeName = String(name || "Player").slice(0, 20);
        room.players.set(socket.id, { name: safeName });
        if (!room.totalScores.has(socket.id)) room.totalScores.set(socket.id, 0);
        if (!room.roundScores.has(socket.id)) room.roundScores.set(socket.id, 0);
        socket.join(code);
        io.to(code).emit("room:state", publicRoomState(room));
        cb?.({ ok: true, code });
    });

    socket.on("round:start", ({ code, durationSec }) => {
        const room = rooms.get(code);
        if (room && room.hostSocketId === socket.id) {
            room.submissions.clear();
            room.roundScores.clear();
            room.players.forEach((_, id) => room.roundScores.set(id, 0));

            room.status = "playing";
            room.round += 1;
            room.durationSec = Number(durationSec || DEFAULT_DURATION_SEC);

            const letters = ["ا","ب","پ","ت","ث","ج","چ","ح","خ","د","ذ","ر","ز","ژ","س","ش","ص","ض","ط","ظ","ع","غ","ف","ق","ک","گ","ل","م","ن","و","ه","ی"];
            room.letter = letters[Math.floor(Math.random() * letters.length)];
            room.endsAt = Date.now() + room.durationSec * 1000;

            if (room.timer) clearTimeout(room.timer);
            room.timer = setTimeout(() => autoEndRoundIfAllSubmitted(room), room.durationSec * 1000);

            io.to(code).emit("room:state", publicRoomState(room));
        }
    });

    function autoEndRoundIfAllSubmitted(room) {
        if (room.status !== "playing") return;
        if (room.submissions.size === room.players.size) {
            room.status = "review";
            io.to(room.code).emit("room:state", publicRoomState(room));
        } else {
            // اگر هنوز همه نفرستادن، به هر حال بعد از تایمر برو به داوری
            room.status = "review";
            io.to(room.code).emit("room:state", publicRoomState(room));
        }
    }

    socket.on("submit", ({ code, answers }, cb) => {
        const room = rooms.get(code);
        if (room && room.status === "playing") {
            room.submissions.set(socket.id, answers);
            cb?.({ ok: true });

            // چک کن اگر همه ارسال کردن، زودتر برو داوری
            if (room.submissions.size === room.players.size) {
                clearTimeout(room.timer);
                autoEndRoundIfAllSubmitted(room);
            }

            io.to(code).emit("room:state", publicRoomState(room));
        }
    });

    socket.on("host:assign_score", ({ code, playerId, category, points }) => {
        const room = rooms.get(code);
        if (room && room.hostSocketId === socket.id && room.status === "review") {
            const currentRound = room.roundScores.get(playerId) || 0;
            // ما قبلاً امتیازات این راند رو داریم، فقط جمع کل رو آپدیت می‌کنیم وقتی داوری تموم شد
            // اینجا فقط جمع راند رو آپدیت می‌کنیم (برای نمایش)
            room.roundScores.set(playerId, currentRound + Number(points));
            io.to(code).emit("room:state", publicRoomState(room));
        }
    });

    socket.on("round:finish_review", ({ code }) => {
        const room = rooms.get(code);
        if (room && room.hostSocketId === socket.id) {
            // اضافه کردن امتیازات این راند به مجموع کل
            room.roundScores.forEach((score, id) => {
                const total = room.totalScores.get(id) || 0;
                room.totalScores.set(id, total + score);
            });

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
                    if (room.hostSocketId === socket.id) {
                        room.hostSocketId = room.players.keys().next().value || null;
                    }
                    io.to(code).emit("room:state", publicRoomState(room));
                }
            }
        }
    });
});

server.listen(3000, () => console.log("Server running on http://localhost:3000"));
