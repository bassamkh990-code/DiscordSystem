const { Client, GatewayIntentBits, ActionRowBuilder, StringSelectMenuBuilder, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits } = require('discord.js');
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.json');

function readDB() {
    try {
        if (!fs.existsSync(DB_PATH)) {
            const def = { staff: [], packages: [], activations: [], auditLogs: [] };
            fs.writeFileSync(DB_PATH, JSON.stringify(def, null, 2), 'utf8');
            return def;
        }
        const data = fs.readFileSync(DB_PATH, 'utf8');
        const db = JSON.parse(data);
        if (!db.staff) db.staff = [];
        if (!db.packages) db.packages = [];
        if (!db.activations) db.activations = [];
        if (!db.auditLogs) db.auditLogs = [];
        return db;
    } catch (e) {
        return { staff: [], packages: [], activations: [], auditLogs: [] };
    }
}

function writeDB(data) {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function logAction(action, details) {
    const db = readDB();
    if (!db.auditLogs) db.auditLogs = [];
    db.auditLogs.push({
        id: Date.now().toString(),
        action,
        details,
        date: new Date().toLocaleString('ar-SA')
    });
    if (db.auditLogs.length > 100) db.auditLogs.shift();
    writeDB(db);
}

const DASHBOARD_PASSCODE = '966123';
const AUDIT_PASSCODE = '999888';

const NEW_BOT_TOKEN = 'MTU3MTgyNDU5MjMyNDkyNzUwOA.Gyd2sC.2oRY_9ilEZA6qeVx9vRap7N3meSLW7--P3a0DE';
const PACKAGE_BOT_TOKEN = 'MTU2OTQzMDgzMzYzMzQyNzU1Nw.G7gQ5M.FsKua4Cr9B1N5SPiACKoIvFuceJM4suTjiI1zw';
const ACTIVATION_BOT_TOKEN = 'MTUzNTcyNjI2NDYxMzA4NTI0NQ.GAyuHW.iGXeqdKlMFDCzGSE4NHoXaa40dvXGcDPfAf5TU';

const ATTENDANCE_LOG_CHANNEL = '1571824969103708210';
const SUPPORT_CHANNELS = ['1571825013680504953', '1571825040335446147', '1571825068168978452'];

const STAFF_ROLE_ID = '1572372027162103888';
const THANKS_ROLE_ID = '1572372060012019792';
const BANNED_STAFF_ROLE_ID = '1572372121827541012';

const activeSessions = new Map();

// 1. بوت الإدارة والساعات والدعم
const mainClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers] });
mainClient.once('ready', () => console.log(`[بوت الإدارة] شغال: ${mainClient.user.tag}`));

mainClient.on('voiceStateUpdate', async (oldState, newState) => {
    const member = newState.member || oldState.member;
    if (!member || member.user.bot) return;

    const db = readDB();
    const staff = db.staff.find(s => s.discordId === member.id);
    if (!staff) return;

    const oldChannel = oldState.channelId;
    const newChannel = newState.channelId;
    const logChannel = member.guild.channels.cache.get(ATTENDANCE_LOG_CHANNEL);

    if (!SUPPORT_CHANNELS.includes(oldChannel) && SUPPORT_CHANNELS.includes(newChannel)) {
        activeSessions.set(member.id, Date.now());
        if (logChannel) {
            logChannel.send({ embeds: [new EmbedBuilder().setColor(0x00FF00).setDescription(`🟢 **دخول إداري**\nالإداري: <@${member.id}>\nالروم: **${newState.channel.name}**`)] }).catch(()=>{});
        }
    } 
    else if (SUPPORT_CHANNELS.includes(oldChannel) && !SUPPORT_CHANNELS.includes(newChannel)) {
        if (activeSessions.has(member.id)) {
            const startTime = activeSessions.get(member.id);
            const diffMins = Math.floor((Date.now() - startTime) / 60000);
            const today = new Date().toISOString().split('T')[0];
            
            if (diffMins > 0) {
                staff.totalMinutes = (staff.totalMinutes || 0) + diffMins;
                if (!staff.sessions) staff.sessions = [];
                let sess = staff.sessions.find(s => s.date === today);
                if (sess) {
                    sess.minutes += diffMins;
                } else {
                    staff.sessions.push({ date: today, minutes: diffMins });
                }
                writeDB(db);
            }
            activeSessions.delete(member.id);

            if (logChannel) {
                logChannel.send({ embeds: [new EmbedBuilder().setColor(0xFF0000).setDescription(`🔴 **خروج إداري**\nالإداري: <@${member.id}>\nالمدة: **${diffMins} دقيقة**`)] }).catch(()=>{});
            }
        }
    }
});
mainClient.login(NEW_BOT_TOKEN).catch(e => console.log('خطأ بوت الإدارة:', e.message));

