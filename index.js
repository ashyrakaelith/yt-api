const express = require("express");
const cors = require("cors");
const { Innertube, UniversalCache } = require("youtubei.js");
const yts = require("yt-search");

const app = express();
app.use(cors());
app.use(express.json());

// Initialize YouTube client
let youtube;
async function getYouTube() {
    if (!youtube) {
        youtube = await Innertube.create({
            cache: new UniversalCache(false),
            generate_session_locally: true,   // Faster startup
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
        version: "2.0.0",
        message: "Powered by youtubei.js (v17+)"
    });
});

// Video Info
app.get("/api/info", async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ success: false, message: "url parameter is required" });

    const videoId = extractVideoId(url);
    if (!videoId) return res.status(400).json({ success: false, message: "Invalid YouTube URL or video ID" });

    try {
        const yt = await getYouTube();
        const info = await yt.getInfo(videoId);

        const details = info.video_details;
        const primary = info.primary_info;

        const thumbnails = details.thumbnails || [];
        const bestThumb = thumbnails.reduce((best, t) => 
            !best || (t.width || 0) > (best.width || 0) ? t : best, null);

        const allFormats = [
            ...(info.streaming_data?.formats || []),
            ...(info.streaming_data?.adaptive_formats || [])
        ].map(f => ({
            itag: f.itag,
            quality: f.quality_label || f.audio_quality,
            container: f.mime_type?.split('/')[1]?.split(';')[0] || 'unknown',
            hasVideo: !!f.video_codec,
            hasAudio: !!f.audio_codec,
            bitrate: f.bitrate,
            fps: f.fps,
            filesize: f.content_length ? `${(Number(f.content_length) / 1_048_576).toFixed(2)} MB` : "unknown"
        }));

        res.json({
            success: true,
            data: {
                videoId: details.id,
                title: details.title.text || details.title,
                description: primary?.description?.text || "",
                author: details.author?.name,
                channelId: details.channel_id,
                duration: formatDuration(details.duration.seconds),
                durationSeconds: details.duration.seconds,
                viewCount: formatNumber(details.view_count),
                viewCountRaw: details.view_count,
                likeCount: formatNumber(info.like_count || 0),
                uploadDate: details.published?.text || "",
                thumbnails: {
                    default: `https://img.youtube.com/vi/${videoId}/default.jpg`,
                    medium: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
                    high: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
                    maxres: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
                    best: bestThumb?.url || null
                },
                formats: allFormats
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// Available Formats
app.get("/api/formats", async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ success: false, message: "url parameter is required" });

    const videoId = extractVideoId(url);
    if (!videoId) return res.status(400).json({ success: false, message: "Invalid YouTube URL or video ID" });

    try {
        const yt = await getYouTube();
        const info = await yt.getInfo(videoId);

        const allFormats = [
            ...(info.streaming_data?.formats || []),
            ...(info.streaming_data?.adaptive_formats || [])
        ];

        const videoFormats = allFormats
            .filter(f => f.has_video)
            .map(f => ({ ...f, filesize: f.content_length ? `${(Number(f.content_length)/1048576).toFixed(2)} MB` : "unknown" }));

        const audioFormats = allFormats
            .filter(f => f.has_audio && !f.has_video)
            .map(f => ({ ...f, filesize: f.content_length ? `${(Number(f.content_length)/1048576).toFixed(2)} MB` : "unknown" }));

        res.json({
            success: true,
            videoId,
            title: info.video_details.title.text || info.video_details.title,
            videoFormats,
            audioFormats
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Download Video
app.get("/api/download/video", async (req, res) => {
    const { url, quality = "best" } = req.query;
    const videoId = extractVideoId(url);
    if (!videoId) return res.status(400).json({ success: false, message: "Invalid URL" });

    try {
        const yt = await getYouTube();
        const info = await yt.getInfo(videoId);

        const title = String(info.video_details.title.text || info.video_details.title)
            .replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "_");

        res.setHeader("Content-Disposition", `attachment; filename="${title}.mp4"`);
        res.setHeader("Content-Type", "video/mp4");

        const stream = await info.download({
            quality: quality === "highest" ? "best" : quality,
            type: "video+audio"
        });

        stream.pipe(res);
    } catch (err) {
        if (!res.headersSent) res.status(500).json({ success: false, message: err.message });
    }
});

// Download Audio
app.get("/api/download/audio", async (req, res) => {
    const { url } = req.query;
    const videoId = extractVideoId(url);
    if (!videoId) return res.status(400).json({ success: false, message: "Invalid URL" });

    try {
        const yt = await getYouTube();
        const info = await yt.getInfo(videoId);

        const title = String(info.video_details.title.text || info.video_details.title)
            .replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "_");

        res.setHeader("Content-Disposition", `attachment; filename="${title}.mp3"`);
        res.setHeader("Content-Type", "audio/mpeg");

        const stream = await info.download({
            quality: "best",
            type: "audio"
        });

        stream.pipe(res);
    } catch (err) {
        if (!res.headersSent) res.status(500).json({ success: false, message: err.message });
    }
});

// Thumbnail
app.get("/api/thumbnail", async (req, res) => {
    const { url, size = "maxresdefault", redirect = "false" } = req.query;
    const videoId = extractVideoId(url);
    if (!videoId) return res.status(400).json({ success: false, message: "Invalid URL" });

    const validSizes = ["default", "mqdefault", "hqdefault", "sddefault", "maxresdefault"];
    const safeSize = validSizes.includes(size) ? size : "maxresdefault";
    const thumbUrl = `https://img.youtube.com/vi/${videoId}/${safeSize}.jpg`;

    if (redirect === "true") return res.redirect(thumbUrl);

    try {
        const axios = require("axios");
        const { data, headers } = await axios.get(thumbUrl, { responseType: "stream" });
        res.setHeader("Content-Type", headers["content-type"] || "image/jpeg");
        data.pipe(res);
    } catch (err) {
        res.status(500).json({ success: false, message: "Failed to fetch thumbnail" });
    }
});

// Search
app.get("/api/search", async (req, res) => {
    const { q, limit = 10, type = "video" } = req.query;
    if (!q) return res.status(400).json({ success: false, message: "q parameter is required" });

    try {
        const results = await yts(q);
        let items = [];

        if (type === "video") {
            items = results.videos.slice(0, parseInt(limit)).map(v => ({
                videoId: v.videoId,
                title: v.title,
                author: v.author?.name,
                duration: v.timestamp,
                views: formatNumber(v.views),
                thumbnail: v.thumbnail,
                url: v.url
            }));
        } else if (type === "channel") {
            items = results.channels.slice(0, parseInt(limit)).map(c => ({
                channelId: c.channelId,
                name: c.name,
                thumbnail: c.thumbnail,
                subscribers: c.subscribers
            }));
        } else if (type === "playlist") {
            items = results.playlists.slice(0, parseInt(limit)).map(p => ({
                playlistId: p.playlistId,
                title: p.title,
                videoCount: p.videoCount,
                thumbnail: p.thumbnail,
                url: p.url
            }));
        }

        res.json({ success: true, query: q, type, count: items.length, data: items });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Channel
app.get("/api/channel", async (req, res) => {
    const { q, limit = 10 } = req.query;
    if (!q) return res.status(400).json({ success: false, message: "q parameter is required" });

    try {
        const results = await yts({ query: q, category: "channel" });
        const channels = results.channels.slice(0, parseInt(limit)).map(c => ({
            channelId: c.channelId,
            name: c.name,
            thumbnail: c.thumbnail,
            subscribers: c.subscribers
        }));
        res.json({ success: true, query: q, count: channels.length, data: channels });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Playlist
app.get("/api/playlist", async (req, res) => {
    const { q, limit = 10 } = req.query;
    if (!q) return res.status(400).json({ success: false, message: "q parameter is required" });

    try {
        const results = await yts({ query: q, category: "playlist" });
        const playlists = results.playlists.slice(0, parseInt(limit)).map(p => ({
            playlistId: p.playlistId,
            title: p.title,
            videoCount: p.videoCount,
            thumbnail: p.thumbnail,
            url: p.url
        }));
        res.json({ success: true, query: q, count: playlists.length, data: playlists });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Trending
app.get("/api/trending", async (req, res) => {
    const { limit = 10 } = req.query;
    try {
        const results = await yts("trending");
        const videos = results.videos.slice(0, parseInt(limit)).map(v => ({
            videoId: v.videoId,
            title: v.title,
            author: v.author?.name,
            duration: v.timestamp,
            views: formatNumber(v.views),
            thumbnail: v.thumbnail,
            url: v.url
        }));
        res.json({ success: true, count: videos.length, data: videos });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Cache Clear
app.get("/api/cache/clear", (req, res) => {
    res.json({ success: true, message: "Cache clear not needed with youtubei.js session cache" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 YouTube API v2.0 running on port ${PORT}`);
    console.log(`📖 Docs: http://localhost:${PORT}/`);
});
