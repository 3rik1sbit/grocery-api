// server.js
// API now supports item reordering with a `position` field.

const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = 3000;
const DB_PATH = path.join(__dirname, 'database.json');

// --- Middleware ---
app.use(cors());
app.use(express.json());

// --- Helper Functions ---
async function readDatabase() {
    try {
        const data = await fs.readFile(DB_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            const initialData = { lists: [{ id: 1, name: "Småhandling", items: [] }] };
            await writeDatabase(initialData);
            return initialData;
        }
        throw error;
    }
}

async function writeDatabase(data) {
    await fs.writeFile(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
}


// --- API Routes for Lists ---
// ... (Your GET /lists and POST /lists routes remain the same) ...
app.get('/lists', async (req, res) => {
    console.log('GET /lists - Request received to fetch all lists.');
    try {
        const db = await readDatabase();
        const listMetas = db.lists.map(list => ({ id: list.id, name: list.name }));
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
        const newList = { id: newId, name: name.trim(), items: [] };
        db.lists.push(newList);
        await writeDatabase(db);
        console.log("Successfully created new list:", newList);
        res.status(201).json(newList);
    } catch (error) {
        console.error('Error creating list:', error);
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
        await writeDatabase(db);
        res.status(204).send();
    } catch (error) { res.status(500).json({ message: 'Error updating database.' }); }
});


// --- Server Initialization ---
app.listen(PORT, () => {
    console.log(`Multi-list Grocery API server with reordering is running on http://localhost:${PORT}`);
    readDatabase().catch(err => console.error("Initial DB check failed:", err));
});

