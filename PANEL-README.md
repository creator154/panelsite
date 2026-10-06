# ZX Separate Uploader Panel

This panel uses only your own ZX backend. No PenPencil/PW/source URL is used.

Flow: Login with your own ADMIN_AUTH_TOKEN -> Tests/DPPs -> Batches -> View -> Upload. Uploads are stored in your MongoDB and immediately published to the public API.

Deploy backend/ as your own Heroku app, set vars from backend/.env.example, put that backend URL in panel/config.js, then deploy panel/ as a separate Heroku app. The public frontend remains separate.
