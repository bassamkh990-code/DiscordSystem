const { Client, GatewayIntentBits, ActionRowBuilder, StringSelectMenuBuilder, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits } = require('discord.js');
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.json');
const PORT = process.env.PORT || 3000;

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const GITHUB_DB_FILE = 'data.json';

let writeChain = Promise.resolve();
let githubSyncTimer = null;
let latestPendingJSON = null;

function defaultDB() {
    return { staff: [], packages: [], activations: [], auditLogs: [], blacklist: [] };
}

function normalizeDB(raw) {
    const base = raw && typeof raw === 'object' ? raw : {};
    return {
        staff: Array.isArray(base.staff) ? base.staff : [],
        packages: Array.isArray(base.packages) ? base.packages : [],
        activations: Array.isArray(base.activations) ? base.activations : [],
        auditLogs: Array.isArray(base.auditLogs) ? base.auditLogs : [],
        blacklist: Array.isArray(base.blacklist) ? base.blacklist : []
    };
}

function writeLocalDBSync(cleanData) {
    const serialized = JSON.stringify(cleanData, null, 2);
    fs.writeFileSync(DB_PATH, serialized, 'utf8');
    return serialized;
}

function readDB() {
    try {
        if (!fs.existsSync(DB_PATH)) {
            const def = defaultDB();
            writeLocalDBSync(def);
            return def;
        }
        const rawText = fs.readFileSync(DB_PATH, 'utf8');
        if (!rawText || !rawText.trim()) {
            const def = defaultDB();
            writeLocalDBSync(def);
            return def;
        }
        return normalizeDB(JSON.parse(rawText));
    } catch (e) {
        console.error('[DB Read Error]:', e.message);
        return defaultDB();
    }
}

function getGitHubHeaders() {
    return {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
    };
}

async function fetchDBFromGitHubOnStartup() {
    if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) return;

    try {
        const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_DB_FILE}?ref=${GITHUB_BRANCH}`;
        const res = await axios.get(apiUrl, { headers: getGitHubHeaders() });
        if (res.data && res.data.content) {
            const decoded = Buffer.from(res.data.content, 'base64').toString('utf8');
            const parsed = normalizeDB(JSON.parse(decoded));
            const hasRemoteData =
                parsed.staff.length > 0 ||
                parsed.packages.length > 0 ||
                parsed.activations.length > 0 ||
                parsed.auditLogs.length > 0 ||
                parsed.blacklist.length > 0;

            const currentLocal = readDB();
            const hasLocalData =
                currentLocal.staff.length > 0 ||
                currentLocal.packages.length > 0 ||
                currentLocal.activations.length > 0 ||
                currentLocal.auditLogs.length > 0 ||
                currentLocal.blacklist.length > 0;

            if (hasRemoteData || !hasLocalData) {
                writeLocalDBSync(parsed);
                console.log('[GitHub Sync] تمت مزامنة data.json من GitHub عند التشغيل.');
            }
        }
    } catch (e) {
        if (!e.response || e.response.status !== 404) {
            console.error('[GitHub Startup Fetch Error]:', e.message);
        }
    }
}

async function syncDBToGitHub(jsonString) {
    if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
        console.log('[GitHub Sync] ناقص GITHUB_TOKEN أو GITHUB_OWNER أو GITHUB_REPO.');
        return;
    }

    const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_DB_FILE}`;
    const headers = getGitHubHeaders();

    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            let sha;
            try {
                const existing = await axios.get(`${apiUrl}?ref=${GITHUB_BRANCH}`, { headers });
                sha = existing.data && existing.data.sha;
            } catch (err) {
                if (!err.response || err.response.status !== 404) {
                    throw err;
                }
            }

            const body = {
                message: 'Sync data.json from DiscordSystem',
                content: Buffer.from(jsonString, 'utf8').toString('base64'),
                branch: GITHUB_BRANCH
            };
            if (sha) body.sha = sha;

            await axios.put(apiUrl, body, { headers });
            console.log('[GitHub Sync] تم حفظ data.json في GitHub بنجاح.');
            return;
        } catch (err) {
            const status = err.response && err.response.status;
            if (status === 409 && attempt === 1) {
                continue;
            }
            const details = err.response && err.response.data
                ? JSON.stringify(err.response.data.message || err.response.data)
                : err.message;
            console.error('[GitHub Sync Failed]:', details);
            return;
        }
    }
}

