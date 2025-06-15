// api/index.js
const TelegramBot = require("node-telegram-bot-api");
const express = require("express"); // Import express
const fs = require("fs");
const axios = require("axios"); // Import axios

// --- Configuration for Bot Token ---
// Vercel will inject TELEGRAM_BOT_TOKEN as an environment variable
const botToken = process.env.TELEGRAM_BOT_TOKEN;

if (!botToken) {
  console.error("ERROR: TELEGRAM_BOT_TOKEN environment variable not found!");
  // In a serverless function, you can't just exit. You need to handle it gracefully.
  // For Vercel, if this happens, the function will likely fail to initialize.
  throw new Error("Telegram bot token is not set.");
}

// Initialize the bot (without polling)
const bot = new TelegramBot(botToken); // No { polling: true } here!

// --- User Tag Storage ---
// In a serverless environment like Vercel, direct file system access (like fs.readFileSync/writeFileSync)
// is generally NOT suitable for persistent data. Each function invocation can be on a different server.
// For a truly production-ready bot, you'd use a database (e.g., MongoDB Atlas free tier, Render Postgres free tier).
// For this example, we'll keep the fs logic but be aware it's not truly persistent across invocations.
// For simple user tags, you might manually manage them or accept they reset.
const USER_TAGS_FILE = "/tmp/userTags.json"; // Use /tmp for temporary file system in serverless
const usersAwaitingTag = {}; // This will reset on each new function invocation,
// meaning the user needs to complete /settag in one go.
// For persistent state, a database is needed.

// Function to load user tags from the JSON file
function loadUserTags() {
  try {
    // Check if /tmp exists and then if the file exists within it.
    if (fs.existsSync(USER_TAGS_FILE)) {
      const data = fs.readFileSync(USER_TAGS_FILE, "utf8");
      return JSON.parse(data);
    }
  } catch (error) {
    // console.error('Error loading user tags from file (expected if first run or /tmp cleared):', error.message);
    // This error is common in serverless as /tmp clears. Not a critical error for non-persistent local storage.
  }
  return {};
}

// Function to save user tags to the JSON file
function saveUserTags(userTags) {
  try {
    // Ensure the directory exists if using /tmp/subfolder/file
    // For /tmp/file, it's usually fine.
    fs.writeFileSync(USER_TAGS_FILE, JSON.stringify(userTags, null, 2), "utf8");
  } catch (error) {
    console.error(
      "Error saving user tags to file (expected if /tmp is read-only or full):",
      error.message
    );
  }
}

let userTags = loadUserTags(); // Load tags on each invocation (will be empty often in serverless)

// --- Utility Functions (unchanged logic) ---

function isValidAmazonTag(tag) {
  const tagRegex = /^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*-[0-9]{1,3}$/;
  return tagRegex.test(tag);
}

function convertToAffiliateLink(url, tag) {
  if (!tag) {
    return url;
  }
  try {
    const urlObj = new URL(url);
    const params = new URLSearchParams(urlObj.search);
    params.delete("tag");
    params.delete("linkCode");
    params.delete("ascsubtag");
    params.delete("creativeASIN");
    params.delete("ref_");
    params.set("tag", tag);
    urlObj.search = params.toString();
    return urlObj.toString();
  } catch (e) {
    console.error("Error modifying URL for affiliate tag:", e.message);
    return url;
  }
}

async function resolveUrl(url) {
  try {
    const response = await axios.get(url, { maxRedirects: 10 });
    const finalUrl = response.request.res.responseUrl;
    console.log(`Resolved URL (internal log): ${url} -> ${finalUrl}`);
    return finalUrl;
  } catch (error) {
    console.error(`Error resolving URL ${url}:`, error.message);
    return null;
  }
}

// --- Express Server Setup for Webhooks ---
const app = express();
app.use(express.json()); // Middleware to parse JSON request bodies

