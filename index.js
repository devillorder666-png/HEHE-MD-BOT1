const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const axios = require('axios');
const config = require('./config');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let sock;
let games = {}; 

// 1. DYNAMIC PAIRING WEB SERVER INTERFACE
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${config.botName}</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #e5ddd5; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
                .box { background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); text-align: center; max-width: 360px; width: 85%; }
                h2 { color: #075e54; margin-bottom: 10px; }
                input { width: 100%; padding: 12px; margin: 15px 0; border: 1px solid #ccc; border-radius: 6px; box-sizing: border-box; font-size: 16px; }
                button { background: #25d366; color: white; border: none; padding: 12px; border-radius: 6px; font-size: 16px; cursor: pointer; font-weight: bold; width: 100%; }
                button:hover { background: #128c7e; }
            </style>
        </head>
        <body>
            <div class="box">
                <h2>${config.botName} Connection Link</h2>
                <p>Enter a WhatsApp phone number with country code to request a linking code.</p>
                <form action="/pair" method="POST">
                    <input type="text" name="number" placeholder="e.g. 256779997074" required />
                    <button type="submit">Link Multi-Device</button>
                </form>
            </div>
        </body>
        </html>
    `);
});

app.post('/pair', async (req, res) => {
    let num = req.body.number.replace(/[^0-9]/g, '');
    if (!num) return res.send("<h3>Please supply a valid numerical string.</h3>");
    try {
        if (!sock) return res.send("<h3>Bot backend system is currently booting. Reload in a moment.</h3>");
        let code = await sock.requestPairingCode(num);
        res.send(`
            <div style="font-family: sans-serif; text-align: center; padding: 50px;">
                <h2>Your Entry Connection Code:</h2>
                <h1 style="color: #128c7e; font-size: 45px; letter-spacing: 4px; background: #f0f0f0; padding: 15px; display: inline-block; border-radius: 8px;">${code}</h1>
                <p>Open WhatsApp -> Linked Devices -> Link with Phone Number, and key in this code.</p>
                <br><a href="/" style="color: #075e54; text-decoration: none; font-weight: bold;">← Go Back</a>
            </div>
        `);
    } catch (err) {
        res.send("<h3>Pairing failure structural log: " + err.message + "</h3>");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server live on port ${PORT}`));

// 2. WHATSAPP BOT SYSTEM ENGINE
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_session');
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log(`${config.botName} instance active.`);
            // Auto trigger target pairing logs upon terminal creation if connection hasn't been established
            if (config.targetConnect) {
                try {
                    await delay(6000);
                    let initialCode = await sock.requestPairingCode(config.targetConnect);
                    console.log(`[AUTO CODE FOR TARGET ${config.targetConnect}]: ${initialCode}`);
                } catch(e){}
            }
        }
    });

    sock.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            const mek = chatUpdate.messages[0];
            if (!mek.message || mek.key.fromMe) return;
            
            const from = mek.key.remoteJid;
            const isGroup = from.endsWith('@g.us');
            const type = Object.keys(mek.message)[0];
            
            const body = (type === 'conversation') ? mek.message.conversation : 
                         (type === 'extendedTextMessage') ? mek.message.extendedTextMessage.text : '';
            
            const sender = isGroup ? mek.key.participant : mek.key.remoteJid;
            const isOwner = sender.includes("256792930216");

            // Evaluate ongoing game plays
            if (isGroup && games[from] && games[from].status === 'playing') {
                if (sender === games[from].players[games[from].currentTurn] && !body.startsWith('.')) {
                    await handleWordChainTurn(from, sender, body.trim().toLowerCase());
                    return;
                }
            }

            if (!body.startsWith('.')) return;
            const args = body.trim().split(/ +/);
            const command = args.shift().slice(1).toLowerCase();

            switch (command) {
                case 'alive':
                    await sock.sendMessage(from, { text: `👋 *${config.botName}* is up and running continuously!\n\n👑 *Owner:* +256792930216` });
                    break;

                case 'eval':
                case 'eval2':
                    if (!isOwner) return sock.sendMessage(from, { text: "❌ Restrained access: Owner parameter only." });
                    try {
                        let evalCode = args.join(" ");
                        let result = eval(evalCode);
                        await sock.sendMessage(from, { text: `*Evaluation Result:* ${String(result)}` });
                    } catch (e) {
                        await sock.sendMessage(from, { text: `*Error:* ${e.message}` });
                    }
                    break;

                case 'restart':
                    if (!isOwner) return;
                    await sock.sendMessage(from, { text: "🔄 Executing process container reboot cycle..." });
                    process.exit(0);
                    break;

                case 'wrchain':
                    if (!isGroup) return sock.sendMessage(from, { text: "❌ Wordchain initialization metrics require group structural contexts." });
                    if (args[0] === 'join') {
                        setupWordChainJoin(from, sender);
                    }
                    break;
            }
        } catch (err) {
            console.log(err);
        }
    });
}

