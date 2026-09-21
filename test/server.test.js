// Regression tests for the mistakes that are easy to reintroduce here: losing
// a concurrent write, reusing an id, leaving a route unauthenticated, letting
// a bad payload through as a 500, and shadowing a literal route with a
// parameterised one.
//
// Run with: npm test

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const KEY = 'test-key-0123456789';
const PORT = 3100 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;

let server;
let dbPath;
let tmpDir;

function req(method, url, { body, key = KEY, headers = {} } = {}) {
    const h = { ...headers };
    if (key !== null) h['X-API-Key'] = key;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    return fetch(BASE + url, {
        method,
        headers: h,
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}

async function json(method, url, opts) {
    const res = await req(method, url, opts);
    return { status: res.status, body: await res.json().catch(() => null) };
}

async function waitForServer() {
    for (let i = 0; i < 100; i++) {
        try {
            const res = await req('GET', '/lists');
            if (res.status === 200) return;
        } catch {
            // not listening yet
        }
        await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('server did not start');
}

before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grocery-test-'));
    dbPath = path.join(tmpDir, 'database.json');
    server = spawn('node', [path.join(__dirname, '..', 'server.js')], {
        env: { ...process.env, PORT: String(PORT), DATABASE_PATH: dbPath, GROCERY_API_KEY: KEY },
        stdio: 'ignore',
    });
    await waitForServer();
});

after(() => {
    if (server) server.kill();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Start each test from a known database.
beforeEach(() => {
    fs.writeFileSync(dbPath, JSON.stringify({
        lists: [
            { id: 1, name: 'Test', items: [], changeCount: 0 },
            { id: 2, name: 'Other', items: [], changeCount: 0 },
        ],
    }, null, 2));
});

test('every route rejects a request with no key, a wrong key, and accepts the right one', async () => {
    assert.strictEqual((await req('GET', '/lists', { key: null })).status, 401);
    assert.strictEqual((await req('GET', '/lists', { key: 'wrong' })).status, 401);
    assert.strictEqual((await req('POST', '/lists', { body: { name: 'x' }, key: null })).status, 401);
    assert.strictEqual((await req('GET', '/lists')).status, 200);
});

test('/health answers without a key, and discloses nothing but the verdict', async () => {
    // Unauthenticated on purpose so monitoring needs no copy of the key --
    // see the comment on the route. The exact body is asserted because the
    // value of this endpoint is that it leaks nothing: no list names, no
    // counts. A future "helpful" addition should fail here.
    const res = await req('GET', '/health', { key: null });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { status: 'ok' });
});

test('/health reports 503 when the database cannot be read', async () => {
    // The whole reason it reads the file instead of answering a flat 200: an
    // up process with an unreadable database must not look healthy.
    fs.writeFileSync(dbPath, '{ not valid json');
    const res = await req('GET', '/health', { key: null });
    assert.strictEqual(res.status, 503);
    assert.deepStrictEqual(await res.json(), { status: 'unavailable' });
});

test('/health does not create a database when one is missing', async () => {
    // readDatabase() writes a starter database on ENOENT. If /health ever
    // starts using it, an unauthenticated request could create files.
    fs.rmSync(dbPath);
    const res = await req('GET', '/health', { key: null });
    assert.strictEqual(res.status, 503);
    assert.strictEqual(fs.existsSync(dbPath), false);
});

test('a wrong key of the same length is still rejected', async () => {
    // Guards the constant-time comparison against being replaced by something
    // that only checks length.
    const sameLength = 'x'.repeat(KEY.length);
    assert.strictEqual((await req('GET', '/lists', { key: sameLength })).status, 401);
});

test('concurrent adds do not lose updates', async () => {
    // The whole database is read, mutated and written per request. Without
    // serialisation the later write discards the earlier one's item.
    const N = 25;
    const results = await Promise.all(
        Array.from({ length: N }, (_, i) => req('POST', '/lists/1/groceries', { body: { name: `item-${i}` } }))
    );
    const created = results.filter(r => r.status === 201).length;
    const { body: items } = await json('GET', '/lists/1/groceries');

    assert.strictEqual(created, N, 'every add should be accepted');
    assert.strictEqual(items.length, N, 'every accepted add should survive');
});

test('concurrent toggles all apply', async () => {
    const { body: a } = await json('POST', '/lists/1/groceries', { body: { name: 'a' } });
    const { body: b } = await json('POST', '/lists/1/groceries', { body: { name: 'b' } });

    await Promise.all([
        req('POST', `/lists/1/groceries/${a.id}/toggle`),
        req('POST', `/lists/1/groceries/${b.id}/toggle`),
    ]);

    const { body: items } = await json('GET', '/lists/1/groceries');
    assert.deepStrictEqual(items.map(i => i.checked), [true, true], 'neither toggle should be lost');
});

test('item ids are not reused after everything is deleted', async () => {
    // A reused id silently takes over a client's stale cached row.
    const { body: first } = await json('POST', '/lists/1/groceries', { body: { name: 'first' } });
    await req('DELETE', `/lists/1/groceries/${first.id}`);

    const { body: second } = await json('POST', '/lists/1/groceries', { body: { name: 'second' } });
    assert.notStrictEqual(second.id, first.id, 'a fresh item must not inherit a deleted id');
});

test('list ids are not reused after deletion', async () => {
    const { body: created } = await json('POST', '/lists', { body: { name: 'temp' } });
    await req('DELETE', `/lists/${created.id}`);
    const { body: next } = await json('POST', '/lists', { body: { name: 'temp2' } });
    assert.notStrictEqual(next.id, created.id);
});

test('a missing or blank name is a 400, not a 500', async () => {
    assert.strictEqual((await req('POST', '/lists/1/groceries', { body: {} })).status, 400);
    assert.strictEqual((await req('POST', '/lists/1/groceries', { body: { name: '   ' } })).status, 400);
    assert.strictEqual((await req('POST', '/lists', { body: {} })).status, 400);
    assert.strictEqual((await req('PATCH', '/lists/1', { body: { name: '' } })).status, 400);
    assert.strictEqual((await req('POST', '/lists/1/groceries/reorder', { body: { orderedIds: 'nope' } })).status, 400);
});

test('operations on things that do not exist are 404', async () => {
    assert.strictEqual((await req('POST', '/lists/999/groceries', { body: { name: 'x' } })).status, 404);
    assert.strictEqual((await req('POST', '/lists/1/groceries/999/toggle')).status, 404);
    assert.strictEqual((await req('DELETE', '/lists/1/groceries/999')).status, 404);
    assert.strictEqual((await req('DELETE', '/lists/999')).status, 404);
    assert.strictEqual((await req('PATCH', '/lists/999', { body: { name: 'x' } })).status, 404);
});

test('a failed mutation leaves the database untouched', async () => {
    const before = fs.readFileSync(dbPath, 'utf8');
    await req('POST', '/lists/999/groceries', { body: { name: 'x' } }); // 404
    assert.strictEqual(fs.readFileSync(dbPath, 'utf8'), before);
});

test('a rejected mutation does not wedge later ones', async () => {
    // The serialisation queue must survive a task that throws.
    for (let i = 0; i < 3; i++) await req('DELETE', '/lists/999');
    assert.strictEqual((await req('POST', '/lists/1/groceries', { body: { name: 'still works' } })).status, 201);
});

test('clearing completed items is not parsed as an item id', async () => {
    // DELETE /lists/1/groceries/completed must not be matched by /:itemId.
    const { body: keep } = await json('POST', '/lists/1/groceries', { body: { name: 'keep' } });
    const { body: done } = await json('POST', '/lists/1/groceries', { body: { name: 'done' } });
    await req('POST', `/lists/1/groceries/${done.id}/toggle`);

    const { status, body } = await json('DELETE', '/lists/1/groceries/completed');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.removed, 1);

    const { body: items } = await json('GET', '/lists/1/groceries');
    assert.deepStrictEqual(items.map(i => i.id), [keep.id], 'only the checked item should go');
});

test('renaming a list keeps its items and id', async () => {
    const { body: item } = await json('POST', '/lists/1/groceries', { body: { name: 'milk' } });
    const { status, body } = await json('PATCH', '/lists/1', { body: { name: 'Renamed' } });

    assert.strictEqual(status, 200);
    assert.strictEqual(body.name, 'Renamed');
    assert.strictEqual(body.id, 1);

    const { body: items } = await json('GET', '/lists/1/groceries');
    assert.deepStrictEqual(items.map(i => i.id), [item.id]);
});

test('reordering applies the requested order', async () => {
    const { body: a } = await json('POST', '/lists/1/groceries', { body: { name: 'a' } });
    const { body: b } = await json('POST', '/lists/1/groceries', { body: { name: 'b' } });
    const { body: c } = await json('POST', '/lists/1/groceries', { body: { name: 'c' } });

    await req('POST', '/lists/1/groceries/reorder', { body: { orderedIds: [c.id, a.id, b.id] } });

    const { body: items } = await json('GET', '/lists/1/groceries');
    assert.deepStrictEqual(items.map(i => i.name), ['c', 'a', 'b']);
});

test('deleting a list does not touch the other list', async () => {
    await json('POST', '/lists/2/groceries', { body: { name: 'survivor' } });
    await req('DELETE', '/lists/1');

    const { body: items } = await json('GET', '/lists/2/groceries');
    assert.deepStrictEqual(items.map(i => i.name), ['survivor']);
});

test('the database stays valid JSON under concurrent writes, with no temp files left behind', async () => {
    await Promise.all(
        Array.from({ length: 20 }, (_, i) => req('POST', '/lists/1/groceries', { body: { name: `x${i}` } }))
    );
    // Would throw if a write were ever partially visible.
    JSON.parse(fs.readFileSync(dbPath, 'utf8'));

    const strays = fs.readdirSync(tmpDir).filter(f => f.endsWith('.tmp'));
    assert.deepStrictEqual(strays, [], 'temp files should be renamed away, not left behind');
});

test('changeCount rises when a list is modified, which is what orders the lists', async () => {
    const before = (await json('GET', '/lists')).body.find(l => l.id === 1).changeCount;
    await req('POST', '/lists/1/groceries', { body: { name: 'x' } });
    const after = (await json('GET', '/lists')).body.find(l => l.id === 1).changeCount;
    assert.ok(after > before, 'adding an item should count as using the list');
});
