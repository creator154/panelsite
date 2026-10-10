'use strict';

/* =========================================================
   ZX TEST UPLOADER
   Source Batches + Tests + DPPs + Upload
========================================================= */

const $ = selector => document.querySelector(selector);

const S = {
    token: localStorage.getItem('zx_admin_token') || '',
    type: 'test',
    batches: [],
    items: [],
    selectedBatch: null,
    loading: false,
    search: '',
    uploaded: new Set()
};

const API = () =>
    ((window.ZX_CONFIG && window.ZX_CONFIG.API_BASE) || '')
        .replace(/\/$/, '');

/* =========================================================
   API REQUEST
========================================================= */

async function req(path, options = {}) {
    const headers = {
        'Content-Type': 'application/json',
        ...(options.headers || {})
    };

    if (S.token) {
        headers.Authorization = 'Bearer ' + S.token;
    }

    const response = await fetch(API() + path, {
        ...options,
        headers
    });

    const data = await response.json().catch(() => ({}));

    if (response.status === 401 || response.status === 403) {
        if (
            path !== '/api/auth/login' &&
            path !== '/api/admin/me'
        ) {
            logout();
        }

        throw new Error(
            data.message || 'Session expired. Please login again.'
        );
    }

    if (!response.ok) {
        throw new Error(
            data.message || `Request failed (${response.status})`
        );
    }

    return data;
}

/* =========================================================
   SAFE HELPERS
========================================================= */

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    }[char]));
}

function normalizeList(data) {
    if (Array.isArray(data)) return data;

    if (!data || typeof data !== 'object') return [];

    const keys = [
        'batches',
        'items',
        'tests',
        'dpps',
        'data',
        'results',
        'docs'
    ];

    for (const key of keys) {
        if (Array.isArray(data[key])) {
            return data[key];
        }
    }

    if (data.data && typeof data.data === 'object') {
        for (const key of keys) {
            if (Array.isArray(data.data[key])) {
                return data.data[key];
            }
        }
    }

    return [];
}

function itemId(item) {
    return String(
        item?._id ||
        item?.id ||
        item?.testId ||
        item?.test_id ||
        item?.dppId ||
        item?.dpp_id ||
        item?.slug ||
        ''
    );
}

function itemTitle(item) {
    return (
        item?.title ||
        item?.name ||
        item?.testName ||
        item?.test_name ||
        item?.displayName ||
        'Untitled Test'
    );
}

function questionCount(item) {
    const questions =
        item?.questions ||
        item?.questionList ||
        item?.question_list ||
        item?.testQuestions ||
        item?.test_questions;

    if (Array.isArray(questions)) {
        return questions.length;
    }

    return Number(
        item?.totalQuestions ||
        item?.totalQuestion ||
        item?.questionCount ||
        item?.total_questions ||
        0
    );
}

function formatDate(value) {
    if (!value) return '';

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return '';
    }

    return date.toLocaleString();
}

function notify(message) {
    let box = $('#zx-toast');

    if (!box) {
        box = document.createElement('div');
        box.id = 'zx-toast';

        Object.assign(box.style, {
            position: 'fixed',
            left: '50%',
            bottom: '24px',
            transform: 'translateX(-50%)',
            zIndex: '99999',
            padding: '12px 18px',
            borderRadius: '12px',
            background: '#171717',
            color: '#fff',
            boxShadow: '0 8px 30px #0005',
            maxWidth: '90%',
            fontSize: '14px'
        });

        document.body.appendChild(box);
    }

    box.textContent = message;
    box.style.display = 'block';

    clearTimeout(box._timer);

    box._timer = setTimeout(() => {
        box.style.display = 'none';
    }, 3500);
}

/* =========================================================
   LOGIN
========================================================= */