// 2. بوت الحزم
const packageClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
packageClient.once('ready', () => console.log(`[بوت الحزم] شغال: ${packageClient.user.tag}`));
packageClient.on('messageCreate', async message => {
    if (message.author.bot) return;
    if (message.content === '!pkg') {
        if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) return message.reply('للإداريين فقط.');
        const menu = new StringSelectMenuBuilder().setCustomId('pkg_menu').setPlaceholder('اختر الحزمة...').addOptions([
            { label: 'حزمة بلاتينيوم', value: 'platinum_package', emoji: '💎' },
            { label: 'حزمة تيتانيوم', value: 'titanium_package', emoji: '⚡' },
            { label: 'حزمة زحف', value: 'crawl_package', emoji: '🚀' }
        ]);
        await message.channel.send({ embeds: [new EmbedBuilder().setTitle('نظام الحزم').setColor(0x5865F2)], components: [new ActionRowBuilder().addComponents(menu)] });
        message.delete().catch(()=>{});
    }
});
packageClient.on('interactionCreate', async interaction => {
    if (interaction.isStringSelectMenu() && interaction.customId === 'pkg_menu') {
        const modal = new ModalBuilder().setCustomId(`modal_pkg_${interaction.values[0]}`).setTitle('إعطاء حزمة');
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('uid').setLabel('كوبي آيدي الشخص').setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('السبب').setStyle(TextInputStyle.Paragraph).setRequired(true))
        );
        await interaction.showModal(modal);
    } else if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_pkg_')) {
        const pkgKey = interaction.customId.replace('modal_pkg_', '');
        const pkgName = pkgKey === 'platinum_package' ? 'حزمة بلاتينيوم' : pkgKey === 'titanium_package' ? 'حزمة تيتانيوم' : 'حزمة زحف';
        const uid = interaction.fields.getTextInputValue('uid').trim();
        const reason = interaction.fields.getTextInputValue('reason');
        
        try {
            const member = await interaction.guild.members.fetch(uid);
            const ROLES = { platinum_package: '1569432725474254928', titanium_package: '1569432661221703821', crawl_package: '1569432789730983987' };
            await member.roles.add(ROLES[pkgKey]);

            const db = readDB();
            db.packages.push({ 
                username: member.user.username, 
                packageName: pkgName, 
                staffId: interaction.user.id,
                staffName: interaction.user.username, 
                reason, 
                date: new Date().toLocaleString('ar-SA') 
            });
            writeDB(db);

            logAction('منح حزمة', `الإداري ${interaction.user.username} منح ${pkgName} للعضو ${member.user.username}`);

            const logCh = interaction.guild.channels.cache.get('1569431128430088222');
            if (logCh) logCh.send({ embeds: [new EmbedBuilder().setTitle('📦 منح حزمة').addFields({ name: 'الإداري', value: `${interaction.user}` }, { name: 'الشخص', value: `<@${uid}>` }, { name: 'الحزمة', value: pkgName }, { name: 'السبب', value: reason }).setColor(0x00FFCC)] });
            await interaction.reply({ content: '✅ تم إعطاء الحزمة وتحديث السجلات في الموقع بنجاح!', ephemeral: true });
        } catch (e) {
            await interaction.reply({ content: '❌ تأكد من صحة الآيدي والصلاحيات.', ephemeral: true });
        }
    }
});
packageClient.login(PACKAGE_BOT_TOKEN).catch(e => console.log('خطأ بوت الحزم:', e.message));

