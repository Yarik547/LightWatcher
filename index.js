import axios from "axios";
import fs from "node:fs";
import path from "node:path";
import { Telegraf, Markup } from "telegraf";
import puppeteer from "puppeteer";
import "dotenv/config";

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN env");

const TARGET_URL = process.env.TARGET_URL || "https://poweron.loe.lviv.ua/";
const CHECK_INTERVAL_MS = 300_000; // 5 хвилин

const DATA_DIR = path.resolve("./data");
const SUBS_FILE = path.join(DATA_DIR, "subscribers.json");
const CACHE_FILE = path.join(DATA_DIR, "last_graph.json");

const bot = new Telegraf(BOT_TOKEN);

// --- Сховище в пам'яті (кеш) ---
let cachedGraph = { url: null, time: null };

// --- Ініціалізація бази ---
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (fs.existsSync(CACHE_FILE))
	cachedGraph = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));

function loadSubs() {
	try {
		return new Set(JSON.parse(fs.readFileSync(SUBS_FILE, "utf-8")));
	} catch {
		return new Set();
	}
}

function saveSubs(set) {
	fs.writeFileSync(SUBS_FILE, JSON.stringify([...set]));
}

let subscribers = loadSubs();

// --- Робота з браузером ---
async function fetchGraph() {
	console.log(`[${new Date().toLocaleTimeString()}] Спроба парсингу...`);
	const browser = await puppeteer.launch({
		headless: "new",
		args: [
			"--no-sandbox",
			"--disable-setuid-sandbox",
			"--disable-dev-shm-usage",
			"--disable-blink-features=AutomationControlled",
		],
	});

	try {
		const page = await browser.newPage();
		await page.setUserAgent(
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
		);

		// Railway іноді потребує більше часу на DNS
		await page.goto(TARGET_URL, {
			waitUntil: "networkidle2",
			timeout: 60000,
		});

		// Чекаємо рендерингу віджетів
		await new Promise((r) => setTimeout(r, 15000));

		const data = await page.evaluate(() => {
			const el =
				document.querySelector(".power-off__current a") ||
				document.querySelector(".power-off__current img");
			return el ? el.href || el.src : null;
		});

		if (data) {
			cachedGraph = {
				url: data,
				time: new Date().toLocaleString("uk-UA"),
			};
			fs.writeFileSync(CACHE_FILE, JSON.stringify(cachedGraph));
		}
		return data;
	} catch (e) {
		console.error("Puppeteer Error:", e.message);
		return null;
	} finally {
		await browser.close();
	}
}

// --- Повідомлення ---
async function sendGraph(chatId, isUpdate = false) {
	if (!cachedGraph.url) {
		return bot.telegram.sendMessage(
			chatId,
			"⚠️ Графік ще не завантажено. Спробую ще раз за кілька хвилин.",
		);
	}

	const caption = isUpdate
		? `🆕 *ГРАФІК ОНОВЛЕНО!*\n🕒 Стан на: ${cachedGraph.time}`
		: `📊 *Поточний графік*\n🕒 Останнє оновлення: ${cachedGraph.time}`;

	await bot.telegram.sendPhoto(chatId, cachedGraph.url, {
		caption,
		parse_mode: "Markdown",
		...Markup.inlineKeyboard([
			Markup.button.callback("🔄 Оновити зараз", "SCHEDULE_NOW"),
		]),
	});
}

// --- Цикл перевірки ---
async function checkUpdates() {
	const oldUrl = cachedGraph.url;
	const newUrl = await fetchGraph();

	if (newUrl && newUrl !== oldUrl) {
		console.log("Оновлення знайдено! Розсилка...");
		for (const id of subscribers) {
			sendGraph(id, true).catch(() => {});
		}
	}
}

// --- Команди ---
bot.start(async (ctx) => {
	subscribers.add(ctx.chat.id);
	saveSubs(subscribers);
	await ctx.reply("Бот активовано! Я перевіряю сайт ЛОЕ кожні 5 хвилин.");
	sendGraph(ctx.chat.id);
});

bot.action("SCHEDULE_NOW", async (ctx) => {
	await ctx.answerCbQuery("Перевіряю стан...").catch(() => {});
	// Спочатку шлемо кеш (миттєво)
	await sendGraph(ctx.chat.id);
	// Потім запускаємо фонову перевірку, якщо кеш старий (опціонально)
});

// --- Старт ---
await bot.telegram.deleteWebhook({ drop_pending_updates: true });
bot.launch().then(() => {
	console.log("Бот запущений");
	checkUpdates();
	setInterval(checkUpdates, CHECK_INTERVAL_MS);
});
