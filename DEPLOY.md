# Deploying Wake Up Better Backend to Railway

## Quick Deploy

### Option 1: Deploy from GitHub (Recommended)

1. **Push your code to GitHub**
   ```bash
   cd backend
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/YOUR_USERNAME/wakeupbetter-api.git
   git push -u origin main
   ```

2. **Connect to Railway**
   - Go to [railway.app](https://railway.app)
   - Click "New Project" → "Deploy from GitHub repo"
   - Select your repository
   - Railway will auto-detect the Node.js project

3. **Set Environment Variables**
   In Railway dashboard → Variables:
   ```
   OPENAI_API_KEY=sk-your-openai-api-key
   GROK_API_KEY=your-grok-api-key (optional, for news)
   PORT=3000
   ```

4. **Get your URL**
   - Railway will provide a URL like: `https://your-app.up.railway.app`
   - Update `Config.swift` in the iOS app with this URL

### Option 2: Deploy via Railway CLI

1. **Install Railway CLI**
   ```bash
   npm install -g @railway/cli
   ```

2. **Login and deploy**
   ```bash
   cd backend
   railway login
   railway init
   railway up
   ```

3. **Set environment variables**
   ```bash
   railway variables set OPENAI_API_KEY=sk-your-key
   railway variables set GROK_API_KEY=your-grok-key
   ```

4. **Get your URL**
   ```bash
   railway open
   ```

## Verify Deployment

Test the health endpoint:
```bash
curl https://your-app.up.railway.app/api/health
```

Expected response:
```json
{"status":"ok","timestamp":"2025-01-30T..."}
```

## Update iOS App

Once deployed, update the API URL in the iOS app:

**File:** `ios/WakeUpBetter/WakeUpBetter/Config.swift`
```swift
static let apiBaseURL = "https://your-app.up.railway.app/api/track"
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Health check |
| `/api/track/session` | POST | Create wake-up session |
| `/api/track/session/:id/start` | POST | Start session (get greeting) |
| `/api/track/session/:id/next` | POST | Get next segment |
| `/api/track/session/:id/audio` | POST | Send user audio |
| `/api/track/session/:id/silence-duration` | GET | Get silence timer duration |
| `/api/track/session/:id` | DELETE | End session |

## Troubleshooting

### Build fails
- Make sure `typescript` is in `devDependencies`
- Check that `tsconfig.json` exists

### Runtime errors
- Check Railway logs: `railway logs`
- Verify `OPENAI_API_KEY` is set correctly

### iOS can't connect
- Ensure URL uses `https://` not `http://`
- Check iOS App Transport Security settings in Info.plist