function login() {
    document.body.innerHTML = `
        <div class="top">
            <div class="card login">
                <div style="text-align:center;margin-bottom:24px">
                    <div style="
                        width:64px;
                        height:64px;
                        margin:0 auto 16px;
                        border-radius:20px;
                        display:grid;
                        place-items:center;
                        background:linear-gradient(135deg,#2563eb,#7c3aed);
                        color:white;
                        font-size:28px;
                        font-weight:800">
                        ZX
                    </div>

                    <h2 style="margin-bottom:8px">
                        Test Uploader
                    </h2>

                    <p style="opacity:.7;margin:0">
                        Sign in to manage Tests and DPPs
                    </p>
                </div>

                <form id="login-form">
                    <label class="label">Auth Token</label>

                    <input
                        id="tok"
                        type="password"
                        placeholder="Enter your auth token"
                        autocomplete="current-password"
                        required
                    >

                    <label class="label">Role</label>

                    <select disabled>
                        <option>Batch Uploader</option>
                    </select>

                    <button
                        id="login-button"
                        class="btn full"
                        type="submit">
                        Login
                    </button>
                </form>

                <p style="
                    font-size:12px;
                    text-align:center;
                    opacity:.65;
                    margin-top:18px">
                    Secure uploader access
                </p>
            </div>
        </div>
    `;

    $('#login-form').addEventListener('submit', async event => {
        event.preventDefault();
        await doLogin();
    });
}

async function doLogin() {
    const input = $('#tok');
    const button = $('#login-button');

    const token = input?.value.trim();

    if (!token) {
        notify('Please enter your auth token.');
        return;
    }

    button.disabled = true;
    button.textContent = 'Signing in...';

    try {
        const response = await fetch(API() + '/api/auth/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                authToken: token
            })
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(data.message || 'Login failed');
        }

        if (!data.token) {
            throw new Error('Backend did not return a session token.');
        }

        S.token = data.token;

        localStorage.setItem('zx_admin_token', S.token);

        await home();

    } catch (error) {
        notify(error.message);
        button.disabled = false;
        button.textContent = 'Login';
    }
}

function logout() {
    localStorage.removeItem('zx_admin_token');

    S.token = '';
    S.batches = [];
    S.items = [];
    S.selectedBatch = null;

    login();
}

/* =========================================================
   MAIN LAYOUT
========================================================= */

function shell(title, content) {
    document.body.innerHTML = `
        <div class="top">
            <div class="wrap">

                <div class="header">
                    <div>
                        <h2>${esc(title)}</h2>
                        <small style="opacity:.65">
                            ZX Test Series Manager
                        </small>
                    </div>

                    <button
                        class="btn red"
                        id="logout-button">
                        Logout
                    </button>
                </div>

                ${content}

            </div>
        </div>
    `;

    $('#logout-button').addEventListener('click', logout);
}

/* =========================================================
   DASHBOARD
========================================================= */

