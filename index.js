import express from "express";
import axios from "axios";
import cors from "cors";
import yts from "yt-search";
import { Innertube, UniversalCache } from "youtubei.js";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

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

// Pipe a youtubei.js ReadableStream → Express response
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
// API docs (JSON)
// ----------------------------
app.get("/api", (req, res) => {
    res.json({
        success: true,
        name: "YouTube API",
        version: "4.0.0",
        engine: "youtubei.js (Innertube)",
        endpoints: {
            info: "GET /api/info?url=",
            formats: "GET /api/formats?url=",
            download_video: "GET /api/download/video?url=&quality=360p",
            download_audio: "GET /api/download/audio?url=",
            thumbnail: "GET /api/thumbnail?url=&size=maxresdefault",
            search: "GET /api/search?q=&limit=10&type=video",
            trending: "GET /api/trending?limit=10",
            channel: "GET /api/channel?q=&limit=10",
            playlist: "GET /api/playlist?q=&limit=10",
            cache_clear: "GET /api/cache/clear"
        }
    });
});

// ----------------------------
// Video Info
// ----------------------------
app.get("/api/info", async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ success: false, message: "url is required" });

    const videoId = extractVideoId(url);
    if (!videoId) return res.status(400).json({ success: false, message: "Invalid YouTube URL" });

    try {
        const info = await getCachedInfo(videoId);
        const details = info.basic_info;

        const sd = info.streaming_data;
        const allRaw = [...(sd?.formats || []), ...(sd?.adaptive_formats || [])];
        const formats = allRaw.map(f => ({
            itag: f.itag,
            quality: f.quality_label || f.audio_quality || "unknown",
            mimeType: f.mime_type,
            hasVideo: !!f.width,
            hasAudio: !!f.audio_quality,
            bitrate: f.bitrate,
            fps: f.fps || null,
            width: f.width || null,
            height: f.height || null,
            filesize: f.content_length
                ? `${(parseInt(f.content_length) / 1_048_576).toFixed(2)} MB`
                : "unknown"
        }));

        res.json({
            success: true,
            data: {
                videoId: details.id,
                title: details.title,
                description: details.short_description || "",
                author: details.author,
                channelId: details.channel_id,
                duration: formatDuration(details.duration),
                durationSeconds: details.duration,
                viewCount: formatNumber(details.view_count),
                viewCountRaw: details.view_count,
                likeCount: formatNumber(details.like_count),
                likeCountRaw: details.like_count,
                isPrivate: details.is_private,
                isLive: details.is_live,
                keywords: details.keywords || [],
                thumbnails: {
                    default: `https://img.youtube.com/vi/${videoId}/default.jpg`,
                    medium: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
                    high: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
                    standard: `https://img.youtube.com/vi/${videoId}/sddefault.jpg`,
                    maxres: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
                    best: bestThumbnail(details.thumbnails)
                },
                url: `https://www.youtube.com/watch?v=${videoId}`,
                shortUrl: `https://youtu.be/${videoId}`,
                embedUrl: `https://www.youtube.com/embed/${videoId}`,
                formats
            }
        });

    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ----------------------------
// Formats
// ----------------------------
app.get("/api/formats", async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ success: false, message: "url is required" });

    const videoId = extractVideoId(url);
    if (!videoId) return res.status(400).json({ success: false, message: "Invalid YouTube URL" });

    try {
        const info = await getCachedInfo(videoId);
        const sd = info.streaming_data;

        const toFormat = f => ({
            itag: f.itag,
            quality: f.quality_label || f.audio_quality || "unknown",
            mimeType: f.mime_type,
            hasVideo: !!f.width,
            hasAudio: !!f.audio_quality,
            bitrate: f.bitrate,
            fps: f.fps || null,
            width: f.width || null,
            height: f.height || null,
            filesize: f.content_length
                ? `${(parseInt(f.content_length) / 1_048_576).toFixed(2)} MB`
                : "unknown"
        });

        const muxed = (sd?.formats || []).map(toFormat);
        const adaptive = (sd?.adaptive_formats || []).map(toFormat);

        res.json({
            success: true,
            videoId,
            title: info.basic_info.title,
            muxedFormats: muxed,
            videoFormats: adaptive.filter(f => f.hasVideo && !f.hasAudio),
            audioFormats: adaptive.filter(f => !f.hasVideo && f.hasAudio)
        });

    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ----------------------------
// Download Video
// ----------------------------
app.get("/api/download/video", async (req, res) => {
    const { url, quality = "360p" } = req.query;
    if (!url) return res.status(400).json({ success: false, message: "url is required" });

    const videoId = extractVideoId(url);
    if (!videoId) return res.status(400).json({ success: false, message: "Invalid YouTube URL" });

    try {
        const client = await getYT();
        const info = await getCachedInfo(videoId);
        const title = (info.basic_info.title || "video")
            .replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "_");

        const sd = info.streaming_data;
        const muxed = sd?.formats || [];
        const qualityOrder = ["1080p", "720p", "480p", "360p", "240p", "144p"];
        const targetIndex = qualityOrder.indexOf(quality);
        const candidates = targetIndex >= 0
            ? qualityOrder.slice(targetIndex)
            : qualityOrder;

        let chosen = null;
        for (const q of candidates) {
            chosen = muxed.find(f => f.quality_label === q);
            if (chosen) break;
        }
        if (!chosen) chosen = muxed[0];

        if (!chosen) {
            return res.status(404).json({
                success: false,
                message: "No muxed (video+audio) format available for this video"
            });
        }

        console.log(`📥 Video download: ${videoId} | itag=${chosen.itag} | quality=${chosen.quality_label}`);

        res.setHeader("Content-Disposition", `attachment; filename="${title}.mp4"`);
        res.setHeader("Content-Type", "video/mp4");
        if (chosen.content_length)
            res.setHeader("Content-Length", chosen.content_length);

        const stream = await client.download(videoId, {
            type: "video+audio",
            quality: chosen.quality_label || "360p",
            format: "mp4"
        });

        await pipeYTStream(stream, res);

    } catch (err) {
        console.error("Video download error:", err.message);
        if (!res.headersSent)
            res.status(500).json({ success: false, message: err.message });
    }
});