function scheduleGitHubSync(jsonString) {
    latestPendingJSON = jsonString;
    if (githubSyncTimer) clearTimeout(githubSyncTimer);
    githubSyncTimer = setTimeout(() => {
        const toSync = latestPendingJSON;
        latestPendingJSON = null;
        if (toSync) {
            syncDBToGitHub(toSync);
        }
    }, 1000);
}

function writeDB(data) {
    const clean = normalizeDB(data);
    writeChain = writeChain
        .then(() => {
            const serialized = writeLocalDBSync(clean);
            scheduleGitHubSync(serialized);
        })
        .catch(e => {
            console.error('[DB Write Error]:', e.message);
        });
    return writeChain;
}

function formatClock(dateObj) {
    return dateObj.toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' });
}

// دالة لتسجيل العمليات تلقائياً
function logAction(action, details) {
    writeChain = writeChain
        .then(() => {
            const db = readDB();
            db.auditLogs.push({
                id: Date.now().toString() + '_' + Math.floor(Math.random() * 1000),
                action,
                details,
                date: new Date().toLocaleString('ar-SA')
            });
            if (db.auditLogs.length > 100) {
                db.auditLogs = db.auditLogs.slice(-100);
            }
            const serialized = writeLocalDBSync(db);
            scheduleGitHubSync(serialized);
        })
        .catch(e => {
            console.error('خطأ في تسجيل العملية:', e.message);
        });
    return writeChain;
}

const DASHBOARD_PASSCODE = '966123'; // رمز دخول اللوحة الرئيسية
const AUDIT_PASSCODE = '999888';     // رمز دخول سجل العمليات السري

// ==========================================
// 🔑 توكنات البوتات (تسحب بأمان من Render)
// ==========================================
const NEW_BOT_TOKEN = process.env.NEW_BOT_TOKEN;                   // توكن بوت الإدارة والساعات
const PACKAGE_BOT_TOKEN = process.env.PACKAGE_BOT_TOKEN;           // توكن بوت الحزم
const ACTIVATION_BOT_TOKEN = process.env.ACTIVATION_BOT_TOKEN;     // توكن بوت التفعيل

// ==========================================
// 📌 آيديات الرومات (Channels)
// ==========================================
const ATTENDANCE_LOG_CHANNEL = '1571824969103708210'; // روم سجلات دخول وخروج الإداريين
const SUPPORT_CHANNELS = [
    '1571825013680504953', // روم الدعم الصوتي الأول
    '1571825040335446147', // روم الدعم الصوتي الثاني
    '1571825068168978452'  // روم الدعم الصوتي الثالث
];

