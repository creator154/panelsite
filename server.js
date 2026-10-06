const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'frontend/public')));

// Simple local JSON storage file for admin updates
const DATA_FILE = path.join(__dirname, 'data.json');

// Helper to read/write custom updates
function getStoredData() {
    if (!fs.existsSync(DATA_FILE)) return {};
    try {
        return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch {
        return {};
    }
}

function saveStoredData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Admin Login Route
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    const adminUser = process.env.ADMIN_USER || 'admin';
    const adminPass = process.env.ADMIN_PASS || 'admin123';

    if (username === adminUser && password === adminPass) {
        res.json({ success: true, token: "admin_auth_token_xyz" });
    } else {
        res.status(401).json({ success: false, message: "Invalid credentials" });
    }
});

// Admin Update Batch Data Route
app.post('/api/admin/update', (req, res) => {
    const { batchId, testName, testLink } = req.body;
    if (!batchId) return res.status(400).json({ error: "Batch ID is required" });

    let data = getStoredData();
    if (!data[batchId]) data[batchId] = [];
    data[batchId].push({ testName, testLink, updatedAt: new Date().toISOString() });

    saveStoredData(data);
    res.json({ success: true, message: "Batch updated successfully!" });
});

// Fetch custom updates for frontend or proxy upstream tests
app.get('/batch/:batchId/:batchName/:type', async (req, res) => {
    const { batchId, type } = req.params;
    
    // Check if we have local admin updates first
    let stored = getStoredData();
    if (stored[batchId] && stored[batchId].length > 0) {
        return res.json({ source: "admin_panel", data: stored[batchId] });
    }

    // Otherwise fallback to Penpencil API proxy
    const token = process.env.PW_JWT_TOKEN || '';
    try {
        let apiUrl = `https://api.penpencil.xyz/v1/batches/${batchId}/tests`;
        if (type === 'test_series') {
            apiUrl = `https://api.penpencil.xyz/v1/batches/${batchId}/test-series`;
        }

        const response = await axios.get(apiUrl, {
            headers: {
                'authorization': `Bearer ${token}`,
                'client-id': '5eb3394cb5809f0004b36016',
                'accept': 'application/json, text/plain, */*'
            }
        });
        res.json(response.data);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch upstream data", details: err.message });
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'frontend/public/index.html'));
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
