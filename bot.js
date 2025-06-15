const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const axios = require("axios"); // Import axios for making HTTP requests

// --- Configuration for Bot Token ---
let botToken;
try {
  // Try to load from config.js for local development
  const config = require("./config");
  botToken = config.telegramBotToken;
} catch (e) {
  // If config.js is not found or fails, assume we are in a deployment environment
  // and try to get token from environment variables.
  botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.error(
      "ERROR: TELEGRAM_BOT_TOKEN not found! Please set it in config.js (local) or as an environment variable (deployment)."
    );
    // In deployment, you might want to exit if the token isn't found
    // process.exit(1);
  }
}

// Initialize the bot with your token
const bot = new TelegramBot(botToken, { polling: true });

// --- User Tag Storage ---
const USER_TAGS_FILE = "userTags.json";
const usersAwaitingTag = {}; // To track users in the /settag process

// Function to load user tags from the JSON file
function loadUserTags() {
  try {
    if (fs.existsSync(USER_TAGS_FILE)) {
      const data = fs.readFileSync(USER_TAGS_FILE, "utf8");
      return JSON.parse(data);
    }
  } catch (error) {
    console.error("Error loading user tags from file:", error.message);
  }
  return {};
}

// Function to save user tags to the JSON file
function saveUserTags(userTags) {
  try {
    fs.writeFileSync(USER_TAGS_FILE, JSON.stringify(userTags, null, 2), "utf8");
  } catch (error) {
    console.error("Error saving user tags to file:", error.message);
  }
}

let userTags = loadUserTags();

/**
 * Basic validation for an Amazon Associate Tag.
 * @param {string} tag - The potential Amazon Associate Tag.
 * @returns {boolean} True if the tag appears valid, false otherwise.
 */
function isValidAmazonTag(tag) {
  const tagRegex = /^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*-[0-9]{1,3}$/;
  return tagRegex.test(tag);
}

/**
 * Converts a standard (long) Amazon URL into an affiliate link.
 * @param {string} url - The original Amazon product URL.
 * @param {string} tag - The Amazon Associate Tag.
 * @returns {string} The affiliate URL or the original URL if conversion fails/tag is missing.
 */
function convertToAffiliateLink(url, tag) {
  if (!tag) {
    return url;
  }

  const amazonLongRegex =
    /(amazon\.(com|co\.uk|de|fr|es|it|ca|com\.au|co\.jp|cn|in))\/.*(?:dp|gp\/product)\/([A-Z0-9]{10})/i;
  const match = url.match(amazonLongRegex);

  if (match) {
    const domain = match[1];
    const asin = match[3];

    return `https://${domain}/dp/${asin}?tag=${tag}`;
  }
  return url;
}

/**
 * Resolves a short Amazon link (e.g., amzn.to/xyz) to its full, long URL.
 * Includes common short domains.
 * @param {string} shortUrl - The short Amazon URL.
 * @returns {Promise<string|null>} A promise that resolves to the full URL or null if resolution fails.
 */
async function resolveShortAmazonLink(shortUrl) {
  // UPDATED: Added amzn-to.co to the list of recognized short domains
  const shortLinkRegex =
    /(amzn\.to|a\.co|amzn-to\.co|amazon\.in\/gp\/product)\//i;
  if (!shortLinkRegex.test(shortUrl)) {
    return null;
  }

  try {
    const response = await axios.get(shortUrl, { maxRedirects: 10 });
    const finalUrl = response.request.res.responseUrl;
    console.log(
      `Resolved short link (internal log): ${shortUrl} -> ${finalUrl}`
    );
    return finalUrl;
  } catch (error) {
    console.error(`Error resolving short link ${shortUrl}:`, error.message);
    return null;
  }
}

// --- Telegram Bot Command Handlers ---

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  delete usersAwaitingTag[userId]; // Clear any pending tag setting

  if (userTags[userId]) {
    bot.sendMessage(
      chatId,
      `Welcome back! Send me an Amazon link (long or short) and I'll convert it for you. Your current Amazon Associate Tag is: \`${userTags[userId]}\`. You can change it with /settag.`
    );
  } else {
    bot.sendMessage(
      chatId,
      "Hello! Welcome to the Amazon Affiliate Link Converter Bot. To get started, please send me your Amazon Associate Tag by using the /settag command."
    );
  }
});

