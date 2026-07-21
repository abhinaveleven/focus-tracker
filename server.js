const express = require('express');
const { PrismaClient } = require('@prisma/client');
const path = require('path');
const fs = require('fs');
const auth = require('./auth');

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(express.json());
app.use(auth.attachUser);

// Seed data on startup
const defaultCategories = [
    { name: 'work', color: '#378ADD' },
    { name: 'gym', color: '#4ade80' },
    { name: 'study', color: '#a78bfa' },
    { name: 'creative', color: '#fb923c' },
    { name: 'other', color: '#6b7280' }
];

async function deduplicateCategories() {
    try {
        const allCategories = await prisma.category.findMany();
        const seen = new Set();
        for (const cat of allCategories) {
            const key = `${cat.userId}-${cat.name.toLowerCase()}`;
            if (seen.has(key)) {
                await prisma.category.delete({ where: { id: cat.id } });
                console.log(`Deleted duplicate category: ${cat.name} for user ${cat.userId}`);
            } else {
                seen.add(key);
            }
        }
    } catch (e) {
        console.error('Failed to deduplicate categories', e);
    }
}

async function seedUsersAndCategories() {
    try {
        await deduplicateCategories();
        
        let defaultUser = await prisma.user.findUnique({ where: { name: 'abhinav' } });
        if (!defaultUser) {
            defaultUser = await prisma.user.upsert({
                where: { id: 1 },
                update: {},
                create: { id: 1, name: 'abhinav' }
            });
            console.log('Seeded default user abhinav.');
        }

        // Seeding writes an explicit id, which leaves the Postgres sequence
        // behind and makes the next inserted user collide on the primary key.
        await prisma.$executeRawUnsafe(
            `SELECT setval(pg_get_serial_sequence('"User"', 'id'), COALESCE((SELECT MAX(id) FROM "User"), 1))`
        );

        // Lock the owner profile on first boot when OWNER_PASSWORD is supplied,
        // so the app is never publicly readable between deploy and first login.
        if (process.env.OWNER_PASSWORD) {
            const owner = await prisma.user.findUnique({ where: { name: 'abhinav' } });
            if (owner && (!owner.password || !owner.password.startsWith('scrypt$'))) {
                await prisma.user.update({
                    where: { id: owner.id },
                    data: { password: auth.hashPassword(process.env.OWNER_PASSWORD) }
                });
                console.log('Owner profile locked from OWNER_PASSWORD.');
            }
        }

        const catCount = await prisma.category.count();
        if (catCount === 0) {
            for (const cat of defaultCategories) {
                const existing = await prisma.category.findFirst({
                    where: { userId: defaultUser.id, name: cat.name }
                });
                if (!existing) {
                    await prisma.category.create({
                        data: { name: cat.name, color: cat.color, userId: defaultUser.id }
                    });
                }
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
        activeTimers[userIdStr] = { state: 'idle', elapsed: 0, startTs: null, absoluteStartTs: null, category: null, pausedAt: null, note: '', lastModified: Date.now() };
    }
    return activeTimers[userIdStr];
}

// 1. Serve Static Files
app.use(express.static(path.join(__dirname, 'public')));

// Users API
// The profile list is what the lock screen picks from, so it stays readable.
// It exposes only names and whether each profile is locked - never any data.
app.get('/api/users', async (req, res) => {
    const users = await prisma.user.findMany();
    res.json(users.map(u => ({ id: u.id, name: u.name, hasPassword: !!u.password })));
});

app.get('/api/users/me', async (req, res) => {
    if (!req.userId) return res.status(401).json({ error: 'Not signed in' });
    const u = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!u) return res.status(401).json({ error: 'Not signed in' });
    res.json({ id: u.id, name: u.name, hasPassword: !!u.password });
});

app.post('/api/users', auth.requireAuth, async (req, res) => {
    const { name, password } = req.body;
    try {
        const u = await prisma.user.create({
            data: { name, password: password ? auth.hashPassword(password) : null }
        });
        res.json({ id: u.id, name: u.name });
    } catch (e) {
        res.status(400).json({ error: 'Failed to create user. Name might be taken.' });
    }
});

app.post('/api/users/login', async (req, res) => {
    const { id, password } = req.body;
    const u = await prisma.user.findUnique({ where: { id: parseInt(id) } });
    if (!u) return res.status(401).json({ error: 'Invalid password' });

    const { ok, needsUpgrade } = auth.verifyPassword(password, u.password);
    if (!ok) return res.status(401).json({ error: 'Invalid password' });

    // Transparently re-store legacy plaintext passwords as scrypt hashes.
    if (needsUpgrade) {
        await prisma.user.update({
            where: { id: u.id },
            data: { password: auth.hashPassword(password || '') }
        });
    }

    auth.setSessionCookie(req, res, u.id);
    res.json({ success: true, id: u.id, name: u.name });
});

app.post('/api/users/logout', (req, res) => {
    auth.clearSessionCookie(res);
    res.json({ success: true });
});

// Set or change the password on your own profile. Requires the current one
// once a profile is locked.
app.post('/api/users/password', auth.requireAuth, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const u = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!u) return res.status(401).json({ error: 'Not signed in' });

    if (u.password && !auth.verifyPassword(currentPassword, u.password).ok) {
        return res.status(401).json({ error: 'Current password is incorrect' });
    }
    if (!newPassword) return res.status(400).json({ error: 'New password required' });

    await prisma.user.update({
        where: { id: u.id },
        data: { password: auth.hashPassword(newPassword) }
    });
    auth.setSessionCookie(req, res, u.id);
    res.json({ success: true });
});

