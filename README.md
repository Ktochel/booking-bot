# Bot rezerwacji wizyt — Telegram

Bot do zapisów na wizyty dla salonu, gabinetu lub warsztatu.
Klient rezerwuje termin klikając przyciski, właściciel dostaje
powiadomienie na Telegramie.

## Co robi

- Rezerwacja krok po kroku: usługa → dzień → godzina → potwierdzenie
- Pokazuje wyłącznie wolne terminy (zajęte znikają automatycznie)
- Blokada podwójnej rezerwacji na poziomie bazy (`UNIQUE INDEX`)
- Powiadomienie właściciela o każdej nowej rezerwacji i odwołaniu
- Automatyczne przypomnienie klientowi dzień wcześniej o 18:00
- Klient może odwołać wizytę sam — termin wraca do puli
- Komenda `/lista` dla właściciela — nadchodzące rezerwacje

## Uruchomienie

```bash
npm install
cp .env.example .env
# uzupełnij BOT_TOKEN i OWNER_ID w pliku .env
node bot.js
```

**BOT_TOKEN** — załóż bota u [@BotFather](https://t.me/BotFather) (`/newbot`).
**OWNER_ID** — napisz do [@userinfobot](https://t.me/userinfobot), odeśle Twoje `id`.

## Konfiguracja pod klienta

Wszystko, co zmienia się między firmami, jest na górze `bot.js`:

```js
const SALON = { name, address, phone };
const SERVICES = [ { id, name, price, minutes }, … ];
const HOURS = ['10:00', '11:30', …];
const WORK_DAYS = [1,2,3,4,5,6];   // 0 = niedziela
```

Zmiana cennika czy godzin pracy = edycja kilku linii, bez ruszania logiki.

## Baza danych

SQLite (`bookings.db`), tworzy się sama przy pierwszym uruchomieniu.
Nie wymaga serwera bazy — plik leży obok bota.

Tabela `bookings`: `chat_id`, `user_name`, `service`, `price`,
`date`, `time`, `status`, `reminded`, `created_at`.

## Hosting

Bot potrzebuje **stale działającego procesu Node.js** — to wyklucza
hostingi współdzielone typu PythonAnywhere (są pod Pythona, a na darmowym
koncie procesy konsolowe są ubijane) czy Render free tier (usypia usługi).

Sprawdzone opcje:

| Hosting | Koszt | Uwagi |
|---|---|---|
| **Mikr.us** | ~35–50 zł / rok | VPS w Polsce, argument RODO dla klienta |
| **Oracle Cloud** | 0 zł (Always Free) | wymaga karty przy rejestracji |
| **Fly.io / Koyeb** | darmowy limit | prostszy deploy, mniej kontroli |

Zalecane uruchomienie przez `pm2`:

```bash
npm install -g pm2
pm2 start bot.js --name bot-rezerwacje
pm2 save && pm2 startup
```

## Stack

Node.js · Telegraf 4 · better-sqlite3 · node-cron

---

Projekt demonstracyjny — dane salonu są przykładowe.
