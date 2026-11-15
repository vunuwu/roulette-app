// Сервер рулетки honestiTG: оплата Telegram Stars + призы + бесплатная прокрутка.
// Без зависимостей, нужен Node.js 18+.
//
// Переменные окружения:
//   BOT_TOKEN       токен бота из @BotFather (обязательно)
//   PUBLIC_URL      публичный https-адрес сервера, например https://roulette.onrender.com (обязательно)
//   WEBHOOK_SECRET  любая случайная строка из букв/цифр (обязательно)
//   PORT            порт (хостинг обычно задаёт сам)
//   DATA_FILE       путь к файлу с данными (по умолчанию ./data.json)

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const BOT_TOKEN = process.env.BOT_TOKEN;
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const PORT = Number(process.env.PORT || 3000);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data.json");
const SPIN_PRICE = 100;                 // звёзд за прокрутку
const FREE_MS = 24 * 60 * 60 * 1000;    // интервал бесплатной прокрутки

if (!BOT_TOKEN || !WEBHOOK_SECRET) {
  console.error("Задайте переменные BOT_TOKEN и WEBHOOK_SECRET");
  process.exit(1);
}

// ---------- Призы (chance в процентах, сумма = 100) ----------
const FREE_PRIZES = [
  {name:"Пусто",desc:"В этот раз ничего не выпало",chance:73,imageIndex:0},
  {name:"1–5 скинов",desc:"+ доступ к почте",chance:15,imageIndex:1},
  {name:"10–20 скинов",desc:"без доступа к почте",chance:6,imageIndex:2},
  {name:"20–50 скинов",desc:"без доступа к почте",chance:3,imageIndex:3},
  {name:"100–150 скинов",desc:"без доступа к почте",chance:2,imageIndex:4},
  {name:"30 скинов",desc:"+ доступ к почте",chance:0.9,imageIndex:5},
  {name:"100 скинов",desc:"+ доступ к почте",chance:0.1,imageIndex:6}
];
// ВАЖНО: таблицу платных призов поставьте свою. Сейчас это заглушка.
const PAID_PRIZES = FREE_PRIZES;

function pick(prizes) {
  const roll = crypto.randomInt(0, 10000) / 100;
  let sum = 0;
  for (const p of prizes) { sum += p.chance; if (roll < sum) return p; }
  return prizes[0];
}

// ---------- Хранилище ----------
let db = { users: {} };   // users[id] = { lastFree, paidCredits, history: [] }
try { db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch {}
function save() {
  try { fs.writeFileSync(DATA_FILE + ".tmp", JSON.stringify(db)); fs.renameSync(DATA_FILE + ".tmp", DATA_FILE); }
  catch (e) { console.error("save error", e.message); }
}
function user(id) {
  if (!db.users[id]) db.users[id] = { lastFree: 0, paidCredits: 0, history: [], payments: [] };
  return db.users[id];
}

// ---------- Telegram ----------
async function tgApi(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)
  });
  const data = await r.json().catch(() => ({}));
  if (!data.ok) throw new Error(`${method}: ${data.description || r.status}`);
  return data.result;
}

// Проверка подписи initData мини-приложения
function verifyInitData(initData) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const str = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const calc = crypto.createHmac("sha256", secret).update(str).digest("hex");
  const a = Buffer.from(calc), b = Buffer.from(hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const age = Date.now() / 1000 - Number(params.get("auth_date") || 0);
  if (age > 24 * 3600) return null;
  try { return JSON.parse(params.get("user")); } catch { return null; }
}

