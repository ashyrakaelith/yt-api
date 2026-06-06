const express = require("express");
const axios   = require("axios");
const cors    = require("cors");
const yts     = require("yt-search");
const { Innertube } = require("youtubei.js");

const app = express();
app.use(cors());
app.use(express.json());

// ----------------------------
// Innertube singleton (reuse)
// ----------------------------
let yt = null;

async function getYT() {
    if (!yt) {
        yt = await Innertube.create({
            cache: null,
            generate_session_locally: true
        });
    }
    return yt;
}

// ----------------------------
// In-memory cache (5 min)
// ----------------------------
const cache    = new Map();
const CACHE_TTL = 5 * 60 * 1000;

async function getCachedInfo(videoId) {
    const hit = cache.get(videoId);
    if (hit && Date.now() - hit.ts < CACHE_TTL) {
        console.log(`📦 Cache hit: ${videoId}`);
        return hit.info;
    }
    const client = await getYT();
    const info   = await client.getInfo(videoId);
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
    if (num >= 1_000_000)     return (num / 1_000_000).toFixed(1) + "M";
    if (num >= 1_000)         return (num / 1_000).toFixed(1) + "K";
    return String(num);
}

function bestThumbnail(thumbs) {
    if (!thumbs?.length) return null;
    return thumbs.reduce((best, t) =>
        !best || (t.width || 0) > (best.width || 0) ? t : best, null
    )?.url || null;
}

