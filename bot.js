/**
 * Bot rezerwacji wizyt — Telegram
 * Node.js + Telegraf + SQLite
 *
 * Uruchomienie:
 *   npm install
 *   cp .env.example .env   (i uzupełnij BOT_TOKEN oraz OWNER_ID)
 *   node bot.js
 */

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { DatabaseSync } = require('node:sqlite');
const cron = require('node-cron');

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = process.env.OWNER_ID;

if (!BOT_TOKEN) {
  console.error('Brak BOT_TOKEN w pliku .env');
  process.exit(1);
}

/* ------------------------- konfiguracja firmy ------------------------- */

const SALON = {
  name: 'Studio Aurea',
  address: 'ul. Przykładowa 12/3, Wrocław',
  phone: '+48 000 000 000',
};

const SERVICES = [
  { id: 'hydro', name: 'Oczyszczanie wodorowe', price: 240, minutes: 60 },
  { id: 'mezo',  name: 'Mezoterapia igłowa',    price: 450, minutes: 60 },
  { id: 'peel',  name: 'Peeling chemiczny',     price: 300, minutes: 45 },
  { id: 'kons',  name: 'Konsultacja',           price: 100, minutes: 30 },
];

const HOURS = ['10:00', '11:30', '13:00', '15:00', '16:30', '18:00'];
const WORK_DAYS = [1, 2, 3, 4, 5, 6];   // pon–sob (0 = niedziela)
const DAYS_AHEAD = 14;

/* ------------------------------ baza ------------------------------ */

const db = new DatabaseSync('bookings.db');
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id    INTEGER NOT NULL,
    user_name  TEXT    NOT NULL,
    username   TEXT,
    phone      TEXT,
    service_id TEXT    NOT NULL,
    service    TEXT    NOT NULL,
    price      INTEGER NOT NULL,
    date       TEXT    NOT NULL,
    time       TEXT    NOT NULL,
    status     TEXT    NOT NULL DEFAULT 'new',
    reminded   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_slot
    ON bookings(date, time) WHERE status != 'cancelled';
`);

const q = {
  isTaken:   db.prepare(`SELECT 1 FROM bookings WHERE date=? AND time=? AND status!='cancelled'`),
  takenDay:  db.prepare(`SELECT time FROM bookings WHERE date=? AND status!='cancelled'`),
  insert:    db.prepare(`INSERT INTO bookings (chat_id,user_name,username,service_id,service,price,date,time)
                         VALUES (?,?,?,?,?,?,?,?)`),
  mine:      db.prepare(`SELECT * FROM bookings WHERE chat_id=? AND status!='cancelled'
                         AND date >= date('now') ORDER BY date, time`),
  byId:      db.prepare(`SELECT * FROM bookings WHERE id=? AND chat_id=?`),
  cancel:    db.prepare(`UPDATE bookings SET status='cancelled' WHERE id=? AND chat_id=?`),
  tomorrow:  db.prepare(`SELECT * FROM bookings WHERE date = date('now','+1 day')
                         AND status!='cancelled' AND reminded=0`),
  markRem:   db.prepare(`UPDATE bookings SET reminded=1 WHERE id=?`),
  allUpcoming: db.prepare(`SELECT * FROM bookings WHERE status!='cancelled'
                           AND date >= date('now') ORDER BY date, time LIMIT 30`),
};

/* ----------------------------- pomocnicze ----------------------------- */

const WD = ['niedz.', 'pon.', 'wt.', 'śr.', 'czw.', 'pt.', 'sob.'];

function availableDays() {
  const out = [];
  for (let i = 1; i <= DAYS_AHEAD && out.length < 6; i++) {
    const d = new Date(Date.now() + i * 86400000);
    if (!WORK_DAYS.includes(d.getDay())) continue;
    const key = d.toISOString().slice(0, 10);
    const taken = q.takenDay.all(key).map(r => r.time);
    if (taken.length >= HOURS.length) continue;          // dzień pełny
    out.push({
      key,
      label: `${WD[d.getDay()]} ${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')}`,
    });
  }
  return out;
}

function freeHours(dateKey) {
  const taken = q.takenDay.all(dateKey).map(r => r.time);
  return HOURS.filter(h => !taken.includes(h));
}

function prettyDate(key) {
  const d = new Date(key + 'T00:00:00');
  return `${WD[d.getDay()]} ${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')}`;
}

const session = new Map();   // chat_id -> { serviceId, date }

function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📅 Umów wizytę', 'book')],
    [Markup.button.callback('📋 Moje wizyty', 'mine'),
     Markup.button.callback('📍 Kontakt', 'contact')],
  ]);
}

