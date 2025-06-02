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
  // 1) Проверяем, что у нас есть env и привязка KV:
  if (!env || !env.SHEET_KV) { // Добавлена проверка на существование env
    throw new Error("Binding 'SHEET_KV' is not defined in env. Проверьте wrangler.toml и Dashboard.");
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
  if (!env.GOOGLE_SHEETS_ID || !env.GOOGLE_SHEETS_API_KEY) { // Проверяем наличие в переданном env
    throw new Error("Missing GOOGLE_SHEETS_ID или GOOGLE_SHEETS_API_KEY in env");
  }
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEETS_ID}/values/${RANGE}?key=${env.GOOGLE_SHEETS_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) {
    // Более подробное логирование ошибки от Google Sheets API
    const errorBody = await res.text();
    console.error("Sheets API Error Body:", errorBody);
    throw new Error(`Sheets API returned HTTP ${res.status}. Response: ${errorBody}`);
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
  if (!env || !env.TELEGRAM_BOT_TOKEN) { // Проверяем наличие в переданном env
      console.error("TELEGRAM_BOT_TOKEN not found in env. Message not sent.");
      return;
  }
  const token = env.TELEGRAM_BOT_TOKEN;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = { chat_id: chatId, text };
  if (replyTo) body.reply_to_message_id = replyTo;

  try {
    const response = await fetch(url, { // Сохраняем ответ от Telegram API
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) { // Проверяем статус ответа
        const errorBody = await response.text();
        console.error(`Error sending message to Telegram: ${response.status} ${response.statusText}`, errorBody);
    }
  } catch (e) {
    console.error("Error sending message to Telegram (network or other):", e);
  }
}

// ==================== Основной HTTP-обработчик (Webhook) ====================
addEventListener("fetch", (fetchEvent) => { // `fetchEvent` - это FetchEvent
  // В Service Worker байндинги и секреты доступны как глобальные переменные.
  // Собираем их в объект `envForHandler` для передачи в наши функции.
  const envForHandler = {
    SHEET_KV: typeof SHEET_KV !== 'undefined' ? SHEET_KV : null,
    GOOGLE_SHEETS_API_KEY: typeof GOOGLE_SHEETS_API_KEY !== 'undefined' ? GOOGLE_SHEETS_API_KEY : null,
    GOOGLE_SHEETS_ID: typeof GOOGLE_SHEETS_ID !== 'undefined' ? GOOGLE_SHEETS_ID : null,
    TELEGRAM_BOT_TOKEN: typeof TELEGRAM_BOT_TOKEN !== 'undefined' ? TELEGRAM_BOT_TOKEN : null,
    // Добавьте сюда другие байндинги/секреты, если они используются
  };

  // Проверим, что основные байндинги определены, иначе нет смысла продолжать
  if (!envForHandler.SHEET_KV || !envForHandler.TELEGRAM_BOT_TOKEN || !envForHandler.GOOGLE_SHEETS_API_KEY || !envForHandler.GOOGLE_SHEETS_ID) {
    console.error("CRITICAL: One or more required bindings/secrets are undefined in the global scope for the fetch handler.",
                  "SHEET_KV defined:", !!envForHandler.SHEET_KV,
                  "TELEGRAM_BOT_TOKEN defined:", !!envForHandler.TELEGRAM_BOT_TOKEN,
                  "GOOGLE_SHEETS_API_KEY defined:", !!envForHandler.GOOGLE_SHEETS_API_KEY,
                  "GOOGLE_SHEETS_ID defined:", !!envForHandler.GOOGLE_SHEETS_ID);
    // Можно вернуть ошибку, но Telegram ожидает 200 OK, чтобы не отключить webhook.
    // Лучше просто залогировать и вернуть OK. Бот не ответит, но webhook останется.
  }

  fetchEvent.respondWith(handleRequest(fetchEvent.request, envForHandler)); // Передаем собранный envForHandler
});

/**
 * @param {Request} request
 * @param {object} env - Объект с байндингами и секретами
 * @returns {Promise<Response>}
 */
async function handleRequest(request, env) { // Второй аргумент теперь явно `env`
  // Быстрый Health-check: GET → просто «CatBot online»
  if (request.method === "GET") {
    return new Response("🐈‍⬛ CatBot online", { status: 200 });
  }

  try {
    // Проверка, что env вообще передан и содержит SHEET_KV
    if (!env || !env.SHEET_KV) {
        console.error("handleRequest: env object or env.SHEET_KV is missing!");
        // Отправляем сообщение об ошибке, если есть токен и chatId
        try {
            const tempUpdate = await request.clone().json().catch(() => null);
            if (tempUpdate && tempUpdate.message && tempUpdate.message.chat && env && env.TELEGRAM_BOT_TOKEN) {
                await sendTelegram(env, tempUpdate.message.chat.id, "Критическая ошибка конфигурации воркера 😿 Свяжитесь с администратором.");
            }
        } catch (e) { /*ignore*/ }
        return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" }});
    }

    const update = await request.json().catch(() => null);
    if (!update || !update.message || !update.message.text) {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const chatId = update.message.chat.id;
    const rawText = (update.message.text || "").trim().toLowerCase();
    const key = rawText.startsWith("/") ? commandMap[rawText] || rawText : rawText;

    if (key === "/reload") {
      try {
        await env.SHEET_KV.delete("sheet-v1"); // Используем переданный env
      } catch(e) { console.error("Error deleting KV for /reload:", e); }
      ramCache = null;
      try {
        await fetchSheet(env); // Передаем env
        await sendTelegram(env, chatId, "Данные перезагружены ✅"); // Передаем env
      } catch (err) {
        console.error("Error during /reload data fetch:", err);
        await sendTelegram(env, chatId, `Ошибка при перезагрузке таблицы 😿: ${err.message}`); // Передаем env
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    let map;
    try {
      map = await fetchSheet(env); // Передаем env
    } catch (err) {
      console.error("Error fetching sheet data in handleRequest:", err);
      await sendTelegram(env, chatId, `Не удалось получить данные из таблицы 😿: ${err.message}`); // Передаем env
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const answers = map.get(key);
    if (answers && answers.length > 0) {
      const randomAnswer = pickRandom(answers);
      await sendTelegram(env, chatId, randomAnswer, update.message.message_id); // Передаем env
    } else {
      await sendTelegram(
        env, // Передаем env
        chatId,
        "Не знаю такого триггера 🙀 Напишите /reload, если вы только что добавили новый триггер."
      );
    }
  } catch (err) {
    console.error("Handler error:", err);
    // Попытка отправить сообщение об ошибке, если это возможно
    try {
        const tempUpdate = await request.clone().json().catch(() => null);
        if (tempUpdate && tempUpdate.message && tempUpdate.message.chat && env && env.TELEGRAM_BOT_TOKEN) {
            await sendTelegram(env, tempUpdate.message.chat.id, "Произошла внутренняя ошибка бота 😿");
        }
    } catch(e) { /*ignore*/ }
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
  });
}

// ==================== CRON-обработчик ====================
addEventListener("scheduled", (scheduledEvent) => { // scheduledEvent - это ScheduledEvent
  // Для scheduledEvent, scheduledEvent.env корректно содержит байндинги
  scheduledEvent.waitUntil(handleScheduled(scheduledEvent));
});

/**
 * @param {ScheduledEvent & { env: any }} event  // Типизация здесь для ясности, JavaScript нестрого типизирован
 */
async function handleScheduled(event) {
  // Вывод в консоль для отладки: что вообще есть в event и event.env
  console.log("handleScheduled called. Event keys:", Object.keys(event).join(", "));
  if (event.env) {
    console.log("handleScheduled: event.env keys:", Object.keys(event.env).join(", "));
  } else {
    console.log("handleScheduled: event.env is undefined.");
  }

  // Оригинальная проверка
  if (!event.env || !event.env.SHEET_KV) {
    console.error("Scheduled: event.env or event.env.SHEET_KV is missing!");
    return; // Выходим, если нет SHEET_KV
  }

  // Проверим и другие необходимые для fetchSheet переменные, если они используются только в scheduled
  if (!event.env.GOOGLE_SHEETS_API_KEY || !event.env.GOOGLE_SHEETS_ID) {
      console.error("Scheduled: GOOGLE_SHEETS_API_KEY or GOOGLE_SHEETS_ID is missing in event.env!");
      // В зависимости от логики, может, тоже стоит return
  }


  try {
    console.log("Scheduled: Attempting to call fetchSheet with event.env:", event.env);
    await fetchSheet(event.env); // Здесь event.env должен быть корректным объектом с байндингами
    console.log("Scheduled: fetchSheet completed successfully.");
  } catch (err) {
    console.error("Scheduled refresh error:", err.message, err.stack);
  }
}
