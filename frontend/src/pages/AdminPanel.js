import React, { useState } from 'react';
import axios from 'axios';

const BACKEND_URL = 'https://YOUR-BACKEND-HEROKU-URL.herokuapp.com'; // Change this line

export default function AdminPanel() {
  const [token, setToken] = useState('');
  const [batches, setBatches] = useState([]);
  const [selectedBatch, setSelectedBatch] = useState(null);
  const [activeType, setActiveType] = useState('tests');
  const [items, setItems] = useState([]);

  const fetchBatches = async () => {
    try {
      const res = await axios.post(`${BACKEND_URL}/api/uploader/batches`, { authToken: token });
      setBatches(res.data.batches);
    } catch (err) {
      alert('Error fetching batches. Please check your PW Auth Token.');
    }
  };

  const loadContent = async (batch, type) => {
    setSelectedBatch(batch);
    setActiveType(type);
    try {
      const res = await axios.post(`${BACKEND_URL}/api/uploader/content`, {
        authToken: token,
        batchId: batch._id,
        type: type
      });
      setItems(res.data.items);
    } catch (err) {
      alert('Error fetching items for this batch.');
    }
  };

  const uploadItem = async (item) => {
    try {
      await axios.post(`${BACKEND_URL}/api/uploader/sync`, {
        batchId: selectedBatch._id,
        batchName: selectedBatch.name,
        type: activeType,
        title: item.title,
        questions: item.questions || []
      });
      alert(`"${item.title}" successfully uploaded to student portal!`);
    } catch (err) {
      alert('Upload failed.');
    }
  };

  return (
    <div className="container py-4" style={{ maxWidth: '700px' }}>
      <h3 className="fw-bold text-primary mb-3">🛠 Admin Scraper Control Panel</h3>
      
      <div className="card p-3 mb-3 shadow-sm">
        <label className="fw-bold mb-1">Enter PW Bearer Auth Token:</label>
        <div className="d-flex gap-2">
          <input 
            type="text" 
            className="form-control" 
            placeholder="Bearer Token..." 
            value={token} 
            onChange={(e) => setToken(e.target.value)} 
          />
          <button className="btn btn-primary" onClick={fetchBatches}>Get Enrolled Batches</button>
        </div>
      </div>

      {batches.length > 0 && (
        <div className="card p-3 mb-3 shadow-sm">
          <h5 className="fw-bold mb-2">Select Batch & Content Type:</h5>
          {batches.map(b => (
            <div key={b._id} className="d-flex justify-content-between align-items-center border-bottom py-2">
              <span className="fw-semibold">{b.name}</span>
              <div className="btn-group">
                <button className="btn btn-sm btn-outline-primary" onClick={() => loadContent(b, 'tests')}>📄 Load Tests</button>
                <button className="btn btn-sm btn-outline-success" onClick={() => loadContent(b, 'dpps')}>📚 Load DPPs</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {items.length > 0 && (
        <div className="card p-3 shadow-sm">
          <h5 className="fw-bold mb-3">{selectedBatch?.name} — {activeType.toUpperCase()}</h5>
          {items.map(item => (
            <div key={item._id} className="d-flex justify-content-between align-items-center mb-2 p-2 border rounded">
              <div>
                <strong>{item.title}</strong>
              </div>
              <button className="btn btn-sm btn-success" onClick={() => uploadItem(item)}>
                ☁ Sync Live
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
