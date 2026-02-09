# Wake Up Better - Backend Server

Voice agent backend for the Wake Up Better alarm app. Uses OpenAI's Realtime API for speech-to-speech conversations.

## Quick Start

### 1. Install Dependencies
```bash
cd backend
npm install
```

### 2. Set Up Environment Variables
```bash
# Copy the example env file
cp .env.example .env

# Edit .env and add your OpenAI API key
# OPENAI_API_KEY=sk-your-key-here
```

### 3. Run the Server
```bash
# Development mode (with auto-reload)
npm run dev

# Or build and run production
npm run build
npm start
```

### 4. Test in Browser
Open http://localhost:3000 in your browser to use the test page.

## Project Structure

```
backend/
├── src/
│   ├── server.ts           # Main Express + WebSocket server
│   ├── config/
│   │   └── personas.ts     # Persona definitions (Zen, Coach, Sergeant)
│   └── services/
│       ├── realtimeSession.ts  # OpenAI Realtime API wrapper
│       └── grokNews.ts         # News headlines fetcher
├── public/
│   └── index.html          # Web test page
├── .env.example            # Environment variables template
└── package.json
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/personas` | GET | List available personas |
| `/api/voices` | GET | List available voices |
| `/api/health` | GET | Health check |

## WebSocket Protocol

Connect to `ws://localhost:3000/ws`

### Client → Server Messages

**Start Session**
```json
{
  "type": "start",
  "personaId": "zen-guide",
  "voiceId": "soft-female",
  "preferences": {
    "includeNews": true,
    "includeWeather": true,
    "includeCalendar": true
  },
  "context": {
    "weather": "Sunny, 72°F",
    "calendar": "Team meeting at 10am"
  }
}
```

**Send Audio** (PCM16 format, base64 encoded)
```json
{
  "type": "audio",
  "data": "base64-encoded-pcm16-audio"
}
```

**End Session**
```json
{
  "type": "end"
}
```

### Server → Client Messages

**Session Ready**
```json
{
  "type": "session.ready",
  "sessionId": "...",
  "persona": { "id": "zen-guide", "name": "Zen Guide" }
}
```

**Audio Response** (agent speaking)
```json
{
  "type": "response.audio.delta",
  "delta": "base64-encoded-pcm16-audio"
}
```

**Transcript** (what agent is saying)
```json
{
  "type": "response.audio_transcript.delta",
  "delta": "Good morning..."
}
```

## Personas

### 🧘 Zen Guide
- Ultra calm, meditative approach
- No news by default
- Never raises voice
- Best for: People who hate jarring alarms

### 💪 Morning Coach
- Energetic, motivational
- Includes news and weather
- Celebrates wins
- Best for: People who need positive energy

### 🔥 Strict Sergeant
- No-nonsense, direct
- Uses guilt and light roasting
- Never gives up
- Best for: Heavy sleepers who need tough love

## Voice Options

| ID | Description |
|----|-------------|
| `soft-female` | Soft, warm female voice |
| `warm-male` | Calm, reassuring male voice |
| `energetic-female` | Bright, energetic female voice |
| `energetic-male` | Strong, motivating male voice |

## Troubleshooting

### "OPENAI_API_KEY environment variable is required"
Make sure you've created a `.env` file with your API key.

### Microphone not working
- Check browser permissions
- Make sure you're using HTTPS in production (required for mic access)

### Audio quality issues
- The Realtime API uses 24kHz PCM16 audio
- Make sure your client handles this format correctly

## Next Steps

This backend is ready to connect to:
- iOS app (via WebSocket)
- React Native app
- Any client that supports WebSocket + audio

The iOS app will add:
- Local notifications for alarm
- Calendar integration (EventKit)
- Step counting for wake verification
- Persistent user preferences