async function home() {
    try {
        const stats = await req('/api/admin/stats');

        shell(
            'Test Series Uploader',
            `
                <div class="hero">
                    <h1>Test Series<br>Uploader</h1>

                    <p>
                        Manage your batches, tests and daily practice
                        questions from one place.
                    </p>
                </div>

                <div class="stats">
                    <div class="stat">
                        Batches
                        <br>
                        <b>${Number(stats.batches || 0)}</b>
                    </div>

                    <div class="stat">
                        Tests
                        <br>
                        <b>${Number(stats.tests || 0)}</b>
                    </div>

                    <div class="stat">
                        DPPs
                        <br>
                        <b>${Number(stats.dpps || 0)}</b>
                    </div>

                    <div class="stat">
                        Published
                        <br>
                        <b>${Number(stats.published || 0)}</b>
                    </div>
                </div>

                <div class="tiles">
                    <div class="tile blue" id="tests-tile">
                        <div class="icon">📄</div>
                        <h2>Tests</h2>
                        <p>Browse and upload tests</p>
                    </div>

                    <div class="tile green" id="dpps-tile">
                        <div class="icon">📚</div>
                        <h2>DPPs</h2>
                        <p>Browse and upload DPPs</p>
                    </div>
                </div>

                <div class="card">
                    <h3>Source Upload</h3>

                    <p>
                        Select Tests or DPPs to browse the batches
                        available to your account.
                    </p>

                    <button class="btn" id="source-tests">
                        Browse Tests
                    </button>

                    <button class="btn green" id="source-dpps">
                        Browse DPPs
                    </button>
                </div>

                <div class="card">
                    <h3>Local Batches</h3>

                    <p>
                        View batches already stored in your database.
                    </p>

                    <button class="btn gray" id="local-batches">
                        View Local Batches
                    </button>
                </div>
            `
        );

        $('#tests-tile').onclick = () => sourceBatches('test');
        $('#dpps-tile').onclick = () => sourceBatches('dpp');

        $('#source-tests').onclick = () => sourceBatches('test');
        $('#source-dpps').onclick = () => sourceBatches('dpp');

        $('#local-batches').onclick = () => batches('test');

    } catch (error) {
        console.error('Dashboard error:', error);
        notify(error.message);

        if (S.token) {
            logout();
        }
    }
}

/* =========================================================
   SOURCE BATCHES
========================================================= */

async function sourceBatches(type) {
    S.type = type;
    S.loading = true;
    S.selectedBatch = null;
    S.items = [];

    shell(
        type === 'test' ? 'Source Tests' : 'Source DPPs',
        `
            <button class="btn gray" id="back-home">
                ← Dashboard
            </button>

            <div class="card">
                <h3>Available Source Batches</h3>

                <p style="opacity:.7">
                    Select a batch to fetch its ${
                        type === 'test' ? 'Tests' : 'DPPs'
                    }.
                </p>

                <input
                    id="batch-search"
                    placeholder="Search batches..."
                >

                <div id="source-batch-list">
                    Loading batches...
                </div>
            </div>
        `
    );

    $('#back-home').onclick = home;

    $('#batch-search').addEventListener('input', () => {
        drawSourceBatches();
    });

    try {
        /*
         * Requires backend route:
         * GET /api/admin/source/batches
         */

        const data = await req('/api/admin/source/batches');

        S.batches = normalizeList(data);

        S.loading = false;

        drawSourceBatches();

    } catch (error) {
        S.loading = false;

        $('#source-batch-list').innerHTML = `
            <div class="notice">
                <b>Unable to load source batches.</b>
                <p>${esc(error.message)}</p>
                <p>
                    Check whether the backend implements
                    GET /api/admin/source/batches.
                </p>
                <button class="btn" id="retry-source-batches">
                    Retry
                </button>
            </div>
        `;

        $('#retry-source-batches').onclick = () => sourceBatches(type);
    }
}

function drawSourceBatches() {
    const container = $('#source-batch-list');

    if (!container) return;

    const query = ($('#batch-search')?.value || '').toLowerCase();

    const filtered = S.batches.filter(batch => {
        const name = String(
            batch.name ||
            batch.title ||
            batch.batchName ||
            batch.batch_name ||
            ''
        ).toLowerCase();

        return name.includes(query);
    });

    if (!filtered.length) {
        container.innerHTML = `
            <p>No source batches found.</p>
        `;
        return;
    }

    container.innerHTML = filtered.map((batch, index) => {
        const id = itemId(batch);

        const name =
            batch.name ||
            batch.title ||
            batch.batchName ||
            batch.batch_name ||
            'Untitled Batch';

        const language =
            batch.language ||
            batch.lang ||
            '';

        return `
            <div class="row">
                <div>
                    <b>${esc(name)}</b>

                    <small>
                        ${esc(language)}
                    </small>
                </div>

                <div class="actions">
                    <button
                        class="btn"
                        data-source-batch="${index}">
                        View ${S.type === 'test' ? 'Tests' : 'DPPs'}
                    </button>
                </div>
            </div>
        `;
    }).join('');

    container.querySelectorAll('[data-source-batch]').forEach(button => {
        button.onclick = () => {
            const batch = filtered[Number(button.dataset.sourceBatch)];

            if (batch) {
                sourceContent(batch);
            }
        };
    });
}

