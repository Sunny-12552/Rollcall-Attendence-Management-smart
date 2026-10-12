import 'dotenv/config';
import fs from 'node:fs';
import { google } from 'googleapis';

const sourceId = process.env.SOURCE_GOOGLE_SPREADSHEET_ID?.trim();
const name = process.env.NEW_SPREADSHEET_NAME?.trim() || 'Rollcall Attendance Copy';
const parentFolderId = process.env.NEW_SPREADSHEET_PARENT_FOLDER_ID?.trim();

if (!sourceId) throw new Error('Set SOURCE_GOOGLE_SPREADSHEET_ID before running this command.');
if (sourceId === process.env.GOOGLE_SPREADSHEET_ID?.trim()) throw new Error('Source and target spreadsheet IDs must be different.');

const credentials = process.env.GOOGLE_SERVICE_ACCOUNT_FILE
  ? JSON.parse(fs.readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_FILE, 'utf8'))
  : process.env.GOOGLE_SERVICE_ACCOUNT_JSON
    ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    : null;
if (!credentials) throw new Error('Google service-account credentials are not configured.');

const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/drive'] });
const drive = google.drive({ version: 'v3', auth });
const sheets = google.sheets({ version: 'v4', auth });
const requestBody = { name, mimeType: 'application/vnd.google-apps.spreadsheet' };
if (parentFolderId) requestBody.parents = [parentFolderId];

const result = await drive.files.copy({
  fileId: sourceId,
  requestBody,
  fields: 'id,name,webViewLink'
});

const newSpreadsheetId = result.data.id;
const metadata = await sheets.spreadsheets.get({
  spreadsheetId: newSpreadsheetId,
  fields: 'sheets.properties.title'
});
const ranges = (metadata.data.sheets || []).map(({ properties }) => {
  const title = properties.title.replace(/'/g, "''");
  return `'${title}'!A2:ZZ`;
});
if (ranges.length) {
  await sheets.spreadsheets.values.batchClear({
    spreadsheetId: newSpreadsheetId,
    requestBody: { ranges }
  });
}

console.log(`Created spreadsheet: ${result.data.name}`);
console.log(`Created structure-only spreadsheet. Stored attendance and roster data were cleared.`);
console.log(`New spreadsheet ID: ${newSpreadsheetId}`);
console.log(`Open: ${result.data.webViewLink || `https://docs.google.com/spreadsheets/d/${newSpreadsheetId}/edit`}`);
console.log('Set GOOGLE_SPREADSHEET_ID to the new ID, then restart the attendance app.');