// 3. بوت التفعيل
const actClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers] });
actClient.once('ready', () => console.log(`[بوت التفعيل] شغال: ${actClient.user.tag}`));
actClient.on('messageCreate', async message => {
    if (message.author.bot || !message.guild) return;
    if (message.content === '!act') {
        const menu = new StringSelectMenuBuilder().setCustomId('sector_menu').setPlaceholder('اختر القطاع').addOptions([
            { label: 'الإدارة العامة لأمن الطرق', value: 'sec_1' },
            { label: 'الشرطة', value: 'pol_1' },
            { label: 'الإدارة العامة للمرور', value: 'traf_1' },
            { label: 'الإدارة العامة لدوريات الأمن', value: 'sf_1' }
        ]);
        await message.channel.send({ embeds: [new EmbedBuilder().setTitle('بوت التفعيل').setColor(0xCFB53B)], components: [new ActionRowBuilder().addComponents(menu)] });
        message.delete().catch(()=>{});
    }
});
actClient.on('interactionCreate', async interaction => {
    if (interaction.isStringSelectMenu() && interaction.customId === 'sector_menu') {
        const modal = new ModalBuilder().setCustomId(`modal_sec_${interaction.values[0]}`).setTitle('تفعيل لاعب');
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('did').setLabel('كوبي آيدي الشخص').setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('mil').setLabel('الاسم').setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('pname').setLabel('الكود العسكري').setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('page').setLabel('العمر').setStyle(TextInputStyle.Short).setRequired(true))
        );
        await interaction.showModal(modal);
    } else if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_sec_')) {
        const secKey = interaction.customId.replace('modal_sec_', '');
        const did = interaction.fields.getTextInputValue('did').trim();
        const mil = interaction.fields.getTextInputValue('mil');
        const pname = interaction.fields.getTextInputValue('pname');
        const page = interaction.fields.getTextInputValue('page');

        await interaction.deferReply({ ephemeral: true });
        try {
            const member = await interaction.guild.members.fetch(did);
            const ROLES = { 
                "sec_1": "1569400665539608648", 
                "pol_1": "1569400598540067006", 
                "traf_1": "1569400809245118494", 
                "sf_1": "1569400719654654002", 
                "agreed": "1569402699047243999",
                "not_agreed": "1569402893961011322"
            };
            const SECTOR_NAMES = { "sec_1": "أمن الطرق", "pol_1": "الشرطة", "traf_1": "المرور", "sf_1": "دوريات الأمن" };

            await member.roles.add(ROLES[secKey]);
            await member.roles.add(ROLES["agreed"]);

            if (ROLES["not_agreed"] && member.roles.cache.has(ROLES["not_agreed"])) {
                await member.roles.remove(ROLES["not_agreed"]);
            }

            const newNick = `${mil} | ${pname}`;
            await member.setNickname(newNick);

            const db = readDB();
            db.activations.push({ 
                username: member.user.username, 
                nickname: newNick, 
                sector: SECTOR_NAMES[secKey] || secKey, 
                staffId: interaction.user.id,
                staffName: interaction.user.username, 
                date: new Date().toLocaleString('ar-SA') 
            });
            writeDB(db);

            logAction('تفعيل لاعب', `الإداري ${interaction.user.username} قام بتفعيل العضو ${member.user.username} في قطاع ${SECTOR_NAMES[secKey]}`);

            const logCh = interaction.guild.channels.cache.get('1569418084391850055');
            if (logCh) logCh.send({ content: `العضو: ${member}\n\nالإداري: ${interaction.user}\n\nالعمر: ${page}\n\nالاسم الجديد: ${newNick}` });
            await interaction.editReply('✅ تم التفعيل وتسجيله في الموقع بنجاح!');
        } catch (e) {
            await interaction.editReply('❌ حدث خطأ، تأكد من الآيدي والصلاحيات.');
        }
    }
});
actClient.login(ACTIVATION_BOT_TOKEN).catch(e => console.log('خطأ بوت التفعيل:', e.message));