// This is the webhook endpoint that Telegram will send updates to
app.post("/", async (req, res) => {
  // Process the incoming update from Telegram
  const update = req.body;

  // Make sure it's a valid Telegram update
  if (!update || !update.message) {
    return res.status(200).send("No message received"); // Acknowledge without processing invalid updates
  }

  const msg = update.message;
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text;

  // --- Handle /settag state (NOTE: usersAwaitingTag will reset per invocation) ---
  // For /settag to work across multiple messages in a serverless environment,
  // you would need a persistent storage (like a database) to store the 'awaiting tag' state.
  // As a temporary workaround for demonstration, we will rely on a single message for /settag
  // or accept that the user needs to re-type /settag then the tag in one go.

  // If the message is /settag, explicitly set the state (won't persist long)
  if (text === "/settag") {
    usersAwaitingTag[userId] = true; // This state is ephemeral in serverless
    bot.sendMessage(
      chatId,
      "Please send me your Amazon Associate Tag now. This will overwrite your previous tag. Example: `yourstore-20`"
    );
    return res.status(200).send("Set tag prompt sent"); // Respond quickly
  }
  // If the user was awaiting tag, process it. This relies on previous /settag being in same invocation, unlikely.
  // A robust solution for /settag would involve storing usersAwaitingTag in a database.
  // For this example, we will treat the first message after /start (if no tag) as the tag, or just accept /settag + tag in one go.

  // --- Strict Tag Setting Logic (adapted for serverless) ---
  // Since usersAwaitingTag is ephemeral, we check if the user has a tag AND if it's the first message from them.
  // OR, if they've explicitly used /settag, the next message is the tag. This is hard without persistence.
  // Let's simplify: if no tag, FIRST message after /start (or initial contact) is the tag.
  // Or if they explicitly say /settag, the NEXT message (if within short time, not guaranteed on serverless) is the tag.

  if (!userTags[userId] && !text.startsWith("/")) {
    // If no tag AND not a command
    const potentialTag = text.trim();
    if (potentialTag.length > 0 && isValidAmazonTag(potentialTag)) {
      userTags[userId] = potentialTag;
      saveUserTags(userTags); // This save is also ephemeral for serverless
      bot.sendMessage(
        chatId,
        `Thank you! Your Amazon Associate Tag has been set to: \`${userTags[userId]}\`. Now, send me any Amazon product link (long or shortened), and I will convert it into an affiliate link.`
      );
    } else {
      bot.sendMessage(
        chatId,
        "Please provide a valid (non-empty) Amazon Associate Tag. Example: `yourstore-20`."
      );
    }
    return res.status(200).send("Tag processed"); // Respond quickly
  }

  // --- Command Handling (excluding /settag which is handled above) ---
  if (text.startsWith("/")) {
    // Handle /start command
    if (text === "/start") {
      delete usersAwaitingTag[userId]; // Still useful for local testing
      if (userTags[userId]) {
        bot.sendMessage(
          chatId,
          `Welcome back! Send me an Amazon link (long or shortened) and I'll convert it for you. Your current Amazon Associate Tag is: \`${userTags[userId]}\`. You can change it with /settag.`
        );
      } else {
        bot.sendMessage(
          chatId,
          "Hello! Welcome to the Amazon Affiliate Link Converter Bot. To get started, please send me your Amazon Associate Tag by using the /settag command."
        );
      }
    } else {
      bot.sendMessage(
        chatId,
        "Sorry, I don't recognize that command. Please use /start or /settag."
      );
    }
    return res.status(200).send("Command processed"); // Respond quickly
  }

  // --- Robust URL Extraction and Amazon Link Conversion Logic ---
  const urlMatch = text.match(/(https?:\/\/[^\s]+)/);
  let originalReceivedUrl = urlMatch ? urlMatch[0] : null;

  if (!originalReceivedUrl) {
    bot.sendMessage(
      chatId,
      "That doesn't look like a valid URL. Please send a full Amazon URL or a shortened one."
    );
    return res.status(200).send("No URL found");
  }

  const anyAmazonDomainRegex =
    /amazon\.(com|co\.uk|de|fr|es|it|ca|com\.au|co\.jp|cn|in)/i;
  let finalAmazonUrl = null;

  // 1. First, check if the original URL is already an Amazon domain
  if (anyAmazonDomainRegex.test(originalReceivedUrl)) {
    finalAmazonUrl = originalReceivedUrl;
  } else {
    // 2. If not a direct Amazon link, try to resolve it
    bot.sendMessage(
      chatId,
      "Detecting shortened link... Please wait while I resolve it for you."
    );
    const resolvedUrl = await resolveUrl(originalReceivedUrl);

    if (resolvedUrl) {
      // 3. After resolving, check if the resolved URL is an Amazon domain
      if (anyAmazonDomainRegex.test(resolvedUrl)) {
        finalAmazonUrl = resolvedUrl;
      }
    } else {
      bot.sendMessage(
        chatId,
        "Sorry, I could not resolve the provided link. Please try sending the full link or check its validity."
      );
      return res.status(200).send("Link resolution failed");
    }
  }

  // 4. If we have a final Amazon URL, convert it
  if (finalAmazonUrl) {
    const affiliateLink = convertToAffiliateLink(
      finalAmazonUrl,
      userTags[userId]
    );
    if (affiliateLink !== finalAmazonUrl) {
      bot.sendMessage(
        chatId,
        `Here's your affiliate link:\n\n${affiliateLink}`
      );
    } else {
      bot.sendMessage(
        chatId,
        "The link was resolved, but I could not convert it to an affiliate link. Please ensure it's a valid Amazon URL."
      );
    }
  } else {
    // 5. If after all checks and resolutions, it's not an Amazon link
    bot.sendMessage(
      chatId,
      "That doesn't look like a valid Amazon product link. Please send a full Amazon URL (e.g., `amazon.com/dp/B0xxxxxxx`) or a shortened one (like `amzn.to/xxxx`, `tinyurl.com/xxxx`, etc.)."
    );
  }

  // Acknowledge the update to Telegram
  res.status(200).send("Update processed");
});

// Export the express app as a serverless function
module.exports = app;
