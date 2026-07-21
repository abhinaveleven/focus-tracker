const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const COOKIE_NAME = 'ft_session';
const SESSION_DAYS = 30;

// Secret for signing session cookies. Prefer SESSION_SECRET so sessions survive
// a rebuild; fall back to a generated one persisted next to the app.
function loadSecret() {
    if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
    const file = path.join(__dirname, '.session_secret');
    try {
        if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
    } catch (e) { /* fall through to regenerate */ }
    const generated = crypto.randomBytes(32).toString('hex');
    try {
        fs.writeFileSync(file, generated, { mode: 0o600 });
    } catch (e) {
        console.warn('Could not persist session secret; sessions reset on restart.');
    }
    return generated;
}
const SECRET = loadSecret();

function hashPassword(pw) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
    return `scrypt$${salt}$${hash}`;
}

function safeEqual(a, b) {
    const ab = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
}

// Returns { ok, needsUpgrade }. A profile with no password stored is open, and
// only accepts an empty password. Legacy plaintext rows still verify, and are
// flagged so the caller can rewrite them as a hash.
function verifyPassword(pw, stored) {
    const supplied = pw || '';
    if (!stored) return { ok: supplied === '', needsUpgrade: false };
    if (stored.startsWith('scrypt$')) {
        const [, salt, hash] = stored.split('$');
        const candidate = crypto.scryptSync(supplied, salt, 64).toString('hex');
        return { ok: safeEqual(candidate, hash), needsUpgrade: false };
    }
    const ok = safeEqual(supplied, stored);
    return { ok, needsUpgrade: ok };
}

function sign(payload) {
    return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

function createToken(userId) {
    const exp = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
    const payload = `${userId}.${exp}`;
    return `${payload}.${sign(payload)}`;
}

function readToken(token) {
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [userId, exp, mac] = parts;
    if (!safeEqual(mac, sign(`${userId}.${exp}`))) return null;
    if (Date.now() > Number(exp)) return null;
    const id = parseInt(userId, 10);
    return Number.isInteger(id) ? id : null;
}

function parseCookies(header) {
    const out = {};
    if (!header) return out;
    for (const part of header.split(';')) {
        const i = part.indexOf('=');
        if (i === -1) continue;
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
}

function setSessionCookie(req, res, userId) {
    const secure = req.secure || req.get('x-forwarded-proto') === 'https';
    const attrs = [
        `${COOKIE_NAME}=${createToken(userId)}`,
        'HttpOnly',
        'SameSite=Lax',
        'Path=/',
        `Max-Age=${SESSION_DAYS * 24 * 60 * 60}`,
    ];
    if (secure) attrs.push('Secure');
    res.setHeader('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(res) {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

// Populates req.userId from the signed cookie. Never trusts a client-supplied id.
function attachUser(req, res, next) {
    req.userId = readToken(parseCookies(req.get('cookie'))[COOKIE_NAME]);
    next();
}

function requireAuth(req, res, next) {
    if (!req.userId) return res.status(401).json({ error: 'Not signed in' });
    next();
}

module.exports = {
    hashPassword,
    verifyPassword,
    setSessionCookie,
    clearSessionCookie,
    attachUser,
    requireAuth,
};
