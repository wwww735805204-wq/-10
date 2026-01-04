const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    delay 
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const axios = require('axios');
const express = require('express'); // إضافة سيرفر ويب لإبقاء البوت مستيقظاً
const { Boom } = require('@hapi/boom');

// --- إعداد سيرفر الويب البسيط ---
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is Running!'));
app.listen(port, () => console.log(`سيرفر التنبيه يعمل على المنفذ ${port}`));

const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxuypqigQzWhKzV3QBbyhoSm5ZBONgGfJ-w5vOyWZ17xJO4-d8VgzA6Ga0bzzzooNHv/exec";
const DB_FILE = './mapping_db.json';

if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ merchants: {}, customers: {} }));

function formatMoney(amount) {
    return Number(amount).toLocaleString('en-US'); 
}

async function handleCustomerRequest(sock, jid, customerId) {
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
                report += `${isPayment ? "🟢" : "🔴"} *${formatMoney(amount)}* | ${i.text}\n   └ 🗓️ ${i.calendar}\n\n`; 
            });

            const netBalance = totalDebt - totalPaid;
            report += `───────────────────\n📊 *ملخص الحساب:*\n🔴 *الدين:* ${formatMoney(totalDebt)}\n🟢 *النقد:* ${formatMoney(totalPaid)}\n───────────────────\n`;
            report += netBalance > 0 ? `❗ *المطلوب:* ${formatMoney(netBalance)}` : netBalance < 0 ? `💰 *لك رصيد:* ${formatMoney(Math.abs(netBalance))}` : `✅ *خالص*`;
            report += `\n───────────────────\n🤖 نظام آلي`;

            await sock.sendMessage(jid, { text: report });
        }
    } catch (e) { console.log(e); }
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        browser: ["Ubuntu", "Chrome", "20.0.0"]
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (u) => {
        const { connection, lastDisconnect } = u;
        if (connection === 'open') console.log('✅ متصل!');
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom) ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;
            if (shouldReconnect) startBot();
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;
        const sender = m.key.remoteJid;
        const text = (m.message.conversation || m.message.extendedTextMessage?.text || "").trim();
        let db = JSON.parse(fs.readFileSync(DB_FILE));
        
        if (text === "كم حسابي") {
            const id = db.customers[sender.split('@')[0]];
            id ? handleCustomerRequest(sock, sender, id) : sock.sendMessage(sender, { text: "أرسل الـ ID الخاص بك (مثال: ID-123)" });
        } else if (text.startsWith("ID-")) {
            db.customers[sender.split('@')[0]] = text;
            fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
            sock.sendMessage(sender, { text: "✅ تم الربط!" });
            handleCustomerRequest(sock, sender, text);
        }
    });
}
startBot();
