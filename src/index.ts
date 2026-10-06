import http from "http";
import https from "https";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { execFile } from "child_process";
import WhatsApp from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';

const require = createRequire(import.meta.url);
const ffmpegFluent = require('fluent-ffmpeg');

const { Client, LocalAuth, Events, MessageMedia } = WhatsApp;
const PORT = 1234;
const WHATSAPP_GROUP = 'Home Cameras';
const WHATSAPP_CLIPS_GROUP = 'Home Cameras Clips';
// Fallback JIDs, captured 13-09-26. client.getChats() currently throws for every
// chat ("Failed to execute 'get' on 'IDBObjectStore'") under the WhatsApp Web
// version rolled out ~06-09-26, so name-based lookup can't be trusted right now.
// Remove this fallback once that's fixed upstream (wwebjs/whatsapp-web.js).
const KNOWN_GROUP_IDS: Record<string, string> = {
  [WHATSAPP_GROUP]: '120363428255028161@g.us',
  [WHATSAPP_CLIPS_GROUP]: '120363427709871774@g.us',
};
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name} (check .env / systemd EnvironmentFile)`);
  return value;
}
const BI_HOST = requireEnv('BI_HOST');
const BI_PORT = Number(requireEnv('BI_PORT'));
const BI_USERNAME = requireEnv('BI_USERNAME');
const BI_PASSWORD = requireEnv('BI_PASSWORD');

let whatsAppGood = false;
let groupID = '';
let clipsGroupID = '';
const processingAlerts = new Set<string>();
let readyDeadline = 0;
let shuttingDown = false;

// systemd sets INVOCATION_ID for services; a manual `npm run listener` doesn't have it
const UNDER_SYSTEMD = !!process.env.INVOCATION_ID;
// Exit code for "WhatsApp needs re-linking" - the unit has RestartPreventExitStatus=78
// so systemd leaves the service stopped instead of restart-looping on a QR prompt
const EXIT_NEEDS_AUTH = 78;
const SCAN_WAIT_MS = 5 * 60 * 1000; // Time allowed to scan a QR code when run manually

// Tell systemd we're up (the unit is Type=notify, so it shows 'activating' until
// this is sent - WhatsApp linked, groups resolved and listening). No-op when run manually.
function notifySystemdReady() {
  if (!process.env.NOTIFY_SOCKET) return;
  execFile('systemd-notify', ['--ready'], (err) => {
    if (err) console.warn('systemd-notify failed:', err.message);
  });
}

function nowString(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear().toString().slice(-2)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// readyDeadline is pushed out while a QR code is waiting to be scanned
async function waitForWhatsAppGood(timeout: number): Promise<boolean> {
  readyDeadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      if (whatsAppGood) {
        clearInterval(interval);
        resolve(true);
      } else if (Date.now() > readyDeadline) {
        clearInterval(interval);
        reject(new Error('Timeout waiting for WhatsApp to be ready.'));
      }
    }, 500);
  });
}

async function getGroupID(groupName: string): Promise<string> {
  try {
    const chats = await client.getChats();
    const group = chats.find(chat => chat.isGroup && chat.name === groupName);
    if (group) {
      console.log(`Group ID for [${groupName}]: ${group.id._serialized}`);
      return group.id._serialized;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`getChats() failed while resolving [${groupName}] (${message}), falling back to known ID`);
  }
  const fallback = KNOWN_GROUP_IDS[groupName];
  if (fallback) {
    console.log(`Using known group ID for [${groupName}]: ${fallback}`);
    return fallback;
  }
  throw new Error(`Cannot find WhatsApp group [${groupName}]`);
}

function biJsonRequest(body: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      host: BI_HOST,
      port: BI_PORT,
      path: '/json',
      method: 'POST',
      rejectUnauthorized: false,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse BI response: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function biLogin(): Promise<string> {
  const step1 = await biJsonRequest({ cmd: 'login' });
  if (!step1.session) throw new Error('BI login failed: no session key');
  const session = step1.session;
  const response = crypto.createHash('md5').update(`${BI_USERNAME}:${session}:${BI_PASSWORD}`).digest('hex');
  const step2 = await biJsonRequest({ cmd: 'login', session, response });
  if (step2.result !== 'success') throw new Error(`BI login failed: ${JSON.stringify(step2)}`);
  return session;
}

async function fetchFromBI(session: string, path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const fullPath = `${path}${path.includes('?') ? '&' : '?'}session=${session}`;
    const options = { host: BI_HOST, port: BI_PORT, path: fullPath, rejectUnauthorized: false };
    https.get(options, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`BI returned HTTP ${res.statusCode} for ${path}`));
        res.resume();
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

async function exportClipAsMP4(session: string, clip: string): Promise<Buffer> {
  const exportStart = await biJsonRequest({ cmd: 'export', session, path: clip, format: 1 });
  if (!exportStart.data?.path) throw new Error(`Export failed to start for ${clip}`);
  const exportPath = exportStart.data.path;
  let status = exportStart.data.status;
  let uri = exportStart.data.uri;
  while (status === 'queued' || status === 'active') {
    await new Promise(resolve => setTimeout(resolve, 2000));
    const poll = await biJsonRequest({ cmd: 'export', session, path: exportPath });
    status = poll.data?.status;
    uri = poll.data?.uri ?? uri;
  }
  if (status === 'error' || !uri) throw new Error(`Export failed for ${clip}: status=${status}`);
  return fetchFromBI(session, `/clips/${uri}`);
}

async function fetchClipFromBI(session: string, clip: string): Promise<Buffer> {
  if (clip.toLowerCase().endsWith('.mp4')) {
    return fetchFromBI(session, `/alerts/${clip}?fulljpeg=1`);
  }
  return exportClipAsMP4(session, clip);
}

function transcodeToSD(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const id = Date.now();
    const inFile = path.join(os.tmpdir(), `clip_in_${id}.mp4`);
    const outFile = path.join(os.tmpdir(), `clip_out_${id}.mp4`);
    fs.writeFileSync(inFile, input);
    ffmpegFluent(inFile)
      .videoFilter('scale=640:360')
      .videoCodec('libx264')
      .audioCodec('aac')
      .on('end', () => {
        const result = fs.readFileSync(outFile);
        fs.rmSync(inFile, { force: true });
        fs.rmSync(outFile, { force: true });
        resolve(result);
      })
      .on('error', (err) => {
        fs.rmSync(inFile, { force: true });
        fs.rmSync(outFile, { force: true });
        reject(err);
      })
      .save(outFile);
  });
}

async function sendAlert(cam: string, memo: string, base64jpg: string) {
  if (!whatsAppGood) {
    console.log('WhatsApp not ready, dropping alert');
    return;
  }
  const media = new MessageMedia('image/jpeg', base64jpg, 'alert.jpg');
  const caption = `${nowString()} - ${cam}${memo ? ` - ${memo}` : ''}`;
  await client.sendMessage(groupID, media, { caption });
  console.log(`Alert sent: ${caption}`);
}

async function sendClip(session: string, cam: string, memo: string, clip: string) {
  if (!whatsAppGood) {
    console.log('WhatsApp not ready, dropping clip');
    return;
  }
  const clipBuffer = await fetchClipFromBI(session, clip);
  const transcodedBuffer = await transcodeToSD(clipBuffer);
  const media = new MessageMedia('video/mp4', transcodedBuffer.toString('base64'), 'clip.mp4');
  const caption = `${nowString()} - ${cam}${memo ? ` - ${memo}` : ''}`;
  await client.sendMessage(clipsGroupID, media, { caption });
  console.log(`Clip sent: ${caption}`);
}

/**
 * Shared handling for both endpoints: dedupes by alertKey, responds 200
 * immediately, then runs `work` in the background so a slow WhatsApp/Blue
 * Iris round-trip never holds the HTTP request open.
 */
function handleAsync(res: http.ServerResponse, alertKey: string, label: string, work: () => Promise<void>) {
  if (processingAlerts.has(alertKey)) {
    console.log(`Duplicate ${label} for [${alertKey}], ignoring`);
    res.writeHead(200);
    res.end("OK");
    return;
  }
  processingAlerts.add(alertKey);
  res.writeHead(200);
  res.end("OK");
  work()
    .catch((err) => console.error(`Error handling ${label} for [${alertKey}]:`, err))
    .finally(() => processingAlerts.delete(alertKey));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/alert") {
    readBody(req).then(async (body) => {
      try {
        const { cam, memo, image, alert_time } = JSON.parse(body);
        const alertKey = `${cam}:${alert_time}`;
        console.log(`Alert: cam=${cam}, memo=${memo}`);
        handleAsync(res, alertKey, '/alert', () => sendAlert(cam, memo, image));
      } catch (err) {
        console.error('Error parsing /alert payload:', err);
        res.writeHead(500);
        res.end("Error");
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/clip") {
    readBody(req).then(async (body) => {
      try {
        const { cam, memo, clip, alert_time } = JSON.parse(body);
        const alertKey = `${cam}:${alert_time}`;
        console.log(`Clip: cam=${cam}, memo=${memo}, clip=${clip}`);
        handleAsync(res, alertKey, '/clip', async () => {
          const session = await biLogin();
          let resolvedClip = clip;
          if (!clip || clip === '@-1') {
            while (true) {
              const result = await biJsonRequest({ cmd: 'alertlist', session, camera: cam });
              if (result.result === 'success' && result.data?.length > 0) {
                resolvedClip = result.data[0].clip;
                console.log(`Clip indexed for [${cam}]: ${resolvedClip}`);
                break;
              }
              await new Promise(resolve => setTimeout(resolve, 2000));
            }
          }
          await sendClip(session, cam, memo, resolvedClip);
        });
      } catch (err) {
        console.error('Error parsing /clip payload:', err);
        res.writeHead(500);
        res.end("Error");
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

const systemChromium = ['/usr/bin/chromium', '/usr/bin/chromium-browser'].find(p => fs.existsSync(p));

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: './runtime-data'
  }),
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7871.100 Safari/537.36',
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    ...(systemChromium ? { executablePath: systemChromium } : {})
  }
});

client.on(Events.READY, () => {
  console.log('WhatsApp Web is ready!');
  whatsAppGood = true;
});

client.on(Events.QR_RECEIVED, (qr) => {
  if (UNDER_SYSTEMD) {
    // Nobody can scan a QR code in the journal - stop and wait for a manual re-link
    console.error('WhatsApp is not linked. Stopping service - run `npm run listener` manually to scan a QR code.');
    void shutdown(EXIT_NEEDS_AUTH);
    return;
  }
  console.log('Please scan the following QR code with your WhatsApp mobile app.');
  qrcode.generate(qr, { small: true });
  readyDeadline = Date.now() + SCAN_WAIT_MS;
});

client.on(Events.AUTHENTICATION_FAILURE, (message) => {
  whatsAppGood = false;
  console.error('Authentication failed:', message);
});

client.on(Events.DISCONNECTED, (reason) => {
  whatsAppGood = false;
  if (reason === 'LOGOUT') {
    // Unlinked from the phone - session is gone, needs a manual re-link
    console.error('WhatsApp was logged out (device unlinked). Run `npm run listener` manually to re-link.');
    void shutdown(EXIT_NEEDS_AUTH);
  } else {
    // The library closes the browser on any other disconnect - exit so systemd restarts us
    console.error('WhatsApp disconnected:', reason);
    void shutdown(1);
  }
});

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('Shutting down...');
  server.close();
  try {
    await client.destroy();
  } catch (err) {
    console.warn('client.destroy() failed:', err instanceof Error ? err.message : err);
  }
  await new Promise(res => setTimeout(res, 3000));
  process.exit(exitCode);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

// The library can reject in the background while we're shutting down (e.g. it
// tries to reload the page after a logout) - don't let that crash the exit
process.on('unhandledRejection', (err) => {
  if (shuttingDown) {
    console.warn('Ignoring error during shutdown:', err instanceof Error ? err.message : err);
    return;
  }
  console.error('Unhandled rejection:', err);
  process.exit(1);
});

client.initialize();

await waitForWhatsAppGood(30000);
groupID = await getGroupID(WHATSAPP_GROUP);
clipsGroupID = await getGroupID(WHATSAPP_CLIPS_GROUP);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Listening for alerts on port ${PORT}`);
  notifySystemdReady();
});