/* =========================================================
   SOURCE TESTS / DPPS
========================================================= */

async function sourceContent(batch) {
    S.selectedBatch = batch;
    S.items = [];

    const batchId = itemId(batch);

    if (!batchId) {
        notify('Source batch ID is missing.');
        return;
    }

    const name =
        batch.name ||
        batch.title ||
        batch.batchName ||
        'Selected Batch';

    shell(
        S.type === 'test' ? 'Available Tests' : 'Available DPPs',
        `
            <button class="btn gray" id="back-batches">
                ← Back to Batches
            </button>

            <div class="card">
                <h3>${esc(name)}</h3>

                <div class="bar">
                    <input
                        id="item-search"
                        placeholder="Search ${S.type === 'test' ? 'tests' : 'DPPs'}..."
                    >

                    <button class="btn" id="refresh-items">
                        Refresh
                    </button>
                </div>

                <div id="source-items">
                    Loading...
                </div>
            </div>
        `
    );

    $('#back-batches').onclick = () => sourceBatches(S.type);

    $('#refresh-items').onclick = () => sourceContent(batch);

    $('#item-search').addEventListener('input', drawSourceItems);

    try {
        /*
         * Expected backend routes:
         *
         * GET /api/admin/source/batches/:batchId/tests
         * GET /api/admin/source/batches/:batchId/dpps
         */

        const endpoint =
            '/api/admin/source/batches/' +
            encodeURIComponent(batchId) +
            '/' +
            (S.type === 'test' ? 'tests' : 'dpps');

        const data = await req(endpoint);

        S.items = normalizeList(data);

        drawSourceItems();

    } catch (error) {
        $('#source-items').innerHTML = `
            <div class="notice">
                <b>Unable to load items.</b>
                <p>${esc(error.message)}</p>

                <button class="btn" id="retry-items">
                    Retry
                </button>
            </div>
        `;

        $('#retry-items').onclick = () => sourceContent(batch);
    }
}

function drawSourceItems() {
    const container = $('#source-items');

    if (!container) return;

    const query = ($('#item-search')?.value || '').toLowerCase();

    const filtered = S.items.filter(item => {
        return itemTitle(item).toLowerCase().includes(query);
    });

    if (!filtered.length) {
        container.innerHTML = `
            <p>No ${
                S.type === 'test' ? 'tests' : 'DPPs'
            } found.</p>
        `;
        return;
    }

    container.innerHTML = filtered.map((item, index) => {
        const id = itemId(item);

        const count = questionCount(item);

        const date = formatDate(
            item.startTime ||
            item.startDate ||
            item.start_date ||
            item.date
        );

        const uploaded = S.uploaded.has(id);

        return `
            <div class="row">
                <div style="min-width:0">
                    <b>${esc(itemTitle(item))}</b>

                    <small>
                        Source ID: ${esc(id || 'Not available')}
                    </small>

                    <small>
                        Questions reported: ${count}
                        ${date ? ' • ' + esc(date) : ''}
                    </small>
                </div>

                <div class="actions">
                    <button
                        class="btn ${
                            uploaded ? 'green' : ''
                        }"
                        data-upload-item="${index}"
                        ${uploaded ? 'disabled' : ''}>
                        ${uploaded ? '✓ Uploaded' : 'Upload'}
                    </button>
                </div>
            </div>
        `;
    }).join('');

    container.querySelectorAll('[data-upload-item]').forEach(button => {
        button.onclick = async () => {
            const item = filtered[Number(button.dataset.uploadItem)];

            if (item) {
                await uploadSourceItem(item, button);
            }
        };
    });
}

