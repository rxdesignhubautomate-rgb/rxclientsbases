# Render deployment

Deploy the complete backend repository. Do not upload only selected changed files.

Required file check:

```text
src/utils/pagination.js
```

Recommended Render Web Service settings:

- Root Directory: leave blank
- Runtime: Node
- Build Command: `npm ci`
- Start Command: `npm start`

If Render previously produced `ERR_MODULE_NOT_FOUND` for `src/utils/pagination.js`:

1. Confirm the exact lowercase path `src/utils/pagination.js` exists in the connected GitHub repository.
2. Deploy the complete repository ZIP/commit.
3. In Render choose **Manual Deploy > Clear build cache & deploy**.

The backend ZIP supplied with this release contains the required file at the correct path.
