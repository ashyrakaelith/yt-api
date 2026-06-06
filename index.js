const express = require("express");
const axios = require("axios");
const cors = require("cors");
const yts = require("yt-search");
const { Innertube, UniversalCache } = require("youtubei.js");

const app = express();
app.use(cors());
app.use(express.json());

// ----------------------------
// Innertube singleton
// ----------------------------
let yt = null;

async function getYT() {
    if (!yt) {
        yt = await Innertube.create({
            cache: new UniversalCache(false),
            generate_session_locally: true,
            retrieve_player: true,
            // Railway variables එකෙන් cookies ලබා ගනී
            cookies: process.env.YT_COOKIES || "" 
        });
    }
    return yt;
}

// ----------------------------
// In-memory info cache (5 min)
// ----------------------------
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

async function getCachedInfo(videoId) {
    const hit = cache.get(videoId);
    if (hit && Date.now() - hit.ts < CACHE_TTL) {
        return hit.info;
    }
    const client = await getYT();
    const info = await client.getInfo(videoId);
    cache.set(videoId, { info, ts: Date.now() });
    return info;
}

// ----------------------------
// Helpers
// ----------------------------
function extractVideoId(input) {
    const patterns = [
        /(?:v=|youtu\.be\/|embed\/|shorts\/)([a-zA-Z0-9_-]{11})/,
        /^([a-zA-Z0-9_-]{11})$/
    ];
    for (const re of patterns) {
        const m = input.match(re);
        if (m) return m[1];
    }
    return null;
}

function formatDuration(seconds) {
    if (!seconds) return "0:00";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0)
        return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
}

function formatNumber(n) {
    if (!n) return "0";
    const num = parseInt(n);
    if (num >= 1_000_000_000) return (num / 1_000_000_000).toFixed(1) + "B";
    if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + "M";
    if (num >= 1_000) return (num / 1_000).toFixed(1) + "K";
    return String(num);
}

function bestThumbnail(thumbs) {
    if (!thumbs?.length) return null;
    return thumbs.reduce((best, t) =>
        !best || (t.width || 0) > (best.width || 0) ? t : best, null
    )?.url || null;
}

async function pipeYTStream(ytStream, res) {
    const reader = ytStream.getReader();
    res.on("close", () => reader.cancel());
    while (true) {
        const { done, value } = await reader.read();
        if (done) { res.end(); break; }
        const ok = res.write(value);
        if (!ok) await new Promise(r => res.once("drain", r));
    }
}

// ----------------------------
// Endpoints
// ----------------------------
app.get("/", (req, res) => {
    res.json({ success: true, message: "YouTube API is running" });
});

app.get("/api/info", async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ success: false, message: "url is required" });
    const videoId = extractVideoId(url);
    if (!videoId) return res.status(400).json({ success: false, message: "Invalid URL" });
    try {
        const info = await getCachedInfo(videoId);
        res.json({ success: true, data: info.basic_info });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get("/api/download/video", async (req, res) => {
    const { url, quality = "360p" } = req.query;
    const videoId = extractVideoId(url);
    if (!videoId) return res.status(400).json({ success: false, message: "Invalid URL" });

    try {
        const client = await getYT();
        const stream = await client.download(videoId, { type: "video+audio", quality, format: "mp4" });
        res.setHeader("Content-Type", "video/mp4");
        await pipeYTStream(stream, res);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get("/api/download/audio", async (req, res) => {
    const { url } = req.query;
    const videoId = extractVideoId(url);
    if (!videoId) return res.status(400).json({ success: false, message: "Invalid URL" });

    try {
        const client = await getYT();
        const stream = await client.download(videoId, { type: "audio", quality: "best", format: "mp4" });
        res.setHeader("Content-Type", "audio/mpeg");
        await pipeYTStream(stream, res);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ----------------------------
// Start
// ----------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`🚀 API running on port ${PORT}`);
    try {
        await getYT();
        console.log("✅ Innertube ready");
    } catch (e) {
        console.error("❌ Innertube init failed:", e.message);
    }
});