/* =========================================================
   SOURCE UPLOAD
========================================================= */

async function uploadSourceItem(item, button) {
    const batch = S.selectedBatch;

    if (!batch) {
        notify('Please select a batch first.');
        return;
    }

    const sourceBatchId = itemId(batch);
    const sourceTestId = itemId(item);

    if (!sourceBatchId || !sourceTestId) {
        notify('Source batch ID or test ID is missing.');
        return;
    }

    if (
        !confirm(
            'Upload "' + itemTitle(item) +
            '" with its questions?'
        )
    ) {
        return;
    }

    const originalText = button.textContent;

    button.disabled = true;
    button.textContent = 'Uploading...';

    try {
        /*
         * Backend is responsible for fetching the actual
         * question detail from the source API.
         *
         * POST /api/admin/source/batches/:batchId/test/upload
         * POST /api/admin/source/batches/:batchId/dpp/upload
         */

        const endpoint =
            '/api/admin/source/batches/' +
            encodeURIComponent(sourceBatchId) +
            '/' +
            S.type +
            '/upload';

        const result = await req(endpoint, {
            method: 'POST',

            body: JSON.stringify({
                sourceTestId,
                sourceId: sourceTestId,
                sourceItem: item
            })
        });

        if (result.success === false) {
            throw new Error(
                result.message || 'Upload failed.'
            );
        }

        const saved = result.item || result.data || {};

        const savedQuestions = questionCount(saved);

        S.uploaded.add(sourceTestId);

        button.textContent = '✓ Uploaded';
        button.classList.add('green');

        notify(
            'Upload successful: ' +
            (saved.title || itemTitle(item)) +
            (savedQuestions ? ' • Questions: ' + savedQuestions : '')
        );

        drawSourceItems();

    } catch (error) {
        console.error('Source upload failed:', error);

        button.disabled = false;
        button.textContent = originalText;

        alert(
            'Upload failed.\n\n' +
            error.message +
            '\n\nIf the message says "Questions nahi mile", ' +
            'the backend has not extracted the actual questions yet.'
        );
    }
}

/* =========================================================
   LOCAL BATCHES
========================================================= */

async function batches(type) {
    S.type = type;

    try {
        const data = await req('/api/admin/batches');

        S.batches = normalizeList(data);

        shell(
            'Local Batches',
            `
                <button class="btn gray" id="back-dashboard">
                    ← Dashboard
                </button>

                <div class="card">
                    <h3>Database Batches</h3>

                    <input
                        id="local-search"
                        placeholder="Search batches..."
                    >

                    <div id="local-batch-list"></div>
                </div>
            `
        );

        $('#back-dashboard').onclick = home;

        $('#local-search').addEventListener('input', drawLocalBatches);

        drawLocalBatches();

    } catch (error) {
        notify(error.message);
    }
}

function drawLocalBatches() {
    const container = $('#local-batch-list');

    if (!container) return;

    const query = ($('#local-search')?.value || '').toLowerCase();

    const filtered = S.batches.filter(batch =>
        String(batch.name || '').toLowerCase().includes(query)
    );

    if (!filtered.length) {
        container.innerHTML = '<p>No batches found.</p>';
        return;
    }

    container.innerHTML = filtered.map((batch, index) => `
        <div class="row">
            <div>
                <b>${esc(batch.name)}</b>
                <small>
                    ${esc(batch.language || '')}
                    • ${esc(batch.status || '')}
                </small>
            </div>

            <div class="actions">
                <button class="btn" data-local-content="${index}">
                    View ${S.type === 'test' ? 'Tests' : 'DPPs'}
                </button>
            </div>
        </div>
    `).join('');

    container.querySelectorAll('[data-local-content]').forEach(button => {
        button.onclick = () => {
            const batch = filtered[Number(button.dataset.localContent)];

            if (batch) {
                localContent(batch);
            }
        };
    });
}

