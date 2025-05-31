/**
 * worker.js — Telegram-бот для Cloudflare Workers (Service Worker синтаксис).
 * Читает триггеры из Google Sheets (колонка B) и выдаёт случайный ответ (колонка C).
 * 
 * Чтобы этот код работал, убедитесь:
 * 1. В wrangler.toml прописано:
 *    name = "catbot"
 *    compatibility_date = "2025-05-31"
 *    main = "src/worker.js"
 *
 *    [[kv_namespaces]]
 *    binding    = "SHEET_KV"
 *    id         = "<PROD_KV_ID>"
 *    preview_id = "<PREVIEW_KV_ID>"
 *
 *    [triggers]
 *    crons = ["*/5 * * * *"]
 *
 * 2. В разделе Variables and Secrets Dashboard (или через wrangler secret put) есть три секрета:
 *    TELEGRAM_BOT_TOKEN, GOOGLE_SHEETS_API_KEY, GOOGLE_SHEETS_ID
 * 3. Таблица Google Sheets доступна «Anyone with the link → Viewer».
 *    В таблице в первой строке — заголовки (любой текст), 
 *    а начиная со второй строки:
 *      колонка A — (не используется),
 *      колонка B — триггер (ключевое слово),
 *      колонка C — ответ.
 * 4. URL вебхука Telegram сконфигурирован (curl setWebhook …) и указывает на корень воркера.
 */

/** ----- Константы и RAM-кэш ----- */
const RANGE = encodeURIComponent('Sheet1!A:C'); // Диапазон: первые три колонки листа "Sheet1"
const RAM_TTL = 5 * 60 * 1000;                   // 5 минут в миллисекундах
let ramCache = null;                             // { data: Map<trigger, [ответы]>, exp: timestamp }

/**
 * Выбирает случайный элемент из массива.
 * @param {Array<any>} arr 
 * @returns {any}
 */
function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Подтягивает данные из Google Sheets, кэширует в RAM и KV, возвращает Map<trigger, [ответы]>.
 * Триггер берётся из колонки B (index 1), ответ — из колонки C (index 2).
 * @param {{ SHEET_KV: KVNamespace, GOOGLE_SHEETS_API_KEY: string, GOOGLE_SHEETS_ID: string }} env 
 * @returns {Promise<Map<string,string[]>>}
 */
async function fetchSheet(env) {
  // 1) Проверяем RAM-слой
  if (ramCache && Date.now() < ramCache.exp) {
    return ramCache.data;
  }

  // 2) Проверяем KV-слой (preview_id для wrangler dev, id для продакшна)
  const kvKey = 'sheet-v1';
  const kvRaw = await env.SHEET_KV.get(kvKey, { type: 'json' });
  if (kvRaw) {
    // kvRaw — сериализованный массив пар [[trigger, [ответы]], ...]
    const map = new Map(kvRaw);
    ramCache = { data: map, exp: Date.now() + RAM_TTL };
    return map;
  }

  // 3) Запрос к Google Sheets API
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEETS_ID}` +
              `/values/${RANGE}?key=${env.GOOGLE_SHEETS_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`Sheets API error: ${res.status}`);
    throw new Error(`Sheets API returned HTTP ${res.status}`);
  }
  const json = await res.json(); // { values: [ [A, B, C], [A, B, C], ... ] }
  const values = Array.isArray(json.values) ? json.values : [];

  // 4) Формируем Map<trigger, [ответы]>
  const map = new Map();
  // Пропускаем первую строку (заголовок)
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    // row.length может быть меньше 3, проверяем
    const rawTrigger = (row[1] || '').trim().toLowerCase();
    const rawResponse = (row[2] || '').trim();
    if (!rawTrigger || !rawResponse) continue;
    if (!map.has(rawTrigger)) {
      map.set(rawTrigger, []);
    }
    map.get(rawTrigger).push(rawResponse);
  }

  // 5) Сохраняем в KV (TTL в секундах)
  const serialised = Array.from(map.entries()); // [ [trigger, [ответы]], … ]
  await env.SHEET_KV.put(kvKey, JSON.stringify(serialised), { expirationTtl: RAM_TTL / 1000 });

  // 6) Обновляем RAM
  ramCache = { data: map, exp: Date.now() + RAM_TTL };
  console.log(`Sheet refreshed: ${map.size} distinct triggers`);
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
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = { chat_id: chatId, text };
  if (replyTo) body.reply_to_message_id = replyTo;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ----------------- Обработчик HTTP (Webhook) -----------------
addEventListener('fetch', (event) => {
  event.respondWith(handleRequest(event.request, event));
});

/**
 * @param {Request} request 
 * @param {{ env: any }} event 
 * @returns {Promise<Response>}
 */
async function handleRequest(request, event) {
  // Health-check на GET-запросы
  if (request.method === 'GET') {
    return new Response('🐈‍⬛ CatBot online', { status: 200 });
  }

  // Обрабатываем POST от Telegram
  try {
    const update = await request.json().catch(() => null);
    if (!update || !update.message || !update.message.text) {
      // Если нет поля message.text, просто возвращаем OK
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const chatId = update.message.chat.id;
    const textIn = (update.message.text || '').trim();
    const key = textIn.toLowerCase();

    // Команда для перезагрузки данных из Google Sheets
    if (key === '/reload') {
      await event.env.SHEET_KV.delete('sheet-v1');
      ramCache = null;
      try {
        await fetchSheet(event.env);
        await sendTelegram(event.env, chatId, 'Данные перезагружены ✅');
      } catch (err) {
        console.error('Error reloading sheet:', err);
        await sendTelegram(event.env, chatId, 'Ошибка при перезагрузке таблицы 😿');
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Получаем карту триггер→массив ответов
    let map;
    try {
      map = await fetchSheet(event.env);
    } catch (err) {
      console.error('Error fetching sheet:', err);
      await sendTelegram(event.env, chatId, 'Не удалось получить данные из таблицы 😿');
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
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
        'Не знаю такого триггера 🙀 Напишите /reload, если вы только что добавили новый триггер.'
      );
    }
  } catch (err) {
    console.error('Handler error:', err);
  }

  // Всегда возвращаем 200 OK с {ok:true}, чтобы Telegram не отключил webhook
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

// ----------------- Обработчик CRON (по расписанию) -----------------
addEventListener('scheduled', (event) => {
  event.waitUntil(handleScheduled(event));
});

/**
 * При срабатывании планировщика (раз в 5 минут) обновляем кеш данных
 * @param {{ env: any }} event 
 */
async function handleScheduled(event) {
  try {
    await fetchSheet(event.env);
  } catch (err) {
    console.error('Scheduled refresh error:', err);
  }
}