/* -------------------------------- bot -------------------------------- */

const bot = new Telegraf(BOT_TOKEN);

bot.start(ctx =>
  ctx.reply(
    `Cześć, ${ctx.from.first_name}! 👋\n\n` +
    `Tu bot *${SALON.name}*. Umówisz wizytę w 30 sekund — bez dzwonienia.`,
    { parse_mode: 'Markdown', ...mainMenu() }
  )
);

bot.action('menu', async ctx => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('Co chcesz zrobić?', mainMenu());
});

bot.action('book', async ctx => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    'Wybierz zabieg:',
    Markup.inlineKeyboard([
      ...SERVICES.map(s => [Markup.button.callback(`${s.name} · ${s.price} zł`, `s:${s.id}`)]),
      [Markup.button.callback('← Wróć', 'menu')],
    ])
  );
});

bot.action(/^s:(.+)$/, async ctx => {
  await ctx.answerCbQuery();
  const service = SERVICES.find(s => s.id === ctx.match[1]);
  if (!service) return;

  session.set(ctx.chat.id, { serviceId: service.id });

  const days = availableDays();
  if (!days.length) {
    return ctx.editMessageText(
      'Nie ma wolnych terminów w najbliższych dniach 😕\n' +
      `Zadzwoń: ${SALON.phone}`,
      Markup.inlineKeyboard([[Markup.button.callback('← Wróć', 'menu')]])
    );
  }

  await ctx.editMessageText(
    `*${service.name}* — ${service.price} zł\n\nNa kiedy?`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        ...chunk(days.map(d => Markup.button.callback(d.label, `d:${d.key}`)), 2),
        [Markup.button.callback('← Wróć', 'book')],
      ]),
    }
  );
});