// 4. تشغيل الموقع الإلكتروني (Dashboard)
const app = express();
app.use(express.json());
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

function isAuthenticated(req) {
    const cookieHeader = req.headers.cookie || '';
    return cookieHeader.split(';').some(c => c.trim() === `dash_auth=${DASHBOARD_PASSCODE}`);
}

function isAuditAuthenticated(req) {
    const cookieHeader = req.headers.cookie || '';
    return cookieHeader.split(';').some(c => c.trim() === `audit_auth=${AUDIT_PASSCODE}`);
}

app.get('/', async (req, res) => {
    if (!isAuthenticated(req)) {
        return res.render('index', { authenticated: false, auditAuth: false, staffList: [], packages: [], activations: [], auditLogs: [] });
    }

    const db = readDB();
    const guild = mainClient.guilds.cache.first();
    const auditAuth = isAuditAuthenticated(req);

    const staffWithStats = await Promise.all(db.staff.map(async (s) => {
        const activationsCount = db.activations.filter(a => a.staffId === s.discordId).length;
        const packagesCount = db.packages.filter(p => p.staffId === s.discordId).length;

        let inSupport = false;
        let channelName = '';

        if (guild) {
            try {
                const member = await guild.members.fetch(s.discordId).catch(() => null);
                if (member && member.voice && member.voice.channelId) {
                    if (SUPPORT_CHANNELS.includes(member.voice.channelId)) {
                        inSupport = true;
                        channelName = member.voice.channel.name;
                    }
                }
            } catch (e) {}
        }

        return { ...s, activationsCount, packagesCount, inSupport, channelName };
    }));

    res.render('index', { 
        authenticated: true,
        auditAuth,
        staffList: staffWithStats, 
        packages: (db.packages || []).slice().reverse(), 
        activations: (db.activations || []).slice().reverse(),
        auditLogs: (db.auditLogs || []).slice().reverse()
    });
});

app.post('/api/login', (req, res) => {
    const { passcode } = req.body;
    if (passcode === DASHBOARD_PASSCODE) {
        res.setHeader('Set-Cookie', `dash_auth=${DASHBOARD_PASSCODE}; Path=/; HttpOnly; Max-Age=86400`);
        return res.json({ success: true });
    }
    res.status(401).json({ success: false, message: '❌ الرمز غير صحيح!' });
});

app.post('/api/logout', (req, res) => {
    res.setHeader('Set-Cookie', ['dash_auth=; Path=/; HttpOnly; Max-Age=0', 'audit_auth=; Path=/; HttpOnly; Max-Age=0']);
    res.json({ success: true });
});

app.post('/api/audit/login', (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ success: false });
    const { passcode } = req.body;
    if (passcode === AUDIT_PASSCODE) {
        res.setHeader('Set-Cookie', `audit_auth=${AUDIT_PASSCODE}; Path=/; HttpOnly; Max-Age=86400`);
        return res.json({ success: true });
    }
    res.status(401).json({ success: false, message: '❌ رمز سجل العمليات غير صحيح!' });
});

app.post('/api/staff/add', async (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ success: false });
    const { discordId } = req.body;
    
    let username = `User_${discordId}`;
    let avatar = 'https://cdn.discordapp.com/embed/avatars/0.png';

    const guild = mainClient.guilds.cache.first();
    if (guild) {
        try {
            const member = await guild.members.fetch(discordId);
            if (member) {
                username = member.user.globalName || member.user.username;
                if (member.user.avatar) {
                    avatar = `https://cdn.discordapp.com/avatars/${discordId}/${member.user.avatar}.png`;
                }
                if (STAFF_ROLE_ID) {
                    await member.roles.add(STAFF_ROLE_ID).catch(() => {});
                }
            }
        } catch (e) {
            try {
                const response = await axios.get(`https://discord.com/api/v10/users/${discordId}`, { headers: { Authorization: `Bot ${NEW_BOT_TOKEN}` } });
                const user = response.data;
                username = user.global_name || user.username;
                if (user.avatar) {
                    avatar = `https://cdn.discordapp.com/avatars/${discordId}/${user.avatar}.png`;
                }
            } catch (err) {}
        }
    }

    const db = readDB();
    if (!db.staff.find(s => s.discordId === discordId)) {
        db.staff.push({ discordId, username, avatar, totalMinutes: 0, sessions: [], fivemName: '', extraNotes: '' });
        writeDB(db);
        logAction('إضافة إداري', `تمت إضافة الإداري ${username} (${discordId})`);
    }
    res.json({ success: true });
});