// 3. WORDCHAIN GOOGLE INDEX ENGINE LOGIC
function setupWordChainJoin(from, sender) {
    if (!games[from]) {
        games[from] = { status: 'joining', players: [], usedWords: [], currentTurn: 0, timer: null };
        sock.sendMessage(from, { text: `🎮 *WORDCHAIN GAME OPENED!*\n\nType \`.wrchain join\` to reserve a slot (2 to 8 players max).\n⏳ Game starts automatically in 40 seconds!` });
        setTimeout(() => startGame(from), 40000);
    }
    
    let game = games[from];
    if (game.status !== 'joining') return;
    if (game.players.includes(sender)) return;
    if (game.players.length >= 8) return sock.sendMessage(from, { text: "❌ Match full. Max capacity limits reached." });

    game.players.push(sender);
    sock.sendMessage(from, { text: `✅ @${sender.split('@')[0]} has entered the match. [${game.players.length}/8]`, mentions: [sender] });
}

function startGame(from) {
    let game = games[from];
    if (!game || game.status !== 'joining') return;
    if (game.players.length < 2) {
        sock.sendMessage(from, { text: "❌ Match aborted. Insufficient participation ratios (minimum 2 players required)." });
        delete games[from];
        return;
    }
    game.status = 'playing';
    game.currentTurn = 0;
    
    let alphabet = "abcdefghijklmnopqrstuvwxyz";
    game.lastLetter = alphabet[Math.floor(Math.random() * alphabet.length)];
    
    sock.sendMessage(from, { 
        text: `🏁 *WORDCHAIN INITIALIZED!*\n\nStarting match filter target key letter: *${game.lastLetter.toUpperCase()}*\n\n*Turn Matrix Order:* \n` + game.players.map((p, idx) => `${idx + 1}. @${p.split('@')[0]}`).join('\n'), 
        mentions: game.players 
    });
    nextTurn(from);
}

function nextTurn(from) {
    let game = games[from];
    if (!game || game.status !== 'playing') return;

    if (game.players.length === 1) {
        let winner = game.players[0];
        sock.sendMessage(from, { text: `🏆 🎉 *MATCH RESOLVED!*\nThe victorious champion is @${winner.split('@')[0]}!`, mentions: [winner] });
        clearTimeout(game.timer);
        delete games[from];
        return;
    }

    let currentPlayer = game.players[game.currentTurn];
    sock.sendMessage(from, { text: `⏳ @${currentPlayer.split('@')[0]}, it's your turn! Provide a dictionary word starting with: *${game.lastLetter.toUpperCase()}*.\n\n⏱️ Countdown: *40 seconds*!`, mentions: [currentPlayer] });

    if (game.timer) clearTimeout(game.timer);
    
    game.timer = setTimeout(() => {
        sock.sendMessage(from, { text: `❌ Time elapsed! @${currentPlayer.split('@')[0]} failed to respond and is *ELIMINATED*!`, mentions: [currentPlayer] });
        game.players.splice(game.currentTurn, 1);
        if (game.currentTurn >= game.players.length) game.currentTurn = 0;
        nextTurn(from);
    }, config.thinkTime * 1000);
}