bot.action(/^d:(.+)$/, async ctx => {
  await ctx.answerCbQuery();
  const dateKey = ctx.match[1];
  const s = session.get(ctx.chat.id);
  if (!s) return ctx.editMessageText('Sesja wygasła. Zacznij od /start');

  s.date = dateKey;
  const free = freeHours(dateKey);
  if (!free.length) {
    return ctx.editMessageText(
      'Ten dzień właśnie się zapełnił. Wybierz inny.',
      Markup.inlineKeyboard([[Markup.button.callback('← Wybierz dzień', `s:${s.serviceId}`)]])
    );
  }

  await ctx.editMessageText(
    `*${prettyDate(dateKey)}* — wolne godziny:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        ...chunk(free.map(h => Markup.button.callback(h, `t:${h}`)), 3),
        [Markup.button.callback('← Wróć', `s:${s.serviceId}`)],
      ]),
    }
  );
});

bot.action(/^t:(.+)$/, async ctx => {
  await ctx.answerCbQuery();
  const time = ctx.match[1];
  const s = session.get(ctx.chat.id);
  if (!s || !s.date) return ctx.editMessageText('Sesja wygasła. Zacznij od /start');

  s.time = time;
  const service = SERVICES.find(x => x.id === s.serviceId);

  await ctx.editMessageText(
    `*Sprawdź, czy się zgadza:*\n\n` +
    `💆 ${service.name}\n📅 ${prettyDate(s.date)}, godz. ${time}\n💰 ${service.price} zł`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Potwierdzam', 'confirm')],
        [Markup.button.callback('← Zmień termin', `s:${s.serviceId}`)],
      ]),
    }
  );
});

bot.action('confirm', async ctx => {
  const s = session.get(ctx.chat.id);
  if (!s || !s.date || !s.time) {
    await ctx.answerCbQuery();
    return ctx.editMessageText('Sesja wygasła. Zacznij od /start');
  }

  const service = SERVICES.find(x => x.id === s.serviceId);

  // ostatnie sprawdzenie — ktoś mógł zająć termin w międzyczasie
  if (q.isTaken.get(s.date, s.time)) {
    await ctx.answerCbQuery('Termin właśnie zajęty', { show_alert: true });
    return ctx.editMessageText(
      'Ktoś zdążył przed Tobą 😕 Wybierz inną godzinę.',
      Markup.inlineKeyboard([[Markup.button.callback('← Wybierz termin', `s:${s.serviceId}`)]])
    );
  }

  const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ');
  let info;
  try {
    info = q.insert.run(ctx.chat.id, name, ctx.from.username || null,
                        service.id, service.name, service.price, s.date, s.time);
  } catch (e) {
    await ctx.answerCbQuery();
    return ctx.editMessageText('Ten termin jest już zajęty. Wybierz inny.',
      Markup.inlineKeyboard([[Markup.button.callback('← Wybierz termin', `s:${s.serviceId}`)]]));
  }

  await ctx.answerCbQuery('Zarezerwowano!');
  session.delete(ctx.chat.id);

  await ctx.editMessageText(
    `Gotowe! ✅\n\n` +
    `💆 ${service.name}\n📅 ${prettyDate(s.date)}, godz. ${s.time}\n💰 ${service.price} zł\n\n` +
    `📍 ${SALON.address}\n\nPrzypomnę Ci dzień wcześniej.`,
    { ...mainMenu() }
  );

  // powiadomienie właściciela
  if (OWNER_ID) {
    bot.telegram.sendMessage(
      OWNER_ID,
      `🔔 *Nowa rezerwacja*\n\n` +
      `👤 ${name}${ctx.from.username ? ' (@' + ctx.from.username + ')' : ''}\n` +
      `💆 ${service.name}\n📅 ${prettyDate(s.date)}, ${s.time}\n💰 ${service.price} zł`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  }
});

bot.action('mine', async ctx => {
  await ctx.answerCbQuery();
  const rows = q.mine.all(ctx.chat.id);
  if (!rows.length) {
    return ctx.editMessageText('Nie masz nadchodzących wizyt.', mainMenu());
  }
  await ctx.editMessageText(
    '*Twoje wizyty:*\n\n' +
    rows.map(r => `• ${r.service}\n  ${prettyDate(r.date)}, ${r.time} — ${r.price} zł`).join('\n\n'),
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        ...rows.map(r => [Markup.button.callback(`❌ Odwołaj ${prettyDate(r.date)} ${r.time}`, `c:${r.id}`)]),
        [Markup.button.callback('← Wróć', 'menu')],
      ]),
    }
  );
});

bot.action(/^c:(\d+)$/, async ctx => {
  const id = Number(ctx.match[1]);
  const row = q.byId.get(id, ctx.chat.id);
  if (!row) {
    await ctx.answerCbQuery('Nie znaleziono rezerwacji');
    return;
  }
  q.cancel.run(id, ctx.chat.id);
  await ctx.answerCbQuery('Odwołano');
  await ctx.editMessageText(
    `Rezerwacja ${prettyDate(row.date)} o ${row.time} została odwołana.`,
    mainMenu()
  );

  if (OWNER_ID) {
    bot.telegram.sendMessage(
      OWNER_ID,
      `❌ Odwołano: ${row.user_name} — ${row.service}, ${prettyDate(row.date)} ${row.time}`
    ).catch(() => {});
  }
});

bot.action('contact', async ctx => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `📍 ${SALON.address}\n☎ ${SALON.phone}\n🕐 pon–pt 10:00–19:00, sob 10:00–15:00`,
    mainMenu()
  );
});

/* --------------------- komendy właściciela --------------------- */

bot.command('lista', ctx => {
  if (String(ctx.chat.id) !== String(OWNER_ID)) return;
  const rows = q.allUpcoming.all();
  if (!rows.length) return ctx.reply('Brak nadchodzących rezerwacji.');
  ctx.reply(
    '*Nadchodzące rezerwacje:*\n\n' +
    rows.map(r => `${prettyDate(r.date)} ${r.time} — ${r.user_name}\n  ${r.service}, ${r.price} zł`).join('\n\n'),
    { parse_mode: 'Markdown' }
  );
});

/* ----------------------- przypomnienia ----------------------- */

// codziennie o 18:00 — przypomnienie o jutrzejszych wizytach
cron.schedule('0 18 * * *', () => {
  const rows = q.tomorrow.all();
  rows.forEach(r => {
    bot.telegram.sendMessage(
      r.chat_id,
      `⏰ Przypomnienie: jutro o *${r.time}* masz wizytę.\n\n` +
      `💆 ${r.service}\n📍 ${SALON.address}\n\n` +
      `Jeśli coś się zmieniło — odwołaj przez /start → Moje wizyty.`,
      { parse_mode: 'Markdown' }
    ).then(() => q.markRem.run(r.id)).catch(() => {});
  });
}, { timezone: 'Europe/Warsaw' });

/* --------------------------- pomocnicze --------------------------- */

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/* ----------------------------- start ----------------------------- */

bot.catch((err, ctx) => {
  console.error('Błąd bota:', err);
  if (ctx && ctx.reply) ctx.reply('Coś poszło nie tak. Spróbuj /start').catch(() => {});
});

console.log('Bot startuje…');
bot.launch(() => console.log('Bot wystartował i nasłuchuje.'));

process.once('SIGINT',  () => { bot.stop('SIGINT');  db.close(); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); db.close(); });
