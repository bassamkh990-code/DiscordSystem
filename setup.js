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

// دالة لتسجيل العمليات تلقائياً
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

const DASHBOARD_PASSCODE = '966123'; // رمز دخول اللوحة الرئيسية
const AUDIT_PASSCODE = '999888';     // رمز دخول سجل العمليات السري

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
const packageClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