// ----------------------------
// Download Audio
// ----------------------------
app.get("/api/download/audio", async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ success: false, message: "url is required" });

    const videoId = extractVideoId(url);
    if (!videoId) return res.status(400).json({ success: false, message: "Invalid YouTube URL" });

    try {
        const client = await getYT();
        const info = await getCachedInfo(videoId);
        const title = (info.basic_info.title || "audio")
            .replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "_");

        console.log(`🎵 Audio download: ${videoId}`);

        res.setHeader("Content-Disposition", `attachment; filename="${title}.mp3"`);
        res.setHeader("Content-Type", "audio/mpeg");

        const stream = await client.download(videoId, {
            type: "audio",
            quality: "best",
            format: "mp4"
        });

        await pipeYTStream(stream, res);

    } catch (err) {
        console.error("Audio download error:", err.message);
        if (!res.headersSent)
            res.status(500).json({ success: false, message: err.message });
    }
});

// ----------------------------
// Thumbnail
// ----------------------------
app.get("/api/thumbnail", async (req, res) => {
    const { url, size = "maxresdefault", redirect = "false" } = req.query;
    if (!url) return res.status(400).json({ success: false, message: "url is required" });

    const videoId = extractVideoId(url);
    if (!videoId) return res.status(400).json({ success: false, message: "Invalid YouTube URL" });

    const validSizes = ["default", "mqdefault", "hqdefault", "sddefault", "maxresdefault"];
    const safeSize = validSizes.includes(size) ? size : "maxresdefault";
    const thumbUrl = `https://img.youtube.com/vi/${videoId}/${safeSize}.jpg`;

    if (redirect === "true") return res.redirect(thumbUrl);

    try {
        const { data, headers } = await axios.get(thumbUrl, { responseType: "stream" });
        res.setHeader("Content-Type", headers["content-type"] || "image/jpeg");
        data.pipe(res);
    } catch (err) {
        res.status(500).json({ success: false, message: "Failed to fetch thumbnail" });
    }
});

