# DeviceCheck Setup Instructions

I've added the DeviceCheck endpoints to your backend! Follow these steps to complete the setup.

## ✅ What I've Done

1. **Created** `/src/routes/deviceCheckApi.ts` - The DeviceCheck endpoints
2. **Modified** `/src/server.ts` - Added the route to your Express server
3. **Created** this setup guide

## 🔧 Required Steps

### 1. Install Dependencies

```bash
cd "/Users/ziyatansu/Desktop/WUB/Wake Up Better/backend"
npm install jsonwebtoken @types/jsonwebtoken
```

### 2. Get Apple DeviceCheck Credentials

1. Go to https://appstoreconnect.apple.com
2. Click **Keys** in the sidebar
3. Click the **+** button to create a new key
4. Give it a name (e.g., "DeviceCheck Key")
5. Enable **DeviceCheck** capability
6. Click **Generate**
7. **Download the .p8 file** (you can only do this once!)
8. Note the **Key ID** (shows in the key list)
9. Note your **Team ID** (top right, or in membership details)

### 3. Add Environment Variables

Add these to your `.env` file in the backend directory:

```bash
# Apple DeviceCheck Configuration
APPLE_TEAM_ID=YOUR_TEAM_ID_HERE
DEVICECHECK_KEY_ID=YOUR_KEY_ID_HERE
DEVICECHECK_PRIVATE_KEY_PATH=/path/to/AuthKey_XXXXXXXX.p8
```

**Example:**
```bash
APPLE_TEAM_ID=A1B2C3D4E5
DEVICECHECK_KEY_ID=ABCDEF1234
DEVICECHECK_PRIVATE_KEY_PATH=/Users/ziyatansu/Desktop/WUB/Wake\ Up\ Better/backend/AuthKey_ABCDEF1234.p8
```

### 4. Save Your .p8 Key File

Move the downloaded `.p8` file to your backend directory:

```bash
mv ~/Downloads/AuthKey_XXXXXXXX.p8 "/Users/ziyatansu/Desktop/WUB/Wake Up Better/backend/"
```

### 5. Restart Your Server

```bash
npm run dev
```

## 🧪 Testing

### Test with curl:

```bash
# Query device status
curl -X POST http://localhost:3000/device/status \
  -H "Content-Type: application/json" \
  -d '{"device_token": "test_token_12345"}'

# Should return: {"free_sessions_used":0}

# Increment session
curl -X POST http://localhost:3000/device/update \
  -H "Content-Type: application/json" \
  -d '{"device_token": "test_token_12345", "increment_session": true}'

# Should return: {"success":true,"free_sessions_used":1}

# Query again
curl -X POST http://localhost:3000/device/status \
  -H "Content-Type: application/json" \
  -d '{"device_token": "test_token_12345"}'

# Should return: {"free_sessions_used":1}
```

## 📝 Current Implementation

The endpoints are currently using **in-memory storage** (Map). This works but data is lost when server restarts.

### To Upgrade to Database (Optional):

Replace the `deviceStore` Map with a database. Example schemas:

**PostgreSQL:**
```sql
CREATE TABLE device_sessions (
    device_hash VARCHAR(64) PRIMARY KEY,
    free_sessions_used INT DEFAULT 0,
    last_updated TIMESTAMP DEFAULT NOW()
);
```

**MongoDB:**
```javascript
{
  device_hash: String,
  free_sessions_used: Number,
  last_updated: Date
}
```

## 🚨 Apple DeviceCheck Integration (Optional)

The code includes commented-out Apple DeviceCheck API calls. These provide redundancy by storing session counts in Apple's servers as well.

To enable:
1. Uncomment line 173 in `deviceCheckApi.ts`
2. This will sync counts with Apple's two-bit storage

**Note:** This requires valid Apple credentials and only works with real device tokens (not test data).

## ✅ Verification

Once set up, your iOS app will:
1. Track free sessions server-side
2. Prevent abuse via app reinstallation
3. Automatically fall back to local tracking if server is unavailable

Test on a real iOS device (DeviceCheck doesn't work in Simulator).

## 🔒 Security

- Device tokens are hashed before storage (SHA-256)
- Tokens expire after ~1 hour, app generates new ones
- Rate limiting recommended (10 req/min per IP)
- Use HTTPS in production

## ❓ Troubleshooting

**"DeviceCheck private key not found"**
- Check your `.env` file has the correct path
- Make sure the `.p8` file exists at that location

**"Failed to query Apple: 401"**
- Check your Team ID and Key ID are correct
- Make sure the .p8 file matches the Key ID

**"Device token validation failed"**
- Test with curl first using dummy tokens
- Real device tokens only work from actual iOS devices

## 📞 Need Help?

If you encounter issues:
1. Check server logs for errors
2. Test endpoints with curl first
3. Verify environment variables are loaded (`console.log(process.env.APPLE_TEAM_ID)`)