async function localContent(batch) {
    S.selectedBatch = batch;

    try {
        const data = await req(
            '/api/admin/batches/' +
            encodeURIComponent(batch._id) +
            '/content/' +
            S.type
        );

        const items = data.items || [];

        shell(
            S.type === 'test' ? 'Saved Tests' : 'Saved DPPs',
            `
                <button class="btn gray" id="back-local">
                    ← Back
                </button>

                <div class="card">
                    <h3>${esc(batch.name)}</h3>

                    <div id="local-content-list"></div>
                </div>
            `
        );

        $('#back-local').onclick = () => batches(S.type);

        const container = $('#local-content-list');

        if (!items.length) {
            container.innerHTML = '<p>No saved items.</p>';
            return;
        }

        container.innerHTML = items.map(item => `
            <div class="row">
                <div>
                    <b>${esc(item.title)}</b>
                    <small>
                        Questions: ${questionCount(item)}
                    </small>
                </div>

                <div class="actions">
                    <span class="btn ${
                        item.published ? 'green' : ''
                    }">
                        ${item.published ? '✓ Published' : 'Not published'}
                    </span>
                </div>
            </div>
        `).join('');

    } catch (error) {
        notify(error.message);
    }
}

/* =========================================================
   LEGACY MANUAL CONTENT
========================================================= */

async function content(id) {
    const batch = S.batches.find(item => item._id === id);

    if (!batch) {
        notify('Batch not found.');
        return;
    }

    await localContent(batch);
}

function newContent() {
    notify(
        'For automatic question uploads, use Source Batches ' +
        'instead of manual JSON upload.'
    );
}

async function saveContent() {
    notify('Use Source Upload to fetch questions automatically.');
}

async function publish(id) {
    try {
        await req('/api/admin/content/' + id + '/publish', {
            method: 'POST'
        });

        notify('Published successfully.');

        if (S.selectedBatch) {
            await localContent(S.selectedBatch);
        }
    } catch (error) {
        notify(error.message);
    }
}

async function delContent(id) {
    if (!confirm('Delete this item?')) return;

    try {
        await req('/api/admin/content/' + id, {
            method: 'DELETE'
        });

        notify('Item deleted.');

        if (S.selectedBatch) {
            await localContent(S.selectedBatch);
        }
    } catch (error) {
        notify(error.message);
    }
}

/* =========================================================
   LEGACY BATCH CREATION
========================================================= */

function modal(html) {
    const existing = $('#modal');

    if (existing) existing.remove();

    const element = document.createElement('div');

    element.id = 'modal';
    element.className = 'modal';

    element.innerHTML = `
        <div class="card">
            <div style="text-align:right">
                <button class="btn gray" id="close-modal">
                    Close
                </button>
            </div>

            ${html}
        </div>
    `;

    document.body.appendChild(element);

    $('#close-modal').onclick = closeModal;
}

function closeModal() {
    $('#modal')?.remove();
}

function newBatch() {
    notify('Create batches through the backend admin tools.');
}

async function saveBatch() {
    notify('Use the configured backend to create batches.');
}

async function delBatch(id) {
    if (!confirm('Delete this batch?')) return;

    try {
        await req('/api/admin/batches/' + id, {
            method: 'DELETE'
        });

        notify('Batch deleted.');

        await batches(S.type);

    } catch (error) {
        notify(error.message);
    }
}

/* =========================================================
   INITIALIZE
========================================================= */

Object.assign(window, {
    doLogin,
    login,
    home,
    logout,
    batches,
    sourceBatches,
    sourceContent,
    uploadSourceItem,
    drawSourceBatches,
    drawSourceItems,
    drawLocalBatches,
    newBatch,
    saveBatch,
    delBatch,
    content,
    newContent,
    saveContent,
    publish,
    delContent,
    modal,
    closeModal
});

if (S.token) {
    home();
} else {
    login();
}
