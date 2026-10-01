# Motify Clip

Autonomous natural-language video director and editing engine. Drop raw video clips, describe your vision in plain text, and Motify Clip orchestrates narrative assembly, scene cuts, smart framing, punch-ins, audio normalization, and burned captions into a finished export.

## Prerequisites

- **Node.js** 20+
- **Python** 3.10+
- **FFmpeg** and **FFprobe** installed and added to `PATH` (with `drawtext` and `subtitles`/`libass` support enabled)
- A **Google Gemini API Key** and **Kiri STT API Key**

Verify FFmpeg capabilities:
```bash
ffmpeg -version
ffmpeg -filters | grep -E "drawtext|subtitles"
```

---

## Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Configure Python environment**:
   ```bash
   python -m venv .venv
   # Windows:
   .\.venv\Scripts\Activate.ps1
   # macOS / Linux:
   source .venv/bin/activate

   pip install -r requirements.txt
   ```

3. **Environment configuration**:
   ```bash
   cp .env.example .env
   ```
   Edit `.env` with your API keys and binary paths:
   ```dotenv
   GEMINI_API_KEY=your_gemini_api_key
   GEMINI_MODEL=gemini-2.5-flash
   KIRI_API_KEY=your_kiri_api_key
   KIRI_STT_MODEL=kiristt
   
   # Optional: specify binary locations if not on system PATH
   # FFMPEG_BIN=ffmpeg
   # FFPROBE_BIN=ffprobe
   # PYTHON_BIN=.venv/Scripts/python.exe
   ```

---

## Running

### Development Mode
Starts both the Vite frontend (`http://localhost:5173`) and Node API server (`http://127.0.0.1:8787`):
```bash
npm run dev
```

### Production Build
Build and start the unified server:
```bash
npm run build
npm start
```
Open `http://127.0.0.1:8787`.

---

## License

All rights reserved by Motify.