// ----------------------------
// Home
// ----------------------------
app.get("/", (req, res) => {
    res.json({
        success: true,
        name:    "YouTube API",
        version: "3.0.0",
        engine:  "youtubei.js (Innertube)",
        endpoints: {
            info:           "GET /api/info?url=",
            formats:        "GET /api/formats?url=",
            download_video: "GET /api/download/video?url=&itag=",
            download_audio: "GET /api/download/audio?url=",
            thumbnail:      "GET /api/thumbnail?url=&size=maxresdefault",
            search:         "GET /api/search?q=&limit=10&type=video",
            trending:       "GET /api/trending?limit=10",
            channel:        "GET /api/channel?q=&limit=10",
            playlist:       "GET /api/playlist?q=&limit=10",
            cache_clear:    "GET /api/cache/clear"
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
        const info    = await getCachedInfo(videoId);
        const details = info.basic_info;

        // Collect all streaming formats
        const formats = [];
        try {
            const sd = info.streaming_data;
            if (sd) {
                for (const f of [...(sd.formats || []), ...(sd.adaptive_formats || [])]) {
                    formats.push({
                        itag:      f.itag,
                        quality:   f.quality_label || f.audio_quality || "unknown",
                        container: f.mime_type?.split(";")?.[0]?.split("/")?.[1] || "unknown",
                        mimeType:  f.mime_type,
                        hasVideo:  !!f.width,
                        hasAudio:  !!f.audio_quality,
                        bitrate:   f.bitrate,
                        fps:       f.fps || null,
                        width:     f.width  || null,
                        height:    f.height || null,
                        filesize:  f.content_length
                            ? `${(parseInt(f.content_length) / 1_048_576).toFixed(2)} MB`
                            : "unknown"
                    });
                }
            }
        } catch (_) {}

        res.json({
            success: true,
            data: {
                videoId:         details.id,
                title:           details.title,
                description:     details.short_description || "",
                author:          details.author,
                channelId:       details.channel_id,
                duration:        formatDuration(details.duration),
                durationSeconds: details.duration,
                viewCount:       formatNumber(details.view_count),
                viewCountRaw:    details.view_count,
                likeCount:       formatNumber(details.like_count),
                likeCountRaw:    details.like_count,
                isPrivate:       details.is_private,
                isLive:          details.is_live,
                keywords:        details.keywords || [],
                thumbnails: {
                    default:  `https://img.youtube.com/vi/${videoId}/default.jpg`,
                    medium:   `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
                    high:     `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
                    standard: `https://img.youtube.com/vi/${videoId}/sddefault.jpg`,
                    maxres:   `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
                    best:     bestThumbnail(details.thumbnails)
                },
                url:      `https://www.youtube.com/watch?v=${videoId}`,
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
        const sd   = info.streaming_data;

        const toFormat = f => ({
            itag:     f.itag,
            quality:  f.quality_label || f.audio_quality || "unknown",
            mimeType: f.mime_type,
            hasVideo: !!f.width,
            hasAudio: !!f.audio_quality,
            bitrate:  f.bitrate,
            fps:      f.fps || null,
            width:    f.width  || null,
            height:   f.height || null,
            filesize: f.content_length
                ? `${(parseInt(f.content_length) / 1_048_576).toFixed(2)} MB`
                : "unknown"
        });

        const muxed = (sd?.formats         || []).map(toFormat);
        const adaptive = (sd?.adaptive_formats || []).map(toFormat);

        const videoFormats = adaptive.filter(f => f.hasVideo && !f.hasAudio);
        const audioFormats = adaptive.filter(f => f.hasAudio && !f.hasVideo);

        res.json({
            success: true,
            videoId,
            title:        info.basic_info.title,
            muxedFormats: muxed,
            videoFormats,
            audioFormats
        });

    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ----------------------------
// Download Video (stream via itag)
// ----------------------------
app.get("/api/download/video", async (req, res) => {
    const { url, itag } = req.query;
    if (!url) return res.status(400).json({ success: false, message: "url is required" });

    const videoId = extractVideoId(url);
    if (!videoId) return res.status(400).json({ success: false, message: "Invalid YouTube URL" });

    try {
        const info  = await getCachedInfo(videoId);
        const sd    = info.streaming_data;
        const title = (info.basic_info.title || "video")
            .replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "_");

        // Pick format: itag-matched or best muxed (has video+audio)
        const allFormats = [
            ...(sd?.formats || []),
            ...(sd?.adaptive_formats || [])
        ];

        let chosen;
        if (itag) {
            chosen = allFormats.find(f => f.itag === parseInt(itag));
        }
        if (!chosen) {
            // Best muxed (video+audio combined)
            const muxed = sd?.formats || [];
            chosen = muxed[0]; // highest quality first
        }

        if (!chosen?.url) {
            return res.status(404).json({
                success: false,
                message: "No downloadable format found. Try specifying an itag from /api/formats"
            });
        }

        res.setHeader("Content-Disposition", `attachment; filename="${title}.mp4"`);
        res.setHeader("Content-Type", "video/mp4");

        const stream = await axios.get(chosen.url, { responseType: "stream" });
        if (chosen.content_length) {
            res.setHeader("Content-Length", chosen.content_length);
        }
        stream.data.pipe(res);

    } catch (err) {
        if (!res.headersSent)
            res.status(500).json({ success: false, message: err.message });
    }
});

// ----------------------------
// Download Audio (stream)
// ----------------------------
app.get("/api/download/audio", async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ success: false, message: "url is required" });

    const videoId = extractVideoId(url);
    if (!videoId) return res.status(400).json({ success: false, message: "Invalid YouTube URL" });

    try {
        const info  = await getCachedInfo(videoId);
        const sd    = info.streaming_data;
        const title = (info.basic_info.title || "audio")
            .replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "_");

        // Best audio-only format
        const audioFormats = (sd?.adaptive_formats || [])
            .filter(f => f.mime_type?.startsWith("audio/") && f.url)
            .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

        const chosen = audioFormats[0];

        if (!chosen?.url) {
            return res.status(404).json({
                success: false,
                message: "No audio format found"
            });
        }

        res.setHeader("Content-Disposition", `attachment; filename="${title}.mp3"`);
        res.setHeader("Content-Type", "audio/mpeg");

        const stream = await axios.get(chosen.url, { responseType: "stream" });
        if (chosen.content_length) {
            res.setHeader("Content-Length", chosen.content_length);
        }
        stream.data.pipe(res);

    } catch (err) {
        if (!res.headersSent)
            res.status(500).json({ success: false, message: err.message });
    }
});

// ----------------------------
// Thumbnail (proxy or redirect)
// ----------------------------
app.get("/api/thumbnail", async (req, res) => {
    const { url, size = "maxresdefault", redirect = "false" } = req.query;
    if (!url) return res.status(400).json({ success: false, message: "url is required" });

    const videoId = extractVideoId(url);
    if (!videoId) return res.status(400).json({ success: false, message: "Invalid YouTube URL" });

    const validSizes = ["default", "mqdefault", "hqdefault", "sddefault", "maxresdefault"];
    const safeSize   = validSizes.includes(size) ? size : "maxresdefault";
    const thumbUrl   = `https://img.youtube.com/vi/${videoId}/${safeSize}.jpg`;

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
                videoId:     v.videoId,
                title:       v.title,
                author:      v.author?.name,
                channelId:   v.author?.channelId,
                duration:    v.timestamp,
                views:       formatNumber(v.views),
                viewsRaw:    v.views,
                uploadDate:  v.ago,
                description: v.description,
                thumbnail:   v.thumbnail,
                url:         v.url,
                shortUrl:    `https://youtu.be/${v.videoId}`
            }));
        } else if (type === "channel") {
            items = results.channels.slice(0, parseInt(limit)).map(c => ({
                channelId:   c.channelId,
                name:        c.name,
                url:         c.url,
                thumbnail:   c.thumbnail,
                subscribers: c.subscribers
            }));
        } else if (type === "playlist") {
            items = results.playlists.slice(0, parseInt(limit)).map(p => ({
                playlistId: p.playlistId,
                title:      p.title,
                videoCount: p.videoCount,
                author:     p.author?.name,
                thumbnail:  p.thumbnail,
                url:        p.url
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
        const results  = await yts({ query: q, category: "channel" });
        const channels = results.channels.slice(0, parseInt(limit)).map(c => ({
            channelId:   c.channelId,
            name:        c.name,
            url:         c.url,
            thumbnail:   c.thumbnail,
            subscribers: c.subscribers,
            verified:    c.verified || false
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
        const results   = await yts({ query: q, category: "playlist" });
        const playlists = results.playlists.slice(0, parseInt(limit)).map(p => ({
            playlistId: p.playlistId,
            title:      p.title,
            videoCount: p.videoCount,
            author:     p.author?.name,
            thumbnail:  p.thumbnail,
            url:        p.url
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
        const videos  = results.videos.slice(0, parseInt(limit)).map(v => ({
            videoId:   v.videoId,
            title:     v.title,
            author:    v.author?.name,
            duration:  v.timestamp,
            views:     formatNumber(v.views),
            viewsRaw:  v.views,
            uploadDate:v.ago,
            thumbnail: v.thumbnail,
            url:       v.url
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
    yt = null; // also reset Innertube instance
    res.json({ success: true, message: `Cleared ${size} cached entries` });
});

// ----------------------------
// Start + warm up Innertube
// ----------------------------
const PORT = process.env.PORT || 3000;

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
