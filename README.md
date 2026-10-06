# ZX Exam Preparation Platform

Own-stack setup:
- `frontend/` = public student site
- `panel/` = separate Test/DPP uploader panel
- `backend/` = your own API + MongoDB data store

No third-party/source API is required. The panel creates batches and uploads tests/DPPs into your own database; the public site reads published content from your own API.
