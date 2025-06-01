/**
 * worker.js — Telegram-бот для Cloudflare Workers (Service Worker синтаксис).
 * Читает триггеры из Google Sheets (колонка B) и выдаёт случайный ответ (колонка C).
 * Защищаемся от отсутствия binding "SHEET_KV" в scheduled.
 */

/** ----- Mapping команд → триггер из таблицы ----- */
const commandMap = {
  '/command1': 'мяу',
  '/command2': 'песенка',
  '/command3': 'обнимашка',
  '/command4': 'скучно',
  '/command5': 'миссия',
  '/command6': 'поговорим',
};

/** ----- Константы и RAM-кэш ----- */
const RANGE = encodeURIComponent('Sheet1!A:C');
const RAM_TTL = 5 * 60 * 1000;
let ramCache = null;

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
 * @param {{ SHEET_KV: KVNamespace, GOOGLE_SHEETS_API_KEY: string, GOOGLE_SHEETS_ID: string }} env 
 * @returns {Promise<Map<string,string[]>>}
 */
async function fetchSheet(env) {
  // Проверка существования привязки
  if (!env.SHEET_KV) {
    throw new Error('Binding "SHEET_KV" is not defined. Check wrangler.toml or Dashboard.');
  }

  // 1) RAM-слой
  if (ramCache && Date.now() < ramCache.exp) {
    return ramCache.data;
  }

  // 2) KV-слой
  const kvKey = 'sheet-v1';
  let kvRaw;
  try {
    kvRaw = await env.SHEET_KV.get(kvKey, { type: 'json' });
  } catch (e) {
    throw new Error('Error accessing KV: ' + e.message);
  }
  if (kvRaw) {
    const map = new Map(kvRaw);
    ramCache = { data: map, exp: Date.now() + RAM_TTL };
    return map;
  }

  // 3) Запрос к Google Sheets API
  if (!env.GOOGLE_SHEETS_ID || !env.GOOGLE_SHEETS_API_KEY) {
    throw new Error('ENV variables GOOGLE_SHEETS_ID or GOOGLE_SHEETS_API_KEY are missing.');
  }
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEETS_ID}` +
              `/values/${RANGE}?key=${env.GOOGLE_SHEETS_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Sheets API returned HTTP ${res.status}`);
  }
  const json = await res.json();
  const values = Array.isArray(json.values) ? json.values : [];

  // 4) Формируем Map<trigger, [ответы]> (пропускаем первую строку)
  const map = new Map();
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const rawTrigger = (row[1] || '').trim().toLowerCase();
    const rawResponse = (row[2] || '').trim();
    if (!rawTrigger || !rawResponse) continue;
    if (!map.has(rawTrigger)) {
      map.set(rawTrigger, []);
    }
    map.get(rawTrigger).push(rawResponse);
  }

  // 5) Сохраняем в KV
  const serialised = Array.from(map.entries());
  try {
    await env.SHEET_KV.put(kvKey, JSON.stringify(serialised), { expirationTtl: RAM_TTL / 1000 });
  } catch (e) {
    console.error('Error writing to KV:', e);
  }

  // 6) Обновляем RAM
  ramCache = { data: map, exp: Date.now() + RAM_TTL };
  console.log(`Sheet refreshed: ${map.size} triggers`);
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
  if (!env.TELEGRAM_BOT_TOKEN) {
    console.error('Missing TELEGRAM_BOT_TOKEN.');
    return;
  }
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = { chat_id: chatId, text };
  if (replyTo) body.reply_to_message_id = replyTo;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error('Error sending message to Telegram:', e);
  }
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
  if (request.method === 'GET') {
    return new Response('🐈‍⬛ CatBot online', { status: 200 });
  }

  try {
    const update = await request.json().catch(() => null);
    if (!update || !update.message || !update.message.text) {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const chatId = update.message.chat.id;
    const rawText = (update.message.text || '').trim().toLowerCase();
    // Преобразуем команду через commandMap
    let key;
    if (rawText.startsWith('/')) {
      key = commandMap[rawText] || rawText;
    } else {
      key = rawText;
    }

    // Обработка команды /reload
    if (key === '/reload') {
      if (!event.env.SHEET_KV) {
        await sendTelegram(event.env, chatId, 'Binding "SHEET_KV" не найден. Провер")] }]}
