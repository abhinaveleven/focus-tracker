# Focus Tracker

A self-hosted focus/time tracker with per-profile locking.

## Running

```bash
cp .env.example .env   # then edit it
docker compose up -d --build
```

The app listens on port `8181`.

## Profile locking

Each profile has its own password. All data endpoints require a valid session
cookie, and the server derives your identity from that cookie alone — a request
can never ask for another profile's data by passing an id, and session ids are
HMAC-signed so they cannot be forged. Passwords are stored as salted scrypt
hashes.

A profile with no password set is unlocked and anyone can open it, so set a
password on every profile you care about.

Environment variables (in `.env`, which is gitignored):

| Variable | Purpose |
| --- | --- |
| `OWNER_PASSWORD` | Locks the `abhinav` profile on first boot, so the app is never publicly readable between deploy and first login. Ignored once a password is set. |
| `SESSION_SECRET` | Signs session cookies. Set it so logins survive a rebuild; otherwise one is generated and persisted to `.session_secret`. |

### Changing a password

From the UI: profile menu → **Set / Change Password**.

From the command line:

```bash
docker exec focus-app node set-password.js abhinav 'new password'
docker exec focus-app node set-password.js abhinav --clear   # unlock
```
