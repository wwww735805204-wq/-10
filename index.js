const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    delay,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const axios = require('axios');
const express = require('express');
const { Boom } = require('@hapi/boom');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- الإعدادات ---
const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxuypqigQzWhKzV3QBbyhoSm5ZBONgGfJ-w5vOyWZ17xJO4-d8VgzA6Ga0bzzzooNHv/exec";
const DB_FILE = './mapping_db.json';
const SESSIONS_DIR = './sessions_auth';

const sessions = new Map();

if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ merchants: {}, customers: {} }));
}
if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR);
}

// --- وظائف مساعدة ---
function formatMoney(amount) {
    return Number(amount).toLocaleString('en-US');
}

function deleteSession(sessionId) {
    const sessionPath = path.join(SESSIONS_DIR, sessionId);
    if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
    }
    sessions.delete(sessionId);
}

// --- التعامل مع طلبات العملاء ---
async function handleCustomerRequest(socket, jid, customerId) {
    try {
        const params = new URLSearchParams();
        params.append('action', 'get_customer_by_userid');
        params.append('customer_userid', customerId);

        const response = await axios.post(SCRIPT_URL, params, { timeout: 15000 });
        if (response.data && response.data.success) {
            const customer = response.data.data.customer_data;
            const merchant = response.data.data.merchant_info;
            let list = typeof customer.list === 'string' ? JSON.parse(customer.list) : customer.list;
            let totalDebt = 0, totalPaid = 0;
            let report = `🧾 *كشف حساب: ${merchant.merchant_name}*\n👤 *العميل:* ${customer.name}\n📅 *التاريخ:* ${new Date().toLocaleDateString('en-GB')}\n───────────────────\n`;
            
            const visibleList = list.filter(item => item.state === "visible" || !item.hasOwnProperty('state'));
            visibleList.forEach(i => {
                let amount = parseFloat(i.m) || 0;
                const isPayment = i["+"] === "+";
                isPayment ? totalPaid += amount : totalDebt += amount;
                report += `${isPayment ? "🟢" : "🔴"} *${formatMoney(amount)}* | ${i.text}\n └ 🗓️ ${i.calendar}\n\n`;
            });
            const netBalance = totalDebt - totalPaid;
            report += `───────────────────\n📊 *ملخص الحساب:*\n🔴 *إجمالي الدين:* ${formatMoney(totalDebt)}\n🟢 *إجمالي النقد:* ${formatMoney(totalPaid)}\n───────────────────\n`;
            report += netBalance > 0 ? `❗ *المتبقي عليك:* ${formatMoney(netBalance)}` : netBalance < 0 ? `💰 *رصيد لك:* ${formatMoney(Math.abs(netBalance))}` : `✅ *الحساب خالص*`;
            report += `\n───────────────────\n🤖 نظام محاسبي آلي`;
            await socket.sendMessage(jid, { text: report });
        }
    } catch (e) {
        console.error("Fetch Error:", e.message);
        await socket.sendMessage(jid, { text: "⚠️ حدث خطأ أثناء جلب البيانات." });
    }
}

// --- دالة تشغيل الجلسة ---
async function startSession(sessionId) {
    const sessionPath = path.join(SESSIONS_DIR, sessionId);
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
        },
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ["Windows", "Chrome", "11.0.0"],
    });

    sessions.set(sessionId, sock);
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') console.log(`✅ [${sessionId}] متصل!`);
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom) ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;
            if (shouldReconnect) {
                startSession(sessionId);
            } else {
                deleteSession(sessionId);
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;
        const sender = m.key.remoteJid;
        const pureNumber = sender.split('@')[0];
        const text = (m.message.conversation || m.message.extendedTextMessage?.text || "").trim();
        
        let db = JSON.parse(fs.readFileSync(DB_FILE));
        
        if (text === "كم حسابي") {
            const savedId = db.customers[`${sessionId}_${pureNumber}`];
            if (savedId) {
                await handleCustomerRequest(sock, sender, savedId);
            } else {
                await sock.sendMessage(sender, { text: "عزيزي العميل، يرجى إرسال الـ ID الخاص بك (مثال: ID-12345):" });
            }
        } else if (text.startsWith("ID-")) {
            db.customers[`${sessionId}_${pureNumber}`] = text;
            fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
            await sock.sendMessage(sender, { text: "✅ تم الربط بنجاح. جاري الجلب..." });
            await handleCustomerRequest(sock, sender, text);
        }
    });
    return sock;
}

// --- API ---
app.post('/request-code', async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ success: false, error: "Missing phoneNumber" });

    const sessionId = phoneNumber.replace(/[^0-9]/g, '');
    try {
        if (sessions.has(sessionId)) {
            const oldSock = sessions.get(sessionId);
            if (!oldSock.authState.creds.registered) {
                deleteSession(sessionId);
            }
        }
        const sock = await startSession(sessionId);
        let retryCount = 0;
        while (!sock.requestPairingCode && retryCount < 10) {
            await delay(500);
            retryCount++;
        }
        const code = await sock.requestPairingCode(sessionId);
        res.json({ success: true, pairingCode: code });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// تعديل المنفذ ليتناسب مع الاستضافات السحابية
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    if (fs.existsSync(SESSIONS_DIR)) {
        fs.readdirSync(SESSIONS_DIR).forEach(f => {
            if (fs.statSync(path.join(SESSIONS_DIR, f)).isDirectory()) startSession(f);
        });
    }
});
