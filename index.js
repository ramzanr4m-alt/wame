const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require('@whiskeysockets/baileys');
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const pino = require('pino');

const TG_TOKEN = process.env.TG_TOKEN;
const OWNER_TG_ID = 5846687574;

let BLACKLIST = [];

const app = express();
app.get('/', (req, res) => res.send('Бот активен'));
app.listen(process.env.PORT || 3000);

if (!TG_TOKEN) {
    console.error("ОШИБКА: Не задан токен Telegram!");
    process.exit(1);
}

const tgBot = new TelegramBot(TG_TOKEN, { polling: true });

// Устанавливаем список команд для удобного меню в Telegram
tgBot.setMyCommands([
    { command: 'start', description: 'Запустить бота' },
    { command: 'link', description: 'Привязать WhatsApp по номеру' },
    { command: 'groups', description: 'Список групп и их ID' },
    { command: 'ignore', description: 'Добавить группу в игнор (/ignore ID)' },
    { command: 'unignore', description: 'Убрать из игнора (/unignore ID)' },
    { command: 'test_group', description: 'Тест отправки в 1 группу (/test_group ID Текст)' },
    { command: 'send', description: 'Сделать рассылку (/send Текст)' }
]);

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
    if (!msg.from || msg.from.id !== OWNER_TG_ID) return;
    const text = (msg.text || '').trim();

    if (text === '/start') {
        return tgBot.sendMessage(OWNER_TG_ID, 'Привет! Бот управления WhatsApp рассылкой запущен.\n\nДоступные команды:\n• /link — привязать WhatsApp\n• /groups — список групп\n• /ignore ID — исключить группу\n• /unignore ID — вернуть группу\n• /test_group ID Текст — тест 1 группы\n• /send Текст — запустить рассылку');
    }

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

            let report = 'Список ваших групп:\n\n';
            groupList.forEach((g, i) => {
                const isBlocked = BLACKLIST.includes(g.id);
                report += `${i + 1}. *${g.subject}*\nID: \`${g.id}\`${isBlocked ? ' ⛔ (В исключениях)' : ''}\n\n`;
            });
            report += 'Команды:\n• `/ignore ID` — добавить в игнор\n• `/unignore ID` — убрать из игнора';
            return tgBot.sendMessage(OWNER_TG_ID, report, { parse_mode: 'Markdown' });
        } catch (e) {
            return tgBot.sendMessage(OWNER_TG_ID, 'Ошибка получения списка групп.');
        }
    }

    if (text.startsWith('/ignore ')) {
        const idToIgnore = text.replace('/ignore ', '').trim();
        if (!idToIgnore) return tgBot.sendMessage(OWNER_TG_ID, 'Укажите ID группы.');
        if (!BLACKLIST.includes(idToIgnore)) {
            BLACKLIST.push(idToIgnore);
            return tgBot.sendMessage(OWNER_TG_ID, `Группа \`${idToIgnore}\` добавлена в исключения.`, { parse_mode: 'Markdown' });
        }
        return tgBot.sendMessage(OWNER_TG_ID, 'Эта группа уже в исключениях.');
    }

    if (text.startsWith('/unignore ')) {
        const idToFree = text.replace('/unignore ', '').trim();
        BLACKLIST = BLACKLIST.filter(id => id !== idToFree);
        return tgBot.sendMessage(OWNER_TG_ID, `Группа \`${idToFree}\` удалена из исключений.`, { parse_mode: 'Markdown' });
    }

    if (text.startsWith('/test_group ')) {
        const parts = text.replace('/test_group ', '').trim().split(' ');
        const targetId = parts[0];
        const testMsg = parts.slice(1).join(' ');

        if (!targetId || !testMsg) {
            return tgBot.sendMessage(OWNER_TG_ID, 'Формат команды:\n`/test_group ID_ГРУППЫ Текст сообщения`', { parse_mode: 'Markdown' });
        }

        const isIgnored = BLACKLIST.includes(targetId);

        try {
            await sock.sendMessage(targetId, { text: testMsg });
            return tgBot.sendMessage(OWNER_TG_ID, `Тестовое сообщение отправлено!\nID: \`${targetId}\`\nСтатус: ${isIgnored ? '⛔ В исключениях' : '✅ Активна'}`, { parse_mode: 'Markdown' });
        } catch (err) {
            return tgBot.sendMessage(OWNER_TG_ID, `Ошибка отправки в группу \`${targetId}\`. Проверьте ID.`, { parse_mode: 'Markdown' });
        }
    }

    if (text.startsWith('/send ')) {
        const broadcastText = text.replace('/send ', '').trim();
        if (!broadcastText) return tgBot.sendMessage(OWNER_TG_ID, 'Текст не может быть пустым.');

        const groups = await sock.groupFetchAllParticipating();
        const targetGroups = Object.values(groups).filter(g => !BLACKLIST.includes(g.id));

        await tgBot.sendMessage(OWNER_TG_ID, `Начинаю рассылку в ${targetGroups.length} групп. Пропущено: ${BLACKLIST.length}. Пауза: 8-12 сек.`);

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

    tgBot.sendMessage(OWNER_TG_ID, 'Неизвестная команда. Используйте меню или команды: /groups, /ignore, /unignore, /test_group, /send');
});

startWhatsApp();
