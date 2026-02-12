import express, { Request, Response } from 'express';
import crypto from 'crypto';
import fetch from 'node-fetch';
import jwt from 'jsonwebtoken';
import fs from 'fs';

const router = express.Router();

// In-memory store for demo (replace with database in production)
// Key: hashed device token, Value: { freeSessionsUsed: number, lastUpdated: Date }
const deviceStore = new Map<string, { freeSessionsUsed: number; lastUpdated: Date }>();

// Apple DeviceCheck configuration
const APPLE_TEAM_ID = process.env.APPLE_TEAM_ID || '';
const DEVICECHECK_KEY_ID = process.env.DEVICECHECK_KEY_ID || '';
const DEVICECHECK_PRIVATE_KEY = process.env.DEVICECHECK_PRIVATE_KEY || '';
const DEVICECHECK_PRIVATE_KEY_PATH = process.env.DEVICECHECK_PRIVATE_KEY_PATH || '';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Apple DeviceCheck API endpoints
const DEVICECHECK_API_URL = IS_PRODUCTION
  ? 'https://api.devicecheck.apple.com/v1'
  : 'https://api.development.devicecheck.apple.com/v1';

/**
 * Generate JWT for Apple DeviceCheck API
 */
function generateDeviceCheckJWT(): string {
  // Support both environment variable (Railway) and file path (local)
  let privateKey: string;

  if (DEVICECHECK_PRIVATE_KEY) {
    // Use private key from environment variable (Railway deployment)
    privateKey = DEVICECHECK_PRIVATE_KEY.replace(/\\n/g, '\n');
  } else if (DEVICECHECK_PRIVATE_KEY_PATH && fs.existsSync(DEVICECHECK_PRIVATE_KEY_PATH)) {
    // Use private key from file (local development)
    privateKey = fs.readFileSync(DEVICECHECK_PRIVATE_KEY_PATH, 'utf8');
  } else {
    throw new Error('DeviceCheck private key not found in env var or file path');
  }

  const token = jwt.sign({}, privateKey, {
    algorithm: 'ES256',
    expiresIn: '10m',
    issuer: APPLE_TEAM_ID,
    header: {
      kid: DEVICECHECK_KEY_ID,
    },
  });

  return token;
}

/**
 * Hash device token for storage (don't store raw tokens)
 */
function hashDeviceToken(deviceToken: string): string {
  return crypto.createHash('sha256').update(deviceToken).digest('hex');
}

/**
 * Query Apple DeviceCheck API for device bits (optional, for verification)
 */
async function queryAppleDeviceCheck(deviceToken: string): Promise<{ bit0: boolean; bit1: boolean } | null> {
  try {
    const jwtToken = generateDeviceCheckJWT();

    const response = await fetch(`${DEVICECHECK_API_URL}/query_two_bits`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwtToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        device_token: deviceToken,
        timestamp: Date.now(),
      }),
    });

    if (!response.ok) {
      console.error('[DeviceCheck] Apple API error:', await response.text());
      return null;
    }

    const data = await response.json() as { bit0: boolean; bit1: boolean };
    return data;
  } catch (error) {
    console.error('[DeviceCheck] Failed to query Apple:', error);
    return null;
  }
}

/**
 * Update Apple DeviceCheck bits (optional, for backup storage)
 */
async function updateAppleDeviceCheck(deviceToken: string, sessionsUsed: number): Promise<boolean> {
  try {
    const jwtToken = generateDeviceCheckJWT();

    // Map sessions to 2 bits:
    // 00 (0): 0 sessions
    // 01 (1): 1 session
    // 10 (2): 2+ sessions
    const bit0 = sessionsUsed >= 1;
    const bit1 = sessionsUsed >= 2;

    const response = await fetch(`${DEVICECHECK_API_URL}/update_two_bits`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwtToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        device_token: deviceToken,
        timestamp: Date.now(),
        bit0,
        bit1,
      }),
    });

    if (!response.ok) {
      console.error('[DeviceCheck] Apple update error:', await response.text());
      return false;
    }

    return true;
  } catch (error) {
    console.error('[DeviceCheck] Failed to update Apple:', error);
    return false;
  }
}

/**
 * POST /device/status
 * Query device's free session count
 */
router.post('/status', async (req: Request, res: Response) => {
  try {
    const { device_token } = req.body;

    if (!device_token) {
      return res.status(400).json({ error: 'device_token required' });
    }

    // Hash the device token for storage
    const deviceHash = hashDeviceToken(device_token);

    // Get from our database (in-memory for now)
    const deviceData = deviceStore.get(deviceHash);
    const freeSessionsUsed = deviceData?.freeSessionsUsed || 0;

    console.log(`[DeviceCheck] Status query: ${deviceHash.substring(0, 8)}... -> ${freeSessionsUsed}/2 sessions used`);

    res.json({
      free_sessions_used: freeSessionsUsed,
    });
  } catch (error) {
    console.error('[DeviceCheck] Status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /device/update
 * Increment device's free session counter
 */
router.post('/update', async (req: Request, res: Response) => {
  try {
    const { device_token, increment_session } = req.body;

    if (!device_token) {
      return res.status(400).json({ error: 'device_token required' });
    }

    // Hash the device token
    const deviceHash = hashDeviceToken(device_token);

    // Get current count
    const deviceData = deviceStore.get(deviceHash) || { freeSessionsUsed: 0, lastUpdated: new Date() };

    // Increment if requested
    if (increment_session) {
      deviceData.freeSessionsUsed = Math.min(2, deviceData.freeSessionsUsed + 1);
      deviceData.lastUpdated = new Date();
    }

    // Save to store
    deviceStore.set(deviceHash, deviceData);

    console.log(`[DeviceCheck] Update: ${deviceHash.substring(0, 8)}... -> ${deviceData.freeSessionsUsed}/2 sessions`);

    // Optional: Also update Apple's two bits as backup
    // Uncomment if you want redundancy (requires Apple DeviceCheck setup)
    // await updateAppleDeviceCheck(device_token, deviceData.freeSessionsUsed);

    res.json({
      success: true,
      free_sessions_used: deviceData.freeSessionsUsed,
    });
  } catch (error) {
    console.error('[DeviceCheck] Update error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
