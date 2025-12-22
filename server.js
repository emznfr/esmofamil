function startRound(room, durationSec) {
  room.submissions.clear();
  room.status = "playing";
  room.round += 1;

  // تعیین حروف الفبا بر اساس زبان اتاق (فرض می‌کنیم زبان در room.lang ذخیره شده)
  const alphabets = {
    fa: ["ا","ب","پ","ت","ث","ج","چ","ح","خ","د","ذ","ر","ز","ژ","س","ش","ص","ض","ط","ظ","ع","غ","ف","ق","ک","گ","ل","م","ن","و","ه","ی"],
    en: "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""),
    fr: "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("")
  };
  
  const currentLang = room.lang || 'fa';
  const selectedAlphabet = alphabets[currentLang];
  room.letter = selectedAlphabet[Math.floor(Math.random() * selectedAlphabet.length)];

  const now = Date.now();
  room.endsAt = now + room.durationSec * 1000;

  if (room.timer) clearTimeout(room.timer);
  room.timer = setTimeout(() => endRound(room), room.durationSec * 1000);

  io.to(room.code).emit("room:state", publicRoomState(room));
}
