import React, { useState } from 'react';
import axios from 'axios';

const BACKEND_URL =
  'https://panel1-18e1d76be41d.herokuapp.com';

export default function AdminPanel() {

  const [token, setToken] = useState('');
  const [batches, setBatches] = useState([]);
  const [selectedBatch, setSelectedBatch] = useState(null);
  const [activeType, setActiveType] = useState('tests');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [uploadingId, setUploadingId] = useState(null);

  /* =====================================================
     LOAD SOURCE BATCHES
  ===================================================== */

  const fetchBatches = async () => {

    if (!token.trim()) {
      alert('Please enter your PW Auth Token.');
      return;
    }

    setLoading(true);

    try {

      const res = await axios.post(
        `${BACKEND_URL}/api/uploader/batches`,
        {
          authToken: token.trim()
        }
      );

      console.log('Batches:', res.data);

      setBatches(
        Array.isArray(res.data?.batches)
          ? res.data.batches
          : []
      );

      if (!res.data?.batches?.length) {
        alert('No batches found.');
      }

    } catch (err) {

      console.error(
        'Batch error:',
        err.response?.data || err.message
      );

      alert(
        err.response?.data?.message ||
        'Error fetching batches. Please check your PW Auth Token.'
      );

    } finally {

      setLoading(false);

    }
  };


  /* =====================================================
     LOAD TESTS / DPPS
  ===================================================== */

  const loadContent = async (batch, type) => {

    setSelectedBatch(batch);
    setActiveType(type);
    setItems([]);
    setLoading(true);

    try {

      const res = await axios.post(
        `${BACKEND_URL}/api/uploader/content`,
        {
          authToken: token.trim(),
          batchId:
            batch._id ||
            batch.id ||
            batch.batchId,
          type
        }
      );

      console.log(
        `${type} response:`,
        res.data
      );

      const list =
        Array.isArray(res.data?.items)
          ? res.data.items
          : [];

      setItems(list);

      if (!list.length) {
        alert(
          `No ${type === 'tests' ? 'tests' : 'DPPs'} found.`
        );
      }

    } catch (err) {

      console.error(
        'Content error:',
        err.response?.data || err.message
      );

      alert(
        err.response?.data?.message ||
        'Error fetching items for this batch.'
      );

    } finally {

      setLoading(false);

    }
  };


  /* =====================================================
     UPLOAD TEST / DPP
  ===================================================== */

  const uploadItem = async (item) => {

    if (!selectedBatch) {
      alert('Please select a batch first.');
      return;
    }

    const sourceTestId = String(
      item._id ||
      item.id ||
      item.testId ||
      item.sourceTestId ||
      ''
    ).trim();

    if (!sourceTestId) {
      alert('Source test ID not found.');
      return;
    }

    const sourceBatchId = String(
      selectedBatch.sourceBatchId ||
      selectedBatch._id ||
      selectedBatch.id ||
      selectedBatch.batchId ||
      ''
    ).trim();

    if (!sourceBatchId) {
      alert('Source batch ID not found.');
      return;
    }

    setUploadingId(sourceTestId);

    try {

      console.log(
        'Uploading:',
        {
          sourceBatchId,
          sourceTestId,
          type: activeType,
          item
        }
      );

      const apiType =
        activeType === 'dpps'
          ? 'dpp'
          : 'test';

      const res = await axios.post(

        `${BACKEND_URL}/api/admin/source/batches/${encodeURIComponent(
          sourceBatchId
        )}/${apiType}/upload`,

        {
          sourceTestId,

          sourceItem: item,

          title:
            item.title ||
            item.name ||
            'Untitled Test',

          instructions:
            item.instructions ||
            item.description ||
            '',

          startTime:
            item.startTime ||
            item.start_time ||
            null
        },

        {
          headers: {
            Authorization:
              `Bearer ${token.trim()}`
          }
        }

      );

      console.log(
        'Upload response:',
        res.data
      );

      if (res.data?.skipped) {

        alert(
          `"${item.title || item.name}" is already uploaded.`
        );

      } else {

        alert(
          `"${item.title || item.name}" uploaded successfully!`
        );

      }

    } catch (err) {

      console.error(
        'Upload error:',
        err.response?.data || err.message
      );

      alert(
        err.response?.data?.message ||
        err.response?.data?.error ||
        'Upload failed.'
      );

    } finally {

      setUploadingId(null);

    }
  };


  /* =====================================================
     UI
  ===================================================== */

  return (

    <div
      className="container py-4"
      style={{
        maxWidth: '900px'
      }}
    >

      <h3 className="fw-bold text-primary mb-3">
        🛠 Admin Scraper Control Panel
      </h3>


      {/* TOKEN */}

      <div className="card p-3 mb-3 shadow-sm">

        <label className="fw-bold mb-1">
          Enter PW Bearer Auth Token:
        </label>

        <div className="d-flex gap-2">

          <input
            type="text"
            className="form-control"
            placeholder="Bearer Token..."
            value={token}
            onChange={(e) =>
              setToken(e.target.value)
            }
          />

          <button
            className="btn btn-primary"
            onClick={fetchBatches}
            disabled={loading}
          >
            {loading
              ? 'Loading...'
              : 'Get Enrolled Batches'}
          </button>

        </div>

      </div>


      {/* BATCHES */}

      {batches.length > 0 && (

        <div className="card p-3 mb-3 shadow-sm">

          <h5 className="fw-bold mb-2">
            Select Batch & Content Type
          </h5>

          {batches.map((b) => (

            <div
              key={
                b._id ||
                b.id ||
                b.batchId
              }
              className="d-flex justify-content-between align-items-center border-bottom py-2"
            >

              <span className="fw-semibold">
                {b.name ||
                  b.title ||
                  'Unnamed Batch'}
              </span>

              <div className="btn-group">

                <button
                  className="btn btn-sm btn-outline-primary"
                  onClick={() =>
                    loadContent(b, 'tests')
                  }
                >
                  📄 Load Tests
                </button>

                <button
                  className="btn btn-sm btn-outline-success"
                  onClick={() =>
                    loadContent(b, 'dpps')
                  }
                >
                  📚 Load DPPs
                </button>

              </div>

            </div>

          ))}

        </div>

      )}


      {/* ITEMS */}

      {selectedBatch && (

        <div className="card p-3 shadow-sm">

          <h5 className="fw-bold mb-3">

            {selectedBatch.name ||
              selectedBatch.title}

            {' — '}

            {activeType.toUpperCase()}

          </h5>


          {loading && (

            <div className="text-center py-3">
              Loading...
            </div>

          )}


          {!loading &&
            items.length === 0 && (

              <div className="text-muted text-center py-3">
                No items found.
              </div>

            )}


          {!loading &&
            items.map((item) => {

              const id = String(
                item._id ||
                item.id ||
                item.testId ||
                item.sourceTestId ||
                ''
              );

              const title =
                item.title ||
                item.name ||
                item.testName ||
                item.test_title ||
                'Untitled Test';

              const isUploading =
                uploadingId === id;

              return (

                <div
                  key={id}
                  className="d-flex justify-content-between align-items-center mb-2 p-2 border rounded"
                >

                  <div>

                    <strong>
                      {title}
                    </strong>

                    <div
                      className="small text-muted"
                    >
                      ID: {id}
                    </div>

                  </div>


                  <button
                    className="btn btn-sm btn-success"
                    onClick={() =>
                      uploadItem(item)
                    }
                    disabled={isUploading}
                  >

                    {isUploading
                      ? 'Uploading...'
                      : '☁ Upload'}

                  </button>

                </div>

              );

            })}

        </div>

      )}

    </div>

  );
}
