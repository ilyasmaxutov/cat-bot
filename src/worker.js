const commandMap = {
  "/command1": "мяу",
  "/command2": "песенка",
  "/command3": "обнимашка",
  "/command4": "скучно",
  "/command5": "миссия",
  "/command6": "поговорим",
};

const RANGE = encodeURIComponent("Sheet1!A:C");
const RAM_TTL = 5 * 60 * 1000;
let ramCache = null;

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function fetchSheet(env) {
  if (!env.SHEET_KV) {
    throw new Error("Binding 'SHEET_KV' is not defined.");
  }

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

  if (kvRaw) {
    const map = new Map(kvRaw);
    ramCache = { data: map, exp: Date.now() + RAM_TTL };
    return map;
  }

  if (!env.GOOGLE_SHEETS_ID || !env.GOOGLE_SHEETS_API_KEY) {
    throw new Error("Missing GOOGLE_SHEETS_ID or GOOGLE_SHEETS_API_KEY");
  }

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEETS_ID}/values/${RANGE}?key=${env.GOOGLE_SHEETS_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Sheets API returned ${res.status}`);
  }

  const json = await res.json();
  const values = Array.isArray(json.values) ? json.values : [];
  const map = new Map();

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const rawTrigger = (row[1] || "").trim().toLowerCase();
    const rawResponse = (row[2] || "").trim();
    if (!rawTrigger || !rawResponse) continue;
    if (!map.has(rawTrigger)) {
      map.set(rawTrigger, []);
    }
    map.get(rawTrigger).push(rawResponse);
  }

  const serialised = Array.from(map.entries());
  try {
    await env.SHEET_KV.put(kvKey, JSON.stringify(serialised), { expirationTtl: RAM_TTL / 1000 });
  } catch (e) {
    console.error("Error writing to KV:", e);
  }

  ramCache = { data: map, exp: Date.now() + RAM_TTL };
  return map;
}

async function sendTelegram(env, chatId, text, replyTo) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

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

addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request, event));
});

async function handleRequest(request, event) {
  if (request.method === "GET") {
    return new Response("🐈‍⬛ CatBot online", { status: 200 });
  }

  try {
    const update = await request.json().catch(() => null);
    if (!update || !update.message || !update.message.text) {
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }

    const chatId = update.message.chat.id;
    const rawText = (update.message.text || "").trim().toLowerCase();
    let key = rawText.startsWith("/") ? commandMap[rawText] || rawText : rawText;

    if (key === "/reload") {
      await env.SHEET_KV.delete("sheet-v1");
      ramCache = null;
      try {
        await fetchSheet(env);
        await sendTelegram(env, chatId, "Данные перезагружены ✅");
      } catch (err) {
        console.error(err);
        await sendTelegram(env, chatId, "Ошибка при перезагрузке таблицы 😿");
      }
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }

    let map;
    try {
      map = await fetchSheet(env);
    } catch (err) {
      console.error(err);
      await sendTelegram(env, chatId, "Не удалось получить данные из таблицы 😿");
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }

    const answers = map.get(key);
    if (answers && answers.length > 0) {
      const randomAnswer = pickRandom(answers);
      await sendTelegram(env, chatId, randomAnswer, update.message.message_id);
    } else {
      await sendTelegram(env, chatId, "Не знаю такого триггера 🙀 Напишите /reload, если вы только что добавили новый триггер.");
    }
  } catch (err) {
    console.error(err);
  }

  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
}

addEventListener("scheduled", (event) => {
  event.waitUntil(handleScheduled(event));
});

async function handleScheduled(event) {
  if (!event.env.SHEET_KV) return;
  try {
    await fetchSheet(event.env);
  } catch (err) {
    console.error(err);
  }
}
