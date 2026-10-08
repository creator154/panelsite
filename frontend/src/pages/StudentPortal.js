import React, { useState, useEffect } from 'react';
import axios from 'axios';

const BACKEND_URL =
  'https://zxsite-68c7f7bb252b.herokuapp.com';

export default function StudentPortal() {
  const [batches, setBatches] = useState([]);
  const [selectedBatch, setSelectedBatch] = useState('');
  const [activeTab, setActiveTab] = useState('test');
  const [items, setItems] = useState([]);

  const [loadingBatches, setLoadingBatches] = useState(true);
  const [loadingItems, setLoadingItems] = useState(false);
  const [error, setError] = useState('');

  /*
   * =====================================================
   * LOAD REAL BATCHES
   * =====================================================
   */

  useEffect(() => {
    const loadBatches = async () => {
      try {
        setLoadingBatches(true);
        setError('');

        const res = await axios.get(
          `${BACKEND_URL}/api/pw-batches`
        );

        const list = Array.isArray(res.data?.batches)
          ? res.data.batches
          : Array.isArray(res.data?.items)
          ? res.data.items
          : [];

        setBatches(list);

        if (list.length > 0) {
          const firstBatch = list[0];

          setSelectedBatch(
            String(
              firstBatch._id ||
              firstBatch.id ||
              firstBatch.batchId ||
              ''
            )
          );
        }
      } catch (err) {
        console.error(
          'Batch loading error:',
          err.response?.data || err.message
        );

        setError(
          'Batches load nahi ho pa rahe hain.'
        );
      } finally {
        setLoadingBatches(false);
      }
    };

    loadBatches();
  }, []);


  /*
   * =====================================================
   * LOAD TESTS / DPPs
   * =====================================================
   */

  useEffect(() => {
    if (!selectedBatch) {
      setItems([]);
      return;
    }

    const loadItems = async () => {
      try {
        setLoadingItems(true);
        setError('');
        setItems([]);

        const contentType =
          activeTab === 'test'
            ? 'test'
            : 'dpp';

        const res = await axios.get(
          `${BACKEND_URL}/api/live/${encodeURIComponent(
            selectedBatch
          )}/${contentType}`
        );

        const list = Array.isArray(res.data?.items)
          ? res.data.items
          : [];

        setItems(list);

      } catch (err) {
        console.error(
          'Content loading error:',
          err.response?.data || err.message
        );

        setItems([]);

        setError(
          `${activeTab === 'test' ? 'Tests' : 'DPPs'} load nahi ho pa rahe hain.`
        );
      } finally {
        setLoadingItems(false);
      }
    };

    loadItems();
  }, [selectedBatch, activeTab]);


  /*
   * =====================================================
   * UI
   * =====================================================
   */

  return (
    <div
      className="container py-3"
      style={{
        maxWidth: '600px'
      }}
    >

      <h4 className="fw-bold text-center text-primary mb-3">
        🎓 Student Test & DPP Portal
      </h4>


      {/* BATCH SELECT */}

      <label className="fw-bold mb-1">
        Select Batch:
      </label>

      {loadingBatches ? (
        <div className="text-center text-muted py-3">
          Loading batches...
        </div>
      ) : batches.length === 0 ? (
        <div className="text-center text-muted py-3">
          No batches available.
        </div>
      ) : (
        <select
          className="form-select mb-3"
          value={selectedBatch}
          onChange={(e) =>
            setSelectedBatch(e.target.value)
          }
        >
          {batches.map((batch) => {

            const id = String(
              batch._id ||
              batch.id ||
              batch.batchId ||
              ''
            );

            return (
              <option
                key={id}
                value={id}
              >
                {batch.name ||
                  batch.title ||
                  'Unnamed Batch'}
              </option>
            );
          })}
        </select>
      )}


      {/* TEST / DPP TABS */}

      <div className="btn-group w-100 mb-3">

        <button
          className={`btn ${
            activeTab === 'test'
              ? 'btn-primary'
              : 'btn-outline-primary'
          }`}
          onClick={() =>
            setActiveTab('test')
          }
        >
          📄 Tests
        </button>

        <button
          className={`btn ${
            activeTab === 'dpp'
              ? 'btn-success'
              : 'btn-outline-success'
          }`}
          onClick={() =>
            setActiveTab('dpp')
          }
        >
          📚 DPPs
        </button>

      </div>


      {/* ERROR */}

      {error && (
        <div className="alert alert-danger">
          {error}
        </div>
      )}


      {/* LOADING */}

      {loadingItems && (
        <div className="text-center text-muted py-4">
          Loading {activeTab === 'test' ? 'Tests' : 'DPPs'}...
        </div>
      )}


      {/* EMPTY */}

      {!loadingItems &&
        !error &&
        items.length === 0 && (
          <div className="text-center text-muted py-4">
            No{' '}
            {activeTab === 'test'
              ? 'TESTS'
              : 'DPPS'}{' '}
            available for this batch yet.
          </div>
        )}


      {/* ITEMS */}

      {!loadingItems &&
        items.length > 0 && (

          <div className="d-flex flex-column gap-2">

            {items.map((item) => {

              const id = String(
                item._id ||
                item.id ||
                item.testId ||
                item.sourceTestId ||
                Math.random()
              );

              const title =
                item.title ||
                item.name ||
                item.testName ||
                'Untitled Test';

              const totalQuestions =
                item.totalQuestions ??
                (Array.isArray(item.questions)
                  ? item.questions.length
                  : 0);

              return (
                <div
                  key={id}
                  className="card p-3 shadow-sm border-0 bg-white"
                >

                  <h6 className="fw-bold mb-1">
                    {title}
                  </h6>

                  <small className="text-muted d-block mb-2">
                    Total Questions: {totalQuestions}
                  </small>

                  <button
                    className={`btn btn-sm ${
                      activeTab === 'test'
                        ? 'btn-primary'
                        : 'btn-success'
                    } mt-1`}
                  >
                    {activeTab === 'test'
                      ? '▶ Start Test'
                      : '📝 Solve DPP'}
                  </button>

                </div>
              );
            })}

          </div>

        )}

    </div>
  );
}
