import axios from "axios";
import * as cheerio from "cheerio";
import fs from "node:fs";
import path from "node:path";
import { Telegraf, Markup } from "telegraf";

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN env");

const TARGET_URL = process.env.TARGET_URL || "https://poweron.loe.lviv.ua/";
const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS || 60_000);

const DATA_DIR = process.env.DATA_DIR || path.resolve("./data");
const SUBSCRIBERS_FILE = path.join(DATA_DIR, "subscribers.json");

const IMG_SELECTOR = ".power-off_current img"; // як на твоєму скріні

const bot = new Telegraf(BOT_TOKEN);

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

function kb() {
	return Markup.inlineKeyboard([
		Markup.button.callback("Графік зараз", "SCHEDULE_NOW"),
	]);
}

async function fetchScheduleImageUrl() {
	const res = await axios.get(TARGET_URL, {
		headers: { "User-Agent": "Mozilla/5.0" },
		timeout: 20_000,
	});

	const $ = cheerio.load(res.data);
	const src = $(IMG_SELECTOR).attr("src");
	if (!src)
		throw new Error(`Не знайшов картинку за селектором: ${IMG_SELECTOR}`);

	// src вже абсолютний у цього сайту, але на всяк випадок:
	if (src.startsWith("http://") || src.startsWith("https://")) return src;
	return new URL(src, TARGET_URL).toString();
}

function nowText() {
	// Простий timestamp без залежностей
	const d = new Date();
	const pad = (n) => String(n).padStart(2, "0");
	return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function sendScheduleToChat(chatId, imageUrl, extraText = "") {
	const caption = `Оновлено: ${nowText()}${extraText ? `\n${extraText}` : ""}`;
	await bot.telegram.sendPhoto(chatId, imageUrl, {
		caption,
		reply_markup: kb().reply_markup,
	});
}

let lastImageUrl = null;
let lastErrorNotifiedAt = 0;

async function checkAndBroadcast() {
	try {
		const imageUrl = await fetchScheduleImageUrl();

		if (imageUrl && imageUrl !== lastImageUrl) {
			lastImageUrl = imageUrl;

			const ids = [...subscribers];
			for (const chatId of ids) {
				try {
					await sendScheduleToChat(chatId, imageUrl);
				} catch (e) {
					// Якщо бот заблокували або чат недоступний — прибираємо підписника
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
		}
	} catch (e) {
		const now = Date.now();
		// щоб не спамити щохвилини: максимум 1 повідомлення про помилку на 15 хв
		if (now - lastErrorNotifiedAt > 15 * 60_000) {
			lastErrorNotifiedAt = now;
			const ids = [...subscribers];
			for (const chatId of ids) {
				try {
					await bot.telegram.sendMessage(
						chatId,
						`Помилка при перевірці сайту, спробую знову.\nДеталі: ${e.message}`,
					);
				} catch {}
			}
		}
	}
}

// Команди
bot.start(async (ctx) => {
	const chatId = ctx.chat.id;
	subscribers.add(chatId);
	saveSubscribers(subscribers);

	await ctx.reply(
		"Привіт! Я надсилатиму оновлення графіка, коли він зміниться.\nНатисни кнопку нижче або напиши “графік”.",
		kb(),
	);

	// Одразу надішлемо поточний графік
	try {
		const imageUrl = await fetchScheduleImageUrl();
		lastImageUrl = imageUrl;
		await sendScheduleToChat(chatId, imageUrl, "Поточний графік.");
	} catch (e) {
		await ctx.reply(`Не зміг отримати графік зараз. Помилка: ${e.message}`);
	}
});

bot.command("status", async (ctx) => {
	const text =
		`Підписників: ${subscribers.size}\n` +
		`Останній URL: ${lastImageUrl || "ще немає"}\n` +
		`Сайт: ${TARGET_URL}\n` +
		`Інтервал: ${Math.round(CHECK_INTERVAL_MS / 1000)} сек`;
	await ctx.reply(text, kb());
});

bot.action("SCHEDULE_NOW", async (ctx) => {
	await ctx.answerCbQuery(); // прибирає “spinner” на кнопці [web:52]
	const chatId = ctx.chat.id;

	subscribers.add(chatId);
	saveSubscribers(subscribers);

	try {
		const imageUrl = await fetchScheduleImageUrl();
		lastImageUrl = imageUrl; // щоб одразу синхронізувати
		await sendScheduleToChat(chatId, imageUrl, "Запит вручну.");
	} catch (e) {
		await ctx.reply(
			`Помилка, спробуй знову пізніше.\nДеталі: ${e.message}`,
			kb(),
		);
	}
});

bot.on("text", async (ctx) => {
	const chatId = ctx.chat.id;
	subscribers.add(chatId);
	saveSubscribers(subscribers);

	const t = (ctx.message.text || "").toLowerCase();
	if (t.includes("графік") || t.includes("зараз") || t.includes("schedule")) {
		try {
			const imageUrl = await fetchScheduleImageUrl();
			lastImageUrl = imageUrl;
			await sendScheduleToChat(chatId, imageUrl, "Запит текстом.");
		} catch (e) {
			await ctx.reply(
				`Помилка, спробуй знову.\nДеталі: ${e.message}`,
				kb(),
			);
		}
	} else {
		await ctx.reply(
			"Напиши “графік” або натисни кнопку “Графік зараз”.",
			kb(),
		);
	}
});

// Запуск
await bot.launch();
console.log("Bot started");

setInterval(checkAndBroadcast, CHECK_INTERVAL_MS);

// graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