// ==========================================
// 🛡️ آيديات الرتب (Roles) الرئيسية
// ==========================================
const STAFF_ROLE_ID = '1572372027162103888';        // رتبة الإداري الأساسية
const THANKS_ROLE_ID = '1572372060012019792';        // رتبة شكر لخدمتك الإدارية (عند الحذف بقرار شكر)
const BANNED_STAFF_ROLE_ID = '1572372121827541012';  // رتبة محظور من دخول الإدارة (عند الحذف بقرار حظر)

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
        const joinTs = Date.now();
        activeSessions.set(member.id, {
            startTime: joinTs,
            channelName: newState.channel ? newState.channel.name : 'روم الدعم'
        });
        if (logChannel) {
            logChannel.send({ embeds: [new EmbedBuilder().setColor(0x00FF00).setDescription(`🟢 **دخول إداري**\nالإداري: <@${member.id}>\nالروم: **${newState.channel.name}**`)] }).catch(()=>{});
        }
    }
    else if (SUPPORT_CHANNELS.includes(oldChannel) && !SUPPORT_CHANNELS.includes(newChannel)) {
        if (activeSessions.has(member.id)) {
            const sessionInfo = activeSessions.get(member.id);
            const startTime = typeof sessionInfo === 'object' ? sessionInfo.startTime : sessionInfo;
            const channelName = typeof sessionInfo === 'object' ? sessionInfo.channelName : (oldState.channel ? oldState.channel.name : 'روم الدعم');

            const endDate = new Date();
            const startDate = new Date(startTime);
            const diffMins = Math.max(0, Math.floor((endDate.getTime() - startTime) / 60000));
            const today = new Date().toISOString().split('T')[0];

            if (!Array.isArray(staff.sessions)) staff.sessions = [];
            if (!Array.isArray(staff.sessionLogs)) staff.sessionLogs = [];

            staff.sessionLogs.push({
                id: Date.now().toString() + '_' + Math.floor(Math.random() * 1000),
                date: today,
                channelName,
                joinTime: formatClock(startDate),
                leaveTime: formatClock(endDate),
                minutes: diffMins
            });
            if (staff.sessionLogs.length > 60) {
                staff.sessionLogs = staff.sessionLogs.slice(-60);
            }

            if (diffMins > 0) {
                staff.totalMinutes = (Number(staff.totalMinutes) || 0) + diffMins;
                let sess = staff.sessions.find(s => s.date === today);
                if (sess) {
                    sess.minutes = (Number(sess.minutes) || 0) + diffMins;
                } else {
                    staff.sessions.push({ date: today, minutes: diffMins });
                }
            }

            await writeDB(db);
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
            await writeDB(db);
            await logAction('منح حزمة', `الإداري ${interaction.user.username} منح ${pkgName} للعضو ${member.user.username}`);

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

        // التحقق من وجود الآيدي في البلاك ليست قبل التفعيل
        const checkDB = readDB();
        const blacklistedUser = (checkDB.blacklist || []).find(b => b.discordId === did);
        if (blacklistedUser) {
            await logAction('رفض تفعيل (بلاك ليست)', `تم رفض تفعيل الآيدي (${did}) بواسطة الإداري ${interaction.user.username} لأنه مدرج في البلاك ليست`);
            return interaction.editReply(`🚫 **مرفوض — الشخص بلاك ليست!**\nالآيدي: \`${did}\`${blacklistedUser.reason ? `\nالسبب: ${blacklistedUser.reason}` : ''}`);
        }

        try {
            const member = await interaction.guild.members.fetch(did);

            // ==========================================
            // 🛡️ رتب التفعيل والقطاعات العسكرية
            // ==========================================
            const ROLES = {
                "sec_1": "1569400665539608648",      // رتبة قطاع: الإدارة العامة لأمن الطرق
                "pol_1": "1569400598540067006",      // رتبة قطاع: الشرطة
                "traf_1": "1569400809245118494",     // رتبة قطاع: الإدارة العامة للمرور
                "sf_1": "1569400719654654002",       // رتبة قطاع: الإدارة العامة لدوريات الأمن
                "agreed": "1569402699047243999",     // رتبة الموافقة (تُعطى عند إتمام التفعيل)
                "not_agreed": "1569402893961011322"  // رتبة عدم الموافقة (تُزال تلقائياً عند التفعيل إن وجدت)
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
            await writeDB(db);
            await logAction('تفعيل لاعب', `الإداري ${interaction.user.username} قام بتفعيل العضو ${member.user.username} في قطاع ${SECTOR_NAMES[secKey]}`);

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
app.use(express.static(path.join(__dirname, 'public')));
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
        return res.render('index', { authenticated: false, auditAuth: false, staffList: [], packages: [], activations: [], auditLogs: [], blacklist: [] });
    }

    const db = readDB();
    const guild = mainClient.guilds.cache.first();
    const auditAuth = isAuditAuthenticated(req);

    const staffWithStats = await Promise.all(db.staff.map(async (s) => {
        const activationsCount = db.activations.filter(a => a.staffId === s.discordId).length;
        const packagesCount = db.packages.filter(p => p.staffId === s.discordId).length;

        let inSupport = false;
        let channelName = '';
        let activeJoinClock = '';

        if (activeSessions.has(s.discordId)) {
            const sessInfo = activeSessions.get(s.discordId);
            const st = typeof sessInfo === 'object' ? sessInfo.startTime : sessInfo;
            activeJoinClock = formatClock(new Date(st));
        }

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

        return {
            ...s,
            sessionLogs: (s.sessionLogs || []).slice().reverse(),
            activationsCount,
            packagesCount,
            inSupport,
            channelName,
            activeJoinClock
        };
    }));

    res.render('index', {
        authenticated: true,
        auditAuth,
        staffList: staffWithStats,
        packages: (db.packages || []).slice().reverse(),
        activations: (db.activations || []).slice().reverse(),
        auditLogs: (db.auditLogs || []).slice().reverse(),
        blacklist: (db.blacklist || []).slice().reverse()
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

// إدارة البلاك ليست
app.post('/api/blacklist/add', async (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ success: false });
    const discordId = (req.body.discordId || '').trim();
    const reason = (req.body.reason || '').trim();
    if (!discordId) return res.status(400).json({ success: false, message: 'الرجاء إدخال الآيدي' });

    let username = `User_${discordId}`;
    try {
        const response = await axios.get(`https://discord.com/api/v10/users/${discordId}`, { headers: { Authorization: `Bot ${ACTIVATION_BOT_TOKEN || NEW_BOT_TOKEN}` } });
        const user = response.data;
        username = user.global_name || user.username;
    } catch (e) {}

    const db = readDB();
    if (!db.blacklist) db.blacklist = [];
    if (db.blacklist.find(b => b.discordId === discordId)) {
        return res.status(400).json({ success: false, message: 'هذا الآيدي مضاف مسبقاً في البلاك ليست' });
    }

    db.blacklist.push({
        discordId,
        username,
        reason,
        date: new Date().toLocaleString('ar-SA')
    });
    await writeDB(db);
    await logAction('إضافة بلاك ليست', `تمت إضافة (${username} - ${discordId}) إلى البلاك ليست${reason ? ` | السبب: ${reason}` : ''}`);
    res.json({ success: true });
});

app.delete('/api/blacklist/remove/:id', async (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ success: false });
    const discordId = req.params.id;
    const db = readDB();
    const entry = (db.blacklist || []).find(b => b.discordId === discordId);
    db.blacklist = (db.blacklist || []).filter(b => b.discordId !== discordId);
    await writeDB(db);
    await logAction('إزالة بلاك ليست', `تمت إزالة (${entry ? entry.username : discordId} - ${discordId}) من البلاك ليست`);
    res.json({ success: true });
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
        db.staff.push({ discordId, username, avatar, totalMinutes: 0, sessions: [], sessionLogs: [], fivemName: '', extraNotes: '' });
        await writeDB(db);
        await logAction('إضافة إداري', `تمت إضافة الإداري ${username} (${discordId})`);
    }
    res.json({ success: true });
});

