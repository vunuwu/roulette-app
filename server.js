import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const PORT = Number(process.env.PORT || 3000);
const DB_FILE = path.join(__dirname, "data.json");

if (!BOT_TOKEN) {
  console.error("Set BOT_TOKEN in environment before starting the server.");
  process.exit(1);
}

function readDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); }
  catch { return { invoices: {}, credits: {} }; }
}
function writeDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
function verifyInitData(initData) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const pairs = [...params.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`);
  const dataCheckString = pairs.join("\n");
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const calculated = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  const a = Buffer.from(calculated, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a,b)) return null;
  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Date.now()/1000 - authDate > 86400) return null;
  try { return JSON.parse(params.get("user") || "null"); } catch { return null; }
}
function getUser(req) {
  return verifyInitData(req.get("X-Telegram-Init-Data") || "");
}
async function telegram(method, body) {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)
  });
  const result = await response.json();
  if (!result.ok) throw new Error(result.description || `Telegram ${method} failed`);
  return result.result;
}

const PRIZES = [
  {name:"Пусто",desc:"В этот раз ничего не выпало",chance:55,imageIndex:0},
  {name:"Обычный приз",desc:"1–5 скинов",chance:30,imageIndex:0},
  {name:"Редкий приз",desc:"10–40 скинов",chance:10,imageIndex:1},
  {name:"Эпический приз",desc:"100 скинов",chance:3,imageIndex:1},
  {name:"Легендарный приз",desc:"140 скинов",chance:1,imageIndex:2},
  {name:"Мифический приз",desc:"85 скинов",chance:1,imageIndex:2}
];
function pickPrize() {
  let roll = Math.random()*100, sum = 0;
  for (const prize of PRIZES) { sum += prize.chance; if (roll < sum) return prize; }
  return PRIZES[0];
}

app.post("/api/create-invoice", async (req,res) => {
  try {
    const user = getUser(req);
    if (!user?.id) return res.status(401).json({error:"Откройте приложение из Telegram."});
    const payload = `spin_${user.id}_${crypto.randomBytes(12).toString("hex")}`;
    const db = readDb();
    db.invoices[payload] = {userId:user.id, status:"created", createdAt:Date.now()};
    writeDb(db);
    const invoiceUrl = await telegram("createInvoiceLink", {
      title:"Прокрутка рулетки",
      description:"Одна прокрутка рулетки Fortnite аккаунтов",
      payload,
      provider_token:"",
      currency:"XTR",
      prices:[{label:"Одна прокрутка",amount:100}]
    });
    res.json({invoiceUrl});
  } catch (e) {
    console.error(e);
    res.status(500).json({error:"Не удалось создать оплату. Проверьте настройки бота."});
  }
});

app.post("/telegram/webhook", async (req,res) => {
  try {
    if (WEBHOOK_SECRET && req.get("X-Telegram-Bot-Api-Secret-Token") !== WEBHOOK_SECRET)
      return res.sendStatus(403);
    const update = req.body;
    const db = readDb();

    if (update.pre_checkout_query) {
      const q = update.pre_checkout_query;
      const invoice = db.invoices[q.invoice_payload];
      const valid = !!invoice && invoice.status === "created" &&
        Number(q.total_amount) === 100 && q.currency === "XTR";
      await telegram("answerPreCheckoutQuery", {
        pre_checkout_query_id:q.id,
        ok:valid,
        ...(!valid ? {error_message:"Счёт недействителен. Создайте оплату заново."} : {})
      });
    }

    const payment = update.message?.successful_payment;
    if (payment) {
      const invoice = db.invoices[payment.invoice_payload];
      if (invoice && invoice.status !== "paid" &&
          payment.currency === "XTR" && Number(payment.total_amount) === 100) {
        invoice.status = "paid";
        invoice.paidAt = Date.now();
        db.credits[String(invoice.userId)] = (db.credits[String(invoice.userId)] || 0) + 1;
        writeDb(db);
      }
    }
    res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error:",e);
    res.sendStatus(500);
  }
});

app.post("/api/spin", (req,res) => {
  const user = getUser(req);
  if (!user?.id) return res.status(401).json({error:"Не удалось проверить Telegram-пользователя."});
  const db = readDb();
  const key = String(user.id);
  if ((db.credits[key] || 0) < 1)
    return res.status(409).json({error:"Ждём подтверждение платежа Telegram."});
  db.credits[key] -= 1;
  const prize = pickPrize();
  writeDb(db);
  res.json(prize);
});

// ----- Бесплатная прокрутка: один раз в 24 часа на пользователя Telegram -----
const FREE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

app.get("/api/free-status", (req,res) => {
  const user = getUser(req);
  if (!user?.id) return res.status(401).json({error:"Откройте приложение из Telegram."});
  const db = readDb();
  const last = Number((db.freeSpins || {})[String(user.id)] || 0);
  const msLeft = Math.max(0, FREE_COOLDOWN_MS - (Date.now() - last));
  res.json({available: msLeft === 0, msLeft});
});

app.post("/api/free-spin", (req,res) => {
  const user = getUser(req);
  if (!user?.id) return res.status(401).json({error:"Не удалось проверить Telegram-пользователя."});
  const db = readDb();
  db.freeSpins = db.freeSpins || {};
  const key = String(user.id);
  const msLeft = FREE_COOLDOWN_MS - (Date.now() - Number(db.freeSpins[key] || 0));
  if (msLeft > 0)
    return res.status(429).json({error:"Бесплатная прокрутка уже использована.", msLeft});
  db.freeSpins[key] = Date.now();   // фиксируем время до выдачи результата
  const prize = pickPrize();
  writeDb(db);
  res.json(prize);
});

app.get("/health", (_req,res) => res.json({ok:true}));
app.listen(PORT, () => console.log(`honestiTG roulette listening on :${PORT}`));
