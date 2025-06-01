// worker.js — Telegram-бот для Cloudflare Workers (Service Worker синтаксис).
// Читает триггеры из Google Sheets (колонка B) и выдаёт случайный ответ (колонка C),
// при этом используется встроенный mapping команд → ключ таблицы.

const commandMap = {
  "/command1": "мяу",
  "/command2": "песенка",
  "/command3": "обнимашка",
  "/command4": "скучно",
  "/command5": "миссия",
  "/command6": "поговорим",
};

const RANGE = encodeURIComponent("Sheet1!A:C"); // Убедитесь, что лист в Google Sheets называется «Sheet1».
const RAM_TTL = 5 * 60 * 1000;                    // 5 минут в мс
let ramCache = null;                              // { data: Map<trigger, [ответы]>, exp: timestamp }

/**
 * Возвращает случайный элемент из массива.
 * @param {Array<any>} arr
 * @returns {any}
 */
function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Подтягивает данные из Google Sheets, кэширует в RAM и KV, 
 * возвращает Map<trigger (lowercase), [ответы]>.
 * @param {{ SHEET_KV: KVNamespace, GOOGLE_SHEETS_API_KEY: string, GOOGLE_SHEETS_ID: string }} env
 * @returns {Promise<Map<string, string[]>>}
 */
async function fetchSheet(env) {
  // 1) Проверяем, что у нас есть привязка KV:
  if (!env.SHEET_KV) {
    throw new Error("Binding 'SHEET_KV' is not defined. Проверьте wrangler.toml и Dashboard.");
  }

  // 2) Если в RAM-слое ещё живые данные, возвращаем их:
  if (ramCache && Date.now() < ramCache.exp) {
    return ramCache.data;
  }

  const kvKey = "sheet-v1";
  let kvRaw;
  try {
    kvRaw = await env.SHEET_KV.get(kvKey, { type: "json" });
  } catch (e) {
    throw new Error("Error accessing KV: " + e.message);
  }

  // 3) Если в KV уже есть сериализованная Map<trigger, [ответы]>, достаём её
  if (kvRaw) {
    const map = new Map(kvRaw);
    ramCache = { data: map, exp: Date.now() + RAM_TTL };
    return map;
  }

  // 4) Иначе запрашиваем Google Sheets напрямую
  if (!env.GOOGLE_SHEETS_ID || !env.GOOGLE_SHEETS_API_KEY) {
    throw new Error("Missing GOOGLE_SHEETS_ID или GOOGLE_SHEETS_API_KEY");
  }
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEETS_ID}/values/${RANGE}?key=${env.GOOGLE_SHEETS_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Sheets API returned HTTP ${res.status}`);
  }
  const json = await res.json();
  const values = Array.isArray(json.values) ? json.values : [];

  // 5) Парсим ответ в Map<trigger, [ответы]> (пропускаем первую строку, т.к. там заголовки)
  const map = new Map();
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const rawTrigger = (row[1] || "").trim().toLowerCase(); // колонка B
    const rawResponse = (row[2] || "").trim();              // колонка C
    if (!rawTrigger || !rawResponse) continue;
    if (!map.has(rawTrigger)) {
      map.set(rawTrigger, []);
    }
    map.get(rawTrigger).push(rawResponse);
  }

  // 6) Сериализуем и сохраняем в KV (TTL в секундах)
  const serialised = Array.from(map.entries());
  try {
    await env.SHEET_KV.put(kvKey, JSON.stringify(serialised), { expirationTtl: RAM_TTL / 1000 });
  } catch (e) {
    console.error("Error writing to KV:", e);
  }

  // 7) Обновляем RAM-слой и возвращаем
  ramCache = { data: map, exp: Date.now() + RAM_TTL };
  return map;
}

/**
 * Отправляет сообщение в Telegram-чат.
 * @param {{ TELEGRAM_BOT_TOKEN: string }} env
 * @param {number} chatId
 * @param {string} text
 * @param {number=} replyTo
 */
async function sendTelegram(env, chatId, text, replyTo) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return; // Если токена нет, просто выходим.

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = { chat_id: chatId, text };
  if (replyTo) body.reply_to_message_id = replyTo;

  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error("Error sending message to Telegram:", e);
  }
}

// ==================== Основной HTTP-обработчик (Webhook) ====================
addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request, event));
});

/**
 * @param {Request} request
 * @param {{ env: any }} event
 * @returns {Promise<Response>}
 */
async function handleRequest(request, event) {
  // Быстрый Health-check: GET → просто «CatBot online»
  if (request.method === "GET") {
    return new Response("🐈‍⬛ CatBot online", { status: 200 });
  }

  try {
    const update = await request.json().catch(() => null);
    if (!update || !update.message || !update.message.text) {
      // Если нет message.text, возвращаем Telegram пустой OK
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const chatId = update.message.chat.id;
    const rawText = (update.message.text || "").trim().toLowerCase();

    // Если сообщение начинается с «/», смотрим в commandMap, иначе берём как есть:
    const key = rawText.startsWith("/") ? commandMap[rawText] || rawText : rawText;

    // Обработка «/reload» прямо в чате
    if (key === "/reload") {
      // Сбрасываем KV и RAM, чтобы принудительно перечитать таблицу
      try {
        await event.env.SHEET_KV.delete("sheet-v1");
      } catch {}
      ramCache = null;
      try {
        await fetchSheet(event.env);
        await sendTelegram(event.env, chatId, "Данные перезагружены ✅");
      } catch (err) {
        console.error(err);
        await sendTelegram(event.env, chatId, "Ошибка при перезагрузке таблицы 😿");
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Получаем Map<trigger, [ответы]> из кеша/KV/Google Sheets
    let map;
    try {
      map = await fetchSheet(event.env);
    } catch (err) {
      console.error(err);
      await sendTelegram(event.env, chatId, "Не удалось получить данные из таблицы 😿");
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Ищем ответы по ключу
    const answers = map.get(key);
    if (answers && answers.length > 0) {
      const randomAnswer = pickRandom(answers);
      await sendTelegram(event.env, chatId, randomAnswer, update.message.message_id);
    } else {
      await sendTelegram(
        event.env,
        chatId,
        "Не знаю такого триггера 🙀 Напишите /reload, если вы только что добавили новый триггер."
      );
    }
  } catch (err) {
    console.error("Handler error:", err);
  }

  // Всегда отсылаем Telegram { ok: true }, чтобы webhook не отключили
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
  });
}

// ==================== CRON-обработчик ====================
addEventListener("scheduled", (event) => {
  event.waitUntil(handleScheduled(event));
});

/**
 * @param {{ env: any }} event
 */
async function handleScheduled(event) {
  // Если KV-binding вдруг не подцепился (или тестовый режим), просто выходим
  if (!event.env.SHEET_KV) return;
  try {
    await fetchSheet(event.env);
  } catch (err) {
    console.error("Scheduled refresh error:", err);
  }
}
