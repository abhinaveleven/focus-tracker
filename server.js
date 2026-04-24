const express = require('express');
const { PrismaClient } = require('@prisma/client');
const path = require('path');
const fs = require('fs');

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Seed data on startup
const defaultCategories = [
    { name: 'work', color: '#378ADD' },
    { name: 'gym', color: '#4ade80' },
    { name: 'study', color: '#a78bfa' },
    { name: 'creative', color: '#fb923c' },
    { name: 'other', color: '#6b7280' }
];

async function seedUsersAndCategories() {
    try {
        let defaultUser = await prisma.user.findUnique({ where: { name: 'abhinav' } });
        if (!defaultUser) {
            defaultUser = await prisma.user.upsert({
                where: { id: 1 },
                update: {},
                create: { id: 1, name: 'abhinav' }
            });
            console.log('Seeded default user abhinav.');
        }

        const catCount = await prisma.category.count();
        if (catCount === 0) {
            for (const cat of defaultCategories) {
                await prisma.category.upsert({
                    where: { userId_name: { userId: defaultUser.id, name: cat.name } },
                    update: {},
                    create: { name: cat.name, color: cat.color, userId: defaultUser.id }
                });
            }
            console.log('Seeded default categories for abhinav.');
        }
    } catch (e) {
        console.error('Failed to seed DB.', e);
    }
}
seedUsersAndCategories();

// Active Timer Persistence
let activeTimers = {};
const TIMERS_FILE = path.join(__dirname, 'active_timers.json');

try {
    if (fs.existsSync(TIMERS_FILE)) {
        const raw = fs.readFileSync(TIMERS_FILE, 'utf8');
        activeTimers = JSON.parse(raw);
        console.log('Loaded timer states from disk');
    }
} catch (e) {
    console.error("Failed to load active timers", e);
}

let lastFlush = 0;
function flushTimers() {
    if (Date.now() - lastFlush < 4000) return;
    lastFlush = Date.now();
    fs.writeFile(TIMERS_FILE, JSON.stringify(activeTimers), () => {});
}

function getTimer(userIdStr) {
    if (!activeTimers[userIdStr]) {
        activeTimers[userIdStr] = { state: 'idle', elapsed: 0, startTs: null, category: null, pausedAt: null, note: '', lastModified: Date.now() };
    }
    return activeTimers[userIdStr];
}

// 1. Serve Static Files
app.use(express.static(path.join(__dirname, 'public')));

// Users API
app.get('/api/users', async (req, res) => {
    const users = await prisma.user.findMany();
    res.json(users.map(u => ({ id: u.id, name: u.name, hasPassword: !!u.password })));
});

app.post('/api/users', async (req, res) => {
    const { name, password } = req.body;
    try {
        const u = await prisma.user.create({ data: { name, password } });
        res.json({ id: u.id, name: u.name });
    } catch (e) {
        res.status(400).json({ error: 'Failed to create user. Name might be taken.' });
    }
});

app.post('/api/users/login', async (req, res) => {
    const { id, password } = req.body;
    const u = await prisma.user.findUnique({ where: { id: parseInt(id) } });
    if (!u) return res.status(404).json({ error: 'User not found' });
    if (u.password && u.password !== password) return res.status(401).json({ error: 'Invalid password' });
    res.json({ success: true, id: u.id, name: u.name });
});

// Sessions API
app.get('/api/sessions', async (req, res) => {
    const userId = parseInt(req.query.userId);
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const sessions = await prisma.session.findMany({
        where: { userId },
        orderBy: { ts: 'desc' },
    });
    res.json(sessions);
});

app.post('/api/sessions', async (req, res) => {
    const { category, duration, note, userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const newSession = await prisma.session.create({
        data: {
            userId: parseInt(userId),
            category,
            duration: parseInt(duration),
            note,
            ts: new Date(),
        },
    });
    res.json(newSession);
});

app.put('/api/sessions/:id', async (req, res) => {
    const { note } = req.body;
    const updated = await prisma.session.update({
        where: { id: parseInt(req.params.id) },
        data: { note }
    });
    res.json(updated);
});

app.delete('/api/sessions/:id', async (req, res) => {
    await prisma.session.delete({ where: { id: parseInt(req.params.id) } });
    res.json({ success: true });
});

// Categories API
app.get('/api/categories', async (req, res) => {
    const userId = parseInt(req.query.userId);
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const categories = await prisma.category.findMany({ where: { userId } });
    res.json(categories);
});

app.post('/api/categories', async (req, res) => {
    try {
        const { name, color, userId } = req.body;
        if (!userId) return res.status(400).json({ error: 'userId required' });
        const cat = await prisma.category.create({ data: { name, color, userId: parseInt(userId) } });
        res.json(cat);
    } catch (e) {
        res.status(400).json({ error: 'Failed to create category' });
    }
});

app.delete('/api/categories/:id', async (req, res) => {
    await prisma.category.delete({ where: { id: parseInt(req.params.id) } });
    res.json({ success: true });
});

// Timer API
app.get('/api/timer', (req, res) => {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    res.json(getTimer(userId));
});

app.post('/api/timer', (req, res) => {
    const { userId, state, elapsed, startTs, pausedAt, category, note } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    
    activeTimers[userId] = { state, elapsed, startTs, pausedAt, category, note, lastModified: Date.now() };
    lastFlush = 0; flushTimers(); // Force flush immediately on state saves
    res.json({ success: true, lastModified: activeTimers[userId].lastModified });
});

// Background Task: Auto-save logic
setInterval(async () => {
    const now = new Date();
    const is1159PM = now.getHours() === 23 && now.getMinutes() === 59 && now.getSeconds() === 0;

    for (const [uidStr, t] of Object.entries(activeTimers)) {
        const userId = parseInt(uidStr);
        
        if (is1159PM) {
            let durationToSave = t.elapsed;
            if (t.state === 'running' && t.startTs) {
                durationToSave += Date.now() - t.startTs;
            }

            const durationSecs = Math.floor(durationToSave / 1000);
            
            if (durationSecs > 0 && t.category) {
                try {
                    await prisma.session.create({
                        data: {
                            userId,
                            category: t.category,
                            duration: durationSecs,
                            note: t.note,
                            ts: new Date(),
                        },
                    });
                    
                    if (t.state === 'running') {
                        t.elapsed = 0;
                        t.startTs = Date.now();
                    } else {
                        t.state = 'idle';
                        t.elapsed = 0;
                        t.startTs = null;
                        t.pausedAt = null;
                        t.note = '';
                    }
                    t.lastModified = Date.now();
                } catch (e) {
                    console.error("Failed 11:59PM auto-save", e);
                }
            }
        }

        // 20-minute pause auto-save
        if (t.state === 'paused' && t.pausedAt) {
            const pausedFor = Date.now() - t.pausedAt;
            if (pausedFor >= 20 * 60 * 1000) {
                const durationSecs = Math.floor(t.elapsed / 1000);
                if (durationSecs > 0 && t.category) {
                    try {
                        await prisma.session.create({
                            data: {
                                userId,
                                category: t.category,
                                duration: durationSecs,
                                note: t.note,
                                ts: new Date()
                            }
                        });
                    } catch (e) {
                        console.error("Failed pause auto-save", e);
                    }
                }
                t.state = 'idle';
                t.elapsed = 0;
                t.startTs = null;
                t.pausedAt = null;
                t.note = '';
                t.lastModified = Date.now();
            }
        }
    }
    flushTimers();
}, 1000);

// Route everything else
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));