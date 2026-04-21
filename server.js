const express = require('express');
const { PrismaClient } = require('@prisma/client');
const path = require('path');

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

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

// 5. In-Memory Active Timer State
let activeTimer = { running: false, elapsed: 0, startTs: null, category: null, lastModified: 0 };

app.get('/api/timer', (req, res) => {
    res.json(activeTimer);
});

app.post('/api/timer', (req, res) => {
    activeTimer = { ...req.body, lastModified: Date.now() };
    res.json({ success: true, lastModified: activeTimer.lastModified });
});

// Route everything else to index.html
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});