// ---------- HTTP ----------
function send(res, status, obj) {
  res.writeHead(status, {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"});
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise(resolve => {
    let s = "";
    req.on("data", c => { s += c; if (s.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(s || "{}")); } catch { resolve({}); } });
  });
}
function authUser(req, res) {
  const u = verifyInitData(req.headers["x-telegram-init-data"]);
  if (!u) { send(res, 401, {error: "Откройте рулетку внутри Telegram."}); return null; }
  return u;
}

const MIME = {".html":"text/html; charset=utf-8",".jpg":"image/jpeg",".jpeg":"image/jpeg",".png":"image/png",".webp":"image/webp",".gif":"image/gif",".svg":"image/svg+xml"};
function serveStatic(req, res) {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (!p.startsWith("/assets/")) p = "/index.html";   // любая страница = рулетка
  const file = path.join(__dirname, p);
  if (!file.startsWith(__dirname)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, {"Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream"});
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    // бот может открывать страницу по пути вида /roulette — убираем префикс
    req.url = req.url.replace(/^\/roulette(?=\/|\?|$)/, "") || "/";
    const url = req.url.split("?")[0];

    // CORS: страница может лежать на GitHub Pages, а сервер в Termux
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Telegram-Init-Data, X-Pinggy-No-Screen");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

    // Вебхук от Telegram
    if (req.method === "POST" && url === `/telegram/${WEBHOOK_SECRET}`) {
      const update = await readBody(req);
      res.writeHead(200); res.end("ok");
      handleUpdate(update).catch(e => console.error("update error", e.message));
      return;
    }

    // Основной бот сообщает сюда об успешной оплате (режим без своего вебхука)
    if (req.method === "POST" && url === "/internal/payment") {
      if (req.headers["x-secret"] !== WEBHOOK_SECRET) return send(res, 403, {error: "forbidden"});
      const b = await readBody(req);
      const d = user(b.userId);
      if (b.chargeId && d.payments.includes(b.chargeId)) return send(res, 200, {ok: true, duplicate: true});
      if (b.chargeId) d.payments.push(b.chargeId);
      d.paidCredits++;
      save();
      return send(res, 200, {ok: true});
    }

    if (req.method === "POST" && url === "/api/create-invoice") {
      const u = authUser(req, res); if (!u) return;
      const payload = `spin:${u.id}:${crypto.randomBytes(6).toString("hex")}`;
      try {
        const invoiceUrl = await tgApi("createInvoiceLink", {
          title: "Прокрутка рулетки",
          description: "Одна прокрутка рулетки honestiTG",
          payload,
          provider_token: "",
          currency: "XTR",
          prices: [{label: "Прокрутка", amount: SPIN_PRICE}]
        });
        return send(res, 200, {invoiceUrl});
      } catch (e) {
        console.error(e.message);
        return send(res, 500, {error: "Ошибка создания счёта: " + e.message});
      }
    }

    if (req.method === "POST" && url === "/api/spin") {
      const u = authUser(req, res); if (!u) return;
      const d = user(u.id);
      if (d.paidCredits <= 0) return send(res, 409, {error: "Оплата ещё не подтверждена."});
      d.paidCredits--;
      const prize = pick(PAID_PRIZES);
      d.history.push({t: Date.now(), type: "paid", prize: prize.name});
      save();
      return send(res, 200, prize);
    }

    if (req.method === "GET" && url === "/api/free-status") {
      const u = authUser(req, res); if (!u) return;
      const left = Math.max(0, FREE_MS - (Date.now() - user(u.id).lastFree));
      return send(res, 200, {msLeft: left});
    }

    if (req.method === "POST" && url === "/api/free-spin") {
      const u = authUser(req, res); if (!u) return;
      const d = user(u.id);
      const left = Math.max(0, FREE_MS - (Date.now() - d.lastFree));
      if (left > 0) return send(res, 429, {error: "Бесплатная прокрутка уже использована.", msLeft: left});
      d.lastFree = Date.now();
      const prize = pick(FREE_PRIZES);
      d.history.push({t: Date.now(), type: "free", prize: prize.name});
      save();
      return send(res, 200, prize);
    }

    if (req.method === "GET") return serveStatic(req, res);
    res.writeHead(404); res.end();
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, {error: "Ошибка сервера."});
  }
});

async function handleUpdate(update) {
  // Telegram требует ответить на pre_checkout_query в течение 10 секунд
  if (update.pre_checkout_query) {
    const q = update.pre_checkout_query;
    const ok = q.currency === "XTR" && q.total_amount === SPIN_PRICE && String(q.invoice_payload).startsWith(`spin:${q.from.id}:`);
    await tgApi("answerPreCheckoutQuery", ok
      ? {pre_checkout_query_id: q.id, ok: true}
      : {pre_checkout_query_id: q.id, ok: false, error_message: "Неверный счёт"});
    return;
  }
  const sp = update.message?.successful_payment;
  if (sp) {
    const id = update.message.from.id;
    const d = user(id);
    if (d.payments.includes(sp.telegram_payment_charge_id)) return;  // защита от повтора
    d.payments.push(sp.telegram_payment_charge_id);
    d.paidCredits++;
    save();
    console.log(`Оплата: user ${id}, charge ${sp.telegram_payment_charge_id}`);
  }
}

server.listen(PORT, async () => {
  console.log("Сервер запущен на порту", PORT);
  if (process.env.OWN_WEBHOOK !== "1") {
    console.log("Свой вебхук отключён: оплату должен подтверждать основной бот через /internal/payment.");
  } else if (PUBLIC_URL) {
    try {
      await tgApi("setWebhook", {
        url: `${PUBLIC_URL}/telegram/${WEBHOOK_SECRET}`,
        allowed_updates: ["pre_checkout_query", "message"]
      });
      console.log("Вебхук установлен:", `${PUBLIC_URL}/telegram/***`);
    } catch (e) { console.error("setWebhook error:", e.message); }
  } else {
    console.warn("PUBLIC_URL не задан: вебхук не установлен, оплата не подтвердится.");
  }
});
