const express = require("express");
const axios = require("axios");
const cors = require("cors");
const ytdl = require("@distube/ytdl-core");
const yts = require("yt-search");

const app = express();

app.use(cors());
app.use(express.json());

// ----------------------------
// Helpers
// ----------------------------
function extractVideoId(input) {
    // Accept full URL or bare ID
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

// ----------------------------
// Home
// ----------------------------
app.get("/", (req, res) => {
    res.json({
        success: true,
        name: "YouTube API",
        version: "1.0.0",
        endpoints: {
            info:          "GET  /api/info?url=<videoUrl>",
            search:        "GET  /api/search?q=<query>&limit=10",
            formats:       "GET  /api/formats?url=<videoUrl>",
            download_video:"GET  /api/download/video?url=<videoUrl>&quality=highest",
            download_audio:"GET  /api/download/audio?url=<videoUrl>",
            thumbnail:     "GET  /api/thumbnail?url=<videoUrl>&size=maxresdefault",
            trending:      "GET  /api/trending?limit=10",
            channel:       "GET  /api/channel?q=<channelName>&limit=10",
            playlist:      "GET  /api/playlist?q=<playlistName>&limit=10"
        }
    });
});

// ----------------------------
// Video Info
// ----------------------------
app.get("/api/info", async (req, res) => {
    const { url } = req.query;

    if (!url) {
        return res.status(400).json({
            success: false,
            message: "url parameter is required"
        });
    }

    const videoId = extractVideoId(url);

    if (!videoId) {
        return res.status(400).json({
            success: false,
            message: "Invalid YouTube URL or video ID"
        });
    }

    try {
        const info = await ytdl.getInfo(
            `https://www.youtube.com/watch?v=${videoId}`
        );

        const details = info.videoDetails;

        const thumbnails = details.thumbnails || [];

        const bestThumb =
            thumbnails.reduce(
                (best, t) =>
                    !best || (t.width || 0) > (best.width || 0)
                        ? t
                        : best,
                null
            );

        const formats = info.formats.map(f => ({
            itag:        f.itag,
            quality:     f.qualityLabel || f.audioQuality || "unknown",
            container:   f.container,
            codecs:      f.codecs,
            hasVideo:    f.hasVideo,
            hasAudio:    f.hasAudio,
            bitrate:     f.bitrate,
            fps:         f.fps || null,
            filesize:    f.contentLength
                ? `${(f.contentLength / 1_048_576).toFixed(2)} MB`
                : "unknown"
        }));

        res.json({
            success: true,
            data: {
                videoId:        details.videoId,
                title:          details.title,
                description:    details.description,
                author:         details.author?.name,
                channelId:      details.author?.id,
                channelUrl:     details.author?.channel_url,
                duration:       formatDuration(parseInt(details.lengthSeconds)),
                durationSeconds:parseInt(details.lengthSeconds),
                viewCount:      formatNumber(details.viewCount),
                viewCountRaw:   parseInt(details.viewCount),
                likeCount:      formatNumber(details.likes),
                likeCountRaw:   details.likes,
                uploadDate:     details.uploadDate,
                publishDate:    details.publishDate,
                isPrivate:      details.isPrivate,
                isLive:         details.isLiveContent,
                category:       details.category,
                keywords:       details.keywords || [],
                thumbnails: {
                    default:    `https://img.youtube.com/vi/${videoId}/default.jpg`,
                    medium:     `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
                    high:       `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
                    standard:   `https://img.youtube.com/vi/${videoId}/sddefault.jpg`,
                    maxres:     `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
                    best:       bestThumb?.url || null
                },
                url:            `https://www.youtube.com/watch?v=${videoId}`,
                shortUrl:       `https://youtu.be/${videoId}`,
                embedUrl:       `https://www.youtube.com/embed/${videoId}`,
                formats:        formats
            }
        });

    } catch (err) {
        res.status(500).json({
            success: false,
            message: err.message
        });
    }
});

// ----------------------------
// Available Formats
// ----------------------------
app.get("/api/formats", async (req, res) => {
    const { url } = req.query;

    if (!url) {
        return res.status(400).json({
            success: false,
            message: "url parameter is required"
        });
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
        return res.status(400).json({
            success: false,
            message: "Invalid YouTube URL or video ID"
        });
    }

    try {
        const info = await ytdl.getInfo(
            `https://www.youtube.com/watch?v=${videoId}`
        );

        const videoFormats = ytdl
            .filterFormats(info.formats, "videoandaudio")
            .map(f => ({
                itag:      f.itag,
                quality:   f.qualityLabel,
                container: f.container,
                codecs:    f.codecs,
                fps:       f.fps,
                bitrate:   f.bitrate,
                filesize:  f.contentLength
                    ? `${(f.contentLength / 1_048_576).toFixed(2)} MB`
                    : "unknown"
            }));

        const audioFormats = ytdl
            .filterFormats(info.formats, "audioonly")
            .map(f => ({
                itag:         f.itag,
                audioQuality: f.audioQuality,
                container:    f.container,
                codecs:       f.codecs,
                bitrate:      f.audioBitrate,
                filesize:     f.contentLength
                    ? `${(f.contentLength / 1_048_576).toFixed(2)} MB`
                    : "unknown"
            }));

        res.json({
            success: true,
            videoId,
            title: info.videoDetails.title,
            videoFormats,
            audioFormats
        });

    } catch (err) {
        res.status(500).json({
            success: false,
            message: err.message
        });
    }
});

// ----------------------------
// Download Video (stream)
// ----------------------------
app.get("/api/download/video", async (req, res) => {
    const { url, quality = "highest", itag } = req.query;

    if (!url) {
        return res.status(400).json({
            success: false,
            message: "url parameter is required"
        });
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
        return res.status(400).json({
            success: false,
            message: "Invalid YouTube URL or video ID"
        });
    }

    try {
        const info = await ytdl.getInfo(
            `https://www.youtube.com/watch?v=${videoId}`
        );

        const title = info.videoDetails.title
            .replace(/[^\w\s-]/g, "")
            .trim()
            .replace(/\s+/g, "_");

        res.setHeader(
            "Content-Disposition",
            `attachment; filename="${title}.mp4"`
        );
        res.setHeader("Content-Type", "video/mp4");

        const options = itag
            ? { filter: f => f.itag === parseInt(itag) }
            : { quality };

        ytdl(
            `https://www.youtube.com/watch?v=${videoId}`,
            options
        ).pipe(res);

    } catch (err) {
        if (!res.headersSent) {
            res.status(500).json({
                success: false,
                message: err.message
            });
        }
    }
});

// ----------------------------
// Download Audio (stream)
// ----------------------------
app.get("/api/download/audio", async (req, res) => {
    const { url, quality = "highestaudio" } = req.query;

    if (!url) {
        return res.status(400).json({
            success: false,
            message: "url parameter is required"
        });
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
        return res.status(400).json({
            success: false,
            message: "Invalid YouTube URL or video ID"
        });
    }

    try {
        const info = await ytdl.getInfo(
            `https://www.youtube.com/watch?v=${videoId}`
        );

        const title = info.videoDetails.title
            .replace(/[^\w\s-]/g, "")
            .trim()
            .replace(/\s+/g, "_");

        res.setHeader(
            "Content-Disposition",
            `attachment; filename="${title}.mp3"`
        );
        res.setHeader("Content-Type", "audio/mpeg");

        ytdl(
            `https://www.youtube.com/watch?v=${videoId}`,
            {
                quality,
                filter: "audioonly"
            }
        ).pipe(res);

    } catch (err) {
        if (!res.headersSent) {
            res.status(500).json({
                success: false,
                message: err.message
            });
        }
    }
});

// ----------------------------
// Thumbnail
// ----------------------------
app.get("/api/thumbnail", async (req, res) => {
    const {
        url,
        size = "maxresdefault",
        redirect = "false"
    } = req.query;

    if (!url) {
        return res.status(400).json({
            success: false,
            message: "url parameter is required"
        });
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
        return res.status(400).json({
            success: false,
            message: "Invalid YouTube URL or video ID"
        });
    }

    const validSizes = [
        "default",
        "mqdefault",
        "hqdefault",
        "sddefault",
        "maxresdefault"
    ];

    const safeSize = validSizes.includes(size)
        ? size
        : "maxresdefault";

    const thumbUrl =
        `https://img.youtube.com/vi/${videoId}/${safeSize}.jpg`;

    // Redirect mode — browser will display image
    if (redirect === "true") {
        return res.redirect(thumbUrl);
    }

    // Proxy mode — stream image through API
    try {
        const { data, headers } = await axios.get(thumbUrl, {
            responseType: "stream"
        });

        res.setHeader(
            "Content-Type",
            headers["content-type"] || "image/jpeg"
        );

        data.pipe(res);

    } catch (err) {
        res.status(500).json({
            success: false,
            message: "Failed to fetch thumbnail"
        });
    }
});

// ----------------------------
// Search Videos
// ----------------------------
app.get("/api/search", async (req, res) => {
    const {
        q,
        limit = "10",
        type = "video"
    } = req.query;

    if (!q) {
        return res.status(400).json({
            success: false,
            message: "q (query) parameter is required"
        });
    }

    try {
        const results = await yts(q);

        let items = [];

        if (type === "video") {
            items = results.videos
                .slice(0, parseInt(limit))
                .map(v => ({
                    videoId:   v.videoId,
                    title:     v.title,
                    author:    v.author?.name,
                    channelId: v.author?.channelId,
                    duration:  v.timestamp,
                    views:     formatNumber(v.views),
                    viewsRaw:  v.views,
                    uploadDate:v.ago,
                    description:v.description,
                    thumbnail: v.thumbnail,
                    url:       v.url,
                    shortUrl:  `https://youtu.be/${v.videoId}`
                }));

        } else if (type === "channel") {
            items = results.channels
                .slice(0, parseInt(limit))
                .map(c => ({
                    channelId:   c.channelId,
                    name:        c.name,
                    url:         c.url,
                    thumbnail:   c.thumbnail,
                    subscribers: c.subscribers
                }));

        } else if (type === "playlist") {
            items = results.playlists
                .slice(0, parseInt(limit))
                .map(p => ({
                    playlistId: p.playlistId,
                    title:      p.title,
                    videoCount: p.videoCount,
                    author:     p.author?.name,
                    thumbnail:  p.thumbnail,
                    url:        p.url
                }));
        }

        res.json({
            success: true,
            query:   q,
            type,
            count:   items.length,
            data:    items
        });

    } catch (err) {
        res.status(500).json({
            success: false,
            message: err.message
        });
    }
});

// ----------------------------
// Channel Videos
// ----------------------------
app.get("/api/channel", async (req, res) => {
    const { q, limit = "10" } = req.query;

    if (!q) {
        return res.status(400).json({
            success: false,
            message: "q (channel name) parameter is required"
        });
    }

    try {
        const results = await yts({ query: q, category: "channel" });

        const channels = results.channels
            .slice(0, parseInt(limit))
            .map(c => ({
                channelId:   c.channelId,
                name:        c.name,
                url:         c.url,
                thumbnail:   c.thumbnail,
                subscribers: c.subscribers,
                verified:    c.verified || false
            }));

        res.json({
            success: true,
            query:   q,
            count:   channels.length,
            data:    channels
        });

    } catch (err) {
        res.status(500).json({
            success: false,
            message: err.message
        });
    }
});

// ----------------------------
// Playlist Search
// ----------------------------
app.get("/api/playlist", async (req, res) => {
    const { q, limit = "10" } = req.query;

    if (!q) {
        return res.status(400).json({
            success: false,
            message: "q (playlist name) parameter is required"
        });
    }

    try {
        const results = await yts({ query: q, category: "playlist" });

        const playlists = results.playlists
            .slice(0, parseInt(limit))
            .map(p => ({
                playlistId: p.playlistId,
                title:      p.title,
                videoCount: p.videoCount,
                author:     p.author?.name,
                thumbnail:  p.thumbnail,
                url:        p.url
            }));

        res.json({
            success: true,
            query:   q,
            count:   playlists.length,
            data:    playlists
        });

    } catch (err) {
        res.status(500).json({
            success: false,
            message: err.message
        });
    }
});

// ----------------------------
// Trending (via yts)
// ----------------------------
app.get("/api/trending", async (req, res) => {
    const { limit = "10" } = req.query;

    try {
        const results = await yts("trending");

        const videos = results.videos
            .slice(0, parseInt(limit))
            .map(v => ({
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

        res.json({
            success: true,
            count:   videos.length,
            data:    videos
        });

    } catch (err) {
        res.status(500).json({
            success: false,
            message: err.message
        });
    }
});

// ----------------------------
// Start Server
// ----------------------------
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(
        `🚀 YouTube API running on port ${PORT}`
    );
    console.log(
        `📖 Docs: http://localhost:${PORT}/`
    );
});