app.post('/api/staff/details/:id', async (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ success: false, message: 'غير مصرح' });
    const discordId = String(req.params.id || '').trim();
    const { fivemName, extraNotes, adjustMinutes, adjustReason } = req.body || {};

    const db = readDB();
    const staff = db.staff.find(s => String(s.discordId) === discordId);
    if (!staff) return res.status(404).json({ success: false, message: 'الإداري غير موجود' });

    staff.fivemName = typeof fivemName === 'string' ? fivemName.trim() : (staff.fivemName || '');
    staff.extraNotes = typeof extraNotes === 'string' ? extraNotes.trim() : (staff.extraNotes || '');

    const rawMins = adjustMinutes === undefined || adjustMinutes === null ? '' : String(adjustMinutes).trim();
    const deltaMins = rawMins !== '' ? parseInt(rawMins, 10) : 0;

    let timeAdjusted = false;
    let signText = '';

    if (!isNaN(deltaMins) && deltaMins !== 0) {
        const currentTotal = Number(staff.totalMinutes) || 0;
        staff.totalMinutes = Math.max(0, currentTotal + deltaMins);

        const today = new Date().toISOString().split('T')[0];
        if (!Array.isArray(staff.sessions)) staff.sessions = [];
        let sess = staff.sessions.find(s => s.date === today);
        if (sess) {
            sess.minutes = Math.max(0, (Number(sess.minutes) || 0) + deltaMins);
        } else if (deltaMins > 0) {
            staff.sessions.push({ date: today, minutes: deltaMins });
        }

        timeAdjusted = true;
        signText = deltaMins > 0 ? `+${deltaMins}` : `${deltaMins}`;
    }

    await writeDB(db);

    if (timeAdjusted) {
        const reasonText = adjustReason && String(adjustReason).trim() ? ` | السبب: ${String(adjustReason).trim()}` : '';
        await logAction('تعديل ساعات يدوي', `تم تعديل دقائق الإداري ${staff.username} بمقدار (${signText} دقيقة)${reasonText}`);
    }

    await logAction('تحديث تفاصيل', `تم تحديث تفاصيل الإداري ${staff.username} (اسم FiveM: ${staff.fivemName || 'بدون'})`);
    res.json({ success: true, totalMinutes: staff.totalMinutes });
});