bot.onText(/\/settag/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  usersAwaitingTag[userId] = true; // Mark this user as awaiting a tag
  bot.sendMessage(
    chatId,
    "Please send me your Amazon Associate Tag now. This will overwrite your previous tag. Example: `yourstore-20`"
  );
});

// --- General Message Handler ---

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text;

  // --- Strict Tag Setting Logic ---
  if (usersAwaitingTag[userId]) {
    const potentialTag = text.trim();
    if (potentialTag.length > 0 && isValidAmazonTag(potentialTag)) {
      userTags[userId] = potentialTag;
      saveUserTags(userTags);
      delete usersAwaitingTag[userId];
      bot.sendMessage(
        chatId,
        `Thank you! Your Amazon Associate Tag has been set to: \`${userTags[userId]}\`. Now, send me any Amazon product link (long or short), and I will convert it into an affiliate link.`
      );
    } else {
      bot.sendMessage(
        chatId,
        "That does not appear to be a valid Amazon Associate Tag format. Please try again with a format like `yourstore-20`."
      );
    }
    return;
  }

  // --- Ignore Commands ---
  if (text.startsWith("/")) {
    bot.sendMessage(
      chatId,
      "Sorry, I don't recognize that command. Please use /start or /settag."
    );
    return;
  }

  // --- Robust URL Extraction and Amazon Link Conversion Logic ---
  // Extract the first URL found in the message text.
  // This handles cases where users might paste a URL with extra text.
  const urlMatch = text.match(/(https?:\/\/[^\s]+)/);
  let originalUrl = urlMatch ? urlMatch[0] : null; // Get the matched URL string or null

  if (!originalUrl) {
    // If no URL was found in the message at all
    bot.sendMessage(
      chatId,
      "That doesn't look like a valid Amazon product link. Please send a full Amazon URL (e.g., `amazon.com/dp/B0xxxxxxx`) or a short one (`amzn.to/xxxx`)."
    );
    return;
  }

  const amazonShortLinkRegex =
    /(amzn\.to|a\.co|amzn-to\.co|amazon\.in\/gp\/product)\//i; // UPDATED REGEX
  const amazonLongLinkRegex =
    /amazon\.(com|co\.uk|de|fr|es|it|ca|com\.au|co\.jp|cn|in)\/.*(?:dp|gp\/product)\/([A-Z0-9]{10})/i;

  let isAmazonLink = false;

  // Check if the extracted URL is a potential short Amazon link
  if (amazonShortLinkRegex.test(originalUrl)) {
    bot.sendMessage(
      chatId,
      "Detecting short Amazon link... Please wait while I convert it for you."
    );
    const resolvedUrl = await resolveShortAmazonLink(originalUrl);

    if (resolvedUrl) {
      originalUrl = resolvedUrl;
      isAmazonLink = amazonLongLinkRegex.test(originalUrl); // Re-check if resolved URL is a valid long Amazon link
    } else {
      bot.sendMessage(
        chatId,
        "Sorry, I could not resolve the short Amazon link. Please try sending the full link or check if the short link is valid."
      );
      return;
    }
  } else {
    // If not a short link, check if it's a long Amazon link directly
    isAmazonLink = amazonLongLinkRegex.test(originalUrl);
  }

  if (isAmazonLink) {
    const affiliateLink = convertToAffiliateLink(originalUrl, userTags[userId]);
    if (affiliateLink !== originalUrl) {
      bot.sendMessage(
        chatId,
        `Here's your affiliate link:\n\n${affiliateLink}`
      );
    } else {
      bot.sendMessage(
        chatId,
        "Could not convert the link. Please ensure it's a valid Amazon product page URL (e.g., contains /dp/ or /gp/product/ and an ASIN)."
      );
    }
  } else {
    // If it's not a short link, and not a valid long Amazon link, after robust URL extraction
    bot.sendMessage(
      chatId,
      "That doesn't look like a valid Amazon product link. Please send a full Amazon URL (e.g., `amazon.com/dp/B0xxxxxxx`) or a short one (`amzn.to/xxxx`)."
    );
  }
});

console.log("Bot is running...");
