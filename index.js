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
        console.log(`📦 Cache hit: ${videoId}`);
        return hit.info;
    }
    const client = await getYT();
    const info = await client.getInfo(videoId);
    
    // ආරක්ෂිත පරීක්ෂාව
    if (!info) throw new Error("Could not retrieve video information.");
    
    cache.set(videoId, { info, ts: Date.now() });
    return info;
}

// ----------------------------
// Helpers
// ----------------------------
function extractVideoId(input) {
    const patterns = [/(?:v=|youtu\.be\/|embed\/|shorts\/)([a-zA-Z0-9_-]{11})/, /^([a-zA-Z0-9_-]{11})$/];
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
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
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
    return thumbs.reduce((best, t) => !best || (t.width || 0) > (best.width || 0) ? t : best, null)?.url || null;
}

// වඩාත් ස්ථායී Stream Pipe
async function pipeYTStream(ytStream, res) {
    const reader = ytStream.getReader();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!res.write(value)) {
                await new Promise(r => res.once("drain", r));
            }
        }
        res.end();
    } catch (err) {
        console.error("Stream error:", err);
        if (!res.writableEnded) res.status(500).end();
    } finally {
        reader.releaseLock();
    }
}

// ----------------------------
// Routes (Home, Info, Formats, Download, etc.)
// ----------------------------
app.get("/", (req, res) => {
    res.json({ success: true, message: "YouTube API Online" });
});

app.get("/api/info", async (req, res) => {
    const { url } = req.query;
    const videoId = extractVideoId(url);
    if (!videoId) return res.status(400).json({ success: false, message: "Invalid URL" });
    try {
        const info = await getCachedInfo(videoId);
        res.json({ success: true, data: { title: info.basic_info.title, id: info.basic_info.id } });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Download Audio Route
app.get("/api/download/audio", async (req, res) => {
    const { url } = req.query;
    const videoId = extractVideoId(url);
    if (!videoId) return res.status(400).json({ success: false, message: "Invalid URL" });

    try {
        const client = await getYT();
        const info = await getCachedInfo(videoId);
        
        // Stream ලබා ගැනීම
        const stream = await client.download(videoId, {
            type: "audio",
            quality: "best",
            format: "mp4"
        });

        res.setHeader("Content-Disposition", `attachment; filename="${info.basic_info.title.replace(/[^\w\s]/gi, '')}.mp3"`);
        res.setHeader("Content-Type", "audio/mpeg");
        res.setHeader("Transfer-Encoding", "chunked");

        await pipeYTStream(stream, res);
    } catch (err) {
        console.error("Download Error:", err);
        if (!res.headersSent) res.status(500).json({ success: false, message: err.message });
    }
});

app.get("/api/cache/clear", (req, res) => {
    cache.clear();
    yt = null;
    res.json({ success: true, message: "Cache cleared" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`🚀 Running on port ${PORT}`);
    await getYT();
});