app.post('/api/staff/details/:id', (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ success: false });
    const discordId = req.params.id;
    const { fivemName, extraNotes } = req.body;

    const db = readDB();
    const staff = db.staff.find(s => s.discordId === discordId);
    if (!staff) return res.status(404).json({ success: false });

    staff.fivemName = fivemName || '';
    staff.extraNotes = extraNotes || '';
    writeDB(db);

    logAction('تحديث تفاصيل', `تم تحديث تفاصيل الإداري ${staff.username} (اسم FiveM: ${fivemName || 'بدون'})`);
    res.json({ success: true });
});

app.post('/api/staff/reset/:id', (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ success: false });
    const discordId = req.params.id;
    const db = readDB();
    const staff = db.staff.find(s => s.discordId === discordId);
    if (!staff) return res.status(404).json({ success: false });

    staff.totalMinutes = 0;
    staff.sessions = [];
    if (activeSessions.has(discordId)) activeSessions.set(discordId, Date.now());
    writeDB(db);

    logAction('تصفير ساعات فردي', `تم تصفير ساعات الإداري ${staff.username}`);
    res.json({ success: true });
});

app.post('/api/staff/reset-all', (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ success: false });
    const db = readDB();
    db.staff.forEach(s => {
        s.totalMinutes = 0;
        s.sessions = [];
        if (activeSessions.has(s.discordId)) activeSessions.set(s.discordId, Date.now());
    });
    writeDB(db);

    logAction('تصفير ساعات جماعي', 'تم تصفير ساعات جميع الإداريين دفعة واحدة');
    res.json({ success: true });
});

app.delete('/api/staff/remove/:id', async (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ success: false });
    const discordId = req.params.id;
    const { action } = req.body || {};

    const db = readDB();
    const staff = db.staff.find(s => s.discordId === discordId);
    const staffName = staff ? staff.username : discordId;

    try {
        const guild = mainClient.guilds.cache.first();
        if (guild) {
            const member = await guild.members.fetch(discordId).catch(() => null);
            if (member) {
                if (STAFF_ROLE_ID && member.roles.cache.has(STAFF_ROLE_ID)) {
                    await member.roles.remove(STAFF_ROLE_ID).catch(() => {});
                }
                if (action === 'thanks' && THANKS_ROLE_ID) {
                    await member.roles.add(THANKS_ROLE_ID).catch(() => {});
                } else if (action === 'ban' && BANNED_STAFF_ROLE_ID) {
                    await member.roles.add(BANNED_STAFF_ROLE_ID).catch(() => {});
                }
            }
        }
    } catch (e) {}

    db.staff = db.staff.filter(s => s.discordId !== discordId);
    writeDB(db);

    const actionText = action === 'thanks' ? 'شكراً لخدمتك الإدارية' : action === 'ban' ? 'محظور من دخول الإدارة' : 'بدون رتبة إضافية';
    logAction('حذف إداري', `تم حذف الإداري ${staffName} ومنحه رتبة: (${actionText})`);

    res.json({ success: true });
});

app.listen(3000, () => {
    console.log('====================================');
    console.log('🌐 الموقع شغال الآن على الرابط:');
    console.log('👉 http://localhost:3000');
    console.log('🔑 رمز سجل العمليات السري:', AUDIT_PASSCODE);
    console.log('====================================');
});
