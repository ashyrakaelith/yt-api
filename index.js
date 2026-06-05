const express = require("express");
const cors = require("cors");
const { Innertube, UniversalCache } = require("youtubei.js");
const yts = require("yt-search"); // Keep for search (still works well)

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Innertube (once)
let youtube;
async function initYouTube() {
    if (!youtube) {
        youtube = await Innertube.create({
            cache: new UniversalCache(false), // or true if you want disk cache
            // You can add cookies here later for age-restricted videos
        });
    }
    return youtube;
}

// Reuse your helpers
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

// ----------------------------
// Video Info
// ----------------------------
app.get("/api/info", async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ success: false, message: "url required" });

    const videoId = extractVideoId(url);
    if (!videoId) return res.status(400).json({ success: false, message: "Invalid YouTube URL/ID" });

    try {
        const yt = await initYouTube();
        const info = await yt.getInfo(videoId);

        const details = info.primary_info;
        const videoDetails = info.video_details;

        const thumbnails = videoDetails.thumbnails || [];
        const bestThumb = thumbnails.reduce((best, t) => 
            !best || (t.width || 0) > (best.width || 0) ? t : best, null);

        // Formats (streams)
        const formats = info.streaming_data?.formats || [];
        const adaptiveFormats = info.streaming_data?.adaptive_formats || [];

        const allFormats = [...formats, ...adaptiveFormats].map(f => ({
            itag: f.itag,
            quality: f.quality_label || f.audio_quality,
            container: f.mime_type?.split(';')[0].split('/')[1] || 'unknown',
            hasVideo: !!f.video_codec,
            hasAudio: !!f.audio_codec,
            bitrate: f.bitrate,
            fps: f.fps,
            contentLength: f.content_length
        }));

        res.json({
            success: true,
            data: {
                videoId: videoDetails.id,
                title: videoDetails.title.text || videoDetails.title,
                description: details?.description?.text || "",
                author: videoDetails.author.name,
                channelId: videoDetails.channel_id,
                duration: formatDuration(videoDetails.duration.seconds),
                durationSeconds: videoDetails.duration.seconds,
                viewCount: formatNumber(videoDetails.view_count),
                viewCountRaw: videoDetails.view_count,
                likeCount: formatNumber(info.like_count || 0),
                uploadDate: videoDetails.published.text,
                thumbnails: {
                    default: `https://img.youtube.com/vi/${videoId}/default.jpg`,
                    medium: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
                    high: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
                    maxres: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
                    best: bestThumb?.url || null
                },
                formats: allFormats,
                url: `https://www.youtube.com/watch?v=${videoId}`
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// Download Video (similar for audio)
app.get("/api/download/video", async (req, res) => {
    const { url, quality = "highest" } = req.query;
    const videoId = extractVideoId(url);
    if (!videoId) return res.status(400).json({ success: false, message: "Invalid URL" });

    try {
        const yt = await initYouTube();
        const info = await yt.getInfo(videoId);

        const title = (info.video_details.title.text || info.video_details.title)
            .replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "_");

        res.setHeader("Content-Disposition", `attachment; filename="${title}.mp4"`);
        res.setHeader("Content-Type", "video/mp4");

        // Choose best format
        const stream = await info.download({
            quality: quality === "highest" ? "best" : quality,
            type: "video+audio" // or "video" / "audio"
        });

        stream.pipe(res);
    } catch (err) {
        if (!res.headersSent) res.status(500).json({ success: false, message: err.message });
    }
});

// Keep your other endpoints (search, trending, thumbnail, etc.) as they mostly still work with yt-search
// You can also replace search with youtubei.js for better consistency if needed.
