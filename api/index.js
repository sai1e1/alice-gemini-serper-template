const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 1200;
const MAX_ALICE_TEXT = 1024;
const TOTAL_RESPONSE_BUDGET_MS = 3600;
const SERPER_TIMEOUT_MS = 600;
const LLM_TIMEOUT_MS = 3000;

// Провайдер выбирается переменной LLM_PROVIDER.
// baseUrl и model можно переопределить через LLM_BASE_URL и LLM_MODEL.
const PROVIDERS = {
  // openrouter/free — роутер, который сам выбирает одну из бесплатных моделей
  openrouter: { kind: "openai", baseUrl: "https://openrouter.ai/api/v1", model: "openrouter/free" },
  groq: { kind: "openai", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile" },
  mistral: { kind: "openai", baseUrl: "https://api.mistral.ai/v1", model: "mistral-small-latest" },
  // В модели YandexGPT вместо <folder_id> подставьте идентификатор каталога Yandex Cloud.
  yandex: { kind: "openai", baseUrl: "https://llm.api.cloud.yandex.net/v1", model: "gpt://<folder_id>/yandexgpt-lite/latest" },
  gemini: { kind: "google", baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-2.0-flash" }
};

const DEFAULT_PROVIDER = "openrouter";

function resolveLlmConfig(env = process.env) {
  const requested = String(env.LLM_PROVIDER || (env.GEMINI_API_KEY ? "gemini" : DEFAULT_PROVIDER))
    .trim()
    .toLowerCase();
  const preset = PROVIDERS[requested];
  if (!preset) throw new Error("UNKNOWN_PROVIDER");

  const model = String(
    env.LLM_MODEL || (requested === "gemini" ? env.GEMINI_MODEL : "") || preset.model
  ).trim();
  const apiKey = String(env.LLM_API_KEY || (requested === "gemini" ? env.GEMINI_API_KEY : "") || "").trim();
  const baseUrl = String(env.LLM_BASE_URL || preset.baseUrl).trim().replace(/\/+$/, "");

  return { provider: requested, kind: preset.kind, baseUrl, model, apiKey };
}

const SYSTEM_PROMPT = [
  "Ты — полезный голосовой помощник в навыке Яндекс Алисы.",
  "Отвечай естественно, по-русски, кратко и так, чтобы ответ было удобно слушать.",
  "Обычно используй 1–3 коротких предложения. Не используй Markdown, таблицы, списки с символами или длинные вступления.",
  "Если вопрос требует актуальных данных и переданы результаты поиска, опирайся на них; не выдумывай отсутствующие факты.",
  "Если не знаешь ответа, честно скажи об этом."
].join(" ");

function aliceResponse(text, endSession = false, history = []) {
  return {
    version: "1.0",
    response: {
      text: fitAliceText(text),
      end_session: endSession
    },
    session_state: { history }
  };
}

function fitAliceText(value) {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (text.length <= MAX_ALICE_TEXT) return text || "Не удалось подготовить ответ.";

  const candidate = text.slice(0, MAX_ALICE_TEXT - 1);
  const sentenceEnd = Math.max(
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("! "),
    candidate.lastIndexOf("? ")
  );
  if (sentenceEnd >= 300) return candidate.slice(0, sentenceEnd + 1).trim();

  const lastSpace = candidate.lastIndexOf(" ");
  return (lastSpace > 200 ? candidate.slice(0, lastSpace) : candidate).trim() + "…";
}

function isSearchIntent(text) {
  return /\b(latest|today|current|news|weather|price|exchange rate|recent|search|look up)\b|сегодня|сейчас|последн|новост|погод|курс валют|найди|поищи|актуальн|сколько стоит|свежие данные/i.test(text);
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(item => item && (item.role === "user" || item.role === "model") && typeof item.text === "string")
    .slice(-MAX_HISTORY_MESSAGES)
    .map(item => ({ role: item.role, text: item.text.slice(0, MAX_HISTORY_MESSAGE_CHARS) }));
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

async function searchWeb(query, timeoutMs) {
  const key = process.env.SERPER_API_KEY;
  if (!key || timeoutMs < 150) return "";

  try {
    const { response, data } = await fetchJson(
      "https://google.serper.dev/search",
      {
        method: "POST",
        headers: {
          "X-API-KEY": key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ q: query, gl: "ru", hl: "ru", num: 3 })
      },
      Math.min(SERPER_TIMEOUT_MS, timeoutMs)
    );

    if (!response.ok) {
      console.warn("Serper request failed with HTTP", response.status);
      return "";
    }

    const items = (Array.isArray(data.organic) ? data.organic : [])
      .slice(0, 3)
      .map((item, i) => {
        const title = String(item.title || "").slice(0, 180);
        const snippet = String(item.snippet || "").slice(0, 350);
        const link = String(item.link || "").slice(0, 240);
        return `${i + 1}. ${title}: ${snippet} ${link}`.trim();
      });

    const answerBox = data.answerBox?.answer || data.answerBox?.snippet;
    if (answerBox) items.unshift(`Краткий ответ поисковика: ${String(answerBox).slice(0, 350)}`);
    return items.length ? items.join("\n") : "";
  } catch (error) {
    console.warn("Serper request did not finish in time; continuing without search.");
    return "";
  }
}

function buildPrompt(text, searchContext) {
  return searchContext
    ? `${text}\n\nРезультаты поиска в интернете:\n${searchContext}\nИспользуй их только там, где они относятся к вопросу.`
    : text;
}

async function askLlm(text, history, searchContext, timeoutMs) {
  const config = resolveLlmConfig();
  if (!config.apiKey) throw new Error("MISSING_LLM_KEY");
  if (!config.model || config.model.includes("<folder_id>")) throw new Error("MISSING_MODEL");
  if (timeoutMs < 250) throw new Error("TIME_BUDGET_EXHAUSTED");

  const budget = Math.min(LLM_TIMEOUT_MS, timeoutMs);
  const prompt = buildPrompt(text, searchContext);

  return config.kind === "google"
    ? askGeminiNative(config, history, prompt, budget)
    : askOpenAiCompatible(config, history, prompt, budget);
}

function throwLlmHttpError(label, status, detail) {
  console.error(`${label} request failed with HTTP`, status, detail || "");
  if (status === 401 || status === 403) throw new Error("LLM_KEY_REJECTED");
  if (status === 404) throw new Error("LLM_MODEL_UNKNOWN");
  if (status === 429) throw new Error("LLM_QUOTA");
  throw new Error("LLM_REQUEST_FAILED");
}

async function askGeminiNative(config, history, prompt, budget) {
  if (!/^[A-Za-z0-9._-]+$/.test(config.model)) throw new Error("INVALID_MODEL_NAME");

  const contents = safeHistory(history).map(item => ({
    role: item.role,
    parts: [{ text: item.text }]
  }));
  contents.push({ role: "user", parts: [{ text: prompt }] });

  const { response, data } = await fetchJson(
    `${config.baseUrl}/models/${config.model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": config.apiKey
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: {
          temperature: 0.5,
          maxOutputTokens: 240
        }
      })
    },
    budget
  );

  if (!response.ok) throwLlmHttpError("Gemini", Number(response.status));

  const candidate = data?.candidates?.[0];
  const answer = (candidate?.content?.parts || [])
    .map(part => typeof part.text === "string" ? part.text : "")
    .join("")
    .trim();

  if (!answer) {
    if (data?.promptFeedback?.blockReason) throw new Error("LLM_BLOCKED");
    throw new Error("LLM_EMPTY_RESPONSE");
  }
  if (candidate?.finishReason === "MAX_TOKENS") {
    console.warn("Gemini reached the output token limit.");
  }
  return answer;
}

async function askOpenAiCompatible(config, history, prompt, budget) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...safeHistory(history).map(item => ({
      role: item.role === "model" ? "assistant" : "user",
      content: item.text
    })),
    { role: "user", content: prompt }
  ];

  const { response, data } = await fetchJson(
    `${config.baseUrl}/chat/completions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Yandex Cloud ждёт "Api-Key ...", остальные — обычный Bearer.
        Authorization: config.provider === "yandex"
          ? `Api-Key ${config.apiKey}`
          : `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: 0.5,
        max_tokens: 240
      })
    },
    budget
  );

  if (!response.ok) {
    throwLlmHttpError(config.provider, Number(response.status), data?.error?.message);
  }

  const answer = String(data?.choices?.[0]?.message?.content ?? "").trim();
  if (!answer) throw new Error("LLM_EMPTY_RESPONSE");
  if (data?.choices?.[0]?.finish_reason === "length") {
    console.warn("Model reached the output token limit.");
  }
  return answer;
}

function errorForUser(error) {
  switch (error?.message) {
    case "MISSING_LLM_KEY":
      return "Сервер пока не настроен. Проверьте переменную LLM_API_KEY в настройках Vercel.";
    case "MISSING_MODEL":
      return "Сервер пока не настроен. Проверьте переменную LLM_MODEL в настройках Vercel.";
    case "UNKNOWN_PROVIDER":
      return "Сервер пока не настроен. Проверьте переменную LLM_PROVIDER в настройках Vercel.";
    case "LLM_KEY_REJECTED":
      return "Не удалось подключиться к нейросети. Проверьте API-ключ в настройках Vercel.";
    case "LLM_MODEL_UNKNOWN":
      return "Модель недоступна для этого ключа. Проверьте переменную LLM_MODEL в настройках Vercel.";
    case "LLM_QUOTA":
      return "Сейчас превышен лимит запросов к нейросети. Попробуйте немного позже.";
    case "LLM_BLOCKED":
      return "Я не смогла обработать этот запрос. Попробуйте спросить иначе.";
    case "TIME_BUDGET_EXHAUSTED":
    case "AbortError":
      return "Не успела подготовить ответ. Попробуйте задать вопрос ещё раз, чуть короче.";
    default:
      return "Не получилось получить ответ от нейросети. Попробуйте ещё раз чуть позже.";
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    let llm;
    try {
      const config = resolveLlmConfig();
      llm = {
        provider: config.provider,
        model: config.model,
        keyConfigured: Boolean(config.apiKey),
        searchConfigured: Boolean(process.env.SERPER_API_KEY)
      };
    } catch (error) {
      llm = { error: error?.message || "UNKNOWN_PROVIDER" };
    }

    return res.status(200).json({
      ok: true,
      service: "alice-gemini-serper",
      message: "Webhook is ready. Yandex Dialogs should send POST requests to /api.",
      llm
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const startedAt = Date.now();
  const remainingMs = () => TOTAL_RESPONSE_BUDGET_MS - (Date.now() - startedAt);
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const text = String(body?.request?.command || body?.request?.original_utterance || "").trim();
  const oldHistory = safeHistory(body?.state?.session?.history);

  if (!text) {
    return res.status(200).json(aliceResponse(
      "Привет! Я могу ответить на вопрос или найти актуальную информацию. Что хочешь узнать?",
      false,
      oldHistory
    ));
  }

  try {
    let searchContext = "";
    if (isSearchIntent(text) && process.env.SERPER_API_KEY) {
      // Search has a very short budget because Alice expects a response within 4.5 seconds.
      searchContext = await searchWeb(text, Math.min(SERPER_TIMEOUT_MS, Math.max(0, remainingMs() - 2600)));
    }

    const answer = await askLlm(
      text,
      oldHistory,
      searchContext,
      Math.max(0, remainingMs() - 500)
    );

    const history = [
      ...oldHistory,
      { role: "user", text: text.slice(0, MAX_HISTORY_MESSAGE_CHARS) },
      { role: "model", text: answer.slice(0, MAX_HISTORY_MESSAGE_CHARS) }
    ].slice(-MAX_HISTORY_MESSAGES);

    return res.status(200).json(aliceResponse(answer, false, history));
  } catch (error) {
    const safeError = error?.message === "AbortError" ? "TIME_BUDGET_EXHAUSTED" : error;
    console.warn("Alice webhook returned a fallback response:", safeError?.message || "unknown error");
    return res.status(200).json(aliceResponse(errorForUser(safeError), false, oldHistory));
  }
}

export { aliceResponse, fitAliceText, isSearchIntent, safeHistory, resolveLlmConfig };
