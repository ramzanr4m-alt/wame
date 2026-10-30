const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require('@whiskeysockets/baileys');
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const pino = require('pino');

// --- НАСТРОЙКИ ---
const TG_TOKEN = '9032734400:AAE077CjWtLGPbSAKq_MA0wzvGHuc_c1Umw';
const OWNER_TG_ID = 5846687574;

// Черный список ID групп, куда отправлять НЕ нужно
let BLACKLIST = [];
// -----------------

const app = express();
app.get('/', (req, res) => res.send('Бот активен'));
app.listen(process.env.PORT || 3000);

const tgBot = new TelegramBot(TG_TOKEN, { polling: true });
let sock;
let waitingForPhone = false;

async function startWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_session');
    
    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startWhatsApp();
        } else if (connection === 'open') {
            tgBot.sendMessage(OWNER_TG_ID, 'WhatsApp успешно подключен и готов к работе!');
        }
    });
}

tgBot.on('message', async (msg) => {
    if (msg.from.id !== OWNER_TG_ID) return;
    const text = (msg.text || '').trim();

    if (text === '/link') {
        waitingForPhone = true;
        return tgBot.sendMessage(OWNER_TG_ID, 'Отправьте ваш номер WhatsApp в международном формате БЕЗ плюса (например: 79991234567):');
    }

    if (waitingForPhone) {
        waitingForPhone = false;
        const cleanPhone = text.replace(/[^0-9]/g, '');
        tgBot.sendMessage(OWNER_TG_ID, 'Запрашиваю код у WhatsApp...');
        
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(cleanPhone);
                tgBot.sendMessage(
                    OWNER_TG_ID, 
                    `Ваш код привязки: *${code}*\n\n1. Откройте WhatsApp на iPhone.\n2. Настройки → Связанные устройства → Привязка устройства.\n3. Внизу нажмите "Привязать по номеру телефона" и введите этот код.`,
                    { parse_mode: 'Markdown' }
                );
            } catch (err) {
                tgBot.sendMessage(OWNER_TG_ID, 'Ошибка генерации кода. Проверьте правильность номера и повторите /link');
            }
        }, 3000);
        return;
    }

    if (text === '/groups') {
        try {
            const groups = await sock.groupFetchAllParticipating();
            const groupList = Object.values(groups);
            
            if (groupList.length === 0) return tgBot.sendMessage(OWNER_TG_ID, 'Группы не найдены.');

            let report = 'Список групп:\n\n';
            groupList.forEach((g, i) => {
                const isBlocked = BLACKLIST.includes(g.id);
                report += `${i + 1}. *${g.subject}*\nID: \`${g.id}\`${isBlocked ? ' ⛔ (Исключена)' : ''}\n\n`;
            });
            report += 'Чтобы исключить группу, отправьте команду:\n`/ignore ID_ГРУППЫ`';
            return tgBot.sendMessage(OWNER_TG_ID, report, { parse_mode: 'Markdown' });
        } catch (e) {
            return tgBot.sendMessage(OWNER_TG_ID, 'Ошибка получения списка групп.');
        }
    }

    if (text.startsWith('/ignore ')) {
        const idToIgnore = text.replace('/ignore ', '').trim();
        if (!BLACKLIST.includes(idToIgnore)) {
            BLACKLIST.push(idToIgnore);
            return tgBot.sendMessage(OWNER_TG_ID, `Группа ${idToIgnore} добавлена в исключения.`);
        }
        return tgBot.sendMessage(OWNER_TG_ID, 'Эта группа уже в исключениях.');
    }

    if (text === '/clear_blacklist') {
        BLACKLIST = [];
        return tgBot.sendMessage(OWNER_TG_ID, 'Черный список очищен.');
    }

    if (text.startsWith('/send ')) {
        const broadcastText = text.replace('/send ', '').trim();
        if (!broadcastText) return tgBot.sendMessage(OWNER_TG_ID, 'Текст не может быть пустым.');

        const groups = await sock.groupFetchAllParticipating();
        const targetGroups = Object.values(groups).filter(g => !BLACKLIST.includes(g.id));

        await tgBot.sendMessage(OWNER_TG_ID, `Начинаю рассылку в ${targetGroups.length} групп. Пауза между отправками: 8-12 сек.`);

        let sent = 0;
        let errors = 0;

        for (const group of targetGroups) {
            try {
                await sock.sendMessage(group.id, { text: broadcastText });
                sent++;
            } catch (err) {
                errors++;
            }
            const randomDelay = Math.floor(Math.random() * 4000) + 8000;
            await delay(randomDelay);
        }

        return tgBot.sendMessage(OWNER_TG_ID, `Рассылка завершена!\nУспешно: ${sent}\nОшибок: ${errors}`);
    }

    tgBot.sendMessage(OWNER_TG_ID, 'Команды:\n/link — привязать WhatsApp\n/groups — список групп\n/ignore ID — исключить группу\n/send Текст — разослать');
});

startWhatsApp();
