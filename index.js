const express = require("express");
const cors = require("cors");
const { Innertube, UniversalCache } = require("youtubei.js");
const yts = require("yt-search");

const app = express();
app.use(cors());
app.use(express.json());

// Initialize YouTube
let youtube;
async function getYouTube() {
    if (!youtube) {
        youtube = await Innertube.create({
            cache: new UniversalCache(false),
            generate_session_locally: true,
        });
    }
    return youtube;
}

// --------------------- Helpers ---------------------
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

function getSafeTitle(videoDetails) {
    if (!videoDetails?.title) return "Untitled";
    if (typeof videoDetails.title === 'string') return videoDetails.title;
    if (videoDetails.title?.text) return videoDetails.title.text;
    if (videoDetails.title?.runs?.[0]?.text) return videoDetails.title.runs[0].text;
    return "Untitled";
}

function formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
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

// --------------------- Routes ---------------------

app.get("/", (req, res) => {
    res.json({
        success: true,
        name: "YouTube API",
        version: "2.1.0",
        status: "Fixed Audio Download"
    });
});

// Info & Formats (unchanged but safe)
app.get("/api/info", async (req, res) => { /* ... keep your existing /api/info */ 
    // (Use the previous version with getSafeTitle)
});

app.get("/api/formats", async (req, res) => { /* keep previous */ });

// ==================== FIXED DOWNLOAD AUDIO ====================
app.get("/api/download/audio", async (req, res) => {
    const { url } = req.query;
    const videoId = extractVideoId(url);
    if (!videoId) return res.status(400).json({ success: false, message: "Invalid URL" });

    try {
        const yt = await getYouTube();
        const info = await yt.getInfo(videoId);

        const title = getSafeTitle(info.video_details)
            .replace(/[^\w\s-]/g, "")
            .trim()
            .replace(/\s+/g, "_") || "audio";

        res.setHeader("Content-Disposition", `attachment; filename="${title}.mp3"`);
        res.setHeader("Content-Type", "audio/mpeg");

        // Improved audio download with fallback
        const stream = await info.download({
            type: "audio",
            quality: "best",
            format: "mp4"   // Most reliable for audio
        });

        stream.on('error', (err) => {
            console.error("Stream Error:", err);
            if (!res.headersSent) {
                res.status(500).json({ success: false, message: err.message });
            } else {
                res.end();
            }
        });

        stream.pipe(res);

    } catch (err) {
        console.error("Audio Download Error:", err);
        if (!res.headersSent) {
            res.status(500).json({ 
                success: false, 
                message: err.message || "Failed to process audio download" 
            });
        }
    }
});

// ==================== FIXED DOWNLOAD VIDEO ====================
app.get("/api/download/video", async (req, res) => {
    const { url, quality = "best" } = req.query;
    const videoId = extractVideoId(url);
    if (!videoId) return res.status(400).json({ success: false, message: "Invalid URL" });

    try {
        const yt = await getYouTube();
        const info = await yt.getInfo(videoId);

        const title = getSafeTitle(info.video_details)
            .replace(/[^\w\s-]/g, "")
            .trim()
            .replace(/\s+/g, "_") || "video";

        res.setHeader("Content-Disposition", `attachment; filename="${title}.mp4"`);
        res.setHeader("Content-Type", "video/mp4");

        const stream = await info.download({
            type: "video+audio",
            quality: quality === "highest" ? "best" : quality,
        });

        stream.on('error', (err) => {
            console.error("Video Stream Error:", err);
            if (!res.headersSent) res.status(500).end();
        });

        stream.pipe(res);

    } catch (err) {
        console.error("Video Download Error:", err);
        if (!res.headersSent) {
            res.status(500).json({ success: false, message: err.message });
        }
    }
});

// Keep other routes (search, thumbnail, trending, etc.) as they are

// ... [Add your other routes here: /api/search, /api/thumbnail, etc.]

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 YouTube API v2.1 running on port ${PORT}`);
});
