const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'frontend/public')));

// Proxy endpoint to fetch batches or tests dynamically using token
app.get('/api/proxy/:endpoint(*)', async (req, res) => {
    const token = req.headers['authorization'] || process.env.PW_JWT_TOKEN || '';
    const targetUrl = `https://api.penpencil.xyz/v1/${req.params.endpoint}`;

    try {
        const response = await axios.get(targetUrl, {
            headers: {
                'authorization': token.startsWith('Bearer') ? token : `Bearer ${token}`,
                'client-id': '5eb3394cb5809f0004b36016',
                'accept': 'application/json, text/plain, */*'
            },
            params: req.query
        });
        res.json(response.data);
    } catch (err) {
        res.status(500).json({ 
            error: "Failed to fetch data from upstream", 
            details: err.response?.data || err.message 
        });
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'frontend/public/index.html'));
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
