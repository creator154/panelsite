import React, { useState, useEffect } from 'react';
import axios from 'axios';

const BACKEND_URL = 'https://YOUR-BACKEND-HEROKU-URL.herokuapp.com'; // Change this line

export default function StudentPortal() {
  const [batches] = useState([
    { id: 'yakeen_2027', name: 'Yakeen NEET Hindi 2027' },
    { id: 'yakeen_2026', name: 'Yakeen NEET Hindi 2026' }
  ]);
  const [selectedBatch, setSelectedBatch] = useState('yakeen_2027');
  const [activeTab, setActiveTab] = useState('test');
  const [items, setItems] = useState([]);

  useEffect(() => {
    axios.get(`${BACKEND_URL}/api/uploader/live/${selectedBatch}/${activeTab}`)
      .then(res => setItems(res.data.items || []))
      .catch(err => console.error(err));
  }, [selectedBatch, activeTab]);

  return (
    <div className="container py-3" style={{ maxWidth: '600px' }}>
      <h4 className="fw-bold text-center text-primary mb-3">🎓 Student Test & DPP Portal</h4>
      
      <label className="fw-bold mb-1">Select Batch:</label>
      <select 
        className="form-select mb-3" 
        value={selectedBatch} 
        onChange={(e) => setSelectedBatch(e.target.value)}>
        {batches.map(b => (
          <option key={b.id} value={b.id}>{b.name}</option>
        ))}
      </select>

      <div className="btn-group w-100 mb-3">
        <button 
          className={`btn ${activeTab === 'test' ? 'btn-primary' : 'btn-outline-primary'}`}
          onClick={() => setActiveTab('test')}>
          📄 Tests
        </button>
        <button 
          className={`btn ${activeTab === 'dpp' ? 'btn-success' : 'btn-outline-success'}`}
          onClick={() => setActiveTab('dpp')}>
          📚 DPPs
        </button>
      </div>

      <div className="d-flex flex-column gap-2">
        {items.length === 0 ? (
          <div className="text-center text-muted py-4">No {activeTab.toUpperCase()} available for this batch yet.</div>
        ) : (
          items.map(item => (
            <div key={item._id} className="card p-3 shadow-sm border-0 bg-white">
              <h6 className="fw-bold">{item.title}</h6>
              <small className="text-muted mb-2">Total Questions: {item.totalQuestions}</small>
              <button className="btn btn-sm btn-primary mt-1">
                {activeTab === 'test' ? '▶ Start Test' : '📝 Solve DPP'}
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
