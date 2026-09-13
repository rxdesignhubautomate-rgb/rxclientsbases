# Google Drive quotation archive setup

The backend uploads every successfully sent quotation PDF to this folder by default:

`1He-4AeMT7HgelGCGRZ_PdDhSv9cLdn97`

Complete these one-time steps before deploying the backend:

1. In the Google Cloud project used by `FIREBASE_PROJECT_ID`, enable the **Google Drive API**.
2. Copy the service-account email from the Render environment variable `FIREBASE_CLIENT_EMAIL`. For the current `whatsappagent-704a6` project it is `firebase-adminsdk-fbsvc@whatsappagent-704a6.iam.gserviceaccount.com`.
3. Ask the folder owner to open the destination Google Drive folder, choose **Share**, add that service-account email, and give it **Editor** access. The currently signed-in `rxdesignlko@gmail.com` account only shows **Ask to share**, so it cannot grant this permission itself.
4. Optional: set `GOOGLE_DRIVE_QUOTATIONS_FOLDER_ID` in Render if the destination folder changes. The current folder ID is already the backend default.
5. Redeploy the backend after changing Render environment variables.

No additional private key is required. The Drive uploader reuses the existing Firebase service-account credentials from `FIREBASE_CLIENT_EMAIL` and `FIREBASE_PRIVATE_KEY`.

Files are saved as:

`Party Name - Quotation ID.pdf`

If the party name is empty or unknown, the WhatsApp number is used instead.

If WhatsApp delivery succeeds but Drive access is not configured, the quotation remains sent and the lead is still marked **Quotation Sent**. The CRM displays a Drive-upload warning so the archive can be retried after setup.
