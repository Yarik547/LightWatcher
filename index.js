import axios from "axios";
import * as cheerio from "cheerio";
import fs from "node:fs";
import path from "node:path";
import { Telegraf, Markup } from "telegraf";
import puppeteer from "puppeteer";
import "dotenv/config";

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN env");

const TARGET_URL = process.env.TARGET_URL || "https://poweron.loe.lviv.ua/";
const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS || 300_000);

const DATA_DIR = process.env.DATA_DIR || path.resolve("./data");
const SUBSCRIBERS_FILE = path.join(DATA_DIR, "subscribers.json");

const bot = new Telegraf(BOT_TOKEN);

// --- Робота з базою ---

function ensureDataDir() {
	if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
	if (!fs.existsSync(SUBSCRIBERS_FILE))
		fs.writeFileSync(SUBSCRIBERS_FILE, "[]", "utf-8");
}

function loadSubscribers() {
	ensureDataDir();
	try {
		const raw = fs.readFileSync(SUBSCRIBERS_FILE, "utf-8");
		const arr = JSON.parse(raw);
		return new Set(
			(Array.isArray(arr) ? arr : []).map(Number).filter(Number.isFinite),
		);
	} catch {
		return new Set();
	}
}

function saveSubscribers(set) {
	ensureDataDir();
	fs.writeFileSync(
		SUBSCRIBERS_FILE,
		JSON.stringify([...set], null, 2),
		"utf-8",
	);
}

let subscribers = loadSubscribers();

// --- Допоміжні функції ---

function kb() {
	return Markup.inlineKeyboard([
		Markup.button.callback("📊 Графік зараз", "SCHEDULE_NOW"),
	]);
}

function nowText() {
	const d = new Date();
	const pad = (n) => String(n).padStart(2, "0");
	return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// --- Головна логіка парсингу ---

async function fetchScheduleImageUrl() {
	console.log(`[${nowText()}] Спроба отримати графік...`);

	const browser = await puppeteer.launch({
		headless: "new",
		executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
		args: [
			"--no-sandbox",
			"--disable-setuid-sandbox",
			"--disable-dev-shm-usage",
			"--single-process",
			"--no-zygote",
		],
	});

	try {
		const page = await browser.newPage();
		// Встановлюємо реалістичний User-Agent
		await page.setUserAgent(
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
		);

		// Чекаємо завантаження самого документа
		await page.goto(TARGET_URL, {
			waitUntil: "domcontentloaded",
			timeout: 60000,
		});

		// "М'яке" очікування селектора (якщо сайт тупить)
		let src = null;
		for (let i = 0; i < 3; i++) {
			// 3 спроби перевірити наявність елемента
			console.log(`Спроба знайти елемент #${i + 1}`);

			src = await page.evaluate(() => {
				const container = document.querySelector(".power-off__current");
				if (!container) return null;

				const link = container.querySelector("a");
				if (link && link.href && link.href.includes("api.loe"))
					return link.href;

				const img = container.querySelector("img");
				return img ? img.src : null;
			});

			if (src) break;
			await new Promise((r) => setTimeout(r, 4000)); // Чекаємо 4 секунди між спробами
		}

		return src;
	} catch (error) {
		console.error("Критична помилка Puppeteer:", error.message);
		return null;
	} finally {
		await browser.close();
	}
}

async function sendScheduleToChat(chatId, imageUrl, extraText = "") {
	const caption = `💡 *Графік оновлено* \n🕒 ${nowText()}${extraText ? `\n\n_${extraText}_` : ""}`;
	await bot.telegram.sendPhoto(chatId, imageUrl, {
		caption,
		parse_mode: "Markdown",
		...kb(),
	});
}

// --- Фонова перевірка ---

let lastImageUrl = null;

async function checkAndBroadcast() {
	try {
		const imageUrl = await fetchScheduleImageUrl();
		if (imageUrl && imageUrl !== lastImageUrl) {
			lastImageUrl = imageUrl;
			for (const chatId of subscribers) {
				try {
					await sendScheduleToChat(chatId, imageUrl);
				} catch (e) {
					if (
						e.description?.includes("blocked") ||
						e.description?.includes("chat not found")
					) {
						subscribers.delete(chatId);
						saveSubscribers(subscribers);
					}
				}
			}
		}
	} catch (e) {
		console.error("Помилка автоматичної перевірки:", e.message);
	}
}

// --- Команди ---

bot.start(async (ctx) => {
	subscribers.add(ctx.chat.id);
	saveSubscribers(subscribers);
	await ctx.reply(
		"Бот активовано! Я надішлю графік, коли він з'явиться або оновиться.",
		kb(),
	);
});

bot.action("SCHEDULE_NOW", async (ctx) => {
	// Миттєва відповідь, щоб Telegram не видавав помилку кнопки
	await ctx.answerCbQuery("Шукаю графік на сайті...").catch(() => {});

	try {
		const url = await fetchScheduleImageUrl();
		if (url) {
			await sendScheduleToChat(ctx.chat.id, url, "Поточний графік:");
		} else {
			await ctx.reply(
				"На жаль, зараз не вдалося знайти графік на сторінці. Спробуйте ще раз через хвилину або перевірте сайт вручну.",
			);
		}
	} catch (e) {
		await ctx.reply("Виникла технічна помилка при зверненні до сайту.");
	}
});

bot.on("text", async (ctx) => {
	const t = ctx.message.text.toLowerCase();
	if (t.includes("графік") || t.includes("світло")) {
		const url = await fetchScheduleImageUrl();
		if (url) await sendScheduleToChat(ctx.chat.id, url);
		else await ctx.reply("Графік не знайдено.");
	}
});

// --- Запуск ---

bot.launch().then(() => {
	console.log("Бот успішно працює!");
	setInterval(checkAndBroadcast, CHECK_INTERVAL_MS);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
