// server.js
// API now supports item reordering with a `position` field.

const express = require('express');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
// Overridable so the test suite can run against a scratch database on a free
// port instead of the real one.
const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'database.json');

// Pick up GROCERY_API_KEY from a local .env (gitignored) if there is one, so
// the key doesn't have to be threaded through the pm2 invocation. Parsed by
// hand because process.loadEnvFile needs Node 20.6+ and production is on 18.
function loadEnvFile(file) {
    let contents;
    try {
        contents = fsSync.readFileSync(file, 'utf8');
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return; // No .env; fall back to the real environment.
    }
    for (const line of contents.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        const quoted = (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"));
        if (quoted) value = value.slice(1, -1);
        // A real environment variable wins over the file.
        if (!(key in process.env)) process.env[key] = value;
    }
}

loadEnvFile(path.join(__dirname, '.env'));

const API_KEY = process.env.GROCERY_API_KEY;
if (!API_KEY) {
    console.error(
        'GROCERY_API_KEY is not set. Refusing to start: that would expose every ' +
        'list to anyone who finds this URL. Put it in backend/.env or the environment.'
    );
    process.exit(1);
}

// --- Middleware ---
// The Android client is not a browser, so it needs no CORS at all. Send
// cross-origin permission only to origins named in CORS_ORIGINS (comma
// separated); with none set, send none. Set that variable if a web client is
// ever added.
const corsOrigins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
app.use(cors(corsOrigins.length > 0 ? { origin: corsOrigins } : { origin: false }));
app.use(express.json());

// --- Health ---
// Deliberately above the key check. This is the one endpoint the uptime
// monitor calls, and handing monitoring a copy of the production key so it
// can ask "are you alive?" every minute is a worse trade than leaving this
// open. It discloses nothing an anonymous caller could not already learn from
// the port accepting connections -- no counts, no names, just the verdict.
//
// It reads the database rather than answering a flat 200, because a process
// that is up while its database is missing or corrupt is precisely the state
// worth being woken for, and `res.send('ok')` cannot tell the two apart.
//
// Read-only, and deliberately NOT readDatabase(): that helper writes a fresh
// database when the file is missing, and an unauthenticated request must
// never be able to create anything.
app.get('/health', async (req, res) => {
    try {
        JSON.parse(await fs.readFile(DB_PATH, 'utf8'));
        res.json({ status: 'ok' });
    } catch (error) {
        console.error(`Health check failed: ${error.message}`);
        res.status(503).json({ status: 'unavailable' });
    }
});

// Every route below requires the shared key. Compared in constant time so the
// endpoint can't be used as an oracle to recover the key byte by byte.
function keyMatches(presented) {
    const a = Buffer.from(presented, 'utf8');
    const b = Buffer.from(API_KEY, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

app.use((req, res, next) => {
    const presented = req.get('X-API-Key');
    if (!presented || !keyMatches(presented)) {
        console.warn(`Rejected unauthenticated ${req.method} ${req.path}`);
        return res.status(401).json({ message: 'Unauthorized.' });
    }
    next();
});

// --- Helper Functions ---
async function readDatabase() {
    try {
        const data = await fs.readFile(DB_PATH, 'utf8');
        const db = JSON.parse(data);
        // Migrate existing lists that lack changeCount
        for (const list of db.lists) {
            if (list.changeCount === undefined) {
                list.changeCount = 0;
            }
        }
        return db;
    } catch (error) {
        if (error.code === 'ENOENT') {
            const initialData = { lists: [{ id: 1, name: "Småhandling", items: [] }] };
            await writeDatabase(initialData);
            return initialData;
        }
        throw error;
    }
}

// Writing straight over database.json means a crash mid-write leaves a
// truncated file and the whole database is gone. Write a temp file in the same
// directory, flush it, then rename: rename is atomic on POSIX, so a reader
// either sees the old file or the complete new one, never a partial write.
let tmpSeq = 0;

async function writeDatabase(data) {
    const payload = JSON.stringify(data, null, 2);
    // Unique per write: a fixed name meant two overlapping writes shared one
    // temp file and both renamed it over the database.
    const tmpPath = `${DB_PATH}.${process.pid}.${tmpSeq++}.tmp`;

    let handle;
    try {
        handle = await fs.open(tmpPath, 'w');
        await handle.writeFile(payload, 'utf8');
        await handle.sync();
    } finally {
        if (handle) await handle.close();
    }

    try {
        await fs.rename(tmpPath, DB_PATH);
    } catch (error) {
        await fs.unlink(tmpPath).catch(() => {});
        throw error;
    }

    // Persist the rename itself, so the swap survives a power loss too.
    let dir;
    try {
        dir = await fs.open(path.dirname(DB_PATH), 'r');
        await dir.sync();
    } catch {
        // Directory fsync is a durability nicety; not all filesystems allow it.
    } finally {
        if (dir) await dir.close();
    }
}

// An error that carries the status the client should see, so a mutation can
// bail out from inside updateDatabase without writing anything.
class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

// Every request read the whole database, changed it, and wrote it back. Two
// overlapping requests therefore both read the same snapshot and the second
// write silently discarded the first one's change: two phones ticking off
// different items at the same time, and one tick is simply lost. Serialising
// the read-modify-write sequences makes each one see the previous one's result.
//
// An in-process queue is enough because pm2 runs this in fork_mode, as a single
// process. Running it clustered, or as several processes over the same file,
// would need a real file lock instead.
let writeQueue = Promise.resolve();

function serialize(task) {
    const run = writeQueue.then(task, task);
    // Keep the chain alive: a rejected task must not wedge every later one.
    writeQueue = run.then(() => {}, () => {});
    return run;
}

// Reads the database, applies `mutate`, and writes the result back, with no
// other mutation interleaved. If `mutate` throws, nothing is written.
async function updateDatabase(mutate) {
    return serialize(async () => {
        const db = await readDatabase();
        const result = await mutate(db);
        await writeDatabase(db);
        return result;
    });
}

// Ids were max(existing) + 1, which restarts at 1 once everything is deleted
// and hands a new row an id a client still has cached, so the client's stale
// entry silently becomes the new one. Keep a high-water mark instead, seeded
// from the existing rows so old databases carry over.
function allocateListId(db) {
    const highWater = db.lists.reduce(
        (max, list) => Math.max(max, list.id),
        db.nextListId || 0
    );
    db.nextListId = highWater + 1;
    return db.nextListId;
}

function allocateItemId(list) {
    const highWater = list.items.reduce(
        (max, item) => Math.max(max, item.id),
        list.nextItemId || 0
    );
    list.nextItemId = highWater + 1;
    return list.nextItemId;
}

function handleError(res, error, fallback) {
    if (error instanceof ApiError) {
        return res.status(error.status).json({ message: error.message });
    }
    console.error(fallback, error);
    return res.status(500).json({ message: fallback });
}


// --- API Routes for Lists ---
// ... (Your GET /lists and POST /lists routes remain the same) ...
app.get('/lists', async (req, res) => {
    console.log('GET /lists - Request received to fetch all lists.');
    try {
        const db = await readDatabase();
        const listMetas = db.lists.map(list => ({ id: list.id, name: list.name, changeCount: list.changeCount || 0 }));
        res.status(200).json(listMetas);
    } catch (error) {
        console.error('Error fetching lists:', error);
        res.status(500).json({ message: 'Error reading from database.' });
    }
});
app.post('/lists', async (req, res) => {
    const { name } = req.body;
    console.log(`POST /lists - Request to create new list: ${name}`);
    if (!name || typeof name !== 'string' || name.trim() === '') {
        return res.status(400).json({ message: 'List name is required.' });
    }
    try {
        const newList = await updateDatabase(db => {
            const newId = allocateListId(db);
            const list = { id: newId, name: name.trim(), items: [], changeCount: 0, nextItemId: 0 };
            db.lists.push(list);
            return list;
        });
        console.log("Successfully created new list:", newList);
        res.status(201).json(newList);
    } catch (error) {
        handleError(res, error, 'Error updating database.');
    }
});


app.patch('/lists/:listId', async (req, res) => {
    const listId = parseInt(req.params.listId, 10);
    const { name } = req.body;
    console.log(`PATCH /lists/${listId} - Request to rename list.`);
    if (!name || typeof name !== 'string' || name.trim() === '') {
        return res.status(400).json({ message: 'List name is required.' });
    }
    try {
        const renamed = await updateDatabase(db => {
            const list = db.lists.find(l => l.id === listId);
            if (!list) throw new ApiError(404, 'List not found.');
            list.name = name.trim();
            return { id: list.id, name: list.name, changeCount: list.changeCount || 0 };
        });
        res.status(200).json(renamed);
    } catch (error) {
        handleError(res, error, 'Error updating database.');
    }
});

app.delete('/lists/:listId', async (req, res) => {
    const listId = parseInt(req.params.listId, 10);
    console.log(`DELETE /lists/${listId} - Request to delete list.`);
    try {
        await updateDatabase(db => {
            const initialLength = db.lists.length;
            db.lists = db.lists.filter(l => l.id !== listId);
            if (db.lists.length === initialLength) throw new ApiError(404, 'List not found.');
        });
        res.status(204).send();
    } catch (error) {
        handleError(res, error, 'Error updating database.');
    }
});

// --- API Routes for Groceries (Items within a list) ---

// GET items is updated to sort by position
app.get('/lists/:listId/groceries', async (req, res) => {
    const listId = parseInt(req.params.listId, 10);
    try {
        const db = await readDatabase();
        const list = db.lists.find(l => l.id === listId);
        if (!list) return res.status(404).json({ message: 'List not found.' });
        // Sort items by their position before sending
        list.items.sort((a, b) => a.position - b.position);
        res.status(200).json(list.items);
    } catch (error) { res.status(500).json({ message: 'Error reading from database.' }); }
});

// POST item is updated to add a position
app.post('/lists/:listId/groceries', async (req, res) => {
    const listId = parseInt(req.params.listId, 10);
    const { name } = req.body;
    // Without this, a missing name threw on name.trim() and surfaced as a 500.
    if (!name || typeof name !== 'string' || name.trim() === '') {
        return res.status(400).json({ message: 'Item name is required.' });
    }
    try {
        const newItem = await updateDatabase(db => {
            const list = db.lists.find(l => l.id === listId);
            if (!list) throw new ApiError(404, 'List not found.');

            const newItemId = allocateItemId(list);
            // New items get the highest position, placing them at the end.
            const newPosition = list.items.reduce(
                (max, item) => Math.max(max, item.position + 1),
                0
            );

            const item = { id: newItemId, name: name.trim(), checked: false, position: newPosition };
            list.items.push(item);
            list.changeCount = (list.changeCount || 0) + 1;
            return item;
        });
        res.status(201).json(newItem);
    } catch (error) { handleError(res, error, 'Error updating database.'); }
});

// *** NEW ENDPOINT FOR REORDERING ***
app.post('/lists/:listId/groceries/reorder', async (req, res) => {
    const listId = parseInt(req.params.listId, 10);
    const { orderedIds } = req.body; // Expects an array of item IDs in the new order.
    console.log(`POST /lists/${listId}/groceries/reorder - Reordering items.`);

    if (!Array.isArray(orderedIds)) {
        return res.status(400).json({ message: 'orderedIds must be an array.' });
    }

    try {
        await updateDatabase(db => {
            const list = db.lists.find(l => l.id === listId);
            if (!list) throw new ApiError(404, 'List not found.');

            // Create a map for quick lookups
            const itemMap = new Map(list.items.map(item => [item.id, item]));

            // Update the position of each item based on its index in the orderedIds array.
            orderedIds.forEach((id, index) => {
                const item = itemMap.get(id);
                if (item) {
                    item.position = index;
                }
            });

            list.changeCount = (list.changeCount || 0) + 1;
        });
        res.status(200).json({ message: "List reordered successfully." });
    } catch (error) {
        handleError(res, error, 'Error updating database.');
    }
});


// ... (The toggle and delete routes remain mostly the same) ...
app.post('/lists/:listId/groceries/:itemId/toggle', async (req, res) => {
    const listId = parseInt(req.params.listId, 10);
    const itemId = parseInt(req.params.itemId, 10);
    try {
        const toggled = await updateDatabase(db => {
            const list = db.lists.find(l => l.id === listId);
            if (!list) throw new ApiError(404, 'List not found.');
            const item = list.items.find(i => i.id === itemId);
            if (!item) throw new ApiError(404, 'Item not found.');
            item.checked = !item.checked;
            list.changeCount = (list.changeCount || 0) + 1;
            return item;
        });
        res.status(200).json(toggled);
    } catch (error) { handleError(res, error, 'Error updating database.'); }
});
// Registered before /:itemId, otherwise "completed" is parsed as an item id.
app.delete('/lists/:listId/groceries/completed', async (req, res) => {
    const listId = parseInt(req.params.listId, 10);
    console.log(`DELETE /lists/${listId}/groceries/completed - Clearing checked items.`);
    try {
        const removed = await updateDatabase(db => {
            const list = db.lists.find(l => l.id === listId);
            if (!list) throw new ApiError(404, 'List not found.');
            const before = list.items.length;
            list.items = list.items.filter(item => !item.checked);
            const count = before - list.items.length;
            if (count > 0) list.changeCount = (list.changeCount || 0) + 1;
            return count;
        });
        res.status(200).json({ removed });
    } catch (error) {
        handleError(res, error, 'Error updating database.');
    }
});

app.delete('/lists/:listId/groceries/:itemId', async (req, res) => {
    const listId = parseInt(req.params.listId, 10);
    const itemId = parseInt(req.params.itemId, 10);
    try {
        await updateDatabase(db => {
            const list = db.lists.find(l => l.id === listId);
            if (!list) throw new ApiError(404, 'List not found.');
            const initialLength = list.items.length;
            list.items = list.items.filter(i => i.id !== itemId);
            if (list.items.length === initialLength) throw new ApiError(404, 'Item not found in list.');
            list.changeCount = (list.changeCount || 0) + 1;
        });
        res.status(204).send();
    } catch (error) { handleError(res, error, 'Error updating database.'); }
});


// --- Server Initialization ---
app.listen(PORT, () => {
    console.log(`Multi-list Grocery API server with reordering is running on http://localhost:${PORT}`);
    readDatabase().catch(err => console.error("Initial DB check failed:", err));
});

