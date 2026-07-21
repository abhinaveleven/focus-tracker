// Set or clear a profile password from the command line.
//
//   docker exec focus-app node set-password.js <name> '<new password>'
//   docker exec focus-app node set-password.js <name> --clear
//
// Quote the password so the shell does not mangle it.
const { PrismaClient } = require('@prisma/client');
const auth = require('./auth');

const [name, password] = process.argv.slice(2);

if (!name || password === undefined) {
    console.error("Usage: node set-password.js <name> '<new password>' | --clear");
    process.exit(1);
}

const prisma = new PrismaClient();

(async () => {
    const user = await prisma.user.findUnique({ where: { name } });
    if (!user) {
        const all = await prisma.user.findMany();
        console.error(`No profile named "${name}". Existing: ${all.map(u => u.name).join(', ') || '(none)'}`);
        process.exit(1);
    }

    const clearing = password === '--clear';
    await prisma.user.update({
        where: { id: user.id },
        data: { password: clearing ? null : auth.hashPassword(password) }
    });

    console.log(clearing
        ? `Password cleared for "${name}" - this profile is now unlocked.`
        : `Password set for "${name}".`);
})()
    .catch(e => { console.error(e.message); process.exit(1); })
    .finally(() => prisma.$disconnect());
