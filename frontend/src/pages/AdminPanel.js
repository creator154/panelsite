import React, { useState } from 'react';
import axios from 'axios';

const BACKEND_URL =
  'https://panel1-18e1d76be41d.herokuapp.com';

export default function AdminPanel() {
  const [token, setToken] = useState('');
  const [sessionToken, setSessionToken] = useState('');

  const [batches, setBatches] = useState([]);
  const [selectedBatch, setSelectedBatch] = useState(null);

  const [activeType, setActiveType] = useState('tests');
  const [items, setItems] = useState([]);

  const [loading, setLoading] = useState(false);
  const [uploadingId, setUploadingId] = useState(null);

  const authHeaders = () => ({
    Authorization: `Bearer ${sessionToken}`
  });

  /*
   * =====================================================
   * LOGIN WITH PW TOKEN
   * =====================================================
   */

  const loginAndFetchBatches = async () => {
    const pwToken = token.trim();

    if (!pwToken) {
      alert('Please enter your PW Auth Token.');
      return;
    }

    setLoading(true);

    try {
      /*
       * First authenticate the PW token.
       * Backend returns our own JWT session token.
       */

      const loginRes = await axios.post(
        `${BACKEND_URL}/api/auth/login`,
        {
          authToken: pwToken
        }
      );

      if (!loginRes.data?.success || !loginRes.data?.token) {
        throw new Error(
          loginRes.data?.message ||
          'Source login failed.'
        );
      }

      const jwtToken = loginRes.data.token;

      setSessionToken(jwtToken);

      /*
       * Now load source batches using JWT.
       */

      const batchRes = await axios.get(
        `${BACKEND_URL}/api/admin/source/batches`,
        {
          headers: {
            Authorization: `Bearer ${jwtToken}`
          }
        }
      );

      const list = Array.isArray(
        batchRes.data?.batches
      )
        ? batchRes.data.batches
        : [];

      setBatches(list);

      if (!list.length) {
        alert('No enrolled batches found.');
      } else {
        alert(
          `${list.length} batches loaded successfully.`
        );
      }

    } catch (err) {
      console.error(
        'Login / Batch error:',
        err.response?.data || err.message
      );

      setSessionToken('');
      setBatches([]);
      setSelectedBatch(null);
      setItems([]);

      alert(
        err.response?.data?.message ||
        err.message ||
        'Login failed. Please check your PW Auth Token.'
      );
    } finally {
      setLoading(false);
    }
  };


  /*
   * =====================================================
   * LOAD TESTS / DPPS
   * =====================================================
   */

  const loadContent = async (batch, type) => {
    if (!sessionToken) {
      alert('Please login with PW Auth Token first.');
      return;
    }

    setSelectedBatch(batch);
    setActiveType(type);
    setItems([]);
    setLoading(true);

    try {
      const sourceBatchId = String(
        batch._id ||
        batch.id ||
        batch.batchId ||
        batch.batch_id ||
        ''
      ).trim();

      if (!sourceBatchId) {
        throw new Error(
          'Source batch ID not found.'
        );
      }

      const endpoint =
        type === 'dpps'
          ? 'dpps'
          : 'tests';

      const res = await axios.get(
        `${BACKEND_URL}/api/admin/source/batches/${encodeURIComponent(
          sourceBatchId
        )}/${endpoint}`,
        {
          headers: authHeaders()
        }
      );

      const list = Array.isArray(
        res.data?.items
      )
        ? res.data.items
        : [];

      setItems(list);

      if (!list.length) {
        alert(
          `No ${
            type === 'tests'
              ? 'tests'
              : 'DPPs'
          } found.`
        );
      }

    } catch (err) {
      console.error(
        'Content error:',
        err.response?.data || err.message
      );

      alert(
        err.response?.data?.message ||
        err.message ||
        'Error fetching content.'
      );
    } finally {
      setLoading(false);
    }
  };


  /*
   * =====================================================
   * UPLOAD TEST / DPP
   * =====================================================
   */

  const uploadItem = async (item) => {
    if (!sessionToken) {
      alert('Please login first.');
      return;
    }

    if (!selectedBatch) {
      alert('Please select a batch first.');
      return;
    }

    const sourceTestId = String(
      item._id ||
      item.id ||
      item.testId ||
      item.test_id ||
      item.testID ||
      item.sourceTestId ||
      ''
    ).trim();

    if (!sourceTestId) {
      alert('Source test ID not found.');
      return;
    }

    const sourceBatchId = String(
      selectedBatch._id ||
      selectedBatch.id ||
      selectedBatch.batchId ||
      selectedBatch.batch_id ||
      ''
    ).trim();

    if (!sourceBatchId) {
      alert('Source batch ID not found.');
      return;
    }

    const apiType =
      activeType === 'dpps'
        ? 'dpp'
        : 'test';

    setUploadingId(sourceTestId);

    try {
      /*
       * First check whether this item is already uploaded.
       */

      const statusRes = await axios.get(
        `${BACKEND_URL}/api/admin/source/batches/${encodeURIComponent(
          sourceBatchId
        )}/${apiType}/status`,
        {
          headers: authHeaders()
        }
      );

      const uploadedIds =
        Array.isArray(
          statusRes.data?.uploadedIds
        )
          ? statusRes.data.uploadedIds.map(String)
          : [];

      if (
        uploadedIds.includes(sourceTestId)
      ) {
        alert(
          `"${getTitle(item)}" is already uploaded.`
        );
        return;
      }

      /*
       * Upload.
       */

      const res = await axios.post(
        `${BACKEND_URL}/api/admin/source/batches/${encodeURIComponent(
          sourceBatchId
        )}/${apiType}/upload`,
        {
          sourceTestId,

          /*
           * Backend can use this if source detail
           * endpoint doesn't return the expected data.
           */
          sourceItem: item,

          title: getTitle(item),

          instructions:
            item.instructions ||
            item.instruction ||
            item.description ||
            '',

          startTime:
            item.startTime ||
            item.start_time ||
            item.startDate ||
            item.start_date ||
            item.scheduledAt ||
            null
        },
        {
          headers: authHeaders()
        }
      );

      console.log(
        'Upload response:',
        res.data
      );

      if (res.data?.skipped) {
        alert(
          `"${getTitle(item)}" is already uploaded.`
        );
      } else if (res.data?.success) {
        alert(
          `"${getTitle(item)}" uploaded successfully!`
        );
      } else {
        alert(
          res.data?.message ||
          'Upload response received.'
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
        err.message ||
        'Upload failed.'
      );
    } finally {
      setUploadingId(null);
    }
  };


  /*
   * =====================================================
   * HELPERS
   * =====================================================
   */

  const getTitle = (item) => {
    return (
      item?.title ||
      item?.name ||
      item?.testName ||
      item?.test_title ||
      'Untitled Test'
    );
  };


  /*
   * =====================================================
   * UI
   * =====================================================
   */

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


      {/* PW TOKEN */}

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
            onClick={loginAndFetchBatches}
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

          {batches.map((batch) => {

            const batchId = String(
              batch._id ||
              batch.id ||
              batch.batchId ||
              batch.batch_id ||
              ''
            );

            return (
              <div
                key={batchId}
                className="d-flex justify-content-between align-items-center border-bottom py-2"
              >

                <span className="fw-semibold">
                  {batch.name ||
                    batch.title ||
                    'Unnamed Batch'}
                </span>

                <div className="btn-group">

                  <button
                    className="btn btn-sm btn-outline-primary"
                    onClick={() =>
                      loadContent(
                        batch,
                        'tests'
                      )
                    }
                    disabled={loading}
                  >
                    📄 Load Tests
                  </button>

                  <button
                    className="btn btn-sm btn-outline-success"
                    onClick={() =>
                      loadContent(
                        batch,
                        'dpps'
                      )
                    }
                    disabled={loading}
                  >
                    📚 Load DPPs
                  </button>

                </div>

              </div>
            );
          })}

        </div>
      )}


      {/* ITEMS */}

      {selectedBatch && (
        <div className="card p-3 shadow-sm">

          <h5 className="fw-bold mb-3">

            {selectedBatch.name ||
              selectedBatch.title ||
              'Selected Batch'}

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
                item.test_id ||
                item.testID ||
                item.sourceTestId ||
                ''
              );

              const title =
                getTitle(item);

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

                    <div className="small text-muted">
                      ID: {id}
                    </div>

                  </div>

                  <button
                    className="btn btn-sm btn-success"
                    onClick={() =>
                      uploadItem(item)
                    }
                    disabled={
                      isUploading ||
                      !sessionToken
                    }
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
