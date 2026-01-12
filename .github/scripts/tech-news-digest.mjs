import fs from "fs";
import path from "path";
import Parser from "rss-parser";
import { Agent, setGlobalDispatcher } from "undici";

// 👇 ローカル実行時だけ dotenv を読む
if (!process.env.GITHUB_ACTIONS) {
  const dotenvPath = path.resolve(process.cwd(), ".env.local");
  if (fs.existsSync(dotenvPath)) {
    const dotenv = await import("dotenv");
    dotenv.config({ path: dotenvPath });
    console.log("Loaded .env.local");
  }
}

const {
  OPENAI_API_KEY,
  SLACK_WEBHOOK_URL,
  FEEDS = "",
  MODEL = "gpt-4.1-mini",
  HOURS_LOOKBACK = "72",
  MAX_ITEMS_PER_FEED = "15",
} = process.env;

// ---- 以下は前回と同じ ----

if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
if (!SLACK_WEBHOOK_URL) throw new Error("Missing SLACK_WEBHOOK_URL");

const undiciAgent = new Agent({
  // 0 はダメなことがあるので 1ms にする
  keepAliveTimeout: 1,
  keepAliveMaxTimeout: 1,
});
setGlobalDispatcher(undiciAgent);

const feeds = FEEDS.split("\n").map((s) => s.trim()).filter(Boolean);
if (feeds.length === 0) throw new Error("FEEDS is empty");

const lookbackHours = Number(HOURS_LOOKBACK);
const maxItems = Number(MAX_ITEMS_PER_FEED);

const parser = new Parser();

function toDateSafe(x) {
  const d = x ? new Date(x) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

const cutoff = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);

const items = [];
for (const url of feeds) {
  let feed;
  try {
    feed = await parser.parseURL(url);
  } catch (e) {
    console.warn(`WARN: failed to parse feed: ${url}`, e?.message ?? e);
    continue;
  }

  const source = feed.title || url;
  for (const entry of (feed.items || []).slice(0, maxItems)) {
    const title = (entry.title || "").trim();
    const link = (entry.link || "").trim();
    if (!title || !link) continue;

    const published =
      toDateSafe(entry.isoDate) ||
      toDateSafe(entry.pubDate) ||
      toDateSafe(entry.published) ||
      toDateSafe(entry.updated);

    if (published && published < cutoff) continue;

    items.push({
      source,
      title,
      url: link,
      publishedAt: published ? published.toISOString() : null,
    });
  }
}

// 重複排除
const uniq = [];
const seen = new Set();
for (const it of items) {
  if (seen.has(it.url)) continue;
  seen.add(it.url);
  uniq.push(it);
}

const prompt = `
あなたは「Tech News（Slack投稿用）」の編集長です。
対象読者は、React/Next.js中心のフロントエンドエンジニアで、生成AIにも関心があり、
さらにIT企業の新規事業・プロダクト動向も追いたい人です。
以下は直近${lookbackHours}時間の技術ニュース候補です。

# 目的
直近の候補一覧から「本当に読む価値があるもの」を選び、Slackに投稿できる形に要約する。

# 優先順位（高→低）
1) Security / 脆弱性（RSC/App Router/依存関係/サプライチェーン）
2) Breaking change / 互換性影響
3) 実運用に効く新機能・新API（React/Next/ブラウザ/ツール）
4) 設計・アーキテクチャの普遍知（再現性が高い学び）
5) IT企業の新規事業/プロダクト発表（市場性・戦略が読み取れる）

# 採点ルール（合計10点）
- Impact(0-4): 影響範囲の広さ
- Urgency(0-3): 今すぐ確認/対応が必要か
- Relevance(0-2): React/Next/AI/新規事業にどれだけ直結するかまた生成AIのハックに役立つか
- Credibility(0-1): 公式/一次情報/信頼性

# 制約
- 推測しない。候補にないニュースは書かない。
- 最大5件に絞る（スコア順）。同じ話題は1件に統合。
- 1件あたり3行以内：
  1) 何が起きた
  2) 影響/対象
  3) 取るべきアクション（読む/対応/様子見）
- 各項目に必ずURLを付ける。
- 最後に「今日のアクション（最大3つ）」を箇条書きで出す。

# 出力フォーマット（必ずこの形）
📰 Tech News｜本日の注目（上位5件）
1) [score/10] タイトル — 出典
   - 何が起きた:
   - 影響:
   - アクション:
   URL: ...

...（最大5件）

✅ 今日のアクション
- ...
- ...
- ...

# 候補JSON
{ここに候補JSON}
${JSON.stringify(uniq, null, 2)}
`.trim();

async function callOpenAI() {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, input: prompt }),
  });

  const data = await res.json();

  let text = "";
  for (const out of data.output ?? []) {
    for (const c of out.content ?? []) {
      if (c.type === "output_text" || c.type === "text") {
        text += c.text ?? "";
      }
    }
  }
  return text.trim();
}

async function postToSlack(message) {
  await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: message }),
  });
}

try {
  const summary = uniq.length
    ? await callOpenAI()
    : "（ニュース候補が取得できませんでした）";


  await postToSlack(`🧪 *Tech News*\n\n${summary}`);
  console.log("OK");
} finally {
  // TLSSocket を解放してプロセスを終わらせる
  await undiciAgent.close();
  setImmediate(() => process.exit(0));
}