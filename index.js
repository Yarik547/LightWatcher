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
const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS || 60_000);

const DATA_DIR = process.env.DATA_DIR || path.resolve("./data");
const SUBSCRIBERS_FILE = path.join(DATA_DIR, "subscribers.json");

const bot = new Telegraf(BOT_TOKEN);

// --- Робота з базою підписників ---

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

// --- Головна логіка парсингу через Puppeteer ---

async function fetchScheduleImageUrl() {
	console.log(`[${nowText()}] Запуск браузера для перевірки сайту...`);

	// Запускаємо браузер (headless: true означає без вікна)
	const browser = await puppeteer.launch({
		headless: "new",
		executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null, // Важливо для деяких оточень
		args: [
			"--no-sandbox",
			"--disable-setuid-sandbox",
			"--disable-dev-shm-usage", // Вирішує проблему з нестачею пам'яті в Docker
			"--single-process", // Економить ресурси на Railway
			"--no-zygote",
		],
	});
	try {
		const page = await browser.newPage();

		// Маскуємося під звичайного користувача
		await page.setUserAgent(
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
		);

		// Переходимо на сайт і чекаємо на завантаження мережі
		await page.goto(TARGET_URL, {
			waitUntil: "networkidle2",
			timeout: 45000,
		});

		// Чекаємо саме на той клас, який ми бачили в інспекторі
		console.log("Очікую на появу елемента .power-off__current...");
		await page.waitForSelector(".power-off__current", { timeout: 20000 });

		// Витягуємо дані прямо з DOM браузера
		const src = await page.evaluate(() => {
			const link = document.querySelector(".power-off__current a");
			if (link && link.href) return link.href;

			const img = document.querySelector(".power-off__current img");
			return img ? img.src : null;
		});

		if (!src) {
			throw new Error(
				"Контейнер знайдено, але посилання на картинку відсутнє.",
			);
		}

		console.log(`Успішно знайдено: ${src}`);
		return src;
	} catch (error) {
		console.error("Помилка при роботі Puppeteer:", error.message);
		throw error;
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
let lastErrorNotifiedAt = 0;

async function checkAndBroadcast() {
	try {
		const imageUrl = await fetchScheduleImageUrl();

		if (imageUrl && imageUrl !== lastImageUrl) {
			console.log("Графік змінився! Починаю розсилку...");
			lastImageUrl = imageUrl;

			for (const chatId of subscribers) {
				try {
					await sendScheduleToChat(chatId, imageUrl);
				} catch (e) {
					const msg = String(
						e?.response?.description || e?.message || "",
					);
					if (
						msg.toLowerCase().includes("blocked") ||
						msg.toLowerCase().includes("chat not found")
					) {
						subscribers.delete(chatId);
						saveSubscribers(subscribers);
					}
				}
			}
		} else {
			console.log("Змін у графіку не виявлено.");
		}
	} catch (e) {
		const now = Date.now();
		if (now - lastErrorNotifiedAt > 30 * 60_000) {
			// Повідомляємо про помилку не частіше ніж раз на 30 хв
			lastErrorNotifiedAt = now;
			console.error("Критична помилка моніторингу:", e.message);
		}
	}
}

// --- Команди бота ---

bot.start(async (ctx) => {
	subscribers.add(ctx.chat.id);
	saveSubscribers(subscribers);
	await ctx.reply(
		"Привіт! Я моніторю сайт ЛОЕ. Як тільки графік оновиться — я надішлю його вам.",
		kb(),
	);

	try {
		const url = await fetchScheduleImageUrl();
		lastImageUrl = url;
		await sendScheduleToChat(
			ctx.chat.id,
			url,
			"Поточний графік на цей момент:",
		);
	} catch (e) {
		await ctx.reply(
			"Сайт зараз не віддає графік, але я підписав вас на оновлення.",
		);
	}
});

bot.action("SCHEDULE_NOW", async (ctx) => {
	await ctx.answerCbQuery("Зачекайте, запускаю браузер...");
	try {
		const url = await fetchScheduleImageUrl();
		await sendScheduleToChat(ctx.chat.id, url, "Ваш запит вручну:");
	} catch (e) {
		await ctx.reply(`Не вдалося отримати графік: ${e.message}`);
	}
});

bot.on("text", async (ctx) => {
	const t = ctx.message.text.toLowerCase();
	if (t.includes("графік") || t.includes("зараз")) {
		try {
			const url = await fetchScheduleImageUrl();
			await sendScheduleToChat(ctx.chat.id, url);
		} catch (e) {
			await ctx.reply("Помилка при отриманні. Спробуйте через хвилину.");
		}
	}
});

// --- Запуск ---

bot.launch().then(() => {
	console.log("Бот успішно запущений через Puppeteer!");
	// Перша перевірка через 5 секунд після старту, далі за інтервалом
	setTimeout(checkAndBroadcast, 5000);
	setInterval(checkAndBroadcast, CHECK_INTERVAL_MS);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
