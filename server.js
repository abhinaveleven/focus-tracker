const express = require('express');
const { PrismaClient } = require('@prisma/client');
const path = require('path');

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Seed categories on startup
const defaultCategories = [
    { name: 'work', color: '#378ADD' },
    { name: 'gym', color: '#4ade80' },
    { name: 'study', color: '#a78bfa' },
    { name: 'creative', color: '#fb923c' },
    { name: 'other', color: '#6b7280' }
];

async function seedCategories() {
    try {
        const count = await prisma.category.count();
        if (count === 0) {
            for (const cat of defaultCategories) {
                await prisma.category.create({ data: cat });
            }
            console.log('Seeded default categories.');
        }
    } catch (e) {
        console.error('Failed to seed categories.', e);
    }
}
seedCategories();

// 1. Serve Static Files (The Frontend)
app.use(express.static(path.join(__dirname, 'public')));

// 2. API: Get all sessions
app.get('/api/sessions', async (req, res) => {
    const sessions = await prisma.session.findMany({
        orderBy: { ts: 'desc' },
    });
    res.json(sessions);
});

// 3. API: Save a session
app.post('/api/sessions', async (req, res) => {
    const { category, duration } = req.body;
    const newSession = await prisma.session.create({
        data: {
            category,
            duration: parseInt(duration),
            ts: new Date(),
        },
    });
    res.json(newSession);
});

// 4. API: Delete a session
app.delete('/api/sessions/:id', async (req, res) => {
    await prisma.session.delete({ where: { id: parseInt(req.params.id) } });
    res.json({ success: true });
});

// API: Category CRUD
app.get('/api/categories', async (req, res) => {
    const categories = await prisma.category.findMany();
    res.json(categories);
});

app.post('/api/categories', async (req, res) => {
    try {
        const { name, color } = req.body;
        const cat = await prisma.category.create({ data: { name, color } });
        res.json(cat);
    } catch (e) {
        res.status(400).json({ error: 'Failed to create category' });
    }
});

app.delete('/api/categories/:id', async (req, res) => {
    try {
        await prisma.category.delete({ where: { id: parseInt(req.params.id) } });
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: 'Failed to delete category' });
    }
});

// 5. In-Memory Active Timer State
// state: 'idle' | 'running' | 'paused' | 'stopped'
let activeTimer = { state: 'idle', elapsed: 0, startTs: null, category: null, pausedAt: null, lastModified: Date.now() };

app.get('/api/timer', (req, res) => {
    res.json(activeTimer);
});

app.post('/api/timer', (req, res) => {
    activeTimer = { ...req.body, lastModified: Date.now() };
    res.json({ success: true, lastModified: activeTimer.lastModified });
});

// Background Task: Auto-save logic
setInterval(async () => {
    const now = new Date();
    // 11:59 PM auto-save logic
    const is1159PM = now.getHours() === 23 && now.getMinutes() === 59 && now.getSeconds() === 0;

    if (is1159PM) {
        let durationToSave = activeTimer.elapsed;
        if (activeTimer.state === 'running' && activeTimer.startTs) {
            durationToSave += Date.now() - activeTimer.startTs;
        }

        const durationSecs = Math.floor(durationToSave / 1000);
        
        if (durationSecs > 0 && activeTimer.category) {
            try {
                await prisma.session.create({
                    data: {
                        category: activeTimer.category,
                        duration: durationSecs,
                        ts: new Date(),
                    },
                });
                console.log('Saved session at 11:59 PM');
                
                if (activeTimer.state === 'running') {
                    // rolling over into the new day
                    activeTimer.elapsed = 0;
                    activeTimer.startTs = Date.now();
                } else {
                    activeTimer.state = 'idle';
                    activeTimer.elapsed = 0;
                    activeTimer.startTs = null;
                    activeTimer.pausedAt = null;
                }
                activeTimer.lastModified = Date.now();
            } catch (e) {
                console.error("Failed 11:59PM auto-save", e);
            }
        }
    }

    // 20-minute pause auto-save logic
    if (activeTimer.state === 'paused' && activeTimer.pausedAt) {
        const pausedFor = Date.now() - activeTimer.pausedAt;
        if (pausedFor >= 20 * 60 * 1000) { // 20 minutes
            const durationSecs = Math.floor(activeTimer.elapsed / 1000);
            if (durationSecs > 0 && activeTimer.category) {
                try {
                    await prisma.session.create({
                        data: {
                            category: activeTimer.category,
                            duration: durationSecs,
                            ts: new Date()
                        }
                    });
                    console.log('Auto-saved paused session after 20 mins');
                } catch (e) {
                    console.error("Failed pause auto-save", e);
                }
            }
            activeTimer.state = 'idle';
            activeTimer.elapsed = 0;
            activeTimer.startTs = null;
            activeTimer.pausedAt = null;
            activeTimer.lastModified = Date.now();
        }
    }
}, 1000);

// Route everything else to index.html
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});