// Sessions API - the signed-in user is the only user these can touch.
app.get('/api/sessions', auth.requireAuth, async (req, res) => {
    const sessions = await prisma.session.findMany({
        where: { userId: req.userId },
        orderBy: { ts: 'desc' },
    });
    res.json(sessions);
});

app.post('/api/sessions', auth.requireAuth, async (req, res) => {
    const { category, duration, note, startTime } = req.body;
    const newSession = await prisma.session.create({
        data: {
            userId: req.userId,
            category,
            duration: parseInt(duration),
            note,
            ts: new Date(),
            startTime: startTime ? new Date(startTime) : new Date(),
        },
    });
    res.json(newSession);
});

app.put('/api/sessions/:id', auth.requireAuth, async (req, res) => {
    const { note } = req.body;
    const { count } = await prisma.session.updateMany({
        where: { id: parseInt(req.params.id), userId: req.userId },
        data: { note }
    });
    if (!count) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
});

app.delete('/api/sessions/:id', auth.requireAuth, async (req, res) => {
    const { count } = await prisma.session.deleteMany({
        where: { id: parseInt(req.params.id), userId: req.userId }
    });
    if (!count) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
});

// Categories API
app.get('/api/categories', auth.requireAuth, async (req, res) => {
    const categories = await prisma.category.findMany({ where: { userId: req.userId } });
    res.json(categories);
});

app.post('/api/categories', auth.requireAuth, async (req, res) => {
    try {
        const { name, color } = req.body;

        const existing = await prisma.category.findFirst({
            where: { userId: req.userId, name }
        });
        if (existing) {
            return res.json(existing);
        }

        const cat = await prisma.category.create({ data: { name, color, userId: req.userId } });
        res.json(cat);
    } catch (e) {
        res.status(400).json({ error: 'Failed to create category' });
    }
});

app.delete('/api/categories/:id', auth.requireAuth, async (req, res) => {
    const { count } = await prisma.category.deleteMany({
        where: { id: parseInt(req.params.id), userId: req.userId }
    });
    if (!count) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
});

// Timer API
app.get('/api/timer', auth.requireAuth, (req, res) => {
    res.json(getTimer(String(req.userId)));
});

app.post('/api/timer', auth.requireAuth, (req, res) => {
    const { state, elapsed, startTs, absoluteStartTs, pausedAt, category, note } = req.body;
    const key = String(req.userId);

    activeTimers[key] = { state, elapsed, startTs, absoluteStartTs, pausedAt, category, note, lastModified: Date.now() };
    lastFlush = 0; flushTimers(); // Force flush immediately on state saves
    res.json({ success: true, lastModified: activeTimers[key].lastModified });
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
                            startTime: t.absoluteStartTs ? new Date(t.absoluteStartTs) : new Date(),
                        },
                    });
                    
                    if (t.state === 'running') {
                        t.elapsed = 0;
                        t.startTs = Date.now();
                        t.absoluteStartTs = Date.now();
                    } else {
                        t.state = 'idle';
                        t.elapsed = 0;
                        t.startTs = null;
                        t.absoluteStartTs = null;
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
                                ts: new Date(t.pausedAt),
                                startTime: t.absoluteStartTs ? new Date(t.absoluteStartTs) : new Date(t.pausedAt - durationSecs * 1000)
                            }
                        });
                    } catch (e) {
                        console.error("Failed pause auto-save", e);
                    }
                }
                t.state = 'idle';
                t.elapsed = 0;
                t.startTs = null;
                t.absoluteStartTs = null;
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