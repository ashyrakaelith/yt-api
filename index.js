const express = require('express');
const ytdl = require('@distube/ytdl-core');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/metadata', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    const info = await ytdl.getInfo(url);
    
    const formats = info.formats.map(format => ({
      itag: format.itag,
      quality: format.qualityLabel,
      mimeType: format.mimeType,
      bitrate: format.bitrate,
      audioBitrate: format.audioBitrate,
      hasVideo: format.hasVideo,
      hasAudio: format.hasAudio,
      container: format.container,
    }));

    const videoDetails = {
      title: info.videoDetails.title,
      description: info.videoDetails.description,
      author: info.videoDetails.author.name,
      thumbnails: info.videoDetails.thumbnails,
      lengthSeconds: info.videoDetails.lengthSeconds,
      viewCount: info.videoDetails.viewCount,
      uploadDate: info.videoDetails.uploadDate,
      likes: info.videoDetails.likes,
      categories: info.videoDetails.categories,
      formats
    };

    res.json(videoDetails);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch metadata', details: error.message });
  }
});

app.get('/download/video', async (req, res) => {
  try {
    const { url, quality } = req.query;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    const info = await ytdl.getInfo(url);
    let format;

    if (quality) {
      format = ytdl.chooseFormat(info.formats, { quality });
    } else {
      format = ytdl.chooseFormat(info.formats, { filter: 'audioandvideo', quality: 'highest' });
    }

    res.header('Content-Disposition', `attachment; filename="${info.videoDetails.title}.mp4"`);
    ytdl.downloadFromInfo(info, { format }).pipe(res);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Download failed', details: error.message });
  }
});

app.get('/download/audio', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    const info = await ytdl.getInfo(url);
    const format = ytdl.chooseFormat(info.formats, { filter: 'audioonly', quality: 'highestaudio' });

    res.header('Content-Disposition', `attachment; filename="${info.videoDetails.title}.mp3"`);
    ytdl.downloadFromInfo(info, { format }).pipe(res);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Audio download failed', details: error.message });
  }
});

app.get('/formats', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    const info = await ytdl.getInfo(url);
    const formats = info.formats.map(f => ({
      itag: f.itag,
      qualityLabel: f.qualityLabel,
      hasVideo: f.hasVideo,
      hasAudio: f.hasAudio,
      container: f.container,
      bitrate: f.bitrate
    }));

    res.json({ formats });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 YouTube API running on http://localhost:${PORT}`);
});
