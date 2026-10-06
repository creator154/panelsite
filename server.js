const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, 'frontend/public')));

// Proxy endpoint using token access for batch tests & DPPs
app.get('/batch/:batchId/:batchName/:type', async (req, res) => {
    const { batchId, type } = req.params;
    const token = process.env.PW_JWT_TOKEN || '';

    try {
        let apiUrl = `https://api.penpencil.xyz/v1/batches/${batchId}/tests`;
        if (type === 'test_series') {
            apiUrl = `https://api.penpencil.xyz/v1/batches/${batchId}/test-series`;
        } else if (type === 'dpp') {
            apiUrl = `https://api.penpencil.xyz/v1/batches/${batchId}/dpps`;
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
        res.status(500).json({ error: "Failed to fetch data, please check token or batch access.", details: err.message });
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'frontend/public/index.html'));
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