// ----------------------------
// Search
// ----------------------------
app.get("/api/search", async (req, res) => {
    const { q, limit = "10", type = "video" } = req.query;
    if (!q) return res.status(400).json({ success: false, message: "q is required" });

    try {
        const results = await yts(q);
        let items = [];

        if (type === "video") {
            items = results.videos.slice(0, parseInt(limit)).map(v => ({
                videoId: v.videoId,
                title: v.title,
                author: v.author?.name,
                channelId: v.author?.channelId,
                duration: v.timestamp,
                views: formatNumber(v.views),
                viewsRaw: v.views,
                uploadDate: v.ago,
                description: v.description,
                thumbnail: v.thumbnail,
                url: v.url,
                shortUrl: `https://youtu.be/${v.videoId}`
            }));
        } else if (type === "channel") {
            items = results.channels.slice(0, parseInt(limit)).map(c => ({
                channelId: c.channelId,
                name: c.name,
                url: c.url,
                thumbnail: c.thumbnail,
                subscribers: c.subscribers
            }));
        } else if (type === "playlist") {
            items = results.playlists.slice(0, parseInt(limit)).map(p => ({
                playlistId: p.playlistId,
                title: p.title,
                videoCount: p.videoCount,
                author: p.author?.name,
                thumbnail: p.thumbnail,
                url: p.url
            }));
        }

        res.json({ success: true, query: q, type, count: items.length, data: items });

    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ----------------------------
// Channel Search
// ----------------------------
app.get("/api/channel", async (req, res) => {
    const { q, limit = "10" } = req.query;
    if (!q) return res.status(400).json({ success: false, message: "q is required" });

    try {
        const results = await yts({ query: q, category: "channel" });
        const channels = results.channels.slice(0, parseInt(limit)).map(c => ({
            channelId: c.channelId,
            name: c.name,
            url: c.url,
            thumbnail: c.thumbnail,
            subscribers: c.subscribers,
            verified: c.verified || false
        }));
        res.json({ success: true, query: q, count: channels.length, data: channels });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ----------------------------
// Playlist Search
// ----------------------------
app.get("/api/playlist", async (req, res) => {
    const { q, limit = "10" } = req.query;
    if (!q) return res.status(400).json({ success: false, message: "q is required" });

    try {
        const results = await yts({ query: q, category: "playlist" });
        const playlists = results.playlists.slice(0, parseInt(limit)).map(p => ({
            playlistId: p.playlistId,
            title: p.title,
            videoCount: p.videoCount,
            author: p.author?.name,
            thumbnail: p.thumbnail,
            url: p.url
        }));
        res.json({ success: true, query: q, count: playlists.length, data: playlists });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ----------------------------
// Trending
// ----------------------------
app.get("/api/trending", async (req, res) => {
    const { limit = "10" } = req.query;
    try {
        const results = await yts("trending");
        const videos = results.videos.slice(0, parseInt(limit)).map(v => ({
            videoId: v.videoId,
            title: v.title,
            author: v.author?.name,
            duration: v.timestamp,
            views: formatNumber(v.views),
            viewsRaw: v.views,
            uploadDate: v.ago,
            thumbnail: v.thumbnail,
            url: v.url
        }));
        res.json({ success: true, count: videos.length, data: videos });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ----------------------------
// Cache Clear
// ----------------------------
app.get("/api/cache/clear", (req, res) => {
    const size = cache.size;
    cache.clear();
    yt = null;
    res.json({ success: true, message: `Cleared ${size} cached entries and reset Innertube` });
});

// ----------------------------
// Start
// ----------------------------
const PORT = process.env.PORT || 5000;

app.listen(PORT, async () => {
    console.log(`🚀 YouTube API running on port ${PORT}`);
    console.log(`📖 Docs: http://localhost:${PORT}/`);
    try {
        await getYT();
        console.log("✅ Innertube ready");
    } catch (e) {
        console.error("❌ Innertube init failed:", e.message);
    }
});
