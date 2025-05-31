/**
 * worker.js — Telegram-бот для Cloudflare Workers без export’ов.
 * Формат Google-Sheets:  A:trigger | B:response
 * Строк с одинаковым trigger может быть несколько – бот выберет случайный ответ.
 */

/** ----- Конфигурация ----- */
/** 
 * Для работы в Dashboard: 
 * в wrangler.toml main указывает на "src/worker.js", 
 * но в Dashboard вы правите Код напрямую.
 * KV-namespace и секреты уже привязаны через UI.
 */

/** ----- Константы ----- */
const SHEET_RANGE = encodeURIComponent('Лист1');   // Имя листа в Google Sheets
const RAM_TTL = 5 * 60 * 1000;                      // 5 минут в мс
let ramCache = null;                                // Глобальный RAM-кэш

/**
 * Выбор случайного элемента из массива
 * @param {Array<any>} arr 
 * @returns {any}
 */
function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Подтягивает данные из Google Sheets и кэширует их в RAM и в KV.
 * Возвращает Map<trigger, [ответы]>.
 * @param {{ TELEGRAM_BOT_TOKEN: string, GOOGLE_SHEETS_API_KEY: string, GOOGLE_SHEETS_ID: string, SHEET_KV: KVNamespace }} env
 */
async function fetchSheet(env) {
  // 1) RAM-слой
  if (ramCache && Date.now() < ramCache.exp) {
    return ramCache.data;
  }

  const kvKey = 'sheet-v1';

  // 2) KV-слой
  const kvRaw = await env.SHEET_KV.get(kvKey, { type: 'json' });
  if (kvRaw) {
    // kvRaw — сериализованный массив пар [[trigger, [ответы]]]
    const map = new Map(kvRaw);
    ramCache = { data: map, exp: Date.now() + RAM_TTL };
    return map;
  }

  // 3) Запрос к Google Sheets API
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEETS_ID}/values/${SHEET_RANGE}?key=${env.GOOGLE_SHEETS_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`Sheets API error: ${res.status}`);
    throw new Error(`Sheets API ${res.status}`);
  }

  const json = await res.json(); // { values: [ [trigger, response], ... ] }
  const values = json.values || [];

  // 4) Строим Map<trigger, [ответы]>
  const map = new Map();
  for (const row of values) {
    const triggerRaw = row[0] || '';
    const responseText = row[1] || '';
    const trigger = triggerRaw.trim().toLowerCase();
    if (!trigger || !responseText) continue;
    if (!map.has(trigger)) {
      map.set(trigger, []);
    }
    map.get(trigger).push(responseText);
  }

  // 5) Сериализуем и пушим в KV (TTL в секундах)
  const serialised = Array.from(map.entries()); // [ [trigger, [ответы]], ... ]
  await env.SHEET_KV.put(kvKey, JSON.stringify(serialised), { expirationTtl: RAM_TTL / 1000 });

  // 6) Обновляем RAM
  ramCache = { data: map, exp: Date.now() + RAM_TTL };
  console.log(`Sheet refreshed: ${map.size} triggers`);
  return map;
}

/**
 * Отправляет сообщение в Telegram
 * @param {{ TELEGRAM_BOT_TOKEN: string }} env 
 * @param {number} chatId 
 * @param {string} text 
 * @param {number=} replyTo 
 */
async function sendTelegram(env, chatId, text, replyTo) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: chatId,
    text: text,
  };
  if (replyTo) {
    body.reply_to_message_id = replyTo;
  }
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// --------------- Обработчик HTTP (Webhook) ---------------
addEventListener('fetch', (event) => {
  event.respondWith(handleRequest(event.request, event));
});

/**
 * @param {Request} request 
 * @param {{ env: any }} event
 * @returns {Promise<Response>}
 */
async function handleRequest(request, event) {
  // 1) Health-check: если GET, просто ответим «alive»
  if (request.method === 'GET') {
    return new Response('🐈‍⬛ CatBot online', { status: 200 });
  }

  // 2) POST от Telegram
  try {
    const upd = await request.json();
    // Если нет текстового сообщения — игнорируем
    if (!upd.message || !upd.message.text) {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const chatId = upd.message.chat.id;
    const textIn = (upd.message.text || '').trim();
    const textKey = textIn.toLowerCase();

    // Команда для перезагрузки кэша
    if (textKey === '/reload') {
      await event.env.SHEET_KV.delete('sheet-v1');
      ramCache = null;
      await fetchSheet(event.env); // сразу прогреваем кэш
      await sendTelegram(event.env, chatId, 'Данные перезагружены ✅');
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Получаем Map<trigger, [ответы]>
    const map = await fetchSheet(event.env);
    const answers = map.get(textKey);
    if (answers && answers.length > 0) {
      // Бросаем случайный ответ из списка
      const randomAnswer = pickRandom(answers);
      await sendTelegram(event.env, chatId, randomAnswer, upd.message.message_id);
    } else {
      // Если нет такого триггера
      await sendTelegram(
        event.env,
        chatId,
        'Не знаю такого триггера 🙀 Напишите /reload, если вы только что добавили его.'
      );
    }
  } catch (err) {
    console.error('Handler error:', err);
    // В любом случае возвращаем OK, чтобы Telegram не «думал», что мы упали
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

// --------------- Обработчик CRON (по расписанию) ---------------
addEventListener('scheduled', (event) => {
  event.waitUntil(handleScheduled(event));
});

/**
 * @param {{ env: any }} event 
 */
async function handleScheduled(event) {
  try {
    // Просто обновляем кэш из Google Sheets каждые 5 минут
    await fetchSheet(event.env);
  } catch (err) {
    console.error('Scheduled refresh error:', err);
  }
}