app.post('/api/staff/reset/:id', async (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ success: false });
    const discordId = req.params.id;
    const db = readDB();
    const staff = db.staff.find(s => s.discordId === discordId);
    if (!staff) return res.status(404).json({ success: false });

    staff.totalMinutes = 0;
    staff.sessions = [];
    staff.sessionLogs = [];
    if (activeSessions.has(discordId)) {
        const prev = activeSessions.get(discordId);
        activeSessions.set(discordId, {
            startTime: Date.now(),
            channelName: typeof prev === 'object' ? prev.channelName : 'روم الدعم'
        });
    }
    await writeDB(db);
    await logAction('تصفير ساعات فردي', `تم تصفير ساعات وجلسات الإداري ${staff.username}`);
    res.json({ success: true });
});

app.post('/api/staff/reset-all', async (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ success: false });
    const db = readDB();
    db.staff.forEach(s => {
        s.totalMinutes = 0;
        s.sessions = [];
        s.sessionLogs = [];
        if (activeSessions.has(s.discordId)) {
            const prev = activeSessions.get(s.discordId);
            activeSessions.set(s.discordId, {
                startTime: Date.now(),
                channelName: typeof prev === 'object' ? prev.channelName : 'روم الدعم'
            });
        }
    });
    await writeDB(db);
    await logAction('تصفير ساعات جماعي', 'تم تصفير ساعات وجلسات جميع الإداريين دفعة واحدة');
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
    await writeDB(db);

    const actionText = action === 'thanks' ? 'شكراً لخدمتك الإدارية' : action === 'ban' ? 'محظور من دخول الإدارة' : 'بدون رتبة إضافية';
    await logAction('حذف إداري', `تم حذف الإداري ${staffName} ومنحه رتبة: (${actionText})`);

    res.json({ success: true });
});

app.listen(PORT, async () => {
    readDB();
    await fetchDBFromGitHubOnStartup();
    console.log('====================================');
    console.log(`🌐 الموقع شغال الآن على البورت: ${PORT}`);
    console.log('🔑 رمز سجل العمليات السري:', AUDIT_PASSCODE);
    console.log('====================================');
});
