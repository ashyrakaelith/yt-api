const express = require("express");
const axios = require("axios");
const cors = require("cors");
const yts = require("yt-search");
const { Innertube, UniversalCache } = require("youtubei.js");

const app = express();
app.use(cors());
app.use(express.json());

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

const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

async function getCachedInfo(videoId) {
    const hit = cache.get(videoId);
    if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.info;
    const client = await getYT();
    const info = await client.getInfo(videoId);
    if (!info) throw new Error("Could not retrieve video info");
    cache.set(videoId, { info, ts: Date.now() });
    return info;
}

function extractVideoId(input) {
    const patterns = [/(?:v=|youtu\.be\/|embed\/|shorts\/)([a-zA-Z0-9_-]{11})/, /^([a-zA-Z0-9_-]{11})$/];
    for (const re of patterns) {
        const m = input.match(re);
        if (m) return m[1];
    }
    return null;
}

async function pipeYTStream(ytStream, res) {
    const reader = ytStream.getReader();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) { res.end(); break; }
            if (!res.write(value)) await new Promise(r => res.once("drain", r));
        }
    } catch (err) {
        console.error("Pipe error:", err);
        res.end();
    } finally {
        reader.cancel();
    }
}

// Routes - API Info, Download Video/Audio
app.get("/api/info", async (req, res) => {
    const { url } = req.query;
    const videoId = extractVideoId(url);
    if (!videoId) return res.status(400).json({ success: false, message: "Invalid URL" });
    try {
        const info = await getCachedInfo(videoId);
        res.json({ success: true, data: info.basic_info });
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
        const info = await getCachedInfo(videoId);
        
        // Stream ආරම්භ කිරීමට පෙර Streaming data පරීක්ෂාව
        if (!info.streaming_data) throw new Error("Video restricted or stream unavailable");

        res.setHeader("Content-Type", "audio/mpeg");
        const stream = await client.download(videoId, { type: "audio", quality: "best", format: "mp4" });
        await pipeYTStream(stream, res);
    } catch (err) {
        console.error("Audio error:", err);
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
    console.log(`🚀 API running on port ${PORT}`);
    await getYT().catch(console.error);
});
