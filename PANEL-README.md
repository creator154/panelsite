
# ZX Separate Test Uploader Panel

This folder is a separate admin/uploader website, designed around the supplied screenshots.

Flow:
1. Open the panel.
2. Enter the URL of your own backend.
3. Enter an authorized auth token for the source service.
4. Login as Batch Uploader.
5. Choose Tests or DPPs.
6. Choose a batch.
7. Press Upload Test / Upload DPP.
8. The selected item is saved to MongoDB with `published: true`, so the public site's live API can show it.

The panel does not contain a private token. Tokens are stored in the browser's localStorage on that device.

Backend Config Vars:
- MONGO_URI
- AUTHORIZED_API_BASE_URL (optional; defaults to https://api.penpencil.co)

Panel deployment:
- Deploy the `panel` folder as a separate Heroku app.
- Deploy the `backend` folder as the API.
- Put the backend URL into the panel login screen.

Only use an auth token and source API that you are authorized to access. This project does not bypass authentication or DRM.
