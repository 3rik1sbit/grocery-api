// server.js
// A simple API for managing a grocery list.
// The '/api' prefix has been removed from routes to work cleanly with the Nginx reverse proxy.

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

// --- Helper Function to Read from DB ---
async function readDatabase() {
    try {
        const data = await fs.readFile(DB_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            await writeDatabase({ groceries: [] });
            return { groceries: [] };
        }
        throw error;
    }
}

// --- Helper Function to Write to DB ---
async function writeDatabase(data) {
    await fs.writeFile(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
}


// --- API Routes ---

/**
 * @route   GET /groceries
 * @desc    Get all grocery list items.
 * @access  Public
 */
app.get('/groceries', async (req, res) => {
    console.log('GET /groceries - Request received to fetch all items.');
    try {
        const db = await readDatabase();
        res.status(200).json(db.groceries);
        console.log('Successfully sent grocery list.');
    } catch (error) {
        console.error('Error fetching groceries:', error);
        res.status(500).json({ message: 'Error reading from database.' });
    }
});

/**
 * @route   POST /groceries/:id/toggle
 * @desc    Toggle the 'checked' status of a grocery item.
 * @access  Public
 */
app.post('/groceries/:id/toggle', async (req, res) => {
    const itemId = parseInt(req.params.id, 10);
    console.log(`POST /groceries/${itemId}/toggle - Request received to toggle item.`);

    if (isNaN(itemId)) {
        return res.status(400).json({ message: 'Invalid item ID provided.' });
    }

    try {
        const db = await readDatabase();
        const itemIndex = db.groceries.findIndex(item => item.id === itemId);

        if (itemIndex === -1) {
            console.warn(`Item with ID ${itemId} not found.`);
            return res.status(404).json({ message: 'Item not found.' });
        }

        db.groceries[itemIndex].checked = !db.groceries[itemIndex].checked;
        await writeDatabase(db);

        console.log(`Successfully toggled item ID ${itemId}. New status: ${db.groceries[itemIndex].checked}`);
        res.status(200).json(db.groceries[itemIndex]);

    } catch (error) {
        console.error(`Error toggling item ${itemId}:`, error);
        res.status(500).json({ message: 'Error updating database.' });
    }
});

/**
 * @route   POST /groceries
 * @desc    Add a new grocery item.
 * @access  Public
 */
app.post('/groceries', async (req, res) => {
    const { name } = req.body;
    console.log(`POST /groceries - Request received to add item: ${name}`);

    if (!name || typeof name !== 'string' || name.trim() === '') {
        return res.status(400).json({ message: 'Item name is required.' });
    }
    
    try {
        const db = await readDatabase();
        const newId = db.groceries.length > 0 ? Math.max(...db.groceries.map(item => item.id)) + 1 : 1;
        const newItem = {
            id: newId,
            name: name.trim(),
            checked: false
        };

        db.groceries.push(newItem);
        await writeDatabase(db);
        
        console.log(`Successfully added new item:`, newItem);
        res.status(201).json(newItem);

    } catch (error) {
        console.error(`Error adding item:`, error);
        res.status(500).json({ message: 'Error updating database.' });
    }
});


// --- Server Initialization ---
app.listen(PORT, () => {
    console.log(`Grocery API server is running on http://localhost:${PORT}`);
    readDatabase().catch(err => console.error("Initial DB check failed:", err));
});

