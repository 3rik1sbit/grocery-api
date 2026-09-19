// server.js
// API now supports item reordering with a `position` field.

const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = 3000;
const DB_PATH = path.join(__dirname, 'database.json');

// Pick up GROCERY_API_KEY from a local .env (gitignored) if there is one, so
// the key doesn't have to be threaded through the pm2 invocation.
try {
    process.loadEnvFile(path.join(__dirname, '.env'));
} catch {
    // No .env file; fall back to the real environment.
}

const API_KEY = process.env.GROCERY_API_KEY;
if (!API_KEY) {
    console.error(
        'GROCERY_API_KEY is not set. Refusing to start: that would expose every ' +
        'list to anyone who finds this URL. Put it in backend/.env or the environment.'
    );
    process.exit(1);
}

// --- Middleware ---
app.use(cors());
app.use(express.json());

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
async function writeDatabase(data) {
    const payload = JSON.stringify(data, null, 2);
    const tmpPath = `${DB_PATH}.${process.pid}.tmp`;

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
        const db = await readDatabase();
        const newId = db.lists.length > 0 ? Math.max(...db.lists.map(l => l.id)) + 1 : 1;
        const newList = { id: newId, name: name.trim(), items: [], changeCount: 0 };
        db.lists.push(newList);
        await writeDatabase(db);
        console.log("Successfully created new list:", newList);
        res.status(201).json(newList);
    } catch (error) {
        console.error('Error creating list:', error);
        res.status(500).json({ message: 'Error updating database.' });
    }
});


app.delete('/lists/:listId', async (req, res) => {
    const listId = parseInt(req.params.listId, 10);
    console.log(`DELETE /lists/${listId} - Request to delete list.`);
    try {
        const db = await readDatabase();
        const initialLength = db.lists.length;
        db.lists = db.lists.filter(l => l.id !== listId);
        if (db.lists.length === initialLength) return res.status(404).json({ message: 'List not found.' });
        await writeDatabase(db);
        res.status(204).send();
    } catch (error) {
        console.error('Error deleting list:', error);
        res.status(500).json({ message: 'Error updating database.' });
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
    try {
        const db = await readDatabase();
        const list = db.lists.find(l => l.id === listId);
        if (!list) return res.status(404).json({ message: 'List not found.' });

        const newItemId = list.items.length > 0 ? Math.max(...list.items.map(item => item.id)) + 1 : 1;
        // New items get the highest position, placing them at the end.
        const newPosition = list.items.length > 0 ? Math.max(...list.items.map(item => item.position)) + 1 : 0;
        
        const newItem = { id: newItemId, name: name.trim(), checked: false, position: newPosition };
        list.items.push(newItem);
        list.changeCount = (list.changeCount || 0) + 1;
        await writeDatabase(db);
        res.status(201).json(newItem);
    } catch (error) { res.status(500).json({ message: 'Error updating database.' }); }
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
        const db = await readDatabase();
        const list = db.lists.find(l => l.id === listId);
        if (!list) return res.status(404).json({ message: 'List not found.' });

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
        await writeDatabase(db);
        res.status(200).json({ message: "List reordered successfully." });
    } catch (error) {
        console.error(`Error reordering list ${listId}:`, error);
        res.status(500).json({ message: 'Error updating database.' });
    }
});


// ... (The toggle and delete routes remain mostly the same) ...
app.post('/lists/:listId/groceries/:itemId/toggle', async (req, res) => {
    const listId = parseInt(req.params.listId, 10);
    const itemId = parseInt(req.params.itemId, 10);
    try {
        const db = await readDatabase();
        const list = db.lists.find(l => l.id === listId);
        if (!list) return res.status(404).json({ message: 'List not found.' });
        const item = list.items.find(i => i.id === itemId);
        if (!item) return res.status(404).json({ message: 'Item not found.' });
        item.checked = !item.checked;
        list.changeCount = (list.changeCount || 0) + 1;
        await writeDatabase(db);
        res.status(200).json(item);
    } catch (error) { res.status(500).json({ message: 'Error updating database.' }); }
});
app.delete('/lists/:listId/groceries/:itemId', async (req, res) => {
    const listId = parseInt(req.params.listId, 10);
    const itemId = parseInt(req.params.itemId, 10);
    try {
        const db = await readDatabase();
        const list = db.lists.find(l => l.id === listId);
        if (!list) return res.status(404).json({ message: 'List not found.' });
        const initialLength = list.items.length;
        list.items = list.items.filter(i => i.id !== itemId);
        if (list.items.length === initialLength) return res.status(404).json({ message: 'Item not found in list.' });
        list.changeCount = (list.changeCount || 0) + 1;
        await writeDatabase(db);
        res.status(204).send();
    } catch (error) { res.status(500).json({ message: 'Error updating database.' }); }
});


// --- Server Initialization ---
app.listen(PORT, () => {
    console.log(`Multi-list Grocery API server with reordering is running on http://localhost:${PORT}`);
    readDatabase().catch(err => console.error("Initial DB check failed:", err));
});

